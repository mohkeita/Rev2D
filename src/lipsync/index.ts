/**
 * Lip sync: text (kana, Hangul, romaji / Latin) or an audio envelope -> mouth animation on the
 * standard mouth parameters (MouthOpen, MouthForm). Pure (browser-safe): the editor and the web
 * player use it for live preview, the CLI / MCP use it to write animations.
 *
 *   textToMorae(text, script?)            text -> beats with a mouth shape each (+ unknown characters)
 *   lipSyncFromText(text, opts?)          text -> { animation, morae, duration, unknown }
 *   lipSyncFromMorae(morae, opts?)        prepared / edited beats -> the same result
 *   mouthShapeAt(morae, rate, t)          the same motion at a time, for live preview and the player
 *   moraeBeats(morae)                     length in beats (duration in seconds = beats / rate)
 *   decodeWav(bytes)                      PCM WAV -> mono samples
 *   lipSyncFromAudio(audio, opts?)        loudness -> a MouthOpen animation
 *   mouthEnvelope(audio, opts?)           loudness -> MouthOpen per frame (what lipSyncFromAudio keys)
 *
 * Files: types.ts (contracts, the viseme table) · chars.ts (character classes, pause lengths) ·
 * kana.ts / hangul.ts / latin.ts (one converter per script) · text.ts (textToMorae) · motion.ts
 * (beats -> eased keys -> animation / live shape) · wav.ts (decodeWav) · audio.ts (volume lip sync).
 */
export { VISEME_SHAPES } from './types.js';
export type { Viseme, MouthShape, Mora, LipSyncScript, TextToMoraeResult, LipSyncOptions, LipSyncResult, WavAudio } from './types.js';
export { textToMorae, moraeBeats } from './text.js';
export { MORA_BEATS } from './chars.js';
export {
  DEFAULT_LIPSYNC_RATE,
  lipSyncFromText,
  lipSyncFromMorae,
  mouthShapeAt,
  mouthCurves,
  sampleMouthCurve,
  type MouthCurves,
  type MouthCurveKey,
  type MouthEase,
} from './motion.js';
export { decodeWav } from './wav.js';
export { DEFAULT_LIPSYNC_FPS, lipSyncFromAudio, mouthEnvelope, type MouthEnvelope, type MouthEnvelopeOptions } from './audio.js';
