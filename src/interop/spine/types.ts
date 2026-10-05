/**
 * TypeScript shapes of the Spine skeleton JSON export format (3.8 - 4.2), written from the public
 * format documentation (esotericsoftware.com/spine-json-format). Every field is optional where the
 * format has a default; the defaults are noted in the comments and applied by the importer.
 *
 * Coordinates are Spine's: +y UP, rotations in degrees COUNTER-clockwise, bone values local to the
 * parent bone. Colors are hex strings "RRGGBBAA" (slots, attachments) or "RRGGBB" (dark colors).
 *
 * Version differences that matter to readers and writers:
 * - skins: 3.8+ writes an array of `{ name, attachments }`; 3.7 and older an object `{ skinName: { slot: { attachment } } }`.
 * - rotate keys: 4.x `value`, 3.x `angle`. Translate/scale/shear keys use `x`/`y` in both.
 * - curves: 4.x `"curve": [cx1, cy1, cx2, cy2, ...]` in ABSOLUTE time/value per value channel;
 *   3.8 `"curve": cx1, "c2": cy1, "c3": cx2, "c4": cy2` NORMALIZED (0..1) and shared by all channels;
 *   3.7 and older `"curve": [cx1, cy1, cx2, cy2]` normalized. `"stepped"` holds the key's value.
 * - slot color timelines: 4.x `rgba`/`rgb`/`alpha`/`rgba2`/`rgb2`; 3.x `color`/`twoColor`.
 * - deform timelines: 4.1+ `animations.attachments.<skin>.<slot>.<attachment>.deform`;
 *   4.0 and 3.x `animations.deform.<skin>.<slot>.<attachment>` (very old files: `ffd`).
 * - bone transform inheritance: 4.2 `inherit`, older `transform`.
 */

export type SpineInherit = 'normal' | 'onlyTranslation' | 'noRotationOrReflection' | 'noScale' | 'noScaleOrReflection';

export type SpineBlend = 'normal' | 'additive' | 'multiply' | 'screen';

export interface SpineSkeletonInfo {
  hash?: string;
  /** Editor version that exported the file, e.g. "4.2.22" or "3.8.99". */
  spine?: string;
  /** Setup-pose bounds: bottom-left corner (y up) and size, in skeleton units. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** 4.2: physics reference scale (default 100). */
  referenceScale?: number;
  /** Nonessential: dopesheet frame rate (default 30). */
  fps?: number;
  images?: string;
  audio?: string;
}

export interface SpineBoneData {
  name: string;
  parent?: string;
  /** Default 0. */
  length?: number;
  x?: number;
  y?: number;
  /** Degrees, counter-clockwise. */
  rotation?: number;
  /** Default 1. */
  scaleX?: number;
  /** Default 1. */
  scaleY?: number;
  shearX?: number;
  shearY?: number;
  /** 4.2 name of the inheritance mode (default "normal"). */
  inherit?: SpineInherit;
  /** 3.x - 4.1 name of the inheritance mode. */
  transform?: SpineInherit;
  /** Only active when the current skin contains the bone. */
  skin?: boolean;
  /** Nonessential: "RRGGBBAA" (default "989898FF"). */
  color?: string;
  icon?: string;
  visible?: boolean;
}

export interface SpineSlotData {
  name: string;
  bone: string;
  /** "RRGGBBAA", default "FFFFFFFF". */
  color?: string;
  /** Two-color tint dark color "RRGGBB". */
  dark?: string;
  /** Setup-pose attachment name (none when omitted or null). */
  attachment?: string | null;
  /** Default "normal". */
  blend?: SpineBlend;
  visible?: boolean;
}

export interface SpineConstraintBase {
  name: string;
  /** Solve order among all constraints (ik, transform, path, physics); default 0. */
  order?: number;
  skin?: boolean;
}

export interface SpineIkData extends SpineConstraintBase {
  bones: string[];
  target: string;
  /** Default 1. */
  mix?: number;
  /** Two-bone IK only, default 0 (skeleton units, scaled by the parent's scale). */
  softness?: number;
  /** Default true. */
  bendPositive?: boolean;
  compress?: boolean;
  stretch?: boolean;
  uniform?: boolean;
}

export interface SpineTransformData extends SpineConstraintBase {
  bones: string[];
  target: string;
  rotation?: number;
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  shearY?: number;
  mixRotate?: number;
  mixX?: number;
  mixY?: number;
  mixScaleX?: number;
  mixScaleY?: number;
  mixShearY?: number;
  local?: boolean;
  relative?: boolean;
  /** 3.x mixes. */
  rotateMix?: number;
  translateMix?: number;
  scaleMix?: number;
  shearMix?: number;
  [key: string]: unknown;
}

export interface SpinePathConstraintData extends SpineConstraintBase {
  bones: string[];
  target: string;
  [key: string]: unknown;
}

export interface SpinePhysicsData extends SpineConstraintBase {
  bone: string;
  [key: string]: unknown;
}

export interface SpineSequence {
  count: number;
  /** First frame number (default 1). */
  start?: number;
  /** Zero-padding of the frame number (default 0). */
  digits?: number;
  /** Frame index shown in the setup pose (default 0). */
  setup?: number;
}

export interface SpineRegionAttachment {
  type?: 'region';
  name?: string;
  /** Atlas region name (default: the attachment name). */
  path?: string;
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  width: number;
  height: number;
  color?: string;
  sequence?: SpineSequence;
}

export interface SpineMeshAttachment {
  /** "skinnedmesh" / "weightedmesh" are 3.0-era names of weighted meshes. */
  type: 'mesh' | 'skinnedmesh' | 'weightedmesh';
  name?: string;
  path?: string;
  /** Texture coordinates normalized to the ORIGINAL (unpacked) image, v down. */
  uvs: number[];
  triangles: number[];
  /**
   * Unweighted: [x, y, ...] local to the slot's bone (length = uvs.length).
   * Weighted: per vertex [boneCount, (boneIndex, x, y, weight) * boneCount] (x, y local to that bone).
   */
  vertices: number[];
  hull?: number;
  edges?: number[];
  color?: string;
  width?: number;
  height?: number;
  sequence?: SpineSequence;
}

export interface SpineLinkedMeshAttachment {
  type: 'linkedmesh' | 'weightedlinkedmesh';
  name?: string;
  path?: string;
  /** Skin holding the parent mesh (default: the default skin). */
  skin?: string;
  /** Name of the parent mesh attachment (same slot). */
  parent: string;
  /** 4.x: use the parent's deform/sequence timelines (default true). */
  timelines?: boolean;
  /** 3.x name of `timelines`. */
  deform?: boolean;
  color?: string;
  width?: number;
  height?: number;
  sequence?: SpineSequence;
}

export interface SpineBoundingBoxAttachment {
  type: 'boundingbox';
  vertexCount: number;
  vertices: number[];
  color?: string;
}

export interface SpinePathAttachment {
  type: 'path';
  closed?: boolean;
  constantSpeed?: boolean;
  lengths?: number[];
  vertexCount: number;
  vertices: number[];
  color?: string;
}

export interface SpinePointAttachment {
  type: 'point';
  x?: number;
  y?: number;
  rotation?: number;
  color?: string;
}

export interface SpineClippingAttachment {
  type: 'clipping';
  /** Last slot (inclusive) that is clipped; clipping starts after the clipping slot. */
  end?: string;
  vertexCount: number;
  vertices: number[];
  color?: string;
}

export type SpineAttachment =
  | SpineRegionAttachment
  | SpineMeshAttachment
  | SpineLinkedMeshAttachment
  | SpineBoundingBoxAttachment
  | SpinePathAttachment
  | SpinePointAttachment
  | SpineClippingAttachment;

/** slot name -> attachment name -> attachment. */
export type SpineSkinAttachments = Record<string, Record<string, SpineAttachment>>;

export interface SpineSkinData {
  name: string;
  attachments?: SpineSkinAttachments;
  bones?: string[];
  ik?: string[];
  transform?: string[];
  path?: string[];
  physics?: string[];
  color?: string;
}

export interface SpineEventData {
  int?: number;
  float?: number;
  string?: string;
  audio?: string;
  volume?: number;
  balance?: number;
}

// ----------------------------------------------------------------------------- animations

/**
 * Curve of a key (shapes the segment to the next key). 4.x: "stepped" or absolute bezier control
 * points [cx1, cy1, cx2, cy2] per value channel. 3.8: "stepped" or the normalized cx1 number (with
 * c2..c4 on the key). 3.7 and older: "stepped" | "linear" | normalized [cx1, cy1, cx2, cy2].
 */
export type SpineCurve = 'stepped' | 'linear' | number | number[];

export interface SpineKeyBase {
  /** Seconds, default 0. */
  time?: number;
  curve?: SpineCurve;
  /** 3.8 normalized bezier: cy1, cx2, cy2 (curve = cx1). Defaults 0, 1, 1. */
  c2?: number;
  c3?: number;
  c4?: number;
}

export interface SpineValueKey extends SpineKeyBase {
  value?: number;
  /** 3.x rotate value. */
  angle?: number;
}

export interface SpineXYKey extends SpineKeyBase {
  x?: number;
  y?: number;
}

export interface SpineColorKey extends SpineKeyBase {
  /** rgba / rgb (4.x), color (3.x). */
  color?: string;
  /** rgba2 / rgb2 (4.x), twoColor (3.x). */
  light?: string;
  dark?: string;
}

export interface SpineAttachmentKey {
  time?: number;
  /** Attachment to show (none when null / omitted). */
  name?: string | null;
}

export interface SpineDeformKey extends SpineKeyBase {
  /** Index of the first vertex value in `vertices` (default 0). */
  offset?: number;
  /** Offsets from the setup vertices (unweighted) or from each bone-local position (weighted). */
  vertices?: number[];
}

export interface SpineSequenceKey {
  time?: number;
  mode?: string;
  index?: number;
  delay?: number;
}

export interface SpineDrawOrderKey {
  time?: number;
  offsets?: Array<{ slot: string; offset: number }>;
}

export interface SpineEventKey {
  time?: number;
  name: string;
  int?: number;
  float?: number;
  string?: string;
  volume?: number;
  balance?: number;
}

export interface SpineIkKey extends SpineKeyBase {
  /** Default 1. */
  mix?: number;
  /** Default 0. */
  softness?: number;
  /** Default true. */
  bendPositive?: boolean;
  compress?: boolean;
  stretch?: boolean;
}

export interface SpineInheritKey {
  time?: number;
  inherit?: SpineInherit;
}

export interface SpineBoneTimelines {
  rotate?: SpineValueKey[];
  translate?: SpineXYKey[];
  translatex?: SpineValueKey[];
  translatey?: SpineValueKey[];
  scale?: SpineXYKey[];
  scalex?: SpineValueKey[];
  scaley?: SpineValueKey[];
  shear?: SpineXYKey[];
  shearx?: SpineValueKey[];
  sheary?: SpineValueKey[];
  inherit?: SpineInheritKey[];
}

export interface SpineSlotTimelines {
  attachment?: SpineAttachmentKey[];
  rgba?: SpineColorKey[];
  rgb?: SpineColorKey[];
  alpha?: SpineValueKey[];
  rgba2?: SpineColorKey[];
  rgb2?: SpineColorKey[];
  /** 3.x */
  color?: SpineColorKey[];
  /** 3.x */
  twoColor?: SpineColorKey[];
}

/** skin -> slot -> attachment -> keys */
export type SpineDeformTimelines = Record<string, Record<string, Record<string, SpineDeformKey[]>>>;

export interface SpineAnimation {
  bones?: Record<string, SpineBoneTimelines>;
  slots?: Record<string, SpineSlotTimelines>;
  ik?: Record<string, SpineIkKey[]>;
  transform?: Record<string, SpineKeyBase[]>;
  path?: Record<string, Record<string, SpineKeyBase[]>>;
  physics?: Record<string, Record<string, SpineKeyBase[]>>;
  /** 4.1+: skin -> slot -> attachment -> { deform, sequence }. */
  attachments?: Record<string, Record<string, Record<string, { deform?: SpineDeformKey[]; sequence?: SpineSequenceKey[] }>>>;
  /** 4.0 / 3.x deform timelines. */
  deform?: SpineDeformTimelines;
  /** 3.0-era name of `deform`. */
  ffd?: SpineDeformTimelines;
  drawOrder?: SpineDrawOrderKey[];
  /** 3.x spelling. */
  draworder?: SpineDrawOrderKey[];
  events?: SpineEventKey[];
}

export interface SpineSkeletonJson {
  skeleton?: SpineSkeletonInfo;
  bones?: SpineBoneData[];
  slots?: SpineSlotData[];
  ik?: SpineIkData[];
  transform?: SpineTransformData[];
  path?: SpinePathConstraintData[];
  physics?: SpinePhysicsData[];
  /** 3.8+: array of skins. 3.7 and older: skin name -> slot -> attachment -> attachment data. */
  skins?: SpineSkinData[] | Record<string, SpineSkinAttachments>;
  events?: Record<string, SpineEventData>;
  animations?: Record<string, SpineAnimation>;
}
