/**
 * Exact Euclidean distance transforms (Felzenszwalb & Huttenlocher, linear time) and what builds on
 * them: sub-pixel signed distance to a mask's edge, feathering, dilation and erosion by a radius.
 *
 * Two notions of distance:
 * - distanceTransform: the classic binary transform. Distance between PIXEL CENTRES, from every
 *   pixel to the nearest set pixel.
 * - signedDistance: distance from each pixel centre to the mask's EDGE, the 0.5 level of the
 *   (bilinearly interpolated) mask, negative inside. It reads antialiased edges with sub-pixel
 *   accuracy, so feathering or growing an antialiased shape stays smooth instead of stair-stepped.
 *
 * The image border is not an edge: a mask that runs into the border is treated as continuing
 * beyond it (eroding or feathering a bust that is cut by the canvas does not eat into it there).
 */
import { createMask, cropMask, maskBounds } from './mask.js';
import type { DistanceField, Mask } from './types.js';

/**
 * Lower envelope of the parabolas y = (x - q)² + f[q] over q = 0..n-1 (entries with f = Infinity are
 * skipped), evaluated at every integer x: out[x] = min over q of (x - q)² + f[q].
 * `v` (Int32, n) and `z` (Float64, n + 1) are scratch buffers.
 */
function envelope(f: Float32Array, out: Float32Array, n: number, v: Int32Array, z: Float64Array): void {
  let k = -1;
  for (let q = 0; q < n; q++) {
    const fq = f[q];
    if (fq === Infinity) continue;
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    const base = fq + q * q;
    let p = v[k];
    let s = (base - (f[p] + p * p)) / (2 * (q - p));
    while (s <= z[k]) {
      k--;
      p = v[k];
      s = (base - (f[p] + p * p)) / (2 * (q - p));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (k < 0) {
    out.fill(Infinity, 0, n);
    return;
  }
  k = 0;
  for (let x = 0; x < n; x++) {
    while (z[k + 1] < x) k++;
    const p = v[k];
    out[x] = (x - p) * (x - p) + f[p];
  }
}

/** Envelope along every row of `grid` (width x height), in place. */
function envelopeRows(grid: Float32Array, width: number, height: number): void {
  const v = new Int32Array(width);
  const z = new Float64Array(width + 1);
  const f = new Float32Array(width);
  for (let y = 0; y < height; y++) {
    const row = grid.subarray(y * width, (y + 1) * width);
    f.set(row);
    envelope(f, row, width, v, z);
  }
}

/** Envelope along every column of `grid` (width x height), in place. */
function envelopeColumns(grid: Float32Array, width: number, height: number): void {
  const v = new Int32Array(height);
  const z = new Float64Array(height + 1);
  const f = new Float32Array(height);
  const d = new Float32Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0, i = x; y < height; y++, i += width) f[y] = grid[i];
    envelope(f, d, height, v, z);
    for (let y = 0, i = x; y < height; y++, i += width) grid[i] = d[y];
  }
}

/**
 * Exact Euclidean distance transform of a binary mask: for every pixel the distance (in px, between
 * pixel centres) to the nearest pixel whose value is >= `threshold`. Set pixels are 0; an empty mask
 * gives Infinity everywhere.
 */
export function distanceTransform(mask: Mask, threshold = 0.5): DistanceField {
  const { width, height, data } = mask;
  const out = createMask(width, height);
  const g = out.data;
  // Pass 1: distance to the nearest set pixel within the column (two scans in row order).
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      g[i] = data[i] >= threshold ? 0 : y > 0 ? g[i - width] + 1 : Infinity;
    }
  }
  for (let y = height - 2; y >= 0; y--) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const below = g[i + width] + 1;
      if (below < g[i]) g[i] = below;
    }
  }
  // Pass 2: combine the columns along each row.
  for (let i = 0; i < g.length; i++) g[i] *= g[i];
  envelopeRows(g, width, height);
  for (let i = 0; i < g.length; i++) g[i] = Math.sqrt(g[i]);
  return out;
}

/**
 * Squared distance to the nearest point where the mask crosses `threshold` along a COLUMN (the
 * crossing is placed between two pixel centres by linear interpolation), for every pixel.
 */
function crossingsAlongColumns(data: Float32Array, width: number, height: number, threshold: number): Float32Array {
  const g = new Float32Array(width * height).fill(Infinity);
  const edge = new Float64Array(width);
  edge.fill(-Infinity);
  for (let y = 1; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const a = data[i - width];
      const b = data[i];
      if (a >= threshold !== b >= threshold) edge[x] = y - 1 + (threshold - a) / (b - a);
      g[i] = y - edge[x];
    }
  }
  edge.fill(Infinity);
  for (let y = height - 2; y >= 0; y--) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const a = data[i];
      const b = data[i + width];
      if (a >= threshold !== b >= threshold) edge[x] = y + (threshold - a) / (b - a);
      const d = edge[x] - y;
      if (d < g[i]) g[i] = d;
    }
  }
  for (let i = 0; i < g.length; i++) g[i] *= g[i];
  return g;
}

/** The same along ROWS. */
function crossingsAlongRows(data: Float32Array, width: number, height: number, threshold: number): Float32Array {
  const g = new Float32Array(width * height).fill(Infinity);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let edge = -Infinity;
    for (let x = 1; x < width; x++) {
      const a = data[row + x - 1];
      const b = data[row + x];
      if (a >= threshold !== b >= threshold) edge = x - 1 + (threshold - a) / (b - a);
      g[row + x] = x - edge;
    }
    edge = Infinity;
    for (let x = width - 2; x >= 0; x--) {
      const a = data[row + x];
      const b = data[row + x + 1];
      if (a >= threshold !== b >= threshold) edge = x + (threshold - a) / (b - a);
      const d = edge - x;
      if (d < g[row + x]) g[row + x] = d;
    }
  }
  for (let i = 0; i < g.length; i++) g[i] *= g[i];
  return g;
}

/** Squared distance from (px, py) to the segment (ax, ay)-(bx, by). */
function segmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** How far (in pixels) around an edge cell the exact contour distance is written. */
const NEAR = 3;

/**
 * Lower `sq` (squared distances) near the edge to the distance to the edge CONTOUR: in every 2 x 2
 * cell of pixel centres that the edge passes through, the crossings on the cell's sides are joined
 * by straight segments (marching squares), and the pixels up to NEAR px around the cell take the
 * distance to those segments. The crossings alone are up to 0.3 px too far for a pixel next to a
 * diagonal edge (its nearest edge point lies between two grid lines).
 */
function refineNearContour(data: Float32Array, width: number, height: number, threshold: number, sq: Float32Array): void {
  const seg = new Float64Array(8);
  for (let cy = 0; cy + 1 < height; cy++) {
    const row = cy * width;
    for (let cx = 0; cx + 1 < width; cx++) {
      const a = data[row + cx];
      const b = data[row + cx + 1];
      const c = data[row + width + cx + 1];
      const d = data[row + width + cx];
      const ia = a >= threshold;
      const ib = b >= threshold;
      const ic = c >= threshold;
      const id = d >= threshold;
      if (ia === ib && ib === ic && ic === id) continue;
      // Crossings on the cell's sides (pixel-centre coordinates).
      const tx = cx + (threshold - a) / (b - a); // top:    a - b
      const ry = cy + (threshold - b) / (c - b); // right:  b - c
      const bx = cx + (threshold - d) / (c - d); // bottom: d - c
      const ly = cy + (threshold - a) / (d - a); // left:   a - d
      let count = 0;
      const top = ia !== ib;
      const right = ib !== ic;
      const bottom = id !== ic;
      const left = ia !== id;
      if (top && right && bottom && left) {
        // Two opposite corners are inside: the cell centre decides which pair the contour separates.
        const centreInside = (a + b + c + d) / 4 >= threshold;
        if (ia === centreInside) {
          seg.set([tx, cy, cx + 1, ry, bx, cy + 1, cx, ly]); // around b and around d
        } else {
          seg.set([tx, cy, cx, ly, cx + 1, ry, bx, cy + 1]); // around a and around c
        }
        count = 2;
      } else {
        let k = 0;
        if (top) {
          seg[k++] = tx;
          seg[k++] = cy;
        }
        if (right) {
          seg[k++] = cx + 1;
          seg[k++] = ry;
        }
        if (bottom) {
          seg[k++] = bx;
          seg[k++] = cy + 1;
        }
        if (left) {
          seg[k++] = cx;
          seg[k++] = ly;
        }
        count = 1;
      }
      const x0 = Math.max(0, cx - NEAR + 1);
      const x1 = Math.min(width - 1, cx + NEAR);
      const y0 = Math.max(0, cy - NEAR + 1);
      const y1 = Math.min(height - 1, cy + NEAR);
      for (let s = 0; s < count; s++) {
        const ax = seg[s * 4];
        const ay = seg[s * 4 + 1];
        const ex = seg[s * 4 + 2];
        const ey = seg[s * 4 + 3];
        for (let py = y0; py <= y1; py++) {
          for (let px = x0; px <= x1; px++) {
            const d2 = segmentDistanceSq(px, py, ax, ay, ex, ey);
            const i = py * width + px;
            if (d2 < sq[i]) sq[i] = d2;
          }
        }
      }
    }
  }
}

/**
 * Signed distance from every pixel centre to the mask's edge (its `threshold` level, default 0.5):
 * NEGATIVE inside the mask, POSITIVE outside, in px with sub-pixel accuracy (within about 0.1 px
 * for antialiased shapes; a hard-edged binary mask is read as the polyline through the middles of
 * its pixel steps). A mask without an edge gives -Infinity (all inside) or +Infinity (all outside)
 * everywhere.
 *
 * Method: the edge is sampled where it crosses the grid lines through the pixel centres (linear
 * interpolation between neighbouring pixels). Two exact distance transforms give the distance to
 * the nearest crossing on a vertical and on a horizontal grid line; within 3 px of the edge the
 * distance to the contour segments between the crossings replaces it.
 */
export function signedDistance(mask: Mask, threshold = 0.5): DistanceField {
  const { width, height, data } = mask;
  const out = createMask(width, height);
  if (width === 0 || height === 0) return out;
  const viaColumns = crossingsAlongColumns(data, width, height, threshold);
  envelopeRows(viaColumns, width, height);
  const viaRows = crossingsAlongRows(data, width, height, threshold);
  envelopeColumns(viaRows, width, height);
  for (let i = 0; i < viaRows.length; i++) if (viaColumns[i] < viaRows[i]) viaRows[i] = viaColumns[i];
  refineNearContour(data, width, height, threshold, viaRows);
  const d = out.data;
  for (let i = 0; i < d.length; i++) d[i] = data[i] >= threshold ? -Math.sqrt(viaRows[i]) : Math.sqrt(viaRows[i]);
  return out;
}

/**
 * Evaluate `value(signed distance)` for the pixels that can differ from the plain inside / outside
 * answer: only a window around the mask's inside pixels (grown by `reach`) is computed.
 * Outside the window every pixel is outside the mask by more than `reach`, where `value` is 0.
 */
function mapSignedDistance(mask: Mask, reach: number, value: (sd: number) => number): Mask {
  const out = createMask(mask.width, mask.height);
  const inside = maskBounds(mask, 0);
  if (!inside) return out;
  const m = Math.ceil(Math.max(0, reach)) + 2;
  const x0 = Math.max(0, inside.x - m);
  const y0 = Math.max(0, inside.y - m);
  const x1 = Math.min(mask.width, inside.x + inside.width + m);
  const y1 = Math.min(mask.height, inside.y + inside.height + m);
  const w = x1 - x0;
  const h = y1 - y0;
  const window = w === mask.width && h === mask.height ? mask : cropMask(mask, x0, y0, w, h);
  const sd = signedDistance(window).data;
  for (let y = 0; y < h; y++) {
    const src = y * w;
    const dst = (y + y0) * mask.width + x0;
    for (let x = 0; x < w; x++) out.data[dst + x] = value(sd[src + x]);
  }
  return out;
}

export type FeatherMode = 'inward' | 'outward' | 'centered';

export interface FeatherOptions {
  /** Shape of the ramp across the soft edge: "smooth" (smoothstep, default) or "linear". */
  profile?: 'smooth' | 'linear';
}

/**
 * Replace the mask's edge (its 0.5 level) by a soft edge that is `radius` px wide:
 * - "inward": the ramp lies inside the shape: 0 at the edge, 1 from `radius` px inside. Nothing
 *   outside the original shape becomes visible.
 * - "outward": 1 inside the shape, fading to 0 at `radius` px outside.
 * - "centered" (default): the ramp straddles the edge: 0.5 on it, 1 at radius / 2 inside, 0 at
 *   radius / 2 outside.
 * The ramp is never narrower than 1 px (an antialiased edge), so radius 0 gives the shape with a
 * plain antialiased edge. The result is monotonic in the distance to the edge.
 */
export function featherMask(mask: Mask, radius: number, mode: FeatherMode = 'centered', opts: FeatherOptions = {}): Mask {
  if (!Number.isFinite(radius)) throw new RangeError(`featherMask: radius must be a finite number, got ${radius}`);
  const r = Math.max(0, radius);
  // Signed distances where the result is 1 (lo) and 0 (hi).
  let lo = mode === 'inward' ? -r : mode === 'outward' ? 0 : -r / 2;
  let hi = lo + r;
  if (hi - lo < 1) {
    const mid = (lo + hi) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }
  const span = hi - lo;
  const smooth = (opts.profile ?? 'smooth') === 'smooth';
  return mapSignedDistance(mask, hi, (sd) => {
    if (sd >= hi) return 0;
    if (sd <= lo) return 1;
    const t = (hi - sd) / span;
    return smooth ? t * t * (3 - 2 * t) : t;
  });
}

/** Coverage of the shape whose edge is moved outward by `offset` px (inward when negative), antialiased. */
function offsetMask(mask: Mask, offset: number): Mask {
  if (!Number.isFinite(offset)) throw new RangeError(`dilateMask / erodeMask: radius must be a finite number, got ${offset}`);
  return mapSignedDistance(mask, offset + 0.5, (sd) => {
    const c = offset + 0.5 - sd;
    return c <= 0 ? 0 : c >= 1 ? 1 : c;
  });
}

/**
 * Grow the shape: its edge (the 0.5 level) moves outward by `radius` px, with round corners and an
 * antialiased edge. A negative radius erodes.
 */
export function dilateMask(mask: Mask, radius: number): Mask {
  return offsetMask(mask, radius);
}

/**
 * Shrink the shape: its edge (the 0.5 level) moves inward by `radius` px; parts thinner than
 * 2 x radius disappear. A negative radius dilates.
 */
export function erodeMask(mask: Mask, radius: number): Mask {
  return offsetMask(mask, -radius);
}
