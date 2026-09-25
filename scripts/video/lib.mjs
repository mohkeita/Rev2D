/**
 * Shared helpers for the video capture scripts (scripts/video/*.mjs).
 *
 * Everything here records REAL output: CLI commands are spawned for real, their stdout / stderr /
 * exit code / timestamps are kept verbatim, and every asset is registered in
 * out/video/assets/manifest.json (path, kind, bytes, size, fps / frames, duration, command log).
 *
 * Plain Node ESM (no tsx needed): run with `node scripts/video/<step>.mjs` from the repo root.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = path.join(ROOT, 'out', 'video');
export const ASSETS = path.join(OUT, 'assets');
export const WORK = path.join(OUT, 'work');
export const MANIFEST = path.join(ASSETS, 'manifest.json');
export const BIN = path.join(ROOT, 'bin', 'rev2d.js');

const FFMPEG_DIR = process.env.FFMPEG_DIR ?? 'C:\\Users\\Ndus_072\\ffmpeg-8.0-essentials_build\\bin';
export const FFMPEG = existsSync(path.join(FFMPEG_DIR, 'ffmpeg.exe')) ? path.join(FFMPEG_DIR, 'ffmpeg.exe') : 'ffmpeg';
export const FFPROBE = existsSync(path.join(FFMPEG_DIR, 'ffprobe.exe')) ? path.join(FFMPEG_DIR, 'ffprobe.exe') : 'ffprobe';

/**
 * Isolated home for the editor processes we start: the editor registry (~/.rev2d/editors) and the
 * recent-files list (~/.rev2d/recent.json) go here instead of the user's real home directory.
 */
export const SANDBOX_HOME = path.join(OUT, 'home');

export function sandboxEnv(extra = {}) {
  mkdirSync(SANDBOX_HOME, { recursive: true });
  return { ...process.env, USERPROFILE: SANDBOX_HOME, HOME: SANDBOX_HOME, NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Repo-relative, forward slashes (what the manifest stores). */
export function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

/** The exact command line as a human would type it in the repo root (for captions / manifest). */
export function displayCommand(args) {
  const q = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return ['rev2d', ...args.map(q)].join(' ');
}

/**
 * Run `node bin/rev2d.js <args>` to completion and capture everything.
 * Returns {command, argv, cwd, startedAt, endedAt, durationMs, exitCode, stdout, stderr}.
 */
export function runCli(args, { cwd = ROOT, env = sandboxEnv(), input } = {}) {
  const startedAt = new Date();
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  const durationMs = Math.round(performance.now() - t0);
  return {
    command: displayCommand(args),
    argv: ['node', 'bin/rev2d.js', ...args],
    cwd: rel(cwd) || '.',
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs,
    exitCode: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Async variant (the recording keeps running while the command does). */
export function runCliAsync(args, { cwd = ROOT, env = sandboxEnv() } = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const t0 = performance.now();
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('close', (code) =>
      resolve({
        command: displayCommand(args),
        argv: ['node', 'bin/rev2d.js', ...args],
        cwd: rel(cwd) || '.',
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - t0),
        exitCode: code,
        stdout,
        stderr,
      }),
    );
  });
}

export function must(result, what = result.command) {
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed with exit ${result.exitCode}\n${result.stderr}\n${result.stdout}`);
  }
  return result;
}

/** A free TCP port on 127.0.0.1 that is not one of the ports we must leave alone. */
export async function freePort(avoid = [4777, 4778, 4779, 4780, 4781]) {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
    if (!avoid.includes(port)) return port;
  }
}

/** PNG width/height from the IHDR chunk. */
export function pngSize(file) {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export function bytesOf(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((sum, f) => sum + bytesOf(path.join(p, f)), 0);
}

/** ffprobe summary of a video / gif: {width, height, fps, frames, duration, codec, pix_fmt}. */
export function probe(file) {
  const r = spawnSync(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,nb_read_frames,codec_name,pix_fmt:format=duration', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  const s = j.streams[0];
  const [n, d] = (s.avg_frame_rate && s.avg_frame_rate !== '0/0' ? s.avg_frame_rate : s.r_frame_rate).split('/').map(Number);
  return {
    width: s.width,
    height: s.height,
    fps: d ? Math.round((n / d) * 1000) / 1000 : null,
    frames: s.nb_read_frames ? Number(s.nb_read_frames) : null,
    duration: j.format?.duration ? Number(Number(j.format.duration).toFixed(3)) : null,
    codec: s.codec_name,
    pixFmt: s.pix_fmt,
  };
}

export function ffmpeg(args, { quiet = true } = {}) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-y', ...(quiet ? ['-loglevel', 'error'] : []), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr}`);
  return r;
}

/**
 * Replace this step's entries in out/video/assets/manifest.json (other steps' entries are kept).
 * Each entry: {id, path, kind, bytes, ...}; `path` is repo-relative.
 */
export function updateManifest(step, entries, stepInfo = {}) {
  ensureDir(ASSETS);
  let m = { project: 'Rev2D', generator: 'scripts/video', honesty: 'every asset is real Rev2D output (renders, editor captures, command output); nothing is mocked', steps: {}, assets: [] };
  if (existsSync(MANIFEST)) {
    try {
      m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    } catch {
      /* rebuild */
    }
  }
  m.updatedAt = new Date().toISOString();
  m.steps = { ...(m.steps ?? {}), [step]: { script: `scripts/video/${step}.mjs`, capturedAt: new Date().toISOString(), node: process.version, ...stepInfo } };
  m.assets = [...(m.assets ?? []).filter((a) => a.step !== step), ...entries.map((e) => ({ step, ...e }))];
  const tmp = `${MANIFEST}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  renameSync(tmp, MANIFEST);
  return m;
}

/** A manifest entry for one terminal step (command + verbatim output). */
export function commandEntry(id, result, extra = {}) {
  return {
    id,
    kind: 'command',
    command: result.command,
    argv: result.argv,
    cwd: result.cwd,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...extra,
  };
}

/** Save a command's transcript (as it would look in a terminal) next to the assets. */
export function writeTranscript(file, results) {
  const lines = [];
  for (const r of results) {
    lines.push(`$ ${r.command}`);
    if (r.stdout) lines.push(r.stdout.replace(/\s+$/, ''));
    if (r.stderr) lines.push(r.stderr.replace(/\s+$/, ''));
    lines.push(`[exit ${r.exitCode} · ${r.durationMs} ms · ${r.startedAt}]`, '');
  }
  writeFileSync(file, lines.join('\n'));
  return file;
}

export function log(...a) {
  console.log(`[video ${new Date().toISOString().slice(11, 19)}]`, ...a);
}
