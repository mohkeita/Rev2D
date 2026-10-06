/**
 * Masks: single-channel Float32 coverage images (0..1). Creation, conversion from / to image alpha,
 * boolean operations, threshold, bounds, area, crop / paste and bilinear sampling.
 * Every function returns a new mask unless it says "in place".
 */
import type { ImageRGBA, Mask, Rect, RGB } from './types.js';
import { assertSize } from './types.js';

/** New mask filled with `fill` (default 0). */
export function createMask(width: number, height: number, fill = 0): Mask {
  assertSize(width, height, 'createMask');
  const data = new Float32Array(width * height);
  if (fill !== 0) data.fill(fill);
  return { width, height, data };
}

export function cloneMask(mask: Mask): Mask {
  return { width: mask.width, height: mask.height, data: new Float32Array(mask.data) };
}

/** Throws unless `mask` is well formed (integer size, data length = width * height). */
export function assertMask(mask: Mask, fn: string): void {
  assertSize(mask.width, mask.height, fn);
  if (mask.data.length !== mask.width * mask.height) {
    throw new RangeError(`${fn}: mask data length ${mask.data.length} does not match ${mask.width}x${mask.height}`);
  }
}

/** Throws unless both have the same size. Works for masks and images. */
export function assertSameSize(
  a: { width: number; height: number },
  b: { width: number; height: number },
  fn: string,
): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new RangeError(`${fn}: sizes differ (${a.width}x${a.height} vs ${b.width}x${b.height})`);
  }
}

/** The image's alpha channel as a mask (alpha / 255). */
export function maskFromAlpha(img: ImageRGBA): Mask {
  const out = createMask(img.width, img.height);
  const s = img.data;
  const d = out.data;
  for (let i = 0, j = 3; i < d.length; i++, j += 4) d[i] = s[j] / 255;
  return out;
}

/** An image of one colour (default white) whose alpha is the mask: the usual way to save a mask as a PNG. */
export function maskToImage(mask: Mask, color: RGB = [255, 255, 255]): ImageRGBA {
  const data = new Uint8ClampedArray(mask.width * mask.height * 4);
  const r = Math.round(color[0]);
  const g = Math.round(color[1]);
  const b = Math.round(color[2]);
  const m = mask.data;
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    data[j] = r;
    data[j + 1] = g;
    data[j + 2] = b;
    data[j + 3] = alpha8(m[i]);
  }
  return { width: mask.width, height: mask.height, data };
}

/** An opaque grey-scale picture of the mask (0 = black, 1 = white), for debug images. */
export function maskToGray(mask: Mask): ImageRGBA {
  const data = new Uint8ClampedArray(mask.width * mask.height * 4);
  const m = mask.data;
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    const v = alpha8(m[i]);
    data[j] = v;
    data[j + 1] = v;
    data[j + 2] = v;
    data[j + 3] = 255;
  }
  return { width: mask.width, height: mask.height, data };
}

/** Mask value 0..1 -> 0..255, rounded half up; NaN maps to 0. */
export function alpha8(v: number): number {
  return v > 0 ? (v >= 1 ? 255 : Math.floor(v * 255 + 0.5)) : 0;
}

function combine(masks: Mask[], fn: string, op: (a: number, b: number) => number): Mask {
  if (masks.length === 0) throw new RangeError(`${fn}: needs at least one mask`);
  const out = cloneMask(masks[0]);
  const d = out.data;
  for (let k = 1; k < masks.length; k++) {
    assertSameSize(masks[0], masks[k], fn);
    const s = masks[k].data;
    for (let i = 0; i < d.length; i++) d[i] = op(d[i], s[i]);
  }
  return out;
}

/** Per-pixel maximum: inside any of the masks. */
export function maskUnion(...masks: Mask[]): Mask {
  return combine(masks, 'maskUnion', (a, b) => (a > b ? a : b));
}

/** Per-pixel minimum: inside all of the masks. */
export function maskIntersect(...masks: Mask[]): Mask {
  return combine(masks, 'maskIntersect', (a, b) => (a < b ? a : b));
}

/** Per-pixel product: one mask weighted by the others (e.g. a region times a soft falloff). */
export function maskMultiply(...masks: Mask[]): Mask {
  return combine(masks, 'maskMultiply', (a, b) => a * b);
}

/**
 * `a` without `b`: max(0, a - b). Exact where b lies inside a or shares its edge (a region minus a
 * shape cut from it leaves no rim). For unrelated shapes that merely cross, the alternative
 * `maskMultiply(a, maskInvert(b))` keeps a softer rim.
 */
export function maskSubtract(a: Mask, b: Mask): Mask {
  return combine([a, b], 'maskSubtract', (x, y) => (x > y ? x - y : 0));
}

/** 1 - mask. */
export function maskInvert(mask: Mask): Mask {
  const out = createMask(mask.width, mask.height);
  const s = mask.data;
  const d = out.data;
  for (let i = 0; i < d.length; i++) d[i] = 1 - s[i];
  return out;
}

/** Binary mask: 1 where the value is >= `threshold` (default 0.5), else 0. */
export function maskThreshold(mask: Mask, threshold = 0.5): Mask {
  const out = createMask(mask.width, mask.height);
  const s = mask.data;
  const d = out.data;
  for (let i = 0; i < d.length; i++) d[i] = s[i] >= threshold ? 1 : 0;
  return out;
}

/** Whole-pixel bounding box of the pixels with a value > `threshold` (default 0: any coverage), or null when there are none. */
export function maskBounds(mask: Mask, threshold = 0): Rect | null {
  const { width, height, data } = mask;
  let minX = width;
  let maxX = -1;
  let minY = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let first = -1;
    for (let x = 0; x < width; x++) {
      if (data[row + x] > threshold) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = width - 1; x > first; x--) {
      if (data[row + x] > threshold) {
        last = x;
        break;
      }
    }
    if (minY < 0) minY = y;
    maxY = y;
    if (first < minX) minX = first;
    if (last > maxX) maxX = last;
  }
  return minY < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Sum of the values: the covered area in pixels (antialiased edges count partially). */
export function maskArea(mask: Mask): number {
  const d = mask.data;
  let sum = 0;
  for (let i = 0; i < d.length; i++) sum += d[i];
  return sum;
}

/** Number of pixels with a value >= `threshold` (default 0.5). */
export function maskCount(mask: Mask, threshold = 0.5): number {
  const d = mask.data;
  let n = 0;
  for (let i = 0; i < d.length; i++) if (d[i] >= threshold) n++;
  return n;
}

/** Copy of the rectangle (x, y, width, height), rounded to whole pixels; areas outside the mask are 0. */
export function cropMask(mask: Mask, x: number, y: number, width: number, height: number): Mask {
  const out = createMask(width, height);
  const ox = Math.round(x);
  const oy = Math.round(y);
  const x0 = Math.max(0, ox);
  const x1 = Math.min(mask.width, ox + width);
  if (x1 <= x0) return out;
  for (let py = Math.max(0, oy); py < Math.min(mask.height, oy + height); py++) {
    const from = py * mask.width + x0;
    out.data.set(mask.data.subarray(from, from + (x1 - x0)), (py - oy) * width + (x0 - ox));
  }
  return out;
}

/**
 * Write `src` into `dst` IN PLACE with src's top-left at (x, y) (rounded); parts outside `dst` are
 * clipped. `mode`: "replace" (default) copies the values, "max" keeps the larger one (a union).
 */
export function pasteMask(dst: Mask, src: Mask, x = 0, y = 0, mode: 'replace' | 'max' = 'replace'): void {
  const ox = Math.round(x);
  const oy = Math.round(y);
  const x0 = Math.max(0, ox);
  const x1 = Math.min(dst.width, ox + src.width);
  if (x1 <= x0) return;
  for (let py = Math.max(0, oy); py < Math.min(dst.height, oy + src.height); py++) {
    const from = (py - oy) * src.width + (x0 - ox);
    const to = py * dst.width + x0;
    if (mode === 'replace') {
      dst.data.set(src.data.subarray(from, from + (x1 - x0)), to);
    } else {
      for (let k = 0; k < x1 - x0; k++) if (src.data[from + k] > dst.data[to + k]) dst.data[to + k] = src.data[from + k];
    }
  }
}

/**
 * Bilinear sample at the continuous position (x, y) in pixels (pixel centres at +0.5); positions
 * outside the mask read the nearest edge value. Use it to evaluate a mask or a distance field at
 * lattice points.
 */
export function sampleMask(mask: Mask, x: number, y: number): number {
  const { width, height, data } = mask;
  if (width === 0 || height === 0) return 0;
  const fx = Math.min(Math.max(x - 0.5, 0), width - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const top = data[y0 * width + x0] * (1 - tx) + data[y0 * width + x1] * tx;
  const bottom = data[y1 * width + x0] * (1 - tx) + data[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}
