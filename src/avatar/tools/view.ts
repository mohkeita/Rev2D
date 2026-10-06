/**
 * The canvas the agent tools draw on: a rectangle of the illustration, magnified by a whole number
 * (nearest neighbour, so every source pixel is a crisp square), on a checkerboard where the
 * picture is transparent, framed by dark ruler margins that are labelled in SOURCE pixel
 * coordinates on all four sides. Grid lines, landmark overlays and markers are drawn over it with
 * the stroke helpers below, which stay readable on any artwork (a dark and a light pixel side by
 * side, or a colour on a contrasting halo).
 *
 * Coordinates: a source point (x, y) is the continuous image coordinate the avatar spec uses
 * (pixel column 12 spans x = 12..13). `toOutput` maps it to output pixels; a grid line "x = 450"
 * is drawn exactly on the boundary between source columns 449 and 450.
 */
import type { ImageRGBA, RGBA } from '../../core/types.js';
import { Coverage, fillRect } from '../../render/draw.js';
import { drawText, measureText } from '../../render/font.js';
import { createImage, resolveColor, type ColorInput } from '../../render/image.js';
import type { Vec2 } from './geometry.js';

/** A failed tool call (bad region, unknown part, nothing to draw): message plus a hint with the fix. */
export class AvatarToolError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'AvatarToolError';
  }
}

export type SourceRegion = [x0: number, y0: number, x1: number, y1: number];

export interface SourceViewOptions {
  /** Source rectangle to show, [x0, y0, x1, y1] (clipped to the image; default: the whole image). */
  region?: readonly number[];
  /** Output pixels per source pixel, a whole number >= 1. Default: the long side becomes about 1000-1600 px. */
  scale?: number;
  /** Lines of footer text below the bottom ruler (a caption, a legend). Default 0. */
  footerLines?: number;
}

export interface SourceView {
  /** The output image: margins plus the magnified picture. */
  image: ImageRGBA;
  /** Source rectangle shown: whole pixels inside the image. */
  region: SourceRegion;
  /** Output pixels per source pixel. */
  scale: number;
  /** Output pixel at which the source point (region x0, y0) lies: the top-left of the picture area. */
  origin: Vec2;
  /** Size of the picture area in output px. */
  size: Vec2;
  /** Magnification of the bitmap font used for labels (1 = 5x7 px glyphs). */
  textScale: number;
  /** Output rows below the bottom ruler, [top, height]; height 0 without a footer. */
  footer: Vec2;
  toOutput(x: number, y: number): Vec2;
}

/** Length of a labelled ruler tick, in text-scale px (unlabelled ticks are half as long). */
const TICK = 4;
/** Longest output side the automatic scale aims for. */
const TARGET_LONG_SIDE = 1280;
const MAX_SCALE = 40;
/** Largest picture area a view may have (an 8000 x 5000 px canvas): beyond it, zoom into a region. */
const MAX_VIEW_PIXELS = 40_000_000;
/** Height of one footer line in text-scale px. */
const FOOTER_LINE = 10;
const MARGIN_COLOR = '#1f2124';
const CHECKER_LIGHT: [number, number, number] = [240, 240, 240];
const CHECKER_DARK: [number, number, number] = [204, 204, 204];
export const RULER_TEXT = '#f2f2f2';
export const RULER_DIM = '#9aa0a6';

function clipRegion(source: ImageRGBA, region: readonly number[] | undefined): SourceRegion {
  if (region === undefined) return [0, 0, source.width, source.height];
  if (region.length !== 4 || !region.every(Number.isFinite)) {
    throw new AvatarToolError(`a region is four numbers x0,y0,x1,y1, got ${JSON.stringify(region)}`, 'e.g. 420,380,580,520 (source-image pixels, top-left and bottom-right corner)');
  }
  const x0 = Math.max(0, Math.floor(Math.min(region[0], region[2])));
  const y0 = Math.max(0, Math.floor(Math.min(region[1], region[3])));
  const x1 = Math.min(source.width, Math.ceil(Math.max(region[0], region[2])));
  const y1 = Math.min(source.height, Math.ceil(Math.max(region[1], region[3])));
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    throw new AvatarToolError(
      `the region ${region.join(',')} does not overlap the ${source.width}x${source.height} image`,
      `x runs 0..${source.width} and y runs 0..${source.height}; give x0,y0,x1,y1 with x0 < x1 and y0 < y1`,
    );
  }
  return [x0, y0, x1, y1];
}

/** The whole-number magnification that brings the long side of a w x h rectangle closest to the target. */
export function autoScale(width: number, height: number): number {
  const long = Math.max(width, height);
  return Math.max(1, Math.min(MAX_SCALE, Math.round(TARGET_LONG_SIDE / long)));
}

/** Magnify a rectangle of the illustration onto a new canvas with ruler margins (see the file comment). */
export function createSourceView(source: ImageRGBA, options: SourceViewOptions = {}): SourceView {
  if (source.width < 1 || source.height < 1) throw new AvatarToolError('the image is empty');
  const region = clipRegion(source, options.region);
  const [x0, y0, x1, y1] = region;
  const rw = x1 - x0;
  const rh = y1 - y0;
  let scale = autoScale(rw, rh);
  if (options.scale !== undefined) {
    if (!Number.isInteger(options.scale) || options.scale < 1 || options.scale > MAX_SCALE) {
      throw new AvatarToolError(`the scale must be a whole number from 1 to ${MAX_SCALE}, got ${options.scale}`);
    }
    scale = options.scale;
  }
  const pw = rw * scale;
  const ph = rh * scale;
  if (pw * ph > MAX_VIEW_PIXELS) {
    throw new AvatarToolError(
      `a ${rw}x${rh} px view at x${scale} would be ${pw}x${ph} px: too large to draw`,
      scale > 1 ? 'use a smaller scale, or a smaller region' : 'look at a part of the image with a region (x0,y0,x1,y1)',
    );
  }
  const textScale = Math.max(1, Math.round(Math.max(pw, ph) / 640));
  // Room for the widest coordinate label beside the picture and one text line above / below it.
  const digits = String(Math.max(source.width, source.height)).length;
  const marginX = measureText('0'.repeat(digits), { scale: textScale }).width + (TICK + 4) * textScale;
  const marginY = (7 + TICK + 4) * textScale;
  const lines = Math.max(0, Math.round(options.footerLines ?? 0));
  const footer = lines ? (lines * FOOTER_LINE + 1) * textScale : 0;
  const width = pw + 2 * marginX;
  const height = ph + 2 * marginY + footer;
  const image = createImage(width, height, MARGIN_COLOR);
  const origin: Vec2 = [marginX, marginY];

  // Picture: nearest-neighbour magnification composited over a checkerboard.
  const cell = 8 * textScale;
  const src = source.data;
  const dst = image.data;
  for (let py = 0; py < ph; py++) {
    const sy = y0 + Math.floor(py / scale);
    const cy = Math.floor(py / cell);
    let di = ((origin[1] + py) * width + origin[0]) * 4;
    for (let px = 0; px < pw; px++, di += 4) {
      const si = (sy * source.width + x0 + Math.floor(px / scale)) * 4;
      const a = src[si + 3] / 255;
      const bg = (Math.floor(px / cell) + cy) % 2 === 0 ? CHECKER_LIGHT : CHECKER_DARK;
      dst[di] = Math.round(src[si] * a + bg[0] * (1 - a));
      dst[di + 1] = Math.round(src[si + 1] * a + bg[1] * (1 - a));
      dst[di + 2] = Math.round(src[si + 2] * a + bg[2] * (1 - a));
      dst[di + 3] = 255;
    }
  }

  return {
    image,
    region,
    scale,
    origin,
    size: [pw, ph],
    textScale,
    footer: [marginY * 2 + ph, footer],
    toOutput: (x, y) => [origin[0] + (x - x0) * scale, origin[1] + (y - y0) * scale],
  };
}

// ----------------------------------------------------------------------------- rulers and grid lines

export interface RulerOptions {
  /** Source px between lines. Default: the finest of 1, 2, 5, 10, 20, 50, ... that keeps lines about 20 text-scale px apart. */
  step?: number;
  /** Draw the lines across the picture (default true); false = ticks and labels in the margins only. */
  lines?: boolean;
}

export interface RulerInfo {
  /** Source px between grid lines. */
  step: number;
  /** Source px between labelled lines: a multiple of `step`. */
  labelStep: number;
  /** Source px between the strong lines (round coordinates such as multiples of 10 or 100): a multiple of `step`. */
  strongStep: number;
}

const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

function defaultStep(view: SourceView): number {
  const min = 20 * view.textScale;
  return STEPS.find((s) => s !== 25 && s !== 250 && s * view.scale >= min) ?? STEPS[STEPS.length - 1];
}

/** Multiples of `step` inside [from, to]. */
function multiples(step: number, from: number, to: number): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(from / step - 1e-9); k * step <= to + 1e-9; k++) out.push(Number((k * step).toFixed(6)));
  return out;
}

/**
 * Grid lines over the picture and tick labels in the margins of all four sides, in source pixel
 * coordinates. Each line is two output pixels wide, one dark and one light, with the boundary
 * between them exactly on the coordinate, so it shows on any artwork. Lines on round coordinates
 * (every 10 px in a fine grid, every 100 px in a coarse one) are stronger and their labels brighter,
 * which makes counting from a label to a line reliable.
 */
export function drawRulers(view: SourceView, options: RulerOptions = {}): RulerInfo {
  const step = options.step ?? defaultStep(view);
  if (!(step > 0) || !Number.isFinite(step)) throw new AvatarToolError(`the grid step must be a positive number of source px, got ${step}`);
  const [x0, y0, x1, y1] = view.region;
  const ts = view.textScale;
  const { image } = view;
  const [ox, oy] = view.origin;
  const [pw, ph] = view.size;
  if ((Math.max(x1 - x0, y1 - y0) / step) * 2 > Math.max(pw, ph)) {
    throw new AvatarToolError(`a grid step of ${step} px is too fine for this view: its lines would touch each other`, `use a step of at least ${defaultStep(view)}, or zoom into a smaller region`);
  }

  // Labels must not touch: label every n-th line.
  const labelWidth = measureText(String(Math.max(x1, y1)), { scale: ts }).width + 5 * ts;
  const labelHeight = 7 * ts + 4 * ts;
  const every = (need: number) => [1, 2, 5, 10, 20, 50, 100].find((n) => n * step * view.scale >= need) ?? 100;
  const labelStep = step * Math.max(every(labelWidth), every(labelHeight));
  // The next round spacing above the step: 5 -> 10, 10 or 20 -> 50 (20 -> 100), 50 -> 100, ...
  const strongStep = [10, 50, 100, 500, 1000, 5000, 10000].find((r) => r >= step * 2 && Math.abs(r / step - Math.round(r / step)) < 1e-6) ?? step;
  const multipleOf = (v: number, of: number) => Math.abs(v / of - Math.round(v / of)) < 1e-6;

  const drawLines = options.lines ?? true;
  const line = (v: number, at: number) => ({ v, at: Math.round(at), major: multipleOf(v, strongStep), labelled: multipleOf(v, labelStep) });
  const xs = multiples(step, x0, x1).map((v) => line(v, ox + (v - x0) * view.scale));
  const ys = multiples(step, y0, y1).map((v) => line(v, oy + (v - y0) * view.scale));
  if (drawLines) {
    // All dark halves first, then all light halves: crossings look the same in both directions.
    for (const pass of ['dark', 'light'] as const) {
      const offset = pass === 'dark' ? -1 : 0;
      for (const major of [false, true]) {
        const color: RGBA = pass === 'dark' ? [0, 0, 0, major ? 0.62 : 0.3] : [1, 1, 1, major ? 0.8 : 0.38];
        for (const x of xs) if (x.major === major) fillRect(image, x.at + offset, oy, 1, ph, color);
        for (const y of ys) if (y.major === major) fillRect(image, ox, y.at + offset, pw, 1, color);
      }
    }
  }
  const label = (v: number) => String(Number(v.toFixed(3)));
  for (const x of xs) {
    const len = (x.major ? TICK : TICK / 2) * ts;
    fillRect(image, x.at - 1, oy - len, 2, len, RULER_DIM);
    fillRect(image, x.at - 1, oy + ph, 2, len, RULER_DIM);
    if (!x.labelled) continue;
    const text = label(x.v);
    const w = measureText(text, { scale: ts }).width;
    const tx = Math.max(0, Math.min(image.width - w, Math.round(x.at - w / 2)));
    const color = x.major ? RULER_TEXT : RULER_DIM;
    drawText(image, tx, oy - (TICK + 1 + 7) * ts, text, color, { scale: ts });
    drawText(image, tx, oy + ph + (TICK + 1) * ts, text, color, { scale: ts });
  }
  for (const y of ys) {
    const len = (y.major ? TICK : TICK / 2) * ts;
    fillRect(image, ox - len, y.at - 1, len, 2, RULER_DIM);
    fillRect(image, ox + pw, y.at - 1, len, 2, RULER_DIM);
    if (!y.labelled) continue;
    const text = label(y.v);
    const w = measureText(text, { scale: ts }).width;
    const ty = Math.round(y.at - (7 * ts) / 2);
    const color = y.major ? RULER_TEXT : RULER_DIM;
    drawText(image, ox - (TICK + 1) * ts - w, ty, text, color, { scale: ts });
    drawText(image, ox + pw + (TICK + 1) * ts, ty, text, color, { scale: ts });
  }
  return { step, labelStep, strongStep };
}

/**
 * One line of text in the footer (`line` counts from 0): the parts joined by " | ". Parts that do
 * not fit the canvas width are left out from the end, so the line never stops in the middle of one.
 */
export function drawFooterText(view: SourceView, parts: readonly string[], line = 0, color: ColorInput = RULER_DIM): void {
  const ts = view.textScale;
  const max = Math.floor((view.image.width - 8 * ts) / (6 * ts));
  let shown = parts.slice();
  while (shown.length > 1 && shown.join(' | ').length > max) shown = shown.slice(0, -1);
  drawText(view.image, 4 * ts, view.footer[0] + line * FOOTER_LINE * ts, shown.join(' | ').slice(0, Math.max(0, max)), color, { scale: ts });
}

// ----------------------------------------------------------------------------- strokes that read on any artwork

const DARK_HALO: RGBA = [0, 0, 0, 0.78];
const LIGHT_HALO: RGBA = [1, 1, 1, 0.85];

function luminance(color: ColorInput): number {
  const [r, g, b] = resolveColor(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The halo a stroke of this colour gets: dark around light colours, light around dark ones. */
function haloFor(color: ColorInput): RGBA {
  return luminance(color) < 0.4 ? LIGHT_HALO : DARK_HALO;
}

/** The pixel box of `points` grown by `reach`, clipped to the picture area (overlays never run into the rulers). */
function clipBox(view: SourceView, points: ArrayLike<number>, reach: number): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    if (points[i] < minX) minX = points[i];
    if (points[i] > maxX) maxX = points[i];
    if (points[i + 1] < minY) minY = points[i + 1];
    if (points[i + 1] > maxY) maxY = points[i + 1];
  }
  const [ox, oy] = view.origin;
  return [Math.max(ox, minX - reach), Math.max(oy, minY - reach), Math.min(ox + view.size[0], maxX + reach), Math.min(oy + view.size[1], maxY + reach)];
}

function haloWidth(view: SourceView): number {
  return Math.max(1, Math.round(view.textScale * 0.75));
}

/** A polyline in OUTPUT coordinates: `color` on a contrasting halo. `dash` = [dash, gap] in output px. */
export function strokeOutput(view: SourceView, points: ArrayLike<number>, color: ColorInput, width: number, closed = false, dash?: [number, number]): void {
  const halo = haloWidth(view);
  const box = clipBox(view, points, width / 2 + halo + 2);
  if (!(box[2] > box[0] && box[3] > box[1])) return;
  const draw = (w: number, c: ColorInput) => {
    const cov = new Coverage(view.image, box);
    if (!dash) cov.polyline(points, w, true, closed);
    else {
      const n = Math.floor(points.length / 2);
      for (let i = 0; i + 1 < n; i++) cov.dashed(points[i * 2], points[i * 2 + 1], points[i * 2 + 2], points[i * 2 + 3], w, dash[0], dash[1]);
      if (closed && n > 2) cov.dashed(points[n * 2 - 2], points[n * 2 - 1], points[0], points[1], w, dash[0], dash[1]);
    }
    cov.composite(view.image, c);
  };
  draw(width + 2 * halo, haloFor(color));
  draw(width, color);
}

/** A filled dot (or a ring) in OUTPUT coordinates: `color` on a contrasting halo. */
export function dotOutput(view: SourceView, x: number, y: number, radius: number, color: ColorInput, ring = false): void {
  const halo = haloWidth(view);
  const w = Math.max(1.5, view.textScale);
  const box = clipBox(view, [x, y], radius + w + halo + 2);
  if (!(box[2] > box[0] && box[3] > box[1])) return;
  const a = new Coverage(view.image, box);
  const b = new Coverage(view.image, box);
  if (ring) {
    a.ring(x, y, radius, w + 2 * halo);
    b.ring(x, y, radius, w);
  } else {
    a.disc(x, y, radius + halo);
    b.disc(x, y, radius);
  }
  a.composite(view.image, haloFor(color));
  b.composite(view.image, color);
}

/** The box [x, y, w, h] a tag with its top-left at (x, y) would take: kept inside the picture area. */
export function tagBox(view: SourceView, x: number, y: number, text: string, scale = view.textScale, bar = false): [number, number, number, number] {
  const pad = Math.max(1, scale);
  const m = measureText(text, { scale });
  const w = m.width + 2 * pad + (bar ? 3 * scale : 0);
  const h = m.height + 2 * pad;
  const [bx0, by0] = view.origin;
  const bx1 = bx0 + view.size[0];
  const by1 = by0 + view.size[1];
  return [Math.round(Math.max(bx0, Math.min(bx1 - w, x))), Math.round(Math.max(by0, Math.min(by1 - h, y))), w, h];
}

/**
 * White text on a dark box whose top-left is (x, y) in OUTPUT coordinates, kept inside the picture
 * area. `bar` paints a strip of that colour at the left edge of the box (the group colour of a
 * label: coloured text would be hard to read for the darker hues). Returns the box.
 */
export function tagOutput(view: SourceView, x: number, y: number, text: string, scale = view.textScale, bar?: ColorInput): [number, number, number, number] {
  const box = tagBox(view, x, y, text, scale, bar !== undefined);
  const pad = Math.max(1, scale);
  fillRect(view.image, box[0], box[1], box[2], box[3], [0.04, 0.04, 0.06, 0.82]);
  let tx = box[0] + pad;
  if (bar !== undefined) {
    fillRect(view.image, box[0], box[1], 2 * scale, box[3], bar);
    tx += 3 * scale;
  }
  drawText(view.image, tx, box[1] + pad, text, RULER_TEXT, { scale });
  return box;
}
