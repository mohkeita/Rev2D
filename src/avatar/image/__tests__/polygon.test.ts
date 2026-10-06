import { describe, expect, it } from 'vitest';
import {
  closestOnPolyline,
  ellipsePolygon,
  pointCount,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  polygonCentroid,
  polygonEnvelope,
  polygonSelfIntersects,
  polylineLength,
  polylinePointAt,
  resamplePolyline,
  segmentsIntersect,
  simplifyPolyline,
  smoothPolyline,
  translatePoints,
} from '../polygon.js';
import { mulberry32, randomInt } from '../random.js';

const SQUARE = [0, 0, 10, 0, 10, 10, 0, 10]; // clockwise on screen (+y down)
const L_SHAPE = [0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2];

function reversed(points: number[]): number[] {
  const out: number[] = [];
  for (let i = points.length - 2; i >= 0; i -= 2) out.push(points[i], points[i + 1]);
  return out;
}

function close(a: number[], b: number[], digits = 9): void {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
}

describe('bounds, area, centroid', () => {
  it('counts points and finds the bounding box', () => {
    expect(pointCount(SQUARE)).toBe(4);
    expect(pointCount([1, 2, 3])).toBe(1);
    expect(pointCount(new Float32Array(6))).toBe(3);
    expect(polygonBounds([3, -2, 7.5, 4, -1, 9])).toEqual({ x: -1, y: -2, width: 8.5, height: 11 });
    expect(polygonBounds([4, 5])).toEqual({ x: 4, y: 5, width: 0, height: 0 });
    expect(() => polygonBounds([])).toThrow(/empty/);
  });

  it('signed area is positive for clockwise-on-screen polygons', () => {
    expect(polygonArea(SQUARE)).toBe(100);
    expect(polygonArea(reversed(SQUARE))).toBe(-100);
    expect(polygonArea(L_SHAPE)).toBe(3);
    expect(polygonArea([0, 0, 4, 0, 0, 3])).toBe(6);
    expect(polygonArea([0, 0, 5, 5])).toBe(0);
    expect(polygonArea([])).toBe(0);
    // Translation does not change it.
    expect(polygonArea(translatePoints(L_SHAPE, 1000, -500))).toBeCloseTo(3, 9);
  });

  it('centroid is the centre of area', () => {
    expect(polygonCentroid(SQUARE)).toEqual([5, 5]);
    close(polygonCentroid(L_SHAPE), [2.5 / 3, 2.5 / 3]);
    close(polygonCentroid(reversed(L_SHAPE)), [2.5 / 3, 2.5 / 3]);
    close(polygonCentroid([0, 0, 6, 0, 0, 3]), [2, 1]);
    // Far from the origin it stays accurate.
    close(polygonCentroid(translatePoints(L_SHAPE, 1e6, 2e6)), [1e6 + 2.5 / 3, 2e6 + 2.5 / 3], 6);
  });

  it('falls back to the mean of the points for degenerate polygons', () => {
    expect(polygonCentroid([0, 0, 4, 0, 8, 0])).toEqual([4, 0]);
    expect(polygonCentroid([3, 7])).toEqual([3, 7]);
    expect(polygonCentroid([1, 1, 3, 5])).toEqual([2, 3]);
    expect(() => polygonCentroid([])).toThrow(/empty/);
  });
});

describe('pointInPolygon', () => {
  it('works for convex and concave polygons in both windings', () => {
    for (const poly of [L_SHAPE, reversed(L_SHAPE)]) {
      expect(pointInPolygon(poly, 0.5, 0.5)).toBe(true);
      expect(pointInPolygon(poly, 1.5, 0.5)).toBe(true);
      expect(pointInPolygon(poly, 0.5, 1.5)).toBe(true);
      expect(pointInPolygon(poly, 1.5, 1.5)).toBe(false);
      expect(pointInPolygon(poly, -0.1, 0.5)).toBe(false);
      expect(pointInPolygon(poly, 2.1, 0.5)).toBe(false);
      expect(pointInPolygon(poly, 0.5, 2.1)).toBe(false);
    }
    expect(pointInPolygon(SQUARE, 5, 5)).toBe(true);
    expect(pointInPolygon(SQUARE, 15, 5)).toBe(false);
    expect(pointInPolygon([], 0, 0)).toBe(false);
  });

  it('agrees with the ellipse equation for an ellipse polygon', () => {
    const poly = ellipsePolygon(10, 8, 6, 3, 30);
    const random = mulberry32(3);
    const c = Math.cos((30 * Math.PI) / 180);
    const s = Math.sin((30 * Math.PI) / 180);
    let checked = 0;
    for (let k = 0; k < 400; k++) {
      const x = random() * 20;
      const y = random() * 16;
      const u = ((x - 10) * c + (y - 8) * s) / 6;
      const v = (-(x - 10) * s + (y - 8) * c) / 3;
      const e = u * u + v * v;
      if (Math.abs(e - 1) < 0.02) continue; // too close to the outline to call
      expect(pointInPolygon(poly, x, y)).toBe(e < 1);
      checked++;
    }
    expect(checked).toBeGreaterThan(350);
  });
});

describe('polyline length, points and resampling', () => {
  const path = [0, 0, 10, 0, 10, 10]; // an "L" of length 20

  it('measures open and closed length', () => {
    expect(polylineLength(path)).toBe(20);
    expect(polylineLength(path, true)).toBeCloseTo(20 + Math.sqrt(200), 12);
    expect(polylineLength(SQUARE, true)).toBe(40);
    expect(polylineLength([3, 4])).toBe(0);
    expect(polylineLength([])).toBe(0);
  });

  it('finds the point and tangent at a fraction of the length', () => {
    expect(polylinePointAt(path, 0)).toEqual({ x: 0, y: 0, dx: 1, dy: 0 });
    expect(polylinePointAt(path, 0.25)).toEqual({ x: 5, y: 0, dx: 1, dy: 0 });
    expect(polylinePointAt(path, 0.75)).toEqual({ x: 10, y: 5, dx: 0, dy: 1 });
    expect(polylinePointAt(path, 1)).toEqual({ x: 10, y: 10, dx: 0, dy: 1 });
    expect(polylinePointAt(path, 7)).toEqual({ x: 10, y: 10, dx: 0, dy: 1 });
    expect(polylinePointAt(path, -1)).toEqual({ x: 0, y: 0, dx: 1, dy: 0 });
    const closing = polylinePointAt(SQUARE, 0.875, true);
    close([closing.x, closing.y, closing.dx, closing.dy], [0, 5, 0, -1]);
    expect(polylinePointAt([2, 3], 0.5)).toEqual({ x: 2, y: 3, dx: 0, dy: 0 });
    // Repeated points do not break the tangent.
    expect(polylinePointAt([0, 0, 0, 0, 4, 0, 4, 0], 0)).toEqual({ x: 0, y: 0, dx: 1, dy: 0 });
    expect(polylinePointAt([0, 0, 0, 0, 4, 0, 4, 0], 1)).toEqual({ x: 4, y: 0, dx: 1, dy: 0 });
  });

  it('resamples an open polyline evenly, keeping both ends', () => {
    expect(resamplePolyline(path, 5)).toEqual([0, 0, 5, 0, 10, 0, 10, 5, 10, 10]);
    expect(resamplePolyline(path, 2)).toEqual([0, 0, 10, 10]);
    const many = resamplePolyline([0, 0, 3, 4, 3, 10, 9, 10], 9);
    // Total length 5 + 6 + 6 = 17: consecutive samples are 17 / 8 apart along the path.
    expect(many.slice(0, 2)).toEqual([0, 0]);
    expect(many.slice(-2)).toEqual([9, 10]);
    for (let k = 0; k < 9; k++) {
      const p = closestOnPolyline([0, 0, 3, 4, 3, 10, 9, 10], many[k * 2], many[k * 2 + 1]);
      expect(p.distance).toBeLessThan(1e-9);
      expect(p.s).toBeCloseTo((17 * k) / 8, 9);
    }
  });

  it('resamples a closed polygon starting at its first vertex', () => {
    expect(resamplePolyline(SQUARE, 8, true)).toEqual([0, 0, 5, 0, 10, 0, 10, 5, 10, 10, 5, 10, 0, 10, 0, 5]);
    expect(resamplePolyline(SQUARE, 4, true)).toEqual(SQUARE);
    expect(resamplePolyline(SQUARE, 1, true)).toEqual([0, 0]);
  });

  it('validates the count and handles degenerate input', () => {
    expect(() => resamplePolyline(path, 1)).toThrow(/count must be an integer >= 2/);
    expect(() => resamplePolyline(path, 2.5)).toThrow(RangeError);
    expect(() => resamplePolyline([], 3)).toThrow(/empty/);
    expect(resamplePolyline([4, 4], 3)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(resamplePolyline([1, 1, 1, 1], 3)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe('closestOnPolyline', () => {
  const path = [0, 0, 10, 0, 10, 10];

  it('projects onto the nearest segment', () => {
    const p = closestOnPolyline(path, 4, 3);
    expect(p).toEqual({ distance: 3, x: 4, y: 0, s: 4, t: 0.2, segment: 0, u: 0.4 });
    const q = closestOnPolyline(path, 13, 7);
    expect(q).toEqual({ distance: 3, x: 10, y: 7, s: 17, t: 0.85, segment: 1, u: 0.7 });
  });

  it('clamps to the ends and to corners', () => {
    const before = closestOnPolyline(path, -3, -4);
    expect(before.distance).toBe(5);
    expect(before.t).toBe(0);
    const after = closestOnPolyline(path, 10, 14);
    expect(after.distance).toBe(4);
    expect(after.t).toBe(1);
    expect(after.segment).toBe(1);
    const corner = closestOnPolyline(path, 13, -4);
    expect(corner.distance).toBe(5);
    expect(corner.s).toBe(10);
    expect(corner.t).toBe(0.5);
  });

  it('includes the closing segment when closed', () => {
    const open = closestOnPolyline(SQUARE, -1, 5);
    expect(open.distance).toBeCloseTo(Math.sqrt(26), 12);
    const closed = closestOnPolyline(SQUARE, -1, 5, true);
    expect(closed.distance).toBe(1);
    expect(closed.segment).toBe(3);
    expect(closed.s).toBe(35);
    expect(closed.t).toBe(0.875);
  });

  it('handles a single point and zero-length segments', () => {
    expect(closestOnPolyline([2, 2], 5, 6)).toEqual({ distance: 5, x: 2, y: 2, s: 0, t: 0, segment: 0, u: 0 });
    const p = closestOnPolyline([0, 0, 0, 0, 10, 0], 5, 1);
    expect(p.distance).toBe(1);
    expect(p.t).toBe(0.5);
    expect(() => closestOnPolyline([], 0, 0)).toThrow(/empty/);
  });
});

describe('polygonEnvelope', () => {
  it('samples the upper and lower boundary of a diamond', () => {
    const e = polygonEnvelope([0, 5, 5, 0, 10, 5, 5, 10], 5);
    expect(e.x).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(e.upper).toEqual([5, 2.5, 0, 2.5, 5]);
    expect(e.lower).toEqual([5, 7.5, 10, 7.5, 5]);
  });

  it('spans vertical edges at the ends and ignores the winding', () => {
    for (const poly of [[2, 1, 8, 1, 8, 4, 2, 4], reversed([2, 1, 8, 1, 8, 4, 2, 4])]) {
      const e = polygonEnvelope(poly, 4);
      expect(e.x).toEqual([2, 4, 6, 8]);
      expect(e.upper).toEqual([1, 1, 1, 1]);
      expect(e.lower).toEqual([4, 4, 4, 4]);
    }
  });

  it('returns the outermost boundary of a concave shape', () => {
    // A "W"-like top: the notch at x = 5 reaches down to y = 4.
    const poly = [0, 0, 5, 4, 10, 0, 10, 10, 0, 10];
    const e = polygonEnvelope(poly, 5);
    expect(e.upper).toEqual([0, 2, 4, 2, 0]);
    expect(e.lower).toEqual([10, 10, 10, 10, 10]);
  });

  it('traces the lid lines of an eye-shaped outline', () => {
    const eye = ellipsePolygon(50, 40, 20, 8, 0, 256);
    const e = polygonEnvelope(eye, 21);
    expect(e.x[0]).toBeCloseTo(30, 2);
    expect(e.x[20]).toBeCloseTo(70, 2);
    for (let k = 1; k < 20; k++) {
      const half = 8 * Math.sqrt(Math.max(0, 1 - ((e.x[k] - 50) / 20) ** 2));
      expect(e.upper[k]).toBeCloseTo(40 - half, 1);
      expect(e.lower[k]).toBeCloseTo(40 + half, 1);
      expect(e.upper[k]).toBeLessThan(e.lower[k]);
    }
    expect(e.upper[0]).toBeCloseTo(40, 1);
    expect(e.lower[20]).toBeCloseTo(40, 1);
  });

  it('validates its input', () => {
    expect(() => polygonEnvelope(SQUARE, 1)).toThrow(/count must be an integer >= 2/);
    expect(() => polygonEnvelope([], 4)).toThrow(/empty/);
    // No width: both curves span the whole height at that x.
    const flat = polygonEnvelope([3, 1, 3, 9], 2);
    expect(flat.x).toEqual([3, 3]);
    expect(flat.upper).toEqual([1, 1]);
    expect(flat.lower).toEqual([9, 9]);
  });
});

describe('simplifyPolyline', () => {
  it('drops collinear points and keeps corners', () => {
    expect(simplifyPolyline([0, 0, 2, 0, 5, 0, 10, 0, 10, 4, 10, 10], 0.01)).toEqual([0, 0, 10, 0, 10, 10]);
  });

  it('keeps a bump only when it exceeds the tolerance', () => {
    const bumpy = [0, 0, 5, 0.4, 10, 0];
    expect(simplifyPolyline(bumpy, 0.5)).toEqual([0, 0, 10, 0]);
    expect(simplifyPolyline(bumpy, 0.3)).toEqual(bumpy);
    expect(simplifyPolyline(bumpy, 0)).toEqual(bumpy);
  });

  it('keeps every original point within the tolerance of the result', () => {
    const random = mulberry32(11);
    const wiggly: number[] = [];
    for (let k = 0; k <= 60; k++) wiggly.push(k * 2, 20 * Math.sin(k / 6) + (random() - 0.5) * 1.2);
    for (const tolerance of [0.5, 2, 6]) {
      const simple = simplifyPolyline(wiggly, tolerance);
      expect(simple.length).toBeLessThan(wiggly.length);
      expect(simple.slice(0, 2)).toEqual(wiggly.slice(0, 2));
      expect(simple.slice(-2)).toEqual(wiggly.slice(-2));
      for (let k = 0; k <= 60; k++) expect(closestOnPolyline(simple, wiggly[k * 2], wiggly[k * 2 + 1]).distance).toBeLessThanOrEqual(tolerance + 1e-9);
    }
    expect(simplifyPolyline(wiggly, 6).length).toBeLessThan(simplifyPolyline(wiggly, 0.5).length);
  });

  it('simplifies closed polygons without opening them or collapsing below a triangle', () => {
    const circle = ellipsePolygon(0, 0, 50, 50, 0, 200);
    const simple = simplifyPolyline(circle, 1, true);
    expect(simple.length / 2).toBeLessThan(40);
    expect(simple.length / 2).toBeGreaterThanOrEqual(8);
    for (let k = 0; k < 200; k++) expect(closestOnPolyline(simple, circle[k * 2], circle[k * 2 + 1], true).distance).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.abs(polygonArea(simple))).toBeGreaterThan(Math.PI * 2500 * 0.95);
    // A huge tolerance still leaves a triangle with area.
    const triangle = simplifyPolyline(circle, 1000, true);
    expect(triangle.length).toBe(6);
    expect(Math.abs(polygonArea(triangle))).toBeGreaterThan(1000);
    expect(simplifyPolyline([0, 0, 4, 0, 2, 3], 100, true)).toEqual([0, 0, 4, 0, 2, 3]);
    expect(simplifyPolyline([0, 0, 4, 0], 100)).toEqual([0, 0, 4, 0]);
  });
});

describe('smoothPolyline (corner cutting)', () => {
  it('cuts the corner of an open polyline and keeps its ends', () => {
    expect(smoothPolyline([0, 0, 10, 0, 10, 10])).toEqual([0, 0, 7.5, 0, 10, 2.5, 10, 10]);
    expect(smoothPolyline([0, 0, 10, 0])).toEqual([0, 0, 10, 0]);
    expect(smoothPolyline([0, 0, 10, 0, 10, 10], 0)).toEqual([0, 0, 10, 0, 10, 10]);
  });

  it('turns a closed square into an octagon, then a 16-gon', () => {
    const once = smoothPolyline(SQUARE, 1, true);
    expect(once).toEqual([2.5, 0, 7.5, 0, 10, 2.5, 10, 7.5, 7.5, 10, 2.5, 10, 0, 7.5, 0, 2.5]);
    expect(polygonArea(once)).toBeCloseTo(100 - 4 * (2.5 * 2.5) / 2, 12);
    const twice = smoothPolyline(SQUARE, 2, true);
    expect(twice.length).toBe(32);
    expect(polygonArea(twice)).toBeLessThan(polygonArea(once));
    expect(polygonArea(twice)).toBeGreaterThan(Math.PI * 25);
  });

  it('stays inside the hull and converges to a smooth curve', () => {
    const zigzag = [0, 0, 10, 10, 20, 0, 30, 10, 40, 0];
    const smooth = smoothPolyline(zigzag, 4);
    expect(smooth.slice(0, 2)).toEqual([0, 0]);
    expect(smooth.slice(-2)).toEqual([40, 0]);
    let largestTurn = 0;
    for (let k = 1; k + 1 < smooth.length / 2; k++) {
      const ax = smooth[k * 2] - smooth[k * 2 - 2];
      const ay = smooth[k * 2 + 1] - smooth[k * 2 - 1];
      const bx = smooth[k * 2 + 2] - smooth[k * 2];
      const by = smooth[k * 2 + 3] - smooth[k * 2 + 1];
      const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
      largestTurn = Math.max(largestTurn, turn);
      expect(smooth[k * 2 + 1]).toBeGreaterThanOrEqual(0);
      expect(smooth[k * 2 + 1]).toBeLessThanOrEqual(10);
    }
    // The original corners turn by 90 degrees; after four passes no corner turns more than a fraction of that.
    expect(largestTurn).toBeLessThan(Math.PI / 8);
  });
});

describe('self-intersection', () => {
  it('segmentsIntersect covers crossing, touching, collinear and separate segments', () => {
    expect(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 5, 0, 5, 5)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 10, 0, 20, 5)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 5, 0, 15, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 11, 0, 15, 0)).toBe(false);
    expect(segmentsIntersect(0, 0, 10, 0, 0, 1, 10, 1)).toBe(false);
    expect(segmentsIntersect(0, 0, 10, 10, 6, 5, 10, 5)).toBe(false);
  });

  it('accepts simple polygons, convex or concave, in both windings', () => {
    for (const poly of [SQUARE, L_SHAPE, ellipsePolygon(5, 5, 4, 2, 20, 40), [0, 0, 10, 0, 10, 10, 5, 3, 0, 10]]) {
      expect(polygonSelfIntersects(poly)).toBe(false);
      expect(polygonSelfIntersects(reversed(poly))).toBe(false);
    }
    expect(polygonSelfIntersects([0, 0, 4, 0, 2, 3])).toBe(false);
    expect(polygonSelfIntersects([0, 0, 4, 0])).toBe(false);
    expect(polygonSelfIntersects([])).toBe(false);
  });

  it('detects crossings, pinches and fold-backs', () => {
    expect(polygonSelfIntersects([0, 0, 10, 10, 10, 0, 0, 10])).toBe(true); // bow tie
    expect(polygonSelfIntersects([0, 0, 10, 0, 10, 10, 5, -3, 0, 10])).toBe(true); // a spike through the top edge
    expect(polygonSelfIntersects([0, 0, 4, 0, 4, 4, 2, 0, 0, 4])).toBe(true); // touches its own edge at (2, 0)
    expect(polygonSelfIntersects([0, 0, 10, 0, 5, 0, 5, 5])).toBe(true); // doubles back along its first edge
  });

  it('ignores repeated points and an explicitly repeated first point', () => {
    expect(polygonSelfIntersects([0, 0, 0, 0, 10, 0, 10, 10, 10, 10, 0, 10])).toBe(false);
    expect(polygonSelfIntersects([...SQUARE, 0, 0])).toBe(false);
  });

  it('checks open polylines without the closing segment', () => {
    const hook = [0, 0, 10, 0, 10, 10, 5, 10, 5, 5];
    expect(polygonSelfIntersects(hook, false)).toBe(false);
    const cross = [0, 0, 10, 0, 10, 10, 5, 10, 5, -5];
    expect(polygonSelfIntersects(cross, false)).toBe(true);
    // The same hook closed: the closing segment (5,5)-(0,0) crosses nothing either.
    expect(polygonSelfIntersects(hook, true)).toBe(false);
    // An open "Z" is simple; closing it draws the second diagonal across the first.
    const z = [0, 0, 10, 0, 0, 10, 10, 10];
    expect(polygonSelfIntersects(z, false)).toBe(false);
    expect(polygonSelfIntersects(z, true)).toBe(true);
  });
});

describe('ellipsePolygon / translatePoints', () => {
  it('has exactly the area of the ellipse and runs clockwise on screen', () => {
    for (const [rx, ry, rotation] of [
      [10, 10, 0],
      [20, 5, 33],
      [3, 40, -70],
      [0.5, 0.25, 0],
    ]) {
      const poly = ellipsePolygon(7, -3, rx, ry, rotation);
      expect(polygonArea(poly)).toBeCloseTo(Math.PI * rx * ry, 9);
      expect(pointCount(poly) % 4).toBe(0);
      close(polygonCentroid(poly), [7, -3], 9);
    }
    expect(pointCount(ellipsePolygon(0, 0, 600, 600))).toBeGreaterThan(300);
    expect(pointCount(ellipsePolygon(0, 0, 1, 1))).toBe(24);
  });

  it('stays within a few hundredths of a pixel of the true ellipse', () => {
    const poly = ellipsePolygon(0, 0, 300, 120);
    let worst = 0;
    for (let k = 0; k < poly.length; k += 2) worst = Math.max(worst, Math.abs(Math.sqrt((poly[k] / 300) ** 2 + (poly[k + 1] / 120) ** 2) - 1) * 300);
    expect(worst).toBeLessThan(0.03);
  });

  it('rotates clockwise for positive angles and honours an explicit segment count', () => {
    const poly = ellipsePolygon(10, 20, 8, 2, 90, 4);
    expect(pointCount(poly)).toBe(4);
    // The first point is the end of the rx axis, which a quarter turn clockwise points straight down.
    expect(poly[0]).toBeCloseTo(10, 9);
    expect(poly[1]).toBeGreaterThan(20 + 8);
    expect(polygonArea(poly)).toBeCloseTo(Math.PI * 16, 9);
    expect(pointCount(ellipsePolygon(0, 0, 5, 5, 0, 7))).toBe(7);
  });

  it('translates point lists', () => {
    expect(translatePoints([1, 2, 3, 4], 10, -1)).toEqual([11, 1, 13, 3]);
    expect(translatePoints(new Float64Array([1, 2]), 0.5, 0.5)).toEqual([1.5, 2.5]);
    expect(translatePoints([], 1, 1)).toEqual([]);
  });
});

describe('mulberry32', () => {
  /** The published reference implementation. */
  function reference(a: number): () => number {
    return () => {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('matches the reference implementation', () => {
    for (const seed of [0, 1, 42, 0xdeadbeef, 2 ** 32 - 1]) {
      const a = mulberry32(seed);
      const b = reference(seed);
      for (let k = 0; k < 50; k++) expect(a()).toBe(b());
    }
  });

  it('is reproducible, seed-dependent and uniform in [0, 1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const c = mulberry32(124);
    const first = Array.from({ length: 8 }, () => a());
    expect(Array.from({ length: 8 }, () => b())).toEqual(first);
    expect(Array.from({ length: 8 }, () => c())).not.toEqual(first);
    const r = mulberry32(9);
    let total = 0;
    let min = 1;
    let max = 0;
    const buckets = new Array(10).fill(0);
    for (let k = 0; k < 20000; k++) {
      const v = r();
      total += v;
      min = Math.min(min, v);
      max = Math.max(max, v);
      buckets[Math.floor(v * 10)]++;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1);
    expect(total / 20000).toBeCloseTo(0.5, 2);
    for (const count of buckets) expect(Math.abs(count - 2000)).toBeLessThan(200);
    // Negative and fractional seeds are read as uint32.
    expect(mulberry32(-1)()).toBe(mulberry32(2 ** 32 - 1)());
  });

  it('randomInt stays in range', () => {
    const r = mulberry32(5);
    const seen = new Set<number>();
    for (let k = 0; k < 500; k++) {
      const v = randomInt(r, 7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
    expect(randomInt(r, 1)).toBe(0);
  });
});
