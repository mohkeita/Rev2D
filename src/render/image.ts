/**
 * ImageRGBA helpers: allocation, pixel access, alpha compositing, cropping and resizing.
 * Pure TypeScript (browser-safe). Images are straight-alpha RGBA8, row-major, top-down.
 */
import type { ImageRGBA, RGBA } from '../core/types.js';
import { clamp01, color as parseColorStrict } from '../core/color.js';

/** Straight RGBA 0..1, or any color string of the model format ("#rrggbb", "rgba(...)", "white", ...). */
export type ColorInput = RGBA | string;

/** An axis-aligned pixel rectangle. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normalize a ColorInput to straight RGBA 0..1. Throws on an invalid color string. */
export function resolveColor(c: ColorInput): RGBA {
  return typeof c === 'string' ? parseColorStrict(c) : c;
}

/** Straight RGBA 0..1 -> RGBA8 with round-half-up. */
export function toRGBA8(c: RGBA): [number, number, number, number] {
  return [to8(c[0]), to8(c[1]), to8(c[2]), to8(c[3])];
}

function to8(v: number): number {
  return Math.round(clamp01(v) * 255);
}

function assertSize(width: number, height: number, fn: string): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`${fn}: size must be non-negative integers, got ${width}x${height}`);
  }
}

/** Throws unless `img` is a well-formed ImageRGBA (integer size, data length = w*h*4). */
export function assertImage(img: ImageRGBA, fn: string): void {
  assertSize(img.width, img.height, fn);
  if (img.data.length !== img.width * img.height * 4) {
    throw new RangeError(
      `${fn}: image data length ${img.data.length} does not match ${img.width}x${img.height}x4 = ${img.width * img.height * 4}`,
    );
  }
}

/** New image, transparent unless `fill` is given. */
export function createImage(width: number, height: number, fill?: ColorInput): ImageRGBA {
  assertSize(width, height, 'createImage');
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill !== undefined) {
    const [r, g, b, a] = toRGBA8(resolveColor(fill));
    if (r | g | b | a) {
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      }
    }
  }
  return { width, height, data };
}

export function cloneImage(img: ImageRGBA): ImageRGBA {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** RGBA8 of pixel (x, y). Throws when out of bounds. */
export function getPixel(img: ImageRGBA, x: number, y: number): [number, number, number, number] {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= img.width || y >= img.height) {
    throw new RangeError(`getPixel: (${x}, ${y}) is outside the ${img.width}x${img.height} image`);
  }
  const i = (y * img.width + x) * 4;
  const d = img.data;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

/**
 * Source-over composite of a straight color (r, g, b in 0..255, alpha `a` in 0..1) onto the pixel at
 * byte offset `i`. All drawing primitives funnel through this, so results are identical everywhere.
 */
export function blendOver(data: Uint8ClampedArray, i: number, r: number, g: number, b: number, a: number): void {
  if (!(a > 0)) return;
  if (a >= 1) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
    return;
  }
  const keep = (data[i + 3] / 255) * (1 - a);
  const oa = a + keep;
  data[i] = Math.round((r * a + data[i] * keep) / oa);
  data[i + 1] = Math.round((g * a + data[i + 1] * keep) / oa);
  data[i + 2] = Math.round((b * a + data[i + 2] * keep) / oa);
  data[i + 3] = Math.round(oa * 255);
}

/** Composite `src` over `dst` in place with src's top-left at (x, y) (rounded). Out-of-bounds parts are clipped. */
export function blitImage(dst: ImageRGBA, src: ImageRGBA, x = 0, y = 0, opacity = 1): void {
  const ox = Math.round(x);
  const oy = Math.round(y);
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(dst.width, ox + src.width);
  const y1 = Math.min(dst.height, oy + src.height);
  const k = clamp01(opacity) / 255;
  const s = src.data;
  const d = dst.data;
  for (let py = y0; py < y1; py++) {
    let si = ((py - oy) * src.width + (x0 - ox)) * 4;
    let di = (py * dst.width + x0) * 4;
    for (let px = x0; px < x1; px++, si += 4, di += 4) blendOver(d, di, s[si], s[si + 1], s[si + 2], s[si + 3] * k);
  }
}

/** Copy of the rectangle (x, y, width, height); areas outside `img` are transparent. */
export function cropImage(img: ImageRGBA, x: number, y: number, width: number, height: number): ImageRGBA {
  const out = createImage(width, height);
  const ox = Math.round(x);
  const oy = Math.round(y);
  const x0 = Math.max(0, ox);
  const x1 = Math.min(img.width, ox + width);
  if (x1 <= x0) return out;
  for (let py = Math.max(0, oy); py < Math.min(img.height, oy + height); py++) {
    const from = (py * img.width + x0) * 4;
    out.data.set(img.data.subarray(from, from + (x1 - x0) * 4), ((py - oy) * width + (x0 - ox)) * 4);
  }
  return out;
}

/** Nearest-neighbour resample to width x height (pixel centers map to pixel centers). */
export function resizeNearest(img: ImageRGBA, width: number, height: number): ImageRGBA {
  const out = createImage(width, height);
  if (img.width === 0 || img.height === 0) return out;
  const xs = new Int32Array(width);
  for (let x = 0; x < width; x++) xs[x] = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / width));
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / height));
    const srow = sy * img.width;
    let di = y * width * 4;
    for (let x = 0; x < width; x++, di += 4) {
      const si = (srow + xs[x]) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}
