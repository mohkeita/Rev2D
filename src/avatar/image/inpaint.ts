/**
 * Filling in missing pixels:
 * - inpaint: fill a hole from its surroundings so shading continues smoothly (what lies behind a
 *   cut-out layer: eyelid skin behind an eye, cloth behind a tassel).
 * - extendEdges: bleed the colours of visible pixels into the transparent pixels next to them
 *   (alpha unchanged), so bilinear texture sampling at a layer's edge does not darken.
 *
 * inpaint solves the membrane (Laplace) equation on the hole: every filled pixel becomes the
 * weighted average of its four neighbours, with the surrounding visible pixels as fixed values.
 * A linear gradient is continued exactly; curved shading is continued smoothly. The solver works
 * coarse to fine on an image pyramid (each level starts from the level above and is relaxed with
 * successive over-relaxation), so large holes cost little more than their pixel count. No texture is
 * synthesised: the fill is smooth by construction.
 */
import { assertImage, cloneImage } from '../../render/image.js';
import { assertSameSize, maskBounds } from './mask.js';
import type { ImageRGBA, Mask } from './types.js';

const VOID = 0;
const SOURCE = 1;
const UNKNOWN = 2;

/**
 * One pyramid level, stored with a 1-pixel border of VOID cells so neighbours need no bounds checks.
 * `weight` is what a cell contributes to its neighbours' averages: a source's weight, 1 for an
 * unknown that has a value, 0 for void cells and unknowns without a value yet.
 */
interface Level {
  w: number;
  h: number;
  stride: number;
  kind: Uint8Array;
  weight: Float32Array;
  planes: Float32Array[];
}

function createLevel(w: number, h: number, planes: number): Level {
  const stride = w + 2;
  const size = stride * (h + 2);
  return {
    w,
    h,
    stride,
    kind: new Uint8Array(size),
    weight: new Float32Array(size),
    planes: Array.from({ length: planes }, () => new Float32Array(size)),
  };
}

/** Half-resolution level: a block with any source is a source (their weighted mean), else unknown if it holds an unknown. */
function coarsen(fine: Level): Level {
  const coarse = createLevel(Math.ceil(fine.w / 2), Math.ceil(fine.h / 2), fine.planes.length);
  const sums = new Float64Array(fine.planes.length);
  for (let cy = 0; cy < coarse.h; cy++) {
    for (let cx = 0; cx < coarse.w; cx++) {
      let weight = 0;
      let unknown = 0;
      sums.fill(0);
      for (let dy = 0; dy < 2; dy++) {
        const fy = cy * 2 + dy;
        if (fy >= fine.h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const fx = cx * 2 + dx;
          if (fx >= fine.w) continue;
          const fi = (fy + 1) * fine.stride + fx + 1;
          if (fine.kind[fi] === SOURCE) {
            const wgt = fine.weight[fi];
            weight += wgt;
            for (let p = 0; p < sums.length; p++) sums[p] += wgt * fine.planes[p][fi];
          } else if (fine.kind[fi] === UNKNOWN) unknown++;
        }
      }
      const ci = (cy + 1) * coarse.stride + cx + 1;
      if (weight > 0) {
        coarse.kind[ci] = SOURCE;
        coarse.weight[ci] = weight / 4;
        for (let p = 0; p < sums.length; p++) coarse.planes[p][ci] = sums[p] / weight;
      } else if (unknown > 0) coarse.kind[ci] = UNKNOWN;
    }
  }
  return coarse;
}

/** Start values for the fine unknowns: bilinear interpolation of the coarse cells that have a value. */
function prolongate(coarse: Level, fine: Level): void {
  for (let y = 0; y < fine.h; y++) {
    const cy = y >> 1;
    const ny = y & 1 ? cy + 1 : cy - 1;
    for (let x = 0; x < fine.w; x++) {
      const fi = (y + 1) * fine.stride + x + 1;
      if (fine.kind[fi] !== UNKNOWN) continue;
      const cx = x >> 1;
      const nx = x & 1 ? cx + 1 : cx - 1;
      const i00 = (cy + 1) * coarse.stride + cx + 1;
      const i10 = (cy + 1) * coarse.stride + nx + 1;
      const i01 = (ny + 1) * coarse.stride + cx + 1;
      const i11 = (ny + 1) * coarse.stride + nx + 1;
      const w00 = coarse.weight[i00] > 0 ? 0.5625 : 0;
      const w10 = coarse.weight[i10] > 0 ? 0.1875 : 0;
      const w01 = coarse.weight[i01] > 0 ? 0.1875 : 0;
      const w11 = coarse.weight[i11] > 0 ? 0.0625 : 0;
      const total = w00 + w10 + w01 + w11;
      if (!(total > 0)) continue;
      for (let p = 0; p < fine.planes.length; p++) {
        const c = coarse.planes[p];
        fine.planes[p][fi] = (w00 * c[i00] + w10 * c[i10] + w01 * c[i01] + w11 * c[i11]) / total;
      }
      fine.weight[fi] = 1;
    }
  }
}

/**
 * Relax the unknowns of one level toward the weighted average of their neighbours (SOR, sweeping
 * forward and backward in turn; the last sweeps are plain Gauss-Seidel so no over-relaxation ripple
 * remains). Unknowns without a value take the average of the neighbours that have one.
 */
function relax(level: Level, unknowns: Int32Array, iterations: number): void {
  const { stride, weight, planes } = level;
  const count = unknowns.length;
  if (count === 0) return;
  const size = Math.sqrt(count) + 1;
  const omega = Math.min(1.95, 2 / (1 + Math.sin(Math.PI / (size + 1))));
  const plain = Math.min(2, iterations);
  let settled = false;
  for (let it = 0; it < iterations; it++) {
    const last = settled || it >= iterations - plain;
    const om = last ? 1 : omega;
    let maxChange = 0;
    let grew = false;
    const forward = (it & 1) === 0;
    for (let k = 0; k < count; k++) {
      const i = unknowns[forward ? k : count - 1 - k];
      const wl = weight[i - 1];
      const wr = weight[i + 1];
      const wu = weight[i - stride];
      const wd = weight[i + stride];
      const total = wl + wr + wu + wd;
      if (!(total > 0)) continue;
      const fresh = weight[i] === 0;
      for (let p = 0; p < planes.length; p++) {
        const v = planes[p];
        const avg = (wl * v[i - 1] + wr * v[i + 1] + wu * v[i - stride] + wd * v[i + stride]) / total;
        if (fresh) v[i] = avg;
        else {
          const change = om * (avg - v[i]);
          v[i] += change;
          const mag = change < 0 ? -change : change;
          if (mag > maxChange) maxChange = mag;
        }
      }
      if (fresh) {
        weight[i] = 1;
        grew = true;
      }
    }
    if (settled) break;
    // Converged (values are on a 0..255 scale): finish with one plain sweep.
    if (!grew && maxChange < 0.02) settled = true;
  }
}

function solve(level: Level, iterations: number): void {
  let count = 0;
  for (let i = 0; i < level.kind.length; i++) if (level.kind[i] === UNKNOWN) count++;
  if (count === 0) return;
  if (level.w > 1 || level.h > 1) {
    const coarse = coarsen(level);
    solve(coarse, iterations);
    prolongate(coarse, level);
  }
  const unknowns = new Int32Array(count);
  let k = 0;
  for (let i = 0; i < level.kind.length; i++) if (level.kind[i] === UNKNOWN) unknowns[k++] = i;
  relax(level, unknowns, iterations);
}

export interface InpaintOptions {
  /**
   * The alpha of the filled pixels:
   * - "diffuse" (default): interpolated smoothly between the alphas around the hole, so a hole that
   *   spans the silhouette fades from opaque to transparent instead of inventing an outline.
   * - "opaque": 255.
   * - "keep": unchanged (only the colours are replaced).
   */
  alpha?: 'diffuse' | 'opaque' | 'keep';
  /**
   * Restricts where colours are taken from: a weight per pixel (0..1). Pixels with weight 0 are
   * never used as a colour source (e.g. lashes or hair around an eye region when only skin should
   * flow in). Default: every visible pixel outside the hole, weighted by its alpha.
   */
  sources?: Mask;
  /** Relaxation sweeps per pyramid level (default 48). More sweeps only matter for very large holes. */
  iterations?: number;
}

/**
 * Fill the pixels of `hole` (every pixel with a mask value > 0) from the visible pixels around it.
 * Returns a new image; pixels outside the hole are untouched.
 *
 * - Alpha-aware: fully transparent pixels contribute nothing, partly transparent ones in proportion
 *   to their alpha.
 * - Pixels with a partial mask value are blended between the original and the fill (value 1 =
 *   fully replaced). The pixels just outside the hole are trusted as they are: when the hole is the
 *   outline of an object that is being removed, dilate it by 1-2 px first so the object's
 *   antialiased rim does not leak into the fill.
 * - Parts of the hole that no visible pixel can reach (a hole surrounded by transparency) cannot be
 *   filled: they become fully transparent ("keep" leaves them untouched).
 * - Deterministic.
 */
export function inpaint(img: ImageRGBA, hole: Mask, opts: InpaintOptions = {}): ImageRGBA {
  assertImage(img, 'inpaint');
  assertSameSize(img, hole, 'inpaint');
  if (opts.sources) assertSameSize(img, opts.sources, 'inpaint');
  const out = cloneImage(img);
  const bounds = maskBounds(hole, 0);
  if (!bounds) return out;
  const mode = opts.alpha ?? 'diffuse';
  const iterations = Math.max(1, Math.floor(opts.iterations ?? 48));
  const W = img.width;
  // The hole plus the ring of pixels around it (the only pixels the solution depends on).
  const x0 = Math.max(0, bounds.x - 1);
  const y0 = Math.max(0, bounds.y - 1);
  const x1 = Math.min(img.width, bounds.x + bounds.width + 1);
  const y1 = Math.min(img.height, bounds.y + bounds.height + 1);
  const ww = x1 - x0;
  const wh = y1 - y0;
  const src = img.data;
  const sources = opts.sources ? opts.sources.data : null;

  const colour = createLevel(ww, wh, 3);
  let alphaMin = 255;
  let alphaMax = 0;
  let known = 0;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const gi = (y + y0) * W + x + x0;
      const li = (y + 1) * colour.stride + x + 1;
      if (hole.data[gi] > 0) {
        colour.kind[li] = UNKNOWN;
        continue;
      }
      const a = src[gi * 4 + 3];
      known++;
      if (a < alphaMin) alphaMin = a;
      if (a > alphaMax) alphaMax = a;
      let weight = a / 255;
      if (sources) weight *= Math.min(1, Math.max(0, sources[gi]));
      if (!(weight > 0)) continue;
      colour.kind[li] = SOURCE;
      colour.weight[li] = weight;
      colour.planes[0][li] = src[gi * 4];
      colour.planes[1][li] = src[gi * 4 + 1];
      colour.planes[2][li] = src[gi * 4 + 2];
    }
  }
  solve(colour, iterations);

  // Alpha of the fill: every pixel around the hole is a source here, transparent ones included.
  let alpha: Level | null = null;
  if (mode === 'diffuse' && known > 0 && alphaMin !== alphaMax) {
    alpha = createLevel(ww, wh, 1);
    for (let y = 0; y < wh; y++) {
      for (let x = 0; x < ww; x++) {
        const gi = (y + y0) * W + x + x0;
        const li = (y + 1) * alpha.stride + x + 1;
        if (hole.data[gi] > 0) alpha.kind[li] = UNKNOWN;
        else {
          alpha.kind[li] = SOURCE;
          alpha.weight[li] = 1;
          alpha.planes[0][li] = src[gi * 4 + 3];
        }
      }
    }
    solve(alpha, iterations);
  }

  const [R, G, B] = colour.planes;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const gi = (y + y0) * W + x + x0;
      const hv = hole.data[gi];
      if (!(hv > 0)) continue;
      const li = (y + 1) * colour.stride + x + 1;
      const filled = colour.weight[li] > 0;
      const o = gi * 4;
      const origA = src[o + 3];
      if (mode === 'keep' && !filled) continue;
      let fillA: number;
      if (mode === 'keep') fillA = origA;
      else if (!filled) fillA = 0;
      else if (mode === 'opaque') fillA = 255;
      else if (alpha) fillA = alpha.weight[li] > 0 ? Math.min(255, Math.max(0, alpha.planes[0][li])) : 0;
      else fillA = known > 0 ? alphaMin : origA;
      const m = hv >= 1 ? 1 : hv;
      // Blend premultiplied so a transparent side does not tint the result.
      const wOrig = origA * (1 - m);
      const wFill = fillA * m;
      const total = wOrig + wFill;
      for (let c = 0; c < 3; c++) {
        const fill = filled ? (c === 0 ? R[li] : c === 1 ? G[li] : B[li]) : src[o + c];
        const v = total > 0 ? (src[o + c] * wOrig + fill * wFill) / total : fill;
        out.data[o + c] = Math.floor(Math.min(255, Math.max(0, v)) + 0.5);
      }
      out.data[o + 3] = Math.floor(total + 0.5);
    }
  }
  return out;
}

export interface ExtendOptions {
  /** Pixels with an alpha of at least this (1..255) are colour sources; the others receive colour (default 1). */
  minAlpha?: number;
}

/**
 * Edge extension (colour bleed): give the transparent pixels within `radius` px of visible pixels
 * the colour of their nearest visible neighbours, WITHOUT changing any alpha. A renderer that
 * interpolates straight (non-premultiplied) RGBA then no longer mixes in the black of invisible
 * pixels at a layer's edge. `radius` counts rings of pixels (default 4; Infinity fills every
 * transparent pixel that can be reached). Returns a new image.
 */
export function extendEdges(img: ImageRGBA, radius = 4, opts: ExtendOptions = {}): ImageRGBA {
  assertImage(img, 'extendEdges');
  const out = cloneImage(img);
  const { width, height } = img;
  const n = width * height;
  const minAlpha = Math.max(1, opts.minAlpha ?? 1);
  const d = out.data;
  // Weight of a pixel as a colour source: its alpha for visible pixels, 1 for pixels filled earlier.
  const weight = new Float32Array(n);
  let visible = 0;
  for (let i = 0; i < n; i++) {
    if (d[i * 4 + 3] >= minAlpha) {
      weight[i] = d[i * 4 + 3] / 255;
      visible++;
    }
  }
  if (visible === 0 || visible === n || !(radius > 0)) return out;

  const queued = new Uint8Array(n);
  let frontier: number[] = [];
  const hasSourceNeighbour = (x: number, y: number): boolean => {
    for (let ny = y > 0 ? y - 1 : y; ny <= (y < height - 1 ? y + 1 : y); ny++) {
      for (let nx = x > 0 ? x - 1 : x; nx <= (x < width - 1 ? x + 1 : x); nx++) {
        if (weight[ny * width + nx] > 0) return true;
      }
    }
    return false;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (weight[i] > 0 || !hasSourceNeighbour(x, y)) continue;
      queued[i] = 1;
      frontier.push(i);
    }
  }

  const colours: number[] = [];
  for (let ring = 0; ring < radius && frontier.length > 0; ring++) {
    // Compute the whole ring from the state before it, then commit: the result does not depend on the scan order.
    colours.length = 0;
    for (const i of frontier) {
      const x = i % width;
      const y = (i - x) / width;
      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;
      for (let ny = y > 0 ? y - 1 : y; ny <= (y < height - 1 ? y + 1 : y); ny++) {
        for (let nx = x > 0 ? x - 1 : x; nx <= (x < width - 1 ? x + 1 : x); nx++) {
          const j = ny * width + nx;
          let wgt = weight[j];
          if (!(wgt > 0)) continue;
          if (nx !== x && ny !== y) wgt *= 0.5; // diagonal neighbours are farther away
          r += d[j * 4] * wgt;
          g += d[j * 4 + 1] * wgt;
          b += d[j * 4 + 2] * wgt;
          total += wgt;
        }
      }
      colours.push(Math.floor(r / total + 0.5), Math.floor(g / total + 0.5), Math.floor(b / total + 0.5));
    }
    const next: number[] = [];
    for (let k = 0; k < frontier.length; k++) {
      const i = frontier[k];
      d[i * 4] = colours[k * 3];
      d[i * 4 + 1] = colours[k * 3 + 1];
      d[i * 4 + 2] = colours[k * 3 + 2];
    }
    for (const i of frontier) weight[i] = 1;
    for (const i of frontier) {
      const x = i % width;
      const y = (i - x) / width;
      for (let ny = y > 0 ? y - 1 : y; ny <= (y < height - 1 ? y + 1 : y); ny++) {
        for (let nx = x > 0 ? x - 1 : x; nx <= (x < width - 1 ? x + 1 : x); nx++) {
          const j = ny * width + nx;
          if (weight[j] > 0 || queued[j]) continue;
          queued[j] = 1;
          next.push(j);
        }
      }
    }
    frontier = next;
  }
  return out;
}
