/** Image-producing commands: render, sheet, gif, frames, diff. */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ImageRGBA } from '../../core/types.js';
import {
  buildSheet,
  parseSweep,
  planOptions,
  planSamples,
  PoseStats,
  renderFrame,
  renderPose,
  samplePlanNotes,
  samplePoses,
  sharedViewBox,
  SHEET_DEFAULT_FRAMES,
  SWEEP_DEFAULT_STEPS,
  sweepLabel,
  toPoseOptions,
  viewSplit,
  type FrameInput,
  type SamplePlan,
  type SheetInput,
  type Sweep,
  type ViewBox,
} from '../../api/index.js';
import { decodePNG, diffImages, encodeGIF, encodePNG } from '../../render/index.js';
import { UsageError } from '../args.js';
import type { Command } from '../command.js';
import { CliError, type Ctx, type LoadedRig } from '../context.js';
import { checkAnimations, frameInput, idHint, outFlag, requireOut, sampledAnimation, sampleInput, usage } from '../flags.js';
import { num, plural, rect } from '../text.js';

/** Upper bounds that keep a typo (e.g. "--frames 10000") from exhausting memory. */
const MAX_SHEET_CELLS = 256;
/** Largest side of a sheet without --scale: cells are drawn smaller so the sheet fits (a note says so). */
const MAX_SHEET_SIDE = 4096;
const MAX_SEQUENCE_FRAMES = 2000;
/** A GIF is encoded from all frames at once: at most 2^27 RGBA pixels (512 MiB) in memory. */
const MAX_GIF_PIXELS = 2 ** 27;
/** GIF delays are whole centiseconds and browsers treat delays below 2 cs as 10 cs. */
const MAX_GIF_FPS = 50;

const SAMPLE_FLAG_NAMES = ['frames', 'fps', 'from', 'to', 'times', 'warmup'];

function listIds(ids: string[], max = 40): string {
  if (ids.length === 0) return '-';
  return ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')}, ... (+${ids.length - max})`;
}

function vbText(vb: readonly number[]): string {
  return vb.map((v) => num(v)).join(',');
}

// ----------------------------------------------------------------------------- render

export const render: Command = {
  name: 'render',
  group: 'check',
  summary: 'render one pose to a PNG (optionally with debug overlays)',
  usage: 'render <model> -o <out.png> [pose flags] [frame flags] [--json]',
  args: ['<model>'],
  flags: [outFlag('out.png', 'output PNG file (required; parent directories are created)')],
  flagGroups: ['pose', 'frame'],
  json: true,
  description: [
    'Renders the model deterministically (same inputs -> same pixels) and prints the output path, image size, view box and which parts are visible: in the view box or outside it.',
    'Use --overlay bones,labels to see the rig (--only ids to focus on some bones/parts), --viewbox fit to crop to the visible parts, --scale 2 for detail.',
    'Notes (stderr, or "notes" in --json) flag IK chains out of reach or nearly straight (snap risk), physics outputs clamped to their parameter range, parts entirely outside the canvas (the default view box; an explicit --viewbox crop only notes when nothing visible is in it) and clamped --param values.',
  ],
  examples: [
    'rev2d render hero.r2d.json -o out/hero.png',
    'rev2d render hero.r2d.json -o out/rig.png --overlay bones,warps,labels --viewbox fit --scale 2',
    'rev2d render hero.r2d.json -o out/arm.png --overlay bones,labels --only foreArm --only-chain',
    'rev2d render hero.r2d.json -o out/look-left.png --param AngleX=-30 --param EyeOpen=0.2',
    'rev2d render hero.r2d.json -o out/idle-1s.png --anim idle --anim talk@0.8,add --time 1',
  ],
  async run(ctx) {
    const out = requireOut(ctx.args, 'rev2d render model.r2d.json -o out.png');
    const m = await ctx.loadRig(ctx.args.positionals[0]);
    const notes: string[] = [];
    const input = frameInput(ctx.args, m.model, notes);
    const f = renderFrame(m, input);
    const file = ctx.writeFile(out, encodePNG(f.image));
    const visible = f.pose.drawOrder;
    const hidden = m.model.parts.map((p) => p.id).filter((id) => !visible.includes(id));
    const { inView, outsideView } = viewSplit(f.pose, f.viewBox, m.model);
    const stats = new PoseStats(m.model, f.viewBox);
    stats.add(f.pose);
    notes.push(...stats.notes());
    if (ctx.json) {
      ctx.printJson({
        file,
        width: f.image.width,
        height: f.image.height,
        viewBox: f.viewBox,
        scale: f.scale,
        time: f.pose.time,
        overlay: input.overlay ?? [],
        params: f.pose.params,
        visibleParts: visible,
        inView,
        outsideView,
        hiddenParts: hidden,
        events: f.pose.events,
        notes,
      });
      return 0;
    }
    ctx.out(`wrote ${ctx.display(file)} (${f.image.width}x${f.image.height}, viewBox ${vbText(f.viewBox)}, scale ${num(f.scale)}, t=${num(f.pose.time)}s)`);
    if (outsideView.length) {
      ctx.out(`visible parts in view (${inView.length}, back to front): ${listIds(inView)}`, `visible parts outside the view box (${outsideView.length}): ${listIds(outsideView)}`);
    } else {
      ctx.out(`visible parts (${visible.length}, back to front): ${listIds(visible)}`);
    }
    if (hidden.length) ctx.out(`hidden parts (${hidden.length}): ${listIds(hidden)}`);
    ctx.notes(notes);
    return 0;
  },
};

// ----------------------------------------------------------------------------- sheet

export const sheet: Command = {
  name: 'sheet',
  group: 'check',
  summary: 'contact sheet: an animation over time, 1-2 parameter sweeps, or an overview of parameters, in one PNG',
  usage:
    'sheet <model> -o <out.png> (--anim <id> [sampling flags] | --sweep <spec> [--sweep <spec>] | --overview [ids] [--steps n]) [--columns n] [--title t] [pose flags] [frame flags] [--json]',
  args: ['<model>'],
  flags: [
    outFlag('out.png', 'output PNG file (required)'),
    {
      name: 'sweep',
      type: 'string',
      repeat: true,
      arg: 'spec',
      description: 'parameter sweep: "AngleX" (5 steps over its range), "AngleX=-30:30:7" (min:max:steps), "AngleX=-30,0,30", linked "EyeLOpen,EyeROpen=0:1:5"; a second --sweep makes a grid (rows)',
    },
    { name: 'overview', type: 'string', optionalValue: true, arg: 'ids', description: 'one row per parameter (all, or the comma-listed ids) over its range, captioned with the values' },
    { name: 'steps', type: 'int', min: 1, max: 64, arg: 'n', description: `--overview: values per parameter row (default ${SWEEP_DEFAULT_STEPS})` },
    { name: 'columns', type: 'int', min: 1, arg: 'n', description: 'cells per row (default: sweep length, overview steps, or a square-ish grid)' },
    { name: 'title', type: 'string', arg: 'text', description: 'title bar text (default: model name and what is shown, incl. extra layers)' },
  ],
  flagGroups: ['sample', 'pose', 'frame'],
  flagNotes: {
    time: 'sweep and overview sheets: time in seconds for animation layers and physics (animation sheets reject it: use --from/--to or --times)',
    anim: 'animation sheet: the first --anim is sampled (plain id); more --anim flags are layers "id[@weight][,add|override|once|hold|start=s|time=s]". Sweep/overview sheets: layers at --time',
    frames: `animation sheets: number of cells spread over the window (default ${SHEET_DEFAULT_FRAMES})`,
    fps: `animation sheets: sample at this rate instead of ${SHEET_DEFAULT_FRAMES} cells (frames per second of animation time)`,
  },
  json: true,
  description: [
    'Animation sheet (--anim): the first --anim is sampled at --frames evenly spaced times (default 8) over the window --from/--to (default the whole animation; a looping animation over exactly one cycle excludes t=duration), or at the --times given. Further --anim flags play as extra layers and are named in the title ("idle + talk(add)"). Each caption is the frame time; events in [t, next t) are listed under it. --warmup s (looping animations) runs whole cycles first so physics is in its steady state.',
    'Sweep sheet (--sweep): each cell sets the swept parameter(s) ("A,B=0:1:5" links parameters: both get the same values); --param/--anim/--time set the rest of the pose. Overview (--overview [ids]): one row per parameter over its whole range, --steps values each (default 5).',
    'All cells share one view box: --viewbox fit covers the visible parts of every cell, so cells are directly comparable. Notes report IK reach/snap risk, clamped physics outputs and parts entirely outside the canvas over all cells (with an explicit --viewbox crop: only when nothing visible is in it).',
    `Cells are drawn at scale 1 unless --scale is given; a sheet that would be larger than ${MAX_SHEET_SIDE} px on a side is drawn smaller to fit, with a note.`,
  ],
  examples: [
    'rev2d sheet hero.r2d.json -o out/idle.png --anim idle --frames 12',
    'rev2d sheet hero.r2d.json -o out/talk.png --anim look_around --anim talk,add --from 1 --to 3 --frames 9',
    'rev2d sheet hero.r2d.json -o out/hair.png --anim idle --warmup 10 --frames 8',
    'rev2d sheet hero.r2d.json -o out/anglex.png --sweep AngleX',
    'rev2d sheet hero.r2d.json -o out/eyes.png --sweep EyeLOpen,EyeROpen=0:1:5',
    'rev2d sheet hero.r2d.json -o out/grid.png --sweep AngleX=-30:30:5 --sweep AngleY=-30,0,30 --overlay warps',
    'rev2d sheet hero.r2d.json -o out/overview.png --overview --steps 5',
  ],
  async run(ctx) {
    const out = requireOut(ctx.args, 'rev2d sheet model.r2d.json -o sheet.png --anim idle');
    const m = await ctx.loadRig(ctx.args.positionals[0]);
    const model = m.model;
    const specs = ctx.args.list('sweep');
    const overviewRaw = ctx.args.str('overview');
    const anims = checkAnimations(ctx.args.list('anim'), model);
    const notes: string[] = [];
    const base = frameInput(ctx.args, model, notes);
    const columns = ctx.args.num('columns');
    const title = ctx.args.str('title');
    const sampling = SAMPLE_FLAG_NAMES.filter((f) => ctx.args.has(f));
    let input: SheetInput;
    let cells: number;
    if (specs.length && overviewRaw !== undefined) throw new UsageError('--sweep and --overview are different sheets; give one of them');
    if (ctx.args.has('steps') && overviewRaw === undefined) throw new UsageError('--steps applies to --overview sheets', 'sweeps take their steps in the spec, e.g. --sweep AngleX=-30:30:7');
    if ((specs.length || overviewRaw !== undefined) && sampling.length) {
      throw new UsageError(`--${sampling[0]} applies to animation sheets (--anim without --sweep/--overview)`, 'sweep and overview cells show one pose each (at --time)');
    }
    if (specs.length) {
      if (specs.length > 2) throw new UsageError(`at most 2 --sweep flags (columns x rows), got ${specs.length}`);
      const sweeps: Sweep[] = specs.map((s) => usage(() => parseSweep(model, s), '--sweep: '));
      if (sweeps.length === 2) {
        const first = [sweeps[0].param, ...(sweeps[0].linked ?? [])];
        const shared = [sweeps[1].param, ...(sweeps[1].linked ?? [])].find((id) => first.includes(id));
        if (shared) throw new UsageError(`both sweeps vary "${shared}"; sweep two different parameters`, 'the first sweep varies across columns, the second down rows');
      }
      cells = sweeps.reduce((n, s) => n * s.values.length, 1);
      input = { ...base, sweeps, columns, title };
    } else if (overviewRaw !== undefined) {
      const ids = overviewRaw.split(',').map((s) => s.trim()).filter(Boolean);
      const all = model.parameters.map((p) => p.id);
      for (const id of ids) if (!all.includes(id)) throw new UsageError(`unknown parameter "${id}" in --overview`, idHint(id, all, 'parameters'));
      if (!all.length) throw new UsageError('the model has no parameters to show in an overview', 'sheet an animation (--anim) instead');
      const steps = ctx.args.num('steps') ?? SWEEP_DEFAULT_STEPS;
      cells = (ids.length ? new Set(ids).size : all.length) * steps;
      input = { ...base, overview: { ...(ids.length ? { params: ids } : {}), steps }, columns, title };
    } else if (anims.length) {
      if (ctx.args.has('time')) {
        throw new UsageError('--time does not apply to animation sheets (their cells are sampled over the animation)', 'choose the window with --from/--to, the count with --frames, or list --times a:b:n');
      }
      const animation = sampledAnimation(anims[0], model, false);
      const window = sampleInput(ctx.args);
      const frames = window.frames ?? (window.fps !== undefined || window.times !== undefined ? undefined : SHEET_DEFAULT_FRAMES);
      const plan = usage(() => planSamples(model, { ...window, animation, frames }));
      cells = plan.times.length;
      input = { ...base, ...window, frames, animations: anims.slice(1), animation, columns, title };
    } else {
      throw new UsageError('sheet needs --anim <id>, --sweep <spec> or --overview [ids]', 'e.g. --anim idle --frames 8, --sweep AngleX=-30:30:5, or --overview');
    }
    if (cells > MAX_SHEET_CELLS) throw new UsageError(`the sheet would have ${cells} cells (max ${MAX_SHEET_CELLS})`, 'use fewer sweep/overview steps, fewer parameters, or fewer --frames');
    const r = buildSheet(m, { ...input, maxSide: MAX_SHEET_SIDE });
    const file = ctx.writeFile(out, encodePNG(r.image));
    notes.push(...r.notes);
    const summary: Record<string, unknown> =
      r.mode === 'sweep'
        ? { sweeps: r.sweeps }
        : r.mode === 'overview'
          ? { overview: { params: r.overview!.params, steps: r.overview!.steps } }
          : { animation: r.animation, layers: anims.slice(1), times: r.times, warmup: r.plan!.offset, events: r.events };
    if (ctx.json) {
      ctx.printJson({ file, width: r.image.width, height: r.image.height, cells: r.cells, columns: r.columns, viewBox: r.viewBox, scale: r.scale, mode: r.mode, title: r.title, ...summary, notes });
      return 0;
    }
    const what =
      r.mode === 'sweep'
        ? r.sweeps!.map((s) => `${sweepLabel(s)}=${s.values.map((v) => num(v)).join(',')}`).join(' x ')
        : r.mode === 'overview'
          ? `${r.overview!.params.join(', ')} (${r.overview!.steps} steps each)`
          : `${[r.animation, ...(r.layers ?? [])].join(' + ')} at t=${r.times!.map((t) => num(t, 2)).join(',')}s${r.plan!.offset ? ` (after ${num(r.plan!.offset)}s warm-up)` : ''}`;
    ctx.out(`wrote ${ctx.display(file)} (${r.image.width}x${r.image.height}, ${plural(r.cells, 'cell')}, ${r.columns} per row, cell viewBox ${vbText(r.viewBox)}${r.scale !== 1 ? `, scale ${num(r.scale)}` : ''})`, `cells: ${what}`);
    if (r.events?.length) ctx.out(`events: ${r.events.map((e) => `${e.animation}:${e.name}@${num(e.t)}s (cell ${e.cell})`).join(', ')}`);
    ctx.notes(notes);
    return 0;
  },
};

// ----------------------------------------------------------------------------- sequences (gif, frames)

interface SequencePlan {
  animation: string;
  layers: string[];
  plan: SamplePlan;
  /** Frame input with the view box already resolved (shared by every frame). */
  input: FrameInput & { viewBox: ViewBox };
  notes: string[];
}

function planSequence(ctx: Ctx, m: LoadedRig, example: string): SequencePlan {
  const model = m.model;
  const anims = checkAnimations(ctx.args.list('anim'), model);
  if (!anims.length) throw new UsageError('missing --anim <id>', `e.g. ${example}${model.animations.length ? ` (animations: ${model.animations.map((a) => a.id).join(', ')})` : ''}`);
  if (ctx.args.has('time')) {
    throw new UsageError('--time does not apply here (frames are sampled over the animation)', 'choose the window with --from/--to, the count with --fps or --frames, or list --times a:b:n');
  }
  const animation = sampledAnimation(anims[0], model, true);
  const plan = usage(() => planSamples(model, { ...sampleInput(ctx.args), animation }));
  if (plan.times.length > MAX_SEQUENCE_FRAMES) throw new UsageError(`${plan.times.length} frames is too many (max ${MAX_SEQUENCE_FRAMES})`, 'lower --fps or --frames');
  const notes: string[] = [];
  // frameInput() turns every --anim into a pose layer, so the sampled animation plays first (with its weight).
  const input = frameInput(ctx.args, model, notes);
  const options = planOptions(toPoseOptions(model, input), plan);
  // One view box for every frame: 'fit' is resolved over all poses first (GIF frames must share a size).
  const viewBox = input.viewBox === 'fit' ? sharedViewBox(model, samplePoses(m.rig, options, plan.evalTimes), input) : sharedViewBox(model, [], input);
  notes.push(...samplePlanNotes(model, plan));
  return { animation, layers: anims.slice(1), plan, input: { ...input, viewBox }, notes };
}

/** Render the planned frames one at a time with incremental physics; returns the notes over all frames. */
function renderPlanned(m: LoadedRig, seq: SequencePlan, each: (image: ImageRGBA, index: number) => void): string[] {
  const stats = new PoseStats(m.model, seq.input.viewBox);
  const options = planOptions(toPoseOptions(m.model, seq.input), seq.plan);
  let i = 0;
  for (const pose of samplePoses(m.rig, options, seq.plan.evalTimes)) {
    stats.add(pose, seq.plan.times[i]);
    each(renderPose(m, m.rig, pose, seq.input).image, i++);
  }
  return stats.notes();
}

export const gif: Command = {
  name: 'gif',
  group: 'check',
  summary: 'render an animation to a looping animated GIF',
  usage: 'gif <model> -o <out.gif> --anim <id> [sampling flags] [--no-loop] [pose flags] [frame flags] [--json]',
  args: ['<model>'],
  flags: [outFlag('out.gif', 'output GIF file (required)'), { name: 'loop', type: 'boolean', description: 'loop forever (default; --no-loop plays once)' }],
  flagGroups: ['sample', 'sequencePose', 'frame'],
  json: true,
  description: [
    'The first --anim is played frame by frame with incremental physics over the window (--from/--to, default the whole animation) or at --times; more --anim flags add layers. Playback speed matches real time: --fps, or frames/window when only --frames is given (GIF playback tops out at 50 fps). --warmup s (looping animations) starts the recording after whole cycles of physics warm-up.',
    'All frames share one view box: --viewbox fit covers the visible parts of every frame. The whole GIF is encoded in memory (at most 134M pixels over all frames). Notes report IK reach/snap risk, clamped physics outputs and parts entirely outside the canvas over all frames (with an explicit --viewbox crop: only when nothing visible is in it).',
  ],
  examples: [
    'rev2d gif hero.r2d.json -o out/idle.gif --anim idle',
    'rev2d gif hero.r2d.json -o out/walk.gif --anim walk --fps 15 --viewbox fit --scale 0.5',
    'rev2d gif hero.r2d.json -o out/hair.gif --anim idle --warmup 10',
  ],
  async run(ctx) {
    const out = requireOut(ctx.args, 'rev2d gif model.r2d.json -o idle.gif --anim idle');
    const m = await ctx.loadRig(ctx.args.positionals[0]);
    const seq = planSequence(ctx, m, 'rev2d gif model.r2d.json -o idle.gif --anim idle');
    const images: ImageRGBA[] = [];
    const frameNotes = renderPlanned(m, seq, (img, i) => {
      if (i === 0 && img.width * img.height * seq.plan.times.length > MAX_GIF_PIXELS) {
        const mp = (img.width * img.height * seq.plan.times.length) / 1e6;
        throw new UsageError(
          `the GIF would hold ${seq.plan.times.length} frames of ${img.width}x${img.height} (${num(mp, 1)} megapixels; max ${num(MAX_GIF_PIXELS / 1e6, 1)})`,
          'lower --scale, crop with --viewbox, or use fewer frames (--fps/--frames); "rev2d frames" writes PNGs one by one without this limit',
        );
      }
      images.push(img);
    });
    const loop = ctx.args.bool('loop') ?? true;
    const fps = seq.plan.fps;
    const bytes = encodeGIF(images, { fps, loop });
    const file = ctx.writeFile(out, bytes);
    const { width, height } = images[0];
    const notes = [...seq.notes, ...frameNotes];
    if (fps > MAX_GIF_FPS) {
      notes.push(`GIF frame delays are whole centiseconds (at least 2), so this ${num(fps, 2)} fps GIF plays at about ${MAX_GIF_FPS} fps, slower than real time; use --fps ${MAX_GIF_FPS} or lower`);
    }
    const viewBox = seq.input.viewBox;
    if (ctx.json) {
      ctx.printJson({ file, width, height, viewBox, animation: seq.animation, layers: seq.layers, frames: images.length, fps, loop, bytes: bytes.length, times: seq.plan.times, warmup: seq.plan.offset, notes });
      return 0;
    }
    ctx.out(`wrote ${ctx.display(file)} (${width}x${height}, ${plural(images.length, 'frame')} at ${num(fps, 2)} fps, ${loop ? 'looping' : 'plays once'}, ${bytes.length} bytes, viewBox ${vbText(viewBox)})`);
    ctx.notes(notes);
    return 0;
  },
};

const FRAME_FILE = /^frame_\d{4,}\.png$/;

export const frames: Command = {
  name: 'frames',
  group: 'check',
  summary: 'render an animation to a PNG sequence plus manifest.json',
  usage: 'frames <model> -o <dir> --anim <id> [sampling flags] [pose flags] [frame flags] [--json]',
  args: ['<model>'],
  flags: [outFlag('dir', 'output directory (required; created if missing)')],
  flagGroups: ['sample', 'sequencePose', 'frame'],
  json: true,
  description: [
    'Writes dir/frame_0000.png, frame_0001.png, ... and dir/manifest.json {animation, layers, fps, width, height, viewBox, times, files} (plus warmup when --warmup is used). Stale frame_NNNN.png files from a previous longer run are removed so the directory always matches the manifest.',
    'Sampling as for gif (--fps/--frames over --from/--to, or --times; --warmup for looping animations with physics). All frames share one view box (--viewbox fit covers the visible parts of every frame), so they have the same size.',
  ],
  examples: [
    'rev2d frames hero.r2d.json -o out/idle --anim idle',
    'rev2d frames hero.r2d.json -o out/walk --anim walk --frames 16 --overlay bones',
    'rev2d frames hero.r2d.json -o out/jump --anim jump --times 0.4,0.5,0.6',
  ],
  async run(ctx) {
    const out = requireOut(ctx.args, 'rev2d frames model.r2d.json -o out/idle --anim idle');
    const m = await ctx.loadRig(ctx.args.positionals[0]);
    const seq = planSequence(ctx, m, 'rev2d frames model.r2d.json -o out/idle --anim idle');
    const dir = ctx.resolve(out);
    const files: string[] = [];
    let size: [number, number] = [0, 0];
    const frameNotes = renderPlanned(m, seq, (img, i) => {
      const name = `frame_${String(i).padStart(4, '0')}.png`;
      ctx.writeFile(path.join(dir, name), encodePNG(img));
      files.push(name);
      size = [img.width, img.height];
    });
    const keep = new Set(files);
    const stale = readdirSync(dir).filter((n) => FRAME_FILE.test(n) && !keep.has(n));
    for (const n of stale) rmSync(path.join(dir, n), { force: true });
    const viewBox = seq.input.viewBox;
    const manifest = {
      animation: seq.animation,
      layers: seq.layers,
      fps: seq.plan.fps,
      width: size[0],
      height: size[1],
      viewBox,
      times: seq.plan.times,
      ...(seq.plan.offset ? { warmup: seq.plan.offset } : {}),
      files,
    };
    const manifestFile = ctx.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const notes = [...seq.notes, ...frameNotes];
    if (ctx.json) {
      ctx.printJson({ dir, manifest: manifestFile, removedStale: stale.length, ...manifest, notes });
      return 0;
    }
    ctx.out(`wrote ${files.length} frames (${size[0]}x${size[1]}, viewBox ${vbText(viewBox)}) to ${ctx.display(dir)}/frame_0000.png..${files[files.length - 1]} and manifest.json`);
    if (stale.length) ctx.out(`removed ${plural(stale.length, 'stale frame')} from a previous run`);
    ctx.notes(notes);
    return 0;
  },
};

// ----------------------------------------------------------------------------- diff

function readPng(ctx: Ctx, file: string): ImageRGBA {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(ctx.resolve(file));
  } catch (e) {
    throw new CliError(`cannot read ${ctx.display(file)}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  try {
    return decodePNG(bytes);
  } catch (e) {
    throw new CliError(`${ctx.display(file)} is not a readable PNG: ${(e as Error).message}`);
  }
}

/** Bounding box [x, y, w, h] (image pixels) of the pixels whose max channel delta exceeds `threshold`. */
function changedRegion(a: ImageRGBA, b: ImageRGBA, threshold: number): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const delta = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]), Math.abs(a.data[i + 3] - b.data[i + 3]));
      if (delta <= threshold) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

export const diff: Command = {
  name: 'diff',
  group: 'check',
  summary: 'compare two PNGs pixel by pixel (regression checks for renders)',
  usage: 'diff <a.png> <b.png> [-o diff.png] [--threshold n] [--fail-on-diff] [--json]',
  args: ['<a.png>', '<b.png>'],
  flags: [
    outFlag('diff.png', 'write a visualization: a dimmed, changed pixels in red'),
    { name: 'threshold', type: 'number', min: 0, max: 255, arg: '0..255', description: 'a pixel differs when its max channel delta exceeds this (default 0)' },
    { name: 'fail-on-diff', type: 'boolean', description: 'exit 1 when any pixel differs' },
  ],
  json: true,
  description: ['Reports how many pixels differ and the bounding box of the changed region (image pixels), so a change can be located without looking.'],
  examples: ['rev2d diff before.png after.png', 'rev2d diff expected.png actual.png -o out/diff.png --threshold 8 --fail-on-diff'],
  async run(ctx) {
    const [fa, fb] = ctx.args.positionals;
    const a = readPng(ctx, fa);
    const b = readPng(ctx, fb);
    if (a.width !== b.width || a.height !== b.height) {
      throw new CliError(`size mismatch: ${ctx.display(fa)} is ${a.width}x${a.height}, ${ctx.display(fb)} is ${b.width}x${b.height}`, {
        hint: 'render both with the same --scale and --viewbox',
      });
    }
    const threshold = ctx.args.num('threshold') ?? 0;
    const d = diffImages(a, b, { threshold });
    const region = changedRegion(a, b, threshold);
    const out = ctx.args.str('out');
    const diffFile = out ? ctx.writeFile(out, encodePNG(d.image)) : null;
    const total = d.width * d.height;
    const ratio = total ? d.differentPixels / total : 0;
    const identical = d.differentPixels === 0;
    if (ctx.json) {
      ctx.printJson({
        a: ctx.resolve(fa),
        b: ctx.resolve(fb),
        width: d.width,
        height: d.height,
        threshold,
        identical,
        differentPixels: d.differentPixels,
        totalPixels: total,
        ratio,
        maxDelta: d.maxDelta,
        meanDelta: d.meanDelta,
        region,
        diff: diffFile,
      });
    } else {
      ctx.out(
        identical
          ? `identical: no pixel differs by more than ${num(threshold)} (${d.width}x${d.height}; max delta ${d.maxDelta})`
          : `${d.differentPixels} of ${total} pixels differ (${num(ratio * 100, 3)}%) at threshold ${num(threshold)}; max delta ${d.maxDelta}, mean delta ${num(d.meanDelta, 3)}; changed region ${rect(region, 0)} (x, y, w, h)`,
      );
      if (diffFile) ctx.out(`wrote ${ctx.display(diffFile)}`);
    }
    return !identical && ctx.args.bool('fail-on-diff') ? 1 : 0;
  },
};
