/**
 * Multi-frame outputs: animation sequences (GIF / PNG frames), contact sheets of an animation, of
 * parameter sweeps (one or two, optionally linked parameters) and parameter overviews (one row per
 * parameter over its range).
 */
import type { AnimationLayer, ImageRGBA, Model, Pose } from '../core/types.js';
import { composeSheet, sheetSize, type SheetCell } from '../render/index.js';
import type { LoadedModel } from '../node/load.js';
import { ApiError, fmtNum, idHint, show } from './errors.js';
import { renderPose, sharedViewBox, type FrameInput, type FrameResult, type ViewBox } from './frame.js';
import { formatLayerLabel } from './layers.js';
import { requireRig, toPoseOptions } from './pose.js';
import { planOptions, planSamples, sampleEvents, samplePlanNotes, samplePoses, type SampleInput, type SamplePlan } from './sampling.js';
import { PoseStats } from './stats.js';

// ----------------------------------------------------------------------------- sweeps

export interface Sweep {
  param: string;
  values: number[];
  /** Further parameters that get the same values in every cell ("EyeLOpen,EyeROpen=0:1:5"). */
  linked?: string[];
}

/** Values of a sweep without an explicit count ("Param", "Param=min:max"). */
export const SWEEP_DEFAULT_STEPS = 5;
/** Upper bound on the values of one sweep (a typo like "0:1:10000" must not allocate a huge sheet). */
export const MAX_SWEEP_VALUES = 1000;

const SWEEP_FORMS = `forms: "Param" (${SWEEP_DEFAULT_STEPS} values over its range), "Param=min:max" (${SWEEP_DEFAULT_STEPS} values), "Param=min:max:steps" or "Param=v1,v2,..."; "A,B=..." links parameters (same values)`;

/**
 * Parse a parameter sweep:
 *
 *   "AngleX"                 5 values evenly over the parameter's range
 *   "AngleX=-30:30"          5 values from -30 to 30
 *   "AngleX=-30:30:7"        7 values from -30 to 30 (steps: a whole number >= 2, or 1 for just min)
 *   "AngleX=-30,0,30"        exactly these values
 *   "EyeLOpen,EyeROpen=0:1"  linked: both parameters get the same values in every cell
 *
 * Every number must be finite; anything else is an ApiError whose hint shows the accepted forms
 * (or a did-you-mean for an unknown parameter). Values outside the parameter's range are kept (they
 * are clamped when the pose is evaluated). A linked sweep without values needs parameters with the
 * same range.
 */
export function parseSweep(model: Model, spec: string): Sweep {
  if (typeof spec !== 'string') throw new ApiError(`a sweep must be a string like "AngleX=-30:30:5", got ${show(spec)}`, [], SWEEP_FORMS);
  const ids = model.parameters.map((p) => p.id);
  const eq = spec.indexOf('=');
  const names = (eq < 0 ? spec : spec.slice(0, eq)).split(',').map((s) => s.trim());
  if (names.every((n) => !n)) {
    const first = model.parameters[0];
    const example = first ? `${first.id}=${first.min}:${first.max}:${SWEEP_DEFAULT_STEPS}` : `AngleX=-30:30:${SWEEP_DEFAULT_STEPS}`;
    throw new ApiError(`sweep "${spec}" names no parameter`, [], `start with a parameter id, e.g. "${example}"`);
  }
  if (names.some((n) => !n)) throw new ApiError(`sweep "${spec}" has an empty parameter id in its list`, [], 'link parameters as "A,B=min:max" (comma-separated ids before "=")');
  const params = names.map((id) => {
    const p = model.parameters.find((q) => q.id === id);
    if (!p) throw new ApiError(`unknown parameter "${id}" in sweep "${spec}"`, [], idHint(id, ids, 'parameters'));
    return p;
  });
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new ApiError(`sweep "${spec}" lists "${dup}" twice`, [], 'list each linked parameter once');
  const [p] = params;
  const result = (values: number[]): Sweep => (params.length > 1 ? { param: p.id, values, linked: names.slice(1) } : { param: p.id, values });
  if (eq < 0) {
    const other = params.find((q) => q.min !== p.min || q.max !== p.max);
    if (other) {
      throw new ApiError(
        `linked parameters in sweep "${spec}" have different ranges (${p.id} ${p.min}..${p.max}, ${other.id} ${other.min}..${other.max})`,
        [],
        `give the values explicitly, e.g. "${names.join(',')}=${Math.max(p.min, other.min)}:${Math.min(p.max, other.max)}:${SWEEP_DEFAULT_STEPS}"`,
      );
    }
    return result(linspace(p.min, p.max, SWEEP_DEFAULT_STEPS));
  }

  const bad = (why: string) => new ApiError(`bad sweep "${spec}": ${why}`, [], `${SWEEP_FORMS}, e.g. "${p.id}=${p.min}:${p.max}:${SWEEP_DEFAULT_STEPS}"`);
  const number = (raw: string, what: string): number => {
    const v = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(v)) throw bad(raw.trim() === '' ? `${what} is missing` : `${what} ${JSON.stringify(raw.trim())} is not a finite number`);
    return v;
  };
  const range = spec.slice(eq + 1);
  if (range.trim() === '') throw bad('no values after "="');
  if (range.includes('=')) throw bad('more than one "="');
  if (range.includes(':')) {
    const parts = range.split(':');
    if (parts.length > 3) throw bad(`expected min:max or min:max:steps, got ${parts.length} ":"-separated parts`);
    const min = number(parts[0], 'min');
    const max = number(parts[1], 'max');
    let steps = SWEEP_DEFAULT_STEPS;
    if (parts.length === 3) {
      steps = number(parts[2], 'steps');
      if (!Number.isInteger(steps) || steps < 1) throw bad(`steps must be a whole number >= 2 (or 1 for just min), got ${parts[2].trim()}`);
      if (steps > MAX_SWEEP_VALUES) throw bad(`${steps} steps is too many (max ${MAX_SWEEP_VALUES})`);
    }
    return result(linspace(min, max, steps));
  }
  const items = range.split(',');
  if (items.length > MAX_SWEEP_VALUES) throw bad(`${items.length} values is too many (max ${MAX_SWEEP_VALUES})`);
  return result(items.map((raw, i) => number(raw, `value ${i + 1}`)));
}

export function linspace(a: number, b: number, n: number): number[] {
  if (n <= 1) return [a];
  return Array.from({ length: n }, (_, i) => +(a + ((b - a) * i) / (n - 1)).toFixed(6));
}

/** "EyeLOpen,EyeROpen" for a linked sweep, else the parameter id. */
export function sweepLabel(s: Sweep): string {
  return [s.param, ...(s.linked ?? [])].join(',');
}

/**
 * Cell captions exactly as buildSheet writes them, for callers that size a sheet before building it
 * (sheetSize / fitSheetScale take the texts, because captions wrap in narrow cells).
 */
export const sheetCaption = {
  /** Animation cell: "t=0.25s". */
  time: (t: number): string => `t=${t.toFixed(2)}s`,
  /** Sweep cell: "AngleX=30" or, in a grid, "AngleX=30 AngleY=-30". */
  sweep: (sx: Sweep, vx: number, sy?: Sweep, vy?: number): string =>
    sy && vy !== undefined ? `${sweepLabel(sx)}=${fmtNum(vx)} ${sweepLabel(sy)}=${fmtNum(vy)}` : `${sweepLabel(sx)}=${fmtNum(vx)}`,
  /** Overview cell: "MouthOpen=0.5". */
  overview: (param: string, v: number): string => `${param}=${fmtNum(v)}`,
};

/** The parameter values a sweep sets to `v`. */
function sweepParams(s: Sweep, v: number): Record<string, number> {
  const out: Record<string, number> = { [s.param]: v };
  for (const id of s.linked ?? []) out[id] = v;
  return out;
}

/** Notes for sweep values outside the parameters' ranges (evaluation clamps them). */
export function sweepClampNotes(model: Model, sweep: Sweep): string[] {
  const notes: string[] = [];
  for (const id of [sweep.param, ...(sweep.linked ?? [])]) {
    const p = model.parameters.find((q) => q.id === id);
    if (!p) continue;
    const outside = sweep.values.filter((v) => v < p.min || v > p.max);
    if (outside.length) {
      notes.push(`sweep ${id}: ${outside.map((v) => fmtNum(v)).join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside its range [${fmtNum(p.min)}..${fmtNum(p.max)}] and clamped (such cells look like the range end)`);
    }
  }
  return notes;
}

// ----------------------------------------------------------------------------- sequences

export interface SequenceInput extends FrameInput, Omit<SampleInput, 'animation'> {
  /** The sampled animation; `animations` are extra layers on top of it. */
  animation: string;
}

export interface SequenceResult {
  /** Animation-local sample times. */
  times: number[];
  frames: FrameResult[];
  /** The view box shared by every frame (viewBox 'fit' covers the visible parts of all frames). */
  viewBox: ViewBox;
  plan: SamplePlan;
  /** IK / physics / view-box findings over all frames (see PoseStats). */
  notes: string[];
}

/** Checked pose options of a sampled animation plus its extra layers, shifted for the plan's warm-up. */
function sequenceOptions(model: Model, input: SequenceInput | SheetInput, animation: string, plan: SamplePlan) {
  const base = toPoseOptions(model, { ...input, animations: [animation, ...(input.animations ?? [])] });
  return { base, options: planOptions(base, plan) };
}

/**
 * Render an animation frame by frame with incremental physics. Extra layers from input.animations
 * play on top. All frames share one view box: with viewBox 'fit' every pose is evaluated first and
 * the union of their bounds frames the whole sequence, so frames have the same size and do not jitter.
 */
export function renderSequence(m: LoadedModel, input: SequenceInput): SequenceResult {
  const rig = requireRig(m);
  const plan = planSamples(rig.model, { ...input, animation: input.animation });
  const { options } = sequenceOptions(rig.model, input, input.animation, plan);
  const poses = [...samplePoses(rig, options, plan.evalTimes)];
  const viewBox = sharedViewBox(rig.model, poses, input);
  const stats = new PoseStats(rig.model, viewBox);
  poses.forEach((p, i) => stats.add(p, plan.times[i]));
  const frames = poses.map((pose) => renderPose(m, rig, pose, { ...input, viewBox }));
  return { times: plan.times, frames, viewBox, plan, notes: [...samplePlanNotes(rig.model, plan), ...stats.notes()] };
}

// ----------------------------------------------------------------------------- sheets

export interface OverviewInput {
  /** Parameters, one row each (default: every parameter, in model order). */
  params?: string[];
  /** Values per row, evenly over each parameter's range (default 5). */
  steps?: number;
}

export interface SheetInput extends FrameInput {
  /** Animation contact sheet: the sampled animation (`animations` are extra layers). */
  animation?: string;
  /** Animation sheets: cells over the window (default 8 unless fps or times is given). */
  frames?: number;
  fps?: number;
  from?: number;
  to?: number;
  times?: number[];
  warmup?: number;
  /** Parameter sweep: one sweep = a row of cells; two sweeps = grid (first varies across columns). */
  sweeps?: Sweep[];
  /** Parameter overview: one row per parameter over its range. */
  overview?: OverviewInput;
  columns?: number;
  title?: string;
  /**
   * Without `scale`: the largest sheet side in px. Cells are rendered smaller (never larger than
   * scale 1) so the composed sheet fits, and a note says so. Default: no limit (cells at scale 1).
   */
  maxSide?: number;
}

export interface SheetResult {
  image: ImageRGBA;
  mode: 'animation' | 'sweep' | 'overview';
  cells: number;
  columns: number;
  /** Model-space region of every cell. */
  viewBox: ViewBox;
  /** Cell scale (output px per model px). */
  scale: number;
  title: string;
  captions: string[];
  /** Animation sheets. */
  animation?: string;
  /** Labels of the extra layers ("talk(add)"). */
  layers?: string[];
  times?: number[];
  plan?: SamplePlan;
  /** Animation sheets: events per cell (cell i covers [times[i], times[i+1])). */
  events?: Array<{ cell: number; animation: string; name: string; t: number }>;
  sweeps?: Sweep[];
  overview?: { params: string[]; steps: number; rows: Array<{ param: string; values: number[] }> };
  /** IK / physics / view-box findings over all cells, plus sampling notes. */
  notes: string[];
}

/** Default number of cells of an animation sheet. */
export const SHEET_DEFAULT_FRAMES = 8;

/**
 * A contact sheet: an animation sampled over time, one or two parameter sweeps, or an overview of
 * several parameters. Every cell shares one view box; with viewBox 'fit' all cell poses are evaluated
 * first and the union of their bounds frames every cell, so cells are directly comparable.
 */
export function buildSheet(m: LoadedModel, input: SheetInput): SheetResult {
  const rig = requireRig(m);
  const model = rig.model;
  const modes = [input.animation ? 'animation' : null, input.sweeps?.length ? 'sweeps' : null, input.overview ? 'overview' : null].filter(Boolean);
  if (modes.length > 1) {
    throw new ApiError(`a sheet shows one of an animation, parameter sweeps or a parameter overview, got ${modes.join(' and ')}`, [], 'drop all but one of `animation`, `sweeps` and `overview`');
  }
  const specs: Array<{ pose: Pose; caption: string; subcaption?: string }> = [];
  type Extra = Omit<SheetResult, 'image' | 'cells' | 'columns' | 'viewBox' | 'scale' | 'title' | 'captions' | 'notes'>;
  let result: Extra;
  let naturalColumns: number | undefined;
  const notes: string[] = [];
  let defaultTitle: string;

  if (input.animation) {
    const frames = input.frames ?? (input.fps !== undefined || input.times !== undefined ? undefined : SHEET_DEFAULT_FRAMES);
    const plan = planSamples(model, { ...input, animation: input.animation, frames });
    const { base, options } = sequenceOptions(model, input, input.animation, plan);
    const poses = [...samplePoses(rig, options, plan.evalTimes)];
    const events = sampleEvents(rig, base, plan);
    const layers = (base.animations ?? []).slice(1) as AnimationLayer[];
    poses.forEach((pose, i) => {
      const names = events[i].map((e) => (e.animation === plan.animation ? e.name : `${e.animation}:${e.name}`));
      specs.push({ pose, caption: sheetCaption.time(plan.times[i]), ...(names.length ? { subcaption: names.join(' ') } : {}) });
    });
    result = {
      mode: 'animation',
      animation: plan.animation,
      layers: layers.map(formatLayerLabel),
      times: plan.times,
      plan,
      events: events.flatMap((list, cell) => list.map((e) => ({ cell, animation: e.animation, name: e.name, t: e.t }))),
    };
    notes.push(...samplePlanNotes(model, plan));
    const window = input.from !== undefined || input.to !== undefined ? ` t=${fmtNum(plan.times[0])}..${fmtNum(plan.end)}s` : '';
    const warm = plan.offset ? ` after ${fmtNum(plan.offset)}s warm-up` : '';
    defaultTitle = `${model.meta.name} - ${[plan.animation, ...layers.map(formatLayerLabel)].join(' + ')}${window}${warm}`;
  } else if (input.sweeps?.length) {
    if (input.sweeps.length > 2) throw new ApiError(`at most 2 sweeps (columns x rows), got ${input.sweeps.length}`, [], 'the first sweep varies across columns, the second down rows');
    const [sx, sy] = input.sweeps;
    for (const s of input.sweeps) {
      if (!s.values.length) throw new ApiError(`sweep "${s.param}" has no values`, [], SWEEP_FORMS);
    }
    if (sy) {
      const shared = [sx.param, ...(sx.linked ?? [])].find((id) => [sy.param, ...(sy.linked ?? [])].includes(id));
      if (shared) throw new ApiError(`both sweeps vary "${shared}"`, [], 'sweep two different parameters (the first varies across columns, the second down rows)');
    }
    for (const vy of sy ? sy.values : [NaN]) {
      for (const vx of sx.values) {
        const params = { ...(input.params ?? {}), ...sweepParams(sx, vx), ...(sy ? sweepParams(sy, vy) : {}) };
        const pose = rig.pose(toPoseOptions(model, { ...input, params }));
        specs.push({ pose, caption: sy ? sheetCaption.sweep(sx, vx, sy, vy) : sheetCaption.sweep(sx, vx) });
      }
    }
    result = { mode: 'sweep', sweeps: input.sweeps };
    naturalColumns = sx.values.length;
    for (const s of input.sweeps) notes.push(...sweepClampNotes(model, s));
    defaultTitle = `${model.meta.name} - sweep ${input.sweeps.map(sweepLabel).join(' x ')}`;
  } else if (input.overview) {
    const ids = model.parameters.map((p) => p.id);
    const listed = input.overview.params?.length ? input.overview.params : ids;
    if (!listed.length) throw new ApiError('the model has no parameters to show in an overview', [], 'add parameters first, or sheet an animation instead');
    for (const id of listed) {
      if (!ids.includes(id)) throw new ApiError(`unknown parameter "${id}" in overview`, [], idHint(id, ids, 'parameters'));
    }
    const steps = input.overview.steps ?? SWEEP_DEFAULT_STEPS;
    if (!Number.isInteger(steps) || steps < 1 || steps > 64) throw new ApiError(`overview steps must be a whole number within 1..64, got ${show(steps)}`, [], `e.g. steps ${SWEEP_DEFAULT_STEPS} (the default)`);
    const rows = [...new Set(listed)].map((id) => {
      const p = model.parameters.find((q) => q.id === id)!;
      return { param: id, values: linspace(p.min, p.max, steps) };
    });
    for (const row of rows) {
      for (const v of row.values) {
        const pose = rig.pose(toPoseOptions(model, { ...input, params: { ...(input.params ?? {}), [row.param]: v } }));
        specs.push({ pose, caption: sheetCaption.overview(row.param, v) });
      }
    }
    result = { mode: 'overview', overview: { params: rows.map((r) => r.param), steps, rows } };
    naturalColumns = steps;
    defaultTitle = `${model.meta.name} - overview: ${rows.length} parameter${rows.length === 1 ? '' : 's'} x ${steps} steps`;
  } else {
    throw new ApiError('sheet needs an animation, parameter sweeps or a parameter overview', [], 'pass `animation` (frames over time), `sweeps` (see parseSweep) or `overview` (one row per parameter)');
  }

  const poses = specs.map((s) => s.pose);
  const viewBox = sharedViewBox(model, poses, input);
  const stats = new PoseStats(model, viewBox);
  poses.forEach((p) => stats.add(p));
  notes.push(...stats.notes());
  const title = input.title ?? defaultTitle;
  const count = specs.length;
  const columns = Math.max(1, Math.min(count, Math.floor(input.columns ?? naturalColumns ?? Math.ceil(Math.sqrt(count)))));
  let scale = input.scale ?? 1;
  if (input.scale === undefined && input.maxSide !== undefined) {
    // The caption texts: wrapped captions make the caption area taller in narrower cells.
    const layout = { columns, title, captions: specs.map((s) => s.caption), subcaptions: specs.map((s) => s.subcaption) };
    const fit = fitSheetScale(viewBox, count, input.maxSide, layout);
    if (fit < 1) {
      const natural = sheetSize(count, Math.round(viewBox[2]), Math.round(viewBox[3]), layout);
      notes.push(
        `cells are drawn at scale ${fmtNum(fit)} so the ${count}-cell sheet fits ${input.maxSide} px per side (at scale 1 it would be ${natural.width}x${natural.height} px); set scale explicitly (--scale) to override, or show fewer cells or a smaller view box`,
      );
      scale = fit;
    }
  }
  const cellInput = { ...input, viewBox, scale };
  const cells: SheetCell[] = specs.map((s) => ({ image: renderPose(m, rig, s.pose, cellInput).image, caption: s.caption, ...(s.subcaption ? { subcaption: s.subcaption } : {}) }));
  const image = composeSheet(cells, { columns, title });
  return { ...result, image, cells: count, columns, viewBox, scale, title, captions: specs.map((s) => s.caption), notes };
}

/**
 * Largest cell scale <= 1 (3 decimals, or 3 significant digits below 0.1) at which a sheet of `count`
 * cells showing `viewBox` fits `maxSide` px on both sides. Pass the caption texts in `layout`
 * (`captions`, `subcaptions`) for an exact fit: captions wrap onto more lines in narrower cells, so the
 * caption area grows as the scale shrinks.
 */
export function fitSheetScale(viewBox: ViewBox, count: number, maxSide: number, layout: Parameters<typeof sheetSize>[3] = {}): number {
  const cellW = (s: number) => Math.max(1, Math.round(viewBox[2] * s));
  const fits = (s: number) => {
    const { width, height } = sheetSize(count, cellW(s), Math.max(1, Math.round(viewBox[3] * s)), layout);
    return width <= maxSide && height <= maxSide;
  };
  if (fits(1)) return 1;
  const { columns, rows } = sheetSize(count, 1, 1, layout);
  const round = (v: number) => (v >= 0.1 ? Math.floor(v * 1000) / 1000 : Number(v.toPrecision(3)));
  // Padding, title and caption area at scale s (the captions depend on the cell width): the largest
  // scale whose cells fit next to them. Narrower cells can only need more caption lines, so this
  // never grows; it settles within a few steps (captions wrap onto at most a few lines).
  let s = 1;
  for (let i = 0; i < 10; i++) {
    const fixed = sheetSize(count, cellW(s), 0, layout);
    const next = Math.min((maxSide - (fixed.width - columns * cellW(s))) / (columns * viewBox[2]), (maxSide - fixed.height) / (rows * viewBox[3]));
    if (!(next > 0)) return 1e-3;
    const r = Math.min(s, round(next));
    if (r === s) break;
    s = r;
  }
  // Rounded cell sizes can overshoot by a pixel per cell: step down until the sheet fits.
  for (let i = 0; i < 20 && s > 1e-3 && !fits(s); i++) s = round(s * 0.995);
  return Math.max(1e-3, s);
}

/** buildSheet's image only. */
export function renderSheet(m: LoadedModel, input: SheetInput): ImageRGBA {
  return buildSheet(m, input).image;
}
