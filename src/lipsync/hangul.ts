/**
 * Korean Hangul -> beats. A syllable block is decomposed arithmetically (initial x 588 + medial x 28 +
 * final); the medial vowel gives the mouth shape, and a final consonant that closes the lips adds a
 * short closed beat.
 */
import { MORA_BEATS } from './chars.js';
import type { Mora, Viseme } from './types.js';

const SYLLABLE_BASE = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const MEDIALS = 21;
const FINALS = 28;

/**
 * Mouth shape of the 21 medial vowels, in Unicode order:
 * ㅏ ㅐ ㅑ ㅒ ㅓ ㅔ ㅕ ㅖ ㅗ ㅘ ㅙ ㅚ ㅛ ㅜ ㅝ ㅞ ㅟ ㅠ ㅡ ㅢ ㅣ.
 * ㅓ ㅕ ㅝ are an open "o"; ㅡ has no rounding but the same narrow opening as "u".
 */
const MEDIAL_VISEMES: readonly Viseme[] = [
  'a', 'e', 'a', 'e', 'o', 'e', 'o', 'e', 'o', 'a', 'e', 'e', 'o', 'u', 'o', 'e', 'i', 'u', 'u', 'i', 'i',
];

/** Final consonants (index 0 = none) in Unicode order, as compatibility jamo. */
const FINAL_JAMO = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
/** Finals pronounced with closed lips: ㅁ ㅂ ㅍ and the clusters that end up as one of them (ㄻ, ㄿ, ㅄ). */
const LIP_FINALS = new Set(['ㅁ', 'ㅂ', 'ㅍ', 'ㄻ', 'ㄿ', 'ㅄ']);
/** Stand-alone consonant jamo that close the lips. */
const LIP_JAMO = new Set(['ㅁ', 'ㅂ', 'ㅃ', 'ㅍ']);

const JAMO_VOWEL_FIRST = 0x314f; // ㅏ
const JAMO_VOWEL_LAST = 0x3163; // ㅣ

export interface HangulSyllable {
  /** Indices into the Unicode jamo orders: 19 initials, 21 medials, 28 finals (0 = no final). */
  initial: number;
  medial: number;
  final: number;
}

/** Decompose one syllable block (가..힣); undefined for anything else. */
export function decomposeHangul(ch: string): HangulSyllable | undefined {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < SYLLABLE_BASE || cp > SYLLABLE_LAST) return undefined;
  const index = cp - SYLLABLE_BASE;
  return {
    initial: Math.floor(index / (MEDIALS * FINALS)),
    medial: Math.floor((index % (MEDIALS * FINALS)) / FINALS),
    final: index % FINALS,
  };
}

/**
 * A run of Hangul -> beats: one beat per syllable block with the shape of its medial vowel, plus a
 * short closed "n" beat when the final consonant closes the lips (밥 = a + closure). Stand-alone
 * jamo: a vowel is a beat, ㅁ ㅂ ㅃ ㅍ a closure, any other consonant (ㅋㅋㅋ) a short rest.
 */
export function hangulToMorae(run: string): Mora[] {
  const out: Mora[] = [];
  for (const ch of run) {
    const syllable = decomposeHangul(ch);
    if (syllable) {
      out.push({ text: ch, viseme: MEDIAL_VISEMES[syllable.medial], beats: 1 });
      const final = FINAL_JAMO[syllable.final];
      if (LIP_FINALS.has(final)) out.push({ text: final, viseme: 'n', beats: MORA_BEATS.lipClose });
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= JAMO_VOWEL_FIRST && cp <= JAMO_VOWEL_LAST) out.push({ text: ch, viseme: MEDIAL_VISEMES[cp - JAMO_VOWEL_FIRST], beats: 1 });
    else if (LIP_JAMO.has(ch)) out.push({ text: ch, viseme: 'n', beats: MORA_BEATS.lipClose });
    else out.push({ text: ch, viseme: 'rest', beats: MORA_BEATS.short });
  }
  return out;
}
