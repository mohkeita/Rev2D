import { it, expect } from 'vitest';
import {
  parseEpisode,
  resolveEpisode,
  compileShot,
  planAssets,
  coverCrop,
  musicGainAt,
  speechIntervals,
} from '../index.js';
const input = {
  version: 1,
  id: 'demo',
  narration: { audio: 'voice.wav' },
  shots: [
    {
      id: 'A',
      start: 0,
      end: '@text:second',
      background: 'room',
      characters: [{ id: 'hero', pose: 'standing', at: 'sofa_left', gestures: [{ name: 'wave', t: 0 }] }],
    },
    { id: 'B', start: '@text:second', end: '@end' },
  ],
};
const words = [
  { word: 'First', start: 0, end: 0.7 },
  { word: 'second', start: 1, end: 1.4 },
];
it('resolves cues to shared frame boundaries, preserves silence at @end, and compiles explicit acting scenes', () => {
  const p = parseEpisode(input);
  expect(p.diagnostics).toEqual([]);
  const r = resolveEpisode(p.episode!, words, 2);
  expect(r.diagnostics).toEqual([]);
  expect(r.timeline!.shots.map((s) => [s.startFrame, s.endFrame])).toEqual([
    [0, 24],
    [24, 48],
  ]);
  const c = compileShot(r.timeline!, r.timeline!.shots[0]);
  expect(c.diagnostics).toEqual([]);
  expect(c.scene!.layers![1]).toMatchObject({
    type: 'character',
    at: 'room.sofa_left',
    animations: ['idle_alive', { gesture: 'wave', t: 0 }],
  });
  expect(planAssets(r.timeline!, undefined)).toEqual([
    { kind: 'background', id: 'room', shots: ['A'] },
    { kind: 'character', id: 'hero', pose: 'standing', shots: ['A'] },
  ]);
});
it('diagnoses gaps, overlaps, duplicate ids, missing cues and wrong narration duration', () => {
  for (const [change, code] of [
    [{ start: 1.2 }, 'episode-gap'],
    [{ start: -0.2 }, 'episode-overlap'],
    [{ id: 'A' }, 'episode-duplicate-id'],
    [{ start: '@text:unknown' }, 'episode-cue-not-found'],
    [{ end: 3 }, 'episode-duration'],
  ] as const) {
    const raw = structuredClone(input);
    Object.assign(raw.shots[1], change);
    const p = parseEpisode(raw);
    expect(resolveEpisode(p.episode!, words, 2).diagnostics.map((d) => d.code)).toContain(code);
  }
});
it('uses cumulative frame rounding rather than independently rounding shot durations', () => {
  const p = parseEpisode({
    version: 1,
    id: 'frames',
    fps: 24,
    narration: { audio: 'v.wav' },
    shots: [
      { id: 'A', start: 0, end: 0.11 },
      { id: 'B', start: 0.11, end: 0.23 },
      { id: 'C', start: 0.23, end: 0.34 },
    ],
  }).episode!;
  const r = resolveEpisode(p, [], 0.34).timeline!;
  expect(r.shots.map((s) => s.frames)).toEqual([3, 3, 2]);
  expect(r.frames).toBe(8);
});
it('rejects unsupported and unsafe storyboard fields and long transitions', () => {
  expect(parseEpisode({ ...input, narration: { audio: 'https://example.com/v.wav' } }).episode).toBeNull();
  const raw = structuredClone(input) as any;
  raw.shots[1].transition = { type: 'dissolve', duration: 2 };
  expect(resolveEpisode(parseEpisode(raw).episode!, words, 2).diagnostics.map((d) => d.code)).toContain(
    'episode-transition-range',
  );
});
it('keeps crop focus inside source bounds and ducks only aligned speech', () => {
  expect(coverCrop([1920, 1080], [1080, 1920], [0, 0])[0]).toBe(0);
  const crop = coverCrop([1920, 1080], [1080, 1920], [1, 1]);
  expect(crop[0] + crop[2]).toBe(1920);
  const spans = speechIntervals([{ word: 'one', start: 1, end: 2 }], 4);
  expect(musicGainAt(1.5, 0.4, 0.5, spans)).toBe(0.2);
  expect(musicGainAt(3, 0.4, 0.5, spans)).toBe(0.4);
});
