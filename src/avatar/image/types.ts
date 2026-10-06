/**
 * Shared types of the avatar image toolkit and small rectangle helpers. Pure (browser-safe).
 */
import type { ImageRGBA } from '../../core/types.js';

export type { ImageRGBA };

/**
 * A single-channel float image, row-major, top-down: `data[y * width + x]`.
 * As a mask the values are coverage in 0..1 (0 = outside, 1 = inside, in between = soft edge).
 * Pixel (x, y) covers [x, x+1) x [y, y+1); its centre is at (x + 0.5, y + 0.5).
 */
export interface Mask {
  width: number;
  height: number;
  data: Float32Array;
}

/** Same layout as a Mask, but the values are distances in pixels (not limited to 0..1). */
export type DistanceField = Mask;

/** An axis-aligned rectangle (structurally the PixelRect of src/render). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A flat point list [x0, y0, x1, y1, ...] in pixels (+x right, +y down). */
export type Points = ArrayLike<number>;

/** sRGB colour, each channel 0..255 (may be fractional). */
export type RGB = [number, number, number];

/** CIE L*a*b* (D65): L 0..100, a and b roughly -128..127. */
export type Lab = [number, number, number];

/** `rect` grown by `margin` on every side (a negative margin shrinks it; the size never goes below 0). */
export function expandRect(rect: Rect, margin: number): Rect {
  const width = Math.max(0, rect.width + 2 * margin);
  const height = Math.max(0, rect.height + 2 * margin);
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
}

/** The smallest rectangle containing both. */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** The overlap of both, or null when they do not overlap (touching edges do not count). */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/**
 * The whole-pixel rectangle that covers `rect` grown by `margin`, clipped to a width x height
 * image: what to crop so a shape with these bounds (plus a feather of `margin` px) fits.
 * The result may be empty (width or height 0) when the rect lies outside the image.
 */
export function pixelRect(rect: Rect, margin: number, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.min(width, Math.floor(rect.x - margin)));
  const y0 = Math.max(0, Math.min(height, Math.floor(rect.y - margin)));
  const x1 = Math.max(x0, Math.min(width, Math.ceil(rect.x + rect.width + margin)));
  const y1 = Math.max(y0, Math.min(height, Math.ceil(rect.y + rect.height + margin)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Throws unless width and height are non-negative integers. */
export function assertSize(width: number, height: number, fn: string): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`${fn}: size must be non-negative integers, got ${width}x${height}`);
  }
}
