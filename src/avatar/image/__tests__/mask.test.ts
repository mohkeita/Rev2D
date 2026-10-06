import { describe, expect, it } from 'vitest';
import { createImage } from '../../../render/image.js';
import {
  alpha8,
  assertMask,
  assertSameSize,
  cloneMask,
  createMask,
  cropMask,
  maskArea,
  maskBounds,
  maskCount,
  maskFromAlpha,
  maskIntersect,
  maskInvert,
  maskMultiply,
  maskSubtract,
  maskThreshold,
  maskToGray,
  maskToImage,
  maskUnion,
  pasteMask,
  sampleMask,
} from '../mask.js';
import { polygonMask } from '../raster.js';
import { expandRect, intersectRect, pixelRect, unionRect } from '../types.js';
import { at, imageFrom, maskFromRows, px, rowsOf } from './helpers.js';

describe('masks: create, clone, convert', () => {
  it('creates a mask of the given size and fill', () => {
    const m = createMask(4, 3);
    expect(m.width).toBe(4);
    expect(m.height).toBe(3);
    expect(m.data).toBeInstanceOf(Float32Array);
    expect(Array.from(m.data)).toEqual(new Array(12).fill(0));
    expect(Array.from(createMask(2, 2, 0.25).data)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(createMask(0, 5).data.length).toBe(0);
  });

  it('rejects sizes that are not non-negative integers', () => {
    expect(() => createMask(-1, 2)).toThrow(RangeError);
    expect(() => createMask(2.5, 2)).toThrow(/createMask/);
  });

  it('clones without sharing data', () => {
    const a = maskFromRows(['#.', '.#']);
    const b = cloneMask(a);
    b.data[0] = 0;
    expect(at(a, 0, 0)).toBe(1);
    expect(b.width).toBe(2);
  });

  it('asserts well-formed masks and equal sizes', () => {
    expect(() => assertMask({ width: 2, height: 2, data: new Float32Array(3) }, 'test')).toThrow(/test: mask data length 3/);
    expect(() => assertMask(createMask(2, 2), 'test')).not.toThrow();
    expect(() => assertSameSize(createMask(2, 2), createMask(2, 3), 'op')).toThrow(/op: sizes differ \(2x2 vs 2x3\)/);
  });

  it('reads the alpha channel of an image as a mask', () => {
    const img = imageFrom(3, 1, (x) => [10, 20, 30, [0, 51, 255][x]]);
    const m = maskFromAlpha(img);
    expect(m.width).toBe(3);
    expect(at(m, 0, 0)).toBe(0);
    expect(at(m, 1, 0)).toBeCloseTo(0.2, 6);
    expect(at(m, 2, 0)).toBe(1);
  });

  it('writes a mask as the alpha of a one-colour image', () => {
    const m = createMask(3, 1);
    m.data.set([0, 0.5, 1]);
    const white = maskToImage(m);
    expect(px(white, 0, 0)).toEqual([255, 255, 255, 0]);
    expect(px(white, 1, 0)).toEqual([255, 255, 255, 128]);
    expect(px(white, 2, 0)).toEqual([255, 255, 255, 255]);
    expect(px(maskToImage(m, [10, 20, 30]), 2, 0)).toEqual([10, 20, 30, 255]);
    // Round trip through 8 bits.
    expect(at(maskFromAlpha(white), 1, 0)).toBeCloseTo(128 / 255, 6);
  });

  it('renders a mask as an opaque grey image', () => {
    const m = createMask(2, 1);
    m.data.set([0.25, 1]);
    const g = maskToGray(m);
    expect(px(g, 0, 0)).toEqual([64, 64, 64, 255]);
    expect(px(g, 1, 0)).toEqual([255, 255, 255, 255]);
  });

  it('converts coverage to 8 bits with clamping', () => {
    expect(alpha8(0)).toBe(0);
    expect(alpha8(1)).toBe(255);
    expect(alpha8(0.5)).toBe(128);
    expect(alpha8(-3)).toBe(0);
    expect(alpha8(7)).toBe(255);
    expect(alpha8(Number.NaN)).toBe(0);
  });
});

describe('masks: boolean operations', () => {
  const a = createMask(4, 1);
  a.data.set([0, 0.25, 0.75, 1]);
  const b = createMask(4, 1);
  b.data.set([1, 0.5, 0.5, 0.25]);

  it('union is the maximum, intersect the minimum, multiply the product', () => {
    expect(Array.from(maskUnion(a, b).data)).toEqual([1, 0.5, 0.75, 1]);
    expect(Array.from(maskIntersect(a, b).data)).toEqual([0, 0.25, 0.5, 0.25]);
    expect(Array.from(maskMultiply(a, b).data)).toEqual([0, 0.125, 0.375, 0.25]);
  });

  it('takes any number of masks', () => {
    const c = createMask(4, 1, 0.6);
    expect(Array.from(maskUnion(a, b, c).data)).toEqual([1, 0.6, 0.75, 1].map(Math.fround));
    expect(Array.from(maskIntersect(a).data)).toEqual(Array.from(a.data));
    expect(() => maskUnion()).toThrow(/at least one mask/);
  });

  it('subtract is max(0, a - b) and invert is 1 - a', () => {
    expect(Array.from(maskSubtract(a, b).data)).toEqual([0, 0, 0.25, 0.75]);
    expect(Array.from(maskInvert(a).data)).toEqual([1, 0.75, 0.25, 0]);
  });

  it('subtracting a shape cut from a region leaves no rim along the shared edge', () => {
    const region = polygonMask(20, 20, [2.3, 2.3, 17.6, 2.3, 17.6, 17.6, 2.3, 17.6]);
    const half = polygonMask(20, 20, [2.3, 2.3, 9.4, 2.3, 9.4, 17.6, 2.3, 17.6]);
    const rest = maskSubtract(region, half);
    // The rest is the rectangle from x = 9.4 to 17.6: its area is exact, and the shared outer edges are clean.
    expect(maskArea(rest)).toBeCloseTo((17.6 - 9.4) * (17.6 - 2.3), 3);
    expect(at(rest, 2, 10)).toBe(0);
    expect(at(rest, 5, 2)).toBe(0);
  });

  it('does not modify its inputs and rejects different sizes', () => {
    const before = Array.from(a.data);
    maskUnion(a, b);
    maskSubtract(a, b);
    maskInvert(a);
    expect(Array.from(a.data)).toEqual(before);
    expect(() => maskIntersect(a, createMask(3, 1))).toThrow(/maskIntersect: sizes differ/);
  });
});

describe('masks: threshold, bounds, area', () => {
  it('thresholds at 0.5 by default (inclusive)', () => {
    const m = createMask(4, 1);
    m.data.set([0.49, 0.5, 0.51, 1]);
    expect(Array.from(maskThreshold(m).data)).toEqual([0, 1, 1, 1]);
    expect(Array.from(maskThreshold(m, 0.9).data)).toEqual([0, 0, 0, 1]);
  });

  it('finds the bounding box of covered pixels', () => {
    const m = maskFromRows(['......', '..#...', '..##+.', '......']);
    expect(maskBounds(m)).toEqual({ x: 2, y: 1, width: 3, height: 2 });
    // With a threshold the soft pixel no longer counts.
    expect(maskBounds(m, 0.5)).toEqual({ x: 2, y: 1, width: 2, height: 2 });
    expect(maskBounds(createMask(5, 5))).toBeNull();
    expect(maskBounds(createMask(3, 2, 1))).toEqual({ x: 0, y: 0, width: 3, height: 2 });
    const single = createMask(7, 5);
    single.data[4 * 7 + 6] = 0.01;
    expect(maskBounds(single)).toEqual({ x: 6, y: 4, width: 1, height: 1 });
  });

  it('measures area as the sum and counts pixels above a threshold', () => {
    const m = maskFromRows(['#+.', '##.']);
    expect(maskArea(m)).toBeCloseTo(3.5, 6);
    expect(maskCount(m)).toBe(4);
    expect(maskCount(m, 0.75)).toBe(3);
  });
});

describe('masks: crop, paste, sample', () => {
  const m = maskFromRows(['#...', '.#..', '..#.', '...#']);

  it('crops with zero outside the mask', () => {
    expect(rowsOf(cropMask(m, 1, 1, 2, 2))).toEqual(['#.', '.#']);
    expect(rowsOf(cropMask(m, -1, -1, 3, 3))).toEqual(['...', '.#.', '..#']);
    expect(rowsOf(cropMask(m, 3, 3, 3, 2))).toEqual(['#..', '...']);
    expect(maskArea(cropMask(m, 10, 10, 2, 2))).toBe(0);
  });

  it('pastes in place, clipped, replacing or keeping the maximum', () => {
    const dst = createMask(4, 4, 0.5);
    pasteMask(dst, maskFromRows(['#.', '.#']), 3, 3);
    expect(at(dst, 3, 3)).toBe(1);
    expect(at(dst, 2, 2)).toBe(0.5);
    const dst2 = createMask(3, 1, 0.5);
    pasteMask(dst2, maskFromRows(['#.#']), 0, 0, 'max');
    expect(Array.from(dst2.data)).toEqual([1, 0.5, 1]);
    pasteMask(dst2, maskFromRows(['#.#']), 0, 0);
    expect(Array.from(dst2.data)).toEqual([1, 0, 1]);
    pasteMask(dst2, maskFromRows(['##']), -5, 0);
    expect(Array.from(dst2.data)).toEqual([1, 0, 1]);
  });

  it('crop followed by paste restores the region', () => {
    const copy = createMask(4, 4);
    pasteMask(copy, cropMask(m, 0, 0, 4, 4));
    expect(Array.from(copy.data)).toEqual(Array.from(m.data));
  });

  it('samples bilinearly with pixel centres at +0.5 and clamps outside', () => {
    const g = createMask(2, 2);
    g.data.set([0, 1, 2, 3]);
    expect(sampleMask(g, 0.5, 0.5)).toBe(0);
    expect(sampleMask(g, 1.5, 0.5)).toBe(1);
    expect(sampleMask(g, 1, 0.5)).toBeCloseTo(0.5, 6);
    expect(sampleMask(g, 1, 1)).toBeCloseTo(1.5, 6);
    expect(sampleMask(g, 0.5, 1.25)).toBeCloseTo(1.5, 6);
    expect(sampleMask(g, -10, -10)).toBe(0);
    expect(sampleMask(g, 99, 99)).toBe(3);
    expect(sampleMask(createMask(0, 0), 1, 1)).toBe(0);
  });
});

describe('rect helpers', () => {
  it('expands, unites and intersects', () => {
    expect(expandRect({ x: 10, y: 20, width: 4, height: 6 }, 2)).toEqual({ x: 8, y: 18, width: 8, height: 10 });
    expect(expandRect({ x: 10, y: 20, width: 4, height: 6 }, -3)).toEqual({ x: 12, y: 23, width: 0, height: 0 });
    expect(unionRect({ x: 0, y: 0, width: 2, height: 2 }, { x: 5, y: 1, width: 1, height: 4 })).toEqual({ x: 0, y: 0, width: 6, height: 5 });
    expect(intersectRect({ x: 0, y: 0, width: 4, height: 4 }, { x: 2, y: 3, width: 5, height: 5 })).toEqual({ x: 2, y: 3, width: 2, height: 1 });
    expect(intersectRect({ x: 0, y: 0, width: 2, height: 2 }, { x: 2, y: 0, width: 2, height: 2 })).toBeNull();
  });

  it('turns float bounds into a clipped whole-pixel crop rectangle', () => {
    expect(pixelRect({ x: 10.4, y: 20.6, width: 5.2, height: 3.1 }, 0, 100, 100)).toEqual({ x: 10, y: 20, width: 6, height: 4 });
    expect(pixelRect({ x: 10.4, y: 20.6, width: 5.2, height: 3.1 }, 2, 100, 100)).toEqual({ x: 8, y: 18, width: 10, height: 8 });
    expect(pixelRect({ x: -5, y: 95, width: 10, height: 10 }, 1, 100, 100)).toEqual({ x: 0, y: 94, width: 6, height: 6 });
    expect(pixelRect({ x: 200, y: 200, width: 10, height: 10 }, 0, 100, 100)).toEqual({ x: 100, y: 100, width: 0, height: 0 });
  });

  it('covers every covered pixel of a rasterised polygon', () => {
    const pts = [3.2, 4.7, 11.9, 5.1, 9.4, 12.3];
    const m = polygonMask(20, 20, pts);
    const b = maskBounds(m);
    const r = pixelRect({ x: 3.2, y: 4.7, width: 11.9 - 3.2, height: 12.3 - 4.7 }, 0, 20, 20);
    expect(b).not.toBeNull();
    expect(b!.x).toBeGreaterThanOrEqual(r.x);
    expect(b!.y).toBeGreaterThanOrEqual(r.y);
    expect(b!.x + b!.width).toBeLessThanOrEqual(r.x + r.width);
    expect(b!.y + b!.height).toBeLessThanOrEqual(r.y + r.height);
    expect(createImage(r.width, r.height).data.length).toBe(r.width * r.height * 4);
  });
});
