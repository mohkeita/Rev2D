/**
 * Spine animations from sampled Rev2D frames. Every channel is sampled (bake.ts), turned into values
 * relative to the Spine setup pose and reduced to the fewest linear / Bézier keys that stay within the
 * tolerance (bake-reduce.ts):
 * - bones (local values after bindings, animation and IK; warp lattice bones: lattice point positions):
 *   rotate = −(rotation − setup) (the y flip turns clockwise into counter-clockwise),
 *   translate = (x − setup, −(y − setup)), scale = value / setup;
 * - slots: rgba = (tint rgb, tint alpha × opacity, 0 while hidden);
 * - deform: vertex offsets the bones do not explain (shape morphs, skinning differences, clipping
 *   polygons of deforming masks);
 * - draw order: stepped keys where the (z, index) order changes;
 * - events with their data.
 */
import type { CompiledRig } from '../../core/rig/compiled.js';
import type { Pose, RGBA } from '../../core/types.js';
import { stepIntervals, type ClipSample } from './bake.js';
import { fitSegments, type CurveMode, type Segment } from './bake-reduce.js';
import { round, roundAll } from './export-json.js';
import type { SpineBone } from './export-bones.js';
import type { VertexPlan } from './export-parts.js';
import { toSpineColor, type ReportBuilder } from './util.js';

export interface SlotPlan {
  name: string;
  /** 'part': the slot of an exported part; 'clip': a clipping slot. */
  kind: 'part' | 'clip';
  /** Rev2D part index (the mask part for clipping slots). */
  partIndex: number;
  /** Tie-break of parts with equal z (the setup slot order; -1 for clipping slots). */
  rank: number;
  attachment: string;
  plan: VertexPlan;
  /** Clipping slots: the part slots they clip (setup order). */
  clipped?: SlotPlan[];
}

export interface AnimTolerances {
  /** Degrees. */
  rotate: number;
  /** Px. */
  translate: number;
  /** Scale units. */
  scale: number;
  /** Color channel units (0..1). */
  color: number;
  /** Px. */
  deform: number;
  /** Decimals of deform offsets. */
  deformDecimals: number;
}

export interface AnimContext {
  c: CompiledRig;
  setupPose: Pose;
  /** Spine bones in order (index 0 = the synthetic root). */
  bones: SpineBone[];
  /** Slots in setup draw order. */
  slots: SlotPlan[];
  tol: AnimTolerances;
  report: ReportBuilder;
  /** Deform timelines under `attachments` (4.1+) or the older top-level `deform` layout. */
  deformLayout: 'attachments' | 'deform';
  skin: string;
}

type Json = Record<string, unknown>;

function wrap180(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  else if (r > 180) r -= 360;
  return r;
}

function time(t: number): number {
  return round(t, 5);
}

/**
 * Fit a sampled timeline (`dims` values per frame) and build its keys: one per segment start with the
 * segment's curve (Spine 4 absolute control points per channel, or a percent curve for 'shared'), plus
 * the last frame. `time` is omitted at 0 (Spine's default).
 */
function timeline(
  times: number[],
  vals: ArrayLike<number>,
  dims: number,
  tol: number,
  mode: CurveMode,
  decimals: number,
  make: (f: number) => Json,
  stats: AnimStats,
  jumps?: boolean[],
): Json[] {
  const segs: Segment[] = fitSegments(times, vals, dims, tol, mode, true, jumps);
  const out: Json[] = [];
  const push = (f: number, seg: Segment | null) => {
    const t = time(times[f]);
    const k: Json = t === 0 ? {} : { time: t };
    Object.assign(k, make(f));
    if (seg?.curve === 'stepped') {
      k.curve = 'stepped';
    } else if (seg?.curve) {
      const t0 = times[seg.from];
      const dt = times[seg.to] - t0;
      const cx1 = time(t0 + dt / 3);
      const cx2 = time(t0 + (2 * dt) / 3);
      const curve: number[] = [];
      const channels = mode === 'shared' ? 1 : dims;
      for (let d = 0; d < channels; d++) curve.push(cx1, round(seg.curve[2 * d], decimals), cx2, round(seg.curve[2 * d + 1], decimals));
      k.curve = curve;
    }
    out.push(k);
  };
  for (const seg of segs) push(seg.from, seg);
  push(segs.length ? segs[segs.length - 1].to : 0, null);
  stats.sampledKeys += times.length;
  stats.keys += out.length;
  return out;
}

function maxAbsDev(values: ArrayLike<number>, dims: number, ref: number[]): number {
  let m = 0;
  for (let i = 0; i < values.length; i++) m = Math.max(m, Math.abs(values[i] - ref[i % dims]));
  return m;
}

/** Slot color of a part in a pose: tint rgb, tint alpha × opacity (0 while hidden). */
export function slotColor(pose: Pose, partId: string): RGBA {
  const p = pose.parts[partId];
  return [p.tint[0], p.tint[1], p.tint[2], p.visible ? p.tint[3] * p.opacity : 0];
}

/** Draw order of the slots in a pose (indices into ctx.slots). */
function frameOrder(ctx: AnimContext, pose: Pose): number[] {
  const parts = ctx.slots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === 'part')
    .sort((a, b) => pose.parts[ctx.c.parts[a.s.partIndex].id].z - pose.parts[ctx.c.parts[b.s.partIndex].id].z || a.s.rank - b.s.rank);
  // A clipping slot goes right before whichever of its clipped slots is drawn first.
  const clipOf = new Map<SlotPlan, number>();
  ctx.slots.forEach((s, i) => {
    if (s.kind === 'clip') for (const q of s.clipped!) clipOf.set(q, i);
  });
  const placed = new Set<number>();
  const out: number[] = [];
  for (const { s, i } of parts) {
    const clip = clipOf.get(s);
    if (clip !== undefined && !placed.has(clip)) {
      placed.add(clip);
      out.push(clip);
    }
    out.push(i);
  }
  return out;
}

/** Spine draw order offsets turning the setup order (identity) into `order`. */
function drawOrderOffsets(ctx: AnimContext, order: number[]): Json[] {
  const out: Json[] = [];
  const newIndex = new Array<number>(order.length);
  order.forEach((slot, pos) => (newIndex[slot] = pos));
  for (let s = 0; s < newIndex.length; s++) if (newIndex[s] !== s) out.push({ slot: ctx.slots[s].name, offset: newIndex[s] - s });
  return out;
}

/** Whether every clipping range is still contiguous and ends where its `end` slot says. */
function clipsIntact(ctx: AnimContext, order: number[]): boolean {
  const pos = new Map<SlotPlan, number>();
  order.forEach((slot, p) => pos.set(ctx.slots[slot], p));
  for (const s of ctx.slots) {
    if (s.kind !== 'clip') continue;
    const ps = s.clipped!.map((q) => pos.get(q)!);
    const start = pos.get(s)!;
    if (ps.some((p, k) => p !== start + 1 + k)) return false;
  }
  return true;
}

export interface AnimStats {
  sampledKeys: number;
  keys: number;
  deformTimelines: number;
  deformKeys: number;
}

export function buildAnimation(ctx: AnimContext, clip: ClipSample, stats: AnimStats): Json {
  const { c, setupPose, tol } = ctx;
  const n = clip.poses.length;
  const times = clip.times;
  const where = `animations.${clip.name}`;
  const anim: Json = {};
  const jumps = stepIntervals(times, clip.steps);

  // ------------------------------------------------------------------ slots (colors)
  const slotsJson: Record<string, Json> = {};
  for (const s of ctx.slots) {
    if (s.kind !== 'part') continue;
    const id = c.parts[s.partIndex].id;
    const setup = slotColor(setupPose, id);
    const vals = new Float64Array(n * 4);
    clip.poses.forEach((p, f) => vals.set(slotColor(p, id), f * 4));
    if (maxAbsDev(vals, 4, setup) <= Math.max(tol.color, 1e-9)) continue;
    slotsJson[s.name] = {
      rgba: timeline(times, vals, 4, tol.color, 'channels', 4, (f) => ({ color: toSpineColor([vals[f * 4], vals[f * 4 + 1], vals[f * 4 + 2], vals[f * 4 + 3]]) }), stats, jumps),
    };
  }
  if (Object.keys(slotsJson).length) anim.slots = slotsJson;

  // ------------------------------------------------------------------ bones
  const bonesJson: Record<string, Json> = {};
  const lengthChanged: string[] = [];
  for (const b of ctx.bones) {
    if (b.parent < 0) continue;
    const id = b.name;
    const L0 = b.local(setupPose);
    const rot = new Float64Array(n);
    const tr = new Float64Array(n * 2);
    const sc = new Float64Array(n * 2);
    let prev = 0;
    let lengthMoved = false;
    clip.poses.forEach((p, f) => {
      const L = b.local(p);
      const r = -(L.rotation - L0.rotation);
      prev = f === 0 ? wrap180(r) : prev + wrap180(r - prev);
      rot[f] = prev;
      tr[2 * f] = L.x - L0.x;
      tr[2 * f + 1] = -(L.y - L0.y);
      sc[2 * f] = L0.scaleX !== 0 ? L.scaleX / L0.scaleX : 1;
      sc[2 * f + 1] = L0.scaleY !== 0 ? L.scaleY / L0.scaleY : 1;
      if (Math.abs(L.length - L0.length) > 1e-6) lengthMoved = true;
      if ((L0.scaleX === 0 && L.scaleX !== 0) || (L0.scaleY === 0 && L.scaleY !== 0)) {
        ctx.report.warn(
          'spine-bone-scale-zero',
          `bone "${id}" has scale 0 in the setup pose; Spine scale keys multiply the setup scale, so its animated scale cannot be exported`,
          `${where}.bones.${id}`,
          'give the bone a small non-zero setup scale',
        );
      }
    });
    if (lengthMoved) lengthChanged.push(id);
    const tl: Json = {};
    if (maxAbsDev(rot, 1, [0]) > Math.max(tol.rotate, 1e-9)) {
      tl.rotate = timeline(times, rot, 1, tol.rotate, 'channels', 3, (f) => {
        const v = round(rot[f], 3);
        return v === 0 ? {} : { value: v };
      }, stats, jumps);
    }
    if (maxAbsDev(tr, 2, [0, 0]) > Math.max(tol.translate, 1e-9)) {
      tl.translate = timeline(times, tr, 2, tol.translate, 'channels', 3, (f) => {
        const k: Json = {};
        const x = round(tr[2 * f], 3);
        const y = round(tr[2 * f + 1], 3);
        if (x !== 0) k.x = x;
        if (y !== 0) k.y = y;
        return k;
      }, stats, jumps);
    }
    if (maxAbsDev(sc, 2, [1, 1]) > Math.max(tol.scale, 1e-9)) {
      tl.scale = timeline(times, sc, 2, tol.scale, 'channels', 5, (f) => {
        const k: Json = {};
        const x = round(sc[2 * f], 5);
        const y = round(sc[2 * f + 1], 5);
        if (x !== 1) k.x = x;
        if (y !== 1) k.y = y;
        return k;
      }, stats, jumps);
    }
    if (Object.keys(tl).length) bonesJson[b.name] = tl;
  }
  if (Object.keys(bonesJson).length) anim.bones = bonesJson;
  if (lengthChanged.length) {
    ctx.report.info(
      'spine-bone-length-animated',
      `bone length changes of ${lengthChanged.map((b) => `"${b}"`).join(', ')} are not exported (Spine cannot animate a bone's length; IK and skinning effects are baked)`,
      where,
    );
  }

  // ------------------------------------------------------------------ deform
  const deformJson: Record<string, Record<string, Json>> = {};
  for (const s of ctx.slots) {
    if (s.plan.rigid) continue;
    const len = s.plan.deformLength;
    const vals = new Float32Array(n * len);
    clip.poses.forEach((p, f) => s.plan.deform(p, vals, f * len));
    let dev = 0;
    for (let i = 0; i < vals.length; i++) dev = Math.max(dev, Math.abs(vals[i]));
    if (dev <= Math.max(tol.deform, 1e-6)) continue;
    const before = stats.keys;
    const keys = timeline(times, vals, len, tol.deform, 'shared', 5, (f) => {
      const row = roundAll(vals.subarray(f * len, (f + 1) * len), tol.deformDecimals);
      let a = 0;
      while (a < row.length && row[a] === 0) a++;
      if (a === row.length) return {};
      let b = row.length;
      while (b > a && row[b - 1] === 0) b--;
      return a > 0 ? { offset: a, vertices: row.slice(a, b) } : { vertices: row.slice(0, b) };
    }, stats, jumps);
    stats.deformTimelines++;
    stats.deformKeys += stats.keys - before;
    (deformJson[s.name] ??= {})[s.attachment] = ctx.deformLayout === 'attachments' ? { deform: keys } : (keys as unknown as Json);
  }
  if (Object.keys(deformJson).length) {
    if (ctx.deformLayout === 'attachments') anim.attachments = { [ctx.skin]: deformJson };
    else anim.deform = { [ctx.skin]: deformJson };
  }

  // ------------------------------------------------------------------ draw order
  const setupOrder = ctx.slots.map((_, i) => i).join(',');
  const drawKeys: Json[] = [];
  let last = setupOrder;
  let broken = false;
  clip.poses.forEach((p, f) => {
    const order = frameOrder(ctx, p);
    const sig = order.join(',');
    if (sig === last) return;
    last = sig;
    if (!clipsIntact(ctx, order)) broken = true;
    const t = time(times[f]);
    const offsets = drawOrderOffsets(ctx, order);
    const key: Json = t === 0 ? {} : { time: t };
    if (offsets.length) key.offsets = offsets;
    drawKeys.push(key);
  });
  if (drawKeys.length) {
    anim.drawOrder = drawKeys;
    stats.keys += drawKeys.length;
    stats.sampledKeys += drawKeys.length;
  }
  if (broken) {
    ctx.report.warn(
      'spine-mask-draw-order',
      'the draw order changes in a way that splits a masked range; Spine clips a contiguous range of slots, so the clipping may cover other slots there',
      where,
      'keep masked parts next to each other in every pose (animate their z together)',
    );
  }

  // ------------------------------------------------------------------ events
  if (clip.events.length) {
    anim.events = clip.events.map((e) => {
      const k: Json = {};
      const t = time(e.t);
      if (t !== 0) k.time = t;
      k.name = e.name;
      Object.assign(k, eventData(ctx, e.data, `${where}.events (${e.name} at ${e.t})`));
      return k;
    });
  }
  return anim;
}

/** Spine event values (int / float / string / volume / balance) of Rev2D event data. */
export function eventData(ctx: { report: ReportBuilder }, data: unknown, where: string): Json {
  if (data === undefined || data === null) return {};
  if (typeof data === 'number') return Number.isInteger(data) ? { int: data } : { float: data };
  if (typeof data === 'string') return { string: data };
  if (typeof data === 'boolean') return { int: data ? 1 : 0 };
  if (typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    const out: Json = {};
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) {
      if (k === 'int' && typeof v === 'number' && Number.isInteger(v)) out.int = v;
      else if ((k === 'float' || k === 'volume' || k === 'balance') && typeof v === 'number') out[k] = v;
      else if (k === 'string' && typeof v === 'string') out.string = v;
      else if (k === 'audio' && typeof v === 'string') continue; // skeleton-level field
      else rest[k] = v;
    }
    if (Object.keys(rest).length) {
      if (out.string === undefined) {
        out.string = JSON.stringify(rest);
        ctx.report.info('spine-event-data', 'event data fields without a Spine equivalent are written as a JSON string in the event\'s "string" value', where);
      } else {
        ctx.report.warn('spine-event-data-dropped', `event data fields ${Object.keys(rest).join(', ')} have no Spine equivalent and were dropped`, where);
      }
    }
    return out;
  }
  ctx.report.info('spine-event-data', 'event data is written as a JSON string in the event\'s "string" value', where);
  return { string: JSON.stringify(data) };
}
