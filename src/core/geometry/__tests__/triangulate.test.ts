import { describe, expect, it } from 'vitest';
import { GeometryError } from '../errors.js';
import { cleanPolygon, reversePoints, subdivideEdges } from '../primitives.js';
import { earClip, latticePoints, triangulatePolygon } from '../triangulate.js';
import { expectValidTriangulation, insidePolygon, maxEdge, minAngleDeg, shoelace } from './helpers.js';

const square = [0, 0, 10, 0, 10, 10, 0, 10];
const lShape = [0, 0, 60, 0, 60, 20, 20, 20, 20, 50, 0, 50];
const comb = [0, 0, 100, 0, 100, 50, 80, 50, 80, 10, 60, 10, 60, 50, 40, 50, 40, 10, 20, 10, 20, 50, 0, 50];

function star(points: number, outer: number, inner: number, cx = 100, cy = 100): number[] {
  const out: number[] = [];
  for (let k = 0; k < 2 * points; k++) {
    const r = k % 2 ? inner : outer;
    out.push(cx + r * Math.cos((Math.PI * k) / points), cy + r * Math.sin((Math.PI * k) / points));
  }
  return out;
}

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random star-shaped (hence simple) polygon around (0, 0). */
function randomPolygon(seed: number, n: number): number[] {
  const rand = rng(seed);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * (k + 0.8 * rand())) / n;
    const r = 20 + 80 * rand();
    out.push(r * Math.cos(a), r * Math.sin(a));
  }
  return out;
}

function expectCentroidsInside(pos: number[], idx: number[], poly: number[]): void {
  const outside: number[] = [];
  for (let t = 0; t < idx.length && outside.length < 5; t += 3) {
    const cx = (pos[2 * idx[t]] + pos[2 * idx[t + 1]] + pos[2 * idx[t + 2]]) / 3;
    const cy = (pos[2 * idx[t] + 1] + pos[2 * idx[t + 1] + 1] + pos[2 * idx[t + 2] + 1]) / 3;
    if (!insidePolygon(cx, cy, poly)) outside.push(t / 3);
  }
  expect(outside, 'triangles whose centroid is outside the polygon').toEqual([]);
}

describe('cleanPolygon', () => {
  it('removes duplicate, collinear and spike points', () => {
    expect(cleanPolygon([0, 0, 5, 0, 10, 0, 10, 0, 10, 10, 0, 10, 0, 0], 1e-9)).toEqual(square);
    expect(cleanPolygon([0, 0, 10, 0, 10, 10, 10, 20, 10, 10, 0, 10], 1e-9)).toEqual(square);
  });

  it('returns [] when fewer than 3 points survive', () => {
    expect(cleanPolygon([0, 0, 5, 5, 10, 10], 1e-9)).toEqual([]);
    expect(cleanPolygon([1, 1, 1, 1, 1, 1, 1, 1], 1e-9)).toEqual([]);
    expect(cleanPolygon([0, 0, 1, 0], 1e-9)).toEqual([]);
  });
});

describe('triangulatePolygon', () => {
  it('triangulates convex and concave polygons exactly (n - 2 triangles, same vertices)', () => {
    for (const poly of [square, lShape, comb, star(5, 100, 40), star(12, 50, 45)]) {
      const { positions, indices } = triangulatePolygon(poly);
      expect(positions).toEqual(poly);
      expect(indices.length / 3).toBe(poly.length / 2 - 2);
      expectValidTriangulation(positions, indices, Math.abs(shoelace(poly)), 1e-12);
      expectCentroidsInside(positions, indices, poly);
    }
  });

  it('accepts either winding and always emits positive triangles', () => {
    for (const poly of [lShape, comb, star(7, 80, 30)]) {
      const reversed = reversePoints(poly);
      expect(shoelace(reversed)).toBeLessThan(0);
      const { positions, indices } = triangulatePolygon(reversed);
      expect(positions).toEqual(poly);
      expectValidTriangulation(positions, indices, Math.abs(shoelace(poly)), 1e-12);
    }
  });

  it('triangulates random simple polygons validly', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const poly = randomPolygon(seed, 5 + (seed % 7) * 20);
      const { positions, indices } = triangulatePolygon(poly);
      expectValidTriangulation(positions, indices, Math.abs(shoelace(poly)), 1e-9);
      expectCentroidsInside(positions, indices, poly);
    }
  });

  it('drops collinear and duplicate points before triangulating', () => {
    const { positions, indices } = triangulatePolygon([0, 0, 5, 0, 10, 0, 10, 0, 10, 10, 0, 10, 0, 0]);
    expect(positions).toEqual(square);
    expect(indices).toHaveLength(6);
  });

  it('returns no triangles for degenerate outlines', () => {
    const empty = { positions: [], indices: [] };
    expect(triangulatePolygon([])).toEqual(empty);
    expect(triangulatePolygon([0, 0, 10, 10])).toEqual(empty);
    expect(triangulatePolygon([0, 0, 5, 5, 10, 10, 20, 20])).toEqual(empty);
    // Figure eight whose lobes cancel out.
    expect(triangulatePolygon([0, 0, 10, 10, 10, 0, 0, 10])).toEqual(empty);
  });

  it('handles an outline touching itself at a vertex', () => {
    const touching = [0, 0, 10, 0, 10, 10, 20, 10, 20, 20, 10, 20, 10, 10, 0, 10];
    for (const poly of [touching, reversePoints(touching)]) {
      const { positions, indices } = triangulatePolygon(poly);
      expectValidTriangulation(positions, indices, 200, 1e-12);
      expectCentroidsInside(positions, indices, poly);
    }
  });

  it('terminates on self-intersecting outlines without inverted triangles', () => {
    const bowTie = [0, 0, 100, 60, 100, 0, 0, 50];
    for (const detail of [undefined, 5]) {
      const { positions, indices } = triangulatePolygon(bowTie, detail);
      expect(indices.length).toBeGreaterThan(0);
      for (let t = 0; t < indices.length; t += 3) {
        const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
        const turn = (positions[2 * b] - positions[2 * a]) * (positions[2 * c + 1] - positions[2 * a + 1]) - (positions[2 * b + 1] - positions[2 * a + 1]) * (positions[2 * c] - positions[2 * a]);
        expect(turn).toBeGreaterThan(0);
      }
    }
  });

  it('keeps nearly collinear vertices valid', () => {
    const poly = [0, 0, 50, 1e-9, 100, 0, 100, 100, 50, 100 - 1e-10, 0, 100];
    const { positions, indices } = triangulatePolygon(poly);
    expectValidTriangulation(positions, indices, 10000, 1e-9);
  });

  it('is deterministic', () => {
    const poly = randomPolygon(7, 60);
    expect(triangulatePolygon(poly, 9)).toEqual(triangulatePolygon(poly, 9));
  });
});

describe('triangulatePolygon with detail', () => {
  // [name, polygon, detail, minimum triangle angle (bounded by the outline's own sharpest corner)]
  const cases: Array<[string, number[], number, number]> = [
    ['rect', [0, 0, 100, 0, 100, 60, 0, 60], 10, 20],
    ['L', lShape, 6, 20],
    ['comb', comb, 3, 20],
    ['star', star(5, 100, 40), 5, 20],
    ['thin sliver', [0, 0, 200, 0, 200, 3, 0, 3], 4, 20],
    ['random', randomPolygon(3, 50), 7, 5],
    // 2° apex: refinement near it takes a long chain of dependent insertions.
    ['sharp wedge', [0, 0, 200, -200 * Math.tan(Math.PI / 180), 200, 200 * Math.tan(Math.PI / 180)], 1, 0.9],
  ];

  it.each(cases)('%s: every edge <= detail, same area, valid and well shaped', (_name, poly, detail, minAngle) => {
    const { positions, indices } = triangulatePolygon(poly, detail);
    expect(maxEdge(positions, indices)).toBeLessThanOrEqual(detail * (1 + 1e-9));
    expectValidTriangulation(positions, indices, Math.abs(shoelace(poly)), 1e-9);
    expectCentroidsInside(positions, indices, poly);
    expect(minAngleDeg(positions, indices)).toBeGreaterThan(minAngle);
    // The original outline vertices are kept.
    const clean = cleanPolygon(poly, 1e-9);
    for (let i = 0; i < clean.length; i += 2) {
      let found = false;
      for (let j = 0; j < positions.length && !found; j += 2) found = positions[j] === clean[i] && positions[j + 1] === clean[i + 1];
      expect(found).toBe(true);
    }
  });

  it('adds interior points on a hexagonal lattice clear of the boundary', () => {
    const rect = [0, 0, 100, 0, 100, 60, 0, 60];
    const lattice = latticePoints(subdivideEdges(rect, true, 10), 10);
    expect(lattice.length).toBeGreaterThan(0);
    for (let i = 0; i < lattice.length; i += 2) {
      const [x, y] = [lattice[i], lattice[i + 1]];
      expect(Math.min(x, 100 - x, y, 60 - y)).toBeGreaterThanOrEqual(5);
    }
    // Rows are sqrt(3)/2 * spacing apart, anchored at the centroid (50, 30).
    const ys = [...new Set(lattice.filter((_, i) => i % 2 === 1))].sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo((10 * Math.sqrt(3)) / 2, 9);
    let nearest = Infinity;
    for (let i = 0; i < lattice.length; i += 2) nearest = Math.min(nearest, Math.hypot(lattice[i] - 50, lattice[i + 1] - 30));
    expect(nearest).toBeLessThan(1e-9);
  });

  it('refines long thin outlines whose extent dwarfs detail', () => {
    // Tolerances must follow the local triangle size, not the outline's extent: these used to refine
    // without end (until the arrays overflowed).
    for (const [w, h, detail] of [
      [8000, 2, 1],
      [2000, 0.5, 0.25],
    ]) {
      const poly = [0, 0, w, 0, w, h, 0, h];
      const { positions, indices } = triangulatePolygon(poly, detail);
      expect(maxEdge(positions, indices)).toBeLessThanOrEqual(detail * (1 + 1e-9));
      expectValidTriangulation(positions, indices, w * h, 1e-9);
      // Close to the vertex estimate that the detail budget (and model validation) relies on.
      const estimate = (2 * (w + h)) / detail + (w * h) / (detail * detail * (Math.sqrt(3) / 2));
      expect(positions.length / 2).toBeLessThan(1.5 * estimate);
    }
  });

  it('refines a diagonal strip (a bounding box far larger than the shape)', () => {
    const c = Math.SQRT1_2;
    const strip = [0, 0, 3000, 0, 3000, 3, 0, 3].map((v, i, p) => (i % 2 === 0 ? c * (v - p[i + 1]) : c * (p[i - 1] + v)));
    const { positions, indices } = triangulatePolygon(strip, 1);
    expect(maxEdge(positions, indices)).toBeLessThanOrEqual(1 + 1e-9);
    expectValidTriangulation(positions, indices, 9000, 1e-9);
    expectCentroidsInside(positions, indices, strip);
  });

  it('places lattice points exactly where a brute-force search finds them', () => {
    const spacing = 4;
    const ring = subdivideEdges(star(7, 90, 35), true, spacing);
    // Hexagonal lattice anchored at the area centroid, inside the ring, >= spacing / 2 from every edge.
    let a2 = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const c = ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
      a2 += c;
      sx += (ring[j] + ring[i]) * c;
      sy += (ring[j + 1] + ring[i + 1]) * c;
    }
    const [cx, cy] = [sx / (3 * a2), sy / (3 * a2)];
    const rowStep = (spacing * Math.sqrt(3)) / 2;
    const expected: string[] = [];
    for (let j = -40; j <= 40; j++) {
      for (let i = -40; i <= 40; i++) {
        const x = cx + (j & 1 ? spacing / 2 : 0) + i * spacing;
        const y = cy + j * rowStep;
        if (!insidePolygon(x, y, ring)) continue;
        let near = false;
        for (let k = 0, m = ring.length - 2; k < ring.length && !near; m = k, k += 2) {
          const [ax, ay, bx, by] = [ring[m], ring[m + 1], ring[k], ring[k + 1]];
          const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
          near = Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) < spacing / 2;
        }
        if (!near) expected.push(`${x.toFixed(6)},${y.toFixed(6)}`);
      }
    }
    const lattice = latticePoints(ring, spacing);
    const found: string[] = [];
    for (let i = 0; i < lattice.length; i += 2) found.push(`${lattice[i].toFixed(6)},${lattice[i + 1].toFixed(6)}`);
    expect(expected.length).toBeGreaterThan(100);
    expect(found.sort()).toEqual(expected.sort());
  });

  it('locates lattice points across concavities without degrading to linear scans', () => {
    // 50 teeth: every lattice row crosses 49 gaps that a visibility walk cannot cross.
    const teeth = [0, 0, 1000, 0, 1000, 20];
    for (let k = 49; k >= 0; k--) teeth.push(20 * k + 20, 20, 20 * k + 20, 200, 20 * k + 10, 200, 20 * k + 10, 20);
    teeth.push(0, 20);
    const t0 = performance.now();
    const { positions, indices } = triangulatePolygon(teeth, 2);
    const elapsed = performance.now() - t0;
    expectValidTriangulation(positions, indices, Math.abs(shoelace(teeth)), 1e-9);
    expect(maxEdge(positions, indices)).toBeLessThanOrEqual(2 * (1 + 1e-9));
    // Quadratic point location took ~10 s here; linear work is well under a second.
    expect(elapsed).toBeLessThan(1500);
  });

  it('refines a small shape far from the origin like the same shape at the origin', () => {
    // Areas from absolute coordinates cancel catastrophically out here and made the outline look
    // self-intersecting, which silently skipped refinement.
    const shape = star(6, 1, 0.5, 0, 0);
    const far = shape.map((v, i) => v + (i % 2 === 0 ? 12000 : -7000));
    const near = triangulatePolygon(shape, 0.1);
    const moved = triangulatePolygon(far, 0.1);
    expect(maxEdge(moved.positions, moved.indices)).toBeLessThanOrEqual(0.1 * (1 + 1e-6));
    expectValidTriangulation(moved.positions, moved.indices, Math.abs(shoelace(shape)), 1e-6);
    // Rounding at the offset may break ties differently, but the meshes are alike.
    expect(Math.abs(moved.positions.length / near.positions.length - 1)).toBeLessThan(0.05);
  });

  it('leaves shapes smaller than detail as a plain triangulation', () => {
    expect(triangulatePolygon(square, 50)).toEqual(triangulatePolygon(square));
  });

  it('rejects a detail that would explode the vertex count', () => {
    expect(() => triangulatePolygon([0, 0, 5000, 0, 5000, 5000, 0, 5000], 1)).toThrow(GeometryError);
  });
});

describe('earClip', () => {
  it('returns n - 2 triangles over the ring indices for simple outlines', () => {
    const { triangles, simple } = earClip(comb, 1e-9);
    expect(simple).toBe(true);
    expect(triangles).toHaveLength((comb.length / 2 - 2) * 3);
    expect(new Set(triangles).size).toBe(comb.length / 2);
  });

  it('flags outlines that needed a forced ear', () => {
    // Bow tie with net positive area: one lobe runs the wrong way.
    const bowTie = reversePoints([0, 0, 30, 20, 30, 0, 0, 10]);
    expect(shoelace(bowTie)).toBeGreaterThan(0);
    expect(earClip(bowTie, 1e-9).simple).toBe(false);
    expect(earClip(subdivideEdges(bowTie, true, 2), 1e-9).simple).toBe(false);
    // Touching itself at a vertex is still tiled exactly.
    expect(earClip([0, 0, 10, 0, 10, 10, 20, 10, 20, 20, 10, 20, 10, 10, 0, 10], 1e-9).simple).toBe(true);
  });

  it('zigzags across collinear runs instead of fanning out along them', () => {
    // A subdivided strip: fanning from one corner would create triangles as long as the strip,
    // which are slow to test as ears (quadratic overall) and a poor start for Delaunay flips.
    const strip = subdivideEdges([0, 0, 1000, 0, 1000, 2, 0, 2], true, 1);
    const { triangles, simple } = earClip(strip, 1e-6);
    expect(simple).toBe(true);
    expectValidTriangulation(strip, triangles, 2000, 1e-12);
    expect(maxEdge(strip, triangles)).toBeLessThan(3);
  });

  it('stays fast on large outlines', () => {
    const wavy: number[] = [];
    for (let k = 0; k < 5000; k++) {
      const a = (2 * Math.PI * k) / 5000;
      const r = 300 + 60 * Math.sin(17 * a);
      wavy.push(r * Math.cos(a), r * Math.sin(a));
    }
    const t0 = performance.now();
    const { triangles } = earClip(wavy, 1e-3);
    expect(performance.now() - t0).toBeLessThan(500);
    expectValidTriangulation(wavy, triangles, shoelace(wavy), 1e-9);
  });
});
