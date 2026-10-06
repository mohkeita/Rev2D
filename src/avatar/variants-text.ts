/**
 * The words and the picture of a variant request (step 1 of ./variants.ts): the prompt for the
 * image generator (what to draw, where, and the hard constraints that make the drawing usable),
 * README.md for the person or agent who draws them, and preview.png, the illustration with the
 * editable areas tinted. Pure and deterministic.
 */
import type { ImageRGBA } from '../core/types.js';
import { createImage, cropImage, resizeNearest } from '../render/image.js';
import { drawLabel } from '../render/font.js';
import { composeSheet } from '../render/sheet.js';
import { compositeOver, downscaleArea, tintMask } from './image/compose.js';
import { createMask } from './image/mask.js';
import type { Rect, RGB } from './image/types.js';
import { AVATAR_PART_GROUPS } from './parts.js';
import type { AvatarSpec, VariantGroup, VariantId } from './types.js';
import { variantFiles, VARIANT_PREVIEW, VARIANT_README, VARIANT_TUNING, VARIANTS, type VariantArea, type VariantEditAreas } from './variants-areas.js';

const groupColor = (id: 'eyes' | 'mouth'): string => AVATAR_PART_GROUPS.find((g) => g.id === id)?.color ?? (id === 'eyes' ? '#F0E442' : '#D55E00');

function hexRgb(hex: string): RGB {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const r0 = (v: number) => Math.round(v);

/** Where an area is, in words with coordinates: "around the eye on the image left (x 424..556, y 424..516)". */
function areaText(spec: AvatarSpec, a: VariantArea): string {
  const [x0, y0, x1, y1] = a.bounds;
  if (a.key === 'mouth') {
    const { center, radius, rotation } = spec.face.mouth.area;
    return `the ellipse around the mouth centred at (${r0(center[0])}, ${r0(center[1])}) with radii ${r0(radius[0])} x ${r0(radius[1])} px${rotation ? `, rotated ${Math.round(rotation)} degrees` : ''}, grown by about ${Math.max(1, Math.round(a.grow))} px`;
  }
  return `the area around the eye on the image ${a.key === 'imageLeft' ? 'left' : 'right'} (x ${r0(x0)}..${r0(x1)}, y ${r0(y0)}..${r0(y1)}, grown by about ${Math.max(1, Math.round(a.grow))} px)`;
}

/** True when the picture has a transparent background worth keeping (some fully transparent pixels). */
export function hasTransparentBackground(source: ImageRGBA): boolean {
  let n = 0;
  for (let i = 3; i < source.data.length; i += 4) if (source.data[i] < VARIANT_TUNING.backgroundAlpha && ++n > (source.width * source.height) / 200) return true;
  return false;
}

export interface VariantPromptOptions {
  /** The illustration's file name in the text (default spec.image.file). */
  sourceName?: string;
  /** Whether the illustration has a transparent background (hasTransparentBackground). */
  transparent?: boolean;
}

/** The prompt for one variant: what to draw where, and the constraints that keep the drawing usable. */
export function variantPrompt(spec: AvatarSpec, id: VariantId, edit: VariantEditAreas, options: VariantPromptOptions = {}): string {
  const def = VARIANTS[id];
  const files = variantFiles(id);
  const { width: W, height: H } = spec.image;
  const source = options.sourceName ?? spec.image.file;
  const transparent = options.transparent ?? false;
  const where = edit.areas.map((a) => areaText(spec, a)).join(' and ');
  return [
    `Edit this illustration: ${def.short}.`,
    '',
    `Input image: ${source}, ${W}x${H} px${transparent ? ', with a transparent background' : ''}.`,
    `Edit mask: ${files.mask}, the same size. OPAQUE (black) mask pixels must stay exactly as they are; TRANSPARENT (white) mask pixels may change. The transparent area is ${where}.`,
    '',
    `Draw: ${def.draw}`,
    '',
    'Hard constraints:',
    `- The output is exactly ${W}x${H} px with the same framing as the input: no crop, zoom, shift, rotation or padding.`,
    `- Every pixel outside the transparent area of the mask stays identical to the input: same colours, line art and shading${transparent ? ', and the transparent background stays transparent' : ''}.`,
    '- Nothing new: no extra objects, text, hands, hair strands, highlights or effects, and no restyling or recolouring of the picture.',
    '- The same art style, line weight, colours and lighting as the original, so the redrawn area blends seamlessly into its unchanged surroundings.',
    '',
    `Save the result as a PNG${transparent ? ' with transparency' : ''} at ${files.drawing}.`,
    '',
  ].join('\n');
}

export interface VariantReadmeEntry {
  id: VariantId;
  recommended: boolean;
}

export interface VariantReadmeOptions extends VariantPromptOptions {
  /** How the project folder is written in commands (default "."). */
  project?: string;
  /** The command that runs rev2d (default "rev2d"). */
  rev2d?: string;
}

/** README.md of variant-requests/: the files, the mask convention, the steps and what the import checks. */
export function variantReadme(spec: AvatarSpec, entries: readonly VariantReadmeEntry[], options: VariantReadmeOptions = {}): string {
  const T = VARIANT_TUNING;
  const { width: W, height: H } = spec.image;
  const source = options.sourceName ?? spec.image.file;
  const project = options.project ?? '.';
  const rev2d = options.rev2d ?? 'rev2d';
  const tolerance = spec.build?.variantTolerance ?? T.tolerance;
  const file = (path: string) => path.replace(/^variant-requests\//, '');
  const rows = entries.map((e) => {
    const f = variantFiles(e.id);
    return `| \`${e.id}\`${e.recommended ? ' (recommended)' : ''} | ${VARIANTS[e.id].short} | \`${file(f.mask)}\` | \`${file(f.prompt)}\` | \`${f.drawing}\` |`;
  });
  return [
    `# Drawn variants of "${spec.name}"`,
    '',
    'Rev2D animates this avatar by deforming the illustration. Closed eyes and an open mouth look far better when they',
    'are DRAWN: an image generator redraws the eyes or the mouth of a full-size copy of the illustration, and Rev2D cuts',
    'the redrawn area out as a sprite that replaces the mesh deformation (which stays the fallback for every variant',
    'without a drawing).',
    '',
    '## Files',
    '',
    '| Variant | What to draw | Edit mask | Prompt | Save the drawing as |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `\`${file(VARIANT_PREVIEW)}\` shows the illustration with the editable areas tinted (eyes yellow, mouth orange).`,
    'Paths are relative to the project folder (the folder that holds avatar.json).',
    '',
    '## The edit mask',
    '',
    `Every mask has the size of \`${source}\` (${W}x${H} px). OPAQUE black pixels must stay exactly as they are;`,
    'TRANSPARENT pixels may change (their colour is white, so tools that read a mask as "white = edit" agree), with a soft',
    'edge in between. All eye variants share one mask (both eye areas), all mouth variants another (the mouth area).',
    '',
    '## Steps',
    '',
    `1. For each variant give the image generator \`${source}\`, its mask and the whole text of its prompt file.`,
    `2. Save the output at full size (${W}x${H} px) as \`variants/<id>.png\`. Look at it next to \`${source}\`: only the`,
    '   eyes (or the mouth) may differ, and nothing may be shifted, zoomed or recoloured.',
    `3. Import: \`${rev2d} avatar variants import ${project}\` checks every drawing and cuts the accepted ones into sprites`,
    '   (the model is rebuilt with them). A rejected drawing is reported with the reason and what to ask the generator',
    '   next; draw it again and import again.',
    `4. Review: \`${rev2d} avatar poses ${project}\`, then look at review/eyes.png, review/mouth.png and review/poses.png.`,
    '   A sprite must sit exactly on the eyes or the mouth, without a seam, halo or colour step around it.',
    `5. \`${rev2d} avatar variants status ${project}\` lists what is requested, drawn, accepted, rejected or stale.`,
    `   To remove a variant, delete \`variants/<id>.png\` and import again.`,
    '',
    '## What the import checks',
    '',
    `- Size: exactly ${W}x${H} px.`,
    `- Outside the mask: the mean difference must not exceed ${tolerance} (of 255; \`build.variantTolerance\` in avatar.json),`,
    `  so fine compression noise passes; at most ${Math.round(T.maxBadShare * 1000) / 10}% of those pixels may change by more than ${T.bad} levels; in the`,
    `  ring just around the editable area the mean may reach ${Math.round(tolerance * T.nearFactor * 100) / 100}. The transparent background does not count.`,
    `- Alignment: a drawing that is shifted or zoomed against \`${source}\` is rejected, and the message says by how much.`,
    `- Inside the mask: at least ${Math.round(T.minInsideChange * 100)}% of the editable area (of each eye) must change.`,
    '',
    'A rejected drawing never replaces an accepted sprite of the same variant: the earlier sprite stays until a new',
    'drawing is accepted. A sprite goes stale when its drawing or the eye regions / mouth area in avatar.json change:',
    'import again.',
    '',
    '## Tips',
    '',
    '- Generators that repaint the whole picture: keep only the masked area of their output and paste it onto a copy of',
    `  \`${source}\` (an image editor with the mask as a selection does it), then save that copy.`,
    '- Generators that cannot keep transparency: the background may come back filled; that is accepted, the sprites only use',
    '  the editable areas.',
    '- Ask for one variant at a time, and compare each result with the original before importing it.',
    '',
  ].join('\n');
}

/**
 * The illustration around the edit areas of the given groups, with those areas tinted in the group
 * colours (eyes yellow, mouth orange) and labelled, enlarged when small: the picture that shows
 * where a drawing may change.
 */
export function variantPreview(source: ImageRGBA, edits: readonly VariantEditAreas[]): ImageRGBA {
  const areas = edits.flatMap((e) => e.areas.map((a) => ({ group: e.group, area: a })));
  if (areas.length === 0) return composeSheet([{ image: createImage(64, 64, '#7d8797'), caption: 'no edit areas' }]);
  // The union of the areas, grown by a quarter of its size on every side, inside the image.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { area } of areas) {
    x0 = Math.min(x0, area.rect.x);
    y0 = Math.min(y0, area.rect.y);
    x1 = Math.max(x1, area.rect.x + area.rect.width);
    y1 = Math.max(y1, area.rect.y + area.rect.height);
  }
  const mx = Math.round((x1 - x0) * 0.25);
  const my = Math.round((y1 - y0) * 0.25);
  const crop: Rect = { x: Math.max(0, x0 - mx), y: Math.max(0, y0 - my), width: 0, height: 0 };
  crop.width = Math.min(source.width, x1 + mx) - crop.x;
  crop.height = Math.min(source.height, y1 + my) - crop.y;

  let image = createImage(crop.width, crop.height, '#7d8797');
  compositeOver(image, cropImage(source, crop.x, crop.y, crop.width, crop.height));
  for (const group of ['eyes', 'mouth'] as const) {
    const mask = createMask(crop.width, crop.height);
    for (const { group: g, area } of areas) {
      if (g !== group) continue;
      for (let y = 0; y < area.rect.height; y++) {
        const ty = y + area.rect.y - crop.y;
        if (ty < 0 || ty >= crop.height) continue;
        for (let x = 0; x < area.rect.width; x++) {
          const tx = x + area.rect.x - crop.x;
          if (tx < 0 || tx >= crop.width) continue;
          const v = area.mask.data[y * area.rect.width + x];
          if (v > mask.data[ty * crop.width + tx]) mask.data[ty * crop.width + tx] = v;
        }
      }
    }
    image = tintMask(image, mask, hexRgb(groupColor(group)), 0.5);
    // The edge of the editable area (its 0.5 level) as a solid line in the group colour.
    const edge = createMask(crop.width, crop.height);
    for (let y = 0; y < crop.height; y++) {
      for (let x = 0; x < crop.width; x++) {
        const i = y * crop.width + x;
        if (mask.data[i] < 0.5) continue;
        const outside = (xx: number, yy: number) => xx < 0 || yy < 0 || xx >= crop.width || yy >= crop.height || mask.data[yy * crop.width + xx] < 0.5;
        if (outside(x - 1, y) || outside(x + 1, y) || outside(x, y - 1) || outside(x, y + 1)) edge.data[i] = 1;
      }
    }
    image = tintMask(image, edge, hexRgb(groupColor(group)), 1);
  }
  // A readable size: small faces are enlarged by a whole number, big ones reduced.
  const long = Math.max(crop.width, crop.height);
  let factor = 1;
  if (long < 700) {
    factor = Math.max(1, Math.floor(800 / long));
    image = resizeNearest(image, crop.width * factor, crop.height * factor);
  } else if (long > 1100) {
    const k = Math.ceil(long / 900);
    image = downscaleArea(image, k);
    factor = 1 / k;
  }
  const textScale = image.width >= 500 ? 2 : 1;
  for (const { group, area } of areas) {
    const x = (area.bounds[0] - crop.x) * factor;
    const y = (area.bounds[1] - crop.y) * factor - 12 * textScale;
    drawLabel(image, Math.max(0, x), Math.max(0, y), group === 'eyes' ? 'eye' : 'mouth', { scale: textScale });
  }
  return composeSheet([{ image, caption: 'tinted = may change (eyes yellow, mouth orange); everything else must stay identical' }], { title: `editable areas, x ${crop.x}..${crop.x + crop.width}, y ${crop.y}..${crop.y + crop.height}` });
}

/** README and preview paths (relative to the project), for messages. */
export const VARIANT_REQUEST_FILES = { readme: VARIANT_README, preview: VARIANT_PREVIEW } as const;
