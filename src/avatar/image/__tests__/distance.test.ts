import { describe, expect, it } from 'vitest';
import { dilateMask, distanceTransform, erodeMask, featherMask, signedDistance } from '../distance.js';
import { cloneMask, createMask, cropMask, maskArea, maskThreshold, pasteMask } from '../mask.js';
import { mulberry32 } from '../random.js';
import { ellipseMask, polygonMask } from '../raster.js';
import type { Mask } from '../types.js';
import { at, maskFromRows, rangeOf } from './helpers.js';

function randomMask(width: number, height: number, density: number, seed: number): Mask {
  const random = mulberry32(seed);
  const m = createMask(width, height);
  for (let i = 0; i < m.data.length; i++) m.data[i] = random() < density ? 1 : 0;
  return m;
}

/** Distance to the nearest set pixel by trying every pair. */
function bruteForce(mask: Mask): number[] {
  const out: number[] = [];
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      let best = Infinity;
      for (let v = 0; v < mask.height; v++) {
        for (let u = 0; u < mask.width; u++) {
          if (mask.data[v * mask.width + u] >= 0.5) best = Math.min(best, (u - x) * (u - x) + (v - y) * (v - y));
        }
      }
      out.push(Math.fround(Math.sqrt(best)));
    }
  }
  return out;
}

describe('distanceTransform', () => {
  it('equals brute force on random masks of many sizes and densities', () => {
    const cases: [number, number, number][] = [
      [17, 13, 0.05],
      [13, 17, 0.3],
      [24, 9, 0.01],
      [1, 20, 0.2],
      [20, 1, 0.2],
      [31, 29, 0.002],
      [16, 16, 0.9],
      [9, 24, 0.5],
    ];
    cases.forEach(([w, h, density], k) => {
      for (let seed = 1; seed <= 3; seed++) {
        const m = randomMask(w, h, density, seed * 100 + k);
        expect(Array.from(distanceTransform(m).data)).toEqual(bruteForce(m));
      }
    });
  });

  it('is 0 on set pixels and Infinity for an empty mask', () => {
    expect(Array.from(distanceTransform(createMask(3, 2, 1)).data)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Array.from(distanceTransform(createMask(3, 2)).data)).toEqual(new Array(6).fill(Infinity));
    expect(distanceTransform(createMask(0, 0)).data.length).toBe(0);
  });

  it('measures between pixel centres', () => {
    const m = createMask(7, 5);
    m.data[2 * 7 + 1] = 1;
    const d = distanceTransform(m);
    expect(at(d, 1, 2)).toBe(0);
    expect(at(d, 4, 2)).toBe(3);
    expect(at(d, 4, 4)).toBeCloseTo(Math.sqrt(13), 6);
    expect(at(d, 0, 0)).toBeCloseTo(Math.sqrt(5), 6);
  });

  it('uses the threshold to decide which pixels are set', () => {
    const m = createMask(5, 1);
    m.data.set([0.2, 0.4, 0.6, 0.4, 0.2]);
    expect(Array.from(distanceTransform(m).data)).toEqual([2, 1, 0, 1, 2]);
    expect(Array.from(distanceTransform(m, 0.3).data)).toEqual([1, 0, 0, 0, 1]);
  });
});

describe('signedDistance', () => {
  it('is exact for a straight hard edge: the edge lies on the pixel boundary', () => {
    const m = createMask(16, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) m.data[y * 16 + x] = 1;
    const sd = signedDistance(m);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) expect(at(sd, x, y)).toBeCloseTo(x + 0.5 - 8, 5);
  });

  it('reads an antialiased straight edge with sub-pixel accuracy', () => {
    for (const edge of [8.0, 8.3, 8.5, 8.75]) {
      const m = polygonMask(16, 8, [0, 0, edge, 0, edge, 8, 0, 8]);
      const sd = signedDistance(m);
      for (let x = 0; x < 16; x++) expect(Math.abs(at(sd, x, 4) - (x + 0.5 - edge))).toBeLessThan(0.1);
    }
  });

  it('follows an antialiased disc within about a tenth of a pixel, at any distance', () => {
    for (const [cx, cy, r] of [
      [24.3, 23.6, 12],
      [20.5, 20.5, 7.25],
      [24, 24, 15.5],
    ]) {
      const sd = signedDistance(ellipseMask(48, 48, cx, cy, r, r));
      let worst = 0;
      let total = 0;
      for (let y = 0; y < 48; y++) {
        for (let x = 0; x < 48; x++) {
          const truth = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) - r;
          const err = Math.abs(at(sd, x, y) - truth);
          worst = Math.max(worst, err);
          total += err;
        }
      }
      expect(worst).toBeLessThan(0.16);
      expect(total / (48 * 48)).toBeLessThan(0.06);
    }
  });

  it('reads a diagonal antialiased edge as accurately as a straight one', () => {
    // The half plane x + y < 30.4: the true distance of a pixel centre is (x + y + 1 - 30.4) / sqrt(2).
    const m = polygonMask(32, 32, [-40, -40, 70.4, -40, -40, 70.4]);
    const sd = signedDistance(m);
    for (let y = 4; y < 28; y++) {
      for (let x = 4; x < 28; x++) {
        const truth = (x + y + 1 - 30.4) / Math.SQRT2;
        expect(Math.abs(at(sd, x, y) - truth)).toBeLessThan(0.1);
      }
    }
  });

  it('is negative inside, positive outside, and half a pixel off at most for binary shapes', () => {
    const disc = maskThreshold(ellipseMask(40, 40, 20, 20, 11, 11));
    const sd = signedDistance(disc);
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        const truth = Math.sqrt((x + 0.5 - 20) ** 2 + (y + 0.5 - 20) ** 2) - 11;
        expect(Math.sign(at(sd, x, y))).toBe(at(disc, x, y) ? -1 : 1);
        expect(Math.abs(at(sd, x, y) - truth)).toBeLessThan(0.55);
      }
    }
  });

  it('has no edge at the image border or in a uniform mask', () => {
    expect(Array.from(signedDistance(createMask(3, 2, 1)).data)).toEqual(new Array(6).fill(-Infinity));
    expect(Array.from(signedDistance(createMask(3, 2)).data)).toEqual(new Array(6).fill(Infinity));
    // A stripe that runs off the top and bottom: only its two sides are edges.
    const stripe = createMask(12, 6);
    for (let y = 0; y < 6; y++) for (let x = 4; x < 8; x++) stripe.data[y * 12 + x] = 1;
    const sd = signedDistance(stripe);
    for (let y = 0; y < 6; y++) {
      expect(at(sd, 5, y)).toBeCloseTo(-1.5, 5);
      expect(at(sd, 0, y)).toBeCloseTo(3.5, 5);
      expect(at(sd, 11, y)).toBeCloseTo(3.5, 5);
    }
  });

  it('handles a single pixel and one-pixel-wide masks', () => {
    const dot = createMask(9, 9);
    dot.data[4 * 9 + 4] = 1;
    const sd = signedDistance(dot);
    expect(at(sd, 4, 4)).toBeLessThan(0);
    expect(at(sd, 4, 4)).toBeGreaterThanOrEqual(-0.5);
    expect(at(sd, 8, 4)).toBeCloseTo(3.5, 5);
    expect(at(sd, 4, 0)).toBeCloseTo(3.5, 5);
    const line = createMask(5, 1);
    line.data.set([1, 1, 0, 0, 0]);
    expect(Array.from(signedDistance(line).data)).toEqual([-1.5, -0.5, 0.5, 1.5, 2.5]);
  });
});

describe('featherMask', () => {
  const disc = ellipseMask(64, 64, 32.2, 31.7, 16, 16);
  const trueDistance = (x: number, y: number): number => Math.sqrt((x + 0.5 - 32.2) ** 2 + (y + 0.5 - 31.7) ** 2) - 16;

  it('stays within 0..1 for every mode, radius and profile', () => {
    for (const mode of ['inward', 'outward', 'centered'] as const) {
      for (const radius of [0, 0.5, 1.5, 4, 10]) {
        for (const profile of ['smooth', 'linear'] as const) {
          const range = rangeOf(featherMask(disc, radius, mode, { profile }).data);
          expect(range).toEqual({ min: 0, max: 1, nan: false });
        }
      }
    }
  });

  it('puts the ramp inside, outside or across the edge', () => {
    const r = 6;
    const inward = featherMask(disc, r, 'inward');
    const outward = featherMask(disc, r, 'outward');
    const centered = featherMask(disc, r, 'centered');
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const d = trueDistance(x, y);
        if (d > 0.5) expect(at(inward, x, y)).toBe(0);
        if (d < -r - 0.5) expect(at(inward, x, y)).toBe(1);
        if (d < -0.5) expect(at(outward, x, y)).toBe(1);
        if (d > r + 0.5) expect(at(outward, x, y)).toBe(0);
        if (d < -r / 2 - 0.5) expect(at(centered, x, y)).toBe(1);
        if (d > r / 2 + 0.5) expect(at(centered, x, y)).toBe(0);
        if (Math.abs(d) < 0.1) expect(Math.abs(at(centered, x, y) - 0.5)).toBeLessThan(0.08);
        // Each mode is the same ramp shifted: inward <= centered <= outward.
        expect(at(inward, x, y)).toBeLessThanOrEqual(at(centered, x, y) + 1e-6);
        expect(at(centered, x, y)).toBeLessThanOrEqual(at(outward, x, y) + 1e-6);
      }
    }
  });

  it('is monotonic in the distance to the edge', () => {
    for (const mode of ['inward', 'outward', 'centered'] as const) {
      const f = featherMask(disc, 8, mode);
      // Along the row and the column through the centre the value never rises when moving away.
      for (let x = 33; x < 64; x++) expect(at(f, x, 31)).toBeLessThanOrEqual(at(f, x - 1, 31) + 1e-6);
      for (let x = 30; x >= 0; x--) expect(at(f, x, 31)).toBeLessThanOrEqual(at(f, x + 1, 31) + 1e-6);
      for (let y = 33; y < 64; y++) expect(at(f, 32, y)).toBeLessThanOrEqual(at(f, 32, y - 1) + 1e-6);
      // Everywhere: a pixel that is at least half a pixel farther out is never brighter.
      const samples: [number, number][] = [];
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) samples.push([trueDistance(x, y), at(f, x, y)]);
      samples.sort((a, b) => a[0] - b[0]);
      let brightestFarther = 0;
      let j = samples.length - 1;
      for (let i = samples.length - 1; i >= 0; i--) {
        while (j > i && samples[j][0] >= samples[i][0] + 0.5) {
          brightestFarther = Math.max(brightestFarther, samples[j][1]);
          j--;
        }
        expect(samples[i][1]).toBeGreaterThanOrEqual(brightestFarther - 1e-6);
      }
    }
  });

  it('gives exact linear ramps along a straight edge', () => {
    const m = createMask(16, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) m.data[y * 16 + x] = 1;
    const outward = featherMask(m, 4, 'outward', { profile: 'linear' });
    expect([7, 8, 9, 10, 11, 12].map((x) => at(outward, x, 2))).toEqual([1, 0.875, 0.625, 0.375, 0.125, 0]);
    const inward = featherMask(m, 4, 'inward', { profile: 'linear' });
    expect([3, 4, 5, 6, 7, 8].map((x) => at(inward, x, 2))).toEqual([1, 0.875, 0.625, 0.375, 0.125, 0]);
    const centered = featherMask(m, 4, 'centered', { profile: 'linear' });
    expect([5, 6, 7, 8, 9, 10].map((x) => at(centered, x, 2))).toEqual([1, 0.875, 0.625, 0.375, 0.125, 0]);
    // The smooth profile is the smoothstep of the linear ramp.
    const smooth = featherMask(m, 4, 'outward');
    expect(at(smooth, 9, 2)).toBeCloseTo(0.625 * 0.625 * (3 - 1.25), 6);
  });

  it('radius 0 returns the shape with a plain antialiased edge', () => {
    const f = featherMask(disc, 0, 'centered', { profile: 'linear' });
    let worst = 0;
    for (let i = 0; i < f.data.length; i++) worst = Math.max(worst, Math.abs(f.data[i] - disc.data[i]));
    expect(worst).toBeLessThan(0.12);
    expect(Math.abs(maskArea(f) - maskArea(disc)) / maskArea(disc)).toBeLessThan(0.005);
  });

  it('gives the same result on a large canvas as on a tight crop (only a window is computed)', () => {
    const big = createMask(200, 150);
    const shape = polygonMask(30, 24, [5.5, 4.2, 24.1, 6.3, 20.7, 19.4, 8.2, 17.9]);
    pasteMask(big, shape, 120, 90);
    for (const mode of ['inward', 'outward', 'centered'] as const) {
      const whole = featherMask(big, 3, mode);
      const local = featherMask(shape, 3, mode);
      const window = cropMask(whole, 120, 90, 30, 24);
      for (let i = 0; i < local.data.length; i++) expect(window.data[i]).toBeCloseTo(local.data[i], 5);
      expect(maskArea(whole)).toBeCloseTo(maskArea(local), 3);
    }
  });

  it('leaves uniform masks alone and does not modify its input', () => {
    expect(maskArea(featherMask(createMask(8, 8), 3))).toBe(0);
    expect(maskArea(featherMask(createMask(8, 8, 1), 3, 'inward'))).toBe(64);
    const before = cloneMask(disc);
    featherMask(disc, 5);
    expect(Array.from(disc.data)).toEqual(Array.from(before.data));
  });
});

describe('dilateMask / erodeMask', () => {
  it('moves the edge of a disc by the radius', () => {
    const disc = ellipseMask(64, 64, 32.3, 31.6, 12, 12);
    for (const r of [1, 2.5, 6]) {
      const grown = Math.PI * (12 + r) ** 2;
      const shrunk = Math.PI * (12 - r) ** 2;
      expect(Math.abs(maskArea(dilateMask(disc, r)) - grown) / grown).toBeLessThan(0.01);
      expect(Math.abs(maskArea(erodeMask(disc, r)) - shrunk) / shrunk).toBeLessThan(0.015);
    }
  });

  it('rounds the corners of a square when growing and keeps them when shrinking', () => {
    const square = polygonMask(60, 60, [20, 20, 40, 20, 40, 40, 20, 40]);
    const grown = dilateMask(square, 5);
    const expected = 400 + 4 * 20 * 5 + Math.PI * 25;
    expect(Math.abs(maskArea(grown) - expected) / expected).toBeLessThan(0.015);
    expect(at(grown, 30, 16)).toBe(1);
    expect(at(grown, 30, 14)).toBe(0);
    // The corner is cut round: (16, 16) is 5.66 px from the square's corner.
    expect(at(grown, 15, 15)).toBe(0);
    const shrunk = erodeMask(square, 5);
    expect(maskArea(shrunk)).toBeCloseTo(100, 1);
    expect(at(shrunk, 25, 25)).toBe(1);
    expect(at(shrunk, 24, 30)).toBe(0);
  });

  it('removes thin parts when eroding and restores the rest when dilating again (opening)', () => {
    const m = maskFromRows([
      '....................',
      '.########...........',
      '.########...........',
      '.#################..',
      '.########...........',
      '.########...........',
      '.########...........',
      '.########...........',
      '.########...........',
      '....................',
    ]);
    const opened = dilateMask(erodeMask(m, 1.5), 1.5);
    expect(at(opened, 14, 3)).toBe(0);
    expect(at(opened, 4, 4)).toBe(1);
    expect(Math.abs(maskArea(opened) - 64)).toBeLessThan(4);
  });

  it('a negative radius does the opposite and radius 0 keeps the shape', () => {
    const disc = ellipseMask(40, 40, 20, 20, 9, 9);
    expect(Array.from(dilateMask(disc, -2).data)).toEqual(Array.from(erodeMask(disc, 2).data));
    expect(Array.from(erodeMask(disc, -2).data)).toEqual(Array.from(dilateMask(disc, 2).data));
    expect(Math.abs(maskArea(dilateMask(disc, 0)) - maskArea(disc)) / maskArea(disc)).toBeLessThan(0.005);
  });

  it('does not erode from the image border', () => {
    const stripe = createMask(30, 20);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) stripe.data[y * 30 + x] = 1;
    const shrunk = erodeMask(stripe, 3);
    expect(maskArea(shrunk)).toBeCloseTo(7 * 20, 4);
    expect(at(shrunk, 0, 0)).toBe(1);
    expect(at(shrunk, 6, 19)).toBe(1);
    expect(at(shrunk, 7, 10)).toBe(0);
  });

  it('rejects radii that are not finite numbers', () => {
    const m = createMask(6, 6, 1);
    expect(() => dilateMask(m, Number.NaN)).toThrow(/radius must be a finite number/);
    expect(() => erodeMask(m, Infinity)).toThrow(RangeError);
    expect(() => featherMask(m, Number.NaN)).toThrow(/featherMask: radius must be a finite number/);
  });

  it('keeps empty and full masks as they are', () => {
    expect(maskArea(dilateMask(createMask(6, 6), 4))).toBe(0);
    expect(maskArea(erodeMask(createMask(6, 6, 1), 4))).toBe(36);
    expect(maskArea(erodeMask(maskFromRows(['....', '.##.', '.##.', '....']), 5))).toBe(0);
  });
});
