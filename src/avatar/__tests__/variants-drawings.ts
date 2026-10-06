/**
 * Synthetic "drawings" for the drawn-variant tests: copies of a test illustration in which the eyes
 * or the mouth are repainted programmatically inside the edit areas (like an image generator would),
 * plus the usual ways a real generator fails (a global shift, a zoom, recompression noise, changes
 * outside the mask). No third-party art: they start from the hana render or synthetic pictures.
 */
import type { ImageRGBA } from '../../core/types.js';
import { colorStats } from '../image/color.js';
import { createMask, maskSubtract } from '../image/mask.js';
import { mulberry32 } from '../image/random.js';
import { polygonEnvelope } from '../image/polygon.js';
import { ellipseMask, polygonMask, strokeMask } from '../image/raster.js';
import type { Mask, RGB } from '../image/types.js';
import type { AvatarSpec } from '../types.js';

export function copyImage(img: ImageRGBA): ImageRGBA {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** Paint `color` over `img` IN PLACE with coverage `mask` (opaque result where the mask is 1). */
export function paint(img: ImageRGBA, mask: Mask, color: RGB): void {
  for (let i = 0, j = 0; i < mask.data.length; i++, j += 4) {
    const m = mask.data[i];
    if (!(m > 0)) continue;
    const a = img.data[j + 3] / 255;
    const out = m + a * (1 - m);
    for (let c = 0; c < 3; c++) img.data[j + c] = Math.round((color[c] * m + img.data[j + c] * a * (1 - m)) / out);
    img.data[j + 3] = Math.round(out * 255);
  }
}

/** The skin colour of the face oval around the eyes (median, outside both eye regions). */
export function skinColor(source: ImageRGBA, spec: AvatarSpec): RGB {
  const { width: W, height: H } = source;
  const face = ellipseMask(W, H, spec.face.center[0], spec.face.center[1], spec.face.radius[0] * 0.7, spec.face.radius[1] * 0.7);
  let keep = face;
  for (const side of ['imageLeft', 'imageRight'] as const) keep = maskSubtract(keep, polygonMask(W, H, spec.face.eyes[side].region));
  keep = maskSubtract(keep, ellipseMask(W, H, spec.face.mouth.area.center[0], spec.face.mouth.area.center[1], spec.face.mouth.area.radius[0], spec.face.mouth.area.radius[1]));
  return colorStats(source, keep)?.median ?? [240, 210, 200];
}

/** Both eyes closed: each opening painted with skin, and one dark lash line along its lower edge. */
export function drawClosedEyes(source: ImageRGBA, spec: AvatarSpec, sides: ReadonlyArray<'imageLeft' | 'imageRight'> = ['imageLeft', 'imageRight']): ImageRGBA {
  const out = copyImage(source);
  const skin = skinColor(source, spec);
  for (const side of sides) {
    const opening = spec.face.eyes[side].opening;
    paint(out, polygonMask(out.width, out.height, opening), skin);
    const env = polygonEnvelope(opening, 9);
    const line: number[] = [];
    env.x.forEach((x, i) => line.push(x, env.lower[i] - (env.lower[i] - env.upper[i]) * 0.3));
    paint(out, strokeMask(out.width, out.height, line, Math.max(1, out.width / 300)), [60, 30, 40]);
  }
  return out;
}

/** The mouth open: a dark ellipse with a tongue, inside the mouth area. */
export function drawOpenMouth(source: ImageRGBA, spec: AvatarSpec, size = 0.6): ImageRGBA {
  const out = copyImage(source);
  const { center, radius, rotation } = spec.face.mouth.area;
  paint(out, ellipseMask(out.width, out.height, center[0], center[1], radius[0] * size, radius[1] * size, rotation), [70, 20, 30]);
  paint(out, ellipseMask(out.width, out.height, center[0], center[1] + radius[1] * size * 0.45, radius[0] * size * 0.55, radius[1] * size * 0.35, rotation), [200, 90, 100]);
  return out;
}

/** The picture moved by (dx, dy) whole pixels; the uncovered edge is transparent. */
export function shiftImage(img: ImageRGBA, dx: number, dy: number): ImageRGBA {
  const out: ImageRGBA = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.length) };
  for (let y = 0; y < img.height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < img.width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= img.width) continue;
      const o = (y * img.width + x) * 4;
      const so = (sy * img.width + sx) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = img.data[so + c];
    }
  }
  return out;
}

/** The picture scaled by `s` about its centre (bilinear on premultiplied colour). */
export function zoomImage(img: ImageRGBA, s: number): ImageRGBA {
  const { width: W, height: H } = img;
  const out: ImageRGBA = { width: W, height: H, data: new Uint8ClampedArray(img.data.length) };
  const at = (x: number, y: number, c: number) => {
    const cx = Math.min(W - 1, Math.max(0, x));
    const cy = Math.min(H - 1, Math.max(0, y));
    const o = (cy * W + cx) * 4;
    return c === 3 ? img.data[o + 3] : (img.data[o + c] * img.data[o + 3]) / 255;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = W / 2 + (x + 0.5 - W / 2) / s - 0.5;
      const sy = H / 2 + (y + 0.5 - H / 2) / s - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const tx = sx - x0;
      const ty = sy - y0;
      const o = (y * W + x) * 4;
      const v = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) v[c] = (at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx) * (1 - ty) + (at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx) * ty;
      out.data[o + 3] = Math.round(v[3]);
      for (let c = 0; c < 3; c++) out.data[o + c] = v[3] > 0 ? Math.round((v[c] * 255) / v[3]) : 0;
    }
  }
  return out;
}

/** Recompression-like noise: every colour channel of every visible pixel moves by up to +-amplitude (seeded). */
export function addNoise(img: ImageRGBA, amplitude: number, seed = 1): ImageRGBA {
  const out = copyImage(img);
  const random = mulberry32(seed);
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) out.data[i + c] = out.data[i + c] + Math.round((random() * 2 - 1) * amplitude);
  }
  return out;
}

/** A solid patch painted at (x, y, w, h): something added outside the mask. */
export function addPatch(img: ImageRGBA, x: number, y: number, w: number, h: number, color: RGB = [30, 160, 60]): ImageRGBA {
  const out = copyImage(img);
  const m = createMask(img.width, img.height);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) m.data[yy * img.width + xx] = 1;
  paint(out, m, color);
  return out;
}

/**
 * A drawing as an image generator makes it: where it repainted the illustration, what is drawn in
 * front (hair, brows: `above` at rest over `rect`, see spriteBackdrop) stays in front.
 */
export function keepInFront(drawing: ImageRGBA, source: ImageRGBA, backdrop: { rect: { x: number; y: number; width: number; height: number }; above: ImageRGBA }): ImageRGBA {
  const out = copyImage(drawing);
  const { rect, above } = backdrop;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const i = (y * rect.width + x) * 4;
      const o = ((y + rect.y) * out.width + x + rect.x) * 4;
      const repainted = [0, 1, 2, 3].some((c) => drawing.data[o + c] !== source.data[o + c]);
      if (!repainted) continue;
      const a = above.data[i + 3] / 255;
      for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(above.data[i + c] * a + out.data[o + c] * (1 - a));
    }
  }
  return out;
}
