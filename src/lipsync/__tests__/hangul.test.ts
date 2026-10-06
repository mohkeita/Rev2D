import { describe, expect, it } from 'vitest';
import { MORA_BEATS, textToMorae, type Mora, type Viseme } from '../index.js';
import { decomposeHangul, hangulToMorae } from '../hangul.js';

const show = (morae: Mora[]): string => morae.map((m) => `${m.text}:${m.viseme}${m.beats === 1 ? '' : `*${m.beats}`}`).join(' ');
const CLOSE = `n*${MORA_BEATS.lipClose}`;

/** Compose a syllable block from jamo indices (the inverse of decomposeHangul). */
const block = (initial: number, medial: number, final = 0): string => String.fromCodePoint(0xac00 + (initial * 21 + medial) * 28 + final);

describe('Hangul decomposition', () => {
  it('splits a block into initial, medial and final', () => {
    expect(decomposeHangul('가')).toEqual({ initial: 0, medial: 0, final: 0 });
    expect(decomposeHangul('한')).toEqual({ initial: 18, medial: 0, final: 4 });
    expect(decomposeHangul('글')).toEqual({ initial: 0, medial: 18, final: 8 });
    expect(decomposeHangul('힣')).toEqual({ initial: 18, medial: 20, final: 27 });
    expect(decomposeHangul('a')).toBeUndefined();
    expect(decomposeHangul('ㅏ')).toBeUndefined();
  });

  it('round-trips every block', () => {
    for (let cp = 0xac00; cp <= 0xd7a3; cp += 97) {
      const s = decomposeHangul(String.fromCodePoint(cp));
      expect(s).toBeDefined();
      expect(block(s!.initial, s!.medial, s!.final)).toBe(String.fromCodePoint(cp));
    }
  });
});

describe('medial vowels', () => {
  // The mapping of the task: ㅏㅑㅘ a · ㅓㅕㅝ open o · ㅗㅛ o · ㅜㅠ u · ㅡ u · ㅣㅟㅢ i · ㅐㅒㅔㅖㅙㅚㅞ e.
  const expected: Array<[string, Viseme]> = [
    ['아', 'a'], ['야', 'a'], ['와', 'a'],
    ['어', 'o'], ['여', 'o'], ['워', 'o'],
    ['오', 'o'], ['요', 'o'],
    ['우', 'u'], ['유', 'u'],
    ['으', 'u'],
    ['이', 'i'], ['위', 'i'], ['의', 'i'],
    ['애', 'e'], ['얘', 'e'], ['에', 'e'], ['예', 'e'], ['왜', 'e'], ['외', 'e'], ['웨', 'e'],
  ];

  it('maps all 21 vowels', () => {
    expect(expected).toHaveLength(21);
    for (const [syllable, viseme] of expected) {
      expect(textToMorae(syllable).morae, syllable).toEqual([{ text: syllable, viseme, beats: 1 }]);
    }
    // Every medial index is covered by the list above.
    expect(new Set(expected.map(([s]) => decomposeHangul(s)!.medial)).size).toBe(21);
  });

  it('the initial consonant does not change the shape', () => {
    for (let initial = 0; initial < 19; initial++) {
      expect(textToMorae(block(initial, 0)).morae[0].viseme).toBe('a');
      expect(textToMorae(block(initial, 20)).morae[0].viseme).toBe('i');
    }
  });

  it('stand-alone vowel jamo are beats too', () => {
    expect(show(textToMorae('ㅏㅣㅜㅔㅗ').morae)).toBe('ㅏ:a ㅣ:i ㅜ:u ㅔ:e ㅗ:o');
    expect(show(textToMorae('ㅠㅠ').morae)).toBe('ㅠ:u ㅠ:u');
  });
});

describe('final consonants', () => {
  it('ㅁ ㅂ ㅍ close the lips after the vowel', () => {
    expect(textToMorae('밥').morae).toEqual([
      { text: '밥', viseme: 'a', beats: 1 },
      { text: 'ㅂ', viseme: 'n', beats: MORA_BEATS.lipClose },
    ]);
    expect(show(textToMorae('감').morae)).toBe(`감:a ㅁ:${CLOSE}`);
    expect(show(textToMorae('숲').morae)).toBe(`숲:u ㅍ:${CLOSE}`);
    expect(MORA_BEATS.lipClose).toBeGreaterThan(0);
    expect(MORA_BEATS.lipClose).toBeLessThan(1);
  });

  it('clusters that are pronounced with closed lips close them too', () => {
    expect(show(textToMorae('삶').morae)).toBe(`삶:a ㄻ:${CLOSE}`);
    expect(show(textToMorae('없').morae)).toBe(`없:o ㅄ:${CLOSE}`);
    expect(show(textToMorae('읊').morae)).toBe(`읊:u ㄿ:${CLOSE}`);
  });

  it('other finals add nothing', () => {
    // ㄱ ㄴ ㄷ ㄹ ㅅ ㅇ ㅈ ㅊ ㅋ ㅌ ㅎ and the cluster ㄼ (pronounced ㄹ)
    for (const syllable of ['각', '간', '갇', '갈', '갓', '강', '갖', '갗', '갘', '같', '갛', '넓']) {
      expect(textToMorae(syllable).morae, syllable).toHaveLength(1);
    }
  });

  it('exactly six of the 28 finals close the lips', () => {
    let closing = 0;
    for (let final = 0; final < 28; final++) if (hangulToMorae(block(0, 0, final)).length === 2) closing++;
    expect(closing).toBe(6);
  });
});

describe('Korean text', () => {
  it('안녕하세요', () => {
    expect(textToMorae('안녕하세요')).toEqual({
      morae: [
        { text: '안', viseme: 'a', beats: 1 },
        { text: '녕', viseme: 'o', beats: 1 },
        { text: '하', viseme: 'a', beats: 1 },
        { text: '세', viseme: 'e', beats: 1 },
        { text: '요', viseme: 'o', beats: 1 },
      ],
      unknown: [],
    });
  });

  it('words with closing finals: 감사합니다, 반갑습니다', () => {
    expect(show(textToMorae('감사합니다').morae)).toBe(`감:a ㅁ:${CLOSE} 사:a 합:a ㅂ:${CLOSE} 니:i 다:a`);
    expect(show(textToMorae('반갑습니다').morae)).toBe(`반:a 갑:a ㅂ:${CLOSE} 습:u ㅂ:${CLOSE} 니:i 다:a`);
  });

  it('spaces and punctuation are rests', () => {
    expect(show(textToMorae('밥 먹었어요?').morae)).toBe(`밥:a ㅂ:${CLOSE}  :rest*${MORA_BEATS.space} 먹:o 었:o 어:o 요:o ?:rest*${MORA_BEATS.stop}`);
  });

  it('stand-alone consonant jamo: lips close on ㅁ ㅂ ㅃ ㅍ, the others are short rests', () => {
    expect(show(textToMorae('ㅁ').morae)).toBe(`ㅁ:${CLOSE}`);
    expect(textToMorae('ㅋㅋㅋ')).toEqual({ morae: [{ text: 'ㅋㅋㅋ', viseme: 'rest', beats: 3 * MORA_BEATS.short }], unknown: [] });
  });

  it('decomposed (NFD) Hangul equals the composed text', () => {
    expect(textToMorae('안녕하세요'.normalize('NFD'))).toEqual(textToMorae('안녕하세요'));
  });

  it('a wave dash lengthens the syllable before it', () => {
    expect(show(textToMorae('안녕~').morae)).toBe('안:a 녕~:o*2');
  });
});
