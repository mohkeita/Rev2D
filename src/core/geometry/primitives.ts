/**
 * Flat point-list primitives shared by the geometry compiler.
 *
 * Points are flat lists [x0, y0, x1, y1, ...] in setup space. Orientation uses the algebraic cross
 * product: a loop is "positive" when its shoelace area is > 0 (clockwise on screen, since y points
 * down), and the filled interior of a positive loop lies on the algebraic left (-dy, dx) of each edge.
 */

/** Indexed triangle list: setup-space positions and 3 vertex indices per triangle. */
export interface Triangles {
  positions: number[];
  indices: number[];
}

/** Coordinates closer than REL_EPS × shape extent are treated as coincident (the `eps` of all predicates). */
export const REL_EPS = 1e-9;

/** Cross product (b - a) × (c - a): > 0 when a, b, c turn positively. */
export function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * orient(a, b, c), or 0 when the triangle is thinner than `eps`: some vertex lies within eps of the
 * line through the other two (|orient| / longest edge is the smallest height). The tolerance follows
 * the triangle's own size, so small triangles of a large outline are judged like large ones.
 */
export function orientTol(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, eps: number): number {
  const o = orient(ax, ay, bx, by, cx, cy);
  const longest2 = Math.max((bx - ax) ** 2 + (by - ay) ** 2, (cx - bx) ** 2 + (cy - by) ** 2, (ax - cx) ** 2 + (ay - cy) ** 2);
  return o * o <= eps * eps * longest2 ? 0 : o;
}

/**
 * Signed area of the (implicitly closed) loop; positive for positive orientation. Summed as a fan
 * from the first point, so it stays exact far from the origin (the textbook shoelace over absolute
 * coordinates cancels catastrophically for small shapes at large offsets).
 */
export function signedArea(p: ArrayLike<number>): number {
  const x0 = p[0];
  const y0 = p[1];
  let s = 0;
  for (let i = 2; i + 3 < p.length; i += 2) s += (p[i] - x0) * (p[i + 3] - y0) - (p[i + 2] - x0) * (p[i + 1] - y0);
  return s / 2;
}

/** Largest bounding-box side of a point list, at least 1: the scale of relative tolerances. */
export function extentOf(p: ArrayLike<number>): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < p.length; i += 2) {
    if (p[i] < minX) minX = p[i];
    if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 1] > maxY) maxY = p[i + 1];
  }
  return p.length < 2 ? 1 : Math.max(1, maxX - minX, maxY - minY);
}

/** Drop consecutive points within `eps` of each other (and a closing point equal to the first when `closed`). */
export function dedupe(p: ArrayLike<number>, closed: boolean, eps: number): number[] {
  const out: number[] = [];
  const eps2 = eps * eps;
  for (let i = 0; i + 1 < p.length; i += 2) {
    const m = out.length;
    if (m >= 2) {
      const dx = p[i] - out[m - 2];
      const dy = p[i + 1] - out[m - 1];
      if (dx * dx + dy * dy <= eps2) continue;
    }
    out.push(p[i], p[i + 1]);
  }
  while (closed && out.length >= 4) {
    const m = out.length;
    const dx = out[0] - out[m - 2];
    const dy = out[1] - out[m - 1];
    if (dx * dx + dy * dy > eps2) break;
    out.length = m - 2;
  }
  return out;
}

/**
 * Closed outline ready for filling: duplicate points, collinear points and zero-width spikes removed
 * (repeatedly, since each removal can expose another). Returns [] when fewer than 3 points remain.
 * The result starts at the lowest surviving input index, so it is stable for a given input.
 */
export function cleanPolygon(p: ArrayLike<number>, eps: number): number[] {
  const pts = dedupe(p, true, eps);
  const n = pts.length >> 1;
  if (n < 3) return [];
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const alive = new Uint8Array(n).fill(1);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    prev[i] = i === 0 ? n - 1 : i - 1;
    next[i] = i === n - 1 ? 0 : i + 1;
    stack.push(n - 1 - i);
  }
  let count = n;
  while (stack.length > 0 && count >= 3) {
    const b = stack.pop()!;
    if (!alive[b]) continue;
    const a = prev[b];
    const c = next[b];
    const abx = pts[2 * b] - pts[2 * a];
    const aby = pts[2 * b + 1] - pts[2 * a + 1];
    const bcx = pts[2 * c] - pts[2 * b];
    const bcy = pts[2 * c + 1] - pts[2 * b + 1];
    const lab = Math.hypot(abx, aby);
    const lbc = Math.hypot(bcx, bcy);
    // Redundant: coincides with a neighbour, or lies on the line through them (incl. spikes).
    if (lab > eps && lbc > eps && Math.abs(abx * bcy - aby * bcx) > eps * (lab + lbc)) continue;
    alive[b] = 0;
    next[a] = c;
    prev[c] = a;
    count--;
    stack.push(c, a);
  }
  if (count < 3) return [];
  let start = 0;
  while (!alive[start]) start++;
  const out: number[] = [];
  let i = start;
  do {
    out.push(pts[2 * i], pts[2 * i + 1]);
    i = next[i];
  } while (i !== start);
  return out;
}

/** Insert evenly spaced points so that no edge is longer than `maxLen`. */
export function subdivideEdges(p: ArrayLike<number>, closed: boolean, maxLen: number): number[] {
  const n = p.length >> 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x0 = p[2 * i];
    const y0 = p[2 * i + 1];
    out.push(x0, y0);
    if (!closed && i === n - 1) break;
    const j = i === n - 1 ? 0 : i + 1;
    const dx = p[2 * j] - x0;
    const dy = p[2 * j + 1] - y0;
    const k = Math.ceil(Math.hypot(dx, dy) / maxLen);
    for (let m = 1; m < k; m++) out.push(x0 + (dx * m) / k, y0 + (dy * m) / k);
  }
  return out;
}

/** Same points in reverse order. */
export function reversePoints(p: ArrayLike<number>): number[] {
  const out = new Array<number>(p.length);
  for (let i = 0, j = p.length - 2; j >= 0; i += 2, j -= 2) {
    out[i] = p[j];
    out[i + 1] = p[j + 1];
  }
  return out;
}

/**
 * Segments needed so that a circular arc of `radius` spanning `angle` (rad) deviates at most
 * `tolerance`, and (when given) no segment turns more than `maxStepAngle` (rad).
 */
export function arcSegments(radius: number, angle: number, tolerance: number, maxSegments: number, maxStepAngle = Infinity): number {
  const step = Math.min(2 * Math.acos(1 - Math.min(tolerance / radius, 1)), maxStepAngle);
  return Math.min(maxSegments, Math.max(1, Math.ceil(Math.abs(angle) / step)));
}

/** Append `src` to `target`, offsetting its indices. */
export function appendTriangles(target: Triangles, src: Triangles): void {
  const base = target.positions.length >> 1;
  for (const v of src.positions) target.positions.push(v);
  for (const i of src.indices) target.indices.push(i + base);
}
