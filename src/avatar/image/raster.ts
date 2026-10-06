/**
 * Antialiased rasterisation into masks: polygons (exact area coverage), ellipses, smooth row bands
 * and strokes around polylines. Coordinates are pixels; pixel (x, y) covers [x, x+1) x [y, y+1).
 */
import { createMask } from './mask.js';
import { ellipsePolygon } from './polygon.js';
import type { Mask, Points } from './types.js';

/**
 * Add the signed coverage deltas of the edge (x0, y0) -> (x1, y1) to the accumulation buffer
 * (`stride` values per row, `rows` rows). The edge must lie within 0 <= x <= stride - 2. After all
 * edges of a closed outline, the running sum along each row is the signed covered area per pixel
 * (the technique of font rasterisers: exact for straight edges, no supersampling).
 */
function accumulateEdge(acc: Float64Array, stride: number, rows: number, x0: number, y0: number, x1: number, y1: number): void {
  if (y0 === y1) return;
  let dir = 1;
  if (y0 > y1) {
    dir = -1;
    let t = x0;
    x0 = x1;
    x1 = t;
    t = y0;
    y0 = y1;
    y1 = t;
  }
  if (y1 <= 0 || y0 >= rows) return;
  const maxX = stride - 2;
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  let top = y0;
  if (y0 < 0) {
    x -= y0 * dxdy;
    top = 0;
  }
  const bottom = Math.min(rows, y1);
  for (let y = Math.floor(top); y < bottom; y++) {
    const dy = Math.min(y + 1, bottom) - Math.max(y, top);
    let xnext = x + dxdy * dy;
    // Rounding may push a clipped edge a hair outside its column range.
    if (x < 0) x = 0;
    else if (x > maxX) x = maxX;
    if (xnext < 0) xnext = 0;
    else if (xnext > maxX) xnext = maxX;
    const d = dy * dir;
    const row = y * stride;
    const xlo = x < xnext ? x : xnext;
    const xhi = x < xnext ? xnext : x;
    const lo = Math.floor(xlo);
    const hi = Math.ceil(xhi);
    if (hi <= lo + 1) {
      // The edge stays inside one pixel column: split the delta by where it crosses on average.
      const mid = 0.5 * (x + xnext) - lo;
      acc[row + lo] += d - d * mid;
      acc[row + lo + 1] += d * mid;
    } else {
      const s = 1 / (xhi - xlo);
      const f0 = xlo - lo;
      const a0 = 0.5 * s * (1 - f0) * (1 - f0);
      const f1 = xhi - hi + 1;
      const am = 0.5 * s * f1 * f1;
      acc[row + lo] += d * a0;
      if (hi === lo + 2) {
        acc[row + lo + 1] += d * (1 - a0 - am);
      } else {
        const a1 = s * (1.5 - f0);
        acc[row + lo + 1] += d * (a1 - a0);
        for (let xi = lo + 2; xi < hi - 1; xi++) acc[row + xi] += d * s;
        const a2 = a1 + (hi - lo - 3) * s;
        acc[row + hi - 1] += d * (1 - a2 - am);
      }
      acc[row + hi] += d * am;
    }
    x = xnext;
  }
}

/**
 * Clip the edge to the column range 0..cols and accumulate it. What lies left of the range still
 * covers every pixel to its right, so it is replaced by an edge along x = 0; what lies right of the
 * range covers nothing inside and is moved onto x = cols (the padding column).
 */
function accumulateClipped(acc: Float64Array, stride: number, rows: number, cols: number, x0: number, y0: number, x1: number, y1: number): void {
  if (y0 === y1) return;
  if (x0 >= 0 && x0 <= cols && x1 >= 0 && x1 <= cols) {
    accumulateEdge(acc, stride, rows, x0, y0, x1, y1);
    return;
  }
  // Parameters where the edge crosses x = 0 and x = cols, in order.
  const dx = x1 - x0;
  let ta = 0;
  let tb = 1;
  if (dx !== 0) {
    const t0 = (0 - x0) / dx;
    const t1 = (cols - x0) / dx;
    ta = Math.min(1, Math.max(0, Math.min(t0, t1)));
    tb = Math.min(1, Math.max(0, Math.max(t0, t1)));
  }
  const cuts = [0, ta, tb, 1];
  for (let k = 0; k < 3; k++) {
    const u0 = cuts[k];
    const u1 = cuts[k + 1];
    if (u1 <= u0) continue;
    const ya = y0 + (y1 - y0) * u0;
    const yb = k === 2 || u1 === 1 ? y1 : y0 + (y1 - y0) * u1;
    const mid = x0 + dx * 0.5 * (u0 + u1);
    if (mid < 0) accumulateEdge(acc, stride, rows, 0, ya, 0, yb);
    else if (mid > cols) accumulateEdge(acc, stride, rows, cols, ya, cols, yb);
    else {
      const xa = Math.min(cols, Math.max(0, x0 + dx * u0));
      const xb = Math.min(cols, Math.max(0, x0 + dx * u1));
      accumulateEdge(acc, stride, rows, xa, ya, xb, yb);
    }
  }
}

/**
 * Rasterise a polygon into `mask` IN PLACE, combining with what is there by maximum (a union).
 * See polygonMask for the coverage rules.
 */
export function fillPolygon(mask: Mask, points: Points): void {
  const n = Math.floor(points.length / 2);
  if (n < 3) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n * 2; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError(`fillPolygon: point ${i / 2} is not finite (${x}, ${y})`);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const px0 = Math.max(0, Math.floor(minX));
  const py0 = Math.max(0, Math.floor(minY));
  const px1 = Math.min(mask.width, Math.ceil(maxX));
  const py1 = Math.min(mask.height, Math.ceil(maxY));
  const cols = px1 - px0;
  const rows = py1 - py0;
  if (cols <= 0 || rows <= 0) return;
  const stride = cols + 2;
  const acc = new Float64Array(stride * rows);
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    accumulateClipped(acc, stride, rows, cols, points[i * 2] - px0, points[i * 2 + 1] - py0, points[j * 2] - px0, points[j * 2 + 1] - py0);
  }
  const out = mask.data;
  for (let y = 0; y < rows; y++) {
    let sum = 0;
    const src = y * stride;
    const dst = (y + py0) * mask.width + px0;
    for (let x = 0; x < cols; x++) {
      sum += acc[src + x];
      let v = sum < 0 ? -sum : sum;
      // Float64 sums of exact areas are off by ~1e-13: snap so "outside" is exactly 0 and "inside" exactly 1.
      if (v < 1e-9) continue;
      if (v > 1 - 1e-9) v = 1;
      if (v > out[dst + x]) out[dst + x] = v;
    }
  }
}

/**
 * A polygon as an antialiased mask: every pixel gets the exact fraction of its area that the
 * polygon covers. Any winding, concave polygons allowed; parts outside the mask are clipped.
 * Self-overlapping outlines follow the non-zero rule (overlaps of the same winding stay filled).
 * Fewer than 3 points give an empty mask.
 */
export function polygonMask(width: number, height: number, points: Points): Mask {
  const mask = createMask(width, height);
  fillPolygon(mask, points);
  return mask;
}

/**
 * An ellipse as an antialiased mask. `rotation` is in degrees, clockwise-positive on screen.
 * The covered area equals pi * rx * ry (when the ellipse lies inside the mask).
 */
export function ellipseMask(width: number, height: number, cx: number, cy: number, rx: number, ry: number, rotation = 0): Mask {
  const mask = createMask(width, height);
  if (!(Math.abs(rx) > 0) || !(Math.abs(ry) > 0)) return mask;
  fillPolygon(mask, ellipsePolygon(cx, cy, rx, ry, rotation));
  return mask;
}

/** Hermite smoothstep: 0 for x <= edge0, 1 for x >= edge1, smooth (zero slope at both ends) in between. Works for edge0 > edge1 too. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  let t = (x - edge0) / (edge1 - edge0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** The value of a band at the row position y: 1 on the yStart side, smoothstep to 0 at yEnd. */
export function bandValue(yStart: number, yEnd: number, y: number): number {
  return 1 - smoothstep(yStart, yEnd, y);
}

/**
 * A smooth row band: 1 above `yStart`, a smoothstep fade to 0 at `yEnd`, 0 below (evaluated at the
 * pixel centres). With yStart > yEnd the band is flipped: full below yStart, fading upward to yEnd.
 */
export function bandMask(width: number, height: number, yStart: number, yEnd: number): Mask {
  const mask = createMask(width, height);
  for (let y = 0; y < height; y++) {
    const v = bandValue(yStart, yEnd, y + 0.5);
    if (v > 0) mask.data.fill(v, y * width, (y + 1) * width);
  }
  return mask;
}

export interface StrokeOptions {
  /** Connect the last point back to the first. */
  closed?: boolean;
  /**
   * Width in px of an extra soft falloff outside the radius: the value fades linearly from 1 at
   * `radius` to 0 at `radius + soft`. Default 0 (a plain antialiased edge).
   */
  soft?: number;
}

/**
 * A stroke mask: every pixel within `radius` px of the polyline (round caps and joins), with an
 * antialiased edge. A single point gives a disc.
 */
export function strokeMask(width: number, height: number, points: Points, radius: number, opts: StrokeOptions = {}): Mask {
  const mask = createMask(width, height);
  const n = Math.floor(points.length / 2);
  if (n === 0 || !(radius >= 0)) return mask;
  const soft = Math.max(0, opts.soft ?? 0);
  // Coverage as a function of the distance d: 1 up to the radius, then a ramp of max(1, soft) px
  // centred like a box-filtered edge.
  const ramp = Math.max(1, soft);
  const full = soft >= 1 ? radius : radius + soft / 2 - 0.5;
  const reach = full + ramp;
  const out = mask.data;
  const segs = n === 1 ? 1 : opts.closed && n > 2 ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = n === 1 ? 0 : i + 1 === n ? 0 : i + 1;
    const ax = points[i * 2];
    const ay = points[i * 2 + 1];
    const bx = points[j * 2];
    const by = points[j * 2 + 1];
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) {
      throw new RangeError(`strokeMask: point ${i} or ${j} is not finite`);
    }
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const ya = Math.max(0, Math.floor(Math.min(ay, by) - reach));
    const yb = Math.min(height - 1, Math.ceil(Math.max(ay, by) + reach));
    for (let py = ya; py <= yb; py++) {
      const cy = py + 0.5;
      // Only the part of the segment within `reach` of this row can cover pixels of the row.
      let lo = Math.min(ax, bx);
      let hi = Math.max(ax, bx);
      if (dy !== 0) {
        const ta = (cy - reach - ay) / dy;
        const tb = (cy + reach - ay) / dy;
        const t0 = Math.max(0, Math.min(ta, tb));
        const t1 = Math.min(1, Math.max(ta, tb));
        if (t0 > t1) continue;
        lo = Math.min(ax + t0 * dx, ax + t1 * dx);
        hi = Math.max(ax + t0 * dx, ax + t1 * dx);
      }
      const xa = Math.max(0, Math.floor(lo - reach));
      const xb = Math.min(width - 1, Math.ceil(hi + reach));
      const row = py * width;
      for (let px = xa; px <= xb; px++) {
        const cx = px + 0.5;
        let t = len2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx - cx;
        const ey = ay + t * dy - cy;
        const d = Math.sqrt(ex * ex + ey * ey);
        let c = (reach - d) / ramp;
        if (c <= 0) continue;
        if (c > 1) c = 1;
        if (c > out[row + px]) out[row + px] = c;
      }
    }
  }
  return mask;
}
