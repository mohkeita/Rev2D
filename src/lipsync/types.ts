/**
 * Lip-sync contracts: mouth shapes (visemes), beats (morae) and the options / results of the
 * generators. Everything here is re-exported by ./index.ts, the public entry point.
 */

/** Mouth shapes: the five vowels, "n" (closed, e.g. Japanese ん / a closing consonant) and "rest" (pause). */
export type Viseme = 'a' | 'i' | 'u' | 'e' | 'o' | 'n' | 'rest';

export interface MouthShape {
  /** MouthOpen 0..1. */
  open: number;
  /** MouthForm -1 (narrow / round) .. +1 (wide / smile). */
  form: number;
}

/** (open, form) per viseme; the avatar builder places its drawn mouth sprites on the same table. */
export const VISEME_SHAPES: Record<Viseme, MouthShape> = {
  a: { open: 1, form: 0 },
  i: { open: 0.35, form: 1 },
  u: { open: 0.35, form: -1 },
  e: { open: 0.6, form: 0.5 },
  o: { open: 0.75, form: -1 },
  n: { open: 0, form: 0 },
  rest: { open: 0, form: 0 },
};

export interface Mora {
  /**
   * Source text of this beat (e.g. "こ", "きゃ", "ラー", "안", "ka"). Informational: a mark that only
   * lengthens a beat (ー, a small same-vowel kana) is appended to that beat's text, a run of pause
   * characters is one rest, and the closing beat of a Hangul final consonant carries its jamo ("ㅁ").
   */
  text: string;
  viseme: Viseme;
  /** Length in beats (1 = one mora / syllable; long vowels and pauses may differ). */
  beats: number;
}

export type LipSyncScript = 'auto' | 'kana' | 'hangul' | 'latin';

export interface TextToMoraeResult {
  morae: Mora[];
  /** Characters that could not be mapped (they become short rests): each distinct character once, in order of appearance. */
  unknown: string[];
}

export interface LipSyncOptions {
  /** Beats per second (default 7; natural speech is roughly 4-12). */
  rate?: number;
  /** Parameter ids (defaults "MouthOpen" / "MouthForm"). `formParam: ""` leaves the form track out (models without a MouthForm). */
  openParam?: string;
  formParam?: string;
  /** Animation id (default "lipsync"). */
  id?: string;
  /** Default false: speech is a one-shot. A looping result closes its seam (it starts and ends closed). */
  loop?: boolean;
  /** Scale of the opening (default 1); the result stays within 0..1. */
  gain?: number;
}

export interface LipSyncResult {
  /** Raw Rev2D animation JSON (param tracks on the mouth parameters). */
  animation: Record<string, unknown>;
  morae: Mora[];
  /** Seconds; equal to `animation.duration`. */
  duration: number;
  unknown: string[];
}

export interface WavAudio {
  sampleRate: number;
  channels: number;
  /** Mono mix, -1..1. */
  samples: Float32Array;
}
