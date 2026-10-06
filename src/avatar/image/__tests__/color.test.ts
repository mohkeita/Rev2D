import { describe, expect, it } from 'vitest';
import {
  colorMatchMask,
  colorStats,
  deltaE,
  deltaERgb,
  dominantColors,
  imageToLab,
  labToRgb,
  linearToSrgb,
  rgbToLab,
  srgbToLinear,
} from '../color.js';
import { createMask } from '../mask.js';
import { mulberry32 } from '../random.js';
import { at, imageFrom, maskFromRows } from './helpers.js';

describe('sRGB transfer curve', () => {
  it('maps the ends and known values', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 5);
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 12);
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(1, 12);
    expect(linearToSrgb(0.18)).toBeCloseTo(0.46136, 4);
  });

  it('round-trips every 8-bit code and is monotonic', () => {
    let previous = -1;
    for (let v = 0; v <= 255; v++) {
      const lin = srgbToLinear(v / 255);
      expect(lin).toBeGreaterThan(previous);
      previous = lin;
      expect(linearToSrgb(lin) * 255).toBeCloseTo(v, 9);
    }
  });
});

describe('Lab', () => {
  it('matches reference values (D65)', () => {
    const cases: [number[], number[]][] = [
      [[255, 255, 255], [100, 0, 0]],
      [[0, 0, 0], [0, 0, 0]],
      [[255, 0, 0], [53.2408, 80.0925, 67.2032]],
      [[0, 255, 0], [87.7347, -86.1827, 83.1793]],
      [[0, 0, 255], [32.297, 79.1875, -107.8602]],
      [[119, 119, 119], [50.034, 0, 0]],
    ];
    for (const [rgb, lab] of cases) {
      const got = rgbToLab(rgb[0], rgb[1], rgb[2]);
      for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - lab[k])).toBeLessThan(0.01);
    }
  });

  it('round-trips the RGB cube', () => {
    let worst = 0;
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const lab = rgbToLab(r, g, b);
          const back = labToRgb(lab[0], lab[1], lab[2]);
          worst = Math.max(worst, Math.abs(back[0] - r), Math.abs(back[1] - g), Math.abs(back[2] - b));
        }
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('accepts fractional channels and clamps out-of-gamut results', () => {
    // A half step in one channel lands between the two whole steps.
    const mid = rgbToLab(100.5, 20, 200);
    const lo = rgbToLab(100, 20, 200);
    const hi = rgbToLab(101, 20, 200);
    for (let k = 0; k < 3; k++) {
      expect(mid[k]).toBeGreaterThan(Math.min(lo[k], hi[k]));
      expect(mid[k]).toBeLessThan(Math.max(lo[k], hi[k]));
    }
    const wild = labToRgb(50, 150, -150);
    for (const c of wild) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
    }
    expect(labToRgb(120, 0, 0)).toEqual([255, 255, 255]);
  });

  it('deltaE is the Euclidean distance in Lab', () => {
    expect(deltaE([50, 10, -10], [50, 10, -10])).toBe(0);
    expect(deltaE([50, 0, 0], [53, 4, 0])).toBe(5);
    expect(deltaE([10, 20, 30], [40, -5, 7])).toBeCloseTo(deltaE([40, -5, 7], [10, 20, 30]), 12);
    expect(deltaERgb([255, 255, 255], [0, 0, 0])).toBeCloseTo(100, 4);
    expect(deltaERgb([200, 100, 50], [200, 100, 50])).toBe(0);
    // Similar skin tones are close, skin and dark hair are far apart.
    expect(deltaERgb([250, 220, 205], [245, 212, 198])).toBeLessThan(5);
    expect(deltaERgb([250, 220, 205], [60, 40, 50])).toBeGreaterThan(50);
  });

  it('converts a whole image like rgbToLab and keeps alpha', () => {
    const img = imageFrom(5, 4, (x, y) => [x * 60, y * 80, (x + y) * 30, 255 - x * 50]);
    const lab = imageToLab(img);
    expect(lab.width).toBe(5);
    expect(lab.height).toBe(4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 5; x++) {
        const i = y * 5 + x;
        const want = rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
        for (let k = 0; k < 3; k++) expect(lab.lab[i * 3 + k]).toBeCloseTo(want[k], 3);
        expect(lab.alpha[i]).toBe(img.data[i * 4 + 3]);
      }
    }
  });
});

describe('colorMatchMask', () => {
  const img = imageFrom(4, 1, (x) => [[200, 100, 50, 255], [205, 104, 54, 255], [20, 200, 90, 255], [200, 100, 50, 0]][x]);

  it('is 1 within the tolerance, 0 beyond, and excludes transparent pixels', () => {
    const ref = rgbToLab(200, 100, 50);
    const m = colorMatchMask(img, [ref], 1);
    expect(Array.from(m.data)).toEqual([1, 0, 0, 0]);
    const wide = colorMatchMask(img, [ref], 10);
    expect(Array.from(wide.data)).toEqual([1, 1, 0, 0]);
    const two = colorMatchMask(imageToLab(img), [ref, rgbToLab(20, 200, 90)], 1);
    expect(Array.from(two.data)).toEqual([1, 0, 1, 0]);
  });

  it('fades linearly over the softness', () => {
    const ref = rgbToLab(200, 100, 50);
    const d = deltaERgb([200, 100, 50], [205, 104, 54]);
    const m = colorMatchMask(img, [ref], d - 1, 4);
    expect(at(m, 1, 0)).toBeCloseTo(0.75, 3);
    expect(at(m, 0, 0)).toBe(1);
    expect(at(m, 2, 0)).toBe(0);
  });
});

describe('colorStats', () => {
  it('describes a flat colour exactly', () => {
    const img = imageFrom(6, 5, () => [200, 150, 100]);
    const s = colorStats(img)!;
    expect(s.count).toBe(30);
    expect(s.weight).toBeCloseTo(30, 9);
    expect(s.mean).toEqual([200, 150, 100]);
    expect(s.median).toEqual([200, 150, 100]);
    expect(s.trimmedMean).toEqual([200, 150, 100]);
    expect(s.std).toEqual([0, 0, 0]);
  });

  it('median and trimmed mean ignore outliers that pull the mean', () => {
    // 90 skin pixels and 10 black lash pixels.
    const img = imageFrom(10, 10, (x, y) => (y === 0 ? [0, 0, 0] : [200, 150, 100]));
    const s = colorStats(img)!;
    expect(s.mean[0]).toBeCloseTo(180, 9);
    expect(s.mean[1]).toBeCloseTo(135, 9);
    expect(s.mean[2]).toBeCloseTo(90, 9);
    expect(s.median).toEqual([200, 150, 100]);
    expect(s.trimmedMean[0]).toBeCloseTo(200, 6);
    expect(s.trimmedMean[1]).toBeCloseTo(150, 6);
    expect(s.std[0]).toBeCloseTo(60, 6);
    // With no trimming the trimmed mean is the mean.
    expect(colorStats(img, null, { trim: 0 })!.trimmedMean[0]).toBeCloseTo(180, 9);
    // Trimming 5% per side drops only half of the outliers.
    expect(colorStats(img, null, { trim: 0.05 })!.trimmedMean[0]).toBeCloseTo((200 * 85) / 90, 6);
  });

  it('weights by the mask and by alpha', () => {
    const img = imageFrom(4, 1, (x) => [[10, 0, 0, 255], [20, 0, 0, 255], [30, 0, 0, 255], [250, 0, 0, 0]][x]);
    const mask = createMask(4, 1);
    mask.data.set([1, 0.5, 0, 1]);
    const s = colorStats(img, mask)!;
    // Pixel 2 is outside the mask, pixel 3 is transparent.
    expect(s.count).toBe(2);
    expect(s.weight).toBeCloseTo(1.5, 9);
    expect(s.mean[0]).toBeCloseTo((10 * 1 + 20 * 0.5) / 1.5, 9);
    expect(s.median[0]).toBe(10);
    const translucent = imageFrom(2, 1, (x) => [x ? 100 : 0, 0, 0, x ? 51 : 255]);
    expect(colorStats(translucent)!.mean[0]).toBeCloseTo((100 * 0.2) / 1.2, 9);
  });

  it('gives the median of a ramp and returns null when nothing counts', () => {
    const ramp = imageFrom(101, 1, (x) => [x, 2 * x, 255 - x]);
    const s = colorStats(ramp)!;
    expect(s.median).toEqual([50, 100, 205]);
    expect(s.mean[0]).toBeCloseTo(50, 9);
    expect(s.trimmedMean[0]).toBeCloseTo(50, 6);
    expect(colorStats(ramp, createMask(101, 1))).toBeNull();
    expect(colorStats(imageFrom(3, 3, () => [1, 2, 3, 0]))).toBeNull();
    expect(() => colorStats(ramp, createMask(3, 3))).toThrow(/colorStats: sizes differ/);
  });
});

describe('dominantColors', () => {
  const palette = [
    [230, 200, 180],
    [70, 40, 90],
    [20, 160, 120],
  ];
  // 60% / 30% / 10% with a little noise.
  const noise = mulberry32(5);
  const img = imageFrom(50, 40, (x) => {
    const c = palette[x < 30 ? 0 : x < 45 ? 1 : 2];
    return c.map((v) => v + Math.round((noise() - 0.5) * 6));
  });

  it('finds the colours sorted by their share', () => {
    const found = dominantColors(img, null, 3);
    expect(found.length).toBe(3);
    expect(found[0].share).toBeCloseTo(0.6, 2);
    expect(found[1].share).toBeCloseTo(0.3, 2);
    expect(found[2].share).toBeCloseTo(0.1, 2);
    found.forEach((c, k) => {
      expect(deltaERgb(c.rgb, palette[k] as [number, number, number])).toBeLessThan(2);
      expect(deltaE(c.lab, rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]))).toBeLessThan(1e-6);
    });
    expect(found.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 9);
  });

  it('returns fewer clusters when there are fewer distinct colours', () => {
    const two = imageFrom(10, 10, (x) => (x < 7 ? [200, 30, 30] : [30, 30, 200]));
    const found = dominantColors(two, null, 5);
    expect(found.length).toBe(2);
    expect(found[0].share).toBeCloseTo(0.7, 9);
    expect(found[0].rgb.map(Math.round)).toEqual([200, 30, 30]);
    expect(found[1].rgb.map(Math.round)).toEqual([30, 30, 200]);
    expect(dominantColors(two, null, 1)[0].share).toBe(1);
  });

  it('only looks under the mask and at visible pixels', () => {
    const mask = createMask(50, 40);
    for (let y = 0; y < 40; y++) for (let x = 30; x < 50; x++) mask.data[y * 50 + x] = 1;
    const found = dominantColors(img, mask, 2);
    expect(found.length).toBe(2);
    expect(found[0].share).toBeCloseTo(0.75, 2);
    expect(deltaERgb(found[0].rgb, [70, 40, 90])).toBeLessThan(2);
    expect(dominantColors(img, createMask(50, 40), 3)).toEqual([]);
    expect(dominantColors(imageFrom(4, 4, () => [9, 9, 9, 0]), null, 2)).toEqual([]);
  });

  it('is deterministic for a seed and stable across seeds for clear clusters', () => {
    const a = dominantColors(img, null, 3, { seed: 7 });
    const b = dominantColors(img, null, 3, { seed: 7 });
    expect(a).toEqual(b);
    for (const seed of [1, 2, 3, 99]) {
      const c = dominantColors(img, null, 3, { seed });
      expect(c.map((k) => Math.round(k.share * 100))).toEqual([60, 30, 10]);
    }
  });

  it('subsamples large inputs evenly', () => {
    const found = dominantColors(img, null, 3, { maxSamples: 200 });
    expect(found.length).toBe(3);
    expect(found[0].share).toBeGreaterThan(0.5);
    expect(deltaERgb(found[0].rgb, [230, 200, 180])).toBeLessThan(3);
    expect(() => dominantColors(img, null, 0)).toThrow(/positive integer/);
  });

  it('works under a text-drawn mask', () => {
    const m = maskFromRows(['##..', '##..']);
    const small = imageFrom(4, 2, (x) => (x < 2 ? [255, 0, 0] : [0, 0, 255]));
    const found = dominantColors(small, m, 2);
    expect(found.length).toBe(1);
    expect(found[0].rgb.map(Math.round)).toEqual([255, 0, 0]);
  });
});
