/**
 * Drawn variants, the pure parts (../variants.ts and its variants-*.ts helpers, ../features/sprites.ts),
 * on the repository's own test illustration (test/fixtures/avatar-hana.ts at half size, 256 x 320)
 * with "drawings" painted programmatically inside the edit areas (./variants-drawings.ts):
 *
 *   - requests: mask geometry (opaque outside, transparent over both grown eye regions or the mouth
 *     ellipse, soft in between), prompts and README that state the constraints, the preview;
 *   - the check: accepts a drawing (and one with recompression noise); rejects another size, changes
 *     outside the mask, a 3 px global shift (named), a zoom (named), nothing changed inside, one eye only;
 *   - sprites: cut per eye / for the mouth, recorded with fingerprints, a rejected drawing keeps the
 *     earlier sprite, removal, carry-over after a rebuild, staleness;
 *   - the model: sprites are invisible at rest, and at their pose the composite IS the drawing inside
 *     the edit area; the mouth grid picks the nearest drawn shape; everything is deterministic.
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
import { mouthGrid, mouthSpriteWinners, SPRITE_TUNING } from '../features/sprites.js';
import { buildLayers } from '../layers.js';
import { reviewPoses } from '../poses.js';
import { parseAvatarSpec } from '../spec.js';
import { avatarVariantRequests, buildAvatarSprites, checkAvatarVariant } from '../index.js';
import { VARIANT_IDS, type AvatarSpec, type LayersMeta } from '../types.js';
import {
  carrySprites,
  cutVariantSprites,
  hashImage,
  isVariantId,
  normalizeVariantIds,
  RECOMMENDED_VARIANT_IDS,
  removeSprites,
  spriteLayerId,
  spritesMeta,
  variantEditAreas,
  variantEditable,
  variantInputsHash,
  variantMaskImage,
  variantPreview,
  variantReadme,
  variantRequests,
  variantStatuses,
  VARIANT_TUNING,
  VARIANTS,
} from '../variants.js';
import { addNoise, addPatch, copyImage, drawClosedEyes, drawOpenMouth, shiftImage, zoomImage } from './variants-drawings.js';

const hana = hanaIllustration(0.5);
const spec = parseAvatarSpec(hana.doc).spec as AvatarSpec;
const W = hana.width;
const H = hana.height;
const source = hana.image;
/** The skeleton plus the sprites: the base is all there is under a sprite. */
const FEATURES = AVATAR_FEATURES.filter((f) => ['head', 'body', 'sprites'].includes(f.id));
const layers = buildLayers(spec, source, undefined, FEATURES);
const closedEyes = drawClosedEyes(source, spec);
const openMouth = drawOpenMouth(source, spec);
const eyesEdit = variantEditAreas(spec, 'eyes');
const mouthEdit = variantEditAreas(spec, 'mouth');

/** Pixels of a full-size coverage at or above / at or below a level. */
function where(cover: { data: Float32Array }, test: (v: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < cover.data.length; i++) if (test(cover.data[i])) out.push(i);
  return out;
}

/** The model of the layers + sprites, its rig and its textures. */
function built(meta: LayersMeta, images: Record<string, ImageRGBA>) {
  const compiled = compileModel(spec, meta, FEATURES);
  const validation = validateModel(compiled.doc);
  const model = validation.model as Model;
  const textures = Object.fromEntries(meta.layers.map((l) => [l.id, images[l.file]]));
  const rig = new Rig(model);
  const render = (params: Record<string, number> = {}) => renderImage(buildRenderList(rig, rig.pose({ params, physics: false })), textures, { supersample: 1 });
  return { compiled, validation, model, rig, render };
}

/** Largest channel difference over a list of pixels. */
function maxDiff(a: ImageRGBA, b: ImageRGBA, pixels: number[]): number {
  let max = 0;
  for (const p of pixels) for (let c = 0; c < 4; c++) max = Math.max(max, Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]));
  return max;
}

// ----------------------------------------------------------------------------- table and areas

describe('the variant table', () => {
  it('describes every variant id, recommends closed eyes and the "a" mouth, and places mouths on the viseme table', () => {
    expect(Object.keys(VARIANTS)).toEqual([...VARIANT_IDS]);
    expect(RECOMMENDED_VARIANT_IDS).toEqual(['eyes_closed', 'mouth_a']);
    expect(VARIANTS.mouth_a.mouth).toEqual({ open: 1, form: 0 });
    expect(VARIANTS.mouth_a_half.mouth).toEqual({ open: 0.5, form: 0 });
    expect(VARIANTS.mouth_i.mouth).toEqual({ open: 0.35, form: 1 });
    expect(VARIANTS.mouth_u.mouth).toEqual({ open: 0.35, form: -1 });
    expect(VARIANTS.mouth_e.mouth).toEqual({ open: 0.6, form: 0.5 });
    expect(VARIANTS.mouth_o.mouth).toEqual({ open: 0.75, form: -1 });
    for (const id of VARIANT_IDS) expect(VARIANTS[id].group === 'eyes' ? VARIANTS[id].eye : VARIANTS[id].mouth).toBeTruthy();
    expect(isVariantId('eyes_closed')).toBe(true);
    expect(isVariantId('eyes_open')).toBe(false);
    expect(normalizeVariantIds()).toEqual(['eyes_closed', 'mouth_a']);
    expect(normalizeVariantIds(['mouth_o', 'eyes_half', 'mouth_o'])).toEqual(['eyes_half', 'mouth_o']);
  });
});

describe('edit areas and masks', () => {
  it('cover both eye regions, grown and feathered, and nothing else', () => {
    expect(eyesEdit.areas.map((a) => a.key)).toEqual(['imageLeft', 'imageRight']);
    const editable = variantEditable(eyesEdit);
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const area = eyesEdit.areas.find((a) => a.key === side)!;
      expect(area.grow).toBeGreaterThanOrEqual(VARIANT_TUNING.minGrow);
      expect(area.feather).toBeGreaterThanOrEqual(VARIANT_TUNING.minFeather);
      // Every vertex of the region (and of the opening) lies in the fully editable core.
      const pts = [...spec.face.eyes[side].region, ...spec.face.eyes[side].opening];
      for (let i = 0; i < pts.length; i += 2) expect(editable.data[Math.floor(pts[i + 1]) * W + Math.floor(pts[i])]).toBeGreaterThan(0.999);
    }
    // The mouth, the nose and the image corners stay.
    const at = (x: number, y: number) => editable.data[Math.floor(y) * W + Math.floor(x)];
    expect(at(spec.face.mouth.area.center[0], spec.face.mouth.area.center[1])).toBe(0);
    expect(at(spec.face.nose[0], spec.face.nose[1])).toBe(0);
    expect(at(0, 0)).toBe(0);
    // Soft edge: some pixels in between.
    expect(where(editable, (v) => v > 0.05 && v < 0.95).length).toBeGreaterThan(20);
  });

  it('cover the mouth ellipse for mouth variants', () => {
    const editable = variantEditable(mouthEdit);
    const { center, radius } = spec.face.mouth.area;
    const at = (x: number, y: number) => editable.data[Math.floor(y) * W + Math.floor(x)];
    expect(at(center[0], center[1])).toBe(1);
    expect(at(center[0] + radius[0] * 0.95, center[1])).toBe(1);
    expect(at(center[0], center[1] - radius[1] * 0.95)).toBe(1);
    expect(at(center[0] + radius[0] + 8, center[1])).toBe(0);
    expect(at(spec.face.chin[0], spec.face.chin[1])).toBe(0);
  });

  it('write masks: opaque black where the picture stays, transparent white where it may change', () => {
    const mask = variantMaskImage(eyesEdit);
    const editable = variantEditable(eyesEdit);
    expect([mask.width, mask.height]).toEqual([W, H]);
    for (let i = 0; i < editable.data.length; i += 97) {
      const e = editable.data[i];
      const a = mask.data[i * 4 + 3];
      expect(a).toBe(255 - Math.round(e * 255));
      expect(mask.data[i * 4]).toBe(Math.round(e * 255));
    }
    expect(mask.data[3]).toBe(255);
  });

  it('fingerprint the landmarks they come from', () => {
    const moved = parseAvatarSpec({ ...hana.doc, face: { ...hana.doc.face, mouth: { ...hana.doc.face.mouth, area: { ...hana.doc.face.mouth.area, radius: [30, 12] } } } }).spec as AvatarSpec;
    expect(variantInputsHash(moved, 'mouth')).not.toBe(variantInputsHash(spec, 'mouth'));
    expect(variantInputsHash(moved, 'eyes')).toBe(variantInputsHash(spec, 'eyes'));
    expect(variantInputsHash(spec, 'eyes')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashImage(source)).toBe(hashImage(copyImage(source)));
    expect(hashImage(closedEyes)).not.toBe(hashImage(source));
  });
});

// ----------------------------------------------------------------------------- requests

describe('requests', () => {
  it('give one mask, prompt and file per variant (recommended by default), masks shared within a group', () => {
    const def = avatarVariantRequests(spec, layers.meta, source);
    expect(def.map((r) => r.id)).toEqual(['eyes_closed', 'mouth_a']);
    const all = variantRequests(spec, source, [...VARIANT_IDS]);
    expect(all.requests.map((r) => r.id)).toEqual([...VARIANT_IDS]);
    expect(all.edits.map((e) => e.group)).toEqual(['eyes', 'mouth']);
    expect(all.transparent).toBe(true);
    const closed = all.requests[0];
    expect(closed).toMatchObject({ id: 'eyes_closed', group: 'eyes', file: 'variants/eyes_closed.png', maskFile: 'variant-requests/eyes_closed.mask.png', promptFile: 'variant-requests/eyes_closed.prompt.txt', recommended: true });
    expect(all.requests[1].mask).toBe(closed.mask);
    expect(all.requests.find((r) => r.id === 'mouth_o')!.mask).not.toBe(closed.mask);
    expect(closed.areas.map((a) => a.key)).toEqual(['imageLeft', 'imageRight']);
  });

  it('write prompts that say what to draw, where, and the hard constraints', () => {
    const { requests } = variantRequests(spec, source, ['eyes_closed', 'mouth_a', 'mouth_u']);
    for (const r of requests) {
      expect(r.prompt).toContain(`${W}x${H} px`);
      expect(r.prompt).toContain(r.maskFile);
      expect(r.prompt).toContain('no crop, zoom, shift, rotation or padding');
      expect(r.prompt).toContain('Every pixel outside the transparent area of the mask stays identical');
      expect(r.prompt).toContain('Nothing new');
      expect(r.prompt).toContain('same art style');
      expect(r.prompt).toContain('transparent background');
      expect(r.prompt).toContain(`at ${r.file}`);
      expect(r.prompt).toContain(VARIANTS[r.id].draw);
    }
    expect(requests[0].prompt).toContain('both eyes gently closed');
    expect(requests[0].prompt).toContain('the eye on the image left (x ');
    expect(requests[1].prompt).toContain('the ellipse around the mouth centred at');
    expect(requests[2].prompt).toContain('"u"');
  });

  it('write a README with the files, the mask convention, the steps and the rules of the check', () => {
    const text = variantReadme(spec, [{ id: 'eyes_closed', recommended: true }, { id: 'mouth_o', recommended: false }], { project: 'projects/hana' });
    for (const s of [
      '| `eyes_closed` (recommended) |',
      '`mouth_o.mask.png`',
      '`variants/mouth_o.png`',
      'OPAQUE black pixels must stay exactly as they are',
      'rev2d avatar variants import projects/hana',
      'rev2d avatar poses projects/hana',
      'rev2d avatar variants status projects/hana',
      `exactly ${W}x${H} px`,
      'the mean difference must not exceed 2',
      'shifted or zoomed',
      'preview.png',
    ]) {
      expect(text).toContain(s);
    }
  });

  it('draw a preview of the editable areas', () => {
    const preview = variantPreview(source, [eyesEdit, mouthEdit]);
    expect(preview.width).toBeGreaterThan(300);
    expect(preview.height).toBeGreaterThan(200);
    // The tint makes the eye areas yellower than the illustration: some pixel is strongly yellow.
    let yellow = 0;
    for (let i = 0; i < preview.data.length; i += 4) if (preview.data[i] > 200 && preview.data[i + 1] > 180 && preview.data[i + 2] < 140) yellow++;
    expect(yellow).toBeGreaterThan(100);
  });
});

// ----------------------------------------------------------------------------- the check

describe('the check', () => {
  it('accepts a drawing that changes only the eyes, with numbers', () => {
    const c = checkAvatarVariant(spec, layers.meta, source, 'eyes_closed', closedEyes);
    expect(c).toMatchObject({ id: 'eyes_closed', ok: true, group: 'eyes', tolerance: 2, size: [W, H], shift: null, scale: null, badBounds: null });
    expect(c.outsideDiff).toBe(0);
    expect(c.insideChanged).toBeGreaterThan(0.1);
    expect(c.areas.map((a) => a.key)).toEqual(['imageLeft', 'imageRight']);
    for (const a of c.areas) expect(a.changed).toBeGreaterThan(0.1);
    expect(c.reason).toBeUndefined();
    expect(c.drawingHash).toBe(hashImage(closedEyes));
    expect(checkAvatarVariant(spec, layers.meta, source, 'mouth_a', openMouth).ok).toBe(true);
  });

  it('tolerates recompression noise', () => {
    const noisy = addNoise(closedEyes, 2, 7);
    const c = checkAvatarVariant(spec, layers.meta, source, 'eyes_closed', noisy);
    expect(c.ok).toBe(true);
    expect(c.outsideDiff).toBeGreaterThan(0.3);
    expect(c.outsideDiff).toBeLessThanOrEqual(2);
    expect(c.shift).toBeNull();
  });

  it('rejects another size, saying how to fix it', () => {
    const small: ImageRGBA = { width: W / 2, height: H / 2, data: new Uint8ClampedArray((W / 2) * (H / 2) * 4) };
    const c = checkAvatarVariant(spec, layers.meta, source, 'eyes_closed', small);
    expect(c.ok).toBe(false);
    expect(c.reason).toBe(`the drawing is ${W / 2}x${H / 2} px, source.png is ${W}x${H} px`);
    expect(c.hint).toContain(`exactly ${W}x${H} px`);
    expect(c.size).toEqual([W / 2, H / 2]);
    const wide: ImageRGBA = { width: W, height: W, data: new Uint8ClampedArray(W * W * 4) };
    expect(checkAvatarVariant(spec, layers.meta, source, 'eyes_closed', wide).hint).toContain('no crop, no padding');
  });

  it('rejects changes outside the mask, with where they are', () => {
    const c = checkAvatarVariant(spec, layers.meta, source, 'eyes_closed', addPatch(closedEyes, 100, 230, 60, 40));
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/^the drawing changes the picture outside the editable area: mean difference [\d.]+ \(limit 2\)/);
    expect(c.reason).toContain('most of them in x 100..160, y 230..270');
    expect(c.hint).toContain('Change only the transparent area of the mask');
    expect(c.hint).toContain('variant-requests/eyes_closed.mask.png');
    // A small change that keeps the mean low is still caught by the share of badly changed pixels.
    const small = checkAvatarVariant(spec, layers.meta, source, 'eyes_closed', addPatch(closedEyes, 120, 240, 20, 20));
    expect(small.outsideDiff).toBeLessThanOrEqual(2);
    expect(small.ok).toBe(false);
    expect(small.reason).toContain('something was added, removed or repainted there');
  });

  it('rejects a 3 px global shift and names it', () => {
    const c = checkAvatarVariant(spec, layers.meta, source, 'eyes_closed', shiftImage(closedEyes, 3, 0));
    expect(c.ok).toBe(false);
    expect(c.shift).toEqual([3, 0]);
    expect(c.reason).toMatch(/^the whole drawing is shifted by 3 px to the right against source\.png/);
    expect(c.hint).toContain('no shift, crop, zoom or padding');
    expect(c.hint).toContain('move the drawing back by 3 px to the left');
    const diagonal = checkAvatarVariant(spec, layers.meta, source, 'mouth_a', shiftImage(openMouth, -2, 3));
    expect(diagonal.shift).toEqual([-2, 3]);
    expect(diagonal.reason).toContain('2 px to the left and 3 px down');
  });

  it('rejects a zoomed drawing and names the factor', () => {
    const c = checkAvatarVariant(spec, layers.meta, source, 'eyes_closed', zoomImage(closedEyes, 1.03));
    expect(c.ok).toBe(false);
    expect(c.scale).not.toBeNull();
    expect(Math.abs(c.scale! - 1.03)).toBeLessThan(0.006);
    expect(c.reason).toMatch(/^the drawing is zoomed in by [\d.]+% against source\.png/);
    expect(c.hint).toContain('no zoom');
  });

  it('rejects a drawing that changes nothing inside, or only one eye', () => {
    const same = checkAvatarVariant(spec, layers.meta, source, 'eyes_closed', copyImage(source));
    expect(same.ok).toBe(false);
    expect(same.reason).toMatch(/^nothing changed inside the editable area: 0% of it differs from source\.png \(at least 2% must\)/);
    expect(same.hint).toContain('both eyes gently closed');
    const one = checkAvatarVariant(spec, layers.meta, source, 'eyes_closed', drawClosedEyes(source, spec, ['imageLeft']));
    expect(one.ok).toBe(false);
    expect(one.reason).toMatch(/^only the eye on the image left \([\d.]+% of its area\) changed; the eye on the image right did not/);
    expect(one.hint).toContain('Redraw BOTH eyes');
    // An eye drawing does not count as a mouth drawing.
    expect(checkAvatarVariant(spec, layers.meta, source, 'mouth_a', closedEyes).ok).toBe(false);
  });

  it('notes a filled background without rejecting the drawing', () => {
    const filled = copyImage(closedEyes);
    for (let i = 0; i < filled.data.length; i += 4) if (filled.data[i + 3] === 0) filled.data.set([255, 255, 255, 255], i);
    const c = checkAvatarVariant(spec, layers.meta, source, 'eyes_closed', filled);
    expect(c.ok).toBe(true);
    expect(c.backgroundFilled).toBe(1);
    expect(c.notes[0]).toContain('fills in the transparent background');
  });

  it('follows build.variantTolerance', () => {
    const strict = parseAvatarSpec({ ...hana.doc, build: { variantTolerance: 0.2 } }).spec as AvatarSpec;
    const c = checkAvatarVariant(strict, layers.meta, source, 'eyes_closed', addNoise(closedEyes, 2, 7));
    expect(c.ok).toBe(false);
    expect(c.tolerance).toBe(0.2);
    expect(c.hint).toContain('"build.variantTolerance" in avatar.json (now 0.2)');
  });
});

// ----------------------------------------------------------------------------- sprites

describe('sprites', () => {
  const both = buildAvatarSprites(spec, layers.meta, source, { eyes_closed: closedEyes, mouth_a: openMouth });

  it('are cut per eye and for the mouth, and recorded with fingerprints', () => {
    expect(both.accepted).toEqual(['eyes_closed', 'mouth_a']);
    expect(both.rejected).toEqual([]);
    expect(both.meta.variants).toEqual(['eyes_closed', 'mouth_a']);
    const ids = ['eyes_closed_imageLeft', 'eyes_closed_imageRight', 'mouth_a_mouth'].map((s) => `sprite_${s}`);
    expect(both.meta.layers.slice(-3).map((l) => l.id)).toEqual(ids);
    expect(Object.keys(both.images)).toEqual(ids.map((id) => `textures/${id}.png`));
    expect(both.meta.layers.slice(0, -3)).toEqual(layers.meta.layers);
    const sm = spritesMeta(both.meta)!;
    expect(sm.sprites.map((s) => [s.id, s.group, s.drawingHash, s.inputsHash])).toEqual([
      ['eyes_closed', 'eyes', hashImage(closedEyes), variantInputsHash(spec, 'eyes')],
      ['mouth_a', 'mouth', hashImage(openMouth), variantInputsHash(spec, 'mouth')],
    ]);
    expect(sm.sprites[0].check).toMatchObject({ outsideDiff: 0, tolerance: 2 });
    // A sprite is the drawing with the area's coverage as alpha, placed at its rect.
    const left = both.meta.layers.find((l) => l.id === spriteLayerId('eyes_closed', 'imageLeft'))!;
    const img = both.images[left.file];
    expect([img.width, img.height]).toEqual([left.rect[2], left.rect[3]]);
    const editable = variantEditable(eyesEdit);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const p = (y + left.rect[1]) * W + x + left.rect[0];
        const a = img.data[(y * img.width + x) * 4 + 3];
        if (editable.data[p] >= 0.999 && closedEyes.data[p * 4 + 3] === 255) {
          expect(a).toBe(255);
          for (let c = 0; c < 3; c++) expect(img.data[(y * img.width + x) * 4 + c]).toBe(closedEyes.data[p * 4 + c]);
        }
        if (editable.data[p] === 0) expect(a).toBe(0);
      }
    }
  });

  it('keep an earlier sprite when a new drawing is rejected, and replace it when one is accepted', () => {
    const again = buildAvatarSprites(spec, both.meta, source, { eyes_closed: shiftImage(closedEyes, 3, 0) });
    expect(again.rejected).toEqual(['eyes_closed']);
    expect(again.kept).toEqual(['eyes_closed']);
    expect(again.images).toEqual({});
    expect(again.meta.variants).toEqual(['eyes_closed', 'mouth_a']);
    const sm = spritesMeta(again.meta)!;
    expect(sm.sprites[0].drawingHash).toBe(hashImage(closedEyes));
    expect(sm.rejected).toEqual([expect.objectContaining({ id: 'eyes_closed', drawingHash: hashImage(shiftImage(closedEyes, 3, 0)), reason: expect.stringContaining('shifted by 3 px') })]);
    const better = drawClosedEyes(addNoise(source, 1, 3), spec);
    const replaced = buildAvatarSprites(spec, again.meta, source, { eyes_closed: better });
    expect(replaced.accepted).toEqual(['eyes_closed']);
    expect(spritesMeta(replaced.meta)!.rejected).toEqual([]);
    expect(spritesMeta(replaced.meta)!.sprites[0].drawingHash).toBe(hashImage(better));
    expect(replaced.meta.layers.filter((l) => l.id.startsWith('sprite_'))).toHaveLength(3);
  });

  it('are removed on request, and carried over by a rebuild of the layers', () => {
    const removed = removeSprites(both.meta, ['mouth_a']);
    expect(removed.removed.map((l) => l.file)).toEqual(['textures/sprite_mouth_a_mouth.png']);
    expect(removed.meta.variants).toEqual(['eyes_closed']);
    expect(removed.meta.layers.some((l) => l.id === 'sprite_mouth_a_mouth')).toBe(false);
    const none = removeSprites(removed.meta, ['eyes_closed']).meta;
    expect(none.variants).toEqual([]);
    expect(none.sprites).toBeUndefined();
    expect(none.layers).toEqual(layers.meta.layers);

    const rebuilt = buildLayers(spec, source, both.meta, FEATURES);
    expect(rebuilt.meta.variants).toEqual([]);
    const carried = carrySprites(both.meta, rebuilt.meta, spec);
    expect(carried.meta).toEqual(both.meta);
    expect(carried.stale).toEqual([]);
    const gone = carrySprites(both.meta, rebuilt.meta, spec, (file) => !file.includes('mouth'));
    expect(gone.missing).toEqual(['mouth_a']);
    expect(gone.meta.variants).toEqual(['eyes_closed']);
    const moved = parseAvatarSpec({ ...hana.doc, face: { ...hana.doc.face, mouth: { ...hana.doc.face.mouth, area: { ...hana.doc.face.mouth.area, radius: [30, 12] } } } }).spec as AvatarSpec;
    expect(carrySprites(both.meta, rebuilt.meta, moved).stale).toEqual(['mouth_a']);
  });

  it('hold what lies under the layers drawn above them, so the composite is the drawing', () => {
    // Above the eyes: a half-transparent band and an opaque band over the image-left eye; a flat base.
    const left = eyesEdit.areas[0];
    const rect = { ...left.rect };
    const above: ImageRGBA = { width: rect.width, height: rect.height, data: new Uint8ClampedArray(rect.width * rect.height * 4) };
    const band = (y0: number, y1: number, rgba: number[]) => {
      for (let y = y0; y < y1; y++) for (let x = 0; x < rect.width; x++) above.data.set(rgba, (y * rect.width + x) * 4);
    };
    const mid = Math.floor(rect.height / 2);
    band(mid - 6, mid - 2, [200, 40, 40, 128]);
    band(mid + 2, mid + 6, [40, 40, 200, 255]);
    const base: ImageRGBA = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(128) };
    // A realistic drawing has the layers above in front of what it redraws.
    const drawing = copyImage(closedEyes);
    const over = (dst: Uint8ClampedArray, o: number, src: Uint8ClampedArray, i: number) => {
      const a = src[i + 3] / 255;
      for (let c = 0; c < 3; c++) dst[o + c] = Math.round(src[i + c] * a + dst[o + c] * (1 - a));
    };
    for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) over(drawing.data, ((y + rect.y) * W + x + rect.x) * 4, above.data, (y * rect.width + x) * 4);
    const cut = cutVariantSprites('eyes_closed', drawing, eyesEdit, { rect, above, base });
    const sprite = cut.images['textures/sprite_eyes_closed_imageLeft.png'];
    const [sx, sy] = cut.layers[0].rect;
    let checked = 0;
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const gx = x + rect.x;
        const gy = y + rect.y;
        if (left.mask.data[y * rect.width + x] < 0.999 || closedEyes.data[(gy * W + gx) * 4 + 3] < 255) continue;
        const si = ((gy - sy) * sprite.width + gx - sx) * 4;
        const a = above.data[(y * rect.width + x) * 4 + 3];
        // Under the half-transparent band: the redrawn eye itself; under the opaque band: the base.
        const want = a === 255 ? [128, 128, 128] : [0, 1, 2].map((c) => closedEyes.data[(gy * W + gx) * 4 + c]);
        for (let c = 0; c < 3; c++) expect(Math.abs(sprite.data[si + c] - want[c])).toBeLessThanOrEqual(a === 128 ? 2 : 0);
        // And the band drawn over the sprite gives the drawing back.
        const composite = new Uint8ClampedArray(sprite.data.subarray(si, si + 4));
        over(composite, 0, above.data, (y * rect.width + x) * 4);
        for (let c = 0; c < 3; c++) expect(Math.abs(composite[c] - drawing.data[(gy * W + gx) * 4 + c])).toBeLessThanOrEqual(a === 255 ? 0 : 2);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('report a status per variant', () => {
    const again = buildAvatarSprites(spec, both.meta, source, { mouth_a: copyImage(source) });
    const rows = variantStatuses(spec, again.meta, {
      eyes_closed: { requested: true, drawing: { hash: hashImage(closedEyes) } },
      eyes_half: { requested: true, drawing: null },
      mouth_a: { requested: true, drawing: { hash: hashImage(source) } },
      mouth_o: { requested: false, drawing: { hash: 'ffff' } },
    });
    const state = Object.fromEntries(rows.map((r) => [r.id, r.state]));
    expect(state).toEqual({ eyes_closed: 'accepted', eyes_half: 'requested', eyes_smile: 'missing', mouth_a: 'rejected', mouth_a_half: 'missing', mouth_i: 'missing', mouth_u: 'missing', mouth_e: 'missing', mouth_o: 'drawn' });
    const mouth = rows.find((r) => r.id === 'mouth_a')!;
    expect(mouth.sprite).toBe(true);
    expect(mouth.rejection?.reason).toContain('nothing changed inside');
    // A changed drawing or changed landmarks make a sprite stale.
    const changed = variantStatuses(spec, both.meta, { eyes_closed: { requested: true, drawing: { hash: 'changed' } } });
    expect(changed[0]).toMatchObject({ state: 'stale', stale: ['variants/eyes_closed.png changed since it was imported'] });
    const moved = parseAvatarSpec({ ...hana.doc, face: { ...hana.doc.face, eyes: { ...hana.doc.face.eyes, imageLeft: { ...hana.doc.face.eyes.imageLeft, region: hana.doc.face.eyes.imageLeft.region.map((v: number) => v + 1) } } } }).spec as AvatarSpec;
    expect(variantStatuses(moved, both.meta, { eyes_closed: { requested: true, drawing: { hash: hashImage(closedEyes) } } })[0].stale).toEqual(['the eye regions changed since the sprites were cut']);
    expect(variantStatuses(spec, both.meta, {})[0].stale).toEqual(['variants/eyes_closed.png is gone (import again to remove the sprite)']);
  });

  it('are deterministic', () => {
    const again = buildAvatarSprites(spec, layers.meta, source, { eyes_closed: closedEyes, mouth_a: openMouth });
    expect(formatModelJson(again.meta)).toBe(formatModelJson(both.meta));
    for (const [file, img] of Object.entries(again.images)) expect(Buffer.from(img.data).equals(Buffer.from(both.images[file].data))).toBe(true);
  });
});

// ----------------------------------------------------------------------------- the model

describe('sprites in the model', () => {
  const both = buildAvatarSprites(spec, layers.meta, source, { eyes_closed: closedEyes, mouth_a: openMouth, mouth_o: drawOpenMouth(source, spec, 0.4) });
  const images = { ...layers.images, ...both.images };
  const m = built(both.meta, images);
  const bare = built(layers.meta, layers.images);

  it('validate, stay invisible at rest and add only their own parts and bindings', () => {
    expect(m.validation.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    const parts = m.model.parts.filter((p) => p.id.startsWith('sprite_'));
    expect(parts.map((p) => p.id)).toEqual(['sprite_eyes_closed_imageLeft', 'sprite_eyes_closed_imageRight', 'sprite_mouth_o_mouth', 'sprite_mouth_a_mouth']);
    for (const p of parts) expect(p).toMatchObject({ parent: 'avatarWarp', opacity: 0 });
    expect(m.model.bindings.filter((b) => b.target.startsWith('part:sprite_')).map((b) => [b.target, b.params])).toEqual([
      ['part:sprite_eyes_closed_imageLeft.opacity', ['EyeROpen']],
      ['part:sprite_eyes_closed_imageRight.opacity', ['EyeLOpen']],
      ['part:sprite_mouth_o_mouth.opacity', ['MouthOpen', 'MouthForm']],
      ['part:sprite_mouth_a_mouth.opacity', ['MouthOpen', 'MouthForm']],
    ]);
    expect(Buffer.from(m.render().data).equals(Buffer.from(bare.render().data))).toBe(true);
    expect(m.compiled.report.stats.sprites).toBe(3);
  });

  it('show exactly the drawing inside the edit area at their pose', () => {
    const closed = m.render({ EyeLOpen: 0, EyeROpen: 0 });
    const core = where(variantEditable(eyesEdit), (v) => v >= 0.999);
    expect(core.length).toBeGreaterThan(500);
    expect(maxDiff(closed, closedEyes, core)).toBeLessThanOrEqual(2);
    // The rest of the picture is untouched: the ring outside the soft edge equals the illustration.
    const outside = where(variantEditable(eyesEdit), (v) => v === 0);
    expect(maxDiff(closed, source, outside)).toBeLessThanOrEqual(2);
    const open = m.render({ MouthOpen: 1, MouthForm: 0 });
    const mouthCore = where(variantEditable(mouthEdit), (v) => v >= 0.999);
    expect(maxDiff(open, openMouth, mouthCore)).toBeLessThanOrEqual(2);
    // Half open is still the illustration's eye (no half sprite): nothing of the closed sprite shows.
    expect(maxDiff(m.render({ EyeLOpen: 0.5, EyeROpen: 0.5 }), source, core)).toBeLessThanOrEqual(2);
  });

  it('pick the nearest drawn mouth for every point of the MouthOpen x MouthForm grid', () => {
    const shapes = [VARIANTS.mouth_o.mouth!, VARIANTS.mouth_a.mouth!];
    const winners = mouthSpriteWinners(shapes);
    const grid = mouthGrid();
    const at = (o: number, f: number) => winners[grid.open.indexOf(o)][grid.form.indexOf(f)];
    expect(at(0, 0)).toBe(-1);
    expect(at(0, -1)).toBe(-1);
    expect(at(SPRITE_TUNING.mouthClosed, 1)).toBe(-1);
    expect(at(1, 0)).toBe(1);
    expect(at(0.8, -1)).toBe(0);
    expect(at(1, 1)).toBe(1);
    // With only "o" drawn, it stands in for "a" and for everything else that is open.
    expect(mouthSpriteWinners([VARIANTS.mouth_o.mouth!])[grid.open.indexOf(1)][grid.form.indexOf(0)]).toBe(0);
    const o = m.render({ MouthOpen: 0.8, MouthForm: -1 });
    const mouthCore = where(variantEditable(mouthEdit), (v) => v >= 0.999);
    expect(maxDiff(o, drawOpenMouth(source, spec, 0.4), mouthCore)).toBeLessThanOrEqual(2);
  });

  it('show a half and a smiling eye at their own parameters', () => {
    // Distinct eye drawings: the eye areas painted lighter (half) and darker (smile).
    const half = copyImage(source);
    const smileDrawing = copyImage(source);
    for (const [img, shade] of [[half, 40], [smileDrawing, -40]] as const) {
      const editable = variantEditable(eyesEdit);
      for (let p = 0; p < W * H; p++) {
        if (editable.data[p] < 0.999) continue;
        for (let c = 0; c < 3; c++) img.data[p * 4 + c] = source.data[p * 4 + c] + shade;
      }
    }
    const s = buildAvatarSprites(spec, layers.meta, source, { eyes_closed: closedEyes, eyes_half: half, eyes_smile: smileDrawing });
    expect(s.accepted).toEqual(['eyes_closed', 'eyes_half', 'eyes_smile']);
    const mm = built(s.meta, { ...layers.images, ...s.images });
    expect(mm.validation.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(mm.model.parameters.map((p) => p.id)).toEqual(expect.arrayContaining(['EyeLSmile', 'EyeRSmile']));
    const core = where(variantEditable(eyesEdit), (v) => v >= 0.999);
    expect(maxDiff(mm.render({ EyeLOpen: 0.45, EyeROpen: 0.45 }), half, core)).toBeLessThanOrEqual(2);
    expect(maxDiff(mm.render({ EyeLOpen: 0, EyeROpen: 0 }), closedEyes, core)).toBeLessThanOrEqual(2);
    expect(maxDiff(mm.render({ EyeLSmile: 1, EyeRSmile: 1 }), smileDrawing, core)).toBeLessThanOrEqual(2);
    expect(maxDiff(mm.render(), source, core)).toBeLessThanOrEqual(2);
    expect(reviewPoses(spec, s.meta, FEATURES).map((p) => p.id)).toContain('sprite_eyes_smile');
  });

  it('compile without sprites metadata, or with sprite layers missing from the layer list', () => {
    expect(built(layers.meta, layers.images).model.parts.some((p) => p.id.startsWith('sprite_'))).toBe(false);
    const partial: LayersMeta = { ...both.meta, layers: both.meta.layers.filter((l) => l.id !== 'sprite_eyes_closed_imageLeft') };
    const doc = compileModel(spec, partial, FEATURES).doc as { parts: Array<{ id: string }> };
    expect(doc.parts.map((p) => p.id).filter((id) => id.startsWith('sprite_'))).toEqual(['sprite_eyes_closed_imageRight', 'sprite_mouth_o_mouth', 'sprite_mouth_a_mouth']);
  });
});
