/**
 * Shared maths of the avatar builder (pure, browser-safe, deterministic). Every feature module in
 * ./features/ builds its deformations from these pieces, so they all speak one language:
 *
 *   Lattice   the rest points of a warp: makeLattice (a rect + a target cell size), nestedLattice
 *             (a child warp inside its parent's rect), latticeFolds (a quick geometric fold test)
 *   Weight    (x, y) -> 0..1 in source pixels: bandWeight, domeWeight, softEllipseWeight,
 *             gaussianWeight, fanWeight, rectFadeWeight, multiplyWeights
 *   Field     (x, y) -> [dx, dy], where a REST point moves: rotationField, shiftField, sumFields,
 *             scaleField, weightField
 *   offsets   sampleField (a field at the lattice points), sparseOffsets / fieldOffsets (the sparse
 *             keyform value {"<point>": [dx, dy]} that lists only the points that move)
 *   metrics   avatarMetrics(spec): every amount and size with its default filled in
 *
 * Also re-exported here, so features import one module: the model builder (./builder.ts: unique
 * ids, standard parameters, explicit draw order) and the fold checker (./folds.ts).
 *
 * Conventions: source pixels, +y down, angles in degrees and clockwise-positive on screen. A field
 * is evaluated at REST positions (where a point is in the illustration); warp offsets add up, so
 * several bindings on one warp are simply the sum of their fields.
 */
import type { AvatarSpec } from './types.js';

export { ModelBuilder, AvatarBuildError, STANDARD_PARAMETERS, AVATAR_Z, type StandardParameterId, type WarpHandle, type FieldKey, type ModelMeta } from './builder.js';
export { findFolds, foldIssues, defaultFoldPoses, FOLD_CODE, type FoldFinding, type FoldPlan, type FoldOptions } from './folds.js';

export type Vec2 = [number, number];
/** [x, y, width, height] in source pixels. */
export type RectTuple = [x: number, y: number, width: number, height: number];

/** An axis-aligned ellipse (the head ellipse, the face oval, the chest). */
export interface Ellipse {
  center: readonly [number, number];
  radius: readonly [number, number];
}

const DEG = Math.PI / 180;

// ----------------------------------------------------------------------------- lattices

/** Most cells per side of a warp lattice (the limit of the model format). */
export const MAX_LATTICE_CELLS = 64;

/** The rest lattice of a warp: (cols + 1) x (rows + 1) points over `rect`, row-major. */
export interface Lattice {
  rect: RectTuple;
  cols: number;
  rows: number;
  /** Rest positions [x0, y0, x1, y1, ...]; point index = row * (cols + 1) + col. */
  points: Float64Array;
}

export interface LatticeLimits {
  /** Fewest cells per side (default 2). */
  min?: number;
  /** Most cells per side (default MAX_LATTICE_CELLS). */
  max?: number;
}

/** A lattice with exactly cols x rows cells. */
export function latticeOf(rect: RectTuple, cols: number, rows: number): Lattice {
  if (!(rect[2] > 0 && rect[3] > 0)) throw new RangeError(`latticeOf: the rect needs a positive size, got ${rect[2]}x${rect[3]}`);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new RangeError(`latticeOf: cols / rows must be whole numbers >= 1, got ${cols}x${rows}`);
  const points = new Float64Array((cols + 1) * (rows + 1) * 2);
  let k = 0;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      points[k++] = rect[0] + (rect[2] * c) / cols;
      points[k++] = rect[1] + (rect[3] * r) / rows;
    }
  }
  return { rect: [rect[0], rect[1], rect[2], rect[3]], cols, rows, points };
}

/** A lattice over `rect` whose cells are about `cell` px (never more than `max` cells per side). */
export function makeLattice(rect: RectTuple, cell: number, limits: LatticeLimits = {}): Lattice {
  if (!(cell > 0)) throw new RangeError(`makeLattice: the cell size must be > 0, got ${cell}`);
  const min = Math.max(1, Math.floor(limits.min ?? 2));
  const max = Math.max(min, Math.min(MAX_LATTICE_CELLS, Math.floor(limits.max ?? MAX_LATTICE_CELLS)));
  const count = (size: number) => Math.min(max, Math.max(min, Math.round(size / cell)));
  return latticeOf(rect, count(rect[2]), count(rect[3]));
}

/**
 * The lattice of a nested warp: `rect` grown by `margin` px, clipped to `bounds` (the parent warp's
 * rect: a child that sticks out is extrapolated and drifts) and snapped outward to whole pixels,
 * with cells of about `cell` px. Returns null when nothing of the rect lies inside the bounds.
 */
export function nestedLattice(rect: RectTuple, bounds: RectTuple, cell: number, margin = 0, limits: LatticeLimits = {}): Lattice | null {
  const x0 = Math.max(bounds[0], Math.floor(rect[0] - margin));
  const y0 = Math.max(bounds[1], Math.floor(rect[1] - margin));
  const x1 = Math.min(bounds[0] + bounds[2], Math.ceil(rect[0] + rect[2] + margin));
  const y1 = Math.min(bounds[1] + bounds[3], Math.ceil(rect[1] + rect[3] + margin));
  if (!(x1 > x0 && y1 > y0)) return null;
  return makeLattice([x0, y0, x1 - x0, y1 - y0], cell, limits);
}

/** Number of control points. */
export function latticePointCount(lattice: Lattice): number {
  return (lattice.cols + 1) * (lattice.rows + 1);
}

/** Width and height of one cell in px. */
export function latticeCell(lattice: Lattice): Vec2 {
  return [lattice.rect[2] / lattice.cols, lattice.rect[3] / lattice.rows];
}

/** True for the points on the outer edge of the lattice. */
export function isEdgePoint(lattice: Lattice, index: number): boolean {
  const col = index % (lattice.cols + 1);
  const row = (index - col) / (lattice.cols + 1);
  return col === 0 || row === 0 || col === lattice.cols || row === lattice.rows;
}

export interface LatticeFold {
  /** Cell column / row and the rest position of its centre. */
  col: number;
  row: number;
  at: Vec2;
  /** Smallest corner area of the deformed cell relative to rest: <= 0 = flipped, near 0 = collapsed. */
  ratio: number;
}

/**
 * Corner areas of every deformed cell relative to rest (a bilinear cell is free of folds exactly
 * when the triangle at each of its four corners keeps its orientation). Returns the cells whose
 * smallest ratio is below `minRatio`, worst first. `offsets` is dense: 2 numbers per point.
 */
export function latticeFolds(lattice: Lattice, offsets: ArrayLike<number>, minRatio = 0.1): LatticeFold[] {
  const { cols, rows, points } = lattice;
  const [cw, ch] = latticeCell(lattice);
  const rest = cw * ch;
  const px = (i: number) => points[i * 2] + offsets[i * 2];
  const py = (i: number) => points[i * 2 + 1] + offsets[i * 2 + 1];
  const cross = (o: number, a: number, b: number) => (px(a) - px(o)) * (py(b) - py(o)) - (py(a) - py(o)) * (px(b) - px(o));
  const out: LatticeFold[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i00 = r * (cols + 1) + c;
      const i10 = i00 + 1;
      const i01 = i00 + cols + 1;
      const i11 = i01 + 1;
      // Rest orientation of each corner triangle is (corner, next along +x, next along +y) -> +rest.
      const ratio = Math.min(cross(i00, i10, i01), cross(i10, i11, i00), cross(i11, i01, i10), cross(i01, i00, i11)) / rest;
      if (ratio < minRatio) out.push({ col: c, row: r, at: [lattice.rect[0] + (c + 0.5) * cw, lattice.rect[1] + (r + 0.5) * ch], ratio });
    }
  }
  return out.sort((a, b) => a.ratio - b.ratio);
}

// ----------------------------------------------------------------------------- weights

/** A smooth influence 0..1 at a source-pixel position. */
export type Weight = (x: number, y: number) => number;

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Hermite smoothstep of t clamped to 0..1: zero slope at both ends. */
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Smoothstep from 0 at `from` to 1 at `to` (works for from > to: a falling ramp). */
export function ramp(from: number, to: number, v: number): number {
  if (from === to) return v < from ? 0 : 1;
  return smoothstep((v - from) / (to - from));
}

/**
 * A row band [yStart, yEnd]: 1 above yStart, a smoothstep down to 0 at yEnd (the "neck band" and the
 * "body fade" of the spec). The validator's chin check assumes exactly this falloff.
 */
export function bandWeight(band: readonly [number, number]): Weight {
  const [y0, y1] = band;
  return (_x, y) => 1 - ramp(y0, y1, y);
}

/** Normalised radial position in an ellipse: 0 at the centre, 1 on the outline, > 1 outside. */
export function ellipseLevel(e: Ellipse, x: number, y: number): number {
  const u = (x - e.center[0]) / e.radius[0];
  const v = (y - e.center[1]) / e.radius[1];
  return Math.sqrt(u * u + v * v);
}

/**
 * A dome over an ellipse: (1 - r^2)^exponent with r the normalised radius, exactly 0 on and outside
 * the outline. For exponent > 1 the slope is zero at the rim (no crease where the motion ends);
 * smaller exponents give a flatter top and a steeper flank. In the terms of DESIGN.md the depth of a
 * unit sphere is z = sqrt(1 - r^2) and this is z^(2 * exponent).
 */
export function domeWeight(e: Ellipse, exponent = 2): Weight {
  return (x, y) => {
    const u = (x - e.center[0]) / e.radius[0];
    const v = (y - e.center[1]) / e.radius[1];
    const d = 1 - u * u - v * v;
    return d <= 0 ? 0 : Math.pow(d, exponent);
  };
}

/** 1 inside the ellipse scaled by `inner`, a smooth fall to exactly 0 at the ellipse scaled by `outer`. */
export function softEllipseWeight(e: Ellipse, inner = 1, outer = 1.25): Weight {
  return (x, y) => 1 - ramp(inner, outer, ellipseLevel(e, x, y));
}

/** exp(-d^2 / (2 sigma^2)). */
export function gaussian(distance: number, sigma: number): number {
  const t = distance / sigma;
  return Math.exp(-0.5 * t * t);
}

/**
 * A Gaussian bump around a point: 1 at the centre; `sigma` px (or [sx, sy]). Cut to exactly 0 beyond
 * `cutoff` sigmas (default 3) with a smooth last sigma, so sparse keyforms stay sparse.
 */
export function gaussianWeight(center: readonly [number, number], sigma: number | readonly [number, number], cutoff = 3): Weight {
  const sx = typeof sigma === 'number' ? sigma : sigma[0];
  const sy = typeof sigma === 'number' ? sigma : sigma[1];
  return (x, y) => {
    const u = (x - center[0]) / sx;
    const v = (y - center[1]) / sy;
    const d = Math.sqrt(u * u + v * v);
    if (d >= cutoff) return 0;
    return Math.exp(-0.5 * d * d) * (1 - ramp(cutoff - 1, cutoff, d));
  };
}

/**
 * A fan around a pivot, by DIRECTION only: 1 for points within `full` degrees of straight up, a
 * smooth fall to 0 at `zero` degrees (90 = level with the pivot, 180 = straight below).
 *
 * Why directions: a rotation about the pivot moves a point by angle x distance, so a weight that
 * fades over a fixed number of pixels squashes (and finally folds) everything far from the pivot. A
 * weight that depends only on the direction turns the fade into a pure angular redistribution: the
 * strain is angle x d(weight)/d(direction) at any distance, the way a joint bends.
 */
export function fanWeight(pivot: readonly [number, number], full: number, zero: number): Weight {
  return (x, y) => {
    const dx = x - pivot[0];
    const dy = y - pivot[1];
    if (dx === 0 && dy === 0) return 0;
    const fromUp = Math.atan2(Math.abs(dx), -dy) / DEG;
    return 1 - ramp(full, zero, fromUp);
  };
}

/**
 * 0 on the edge of `rect` (and outside), a smooth rise to 1 at `margin` px inside. Multiply the
 * field of a nested warp by it: a layer drawn over the base must not move at its rect edge
 * (DESIGN.md §3, the interior-patch rule).
 */
export function rectFadeWeight(rect: RectTuple, margin: number): Weight {
  const [x0, y0, w, h] = rect;
  return (x, y) => {
    const d = Math.min(x - x0, y - y0, x0 + w - x, y0 + h - y);
    return d <= 0 ? 0 : margin > 0 ? smoothstep(d / margin) : 1;
  };
}

/** The product of several weights. */
export function multiplyWeights(...weights: Weight[]): Weight {
  return (x, y) => {
    let w = 1;
    for (const f of weights) {
      w *= f(x, y);
      if (w === 0) return 0;
    }
    return w;
  };
}

// ----------------------------------------------------------------------------- fields

/** A displacement field: the offset [dx, dy] of the rest point (x, y). */
export type Field = (x: number, y: number) => Vec2;

/**
 * Rotation about `pivot` by `degrees` (clockwise on screen). With a weight the ANGLE is blended
 * (the point at weight w turns by w x degrees): partly weighted points keep their distance to the
 * pivot, so a neck bends instead of shrinking.
 */
export function rotationField(pivot: readonly [number, number], degrees: number, weight?: Weight): Field {
  return (x, y) => {
    const w = weight ? weight(x, y) : 1;
    if (w === 0 || degrees === 0) return [0, 0];
    const a = degrees * w * DEG;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const qx = x - pivot[0];
    const qy = y - pivot[1];
    return [qx * cos - qy * sin - qx, qx * sin + qy * cos - qy];
  };
}

/** A constant shift scaled by a weight. */
export function shiftField(dx: number, dy: number, weight: Weight): Field {
  return (x, y) => {
    const w = weight(x, y);
    return [dx * w, dy * w];
  };
}

export function sumFields(...fields: Field[]): Field {
  return (x, y) => {
    let dx = 0;
    let dy = 0;
    for (const f of fields) {
      const d = f(x, y);
      dx += d[0];
      dy += d[1];
    }
    return [dx, dy];
  };
}

export function scaleField(field: Field, k: number): Field {
  return (x, y) => {
    const d = field(x, y);
    return [d[0] * k, d[1] * k];
  };
}

/** A field multiplied by a weight. */
export function weightField(field: Field, weight: Weight): Field {
  return (x, y) => {
    const w = weight(x, y);
    if (w === 0) return [0, 0];
    const d = field(x, y);
    return [d[0] * w, d[1] * w];
  };
}

// ----------------------------------------------------------------------------- offsets (keyform values)

/** A sparse warp keyform: {"<point index>": [dx, dy]} for the points that move; the others stay. */
export type SparseOffsets = Record<string, Vec2>;

export interface SampleOptions {
  /** Force the offsets of the points on the lattice edge to exactly 0 (nested warps over the base). */
  pinEdges?: boolean;
}

/** Decimals kept in keyform offsets: 0.01 px is far below anything visible and keeps the JSON short. */
export const OFFSET_PRECISION = 2;

/** The field at every lattice point: dense offsets, 2 numbers per point. */
export function sampleField(lattice: Lattice, field: Field, options: SampleOptions = {}): Float64Array {
  const n = latticePointCount(lattice);
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    if (options.pinEdges && isEdgePoint(lattice, i)) continue;
    const d = field(lattice.points[i * 2], lattice.points[i * 2 + 1]);
    out[i * 2] = Number.isFinite(d[0]) ? d[0] : 0;
    out[i * 2 + 1] = Number.isFinite(d[1]) ? d[1] : 0;
  }
  return out;
}

function roundTo(v: number, precision: number): number {
  const k = 10 ** precision;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
}

/** Dense offsets -> the sparse keyform value: rounded, listing only the points that move. */
export function sparseOffsets(offsets: ArrayLike<number>, precision = OFFSET_PRECISION): SparseOffsets {
  const out: SparseOffsets = {};
  for (let i = 0; i * 2 + 1 < offsets.length; i++) {
    const dx = roundTo(offsets[i * 2], precision);
    const dy = roundTo(offsets[i * 2 + 1], precision);
    if (dx !== 0 || dy !== 0) out[String(i)] = [dx, dy];
  }
  return out;
}

/** A field as the sparse keyform value of a warp with this lattice. */
export function fieldOffsets(lattice: Lattice, field: Field, options: SampleOptions = {}): SparseOffsets {
  return sparseOffsets(sampleField(lattice, field, options));
}

/** Sparse -> dense offsets (for latticeFolds and tests). */
export function denseOffsets(lattice: Lattice, sparse: SparseOffsets): Float64Array {
  const out = new Float64Array(latticePointCount(lattice) * 2);
  for (const [key, d] of Object.entries(sparse)) {
    const i = Number(key);
    out[i * 2] = d[0];
    out[i * 2 + 1] = d[1];
  }
  return out;
}

/** Where a rest point lands under a field. */
export function applyField(field: Field, x: number, y: number): Vec2 {
  const d = field(x, y);
  return [x + d[0], y + d[1]];
}

// ----------------------------------------------------------------------------- metrics (defaults resolved)

/** Every amount and size of a spec with its default filled in (see the descriptions in schema.ts). */
export interface AvatarMetrics {
  width: number;
  height: number;
  /** The longer image side. */
  long: number;
  /** Lattice cell sizes in px: the whole-image warp, hair-sized warps, eye / mouth warps. */
  cell: { body: number; head: number; detail: number };
  /** True when build.cell.body was raised to keep the whole-image lattice within MAX_LATTICE_CELLS. */
  cellClamped: boolean;
  /** Soft edge of cut layers, px. */
  feather: number;
  /** Px the face centre moves at AngleX / AngleY = 30. */
  turn: { x: number; y: number };
  /** Head roll in degrees at AngleZ = 30. */
  tilt: number;
  /** Body rotation in degrees at BodyAngleX = 10. */
  sway: number;
  /** Px the chest rises at Breath = 1. */
  breath: number;
  head: Ellipse;
  face: Ellipse;
}

export const DEFAULT_TURN_X = 0.035;
export const DEFAULT_TURN_Y = 0.025;
export const DEFAULT_TILT = 8.5;
export const DEFAULT_BREATH = 0.0035;
/** Whole-image lattice cell as a share of the long side (about 50 cells). */
export const DEFAULT_BODY_CELL = 0.02;
export const DEFAULT_FEATHER = 1.5;

export function avatarMetrics(spec: AvatarSpec): AvatarMetrics {
  const { width, height } = spec.image;
  const long = Math.max(width, height);
  const smallest = long / MAX_LATTICE_CELLS;
  const wanted = spec.build?.cell?.body ?? long * DEFAULT_BODY_CELL;
  const body = Math.max(wanted, smallest);
  return {
    width,
    height,
    long,
    cell: {
      body,
      head: spec.build?.cell?.head ?? Math.max(4, body * 0.6),
      detail: spec.build?.cell?.detail ?? Math.max(2, long * 0.006),
    },
    cellClamped: wanted < smallest - 1e-9,
    feather: spec.build?.feather ?? DEFAULT_FEATHER,
    turn: { x: spec.head.turn?.x ?? width * DEFAULT_TURN_X, y: spec.head.turn?.y ?? height * DEFAULT_TURN_Y },
    tilt: spec.head.tilt ?? DEFAULT_TILT,
    sway: spec.body.sway,
    breath: spec.body.breath ?? height * DEFAULT_BREATH,
    head: { center: spec.head.center, radius: spec.head.radius },
    face: { center: spec.face.center, radius: spec.face.radius },
  };
}
