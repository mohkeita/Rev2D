/** Per-shot process isolation and content-addressed cache. Inputs and output bytes are verified. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseScene } from '../scene/schema.js';
import type { TimedShot } from '../episode/index.js';
import { loadScene, requireScene } from './scene.js';
import { readLibrary, libraryFile } from './library.js';
import { findFfmpeg } from './video.js';
import { runProgram, checkSize, probeMedia } from './episode-media.js';
import {
  digest,
  jsonFile,
  writeAtomic,
  fail,
  readEpisodeBuild,
  selectShots,
  type EpisodeBuild,
} from './episode.js';
export interface EpisodeProgress {
  shot: string;
  completed: number;
  total: number;
  frame: number;
  frames: number;
  cached: boolean;
}
export interface ShotRenderJob {
  scene: string;
  external?: { video: string; fit: 'cover' | 'contain'; from: number };
  output: string;
  size: [number, number];
  fps: number;
  frames: number;
}
export async function assertBuildCurrent(root: string, build: EpisodeBuild) {
  for (const [file, hash] of Object.entries(build.sourceHashes)) {
    if (
      path.isAbsolute(file) ||
      file.includes('\0') ||
      typeof hash !== 'string' ||
      digest(await readFile(path.resolve(root, file))) !== hash
    )
      fail(
        'episode-build-stale',
        '/storyboard',
        'storyboard or narration inputs changed since the build',
        'run episode build again before rendering or assembling',
      );
  }
}
async function engineFingerprint() {
  const root = fileURLToPath(new URL('../', import.meta.url)),
    files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const f = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['cli', 'mcp', 'server'].includes(entry.name)) await walk(f);
      } else if (/\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(f);
    }
  };
  await walk(root);
  const values = [];
  for (const f of files.sort()) values.push([path.relative(root, f), digest(await readFile(f))]);
  return digest(JSON.stringify(values));
}
/** Only selected assets are fingerprinted; unrelated library images do not invalidate a shot. */
export async function shotFingerprint(root: string, build: EpisodeBuild, t: TimedShot, engine: string) {
  const dir = path.join(root, 'shots', t.shot.id),
    sceneFile = path.join(dir, 'scene.json'),
    files = new Set<string>([sceneFile]);
  let external: ShotRenderJob['external'];
  if (t.shot.external) {
    const meta = (await jsonFile(path.join(dir, 'external.json'))) as Record<string, unknown>;
    if (
      typeof meta.video !== 'string' ||
      path.isAbsolute(meta.video) ||
      meta.video.includes('\0') ||
      !['cover', 'contain'].includes(String(meta.fit)) ||
      typeof meta.from !== 'number' ||
      !Number.isFinite(meta.from) ||
      meta.from < 0
    )
      fail('episode-external-format', '/external', 'invalid built external descriptor', 'rebuild this shot');
    files.add(path.join(dir, 'external.json'));
    external = {
      video: path.resolve(dir, meta.video),
      fit: meta.fit as 'cover' | 'contain',
      from: meta.from,
    };
    files.add(external.video);
  } else {
    const raw = parseScene(await jsonFile(sceneFile));
    if (!raw.scene)
      fail(
        'episode-scene-invalid',
        '/shots/' + t.shot.id,
        'invalid scene document',
        'run scene validate on the built scene',
      );
    const s = raw.scene,
      loaded = await loadScene(sceneFile);
    requireScene(loaded);
    if (s.fps !== build.episode.fps || Math.ceil(s.duration * s.fps - 1e-8) !== t.frames)
      fail(
        'episode-scene-timing',
        '/shots/' + t.shot.id,
        'built scene timing differs from the storyboard',
        'edit timing in the storyboard and rebuild; scene duration and fps are owned by the episode',
      );
    for (const model of loaded.models.values()) {
      if (model.file) files.add(model.file);
      for (const texture of model.model?.textures ?? [])
        if (!texture.path.startsWith('data:')) files.add(path.resolve(model.baseDir, texture.path));
    }
    if (s.narration) {
      if (s.narration.audio) files.add(path.resolve(dir, s.narration.audio));
      if (s.narration.alignment) files.add(path.resolve(dir, s.narration.alignment));
    }
    let library: Awaited<ReturnType<typeof readLibrary>> | undefined, base: string | undefined;
    if (s.library) {
      base = path.resolve(dir, s.library);
      files.add(path.join(base, 'library.json'));
      library = await readLibrary(base);
    }
    for (const layer of s.layers) {
      if (layer.type === 'image') files.add(path.resolve(dir, layer.src));
      if (layer.type === 'bubble' && layer.content) files.add(path.resolve(dir, layer.content.src));
      if (!base || !library) continue;
      if (layer.type === 'character') {
        const char = library.characters.find((c) => c.id === layer.character)!;
        for (const pose of layer.poses) {
          const p = char.poses.find((p) => p.id === pose.pose)!;
          const avatar = await libraryFile(base, p.avatar);
          for (const name of ['avatar.json', 'source.png', 'layers.json']) {
            const f = path.join(avatar, name);
            if (existsSync(f)) files.add(f);
          }
        }
      } else if (layer.type === 'background') {
        const a = library.backgrounds.find((a) => a.id === layer.ref)!;
        files.add(await libraryFile(base, a.src));
      } else if (layer.type === 'prop' || layer.type === 'bubble') {
        const a = (layer.type === 'prop' ? library.props : library.bubbles).find((a) => a.id === layer.ref)!;
        files.add(await libraryFile(base, a.src));
      }
    }
  }
  const hashes = [];
  for (const f of [...files].sort()) {
    if (!(await stat(f)).isFile())
      fail('episode-resource-file', '', 'referenced resource is not a file', 'repair the asset path');
    hashes.push([path.relative(dir, f), digest(await readFile(f))]);
  }
  return {
    fingerprint: digest(
      JSON.stringify({
        engine,
        size: build.episode.size,
        fps: build.episode.fps,
        frames: t.frames,
        files: hashes,
      }),
    ),
    job: {
      scene: sceneFile,
      external,
      output: path.join(dir, 'shot.mp4'),
      size: build.episode.size,
      fps: build.episode.fps,
      frames: t.frames,
    } satisfies ShotRenderJob,
  };
}
async function runWorker(
  job: ShotRenderJob,
  progress: (p: { frame: number; frames: number }) => void,
  signal?: AbortSignal,
) {
  const js = fileURLToPath(new URL('./episode-worker.js', import.meta.url)),
    entry = existsSync(js) ? js : fileURLToPath(new URL('./episode-worker.ts', import.meta.url));
  const execArgv = entry.endsWith('.ts') ? ['--import', createRequire(import.meta.url).resolve('tsx')] : [];
  if (signal?.aborted) fail('episode-cancelled', '', 'render cancelled', 'restart when ready');
  const child = fork(entry, ['--episode-worker'], {
    execArgv,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let stderr = '',
    error: Error | undefined,
    done = false;
  child.stderr?.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-16384);
  });
  child.on('error', (e) => {
    error = e;
  });
  child.on('message', (raw: unknown) => {
    const m = raw as { type?: string; frame?: number; frames?: number; message?: string };
    if (m.type === 'progress' && typeof m.frame === 'number' && typeof m.frames === 'number')
      progress({ frame: m.frame, frames: m.frames });
    if (m.type === 'done') done = true;
    if (m.type === 'error') error = new Error(m.message);
  });
  const abort = () => {
    child.kill('SIGTERM');
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const closed = new Promise<number | null>((r) => child.once('close', r));
    child.send(job);
    const code = await closed;
    if (signal?.aborted) fail('episode-cancelled', '', 'render cancelled', 'restart when ready');
    if (error || code !== 0 || !done)
      fail(
        'episode-worker-failed',
        '/shots',
        error?.message ?? (stderr || `worker exited ${code}`),
        'validate the scene and check the encoder',
      );
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
export async function renderEngineFingerprint() {
  return digest((await engineFingerprint()) + '\n' + (await runProgram(await findFfmpeg(), ['-version'])));
}
export async function renderEpisode(
  root: string,
  options: {
    jobs?: number;
    only?: string[];
    force?: boolean;
    signal?: AbortSignal;
    progress?: (p: EpisodeProgress) => void;
  } = {},
) {
  root = path.resolve(root);
  const build = await readEpisodeBuild(root);
  await assertBuildCurrent(root, build);
  checkSize(build.episode.size);
  const jobs = options.jobs ?? 2;
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16)
    fail('episode-jobs', '/jobs', 'jobs must be an integer in 1..16', 'use --jobs 2');
  const selected = selectShots(build, options.only),
    engine = await renderEngineFingerprint();
  const rendered: string[] = [],
    cached: string[] = [];
  let cursor = 0,
    completed = 0;
  let firstError: unknown;
  const stop = new AbortController(),
    abort = () => stop.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) stop.abort();
  const pool = async () => {
    while (cursor < selected.length) {
      if (stop.signal.aborted) fail('episode-cancelled', '', 'render cancelled', 'restart when ready');
      const t = selected[cursor++];
      if (!build.built.includes(t.shot.id))
        fail(
          'episode-shot-not-built',
          '/shots/' + t.shot.id,
          'shot has not been built',
          'run episode build with this shot selected',
        );
      const record = path.join(root, 'shots', t.shot.id, 'render.json'),
        input = await shotFingerprint(root, build, t, engine);
      let hit = false;
      if (!options.force && existsSync(record) && existsSync(input.job.output)) {
        const old = (await jsonFile(record)) as { fingerprint?: string; outputHash?: string };
        hit =
          old.fingerprint === input.fingerprint &&
          old.outputHash === digest(await readFile(input.job.output));
      }
      const emit = (p: { frame: number; frames: number }) =>
        options.progress?.({ shot: t.shot.id, completed, total: selected.length, cached: hit, ...p });
      if (hit) cached.push(t.shot.id);
      else {
        if (existsSync(input.job.output) && !existsSync(record) && !options.force)
          fail(
            'episode-output-exists',
            '/shots/' + t.shot.id,
            'shot.mp4 is not a managed cached render',
            'move that file or use --force explicitly',
          );
        const temp = input.job.output + '.' + randomUUID() + '.mp4';
        try {
          await runWorker({ ...input.job, output: temp }, emit, stop.signal);
          const media = await probeMedia(temp);
          if (
            media.frames !== t.frames ||
            media.width !== build.episode.size[0] ||
            media.height !== build.episode.size[1]
          )
            fail(
              'episode-render-frames',
              '/shots/' + t.shot.id,
              'worker output does not match its frame/size contract',
              'validate scene timing and the encoder',
            );
          const after = await shotFingerprint(root, build, t, engine);
          if (after.fingerprint !== input.fingerprint)
            fail(
              'episode-input-changed',
              '/shots/' + t.shot.id,
              'resources changed during rendering',
              'restart after editing is complete',
            );
          await rename(temp, input.job.output);
          await writeAtomic(record, {
            version: 1,
            fingerprint: input.fingerprint,
            outputHash: digest(await readFile(input.job.output)),
            frames: t.frames,
            fps: build.episode.fps,
            size: build.episode.size,
          });
          rendered.push(t.shot.id);
        } finally {
          await rm(temp, { force: true });
        }
      }
      completed++;
      emit({ frame: t.frames, frames: t.frames });
    }
  };
  try {
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(jobs, selected.length) }, () =>
        pool().catch((e) => {
          firstError ??= e;
          stop.abort();
          throw e;
        }),
      ),
    );
    const error = results.find((r) => r.status === 'rejected');
    if (error?.status === 'rejected') throw firstError ?? error.reason;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
  return { ok: true, rendered: rendered.sort(), cached: cached.sort(), total: selected.length };
}
