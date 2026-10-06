/**
 * Beats -> mouth motion. One model serves both outputs: `mouthCurves` lays the motion out as eased
 * keys on a beat axis, `mouthShapeAt` samples those keys (live preview, the web player) and
 * `lipSyncFromMorae` / `lipSyncFromText` write them as a Rev2D animation.
 *
 * Shape of one beat (as a share of the beat, of at most one beat's worth for long beats):
 *
 *   boundary --ease-out--> target ......hold...... target --ease-in--> boundary with the next beat
 *   0                      0.35                    0.70                 1
 *
 * The boundary lies a little toward the next shape; a repeated vowel dips instead (it re-articulates),
 * a closure or pause is entered half closed, and the sequence starts and ends closed and neutral.
 */
import { EASINGS } from '../core/easing.js';
import { textToMorae } from './text.js';
import { VISEME_SHAPES } from './types.js';
import type { LipSyncOptions, LipSyncResult, LipSyncScript, Mora, MouthShape } from './types.js';

/** Beats per second when `rate` is not given. */
export const DEFAULT_LIPSYNC_RATE = 7;

/** Shortest animation written (the schema needs a positive duration; empty text still gives a valid animation). */
const MIN_DURATION = 0.1;

const MOTION = {
  /** Share of a beat until the mouth has reached the beat's shape. */
  attack: 0.35,
  /** The same for a pause: the mouth relaxes shut more slowly than a consonant closes it. */
  restAttack: 0.7,
  /** Share at the end of a beat spent leaving its shape. */
  release: 0.3,
  /** The last beat closes completely within itself. */
  finalRelease: 0.45,
  /** How far a beat relaxes toward the next shape before that beat starts. */
  relax: 0.35,
  /** ... toward a closure or a pause. */
  closeRelax: 0.5,
  /** A repeated vowel re-articulates: the opening drops by this share between the two beats. */
  dip: 0.3,
} as const;

/** Slack for comparing key times on the beat axis. */
const EPS = 1e-9;

/** The eases the motion uses; all of them are ease names of the model schema (src/core/schema.ts). */
export type MouthEase = 'linear' | 'outCubic' | 'inSine' | 'inOutSine';

export interface MouthCurveKey {
  /** Time in beats. */
  t: number;
  v: number;
  /** Ease from this key to the next one. */
  ease: MouthEase;
}

export interface MouthCurves {
  open: MouthCurveKey[];
  form: MouthCurveKey[];
  /** Length of the sequence in beats. */
  beats: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Round to 3 decimals; never -0. */
const round3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;

/** Append one beat to a track: reach `target`, hold it, leave toward `boundary` (reached at `end`). */
function addBeat(keys: MouthCurveKey[], reach: number, leave: number, end: number, target: number, boundary: number, nextTarget: number, last: boolean): void {
  // The key the previous beat ended on starts this beat's attack.
  keys[keys.length - 1].ease = 'outCubic';
  // Leaving toward a value the motion turns around at (a dip) settles there; otherwise it accelerates
  // into the next attack.
  const turns = (boundary - target) * (nextTarget - boundary) < 0;
  const release: MouthEase = last || turns ? 'inOutSine' : 'inSine';
  keys.push({ t: reach, v: target, ease: 'linear' });
  if (leave - reach > EPS) keys.push({ t: leave, v: target, ease: release });
  else keys[keys.length - 1].ease = release;
  keys.push({ t: end, v: boundary, ease: 'linear' });
}

/** Drop keys inside and at the end of flat stretches (the last value holds), and the eases of segments that do not move. */
function simplify(keys: MouthCurveKey[]): MouthCurveKey[] {
  const out: MouthCurveKey[] = [];
  keys.forEach((key, i) => {
    const prev = out[out.length - 1];
    const next = keys[i + 1];
    if (prev && prev.v === key.v && (!next || next.v === key.v)) return;
    out.push(key);
  });
  out.forEach((key, i) => {
    if (i === out.length - 1 || out[i + 1].v === key.v) key.ease = 'linear';
  });
  return out;
}

/**
 * The mouth motion of a beat sequence as eased keys on a beat axis (divide the times by the rate for
 * seconds). `gain` scales the opening (the result stays within 0..1).
 */
export function mouthCurves(morae: readonly Mora[], gain = 1): MouthCurves {
  const seq = morae.filter((m) => Number.isFinite(m.beats) && m.beats > 0);
  const n = seq.length;
  const g = Number.isFinite(gain) && gain > 0 ? gain : 0;
  const open: number[] = [];
  const form: number[] = [];
  for (const m of seq) {
    const shape = VISEME_SHAPES[m.viseme] ?? VISEME_SHAPES.rest;
    open.push(clamp(shape.open * g, 0, 1));
    form.push(shape.form);
  }
  // A closure inside speech keeps the lips between the shapes around it instead of snapping to neutral.
  const neighbourForm = (k: number, step: -1 | 1): number => {
    for (let j = k + step; j >= 0 && j < n; j += step) if (seq[j].viseme !== 'n') return VISEME_SHAPES[seq[j].viseme]?.form ?? 0;
    return 0;
  };
  seq.forEach((m, k) => {
    if (m.viseme === 'n') form[k] = (neighbourForm(k, -1) + neighbourForm(k, 1)) / 2;
  });

  const openKeys: MouthCurveKey[] = [{ t: 0, v: 0, ease: 'linear' }];
  const formKeys: MouthCurveKey[] = [{ t: 0, v: 0, ease: 'linear' }];
  let start = 0;
  for (let k = 0; k < n; k++) {
    const length = seq[k].beats;
    const end = start + length;
    const unit = Math.min(length, 1);
    const last = k === n - 1;
    const reach = start + (seq[k].viseme === 'rest' ? MOTION.restAttack : MOTION.attack) * unit;
    const leave = Math.max(reach, end - (last ? MOTION.finalRelease : MOTION.release) * unit);
    const nextOpen = last ? 0 : open[k + 1];
    const nextForm = last ? 0 : form[k + 1];
    let boundaryOpen = 0;
    let boundaryForm = 0;
    if (!last) {
      boundaryForm = lerp(form[k], nextForm, MOTION.relax);
      if (open[k] === 0) boundaryOpen = 0;
      else if (nextOpen === 0) boundaryOpen = open[k] * (1 - MOTION.closeRelax);
      else if (seq[k + 1].viseme === seq[k].viseme) boundaryOpen = open[k] * (1 - MOTION.dip);
      else boundaryOpen = lerp(open[k], nextOpen, MOTION.relax);
    }
    addBeat(openKeys, reach, leave, end, open[k], boundaryOpen, nextOpen, last);
    addBeat(formKeys, reach, leave, end, form[k], boundaryForm, nextForm, last);
    start = end;
  }
  return { open: simplify(openKeys), form: simplify(formKeys), beats: start };
}

/** Value of a key track at time `t` (in the unit of the keys); the first / last value holds outside. */
export function sampleMouthCurve(keys: readonly MouthCurveKey[], t: number): number {
  const last = keys.length - 1;
  if (last < 0) return 0;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[last].t) return keys[last].v;
  // Invariant: keys[lo].t <= t < keys[hi].t.
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.t - a.t;
  return span > 0 ? a.v + (b.v - a.v) * EASINGS[a.ease]((t - a.t) / span) : b.v;
}

// The player asks for a shape every frame with the same array: keep its curves. The signature guards
// against an array that was edited in place.
const curveCache = new WeakMap<readonly Mora[], { signature: number; curves: MouthCurves }>();

function signature(morae: readonly Mora[]): number {
  let h = morae.length;
  for (const m of morae) {
    h = (Math.imul(h, 31) + (typeof m.viseme === 'string' ? m.viseme.charCodeAt(0) : 0)) | 0;
    h = (Math.imul(h, 31) + Math.round(m.beats * 1000)) | 0;
  }
  return h;
}

function cachedCurves(morae: readonly Mora[]): MouthCurves {
  const sig = signature(morae);
  const hit = curveCache.get(morae);
  if (hit && hit.signature === sig) return hit.curves;
  const curves = mouthCurves(morae);
  curveCache.set(morae, { signature: sig, curves });
  return curves;
}

/**
 * Mouth shape at time t (seconds) of a beat sequence played at `rate` beats per second: for live
 * preview and the web player. Closed before the start and from the end (sum of the beats / rate) on.
 * It is the motion `lipSyncFromText` writes with gain 1 (the animation rounds its keys to 3 decimals).
 */
export function mouthShapeAt(morae: Mora[], rate: number, t: number): MouthShape {
  if (!Array.isArray(morae) || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(t)) return { open: 0, form: 0 };
  const curves = cachedCurves(morae);
  const beat = t * rate;
  if (beat <= 0 || beat >= curves.beats) return { open: 0, form: 0 };
  return { open: sampleMouthCurve(curves.open, beat), form: sampleMouthCurve(curves.form, beat) };
}

interface AnimationKey {
  t: number;
  v: number;
  ease?: MouthEase;
}

/** Keys on the beat axis -> animation keys in seconds, rounded to 3 decimals, times strictly increasing. */
function animationKeys(keys: readonly MouthCurveKey[], rate: number, duration: number): AnimationKey[] {
  const rounded: MouthCurveKey[] = [];
  for (const key of keys) {
    const t = Math.min(duration, round3(key.t / rate));
    const v = round3(key.v);
    const prev = rounded[rounded.length - 1];
    // Two keys closer than the rounding step (a very high rate): the later one says where the mouth
    // is, except at t = 0, which stays closed.
    if (prev && t <= prev.t) {
      if (rounded.length > 1) {
        prev.v = v;
        prev.ease = key.ease;
      }
    } else {
      rounded.push({ t, v, ease: key.ease });
    }
  }
  return simplify(rounded).map((key) => (key.ease === 'linear' ? { t: key.t, v: key.v } : { t: key.t, v: key.v, ease: key.ease }));
}

function describe(text: string | undefined, beats: number, rate: number): string {
  const count = round3(beats);
  const tempo = `${count} ${count === 1 ? 'beat' : 'beats'} at ${round3(rate)} beats/s`;
  if (text === undefined) return `Lip sync (${tempo}).`;
  const chars = [...text.trim().replace(/\s+/gu, ' ')];
  const shown = chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : chars.join('');
  return `Lip sync of ${JSON.stringify(shown)} (${tempo}).`;
}

function buildAnimation(morae: Mora[], opts: LipSyncOptions, text: string | undefined, unknown: string[]): LipSyncResult {
  const rate = opts.rate ?? DEFAULT_LIPSYNC_RATE;
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`lip sync: "rate" must be a positive number of beats per second, got ${rate}`);
  const gain = opts.gain ?? 1;
  if (!Number.isFinite(gain) || gain < 0) throw new RangeError(`lip sync: "gain" must be a number >= 0, got ${gain}`);
  const curves = mouthCurves(morae, gain);
  const duration = Math.max(MIN_DURATION, round3(curves.beats / rate));
  const openParam = opts.openParam ?? 'MouthOpen';
  const formParam = opts.formParam ?? 'MouthForm';
  if (openParam === '') throw new RangeError('lip sync: "openParam" must be a parameter id (only "formParam" may be empty, to leave the form track out)');
  const tracks = [{ target: `param:${openParam}`, keys: animationKeys(curves.open, rate, duration) }];
  if (formParam !== '') tracks.push({ target: `param:${formParam}`, keys: animationKeys(curves.form, rate, duration) });
  const animation = {
    id: opts.id ?? 'lipsync',
    duration,
    loop: opts.loop ?? false,
    description: describe(text, curves.beats, rate),
    tracks,
  };
  return { animation, morae, duration, unknown };
}

/**
 * Beats -> animation, for beats that were prepared or edited by the caller (stretched pauses, a
 * corrected reading). Same motion and options as `lipSyncFromText`.
 */
export function lipSyncFromMorae(morae: readonly Mora[], opts: LipSyncOptions = {}): LipSyncResult {
  return buildAnimation([...morae], opts, undefined, []);
}

/**
 * Text -> animation: param tracks for the open and form parameters, starting and ending closed, with
 * times and values rounded to 3 decimals. The duration is the sum of the beats / rate (at least 0.1 s).
 * Throws a RangeError for a rate that is not a positive number.
 */
export function lipSyncFromText(text: string, opts: LipSyncOptions & { script?: LipSyncScript } = {}): LipSyncResult {
  const { morae, unknown } = textToMorae(text, opts.script ?? 'auto');
  return buildAnimation(morae, opts, text, unknown);
}
