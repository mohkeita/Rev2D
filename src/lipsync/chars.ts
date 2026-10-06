/**
 * Character classes for the text front end: which script converter a character belongs to, and how
 * long the pause of a character that is not spoken lasts.
 */

export type CharClass =
  | 'kana'
  | 'hangul'
  | 'latin'
  /** A long-vowel mark (ー ｰ 〜 ～ ~): one more beat of the previous mouth shape. */
  | 'long'
  /** A word gap: white space and the middle dot between words (ジョン・スミス). */
  | 'space'
  /** A pause inside a sentence (、 , ; : and dashes). */
  | 'comma'
  /** The end of a sentence (。 . ! ? … and line breaks). */
  | 'stop'
  | 'digit'
  | 'symbol'
  /** Invisible or combining characters: no beat, no report. */
  | 'ignore'
  /** A letter of a script that cannot be read here (kanji, Cyrillic, ...). */
  | 'unknown';

/** Lengths in beats. */
export const MORA_BEATS = {
  /** A word gap. */
  space: 0.5,
  comma: 1.5,
  stop: 3,
  /** Digits, symbols and unknown characters ("short rests"). */
  short: 0.5,
  /** Longest pause a run of pause characters adds up to ("......" is not three seconds of silence). */
  maxRest: 4,
  /** Sokuon (っ / ッ) and a doubled romaji consonant: a short closure. */
  sokuon: 0.5,
  /** Lips closing on m / b / p (a Hangul final ㅁ ㅂ ㅍ, the English-like fallback). */
  lipClose: 0.4,
} as const;

const LONG_MARKS = new Set(['ー', 'ｰ', '〜', '～', '~']);
const STOPS = new Set(['。', '．', '.', '!', '?', '！', '？', '…', '‥', '｡', '‼', '⁇', '⁈', '⁉']);
const COMMAS = new Set(['、', '，', ',', ';', '；', ':', '：', '､', '—', '–', '―']);
const WORD_DOTS = new Set(['・', '･']);

const RE_SPACE = /\s/u;
const RE_DIGIT = /\p{N}/u;
const RE_IGNORE = /[\p{M}\p{Cf}\p{Cc}]/u;
const RE_UNREADABLE = /[\p{L}\p{Co}\p{Cn}\p{Cs}]/u;

/** Hiragana, katakana (full and half width), their iteration marks and the (semi-)voiced sound marks. */
export function isKana(cp: number): boolean {
  return (
    (cp >= 0x3041 && cp <= 0x3096) || // hiragana
    (cp >= 0x3099 && cp <= 0x309e) || // sound marks, iteration marks
    (cp >= 0x30a1 && cp <= 0x30fa) || // katakana
    cp === 0x30fd ||
    cp === 0x30fe || // iteration marks
    (cp >= 0xff66 && cp <= 0xff6f) || // half-width ｦ ｧ..ｯ
    (cp >= 0xff71 && cp <= 0xff9f) // half-width ｱ..ﾝ ﾞ ﾟ
  );
}

/** Hangul syllable blocks and compatibility jamo (ㄱ..ㅣ). */
export function isHangul(cp: number): boolean {
  return (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x3131 && cp <= 0x3163);
}

/** Basic Latin letters, Latin letters with diacritics and full-width Latin letters. */
export function isLatin(cp: number): boolean {
  return (
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) ||
    (cp >= 0xc0 && cp <= 0x24f && cp !== 0xd7 && cp !== 0xf7) ||
    (cp >= 0x1e00 && cp <= 0x1eff) ||
    (cp >= 0xff21 && cp <= 0xff3a) ||
    (cp >= 0xff41 && cp <= 0xff5a)
  );
}

/** Class of one character (a whole code point). */
export function classifyChar(ch: string): CharClass {
  const cp = ch.codePointAt(0) ?? 0;
  if (LONG_MARKS.has(ch)) return 'long';
  if (isKana(cp)) return 'kana';
  if (isHangul(cp)) return 'hangul';
  if (isLatin(cp)) return 'latin';
  if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') return 'stop';
  if (RE_SPACE.test(ch) || WORD_DOTS.has(ch)) return 'space';
  if (STOPS.has(ch)) return 'stop';
  if (COMMAS.has(ch)) return 'comma';
  if (RE_DIGIT.test(ch)) return 'digit';
  if (RE_IGNORE.test(ch)) return 'ignore';
  if (RE_UNREADABLE.test(ch)) return 'unknown';
  return 'symbol';
}
