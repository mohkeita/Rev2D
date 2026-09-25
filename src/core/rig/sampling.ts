/**
 * Frame inputs, animation sampling, parameter evaluation (SPEC §9 steps 1-3 + clamping) and binding
 * grid interpolation (SPEC §5).
 */
import { suggest } from '../address.js';
import type { PoseOptions, Value } from '../types.js';
import { blendValues, lerpValue } from '../values.js';
import type { CompiledAnimation, CompiledBinding, CompiledRig, CompiledTrack } from './compiled.js';
import { hermiteValue } from './curves.js';

export interface ResolvedLayer {
  anim: CompiledAnimation;
  weight: number;
  /** Explicit layer time at the frame time, or undefined to follow the global clock (minus `start`). */
  time: number | undefined;
  /** 'add': param tracks add weight * (v - parameter default); 'override': blend toward v. */
  mode: 'override' | 'add';
  /** Global time at which the layer's clock is 0 (ignored when `time` is set). */
  start: number;
  /** false: the layer contributes nothing (no values, no events) outside its active window (see layerActive). */
  hold: boolean;
}

export interface FrameInputs {
  time: number;
  layers: ResolvedLayer[];
  /** [param index, value] explicit overrides, already clamped to the parameter range. */
  overrides: Array<[number, number]>;
  physics: boolean;
}

/** A non-parameter animation track sample waiting to be combined after bindings. */
export interface Contribution {
  slot: number;
  value: Value;
  weight: number;
}

function finite(v: number | undefined, what: string): void {
  if (v !== undefined && !Number.isFinite(v)) throw new Error(`Rig: ${what} must be a finite number, got ${v}`);
}

export function resolveInputs(c: CompiledRig, opts: PoseOptions): FrameInputs {
  const time = opts.time ?? 0;
  finite(time, 'time');
  const layers = (opts.animations ?? []).map((entry): ResolvedLayer => {
    const layer = typeof entry === 'string' ? { id: entry } : entry;
    const anim = c.animations.get(layer.id);
    if (!anim) {
      const hint = suggest(layer.id, [...c.animations.keys()]);
      throw new Error(`Rig: unknown animation "${layer.id}"${hint ? ` (${hint})` : ''}`);
    }
    const what = `animation layer "${layer.id}"`;
    finite(layer.time, `time of ${what}`);
    finite(layer.weight, `weight of ${what}`);
    finite(layer.start, `start of ${what}`);
    const mode = layer.mode ?? 'override';
    if (mode !== 'override' && mode !== 'add') {
      throw new Error(`Rig: mode of ${what} must be "override" or "add", got ${JSON.stringify(mode)}`);
    }
    if (layer.hold !== undefined && typeof layer.hold !== 'boolean') {
      throw new Error(`Rig: hold of ${what} must be true or false, got ${JSON.stringify(layer.hold)}`);
    }
    return { anim, weight: layer.weight ?? 1, time: layer.time, mode, start: layer.start ?? 0, hold: layer.hold ?? true };
  });
  const overrides = Object.entries(opts.params ?? {}).map(([id, value]): [number, number] => {
    const p = c.params.index.get(id);
    if (p === undefined) {
      const hint = suggest(id, c.params.ids);
      throw new Error(`Rig: unknown parameter "${id}"${hint ? ` (${hint})` : ''}`);
    }
    finite(value, `parameter "${id}"`);
    const { min, max } = c.params;
    return [p, value < min[p] ? min[p] : value > max[p] ? max[p] : value];
  });
  return { time, layers, overrides, physics: opts.physics !== false && c.physics.length > 0 };
}

/**
 * Unwrapped time of a layer at global time `t`: `t - start` on the global clock, or the explicit layer
 * time, which keeps its offset to the frame clock (so physics sub-steps see it advance too).
 */
export function layerTime(layer: ResolvedLayer, inputs: FrameInputs, t: number): number {
  return layer.time === undefined ? t - layer.start : layer.time + (t - inputs.time);
}

/** Slack for window tests on computed times (e.g. start + duration). */
const WINDOW_EPS = 1e-9;

/**
 * Whether a layer contributes (values and events) at unwrapped layer time `raw`. Holding layers
 * (default) always do. With hold = false a layer contributes only while `raw` is in [0, duration]
 * (non-looping) or >= 0 (looping: nothing before it starts).
 */
export function layerActive(layer: ResolvedLayer, raw: number): boolean {
  if (layer.hold) return true;
  if (raw < -WINDOW_EPS) return false;
  return layer.anim.loop || raw <= layer.anim.duration + WINDOW_EPS;
}

/** Animation-local time: wrapped for looping animations, clamped to [0, duration] otherwise. */
export function localTime(anim: CompiledAnimation, raw: number): number {
  const d = anim.duration;
  if (anim.loop) return wrap(raw, d);
  return raw < 0 ? 0 : raw > d ? d : raw;
}

function wrap(t: number, d: number): number {
  return ((t % d) + d) % d;
}

/**
 * Time at which `track` is sampled for animation-local time `local`: shifted by the track offset,
 * wrapped into [0, duration) for looping animations (non-looping: unclamped, so keys hold).
 */
export function trackTime(anim: CompiledAnimation, track: CompiledTrack, local: number): number {
  if (track.offset === 0) return local;
  const t = local - track.offset;
  return anim.loop ? wrap(t, anim.duration) : t;
}

/**
 * Sample a track: first/last value hold outside the keys; segments ease from key i to key i+1 with
 * key i's ease ("smooth" segments: cubic Hermite through the key tangents, see curves.ts).
 */
export function sampleTrack(track: CompiledTrack, t: number): Value {
  const { times, values } = track;
  const last = times.length - 1;
  if (t <= times[0]) return values[0];
  if (t >= times[last]) return values[last];
  // Invariant: times[lo] <= t < times[hi].
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const dt = times[hi] - times[lo];
  const s = (t - times[lo]) / dt;
  if (track.smooth?.[lo]) {
    const m = track.tangents!;
    return hermiteValue(values[lo], values[hi], m[lo], m[hi], dt, s);
  }
  const ease = track.eases[lo];
  if (!ease) return values[lo];
  return lerpValue(values[lo], values[hi], ease(s));
}

/**
 * Write the explicit parameter values (clamped) into `out`. Explicit values always win: this runs after
 * the animation layers and again after every physics write (SPEC §9).
 */
export function applyOverrides(inputs: FrameInputs, out: Float64Array): void {
  for (const [p, v] of inputs.overrides) out[p] = v;
}

/**
 * Parameters at global time `t`: defaults -> animation layers -> clamp to range -> explicit overrides.
 * Param tracks of 'override' layers blend toward their value (p += w·(v - p)); those of 'add' layers
 * add their offset from the parameter default (p += w·(v - default)). When `contributions` is given,
 * non-parameter tracks are sampled into it (in layer order; always deltas from setup).
 */
export function evaluateParams(
  c: CompiledRig,
  inputs: FrameInputs,
  t: number,
  out: Float64Array,
  contributions: Contribution[] | null,
): void {
  const defaults = c.params.defaults;
  out.set(defaults);
  for (const layer of inputs.layers) {
    const raw = layerTime(layer, inputs, t);
    if (!layerActive(layer, raw)) continue;
    const { anim } = layer;
    const local = localTime(anim, raw);
    const w = layer.weight;
    const add = layer.mode === 'add';
    for (const track of anim.tracks) {
      if (track.param >= 0) {
        const p = track.param;
        const v = sampleTrack(track, trackTime(anim, track, local)) as number;
        out[p] += w * (v - (add ? defaults[p] : out[p]));
      } else if (contributions) {
        contributions.push({ slot: track.slot, value: sampleTrack(track, trackTime(anim, track, local)), weight: w });
      }
    }
  }
  const { min, max } = c.params;
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    out[i] = v < min[i] ? min[i] : v > max[i] ? max[i] : v;
  }
  applyOverrides(inputs, out);
}

/** Multilinear interpolation over the binding grid (clamped at the ends; `step` holds the lower key). */
export function evaluateBinding(b: CompiledBinding, params: Float64Array): Value {
  const dims = b.axes.length;
  let base = 0;
  const frac = [0, 0, 0];
  for (let d = 0; d < dims; d++) {
    const axis = b.axes[d];
    const p = params[b.params[d]];
    const last = axis.length - 1;
    let i = 0;
    if (p >= axis[last]) {
      i = last;
    } else if (p > axis[0]) {
      while (axis[i + 1] <= p) i++;
      if (!b.step) frac[d] = (p - axis[i]) / (axis[i + 1] - axis[i]);
    }
    base += i * b.strides[d];
  }
  const values: Value[] = [];
  const weights: number[] = [];
  for (let corner = 0; corner < 1 << dims; corner++) {
    let w = 1;
    let idx = base;
    for (let d = 0; d < dims && w !== 0; d++) {
      if (corner & (1 << d)) {
        w *= frac[d];
        idx += b.strides[d];
      } else {
        w *= 1 - frac[d];
      }
    }
    if (w === 0) continue;
    values.push(b.keyforms[idx]);
    weights.push(w);
  }
  return values.length === 1 ? values[0] : blendValues(values, weights);
}
