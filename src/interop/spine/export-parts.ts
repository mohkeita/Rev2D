/**
 * Per-part analysis for the Spine exporter: the shape/paint states a part takes over every exported
 * frame, the reference state its texture is drawn from (the largest one, so a mouth that opens is not
 * rasterized closed), its Spine mesh and region, clipping polygons of mask parts, and the vertex plans
 * that turn poses into Spine setup vertices and deform offsets.
 *
 * Spine setup pose = the rig's default pose (parameters at their defaults, no animation, physics at
 * rest, IK solved). Canvas (X, Y) is Spine (X, −Y); bone-local vectors flip y the same way (F).
 */
import { invert } from '../../core/math.js';
import type { CompiledPart, CompiledRig } from '../../core/rig/compiled.js';
import { pointSkinWeights } from '../../core/rig/parts.js';
import type { ImageRGBA, Mat2D, Part, Pose, Shape } from '../../core/types.js';
import { partBone, partDeformer, type ClipSample, type Deformer } from './bake.js';
import { warpBone, warpWeights, type BoneTable } from './export-bones.js';
import { alphaContour, polygonArea, simplifyTo } from './export-mask.js';
import { buildCoverMesh, partGeometry, rasterizePart, regionBox, regionUvs, texelDensity, type CoverMesh, type PartGeometry, type RegionBox } from './export-mesh.js';
import { planMorph, shapeArea, type MorphPlan } from './export-morph.js';

// ----------------------------------------------------------------------------- states

export interface PartState {
  /** Identity of the geometry-relevant values (shape fields, paint, stroke width). */
  key: string;
  /** Identity of the shape fields only. */
  shapeKey: string;
  shape: Shape;
  part: Part;
}

interface GeometrySlotRef {
  key: string;
  field: string;
}

/** Tracks the distinct geometry states of one part. */
export class PartStates {
  readonly slots: GeometrySlotRef[];
  readonly byKey = new Map<string, PartState>();
  private readonly setupState: PartState;

  constructor(
    readonly c: CompiledRig,
    readonly cp: CompiledPart,
  ) {
    this.slots = cp.geometrySlots.map((s) => ({ key: c.slots[s].key, field: (c.slots[s].target as { field: string }).field }));
    this.setupState = { key: '', shapeKey: '', shape: cp.source.shape, part: cp.source };
  }

  get dynamic(): boolean {
    return this.slots.length > 0;
  }

  /** The state of the part in a pose (values of its bound / animated geometry fields). */
  of(pose: Pose): PartState {
    if (!this.slots.length) return this.setupState;
    const values = this.slots.map((s) => pose.properties[s.key]);
    const key = JSON.stringify(values);
    let st = this.byKey.get(key);
    if (st) return st;
    const src = this.cp.source;
    const shape: Record<string, unknown> = { ...src.shape };
    let fill = src.fill;
    const stroke = src.stroke ? { ...src.stroke } : undefined;
    const shapeValues: unknown[] = [];
    this.slots.forEach((s, i) => {
      const v = values[i];
      if (s.field.startsWith('shape.')) shapeValues.push(v);
      if (v === undefined) return;
      if (s.field === 'fill') fill = v as string;
      else if (s.field === 'stroke.color') stroke!.color = v as string;
      else if (s.field === 'stroke.width') stroke!.width = v as number;
      else shape[s.field.slice('shape.'.length)] = v;
    });
    st = { key, shapeKey: JSON.stringify(shapeValues), shape: shape as Shape, part: { ...src, shape: shape as Shape, fill, stroke } };
    this.byKey.set(key, st);
    return st;
  }

  /** What changes between states: shape fields, paint (fill / stroke color), stroke width. */
  changes(): { shape: boolean; paint: boolean; strokeWidth: boolean } {
    const out = { shape: false, paint: false, strokeWidth: false };
    const states = [...this.byKey.values()];
    if (states.length < 2) return out;
    const firstValues = JSON.parse(states[0].key) as unknown[];
    for (const st of states.slice(1)) {
      const vals = JSON.parse(st.key) as unknown[];
      this.slots.forEach((s, i) => {
        if (JSON.stringify(vals[i]) === JSON.stringify(firstValues[i])) return;
        if (s.field === 'fill' || s.field === 'stroke.color') out.paint = true;
        else if (s.field === 'stroke.width') out.strokeWidth = true;
        else out.shape = true;
      });
    }
    return out;
  }
}

/** The reference state: the one with the largest filled area (ties: the setup pose's state). */
export function referenceState(states: PartStates, setup: PartState): PartState {
  if (!states.dynamic) return setup;
  let best = setup;
  let bestArea = shapeArea(setup.shape, states.c.textures);
  for (const st of states.byKey.values()) {
    if (st.shapeKey === setup.shapeKey) continue;
    const a = shapeArea(st.shape, states.c.textures);
    if (a > bestArea * (1 + 1e-6) + 1e-9) {
      best = st;
      bestArea = a;
    }
  }
  return best;
}

/** Frames of every clip, for state collection. Returns the setup pose's state. */
export function collectStates(states: PartStates, setupPose: Pose, clips: readonly ClipSample[]): PartState {
  const setup = states.of(setupPose);
  for (const clip of clips) for (const pose of clip.poses) states.of(pose);
  return setup;
}

// ----------------------------------------------------------------------------- bindings

/** How a part's points attach to Spine bones. */
export interface VertexBinding {
  /** Spine index of the slot bone (unweighted points are local to it). */
  slotBone: number;
  /** Per point: [Spine bone index, weight] pairs summing to 1; null = unweighted. */
  influences: Array<Array<[number, number]>> | null;
  /** Poses never move the points relative to their bones (no deform timeline needed). */
  rigid: boolean;
}

/**
 * Binding of reference points of part `index`: skinned parts are weighted over their skin bones, parts
 * in a warp over the warp's lattice bones (bilinear weights, exact), others follow their bone (or the
 * root). `unweighted` forces a plain polygon on the part's bone (clipping polygons; the rest is baked
 * into deform timelines). Lattice bones must exist in `bones` (see latticePoints).
 */
export function bindPart(c: CompiledRig, bones: BoneTable, index: number, points: ArrayLike<number>, morphing: boolean, unweighted = false): VertexBinding {
  const cp = c.parts[index];
  const n = points.length >> 1;
  const slotBone = bones.ofRev(partBone(c, index));
  if (unweighted) return { slotBone, influences: null, rigid: !morphing && !cp.skin && cp.parent.kind !== 'warp' };
  if (cp.skin) {
    const skin = cp.skin;
    const influences: Array<Array<[number, number]>> = [];
    for (let v = 0; v < n; v++) {
      const w = pointSkinWeights(skin, cp.source.shape, c.bones, points[2 * v], points[2 * v + 1]);
      let sum = 0;
      for (let k = 0; k < w.length; k++) if (w[k] > 1e-6) sum += w[k];
      const row: Array<[number, number]> = [];
      for (let k = 0; k < w.length; k++) if (w[k] > 1e-6 && sum > 0) row.push([bones.ofRev(skin.bones[k]), w[k] / sum]);
      // No weight at all: the rig leaves such a vertex in place; follow the first skin bone.
      influences.push(row.length ? row : [[bones.ofRev(skin.bones[0]), 1]]);
    }
    return { slotBone, influences, rigid: false };
  }
  if (cp.parent.kind === 'warp') {
    const warp = cp.parent.index;
    const influences: Array<Array<[number, number]>> = [];
    for (let v = 0; v < n; v++) influences.push(warpWeights(c, warp, points[2 * v], points[2 * v + 1]).map(([p, w]): [number, number] => [bones.lattice(warp, p), w]));
    return { slotBone: bones.ofRev(warpBone(c, warp)), influences, rigid: !morphing };
  }
  return { slotBone, influences: null, rigid: !morphing };
}

/** Lattice points (warp, point) used by reference points of a warp part. */
export function latticePoints(c: CompiledRig, index: number, points: ArrayLike<number>): Array<[number, number]> {
  const cp = c.parts[index];
  if (cp.skin || cp.parent.kind !== 'warp') return [];
  const warp = cp.parent.index;
  const out: Array<[number, number]> = [];
  for (let v = 0; v + 1 < points.length; v += 2) for (const [p] of warpWeights(c, warp, points[v], points[v + 1])) out.push([warp, p]);
  return out;
}

// ----------------------------------------------------------------------------- vertex plans

function applyInv(inv: Mat2D, x: number, y: number): [number, number] {
  return [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]];
}

export interface WeightedPlan {
  /** Influences per vertex. */
  counts: number[];
  /** Spine bone index per influence (flattened over vertices). */
  bones: number[];
  weights: number[];
  /** Rev2D-local (y down) setup position per influence (2 per influence). */
  local: Float64Array;
}

/**
 * How a set of reference points (mesh vertices or a clipping polygon) of one part becomes Spine
 * vertices: setup local coordinates relative to the slot bone (or per influence) and, per pose, the
 * canvas positions the rig gives them and the Spine deform offsets that close the gap.
 */
export class VertexPlan {
  readonly slotBone: number;
  readonly weighted: WeightedPlan | null;
  /** Unweighted: Rev2D-local setup positions relative to the slot bone. */
  readonly local: Float64Array;
  readonly rigid: boolean;
  private readonly deformer: Deformer;
  private readonly morphCache = new Map<string, Float64Array>();

  constructor(
    readonly c: CompiledRig,
    readonly bones: BoneTable,
    readonly partIndex: number,
    /** Reference setup-space points. */
    readonly ref: Float64Array,
    readonly states: PartStates,
    readonly morph: MorphPlan | null,
    binding: VertexBinding,
    setupPose: Pose,
  ) {
    this.deformer = partDeformer(c, partIndex, ref);
    this.slotBone = binding.slotBone;
    this.rigid = binding.rigid;
    const p0 = this.positions(setupPose);
    const n = ref.length >> 1;
    if (binding.influences) {
      const counts: number[] = [];
      const bs: number[] = [];
      const weights: number[] = [];
      const local: number[] = [];
      const invs = new Map<number, Mat2D>();
      const inv = (b: number) => {
        let m = invs.get(b);
        if (!m) {
          m = invert(bones.bones[b].world(setupPose));
          invs.set(b, m);
        }
        return m;
      };
      for (let v = 0; v < n; v++) {
        const row = binding.influences[v];
        counts.push(row.length);
        for (const [b, w] of row) {
          bs.push(b);
          weights.push(w);
          local.push(...applyInv(inv(b), p0[2 * v], p0[2 * v + 1]));
        }
      }
      this.weighted = { counts, bones: bs, weights, local: Float64Array.from(local) };
      this.local = new Float64Array(0);
    } else {
      this.weighted = null;
      const m = invert(bones.bones[this.slotBone].world(setupPose));
      this.local = new Float64Array(n * 2);
      for (let v = 0; v < n; v++) {
        const [lx, ly] = applyInv(m, p0[2 * v], p0[2 * v + 1]);
        this.local[2 * v] = lx;
        this.local[2 * v + 1] = ly;
      }
    }
  }

  /** Number of deform values (2 per vertex, or 2 per influence when weighted). */
  get deformLength(): number {
    return this.weighted ? this.weighted.bones.length * 2 : this.local.length;
  }

  /** Canvas positions of the points in a pose (shape morph, then the part's deformation). */
  positions(pose: Pose): Float64Array {
    let src: Float64Array = this.ref;
    if (this.morph) {
      const st = this.states.of(pose);
      let m = this.morphCache.get(st.shapeKey);
      if (!m) {
        m = new Float64Array(this.ref.length);
        this.morph.map(st.shape, m);
        this.morphCache.set(st.shapeKey, m);
      }
      src = m;
    }
    const out = new Float64Array(this.ref.length);
    this.deformer(pose, src, out);
    return out;
  }

  /** Spine deform offsets for a pose (Spine units, y up), written into `out` at `offset`. */
  deform(pose: Pose, out: Float32Array, offset: number): void {
    const P = this.positions(pose);
    const bones = this.bones.bones;
    if (!this.weighted) {
      const inv = invert(bones[this.slotBone].world(pose));
      for (let v = 0; v < P.length >> 1; v++) {
        const [lx, ly] = applyInv(inv, P[2 * v], P[2 * v + 1]);
        out[offset + 2 * v] = lx - this.local[2 * v];
        out[offset + 2 * v + 1] = -(ly - this.local[2 * v + 1]);
      }
      return;
    }
    const wp = this.weighted;
    const worlds = new Map<number, Mat2D>();
    const world = (b: number) => {
      let m = worlds.get(b);
      if (!m) {
        m = bones[b].world(pose);
        worlds.set(b, m);
      }
      return m;
    };
    let k = 0;
    for (let v = 0; v < wp.counts.length; v++) {
      let sx = 0;
      let sy = 0;
      for (let j = 0; j < wp.counts[v]; j++) {
        const m = world(wp.bones[k + j]);
        const lx = wp.local[2 * (k + j)];
        const ly = wp.local[2 * (k + j) + 1];
        sx += wp.weights[k + j] * (m[0] * lx + m[2] * ly + m[4]);
        sy += wp.weights[k + j] * (m[1] * lx + m[3] * ly + m[5]);
      }
      const rx = P[2 * v] - sx;
      const ry = P[2 * v + 1] - sy;
      for (let j = 0; j < wp.counts[v]; j++) {
        const m = world(wp.bones[k + j]);
        const det = m[0] * m[3] - m[1] * m[2];
        let dx = 0;
        let dy = 0;
        if (Math.abs(det) > 1e-12) {
          dx = (m[3] * rx - m[2] * ry) / det;
          dy = (-m[1] * rx + m[0] * ry) / det;
        }
        out[offset + 2 * (k + j)] = dx;
        out[offset + 2 * (k + j) + 1] = -dy;
      }
      k += wp.counts[v];
    }
  }
}

// ----------------------------------------------------------------------------- attachments

export interface PartMesh {
  index: number;
  id: string;
  mesh: CoverMesh;
  box: RegionBox;
  uvs: number[];
  image: ImageRGBA;
  ref: PartState;
  morph: MorphPlan | null;
  /** The region had to shrink to fit a page. */
  downscaled: boolean;
}

export interface MeshOptions {
  textureScale: number;
  /** Largest region side in px (the page minus padding). */
  maxRegion: number;
}

/** Mesh, region image and morph plan of an exported part; null when it draws nothing in its reference state. */
export function planPartMesh(c: CompiledRig, index: number, states: PartStates, ref: PartState, textures: Record<string, ImageRGBA>, opts: MeshOptions): PartMesh | null {
  const cp = c.parts[index];
  const pg: PartGeometry = partGeometry(ref.part, c.textures);
  let scale = opts.textureScale * Math.min(4, Math.max(1, texelDensity(pg, c.textures)));
  // Margin around visible edges for the anti-aliased texels: two texels, at least half a pixel.
  const marginFor = (s: number) => Math.max(0.5, 2 / s);
  let mesh = buildCoverMesh(pg, marginFor(scale));
  if (!mesh) return null;
  let box = regionBox(mesh.positions, scale);
  let downscaled = false;
  for (let guard = 0; guard < 20 && (box.width > opts.maxRegion || box.height > opts.maxRegion); guard++) {
    scale *= (opts.maxRegion / Math.max(box.width, box.height)) * 0.98;
    mesh = buildCoverMesh(pg, marginFor(scale))!;
    box = regionBox(mesh.positions, scale);
    downscaled = true;
  }
  const refPts = Float64Array.from(mesh.positions);
  const morph = states.dynamic && states.changes().shape ? planMorph(ref.shape, [...states.byKey.values()].map((s) => s.shape), refPts, c.textures) : null;
  const image = rasterizePart(cp.id, pg, box, textures);
  return { index, id: cp.id, mesh, box, uvs: regionUvs(mesh.positions, box), image, ref, morph, downscaled };
}

// ----------------------------------------------------------------------------- clipping

export interface ClipPolygon {
  maskIndex: number;
  /** Reference setup-space polygon. */
  points: Float64Array;
  morph: MorphPlan | null;
  /** Covered area of the polygon's region and of all other (dropped) regions, px². */
  area: number;
  otherArea: number;
}

/** Scale at which mask parts are rendered to trace their outline. */
const MASK_TRACE_SCALE = 4;
/** Contour simplification tolerance in setup px, and the vertex budget of a clipping polygon. */
const MASK_TOLERANCE = 0.2;
const MASK_MAX_POINTS = 128;

/**
 * Clipping polygon of a mask part: the 50% alpha contour of its reference state (fill and stroke,
 * paint and texture alpha), simplified. Null when the part covers nothing.
 */
export function planClipPolygon(c: CompiledRig, maskIndex: number, states: PartStates, ref: PartState, textures: Record<string, ImageRGBA>): ClipPolygon | null {
  const cp = c.parts[maskIndex];
  const pg = partGeometry(ref.part, c.textures);
  const mesh = buildCoverMesh(pg, 1);
  if (!mesh) return null;
  let scale = MASK_TRACE_SCALE;
  let box = regionBox(mesh.positions, scale);
  while ((box.width > 4096 || box.height > 4096) && scale > 0.25) {
    scale /= 2;
    box = regionBox(mesh.positions, scale);
  }
  const img = rasterizePart(cp.id, pg, box, textures, 2);
  const contour = alphaContour(img, 0.5);
  if (!contour.polygon) return null;
  const simplified = simplifyTo(contour.polygon, MASK_TOLERANCE * scale, MASK_MAX_POINTS);
  const pts = new Float64Array(simplified.length);
  for (let i = 0; i + 1 < simplified.length; i += 2) {
    pts[i] = box.x + simplified[i] / scale;
    pts[i + 1] = box.y + simplified[i + 1] / scale;
  }
  if (Math.abs(polygonArea(pts)) < 1e-6) return null;
  const morph = states.dynamic && states.changes().shape ? planMorph(ref.shape, [...states.byKey.values()].map((s) => s.shape), pts, c.textures) : null;
  return { maskIndex, points: pts, morph, area: contour.area / (scale * scale), otherArea: contour.otherArea / (scale * scale) };
}
