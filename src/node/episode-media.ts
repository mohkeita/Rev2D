/** Bounded optional ffmpeg/ffprobe adapters. Local files only; never execute a shell. */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { access, link, mkdir, rm, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { findFfmpeg } from './video.js';
import { fail } from './episode.js';
export async function runProgram(program: string, args: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) fail('episode-cancelled', '', 'operation cancelled', 'restart when ready');
  const child = spawn(program, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '',
    stderr = '',
    error: Error | undefined;
  child.stdout.on('data', (b: Buffer) => {
    stdout = (stdout + b.toString()).slice(-4 * 1024 * 1024);
  });
  child.stderr.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-32768);
  });
  child.on('error', (e) => {
    error = e;
  });
  const abort = () => {
    child.kill('SIGKILL');
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const code = await new Promise<number | null>((r) => child.once('close', r));
    if (signal?.aborted) fail('episode-cancelled', '', 'operation cancelled', 'restart when ready');
    if (error || code !== 0)
      fail(
        'episode-encoder-failed',
        '',
        `${path.basename(program)}: ${error?.message ?? stderr}`,
        'check media formats and the local encoder installation',
      );
    return stdout;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
export async function probeMedia(file: string) {
  if (!(await stat(file)).isFile())
    fail('episode-media-file', '', 'media is not a regular file', 'provide a local media file');
  const candidates = process.env.REV2D_FFPROBE
    ? [process.env.REV2D_FFPROBE]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .map((p) => path.join(p, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
  let executable: string | undefined;
  for (const p of candidates)
    try {
      await access(p, constants.X_OK);
      executable = p;
      break;
    } catch {
      /* next */
    }
  if (!executable)
    fail(
      'episode-ffprobe-missing',
      '',
      'ffprobe is unavailable',
      'install ffmpeg/ffprobe or set REV2D_FFPROBE',
    );
  const raw = JSON.parse(
    await runProgram(executable, [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      file,
    ]),
  ) as {
    streams: { codec_type: string; width?: number; height?: number; nb_frames?: string; duration?: string }[];
    format: { duration?: string };
  };
  const v = raw.streams.find((s) => s.codec_type === 'video'),
    a = raw.streams.find((s) => s.codec_type === 'audio');
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    frames: Number(v?.nb_frames ?? 0),
    duration: Number(raw.format.duration ?? v?.duration ?? a?.duration ?? 0),
    videoDuration: Number(v?.duration ?? raw.format.duration ?? 0),
    audioDuration: a ? Number(a.duration ?? raw.format.duration ?? 0) : 0,
    audio: !!a,
  };
}
export const encoderArgs = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-n',
  '-filter_threads',
  '1',
  '-filter_complex_threads',
  '1',
];
export const videoArgs = [
  '-c:v',
  'libx264',
  '-threads',
  '2',
  '-preset',
  'veryfast',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
];
export function checkSize(size: [number, number]) {
  if (
    !size.every((n) => Number.isInteger(n) && n >= 2 && n <= 3840 && n % 2 === 0) ||
    size[0] * size[1] > 3840 * 2160
  )
    fail(
      'episode-size',
      '/size',
      `unsupported output size ${size.join('x')}`,
      'use even dimensions within 3840 × 2160 area',
    );
}
/** No-clobber publication, including when the output appears while the encoder runs. */
export async function publishMedia<T>(output: string, encode: (temp: string) => Promise<T>) {
  output = path.resolve(output);
  if (existsSync(output))
    fail('episode-output-exists', '/out', 'output file already exists', 'choose a new output file');
  await mkdir(path.dirname(output), { recursive: true });
  const temp = path.join(path.dirname(output), `.episode-${randomUUID()}${path.extname(output)}`);
  try {
    const value = await encode(temp);
    await link(temp, output);
    return value;
  } finally {
    await rm(temp, { force: true });
  }
}
export async function normalizeClip(
  input: string,
  output: string,
  options: {
    size: [number, number];
    fps: number;
    frames: number;
    from?: number;
    fit?: 'cover' | 'contain';
    signal?: AbortSignal;
  },
) {
  checkSize(options.size);
  const probe = await probeMedia(input),
    duration = options.frames / options.fps;
  if (!probe.width || probe.videoDuration - (options.from ?? 0) < duration - 1 / options.fps - 1e-6)
    fail(
      'episode-external-duration',
      '/external',
      `source video is shorter than the shot (${duration}s)`,
      'extend or replace the explicitly referenced clip',
    );
  const [w, h] = options.size;
  const sizing =
    options.fit === 'contain'
      ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
      : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  const ffmpeg = await findFfmpeg();
  await publishMedia(output, (temp) =>
    runProgram(
      ffmpeg,
      [
        ...encoderArgs,
        '-protocol_whitelist',
        'file,pipe',
        '-ss',
        String(options.from ?? 0),
        '-i',
        input,
        '-vf',
        `setpts=PTS-STARTPTS,fps=${options.fps},${sizing},setsar=1,tpad=stop_mode=clone:stop_duration=${1 / options.fps},format=yuv420p`,
        '-frames:v',
        String(options.frames),
        ...videoArgs,
        '-an',
        temp,
      ],
      options.signal,
    ),
  );
}
