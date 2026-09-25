/**
 * Shared types. Model types are inferred from schema.ts (output = defaults filled in).
 * Runtime types (Pose, RenderList, CompiledGeometry, ...) are the contracts between modules:
 *   parse/validate -> Rig (compile) -> evaluate -> Pose -> buildRenderList -> RenderList -> renderer
 */
import type { z } from 'zod';
import type {
  AnimationSchema,
  BindingSchema,
  BoneSchema,
  EaseSchema,
  FillSchema,
  IkSchema,
  ModelSchema,
  ParameterSchema,
  PartSchema,
  PhysicsSchema,
  ShapeSchema,
  StrokeSchema,
  TextureSchema,
  TrackSchema,
  ValueSchema,
  WarpSchema,
  BlendModeSchema,
  KeySchema,
} from './schema.js';

// ----------------------------------------------------------------------------- model (normalized)

export type Model = z.output<typeof ModelSchema>;
/** What authors write (defaults optional). */
export type ModelInput = z.input<typeof ModelSchema>;
export type Parameter = z.output<typeof ParameterSchema>;
export type Texture = z.output<typeof TextureSchema>;
export type Bone = z.output<typeof BoneSchema>;
export type Warp = z.output<typeof WarpSchema>;
export type Part = z.output<typeof PartSchema>;
export type Shape = z.output<typeof ShapeSchema>;
export type ShapeType = Shape['type'];
export type Fill = z.output<typeof FillSchema>;
export type Stroke = z.output<typeof StrokeSchema>;
export type BlendMode = z.output<typeof BlendModeSchema>;
export type Binding = z.output<typeof BindingSchema>;
export type Animation = z.output<typeof AnimationSchema>;
export type Track = z.output<typeof TrackSchema>;
export type Key = z.output<typeof KeySchema>;
export type Ease = z.output<typeof EaseSchema>;
export type IkConstraint = z.output<typeof IkSchema>;
export type PhysicsGroup = z.output<typeof PhysicsSchema>;
/** Raw JSON value as written in bindings / tracks. */
export type RawValue = z.output<typeof ValueSchema>;

// ----------------------------------------------------------------------------- math

/** 2D affine matrix [a, b, c, d, tx, ty]: x' = a*x + c*y + tx, y' = b*x + d*y + ty. */
export type Mat2D = [number, number, number, number, number, number];
/** Straight (non-premultiplied) RGBA, each 0..1. */
export type RGBA = [number, number, number, number];

// ----------------------------------------------------------------------------- values

export type ValueType = 'number' | 'points' | 'color' | 'path' | 'boolean';

/** A parsed SVG path whose numbers can be interpolated. `template` encodes the command structure. */
export interface PathValue {
  /** Normalized command structure, e.g. "M2 C6 C6 Z0" (command letter + number count). Equal templates are interpolable. */
  template: string;
  /** Command letters in order (case preserved, i.e. relative commands stay relative). */
  commands: string[];
  /** All numeric arguments in order. */
  nums: number[];
}

/**
 * Runtime (normalized) value.
 * number -> number, points -> number[] (flat), color -> RGBA, path -> PathValue, boolean -> number (0/1).
 */
export type Value = number | number[] | RGBA | PathValue;

// ----------------------------------------------------------------------------- addresses & targets

export type TargetKind = 'param' | 'bone' | 'warp' | 'part' | 'ik';

/** Parsed property address, e.g. "part:mouth.shape.ry" -> {kind:'part', id:'mouth', prop:['shape','ry']}. */
export interface Address {
  kind: TargetKind;
  id: string;
  /** Property path segments; empty for `param:<id>`. */
  prop: string[];
}

export interface ResolvedTarget {
  address: Address;
  /** Canonical string form, e.g. "bone:head.rotation". */
  key: string;
  valueType: ValueType;
  /** Setup (rest) value, normalized. For warp offsets: zeros. */
  setup: Value;
  /** For 'points' values: number of points (array length = 2 * pointCount). */
  pointCount?: number;
}

// ----------------------------------------------------------------------------- diagnostics

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable code, e.g. "unknown-bone", "binding-grid-incomplete". */
  code: string;
  message: string;
  /** JSON pointer into the model file, e.g. "/parts/3/parent". */
  path: string;
  /** Actionable fix suggestion (did-you-mean, expected shape, etc.). */
  hint?: string;
}

// ----------------------------------------------------------------------------- textures

export interface TextureInfo {
  width: number;
  height: number;
}

/** Decoded RGBA8 image (straight alpha, row-major, top-down). */
export interface ImageRGBA {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

// ----------------------------------------------------------------------------- geometry

/**
 * Triangle mesh produced from a shape (+ stroke) in SETUP space, before deformation.
 * Fill and stroke are separate batches so the stroke never samples the texture.
 */
export interface CompiledGeometry {
  fill: MeshBatch | null;
  stroke: MeshBatch | null;
}

export interface MeshBatch {
  /** Setup-space positions [x0,y0,...]. Triangle winding is unspecified (raw meshes keep authored winding): never cull. */
  positions: Float32Array;
  /** Per-vertex straight RGBA (paint evaluated at setup positions), 4 floats per vertex. */
  colors: Float32Array;
  /** Texture coords 0..1 per vertex (only for textured batches). */
  uvs?: Float32Array;
  texture?: string;
  indices: Uint32Array;
}

// ----------------------------------------------------------------------------- evaluation

export interface AnimationLayer {
  /** Animation id. */
  id: string;
  /** Local time in seconds (wrapped when the animation loops, clamped otherwise). Default: PoseOptions.time. */
  time?: number;
  /** Blend weight 0..1. Default 1. */
  weight?: number;
  /**
   * How `param:` tracks combine with the layers below:
   * - 'override' (default): p = p + weight * (v - p)  (the later layer wins)
   * - 'add': p = p + weight * (v - default)          (gestures on top of idle, e.g. talk over look_around)
   * Parameters are clamped to their range after all layers. Non-param tracks are always additive
   * deltas from setup (SPEC §5), whatever the mode.
   */
  mode?: 'override' | 'add';
  /** Global time at which this layer starts: local time = PoseOptions.time - start. Ignored when `time` is set. Default 0. */
  start?: number;
  /**
   * true (default): outside [0, duration] a non-looping layer holds its first/last values and a looping
   * layer keeps looping (also before `start`). false: the layer contributes nothing (no values, no events)
   * before its local time 0 and, if non-looping, after `duration` (one-shot overlays such as a wink that
   * must stop affecting the pose when done).
   */
  hold?: boolean;
}

export interface PoseOptions {
  /** Global time in seconds (used by layers without their own time and by physics). Default 0. */
  time?: number;
  /** Animations applied in order (later layers blend over earlier ones). Strings = full weight. */
  animations?: Array<string | AnimationLayer>;
  /** Explicit parameter values; they override animation AND physics values (explicit always wins). */
  params?: Record<string, number>;
  /** Simulate physics (default true when the model has physics): from rest over at most the 60 s before `time`. */
  physics?: boolean;
}

export interface BonePose {
  /** World matrix. */
  world: Mat2D;
  /** World position of the joint. */
  x: number;
  y: number;
  /** World rotation (degrees, clockwise). */
  rotation: number;
  /** World scale (length of the transformed basis vectors). */
  scaleX: number;
  scaleY: number;
  /** World position of the bone tip (joint + length along local +x). */
  tip: [number, number];
  /** Final local values after bindings/animation/IK. */
  local: { x: number; y: number; rotation: number; scaleX: number; scaleY: number; length: number };
}

export interface WarpPose {
  /** Deformed control points in world space, row-major, [x0,y0,...], length 2*(cols+1)*(rows+1). */
  points: Float32Array;
  cols: number;
  rows: number;
}

export interface PartPose {
  visible: boolean;
  /** Final combined opacity (setup value + bindings + animation), clamped 0..1. Static visibility is only in `visible`. */
  opacity: number;
  z: number;
  tint: RGBA;
  /** Axis-aligned world bounds [x, y, w, h] of the deformed geometry (fill + stroke). Null if empty. */
  bounds: [number, number, number, number] | null;
  /** Deformed world positions for each batch. */
  fill: Float32Array | null;
  stroke: Float32Array | null;
}

export interface Pose {
  time: number;
  params: Record<string, number>;
  bones: Record<string, BonePose>;
  warps: Record<string, WarpPose>;
  parts: Record<string, PartPose>;
  /** Visible part ids in final draw order (back to front). */
  drawOrder: string[];
  /** Final value of every animated/bound property, keyed by canonical address. For inspection/debugging. */
  properties: Record<string, number | number[] | string>;
  /** Animation events whose time is in (prevTime, time] (sequential playback) or == time (stateless). */
  events: Array<{ animation: string; name: string; t: number; data?: unknown }>;
  /** IK diagnostics per constraint id (reach, error, snap risk). */
  ik: Record<string, IkPose>;
  /** Physics diagnostics per group id (raw vs clamped outputs). Empty when physics is off. */
  physics: Record<string, PhysicsPose>;
}

export interface IkPose {
  /**
   * The full solve (as if mix = 1) puts the chain tip within 0.01 px of the target. One-bone (aim) IK only
   * reaches a target exactly one bone length away, unless `stretch` is on.
   */
  reached: boolean;
  /** Final distance from the chain tip to the target in px (after solving, mix and stretch). */
  error: number;
  /** Distance from the chain root joint to the target in px. */
  distance: number;
  /** Maximum reach in px: sum of world segment lengths (one-bone IK: the bone's world length). */
  maxReach: number;
  /** distance / maxReach: >= 1 means out of reach, values near 1 risk visible "knee snapping". 0 when maxReach is 0. */
  extension: number;
  /** Two-bone IK: final interior angle at the middle joint in degrees (180 = fully straight); omitted when a segment has zero length. */
  bend?: number;
  /** Only for constraints with `stretch: true`: scale factor applied along the bones, after mix (1 = none). */
  stretch?: number;
}

export interface PhysicsPose {
  outputs: Array<{
    param: string;
    /** Output before clamping to the parameter range (simulated value * scale). */
    raw: number;
    /** Value written to the parameter (clamped), or the explicit value when overridden. */
    value: number;
    /** raw was outside [min, max]. */
    clamped: boolean;
    /** An explicit PoseOptions.params value replaced the physics output. */
    overridden: boolean;
  }>;
}

// ----------------------------------------------------------------------------- rendering

export interface DrawItem {
  partId: string;
  kind: 'fill' | 'stroke';
  /** World positions [x0,y0,...]. */
  positions: Float32Array;
  /**
   * Per-vertex straight RGBA 0..1 with part opacity and tint already applied.
   * For mask items (inside `masks`) this is the mask part's paint only (its opacity/tint/visibility ignored).
   */
  colors: Float32Array;
  uvs?: Float32Array;
  texture?: string;
  indices: Uint32Array;
  blend: BlendMode;
  /** Soft clip: the source is multiplied by the union alpha coverage of these items (1 - coverage when maskInvert). */
  masks?: DrawItem[];
  maskInvert?: boolean;
}

export interface RenderList {
  width: number;
  height: number;
  background: RGBA;
  draws: DrawItem[];
}
