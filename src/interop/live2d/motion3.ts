/**
 * motion3.json <-> Rev2D animation.
 *
 * Import: Parameter curves become `param:` tracks (ids through the ParamMap), segments become keys
 * (linear -> linear, stepped -> step, inverse stepped -> a jump at the segment start, Bézier -> a
 * cubic-bezier ease normalized to the segment), PartOpacity curves become `part:<id>.opacity` tracks when
 * the target model has that part, Model EyeBlink / LipSync curves are applied to the parameters of the
 * model3 groups, UserData becomes events. Export is the reverse; see curves.ts for the exactness of
 * every ease. Everything approximated or dropped is reported.
 */
import { parseAddress, suggest } from '../../core/address.js';
import { keyTangents } from '../../core/rig/curves.js';
import type { Model } from '../../core/types.js';
import type { InteropReport, Live2dExportOptions, Live2dImportOptions } from '../types.js';
import {
  clipCurve,
  type Curve,
  curveToKeys,
  decodeSegments,
  type EaseConversion,
  encodeSegments,
  evalCurve,
  extendCurve,
  handlesAtThirds,
  JUMP,
  type KeyIn,
  keysToCurve,
  lastTime,
  lastValue,
  type Piece,
  rotateLoop,
  shiftCurve,
} from './curves.js';
import { checkStandardRange, compactLocations, LegacyIds, resolveLive2dParam, STANDARD_PARAM_MAP, toLive2dId, UnknownParams } from './params.js';
import { arrayOf, finite, fmt, IMPORTED_MOTION, isObject, type Json, modelInfo, parseJsonInput, q, Reporter, utf8Length } from './util.js';

export interface MotionImportOptions extends Live2dImportOptions {
  /** model3.json Groups by name (EyeBlink, LipSync) -> Live2D parameter ids; applies "Model" curves. */
  groups?: Record<string, string[]>;
  /** Description for the animation (default: a short note on the source). */
  description?: string;
  /** @internal parameters already range-checked in this conversion (one warning per parameter). */
  checked?: Set<string>;
}

export interface MotionExportOptions extends Live2dExportOptions {
  /** Allowed error of eases approximated by Bézier pieces, as a fraction of each segment's value change (default 0.001). */
  tolerance?: number;
  /** @internal parameters already range-checked in this conversion. */
  checked?: Set<string>;
}

interface DecodedCurve {
  index: number;
  target: string;
  id: string;
  curve: Curve;
  where: string;
}

/** motion3.json -> raw Rev2D animation. */
export function importMotion3(json: string | Json, animationId: string, opts: MotionImportOptions = {}): { animation: Json; report: InteropReport } {
  const r = new Reporter();
  const doc = parseJsonInput(json, 'motion3.json');
  const map = opts.paramMap ?? STANDARD_PARAM_MAP;
  const model = modelInfo(opts.model);
  const checked = opts.checked ?? new Set<string>();
  if (doc.Version !== 3) r.warn('live2d-version', `Version is ${JSON.stringify(doc.Version)}, expected 3`, 'Version', 'the file is read as a Cubism 3+ motion3.json');
  if (!isObject(doc.Meta)) r.warn('live2d-meta-missing', 'Meta is missing', 'Meta', 'Duration and Fps are derived from the curves (30 fps)');
  const meta: Json = isObject(doc.Meta) ? doc.Meta : {};
  if (!Array.isArray(doc.Curves)) throw new Error('motion3.json: "Curves" must be an array');
  const restricted = meta.AreBeziersRestricted === true;
  let fps = finite(meta.Fps) ?? 0;
  if (!(fps > 0)) {
    if (isObject(doc.Meta)) r.warn('live2d-fps-missing', `Meta.Fps is ${JSON.stringify(meta.Fps)}`, 'Meta.Fps', 'sampling (where needed) uses 30 fps');
    fps = 30;
  }

  // ---- decode every curve
  const decoded: DecodedCurve[] = [];
  let segmentCount = 0;
  let pointCount = 0;
  let curveFades = 0;
  let unrestrictedHandles = 0;
  let nonThirdsRestricted = 0;
  doc.Curves.forEach((raw, index) => {
    const where = `Curves[${index}]`;
    if (!isObject(raw)) {
      r.warn('live2d-curve-invalid', `curve is ${raw === null ? 'null' : typeof raw}, not an object: skipped`, where);
      return;
    }
    const target = typeof raw.Target === 'string' ? raw.Target : '';
    const id = typeof raw.Id === 'string' ? raw.Id : '';
    const label = `${where} (${target || '?'} ${id || '?'})`;
    if (!target || !id) {
      r.warn('live2d-curve-invalid', 'curve without a Target or Id string: skipped', label);
      return;
    }
    if (raw.FadeInTime !== undefined || raw.FadeOutTime !== undefined) curveFades++;
    const res = decodeSegments(raw.Segments, restricted);
    if (!res.ok) {
      r.warn('live2d-curve-invalid', `${res.error}: curve skipped`, res.at >= 0 ? `${label}.Segments[${res.at}]` : label);
      return;
    }
    segmentCount += res.curve.pieces.length;
    pointCount += 1 + res.curve.pieces.reduce((n, p) => n + (p.kind === 'bezier' ? 3 : 1), 0);
    for (const p of res.curve.pieces) {
      if (p.kind !== 'bezier') continue;
      // Handle times in files are rounded (e.g. to 3 decimals): 1 % of the segment counts as "at thirds".
      if (restricted) {
        if (!handlesAtThirds({ ...p, byTime: false }, 0.01)) nonThirdsRestricted++;
      } else if (!handlesAtThirds(p, 0.01)) unrestrictedHandles++;
    }
    decoded.push({ index, target, id, curve: res.curve, where: label });
  });
  r.count('curves', decoded.length);
  r.count('segments', segmentCount);
  r.count('points', pointCount);
  checkCurveOrder(doc.Curves, r);

  let duration = finite(meta.Duration) ?? 0;
  if (!(duration > 0)) {
    const end = Math.max(0, ...decoded.map((d) => lastTime(d.curve)));
    duration = end > 0 ? end : 1;
    r.warn('live2d-duration-missing', `Meta.Duration is ${JSON.stringify(meta.Duration)}`, 'Meta.Duration', `the animation lasts ${fmt(duration)} s (the last curve point)`);
  }
  checkMetaCounts(meta, doc.Curves.length, segmentCount, pointCount, r);
  if (nonThirdsRestricted > 0) {
    r.info(
      'live2d-bezier-restricted',
      `${nonThirdsRestricted} Bézier segment(s) have handle times away from 1/3 and 2/3 of the segment while Meta.AreBeziersRestricted is true; the Cubism SDK then evaluates Béziers over normalized time and ignores those handle times, and so does this import`,
      'Meta.AreBeziersRestricted',
    );
  }
  if (unrestrictedHandles > 0) r.count('freeBezierHandles', unrestrictedHandles);

  // ---- parameter curves
  const tracks = new Map<string, { target: string; curve: Curve; where: string }>();
  const addTrack = (target: string, curve: Curve, where: string) => tracks.set(target, { target, curve, where });
  const unknown = new UnknownParams();
  const legacy = new LegacyIds();
  for (const d of decoded.filter((c) => c.target === 'Parameter')) {
    const res = resolveLive2dParam(d.id, map, model);
    legacy.add(res, d.id);
    if (!res.ok) {
      unknown.add(d.id, res.id, `Curves[${d.index}]`, res.hint);
      r.count('droppedCurves');
      continue;
    }
    const target = `param:${res.id}`;
    if (tracks.has(target)) {
      r.warn('live2d-duplicate-curve', `a second curve drives ${q(res.id)}; the later one wins (as in the Cubism SDK)`, d.where);
    }
    if (res.param) {
      checkStandardRange(res.param, d.id, r, checked, d.where);
      checkValueRange(d.curve, res.param, r, d.where);
    }
    addTrack(target, d.curve, d.where);
  }
  unknown.report(r, 'curve(s)');

  // ---- model curves (EyeBlink / LipSync / Opacity)
  for (const d of decoded.filter((c) => c.target === 'Model')) {
    if (d.id === 'EyeBlink' || d.id === 'LipSync') {
      const ids = opts.groups?.[d.id] ?? [];
      if (!ids.length) {
        r.info(
          'live2d-model-curve-dropped',
          `Model ${d.id} curve dropped: it drives the parameters of the model3.json ${q(d.id)} group, which is not known here`,
          d.where,
          'import the model3.json that lists this motion instead (its Groups name the parameters) to apply it',
        );
        r.count('droppedCurves');
        continue;
      }
      for (const l2d of ids) {
        const res = resolveLive2dParam(l2d, map, model);
        legacy.add(res, l2d);
        if (!res.ok) {
          r.warn('live2d-unknown-parameter', `${d.id} group parameter ${q(l2d)} is not in the target model: the ${d.id} curve is not applied to it`, d.where, res.hint ? `${res.hint} (or map it with a parameter map)` : undefined);
          continue;
        }
        const target = `param:${res.id}`;
        const own = tracks.get(target);
        if (!own) {
          addTrack(target, d.curve, d.where);
          r.info('live2d-model-curve-applied', `Model ${d.id} curve applied to ${q(res.id)} (${d.id} group)`, d.where);
        } else {
          const op = d.id === 'EyeBlink' ? (a: number, b: number) => a * b : (a: number, b: number) => a + b;
          const combined = combineCurves(own.curve, d.curve, op, duration, fps);
          addTrack(target, combined, own.where);
          r.info(
            'live2d-model-curve-combined',
            `Model ${d.id} curve ${d.id === 'EyeBlink' ? 'multiplied into' : 'added to'} the curve of ${q(res.id)} (as the Cubism SDK does), sampled at ${fmt(fps)} fps into linear keys`,
            d.where,
          );
        }
      }
    } else if (d.id === 'Opacity') {
      const values = curveValues(d.curve);
      if (values.every((v) => Math.abs(v - 1) < 1e-9)) r.info('live2d-model-opacity', 'Model Opacity curve is constantly 1: nothing to import', d.where);
      else r.warn('live2d-model-opacity-dropped', 'Model Opacity curve dropped: Rev2D has no whole-model opacity', d.where, 'animate the opacity of the parts (or a parameter bound to them) instead');
      r.count('droppedCurves');
    } else {
      r.warn('live2d-curve-target-unknown', `unknown Model curve id ${q(d.id)}: dropped`, d.where);
      r.count('droppedCurves');
    }
  }
  legacy.report(r, 'Curves');

  // ---- part opacity
  const droppedParts: string[] = [];
  const droppedWhere: number[] = [];
  for (const d of decoded.filter((c) => c.target === 'PartOpacity')) {
    if (model?.parts.has(d.id)) {
      addTrack(`part:${d.id}.opacity`, d.curve, d.where);
      r.info(
        'live2d-part-opacity',
        `PartOpacity curve ${q(d.id)} imported as the opacity of the Rev2D part with the same id`,
        d.where,
        "Cubism SDK apps do not set the part's opacity from this curve directly: they keep its value under the part's id for the model's pose (pose3.json) groups",
      );
    } else {
      droppedParts.push(d.id);
      droppedWhere.push(d.index);
      r.count('droppedCurves');
    }
  }
  if (droppedParts.length) {
    const hint = model ? droppedParts.map((p) => suggest(p, model.partIds)).find(Boolean) : undefined;
    r.warn(
      'live2d-part-opacity-dropped',
      `${droppedParts.length} PartOpacity curve(s) dropped (${droppedParts.join(', ')}): ${model ? 'the target model has no parts with these ids' : 'no target model to match part ids'}`,
      compactLocations(droppedWhere.map((i) => `Curves[${i}]`)),
      `Live2D parts are groups of art meshes; a Rev2D part with the same id receives the curve as its opacity${hint ? ` (${hint})` : ''}`,
    );
  }
  for (const d of decoded.filter((c) => c.target !== 'Parameter' && c.target !== 'Model' && c.target !== 'PartOpacity')) {
    r.warn('live2d-curve-target-unknown', `unknown curve Target ${q(d.target)}: dropped`, d.where);
    r.count('droppedCurves');
  }

  // ---- curves -> keys
  const outTracks: Json[] = [];
  let trimmed = 0;
  let sampled = 0;
  let jumps = 0;
  let splitKeys = 0;
  let seam = 0;
  for (const t of tracks.values()) {
    if (lastTime(t.curve) > duration + 1e-9) trimmed++;
    const clipped = clipCurve(t.curve, 0, duration);
    const res = curveToKeys(clipped, fps);
    sampled += res.sampledSegments;
    jumps += res.jumps;
    splitKeys += res.splitKeys;
    r.count('keys', res.keys.length);
    if (Math.abs(evalCurve(clipped, 0) - lastValue(clipped)) > 1e-6) seam++;
    outTracks.push({ target: t.target, keys: res.keys.map((k) => (k.ease === undefined ? { t: k.t, v: k.v } : { t: k.t, v: k.v, ease: k.ease })) });
  }
  r.count('tracks', outTracks.length);
  if (splitKeys) r.count('splitKeys', splitKeys);
  if (trimmed) {
    r.info('live2d-curve-trimmed', `${trimmed} curve(s) have points after Meta.Duration (${fmt(duration)} s); they never play and were cut at the duration`, 'Curves');
  }
  if (sampled) {
    r.warn(
      'live2d-bezier-sampled',
      `${sampled} Bézier segment(s) have handle times outside their segment, which no easing can express: sampled at ${fmt(fps)} fps into linear keys`,
      'Curves',
      'exact at the sample times and linear in between; where such a time curve folds back (several points per time) the earliest point is used, the Cubism SDK may pick another',
    );
  }
  if (jumps) {
    r.info(
      'live2d-jump-delayed',
      `${jumps} value jump(s) (inverse stepped segments or zero-length segments) happen ${JUMP * 1000} ms after their time: Rev2D keys need distinct times`,
      'Curves',
    );
  }
  if (restricted === false && unrestrictedHandles > 0) {
    r.info('live2d-bezier-free', `${unrestrictedHandles} Bézier segment(s) with free handle times became cubic-bezier eases (exact)`, 'Meta.AreBeziersRestricted');
  }

  // ---- user data -> events
  const events: Json[] = [];
  arrayOf(doc.UserData).forEach((u, i) => {
    const where = `UserData[${i}]`;
    if (!isObject(u) || finite(u.Time) === undefined || typeof u.Value !== 'string') {
      r.warn('live2d-userdata-invalid', 'user data needs a numeric Time and a string Value: skipped', where);
      return;
    }
    const time = u.Time as number;
    if (time < 0 || time > duration + 1e-9) {
      r.warn('live2d-userdata-out-of-range', `user data at t=${fmt(time)} is outside [0, ${fmt(duration)}] and never fires: dropped`, where);
      return;
    }
    const name = u.Value.length ? u.Value : 'UserData';
    if (!u.Value.length) r.info('live2d-userdata-empty', 'empty user data Value: the event is named "UserData"', where);
    events.push({ t: time, name });
  });
  if (events.length) r.count('events', events.length);
  const udCount = finite(meta.UserDataCount);
  if (udCount !== undefined && udCount !== arrayOf(doc.UserData).length) {
    r.info('live2d-meta-count-mismatch', `Meta.UserDataCount is ${udCount} but UserData has ${arrayOf(doc.UserData).length} entries`, 'Meta.UserDataCount');
  }

  // ---- notes
  const fadeIn = finite(meta.FadeInTime);
  const fadeOut = finite(meta.FadeOutTime);
  if (fadeIn !== undefined || fadeOut !== undefined || curveFades) {
    r.info(
      'live2d-fade-ignored',
      `fade times (${[fadeIn !== undefined ? `FadeInTime ${fmt(fadeIn)} s` : '', fadeOut !== undefined ? `FadeOutTime ${fmt(fadeOut)} s` : '', curveFades ? `${curveFades} curve(s) with their own fades` : ''].filter(Boolean).join(', ')}) are not imported: Rev2D animations have no fades`,
      'Meta',
      'blend layers with weights (or compose) for cross-fades',
    );
  }
  const loop = meta.Loop === true;
  if (loop) {
    r.info(
      'live2d-loop-flag',
      'Meta.Loop is true: imported as a looping animation; the Cubism SDK does not loop a motion by this flag (the app decides, e.g. sample apps replay the Idle group and play the other groups once)',
      'Meta.Loop',
      'set "loop": false on the animation if the motion is a one-shot',
    );
  }
  if (loop && seam) {
    r.info(
      'live2d-loop-seam',
      `${seam} looping curve(s) end on a different value than they start: Rev2D jumps back at the loop point, while the Cubism SDK (MotionBehavior V2) blends back over one extra frame`,
      'Meta.Loop',
    );
  }

  if (!outTracks.length && !events.length) {
    r.warn(
      'live2d-motion-empty',
      `no curve or user data could be imported: animation ${q(animationId)} is empty`,
      'Curves',
      'the curves drive parameters or parts the target model does not have (see live2d-unknown-parameter); add them to the model or map the ids with a parameter map',
    );
  }

  const animation: Json = {
    id: animationId,
    duration,
    loop,
    tracks: outTracks,
    ...(events.length ? { events } : {}),
    description: opts.description ?? `${IMPORTED_MOTION} (${fmt(fps)} fps).`,
  };
  return { animation, report: r.report('live2d-motion3', 'import') };
}

const TARGET_ORDER: Record<string, number> = { Model: 0, Parameter: 1, PartOpacity: 2 };

/**
 * The Cubism SDK evaluates the Model curves at the start of the list, then the Parameter curves that
 * follow, then the PartOpacity curves that follow those: a curve out of that order ends its loop, and it
 * and every later curve are never evaluated. This import reads every curve, so such files play
 * differently (reported).
 */
function checkCurveOrder(curves: unknown[], r: Reporter): void {
  const rank = (c: unknown) => (isObject(c) && typeof c.Target === 'string' ? (TARGET_ORDER[c.Target] ?? -1) : -1);
  let c = 0;
  for (const want of [0, 1, 2]) while (c < curves.length && rank(curves[c]) === want) c++;
  // Invalid curves and unknown targets are reported where they are decoded.
  if (c >= curves.length || rank(curves[c]) < 0) return;
  const first = curves[c];
  const label = isObject(first) ? `${String(first.Target)} ${String(first.Id)}` : '?';
  r.warn(
    'live2d-curve-order',
    `Curves[${c}] (${label}) breaks the order Model, Parameter, PartOpacity: the Cubism SDK never evaluates it and the ${curves.length - c - 1} curve(s) after it; this import reads all ${curves.length} curves, so the motion plays differently in Cubism`,
    `Curves[${c}]`,
    'sort the curves: Model curves first, then Parameter curves, then PartOpacity curves',
  );
}

function checkMetaCounts(meta: Json, curves: number, segments: number, points: number, r: Reporter): void {
  const pairs: Array<[string, number]> = [
    ['CurveCount', curves],
    ['TotalSegmentCount', segments],
    ['TotalPointCount', points],
  ];
  for (const [key, actual] of pairs) {
    const given = finite(meta[key]);
    if (given === undefined) {
      r.info('live2d-meta-count-missing', `Meta.${key} is missing (the Curves have ${actual})`, `Meta.${key}`);
    } else if (given !== actual) {
      r.warn('live2d-meta-count-mismatch', `Meta.${key} is ${given} but the Curves have ${actual}`, `Meta.${key}`, 'the Cubism SDK sizes its buffers from Meta and may reject or misread the file; the Curves were read as they are');
    }
  }
}

function curveValues(c: Curve): number[] {
  return [c.v, ...c.pieces.map((p) => p.v1)];
}

function checkValueRange(c: Curve, p: { id: string; min: number; max: number }, r: Reporter, where: string): void {
  const values = curveValues(c);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo < p.min - 1e-9 || hi > p.max + 1e-9) {
    r.info('live2d-value-out-of-range', `values ${fmt(lo)}..${fmt(hi)} exceed the range [${fmt(p.min)}, ${fmt(p.max)}] of ${q(p.id)}; the rig clamps them`, where);
  }
}

/** op(a(t), b(t)) sampled at every point time of both curves and at `fps` over [0, duration], as linear pieces. */
function combineCurves(a: Curve, b: Curve, op: (x: number, y: number) => number, duration: number, fps: number): Curve {
  const times = new Set<number>([0, duration]);
  for (const c of [a, b]) {
    times.add(c.t);
    for (const p of c.pieces) times.add(p.t1);
  }
  const n = Math.ceil(duration * fps);
  for (let k = 1; k < n; k++) times.add((k * duration) / n);
  const ts = [...times].filter((t) => t >= 0 && t <= duration).sort((x, y) => x - y);
  const pieces: Piece[] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (t1 - t0 < 1e-9) continue;
    pieces.push({ kind: 'linear', t0, v0: op(evalCurve(a, t0), evalCurve(b, t0)), t1, v1: op(evalCurve(a, t1), evalCurve(b, t1)) });
  }
  for (let i = 1; i < pieces.length; i++) pieces[i] = { ...pieces[i], v0: pieces[i - 1].v1 };
  return pieces.length ? { t: pieces[0].t0, v: pieces[0].v0, pieces } : { t: 0, v: op(a.v, b.v), pieces: [] };
}

// ----------------------------------------------------------------------------- export

/** Rev2D animation -> motion3.json. */
export function exportMotion3(model: Model, animationId: string, opts: MotionExportOptions = {}): { motion3: Json; report: InteropReport } {
  const anim = model.animations.find((a) => a.id === animationId);
  if (!anim) {
    const hint = suggest(animationId, model.animations.map((a) => a.id));
    throw new Error(`unknown animation ${q(animationId)}${hint ? ` (${hint})` : ''}`);
  }
  const r = new Reporter();
  const map = opts.paramMap ?? STANDARD_PARAM_MAP;
  const fps = opts.fps ?? model.meta.fps ?? 30;
  const tol = opts.tolerance ?? 0.001;
  const checked = opts.checked ?? new Set<string>();
  const duration = anim.duration;
  const params = new Map(model.parameters.map((p) => [p.id, p]));
  const base = `animations.${anim.id}`;

  type OutCurve = { target: 'Parameter' | 'PartOpacity'; id: string; curve: Curve; where: string };
  const curves = new Map<string, OutCurve>();
  const exact = new Map<string, number>();
  /** Approximated eases whose error is negligible (<= 0.01 % of the track's largest change). */
  const close = new Map<string, number>();
  const partIds: string[] = [];

  anim.tracks.forEach((track, j) => {
    const where = `${base}.tracks[${j}] (${track.target})`;
    let addr;
    try {
      addr = parseAddress(track.target);
    } catch (e) {
      r.warn('live2d-track-unsupported', `track target cannot be parsed (${e instanceof Error ? e.message : String(e)}): dropped`, where);
      r.count('droppedTracks');
      return;
    }
    let target: OutCurve['target'];
    let l2dId: string;
    if (addr.kind === 'param') {
      const p = params.get(addr.id);
      l2dId = toLive2dId(addr.id, map);
      if (p) checkStandardRange({ id: p.id, min: p.min, max: p.max, default: Math.min(p.max, Math.max(p.min, p.default ?? 0)) }, l2dId, r, checked, where);
      target = 'Parameter';
    } else if (addr.kind === 'part' && addr.prop.length === 1 && addr.prop[0] === 'opacity') {
      target = 'PartOpacity';
      l2dId = addr.id;
      partIds.push(addr.id);
    } else {
      r.warn(
        'live2d-track-unsupported',
        'Live2D motions only drive parameters and part opacity: track dropped',
        where,
        'drive this property from a parameter with a binding and animate the parameter instead',
      );
      r.count('droppedTracks');
      return;
    }
    const keys = [...track.keys].sort((a, b) => a.t - b.t);
    if (keys.some((k) => typeof k.v !== 'number' || !Number.isFinite(k.v))) {
      r.warn('live2d-track-unsupported', 'track has non-numeric key values: dropped', where);
      r.count('droppedTracks');
      return;
    }
    const keyIn: KeyIn[] = keys.map((k) => ({ t: k.t, v: k.v as number, ease: k.ease }));
    const smooth = keyIn.some((k) => k.ease === 'smooth');
    const tangents = smooth ? keyTangents(keyIn.map((k) => k.t), keyIn.map((k) => k.v), anim.loop, duration) : null;
    const approximations: EaseConversion[] = [];
    const negligible = 1e-4 * Math.max(1e-9, maxDelta(keyIn));
    let curve = keysToCurve(keyIn, tangents, tol, (_i, c) => {
      if (c.exact) exact.set(c.ease, (exact.get(c.ease) ?? 0) + 1);
      else if (c.maxError <= negligible) close.set(c.ease, (close.get(c.ease) ?? 0) + 1);
      else approximations.push(c);
    });
    if (approximations.length) {
      const byEase = new Map<string, { segments: number; pieces: number; err: number }>();
      for (const a of approximations) {
        const e = byEase.get(a.ease) ?? { segments: 0, pieces: 0, err: 0 };
        e.segments++;
        e.pieces += a.pieces;
        e.err = Math.max(e.err, a.maxError);
        byEase.set(a.ease, e);
      }
      const text = [...byEase].map(([ease, e]) => `${e.segments} ${ease} segment(s) as ${e.pieces} ${ease.includes('outside') ? 'linear' : 'Bézier'} segments (max error ${fmt(e.err)})`).join(', ');
      const worst = Math.max(...[...byEase.values()].map((e) => e.err));
      // Within 10x the requested tolerance: a note; beyond (erratic eases): a warning.
      const report = worst > 10 * tol * Math.max(1e-9, maxDelta(keyIn)) ? r.warn.bind(r) : r.info.bind(r);
      report('live2d-ease-approximated', `${text}: Live2D has no such easing`, where, `tighten with a smaller tolerance (now ${tol} of each segment's change)`);
      r.count('approximatedSegments', approximations.length);
    }
    const offset = track.offset ?? 0;
    if (anim.loop) {
      curve = clipCurve(curve, 0, duration);
      curve = offset !== 0 ? rotateLoop(curve, duration, offset) : extendCurve(curve, Math.min(curve.t, duration), duration);
    } else {
      if (offset !== 0) curve = shiftCurve(curve, offset);
      curve = clipCurve(curve, 0, duration);
      // Every curve reaches Duration (as Cubism Editor exports do): a looped playback (MotionBehavior V2)
      // blends from the last point back to the first over [last point, Duration + 1/Fps], so a curve
      // ending early would drift back instead of holding its last value until the loop point.
      curve = extendCurve(curve, Math.min(curve.t, duration), duration);
    }
    if (offset !== 0) r.info('live2d-track-offset-baked', `track offset ${fmt(offset)} s baked into the curve`, where);
    const key = `${target}:${l2dId}`;
    if (curves.has(key)) {
      r.warn('live2d-duplicate-curve', `${target} ${q(l2dId)} is driven by an earlier track too: only this later track is exported (it wins in Rev2D)`, where);
    }
    curves.set(key, { target, id: l2dId, curve, where });
  });

  if (exact.size || close.size) {
    const list = (m: Map<string, number>) => [...m].map(([e, n]) => `${n} ${e}`).join(', ');
    r.info(
      'live2d-ease-exact',
      [
        exact.size ? `written as exact Bézier segments: ${list(exact)}` : '',
        close.size ? `written as Bézier segments within 0.01 % of their track's largest change: ${list(close)}` : '',
      ]
        .filter(Boolean)
        .join('; '),
      base,
    );
  }
  if (partIds.length) {
    r.info(
      'live2d-part-opacity-exported',
      `part opacity tracks exported as PartOpacity curves (${[...new Set(partIds)].join(', ')})`,
      base,
      "they take effect only if the Live2D model has parts with these ids; Cubism SDK apps use them through the model's pose (pose3.json) groups, not as the part's opacity directly",
    );
  }

  // Cubism evaluates Model curves, then Parameter curves, then PartOpacity curves (in that order).
  const ordered = [...curves.values()].sort((a, b) => (a.target === b.target ? 0 : a.target === 'Parameter' ? -1 : 1));
  let segments = 0;
  let points = 0;
  let restricted = true;
  let seam = 0;
  const outCurves = ordered.map((c) => {
    const enc = encodeSegments(c.curve, duration);
    segments += enc.segmentCount;
    points += enc.pointCount;
    if (!enc.restrictedOk) restricted = false;
    if (anim.loop && Math.abs(evalCurve(c.curve, 0) - evalCurve(c.curve, duration)) > 1e-6) seam++;
    return { Target: c.target, Id: c.id, Segments: enc.segments };
  });

  const events = [...(anim.events ?? [])].sort((a, b) => a.t - b.t);
  let withData = 0;
  const userData = events.map((e) => {
    if (e.data !== undefined) withData++;
    return { Time: e.t, Value: e.name };
  });
  if (withData) {
    r.warn('live2d-event-data-dropped', `${withData} event(s) carry "data", which motion3 user data cannot hold: only the names are exported`, `${base}.events`);
  }
  if (anim.loop) {
    r.info(
      'live2d-loop-extra-frame',
      `the Cubism SDK (MotionBehavior V2) loops a motion every Duration + 1/Fps (${fmt(duration)} + 1/${fmt(fps)} s) and blends back to the first values during that extra frame; Rev2D loops every ${fmt(duration)} s${seam ? ` (${seam} curve(s) end on a different value than they start)` : ''}`,
      base,
    );
  }
  if (!ordered.length) r.warn('live2d-motion-empty', 'no track could be exported: the motion has no curves', base);

  const motion3: Json = {
    Version: 3,
    Meta: {
      Duration: duration,
      Fps: fps,
      Loop: anim.loop,
      AreBeziersRestricted: restricted,
      CurveCount: outCurves.length,
      TotalSegmentCount: segments,
      TotalPointCount: points,
      UserDataCount: userData.length,
      TotalUserDataSize: userData.reduce((n, u) => n + utf8Length(u.Value), 0),
    },
    Curves: outCurves,
    ...(userData.length ? { UserData: userData } : {}),
  };
  r.count('curves', outCurves.length);
  r.count('segments', segments);
  r.count('points', points);
  if (userData.length) r.count('userData', userData.length);
  return { motion3, report: r.report('live2d-motion3', 'export') };
}

function maxDelta(keys: KeyIn[]): number {
  let m = 0;
  for (let i = 1; i < keys.length; i++) m = Math.max(m, Math.abs(keys[i].v - keys[i - 1].v));
  return m;
}
