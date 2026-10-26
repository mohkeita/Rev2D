/** New review directories: visual sheets, analysis, a readable index, and per-shot thumbnails. */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadScene, writeSceneFrame, writeSceneSheet, analyzeLoadedScene } from './scene.js';
import { findFfmpeg } from './video.js';
import { runProgram, encoderArgs, probeMedia } from './episode-media.js';
import { readEpisodeBuild, jsonFile, writeAtomic, fail, relative, type EpisodeBuild } from './episode.js';
import type { TimedShot } from '../episode/index.js';
async function newDirectory(output: string) {
  output = path.resolve(output);
  if (existsSync(output))
    fail('episode-output-exists', '/out', 'review directory already exists', 'choose a new output directory');
  await mkdir(output, { recursive: true });
  return output;
}
async function externalVideo(root: string, t: TimedShot) {
  const shot = path.join(root, 'shots', t.shot.id),
    cached = path.join(shot, 'shot.mp4');
  if (existsSync(cached)) return { file: cached, from: 0 };
  const source = (await jsonFile(path.join(shot, 'external.json'))) as { video: string; from: number };
  return { file: path.resolve(shot, source.video), from: source.from };
}
async function externalImage(root: string, t: TimedShot, file: string, time: number, sheet = false) {
  const video = await externalVideo(root, t),
    ffmpeg = await findFfmpeg();
  await runProgram(ffmpeg, [
    ...encoderArgs,
    '-protocol_whitelist',
    'file,pipe',
    '-ss',
    String(video.from + (sheet ? 0 : time)),
    '-i',
    video.file,
    '-vf',
    sheet ? `fps=${6 / t.duration},scale=320:-2,tile=3x2` : 'scale=640:-2',
    '-frames:v',
    '1',
    file,
  ]);
}
function assertBuilt(b: EpisodeBuild, t: TimedShot) {
  if (!b.built.includes(t.shot.id))
    fail('episode-shot-not-built', '/shots/' + t.shot.id, 'shot not built', 'run episode build first');
}
export async function episodeThumbnails(
  root: string,
  output: string,
  options: { at?: 'middle' | 'start' | 'end' } = {},
) {
  root = path.resolve(root);
  const b = await readEpisodeBuild(root),
    at = options.at ?? 'middle';
  if (!['middle', 'start', 'end'].includes(at))
    fail('episode-thumbnail-time', '/at', 'invalid thumbnail time', 'use middle, start or end');
  output = await newDirectory(output);
  const files = [];
  for (const t of b.shots) {
    assertBuilt(b, t);
    const time =
        at === 'start' ? 0 : at === 'end' ? Math.max(0, t.duration - 1 / b.episode.fps) : t.duration / 2,
      file = path.join(output, t.shot.id + '.png');
    if (t.shot.external) await externalImage(root, t, file, time);
    else {
      const loaded = await loadScene(path.join(root, 'shots', t.shot.id, 'scene.json'));
      await writeSceneFrame(loaded, file, time, {
        scale: Math.min(1, 640 / (loaded.prepared?.scene.width ?? 640)),
      });
    }
    files.push({ id: t.shot.id, file, time });
  }
  await writeAtomic(path.join(output, 'index.json'), files);
  return { ok: true, directory: output, files };
}
const escape = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const href = (s: string) =>
  s
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
function analysisNotes(value: unknown): string[] {
  const notes = new Set<string>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.message === 'string' && o.severity !== 'info')
      notes.add(String(o.code ?? 'note') + ': ' + o.message);
    if (Array.isArray(o.notes)) for (const n of o.notes) if (typeof n === 'string') notes.add(n);
    for (const [k, x] of Object.entries(o)) if (k !== 'notes') visit(x);
  };
  visit(value);
  return [...notes];
}
export async function reportEpisode(root: string, output: string) {
  root = path.resolve(root);
  const b = await readEpisodeBuild(root);
  output = await newDirectory(output);
  const rows = [];
  for (const t of b.shots) {
    assertBuilt(b, t);
    const dir = path.join(output, t.shot.id);
    await mkdir(dir);
    let analysis: unknown;
    if (t.shot.external) {
      await externalImage(root, t, path.join(dir, 'sheet.png'), 0, true);
      analysis = {
        external: true,
        media: await probeMedia((await externalVideo(root, t)).file),
        notes: ['Explicit external video; rig/gesture analysis does not apply.'],
      };
    } else {
      const loaded = await loadScene(path.join(root, 'shots', t.shot.id, 'scene.json'));
      await writeSceneSheet(loaded, path.join(dir, 'sheet.png'), {
        frames: 6,
        scale: Math.min(0.5, 320 / (loaded.prepared?.scene.width ?? 640)),
      });
      analysis = { validation: loaded.diagnostics, ...analyzeLoadedScene(loaded) };
    }
    await writeAtomic(path.join(dir, 'analysis.json'), analysis);
    rows.push({
      id: t.shot.id,
      start: t.startFrame / b.episode.fps,
      end: t.endFrame / b.episode.fps,
      frames: t.frames,
      note: t.shot.note,
      sheet: t.shot.id + '/sheet.png',
      analysis: t.shot.id + '/analysis.json',
      video: relative(output, path.join(root, 'shots', t.shot.id, 'shot.mp4')),
      transition: t.transition,
      notes: analysisNotes(analysis),
    });
  }
  await writeAtomic(path.join(output, 'index.json'), {
    id: b.id,
    frames: b.frames,
    duration: b.duration,
    shots: rows,
  });
  await writeFile(
    path.join(output, 'index.md'),
    `# ${b.id}\n\n${b.frames} frames · ${b.duration}s · ${b.episode.fps}fps\n\n` +
      rows
        .map(
          (r) =>
            `## ${r.id} — ${r.start.toFixed(3)}–${r.end.toFixed(3)}s\n\n${r.note.replaceAll('<', '&lt;')}\n\n${r.notes.length ? r.notes.map((n) => '- ' + n.replaceAll('<', '&lt;')).join('\n') : 'No analysis notes.'}\n\n![${r.id}](${href(r.sheet)})\n\n[Analysis](${href(r.analysis)}) · [Video](${href(r.video)})\n`,
        )
        .join('\n'),
    { flag: 'wx' },
  );
  await writeFile(
    path.join(output, 'index.html'),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(b.id)} review</title><style>body{font:16px system-ui;background:#f1f4f8;color:#172133;max-width:1100px;margin:32px auto;padding:0 20px}article{background:white;border:1px solid #ccd5e0;border-radius:12px;padding:20px;margin:24px 0}img{width:100%;height:auto}a{color:#1b55a5}p{line-height:1.6}small{color:#4b596c}</style><h1>${escape(b.id)} — review</h1><p>${b.frames} frames · ${b.duration}s · ${b.episode.fps}fps</p>` +
      rows
        .map(
          (r) =>
            `<article><h2>${escape(r.id)}</h2><small>${r.start.toFixed(3)}–${r.end.toFixed(3)}s · ${r.frames} frames · ${r.transition.type}</small><p>${escape(r.note)}</p><details><summary>${r.notes.length} analysis notes</summary><ul>${r.notes.map((n) => '<li>' + escape(n) + '</li>').join('')}</ul></details><img src="${href(r.sheet)}" alt="Six frames of ${escape(r.id)}"><p><a href="${href(r.analysis)}">Analysis and notes</a> · <a href="${href(r.video)}">Shot video</a></p></article>`,
        )
        .join('') +
      '</html>',
    { flag: 'wx' },
  );
  return { ok: true, directory: output, shots: rows.length, index: path.join(output, 'index.html') };
}
