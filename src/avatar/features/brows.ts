/**
 * Feature "brows": eyebrows (BrowLY / BrowRY), only when face.brows is given.
 *
 * LAYERS. Per brow, the ink along the brow polyline (pixels that are clearly not skin within the
 * brow's measured thickness of the line, its ends extended a little because brows taper, and a rounded
 * end drawn past the line) is lifted off the picture: the base is filled under it by interpolating
 * across the brow between the pixels on both sides, along the direction in which they match (skin
 * stays skin, a bang under the brow stays a bang and its outline runs straight through), and the brow
 * layer holds the DIFFERENCE MATTE against that fill (./eyes-matte.ts), so at rest the composite is the
 * illustration and a moving brow leaves its surroundings behind. Pixels the eye feature claimed
 * (lashes, lids, also the hair over an eye, which it claims weakly) are never taken.
 * Where hair crosses the brow, the brow's own colour decides what is brow (see buildBrow).
 *
 * COMPILE. The brow layer is a part of the root warp (it follows the head), drawn ABOVE the hair
 * (BROW_Z; ./hair.ts continues the bangs under it), whose position is bound to BrowLY / BrowRY
 * (`L` = the character's left = the brow on the image RIGHT): +1 raises it, -1 lowers it, never so
 * far that it would touch the eye region below. The eyes do not move.
 */
import { cloneImage } from '../../render/image.js';
import { AVATAR_Z } from '../fields.js';
import { imageToLab } from '../image/color.js';
import { cropRect, pasteImage } from '../image/compose.js';
import { dilateMask, signedDistance } from '../image/distance.js';
import { connectedComponents } from '../image/components.js';
import { extendEdges } from '../image/inpaint.js';
import { createMask, maskBounds, maskCount } from '../image/mask.js';
import { closestOnPolyline, polygonCentroid, polylineLength, polylinePointAt, translatePoints } from '../image/polygon.js';
import { polygonMask, strokeMask } from '../image/raster.js';
import { pixelRect, type Rect } from '../image/types.js';
import type { Mask } from '../image/types.js';
import type { AvatarPose, AvatarSpec, ImageSide } from '../types.js';
import { blankLike, faceSkinColor, labDistance, maskWhere, medianColor, rgbToLab, round2, writeMatte } from './eyes-matte.js';
import { EYE_TUNING } from './eyes.js';
import type { AvatarFeature, LayersContext } from './types.js';

export const BROW_TUNING = {
  /** Ink differs from the skin by at least this deltaE. */
  ink: 24,
  /** The ink is searched at most this share of the face width away from the polyline. */
  search: 0.07,
  /** The polyline is extended at both ends by this share of its length (brows taper past the points). */
  extend: 0.18,
  /** Soft edge taken with the ink (px). */
  margin: 2,
  /** How far a brow rises at +1, as a share of the face oval's vertical radius. */
  lift: 0.05,
  /** Lowered at most this share of the gap between the brow and the eye region. */
  drop: 0.5,
  /** Ink that continues more than this many brow thicknesses beyond the brow across its line is hair crossing it... */
  crossing: 1.5,
  /** ...unless it has the brow's own colour (within this deltaE): then the brow is drawn over the hair there. */
  sameTone: 20,
  /** Lines darker than the brow by this much (L*) are outlines: the brow's own run along it. */
  darker: 5,
  /** The fill under a brow interpolates across it along the best of 2 * fillAngles + 1 directions within fillSpread degrees of its normal... */
  fillAngles: 6,
  fillSpread: 60,
  /** ...each step away from the normal costing this much colour difference (sum over RGB). */
  fillBend: 6,
} as const;

/**
 * Draw order of the brow layers: ABOVE the hair (AVATAR_Z.hair + 2). Illustrations draw brows over the
 * bangs (or the bangs hide them, and then the hidden part is simply not in the layer); ./hair.ts
 * continues the bangs under the brows, so a swinging bang passes under a brow and a raised brow
 * leaves the bang whole.
 */
export const BROW_Z = AVATAR_Z.hair + 2;

/** Model id per image side: `L` is the character's left, the brow on the image RIGHT. */
const BROW_IDS: Record<ImageSide, 'browL' | 'browR'> = { imageLeft: 'browR', imageRight: 'browL' };
const BROW_PARAM: Record<ImageSide, 'BrowLY' | 'BrowRY'> = { imageLeft: 'BrowRY', imageRight: 'BrowLY' };

export interface BrowMeta {
  /** "browL" | "browR": the layer and part id. */
  id: string;
  /** Measured thickness of the brow (px). */
  thickness: number;
  /** Px the brow rises at +1 and sinks at -1. */
  lift: number;
  drop: number;
}

export interface BrowsMeta {
  version: 1;
  imageLeft?: BrowMeta;
  imageRight?: BrowMeta;
}

/** The polyline with both ends pushed outward along their end segments by `share` of its length. */
function extendPolyline(points: readonly number[], share: number): number[] {
  const n = points.length >> 1;
  if (n < 2) return [...points];
  const length = polylineLength(points);
  const out = [...points];
  const push = (i: number, j: number) => {
    const dx = points[i * 2] - points[j * 2];
    const dy = points[i * 2 + 1] - points[j * 2 + 1];
    const d = Math.hypot(dx, dy) || 1;
    return [points[i * 2] + (dx / d) * share * length, points[i * 2 + 1] + (dy / d) * share * length];
  };
  const head = push(0, 1);
  const tail = push(n - 1, n - 2);
  out[0] = head[0];
  out[1] = head[1];
  out[out.length - 2] = tail[0];
  out[out.length - 1] = tail[1];
  return out;
}

/**
 * Where the brows feature looks for brow ink: a band of its search radius along each brow polyline
 * (ends extended), full size. ./hair.ts uses it to find the brow pixels the brows feature took.
 */
export function browSearchBand(spec: AvatarSpec, width: number, height: number): Mask {
  const out = createMask(width, height);
  const lines = spec.face.brows;
  if (!lines) return out;
  const search = Math.max(3, BROW_TUNING.search * 2 * spec.face.radius[0]);
  for (const side of ['imageLeft', 'imageRight'] as const) {
    if (lines[side].length < 4) continue;
    const band = strokeMask(width, height, extendPolyline(lines[side], BROW_TUNING.extend), search);
    for (let i = 0; i < out.data.length; i++) if (band.data[i] > out.data[i]) out.data[i] = band.data[i];
  }
  return out;
}

function buildBrow(ctx: LayersContext, side: ImageSide, line: readonly number[]): BrowMeta | null {
  const T = BROW_TUNING;
  const { source, spec } = ctx;
  const path = `/face/brows/${side}`;
  if (line.length < 4) return null;
  const extended = extendPolyline(line, T.extend);
  const search = Math.max(3, T.search * 2 * spec.face.radius[0]);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < extended.length; i += 2) {
    x0 = Math.min(x0, extended[i]);
    y0 = Math.min(y0, extended[i + 1]);
    x1 = Math.max(x1, extended[i]);
    y1 = Math.max(y1, extended[i + 1]);
  }
  const win = pixelRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, Math.ceil(search * 2.5), source.width, source.height);
  const ww = win.width;
  const wh = win.height;
  const n = ww * wh;
  if (n === 0) return null;
  const src = cropRect(source, win);
  const lab = imageToLab(src);
  const local = translatePoints(extended, -win.x, -win.y);
  const near = strokeMask(ww, wh, local, search);
  // Pixels the eye feature claimed (the hair over an eye too, which it claims weakly) and everything
  // inside an eye region belong to the eyes.
  const claimed = cropClaimed(ctx, win);
  for (let i = 0; i < claimed.length; i++) if (claimed[i] >= EYE_TUNING.frontClaim) claimed[i] = 1;
  for (const eye of [spec.face.eyes.imageLeft, spec.face.eyes.imageRight]) {
    const region = dilateMask(polygonMask(ww, wh, translatePoints(eye.region, -win.x, -win.y)), 2);
    for (let i = 0; i < claimed.length; i++) claimed[i] = Math.max(claimed[i], region.data[i]);
  }

  // The skin around the brow and the ink on it.
  const faceSkin = faceSkinColor(source, spec);
  const faceLab = rgbToLab(faceSkin[0], faceSkin[1], faceSkin[2]);
  const whole: Rect = { x: 0, y: 0, width: ww, height: wh };
  const skin = medianColor(src, whole, (_x, _y, i) => near.data[i] < 0.5 && labDistance(lab, i, faceLab) < 18, 12) ?? faceSkin;
  const skinLab = rgbToLab(skin[0], skin[1], skin[2]);
  const isInk = (i: number) => claimed[i] < 0.5 && (src.data[i * 4 + 3] < 128 || labDistance(lab, i, skinLab) > T.ink);

  // Thickness: the ink run across the line at points along it, where skin bounds it on both sides
  // (a run that reaches the search limit crosses hair and says nothing about the brow).
  const runs: number[] = [];
  const all: number[] = [];
  for (let k = 0; k <= 16; k++) {
    const p = polylinePointAt(local, 0.1 + 0.05 * k);
    // The normal of the line there.
    const nx = -p.dy;
    const ny = p.dx;
    let run = 0;
    let open = false;
    for (const dir of [-1, 1]) {
      let d = dir < 0 ? 1 : 0;
      for (; d <= search; d++) {
        const px = Math.floor(p.x + dir * d * nx);
        const py = Math.floor(p.y + dir * d * ny);
        if (px < 0 || py < 0 || px >= ww || py >= wh || !isInk(py * ww + px)) break;
        run++;
      }
      if (d > search) open = true;
    }
    all.push(run);
    if (!open) runs.push(run);
  }
  const pick = runs.length >= 3 ? runs : all;
  pick.sort((a, b) => a - b);
  const thickness = pick[pick.length >> 1];
  if (thickness < 1) {
    ctx.report.info('avatar-brow-not-found', `no brow ink along the ${side} brow line: the brow is left in the picture and does not move`, { path, hint: 'trace the polyline along the middle of the visible brow, or leave face.brows out when hair hides the brows' });
    return null;
  }
  const radius = Math.min(search, thickness / 2 + 2);
  const band = strokeMask(ww, wh, local, radius);
  // Hair crossing the brow (a bang that ends on it or runs over it) has the brow's colour on many
  // illustrations: what continues as ink far across the line, beyond the brow's thickness, is hair
  // and stays in the picture (the hair layer above moves it).
  const crossing = (x: number, y: number, alongSegment = false): boolean => {
    const p = closestOnPolyline(local, x + 0.5, y + 0.5);
    const dx = x + 0.5 - p.x;
    const dy = y + 0.5 - p.y;
    const len = Math.hypot(dx, dy);
    // The normal of the line there (any of the two when the pixel lies on it).
    const seg = p.segment * 2;
    const tx = local[seg + 2] - local[seg];
    const ty = local[seg + 3] - local[seg + 1];
    const tl = Math.hypot(tx, ty) || 1;
    // (Past an end of the line the direction to the pixel runs along the line: the segment's normal is used.)
    const nx = len > 0.5 && !alongSegment ? dx / len : -ty / tl;
    const ny = len > 0.5 && !alongSegment ? dy / len : tx / tl;
    for (const dir of [-1, 1]) {
      let run = 0;
      for (let d = radius; d <= radius + T.crossing * thickness; d++) {
        const px = Math.floor(p.x + dir * nx * d);
        const py = Math.floor(p.y + dir * ny * d);
        if (px < 0 || py < 0 || px >= ww || py >= wh || !isInk(py * ww + px)) break;
        run++;
      }
      if (run > T.crossing * thickness) return true;
    }
    return false;
  };
  // Where ink crosses the line, the brow's own colour decides: a brow drawn over the bangs in the
  // hair's colour (hana) keeps its whole line; a lock of another colour in front of it stays hair.
  const candidates = maskWhere(ww, wh, (i) => band.data[i] >= 0.5 && isInk(i));
  const across = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (candidates.data[i] === 1 && crossing(i % ww, Math.floor(i / ww))) across[i] = 1;
  const own = medianColor(src, { x: 0, y: 0, width: ww, height: wh }, (_x, _y, i) => candidates.data[i] === 1 && across[i] === 0, 4);
  const ownLab = own ? rgbToLab(own[0], own[1], own[2]) : null;
  // Over hair the brow is only as wide as itself: the hair beside it stays hair. Of the lines darker
  // than the brow there, those that run along the brow are its outline; those that run across it
  // are the outlines of the locks.
  const core = strokeMask(ww, wh, local, thickness / 2 + 0.5);
  const ownL = ownLab ? ownLab[0] : 0;
  const darkRun = (x: number, y: number, ux: number, uy: number): number => {
    let run = 0;
    for (const dir of [-1, 1]) {
      for (let d = 1; d <= 2 * thickness; d++) {
        const px = Math.floor(x + 0.5 + dir * ux * d);
        const py = Math.floor(y + 0.5 + dir * uy * d);
        if (px < 0 || py < 0 || px >= ww || py >= wh || lab.lab[(py * ww + px) * 3] >= ownL - T.darker) break;
        run++;
      }
    }
    return run;
  };
  const alongBrow = (i: number): boolean => {
    const x = i % ww;
    const y = Math.floor(i / ww);
    const p = closestOnPolyline(local, x + 0.5, y + 0.5);
    const seg = p.segment * 2;
    const tx = local[seg + 2] - local[seg];
    const ty = local[seg + 3] - local[seg + 1];
    const tl = Math.hypot(tx, ty) || 1;
    return darkRun(x, y, tx / tl, ty / tl) >= darkRun(x, y, -ty / tl, tx / tl);
  };
  const ink = maskWhere(ww, wh, (i) => {
    if (candidates.data[i] !== 1) return false;
    if (across[i] === 0) return true;
    if (core.data[i] < 0.5 || ownLab === null || labDistance(lab, i, ownLab) >= T.sameTone) return false;
    return lab.lab[i * 3] >= ownL - T.darker || alongBrow(i);
  });
  if (maskCount(ink) === 0) return null;
  // A brow drawn on past the traced line (a rounded end, wider than the band) comes with it: ink joined
  // to the brow at either end, at most a thickness beyond its band, that does not run on across the
  // line (hair).
  const total = polylineLength(local);
  const cap = maskWhere(ww, wh, (i) => {
    if (ink.data[i] === 1 || !isInk(i)) return false;
    const x = i % ww;
    const y = Math.floor(i / ww);
    const p = closestOnPolyline(local, x + 0.5, y + 0.5);
    if (p.s > thickness && p.s < total - thickness) return false;
    return p.distance <= radius + thickness && !crossing(x, y, true);
  });
  if (maskCount(cap) > 0) {
    const joined = connectedComponents(maskWhere(ww, wh, (i) => ink.data[i] === 1 || cap.data[i] === 1), { connectivity: 8 });
    const brow = new Uint8Array(joined.count + 1);
    for (let i = 0; i < n; i++) if (ink.data[i] === 1 && joined.labels[i]) brow[joined.labels[i]] = 1;
    for (let i = 0; i < n; i++) if (cap.data[i] === 1 && brow[joined.labels[i]] === 1) ink.data[i] = 1;
  }
  // The soft edge of the brow comes with it; ink that is not the brow's (hair next to it) does not.
  const soft = dilateMask(ink, T.margin);
  const hole = maskWhere(ww, wh, (i) => claimed[i] < 0.5 && soft.data[i] >= 0.5 && (ink.data[i] === 1 || !isInk(i)));
  if (!maskBounds(hole)) return null;

  const before = cropRect(ctx.base, win);
  // The fill continues whatever crosses the brow: each pixel is interpolated between the pixels on
  // both sides of the brow along the direction (near the brow's normal) in which they match best, so
  // skin stays skin and a bang under a brow keeps its edges and outlines straight through (a smooth
  // membrane would smear the two into a grey band, the nearest pixels would leave a notch where an
  // outline crosses). So the matte holds only what sets the brow apart from its surroundings, and the
  // edge of the hole matches the picture. Lashes and lids the eye feature took do not feed it.
  const holed = cloneImage(before);
  for (let i = 0; i < n; i++) if (hole.data[i] === 1 || claimed[i] >= 0.5) holed.data[i * 4 + 3] = 0;
  const reachFill = Math.ceil(radius + T.margin + 2);
  const carried = extendEdges(holed, reachFill);
  const filled = cloneImage(before);
  const span = Math.ceil(2 * (radius + T.margin)) + 2;
  const known = (x: number, y: number): number => {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= ww || py >= wh) return -1;
    const j = py * ww + px;
    return holed.data[j * 4 + 3] > 0 ? j : -1;
  };
  for (let i = 0; i < n; i++) {
    if (hole.data[i] !== 1) continue;
    const x = (i % ww) + 0.5;
    const y = Math.floor(i / ww) + 0.5;
    const p = closestOnPolyline(local, x, y);
    const seg = p.segment * 2;
    const tl = Math.hypot(local[seg + 2] - local[seg], local[seg + 3] - local[seg + 1]) || 1;
    const nx = -(local[seg + 3] - local[seg + 1]) / tl;
    const ny = (local[seg + 2] - local[seg]) / tl;
    let best = Infinity;
    let value: [number, number, number] | null = null;
    for (let k = -T.fillAngles; k <= T.fillAngles; k++) {
      const angle = (k * T.fillSpread * Math.PI) / (180 * T.fillAngles);
      const dx = nx * Math.cos(angle) - ny * Math.sin(angle);
      const dy = nx * Math.sin(angle) + ny * Math.cos(angle);
      let a = -1;
      let da = 0;
      for (let d = 1; d <= span && a < 0; d++) {
        a = known(x + dx * d, y + dy * d);
        da = d;
      }
      let b = -1;
      let db = 0;
      for (let d = 1; d <= span && b < 0; d++) {
        b = known(x - dx * d, y - dy * d);
        db = d;
      }
      if (a < 0 || b < 0) continue;
      let cost = Math.abs(k) * T.fillBend;
      for (let c = 0; c < 3; c++) cost += Math.abs(holed.data[a * 4 + c] - holed.data[b * 4 + c]);
      if (cost >= best) continue;
      best = cost;
      const t = da / (da + db);
      value = [0, 1, 2].map((c) => Math.round(holed.data[a * 4 + c] * (1 - t) + holed.data[b * 4 + c] * t)) as [number, number, number];
    }
    const from = value ?? [carried.data[i * 4], carried.data[i * 4 + 1], carried.data[i * 4 + 2]];
    filled.data[i * 4] = from[0];
    filled.data[i * 4 + 1] = from[1];
    filled.data[i * 4 + 2] = from[2];
  }
  const layer = blankLike(src);
  for (let i = 0; i < n; i++) if (hole.data[i] === 1) writeMatte(layer, src, filled, i);
  const bounds = maskBounds(hole) as Rect;
  const rect = pixelRect(bounds, 2, ww, wh);

  // How far the brow may sink before it meets the eye region below it.
  const eyes = spec.face.eyes;
  const centre = polygonCentroid(line);
  const eye = [eyes.imageLeft, eyes.imageRight].sort((a, b) => dist(polygonCentroid(a.region), centre) - dist(polygonCentroid(b.region), centre))[0];
  const region = polygonMask(ww, wh, translatePoints(eye.region, -win.x, -win.y));
  const toRegion = signedDistance(region);
  let gap = Infinity;
  for (let i = 0; i < n; i++) if (ink.data[i] === 1) gap = Math.min(gap, toRegion.data[i]);
  const lift = round2(T.lift * spec.face.radius[1]);
  const drop = round2(Math.max(0, Math.min(lift, Number.isFinite(gap) ? T.drop * gap : lift)));

  const id = BROW_IDS[side];
  const base = cloneImage(ctx.base);
  pasteImage(base, filled, win.x, win.y);
  ctx.base = base;
  ctx.addLayer(id, extendEdges(cropRect(layer, rect), 2), [rect.x + win.x, rect.y + win.y, rect.width, rect.height]);
  ctx.claim(hole, win.x, win.y);
  ctx.report.stat(`${id}Thickness`, thickness);
  if (drop < 1) ctx.report.info('avatar-brow-close', `the ${side} brow touches the eye region: it is not lowered (BrowRY / BrowLY < 0 do nothing)`, { path });
  return { id, thickness, lift, drop };
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** The claimed mask over a window, as a plain array. */
function cropClaimed(ctx: LayersContext, win: Rect): Float32Array {
  const out = new Float32Array(win.width * win.height);
  const claimed = ctx.claimed;
  for (let y = 0; y < win.height; y++) {
    for (let x = 0; x < win.width; x++) out[y * win.width + x] = claimed.data[(y + win.y) * claimed.width + x + win.x];
  }
  return out;
}

function isBrowMeta(value: unknown): value is BrowMeta {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Partial<BrowMeta>;
  return typeof b.id === 'string' && typeof b.lift === 'number' && Number.isFinite(b.lift) && typeof b.drop === 'number' && Number.isFinite(b.drop);
}

export const brows: AvatarFeature = {
  id: 'brows',
  summary: 'eyebrows (BrowLY / BrowRY): each brow lifted off the skin into its own layer that rises and sinks, only when face.brows is given',

  layers(ctx) {
    const lines = ctx.spec.face.brows;
    if (!lines) return;
    const meta: BrowsMeta = { version: 1 };
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const brow = buildBrow(ctx, side, lines[side]);
      if (brow) meta[side] = brow;
    }
    ctx.setMeta('brows', meta);
  },

  compile(ctx) {
    if (!ctx.spec.face.brows) return;
    const meta = ctx.featureMeta<BrowsMeta>('brows');
    if (!meta || typeof meta !== 'object') return;
    const { model, root } = ctx;
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const brow = meta[side];
      if (!isBrowMeta(brow)) continue;
      const layer = ctx.layer(brow.id);
      if (!layer || !(brow.lift > 0 || brow.drop > 0)) continue;
      const param = model.parameter(BROW_PARAM[side]);
      model.imagePart(layer, { parent: root.id, z: BROW_Z, description: `Brow on the image ${side === 'imageLeft' ? 'left' : 'right'}: ${param} raises (+) and lowers (-) it.` });
      const y = layer.rect[1];
      model.bind({ id: `${brow.id}Y`, target: `part:${brow.id}.shape.y`, params: [param], keys: [{ at: [-1], value: round2(y + brow.drop) }, { at: [0], value: y }, { at: [1], value: round2(y - brow.lift) }] });
    }
  },

  poses(ctx): AvatarPose[] {
    if (!ctx.spec.face.brows) return [];
    return [
      { id: 'brows_up', label: 'brows up (BrowLY / BrowRY 1)', params: { BrowLY: 1, BrowRY: 1 }, zoom: 'eyes' },
      { id: 'brows_down', label: 'brows down (BrowLY / BrowRY -1)', params: { BrowLY: -1, BrowRY: -1 }, zoom: 'eyes' },
    ];
  },
};

