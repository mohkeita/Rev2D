/** Streaming external encoder: no shell, bounded stderr, one RGBA frame in flight. */
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile, rm, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ImageRGBA } from '../core/types.js';
import { encodePNG } from '../render/png.js';
import { RasterWorkspace } from '../render/browser.js';
import { SceneError, sceneDiagnostic, ScenePlayer, renderSceneFrame } from '../scene/index.js';
import { requireScene, type LoadedScene } from './scene.js';

export interface RenderProgress {
  frame: number;
  frames: number;
  percent: number;
  fps: number;
  remaining: number;
}
export interface SceneRenderOptions {
  format?: 'png' | 'mp4' | 'gif';
  from?: number;
  to?: number;
  scale?: number;
  crf?: number;
  audio?: boolean;
  signal?: AbortSignal;
  progress?: (progress: RenderProgress) => void;
}
function error(code: string, message: string, hint: string): SceneError {
  return new SceneError([sceneDiagnostic(code, '', message, hint)]);
}
export async function findFfmpeg(): Promise<string> {
  const executable = process.env.REV2D_FFMPEG;
  const candidates = executable
    ? [executable]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .map((dir) => path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  for (const file of candidates)
    try {
      await access(file, constants.X_OK);
      return file;
    } catch {
      /* try next PATH entry */
    }
  throw error(
    'scene-ffmpeg-missing',
    `ffmpeg is unavailable${executable ? ': ' + executable : ''}`,
    'install ffmpeg, add it to PATH, or set REV2D_FFMPEG to its executable; --format png needs no ffmpeg',
  );
}

export async function renderScene(loaded: LoadedScene, output: string, options: SceneRenderOptions = {}) {
  const prepared = requireScene(loaded),
    scene = prepared.scene;
  const format = options.format ?? (output.toLowerCase().endsWith('.gif') ? 'gif' : 'mp4');
  const from = options.from ?? 0,
    to = options.to ?? scene.duration,
    scale = options.scale ?? 1,
    crf = options.crf ?? 18;
  if (
    ![from, to, scale, crf].every(Number.isFinite) ||
    from < 0 ||
    to <= from ||
    to > scene.duration ||
    scale <= 0 ||
    crf < 0 ||
    crf > 51
  )
    throw error(
      'scene-render-range',
      'invalid render window, scale or CRF',
      'use 0 <= from < to <= duration, scale > 0 and CRF in 0..51',
    );
  const width = Math.round(scene.width * scale),
    height = Math.round(scene.height * scale),
    frames = Math.ceil((to - from) * scene.fps - 1e-8),
    duration = frames / scene.fps;
  if (
    !width ||
    !height ||
    width > 3840 ||
    height > 3840 ||
    width * height > 3840 * 2160 ||
    (format === 'mp4' && (width % 2 || height % 2))
  )
    throw error(
      'scene-size-range',
      `unsupported ${format} output size ${width}x${height}`,
      'use even MP4 dimensions within 3840 × 2160 area; portrait is supported',
    );
  output = path.resolve(output);
  const encoder = format === 'png' ? null : await findFfmpeg();
  // Never replace an existing render or a scene/source file.
  try {
    await access(output);
    throw error(
      'scene-output-exists',
      `output already exists: ${output}`,
      'choose a new output file or directory',
    );
  } catch (e) {
    if (e instanceof SceneError) throw e;
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await mkdir(path.dirname(output), { recursive: true });
  const player = new ScenePlayer(prepared),
    workspace = new RasterWorkspace({ cacheTextures: true }),
    started = performance.now();
  let peakRssBytes = process.memoryUsage().rss;
  const progress = (frame: number) => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    const elapsed = Math.max(0.001, (performance.now() - started) / 1000),
      fps = frame / elapsed;
    options.progress?.({
      frame,
      frames,
      percent: (frame / frames) * 100,
      fps,
      remaining: (frames - frame) / Math.max(fps, 0.001),
    });
  };
  const image = (i: number) => {
    if (options.signal?.aborted)
      throw error('scene-render-cancelled', 'render cancelled', 'restart into a new output path');
    const time = from + i / scene.fps;
    return renderSceneFrame(prepared, time, { scale, workspace }, player.update(time));
  };
  if (format === 'png') {
    await mkdir(output);
    try {
      for (let i = 0; i < frames; i++) {
        await writeFile(path.join(output, `frame-${String(i).padStart(6, '0')}.png`), encodePNG(image(i)), {
          flag: 'wx',
        });
        progress(i + 1);
      }
      await writeFile(
        path.join(output, 'manifest.json'),
        JSON.stringify(
          {
            version: 1,
            width,
            height,
            fps: scene.fps,
            frames,
            from,
            to: from + duration,
            duration,
            pattern: 'frame-%06d.png',
            audio: options.audio !== false ? (loaded.audio ?? null) : null,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
    } catch (e) {
      await rm(output, { recursive: true, force: true });
      throw e;
    }
  } else {
    const temp = path.join(path.dirname(output), `.rev2d-${randomUUID()}.${format}`);
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-n',
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgba',
      '-video_size',
      `${width}x${height}`,
      '-framerate',
      String(scene.fps),
      '-i',
      'pipe:0',
    ];
    const audio = format === 'mp4' && options.audio !== false ? loaded.audio : undefined;
    if (audio) args.push('-ss', String(audio.offset + from), '-i', audio.file);
    args.push('-map', '0:v:0');
    if (format === 'mp4') {
      args.push(
        '-c:v',
        'libx264',
        '-threads',
        '2',
        '-preset',
        'veryfast',
        '-crf',
        String(crf),
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
      );
      if (audio)
        args.push(
          '-map',
          '1:a:0',
          '-af',
          `apad,atrim=duration=${duration},asetpts=PTS-STARTPTS`,
          '-c:a',
          'aac',
        );
      else args.push('-an');
    } else args.push('-an', '-vf', 'format=rgb8', '-loop', '0');
    args.push('-t', String(duration), temp);
    const child = spawn(encoder!, args, {
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '',
      spawnError: Error | undefined;
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16384);
    });
    child.stdin.on('error', () => {
      /* write callbacks handle broken pipes */
    });
    child.on('error', (e) => {
      spawnError = e;
    });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    const abort = () => {
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      for (let i = 0; i < frames; i++) {
        const frame: ImageRGBA = image(i);
        await new Promise<void>((resolve, reject) =>
          child.stdin.write(
            Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
            (e) => (e ? reject(e) : resolve()),
          ),
        );
        progress(i + 1);
      }
      child.stdin.end();
      const exit = await closed;
      if (spawnError || exit !== 0)
        throw error(
          'scene-ffmpeg-failed',
          `ffmpeg failed: ${spawnError?.message ?? stderr}`,
          'check the encoder, output permissions and narration audio',
        );
      await link(temp, output); // atomic no-clobber publication on the same filesystem
    } catch (e) {
      child.stdin.destroy();
      child.kill('SIGKILL');
      await closed;
      if (options.signal?.aborted)
        throw error('scene-render-cancelled', 'render cancelled', 'restart the render when ready');
      if (e instanceof SceneError) throw e;
      throw error(
        'scene-ffmpeg-failed',
        `${(e as Error).message}${stderr ? ': ' + stderr : ''}`,
        'check that ffmpeg can encode H.264 and read the supplied audio',
      );
    } finally {
      options.signal?.removeEventListener('abort', abort);
      await rm(temp, { force: true });
    }
  }
  return {
    file: output,
    format,
    width,
    height,
    fps: scene.fps,
    frames,
    duration,
    from,
    to: from + duration,
    peakRssBytes,
  };
}
