/**
 * Avatar builder: one illustration -> a rigged Rev2D model. See ./DESIGN.md for the pipeline and
 * the structure of the generated model, ./schema.ts for the avatar spec and ./types.ts for the
 * contracts between the stages. Pure (browser-safe) except where noted; file IO is in
 * src/node/avatar.ts.
 */
import type { ImageRGBA } from '../core/types.js';
import { compileModel, type CompiledAvatar } from './compile.js';
import { buildLayers } from './layers.js';
import { reviewPoses } from './poses.js';
import type { AvatarPose, AvatarSpec, BuildLayersResult, LayersMeta, VariantId } from './types.js';
import { buildSprites, checkVariantDrawing, variantRequests, type BuildSpritesResult, type VariantCheckResult, type VariantRequestInfo } from './variants.js';

export * from './schema.js';
export * from './types.js';

// Spec parsing / validation and the draft of a new project (./spec.ts):
//   parseAvatarSpec(input, options?)   JSON / JSONC text or a parsed value -> {spec, diagnostics, doc}
//   draftAvatarSpec(name, width, height)   a RAW document with every landmark still null
export {
  parseAvatarSpec,
  draftAvatarSpec,
  avatarSpecName,
  avatarSpecHasErrors,
  AVATAR_DIAGNOSTIC_CODES,
  AVATAR_RESERVED_IDS,
  type AvatarSpecParse,
  type ParseAvatarSpecOptions,
} from './spec.js';

// The editable geometry of a RAW spec document, grouped the way the editor lists it (./parts.ts).
export {
  describeAvatarParts,
  avatarLandmarks,
  resolveShape,
  resolvePointer,
  setPointer,
  pointerSegments,
  toSpecPointer,
  AVATAR_PART_GROUPS,
  AVATAR_PART_GROUP_IDS,
  type AvatarLandmark,
  type AvatarPartGroupInfo,
  type AvatarPartGroupMeta,
  type AvatarPartItemInfo,
  type LandmarkRole,
  type ResolvedShape,
} from './parts.js';

// Hash of everything in the spec that changes the layer IMAGES (./hash.ts lists the fields).
export { layerInputsHash, layerInputs, canonicalJson, fnv1a64 } from './hash.js';

// Import of a Mesh Avatar Studio project (rig.json v1) as an avatar spec document (./mas.ts).
export { importMasRig, MasImportError, type MasImportOptions, type MasImportResult } from './mas.js';

// Agent tools: coordinate grids, landmark overlays and the vision check (./tools/).
export * from './tools/index.js';

// The build pipeline. Feature modules (./features/: head, body, eyes, mouth, brows, cheeks, hair,
// attachments, sprites, animations) contribute to both stages through one interface
// (./features/types.ts); ./fields.ts has the shared maths, the model builder and the fold checker.
export { AVATAR_FEATURES, type AvatarFeature, type CompileContext, type FeatureId, type LayersContext, type PosesContext, type ReportSink } from './features/index.js';
export { BASE_LAYER, layerFile } from './layers.js';
export { ROOT_WARP, type CompiledAvatar } from './compile.js';
export { STANDARD_POSES } from './poses.js';
export { AVATAR_Z, STANDARD_PARAMETERS, type StandardParameterId } from './builder.js';
export { findFolds, foldIssues, defaultFoldPoses, FOLD_CODE, type FoldFinding, type FoldOptions, type FoldPlan } from './folds.js';
export { avatarMetrics, type AvatarMetrics } from './fields.js';

/**
 * Stage 1, image processing: the base layer (the illustration with every moving layer cut out and
 * filled in behind) plus the layers of the features (eyes, hair, attachments), and the metadata
 * stage 2 needs. `previous` is the metadata of the last build, for features that can reuse results.
 */
export function buildAvatarLayers(spec: AvatarSpec, source: ImageRGBA, previous?: LayersMeta): BuildLayersResult {
  return buildLayers(spec, source, previous);
}

/**
 * Stage 2: spec + layer metadata -> a Rev2D model document. Pure and fast: the editor runs it on
 * every handle drag. The result also carries `folds`, the plan for the fold checker (findFolds).
 */
export function compileAvatar(spec: AvatarSpec, meta: LayersMeta): CompiledAvatar {
  return compileModel(spec, meta);
}

/** The fixed poses used to review an avatar (rest, half / closed eyes, mouth open, turns, tilts, body sway, ...). */
export function avatarReviewPoses(spec: AvatarSpec, meta: LayersMeta): AvatarPose[] {
  return reviewPoses(spec, meta);
}

// Drawn variants (./variants.ts and its variants-*.ts helpers): the variant table, edit areas and
// masks, prompts / README / preview, the drawing check, sprite cutting and the "sprites" bookkeeping
// of layers.json, the status of every variant. File IO: src/node/avatar-variants.ts.
export * from './variants.js';

/**
 * Masks and prompts for drawn eye / mouth variants (for an image generator): per variant a mask at
 * the source size (TRANSPARENT = may change, OPAQUE = must stay identical) and a prompt with the
 * hard constraints. `ids` default to the recommended eyes_closed and mouth_a. `meta` is not needed
 * (the masks come from the spec's eye regions and mouth area); it is accepted for symmetry.
 */
export function avatarVariantRequests(spec: AvatarSpec, meta: LayersMeta | null, source: ImageRGBA, ids?: VariantId[]): VariantRequestInfo[] {
  return variantRequests(spec, source, ids).requests;
}

/**
 * Check a finished drawing: the size of the source, unchanged outside its mask (within
 * spec.build.variantTolerance; a global shift or zoom is detected and named), changed inside it
 * (each eye, for eye variants). Never throws for a bad drawing: `ok` is false and `reason` / `hint`
 * say why and what to ask the image generator.
 */
export function checkAvatarVariant(spec: AvatarSpec, meta: LayersMeta | null, source: ImageRGBA, id: VariantId, drawing: ImageRGBA): VariantCheckResult {
  return checkVariantDrawing(spec, source, id, drawing);
}

/**
 * Check every drawing and cut the accepted ones into sprite layers (per eye for eye variants, the
 * mouth area for mouth variants). Returns the images of the new sprites (by LayerInfo.file), the
 * updated layer metadata (layers, variants and the "sprites" bookkeeping with fingerprints), the
 * checks, and which drawings were accepted / rejected / rejected-but-kept (a rejected drawing never
 * replaces an earlier accepted sprite).
 */
export function buildAvatarSprites(spec: AvatarSpec, meta: LayersMeta, source: ImageRGBA, drawings: Partial<Record<VariantId, ImageRGBA>>): BuildSpritesResult {
  return buildSprites(spec, meta, source, drawings);
}
