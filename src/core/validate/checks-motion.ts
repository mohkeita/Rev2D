/**
 * Semantic checks for everything that moves the rig: bindings, IK, physics and animations.
 */
import type { Binding, Model, PathValue, RawValue, ResolvedTarget, RGBA, Value } from '../types.js';
import { AddressError, parseAddress, resolveTarget } from '../address.js';
import { formatColor } from '../color.js';
import { normalizeValue, ValueError } from '../values.js';
import type { SemanticContext } from './context.js';
import { toPointer } from './diagnostics.js';
import { overflowingPathNumber } from './geometry-limits.js';
import { formatQuotedList, q } from './text.js';

const ADDRESS_HINT = 'addresses look like "bone:<id>.rotation", "part:<id>.opacity", "part:<id>.shape.rx", "warp:<id>.offsets" or "ik:<id>.mix"';
/** How many missing grid combinations a binding-grid-incomplete hint lists. */
const MISSING_KEYS_SHOWN = 8;

/**
 * Resolve a binding/track target, reporting 'invalid-target' (or a param target in a binding).
 * Returns null when the target is unusable, including shape fields of parts whose shape is already
 * reported as invalid (checking values against a broken setup shape would only add noise).
 */
function checkTarget(ctx: SemanticContext, raw: string, path: readonly PropertyKey[], allowParam: boolean): ResolvedTarget | null {
  try {
    const address = parseAddress(raw);
    if (address.kind === 'param' && !allowParam) {
      ctx.sink.error(
        'binding-param-target',
        path,
        `bindings cannot target a parameter (${q(raw)})`,
        'bindings turn parameter values into property values; drive parameters from animations or physics, and bind the property the parameter should control',
      );
      return null;
    }
    if (address.kind === 'part' && address.prop[0] === 'shape' && ctx.brokenShapes.has(address.id)) return null;
    return resolveTarget(ctx.model, address);
  } catch (e) {
    if (!(e instanceof AddressError)) throw e;
    ctx.sink.error('invalid-target', path, e.message, e.hint ?? ADDRESS_HINT);
    return null;
  }
}

/** Normalize a keyform / key value for `target`, reporting 'invalid-value'; null when it is invalid. */
function checkValue(ctx: SemanticContext, raw: RawValue, target: ResolvedTarget, path: readonly PropertyKey[]): Value | null {
  // Report overflowing path numbers specifically (parsePath would only say "out of range").
  const overflow = target.valueType === 'path' && typeof raw === 'string' ? overflowingPathNumber(raw) : null;
  if (overflow !== null) {
    ctx.sink.error('invalid-value', path, `SVG path number ${q(overflow)} is too large for ${q(target.key)}`, 'path numbers must be finite');
    return null;
  }
  try {
    return normalizeValue(raw, target);
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    ctx.sink.error('invalid-value', path, `${e.message} for ${q(target.key)}`, e.hint);
    return null;
  }
}

function fmtNum(n: number): string {
  return String(Object.is(n, -0) ? 0 : n);
}

function fmtAt(at: readonly number[]): string {
  return `[${at.map(fmtNum).join(', ')}]`;
}

// ----------------------------------------------------------------------------- bindings

export function checkBindings(ctx: SemanticContext): void {
  ctx.checkDuplicateIds('bindings');
  ctx.model.bindings.forEach((b, i) => {
    const at = ['bindings', i];
    const target = checkTarget(ctx, b.target, [...at, 'target'], false);

    const seen = new Set<string>();
    b.params.forEach((p, j) => {
      if (seen.has(p)) {
        ctx.sink.error('binding-duplicate-param', [...at, 'params', j], `parameter ${q(p)} is listed twice`, 'each driving parameter may appear once');
      } else {
        ctx.checkRef('parameters', p, [...at, 'params', j]);
      }
      seen.add(p);
    });

    let gridOk = seen.size === b.params.length;
    const values: Array<Value | null> = [];
    b.keys.forEach((key, j) => {
      const keyAt = [...at, 'keys', j];
      if (key.at.length !== b.params.length) {
        gridOk = false;
        ctx.sink.error(
          'binding-at-length',
          [...keyAt, 'at'],
          `"at" has ${key.at.length} value(s) but the binding has ${b.params.length} parameter(s) (${formatQuotedList(b.params)})`,
          `one value per parameter, in "params" order, e.g. "at": ${fmtAt(b.params.map(() => 0))}`,
        );
      } else {
        key.at.forEach((v, d) => {
          const p = ctx.param(b.params[d]);
          if (p && p.min <= p.max && (v < p.min || v > p.max)) {
            ctx.sink.warning(
              'binding-key-out-of-range',
              [...keyAt, 'at', d],
              `${q(p.id)} value ${fmtNum(v)} is outside its range [${p.min}, ${p.max}]`,
              'the parameter is clamped to its range, so this keyform is never reached exactly',
            );
          }
        });
      }
      if (target) values.push(checkValue(ctx, key.value, target, [...keyAt, 'value']));
    });
    if (gridOk) checkGrid(ctx, b, at);
    if (target && values.length > 0 && values.every((v) => v !== null)) checkBindingEffect(ctx, b, at, target, values as Value[]);
  });
}

/** Keyform values within this distance of the setup value (element-wise) count as unchanged. */
const NO_EFFECT_EPS = 1e-9;

function sameAsSetup(v: Value, setup: Value): boolean {
  if (typeof v === 'number') return Math.abs(v - (setup as number)) <= NO_EFFECT_EPS;
  const a = Array.isArray(v) ? v : v.nums;
  const s = Array.isArray(setup) ? setup : (setup as PathValue).nums;
  return a.length === s.length && a.every((x, k) => Math.abs(x - s[k]) <= NO_EFFECT_EPS);
}

/**
 * The validator resolves targets without decoded textures, so an image's omitted `w`/`h` has an unknown
 * setup value when neither a crop nor the model's texture entry gives the size.
 */
function setupKnown(model: Model, target: ResolvedTarget): boolean {
  const { address } = target;
  if (address.kind !== 'part' || address.prop[0] !== 'shape') return true;
  const field = address.prop[1];
  const shape = model.parts.find((p) => p.id === address.id)?.shape;
  if (shape?.type !== 'image' || (field !== 'w' && field !== 'h') || shape[field] !== undefined || shape.crop) return true;
  const texture = model.textures.find((t) => t.id === shape.texture);
  return texture?.[field === 'w' ? 'width' : 'height'] !== undefined;
}

/** Setup value for messages. */
function describeSetup(target: ResolvedTarget): string {
  const s = target.setup;
  switch (target.valueType) {
    case 'number':
      return `its setup value ${fmtNum(s as number)}`;
    case 'boolean':
      return `its setup value ${s ? 'true' : 'false'}`;
    case 'color':
      return `its setup color ${q(formatColor(s as RGBA))}`;
    case 'path':
      return 'its setup path';
    case 'points':
      return 'its setup points';
  }
}

/** A binding whose every keyform equals the setup value never changes the property (binding-no-effect). */
function checkBindingEffect(ctx: SemanticContext, b: Binding, at: readonly PropertyKey[], target: ResolvedTarget, values: Value[]): void {
  if (!setupKnown(ctx.model, target) || !values.every((v) => sameAsSetup(v, target.setup))) return;
  const n = values.length;
  const keyforms = n === 1 ? 'its only keyform' : `all ${n} keyforms`;
  const driven = `driven by ${formatQuotedList(b.params)}`;
  if (target.address.kind === 'warp') {
    ctx.sink.info(
      'binding-no-effect',
      at,
      `binding on ${q(target.key)} (${driven}) has no effect: ${keyforms} are all-zero offsets, so the lattice never moves`,
      `warp offsets are relative to the rest lattice: give the keyforms away from the rest pose non-zero offsets (e.g. "value": {"4": [8, 0]} moves point 4 right by 8 px), fix "target" if it names the wrong warp, or remove the binding`,
    );
    return;
  }
  ctx.sink.info(
    'binding-no-effect',
    at,
    `binding on ${q(target.key)} (${driven}) has no effect: ${keyforms} equal ${describeSetup(target)}, so the property never changes`,
    `keyform values are absolute (only warp offsets are relative), so an offset of 0 written as the value, or the setup value everywhere, does nothing: write the value the property should have at each "at" (e.g. setup ± the change at the parameter's ends; the bind op with "relative": true converts offsets for you), fix "target" if it names the wrong property, or remove the binding`,
  );
}

/** Keyforms must cover the full Cartesian grid of the distinct `at` values of each parameter. */
function checkGrid(ctx: SemanticContext, b: Binding, at: readonly PropertyKey[]): void {
  const dims = b.params.length;
  const axes = Array.from({ length: dims }, (_, d) => [...new Set(b.keys.map((k) => k.at[d]))].sort((x, y) => x - y));
  const gridKey = (values: readonly number[]) => values.map(fmtNum).join(',');

  const first = new Map<string, number>();
  b.keys.forEach((key, j) => {
    const id = gridKey(key.at);
    const prev = first.get(id);
    if (prev === undefined) {
      first.set(id, j);
    } else {
      ctx.sink.error(
        'binding-duplicate-key',
        [...at, 'keys', j],
        `duplicate keyform at ${fmtAt(key.at)} (same "at" as ${toPointer([...at, 'keys', prev])})`,
        'remove one of them or give it a different "at"',
      );
    }
  });

  const total = axes.reduce((n, axis) => n * axis.length, 1);
  const missingCount = total - first.size;
  if (missingCount <= 0) return;

  // Walk the grid in order; every step is either present or missing, so this ends after at most
  // first.size + MISSING_KEYS_SHOWN steps even for huge grids.
  const missing: number[][] = [];
  const idx = new Array<number>(dims).fill(0);
  while (missing.length < MISSING_KEYS_SHOWN) {
    const combo = idx.map((k, d) => axes[d][k]);
    if (!first.has(gridKey(combo))) missing.push(combo);
    let d = dims - 1;
    while (d >= 0 && ++idx[d] === axes[d].length) idx[d--] = 0;
    if (d < 0) break;
  }
  const grid = b.params.map((p, d) => `${p} {${axes[d].map(fmtNum).join(', ')}}`).join(' × ');
  const shown = missing.map(fmtAt).join(', ');
  const rest = missingCount > missing.length ? `, … (+${missingCount - missing.length} more)` : '';
  ctx.sink.error(
    'binding-grid-incomplete',
    [...at, 'keys'],
    `keyforms do not form a full grid: ${grid} needs ${total} keys, ${missingCount} missing`,
    `add keys with "at": ${shown}${rest}`,
  );
}

// ----------------------------------------------------------------------------- ik

export function checkIk(ctx: SemanticContext): void {
  ctx.checkDuplicateIds('ik');
  ctx.model.ik.forEach((c, i) => {
    const at = ['ik', i];
    const bonesOk = c.bones.map((b, j) => ctx.checkRef('bones', b, [...at, 'bones', j])).every(Boolean);
    const targetOk = ctx.checkRef('bones', c.target, [...at, 'target']);
    if (!bonesOk) return;

    if (c.bones.length === 2) {
      const [first, second] = c.bones;
      if (first === second) {
        ctx.sink.error('ik-not-chain', [...at, 'bones', 1], `the chain lists ${q(first)} twice`, 'use one bone for aim IK, or [parent, child] for two-bone IK');
      } else if (ctx.boneParent(second) !== first) {
        const actual = ctx.boneParent(second);
        const hint =
          ctx.boneParent(first) === second
            ? `the order is reversed: use [${q(second)}, ${q(first)}] (parent first)`
            : `${q(second)}'s parent is ${actual === undefined ? 'none' : q(actual)}; two-bone IK needs [parent, child] where the child's "parent" is the first bone`;
        ctx.sink.error('ik-not-chain', [...at, 'bones', 1], `${q(second)} is not a direct child of ${q(first)}`, hint);
      }
    }

    checkIkOptions(ctx, i);

    if (!targetOk) return;
    if (c.bones.includes(c.target)) {
      ctx.sink.error('ik-target-in-chain', [...at, 'target'], `IK target ${q(c.target)} is one of the chain bones`, 'use a separate target bone outside the chain (e.g. a child of the root)');
      return;
    }
    const chainBone = ctx.boneAncestors(c.target).find((b) => c.bones.includes(b));
    if (chainBone !== undefined) {
      ctx.sink.error(
        'ik-target-in-chain',
        [...at, 'target'],
        `IK target ${q(c.target)} is a descendant of chain bone ${q(chainBone)}, so it moves with the chain it should pull`,
        'parent the target to a bone outside the chain (e.g. the root)',
      );
    }
  });
}

/** Round for messages: at most 2 decimals, no "-0". */
function px(n: number): string {
  const r = Number(n.toFixed(2));
  return String(Object.is(r, -0) ? 0 : r);
}

/** Setup-pose reach of an IK chain (sum of world segment lengths, as the solver measures it); null if unknown. */
function setupReach(ctx: SemanticContext, bones: readonly string[]): number | null {
  const worlds = bones.map((b) => ctx.boneSetupWorld(b));
  if (worlds.some((w) => w === null)) return null;
  const last = bones[bones.length - 1];
  const w = worlds[worlds.length - 1]!;
  const length = ctx.model.bones[ctx.ids.bones.get(last)!].length * Math.hypot(w[0], w[1]);
  if (bones.length === 1) return length;
  const [a, b] = worlds as [NonNullable<(typeof worlds)[0]>, NonNullable<(typeof worlds)[0]>];
  return Math.hypot(b[4] - a[4], b[5] - a[5]) + length;
}

/** stretch / softness sanity (the chain itself is checked by checkIk). */
function checkIkOptions(ctx: SemanticContext, i: number): void {
  const c = ctx.model.ik[i];
  const at = ['ik', i];
  const softness = c.softness ?? 0;
  if (c.bones.length === 1) {
    if (softness > 0) {
      ctx.sink.warning(
        'ik-softness-one-bone',
        [...at, 'softness'],
        `softness has no effect on a one-bone (aim) IK constraint`,
        'remove "softness"; it eases a two-bone chain [parent, child] into full extension (one-bone IK only aims, and "stretch" scales its length)',
      );
    }
    const bone = ctx.model.bones[ctx.ids.bones.get(c.bones[0])!];
    if (c.stretch && bone.length === 0) {
      ctx.sink.warning(
        'ik-stretch-zero-length',
        [...at, 'stretch'],
        `stretch has no effect: bone ${q(bone.id)} has length 0, so there is no length to scale toward the target`,
        `give ${q(bone.id)} a "length" (the distance from its joint to its tip), or remove "stretch"`,
      );
    }
    return;
  }
  if (softness <= 0 || ctx.boneParent(c.bones[1]) !== c.bones[0]) return;
  const reach = setupReach(ctx, c.bones);
  if (reach === null || !(reach > 0) || softness < reach) return;
  ctx.sink.warning(
    'ik-softness-too-large',
    [...at, 'softness'],
    `softness ${px(softness)} px is at least the chain's reach ${px(reach)} px (setup pose), so the chain bends short of every target and never straightens before it is ${px(2 * reach)} px away`,
    `use a softness well below the reach, typically 5–15% of it (e.g. ${px(Math.max(0.5, reach * 0.1))})`,
  );
}

// ----------------------------------------------------------------------------- physics

export function checkPhysics(ctx: SemanticContext): void {
  ctx.checkDuplicateIds('physics');
  ctx.model.physics.forEach((g, i) => {
    const at = ['physics', i];
    g.inputs.forEach((input, j) => ctx.checkRef('parameters', input.param, [...at, 'inputs', j, 'param']));
    const inputs = new Set(g.inputs.map((input) => input.param));
    g.outputs.forEach((out, j) => {
      const outAt = [...at, 'outputs', j];
      const exists = ctx.checkRef('parameters', out.param, [...outAt, 'param']);
      if (out.segment >= g.segments.length) {
        ctx.sink.error(
          'physics-bad-segment',
          [...outAt, 'segment'],
          `segment ${out.segment} does not exist: the chain has ${g.segments.length} segment(s) (0..${g.segments.length - 1})`,
          'use -1 (or omit "segment") for the last segment',
        );
      }
      if (!exists) return;
      const track = ctx.animatedParams.get(out.param);
      if (track !== undefined) {
        ctx.sink.warning(
          'physics-output-animated',
          [...outAt, 'param'],
          `physics output ${q(out.param)} is also animated (${track}); physics overwrites it every frame`,
          'animate one of the physics inputs instead, or remove the track',
        );
      }
      if (inputs.has(out.param)) {
        ctx.sink.warning(
          'physics-feedback',
          [...outAt, 'param'],
          `${q(out.param)} is both an input and an output of this physics group`,
          'feed the pendulum from a different parameter (e.g. the head angle) to avoid a feedback loop',
        );
      }
    });
  });
}

// ----------------------------------------------------------------------------- animations

export function checkAnimations(ctx: SemanticContext): void {
  ctx.checkDuplicateIds('animations');
  ctx.model.animations.forEach((a, i) => {
    const at = ['animations', i];
    const tracksByTarget = new Map<string, number>();
    a.tracks.forEach((track, j) => {
      const trackAt = [...at, 'tracks', j];
      const target = checkTarget(ctx, track.target, [...trackAt, 'target'], true);
      const key = target?.key ?? track.target;
      const prev = tracksByTarget.get(key);
      if (prev !== undefined) {
        // SPEC §6: parameter tracks blend toward their value (the later one wins); others add deltas.
        const effect =
          target?.address.kind === 'param' ? 'the later track overrides the earlier one' : 'both tracks apply and their changes add up';
        ctx.sink.warning(
          'duplicate-track',
          [...trackAt, 'target'],
          `${q(key)} is already animated by ${toPointer([...at, 'tracks', prev])} in this animation`,
          `${effect}; merge their keys into one track`,
        );
      } else {
        tracksByTarget.set(key, j);
      }
      checkTrackOffset(ctx, i, j);
      const param = target?.address.kind === 'param' ? ctx.param(target.address.id) : undefined;
      // Key time -> index of the first key at that time (also catches duplicates split by unsorted keys).
      const keyAtTime = new Map<number, number>();
      track.keys.forEach((k, n) => {
        const keyAt = [...trackAt, 'keys', n];
        const same = keyAtTime.get(k.t);
        if (same !== undefined) {
          ctx.sink.error(
            'duplicate-key-time',
            [...keyAt, 't'],
            `two keys at t=${fmtNum(k.t)}`,
            `same "t" as ${toPointer([...trackAt, 'keys', same])}; key times must be strictly increasing, so remove or move one of them`,
          );
        } else {
          keyAtTime.set(k.t, n);
          const before = n > 0 ? track.keys[n - 1].t : -Infinity;
          if (k.t < before) {
            ctx.sink.error('keys-unsorted', [...keyAt, 't'], `key time ${fmtNum(k.t)} comes after a key at t=${fmtNum(before)}`, 'sort the keys by "t" in increasing order');
          }
        }
        if (k.t > a.duration) {
          ctx.sink.warning('key-after-duration', [...keyAt, 't'], `key at t=${fmtNum(k.t)} is after the animation's duration (${a.duration})`, `extend "duration" to at least ${fmtNum(k.t)} or move the key`);
        }
        if (target) checkValue(ctx, k.v, target, [...keyAt, 'v']);
        if (param && typeof k.v === 'number' && param.min <= param.max && (k.v < param.min || k.v > param.max)) {
          ctx.sink.warning(
            'track-value-out-of-range',
            [...keyAt, 'v'],
            `${q(param.id)} value ${fmtNum(k.v)} is outside its range [${param.min}, ${param.max}] and will be clamped`,
            `use values within [${param.min}, ${param.max}]`,
          );
        }
      });
    });
    a.events?.forEach((ev, n) => {
      if (ev.t > a.duration) {
        ctx.sink.warning('event-after-duration', [...at, 'events', n, 't'], `event ${q(ev.name)} at t=${fmtNum(ev.t)} is after the animation's duration (${a.duration}) and never fires`, `extend "duration" or move the event`);
      }
    });
  });
}

/**
 * A non-looping track samples [-offset, duration - offset]; an offset that moves this window entirely
 * before the first key or after the last one leaves the track constant.
 */
function checkTrackOffset(ctx: SemanticContext, i: number, j: number): void {
  const a = ctx.model.animations[i];
  const track = a.tracks[j];
  const offset = track.offset ?? 0;
  if (offset === 0 || a.loop || track.keys.length < 2) return;
  const times = track.keys.map((k) => k.t);
  const first = Math.min(...times);
  const last = Math.max(...times);
  if (first === last) return;
  const from = -offset;
  const to = a.duration - offset;
  if (to > first && from < last) return;
  ctx.sink.warning(
    'track-offset-no-effect',
    ['animations', i, 'tracks', j, 'offset'],
    `offset ${fmtNum(offset)} makes this track sample t = ${fmtNum(from)}..${fmtNum(to)} s, entirely ${to <= first ? 'before its first key' : 'after its last key'} (keys ${fmtNum(first)}..${fmtNum(last)} s), so it holds ${to <= first ? 'the first' : 'the last'} value for the whole (non-looping) animation`,
    `use an offset between ${fmtNum(-last)} and ${fmtNum(a.duration - first)} (exclusive), or set "loop": true so the offset wraps around the duration`,
  );
}
