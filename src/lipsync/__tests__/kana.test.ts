import { describe, expect, it } from 'vitest';
import { MORA_BEATS, textToMorae, type Mora } from '../index.js';
import { kanaToMorae, toHiragana } from '../kana.js';

/** "こ:o ん:n" notation: text, viseme and (when not 1) the length in beats. */
const show = (morae: Mora[]): string => morae.map((m) => `${m.text}:${m.viseme}${m.beats === 1 ? '' : `*${m.beats}`}`).join(' ');
const visemes = (text: string): string => textToMorae(text).morae.map((m) => m.viseme).join(' ');

describe('kana table', () => {
  it('あいうえお are the five vowels, one beat each', () => {
    expect(textToMorae('あいうえお')).toEqual({
      morae: [
        { text: 'あ', viseme: 'a', beats: 1 },
        { text: 'い', viseme: 'i', beats: 1 },
        { text: 'う', viseme: 'u', beats: 1 },
        { text: 'え', viseme: 'e', beats: 1 },
        { text: 'お', viseme: 'o', beats: 1 },
      ],
      unknown: [],
    });
  });

  it('every row follows a i u e o', () => {
    for (const row of ['かきくけこ', 'さしすせそ', 'たちつてと', 'なにぬねの', 'はひふへほ', 'まみむめも', 'らりるれろ']) {
      expect(visemes(row), row).toBe('a i u e o');
    }
    expect(visemes('やゆよ')).toBe('a u o');
    expect(visemes('わゐゑを')).toBe('a i e o');
  });

  it('voiced and semi-voiced kana keep the vowel of their row', () => {
    for (const row of ['がぎぐげご', 'ざじずぜぞ', 'だぢづでど', 'ばびぶべぼ', 'ぱぴぷぺぽ']) {
      expect(visemes(row), row).toBe('a i u e o');
    }
    expect(visemes('ゔ')).toBe('u');
  });

  it('covers every hiragana and katakana letter (nothing is unknown, nothing is a rest)', () => {
    const letters: string[] = [];
    for (let cp = 0x3041; cp <= 0x3096; cp++) letters.push(String.fromCodePoint(cp));
    for (let cp = 0x30a1; cp <= 0x30fa; cp++) letters.push(String.fromCodePoint(cp));
    for (const ch of letters) {
      // A small kana joins the beat before it: test each letter on its own.
      const { morae, unknown } = textToMorae(ch);
      expect(unknown, ch).toEqual([]);
      expect(morae, ch).toHaveLength(1);
      expect(morae[0].viseme, ch).not.toBe('rest');
      expect(morae[0].text, ch).toBe(ch);
    }
  });

  it('ん is a closed beat', () => {
    expect(show(textToMorae('ほん').morae)).toBe('ほ:o ん:n');
    expect(show(textToMorae('ン').morae)).toBe('ン:n');
  });

  it('っ is a short closure', () => {
    expect(show(textToMorae('きって').morae)).toBe(`き:i っ:n*${MORA_BEATS.sokuon} て:e`);
    expect(MORA_BEATS.sokuon).toBeLessThan(1);
    expect(show(textToMorae('バッグ').morae)).toBe(`バ:a ッ:n*${MORA_BEATS.sokuon} グ:u`);
  });
});

describe('small kana', () => {
  it('ゃ ゅ ょ join the kana before them and give the beat their vowel', () => {
    expect(textToMorae('きゃ').morae).toEqual([{ text: 'きゃ', viseme: 'a', beats: 1 }]);
    expect(show(textToMorae('きゃきゅきょ').morae)).toBe('きゃ:a きゅ:u きょ:o');
    expect(show(textToMorae('しゃしん').morae)).toBe('しゃ:a し:i ん:n');
    expect(show(textToMorae('りょこう').morae)).toBe('りょ:o こ:o う:u');
  });

  it('small vowels join too (ふぁ, てぃ, うぉ, ヴェ)', () => {
    expect(show(textToMorae('ふぁ').morae)).toBe('ふぁ:a');
    expect(show(textToMorae('てぃ').morae)).toBe('てぃ:i');
    expect(show(textToMorae('うぉ').morae)).toBe('うぉ:o');
    expect(show(textToMorae('ヴェ').morae)).toBe('ヴェ:e');
    expect(show(textToMorae('くゎ').morae)).toBe('くゎ:a');
  });

  it('a small vowel after a beat with the same vowel lengthens it', () => {
    expect(show(textToMorae('ねぇ').morae)).toBe('ねぇ:e*2');
    expect(show(textToMorae('あぁぁ').morae)).toBe('あぁぁ:a*3');
    expect(show(textToMorae('きゃぁ').morae)).toBe('きゃぁ:a*2');
  });

  it('a small kana with no beat to join is a beat of its own', () => {
    expect(show(textToMorae('ぁ').morae)).toBe('ぁ:a');
    expect(show(textToMorae('んゃ').morae)).toBe('ん:n ゃ:a');
    expect(show(textToMorae('っょ').morae)).toBe(`っ:n*${MORA_BEATS.sokuon} ょ:o`);
  });
});

describe('long vowel mark', () => {
  it('ー holds the previous vowel for one more beat', () => {
    expect(textToMorae('ラーメン').morae).toEqual([
      { text: 'ラー', viseme: 'a', beats: 2 },
      { text: 'メ', viseme: 'e', beats: 1 },
      { text: 'ン', viseme: 'n', beats: 1 },
    ]);
    expect(show(textToMorae('こーひー').morae)).toBe('こー:o*2 ひー:i*2');
    expect(show(textToMorae('きゃー').morae)).toBe('きゃー:a*2');
    expect(show(textToMorae('えーー').morae)).toBe('えーー:e*3');
  });

  it('the wave dash and the half-width mark do the same', () => {
    expect(show(textToMorae('すごい〜').morae)).toBe('す:u ご:o い〜:i*2');
    expect(show(textToMorae('ね～').morae)).toBe('ね～:e*2');
    expect(show(textToMorae('ｺｰﾋｰ').morae)).toBe('ｺｰ:o*2 ﾋｰ:i*2');
  });

  it('with nothing to lengthen it is a short rest', () => {
    expect(show(textToMorae('ーあ').morae)).toBe(`ー:rest*${MORA_BEATS.short} あ:a`);
    expect(show(textToMorae('あ、ーい').morae)).toBe(`あ:a 、ー:rest*${MORA_BEATS.comma + MORA_BEATS.short} い:i`);
  });
});

describe('katakana and other forms', () => {
  it('katakana reads like hiragana', () => {
    expect(visemes('アイウエオ')).toBe(visemes('あいうえお'));
    expect(visemes('コンニチハ')).toBe(visemes('こんにちは'));
    expect(show(textToMorae('キャット').morae)).toBe(`キャ:a ッ:n*${MORA_BEATS.sokuon} ト:o`);
    expect(show(textToMorae('ヷヸヹヺ').morae)).toBe('ヷ:a ヸ:i ヹ:e ヺ:o');
  });

  it('half-width katakana and its sound marks', () => {
    expect(show(textToMorae('ｶﾞｯｺｳ').morae)).toBe(`ｶﾞ:a ｯ:n*${MORA_BEATS.sokuon} ｺ:o ｳ:u`);
    expect(show(textToMorae('ﾊﾟﾝ').morae)).toBe('ﾊﾟ:a ﾝ:n');
    expect(toHiragana('ｱ')).toBe('あ');
    expect(toHiragana('ﾝ')).toBe('ん');
    expect(toHiragana('ｦ')).toBe('を');
  });

  it('decomposed kana (base + combining sound mark) equals the composed form', () => {
    expect(textToMorae('か\u3099き\u3099ハ\u309a').morae).toEqual(textToMorae('がぎパ').morae);
    // A sound mark that has no composed form stays with its kana.
    expect(show(textToMorae('あ\u3099い').morae)).toBe('あ\u3099:a い:i');
    expect(show(textToMorae('あ゛').morae)).toBe('あ゛:a');
  });

  it('iteration marks repeat the previous kana', () => {
    expect(show(textToMorae('すゞめ').morae)).toBe('す:u ゞ:u め:e');
    expect(show(textToMorae('こゝろ').morae)).toBe('こ:o ゝ:o ろ:o');
  });

  it('toHiragana folds katakana and leaves everything else alone', () => {
    expect(toHiragana('カ')).toBe('か');
    expect(toHiragana('ヴ')).toBe('ゔ');
    expect(toHiragana('か')).toBe('か');
    expect(toHiragana('a')).toBe('a');
  });

  it('kanaToMorae converts a run on its own', () => {
    expect(show(kanaToMorae('とうきょう'))).toBe('と:o う:u きょ:o う:u');
    expect(kanaToMorae('')).toEqual([]);
  });
});

describe('punctuation in Japanese text', () => {
  it('、。！？ and spaces are rests', () => {
    expect(show(textToMorae('あ、い').morae)).toBe(`あ:a 、:rest*${MORA_BEATS.comma} い:i`);
    expect(show(textToMorae('あ。い').morae)).toBe(`あ:a 。:rest*${MORA_BEATS.stop} い:i`);
    expect(show(textToMorae('あ！い').morae)).toBe(`あ:a ！:rest*${MORA_BEATS.stop} い:i`);
    expect(show(textToMorae('あ？い').morae)).toBe(`あ:a ？:rest*${MORA_BEATS.stop} い:i`);
    expect(show(textToMorae('あ\u3000い').morae)).toBe(`あ:a \u3000:rest*${MORA_BEATS.space} い:i`);
    expect(show(textToMorae('あ い').morae)).toBe(`あ:a  :rest*${MORA_BEATS.space} い:i`);
  });

  it('the middle dot between words is a word gap', () => {
    expect(show(textToMorae('ジョン・スミス').morae)).toBe(`ジョ:o ン:n ・:rest*${MORA_BEATS.space} ス:u ミ:i ス:u`);
  });

  it('a sentence: こんにちは、せかい。', () => {
    expect(show(textToMorae('こんにちは、せかい。').morae)).toBe(`こ:o ん:n に:i ち:i は:a 、:rest*${MORA_BEATS.comma} せ:e か:a い:i 。:rest*${MORA_BEATS.stop}`);
  });

  it('kanji cannot be read: short rests, reported once each', () => {
    const { morae, unknown } = textToMorae('今日は今日');
    expect(unknown).toEqual(['今', '日']);
    expect(morae).toEqual([
      { text: '今日', viseme: 'rest', beats: 2 * MORA_BEATS.short },
      { text: 'は', viseme: 'a', beats: 1 },
      { text: '今日', viseme: 'rest', beats: 2 * MORA_BEATS.short },
    ]);
  });
});
