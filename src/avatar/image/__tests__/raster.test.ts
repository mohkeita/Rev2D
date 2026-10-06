import { describe, expect, it } from 'vitest';
import { createMask, maskArea, maskBounds } from '../mask.js';
import { pointInPolygon, polygonArea } from '../polygon.js';
import { mulberry32 } from '../random.js';
import { bandMask, bandValue, ellipseMask, fillPolygon, polygonMask, smoothstep, strokeMask } from '../raster.js';
import type { Mask } from '../types.js';
import { at, rangeOf } from './helpers.js';

function reversed(points: number[]): number[] {
  const out: number[] = [];
  for (let i = points.length - 2; i >= 0; i -= 2) out.push(points[i], points[i + 1]);
  return out;
}

function maxDiff(a: Mask, b: Mask): number {
  let d = 0;
  for (let i = 0; i < a.data.length; i++) d = Math.max(d, Math.abs(a.data[i] - b.data[i]));
  return d;
}

/** Coverage of pixel (x, y) by supersampling point-in-polygon tests (n x n samples). */
function supersample(points: number[], x: number, y: number, n = 16): number {
  let hits = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (pointInPolygon(points, x + (i + 0.5) / n, y + (j + 0.5) / n)) hits++;
  return hits / (n * n);
}

describe('polygonMask', () => {
  it('fills a pixel-aligned square exactly', () => {
    const m = polygonMask(10, 10, [2, 2, 8, 2, 8, 8, 2, 8]);
    expect(maskArea(m)).toBe(36);
    expect(at(m, 2, 2)).toBe(1);
    expect(at(m, 7, 7)).toBe(1);
    expect(at(m, 1, 2)).toBe(0);
    expect(at(m, 8, 7)).toBe(0);
    expect(maskBounds(m)).toEqual({ x: 2, y: 2, width: 6, height: 6 });
  });

  it('gives fractional pixels their exact covered area', () => {
    const m = polygonMask(8, 6, [1.5, 1.25, 4.5, 1.25, 4.5, 3.75, 1.5, 3.75]);
    expect(maskArea(m)).toBeCloseTo(3 * 2.5, 6);
    expect(at(m, 1, 1)).toBeCloseTo(0.5 * 0.75, 6);
    expect(at(m, 2, 1)).toBeCloseTo(0.75, 6);
    expect(at(m, 2, 2)).toBe(1);
    expect(at(m, 4, 3)).toBeCloseTo(0.5 * 0.75, 6);
    expect(at(m, 5, 3)).toBe(0);
  });

  it('antialiases a diagonal edge: pixels cut in half are 0.5', () => {
    const m = polygonMask(10, 10, [0, 0, 10, 0, 0, 10]);
    expect(maskArea(m)).toBeCloseTo(50, 5);
    expect(at(m, 0, 0)).toBe(1);
    for (let k = 0; k < 10; k++) expect(at(m, k, 9 - k)).toBeCloseTo(0.5, 6);
    expect(at(m, 9, 9)).toBe(0);
    expect(at(m, 5, 5)).toBe(0);
  });

  it('gives the same mask for both windings', () => {
    const pts = [3.2, 1.7, 15.6, 4.1, 17.3, 14.8, 9.9, 18.2, 2.4, 11.5];
    const cw = polygonMask(20, 20, pts);
    const ccw = polygonMask(20, 20, reversed(pts));
    expect(polygonArea(pts) * polygonArea(reversed(pts))).toBeLessThan(0);
    expect(maxDiff(cw, ccw)).toBeLessThan(1e-6);
    expect(maskArea(cw)).toBeCloseTo(Math.abs(polygonArea(pts)), 3);
  });

  it('handles concave polygons: the notch stays empty', () => {
    // A "U" opening upward: the notch between the arms is outside.
    const u = [2, 2, 6, 2, 6, 12, 14, 12, 14, 2, 18, 2, 18, 17, 2, 17];
    const m = polygonMask(20, 20, u);
    expect(maskArea(m)).toBeCloseTo(Math.abs(polygonArea(u)), 4);
    expect(maskArea(m)).toBeCloseTo(16 * 15 - 8 * 10, 4);
    expect(at(m, 10, 5)).toBe(0);
    expect(at(m, 3, 5)).toBe(1);
    expect(at(m, 16, 5)).toBe(1);
    expect(at(m, 10, 14)).toBe(1);
    expect(maxDiff(m, polygonMask(20, 20, reversed(u)))).toBeLessThan(1e-6);
  });

  it('matches supersampled coverage for random star-shaped polygons, with the exact area', () => {
    const random = mulberry32(42);
    for (let trial = 0; trial < 4; trial++) {
      const pts: number[] = [];
      const n = 5 + trial * 3;
      for (let k = 0; k < n; k++) {
        const a = ((k + random() * 0.6) / n) * Math.PI * 2;
        const r = 4 + random() * 10;
        pts.push(16 + Math.cos(a) * r, 16 + Math.sin(a) * r);
      }
      const m = polygonMask(32, 32, pts);
      expect(maskArea(m)).toBeCloseTo(Math.abs(polygonArea(pts)), 3);
      expect(maxDiff(m, polygonMask(32, 32, reversed(pts)))).toBeLessThan(1e-6);
      let worst = 0;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) worst = Math.max(worst, Math.abs(at(m, x, y) - supersample(pts, x, y)));
      expect(worst).toBeLessThan(0.08);
      expect(rangeOf(m.data)).toEqual({ min: 0, max: 1, nan: false });
    }
  });

  it('clips polygons that leave the mask on any side', () => {
    expect(maskArea(polygonMask(10, 10, [-5, -5, 5, -5, 5, 5, -5, 5]))).toBeCloseTo(25, 6);
    expect(maskArea(polygonMask(10, 10, [6, 2, 20, 2, 20, 6, 6, 6]))).toBeCloseTo(16, 6);
    expect(maskArea(polygonMask(10, 10, [2, 6, 6, 6, 6, 30, 2, 30]))).toBeCloseTo(16, 6);
    expect(maskArea(polygonMask(10, 10, [-100, -100, 100, -100, 100, 100, -100, 100]))).toBe(100);
    // A triangle entering from the left: at x = 0 it spans y 2.5..7.5, at x = 10 the whole height.
    const tri = polygonMask(10, 10, [-10, 5, 10, 0, 10, 10]);
    expect(maskArea(tri)).toBeCloseTo(75, 5);
    expect(at(tri, 0, 5)).toBe(1);
    expect(at(tri, 0, 0)).toBe(0);
    // Entirely outside: nothing, and no error.
    expect(maskArea(polygonMask(10, 10, [20, 20, 30, 20, 30, 30]))).toBe(0);
    expect(maskArea(polygonMask(10, 10, [-30, 2, -20, 2, -20, 8]))).toBe(0);
  });

  it('matches the area of the visible part for an edge crossing the left border diagonally', () => {
    // A big diamond centred on the left border: half of it is visible.
    const diamond = [0, 2, 6, 8, 0, 14, -6, 8];
    const m = polygonMask(16, 16, diamond);
    expect(maskArea(m)).toBeCloseTo(Math.abs(polygonArea(diamond)) / 2, 5);
    const shifted = polygonMask(16, 16, [8, 2, 14, 8, 8, 14, 2, 8]);
    // The visible half equals the right half of the same diamond drawn inside.
    for (let y = 0; y < 16; y++) for (let x = 0; x < 6; x++) expect(at(m, x, y)).toBeCloseTo(at(shifted, x + 8, y), 6);
  });

  it('fills both lobes of a self-crossing outline and keeps same-winding overlaps filled', () => {
    const bowtie = polygonMask(10, 10, [0, 0, 10, 10, 10, 0, 0, 10]);
    expect(maskArea(bowtie)).toBeCloseTo(50, 5);
    expect(at(bowtie, 1, 5)).toBe(1);
    expect(at(bowtie, 8, 5)).toBe(1);
    expect(at(bowtie, 5, 1)).toBe(0);
    // A square traced twice in the same direction.
    const twice = polygonMask(10, 10, [2, 2, 8, 2, 8, 8, 2, 8, 2, 2, 8, 2, 8, 8, 2, 8]);
    expect(maskArea(twice)).toBe(36);
  });

  it('returns an empty mask for fewer than 3 points and rejects non-finite points', () => {
    expect(maskArea(polygonMask(5, 5, []))).toBe(0);
    expect(maskArea(polygonMask(5, 5, [1, 1, 4, 4]))).toBe(0);
    expect(() => polygonMask(5, 5, [1, 1, Number.NaN, 2, 3, 3])).toThrow(/not finite/);
  });

  it('fillPolygon unites with what is already in the mask', () => {
    const m = createMask(10, 10);
    fillPolygon(m, [0, 0, 4, 0, 4, 4, 0, 4]);
    fillPolygon(m, [2, 2, 6, 2, 6, 6, 2, 6]);
    expect(maskArea(m)).toBe(16 + 16 - 4);
    m.data[99] = 0.25;
    fillPolygon(m, [9.5, 9, 10, 9, 10, 10, 9.5, 10]);
    expect(at(m, 9, 9)).toBe(0.5);
  });

  it('is deterministic', () => {
    const pts = [3.3, 1.1, 27.2, 9.7, 12.5, 30.9];
    expect(Array.from(polygonMask(32, 32, pts).data)).toEqual(Array.from(polygonMask(32, 32, pts).data));
  });
});

describe('ellipseMask', () => {
  it('covers pi * a * b (well within 1%)', () => {
    for (const [cx, cy, rx, ry] of [
      [31.6, 30.2, 20.3, 11.7],
      [32, 32, 25, 25],
      [20.5, 40.25, 6.5, 14],
      [30, 30, 1.5, 2.5],
    ]) {
      const m = ellipseMask(64, 64, cx, cy, rx, ry);
      const expected = Math.PI * rx * ry;
      expect(Math.abs(maskArea(m) - expected) / expected).toBeLessThan(0.001);
    }
  });

  it('keeps its area when rotated and turns clockwise on screen', () => {
    const expected = Math.PI * 20 * 5;
    for (const rotation of [0, 17, 45, 90, -30, 200]) {
      const m = ellipseMask(64, 64, 32, 32, 20, 5, rotation);
      expect(Math.abs(maskArea(m) - expected) / expected).toBeLessThan(0.001);
    }
    // +45 degrees: the long axis points to the lower right (and upper left).
    const m = ellipseMask(64, 64, 32, 32, 20, 5, 45);
    expect(at(m, 42, 42)).toBe(1);
    expect(at(m, 22, 22)).toBe(1);
    expect(at(m, 42, 22)).toBe(0);
    expect(at(m, 22, 42)).toBe(0);
  });

  it('a quarter turn swaps the radii', () => {
    const a = ellipseMask(48, 48, 24.3, 23.8, 15, 7, 90);
    const b = ellipseMask(48, 48, 24.3, 23.8, 7, 15, 0);
    expect(maxDiff(a, b)).toBeLessThan(1e-4);
  });

  it('has the expected extent and values in 0..1', () => {
    const m = ellipseMask(40, 30, 20, 15, 10, 6);
    // The area-preserving outline pokes about 0.01 px past the true ellipse at its four extremes:
    // ignore that sliver of coverage.
    expect(maskBounds(m, 0.02)).toEqual({ x: 10, y: 9, width: 20, height: 12 });
    const loose = maskBounds(m)!;
    expect(loose.width).toBeLessThanOrEqual(22);
    expect(loose.height).toBeLessThanOrEqual(14);
    expect(at(m, 20, 15)).toBe(1);
    expect(rangeOf(m.data)).toEqual({ min: 0, max: 1, nan: false });
  });

  it('is clipped by the mask and empty for a zero radius', () => {
    const half = ellipseMask(40, 40, 0, 20, 10, 10);
    expect(maskArea(half)).toBeCloseTo((Math.PI * 100) / 2, 1);
    expect(maskArea(ellipseMask(10, 10, 5, 5, 0, 3))).toBe(0);
  });
});

describe('bandMask', () => {
  it('is 1 above yStart, 0 from yEnd and a smoothstep in between', () => {
    const m = bandMask(4, 10, 2, 6);
    expect(at(m, 0, 0)).toBe(1);
    expect(at(m, 3, 1)).toBe(1);
    expect(at(m, 0, 6)).toBe(0);
    expect(at(m, 2, 9)).toBe(0);
    // Row 3 has its centre at 3.5: t = 0.375.
    expect(at(m, 1, 3)).toBeCloseTo(1 - 0.375 * 0.375 * (3 - 0.75), 6);
    for (let y = 1; y < 10; y++) expect(at(m, 0, y)).toBeLessThanOrEqual(at(m, 0, y - 1));
    for (let y = 0; y < 10; y++) for (let x = 1; x < 4; x++) expect(at(m, x, y)).toBe(at(m, 0, y));
  });

  it('evaluates the band at any row position', () => {
    expect(bandValue(2, 6, 1)).toBe(1);
    expect(bandValue(2, 6, 4)).toBeCloseTo(0.5, 12);
    expect(bandValue(2, 6, 6)).toBe(0);
    expect(bandValue(2, 6, 3)).toBeGreaterThan(bandValue(2, 6, 5));
  });

  it('flips when yStart > yEnd and is a hard step when both are equal', () => {
    const flipped = bandMask(1, 10, 6, 2);
    expect(at(flipped, 0, 9)).toBe(1);
    expect(at(flipped, 0, 0)).toBe(0);
    expect(at(flipped, 0, 4)).toBeGreaterThan(at(flipped, 0, 3));
    const step = bandMask(1, 4, 2, 2);
    expect(Array.from(step.data)).toEqual([1, 1, 0, 0]);
  });

  it('smoothstep has zero slope at both ends', () => {
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0, 1, 0.001)).toBeLessThan(1e-5);
    expect(1 - smoothstep(0, 1, 0.999)).toBeLessThan(1e-5);
    expect(smoothstep(10, 20, 12.5)).toBeCloseTo(0.15625, 12);
  });
});

describe('strokeMask', () => {
  it('covers a capsule of the given radius around a segment', () => {
    const m = strokeMask(40, 20, [10, 10, 30, 10], 4);
    const expected = 20 * 8 + Math.PI * 16;
    expect(Math.abs(maskArea(m) - expected) / expected).toBeLessThan(0.015);
    expect(at(m, 20, 10)).toBe(1);
    expect(at(m, 20, 7)).toBe(1);
    expect(at(m, 20, 4)).toBe(0);
    expect(at(m, 7, 10)).toBe(1);
    expect(at(m, 4, 10)).toBe(0);
    // Antialiased edge: the pixel whose centre lies exactly on the radius is half covered.
    expect(at(strokeMask(40, 20, [10, 10.5, 30, 10.5], 4), 20, 14)).toBeCloseTo(0.5, 6);
  });

  it('draws a disc for a single point', () => {
    const m = strokeMask(30, 30, [15, 15], 6);
    const expected = Math.PI * 36;
    expect(Math.abs(maskArea(m) - expected) / expected).toBeLessThan(0.02);
  });

  it('follows a polyline with round joins and can close it', () => {
    const pts = [5, 5, 25, 5, 25, 25];
    const open = strokeMask(30, 30, pts, 2);
    expect(at(open, 15, 5)).toBe(1);
    expect(at(open, 25, 15)).toBe(1);
    expect(at(open, 25, 5)).toBe(1);
    expect(at(open, 15, 15)).toBe(0);
    const closed = strokeMask(30, 30, pts, 2, { closed: true });
    expect(at(closed, 15, 15)).toBe(1);
    expect(maskArea(closed)).toBeGreaterThan(maskArea(open));
  });

  it('fades outside the radius with the soft option, monotonically', () => {
    const m = strokeMask(60, 21, [10.5, 10.5, 50.5, 10.5], 3, { soft: 6 });
    const column = Array.from({ length: 11 }, (_, k) => at(m, 30, 10 + k));
    expect(column[0]).toBe(1);
    expect(column[3]).toBe(1);
    expect(column[6]).toBeCloseTo(0.5, 6);
    expect(column[9]).toBe(0);
    for (let k = 1; k < column.length; k++) expect(column[k]).toBeLessThanOrEqual(column[k - 1]);
  });

  it('is clipped by the mask and empty without points', () => {
    const m = strokeMask(10, 10, [-5, 5, 15, 5], 2);
    expect(at(m, 0, 5)).toBe(1);
    expect(at(m, 9, 5)).toBe(1);
    expect(at(m, 5, 0)).toBe(0);
    expect(maskArea(strokeMask(10, 10, [], 3))).toBe(0);
  });
});
