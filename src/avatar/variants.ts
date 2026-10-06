/**
 * Drawn variants (DESIGN.md "Drawn variants"): eye and mouth pictures from an image generator that
 * replace the mesh fallback where they exist. The flow, and where each step lives:
 *
 *   1. REQUEST  variantRequests (here; words in ./variants-text.ts): per variant an edit mask at the
 *               source size (TRANSPARENT = may change, OPAQUE = must stay identical), a prompt for the
 *               image generator, plus README.md and preview.png for the whole set.
 *   2. DRAW     an agent with an image generator, or a person, saves variants/<id>.png: a full-size copy
 *               of the illustration in which only the masked area is redrawn.
 *   3. CHECK    checkVariantDrawing (./variants-check.ts): same size; unchanged outside the mask
 *               (recompression noise passes, a shift or a zoom is found and named); changed inside it.
 *   4. CUT      buildSprites (./variants-sprites.ts): accepted drawings become feathered sprite layers
 *               (one per eye, or the mouth area), recorded in layers.json under "sprites" with the
 *               fingerprints that make them stale (the drawing's pixels, the landmarks they were cut with).
 *   5. SHOW     the "sprites" feature (./features/sprites.ts) places them in the model and binds their
 *               opacity to EyeOpen / EyeSmile and to MouthOpen x MouthForm.
 *
 * Shared ground (the variant table, edit areas, fingerprints) is in ./variants-areas.ts. File IO
 * (writing requests, importing drawings, the status of a project) is in src/node/avatar-variants.ts.
 * Everything here is pure, deterministic and browser-safe.
 */
import type { ImageRGBA } from '../core/types.js';
import { VARIANT_IDS, type AvatarSpec, type VariantGroup, type VariantId, type VariantRequest } from './types.js';
import { RECOMMENDED_VARIANT_IDS, variantEditAreas, variantFiles, variantMaskImage, VARIANTS, type VariantAreaKey, type VariantEditAreas } from './variants-areas.js';
import { hasTransparentBackground, variantPrompt, type VariantPromptOptions } from './variants-text.js';

export * from './variants-areas.js';
export * from './variants-check.js';
export * from './variants-sprites.js';
export * from './variants-text.js';

export interface VariantRequestInfo extends VariantRequest {
  label: string;
  /** Where the prompt is written: "variant-requests/<id>.prompt.txt". */
  promptFile: string;
  /** The edit areas of the mask: key, landmark bounds [x0, y0, x1, y1], growth and soft edge in px. */
  areas: Array<{ key: VariantAreaKey; bounds: [number, number, number, number]; grow: number; feather: number }>;
}

export interface VariantRequestSet {
  requests: VariantRequestInfo[];
  /** The edit areas per group that occurs in `requests` (for the preview and the check). */
  edits: VariantEditAreas[];
  /** Whether the illustration has a transparent background (the prompts ask to keep it). */
  transparent: boolean;
}

/** The ids in VARIANT_IDS order without duplicates; none given = the recommended ones. */
export function normalizeVariantIds(ids?: readonly VariantId[]): VariantId[] {
  if (!ids || ids.length === 0) return [...RECOMMENDED_VARIANT_IDS];
  return VARIANT_IDS.filter((id) => ids.includes(id));
}

/**
 * Masks and prompts for drawn variants (`ids`, default the recommended eyes_closed and mouth_a).
 * Variants of one group share their mask image.
 */
export function variantRequests(spec: AvatarSpec, source: ImageRGBA, ids?: readonly VariantId[], options: VariantPromptOptions = {}): VariantRequestSet {
  const transparent = options.transparent ?? hasTransparentBackground(source);
  const edits = new Map<VariantGroup, { edit: VariantEditAreas; mask: ImageRGBA }>();
  const requests = normalizeVariantIds(ids).map((id): VariantRequestInfo => {
    const def = VARIANTS[id];
    let e = edits.get(def.group);
    if (!e) {
      const edit = variantEditAreas(spec, def.group);
      e = { edit, mask: variantMaskImage(edit) };
      edits.set(def.group, e);
    }
    const files = variantFiles(id);
    return {
      id,
      group: def.group,
      label: def.label,
      file: files.drawing,
      mask: e.mask,
      maskFile: files.mask,
      prompt: variantPrompt(spec, id, e.edit, { ...options, transparent }),
      promptFile: files.prompt,
      recommended: def.recommended,
      areas: e.edit.areas.map((a) => ({ key: a.key, bounds: a.bounds, grow: a.grow, feather: a.feather })),
    };
  });
  return { requests, edits: [...edits.values()].map((e) => e.edit), transparent };
}
