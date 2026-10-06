/**
 * Region analysis on masks: connected components (labels, areas, bounding boxes), keeping the
 * largest component, dropping small ones, filling holes, and region growing from seed pixels by
 * colour similarity.
 *
 * Components are formed by the pixels whose value is >= `threshold` (default 0.5). With
 * 8-connectivity (the default) pixels that touch at a corner belong together.
 */
import { writeLab, type LabImage } from './color.js';
import { assertSameSize, cloneMask, createMask } from './mask.js';
import type { ImageRGBA, Lab, Mask, Points, Rect } from './types.js';

export interface ComponentOptions {
  /** 8 (default): diagonal neighbours connect; 4: only edge neighbours. */
  connectivity?: 4 | 8;
  /** Pixels with a value >= threshold are "set" (default 0.5). */
  threshold?: number;
}

export interface ComponentInfo {
  /** The value of this component's pixels in `labels` (1-based). */
  label: number;
  /** Number of pixels. */
  area: number;
  /** Whole-pixel bounding box. */
  bounds: Rect;
}

export interface Components {
  width: number;
  height: number;
  /** Per pixel: 0 = background, otherwise the component's label. */
  labels: Int32Array;
  /** Number of components. */
  count: number;
  /** components[label - 1], in the order their first pixel appears (top to bottom, left to right). */
  components: ComponentInfo[];
}

/** Label the connected groups of `set` pixels (non-zero bytes). */
function labelPixels(set: Uint8Array, width: number, height: number, connectivity: 4 | 8): Components {
  const labels = new Int32Array(width * height);
  const components: ComponentInfo[] = [];
  const stack = new Int32Array(width * height);
  const eight = connectivity === 8;
  for (let start = 0; start < set.length; start++) {
    if (!set[start] || labels[start]) continue;
    const label = components.length + 1;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let area = 0;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top > 0) {
      const i = stack[--top];
      const x = i % width;
      const y = (i - x) / width;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const y0 = y > 0 ? y - 1 : y;
      const y1 = y < height - 1 ? y + 1 : y;
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < width - 1 ? x + 1 : x;
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          if (!eight && nx !== x && ny !== y) continue;
          const j = ny * width + nx;
          if (set[j] && !labels[j]) {
            labels[j] = label;
            stack[top++] = j;
          }
        }
      }
    }
    components.push({ label, area, bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } });
  }
  return { width, height, labels, count: components.length, components };
}

function binarize(mask: Mask, threshold: number, invert = false): Uint8Array {
  const set = new Uint8Array(mask.data.length);
  const d = mask.data;
  for (let i = 0; i < d.length; i++) set[i] = d[i] >= threshold !== invert ? 1 : 0;
  return set;
}

/** Connected components of a mask: a label per pixel plus the area and bounding box of every component. */
export function connectedComponents(mask: Mask, opts: ComponentOptions = {}): Components {
  return labelPixels(binarize(mask, opts.threshold ?? 0.5), mask.width, mask.height, opts.connectivity ?? 8);
}

/**
 * Keep the components `keep` accepts and clear the rest. Pixels below the threshold (soft rims)
 * survive only where they touch a kept component, so antialiased edges stay intact.
 */
function filterComponents(mask: Mask, opts: ComponentOptions, choose: (all: ComponentInfo[]) => (info: ComponentInfo) => boolean): Mask {
  const found = connectedComponents(mask, opts);
  const keep = choose(found.components);
  const kept = new Uint8Array(found.count + 1);
  for (const c of found.components) kept[c.label] = keep(c) ? 1 : 0;
  const { width, height } = mask;
  const out = createMask(width, height);
  const labels = found.labels;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const v = mask.data[i];
      if (!(v > 0)) continue;
      if (labels[i]) {
        if (kept[labels[i]]) out.data[i] = v;
        continue;
      }
      let touches = false;
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1) && !touches; ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
          if (kept[labels[ny * width + nx]]) {
            touches = true;
            break;
          }
        }
      }
      if (touches) out.data[i] = v;
    }
  }
  return out;
}

/**
 * The mask with only its largest connected component (by pixel count; the first one found wins a
 * tie). Soft rim pixels below the threshold are kept where they touch it.
 */
export function keepLargestComponent(mask: Mask, opts: ComponentOptions = {}): Mask {
  return filterComponents(mask, opts, (all) => {
    let best: ComponentInfo | null = null;
    for (const c of all) if (!best || c.area > best.area) best = c;
    return (c) => c === best;
  });
}

/** The mask without the components smaller than `minArea` pixels (specks). */
export function removeSmallComponents(mask: Mask, minArea: number, opts: ComponentOptions = {}): Mask {
  return filterComponents(mask, opts, () => (c) => c.area >= minArea);
}

export interface FillHolesOptions extends ComponentOptions {
  /** Only holes of at most this many pixels are filled (default: every hole). */
  maxArea?: number;
}

/**
 * Fill the holes of a mask: background regions (value < threshold) that are not connected to the
 * image border become 1. `connectivity` describes the foreground; the background uses the
 * complementary rule (a diagonal gap in an 8-connected outline does not leak).
 */
export function fillHoles(mask: Mask, opts: FillHolesOptions = {}): Mask {
  const { width, height } = mask;
  const background = labelPixels(binarize(mask, opts.threshold ?? 0.5, true), width, height, (opts.connectivity ?? 8) === 8 ? 4 : 8);
  const maxArea = opts.maxArea ?? Infinity;
  const fill = new Uint8Array(background.count + 1);
  for (const c of background.components) {
    const b = c.bounds;
    const touchesBorder = b.x === 0 || b.y === 0 || b.x + b.width === width || b.y + b.height === height;
    fill[c.label] = !touchesBorder && c.area <= maxArea ? 1 : 0;
  }
  const out = cloneMask(mask);
  for (let i = 0; i < out.data.length; i++) if (fill[background.labels[i]]) out.data[i] = 1;
  return out;
}

export interface GrowOptions {
  /**
   * Largest colour difference (deltaE in Lab) between a pixel and the nearest reference colour.
   * Infinity disables the colour test (the region is then bounded by `limit`, `maxStep` and alpha).
   */
  tolerance: number;
  /** Reference colours in Lab (e.g. the dominant colours of the hair). Default: the mean colour of the seed pixels. */
  references?: Lab[];
  /** Largest colour difference between two neighbouring pixels the region may step across (default Infinity: no edge test). */
  maxStep?: number;
  /** The region never leaves the pixels where this mask is >= 0.5. */
  limit?: Mask;
  /** 4 (default): the region spreads through edge neighbours only, so it does not slip through diagonal gaps; 8: also diagonally. */
  connectivity?: 4 | 8;
  /** Pixels with an alpha below this (0..255) never join (default 1: fully transparent pixels are excluded). */
  minAlpha?: number;
}

/**
 * Region growing: starting from the seed pixels, add every connected pixel that is acceptable.
 * A pixel is acceptable when it lies inside `limit`, is not transparent and its colour is within
 * `tolerance` of the nearest reference colour; with `maxStep` it must also differ by at most that
 * much from the neighbour it is reached from. Seeds must be acceptable themselves (a seed stroke
 * that crosses another colour does not drag it in).
 *
 * `seeds` is a mask (pixels >= 0.5) or a flat point list [x0, y0, ...] in pixels. Pass a LabImage
 * (imageToLab) when growing several regions on one image. Returns a binary mask (0 / 1).
 */
export function growRegion(image: ImageRGBA | LabImage, seeds: Mask | Points, opts: GrowOptions): Mask {
  const { width, height } = image;
  const n = width * height;
  const out = createMask(width, height);
  if (opts.limit) assertSameSize(image, opts.limit, 'growRegion');
  const limit = opts.limit ? opts.limit.data : null;
  const minAlpha = opts.minAlpha ?? 1;
  if (!(opts.tolerance >= 0)) throw new RangeError(`growRegion: tolerance must be a number >= 0, got ${opts.tolerance}`);
  const maxStep2 = Math.max(0, opts.maxStep ?? Infinity) ** 2;
  const tol2 = opts.tolerance ** 2;

  // Lab values: taken from a LabImage, or converted pixel by pixel on demand.
  const pre = 'lab' in image ? image : null;
  const lab = pre ? pre.lab : new Float32Array(n * 3);
  const rgba = pre ? null : (image as ImageRGBA).data;
  const converted = pre ? null : new Uint8Array(n);
  const alphaOf = (i: number): number => (pre ? pre.alpha[i] : (rgba as Uint8ClampedArray)[i * 4 + 3]);
  const need = (i: number): void => {
    if (converted && !converted[i]) {
      writeLab(rgba as Uint8ClampedArray, i * 4, lab, i * 3);
      converted[i] = 1;
    }
  };

  // Seed pixels, in raster order.
  const seedList: number[] = [];
  if ('data' in seeds && 'width' in seeds) {
    assertSameSize(image, seeds, 'growRegion');
    for (let i = 0; i < n; i++) if (seeds.data[i] >= 0.5) seedList.push(i);
  } else {
    const flags = new Uint8Array(n);
    for (let k = 0; k + 1 < seeds.length; k += 2) {
      const x = Math.floor(seeds[k]);
      const y = Math.floor(seeds[k + 1]);
      if (x >= 0 && y >= 0 && x < width && y < height) flags[y * width + x] = 1;
    }
    for (let i = 0; i < n; i++) if (flags[i]) seedList.push(i);
  }
  const usable = (i: number): boolean => (!limit || limit[i] >= 0.5) && alphaOf(i) >= minAlpha;

  let refs: Float64Array;
  if (opts.references) {
    refs = new Float64Array(opts.references.length * 3);
    opts.references.forEach((c, k) => refs.set(c, k * 3));
  } else {
    const sum = [0, 0, 0];
    let count = 0;
    for (const i of seedList) {
      if (!usable(i)) continue;
      need(i);
      sum[0] += lab[i * 3];
      sum[1] += lab[i * 3 + 1];
      sum[2] += lab[i * 3 + 2];
      count++;
    }
    if (count === 0) return out;
    refs = new Float64Array([sum[0] / count, sum[1] / count, sum[2] / count]);
  }

  // 0 = not decided, 1 = in the region, 2 = never acceptable.
  const state = new Uint8Array(n);
  const acceptable = (i: number): boolean => {
    if (!usable(i)) return false;
    if (tol2 === Infinity) return true;
    need(i);
    const L = lab[i * 3];
    const a = lab[i * 3 + 1];
    const b = lab[i * 3 + 2];
    for (let k = 0; k < refs.length; k += 3) {
      if ((L - refs[k]) ** 2 + (a - refs[k + 1]) ** 2 + (b - refs[k + 2]) ** 2 <= tol2) return true;
    }
    return false;
  };

  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (const i of seedList) {
    if (state[i]) continue;
    if (acceptable(i)) {
      state[i] = 1;
      queue[tail++] = i;
    } else state[i] = 2;
  }
  const eight = (opts.connectivity ?? 4) === 8;
  const stepTest = maxStep2 !== Infinity;
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = (i - x) / width;
    if (stepTest) need(i);
    const y0 = y > 0 ? y - 1 : y;
    const y1 = y < height - 1 ? y + 1 : y;
    const x0 = x > 0 ? x - 1 : x;
    const x1 = x < width - 1 ? x + 1 : x;
    for (let ny = y0; ny <= y1; ny++) {
      for (let nx = x0; nx <= x1; nx++) {
        if (!eight && nx !== x && ny !== y) continue;
        const j = ny * width + nx;
        if (state[j]) continue;
        if (!acceptable(j)) {
          state[j] = 2;
          continue;
        }
        if (stepTest) {
          need(j);
          const d2 = (lab[i * 3] - lab[j * 3]) ** 2 + (lab[i * 3 + 1] - lab[j * 3 + 1]) ** 2 + (lab[i * 3 + 2] - lab[j * 3 + 2]) ** 2;
          // Too sharp a step from here; another neighbour may still reach it.
          if (d2 > maxStep2) continue;
        }
        state[j] = 1;
        queue[tail++] = j;
      }
    }
  }
  for (let i = 0; i < n; i++) if (state[i] === 1) out.data[i] = 1;
  return out;
}
