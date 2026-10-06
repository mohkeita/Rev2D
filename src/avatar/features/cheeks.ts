/**
 * Feature "cheeks": blush (Cheek), only when face.cheeks is given.
 *
 * Two soft ellipses over the cheeks (parts at AVATAR_Z.cheeks, children of the root warp, so they
 * follow the head turn and tilt): a radial gradient from a blush colour in the middle to nothing at
 * the rim, wider than tall. Their opacity follows Cheek (0 = invisible: the rest pose is the
 * illustration). Nothing is cut from the picture.
 *
 * The blush colour is estimated in the layer stage from the skin of the face (a deeper, redder shade
 * of it, so it suits pale and dark skin alike) and stored in textures/layers.json under "cheeks";
 * without it (an older layer build) a neutral pink is used.
 */
import { AVATAR_Z } from '../fields.js';
import { labToRgb, rgbToLab } from '../image/color.js';
import type { RGB } from '../image/types.js';
import type { AvatarPose, ImageSide } from '../types.js';
import { faceSkinColor, hexColor, parseHex, round2 } from './eyes-matte.js';
import type { AvatarFeature } from './types.js';

export const CHEEK_TUNING = {
  /** Default blush radius as a share of the face width (spec: 9%). */
  radius: 0.09,
  /** Height of the blush ellipse relative to its width. */
  aspect: 0.62,
  /** Opacity of the blush colour in the middle of the ellipse at Cheek = 1, and halfway out. */
  core: 0.55,
  mid: 0.3,
  /** The blush colour: the skin in Lab with this lightness change and this much more red (a*). */
  lightness: -12,
  redness: 22,
  /** Used when the layer stage did not estimate a colour. */
  fallback: '#f08c96',
} as const;

const SIDES: Record<ImageSide, string> = { imageLeft: 'cheekR', imageRight: 'cheekL' };

export interface CheeksMeta {
  version: 1;
  /** The blush colour, "#rrggbb". */
  color: string;
}

/** A blush colour for a skin colour: deeper and redder (Lab), whatever the skin tone. */
export function blushColor(skin: RGB): RGB {
  const [L, a, b] = rgbToLab(skin[0], skin[1], skin[2]);
  return labToRgb(Math.max(20, L + CHEEK_TUNING.lightness), a + CHEEK_TUNING.redness, b + CHEEK_TUNING.redness * 0.25);
}

function rgba(rgb: RGB, alpha: number): string {
  return `rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},${alpha})`;
}

export const cheeks: AvatarFeature = {
  id: 'cheeks',
  summary: 'blush (Cheek): soft ellipses over the cheeks, only when face.cheeks is given',

  layers(ctx) {
    if (!ctx.spec.face.cheeks) return;
    const meta: CheeksMeta = { version: 1, color: hexColor(blushColor(faceSkinColor(ctx.source, ctx.spec))) };
    ctx.setMeta('cheeks', meta);
  },

  compile(ctx) {
    const spec = ctx.spec.face.cheeks;
    if (!spec) return;
    const { model, root } = ctx;
    const meta = ctx.featureMeta<CheeksMeta>('cheeks');
    const color = parseHex(meta?.color) ?? (parseHex(CHEEK_TUNING.fallback) as RGB);
    const cheek = model.parameter('Cheek');
    const r = spec.radius ?? CHEEK_TUNING.radius * 2 * ctx.spec.face.radius[0];
    const rx = round2(r);
    const ry = round2(r * CHEEK_TUNING.aspect);
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const [cx, cy] = spec[side];
      const id = SIDES[side];
      model.part({
        id,
        parent: root.id,
        z: AVATAR_Z.cheeks,
        shape: { type: 'ellipse', cx: round2(cx), cy: round2(cy), rx, ry, detail: round2(Math.max(2, ry / 3)) },
        fill: {
          type: 'radial',
          center: [round2(cx), round2(cy)],
          radius: rx,
          stops: [
            [0, rgba(color, CHEEK_TUNING.core)],
            [0.5, rgba(color, CHEEK_TUNING.mid)],
            [1, rgba(color, 0)],
          ],
        },
        opacity: 0,
        description: `Blush on the ${side === 'imageLeft' ? "character's right cheek (image left)" : "character's left cheek (image right)"}: its opacity follows Cheek.`,
      });
      model.bind({ id: `${id}Blush`, target: `part:${id}.opacity`, params: [cheek], keys: [{ at: [0], value: 0 }, { at: [1], value: 1 }] });
    }
  },

  poses(ctx): AvatarPose[] {
    return ctx.spec.face.cheeks ? [{ id: 'blush', label: 'blush (Cheek 1)', params: { Cheek: 1 } }] : [];
  },
};
