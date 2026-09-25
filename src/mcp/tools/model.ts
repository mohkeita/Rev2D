/**
 * Model tools: validate, info, render, sheet, inspect, analyze and hit test. They never modify the
 * model; render and sheet can also save their PNG (save_to). Every call loads the model fresh from disk.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Model, Pose } from '../../core/types.js';
import { paramDefault } from '../../core/address.js';
import { formatDiagnostics } from '../../core/validate.js';
import { loadModelFile } from '../../node/load.js';
import {
  analyzeAnimation,
  buildSheet,
  fitViewBox,
  formatAnalysis,
  formatInfo,
  hitTest,
  inspectPose,
  inspectSeries,
  modelInfo,
  parseSweep,
  planOptions,
  planSamples,
  PoseStats,
  renderPose,
  resolveViewBox,
  samplePoses,
  sheetCaption,
  SHEET_DEFAULT_FRAMES,
  SWEEP_DEFAULT_STEPS,
  sweepLabel,
  TRACK_COLUMN_FORMS,
  toPoseOptions,
  trackSeries,
  type FrameInput,
  type InspectResult,
  type SamplePlan,
  type Sweep,
  type TrackResult,
} from '../../api/index.js';
import { encodePNG, sheetSize } from '../../render/index.js';
import {
  addTool,
  autoScale,
  checkOutputSize,
  displayPath,
  fileNotFound,
  fmtNum,
  fmtScale,
  image,
  json,
  listPreview,
  loadModel,
  MAX_IMAGE_SIDE,
  mcpText,
  MAX_RENDER_SIDE,
  MAX_SHEET_SIDE,
  MAX_UPSCALE,
  MIN_IMAGE_SIDE,
  requireKnownIds,
  requirePoseIds,
  resolvePath,
  result,
  saveFile,
  text,
  ToolError,
  warningNote,
  type ReadyModel,
  type ToolContext,
} from '../context.js';
import { frameShape, MAX_TIME, pathField, poseShape, saveToField, toFrameInput, toPoseInput } from '../schemas.js';

type Rect = [number, number, number, number];

/** "AngleX=30, EyeOpen=0" for parameters away from their default, or "all at defaults". */
export function paramSummary(model: Model, params: Record<string, number>): string {
  const changed = model.parameters
    .filter((p) => Math.abs((params[p.id] ?? paramDefault(p)) - paramDefault(p)) > 1e-6)
    .map((p) => `${p.id}=${fmtNum(params[p.id])}`);
  return changed.length ? changed.join(', ') : 'all at defaults';
}

/** One line per IK constraint of the pose: "armIk extension 0.93 (reaches the target)". */
function ikSummary(model: Model, pose: Pose): string {
  const items = model.ik.flatMap((k) => {
    const d = pose.ik?.[k.id];
    if (!d) return [];
    const aim = k.bones.length === 1 && !k.stretch;
    const state = d.reached
      ? 'reaches the target'
      : aim
        ? 'one bone aiming at the target'
        : d.extension <= 1
          ? `within reach; softness keeps the tip ${fmtNum(d.error)} px short`
          : `out of reach: misses the target by ${fmtNum(d.error)} px`;
    return [`${k.id} extension ${fmtNum(d.extension)} (${state}${d.stretch !== undefined && Math.abs(d.stretch - 1) > 1e-6 ? `, stretched x${fmtNum(d.stretch)}` : ''})`];
  });
  return items.length ? `IK: ${items.join('; ')}` : '';
}

/** Render one frame with the auto-scale policy. Shared by rev2d_render and apply_ops render_after. */
export function renderForAgent(m: ReadyModel, input: FrameInput): { png: Uint8Array; summary: string[] } {
  requirePoseIds(m.model, input);
  const pose = m.rig.pose(toPoseOptions(m.model, input));
  const viewBox = resolveViewBox(m.model, pose, input);
  const scale = input.scale ?? autoScale(viewBox[2], viewBox[3]);
  checkOutputSize('the image', Math.round(viewBox[2] * scale), Math.round(viewBox[3] * scale), MAX_RENDER_SIDE);
  const frame = renderPose(m, m.rig, pose, { ...input, viewBox, scale });
  const hidden = m.model.parts.map((p) => p.id).filter((id) => !pose.drawOrder.includes(id));
  const summary = [
    `${frame.image.width}x${frame.image.height} px image of viewBox [${viewBox.map(fmtNum).join(', ')}] (model px) at scale ${fmtScale(scale)}, t=${fmtNum(pose.time)}s`,
    `params: ${paramSummary(m.model, pose.params)}`,
    `visible parts (${pose.drawOrder.length}, back to front): ${listPreview(pose.drawOrder) || 'none'}`,
  ];
  if (hidden.length) summary.push(`hidden parts (visible=false or opacity 0): ${listPreview(hidden)}`);
  if (pose.events.length) summary.push(`events at t: ${pose.events.map((e) => `${e.animation}:${e.name}`).join(', ')}`);
  const ik = ikSummary(m.model, pose);
  if (ik) summary.push(ik);
  // IK out of reach / near snapping, physics outputs clamped, parts outside the view box.
  const stats = new PoseStats(m.model, viewBox);
  stats.add(pose);
  for (const note of stats.notes()) summary.push(`note: ${mcpText(note)}`);
  return { png: encodePNG(frame.image), summary };
}

// ----------------------------------------------------------------------------- sheets

const MAX_SHEET_CELLS = 64;

type SheetPlan =
  | { kind: 'animation'; animation: string; plan: SamplePlan; events: boolean }
  | { kind: 'sweep'; sweeps: Sweep[]; cells: Array<Record<string, number>> }
  | { kind: 'overview'; rows: Array<{ param: string; values: number[] }>; steps: number; cells: Array<Record<string, number>> };

const SWEEP_FORMS = '"Param" (5 values over its range), "Param=min:max:steps", "Param=v1,v2,..." or linked "A,B=min:max:steps" (same values for both)';

/** parseSweep with did-you-mean ids and a strict "min:max:steps" form (whole number of steps). */
function sweepOf(model: Model, spec: string): Sweep {
  const eq = spec.indexOf('=');
  const ids = (eq < 0 ? spec : spec.slice(0, eq)).split(',').map((s) => s.trim());
  requireKnownIds('parameter', ids.filter(Boolean), model.parameters.map((p) => p.id));
  const id = ids.join(',');
  const range = eq < 0 ? '' : spec.slice(eq + 1).trim();
  const bad = (why: string) => new ToolError(`bad sweep "${spec}": ${why}`, [], `forms: ${SWEEP_FORMS}, e.g. "${id}=-30:30:5"`);
  if (eq >= 0 && !range) throw bad('no values after "="');
  if (range.includes(':')) {
    const parts = range.split(':');
    if (parts.length > 3) throw bad('use min:max:steps');
    if (parts.length === 3 && !/^\s*[1-9]\d*\s*$/.test(parts[2])) throw bad('steps must be a whole number >= 1');
  }
  // The API names the remaining problems (linked ranges differ, bad numbers) with a hint.
  return parseSweep(model, spec);
}

interface SheetArgs {
  animation?: string;
  frames?: number;
  fps?: number;
  from?: number;
  to?: number;
  times?: number[];
  warmup?: number;
  sweeps?: string[];
  overview?: true | { params?: string[]; steps?: number };
  time?: number;
}

function planSheet(m: ReadyModel, a: SheetArgs): SheetPlan {
  const model = m.model;
  const animations = model.animations.map((x) => x.id);
  const parameters = model.parameters.map((p) => p.id);
  const modes = [a.animation ? '`animation`' : '', a.sweeps?.length ? '`sweeps`' : '', a.overview ? '`overview`' : ''].filter(Boolean);
  if (modes.length > 1) throw new ToolError(`give one of \`animation\`, \`sweeps\` or \`overview\`, not ${modes.join(' and ')}`);
  const windowArgs = (['frames', 'fps', 'from', 'to', 'times', 'warmup'] as const).filter((k) => a[k] !== undefined);
  if (!a.animation && windowArgs.length) {
    throw new ToolError(`${windowArgs.join(', ')} only apply to an animation sheet`, [], 'pass `animation` to sample it over time, or drop them for sweeps / overview');
  }
  if (a.animation) {
    requireKnownIds('animation', [a.animation], animations);
    if (a.time !== undefined) {
      throw new ToolError('`time` does not apply to an animation sheet: its cells are spread over the animation', [], 'remove time; use frames, fps, from/to or times to choose the sample times');
    }
    const frames = a.frames ?? (a.fps !== undefined || a.times !== undefined ? undefined : SHEET_DEFAULT_FRAMES);
    const plan = planSamples(model, { animation: a.animation, frames, fps: a.fps, from: a.from, to: a.to, times: a.times, warmup: a.warmup });
    if (plan.times.length > MAX_SHEET_CELLS) {
      throw new ToolError(`${plan.times.length} frames is too many for one sheet (max ${MAX_SHEET_CELLS})`, [], 'lower fps, pass frames, or narrow from/to');
    }
    return { kind: 'animation', animation: a.animation, plan, events: model.animations.some((x) => x.events?.length) };
  }
  if (a.overview) {
    const o = a.overview === true ? {} : a.overview;
    if (o.params) requireKnownIds('parameter', o.params, parameters);
    const listed = [...new Set(o.params?.length ? o.params : parameters)];
    if (!listed.length) throw new ToolError('the model has no parameters to show in an overview', [], 'add parameters first, or sheet an animation instead');
    const steps = o.steps ?? SWEEP_DEFAULT_STEPS;
    const count = listed.length * steps;
    if (count > MAX_SHEET_CELLS) {
      throw new ToolError(
        `${listed.length} parameters x ${steps} steps = ${count} cells is too many for one sheet (max ${MAX_SHEET_CELLS})`,
        [],
        `pass overview {params: [...]} with at most ${Math.floor(MAX_SHEET_CELLS / steps)} parameters, or fewer steps`,
      );
    }
    const rows = listed.map((id) => {
      const p = model.parameters.find((q) => q.id === id)!;
      return { param: id, values: steps <= 1 ? [p.min] : Array.from({ length: steps }, (_, i) => +(p.min + ((p.max - p.min) * i) / (steps - 1)).toFixed(6)) };
    });
    return { kind: 'overview', rows, steps, cells: rows.flatMap((r) => r.values.map((v) => ({ [r.param]: v }))) };
  }
  if (!a.sweeps?.length) {
    throw new ToolError(
      'a sheet needs `animation` (frames over time), `sweeps` (parameter values) or `overview` (one row per parameter)',
      [],
      `animations: ${animations.join(', ') || 'none'}; parameters: ${parameters.join(', ') || 'none'}`,
    );
  }
  if (a.sweeps.length > 2) throw new ToolError('at most 2 sweeps: the first varies across columns, the second down rows');
  const sweeps = a.sweeps.map((s) => sweepOf(model, s));
  const [sx, sy] = sweeps;
  const count = sx.values.length * (sy ? sy.values.length : 1);
  if (count > MAX_SHEET_CELLS) throw new ToolError(`${count} cells is too many for one sheet (max ${MAX_SHEET_CELLS})`, [], 'use fewer sweep steps');
  const set = (s: Sweep, v: number) => Object.fromEntries([s.param, ...(s.linked ?? [])].map((id) => [id, v]));
  const cells: Array<Record<string, number>> = [];
  for (const vy of sy ? sy.values : [NaN]) {
    for (const vx of sx.values) cells.push({ ...set(sx, vx), ...(sy ? set(sy, vy) : {}) });
  }
  return { kind: 'sweep', sweeps, cells };
}

function cellCount(plan: SheetPlan): number {
  return plan.kind === 'animation' ? plan.plan.times.length : plan.cells.length;
}

/** One viewBox for every cell (the union of their "fit" boxes) so motion stays visible across cells. */
function sheetFitViewBox(m: ReadyModel, input: FrameInput, plan: SheetPlan): Rect {
  let poses: Pose[];
  if (plan.kind === 'animation') {
    const base = toPoseOptions(m.model, { ...input, animations: [plan.animation, ...(input.animations ?? [])] });
    poses = [...samplePoses(m.rig, planOptions(base, plan.plan), plan.plan.evalTimes)];
  } else {
    poses = plan.cells.map((params) => m.rig.pose(toPoseOptions(m.model, { ...input, params: { ...(input.params ?? {}), ...params } })));
  }
  return fitViewBox(poses, input.padding ?? 16) ?? [0, 0, m.model.meta.width, m.model.meta.height];
}

/** The caption texts buildSheet will write under the cells (event subcaptions are only known after sampling). */
interface SheetCaptions {
  captions: string[];
  /** Whether cells may list events; reserves one line (event lists that wrap add at most one more). */
  subcaptions: boolean;
}

function sheetCaptions(plan: SheetPlan): SheetCaptions {
  if (plan.kind === 'animation') return { captions: plan.plan.times.map(sheetCaption.time), subcaptions: plan.events };
  if (plan.kind === 'overview') return { captions: plan.rows.flatMap((r) => r.values.map((v) => sheetCaption.overview(r.param, v))), subcaptions: false };
  const [sx, sy] = plan.sweeps;
  const captions = sy ? sy.values.flatMap((vy) => sx.values.map((vx) => sheetCaption.sweep(sx, vx, sy, vy))) : sx.values.map((vx) => sheetCaption.sweep(sx, vx));
  return { captions, subcaptions: false };
}

/**
 * composeSheet's layout as buildSheet uses it for cells `cellW` px wide: 8 px padding around/between
 * cells, the captions wrapped to the cell width (every cell reserves the most wrapped caption's lines;
 * a line for events when cells can list them) and a title bar. `extra` = the fixed (non-cell) pixels
 * per axis at that cell width.
 */
function sheetLayout(cells: number, columns: number, caps: SheetCaptions, cellW: number): { cols: number; rows: number; extraW: number; extraH: number } {
  // buildSheet always draws a title bar and captions; sheetSize is composeSheet's own arithmetic.
  const empty = sheetSize(cells, cellW, 0, { columns, title: 'title', captions: caps.captions, subcaptions: caps.subcaptions });
  return { cols: empty.columns, rows: empty.rows, extraW: empty.width - empty.columns * cellW, extraH: empty.height };
}

/**
 * Default cell scale, the autoScale policy applied to the whole sheet: 1, reduced so the sheet fits
 * MAX_IMAGE_SIDE; small sheets (e.g. of a zoomed viewBox) enlarged up to MAX_UPSCALE toward MIN_IMAGE_SIDE.
 * Captions wrap onto more lines in narrower cells, so a reduced scale is recomputed with the caption
 * area at that scale until it settles (it only shrinks; captions wrap onto at most a few lines).
 */
function sheetScale(vb: Rect, cells: number, columns: number, caps: SheetCaptions): number {
  const round = (s: number) => (s >= 0.1 ? Math.max(0.01, Math.floor(s * 1000) / 1000) : Math.max(1e-4, Number(s.toPrecision(3))));
  const at = (cellW: number) => {
    const { cols, rows, extraW, extraH } = sheetLayout(cells, columns, caps, cellW);
    const reach = (side: number) => Math.min((side - extraW) / (cols * vb[2]), (side - extraH) / (rows * vb[3]));
    return round(Math.min(Math.max(1, Math.min(MAX_UPSCALE, reach(MIN_IMAGE_SIDE))), reach(MAX_IMAGE_SIDE)));
  };
  let s = at(Math.max(1, Math.round(vb[2])));
  for (let i = 0; i < 10 && s < 1; i++) {
    const next = Math.min(s, at(Math.max(1, Math.round(vb[2] * s))));
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Reject sheets (and cells) beyond the size limits before rendering any cell. */
function checkSheetSize(vb: Rect, scale: number, cells: number, columns: number, caps: SheetCaptions): void {
  const cw = Math.round(vb[2] * scale);
  const ch = Math.round(vb[3] * scale);
  checkOutputSize('each sheet cell', cw, ch, MAX_RENDER_SIDE);
  const { cols, rows, extraW, extraH } = sheetLayout(cells, columns, caps, Math.max(1, cw));
  checkOutputSize(`the sheet (${cells} cells in ${cols} columns)`, cols * cw + extraW, rows * ch + extraH, MAX_SHEET_SIDE);
}

// ----------------------------------------------------------------------------- inspection

function pickIds(kind: string, wanted: string[] | undefined, all: string[]): Set<string> | null {
  if (!wanted) return null;
  requireKnownIds(kind, wanted, all);
  return new Set(wanted);
}

type Selection = { bones: Set<string> | null; warps: Set<string> | null; parts: Set<string> | null };

function filterInspect(r: InspectResult, sel: Selection): Partial<InspectResult> {
  if (!sel.bones && !sel.warps && !sel.parts) return r;
  const keep = (kind: string, ids: Set<string> | null) => (key: string) => {
    if (!ids || !key.startsWith(`${kind}:`)) return false;
    const id = key.slice(kind.length + 1).split('.')[0];
    return ids.has(id);
  };
  const tests = [keep('bone', sel.bones), keep('warp', sel.warps), keep('part', sel.parts)];
  const out: Partial<InspectResult> = { time: r.time, params: r.params };
  if (sel.bones) out.bones = r.bones.filter((b) => sel.bones!.has(b.id));
  if (sel.warps) out.warps = r.warps.filter((w) => sel.warps!.has(w.id));
  if (sel.parts) out.parts = r.parts.filter((p) => sel.parts!.has(p.id));
  out.drawOrder = r.drawOrder;
  out.properties = Object.fromEntries(Object.entries(r.properties).filter(([k]) => tests.some((t) => t(k))));
  out.events = r.events;
  // IK and physics diagnostics are small and always relevant to a check.
  if (r.ik.length) out.ik = r.ik;
  if (r.physics.length) out.physics = r.physics;
  if (r.points) out.points = r.points;
  return out;
}

/** Longest series rev2d_inspect returns as full poses (use `track` for longer ones). */
const MAX_SERIES_POSES = 120;

/** A track table as aligned text: one row per time. */
function formatTrack(t: TrackResult): string {
  const cell = (v: unknown) => (v === null ? '-' : Array.isArray(v) ? `[${v.map((x) => fmtNum(Number(x))).join(', ')}]` : typeof v === 'number' ? fmtNum(v) : String(v));
  const header = ['t', ...t.columns.map((c) => (t.fields[c] ? `${c} (${t.fields[c].join(', ')})` : c))];
  const rows = t.rows.map((r, i) => [fmtNum(t.times[i]), ...r.map(cell)]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

const pointField = z
  .array(
    z.union([
      z.string().min(1),
      z.strictObject({
        x: z.number(),
        y: z.number(),
        parent: z.string().min(1).nullable().optional().describe('Bone, warp or part id the point is attached to ("bone:id", "warp:id", "part:id" pick the kind; omit/null = model space).'),
      }),
    ]),
  )
  .max(64);

const timesField = z.array(z.number().min(0).max(MAX_TIME)).min(1);

// ----------------------------------------------------------------------------- registration

export function registerModelTools(server: McpServer, ctx: ToolContext): void {
  addTool(
    server,
    'rev2d_validate',
    {
      title: 'Validate a Rev2D model',
      description:
        'Validate a model file: JSON syntax, schema (unknown keys, types, ranges) and semantics (dangling ids, cycles, binding grids, address targets, geometry limits). ' +
        'Returns one line per diagnostic ("severity  /json/pointer  code  message  → hint") plus a JSON block {ok, errors, warnings, diagnostics:[{severity, code, message, path, hint}]}. ' +
        'isError is true when the model has errors. Run after every hand edit; fix errors in order (later ones are often consequences of earlier ones).',
      input: z.strictObject({ path: pathField }),
      effect: 'read-only',
    },
    async (a) => {
      const abs = resolvePath(ctx, a.path);
      const m = await loadModelFile(abs);
      if (m.diagnostics.some((d) => d.code === 'file-not-found')) throw fileNotFound(ctx, abs);
      const errors = m.diagnostics.filter((d) => d.severity === 'error').length;
      const warnings = m.diagnostics.filter((d) => d.severity === 'warning').length;
      const ok = errors === 0;
      const head = `${displayPath(ctx, abs)}: ${ok ? 'valid' : 'INVALID'}`;
      const body = m.diagnostics.length ? formatDiagnostics(m.diagnostics) : 'no diagnostics';
      const next = ok ? '\nnext: rev2d_render to look at it, rev2d_info for its structure' : '';
      return result(
        [text(`${head}\n${body}${next}`), json({ ok, file: abs, errors, warnings, diagnostics: m.diagnostics })],
        !ok,
      );
    },
  );

  addTool(
    server,
    'rev2d_info',
    {
      title: 'Describe a Rev2D model',
      description:
        'Structural summary of a model — read this first when working on an unfamiliar model: canvas size, parameters (range, default, what they drive and what drives them), ' +
        'the bone tree (local x, y, rotation, length and attached warps/parts), warps (grid, rect, children), parts (shape, parent/skin, z, masks), bindings (target <- params), IK, physics and animations. ' +
        'Returns a text outline plus the same data as JSON.',
      input: z.strictObject({ path: pathField }),
      effect: 'read-only',
    },
    async (a) => {
      const abs = resolvePath(ctx, a.path);
      const m = await loadModelFile(abs);
      if (m.diagnostics.some((d) => d.code === 'file-not-found')) throw fileNotFound(ctx, abs);
      if (!m.model) {
        throw new ToolError(`${displayPath(ctx, abs)} does not pass validation, so it cannot be summarized`, m.diagnostics);
      }
      const info = modelInfo(m.model);
      const warn = warningNote(m.diagnostics);
      const note = m.diagnostics.some((d) => d.severity === 'error')
        ? `\n\nNOTE: the model loads but cannot be rendered:\n${formatDiagnostics(m.diagnostics)}`
        : warn
          ? `\n\n${warn}`
          : '';
      return result([text(`${displayPath(ctx, abs)}\n${formatInfo(info)}${note}`), json(info)]);
    },
  );

  addTool(
    server,
    'rev2d_render',
    {
      title: 'Render a Rev2D model',
      description:
        'Render the model to a PNG (returned inline as an image) at a pose: time + animation layers + parameter overrides. Deterministic: same inputs, same pixels. ' +
        'Coordinates are setup space (canvas px, origin top-left, +x right, +y down; angles in degrees, clockwise-positive). ' +
        'Layers stack: ["idle", "talk@0.8,add"] (add = on top of idle), ["idle", "wink,once,start=2"] (one-shot from t=2 that stops at its end). ' +
        'Use overlay ["bones","labels"] to see the rig (only: ["upperArm"] to focus it), ["warps"] for lattices, ["grid"] to read coordinates, viewBox "fit" or [x,y,w,h] to zoom. ' +
        'Explicit params beat animation and physics. The text summary lists image size, viewBox, scale, non-default params, visible and hidden parts, IK reach, and notes on problems: ' +
        'IK targets out of reach or chains about to snap straight, physics outputs clamped to their parameter range, parts outside the view. ' +
        'Use rev2d_inspect for exact numbers instead of estimating from pixels.',
      input: z.strictObject({ path: pathField, ...frameShape, save_to: saveToField }),
      effect: 'additive',
    },
    async (a) => {
      const m = await loadModel(ctx, a.path);
      const { png, summary } = renderForAgent(m, toFrameInput(a));
      const lines = [`${displayPath(ctx, m.file)}: ${summary[0]}`, ...summary.slice(1)];
      const warn = warningNote(m.diagnostics);
      if (warn) lines.push(warn);
      if (a.save_to) lines.push(`saved: ${await saveFile(ctx, a.save_to, png)}`);
      return result([text(lines.join('\n')), image(png)]);
    },
  );

  addTool(
    server,
    'rev2d_sheet',
    {
      title: 'Render a contact sheet',
      description:
        'Verify motion in ONE image: a captioned grid of renders. One of: ' +
        '`animation` = frames over time (default 8 over the whole animation; frames/fps, a window from/to in seconds, or explicit times; warmup = seconds of physics pre-roll for looping animations, whole cycles; cells list the events that fall into them); ' +
        '`sweeps` = parameter sweeps "Param" (5 values over its range), "Param=min:max:steps", "Param=v1,v2" or linked "EyeLOpen,EyeROpen=0:1:5" (same values for both) — one sweep = one row, two = grid (first across columns, second down rows); ' +
        '`overview` = one row per parameter over its range ({params?, steps?}; true = all parameters): the whole control surface at a glance. ' +
        'All cells share one viewBox (viewBox "fit" = union of all cells), so movement between cells is real movement. ' +
        'Default scale keeps the sheet within about 1024 px (small sheets are enlarged up to 4x); pass scale to override. params and animations (extra layers, e.g. "talk@0.8,add") apply to every cell; time applies to sweep/overview cells only. ' +
        'The summary adds notes: IK out of reach or snapping, physics clamping, values outside a parameter range.',
      input: z.strictObject({
        path: pathField,
        animation: z.string().min(1).optional().describe('Animation id for a time contact sheet (animations = extra layers on top of it).'),
        frames: z.number().int().min(1).max(64).optional().describe(`Number of frames for \`animation\` (default ${SHEET_DEFAULT_FRAMES} unless fps or times is given).`),
        fps: z.number().positive().optional().describe('Sample `animation` at this frame rate instead of a fixed frame count.'),
        from: z.number().min(0).max(MAX_TIME).optional().describe('Window start in animation seconds (default 0).'),
        to: z.number().positive().max(MAX_TIME).optional().describe('Window end in animation seconds (default: the duration; later values wrap for loops, hold otherwise).'),
        times: timesField.max(64).optional().describe('Explicit animation times in seconds (replaces frames/fps/from/to), e.g. [0, 0.12, 0.25].'),
        warmup: z.number().min(0).max(MAX_TIME).optional().describe('Looping animations: seconds of pre-roll before the window (rounded up to whole cycles) so physics is in its steady state.'),
        sweeps: z
          .array(z.string().min(1))
          .min(1)
          .max(2)
          .optional()
          .describe('Parameter sweeps, e.g. ["AngleX=-30:30:5"], ["AngleX=-30,0,30", "AngleY=-30,0,30"] or linked ["EyeLOpen,EyeROpen=0:1:5"].'),
        overview: z
          .union([
            z.literal(true),
            z.strictObject({
              params: z.array(z.string()).min(1).optional().describe('Parameters, one row each (default: all).'),
              steps: z.number().int().min(1).max(16).optional().describe('Values per row over the range (default 5).'),
            }),
          ])
          .optional()
          .describe('Parameter overview: one row per parameter over its range (true = all parameters, 5 steps).'),
        columns: z.number().int().min(1).max(64).optional().describe('Cells per row (default: sweep length / overview steps, or a square-ish grid for animations).'),
        title: z.string().optional().describe('Title bar text (default: model name and what is shown).'),
        ...frameShape,
        save_to: saveToField,
      }),
      effect: 'additive',
    },
    async (a) => {
      const m = await loadModel(ctx, a.path);
      const input = toFrameInput(a);
      requirePoseIds(m.model, input);
      const plan = planSheet(m, a);
      const n = cellCount(plan);
      const caps = sheetCaptions(plan);
      const viewBox: Rect = input.viewBox === 'fit' ? sheetFitViewBox(m, input, plan) : (input.viewBox ?? [0, 0, m.model.meta.width, m.model.meta.height]);
      const columns = a.columns ?? (plan.kind === 'animation' ? Math.ceil(Math.sqrt(n)) : plan.kind === 'overview' ? plan.steps : plan.sweeps[0].values.length);
      const scale = input.scale ?? sheetScale(viewBox, n, columns, caps);
      checkSheetSize(viewBox, scale, n, columns, caps);
      const sheet = buildSheet(m, {
        ...input,
        viewBox,
        scale,
        columns,
        title: a.title,
        ...(plan.kind === 'animation'
          ? { animation: plan.animation, frames: a.frames, fps: a.fps, from: a.from, to: a.to, times: a.times, warmup: a.warmup }
          : plan.kind === 'overview'
            ? { overview: { params: plan.rows.map((r) => r.param), steps: plan.steps } }
            : { sweeps: plan.sweeps }),
      });
      // Event lists that wrap onto a second line are the one part of the size not known in advance.
      checkOutputSize(`the sheet (${n} cells in ${Math.min(columns, n)} columns)`, sheet.image.width, sheet.image.height, MAX_SHEET_SIDE);
      const png = encodePNG(sheet.image);
      const values = (s: Sweep) => `${sweepLabel(s)} = ${s.values.map(fmtNum).join(', ')}`;
      const what: string[] = [];
      if (plan.kind === 'animation') {
        const layers = sheet.layers?.length ? ` + ${sheet.layers.join(' + ')}` : '';
        const warm = plan.plan.offset ? ` (after ${fmtNum(plan.plan.offset)} s warm-up)` : '';
        what.push(`cells: animation "${plan.animation}"${layers} at t = ${plan.plan.times.map(fmtNum).join(', ')} s${warm}`);
        if (sheet.events?.length) what.push(`events: ${listPreview(sheet.events.map((e) => `${e.animation}:${e.name}@${fmtNum(e.t)}s (cell ${e.cell + 1})`), 20)}`);
      } else if (plan.kind === 'overview') {
        what.push(`rows: ${plan.rows.map((r) => `${r.param} ${fmtNum(r.values[0])}..${fmtNum(r.values[r.values.length - 1])}`).join(' | ')} (${plan.steps} steps each)`);
      } else {
        what.push(`columns: ${values(plan.sweeps[0])}`, ...(plan.sweeps[1] ? [`rows: ${values(plan.sweeps[1])}`] : []));
      }
      const lines = [
        `${displayPath(ctx, m.file)}: ${sheet.image.width}x${sheet.image.height} px sheet, ${n} cells in ${Math.min(columns, n)} columns`,
        ...what,
        `each cell: viewBox [${viewBox.map(fmtNum).join(', ')}] (model px) at scale ${fmtScale(scale)}`,
        ...sheet.notes.map((note) => `note: ${mcpText(note)}`),
      ];
      const warn = warningNote(m.diagnostics);
      if (warn) lines.push(warn);
      if (a.save_to) lines.push(`saved: ${await saveFile(ctx, a.save_to, png)}`);
      return result([text(lines.join('\n')), image(png)]);
    },
  );

  addTool(
    server,
    'rev2d_inspect',
    {
      title: 'Inspect a pose numerically',
      description:
        'Exact evaluated numbers (check geometry without looking at pixels). One pose -> JSON with: params (final values after animations/physics/clamping); ' +
        'bones [{id, parent, x, y (world joint), rotation (world, degrees clockwise), scaleX, scaleY, tip [x,y] (world bone end), local {x, y, rotation, scaleX, scaleY}}]; ' +
        'warps [{id, cols, rows, points [[x,y]...] world control points, row-major}]; parts [{id, visible, opacity, z, bounds [x,y,w,h], center [x,y]}] (world = setup-space px); ' +
        'drawOrder; properties (final value of every bound/animated address); events; ik [{id, reached, extension (distance/max reach: >= 1 out of reach, > 0.98 snap risk), error px, bend}]; ' +
        'physics [{id, outputs [{param, raw (before clamping), value, clamped, overridden}]}]. ' +
        'points ["120,80@head"] = where setup-space points attached to a bone, warp or part end up (e.g. a hat on a turning head; a skinned part blends its bones; "bone:id"/"warp:id"/"part:id" pick the kind). ' +
        'bones/warps/parts id lists return only those sections and ids. ' +
        'Over time: times [..] (or frames n over the first animation) -> {times, results} (ascending times play like a game loop: incremental physics, crossed events); ' +
        'with track columns -> a compact table instead, one row per time, e.g. track "param:AngleX,bone:head,part:mouth.center,ik:armIk,physics:hair.HairSway,point:120,80@head".',
      input: z.strictObject({
        path: pathField,
        ...poseShape,
        bones: z.array(z.string()).optional().describe('Only these bone ids.'),
        warps: z.array(z.string()).optional().describe('Only these warp ids.'),
        parts: z.array(z.string()).optional().describe('Only these part ids.'),
        points: pointField
          .optional()
          .describe('Setup-space points to map through the pose: "x,y" (model space) or "x,y@parent" (attached to that bone, warp or part: a skinned part blends its skin bones like its own vertices, another part maps like its parent; prefix "bone:", "warp:" or "part:" when ids are shared), or {x, y, parent}. Result: points [{spec, parent, setup, posed}].'),
        times: timesField.max(2000).optional().describe('Global times in seconds for a series (instead of `time`).'),
        frames: z.number().int().min(1).max(2000).optional().describe('Series of this many frames over the first animation layer (instead of times).'),
        track: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .optional()
          .describe(`Track columns for a compact time table (needs times or frames): ${TRACK_COLUMN_FORMS}.`),
      }),
      effect: 'read-only',
    },
    async (a) => {
      const m = await loadModel(ctx, a.path);
      const sel: Selection = {
        bones: pickIds('bone', a.bones, m.model.bones.map((b) => b.id)),
        warps: pickIds('warp', a.warps, m.model.warps.map((w) => w.id)),
        parts: pickIds('part', a.parts, m.model.parts.map((p) => p.id)),
      };
      requirePoseIds(m.model, a);
      const series = a.times !== undefined || a.frames !== undefined;
      const conventions = 'World coordinates in setup-space px (+y down), rotations in degrees clockwise.';
      if (a.track !== undefined) {
        if (!series) throw new ToolError('track needs times or frames (one table row per time)', [], 'e.g. times [0, 0.5, 1] or frames 8 with animations ["idle"]');
        const t = trackSeries(m, { ...toPoseInput(a), times: a.times, frames: a.frames, columns: a.track, points: a.points });
        const head = `${displayPath(ctx, m.file)}: ${t.rows.length} times x ${t.columns.length} columns. ${conventions}`;
        return result([text(`${head}\n${formatTrack(t)}`), json(t)]);
      }
      if (series) {
        const s = inspectSeries(m, { ...toPoseInput(a), times: a.times, frames: a.frames, points: a.points });
        if (s.times.length > MAX_SERIES_POSES) {
          throw new ToolError(
            `${s.times.length} full poses is too much output (max ${MAX_SERIES_POSES})`,
            [],
            'pass track columns for a compact table (e.g. track "param:AngleX,bone:head"), or fewer times',
          );
        }
        const head = `${displayPath(ctx, m.file)}: ${s.times.length} poses at t = ${listPreview(s.times.map(fmtNum), 20)} s${sel.bones || sel.warps || sel.parts ? '' : ' (tip: bones/parts/warps filters or track columns keep this short)'}. ${conventions}`;
        return result([text(head), json({ times: s.times, results: s.results.map((r) => filterInspect(r, sel)) })]);
      }
      const r = inspectPose(m, { ...toPoseInput(a), points: a.points });
      const lines = [`${displayPath(ctx, m.file)} at t=${fmtNum(r.time)}s, params: ${paramSummary(m.model, r.params)}. ${conventions}`];
      for (const p of r.points ?? []) lines.push(`point ${p.spec}: setup [${p.setup.map(fmtNum).join(', ')}] -> posed [${p.posed.map(fmtNum).join(', ')}]`);
      return result([text(lines.join('\n')), json(filterInspect(r, sel))]);
    },
  );

  addTool(
    server,
    'rev2d_analyze',
    {
      title: 'Analyze an animation',
      description:
        'Find animation problems without watching it: samples the animation densely (default 60 fps, the physics rate) with incremental physics and reports ' +
        'parameter ranges actually used (and which hit their limits), physics outputs clamped to their parameter range (peak raw value and when), ' +
        'IK chains out of reach or nearly straight (knee/elbow snapping; max extension and when), events with the frame they fall in, ' +
        'the loop seam of looping animations (parameters/bones that jump from the last frame back to t=0, and the pixel difference one loop later), ' +
        'the union of the visible bounds and parts that leave the canvas, plus actionable notes. ' +
        'Physics starts at rest at t=0: pass warmup (seconds, rounded up to whole cycles) to analyze the steady state of a looping animation. ' +
        'animations = extra layers on top (e.g. ["talk@0.8,add"]); params and physics as in rev2d_render. Returns a text report and the JSON result. ' +
        'Typical loop: rev2d_analyze -> fix keys/ranges with rev2d_apply_ops -> rev2d_analyze again -> rev2d_sheet to look.',
      input: z.strictObject({
        path: pathField,
        animation: z.string().min(1).describe('Animation id to analyze.'),
        animations: poseShape.animations,
        params: poseShape.params,
        physics: poseShape.physics,
        fps: z.number().positive().max(240).optional().describe('Samples per second of animation time (default 60).'),
        frames: z.number().int().min(1).max(2000).optional().describe('Exact number of samples over the window (instead of fps).'),
        from: z.number().min(0).max(MAX_TIME).optional().describe('Window start in animation seconds (default 0).'),
        to: z.number().positive().max(MAX_TIME).optional().describe('Window end in animation seconds (default: the duration).'),
        times: timesField.max(2000).optional().describe('Explicit sample times in animation seconds (replaces fps/frames/from/to).'),
        warmup: z.number().min(0).max(MAX_TIME).optional().describe('Looping animations: seconds of physics pre-roll before the window (whole cycles).'),
        pixels: z.boolean().optional().describe('Compare the rendered first frame with the frame one loop later (default true; false is faster).'),
      }),
      effect: 'read-only',
    },
    async (a) => {
      const m = await loadModel(ctx, a.path);
      requireKnownIds('animation', [a.animation], m.model.animations.map((x) => x.id));
      requirePoseIds(m.model, a);
      const r = analyzeAnimation(m, {
        animation: a.animation,
        animations: a.animations,
        params: a.params,
        physics: a.physics,
        fps: a.fps,
        frames: a.frames,
        from: a.from,
        to: a.to,
        times: a.times,
        warmup: a.warmup,
        pixels: a.pixels,
      });
      const report = { ...r, notes: r.notes.map(mcpText) };
      return result([text(`${displayPath(ctx, m.file)}: ${mcpText(formatAnalysis(r))}`), json(report)]);
    },
  );

  addTool(
    server,
    'rev2d_hit_test',
    {
      title: 'Which parts cover a point',
      description:
        'List the parts whose deformed geometry covers the setup-space point (x, y) at a pose, top-most first, with whether the fill or the stroke is hit. ' +
        'Ignores masks and texture transparency. When nothing is hit, the nearest parts (by bounds) are listed. Useful to map a spot in a render back to a part id.',
      input: z.strictObject({
        path: pathField,
        x: z.number().describe('Setup-space x (px from the left edge of the canvas).'),
        y: z.number().describe('Setup-space y (px from the top edge; +y is down).'),
        ...poseShape,
      }),
      effect: 'read-only',
    },
    async (a) => {
      const m = await loadModel(ctx, a.path);
      requirePoseIds(m.model, a);
      const hits = hitTest(m, { ...toPoseInput(a), x: a.x, y: a.y });
      const at = `(${fmtNum(a.x)}, ${fmtNum(a.y)})`;
      if (hits.length) {
        return result([
          text(`${at}: ${hits.map((h) => `${h.partId} (${h.kind})`).join(', ')} — top-most first`),
          json({ x: a.x, y: a.y, hits }),
        ]);
      }
      const r = inspectPose(m, toPoseInput(a));
      const nearest = r.parts
        .filter((p) => p.bounds && p.visible)
        .map((p) => ({ partId: p.id, distance: Math.round(rectDistance(p.bounds!, a.x, a.y) * 10) / 10, bounds: p.bounds! }))
        .sort((p, q) => p.distance - q.distance || p.partId.localeCompare(q.partId))
        .slice(0, 3);
      const near = nearest.length ? `; nearest: ${nearest.map((n) => `${n.partId} (${n.distance} px, bounds [${n.bounds.join(', ')}])`).join(', ')}` : '';
      return result([text(`${at}: no part covers this point${near}`), json({ x: a.x, y: a.y, hits, nearest })]);
    },
  );
}

/** Distance from (x, y) to an [x, y, w, h] rectangle (0 inside). */
function rectDistance(b: Rect, x: number, y: number): number {
  const dx = Math.max(b[0] - x, 0, x - (b[0] + b[2]));
  const dy = Math.max(b[1] - y, 0, y - (b[1] + b[3]));
  return Math.hypot(dx, dy);
}
