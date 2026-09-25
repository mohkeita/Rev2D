/**
 * Step 1 - showcase frame sequences (30 fps) rendered by the real CLI `frames` command.
 *
 *   node scripts/video/01-showcase.mjs
 *
 * Output: out/video/assets/showcase/<model>-<anim>/frame_NNNN.png + manifest.json (from the CLI),
 * plus a lossless-ish preview mp4 per sequence (for review only) and entries in
 * out/video/assets/manifest.json. Scales are chosen so every sequence is 720 px tall.
 * Looping animations with physics (hana hair, robot-arm cable) use --warmup so frame 0 is already
 * in the steady state and the sequence loops seamlessly.
 */
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASSETS, bytesOf, commandEntry, ensureDir, ffmpeg, log, must, probe, rel, runCliAsync, updateManifest } from './lib.mjs';

const FPS = 30;
const JOBS = [
  { model: 'hana', anim: 'look_around', scale: 1.125, warmup: 6, note: 'head turns, eye darts, hair physics follows' },
  { model: 'hana', anim: 'talk', scale: 1.125, warmup: 4, note: 'mouth shapes + brows + cheek, 2 s loop' },
  { model: 'hana', anim: 'idle', scale: 1.125, warmup: 4, note: 'breathing, sway, blinks' },
  { model: 'slime', anim: 'jump_loop', scale: 1.8, note: 'squash & stretch jump, 1 s loop (no physics)' },
  { model: 'robot-arm', anim: 'reach', scale: 1.5, warmup: 4, note: 'two-bone IK reach + grip, cable physics' },
  { model: 'robot-arm', anim: 'drum', scale: 1.5, warmup: 4, note: 'finger taps, 0.9 s loop, cable physics' },
  { model: 'textured', anim: 'flutter', scale: 1.875, note: 'PNG-textured koinobori on warp lattices + spinning mesh pinwheel' },
];

const outRoot = ensureDir(path.join(ASSETS, 'showcase'));
const concurrency = Math.max(1, Math.min(4, os.availableParallelism() - 1));

async function runJob(job) {
  const name = `${job.model}-${job.anim}`;
  const dir = path.join(outRoot, name);
  rmSync(dir, { recursive: true, force: true });
  const args = [
    'frames',
    `examples/${job.model}/${job.model}.r2d.json`,
    '-o',
    rel(dir),
    '--anim',
    job.anim,
    '--fps',
    String(FPS),
    '--scale',
    String(job.scale),
    ...(job.warmup ? ['--warmup', String(job.warmup)] : []),
    '--json',
  ];
  log('start', name);
  const r = must(await runCliAsync(args));
  const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  // Review preview (not a deliverable): the sequence as an mp4 at 30 fps.
  const preview = path.join(outRoot, `${name}.preview.mp4`);
  ffmpeg(['-framerate', String(FPS), '-i', path.join(dir, 'frame_%04d.png'), '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-movflags', '+faststart', preview]);
  log('done', name, `${m.files.length} frames ${m.width}x${m.height} in ${r.durationMs} ms`);
  return [
    {
      ...commandEntry(`showcase/${name}`, r),
      kind: 'frames',
      path: rel(dir),
      pattern: 'frame_%04d.png',
      model: `examples/${job.model}/${job.model}.r2d.json`,
      animation: job.anim,
      width: m.width,
      height: m.height,
      fps: m.fps,
      frames: m.files.length,
      duration: Number((m.files.length / m.fps).toFixed(4)),
      loops: true,
      warmup: m.warmup ?? null,
      viewBox: m.viewBox,
      bytes: bytesOf(dir),
      note: job.note,
    },
    { id: `showcase/${name}.preview`, path: rel(preview), kind: 'video-preview', bytes: bytesOf(preview), ...probe(preview), note: 'review preview of the frame sequence (ffmpeg of the PNGs)' },
  ];
}

const queue = [...JOBS];
const entries = [];
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) entries.push(...(await runJob(job)));
  }),
);
entries.sort((a, b) => a.id.localeCompare(b.id));
updateManifest('01-showcase', entries, { fps: FPS, note: 'CLI frames command, 30 fps, 720 px tall' });
log('manifest updated,', entries.length, 'entries');
