/**
 * Playback logic (pure): active animation layers, which parameters animations/physics drive, the
 * playback clock and timeline track rows.
 *
 * The clock is GLOBAL time (PoseOptions.time): it keeps increasing while a looping animation plays,
 * so the Player's incremental physics never restarts at the loop seam; each layer wraps its own
 * local time (SPEC §6). Seeking backwards resets the Player (physics re-simulates from t=0).
 */
import type { Animation, Model } from '../../../src/core/index.js';

/**
 * How a layer combines (core AnimationLayer, SPEC §6): `mode` 'override' (default; later layers win
 * for param tracks) or 'add' (param tracks add weight * (v - default) on top); `start` = global time
 * at which the layer starts (local time = time - start; default 0); `hold` (default true) = a
 * non-looping layer keeps its first/last values outside [0, duration] (false: contributes nothing
 * there, e.g. a one-shot wink).
 */
export interface LayerOptions {
  mode?: 'override' | 'add';
  start?: number;
  hold?: boolean;
}

export interface LayerSetting extends LayerOptions {
  id: string;
  weight: number;
}

export interface PlaybackSettings {
  /** Primary animation (shown in the timeline), null = none. */
  animation: string | null;
  /** Weight of the primary animation (default 1). */
  animationWeight?: number;
  /** Options of the primary animation (default: none). */
  animationOptions?: LayerOptions;
  /** Extra layers played on top of the primary animation, in order. */
  layers: LayerSetting[];
}

/** Only the options that differ from the defaults (mode override, start 0, hold true). */
export function explicitOptions(o: LayerOptions | undefined): LayerOptions {
  const out: LayerOptions = {};
  if (o?.mode === 'add') out.mode = 'add';
  if (o?.start !== undefined && Number.isFinite(o.start) && o.start !== 0) out.start = o.start;
  if (o?.hold === false) out.hold = false;
  return out;
}

/** Short label of the non-default options, e.g. "add · from 1.5s · once" ('' when all are defaults). */
export function optionsLabel(o: LayerOptions | undefined): string {
  const e = explicitOptions(o);
  const parts: string[] = [];
  if (e.mode) parts.push('add');
  if (e.start !== undefined) parts.push(`from ${+e.start.toFixed(3)}s`);
  if (e.hold === false) parts.push('once');
  return parts.join(' · ');
}

/**
 * Layers passed to the rig: the primary first, then the enabled extras; layers with weight 0 are
 * left out. Options are included only where they differ from the defaults.
 */
export function activeLayers(model: Model, s: PlaybackSettings): LayerSetting[] {
  const exists = (id: string): boolean => model.animations.some((a) => a.id === id);
  const out: LayerSetting[] = [];
  const primaryWeight = s.animationWeight ?? 1;
  if (s.animation && primaryWeight > 0 && exists(s.animation)) out.push({ id: s.animation, weight: primaryWeight, ...explicitOptions(s.animationOptions) });
  for (const l of s.layers) {
    if (l.id !== s.animation && l.weight > 0 && exists(l.id) && !out.some((o) => o.id === l.id)) {
      out.push({ id: l.id, weight: l.weight, ...explicitOptions(l) });
    }
  }
  return out;
}

/** Parameters written by `param:` tracks of the given layers. */
export function animatedParams(model: Model, layers: readonly LayerSetting[]): Set<string> {
  const out = new Set<string>();
  for (const l of layers) {
    const anim = model.animations.find((a) => a.id === l.id);
    for (const t of anim?.tracks ?? []) if (t.target.startsWith('param:')) out.add(t.target.slice(6));
  }
  return out;
}

/** Parameters written by physics outputs. */
export function physicsParams(model: Model): Set<string> {
  return new Set(model.physics.flatMap((g) => g.outputs.map((o) => o.param)));
}

/** One physics output of a pose (core PhysicsPose) with the group that wrote it. */
export interface PhysicsOutputInfo {
  group: string;
  param: string;
  /** Output before clamping to the parameter range. */
  raw: number;
  /** Value written (clamped), or the explicit value when overridden. */
  value: number;
  clamped: boolean;
  /** An explicit (pinned) value replaced the physics output. */
  overridden: boolean;
}

/** Physics outputs of a pose by parameter id (empty when physics is off or the pose has none). */
export function physicsOutputsByParam(
  physics: Record<string, { outputs?: ReadonlyArray<Omit<PhysicsOutputInfo, 'group'>> } | undefined> | undefined,
): Map<string, PhysicsOutputInfo[]> {
  const out = new Map<string, PhysicsOutputInfo[]>();
  for (const [group, g] of Object.entries(physics ?? {})) {
    for (const o of g?.outputs ?? []) out.set(o.param, [...(out.get(o.param) ?? []), { group, ...o }]);
  }
  return out;
}

/** Local time of an animation at global time t (SPEC §6: loop wraps, otherwise clamps). */
export function localTime(t: number, anim: Pick<Animation, 'duration' | 'loop'>): number {
  if (anim.loop) {
    const r = t % anim.duration;
    return r < 0 ? r + anim.duration : r;
  }
  return Math.min(Math.max(t, 0), anim.duration);
}

export interface LayerPhase {
  /**
   * Local time as the rig samples it: t - start, wrapped (loop) or clamped (one-shot). Before the
   * start a looping layer already plays (phase-shifted) unless hold is false; otherwise 0.
   */
  local: number;
  state: 'before' | 'playing' | 'after';
  /** The layer affects the pose now (a hold: false one-shot does not outside [0, duration]). */
  active: boolean;
}

/** Where a layer is at global time t. */
export function layerPhase(t: number, anim: Pick<Animation, 'duration' | 'loop'>, o: LayerOptions = {}): LayerPhase {
  const raw = t - (o.start ?? 0);
  const state = raw < 0 ? 'before' : !anim.loop && raw > anim.duration + 1e-9 ? 'after' : 'playing';
  const active = state === 'playing' || o.hold !== false;
  const wrapsBefore = anim.loop && o.hold !== false;
  return { local: localTime(wrapsBefore ? raw : Math.max(0, raw), anim), state, active };
}

export interface ClockStep {
  time: number;
  /** Playback reached the end of a non-repeating animation and should stop. */
  ended: boolean;
}

/**
 * Advance the playback clock by dt seconds. With `repeat` off, playback ends at the primary
 * animation's end. With `repeat` on, looping animations run on (their layer time wraps) and
 * non-looping ones restart from 0.
 */
export function advanceClock(
  time: number,
  dt: number,
  primary: Pick<Animation, 'duration' | 'loop'> | null,
  repeat: boolean,
  start = 0,
): ClockStep {
  const next = time + dt;
  if (!primary) return { time: next, ended: false };
  // A delayed primary (start > 0) runs on the same clock: it ends at start + duration.
  const local = time - start;
  if (!repeat) {
    if (local < 0) return { time: next, ended: false };
    const end = start + (primary.loop ? Math.floor(local / primary.duration + 1e-9) * primary.duration + primary.duration : primary.duration);
    return next >= end ? { time: end, ended: true } : { time: next, ended: false };
  }
  const nextLocal = next - start;
  if (!primary.loop && nextLocal > primary.duration) return { time: start + nextLocal - primary.duration * Math.floor(nextLocal / primary.duration), ended: false };
  return { time: next, ended: false };
}

export interface TrackRow {
  target: string;
  /** Row label: the address without the kind prefix, e.g. "head.rotation". */
  label: string;
  /** Distinct key times in ascending order. */
  times: number[];
}

export interface TrackGroup {
  /** Address kind: param, bone, warp, part, ik. */
  kind: string;
  rows: TrackRow[];
}

const GROUP_ORDER = ['param', 'bone', 'warp', 'part', 'ik'];

/** Tracks of an animation grouped by address kind (params first), rows in file order. */
export function trackGroups(anim: Animation): TrackGroup[] {
  const groups = new Map<string, TrackRow[]>();
  for (const t of anim.tracks) {
    const colon = t.target.indexOf(':');
    const kind = colon > 0 ? t.target.slice(0, colon) : 'other';
    const times = [...new Set(t.keys.map((k) => k.t))].sort((a, b) => a - b);
    const rows = groups.get(kind) ?? [];
    rows.push({ target: t.target, label: t.target.slice(colon + 1), times });
    groups.set(kind, rows);
  }
  const rank = (k: string): number => (GROUP_ORDER.includes(k) ? GROUP_ORDER.indexOf(k) : GROUP_ORDER.length);
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([kind, rows]) => ({ kind, rows }));
}

/** Every distinct key time of an animation (for the summary row and frame snapping). */
export function allKeyTimes(anim: Animation): number[] {
  return [...new Set(anim.tracks.flatMap((t) => t.keys.map((k) => k.t)))].sort((a, b) => a - b);
}

/** "1.25s · f38" style readout parts. */
export function frameOf(t: number, fps: number): number {
  return Math.round(t * fps + 1e-9);
}
