/** Episode acceptance tests use original colours, the original shared demo, and local encoders. */
import { it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseEpisode } from '../src/episode/index.js';
import {
  buildEpisode,
  validateEpisode,
  planEpisode,
  readEpisodeBuild,
  writeAtomic,
  jsonFile,
  digest,
} from '../src/node/episode.js';
import { renderEpisode } from '../src/node/episode-render.js';
import { assembleEpisode, shotCrop } from '../src/node/episode-assemble.js';
import { reportEpisode, episodeThumbnails } from '../src/node/episode-report.js';
import { findFfmpeg } from '../src/node/video.js';
import { runProgram, probeMedia, encoderArgs } from '../src/node/episode-media.js';
import { loadScene } from '../src/node/scene.js';
import { syntheticWav } from '../scripts/examples/scene-assets.js';
import { decodePNG } from '../src/render/png.js';
let root: string, encoder: string | undefined;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'rev2d-episode-test-'));
  try {
    encoder = await findFfmpeg();
  } catch {
    /* optional */
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const simple = (id = 'simple') => ({
  version: 1,
  id,
  size: [160, 90],
  fps: 24,
  narration: { audio: 'voice.wav' },
  shots: [
    { id: 'A', start: 0, end: 0.5, layers: [{ id: 'red', type: 'color', color: '#ff0000' }] },
    { id: 'B', start: 0.5, end: 1, layers: [{ id: 'blue', type: 'color', color: '#0000ff' }] },
  ],
});
async function pack(name: string, raw: unknown = simple(name)) {
  const dir = path.join(root, name);
  await mkdir(dir);
  await writeFile(path.join(dir, 'voice.wav'), syntheticWav(1));
  await writeAtomic(path.join(dir, 'storyboard.json'), raw);
  return { dir, file: path.join(dir, 'storyboard.json'), build: path.join(dir, 'episode') };
}
it('validates virtual scenes without creating check directories and rebases authored resources', async () => {
  const p = await pack('virtual');
  const scene = path.join(p.dir, 'original.json');
  await writeAtomic(scene, {
    version: 1,
    width: 160,
    height: 90,
    duration: 1,
    layers: [{ id: 'red', type: 'color', color: '#ff0000' }],
  });
  const original = digest(await readFile(scene));
  const raw = simple('virtual') as Record<string, unknown>;
  raw.shots = [{ id: 'A', start: 0, end: 1, scene: 'original.json' }];
  await writeAtomic(p.file, raw);
  expect((await validateEpisode(p.file)).ok).toBe(true);
  expect(existsSync(path.join(p.dir, '.episode-check'))).toBe(false);
  await buildEpisode(p.file, p.build);
  const built = (await jsonFile(path.join(p.build, 'shots/A/scene.json'))) as {
    duration: number;
    narration: { audio: string };
  };
  expect(built.duration).toBe(1);
  expect(path.resolve(p.build, 'shots/A', built.narration.audio)).toBe(path.join(p.dir, 'voice.wav'));
  expect(digest(await readFile(scene))).toBe(original);
  expect(
    (await loadScene(scene, { version: 1, width: 160, height: 90, duration: 1, layers: [] })).prepared,
  ).not.toBeNull();
});
it('reports exact missing assets and writes actionable character, prop, background and native UI requests', async () => {
  const p = await pack('missing', {
    ...simple('missing'),
    shots: [
      {
        id: 'A',
        start: 0,
        end: 1,
        background: 'room',
        characters: [{ id: 'hero', pose: 'sitting_phone' }],
        props: [{ ref: 'box' }],
        ui: [{ ref: 'progress' }],
      },
    ],
  });
  const result = await planEpisode(p.file, path.join(p.dir, 'requests'));
  expect(result.missing).toEqual([
    { kind: 'background', id: 'room', shots: ['A'] },
    { kind: 'character', id: 'hero', pose: 'sitting_phone', shots: ['A'] },
    { kind: 'prop', id: 'box', shots: ['A'] },
    { kind: 'ui', id: 'progress', shots: ['A'] },
  ]);
  expect(result.requests).toHaveLength(4);
  expect((await validateEpisode(p.file)).ok).toBe(false);
  expect(await readFile(path.join(p.dir, 'requests/004-ui-progress/prompt.txt'), 'utf8')).toContain(
    'Rev2D model',
  );
});
it('build only is explicit, generated manual edits require force, and malformed metadata is refused', async () => {
  const p = await pack('managed');
  await buildEpisode(p.file, p.build, { only: ['A'] });
  expect((await readEpisodeBuild(p.build)).built).toEqual(['A']);
  const f = path.join(p.build, 'shots/A/scene.json');
  await writeFile(f, (await readFile(f, 'utf8')).replace('#ff0000', '#dd0000'));
  await expect(buildEpisode(p.file, p.build)).rejects.toThrow('local edits');
  await buildEpisode(p.file, p.build, { force: true });
  await expect(buildEpisode(p.file, p.build, { only: ['missing'] })).rejects.toThrow('unknown shot');
  const manifest = (await jsonFile(path.join(p.build, 'episode.json'))) as {
    shots: { shot: { id: string } }[];
  };
  manifest.shots[0].shot.id = '../escape';
  await writeAtomic(path.join(p.build, 'episode.json'), manifest);
  await expect(readEpisodeBuild(p.build)).rejects.toThrow('valid managed');
});
it('renders separate workers, reuses all cache entries, changes one shot only, verifies output bytes and exact cut frames', async ({
  skip,
}) => {
  if (!encoder) skip();
  const p = await pack('cache');
  await buildEpisode(p.file, p.build);
  expect((await renderEpisode(p.build, { jobs: 2 })).rendered).toEqual(['A', 'B']);
  expect((await renderEpisode(p.build)).cached).toEqual(['A', 'B']);
  const f = path.join(p.build, 'shots/B/scene.json');
  await writeFile(f, (await readFile(f, 'utf8')).replace('#0000ff', '#00ff00'));
  expect((await renderEpisode(p.build)).rendered).toEqual(['B']);
  const output = path.join(p.dir, 'final.mp4'),
    assembled = await assembleEpisode(p.build, output);
  expect(assembled.frames).toBe(24);
  expect(assembled.audio).toBe(true);
  expect(assembled.audioDuration).toBeCloseTo(1, 1);
  expect(assembled.cuts.map((c) => c.frame)).toEqual([0, 12]);
  const frames = path.join(p.dir, 'cut-%02d.png');
  await runProgram(encoder!, [
    ...encoderArgs,
    '-i',
    output,
    '-vf',
    "select='eq(n,11)+eq(n,12)'",
    '-vsync',
    '0',
    frames,
  ]);
  const before = decodePNG(await readFile(path.join(p.dir, 'cut-01.png'))),
    after = decodePNG(await readFile(path.join(p.dir, 'cut-02.png')));
  expect(before.data[0]).toBeGreaterThan(240);
  expect(before.data[1]).toBeLessThan(12);
  expect(after.data[0]).toBeLessThan(12);
  expect(after.data[1]).toBeGreaterThan(240);
  await expect(assembleEpisode(p.build, output)).rejects.toThrow();
  const video = path.join(p.build, 'shots/A/shot.mp4');
  await writeFile(video, 'tampered');
  expect((await renderEpisode(p.build)).rendered).toEqual(['A']);
  await writeFile(path.join(p.dir, 'voice.wav'), syntheticWav(1.1));
  await expect(renderEpisode(p.build)).rejects.toThrow('inputs changed');
}, 60000);
it('keeps transition duration, mixes sidechain audio, exports valid 1080x1920 and makes readable review indexes', async ({
  skip,
}) => {
  if (!encoder) skip();
  const raw = {
    ...simple('transitions'),
    music: { src: 'music.wav', gain: 0.3, duck: { under: 'narration', amount: 0.5 } },
    shots: [
      { id: 'A', start: 0, end: 0.5, layers: [{ id: 'red', type: 'color', color: '#ff0000' }] },
      {
        id: 'B',
        start: 0.5,
        end: 1,
        transition: { type: 'dissolve', duration: 0.125 },
        layers: [{ id: 'blue', type: 'color', color: '#0000ff' }],
      },
    ],
  };
  const p = await pack('transitions', raw);
  await writeFile(path.join(p.dir, 'music.wav'), syntheticWav(1));
  await buildEpisode(p.file, p.build);
  await renderEpisode(p.build);
  const final = await assembleEpisode(p.build, path.join(p.dir, 'portrait.mp4'), { size: [1080, 1920] });
  expect(final).toMatchObject({ width: 1080, height: 1920, frames: 24, audio: true });
  expect(final.videoDuration).toBeCloseTo(1, 4);
  const report = await reportEpisode(p.build, path.join(p.dir, 'report'));
  expect(report.shots).toBe(2);
  expect(await readFile(report.index, 'utf8')).toContain('A/sheet.png');
  expect(existsSync(path.join(p.dir, 'report/B/analysis.json'))).toBe(true);
  expect((await episodeThumbnails(p.build, path.join(p.dir, 'thumbs'))).files).toHaveLength(2);
}, 60000);
it('warns when a focus-aware portrait crop excludes an important prop', async () => {
  const raw = {
    ...simple('crop'),
    shots: [
      {
        id: 'A',
        start: 0,
        end: 1,
        focus: [0.9, 0.5],
        layers: [{ id: 'important', type: 'image', src: 'image.png', at: [0, 45], anchor: 'center' }],
      },
    ],
  };
  const p = await pack('crop', raw);
  const { encodePNG } = await import('../src/render/png.js');
  await writeFile(
    path.join(p.dir, 'image.png'),
    encodePNG({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) }),
  );
  await buildEpisode(p.file, p.build);
  const crop = await shotCrop(
    p.build,
    await readEpisodeBuild(p.build),
    (await readEpisodeBuild(p.build)).shots[0],
    [1080, 1920],
  );
  expect(crop.diagnostics.map((d) => d.code)).toContain('episode-vertical-crop');
});
it('ships a six-shot original example with external, two-character and phone scenes and cue-aligned cuts', async () => {
  const file = path.resolve('examples/episodes/demo/storyboard.json'),
    p = parseEpisode(await jsonFile(file)).episode!;
  expect(p.shots).toHaveLength(6);
  expect(p.shots.some((s) => s.external)).toBe(true);
  expect(p.shots.some((s) => s.characters.length === 2)).toBe(true);
  expect(p.shots.some((s) => s.ui.some((u) => u.ref === 'phone_progress'))).toBe(true);
  const v = await validateEpisode(file);
  expect(v.ok).toBe(true);
  if ('shots' in v) expect(v.shots?.map((s) => s.startFrame)).toEqual([0, 48, 96, 144, 192, 240]);
});

it('fingerprints a transitive model texture only for the shot using it and enforces scene frame ownership', async () => {
  const p = await pack('transitive');
  const { encodePNG } = await import('../src/render/png.js');
  const image = (value: number) =>
    encodePNG({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(value) });
  await writeFile(path.join(p.dir, 'texture.png'), image(255));
  await writeAtomic(path.join(p.dir, 'model.r2d.json'), {
    format: 'rev2d',
    version: 1,
    meta: { name: 'original', width: 8, height: 8 },
    textures: [{ id: 'tex', path: 'texture.png' }],
    parts: [{ id: 'body', shape: { type: 'image', texture: 'tex', x: 0, y: 0, w: 8, h: 8 } }],
  });
  const raw = simple('transitive');
  raw.shots[0].layers = [
    { id: 'actor', type: 'model', src: 'model.r2d.json' },
  ] as unknown as (typeof raw.shots)[0]['layers'];
  await writeAtomic(p.file, raw);
  await buildEpisode(p.file, p.build);
  const { shotFingerprint } = await import('../src/node/episode-render.js'),
    b = await readEpisodeBuild(p.build);
  const old = await Promise.all(b.shots.map((t) => shotFingerprint(p.build, b, t, 'test-engine')));
  await writeFile(path.join(p.dir, 'texture.png'), image(128));
  const next = await Promise.all(b.shots.map((t) => shotFingerprint(p.build, b, t, 'test-engine')));
  expect(next[0].fingerprint).not.toBe(old[0].fingerprint);
  expect(next[1].fingerprint).toBe(old[1].fingerprint);
  const scene = path.join(p.build, 'shots/A/scene.json'),
    doc = (await jsonFile(scene)) as { duration: number };
  doc.duration = 2;
  await writeAtomic(scene, doc);
  await expect(shotFingerprint(p.build, b, b.shots[0], 'test-engine')).rejects.toThrow('timing differs');
});

it('round-trips an audio end between frame boundaries without replacing unquantized cue times', async () => {
  const p = await pack('fractional-audio', {
    ...simple('fractional-audio'),
    shots: [{ id: 'A', start: 0, end: '@end', layers: [] }],
  });
  await writeFile(path.join(p.dir, 'voice.wav'), syntheticWav(1.01));
  await buildEpisode(p.file, p.build);
  const b = await readEpisodeBuild(p.build);
  expect(b.audioDuration).toBe(1.01);
  expect(b.duration).toBe(1);
  expect(b.frames).toBe(24);
  expect(b.shots[0].end).toBe(1.01);
});

it('chains every transition type without fractional time-base drift or shifted cuts', async ({ skip }) => {
  if (!encoder) skip();
  const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'];
  const transitions = ['cut', 'dissolve', 'whip-left', 'whip-right', 'dip-to-black', 'cut'];
  const p = await pack('all-transitions', {
    ...simple('all-transitions'),
    shots: colours.map((color, i) => ({
      id: 'S' + i,
      start: i * 0.5,
      end: (i + 1) * 0.5,
      transition: { type: transitions[i], duration: 0.125 },
      layers: [{ id: 'colour', type: 'color', color }],
    })),
  });
  await writeFile(path.join(p.dir, 'voice.wav'), syntheticWav(3));
  await buildEpisode(p.file, p.build);
  await renderEpisode(p.build, { jobs: 2 });
  const a = await assembleEpisode(p.build, path.join(p.dir, 'final.mp4'));
  expect(a.frames).toBe(72);
  expect(a.videoDuration).toBe(3);
  expect(a.cuts.map((c) => c.frame)).toEqual([0, 12, 24, 36, 48, 60]);
  const image = path.join(p.dir, 'cut-into-second.png');
  await runProgram(encoder!, [
    ...encoderArgs,
    '-i',
    a.file,
    '-vf',
    "select='eq(n,15)'",
    '-frames:v',
    '1',
    image,
  ]);
  const rgba = decodePNG(await readFile(image));
  expect(rgba.data[1]).toBeGreaterThan(240);
  expect(rgba.data[0]).toBeLessThan(12);
}, 60000);
