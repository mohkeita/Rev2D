import { describe, expect, it } from 'vitest';
import { imageToLab, rgbToLab } from '../color.js';
import { connectedComponents, fillHoles, growRegion, keepLargestComponent, removeSmallComponents } from '../components.js';
import { createMask, maskArea, maskCount } from '../mask.js';
import { ellipseMask } from '../raster.js';
import { at, imageFrom, maskFromRows, rowsOf } from './helpers.js';

describe('connectedComponents', () => {
  const m = maskFromRows([
    '##....#',
    '##...#.',
    '.......',
    '..#....',
    '.#.#..#',
    '..#...#',
  ]);

  it('labels with 8-connectivity by default: diagonal neighbours join', () => {
    const c = connectedComponents(m);
    expect(c.count).toBe(4);
    expect(c.components.map((k) => k.area)).toEqual([4, 2, 4, 2]);
    expect(c.components.map((k) => k.label)).toEqual([1, 2, 3, 4]);
    expect(c.components[0].bounds).toEqual({ x: 0, y: 0, width: 2, height: 2 });
    expect(c.components[1].bounds).toEqual({ x: 5, y: 0, width: 2, height: 2 });
    expect(c.components[2].bounds).toEqual({ x: 1, y: 3, width: 3, height: 3 });
    expect(c.components[3].bounds).toEqual({ x: 6, y: 4, width: 1, height: 2 });
    expect(c.labels[0]).toBe(1);
    expect(c.labels[6]).toBe(2);
    expect(c.labels[1 * 7 + 5]).toBe(2);
    expect(c.labels[3 * 7 + 2]).toBe(3);
    expect(c.labels[5 * 7 + 2]).toBe(3);
    expect(c.labels[2 * 7 + 3]).toBe(0);
    expect(c.width).toBe(7);
    expect(c.height).toBe(6);
  });

  it('separates diagonal neighbours with 4-connectivity', () => {
    const c = connectedComponents(m, { connectivity: 4 });
    expect(c.count).toBe(8);
    expect(c.components.map((k) => k.area)).toEqual([4, 1, 1, 1, 1, 1, 2, 1]);
  });

  it('labels and areas are consistent', () => {
    const c = connectedComponents(m);
    const counts = new Array(c.count + 1).fill(0);
    for (const l of c.labels) counts[l]++;
    c.components.forEach((k) => expect(counts[k.label]).toBe(k.area));
    expect(counts[0]).toBe(m.data.length - maskCount(m));
  });

  it('uses the threshold', () => {
    const soft = createMask(5, 1);
    soft.data.set([0.2, 0.6, 0.3, 0.6, 0.9]);
    expect(connectedComponents(soft).count).toBe(2);
    expect(connectedComponents(soft, { threshold: 0.25 }).count).toBe(1);
    expect(connectedComponents(soft, { threshold: 0.95 }).count).toBe(0);
  });

  it('handles empty, full and large snaking shapes without recursion limits', () => {
    expect(connectedComponents(createMask(4, 4)).count).toBe(0);
    const full = connectedComponents(createMask(300, 300, 1));
    expect(full.count).toBe(1);
    expect(full.components[0].area).toBe(90000);
    // A one-pixel-wide spiral-like comb: one long component.
    const comb = createMask(101, 101);
    for (let y = 0; y < 101; y++) for (let x = 0; x < 101; x++) if (y % 2 === 0 || (x === (y % 4 === 1 ? 100 : 0))) comb.data[y * 101 + x] = 1;
    expect(connectedComponents(comb, { connectivity: 4 }).count).toBe(1);
  });
});

describe('keepLargestComponent / removeSmallComponents', () => {
  it('keeps only the largest component', () => {
    const m = maskFromRows(['##...#', '##....', '....##', '...###']);
    expect(rowsOf(keepLargestComponent(m))).toEqual(['......', '......', '....##', '...###']);
    expect(maskArea(keepLargestComponent(createMask(3, 3)))).toBe(0);
  });

  it('the first component wins a tie', () => {
    const m = maskFromRows(['##..##', '......']);
    expect(rowsOf(keepLargestComponent(m))).toEqual(['##....', '......']);
  });

  it('keeps the antialiased rim of the kept component and drops the rest', () => {
    const disc = ellipseMask(40, 30, 14.3, 15.2, 9, 9);
    const speck = ellipseMask(40, 30, 33.5, 8.5, 1.6, 1.6);
    const both = createMask(40, 30);
    for (let i = 0; i < both.data.length; i++) both.data[i] = Math.max(disc.data[i], speck.data[i]);
    const kept = keepLargestComponent(both);
    expect(Array.from(kept.data)).toEqual(Array.from(disc.data));
    const cleaned = removeSmallComponents(both, 20);
    expect(Array.from(cleaned.data)).toEqual(Array.from(disc.data));
    expect(Array.from(removeSmallComponents(both, 1).data)).toEqual(Array.from(both.data));
  });

  it('removes components below the minimum area', () => {
    const m = maskFromRows(['#..##..###', '......#...', '..........']);
    expect(rowsOf(removeSmallComponents(m, 2))).toEqual(['...##..###', '......#...', '..........']);
    expect(rowsOf(removeSmallComponents(m, 3))).toEqual(['.......###', '......#...', '..........']);
    expect(rowsOf(removeSmallComponents(m, 3, { connectivity: 4 }))).toEqual(['.......###', '..........', '..........']);
    expect(maskArea(removeSmallComponents(m, 100))).toBe(0);
  });
});

describe('fillHoles', () => {
  it('fills regions enclosed by the mask and nothing else', () => {
    const ring = maskFromRows(['.......', '.#####.', '.#...#.', '.#.#.#.', '.#...#.', '.#####.', '.......']);
    expect(rowsOf(fillHoles(ring))).toEqual(['.......', '.#####.', '.#####.', '.#####.', '.#####.', '.#####.', '.......']);
    expect(maskArea(fillHoles(ring))).toBe(25);
  });

  it('does not fill a region that reaches the image border', () => {
    const open = maskFromRows(['.#####.', '.#...#.', '.#...#.', '.#.....', '.#####.']);
    expect(rowsOf(fillHoles(open))).toEqual(rowsOf(open));
    const touching = maskFromRows(['#####', '#...#', '#...#']);
    expect(rowsOf(fillHoles(touching))).toEqual(rowsOf(touching));
  });

  it('treats a diagonal gap as closed for an 8-connected outline and open for a 4-connected one', () => {
    const diamond = maskFromRows(['..#..', '.#.#.', '#...#', '.#.#.', '..#..']);
    expect(rowsOf(fillHoles(diamond))).toEqual(['..#..', '.###.', '#####', '.###.', '..#..']);
    expect(rowsOf(fillHoles(diamond, { connectivity: 4 }))).toEqual(rowsOf(diamond));
  });

  it('only fills holes up to maxArea', () => {
    const m = maskFromRows(['#########', '#.#.....#', '#.#.....#', '#########']);
    expect(rowsOf(fillHoles(m, { maxArea: 2 }))).toEqual(['#########', '###.....#', '###.....#', '#########']);
    expect(maskArea(fillHoles(m))).toBe(36);
    expect(maskArea(fillHoles(m, { maxArea: 1 }))).toBe(maskArea(m));
  });

  it('keeps soft values outside the holes', () => {
    const disc = ellipseMask(30, 30, 15, 15, 10, 10);
    const hole = ellipseMask(30, 30, 15, 15, 4, 4);
    const ring = createMask(30, 30);
    for (let i = 0; i < ring.data.length; i++) ring.data[i] = Math.max(0, disc.data[i] - hole.data[i]);
    const filled = fillHoles(ring);
    expect(at(filled, 15, 15)).toBe(1);
    // The outer antialiased rim is unchanged.
    for (let i = 0; i < ring.data.length; i++) if (hole.data[i] === 0) expect(filled.data[i]).toBe(ring.data[i]);
  });
});

describe('growRegion', () => {
  // Left: a reddish gradient; right: blue; a 1 px dark line between them at x = 20.
  const img = imageFrom(40, 20, (x, y) => (x < 20 ? [200 + x, 60 + y, 50] : x === 20 ? [10, 10, 10] : [40, 60, 220]));

  it('grows through similar colours and stops at different ones', () => {
    const region = growRegion(img, [5.5, 5.5], { tolerance: 20 });
    expect(maskArea(region)).toBe(20 * 20);
    expect(at(region, 0, 0)).toBe(1);
    expect(at(region, 19, 19)).toBe(1);
    expect(at(region, 20, 10)).toBe(0);
    expect(at(region, 30, 10)).toBe(0);
    const blue = growRegion(img, [30, 10], { tolerance: 5 });
    expect(maskArea(blue)).toBe(19 * 20);
  });

  it('a small tolerance keeps the region near the seed colour', () => {
    const tight = growRegion(img, [0.5, 0.5], { tolerance: 3 });
    expect(maskArea(tight)).toBeGreaterThan(0);
    expect(maskArea(tight)).toBeLessThan(120);
    expect(at(tight, 0, 0)).toBe(1);
    expect(at(tight, 19, 19)).toBe(0);
  });

  it('accepts seeds as a mask, as points and a LabImage as the picture: same result', () => {
    const seeds = createMask(40, 20);
    seeds.data[5 * 40 + 5] = 1;
    const a = growRegion(img, seeds, { tolerance: 20 });
    const b = growRegion(img, [5.2, 5.9], { tolerance: 20 });
    const c = growRegion(imageToLab(img), seeds, { tolerance: 20 });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(Array.from(a.data)).toEqual(Array.from(c.data));
  });

  it('never leaves the limit mask', () => {
    const limit = ellipseMask(40, 20, 8, 10, 6, 6);
    const region = growRegion(img, [8, 10], { tolerance: 50, limit });
    let outside = 0;
    for (let i = 0; i < region.data.length; i++) if (region.data[i] && limit.data[i] < 0.5) outside++;
    expect(outside).toBe(0);
    expect(maskArea(region)).toBe(maskCount(limit));
  });

  it('matches against several reference colours', () => {
    // Stripes of two tones of one material plus a third colour.
    const striped = imageFrom(30, 10, (x) => (x >= 24 ? [20, 200, 40] : Math.floor(x / 3) % 2 ? [90, 60, 40] : [150, 110, 80]));
    const one = growRegion(striped, [1, 5], { tolerance: 8 });
    expect(maskArea(one)).toBe(3 * 10);
    const both = growRegion(striped, [1, 5], { tolerance: 8, references: [rgbToLab(90, 60, 40), rgbToLab(150, 110, 80)] });
    expect(maskArea(both)).toBe(24 * 10);
    expect(at(both, 25, 5)).toBe(0);
  });

  it('with maxStep it follows a gradient but does not cross a sharp edge', () => {
    // A wide smooth ramp, then a jump.
    const ramp = imageFrom(60, 6, (x) => (x < 50 ? [20 + x * 4, 20 + x * 4, 20 + x * 4] : [0, 0, 0]));
    const followed = growRegion(ramp, [1, 3], { tolerance: Infinity, maxStep: 4 });
    expect(maskArea(followed)).toBe(50 * 6);
    // Without the step test and with a tolerance that covers only part of the ramp the region is cut short.
    const cut = growRegion(ramp, [1, 3], { tolerance: 20 });
    expect(maskArea(cut)).toBeLessThan(50 * 6);
    expect(maskArea(cut)).toBeGreaterThan(0);
  });

  it('skips transparent pixels and respects minAlpha', () => {
    const cut = imageFrom(20, 10, (x) => [100, 150, 200, x < 8 ? 255 : x < 12 ? 0 : 255]);
    const region = growRegion(cut, [2, 5], { tolerance: 10 });
    expect(maskArea(region)).toBe(8 * 10);
    const faint = imageFrom(20, 10, (x) => [100, 150, 200, x < 8 ? 255 : 40]);
    expect(maskArea(growRegion(faint, [2, 5], { tolerance: 10 }))).toBe(20 * 10);
    expect(maskArea(growRegion(faint, [2, 5], { tolerance: 10, minAlpha: 128 }))).toBe(8 * 10);
  });

  it('ignores seeds that are not acceptable themselves', () => {
    // A seed stroke over both colours with the red as the only reference: blue seeds are dropped.
    const seeds = createMask(40, 20);
    for (let x = 2; x < 38; x++) seeds.data[10 * 40 + x] = 1;
    const region = growRegion(img, seeds, { tolerance: 25, references: [rgbToLab(210, 70, 50)] });
    expect(maskArea(region)).toBe(20 * 20);
    expect(at(region, 30, 10)).toBe(0);
    // Seeds outside the picture or in transparent areas give an empty region, not an error.
    expect(maskArea(growRegion(img, [-5, -5, 100, 3], { tolerance: 10 }))).toBe(0);
    expect(maskArea(growRegion(img, [], { tolerance: 10 }))).toBe(0);
  });

  it('spreads through diagonal gaps only with 8-connectivity', () => {
    // Two white squares touching at a corner on black.
    const corner = imageFrom(8, 8, (x, y) => ((x < 4 && y < 4) || (x >= 4 && y >= 4) ? [255, 255, 255] : [0, 0, 0]));
    expect(maskArea(growRegion(corner, [1, 1], { tolerance: 5 }))).toBe(16);
    expect(maskArea(growRegion(corner, [1, 1], { tolerance: 5, connectivity: 8 }))).toBe(32);
  });

  it('is deterministic and rejects a limit of another size', () => {
    const a = growRegion(img, [5, 5, 30, 10], { tolerance: 12, maxStep: 6 });
    const b = growRegion(img, [5, 5, 30, 10], { tolerance: 12, maxStep: 6 });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(() => growRegion(img, [1, 1], { tolerance: 5, limit: createMask(3, 3) })).toThrow(/growRegion: sizes differ/);
    expect(() => growRegion(img, [1, 1], { tolerance: -1 })).toThrow(/tolerance must be a number >= 0/);
    expect(() => growRegion(img, [1, 1], { tolerance: Number.NaN })).toThrow(RangeError);
    // Tolerance 0 keeps exactly the pixels of the seed's colour.
    expect(maskArea(growRegion(img, [30, 10], { tolerance: 0 }))).toBe(19 * 20);
  });
});
