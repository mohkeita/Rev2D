import { describe, expect, it } from 'vitest';
import { blurImage, blurMask, boxBlurImage, boxBlurMask } from '../blur.js';
import { createMask, maskArea } from '../mask.js';
import type { Mask } from '../types.js';
import { at, imageFrom, px, rangeOf } from './helpers.js';

function impulse(size: number): Mask {
  const m = createMask(size, size);
  m.data[((size - 1) / 2) * size + (size - 1) / 2] = 1;
  return m;
}

/** Variance of a blurred impulse along x (it is its own probability distribution). */
function varianceX(m: Mask): number {
  const c = (m.width - 1) / 2;
  let v = 0;
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) v += at(m, x, y) * (x - c) * (x - c);
  return v / maskArea(m);
}

describe('blurMask (Gaussian)', () => {
  it('preserves the sum when nothing reaches the border', () => {
    const m = createMask(48, 48);
    for (let y = 20; y < 27; y++) for (let x = 18; x < 25; x++) m.data[y * 48 + x] = y % 2 ? 1 : 0.4;
    const total = maskArea(m);
    for (const sigma of [0.4, 1, 1.5, 2.99, 3, 3.3, 5]) {
      for (const edge of ['clamp', 'zero'] as const) {
        expect(Math.abs(maskArea(blurMask(m, sigma, { edge })) - total) / total).toBeLessThan(1e-4);
      }
    }
  });

  it('matches the sampled Gaussian for small sigmas', () => {
    for (const sigma of [0.6, 1.2, 1.9, 2.9]) {
      const b = blurMask(impulse(21), sigma);
      const radius = Math.ceil(3 * sigma);
      let norm = 0;
      for (let k = -radius; k <= radius; k++) norm += Math.exp(-(k * k) / (2 * sigma * sigma));
      const g = (k: number): number => (Math.abs(k) <= radius ? Math.exp(-(k * k) / (2 * sigma * sigma)) / norm : 0);
      let worst = 0;
      for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) worst = Math.max(worst, Math.abs(at(b, 10 + dx, 10 + dy) - g(dx) * g(dy)));
      expect(worst).toBeLessThan(1e-6);
    }
  });

  it('has the requested variance and a Gaussian shape for large sigmas', () => {
    for (const sigma of [3, 3.7, 5, 9.5]) {
      const size = 2 * Math.ceil(sigma * 5) + 1;
      const b = blurMask(impulse(size), sigma);
      expect(Math.abs(varianceX(b) - sigma * sigma) / (sigma * sigma)).toBeLessThan(0.01);
      const c = (size - 1) / 2;
      const peak = 1 / (2 * Math.PI * sigma * sigma);
      let worst = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const truth = peak * Math.exp(-((x - c) ** 2 + (y - c) ** 2) / (2 * sigma * sigma));
          worst = Math.max(worst, Math.abs(at(b, x, y) - truth));
        }
      }
      // Four box passes: about 3.5% below the true peak per axis, so about 7% in two dimensions.
      expect(worst / peak).toBeLessThan(0.085);
      // Symmetric in x and y and under transposition.
      expect(at(b, c - 3, c)).toBeCloseTo(at(b, c + 3, c), 7);
      expect(at(b, c, c - 2)).toBeCloseTo(at(b, c, c + 2), 7);
      expect(at(b, c + 2, c + 1)).toBeCloseTo(at(b, c + 1, c + 2), 7);
    }
  });

  it('changes little across the switch between the two methods (sigma 3)', () => {
    const a = blurMask(impulse(41), 2.999);
    const b = blurMask(impulse(41), 3);
    let worst = 0;
    for (let i = 0; i < a.data.length; i++) worst = Math.max(worst, Math.abs(a.data[i] - b.data[i]));
    expect(worst).toBeLessThan(0.085 / (2 * Math.PI * 9));
  });

  it('keeps a constant mask constant with clamped edges and fades with zero edges', () => {
    const flat = createMask(20, 12, 0.7);
    for (const sigma of [1, 5]) {
      const clamp = rangeOf(blurMask(flat, sigma).data);
      expect(clamp.min).toBeCloseTo(0.7, 5);
      expect(clamp.max).toBeCloseTo(0.7, 5);
      const zero = blurMask(flat, sigma, { edge: 'zero' });
      expect(at(zero, 10, 6)).toBeGreaterThan(at(zero, 0, 0));
      // A corner pixel sees a little more than a quarter of the kernel.
      expect(at(zero, 0, 0)).toBeLessThan(0.7 * 0.55);
      expect(at(zero, 0, 0)).toBeGreaterThan(0.7 * 0.25);
      expect(maskArea(zero)).toBeLessThan(maskArea(flat));
    }
  });

  it('returns a copy for sigma <= 0 and never changes its input', () => {
    const m = impulse(9);
    const before = Array.from(m.data);
    const same = blurMask(m, 0);
    expect(same).not.toBe(m);
    expect(same.data).not.toBe(m.data);
    expect(Array.from(same.data)).toEqual(before);
    blurMask(m, 2.5);
    blurMask(m, 4.5);
    expect(Array.from(m.data)).toEqual(before);
  });

  it('is deterministic', () => {
    const m = createMask(30, 20);
    for (let i = 0; i < m.data.length; i++) m.data[i] = (i * 37) % 11 === 0 ? 1 : 0;
    expect(Array.from(blurMask(m, 3.1).data)).toEqual(Array.from(blurMask(m, 3.1).data));
    expect(Array.from(blurMask(m, 1.1).data)).toEqual(Array.from(blurMask(m, 1.1).data));
  });
});

describe('boxBlurMask', () => {
  it('averages over a (2r + 1) square', () => {
    const b = boxBlurMask(impulse(9), 1);
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) expect(at(b, x, y)).toBeCloseTo(Math.abs(x - 4) <= 1 && Math.abs(y - 4) <= 1 ? 1 / 9 : 0, 7);
    expect(maskArea(boxBlurMask(impulse(15), 3))).toBeCloseTo(1, 5);
    expect(at(boxBlurMask(impulse(15), 3), 10, 4)).toBeCloseTo(1 / 49, 7);
    expect(at(boxBlurMask(impulse(15), 3), 11, 7)).toBe(0);
  });

  it('counts the outermost pixels partially for a fractional radius', () => {
    const b = boxBlurMask(impulse(9), 1.5);
    const row = [2, 3, 4, 5, 6].map((x) => at(b, x, 4) * 4 * 4);
    expect(row[0]).toBeCloseTo(0.5, 5);
    expect(row[1]).toBeCloseTo(1, 5);
    expect(row[2]).toBeCloseTo(1, 5);
    expect(row[4]).toBeCloseTo(0.5, 5);
    expect(at(b, 1, 4)).toBe(0);
    // A radius below 1 only has the fractional taps.
    const small = boxBlurMask(impulse(5), 0.25);
    expect(at(small, 2, 2)).toBeCloseTo(1 / 1.5 / 1.5, 6);
    expect(at(small, 1, 2)).toBeCloseTo(0.25 / 1.5 / 1.5, 6);
  });

  it('returns a copy for radius 0', () => {
    const m = impulse(5);
    expect(Array.from(boxBlurMask(m, 0).data)).toEqual(Array.from(m.data));
  });
});

describe('blurImage / boxBlurImage', () => {
  it('keeps an opaque flat colour and blurs opaque pictures like each channel', () => {
    const flat = imageFrom(12, 10, () => [200, 100, 50]);
    expect(Array.from(blurImage(flat, 2.5).data)).toEqual(Array.from(flat.data));
    const steps = imageFrom(30, 6, (x) => [x < 15 ? 0 : 255, x < 15 ? 255 : 0, 40]);
    const b = blurImage(steps, 1.5);
    expect(px(b, 2, 3)).toEqual([0, 255, 40, 255]);
    expect(px(b, 27, 3)).toEqual([255, 0, 40, 255]);
    const left = px(b, 14, 3);
    const right = px(b, 15, 3);
    expect(left[0] + right[0]).toBe(255);
    expect(left[0]).toBeGreaterThan(60);
    expect(left[0]).toBeLessThan(128);
    expect(left[3]).toBe(255);
  });

  it('is alpha-aware: transparent pixels contribute no colour', () => {
    // Left half opaque red; right half fully transparent but with green stored in its RGB.
    const img = imageFrom(24, 8, (x) => (x < 12 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
    for (const blurred of [blurImage(img, 1.5), blurImage(img, 3.2), boxBlurImage(img, 2)]) {
      for (let x = 0; x < 24; x++) {
        const p = px(blurred, x, 4);
        if (p[3] > 0) expect([p[0], p[1], p[2]]).toEqual([255, 0, 0]);
      }
      expect(px(blurred, 2, 4)[3]).toBe(255);
      expect(px(blurred, 11, 4)[3]).toBeLessThan(200);
      expect(px(blurred, 11, 4)[3]).toBeGreaterThan(128);
      expect(px(blurred, 12, 4)[3]).toBeLessThan(128);
      expect(px(blurred, 12, 4)[3]).toBeGreaterThan(50);
      expect(px(blurred, 22, 4)[3]).toBe(0);
      // Alpha itself is the blurred alpha: it falls monotonically across the edge.
      for (let x = 1; x < 24; x++) expect(px(blurred, x, 4)[3]).toBeLessThanOrEqual(px(blurred, x - 1, 4)[3]);
    }
  });

  it('fades an opaque image toward the border only with zero edges', () => {
    const flat = imageFrom(16, 16, () => [10, 200, 90]);
    const clamp = blurImage(flat, 3);
    expect(px(clamp, 0, 0)).toEqual([10, 200, 90, 255]);
    const zero = blurImage(flat, 3, { edge: 'zero' });
    expect(px(zero, 8, 8)[3]).toBeGreaterThan(px(zero, 0, 0)[3]);
    expect(px(zero, 0, 0)[3]).toBeLessThan(110);
    expect(px(zero, 0, 0).slice(0, 3)).toEqual([10, 200, 90]);
  });

  it('box-blurs an image like its channels', () => {
    const img = imageFrom(9, 9, (x, y) => (x === 4 && y === 4 ? [255, 255, 255] : [0, 0, 0]));
    const b = boxBlurImage(img, 1);
    expect(px(b, 4, 4)).toEqual([28, 28, 28, 255]);
    expect(px(b, 5, 3)).toEqual([28, 28, 28, 255]);
    expect(px(b, 6, 4)).toEqual([0, 0, 0, 255]);
  });

  it('returns a copy for sigma 0 and is deterministic', () => {
    const img = imageFrom(10, 7, (x, y) => [x * 20, y * 30, (x * y) % 255, 128 + x * 10]);
    const copy = blurImage(img, 0);
    expect(copy.data).not.toBe(img.data);
    expect(Array.from(copy.data)).toEqual(Array.from(img.data));
    expect(Array.from(blurImage(img, 2.2).data)).toEqual(Array.from(blurImage(img, 2.2).data));
    expect(Array.from(blurImage(img, 4.2).data)).toEqual(Array.from(blurImage(img, 4.2).data));
  });
});
