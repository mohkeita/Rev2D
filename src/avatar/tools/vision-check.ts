/**
 * Vision check: can this agent read pixel coordinates off a picture well enough to place
 * landmarks?
 *
 *   makeVisionCheck({seed, size})    a busy, illustration-like synthetic image (gradient, flat
 *                                    shapes with outlines, thin strokes) with 12 numbered markers,
 *                                    plus the answer key (kept apart from the image)
 *   scoreVisionCheck(key, answer)    answer = {"1": [x, y], ..., "12": [x, y]}: the error of every
 *                                    marker, mean and max, pass / fail and advice
 *
 * A marker is a small crosshair with an open centre (the pixels at the centre stay visible) and
 * its number in a box beside it. The wanted coordinate is the point its four arms point at: a whole
 * number in both axes, with the arms (white, two pixels wide, black edges) centred exactly on it,
 * so the grid line of that coordinate runs down the middle of an arm. The check passes when the
 * mean error is at most 4 px and the largest at most 10 px on a 1024 px image (both scale with the
 * image size).
 *
 * Deterministic: the same seed and size give the same key everywhere (a 32-bit integer PRNG and
 * whole-pixel positions) and the same pixels in one JS engine (the software drawing code of
 * src/render; only Math.sin / Math.cos of the background shapes may round differently elsewhere).
 */
import type { ImageRGBA, RGBA } from '../../core/types.js';
import { drawCircle, drawLine, drawPolyline, fillRect } from '../../render/draw.js';
import { drawLabel, measureLabel } from '../../render/font.js';
import { createImage } from '../../render/image.js';
import { round } from './geometry.js';
import { AvatarToolError } from './view.js';

export const VISION_CHECK_MARKERS = 12;

export interface VisionCheckOptions {
  /** Any integer; the same seed gives the same image (default 1). */
  seed?: number;
  /** Width and height of the square image in px (default 1024; 256..4096). */
  size?: number;
}

export interface VisionCheckKey {
  version: 1;
  seed: number;
  size: number;
  /** Marker number -> the centre of its crosshair, [x, y] in image pixels. */
  markers: Record<string, [number, number]>;
}

export interface VisionCheck {
  image: ImageRGBA;
  key: VisionCheckKey;
}

/** mulberry32: a small, fast 32-bit PRNG with a well-defined sequence in every JS engine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE: Array<[number, number, number]> = [
  [0.36, 0.2, 0.16], // hair browns
  [0.52, 0.3, 0.2],
  [0.98, 0.87, 0.8], // skin
  [0.96, 0.74, 0.68],
  [0.8, 0.12, 0.14], // accents
  [0.93, 0.72, 0.2],
  [0.12, 0.12, 0.14],
  [0.2, 0.32, 0.6],
  [0.42, 0.64, 0.5],
  [0.72, 0.56, 0.8],
  [1, 1, 1],
];

export function makeVisionCheck(options: VisionCheckOptions = {}): VisionCheck {
  const seed = options.seed ?? 1;
  const size = options.size ?? 1024;
  if (!Number.isInteger(seed)) throw new AvatarToolError(`the seed must be a whole number, got ${seed}`);
  if (!Number.isInteger(size) || size < 256 || size > 4096) throw new AvatarToolError(`the size must be a whole number of pixels from 256 to 4096, got ${size}`);
  const rnd = mulberry32(seed);
  const between = (lo: number, hi: number) => lo + (hi - lo) * rnd();
  const pick = (alpha: number): RGBA => {
    const c = PALETTE[Math.floor(rnd() * PALETTE.length)];
    return [c[0], c[1], c[2], alpha];
  };
  const k = size / 1024;
  const image = createImage(size, size);

  // Background: a diagonal gradient between two pastel colours.
  const from = [between(0.75, 1), between(0.75, 1), between(0.75, 1)];
  const to = [between(0.45, 0.8), between(0.45, 0.8), between(0.45, 0.8)];
  const angle = rnd() * Math.PI * 2;
  const gx = Math.cos(angle);
  const gy = Math.sin(angle);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.min(1, Math.max(0, 0.5 + ((x - size / 2) * gx + (y - size / 2) * gy) / size));
      const i = (y * size + x) * 4;
      image.data[i] = Math.round((from[0] + (to[0] - from[0]) * t) * 255);
      image.data[i + 1] = Math.round((from[1] + (to[1] - from[1]) * t) * 255);
      image.data[i + 2] = Math.round((from[2] + (to[2] - from[2]) * t) * 255);
      image.data[i + 3] = 255;
    }
  }

  // Flat shapes, some with line-art outlines: discs, capsules (thick strokes) and rings.
  for (let i = 0; i < 26; i++) {
    const x = between(0, size);
    const y = between(0, size);
    const r = between(24, 140) * k;
    drawCircle(image, x, y, r, pick(between(0.4, 0.9)));
    if (rnd() < 0.5) drawCircle(image, x, y, r, [0.15, 0.08, 0.08, 0.85], { fill: false, width: Math.max(1, 2 * k) });
  }
  for (let i = 0; i < 16; i++) {
    const x = between(0, size);
    const y = between(0, size);
    const a = rnd() * Math.PI * 2;
    const len = between(60, 320) * k;
    drawLine(image, x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, pick(between(0.5, 0.95)), { width: between(12, 46) * k });
  }
  for (let i = 0; i < 10; i++) {
    drawCircle(image, between(0, size), between(0, size), between(18, 90) * k, pick(0.9), { fill: false, width: between(2, 7) * k });
  }
  // Thin strokes: gently curved polylines like strands of hair, lashes and folds.
  for (let i = 0; i < 46; i++) {
    let x = between(0, size);
    let y = between(0, size);
    let a = rnd() * Math.PI * 2;
    const bend = between(-0.25, 0.25);
    const step = between(14, 34) * k;
    const pts = [x, y];
    for (let j = 0; j < 9; j++) {
      a += bend;
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      pts.push(x, y);
    }
    const dark = rnd() < 0.6;
    drawPolyline(image, pts, dark ? [0.14, 0.07, 0.07, 0.9] : pick(0.9), { width: Math.max(1, between(1, 2.6) * k) });
  }

  // Marker centres: whole pixels, away from the border and from each other.
  const margin = Math.round(64 * k);
  const apart = 96 * k;
  const centres: Array<[number, number]> = [];
  for (let attempt = 0; centres.length < VISION_CHECK_MARKERS && attempt < 20000; attempt++) {
    const x = margin + Math.floor(rnd() * (size - 2 * margin));
    const y = margin + Math.floor(rnd() * (size - 2 * margin));
    if (centres.every(([cx, cy]) => (cx - x) ** 2 + (cy - y) ** 2 >= apart * apart)) centres.push([x, y]);
  }

  const gap = Math.max(3, Math.round(4 * k));
  const arm = Math.max(9, Math.round(14 * k));
  const half = Math.max(1, Math.round(k));
  const edge = Math.max(1, Math.round(k));
  const textScale = Math.max(1, Math.round(2 * k));
  const markers: Record<string, [number, number]> = {};
  centres.forEach(([x, y], index) => {
    const id = String(index + 1);
    markers[id] = [x, y];
    // Four bars that leave the centre open, centred on the coordinate lines x and y; white with a
    // black edge shows on any colour.
    const bars: Array<[number, number, number, number]> = [
      [x - half, y - arm, 2 * half, arm - gap],
      [x - half, y + gap, 2 * half, arm - gap],
      [x - arm, y - half, arm - gap, 2 * half],
      [x + gap, y - half, arm - gap, 2 * half],
    ];
    for (const [bx, by, bw, bh] of bars) fillRect(image, bx - edge, by - edge, bw + 2 * edge, bh + 2 * edge, '#000000');
    for (const [bx, by, bw, bh] of bars) fillRect(image, bx, by, bw, bh, '#ffffff');
    // The number in a box diagonally beside the crosshair, on the side with more room.
    const label = measureLabel(id, 0, 0, { scale: textScale });
    const right = x + arm + label.width < size - 2;
    const below = y + arm + label.height < size - 2;
    const lx = right ? x + Math.round(arm * 0.6) : x - Math.round(arm * 0.6) - label.width;
    const ly = below ? y + Math.round(arm * 0.6) : y - Math.round(arm * 0.6) - label.height;
    drawLabel(image, lx, ly, id, { scale: textScale, background: [0, 0, 0, 0.85] });
  });

  return { image, key: { version: 1, seed, size, markers } };
}

// ----------------------------------------------------------------------------- scoring

export interface VisionCheckMarkerScore {
  id: string;
  expected: [number, number];
  /** The answer for this marker; null when it is missing or not [x, y]. */
  answer: [number, number] | null;
  /** Distance between answer and expected in px; null without an answer. */
  error: number | null;
}

export interface VisionCheckScore {
  pass: boolean;
  /** Mean and largest error over the answered markers, px (null when nothing was answered). */
  mean: number | null;
  max: number | null;
  answered: number;
  total: number;
  /** The limits for this image size: mean <= limits.mean and max <= limits.max pass. */
  limits: { mean: number; max: number };
  markers: VisionCheckMarkerScore[];
  /** Mean of (answer - expected), px: a constant shift shows up here. */
  bias: [number, number] | null;
  advice: string;
}

function readAnswer(v: unknown): [number, number] | null {
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (Array.isArray(v) && v.length === 2 && ok(v[0]) && ok(v[1])) return [v[0], v[1]];
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as { x?: unknown; y?: unknown };
    if (ok(o.x) && ok(o.y)) return [o.x, o.y];
  }
  return null;
}

function isKey(v: unknown): v is VisionCheckKey {
  if (v === null || typeof v !== 'object') return false;
  const k = v as Partial<VisionCheckKey>;
  return typeof k.size === 'number' && k.size > 0 && k.markers !== null && typeof k.markers === 'object' && Object.values(k.markers).every((m) => readAnswer(m) !== null);
}

/** Compare an answer {"1": [x, y], ...} with the key. Throws AvatarToolError when the answer is not an object. */
export function scoreVisionCheck(key: VisionCheckKey, answer: unknown): VisionCheckScore {
  if (!isKey(key)) throw new AvatarToolError('the answer key is damaged', 'run "rev2d avatar vision-check make" again');
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new AvatarToolError('the answer must be a JSON object that maps marker numbers to [x, y]', 'e.g. {"1": [312, 148], "2": [640, 505], ...} with one entry per marker');
  }
  const given = answer as Record<string, unknown>;
  const k = key.size / 1024;
  const limits = { mean: round(4 * k, 2), max: round(10 * k, 2) };
  const ids = Object.keys(key.markers).sort((a, b) => Number(a) - Number(b));
  const markers: VisionCheckMarkerScore[] = ids.map((id) => {
    const expected = key.markers[id];
    const got = readAnswer(given[id]);
    const error = got ? Math.sqrt((got[0] - expected[0]) ** 2 + (got[1] - expected[1]) ** 2) : null;
    return { id, expected, answer: got, error: error === null ? null : round(error, 2) };
  });
  const done = markers.filter((m): m is VisionCheckMarkerScore & { answer: [number, number]; error: number } => m.answer !== null);
  const total = markers.length;
  const answered = done.length;
  const meanOf = (errors: number[]) => errors.reduce((a, b) => a + b, 0) / errors.length;
  const mean = answered ? meanOf(done.map((m) => m.error)) : null;
  const max = answered ? Math.max(...done.map((m) => m.error)) : null;
  const pass = answered === total && mean !== null && max !== null && mean <= limits.mean && max <= limits.max;
  const bias: [number, number] | null = answered
    ? [round(meanOf(done.map((m) => m.answer[0] - m.expected[0])), 2), round(meanOf(done.map((m) => m.answer[1] - m.expected[1])), 2)]
    : null;

  const advice: string[] = [];
  const missing = markers.filter((m) => m.answer === null).map((m) => m.id);
  const unknown = Object.keys(given).filter((id) => !ids.includes(id));
  if (missing.length) advice.push(`No usable answer for marker${missing.length === 1 ? '' : 's'} ${missing.join(', ')}: every marker 1..${total} needs "<number>": [x, y].`);
  if (unknown.length) advice.push(`Ignored entries that are not marker numbers: ${unknown.slice(0, 6).join(', ')}.`);
  if (mean !== null && max !== null) {
    if (pass) {
      advice.push(
        `Mean error ${round(mean, 1)} px, largest ${round(max, 1)} px (limits ${limits.mean} / ${limits.max} px): you read coordinates well enough to place landmarks.` +
          (mean > 2 * k ? ' For eye openings, read them off a zoomed grid ("rev2d avatar grid --region x0,y0,x1,y1"): they need about 2 px.' : ''),
      );
    } else if (answered) {
      advice.push(`Mean error ${round(mean, 1)} px, largest ${round(max, 1)} px; the limits are ${limits.mean} px (mean) and ${limits.max} px (largest).`);
      // Systematic causes: the one that explains the errors best, when it explains at least half.
      const swapped = meanOf(done.map((m) => Math.sqrt((m.answer[1] - m.expected[0]) ** 2 + (m.answer[0] - m.expected[1]) ** 2)));
      const dot = done.reduce((s, m) => s + m.answer[0] * m.expected[0] + m.answer[1] * m.expected[1], 0);
      const norm = done.reduce((s, m) => s + m.expected[0] ** 2 + m.expected[1] ** 2, 0);
      const scale = norm > 0 ? dot / norm : 1;
      const rescaled = scale > 0 && Math.abs(scale - 1) > 0.03 ? meanOf(done.map((m) => Math.sqrt((m.answer[0] / scale - m.expected[0]) ** 2 + (m.answer[1] / scale - m.expected[1]) ** 2))) : Infinity;
      const shifted = bias && Math.sqrt(bias[0] ** 2 + bias[1] ** 2) > 2 * k ? meanOf(done.map((m) => Math.sqrt((m.answer[0] - bias[0] - m.expected[0]) ** 2 + (m.answer[1] - bias[1] - m.expected[1]) ** 2))) : Infinity;
      const best = Math.min(swapped, rescaled, shifted);
      if (best < mean / 2 && best === swapped) {
        advice.push('x and y look swapped: an answer is [x, y] with x counted to the right and y counted downward from the top-left corner.');
      } else if (best < mean / 2 && best === shifted && bias) {
        advice.push(
          `Your answers are shifted by about (${round(bias[0], 1)}, ${round(bias[1], 1)}) px on average: a constant offset. Read the numbers on the grid labels, not pixel positions inside the grid picture (it has ruler margins).`,
        );
      } else if (best < mean / 2 && best === rescaled) {
        advice.push(
          `Your coordinates are about ${round(scale, 3)}x the true ones: you are measuring in a resized copy of the image. Do not estimate pixel positions in your view; read the labelled grid lines of "rev2d avatar grid" (its labels are source pixels at any zoom).`,
        );
      } else {
        const worst = [...done].sort((a, b) => b.error - a.error).slice(0, 3);
        advice.push(
          `Largest errors: ${worst.map((m) => `marker ${m.id} (${round(m.error, 1)} px)`).join(', ')}. Read each marker on a zoomed grid ("rev2d avatar grid <image> --region x0,y0,x1,y1" around it) and take the centre of the crosshair, where its four arms point.`,
        );
      }
    }
  }
  return { pass, mean: mean === null ? null : round(mean, 2), max: max === null ? null : round(max, 2), answered, total, limits, markers, bias, advice: advice.join(' ') };
}
