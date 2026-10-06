/**
 * Volume lip sync: the loudness of a recording drives MouthOpen.
 *
 *   samples -> RMS per frame -> normalise to the loud level (a high percentile, so one click does not
 *   set the scale) -> noise gate -> loudness curve -> attack / release smoothing -> keys within a
 *   tolerance
 */
import type { LipSyncOptions, LipSyncResult, WavAudio } from './types.js';

/** Envelope frames (and at most this many keys) per second when `fps` is not given. */
export const DEFAULT_LIPSYNC_FPS = 30;
const MAX_FPS = 240;
const MIN_DURATION = 0.1;

const ENVELOPE = {
  /** RMS below this (-60 dBFS) is silence whatever the rest of the file does. */
  silence: 0.001,
  /** The loud level: this percentile of the frames that are not silent. */
  percentile: 0.95,
  /** Lowest loud level (-34 dBFS): a file of nothing but room noise must not be scaled up to speech. */
  minLevel: 0.02,
  /** Noise gate: share of the loud level below which the mouth stays shut. */
  gate: 0.1,
  /** Exponent of the loudness curve (< 1: moderate volume already opens the mouth well). */
  curve: 0.6,
  /** Time constants in seconds at smoothing = 1: the mouth opens fast and closes softly. */
  attack: 0.04,
  release: 0.16,
  /**
   * An exponential release creeps toward closed for a long time. The last quarter of the way goes at
   * a constant rate instead (a full close would take this many release time constants), so the mouth
   * is shut about 2.4 time constants after the sound ends.
   */
  glide: 4,
  /** Openings below this are shut. */
  floor: 0.02,
  /** Keys are dropped while the curve through the remaining keys stays this close (in MouthOpen units). */
  tolerance: 0.02,
} as const;

const round3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;

export interface MouthEnvelope {
  /** Frames per second: `values[i]` is the opening at `i / fps` seconds. */
  fps: number;
  /** MouthOpen 0..1 per frame. */
  values: Float32Array;
  /** Length of the audio in seconds. */
  duration: number;
}

export interface MouthEnvelopeOptions {
  /** Frames per second (default 30, at most 240). */
  fps?: number;
  /**
   * 0 = the raw envelope, 1 = slow; default 0.5. The mouth opens with a time constant of
   * 40 ms x smoothing and closes with 160 ms x smoothing (it is shut about 2.4 time constants after
   * the sound ends: 190 ms at the default).
   */
  smoothing?: number;
  /** Scale of the opening (default 1); the result stays within 0..1. */
  gain?: number;
}

function checkAudio(audio: WavAudio, who: string): void {
  if (!audio || !(audio.samples instanceof Float32Array)) throw new TypeError(`${who}: expected decoded audio ({ sampleRate, channels, samples: Float32Array }), e.g. the result of decodeWav`);
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) throw new RangeError(`${who}: the sample rate must be a positive number, got ${audio.sampleRate}`);
}

function option(value: number | undefined, fallback: number, name: string, who: string, allowZero: boolean): number {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) throw new RangeError(`${who}: "${name}" must be a number ${allowZero ? '>= 0' : '> 0'}, got ${v}`);
  return v;
}

/** Share of the distance to the target a one-pole filter covers in one step. */
function step(dt: number, timeConstant: number): number {
  return timeConstant > 0 ? 1 - Math.exp(-dt / timeConstant) : 1;
}

/**
 * The mouth opening over time for a recording: one value per frame (see the pipeline at the top of
 * this file). `lipSyncFromAudio` turns it into keys; a live player can use it directly.
 */
export function mouthEnvelope(audio: WavAudio, opts: MouthEnvelopeOptions = {}): MouthEnvelope {
  const who = 'mouthEnvelope';
  checkAudio(audio, who);
  const fps = Math.min(MAX_FPS, option(opts.fps, DEFAULT_LIPSYNC_FPS, 'fps', who, false));
  const smoothing = option(opts.smoothing, 0.5, 'smoothing', who, true);
  const gain = option(opts.gain, 1, 'gain', who, true);
  const { samples, sampleRate } = audio;
  const total = samples.length;
  const duration = total / sampleRate;
  const frames = total === 0 ? 0 : Math.floor(duration * fps + 1e-9) + 1;
  const values = new Float32Array(frames);
  if (frames === 0) return { fps, values, duration };

  // RMS of the frame-long window centred on each frame time; the windows tile the recording.
  const hop = sampleRate / fps;
  const rms = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const from = Math.max(0, Math.round((i - 0.5) * hop));
    const to = Math.min(total, Math.round((i + 0.5) * hop));
    let sum = 0;
    for (let s = from; s < to; s++) sum += samples[s] * samples[s];
    rms[i] = to > from ? Math.sqrt(sum / (to - from)) : 0;
  }

  const audible = Array.from(rms).filter((v) => v > ENVELOPE.silence).sort((a, b) => a - b);
  if (audible.length === 0) return { fps, values, duration };
  const loud = audible[Math.min(audible.length - 1, Math.max(0, Math.ceil(ENVELOPE.percentile * audible.length) - 1))];
  const level = Math.max(loud, ENVELOPE.minLevel);

  const release = ENVELOPE.release * smoothing;
  const up = step(1 / fps, ENVELOPE.attack * smoothing);
  const down = step(1 / fps, release);
  const glide = release > 0 ? 1 / fps / (ENVELOPE.glide * release) : Number.POSITIVE_INFINITY;
  let y = 0;
  for (let i = 0; i < frames; i++) {
    const gated = (rms[i] / level - ENVELOPE.gate) / (1 - ENVELOPE.gate);
    const target = gated <= 0 ? 0 : Math.pow(Math.min(1, gated), ENVELOPE.curve);
    if (target >= y) y += (target - y) * up;
    else y -= Math.min(y - target, Math.max((y - target) * down, glide));
    const open = Math.min(1, y * gain);
    values[i] = open < ENVELOPE.floor ? 0 : open;
  }
  return { fps, values, duration };
}

/** Indices of the points to keep so that linear interpolation stays within `tolerance` (Ramer-Douglas-Peucker on the value axis). */
function reducePoints(times: ArrayLike<number>, values: ArrayLike<number>, tolerance: number): number[] {
  const n = times.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const b = stack.pop() as number;
    const a = stack.pop() as number;
    let worst = -1;
    let worstError = tolerance;
    const span = times[b] - times[a];
    for (let i = a + 1; i < b; i++) {
      const error = Math.abs(values[i] - (values[a] + ((values[b] - values[a]) * (times[i] - times[a])) / span));
      if (error > worstError) {
        worstError = error;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push(a, worst, worst, b);
    }
  }
  const kept: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) kept.push(i);
  return kept;
}

/**
 * Audio loudness -> MouthOpen animation (volume lip sync): one linear track on the open parameter,
 * closed at both ends, keys at most `fps` per second and reduced within a tolerance of 0.02, times
 * and values rounded to 3 decimals. `morae` and `unknown` of the result are empty.
 */
export function lipSyncFromAudio(audio: WavAudio, opts: LipSyncOptions & { fps?: number; smoothing?: number } = {}): LipSyncResult {
  const who = 'lipSyncFromAudio';
  checkAudio(audio, who);
  const { fps, values, duration: seconds } = mouthEnvelope(audio, { fps: option(opts.fps, DEFAULT_LIPSYNC_FPS, 'fps', who, false), smoothing: option(opts.smoothing, 0.5, 'smoothing', who, true), gain: option(opts.gain, 1, 'gain', who, true) });
  const duration = Math.max(MIN_DURATION, round3(seconds));
  const openParam = opts.openParam ?? 'MouthOpen';
  if (openParam === '') throw new RangeError(`${who}: "openParam" must be a parameter id`);

  // Frame points before the end, then a closed key exactly at the end.
  const times: number[] = [];
  const opens: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const t = round3(i / fps);
    if (t >= duration) break;
    times.push(t);
    opens.push(i === 0 ? 0 : values[i]);
  }
  if (times.length === 0) {
    times.push(0);
    opens.push(0);
  }
  times.push(duration);
  opens.push(0);

  const keys: Array<{ t: number; v: number }> = [];
  for (const i of reducePoints(times, opens, ENVELOPE.tolerance)) {
    const key = { t: times[i], v: round3(opens[i]) };
    const prev = keys[keys.length - 1];
    if (prev && key.t <= prev.t) prev.v = key.v;
    else keys.push(key);
  }
  // A recording without sound is one closed key.
  const moving = keys.some((k) => k.v !== 0);
  const animation = {
    id: opts.id ?? 'lipsync',
    duration,
    loop: opts.loop ?? false,
    description: `Volume lip sync (${round3(seconds)} s of audio, ${round3(fps)} frames/s).`,
    tracks: [{ target: `param:${openParam}`, keys: moving ? keys : [{ t: 0, v: 0 }] }],
  };
  return { animation, morae: [], duration, unknown: [] };
}
