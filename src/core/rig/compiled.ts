/**
 * Compiled (index-resolved) rig structures shared by the compile and evaluation stages.
 * Everything that can be decided once per model lives here so per-frame evaluation never looks up ids.
 */
import type { BoneSegment } from '../geometry/index.js';
import type {
  BlendMode,
  CompiledGeometry,
  Mat2D,
  Model,
  Part,
  RGBA,
  TextureInfo,
  Value,
  ValueType,
} from '../types.js';

export type EaseFunction = (t: number) => number;

/** Per-bone local values are stored as 6 consecutive floats in BONE_PROPS order. */
export const BONE_STRIDE = 6;
export const BONE_X = 0;
export const BONE_Y = 1;
export const BONE_ROTATION = 2;
export const BONE_SCALE_X = 3;
export const BONE_SCALE_Y = 4;
export const BONE_LENGTH = 5;

export type ParentRef = { kind: 'none' } | { kind: 'bone'; index: number } | { kind: 'warp'; index: number };

export interface CompiledParams {
  ids: string[];
  index: Map<string, number>;
  min: Float64Array;
  max: Float64Array;
  defaults: Float64Array;
}

export interface CompiledBone {
  id: string;
  /** Parent bone index, -1 for roots. */
  parent: number;
  setupWorld: Mat2D;
  invSetupWorld: Mat2D;
  /** Setup-world joint -> tip segment (used for auto skin weights). */
  segment: BoneSegment;
}

export interface CompiledWarp {
  id: string;
  parent: ParentRef;
  rect: [number, number, number, number];
  cols: number;
  rows: number;
  /** Rest lattice points in setup space. */
  rest: Float64Array;
}

/** Part fields that require recompiling geometry when they change. */
export type GeometryField = 'fill' | 'stroke.color' | 'stroke.width' | `shape.${string}`;

export type SlotTarget =
  | { kind: 'bone'; index: number; field: number }
  | { kind: 'warp'; index: number }
  | { kind: 'ik'; index: number }
  | { kind: 'part'; index: number; prop: 'opacity' | 'z' | 'visible' | 'tint' }
  | { kind: 'geometry'; index: number; field: GeometryField };

/** Post-processing applied to a combined property value (`path` = snap arc flags to 0/1). */
export type PostOp = 'none' | 'color' | 'unit' | 'bool' | 'nonneg' | 'path';

/** A bound and/or animated (non-parameter) property. */
export interface Slot {
  key: string;
  valueType: ValueType;
  setup: Value;
  pointCount?: number;
  post: PostOp;
  target: SlotTarget;
}

export interface CompiledBinding {
  slot: number;
  params: number[];
  /** Distinct sorted grid values per parameter. */
  axes: Float64Array[];
  /** Keyform index stride per parameter. */
  strides: number[];
  /** Keyforms in grid order (index = Σ axisIndex_d · stride_d). */
  keyforms: Value[];
  step: boolean;
}

export interface CompiledTrack {
  /** Parameter index for `param:` tracks, else -1. */
  param: number;
  /** Slot index for property tracks, else -1. */
  slot: number;
  /** Key times, ascending (stable for equal times). */
  times: Float64Array;
  values: Value[];
  /** Easing of the segment starting at each key; null = step (hold). Unused where `smooth` is set. */
  eases: Array<EaseFunction | null>;
  /** Per key: the segment starting at this key is a "smooth" (cubic Hermite / Catmull-Rom) segment. Null = none. */
  smooth: Uint8Array | null;
  /**
   * Per key tangent (value units per second) used by smooth segments; numbers for number values,
   * element arrays for points / colors / path numbers. Null when no segment is smooth.
   */
  tangents: Array<number | number[]> | null;
  /** Time shift in seconds: the track is sampled at (local time - offset), wrapped for looping animations. */
  offset: number;
}

export interface CompiledEvent {
  t: number;
  name: string;
  data?: unknown;
}

export interface CompiledAnimation {
  id: string;
  duration: number;
  loop: boolean;
  tracks: CompiledTrack[];
  /** Sorted by t (stable). */
  events: CompiledEvent[];
}

export interface CompiledIk {
  id: string;
  /** [bone] or [parent, child]. */
  bones: number[];
  target: number;
  bendPositive: boolean;
  mix: number;
  /** Scale the chain along the bones so the tip reaches an out-of-reach target. */
  stretch: boolean;
  /** Two-bone soft approach distance to full extension in px (0 = off; ignored for one-bone IK). */
  softness: number;
  /** Bones whose world matrices must be recomputed after solving (chain root + descendants, parents first). */
  update: number[];
}

export interface CompiledPhysics {
  id: string;
  inputs: Array<{ param: number; type: 'x' | 'y' | 'angle'; weight: number }>;
  /** `segment` is resolved to 0..segments-1. */
  outputs: Array<{ param: number; type: 'angle' | 'x' | 'y'; segment: number; scale: number }>;
  lengths: number[];
  masses: number[];
  gravity: number;
  damping: number;
  stiffness: number;
}

export interface CompiledSkin {
  bones: number[];
  weights: 'auto' | number[][];
  falloff: number;
}

/** Compiled geometry plus per-vertex skin weights (row per vertex, one column per skin bone). */
export interface GeometryEntry {
  geometry: CompiledGeometry;
  fillWeights: Float32Array | null;
  strokeWeights: Float32Array | null;
}

export interface CompiledPart {
  id: string;
  source: Part;
  parent: ParentRef;
  skin: CompiledSkin | null;
  masks: number[];
  maskInvert: boolean;
  blend: BlendMode;
  /** Static `visible` flag. */
  visible: boolean;
  opacity: number;
  z: number;
  tint: RGBA;
  /** Slots that change geometry (shape fields, fill, stroke color/width). Empty = static geometry. */
  geometrySlots: number[];
  /** Geometry compiled once at construction (static parts only). */
  geometry: GeometryEntry | null;
  /** Recently used geometries of a dynamic part with the effective values they were built from (most recent first). */
  cache: Array<{ values: Value[]; geometry: GeometryEntry }>;
}

export interface CompiledRig {
  model: Model;
  textures: Record<string, TextureInfo>;
  params: CompiledParams;
  bones: CompiledBone[];
  /** Bone indices, parents first. */
  boneOrder: number[];
  /** Setup local values, BONE_STRIDE floats per bone. */
  boneSetup: Float64Array;
  warps: CompiledWarp[];
  /** Warp indices, parent warps first. */
  warpOrder: number[];
  parts: CompiledPart[];
  partIndex: Map<string, number>;
  slots: Slot[];
  bindings: CompiledBinding[];
  animations: Map<string, CompiledAnimation>;
  ik: CompiledIk[];
  physics: CompiledPhysics[];
}
