/**
 * Statistics over one or more evaluated poses (a render, the cells of a sheet, the frames of a GIF or
 * an analysis) and the notes derived from them: IK chains out of reach or close to snapping straight,
 * physics outputs clamped to their parameter range, parts outside the view box or the canvas.
 *
 * View-box notes: "the visible parts lie entirely outside the view box" (nothing in view) is always
 * noted; the list of single parts entirely outside it only for the canvas view box (the default).
 * An explicit crop leaves parts out on purpose, and a 'fit' view box contains every visible part.
 */
import type { Model, Pose } from '../core/types.js';
import { fmtNum, listIds, shareText } from './errors.js';
import { RectAccumulator, type ViewBox } from './frame.js';

/** Extension (distance / max reach) above which a two-bone chain is close to snapping straight. */
export const SNAP_EXTENSION = 0.98;

export interface IkStats {
  id: string;
  bones: string[];
  frames: number;
  maxExtension: number;
  /** Time of the frame with the largest extension. */
  maxExtensionAt: number;
  /** Frames in which the target is beyond the chain's maximum reach (extension > 1). */
  outOfReach: number;
  /** Frames with extension > 0.98 (straight or nearly straight: visible knee/elbow snapping). */
  nearStraight: number;
  maxError: number;
  maxStretch: number;
}

export interface PhysicsOutputStats {
  group: string;
  param: string;
  /** Parameter range. */
  range: [number, number];
  rawMin: number;
  rawMax: number;
  /** Raw output with the largest magnitude (sign kept). */
  peak: number;
  peakAt: number;
  frames: number;
  /** Frames whose raw output was outside the range (and therefore clamped). */
  clamped: number;
  /** Frames in which an explicit parameter value replaced the output. */
  overridden: number;
}

export interface ParamStats {
  id: string;
  min: number;
  max: number;
  range: [number, number];
}

export interface PartFrameStats {
  id: string;
  /** Frames in which the part is visible (in the draw order). */
  visible: number;
  /** Frames in which it is visible but entirely outside the view box. */
  outsideView: number;
  /** Frames in which it is partly outside the view box (cut off). */
  clippedView: number;
  /** Frames in which it extends beyond the canvas [0, 0, width, height] (masked parts: the part of it inside its masks). */
  outsideCanvas: number;
  /** Largest distance in px its bounds reach beyond a canvas edge. */
  maxOverflow: number;
  /** Smallest such distance over the frames it is visible in (0 when it is inside in some frame). */
  minOverflow: number;
  maxOverflowAt: number;
}

type Rect = readonly [number, number, number, number];

function intersects(a: Rect, b: Rect): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

function contains(outer: Rect, inner: Rect, tolerance = 0.5): boolean {
  return (
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[0] + inner[2] <= outer[0] + outer[2] + tolerance &&
    inner[1] + inner[3] <= outer[1] + outer[3] + tolerance
  );
}

/** How far `inner` reaches beyond `outer` (0 when inside). */
function overflow(outer: Rect, inner: Rect): number {
  return Math.max(0, outer[0] - inner[0], outer[1] - inner[1], inner[0] + inner[2] - (outer[0] + outer[2]), inner[1] + inner[3] - (outer[1] + outer[3]));
}

/** Intersection of two rects, or null when they do not overlap. */
function intersection(a: Rect, b: Rect): [number, number, number, number] | null {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

/** Non-inverted masks by part id (inverted masks do not shrink what a part can cover). */
export function clipMasks(model: Model): Map<string, string[]> {
  return new Map(model.parts.filter((p) => p.mask?.length && !p.maskInvert).map((p) => [p.id, p.mask!]));
}

/**
 * Region a part can actually cover in a pose: its bounds, clipped to the union of its mask parts'
 * bounds when it has a (non-inverted) mask. Null when it covers nothing (no geometry, masks without
 * geometry, or masks that miss it). An iris clipped by the eye white is bounded by the eye white.
 */
export function coverBounds(pose: Pose, id: string, masks: Map<string, string[]>): Rect | null {
  const b = pose.parts[id]?.bounds ?? null;
  const mask = masks.get(id);
  if (!b || !mask) return b;
  const acc = new RectAccumulator();
  for (const m of mask) acc.add(pose.parts[m]?.bounds ?? null);
  const clip = acc.rect();
  return clip ? intersection(b, clip) : null;
}

/** Visible parts of one pose split by the view box: intersecting it or entirely outside. */
export function viewSplit(pose: Pose, viewBox: Rect, model?: Model): { inView: string[]; outsideView: string[] } {
  const inView: string[] = [];
  const outsideView: string[] = [];
  const masks = model ? clipMasks(model) : new Map<string, string[]>();
  for (const id of pose.drawOrder) {
    const b = coverBounds(pose, id, masks);
    if (b && !intersects(viewBox, b)) outsideView.push(id);
    else inView.push(id);
  }
  return { inView, outsideView };
}

export class PoseStats {
  frames = 0;
  private readonly ikStats = new Map<string, IkStats>();
  private readonly physicsStats = new Map<string, PhysicsOutputStats>();
  private readonly paramStats = new Map<string, ParamStats>();
  private readonly partStats = new Map<string, PartFrameStats>();
  private readonly bounds = new RectAccumulator();
  private readonly canvas: Rect;
  private readonly masks: Map<string, string[]>;
  /** Frames in which nothing is visible. */
  empty = 0;

  /** Whether viewNotes lists single parts entirely outside the view box (see the module comment). */
  readonly notePartsOutsideView: boolean;

  /**
   * `viewBox`: the region every frame shows (null = do not check the view). `opts.partsOutsideView`:
   * list the single visible parts entirely outside it in the notes (default: only when the view box
   * is the canvas; an explicit crop leaves parts out on purpose). The inView/outsideView split
   * (viewSplit, parts()) is computed either way.
   */
  constructor(
    readonly model: Model,
    readonly viewBox: Rect | null = null,
    opts: { partsOutsideView?: boolean } = {},
  ) {
    this.canvas = [0, 0, model.meta.width, model.meta.height];
    this.notePartsOutsideView = opts.partsOutsideView ?? (viewBox !== null && viewBox.every((v, i) => v === this.canvas[i]));
    this.masks = clipMasks(model);
    for (const p of model.parameters) this.paramStats.set(p.id, { id: p.id, min: Infinity, max: -Infinity, range: [p.min, p.max] });
    for (const k of model.ik) {
      this.ikStats.set(k.id, { id: k.id, bones: k.bones, frames: 0, maxExtension: 0, maxExtensionAt: 0, outOfReach: 0, nearStraight: 0, maxError: 0, maxStretch: 1 });
    }
    for (const g of model.physics) {
      for (const o of g.outputs) {
        const p = model.parameters.find((q) => q.id === o.param);
        this.physicsStats.set(`${g.id}\u0000${o.param}`, {
          group: g.id,
          param: o.param,
          range: [p?.min ?? -Infinity, p?.max ?? Infinity],
          rawMin: Infinity,
          rawMax: -Infinity,
          peak: 0,
          peakAt: 0,
          frames: 0,
          clamped: 0,
          overridden: 0,
        });
      }
    }
    for (const p of model.parts) {
      this.partStats.set(p.id, { id: p.id, visible: 0, outsideView: 0, clippedView: 0, outsideCanvas: 0, maxOverflow: 0, minOverflow: Infinity, maxOverflowAt: 0 });
    }
  }

  /** Add one pose; `time` is what reports call the frame (default pose.time). */
  add(pose: Pose, time: number = pose.time): void {
    this.frames++;
    for (const [id, v] of Object.entries(pose.params)) {
      const s = this.paramStats.get(id);
      if (!s) continue;
      if (v < s.min) s.min = v;
      if (v > s.max) s.max = v;
    }
    for (const [id, p] of Object.entries(pose.ik ?? {})) {
      const s = this.ikStats.get(id);
      if (!s) continue;
      s.frames++;
      if (p.extension > s.maxExtension || s.frames === 1) {
        s.maxExtension = p.extension;
        s.maxExtensionAt = time;
      }
      // Geometric reach: softness deliberately leaves the tip short of targets that are within reach.
      if (p.extension > 1 + 1e-6) s.outOfReach++;
      if (p.extension > SNAP_EXTENSION) s.nearStraight++;
      if (p.error > s.maxError) s.maxError = p.error;
      if ((p.stretch ?? 1) > s.maxStretch) s.maxStretch = p.stretch ?? 1;
    }
    for (const [group, g] of Object.entries(pose.physics ?? {})) {
      for (const o of g.outputs) {
        const s = this.physicsStats.get(`${group}\u0000${o.param}`);
        if (!s) continue;
        s.frames++;
        if (o.overridden) {
          s.overridden++;
          continue;
        }
        if (o.raw < s.rawMin) s.rawMin = o.raw;
        if (o.raw > s.rawMax) s.rawMax = o.raw;
        if (Math.abs(o.raw) > Math.abs(s.peak) || s.frames - s.overridden === 1) {
          s.peak = o.raw;
          s.peakAt = time;
        }
        if (o.clamped) s.clamped++;
      }
    }
    if (pose.drawOrder.length === 0) this.empty++;
    for (const id of pose.drawOrder) {
      const s = this.partStats.get(id);
      // Masked parts only show inside their masks: a glow clipped to the body cannot leave the canvas.
      const b = coverBounds(pose, id, this.masks);
      if (!s) continue;
      s.visible++;
      if (!b) continue;
      this.bounds.add(b);
      if (this.viewBox) {
        if (!intersects(this.viewBox, b)) s.outsideView++;
        else if (!contains(this.viewBox, b)) s.clippedView++;
      }
      const over = overflow(this.canvas, b);
      if (over < s.minOverflow) s.minOverflow = over;
      if (over > 0.5) {
        s.outsideCanvas++;
        if (over > s.maxOverflow) {
          s.maxOverflow = over;
          s.maxOverflowAt = time;
        }
      }
    }
  }

  ik(): IkStats[] {
    return [...this.ikStats.values()].filter((s) => s.frames > 0);
  }

  physics(): PhysicsOutputStats[] {
    return [...this.physicsStats.values()].filter((s) => s.frames > 0);
  }

  params(): ParamStats[] {
    return [...this.paramStats.values()].filter((s) => s.min <= s.max);
  }

  parts(): PartFrameStats[] {
    return [...this.partStats.values()];
  }

  /** Union of the visible bounds over all frames. */
  unionBounds(): ViewBox | null {
    return this.bounds.rect();
  }

  /** Notes about suspicious results (see the module comment). */
  notes(): string[] {
    const notes: string[] = [];
    const n = this.frames;
    if (n === 0) return notes;
    if (this.empty) notes.push(`no part is visible in ${shareText(this.empty, n)} (check opacity/visible values, bindings and animations)`);
    notes.push(...this.ikNotes(), ...this.physicsNotes(), ...this.viewNotes());
    return notes;
  }

  ikNotes(): string[] {
    const notes: string[] = [];
    for (const s of this.ik()) {
      const def = this.model.ik.find((k) => k.id === s.id)!;
      if (def.bones.length < 2) continue; // an aim constraint only points at its target
      const upTo = s.frames > 1 ? 'up to ' : '';
      if (s.outOfReach && !def.stretch) {
        notes.push(
          `IK "${s.id}": target out of reach in ${shareText(s.outOfReach, s.frames)}; extension ${upTo}${fmtNum(s.maxExtension)}, the chain tip misses the target by ${upTo}${fmtNum(s.maxError, 1)} px and the chain snaps straight. Move the target closer, lengthen the bones, or set "stretch": true`,
        );
      } else if (s.nearStraight && !(def.softness > 0)) {
        notes.push(
          `IK "${s.id}": chain nearly straight in ${shareText(s.nearStraight, s.frames)}; extension ${upTo}${fmtNum(s.maxExtension)} (> ${SNAP_EXTENSION}), so the joint may visibly snap as it straightens. Set "softness" (px, e.g. 10) or keep the target closer`,
        );
      }
    }
    return notes;
  }

  physicsNotes(): string[] {
    const notes: string[] = [];
    for (const s of this.physics()) {
      if (!s.clamped) continue;
      const active = s.frames - s.overridden;
      notes.push(
        `physics "${s.group}": ${s.param} clamped in ${shareText(s.clamped, active)}; raw output ${active === 1 ? fmtNum(s.peak) : `up to ${fmtNum(s.peak)}`} vs range ${fmtNum(s.range[0])}..${fmtNum(s.range[1])}, so the swing stops hard at the limit. Lower the output "scale" or widen the parameter range`,
      );
    }
    return notes;
  }

  viewNotes(): string[] {
    if (!this.viewBox) return [];
    const parts = this.parts().filter((s) => s.visible > 0);
    if (!parts.length) return [];
    const n = this.frames;
    if (parts.every((s) => s.outsideView === s.visible)) {
      const b = this.bounds.rect();
      return [`the visible parts${b ? ` [${b.map((v) => fmtNum(v, 1)).join(', ')}]` : ''} lie entirely outside the view box; use a "fit" view box (--viewbox fit)`];
    }
    // Parts partly beyond the view box are common (backgrounds, floors) and not noted; see PartFrameStats.
    // Parts entirely outside an explicit crop are left out on purpose.
    if (!this.notePartsOutsideView) return [];
    const out = parts.filter((s) => s.outsideView > 0);
    const label = (s: PartFrameStats) => (n > 1 && s.outsideView < n ? `${s.id} (${shareText(s.outsideView, n)})` : s.id);
    return out.length ? [`visible parts entirely outside the view box: ${listIds(out.map(label), 20)}; use a "fit" view box (--viewbox fit) to include them`] : [];
  }
}
