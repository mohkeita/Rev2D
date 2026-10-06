/**
 * Small planar geometry helpers for avatar landmarks: flat point lists [x0, y0, x1, y1, ...],
 * polygons (any winding, concave allowed) and axis-aligned or rotated ellipses. Pure and
 * deterministic (Math.sqrt / sin / cos only on values that do not need bit-exact agreement between
 * engines: results feed diagnostics and overlay drawings, never model output).
 *
 * Used by the spec checks (src/avatar/spec.ts), the parts description and the agent tools.
 */

export type Vec2 = [number, number];
/** [minX, minY, maxX, maxY]. */
export type Bounds = [number, number, number, number];

const DEG = Math.PI / 180;

/** Number of complete points in a flat list. */
export function pointCount(points: ArrayLike<number>): number {
  return Math.floor(points.length / 2);
}

export function pointAt(points: ArrayLike<number>, i: number): Vec2 {
  return [points[i * 2], points[i * 2 + 1]];
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Bounds of the complete points of a flat list; null when it has none. */
export function pointsBounds(points: ArrayLike<number>): Bounds | null {
  const n = pointCount(points);
  if (n === 0) return null;
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
  return [minX, minY, maxX, maxY];
}

export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Signed area (positive = clockwise on screen, where +y points down). */
export function polygonArea(points: ArrayLike<number>): number {
  const n = pointCount(points);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return sum / 2;
}

/** Area centroid of a polygon; the mean of its vertices when the area is (nearly) zero. */
export function polygonCentroid(points: ArrayLike<number>): Vec2 {
  const n = pointCount(points);
  if (n === 0) return [NaN, NaN];
  const area = polygonArea(points);
  if (Math.abs(area) > 1e-9) {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const cross = points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
      cx += (points[i * 2] + points[j * 2]) * cross;
      cy += (points[i * 2 + 1] + points[j * 2 + 1]) * cross;
    }
    return [cx / (6 * area), cy / (6 * area)];
  }
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += points[i * 2];
    sy += points[i * 2 + 1];
  }
  return [sx / n, sy / n];
}

/** Even-odd point-in-polygon test (points exactly on an edge may fall either way). */
export function pointInPolygon(x: number, y: number, points: ArrayLike<number>): boolean {
  const n = pointCount(points);
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return distance(px, py, ax + t * dx, ay + t * dy);
}

/** Distance from a point to the outline of a closed polygon (or to an open polyline with `closed` false). */
export function distanceToOutline(x: number, y: number, points: ArrayLike<number>, closed = true): number {
  const n = pointCount(points);
  if (n === 0) return Infinity;
  if (n === 1) return distance(x, y, points[0], points[1]);
  let best = Infinity;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n;
    const d = distanceToSegment(x, y, points[i * 2], points[i * 2 + 1], points[j * 2], points[j * 2 + 1]);
    if (d < best) best = d;
  }
  return best;
}

/** How far a point lies outside a polygon: 0 inside, else the distance to its outline. */
export function outsideDistance(x: number, y: number, polygon: ArrayLike<number>): number {
  return pointInPolygon(x, y, polygon) ? 0 : distanceToOutline(x, y, polygon);
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * The point where segments AB and CD properly cross (interiors intersect at a single point), or
 * null. Touching end points and collinear overlaps do not count: outlines traced by hand often
 * repeat or nearly repeat a vertex.
 */
export function segmentCrossing(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): Vec2 | null {
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  if (!((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))) return null;
  if (!((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return null;
  const t = d1 / (d1 - d2);
  return [ax + t * (bx - ax), ay + t * (by - ay)];
}

export interface SelfIntersection {
  /** Edge i joins point i and point i + 1 (the last edge closes the polygon). */
  edgeA: number;
  edgeB: number;
  at: Vec2;
}

/** The first pair of non-adjacent edges of a closed polygon that cross, or null. */
export function polygonSelfIntersection(points: ArrayLike<number>): SelfIntersection | null {
  const n = pointCount(points);
  if (n < 4) return null;
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      const j2 = (j + 1) % n;
      if (j2 === i) continue; // the closing edge is adjacent to the first one
      const at = segmentCrossing(
        points[i * 2],
        points[i * 2 + 1],
        points[i2 * 2],
        points[i2 * 2 + 1],
        points[j * 2],
        points[j * 2 + 1],
        points[j2 * 2],
        points[j2 * 2 + 1],
      );
      if (at) return { edgeA: i, edgeB: j, at };
    }
  }
  return null;
}

/** True when two closed polygons share area: an edge of one crosses the other, or one contains the other. */
export function polygonsOverlap(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  const na = pointCount(a);
  const nb = pointCount(b);
  if (na < 3 || nb < 3) return false;
  const ba = pointsBounds(a)!;
  const bb = pointsBounds(b)!;
  if (ba[2] < bb[0] || bb[2] < ba[0] || ba[3] < bb[1] || bb[3] < ba[1]) return false;
  for (let i = 0; i < na; i++) {
    const i2 = (i + 1) % na;
    for (let j = 0; j < nb; j++) {
      const j2 = (j + 1) % nb;
      if (segmentCrossing(a[i * 2], a[i * 2 + 1], a[i2 * 2], a[i2 * 2 + 1], b[j * 2], b[j * 2 + 1], b[j2 * 2], b[j2 * 2 + 1])) return true;
    }
  }
  return pointInPolygon(a[0], a[1], b) || pointInPolygon(b[0], b[1], a);
}

// ----------------------------------------------------------------------------- ellipses

/**
 * Normalised radial position of a point in an ellipse: 0 at the centre, 1 on the outline, > 1
 * outside. `rotation` is in degrees, clockwise on screen.
 */
export function ellipseLevel(center: Vec2, radius: Vec2, rotation: number, x: number, y: number): number {
  let dx = x - center[0];
  let dy = y - center[1];
  if (rotation) {
    const c = Math.cos(rotation * DEG);
    const s = Math.sin(rotation * DEG);
    const rx = dx * c + dy * s;
    dy = -dx * s + dy * c;
    dx = rx;
  }
  const u = dx / radius[0];
  const v = dy / radius[1];
  return Math.sqrt(u * u + v * v);
}

/** `n` points on the outline of an ellipse as a flat list (rotation in degrees, clockwise on screen). */
export function ellipseOutline(center: Vec2, radius: Vec2, rotation = 0, n = 96): number[] {
  const c = Math.cos(rotation * DEG);
  const s = Math.sin(rotation * DEG);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ex = Math.cos(a) * radius[0];
    const ey = Math.sin(a) * radius[1];
    out.push(center[0] + ex * c - ey * s, center[1] + ex * s + ey * c);
  }
  return out;
}

/** Axis-aligned bounds of a (rotated) ellipse. */
export function ellipseBounds(center: Vec2, radius: Vec2, rotation = 0): Bounds {
  const c = Math.cos(rotation * DEG);
  const s = Math.sin(rotation * DEG);
  const hx = Math.sqrt(radius[0] * radius[0] * c * c + radius[1] * radius[1] * s * s);
  const hy = Math.sqrt(radius[0] * radius[0] * s * s + radius[1] * radius[1] * c * c);
  return [center[0] - hx, center[1] - hy, center[0] + hx, center[1] + hy];
}

/** Round to `digits` decimals without "-0". */
export function round(v: number, digits = 1): number {
  const k = 10 ** digits;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
}
