/**
 * Which pixels of the illustration belong to an attachment that is cut into its own layer.
 *
 * A cut-out's outline is traced around the object ("everything that lies IN FRONT"): its pixels are
 * the polygon. A pendulum's outline is often loose (a bounding box, e.g. imported from another
 * tool), so the polygon also holds pieces of what lies around the object (hair, skin, cloth). Those
 * are taken out: the colours just OUTSIDE the outline are what surrounds the object, and whatever
 * inside the outline is connected to its border through such colours (or is transparent) is not
 * the object. What remains and touches the pivot -> tip line is the object. When that leaves almost
 * nothing (the object has the colours of its surroundings), the whole polygon is used.
 *
 * Outlines are drawn by hand and by eye: a pointed end often sticks out of them. The object
 * therefore continues a little beyond its outline through pixels of its own colours (as far as the
 * ring for a pendulum, a couple of px for a traced cut-out), or a sliver of it would stay behind in
 * the picture when it moves. A pendulum does not continue near its pivot: what lies there beyond the
 * outline is what it hangs from (a knot, a bun).
 *
 * Shared by ./hair-mask.ts (hair never takes these pixels) and ./attachments.ts (which cuts them),
 * so both stages see exactly the same object. Pure and deterministic; the work is done in a window
 * around the outline, and the result is remembered per source image (both stages ask for it).
 */
import type { ImageRGBA } from '../../core/types.js';
import type { AvatarMetrics } from '../fields.js';
import { dominantColors, type LabImage } from '../image/color.js';
import { connectedComponents, fillHoles, growRegion } from '../image/components.js';
import { distanceTransform } from '../image/distance.js';
import { createMask, pasteMask } from '../image/mask.js';
import { polygonBounds, translatePoints } from '../image/polygon.js';
import { fillPolygon, strokeMask } from '../image/raster.js';
import { pixelRect, type Lab, type Mask, type Rect } from '../image/types.js';
import { cropImage } from '../../render/image.js';
import type { AvatarAttachment } from '../types.js';

export const OBJECT_TUNING = {
  /** Pixels with at least this alpha count as part of the picture. */
  visible: 128,
  /** Width of the ring outside the outline whose colours are "the surroundings", as a share of the long side (at least 3 px). */
  ring: 0.008,
  /** Largest colour difference (deltaE) between a surrounding pixel inside the outline and the nearest surrounding colour. */
  tolerance: 10,
  /** Colours of the ring that count as surroundings: up to this many, each with at least this share of the ring. */
  ringColours: 6,
  ringShare: 0.03,
  /** Beyond its outline the object continues through pixels this close (deltaE) to its own colours: a pendulum up to the ring width, a cut-out this many px. */
  ownTolerance: 12,
  cutoutBeyond: 2.5,
  /** ... except within this share of its length around a pendulum's pivot. */
  pivotClear: 0.4,
  /** Below this share of the polygon the colour separation is not trusted: the whole polygon is the object. */
  minShare: 0.12,
  /** Enclosed gaps up to this share of the polygon belong to the object (gaps between threads, a highlight). */
  holes: 0.03,
  /** Growth over the antialiased outline of the object, px, and partly transparent pixels this much farther out. */
  rim: 1.25,
  softRim: 2,
} as const;

export interface ObjectMask {
  /** 1 on the object (antialiased outline included), 0 elsewhere. Full size. */
  mask: Mask;
  /** Share of the polygon's visible pixels that is object. */
  share: number;
  /** True when the colour separation was not used (traced outline, or it found too little). */
  wholePolygon: boolean;
}

/** The visible pixels of the polygon (hard 0 / 1). */
function polygonPixels(source: ImageRGBA, outline: readonly number[]): { inside: Mask; count: number } {
  const { width, height } = source;
  const inside = createMask(width, height);
  fillPolygon(inside, outline);
  let count = 0;
  for (let i = 0; i < inside.data.length; i++) {
    inside.data[i] = inside.data[i] >= 0.5 ? 1 : 0;
    if (inside.data[i] && source.data[i * 4 + 3] >= OBJECT_TUNING.visible) count++;
  }
  return { inside, count };
}

/** The object's hard mask grown over its antialiased outline (inside the polygon grown by the rim). */
function withRim(source: ImageRGBA, core: Mask, inside: Mask): Mask {
  const T = OBJECT_TUNING;
  const toCore = distanceTransform(core);
  const toInside = distanceTransform(inside);
  const out = createMask(source.width, source.height);
  for (let i = 0; i < out.data.length; i++) {
    const d = toCore.data[i];
    if (toInside.data[i] > T.rim + T.softRim) continue;
    const alpha = source.data[i * 4 + 3];
    if (d <= T.rim || (alpha > 0 && alpha < 250 && d <= T.rim + T.softRim)) out.data[i] = 1;
  }
  return out;
}

/**
 * The object grown beyond the outline by `beyond` px through pixels of its own colours (only where
 * `allowed` says so), then over its antialiased outline. `inside` is the outline's polygon.
 */
function finish(source: ImageRGBA, lab: LabImage, core: Mask, inside: Mask, toInside: Mask, beyond: number, allowed: (x: number, y: number) => boolean = () => true): Mask {
  const T = OBJECT_TUNING;
  const own = dominantColors(source, core, 3)
    .filter((c) => c.share >= 0.1)
    .map((c) => c.lab);
  let grown = core;
  if (own.length && beyond > 0) {
    const limit = createMask(source.width, source.height);
    const w = source.width;
    for (let i = 0; i < limit.data.length; i++) limit.data[i] = inside.data[i] || (toInside.data[i] <= beyond && allowed((i % w) + 0.5, Math.floor(i / w) + 0.5)) ? 1 : 0;
    const more = growRegion(lab, core, { references: own, tolerance: T.ownTolerance, limit, connectivity: 4, minAlpha: T.visible });
    grown = createMask(source.width, source.height);
    for (let i = 0; i < grown.data.length; i++) grown.data[i] = core.data[i] || more.data[i] ? 1 : 0;
  }
  const reach = createMask(source.width, source.height);
  for (let i = 0; i < reach.data.length; i++) reach.data[i] = inside.data[i] || grown.data[i] ? 1 : 0;
  return withRim(source, grown, reach);
}

/** A window of a Lab image. */
function cropLab(lab: LabImage, r: Rect): LabImage {
  const out: LabImage = { width: r.width, height: r.height, lab: new Float32Array(r.width * r.height * 3), alpha: new Uint8ClampedArray(r.width * r.height) };
  for (let y = 0; y < r.height; y++) {
    const from = (y + r.y) * lab.width + r.x;
    out.lab.set(lab.lab.subarray(from * 3, (from + r.width) * 3), y * r.width * 3);
    out.alpha.set(lab.alpha.subarray(from, from + r.width), y * r.width);
  }
  return out;
}

const memo = new WeakMap<ImageRGBA, Map<string, ObjectMask | null>>();

/** The pixels of an attachment that is cut (pendulum or cut-out); null for a jiggle (nothing is cut). */
export function attachmentObject(attachment: AvatarAttachment, source: ImageRGBA, lab: LabImage, metrics: AvatarMetrics): ObjectMask | null {
  if (attachment.kind === 'jiggle') return null;
  const key = JSON.stringify([attachment, metrics.long]);
  let known = memo.get(source);
  if (!known) memo.set(source, (known = new Map()));
  if (known.has(key)) return known.get(key)!;
  // Everything happens within reach of the outline: the ring, the growth beyond it, the rim.
  const T = OBJECT_TUNING;
  const margin = Math.ceil(Math.max(3, metrics.long * T.ring) + T.rim + T.softRim + 4);
  const r = pixelRect(polygonBounds(attachment.outline), margin, source.width, source.height);
  let result: ObjectMask | null = null;
  if (r.width > 0 && r.height > 0) {
    const shift = (points: readonly number[]) => translatePoints(points, -r.x, -r.y);
    const local: AvatarAttachment =
      attachment.kind === 'pendulum'
        ? { ...attachment, outline: shift(attachment.outline), pivot: [attachment.pivot[0] - r.x, attachment.pivot[1] - r.y], tip: [attachment.tip[0] - r.x, attachment.tip[1] - r.y] }
        : { ...attachment, outline: shift(attachment.outline) };
    const found = objectIn(local, cropImage(source, r.x, r.y, r.width, r.height), cropLab(lab, r), metrics);
    const mask = createMask(source.width, source.height);
    pasteMask(mask, found.mask, r.x, r.y);
    result = { ...found, mask };
  }
  known.set(key, result);
  return result;
}

/** attachmentObject within a window (the attachment's coordinates are those of the window). */
function objectIn(attachment: Exclude<AvatarAttachment, { kind: 'jiggle' }>, source: ImageRGBA, lab: LabImage, metrics: AvatarMetrics): ObjectMask {
  const T = OBJECT_TUNING;
  const { width, height } = source;
  const n = width * height;
  const { inside, count } = polygonPixels(source, attachment.outline);
  const toInside = distanceTransform(inside);
  const ringWidth = Math.max(3, metrics.long * T.ring);
  // A pendulum continues beyond its outline only in its outer part (away from what it hangs from).
  let allowed: (x: number, y: number) => boolean = () => true;
  if (attachment.kind === 'pendulum') {
    const [px, py] = attachment.pivot;
    const length = Math.hypot(attachment.tip[0] - px, attachment.tip[1] - py);
    allowed = (x, y) => Math.hypot(x - px, y - py) > T.pivotClear * length;
  }
  const whole = (): ObjectMask => {
    const core = createMask(width, height);
    for (let i = 0; i < n; i++) core.data[i] = inside.data[i] && source.data[i * 4 + 3] >= T.visible ? 1 : 0;
    const beyond = attachment.kind === 'cutout' ? T.cutoutBeyond : ringWidth;
    return { mask: finish(source, lab, core, inside, toInside, beyond, allowed), share: count > 0 ? 1 : 0, wholePolygon: true };
  };
  if (attachment.kind === 'cutout' || count === 0) return whole();

  // The surroundings: dominant colours of a ring just outside the outline.
  const ring = createMask(width, height);
  for (let i = 0; i < n; i++) ring.data[i] = !inside.data[i] && toInside.data[i] <= ringWidth && source.data[i * 4 + 3] >= 250 ? 1 : 0;
  // A colour of the ring that is more common inside the outline than around it is the object's own
  // (the knot a ribbon hangs from, the cord of a tassel running on above its box).
  const share = (zone: Mask, c: Lab): number => {
    let total = 0;
    let near = 0;
    const tol2 = T.tolerance * T.tolerance;
    for (let i = 0; i < n; i++) {
      if (!zone.data[i] || source.data[i * 4 + 3] < T.visible) continue;
      total++;
      if ((lab.lab[i * 3] - c[0]) ** 2 + (lab.lab[i * 3 + 1] - c[1]) ** 2 + (lab.lab[i * 3 + 2] - c[2]) ** 2 <= tol2) near++;
    }
    return total > 0 ? near / total : 0;
  };
  const surroundings = dominantColors(source, ring, T.ringColours)
    .filter((c) => c.share >= T.ringShare)
    .map((c) => c.lab)
    .filter((c) => share(ring, c) >= share(inside, c));

  // Inside the outline: what is connected to its border through surrounding colours, or transparent.
  const border = createMask(width, height);
  const outsideOf = createMask(width, height);
  for (let i = 0; i < n; i++) outsideOf.data[i] = inside.data[i] ? 0 : 1;
  const toOutside = distanceTransform(outsideOf);
  for (let i = 0; i < n; i++) if (inside.data[i] && toOutside.data[i] <= 1.5) border.data[i] = 1;
  const around = surroundings.length ? growRegion(lab, border, { references: surroundings, tolerance: T.tolerance, limit: inside, connectivity: 4, minAlpha: T.visible }) : createMask(width, height);
  let core = createMask(width, height);
  for (let i = 0; i < n; i++) core.data[i] = inside.data[i] && source.data[i * 4 + 3] >= T.visible && !around.data[i] ? 1 : 0;
  core = fillHoles(core, { maxArea: Math.max(4, count * T.holes) });
  for (let i = 0; i < n; i++) if (!inside.data[i]) core.data[i] = 0;

  // The pieces on the line from the pivot to the tip (or the largest piece).
  const line = strokeMask(width, height, [...attachment.pivot, ...attachment.tip], Math.max(1.5, ringWidth / 2));
  const parts = connectedComponents(core);
  const keep = new Uint8Array(parts.count + 1);
  for (let i = 0; i < n; i++) if (line.data[i] >= 0.5 && parts.labels[i]) keep[parts.labels[i]] = 1;
  if (!keep.some((k) => k === 1) && parts.count > 0) {
    const largest = parts.components.reduce((a, b) => (b.area > a.area ? b : a));
    keep[largest.label] = 1;
  }
  let area = 0;
  for (let i = 0; i < n; i++) {
    core.data[i] = keep[parts.labels[i]] ? 1 : 0;
    if (core.data[i]) area++;
  }
  if (area < count * T.minShare) return whole();
  return { mask: finish(source, lab, core, inside, toInside, ringWidth, allowed), share: area / count, wholePolygon: false };
}
