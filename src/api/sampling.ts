/**
 * Sampling an animation over time: which times a sheet / GIF / frame sequence / analysis shows, the
 * warm-up offset that lets physics reach its steady state, sequential evaluation (one Player, so
 * physics runs incrementally) and the events that fall into each sampled frame.
 */
import type { Model, Pose, PoseOptions } from '../core/types.js';
import type { Rig } from '../core/rig.js';
import { ApiError, fmtNum, idHint, show } from './errors.js';
import { checkTime } from './pose.js';

/** Upper bound on the times of one sample plan (a typo like "0:10:100000" must not allocate a huge output). */
export const MAX_SAMPLE_TIMES = 2000;

const TIME_FORMS = '"a:b:n" (n evenly spaced times from a to b, both included) or "t1,t2,..." (seconds, >= 0)';

/**
 * Parse a time list: "a:b:n" = n evenly spaced times from a to b (both included; n = 1 gives just a)
 * or "t1,t2,..." = exactly these times. Every time is a finite number of seconds >= 0.
 */
export function parseTimeSpec(spec: string, what = 'times'): number[] {
  if (typeof spec !== 'string' || spec.trim() === '') throw new ApiError(`${what} must be ${TIME_FORMS}, got ${show(spec)}`, [], 'e.g. "0:2:9" or "0,0.5,1.25"');
  const bad = (why: string) => new ApiError(`bad ${what} "${spec}": ${why}`, [], `forms: ${TIME_FORMS}, e.g. "0:2:9" or "0,0.5,1.25"`);
  const number = (raw: string, label: string): number => {
    const v = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(v)) throw bad(raw.trim() === '' ? `${label} is missing` : `${label} ${JSON.stringify(raw.trim())} is not a finite number`);
    if (v < 0) throw bad(`${label} ${raw.trim()} is negative (times are seconds >= 0)`);
    return v;
  };
  if (spec.includes(':')) {
    const parts = spec.split(':');
    if (parts.length !== 3) throw bad(`expected a:b:n (start:end:count), got ${parts.length} ":"-separated parts`);
    const a = number(parts[0], 'start');
    const b = number(parts[1], 'end');
    const n = Number(parts[2].trim() === '' ? NaN : parts[2]);
    if (!Number.isInteger(n) || n < 1) throw bad(`count must be a whole number >= 1, got ${JSON.stringify(parts[2].trim())}`);
    if (n > MAX_SAMPLE_TIMES) throw bad(`${n} times is too many (max ${MAX_SAMPLE_TIMES})`);
    if (b < a) throw bad(`end ${fmtNum(b)} is before start ${fmtNum(a)}`);
    return Array.from({ length: n }, (_, i) => +(n === 1 ? a : a + ((b - a) * i) / (n - 1)).toFixed(6));
  }
  const items = spec.split(',');
  if (items.length > MAX_SAMPLE_TIMES) throw bad(`${items.length} times is too many (max ${MAX_SAMPLE_TIMES})`);
  return items.map((raw, i) => number(raw, `time ${i + 1}`));
}

export interface SampleInput {
  animation: string;
  /** Exact number of frames spread over the window. */
  frames?: number;
  /** Frames per second (default meta.fps). Ignored for sampling when `frames` is given. */
  fps?: number;
  /** Window start in animation seconds (default 0). */
  from?: number;
  /** Window end in animation seconds (default: the duration). May exceed the duration (loops wrap, others hold). */
  to?: number;
  /** Explicit sample times in animation seconds (replaces frames/fps/from/to). */
  times?: number[];
  /**
   * Looping animations only: seconds of pre-roll before the window, rounded up to whole cycles, so
   * physics is in its steady state (sampled at t + k·duration, k = ceil(warmup / duration)).
   */
  warmup?: number;
}

export interface SamplePlan {
  animation: string;
  loop: boolean;
  duration: number;
  /** Animation-local sample times (what captions, manifests and reports show). */
  times: number[];
  /** Seconds added to every time for evaluation: k whole cycles of warm-up (0 without). */
  offset: number;
  /** Global evaluation times: times + offset. */
  evalTimes: number[];
  /** Playback rate matching real time: `fps`, frames / window, or meta.fps. */
  fps: number;
  /** The samples cover exactly one loop, so the last frame is followed by the first. */
  fullLoop: boolean;
  /** End of the last frame's event interval (animation seconds): frame i covers [times[i], times[i+1]). */
  end: number;
}

/**
 * Sample times for an animation window. Looping animations sampled over exactly one cycle exclude
 * t = to (it equals t = from); other windows include both ends. Throws ApiError on bad inputs.
 */
export function planSamples(model: Model, input: SampleInput): SamplePlan {
  const anim = model.animations.find((a) => a.id === input.animation);
  if (!anim) throw new ApiError(`unknown animation "${input.animation}"`, [], idHint(String(input.animation), model.animations.map((a) => a.id), 'animations'));
  if (input.frames !== undefined && !(Number.isInteger(input.frames) && input.frames >= 1)) {
    throw new ApiError(`frames must be a whole number >= 1, got ${show(input.frames)}`, [], 'e.g. frames 8');
  }
  if (input.fps !== undefined && !(typeof input.fps === 'number' && Number.isFinite(input.fps) && input.fps > 0)) {
    throw new ApiError(`fps must be a number > 0, got ${show(input.fps)}`, [], `e.g. fps ${model.meta.fps} (the model's meta.fps)`);
  }
  let times: number[];
  let fullLoop = false;
  let fps = input.fps ?? model.meta.fps;
  let end: number;
  if (input.times !== undefined) {
    const extra = (['frames', 'fps', 'from', 'to'] as const).filter((k) => input[k] !== undefined);
    if (extra.length) throw new ApiError(`times lists the sample times itself; drop ${extra.join(', ')}`, [], 'use either times, or frames/fps with from/to');
    if (!Array.isArray(input.times) || input.times.length === 0) throw new ApiError(`times must be a non-empty list of seconds, got ${show(input.times)}`, [], 'e.g. [0, 0.5, 1]');
    if (input.times.length > MAX_SAMPLE_TIMES) throw new ApiError(`${input.times.length} times is too many (max ${MAX_SAMPLE_TIMES})`);
    times = input.times.map((t, i) => checkTime(t, `times[${i}]`));
    end = times[times.length - 1];
  } else {
    const from = checkTime(input.from ?? 0, 'from');
    const to = input.to ?? anim.duration;
    if (typeof to !== 'number' || !Number.isFinite(to)) throw new ApiError(`to must be a finite number of seconds, got ${show(to)}`, [], `e.g. to ${fmtNum(anim.duration)} (the duration of "${anim.id}")`);
    if (!(to > from)) throw new ApiError(`to (${fmtNum(to)}) must be greater than from (${fmtNum(from)})`, [], `"${anim.id}" lasts ${fmtNum(anim.duration)}s; e.g. from 0 to ${fmtNum(anim.duration)}`);
    const span = to - from;
    fullLoop = anim.loop && Math.abs(span - anim.duration) < 1e-9;
    const count = input.frames ?? Math.max(1, Math.round(span * fps) + (fullLoop ? 0 : 1));
    if (count > MAX_SAMPLE_TIMES) throw new ApiError(`${count} frames is too many (max ${MAX_SAMPLE_TIMES})`, [], 'lower fps or frames, or narrow from/to');
    times = [];
    for (let i = 0; i < count; i++) {
      const t = fullLoop || count === 1 ? from + (span * i) / count : from + (span * i) / (count - 1);
      times.push(+t.toFixed(6));
    }
    if (input.fps === undefined && input.frames !== undefined) fps = (fullLoop ? input.frames : Math.max(1, input.frames - 1)) / span;
    end = fullLoop ? to : times[times.length - 1];
  }
  let offset = 0;
  if (input.warmup !== undefined) {
    if (typeof input.warmup !== 'number' || !Number.isFinite(input.warmup) || input.warmup < 0) {
      throw new ApiError(`warmup must be a finite number of seconds >= 0, got ${show(input.warmup)}`, [], 'e.g. warmup 10');
    }
    if (!anim.loop) {
      throw new ApiError(
        `warmup only applies to looping animations: "${anim.id}" does not loop, so there is no steady state to run into`,
        [],
        'physics starts at rest at t=0; to look at later moments of a non-looping animation, sample them with from/to or times',
      );
    }
    offset = Math.max(0, Math.ceil(input.warmup / anim.duration - 1e-9)) * anim.duration;
  }
  return {
    animation: anim.id,
    loop: anim.loop,
    duration: anim.duration,
    times,
    offset,
    evalTimes: times.map((t) => +(t + offset).toFixed(6)),
    fps: Number(fps.toFixed(6)),
    fullLoop,
    end,
  };
}

/** Notes about the sampling window itself (not about the poses). */
export function samplePlanNotes(model: Model, plan: SamplePlan): string[] {
  const notes: string[] = [];
  if (plan.offset && model.physics.length === 0) notes.push('warmup changes nothing here: the model has no physics');
  const last = plan.times[plan.times.length - 1];
  if (!plan.loop && last > plan.duration + 1e-9) {
    const after = plan.times.filter((t) => t > plan.duration + 1e-9).length;
    notes.push(`"${plan.animation}" does not loop: after ${fmtNum(plan.duration)}s it holds its last pose (${after} frame${after === 1 ? ' samples' : 's sample'} that)`);
  }
  return notes;
}

/** Sample times for an animation: looping animations exclude t = duration (it equals t = 0). */
export function sequenceTimes(model: Model, input: Pick<SampleInput, 'animation' | 'fps' | 'frames'>): number[] {
  return planSamples(model, { animation: input.animation, fps: input.fps, frames: input.frames }).times;
}

/**
 * Pose options for evaluating a plan: with a warm-up offset every layer's clock is shifted by it (layers
 * without an explicit time get start += offset), so all layers show the animation-local time the
 * captions name while physics has been running since t = 0.
 */
export function planOptions(base: PoseOptions, plan: Pick<SamplePlan, 'offset'>): PoseOptions {
  if (!plan.offset) return base;
  const animations = (base.animations ?? []).map((l) => {
    const layer = typeof l === 'string' ? { id: l } : l;
    return layer.time !== undefined ? layer : { ...layer, start: (layer.start ?? 0) + plan.offset };
  });
  return { ...base, animations };
}

/** Poses at `times` with one Player (incremental physics, crossed events), lazily. */
export function* samplePoses(rig: Rig, base: PoseOptions, times: number[]): Generator<Pose> {
  const player = rig.player();
  for (const t of times) yield player.update({ ...base, time: t });
}

const EVENT_EPS = 1e-7;

/**
 * Events per sampled frame, frame i covering [times[i], times[i+1]) and the last one up to `plan.end`
 * (inclusive when the window is not a full loop). Evaluated with a separate event-only Player (physics
 * off). Unordered explicit times get the events exactly at each time instead.
 */
export function sampleEvents(rig: Rig, base: PoseOptions, plan: SamplePlan): Array<Pose['events']> {
  const cells: Array<Pose['events']> = plan.times.map(() => []);
  const layers = base.animations ?? [];
  const ids = new Set(layers.map((l) => (typeof l === 'string' ? l : l.id)));
  if (!rig.model.animations.some((a) => ids.has(a.id) && a.events?.length)) return cells;
  const opts = { ...planOptions(base, plan), physics: false };
  const T = plan.evalTimes;
  const ascending = T.every((t, i) => i === 0 || t > T[i - 1]);
  if (!ascending) {
    T.forEach((t, i) => cells[i].push(...rig.pose({ ...opts, time: t }).events));
    return cells;
  }
  const player = rig.player();
  cells[0].push(...player.update({ ...opts, time: T[0] }).events);
  for (let i = 1; i < T.length; i++) cells[i - 1].push(...player.update({ ...opts, time: T[i] - EVENT_EPS }).events);
  const last = plan.fullLoop ? plan.end + plan.offset - EVENT_EPS : plan.end + plan.offset + EVENT_EPS;
  if (last > T[T.length - 1]) cells[T.length - 1].push(...player.update({ ...opts, time: last }).events);
  return cells;
}
