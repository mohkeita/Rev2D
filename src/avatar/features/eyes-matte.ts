/**
 * Pixel helpers shared by the face features that lift small drawn things off the skin (eyes.ts,
 * brows.ts, mouth.ts). Pure and deterministic, like everything under src/avatar.
 *
 * THE DIFFERENCE MATTE. A feature that must move a lash line or a brow first fills the base under it
 * with clean skin (inpaint with skin-only sources) and then stores, per pixel, the most transparent
 * colour that turns the fill back into the illustration:
 *
 *     alpha * colour + (1 - alpha) * fill = source        (per channel, alpha as small as possible)
 *
 * Plain skin gets alpha 0, a dark stroke a high alpha with its own colour, soft shading a low alpha.
 * So the rest pose is the illustration exactly (within 8-bit rounding), the layer carries ONLY what
 * was drawn on the skin, and when it moves there is no rectangle of old skin moving along: no seam
 * to hide, nothing to feather.
 */
import type { ImageRGBA } from '../../core/types.js';
import { createImage } from '../../render/image.js';
import { deltaE, rgbToLab, type LabImage } from '../image/color.js';
import { createMask } from '../image/mask.js';
import type { Lab, Mask, RGB, Rect } from '../image/types.js';
import type { AvatarSpec } from '../types.js';

/** "#rrggbb" of a colour (channels rounded and clamped). */
export function hexColor(rgb: readonly number[]): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

/** [r, g, b] of "#rrggbb" (anything else: null). */
export function parseHex(text: unknown): RGB | null {
  if (typeof text !== 'string') return null;
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/** Median per channel of the opaque pixels a predicate accepts inside a rectangle (null when fewer than `min`). */
export function medianColor(img: ImageRGBA, rect: Rect, accept: (x: number, y: number, i: number) => boolean, min = 1): RGB | null {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let count = 0;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(img.height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * img.width + x;
      if (img.data[i * 4 + 3] < 250 || !accept(x, y, i)) continue;
      hist[0][img.data[i * 4]]++;
      hist[1][img.data[i * 4 + 1]]++;
      hist[2][img.data[i * 4 + 2]]++;
      count++;
    }
  }
  if (count < min) return null;
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let cum = 0;
    for (let v = 0; v < 256; v++) {
      cum += hist[c][v];
      if (cum * 2 >= count) {
        out[c] = v;
        break;
      }
    }
  }
  return out;
}

/**
 * The skin colour of the face: the median of small discs on places that are skin by definition of
 * the landmarks (the face centre, the bridge of the nose between the eyes, the spot between the face
 * centre and the nose tip). Falls back to a light skin tone when none of them is opaque.
 */
export function faceSkinColor(source: ImageRGBA, spec: AvatarSpec): RGB {
  const { face } = spec;
  const centre = (points: readonly number[]): [number, number] => {
    let x = 0;
    let y = 0;
    for (let i = 0; i + 1 < points.length; i += 2) {
      x += points[i];
      y += points[i + 1];
    }
    const n = Math.max(1, points.length / 2);
    return [x / n, y / n];
  };
  const left = centre(face.eyes.imageLeft.opening);
  const right = centre(face.eyes.imageRight.opening);
  const spots: Array<[number, number]> = [
    [face.center[0], face.center[1]],
    [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2],
    [(face.center[0] + face.nose[0]) / 2, (face.center[1] + face.nose[1]) / 2],
  ];
  const r = Math.max(2, face.radius[0] * 0.05);
  const x0 = Math.min(...spots.map((s) => s[0])) - r;
  const y0 = Math.min(...spots.map((s) => s[1])) - r;
  const x1 = Math.max(...spots.map((s) => s[0])) + r;
  const y1 = Math.max(...spots.map((s) => s[1])) + r;
  const median = medianColor(source, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, (x, y) => spots.some((s) => (x + 0.5 - s[0]) ** 2 + (y + 0.5 - s[1]) ** 2 <= r * r), 4);
  return median ?? [245, 215, 200];
}

/** Lab of pixel `i` of a LabImage. */
export function labAt(lab: LabImage, i: number): Lab {
  return [lab.lab[i * 3], lab.lab[i * 3 + 1], lab.lab[i * 3 + 2]];
}

/** deltaE between pixel `i` and a colour. */
export function labDistance(lab: LabImage, i: number, c: Lab): number {
  const dL = lab.lab[i * 3] - c[0];
  const da = lab.lab[i * 3 + 1] - c[1];
  const db = lab.lab[i * 3 + 2] - c[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** Smallest deltaE between a colour and a list (Infinity for an empty list). */
export function nearestDistance(c: Lab, list: readonly Lab[]): number {
  let best = Infinity;
  for (const other of list) best = Math.min(best, deltaE(c, other));
  return best;
}

export { rgbToLab };

/** Largest channel difference between the same pixel of two images. */
export function channelDifference(a: ImageRGBA, b: ImageRGBA, i: number): number {
  const o = i * 4;
  return Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2]));
}

/**
 * Write into `out` (pixel `i`) the most transparent colour that gives `source` when drawn over
 * `under` (both taken as opaque). Differences of one level are rounding noise and stay out.
 * Returns the alpha written (0..255).
 */
export function writeMatte(out: ImageRGBA, source: ImageRGBA, under: ImageRGBA, i: number): number {
  const o = i * 4;
  const s = source.data;
  const f = under.data;
  let need = 0;
  let noise = true;
  for (let c = 0; c < 3; c++) {
    const sv = s[o + c];
    const fv = f[o + c];
    if (Math.abs(sv - fv) > 1) noise = false;
    if (sv < fv) need = Math.max(need, (fv - sv) / fv);
    else if (sv > fv) need = Math.max(need, (sv - fv) / (255 - fv));
  }
  if (noise || !(need > 0)) return 0;
  // Rounding the alpha UP keeps the colour inside 0..255.
  const a8 = Math.min(255, Math.ceil(need * 255));
  for (let c = 0; c < 3; c++) {
    const fv = f[o + c];
    out.data[o + c] = Math.max(0, Math.min(255, Math.round(fv + ((s[o + c] - fv) * 255) / a8)));
  }
  out.data[o + 3] = a8;
  return a8;
}

/**
 * Like writeMatte, but the colour leans toward `toward` (the colour of what the pixel's edge belongs
 * to, e.g. the hair next to an antialiased hair edge): the alpha is the share of `toward` that mixes
 * `under` into `source` (at least the alpha writeMatte needs), so the edge keeps its own colour over
 * another backing. Drawn over `under` it still gives `source`.
 */
export function writeMatteToward(out: ImageRGBA, source: ImageRGBA, under: ImageRGBA, i: number, toward: ArrayLike<number>): number {
  const o = i * 4;
  const s = source.data;
  const f = under.data;
  let need = 0;
  let noise = true;
  let along = 0;
  let span = 0;
  for (let c = 0; c < 3; c++) {
    const sv = s[o + c];
    const fv = f[o + c];
    if (Math.abs(sv - fv) > 1) noise = false;
    if (sv < fv) need = Math.max(need, (fv - sv) / fv);
    else if (sv > fv) need = Math.max(need, (sv - fv) / (255 - fv));
    const d = toward[c] - fv;
    along += (sv - fv) * d;
    span += d * d;
  }
  if (noise || !(need > 0)) return 0;
  const share = span > 0 ? along / span : 0;
  const a8 = Math.min(255, Math.ceil(Math.max(need, Math.min(1, share)) * 255));
  for (let c = 0; c < 3; c++) {
    const fv = f[o + c];
    out.data[o + c] = Math.max(0, Math.min(255, Math.round(fv + ((s[o + c] - fv) * 255) / a8)));
  }
  out.data[o + 3] = a8;
  return a8;
}

/** Copy pixel `i` of `source` into `out`, fully opaque where the source is. */
export function writeOpaque(out: ImageRGBA, source: ImageRGBA, i: number): void {
  const o = i * 4;
  out.data[o] = source.data[o];
  out.data[o + 1] = source.data[o + 1];
  out.data[o + 2] = source.data[o + 2];
  out.data[o + 3] = source.data[o + 3];
}

/** True when any pixel of the image has an alpha of at least `min`. */
export function hasAlpha(img: ImageRGBA, min = 1): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] >= min) return true;
  return false;
}

/** A mask from a per-pixel predicate. */
export function maskWhere(width: number, height: number, test: (i: number) => boolean): Mask {
  const mask = createMask(width, height);
  for (let i = 0; i < mask.data.length; i++) if (test(i)) mask.data[i] = 1;
  return mask;
}

/** A transparent image of the same size. */
export function blankLike(img: ImageRGBA): ImageRGBA {
  return createImage(img.width, img.height);
}

/** Clamped linear interpolation of the samples (xs ascending) at x. */
export function interpolate(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xs[hi] - xs[lo];
  const t = span > 0 ? (x - xs[lo]) / span : 0;
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

/**
 * A rotated frame: u runs along `angle` (degrees, clockwise on screen), v perpendicular to it and
 * downward for angle 0. Eyes and the mouth do their geometry in such a frame, so a tilted head in
 * the illustration closes its eyes along its own vertical.
 */
export interface Frame {
  center: [number, number];
  angle: number;
  /** Source pixels -> frame coordinates. */
  to(x: number, y: number): [number, number];
  /** Frame coordinates -> source pixels. */
  from(u: number, v: number): [number, number];
  /** Unit vectors of the u and v axes in source pixels. */
  along: [number, number];
  down: [number, number];
}

export function makeFrame(center: readonly [number, number], angle: number): Frame {
  const a = (angle * Math.PI) / 180;
  // Exact axes for an upright frame keep keyforms free of 1e-17 noise.
  const cos = angle === 0 ? 1 : Math.cos(a);
  const sin = angle === 0 ? 0 : Math.sin(a);
  const [cx, cy] = center;
  return {
    center: [cx, cy],
    angle,
    to: (x, y) => [(x - cx) * cos + (y - cy) * sin, -(x - cx) * sin + (y - cy) * cos],
    from: (u, v) => [cx + u * cos - v * sin, cy + u * sin + v * cos],
    along: [cos, sin],
    down: [-sin, cos],
  };
}

/** A flat point list mapped through a function. */
export function mapPoints(points: ArrayLike<number>, f: (x: number, y: number) => [number, number]): number[] {
  const out: number[] = new Array(points.length - (points.length % 2));
  for (let i = 0; i + 1 < points.length; i += 2) {
    const p = f(points[i], points[i + 1]);
    out[i] = p[0];
    out[i + 1] = p[1];
  }
  return out;
}

/** Round to 2 decimals (coordinates in metadata and keyforms). */
export function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
