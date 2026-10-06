/**
 * Polygon and polyline helpers on flat point lists [x0, y0, x1, y1, ...] (+x right, +y down).
 * A polygon is implicitly closed (the last point connects to the first); a polyline is open unless
 * a function takes `closed`. Lengths use Math.sqrt (correctly rounded on every engine).
 */
import type { Points, Rect } from './types.js';

function countOf(points: Points): number {
  return Math.floor(points.length / 2);
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Number of points in a flat list. */
export function pointCount(points: Points): number {
  return countOf(points);
}

/** Bounding box of the points. Throws on an empty list. */
export function polygonBounds(points: Points): Rect {
  const n = countOf(points);
  if (n === 0) throw new RangeError('polygonBounds: the point list is empty');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Signed area of a polygon (shoelace). Positive when the points run CLOCKWISE ON SCREEN (+y is
 * down), negative when counter-clockwise. The absolute value is the enclosed area in px².
 */
export function polygonArea(points: Points): number {
  const n = countOf(points);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    sum += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return sum / 2;
}

/** Area centroid of a polygon; the mean of the points when the area is (nearly) zero. Throws on an empty list. */
export function polygonCentroid(points: Points): [number, number] {
  const n = countOf(points);
  if (n === 0) throw new RangeError('polygonCentroid: the point list is empty');
  // Shift to the first point so large coordinates do not cost precision.
  const ox = points[0];
  const oy = points[1];
  let a = 0;
  let cx = 0;
  let cy = 0;
  let mx = 0;
  let my = 0;
  let scale = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const x0 = points[i * 2] - ox;
    const y0 = points[i * 2 + 1] - oy;
    const x1 = points[j * 2] - ox;
    const y1 = points[j * 2 + 1] - oy;
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
    mx += x0;
    my += y0;
    scale = Math.max(scale, Math.abs(x0), Math.abs(y0));
  }
  if (Math.abs(a) <= 1e-12 * Math.max(1, scale * scale)) return [ox + mx / n, oy + my / n];
  return [ox + cx / (3 * a), oy + cy / (3 * a)];
}

/** True when (x, y) lies inside the polygon (even-odd rule; any winding, concave polygons allowed). */
export function pointInPolygon(points: Points, x: number, y: number): boolean {
  const n = countOf(points);
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

/** Total length of a polyline (plus the closing segment when `closed`). */
export function polylineLength(points: Points, closed = false): number {
  const n = countOf(points);
  let len = 0;
  for (let i = 0; i + 1 < n; i++) len += dist(points[i * 2], points[i * 2 + 1], points[i * 2 + 2], points[i * 2 + 3]);
  if (closed && n > 1) len += dist(points[n * 2 - 2], points[n * 2 - 1], points[0], points[1]);
  return len;
}

/** Cumulative arc length at every vertex (one extra entry for the closing segment when `closed`). */
function arcLengths(points: Points, closed: boolean): Float64Array {
  const n = countOf(points);
  const segs = closed && n > 1 ? n : Math.max(0, n - 1);
  const out = new Float64Array(segs + 1);
  for (let i = 0; i < segs; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    out[i + 1] = out[i] + dist(points[i * 2], points[i * 2 + 1], points[j * 2], points[j * 2 + 1]);
  }
  return out;
}

export interface PolylinePoint {
  x: number;
  y: number;
  /** Unit tangent (direction of travel); (0, 0) for a polyline without length. */
  dx: number;
  dy: number;
}

/** The point at the fraction `t` (0..1, clamped) of the polyline's arc length, with the tangent there. */
export function polylinePointAt(points: Points, t: number, closed = false): PolylinePoint {
  const n = countOf(points);
  if (n === 0) throw new RangeError('polylinePointAt: the point list is empty');
  const acc = arcLengths(points, closed);
  const total = acc[acc.length - 1];
  if (!(total > 0)) return { x: points[0], y: points[1], dx: 0, dy: 0 };
  const s = Math.min(Math.max(t, 0), 1) * total;
  let seg = 0;
  while (seg + 2 < acc.length && acc[seg + 1] < s) seg++;
  // Skip zero-length segments so the tangent is defined.
  while (seg + 2 < acc.length && acc[seg + 1] === acc[seg]) seg++;
  while (seg > 0 && acc[seg + 1] === acc[seg]) seg--;
  const j = seg + 1 === n ? 0 : seg + 1;
  const ax = points[seg * 2];
  const ay = points[seg * 2 + 1];
  const bx = points[j * 2];
  const by = points[j * 2 + 1];
  const len = acc[seg + 1] - acc[seg];
  const u = len > 0 ? Math.min(1, Math.max(0, (s - acc[seg]) / len)) : 0;
  return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u, dx: len > 0 ? (bx - ax) / len : 0, dy: len > 0 ? (by - ay) / len : 0 };
}

/**
 * `count` points evenly spaced by arc length. Open: the first and the last point are kept
 * (count >= 2). Closed: the points start at the first vertex and the last one sits one step before
 * it (count >= 1), so the result is again an implicitly closed polygon.
 */
export function resamplePolyline(points: Points, count: number, closed = false): number[] {
  const n = countOf(points);
  if (n === 0) throw new RangeError('resamplePolyline: the point list is empty');
  if (!Number.isInteger(count) || count < (closed ? 1 : 2)) {
    throw new RangeError(`resamplePolyline: count must be an integer >= ${closed ? 1 : 2}, got ${count}`);
  }
  const acc = arcLengths(points, closed);
  const total = acc[acc.length - 1];
  const out: number[] = new Array(count * 2);
  const steps = closed ? count : count - 1;
  let seg = 0;
  for (let k = 0; k < count; k++) {
    if (!closed && k === count - 1) {
      out[k * 2] = points[n * 2 - 2];
      out[k * 2 + 1] = points[n * 2 - 1];
      break;
    }
    const s = (total * k) / steps;
    while (seg + 2 < acc.length && acc[seg + 1] < s) seg++;
    const j = seg + 1 === n ? 0 : seg + 1;
    const len = acc[seg + 1] - acc[seg];
    const u = len > 0 ? Math.min(1, (s - acc[seg]) / len) : 0;
    out[k * 2] = points[seg * 2] + (points[j * 2] - points[seg * 2]) * u;
    out[k * 2 + 1] = points[seg * 2 + 1] + (points[j * 2 + 1] - points[seg * 2 + 1]) * u;
  }
  return out;
}

export interface PolylineProjection {
  /** Distance from the query point to the polyline, px. */
  distance: number;
  /** The closest point on the polyline. */
  x: number;
  y: number;
  /** Arc length from the first point to the closest point, px. */
  s: number;
  /** The same as a fraction of the total length: 0 at the first point, 1 at the last (0 for a polyline without length). */
  t: number;
  /** Index of the segment the closest point lies on, and the position inside it (0..1). */
  segment: number;
  u: number;
}

/** The closest point of a polyline to (x, y): distance and projection parameter. Ties go to the earliest segment. */
export function closestOnPolyline(points: Points, x: number, y: number, closed = false): PolylineProjection {
  const n = countOf(points);
  if (n === 0) throw new RangeError('closestOnPolyline: the point list is empty');
  const segs = closed && n > 1 ? n : n - 1;
  let best: PolylineProjection = { distance: dist(points[0], points[1], x, y), x: points[0], y: points[1], s: 0, t: 0, segment: 0, u: 0 };
  let bestD2 = best.distance * best.distance;
  let walked = 0;
  for (let i = 0; i < segs; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ax = points[i * 2];
    const ay = points[i * 2 + 1];
    const dx = points[j * 2] - ax;
    const dy = points[j * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let u = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = ax + dx * u;
    const py = ay + dy * u;
    const d2 = (px - x) * (px - x) + (py - y) * (py - y);
    const len = Math.sqrt(len2);
    if (d2 < bestD2 || i === 0) {
      bestD2 = d2;
      best = { distance: Math.sqrt(d2), x: px, y: py, s: walked + len * u, t: 0, segment: i, u };
    }
    walked += len;
  }
  best.t = walked > 0 ? best.s / walked : 0;
  return best;
}

export interface PolygonEnvelope {
  /** `count` x positions from the polygon's leftmost to its rightmost point, evenly spaced. */
  x: number[];
  /** Upper boundary (smallest y, the top on screen) of the polygon at each x. */
  upper: number[];
  /** Lower boundary (largest y) of the polygon at each x. */
  lower: number[];
}

/**
 * The upper and lower boundary curves of a polygon, sampled at `count` x positions between its
 * leftmost and rightmost point (e.g. the upper and lower lid line of an eye opening). At both ends
 * the two curves meet (or span the polygon's vertical edge there).
 */
export function polygonEnvelope(points: Points, count: number): PolygonEnvelope {
  const n = countOf(points);
  if (n === 0) throw new RangeError('polygonEnvelope: the point list is empty');
  if (!Number.isInteger(count) || count < 2) throw new RangeError(`polygonEnvelope: count must be an integer >= 2, got ${count}`);
  const b = polygonBounds(points);
  const xs: number[] = new Array(count);
  const upper: number[] = new Array(count);
  const lower: number[] = new Array(count);
  for (let k = 0; k < count; k++) {
    const x = k === count - 1 ? b.x + b.width : b.x + (b.width * k) / (count - 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const x0 = points[i * 2];
      const y0 = points[i * 2 + 1];
      const x1 = points[j * 2];
      const y1 = points[j * 2 + 1];
      if (x < Math.min(x0, x1) || x > Math.max(x0, x1)) continue;
      if (x0 === x1) {
        lo = Math.min(lo, y0, y1);
        hi = Math.max(hi, y0, y1);
      } else {
        const y = y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    xs[k] = x;
    upper[k] = lo;
    lower[k] = hi;
  }
  return { x: xs, upper, lower };
}

function simplifyRange(points: Points, first: number, last: number, tol2: number, keep: Uint8Array): void {
  // Iterative Ramer-Douglas-Peucker (an explicit stack: long polylines do not recurse deeply).
  const stack: number[] = [first, last];
  while (stack.length > 0) {
    const b = stack.pop() as number;
    const a = stack.pop() as number;
    const ax = points[a * 2];
    const ay = points[a * 2 + 1];
    const dx = points[b * 2] - ax;
    const dy = points[b * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD2 = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = points[i * 2] - ax;
      const py = points[i * 2 + 1] - ay;
      let u = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = px - dx * u;
      const ey = py - dy * u;
      const d2 = ex * ex + ey * ey;
      if (d2 > worstD2) {
        worstD2 = d2;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push(a, worst, worst, b);
    }
  }
}

/**
 * Ramer-Douglas-Peucker simplification: drops points that lie within `tolerance` px of the
 * simplified line. Open polylines keep both ends; closed polygons keep the first point and the
 * point farthest from it, and never go below 3 points when they had at least 3.
 */
export function simplifyPolyline(points: Points, tolerance: number, closed = false): number[] {
  const n = countOf(points);
  const tol2 = Math.max(0, tolerance) ** 2;
  const keep = new Uint8Array(n);
  if (n <= 2 || (closed && n <= 3)) return Array.from({ length: n * 2 }, (_, i) => points[i]);
  if (!closed) {
    keep[0] = 1;
    keep[n - 1] = 1;
    simplifyRange(points, 0, n - 1, tol2, keep);
  } else {
    // Work on the loop opened at point 0 with point 0 repeated at the end.
    let far = 1;
    let farD2 = -1;
    for (let i = 1; i < n; i++) {
      const dx = points[i * 2] - points[0];
      const dy = points[i * 2 + 1] - points[1];
      const d2 = dx * dx + dy * dy;
      if (d2 > farD2) {
        farD2 = d2;
        far = i;
      }
    }
    const loop = new Float64Array((n + 1) * 2);
    for (let i = 0; i < n * 2; i++) loop[i] = points[i];
    loop[n * 2] = points[0];
    loop[n * 2 + 1] = points[1];
    const keepLoop = new Uint8Array(n + 1);
    keepLoop[0] = 1;
    keepLoop[far] = 1;
    keepLoop[n] = 1;
    simplifyRange(loop, 0, far, tol2, keepLoop);
    simplifyRange(loop, far, n, tol2, keepLoop);
    keep.set(keepLoop.subarray(0, n));
    let kept = 0;
    for (let i = 0; i < n; i++) kept += keep[i];
    if (kept < 3) {
      // Keep a triangle: add the point farthest from the line through the two kept points.
      let third = -1;
      let thirdD = -1;
      const dx = points[far * 2] - points[0];
      const dy = points[far * 2 + 1] - points[1];
      for (let i = 1; i < n; i++) {
        if (i === far) continue;
        const d = Math.abs((points[i * 2] - points[0]) * dy - (points[i * 2 + 1] - points[1]) * dx);
        if (d > thirdD) {
          thirdD = d;
          third = i;
        }
      }
      if (third >= 0) keep[third] = 1;
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}

/**
 * Corner-cutting smoothing (Chaikin): every pass replaces each corner by two points at 1/4 and 3/4
 * of its segments, which converges to a smooth quadratic B-spline. Open polylines keep their ends;
 * the point count roughly doubles per pass. The curve stays inside the hull of the input, so a
 * closed polygon shrinks slightly at its corners.
 */
export function smoothPolyline(points: Points, iterations = 1, closed = false): number[] {
  let cur: number[] = Array.from({ length: countOf(points) * 2 }, (_, i) => points[i]);
  for (let it = 0; it < iterations; it++) {
    const n = cur.length / 2;
    if (n < 3) break;
    const next: number[] = [];
    const segs = closed ? n : n - 1;
    if (!closed) next.push(cur[0], cur[1]);
    for (let i = 0; i < segs; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const ax = cur[i * 2];
      const ay = cur[i * 2 + 1];
      const bx = cur[j * 2];
      const by = cur[j * 2 + 1];
      // Open ends: the first / last segment only contributes its inner point.
      if (closed || i > 0) next.push(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25);
      if (closed || i < segs - 1) next.push(ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75);
    }
    if (!closed) next.push(cur[n * 2 - 2], cur[n * 2 - 1]);
    cur = next;
  }
  return cur;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function onSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
  return px >= Math.min(ax, bx) && px <= Math.max(ax, bx) && py >= Math.min(ay, by) && py <= Math.max(ay, by);
}

/** True when the segments a-b and c-d share at least one point (touching counts). */
export function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (o2 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  if (o3 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (o4 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  return false;
}

/**
 * True when two edges of the polygon that are not neighbours cross or touch, or when neighbouring
 * edges fold back onto each other. Repeated consecutive points are ignored. O(n²): meant for
 * hand-placed outlines (tens to hundreds of points).
 */
export function polygonSelfIntersects(points: Points, closed = true): boolean {
  // Drop repeated consecutive points (and a last point equal to the first for closed polygons).
  const p: number[] = [];
  for (let i = 0; i < countOf(points); i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    const m = p.length;
    if (m >= 2 && p[m - 2] === x && p[m - 1] === y) continue;
    p.push(x, y);
  }
  if (closed && p.length >= 4 && p[0] === p[p.length - 2] && p[1] === p[p.length - 1]) p.length -= 2;
  const n = p.length / 2;
  const segs = closed ? n : n - 1;
  if (segs < 2 || (closed && n < 3)) return false;
  for (let i = 0; i < segs; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 1; j < segs; j++) {
      const j2 = (j + 1) % n;
      const adjacent = j === i + 1 || (closed && i === 0 && j === segs - 1);
      if (!adjacent) {
        if (segmentsIntersect(p[i * 2], p[i * 2 + 1], p[i2 * 2], p[i2 * 2 + 1], p[j * 2], p[j * 2 + 1], p[j2 * 2], p[j2 * 2 + 1])) return true;
        continue;
      }
      // Neighbours share one vertex; they overlap only when the path doubles back on itself.
      const [s, m, e] = j === i + 1 ? [i, i2, j2] : [j, i, i2];
      if (orient(p[s * 2], p[s * 2 + 1], p[m * 2], p[m * 2 + 1], p[e * 2], p[e * 2 + 1]) !== 0) continue;
      const dot = (p[s * 2] - p[m * 2]) * (p[e * 2] - p[m * 2]) + (p[s * 2 + 1] - p[m * 2 + 1]) * (p[e * 2 + 1] - p[m * 2 + 1]);
      if (dot > 0) return true;
    }
  }
  return false;
}

/**
 * An ellipse as a polygon. `rotation` is in degrees, clockwise-positive on screen (the Rev2D
 * convention); the points run clockwise on screen, starting at the end of the rx axis. The polygon
 * is scaled so its area equals the ellipse's exactly (pi * rx * ry). `segments` defaults to a count
 * that keeps the outline within about 0.02 px of the true ellipse.
 */
export function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, rotation = 0, segments?: number): number[] {
  const r = Math.max(Math.abs(rx), Math.abs(ry));
  let n = segments ?? Math.ceil((Math.PI * Math.sqrt(r / 0.04)) / 4) * 4;
  n = Math.max(3, Math.min(4096, Math.floor(segments === undefined ? Math.max(n, 24) : n)));
  // Area of the inscribed n-gon of a unit circle is (n / 2) sin(2 pi / n): scale it up to pi.
  const k = Math.sqrt((2 * Math.PI) / (n * Math.sin((2 * Math.PI) / n)));
  const rad = (rotation * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const out: number[] = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const ex = Math.cos(a) * rx * k;
    const ey = Math.sin(a) * ry * k;
    out[i * 2] = cx + ex * c - ey * s;
    out[i * 2 + 1] = cy + ex * s + ey * c;
  }
  return out;
}

/** The points shifted by (dx, dy), e.g. into the coordinates of a crop. */
export function translatePoints(points: Points, dx: number, dy: number): number[] {
  const n = countOf(points);
  const out: number[] = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = points[i * 2] + dx;
    out[i * 2 + 1] = points[i * 2 + 1] + dy;
  }
  return out;
}
