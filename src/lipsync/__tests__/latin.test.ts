import { describe, expect, it } from 'vitest';
import { MORA_BEATS, textToMorae, type Mora } from '../index.js';
import { isRomaji, latinToMorae } from '../latin.js';

const show = (morae: Mora[]): string => morae.map((m) => `${m.text}:${m.viseme}${m.beats === 1 ? '' : `*${m.beats}`}`).join(' ');
const shapes = (text: string): string => textToMorae(text).morae.map((m) => `${m.viseme}${m.beats === 1 ? '' : `*${m.beats}`}`).join(' ');
const STOP = `n*${MORA_BEATS.sokuon}`;
const LIPS = `n*${MORA_BEATS.lipClose}`;

describe('romaji', () => {
  it('konnichiwa', () => {
    expect(textToMorae('konnichiwa')).toEqual({
      morae: [
        { text: 'ko', viseme: 'o', beats: 1 },
        { text: 'n', viseme: 'n', beats: 1 },
        { text: 'ni', viseme: 'i', beats: 1 },
        { text: 'chi', viseme: 'i', beats: 1 },
        { text: 'wa', viseme: 'a', beats: 1 },
      ],
      unknown: [],
    });
  });

  it('consonant + vowel syllables: ka shi tsu kya', () => {
    expect(show(textToMorae('ka').morae)).toBe('ka:a');
    expect(show(textToMorae('shi').morae)).toBe('shi:i');
    expect(show(textToMorae('tsu').morae)).toBe('tsu:u');
    expect(show(textToMorae('kya').morae)).toBe('kya:a');
    expect(show(textToMorae('sushi').morae)).toBe('su:u shi:i');
    expect(show(textToMorae('ryokou').morae)).toBe('ryo:o ko:o u:u');
    expect(show(textToMorae('fujisan').morae)).toBe('fu:u ji:i sa:a n:n');
    expect(show(textToMorae('aoi').morae)).toBe('a:a o:o i:i');
  });

  it('Kunrei and typing spellings', () => {
    expect(show(textToMorae('si ti tu hu zi').morae.filter((m) => m.viseme !== 'rest'))).toBe('si:i ti:i tu:u hu:u zi:i');
    expect(show(textToMorae('syasin').morae)).toBe('sya:a si:i n:n');
    expect(show(textToMorae('tya').morae)).toBe('tya:a');
  });

  it('the moraic n', () => {
    expect(show(textToMorae('n').morae)).toBe('n:n');
    expect(show(textToMorae('hon').morae)).toBe('ho:o n:n');
    expect(show(textToMorae('kanji').morae)).toBe('ka:a n:n ji:i');
    expect(show(textToMorae('onna').morae)).toBe('o:o n:n na:a');
    expect(show(textToMorae("kin'en").morae)).toBe("ki:i n':n e:e n:n");
    expect(show(textToMorae('kinen').morae)).toBe('ki:i ne:e n:n');
    expect(show(textToMorae('honya').morae)).toBe('ho:o nya:a');
    expect(show(textToMorae("hon'ya").morae)).toBe("ho:o n':n ya:a");
    // "nn" typed for one ん, and Hepburn "m" before b / p / m
    expect(show(textToMorae('kanntan').morae)).toBe('ka:a nn:n ta:a n:n');
    expect(show(textToMorae('shimbun').morae)).toBe('shi:i m:n bu:u n:n');
    expect(show(textToMorae('tempura').morae)).toBe('te:e m:n pu:u ra:a');
  });

  it('a doubled consonant is a short closure', () => {
    expect(show(textToMorae('kitte').morae)).toBe(`ki:i t:${STOP} te:e`);
    expect(show(textToMorae('gakkou').morae)).toBe(`ga:a k:${STOP} ko:o u:u`);
    expect(show(textToMorae('zasshi').morae)).toBe(`za:a s:${STOP} shi:i`);
    expect(show(textToMorae('matcha').morae)).toBe(`ma:a t:${STOP} cha:a`);
    expect(show(textToMorae('kocchi').morae)).toBe(`ko:o c:${STOP} chi:i`);
    expect(show(textToMorae('nippon').morae)).toBe(`ni:i p:${STOP} po:o n:n`);
  });

  it('a macron or circumflex is a long vowel', () => {
    expect(show(textToMorae('Tōkyō').morae)).toBe('Tō:o*2 kyō:o*2');
    expect(show(textToMorae('rāmen').morae)).toBe('rā:a*2 me:e n:n');
    expect(show(textToMorae('ôsaka').morae)).toBe('ô:o*2 sa:a ka:a');
  });

  it('romaji gives the same shapes and lengths as the kana', () => {
    const pairs: Array<[string, string]> = [
      ['konnichiwa', 'こんにちわ'],
      ['arigatou', 'ありがとう'],
      ['kitte', 'きって'],
      ['kyou wa ii tenki', 'きょう わ いい てんき'],
      ['shinbun', 'しんぶん'],
      ['gakkou', 'がっこう'],
      ['ohayou gozaimasu', 'おはよう ございます'],
      ['chotto matte', 'ちょっと まって'],
    ];
    for (const [romaji, kana] of pairs) expect(shapes(romaji), romaji).toBe(shapes(kana));
  });

  it('upper case and full-width letters', () => {
    expect(show(textToMorae('SUSHI').morae)).toBe('SU:u SHI:i');
    expect(show(textToMorae('ｓｕｓｈｉ').morae)).toBe('ｓｕ:u ｓｈｉ:i');
  });

  it('isRomaji needs the whole word to parse', () => {
    for (const word of ['konnichiwa', 'sushi', 'tokyo', 'a', 'n', 'matcha', "kon'ya"]) expect(isRomaji(word), word).toBe(true);
    for (const word of ['hello', 'world', 'cat', 'quick', 'x', 'kk', 'street']) expect(isRomaji(word), word).toBe(false);
  });
});

describe('English-like fallback', () => {
  it('each vowel group is a beat', () => {
    expect(show(textToMorae('hello world').morae)).toBe(`he:e llo:o  :rest*${MORA_BEATS.space} world:o`);
    expect(show(textToMorae('cat').morae)).toBe('cat:a');
    expect(show(textToMorae('train').morae)).toBe('train:e');
    expect(show(textToMorae('feel').morae.concat(textToMorae('cool').morae))).toBe('feel:i cool:u');
    expect(show(textToMorae('loud').morae)).toBe('loud:a');
    expect(show(textToMorae('beautiful').morae)).toBe(`b:${LIPS} eau:o ti:i ful:u`);
  });

  it('m, b and p close the lips', () => {
    expect(textToMorae('mom').morae).toEqual([
      { text: 'm', viseme: 'n', beats: MORA_BEATS.lipClose },
      { text: 'o', viseme: 'o', beats: 1 },
      { text: 'm', viseme: 'n', beats: MORA_BEATS.lipClose },
    ]);
    expect(show(textToMorae('number').morae)).toBe(`nu:u mb:${LIPS} er:e`);
    expect(show(textToMorae('stop').morae)).toBe(`sto:o p:${LIPS}`);
    expect(show(textToMorae('happy').morae)).toBe(`ha:a pp:${LIPS} y:i`);
    expect(show(textToMorae('lamp').morae)).toBe(`la:a mp:${LIPS}`);
  });

  it('y and w count as vowels where they sound like one', () => {
    expect(show(textToMorae('yes').morae)).toBe('yes:e');
    expect(show(textToMorae('sky').morae)).toBe('sky:i');
    expect(show(textToMorae('day').morae.concat(textToMorae('now').morae))).toBe('day:e now:o');
    expect(show(textToMorae('player').morae)).toBe(`p:${LIPS} la:a yer:e`);
    expect(show(textToMorae('queen').morae)).toBe('queen:i');
  });

  it('a silent final e is not a beat', () => {
    expect(show(textToMorae('like').morae)).toBe('like:i');
    expect(show(textToMorae('voice').morae)).toBe('voice:o');
    expect(show(textToMorae('the').morae)).toBe('the:e'); // romaji-free word whose only vowel is the e
    expect(show(textToMorae('little').morae)).toBe('li:i ttle:e'); // consonant + "le" is a syllable
    expect(show(textToMorae('table').morae)).toBe(`ta:a b:${LIPS} le:e`);
  });

  it("apostrophes and hyphens stay inside the word (don't, well-known)", () => {
    expect(show(textToMorae("don't").morae)).toBe("don't:o");
    expect(show(textToMorae('well-known').morae)).toBe('we:e ll-known:o');
    expect(textToMorae("rock 'n' roll").unknown).toEqual([]);
  });

  it('letters with diacritics read as their base letter', () => {
    expect(show(textToMorae('café').morae)).toBe('ca:a fé:e');
    expect(show(textToMorae('über').morae)).toBe(`ü:u b:${LIPS} er:e`);
    expect(show(textToMorae('Straße').morae)).toBe('Straße:a');
    expect(textToMorae('naïve señor Ærø').unknown).toEqual([]);
  });

  it('a word without a vowel or lip consonant is a short rest, not an unknown character', () => {
    expect(textToMorae('tsk')).toEqual({ morae: [{ text: 'tsk', viseme: 'rest', beats: MORA_BEATS.short }], unknown: [] });
    expect(show(textToMorae('hmm').morae)).toBe(`hmm:${LIPS}`);
  });

  it('latinToMorae converts one word', () => {
    expect(show(latinToMorae('banana'))).toBe('ba:a na:a na:a'); // romaji wins when the word parses
    expect(show(latinToMorae('lemon'))).toBe(`le:e m:${LIPS} on:o`);
  });
});
