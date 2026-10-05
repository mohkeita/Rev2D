/**
 * Emulation of Spine features that set a bone's WORLD transform by a rule Rev2D bones do not have:
 *
 * - Transform inheritance modes (onlyTranslation, noRotationOrReflection, noScale,
 *   noScaleOrReflection, and the 4.2 inherit timeline): the bone keeps a world orientation or scale of
 *   its own (a foot that stays level while the leg swings, snow that orbits without turning).
 * - Transform constraints (world or local, absolute or relative; translate-only constraints between
 *   sibling bones are baked exactly by import-transform.ts instead): the bone is pulled toward its
 *   target's rotation, position, scale and shear by the constraint's (animated) mixes.
 *
 * Each rule computes, from the Rev2D pose of everything it reads (parents and targets, IK included),
 * the world transform Spine gives the bone, and turns it into the bone's local values:
 *
 * - Setup pose: when the rule changes the setup pose (a setup IK moving a parent, constraint mixes
 *   that are on in the setup pose), the bone's setup values follow, and the rest world of the bone and
 *   its descendants (where attachments are bound) is updated to match.
 * - Animations: the bone's tracks are resampled (30 fps, every key time, refined where linear
 *   interpolation between samples deviates more than 0.05° / 0.05 px / 0.0005) wherever the plain
 *   conversion differs from the rule; animations the rule does not affect keep their keys.
 * - Model space: when the local transform Rev2D would need is sheared by more than 0.5° (a parent
 *   scaled non-uniformly while the bone must not turn with it), the bone is found in a first pass and,
 *   in the next import pass (import.ts), moved to model space: it keeps its Spine parent while
 *   animations are converted and sampled, then becomes a root bone whose rest is its Spine setup world
 *   and whose x / y / rotation / scale tracks are sampled world values.
 *
 * - Sheared bones (shear pairs, BoneInfo.shearPair) can take any world transform: a transform
 *   constraint on one sets the pair's outer translation, rotation and scale and its inner rotation
 *   (continuous SVD of the local matrix), sampled like the other channels.
 *
 * Rules run in levels (a rule after every rule on its bone's ancestors, on the bones it reads and
 * earlier rules on its own bone), rebuilding a bones-only rig per level. Bones inside IK chains (their
 * rotation is solved by the IK) are reported, not emulated.
 */
import { DEG, fromTRS, invert, multiply } from '../../core/math.js';
import { Rig } from '../../core/rig.js';
import { ModelSchema } from '../../core/schema.js';
import type { Mat2D, Pose } from '../../core/types.js';
import { MIN_KEY_GAP, evalSpineChannel, sampleTimes, simplifyLinear, type ConvertedAnimation, type RawKey } from './import-animations.js';
import { revLocalMatrix, type BoneInfo, type ImportContext } from './import-context.js';
import { transformMixes } from './import-transform.js';
import { decomposeMatrix, rev2dWorldFromSpine, spineWorldMatrix, svd2Near, type SpineBoneLocal, type Svd2 } from './transform.js';
import type { SpineAnimation, SpineInherit, SpineKeyBase, SpineTransformData } from './types.js';
import { clean, fmt } from './util.js';

/** Deviation from the rule below which the plain conversion is kept. */
const ROT_KEEP = 0.01;
const SCALE_KEEP = 1e-4;
const POS_KEEP = 0.005;
/** Refinement: add a sample between two when linear interpolation misses the rule by more. */
const ROT_REFINE = 0.05;
const SCALE_REFINE = 5e-4;
const POS_REFINE = 0.05;
const MIN_DT = 1 / 480;
/** Key reduction tolerances of the sampled tracks. */
const ROT_SIMPLIFY = 0.005;
const SCALE_SIMPLIFY = 1e-5;
const POS_SIMPLIFY = 0.005;
/** Shear (degrees) a parented bone would need before it moves to model space. */
const SHEAR_DETACH = 0.5;
/** Spine's own shear of a model-space bone (degrees) worth a warning. */
const SHEAR_WARN = 0.5;
/** Setup values closer than this are unchanged. */
const SETUP_EPS = 1e-7;

type Json = Record<string, unknown>;
type Channel = 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY';
const CHANNELS: Channel[] = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];

export interface RuleInputs {
  /** Rev2D bone JSON of the current bone values (called again after changes). */
  bones: () => Json[];
  /** Rev2D IK constraints JSON (all variants). */
  ik: () => Json[];
}

interface RuleBase {
  bone: BoneInfo;
  /** Order of the rules on one bone (Spine updates the bone, then its constraints by order). */
  seq: number;
  /**
   * The first rule on its bone: it starts from the bone's Spine local values (the Rev2D pose of the bone
   * itself may already hold setup changes of its rules); later rules start from the previous one's result.
   */
  first?: boolean;
  /** Bones (besides the bone's own parents) whose final world the rule reads. */
  reads: BoneInfo[];
}

interface InheritRule extends RuleBase {
  kind: 'inherit';
}

interface TransformRule extends RuleBase {
  kind: 'transform';
  data: SpineTransformData;
  /** Index in the skeleton's `transform` array. */
  index: number;
  target: BoneInfo;
}

type Rule = InheritRule | TransformRule;

interface Mixes {
  rotate: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  shearY: number;
}

/** Rules planned in the setup stage of an import pass, used again for its animations. */
const planned = new WeakMap<ImportContext, { rules: Rule[]; ikInherit: BoneInfo[] }>();

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function time(k: { time?: number }): number {
  return num(k.time, 0);
}

function wrap180(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  else if (r > 180) r -= 360;
  return r;
}

function wrapPi(r: number): number {
  if (r > Math.PI) return r - 2 * Math.PI;
  if (r < -Math.PI) return r + 2 * Math.PI;
  return r;
}

/** The bone's Spine parent (the hierarchy before any bone moved to model space). */
function spineParent(ctx: ImportContext, b: BoneInfo): BoneInfo | null {
  return b.node.parent >= 0 ? ctx.bones[b.node.parent] : null;
}

function isAncestor(ctx: ImportContext, a: BoneInfo, b: BoneInfo): boolean {
  for (let p = spineParent(ctx, b); p; p = spineParent(ctx, p)) if (p === a) return true;
  return false;
}

// ----------------------------------------------------------------------------- rigs and spaces

/**
 * A bones + IK rig (animations: bone and IK tracks only, played without looping so t = duration is the
 * end). `restRoots`: bones given as root bones at their model-space rest (setup rigs only).
 */
function boneRig(ctx: ImportContext, inputs: RuleInputs, animations: Json[], restRoots = false): Rig {
  let bones = inputs.bones();
  if (restRoots) {
    const byId = new Map(ctx.bones.map((b) => [b.id, b]));
    bones = bones.map((j) => {
      const b = byId.get(j.id as string);
      const rest = b?.detachRest;
      if (!rest || !b.parent) return j;
      const { parent: _parent, ...rest0 } = j;
      void _parent;
      return { ...rest0, x: rest.x, y: rest.y, rotation: rest.rotation, scaleX: rest.scaleX, scaleY: rest.scaleY };
    });
  }
  const doc = {
    format: 'rev2d',
    version: 1,
    meta: { name: 'bones', width: 1, height: 1 },
    bones,
    ik: inputs.ik(),
    animations: animations.map((a) => ({
      id: a.id,
      duration: a.duration,
      loop: false,
      tracks: (a.tracks as Array<{ target: string }>).filter((t) => t.target.startsWith('bone:') || t.target.startsWith('ik:')),
    })),
  };
  return new Rig(ModelSchema.parse(doc));
}

/** Bones whose rotation an IK constraint solves (their local rotation is overridden there). */
function ikChainBones(ctx: ImportContext): Set<BoneInfo> {
  return new Set(ctx.ik.flatMap((k) => k.bones));
}

/** Rev2D world -> Spine skeleton-space world. */
function toSpine(ctx: ImportContext, rev: Mat2D): Mat2D {
  const S = ctx.scale;
  return multiply(multiply(invert(ctx.canvas), rev), [S, 0, 0, -S, 0, 0]);
}

/** Spine skeleton-space world -> Rev2D world. */
function toRev(ctx: ImportContext, spine: Mat2D): Mat2D {
  return rev2dWorldFromSpine(spine, ctx.canvas, ctx.scale);
}

/** Recompute the rest worlds of the descendants of `root` (whose own rest world is already set). */
function rebindDescendants(ctx: ImportContext, root: BoneInfo): void {
  const moved = new Set<BoneInfo>([root]);
  for (const b of ctx.bones) {
    if (b === root || !b.parent || !moved.has(b.parent)) continue;
    b.revWorld = multiply(b.parent.revWorld, revLocalMatrix(b));
    b.spineWorld = toSpine(ctx, b.revWorld);
    moved.add(b);
  }
}

function inheritLabel(mode: SpineInherit): string {
  switch (mode) {
    case 'onlyTranslation':
      return "its parent's rotation, scale or shear";
    case 'noRotationOrReflection':
      return "its parent's rotation or reflection";
    case 'noScale':
      return "its parent's scale";
    case 'noScaleOrReflection':
      return "its parent's scale or reflection";
    default:
      return 'everything';
  }
}

// ----------------------------------------------------------------------------- planning

/** Whether a skin-only constraint is part of the imported skins. */
function skinActive(ctx: ImportContext, c: SpineTransformData): boolean {
  if (!c.skin) return true;
  const skins = Array.isArray(ctx.json.skins) ? ctx.json.skins : [];
  return skins.some((s) => ctx.skinChain.includes(s.name) && (s.transform ?? []).includes(c.name));
}

function planRules(ctx: ImportContext): { rules: Rule[]; ikInherit: BoneInfo[] } {
  const inIk = ikChainBones(ctx);
  const animations = Object.values(ctx.json.animations ?? {});
  const rules: Rule[] = [];
  const ikInherit: BoneInfo[] = [];
  for (const b of ctx.bones) {
    if (!b.parent) continue;
    const timeline = animations.some((a) => (a?.bones?.[b.name]?.inherit?.length ?? 0) > 0);
    if (b.node.inherit === 'normal' && !timeline && !ctx.detach.has(b.name)) continue;
    if (inIk.has(b)) {
      ikInherit.push(b);
      continue;
    }
    rules.push({ kind: 'inherit', bone: b, seq: -1, reads: [] });
  }
  const list = (ctx.json.transform ?? []).map((c, index) => ({ c, index })).sort((a, b) => num(a.c.order, 0) - num(b.c.order, 0) || a.index - b.index);
  list.forEach(({ c, index }, n) => {
    if (ctx.transformHandled.has(index)) return;
    const target = ctx.boneByName.get(c.target);
    const bones = (Array.isArray(c.bones) ? c.bones : []).map((name) => ctx.boneByName.get(name));
    if (!target || !bones.length || bones.some((b) => !b)) return; // reported as unsupported
    if (!skinActive(ctx, c)) {
      ctx.transformInactive.add(index);
      return;
    }
    const blocked = (bones as BoneInfo[]).find((b) => inIk.has(b)) ?? (target.shearPair && c.local ? target : undefined);
    if (blocked) {
      (ctx.transformSkipReasons ??= new Map()).set(
        index,
        blocked === target ? `its target "${target.name}" is sheared (two Rev2D bones) and the constraint is local` : `"${blocked.name}" is inside an IK chain`,
      );
      return;
    }
    for (const b of bones as BoneInfo[]) rules.push({ kind: 'transform', bone: b, seq: n, reads: [target], data: c, index, target });
    ctx.transformEmulated.add(index);
  });
  for (const r of rules) r.first = !rules.some((q) => q.bone === r.bone && q.seq < r.seq);
  return { rules, ikInherit };
}

/** Levels: a rule comes after the rules on its bone's ancestors, on the bones it reads, and earlier rules on its bone. */
function ruleLevels(ctx: ImportContext, rules: Rule[]): Map<Rule, number> {
  const deps = new Map<Rule, Rule[]>();
  for (const r of rules) {
    deps.set(
      r,
      rules.filter(
        (q) =>
          q !== r &&
          ((q.bone === r.bone && q.seq < r.seq) || isAncestor(ctx, q.bone, r.bone) || r.reads.some((x) => x === q.bone || isAncestor(ctx, q.bone, x))),
      ),
    );
  }
  const level = new Map<Rule, number>(rules.map((r) => [r, 0]));
  // Relaxation, bounded (constraints that read each other form cycles: they stay in the last order found).
  for (let pass = 0; pass <= rules.length; pass++) {
    let changed = false;
    for (const r of rules) {
      const l = Math.max(0, ...deps.get(r)!.map((q) => level.get(q)! + 1));
      if (l !== level.get(r) && l <= rules.length) {
        level.set(r, l);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return level;
}

// ----------------------------------------------------------------------------- rule evaluation

/** Spine local values of `b` at time t of `anim` (setup when anim is null; translation from the Rev2D pose, which is exact). */
function spineLocalAt(ctx: ImportContext, b: BoneInfo, anim: SpineAnimation | null, pose: Pose, t: number): SpineBoneLocal {
  const n = b.node;
  if (!anim) return { ...n };
  const tl = anim.bones?.[b.name] ?? {};
  const S = ctx.scale;
  // A shear pair's translation is on its outer bone.
  const local = pose.bones[b.shearPair?.outerId ?? b.id].local;
  // Translate keys were converted relative to the setup a rule may have moved.
  const base = b.ruleSetupBase ?? b.rev;
  const legacy = ctx.legacy;
  const rot = evalSpineChannel(tl.rotate, (k) => num(k.value ?? k.angle, 0), 0, legacy, legacy, t) ?? 0;
  const sx = tl.scale?.length ? evalSpineChannel(tl.scale, (k) => num(k.x, 1), 0, legacy, false, t) : evalSpineChannel(tl.scalex, (k) => num(k.value, 1), 0, legacy, false, t);
  const sy = tl.scale?.length ? evalSpineChannel(tl.scale, (k) => num(k.y, 1), 1, legacy, false, t) : evalSpineChannel(tl.scaley, (k) => num(k.value, 1), 0, legacy, false, t);
  const hx = tl.shear?.length ? evalSpineChannel(tl.shear, (k) => num(k.x, 0), 0, legacy, false, t) : evalSpineChannel(tl.shearx, (k) => num(k.value, 0), 0, legacy, false, t);
  const hy = tl.shear?.length ? evalSpineChannel(tl.shear, (k) => num(k.y, 0), 1, legacy, false, t) : evalSpineChannel(tl.sheary, (k) => num(k.value, 0), 0, legacy, false, t);
  let inherit = n.inherit;
  for (const k of tl.inherit ?? []) if (num(k.time, 0) <= t && k.inherit) inherit = k.inherit;
  return {
    x: (local.x - b.rev.x + base.x) / S,
    y: -(local.y - b.rev.y + base.y) / S,
    rotation: n.rotation + rot,
    scaleX: n.scaleX * (sx ?? 1),
    scaleY: n.scaleY * (sy ?? 1),
    shearX: n.shearX + (hx ?? 0),
    shearY: n.shearY + (hy ?? 0),
    inherit,
  };
}

/** A constraint's mixes at time t (the setup mixes before its timeline's first key, or without one). */
function mixesAt(ctx: ImportContext, r: TransformRule, anim: SpineAnimation | null, t: number): Mixes {
  const setup = transformMixes(r.data as Record<string, unknown>);
  const keys = anim?.transform?.[r.data.name] as Array<SpineKeyBase & Record<string, unknown>> | undefined;
  if (!keys?.length || t < time(keys[0])) return setup;
  const legacy = ctx.legacy;
  const ch = (get: (k: Record<string, unknown>) => number, channel: number) => evalSpineChannel(keys, get, channel, legacy, false, t) ?? 0;
  if (keys.some((k) => ['rotateMix', 'translateMix', 'scaleMix', 'shearMix'].some((f) => f in k))) {
    const translate = ch((k) => num(k.translateMix, 1), 0);
    const scale = ch((k) => num(k.scaleMix, 1), 0);
    return { rotate: ch((k) => num(k.rotateMix, 1), 0), x: translate, y: translate, scaleX: scale, scaleY: scale, shearY: ch((k) => num(k.shearMix, 1), 0) };
  }
  return {
    rotate: ch((k) => num(k.mixRotate, 1), 0),
    x: ch((k) => num(k.mixX, 1), 1),
    y: ch((k) => num(k.mixY, num(k.mixX, 1)), 2),
    scaleX: ch((k) => num(k.mixScaleX, 1), 3),
    scaleY: ch((k) => num(k.mixScaleY, num(k.mixScaleX, 1)), 4),
    shearY: ch((k) => num(k.mixShearY, 1), 5),
  };
}

/** Whether a constraint can change anything in an animation (or the setup pose). */
function constraintActive(r: TransformRule, anim: SpineAnimation | null): boolean {
  const m = transformMixes(r.data as Record<string, unknown>);
  if (m.rotate || m.x || m.y || m.scaleX || m.scaleY || m.shearY) return true;
  return !!anim && (anim.transform?.[r.data.name]?.length ?? 0) > 0;
}

interface Applied {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearY: number;
}

/**
 * Applied local values of a bone from its world and its parent's world (Spine space, normal
 * inheritance): what Spine's updateAppliedTransform derives before a local constraint uses them.
 */
function applied(parent: Mat2D | null, world: Mat2D): Applied {
  const p = parent ?? [1, 0, 0, 1, 0, 0];
  const l = multiply(invert(p), world);
  const [ra, rc, rb, rd] = [l[0], l[1], l[2], l[3]];
  let scaleX = Math.hypot(ra, rc);
  let scaleY: number;
  let shearY: number;
  let rotation: number;
  if (scaleX > 1e-4) {
    const det = ra * rd - rb * rc;
    scaleY = det / scaleX;
    shearY = -Math.atan2(ra * rb + rc * rd, det) / DEG;
    rotation = Math.atan2(rc, ra) / DEG;
  } else {
    scaleX = 0;
    scaleY = Math.hypot(rb, rd);
    shearY = 0;
    rotation = 90 - Math.atan2(rd, rb) / DEG;
  }
  return { x: l[4], y: l[5], rotation, scaleX, scaleY, shearY };
}

/**
 * Spine's transform constraint applied to one bone (Spine space): `bone` / `target` are world matrices
 * (Mat2D: x axis, y axis, position) and their parents' worlds (for the local modes).
 */
function applyTransform(r: TransformRule, m: Mixes, bone: Mat2D, target: Mat2D, boneParent: Mat2D | null, targetParent: Mat2D | null, inherit: SpineInherit): Mat2D {
  const d = r.data;
  const offRot = num(d.rotation, 0);
  const offX = num(d.x, 0);
  const offY = num(d.y, 0);
  const offScaleX = num(d.scaleX, 0);
  const offScaleY = num(d.scaleY, 0);
  const offShearY = num(d.shearY, 0);
  if (d.local) {
    const b = applied(boneParent, bone);
    const t = applied(targetParent, target);
    let { rotation, x, y, scaleX, scaleY, shearY } = b;
    if (d.relative) {
      rotation += (t.rotation + offRot) * m.rotate;
      x += (t.x + offX) * m.x;
      y += (t.y + offY) * m.y;
      scaleX *= (t.scaleX - 1 + offScaleX) * m.scaleX + 1;
      scaleY *= (t.scaleY - 1 + offScaleY) * m.scaleY + 1;
      shearY += (t.shearY + offShearY) * m.shearY;
    } else {
      if (m.rotate) rotation += (t.rotation - rotation + offRot) * m.rotate;
      x += (t.x - x + offX) * m.x;
      y += (t.y - y + offY) * m.y;
      if (m.scaleX && scaleX) scaleX = (scaleX + (t.scaleX - scaleX + offScaleX) * m.scaleX) / scaleX;
      if (m.scaleY && scaleY) scaleY = (scaleY + (t.scaleY - scaleY + offScaleY) * m.scaleY) / scaleY;
      if (m.shearY) shearY += (t.shearY - shearY + offShearY) * m.shearY;
    }
    return spineWorldMatrix(boneParent, { x, y, rotation, scaleX, scaleY, shearX: 0, shearY, inherit });
  }
  // World modes (runtime naming: a, c = x axis; b, d = y axis).
  let [a, c, b, dd, wx, wy] = bone;
  const [ta, tc, tb, td, tx, ty] = target;
  const reflect = ta * td - tb * tc > 0 ? DEG : -DEG;
  const rot = offRot * reflect;
  const shear = offShearY * reflect;
  if (m.rotate) {
    let q = d.relative ? Math.atan2(tc, ta) + rot : Math.atan2(tc, ta) - Math.atan2(c, a) + rot;
    q = wrapPi(q) * m.rotate;
    const cos = Math.cos(q);
    const sin = Math.sin(q);
    [a, b, c, dd] = [cos * a - sin * c, cos * b - sin * dd, sin * a + cos * c, sin * b + cos * dd];
  }
  if (m.x || m.y) {
    const px = ta * offX + tb * offY + tx;
    const py = tc * offX + td * offY + ty;
    if (d.relative) {
      wx += px * m.x;
      wy += py * m.y;
    } else {
      wx += (px - wx) * m.x;
      wy += (py - wy) * m.y;
    }
  }
  if (m.scaleX) {
    let s: number;
    if (d.relative) s = (Math.hypot(ta, tc) - 1 + offScaleX) * m.scaleX + 1;
    else {
      s = Math.hypot(a, c);
      if (s) s = (s + (Math.hypot(ta, tc) - s + offScaleX) * m.scaleX) / s;
    }
    a *= s;
    c *= s;
  }
  if (m.scaleY) {
    let s: number;
    if (d.relative) s = (Math.hypot(tb, td) - 1 + offScaleY) * m.scaleY + 1;
    else {
      s = Math.hypot(b, dd);
      if (s) s = (s + (Math.hypot(tb, td) - s + offScaleY) * m.scaleY) / s;
    }
    b *= s;
    dd *= s;
  }
  if (m.shearY > 0) {
    let q: number;
    if (d.relative) {
      q = wrapPi(Math.atan2(td, tb) - Math.atan2(tc, ta));
      q = Math.atan2(dd, b) + (q - Math.PI / 2 + shear) * m.shearY;
    } else {
      const by = Math.atan2(dd, b);
      q = wrapPi(Math.atan2(td, tb) - Math.atan2(tc, ta) - (by - Math.atan2(c, a)));
      q = by + (q + shear) * m.shearY;
    }
    const s = Math.hypot(b, dd);
    b = Math.cos(q) * s;
    dd = Math.sin(q) * s;
  }
  return [a, c, b, dd, wx, wy];
}

/** The Rev2D world a rule gives its bone in a pose (anim null: the setup pose). */
function ruleWorld(ctx: ImportContext, r: Rule, pose: Pose, anim: SpineAnimation | null, t: number): Mat2D {
  const parent = spineParent(ctx, r.bone);
  if (r.kind === 'inherit') {
    const P = toSpine(ctx, pose.bones[parent!.id].world);
    return toRev(ctx, spineWorldMatrix(P, spineLocalAt(ctx, r.bone, anim, pose, t)));
  }
  const tParent = spineParent(ctx, r.target);
  // The bone before its constraints: from its Spine local values for its first rule (its Rev2D rest may
  // already include a constraint active in the setup pose), else the previous rule's result. A bone
  // with a first transform rule inherits normally (other modes have an inherit rule before it).
  const P = parent ? toSpine(ctx, pose.bones[parent.id].world) : null;
  const before = r.first ? spineWorldMatrix(P, spineLocalAt(ctx, r.bone, anim, pose, t)) : toSpine(ctx, pose.bones[r.bone.id].world);
  const W = applyTransform(
    r,
    mixesAt(ctx, r, anim, t),
    before,
    toSpine(ctx, pose.bones[r.target.id].world),
    P,
    tParent ? toSpine(ctx, pose.bones[tParent.id].world) : null,
    r.bone.node.inherit,
  );
  return toRev(ctx, W);
}

// ----------------------------------------------------------------------------- setup

/**
 * Setup pose (before attachments are placed): model-space bones of this pass get their rest world
 * (Spine's setup world after setup IK and constraints); other emulated bones whose setup world a rule
 * changes get matching setup values. Returns true when rest worlds changed.
 */
export function emulateRulesSetup(ctx: ImportContext, inputs: RuleInputs): boolean {
  const plan = planRules(ctx);
  planned.set(ctx, plan);
  const rules = plan.rules.filter((r) => r.kind === 'inherit' || constraintActive(r, null) || ctx.detach.has(r.bone.name));
  if (!rules.length) return false;
  const level = ruleLevels(ctx, rules);
  rules.sort((a, b) => level.get(a)! - level.get(b)! || a.seq - b.seq || a.bone.index - b.bone.index);
  let pose: Pose | null = null;
  let changed = false;
  for (const r of rules) {
    const b = r.bone;
    const parent = spineParent(ctx, b);
    pose ??= boneRig(ctx, inputs, [], true).pose({ physics: false });
    const world = ruleWorld(ctx, r, pose, null, 0);
    if (ctx.detach.has(b.name)) {
      const d = decomposeMatrix(world);
      b.detachRest = { x: clean(d.x), y: clean(d.y), rotation: clean(d.rotation), scaleX: clean(d.scaleX), scaleY: clean(d.scaleY) };
      const rest = b.detachRest;
      b.revWorld = fromTRS(rest.x, rest.y, rest.rotation, rest.scaleX, rest.scaleY);
      b.spineWorld = toSpine(ctx, b.revWorld);
      rebindDescendants(ctx, b);
      changed = true;
      pose = null;
      continue;
    }
    const P = parent ? pose.bones[parent.id].world : ([1, 0, 0, 1, 0, 0] as Mat2D);
    if (b.shearPair) {
      if (setPairSetup(ctx, b, multiply(invert(P), world))) {
        rebindDescendants(ctx, b);
        changed = true;
        pose = null;
        setupChanged.add(r);
      }
      continue;
    }
    const d = decomposeMatrix(multiply(invert(P), world));
    if (Math.abs(d.shear) > SHEAR_DETACH) ctx.needDetach.add(b.name);
    const rv = b.rev;
    const rotation = rv.rotation + wrap180(d.rotation - rv.rotation);
    const same =
      Math.abs(rotation - rv.rotation) < SETUP_EPS &&
      Math.abs(d.scaleX - rv.scaleX) < SETUP_EPS &&
      Math.abs(d.scaleY - rv.scaleY) < SETUP_EPS &&
      Math.abs(d.x - rv.x) < SETUP_EPS * Math.max(1, Math.abs(rv.x)) &&
      Math.abs(d.y - rv.y) < SETUP_EPS * Math.max(1, Math.abs(rv.y));
    if (same) continue;
    const before = rv.rotation;
    b.ruleSetupBase ??= { x: rv.x, y: rv.y };
    Object.assign(rv, { x: clean(d.x), y: clean(d.y), rotation: clean(rotation), scaleX: clean(d.scaleX), scaleY: clean(d.scaleY) });
    b.revWorld = b.parent ? multiply(b.parent.revWorld, revLocalMatrix(b)) : revLocalMatrix(b);
    b.spineWorld = toSpine(ctx, b.revWorld);
    rebindDescendants(ctx, b);
    changed = true;
    pose = null;
    if (r.kind === 'inherit') {
      ctx.report.info(
        'spine-bone-inherit-setup-ik',
        `the setup IK moves a parent of this bone, which does not inherit ${inheritLabel(b.node.inherit)}: its setup rotation is ${fmt(rv.rotation)}° instead of ${fmt(before)}° so that it keeps Spine's world orientation after the IK`,
        `bones[${b.index}] (${b.name})`,
      );
    } else {
      setupChanged.add(r);
    }
  }
  return changed;
}

/** Transform rules whose constraint changed the setup pose (for the report). */
const setupChanged = new WeakSet<Rule>();

/** Setup values of a shear pair as an SVD (outer rotation = rev.rotation + phi). */
function pairSetup(b: BoneInfo): Svd2 & { x: number; y: number } {
  const p = b.shearPair!;
  return { x: b.rev.x, y: b.rev.y, phi: b.rev.rotation + p.phi, sx: p.sx, sy: p.sy, theta: p.theta };
}

/** Give a shear pair the local matrix L (Rev2D, relative to its parent); false when unchanged. */
function setPairSetup(ctx: ImportContext, b: BoneInfo, L: Mat2D): boolean {
  const cur = pairSetup(b);
  const s = svd2Near([L[0], L[1], L[2], L[3]], cur);
  const close = (u: number, v: number) => Math.abs(u - v) < SETUP_EPS * Math.max(1, Math.abs(v));
  if (close(L[4], cur.x) && close(L[5], cur.y) && close(s.phi, cur.phi) && close(s.theta, cur.theta) && close(s.sx, cur.sx) && close(s.sy, cur.sy)) return false;
  b.ruleSetupBase ??= { x: b.rev.x, y: b.rev.y };
  b.rev.x = clean(L[4]);
  b.rev.y = clean(L[5]);
  Object.assign(b.shearPair!, { phi: clean(s.phi - b.rev.rotation), theta: clean(s.theta), sx: clean(s.sx), sy: clean(s.sy) });
  b.revWorld = b.parent ? multiply(b.parent.revWorld, revLocalMatrix(b)) : revLocalMatrix(b);
  b.spineWorld = toSpine(ctx, b.revWorld);
  return true;
}

// ----------------------------------------------------------------------------- animations

interface Sample {
  t: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shear: number;
}

/** Times where the pose changes behaviour: keys of the Rev2D bone / IK tracks (and just before stepped changes) and of the rules' own Spine timelines. */
function mustTimes(json: Json, anim: SpineAnimation, rules: Rule[]): number[] {
  const out: number[] = [];
  for (const tr of json.tracks as Array<{ target: string; keys: RawKey[] }>) {
    if (!tr.target.startsWith('bone:') && !tr.target.startsWith('ik:')) continue;
    tr.keys.forEach((k, i) => {
      out.push(k.t);
      const next = tr.keys[i + 1];
      if (next && k.ease === 'step') out.push(next.t - MIN_KEY_GAP);
    });
  }
  const stepped = (keys: Array<SpineKeyBase> | undefined) => {
    (keys ?? []).forEach((k, i, all) => {
      out.push(time(k));
      if (k.curve === 'stepped' && all[i + 1]) out.push(time(all[i + 1]) - MIN_KEY_GAP);
    });
  };
  for (const r of rules) {
    const tl = anim.bones?.[r.bone.name];
    for (const keys of [tl?.shear, tl?.shearx, tl?.sheary]) stepped(keys);
    for (const k of tl?.inherit ?? []) {
      const t = time(k);
      out.push(t);
      if (t > MIN_KEY_GAP) out.push(t - MIN_KEY_GAP);
    }
    if (r.kind === 'transform') stepped(anim.transform?.[r.data.name]);
  }
  return out;
}

/**
 * Animations: resample the tracks of every emulated bone wherever the plain conversion differs from its
 * rules (see the module header), move this pass's model-space bones to model space, then report.
 */
export function emulateRulesAnimations(ctx: ImportContext, anims: ConvertedAnimation[], inputs: RuleInputs): void {
  const plan = planned.get(ctx) ?? planRules(ctx);
  for (const b of plan.ikInherit) {
    const timeline = anims.some((a) => (a.anim.bones?.[b.name]?.inherit?.length ?? 0) > 0);
    ctx.report.warn(
      'spine-bone-inherit',
      `transform inheritance "${b.node.inherit}"${timeline ? ' (or an inherit timeline)' : ''} is not emulated for a bone inside an IK chain: Rev2D's IK solves its rotation as if it inherited everything`,
      `bones[${b.index}] (${b.name})`,
      'use normal inheritance for IK chain bones in Spine',
    );
  }
  const rules = plan.rules;
  if (!rules.length) return;
  const level = ruleLevels(ctx, rules);
  const maxLevel = Math.max(...level.values());
  const sampled = new Map<Rule, string[]>(rules.map((r) => [r, []]));
  const shear = new Map<BoneInfo, number>();
  for (let lv = 0; lv <= maxLevel; lv++) {
    const batch = rules.filter((r) => level.get(r) === lv);
    if (!batch.length) continue;
    const rig = boneRig(ctx, inputs, anims.map((a) => a.json));
    for (const a of anims) {
      const active = batch.filter((r) => r.kind === 'inherit' || constraintActive(r, a.anim));
      if (!active.length) continue;
      const json = a.json;
      const id = json.id as string;
      const cache = new Map<number, Pose>();
      const poseAt = (t: number) => {
        let p = cache.get(t);
        if (!p) {
          p = rig.pose({ time: t, animations: [id], physics: false });
          cache.set(t, p);
        }
        return p;
      };
      const grid = sampleTimes(0, json.duration as number, mustTimes(json, a.anim, active));
      for (const r of active) {
        const changed = r.bone.shearPair ? resamplePair(ctx, r, a, grid, poseAt) : resample(ctx, r, a, grid, poseAt, shear);
        if (changed) sampled.get(r)!.push(a.name);
      }
    }
    // Model-space bones become root bones once their first rule wrote world tracks: later levels'
    // rigs (and their later rules) and the document see them that way.
    for (const r of batch) {
      const b = r.bone;
      if (!b.detachRest || !b.parent) continue;
      b.parent = null;
      b.rev = { ...b.detachRest, length: b.rev.length };
    }
  }
  report(ctx, anims, rules, sampled, shear);
}

/** Resample one rule's bone in one animation; true when its tracks changed. */
function resample(ctx: ImportContext, r: Rule, a: ConvertedAnimation, grid: number[], poseAt: (t: number) => Pose, shear: Map<BoneInfo, number>): boolean {
  const b = r.bone;
  const json = a.json;
  const detached = !!b.detachRest;
  const parent = spineParent(ctx, b);
  const want = (t: number): Sample => {
    const pose = poseAt(t);
    const world = ruleWorld(ctx, r, pose, a.anim, t);
    const P = parent && !detached ? pose.bones[parent.id].world : null;
    const d = decomposeMatrix(P ? multiply(invert(P), world) : world);
    return { t, x: d.x, y: d.y, rotation: d.rotation, scaleX: d.scaleX, scaleY: d.scaleY, shear: d.shear };
  };
  // A model-space bone still parented in this rig (its first rule) is compared with its rest.
  const have = (t: number) => (detached && b.parent ? b.detachRest! : poseAt(t).bones[b.id].local);
  const dev: Record<Channel, number> = { x: 0, y: 0, rotation: 0, scaleX: 0, scaleY: 0 };
  let worstShear = 0;
  const samples = grid.map((t) => {
    const s = want(t);
    const h = have(t);
    s.rotation = h.rotation + wrap180(s.rotation - h.rotation);
    for (const c of CHANNELS) dev[c] = Math.max(dev[c], Math.abs(s[c] - h[c]));
    worstShear = Math.max(worstShear, Math.abs(s.shear));
    return s;
  });
  shear.set(b, Math.max(shear.get(b) ?? 0, worstShear));
  if (!detached && worstShear > SHEAR_DETACH) ctx.needDetach.add(b.name);
  const keep = (c: Channel) => (c === 'rotation' ? ROT_KEEP : c === 'x' || c === 'y' ? POS_KEEP : SCALE_KEEP);
  // A model-space bone still parented here (its first rule) replaces all its local tracks.
  const replaceAll = detached && !!b.parent;
  const needed = CHANNELS.filter((c) => dev[c] >= keep(c) || (replaceAll && hasTrack(json, b, c)));
  if (!needed.length) return false;
  const refined = refine(samples, want);
  const tracks = json.tracks as Array<{ target: string; keys: RawKey[] }>;
  const setupOf = (c: Channel) => (detached ? b.detachRest![c] : b.rev[c]);
  for (const c of CHANNELS) {
    const target = `bone:${b.id}.${c}`;
    const i = tracks.findIndex((t) => t.target === target);
    if (!needed.includes(c)) {
      if (replaceAll && i >= 0) tracks.splice(i, 1);
      continue;
    }
    const tol = c === 'rotation' ? ROT_SIMPLIFY : c === 'x' || c === 'y' ? POS_SIMPLIFY : SCALE_SIMPLIFY;
    const keys = simplifyLinear(
      refined.map((s) => ({ t: s.t, v: clean(s[c]) })),
      tol,
    );
    const constant = keys.every((k) => Math.abs((k.v as number) - setupOf(c)) <= tol);
    if (constant) {
      if (i >= 0) tracks.splice(i, 1);
    } else if (i >= 0) tracks[i] = { target, keys };
    else tracks.push({ target, keys });
  }
  ctx.report.count(r.kind === 'inherit' ? 'sampledInheritTracks' : 'sampledTransformTracks');
  return true;
}

type PairSample = Svd2 & { t: number; x: number; y: number };

/**
 * Resample one rule's shear-pair bone in one animation: the rule's local matrix at every sample is split
 * into the outer bone's translation, rotation and scale and the inner bone's rotation (continuous SVD).
 * True when its tracks changed.
 */
function resamplePair(ctx: ImportContext, r: Rule, a: ConvertedAnimation, grid: number[], poseAt: (t: number) => Pose): boolean {
  const b = r.bone;
  const pair = b.shearPair!;
  const parent = spineParent(ctx, b);
  const sampleAt = (t: number, prev: Svd2): PairSample => {
    const pose = poseAt(t);
    const world = ruleWorld(ctx, r, pose, a.anim, t);
    const L = parent ? multiply(invert(pose.bones[parent.id].world), world) : world;
    return { t, x: L[4], y: L[5], ...svd2Near([L[0], L[1], L[2], L[3]], prev) };
  };
  // Compare the rule's world with the posed one (the SVD split itself is not unique).
  let devPos = 0;
  let devLin = 0;
  let prev: PairSample = { t: 0, ...pairSetup(b) };
  const samples = grid.map((t) => {
    const pose = poseAt(t);
    const want = ruleWorld(ctx, r, pose, a.anim, t);
    const have = pose.bones[b.id].world;
    const unit = Math.max(1e-6, Math.hypot(have[0], have[1]), Math.hypot(have[2], have[3]));
    devPos = Math.max(devPos, Math.hypot(want[4] - have[4], want[5] - have[5]));
    for (let i = 0; i < 4; i++) devLin = Math.max(devLin, Math.abs(want[i] - have[i]) / unit);
    prev = sampleAt(t, prev);
    return prev;
  });
  if (devPos < POS_KEEP && devLin < SCALE_KEEP) return false;
  const out: PairSample[] = [];
  const rec = (p: PairSample, q: PairSample) => {
    if (q.t - p.t < 2 * MIN_DT) return;
    const m = sampleAt((p.t + q.t) / 2, p);
    const off = (k: 'x' | 'y' | 'phi' | 'theta' | 'sx' | 'sy') => Math.abs(m[k] - (p[k] + q[k]) / 2);
    if (off('phi') <= ROT_REFINE && off('theta') <= ROT_REFINE && off('sx') <= SCALE_REFINE && off('sy') <= SCALE_REFINE && off('x') <= POS_REFINE && off('y') <= POS_REFINE) return;
    rec(p, m);
    out.push(m);
    rec(m, q);
  };
  samples.forEach((s, i) => {
    if (i > 0) rec(samples[i - 1], s);
    out.push(s);
  });
  const setup = pairSetup(b);
  const tracks = a.json.tracks as Array<{ target: string; keys: RawKey[] }>;
  const put = (target: string, get: (s: PairSample) => number, setupValue: number, tol: number) => {
    const keys = simplifyLinear(
      out.map((s) => ({ t: s.t, v: clean(get(s)) })),
      tol,
    );
    const i = tracks.findIndex((t) => t.target === target);
    if (keys.every((k) => Math.abs((k.v as number) - setupValue) <= tol)) {
      if (i >= 0) tracks.splice(i, 1);
    } else if (i >= 0) tracks[i] = { target, keys };
    else tracks.push({ target, keys });
  };
  put(`bone:${pair.outerId}.x`, (s) => s.x, setup.x, POS_SIMPLIFY);
  put(`bone:${pair.outerId}.y`, (s) => s.y, setup.y, POS_SIMPLIFY);
  put(`bone:${pair.outerId}.rotation`, (s) => s.phi, setup.phi, ROT_SIMPLIFY);
  put(`bone:${pair.outerId}.scaleX`, (s) => s.sx, setup.sx, SCALE_SIMPLIFY);
  put(`bone:${pair.outerId}.scaleY`, (s) => s.sy, setup.sy, SCALE_SIMPLIFY);
  put(`bone:${b.id}.rotation`, (s) => s.theta, setup.theta, ROT_SIMPLIFY);
  ctx.report.count('sampledTransformTracks');
  return true;
}

function hasTrack(json: Json, b: BoneInfo, c: Channel): boolean {
  return (json.tracks as Array<{ target: string }>).some((t) => t.target === `bone:${b.id}.${c}`);
}

/** Add midpoints where linear interpolation between samples misses the rule by more than the refine tolerances. */
function refine(samples: Sample[], want: (t: number) => Sample): Sample[] {
  const out: Sample[] = [];
  const rec = (a: Sample, b: Sample) => {
    if (b.t - a.t < 2 * MIN_DT) return;
    const tm = (a.t + b.t) / 2;
    const m = want(tm);
    m.rotation = a.rotation + wrap180(m.rotation - a.rotation);
    const off = (c: Channel) => Math.abs(m[c] - (a[c] + b[c]) / 2);
    if (off('rotation') <= ROT_REFINE && off('scaleX') <= SCALE_REFINE && off('scaleY') <= SCALE_REFINE && off('x') <= POS_REFINE && off('y') <= POS_REFINE) return;
    rec(a, m);
    out.push(m);
    rec(m, b);
  };
  // Continuous rotation along the samples.
  for (let i = 1; i < samples.length; i++) samples[i].rotation = samples[i - 1].rotation + wrap180(samples[i].rotation - samples[i - 1].rotation);
  samples.forEach((s, i) => {
    if (i > 0) rec(samples[i - 1], s);
    out.push(s);
  });
  for (let i = 1; i < out.length; i++) out[i].rotation = out[i - 1].rotation + wrap180(out[i].rotation - out[i - 1].rotation);
  return out;
}

// ----------------------------------------------------------------------------- report

function listed(names: string[]): string {
  return names.length > 8 ? `${names.slice(0, 8).join(', ')}, ... (+${names.length - 8})` : names.join(', ');
}

function report(ctx: ImportContext, anims: ConvertedAnimation[], rules: Rule[], sampled: Map<Rule, string[]>, shear: Map<BoneInfo, number>): void {
  const bones = [...new Set(rules.map((r) => r.bone))];
  for (const b of bones) {
    const where = `bones[${b.index}] (${b.name})`;
    const own = rules.filter((r) => r.bone === b);
    const inherit = own.find((r): r is InheritRule => r.kind === 'inherit');
    const worst = shear.get(b) ?? 0;
    if (inherit) {
      const list = sampled.get(inherit)!;
      const timelines = anims.filter((a) => (a.anim.bones?.[b.name]?.inherit?.length ?? 0) > 0).map((a) => a.name);
      const mode = `transform inheritance "${b.node.inherit}"${timelines.length ? ` (switched by the inherit timeline of ${timelines.join(', ')})` : ''}`;
      const how = list.length ? `sampled in ${list.length} animation${list.length > 1 ? 's' : ''} (${listed(list)})` : 'no animation needed resampling';
      if (b.detachRest) {
        ctx.report.info(
          'spine-bone-inherit-detached',
          `${mode} is emulated in model space: under its non-uniformly scaled parent the bone would need a sheared local transform, so in Rev2D it has no parent; its rest is its Spine setup world and its position, rotation and scale are ${how}`,
          where,
          'it no longer follows its Spine parent when that parent is edited in Rev2D; re-import after editing the motion in Spine',
        );
      } else {
        ctx.report.info(
          'spine-bone-inherit-baked',
          `${mode} is emulated: the bone does not follow ${inheritLabel(b.node.inherit)}; its rotation / scale are ${how}`,
          where,
          "moving its parents in Rev2D (new keys, IK) does not re-apply Spine's rule; re-import after editing the motion in Spine",
        );
      }
    } else if (b.detachRest) {
      ctx.report.info(
        'spine-bone-model-space',
        'a transform constraint gives this bone a world transform its parent cannot express without shear, so in Rev2D it has no parent; its rest is its Spine setup world and its position, rotation and scale are sampled',
        where,
        'it no longer follows its Spine parent when that parent is edited in Rev2D',
      );
    }
    if (b.detachRest && worst > SHEAR_WARN) {
      ctx.report.warn('spine-bone-inherit-shear', `Spine shears this bone by up to ${fmt(worst)}°, which Rev2D bones cannot express; attachments on it are not sheared`, where, 'avoid shear and non-uniform parent scale on this bone in Spine');
    } else if (!b.detachRest && worst > SHEAR_DETACH) {
      ctx.report.warn(
        'spine-bone-inherit-shear',
        `under its non-uniformly scaled parent this bone would need a local shear of up to ${fmt(worst)}°, which Rev2D bones cannot express; attachments on it are skewed by up to that much`,
        where,
        'scale the parents uniformly in Spine',
      );
    }
  }
  // One line per emulated transform constraint.
  const byConstraint = new Map<number, TransformRule[]>();
  for (const r of rules) if (r.kind === 'transform') byConstraint.set(r.index, [...(byConstraint.get(r.index) ?? []), r]);
  for (const [index, rs] of byConstraint) {
    const c = rs[0].data;
    const anims = [...new Set(rs.flatMap((r) => sampled.get(r)!))];
    const setup = rs.some((r) => setupChanged.has(r));
    const mode = `${c.local ? 'local' : 'world'}, ${c.relative ? 'relative' : 'absolute'}`;
    ctx.report.info(
      'spine-transform-emulated',
      `transform constraint "${c.name}" (${mode}) toward "${rs[0].target.name}" is emulated on ${rs.map((r) => `"${r.bone.name}"`).join(', ')}: ${[setup ? 'the setup pose includes it' : '', anims.length ? `its effect is sampled in ${anims.length} animation${anims.length > 1 ? 's' : ''} (${listed(anims)})` : 'no animation needed resampling'].filter(Boolean).join('; ')}`,
      `transform[${index}] (${c.name})`,
      'moving the target in Rev2D no longer moves the constrained bones; re-import after editing the motion in Spine',
    );
    ctx.report.count('emulatedConstraints.transform');
  }
}
