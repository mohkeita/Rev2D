/**
 * Feature "eyes": blink (EyeLOpen / EyeROpen) and gaze (EyeBallX / EyeBallY).
 *
 * LAYERS (per eye; ids "eyeL..." = the character's left eye = the eye on the image RIGHT)
 *
 *   base              the opening and every stroke drawn on the eye region (lashes, lid and crease
 *                     lines with their soft edges and fainter continuations) filled with eyelid skin,
 *                     inpainted from the skin and shading around them; plain skin stays as it is
 *   <id>_white  part  a mesh in the eye-white colour over the opening: the underlay of the eyeball AND
 *                     its mask; both rows are bound to the blink and meet, so it collapses to zero area
 *   <id>_ball         the pixels inside the opening (white, iris), continued outward so the layer can
 *                     shift for the gaze; clipped by <id>_white, never squashed
 *   <id>_lower        what is drawn below the opening (lower lid line, lower lashes): rises a little
 *   <id>_lowerRim     eye white on the lower lid edge: rises with it, fades out before the lids meet
 *   <id>_crease       strokes above the lash band (crease line, with their soft edge), eye white at
 *                     the corners and strokes apart from the lash above a corner: static, fades out
 *                     as the eye closes
 *   <id>_upper        the lash band, and past the corners the lash joined to it: travels down until
 *                     it meets the lower lid (the corners do not move)
 *   <id>_upperRim     eye white on the upper lid edge: moves with it, fades out before the lids meet
 *   <id>_front        hair in front of the eye: an opaque copy of the hair and a matte of its
 *                     antialiased rim (in the hair's colour) over what the eye draws behind it; the
 *                     hair feature moves it with the hair
 *
 * The lid layers are DIFFERENCE MATTES against what lies under them at rest (./eyes-matte.ts): the
 * eyelid fill, and inside the mask mesh the eyeball. They hold only what is drawn on the skin, so a
 * closed eye shows clean skin and one lash line, no stretched skin, and the rest pose is the
 * illustration exactly. Where the mask mesh covers part of a pixel they are opaque copies (what lies
 * under them there depends on how the renderer samples the mesh).
 *
 * SEAMS. The renderer blends every pixel with its neighbours (bilinear texels, supersampling): two
 * layers that both end on the same pixel edge draw it twice. So a stroke stays in one layer where it
 * can (the lash line by connectivity, not pixel by pixel), the hair's rim is one matte over the
 * continued eye content, and the hair feature keeps its layer's edge where this matte is opaque.
 *
 * GEOMETRY. The opening is stored as two curves over the same u samples (eye frame = the image axes:
 * an axis-aligned warp lattice folds when the closing direction is tilted against it), upper(u) and
 * lower(u), grown by EYE_TUNING.grow. When the eye closes the lids meet on a gentle arc, `meet` of the
 * way from the line between the corners down to the lower curve: the lash band (upper lid warp) moves
 * down rigidly onto it, the lower lid line (lower lid warp) rises the rest of the way, and the mask's
 * rows meet there. Above the lash band the lid lattice stretches up to the top of the region (nothing
 * moving lies there: the brow never moves), across the opening it compresses without folding, and the
 * travel eases in at the corners.
 *
 * HAIR IN FRONT OF THE EYE: non-skin pixels that cross the region's outline from far outside (the
 * region is drawn on skin, outside the lashes) in tones that are no skin shading, followed inward in
 * colours that are none of the eye's own, plus the lock's thin dark outline (where a lock crosses the
 * opening its outline runs on through the lash line; a bang that only ends on the lashes takes none of
 * them). It stays out of the moving layers; the eye claims it only weakly (EYE_TUNING.frontClaim: the
 * hair layer takes it, the brows stay out of it). Behind it and its rim the eye layers continue the
 * eye (the eyeball, the lash line, the lid skin), so the hair can move and the eye can close behind it.
 */
import type { ImageRGBA } from '../../core/types.js';
import { cloneImage, createImage } from '../../render/image.js';
import { AVATAR_Z, smoothstep, type Field, type RectTuple } from '../fields.js';
import { colorMatchMask, dominantColors, imageToLab, type LabImage } from '../image/color.js';
import { connectedComponents, growRegion, removeSmallComponents } from '../image/components.js';
import { alphaBounds, cropRect, pasteImage } from '../image/compose.js';
import { dilateMask, distanceTransform, erodeMask, signedDistance } from '../image/distance.js';
import { extendEdges, inpaint } from '../image/inpaint.js';
import { createMask, maskBounds, maskCount, maskThreshold, maskUnion } from '../image/mask.js';
import { polygonBounds, polygonCentroid, polygonEnvelope, translatePoints } from '../image/polygon.js';
import { polygonMask } from '../image/raster.js';
import { pixelRect, unionRect, type Lab, type Mask, type RGB, type Rect } from '../image/types.js';
import type { AvatarPose, ImageSide, LayerInfo } from '../types.js';
import {
  blankLike,
  channelDifference,
  faceSkinColor,
  hasAlpha,
  hexColor,
  interpolate,
  labAt,
  labDistance,
  makeFrame,
  mapPoints,
  maskWhere,
  medianColor,
  nearestDistance,
  rgbToLab,
  round2,
  writeMatte,
  writeMatteToward,
  writeOpaque,
  parseHex,
  type Frame,
} from './eyes-matte.js';
import type { AvatarFeature, CompileContext, LayersContext } from './types.js';

export const EYE_TUNING = {
  /** The mask mesh is this many px larger than the opening on every side: its antialiased edge hides under the lids. */
  grow: 1.5,
  /** Lid pixels this close to the edge of the mask mesh are fully opaque (px). */
  safe: 0.75,
  /**
   * Where the lids meet when the eye is closed: this share of the way from the line between the two
   * corners down to the lower curve. 1 = on the lower lid line (a deep cup on a tall eye), 0 = on the
   * corner line; the upper lid travels most of the way, the lower lid rises the rest.
   */
  meet: 0.45,
  /** The lash line and the lower lid line overlap by twice this when the eye is closed (px). */
  overlap: 1,
  /** Over this share of the opening width from each corner the travel eases in. */
  corner: 0.15,
  /** A pixel counts as drawn on the skin when it differs from the eyelid fill by this many levels. */
  strong: 28,
  /** The lash band reaches this many lash thicknesses (+ 1.5 px) beyond the opening (lower lid likewise). */
  band: 1.35,
  /** deltaE beyond which a pixel is not skin; the soft range (beyond stroke) of the pixels that feed the eyelid fill. */
  notSkin: 18,
  skinSoft: 10,
  /** Hair may be followed freely this share of the way from the region outline to the opening. */
  marginShare: 0.3,
  /** Inside that margin hair is only followed in colours at least this far (deltaE) from the eye's own... */
  hairDistinct: 10,
  /** ...within this tolerance; only pixels within hairCore of the hair's own tones count as hair in front; with hairRing px around it (its antialiased edge) it is a matte above the eye layers. */
  hairTolerance: 7,
  hairCore: 12,
  /** Hair tones differ from the skin by at least this (deltaE): the skin's shading next to a lock is no hair. */
  hairSkin: 30,
  hairRing: 2,
  /**
   * The eye claims the hair over it only this much (below the 0.5 at which a pixel counts as taken):
   * the hair layer takes those pixels, and features that must stay out of the eye's layers (the brows)
   * read the weak claim.
   */
  frontClaim: 0.3,
  /** A pixel next to the hair is its rim when the hair's colour makes up at least this share of it. */
  rimShare: 0.1,
  /** Over the eyeball the rim takes one pixel more where the hair darkens it by this much (luma). */
  ballRingDarker: 3,
  /** Pixels darker than the hair by more than this (L*) next to it are lashes, not its edge... */
  hairDarker: 3,
  /** ...unless they form a thin line along it (at most outlineWidth px from the hair, more than outlineGap px from any dark mass): its outline. */
  outlineWidth: 3,
  outlineGap: 2,
  /** Give up following hair by colour when it would take more than this share of the region. */
  hairLimit: 0.45,
  /** Gaze: the eyeball shifts by this share of the opening width (x; less in y), more when an iris circle shows the room. */
  gaze: 0.03,
  gazeMax: 0.085,
  gazeY: 0.6,
  /** The crease layer is fully visible from this EyeOpen value up. */
  creaseVisible: 0.45,
  /**
   * Eye-white pixels outside the mask mesh: within whiteTolerance (deltaE) of the white and nearer to it
   * than to the skin, at most whiteReach px from the mesh. When the white differs from the skin by less
   * than whiteDistinct, only pixels at least whiteLighter (L) lighter than the skin count.
   */
  whiteTolerance: 14,
  whiteReach: 3,
  whiteDistinct: 10,
  whiteLighter: 3,
  /** The rim layers (eye white on the lid edges) are fully visible from this EyeOpen value up. */
  rimVisible: 0.3,
  /** The lash line is continued under hair from at most this share of the opening width away. */
  continueReach: 0.35,
  /** A stroke on the skin (lash, lid or crease line) differs from the skin by this deltaE; it is taken with strokeMargin px of skin around it (its soft edge). */
  stroke: 28,
  strokeMargin: 2,
  /** A lock crossing the region outline reaches at least this share of the window margin outside it. */
  reachOut: 0.35,
  /** Across the opening the lid motion fades out over the opening plus this many px plus a share of the travel (the lattice compresses, never flips). */
  fadeAcross: 2,
  fadeShare: 0.6,
  /** Beyond the lash band the motion fades out over at least this many lattice cells. */
  fadeCells: 2,
  /** Lattice cells across the opening (the cell is never smaller than 2 px). */
  cells: 22,
} as const;

/** Model id prefix per image side: `L` is the character's left, the eye on the image RIGHT. */
export const EYE_IDS: Record<ImageSide, 'eyeL' | 'eyeR'> = { imageLeft: 'eyeR', imageRight: 'eyeL' };
const EYE_OPEN: Record<ImageSide, 'EyeLOpen' | 'EyeROpen'> = { imageLeft: 'EyeROpen', imageRight: 'EyeLOpen' };
const SIDES: readonly ImageSide[] = ['imageLeft', 'imageRight'];

/** What the layer stage stores per eye (textures/layers.json, key "eyes"). Frame coordinates are px. */
export interface EyeMeta {
  /** "eyeL" | "eyeR": prefix of every layer, part and warp of this eye. */
  id: string;
  /** Eye frame: centre in source pixels and the direction of u (degrees, clockwise; the layer stage writes 0: the image axes). */
  center: [number, number];
  angle: number;
  /**
   * Positions along the eye line and, at each, the upper / lower edge of the mask mesh and the top /
   * bottom of the region (v, downward). `bottom` is absent in metadata of early builds.
   */
  u: number[];
  upper: number[];
  lower: number[];
  top: number[];
  bottom?: number[];
  /** How far the mask mesh reaches beyond the opening (px). */
  grow: number;
  /** Thickness of the upper lash line and of the lower lid line (px; `lowerLash` may be absent). */
  lash: number;
  lowerLash?: number;
  /** Shift of the eyeball at EyeBallX = 1 / EyeBallY = 1 (px along / across the eye line). */
  shift: [number, number];
  /** The rectangle of the lid layers and of the eye warps. */
  rect: RectTuple;
  /** Estimated colours, "#rrggbb". */
  colors: { skin: string; white: string; iris: string; lash: string };
  /** Share of the region covered by hair in front of the eye. */
  occluded: number;
}

export interface EyesMeta {
  version: 1;
  imageLeft?: EyeMeta;
  imageRight?: EyeMeta;
}

// ----------------------------------------------------------------------------- geometry (both stages)

/** The geometry of one eye from its metadata: curves, where the lids meet, travels and weights. */
export interface EyeGeometry {
  frame: Frame;
  /** Upper / lower edge of the mask mesh, top / bottom of the region at u. */
  upperAt(u: number): number;
  lowerAt(u: number): number;
  topAt(u: number): number;
  bottomAt(u: number): number;
  /** True between the two corners of the mask mesh. */
  inRange(u: number): boolean;
  /** Where the lids meet when the eye is closed (v at u; between the upper and the lower curve). */
  meet(u: number): number;
  /** How far the upper lid travels down / the lower lid travels up at u when the eye closes. */
  travelUp(u: number): number;
  travelDown(u: number): number;
  /** Top of the upper lid's band (the lash line) / bottom of the lower lid's band: they move rigidly. */
  upperEdge(u: number): number;
  lowerEdge(u: number): number;
  /** Share of travelUp / travelDown a point takes. */
  upperWeight(u: number, v: number): number;
  lowerWeight(u: number, v: number): number;
}

/**
 * `cell` is the lattice cell of the eye warps (px): the rigid band of each lid reaches one cell beyond
 * its content, so no lattice cell that carries lashes is stretched.
 */
export function eyeGeometry(eye: EyeMeta, cell = 4): EyeGeometry {
  const T = EYE_TUNING;
  const frame = makeFrame(eye.center, eye.angle);
  const { u, upper, lower, top } = eye;
  const n = u.length;
  const bottom = eye.bottom && eye.bottom.length === n ? eye.bottom : lower.map((v) => v + Math.max(4, eye.lash));
  const lowerLash = eye.lowerLash ?? Math.max(2, eye.lash / 3);
  const first = u[0];
  const last = u[n - 1];
  const inRange = (x: number) => x >= first && x <= last;
  const upperAt = (x: number) => interpolate(u, upper, x);
  const lowerAt = (x: number) => interpolate(u, lower, x);
  const topAt = (x: number) => interpolate(u, top, x);
  const bottomAt = (x: number) => interpolate(u, bottom, x);
  const left = (upper[0] + lower[0]) / 2;
  const right = (upper[n - 1] + lower[n - 1]) / 2;
  const span = Math.max(1e-6, last - first);
  const meet = (x: number): number => {
    const chord = left + ((right - left) * (x - first)) / span;
    const up = upperAt(x);
    const lo = lowerAt(x);
    return Math.min(lo, Math.max(up, chord + T.meet * (lo - chord)));
  };
  // Travelling less than the mask never shows the eyeball: the mask closes under the lid, skin shows between.
  const ease = (x: number) => (inRange(x) ? smoothstep(Math.min(x - first, last - x) / (T.corner * span)) : 0);
  // The lash line's lower edge (upper + grow at rest) ends `overlap` px below the meeting line, the
  // lower lid line's upper edge (lower - grow) as far above it.
  const travelUp = (x: number) => Math.max(0, meet(x) + T.overlap - upperAt(x) - eye.grow) * ease(x);
  const travelDown = (x: number) => Math.max(0, lowerAt(x) - eye.grow - meet(x) + T.overlap) * ease(x);
  const upperEdge = (x: number) => upperAt(x) - Math.min(Math.max(0, upperAt(x) - topAt(x)), eye.lash * T.band + 1.5);
  const lowerEdge = (x: number) => lowerAt(x) + Math.min(Math.max(0, bottomAt(x) - lowerAt(x)), lowerLash * T.band + 1.5);
  const reach = T.fadeCells * cell;
  const upperWeight = (x: number, v: number): number => {
    const up = upperAt(x);
    const rigid = upperEdge(x) - cell;
    if (v >= rigid) {
      // Across the opening the motion fades out linearly by the lower curve: the lattice compresses
      // there (it carries nothing) but never folds over.
      const from = up + 1;
      if (v <= from) return 1;
      const to = lowerAt(x) + T.fadeAcross + T.fadeShare * travelUp(x);
      return v >= to ? 0 : 1 - (v - from) / (to - from);
    }
    // Above the band the lid skin stretches (nothing of the moving layer is there) up to the region top.
    const start = Math.min(topAt(x), rigid - reach);
    return v <= start ? 0 : smoothstep((v - start) / (rigid - start));
  };
  const lowerWeight = (x: number, v: number): number => {
    const lo = lowerAt(x);
    const rigid = lowerEdge(x) + cell;
    if (v <= rigid) {
      const from = lo - 1;
      if (v >= from) return 1;
      const to = upperAt(x) - T.fadeAcross - T.fadeShare * travelDown(x);
      return v <= to ? 0 : 1 - (from - v) / (from - to);
    }
    const end = Math.max(bottomAt(x), rigid + reach);
    return v >= end ? 0 : smoothstep((end - v) / (end - rigid));
  };
  return { frame, upperAt, lowerAt, topAt, bottomAt, inRange, meet, travelUp, travelDown, upperEdge, lowerEdge, upperWeight, lowerWeight };
}

/** The displacement of the upper lid (`which` = "upper") or of the lower lid at EyeOpen = 0, source pixels. */
export function eyeBlinkField(eye: EyeMeta, which: 'upper' | 'lower', cell = 4): Field {
  const g = eyeGeometry(eye, cell);
  const [dx, dy] = g.frame.down;
  return (x, y) => {
    const [u, v] = g.frame.to(x, y);
    const d = which === 'upper' ? g.travelUp(u) : -g.travelDown(u);
    if (d === 0) return [0, 0];
    const w = which === 'upper' ? g.upperWeight(u, v) : g.lowerWeight(u, v);
    return [d * w * dx + 0, d * w * dy + 0];
  };
}

/**
 * The mask / underlay mesh of an eye: a strip between the upper and the lower curve. `open` are
 * its vertices at rest (upper row, then lower row), `closed` at EyeOpen = 0: both rows lie on the
 * meeting line, every triangle has zero area and nothing of the eyeball is left.
 */
export function eyeMaskMesh(eye: EyeMeta): { open: number[]; closed: number[]; triangles: number[]; outline: number[] } {
  const g = eyeGeometry(eye);
  const n = eye.u.length;
  const up: number[] = [];
  const low: number[] = [];
  const shut: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = g.frame.from(eye.u[i], eye.upper[i]);
    const b = g.frame.from(eye.u[i], eye.lower[i]);
    const c = g.frame.from(eye.u[i], g.meet(eye.u[i]));
    up.push(round2(a[0]), round2(a[1]));
    low.push(round2(b[0]), round2(b[1]));
    shut.push(round2(c[0]), round2(c[1]));
  }
  const triangles: number[] = [];
  for (let i = 0; i + 1 < n; i++) triangles.push(i, i + 1, n + i + 1, i, n + i + 1, n + i);
  const outline = [...up];
  for (let i = n - 1; i >= 0; i--) outline.push(low[i * 2], low[i * 2 + 1]);
  return { open: [...up, ...low], closed: [...shut, ...shut], triangles, outline };
}

/** The lattice cell of the eye warps: about cells across the opening, never more than the detail cell, never below 2 px. */
export function eyeCell(eye: EyeMeta, detail: number): number {
  const width = eye.u[eye.u.length - 1] - eye.u[0];
  return Math.max(2, Math.min(detail, width / EYE_TUNING.cells));
}


// ----------------------------------------------------------------------------- stage 1: layers

/**
 * A polygon moved outward by `distance` px along its normals (mitred corners, the mitre capped at
 * twice the distance). Meant for the gentle outlines of eye openings; either winding.
 */
export function offsetPolygon(points: ArrayLike<number>, distance: number): number[] {
  const n = Math.floor(points.length / 2);
  if (n < 3) return Array.from(points);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  // With +y down a positive shoelace sum is clockwise on screen: the outward normal of edge (dx, dy) is (dy, -dx).
  const sign = area >= 0 ? 1 : -1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n;
    const q = (i + 1) % n;
    const ax = points[i * 2] - points[p * 2];
    const ay = points[i * 2 + 1] - points[p * 2 + 1];
    const bx = points[q * 2] - points[i * 2];
    const by = points[q * 2 + 1] - points[i * 2 + 1];
    const al = Math.hypot(ax, ay) || 1;
    const bl = Math.hypot(bx, by) || 1;
    let nx = (sign * ay) / al + (sign * by) / bl;
    let ny = (-sign * ax) / al + (-sign * bx) / bl;
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) {
      out.push(points[i * 2], points[i * 2 + 1]);
      continue;
    }
    nx /= len;
    ny /= len;
    // cos of half the turning angle: 1 on a straight run, small at a sharp corner.
    const half = Math.max(0.5, len / 2);
    out.push(points[i * 2] + (nx * distance) / half, points[i * 2 + 1] + (ny * distance) / half);
  }
  return out;
}

/** Smallest and largest y of a polygon's outline at x (both NaN when x misses it). */
function envelopeAt(points: ArrayLike<number>, x: number): [number, number] {
  const n = Math.floor(points.length / 2);
  let lo = Infinity;
  let hi = -Infinity;
  let nearest = 0;
  let nearestD = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = points[i * 2];
    const y0 = points[i * 2 + 1];
    const x1 = points[j * 2];
    const y1 = points[j * 2 + 1];
    if (Math.abs(x0 - x) < nearestD) {
      nearestD = Math.abs(x0 - x);
      nearest = y0;
    }
    if (x < Math.min(x0, x1) || x > Math.max(x0, x1)) continue;
    if (x0 === x1) {
      lo = Math.min(lo, y0, y1);
      hi = Math.max(hi, y0, y1);
    } else {
      const y = y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  }
  // Rounding can put the first / last sample a hair outside the polygon: its nearest vertex then.
  return lo <= hi ? [lo, hi] : [nearest, nearest];
}

/** Lightest and most common other colour of the pixels under a mask. */
function ballColors(src: ImageRGBA, mask: Mask): { white: RGB; other: RGB } | null {
  const clusters = dominantColors(src, mask, 3);
  if (clusters.length === 0) return null;
  const byLight = [...clusters].sort((a, b) => b.lab[0] - a.lab[0]);
  const white = byLight[0];
  const rest = clusters.filter((c) => c !== white);
  const other = rest.length ? rest[0] : white;
  return { white: white.rgb, other: other.rgb };
}

interface OccluderInput {
  src: ImageRGBA;
  lab: LabImage;
  /** 1 where a pixel is not skin. */
  far: Uint8Array;
  region: Mask;
  regionDistance: Mask;
  /** Pixels the mask mesh may touch. */
  reach: Mask;
  eyeColors: Lab[];
  /** The skin around the eye. */
  skin: Lab;
  openingWidth: number;
  /** Hair is followed freely this deep into the region (px)... */
  depth: number;
  /** ...when it reaches at least this far outside the region (px). */
  reachOut: number;
}

/**
 * Hair (or anything else) lying in front of the eye: binary mask. The region is drawn on skin, so
 * whatever is not skin and crosses its outline from far outside (a lock of hair, a brow) lies in
 * front; lash tips and creases that the outline merely touches do not reach far outside. Inward the
 * hair is followed by its own colours where they differ from the eye's. `info` receives the reason
 * when the search was cut short.
 */
function findOccluders(input: OccluderInput, info: (message: string) => void): Mask {
  const T = EYE_TUNING;
  const { src, lab, far, region, regionDistance, reach, depth, reachOut } = input;
  const { width, height } = region;
  const n = width * height;
  const inside = (i: number) => region.data[i] >= 0.5;
  const outerBand = maskWhere(width, height, (i) => far[i] === 1 && regionDistance.data[i] > -depth);
  const parts = connectedComponents(outerBand, { connectivity: 8 });
  if (parts.count === 0) return createMask(width, height);
  const farthest = new Float64Array(parts.count + 1).fill(-Infinity);
  const touches = new Uint8Array(parts.count + 1);
  for (let i = 0; i < n; i++) {
    const label = parts.labels[i];
    if (!label) continue;
    const d = regionDistance.data[i];
    if (d > farthest[label]) farthest[label] = d;
    if (d <= 0.5) touches[label] = 1;
  }
  const isHair = (label: number) => label > 0 && touches[label] === 1 && farthest[label] >= reachOut;
  let found = maskWhere(width, height, (i) => isHair(parts.labels[i]) && regionDistance.data[i] <= 0.5);
  let area = 0;
  for (let i = 0; i < n; i++) if (inside(i)) area++;
  if (maskCount(found) === 0) return found;
  // The hair's tones come from well outside the region (a lash wedge reaching just past its outline is no hair).
  const outside = maskWhere(width, height, (i) => isHair(parts.labels[i]) && regionDistance.data[i] > Math.max(0.5, reachOut / 2));
  const clusters = dominantColors(src, outside, 3).filter((c) => c.share >= 0.1 && nearestDistance(c.lab, [input.skin]) >= T.hairSkin);
  // Only the skin's shading crosses the outline (a shadow next to a lock, a blush): nothing is in front.
  if (clusters.length === 0) return createMask(width, height);
  const scope = maskWhere(width, height, (i) => far[i] === 1 && (inside(i) || reach.data[i] > 0));
  const distinct = clusters.filter((c) => nearestDistance(c.lab, input.eyeColors) >= T.hairDistinct).map((c) => c.lab);
  if (distinct.length) {
    const grown = growRegion(lab, found, { tolerance: T.hairTolerance, references: distinct, limit: scope, connectivity: 8 });
    if (maskCount(grown) <= T.hairLimit * area) found = maskUnion(found, grown);
    else info('hair in front of the eye could not be told from the eye by colour: only its part near the region outline is kept in front');
  }
  // Only the hair itself, in its own tones: its antialiased rim and outline (mixed with lashes, eye
  // white or skin) stay with the eye layers, which reproduce them at rest, so a hair layer drawn
  // above (its soft edge included) needs no copy of them.
  const tones = clusters.map((c) => c.lab);
  const core = maskWhere(width, height, (i) => found.data[i] >= 0.5 && nearestDistance(labAt(lab, i), tones) < T.hairCore);
  return removeSmallComponents(core, 3);
}

/**
 * Thickness of a lid line: the median run of drawn pixels from the opening outward (dir -1: up from
 * `start`, the top of the opening; +1: down from its bottom) over the middle of the eye, at most to `limit`.
 */
function lineThickness(strong: Uint8Array, width: number, height: number, origin: [number, number], frame: Frame, u: number[], start: number[], limitAt: number[], dir: 1 | -1): number {
  const runs: number[] = [];
  const n = u.length;
  for (let k = Math.floor(n / 4); k <= Math.ceil((3 * n) / 4) && k < n; k++) {
    const edge = start[k];
    const limit = Math.max(1, Math.abs(edge - limitAt[k]));
    const slack = 2 + 0.08 * limit;
    let run = 0;
    let started = false;
    for (let d = -1; d < limit; d++) {
      const [x, y] = frame.from(u[k], edge + dir * (d + 0.5));
      const px = Math.floor(x - origin[0]);
      const py = Math.floor(y - origin[1]);
      const on = px >= 0 && py >= 0 && px < width && py < height && strong[py * width + px] === 1;
      if (on) {
        started = true;
        run++;
      } else if (started || d > slack) break;
    }
    runs.push(run);
  }
  runs.sort((a, b) => a - b);
  return runs.length ? runs[runs.length >> 1] : 0;
}

/**
 * Fill the pixels of `gap` in `img` (IN PLACE) with the line that runs through them: every gap pixel
 * takes the pixel at the same height above the curve `along(u)` in the nearest column on each side
 * outside the gap (at most `reach` px away), blended by distance (premultiplied). It continues the
 * lash line under a lock of hair, so the line has no notch when it moves away from the hair.
 * The eye frame is the image frame (angle 0): columns are pixel columns.
 */
function continueAlong(img: ImageRGBA, gap: Mask, fu: Float32Array, fv: Float32Array, along: (u: number) => number, reach: number): void {
  const { width, height } = img;
  const src = new Uint8ClampedArray(img.data);
  const max = Math.max(1, Math.ceil(reach));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (gap.data[i] !== 1) continue;
      const offset = fv[i] - along(fu[i]);
      const acc = [0, 0, 0, 0];
      let total = 0;
      for (const dir of [-1, 1]) {
        for (let d = 1; d <= max; d++) {
          const nx = x + dir * d;
          if (nx < 0 || nx >= width) break;
          // The row in column nx at the same height above the curve.
          const k = y * width + nx;
          const ny = Math.round(y + along(fu[k]) + offset - fv[k]);
          if (ny < 0 || ny >= height) break;
          const j = ny * width + nx;
          if (gap.data[j] === 1) continue;
          const w = 1 / d;
          // Faint pixels around the line (soft skin shading in the matte) are not continued.
          const a = src[j * 4 + 3] >= 96 ? src[j * 4 + 3] / 255 : 0;
          for (let c = 0; c < 3; c++) acc[c] += src[j * 4 + c] * a * w;
          acc[3] += a * w;
          total += w;
          break;
        }
      }
      if (total === 0) continue;
      const alpha = acc[3] / total;
      const o = i * 4;
      for (let c = 0; c < 3; c++) img.data[o + c] = acc[3] > 0 ? Math.round(acc[c] / acc[3]) : 0;
      img.data[o + 3] = Math.round(alpha * 255);
    }
  }
}

function buildEye(ctx: LayersContext, side: ImageSide, skin: RGB): EyeMeta | null {
  const T = EYE_TUNING;
  const { source } = ctx;
  const eye = ctx.spec.face.eyes[side];
  const id = EYE_IDS[side];
  const path = `/face/eyes/${side}/opening`;
  const center = polygonCentroid(eye.opening);
  // The eye closes along the image vertical even on a tilted head: the warp lattice is axis-aligned,
  // and a motion across its cells (a closing direction tilted against them) folds them over where the
  // travel changes fast, at the corners. The frame keeps the geometry general (EyeMeta.angle).
  const angle = 0;
  const frame = makeFrame(center, angle);

  // The opening as two curves over the eye line, grown by the mask margin.
  const openingF = mapPoints(eye.opening, frame.to);
  const ob = polygonBounds(openingF);
  if (!(ob.width >= 4 && ob.height >= 2)) {
    ctx.report.warning('avatar-eye-too-small', `the opening of the ${side} eye is only ${round2(ob.width)} x ${round2(ob.height)} px: the eye is left as it is`, { path, hint: 'trace the visible eye white and iris; use a larger illustration when the eyes are this small' });
    return null;
  }
  const mid = ob.x + ob.width / 2;
  // Grown along its normals, so steep ends of the opening get the margin too.
  const grownF = offsetPolygon(openingF, T.grow);
  const gb = polygonBounds(grownF);
  const count = Math.max(9, Math.min(25, Math.round(ob.width / 4) | 1));
  const step = gb.width / (count - 1);
  const positions: number[] = [];
  for (let k = 0; k < count; k++) positions.push(k === count - 1 ? gb.x + gb.width : gb.x + step * k);
  // The ends are round: two more samples in the first and the last interval keep the strip around them.
  positions.splice(1, 0, gb.x + step * 0.2, gb.x + step * 0.55);
  positions.splice(positions.length - 1, 0, gb.x + gb.width - step * 0.55, gb.x + gb.width - step * 0.2);
  const u = positions.map(round2);
  const spans = positions.map((x) => envelopeAt(grownF, x));
  const upper = spans.map((s) => round2(s[0]));
  const lower = spans.map((s) => round2(s[1]));
  const envR = polygonEnvelope(mapPoints(eye.region, frame.to), 33);
  const top = u.map((x, i) => round2(Math.min(interpolate(envR.x, envR.upper, x), upper[i] - 1)));
  const bottom = u.map((x, i) => round2(Math.max(interpolate(envR.x, envR.lower, x), lower[i] + 1)));

  const draft: EyeMeta = { id, center: [round2(center[0]), round2(center[1])], angle, u, upper, lower, top, bottom, grow: T.grow, lash: 0, lowerLash: 0, shift: [0, 0], rect: [0, 0, 1, 1], colors: { skin: '', white: '', iris: '', lash: '' }, occluded: 0 };
  const mesh = eyeMaskMesh(draft);

  // The window all the work happens in.
  const bounds = unionRect(polygonBounds(eye.region), polygonBounds(eye.opening));
  const pad = Math.ceil(Math.max(8, 0.25 * Math.max(bounds.width, bounds.height)));
  const win = pixelRect(bounds, pad, source.width, source.height);
  const ww = win.width;
  const wh = win.height;
  const n = ww * wh;
  if (n === 0) return null;
  const src = cropRect(source, win);
  const lab = imageToLab(src);
  const local = (points: ArrayLike<number>) => translatePoints(points, -win.x, -win.y);
  const region = polygonMask(ww, wh, local(eye.region));
  const opening = polygonMask(ww, wh, local(eye.opening));
  const covered = polygonMask(ww, wh, local(mesh.outline));
  // Pixels that are certainly inside the mask mesh (the eyeball shows) and pixels it may touch at all.
  const ball = maskThreshold(erodeMask(maskThreshold(covered, 0.999), T.safe), 0.5);
  const reach = maskThreshold(dilateMask(maskThreshold(covered, 0.001), T.safe), 0.5);
  if (maskCount(ball) === 0) {
    ctx.report.warning('avatar-eye-too-small', `the opening of the ${side} eye covers no whole pixel: the eye is left as it is`, { path });
    return null;
  }

  // Skin around this eye.
  const skinLab = rgbToLab(skin[0], skin[1], skin[2]);
  const regionDistance = signedDistance(region);
  const ring = Math.max(3, 0.12 * Math.max(bounds.width, bounds.height));
  const whole: Rect = { x: 0, y: 0, width: ww, height: wh };
  const localSkin = medianColor(src, whole, (_x, _y, i) => regionDistance.data[i] > 0.5 && regionDistance.data[i] < ring && labDistance(lab, i, skinLab) < T.notSkin, 12) ?? skin;
  const localLab = rgbToLab(localSkin[0], localSkin[1], localSkin[2]);
  const far = new Uint8Array(n);
  for (let i = 0; i < n; i++) far[i] = src.data[i * 4 + 3] < 128 || labDistance(lab, i, localLab) > T.notSkin ? 1 : 0;

  // Frame coordinates of every pixel centre.
  const fu = new Float32Array(n);
  const fv = new Float32Array(n);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const p = frame.to(x + 0.5 + win.x, y + 0.5 + win.y);
      fu[y * ww + x] = p[0];
      fv[y * ww + x] = p[1];
    }
  }
  const first = u[0];
  const last = u[u.length - 1];
  const openingWidth = ob.width;

  // The eye's own colours (from its middle, where hair seldom reaches).
  const core = maskWhere(ww, wh, (i) => ball.data[i] === 1 && opening.data[i] >= 0.999 && Math.abs(fu[i] - mid) < 0.3 * openingWidth);
  const colours = ballColors(src, maskCount(core) >= 6 ? core : ball) ?? { white: [255, 255, 255] as RGB, other: [90, 70, 60] as RGB };
  let iris: RGB = colours.other;
  if (eye.iris) {
    const r = eye.iris.radius * 0.7;
    const [ix, iy] = [eye.iris.center[0] - win.x, eye.iris.center[1] - win.y];
    iris = medianColor(src, { x: ix - r, y: iy - r, width: 2 * r, height: 2 * r }, (x, y, i) => ball.data[i] === 1 && (x + 0.5 - ix) ** 2 + (y + 0.5 - iy) ** 2 <= r * r, 4) ?? iris;
  }
  const probe = Math.max(2, 0.12 * openingWidth);
  const lashZone = maskWhere(ww, wh, (i) => {
    if (far[i] !== 1 || Math.abs(fu[i] - mid) > 0.25 * openingWidth) return false;
    const edge = interpolate(u, upper, fu[i]) + T.grow;
    return fv[i] < edge && fv[i] > edge - probe;
  });
  const lashClusters = dominantColors(src, lashZone, 2).sort((a, b) => a.lab[0] - b.lab[0]);
  const lash: RGB = lashClusters.length ? lashClusters[0].rgb : iris;
  const eyeColors: Lab[] = [colours.white, iris, lash].map((c) => rgbToLab(c[0], c[1], c[2]));

  // Hair in front of the eye: what is not skin and crosses the region outline from far outside.
  const gaps: number[] = [];
  const openingDistance = signedDistance(opening);
  for (let i = 0; i < n; i++) if (Math.abs(regionDistance.data[i]) < 0.75 && Number.isFinite(openingDistance.data[i])) gaps.push(openingDistance.data[i]);
  gaps.sort((a, b) => a - b);
  const gap = gaps.length ? Math.max(0, gaps[gaps.length >> 1]) : 0;
  const occluders = findOccluders(
    { src, lab, far, region, regionDistance, reach, eyeColors, skin: localLab, openingWidth, depth: Math.max(2, T.marginShare * gap), reachOut: Math.max(4, T.reachOut * pad) },
    (message) => ctx.report.info('avatar-eye-hair', `${side} eye: ${message}`, { path: `/face/eyes/${side}/region` }),
  );
  const occluded = maskCount(occluders);
  const front = occluders;
  // Hair in the lashes' or the iris's tones nearer to the opening than to the region outline is the
  // eye's own (a lash wedge at a corner that touches a lock of the same brown), not hair in front.
  for (let i = 0; i < n; i++) {
    if (front.data[i] !== 1) continue;
    const nearer = -regionDistance.data[i] >= openingDistance.data[i];
    if (nearer && nearestDistance(labAt(lab, i), [eyeColors[1], eyeColors[2]]) < T.hairDistinct) front.data[i] = 0;
  }
  if (maskCount(front) > 0) {
    // The lock's dark outline often has the lashes' colour: a thin dark line along the hair (not a dark
    // mass reaching away from it, like the lash line) belongs to the hair.
    const lightness: number[] = [];
    for (let i = 0; i < n; i++) if (front.data[i] === 1) lightness.push(lab.lab[i * 3]);
    lightness.sort((a, b) => a - b);
    const hairL = lightness[lightness.length >> 1];
    const dark = (i: number) => src.data[i * 4 + 3] >= 128 && lab.lab[i * 3] < hairL - T.hairDarker;
    const toFront = distanceTransform(front);
    const mass = maskWhere(ww, wh, (i) => dark(i) && toFront.data[i] > T.outlineWidth + 0.5);
    const toMass = distanceTransform(mass);
    // The lash line is the eye's: dark strokes joined to the opening stay out of the hair, except next to
    // a lock that crosses the opening (its outline runs on through the lash line there). A bang that
    // merely ends on the lashes does not take them.
    const lashes = connectedComponents(maskWhere(ww, wh, (i) => front.data[i] !== 1 && dark(i)), { connectivity: 8 });
    const joined = new Uint8Array(lashes.count + 1);
    const openingBand = dilateMask(opening, 1.5);
    for (let i = 0; i < n; i++) if (lashes.labels[i] && openingBand.data[i] >= 0.5) joined[lashes.labels[i]] = 1;
    const locks = connectedComponents(front, { connectivity: 8 });
    const crosses = new Uint8Array(locks.count + 1);
    for (let i = 0; i < n; i++) if (locks.labels[i] && opening.data[i] >= 0.5) crosses[locks.labels[i]] = 1;
    const toLock = distanceTransform(maskWhere(ww, wh, (i) => locks.labels[i] > 0 && crosses[locks.labels[i]] === 1));
    const outline: number[] = [];
    for (let i = 0; i < n; i++) if (front.data[i] !== 1 && dark(i) && toFront.data[i] <= T.outlineWidth && toMass.data[i] > T.outlineGap) outline.push(i);
    // Where the outline of a lock runs into a dark mass (the lash line it crosses), it goes on as wide as
    // it is elsewhere: the lash ends at the lock's outline, and a closing lid leaves the outline whole.
    let width = 0;
    if (outline.length >= 4) {
      const widths = outline.map((i) => toFront.data[i]).sort((a, b) => a - b);
      width = widths[widths.length >> 1];
      for (let i = 0; i < n; i++) if (front.data[i] !== 1 && dark(i) && toLock.data[i] <= width) outline.push(i);
    }
    for (const i of outline) {
      if (joined[lashes.labels[i]] === 1 && !(toLock.data[i] <= Math.max(width, 1))) continue;
      front.data[i] = 1;
    }
  }
  let regionArea = 0;
  for (let i = 0; i < n; i++) if (region.data[i] >= 0.5) regionArea++;

  // The eyelid: what the mask mesh touches and what is drawn on the skin of the region (lashes,
  // lids, creases and their soft edges) is filled from the skin around it; plain skin stays as it is.
  // Soft shading (eye shadow, blush near the lids) is skin: it stays in the base, also when the eye closes.
  const strokeIn = (img: ImageRGBA, l: LabImage, i: number) => img.data[i * 4 + 3] < 128 || labDistance(l, i, localLab) > T.stroke;
  // A stroke goes on in its fainter parts (a crease that fades out along its length): what is not skin
  // and joined to a stroke is drawn too, so a faded stroke leaves no dashes behind.
  // (Fainter parts only well inside the region: the hole they open stays clear of the brows and hair.)
  const strokes = maskWhere(ww, wh, (i) => region.data[i] >= 0.5 && front.data[i] !== 1 && (strokeIn(src, lab, i) || (far[i] === 1 && regionDistance.data[i] < -(T.strokeMargin + 1))));
  const strokeParts = connectedComponents(strokes, { connectivity: 8 });
  const inked = new Uint8Array(strokeParts.count + 1);
  for (let i = 0; i < n; i++) if (strokeParts.labels[i] && strokeIn(src, lab, i)) inked[strokeParts.labels[i]] = 1;
  const drawn = dilateMask(maskWhere(ww, wh, (i) => strokeParts.labels[i] > 0 && inked[strokeParts.labels[i]] === 1), T.strokeMargin);
  // The hair over the eye (`front`) with its antialiased rim (`covers` = both; eye white next to the
  // hair on the lids is the eye's, on the eyeball the ball continues under the rim): a matte above the eye layers. Behind the rim the eye layers draw what the rim
  // mixes with the hair (`behind`: the picture there continued from the eye next to it), so the hair
  // keeps its own edge whatever the eye does.
  const covers = createMask(ww, wh);
  // The nearest pixel of the hair over the eye (-1 when none is within the rim).
  const nearestFront = (i: number): number => {
    const reachRim = Math.ceil(T.hairRing) + 1;
    const x = i % ww;
    const y = (i - x) / ww;
    let best = -1;
    let bestD = Infinity;
    for (let dy = -reachRim; dy <= reachRim; dy++) {
      for (let dx = -reachRim; dx <= reachRim; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= ww || yy >= wh || front.data[yy * ww + xx] !== 1) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = yy * ww + xx;
        }
      }
    }
    return best;
  };
  // Pixels right next to the hair that it does not darken (skin beside a lock): they stay as they are.
  const beside = createMask(ww, wh);
  let behind = src;
  let labB = lab;
  if (maskCount(front) > 0) {
    const ring = dilateMask(front, T.hairRing);
    // Over the eyeball the rim reaches a pixel farther, wherever the hair darkens the white or the iris
    // at all (a faint step of a slanted edge would otherwise ride along with the gaze).
    const ballRing = dilateMask(front, T.hairRing + 1);
    const luma = (img: ImageRGBA, i: number) => 0.3 * img.data[i * 4] + 0.59 * img.data[i * 4 + 1] + 0.11 * img.data[i * 4 + 2];
    const whiteLuma = 0.3 * colours.white[0] + 0.59 * colours.white[1] + 0.11 * colours.white[2];
    for (let i = 0; i < n; i++) {
      if (front.data[i] === 1) covers.data[i] = 1;
      else if (ball.data[i] === 1) {
        if (ring.data[i] >= 0.5 || (ballRing.data[i] >= 0.5 && luma(src, i) < whiteLuma - T.ballRingDarker)) covers.data[i] = 1;
      } else if (ring.data[i] >= 0.5 && (region.data[i] >= 0.5 || reach.data[i] === 1) && !(labDistance(lab, i, eyeColors[0]) < T.whiteTolerance)) covers.data[i] = 1;
    }
    const continued = inpaint(src, covers, { alpha: 'keep' });
    behind = cloneImage(src);
    for (let i = 0; i < n; i++) {
      if (covers.data[i] !== 1 || front.data[i] === 1) continue;
      // Only a pixel that mixes the hair into what lies behind it is the hair's rim: one lighter than
      // that (skin beside the lock, lighter than the strokes the continuation brought in) is not. (On
      // the eyeball the ball continues under the whole rim: it moves.)
      const hair = nearestFront(i);
      let along = 0;
      let span = 0;
      let lighter = 0;
      for (let k = 0; k < 3; k++) {
        const b = continued.data[i * 4 + k];
        const d = (hair >= 0 ? src.data[hair * 4 + k] : b) - b;
        along += (src.data[i * 4 + k] - b) * d;
        span += d * d;
        lighter += (src.data[i * 4 + k] - b) * [0.3, 0.59, 0.11][k];
      }
      if (ball.data[i] !== 1 && lighter > 2 && !(span > 0 && along / span >= T.rimShare)) {
        covers.data[i] = 0;
        beside.data[i] = 1;
        continue;
      }
      for (let k = 0; k < 3; k++) behind.data[i * 4 + k] = continued.data[i * 4 + k];
    }
    labB = imageToLab(behind);
  }
  const stroke = (i: number) => strokeIn(behind, labB, i);
  // Eye white next to the opening (where the traced opening falls short of the white): it is the eye's.
  const whiteLab = eyeColors[0];
  const whiteDistinct = nearestDistance(whiteLab, [localLab]) >= T.whiteDistinct;
  const nearOpening = maskThreshold(dilateMask(reach, T.whiteReach), 0.5);
  const eyeLike = (i: number) => {
    if (nearOpening.data[i] !== 1) return false;
    const d = labDistance(labB, i, whiteLab);
    if (!(d < T.whiteTolerance)) return false;
    return whiteDistinct ? d < labDistance(labB, i, localLab) : labB.lab[i * 3] >= localLab[0] + T.whiteLighter;
  };
  const hole = maskWhere(ww, wh, (i) => reach.data[i] === 1 || covers.data[i] === 1 || (region.data[i] >= 0.5 && eyeLike(i)) || (drawn.data[i] >= 0.5 && (region.data[i] >= 0.5 || far[i] === 0)));
  const holeBounds = maskBounds(hole);
  if (!holeBounds) {
    ctx.report.warning('avatar-eye-hidden', `the ${side} eye is entirely behind something else: it is left as it is`, { path: `/face/eyes/${side}/region` });
    return null;
  }
  const before = cropRect(ctx.base, win);
  // Every skin pixel around the hole feeds the eyelid (so the fill meets the skin without a step, its
  // shading included), but not the eye white at the corners (it would tint the lid pale) and not hair.
  const sources = colorMatchMask(lab, [localLab], T.stroke, T.skinSoft);
  const away = occluded ? dilateMask(covers, 1) : null;
  const whiteSource = eyeColors[0];
  for (let i = 0; i < n; i++) {
    if (!(sources.data[i] > 0)) continue;
    const toSkin = labDistance(lab, i, localLab);
    if (labDistance(lab, i, whiteSource) < toSkin && toSkin > 4) sources.data[i] = 0;
    else if (away) sources.data[i] *= 1 - Math.min(1, away.data[i]);
  }
  const filled = inpaint(before, hole, { sources });
  for (let i = 0; i < n; i++) {
    // No skin to continue from (a region surrounded by hair): a flat skin tone.
    if (hole.data[i] > 0 && filled.data[i * 4 + 3] === 0 && before.data[i * 4 + 3] > 0) {
      filled.data[i * 4] = localSkin[0];
      filled.data[i * 4 + 1] = localSkin[1];
      filled.data[i * 4 + 2] = localSkin[2];
      filled.data[i * 4 + 3] = before.data[i * 4 + 3];
    }
  }

  // What is drawn on the skin, and how thick the lash line is.
  const strong = new Uint8Array(n);
  for (let i = 0; i < n; i++) strong[i] = hole.data[i] > 0 && covers.data[i] !== 1 && channelDifference(src, filled, i) >= T.strong ? 1 : 0;
  const origin: [number, number] = [win.x, win.y];
  draft.lash = lineThickness(strong, ww, wh, origin, frame, u, upper.map((v) => v + T.grow), top, -1);
  draft.lowerLash = lineThickness(strong, ww, wh, origin, frame, u, lower.map((v) => v - T.grow), bottom, 1);
  const geometry = eyeGeometry(draft);

  // The eyeball: the pixels inside the opening, continued outward so the layer can shift, and under
  // the hair over the eye.
  let room = 0;
  if (eye.iris) {
    const [iu] = frame.to(eye.iris.center[0], eye.iris.center[1]);
    room = Math.max(0, Math.min(iu - eye.iris.radius - (first + T.grow), last - T.grow - (iu + eye.iris.radius)));
  }
  const shiftX = round2(Math.max(T.gaze * openingWidth, Math.min(T.gazeMax * openingWidth, 0.6 * room)));
  const shiftY = round2(shiftX * T.gazeY);
  const reachBounds = maskBounds(reach) as Rect;
  const ballLocal = pixelRect(reachBounds, Math.ceil(shiftX) + 2, ww, wh);
  const ballImage = createImage(ballLocal.width, ballLocal.height);
  const unknown = createMask(ballLocal.width, ballLocal.height, 1);
  let known = 0;
  for (let y = 0; y < ballLocal.height; y++) {
    for (let x = 0; x < ballLocal.width; x++) {
      const i = (y + ballLocal.y) * ww + x + ballLocal.x;
      if (ball.data[i] !== 1 || covers.data[i] === 1 || src.data[i * 4 + 3] < 128) continue;
      const o = (y * ballLocal.width + x) * 4;
      ballImage.data[o] = src.data[i * 4];
      ballImage.data[o + 1] = src.data[i * 4 + 1];
      ballImage.data[o + 2] = src.data[i * 4 + 2];
      ballImage.data[o + 3] = src.data[i * 4 + 3];
      unknown.data[y * ballLocal.width + x] = 0;
      known++;
    }
  }
  if (known === 0) {
    ctx.report.warning('avatar-eye-hidden', `nothing of the ${side} eye's opening is visible: the eye is left as it is`, { path });
    return null;
  }
  let ballFilled = inpaint(ballImage, unknown, { alpha: 'opaque' });
  {
    // A rim pixel on the eyeball that is lighter than what the ball continues under the hair is the
    // eyeball's own (shaded white beside a lock): it stays in the ball, out of the hair's matte.
    const luma = (img: ImageRGBA, o: number) => 0.3 * img.data[o] + 0.59 * img.data[o + 1] + 0.11 * img.data[o + 2];
    let changed = false;
    for (let y = 0; y < ballLocal.height; y++) {
      for (let x = 0; x < ballLocal.width; x++) {
        const i = (y + ballLocal.y) * ww + x + ballLocal.x;
        const o = (y * ballLocal.width + x) * 4;
        if (ball.data[i] !== 1 || covers.data[i] !== 1 || front.data[i] === 1 || src.data[i * 4 + 3] < 128) continue;
        if (luma(src, i * 4) <= luma(ballFilled, o) + 2) continue;
        covers.data[i] = 0;
        ballImage.data.set(src.data.subarray(i * 4, i * 4 + 4), o);
        unknown.data[y * ballLocal.width + x] = 0;
        changed = true;
      }
    }
    if (changed) ballFilled = inpaint(ballImage, unknown, { alpha: 'opaque' });
  }
  // What lies under the lid layers at rest: the fill, and inside the mask mesh (coverage c) the eyeball.
  const whiteRgb = parseHex(hexColor(colours.white)) as RGB;
  const under = cloneImage(filled);
  for (let y = 0; y < ballLocal.height; y++) {
    for (let x = 0; x < ballLocal.width; x++) {
      const i = (y + ballLocal.y) * ww + x + ballLocal.x;
      const c = covered.data[i];
      if (!(c > 0)) continue;
      const o = (y * ballLocal.width + x) * 4;
      // The ball (opaque) over the white mesh over the fill, both clipped to the mesh's coverage.
      for (let k = 0; k < 3; k++) under.data[i * 4 + k] = Math.round(c * ballFilled.data[o + k] + (1 - c) * (c * whiteRgb[k] + (1 - c) * filled.data[i * 4 + k]));
    }
  }

  // The lid layers: difference mattes against what lies under them. Eye white next to the opening that
  // the mask mesh does not cover rides on the lid edges in layers of its own that fade out as the eye
  // closes, so the closed eye shows no white line (only when the white can be told from the skin).
  const cornerLeft = (upper[0] + lower[0]) / 2;
  const cornerRight = (upper[upper.length - 1] + lower[lower.length - 1]) / 2;
  // The lash line: the strokes of the lash band that are joined to the opening (with their soft edge),
  // and past the corners, where the lids do not move, the lash that goes on from the opening (a flared
  // outer corner stays where it is and the closed lash runs into it). A stroke separated from it by
  // skin (a double-eyelid line just above the lashes) is not lash: it stays where it is and fades out
  // with the crease, instead of riding down onto the closed lash.
  const lashLine = createMask(ww, wh);
  {
    const band = maskWhere(ww, wh, (i) => {
      if (hole.data[i] !== 1 || !stroke(i) || front.data[i] === 1) return false;
      const x = fu[i];
      if (x < first || x > last) return true;
      return fv[i] < (geometry.upperAt(x) + geometry.lowerAt(x)) / 2 && fv[i] >= geometry.upperEdge(x);
    });
    const parts = connectedComponents(band, { connectivity: 8 });
    const touches = new Uint8Array(parts.count + 1);
    const openingBand = dilateMask(reach, 1.5);
    for (let i = 0; i < n; i++) if (parts.labels[i] && openingBand.data[i] >= 0.5) touches[parts.labels[i]] = 1;
    const joined = maskWhere(ww, wh, (i) => parts.labels[i] > 0 && touches[parts.labels[i]] === 1);
    const soft = dilateMask(joined, T.strokeMargin);
    for (let i = 0; i < n; i++) lashLine.data[i] = soft.data[i];
  }
  const upperImage = blankLike(src);
  const creaseImage = blankLike(src);
  const lowerImage = blankLike(src);
  const upperRim = blankLike(src);
  const lowerRim = blankLike(src);
  // Where the mask mesh covers part of a pixel, what lies under it depends on how the renderer samples
  // the mesh: an opaque copy is right for any sampling.
  const partly = (i: number) => covered.data[i] > 0.001 && covered.data[i] < 0.999;
  const write = (img: ImageRGBA, i: number) => {
    if (partly(i)) writeOpaque(img, behind, i);
    else writeMatte(img, behind, under, i);
  };
  // What fades out with the crease: strokes and eye white, with the soft skin around them (taken into
  // the hole with them), so a faded stroke leaves no outline: the fill continues the skin around it.
  // Outside the region the soft skin stays as it is (the edge of a brow or a lock next to it).
  const fade = (i: number) => {
    if (region.data[i] < 0.5 && !stroke(i) && labDistance(labB, i, localLab) <= T.notSkin) {
      for (let c = 0; c < 4; c++) {
        filled.data[i * 4 + c] = behind.data[i * 4 + c];
        under.data[i * 4 + c] = behind.data[i * 4 + c];
      }
    } else write(creaseImage, i);
  };
  for (let i = 0; i < n; i++) {
    // The hair over the eye stays out of the moving layers (it is a matte above them).
    if (hole.data[i] !== 1 || ball.data[i] === 1 || front.data[i] === 1) continue;
    const rim = reach.data[i] === 1;
    if (beside.data[i] === 1 && !rim && !eyeLike(i)) {
      for (let c = 0; c < 4; c++) {
        filled.data[i * 4 + c] = src.data[i * 4 + c];
        under.data[i * 4 + c] = src.data[i * 4 + c];
      }
      continue;
    }
    const x = fu[i];
    const white = eyeLike(i);
    if (x >= first && x <= last) {
      if (fv[i] >= (geometry.upperAt(x) + geometry.lowerAt(x)) / 2) write(white ? lowerRim : lowerImage, i);
      else if (white) write(upperRim, i);
      else if (fv[i] >= geometry.upperEdge(x) && (rim || lashLine.data[i] >= 0.5)) write(upperImage, i);
      else fade(i);
    } else if (white) write(creaseImage, i);
    else if (lashLine.data[i] >= 0.5) write(upperImage, i);
    else if (fv[i] < (x < first ? cornerLeft : cornerRight)) {
      // Other strokes above a corner (a flick apart from the lash) cannot follow the lid down: they fade
      // out with the crease.
      fade(i);
    } else write(lowerImage, i);
  }
  if (occluded) {
    // The lash line continues under the hair: when it moves down, no notch may be left where the hair
    // hid it. What the continuation adds lies under the hair's matte (part of what is behind it).
    const hidden = maskWhere(ww, wh, (i) => {
      const x = fu[i];
      if (front.data[i] !== 1 || x < first || x > last) return false;
      return fv[i] >= geometry.upperEdge(x) && fv[i] <= geometry.upperAt(x) + T.grow + 1;
    });
    if (maskCount(hidden) > 0) {
      continueAlong(upperImage, hidden, fu, fv, geometry.upperAt, T.continueReach * openingWidth);
      for (let i = 0; i < n; i++) {
        if (hidden.data[i] !== 1) continue;
        const a = upperImage.data[i * 4 + 3] / 255;
        for (let k = 0; k < 3; k++) under.data[i * 4 + k] = Math.round(upperImage.data[i * 4 + k] * a + under.data[i * 4 + k] * (1 - a));
      }
    }
  }
  const lidLocal = pixelRect(holeBounds, 1, ww, wh);
  const lidRect: RectTuple = [lidLocal.x + win.x, lidLocal.y + win.y, lidLocal.width, lidLocal.height];

  // Commit: the base, the layers, the claim.
  const base = cloneImage(ctx.base);
  pasteImage(base, filled, win.x, win.y);
  ctx.base = base;
  ctx.addLayer(`${id}_ball`, ballFilled, [ballLocal.x + win.x, ballLocal.y + win.y, ballLocal.width, ballLocal.height]);
  ctx.addLayer(`${id}_lower`, extendEdges(cropRect(lowerImage, lidLocal), 2), lidRect);
  if (hasAlpha(lowerRim)) ctx.addLayer(`${id}_lowerRim`, extendEdges(cropRect(lowerRim, lidLocal), 2), lidRect);
  if (hasAlpha(creaseImage)) ctx.addLayer(`${id}_crease`, extendEdges(cropRect(creaseImage, lidLocal), 2), lidRect);
  ctx.addLayer(`${id}_upper`, extendEdges(cropRect(upperImage, lidLocal), 2), lidRect);
  if (hasAlpha(upperRim)) ctx.addLayer(`${id}_upperRim`, extendEdges(cropRect(upperRim, lidLocal), 2), lidRect);
  if (maskCount(covers) > 0) {
    // The hair over the eye: an opaque copy of the hair, and its rim as a matte (of the nearest hair's
    // colour) over what the eye draws behind it at rest.
    const frontImage = blankLike(src);
    for (let i = 0; i < n; i++) {
      if (covers.data[i] !== 1) continue;
      if (front.data[i] === 1) {
        writeOpaque(frontImage, src, i);
        continue;
      }
      const best = nearestFront(i);
      const backing = ball.data[i] === 1 ? under : behind;
      if (best >= 0) writeMatteToward(frontImage, src, backing, i, src.data.subarray(best * 4, best * 4 + 3));
      else writeMatte(frontImage, src, backing, i);
    }
    const fb = alphaBounds(frontImage);
    if (fb) {
      const fr = pixelRect(fb, 1, ww, wh);
      ctx.addLayer(`${id}_front`, extendEdges(cropRect(frontImage, fr), 2), [fr.x + win.x, fr.y + win.y, fr.width, fr.height]);
    }
  }
  // The eye claims its region and everything it cut, except the hair over it: the hair layer takes that
  // whole (its opaque core continues the lock across the region's outline), and ./hair.ts moves
  // <id>_front, the hair's matte over the eye, with it.
  const claim = createMask(ww, wh);
  for (let i = 0; i < n; i++) claim.data[i] = front.data[i] === 1 ? T.frontClaim : Math.max(region.data[i], hole.data[i]);
  ctx.claim(claim, win.x, win.y);

  ctx.report.stat(`${id}Lash`, draft.lash);
  ctx.report.stat(`${id}Occluded`, round2(occluded / Math.max(1, regionArea)));
  if (occluded > 0.5 * regionArea) {
    ctx.report.warning('avatar-eye-covered', `more than half of the ${side} eye region is covered by something that is not skin and reaches its outline (hair?)`, { path: `/face/eyes/${side}/region`, hint: 'draw the region on skin, 10-20 px outside the lashes; hair that hangs over the eye stays in front automatically' });
  }
  return {
    ...draft,
    shift: [shiftX, shiftY],
    rect: lidRect,
    colors: { skin: hexColor(localSkin), white: hexColor(colours.white), iris: hexColor(iris), lash: hexColor(lash) },
    occluded: round2(occluded / Math.max(1, regionArea)),
  };
}

// ----------------------------------------------------------------------------- stage 2: compile

function isEyeMeta(value: unknown): value is EyeMeta {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<EyeMeta>;
  const list = (a: unknown, n?: number): a is number[] => Array.isArray(a) && a.every((v) => typeof v === 'number' && Number.isFinite(v)) && (n === undefined || a.length === n);
  return (
    typeof e.id === 'string' &&
    list(e.center, 2) &&
    typeof e.angle === 'number' &&
    list(e.u) &&
    e.u.length >= 2 &&
    list(e.upper, e.u.length) &&
    list(e.lower, e.u.length) &&
    list(e.top, e.u.length) &&
    (e.bottom === undefined || list(e.bottom, e.u.length)) &&
    typeof e.grow === 'number' &&
    typeof e.lash === 'number' &&
    list(e.shift, 2) &&
    list(e.rect, 4) &&
    typeof e.colors === 'object' &&
    e.colors !== null
  );
}

function compileEye(ctx: CompileContext, side: ImageSide, eye: EyeMeta): void {
  const T = EYE_TUNING;
  const { model, root } = ctx;
  const id = eye.id;
  const ball = ctx.layer(`${id}_ball`);
  const upper = ctx.layer(`${id}_upper`);
  if (!ball || !upper) return;
  const lower = ctx.layer(`${id}_lower`);
  const crease = ctx.layer(`${id}_crease`);
  const front = ctx.layer(`${id}_front`);
  const open = model.parameter(EYE_OPEN[side]);
  const who = side === 'imageLeft' ? "the character's right eye (image left)" : "the character's left eye (image right)";

  // The underlay and mask of the eyeball: collapses exactly when the eye closes.
  const mesh = eyeMaskMesh(eye);
  const white = `${id}_white`;
  model.part({
    id: white,
    parent: root.id,
    z: AVATAR_Z.eyes,
    shape: { type: 'mesh', vertices: mesh.open, triangles: mesh.triangles },
    fill: /^#[0-9a-f]{6}$/i.test(eye.colors.white) ? eye.colors.white : '#ffffff',
    description: `Eye-white underlay and mask of ${who}: both rows move onto the meeting line of the lids as ${open} goes to 0.`,
  });
  model.bind({ id: `${id}Mask`, target: `part:${white}.shape.vertices`, params: [open], keys: [{ at: [0], value: mesh.closed }, { at: [1], value: mesh.open }] });
  ctx.folds.skip('part', white);

  // The eyeball: never squashed, clipped by the mask, shifted by the gaze.
  model.imagePart(ball, { parent: root.id, z: AVATAR_Z.eyes + 1, mask: [white], description: `Eyeball of ${who}, clipped by ${white}.` });
  const [sx, sy] = eye.shift;
  if (sx > 0 || sy > 0) {
    const gx = model.parameter('EyeBallX');
    const gy = model.parameter('EyeBallY');
    const frame = makeFrame(eye.center, eye.angle);
    const [x, y] = ball.rect;
    // EyeBallX > 0 looks toward the screen right (along the eye line), EyeBallY > 0 up (against v).
    const moves: Array<[string, string, number, number]> = [
      ['X', gx, sx * frame.along[0], sx * frame.along[1]],
      ['Y', gy, -sy * frame.down[0], -sy * frame.down[1]],
    ];
    for (const [axis, param, dx, dy] of moves) {
      if (Math.abs(dx) >= 0.005) {
        model.bind({ id: `${id}Gaze${axis}x`, target: `part:${ball.id}.shape.x`, params: [param], keys: [{ at: [-1], value: round2(x - dx) }, { at: [0], value: x }, { at: [1], value: round2(x + dx) }] });
      }
      if (Math.abs(dy) >= 0.005) {
        model.bind({ id: `${id}Gaze${axis}y`, target: `part:${ball.id}.shape.y`, params: [param], keys: [{ at: [-1], value: round2(y - dy) }, { at: [0], value: y }, { at: [1], value: round2(y + dy) }] });
      }
    }
  }

  const cell = eyeCell(eye, ctx.metrics.cell.detail);
  /** A lid warp over the lid layers' rect: `which` lid travels as the eye closes. */
  const lid = (which: 'upper' | 'lower', layer: LayerInfo, z: number, what: string, rim: LayerInfo | undefined): void => {
    const warp = model.warp({ id: `${id}${which === 'upper' ? 'Upper' : 'Lower'}Warp`, parent: root.id, rect: layer.rect, cell, description: `${what} of ${who}: closes as ${open} goes to 0.` });
    model.imagePart(layer, { parent: warp.id, z, description: `${what} of ${who}.` });
    if (rim && rim.rect.every((v, k) => v === layer.rect[k])) {
      // Eye white on the lid edge: moves with the lid and fades out before the lids meet.
      model.imagePart(rim, { parent: warp.id, z: z + 0.5, description: `Eye white on the ${which} lid edge of ${who}: fades out as the eye closes.` });
      model.bind({ id: `${rim.id}Fade`, target: `part:${rim.id}.opacity`, params: [open], keys: [{ at: [0], value: 0 }, { at: [T.rimVisible], value: 1 }, { at: [1], value: 1 }] });
      ctx.folds.collapsible('part', rim.id);
    }
    model.bindField(warp, { id: `${id}Blink${which === 'upper' ? 'Upper' : 'Lower'}`, params: [open], keys: [{ at: [0], field: eyeBlinkField(eye, which, cell) }, { at: [1] }], description: `${what} of ${who}: ${which === 'upper' ? 'the lash band travels down to the meeting line' : 'the lower lid line rises to the meeting line'}.` });
    // The lattice compresses across the opening when the eye closes: only flips are folds.
    ctx.folds.collapsible('warp', warp.id);
    ctx.folds.collapsible('part', layer.id);
  };
  const lowerRim = ctx.layer(`${id}_lowerRim`);
  const upperRim = ctx.layer(`${id}_upperRim`);
  if (lower) lid('lower', lower, AVATAR_Z.eyes + 2, 'Lower lid (lower lid line, lower lashes)', lowerRim);
  if (crease) {
    model.imagePart(crease, { parent: root.id, z: AVATAR_Z.eyes + 3, description: `Crease, lid shading and eye corners of ${who}: static, fades out as the eye closes.` });
    model.bind({ id: `${id}Crease`, target: `part:${crease.id}.opacity`, params: [open], keys: [{ at: [0], value: 0 }, { at: [T.creaseVisible], value: 1 }, { at: [1], value: 1 }] });
  }

  lid('upper', upper, AVATAR_Z.eyes + 4, 'Upper lid (lash line)', upperRim);

  if (front) model.imagePart(front, { parent: root.id, z: AVATAR_Z.eyes + 5, description: `Hair in front of ${who} (an opaque copy, its rim a matte): the lid closes behind it; the hair feature moves it with the hair.` });
}

// ----------------------------------------------------------------------------- the feature

export const eyes: AvatarFeature = {
  id: 'eyes',
  summary: 'blink (EyeLOpen / EyeROpen) and gaze (EyeBallX / EyeBallY): eye layers cut from the eye regions, the base filled with eyelid skin',

  layers(ctx) {
    const skin = faceSkinColor(ctx.source, ctx.spec);
    const meta: EyesMeta = { version: 1 };
    for (const side of SIDES) {
      const eye = buildEye(ctx, side, skin);
      if (eye) meta[side] = eye;
    }
    ctx.setMeta('eyes', meta);
  },

  compile(ctx) {
    const meta = ctx.featureMeta<EyesMeta>('eyes');
    if (!meta || typeof meta !== 'object') return;
    for (const side of SIDES) {
      const eye = meta[side];
      if (isEyeMeta(eye)) compileEye(ctx, side, eye);
    }
  },

  poses(): AvatarPose[] {
    return [
      { id: 'eyes_quarter', label: 'eyes 0.25', params: { EyeLOpen: 0.25, EyeROpen: 0.25 }, zoom: 'eyes' },
      { id: 'wink', label: 'wink (EyeLOpen 0)', params: { EyeLOpen: 0 }, zoom: 'eyes' },
      { id: 'gaze_right', label: 'gaze right (EyeBallX 1)', params: { EyeBallX: 1 }, zoom: 'eyes' },
      { id: 'gaze_left', label: 'gaze left (EyeBallX -1)', params: { EyeBallX: -1 }, zoom: 'eyes' },
      { id: 'gaze_up', label: 'gaze up (EyeBallY 1)', params: { EyeBallY: 1 }, zoom: 'eyes' },
      { id: 'gaze_down', label: 'gaze down (EyeBallY -1)', params: { EyeBallY: -1 }, zoom: 'eyes' },
    ];
  },
};
