import { describe, expect, it } from 'vitest';
import { computeAutoWeights, type BoneSegment } from '../index.js';

const upper: BoneSegment = { x0: 0, y0: 0, x1: 10, y1: 0 };
const point: BoneSegment = { x0: 20, y0: 0, x1: 20, y1: 0 };

describe('computeAutoWeights', () => {
  it('follows w_i = 1 / (dist_i + 1)^falloff, normalized per vertex', () => {
    const w = computeAutoWeights([5, 3], [upper, point], 2);
    const a = 1 / 4 ** 2; // 3 px from the segment interior
    const b = 1 / (Math.hypot(15, 3) + 1) ** 2; // distance to the zero-length bone's joint
    expect(w[0]).toBeCloseTo(a / (a + b), 6);
    expect(w[1]).toBeCloseTo(b / (a + b), 6);
  });

  it('returns one normalized row per vertex', () => {
    const positions = [0, 0, 5, 5, 15, 0, 20, 0, -30, 40, 100, 100];
    const w = computeAutoWeights(positions, [upper, point], 2);
    expect(w).toHaveLength(6 * 2);
    for (let v = 0; v < 6; v++) expect(w[2 * v] + w[2 * v + 1]).toBeCloseTo(1, 6);
    // Equidistant from both bones (5 px from the segment end and from the point).
    expect(w[4]).toBeCloseTo(0.5, 6);
    // Sitting on a bone dominates.
    expect(w[0]).toBeGreaterThan(0.9);
    expect(w[7]).toBeGreaterThan(0.9);
  });

  it('clamps projections to the segment ends', () => {
    // Beyond the start of the segment it behaves like a point bone at (0, 0).
    const [segment] = computeAutoWeights([-5, 0], [upper, point], 1);
    const [joint] = computeAutoWeights([-5, 0], [{ x0: 0, y0: 0, x1: 0, y1: 0 }, point], 1);
    expect(segment).toBeCloseTo(joint, 9);
    // Distance to the (0, 0) end is 5, to the point bone 25.
    expect(segment).toBeCloseTo(1 / 6 / (1 / 6 + 1 / 26), 6);
  });

  it('gets sharper with a larger falloff', () => {
    const soft = computeAutoWeights([8, 4], [upper, point], 1)[0];
    const sharp = computeAutoWeights([8, 4], [upper, point], 4)[0];
    expect(sharp).toBeGreaterThan(soft);
    expect(computeAutoWeights([8, 4], [upper, point], 0)[0]).toBeCloseTo(0.5, 9);
  });

  it('stays finite for huge distances and falloffs', () => {
    const w = computeAutoWeights([1e6, 1e6], [upper, point], 400);
    expect(Number.isFinite(w[0]) && Number.isFinite(w[1])).toBe(true);
    expect(w[0] + w[1]).toBeCloseTo(1, 6);
  });

  it('gives a single bone full weight and handles empty inputs', () => {
    expect(Array.from(computeAutoWeights([1, 2, 3, 4], [upper], 2))).toEqual([1, 1]);
    expect(computeAutoWeights([1, 2], [], 2)).toHaveLength(0);
    expect(computeAutoWeights([], [upper], 2)).toHaveLength(0);
  });
});
