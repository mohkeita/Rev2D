/**
 * Latin text -> beats, one word at a time. A word that parses completely as romaji (Hepburn, Kunrei
 * and the usual typing variants) gives the same beats as its kana; any other word goes through an
 * English-like fallback: every vowel group is a beat and m / b / p close the lips.
 */
import { MORA_BEATS } from './chars.js';
import type { Mora } from './types.js';

type Vowel = 'a' | 'i' | 'u' | 'e' | 'o';

/** One normalised letter and the source text it came from ("ō" -> o, long; "ß" -> s + s). */
interface Unit {
  /** Source characters (empty for the second letter of an expanded character). */
  src: string;
  /** A lower-case ASCII letter, "'" for a separator (apostrophe, hyphen), or "?" for anything else. */
  ch: string;
  /** A vowel written with a macron or circumflex: two beats. */
  long: boolean;
  /** Written with a diacritic (é): such a letter is never silent. */
  marked: boolean;
}

/** Apostrophes (U+0027, U+2019, U+02BC) and hyphens (U+002D, U+2010) that may sit between the letters of a word. */
const SEPARATORS = new Set(["'", '’', 'ʼ', '-', '‐']);
const EXPANSIONS: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i', ŋ: 'n' };
const MACRON = '\u0304';
const CIRCUMFLEX = '\u0302';

const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);
const isVowel = (c: string | undefined): c is Vowel => c !== undefined && VOWELS.has(c);
const isLetter = (c: string | undefined): boolean => c !== undefined && c.length === 1 && c >= 'a' && c <= 'z';
const isConsonant = (c: string | undefined): boolean => isLetter(c) && !VOWELS.has(c as string);

/** Whether a character may join the letters of a word (between two letters). */
export function isWordSeparator(ch: string): boolean {
  return SEPARATORS.has(ch);
}

function toUnits(word: string): Unit[] {
  const units: Unit[] = [];
  for (const src of word) {
    if (SEPARATORS.has(src)) {
      units.push({ src, ch: "'", long: false, marked: false });
      continue;
    }
    const cp = src.codePointAt(0) ?? 0;
    // Full-width letters sit at a fixed distance from ASCII.
    const narrow = (cp >= 0xff21 && cp <= 0xff3a) || (cp >= 0xff41 && cp <= 0xff5a) ? String.fromCodePoint(cp - 0xfee0) : src;
    const lower = narrow.toLowerCase();
    const decomposed = (EXPANSIONS[lower] ?? lower).normalize('NFD');
    const long = decomposed.includes(MACRON) || decomposed.includes(CIRCUMFLEX);
    const letters = [...decomposed].filter((c) => isLetter(c));
    if (letters.length === 0) {
      units.push({ src, ch: '?', long: false, marked: false });
      continue;
    }
    const marked = letters.length < [...decomposed].length;
    letters.forEach((ch, i) => units.push({ src: i === 0 ? src : '', ch, long: long && VOWELS.has(ch), marked }));
  }
  return units;
}

// ------------------------------------------------------------------------------------------ romaji

/** Consonant spellings that can start a romaji syllable (each followed by a vowel). */
const ROMAJI_ONSETS = new Set([
  'k', 'g', 's', 'z', 't', 'd', 'n', 'h', 'b', 'p', 'm', 'y', 'r', 'w', 'f', 'j', 'v',
  'ky', 'gy', 'sh', 'sy', 'zy', 'jy', 'ch', 'ty', 'cy', 'dy', 'ny', 'hy', 'by', 'py', 'my', 'ry', 'fy', 'vy', 'ts', 'dz',
]);

/**
 * Parse a whole word as romaji; null when any part of it is not romaji.
 * - consonant(s) + vowel = one beat with that vowel (ka, shi, tsu, kya); a vowel alone is a beat;
 * - "n" (also "n'", "nn", and "m" before b / p / m) not followed by a vowel or y is the moraic n;
 * - a doubled consonant (kitte, zasshi, matcha) starts with a short closure;
 * - a vowel with a macron or circumflex (ō) lasts two beats.
 */
function romajiToMorae(units: Unit[]): Mora[] | null {
  const out: Mora[] = [];
  const n = units.length;
  const at = (i: number): string | undefined => (i < n ? units[i].ch : undefined);
  const text = (from: number, to: number): string => {
    let s = '';
    for (let k = from; k < to; k++) s += units[k].src;
    return s;
  };
  let lead = '';
  let i = 0;
  while (i < n) {
    const c = at(i);
    if (c === "'") {
      if (out.length > 0) out[out.length - 1].text += units[i].src;
      else lead += units[i].src;
      i++;
      continue;
    }
    const start = i;
    let mora: Mora | undefined;
    const next = at(i + 1);
    if (isVowel(c)) {
      mora = { text: text(i, i + 1), viseme: c, beats: units[i].long ? 2 : 1 };
      i += 1;
    } else if (c === 'n' && !isVowel(next) && next !== 'y') {
      // "nn" typed for one ん: the second n does not start a syllable either.
      const double = next === 'n' && !isVowel(at(i + 2)) && at(i + 2) !== 'y';
      i += double ? 2 : 1;
      mora = { text: text(start, i), viseme: 'n', beats: 1 };
    } else if (c === 'm' && (next === 'b' || next === 'p' || next === 'm')) {
      i += 1;
      mora = { text: text(start, i), viseme: 'n', beats: 1 };
    } else if (isConsonant(c) && (next === c || (c === 't' && next === 'c' && at(i + 2) === 'h'))) {
      i += 1;
      mora = { text: text(start, i), viseme: 'n', beats: MORA_BEATS.sokuon };
    } else {
      for (let len = 2; len >= 1 && !mora; len--) {
        const onset = units.slice(i, i + len).map((u) => u.ch).join('');
        const vowel = at(i + len);
        if (ROMAJI_ONSETS.has(onset) && isVowel(vowel)) {
          mora = { text: text(i, i + len + 1), viseme: vowel, beats: units[i + len].long ? 2 : 1 };
          i += len + 1;
        }
      }
      if (!mora) return null;
    }
    if (lead) {
      mora.text = lead + mora.text;
      lead = '';
    }
    out.push(mora);
  }
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------------------- fallback

/** Vowel groups whose usual English sound is not the mouth shape of their first letter. */
const VOWEL_GROUPS: Record<string, Vowel> = {
  ai: 'e', ay: 'e', au: 'o', aw: 'o',
  ea: 'i', ee: 'i', ei: 'e', ey: 'e', eu: 'u', ew: 'u',
  ie: 'i',
  oa: 'o', oe: 'o', oi: 'o', oy: 'o', oo: 'u', ou: 'a', ow: 'o',
  ue: 'u', ui: 'u',
};
const LIP_LETTERS = new Set(['m', 'b', 'p']);

function groupViseme(group: string): Vowel {
  if (group.startsWith('eau')) return 'o';
  const known = VOWEL_GROUPS[group.slice(0, 2)];
  if (known) return known;
  const first = group[0];
  return isVowel(first) ? first : 'i'; // a group can only start with a vowel letter or "y"
}

/**
 * English-like reading of a word that is not romaji: each group of vowel letters is one beat (y and w
 * count as vowels where they are pronounced as one: "my", "day", "now"), a silent final e is skipped
 * ("like" is one beat, "table" two, "café" two), and a run of m / b / p is a short closure of the lips. Other
 * consonants only add their letters to the text of the beat they belong to.
 */
function englishToMorae(units: Unit[]): Mora[] {
  const s = units.map((u) => u.ch);
  const n = s.length;
  const vowelAt = (i: number): boolean => {
    const c = s[i];
    const prev = i > 0 ? s[i - 1] : undefined;
    const next = i + 1 < n ? s[i + 1] : undefined;
    if (c === 'u' && prev === 'q' && isVowel(next)) return false; // "queen": the u is a glide
    if (isVowel(c)) return true;
    if (c === 'y') return i > 0 && !isVowel(next);
    if (c === 'w') return isVowel(prev) && !isVowel(next);
    return false;
  };
  const text = (from: number, to: number): string => {
    let t = '';
    for (let k = from; k < to; k++) t += units[k].src;
    return t;
  };
  const out: Mora[] = [];
  let pending = '';
  let vowelBeats = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    if (vowelAt(i)) {
      while (j < n && vowelAt(j)) j++;
      const group = s.slice(i, j).join('');
      const before = i > 0 ? s[i - 1] : undefined;
      const syllabicLe = before === 'l' && i > 1 && isConsonant(s[i - 2]);
      const silent = j === n && group === 'e' && !units[i].marked && vowelBeats > 0 && isConsonant(before) && !syllabicLe;
      if (silent) {
        pending += text(i, j);
      } else {
        out.push({ text: pending + text(i, j), viseme: groupViseme(group), beats: 1 });
        pending = '';
        vowelBeats++;
      }
    } else if (LIP_LETTERS.has(s[i])) {
      while (j < n && LIP_LETTERS.has(s[j])) j++;
      out.push({ text: pending + text(i, j), viseme: 'n', beats: MORA_BEATS.lipClose });
      pending = '';
    } else {
      j = i + 1;
      pending += units[i].src;
    }
    i = j;
  }
  if (pending) {
    if (out.length > 0) out[out.length - 1].text += pending;
    else out.push({ text: pending, viseme: 'rest', beats: MORA_BEATS.short });
  }
  return out;
}

/** One word of Latin letters (apostrophes and hyphens inside it allowed) -> beats: romaji first, else the English-like fallback. */
export function latinToMorae(word: string): Mora[] {
  const units = toUnits(word);
  return romajiToMorae(units) ?? englishToMorae(units);
}

/** Whether a word reads as romaji (every letter belongs to a romaji syllable). */
export function isRomaji(word: string): boolean {
  return romajiToMorae(toUnits(word)) !== null;
}
