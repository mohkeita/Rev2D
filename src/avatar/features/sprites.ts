/**
 * Feature "sprites": drawn variants (../variants.ts) shown instead of the mesh fallback.
 *
 * LAYERS. Nothing here: sprites are cut from the drawings in variants/ by `rev2d avatar variants
 * import` (buildSprites, ../variants-sprites.ts), which records them in layers.json under "sprites";
 * a rebuild of the layers carries them over (carrySprites, src/node/avatar.ts).
 *
 * COMPILE. Every sprite layer becomes an image part on the root warp (so it follows head turn, tilt,
 * sway and breath exactly as the base under it does), invisible at rest (opacity 0), with its opacity
 * bound to the parameters of its variant.
 *
 *   EYES, per eye: EyeROpen drives the eye on the image left, EyeLOpen the image right (SPRITE_TUNING):
 *     eyes_closed   fully shown up to EyeOpen 0.12, gone at 0.2;
 *     eyes_half     fully shown from 0.3 to 0.6, gone at 0.2 and 0.7; under a closed sprite it stays
 *                   fully shown all the way down, so the closed one fades in over it;
 *     eyes_smile    follows EyeRSmile / EyeLSmile (declared only with this sprite; fully shown from
 *                   0.98), on top of both.
 *   The hair in front of an eye ("<eye>_front", moved by the hair feature) is lifted above the eye
 *   sprites (EYE_FRONT_Z), so it keeps swaying over a drawn eye.
 *   While sprites cover an eye completely, its open-eye layers (white, ball, lids, rims, crease of
 *   ../features/eyes.ts) are hidden: an opacity binding that subtracts 1 (bindings on a
 *   part add up and opacity is clamped to 0..1). The layers come back a little BEFORE a sprite starts
 *   to fade (0.02 of EyeOpen), so every fade is a sprite over the fully drawn mesh eye, and the picture
 *   under the eye never shows through two half-transparent layers.
 *   MOUTH: MouthOpen x MouthForm on a 21 x 9 grid (steps 0.05 x 0.25). At every grid point with
 *   MouthOpen above 0.15 the drawn mouth nearest on the viseme table (DESIGN.md; VARIANTS[id].mouth)
 *   is shown, so a missing variant is stood in for by its nearest drawn neighbour; at 0.15 and below the
 *   closed mouth of the illustration shows (the mouth feature drops its mesh opening when drawn mouths
 *   exist and keeps only MouthForm). Between two grid points of different mouths the LOWER one stays
 *   fully shown while the upper one fades (stacking), so a change of shape is a dissolve over an opaque
 *   picture, never a flash of what lies beneath.
 *
 * Draw order: eye sprites at AVATAR_Z.eyeSprites (half, closed, smile from bottom to top), mouth sprites
 * at AVATAR_Z.mouthSprites (by opening, then form).
 */
import { AVATAR_Z } from '../builder.js';
import type { AvatarPose, ImageSide, LayerInfo, VariantId } from '../types.js';
import { VARIANTS } from '../variants-areas.js';
import { EYE_FRONT_PARTS, EYE_FRONT_Z, shownSprites, spritesMeta, type SpriteRecord } from '../variants-sprites.js';
import type { AvatarFeature, CompileContext } from './types.js';

export const SPRITE_TUNING = {
  /** EyeOpen up to which a closed sprite is fully shown, and where it is gone. */
  closedFull: 0.12,
  closedGone: 0.2,
  /** EyeOpen range where a half sprite is fully shown, and where it is gone on either side. */
  halfFull: [0.3, 0.6] as const,
  halfGone: [0.2, 0.7] as const,
  /** The open-eye layers come back this much (of EyeOpen / EyeSmile) before a sprite starts to fade. */
  margin: 0.02,
  /** MouthOpen x MouthForm grid of the mouth sprites. */
  mouthOpenStep: 0.05,
  mouthFormStep: 0.25,
  /** MouthOpen at and below which the closed mouth shows. */
  mouthClosed: 0.15,
  /** Weight of MouthForm against MouthOpen when finding the nearest drawn mouth (form spans 2, open 1). */
  formWeight: 0.5,
} as const;

/** The eye parameters and eye-layer prefix of an image side ("L" = the character's left = the image right). */
const EYE_SIDES: Record<ImageSide, { open: 'EyeROpen' | 'EyeLOpen'; smile: 'EyeRSmile' | 'EyeLSmile'; eye: 'eyeR' | 'eyeL' }> = {
  imageLeft: { open: 'EyeROpen', smile: 'EyeRSmile', eye: 'eyeR' },
  imageRight: { open: 'EyeLOpen', smile: 'EyeLSmile', eye: 'eyeL' },
};

/** The open-eye layers of ../features/eyes.ts that a sprite hides (those that exist). */
export const EYE_LAYERS_UNDER_SPRITES = ['white', 'ball', 'lower', 'upper', 'lowerRim', 'crease', 'upperRim'] as const;

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** A piecewise-linear function given by (x, y) points, sampled at x. */
function sample(points: ReadonlyArray<readonly [number, number]>, x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

export interface EyeSpriteCurves {
  /** EyeOpen keys shared by every curve below. */
  keys: number[];
  /** Opacity of the half and the closed sprite at the keys (null when that sprite does not exist). */
  half: number[] | null;
  closed: number[] | null;
  /** How much of the open-eye layers is hidden at the keys (1 = hidden while the sprites cover the eye). */
  hide: number[];
}

/**
 * The opacity curves of an eye's half / closed sprites over EyeOpen and how much the open-eye layers
 * are hidden: hidden exactly while the visible sprites are fully opaque, back a margin before any of
 * them fades. Exported for tests.
 */
export function eyeSpriteCurves(hasClosed: boolean, hasHalf: boolean): EyeSpriteCurves {
  const T = SPRITE_TUNING;
  const m = T.margin;
  const closed: Array<[number, number]> = [
    [0, 1],
    [T.closedFull, 1],
    [T.closedGone, 0],
    [1, 0],
  ];
  const half: Array<[number, number]> = hasClosed
    ? [
        [0, 1],
        [T.halfFull[1], 1],
        [T.halfGone[1], 0],
        [1, 0],
      ]
    : [
        [0, 0],
        [T.halfGone[0], 0],
        [T.halfFull[0], 1],
        [T.halfFull[1], 1],
        [T.halfGone[1], 0],
        [1, 0],
      ];
  // Where the sprites together are opaque: [from, to] of EyeOpen.
  let covered: [number, number] | null = null;
  if (hasClosed && hasHalf) covered = [0, T.halfFull[1]];
  else if (hasClosed) covered = [0, T.closedFull];
  else if (hasHalf) covered = [T.halfFull[0], T.halfFull[1]];
  const hide: Array<[number, number]> = [[0, 0]];
  if (covered) {
    const [a, b] = covered;
    hide.length = 0;
    if (a > 0) hide.push([0, 0], [a, 0], [a + m, 1]);
    else hide.push([0, 1]);
    hide.push([b - m, 1], [b, 0], [1, 0]);
  }
  const keys = [...new Set([0, 1, ...(hasClosed ? closed.map((p) => p[0]) : []), ...(hasHalf ? half.map((p) => p[0]) : []), ...hide.map((p) => p[0])].map(round))].sort((x, y) => x - y);
  return {
    keys,
    closed: hasClosed ? keys.map((k) => sample(closed, k)) : null,
    half: hasHalf ? keys.map((k) => sample(half, k)) : null,
    hide: keys.map((k) => round(sample(hide, k))),
  };
}

function addSprite(ctx: CompileContext, layer: LayerInfo, z: number, description: string): string {
  const id = ctx.model.imagePart(layer, { parent: ctx.root.id, z, cell: Math.max(2, ctx.metrics.cell.body / 2), opacity: 0, description });
  ctx.folds.skip('part', id);
  return id;
}

/** The sprite layer of a record for an area key, when the layer stage listed it. */
function spriteLayer(ctx: CompileContext, record: SpriteRecord | undefined, key: string): LayerInfo | undefined {
  const l = record?.layers.find((x) => x.key === key);
  return l ? ctx.layer(l.id) : undefined;
}

/** Hide the open-eye layers of one eye by `amount` (0..1 per key) of a parameter: a binding that subtracts it from their opacity. */
function hideEyeLayers(ctx: CompileContext, eye: string, param: string, keys: readonly number[], amount: readonly number[], tag: string): void {
  if (!amount.some((v) => v > 0)) return;
  for (const name of EYE_LAYERS_UNDER_SPRITES) {
    const id = `${eye}_${name}`;
    const part = ctx.model.findPart(id);
    if (!part) continue;
    const setup = part.opacity ?? 1;
    ctx.model.bind({ id: `${id}Under${tag}`, target: `part:${id}.opacity`, params: [param], keys: keys.map((at, i) => ({ at: [at], value: round(setup - amount[i]) })) });
  }
}

function compileEyes(ctx: CompileContext, records: SpriteRecord[]): void {
  if (records.length === 0) return;
  // The hair in front of the eyes goes above the eye sprites: it keeps swaying over a drawn eye (the
  // sprites were cut with it counted as drawn above them, ../variants-sprites.ts EYE_FRONT_PARTS).
  for (const id of EYE_FRONT_PARTS) {
    const part = ctx.model.findPart(id);
    if (part) part.z = EYE_FRONT_Z;
  }
  const find = (eye: 'closed' | 'half' | 'smile') => records.find((r) => VARIANTS[r.id].eye === eye);
  const closed = find('closed');
  const half = find('half');
  const smile = find('smile');
  for (const side of ['imageLeft', 'imageRight'] as const) {
    const p = EYE_SIDES[side];
    const where = side === 'imageLeft' ? 'the eye on the image left' : 'the eye on the image right';
    const closedLayer = spriteLayer(ctx, closed, side);
    const halfLayer = spriteLayer(ctx, half, side);
    const smileLayer = spriteLayer(ctx, smile, side);
    if (closedLayer || halfLayer) {
      const open = ctx.model.parameter(p.open);
      const curves = eyeSpriteCurves(closedLayer !== undefined, halfLayer !== undefined);
      if (halfLayer) {
        const id = addSprite(ctx, halfLayer, AVATAR_Z.eyeSprites, `Drawn half-closed eye (${where}), shown around ${p.open} = 0.5.`);
        ctx.model.bind({ id: `${id}Show`, target: `part:${id}.opacity`, params: [open], keys: curves.keys.map((at, i) => ({ at: [at], value: curves.half![i] })) });
      }
      if (closedLayer) {
        const id = addSprite(ctx, closedLayer, AVATAR_Z.eyeSprites + 1, `Drawn closed eye (${where}), shown while ${p.open} is below about 0.15.`);
        ctx.model.bind({ id: `${id}Show`, target: `part:${id}.opacity`, params: [open], keys: curves.keys.map((at, i) => ({ at: [at], value: curves.closed![i] })) });
      }
      hideEyeLayers(ctx, p.eye, open, curves.keys, curves.hide, 'Sprite');
    }
    if (smileLayer) {
      const param = ctx.model.parameter(p.smile);
      const id = addSprite(ctx, smileLayer, AVATAR_Z.eyeSprites + 2, `Drawn smiling eye (${where}), shown by ${p.smile}.`);
      // Fully shown a margin before EyeSmile 1, where the open-eye layers start to hide.
      const m = SPRITE_TUNING.margin;
      ctx.model.bind({ id: `${id}Show`, target: `part:${id}.opacity`, params: [param], keys: [{ at: [0], value: 0 }, { at: [round(1 - m)], value: 1 }, { at: [1], value: 1 }] });
      hideEyeLayers(ctx, p.eye, param, [0, round(1 - m), 1], [0, 0, 1], 'Smile');
    }
  }
}

/** The grid keys of the mouth sprites: MouthOpen 0..1 and MouthForm -1..1 in SPRITE_TUNING steps. */
export function mouthGrid(): { open: number[]; form: number[] } {
  const T = SPRITE_TUNING;
  const steps = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => round(from + i * step));
  return { open: steps(0, 1, T.mouthOpenStep), form: steps(-1, 1, T.mouthFormStep) };
}

/** For every (MouthOpen, MouthForm) grid point: the index of the nearest drawn mouth, or -1 where the closed mouth shows. */
export function mouthSpriteWinners(shapes: ReadonlyArray<{ open: number; form: number }>): number[][] {
  const T = SPRITE_TUNING;
  const grid = mouthGrid();
  return grid.open.map((o) =>
    grid.form.map((f) => {
      if (o <= T.mouthClosed + 1e-9 || shapes.length === 0) return -1;
      let best = 0;
      let bestD = Infinity;
      shapes.forEach((s, i) => {
        const d = Math.hypot(o - s.open, T.formWeight * (f - s.form));
        if (d < bestD - 1e-9) {
          bestD = d;
          best = i;
        }
      });
      return best;
    }),
  );
}

/**
 * The opacity of every drawn mouth (in draw order, bottom first) at every grid point: 1 for the
 * nearest one; 1 also for a mouth drawn BELOW it that is the nearest at a neighbouring grid point (it
 * stays opaque while the upper one fades in or out between them); else 0.
 */
export function mouthSpriteOpacities(shapes: ReadonlyArray<{ open: number; form: number }>): number[][][] {
  const winners = mouthSpriteWinners(shapes);
  const rows = winners.length;
  const cols = winners[0]?.length ?? 0;
  return shapes.map((_, s) =>
    winners.map((row, i) =>
      row.map((w, j) => {
        if (w === s) return 1;
        if (w < 0 || s > w) return 0;
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            const ni = i + di;
            const nj = j + dj;
            if (ni >= 0 && nj >= 0 && ni < rows && nj < cols && winners[ni][nj] === s) return 1;
          }
        }
        return 0;
      }),
    ),
  );
}

function compileMouth(ctx: CompileContext, records: SpriteRecord[]): void {
  const list = records
    .map((r) => ({ record: r, shape: VARIANTS[r.id].mouth, layer: spriteLayer(ctx, r, 'mouth') }))
    .filter((x): x is { record: SpriteRecord; shape: { open: number; form: number }; layer: LayerInfo } => x.layer !== undefined && x.shape !== undefined)
    .sort((a, b) => a.shape.open - b.shape.open || a.shape.form - b.shape.form);
  if (!list.length) return;
  const open = ctx.model.parameter('MouthOpen');
  const form = ctx.model.parameter('MouthForm');
  const grid = mouthGrid();
  const opacity = mouthSpriteOpacities(list.map((x) => x.shape));
  list.forEach((x, s) => {
    const keys = grid.open.flatMap((o, i) => grid.form.map((f, j) => ({ at: [o, f], value: opacity[s][i][j] })));
    const id = addSprite(ctx, x.layer, AVATAR_Z.mouthSprites, `Drawn mouth "${x.record.id}", shown around MouthOpen ${x.shape.open}, MouthForm ${x.shape.form} (and wherever it is the nearest drawn shape).`);
    ctx.model.bind({ id: `${id}Show`, target: `part:${id}.opacity`, params: [open, form], keys });
  });
}

export const sprites: AvatarFeature = {
  id: 'sprites',
  summary: 'drawn variants: eye and mouth sprites cut from the drawings in variants/, shown instead of the mesh fallback',

  compile(ctx) {
    const eyes = shownSprites(ctx.meta, 'eyes');
    const mouths = shownSprites(ctx.meta, 'mouth');
    if (!eyes.length && !mouths.length) return;
    compileEyes(ctx, eyes);
    compileMouth(ctx, mouths);
    ctx.report.stat('sprites', eyes.length + mouths.length);
  },

  poses(ctx): AvatarPose[] {
    const sm = spritesMeta(ctx.meta);
    const has = (id: VariantId) => sm?.sprites.some((s) => s.id === id) ?? false;
    const out: AvatarPose[] = [];
    if (has('eyes_closed')) out.push({ id: 'sprite_eyes_fade', label: 'closed sprite fading (EyeOpen 0.16)', params: { EyeLOpen: 0.16, EyeROpen: 0.16 }, zoom: 'eyes' });
    if (has('eyes_smile')) out.push({ id: 'sprite_eyes_smile', label: 'smiling eyes (EyeSmile 1)', params: { EyeLSmile: 1, EyeRSmile: 1 }, zoom: 'eyes' });
    if (sm?.sprites.some((s) => s.group === 'mouth')) out.push({ id: 'sprite_mouth_fade', label: 'drawn mouth fading in (MouthOpen 0.175)', params: { MouthOpen: 0.175, MouthForm: 0 }, zoom: 'mouth' });
    if (has('mouth_a_half')) out.push({ id: 'sprite_mouth_a_half', label: 'mouth half open (MouthOpen 0.5)', params: { MouthOpen: 0.5, MouthForm: 0 }, zoom: 'mouth' });
    return out;
  },
};
