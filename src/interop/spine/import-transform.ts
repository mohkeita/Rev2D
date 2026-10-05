/**
 * Translate-only Spine transform constraints between sibling bones, baked into bone translation.
 *
 * A world-space (not local, not relative) transform constraint whose rotate / scale / shear mixes are
 * 0 and whose x and y mixes are equal (m) moves each constrained bone B toward the target point
 * P = targetWorld · offset: B' = B + m · (P − B). When B and the target T share their parent, this is
 * the same blend in the parent's local frame (affine maps preserve it):
 *   B'.local = B.local + m · (T.local · offset − B.local)
 * so it needs no world evaluation. The importer applies it to the setup pose (so attachments land
 * where Spine shows them) and to animations: while T and the constraint's mix are not animated it
 * only scales B's translation keys by (1 − m) (exact); otherwise B's translation is sampled.
 * Every other transform constraint is emulated by import-rules.ts (or reported when it cannot be).
 */
import { spineLocalMatrix } from './transform.js';
import type { BoneInfo, ImportContext } from './import-context.js';
import type { SpineKeyBase, SpineTransformData } from './types.js';

export interface TransformBake {
  name: string;
  /** Index in the skeleton's `transform` array. */
  index: number;
  bone: BoneInfo;
  target: BoneInfo;
  /** Setup mix of x and y. */
  mix: number;
  offsetX: number;
  offsetY: number;
  /** The bone's Spine local translation before the constraint (setup). */
  rawX: number;
  rawY: number;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Effective mixes of a transform constraint or one of its timeline keys (4.x and 3.x fields). */
export function transformMixes(c: Record<string, unknown>): { rotate: number; x: number; y: number; scaleX: number; scaleY: number; shearY: number } {
  if (['rotateMix', 'translateMix', 'scaleMix', 'shearMix'].some((k) => k in c)) {
    const t = num(c.translateMix, 1);
    const s = num(c.scaleMix, 1);
    return { rotate: num(c.rotateMix, 1), x: t, y: t, scaleX: s, scaleY: s, shearY: num(c.shearMix, 1) };
  }
  const x = num(c.mixX, 1);
  const scaleX = num(c.mixScaleX, 1);
  return { rotate: num(c.mixRotate, 1), x, y: num(c.mixY, x), scaleX, scaleY: num(c.mixScaleY, scaleX), shearY: num(c.mixShearY, 1) };
}

/** Translate-only with equal x / y mixes: the mix, else null. */
export function translateOnlyMix(c: Record<string, unknown>): number | null {
  const m = transformMixes(c);
  if (m.rotate !== 0 || m.scaleX !== 0 || m.scaleY !== 0 || m.shearY !== 0 || m.x !== m.y) return null;
  return m.x;
}

/**
 * Find bakeable transform constraints and apply them to the setup pose (bone nodes are updated in
 * place, before the setup world transforms are computed). Returns the bakes and the indices of the
 * constraints that are fully handled.
 */
export function planTransformBakes(ctx: ImportContext): { bakes: TransformBake[]; handled: Set<number> } {
  const bakes: TransformBake[] = [];
  const handled = new Set<number>();
  const ikBones = new Set((ctx.json.ik ?? []).flatMap((k) => k.bones ?? []));
  const list = (ctx.json.transform ?? []).map((c, index) => ({ c, index })).sort((a, b) => num(a.c.order, 0) - num(b.c.order, 0) || a.index - b.index);
  for (const { c, index } of list) {
    const reason = unsupportedReason(ctx, c, ikBones);
    if (reason) {
      (ctx.transformSkipReasons ??= new Map()).set(index, reason);
      continue;
    }
    const target = ctx.boneByName.get(c.target)!;
    const mix = translateOnlyMix(c)!;
    const ox = num(c.x, 0);
    const oy = num(c.y, 0);
    const lt = spineLocalMatrix(target.node);
    const px = lt[0] * ox + lt[2] * oy + lt[4];
    const py = lt[1] * ox + lt[3] * oy + lt[5];
    for (const name of c.bones) {
      const bone = ctx.boneByName.get(name)!;
      const bake: TransformBake = { name: c.name, index, bone, target, mix, offsetX: ox, offsetY: oy, rawX: bone.node.x, rawY: bone.node.y };
      bone.node.x += mix * (px - bone.node.x);
      bone.node.y += mix * (py - bone.node.y);
      bakes.push(bake);
    }
    handled.add(index);
  }
  return { bakes, handled };
}

function unsupportedReason(ctx: ImportContext, c: SpineTransformData, ikBones: Set<string>): string | null {
  if (c.local || c.relative) return `${c.local ? 'local' : 'relative'} transform constraints are not supported`;
  if (translateOnlyMix(c as Record<string, unknown>) === null) return 'only translate-only constraints (rotate/scale/shear mixes 0, equal x and y mixes) are converted';
  const target = ctx.boneByName.get(c.target);
  if (!target || !Array.isArray(c.bones) || c.bones.some((b) => !ctx.boneByName.has(b))) return 'bones or target missing';
  if (ikBones.has(target.name)) return 'its target is moved by an IK constraint';
  if (target.node.inherit !== 'normal' && (num(c.x, 0) !== 0 || num(c.y, 0) !== 0)) return 'its target does not inherit transforms normally';
  for (const name of c.bones) {
    const bone = ctx.boneByName.get(name)!;
    if (bone.parent !== target.parent) return `"${name}" and the target "${c.target}" do not share a parent bone`;
  }
  // Animated mixes must stay translate-only.
  for (const a of Object.values(ctx.json.animations ?? {})) {
    for (const k of (a.transform?.[c.name] ?? []) as Array<SpineKeyBase & Record<string, unknown>>) {
      if (translateOnlyMix(k) === null) return 'an animation mixes rotation, scale or shear';
    }
  }
  return null;
}
