import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Rig } from '../../core/rig.js';
import { AnimationSchema, EaseSchema } from '../../core/schema.js';
import { formatDiagnostics, validateModel } from '../../core/validate.js';
import { applyOps } from '../../ops/index.js';
import {
  MORA_BEATS,
  DEFAULT_LIPSYNC_RATE,
  VISEME_SHAPES,
  lipSyncFromMorae,
  lipSyncFromText,
  moraeBeats,
  mouthCurves,
  mouthShapeAt,
  sampleMouthCurve,
  textToMorae,
  type LipSyncResult,
  type Mora,
  type MouthCurveKey,
} from '../index.js';

interface Key {
  t: number;
  v: number;
  ease?: unknown;
}
interface Track {
  target: string;
  keys: Key[];
}
interface Animation {
  id: string;
  duration: number;
  loop: boolean;
  description?: string;
  tracks: Track[];
}

const anim = (r: LipSyncResult): Animation => r.animation as unknown as Animation;
const track = (r: LipSyncResult, param: string): Track => {
  const found = anim(r).tracks.find((t) => t.target === `param:${param}`);
  if (!found) throw new Error(`no track for ${param}`);
  return found;
};
const points = (keys: readonly MouthCurveKey[]): Array<[number, number]> => keys.map((k) => [k.t, k.v]);
const isRounded = (v: number): boolean => Math.round(v * 1000) / 1000 === v;

const HANA = fileURLToPath(new URL('../../../examples/hana/hana.r2d.json', import.meta.url));

/** Add the animations to `doc` with the "add animation" op, validate the result and compile it; fails on any error or warning. */
function rigWith(doc: unknown, results: LipSyncResult[]): Rig {
  const applied = applyOps(doc, results.map((r) => ({ op: 'add', kind: 'animation', value: r.animation })), { validate: false });
  expect(applied.ok, applied.results.map((r) => `${r.message} ${r.hint ?? ''}`).join('; ')).toBe(true);
  const { model, diagnostics } = validateModel(applied.doc);
  const problems = diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warning');
  expect(problems, formatDiagnostics(problems)).toEqual([]);
  if (!model) throw new Error('the model with the lip-sync animations does not validate');
  return new Rig(model);
}

/** The smallest model the animations fit: the two mouth parameters and nothing to draw (fast to pose). */
const mouthOnlyDoc = (): unknown => ({
  format: 'rev2d',
  version: 1,
  meta: { name: 'mouth', width: 64, height: 64 },
  parameters: [
    { id: 'MouthOpen', min: 0, max: 1, default: 0 },
    { id: 'MouthForm', min: -1, max: 1, default: 0 },
  ],
});

describe('mouthCurves: the shape of a beat', () => {
  it('one vowel: reach the shape 35% in, hold, close by the end', () => {
    const { open, form, beats } = mouthCurves([{ text: 'あ', viseme: 'a', beats: 1 }]);
    expect(beats).toBe(1);
    expect(open).toEqual([
      { t: 0, v: 0, ease: 'outCubic' },
      { t: 0.35, v: 1, ease: 'linear' },
      { t: 0.55, v: 1, ease: 'inOutSine' },
      { t: 1, v: 0, ease: 'linear' },
    ]);
    // "a" has form 0: the form track never moves.
    expect(form).toEqual([{ t: 0, v: 0, ease: 'linear' }]);
  });

  it('the form follows the same timing', () => {
    const { open, form } = mouthCurves([{ text: 'い', viseme: 'i', beats: 1 }]);
    expect(points(open)).toEqual([[0, 0], [0.35, 0.35], [0.55, 0.35], [1, 0]]);
    expect(points(form)).toEqual([[0, 0], [0.35, 1], [0.55, 1], [1, 0]]);
  });

  it('starts and ends closed and neutral whatever the text', () => {
    for (const text of ['あ', 'いいい', 'おん', 'っあ', 'a, b. c!', '안녕하세요', '밥', '。あ。']) {
      const { morae } = textToMorae(text);
      const curves = mouthCurves(morae);
      for (const keys of [curves.open, curves.form]) {
        expect(keys[0], text).toMatchObject({ t: 0, v: 0 });
        expect(keys[keys.length - 1].v, text).toBe(0);
        expect(keys[keys.length - 1].t, text).toBeLessThanOrEqual(curves.beats);
      }
      expect(curves.beats, text).toBeCloseTo(moraeBeats(morae), 9);
    }
  });

  it('a beat relaxes a little toward the next shape before that beat starts', () => {
    const { open, form } = mouthCurves(textToMorae('あい').morae);
    // a (open 1, form 0) -> i (open 0.35, form 1): the boundary at beat 1 lies 35% of the way.
    expect(points(open).slice(0, 5)).toEqual([[0, 0], [0.35, 1], [0.7, 1], [1, expect.closeTo(1 - 0.35 * 0.65, 9)], [1.35, 0.35]]);
    expect(points(form).slice(0, 4)).toEqual([[0, 0], [0.7, 0], [1, expect.closeTo(0.35, 9)], [1.35, 1]]);
    expect(open[2].ease).toBe('inSine');
    expect(open[3].ease).toBe('outCubic');
  });

  it('equal consecutive vowels re-articulate with a small dip', () => {
    const curves = mouthCurves(textToMorae('ああ').morae);
    expect(points(curves.open)).toEqual([[0, 0], [0.35, 1], [0.7, 1], [1, 0.7], [1.35, 1], [1.55, 1], [2, 0]]);
    expect(curves.open[2].ease).toBe('inOutSine');
    // The dip is the lowest point between the two holds and the mouth never closes there.
    let lowest = 1;
    for (let t = 0.35; t <= 1.55; t += 0.01) lowest = Math.min(lowest, sampleMouthCurve(curves.open, t));
    expect(lowest).toBeCloseTo(0.7, 2);
    // い い: the same, scaled by the opening of "i".
    const ii = mouthCurves(textToMorae('いい').morae);
    expect(sampleMouthCurve(ii.open, 1)).toBeCloseTo(0.35 * 0.7, 9);
    expect(sampleMouthCurve(ii.form, 1)).toBe(1);
  });

  it('a long vowel holds instead of re-articulating', () => {
    const curves = mouthCurves(textToMorae('あー').morae);
    expect(curves.beats).toBe(2);
    expect(points(curves.open)).toEqual([[0, 0], [0.35, 1], [1.55, 1], [2, 0]]);
    for (let t = 0.35; t <= 1.55; t += 0.05) expect(sampleMouthCurve(curves.open, t)).toBe(1);
  });

  it('rests close the mouth', () => {
    const { morae } = textToMorae('あ、あ');
    expect(morae.map((m) => m.beats)).toEqual([1, MORA_BEATS.comma, 1]);
    const curves = mouthCurves(morae);
    // Half closed where the rest starts, closed 70% of a beat into it, closed until the next beat starts.
    expect(sampleMouthCurve(curves.open, 1)).toBeCloseTo(0.5, 9);
    for (let t = 1.7; t <= 2.5; t += 0.05) expect(sampleMouthCurve(curves.open, t)).toBe(0);
    expect(sampleMouthCurve(curves.open, 2.5 + 0.35)).toBe(1);
  });

  it('ん and っ close the mouth and keep the lips between the shapes around them', () => {
    const curves = mouthCurves(textToMorae('いんい').morae);
    for (let t = 1.35; t <= 2; t += 0.05) expect(sampleMouthCurve(curves.open, t)).toBe(0);
    // Smile before and after: the form does not wobble through neutral during the closure.
    for (let t = 0.35; t <= 2.5; t += 0.05) expect(sampleMouthCurve(curves.form, t)).toBe(1);

    const stop = mouthCurves(textToMorae('あって').morae);
    const closure = 1 + MORA_BEATS.sokuon * 0.35;
    expect(sampleMouthCurve(stop.open, closure)).toBe(0);
    expect(sampleMouthCurve(stop.open, 1 + MORA_BEATS.sokuon)).toBe(0);
    expect(sampleMouthCurve(stop.open, 1 + MORA_BEATS.sokuon + 0.35)).toBeCloseTo(VISEME_SHAPES.e.open, 9);
  });

  it('a pause relaxes the lips to neutral', () => {
    const curves = mouthCurves(textToMorae('い。い').morae);
    expect(sampleMouthCurve(curves.form, 1 + 0.7)).toBe(0);
    expect(sampleMouthCurve(curves.form, 2)).toBe(0);
  });

  it('every vowel reaches the shape of the viseme table', () => {
    const { morae } = textToMorae('あ、い、う、え、お');
    const curves = mouthCurves(morae);
    let start = 0;
    for (const m of morae) {
      if (m.viseme !== 'rest') {
        expect(sampleMouthCurve(curves.open, start + 0.5), m.text).toBeCloseTo(VISEME_SHAPES[m.viseme].open, 9);
        expect(sampleMouthCurve(curves.form, start + 0.5), m.text).toBeCloseTo(VISEME_SHAPES[m.viseme].form, 9);
      }
      start += m.beats;
    }
  });

  it('key times increase and values stay in range', () => {
    for (const text of ['こんにちは、げんきですか？', '안녕하세요 반갑습니다', 'Hello, my name is Hana!', 'あっ、ラーメン！！']) {
      const curves = mouthCurves(textToMorae(text).morae);
      for (const [keys, lo] of [[curves.open, 0], [curves.form, -1]] as const) {
        keys.forEach((k, i) => {
          if (i > 0) expect(k.t, text).toBeGreaterThan(keys[i - 1].t);
          expect(k.v).toBeGreaterThanOrEqual(lo);
          expect(k.v).toBeLessThanOrEqual(1);
        });
      }
    }
  });

  it('gain scales the opening and never exceeds 1', () => {
    const morae = textToMorae('あい').morae;
    expect(sampleMouthCurve(mouthCurves(morae, 0.5).open, 0.5)).toBe(0.5);
    expect(sampleMouthCurve(mouthCurves(morae, 0.5).form, 1.5)).toBe(1);
    expect(sampleMouthCurve(mouthCurves(morae, 3).open, 0.5)).toBe(1);
    expect(sampleMouthCurve(mouthCurves(morae, 3).open, 1.5)).toBe(1);
    expect(mouthCurves(morae, 0).open).toEqual([{ t: 0, v: 0, ease: 'linear' }]);
  });

  it('skips beats without a positive length and treats an unknown viseme as a rest', () => {
    const morae = [
      { text: 'a', viseme: 'a', beats: 1 },
      { text: 'x', viseme: 'i', beats: 0 },
      { text: 'y', viseme: 'zz', beats: 1 },
    ] as Mora[];
    const curves = mouthCurves(morae);
    expect(curves.beats).toBe(2);
    expect(sampleMouthCurve(curves.open, 1.8)).toBe(0);
    expect(curves.form).toEqual([{ t: 0, v: 0, ease: 'linear' }]);
  });
});

describe('lipSyncFromText: timing arithmetic', () => {
  it('the duration is beats / rate', () => {
    expect(lipSyncFromText('あいうえお', { rate: 5 }).duration).toBe(1);
    expect(lipSyncFromText('あいうえお', { rate: 10 }).duration).toBe(0.5);
    expect(lipSyncFromText('あいうえお').duration).toBe(0.714); // 5 / 7, rounded
    expect(DEFAULT_LIPSYNC_RATE).toBe(7);
    const mixed = lipSyncFromText('ラーメン、きって', { rate: 4 });
    expect(mixed.duration).toBe((4 + MORA_BEATS.comma + 2 + MORA_BEATS.sokuon) / 4);
    expect(anim(mixed).duration).toBe(mixed.duration);
  });

  it('key times are beat times / rate', () => {
    const r = lipSyncFromText('あ', { rate: 2 });
    expect(anim(r)).toEqual({
      id: 'lipsync',
      duration: 0.5,
      loop: false,
      description: 'Lip sync of "あ" (1 beat at 2 beats/s).',
      tracks: [
        {
          target: 'param:MouthOpen',
          keys: [
            { t: 0, v: 0, ease: 'outCubic' },
            { t: 0.175, v: 1 },
            { t: 0.275, v: 1, ease: 'inOutSine' },
            { t: 0.5, v: 0 },
          ],
        },
        { target: 'param:MouthForm', keys: [{ t: 0, v: 0 }] },
      ],
    });
  });

  it('the n-th beat starts at n / rate', () => {
    // An order in which the opening changes at every beat, so each beat has a key where it is reached.
    const r = lipSyncFromText('あえいおう', { rate: 4 });
    const open = track(r, 'MouthOpen').keys;
    const shapes = ['a', 'e', 'i', 'o', 'u'] as const;
    shapes.forEach((v, n) => {
      // The shape is reached 35% into the beat (key times are rounded to a millisecond).
      const reached = open.find((k) => Math.abs(k.t - (n + 0.35) / 4) < 0.00051);
      expect(reached, `beat ${n}`).toBeDefined();
      expect(reached!.v).toBe(VISEME_SHAPES[v].open);
    });
  });

  it('returns the beats and the unknown characters of the text', () => {
    const r = lipSyncFromText('今あ');
    expect(r.unknown).toEqual(['今']);
    expect(r.morae).toEqual(textToMorae('今あ').morae);
    expect(r.duration).toBe(0.214); // 1.5 beats / 7
    expect(lipSyncFromText('こんにちは world', { script: 'kana' }).unknown).toEqual(['w', 'o', 'r', 'l', 'd']);
  });
});

describe('lipSyncFromText: the animation', () => {
  const samples = ['こんにちは、げんきですか？', 'あ', 'ああああ', 'きゃっ！', '안녕하세요 반갑습니다', 'Hello, my name is Hana!', 'konnichiwa', '…', 'あ。'];

  it('is a valid Rev2D animation with eases the schema knows', () => {
    for (const text of samples) {
      const r = lipSyncFromText(text);
      const parsed = AnimationSchema.safeParse(r.animation);
      expect(parsed.success, text).toBe(true);
      for (const t of anim(r).tracks) {
        for (const k of t.keys) {
          if (k.ease !== undefined) {
            expect(typeof k.ease, text).toBe('string');
            expect(EaseSchema.safeParse(k.ease).success, `${text}: ${String(k.ease)}`).toBe(true);
          }
        }
      }
    }
  });

  it('rounds times and values to 3 decimals, with strictly increasing times inside the duration', () => {
    const wrong: string[] = [];
    let keys = 0;
    for (const text of samples) {
      for (const rate of [3, 7, 7.3, 11.9]) {
        const r = lipSyncFromText(text, { rate });
        if (!isRounded(r.duration)) wrong.push(`${text} @${rate}: duration ${r.duration}`);
        for (const t of anim(r).tracks) {
          t.keys.forEach((k, i) => {
            keys++;
            const ok =
              isRounded(k.t) &&
              isRounded(k.v) &&
              !Object.is(k.t, -0) &&
              !Object.is(k.v, -0) &&
              k.t >= 0 &&
              k.t <= r.duration &&
              (i === 0 || k.t > t.keys[i - 1].t);
            if (!ok) wrong.push(`${text} @${rate} ${t.target}: key ${i} ${JSON.stringify(k)}`);
          });
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(keys).toBeGreaterThan(500);
  });

  it('starts and ends closed', () => {
    for (const text of samples) {
      const r = lipSyncFromText(text);
      for (const t of anim(r).tracks) {
        expect(t.keys[0], text).toMatchObject({ t: 0, v: 0 });
        expect(t.keys[t.keys.length - 1].v, text).toBe(0);
      }
      const open = track(r, 'MouthOpen').keys;
      // Speech that ends on a vowel closes exactly at the end.
      if (r.morae.length > 0 && r.morae[r.morae.length - 1].viseme !== 'rest' && r.morae[r.morae.length - 1].viseme !== 'n') {
        expect(open[open.length - 1].t, text).toBe(r.duration);
      }
    }
  });

  it('options: id, parameter ids, loop, gain', () => {
    const r = lipSyncFromText('あい', { id: 'hello', openParam: 'Jaw', formParam: 'Lips', loop: true, gain: 0.5, rate: 5 });
    expect(anim(r).id).toBe('hello');
    expect(anim(r).loop).toBe(true);
    expect(anim(r).tracks.map((t) => t.target)).toEqual(['param:Jaw', 'param:Lips']);
    expect(Math.max(...track(r, 'Jaw').keys.map((k) => k.v))).toBe(0.5);
    expect(Math.max(...track(r, 'Lips').keys.map((k) => k.v))).toBe(1);
    // Defaults
    const d = anim(lipSyncFromText('あ'));
    expect([d.id, d.loop, d.tracks.map((t) => t.target)]).toEqual(['lipsync', false, ['param:MouthOpen', 'param:MouthForm']]);
  });

  it('formParam "" leaves the form track out', () => {
    const r = lipSyncFromText('あいう', { formParam: '' });
    expect(anim(r).tracks.map((t) => t.target)).toEqual(['param:MouthOpen']);
  });

  it('rejects a rate or gain that makes no sense', () => {
    expect(() => lipSyncFromText('あ', { rate: 0 })).toThrow(RangeError);
    expect(() => lipSyncFromText('あ', { rate: -3 })).toThrow(/"rate" must be a positive number of beats per second, got -3/);
    expect(() => lipSyncFromText('あ', { rate: Number.NaN })).toThrow(RangeError);
    expect(() => lipSyncFromText('あ', { rate: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => lipSyncFromText('あ', { gain: -1 })).toThrow(/"gain" must be a number >= 0/);
    expect(() => lipSyncFromText('あ', { openParam: '' })).toThrow(/"openParam" must be a parameter id/);
  });

  it('empty text still gives a valid, closed animation', () => {
    for (const text of ['', '   ']) {
      const r = lipSyncFromText(text);
      expect(r.morae).toEqual([]);
      expect(r.duration).toBe(0.1);
      expect(anim(r).tracks.map((t) => t.keys)).toEqual([[{ t: 0, v: 0 }], [{ t: 0, v: 0 }]]);
      expect(AnimationSchema.safeParse(r.animation).success).toBe(true);
    }
  });

  it('describes itself, shortening long text', () => {
    expect(anim(lipSyncFromText('こんにちは')).description).toBe('Lip sync of "こんにちは" (5 beats at 7 beats/s).');
    const long = anim(lipSyncFromText('あ'.repeat(100), { rate: 8 })).description ?? '';
    expect(long).toBe(`Lip sync of "${'あ'.repeat(40)}…" (100 beats at 8 beats/s).`);
    expect(anim(lipSyncFromText('a\n  b')).description).toContain('"a b"');
  });

  it('a very high rate still gives strictly increasing key times and closed ends', () => {
    // Beats shorter than the rounding step: keys fall on the same millisecond.
    for (const rate of [400, 2500, 50000]) {
      const r = lipSyncFromText('こんにちは、げんきですか？', { rate });
      for (const t of anim(r).tracks) {
        t.keys.forEach((k, i) => {
          if (i > 0) expect(k.t, `rate ${rate}`).toBeGreaterThan(t.keys[i - 1].t);
        });
        expect(t.keys[0], `rate ${rate}`).toMatchObject({ t: 0, v: 0 });
        expect(t.keys[t.keys.length - 1].v, `rate ${rate}`).toBe(0);
      }
      expect(AnimationSchema.safeParse(r.animation).success).toBe(true);
      rigWith(mouthOnlyDoc(), [r]);
    }
  });

  it('is deterministic', () => {
    for (const text of samples) {
      expect(JSON.stringify(lipSyncFromText(text, { rate: 6.5 }))).toBe(JSON.stringify(lipSyncFromText(text, { rate: 6.5 })));
    }
  });

  it('does not share state between results', () => {
    const a = lipSyncFromText('あい');
    const before = JSON.stringify(a);
    const b = lipSyncFromText('あい');
    track(b, 'MouthOpen').keys[0].v = 9;
    b.morae[0].viseme = 'o';
    expect(JSON.stringify(a)).toBe(before);
    expect(JSON.stringify(lipSyncFromText('あい'))).toBe(before);
  });
});

describe('lipSyncFromMorae', () => {
  it('builds the same animation from prepared beats', () => {
    const { morae } = textToMorae('こんにちは');
    const fromText = lipSyncFromText('こんにちは', { rate: 6 });
    const fromMorae = lipSyncFromMorae(morae, { rate: 6 });
    expect(anim(fromMorae).tracks).toEqual(anim(fromText).tracks);
    expect(fromMorae.duration).toBe(fromText.duration);
    expect(fromMorae.unknown).toEqual([]);
    expect(anim(fromMorae).description).toBe('Lip sync (5 beats at 6 beats/s).');
  });

  it('follows edited beats and leaves the input alone', () => {
    const morae: Mora[] = [
      { text: 'a', viseme: 'a', beats: 1 },
      { text: '', viseme: 'rest', beats: 2 },
      { text: 'o', viseme: 'o', beats: 3 },
    ];
    const frozen = JSON.stringify(morae);
    const r = lipSyncFromMorae(morae, { rate: 3 });
    expect(r.duration).toBe(2);
    expect(r.morae).toEqual(morae);
    expect(r.morae).not.toBe(morae);
    expect(JSON.stringify(morae)).toBe(frozen);
  });
});

describe('playback', () => {
  it('the rig plays the animation as the motion mouthShapeAt describes', () => {
    for (const [text, rate] of [['こんにちは、げんきですか？', 6], ['안녕하세요 반갑습니다', 7], ['Hello, my name is Hana!', 9.5]] as const) {
      const result = lipSyncFromText(text, { rate });
      const rig = rigWith(mouthOnlyDoc(), [result]);
      let open = 0;
      for (let t = 0; t <= result.duration + 0.2; t += 1 / 60) {
        const pose = rig.pose({ animations: ['lipsync'], time: t });
        const shape = mouthShapeAt(result.morae, rate, t);
        // The animation's keys are rounded to a millisecond and the motion is fast: allow for that.
        expect(Math.abs(pose.params.MouthOpen - shape.open), `${text}: open at ${t.toFixed(3)}`).toBeLessThan(0.05);
        expect(Math.abs(pose.params.MouthForm - shape.form), `${text}: form at ${t.toFixed(3)}`).toBeLessThan(0.08);
        if (pose.params.MouthOpen > 0.3) open++;
      }
      expect(open, text).toBeGreaterThan(20);
    }
  });
});

describe('on examples/hana', () => {
  const pause = lipSyncFromText('あ、い', { id: 'lip_pause', rate: 4 });
  const added = [
    lipSyncFromText('こんにちは、げんきですか？', { id: 'lip_ja' }),
    lipSyncFromText('안녕하세요 반갑습니다', { id: 'lip_ko' }),
    lipSyncFromText('Hello, my name is Hana!', { id: 'lip_en', loop: true }),
    lipSyncFromText('', { id: 'lip_empty' }),
    lipSyncFromText('きゃっ！らーめん', { id: 'lip_fast', rate: 300 }),
    pause,
  ];
  // Validating and compiling hana takes a moment: once for all tests of this block.
  let compiled: Rig | undefined;
  const hana = (): Rig => (compiled ??= rigWith(JSON.parse(readFileSync(HANA, 'utf8')), added));

  it('the generated animations validate when added to the model (applyOps "add animation" + validateModel)', () => {
    const ids = hana().model.animations.map((a) => a.id);
    for (const r of added) expect(ids).toContain((r.animation as { id: string }).id);
  });

  it('moves the mouth of the model: open on a vowel, closed in a pause and at both ends', () => {
    const rig = hana();
    const at = (time: number) => rig.pose({ animations: ['lip_pause'], time, physics: false });
    const rest = rig.pose({ physics: false });
    const mouth = 'part:mouth.shape.d';
    expect(at(0).properties[mouth]).toBe(rest.properties[mouth]);
    expect(at(pause.duration).properties[mouth]).toBe(rest.properties[mouth]);
    expect(at(0.5 / 4).params).toMatchObject({ MouthOpen: 1, MouthForm: 0 });
    expect(at(0.5 / 4).properties[mouth]).not.toBe(rest.properties[mouth]);
    // The pause (beats 1 .. 2.5): closed from 70% of a beat in.
    expect(at(2 / 4).params.MouthOpen).toBe(0);
    expect(at(2 / 4).properties[mouth]).toBe(rest.properties[mouth]);
    expect(at(3 / 4).params).toMatchObject({ MouthOpen: 0.35, MouthForm: 1 });
  });

  it('only animates the mouth parameters: layered over the idle, the rest of the pose stays', () => {
    const rig = hana();
    const idle = rig.pose({ animations: ['idle'], time: 0.5, physics: false });
    const layered = rig.pose({ animations: ['idle', 'lip_ja'], time: 0.5, physics: false });
    expect(layered.params.MouthOpen).not.toBe(idle.params.MouthOpen);
    for (const [id, value] of Object.entries(idle.params)) {
      if (id !== 'MouthOpen' && id !== 'MouthForm') expect(layered.params[id], id).toBe(value);
    }
  });
});

describe('mouthShapeAt', () => {
  const morae = textToMorae('あい、うえお').morae;

  it('is closed before the start and from the end on', () => {
    const end = moraeBeats(morae) / 5;
    expect(mouthShapeAt(morae, 5, -1)).toEqual({ open: 0, form: 0 });
    expect(mouthShapeAt(morae, 5, 0)).toEqual({ open: 0, form: 0 });
    expect(mouthShapeAt(morae, 5, end)).toEqual({ open: 0, form: 0 });
    expect(mouthShapeAt(morae, 5, end + 10)).toEqual({ open: 0, form: 0 });
    expect(mouthShapeAt([], 5, 0.1)).toEqual({ open: 0, form: 0 });
  });

  it('holds the viseme shape in the middle of a beat', () => {
    expect(mouthShapeAt(morae, 5, 0.5 / 5)).toEqual(VISEME_SHAPES.a);
    expect(mouthShapeAt(morae, 5, 1.5 / 5)).toEqual(VISEME_SHAPES.i);
    expect(mouthShapeAt(morae, 5, (2 + MORA_BEATS.comma + 2.5) / 5)).toEqual(VISEME_SHAPES.o);
    // The same beat at another rate is at another time.
    expect(mouthShapeAt(morae, 10, 1.5 / 10)).toEqual(VISEME_SHAPES.i);
  });

  it('is continuous: no jumps between frames', () => {
    const rate = 7;
    const end = moraeBeats(morae) / rate;
    let prev = mouthShapeAt(morae, rate, 0);
    let openStep = 0;
    let formStep = 0;
    for (let t = 0.001; t <= end + 0.01; t += 0.001) {
      const now = mouthShapeAt(morae, rate, t);
      openStep = Math.max(openStep, Math.abs(now.open - prev.open));
      formStep = Math.max(formStep, Math.abs(now.form - prev.form));
      prev = now;
    }
    // The fastest move (0 -> 1 in 35% of a beat with an ease-out) covers at most 6% per millisecond.
    expect(openStep).toBeLessThan(0.07);
    expect(openStep).toBeGreaterThan(0.01);
    expect(formStep).toBeLessThan(0.13);
  });

  it('never throws on bad input: it returns a closed mouth', () => {
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(mouthShapeAt(morae, rate, 0.1)).toEqual({ open: 0, form: 0 });
    expect(mouthShapeAt(morae, 5, Number.NaN)).toEqual({ open: 0, form: 0 });
    expect(mouthShapeAt(undefined as unknown as Mora[], 5, 0.1)).toEqual({ open: 0, form: 0 });
  });

  it('gives the same answer for an equal array and after the array is edited in place', () => {
    const a = textToMorae('あい').morae;
    const copy = a.map((m) => ({ ...m }));
    const t = 0.5 / 5;
    expect(mouthShapeAt(a, 5, t)).toEqual(VISEME_SHAPES.a);
    expect(mouthShapeAt(copy, 5, t)).toEqual(mouthShapeAt(a, 5, t));
    a[0].viseme = 'o';
    expect(mouthShapeAt(a, 5, t)).toEqual(VISEME_SHAPES.o);
    a[0].beats = 3;
    expect(mouthShapeAt(a, 5, 2 / 5)).toEqual(VISEME_SHAPES.o);
    a.push({ text: 'う', viseme: 'u', beats: 1 });
    expect(mouthShapeAt(a, 5, 4.5 / 5)).toEqual(VISEME_SHAPES.u);
    // and repeated calls agree
    expect(mouthShapeAt(a, 5, 0.123)).toEqual(mouthShapeAt(a, 5, 0.123));
  });

  it('a long text, frame by frame: the same values as sampling its curves', () => {
    const long = textToMorae('こんにちは、げんきですか？'.repeat(200)).morae;
    expect(long.length).toBeGreaterThan(2000);
    const curves = mouthCurves(long);
    let worst = 0;
    let open = 0;
    for (let frame = 0; frame < 600; frame++) {
      const shape = mouthShapeAt(long, 7, frame / 60);
      worst = Math.max(worst, Math.abs(shape.open - sampleMouthCurve(curves.open, (frame / 60) * 7)), Math.abs(shape.form - sampleMouthCurve(curves.form, (frame / 60) * 7)));
      if (shape.open > 0.3) open++;
    }
    expect(worst).toBe(0);
    expect(open).toBeGreaterThan(200);
  });
});
