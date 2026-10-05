/**
 * Frame sampling for the Spine exporter: every exported animation (and parameter pose) is evaluated
 * with the rig at a fixed rate, using a Player so physics steps incrementally like real playback.
 * Also the per-part deformers that move a part's reference points into a pose exactly like the rig
 * moves the part's own vertices (bone: world · setupWorld⁻¹, warp: bilinear lattice, skin: linear
 * blend skinning with the weights a vertex at that point gets).
 */
import { multiply } from '../../core/math.js';
import type { Rig } from '../../core/rig.js';
import type { CompiledRig } from '../../core/rig/compiled.js';
import { pointSkinWeights, skinPoints } from '../../core/rig/parts.js';
import { mapPointsThroughWarp } from '../../core/rig/warp.js';
import type { Animation, Mat2D, Pose } from '../../core/types.js';

export interface ClipSample {
  /** Spine animation name. */
  name: string;
  /** Source Rev2D animation id (undefined for parameter poses). */
  animation?: string;
  duration: number;
  loop: boolean;
  /** Local times of the frames (seconds, 0 .. duration). */
  times: number[];
  poses: Pose[];
  events: Array<{ t: number; name: string; data?: unknown }>;
  /** Whole cycles simulated before the sampled one (physics warm-up of looping animations). */
  warmupCycles: number;
  /**
   * Local times where a stepped key of the source changes a value (sampled STEP_LEAD before and at the
   * time): the exporter writes stepped keys there instead of a short ramp.
   */
  steps: number[];
}

/** Seconds of physics warm-up before sampling a looping animation (rounded up to whole cycles). */
export const PHYSICS_WARMUP_SECONDS = 5;

/** Samples closer than this (seconds) are merged, keeping the required one. */
const MIN_GAP = 5e-4;
/** How long before a key the hold of a preceding step key is sampled. */
const STEP_LEAD = 1e-3;

/** Local times (wrapped for loops) where a track's stepped key hands over to the next key. */
export function stepTimes(duration: number, anim: Animation): number[] {
  const out = new Set<number>();
  for (const tr of anim.tracks) {
    tr.keys.forEach((k, i) => {
      if (i === 0 || tr.keys[i - 1].ease !== 'step') return;
      let x = k.t + tr.offset;
      if (anim.loop && duration > 0) x = ((x % duration) + duration) % duration;
      if (x > 0 && x <= duration) out.add(x);
    });
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Frame times of an animation: uniform steps of at most 1/fps (the last exactly at the duration),
 * plus every key time of its tracks (where extremes and corners are) and the instants just before and
 * after the end of a step key's hold (so holds end sharply instead of ramping over a frame).
 */
export function frameTimes(duration: number, fps: number, anim?: Animation): number[] {
  const n = Math.max(1, Math.ceil(duration * fps - 1e-9));
  const grid = Array.from({ length: n + 1 }, (_, k) => (k === n ? duration : (duration * k) / n));
  if (!anim) return grid;
  const must = new Set<number>([0, duration]);
  const place = (t: number) => {
    let x = t;
    if (anim.loop && duration > 0) x = ((x % duration) + duration) % duration;
    if (x >= 0 && x <= duration) must.add(x);
  };
  for (const tr of anim.tracks) {
    tr.keys.forEach((k, i) => {
      place(k.t + tr.offset);
      // Around a step change: the hold just before it and the new value just after it (Rev2D shows the
      // held value at the key time itself).
      if (i > 0 && tr.keys[i - 1].ease === 'step') {
        place(k.t + tr.offset - STEP_LEAD);
        place(k.t + tr.offset + STEP_LEAD);
      }
    });
  }
  const required = [...must].sort((a, b) => a - b);
  const out: number[] = [];
  let r = 0;
  for (const t of grid) {
    while (r < required.length && required[r] <= t + MIN_GAP) {
      const q = required[r++];
      if (out.length && q - out[out.length - 1] < MIN_GAP) out[out.length - 1] = q;
      else out.push(q);
    }
    if (out.length && Math.abs(t - out[out.length - 1]) < MIN_GAP) continue;
    out.push(t);
  }
  while (r < required.length) {
    const q = required[r++];
    if (out.length && q - out[out.length - 1] < MIN_GAP) out[out.length - 1] = q;
    else out.push(q);
  }
  return out;
}

/** Whole cycles to simulate before the sampled cycle of a looping animation with physics. */
export function warmupCycles(rig: Rig, anim: Animation): number {
  if (!anim.loop || rig.model.physics.length === 0) return 0;
  return Math.max(1, Math.ceil(PHYSICS_WARMUP_SECONDS / anim.duration));
}

/**
 * A pose as numbers in pixel-like units, to measure how far a pose is from the interpolation of its
 * neighbours: bone origins and axes (× 100 px), warp lattice points, part bounds, opacity and tint
 * (× 100), deformed fill vertices.
 */
export function poseSignature(pose: Pose): number[] {
  const out: number[] = [];
  for (const b of Object.values(pose.bones)) {
    const w = b.world;
    out.push(w[4], w[5], w[0] * 100, w[1] * 100, w[2] * 100, w[3] * 100);
  }
  for (const w of Object.values(pose.warps)) for (let i = 0; i < w.points.length; i++) out.push(w.points[i]);
  for (const p of Object.values(pose.parts)) {
    out.push(...(p.bounds ?? [0, 0, 0, 0]), (p.visible ? p.opacity : 0) * 100, p.tint[0] * 100, p.tint[1] * 100, p.tint[2] * 100, p.tint[3] * 100);
  }
  // Deformed fill vertices last (deform timelines follow them; a part whose vertex count changes only
  // misaligns what comes after it).
  for (const p of Object.values(pose.parts)) if (p.fill) for (let i = 0; i < p.fill.length; i++) out.push(p.fill[i]);
  return out;
}

/**
 * Refinement levels: an interval is halved at most this many times, and not below MIN_REFINE s (or
 * below one 60 Hz physics step for models with physics: their simulated motion changes in steps, which
 * finer samples would only copy as a staircase).
 */
const MAX_REFINE_LEVELS = 5;
const MIN_REFINE = 1 / 480;

/**
 * Sample an animation at `fps` (plus key times) and refine adaptively: the midpoint of every interval
 * is evaluated and kept where the pose leaves the linear interpolation of its neighbours by more than
 * `tolerance` px (fast motion between samples); the halves around a kept midpoint are checked again,
 * up to MAX_REFINE_LEVELS times. Every pass plays the sorted times with a fresh Player, so physics
 * steps incrementally like real playback (its fixed 60 Hz steps make poses independent of which other
 * times are sampled).
 */
export function sampleAnimation(rig: Rig, anim: Animation, fps: number, tolerance = 0.05): ClipSample {
  const base = frameTimes(anim.duration, fps, anim);
  const cycles = warmupCycles(rig, anim);
  const t0 = cycles * anim.duration;
  const threshold = Math.max(tolerance, 0.05);
  const minRefine = rig.model.physics.length ? 1 / 60 : MIN_REFINE;
  const play = (ts: number[]) => {
    const player = rig.player();
    return ts.map((t) => player.update({ time: t0 + t, animations: [anim.id] }));
  };
  let times = base.slice();
  let poses = play(times);
  let sigs = poses.map(poseSignature);
  // Intervals (by their start time) still to check.
  let open = new Set<number>(times.slice(0, -1));
  for (let level = 0; level < MAX_REFINE_LEVELS && open.size; level++) {
    const mids: number[] = [];
    times.forEach((t, i) => {
      if (i + 1 < times.length && open.has(t) && times[i + 1] - t >= 2 * minRefine) mids.push((t + times[i + 1]) / 2);
    });
    if (!mids.length) break;
    const merged = [...times, ...mids].sort((a, b) => a - b);
    const mergedPoses = play(merged);
    const mergedSigs = mergedPoses.map(poseSignature);
    const midSet = new Set(mids);
    const keep = new Set<number>();
    merged.forEach((t, i) => {
      if (!midSet.has(t)) return;
      const a = mergedSigs[i - 1];
      const b = mergedSigs[i + 1];
      const m = mergedSigs[i];
      let dev = 0;
      for (let k = 0; k < m.length && dev <= threshold; k++) dev = Math.max(dev, Math.abs(m[k] - (a[k] + b[k]) / 2));
      if (dev > threshold) keep.add(t);
    });
    const next = merged.map((t, i) => ({ t, i })).filter(({ t }) => !midSet.has(t) || keep.has(t));
    open = new Set<number>();
    next.forEach(({ t }, j) => {
      if (keep.has(t)) {
        open.add(next[j - 1].t);
        open.add(t);
      }
    });
    times = next.map(({ t }) => t);
    poses = next.map(({ i }) => mergedPoses[i]);
    sigs = next.map(({ i }) => mergedSigs[i]);
  }
  void sigs;
  return {
    name: anim.id,
    animation: anim.id,
    duration: anim.duration,
    loop: anim.loop,
    times,
    poses,
    events: (anim.events ?? []).map((e) => ({ t: e.t, name: e.name, data: e.data })).sort((a, b) => a.t - b.t),
    warmupCycles: cycles,
    steps: stepTimes(anim.duration, anim),
  };
}

/**
 * Intervals k (between frames k and k + 1) no longer than the step lead that end or start at a step
 * time: a value that changes there changes by a step (fitSegments' `jumps`), whether the frame at the
 * step time already shows the new value or still the held one.
 */
export function stepIntervals(times: readonly number[], steps: readonly number[]): boolean[] {
  const out = new Array<boolean>(Math.max(0, times.length - 1)).fill(false);
  if (!steps.length) return out;
  const at = (t: number) => steps.some((s) => Math.abs(t - s) < 1e-9);
  for (let k = 0; k + 1 < times.length; k++) {
    if (times[k + 1] - times[k] > STEP_LEAD + MIN_GAP) continue;
    if (at(times[k + 1]) || at(times[k])) out[k] = true;
  }
  return out;
}

export function sampleParamPose(rig: Rig, name: string, param: string, value: number): ClipSample {
  const pose = rig.pose({ time: 0, params: { [param]: value } });
  return { name, duration: 0, loop: false, times: [0], poses: [pose], events: [], warmupCycles: 0, steps: [] };
}

// ----------------------------------------------------------------------------- deformers

/** Moves reference points (setup space) of one part into a pose. `out` may not alias `src`. */
export type Deformer = (pose: Pose, src: ArrayLike<number>, out: Float64Array) => void;

function applyMat(m: Mat2D, src: ArrayLike<number>, out: Float64Array): void {
  for (let i = 0; i + 1 < src.length; i += 2) {
    const x = src[i];
    const y = src[i + 1];
    out[i] = m[0] * x + m[2] * y + m[4];
    out[i + 1] = m[1] * x + m[3] * y + m[5];
  }
}

/**
 * Deformer of part `index` for a fixed set of reference points (needed up front for skin weights,
 * which depend on where each point is).
 */
export function partDeformer(c: CompiledRig, index: number, points: ArrayLike<number>): Deformer {
  const cp = c.parts[index];
  if (cp.skin) {
    const skin = cp.skin;
    const nb = skin.bones.length;
    const n = points.length >> 1;
    const weights = new Float32Array(n * nb);
    for (let v = 0; v < n; v++) weights.set(pointSkinWeights(skin, cp.source.shape, c.bones, points[2 * v], points[2 * v + 1]), v * nb);
    return (pose, src, out) => {
      const mats = skin.bones.map((b) => multiply(pose.bones[c.bones[b].id].world, c.bones[b].invSetupWorld));
      skinPoints(mats, weights, src, out);
    };
  }
  const parent = cp.parent;
  if (parent.kind === 'bone') {
    const b = c.bones[parent.index];
    return (pose, src, out) => applyMat(multiply(pose.bones[b.id].world, b.invSetupWorld), src, out);
  }
  if (parent.kind === 'warp') {
    const w = c.warps[parent.index];
    return (pose, src, out) => mapPointsThroughWarp(pose.warps[w.id].points, w.cols, w.rows, w.rect, src, out);
  }
  return (_pose, src, out) => {
    for (let i = 0; i < src.length; i++) out[i] = src[i];
  };
}

/** The bone a part rigidly follows: its parent bone, the nearest bone above its parent warp, a skin's first bone, or -1 (none). */
export function partBone(c: CompiledRig, index: number): number {
  const cp = c.parts[index];
  if (cp.skin) return cp.skin.bones[0];
  let parent = cp.parent;
  for (let guard = 0; guard < 1000; guard++) {
    if (parent.kind === 'bone') return parent.index;
    if (parent.kind === 'none') return -1;
    parent = c.warps[parent.index].parent;
  }
  return -1;
}
