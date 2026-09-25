/**
 * Animation layer syntax shared by the CLI (--anim), the MCP server and the editor bridge:
 *
 *   "idle"                 full weight, default options
 *   "blink@0.5"            weight 0..1
 *   "talk@0.8,add"         comma options after the id/weight:
 *                            add | override   how `param:` tracks combine with the layers below
 *                            once | hold      outside the layer's window: contribute nothing / hold the first or last key
 *                                             (window: [start, start + duration], or [start, forever) for a loop)
 *                            start=<s>        global time at which the layer starts (local time = time - start); a
 *                                             looping layer without "once" also plays before it (phase-shifted)
 *                            time=<s>         fixed layer-local time (ignores the global clock)
 *
 * Objects ({id, weight, time, mode, start, hold}) are accepted wherever strings are.
 */
import type { AnimationLayer, Model } from '../core/types.js';
import { suggest } from '../core/address.js';
import { ApiError, fmtNum, idHint, show } from './errors.js';

/** Object form of a layer (JSON inputs). */
export interface LayerInput {
  id: string;
  time?: number;
  weight?: number;
  mode?: 'override' | 'add';
  start?: number;
  hold?: boolean;
}

/** One-line description of the layer syntax for help texts, docs and tool descriptions. */
export const LAYER_SYNTAX =
  '"id" or "id@weight" (weight 0..1), plus comma options: add | override (param tracks add on top of the layers below instead of replacing them), start=<s> (global time the layer starts; a looping layer also plays before it, phase-shifted, unless once), once (the layer contributes nothing before its start and, if it does not loop, after its end, instead of holding its first/last key), time=<s> (fixed layer time); e.g. "talk@0.8,add", "wink,once,start=2.5", "talk,add,once,start=1"';

const OPTION_NAMES = ['add', 'override', 'once', 'hold', 'start', 'time'];
const OPTION_FORMS = 'options: add, override, once, hold, start=<seconds>, time=<seconds>';
const LAYER_FORMS = `use ${LAYER_SYNTAX}, or an object {"id": "idle", "weight": 0.5, "mode": "add", "start": 1, "hold": false, "time": 1}`;
const OBJECT_KEYS = ['id', 'time', 'weight', 'mode', 'start', 'hold'];

/**
 * Parse one layer string ("id", "id@weight", "id@weight,opt,...") and check it against the model.
 * Every mistake is an ApiError naming the offending piece, with a hint (did-you-mean, accepted forms).
 */
export function parseLayerSpec(model: Model, spec: string): AnimationLayer {
  const { layer, weightText } = parseLayerText(spec, model);
  return checkLayer(model, layer, spec, weightText);
}

/**
 * The syntax half of parseLayerSpec: the fields a layer string spells out, without checking them
 * against a model (unknown ids and weights outside 0..1 pass; parseLayerSpec checks those).
 */
export function parseLayerSyntax(spec: string): AnimationLayer {
  return parseLayerText(spec, null).layer;
}

/** Whether a comma-separated piece is a layer option (add, once, start=1, ...) rather than an animation id. */
export function isLayerOption(piece: string): boolean {
  return OPTION_NAMES.includes(piece.split('=')[0].trim());
}

/**
 * Split a comma list of layers ("idle,talk@0.8,add,wink,once,start=2") into layer strings: pieces
 * that are layer options attach to the layer before them (["idle", "talk@0.8,add", "wink,once,start=2"]).
 */
export function splitLayerList(list: string): string[] {
  const out: string[] = [];
  for (const piece of list.split(',')) {
    if (out.length && isLayerOption(piece)) out[out.length - 1] += `,${piece.trim()}`;
    else out.push(piece.trim());
  }
  return out;
}

function parseLayerText(spec: string, model: Model | null): { layer: AnimationLayer; weightText: string | undefined } {
  if (typeof spec !== 'string') throw new ApiError(`bad animation layer ${show(spec)}`, [], LAYER_FORMS);
  const [head, ...options] = spec.split(',').map((s) => s.trim());
  const at = head.lastIndexOf('@');
  const id = (at >= 0 ? head.slice(0, at) : head).trim();
  if (!id) {
    const first = model?.animations[0]?.id ?? 'idle';
    throw new ApiError(`animation layer "${spec}" names no animation`, [], `start with an animation id, e.g. "${first}" or "${first}@0.5"`);
  }
  const layer: AnimationLayer = { id };
  let weightText: string | undefined;
  if (at >= 0) {
    weightText = head.slice(at + 1);
    // Number('') is 0: an empty weight is a typo, not "off".
    layer.weight = weightText.trim() === '' ? NaN : Number(weightText);
  }
  const seen = new Set<string>();
  for (const raw of options) {
    if (raw === '') throw new ApiError(`empty option in animation layer "${spec}" (two commas in a row, or a trailing comma)`, [], OPTION_FORMS);
    const eq = raw.indexOf('=');
    const name = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    const value = eq < 0 ? undefined : raw.slice(eq + 1).trim();
    if (!OPTION_NAMES.includes(name)) {
      const mean = suggest(name, OPTION_NAMES);
      throw new ApiError(`unknown option "${raw}" in animation layer "${spec}"`, [], mean ? `${mean} (${OPTION_FORMS})` : OPTION_FORMS);
    }
    const group = name === 'add' || name === 'override' ? 'mode' : name === 'once' || name === 'hold' ? 'hold' : name;
    if (seen.has(group)) {
      const what = group === 'mode' ? '"add"/"override"' : group === 'hold' ? '"once"/"hold"' : `"${name}"`;
      throw new ApiError(`animation layer "${spec}" gives ${what} more than once`, [], 'give each option at most once');
    }
    seen.add(group);
    if (name === 'start' || name === 'time') {
      const v = value === undefined || value === '' ? NaN : Number(value);
      if (!Number.isFinite(v)) {
        throw new ApiError(`option "${raw}" in animation layer "${spec}" needs a number of seconds`, [], `e.g. "${id},${name}=1.5"`);
      }
      layer[name] = v;
      continue;
    }
    if (value !== undefined) throw new ApiError(`option "${name}" in animation layer "${spec}" takes no value`, [], `write ",${name}" (${OPTION_FORMS})`);
    if (name === 'add' || name === 'override') layer.mode = name;
    else layer.hold = name === 'hold';
  }
  return { layer, weightText };
}

/** One layer of a PoseInput: a layer string or an object, checked against the model. */
export function toLayer(model: Model, entry: unknown): AnimationLayer {
  if (typeof entry === 'string') return parseLayerSpec(model, entry);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as { id?: unknown }).id !== 'string') {
    throw new ApiError(`bad animation layer ${show(entry)}`, [], LAYER_FORMS);
  }
  const obj = entry as Record<string, unknown>;
  const id = obj.id as string;
  for (const key of Object.keys(obj)) {
    if (!OBJECT_KEYS.includes(key)) {
      throw new ApiError(`animation layer "${id}": unknown field "${key}"`, [], suggest(key, OBJECT_KEYS) ?? `fields: ${OBJECT_KEYS.join(', ')}`);
    }
  }
  for (const key of ['time', 'weight', 'start'] as const) {
    const v = obj[key];
    if (v !== undefined && typeof v !== 'number') throw new ApiError(`animation layer "${id}": ${key} must be a number, got ${show(v)}`, [], LAYER_FORMS);
  }
  if (obj.mode !== undefined && obj.mode !== 'add' && obj.mode !== 'override') {
    throw new ApiError(`animation layer "${id}": mode must be "override" or "add", got ${show(obj.mode)}`, [], 'add = param tracks add (value - default) on top of the layers below; override (default) = blend toward the track value');
  }
  if (obj.hold !== undefined && typeof obj.hold !== 'boolean') {
    throw new ApiError(`animation layer "${id}": hold must be true or false, got ${show(obj.hold)}`, [], 'hold false = a non-looping layer stops affecting the pose after its end');
  }
  const layer: AnimationLayer = { id };
  if (obj.time !== undefined) layer.time = obj.time as number;
  if (obj.weight !== undefined) layer.weight = obj.weight as number;
  if (obj.mode !== undefined) layer.mode = obj.mode as 'override' | 'add';
  if (obj.start !== undefined) layer.start = obj.start as number;
  if (obj.hold !== undefined) layer.hold = obj.hold as boolean;
  return checkLayer(model, layer, id, undefined);
}

function checkLayer(model: Model, layer: AnimationLayer, label: string, weightText: string | undefined): AnimationLayer {
  const anim = model.animations.find((a) => a.id === layer.id);
  if (!anim) {
    throw new ApiError(`unknown animation "${layer.id}"`, [], idHint(layer.id, model.animations.map((a) => a.id), 'animations'));
  }
  const w = layer.weight;
  if (w !== undefined && !(Number.isFinite(w) && w >= 0 && w <= 1)) {
    throw new ApiError(
      `weight of animation layer "${label}" must be a number within 0..1, got ${weightText !== undefined ? JSON.stringify(weightText) : w}`,
      [],
      `e.g. "${layer.id}@0.5" or {"id": "${layer.id}", "weight": 0.5}`,
    );
  }
  if (layer.time !== undefined && !Number.isFinite(layer.time)) {
    throw new ApiError(`time of animation layer "${label}" must be a finite number of seconds, got ${layer.time}`, [], `e.g. {"id": "${layer.id}", "time": 0.5}`);
  }
  if (layer.start !== undefined && !Number.isFinite(layer.start)) {
    throw new ApiError(`start of animation layer "${label}" must be a finite number of seconds, got ${layer.start}`, [], `e.g. "${layer.id},start=1.5"`);
  }
  if (layer.time !== undefined && layer.start !== undefined) {
    throw new ApiError(`animation layer "${label}" sets both start and time`, [], 'time fixes the layer clock, so start would be ignored: drop one of them');
  }
  // A loop never ends, so "once" (hold false) only matters before a positive start: the loop then
  // begins at `start` instead of playing phase-shifted from t=0 (core layerActive).
  if (layer.hold === false && anim.loop && !(layer.start !== undefined && layer.start > 0)) {
    throw new ApiError(
      `"once" has no effect on looping animation "${anim.id}" without a start > 0: a loop never ends, so "once" can only silence it before its start`,
      [],
      `to start the loop later, give a start: "${anim.id},once,start=2" or {"id": "${anim.id}", "hold": false, "start": 2} (nothing before 2 s, then it loops); otherwise drop "once" (to stop a looping layer, remove it or give it weight 0)`,
    );
  }
  return layer;
}

/**
 * The layer string of a layer ("idle", "blink@0.5", "talk@0.8,add,once,start=1"): parseLayerSpec
 * reads it back to the same layer (up to fmtNum rounding). Default options are left out.
 */
export function formatLayerSpec(layer: AnimationLayer | string): string {
  if (typeof layer === 'string') return layer;
  const opts = [
    layer.mode === 'add' ? 'add' : '',
    layer.hold === false ? 'once' : '',
    layer.start ? `start=${fmtNum(layer.start)}` : '',
    layer.time !== undefined ? `time=${fmtNum(layer.time)}` : '',
  ].filter(Boolean);
  const weight = layer.weight !== undefined && layer.weight !== 1 ? `@${fmtNum(layer.weight)}` : '';
  return [`${layer.id}${weight}`, ...opts].join(',');
}

/** Human label of a layer for titles and summaries: "talk@0.8(add)", "wink(once, start 2.5s)". */
export function formatLayerLabel(layer: AnimationLayer | string): string {
  if (typeof layer === 'string') return layer;
  const flags: string[] = [];
  if (layer.mode === 'add') flags.push('add');
  if (layer.hold === false) flags.push('once');
  if (layer.start !== undefined && layer.start !== 0) flags.push(`start ${fmtNum(layer.start)}s`);
  if (layer.time !== undefined) flags.push(`t=${fmtNum(layer.time)}s`);
  const weight = layer.weight !== undefined && layer.weight !== 1 ? `@${fmtNum(layer.weight)}` : '';
  return `${layer.id}${weight}${flags.length ? `(${flags.join(', ')})` : ''}`;
}
