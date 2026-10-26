/** Storyboard file IO and explicit per-shot scene builds, shared by CLI and MCP. */
import path from 'node:path';
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Diagnostic } from '../core/types.js';
import { parseJsonc } from '../core/validate.js';
import { formatModelJson } from '../core/format.js';
import { decodeWav } from '../lipsync/wav.js';
import { parseAlignment, type WordTiming } from '../scene/alignment.js';
import { parseScene, type SceneInput } from '../scene/schema.js';
import { parseLibrary, type Library } from '../library/schema.js';
import { generationRequest } from '../library/index.js';
import { readLibrary, requestLibraryImage } from './library.js';
import { loadScene } from './scene.js';
import {
  parseEpisode,
  resolveEpisode,
  compileShot,
  planAssets,
  shotAssetDiagnostics,
  episodeDiagnostic as d,
  EpisodeError,
  type Episode,
  type EpisodeTimeline,
  type TimedShot,
} from '../episode/index.js';
export const slash = (p: string) => p.split(path.sep).join('/');
export const relative = (from: string, to: string) => slash(path.relative(from, to)) || '.';
export const digest = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
export async function jsonFile(file: string): Promise<unknown> {
  const p = parseJsonc(await readFile(file, 'utf8'));
  if (!p.ok) throw new Error(p.error.message);
  return p.value;
}
export async function writeAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(tmp, formatModelJson(value, { precision: 12 }), { flag: 'wx' });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}
export function fail(code: string, pointer: string, message: string, hint: string): never {
  throw new EpisodeError([d(code, pointer, message, hint)]);
}
export interface LoadedEpisode {
  file: string;
  episode: Episode | null;
  timeline: EpisodeTimeline | null;
  library?: Library;
  words: WordTiming[];
  audioDuration: number;
  diagnostics: Diagnostic[];
}
export async function loadEpisode(file: string): Promise<LoadedEpisode> {
  file = path.resolve(file);
  const out: LoadedEpisode = {
    file,
    episode: null,
    timeline: null,
    words: [],
    audioDuration: 0,
    diagnostics: [],
  };
  try {
    const p = parseEpisode(await jsonFile(file));
    out.episode = p.episode;
    out.diagnostics.push(...p.diagnostics);
  } catch (e) {
    out.diagnostics.push(
      d('episode-file-read', '', (e as Error).message, 'provide a readable storyboard JSON or JSONC file'),
    );
  }
  if (!out.episode) return out;
  const e = out.episode,
    base = path.dirname(file);
  try {
    const wav = decodeWav(await readFile(path.resolve(base, e.narration.audio)));
    out.audioDuration = wav.samples.length / wav.sampleRate;
  } catch (err) {
    out.diagnostics.push(
      d(
        'episode-audio-format',
        '/narration/audio',
        (err as Error).message,
        'provide PCM WAV audio; convert other formats with ffmpeg -i voice.mp3 -c:a pcm_s16le voice.wav',
      ),
    );
  }
  if (e.narration.alignment)
    try {
      const a = parseAlignment(await jsonFile(path.resolve(base, e.narration.alignment)));
      out.words = a.words;
      out.diagnostics.push(
        ...a.diagnostics.map((v) => ({
          ...v,
          code: 'episode-alignment-format',
          path: '/narration/alignment' + v.path,
        })),
      );
    } catch (err) {
      out.diagnostics.push(
        d(
          'episode-alignment-format',
          '/narration/alignment',
          (err as Error).message,
          'provide ordered word timestamps or ElevenLabs alignment',
        ),
      );
    }
  if (e.library)
    try {
      out.library = await readLibrary(path.resolve(base, e.library));
    } catch (err) {
      out.diagnostics.push(
        d('episode-library', '/library', (err as Error).message, 'provide a valid library directory'),
      );
    }
  if (e.music)
    try {
      if (!(await stat(path.resolve(base, e.music.src))).isFile())
        throw new Error('music is not a regular file');
    } catch (err) {
      out.diagnostics.push(
        d('episode-music-file', '/music/src', (err as Error).message, 'provide a readable local music file'),
      );
    }
  const resolved = resolveEpisode(e, out.words, out.audioDuration);
  out.timeline = resolved.timeline;
  out.diagnostics.push(...resolved.diagnostics);
  if (out.diagnostics.some((v) => v.severity === 'error')) out.timeline = null;
  return out;
}
export function requireEpisode(e: LoadedEpisode): EpisodeTimeline {
  if (!e.timeline) throw new EpisodeError(e.diagnostics);
  return e.timeline;
}
function rebaseScene(input: SceneInput, from: string, to: string): SceneInput {
  const raw = structuredClone(input),
    file = (s: string) => relative(to, path.resolve(from, s));
  if (raw.library) raw.library = file(raw.library);
  if (raw.narration) {
    if (raw.narration.audio) raw.narration.audio = file(raw.narration.audio);
    if (raw.narration.alignment) raw.narration.alignment = file(raw.narration.alignment);
  }
  for (const l of raw.layers ?? []) {
    if ((l.type === 'image' || l.type === 'model') && l.src) l.src = file(l.src);
    if (l.type === 'bubble' && l.content) l.content.src = file(l.content.src);
  }
  return raw;
}
export async function episodeScene(e: LoadedEpisode, t: TimedShot, target: string): Promise<SceneInput> {
  const timeline = requireEpisode(e),
    base = path.dirname(e.file),
    dest = path.dirname(target);
  let raw: SceneInput,
    from = base;
  if (t.shot.scene) {
    const file = path.resolve(base, t.shot.scene),
      p = parseScene(await jsonFile(file));
    if (!p.scene) throw new EpisodeError(p.diagnostics);
    raw = p.scene;
    from = path.dirname(file);
  } else {
    const c = compileShot(timeline, t);
    if (!c.scene) throw new EpisodeError(c.diagnostics);
    raw = c.scene;
  }
  raw = rebaseScene(raw, from, dest);
  raw.id = t.shot.id;
  raw.duration = t.duration;
  raw.fps = timeline.episode.fps;
  raw.narration = {
    audio: relative(dest, path.resolve(base, timeline.episode.narration.audio)),
    ...(timeline.episode.narration.alignment
      ? { alignment: relative(dest, path.resolve(base, timeline.episode.narration.alignment)) }
      : {}),
    offset: t.start,
  };
  return raw;
}
export async function validateEpisode(file: string) {
  const e = await loadEpisode(file);
  if (!e.timeline) return { ok: false, diagnostics: e.diagnostics };
  const missing = planAssets(e.timeline, e.library);
  e.diagnostics.push(...shotAssetDiagnostics(missing));
  for (const t of e.timeline.shots)
    try {
      if (t.shot.external) {
        const f = path.resolve(path.dirname(e.file), t.shot.external.video);
        if (!(await stat(f)).isFile()) throw new Error('external source is not a regular file');
      } else {
        const virtual = path.join(path.dirname(e.file), '.episode-check', t.shot.id, 'scene.json'),
          raw = await episodeScene(e, t, virtual),
          s = await loadScene(virtual, raw);
        e.diagnostics.push(...s.diagnostics.map((v) => ({ ...v, path: `/shots/${t.shot.id}` + v.path })));
      }
    } catch (err) {
      e.diagnostics.push(
        d(
          'episode-shot-file',
          `/shots/${t.shot.id}`,
          (err as Error).message,
          'repair the authored scene or external file path',
        ),
      );
    }
  return {
    ok: !e.diagnostics.some((v) => v.severity === 'error'),
    id: e.episode!.id,
    frames: e.timeline.frames,
    duration: e.timeline.duration,
    shots: e.timeline.shots.map((t) => ({
      id: t.shot.id,
      start: t.start,
      end: t.end,
      startFrame: t.startFrame,
      endFrame: t.endFrame,
      frames: t.frames,
    })),
    missing,
    diagnostics: e.diagnostics,
  };
}
export async function planEpisode(file: string, output?: string) {
  const e = await loadEpisode(file),
    timeline = requireEpisode(e),
    missing = planAssets(timeline, e.library),
    requests: unknown[] = [];
  if (output) {
    output = path.resolve(output);
    if (existsSync(output))
      fail(
        'episode-output-exists',
        '/out',
        'request directory already exists',
        'choose a new request directory',
      );
    await mkdir(output, { recursive: true });
    for (const [i, m] of missing.entries()) {
      const dir = path.join(output, `${String(i + 1).padStart(3, '0')}-${m.kind}-${m.id}`);
      if (
        m.kind !== 'ui' &&
        e.library &&
        e.episode!.library &&
        (m.kind !== 'character' || e.library.characters.some((c) => c.id === m.id))
      ) {
        requests.push(
          await requestLibraryImage(path.resolve(path.dirname(e.file), e.episode!.library), dir, {
            kind: m.kind,
            id: m.id,
            character: m.kind === 'character' ? m.id : undefined,
            pose: m.pose,
          }),
        );
      } else {
        const empty = parseLibrary({
            version: 1,
            name: e.episode!.id,
            characters:
              m.kind === 'character'
                ? [
                    {
                      id: m.id,
                      name: m.id,
                      height: 300,
                      description:
                        'Identity not yet supplied: request canonical references before generating.',
                    },
                  ]
                : [],
          }).library!,
          request =
            m.kind === 'ui'
              ? {
                  version: 1,
                  kind: 'ui',
                  id: m.id,
                  references: [],
                  prompt: `Author an original Rev2D model for UI ${m.id}. Expose the parameters requested by the storyboard; do not rasterize interactive controls.`,
                }
              : generationRequest(empty, {
                  kind: m.kind,
                  id: m.id,
                  character: m.kind === 'character' ? m.id : undefined,
                  pose: m.pose,
                });
        await mkdir(dir);
        await writeAtomic(path.join(dir, 'request.json'), { ...request, shots: m.shots });
        await writeFile(path.join(dir, 'prompt.txt'), request.prompt + '\n');
        requests.push({ directory: dir, ...request });
      }
    }
  }
  return { ok: true, missing, requests, diagnostics: e.diagnostics };
}
export interface EpisodeBuild {
  format: 'rev2d-episode-build';
  version: 1;
  id: string;
  storyboard: string;
  storyboardHash: string;
  audioDuration: number;
  episode: Episode;
  words: WordTiming[];
  frames: number;
  duration: number;
  shots: TimedShot[];
  built: string[];
  sceneHashes: Record<string, string>;
  sourceHashes: Record<string, string>;
}
export async function readEpisodeBuild(root: string): Promise<EpisodeBuild> {
  const raw = (await jsonFile(path.join(path.resolve(root), 'episode.json'))) as Partial<EpisodeBuild>;
  const invalid = () =>
    fail(
      'episode-build-format',
      '/',
      'not a valid managed episode build',
      'run episode build into a new directory',
    );
  if (
    !raw ||
    raw.format !== 'rev2d-episode-build' ||
    raw.version !== 1 ||
    typeof raw.storyboard !== 'string' ||
    path.isAbsolute(raw.storyboard) ||
    raw.storyboard.includes('\0') ||
    typeof raw.storyboardHash !== 'string' ||
    !Array.isArray(raw.shots) ||
    !Array.isArray(raw.built) ||
    !raw.sceneHashes ||
    !raw.sourceHashes
  )
    invalid();
  const parsed = parseEpisode(raw.episode);
  if (!parsed.episode) throw new EpisodeError(parsed.diagnostics);
  const alignment = parseAlignment(raw.words);
  if (alignment.diagnostics.some((d) => d.severity === 'error')) invalid();
  const resolved = resolveEpisode(parsed.episode!, alignment.words, Number(raw.audioDuration));
  if (!resolved.timeline) invalid();
  const expected = resolved.timeline!;
  if (
    raw.id !== parsed.episode!.id ||
    raw.frames !== expected.frames ||
    Math.abs(raw.duration! - expected.duration) > 1e-9 ||
    formatModelJson(raw.shots, { precision: 10 }) !== formatModelJson(expected.shots, { precision: 10 }) ||
    !raw.built!.every((id) => typeof id === 'string' && expected.shots.some((t) => t.shot.id === id))
  )
    invalid();
  return raw as EpisodeBuild;
}
export function selectShots(build: Pick<EpisodeBuild, 'shots'>, only?: string[]): TimedShot[] {
  if (!only?.length) return build.shots;
  for (const id of only)
    if (!build.shots.some((t) => t.shot.id === id))
      fail(
        'episode-shot-unknown',
        '/only',
        `unknown shot ${id}`,
        `available: ${build.shots.map((t) => t.shot.id).join(', ')}`,
      );
  return build.shots.filter((t) => only.includes(t.shot.id));
}
export async function buildEpisode(
  file: string,
  root: string,
  options: { only?: string[]; force?: boolean } = {},
) {
  const loaded = await loadEpisode(file),
    timeline = requireEpisode(loaded),
    validation = await validateEpisode(file);
  if (!validation.ok) throw new EpisodeError(validation.diagnostics);
  root = path.resolve(root);
  let old: EpisodeBuild | undefined;
  if (existsSync(root)) {
    if (!existsSync(path.join(root, 'episode.json')))
      fail(
        'episode-output-exists',
        '/out',
        'output directory is not an episode build',
        'use a new directory',
      );
    old = await readEpisodeBuild(root);
    if (old.id !== timeline.episode.id)
      fail('episode-output-exists', '/out', 'output belongs to another episode', 'choose a new directory');
  } else await mkdir(root, { recursive: true });
  const sourceHashes: Record<string, string> = {};
  for (const source of [
    path.resolve(file),
    path.resolve(path.dirname(file), timeline.episode.narration.audio),
    ...(timeline.episode.narration.alignment
      ? [path.resolve(path.dirname(file), timeline.episode.narration.alignment)]
      : []),
  ])
    sourceHashes[relative(root, source)] = digest(await readFile(source));
  const sameSource = old && JSON.stringify(old.sourceHashes) === JSON.stringify(sourceHashes);
  const selected = selectShots(timeline, options.only),
    built = new Set(sameSource ? old!.built : []),
    sceneHashes: Record<string, string> = { ...(old?.sceneHashes ?? {}) };
  for (const t of selected) {
    const dir = path.join(root, 'shots', t.shot.id),
      sceneFile = path.join(dir, 'scene.json');
    if (
      existsSync(sceneFile) &&
      (!old?.sceneHashes[t.shot.id] || digest(await readFile(sceneFile)) !== old.sceneHashes[t.shot.id]) &&
      !options.force
    )
      fail(
        'episode-scene-edited',
        '/shots/' + t.shot.id,
        'generated scene has local edits',
        'preserve it with storyboard scene, or rebuild with --force',
      );
    await mkdir(dir, { recursive: true });
    if (t.shot.external) {
      await writeAtomic(path.join(dir, 'external.json'), {
        ...t.shot.external,
        video: relative(dir, path.resolve(path.dirname(file), t.shot.external.video)),
      });
      await writeAtomic(path.join(dir, 'scene.json'), {
        version: 1,
        id: t.shot.id,
        width: timeline.episode.size[0],
        height: timeline.episode.size[1],
        fps: timeline.episode.fps,
        duration: t.duration,
        layers: [],
        camera: 'static',
      });
    } else
      await writeAtomic(
        path.join(dir, 'scene.json'),
        await episodeScene(loaded, t, path.join(dir, 'scene.json')),
      );
    sceneHashes[t.shot.id] = digest(await readFile(sceneFile));
    built.add(t.shot.id);
  }
  const manifest: EpisodeBuild = {
    format: 'rev2d-episode-build',
    version: 1,
    id: timeline.episode.id,
    storyboard: relative(root, path.resolve(file)),
    storyboardHash: digest(await readFile(file)),
    audioDuration: loaded.audioDuration,
    episode: timeline.episode,
    words: loaded.words,
    frames: timeline.frames,
    duration: timeline.duration,
    shots: timeline.shots,
    sceneHashes,
    sourceHashes,
    built: [...built].filter((id) => timeline.shots.some((t) => t.shot.id === id)),
  };
  await writeAtomic(path.join(root, 'episode.json'), manifest);
  return {
    directory: root,
    built: selected.map((t) => t.shot.id),
    frames: timeline.frames,
    duration: timeline.duration,
    diagnostics: validation.diagnostics,
  };
}
