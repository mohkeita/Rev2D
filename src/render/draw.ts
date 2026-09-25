/**
 * Alpha-blended 2D primitives on ImageRGBA (pure TypeScript, browser-safe).
 *
 * Shapes are first rasterized into a Coverage buffer (per-pixel coverage 0..1, combined with `max`)
 * and then composited once. Overlapping pieces of one stroke (polyline joints, dashes, wireframe
 * edges sharing a vertex) therefore never double-blend when the color is translucent.
 * Coordinates are in pixels; pixel (x, y) covers [x, x+1) x [y, y+1) with its center at +0.5.
 */
import type { ImageRGBA } from '../core/types.js';
import { blendOver, resolveColor, toRGBA8, type ColorInput } from './image.js';

export interface LineOptions {
  /** Stroke width in pixels (default 1). Widths below 1 draw a 1px line with proportionally lower alpha. */
  width?: number;
  /** Anti-aliased edges (default true). false = crisp pixels with endpoints snapped to pixel centers. */
  antialias?: boolean;
}

export interface PolylineOptions extends LineOptions {
  /** Connect the last point back to the first. */
  closed?: boolean;
}

export interface DashOptions extends LineOptions {
  /** Dash length in pixels (default 6). */
  dash?: number;
  /** Gap length in pixels (default 4). */
  gap?: number;
}

export interface CircleOptions {
  /** Filled disc (default) or outline ring. */
  fill?: boolean;
  /** Outline width when fill is false (default 1). */
  width?: number;
  antialias?: boolean;
}

/**
 * Per-pixel coverage over a clipped region of an image. Primitives combine with `max`, then
 * `composite` blends one color through the accumulated coverage. The touched column range of every
 * row is tracked, so compositing and clearing cost is proportional to what was drawn, not to the region.
 */
export class Coverage {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** Coverage 0..1 per region pixel, row-major. Read-only view: draw through the methods (they track touched rows). */
  readonly data: Float32Array;
  /** Per region row: first and last touched column (absolute px); rowMin > rowMax = untouched. */
  private readonly rowMin: Int32Array;
  private readonly rowMax: Int32Array;

  /** Region defaults to the whole image; `bounds` = [minX, minY, maxX, maxY] in pixels (expanded to whole pixels, clipped). */
  constructor(img: Pick<ImageRGBA, 'width' | 'height'>, bounds?: [number, number, number, number]) {
    this.x0 = bounds ? clampInt(Math.floor(bounds[0]), 0, img.width) : 0;
    this.y0 = bounds ? clampInt(Math.floor(bounds[1]), 0, img.height) : 0;
    this.x1 = bounds ? clampInt(Math.ceil(bounds[2]), this.x0, img.width) : img.width;
    this.y1 = bounds ? clampInt(Math.ceil(bounds[3]), this.y0, img.height) : img.height;
    this.data = new Float32Array((this.x1 - this.x0) * (this.y1 - this.y0));
    this.rowMin = new Int32Array(this.y1 - this.y0).fill(this.x1);
    this.rowMax = new Int32Array(this.y1 - this.y0).fill(this.x0 - 1);
  }

  private put(px: number, py: number, c: number): void {
    const row = py - this.y0;
    const i = row * (this.x1 - this.x0) + (px - this.x0);
    if (!(c > this.data[i])) return;
    this.data[i] = c > 1 ? 1 : c;
    if (px < this.rowMin[row]) this.rowMin[row] = px;
    if (px > this.rowMax[row]) this.rowMax[row] = px;
  }

  /** Reset all coverage to zero (only touched pixels are visited), e.g. to reuse the buffer for another color. */
  clear(): this {
    const w = this.x1 - this.x0;
    for (let row = 0; row < this.rowMin.length; row++) {
      if (this.rowMin[row] > this.rowMax[row]) continue;
      const base = row * w - this.x0;
      this.data.fill(0, base + this.rowMin[row], base + this.rowMax[row] + 1);
      this.rowMin[row] = this.x1;
      this.rowMax[row] = this.x0 - 1;
    }
    return this;
  }

  /** Crisp rectangle with edges rounded to whole pixels, at the given coverage. */
  rect(x: number, y: number, w: number, h: number, value = 1): this {
    const xa = Math.max(this.x0, Math.round(x));
    const xb = Math.min(this.x1, Math.round(x + w));
    const ya = Math.max(this.y0, Math.round(y));
    const yb = Math.min(this.y1, Math.round(y + h));
    for (let py = ya; py < yb; py++) for (let px = xa; px < xb; px++) this.put(px, py, value);
    return this;
  }

  /** Line segment with round caps. */
  segment(ax: number, ay: number, bx: number, by: number, width = 1, antialias = true): this {
    if (![ax, ay, bx, by, width].every(Number.isFinite) || width <= 0) return this;
    if (!antialias) {
      ax = Math.floor(ax) + 0.5;
      ay = Math.floor(ay) + 0.5;
      bx = Math.floor(bx) + 0.5;
      by = Math.floor(by) + 0.5;
    }
    const hw = Math.max(width, 1) / 2;
    const alpha = Math.min(width, 1);
    // Coverage is zero beyond hw + 0.5 from the segment; the extra 0.5 px absorbs rounding below.
    const reach = hw + 1;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const pya = Math.max(this.y0, Math.floor(Math.min(ay, by) - reach));
    const pyb = Math.min(this.y1 - 1, Math.ceil(Math.max(ay, by) + reach));
    for (let py = pya; py <= pyb; py++) {
      const cy = py + 0.5;
      // A pixel within `reach` of the segment has its nearest segment point within `reach` of this row,
      // so only the columns around that part of the segment can be covered (keeps long lines cheap).
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
      const pxa = Math.max(this.x0, Math.floor(lo - reach));
      const pxb = Math.min(this.x1 - 1, Math.ceil(hi + reach));
      for (let px = pxa; px <= pxb; px++) {
        const cx = px + 0.5;
        let t = len2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = distance(ax + t * dx - cx, ay + t * dy - cy);
        const c = antialias ? (hw + 0.5 - d) * alpha : d <= hw ? 1 : 0;
        if (c > 0) this.put(px, py, c);
      }
    }
    return this;
  }

  /**
   * Dashed segment: dashes of `dash` px separated by `gap` px, starting with a dash at (ax, ay).
   * A pattern finer than one pixel is indistinguishable from a solid line and is drawn as one.
   */
  dashed(ax: number, ay: number, bx: number, by: number, width = 1, dash = 6, gap = 4, antialias = true): this {
    const len = distance(bx - ax, by - ay);
    const period = dash + Math.max(0, gap);
    if (!(len > 0) || !(dash > 0) || !(period >= 1) || !Number.isFinite(len)) {
      return this.segment(ax, ay, bx, by, width, antialias);
    }
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    // Only dashes that can reach the region matter: clip the line's arc-length range to the region
    // grown by the stroke reach (so a far-away endpoint costs nothing).
    const reach = Math.max(width, 1) / 2 + 1;
    const range = clipRange(ax, ay, ux, uy, len, this.x0 - reach, this.y0 - reach, this.x1 + reach, this.y1 + reach);
    if (!range) return this;
    const [s0, s1] = range;
    for (let k = Math.floor(s0 / period); ; k++) {
      const s = k * period;
      if (s >= len || s > s1) break;
      const e = Math.min(len, s + dash);
      this.segment(ax + ux * s, ay + uy * s, ax + ux * e, ay + uy * e, width, antialias);
    }
    return this;
  }

  /** Polyline through flat points [x0, y0, x1, y1, ...]. */
  polyline(points: ArrayLike<number>, width = 1, antialias = true, closed = false): this {
    const n = Math.floor(points.length / 2);
    if (n === 1) return this.segment(points[0], points[1], points[0], points[1], width, antialias);
    for (let i = 0; i + 1 < n; i++) {
      this.segment(points[i * 2], points[i * 2 + 1], points[i * 2 + 2], points[i * 2 + 3], width, antialias);
    }
    if (closed && n > 2) this.segment(points[n * 2 - 2], points[n * 2 - 1], points[0], points[1], width, antialias);
    return this;
  }

  /** Filled disc of radius r. */
  disc(cx: number, cy: number, r: number, antialias = true): this {
    return this.radial(cx, cy, r + 1, (d) => (antialias ? r + 0.5 - d : d <= r ? 1 : 0));
  }

  /** Circle outline of radius r (centered on the circle) and the given width. */
  ring(cx: number, cy: number, r: number, width = 1, antialias = true): this {
    const hw = Math.max(width, 1) / 2;
    const alpha = Math.min(width, 1);
    return this.radial(cx, cy, r + hw + 1, (d) => {
      const e = Math.abs(d - r);
      return antialias ? (hw + 0.5 - e) * alpha : e <= hw ? 1 : 0;
    });
  }

  private radial(cx: number, cy: number, reach: number, cov: (d: number) => number): this {
    if (![cx, cy, reach].every(Number.isFinite)) return this;
    const pxa = Math.max(this.x0, Math.floor(cx - reach));
    const pxb = Math.min(this.x1 - 1, Math.ceil(cx + reach));
    const pya = Math.max(this.y0, Math.floor(cy - reach));
    const pyb = Math.min(this.y1 - 1, Math.ceil(cy + reach));
    for (let py = pya; py <= pyb; py++) {
      for (let px = pxa; px <= pxb; px++) {
        const c = cov(distance(px + 0.5 - cx, py + 0.5 - cy));
        if (c > 0) this.put(px, py, c);
      }
    }
    return this;
  }

  /** Blend `color` onto `img` through the accumulated coverage. */
  composite(img: ImageRGBA, color: ColorInput): void {
    const [r, g, b, a8] = toRGBA8(resolveColor(color));
    const a = a8 / 255;
    const w = this.x1 - this.x0;
    for (let py = this.y0; py < this.y1; py++) {
      const row = py - this.y0;
      const base = row * w - this.x0;
      for (let px = this.rowMin[row]; px <= this.rowMax[row]; px++) {
        const c = this.data[base + px];
        if (c > 0) blendOver(img.data, (py * img.width + px) * 4, r, g, b, a * c);
      }
    }
  }
}

/**
 * Euclidean length of (x, y). Math.sqrt is correctly rounded everywhere, whereas Math.hypot is only
 * approximated (engine-dependent), so this keeps overlay pixels identical across JS engines.
 */
export function distance(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Clamp to [lo, hi]; NaN maps to lo. */
function clampInt(v: number, lo: number, hi: number): number {
  return v >= lo ? (v > hi ? hi : v) : lo;
}

/**
 * Arc-length range [s0, s1] within [0, len] where the ray (x, y) + s * (ux, uy) lies inside the box
 * [minX, maxX] x [minY, maxY] (Liang-Barsky), or null when it misses the box.
 */
function clipRange(
  x: number,
  y: number,
  ux: number,
  uy: number,
  len: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): [number, number] | null {
  let s0 = 0;
  let s1 = len;
  for (const [p, u, lo, hi] of [
    [x, ux, minX, maxX],
    [y, uy, minY, maxY],
  ]) {
    if (u === 0) {
      if (p < lo || p > hi) return null;
      continue;
    }
    const a = (lo - p) / u;
    const b = (hi - p) / u;
    s0 = Math.max(s0, Math.min(a, b));
    s1 = Math.min(s1, Math.max(a, b));
  }
  return s0 <= s1 ? [s0, s1] : null;
}

/** Fill the rectangle [x, x+w) x [y, y+h) (edges rounded to whole pixels). */
export function fillRect(img: ImageRGBA, x: number, y: number, w: number, h: number, color: ColorInput): void {
  const [r, g, b, a8] = toRGBA8(resolveColor(color));
  const a = a8 / 255;
  const xa = Math.max(0, Math.round(x));
  const xb = Math.min(img.width, Math.round(x + w));
  const ya = Math.max(0, Math.round(y));
  const yb = Math.min(img.height, Math.round(y + h));
  for (let py = ya; py < yb; py++) {
    for (let px = xa; px < xb; px++) blendOver(img.data, (py * img.width + px) * 4, r, g, b, a);
  }
}

/** Outline of the rectangle [x, x+w) x [y, y+h), `width` px thick, drawn inside its edges. */
export function strokeRect(
  img: ImageRGBA,
  x: number,
  y: number,
  w: number,
  h: number,
  color: ColorInput,
  width = 1,
): void {
  const t = Math.max(1, Math.round(width));
  new Coverage(img, [x, y, x + w, y + h])
    .rect(x, y, w, t)
    .rect(x, y + h - t, w, t)
    .rect(x, y, t, h)
    .rect(x + w - t, y, t, h)
    .composite(img, color);
}

/** Pixel bounds of the finite points grown by the stroke reach (non-finite points draw nothing). */
function lineBounds(points: ArrayLike<number>, width: number): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const m = Math.max(width, 1) / 2 + 2;
  return [minX - m, minY - m, maxX + m, maxY + m];
}

export function drawLine(
  img: ImageRGBA,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: ColorInput,
  opts: LineOptions = {},
): void {
  const width = opts.width ?? 1;
  new Coverage(img, lineBounds([x0, y0, x1, y1], width))
    .segment(x0, y0, x1, y1, width, opts.antialias ?? true)
    .composite(img, color);
}

export function drawDashedLine(
  img: ImageRGBA,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: ColorInput,
  opts: DashOptions = {},
): void {
  const width = opts.width ?? 1;
  new Coverage(img, lineBounds([x0, y0, x1, y1], width))
    .dashed(x0, y0, x1, y1, width, opts.dash ?? 6, opts.gap ?? 4, opts.antialias ?? true)
    .composite(img, color);
}

/** Polyline through flat points [x0, y0, x1, y1, ...]; joints are round and never double-blended. */
export function drawPolyline(
  img: ImageRGBA,
  points: ArrayLike<number>,
  color: ColorInput,
  opts: PolylineOptions = {},
): void {
  if (points.length < 2) return;
  const width = opts.width ?? 1;
  new Coverage(img, lineBounds(points, width))
    .polyline(points, width, opts.antialias ?? true, opts.closed ?? false)
    .composite(img, color);
}

export function drawCircle(
  img: ImageRGBA,
  cx: number,
  cy: number,
  r: number,
  color: ColorInput,
  opts: CircleOptions = {},
): void {
  const width = opts.width ?? 1;
  const m = r + Math.max(width, 1) + 2;
  const cov = new Coverage(img, [cx - m, cy - m, cx + m, cy + m]);
  if (opts.fill ?? true) cov.disc(cx, cy, r, opts.antialias ?? true);
  else cov.ring(cx, cy, r, width, opts.antialias ?? true);
  cov.composite(img, color);
}
