/**
 * Contracts of the avatar builder (one illustration -> a rigged Rev2D model).
 *
 *   avatar.json (AvatarSpec) + source.png
 *        │ buildAvatarLayers   (image processing: cut / inpaint / masks; slow, needs pixels)
 *        ▼
 *   textures/*.png + textures/layers.json (LayersMeta)
 *        │ compileAvatar       (pure and fast: runs in the browser on every handle drag)
 *        ▼
 *   <name>.r2d.json            (a normal Rev2D model: parameters, warps, parts, bindings, physics, animations)
 *
 * Everything here is pure (no Node APIs); file IO lives in src/node/avatar.ts.
 */
import type { z } from 'zod';
import type { Diagnostic, ImageRGBA } from '../core/types.js';
import type {
  AvatarAttachmentSchema,
  AvatarEyeSchema,
  AvatarSpecSchema,
  AvatarStrandSchema,
} from './schema.js';

export type AvatarSpec = z.output<typeof AvatarSpecSchema>;
/** What authors write (defaults optional). */
export type AvatarSpecInput = z.input<typeof AvatarSpecSchema>;
export type AvatarEye = z.output<typeof AvatarEyeSchema>;
export type AvatarStrand = z.output<typeof AvatarStrandSchema>;
export type AvatarAttachment = z.output<typeof AvatarAttachmentSchema>;

export type ImageSide = 'imageLeft' | 'imageRight';

// ----------------------------------------------------------------------------- reports

export interface AvatarIssue {
  severity: 'warning' | 'info';
  /** Stable kebab-case code, e.g. "avatar-hair-mask-sparse". */
  code: string;
  message: string;
  /** JSON pointer into avatar.json when the issue belongs to a field, e.g. "/face/eyes/imageLeft/opening". */
  path?: string;
  hint?: string;
}

export interface AvatarReport {
  issues: AvatarIssue[];
  /** Counts and measurements, e.g. {layers: 9, hairCoverage: 0.31, warps: 6, parts: 14}. */
  stats: Record<string, number>;
}

// ----------------------------------------------------------------------------- spec parsing

export interface AvatarSpecResult {
  /** Normalized spec (defaults filled) when there are no errors; null otherwise. */
  spec: AvatarSpec | null;
  /** Same Diagnostic shape as model validation: severity, stable code, JSON pointer, message, hint. */
  diagnostics: Diagnostic[];
}

// ----------------------------------------------------------------------------- editable parts (editor handles, overlays)

/** JSON pointer (RFC 6901) into the RAW avatar.json document. */
export type SpecPointer = string;

export type HandleShape =
  | { type: 'point'; at: SpecPointer }
  | { type: 'ellipse'; center: SpecPointer; radius: SpecPointer; rotation?: SpecPointer }
  | { type: 'polygon'; points: SpecPointer }
  | { type: 'polyline'; points: SpecPointer }
  /** Horizontal band [yStart, yEnd]. */
  | { type: 'band'; range: SpecPointer }
  | { type: 'segment'; a: SpecPointer; b: SpecPointer };

export interface AvatarPartItem {
  /** Stable id, unique within the spec, e.g. "eyes.imageLeft.opening" or "strand.bangL". Also the i18n key. */
  id: string;
  /** English label. */
  label: string;
  shape: HandleShape;
  /** True when changing it requires rebuilding the layer images (it cuts pixels). */
  cutsLayers: boolean;
  /** Short placement tip (English). */
  tip?: string;
}

export type AvatarPartGroupId = 'head' | 'eyes' | 'mouth' | 'face' | 'cheeks' | 'strands' | 'attachments' | 'body';

export interface AvatarPartGroup {
  id: AvatarPartGroupId;
  category: 'face' | 'hair' | 'body';
  /** English label and one-line description (i18n keys: `group.<id>.label|description`). */
  label: string;
  description: string;
  /** CSS colour used for this group's handles everywhere (editor, overlay images). */
  color: string;
  /** False when the optional group is absent from this spec (the editor shows it disabled). */
  present: boolean;
  items: AvatarPartItem[];
}

// ----------------------------------------------------------------------------- layers

export interface LayerInfo {
  /** Unique id, also the Rev2D texture id, e.g. "base", "eyeR_ball", "hair", "att_tasselL", "sprite_mouth_a". */
  id: string;
  /** PNG path relative to the project folder, e.g. "textures/eyeR_ball.png". */
  file: string;
  /** Where the image sits in the source: [x, y, width, height] in source pixels. */
  rect: [number, number, number, number];
}

/**
 * Everything compileAvatar needs besides the spec. Written as textures/layers.json so the editor
 * can recompile the model in the browser without the source pixels. The builder may add fields
 * (sampled eye curves, estimated colours, sprite lists, ...); these are the guaranteed ones.
 */
export interface LayersMeta {
  version: 1;
  /** layerInputsHash(spec) at build time: when it differs from the current spec, the layers are stale. */
  inputsHash: string;
  image: { width: number; height: number };
  layers: LayerInfo[];
  /** Ids of the drawn variants that were accepted and cut into sprites (e.g. "eyes_closed", "mouth_a"). */
  variants: string[];
  [extra: string]: unknown;
}

export interface BuildLayersResult {
  /** Layer images by LayerInfo.file. */
  images: Record<string, ImageRGBA>;
  meta: LayersMeta;
  report: AvatarReport;
}

export interface CompileAvatarResult {
  /** Raw Rev2D model JSON (write with formatModelJson). Texture paths are LayerInfo.file. */
  doc: Record<string, unknown>;
  report: AvatarReport;
}

// ----------------------------------------------------------------------------- drawn variants

export type VariantGroup = 'eyes' | 'mouth';

/** Drawn variants an image generator can provide. Mesh deformation is the fallback for each. */
export const VARIANT_IDS = [
  'eyes_closed',
  'eyes_half',
  'eyes_smile',
  'mouth_a',
  'mouth_a_half',
  'mouth_i',
  'mouth_u',
  'mouth_e',
  'mouth_o',
] as const;
export type VariantId = (typeof VARIANT_IDS)[number];

export interface VariantRequest {
  id: VariantId;
  group: VariantGroup;
  /** Where the finished drawing goes, relative to the project: "variants/<id>.png" (full-size, same size as the source). */
  file: string;
  /** Edit mask at the source size: TRANSPARENT pixels may change, OPAQUE pixels must stay identical. */
  mask: ImageRGBA;
  /** Path the mask is written to: "variant-requests/<id>.mask.png". */
  maskFile: string;
  /** Prompt for the image generator (English). */
  prompt: string;
  /** True for the variants that matter most (closed eyes, mouth "a"). */
  recommended: boolean;
}

export interface VariantCheck {
  id: VariantId;
  ok: boolean;
  /** Why it was rejected (size mismatch, changed outside the mask, nothing changed inside), with numbers. */
  reason?: string;
  hint?: string;
  /** Mean absolute difference (0-255) outside the mask and the share of pixels changed inside it. */
  outsideDiff: number;
  insideChanged: number;
}

// ----------------------------------------------------------------------------- review poses

export interface AvatarPose {
  id: string;
  label: string;
  /** Explicit parameter values (ids of the BUILT model). */
  params: Record<string, number>;
  /** Optional zoom target for the crop sheets. */
  zoom?: 'eyes' | 'mouth';
}
