import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Rig } from '../../core/rig.js';
import { AnimationSchema } from '../../core/schema.js';
import { formatDiagnostics, validateModel } from '../../core/validate.js';
import { applyOps } from '../../ops/index.js';
import { DEFAULT_LIPSYNC_FPS, decodeWav, lipSyncFromAudio, mouthEnvelope, type LipSyncResult, type WavAudio } from '../index.js';
import { encodeWav, join, mix, noise, silence, tone } from './fixtures.js';

const RATE = 16000;
const audio = (samples: Float32Array, sampleRate = RATE): WavAudio => ({ sampleRate, channels: 1, samples });

interface Key {
  t: number;
  v: number;
  ease?: unknown;
}
const keysOf = (r: LipSyncResult): Key[] => (r.animation as unknown as { tracks: Array<{ keys: Key[] }> }).tracks[0].keys;
const meta = (r: LipSyncResult) => r.animation as unknown as { id: string; duration: number; loop: boolean; description: string; tracks: Array<{ target: string }> };

/** Linear interpolation through animation keys (what the rig plays for keys without an ease). */
function playKeys(keys: Key[], t: number): number {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) return keys[i - 1].v + ((keys[i].v - keys[i - 1].v) * (t - keys[i - 1].t)) / (keys[i].t - keys[i - 1].t);
  }
  return keys[keys.length - 1].v;
}

/** 0.3 s silence, 0.4 s loud tone, 0.4 s silence, 0.4 s tone at a third of the level, 0.5 s silence. */
const speech = (level = 0.6): Float32Array =>
  join(silence(RATE, 0.3), tone(RATE, 0.4, level), silence(RATE, 0.4), tone(RATE, 0.4, level / 3), silence(RATE, 0.5));
const frame = (seconds: number): number => Math.round(seconds * DEFAULT_LIPSYNC_FPS);

describe('mouthEnvelope', () => {
  it('has one value per frame over the length of the audio', () => {
    const env = mouthEnvelope(audio(speech()));
    expect(env.fps).toBe(30);
    expect(env.duration).toBeCloseTo(2, 9);
    expect(env.values).toBeInstanceOf(Float32Array);
    expect(env.values.length).toBe(61); // frames at 0, 1/30 .. 2
    expect(mouthEnvelope(audio(speech()), { fps: 60 }).values.length).toBe(121);
    expect(mouthEnvelope(audio(speech()), { fps: 12.5 }).values.length).toBe(26);
  });

  it('follows the loudness: open in the tones, closed in the gaps', () => {
    const { values } = mouthEnvelope(audio(speech()));
    // loud tone 0.3 .. 0.7 s
    for (let f = frame(0.4); f <= frame(0.65); f++) expect(values[f], `frame ${f}`).toBeGreaterThan(0.9);
    // quieter tone 1.1 .. 1.5 s: clearly open, clearly less
    for (let f = frame(1.25); f <= frame(1.45); f++) {
      expect(values[f], `frame ${f}`).toBeGreaterThan(0.25);
      expect(values[f], `frame ${f}`).toBeLessThan(0.7);
    }
    // silence: before the first tone, late in the gap, at the end
    for (const f of [0, frame(0.2), frame(1.0), frame(1.05), frame(1.9), 60]) expect(values[f], `frame ${f}`).toBe(0);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('normalises to the loud level: the same recording at a tenth of the volume gives the same motion', () => {
    const loud = mouthEnvelope(audio(speech(0.6))).values;
    const quiet = mouthEnvelope(audio(speech(0.06))).values;
    expect(quiet.length).toBe(loud.length);
    for (let i = 0; i < loud.length; i++) expect(quiet[i]).toBeCloseTo(loud[i], 4);
  });

  it('uses a high percentile, so one click does not set the scale', () => {
    const signal = join(silence(RATE, 0.2), tone(RATE, 2, 0.1), silence(RATE, 0.2));
    // A full-scale click of 10 ms in the middle of the tone.
    signal.fill(1, RATE * 1.2, RATE * 1.2 + 160);
    const { values } = mouthEnvelope(audio(signal));
    for (const t of [0.5, 0.9, 1.6, 2.0]) expect(values[frame(t)], `at ${t}s`).toBeGreaterThan(0.9);
  });

  it('gates noise below the speech level', () => {
    // Tone with a noise floor 26 dB below it everywhere.
    const signal = mix(speech(0.6), noise(RATE, 2, 0.03));
    const { values } = mouthEnvelope(audio(signal));
    expect(values[frame(0.5)]).toBeGreaterThan(0.9);
    for (const f of [0, frame(0.15), frame(1.0), frame(1.9)]) expect(values[f], `frame ${f}`).toBe(0);
  });

  it('does not turn room noise into speech', () => {
    expect(Array.from(mouthEnvelope(audio(noise(RATE, 1, 0.003))).values).every((v) => v === 0)).toBe(true);
    expect(Array.from(mouthEnvelope(audio(silence(RATE, 1))).values).every((v) => v === 0)).toBe(true);
  });

  it('opens fast and closes softly (attack / release)', () => {
    const signal = join(silence(RATE, 0.5), tone(RATE, 0.5, 0.5), silence(RATE, 1));
    const { values } = mouthEnvelope(audio(signal), { smoothing: 1 });
    const on = frame(0.5);
    const off = frame(1.0);
    // Two frames after the onset the mouth is open; two frames after the end it is still half open.
    expect(values[on + 2]).toBeGreaterThan(0.75);
    expect(values[off + 2]).toBeGreaterThan(0.4);
    // The release decays monotonically to closed.
    for (let f = off + 1; f < values.length; f++) expect(values[f]).toBeLessThanOrEqual(values[f - 1]);
    expect(values[values.length - 1]).toBe(0);
    const risen = values.findIndex((v) => v > 0.8) - on;
    const fallen = values.findIndex((v, f) => f > off && v < 0.2) - off;
    expect(fallen).toBeGreaterThan(risen);
  });

  it('smoothing 0 is the raw envelope; more smoothing closes later', () => {
    const signal = join(silence(RATE, 0.5), tone(RATE, 0.5, 0.5), silence(RATE, 1));
    const off = frame(1.0);
    const raw = mouthEnvelope(audio(signal), { smoothing: 0 }).values;
    const soft = mouthEnvelope(audio(signal), { smoothing: 0.5 }).values;
    const slow = mouthEnvelope(audio(signal), { smoothing: 1 }).values;
    expect(raw[off + 1]).toBe(0);
    expect(raw[frame(0.75)]).toBeGreaterThan(0.99);
    expect(soft[off + 2]).toBeGreaterThan(raw[off + 2]);
    expect(slow[off + 2]).toBeGreaterThan(soft[off + 2]);
    // The default is 0.5.
    expect(Array.from(mouthEnvelope(audio(signal)).values)).toEqual(Array.from(soft));
  });

  it('gain scales the opening and stays within 0..1', () => {
    const half = mouthEnvelope(audio(speech()), { gain: 0.5 }).values;
    const double = mouthEnvelope(audio(speech()), { gain: 2 }).values;
    expect(Math.max(...half)).toBeLessThanOrEqual(0.5);
    expect(Math.max(...half)).toBeGreaterThan(0.45);
    expect(Math.max(...double)).toBe(1);
    expect(double[frame(1.35)]).toBeGreaterThan(mouthEnvelope(audio(speech())).values[frame(1.35)]);
  });

  it('does not depend on the sample rate', () => {
    const at = (rate: number) => mouthEnvelope(audio(join(silence(rate, 0.3), tone(rate, 0.4, 0.5), silence(rate, 0.3)), rate)).values;
    const a = at(8000);
    const b = at(48000);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i]), `frame ${i}`).toBeLessThan(0.05);
  });

  it('empty audio has no frames', () => {
    expect(mouthEnvelope(audio(new Float32Array(0)))).toEqual({ fps: 30, values: new Float32Array(0), duration: 0 });
  });

  it('rejects bad input with a clear message', () => {
    expect(() => mouthEnvelope({ sampleRate: 16000, channels: 1, samples: [0, 1] as unknown as Float32Array })).toThrow(/expected decoded audio/);
    expect(() => mouthEnvelope(undefined as unknown as WavAudio)).toThrow(TypeError);
    expect(() => mouthEnvelope(audio(silence(RATE, 0.1), 0))).toThrow(/sample rate must be a positive number, got 0/);
    expect(() => mouthEnvelope(audio(silence(RATE, 0.1)), { fps: 0 })).toThrow(/"fps" must be a number > 0, got 0/);
    expect(() => mouthEnvelope(audio(silence(RATE, 0.1)), { fps: Number.NaN })).toThrow(RangeError);
    expect(() => mouthEnvelope(audio(silence(RATE, 0.1)), { smoothing: -1 })).toThrow(/"smoothing" must be a number >= 0/);
    expect(() => mouthEnvelope(audio(silence(RATE, 0.1)), { gain: -2 })).toThrow(/"gain"/);
    // A frame rate beyond 240 is capped, not an error.
    expect(mouthEnvelope(audio(silence(RATE, 0.1)), { fps: 10000 }).fps).toBe(240);
  });
});

describe('lipSyncFromAudio', () => {
  it('writes one linear MouthOpen track that starts and ends closed', () => {
    const r = lipSyncFromAudio(audio(speech()));
    expect(meta(r)).toMatchObject({ id: 'lipsync', duration: 2, loop: false, description: 'Volume lip sync (2 s of audio, 30 frames/s).' });
    expect(meta(r).tracks.map((t) => t.target)).toEqual(['param:MouthOpen']);
    expect(r.duration).toBe(2);
    expect(r.morae).toEqual([]);
    expect(r.unknown).toEqual([]);
    const keys = keysOf(r);
    expect(keys[0]).toEqual({ t: 0, v: 0 });
    expect(keys[keys.length - 1]).toEqual({ t: 2, v: 0 });
    keys.forEach((k, i) => {
      expect(Object.keys(k)).toEqual(['t', 'v']);
      expect(Math.round(k.t * 1000) / 1000).toBe(k.t);
      expect(Math.round(k.v * 1000) / 1000).toBe(k.v);
      expect(k.v).toBeGreaterThanOrEqual(0);
      expect(k.v).toBeLessThanOrEqual(1);
      if (i > 0) expect(k.t).toBeGreaterThan(keys[i - 1].t);
    });
    expect(AnimationSchema.safeParse(r.animation).success).toBe(true);
  });

  it('reduces the keys and stays within the tolerance of the envelope', () => {
    const signal = audio(speech());
    const { values, fps } = mouthEnvelope(signal);
    const keys = keysOf(lipSyncFromAudio(signal));
    // Two tones with flat tops: far fewer keys than frames.
    expect(keys.length).toBeLessThan(values.length / 2);
    expect(keys.length).toBeGreaterThanOrEqual(8);
    // Frame 0 and the end are forced closed; everywhere else the keys follow the envelope.
    for (let f = 1; f < values.length - 1; f++) {
      expect(Math.abs(playKeys(keys, f / fps) - values[f]), `frame ${f}`).toBeLessThanOrEqual(0.02 + 0.002);
    }
  });

  it('a steady sound needs only a handful of keys', () => {
    const keys = keysOf(lipSyncFromAudio(audio(join(silence(RATE, 0.5), tone(RATE, 3, 0.5), silence(RATE, 0.5)))));
    expect(keys.length).toBeLessThanOrEqual(16);
    expect(playKeys(keys, 2)).toBeGreaterThan(0.95);
  });

  it('silence is one closed key', () => {
    const r = lipSyncFromAudio(audio(silence(RATE, 1.5)));
    expect(keysOf(r)).toEqual([{ t: 0, v: 0 }]);
    expect(r.duration).toBe(1.5);
    const empty = lipSyncFromAudio(audio(new Float32Array(0)));
    expect(keysOf(empty)).toEqual([{ t: 0, v: 0 }]);
    expect(empty.duration).toBe(0.1);
    expect(AnimationSchema.safeParse(empty.animation).success).toBe(true);
  });

  it('closes at the end even when the recording stops mid-sound', () => {
    const r = lipSyncFromAudio(audio(tone(RATE, 0.5, 0.5)));
    const keys = keysOf(r);
    expect(keys[0]).toEqual({ t: 0, v: 0 });
    expect(keys[keys.length - 1]).toEqual({ t: 0.5, v: 0 });
    expect(playKeys(keys, 0.25)).toBeGreaterThan(0.9);
  });

  it('options: id, parameter, loop, gain, fps, smoothing', () => {
    const r = lipSyncFromAudio(audio(speech()), { id: 'voice', openParam: 'Jaw', loop: true, gain: 0.5, fps: 60, smoothing: 0 });
    expect(meta(r)).toMatchObject({ id: 'voice', loop: true, description: 'Volume lip sync (2 s of audio, 60 frames/s).' });
    expect(meta(r).tracks.map((t) => t.target)).toEqual(['param:Jaw']);
    expect(Math.max(...keysOf(r).map((k) => k.v))).toBe(0.5);
    // 60 frames per second: keys may sit on the finer grid.
    expect(keysOf(r).some((k) => Math.abs(k.t * 30 - Math.round(k.t * 30)) > 0.01)).toBe(true);
    expect(() => lipSyncFromAudio(audio(speech()), { fps: -5 })).toThrow(/lipSyncFromAudio: "fps" must be a number > 0, got -5/);
    expect(() => lipSyncFromAudio({} as WavAudio)).toThrow(/lipSyncFromAudio: expected decoded audio/);
    expect(() => lipSyncFromAudio(audio(speech()), { openParam: '' })).toThrow(/"openParam" must be a parameter id/);
  });

  it('a duration that is not a whole number of frames', () => {
    const r = lipSyncFromAudio(audio(tone(RATE, 0.3517, 0.5)));
    const keys = keysOf(r);
    expect(r.duration).toBe(0.352);
    expect(keys[keys.length - 1]).toEqual({ t: 0.352, v: 0 });
    keys.forEach((k, i) => {
      if (i > 0) expect(k.t).toBeGreaterThan(keys[i - 1].t);
    });
  });

  it('is deterministic', () => {
    const signal = mix(speech(), noise(RATE, 2, 0.01, 7));
    expect(JSON.stringify(lipSyncFromAudio(audio(signal)))).toBe(JSON.stringify(lipSyncFromAudio(audio(signal.slice()))));
  });

  it('WAV bytes -> animation -> examples/hana: validates and opens the mouth in the tones', () => {
    const wav = encodeWav({ sampleRate: RATE, channels: [speech(), speech()], bits: 16 });
    const decoded = decodeWav(wav);
    expect(decoded.channels).toBe(2);
    const result = lipSyncFromAudio(decoded);
    // 16-bit quantisation does not change the motion.
    const direct = keysOf(lipSyncFromAudio(audio(speech())));
    expect(keysOf(result).length).toBe(direct.length);
    keysOf(result).forEach((k, i) => {
      expect(k.t).toBe(direct[i].t);
      expect(Math.abs(k.v - direct[i].v)).toBeLessThanOrEqual(0.002);
    });

    const hana = JSON.parse(readFileSync(fileURLToPath(new URL('../../../examples/hana/hana.r2d.json', import.meta.url)), 'utf8'));
    const applied = applyOps(hana, [{ op: 'add', kind: 'animation', value: result.animation }], { validate: false });
    expect(applied.ok, applied.results.map((r) => `${r.message} ${r.hint ?? ''}`).join('; ')).toBe(true);
    const { model, diagnostics } = validateModel(applied.doc);
    const problems = diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warning');
    expect(problems, formatDiagnostics(problems)).toEqual([]);
    const rig = new Rig(model!);
    const open = (time: number) => rig.pose({ animations: ['lipsync'], time, physics: false }).params.MouthOpen;
    expect(open(0)).toBe(0);
    expect(open(0.5)).toBeGreaterThan(0.9);
    expect(open(1.0)).toBe(0);
    expect(open(1.3)).toBeGreaterThan(0.25);
    expect(open(2)).toBe(0);
  });
});
