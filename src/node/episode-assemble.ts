/** Timeline-preserving transitions and global narration/music mix. */
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import type { Diagnostic } from '../core/types.js';
import { apply, multiply } from '../core/math.js';
import { buildRenderList } from '../core/rig.js';
import { evaluateScene, cameraMatrix, type PreparedScene, type EvaluatedScene } from '../scene/index.js';
import {
  coverCrop,
  speechIntervals,
  episodeDiagnostic as diagnostic,
  type TimedShot,
} from '../episode/index.js';
import { loadScene, requireScene } from './scene.js';
import { findFfmpeg } from './video.js';
import { readEpisodeBuild, fail, jsonFile, digest, type EpisodeBuild } from './episode.js';
import { assertBuildCurrent, shotFingerprint, renderEngineFingerprint } from './episode-render.js';
import { runProgram, encoderArgs, videoArgs, checkSize, publishMedia, probeMedia } from './episode-media.js';
/** Bounds of visible geometry, excluding transparent margins of bitmap layers. */
function bounds(prepared: PreparedScene, ev: EvaluatedScene) {
  return ev.layers
    .filter(
      (s) => s.opacity > 0.01 && s.reveal > 0 && s.layer.type !== 'background' && s.layer.type !== 'color',
    )
    .map((s) => {
      let xy: number[] = [];
      if (s.source.rig && s.pose) {
        for (const draw of buildRenderList(s.source.rig, s.pose).draws)
          if (draw.colors.some((v, i) => i % 4 === 3 && v > 0.01)) xy.push(...draw.positions);
      } else if (s.source.image) {
        const image = s.source.image;
        let x0 = image.width,
          y0 = image.height,
          x1 = 0,
          y1 = 0;
        for (let y = 0; y < image.height; y++)
          for (let x = 0; x < image.width; x++)
            if (image.data[(y * image.width + x) * 4 + 3] > 127) {
              x0 = Math.min(x0, x);
              x1 = Math.max(x1, x + 1);
              y0 = Math.min(y0, y);
              y1 = Math.max(y1, y + 1);
            }
        xy = [x0, y0, x1, y1];
      } else xy = [0, 0, s.source.width, s.source.height];
      const m = multiply(cameraMatrix(prepared.scene, ev.camera, s.layer.depth), s.matrix);
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let i = 0; i < xy.length; i += 2) {
        const [x, y] = apply(m, xy[i], xy[i + 1]);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      return {
        id: s.layer.id,
        type: s.layer.type,
        bounds: [x0, y0, x1, y1] as [number, number, number, number],
      };
    });
}
export async function shotCrop(root: string, build: EpisodeBuild, t: TimedShot, size: [number, number]) {
  const source = build.episode.size;
  let focus: [number, number] = Array.isArray(t.shot.focus) ? t.shot.focus : [0.5, 0.5];
  const diagnostics: Diagnostic[] = [];
  let samples: ReturnType<typeof bounds>[] = [];
  if (!t.shot.external) {
    const p = requireScene(await loadScene(path.join(root, 'shots', t.shot.id, 'scene.json'))),
      factor = Math.min(source[0] / p.scene.width, source[1] / p.scene.height),
      dx = (source[0] - p.scene.width * factor) / 2,
      dy = (source[1] - p.scene.height * factor) / 2;
    samples = [0, t.duration / 2, Math.max(0, t.duration - 1 / build.episode.fps)].map((time) =>
      bounds(p, evaluateScene(p, time)).map((b) => ({
        ...b,
        bounds: [
          b.bounds[0] * factor + dx,
          b.bounds[1] * factor + dy,
          b.bounds[2] * factor + dx,
          b.bounds[3] * factor + dy,
        ] as [number, number, number, number],
      })),
    );
    if (!Array.isArray(t.shot.focus)) {
      const b = samples[1].find((b) =>
        t.shot.focus ? b.id === t.shot.focus : b.type === 'character' || b.type === 'model',
      );
      if (t.shot.focus && !b)
        fail(
          'episode-focus-unknown',
          '/shots/' + t.shot.id + '/focus',
          `unknown focus layer ${t.shot.focus}`,
          'use a visible layer id or a normalized [x,y] point',
        );
      if (b)
        focus = [(b.bounds[0] + b.bounds[2]) / 2 / source[0], (b.bounds[1] + b.bounds[3]) / 2 / source[1]];
    }
  }
  const crop = coverCrop(source, size, focus),
    outside = new Set<string>();
  if (size[0] / size[1] < source[0] / source[1])
    for (const sample of samples)
      for (const b of sample) {
        const [x0, y0, x1, y1] = b.bounds;
        if (x0 < crop[0] - 1 || y0 < crop[1] - 1 || x1 > crop[0] + crop[2] + 1 || y1 > crop[1] + crop[3] + 1)
          outside.add(b.id);
      }
  for (const id of outside)
    diagnostics.push(
      diagnostic(
        'episode-vertical-crop',
        `/shots/${t.shot.id}/layers/${id}`,
        `vertical crop can cut important layer ${id}`,
        'adjust focus, author a portrait scene or reposition that layer',
        'warning',
      ),
    );
  return { crop, focus, diagnostics };
}
export async function assembleEpisode(
  root: string,
  output: string,
  options: { size?: [number, number]; signal?: AbortSignal } = {},
) {
  root = path.resolve(root);
  output = path.resolve(output);
  const b = await readEpisodeBuild(root);
  await assertBuildCurrent(root, b);
  const size = options.size ?? b.episode.size;
  checkSize(size);
  const engine = await renderEngineFingerprint();
  for (const t of b.shots) {
    if (!b.built.includes(t.shot.id))
      fail(
        'episode-shot-not-built',
        '/shots/' + t.shot.id,
        'shot is not built',
        'build and render all episode shots',
      );
    const input = await shotFingerprint(root, b, t, engine),
      record = (await jsonFile(path.join(root, 'shots', t.shot.id, 'render.json'))) as {
        fingerprint: string;
        outputHash: string;
      };
    if (
      record.fingerprint !== input.fingerprint ||
      record.outputHash !== digest(await readFile(input.job.output))
    )
      fail(
        'episode-render-stale',
        '/shots/' + t.shot.id,
        'cached shot does not match its inputs or output bytes',
        'run episode render before assembly',
      );
  }
  const ffmpeg = await findFfmpeg(),
    tempdir = await mkdtemp(path.join(os.tmpdir(), 'rev2d-episode-')),
    diagnostics: Diagnostic[] = [],
    crops = [];
  const videos: string[] = [];
  try {
    for (const [i, t] of b.shots.entries()) {
      const input = path.join(root, 'shots', t.shot.id, 'shot.mp4'),
        c = await shotCrop(root, b, t, size);
      crops.push({ id: t.shot.id, ...c });
      diagnostics.push(...c.diagnostics);
      if (size[0] === b.episode.size[0] && size[1] === b.episode.size[1]) {
        videos.push(input);
        continue;
      }
      const [x, y, w, h] = c.crop,
        out = path.join(tempdir, `portrait-${i}.mp4`);
      await runProgram(
        ffmpeg,
        [
          ...encoderArgs,
          '-i',
          input,
          '-vf',
          `crop=w=${w}:h=${h}:x=${x}:y=${y},scale=${size[0]}:${size[1]},setsar=1`,
          '-frames:v',
          String(t.frames),
          ...videoArgs,
          '-an',
          out,
        ],
        options.signal,
      );
      videos.push(out);
    }
    // Make each incoming transition a bounded segment. Concatenating these exact-frame clips
    // avoids xfade/concat time-base drift across a long chain of fractional durations.
    const transitioned: string[] = [];
    for (const [i, t] of b.shots.entries()) {
      const tr = t.transition;
      if (!i || tr.type === 'cut') {
        transitioned.push(videos[i]);
        continue;
      }
      const frames = Math.round(tr.duration * b.episode.fps),
        previous = b.shots[i - 1],
        file = path.join(tempdir, `transition-${i}.mp4`);
      const type =
        tr.type === 'dissolve'
          ? 'fade'
          : tr.type === 'dip-to-black'
            ? 'fadeblack'
            : tr.type === 'whip-left'
              ? 'slideleft'
              : 'slideright';
      const timebase = `fps=${b.episode.fps},settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p`;
      const graph = [
        `[0:v]trim=start_frame=${previous.frames - 1}:end_frame=${previous.frames},${timebase},tpad=stop_mode=clone:stop=${frames - 1}[hold]`,
        '[1:v]split=2[head][tail]',
        `[head]trim=end_frame=${frames},${timebase}[incoming]`,
        `[tail]trim=start_frame=${frames}:end_frame=${t.frames},${timebase}[rest]`,
        `[hold][incoming]xfade=transition=${type}:duration=${tr.duration}:offset=0${tr.type.startsWith('whip') ? ",tmix=frames=3:weights='1 2 1'" : ''},fps=${b.episode.fps},trim=end_frame=${frames},setpts=N/(${b.episode.fps}*TB)[blend]`,
        `[blend][rest]concat=n=2:v=1:a=0,fps=${b.episode.fps},setpts=N/(${b.episode.fps}*TB)[out]`,
      ];
      await runProgram(
        ffmpeg,
        [
          ...encoderArgs,
          '-i',
          videos[i - 1],
          '-i',
          videos[i],
          '-filter_complex',
          graph.join(';'),
          '-map',
          '[out]',
          '-frames:v',
          String(t.frames),
          ...videoArgs,
          '-an',
          file,
        ],
        options.signal,
      );
      transitioned.push(file);
    }
    const joined = path.join(tempdir, 'joined.mp4'),
      list = path.join(tempdir, 'clips.txt');
    await writeFile(list, transitioned.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join('\n') + '\n');
    await runProgram(
      ffmpeg,
      [
        ...encoderArgs,
        '-f',
        'concat',
        '-safe',
        '0',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        list,
        '-c',
        'copy',
        '-an',
        joined,
      ],
      options.signal,
    );
    const base = path.dirname(path.resolve(root, b.storyboard)),
      voice = path.resolve(base, b.episode.narration.audio),
      music = b.episode.music,
      inputs = ['-i', joined, '-protocol_whitelist', 'file,pipe', '-i', voice];
    let audio = `[1:a]apad,atrim=duration=${b.duration},asetpts=PTS-STARTPTS[narration]`,
      label = 'narration';
    if (music) {
      inputs.push(
        '-stream_loop',
        '-1',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        path.resolve(base, music.src),
      );
      const amount = music.duck?.amount ?? 0,
        intervals = speechIntervals(b.words, b.duration);
      if (amount && intervals.length) {
        const condition = intervals.map(([s, e]) => `between(t,${s},${e})`).join('+');
        audio += `;[2:a]volume='${music.gain}*(1-${amount}*min(1,${condition}))':eval=frame,atrim=duration=${b.duration}[music]`;
      } else {
        audio += `;[2:a]volume=${music.gain},atrim=duration=${b.duration}[bed]`;
        if (amount) {
          audio +=
            ';[narration]asplit=2[voice][side];[bed][side]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=250:mix=' +
            amount +
            '[music]';
          label = 'voice';
        } else {
          audio += ';[bed]anull[music]';
        }
      }
      audio += `;[${label}][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false:latency=true[mix]`;
      label = 'mix';
    }
    const media = await publishMedia(output, async (temp) => {
      await runProgram(
        ffmpeg,
        [
          ...encoderArgs,
          ...inputs,
          '-filter_complex',
          audio,
          '-map',
          '0:v:0',
          '-map',
          `[${label}]`,
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-t',
          String(b.duration),
          '-movflags',
          '+faststart',
          temp,
        ],
        options.signal,
      );
      const media = await probeMedia(temp);
      if (
        media.frames !== b.frames ||
        !media.audio ||
        Math.abs(media.videoDuration - b.duration) > 1 / b.episode.fps ||
        Math.abs(media.audioDuration - b.duration) > 1 / b.episode.fps
      )
        fail(
          'episode-assembly-duration',
          '',
          `assembled media does not match ${b.frames} frames / ${b.duration}s: ${JSON.stringify(media)}`,
          'inspect encoder frame counts and audio duration',
        );
      return media;
    });
    return {
      ok: true,
      file: output,
      ...media,
      fps: b.episode.fps,
      frames: b.frames,
      cuts: b.shots.map((t) => ({
        id: t.shot.id,
        frame: t.startFrame,
        time: t.startFrame / b.episode.fps,
        transition: t.transition,
      })),
      crops,
      diagnostics,
    };
  } finally {
    await rm(tempdir, { recursive: true, force: true });
  }
}
