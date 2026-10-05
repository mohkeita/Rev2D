/**
 * Spine skeleton JSON + atlas -> Rev2D model (setup pose). Animations are converted by
 * import-animations.ts.
 *
 * Mapping (see transform.ts for the math): Spine is y-up with counter-clockwise degrees, Rev2D is
 * y-down with clockwise degrees; with F = diag(1, -1) a local (x, y, rotation, scale) becomes
 * (x, -y, -rotation, scale), the whole skeleton is scaled by `scale` and translated so its setup
 * bounds fit the canvas with `padding`. Slots become parts in draw order (z = slot index), one part
 * per attachment of the imported skin: regions and meshes become textured `mesh` parts (unweighted
 * ones parented to the slot bone, weighted ones skinned with explicit weights), linked meshes reuse
 * their parent's geometry with their own region, clipping attachments become invisible mask parts.
 * The setup attachment of a slot is visible; its other attachments start at opacity 0.
 */
import { encodePNG } from '../../render/png.js';
import { apply, fromTRS, invert, multiply } from '../../core/math.js';
import type { ImageRGBA, RGBA } from '../../core/types.js';
import type { OutputFile, SpineImportInput, SpineImportResult } from '../types.js';
import { findRegion, parseAtlas, regionImageToPage, type Atlas, type AtlasRegion } from './atlas.js';
import { convertAnimations, effectiveStretch, findAlphaTintSlots, planIkVariants } from './import-animations.js';
import { emulateRulesAnimations, emulateRulesSetup } from './import-rules.js';
import { planTransformBakes } from './import-transform.js';
import {
  revLocalMatrix,
  sourceVertices,
  toCanvas,
  type BoneInfo,
  type IkInfo,
  type ImportContext,
  type Influence,
  type PartInfo,
  type SlotInfo,
  type SpineVersion,
  type VertexSource,
} from './import-context.js';
import { computeSpineWorlds, decomposeMatrix, rev2dLocalFromSpine, rev2dWorldFromSpine, svd2, type SpineBoneNode } from './transform.js';
import type {
  SpineAttachment,
  SpineBoneTimelines,
  SpineClippingAttachment,
  SpineInherit,
  SpineLinkedMeshAttachment,
  SpineMeshAttachment,
  SpineRegionAttachment,
  SpineSequence,
  SpineSkeletonJson,
  SpineSkinAttachments,
  SpineSkinData,
} from './types.js';
import { IdAllocator, ReportBuilder, WHITE, clean, fmt, parseSpineColor, toCssColor } from './util.js';

const INHERIT_MODES: SpineInherit[] = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];
const BLEND_MODES: Record<string, string> = { normal: 'normal', additive: 'add', multiply: 'multiply', screen: 'screen' };
/** Fill of parts whose texture region is unavailable. */
const UNTEXTURED_FILL = '#a0a0a0';
const DEFAULT_BONE_COLOR = '989898ff';

/** Import passes at most (each can move more bones to model space, see import-rules.ts). */
const MAX_PASSES = 3;

export function importSpine(input: SpineImportInput): SpineImportResult {
  // A pass that finds bones needing model space (inheritance emulation) is repeated with them, so the
  // attachments bound to them are computed against their new rest world from the start.
  const pngCache = new Map<string, Uint8Array>();
  let detach = new Set<string>();
  for (let pass = 1; ; pass++) {
    const { result, needDetach } = importPass(input, detach, pngCache);
    const more = [...needDetach].filter((n) => !detach.has(n));
    if (!more.length || pass >= MAX_PASSES) return result;
    detach = new Set([...detach, ...more]);
  }
}

function importPass(input: SpineImportInput, detach: Set<string>, pngCache: Map<string, Uint8Array>): { result: SpineImportResult; needDetach: Set<string> } {
  const report = new ReportBuilder('spine', 'import');
  const json = parseSkeletonJson(input.skeleton);
  const version = detectVersion(json, report);
  const scale = input.scale ?? 1;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error(`importSpine: scale must be a positive number, got ${scale}`);
  const padding = input.padding ?? 32;
  if (!(padding >= 0) || !Number.isFinite(padding)) throw new Error(`importSpine: padding must be a number >= 0, got ${padding}`);

  let atlas: Atlas | null = null;
  if (input.atlas !== undefined) {
    try {
      atlas = parseAtlas(input.atlas);
    } catch (e) {
      throw new Error(`importSpine: cannot read the atlas: ${(e as Error).message}`);
    }
  }

  const ctx: ImportContext = {
    input,
    json,
    version,
    legacy: version.major > 0 && version.major < 4,
    scale,
    report,
    bones: [],
    boneByName: new Map(),
    slots: [],
    slotByName: new Map(),
    skinChain: [],
    ik: [],
    ikByName: new Map(),
    canvas: [scale, 0, 0, -scale, 0, 0],
    events: json.events ?? {},
    animationIds: new IdAllocator(),
    ikIds: new IdAllocator(),
    alphaTintSlots: new Set(),
    transformBakes: [],
    transformHandled: new Set(),
    detach,
    needDetach: new Set(),
    transformEmulated: new Set(),
    transformInactive: new Set(),
  };

  readBones(ctx);
  ctx.alphaTintSlots = findAlphaTintSlots(json);
  const skins = readSkins(ctx);
  const pages = readPages(ctx, atlas, pngCache);
  const partIds = new IdAllocator();
  readSlots(ctx, skins, atlas, pages, partIds);

  // Canvas: setup bounds + padding.
  const bounds = setupBounds(ctx);
  const ox = Math.round(padding - bounds.x * scale);
  const oy = Math.round(padding + (bounds.y + bounds.height) * scale);
  ctx.canvas = [scale, 0, 0, -scale, ox, oy];
  // (Tolerance: trigonometry noise such as cos(90°) = 6e-17 must not add a pixel.)
  const width = Math.max(1, Math.ceil(bounds.width * scale + 2 * padding - 1e-6));
  const height = Math.max(1, Math.ceil(bounds.height * scale + 2 * padding - 1e-6));

  finishBones(ctx, ox, oy);
  readIk(ctx);
  planIkVariants(ctx);
  const inherit = { bones: () => ctx.bones.flatMap(boneJsons), ik: () => ctx.ik.flatMap((k) => ikJson(ctx, k)) };
  if (emulateRulesSetup(ctx, inherit)) {
    // Rest worlds changed (setup IK compensation, model-space bones): recompute the attachments' setup geometry.
    for (const s of ctx.slots) for (const p of s.parts) if (p.source) p.spineVertices = sourceVertices(p.source);
  }
  finishParts(ctx);
  applyClipping(ctx, width, height);
  reportOtherConstraints(ctx);
  const converted = convertAnimations(ctx);
  emulateRulesAnimations(ctx, converted, inherit);
  const animations = converted.map((a) => a.json);

  const doc: Record<string, unknown> = {
    format: 'rev2d',
    version: 1,
    meta: {
      name: input.name ?? 'spine',
      width,
      height,
      ...(typeof json.skeleton?.fps === 'number' && json.skeleton.fps > 0 ? { fps: json.skeleton.fps } : {}),
      description: `Imported from Spine ${version.raw || '(unknown version)'}${ctx.skinChain.length ? ` (skin "${ctx.skinChain[0]}")` : ''}`,
    },
  };
  if (pages.textures.length) doc.textures = pages.textures;
  doc.bones = ctx.bones.flatMap(boneJsons);
  doc.parts = ctx.slots.flatMap((s) => s.parts.map((p) => p.json));
  const ik = ctx.ik.flatMap((k) => ikJson(ctx, k));
  if (ik.length) doc.ik = ik;
  if (animations.length) doc.animations = animations;

  report.count('bones', ctx.bones.length);
  const shearBones = ctx.bones.filter((b) => b.shearPair).length;
  if (shearBones) report.count('shearBones', shearBones);
  report.count('slots', ctx.slots.length);
  report.count('parts', (doc.parts as unknown[]).length);
  report.count('textures', pages.textures.length);
  report.count('ik', ik.length);
  report.count('animations', animations.length);
  return { result: { doc, files: pages.files, report: report.build() }, needDetach: ctx.needDetach };
}

// ----------------------------------------------------------------------------- input

function parseSkeletonJson(input: string | Record<string, unknown>): SpineSkeletonJson {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
    } catch (e) {
      throw new Error(`importSpine: the skeleton is not valid JSON (${(e as Error).message}); binary .skel files are not supported, export JSON from Spine`);
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('importSpine: the skeleton must be a JSON object');
  const json = value as SpineSkeletonJson;
  if (!Array.isArray(json.bones) || json.bones.length === 0) {
    throw new Error('importSpine: the skeleton has no "bones" array (is this a Spine skeleton JSON export?)');
  }
  return json;
}

function detectVersion(json: SpineSkeletonJson, report: ReportBuilder): SpineVersion {
  const raw = typeof json.skeleton?.spine === 'string' ? json.skeleton.spine : '';
  const m = /^(\d+)\.(\d+)/.exec(raw);
  if (m) {
    const version = { raw, major: Number(m[1]), minor: Number(m[2]) };
    if (version.major < 3 || (version.major === 3 && version.minor < 8)) {
      report.warn('spine-version-old', `Spine ${raw} files are older than the supported 3.8 - 4.2 range; conversion is best effort`, 'skeleton.spine', 'export the skeleton again with Spine 3.8 or newer');
    } else if (version.major > 4 || (version.major === 4 && version.minor > 2)) {
      report.warn('spine-version-new', `Spine ${raw} is newer than the tested 3.8 - 4.2 range; new features may be missing from the report`, 'skeleton.spine');
    }
    return version;
  }
  // Guess from the structure: 3.7-style skins objects or `angle` rotate keys mean 3.x.
  const legacy =
    (json.skins !== undefined && !Array.isArray(json.skins)) ||
    Object.values(json.animations ?? {}).some((a) => Object.values(a.bones ?? {}).some((b) => b.rotate?.some((k) => k.angle !== undefined)));
  report.info(
    'spine-version-unknown',
    `the skeleton does not name its Spine version; reading it as ${legacy ? '3.x' : '4.x'} based on its structure`,
    'skeleton.spine',
    'export with nonessential data, or check the animation curves after import',
  );
  return legacy ? { raw: '', major: 3, minor: 8 } : { raw: '', major: 4, minor: 2 };
}

// ----------------------------------------------------------------------------- bones

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readBones(ctx: ImportContext): void {
  const ids = new IdAllocator();
  const data = ctx.json.bones!;
  const nodes: SpineBoneNode[] = [];
  data.forEach((b, i) => {
    const where = `bones[${i}] (${b.name})`;
    if (typeof b.name !== 'string' || !b.name) throw new Error(`importSpine: ${where} has no name`);
    if (ctx.boneByName.has(b.name)) throw new Error(`importSpine: duplicate bone name "${b.name}"`);
    let parent: BoneInfo | null = null;
    if (b.parent !== undefined && b.parent !== null) {
      parent = ctx.boneByName.get(b.parent) ?? null;
      if (!parent) throw new Error(`importSpine: ${where}: parent "${b.parent}" is not defined before it`);
    }
    let inherit: SpineInherit = b.inherit ?? b.transform ?? 'normal';
    if (!INHERIT_MODES.includes(inherit)) {
      ctx.report.warn('spine-bone-inherit-unknown', `unknown transform inheritance "${inherit}", using "normal"`, where);
      inherit = 'normal';
    }
    const node: SpineBoneNode = {
      parent: parent ? parent.index : -1,
      x: num(b.x, 0),
      y: num(b.y, 0),
      rotation: num(b.rotation, 0),
      scaleX: num(b.scaleX, 1),
      scaleY: num(b.scaleY, 1),
      shearX: num(b.shearX, 0),
      shearY: num(b.shearY, 0),
      inherit,
    };
    nodes.push(node);
    const id = ids.allocate(b.name);
    if (id !== b.name) ctx.report.info('spine-id-renamed', `bone "${b.name}" is "${id}" in Rev2D (ids allow letters, digits, _ and -)`, where);
    // Shear is reproduced with a second bone (planShearPairs), non-normal inheritance is emulated
    // (import-rules.ts); both report what they do.
    const info: BoneInfo = {
      index: i,
      name: b.name,
      id,
      parent,
      node,
      length: Math.max(0, num(b.length, 0)),
      color: boneColor(ctx, b.color, where),
      spineWorld: [1, 0, 0, 1, 0, 0],
      rev: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0 },
      revWorld: [1, 0, 0, 1, 0, 0],
    };
    ctx.bones.push(info);
    ctx.boneByName.set(b.name, info);
  });
  // Translate-only sibling transform constraints change the setup pose Spine shows: apply them first.
  const { bakes, handled } = planTransformBakes(ctx);
  ctx.transformBakes = bakes;
  ctx.transformHandled = handled;
  const worlds = computeSpineWorlds(nodes);
  ctx.bones.forEach((b, i) => (b.spineWorld = worlds[i]));
  planShearPairs(ctx, ids);
}

/** Whether a bone timeline sets a non-zero shear. */
function animatesShear(tl: SpineBoneTimelines | undefined): boolean {
  if (!tl) return false;
  return (
    (tl.shear ?? []).some((k) => num(k.x, 0) !== 0 || num(k.y, 0) !== 0) ||
    (tl.shearx ?? []).some((k) => num(k.value, 0) !== 0) ||
    (tl.sheary ?? []).some((k) => num(k.value, 0) !== 0)
  );
}

/**
 * Bones with shear (setup or animated) become two Rev2D bones (BoneInfo.shearPair): Rev2D bones cannot
 * shear, but a rotated child of a non-uniformly scaled bone can, and every 2x2 transform is
 * R(phi)·diag(sx, sy)·R(theta). Bones inside IK chains or with non-normal inheritance keep one bone
 * (the shear is dropped and reported).
 */
function planShearPairs(ctx: ImportContext, ids: IdAllocator): void {
  const ikBones = new Set((ctx.json.ik ?? []).flatMap((k) => k.bones ?? []));
  const animations = Object.values(ctx.json.animations ?? {});
  for (const b of ctx.bones) {
    const n = b.node;
    const setup = n.shearX !== 0 || n.shearY !== 0;
    const animated = animations.filter((a) => animatesShear(a?.bones?.[b.name])).length;
    if (!setup && !animated) continue;
    const where = `bones[${b.index}] (${b.name})`;
    const inheritTimeline = animations.some((a) => (a?.bones?.[b.name]?.inherit?.length ?? 0) > 0);
    if (ikBones.has(b.name) || n.inherit !== 'normal' || inheritTimeline) {
      if (setup) {
        ctx.report.warn(
          'spine-bone-shear',
          `shear (${fmt(n.shearX)}°, ${fmt(n.shearY)}°) is dropped: ${ikBones.has(b.name) ? 'the bone is inside an IK chain' : 'the bone does not inherit its parent normally'}, so it is not split into a scale bone and a rotation bone; the setup pose keeps its world transform as closely as possible without shear`,
          where,
          'remove the shear in Spine (use rotation / non-uniform scale) for an exact conversion',
        );
      }
      continue;
    }
    b.shearPair = { outerId: ids.allocate(`${b.id}-shear`), phi: 0, theta: 0, sx: 1, sy: 1 };
    ctx.report.info(
      'spine-bone-shear-pair',
      `shear (${setup ? `setup ${fmt(n.shearX)}°, ${fmt(n.shearY)}°` : 'none in the setup pose'}${animated ? `; animated in ${animated} animation${animated > 1 ? 's' : ''}` : ''}) is reproduced exactly with an extra bone "${b.shearPair.outerId}" (translation, rotation, non-uniform scale) that "${b.id}" sits on with its own rotation`,
      where,
      `key "${b.shearPair.outerId}" for translation, rotation and scale in Rev2D; "${b.id}" carries the rest of the shear`,
    );
  }
}

/** Rev2D local values once the canvas offset is known. Exact where Rev2D can express the bone. */
function finishBones(ctx: ImportContext, ox: number, oy: number): void {
  const S = ctx.scale;
  const worldExact: boolean[] = [];
  for (const b of ctx.bones) {
    const target = rev2dWorldFromSpine(b.spineWorld, ctx.canvas, S);
    const n = b.node;
    const parentExact = b.parent ? worldExact[b.parent.index] : true;
    if (b.shearPair) {
      // Local transform (exact up to the parent's own error) split into outer rotation-scale and inner rotation.
      const local = b.parent ? multiply(invert(b.parent.revWorld), target) : target;
      const svd = svd2(local[0], local[1], local[2], local[3], -n.rotation);
      b.rev = { x: local[4], y: local[5], rotation: -n.rotation, scaleX: n.scaleX, scaleY: n.scaleY, length: b.length * S };
      Object.assign(b.shearPair, { phi: clean(svd.phi - b.rev.rotation), theta: clean(svd.theta), sx: clean(svd.sx), sy: clean(svd.sy) });
    } else if (n.inherit === 'normal' && n.shearX === 0 && n.shearY === 0 && parentExact) {
      const l = rev2dLocalFromSpine(n, S);
      if (!b.parent) {
        l.x += ox;
        l.y += oy;
      }
      b.rev = { ...l, length: b.length * S };
    } else {
      const local = b.parent ? multiply(invert(b.parent.revWorld), target) : target;
      const d = decomposeMatrix(local);
      b.rev = { x: d.x, y: d.y, rotation: d.rotation, scaleX: d.scaleX, scaleY: d.scaleY, length: b.length * S };
    }
    const r = b.rev;
    for (const k of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'length'] as const) r[k] = clean(r[k]);
    const m = revLocalMatrix(b);
    b.revWorld = b.parent ? multiply(b.parent.revWorld, m) : m;
    const err = Math.max(...b.revWorld.map((v, k) => Math.abs(v - target[k]) / (k < 4 ? 1 : Math.max(1, S))));
    worldExact[b.index] = err < 1e-6;
  }
}

function boneColor(ctx: ImportContext, hex: string | undefined, where: string): string | undefined {
  if (hex === undefined || hex.toLowerCase() === DEFAULT_BONE_COLOR) return undefined;
  const c = parseSpineColor(hex);
  if (!c) {
    ctx.report.warn('spine-color-invalid', `invalid bone color "${hex}" ignored`, where);
    return undefined;
  }
  return toCssColor(c, true);
}

/** Rev2D bone JSON of a Spine bone: one bone, or the two bones of a shear pair (outer, then this bone). */
function boneJsons(b: BoneInfo): Array<Record<string, unknown>> {
  const p = b.shearPair;
  if (!p) return [boneJson(b)];
  const r = b.rev;
  const outer: Record<string, unknown> = { id: p.outerId };
  if (b.parent) outer.parent = b.parent.id;
  if (r.x !== 0) outer.x = r.x;
  if (r.y !== 0) outer.y = r.y;
  const rotation = clean(r.rotation + p.phi);
  if (rotation !== 0) outer.rotation = rotation;
  if (p.sx !== 1) outer.scaleX = p.sx;
  if (p.sy !== 1) outer.scaleY = p.sy;
  outer.description = `Spine bone "${b.name}": translation, rotation and scale; with the rotation of "${b.id}" it reproduces the bone's shear`;
  const inner: Record<string, unknown> = { id: b.id, parent: p.outerId };
  if (p.theta !== 0) inner.rotation = p.theta;
  if (r.length !== 0) inner.length = r.length;
  if (b.color) inner.color = b.color;
  inner.description = `Spine bone "${b.name}" (sheared: it sits on "${p.outerId}")`;
  return [outer, inner];
}

function boneJson(b: BoneInfo): Record<string, unknown> {
  const out: Record<string, unknown> = { id: b.id };
  if (b.parent) out.parent = b.parent.id;
  const r = b.rev;
  if (r.x !== 0) out.x = r.x;
  if (r.y !== 0) out.y = r.y;
  if (r.rotation !== 0) out.rotation = r.rotation;
  if (r.scaleX !== 1) out.scaleX = r.scaleX;
  if (r.scaleY !== 1) out.scaleY = r.scaleY;
  if (r.length !== 0) out.length = r.length;
  if (b.color) out.color = b.color;
  if (b.id !== b.name) out.description = `Spine bone "${b.name}"`;
  return out;
}

// ----------------------------------------------------------------------------- skins

interface SkinTable {
  /** skin name -> slot -> attachment name -> attachment */
  byName: Map<string, SpineSkinAttachments>;
}

function readSkins(ctx: ImportContext): SkinTable {
  const byName = new Map<string, SpineSkinAttachments>();
  const raw = ctx.json.skins;
  if (Array.isArray(raw)) {
    raw.forEach((s: SpineSkinData, i) => {
      if (typeof s?.name !== 'string') {
        ctx.report.warn('spine-skin-invalid', 'skin without a name ignored', `skins[${i}]`);
        return;
      }
      byName.set(s.name, s.attachments ?? {});
      if (s.bones?.length || s.ik?.length || s.transform?.length || s.path?.length || s.physics?.length) {
        ctx.report.info(
          'spine-skin-constraints',
          `skin "${s.name}" lists skin-specific bones/constraints; Rev2D imports every bone and constraint regardless of the skin`,
          `skins[${i}] (${s.name})`,
        );
      }
    });
  } else if (raw && typeof raw === 'object') {
    for (const [name, atts] of Object.entries(raw)) byName.set(name, atts ?? {});
  }
  const requested = ctx.input.skin;
  let selected = requested ?? 'default';
  if (!byName.has(selected)) {
    const fallback = byName.has('default') ? 'default' : ([...byName.keys()][0] ?? null);
    if (requested !== undefined) {
      ctx.report.warn(
        'spine-skin-missing',
        `skin "${requested}" does not exist${fallback ? `; importing "${fallback}" instead` : ''}`,
        'skins',
        `available skins: ${[...byName.keys()].join(', ') || '(none)'}`,
      );
    } else if (fallback) {
      ctx.report.info('spine-skin-default-missing', `the skeleton has no "default" skin; importing "${fallback}"`, 'skins');
    }
    selected = fallback ?? 'default';
  }
  ctx.skinChain = byName.has(selected) ? (selected === 'default' || !byName.has('default') ? [selected] : [selected, 'default']) : [];
  const others = [...byName.keys()].filter((n) => !ctx.skinChain.includes(n));
  if (others.length) {
    const list = others.length > 12 ? `${others.slice(0, 12).join(', ')}, ... (+${others.length - 12})` : others.join(', ');
    ctx.report.info(
      'spine-skin-not-imported',
      `${others.length} other skin${others.length > 1 ? 's' : ''} not imported: ${list}`,
      'skins',
      'import again with the `skin` option to convert another skin (attachments missing from it fall back to "default")',
    );
  }
  return { byName };
}

/** Attachments of a slot in the skin chain (selected skin wins over "default"), in skin order. */
function slotAttachments(ctx: ImportContext, skins: SkinTable, slot: string): Map<string, { att: SpineAttachment; skin: string }> {
  const out = new Map<string, { att: SpineAttachment; skin: string }>();
  for (const skin of ctx.skinChain) {
    const atts = skins.byName.get(skin)?.[slot];
    if (!atts) continue;
    for (const [name, att] of Object.entries(atts)) if (!out.has(name)) out.set(name, { att, skin });
  }
  return out;
}

// ----------------------------------------------------------------------------- textures

interface PageTexture {
  id: string;
  /** Size that page pixel coordinates are normalized by. */
  uvWidth: number;
  uvHeight: number;
}

interface Pages {
  /** Index-aligned with atlas.pages; null when the page image is unavailable. */
  byIndex: Array<PageTexture | null>;
  textures: Array<Record<string, unknown>>;
  files: OutputFile[];
}

function findPageImage(pages: Record<string, ImageRGBA> | undefined, name: string): ImageRGBA | undefined {
  if (!pages) return undefined;
  if (pages[name]) return pages[name];
  const base = (s: string) => s.split(/[\\/]/).pop()!.toLowerCase();
  const key = Object.keys(pages).find((k) => base(k) === base(name));
  return key ? pages[key] : undefined;
}

/** Straight alpha from premultiplied RGBA8. */
export function unpremultiply(img: ImageRGBA): ImageRGBA {
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0 || a === 255) continue;
    data[i] = Math.min(255, Math.round((data[i] * 255) / a));
    data[i + 1] = Math.min(255, Math.round((data[i + 1] * 255) / a));
    data[i + 2] = Math.min(255, Math.round((data[i + 2] * 255) / a));
  }
  return { width: img.width, height: img.height, data };
}

/** Heuristic: no semi-transparent pixel has a color channel above its alpha (typical of premultiplied images). */
function looksPremultiplied(img: ImageRGBA): boolean {
  let translucent = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0 || a === 255) continue;
    if (d[i] > a || d[i + 1] > a || d[i + 2] > a) return false;
    translucent++;
  }
  return translucent >= 64;
}

function readPages(ctx: ImportContext, atlas: Atlas | null, pngCache: Map<string, Uint8Array>): Pages {
  const out: Pages = { byIndex: [], textures: [], files: [] };
  if (!atlas) return out;
  const ids = new IdAllocator();
  const paths = new Set<string>();
  atlas.pages.forEach((page, i) => {
    const where = `atlas page "${page.name}"`;
    const img = findPageImage(ctx.input.pages, page.name);
    if (!img) {
      ctx.report.warn(
        'spine-page-missing',
        `no image for atlas page "${page.name}"; its regions are imported untextured`,
        where,
        `pass the decoded page image as pages["${page.name}"]`,
      );
      out.byIndex.push(null);
      return;
    }
    let image = img;
    if (page.pma) {
      image = unpremultiply(img);
      ctx.report.info('spine-page-unpremultiplied', `page "${page.name}" has premultiplied alpha; converted to straight alpha for Rev2D`, where);
    } else if (looksPremultiplied(img)) {
      ctx.report.warn(
        'spine-page-maybe-pma',
        `page "${page.name}" looks premultiplied (no translucent pixel is brighter than its alpha) but the atlas does not say "pma: true"; it is imported as straight alpha, so translucent edges may look dark`,
        where,
        'if Spine exported it with "Premultiply alpha", add "pma: true" under the page name in the atlas and import again',
      );
    }
    const base = page.name.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '') || `page${i}`;
    const id = ids.allocate(base);
    let path = `textures/${base}.png`;
    for (let n = 2; paths.has(path); n++) path = `textures/${base}-${n}.png`;
    paths.add(path);
    let bytes = pngCache.get(path);
    if (!bytes) {
      bytes = encodePNG(image);
      pngCache.set(path, bytes);
    }
    out.files.push({ path, bytes });
    out.textures.push({ id, path, width: image.width, height: image.height });
    out.byIndex.push({ id, uvWidth: page.width > 0 ? page.width : image.width, uvHeight: page.height > 0 ? page.height : image.height });
    if (page.width > 0 && page.height > 0 && (page.width !== image.width || page.height !== image.height)) {
      ctx.report.info(
        'spine-page-size',
        `page image is ${image.width}x${image.height} but the atlas says ${page.width}x${page.height}; texture coordinates follow the atlas`,
        where,
      );
    }
  });
  return out;
}

// ----------------------------------------------------------------------------- slots & attachments

interface RegionRef {
  region: AtlasRegion;
  page: PageTexture;
}

/**
 * Atlas region name of an attachment: its `path`, else its `name` (which overrides the skin key),
 * else the skin key. A sequence frame (0-based index; default the setup frame) appends its number
 * `start + index`, zero-padded to `digits`.
 */
function regionName(att: { path?: string; name?: string; sequence?: SpineSequence }, name: string, frame?: number): string {
  const path = att.path ?? att.name ?? name;
  const seq = att.sequence;
  if (!seq) return path;
  return path + sequenceLabel(seq, frame ?? sequenceSetup(seq));
}

/** Frames of an image sequence (>= 1). */
function sequenceCount(seq: SpineSequence): number {
  return Math.max(1, Math.floor(num(seq.count, 1)));
}

/** Frame shown in the setup pose (Spine clamps it to the last frame). */
function sequenceSetup(seq: SpineSequence): number {
  return Math.min(sequenceCount(seq) - 1, Math.max(0, Math.floor(num(seq.setup, 0))));
}

/** Region-name suffix of frame `index`: `start + index`, zero-padded to `digits`. */
function sequenceLabel(seq: SpineSequence, index: number): string {
  return String(num(seq.start, 1) + index).padStart(num(seq.digits, 0), '0');
}

function lookupRegion(ctx: ImportContext, atlas: Atlas | null, pages: Pages, name: string, where: string): RegionRef | null {
  if (!atlas) {
    ctx.report.warn(
      'spine-no-atlas',
      'no atlas given: textured attachments are imported as untextured gray shapes',
      'atlas',
      'pass the .atlas text (and its page images) to import textures',
    );
    return null;
  }
  const region = findRegion(atlas, name);
  if (!region) {
    ctx.report.warn('spine-region-missing', `atlas region "${name}" not found; the attachment is imported untextured`, where, 'check the atlas matches this skeleton export');
    return null;
  }
  const page = pages.byIndex[region.page];
  if (!page) return null; // reported per page
  return { region, page };
}

function readSlots(ctx: ImportContext, skins: SkinTable, atlas: Atlas | null, pages: Pages, partIds: IdAllocator): void {
  const slotIds = new IdAllocator();
  (ctx.json.slots ?? []).forEach((s, i) => {
    const where = `slots[${i}] (${s.name})`;
    const bone = ctx.boneByName.get(s.bone);
    if (!bone) {
      ctx.report.warn('spine-slot-bone-missing', `slot bone "${s.bone}" does not exist; slot skipped`, where);
      return;
    }
    const color = parseSpineColor(s.color ?? 'ffffffff') ?? WHITE;
    if (s.color !== undefined && !parseSpineColor(s.color)) ctx.report.warn('spine-color-invalid', `invalid color "${s.color}", using white`, where);
    if (s.dark !== undefined) {
      ctx.report.warn(
        'spine-dark-color',
        `two-color tint (dark color ${s.dark}) is not supported; only the light color is imported`,
        where,
        'bake the dark tint into the texture, or approximate it with a darker tint',
      );
    }
    const slot: SlotInfo = {
      index: ctx.slots.length,
      name: s.name,
      bone,
      color,
      setupAttachment: s.attachment ?? null,
      parts: [],
      alphaInTint: ctx.alphaTintSlots.has(s.name),
    };
    if (slot.alphaInTint) {
      ctx.report.info(
        'spine-slot-alpha-in-tint',
        "an animation changes both this slot's alpha and its attachment: the alpha is kept in the parts' tint alpha (exact), opacity only switches the attachments",
        where,
      );
    }
    slotIds.allocate(s.name);
    ctx.slots.push(slot);
    ctx.slotByName.set(s.name, slot);
    const blend = BLEND_MODES[s.blend ?? 'normal'];
    if (!blend) ctx.report.warn('spine-blend-unknown', `unknown blend mode "${s.blend}", using normal`, where);
    const atts = slotAttachments(ctx, skins, s.name);
    if (slot.setupAttachment !== null && !atts.has(slot.setupAttachment)) {
      ctx.report.warn('spine-attachment-missing', `setup attachment "${slot.setupAttachment}" is not in the imported skin`, where);
    }
    for (const [name, { att, skin }] of atts) {
      const attWhere = `skins.${skin}.${s.name}.${name}`;
      const frames = readAttachment(ctx, skins, atlas, pages, slot, name, att, skin, attWhere);
      if (!frames.length) continue;
      ctx.report.count(`attachments.${frames[0].kind}`);
      const sequence = frames.length > 1;
      if (sequence) {
        ctx.report.info(
          'spine-sequence',
          `image sequence of ${frames.length} frames: one part per frame, shown one at a time (opacity) as the setup frame and the sequence timelines select`,
          attWhere,
        );
        ctx.report.count('sequenceFrames', frames.length);
      }
      const base = atts.size === 1 ? s.name : `${s.name}__${name}`;
      for (const part of frames) {
        part.id = partIds.allocate(sequence && part.sequence ? `${base}__${part.sequence.label}` : base);
        part.json = { id: part.id, ...part.json };
        const visible = slot.setupAttachment === name && (!part.sequence || part.sequence.index === part.sequence.setup);
        const alpha = color[3] * part.color[3];
        if (part.kind === 'clipping') {
          part.json.opacity = 0;
        } else {
          const opacity = visible ? (slot.alphaInTint ? 1 : alpha) : 0;
          if (opacity !== 1) part.json.opacity = opacity;
          const tint: RGBA = [color[0] * part.color[0], color[1] * part.color[1], color[2] * part.color[2], slot.alphaInTint ? alpha : 1];
          if (tint.some((c) => c !== 1)) part.json.tint = toCssColor(tint);
        }
        if (blend && blend !== 'normal' && part.kind !== 'clipping') part.json.blend = blend;
        part.json.z = slot.index;
        part.json.tags = [`spine-slot:${s.name}`, `spine-attachment:${name}`, ...(sequence && part.sequence ? [`spine-sequence-frame:${part.sequence.index}`] : [])];
        slot.parts.push(part);
      }
    }
  });
}

function newPart(slot: SlotInfo, name: string, skin: string, kind: PartInfo['kind'], color: RGBA): PartInfo {
  return { id: '', slot, attachmentName: name, skinName: skin, kind, color, spineVertices: [], json: {} };
}

function readAttachment(
  ctx: ImportContext,
  skins: SkinTable,
  atlas: Atlas | null,
  pages: Pages,
  slot: SlotInfo,
  name: string,
  att: SpineAttachment,
  skin: string,
  where: string,
): PartInfo[] {
  const type = att.type ?? 'region';
  const color = parseSpineColor((att as { color?: string }).color ?? 'ffffffff') ?? WHITE;
  /**
   * The parts of an attachment: one per frame of an image sequence (all with the same geometry and
   * their own region), else one. `timeline`: the attachment whose sequence timelines select frames.
   */
  const frames = (seq: SpineSequence | undefined, timeline: { skin: string; attachment: string }, make: (frame?: number) => PartInfo | null): PartInfo[] => {
    if (!seq) {
      const p = make();
      return p ? [p] : [];
    }
    const count = sequenceCount(seq);
    const setup = sequenceSetup(seq);
    const out: PartInfo[] = [];
    for (let i = 0; i < count; i++) {
      const p = make(i);
      if (!p) return [];
      p.sequence = { index: i, count, setup, label: sequenceLabel(seq, i), timeline };
      out.push(p);
    }
    return out;
  };
  switch (type) {
    case 'region': {
      const region = att as SpineRegionAttachment;
      return frames(region.sequence, { skin, attachment: name }, (f) => regionPart(ctx, atlas, pages, slot, name, region, skin, color, where, f));
    }
    case 'mesh':
    case 'skinnedmesh':
    case 'weightedmesh': {
      const mesh = att as SpineMeshAttachment;
      const key = { skin, attachment: name };
      return frames(mesh.sequence, key, (f) => meshPart(ctx, atlas, pages, slot, name, mesh, mesh, skin, color, where, key, 'mesh', f));
    }
    case 'linkedmesh':
    case 'weightedlinkedmesh': {
      const linked = att as SpineLinkedMeshAttachment;
      const parentSkin = linked.skin ?? 'default';
      const parent = skins.byName.get(parentSkin)?.[slot.name]?.[linked.parent];
      const ptype = parent?.type ?? 'region';
      if (!parent || !['mesh', 'skinnedmesh', 'weightedmesh'].includes(ptype)) {
        ctx.report.warn(
          'spine-linkedmesh-parent-missing',
          `parent mesh "${linked.parent}" not found in skin "${parentSkin}" slot "${slot.name}"; attachment skipped`,
          where,
        );
        return [];
      }
      const useParentTimelines = linked.timelines ?? linked.deform ?? true;
      const deformKey = useParentTimelines ? { skin: parentSkin, attachment: linked.parent } : { skin, attachment: name };
      return frames(linked.sequence, deformKey, (f) => meshPart(ctx, atlas, pages, slot, name, linked, parent as SpineMeshAttachment, skin, color, where, deformKey, 'linkedmesh', f));
    }
    case 'clipping': {
      const clip = clippingPart(ctx, slot, name, att as SpineClippingAttachment, skin, color, where);
      return clip ? [clip] : [];
    }
    case 'boundingbox':
    case 'point':
    case 'path':
      ctx.report.info(
        'spine-attachment-skipped',
        `${type} attachment "${name}" has no Rev2D equivalent and is skipped`,
        where,
        type === 'point' ? 'add a small bone at that spot if you need to attach effects' : undefined,
      );
      ctx.report.count(`attachments.${type}`);
      return [];
    default:
      ctx.report.warn('spine-attachment-unknown', `unknown attachment type "${type}" skipped`, where);
      return [];
  }
}

function regionPart(
  ctx: ImportContext,
  atlas: Atlas | null,
  pages: Pages,
  slot: SlotInfo,
  name: string,
  att: SpineRegionAttachment,
  skin: string,
  color: RGBA,
  where: string,
  frame?: number,
): PartInfo {
  const part = newPart(slot, name, skin, 'region', color);
  const ref = lookupRegion(ctx, atlas, pages, regionName(att, name, frame), where);
  const w = num(att.width, 0);
  const h = num(att.height, 0);
  const sx = num(att.scaleX, 1);
  const sy = num(att.scaleY, 1);
  // Content rect in attachment space (y up) and the matching original-image pixels (y down).
  let lx = (-w / 2) * sx;
  let ly = (-h / 2) * sy;
  let lx2 = (w / 2) * sx;
  let ly2 = (h / 2) * sy;
  let img: Array<[number, number]> | null = null;
  if (ref) {
    const r = ref.region;
    const rsx = r.originalWidth > 0 ? (w / r.originalWidth) * sx : 0;
    const rsy = r.originalHeight > 0 ? (h / r.originalHeight) * sy : 0;
    lx = (-w / 2) * sx + r.offsetX * rsx;
    ly = (-h / 2) * sy + r.offsetY * rsy;
    lx2 = lx + r.width * rsx;
    ly2 = ly + r.height * rsy;
    const top = r.originalHeight - r.offsetY - r.height;
    const bottom = r.originalHeight - r.offsetY;
    img = [
      [r.offsetX, bottom],
      [r.offsetX, top],
      [r.offsetX + r.width, top],
      [r.offsetX + r.width, bottom],
    ];
  }
  const rot = (num(att.rotation, 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const ax = num(att.x, 0);
  const ay = num(att.y, 0);
  const corners = [lx, ly, lx, ly2, lx2, ly2, lx2, ly];
  const local: number[] = [];
  for (let i = 0; i < 8; i += 2) {
    local.push(corners[i] * cos - corners[i + 1] * sin + ax, corners[i] * sin + corners[i + 1] * cos + ay);
  }
  // Corners in the slot bone's space (no deform key: region attachments have no deform timelines).
  part.source = { weighted: false, bone: slot.bone, local };
  part.spineVertices = sourceVertices(part.source);
  part.json = { parent: slot.bone.id, shape: { type: 'mesh', vertices: [], triangles: [0, 1, 2, 2, 3, 0] } };
  if (ref && img) {
    const uvs: number[] = [];
    for (const [px, py] of img) {
      const [qx, qy] = regionImageToPage(ref.region, px, py);
      uvs.push(clean(qx / ref.page.uvWidth), clean(qy / ref.page.uvHeight));
    }
    Object.assign(part.json.shape as object, { uvs, texture: ref.page.id });
  } else {
    part.json.fill = UNTEXTURED_FILL;
  }
  return part;
}

/** Parse mesh vertices into a vertex source; null (reported) when malformed. */
function meshSource(ctx: ImportContext, slot: SlotInfo, vertices: number[], vertexCount: number, where: string): VertexSource | null {
  if (vertices.length === vertexCount * 2) return { weighted: false, bone: slot.bone, local: vertices.slice() };
  const influences: Influence[][] = [];
  let i = 0;
  for (let v = 0; v < vertexCount; v++) {
    const n = vertices[i++];
    if (!Number.isInteger(n) || n < 1 || i + n * 4 > vertices.length) {
      ctx.report.warn('spine-mesh-invalid', `weighted vertex ${v} is malformed; attachment skipped`, where);
      return null;
    }
    const infl: Influence[] = [];
    for (let k = 0; k < n; k++) {
      const bone = ctx.bones[vertices[i]];
      if (!bone) {
        ctx.report.warn('spine-mesh-invalid', `weighted vertex ${v} names bone index ${vertices[i]} which does not exist; attachment skipped`, where);
        return null;
      }
      infl.push({ bone, x: vertices[i + 1], y: vertices[i + 2], w: vertices[i + 3] });
      i += 4;
    }
    influences.push(infl);
  }
  if (i !== vertices.length) {
    ctx.report.warn('spine-mesh-invalid', `weighted vertex data has ${vertices.length - i} extra values; attachment skipped`, where);
    return null;
  }
  return { weighted: true, influences };
}

function meshPart(
  ctx: ImportContext,
  atlas: Atlas | null,
  pages: Pages,
  slot: SlotInfo,
  name: string,
  att: SpineMeshAttachment | SpineLinkedMeshAttachment,
  mesh: SpineMeshAttachment,
  skin: string,
  color: RGBA,
  where: string,
  deformKey: { skin: string; attachment: string },
  kind: 'mesh' | 'linkedmesh' = 'mesh',
  frame?: number,
): PartInfo | null {
  const uvs = Array.isArray(mesh.uvs) ? mesh.uvs : [];
  const triangles = Array.isArray(mesh.triangles) ? mesh.triangles : [];
  const vertexCount = uvs.length / 2;
  if (!Number.isInteger(vertexCount) || vertexCount < 3 || triangles.length % 3 !== 0 || triangles.some((t) => !(t >= 0 && t < vertexCount))) {
    ctx.report.warn('spine-mesh-invalid', 'mesh has invalid uvs or triangles; attachment skipped', where);
    return null;
  }
  const source = meshSource(ctx, slot, Array.isArray(mesh.vertices) ? mesh.vertices : [], vertexCount, where);
  if (!source) return null;
  const part = newPart(slot, name, skin, kind, color);
  part.source = source;
  part.deformKey = deformKey;
  part.spineVertices = sourceVertices(source);
  const shape: Record<string, unknown> = { type: 'mesh', vertices: [], triangles: triangles.slice() };
  const ref = lookupRegion(ctx, atlas, pages, regionName(att, name, frame), where);
  if (ref) {
    const r = ref.region;
    const pageUvs: number[] = [];
    for (let i = 0; i < uvs.length; i += 2) {
      const [qx, qy] = regionImageToPage(r, uvs[i] * r.originalWidth, uvs[i + 1] * r.originalHeight);
      pageUvs.push(clean(qx / ref.page.uvWidth), clean(qy / ref.page.uvHeight));
    }
    shape.uvs = pageUvs;
    shape.texture = ref.page.id;
  }
  part.json = { shape };
  if (!ref) part.json.fill = UNTEXTURED_FILL;
  if (source.weighted) {
    const bones: BoneInfo[] = [];
    for (const infl of source.influences) for (const f of infl) if (!bones.includes(f.bone)) bones.push(f.bone);
    const weights = source.influences.map((infl) => {
      const row = new Array<number>(bones.length).fill(0);
      for (const f of infl) row[bones.indexOf(f.bone)] += f.w;
      return row;
    });
    part.json.skin = { bones: bones.map((b) => b.id), weights };
    checkWeightedOffsets(ctx, source, where);
  } else {
    part.json.parent = slot.bone.id;
  }
  return part;
}

/**
 * Rev2D skins one setup-space position per vertex; Spine keeps one bone-local position per influence.
 * They agree in every pose only when all influences put the vertex at the same setup position.
 */
function checkWeightedOffsets(ctx: ImportContext, src: VertexSource, where: string): void {
  if (!src.weighted) return;
  let worst = 0;
  for (const infl of src.influences) {
    let wx = 0;
    let wy = 0;
    const pts = infl.map((f) => apply(f.bone.spineWorld, f.x, f.y));
    infl.forEach((f, k) => {
      wx += pts[k][0] * f.w;
      wy += pts[k][1] * f.w;
    });
    infl.forEach((f, k) => (worst = Math.max(worst, f.w * Math.hypot(pts[k][0] - wx, pts[k][1] - wy) * ctx.scale)));
  }
  if (worst > 1) {
    ctx.report.info(
      'spine-weighted-offsets',
      `the bones' setup positions of some weighted vertices disagree by up to ${fmt(worst)} px (weighted); Rev2D skins their weighted average, so posed shapes can differ slightly from Spine`,
      where,
      'in Spine, re-bind the mesh weights in the current setup pose',
    );
  }
}

function clippingPart(ctx: ImportContext, slot: SlotInfo, name: string, att: SpineClippingAttachment, skin: string, color: RGBA, where: string): PartInfo | null {
  const count = num(att.vertexCount, 0);
  const verts = Array.isArray(att.vertices) ? att.vertices : [];
  if (count < 3) {
    ctx.report.warn('spine-clipping-invalid', 'clipping polygon has fewer than 3 vertices; skipped', where);
    return null;
  }
  const source = meshSource(ctx, slot, verts, count, where);
  if (!source) return null;
  const part = newPart(slot, name, skin, 'clipping', color);
  part.source = source;
  // Deform timelines of the clipping attachment animate its polygon (shape.points).
  part.deformKey = { skin, attachment: name };
  part.spineVertices = sourceVertices(source);
  let parent = slot.bone;
  if (source.weighted) {
    // Rev2D polygons cannot carry explicit weights: follow the most influential bone.
    const total = new Map<BoneInfo, number>();
    for (const infl of source.influences) for (const f of infl) total.set(f.bone, (total.get(f.bone) ?? 0) + f.w);
    parent = [...total.entries()].sort((a, b) => b[1] - a[1])[0][0];
    ctx.report.warn(
      'spine-clipping-weighted',
      `weighted clipping polygon approximated by a polygon following bone "${parent.name}"`,
      where,
    );
  }
  part.json = { parent: parent.id, shape: { type: 'polygon', points: [] }, fill: '#ffffff', description: `Spine clipping mask (${att.end ? `clips up to slot "${att.end}"` : 'clips to the end of the draw order'})` };
  return part;
}

// ----------------------------------------------------------------------------- canvas

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Largest extent (Spine units) the skeleton's own bounds may have per axis relative to the setup
 * attachments' extent before they are treated as bogus: factor × attachment extent + margin.
 */
const BOUNDS_FACTOR = 4;
const BOUNDS_MARGIN = 256;

/**
 * Canvas bounds in Spine units: the skeleton's own bounds (`skeleton.x/y/width/height`, what the Spine
 * editor computed; an export of a Rev2D model writes its canvas there) when they are plausible, else
 * the bounds of the setup attachments. Some exports carry bounds far larger than anything drawn (e.g.
 * 756 x 273928 for 1000 px of art), which would make a canvas nothing can render.
 */
function setupBounds(ctx: ImportContext): Bounds {
  const drawn = attachmentBounds(ctx);
  const sk = ctx.json.skeleton;
  if (sk && num(sk.width, 0) > 0 && num(sk.height, 0) > 0) {
    const own = { x: num(sk.x, 0), y: num(sk.y, 0), width: num(sk.width, 0), height: num(sk.height, 0) };
    if (!drawn) return own;
    const unionW = Math.max(own.x + own.width, drawn.x + drawn.width) - Math.min(own.x, drawn.x);
    const unionH = Math.max(own.y + own.height, drawn.y + drawn.height) - Math.min(own.y, drawn.y);
    if (unionW <= BOUNDS_FACTOR * drawn.width + BOUNDS_MARGIN && unionH <= BOUNDS_FACTOR * drawn.height + BOUNDS_MARGIN) return own;
    ctx.report.info(
      'spine-bounds-ignored',
      `the skeleton's bounds (${fmt(own.width)} x ${fmt(own.height)} at ${fmt(own.x)}, ${fmt(own.y)}) are far larger than its setup attachments (${fmt(drawn.width)} x ${fmt(drawn.height)} at ${fmt(drawn.x)}, ${fmt(drawn.y)}); the canvas frames the attachments instead`,
      'skeleton',
      'pass a larger padding if animations move the art outside the canvas',
    );
    return drawn;
  }
  if (drawn) return drawn;
  // No visible attachment: frame the bone joints.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of ctx.bones) {
    minX = Math.min(minX, b.spineWorld[4]);
    maxX = Math.max(maxX, b.spineWorld[4]);
    minY = Math.min(minY, b.spineWorld[5]);
    maxY = Math.max(maxY, b.spineWorld[5]);
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** Bounds of the attachments visible in the setup pose (clipping polygons excluded), or null when there are none. */
function attachmentBounds(ctx: ImportContext): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const slot of ctx.slots) {
    for (const p of slot.parts) {
      if (p.kind === 'clipping' || slot.setupAttachment !== p.attachmentName || (p.sequence && p.sequence.index !== p.sequence.setup)) continue;
      for (let i = 0; i + 1 < p.spineVertices.length; i += 2) {
        minX = Math.min(minX, p.spineVertices[i]);
        maxX = Math.max(maxX, p.spineVertices[i]);
        minY = Math.min(minY, p.spineVertices[i + 1]);
        maxY = Math.max(maxY, p.spineVertices[i + 1]);
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function finishParts(ctx: ImportContext): void {
  for (const slot of ctx.slots) {
    for (const p of slot.parts) {
      const shape = p.json.shape as Record<string, unknown>;
      const pts = toCanvas(ctx, p.spineVertices);
      if (shape.type === 'polygon') shape.points = pts;
      else shape.vertices = pts;
    }
  }
}

/**
 * Spine clipping: parts of the slots after the clipping slot up to its end slot are masked by an
 * invisible polygon part. Rev2D masks are static, so a clipping attachment that animations show or
 * hide switches its polygon (stepped `shape.points` keys) between the real outline and an "open"
 * polygon far around the canvas that clips nothing.
 */
function applyClipping(ctx: ImportContext, width: number, height: number): void {
  const shown = (slot: string, name: string, setup: string | null) => {
    let toggled = false;
    for (const a of Object.values(ctx.json.animations ?? {})) {
      for (const k of a.slots?.[slot]?.attachment ?? []) if ((k.name === name) !== (setup === name)) toggled = true;
    }
    return toggled;
  };
  for (const slot of ctx.slots) {
    const clips = slot.parts.filter((p) => p.kind === 'clipping');
    clips.forEach((p, n) => {
      const att = findSkinAttachment(ctx, p.skinName, slot.name, p.attachmentName) as SpineClippingAttachment | undefined;
      const where = `skins.${p.skinName}.${slot.name}.${p.attachmentName}`;
      const atSetup = slot.setupAttachment === p.attachmentName;
      const toggled = shown(slot.name, p.attachmentName, slot.setupAttachment);
      if (!atSetup && !toggled) {
        ctx.report.info('spine-clipping-unused', 'this clipping attachment is never shown; no mask created', where);
        p.json.description = `${String(p.json.description ?? '')} (never shown in Spine: masks nothing)`.trim();
        return;
      }
      if (n > 0 && clips.slice(0, n).some((c) => c.clip)) {
        ctx.report.warn('spine-clipping-multiple', 'several clipping attachments in one slot: only the first is converted', where);
        return;
      }
      const shape = p.json.shape as { points: number[] };
      const real = shape.points;
      // Open polygon: the same number of points on a circle far around the canvas (clips nothing).
      const count = real.length / 2;
      const r = 4 * Math.max(width, height);
      const open: number[] = [];
      for (let i = 0; i < count; i++) {
        const a = (2 * Math.PI * i) / count;
        open.push(width / 2 + r * Math.cos(a), height / 2 + r * Math.sin(a));
      }
      p.clip = { real, open, toggled };
      if (!atSetup) shape.points = open;
      if (toggled) {
        ctx.report.info(
          'spine-clipping-animated',
          `animations ${atSetup ? 'hide' : 'show'} this clipping attachment: its mask polygon switches between the clip outline and an open polygon that clips nothing`,
          where,
        );
      }
      const endSlot = att?.end ? ctx.slotByName.get(att.end) : undefined;
      if (att?.end && !endSlot) ctx.report.warn('spine-clipping-end-missing', `end slot "${att.end}" not found; clipping to the end of the draw order`, where);
      const last = endSlot ? endSlot.index : ctx.slots.length - 1;
      let clipped = 0;
      for (let i = slot.index + 1; i <= last; i++) {
        for (const q of ctx.slots[i].parts) {
          if (q.kind === 'clipping') continue;
          const mask = (q.json.mask as string[] | undefined) ?? [];
          if (!mask.includes(p.id)) q.json.mask = [...mask, p.id];
          clipped++;
        }
      }
      ctx.report.count('clippingMasks');
      if (clipped === 0) ctx.report.info('spine-clipping-empty', 'the clipping attachment clips no slot', where);
    });
  }
}

function findSkinAttachment(ctx: ImportContext, skin: string, slot: string, name: string): SpineAttachment | undefined {
  const raw = ctx.json.skins;
  if (Array.isArray(raw)) return raw.find((s) => s.name === skin)?.attachments?.[slot]?.[name];
  return (raw as Record<string, SpineSkinAttachments> | undefined)?.[skin]?.[slot]?.[name];
}

// ----------------------------------------------------------------------------- constraints

function readIk(ctx: ImportContext): void {
  const list = (ctx.json.ik ?? []).map((k, i) => ({ k, i })).sort((a, b) => num(a.k.order, 0) - num(b.k.order, 0) || a.i - b.i);
  const ids = ctx.ikIds;
  for (const { k, i } of list) {
    const where = `ik[${i}] (${k.name})`;
    const bones = (k.bones ?? []).map((n) => ctx.boneByName.get(n));
    const target = ctx.boneByName.get(k.target);
    if (bones.length < 1 || bones.length > 2 || bones.some((b) => !b) || !target) {
      ctx.report.warn('spine-ik-invalid', 'IK constraint with missing bones/target or more than 2 bones skipped', where);
      continue;
    }
    const chain = bones as BoneInfo[];
    if (chain.length === 2 && chain[1].parent !== chain[0]) {
      ctx.report.warn('spine-ik-invalid', `"${chain[1].name}" is not a direct child of "${chain[0].name}"; constraint skipped`, where);
      continue;
    }
    if (k.compress) {
      ctx.report.warn('spine-ik-compress', '"compress" (shrink the bone when the target is closer) is not supported; ignored', where);
    }
    if (k.uniform) {
      ctx.report.warn('spine-ik-uniform', '"uniform" (stretch scaleY too) is not supported; only scaleX stretches', where);
    }
    // Spine softness is measured in the first bone's parent space, scaled by the bones' local scales.
    const pp = chain[0].parent;
    const ppScale = pp ? Math.sqrt(Math.abs(pp.spineWorld[0] * pp.spineWorld[3] - pp.spineWorld[1] * pp.spineWorld[2])) : 1;
    const psx = Math.abs(chain[0].node.scaleX);
    const csx = chain.length === 2 ? Math.abs(chain[1].node.scaleX) : 1;
    const info: IkInfo = {
      name: k.name,
      data: k,
      bones: chain,
      target,
      mix: Math.min(1, Math.max(0, num(k.mix, 1))),
      softness: Math.max(0, num(k.softness, 0)),
      bendPositive: k.bendPositive ?? true,
      stretch: effectiveStretch({ bones: chain }, k.stretch ?? false, Math.max(0, num(k.softness, 0))),
      softnessFactor: ctx.scale * ppScale * psx * ((csx + 1) / 2),
      order: num(k.order, 0),
      variants: [],
    };
    info.variants.push({ id: ids.allocate(k.name), softness: info.softness, bendPositive: info.bendPositive, stretch: info.stretch, base: true });
    if (info.variants[0].id !== k.name) ctx.report.info('spine-id-renamed', `IK constraint "${k.name}" is "${info.variants[0].id}" in Rev2D`, where);
    if (chain.length === 1 && info.softness > 0) ctx.report.info('spine-ik-softness-one-bone', 'softness has no effect on one-bone IK', where);
    if (k.stretch && !info.stretch) {
      ctx.report.info(
        'spine-ik-soft-stretch',
        "stretch is on together with softness; Spine's two-bone IK never stretches while softness is on (the softened target stays within reach), so it is imported without stretch",
        where,
      );
    }
    if (chain.length === 2) {
      reportIkNonUniformScale(ctx, chain[0], where);
      // With stretch on, Spine's two-bone solve puts the child joint on the parent's axis (its local y
      // is dropped while the constraint applies); Rev2D keeps the offset.
      const offset = Math.abs(chain[1].node.y) * scale0(ctx, chain[0]);
      const stretchKeys = Object.entries(ctx.json.animations ?? {}).filter(([, a]) => (a?.ik?.[k.name] ?? []).some((key) => key.stretch));
      if (offset > 0.1 && (k.stretch || stretchKeys.length)) {
        ctx.report.info(
          'spine-ik-child-offset',
          `"${chain[1].name}" sits ${fmt(offset)} px off the axis of "${chain[0].name}"; while stretch is on${k.stretch ? '' : ` (animations ${stretchKeys.map(([n]) => n).join(', ')})`} Spine's solve moves it onto the axis, Rev2D keeps the offset, so the chain bends slightly differently`,
          where,
          `set "${chain[1].name}" y to 0 in Spine for an exact conversion`,
        );
      }
    }
    ctx.ik.push(info);
    ctx.ikByName.set(k.name, info);
  }
}

/** Canvas px per unit of `b`'s local y axis in the setup pose. */
function scale0(ctx: ImportContext, b: BoneInfo): number {
  return ctx.scale * Math.hypot(b.spineWorld[2], b.spineWorld[3]);
}

/**
 * Two-bone IK solves differently when the first bone or anything above it is scaled non-uniformly (or
 * sheared): Spine intersects the child's scaled length with an ellipse, Rev2D uses the child's world x
 * scale (SPEC §7), so the tip can land a few px apart. Reported for the setup pose and per animation.
 */
function reportIkNonUniformScale(ctx: ImportContext, first: BoneInfo, where: string): void {
  const near = (a: number, b: number) => Math.abs(Math.abs(a) - Math.abs(b)) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));
  const chain: BoneInfo[] = [];
  for (let b: BoneInfo | null = first; b; b = b.parent) chain.push(b);
  const reasons: string[] = [];
  const own = first.node;
  if (!near(own.scaleX, own.scaleY) || own.shearX !== 0 || own.shearY !== 0) reasons.push(`"${first.name}" has scale ${fmt(own.scaleX)} x ${fmt(own.scaleY)}${own.shearX || own.shearY ? ' and shear' : ''}`);
  const p = first.parent?.spineWorld;
  if (p) {
    const lx = Math.hypot(p[0], p[1]);
    const ly = Math.hypot(p[2], p[3]);
    const dot = (p[0] * p[2] + p[1] * p[3]) / Math.max(1e-12, lx * ly);
    if (!near(lx, ly) || Math.abs(dot) > 1e-4) reasons.push(`the world transform of "${first.parent!.name}" is not a similarity (scale ${fmt(lx)} x ${fmt(ly)})`);
  }
  if (reasons.length) {
    ctx.report.warn(
      'spine-ik-nonuniform-scale',
      `${reasons.join('; ')}: Spine solves two-bone IK exactly on the scaled chain, Rev2D's solve is approximate there (SPEC §7), so the chain may bend slightly differently in the setup pose`,
      where,
      'scale the bones uniformly in Spine, or check the IK chains after import',
    );
  }
  const anims: string[] = [];
  for (const [name, anim] of Object.entries(ctx.json.animations ?? {})) {
    const hit = chain.some((b) => {
      const tl = anim?.bones?.[b.name];
      if (!tl) return false;
      const n = b.node;
      const scale = (tl.scale ?? []) as Array<{ x?: number; y?: number }>;
      if (scale.some((k) => !near(n.scaleX * (k.x ?? 1), n.scaleY * (k.y ?? 1)))) return true;
      if (((tl.scalex ?? []) as Array<{ value?: number }>).some((k) => !near(n.scaleX * (k.value ?? 1), n.scaleY))) return true;
      if (((tl.scaley ?? []) as Array<{ value?: number }>).some((k) => !near(n.scaleX, n.scaleY * (k.value ?? 1)))) return true;
      const shear = [...((tl.shear ?? []) as Array<{ x?: number; y?: number }>).flatMap((k) => [k.x ?? 0, k.y ?? 0]), ...((tl.shearx ?? []) as Array<{ value?: number }>).map((k) => k.value ?? 0), ...((tl.sheary ?? []) as Array<{ value?: number }>).map((k) => k.value ?? 0)];
      return shear.some((v) => v !== 0);
    });
    if (hit) anims.push(name);
  }
  if (anims.length) {
    const list = anims.length > 8 ? `${anims.slice(0, 8).join(', ')}, ... (+${anims.length - 8})` : anims.join(', ');
    ctx.report.warn(
      'spine-ik-nonuniform-scale',
      `animation${anims.length > 1 ? 's' : ''} ${list} scale${anims.length > 1 ? '' : 's'} "${first.name}" or a bone above it non-uniformly (or shear it): Rev2D's two-bone IK is approximate there (SPEC §7), so the chain may bend slightly differently while it does`,
      where,
      'keep IK chain bones and their parents uniformly scaled in Spine, or check those animations after import',
    );
  }
}

function ikJson(ctx: ImportContext, k: IkInfo): Array<Record<string, unknown>> {
  return k.variants.map((v) => {
    const out: Record<string, unknown> = { id: v.id, bones: k.bones.map((b) => b.id), target: k.target.id };
    const mix = v.base ? k.mix : 0;
    if (mix !== 1) out.mix = mix;
    // Spine's bend direction flips with the y axis: a counter-clockwise (Spine-positive) bend is a
    // counter-clockwise bend on screen, which is Rev2D's bendPositive = false.
    out.bendPositive = !v.bendPositive;
    if (v.stretch) out.stretch = true;
    if (k.bones.length === 2 && v.softness > 0) out.softness = v.softness * k.softnessFactor;
    void ctx;
    return out;
  });
}

/** Codes of constraints that are not converted (spelled out, so a code from a report can be searched for). */
const SKIPPED_CONSTRAINT = {
  transform: 'spine-transform-constraint',
  path: 'spine-path-constraint',
  physics: 'spine-physics-constraint',
} as const;

function reportOtherConstraints(ctx: ImportContext): void {
  const kinds: Array<['transform' | 'path' | 'physics', string]> = [
    ['transform', 'transform constraint'],
    ['path', 'path constraint'],
    ['physics', 'physics constraint'],
  ];
  for (const [key, label] of kinds) {
    const list = (ctx.json[key] ?? []) as Array<Record<string, unknown> & { name: string }>;
    list.forEach((c, i) => {
      const where = `${key}[${i}] (${c.name})`;
      if (key === 'transform' && ctx.transformEmulated.has(i)) return; // reported by import-rules.ts
      if (key === 'transform' && ctx.transformInactive.has(i)) {
        ctx.report.info('spine-constraint-skin-inactive', `transform constraint "${c.name}" belongs to skins that were not imported, so it is inactive (as in Spine with this skin)`, where);
        return;
      }
      if (key === 'transform' && ctx.transformHandled.has(i)) {
        ctx.report.info(
          'spine-transform-baked',
          `translate-only transform constraint "${c.name}" converted into the translation of ${(c as { bones?: string[] }).bones?.map((b) => `"${b}"`).join(', ')} (setup pose and animations; sampled where its target moves)`,
          where,
          'moving the target bone in Rev2D no longer drags the constrained bones along; edit their translation tracks instead',
        );
        ctx.report.count('bakedConstraints.transform');
        return;
      }
      const reason = key === 'transform' ? ctx.transformSkipReasons?.get(i) : undefined;
      const active = constraintActive(key, c);
      ctx.report.warn(
        SKIPPED_CONSTRAINT[key],
        `${label} "${c.name}" is not supported and was skipped${reason ? ` (${reason})` : ''}${active ? '; the setup pose differs where it moves bones' : '; it is inactive in the setup pose'}`,
        where,
        key === 'physics' ? 'Rev2D physics drives parameters: rebuild the motion with a physics group and bindings' : 'bake its effect into bone keys in Spine before exporting',
      );
      ctx.report.count(`skippedConstraints.${key}`);
    });
  }
}

/** Whether a skipped constraint changes the setup pose (any of its mixes is non-zero). */
function constraintActive(kind: string, c: Record<string, unknown>): boolean {
  const n = (k: string, d: number) => num(c[k], d);
  if (kind === 'transform') {
    const legacy = ['rotateMix', 'translateMix', 'scaleMix', 'shearMix'];
    if (legacy.some((k) => k in c)) return legacy.some((k) => n(k, 1) !== 0);
    const mixX = n('mixX', 1);
    const mixScaleX = n('mixScaleX', 1);
    return [n('mixRotate', 1), mixX, n('mixY', mixX), mixScaleX, n('mixScaleY', mixScaleX), n('mixShearY', 1)].some((m) => m !== 0);
  }
  if (kind === 'path') {
    const legacy = ['rotateMix', 'translateMix'];
    if (legacy.some((k) => k in c)) return legacy.some((k) => n(k, 1) !== 0);
    const mixX = n('mixX', 1);
    return [n('mixRotate', 1), mixX, n('mixY', mixX)].some((m) => m !== 0);
  }
  return n('mix', 1) !== 0;
}

