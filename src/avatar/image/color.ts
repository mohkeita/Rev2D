/**
 * Colour: sRGB <-> linear light, sRGB <-> CIE L*a*b* (D65), colour difference, whole-image Lab
 * conversion, and robust statistics of the colours under a mask (mean, median, trimmed mean,
 * dominant colours by a small deterministic k-means).
 *
 * RGB values are sRGB in 0..255 (as stored in ImageRGBA; fractions allowed). Statistics weight every
 * pixel by mask value x alpha, so transparent pixels never count.
 */
import { assertSameSize } from './mask.js';
import { mulberry32, randomInt } from './random.js';
import type { ImageRGBA, Lab, Mask, RGB } from './types.js';

// ----------------------------------------------------------------------------- transfer curve

/** sRGB-encoded value (0..1) -> linear light (0..1). */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear light (0..1) -> sRGB-encoded value (0..1). */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Linear-light value of every 8-bit sRGB code. */
const LINEAR_OF_8BIT = /* @__PURE__ */ (() => {
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  return lut;
})();

function linearOf(v: number): number {
  return Number.isInteger(v) && v >= 0 && v <= 255 ? LINEAR_OF_8BIT[v] : srgbToLinear(v / 255);
}

// ----------------------------------------------------------------------------- Lab

// Linear sRGB -> CIE XYZ (D65 white), and the reference white.
const M = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
const XN = 0.95047;
const YN = 1;
const ZN = 1.08883;
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

/** Inverse of M, computed so that the round trip is exact to float precision. */
const M_INV = /* @__PURE__ */ (() => {
  const [a, b, c, d, e, f, g, h, i] = M;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
})();

function labF(t: number): number {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

function labFInv(f: number): number {
  const t = f * f * f;
  return t > EPSILON ? t : (116 * f - 16) / KAPPA;
}

/** sRGB (0..255 per channel) -> CIE L*a*b* (D65). */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = linearOf(r);
  const lg = linearOf(g);
  const lb = linearOf(b);
  const fx = labF((M[0] * lr + M[1] * lg + M[2] * lb) / XN);
  const fy = labF((M[3] * lr + M[4] * lg + M[5] * lb) / YN);
  const fz = labF((M[6] * lr + M[7] * lg + M[8] * lb) / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE L*a*b* (D65) -> sRGB, each channel clamped to 0..255 (not rounded). */
export function labToRgb(L: number, a: number, b: number): RGB {
  const fy = (L + 16) / 116;
  const x = labFInv(fy + a / 500) * XN;
  const y = labFInv(fy) * YN;
  const z = labFInv(fy - b / 200) * ZN;
  const channel = (lin: number): number => {
    const v = linearToSrgb(lin) * 255;
    return v < 0 || Number.isNaN(v) ? 0 : v > 255 ? 255 : v;
  };
  return [
    channel(M_INV[0] * x + M_INV[1] * y + M_INV[2] * z),
    channel(M_INV[3] * x + M_INV[4] * y + M_INV[5] * z),
    channel(M_INV[6] * x + M_INV[7] * y + M_INV[8] * z),
  ];
}

/**
 * Colour difference between two Lab colours (CIE76: the Euclidean distance). About 1 is just
 * noticeable, 2-10 a visible difference of similar colours, above ~25 clearly different colours.
 */
export function deltaE(p: Lab, q: Lab): number {
  const dl = p[0] - q[0];
  const da = p[1] - q[1];
  const db = p[2] - q[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** Colour difference between two sRGB colours (0..255 per channel), see deltaE. */
export function deltaERgb(p: RGB, q: RGB): number {
  return deltaE(rgbToLab(p[0], p[1], p[2]), rgbToLab(q[0], q[1], q[2]));
}

/** An image converted to Lab: `lab` holds L, a, b per pixel (3 floats), `alpha` is the image's alpha channel (0..255). */
export interface LabImage {
  width: number;
  height: number;
  lab: Float32Array;
  alpha: Uint8ClampedArray;
}

/** Convert a whole image to Lab once, for functions that compare many pixels (growRegion, colorMatchMask). */
export function imageToLab(img: ImageRGBA): LabImage {
  const n = img.width * img.height;
  const lab = new Float32Array(n * 3);
  const alpha = new Uint8ClampedArray(n);
  const s = img.data;
  for (let i = 0; i < n; i++) {
    writeLab(s, i * 4, lab, i * 3);
    alpha[i] = s[i * 4 + 3];
  }
  return { width: img.width, height: img.height, lab, alpha };
}

/** Lab of the RGBA8 pixel at byte offset `si`, written to out[oi..oi+2]. */
export function writeLab(src: Uint8ClampedArray, si: number, out: Float32Array, oi: number): void {
  const lr = LINEAR_OF_8BIT[src[si]];
  const lg = LINEAR_OF_8BIT[src[si + 1]];
  const lb = LINEAR_OF_8BIT[src[si + 2]];
  const fx = labF((M[0] * lr + M[1] * lg + M[2] * lb) / XN);
  const fy = labF(M[3] * lr + M[4] * lg + M[5] * lb);
  const fz = labF((M[6] * lr + M[7] * lg + M[8] * lb) / ZN);
  out[oi] = 116 * fy - 16;
  out[oi + 1] = 500 * (fx - fy);
  out[oi + 2] = 200 * (fy - fz);
}

/**
 * A mask of the pixels whose colour is within `tolerance` (deltaE) of the nearest of the reference
 * colours: 1 up to the tolerance, fading linearly to 0 at tolerance + `softness`. Fully transparent
 * pixels are 0.
 */
export function colorMatchMask(image: ImageRGBA | LabImage, references: Lab[], tolerance: number, softness = 0): Mask {
  const img = 'lab' in image ? image : imageToLab(image);
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const refs = new Float64Array(references.length * 3);
  references.forEach((c, k) => refs.set(c, k * 3));
  const reach = tolerance + Math.max(0, softness);
  const reach2 = reach * reach;
  for (let i = 0; i < n; i++) {
    if (img.alpha[i] === 0) continue;
    const L = img.lab[i * 3];
    const a = img.lab[i * 3 + 1];
    const b = img.lab[i * 3 + 2];
    let best = Infinity;
    for (let k = 0; k < refs.length; k += 3) {
      const d2 = (L - refs[k]) ** 2 + (a - refs[k + 1]) ** 2 + (b - refs[k + 2]) ** 2;
      if (d2 < best) best = d2;
    }
    if (best > reach2) continue;
    const d = Math.sqrt(best);
    out[i] = d <= tolerance ? 1 : (reach - d) / (reach - tolerance);
  }
  return { width: img.width, height: img.height, data: out };
}

// ----------------------------------------------------------------------------- statistics

export interface ColorStats {
  /** Number of pixels that count (mask > 0 and alpha > 0). */
  count: number;
  /** Sum of their weights (mask value x alpha / 255). */
  weight: number;
  /** Weighted mean per channel (sRGB values, 0..255). */
  mean: RGB;
  /** Weighted median per channel: robust against outliers such as lash or highlight pixels. */
  median: RGB;
  /** Weighted mean per channel after dropping the lowest and the highest `trim` share of the weight. */
  trimmedMean: RGB;
  /** Weighted standard deviation per channel: near 0 for a flat colour. */
  std: RGB;
}

export interface ColorStatsOptions {
  /** Share of the weight dropped at each end for the trimmed mean (0..0.49, default 0.1). */
  trim?: number;
}

/**
 * Statistics of the colours under a mask (the whole image when `mask` is omitted), weighted by mask
 * value x alpha. Returns null when no pixel counts.
 */
export function colorStats(img: ImageRGBA, mask?: Mask | null, opts: ColorStatsOptions = {}): ColorStats | null {
  if (mask) assertSameSize(img, mask, 'colorStats');
  const trim = Math.min(0.49, Math.max(0, opts.trim ?? 0.1));
  const n = img.width * img.height;
  const s = img.data;
  const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  let count = 0;
  let weight = 0;
  for (let i = 0; i < n; i++) {
    const m = mask ? mask.data[i] : 1;
    if (!(m > 0)) continue;
    const a = s[i * 4 + 3];
    if (a === 0) continue;
    const w = (m > 1 ? 1 : m) * (a / 255);
    count++;
    weight += w;
    hist[0][s[i * 4]] += w;
    hist[1][s[i * 4 + 1]] += w;
    hist[2][s[i * 4 + 2]] += w;
  }
  if (count === 0 || !(weight > 0)) return null;
  const mean: RGB = [0, 0, 0];
  const median: RGB = [0, 0, 0];
  const trimmedMean: RGB = [0, 0, 0];
  const std: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const h = hist[c];
    let sum = 0;
    let sumSq = 0;
    for (let v = 0; v < 256; v++) {
      sum += h[v] * v;
      sumSq += h[v] * v * v;
    }
    mean[c] = sum / weight;
    std[c] = Math.sqrt(Math.max(0, sumSq / weight - mean[c] * mean[c]));
    // Median: the first value at which the cumulative weight reaches half of the total.
    let cum = 0;
    for (let v = 0; v < 256; v++) {
      cum += h[v];
      if (cum >= weight / 2) {
        median[c] = v;
        break;
      }
    }
    // Trimmed mean: the weight between the two cut points, bins on a cut counted partially.
    const lo = weight * trim;
    const hi = weight * (1 - trim);
    let acc = 0;
    let tSum = 0;
    let tWeight = 0;
    for (let v = 0; v < 256; v++) {
      const from = acc;
      acc += h[v];
      const part = Math.min(acc, hi) - Math.max(from, lo);
      if (part > 0) {
        tSum += part * v;
        tWeight += part;
      }
    }
    trimmedMean[c] = tWeight > 0 ? tSum / tWeight : median[c];
  }
  return { count, weight, mean, median, trimmedMean, std };
}

export interface ColorCluster {
  /** Cluster centre as sRGB (0..255, not rounded) and as Lab. */
  rgb: RGB;
  lab: Lab;
  /** Share of the total weight that belongs to this cluster (the shares sum to 1). */
  share: number;
}

export interface DominantColorOptions {
  /** Seed of the k-means++ initialisation (default 1). The same seed gives the same clusters. */
  seed?: number;
  /** At most this many pixels are clustered; more are subsampled evenly, by the seed (default 20000). */
  maxSamples?: number;
  /** Maximum number of k-means iterations (default 24; it usually converges earlier). */
  iterations?: number;
}

/**
 * The up to `k` dominant colours under a mask (the whole image when `mask` is null), by k-means in
 * Lab, sorted by share (largest first). Deterministic for a given seed. Fewer than `k` clusters come
 * back when the pixels have fewer distinct colours; an empty list when no pixel counts.
 */
export function dominantColors(img: ImageRGBA, mask: Mask | null | undefined, k: number, opts: DominantColorOptions = {}): ColorCluster[] {
  if (mask) assertSameSize(img, mask, 'dominantColors');
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`dominantColors: k must be a positive integer, got ${k}`);
  const maxSamples = Math.max(1, Math.floor(opts.maxSamples ?? 20000));
  const n = img.width * img.height;
  const s = img.data;
  let count = 0;
  for (let i = 0; i < n; i++) if ((mask ? mask.data[i] > 0 : true) && s[i * 4 + 3] > 0) count++;
  if (count === 0) return [];
  // Subsampling takes one pixel at a random position out of every `step` counting pixels: an even
  // spread without the aliasing a fixed stride has against the image width.
  const random = mulberry32(opts.seed ?? 1);
  const step = Math.max(1, Math.ceil(count / maxSamples));
  const m = Math.ceil(count / step);
  const lab = new Float32Array(m * 3);
  const w = new Float32Array(m);
  let seen = 0;
  let take = step > 1 ? randomInt(random, step) : 0;
  let used = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const mv = mask ? mask.data[i] : 1;
    if (!(mv > 0) || s[i * 4 + 3] === 0) continue;
    const position = seen++ % step;
    if (position === take) {
      writeLab(s, i * 4, lab, used * 3);
      w[used] = (mv > 1 ? 1 : mv) * (s[i * 4 + 3] / 255);
      total += w[used];
      used++;
    }
    if (position === step - 1 && step > 1) take = randomInt(random, step);
  }
  if (used === 0) return [];

  // k-means++ initialisation: each next centre is drawn with probability ~ weight x squared distance.
  const centres: number[] = [];
  const d2 = new Float64Array(used).fill(Infinity);
  const pick = (weights: (i: number) => number, sum: number): number => {
    let r = random() * sum;
    for (let i = 0; i < used; i++) {
      r -= weights(i);
      if (r < 0) return i;
    }
    return used - 1;
  };
  let chosen = pick((i) => w[i], total);
  for (let c = 0; c < k; c++) {
    centres.push(lab[chosen * 3], lab[chosen * 3 + 1], lab[chosen * 3 + 2]);
    let sum = 0;
    for (let i = 0; i < used; i++) {
      const d = (lab[i * 3] - centres[c * 3]) ** 2 + (lab[i * 3 + 1] - centres[c * 3 + 1]) ** 2 + (lab[i * 3 + 2] - centres[c * 3 + 2]) ** 2;
      if (d < d2[i]) d2[i] = d;
      sum += w[i] * d2[i];
    }
    if (!(sum > 1e-9)) break; // every sample already sits on a centre: fewer distinct colours than k
    chosen = pick((i) => w[i] * d2[i], sum);
  }

  // Lloyd iterations.
  const kk = centres.length / 3;
  const assign = new Int32Array(used).fill(-1);
  const sums = new Float64Array(kk * 4);
  const iterations = Math.max(1, opts.iterations ?? 24);
  for (let it = 0; it < iterations; it++) {
    let changed = false;
    sums.fill(0);
    for (let i = 0; i < used; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = (lab[i * 3] - centres[c * 3]) ** 2 + (lab[i * 3 + 1] - centres[c * 3 + 1]) ** 2 + (lab[i * 3 + 2] - centres[c * 3 + 2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
      sums[best * 4] += w[i] * lab[i * 3];
      sums[best * 4 + 1] += w[i] * lab[i * 3 + 1];
      sums[best * 4 + 2] += w[i] * lab[i * 3 + 2];
      sums[best * 4 + 3] += w[i];
    }
    for (let c = 0; c < kk; c++) {
      if (sums[c * 4 + 3] > 0) {
        centres[c * 3] = sums[c * 4] / sums[c * 4 + 3];
        centres[c * 3 + 1] = sums[c * 4 + 1] / sums[c * 4 + 3];
        centres[c * 3 + 2] = sums[c * 4 + 2] / sums[c * 4 + 3];
      }
    }
    if (!changed) break;
  }

  const clusters: ColorCluster[] = [];
  for (let c = 0; c < kk; c++) {
    const share = sums[c * 4 + 3] / total;
    if (!(share > 0)) continue;
    const centre: Lab = [centres[c * 3], centres[c * 3 + 1], centres[c * 3 + 2]];
    clusters.push({ rgb: labToRgb(centre[0], centre[1], centre[2]), lab: centre, share });
  }
  // Largest first; ties (rare) by lightness, then a, then b, so the order never depends on the seed.
  clusters.sort((p, q) => q.share - p.share || p.lab[0] - q.lab[0] || p.lab[1] - q.lab[1] || p.lab[2] - q.lab[2]);
  return clusters;
}
