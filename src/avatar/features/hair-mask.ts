/**
 * The hair mask of the avatar builder: which pixels of the illustration are hair.
 *
 * Method (pure, deterministic; colours are compared in CIE Lab):
 * 1. SKIN: the dominant colours around the nose, away from the eyes, the mouth and the strands.
 * 2. HAIR TONES: a small k-means over the pixels under the strand polylines (thin strokes), without
 *    the skin-like ones, so a strand that crosses a patch of skin does not teach skin as hair.
 *    Several tones cover gradients, shading and highlights that a strand passes through.
 * 3. GROW from the strand strokes through connected pixels within a tolerance of the nearest tone,
 *    inside the LIMIT: the head ellipse (taken a little larger, with the ellipses of springy masses
 *    on the head: buns), plus a corridor around every strand (long hair below the head). Where a
 *    hair tone could be mistaken for the clothing (dark hair on a dark dress), a pixel below the
 *    chin and outside the corridors must be clearly nearer to the hair than to the clothing. Pixels
 *    another feature has claimed (eye layers), the brows and the attachments that are cut
 *    (./attachments-object.ts) are never hair.
 * 4. CLEAN UP: holes that are not skin and not transparent (highlights, ornaments inside the hair)
 *    are filled, specks are dropped, and the region is grown by the width of the antialiased outline
 *    plus every partly transparent pixel next to it, so the WHOLE outline and silhouette belong to
 *    the hair (a rim left in the base would stay behind as a ghost line when a lock swings).
 *
 * The result is a hard mask (0 / 1); ./hair.ts feathers it for the layer. Besides the mask the
 * numbers that tell whether it can be trusted: coverage, how much of the lower face it covers, and
 * for every strand the share of its polyline that lies on hair.
 */
import type { ImageRGBA } from '../../core/types.js';
import type { AvatarMetrics } from '../fields.js';
import { dominantColors, type LabImage } from '../image/color.js';
import { fillHoles, growRegion, removeSmallComponents } from '../image/components.js';
import { distanceTransform } from '../image/distance.js';
import { createMask } from '../image/mask.js';
import { ellipseMask, fillPolygon, strokeMask } from '../image/raster.js';
import type { Lab, Mask } from '../image/types.js';
import type { AvatarSpec } from '../types.js';

export const HAIR_MASK_TUNING = {
  /** Pixels with at least this alpha count as opaque (illustrations with a removed background are often 250-254 where they look solid). */
  opaque: 250,
  /** Number of hair tones looked for under the strands, and the smallest share a tone needs to count. */
  tones: 5,
  toneShare: 0.03,
  /** Largest colour difference (deltaE) between a hair pixel and the nearest hair tone. */
  tolerance: 12,
  /** Pixels this close (deltaE) to a skin colour are skin: never a hair tone. */
  skinTolerance: 10,
  /** Holes in the hair this close to a skin colour stay holes (an ear, a patch of forehead between two locks, both often in shade). */
  holeSkinTolerance: 20,
  /** A hair tone this close to a clothing colour (tolerance + this) is a conflict: below the chin a pixel outside the strand corridors must then be clearly nearer to the hair than to the clothing. */
  clothingMargin: 6,
  /** The head ellipse is taken this much larger (it is placed by eye, and a bun often sticks out of it). */
  headReach: 1.12,
  /** Radius of the seed stroke along a strand, as a share of the strand width (at least 1 px). */
  seedShare: 0.12,
  /** Half width of the corridor around a strand in which hair may grow outside the head ellipse, in strand widths. */
  corridor: 1,
  /** Growth over the outline: this share of the long image side, within [min, max] px. */
  rimShare: 0.0016,
  rimMin: 1.25,
  rimMax: 3,
  /** Partly transparent pixels this much farther out still join (the soft silhouette). */
  softRim: 2.5,
  /** Components smaller than this share of the image are dropped (at least 6 px). */
  speckShare: 0.00002,
} as const;

export interface HairMaskStrand {
  id: string;
  /** Share of the strand's seed stroke that ended up in the mask (1 = the polyline lies on hair). */
  onHair: number;
}

export interface HairMask {
  /** 1 on hair (outline and silhouette included), 0 elsewhere. */
  mask: Mask;
  /** Where hair may never be: claimed pixels, unclaimed eye regions, brows, cut attachments. */
  blocked: Mask;
  /** The hair tones found under the strands and the skin colours, in Lab. */
  tones: Lab[];
  skin: Lab[];
  /** True when hair and clothing colours are close: below the chin, outside the strand corridors, only pixels clearly nearer to the hair count. */
  clothingConflict: boolean;
  /** Hair pixels as a share of the visible pixels inside the head ellipse. */
  coverage: number;
  /** Share of the lower face (around the nose, away from the strands) that the mask covers: a leak when not ~0. */
  faceShare: number;
  /** Number of hair pixels. */
  area: number;
  strands: HairMaskStrand[];
}

interface Inputs {
  spec: AvatarSpec;
  metrics: AvatarMetrics;
  source: ImageRGBA;
  lab: LabImage;
  /** Pixels other features have cut into their own layers (0..1), full size. */
  claimed: Mask;
  /** The pixels of the attachments that are cut into their own layers (./attachments-object.ts), full size. */
  objects?: Mask;
}

function nearest(lab: Float32Array, i: number, refs: Lab[]): number {
  let best = Infinity;
  const L = lab[i * 3];
  const a = lab[i * 3 + 1];
  const b = lab[i * 3 + 2];
  for (const r of refs) {
    const d = (L - r[0]) ** 2 + (a - r[1]) ** 2 + (b - r[2]) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function minDistance(a: Lab[], b: Lab[]): number {
  let best = Infinity;
  for (const p of a) for (const q of b) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  return best;
}

/**
 * Where the strands are, computed once: `rel` = per pixel the smallest distance (from its centre)
 * to a strand polyline in widths of that strand (Infinity farther than `reach` widths), and per
 * strand the pixels of its seed line (within max(1 px, seedShare x width)).
 */
interface StrandMap {
  rel: Float32Array;
  seeds: Int32Array[];
}

function strandMap(width: number, height: number, spec: AvatarSpec, reach: number): StrandMap {
  const rel = new Float32Array(width * height).fill(Infinity);
  const seeds: Int32Array[] = [];
  for (const strand of spec.hair?.strands ?? []) {
    const nodes = strand.nodes;
    const count = Math.floor(nodes.length / 2);
    const seedRadius = Math.max(1, strand.width * HAIR_MASK_TUNING.seedShare);
    const far = Math.max(seedRadius, strand.width * reach) + 1;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < count; k++) {
      x0 = Math.min(x0, nodes[k * 2]);
      x1 = Math.max(x1, nodes[k * 2]);
      y0 = Math.min(y0, nodes[k * 2 + 1]);
      y1 = Math.max(y1, nodes[k * 2 + 1]);
    }
    const list: number[] = [];
    for (let y = Math.max(0, Math.floor(y0 - far)); y < Math.min(height, Math.ceil(y1 + far)); y++) {
      for (let x = Math.max(0, Math.floor(x0 - far)); x < Math.min(width, Math.ceil(x1 + far)); x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let best = Infinity;
        for (let k = 0; k < Math.max(1, count - 1); k++) {
          const ax = nodes[k * 2];
          const ay = nodes[k * 2 + 1];
          const dx = (count > 1 ? nodes[k * 2 + 2] : ax) - ax;
          const dy = (count > 1 ? nodes[k * 2 + 3] : ay) - ay;
          const len2 = dx * dx + dy * dy;
          const u = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
          const d2 = (ax + dx * u - px) ** 2 + (ay + dy * u - py) ** 2;
          if (d2 < best) best = d2;
        }
        const d = Math.sqrt(best);
        const i = y * width + x;
        if (d / strand.width < rel[i]) rel[i] = d / strand.width;
        if (d <= seedRadius) list.push(i);
      }
    }
    seeds.push(Int32Array.from(list));
  }
  return { rel, seeds };
}

/**
 * Where hair may never be, as a hard mask: pixels another feature has claimed, attachments that are
 * cut (`objects`: they lie in front), the brows, and an eye region that nothing has claimed yet. (The eye feature
 * claims its region WITHOUT the hair that hangs in front of the eye, so that hair stays free for the
 * hair layer; when no eye layers were cut, lashes and irises are kept out by the region itself.)
 */
export function hairBlocked(spec: AvatarSpec, metrics: AvatarMetrics, claimed: Mask, objects?: Mask): Mask {
  const { width, height } = metrics;
  const out = createMask(width, height);
  for (const eye of [spec.face.eyes.imageLeft, spec.face.eyes.imageRight]) {
    const region = createMask(width, height);
    fillPolygon(region, eye.region);
    let taken = false;
    for (let i = 0; i < region.data.length && !taken; i++) taken = region.data[i] >= 0.5 && claimed.data[i] >= 0.5;
    if (!taken) for (let i = 0; i < region.data.length; i++) if (region.data[i] > out.data[i]) out.data[i] = region.data[i];
  }
  const brows = browBand(spec, metrics, claimed);
  for (let i = 0; i < out.data.length; i++) out.data[i] = out.data[i] >= 0.5 || brows.data[i] >= 0.5 || claimed.data[i] >= 0.5 || (objects !== undefined && objects.data[i] >= 0.5) ? 1 : 0;
  return out;
}

/** Radius of the band along a brow polyline that counts as brow: 3.5% of the face width (at least 1.5 px). */
export function browRadius(spec: AvatarSpec): number {
  return Math.max(1.5, spec.face.radius[0] * 0.035);
}

/** A brow band counts as cut by another feature when that feature claimed at least this share of it. */
const BROW_CLAIMED = 0.25;

/**
 * The brows that no other feature has cut, as an antialiased band along their polylines (empty
 * without face.brows). Brows have the colour of the hair and often touch or cross the bangs: hair
 * never takes them (a brow in the hair layer would sway), and ./hair.ts draws them again above the
 * hair. A brow the brows feature cut into its own layer (it claimed a good part of the band) is left
 * to that feature: the claimed pixels keep the hair out, and a static copy would double a moving brow.
 */
export function browBand(spec: AvatarSpec, metrics: AvatarMetrics, claimed?: Mask): Mask {
  const out = createMask(metrics.width, metrics.height);
  const brows = spec.face.brows;
  if (!brows) return out;
  for (const line of [brows.imageLeft, brows.imageRight]) {
    const stroke = strokeMask(metrics.width, metrics.height, line, browRadius(spec));
    if (claimed) {
      let band = 0;
      let taken = 0;
      for (let i = 0; i < stroke.data.length; i++) {
        if (stroke.data[i] < 0.5) continue;
        band++;
        if (claimed.data[i] >= 0.5) taken++;
      }
      if (band > 0 && taken >= BROW_CLAIMED * band) continue;
    }
    for (let i = 0; i < out.data.length; i++) if (stroke.data[i] > out.data[i]) out.data[i] = stroke.data[i];
  }
  return out;
}

/** The skin colours of the face: the dominant colours around the nose, away from eyes, mouth and strands. */
function skinColours(inputs: Inputs, blocked: Mask, map: StrandMap): Lab[] {
  const { spec, source } = inputs;
  const { width, height } = source;
  const face = spec.face;
  const zone = ellipseMask(width, height, face.nose[0], face.nose[1], face.radius[0] * 0.45, face.radius[1] * 0.35);
  const area = face.mouth.area;
  const mouth = ellipseMask(width, height, area.center[0], area.center[1], area.radius[0] * 1.15, area.radius[1] * 1.15, area.rotation);
  for (let i = 0; i < zone.data.length; i++) {
    if (zone.data[i] < 0.5 || mouth.data[i] > 0 || blocked.data[i] > 0 || map.rel[i] <= 0.5 || source.data[i * 4 + 3] < HAIR_MASK_TUNING.opaque) zone.data[i] = 0;
    else zone.data[i] = 1;
  }
  return dominantColors(source, zone, 2)
    .filter((c) => c.share >= 0.15)
    .map((c) => c.lab);
}

/** The dominant colours of the clothing: the chest ellipse below the neck, without the strand corridors. */
function clothingColours(inputs: Inputs, map: StrandMap): Lab[] {
  const { spec, source } = inputs;
  const { width, height } = source;
  const chest = spec.body.chest;
  const zone = ellipseMask(width, height, chest.center[0], chest.center[1], chest.radius[0], chest.radius[1]);
  const top = spec.head.neck[1];
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      zone.data[i] = zone.data[i] >= 0.5 && y >= top && map.rel[i] > HAIR_MASK_TUNING.corridor && source.data[i * 4 + 3] >= HAIR_MASK_TUNING.opaque ? 1 : 0;
    }
  }
  return dominantColors(source, zone, 3)
    .filter((c) => c.share >= 0.1)
    .map((c) => c.lab);
}

/** Build the hair mask (see the file header). Without strands, or when no hair tone is found, the mask is empty. */
export function buildHairMask(inputs: Inputs): HairMask {
  const T = HAIR_MASK_TUNING;
  const { spec, metrics, source, lab, claimed, objects } = inputs;
  const { width, height } = source;
  const n = width * height;
  const strands = spec.hair?.strands ?? [];
  const blocked = hairBlocked(spec, metrics, claimed, objects);
  const empty: HairMask = { mask: createMask(width, height), blocked, tones: [], skin: [], clothingConflict: false, coverage: 0, faceShare: 0, area: 0, strands: strands.map((s) => ({ id: s.id, onHair: 0 })) };
  if (strands.length === 0) return empty;

  const alpha = (i: number) => source.data[i * 4 + 3];
  const map = strandMap(width, height, spec, T.corridor);
  const skin = skinColours(inputs, blocked, map);
  const skinLike = (i: number, tolerance: number = T.skinTolerance) => skin.length > 0 && nearest(lab.lab, i, skin) < tolerance;

  // Hair tones: what lies under the strand polylines, without skin.
  const seeds = createMask(width, height);
  for (const list of map.seeds) for (const i of list) seeds.data[i] = 1;
  const samples = createMask(width, height);
  for (let i = 0; i < n; i++) if (seeds.data[i] === 1 && alpha(i) >= T.opaque && blocked.data[i] === 0 && !skinLike(i)) samples.data[i] = 1;
  const tones = dominantColors(source, samples, T.tones)
    .filter((c) => c.share >= T.toneShare)
    .map((c) => c.lab);
  if (tones.length === 0) return { ...empty, skin };

  // Where hair may grow.
  const clothing = clothingColours(inputs, map);
  const clothingConflict = clothing.length > 0 && minDistance(tones, clothing) < T.tolerance + T.clothingMargin;
  const head = ellipseMask(width, height, spec.head.center[0], spec.head.center[1], spec.head.radius[0] * T.headReach, spec.head.radius[1] * T.headReach);
  // A springy mass on the head is a hair bun more often than not: hair may grow there too (if it has the colour).
  for (const attachment of spec.attachments ?? []) {
    if (attachment.kind !== 'jiggle' || attachment.follow !== 'head') continue;
    const bun = ellipseMask(width, height, attachment.center[0], attachment.center[1], attachment.radius[0] * T.headReach, attachment.radius[1] * T.headReach);
    for (let i = 0; i < n; i++) if (bun.data[i] > head.data[i]) head.data[i] = bun.data[i];
  }
  const chin = spec.head.neck[0];
  const limit = createMask(width, height);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      if (blocked.data[i] !== 0) continue;
      if (map.rel[i] <= T.corridor) limit.data[i] = 1;
      else if (head.data[i] >= 0.5) {
        // Dark hair over a dark dress: below the chin only what is clearly nearer to the hair than to the clothing.
        if (!clothingConflict || y + 0.5 < chin || nearest(lab.lab, i, tones) + T.clothingMargin < nearest(lab.lab, i, clothing)) limit.data[i] = 1;
      }
    }
  }

  const grown = growRegion(lab, seeds, { references: tones, tolerance: T.tolerance, limit, connectivity: 4, minAlpha: 128 });

  // Holes that are neither skin nor see-through nor taken by others: highlights and ornaments inside the hair.
  const filled = fillHoles(grown);
  for (let i = 0; i < n; i++) {
    if (filled.data[i] >= 0.5 && grown.data[i] < 0.5) filled.data[i] = alpha(i) >= T.opaque && blocked.data[i] === 0 && !skinLike(i, T.holeSkinTolerance) ? 1 : 0;
  }
  const body = removeSmallComponents(filled, Math.max(6, n * T.speckShare));

  // The outline and the soft silhouette belong to the hair.
  const rim = Math.min(T.rimMax, Math.max(T.rimMin, metrics.long * T.rimShare));
  const distance = distanceTransform(body);
  const mask = createMask(width, height);
  let area = 0;
  for (let i = 0; i < n; i++) {
    if (blocked.data[i] !== 0) continue;
    const d = distance.data[i];
    const a = alpha(i);
    // Transparent pixels add nothing to the layer; leaving them out keeps the edge of the mask on the silhouette.
    if (a > 0 && (d <= rim || (a < T.opaque && d <= rim + T.softRim))) {
      mask.data[i] = 1;
      area++;
    }
  }

  // How far the mask can be trusted.
  let visibleHead = 0;
  for (let i = 0; i < n; i++) if (head.data[i] >= 0.5 && alpha(i) >= 128) visibleHead++;
  const face = spec.face;
  const lower = ellipseMask(width, height, face.nose[0], face.nose[1], face.radius[0] * 0.4, face.radius[1] * 0.3);
  let lowerArea = 0;
  let lowerHair = 0;
  for (let i = 0; i < n; i++) {
    if (lower.data[i] < 0.5 || map.rel[i] <= 0.75 || blocked.data[i] !== 0) continue;
    lowerArea++;
    if (mask.data[i] !== 0) lowerHair++;
  }
  const perStrand: HairMaskStrand[] = strands.map((strand, k) => {
    const list = map.seeds[k];
    let on = 0;
    for (const i of list) if (mask.data[i] !== 0) on++;
    return { id: strand.id, onHair: list.length > 0 ? on / list.length : 0 };
  });

  return {
    mask,
    blocked,
    tones,
    skin,
    clothingConflict,
    coverage: visibleHead > 0 ? area / visibleHead : 0,
    faceShare: lowerArea > 0 ? lowerHair / lowerArea : 0,
    area,
    strands: perStrand,
  };
}
