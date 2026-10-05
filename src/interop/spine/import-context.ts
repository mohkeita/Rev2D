/** Internal state shared by the Spine importer's setup (import.ts) and animation (import-animations.ts) passes. */
import { apply, fromTRS, multiply } from '../../core/math.js';
import type { Mat2D, RGBA } from '../../core/types.js';
import type { SpineImportInput } from '../types.js';
import type { TransformBake } from './import-transform.js';
import type { SpineBoneNode } from './transform.js';
import type { SpineEventData, SpineIkData, SpineSkeletonJson } from './types.js';
import { clean, type IdAllocator, type ReportBuilder } from './util.js';

export interface SpineVersion {
  raw: string;
  major: number;
  minor: number;
}

export interface BoneInfo {
  index: number;
  name: string;
  id: string;
  parent: BoneInfo | null;
  /** Spine local values with defaults applied (unscaled Spine units). */
  node: SpineBoneNode;
  length: number;
  /** Overlay color ("#rrggbbaa") when the Spine bone has a non-default one. */
  color?: string;
  /** Setup world matrix in Spine skeleton space (no constraints). */
  spineWorld: Mat2D;
  /** Rev2D local values (canvas units). */
  rev: { x: number; y: number; rotation: number; scaleX: number; scaleY: number; length: number };
  /** Rev2D setup world matrix. */
  revWorld: Mat2D;
  /**
   * Set for bones emulating a Spine inheritance mode in model space (import-rules.ts): their rest
   * world as Rev2D values. The bone keeps its Spine parent while animations are converted and sampled,
   * then becomes a root bone with these setup values.
   */
  detachRest?: { x: number; y: number; rotation: number; scaleX: number; scaleY: number };
  /**
   * The Rev2D setup translation before a rule of import-rules.ts moved it (a transform constraint
   * active in the setup pose): converted translate keys are relative to `rev`, so the Spine local
   * translation at a time is the posed one minus (`rev` - this).
   */
  ruleSetupBase?: { x: number; y: number };
  /**
   * Spine bones with shear become two Rev2D bones that reproduce the sheared local transform exactly
   * (2x2 SVD, import.ts planShearPairs): an outer bone `outerId` (the Spine parent, translation,
   * rotation `rev.rotation + phi`, scale `sx`, `sy`) and this bone as its child at the origin with
   * rotation `theta` (children, attachments, IK targets and weights keep using this bone's id).
   * Values of the setup pose; animations that change scale or shear sample all four.
   */
  shearPair?: { outerId: string; phi: number; theta: number; sx: number; sy: number };
}

export interface Influence {
  bone: BoneInfo;
  x: number;
  y: number;
  w: number;
}

/** Where a mesh's (or clipping polygon's) vertices come from, for setup positions and deform keys. */
export type VertexSource =
  | { weighted: false; bone: BoneInfo; local: number[] }
  | { weighted: true; influences: Influence[][] };

export type PartKind = 'region' | 'mesh' | 'linkedmesh' | 'clipping';

export interface PartInfo {
  id: string;
  slot: SlotInfo;
  attachmentName: string;
  /** Skin the attachment came from. */
  skinName: string;
  kind: PartKind;
  /** Attachment color (multiplies the slot color). */
  color: RGBA;
  /** Vertex source: mesh / clipping vertices (deform timelines need it) or region corners, in Spine bone space. */
  source?: VertexSource;
  /** (skin, attachment name) whose deform timelines drive this part; undefined = none. */
  deformKey?: { skin: string; attachment: string };
  /** Setup geometry in Spine skeleton space (before the canvas mapping). */
  spineVertices: number[];
  /** Rev2D part JSON (vertices filled in once the canvas is known). */
  json: Record<string, unknown>;
  /**
   * Image sequence frame: the attachment's sequence has `count` frames, this part draws frame `index`
   * (0-based); `setup` is the frame shown in the setup pose; `timeline` names the attachment whose
   * sequence timelines drive it (a linked mesh may use its parent's).
   */
  sequence?: { index: number; count: number; setup: number; label: string; timeline: { skin: string; attachment: string } };
  /** Clipping masks: the clip outline and the open polygon used while the clip is hidden (canvas). */
  clip?: { real: number[]; open: number[]; toggled: boolean };
}

export interface SlotInfo {
  index: number;
  name: string;
  bone: BoneInfo;
  /** Setup slot color. */
  color: RGBA;
  setupAttachment: string | null;
  parts: PartInfo[];
  /**
   * True when some animation changes both the slot's alpha and its attachment: the slot's alpha then
   * lives in the parts' tint alpha (exact), while opacity only shows which attachment is visible.
   */
  alphaInTint: boolean;
}

export interface IkVariant {
  id: string;
  softness: number;
  bendPositive: boolean;
  stretch: boolean;
  /** The variant matching the setup values (keeps the constraint's id and setup mix). */
  base: boolean;
}

export interface IkInfo {
  name: string;
  data: SpineIkData;
  bones: BoneInfo[];
  target: BoneInfo;
  mix: number;
  /** Setup softness in Spine units (before the world scale factor). */
  softness: number;
  bendPositive: boolean;
  stretch: boolean;
  /** Spine softness units -> Rev2D px. */
  softnessFactor: number;
  order: number;
  /** Rev2D constraints emitted for this Spine constraint (always at least the base one). */
  variants: IkVariant[];
}

export interface ImportContext {
  input: SpineImportInput;
  json: SpineSkeletonJson;
  version: SpineVersion;
  /** Spine 3.x file (normalized curves, `angle` rotate keys, shortest-path rotation). */
  legacy: boolean;
  scale: number;
  report: ReportBuilder;
  bones: BoneInfo[];
  boneByName: Map<string, BoneInfo>;
  slots: SlotInfo[];
  slotByName: Map<string, SlotInfo>;
  /** Skins used, in lookup order (selected skin first, then "default"). */
  skinChain: string[];
  ik: IkInfo[];
  ikByName: Map<string, IkInfo>;
  /** Spine skeleton space -> canvas. */
  canvas: Mat2D;
  events: Record<string, SpineEventData>;
  animationIds: IdAllocator;
  /** Ids of the Rev2D IK constraints (base constraints and their variants). */
  ikIds: IdAllocator;
  /** Slots whose alpha is kept in the parts' tint alpha (see SlotInfo.alphaInTint). */
  alphaTintSlots: Set<string>;
  /** Transform constraints baked into bone translation (import-transform.ts). */
  transformBakes: TransformBake[];
  /** Indices (skeleton `transform` array) of the constraints fully handled by bakes. */
  transformHandled: Set<number>;
  /** Why the other transform constraints were skipped, by index. */
  transformSkipReasons?: Map<number, string>;
  /** Indices of the transform constraints emulated by import-rules.ts. */
  transformEmulated: Set<number>;
  /** Indices of skin-only transform constraints that no imported skin lists (inactive). */
  transformInactive: Set<number>;
  /** Names of bones this pass moves to model space (see BoneInfo.detachRest). */
  detach: Set<string>;
  /** Names of bones a further pass should move to model space (found while emulating inheritance). */
  needDetach: Set<string>;
}

/** Rev2D local matrix of a bone (both bones of a shear pair: outer · inner). */
export function revLocalMatrix(b: BoneInfo): Mat2D {
  const r = b.rev;
  const p = b.shearPair;
  if (!p) return fromTRS(r.x, r.y, r.rotation, r.scaleX, r.scaleY);
  return multiply(fromTRS(r.x, r.y, r.rotation + p.phi, p.sx, p.sy), fromTRS(0, 0, p.theta, 1, 1));
}

/** Spine skeleton-space point list -> canvas point list. */
export function toCanvas(ctx: ImportContext, pts: readonly number[]): number[] {
  const out: number[] = new Array(pts.length);
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const [x, y] = apply(ctx.canvas, pts[i], pts[i + 1]);
    out[i] = clean(x);
    out[i + 1] = clean(y);
  }
  return out;
}

/**
 * Setup-pose Spine-space positions of a vertex source, with optional deform offsets (unweighted: 2
 * per vertex, weighted: 2 per influence, in the bones' local Spine units).
 */
export function sourceVertices(src: VertexSource, deltas?: ArrayLike<number>): number[] {
  if (!src.weighted) {
    const m = src.bone.spineWorld;
    const out: number[] = new Array(src.local.length);
    for (let i = 0; i + 1 < src.local.length; i += 2) {
      const x = src.local[i] + (deltas?.[i] ?? 0);
      const y = src.local[i + 1] + (deltas?.[i + 1] ?? 0);
      out[i] = m[0] * x + m[2] * y + m[4];
      out[i + 1] = m[1] * x + m[3] * y + m[5];
    }
    return out;
  }
  const out: number[] = [];
  let k = 0;
  for (const infl of src.influences) {
    let wx = 0;
    let wy = 0;
    for (const f of infl) {
      const m = f.bone.spineWorld;
      const x = f.x + (deltas?.[k] ?? 0);
      const y = f.y + (deltas?.[k + 1] ?? 0);
      k += 2;
      wx += (m[0] * x + m[2] * y + m[4]) * f.w;
      wy += (m[1] * x + m[3] * y + m[5]) * f.w;
    }
    out.push(wx, wy);
  }
  return out;
}

/** Number of deform values a vertex source takes (2 per vertex or 2 per influence). */
export function deformLength(src: VertexSource): number {
  return src.weighted ? src.influences.reduce((n, infl) => n + 2 * infl.length, 0) : src.local.length;
}
