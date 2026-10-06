/**
 * Putting images and masks together: apply a mask as alpha, crop, paste, composite, bounds of the
 * visible pixels, a tinted overlay of a mask (debug pictures), and resampling (bilinear upscale,
 * area-average downscale). Resampling is alpha-aware: colours are weighted by their alpha.
 */
import { assertImage, blitImage, createImage, cropImage } from '../../render/image.js';
import { alpha8, assertSameSize, createMask } from './mask.js';
import type { ImageRGBA, Mask, Rect, RGB } from './types.js';
import { assertSize } from './types.js';

/**
 * The image with the mask applied to its alpha. "multiply" (default) keeps the image's own
 * transparency (alpha x mask): cutting a layer out of the source. "replace" sets alpha = mask.
 * Colours are untouched, also where the result is transparent.
 */
export function applyMask(img: ImageRGBA, mask: Mask, mode: 'multiply' | 'replace' = 'multiply'): ImageRGBA {
  assertImage(img, 'applyMask');
  assertSameSize(img, mask, 'applyMask');
  const out: ImageRGBA = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const m = mask.data;
  const d = out.data;
  if (mode === 'replace') for (let i = 0, j = 3; i < m.length; i++, j += 4) d[j] = alpha8(m[i]);
  else for (let i = 0, j = 3; i < m.length; i++, j += 4) d[j] = alpha8((d[j] / 255) * m[i]);
  return out;
}

export interface CutLayer {
  /** The image under the mask: alpha x mask, colours untouched (same size as the image; crop it with cropRect). */
  layer: ImageRGBA;
  /**
   * What is left when the layer is lifted off: compositing `layer` over `rest` gives the image back
   * (colours exactly; alpha within 1/255, or within 255 - alpha where the image is only almost
   * opaque). Under `covered` pixels `rest` is transparent.
   */
  rest: ImageRGBA;
  /**
   * 1 where the layer takes an opaque image pixel completely (mask value 1): the pixels of `rest`
   * whose content is unknown because the layer hid it (the hole to inpaint), else 0.
   */
  covered: Mask;
}

export interface CutLayerOptions {
  /**
   * Image pixels with an alpha of at least this (0..255) count as opaque (default 250). Illustrations
   * with a removed background are often only almost opaque (alpha 250-254) where they look solid:
   * with 255 nothing would count as covered and nothing behind the layer could be filled. For such a
   * pixel the rest pose is up to 255 - alpha steps more opaque than the image, and a fill shows
   * through its layer pixel by at most (255 - alpha) / 255 (2% at the default).
   */
  opaque?: number;
}

/**
 * Cut a layer out of an image so that the layer drawn over the rest reproduces the image: the
 * rest pose of a rig built from the pieces is the illustration itself.
 *
 * Per pixel (image alpha a, mask value m):
 * - m = 1 on an opaque pixel: the layer takes it; `rest` is transparent there and the pixel is
 *   marked `covered`. Fill these with `inpaint(rest, covered)`; the fill lies under opaque layer
 *   pixels only, so it cannot show in the rest pose.
 * - 0 < m < 1 on an opaque pixel (the soft edge of the mask): `rest` keeps the original pixel, and
 *   the layer's copy blends over the identical colour.
 * - a translucent pixel (the image's own soft outline): `rest` gets the alpha that completes the
 *   layer, a (1 - m) / (1 - a m), which is nothing for m = 1: an object in front of the transparent
 *   background leaves no rim behind.
 *
 * Use a mask that is 1 on the whole object and fades OUTWARD (featherMask(shape, r, 'outward')), so
 * the soft edge blends surrounding pixels and no part of the object stays in `rest`.
 */
export function cutLayer(img: ImageRGBA, mask: Mask, opts: CutLayerOptions = {}): CutLayer {
  assertImage(img, 'cutLayer');
  assertSameSize(img, mask, 'cutLayer');
  const opaque = Math.min(255, Math.max(1, opts.opaque ?? 250));
  const layer = applyMask(img, mask);
  const rest: ImageRGBA = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const covered = createMask(img.width, img.height);
  const s = img.data;
  const l = layer.data;
  const r = rest.data;
  for (let i = 0, j = 3; i < covered.data.length; i++, j += 4) {
    const cut = l[j];
    if (cut === 0) continue;
    const alpha = s[j];
    if (alpha >= opaque) {
      // An opaque pixel: taken completely (a hole remains) or left in place under the soft mask edge.
      if (cut >= alpha) {
        covered.data[i] = 1;
        r[j] = 0;
      }
    } else {
      r[j] = cut >= 255 ? 0 : Math.floor((255 * (alpha - cut)) / (255 - cut) + 0.5);
    }
  }
  return { layer, rest, covered };
}

/** Copy of a rectangle of the image (rounded to whole pixels); areas outside the image are transparent. */
export function cropRect(img: ImageRGBA, rect: Rect): ImageRGBA {
  return cropImage(img, rect.x, rect.y, Math.round(rect.width), Math.round(rect.height));
}

/**
 * Copy `src` into `dst` IN PLACE with src's top-left at (x, y) (rounded): the pixels are replaced,
 * alpha included (no blending). Parts outside `dst` are clipped.
 */
export function pasteImage(dst: ImageRGBA, src: ImageRGBA, x = 0, y = 0): void {
  const ox = Math.round(x);
  const oy = Math.round(y);
  const xa = Math.max(0, ox);
  const xb = Math.min(dst.width, ox + src.width);
  if (xb <= xa) return;
  for (let py = Math.max(0, oy); py < Math.min(dst.height, oy + src.height); py++) {
    const from = ((py - oy) * src.width + (xa - ox)) * 4;
    dst.data.set(src.data.subarray(from, from + (xb - xa) * 4), (py * dst.width + xa) * 4);
  }
}

/**
 * Composite `src` over `dst` IN PLACE (source-over, straight alpha) with src's top-left at (x, y)
 * (rounded) and an overall opacity. The same blend the renderer's drawing primitives use.
 */
export function compositeOver(dst: ImageRGBA, src: ImageRGBA, x = 0, y = 0, opacity = 1): void {
  blitImage(dst, src, x, y, opacity);
}

/** Whole-pixel bounding box of the pixels with alpha >= `minAlpha` (default 1), or null when there are none. */
export function alphaBounds(img: ImageRGBA, minAlpha = 1): Rect | null {
  const { width, height, data } = img;
  let minX = width;
  let maxX = -1;
  let minY = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4 + 3;
    let first = -1;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4] >= minAlpha) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = width - 1; x > first; x--) {
      if (data[row + x * 4] >= minAlpha) {
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

/**
 * A copy of the image with the mask painted over it in one colour (`opacity` x mask value): a quick
 * way to check a mask against the picture.
 */
export function tintMask(img: ImageRGBA, mask: Mask, color: RGB = [255, 0, 96], opacity = 0.5): ImageRGBA {
  assertImage(img, 'tintMask');
  assertSameSize(img, mask, 'tintMask');
  const out: ImageRGBA = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const d = out.data;
  const m = mask.data;
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    const a = Math.min(1, Math.max(0, m[i] * opacity));
    if (!(a > 0)) continue;
    const keep = (d[j + 3] / 255) * (1 - a);
    const total = a + keep;
    d[j] = Math.floor((color[0] * a + d[j] * keep) / total + 0.5);
    d[j + 1] = Math.floor((color[1] * a + d[j + 1] * keep) / total + 0.5);
    d[j + 2] = Math.floor((color[2] * a + d[j + 2] * keep) / total + 0.5);
    d[j + 3] = Math.floor(total * 255 + 0.5);
  }
  return out;
}

// ----------------------------------------------------------------------------- resampling

/** For every destination index: the two source indices it interpolates between and the weight of the second. */
function bilinearTaps(srcN: number, dstN: number): { i0: Int32Array; i1: Int32Array; t: Float32Array } {
  const i0 = new Int32Array(dstN);
  const i1 = new Int32Array(dstN);
  const t = new Float32Array(dstN);
  for (let d = 0; d < dstN; d++) {
    const s = Math.min(srcN - 1, Math.max(0, ((d + 0.5) * srcN) / dstN - 0.5));
    const a = Math.min(srcN - 1, Math.floor(s));
    i0[d] = a;
    i1[d] = Math.min(srcN - 1, a + 1);
    t[d] = s - a;
  }
  return { i0, i1, t };
}

function scaledSize(n: number, factor: number): number {
  return Math.max(1, Math.round(n * factor));
}

function assertFactor(factor: number, fn: string): void {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new RangeError(`${fn}: factor must be a positive number, got ${factor}`);
}

/**
 * Bilinear resample to width x height (pixel centres map to pixel centres, edges are clamped).
 * Meant for enlarging; for shrinking use resizeArea (bilinear skips pixels below half size).
 * Alpha-aware: where all four source pixels are transparent the plain colours are interpolated, so
 * extended edge colours survive.
 */
export function resizeBilinear(img: ImageRGBA, width: number, height: number): ImageRGBA {
  assertImage(img, 'resizeBilinear');
  assertSize(width, height, 'resizeBilinear');
  const out = createImage(width, height);
  if (img.width === 0 || img.height === 0 || width === 0 || height === 0) return out;
  const xs = bilinearTaps(img.width, width);
  const ys = bilinearTaps(img.height, height);
  const s = img.data;
  const d = out.data;
  for (let y = 0; y < height; y++) {
    const r0 = ys.i0[y] * img.width;
    const r1 = ys.i1[y] * img.width;
    const ty = ys.t[y];
    for (let x = 0; x < width; x++) {
      const tx = xs.t[x];
      const p00 = (r0 + xs.i0[x]) * 4;
      const p10 = (r0 + xs.i1[x]) * 4;
      const p01 = (r1 + xs.i0[x]) * 4;
      const p11 = (r1 + xs.i1[x]) * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const a00 = s[p00 + 3];
      const a10 = s[p10 + 3];
      const a01 = s[p01 + 3];
      const a11 = s[p11 + 3];
      const o = (y * width + x) * 4;
      const alpha = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
      if (alpha > 0 && (a00 & a10 & a01 & a11) !== 255) {
        const k00 = (a00 * w00) / alpha;
        const k10 = (a10 * w10) / alpha;
        const k01 = (a01 * w01) / alpha;
        const k11 = (a11 * w11) / alpha;
        for (let c = 0; c < 3; c++) d[o + c] = Math.floor(s[p00 + c] * k00 + s[p10 + c] * k10 + s[p01 + c] * k01 + s[p11 + c] * k11 + 0.5);
      } else {
        for (let c = 0; c < 3; c++) d[o + c] = Math.floor(s[p00 + c] * w00 + s[p10 + c] * w10 + s[p01 + c] * w01 + s[p11 + c] * w11 + 0.5);
      }
      d[o + 3] = Math.floor(alpha + 0.5);
    }
  }
  return out;
}

/** Bilinear upscale by `factor` (the size is rounded): see resizeBilinear. */
export function upscaleBilinear(img: ImageRGBA, factor: number): ImageRGBA {
  assertFactor(factor, 'upscaleBilinear');
  return resizeBilinear(img, scaledSize(img.width, factor), scaledSize(img.height, factor));
}

/** Bilinear resample of a mask to width x height. */
export function resizeMaskBilinear(mask: Mask, width: number, height: number): Mask {
  const out = createMask(width, height);
  if (mask.width === 0 || mask.height === 0 || width === 0 || height === 0) return out;
  const xs = bilinearTaps(mask.width, width);
  const ys = bilinearTaps(mask.height, height);
  const s = mask.data;
  for (let y = 0; y < height; y++) {
    const r0 = ys.i0[y] * mask.width;
    const r1 = ys.i1[y] * mask.width;
    const ty = ys.t[y];
    for (let x = 0; x < width; x++) {
      const tx = xs.t[x];
      const top = s[r0 + xs.i0[x]] * (1 - tx) + s[r0 + xs.i1[x]] * tx;
      const bottom = s[r1 + xs.i0[x]] * (1 - tx) + s[r1 + xs.i1[x]] * tx;
      out.data[y * width + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

/** Bilinear upscale of a mask by `factor`. */
export function upscaleMask(mask: Mask, factor: number): Mask {
  assertFactor(factor, 'upscaleMask');
  return resizeMaskBilinear(mask, scaledSize(mask.width, factor), scaledSize(mask.height, factor));
}

/** For every destination index: the source range it covers and the share of each source pixel in it. */
function areaTaps(srcN: number, dstN: number): { start: Int32Array; offset: Int32Array; weights: Float32Array } {
  const start = new Int32Array(dstN);
  const offset = new Int32Array(dstN + 1);
  const list: number[] = [];
  for (let d = 0; d < dstN; d++) {
    const a = (d * srcN) / dstN;
    const b = ((d + 1) * srcN) / dstN;
    const first = Math.min(srcN - 1, Math.floor(a));
    const last = Math.max(first, Math.min(srcN - 1, Math.ceil(b) - 1));
    start[d] = first;
    offset[d] = list.length;
    let total = 0;
    for (let i = first; i <= last; i++) {
      const w = Math.max(0, Math.min(b, i + 1) - Math.max(a, i));
      list.push(w);
      total += w;
    }
    for (let k = offset[d]; k < list.length; k++) list[k] = total > 0 ? list[k] / total : 1 / (last - first + 1);
  }
  offset[dstN] = list.length;
  return { start, offset, weights: Float32Array.from(list) };
}

/** Area-average `channels` interleaved float channels from sw x sh to dw x dh. */
function areaResample(src: Float32Array, sw: number, sh: number, channels: number, dw: number, dh: number): Float32Array {
  const xs = areaTaps(sw, dw);
  const ys = areaTaps(sh, dh);
  // Horizontal pass: sw x sh -> dw x sh.
  const mid = new Float32Array(dw * sh * channels);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) * channels;
      for (let k = xs.offset[x], i = xs.start[x]; k < xs.offset[x + 1]; k++, i++) {
        const w = xs.weights[k];
        const p = (y * sw + i) * channels;
        for (let c = 0; c < channels; c++) mid[o + c] += src[p + c] * w;
      }
    }
  }
  // Vertical pass: dw x sh -> dw x dh.
  const out = new Float32Array(dw * dh * channels);
  for (let y = 0; y < dh; y++) {
    for (let k = ys.offset[y], i = ys.start[y]; k < ys.offset[y + 1]; k++, i++) {
      const w = ys.weights[k];
      const p = i * dw * channels;
      const o = y * dw * channels;
      for (let j = 0; j < dw * channels; j++) out[o + j] += mid[p + j] * w;
    }
  }
  return out;
}

/**
 * Area-average resample to width x height: every destination pixel is the mean of the source area
 * it covers (exact for any ratio, no aliasing when shrinking). Alpha-aware: colours are weighted by
 * alpha; a destination pixel whose whole area is transparent gets RGB 0 (run extendEdges afterwards
 * when the result is sampled bilinearly).
 */
export function resizeArea(img: ImageRGBA, width: number, height: number): ImageRGBA {
  assertImage(img, 'resizeArea');
  assertSize(width, height, 'resizeArea');
  const out = createImage(width, height);
  if (img.width === 0 || img.height === 0 || width === 0 || height === 0) return out;
  const n = img.width * img.height;
  const pre = new Float32Array(n * 4);
  const s = img.data;
  for (let i = 0; i < n * 4; i += 4) {
    const a = s[i + 3];
    pre[i] = s[i] * a;
    pre[i + 1] = s[i + 1] * a;
    pre[i + 2] = s[i + 2] * a;
    pre[i + 3] = a;
  }
  const res = areaResample(pre, img.width, img.height, 4, width, height);
  const d = out.data;
  for (let i = 0; i < res.length; i += 4) {
    const a = res[i + 3];
    if (!(a > 0)) continue;
    d[i] = Math.floor(res[i] / a + 0.5);
    d[i + 1] = Math.floor(res[i + 1] / a + 0.5);
    d[i + 2] = Math.floor(res[i + 2] / a + 0.5);
    d[i + 3] = Math.floor(a + 0.5);
  }
  return out;
}

/**
 * Area-average downscale by `factor` (2 = half size; the size is rounded, at least 1 px), e.g. a
 * reduced-size copy of an illustration for fast tests and previews. See resizeArea.
 */
export function downscaleArea(img: ImageRGBA, factor: number): ImageRGBA {
  assertFactor(factor, 'downscaleArea');
  return resizeArea(img, scaledSize(img.width, 1 / factor), scaledSize(img.height, 1 / factor));
}

/** Area-average resample of a mask to width x height. */
export function resizeMaskArea(mask: Mask, width: number, height: number): Mask {
  assertSize(width, height, 'resizeMaskArea');
  if (mask.width === 0 || mask.height === 0 || width === 0 || height === 0) return createMask(width, height);
  return { width, height, data: areaResample(mask.data, mask.width, mask.height, 1, width, height) };
}

/** Area-average downscale of a mask by `factor`. */
export function downscaleMask(mask: Mask, factor: number): Mask {
  assertFactor(factor, 'downscaleMask');
  return resizeMaskArea(mask, scaledSize(mask.width, 1 / factor), scaledSize(mask.height, 1 / factor));
}
