/** Shared assertions for geometry tests. */
import { expect } from 'vitest';
import { PartSchema } from '../../schema.js';
import type { MeshBatch, Part } from '../../types.js';

/** A fully defaulted part (as the rig would pass it). */
export function part(input: Record<string, unknown>): Part {
  return PartSchema.parse({ id: 'p', ...input });
}

export function shoelace(p: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) s += p[j] * p[i + 1] - p[i] * p[j + 1];
  return s / 2;
}

/** Signed area of triangle t (positive = positive orientation). */
export function triangleArea(pos: ArrayLike<number>, idx: ArrayLike<number>, t: number): number {
  const a = idx[3 * t];
  const b = idx[3 * t + 1];
  const c = idx[3 * t + 2];
  return ((pos[2 * b] - pos[2 * a]) * (pos[2 * c + 1] - pos[2 * a + 1]) - (pos[2 * b + 1] - pos[2 * a + 1]) * (pos[2 * c] - pos[2 * a])) / 2;
}

export function totalArea(pos: ArrayLike<number>, idx: ArrayLike<number>): number {
  let s = 0;
  for (let t = 0; t < idx.length / 3; t++) s += triangleArea(pos, idx, t);
  return s;
}

export function maxEdge(pos: ArrayLike<number>, idx: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < idx.length; i++) {
    const a = idx[i];
    const b = idx[i % 3 === 2 ? i - 2 : i + 1];
    m = Math.max(m, Math.hypot(pos[2 * b] - pos[2 * a], pos[2 * b + 1] - pos[2 * a + 1]));
  }
  return m;
}

export function minAngleDeg(pos: ArrayLike<number>, idx: ArrayLike<number>): number {
  let m = 180;
  for (let i = 0; i < idx.length; i++) {
    const t = i - (i % 3);
    const a = idx[i];
    const b = idx[t + ((i + 1) % 3)];
    const c = idx[t + ((i + 2) % 3)];
    const ux = pos[2 * b] - pos[2 * a];
    const uy = pos[2 * b + 1] - pos[2 * a + 1];
    const vx = pos[2 * c] - pos[2 * a];
    const vy = pos[2 * c + 1] - pos[2 * a + 1];
    m = Math.min(m, (Math.acos((ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))) * 180) / Math.PI);
  }
  return m;
}

/** [minX, minY, maxX, maxY]. */
export function bounds(pos: ArrayLike<number>): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pos.length; i += 2) {
    minX = Math.min(minX, pos[i]);
    maxX = Math.max(maxX, pos[i]);
    minY = Math.min(minY, pos[i + 1]);
    maxY = Math.max(maxY, pos[i + 1]);
  }
  return [minX, minY, maxX, maxY];
}

export function expectBounds(pos: ArrayLike<number>, expected: [number, number, number, number], digits = 4): void {
  const b = bounds(pos);
  for (let k = 0; k < 4; k++) expect(b[k]).toBeCloseTo(expected[k], digits);
}

/** Even-odd point in polygon. */
export function insidePolygon(x: number, y: number, poly: ArrayLike<number>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const yi = poly[i + 1];
    const yj = poly[j + 1];
    if (yi > y !== yj > y && x < poly[j] + ((y - yj) * (poly[i] - poly[j])) / (yi - yj)) inside = !inside;
  }
  return inside;
}

/**
 * A conforming, non-overlapping triangulation: indices in range, every triangle positively oriented,
 * every directed edge used once (so each interior edge is shared by exactly two triangles in opposite
 * directions: no T-junctions or overlaps), and the areas adding up to `area`.
 */
export function expectValidTriangulation(pos: ArrayLike<number>, idx: ArrayLike<number>, area: number, relTol = 1e-6): void {
  const n = pos.length / 2;
  expect(idx.length % 3).toBe(0);
  // Collected in plain JS (large meshes would otherwise cost one expect() per index).
  const problems: string[] = [];
  const directed = new Set<number>();
  for (let i = 0; i < idx.length && problems.length < 5; i++) {
    const a = idx[i];
    const b = idx[i % 3 === 2 ? i - 2 : i + 1];
    if (!(Number.isInteger(a) && a >= 0 && a < n)) problems.push(`index ${a} out of range`);
    if (directed.has(a * n + b)) problems.push(`directed edge ${a}>${b} used twice`);
    directed.add(a * n + b);
  }
  for (let t = 0; t < idx.length / 3 && problems.length < 5; t++) {
    if (!(triangleArea(pos, idx, t) > 0)) problems.push(`triangle ${t} is not positively oriented`);
  }
  expect(problems).toEqual([]);
  expect(Math.abs(totalArea(pos, idx) - area)).toBeLessThanOrEqual(Math.abs(area) * relTol + 1e-6);
}

/** Every vertex color of the batch (4 floats per vertex). */
export function colorAt(batch: MeshBatch, i: number): number[] {
  return Array.from(batch.colors.subarray(4 * i, 4 * i + 4));
}
