/**
 * Drawn variants in the built model (../features/sprites.ts with ../features/eyes.ts, mouth.ts and
 * brows.ts), on the repository's own test illustration (test/fixtures/avatar-hana.ts, half size) with
 * drawings painted programmatically (./variants-drawings.ts):
 *
 *   - eye sprites take over from the mesh blink: closed below EyeOpen 0.12, half around 0.5, smile on
 *     EyeSmile; the open-eye layers are hidden only while the sprites cover the eye completely, so no
 *     transition shows the picture under the eye through two half-transparent layers;
 *   - drawn mouths are chosen on MouthOpen x MouthForm by the viseme table, the nearest drawn one
 *     standing in for a missing one, the closed mouth at MouthOpen 0; the mesh opening is dropped;
 *   - the model validates, the rest pose is the model without sprites, and everything is deterministic.
 */
import { describe, expect, it } from 'vitest';
import { formatModelJson } from '../../core/format.js';
import { Rig, buildRenderList } from '../../core/rig.js';
import type { ImageRGBA, Model } from '../../core/types.js';
import { validateModel } from '../../core/validate.js';
import { renderImage } from '../../render/index.js';
import { hanaIllustration } from '../../../test/fixtures/avatar-hana.js';
import { compileModel } from '../compile.js';
import { AVATAR_FEATURES } from '../features/index.js';
import { EYE_LAYERS_UNDER_SPRITES, eyeSpriteCurves, mouthGrid, mouthSpriteOpacities, mouthSpriteWinners, SPRITE_TUNING } from '../features/sprites.js';
import { findFolds } from '../folds.js';
import { buildLayers } from '../layers.js';
import { parseAvatarSpec } from '../spec.js';
import type { AvatarSpec, LayersMeta, VariantId } from '../types.js';
import { buildSprites, spriteBackdrop, variantEditable, variantEditAreas, VARIANTS } from '../variants.js';
import { copyImage, drawClosedEyes, drawOpenMouth, keepInFront } from './variants-drawings.js';

const hana = hanaIllustration(0.5);
const spec = parseAvatarSpec(hana.doc).spec as AvatarSpec;
const W = hana.width;
const H = hana.height;
const source = hana.image;
const FEATURES = AVATAR_FEATURES.filter((f) => ['head', 'body', 'eyes', 'mouth', 'brows', 'sprites'].includes(f.id));
const layers = buildLayers(spec, source, undefined, FEATURES);
const eyesEdit = variantEditAreas(spec, 'eyes');
const mouthEdit = variantEditAreas(spec, 'mouth');

function built(meta: LayersMeta, images: Record<string, ImageRGBA>) {
  const compiled = compileModel(spec, meta, FEATURES);
  const validation = validateModel(compiled.doc);
  const model = validation.model as Model;
  const textures = Object.fromEntries(meta.layers.map((l) => [l.id, images[l.file]]));
  const rig = new Rig(model);
  const render = (params: Record<string, number> = {}) => renderImage(buildRenderList(rig, rig.pose({ params, physics: false })), textures, { supersample: 1 });
  return { compiled, validation, model, rig, textures, render };
}

const bare = built(layers.meta, layers.images);
/** What lies over the eye and mouth sprites (brows), from the model without sprites. */
const backdrops = {
  eyes: spriteBackdrop(bare.model, bare.textures, layers.images['textures/base.png'], eyesEdit),
  mouth: spriteBackdrop(bare.model, bare.textures, layers.images['textures/base.png'], mouthEdit),
};

/** Eye drawings as a generator makes them (brows stay in front): closed, half (eyes painted lighter), smile (darker). */
const closed = keepInFront(drawClosedEyes(source, spec), source, backdrops.eyes);
function shaded(shade: number): ImageRGBA {
  const out = copyImage(source);
  const editable = variantEditable(eyesEdit);
  const opening = drawClosedEyes(source, spec);
  for (let p = 0; p < W * H; p++) {
    if (editable.data[p] < 0.999) continue;
    // Only the eye itself changes (the repainted opening), lighter or darker.
    if (![0, 1, 2].some((c) => opening.data[p * 4 + c] !== source.data[p * 4 + c])) continue;
    for (let c = 0; c < 3; c++) out.data[p * 4 + c] = source.data[p * 4 + c] + shade;
  }
  return keepInFront(out, source, backdrops.eyes);
}
const half = shaded(60);
const smile = shaded(-60);
const mouthO = drawOpenMouth(source, spec, 0.4);
const mouthA = drawOpenMouth(source, spec, 0.7);

function withSprites(drawings: Partial<Record<VariantId, ImageRGBA>>) {
  const s = buildSprites(spec, layers.meta, source, drawings, { backdrops });
  expect(s.rejected).toEqual([]);
  return { sprites: s, ...built(s.meta, { ...layers.images, ...s.images }) };
}

const eyeCore = (() => {
  const editable = variantEditable(eyesEdit);
  const out: number[] = [];
  for (let i = 0; i < editable.data.length; i++) if (editable.data[i] >= 0.999) out.push(i);
  return out;
})();
const mouthCore = (() => {
  const editable = variantEditable(mouthEdit);
  const out: number[] = [];
  for (let i = 0; i < editable.data.length; i++) if (editable.data[i] >= 0.999) out.push(i);
  return out;
})();

/** Largest channel difference over pixels, against an expected image or a per-pixel blend of two. */
function maxDiff(img: ImageRGBA, pixels: number[], a: ImageRGBA, b?: ImageRGBA, t = 0): number {
  let max = 0;
  for (const p of pixels) {
    for (let c = 0; c < 4; c++) {
      const want = b ? a.data[p * 4 + c] * (1 - t) + b.data[p * 4 + c] * t : a.data[p * 4 + c];
      max = Math.max(max, Math.abs(img.data[p * 4 + c] - want));
    }
  }
  return max;
}

/** A binding's value at x by linear interpolation of its keys (as the rig does for one parameter). */
function lerpKeys(keys: number[], values: number[], x: number): number {
  if (x <= keys[0]) return values[0];
  for (let i = 1; i < keys.length; i++) if (x <= keys[i]) return values[i - 1] + ((values[i] - values[i - 1]) * (x - keys[i - 1])) / (keys[i] - keys[i - 1]);
  return values[values.length - 1];
}

// ----------------------------------------------------------------------------- eye curves

describe('eye sprite curves', () => {
  for (const [hasClosed, hasHalf] of [
    [true, false],
    [false, true],
    [true, true],
  ] as const) {
    it(`never show the picture under the eye (closed ${hasClosed}, half ${hasHalf})`, () => {
      const c = eyeSpriteCurves(hasClosed, hasHalf);
      for (let k = 0; k <= 1000; k++) {
        const o = k / 1000;
        const aHalf = c.half ? lerpKeys(c.keys, c.half, o) : 0;
        const aClosed = c.closed ? lerpKeys(c.keys, c.closed, o) : 0;
        const hide = lerpKeys(c.keys, c.hide, o);
        const covered = 1 - (1 - aHalf) * (1 - aClosed);
        // The share of the picture UNDER the eye that shows: what neither the sprites nor the (partly hidden) mesh eye covers.
        expect((1 - covered) * hide, `EyeOpen ${o}`).toBeLessThan(1e-9);
      }
      const at = (curve: number[] | null, o: number) => (curve ? lerpKeys(c.keys, curve, o) : 0);
      if (hasClosed) {
        for (const o of [0, 0.05, 0.1, SPRITE_TUNING.closedFull]) expect(at(c.closed, o)).toBe(1);
        expect(at(c.closed, SPRITE_TUNING.closedGone)).toBe(0);
        expect(lerpKeys(c.keys, c.hide, 0)).toBe(1);
      }
      if (hasHalf) {
        for (const o of [0.3, 0.45, 0.6]) expect(at(c.half, o)).toBe(1);
        expect(lerpKeys(c.keys, c.hide, 0.45)).toBe(1);
        expect(at(c.half, 0.7)).toBe(0);
      }
      // The open eye is the mesh eye alone.
      for (const o of [0.7, 0.8, 1]) {
        expect(at(c.closed, o) + at(c.half, o) + lerpKeys(c.keys, c.hide, o)).toBe(0);
      }
    });
  }
});

// ----------------------------------------------------------------------------- mouth table

describe('mouth sprite selection', () => {
  const grid = mouthGrid();
  const table = (Object.keys(VARIANTS) as VariantId[]).filter((id) => VARIANTS[id].group === 'mouth');

  it('puts every table point on the grid and shows the closed mouth up to MouthOpen 0.15', () => {
    for (const id of table) {
      const { open, form } = VARIANTS[id].mouth!;
      expect(grid.open).toContain(open);
      expect(grid.form).toContain(form);
    }
    const winners = mouthSpriteWinners(table.map((id) => VARIANTS[id].mouth!));
    grid.open.forEach((o, i) => grid.form.forEach((_, j) => expect(winners[i][j] < 0).toBe(o <= SPRITE_TUNING.mouthClosed)));
  });

  for (const available of [['mouth_a'], ['mouth_o'], ['mouth_a', 'mouth_o'], ['mouth_a', 'mouth_i', 'mouth_u'], ['mouth_a_half', 'mouth_e'], table] as VariantId[][]) {
    it(`shows the nearest drawn mouth at every table point (drawn: ${available.join(', ')})`, () => {
      const shapes = available.map((id) => VARIANTS[id].mouth!);
      const winners = mouthSpriteWinners(shapes);
      for (const id of table) {
        const { open, form } = VARIANTS[id].mouth!;
        const w = winners[grid.open.indexOf(open)][grid.form.indexOf(form)];
        const d = (s: { open: number; form: number }) => Math.hypot(open - s.open, SPRITE_TUNING.formWeight * (form - s.form));
        const best = Math.min(...shapes.map(d));
        expect(d(shapes[w]), id).toBe(best);
        if (available.includes(id)) expect(available[w]).toBe(id);
      }
    });
  }

  it('keeps a drawn mouth opaque under the one fading in over it', () => {
    const shapes = table.map((id) => VARIANTS[id].mouth!).sort((a, b) => a.open - b.open || a.form - b.form);
    const winners = mouthSpriteWinners(shapes);
    const alpha = mouthSpriteOpacities(shapes);
    const cover = (i: number, j: number, di: number, dj: number, t: number, u: number) => {
      // Bilinear inside the cell (i, j) .. (i + di, j + dj), as the rig interpolates a 2-parameter grid.
      let rest = 1;
      for (const a of alpha) {
        const v = (a[i][j] * (1 - t) + a[i + di][j] * t) * (1 - u) + (a[i][j + dj] * (1 - t) + a[i + di][j + dj] * t) * u;
        rest *= 1 - v;
      }
      return 1 - rest;
    };
    let cells = 0;
    for (let i = 0; i + 1 < grid.open.length; i++) {
      for (let j = 0; j + 1 < grid.form.length; j++) {
        if ([winners[i][j], winners[i + 1][j], winners[i][j + 1], winners[i + 1][j + 1]].some((w) => w < 0)) continue;
        cells++;
        for (const [t, u] of [[0.5, 0], [0, 0.5], [0.5, 0.5], [0.25, 0.75], [1, 0.5]]) expect(cover(i, j, 1, 1, t, u), `cell ${i}, ${j}`).toBeCloseTo(1, 9);
      }
    }
    expect(cells).toBeGreaterThan(100);
  });
});

// ----------------------------------------------------------------------------- the model

describe('the model with drawn eyes', () => {
  const both = withSprites({ eyes_closed: closed, eyes_half: half, eyes_smile: smile });
  const only = withSprites({ eyes_closed: closed });

  it('validates, has no folds and keeps the rest pose of the model without sprites', () => {
    for (const m of [both, only]) {
      expect(m.validation.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(findFolds(m.model, m.compiled.folds)).toEqual([]);
      expect(Buffer.from(m.render().data).equals(Buffer.from(bare.render().data))).toBe(true);
    }
    const hides = both.model.bindings.filter((b) => b.id?.includes('UnderSprite')).map((b) => b.target);
    for (const eye of ['eyeL', 'eyeR']) {
      for (const name of ['white', 'ball', 'lower', 'upper']) expect(hides).toContain(`part:${eye}_${name}.opacity`);
      for (const t of hides) expect(EYE_LAYERS_UNDER_SPRITES.some((n) => t === `part:eyeL_${n}.opacity` || t === `part:eyeR_${n}.opacity`)).toBe(true);
    }
  });

  it('hides the open-eye layers while a sprite covers the eye, and only then', () => {
    const opacity = (m: { rig: Rig }, params: Record<string, number>, id: string) => {
      const pose = m.rig.pose({ params, physics: false });
      return pose.parts[id]?.visible ? pose.parts[id]!.opacity : 0;
    };
    for (const id of ['eyeR_ball', 'eyeL_upper']) {
      expect(opacity(both, { EyeLOpen: 0, EyeROpen: 0 }, id)).toBe(0);
      expect(opacity(both, { EyeLOpen: 0.45, EyeROpen: 0.45 }, id)).toBe(0);
      expect(opacity(both, { EyeLOpen: 1, EyeROpen: 1, EyeLSmile: 1, EyeRSmile: 1 }, id)).toBe(0);
      expect(opacity(both, { EyeLOpen: 0.65, EyeROpen: 0.65 }, id)).toBe(opacity(bare, { EyeLOpen: 0.65, EyeROpen: 0.65 }, id));
      expect(opacity(only, { EyeLOpen: 0.16, EyeROpen: 0.16 }, id)).toBe(opacity(bare, { EyeLOpen: 0.16, EyeROpen: 0.16 }, id));
      expect(opacity(only, { EyeLOpen: 1, EyeROpen: 1 }, id)).toBe(opacity(bare, {}, id));
    }
    // A wink hides one eye only (eyeR = the image-left eye, EyeROpen).
    expect(opacity(only, { EyeROpen: 0 }, 'eyeR_ball')).toBe(0);
    expect(opacity(only, { EyeROpen: 0 }, 'eyeL_ball')).toBe(opacity(bare, {}, 'eyeL_ball'));
  });

  it('shows the drawings at their poses, and fades between them over opaque pictures', () => {
    expect(maxDiff(both.render({ EyeLOpen: 0, EyeROpen: 0 }), eyeCore, closed)).toBeLessThanOrEqual(2);
    expect(maxDiff(both.render({ EyeLOpen: 0.45, EyeROpen: 0.45 }), eyeCore, half)).toBeLessThanOrEqual(2);
    expect(maxDiff(both.render({ EyeLSmile: 1, EyeRSmile: 1 }), eyeCore, smile)).toBeLessThanOrEqual(2);
    // Half to closed (EyeOpen 0.16, halfway through the closed sprite's fade): half of each drawing.
    expect(maxDiff(both.render({ EyeLOpen: 0.16, EyeROpen: 0.16 }), eyeCore, half, closed, 0.5)).toBeLessThanOrEqual(3);
    // Closed to the mesh eye: half of the drawing over the fully drawn mesh eye of that pose.
    const mesh = bare.render({ EyeLOpen: 0.16, EyeROpen: 0.16 });
    expect(maxDiff(only.render({ EyeLOpen: 0.16, EyeROpen: 0.16 }), eyeCore, mesh, closed, 0.5)).toBeLessThanOrEqual(3);
    // Half fading out to the open mesh eye.
    const open = bare.render({ EyeLOpen: 0.65, EyeROpen: 0.65 });
    expect(maxDiff(both.render({ EyeLOpen: 0.65, EyeROpen: 0.65 }), eyeCore, open, half, 0.5)).toBeLessThanOrEqual(3);
    // The smile fades in over whatever the eye shows.
    expect(maxDiff(both.render({ EyeLSmile: 0.49, EyeRSmile: 0.49 }), eyeCore, bare.render(), smile, 0.5)).toBeLessThanOrEqual(3);
  });
});

describe('the model with drawn mouths', () => {
  const o = withSprites({ mouth_o: mouthO });
  const ao = withSprites({ mouth_o: mouthO, mouth_a: mouthA });

  it('drops the mesh opening and keeps MouthForm on the closed mouth', () => {
    for (const m of [o, ao]) {
      expect(m.validation.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(m.model.parts.some((p) => p.id === 'mouthInner' || p.id === 'mouthTongue')).toBe(false);
      expect(m.model.bindings.find((b) => b.id === 'mouthShape')?.params).toEqual(['MouthForm']);
      expect(m.compiled.report.issues.map((i) => i.code)).toContain('avatar-mouth-drawn');
      expect(Buffer.from(m.render().data).equals(Buffer.from(bare.render().data))).toBe(true);
      expect(Buffer.from(m.render({ MouthForm: 1 }).data).equals(Buffer.from(bare.render({ MouthForm: 1 }).data))).toBe(true);
    }
    expect(bare.model.parts.some((p) => p.id === 'mouthInner')).toBe(true);
    expect(bare.model.bindings.find((b) => b.id === 'mouthShape')?.params).toEqual(['MouthOpen', 'MouthForm']);
  });

  it('shows the drawn mouth nearest on the viseme table, never together with a mesh opening', () => {
    // Only "o" drawn: it stands in for "u", "a" and every other open shape.
    for (const [open, form] of [[0.35, -1], [0.75, -1], [1, 0], [0.35, 1]]) expect(maxDiff(o.render({ MouthOpen: open, MouthForm: form }), mouthCore, mouthO), `${open}, ${form}`).toBeLessThanOrEqual(2);
    // "a" and "o" drawn: each at its own place, "u" goes to "o", "i" and "e" to "a".
    expect(maxDiff(ao.render({ MouthOpen: 1, MouthForm: 0 }), mouthCore, mouthA)).toBeLessThanOrEqual(2);
    expect(maxDiff(ao.render({ MouthOpen: 0.75, MouthForm: -1 }), mouthCore, mouthO)).toBeLessThanOrEqual(2);
    expect(maxDiff(ao.render({ MouthOpen: 0.35, MouthForm: -1 }), mouthCore, mouthO)).toBeLessThanOrEqual(2);
    expect(maxDiff(ao.render({ MouthOpen: 0.35, MouthForm: 1 }), mouthCore, mouthA)).toBeLessThanOrEqual(2);
    expect(maxDiff(ao.render({ MouthOpen: 0.6, MouthForm: 0.5 }), mouthCore, mouthA)).toBeLessThanOrEqual(2);
    // Closed at MouthOpen 0, a dissolve over the closed mouth on the way to the first drawn one.
    expect(maxDiff(ao.render({ MouthOpen: 0 }), mouthCore, source)).toBeLessThanOrEqual(2);
    expect(maxDiff(o.render({ MouthOpen: 0.175, MouthForm: -1 }), mouthCore, bare.render({ MouthForm: -1 }), mouthO, 0.5)).toBeLessThanOrEqual(3);
  });

  it('is deterministic', () => {
    const again = withSprites({ mouth_o: mouthO, mouth_a: mouthA });
    expect(formatModelJson(again.compiled.doc)).toBe(formatModelJson(ao.compiled.doc));
  });
});
