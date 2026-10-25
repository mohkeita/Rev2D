import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { main } from '../src/cli/main.js';
import { loadScene, requireScene, sceneInfo, analyzeLoadedScene } from '../src/node/scene.js';
import { findFfmpeg, renderScene } from '../src/node/video.js';
import { encodePNG } from '../src/render/png.js';
import { createImage } from '../src/render/browser.js';
import { SceneError } from '../src/scene/schema.js';
import { roomScene, syntheticWav } from '../scripts/examples/scene-assets.js';
import { PACKAGE_ROOT } from '../src/api/templates.js';
import { buildPhoneUI } from '../scripts/examples/phone-ui.js';
import { formatModelJson } from '../src/core/format.js';

let dir: string;
let ffmpeg: string | undefined;
try {
  ffmpeg = await findFfmpeg();
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
} catch {
  ffmpeg = undefined;
  console.warn('scene video integration skipped: ffmpeg and ffprobe are optional and not both available');
}
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'rev2d-scene-'));
  await writeFile(path.join(dir, 'image.png'), encodePNG(createImage(20, 20, '#e04030')));
  await writeFile(path.join(dir, 'voice.wav'), syntheticWav(3));
  await writeFile(path.join(dir, 'phone.r2d.json'), JSON.stringify(buildPhoneUI()));
  await writeFile(path.join(dir, 'words.json'), JSON.stringify([{ word: 'idée', start: 1, end: 1.3 }]));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function write(name: string, input: unknown) {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(input));
  return file;
}
const base = (width = 128, height = 72) => ({
  version: 1,
  width,
  height,
  fps: 12,
  duration: 1,
  narration: { audio: 'voice.wav', offset: 0.5 },
  layers: [{ id: 'a', type: 'image', src: 'image.png', x: 10, y: 10 }],
  camera: 'slow-push',
});
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function probe(file: string): {
  streams: {
    codec_type: string;
    codec_name: string;
    pix_fmt?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    duration: string;
  }[];
  format: { duration: string };
} {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  );
}

it('loads both shipped scene formats with zero errors and warnings and exact narration cues', async () => {
  for (const file of ['scene.json', 'portrait.json']) {
    const loaded = await loadScene(path.join(PACKAGE_ROOT, 'examples/scenes/room-demo', file));
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.prepared).not.toBeNull();
    const info = sceneInfo(loaded);
    expect(info.layers).toHaveLength(5);
    expect(info.cues.filter((c) => c.cue === '@text:se lève').every((c) => c.time === 2.5)).toBe(true);
    expect(info.cues.find((c) => c.cue === '@word:5')!.time).toBe(3.2);
    expect(info.cues.find((c) => c.cue === '@text:idée')!.time).toBe(4);
    expect(info.frames).toBe(144);
    expect(requireScene(loaded).assets.layers.hero.sources.standing.rig).toBeDefined();
  }
});
it('keeps the checked-in scene documents equal to their original-art builders', async () => {
  for (const [portrait, file] of [
    [false, 'scene.json'],
    [true, 'portrait.json'],
  ] as const)
    expect(
      JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'examples/scenes/room-demo', file), 'utf8')),
    ).toEqual(JSON.parse(formatModelJson(roomScene(portrait))));
});
it('reports missing files, bad library refs, bad audio and model diagnostics with pointers', async () => {
  const cases = [
    {
      input: { ...base(), layers: [{ id: 'a', type: 'image', src: 'missing.png' }] },
      code: 'scene-file-missing',
    },
    { input: { ...base(), narration: { audio: 'image.png' } }, code: 'scene-audio-format' },
    { input: { ...base(), layers: [{ id: 'a', type: 'prop', ref: 'unknown' }] }, code: 'scene-library-ref' },
    {
      input: {
        ...base(),
        layers: [
          {
            id: 'a',
            type: 'model',
            src: 'phone.r2d.json',
            tracks: [{ param: 'Progres', keys: [{ t: 0, v: 1 }] }],
          },
        ],
      },
      code: 'scene-unknown-param',
    },
    {
      input: {
        ...base(),
        layers: [{ id: 'a', type: 'model', src: 'phone.r2d.json', animations: ['missing'] }],
      },
      code: 'scene-unknown-animation',
    },
    {
      input: {
        ...base(),
        narration: { alignment: 'words.json' },
        layers: [{ id: 'a', type: 'image', src: 'image.png', enter: { t: '@text:absent', type: 'pop' } }],
      },
      code: 'scene-cue-not-found',
    },
  ];
  for (let i = 0; i < cases.length; i++) {
    const loaded = await loadScene(await write(`bad-${i}.json`, cases[i].input));
    expect(loaded.prepared).toBeNull();
    expect(loaded.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: cases[i].code,
          path: expect.stringMatching(/^\//),
          hint: expect.any(String),
        }),
      ]),
    );
  }
  await write('invalid.r2d.json', { format: 'rev2d', version: 1 });
  const invalid = await loadScene(
    await write('bad-model.json', {
      ...base(),
      layers: [{ id: 'a', type: 'model', src: 'invalid.r2d.json' }],
    }),
  );
  expect(invalid.diagnostics.some((d) => d.code.startsWith('scene-model-invalid-'))).toBe(true);
});
it('resolves focus and punch-in presets and returns model analysis', async () => {
  const input = {
    ...base(),
    camera: 'focus:a',
    layers: [{ id: 'a', type: 'model', src: 'phone.r2d.json', x: 50, y: 40 }],
  };
  const loaded = await loadScene(await write('focus.json', input));
  expect(loaded.diagnostics).toEqual([]);
  expect((requireScene(loaded).scene.camera as { keys: { x: number }[] }).keys[0].x).toBe(50);
  expect(analyzeLoadedScene(loaded).frames).toBe(12);
  const punch = await loadScene(
    await write('punch.json', {
      ...base(),
      duration: 2,
      narration: { alignment: 'words.json' },
      camera: 'punch-in@@text:idée',
    }),
  );
  expect(punch.diagnostics).toEqual([]);
  expect(sceneInfo(punch).cues).toContainEqual({ path: '/camera/preset', cue: '@text:idée', time: 1 });
});
it('handles zero-time punches, explicit camera keys, appearing focus targets and malformed JSON', async () => {
  for (const camera of [
    'punch-in@0',
    {
      preset: 'punch-in@absent',
      keys: [
        { t: 0, x: 64, y: 36 },
        { t: 1, x: 65, y: 36 },
      ],
    },
  ]) {
    const loaded = await loadScene(await write('camera-edge.json', { ...base(), camera }));
    expect(loaded.diagnostics).toEqual([]);
  }
  const focused = await loadScene(
    await write('focus-pop.json', {
      ...base(),
      camera: 'focus:a',
      layers: [{ id: 'a', type: 'image', src: 'image.png', x: 50, y: 30, enter: { t: 0, type: 'pop' } }],
    }),
  );
  expect(focused.diagnostics).toEqual([]);
  const zoom = (requireScene(focused).scene.camera as { keys: { zoom: number }[] }).keys[0].zoom;
  expect(Number.isFinite(zoom)).toBe(true);
  expect(zoom).toBeGreaterThan(0);
  await writeFile(path.join(dir, 'syntax.json'), '{');
  expect((await loadScene(path.join(dir, 'syntax.json'))).diagnostics[0].code).toBe('scene-schema-json');
});
it('PNG export is byte deterministic and never modifies a source model', async () => {
  const file = await write('deterministic.json', {
    ...base(),
    layers: [
      {
        id: 'phone',
        type: 'model',
        src: 'phone.r2d.json',
        x: 60,
        y: 36,
        scale: 0.15,
        tracks: [
          {
            param: 'Progress',
            keys: [
              { t: 0, v: 0 },
              { t: 1, v: 1 },
            ],
          },
        ],
      },
    ],
  });
  const model = path.join(dir, 'phone.r2d.json'),
    before = hash(await readFile(model)),
    loaded = await loadScene(file);
  const a = path.join(dir, 'png-a'),
    b = path.join(dir, 'png-b');
  await renderScene(loaded, a, { format: 'png' });
  await renderScene(loaded, b, { format: 'png' });
  const files = (await readdir(a)).filter((n) => n.endsWith('.png'));
  expect(files).toHaveLength(12);
  for (const name of files)
    expect(hash(await readFile(path.join(a, name)))).toBe(hash(await readFile(path.join(b, name))));
  expect(hash(await readFile(model))).toBe(before);
  expect(JSON.parse(await readFile(path.join(a, 'manifest.json'), 'utf8'))).toMatchObject({
    frames: 12,
    duration: 1,
    width: 128,
    height: 72,
  });
});
it('missing ffmpeg has a stable diagnostic and CLI exit 1 while PNG still works', async () => {
  const previous = process.env.REV2D_FFMPEG;
  process.env.REV2D_FFMPEG = '/nonexistent/rev2d-ffmpeg';
  const file = await write('no-ffmpeg.json', base());
  try {
    await expect(renderScene(await loadScene(file), path.join(dir, 'absent.mp4'))).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: 'scene-ffmpeg-missing',
          hint: expect.stringContaining('--format png'),
        }),
      ],
    });
    let stdout = '',
      stderr = '';
    expect(
      await main(['scene', 'render', file, '-o', path.join(dir, 'absent-cli.mp4'), '--json'], {
        cwd: dir,
        stdout: {
          write: (s) => {
            stdout += s;
          },
        },
        stderr: {
          write: (s) => {
            stderr += s;
          },
        },
      }),
    ).toBe(1);
    expect(stdout + stderr).toContain('scene-ffmpeg-missing');
    expect(
      (await renderScene(await loadScene(file), path.join(dir, 'without-encoder'), { format: 'png' })).frames,
    ).toBe(12);
  } finally {
    if (previous === undefined) delete process.env.REV2D_FFMPEG;
    else process.env.REV2D_FFMPEG = previous;
  }
});
it('rejects existing output, invalid windows and cancellation without partial publication', async () => {
  const loaded = await loadScene(await write('safe.json', base()));
  await expect(renderScene(loaded, path.join(dir, 'image.png'), { format: 'png' })).rejects.toBeInstanceOf(
    SceneError,
  );
  await expect(
    renderScene(loaded, path.join(dir, 'bad-window'), { format: 'png', from: 0.8, to: 0.5 }),
  ).rejects.toBeInstanceOf(SceneError);
  const controller = new AbortController();
  controller.abort();
  await expect(
    renderScene(loaded, path.join(dir, 'cancelled'), { format: 'png', signal: controller.signal }),
  ).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'scene-render-cancelled' })] });
  expect(await readdir(dir)).not.toContain('cancelled');
});
it.skipIf(!ffmpeg)(
  'streams H.264/AAC in landscape and portrait with exact frame durations and trims',
  async () => {
    for (const [width, height] of [
      [128, 72],
      [72, 128],
    ]) {
      const loaded = await loadScene(await write(`video-${width}.json`, base(width, height))),
        output = path.join(dir, `${width}.mp4`);
      const result = await renderScene(loaded, output, { from: 0.25, to: 0.75 });
      const metadata = probe(output),
        video = metadata.streams.find((s) => s.codec_type === 'video')!,
        audio = metadata.streams.find((s) => s.codec_type === 'audio')!;
      expect(video).toMatchObject({
        codec_name: 'h264',
        pix_fmt: 'yuv420p',
        width,
        height,
        r_frame_rate: '12/1',
      });
      expect(audio.codec_name).toBe('aac');
      expect(Math.abs(Number(video.duration) - 0.5)).toBeLessThan(1 / 12);
      expect(Math.abs(Number(audio.duration) - 0.5)).toBeLessThan(1 / 12);
      expect(result.frames).toBe(6);
    }
  },
);
it.skipIf(!ffmpeg)('streams GIF and silent MP4 without collecting all frames', async () => {
  const loaded = await loadScene(await write('silent.json', base()));
  await renderScene(loaded, path.join(dir, 'silent.mp4'), { audio: false });
  expect(probe(path.join(dir, 'silent.mp4')).streams).toHaveLength(1);
  await renderScene(loaded, path.join(dir, 'animated.gif'), { format: 'gif' });
  expect(probe(path.join(dir, 'animated.gif')).streams[0].codec_name).toBe('gif');
});
