/**
 * compose: bake several animations, layered the way Rig.pose layers them (weight, mode, start,
 * hold), into ONE new animation that plays the same when used alone at weight 1.
 *
 * Per track target:
 *   - touched by one layer: the track is COPIED (keys shifted by the layer's start, eases and
 *     offset kept; weight != 1 scales the values toward the rest value, which is exact because
 *     every ease is affine in the key values). Copying is used only where it reproduces the layered
 *     playback exactly; otherwise (a looping layer inside a composition of another length, a
 *     layer cut by the composition window, ...) the target is baked, and the message says why.
 *   - touched by several layers of the SAME one-shot animation whose active windows are disjoint
 *     (e.g. "blink" at 1 s and again at 3 s): the copies are MERGED into one key list, which is
 *     exact because at most one of them is away from the rest value at any time.
 *   - touched by several layers otherwise (or not copyable): BAKED by sampling Rig.pose with the
 *     layers at `fps` (default 60), as linear keys (booleans: step keys), dropping samples that
 *     linear interpolation already reproduces. Source key times and layer boundaries that fall
 *     between two samples are listed in a WARNING with an fps that samples them all.
 * Events are merged, shifted by each layer's start (looping layers repeat theirs every cycle).
 */
import { paramDefault } from '../core/address.js';
import { parseColor } from '../core/color.js';
import { tryParsePath } from '../core/path.js';
import { Rig } from '../core/rig.js';
import { AnimationSchema } from '../core/schema.js';
import type { Animation, AnimationLayer, Model, PathValue, RawValue, ResolvedTarget, Track, Value } from '../core/types.js';
import { validateModel } from '../core/validate.js';
import { normalizeValue } from '../core/values.js';
import type { OpContext } from './context.js';
import { lerpRaw, valueJson, valuesClose } from './keyforms.js';
import { canonicalTarget, checkNewId, type Doc, findItem, type Item, ItemGuard, itemKeys, requireItem, resolveRaw, sectionItems } from './model.js';
import { checkKeyFields } from './values.js';
import { choiceHint, clean, describe, type Fields, fmt, isObject, OpError, q, toPointer } from './util.js';

const LAYER_FIELDS = ['animation', 'weight', 'mode', 'start', 'hold'] as const;
const MODES = ['override', 'add'] as const;
/** Slack for time comparisons (key times, window ends). */
const EPS = 1e-9;
/** A copied "hold": false layer steps back to rest this long after its window ends (key times must differ). */
const STEP_AFTER = 1e-6;
/** Most samples a bake may take (duration × fps + 1). */
const MAX_SAMPLES = 20000;
/** Bake sample rate when "fps" is not given. */
const DEFAULT_FPS = 60;
/** Highest "fps" the op accepts. */
const MAX_FPS = 1000;
/** Source times listed in the between-samples WARNING before "… +N more". */
const MAX_LISTED_TIMES = 8;

interface Layer {
  index: number;
  id: string;
  raw: Item;
  anim: Animation;
  weight: number;
  mode: 'override' | 'add';
  start: number;
  hold: boolean;
  /** Which of weight / mode / start / hold were given (passed to Rig.pose as given). */
  given: AnimationLayer;
}

interface Contributor {
  layer: Layer;
  /** Raw track (as authored) and its normalized form. */
  raw: Item;
  track: Track;
}

/** Rest value of a track target: parameter default or setup value of the property. */
interface Rest {
  param: boolean;
  resolved?: ResolvedTarget;
  /** Parameter default (params only). */
  value: number;
}

export function opCompose(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const id = f.string('id', 'id of the new animation');
  const replace = f.optBoolean('replace', 'overwrite an existing animation with this id') ?? false;
  const existing = findItem(doc, 'animation', id);
  if (existing && !replace) {
    throw new OpError(
      `compose: animation ${q(id)} already exists (${toPointer(['animations', existing.index])})`,
      `pass "replace": true to overwrite it, or choose a new id (e.g. ${q(`${id}Composed`)})`,
    );
  }
  if (!existing) checkNewId(doc, 'animation', id, 'compose');
  const layers = readLayers(doc, f);
  const fps = f.optNumber('fps', 'bake sample rate') ?? DEFAULT_FPS;
  if (!(fps > 0) || fps > MAX_FPS) throw new OpError(`compose: "fps" must be > 0 and <= ${MAX_FPS}, got ${fps}`, `e.g. "fps": 120 (default: ${DEFAULT_FPS})`);
  const live = layers.filter((l) => l.weight > 0);
  const loop = f.optBoolean('loop', 'loop flag of the new animation') ?? layers.every((l) => l.anim.loop);
  const duration = f.optNumber('duration', 'seconds') ?? defaultDuration(live.length ? live : layers);
  if (!(duration > 0)) {
    throw new OpError(`compose: the duration must be > 0, got ${fmt(duration)}`, 'give "duration" (seconds) explicitly; by default it is the longest layer (start + duration for one-shot layers)');
  }
  const samples = Math.floor(duration * fps + EPS) + 1;
  const notes: string[] = [];

  // Targets in first-appearance order, with the layers that animate them.
  const byTarget = new Map<string, Contributor[]>();
  for (const layer of live) {
    layer.anim.tracks.forEach((track, i) => {
      const key = canonicalTarget(track.target)!;
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key)!.push({ layer, raw: (layer.raw.tracks as Item[])[i], track });
    });
  }

  const tracks: Item[] = [];
  const copied: string[] = [];
  const baked: Array<{ key: string; why: string; index: number; list: Contributor[] }> = [];
  const timeline: Timeline = { loop, duration };
  for (const [key, list] of byTarget) {
    const rest = restOf(doc, key, list[0].track.target);
    const copy = list.length === 1 ? copyTrack(list[0], rest, timeline) : mergeTracks(list, rest, timeline);
    if (typeof copy !== 'string') {
      tracks.push(copy);
      copied.push(list.length === 1 ? key : `${key}: ${list.length} ${q(list[0].layer.id)} layers merged`);
      continue;
    }
    baked.push({ key, why: copy, index: tracks.length, list });
    tracks.push({ target: list[0].track.target, keys: [] });
  }

  if (baked.length) {
    const missed = offSampleTimes(baked.flatMap((b) => b.list), fps, duration);
    if (missed.length) notes.push(offSampleWarning(missed, fps, duration));
    if (samples > MAX_SAMPLES) {
      throw new OpError(`compose: baking ${fmt(duration)} s at ${fmt(fps)} fps takes ${samples} samples (limit ${MAX_SAMPLES})`, 'lower "fps" or "duration"');
    }
    const rig = samplingRig(ctx, baked.map((b) => b.key));
    const poseLayers = layers.map((l) => l.given);
    const times = Array.from({ length: samples }, (_, j) => Math.min(duration, j / fps));
    if (duration - times[times.length - 1] > EPS) times.push(duration);
    const rests = baked.map((b) => restOf(doc, b.key, String(tracks[b.index].target)));
    const values = baked.map((): unknown[] => []);
    for (const time of times) {
      const pose = rig.pose({ time, animations: poseLayers, physics: false });
      baked.forEach((b, i) => values[i].push(sampleValue(pose, b.key, rests[i])));
    }
    baked.forEach((b, i) => (tracks[b.index].keys = bakeKeys(times, values[i], rests[i])));
  }

  const events = mergeEvents(live, { loop, duration }, notes);
  for (const l of layers) if (l.weight <= 0) notes.push(`layer ${l.index} (${q(l.id)}) has weight 0 and contributes nothing`);
  for (const l of live) {
    if (!l.anim.loop && l.start + l.anim.duration > duration + EPS) notes.push(`layer ${l.index} (${q(l.id)}) runs to ${fmt(l.start + l.anim.duration)} s and is cut at ${fmt(duration)} s`);
  }
  if (loop) {
    const odd = live.filter((l) => l.anim.loop && !divides(l.anim.duration, duration));
    if (odd.length) {
      const lcm = commonPeriod(live.filter((l) => l.anim.loop).map((l) => l.anim.duration));
      const one = odd.length === 1;
      notes.push(
        `WARNING: ${odd.map((l) => `${q(l.id)} (${fmt(l.anim.duration)} s loop)`).join(', ')} ${one ? 'does' : 'do'} not fit a whole number of times into ${fmt(duration)} s, so ${one ? 'its cycle jumps' : 'their cycles jump'} where the composition loops${lcm !== undefined && lcm <= 120 ? `; "duration": ${fmt(lcm)} loops seamlessly` : ''}`,
      );
    }
  }

  const animation: Item = { id, duration: clean(duration), ...(loop ? {} : { loop: false }), tracks, ...(events.length ? { events } : {}) };
  const description = f.optString('description', 'note');
  if (description !== undefined) animation.description = description;
  const order = itemKeys('animation');
  const sorted = Object.fromEntries(order.filter((k) => Object.hasOwn(animation, k)).map((k) => [k, animation[k]]));
  const items = sectionItems(doc, 'animation', true);
  const index = existing ? existing.index : items.length;
  if (existing) items[index] = sorted;
  else items.push(sorted);
  new ItemGuard(doc, 'animation', sorted, true).check(`compose ${id}`);

  const parts = [
    `${existing ? 'replaced' : 'composed'} animation ${q(id)} ${existing ? 'at' : 'as'} ${toPointer(['animations', index])} (${fmt(duration)} s, ${loop ? 'looping' : 'once'}) from ${layers.length} layer${layers.length === 1 ? '' : 's'} (${layers.map((l) => l.id).join(', ')})`,
    copied.length ? `copied ${copied.length} track${copied.length === 1 ? '' : 's'} (${listShort(copied)})` : '',
    baked.length
      ? `baked ${baked.length} track${baked.length === 1 ? '' : 's'} at ${fmt(fps)} fps (${baked.map((b) => `${b.key}: ${b.why} → ${(tracks[b.index].keys as unknown[]).length} keys`).join('; ')})`
      : '',
    events.length ? `merged ${events.length} event${events.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `${parts.join('; ')}${notes.length ? `; ${notes.join('; ')}` : ''}`;
}

function listShort(keys: string[]): string {
  return keys.length > 6 ? `${keys.slice(0, 6).join(', ')}, … +${keys.length - 6}` : keys.join(', ');
}


// ----------------------------------------------------------------------------- layers

function readLayers(doc: Doc, f: Fields): Layer[] {
  const raw = f.array('layers', '[{"animation": id, "weight"?, "mode"?, "start"?, "hold"?}]');
  if (!raw.length) throw new OpError('compose: "layers" is empty', 'e.g. "layers": [{"animation": "idle"}, {"animation": "wave", "start": 1}]');
  return raw.map((entry, index): Layer => {
    const where = `compose: layers[${index}]`;
    const l = typeof entry === 'string' ? { animation: entry } : entry;
    if (!isObject(l)) throw new OpError(`${where} must be an animation id or {"animation": id, ...}, got ${describe(entry)}`);
    checkKeyFields(l, LAYER_FIELDS, where);
    if (typeof l.animation !== 'string' || !l.animation) throw new OpError(`${where} needs "animation" (an animation id)`, 'e.g. {"animation": "idle", "weight": 1}');
    const { item } = requireItem(doc, 'animation', l.animation);
    const parsed = AnimationSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new OpError(`${where}: animation ${q(l.animation)} is not valid (${issue.message} at ${issue.path.join('.') || 'the animation'})`, 'fix it first (rev2d validate shows the details)');
    }
    const given: AnimationLayer = { id: l.animation };
    const num = (k: 'weight' | 'start'): number | undefined => {
      if (l[k] === undefined) return undefined;
      const v = l[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new OpError(`${where}.${k} must be a number, got ${describe(v)}`);
      return v;
    };
    const weight = num('weight');
    if (weight !== undefined && (weight < 0 || weight > 1)) throw new OpError(`${where}.weight must be between 0 and 1, got ${weight}`);
    const start = num('start');
    if (l.mode !== undefined && (typeof l.mode !== 'string' || !(MODES as readonly string[]).includes(l.mode))) {
      throw new OpError(`${where}.mode must be "override" or "add", got ${describe(l.mode)}`, choiceHint(typeof l.mode === 'string' ? l.mode : '', MODES, 'modes'));
    }
    if (l.hold !== undefined && typeof l.hold !== 'boolean') throw new OpError(`${where}.hold must be true or false, got ${describe(l.hold)}`);
    if (weight !== undefined) given.weight = weight;
    if (l.mode !== undefined) given.mode = l.mode as Layer['mode'];
    if (start !== undefined) given.start = start;
    if (l.hold !== undefined) given.hold = l.hold as boolean;
    return {
      index,
      id: l.animation,
      raw: item,
      anim: parsed.data,
      weight: weight ?? 1,
      mode: (l.mode as Layer['mode'] | undefined) ?? 'override',
      start: start ?? 0,
      hold: (l.hold as boolean | undefined) ?? true,
      given,
    };
  });
}

/** Longest layer: its duration when it loops, start + duration when it plays once. */
function defaultDuration(layers: Layer[]): number {
  return Math.max(...layers.map((l) => (l.anim.loop ? l.anim.duration : l.start + l.anim.duration)));
}

function divides(period: number, total: number): boolean {
  const n = total / period;
  return Math.abs(n - Math.round(n)) < 1e-6 && Math.round(n) >= 1;
}

/** Least common multiple of loop durations (on a millisecond grid), when there is a small one. */
function commonPeriod(durations: number[]): number | undefined {
  const ms = durations.map((d) => Math.round(d * 1000));
  if (ms.some((m, i) => m <= 0 || Math.abs(m - durations[i] * 1000) > 1e-6)) return undefined;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  let lcm = ms[0];
  for (const m of ms.slice(1)) {
    lcm = (lcm / gcd(lcm, m)) * m;
    if (lcm > 1e9) return undefined;
  }
  return lcm / 1000;
}

// ----------------------------------------------------------------------------- rest values

function restOf(doc: Doc, key: string, target: string): Rest {
  if (key.startsWith('param:')) {
    const p = requireItem(doc, 'parameter', key.slice('param:'.length)).item;
    if (typeof p.min !== 'number' || typeof p.max !== 'number') throw new OpError(`compose: parameter ${q(String(p.id))} has no numeric min/max`, 'fix the parameter first');
    return { param: true, value: paramDefault({ min: p.min, max: p.max, default: typeof p.default === 'number' ? p.default : undefined }) };
  }
  return { param: false, resolved: resolveRaw(doc, target, 'compose').resolved, value: 0 };
}

function normalized(v: unknown, rest: Rest): Value {
  return rest.param ? (v as number) : normalizeValue(v as RawValue, rest.resolved!);
}

function isRest(v: unknown, rest: Rest): boolean {
  if (rest.param) return Math.abs((v as number) - rest.value) < EPS;
  return valuesClose(normalized(v, rest), rest.resolved!.setup, rest.resolved!.valueType);
}

function valuesEqual(a: unknown, b: unknown, rest: Rest): boolean {
  if (rest.param) return Math.abs((a as number) - (b as number)) < EPS;
  return valuesClose(normalized(a, rest), normalized(b, rest), rest.resolved!.valueType);
}

function restJson(rest: Rest): unknown {
  return rest.param ? rest.value : valueJson(rest.resolved!.setup, rest.resolved!.valueType);
}

/** rest + w · (v − rest), as JSON in the value's own form (sparse point maps stay sparse). */
function scaleToward(v: unknown, rest: Rest, w: number): unknown {
  if (w === 1) return structuredClone(v);
  if (rest.param) return clean(rest.value + w * ((v as number) - rest.value));
  const r = rest.resolved!;
  if (r.valueType === 'points' && isObject(v)) {
    const setup = r.setup as number[];
    return Object.fromEntries(
      Object.entries(v as Record<string, [number, number]>).map(([k, [x, y]]) => {
        const i = Number(k) * 2;
        return [k, [clean(setup[i] + w * (x - setup[i]), 4), clean(setup[i + 1] + w * (y - setup[i + 1]), 4)]];
      }),
    );
  }
  return lerpRaw(valueJson(r.setup, r.valueType), v, w, r);
}

// ----------------------------------------------------------------------------- copy

interface Timeline {
  loop: boolean;
  duration: number;
}

/**
 * The layer's track re-timed into the composition, or the reason it cannot be copied exactly
 * (the target is then baked). See the module comment for the rules.
 */
function copyTrack(c: Contributor, rest: Rest, n: Timeline): Item | string {
  const { layer, raw, track } = c;
  const { anim, start, weight } = layer;
  const bool = !rest.param && rest.resolved!.valueType === 'boolean';
  if (weight !== 1 && bool) return `weight ${fmt(weight)} on a boolean track`;
  const smooth = track.keys.some((k) => k.ease === 'smooth');
  const rawKeys = raw.keys as Item[];
  const scaled = (k: Item): Item => ({ ...k, v: scaleToward(k.v, rest, weight) });

  if (anim.loop) {
    const d = anim.duration;
    if (n.loop && Math.abs(n.duration - d) <= EPS) {
      // Same loop length: the keys as they are, the start folded into the track offset.
      if (!layer.hold && start > EPS) return `${q(layer.id)} starts at ${fmt(start)} s with "hold": false`;
      const offset = clean(wrapTime(track.offset + start, d));
      const out: Item = { target: raw.target, keys: rawKeys.map(scaled) };
      if (offset > EPS && d - offset > EPS) out.offset = offset;
      return out;
    }
    // A loop that plays at most once, from its start, inside a one-shot: nothing wraps, so the
    // keys copy as they are (at t = duration the loop shows its first value: the ends must agree).
    const loops = `${q(layer.id)} loops every ${fmt(d)} s inside a ${n.loop ? `${fmt(n.duration)} s loop` : 'one-shot composition'}`;
    if (n.loop || n.duration > d + EPS) return loops;
    if (Math.abs(start) > EPS) return `${loops} and starts at ${fmt(start)} s`;
    if (track.offset !== 0) return `${loops} with a track offset`;
    if (smooth) return `${loops} and its "smooth" keys wrap around the loop`;
    const last = track.keys[track.keys.length - 1];
    if (last.t > n.duration + EPS) return `${loops} and has keys after ${fmt(n.duration)} s`;
    if (Math.abs(n.duration - d) <= EPS && !valuesEqual(track.keys[0].v, last.v, rest)) return `${loops} and its first and last values differ`;
    return { target: raw.target, keys: rawKeys.map(scaled).map(orderKey) };
  }

  if (track.offset !== 0) return `track offset ${fmt(track.offset)} s in one-shot ${q(layer.id)}`;
  const times = track.keys.map((k) => k.t);
  if (times[times.length - 1] > anim.duration + EPS) return `keys after the end of ${q(layer.id)}`;
  const shifted = times.map((t) => t + start);
  if (shifted[0] < -EPS || shifted[shifted.length - 1] > n.duration + EPS) return `${q(layer.id)} at ${fmt(start)} s runs outside 0..${fmt(n.duration)} s`;
  const keys: Item[] = rawKeys.map((k, i) => ({ ...scaled(k), t: clean(shifted[i]) }));
  let added = false;
  if (!layer.hold) {
    // Outside its window [start, start + duration] the layer contributes nothing: step from and
    // back to the rest value around it. The step back sits STEP_AFTER past the window's end, so the
    // window's last instant still shows the layer (key times must differ).
    const end = start + anim.duration;
    const first = keys[0];
    if (start >= STEP_AFTER && !isRest(track.keys[0].v, rest)) {
      const pre: Item[] = [{ t: 0, v: restJson(rest), ease: 'step' }];
      if ((first.t as number) - start > STEP_AFTER) pre.push({ t: clean(start), v: structuredClone(first.v) });
      keys.unshift(...pre);
      added = true;
    }
    if (end + STEP_AFTER < n.duration - EPS && !isRest(track.keys[track.keys.length - 1].v, rest)) {
      keys[keys.length - 1] = { ...keys[keys.length - 1], ease: 'step' };
      keys.push({ t: clean(end + STEP_AFTER), v: restJson(rest) });
      added = true;
    }
  }
  if (smooth && (added || (n.loop && closed(keys, n.duration)))) return `"smooth" keys in ${q(layer.id)} would get different tangents`;
  return { target: raw.target, keys: keys.map(orderKey) };
}

/**
 * Several layers on one target: one key list when they are layers of the same one-shot animation
 * whose active windows do not overlap, or the reason they must be baked. Exact because, at every
 * time, at most one of the layers is away from the rest value and nothing else touches the target:
 *   - "hold": false layers contribute nothing outside [start, start + duration];
 *   - holding layers must start and end at the rest value (their holds then contribute rest), and
 *     for parameters in "override" mode a holding layer must come first in the layer list: a later
 *     one would pull the value back to rest while an earlier layer plays.
 * Windows may touch only where both sides are at rest; steps to and from rest (as in copyTrack)
 * need 2 µs of room between windows.
 */
function mergeTracks(list: Contributor[], rest: Rest, n: Timeline): Item | string {
  const ids = list.map((c) => c.layer.id);
  if (new Set(ids).size > 1) return ids.join(' + ');
  const { anim } = list[0].layer;
  const label = `${list.length} layers of ${q(ids[0])}`;
  if (anim.loop) return `${label} (a loop: only layers of a one-shot animation merge)`;
  const { track, raw } = list[0];
  if (track.offset !== 0) return `${label} with track offset ${fmt(track.offset)} s`;
  if (track.keys.some((k) => k.ease === 'smooth')) return `${label} with "smooth" keys (their tangents would change)`;
  const bool = !rest.param && rest.resolved!.valueType === 'boolean';
  if (bool && list.some((c) => c.layer.weight !== 1)) return `${label} with a weight below 1 on a boolean track`;
  if (track.keys[track.keys.length - 1].t > anim.duration + EPS) return `${label} with keys after the end of ${q(ids[0])}`;
  const firstRest = isRest(track.keys[0].v, rest);
  const lastRest = isRest(track.keys[track.keys.length - 1].v, rest);
  for (const c of list) {
    if (!c.layer.hold) continue;
    const where = `layers[${c.layer.index}]`;
    if (!firstRest || !lastRest) {
      return `${label}: ${where} holds its ${firstRest ? 'last' : 'first'} value outside its window, and that value is not the rest value (give it "hold": false)`;
    }
    const earlier = rest.param && c.layer.mode === 'override' ? list.find((o) => o.layer.index < c.layer.index) : undefined;
    if (earlier) {
      return `${label}: ${where} holds its keys outside its window in "override" mode, which hides layers[${earlier.layer.index}] (give ${where} "hold": false or "mode": "add")`;
    }
  }
  const sorted = [...list].sort((a, b) => a.layer.start - b.layer.start || a.layer.index - b.layer.index);
  const rawKeys = raw.keys as Item[];
  const d = anim.duration;
  const keys: Item[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const { start, weight, index } = sorted[i].layer;
    const end = start + d;
    const shifted = rawKeys.map((k, j): Item => ({ ...k, v: scaleToward(k.v, rest, weight), t: clean(track.keys[j].t + start) }));
    const first = shifted[0].t as number;
    const last = shifted[shifted.length - 1].t as number;
    if (first < -EPS || last > n.duration + EPS) return `${label}: layers[${index}] at ${fmt(start)} s runs outside 0..${fmt(n.duration)} s`;
    if (i > 0) {
      const prev = sorted[i - 1].layer;
      const gap = start - (prev.start + d);
      const span = (s: number) => `${fmt(s)}..${fmt(s + d)} s`;
      if (gap < -EPS) return `${label}: their windows overlap (${span(prev.start)} and ${span(start)})`;
      if ((!firstRest || !lastRest) && gap <= 2 * STEP_AFTER) {
        return `${label}: their windows ${span(prev.start)} and ${span(start)} touch where the value is not at rest`;
      }
    }
    if (!firstRest) {
      // Step from rest into the window (the key before, when there is one, is at rest).
      if (keys.length) keys[keys.length - 1] = { ...keys[keys.length - 1], ease: 'step' };
      else if (start >= STEP_AFTER) keys.push({ t: 0, v: restJson(rest), ease: 'step' });
      if (first - start > STEP_AFTER && (keys.length || start >= STEP_AFTER)) keys.push({ t: clean(start), v: structuredClone(shifted[0].v) });
    } else if (keys.length && Math.abs((keys[keys.length - 1].t as number) - first) <= EPS) {
      // Touching windows, both at rest: one key.
      keys.pop();
    }
    keys.push(...shifted);
    if (!lastRest && end + STEP_AFTER < n.duration - EPS) {
      keys[keys.length - 1] = { ...keys[keys.length - 1], ease: 'step' };
      keys.push({ t: clean(end + STEP_AFTER), v: restJson(rest) });
    }
  }
  for (let i = 1; i < keys.length; i++) {
    if ((keys[i].t as number) <= (keys[i - 1].t as number)) return `${label}: their windows are too close to merge (keys at ${fmt(keys[i].t as number)} s)`;
  }
  return { target: raw.target, keys: keys.map(orderKey) };
}

function closed(keys: Item[], duration: number): boolean {
  return keys.length > 1 && Math.abs(keys[0].t as number) <= EPS && Math.abs((keys[keys.length - 1].t as number) - duration) <= EPS;
}

function orderKey(k: Item): Item {
  return { t: k.t, v: k.v, ...(k.ease !== undefined ? { ease: k.ease } : {}) };
}

function wrapTime(t: number, d: number): number {
  return ((t % d) + d) % d;
}

// ----------------------------------------------------------------------------- bake

/**
 * A rig for sampling layered playback: the model without bindings (so property values are the
 * animation contributions alone) and without physics.
 */
function samplingRig(ctx: OpContext, keys: string[]): Rig {
  const { model, diagnostics } = validateModel(ctx.doc);
  if (!model) {
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const first = errors[0];
    throw new OpError(
      `compose: baking ${listShort(keys)} samples the layered playback, which needs a valid model, but validation reports ${errors.length} error${errors.length === 1 ? '' : 's'}${first ? ` (first: ${first.message} at ${first.path})` : ''}`,
      'fix those first (earlier ops in the same batch can), or compose layers whose tracks target different properties (those are copied without sampling)',
    );
  }
  const bare: Model = { ...model, bindings: [], physics: [] };
  try {
    return new Rig(bare, { textures: ctx.textures });
  } catch (e) {
    throw new OpError(`compose: cannot evaluate the model to bake ${listShort(keys)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function sampleValue(pose: ReturnType<Rig['pose']>, key: string, rest: Rest): unknown {
  if (rest.param) return clean(pose.params[key.slice('param:'.length)]);
  const v = Object.hasOwn(pose.properties, key) ? pose.properties[key] : restJson(rest);
  return rest.resolved!.valueType === 'boolean' ? (typeof v === 'boolean' ? v : (v as number) >= 0.5) : v;
}

/** Numbers of a sample for the collinearity test, with the tolerance of its JSON rounding. */
function flat(v: unknown, rest: Rest): { nums: number[]; tol: number } {
  if (rest.param) return { nums: [v as number], tol: 1e-6 };
  switch (rest.resolved!.valueType) {
    case 'number':
      return { nums: [v as number], tol: 1e-4 };
    case 'points':
      return { nums: v as number[], tol: 1e-3 };
    case 'color':
      return { nums: (parseColor(v as string) ?? [0, 0, 0, 0]).map((c) => c * 255), tol: 0.5 };
    case 'path':
      return { nums: (tryParsePath(v as string) as PathValue | null)?.nums ?? [], tol: 1e-3 };
    default:
      return { nums: [v ? 1 : 0], tol: 0 };
  }
}

/**
 * Linear keys through the samples, dropping every sample that the line between its kept
 * neighbours already reproduces (within the rounding of the sampled values). Booleans get step
 * keys at each change.
 */
function bakeKeys(times: number[], values: unknown[], rest: Rest): Item[] {
  if (!rest.param && rest.resolved!.valueType === 'boolean') {
    const keys: Item[] = [];
    values.forEach((v, i) => {
      if (i === 0 || v !== values[i - 1]) keys.push({ t: clean(times[i]), v, ease: 'step' });
    });
    return keys;
  }
  const flats = values.map((v) => flat(v, rest));
  const kept = [0];
  let anchor = 0;
  for (let i = 1; i < values.length - 1; i++) {
    // Can the segment anchor → i+1 stand in for every sample between them?
    const a = anchor;
    const b = i + 1;
    let ok = true;
    for (let k = a + 1; k < b && ok; k++) {
      const s = (times[k] - times[a]) / (times[b] - times[a]);
      const fa = flats[a].nums;
      const fb = flats[b].nums;
      const fk = flats[k].nums;
      for (let j = 0; j < fk.length; j++) {
        if (Math.abs(fa[j] + (fb[j] - fa[j]) * s - fk[j]) > flats[k].tol) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) {
      kept.push(i);
      anchor = i;
    }
  }
  if (values.length > 1) kept.push(values.length - 1);
  return kept.map((i) => ({ t: clean(times[i]), v: roundJson(values[i], rest) }));
}

function roundJson(v: unknown, rest: Rest): unknown {
  if (rest.param) return clean(v as number);
  if (typeof v === 'number') return clean(v, 6);
  if (Array.isArray(v)) return v.map((n) => clean(n as number, 4));
  return v;
}

// ----------------------------------------------------------------------------- sample grid

interface SourceTime {
  t: number;
  /** What happens there, e.g. '"blink" key', '"talk" end'. */
  what: string[];
}

/**
 * Times strictly inside (0, duration) where a baked target's source changes course, sorted, that
 * fall between two bake samples (j / fps): key times of the contributing tracks (every cycle of a
 * looping layer) and the window boundaries of "hold": false layers (start; one-shots also
 * start + duration). A baked track has keys only at samples, so it cuts corners at these times.
 */
function offSampleTimes(contributors: Contributor[], fps: number, duration: number): SourceTime[] {
  const found = new Map<number, SourceTime>();
  const add = (t: number, what: string) => {
    if (!(t > EPS && t < duration - EPS) || onGrid(t, fps)) return;
    const key = clean(t, 6);
    const entry = found.get(key) ?? { t: key, what: [] };
    if (!entry.what.includes(what)) entry.what.push(what);
    found.set(key, entry);
  };
  const layers = new Set<Layer>();
  for (const { layer, track } of contributors) {
    layers.add(layer);
    const { anim, start } = layer;
    const d = anim.duration;
    for (const k of track.keys) {
      const local = k.t + track.offset;
      if (!anim.loop) {
        if (local >= -EPS && local <= d + EPS) add(start + local, `${q(layer.id)} key`);
        continue;
      }
      // Looping: the key comes round every cycle; without hold nothing plays before start.
      const phase = wrapTime(local, d);
      const from = layer.hold ? 0 : start;
      for (let m = Math.ceil((from - start - phase) / d - EPS); start + phase + m * d < duration; m++) add(start + phase + m * d, `${q(layer.id)} key`);
    }
  }
  for (const layer of layers) {
    if (layer.hold) continue;
    add(layer.start, `${q(layer.id)} start`);
    if (!layer.anim.loop) add(layer.start + layer.anim.duration, `${q(layer.id)} end`);
  }
  return [...found.values()].sort((a, b) => a.t - b.t);
}

function onGrid(t: number, fps: number): boolean {
  const s = t * fps;
  return Math.abs(s - Math.round(s)) < 1e-6;
}

/** Smallest q <= MAX_FPS with t · q an integer (the sample rates hitting t are its multiples). */
function denominator(t: number): number | undefined {
  for (let q = 1; q <= MAX_FPS; q++) if (onGrid(t, q)) return q;
  return undefined;
}

/** The lowest rate >= fps that puts a sample on every time, if there is one within the limits. */
function alignedFps(times: number[], fps: number, duration: number): number | undefined {
  let lcm = 1;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  for (const t of times) {
    const q = denominator(t);
    if (q === undefined) return undefined;
    lcm = (lcm / gcd(lcm, q)) * q;
    if (lcm > MAX_FPS) return undefined;
  }
  const rate = lcm * Math.ceil(fps / lcm - EPS);
  return rate <= MAX_FPS && Math.floor(duration * rate + EPS) + 1 <= MAX_SAMPLES ? rate : undefined;
}

function offSampleWarning(times: SourceTime[], fps: number, duration: number): string {
  const n = times.length;
  const shown = times.slice(0, MAX_LISTED_TIMES).map((s) => `${s.t} s (${s.what.join(', ')})`);
  if (n > MAX_LISTED_TIMES) shown.push(`… +${n - MAX_LISTED_TIMES} more`);
  const rate = alignedFps(
    times.map((s) => s.t),
    fps,
    duration,
  );
  const fix =
    rate !== undefined
      ? `"fps": ${rate} puts a sample on each`
      : `no "fps" up to ${MAX_FPS} samples them all: move those keys and starts onto multiples of 1/${fmt(fps)} s, or raise "fps" to shrink the error`;
  return `WARNING: ${n} source time${n === 1 ? '' : 's'} of the baked tracks fall${n === 1 ? 's' : ''} between the ${fmt(fps)} fps bake samples, so the baked keys can miss the values there: ${shown.join(', ')}; ${fix}`;
}

// ----------------------------------------------------------------------------- events

function mergeEvents(layers: Layer[], n: Timeline, notes: string[]): Item[] {
  const out: Array<{ t: number; order: number; e: Item }> = [];
  let dropped = 0;
  const end = n.duration;
  const inside = (t: number) => t >= -EPS && (n.loop ? t < end - EPS : t <= end + EPS);
  layers.forEach((layer, li) => {
    const events = Array.isArray(layer.raw.events) ? (layer.raw.events as Item[]) : [];
    const d = layer.anim.duration;
    events.forEach((e, ei) => {
      const t0 = typeof e.t === 'number' ? e.t : 0;
      const push = (t: number) => out.push({ t: clean(Math.max(0, t)), order: li * 1e6 + ei, e: { ...e, t: clean(Math.max(0, t)) } });
      if (!layer.anim.loop) {
        if (t0 > d + EPS) return;
        const t = t0 + layer.start;
        if (inside(t)) push(t);
        else dropped++;
        return;
      }
      // Looping layers repeat their events every cycle; without hold nothing fires before start.
      const phase = wrapTime(t0, d);
      const from = layer.hold ? 0 : Math.max(0, layer.start);
      let any = false;
      for (let k = Math.ceil((from - layer.start - phase) / d - EPS); ; k++) {
        const t = layer.start + phase + k * d;
        if (t > end + EPS) break;
        if (inside(t)) {
          push(t);
          any = true;
        }
      }
      if (!any) dropped++;
    });
  });
  if (dropped) notes.push(`${dropped} event${dropped === 1 ? '' : 's'} outside 0..${fmt(end)} s dropped`);
  return out.sort((a, b) => a.t - b.t || a.order - b.order).map((x) => x.e);
}
