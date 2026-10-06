/**
 * Text -> beats: splits the text into runs of one script, hands each run to its converter and turns
 * everything that is not spoken (punctuation, spaces, digits, symbols, unreadable letters) into rests.
 */
import { MORA_BEATS, classifyChar, type CharClass } from './chars.js';
import { hangulToMorae } from './hangul.js';
import { kanaToMorae } from './kana.js';
import { isWordSeparator, latinToMorae } from './latin.js';
import type { LipSyncScript, Mora, TextToMoraeResult } from './types.js';

const SCRIPTS: readonly LipSyncScript[] = ['auto', 'kana', 'hangul', 'latin'];

const PAUSE_BEATS: Partial<Record<CharClass, number>> = {
  space: MORA_BEATS.space,
  comma: MORA_BEATS.comma,
  stop: MORA_BEATS.stop,
  digit: MORA_BEATS.short,
  symbol: MORA_BEATS.short,
  unknown: MORA_BEATS.short,
};

/**
 * Split text into beats with a mouth shape each.
 *
 * - `auto` detects the script per character run: kana (hiragana, katakana, half-width katakana),
 *   Hangul, Latin (romaji first, else an English-like reading). A named script reads only its own
 *   letters; letters of the other scripts are then reported as unknown.
 * - Long-vowel marks (ー ｰ 〜 ～ ~) lengthen the beat before them by one beat.
 * - Punctuation, spaces, digits and symbols are rests; a run of them is ONE rest (at most 4 beats).
 *   White space around the text is dropped.
 * - Letters that cannot be read (kanji, other scripts) are short rests and are listed in `unknown`:
 *   write their reading in kana, Hangul or Latin letters instead.
 */
export function textToMorae(text: string, script: LipSyncScript = 'auto'): TextToMoraeResult {
  if (typeof text !== 'string') throw new TypeError(`textToMorae: text must be a string, got ${text === null ? 'null' : typeof text}`);
  if (!SCRIPTS.includes(script)) {
    throw new RangeError(`textToMorae: unknown script ${JSON.stringify(script)} (use "auto", "kana", "hangul" or "latin")`);
  }
  // NFC joins decomposed Hangul jamo into syllable blocks and kana with their combining sound marks.
  const chars = [...text.normalize('NFC').trim()];
  const classes = chars.map((ch): CharClass => {
    const cls = classifyChar(ch);
    const isScript = cls === 'kana' || cls === 'hangul' || cls === 'latin';
    return isScript && script !== 'auto' && cls !== script ? 'unknown' : cls;
  });

  const morae: Mora[] = [];
  const unknown: string[] = [];
  const reported = new Set<string>();
  /** The pause being collected; `morae` itself never ends with a rest while the loop runs. */
  let rest: Mora | undefined;
  const pause = (ch: string, beats: number): void => {
    rest ??= { text: '', viseme: 'rest', beats: 0 };
    rest.text += ch;
    rest.beats = Math.min(MORA_BEATS.maxRest, rest.beats + beats);
  };
  const speak = (mora: Mora): void => {
    if (mora.viseme === 'rest') {
      pause(mora.text, mora.beats);
      return;
    }
    if (rest) morae.push(rest);
    rest = undefined;
    morae.push(mora);
  };

  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    const cls = classes[i];
    if (cls === 'kana' || cls === 'hangul' || cls === 'latin') {
      let j = i + 1;
      // An apostrophe or hyphen between two Latin letters stays inside the word (don't, kon'ya).
      while (j < chars.length && (classes[j] === cls || (cls === 'latin' && isWordSeparator(chars[j]) && classes[j + 1] === 'latin'))) j++;
      const run = chars.slice(i, j).join('');
      const beats = cls === 'kana' ? kanaToMorae(run) : cls === 'hangul' ? hangulToMorae(run) : latinToMorae(run);
      beats.forEach(speak);
      i = j;
      continue;
    }
    const last = morae.length > 0 ? morae[morae.length - 1] : undefined;
    if (cls === 'long') {
      if (!rest && last) {
        last.text += ch;
        last.beats += 1;
      } else {
        pause(ch, MORA_BEATS.short);
      }
    } else if (cls === 'ignore') {
      if (rest) rest.text += ch;
      else if (last) last.text += ch;
    } else {
      if (cls === 'unknown' && !reported.has(ch)) {
        reported.add(ch);
        unknown.push(ch);
      }
      pause(ch, PAUSE_BEATS[cls] ?? MORA_BEATS.short);
    }
    i++;
  }
  if (rest) morae.push(rest);
  return { morae, unknown };
}

/** Total length of a beat sequence in beats (beats that are not positive numbers do not count). */
export function moraeBeats(morae: readonly Mora[]): number {
  let total = 0;
  for (const m of morae) if (Number.isFinite(m.beats) && m.beats > 0) total += m.beats;
  return total;
}
