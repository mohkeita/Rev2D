/**
 * Separable blurs for masks and RGBA images: Gaussian and box.
 *
 * - Gaussians below sigma 3 px use the exact sampled kernel, cut at 3 sigma and normalised.
 * - From sigma 3 on, four passes of an "extended" box filter (a box with fractional end taps) are
 *   used: the result has exactly the requested variance, costs the same for every sigma and stays
 *   within about 3.5% of the true kernel's peak per axis (a slightly flatter top, no tails beyond
 *   ~3.5 sigma).
 * - RGBA is blurred alpha-aware (premultiplied), so transparent pixels do not bleed their colour.
 * - Every kernel sums to 1: the sum of a mask is preserved as long as nothing reaches the border.
 */
import { assertImage } from '../../render/image.js';
import { createMask } from './mask.js';
import type { ImageRGBA, Mask } from './types.js';

export interface BlurOptions {
  /**
   * What lies beyond the border: "clamp" (default) repeats the edge pixels, so a picture cut by the
   * canvas does not fade there; "zero" treats the outside as empty / transparent.
   */
  edge?: 'clamp' | 'zero';
}

/** One 1-D filter: either an explicit symmetric kernel or an extended box. */
type Filter =
  | { kind: 'kernel'; radius: number; weights: Float64Array }
  | { kind: 'box'; radius: number; frac: number };

function padOf(filter: Filter): number {
  return filter.kind === 'kernel' ? filter.radius : filter.radius + 1;
}

/**
 * Filter line[from .. to) into the same positions of `out`. The filter reads padOf(filter) values
 * on each side of that range.
 */
function filterLine(line: Float64Array, out: Float64Array, from: number, to: number, filter: Filter): void {
  if (to <= from) return;
  if (filter.kind === 'kernel') {
    // The kernel is symmetric: weights[radius + k] multiplies the pair at -k and +k.
    const { radius, weights } = filter;
    const centre = weights[radius];
    for (let i = from; i < to; i++) {
      let sum = centre * line[i];
      for (let k = 1; k <= radius; k++) sum += weights[radius + k] * (line[i - k] + line[i + k]);
      out[i] = sum;
    }
    return;
  }
  const { radius, frac } = filter;
  const inv = 1 / (2 * radius + 1 + 2 * frac);
  // A running sum: its rounding (about 1e-16 per step) is far below 8- or 24-bit precision.
  let sum = 0;
  for (let k = from - radius; k <= from + radius; k++) sum += line[k];
  for (let i = from; i < to; i++) {
    out[i] = (sum + frac * (line[i - radius - 1] + line[i + radius + 1])) * inv;
    sum += line[i + radius + 1] - line[i - radius];
  }
}

/**
 * Apply the filters in sequence along every row, then along every column of a plane, in place.
 * Each line is extended ONCE by the combined reach of all passes (edge values or zeros), and the
 * passes keep their intermediate values out there, so several passes behave exactly like one pass
 * with the combined kernel on the extended line.
 */
function filterPlane(plane: Float32Array, width: number, height: number, filters: Filter[], clamp: boolean): void {
  if (filters.length === 0 || width === 0 || height === 0) return;
  let pad = 0;
  for (const f of filters) pad += padOf(f);
  const run = (n: number, stride: number, step: number, count: number): void => {
    let line = new Float64Array(n + 2 * pad);
    let out = new Float64Array(n + 2 * pad);
    for (let k = 0; k < count; k++) {
      const start = k * step;
      for (let j = 0, i = start; j < n; j++, i += stride) line[pad + j] = plane[i];
      const first = clamp ? line[pad] : 0;
      const last = clamp ? line[pad + n - 1] : 0;
      for (let i = 0; i < pad; i++) {
        line[i] = first;
        line[pad + n + i] = last;
      }
      let from = 0;
      let to = n + 2 * pad;
      for (const f of filters) {
        from += padOf(f);
        to -= padOf(f);
        filterLine(line, out, from, to, f);
        const t = line;
        line = out;
        out = t;
      }
      for (let j = 0, i = start; j < n; j++, i += stride) plane[i] = line[pad + j];
    }
  };
  run(width, 1, width, height); // rows
  run(height, width, 1, width); // columns
}

/** Normalised Gaussian kernel sampled at integer offsets, cut at 3 sigma. */
function gaussianKernel(sigma: number): Filter {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const weights = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    weights[k + radius] = w;
    sum += w;
  }
  for (let k = 0; k < weights.length; k++) weights[k] /= sum;
  return { kind: 'kernel', radius, weights };
}

/** The extended box filter (integer radius + fractional end taps) with the given variance. */
function boxOfVariance(variance: number): Filter {
  // A plain box of radius r has variance r (r + 1) / 3: take the largest r below the target and
  // make up the rest with the fractional taps.
  const radius = Math.max(0, Math.floor((Math.sqrt(1 + 12 * variance) - 1) / 2));
  const plain = (radius * (radius + 1)) / 3;
  const frac = ((2 * radius + 1) * (variance - plain)) / (2 * ((radius + 1) * (radius + 1) - variance));
  return { kind: 'box', radius, frac: Math.min(1, Math.max(0, frac)) };
}

/** Below this sigma the exact kernel is used (at most 19 taps); from it on, BOX_PASSES extended boxes. */
const EXACT_BELOW = 3;
const BOX_PASSES = 4;

/** The 1-D filters that make up a Gaussian of the given sigma (see the file comment). */
function gaussianFilters(sigma: number): Filter[] {
  if (!(sigma > 0)) return [];
  if (sigma < EXACT_BELOW) return [gaussianKernel(sigma)];
  const box = boxOfVariance((sigma * sigma) / BOX_PASSES);
  return new Array<Filter>(BOX_PASSES).fill(box);
}

function boxFilters(radius: number): Filter[] {
  if (!(radius > 0)) return [];
  const whole = Math.floor(radius);
  return [{ kind: 'box', radius: whole, frac: radius - whole }];
}

function filterMask(mask: Mask, filters: Filter[], opts: BlurOptions): Mask {
  const out = createMask(mask.width, mask.height);
  out.data.set(mask.data);
  filterPlane(out.data, mask.width, mask.height, filters, (opts.edge ?? 'clamp') === 'clamp');
  return out;
}

function filterImage(img: ImageRGBA, filters: Filter[], opts: BlurOptions, fn: string): ImageRGBA {
  assertImage(img, fn);
  const { width, height } = img;
  const n = width * height;
  const out: ImageRGBA = { width, height, data: new Uint8ClampedArray(img.data) };
  if (filters.length === 0 || n === 0) return out;
  const clamp = (opts.edge ?? 'clamp') === 'clamp';
  const src = img.data;
  const alpha = new Float32Array(n);
  let opaque = true;
  for (let i = 0; i < n; i++) {
    alpha[i] = src[i * 4 + 3];
    if (alpha[i] !== 255) opaque = false;
  }
  // With "zero" edges even an opaque image becomes transparent toward the border.
  const uniform = opaque && clamp;
  if (!uniform) filterPlane(alpha, width, height, filters, clamp);
  const plane = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    if (uniform) for (let i = 0; i < n; i++) plane[i] = src[i * 4 + c];
    else for (let i = 0; i < n; i++) plane[i] = src[i * 4 + c] * src[i * 4 + 3];
    filterPlane(plane, width, height, filters, clamp);
    for (let i = 0; i < n; i++) {
      const a = uniform ? 1 : alpha[i];
      out.data[i * 4 + c] = a > 0 ? Math.floor(plane[i] / a + 0.5) : 0;
    }
  }
  if (!uniform) for (let i = 0; i < n; i++) out.data[i * 4 + 3] = Math.floor(alpha[i] + 0.5);
  return out;
}

/** Gaussian blur of a mask with standard deviation `sigma` px (sigma <= 0 returns a copy). */
export function blurMask(mask: Mask, sigma: number, opts: BlurOptions = {}): Mask {
  return filterMask(mask, gaussianFilters(sigma), opts);
}

/**
 * Gaussian blur of an image with standard deviation `sigma` px, alpha-aware: colours are weighted
 * by their alpha, so transparent pixels contribute no colour and edges do not darken.
 */
export function blurImage(img: ImageRGBA, sigma: number, opts: BlurOptions = {}): ImageRGBA {
  return filterImage(img, gaussianFilters(sigma), opts, 'blurImage');
}

/**
 * Box blur of a mask: the mean over a (2 radius + 1)² window. `radius` may be fractional (the outermost
 * pixels of the window then count partially).
 */
export function boxBlurMask(mask: Mask, radius: number, opts: BlurOptions = {}): Mask {
  return filterMask(mask, boxFilters(radius), opts);
}

/** Box blur of an image (alpha-aware), see boxBlurMask. */
export function boxBlurImage(img: ImageRGBA, radius: number, opts: BlurOptions = {}): ImageRGBA {
  return filterImage(img, boxFilters(radius), opts, 'boxBlurImage');
}
