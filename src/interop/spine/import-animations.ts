/**
 * Spine animations -> Rev2D animations.
 *
 * Spine bone timelines are RELATIVE to the setup pose (rotate: setup + value, translate: setup +
 * value, scale: setup × value); Rev2D tracks are ABSOLUTE, so every value is mapped through the bone's
 * Rev2D setup value with the coordinate flip (rotation −value, y −value, scaled translations). Curves
 * convert exactly (curves.ts). Before its first key a Spine timeline shows the setup pose, so tracks
 * whose first key is after 0 start with a stepped setup key.
 *
 * Slots: attachment timelines switch the attachment parts' opacity (step keys), color timelines
 * become tint (rgb) and opacity (alpha) tracks — or tint rgba for slots whose alpha and attachment are
 * both animated (see SlotInfo.alphaInTint). Deform timelines become absolute `shape.vertices` tracks,
 * draw order timelines stepped `z` tracks, events animation events. IK timelines animate the mix;
 * animated softness / bend direction / stretch are reproduced with variant constraints (see
 * planIkVariants). Everything Rev2D cannot express is reported.
 */
import type { Ease } from '../../core/types.js';
import { easeFn } from '../../core/easing.js';
import { bezierToEase, channelToKeys, evalSegment, percentCurveToEase, readSegmentCurve, type ChannelKey, type SegmentCurve } from './curves.js';
import { deformLength, revLocalMatrix, sourceVertices, toCanvas, type BoneInfo, type IkInfo, type IkVariant, type ImportContext, type PartInfo, type SlotInfo } from './import-context.js';
import type {
  SpineAnimation,
  SpineBoneTimelines,
  SpineColorKey,
  SpineDeformKey,
  SpineDrawOrderKey,
  SpineIkKey,
  SpineKeyBase,
  SpineSequenceKey,
  SpineSkeletonJson,
  SpineSlotTimelines,
  SpineValueKey,
  SpineXYKey,
} from './types.js';
import { translateOnlyMix, type TransformBake } from './import-transform.js';
import { spineLocalMatrix, svd2Near, type Svd2 } from './transform.js';
import { clean, fmt, parseSpineColor, toCssColor } from './util.js';

export type RawKey = { t: number; v: unknown; ease?: Ease };
interface Track {
  target: string;
  keys: RawKey[];
}

/**
 * Seconds. A switch at time T is sampled at T − MIN_KEY_GAP and T; grid samples closer than half of
 * it to another sample are dropped (keys must stay distinct after rounding to 4 decimals).
 */
export const MIN_KEY_GAP = 1e-3;
/** Baked translate-only constraints: refine samples until linear interpolation is this close (canvas px). */
const BAKE_REFINE_PX = 0.05;
const BAKE_MIN_DT = 2 / 480;
/** Sampling rate for things that cannot be converted exactly (blended IK variants, mixed color curves). */
export const SAMPLE_FPS = 30;
/** Largest color error (0..1 per channel) accepted when one ease is shared by several channels. */
const COLOR_EASE_TOLERANCE = 1.5 / 255;
/** Codes of timelines of constraints that are not converted (spelled out, so a code from a report can be searched for). */
const SKIPPED_TIMELINE = {
  transform: 'spine-timeline-transform',
  path: 'spine-timeline-path',
  physics: 'spine-timeline-physics',
} as const;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function time(k: { time?: number }): number {
  return num(k.time, 0);
}

function wrap180(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  else if (r > 180) r -= 360;
  return r;
}

// ----------------------------------------------------------------------------- pre-passes

/** Setup alpha of a slot straight from the JSON. */
function slotSetupAlpha(json: SpineSkeletonJson, slot: string): number {
  const s = json.slots?.find((x) => x.name === slot);
  return parseSpineColor(s?.color ?? 'ffffffff')?.[3] ?? 1;
}

/** Alpha values set by a slot's color timelines (undefined when none sets alpha). */
function alphaValues(tl: SpineSlotTimelines): number[] | undefined {
  const out: number[] = [];
  for (const k of tl.rgba ?? []) out.push(parseSpineColor(k.color)?.[3] ?? 1);
  for (const k of tl.color ?? []) out.push(parseSpineColor(k.color)?.[3] ?? 1);
  for (const k of tl.rgba2 ?? []) out.push(parseSpineColor(k.light)?.[3] ?? 1);
  for (const k of tl.twoColor ?? []) out.push(parseSpineColor(k.light)?.[3] ?? 1);
  for (const k of tl.alpha ?? []) out.push(num(k.value, 1));
  return out.length ? out : undefined;
}

/**
 * Slots for which some animation changes both the alpha and the attachment (or the image sequence
 * frame): their alpha goes into the tint so opacity can switch attachments without merging curves.
 */
export function findAlphaTintSlots(json: SpineSkeletonJson): Set<string> {
  const out = new Set<string>();
  for (const anim of Object.values(json.animations ?? {})) {
    const sequenced = new Set<string>();
    for (const slots of Object.values(anim.attachments ?? {})) {
      for (const [slot, atts] of Object.entries(slots ?? {})) if (Object.values(atts ?? {}).some((a) => a?.sequence?.length)) sequenced.add(slot);
    }
    for (const [slot, tl] of Object.entries(anim.slots ?? {})) {
      if (!tl.attachment?.length && !sequenced.has(slot)) continue;
      const setup = slotSetupAlpha(json, slot);
      if (alphaValues(tl)?.some((a) => Math.abs(a - setup) > 1e-9)) out.add(slot);
    }
  }
  return out;
}

/** Spine's sequence modes (SequenceTimeline). */
const SEQUENCE_MODES = ['hold', 'once', 'loop', 'pingpong', 'onceReverse', 'loopReverse', 'pingpongReverse'];

/**
 * Frame index a sequence timeline selects at time t (Spine's rule: from the key's index, one frame
 * per `delay` seconds in the key's mode; a key without delay reuses the previous key's), the setup
 * frame before the first key; clamped to the frames there are.
 */
export function sequenceFrameAt(keys: readonly SpineSequenceKey[] | undefined, count: number, setup: number, t: number): number {
  if (!keys?.length || t < time(keys[0])) return setup;
  let i = 0;
  let delay = num(keys[0].delay, 0);
  while (i + 1 < keys.length && time(keys[i + 1]) <= t) {
    i++;
    delay = num(keys[i].delay, delay);
  }
  const k = keys[i];
  let index = Math.floor(num(k.index, 0));
  const mode = k.mode ?? 'hold';
  if (mode !== 'hold' && delay > 0) {
    index += Math.trunc((t - time(k)) / delay + 1e-5);
    const n = count * 2 - 2;
    switch (mode) {
      case 'once':
        index = Math.min(count - 1, index);
        break;
      case 'loop':
        index %= count;
        break;
      case 'pingpong':
        index = n === 0 ? 0 : index % n;
        if (index >= count) index = n - index;
        break;
      case 'onceReverse':
        index = Math.max(count - 1 - index, 0);
        break;
      case 'loopReverse':
        index = count - 1 - (index % count);
        break;
      case 'pingpongReverse':
        index = n === 0 ? 0 : (index + count - 1) % n;
        if (index >= count) index = n - index;
        break;
    }
  }
  return Math.max(0, Math.min(count - 1, index));
}

/** Times in [from, to) where a sequence timeline can change frames: its keys and every `delay` step after an animated key. */
function sequenceChangeTimes(keys: readonly SpineSequenceKey[], to: number): number[] {
  const out: number[] = [];
  let delay = 0;
  keys.forEach((k, i) => {
    const t0 = time(k);
    delay = num(k.delay, delay);
    out.push(t0);
    if ((k.mode ?? 'hold') === 'hold' || !(delay > 0)) return;
    const end = i + 1 < keys.length ? time(keys[i + 1]) : to;
    for (let n = 1; t0 + n * delay < end - 1e-9; n++) out.push(t0 + n * delay);
  });
  return out;
}

interface IkState {
  mix: number;
  softness: number;
  bendPositive: boolean;
  stretch: boolean;
}

/**
 * IK state of a timeline key. Spine's two-bone IK never stretches while softness is on (the softened
 * target stays within reach), so stretch counts only without softness there (see softStretch).
 */
function ikKeyState(k: SpineIkKey, ik: IkInfo): IkState {
  const softness = Math.max(0, num(k.softness, 0));
  return { mix: num(k.mix, 1), softness, bendPositive: k.bendPositive ?? true, stretch: effectiveStretch(ik, k.stretch ?? false, softness) };
}

/** Whether `stretch` has an effect in Spine's solve: not for two-bone chains with softness. */
export function effectiveStretch(ik: { bones: readonly unknown[] }, stretch: boolean, softness: number): boolean {
  return stretch && !(ik.bones.length === 2 && softness > 0);
}

function variantMatches(v: IkVariant, ik: IkInfo, s: IkState): boolean {
  const twoBone = ik.bones.length === 2;
  return (
    v.stretch === s.stretch &&
    (!twoBone || (v.bendPositive === s.bendPositive && Math.abs(v.softness - s.softness) < 1e-6))
  );
}

/**
 * Rev2D animates only an IK constraint's mix. When animations change softness, bend direction or
 * stretch, every combination they use gets its own constraint (same bones and target, mix 0 in the
 * setup pose) right next to the base one, and the animations drive the mixes: the active
 * combination gets the animated mix, and a softness between two used values blends the two
 * neighbouring variants (the later one with weight f·mix, the earlier one with (1−f)·mix / (1−f·mix),
 * which is a linear blend of their solutions).
 */
/** Softness spacing of the in-between variants: at most this many px apart, or this fraction of the softness. */
const SOFT_STEP_PX = 2;
const SOFT_STEP_REL = 0.2;

/** Softness values (Spine units) strictly between lo and hi on a fixed grid from 0 (see SOFT_STEP_*). */
function softnessGrid(ik: IkInfo, lo: number, hi: number): number[] {
  const out: number[] = [];
  if (!(hi - lo > 1e-9) || !(ik.softnessFactor > 0)) return out;
  const abs = SOFT_STEP_PX / ik.softnessFactor;
  for (let v = 0; v < hi - 1e-9; v += Math.max(abs, v * SOFT_STEP_REL)) if (v > lo + 1e-9) out.push(v);
  return out;
}

export function planIkVariants(ctx: ImportContext): void {
  const softStretch = new Set<IkInfo>();
  const add = (ik: IkInfo, state: IkState) => {
    if (ik.variants.some((v) => variantMatches(v, ik, state))) return;
    ik.variants.push({
      id: '',
      softness: ik.bones.length === 2 ? state.softness : ik.softness,
      bendPositive: ik.bones.length === 2 ? state.bendPositive : ik.bendPositive,
      stretch: state.stretch,
      base: false,
    });
  };
  // Pass 1: the states the keys set. Pass 2: in-between softness values where keys interpolate it, so
  // that blending two neighbouring variants stays close to the solve with the interpolated softness
  // (the solve changes non-linearly with softness near full reach); values close to a key's are skipped
  // (two variants a hair apart would be crossed within one sample interval).
  for (const pass of [1, 2]) {
    for (const [animName, anim] of Object.entries(ctx.json.animations ?? {})) {
      for (const [name, keys] of Object.entries(anim.ik ?? {})) {
        const ik = ctx.ikByName.get(name);
        if (!ik || !Array.isArray(keys)) continue;
        keys.forEach((k, n) => {
          const s = ikKeyState(k, ik);
          if (pass === 1) {
            if (k.stretch && !s.stretch) softStretch.add(ik);
            if (k.compress) {
              ctx.report.warn('spine-ik-compress', '"compress" is not supported by Rev2D IK; ignored', `animations.${animName}.ik.${name}[${n}]`);
            }
            add(ik, s);
            return;
          }
          const prev = n > 0 ? keys[n - 1] : undefined;
          if (!prev || ik.bones.length !== 2 || prev.curve === 'stepped') return;
          const p = ikKeyState(prev, ik);
          if (p.bendPositive !== s.bendPositive || p.stretch !== s.stretch) return;
          const group = ik.variants.filter((v) => v.bendPositive === s.bendPositive && v.stretch === s.stretch).map((v) => v.softness);
          for (const soft of softnessGrid(ik, Math.min(p.softness, s.softness), Math.max(p.softness, s.softness))) {
            const gap = Math.max(SOFT_STEP_PX / ik.softnessFactor, soft * SOFT_STEP_REL) / 2;
            if (group.some((g) => Math.abs(g - soft) < gap)) continue;
            add(ik, { ...s, softness: soft });
            group.push(soft);
          }
        });
      }
    }
  }
  for (const ik of softStretch) {
    ctx.report.info(
      'spine-ik-soft-stretch',
      "animations turn on stretch together with softness; Spine's two-bone IK never stretches while softness is on (the softened target stays within reach), so those keys are imported without stretch",
      `ik "${ik.name}"`,
    );
  }
  for (const ik of ctx.ik) {
    if (ik.variants.length === 1) continue;
    const base = ik.variants[0];
    for (const v of ik.variants) {
      if (v.base) continue;
      const parts: string[] = [];
      if (v.softness !== base.softness) parts.push(`s${fmt(v.softness * ik.softnessFactor).replace('.', '_')}`);
      if (v.bendPositive !== base.bendPositive) parts.push('flip');
      if (v.stretch !== base.stretch) parts.push(v.stretch ? 'stretch' : 'nostretch');
      v.id = ctx.ikIds.allocate(`${base.id}__${parts.join('_') || 'v'}`);
    }
    ik.variants.sort((a, b) => Number(a.bendPositive) - Number(b.bendPositive) || Number(a.stretch) - Number(b.stretch) || a.softness - b.softness);
    const list = ik.variants.map((v) => `${v.id} (softness ${fmt(v.softness * ik.softnessFactor)} px${ik.bones.length === 2 ? `, bend ${v.bendPositive === base.bendPositive ? 'as setup' : 'flipped'}` : ''}${v.stretch ? ', stretch' : ''})`);
    const shown = list.length > 8 ? `${list.slice(0, 8).join('; ')}; ... (+${list.length - 8})` : list.join('; ');
    ctx.report.info(
      'spine-ik-variants',
      `animations change softness, bend direction or stretch, which Rev2D cannot animate: the constraint is split into ${ik.variants.length} variants whose mixes the animations drive: ${shown}`,
      `ik "${ik.name}"`,
      'blended softness values are sampled at 30 fps; edit the variants together (same bones and target)',
    );
  }
}

// ----------------------------------------------------------------------------- driver

/** A converted animation with its Spine source. */
export interface ConvertedAnimation {
  /** Spine animation name. */
  name: string;
  anim: SpineAnimation;
  /** Rev2D animation JSON ({id, duration, loop, tracks, events?}). */
  json: Record<string, unknown>;
}

export function convertAnimations(ctx: ImportContext): ConvertedAnimation[] {
  const out: ConvertedAnimation[] = [];
  for (const [name, anim] of Object.entries(ctx.json.animations ?? {})) {
    if (!anim || typeof anim !== 'object') continue;
    const id = ctx.animationIds.allocate(name);
    if (id !== name) ctx.report.info('spine-id-renamed', `animation "${name}" is "${id}" in Rev2D`, `animations.${name}`);
    const conv = new AnimationConverter(ctx, name, anim);
    out.push({ name, anim, json: conv.convert(id) });
  }
  return out;
}

/**
 * Value of one channel of a Spine timeline at time t with its curves (exact Béziers), or undefined
 * before the first key (Spine shows the setup value there) or without keys. `unwrap`: Spine 3.x
 * rotations take the shortest way between keys.
 */
export function evalSpineChannel<K extends SpineKeyBase>(
  keys: readonly K[] | undefined,
  get: (k: K) => number,
  channel: number,
  legacy: boolean,
  unwrap: boolean,
  t: number,
): number | undefined {
  if (!keys?.length || t < time(keys[0])) return undefined;
  const values = keys.map(get);
  if (unwrap) for (let i = 1; i < values.length; i++) values[i] = values[i - 1] + wrap180(values[i] - values[i - 1]);
  let i = 0;
  while (i + 1 < keys.length && time(keys[i + 1]) <= t) i++;
  if (i + 1 >= keys.length) return values[i];
  const t0 = time(keys[i]);
  const t1 = time(keys[i + 1]);
  const curve = readSegmentCurve(keys[i], channel, [t0, values[i], t1, values[i + 1]], legacy);
  return evalSegment(t0, values[i], curve, t1, values[i + 1], t);
}

/** Latest `time` anywhere in a Spine animation (its duration). */
function lastKeyTime(v: unknown): number {
  if (Array.isArray(v)) {
    let m = 0;
    for (const x of v) if (x && typeof x === 'object') m = Math.max(m, lastKeyTime(x));
    return m;
  }
  if (v && typeof v === 'object') {
    let m = typeof (v as { time?: unknown }).time === 'number' ? ((v as { time: number }).time) : 0;
    for (const [k, x] of Object.entries(v)) if (k !== 'vertices' && k !== 'curve' && x && typeof x === 'object') m = Math.max(m, lastKeyTime(x));
    return m;
  }
  return 0;
}

class AnimationConverter {
  readonly tracks: Track[] = [];
  readonly events: Array<Record<string, unknown>> = [];
  /** Opacity tracks of image sequence frames (ignored when deciding whether the animation loops). */
  readonly flipbook = new Set<string>();
  readonly duration: number;

  constructor(
    readonly ctx: ImportContext,
    readonly name: string,
    readonly anim: SpineAnimation,
  ) {
    this.duration = Math.max(1 / 30, lastKeyTime(anim));
  }

  private where(...path: Array<string | number>): string {
    return [`animations.${this.name}`, ...path].join('.');
  }

  convert(id: string): Record<string, unknown> {
    this.bones();
    this.bakedTransforms();
    this.slots();
    this.deforms();
    this.drawOrder();
    this.ikTimelines();
    this.otherTimelines();
    this.eventKeys();
    const ctx = this.ctx;
    ctx.report.count('tracks', this.tracks.length);
    ctx.report.count('keys', this.tracks.reduce((n, t) => n + t.keys.length, 0));
    // Spine animations have no loop flag: loop the ones that end in the pose they start with (image
    // sequence frames are flipbooks: which frame shows at the end does not count).
    const loop = this.tracks.every((tr) => this.flipbook.has(tr.target) || cyclic(tr.target, tr.keys[0].v, tr.keys[tr.keys.length - 1].v));
    if (!loop) {
      ctx.report.info(
        'spine-animation-once',
        'the animation ends in a different pose than it starts, so it is imported with "loop": false',
        `animations.${this.name}`,
        'set "loop": true on the Rev2D animation to play it as a cycle',
      );
    }
    const anim: Record<string, unknown> = { id, duration: this.duration, loop, tracks: this.tracks };
    if (this.events.length) anim.events = this.events;
    return anim;
  }

  /** Add a track unless it never leaves the setup value. */
  private add(target: string, keys: RawKey[], setup: unknown, same: (a: unknown, b: unknown) => boolean = (a, b) => a === b): void {
    if (!keys.length) return;
    if (keys.every((k) => same(k.v, setup))) return;
    this.tracks.push({ target, keys });
  }

  // --------------------------------------------------------------------------- channels

  /** Scalar channel of Spine keys: values via `get`, curve channel `ch`. */
  private channel<K extends SpineKeyBase>(keys: readonly K[], get: (k: K) => number, ch: number, unwrap = false): ChannelKey[] {
    const times = keys.map(time);
    const values = keys.map(get);
    if (unwrap) for (let i = 1; i < values.length; i++) values[i] = values[i - 1] + wrap180(values[i] - values[i - 1]);
    return keys.map((k, i) => ({
      t: times[i],
      v: values[i],
      curve: i + 1 < keys.length ? readSegmentCurve(k, ch, [times[i], values[i], times[i + 1], values[i + 1]], this.ctx.legacy) : 'linear',
    }));
  }

  /** Rev2D keys of a scalar channel through the affine map `map`, with a stepped setup key before the first key. */
  private scalarKeys(ch: ChannelKey[], map: (v: number) => number, setup: number): RawKey[] {
    const { keys, split } = channelToKeys(ch);
    if (split) this.ctx.report.count('splitCurveKeys', split);
    const out: RawKey[] = keys.map((k) => (k.ease === undefined ? { t: k.t, v: map(k.v) } : { t: k.t, v: map(k.v), ease: k.ease }));
    return withSetupStart(out, setup);
  }

  // --------------------------------------------------------------------------- bones

  private bones(): void {
    const ctx = this.ctx;
    const S = ctx.scale;
    for (const [boneName, tls] of Object.entries(this.anim.bones ?? {})) {
      const bone = ctx.boneByName.get(boneName);
      if (!bone) {
        ctx.report.warn('spine-timeline-target-missing', `bone "${boneName}" does not exist; its timelines are skipped`, this.where('bones', boneName));
        continue;
      }
      const r = bone.rev;
      const pair = bone.shearPair;
      // A shear pair: translation and (while scale and shear stay put) rotation go to the outer bone,
      // whose rotation is the Spine rotation + phi; otherwise its four values are sampled (samplePair).
      const dynamic = !!pair && pairDynamic(tls);
      const target = (prop: string) => `bone:${pair && (prop === 'x' || prop === 'y' || prop === 'rotation') ? pair.outerId : bone.id}.${prop}`;
      const near = (a: unknown, b: unknown) => Math.abs((a as number) - (b as number)) < 1e-9;
      for (const [type, keys] of Object.entries(tls)) {
        if (!Array.isArray(keys) || keys.length === 0) continue;
        const where = this.where('bones', boneName, type);
        if (pair && ['rotate', 'scale', 'scalex', 'scaley', 'shear', 'shearx', 'sheary'].includes(type) && (dynamic || type !== 'rotate')) continue;
        switch (type) {
          case 'rotate': {
            const ch = this.channel(keys as SpineValueKey[], (k) => num(k.value ?? k.angle, 0), 0, ctx.legacy);
            const offset = pair ? pair.phi : 0;
            this.add(target('rotation'), this.scalarKeys(ch, (v) => r.rotation - v + offset, r.rotation + offset), r.rotation + offset, near);
            break;
          }
          case 'translate':
          case 'translatex':
          case 'translatey': {
            // A baked transform constraint either scales the translation (exact) or samples it.
            const bake = this.bakeOf(bone);
            if (bake && this.bakeSampled(bake)) break;
            const f = bake ? 1 - bake.mix : 1;
            const xy = type === 'translate';
            if (xy || type === 'translatex') {
              const ch = this.channel(keys as Array<SpineXYKey & SpineValueKey>, (k) => num(xy ? k.x : k.value, 0), 0);
              this.add(target('x'), this.scalarKeys(ch, (v) => r.x + S * f * v, r.x), r.x, near);
            }
            if (xy || type === 'translatey') {
              const ch = this.channel(keys as Array<SpineXYKey & SpineValueKey>, (k) => num(xy ? k.y : k.value, 0), xy ? 1 : 0);
              this.add(target('y'), this.scalarKeys(ch, (v) => r.y - S * f * v, r.y), r.y, near);
            }
            break;
          }
          case 'scale':
          case 'scalex':
          case 'scaley': {
            const xy = type === 'scale';
            if (xy || type === 'scalex') {
              const ch = this.channel(keys as Array<SpineXYKey & SpineValueKey>, (k) => num(xy ? k.x : k.value, 1), 0);
              this.add(target('scaleX'), this.scalarKeys(ch, (v) => r.scaleX * v, r.scaleX), r.scaleX, near);
            }
            if (xy || type === 'scaley') {
              const ch = this.channel(keys as Array<SpineXYKey & SpineValueKey>, (k) => num(xy ? k.y : k.value, 1), xy ? 1 : 0);
              this.add(target('scaleY'), this.scalarKeys(ch, (v) => r.scaleY * v, r.scaleY), r.scaleY, near);
            }
            break;
          }
          case 'shear':
          case 'shearx':
          case 'sheary': {
            const values = (keys as Array<SpineXYKey & SpineValueKey>).flatMap((k) => (type === 'shear' ? [num(k.x, 0), num(k.y, 0)] : [num(k.value, 0)]));
            if (values.some((v) => v !== 0)) {
              ctx.report.warn('spine-timeline-shear', 'shear timeline skipped (Rev2D bones cannot shear)', where, 'replace the shear with rotation / scale keys in Spine');
            }
            break;
          }
          case 'inherit':
            // Emulated by resampling the bone's rotation / scale (import-rules.ts reports it).
            break;
          default:
            ctx.report.warn('spine-timeline-unknown', `unknown bone timeline "${type}" skipped`, where);
        }
      }
      if (dynamic) this.samplePair(bone, tls);
    }
  }

  /**
   * Shear pair whose scale or shear is animated: sample the local transform (Spine's channels, exact
   * curves) and split every sample into outer rotation, outer scale and inner rotation (continuous SVD),
   * at the key times and 30 fps, refined where linear interpolation deviates.
   */
  private samplePair(bone: BoneInfo, tl: SpineBoneTimelines): void {
    const pair = bone.shearPair!;
    const n = bone.node;
    const legacy = this.ctx.legacy;
    const linear = (t: number): [number, number, number, number] => {
      const rot = evalSpineChannel(tl.rotate, (k) => num(k.value ?? k.angle, 0), 0, legacy, legacy, t) ?? 0;
      const sx = tl.scale?.length ? evalSpineChannel(tl.scale, (k) => num(k.x, 1), 0, legacy, false, t) : evalSpineChannel(tl.scalex, (k) => num(k.value, 1), 0, legacy, false, t);
      const sy = tl.scale?.length ? evalSpineChannel(tl.scale, (k) => num(k.y, 1), 1, legacy, false, t) : evalSpineChannel(tl.scaley, (k) => num(k.value, 1), 0, legacy, false, t);
      const hx = tl.shear?.length ? evalSpineChannel(tl.shear, (k) => num(k.x, 0), 0, legacy, false, t) : evalSpineChannel(tl.shearx, (k) => num(k.value, 0), 0, legacy, false, t);
      const hy = tl.shear?.length ? evalSpineChannel(tl.shear, (k) => num(k.y, 0), 1, legacy, false, t) : evalSpineChannel(tl.sheary, (k) => num(k.value, 0), 0, legacy, false, t);
      const m = spineLocalMatrix({ x: 0, y: 0, rotation: n.rotation + rot, scaleX: n.scaleX * (sx ?? 1), scaleY: n.scaleY * (sy ?? 1), shearX: n.shearX + (hx ?? 0), shearY: n.shearY + (hy ?? 0) });
      // Spine -> Rev2D (conjugate by the y flip), then the setup correction for an inexact parent.
      return mul2(fix, [m[0], -m[1], -m[2], m[3]]);
    };
    // fix = (Rev2D setup linear) · (flipped Spine setup linear)^-1: identity when the parent is exact.
    const setupSpine = spineLocalMatrix({ x: 0, y: 0, rotation: n.rotation, scaleX: n.scaleX, scaleY: n.scaleY, shearX: n.shearX, shearY: n.shearY });
    const rev = revLocalMatrix(bone);
    const fix = mul2([rev[0], rev[1], rev[2], rev[3]], inv2([setupSpine[0], -setupSpine[1], -setupSpine[2], setupSpine[3]]));
    const setup: Svd2 = { phi: bone.rev.rotation + pair.phi, sx: pair.sx, sy: pair.sy, theta: pair.theta };
    const times: number[] = [];
    for (const keys of [tl.rotate, tl.scale, tl.scalex, tl.scaley, tl.shear, tl.shearx, tl.sheary]) {
      (keys ?? []).forEach((k, i, all) => {
        times.push(time(k));
        if (k.curve === 'stepped' && all[i + 1]) times.push(time(all[i + 1]) - MIN_KEY_GAP);
      });
    }
    const grid = sampleTimes(0, this.duration, times);
    const samples: Array<Svd2 & { t: number }> = [];
    let prev = setup;
    for (const t of grid) {
      prev = svd2Near(linear(t), prev);
      samples.push({ t, ...prev });
    }
    const out: Array<Svd2 & { t: number }> = [];
    const rec = (a: Svd2 & { t: number }, b: Svd2 & { t: number }, depth: number) => {
      if (depth > 5 || b.t - a.t < 2 / 480) return;
      const tm = (a.t + b.t) / 2;
      const m = { t: tm, ...svd2Near(linear(tm), a) };
      const off = (k: 'phi' | 'theta' | 'sx' | 'sy') => Math.abs(m[k] - (a[k] + b[k]) / 2);
      if (off('phi') <= 0.05 && off('theta') <= 0.05 && off('sx') <= 5e-4 && off('sy') <= 5e-4) return;
      rec(a, m, depth + 1);
      out.push(m);
      rec(m, b, depth + 1);
    };
    samples.forEach((s, i) => {
      if (i > 0) rec(samples[i - 1], s, 0);
      out.push(s);
    });
    const put = (target: string, get: (s: Svd2) => number, setupValue: number, tol: number) => {
      const keys = simplifyLinear(
        out.map((s) => ({ t: s.t, v: clean(get(s)) })),
        tol,
      );
      this.add(target, keys, setupValue, (a, b) => Math.abs((a as number) - (b as number)) <= tol);
    };
    put(`bone:${pair.outerId}.rotation`, (s) => s.phi, setup.phi, 0.005);
    put(`bone:${pair.outerId}.scaleX`, (s) => s.sx, setup.sx, 1e-5);
    put(`bone:${pair.outerId}.scaleY`, (s) => s.sy, setup.sy, 1e-5);
    put(`bone:${bone.id}.rotation`, (s) => s.theta, setup.theta, 0.005);
    this.ctx.report.count('sampledShearTracks');
  }

  // --------------------------------------------------------------------------- baked transform constraints

  private bakeOf(bone: { name: string }): TransformBake | undefined {
    return this.ctx.transformBakes.find((b) => b.bone.name === bone.name);
  }

  /** The bake needs sampling in this animation: its target or its mix is animated. */
  private bakeSampled(bake: TransformBake): boolean {
    const tl = this.anim.bones?.[bake.target.name];
    return (tl !== undefined && Object.values(tl).some((k) => Array.isArray(k) && k.length > 0)) || (this.anim.transform?.[bake.name]?.length ?? 0) > 0;
  }

  /** Sampled translation of bones whose transform constraint target (or mix) is animated. */
  private bakedTransforms(): void {
    const ctx = this.ctx;
    const S = ctx.scale;
    for (const bake of ctx.transformBakes) {
      if (!this.bakeSampled(bake)) continue;
      const B = this.anim.bones?.[bake.bone.name] ?? {};
      const T = this.anim.bones?.[bake.target.name] ?? {};
      const xy = (keys: Array<SpineXYKey & SpineValueKey> | undefined, field: 'x' | 'y', single: boolean, def: number) =>
        keys?.length ? this.channel(keys, (k) => num(single ? k.value : k[field], def), single || field === 'x' ? 0 : 1, false) : undefined;
      const pick = (both: Array<SpineXYKey & SpineValueKey> | undefined, one: Array<SpineXYKey & SpineValueKey> | undefined, field: 'x' | 'y', def: number) =>
        both?.length ? xy(both, field, false, def) : xy(one, field, true, def);
      const ch = {
        bx: pick(B.translate, B.translatex, 'x', 0),
        by: pick(B.translate, B.translatey, 'y', 0),
        tx: pick(T.translate, T.translatex, 'x', 0),
        ty: pick(T.translate, T.translatey, 'y', 0),
        tsx: pick(T.scale, T.scalex, 'x', 1),
        tsy: pick(T.scale, T.scaley, 'y', 1),
        thx: pick(T.shear, T.shearx, 'x', 0),
        thy: pick(T.shear, T.sheary, 'y', 0),
        tr: T.rotate?.length ? this.channel(T.rotate, (k) => num(k.value ?? k.angle, 0), 0, ctx.legacy) : undefined,
        mix: this.anim.transform?.[bake.name]?.length
          ? this.channel(this.anim.transform[bake.name] as Array<SpineKeyBase & Record<string, unknown>>, (k) => translateOnlyMix(k) ?? bake.mix, ctx.legacy ? 0 : 1)
          : undefined,
      };
      const at = (c: ChannelKey[] | undefined, t: number, before: number) => (c && t >= c[0].t ? channelValue(c, t) : before);
      // Key times, and just before stepped changes (no ramp into a step).
      const keyTimes = Object.values(ch).flatMap((c) => (c ? c.flatMap((k, i) => (k.curve === 'stepped' && c[i + 1] ? [k.t, c[i + 1].t - MIN_KEY_GAP] : [k.t])) : []));
      const ts = sampleTimes(0, this.duration, keyTimes);
      const n = bake.target.node;
      const bone = bake.bone;
      const valueAt = (t: number): { t: number; x: number; y: number } => {
        const lt = spineLocalMatrix({
          x: n.x + at(ch.tx, t, 0),
          y: n.y + at(ch.ty, t, 0),
          rotation: n.rotation + at(ch.tr, t, 0),
          scaleX: n.scaleX * at(ch.tsx, t, 1),
          scaleY: n.scaleY * at(ch.tsy, t, 1),
          shearX: n.shearX + at(ch.thx, t, 0),
          shearY: n.shearY + at(ch.thy, t, 0),
        });
        const px = lt[0] * bake.offsetX + lt[2] * bake.offsetY + lt[4];
        const py = lt[1] * bake.offsetX + lt[3] * bake.offsetY + lt[5];
        const m = at(ch.mix, t, bake.mix);
        const bx = bake.rawX + at(ch.bx, t, 0);
        const by = bake.rawY + at(ch.by, t, 0);
        return { t, x: bone.rev.x + S * (bx + m * (px - bx) - bone.node.x), y: bone.rev.y - S * (by + m * (py - by) - bone.node.y) };
      };
      // 30 fps and key times, refined where linear interpolation between samples misses the curves
      // (a fast target curve between two frames).
      const base = ts.map(valueAt);
      const samples: Array<{ t: number; x: number; y: number }> = [];
      const refine = (a: { t: number; x: number; y: number }, b: { t: number; x: number; y: number }) => {
        if (b.t - a.t < BAKE_MIN_DT) return;
        const m = valueAt((a.t + b.t) / 2);
        if (Math.abs(m.x - (a.x + b.x) / 2) <= BAKE_REFINE_PX && Math.abs(m.y - (a.y + b.y) / 2) <= BAKE_REFINE_PX) return;
        refine(a, m);
        samples.push(m);
        refine(m, b);
      };
      base.forEach((s, i) => {
        if (i > 0) refine(base[i - 1], s);
        samples.push(s);
      });
      const xs: RawKey[] = samples.map((s) => ({ t: s.t, v: s.x }));
      const ys: RawKey[] = samples.map((s) => ({ t: s.t, v: s.y }));
      const near = (a: unknown, b: unknown) => Math.abs((a as number) - (b as number)) < 1e-6;
      const id = bone.shearPair?.outerId ?? bone.id;
      this.add(`bone:${id}.x`, simplifyLinear(xs), bone.rev.x, near);
      this.add(`bone:${id}.y`, simplifyLinear(ys), bone.rev.y, near);
      ctx.report.count('sampledTransformBakes');
    }
  }

  // --------------------------------------------------------------------------- slots

  private slots(): void {
    const ctx = this.ctx;
    for (const [slotName, tls] of Object.entries(this.anim.slots ?? {})) {
      const slot = ctx.slotByName.get(slotName);
      if (!slot) {
        ctx.report.warn('spine-timeline-target-missing', `slot "${slotName}" does not exist; its timelines are skipped`, this.where('slots', slotName));
        continue;
      }
      for (const type of Object.keys(tls)) {
        if (!['attachment', 'rgba', 'rgb', 'alpha', 'rgba2', 'rgb2', 'color', 'twoColor', 'sequence'].includes(type)) {
          ctx.report.warn('spine-timeline-unknown', `unknown slot timeline "${type}" skipped`, this.where('slots', slotName, type));
        }
      }
      const color = this.slotColorChannels(slot, tls);
      this.slotAttachments(slot, tls);
      if (color) this.slotColors(slot, color);
    }
    // Slots whose image sequences are animated without other slot timelines.
    for (const slot of ctx.slots) {
      if (this.anim.slots?.[slot.name]) continue;
      if (slot.parts.some((p) => this.sequenceKeys(p)?.length)) this.slotAttachments(slot, undefined);
    }
    this.checkSequenceTimelines();
  }

  /** The sequence timeline driving an image-sequence part in this animation. */
  private sequenceKeys(p: PartInfo): SpineSequenceKey[] | undefined {
    if (!p.sequence) return undefined;
    const { skin, attachment } = p.sequence.timeline;
    const keys = this.anim.attachments?.[skin]?.[p.slot.name]?.[attachment]?.sequence;
    return keys?.length ? keys : undefined;
  }

  /** Report sequence timelines that drive no imported image sequence. */
  private checkSequenceTimelines(): void {
    const ctx = this.ctx;
    for (const [skin, slots] of Object.entries(this.anim.attachments ?? {})) {
      for (const [slotName, atts] of Object.entries(slots ?? {})) {
        for (const [att, tls] of Object.entries(atts ?? {})) {
          if (!tls?.sequence?.length) continue;
          const where = this.where('attachments', skin, slotName, att, 'sequence');
          const slot = ctx.slotByName.get(slotName);
          const driven = slot?.parts.some((p) => p.sequence && p.sequence.timeline.skin === skin && p.sequence.timeline.attachment === att);
          if (driven) continue;
          if (!ctx.skinChain.includes(skin)) ctx.report.info('spine-timeline-skin-not-imported', `sequence timeline of skin "${skin}" skipped (skin not imported)`, where);
          else ctx.report.warn('spine-timeline-target-missing', `sequence timeline for "${att}" in slot "${slotName}", which has no imported image sequence; skipped`, where);
        }
      }
    }
  }

  /** rgb / alpha channels of a slot's color timelines (unset channels = not animated). */
  private slotColorChannels(slot: SlotInfo, tls: SpineSlotTimelines): { rgb?: ChannelKey[][]; alpha?: ChannelKey[] } | null {
    const ctx = this.ctx;
    const where = (type: string) => this.where('slots', slot.name, type);
    const parse = (hex: string | undefined, fallback: number[], type: string) => {
      const c = parseSpineColor(hex);
      if (!c && hex !== undefined) ctx.report.warn('spine-color-invalid', `invalid color "${hex}"`, where(type));
      return c ?? fallback;
    };
    const setup = slot.color;
    let rgb: ChannelKey[][] | undefined;
    let alpha: ChannelKey[] | undefined;
    const rgbaFrom = (keys: SpineColorKey[], type: string, field: 'color' | 'light', hasAlpha: boolean) => {
      const colors = new Map(keys.map((k) => [k, parse(k[field], [setup[0], setup[1], setup[2], setup[3]], type)]));
      rgb = [0, 1, 2].map((c) => this.channel(keys, (k) => colors.get(k)![c], c));
      if (hasAlpha) alpha = this.channel(keys, (k) => colors.get(k)![3], 3);
    };
    if (tls.rgba?.length) rgbaFrom(tls.rgba, 'rgba', 'color', true);
    if (tls.color?.length) rgbaFrom(tls.color, 'color', 'color', true);
    if (tls.rgb?.length) rgbaFrom(tls.rgb, 'rgb', 'color', false);
    for (const [type, keys] of [['rgba2', tls.rgba2], ['rgb2', tls.rgb2], ['twoColor', tls.twoColor]] as const) {
      if (!keys?.length) continue;
      rgbaFrom(keys, type, 'light', type !== 'rgb2');
      ctx.report.warn('spine-dark-color', 'two-color tint timeline: only the light color is imported', where(type), 'bake the dark tint into the texture');
    }
    if (tls.alpha?.length) alpha = this.channel(tls.alpha, (k) => num(k.value, setup[3]), 0);
    if (!rgb && !alpha) return null;
    return { rgb, alpha };
  }

  /**
   * Which part of the slot is shown: the attachment timeline picks the attachment, the sequence
   * timelines of image sequences pick the frame. Each part gets stepped opacity keys (or, for a
   * clipping attachment, its polygon switches between the clip outline and an open polygon).
   */
  private slotAttachments(slot: SlotInfo, tls: SpineSlotTimelines | undefined): void {
    const keys = tls?.attachment ?? [];
    const sequenced = slot.parts.filter((p) => this.sequenceKeys(p));
    if (!keys.length && !sequenced.length) return;
    const known = new Set(slot.parts.map((p) => p.attachmentName));
    keys.forEach((k, n) => {
      if (k.name && !known.has(k.name)) {
        this.ctx.report.warn('spine-attachment-missing', `attachment "${k.name}" is not in the imported skin; the slot shows nothing there`, this.where('slots', slot.name, 'attachment', n));
      }
    });
    /** Attachment shown at time t (the setup attachment before the first key). */
    const shown = (t: number): string | null => {
      let name = slot.setupAttachment;
      if (keys.length && t >= time(keys[0])) for (const k of keys) if (time(k) <= t) name = k.name ?? null;
      return name;
    };
    const frameOf = (p: PartInfo, t: number) => (p.sequence ? sequenceFrameAt(this.sequenceKeys(p), p.sequence.count, p.sequence.setup, t) : 0);
    const visibleAt = (p: PartInfo, t: number) => shown(t) === p.attachmentName && (!p.sequence || frameOf(p, t) === p.sequence.index);
    const changes = new Set<number>([0, ...keys.map(time)]);
    for (const p of sequenced) for (const t of sequenceChangeTimes(this.sequenceKeys(p)!, this.duration)) changes.add(t);
    const times = [...changes].filter((t) => t <= this.duration + 1e-9).sort((a, b) => a - b);
    const setupVisible = (p: PartInfo) => slot.setupAttachment === p.attachmentName && (!p.sequence || p.sequence.index === p.sequence.setup);
    for (const p of slot.parts) {
      if (p.kind === 'clipping') {
        if (!p.clip?.toggled || !keys.length) continue;
        const clip = p.clip;
        const setup = slot.setupAttachment === p.attachmentName ? clip.real : clip.open;
        const out: RawKey[] = [];
        for (const k of keys) {
          const v = k.name === p.attachmentName ? clip.real : clip.open;
          if (out.length && out[out.length - 1].v === v) continue;
          out.push({ t: time(k), v, ease: 'step' });
        }
        this.add(`part:${p.id}.shape.points`, withSetupStart(out, setup), setup);
        continue;
      }
      const on = slot.alphaInTint ? 1 : slot.color[3] * p.color[3];
      const setup = setupVisible(p) ? on : 0;
      const out: RawKey[] = [];
      for (const t of times) {
        const v = visibleAt(p, t) ? on : 0;
        if (out.length && out[out.length - 1].v === v) continue;
        out.push({ t, v, ease: 'step' });
      }
      this.add(`part:${p.id}.opacity`, out, setup);
      if (p.sequence && this.sequenceKeys(p)) this.flipbook.add(`part:${p.id}.opacity`);
    }
    if (sequenced.length) this.ctx.report.count('sequenceTimelines');
  }

  private slotColors(slot: SlotInfo, color: { rgb?: ChannelKey[][]; alpha?: ChannelKey[] }): void {
    const setup = slot.color;
    for (const p of slot.parts) {
      if (p.kind === 'clipping') continue;
      const ac = p.color;
      if (slot.alphaInTint) {
        const constant = (v: number, like: ChannelKey[]) => like.map((k) => ({ t: k.t, v, curve: 'linear' as const }));
        const like = color.rgb?.[0] ?? color.alpha!;
        const channels = [
          color.rgb?.[0] ?? constant(setup[0], like),
          color.rgb?.[1] ?? constant(setup[1], like),
          color.rgb?.[2] ?? constant(setup[2], like),
          color.alpha ?? constant(setup[3], like),
        ];
        const tint = this.colorKeys(channels, [ac[0], ac[1], ac[2], ac[3]], slot);
        const setupTint = toCssColor([setup[0] * ac[0], setup[1] * ac[1], setup[2] * ac[2], setup[3] * ac[3]], true);
        this.add(`part:${p.id}.tint`, withSetupStart(tint, setupTint), setupTint);
        continue;
      }
      if (color.rgb) {
        const tint = this.colorKeys(color.rgb, [ac[0], ac[1], ac[2]], slot);
        const setupTint = toCssColor([setup[0] * ac[0], setup[1] * ac[1], setup[2] * ac[2], 1], false);
        this.add(`part:${p.id}.tint`, withSetupStart(tint, setupTint), setupTint);
      }
      if (color.alpha && slot.setupAttachment === p.attachmentName && (!p.sequence || p.sequence.index === p.sequence.setup)) {
        const setupOpacity = setup[3] * ac[3];
        const keys = this.scalarKeys(color.alpha, (v) => v * ac[3], setupOpacity);
        this.add(`part:${p.id}.opacity`, keys, setupOpacity, (a, b) => Math.abs((a as number) - (b as number)) < 1e-9);
      }
    }
  }

  /**
   * Color keys from 3 (rgb) or 4 (rgba) channels multiplied by `factor`. Channels of one Spine
   * timeline share key times; per-channel curves that agree become one ease, others are sampled.
   */
  private colorKeys(channels: ChannelKey[][], factor: number[], slot: SlotInfo): RawKey[] {
    const withAlpha = channels.length === 4;
    const toColor = (vals: number[]) =>
      toCssColor([vals[0] * factor[0], vals[1] * factor[1], vals[2] * factor[2], withAlpha ? vals[3] * factor[3] : 1], withAlpha);
    const times = channels[0].map((k) => k.t);
    const aligned = channels.every((ch) => ch.length === times.length && ch.every((k, i) => Math.abs(k.t - times[i]) < 1e-9));
    const out: RawKey[] = [];
    if (!aligned) {
      // Separate timelines (e.g. 4.x rgb + alpha) with different key times: sample the union.
      const all = [...new Set(channels.flatMap((ch) => ch.map((k) => k.t)))].sort((a, b) => a - b);
      const ts = sampleTimes(all[0], all[all.length - 1], all);
      for (const t of ts) out.push({ t, v: toColor(channels.map((ch) => channelValue(ch, t))) });
      this.ctx.report.info('spine-color-sampled', `color and alpha timelines with different key times were sampled at ${SAMPLE_FPS} fps`, this.where('slots', slot.name));
      return out;
    }
    let sampled = false;
    for (let i = 0; i < times.length; i++) {
      const vals = channels.map((ch) => ch[i].v);
      if (i + 1 === times.length) {
        out.push({ t: times[i], v: toColor(vals) });
        break;
      }
      const t0 = times[i];
      const t1 = times[i + 1];
      const curves = channels.map((ch) => ch[i].curve);
      const ease = sharedEase(channels, i, curves);
      if (ease !== null) {
        out.push(ease === undefined ? { t: t0, v: toColor(vals) } : { t: t0, v: toColor(vals), ease });
        continue;
      }
      // Channels ease differently: sample the segment.
      sampled = true;
      const n = Math.max(4, Math.ceil((t1 - t0) * SAMPLE_FPS));
      for (let j = 0; j < n; j++) {
        const t = t0 + ((t1 - t0) * j) / n;
        out.push({ t, v: toColor(channels.map((ch) => evalSegment(t0, ch[i].v, ch[i].curve, t1, ch[i + 1].v, t))) });
      }
    }
    if (sampled) {
      this.ctx.report.info(
        'spine-color-curve-sampled',
        'color channels with different curves were sampled (Rev2D uses one ease per color key)',
        this.where('slots', slot.name),
      );
    }
    return out;
  }

  // --------------------------------------------------------------------------- deform

  private deforms(): void {
    const ctx = this.ctx;
    const entries: Array<{ skin: string; slot: string; att: string; keys: SpineDeformKey[] }> = [];
    for (const [skin, slots] of Object.entries(this.anim.attachments ?? {})) {
      for (const [slot, atts] of Object.entries(slots ?? {})) {
        for (const [att, tls] of Object.entries(atts ?? {})) {
          if (tls?.deform?.length) entries.push({ skin, slot, att, keys: tls.deform });
          // Sequence timelines are converted with the slot's attachments (slotAttachments).
        }
      }
    }
    for (const src of [this.anim.deform, this.anim.ffd]) {
      for (const [skin, slots] of Object.entries(src ?? {})) {
        for (const [slot, atts] of Object.entries(slots ?? {})) for (const [att, keys] of Object.entries(atts ?? {})) if (keys?.length) entries.push({ skin, slot, att, keys });
      }
    }
    for (const e of entries) {
      const where = this.where('deform', e.skin, e.slot, e.att);
      const slot = ctx.slotByName.get(e.slot);
      const parts = slot?.parts.filter((p) => p.deformKey?.skin === e.skin && p.deformKey.attachment === e.att && p.source) ?? [];
      if (!parts.length) {
        if (!ctx.skinChain.includes(e.skin)) {
          ctx.report.info('spine-timeline-skin-not-imported', `deform timeline of skin "${e.skin}" skipped (skin not imported)`, where);
        } else {
          ctx.report.warn('spine-timeline-target-missing', `deform target "${e.att}" in slot "${e.slot}" was not imported; timeline skipped`, where);
        }
        continue;
      }
      for (const p of parts) this.deformTrack(p, e.keys, where);
    }
  }

  private deformTrack(p: PartInfo, keys: SpineDeformKey[], where: string): void {
    const src = p.source!;
    if (p.clip?.toggled) {
      this.ctx.report.warn('spine-clipping-deform', 'deform timeline of a clipping attachment that animations also show/hide: skipped', where);
      return;
    }
    const len = deformLength(src);
    const prop = p.kind === 'clipping' ? 'points' : 'vertices';
    const setup = toCanvas(this.ctx, p.spineVertices);
    const out: RawKey[] = [];
    let bad = false;
    keys.forEach((k, i) => {
      const deltas = new Float64Array(len);
      const off = num(k.offset, 0);
      const vals = Array.isArray(k.vertices) ? k.vertices : [];
      if (off + vals.length > len) bad = true;
      for (let j = 0; j < vals.length && off + j < len; j++) deltas[off + j] = vals[j];
      const verts = toCanvas(this.ctx, sourceVertices(src, deltas));
      const t0 = time(k);
      const next = keys[i + 1];
      if (!next) {
        out.push({ t: t0, v: verts });
        return;
      }
      const t1 = time(next);
      const ease = percentCurveToEase(t0, readSegmentCurve(k, 0, [t0, 0, t1, 1], this.ctx.legacy), t1);
      out.push(ease === undefined ? { t: t0, v: verts } : { t: t0, v: verts, ease });
    });
    if (bad) this.ctx.report.warn('spine-deform-invalid', 'deform key has more values than the attachment has vertices; extra values ignored', where);
    this.ctx.report.count('deformKeys', out.length);
    this.add(`part:${p.id}.shape.${prop}`, withSetupStart(out, setup), setup, sameNumbers);
  }

  // --------------------------------------------------------------------------- draw order

  private drawOrder(): void {
    const keys: SpineDrawOrderKey[] | undefined = this.anim.drawOrder ?? this.anim.draworder;
    if (!keys?.length) return;
    const ctx = this.ctx;
    const n = ctx.slots.length;
    // position[keyIndex][slotIndex]
    const positions = keys.map((k, i) => {
      const order = drawOrderFor(ctx, k, this.where('drawOrder', i));
      const pos = new Array<number>(n);
      order.forEach((slotIndex, p) => (pos[slotIndex] = p));
      return pos;
    });
    for (const slot of ctx.slots) {
      if (positions.every((pos) => pos[slot.index] === slot.index)) continue;
      for (const p of slot.parts) {
        const out: RawKey[] = [];
        keys.forEach((k, i) => {
          const z = positions[i][slot.index];
          if (out.length && out[out.length - 1].v === z) return;
          out.push({ t: time(k), v: z, ease: 'step' });
        });
        this.add(`part:${p.id}.z`, withSetupStart(out, slot.index), slot.index);
      }
    }
  }

  // --------------------------------------------------------------------------- IK

  private ikTimelines(): void {
    const ctx = this.ctx;
    for (const [name, keys] of Object.entries(this.anim.ik ?? {})) {
      const ik = ctx.ikByName.get(name);
      if (!ik) {
        ctx.report.warn('spine-timeline-target-missing', `IK constraint "${name}" was not imported; timeline skipped`, this.where('ik', name));
        continue;
      }
      if (!Array.isArray(keys) || !keys.length) continue;
      const states = keys.map((k) => ikKeyState(k, ik));
      const mixCh = this.channel(keys, (k) => num(k.mix, 1), 0);
      const variantOf = (s: IkState) => ik.variants.find((v) => variantMatches(v, ik, s))!;
      const first = variantOf(states[0]);
      const base = ik.variants.find((v) => v.base)!;
      const near = (a: unknown, b: unknown) => Math.abs((a as number) - (b as number)) < 1e-9;
      if (states.every((s) => variantOf(s) === first)) {
        // One variant for the whole timeline: its mix converts exactly.
        const setupMix = first.base ? ik.mix : 0;
        this.add(`ik:${first.id}.mix`, this.scalarKeys(mixCh, (v) => Math.min(1, Math.max(0, v)), setupMix), setupMix, near);
        if (!first.base) {
          const t0 = mixCh[0].t;
          const keysBase: RawKey[] = t0 > 0 ? [{ t: 0, v: ik.mix, ease: 'step' }, { t: t0, v: 0 }] : [{ t: 0, v: 0 }];
          this.add(`ik:${base.id}.mix`, keysBase, ik.mix, near);
        }
        continue;
      }
      this.sampledIk(ik, keys, states, mixCh);
    }
  }

  /** Several variants in one timeline: sample the mixes of every variant (see planIkVariants). */
  private sampledIk(ik: IkInfo, keys: SpineIkKey[], states: IkState[], mixCh: ChannelKey[]): void {
    const times = keys.map(time);
    const softCh = this.channel(keys, (k) => Math.max(0, num(k.softness, 0)), 1);
    const extra: number[] = [];
    times.forEach((t, i) => {
      if (i > 0 && t - MIN_KEY_GAP > times[i - 1]) extra.push(t - MIN_KEY_GAP);
    });
    if (times[0] > MIN_KEY_GAP) extra.push(times[0] - MIN_KEY_GAP);
    const stateAt = (t: number): IkState => {
      if (t < times[0]) return { mix: ik.mix, softness: ik.softness, bendPositive: ik.bendPositive, stretch: ik.stretch };
      let i = times.length - 1;
      while (i > 0 && times[i] > t) i--;
      const state = { ...states[i], mix: channelValue(mixCh, t), softness: channelValue(softCh, t) };
      state.stretch = effectiveStretch(ik, keys[i].stretch ?? false, state.softness);
      return state;
    };
    const ts = sampleTimes(0, this.duration, [...times, ...extra]);
    // Where the interpolated softness passes a variant's softness, sample exactly there: between two
    // samples only one pair of neighbouring variants is then blended (interpolating mixes across a
    // variant would blend several).
    // At the crossing the softness is exactly the variant's, blended with the variant it comes from;
    // MIN_KEY_GAP later it is blended with the one it goes to (the shared variant is at full mix
    // across the switch when the constraint's mix is 1).
    const values = [...new Set(ik.variants.map((v) => v.softness))];
    const forced = new Map<number, { softness: number; above: boolean }>();
    const after: number[] = [];
    for (let k = 0; k + 1 < ts.length; k++) {
      const a = stateAt(ts[k]);
      const b = stateAt(ts[k + 1]);
      if (a.bendPositive !== b.bendPositive || a.stretch !== b.stretch) continue;
      for (const v of values) {
        if ((a.softness - v) * (b.softness - v) >= 0) continue;
        let lo = ts[k];
        let hi = ts[k + 1];
        for (let n = 0; n < 40; n++) {
          const mid = (lo + hi) / 2;
          if ((stateAt(mid).softness - v) * (a.softness - v) > 0) lo = mid;
          else hi = mid;
        }
        forced.set(hi, { softness: v, above: a.softness > v });
        after.push(hi + MIN_KEY_GAP);
      }
    }
    const all = forced.size ? sampleTimes(0, this.duration, [...ts, ...forced.keys(), ...after]) : ts;
    const mixes = ik.variants.map(() => [] as RawKey[]);
    for (const t of all) {
      const f = forced.get(t);
      const m = f ? variantMixes(ik, { ...stateAt(t), softness: f.softness }, f.above) : variantMixes(ik, stateAt(t));
      m.forEach((v, j) => mixes[j].push({ t, v }));
    }
    ik.variants.forEach((v, j) => {
      const setup = v.base ? ik.mix : 0;
      this.add(`ik:${v.id}.mix`, simplifyLinear(mixes[j]), setup, (a, b) => Math.abs((a as number) - (b as number)) < 1e-6);
    });
    this.ctx.report.count('sampledIkTimelines');
  }

  // --------------------------------------------------------------------------- the rest

  private otherTimelines(): void {
    const ctx = this.ctx;
    for (const [kind, label] of [
      ['transform', 'transform constraint'],
      ['path', 'path constraint'],
      ['physics', 'physics constraint'],
    ] as const) {
      for (const name of Object.keys(this.anim[kind] ?? {})) {
        if (kind === 'transform' && ctx.transformBakes.some((b) => b.name === name)) continue;
        if (kind === 'transform' && [...ctx.transformEmulated, ...ctx.transformInactive].some((i) => ctx.json.transform?.[i]?.name === name)) continue;
        ctx.report.warn(SKIPPED_TIMELINE[kind], `${label} timeline skipped (the constraint is not supported)`, this.where(kind, name));
      }
    }
    const known = new Set(['bones', 'slots', 'ik', 'transform', 'path', 'physics', 'attachments', 'deform', 'ffd', 'drawOrder', 'draworder', 'events']);
    for (const key of Object.keys(this.anim)) {
      if (!known.has(key)) ctx.report.warn('spine-timeline-unknown', `unknown animation section "${key}" skipped`, this.where(key));
    }
  }

  private eventKeys(): void {
    const ctx = this.ctx;
    (this.anim.events ?? []).forEach((k, i) => {
      if (typeof k?.name !== 'string') return;
      const def = ctx.events[k.name];
      if (!def) ctx.report.warn('spine-event-unknown', `event "${k.name}" is not defined in the skeleton`, this.where('events', i));
      const data: Record<string, unknown> = {};
      const pick = (key: 'int' | 'float' | 'string' | 'volume' | 'balance') => {
        const v = k[key] ?? def?.[key];
        if (v !== undefined) data[key] = v;
      };
      pick('int');
      pick('float');
      pick('string');
      if (def?.audio) {
        data.audio = def.audio;
        pick('volume');
        pick('balance');
      }
      const ev: Record<string, unknown> = { t: time(k), name: k.name };
      if (Object.keys(data).length) ev.data = data;
      this.events.push(ev);
      ctx.report.count('events');
    });
  }
}

// ----------------------------------------------------------------------------- helpers

/** Whether a shear pair's scale or shear is animated (its rotation alone converts exactly). */
function pairDynamic(tl: SpineBoneTimelines): boolean {
  const ones = (keys: Array<{ x?: number; y?: number; value?: number }> | undefined, def: number) =>
    (keys ?? []).some((k) => num(k.x, def) !== def || num(k.y, def) !== def || num(k.value, def) !== def);
  return ones(tl.scale, 1) || ones(tl.scalex, 1) || ones(tl.scaley, 1) || ones(tl.shear, 0) || ones(tl.shearx, 0) || ones(tl.sheary, 0);
}

/** 2x2 linear parts in Mat2D layout [a, b, c, d]. */
function mul2(m: readonly number[], n: readonly number[]): [number, number, number, number] {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3]];
}

function inv2(m: readonly number[]): [number, number, number, number] {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
}

/** Spine shows the setup value before a timeline's first key: prepend a stepped setup key at 0. */
function withSetupStart(keys: RawKey[], setup: unknown): RawKey[] {
  if (!keys.length || keys[0].t <= 0) return keys;
  return [{ t: 0, v: setup, ease: 'step' }, ...keys];
}

/**
 * Whether a track ends (visually) where it starts: rotations within 1°, positions and vertices within
 * 1 px, scales / opacity / mixes within 0.02, colors within 4/255, z exactly. Spine keys often end a
 * cycle a hair off its start, or hold a single tiny adjustment; those still loop.
 */
function cyclic(target: string, a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    const ca = parseSpineColor(a);
    const cb = parseSpineColor(b);
    return !!ca && !!cb && ca.every((v, i) => Math.abs(v - cb[i]) <= 4 / 255 + 1e-9);
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] as number)) <= 1);
  if (typeof a !== 'number' || typeof b !== 'number') return a === b;
  const prop = target.slice(target.lastIndexOf('.') + 1);
  const tol = prop === 'rotation' || prop === 'x' || prop === 'y' || prop === 'length' ? 1 : prop === 'z' ? 0 : 0.02;
  return Math.abs(a - b) <= tol + 1e-9;
}

function sameNumbers(a: unknown, b: unknown): boolean {
  const x = a as number[];
  const y = b as number[];
  return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-6);
}

/** Value of a scalar channel at time t (setup-before-first-key is handled by callers). */
function channelValue(ch: ChannelKey[], t: number): number {
  if (t <= ch[0].t) return ch[0].v;
  for (let i = 0; i + 1 < ch.length; i++) {
    if (t < ch[i + 1].t) return evalSegment(ch[i].t, ch[i].v, ch[i].curve, ch[i + 1].t, ch[i + 1].v, t);
  }
  return ch[ch.length - 1].v;
}

/** A regular SAMPLE_FPS grid over [from, to] merged with `must` times (closer duplicates dropped). */
export function sampleTimes(from: number, to: number, must: number[]): number[] {
  const set = new Set<number>(must.filter((t) => t >= from - 1e-9 && t <= to + 1e-9));
  const n = Math.max(1, Math.round((to - from) * SAMPLE_FPS));
  for (let i = 0; i <= n; i++) set.add(from + ((to - from) * i) / n);
  const sorted = [...set].sort((a, b) => a - b);
  const mustSet = new Set(must);
  const out: number[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && t - last < MIN_KEY_GAP / 2) {
      // Keep required times over grid times.
      if (mustSet.has(t) && !mustSet.has(last)) out[out.length - 1] = t;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Drop keys that lie on the straight line between their neighbours. */
export function simplifyLinear(keys: RawKey[], tol = 1e-5): RawKey[] {
  if (keys.length <= 2) return keys;
  const out: RawKey[] = [keys[0]];
  for (let i = 1; i + 1 < keys.length; i++) {
    const a = out[out.length - 1];
    const b = keys[i];
    const c = keys[i + 1];
    const s = (b.t - a.t) / (c.t - a.t);
    const lin = (a.v as number) + s * ((c.v as number) - (a.v as number));
    if (Math.abs(lin - (b.v as number)) > tol) out.push(b);
  }
  out.push(keys[keys.length - 1]);
  return out;
}

/**
 * One ease shared by all channels of segment i, undefined for linear, or null when the channels need
 * different eases (beyond COLOR_EASE_TOLERANCE) or mix stepped with interpolated curves.
 */
function sharedEase(channels: ChannelKey[][], i: number, curves: SegmentCurve[]): Ease | undefined | null {
  if (curves.every((c) => c === 'stepped')) return 'step';
  const spans: Array<{ ease: Ease; span: number }> = [];
  for (let c = 0; c < channels.length; c++) {
    const a = channels[c][i];
    const b = channels[c][i + 1];
    const span = Math.abs(b.v - a.v);
    const curve = curves[c];
    if (curve === 'stepped') {
      if (span > 1e-9) return null;
      continue;
    }
    if (curve === 'linear') {
      if (span > 1e-9) spans.push({ ease: 'linear', span });
      continue;
    }
    const e = bezierToEase(a.t, a.v, curve, b.t, b.v);
    if (e === null) return null; // bulge on a constant channel
    if (span > 1e-9) spans.push({ ease: e, span });
  }
  if (!spans.length) return undefined;
  spans.sort((x, y) => y.span - x.span);
  const ref = easeFn(spans[0].ease);
  for (const s of spans.slice(1)) {
    const fn = easeFn(s.ease);
    for (let k = 1; k < 10; k++) {
      if (Math.abs(ref(k / 10) - fn(k / 10)) * s.span > COLOR_EASE_TOLERANCE) return null;
    }
  }
  return spans[0].ease === 'linear' ? undefined : spans[0].ease;
}

/** Order of slot indices for a draw order key (Spine semantics: listed slots move by their offset). */
function drawOrderFor(ctx: ImportContext, key: SpineDrawOrderKey, where: string): number[] {
  const n = ctx.slots.length;
  const identity = Array.from({ length: n }, (_, i) => i);
  const offsets = (key.offsets ?? [])
    .map((o) => ({ slot: ctx.slotByName.get(o.slot), offset: num(o.offset, 0), name: o.slot }))
    .filter((o) => {
      if (!o.slot) ctx.report.warn('spine-timeline-target-missing', `draw order names unknown slot "${o.name}"`, where);
      return !!o.slot;
    })
    .sort((a, b) => a.slot!.index - b.slot!.index);
  if (!offsets.length) return identity;
  const order = new Array<number>(n).fill(-1);
  const unchanged: number[] = [];
  let original = 0;
  for (const o of offsets) {
    const index = o.slot!.index;
    while (original < index) unchanged.push(original++);
    const target = original + o.offset;
    if (target < 0 || target >= n || order[target] !== -1) {
      ctx.report.warn('spine-draw-order-invalid', `offset ${o.offset} of slot "${o.name}" is out of range; draw order key ignored`, where);
      return identity;
    }
    order[target] = original++;
  }
  while (original < n) unchanged.push(original++);
  for (let i = n - 1; i >= 0; i--) if (order[i] === -1) order[i] = unchanged.pop()!;
  return order;
}

/** Mix of every variant of `ik` for an IK state (see planIkVariants). */
/**
 * Mixes of the variants for an IK state. At a softness equal to an inner variant's, `above` picks the
 * blend of that variant with the next one (else with the previous one): the side a sampled track comes
 * from, so that mixes interpolated between samples stay within one blend.
 */
function variantMixes(ik: IkInfo, s: IkState, above = false): number[] {
  const out = ik.variants.map(() => 0);
  const twoBone = ik.bones.length === 2;
  const group = ik.variants
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v.stretch === s.stretch && (!twoBone || v.bendPositive === s.bendPositive));
  if (!group.length) return out;
  const m = Math.min(1, Math.max(0, s.mix));
  if (!twoBone || group.length === 1) {
    out[group[0].i] = m;
    return out;
  }
  // Group is in array (= softness) order.
  if (s.softness <= group[0].v.softness) {
    out[group[0].i] = m;
    return out;
  }
  // At or beyond the last variant: the last blend with f = 1 (the previous variant at its limit, so a
  // track interpolated from there into the last blend stays within it).
  let j = 0;
  while (j + 2 < group.length && group[j + 1].v.softness < s.softness) j++;
  if (above && group[j + 1].v.softness === s.softness && j + 2 < group.length) j++;
  const p = group[j];
  const q = group[j + 1];
  const f = Math.min(1, (s.softness - p.v.softness) / (q.v.softness - p.v.softness));
  out[q.i] = f * m;
  const denom = 1 - f * m;
  // f·m = 1 (the later variant alone, at full mix): the earlier one is overridden; use its limit 1 so
  // that mixes interpolated between samples stay continuous.
  out[p.i] = denom > 1e-9 ? ((1 - f) * m) / denom : 1;
  return out;
}

