/**
 * Japanese kana -> beats. Every kana is one mora whose mouth shape is its vowel; the consonant does
 * not matter (か and が both show "a").
 */
import { MORA_BEATS } from './chars.js';
import type { Mora, Viseme } from './types.js';

type Vowel = 'a' | 'i' | 'u' | 'e' | 'o';

/** Hiragana by vowel, voiced and semi-voiced rows included. ゕ / ゖ (ヵ / ヶ) are read "ka". */
const HIRAGANA_BY_VOWEL: Record<Vowel, string> = {
  a: 'あかさたなはまやらわがざだばぱぁゃゎゕゖ',
  i: 'いきしちにひみりゐぎじぢびぴぃ',
  u: 'うくすつぬふむゆるぐずづぶぷゔぅゅ',
  e: 'えけせてねへめれゑげぜでべぺぇ',
  o: 'おこそとのほもよろをごぞどぼぽぉょ',
};

const VOWEL_OF = new Map<string, Vowel>();
for (const vowel of Object.keys(HIRAGANA_BY_VOWEL) as Vowel[]) {
  for (const kana of HIRAGANA_BY_VOWEL[vowel]) VOWEL_OF.set(kana, vowel);
}

/** Small kana that join the beat before them: きゃ, ふぁ, てぃ, くゎ. */
const SMALL = new Set('ぁぃぅぇぉゃゅょゎ');
/** Small vowels: after a beat that already has their vowel they only lengthen it (ねぇ, あぁぁ). */
const SMALL_VOWELS = new Set('ぁぃぅぇぉ');
/** (Semi-)voiced sound marks, combining and spacing: they change the consonant only. */
const SOUND_MARKS = new Set(['\u3099', '\u309a', '゛', '゜', 'ﾞ', 'ﾟ']);
/** Iteration marks: the previous kana once more. */
const ITERATION_MARKS = new Set(['ゝ', 'ゞ']);

const HALF_WIDTH = 'ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
const HALF_WIDTH_AS_HIRAGANA = 'をぁぃぅぇぉゃゅょっあいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわん';
/** ヷ ヸ ヹ ヺ (va vi ve vo) have no hiragana of their own. */
const KATAKANA_ONLY: Record<string, string> = { ヷ: 'わ', ヸ: 'ゐ', ヹ: 'ゑ', ヺ: 'を', ヽ: 'ゝ', ヾ: 'ゞ' };

/** The hiragana a kana character stands for (katakana and half-width katakana folded); other characters unchanged. */
export function toHiragana(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x30a1 && cp <= 0x30f6) return String.fromCodePoint(cp - 0x60);
  const special = KATAKANA_ONLY[ch];
  if (special) return special;
  const half = HALF_WIDTH.indexOf(ch);
  return half >= 0 ? HALF_WIDTH_AS_HIRAGANA[half] : ch;
}

function isVowel(viseme: Viseme): viseme is Vowel {
  return viseme !== 'n' && viseme !== 'rest';
}

/**
 * A run of kana -> beats.
 * - A kana is one beat with its vowel; ん is a closed "n" beat; っ is a short closure.
 * - A small ゃゅょぁぃぅぇぉゎ joins the beat before it, which takes the small kana's vowel (きゃ = a,
 *   てぃ = i). A small vowel after a beat that already has that vowel lengthens it by one beat instead
 *   (ねぇ = 2 beats of e). With no beat to join it is a beat of its own.
 * - Sound marks (゛ ゜) are appended to the beat before them; iteration marks (ゝ ゞ) repeat it.
 */
export function kanaToMorae(run: string): Mora[] {
  const out: Mora[] = [];
  for (const ch of run) {
    const kana = toHiragana(ch);
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (SOUND_MARKS.has(kana)) {
      if (last) last.text += ch;
      continue;
    }
    if (kana === 'っ') {
      out.push({ text: ch, viseme: 'n', beats: MORA_BEATS.sokuon });
      continue;
    }
    if (kana === 'ん') {
      out.push({ text: ch, viseme: 'n', beats: 1 });
      continue;
    }
    if (ITERATION_MARKS.has(kana)) {
      out.push(last && isVowel(last.viseme) ? { text: ch, viseme: last.viseme, beats: 1 } : { text: ch, viseme: 'rest', beats: MORA_BEATS.short });
      continue;
    }
    const vowel = VOWEL_OF.get(kana);
    if (!vowel) {
      // Not reachable for the characters isKana() accepts; a pause keeps the timing sane if it ever is.
      out.push({ text: ch, viseme: 'rest', beats: MORA_BEATS.short });
      continue;
    }
    if (SMALL.has(kana) && last && isVowel(last.viseme)) {
      last.text += ch;
      if (last.viseme === vowel && SMALL_VOWELS.has(kana)) last.beats += 1;
      else last.viseme = vowel;
      continue;
    }
    out.push({ text: ch, viseme: vowel, beats: 1 });
  }
  return out;
}
