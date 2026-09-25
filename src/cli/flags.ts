/**
 * Flag groups shared by several commands (pose, frame, sampling, output) and their conversion into
 * the src/api inputs. Ids are checked against the model here so typos get a did-you-mean hint, and
 * api validation errors become usage errors (exit 2).
 */
import type { Model } from '../core/types.js';
import { suggest } from '../core/address.js';
import { parseColor } from '../core/color.js';
import {
  ApiError,
  checkOnlyIds,
  LAYER_SYNTAX,
  OVERLAY_LAYERS,
  parseLayerSpec,
  parseTimeSpec,
  type FrameInput,
  type PoseInput,
  type SampleInput,
} from '../api/index.js';
import type { OverlayLayer } from '../render/index.js';
import { UsageError, type Args, type FlagSpec } from './args.js';
import { num } from './text.js';

export const TIME_FLAG: FlagSpec = { name: 'time', type: 'number', min: 0, arg: 'seconds', description: 'time in seconds (>= 0) for animations and physics (default 0)' };

export const POSE_FLAGS: FlagSpec[] = [
  TIME_FLAG,
  {
    name: 'anim',
    type: 'string',
    repeat: true,
    arg: 'id[@weight][,opts]',
    description: `play an animation layer (repeatable; later layers win): ${LAYER_SYNTAX}`,
  },
  { name: 'param', type: 'string', repeat: true, arg: 'id=value', description: 'set a parameter, e.g. --param AngleX=30 (repeatable, or comma-separated A=1,B=2); explicit values beat animations and physics' },
  { name: 'physics', type: 'boolean', description: 'simulate physics (default on; from rest over at most the 60 s before --time); --no-physics disables' },
];

/**
 * Pose flags of commands that sample an animation over time (gif, frames, analyze): no --time in help.
 * --time is still parsed (hidden) so it can be rejected with a message that names --from/--to.
 */
export const SEQUENCE_POSE_FLAGS: FlagSpec[] = [
  {
    ...POSE_FLAGS[1],
    description: `the first --anim is the animation sampled over time; more --anim flags add layers on top: ${LAYER_SYNTAX}`,
  },
  POSE_FLAGS[2],
  { ...POSE_FLAGS[3], description: 'simulate physics (default on, incrementally frame to frame); --no-physics disables' },
  { ...TIME_FLAG, hidden: true },
];

export const FRAME_FLAGS: FlagSpec[] = [
  { name: 'overlay', type: 'string', repeat: true, arg: 'list|all', description: `debug overlay layers: ${OVERLAY_LAYERS.join(',')} or all` },
  { name: 'only', type: 'string', repeat: true, arg: 'ids', description: 'overlay focus: only these bone/warp/part ids in the bones, warps, mesh, bounds and labels layers (comma list)' },
  { name: 'only-chain', type: 'boolean', description: 'with --only: also draw the ancestor bones of the listed bones' },
  { name: 'scale', type: 'number', greaterThan: 0, arg: 'n', description: 'output pixels per model pixel (default 1)' },
  { name: 'viewbox', type: 'string', arg: 'x,y,w,h|fit', description: 'region to render in model space; fit = bounds of visible parts + padding (default: canvas)' },
  { name: 'padding', type: 'number', min: 0, arg: 'px', description: 'padding around --viewbox fit, in model px (default 16)' },
  { name: 'bg', type: 'string', arg: 'color', description: 'background color override, e.g. "#ffffff" or transparent' },
  { name: 'ss', type: 'int', min: 1, max: 4, arg: 'n', description: 'supersampling per axis, 1..4 (default 2)' },
];

/** How an animation is sampled over time (sheet --anim, gif, frames). */
export const SAMPLE_FLAGS: FlagSpec[] = [
  { name: 'fps', type: 'number', greaterThan: 0, arg: 'n', description: 'frames per second of animation time (default meta.fps)' },
  { name: 'frames', type: 'int', min: 1, arg: 'n', description: 'exact frame count spread over the window (overrides --fps for sampling)' },
  { name: 'from', type: 'number', min: 0, arg: 'seconds', description: 'window start in animation seconds (default 0)' },
  { name: 'to', type: 'number', min: 0, arg: 'seconds', description: 'window end (default: the duration; beyond it loops wrap, others hold)' },
  { name: 'times', type: 'string', arg: 'a:b:n|t1,t2,...', description: 'explicit sample times instead of --frames/--fps/--from/--to: n evenly spaced from a to b, or a list' },
  { name: 'warmup', type: 'number', min: 0, arg: 'seconds', description: 'looping animations: run whole cycles for at least this long first, so physics is in its steady state' },
];

export const JSON_FLAG: FlagSpec = { name: 'json', type: 'boolean', description: 'print machine-readable JSON to stdout' };

export function outFlag(arg: string, description: string): FlagSpec {
  return { name: 'out', short: 'o', type: 'string', arg, description };
}

/** Did-you-mean hint for an id, falling back to the list of valid ids. */
export function idHint(got: string, options: string[], kind: string): string {
  return suggest(got, options) ?? (options.length ? `available ${kind}: ${options.join(', ')}` : `the model has no ${kind}`);
}

/** Run an api parser and turn its ApiError into a usage error (exit 2), keeping the hint. */
export function usage<T>(fn: () => T, prefix = ''): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ApiError) throw new UsageError(`${prefix}${e.message}`, e.hint);
    throw e;
  }
}

export function requireOut(args: Args, example: string): string {
  const out = args.str('out');
  if (!out) throw new UsageError('missing output file: pass -o <file>', `e.g. ${example}`);
  return out;
}

/**
 * Notes for requested parameter values outside their range: evaluation clamps them (SPEC §9), so
 * e.g. AngleX=45 on a [-30, 30] parameter silently renders like AngleX=30.
 */
export function clampNotes(values: Record<string, number>, model: Model, source: string): string[] {
  const notes: string[] = [];
  for (const [id, v] of Object.entries(values)) {
    const p = model.parameters.find((q) => q.id === id);
    if (!p || (v >= p.min && v <= p.max)) continue;
    notes.push(`${source} ${id}=${num(v)} is outside its range [${num(p.min)}..${num(p.max)}] and is clamped to ${num(Math.min(p.max, Math.max(p.min, v)))}`);
  }
  return notes;
}

/** Parse "A=1", "A=1,B=2" occurrences into a record, validating ids against the model. */
export function parseParamAssignments(values: string[], model: Model, flag = '--param'): Record<string, number> {
  const ids = model.parameters.map((p) => p.id);
  const params: Record<string, number> = {};
  for (const item of values.flatMap((v) => v.split(','))) {
    const s = item.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) throw new UsageError(`${flag} expects id=value, got "${s}"`, `e.g. ${flag} ${ids[0] ?? 'AngleX'}=0.5`);
    const id = s.slice(0, eq).trim();
    const raw = s.slice(eq + 1).trim();
    const value = raw === '' ? NaN : Number(raw);
    if (!ids.includes(id)) throw new UsageError(`unknown parameter "${id}" in ${flag}`, idHint(id, ids, 'parameters'));
    if (!Number.isFinite(value)) throw new UsageError(`${flag} ${id} needs a number, got "${raw}"`);
    params[id] = value;
  }
  return params;
}

/** Validate --anim layer specs ("id", "id@weight", "id@weight,add,once,start=2,time=1") against the model. */
export function checkAnimations(specs: string[], model: Model): string[] {
  for (const spec of specs) usage(() => parseLayerSpec(model, spec), '--anim: ');
  return specs;
}

/** Pose flags as a PoseInput. Values that will be clamped are reported in `notes`. */
export function poseInput(args: Args, model: Model, notes: string[] = []): PoseInput {
  const input: PoseInput = {};
  const time = args.num('time');
  if (time !== undefined) input.time = time;
  const anims = checkAnimations(args.list('anim'), model);
  if (anims.length) input.animations = anims;
  const params = parseParamAssignments(args.list('param'), model);
  if (Object.keys(params).length) input.params = params;
  notes.push(...clampNotes(params, model, '--param'));
  if (args.bool('physics') === false) input.physics = false;
  return input;
}

/** The first pose or frame flag given, if any (for commands where they only apply in some modes). */
export function firstPoseOrFrameFlag(args: Args): string | null {
  const flag = [...POSE_FLAGS, ...FRAME_FLAGS].find((f) => args.has(f.name));
  if (!flag) return null;
  return flag.type === 'boolean' && args.bool(flag.name) === false ? `--no-${flag.name}` : `--${flag.name}`;
}

export function parseOverlay(values: string[]): OverlayLayer[] {
  const layers: OverlayLayer[] = [];
  for (const v of values) {
    if (v === 'all') {
      layers.push(...OVERLAY_LAYERS);
      continue;
    }
    if (v === 'none') continue;
    if (!(OVERLAY_LAYERS as string[]).includes(v)) {
      throw new UsageError(`unknown overlay layer "${v}"`, suggest(v, [...OVERLAY_LAYERS, 'all', 'none']) ?? `layers: ${OVERLAY_LAYERS.join(', ')}, all, none`);
    }
    layers.push(v as OverlayLayer);
  }
  return [...new Set(layers)];
}

export function parseViewBox(raw: string, flag = '--viewbox'): [number, number, number, number] | 'fit' {
  if (raw.trim() === 'fit') return 'fit';
  const parts = raw.split(',').map((s) => (s.trim() === '' ? NaN : Number(s)));
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    throw new UsageError(`${flag} expects "x,y,w,h" or "fit", got "${raw}"`, `e.g. ${flag} 0,0,512,512`);
  }
  if (!(parts[2] > 0 && parts[3] > 0)) throw new UsageError(`${flag} width and height must be positive, got "${raw}"`);
  return parts as [number, number, number, number];
}

export function checkColor(raw: string, flag: string): string {
  if (!parseColor(raw)) throw new UsageError(`${flag} "${raw}" is not a color`, 'use #rgb, #rrggbb, #rrggbbaa, rgb()/rgba() or a CSS color name');
  return raw;
}

/** Pose and frame flags as a FrameInput. Values that will be clamped are reported in `notes`. */
export function frameInput(args: Args, model: Model, notes: string[] = []): FrameInput {
  const input: FrameInput = poseInput(args, model, notes);
  const overlay = parseOverlay(args.csv('overlay'));
  if (overlay.length) input.overlay = overlay;
  const only = args.csv('only');
  if (only.length) {
    usage(() => checkOnlyIds(model, only), '--only: ');
    if (!overlay.length) throw new UsageError('--only filters the overlay, but no --overlay is given', 'add e.g. --overlay bones,labels');
    input.only = only;
  }
  if (args.bool('only-chain') === true) {
    if (!only.length) throw new UsageError('--only-chain applies together with --only <ids>', 'e.g. --only foreArm --only-chain');
    input.onlyChain = true;
  }
  const scale = args.num('scale');
  if (scale !== undefined) input.scale = scale;
  const vb = args.str('viewbox');
  if (vb !== undefined) input.viewBox = parseViewBox(vb);
  const padding = args.num('padding');
  if (padding !== undefined) {
    if (input.viewBox !== 'fit') throw new UsageError('--padding only applies to --viewbox fit');
    input.padding = padding;
  }
  const bg = args.str('bg');
  if (bg !== undefined) input.background = checkColor(bg, '--bg');
  const ss = args.num('ss');
  if (ss !== undefined) input.supersample = ss;
  return input;
}

/** Parse --times ("a:b:n" or "t1,t2,..."). */
export function parseTimesFlag(raw: string, flag = '--times'): number[] {
  return usage(() => parseTimeSpec(raw, flag));
}

/** The sampling flags (SAMPLE_FLAGS) as the window part of a SampleInput. */
export function sampleInput(args: Args): Omit<SampleInput, 'animation'> {
  const out: Omit<SampleInput, 'animation'> = {};
  const times = args.str('times');
  if (times !== undefined) {
    const extra = ['frames', 'fps', 'from', 'to'].filter((f) => args.has(f));
    if (extra.length) throw new UsageError(`--times lists the sample times itself; drop ${extra.map((f) => `--${f}`).join(', ')}`, 'use either --times, or --frames/--fps with --from/--to');
    out.times = parseTimesFlag(times);
  }
  for (const key of ['frames', 'fps', 'from', 'to', 'warmup'] as const) {
    const v = args.num(key);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** The first --anim of a sampling command: plain "id" (or "id@weight" when `allowWeight`), no clock options. */
export function sampledAnimation(spec: string, model: Model, allowWeight: boolean): string {
  const layer = usage(() => parseLayerSpec(model, spec), '--anim: ');
  if (layer.start !== undefined || layer.time !== undefined) {
    throw new UsageError(`the first --anim is sampled over time, so it cannot have its own clock ("${spec}")`, `use --anim ${layer.id} and choose the window with --from/--to (or --times); start=/time= apply to the extra --anim layers`);
  }
  if (!allowWeight && (layer.weight !== undefined || layer.mode !== undefined || layer.hold !== undefined)) {
    throw new UsageError(`the sampled animation plays at full weight here; use --anim ${layer.id}`, 'weights and options apply to the extra --anim layers');
  }
  return layer.id;
}
