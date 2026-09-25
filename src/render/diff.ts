/**
 * Pixel comparison of two same-size images with a visualization (pure TypeScript, browser-safe).
 */
import type { ImageRGBA } from '../core/types.js';
import { assertImage } from './image.js';

export interface DiffOptions {
  /** A pixel counts as different when its delta exceeds this (0..255, default 0 = any change). */
  threshold?: number;
}

export interface DiffResult {
  width: number;
  height: number;
  /** Pixels whose delta exceeds the threshold. */
  differentPixels: number;
  /** Largest per-pixel delta (0..255). */
  maxDelta: number;
  /** Mean per-pixel delta over all pixels (0..255). */
  meanDelta: number;
  /** Opaque visualization: `a` as dimmed grayscale, different pixels in red. */
  image: ImageRGBA;
}

/** Per-pixel delta = max over R, G, B, A of |a - b|. Throws if the sizes differ. */
export function diffImages(a: ImageRGBA, b: ImageRGBA, opts: DiffOptions = {}): DiffResult {
  assertImage(a, 'diffImages: image a');
  assertImage(b, 'diffImages: image b');
  if (a.width !== b.width || a.height !== b.height) {
    throw new RangeError(`diffImages: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const threshold = opts.threshold ?? 0;
  if (Number.isNaN(threshold)) throw new RangeError('diffImages: threshold must be a number (0..255)');
  const { width, height } = a;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const da = a.data;
  const db = b.data;
  let differentPixels = 0;
  let maxDelta = 0;
  let sum = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const delta = Math.max(
      Math.abs(da[i] - db[i]),
      Math.abs(da[i + 1] - db[i + 1]),
      Math.abs(da[i + 2] - db[i + 2]),
      Math.abs(da[i + 3] - db[i + 3]),
    );
    sum += delta;
    if (delta > maxDelta) maxDelta = delta;
    if (delta > threshold) {
      differentPixels++;
      out[i] = 255;
      out[i + 1] = 0;
      out[i + 2] = 0;
    } else {
      // Luma of `a` composited over white, dimmed to 30% so red differences stand out.
      const alpha = da[i + 3] / 255;
      const luma = 0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2];
      const gray = Math.round((luma * alpha + 255 * (1 - alpha)) * 0.3);
      out[i] = out[i + 1] = out[i + 2] = gray;
    }
    out[i + 3] = 255;
  }
  return {
    width,
    height,
    differentPixels,
    maxDelta,
    meanDelta: n > 0 ? sum / n : 0,
    image: { width, height, data: out },
  };
}
