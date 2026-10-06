import { describe, expect, it } from 'vitest';
import { cloneImage, createImage } from '../../../render/image.js';
import {
  alphaBounds,
  applyMask,
  compositeOver,
  cropRect,
  cutLayer,
  downscaleArea,
  downscaleMask,
  pasteImage,
  resizeArea,
  resizeBilinear,
  resizeMaskArea,
  resizeMaskBilinear,
  tintMask,
  upscaleBilinear,
  upscaleMask,
} from '../compose.js';
import { featherMask } from '../distance.js';
import { extendEdges, inpaint } from '../inpaint.js';
import { createMask, maskArea } from '../mask.js';
import { mulberry32 } from '../random.js';
import { ellipseMask, polygonMask } from '../raster.js';
import { at, imageFrom, px } from './helpers.js';

describe('applyMask', () => {
  const img = imageFrom(4, 1, (x) => [10 * x, 20, 30, [255, 255, 128, 0][x]]);
  const mask = createMask(4, 1);
  mask.data.set([1, 0.5, 0.5, 1]);

  it('multiplies the alpha by the mask and keeps the colours', () => {
    const out = applyMask(img, mask);
    expect(px(out, 0, 0)).toEqual([0, 20, 30, 255]);
    expect(px(out, 1, 0)).toEqual([10, 20, 30, 128]);
    expect(px(out, 2, 0)).toEqual([20, 20, 30, 64]);
    expect(px(out, 3, 0)).toEqual([30, 20, 30, 0]);
    expect(px(img, 1, 0)[3]).toBe(255);
  });

  it('can replace the alpha instead', () => {
    const out = applyMask(img, mask, 'replace');
    expect([0, 1, 2, 3].map((x) => px(out, x, 0)[3])).toEqual([255, 128, 128, 255]);
    expect(() => applyMask(img, createMask(2, 2))).toThrow(/applyMask: sizes differ/);
  });
});

describe('crop, paste, composite', () => {
  const img = imageFrom(6, 4, (x, y) => [x * 40, y * 60, 7]);

  it('crops a rectangle with transparency outside the image', () => {
    const c = cropRect(img, { x: 4, y: 2, width: 4, height: 3 });
    expect(c.width).toBe(4);
    expect(c.height).toBe(3);
    expect(px(c, 0, 0)).toEqual([160, 120, 7, 255]);
    expect(px(c, 1, 1)).toEqual([200, 180, 7, 255]);
    expect(px(c, 2, 0)).toEqual([0, 0, 0, 0]);
    expect(px(c, 0, 2)).toEqual([0, 0, 0, 0]);
  });

  it('pastes by replacing pixels, alpha included, clipped to the destination', () => {
    const dst = createImage(4, 4, [1, 0, 0, 1]);
    const src = imageFrom(2, 2, (x, y) => [50, 60, 70, x + y === 0 ? 0 : 200]);
    pasteImage(dst, src, 3, 3);
    expect(px(dst, 3, 3)).toEqual([50, 60, 70, 0]);
    expect(px(dst, 2, 2)).toEqual([255, 0, 0, 255]);
    pasteImage(dst, src, -1, -1);
    expect(px(dst, 0, 0)).toEqual([50, 60, 70, 200]);
    pasteImage(dst, src, 10, 10);
    expect(px(dst, 3, 2)).toEqual([255, 0, 0, 255]);
  });

  it('crop then paste restores the pixels', () => {
    const dst = createImage(6, 4);
    pasteImage(dst, cropRect(img, { x: 0, y: 0, width: 6, height: 4 }));
    expect(Array.from(dst.data)).toEqual(Array.from(img.data));
  });

  it('composites source-over with straight alpha and an opacity', () => {
    const dst = createImage(2, 1, [0, 0, 1, 1]);
    const src = imageFrom(2, 1, (x) => [255, 0, 0, x ? 255 : 128]);
    compositeOver(dst, src);
    expect(px(dst, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(px(dst, 0, 0)).toEqual([128, 0, 127, 255]);
    const half = createImage(1, 1);
    compositeOver(half, imageFrom(1, 1, () => [10, 20, 30, 255]), 0, 0, 0.5);
    expect(px(half, 0, 0)).toEqual([10, 20, 30, 128]);
  });

  it('a feathered layer over a filled base reproduces an opaque original', () => {
    // The pipeline's identity: base (anything under the layer) + layer (original x mask) = original where mask = 1.
    const original = imageFrom(16, 16, (x, y) => [x * 16, y * 16, 100]);
    const mask = ellipseMask(16, 16, 8, 8, 5, 5);
    const base = imageFrom(16, 16, () => [0, 255, 0]);
    compositeOver(base, applyMask(original, mask));
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (at(mask, x, y) === 1) expect(px(base, x, y)).toEqual(px(original, x, y));
    expect(px(base, 0, 0)).toEqual([0, 255, 0, 255]);
  });
});

describe('cutLayer', () => {
  /** Largest channel difference between two images, ignoring the colour of pixels that are transparent in both. */
  function difference(a: ReturnType<typeof createImage>, b: ReturnType<typeof createImage>): number {
    let worst = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      worst = Math.max(worst, Math.abs(a.data[i + 3] - b.data[i + 3]));
      if (a.data[i + 3] === 0 && b.data[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a.data[i + c] - b.data[i + c]));
    }
    return worst;
  }

  it('layer over rest reproduces an opaque image exactly, for any soft mask', () => {
    const img = imageFrom(32, 24, (x, y) => [x * 8, y * 10, (x * y) % 256]);
    const random = mulberry32(8);
    const mask = createMask(32, 24);
    for (let i = 0; i < mask.data.length; i++) mask.data[i] = i % 5 === 0 ? 1 : i % 7 === 0 ? 0 : random();
    const { layer, rest, covered } = cutLayer(img, mask);
    const again = cloneImage(rest);
    compositeOver(again, layer);
    expect(difference(again, img)).toBe(0);
    // Fully covered pixels are the hole; partly covered ones keep the original underneath.
    let holes = 0;
    for (let i = 0; i < mask.data.length; i++) {
      expect(covered.data[i]).toBe(layer.data[i * 4 + 3] === 255 ? 1 : 0);
      expect(rest.data[i * 4 + 3]).toBe(layer.data[i * 4 + 3] === 255 ? 0 : 255);
      holes += covered.data[i];
    }
    expect(holes).toBeGreaterThan(100);
    expect(layer.data[3]).toBe(255);
    // Colours are never touched, in either piece.
    for (let i = 0; i < img.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        expect(layer.data[i + c]).toBe(img.data[i + c]);
        expect(rest.data[i + c]).toBe(img.data[i + c]);
      }
    }
  });

  it('reproduces images with their own transparency within one alpha step', () => {
    const random = mulberry32(21);
    // Random alphas, none of them in the "almost opaque" range 250..254.
    const img = imageFrom(40, 30, (x, y) => [x * 6, y * 8, 99, x < 8 ? 0 : x > 30 ? 255 : Math.floor(random() * 250)]);
    const mask = featherMask(ellipseMask(40, 30, 20, 15, 12, 9), 4, 'outward');
    const { layer, rest, covered } = cutLayer(img, mask);
    const again = cloneImage(rest);
    compositeOver(again, layer);
    expect(difference(again, img)).toBeLessThanOrEqual(1);
    // Where the mask is full, a partly transparent image pixel leaves nothing behind.
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i] === 1 && img.data[i * 4 + 3] < 255) expect(rest.data[i * 4 + 3]).toBe(0);
      if (mask.data[i] === 0) expect(rest.data[i * 4 + 3]).toBe(img.data[i * 4 + 3]);
      if (covered.data[i]) expect(img.data[i * 4 + 3]).toBe(255);
    }
  });

  it('whatever is inpainted under the covered pixels stays invisible in the rest pose', () => {
    const img = imageFrom(48, 40, (x, y) => [40 + x * 4, 30 + y * 5, 120, y < 4 ? 0 : 255]);
    // A darker "object" in the middle.
    for (let y = 14; y < 26; y++) for (let x = 18; x < 30; x++) img.data.set([20, 20, 60, 255], (y * 48 + x) * 4);
    const shape = polygonMask(48, 40, [17, 13, 31, 13, 31, 27, 17, 27]);
    const { layer, rest, covered } = cutLayer(img, featherMask(shape, 2, 'outward'));
    const base = inpaint(rest, covered);
    // The object is gone from the base: the fill continues the background gradient.
    expect(px(base, 24, 20)[3]).toBe(255);
    expect(Math.abs(px(base, 24, 20)[0] - (40 + 24 * 4))).toBeLessThan(6);
    expect(Math.abs(px(base, 24, 20)[1] - (30 + 20 * 5))).toBeLessThan(6);
    const again = cloneImage(base);
    compositeOver(again, layer);
    expect(difference(again, img)).toBe(0);
  });

  it('treats almost opaque pixels as covered, so real cut-out art can be filled', () => {
    // Background-removed illustrations are often alpha 253 where they look opaque.
    const img = imageFrom(40, 30, (x, y) => [40 + x * 4, 30 + y * 5, 120, 253]);
    for (let y = 10; y < 20; y++) for (let x = 14; x < 26; x++) img.data.set([20, 20, 60, 253], (y * 40 + x) * 4);
    const mask = featherMask(polygonMask(40, 30, [13, 9, 27, 9, 27, 21, 13, 21]), 2, 'outward');
    const { layer, rest, covered } = cutLayer(img, mask);
    expect(covered.data[15 * 40 + 20]).toBe(1);
    const base = inpaint(rest, covered);
    expect(px(base, 20, 15)[3]).toBe(253);
    expect(Math.abs(px(base, 20, 15)[0] - (40 + 20 * 4))).toBeLessThan(6);
    const again = cloneImage(base);
    compositeOver(again, layer);
    // The fill shows through the 253 / 255 layer by less than 1%: within 2 levels of the source.
    expect(difference(again, img)).toBeLessThanOrEqual(2);
    // With a strict threshold nothing counts as covered and the layer simply leaves a hole.
    const strict = cutLayer(img, mask, { opaque: 255 });
    expect(strict.covered.data.some((v) => v > 0)).toBe(false);
    expect(strict.rest.data[(15 * 40 + 20) * 4 + 3]).toBe(0);
  });

  it('an object over the transparent background leaves no rim and no fill behind', () => {
    // An antialiased disc floating on transparency.
    const disc = ellipseMask(30, 30, 15, 15, 8, 8);
    const img = applyMask(imageFrom(30, 30, () => [200, 60, 60]), disc);
    const { layer, rest, covered } = cutLayer(img, featherMask(ellipseMask(30, 30, 15, 15, 10, 10), 2, 'outward'));
    for (let i = 3; i < rest.data.length; i += 4) expect(rest.data[i]).toBe(0);
    const base = inpaint(rest, covered);
    for (let i = 3; i < base.data.length; i += 4) expect(base.data[i]).toBe(0);
    const again = cloneImage(base);
    compositeOver(again, layer);
    expect(difference(again, img)).toBe(0);
    expect(() => cutLayer(img, createMask(3, 3))).toThrow(/cutLayer: sizes differ/);
  });
});

describe('alphaBounds', () => {
  it('finds the box of visible pixels', () => {
    const img = imageFrom(8, 6, (x, y) => [0, 0, 0, x >= 2 && x <= 5 && y >= 1 && y <= 3 ? 255 : x === 7 && y === 5 ? 3 : 0]);
    expect(alphaBounds(img)).toEqual({ x: 2, y: 1, width: 6, height: 5 });
    expect(alphaBounds(img, 8)).toEqual({ x: 2, y: 1, width: 4, height: 3 });
    expect(alphaBounds(createImage(4, 4))).toBeNull();
    expect(alphaBounds(createImage(3, 2, [0, 0, 0, 1]))).toEqual({ x: 0, y: 0, width: 3, height: 2 });
  });
});

describe('tintMask', () => {
  it('paints the mask over the picture with the given opacity', () => {
    const img = imageFrom(3, 1, (x) => [0, 0, 0, x === 2 ? 0 : 255]);
    const mask = createMask(3, 1);
    mask.data.set([1, 0, 1]);
    const out = tintMask(img, mask, [255, 0, 96], 0.5);
    expect(px(out, 0, 0)).toEqual([128, 0, 48, 255]);
    expect(px(out, 1, 0)).toEqual([0, 0, 0, 255]);
    // Over a transparent pixel only the tint remains.
    expect(px(out, 2, 0)).toEqual([255, 0, 96, 128]);
    expect(px(img, 0, 0)).toEqual([0, 0, 0, 255]);
  });
});

describe('bilinear resampling', () => {
  it('interpolates between pixel centres and clamps at the border', () => {
    const img = imageFrom(2, 1, (x) => (x ? [255, 255, 255] : [0, 0, 0]));
    const up = upscaleBilinear(img, 2);
    expect(up.width).toBe(4);
    expect(up.height).toBe(2);
    expect([0, 1, 2, 3].map((x) => px(up, x, 0)[0])).toEqual([0, 64, 191, 255]);
    expect(px(up, 1, 1)).toEqual(px(up, 1, 0));
  });

  it('keeps flat colours and rounds the size', () => {
    const flat = imageFrom(5, 3, () => [12, 200, 77, 140]);
    const up = upscaleBilinear(flat, 2.5);
    expect(up.width).toBe(13);
    expect(up.height).toBe(8);
    for (let i = 0; i < up.data.length; i += 4) expect(Array.from(up.data.subarray(i, i + 4))).toEqual([12, 200, 77, 140]);
    expect(() => upscaleBilinear(flat, 0)).toThrow(/factor must be a positive number/);
    expect(resizeBilinear(flat, 0, 4).data.length).toBe(0);
  });

  it('is alpha-aware: transparent pixels do not tint the edge', () => {
    // Opaque red next to a transparent pixel that stores green.
    const img = imageFrom(2, 1, (x) => (x ? [0, 255, 0, 0] : [255, 0, 0, 255]));
    const up = resizeBilinear(img, 8, 1);
    for (let x = 0; x < 8; x++) {
      const p = px(up, x, 0);
      if (p[3] > 0) expect([p[0], p[1], p[2]]).toEqual([255, 0, 0]);
    }
    expect(px(up, 0, 0)[3]).toBe(255);
    expect(px(up, 7, 0)[3]).toBe(0);
    expect(px(up, 3, 0)[3]).toBeGreaterThan(px(up, 4, 0)[3]);
    // Where everything is transparent the stored colours are interpolated as they are (extended edges survive).
    const hidden = imageFrom(2, 1, (x) => [x ? 200 : 100, 0, 0, 0]);
    expect(px(resizeBilinear(hidden, 4, 1), 1, 0)).toEqual([125, 0, 0, 0]);
  });

  it('upscales masks the same way', () => {
    const m = createMask(2, 2);
    m.data.set([0, 1, 0, 1]);
    const up = upscaleMask(m, 2);
    expect(up.width).toBe(4);
    expect(Array.from(up.data.subarray(0, 4))).toEqual([0, 0.25, 0.75, 1]);
    expect(Array.from(resizeMaskBilinear(m, 2, 2).data)).toEqual(Array.from(m.data));
  });
});

describe('area resampling', () => {
  it('averages whole blocks when halving', () => {
    const img = imageFrom(4, 4, (x, y) => [x < 2 ? 0 : 200, y < 2 ? 40 : 80, x + y * 4]);
    const down = downscaleArea(img, 2);
    expect(down.width).toBe(2);
    expect(down.height).toBe(2);
    expect(px(down, 0, 0)).toEqual([0, 40, 3, 255]);
    expect(px(down, 1, 0)).toEqual([200, 40, 5, 255]);
    expect(px(down, 1, 1)).toEqual([200, 80, 13, 255]);
  });

  it('weights partially covered source pixels for other ratios', () => {
    const img = imageFrom(3, 1, (x) => [x * 90, 0, 0]);
    const down = resizeArea(img, 2, 1);
    // Each destination pixel covers 1.5 source pixels: (0 * 1 + 90 * 0.5) / 1.5 and (90 * 0.5 + 180 * 1) / 1.5.
    expect(px(down, 0, 0)[0]).toBe(30);
    expect(px(down, 1, 0)[0]).toBe(150);
    const third = downscaleArea(imageFrom(10, 10, () => [9, 9, 9]), 3);
    expect(third.width).toBe(3);
    expect(px(third, 2, 2)).toEqual([9, 9, 9, 255]);
  });

  it('is alpha-aware: colour comes from the visible part of the area', () => {
    const img = imageFrom(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
    const down = resizeArea(img, 1, 1);
    expect(px(down, 0, 0)).toEqual([255, 0, 0, 64]);
    expect(px(resizeArea(imageFrom(2, 2, () => [5, 5, 5, 0]), 1, 1), 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('preserves the mean of a mask', () => {
    const m = ellipseMask(60, 45, 31.2, 20.7, 17, 11);
    for (const [w, h] of [
      [30, 15],
      [20, 15],
      [17, 13],
      [60, 45],
    ]) {
      const small = resizeMaskArea(m, w, h);
      expect((maskArea(small) * (60 * 45)) / (w * h)).toBeCloseTo(maskArea(m), 2);
    }
    const half = downscaleMask(m, 2);
    expect(half.width).toBe(30);
    expect(half.height).toBe(23);
    expect(at(half, 15, 10)).toBeCloseTo(1, 5);
    expect(at(half, 0, 0)).toBe(0);
  });

  it('never returns an empty image for a huge factor', () => {
    const tiny = downscaleArea(imageFrom(5, 3, () => [100, 100, 100]), 50);
    expect(tiny.width).toBe(1);
    expect(tiny.height).toBe(1);
    expect(px(tiny, 0, 0)).toEqual([100, 100, 100, 255]);
  });
});

describe('determinism and the layer round trip', () => {
  it('extended edges keep a downscaled, bilinearly sampled layer from darkening', () => {
    // A bright disc on transparent black, cut, extended, then enlarged.
    const disc = ellipseMask(24, 24, 12, 12, 7, 7);
    const layer = applyMask(imageFrom(24, 24, () => [240, 230, 220]), disc);
    for (let i = 0; i < layer.data.length; i += 4) if (layer.data[i + 3] === 0) layer.data[i] = layer.data[i + 1] = layer.data[i + 2] = 0;
    const extended = extendEdges(layer, 3);
    // Straight (non-premultiplied) interpolation of the colour channels, as a simple renderer does.
    const straight = (img: typeof layer, x: number, y: number): number => (px(img, x, y)[0] + px(img, x + 1, y)[0]) / 2;
    let darkest = 255;
    let darkestExtended = 255;
    for (let y = 2; y < 22; y++) {
      for (let x = 2; x < 21; x++) {
        if (px(layer, x, y)[3] === 0 && px(layer, x + 1, y)[3] === 0) continue;
        darkest = Math.min(darkest, straight(layer, x, y));
        darkestExtended = Math.min(darkestExtended, straight(extended, x, y));
      }
    }
    expect(darkest).toBeLessThan(130);
    expect(darkestExtended).toBe(240);
    expect(Array.from(extendEdges(layer, 3).data)).toEqual(Array.from(extended.data));
  });
});
