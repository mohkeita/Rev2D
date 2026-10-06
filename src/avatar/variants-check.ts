/**
 * The check of a drawn variant (step 3 of ./variants.ts): is variants/<id>.png a copy of the
 * illustration in which ONLY the edit areas of its group were redrawn?
 *
 *   size       exactly the size of the source, or nothing else is looked at.
 *   outside    the pixels the mask keeps (fully opaque mask) must stay: their MEAN difference must not
 *              exceed the tolerance (spec.build.variantTolerance, default 2 of 255), which lets
 *              recompression noise through; no more than 0.5% of them may change by more than 40
 *              levels (a new element, a repainted area); in the ring just around the edit areas,
 *              where the sprite's soft edge blends into the picture, the mean may be 2.5 x the
 *              tolerance (a colour step there shows as a seam). Pixels of the source's transparent
 *              background do not count: a generator that fills them in only earns a note, the sprites
 *              never use them.
 *   misaligned when the outside does not match, the check looks for the global shift (up to 8 px) or
 *              zoom (up to 8%) that makes it match, and says so: "shifted by 3 px to the right".
 *   inside     at least 2% of the editable core (of EACH eye for eye variants) must change.
 *
 * Differences are measured per pixel on premultiplied colour (an invisible pixel's colour does not
 * count) as the mean of the three colour channels, or the alpha difference when that is larger.
 * The result carries the numbers and, when the drawing is rejected, a reason and a hint that says
 * what to ask the image generator next. Pure and deterministic.
 */
import type { ImageRGBA } from '../core/types.js';
import type { VariantCheck, VariantGroup, VariantId, AvatarSpec } from './types.js';
import { hashImage, variantEditAreas, variantEditable, variantFiles, VARIANT_TUNING, VARIANTS, type VariantAreaKey, type VariantEditAreas } from './variants-areas.js';

export interface VariantCheckResult extends VariantCheck {
  group: VariantGroup;
  /** The limit `outsideDiff` was held to (spec.build.variantTolerance, default 2). */
  tolerance: number;
  /** Share of the picture's pixels outside the mask that changed by more than 40 levels. */
  badShare: number;
  /** Where those pixels are, [x0, y0, x1, y1] (null when there are none). */
  badBounds: [number, number, number, number] | null;
  /** Mean difference in the ring just around the edit areas (where a seam would show), and its limit. */
  nearDiff: number;
  nearLimit: number;
  /** Per edit area (each eye, or the mouth): the share of its editable core that changed. */
  areas: Array<{ key: VariantAreaKey; changed: number }>;
  /** The drawing's size [width, height]. */
  size: [number, number];
  /** A global misalignment that explains the differences: [dx, dy] px (drawing against source) and a zoom factor about the image centre; null when none was found. */
  shift: [number, number] | null;
  scale: number | null;
  /** Share of the source's transparent background that the drawing filled in. */
  backgroundFilled: number;
  /** Fingerprint of the drawing (hashImage): a sprite cut from it goes stale when the file changes. */
  drawingHash: string;
  /** Observations that do not reject the drawing. */
  notes: string[];
  /** Why it was rejected, as a stable code (with the numbers of the message in `values`), for translated messages. */
  code?: VariantRejectCode;
  values?: Record<string, number | string>;
}

/**
 * Why a drawing was rejected: another size, zoomed or shifted against the source, changed outside the
 * mask (on average, a new element, a seam around the area), nothing redrawn, one eye only; or a file
 * that is no PNG ("unreadable", from the importer).
 */
export type VariantRejectCode = 'size' | 'zoom' | 'shift' | 'outside' | 'bad' | 'seam' | 'unchanged' | 'one-eye' | 'unreadable';

export interface CheckVariantOptions {
  /** The edit areas of the variant's group, when the caller already has them (variantEditAreas). */
  edit?: VariantEditAreas;
  /** How the source is named in messages (default "source.png", or spec.image.file). */
  sourceName?: string;
}

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
const percent = (share: number) => `${round(share * 100, share < 0.1 ? 1 : 0)}%`;

/** Per-pixel difference of two RGBA8 pixels: mean premultiplied colour difference, or the alpha difference when larger (0-255). */
function pixelDiff(s: Uint8ClampedArray, d: Uint8ClampedArray, o: number): number {
  const a1 = s[o + 3];
  const a2 = d[o + 3];
  const c = (Math.abs(s[o] * a1 - d[o] * a2) + Math.abs(s[o + 1] * a1 - d[o + 1] * a2) + Math.abs(s[o + 2] * a1 - d[o + 2] * a2)) / (3 * 255);
  const a = Math.abs(a1 - a2);
  return c > a ? c : a;
}

/** Premultiplied luminance with a share of alpha (so a silhouette over a transparent background has an edge), 0-255. */
function lumaAt(data: Uint8ClampedArray, o: number): number {
  const a = data[o + 3];
  return ((0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) * a) / 255 * 0.75 + a * 0.25;
}

function lumaImage(img: ImageRGBA): Float32Array {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, o = 0; i < out.length; i++, o += 4) out[i] = lumaAt(img.data, o);
  return out;
}

interface Alignment {
  /** Mean luma difference at the identity, at the best shift, at the best shift + zoom. */
  identity: number;
  shift: [number, number];
  shifted: number;
  scale: number;
  scaleShift: [number, number];
  scaled: number;
}

/**
 * Estimate a global misalignment of the drawing against the source from edge pixels outside the
 * edit areas: the integer shift (|dx|, |dy| <= maxShift) and the zoom about the image centre
 * (1 +- maxZoom, then the shift refined around it) with the smallest mean luma difference.
 */
function estimateAlignment(source: ImageRGBA, drawing: ImageRGBA, editable: Float32Array, edit: VariantEditAreas, withZoom: boolean): Alignment | null {
  const T = VARIANT_TUNING;
  const { width: W, height: H } = source;
  const M = T.maxShift + 2;
  if (W <= 2 * M + 4 || H <= 2 * M + 4) return null;
  const src = lumaImage(source);
  const away = (x: number, y: number) =>
    edit.areas.every((a) => x < a.rect.x - M || y < a.rect.y - M || x >= a.rect.x + a.rect.width + M || y >= a.rect.y + a.rect.height + M);
  // Candidate samples: strong edges of the source, away from the edit areas and the image border.
  const candidates: number[] = [];
  for (let y = M; y < H - M; y++) {
    for (let x = M; x < W - M; x++) {
      const p = y * W + x;
      if (editable[p] > 1e-3) continue;
      const g = Math.abs(src[p + 1] - src[p - 1]) + Math.abs(src[p + W] - src[p - W]);
      if (g >= 24 && away(x, y)) candidates.push(p);
    }
  }
  if (candidates.length < 50) return null;
  const stride = Math.max(1, Math.ceil(candidates.length / 6000));
  const samples: number[] = [];
  for (let i = 0; i < candidates.length; i += stride) samples.push(candidates[i]);
  const drawn = new Float32Array(samples.length);
  samples.forEach((p, i) => (drawn[i] = lumaAt(drawing.data, p * 4)));

  const errorAt = (dx: number, dy: number) => {
    const off = dy * W + dx;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += Math.abs(drawn[i] - src[samples[i] - off]);
    return sum / samples.length;
  };
  const identity = errorAt(0, 0);
  let shift: [number, number] = [0, 0];
  let shifted = identity;
  for (let dy = -T.maxShift; dy <= T.maxShift; dy++) {
    for (let dx = -T.maxShift; dx <= T.maxShift; dx++) {
      const e = errorAt(dx, dy);
      if (e < shifted - 1e-9) {
        shifted = e;
        shift = [dx, dy];
      }
    }
  }
  const result: Alignment = { identity, shift, shifted, scale: 1, scaleShift: shift, scaled: shifted };
  if (!withZoom) return result;

  // Zoom about the image centre: drawing(p) = source(c + (p - c - d) / s).
  const cx = W / 2;
  const cy = H / 2;
  const bilinear = (x: number, y: number) => {
    const x0 = Math.floor(x - 0.5);
    const y0 = Math.floor(y - 0.5);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= W || y0 + 1 >= H) return -1;
    const tx = x - 0.5 - x0;
    const ty = y - 0.5 - y0;
    const i = y0 * W + x0;
    return (src[i] * (1 - tx) + src[i + 1] * tx) * (1 - ty) + (src[i + W] * (1 - tx) + src[i + W + 1] * tx) * ty;
  };
  const zoomError = (s: number, dx: number, dy: number) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const px = (p % W) + 0.5;
      const py = Math.floor(p / W) + 0.5;
      const v = bilinear(cx + (px - cx - dx) / s, cy + (py - cy - dy) / s);
      if (v < 0) continue;
      sum += Math.abs(drawn[i] - v);
      n++;
    }
    return n > samples.length / 2 ? sum / n : Infinity;
  };
  let bestScale = 1;
  let bestZoom = identity;
  for (let k = -32; k <= 32; k++) {
    const s = 1 + (k / 32) * T.maxZoom;
    if (k === 0) continue;
    const e = zoomError(s, 0, 0);
    if (e < bestZoom - 1e-9) {
      bestZoom = e;
      bestScale = s;
    }
  }
  if (bestScale !== 1) {
    let best: [number, number] = [0, 0];
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const e = zoomError(bestScale, dx, dy);
        if (e < bestZoom - 1e-9) {
          bestZoom = e;
          best = [dx, dy];
        }
      }
    }
    if (bestZoom < shifted) {
      result.scale = bestScale;
      result.scaleShift = best;
      result.scaled = bestZoom;
    }
  }
  return result;
}

function directions(dx: number, dy: number): string {
  const parts: string[] = [];
  if (dx) parts.push(`${Math.abs(dx)} px to the ${dx > 0 ? 'right' : 'left'}`);
  if (dy) parts.push(`${Math.abs(dy)} px ${dy > 0 ? 'down' : 'up'}`);
  return parts.join(' and ');
}

/**
 * Check a drawing of variant `id` against the source (see the file comment for the rules). Never
 * throws for a bad drawing: the result says whether it is accepted (`ok`) and why not.
 */
export function checkVariantDrawing(spec: AvatarSpec, source: ImageRGBA, id: VariantId, drawing: ImageRGBA, options: CheckVariantOptions = {}): VariantCheckResult {
  const T = VARIANT_TUNING;
  const def = VARIANTS[id];
  const group = def.group;
  const files = variantFiles(id);
  const sourceName = options.sourceName ?? spec.image.file ?? 'source.png';
  const tolerance = spec.build?.variantTolerance ?? T.tolerance;
  const { width: W, height: H } = source;
  const result: VariantCheckResult = {
    id,
    ok: false,
    outsideDiff: 0,
    insideChanged: 0,
    group,
    tolerance,
    badShare: 0,
    badBounds: null,
    nearDiff: 0,
    nearLimit: round(Math.max(tolerance * T.nearFactor, 1), 3),
    areas: [],
    size: [drawing.width, drawing.height],
    shift: null,
    scale: null,
    backgroundFilled: 0,
    drawingHash: hashImage(drawing),
    notes: [],
  };
  const reject = (code: VariantRejectCode, values: Record<string, number | string>, reason: string, hint: string): VariantCheckResult => Object.assign(result, { ok: false, reason, hint, code, values });
  const askAgain = (extra: string) => `Ask the image generator again with ${sourceName} and the mask ${files.mask} (the prompt is in ${files.prompt}) and add: "${extra}"`;

  if (drawing.width !== W || drawing.height !== H) {
    const sameAspect = Math.abs(drawing.width / drawing.height - W / H) < 0.005;
    return reject(
      'size',
      { width: drawing.width, height: drawing.height, sourceWidth: W, sourceHeight: H },
      `the drawing is ${drawing.width}x${drawing.height} px, ${sourceName} is ${W}x${H} px`,
      sameAspect
        ? `Ask the image generator for an output of exactly ${W}x${H} px. If this drawing shows exactly the same framing as ${sourceName} at another size, scale it to ${W}x${H} px and import it again; a crop or another framing cannot be fixed by scaling.`
        : `${askAgain(`The output must be exactly ${W}x${H} px with the same framing as the input: no crop, no padding, no change of the aspect ratio.`)}`,
    );
  }

  const edit = options.edit ?? variantEditAreas(spec, group);
  const editable = variantEditable(edit).data;
  const ring = new Uint8Array(W * H);
  for (const a of edit.areas) {
    for (let y = 0; y < a.rect.height; y++) {
      for (let x = 0; x < a.rect.width; x++) if (a.ring.data[y * a.rect.width + x] > 0) ring[(y + a.rect.y) * W + x + a.rect.x] = 1;
    }
  }

  // Outside the mask: the picture must stay.
  const s = source.data;
  const d = drawing.data;
  let n = 0;
  let sum = 0;
  let bad = 0;
  let nearN = 0;
  let nearSum = 0;
  let background = 0;
  let filled = 0;
  let bx0 = W;
  let by0 = H;
  let bx1 = -1;
  let by1 = -1;
  for (let p = 0, o = 0; p < W * H; p++, o += 4) {
    if (editable[p] > 1e-3) continue;
    if (s[o + 3] < T.backgroundAlpha) {
      background++;
      if (d[o + 3] >= 128) filled++;
      continue;
    }
    const e = pixelDiff(s, d, o);
    n++;
    sum += e;
    if (e > T.bad) {
      bad++;
      const x = p % W;
      const y = (p - x) / W;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
    if (ring[p]) {
      nearN++;
      nearSum += e;
    }
  }
  result.outsideDiff = round(n ? sum / n : 0, 3);
  result.badShare = round(n ? bad / n : 0, 5);
  result.badBounds = bad ? [bx0, by0, bx1 + 1, by1 + 1] : null;
  result.nearDiff = round(nearN ? nearSum / nearN : 0, 3);
  result.backgroundFilled = round(background ? filled / background : 0, 4);
  if (result.backgroundFilled > 0.5) {
    result.notes.push(`the drawing fills in the transparent background of ${sourceName} (${percent(result.backgroundFilled)} of it is opaque): the sprites only use the edit areas, so this does not matter here`);
  }

  // Inside: something must have been drawn, in every area.
  let coreN = 0;
  let changedN = 0;
  for (const a of edit.areas) {
    let core = 0;
    let changed = 0;
    for (let y = 0; y < a.rect.height; y++) {
      for (let x = 0; x < a.rect.width; x++) {
        if (a.mask.data[y * a.rect.width + x] < 0.999) continue;
        core++;
        if (pixelDiff(s, d, ((y + a.rect.y) * W + x + a.rect.x) * 4) > T.changed) changed++;
      }
    }
    coreN += core;
    changedN += changed;
    result.areas.push({ key: a.key, changed: round(core ? changed / core : 0, 4) });
  }
  result.insideChanged = round(coreN ? changedN / coreN : 0, 4);

  const outsideFails = result.outsideDiff > tolerance;
  const nearFails = result.nearDiff > result.nearLimit;
  const badFails = result.badShare > T.maxBadShare;

  // A global shift or zoom explains (and condemns) differences everywhere at once.
  const alignment = estimateAlignment(source, drawing, editable, edit, outsideFails || nearFails || badFails);
  if (alignment) {
    const gain = (e: number) => alignment.identity - e >= 1.5 && e <= 0.6 * alignment.identity;
    const zoomed = alignment.scale !== 1 && gain(alignment.scaled) && alignment.scaled <= 0.9 * alignment.shifted;
    const shifted = (alignment.shift[0] !== 0 || alignment.shift[1] !== 0) && gain(alignment.shifted);
    if (zoomed) {
      result.scale = round(alignment.scale, 4);
      result.shift = alignment.scaleShift[0] || alignment.scaleShift[1] ? alignment.scaleShift : null;
    } else if (shifted) {
      result.shift = alignment.shift;
    }
    const before = round(alignment.identity, 2);
    if (zoomed && (outsideFails || nearFails || badFails || Math.abs(alignment.scale - 1) >= 0.01)) {
      const pct = round(Math.abs(alignment.scale - 1) * 100, 1);
      const extra = result.shift ? ` and shifted by ${directions(result.shift[0], result.shift[1])}` : '';
      return reject(
        'zoom',
        { percent: pct, direction: alignment.scale > 1 ? 'in' : 'out' },
        `the drawing is zoomed ${alignment.scale > 1 ? 'in' : 'out'} by ${pct}% against ${sourceName} (scaled by ${round(alignment.scale, 3)} about the centre${extra}): edges outside the editable area differ by ${before} on average, ${round(alignment.scaled, 2)} with the zoom undone`,
        `${askAgain(`Keep exactly the same framing and size as the input image (${W}x${H} px): no zoom, crop, padding or shift; only the transparent area of the mask changes.`)} If the generator cannot keep the framing, scale its output back by ${round(1 / alignment.scale, 4)} about the centre so the picture lines up with ${sourceName}, then import it again.`,
      );
    }
    if (shifted && !zoomed) {
      const [dx, dy] = alignment.shift;
      const big = Math.max(Math.abs(dx), Math.abs(dy)) >= 2;
      if (big || outsideFails || nearFails || badFails) {
        return reject(
          'shift',
          { dx, dy },
          `the whole drawing is shifted by ${directions(dx, dy)} against ${sourceName}: edges outside the editable area differ by ${before} on average, ${round(alignment.shifted, 2)} with the shift undone`,
          `${askAgain(`Keep exactly the same framing as the input image: no shift, crop, zoom or padding; only the transparent area of the mask changes.`)} Or move the drawing back by ${directions(-dx, -dy)} in an image editor and import it again.`,
        );
      }
      result.notes.push(`the drawing looks shifted by ${directions(dx, dy)}: small enough to accept, but the sprites will sit that much off`);
    }
  }

  const where = result.badBounds ? `, most of them in x ${result.badBounds[0]}..${result.badBounds[2]}, y ${result.badBounds[1]}..${result.badBounds[3]}` : '';
  if (outsideFails) {
    return reject(
      'outside',
      { diff: result.outsideDiff, limit: tolerance },
      `the drawing changes the picture outside the editable area: mean difference ${result.outsideDiff} (limit ${tolerance}); ${percent(result.badShare)} of those pixels changed by more than ${T.bad} levels${where}`,
      `${askAgain('Change only the transparent area of the mask. Every other pixel must stay exactly as in the input image: same framing, colours, line art and background, nothing added or removed.')} If the differences are only fine compression noise, you may raise "build.variantTolerance" in avatar.json (now ${tolerance}).`,
    );
  }
  if (badFails) {
    return reject(
      'bad',
      { share: round(result.badShare * 100, 1) },
      `${percent(result.badShare)} of the picture outside the editable area changed by more than ${T.bad} levels${where}: something was added, removed or repainted there (at most ${percent(T.maxBadShare)} may change that much)`,
      askAgain('Do not add, remove or repaint anything outside the transparent area of the mask; every other pixel stays exactly as in the input image.'),
    );
  }
  if (nearFails) {
    const what = group === 'eyes' ? 'the eyes' : 'the mouth';
    return reject(
      'seam',
      { diff: result.nearDiff, limit: result.nearLimit },
      `the picture just around the editable area changed: mean difference ${result.nearDiff} in the ring around it (limit ${result.nearLimit}); the sprite would show a seam or a colour step there`,
      askAgain(`Keep the skin and the lines around ${what} identical to the input image and blend the redrawn area seamlessly into its unchanged surroundings.`),
    );
  }
  const unchanged = result.areas.filter((a) => a.changed < T.minInsideChange);
  if (unchanged.length === result.areas.length) {
    return reject(
      'unchanged',
      { changed: round(result.insideChanged * 100, 1) },
      `nothing changed inside the editable area: ${percent(result.insideChanged)} of it differs from ${sourceName} (at least ${percent(T.minInsideChange)} must)`,
      `The generator returned the picture (nearly) unchanged. ${askAgain(`Redraw ${def.short}: ${def.draw}`)}`,
    );
  }
  if (unchanged.length) {
    const name = (k: VariantAreaKey) => (k === 'imageLeft' ? 'the eye on the image left' : k === 'imageRight' ? 'the eye on the image right' : 'the mouth');
    const done = result.areas.filter((a) => a.changed >= T.minInsideChange);
    return reject(
      'one-eye',
      { unchanged: unchanged[0].key },
      `only ${done.map((a) => `${name(a.key)} (${percent(a.changed)} of its area)`).join(' and ')} changed; ${unchanged.map((a) => `${name(a.key)} did not (${percent(a.changed)})`).join(', ')}`,
      askAgain(`Redraw BOTH eyes: ${def.short}; ${unchanged.map((a) => name(a.key)).join(' and ')} must change the same way.`),
    );
  }
  result.ok = true;
  return result;
}
