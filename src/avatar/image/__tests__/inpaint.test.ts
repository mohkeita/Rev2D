import { describe, expect, it } from 'vitest';
import type { ImageRGBA } from '../../../core/types.js';
import { extendEdges, inpaint } from '../inpaint.js';
import { createMask } from '../mask.js';
import { ellipseMask, polygonMask } from '../raster.js';
import type { Mask } from '../types.js';
import { imageFrom, maskFromRows, px } from './helpers.js';

function rectHole(width: number, height: number, x: number, y: number, w: number, h: number): Mask {
  return polygonMask(width, height, [x, y, x + w, y, x + w, y + h, x, y + h]);
}

/** Largest and mean absolute channel difference between two images over the hole pixels. */
function holeError(a: ImageRGBA, b: ImageRGBA, hole: Mask): { max: number; mean: number } {
  let max = 0;
  let total = 0;
  let n = 0;
  for (let i = 0; i < hole.data.length; i++) {
    if (!(hole.data[i] > 0)) continue;
    for (let c = 0; c < 3; c++) {
      const e = Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]);
      max = Math.max(max, e);
      total += e;
      n++;
    }
  }
  return { max, mean: total / n };
}

describe('inpaint', () => {
  const linear = imageFrom(64, 48, (x, y) => [40 + 2.4 * x, 20 + 4 * y, 140 + x - 1.5 * y]);

  it('reconstructs a linear gradient across a hole', () => {
    const hole = rectHole(64, 48, 20, 16, 24, 16);
    const filled = inpaint(linear, hole);
    const err = holeError(filled, linear, hole);
    expect(err.max).toBeLessThanOrEqual(1);
    expect(err.mean).toBeLessThan(0.2);
  });

  it('reconstructs gently curved shading within a small error', () => {
    const shaded = imageFrom(96, 80, (x, y) => [
      180 + 50 * Math.sin(x / 40) - 0.004 * (y - 40) ** 2,
      140 + 40 * Math.cos(y / 50) + 0.2 * x,
      120 + 0.003 * (x - 48) ** 2 + 0.3 * y,
    ]);
    const hole = ellipseMask(96, 80, 48, 40, 14, 10);
    const filled = inpaint(shaded, hole);
    const err = holeError(filled, shaded, hole);
    expect(err.max).toBeLessThanOrEqual(4);
    expect(err.mean).toBeLessThan(1.5);
  });

  it('fills a large hole (coarse-to-fine) as accurately as a small one', () => {
    const big = imageFrom(240, 180, (x, y) => [20 + x, 30 + y, 250 - 0.5 * x - 0.5 * y]);
    const hole = rectHole(240, 180, 30, 30, 180, 120);
    const filled = inpaint(big, hole);
    const err = holeError(filled, big, hole);
    expect(err.max).toBeLessThanOrEqual(2);
    expect(err.mean).toBeLessThan(0.4);
  });

  it('leaves every pixel outside the hole untouched and does not modify its input', () => {
    const hole = ellipseMask(64, 48, 30, 22, 9, 6);
    const before = Array.from(linear.data);
    const filled = inpaint(linear, hole);
    expect(Array.from(linear.data)).toEqual(before);
    let changedOutside = 0;
    for (let i = 0; i < hole.data.length; i++) {
      if (hole.data[i] > 0) continue;
      for (let c = 0; c < 4; c++) if (filled.data[i * 4 + c] !== linear.data[i * 4 + c]) changedOutside++;
    }
    expect(changedOutside).toBe(0);
    expect(filled.data).not.toBe(linear.data);
  });

  it('obeys the maximum principle: no NaN, no overshoot beyond the surrounding colours', () => {
    const noisy = imageFrom(40, 40, (x, y) => [(x * 37 + y * 91) % 256, (x * 53 + y * 17) % 200, 30 + ((x * y) % 180)]);
    const hole = rectHole(40, 40, 10, 12, 20, 14);
    const filled = inpaint(noisy, hole);
    // The ring of pixels just around the hole bounds every filled value.
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (let y = 11; y <= 26; y++) {
      for (let x = 9; x <= 30; x++) {
        if (x >= 10 && x < 30 && y >= 12 && y < 26) continue;
        for (let c = 0; c < 3; c++) {
          lo[c] = Math.min(lo[c], px(noisy, x, y)[c]);
          hi[c] = Math.max(hi[c], px(noisy, x, y)[c]);
        }
      }
    }
    for (let y = 12; y < 26; y++) {
      for (let x = 10; x < 30; x++) {
        const p = px(filled, x, y);
        expect(p[3]).toBe(255);
        for (let c = 0; c < 3; c++) {
          expect(p[c]).toBeGreaterThanOrEqual(lo[c]);
          expect(p[c]).toBeLessThanOrEqual(hi[c]);
        }
      }
    }
  });

  it('ignores fully transparent neighbours: their stored colour never leaks in', () => {
    // Left half opaque blue; right half transparent with red stored in its RGB.
    const img = imageFrom(40, 20, (x) => (x < 20 ? [0, 0, 255, 255] : [255, 0, 0, 0]));
    const hole = rectHole(40, 20, 12, 6, 16, 8);
    for (const alpha of ['opaque', 'diffuse', 'keep'] as const) {
      const filled = inpaint(img, hole, { alpha });
      for (let y = 6; y < 14; y++) {
        for (let x = 12; x < 28; x++) {
          const p = px(filled, x, y);
          expect([p[0], p[1], p[2]]).toEqual([0, 0, 255]);
          if (alpha === 'opaque') expect(p[3]).toBe(255);
          if (alpha === 'keep') expect(p[3]).toBe(x < 20 ? 255 : 0);
        }
      }
    }
  });

  it('"diffuse" interpolates alpha between the opaque and the transparent side', () => {
    const img = imageFrom(40, 20, (x) => (x < 20 ? [0, 0, 255, 255] : [255, 0, 0, 0]));
    const hole = rectHole(40, 20, 12, 0, 16, 20);
    const filled = inpaint(img, hole);
    const row = Array.from({ length: 16 }, (_, k) => px(filled, 12 + k, 10)[3]);
    for (let k = 1; k < row.length; k++) expect(row[k]).toBeLessThan(row[k - 1]);
    expect(row[0]).toBeGreaterThan(220);
    expect(row[15]).toBeLessThan(35);
    // The hole spans the full height, so alpha is a straight ramp from 255 at x = 11 to 0 at x = 28.
    row.forEach((a, k) => expect(Math.abs(a - 255 * (1 - (k + 1) / 17))).toBeLessThanOrEqual(2));
    // Fully opaque surroundings give an opaque fill without a second solve.
    const opaque = imageFrom(20, 20, (x, y) => [x * 10, y * 10, 0]);
    expect(px(inpaint(opaque, rectHole(20, 20, 5, 5, 8, 8)), 9, 9)[3]).toBe(255);
  });

  it('weights partly transparent neighbours by their alpha', () => {
    // A 1-pixel-high strip: opaque red on the left, a faint green pixel on the right of a 1-pixel hole.
    const img = imageFrom(3, 1, (x) => [[255, 0, 0, 255], [9, 9, 9, 255], [0, 255, 0, 102]][x]);
    const hole = createMask(3, 1);
    hole.data[1] = 1;
    const p = px(inpaint(img, hole, { alpha: 'opaque' }), 1, 0);
    // Weights 1 and 0.4: (255 * 1 + 0 * 0.4) / 1.4 = 182.1 and (255 * 0.4) / 1.4 = 72.9.
    expect(p).toEqual([182, 73, 0, 255]);
  });

  it('cannot fill a hole surrounded by transparency: it becomes transparent', () => {
    const img = imageFrom(12, 12, (x, y) => (x >= 4 && x < 8 && y >= 4 && y < 8 ? [200, 100, 50, 255] : [7, 7, 7, 0]));
    const hole = rectHole(12, 12, 4, 4, 4, 4);
    expect(px(inpaint(img, hole, { alpha: 'opaque' }), 5, 5)[3]).toBe(0);
    expect(px(inpaint(img, hole), 5, 5)[3]).toBe(0);
    expect(px(inpaint(img, hole, { alpha: 'keep' }), 5, 5)).toEqual([200, 100, 50, 255]);
    // A hole that covers the whole image has nothing to copy from either.
    const all = inpaint(imageFrom(4, 4, () => [1, 2, 3]), createMask(4, 4, 1));
    expect(px(all, 2, 2)[3]).toBe(0);
  });

  it('takes colours only from the allowed sources', () => {
    // Red on the left, green on the right, a hole in between.
    const img = imageFrom(30, 10, (x) => (x < 15 ? [220, 30, 30] : [30, 220, 30]));
    const hole = rectHole(30, 10, 10, 2, 10, 6);
    const mixed = px(inpaint(img, hole), 15, 5);
    expect(mixed[0]).toBeGreaterThan(60);
    expect(mixed[1]).toBeGreaterThan(60);
    const onlyRed = createMask(30, 10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 15; x++) onlyRed.data[y * 30 + x] = 1;
    const filled = inpaint(img, hole, { sources: onlyRed });
    for (let y = 2; y < 8; y++) for (let x = 10; x < 20; x++) expect(px(filled, x, y)).toEqual([220, 30, 30, 255]);
    expect(() => inpaint(img, hole, { sources: createMask(3, 3) })).toThrow(/inpaint: sizes differ/);
  });

  it('blends pixels with a partial mask value between the original and the fill', () => {
    const img = imageFrom(5, 1, (x) => (x === 2 ? [0, 0, 0] : [200, 100, 60]));
    const hole = createMask(5, 1);
    hole.data[2] = 0.5;
    expect(px(inpaint(img, hole), 2, 0)).toEqual([100, 50, 30, 255]);
    hole.data[2] = 1;
    expect(px(inpaint(img, hole), 2, 0)).toEqual([200, 100, 60, 255]);
    hole.data[2] = 0.25;
    expect(px(inpaint(img, hole), 2, 0)).toEqual([50, 25, 15, 255]);
  });

  it('handles holes at the image border and several separate holes at once', () => {
    const img = imageFrom(30, 20, (x, y) => [100 + 5 * x, 50 + 10 * y, 80]);
    const hole = createMask(30, 20);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) hole.data[y * 30 + x] = 1;
    for (let y = 12; y < 18; y++) for (let x = 20; x < 30; x++) hole.data[y * 30 + x] = 1;
    const filled = inpaint(img, hole);
    for (let i = 0; i < hole.data.length; i++) expect(filled.data[i * 4 + 3]).toBe(255);
    // Interior of the second hole continues the gradient; at the border the fill is the natural (flat) extension.
    expect(Math.abs(px(filled, 23, 15)[1] - (50 + 10 * 15))).toBeLessThanOrEqual(3);
    expect(px(filled, 0, 0)[0]).toBeGreaterThanOrEqual(100);
    expect(px(filled, 0, 0)[0]).toBeLessThanOrEqual(100 + 5 * 6);
  });

  it('is deterministic and returns a copy for an empty hole', () => {
    const hole = ellipseMask(64, 48, 28, 20, 11, 8);
    const a = inpaint(linear, hole);
    const b = inpaint(linear, hole);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    const same = inpaint(linear, createMask(64, 48));
    expect(same.data).not.toBe(linear.data);
    expect(Array.from(same.data)).toEqual(Array.from(linear.data));
    expect(() => inpaint(linear, createMask(8, 8))).toThrow(/inpaint: sizes differ/);
  });

  it('more sweeps do not change a converged fill', () => {
    const hole = rectHole(64, 48, 22, 14, 20, 18);
    const a = inpaint(linear, hole);
    const b = inpaint(linear, hole, { iterations: 400 });
    expect(holeError(a, b, hole).max).toBeLessThanOrEqual(1);
  });
});

describe('extendEdges', () => {
  it('bleeds colour into transparent neighbours without touching alpha', () => {
    const img = imageFrom(11, 11, (x, y) => (Math.abs(x - 5) <= 1 && Math.abs(y - 5) <= 1 ? [200, 40, 10, 255] : [0, 0, 0, 0]));
    const out = extendEdges(img, 2);
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) {
        const ring = Math.max(Math.abs(x - 5), Math.abs(y - 5));
        const p = px(out, x, y);
        expect(p[3]).toBe(px(img, x, y)[3]);
        expect([p[0], p[1], p[2]]).toEqual(ring <= 3 ? [200, 40, 10] : [0, 0, 0]);
      }
    }
  });

  it('averages the colours of the visible neighbours', () => {
    // Red and blue pixels with one transparent pixel between them.
    const img = imageFrom(3, 1, (x) => [[255, 0, 0, 255], [0, 0, 0, 0], [0, 0, 255, 255]][x]);
    expect(px(extendEdges(img, 1), 1, 0)).toEqual([128, 0, 128, 0]);
    // A faint neighbour counts in proportion to its alpha.
    const faint = imageFrom(3, 1, (x) => [[255, 0, 0, 255], [0, 0, 0, 0], [0, 0, 255, 102]][x]);
    expect(px(extendEdges(faint, 1), 1, 0)).toEqual([182, 0, 73, 0]);
  });

  it('grows one ring per pixel of radius and fills everything with Infinity', () => {
    const img = imageFrom(20, 1, (x) => (x === 0 ? [90, 80, 70, 255] : [0, 0, 0, 0]));
    const some = extendEdges(img, 5);
    expect(px(some, 5, 0)).toEqual([90, 80, 70, 0]);
    expect(px(some, 6, 0)).toEqual([0, 0, 0, 0]);
    const all = extendEdges(img, Infinity);
    for (let x = 0; x < 20; x++) expect(px(all, x, 0).slice(0, 3)).toEqual([90, 80, 70]);
    expect(px(extendEdges(img), 4, 0)).toEqual([90, 80, 70, 0]);
    expect(px(extendEdges(img), 5, 0)).toEqual([0, 0, 0, 0]);
  });

  it('keeps visible pixels exactly, also partly transparent ones', () => {
    const img = imageFrom(6, 6, (x, y) => [x * 40, y * 40, 99, x < 3 ? 255 : x === 3 ? 100 : 0]);
    const out = extendEdges(img, 3);
    for (let y = 0; y < 6; y++) for (let x = 0; x <= 3; x++) expect(px(out, x, y)).toEqual(px(img, x, y));
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(img.data[i]);
    expect(out.data).not.toBe(img.data);
  });

  it('treats pixels below minAlpha as receivers', () => {
    const img = imageFrom(3, 1, (x) => [[10, 200, 30, 255], [250, 0, 250, 3], [0, 0, 0, 0]][x]);
    expect(px(extendEdges(img, 2), 1, 0)).toEqual([250, 0, 250, 3]);
    const strict = extendEdges(img, 2, { minAlpha: 8 });
    expect(px(strict, 1, 0)).toEqual([10, 200, 30, 3]);
    expect(px(strict, 2, 0)).toEqual([10, 200, 30, 0]);
  });

  it('returns an unchanged copy for fully opaque or fully transparent images and radius 0', () => {
    const opaque = imageFrom(4, 4, (x, y) => [x, y, 5]);
    expect(Array.from(extendEdges(opaque, 3).data)).toEqual(Array.from(opaque.data));
    const empty = imageFrom(4, 4, () => [9, 9, 9, 0]);
    expect(Array.from(extendEdges(empty, 3).data)).toEqual(Array.from(empty.data));
    const mixed = imageFrom(4, 1, (x) => [50, 60, 70, x < 2 ? 255 : 0]);
    expect(Array.from(extendEdges(mixed, 0).data)).toEqual(Array.from(mixed.data));
  });

  it('does not depend on the scan order (a symmetric shape gives a symmetric result)', () => {
    const disc = maskFromRows(['.......', '..###..', '.#####.', '.#####.', '.#####.', '..###..', '.......']);
    const img = imageFrom(7, 7, (x, y) => [10 + x * 30, 10 + x * 30, 77, disc.data[y * 7 + x] ? 255 : 0]);
    const out = extendEdges(img, 2);
    // The picture is symmetric top to bottom: so is the result.
    for (let y = 0; y < 3; y++) for (let x = 0; x < 7; x++) expect(px(out, x, y)).toEqual(px(out, x, 6 - y));
    expect(Array.from(extendEdges(img, 2).data)).toEqual(Array.from(out.data));
  });
});
