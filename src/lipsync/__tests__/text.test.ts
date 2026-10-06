import { describe, expect, it } from 'vitest';
import { MORA_BEATS, moraeBeats, textToMorae, type LipSyncScript, type Mora } from '../index.js';
import { classifyChar } from '../chars.js';

const show = (morae: Mora[]): string => morae.map((m) => `${m.text}:${m.viseme}${m.beats === 1 ? '' : `*${m.beats}`}`).join(' ');

describe('script detection', () => {
  it('auto reads each run with its own script', () => {
    const { morae, unknown } = textToMorae('Hello, こんにちは! 안녕');
    expect(unknown).toEqual([]);
    expect(show(morae)).toBe(
      `He:e llo:o , :rest*${MORA_BEATS.comma + MORA_BEATS.space} こ:o ん:n に:i ち:i は:a ! :rest*${MORA_BEATS.stop + MORA_BEATS.space} 안:a 녕:o`,
    );
  });

  it('scripts may touch without a space', () => {
    expect(show(textToMorae('はいyes네').morae)).toBe('は:a い:i yes:e 네:e');
    expect(show(textToMorae('カタカナとひらがな').morae)).toBe('カ:a タ:a カ:a ナ:a と:o ひ:i ら:a が:a な:a');
  });

  it('auto is the default', () => {
    expect(textToMorae('あ a 아')).toEqual(textToMorae('あ a 아', 'auto'));
  });

  it('a named script reads only its own letters; the others are unknown', () => {
    const kana = textToMorae('こんにちは world', 'kana');
    expect(show(kana.morae)).toBe(`こ:o ん:n に:i ち:i は:a  world:rest*${MORA_BEATS.space + 5 * MORA_BEATS.short}`);
    expect(kana.unknown).toEqual(['w', 'o', 'r', 'l', 'd']);

    const hangul = textToMorae('안녕 hello こんにちは', 'hangul');
    expect(hangul.morae.filter((m) => m.viseme !== 'rest').map((m) => m.text)).toEqual(['안', '녕']);
    expect(hangul.unknown).toEqual(['h', 'e', 'l', 'o', 'こ', 'ん', 'に', 'ち', 'は']);

    const latin = textToMorae('sushi すし', 'latin');
    expect(show(latin.morae)).toBe(`su:u shi:i  すし:rest*${MORA_BEATS.space + 2 * MORA_BEATS.short}`);
    expect(latin.unknown).toEqual(['す', 'し']);
  });

  it('a named script gives the same result as auto for text in that script', () => {
    const cases: Array<[string, LipSyncScript]> = [
      ['こんにちは、せかい。', 'kana'],
      ['안녕하세요 반갑습니다', 'hangul'],
      ["konnichiwa, don't stop!", 'latin'],
    ];
    for (const [text, script] of cases) expect(textToMorae(text, script), text).toEqual(textToMorae(text));
  });

  it('rejects a script it does not know', () => {
    expect(() => textToMorae('a', 'greek' as LipSyncScript)).toThrow(/unknown script "greek".*"auto", "kana", "hangul" or "latin"/);
    expect(() => textToMorae(42 as unknown as string)).toThrow(TypeError);
    expect(() => textToMorae(null as unknown as string)).toThrow(/must be a string, got null/);
  });
});

describe('rests', () => {
  it('pause lengths: sentence end > comma > space = short', () => {
    expect(MORA_BEATS.stop).toBeGreaterThan(MORA_BEATS.comma);
    expect(MORA_BEATS.comma).toBeGreaterThan(MORA_BEATS.space);
    expect(MORA_BEATS.short).toBeLessThan(1);
    expect(MORA_BEATS.maxRest).toBeGreaterThanOrEqual(MORA_BEATS.stop);
  });

  it('a run of pause characters is one rest', () => {
    expect(textToMorae('a, a').morae).toEqual([
      { text: 'a', viseme: 'a', beats: 1 },
      { text: ', ', viseme: 'rest', beats: MORA_BEATS.comma + MORA_BEATS.space },
      { text: 'a', viseme: 'a', beats: 1 },
    ]);
  });

  it('a long run is capped', () => {
    const { morae } = textToMorae('あ。。。。。。い');
    expect(morae).toHaveLength(3);
    expect(morae[1]).toEqual({ text: '。。。。。。', viseme: 'rest', beats: MORA_BEATS.maxRest });
    expect(textToMorae('a!?!?!?!? a').morae[1].beats).toBe(MORA_BEATS.maxRest);
  });

  it('digits and symbols are short rests and are not reported', () => {
    expect(textToMorae('あ1い')).toEqual({
      morae: [
        { text: 'あ', viseme: 'a', beats: 1 },
        { text: '1', viseme: 'rest', beats: MORA_BEATS.short },
        { text: 'い', viseme: 'i', beats: 1 },
      ],
      unknown: [],
    });
    expect(textToMorae('あ@い').morae[1]).toEqual({ text: '@', viseme: 'rest', beats: MORA_BEATS.short });
    expect(textToMorae('あ「い」').morae.map((m) => m.viseme)).toEqual(['a', 'rest', 'i', 'rest']);
    expect(textToMorae('１２３ 😀 ♪ %').unknown).toEqual([]);
    expect(textToMorae('１２３').morae).toEqual([{ text: '１２３', viseme: 'rest', beats: 3 * MORA_BEATS.short }]);
  });

  it('line breaks end a sentence', () => {
    expect(textToMorae('あ\nい').morae[1]).toEqual({ text: '\n', viseme: 'rest', beats: MORA_BEATS.stop });
    expect(textToMorae('あ\r\nい').morae[1].beats).toBe(MORA_BEATS.maxRest);
  });

  it('white space around the text is dropped, punctuation is kept', () => {
    expect(textToMorae('  あ \n')).toEqual(textToMorae('あ'));
    expect(textToMorae('\u3000あ\u3000').morae).toHaveLength(1);
    expect(show(textToMorae(' あ。 ').morae)).toBe(`あ:a 。:rest*${MORA_BEATS.stop}`);
    expect(show(textToMorae('…あ').morae)).toBe(`…:rest*${MORA_BEATS.stop} あ:a`);
  });

  it('empty and blank text have no beats', () => {
    expect(textToMorae('')).toEqual({ morae: [], unknown: [] });
    expect(textToMorae('   \n\t')).toEqual({ morae: [], unknown: [] });
  });

  it('only punctuation is one rest', () => {
    expect(textToMorae('...')).toEqual({ morae: [{ text: '...', viseme: 'rest', beats: MORA_BEATS.maxRest }], unknown: [] });
  });
});

describe('unknown characters', () => {
  it('are reported once each, in order of appearance, and become short rests', () => {
    const { morae, unknown } = textToMorae('привет あ 漢字 привет');
    expect(unknown).toEqual(['п', 'р', 'и', 'в', 'е', 'т', '漢', '字']);
    expect(morae.map((m) => m.viseme)).toEqual(['rest', 'a', 'rest']);
    expect(morae[0]).toEqual({ text: 'привет ', viseme: 'rest', beats: 6 * MORA_BEATS.short + MORA_BEATS.space });
  });

  it('a character outside the BMP is one unknown character', () => {
    // U+20BB7 (a CJK extension B ideograph) is a surrogate pair in UTF-16.
    const { morae, unknown } = textToMorae('あ\u{20bb7}い');
    expect(unknown).toEqual(['\u{20bb7}']);
    expect(morae[1]).toEqual({ text: '\u{20bb7}', viseme: 'rest', beats: MORA_BEATS.short });
  });

  it('invisible characters are neither beats nor unknown', () => {
    // zero-width joiner, variation selector, zero-width space
    expect(textToMorae('あ\u200dい\ufe0f\u200b')).toEqual({
      morae: [
        { text: 'あ\u200d', viseme: 'a', beats: 1 },
        { text: 'い\ufe0f\u200b', viseme: 'i', beats: 1 },
      ],
      unknown: [],
    });
  });
});

describe('character classes', () => {
  it('classifies one character', () => {
    const cases: Array<[string, string]> = [
      ['あ', 'kana'], ['ア', 'kana'], ['ｱ', 'kana'], ['っ', 'kana'], ['ゞ', 'kana'],
      ['ー', 'long'], ['〜', 'long'], ['~', 'long'],
      ['한', 'hangul'], ['ㅏ', 'hangul'], ['ㅋ', 'hangul'],
      ['a', 'latin'], ['Z', 'latin'], ['é', 'latin'], ['ō', 'latin'], ['ａ', 'latin'],
      [' ', 'space'], ['\u3000', 'space'], ['\t', 'space'], ['・', 'space'],
      ['、', 'comma'], [',', 'comma'], ['；', 'comma'], ['—', 'comma'],
      ['。', 'stop'], ['.', 'stop'], ['!', 'stop'], ['？', 'stop'], ['…', 'stop'], ['\n', 'stop'],
      ['7', 'digit'], ['７', 'digit'], ['½', 'digit'],
      ['@', 'symbol'], ['「', 'symbol'], ['♪', 'symbol'], ['😀', 'symbol'], ['×', 'symbol'],
      ['\u200d', 'ignore'], ['\u0301', 'ignore'],
      ['漢', 'unknown'], ['я', 'unknown'], ['α', 'unknown'], ['々', 'unknown'],
    ];
    for (const [ch, cls] of cases) expect(classifyChar(ch), JSON.stringify(ch)).toBe(cls);
  });
});

describe('moraeBeats', () => {
  it('sums the beats', () => {
    expect(moraeBeats([])).toBe(0);
    expect(moraeBeats(textToMorae('あいうえお').morae)).toBe(5);
    expect(moraeBeats(textToMorae('ラーメン、きって').morae)).toBe(4 + MORA_BEATS.comma + 2 + MORA_BEATS.sokuon);
  });

  it('ignores beats that are not positive numbers', () => {
    const morae: Mora[] = [
      { text: 'a', viseme: 'a', beats: 1 },
      { text: 'x', viseme: 'a', beats: -2 },
      { text: 'y', viseme: 'a', beats: Number.NaN },
      { text: 'z', viseme: 'i', beats: 0 },
    ];
    expect(moraeBeats(morae)).toBe(1);
  });
});
