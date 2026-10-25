/**
 * Deterministic software rasterizer for RenderLists (pure TypeScript, browser-safe).
 *
 * 1. Setup space maps to a supersampled framebuffer: X = (x - viewBox.x) * scale * ss.
 *    The framebuffer holds premultiplied RGBA as Float32.
 * 2. Triangles use snapped fixed-point coordinates (1/256 sample) and integer edge functions with
 *    the top-left fill rule at sample centers (+0.5). Every sample on an edge shared by two triangles
 *    belongs to exactly one of them: no seams, no double blending. Both windings are accepted.
 * 3. Vertex colors (premultiplied) and uvs are interpolated with barycentric (affine) weights;
 *    textures are premultiplied and then sampled bilinearly with clamp-to-edge (no dark fringes).
 * 4. Blend modes are applied in premultiplied space. Masks multiply the source by the union alpha
 *    coverage of the mask items (or its complement for maskInvert). A present but empty `masks` list
 *    is zero coverage: the item is not drawn (drawn unclipped with maskInvert).
 * 5. The framebuffer is box-filtered down by ss x ss and un-premultiplied to straight RGBA8.
 */
import type { BlendMode, DrawItem, ImageRGBA, RenderList, RGBA } from '../core/types.js';
import { assertImage } from './image.js';
import type { RasterWorkspace, RasterTexture as PremulTexture } from './workspace.js';

export interface RenderOptions {
  /** Region of setup space to render [x, y, w, h]. Default [0, 0, list.width, list.height]. */
  viewBox?: [number, number, number, number];
  /** Output pixels per setup unit. Default 1. */
  scale?: number;
  /** Background override (null = list.background). */
  background?: RGBA | null;
  /** Supersampling factor per axis (1..4). Default 2. */
  supersample?: number;
  /** Optional reusable scratch framebuffer for sequential rendering. Outputs remain independent. */
  workspace?: RasterWorkspace;
}

const SUBPIXEL = 256;
const HALF = SUBPIXEL / 2;
const DEFAULT_SUPERSAMPLE = 2;
const MAX_SUPERSAMPLE = 4;
/** Upper bound on framebuffer samples (Float32 RGBA -> 16 bytes each, i.e. 1 GiB). */
const MAX_SAMPLES = 1 << 26;

const NORMAL = 0;
const ADD = 1;
const MULTIPLY = 2;
const SCREEN = 3;
const BLEND_CODES: Record<BlendMode, number> = { normal: NORMAL, add: ADD, multiply: MULTIPLY, screen: SCREEN };

/** Rasterize a render list. Textures are decoded RGBA images keyed by texture id. */
export function renderImage(
  list: RenderList,
  textures: Record<string, ImageRGBA>,
  opts: RenderOptions = {},
): ImageRGBA {
  const vb = opts.viewBox ?? [0, 0, list.width, list.height];
  const scale = opts.scale ?? 1;
  if (!vb.every(Number.isFinite) || !(vb[2] > 0) || !(vb[3] > 0)) {
    throw new RangeError(`renderImage: invalid viewBox [${vb.join(', ')}] (need finite x, y and positive w, h)`);
  }
  if (!(scale > 0) || !Number.isFinite(scale)) {
    throw new RangeError(`renderImage: scale must be a positive number, got ${scale}`);
  }
  const ss = resolveSupersample(opts.supersample);
  const width = Math.round(vb[2] * scale);
  const height = Math.round(vb[3] * scale);
  if (width < 1 || height < 1) {
    throw new RangeError(
      `renderImage: output would be ${width}x${height} px (viewBox ${vb[2]}x${vb[3]} at scale ${scale})`,
    );
  }
  if (width * height * ss * ss > MAX_SAMPLES) {
    throw new RangeError(
      `renderImage: ${width}x${height} px at supersample ${ss} exceeds ${MAX_SAMPLES} samples; lower scale or supersample`,
    );
  }
  const raster = new Rasterizer(width * ss, height * ss, vb[0], vb[1], scale * ss, textures, opts.workspace);
  raster.clear(opts.background ?? list.background);
  for (const item of list.draws) raster.draw(item);
  return raster.resolve(ss);
}

function resolveSupersample(v: number | undefined): number {
  if (v === undefined) return DEFAULT_SUPERSAMPLE;
  if (!Number.isFinite(v)) {
    throw new RangeError(`renderImage: supersample must be a number in 1..${MAX_SUPERSAMPLE}, got ${v}`);
  }
  return Math.min(MAX_SUPERSAMPLE, Math.max(1, Math.round(v)));
}

// ------------------------------------------------------------------------------------ triangles

/** Pixel-index clip rectangle, [x0, x1) x [y0, y1). */
interface Clip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * One horizontal run of covered samples, reused across calls. w0..w2 are the barycentric numerators
 * (integer edge-function values) at sample x0, d0..d2 their per-sample steps; weight_i = w_i * invArea.
 */
interface Span {
  y: number;
  x0: number;
  x1: number;
  w0: number;
  w1: number;
  w2: number;
  d0: number;
  d1: number;
  d2: number;
  invArea: number;
  /** Vertex indices in (normalized) winding order, matching w0..w2. */
  i0: number;
  i1: number;
  i2: number;
}

function newSpan(): Span {
  return { y: 0, x0: 0, x1: 0, w0: 0, w1: 0, w2: 0, d0: 0, d1: 0, d2: 0, invArea: 0, i0: 0, i1: 0, i2: 0 };
}

/** Edge a->b owns samples exactly on it when it is a top edge (horizontal, pointing +x) or a left edge (pointing -y). */
function edgeBias(ax: number, ay: number, bx: number, by: number): number {
  const dy = by - ay;
  return dy < 0 || (dy === 0 && bx - ax > 0) ? 0 : -1;
}

/**
 * Rasterize triangle (a, b, c) given snapped sample coordinates (units of 1/SUBPIXEL sample).
 * Calls `emit` once per non-empty row span. Edge values are exact integers (products of snapped
 * coordinates stay far below 2^53 for any sane scene), which is what makes the fill rule exact.
 */
function rasterizeTriangle(
  xs: Float64Array,
  ys: Float64Array,
  a: number,
  b: number,
  c: number,
  clip: Clip,
  s: Span,
  emit: (s: Span) => void,
): void {
  const x0 = xs[a];
  const y0 = ys[a];
  let x1 = xs[b];
  let y1 = ys[b];
  let x2 = xs[c];
  let y2 = ys[c];
  if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1))) return;
  if (!(Number.isFinite(x2) && Number.isFinite(y2))) return;
  let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
  if (area === 0) return;
  if (area < 0) {
    // Normalize to clockwise-on-screen (y down) so "inside" means all edge values >= 0.
    [x1, x2] = [x2, x1];
    [y1, y2] = [y2, y1];
    [b, c] = [c, b];
    area = -area;
  }
  const px0 = Math.max(clip.x0, Math.ceil((Math.min(x0, x1, x2) - HALF) / SUBPIXEL));
  const px1 = Math.min(clip.x1 - 1, Math.floor((Math.max(x0, x1, x2) - HALF) / SUBPIXEL));
  const py0 = Math.max(clip.y0, Math.ceil((Math.min(y0, y1, y2) - HALF) / SUBPIXEL));
  const py1 = Math.min(clip.y1 - 1, Math.floor((Math.max(y0, y1, y2) - HALF) / SUBPIXEL));
  if (px0 > px1 || py0 > py1) return;

  // Edge i is opposite vertex i: e0 = v1->v2, e1 = v2->v0, e2 = v0->v1.
  // w(p) = (bx - ax) * (py - ay) - (by - ay) * (px - ax); a +1 sample step in x adds -(by - ay) * SUBPIXEL.
  const d0 = -(y2 - y1) * SUBPIXEL;
  const d1 = -(y0 - y2) * SUBPIXEL;
  const d2 = -(y1 - y0) * SUBPIXEL;
  const bias0 = edgeBias(x1, y1, x2, y2);
  const bias1 = edgeBias(x2, y2, x0, y0);
  const bias2 = edgeBias(x0, y0, x1, y1);
  const cx = px0 * SUBPIXEL + HALF;
  const last = px1 - px0;
  s.invArea = 1 / area;
  s.i0 = a;
  s.i1 = b;
  s.i2 = c;
  s.d0 = d0;
  s.d1 = d1;
  s.d2 = d2;
  for (let py = py0; py <= py1; py++) {
    const cy = py * SUBPIXEL + HALF;
    const w0 = (x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1);
    const w1 = (x0 - x2) * (cy - y2) - (y0 - y2) * (cx - x2);
    const w2 = (x1 - x0) * (cy - y0) - (y1 - y0) * (cx - x0);
    // Solve w + bias + d * t >= 0 for the sample offset t in [0, last], per edge. Operands are exact
    // integers, so ceil/floor of the quotient are exact too.
    let lo = 0;
    let hi = last;
    const v0 = w0 + bias0;
    const v1 = w1 + bias1;
    const v2 = w2 + bias2;
    if (d0 > 0) lo = Math.max(lo, Math.ceil(-v0 / d0));
    else if (d0 < 0) hi = Math.min(hi, Math.floor(v0 / -d0));
    else if (v0 < 0) continue;
    if (d1 > 0) lo = Math.max(lo, Math.ceil(-v1 / d1));
    else if (d1 < 0) hi = Math.min(hi, Math.floor(v1 / -d1));
    else if (v1 < 0) continue;
    if (d2 > 0) lo = Math.max(lo, Math.ceil(-v2 / d2));
    else if (d2 < 0) hi = Math.min(hi, Math.floor(v2 / -d2));
    else if (v2 < 0) continue;
    if (lo > hi) continue;
    s.y = py;
    s.x0 = px0 + lo;
    s.x1 = px0 + hi;
    s.w0 = w0 + d0 * lo;
    s.w1 = w1 + d1 * lo;
    s.w2 = w2 + d2 * lo;
    emit(s);
  }
}

// ------------------------------------------------------------------------------------ textures

/** Texture with premultiplied Float32 texels. */
function premultiplyTexture(img: ImageRGBA): PremulTexture {
  const n = img.width * img.height;
  const data = new Float32Array(n * 4);
  const src = img.data;
  for (let i = 0; i < n * 4; i += 4) {
    const a = src[i + 3] / 255;
    data[i] = (src[i] / 255) * a;
    data[i + 1] = (src[i + 1] / 255) * a;
    data[i + 2] = (src[i + 2] / 255) * a;
    data[i + 3] = a;
  }
  return { width: img.width, height: img.height, data };
}

/** Bilinear, clamp-to-edge sample of premultiplied texels at uv (0..1 spans the texture edges) into out[0..3]. */
function sampleBilinear(t: PremulTexture, u: number, v: number, out: Float64Array): void {
  const w = t.width;
  const h = t.height;
  let x = u * w - 0.5;
  let y = v * h - 0.5;
  x = x < -0.5 ? -0.5 : x > w - 0.5 ? w - 0.5 : x;
  y = y < -0.5 ? -0.5 : y > h - 0.5 ? h - 0.5 : y;
  const fx0 = Math.floor(x);
  const fy0 = Math.floor(y);
  const fx = x - fx0;
  const fy = y - fy0;
  const xa = fx0 < 0 ? 0 : fx0;
  const xb = fx0 + 1 >= w ? w - 1 : fx0 + 1;
  const ya = (fy0 < 0 ? 0 : fy0) * w;
  const yb = (fy0 + 1 >= h ? h - 1 : fy0 + 1) * w;
  const d = t.data;
  const i00 = (ya + xa) * 4;
  const i10 = (ya + xb) * 4;
  const i01 = (yb + xa) * 4;
  const i11 = (yb + xb) * 4;
  const k00 = (1 - fx) * (1 - fy);
  const k10 = fx * (1 - fy);
  const k01 = (1 - fx) * fy;
  const k11 = fx * fy;
  out[0] = d[i00] * k00 + d[i10] * k10 + d[i01] * k01 + d[i11] * k11;
  out[1] = d[i00 + 1] * k00 + d[i10 + 1] * k10 + d[i01 + 1] * k01 + d[i11 + 1] * k11;
  out[2] = d[i00 + 2] * k00 + d[i10 + 2] * k10 + d[i01 + 2] * k01 + d[i11 + 2] * k11;
  out[3] = d[i00 + 3] * k00 + d[i10 + 3] * k10 + d[i01 + 3] * k01 + d[i11 + 3] * k11;
}

// ------------------------------------------------------------------------------------ draw items

/** Per-item data prepared for shading: snapped positions, premultiplied colors, sanitized uvs. */
interface PreparedItem {
  xs: Float64Array;
  ys: Float64Array;
  /** Premultiplied RGBA per vertex, clamped to 0..1. */
  colors: Float64Array;
  uvs: Float64Array | null;
  texture: PremulTexture | null;
  indices: Uint32Array;
}

function itemName(item: DrawItem): string {
  return `draw "${item.partId}" (${item.kind})`;
}

function finiteOr0(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

class Rasterizer {
  private readonly data: Float32Array;
  private readonly full: Clip;
  private readonly span = newSpan();
  private readonly texel = new Float64Array(4);
  private readonly textureCache = new Map<string, PremulTexture>();

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly originX: number,
    private readonly originY: number,
    /** Framebuffer samples per setup unit. */
    private readonly k: number,
    private readonly textures: Record<string, ImageRGBA>,
    private readonly workspace?: RasterWorkspace,
  ) {
    this.data = workspace?.framebuffer(width * height * 4) ?? new Float32Array(width * height * 4);
    this.full = { x0: 0, y0: 0, x1: width, y1: height };
  }

  clear(bg: RGBA): void {
    const a = clamp01(bg[3]);
    const r = clamp01(bg[0]) * a;
    const g = clamp01(bg[1]) * a;
    const b = clamp01(bg[2]) * a;
    if (r === 0 && g === 0 && b === 0 && a === 0) {
      this.data.fill(0);
      return;
    }
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a;
    }
  }

  draw(item: DrawItem): void {
    const p = this.prepare(item);
    if (p.indices.length < 3) return;
    const invert = item.maskInvert === true;
    let clip = this.full;
    let coverage: Float32Array | null = null;
    // A present `masks` list clips even when empty: the union of no geometry covers nothing, so the item
    // draws nowhere (everywhere with maskInvert). Only an absent list means "unmasked".
    if (item.masks) {
      if (item.masks.length === 0) {
        if (!invert) return;
      } else {
        // Masks only matter where the item itself can draw: restrict work to its bounding box.
        const box = this.bounds(p);
        if (!box) return;
        clip = box;
        coverage = this.maskCoverage(item.masks, box);
      }
    }
    this.fill(p, BLEND_CODES[item.blend] ?? NORMAL, clip, coverage, invert);
  }

  private prepare(item: DrawItem): PreparedItem {
    const n = Math.floor(item.positions.length / 2);
    if (item.colors.length < n * 4) {
      throw new RangeError(
        `renderImage: ${itemName(item)} has ${item.colors.length} color floats for ${n} vertices (need ${n * 4})`,
      );
    }
    const count = item.indices.length - (item.indices.length % 3);
    for (let i = 0; i < count; i++) {
      if (item.indices[i] >= n) {
        throw new RangeError(`renderImage: ${itemName(item)} index ${item.indices[i]} is out of range (${n} vertices)`);
      }
    }
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const unit = this.k * SUBPIXEL;
    for (let i = 0; i < n; i++) {
      // Non-finite results stay non-finite; triangles touching them are skipped.
      xs[i] = Math.round((item.positions[i * 2] - this.originX) * unit);
      ys[i] = Math.round((item.positions[i * 2 + 1] - this.originY) * unit);
    }
    const colors = new Float64Array(n * 4);
    for (let i = 0; i < n * 4; i += 4) {
      const a = clamp01(item.colors[i + 3]);
      colors[i] = clamp01(item.colors[i]) * a;
      colors[i + 1] = clamp01(item.colors[i + 1]) * a;
      colors[i + 2] = clamp01(item.colors[i + 2]) * a;
      colors[i + 3] = a;
    }
    let texture: PremulTexture | null = null;
    let uvs: Float64Array | null = null;
    if (item.texture !== undefined) {
      texture = this.texture(item.texture, item);
      if (!item.uvs || item.uvs.length < n * 2) {
        throw new RangeError(
          `renderImage: ${itemName(item)} samples texture "${item.texture}" but has no uv per vertex`,
        );
      }
      uvs = new Float64Array(n * 2);
      for (let i = 0; i < n * 2; i++) uvs[i] = finiteOr0(item.uvs[i]);
    }
    return { xs, ys, colors, uvs, texture, indices: item.indices.subarray(0, count) };
  }

  private texture(id: string, item: DrawItem): PremulTexture {
    let t = this.textureCache.get(id);
    if (!t) {
      // Own properties only: texture ids like "constructor" are valid and must not hit Object.prototype.
      const img = Object.hasOwn(this.textures, id) ? this.textures[id] : undefined;
      if (!img) throw new Error(`renderImage: ${itemName(item)} uses texture "${id}", which was not provided`);
      assertImage(img, `renderImage: texture "${id}"`);
      if (img.width === 0 || img.height === 0) throw new RangeError(`renderImage: texture "${id}" is empty`);
      t = this.workspace?.texture(img, () => premultiplyTexture(img)) ?? premultiplyTexture(img);
      this.textureCache.set(id, t);
    }
    return t;
  }

  /** Sample-space bounding box of the item's vertices, clipped to the framebuffer; null if empty. */
  private bounds(p: PreparedItem): Clip | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < p.xs.length; i++) {
      const x = p.xs[i];
      const y = p.ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const clip: Clip = {
      x0: Math.max(0, Math.floor(minX / SUBPIXEL)),
      y0: Math.max(0, Math.floor(minY / SUBPIXEL)),
      x1: Math.min(this.width, Math.ceil(maxX / SUBPIXEL)),
      y1: Math.min(this.height, Math.ceil(maxY / SUBPIXEL)),
    };
    return clip.x0 < clip.x1 && clip.y0 < clip.y1 ? clip : null;
  }

  /** Union alpha coverage (vertex alpha x texel alpha) of the mask items over `box`: c = c + a - c*a. */
  private maskCoverage(masks: DrawItem[], box: Clip): Float32Array {
    const bw = box.x1 - box.x0;
    const cov = new Float32Array(bw * (box.y1 - box.y0));
    const texel = this.texel;
    for (const mask of masks) {
      const m = this.prepare(mask);
      const { colors, uvs, texture } = m;
      const emit = (s: Span): void => {
        const inv = s.invArea;
        const a0 = s.i0 * 4 + 3;
        const a1 = s.i1 * 4 + 3;
        const a2 = s.i2 * 4 + 3;
        let w0 = s.w0;
        let w1 = s.w1;
        let w2 = s.w2;
        let o = (s.y - box.y0) * bw + (s.x0 - box.x0);
        for (let x = s.x0; x <= s.x1; x++, o++) {
          const l0 = w0 * inv;
          const l1 = w1 * inv;
          const l2 = w2 * inv;
          w0 += s.d0;
          w1 += s.d1;
          w2 += s.d2;
          let a = l0 * colors[a0] + l1 * colors[a1] + l2 * colors[a2];
          if (texture && uvs) {
            const u = l0 * uvs[s.i0 * 2] + l1 * uvs[s.i1 * 2] + l2 * uvs[s.i2 * 2];
            const v = l0 * uvs[s.i0 * 2 + 1] + l1 * uvs[s.i1 * 2 + 1] + l2 * uvs[s.i2 * 2 + 1];
            sampleBilinear(texture, u, v, texel);
            a *= texel[3];
          }
          if (!(a > 0)) continue;
          if (a > 1) a = 1;
          const c = cov[o];
          cov[o] = c + a - c * a;
        }
      };
      this.triangles(m, box, emit);
    }
    return cov;
  }

  private fill(p: PreparedItem, mode: number, clip: Clip, coverage: Float32Array | null, invert: boolean): void {
    const { colors, uvs, texture } = p;
    const fb = this.data;
    const stride = this.width;
    const cw = clip.x1 - clip.x0;
    const texel = this.texel;
    const emit = (s: Span): void => {
      const inv = s.invArea;
      const c0 = s.i0 * 4;
      const c1 = s.i1 * 4;
      const c2 = s.i2 * 4;
      let w0 = s.w0;
      let w1 = s.w1;
      let w2 = s.w2;
      let o = (s.y * stride + s.x0) * 4;
      let m = (s.y - clip.y0) * cw + (s.x0 - clip.x0);
      for (let x = s.x0; x <= s.x1; x++, o += 4, m++) {
        const l0 = w0 * inv;
        const l1 = w1 * inv;
        const l2 = w2 * inv;
        w0 += s.d0;
        w1 += s.d1;
        w2 += s.d2;
        let r = l0 * colors[c0] + l1 * colors[c1] + l2 * colors[c2];
        let g = l0 * colors[c0 + 1] + l1 * colors[c1 + 1] + l2 * colors[c2 + 1];
        let b = l0 * colors[c0 + 2] + l1 * colors[c1 + 2] + l2 * colors[c2 + 2];
        let a = l0 * colors[c0 + 3] + l1 * colors[c1 + 3] + l2 * colors[c2 + 3];
        if (texture && uvs) {
          const u = l0 * uvs[s.i0 * 2] + l1 * uvs[s.i1 * 2] + l2 * uvs[s.i2 * 2];
          const v = l0 * uvs[s.i0 * 2 + 1] + l1 * uvs[s.i1 * 2 + 1] + l2 * uvs[s.i2 * 2 + 1];
          sampleBilinear(texture, u, v, texel);
          r *= texel[0];
          g *= texel[1];
          b *= texel[2];
          a *= texel[3];
        }
        if (coverage) {
          const k = invert ? 1 - coverage[m] : coverage[m];
          r *= k;
          g *= k;
          b *= k;
          a *= k;
        }
        // Premultiplied: a <= 0 implies r = g = b = 0, which leaves dst unchanged in every mode.
        if (!(a > 0)) continue;
        blend(fb, o, r, g, b, a > 1 ? 1 : a, mode);
      }
    };
    this.triangles(p, clip, emit);
  }

  private triangles(p: PreparedItem, clip: Clip, emit: (s: Span) => void): void {
    const idx = p.indices;
    for (let t = 0; t < idx.length; t += 3) {
      rasterizeTriangle(p.xs, p.ys, idx[t], idx[t + 1], idx[t + 2], clip, this.span, emit);
    }
  }

  /** Box-filter ss x ss samples per pixel and convert premultiplied float to straight RGBA8. */
  resolve(ss: number): ImageRGBA {
    const width = this.width / ss;
    const height = this.height / ss;
    const out = new Uint8ClampedArray(width * height * 4);
    const d = this.data;
    const count = ss * ss;
    for (let oy = 0; oy < height; oy++) {
      for (let ox = 0; ox < width; ox++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < ss; sy++) {
          let i = ((oy * ss + sy) * this.width + ox * ss) * 4;
          for (let sx = 0; sx < ss; sx++, i += 4) {
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
            a += d[i + 3];
          }
        }
        // Divisions (not reciprocal multiplies) keep exact averages exact, e.g. nine 0.5 samples -> 0.5.
        const a8 = Math.round(clamp01(a / count) * 255);
        if (a8 === 0) continue;
        const o = (oy * width + ox) * 4;
        out[o] = Math.round(clamp01(r / a) * 255);
        out[o + 1] = Math.round(clamp01(g / a) * 255);
        out[o + 2] = Math.round(clamp01(b / a) * 255);
        out[o + 3] = a8;
      }
    }
    return { width, height, data: out };
  }
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/** Composite premultiplied source (r, g, b, a) onto the premultiplied framebuffer sample at `o`. */
function blend(d: Float32Array, o: number, r: number, g: number, b: number, a: number, mode: number): void {
  const dr = d[o];
  const dg = d[o + 1];
  const db = d[o + 2];
  const da = d[o + 3];
  switch (mode) {
    case ADD:
      d[o] = Math.min(1, r + dr);
      d[o + 1] = Math.min(1, g + dg);
      d[o + 2] = Math.min(1, b + db);
      d[o + 3] = Math.min(1, a + da);
      return;
    case MULTIPLY: {
      const ks = 1 - da;
      const kd = 1 - a;
      d[o] = r * dr + r * ks + dr * kd;
      d[o + 1] = g * dg + g * ks + dg * kd;
      d[o + 2] = b * db + b * ks + db * kd;
      d[o + 3] = a * da + a * ks + da * kd;
      return;
    }
    case SCREEN:
      d[o] = r + dr - r * dr;
      d[o + 1] = g + dg - g * dg;
      d[o + 2] = b + db - b * db;
      d[o + 3] = a + da - a * da;
      return;
    default: {
      const k = 1 - a;
      d[o] = r + dr * k;
      d[o + 1] = g + dg * k;
      d[o + 2] = b + db * k;
      d[o + 3] = a + da * k;
    }
  }
}
