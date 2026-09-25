import { describe, expect, it } from 'vitest';
import { flattenPath, GeometryError } from '../index.js';
import { MAX_SEGMENT_ANGLE_DEG } from '../flatten.js';
import { shoelace } from './helpers.js';

type Pt = [number, number];

function cubicAt(p: Pt[], t: number): Pt {
  const mt = 1 - t;
  const w = [mt * mt * mt, 3 * mt * mt * t, 3 * mt * t * t, t * t * t];
  return [w.reduce((s, k, i) => s + k * p[i][0], 0), w.reduce((s, k, i) => s + k * p[i][1], 0)];
}

function quadAt(p: Pt[], t: number): Pt {
  const mt = 1 - t;
  const w = [mt * mt, 2 * mt * t, t * t];
  return [w.reduce((s, k, i) => s + k * p[i][0], 0), w.reduce((s, k, i) => s + k * p[i][1], 0)];
}

function distToPolyline(x: number, y: number, pts: number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const [ax, ay, bx, by] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

function polylineLength(pts: number[]): number {
  let s = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) s += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  return s;
}

/** Max distance from the exact curve to the flattened polyline. */
function maxDeviation(curve: (t: number) => Pt, pts: number[]): number {
  let m = 0;
  for (let i = 0; i <= 2000; i++) {
    const [x, y] = curve(i / 2000);
    m = Math.max(m, distToPolyline(x, y, pts));
  }
  return m;
}

function sub(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]];
}

/** Parameter of the curve point nearest to (x, y): dense search, then ternary refinement. */
function paramOf(curve: (t: number) => Pt, x: number, y: number): number {
  const d = (t: number) => Math.hypot(...sub(curve(t), [x, y]));
  let best = 0;
  for (let i = 0; i <= 4000; i++) if (d(i / 4000) < d(best)) best = i / 4000;
  let lo = Math.max(0, best - 1 / 4000);
  let hi = Math.min(1, best + 1 / 4000);
  for (let k = 0; k < 100; k++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (d(a) < d(b)) hi = b;
    else lo = a;
  }
  return (lo + hi) / 2;
}

/** Largest direction change (degrees) between consecutive segments of a polyline (closed: incl. the wrap). */
function maxTurn(pts: number[], closed: boolean): number {
  const n = pts.length / 2;
  const seg = (i: number): Pt => {
    const j = (i + 1) % n;
    return [pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]];
  };
  let m = 0;
  for (let i = 0; i < (closed ? n : n - 2); i++) {
    const [ax, ay] = seg(i);
    const [bx, by] = seg((i + 1) % n);
    m = Math.max(m, (Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) * 180) / Math.PI);
  }
  return m;
}

function only(d: string, tolerance = 0.5): number[] {
  const subpaths = flattenPath(d, tolerance);
  expect(subpaths).toHaveLength(1);
  return subpaths[0].points;
}

describe('flattenPath: lines and subpaths', () => {
  it('flattens lines and marks Z-closed subpaths', () => {
    expect(flattenPath('M0 0 L10 0 L10 10 Z', 0.5)).toEqual([{ points: [0, 0, 10, 0, 10, 10], closed: true }]);
    expect(flattenPath('M0 0 L10 0 L10 10', 0.5)).toEqual([{ points: [0, 0, 10, 0, 10, 10], closed: false }]);
  });

  it('supports H/V and implicit linetos, absolute and relative', () => {
    expect(only('M0 0 H10 V10 h-10 z')).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(only('M0,0 10,0 10,10')).toEqual([0, 0, 10, 0, 10, 10]);
    expect(only('m5 5 10 0 0 10 v-5 h-2')).toEqual([5, 5, 15, 5, 15, 15, 15, 10, 13, 10]);
  });

  it('starts relative moves from the current point, and after Z from the subpath start', () => {
    expect(flattenPath('m10 10 l10 0 l0 10 z m20 0 l5 5 l-5 0', 0.5)).toEqual([
      { points: [10, 10, 20, 10, 20, 20], closed: true },
      { points: [30, 10, 35, 15, 30, 15], closed: false },
    ]);
    // A drawing command right after Z opens a new subpath at the previous start.
    expect(flattenPath('M0 0 L10 0 L10 10 Z L0 10 L-5 5', 0.5)).toEqual([
      { points: [0, 0, 10, 0, 10, 10], closed: true },
      { points: [0, 0, 0, 10, -5, 5], closed: false },
    ]);
  });

  it('removes duplicate points and drops single-point subpaths', () => {
    expect(only('M0 0 L0 0 L10 0 L10 0 L10 10 L0 0 Z')).toEqual([0, 0, 10, 0, 10, 10]);
    expect(flattenPath('M5 5 M0 0 L10 0', 0.5)).toEqual([{ points: [0, 0, 10, 0], closed: false }]);
    expect(flattenPath('M0 0 Z', 0.5)).toEqual([]);
    // An open subpath that returns to its start keeps the repeated point (no join without Z).
    expect(only('M0 0 L10 0 L10 10 L0 0')).toEqual([0, 0, 10, 0, 10, 10, 0, 0]);
  });
});

describe('flattenPath: curves', () => {
  it('samples cubics on the curve (in order) within tolerance, ending exactly at the endpoint', () => {
    const ctrl: Pt[] = [[0, 0], [30, 90], [70, -40], [100, 20]];
    for (const tol of [0.05, 0.5, 2]) {
      const pts = only(`M0 0 C30 90 70 -40 100 20`, tol);
      let prevT = -1;
      for (let i = 0; i < pts.length; i += 2) {
        const t = paramOf((u) => cubicAt(ctrl, u), pts[i], pts[i + 1]);
        expect(Math.hypot(...sub(cubicAt(ctrl, t), [pts[i], pts[i + 1]]))).toBeLessThan(1e-6);
        expect(t).toBeGreaterThan(prevT);
        prevT = t;
      }
      expect(pts.slice(-2)).toEqual([100, 20]);
      expect(maxDeviation((t) => cubicAt(ctrl, t), pts)).toBeLessThanOrEqual(tol);
    }
  });

  it('adapts the segment count to tolerance and curvature', () => {
    const count = (d: string, tol: number) => only(d, tol).length / 2;
    const curve = 'M0 0 C0 100 100 100 100 0';
    expect(count(curve, 0.05)).toBeGreaterThan(count(curve, 0.5));
    expect(count(curve, 0.5)).toBeGreaterThan(count(curve, 5));
    // Evenly spaced collinear control points: a straight line needs one segment.
    expect(only('M0 0 C10 0 20 0 30 0', 0.01)).toEqual([0, 0, 30, 0]);
    expect(count('M0 0 C0 10 10 10 10 0', 0.5)).toBeLessThan(count('M0 0 C0 400 400 400 400 0', 0.5));
  });

  it('samples quadratics within tolerance', () => {
    const ctrl: Pt[] = [[0, 0], [50, 100], [100, 0]];
    const pts = only('M0 0 Q50 100 100 0', 0.1);
    expect(maxDeviation((t) => quadAt(ctrl, t), pts)).toBeLessThanOrEqual(0.1);
    expect(pts.slice(-2)).toEqual([100, 0]);
  });

  it('reflects the previous cubic control point for S (absolute and relative)', () => {
    const explicit = only('M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0');
    expect(only('M0 0 C0 10 10 10 10 0 S20 -10 20 0')).toEqual(explicit);
    expect(only('m0 0 c0 10 10 10 10 0 s10 -10 10 0')).toEqual(explicit);
    // Chained S reflects the previous S.
    expect(only('M0 0 C0 10 10 10 10 0 S20 -10 20 0 S30 10 30 0')).toEqual(
      only('M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0 C20 10 30 10 30 0'),
    );
  });

  it('uses the current point as first control for S without a preceding cubic', () => {
    expect(only('M0 0 S10 10 20 0')).toEqual(only('M0 0 C0 0 10 10 20 0'));
    expect(only('M0 0 Q5 5 10 0 S20 10 30 0')).toEqual(only('M0 0 Q5 5 10 0 C10 0 20 10 30 0'));
  });

  it('reflects the previous quadratic control point for T, chaining through T', () => {
    expect(only('M0 0 Q10 10 20 0 T40 0')).toEqual(only('M0 0 Q10 10 20 0 Q30 -10 40 0'));
    expect(only('M0 0 Q5 10 10 0 T20 0 T30 0')).toEqual(only('M0 0 Q5 10 10 0 Q15 -10 20 0 Q25 10 30 0'));
    expect(only('m0 0 q5 10 10 0 t10 0')).toEqual(only('M0 0 Q5 10 10 0 Q15 -10 20 0'));
    // T without a preceding quadratic uses the current point as control: a straight line.
    const line = only('M0 0 L10 0 T30 0');
    expect(line.slice(0, 4)).toEqual([0, 0, 10, 0]);
    expect(line.slice(-2)).toEqual([30, 0]);
    for (let i = 4; i < line.length; i += 2) {
      expect(line[i + 1]).toBe(0);
      expect(line[i]).toBeGreaterThan(line[i - 2]);
    }
  });
});

describe('flattenPath: arcs', () => {
  it('flattens a semicircle (sweep 1 bulges toward -y) with the expected area', () => {
    const pts = only('M0 0 A50 50 0 0 1 100 0 Z', 0.05);
    for (let i = 0; i < pts.length; i += 2) {
      expect(Math.hypot(pts[i] - 50, pts[i + 1])).toBeCloseTo(50, 6);
      expect(pts[i + 1]).toBeLessThanOrEqual(1e-9);
    }
    const area = Math.abs(shoelace(pts));
    expect(area).toBeLessThanOrEqual((Math.PI * 2500) / 2);
    expect(area).toBeGreaterThan((Math.PI * 2500) / 2 - 0.05 * 160);
  });

  it('respects the sweep flag and relative endpoints', () => {
    const down = only('M0 0 A50 50 0 0 0 100 0', 0.5);
    for (let i = 1; i < down.length; i += 2) expect(down[i]).toBeGreaterThanOrEqual(-1e-9);
    expect(only('M10 10 a50 50 0 0 1 100 0')).toEqual(only('M10 10 A50 50 0 0 1 110 10'));
  });

  it('scales up radii that are too small to span the endpoints', () => {
    const pts = only('M0 0 A10 10 0 0 1 100 0', 0.1);
    for (let i = 0; i < pts.length; i += 2) expect(Math.hypot(pts[i] - 50, pts[i + 1])).toBeCloseTo(50, 6);
  });

  it('picks the large or small arc', () => {
    const small = polylineLength(only('M0 0 A50 50 0 0 1 50 50', 0.01));
    const large = polylineLength(only('M0 0 A50 50 0 1 1 50 50', 0.01));
    expect(small).toBeCloseTo((Math.PI / 2) * 50, 0);
    expect(large).toBeCloseTo(((3 * Math.PI) / 2) * 50, 0);
  });

  it('handles rotated elliptical arcs', () => {
    // rx=100 along the rotated x axis (now +y), ry=50 along -x: the endpoints span the major axis.
    const pts = only('M0 0 A100 50 90 0 1 0 200', 0.1);
    let maxAbsX = 0;
    for (let i = 0; i < pts.length; i += 2) {
      expect((pts[i] / 50) ** 2 + ((pts[i + 1] - 100) / 100) ** 2).toBeCloseTo(1, 6);
      maxAbsX = Math.max(maxAbsX, Math.abs(pts[i]));
    }
    expect(maxAbsX).toBeCloseTo(50, 1);
  });

  it('treats zero radii as a line and omits arcs to the current point', () => {
    expect(only('M0 0 A0 10 0 0 1 10 10')).toEqual([0, 0, 10, 10]);
    expect(only('M0 0 L10 0 A5 5 0 0 1 10 0 L10 10')).toEqual([0, 0, 10, 0, 10, 10]);
  });
});

describe('flattenPath: errors', () => {
  it('rejects invalid data and tolerances with GeometryError', () => {
    expect(() => flattenPath('M0 0 X10 10', 0.5)).toThrow(GeometryError);
    expect(() => flattenPath('L10 10', 0.5)).toThrow(/invalid path data/);
    expect(() => flattenPath('M0 0 L1e999 0', 0.5)).toThrow(/finite/);
    for (const tol of [0, -1, Number.NaN, Infinity]) expect(() => flattenPath('M0 0 L1 1', tol)).toThrow(GeometryError);
  });
});

describe('flattenPath: max segment angle', () => {
  const K = 0.5523;
  /** Circle of radius r at the origin from four cubic quarter arcs. */
  const cubicCircle = (r: number) =>
    `M${r} 0 C${r} ${K * r} ${K * r} ${r} 0 ${r} C${-K * r} ${r} ${-r} ${K * r} ${-r} 0 C${-r} ${-K * r} ${-K * r} ${-r} 0 ${-r} C${K * r} ${-r} ${r} ${-K * r} ${r} 0 Z`;
  const arcCircle = (r: number) => `M0 ${r} A${r} ${r} 0 1 0 ${2 * r} ${r} A${r} ${r} 0 1 0 0 ${r} Z`;
  const flat = (d: string, tol = 0.5) => flattenPath(d, tol)[0];

  it('keeps small circles round at the default tolerance (no octagons)', () => {
    expect(MAX_SEGMENT_ANGLE_DEG).toBe(15);
    for (const d of [cubicCircle(3), arcCircle(3), cubicCircle(0.5)]) {
      const { points, closed } = flat(d);
      expect(points.length / 2).toBeGreaterThanOrEqual(24);
      expect(maxTurn(points, closed)).toBeLessThanOrEqual(15 * 1.1);
    }
  });

  it('refines where the curvature concentrates (quadratic apex, eccentric arcs, hooks)', () => {
    for (const d of ['M0 0 Q10 20 20 0', 'M0 0 C60 0 100 5 100 10', 'M0 0 C50 0 0 50 10 10', 'M0 10 A100 10 0 0 1 200 10', 'M0 0 C100 0 100 0 100 100']) {
      const { points, closed } = flat(d);
      expect(maxTurn(points, closed), d).toBeLessThanOrEqual(15 * 1.1);
    }
  });

  it('keeps genuine cusps sharp and straight lines single', () => {
    // B'(0.5) = 0: the curve reverses direction.
    expect(maxTurn(flat('M0 0 C100 100 0 100 100 0').points, false)).toBeGreaterThan(170);
    expect(only('M0 0 C10 0 20 0 30 0', 0.5)).toEqual([0, 0, 30, 0]);
    expect(only('M0 0 Q5 0 10 0', 0.5)).toEqual([0, 0, 10, 0]);
  });

  it('does not add vertices to large curves, where the distance tolerance is finer', () => {
    // Radius 200 at tolerance 0.5: steps of ~8° from the tolerance alone.
    const { points, closed } = flat(arcCircle(200));
    expect(maxTurn(points, closed)).toBeLessThan(8);
    expect(points.length / 2).toBe(46);
    expect(flat(cubicCircle(200)).points.length / 2).toBe(48);
  });
});
