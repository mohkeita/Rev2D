/**
 * Feature "hair": the hair sways, lock by lock, while face and clothing stay still.
 *
 * LAYERS. The hair mask (./hair-mask.ts: grown from the strand polylines by colour) cuts the hair
 * into ONE layer drawn over the base; the mask is also written as the debug image
 * textures/hair_mask.png (white = hair). The base keeps its own copy of the hair wherever the moving
 * layer always covers it, and loses it along the edges that a swinging lock uncovers (DESIGN.md §3,
 * the no-ghost rule). For every hair pixel within the reach of a strand's swing of the hair's edge:
 *   - next to the transparent background it is ERASED from the base (and with it every partly
 *     transparent pixel of the silhouette), so the lock leaves no second outline behind;
 *   - next to anything else (the forehead under the bangs, a cheek, a collar, an eye) it is FILLED
 *     by carrying the colours of the picture there inward, so the lock uncovers skin, cloth or the
 *     continued eye instead of its own static copy;
 *   - next to the brows or an attachment that is cut (they are drawn in front) the base stays.
 * Where the layer ends hard (opaque next to nothing) the base right behind its edge pixel holds what
 * lies beside it, and behind the soft silhouette the base gives up the opaque pixels next to it: the
 * renderer blends each pixel with its neighbours, and two edges on the same pixel would show as a seam.
 *
 * BROWS (face.brows) are never hair, but they often touch or cross the bangs. A brow the brows
 * feature cut into its own layer (./brows.ts, drawn ABOVE the hair) keeps the hair out by its claim;
 * under it the hair layer holds the brows feature's fill where that continues a bang, so a swinging
 * bang stays whole under the brow and a raised brow leaves the bang whole. A brow nobody cut is drawn
 * again above the hair as a static band (layer "hair_brows"), so a swinging bang passes under it.
 *
 * HAIR IN FRONT OF AN EYE: the eye feature claims its eye region, the hair lying over it only weakly,
 * and draws that hair (an opaque copy, its antialiased rim a matte over what the eye draws behind it)
 * as "<eye>_front". The hair layer takes those pixels whole (the lock goes on across the region's
 * outline in one layer) except next to the rim, so its own edge lies where the eye's copy is opaque;
 * "<eye>_front" moves with the hair (compile).
 *
 * COMPILE. The layer hangs in the warp "hairWarp", nested in the root lattice (it follows turn, tilt,
 * sway and breath). Each strand gets a parameter Hair_<id> (-1..1) bound to sparse offsets of that
 * warp: a displacement perpendicular to the strand's main direction (root -> tip), zero at the root
 * and `swing` px at the tip, with a Gaussian falloff of the strand's width around its polyline.
 * Overlapping strands add up. +1 moves the tip to the screen right for a lock that hangs down.
 * One physics group per strand (./hair-physics.ts) drives the parameter from AngleX, AngleZ and
 * BodyAngleX: short stiff bangs are quick, long loose locks are slow and lag; when the head tilts
 * the locks hang a little toward the ground.
 */
import { AVATAR_Z } from '../builder.js';
import { sparseOffsets, sampleField, type AvatarMetrics, type Field, type SparseOffsets, type Vec2, type Weight } from '../fields.js';
import { cropRect, cutLayer } from '../image/compose.js';
import { distanceTransform, featherMask } from '../image/distance.js';
import { extendEdges } from '../image/inpaint.js';
import { cloneMask, createMask, cropMask, maskBounds, maskThreshold, maskToGray } from '../image/mask.js';
import { rgbToLab } from '../image/color.js';
import { closestOnPolyline, polylineLength } from '../image/polygon.js';
import { fillPolygon } from '../image/raster.js';
import { pixelRect } from '../image/types.js';
import { createImage } from '../../render/image.js';
import type { AvatarSpec, AvatarStrand } from '../types.js';
import { attachmentObject } from './attachments-object.js';
import { browSearchBand } from './brows.js';
import { browBand, browRadius, buildHairMask, HAIR_MASK_TUNING } from './hair-mask.js';
import { REFERENCE_SHARE, REFERENCE_TIME, swayPhysics, type SwayDrive } from './hair-physics.js';
import type { AvatarFeature } from './types.js';

/** Ids of the hair layer (texture, part), its debug mask image, the brows drawn above it and its warp. */
export const HAIR_LAYER = 'hair';
export const HAIR_MASK_LAYER = 'hair_mask';
export const HAIR_BROWS_LAYER = 'hair_brows';
export const HAIR_WARP = 'hairWarp';
/** Under a brow the bangs are continued in the fill's colours that lie within this deltaE of a hair tone. */
const UNDER_BROW_TONE = 16;

export const HAIR_TUNING = {
  /** Displacement along a strand: (position from root to tip) ^ this. 1 = a rigid swing, more = the tip bends more. */
  ramp: 1.5,
  /** The Gaussian falloff around the polyline ends (smoothly) at this many sigmas; sigma = width / 2. */
  cutoff: 3,
  /**
   * The base is prepared for swings up to this many times the spec's (strand swings add up where
   * strands overlap, the lattice interpolates, and a swing raised later in the editor should not
   * ghost at once), plus a margin in px.
   */
  reachFactor: 1.6,
  reachMargin: 2,
  /** Hair that moves less than this (px) at full swing leaves the base alone. */
  minReach: 0.15,
  /** Warnings: the mask is sparse below this coverage of the head, leaks above this share of the lower face, a strand is off the hair below this share. */
  sparse: 0.03,
  leak: 0.08,
  offHair: 0.5,
  /** Physics: frequency (Hz) of a strand of stiffness 1 whose length is `referenceLength` head heights; longer = slower (1 / sqrt), within [min, max]. */
  frequency: 1.45,
  referenceLength: 0.3,
  minFrequency: 0.45,
  maxFrequency: 3,
  /** Damping ratio: short strands settle sooner than long ones. */
  damping: 0.36,
  dampingPerLength: 0.25,
  minDamping: 0.15,
  /** Output for the reference motion (AngleX from 0 to 10 in 1 s, ./hair-physics.ts): a calm turn like that swings the lock to 80%. */
  peak: 0.8,
  /** At AngleZ = 30 a strand hangs this share of its swing toward the ground (more for loose strands, at most `maxHang`). */
  hang: 0.25,
  maxHang: 0.45,
  /** A strand that lies almost level still answers sideways motion with this share of its swing. */
  minSideways: 0.35,
} as const;

/** What the layer stage tells the compile stage (layers.json, key "hair"). */
export interface HairMeta {
  /** Layer ids of the hair image and of the debug mask. */
  layer: string;
  mask: string;
  /** Hair pixels as a share of the visible pixels inside the head ellipse. */
  coverage: number;
  /** The swing (px) each strand's surroundings in the base were prepared for. */
  reach: Record<string, number>;
  /** Layer id of the brows drawn above the hair (absent without face.brows). */
  brows?: string;
}

// ----------------------------------------------------------------------------- the sway field

/** A strand as the sway sees it. */
export interface StrandShape {
  id: string;
  nodes: number[];
  root: Vec2;
  tip: Vec2;
  /** Length along the polyline, px. */
  length: number;
  /** Gaussian sigma of the falloff around the polyline, px. */
  sigma: number;
  /** Unit direction the tip moves at +1: perpendicular to root -> tip, toward the screen right for a strand that hangs down. */
  normal: Vec2;
  /** Where the weight can be non-zero: [x0, y0, x1, y1]. */
  bounds: [number, number, number, number];
}

export function strandShape(strand: AvatarStrand): StrandShape {
  const nodes = strand.nodes;
  const count = Math.floor(nodes.length / 2);
  const root: Vec2 = [nodes[0], nodes[1]];
  const tip: Vec2 = [nodes[count * 2 - 2], nodes[count * 2 - 1]];
  let dx = tip[0] - root[0];
  let dy = tip[1] - root[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-6) {
    dx = 0;
    dy = 1;
  } else {
    dx /= chord;
    dy /= chord;
  }
  const sigma = strand.width / 2;
  const reach = sigma * HAIR_TUNING.cutoff;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < count; i++) {
    x0 = Math.min(x0, nodes[i * 2]);
    y0 = Math.min(y0, nodes[i * 2 + 1]);
    x1 = Math.max(x1, nodes[i * 2]);
    y1 = Math.max(y1, nodes[i * 2 + 1]);
  }
  return { id: strand.id, nodes, root, tip, length: polylineLength(nodes), sigma, normal: [dy + 0, -dx + 0], bounds: [x0 - reach, y0 - reach, x1 + reach, y1 + reach] };
}

/** How much of a strand's swing a point gets, 0..1: 0 at the root, 1 at the tip on the polyline, a Gaussian across. */
export function strandWeight(shape: StrandShape): Weight {
  const { nodes, sigma, bounds } = shape;
  const cutoff = HAIR_TUNING.cutoff;
  return (x, y) => {
    if (x <= bounds[0] || x >= bounds[2] || y <= bounds[1] || y >= bounds[3]) return 0;
    const p = closestOnPolyline(nodes, x, y);
    const d = p.distance / sigma;
    if (d >= cutoff) return 0;
    // The last sigma fades to exactly 0, so the keyforms stay sparse.
    const fade = d <= cutoff - 1 ? 1 : 1 - smooth(d - (cutoff - 1));
    return Math.pow(p.t, HAIR_TUNING.ramp) * Math.exp(-0.5 * d * d) * fade;
  };
}

function smooth(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** The displacement of a strand at Hair_<id> = 1 with a tip swing of `swing` px. */
export function strandField(shape: StrandShape, swing: number): Field {
  const weight = strandWeight(shape);
  const [nx, ny] = shape.normal;
  return (x, y) => {
    const w = weight(x, y) * swing;
    return [nx * w + 0, ny * w + 0];
  };
}

function negate(offsets: SparseOffsets): SparseOffsets {
  const out: SparseOffsets = {};
  for (const [key, d] of Object.entries(offsets)) out[key] = [d[0] === 0 ? 0 : -d[0], d[1] === 0 ? 0 : -d[1]];
  return out;
}

// ----------------------------------------------------------------------------- physics

/** Frequency (Hz) and damping ratio of a strand: from its length relative to the head and its stiffness. */
export function strandDynamics(spec: AvatarSpec, strand: AvatarStrand, shape: StrandShape): { frequency: number; dampingRatio: number } {
  const T = HAIR_TUNING;
  const relative = Math.max(0.02, shape.length / (2 * spec.head.radius[1]));
  const frequency = Math.min(T.maxFrequency, Math.max(T.minFrequency, T.frequency * strand.stiffness * Math.sqrt(T.referenceLength / relative)));
  const dampingRatio = Math.max(T.minDamping, T.damping - T.dampingPerLength * relative);
  return { frequency, dampingRatio };
}

/**
 * The drives of something attached to the head at (x, y): how far that point travels sideways per
 * unit of AngleX (the face centre's travel: the whole head turns), AngleZ (the tilt about the neck
 * pivot) and BodyAngleX (the sway about the body pivot). Only parameters the model has are listed.
 */
export function headDrives(spec: AvatarSpec, metrics: AvatarMetrics, has: (id: string) => boolean, x: number, y: number): SwayDrive[] {
  void x;
  const rad = Math.PI / 180;
  const drives: SwayDrive[] = [];
  if (has('AngleX')) drives.push({ param: 'AngleX', travel: metrics.turn.x / 30, limit: 30 });
  if (has('AngleZ')) drives.push({ param: 'AngleZ', travel: (metrics.tilt * rad * (spec.head.pivot[1] - y)) / 30, limit: 30 });
  if (has('BodyAngleX')) drives.push({ param: 'BodyAngleX', travel: (metrics.sway * rad * (spec.body.pivot[1] - y)) / 10, limit: 10 });
  return drives.filter((d) => Math.abs(d.travel) > 1e-9);
}

// ----------------------------------------------------------------------------- the feature

const strandParam = (id: string): string => `Hair_${id}`;
const round = (v: number, digits = 1): number => Math.round(v * 10 ** digits) / 10 ** digits;

export const hair: AvatarFeature = {
  id: 'hair',
  summary: 'hair sway: hair layers grown from the strand polylines, one physics-driven parameter Hair_<strandId> per strand',

  layers(ctx) {
    const T = HAIR_TUNING;
    const { spec, metrics, source } = ctx;
    const strands = spec.hair?.strands ?? [];
    if (strands.length === 0) return;
    const { width, height } = source;
    const n = width * height;
    const opaque = HAIR_MASK_TUNING.opaque;

    // The attachments that are cut own their pixels (./attachments.ts cuts exactly these).
    const objects = createMask(width, height);
    for (const attachment of spec.attachments ?? []) {
      const object = attachmentObject(attachment, source, ctx.sourceLab(), metrics);
      if (object) for (let i = 0; i < n; i++) if (object.mask.data[i] > objects.data[i]) objects.data[i] = object.mask.data[i];
    }
    // A copy: ctx.claimed grows in place when this feature claims the hair below.
    const claimedBefore = cloneMask(ctx.claimed);
    const found = buildHairMask({ spec, metrics, source, lab: ctx.sourceLab(), claimed: claimedBefore, objects });
    ctx.report.stat('hairCoverage', round(found.coverage, 4));
    ctx.report.stat('hairPixels', found.area);
    if (found.area === 0) {
      ctx.report.warning('avatar-hair-mask-empty', `no hair was found under the ${strands.length} strand${strands.length === 1 ? '' : 's'}: the hair does not sway`, {
        path: '/hair/strands',
        hint: 'a strand is a polyline from the root of a lock to its tip, ENTIRELY on hair (not on skin, not on the background): check them with "rev2d avatar overlay <project> --part strands"',
      });
      return;
    }
    strands.forEach((strand, i) => {
      const share = found.strands[i]?.onHair ?? 0;
      if (share < T.offHair) {
        ctx.report.warning('avatar-hair-strand-off', `only ${Math.round(share * 100)}% of strand "${strand.id}" lies on hair: its sway will move little or the wrong pixels`, {
          path: `/hair/strands/${i}/nodes`,
          hint: 'place every node of the strand on the lock, from its root to just inside its tip; textures/hair_mask.png shows what counts as hair',
        });
      }
    });
    if (found.coverage < T.sparse) {
      ctx.report.warning('avatar-hair-mask-sparse', `the hair mask covers only ${round(found.coverage * 100)}% of the head: most of the hair will not sway`, {
        path: '/hair/strands',
        hint: 'look at textures/hair_mask.png: add strands on the locks it misses (the mask grows from the strands through similar colours), or enlarge head.radius if hair lies outside the head ellipse',
      });
    }
    if (found.faceShare > T.leak) {
      ctx.report.warning('avatar-hair-mask-leak', `the hair mask covers ${Math.round(found.faceShare * 100)}% of the lower face: skin would sway with the hair`, {
        path: '/hair/strands',
        hint: 'look at textures/hair_mask.png: a strand probably crosses skin or shadow (keep every node on hair), or the face oval / nose are misplaced',
      });
    }

    // Hair over an eye: the eye feature claimed its region, the hair lying over it only weakly (below
    // 0.5, EYE_TUNING.frontClaim). The hair layer takes those pixels whole (an opaque copy), so the lock
    // goes on across the region's outline in one layer; the eye's copy of the hair over it
    // ("<eye>_front", moved with the hair in compile) holds its antialiased edge.
    const hard = cloneMask(found.mask);
    const whole = createMask(width, height);
    const shy = createMask(width, height);
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const region = createMask(width, height);
      fillPolygon(region, spec.face.eyes[side].region);
      let taken = 0;
      const front: number[] = [];
      for (let i = 0; i < n; i++) {
        if (region.data[i] < 0.5 || source.data[i * 4 + 3] === 0) continue;
        if (claimedBefore.data[i] >= 0.5) taken++;
        else front.push(i);
      }
      // Only when the eye feature cut this eye (else the whole region would count as hair over it).
      if (taken === 0) continue;
      // Not next to what the eye claimed (the hair's rim): the layer's edge lies where the eye's matte of
      // the hair is opaque on both sides of it, so it leaves no seam (two layers ending at the same
      // pixel edge would draw it twice).
      for (const i of front) {
        const x = i % width;
        const y = (i - x) / width;
        let edge = false;
        for (let dy = -1; dy <= 1 && !edge; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < width && yy < height && claimedBefore.data[yy * width + xx] >= 0.5) {
              edge = true;
              break;
            }
          }
        }
        if (edge) {
          shy.data[i] = 1;
          continue;
        }
        hard.data[i] = 1;
        whole.data[i] = 1;
      }
    }

    // Under a brow the brows feature cut (its fill continues the surroundings) the bangs go on: where
    // that fill has a hair tone next to the hair, the hair layer holds the fill, so a swinging bang
    // stays whole under the brow (drawn above the hair) and a raised brow leaves the bang whole.
    const underBrow = createMask(width, height);
    if (spec.face.brows) {
      const search = browSearchBand(spec, width, height);
      const eyes = createMask(width, height);
      fillPolygon(eyes, spec.face.eyes.imageLeft.region);
      fillPolygon(eyes, spec.face.eyes.imageRight.region);
      const nearEye = distanceTransform(maskThreshold(eyes, 0.01));
      const toHair = distanceTransform(found.mask);
      const reachHair = Math.max(3, browRadius(spec) * 3);
      const tones = found.tones;
      for (let i = 0; i < n; i++) {
        if (search.data[i] < 0.5 || claimedBefore.data[i] < 0.5 || nearEye.data[i] <= 3 || toHair.data[i] > reachHair) continue;
        const o = i * 4;
        if (ctx.base.data[o + 3] < opaque) continue;
        const c = rgbToLab(ctx.base.data[o], ctx.base.data[o + 1], ctx.base.data[o + 2]);
        let best = Infinity;
        for (const t of tones) best = Math.min(best, Math.hypot(c[0] - t[0], c[1] - t[1], c[2] - t[2]));
        if (best > UNDER_BROW_TONE) continue;
        underBrow.data[i] = 1;
        hard.data[i] = 1;
      }
    }

    // The layer: the source under the feathered mask (never over pixels that hair may not take).
    const soft = featherMask(hard, metrics.feather, 'outward');
    for (let i = 0; i < n; i++) if ((found.blocked.data[i] !== 0 || shy.data[i] === 1) && whole.data[i] === 0 && underBrow.data[i] === 0) soft.data[i] = 0;
    for (let i = 0; i < n; i++) if (whole.data[i] === 1 || underBrow.data[i] === 1) soft.data[i] = 1;

    const bounds = maskBounds(soft, 0);
    if (!bounds) return;
    const rect = pixelRect(bounds, 2, width, height);
    const { layer } = cutLayer(source, soft, { opaque });
    // Under the brows the hair layer holds the brows feature's fill (what the brow is drawn over).
    for (let i = 0; i < n; i++) {
      if (underBrow.data[i] !== 1) continue;
      layer.data.set(ctx.base.data.subarray(i * 4, i * 4 + 4), i * 4);
    }
    const info = ctx.addLayer(HAIR_LAYER, extendEdges(cropRect(layer, rect), 4), [rect.x, rect.y, rect.width, rect.height]);
    const debug = ctx.addLayer(HAIR_MASK_LAYER, maskToGray(cropMask(soft, rect.x, rect.y, rect.width, rect.height)), [rect.x, rect.y, rect.width, rect.height]);

    // How far each hair pixel can move: the swings of all strands that reach it.
    const reach = new Float32Array(n);
    const shapes = strands.map(strandShape);
    shapes.forEach((shape, k) => {
      const weight = strandWeight(shape);
      const x0 = Math.max(rect.x, Math.floor(shape.bounds[0]));
      const y0 = Math.max(rect.y, Math.floor(shape.bounds[1]));
      const x1 = Math.min(rect.x + rect.width, Math.ceil(shape.bounds[2]));
      const y1 = Math.min(rect.y + rect.height, Math.ceil(shape.bounds[3]));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * width + x;
          if (hard.data[i] !== 0) reach[i] += weight(x + 0.5, y + 0.5) * strands[k].swing;
        }
      }
    });

    // What lies next to the hair: the background, something solid, or what is drawn in front (kept).
    const brows = browBand(spec, metrics, claimedBefore);
    const outside = createMask(width, height);
    const background = createMask(width, height);
    const solid = createMask(width, height);
    const kept = createMask(width, height);
    for (let i = 0; i < n; i++) {
      if (hard.data[i] !== 0) continue;
      outside.data[i] = 1;
      // Next to what others cut (eyes, brows, cut-out attachments) the base stays: their layers lie
      // against the hair's edge there, and the eye's matte of the hair over it moves with the hair.
      if (brows.data[i] >= 0.5 || objects.data[i] >= 0.5 || claimedBefore.data[i] >= 0.5) kept.data[i] = 1;
      else if (source.data[i * 4 + 3] < 128) background.data[i] = 1;
      else solid.data[i] = 1;
    }
    const toOutside = distanceTransform(outside);
    const toBackground = distanceTransform(background);
    const toSolid = distanceTransform(solid);
    const toKept = distanceTransform(kept);

    const base = { width, height, data: new Uint8ClampedArray(ctx.base.data) };
    // A partly transparent pixel (the soft silhouette) must not be drawn twice: the base keeps only
    // the alpha that completes the layer's (none where the layer takes the pixel whole).
    const thinned = createMask(width, height);
    for (let i = 0; i < n; i++) {
      const cut = layer.data[i * 4 + 3];
      const alpha = base.data[i * 4 + 3];
      if (cut === 0 || alpha >= opaque) continue;
      base.data[i * 4 + 3] = cut >= alpha ? 0 : Math.floor((255 * (alpha - cut)) / (255 - cut) + 0.5);
      thinned.data[i] = 1;
    }
    // Nor may the base end with a hard edge right behind that soft edge (the renderer blends a pixel with
    // its neighbours, so both edges would show): where the layer is opaque next to a thinned pixel, the
    // base gives the pixel up too, and its edge lies where the layer hides it.
    for (let i = 0; i < n; i++) {
      if (thinned.data[i] === 1 || layer.data[i * 4 + 3] !== 255 || base.data[i * 4 + 3] === 0) continue;
      const x = i % width;
      const y = (i - x) / width;
      let next = false;
      for (let dy = -1; dy <= 1 && !next; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height && thinned.data[yy * width + xx] === 1) {
            next = true;
            break;
          }
        }
      }
      if (next) base.data[i * 4 + 3] = 0;
    }
    const fill: number[] = [];
    let erased = 0;
    let deepest = 0;
    for (let i = 0; i < n; i++) {
      const r = reach[i];
      if (r < T.minReach) continue;
      if (toOutside.data[i] > r * T.reachFactor + T.reachMargin) continue;
      const b = toBackground.data[i];
      const s = toSolid.data[i];
      if (toKept.data[i] <= Math.min(b, s)) continue;
      if (source.data[i * 4 + 3] < opaque || b <= s) {
        base.data[i * 4 + 3] = 0;
        erased++;
      } else {
        fill.push(i);
        if (s > deepest) deepest = s;
      }
    }
    if (fill.length) {
      // What a lock uncovers continues what lies next to it in the picture: the colours of the solid
      // pixels are carried inward ring by ring (a stripe of the collar stays a stripe, the lash line
      // of an eye goes on under the lock; a smooth membrane fill would smear them).
      const window = pixelRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, Math.ceil(deepest) + 2, width, height);
      const sources = createImage(window.width, window.height);
      for (let y = 0; y < window.height; y++) {
        for (let x = 0; x < window.width; x++) {
          const i = (y + window.y) * width + x + window.x;
          if (solid.data[i] === 0) continue;
          const o = (y * window.width + x) * 4;
          sources.data[o] = source.data[i * 4];
          sources.data[o + 1] = source.data[i * 4 + 1];
          sources.data[o + 2] = source.data[i * 4 + 2];
          sources.data[o + 3] = 255;
        }
      }
      const carried = extendEdges(sources, Math.ceil(deepest) + 1);
      for (const i of fill) {
        const x = (i % width) - window.x;
        const y = Math.floor(i / width) - window.y;
        const o = (y * window.width + x) * 4;
        base.data[i * 4] = carried.data[o];
        base.data[i * 4 + 1] = carried.data[o + 1];
        base.data[i * 4 + 2] = carried.data[o + 2];
        base.data[i * 4 + 3] = 255;
      }
    }
    const filled = fill.length;
    // Where the layer ends hard (opaque next to nothing: a bang under a brow, the hair over an eye), the
    // base right behind its edge pixel holds what lies beside it: the renderer blends each pixel with its
    // neighbours, and a base that ended at the same edge would darken (or lighten) it twice.
    const edgeColor = new Map<number, [number, number, number]>();
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const i = y * width + x;
        if (layer.data[i * 4 + 3] !== 255 || base.data[i * 4 + 3] !== 255) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const j = yy * width + xx;
          if (layer.data[j * 4 + 3] !== 0 || base.data[j * 4 + 3] !== 255) continue;
          r += base.data[j * 4];
          g += base.data[j * 4 + 1];
          b += base.data[j * 4 + 2];
          count++;
        }
        if (count > 0) edgeColor.set(i, [Math.round(r / count), Math.round(g / count), Math.round(b / count)]);
      }
    }
    for (const [i, c] of edgeColor) base.data.set(c, i * 4);
    ctx.base = base;
    ctx.claim(soft);
    ctx.report.stat('hairErased', erased);
    ctx.report.stat('hairFilled', filled);

    const meta: HairMeta = { layer: info.id, mask: debug.id, coverage: round(found.coverage, 4), reach: Object.fromEntries(strands.map((s) => [s.id, round(s.swing * T.reachFactor, 2)])) };

    // The brows again, above the hair: the source under the feathered band.
    const band = featherMask(brows, metrics.feather, 'outward');
    const bandBounds = maskBounds(band, 0);
    if (bandBounds) {
      const r = pixelRect(bandBounds, 1, width, height);
      const { layer: browLayer } = cutLayer(source, band, { opaque });
      meta.brows = ctx.addLayer(HAIR_BROWS_LAYER, extendEdges(cropRect(browLayer, r), 2), [r.x, r.y, r.width, r.height]).id;
    }

    ctx.setMeta('hair', meta);
  },

  compile(ctx) {
    const T = HAIR_TUNING;
    const { spec, metrics, model, root } = ctx;
    const strands = spec.hair?.strands ?? [];
    if (strands.length === 0) return;
    const meta = ctx.featureMeta<Partial<HairMeta>>('hair');
    const layer = ctx.layer(meta?.layer ?? HAIR_LAYER);
    if (!layer) {
      ctx.report.warning('avatar-hair-layer-missing', `the spec has ${strands.length} hair strand${strands.length === 1 ? '' : 's'} but the layers hold no hair image: the hair does not sway`, {
        path: '/hair/strands',
        hint: 'build the layers again ("rev2d avatar build"); if that reports "avatar-hair-mask-empty", the strands do not lie on hair',
      });
      return;
    }

    const warp = model.warp({
      id: HAIR_WARP,
      parent: root.id,
      rect: layer.rect,
      cell: metrics.cell.head,
      description: 'The hair layer: one sparse offset binding per strand (Hair_<id>) sways its lock; nested in the root lattice, so the hair follows the head.',
    });
    model.imagePart(layer, { id: HAIR_LAYER, parent: warp.id, z: AVATAR_Z.hair, description: 'The hair, cut by the hair mask (textures/hair_mask.png); the base behind its swinging edges is erased or filled.' });
    const browLayer = meta?.brows !== undefined ? ctx.layer(meta.brows) : undefined;
    if (browLayer) {
      model.imagePart(browLayer, { id: HAIR_BROWS_LAYER, parent: root.id, z: AVATAR_Z.hair + 2, description: 'The brows drawn again above the hair: a swinging bang passes under them (static; they follow the root lattice).' });
    }
    // The eye feature's matte of the hair over an eye ("<eye>_front", eyeL = the eye on the image right)
    // holds the hair's antialiased edge over the eye: it moves with the hair.
    for (const id of ['eyeL_front', 'eyeR_front']) {
      const front = model.findPart(id);
      const info = ctx.layer(id);
      if (!front || !info) continue;
      const [x, y, w, h] = info.rect;
      const [wx, wy, wwid, whei] = warp.lattice.rect;
      if (x >= wx && y >= wy && x + w <= wx + wwid && y + h <= wy + whei) front.parent = warp.id;
    }

    const has = (id: string) => model.hasParameter(id);
    const params: string[] = [];
    let points = 0;
    strands.forEach((strand, i) => {
      const shape = strandShape(strand);
      const plus = sparseOffsets(sampleField(warp.lattice, strandField(shape, strand.swing)));
      const moved = Object.keys(plus).length;
      if (moved === 0) {
        ctx.report.warning('avatar-hair-strand-still', `strand "${strand.id}" moves no point of the hair lattice: it lies outside the hair layer or is too thin for the lattice`, {
          path: `/hair/strands/${i}`,
          hint: `the hair lattice has cells of about ${round(metrics.cell.head)} px: give the strand a width of at least that, and place it on hair`,
        });
        return;
      }
      points += moved;
      const prepared = meta?.reach?.[strand.id];
      if (prepared !== undefined && strand.swing > prepared + 1e-6) {
        ctx.report.info('avatar-hair-swing-beyond-layers', `strand "${strand.id}" swings ${round(strand.swing)} px, the layers were cut for up to ${round(prepared)} px: its edges may show a second outline until the layers are rebuilt`, {
          path: `/hair/strands/${i}/swing`,
          hint: 'run "rev2d avatar build" again',
        });
      }

      const param = model.parameter({ id: strandParam(strand.id), min: -1, max: 1, default: 0, group: 'Hair', description: `Sway of the lock "${strand.id}" (written by physics): +1 = the tip ${round(strand.swing)} px toward ${describe(shape.normal)}.` });
      params.push(param);
      model.bind({
        id: `hairSway_${strand.id}`,
        target: `warp:${warp.id}.offsets`,
        params: [param],
        keys: [
          { at: [-1], value: negate(plus) },
          { at: [0], value: {} },
          { at: [1], value: plus },
        ],
        description: `Lock "${strand.id}": perpendicular to the strand, 0 at its root, ${round(strand.swing)} px at its tip, Gaussian falloff of ${round(shape.sigma)} px around the polyline.`,
      });

      const { frequency, dampingRatio } = strandDynamics(spec, strand, shape);
      const drives = headDrives(spec, metrics, has, shape.root[0], shape.root[1]);
      if (drives.length === 0) return;
      // The lag is sideways (screen x); the lock moves along its normal.
      const sideways = (shape.normal[0] < 0 ? -1 : 1) * Math.max(Math.abs(shape.normal[0]), T.minSideways);
      const tilt = (metrics.tilt * Math.PI) / 180;
      const hangShare = Math.min(T.maxHang, T.hang / Math.max(0.4, strand.stiffness));
      const tilts = has('AngleZ') && tilt > 1e-6 ? [{ param: 'AngleZ', degrees: metrics.tilt / 30 }] : [];
      const hang = tilts.length ? Math.min(0.6, Math.max(0.02, (hangShare * strand.swing) / (Math.max(1, shape.length) * Math.sin(tilt) * Math.abs(sideways)))) : 0.05;
      model.physics(
        swayPhysics({
          id: `hairPhysics_${strand.id}`,
          output: param,
          kind: 'x',
          full: strand.swing / sideways,
          length: shape.length,
          frequency,
          dampingRatio,
          hang,
          drives,
          tilts,
          peak: T.peak,
          description: `Lock "${strand.id}": ${round(frequency, 2)} Hz, damping ratio ${round(dampingRatio, 2)}; a head turn of ${Math.round(30 * REFERENCE_SHARE)} in ${REFERENCE_TIME} s swings it to ${Math.round(T.peak * 100)}%.`,
        }),
      );
    });
    ctx.report.stat('hairStrands', params.length);
    ctx.report.stat('hairPoints', points);

    // Fold check (each lock alone at its limits is a default pose): all locks together with the head
    // turned and tilted, and neighbouring locks swinging against each other.
    if (params.length) {
      const all = (v: number) => Object.fromEntries(params.map((p) => [p, v]));
      const alternating = (v: number) => Object.fromEntries(params.map((p, k) => [p, k % 2 ? -v : v]));
      ctx.folds.pose(alternating(1));
      ctx.folds.pose({ ...all(1), AngleX: 30, AngleZ: 30 });
      ctx.folds.pose({ ...all(-1), AngleX: -30, AngleZ: -30 });
    }
  },

  poses(ctx) {
    const strands = ctx.spec.hair?.strands ?? [];
    if (strands.length === 0) return [];
    const all = (v: number) => Object.fromEntries(strands.map((s) => [strandParam(s.id), v]));
    return [
      { id: 'hair_left', label: 'hair swung (all strands -1)', params: all(-1) },
      { id: 'hair_right', label: 'hair swung (all strands 1)', params: all(1) },
    ];
  },
};

function describe(normal: Vec2): string {
  if (Math.abs(normal[0]) >= Math.abs(normal[1])) return normal[0] >= 0 ? 'the screen right' : 'the screen left';
  return normal[1] >= 0 ? 'the bottom' : 'the top';
}
