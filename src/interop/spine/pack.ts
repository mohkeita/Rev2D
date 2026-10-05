/**
 * Deterministic texture atlas packing for the Spine exporter: MaxRects (best short side fit, no
 * rotation) into power-of-two pages no larger than `maxSize`, with `padding` transparent pixels
 * between regions and around the page border. Also page composition and alpha bleeding (straight
 * alpha textures sampled bilinearly by a GPU show dark fringes unless the color of fully transparent
 * texels is copied from their visible neighbours).
 */
import type { ImageRGBA } from '../../core/types.js';

export interface PackItem {
  id: string;
  width: number;
  height: number;
}

export interface PackPlacement {
  id: string;
  page: number;
  /** Top-left of the item's pixels on its page. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PackResult {
  pages: Array<{ width: number; height: number }>;
  /** In input order. */
  placements: PackPlacement[];
}

export interface PackOptions {
  /** Largest page side in px (a power of two is not required, pages are powers of two up to it). */
  maxSize: number;
  /** Transparent pixels between regions and around the border (default 2). */
  padding?: number;
  /** Smallest page side (default 16). */
  minSize?: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** MaxRects bin: free rectangles, best-short-side-fit placement. */
class MaxRectsBin {
  private free: Rect[];
  constructor(width: number, height: number) {
    this.free = [{ x: 0, y: 0, w: width, h: height }];
  }

  /** Place a w x h rect; returns its position or null when it does not fit. */
  insert(w: number, h: number): { x: number; y: number } | null {
    let best: Rect | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    for (const f of this.free) {
      if (f.w < w || f.h < h) continue;
      const short = Math.min(f.w - w, f.h - h);
      const long = Math.max(f.w - w, f.h - h);
      // Ties: top-most, then left-most (deterministic, keeps pages compact toward the origin).
      if (
        short < bestShort ||
        (short === bestShort && (long < bestLong || (long === bestLong && best !== null && (f.y < best.y || (f.y === best.y && f.x < best.x)))))
      ) {
        best = f;
        bestShort = short;
        bestLong = long;
      }
    }
    if (!best) return null;
    const placed: Rect = { x: best.x, y: best.y, w, h };
    this.split(placed);
    return { x: placed.x, y: placed.y };
  }

  private split(used: Rect): void {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (used.x >= f.x + f.w || used.x + used.w <= f.x || used.y >= f.y + f.h || used.y + used.h <= f.y) {
        next.push(f);
        continue;
      }
      if (used.x > f.x) next.push({ x: f.x, y: f.y, w: used.x - f.x, h: f.h });
      if (used.x + used.w < f.x + f.w) next.push({ x: used.x + used.w, y: f.y, w: f.x + f.w - used.x - used.w, h: f.h });
      if (used.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: used.y - f.y });
      if (used.y + used.h < f.y + f.h) next.push({ x: f.x, y: used.y + used.h, w: f.w, h: f.y + f.h - used.y - used.h });
    }
    // Prune rectangles contained in others (keep the first of identical ones).
    this.free = next.filter((a, i) => !next.some((b, j) => j !== i && contains(b, a) && (!contains(a, b) || j < i)));
  }
}

function contains(a: Rect, b: Rect): boolean {
  return b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
}

/** Try to pack every item into one width x height page. Returns positions (by item index) or null. */
function packInto(items: PackItem[], width: number, height: number, pad: number, greedy: boolean): Map<number, { x: number; y: number }> | null {
  const bin = new MaxRectsBin(width - pad, height - pad);
  const out = new Map<number, { x: number; y: number }>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const pos = bin.insert(it.width + pad, it.height + pad);
    if (!pos) {
      if (greedy) continue;
      return null;
    }
    out.set(i, { x: pos.x + pad, y: pos.y + pad });
  }
  return out;
}

function powersOfTwo(min: number, max: number): number[] {
  const out: number[] = [];
  for (let s = min; s <= max; s *= 2) out.push(s);
  if (out[out.length - 1] !== max) out.push(max);
  return out;
}

/**
 * Pack items into as few pages as needed, each the smallest power-of-two size (by area, then by its
 * longer side) that holds its items. Deterministic for the same input. Throws when an item cannot fit
 * a page of `maxSize` even alone.
 */
export function packRects(input: readonly PackItem[], opts: PackOptions): PackResult {
  const pad = opts.padding ?? 2;
  const max = Math.floor(opts.maxSize);
  const min = Math.min(max, Math.max(1, opts.minSize ?? 16));
  for (const it of input) {
    if (!(it.width > 0 && it.height > 0) || !Number.isInteger(it.width) || !Number.isInteger(it.height)) {
      throw new Error(`packRects: item "${it.id}" has invalid size ${it.width}x${it.height}`);
    }
    if (it.width + 2 * pad > max || it.height + 2 * pad > max) {
      throw new Error(`packRects: item "${it.id}" (${it.width}x${it.height}) does not fit a ${max}x${max} page with ${pad} px padding`);
    }
  }
  const order = input
    .map((it, i) => ({ it, i }))
    .sort(
      (a, b) =>
        Math.max(b.it.width, b.it.height) - Math.max(a.it.width, a.it.height) ||
        b.it.width * b.it.height - a.it.width * a.it.height ||
        (a.it.id < b.it.id ? -1 : a.it.id > b.it.id ? 1 : a.i - b.i),
    );
  const sides = powersOfTwo(min, max);
  const sizes: Array<[number, number]> = [];
  for (const w of sides) for (const h of sides) sizes.push([w, h]);
  sizes.sort((a, b) => a[0] * a[1] - b[0] * b[1] || Math.max(...a) - Math.max(...b) || b[0] - a[0]);

  const placements: PackPlacement[] = new Array(input.length);
  const pages: PackResult['pages'] = [];
  let remaining = order;
  while (remaining.length) {
    const items = remaining.map((r) => r.it);
    const area = items.reduce((s, it) => s + (it.width + pad) * (it.height + pad), 0);
    let chosen: { size: [number, number]; pos: Map<number, { x: number; y: number }> } | null = null;
    for (const size of sizes) {
      if (size[0] * size[1] < area) continue;
      const pos = packInto(items, size[0], size[1], pad, false);
      if (pos) {
        chosen = { size, pos };
        break;
      }
    }
    let placedIdx: number[];
    if (chosen) {
      placedIdx = items.map((_, i) => i);
    } else {
      // Fill a full page greedily, then shrink it to the smallest size that holds the same items.
      const full = packInto(items, max, max, pad, true)!;
      placedIdx = [...full.keys()];
      const subset = placedIdx.map((i) => items[i]);
      const subArea = subset.reduce((s, it) => s + (it.width + pad) * (it.height + pad), 0);
      for (const size of sizes) {
        if (size[0] * size[1] < subArea) continue;
        const pos = packInto(subset, size[0], size[1], pad, false);
        if (pos) {
          chosen = { size, pos: new Map([...pos].map(([k, v]) => [placedIdx[k], v])) };
          break;
        }
      }
      chosen ??= { size: [max, max], pos: full };
    }
    const page = pages.length;
    pages.push({ width: chosen.size[0], height: chosen.size[1] });
    for (const i of placedIdx) {
      const { it, i: original } = remaining[i];
      const p = chosen.pos.get(i)!;
      placements[original] = { id: it.id, page, x: p.x, y: p.y, width: it.width, height: it.height };
    }
    const placed = new Set(placedIdx);
    remaining = remaining.filter((_, i) => !placed.has(i));
  }
  return { pages, placements };
}

/** Copy images onto transparent pages at their placements (no blending). */
export function composePages(result: PackResult, images: ReadonlyMap<string, ImageRGBA>): ImageRGBA[] {
  const pages = result.pages.map((p) => ({ width: p.width, height: p.height, data: new Uint8ClampedArray(p.width * p.height * 4) }));
  for (const pl of result.placements) {
    const img = images.get(pl.id);
    if (!img) throw new Error(`composePages: no image for "${pl.id}"`);
    const page = pages[pl.page];
    for (let y = 0; y < img.height; y++) {
      const src = img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4);
      page.data.set(src, ((pl.y + y) * page.width + pl.x) * 4);
    }
  }
  return pages;
}

/** Premultiplied copy of a straight-alpha image (rgb × alpha, rounded). */
export function premultiply(img: ImageRGBA): ImageRGBA {
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 255) continue;
    data[i] = Math.round((data[i] * a) / 255);
    data[i + 1] = Math.round((data[i + 1] * a) / 255);
    data[i + 2] = Math.round((data[i + 2] * a) / 255);
  }
  return { width: img.width, height: img.height, data };
}

/**
 * Alpha bleeding: fully transparent texels next to visible ones take the average color of those
 * neighbours (repeated `passes` times, growing outwards), alpha stays 0. Invisible in straight-alpha
 * rendering except where bilinear filtering mixes texels, where it removes dark fringes.
 */
export function bleedAlpha(img: ImageRGBA, passes = 4): ImageRGBA {
  const { width: w, height: h } = img;
  const data = new Uint8ClampedArray(img.data);
  // 0 = transparent without color yet, 1 = has color (visible or already bled).
  let known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = data[i * 4 + 3] > 0 ? 1 : 0;
  for (let pass = 0; pass < passes; pass++) {
    const next = known.slice();
    let changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx === 0 && dy === 0) || xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!known[j]) continue;
            r += data[j * 4];
            g += data[j * 4 + 1];
            b += data[j * 4 + 2];
            n++;
          }
        }
        if (n === 0) continue;
        data[i * 4] = Math.round(r / n);
        data[i * 4 + 1] = Math.round(g / n);
        data[i * 4 + 2] = Math.round(b / n);
        next[i] = 1;
        changed = true;
      }
    }
    known = next;
    if (!changed) break;
  }
  return { width: w, height: h, data };
}
