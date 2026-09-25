/**
 * Animation analysis: sample an animation densely and report what an author would otherwise have to
 * find by watching it: parameter ranges actually used, physics outputs hitting their limits, IK chains
 * out of reach or close to snapping, events, the loop seam, and parts leaving the canvas.
 */
import type { Pose } from '../core/types.js';
import { diffImages } from '../render/index.js';
import type { LoadedModel } from '../node/load.js';
import { fmtNum, listIds, shareText } from './errors.js';
import { renderPose, type ViewBox } from './frame.js';
import { formatLayerLabel } from './layers.js';
import { requireRig, toPoseOptions, type PoseInput } from './pose.js';
import { planOptions, planSamples, sampleEvents, samplePoses, type SampleInput } from './sampling.js';
import { PoseStats, SNAP_EXTENSION } from './stats.js';

/** Default sampling rate of an analysis: physics runs at 60 Hz, so peaks and clamping are not missed. */
export const ANALYZE_FPS = 60;
/**
 * Seam extrapolation steps. The end of the loop is extrapolated linearly from two samples before it;
 * that misreads curvature (an ease arriving fast at its last key) as a jump by about a·h², so a tiny
 * step is used too. Physics outputs only change once per 60 Hz step, so they need the physics step.
 * Each value's jump is the smaller of the two estimates: a real discontinuity shows in both.
 */
const SEAM_STEP = 1 / 60;
const SEAM_FINE_STEP = 1e-3;
/** A seam jump is reported above this share of the parameter range. */
const SEAM_PARAM_SHARE = 0.01;
/** Bone seam tolerances (world px / degrees). */
const SEAM_PX = 0.5;
const SEAM_DEG = 0.5;
/** Longest side of the seam comparison renders. */
const SEAM_RENDER_SIDE = 256;
/** Channel delta above which a seam pixel counts as different. */
const SEAM_PIXEL_THRESHOLD = 8;

export interface AnalyzeInput extends PoseInput, Omit<SampleInput, 'animation'> {
  /** The analyzed animation; `animations` are extra layers on top of it. */
  animation: string;
  /** Compare the rendered first frame with the frame one loop later (default true). */
  pixels?: boolean;
}

export interface AnalyzeResult {
  animation: string;
  /** Labels of the extra layers ("talk(add)"). */
  layers: string[];
  duration: number;
  loop: boolean;
  /** Number of sampled frames and the sampling rate (frames per second of animation time). */
  frames: number;
  fps: number;
  /** Animation-local window [first sample, end]. */
  window: [number, number];
  /** Seconds of warm-up actually run before the window (whole cycles). */
  warmup: number;
  params: Array<{ id: string; min: number; max: number; range: [number, number]; changes: boolean }>;
  physics: Array<{
    group: string;
    param: string;
    range: [number, number];
    rawMin: number;
    rawMax: number;
    peak: number;
    peakAt: number;
    clampedFrames: number;
    clampedShare: number;
    overriddenFrames: number;
  }>;
  ik: Array<{
    id: string;
    bones: string[];
    maxExtension: number;
    maxExtensionAt: number;
    outOfReachFrames: number;
    nearStraightFrames: number;
    maxError: number;
    maxStretch: number;
  }>;
  /** Events per frame interval: `t` = the event's own time, `at` = the frame (animation-local) it falls in. */
  events: Array<{ animation: string; name: string; t: number; frame: number; at: number }>;
  /** Looping animations: differences between the end of the loop (extrapolated to t = duration) and t = 0. */
  seam: {
    ok: boolean;
    params: Array<{ id: string; start: number; end: number; jump: number }>;
    bones: Array<{ id: string; distance: number; rotation: number }>;
    /** First frame vs the frame one loop later (physics and other layers keep running). Null when skipped. */
    pixels: { differentPixels: number; ratio: number; maxDelta: number; threshold: number; scale: number } | null;
  } | null;
  /** Union of the visible bounds over all frames. */
  bounds: ViewBox | null;
  canvas: [number, number];
  /**
   * Parts extending beyond the canvas. `always`: in every frame the part is visible (a floor wider
   * than the canvas, a bust cut off at the bottom edge): intended framing, so the notes only report
   * parts that leave the canvas during the animation.
   */
  outsideCanvas: Array<{ part: string; frames: number; share: number; maxOverflow: number; at: number; always: boolean }>;
  notes: string[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const angleDelta = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

/** Sample an animation (plus layers) and summarize it. Throws ApiError on bad inputs. */
export function analyzeAnimation(m: LoadedModel, input: AnalyzeInput): AnalyzeResult {
  const rig = requireRig(m);
  const model = rig.model;
  const fps = input.fps ?? (input.frames === undefined && input.times === undefined ? ANALYZE_FPS : undefined);
  const plan = planSamples(model, { ...input, fps });
  const base = toPoseOptions(model, { ...input, time: undefined, animations: [plan.animation, ...(input.animations ?? [])] });
  const options = planOptions(base, plan);
  const layers = (base.animations ?? []).slice(1).map((l) => formatLayerLabel(l));

  const stats = new PoseStats(model, null);
  const poses: Pose[] = [];
  let i = 0;
  for (const pose of samplePoses(rig, options, plan.evalTimes)) {
    stats.add(pose, plan.times[i++]);
    poses.push(pose);
  }
  const events = sampleEvents(rig, base, plan).flatMap((list, frame) => list.map((e) => ({ animation: e.animation, name: e.name, t: e.t, frame, at: plan.times[frame] })));

  const params = stats.params().map((s) => ({ id: s.id, min: r3(s.min), max: r3(s.max), range: s.range, changes: s.max - s.min > 1e-9 }));
  const physics = stats.physics().map((s) => {
    const active = s.frames - s.overridden;
    return {
      group: s.group,
      param: s.param,
      range: s.range,
      rawMin: r3(active ? s.rawMin : 0),
      rawMax: r3(active ? s.rawMax : 0),
      peak: r3(s.peak),
      peakAt: s.peakAt,
      clampedFrames: s.clamped,
      clampedShare: r3(active ? s.clamped / active : 0),
      overriddenFrames: s.overridden,
    };
  });
  const ik = stats.ik().map((s) => ({
    id: s.id,
    bones: s.bones,
    maxExtension: r3(s.maxExtension),
    maxExtensionAt: s.maxExtensionAt,
    outOfReachFrames: s.outOfReach,
    nearStraightFrames: s.nearStraight,
    maxError: r3(s.maxError),
    maxStretch: r3(s.maxStretch),
  }));
  const n = stats.frames;
  const outsideCanvas = stats
    .parts()
    .filter((s) => s.outsideCanvas > 0)
    .map((s) => ({
      part: s.id,
      frames: s.outsideCanvas,
      share: r3(s.outsideCanvas / n),
      maxOverflow: r3(s.maxOverflow),
      at: s.maxOverflowAt,
      always: s.outsideCanvas === s.visible,
    }));

  const notes: string[] = [];
  if (plan.loop && model.physics.length && input.physics !== false && !plan.offset) {
    notes.push(`physics starts at rest at t=0, so this first cycle includes its settling (and the seam compares against the rest pose); pass warmup (--warmup ${fmtNum(Math.max(plan.duration, 10))}) to analyze the steady state`);
  }
  if (plan.offset && !model.physics.length) notes.push('warmup changes nothing here: the model has no physics');
  notes.push(...stats.ikNotes(), ...stats.physicsNotes());
  if (stats.empty) notes.push(`no part is visible in ${shareText(stats.empty, n)}`);
  const moving = outsideCanvas.filter((o) => !o.always);
  if (moving.length) {
    notes.push(`parts leave the canvas: ${listIds(moving.map((o) => `${o.part} (${shareText(o.frames, n)}, up to ${fmtNum(o.maxOverflow, 1)} px)`), 12)}; enlarge meta.width/height or keep the motion inside`);
  }

  let seam: AnalyzeResult['seam'] = null;
  if (plan.loop) {
    // Looping layers whose cycle does not fit the analyzed loop a whole number of times shift phase
    // every cycle, so the combination cannot close however the keys are set.
    for (const l of (base.animations ?? []).slice(1)) {
      const layer = typeof l === 'string' ? { id: l } : l;
      const anim = model.animations.find((a) => a.id === layer.id);
      if (!anim?.loop || layer.time !== undefined) continue;
      const ratio = plan.duration / anim.duration;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-6) {
        notes.push(
          `layer "${anim.id}" (${fmtNum(anim.duration)}s loop) does not repeat a whole number of times in "${plan.animation}" (${fmtNum(plan.duration)}s), so the parameters it drives cannot close the loop; seam jumps there are expected (make the durations divide, or analyze the layers separately)`,
        );
      }
    }
    const d = plan.duration;
    const t0 = plan.offset;
    const at = (t: number) => rig.pose({ ...options, time: t });
    const p0 = at(t0);
    // [before, just before] the loop end, per extrapolation step.
    const pairs = [SEAM_STEP, SEAM_FINE_STEP].map((h) => [at(t0 + d - 2 * h), at(t0 + d - h)] as const);
    const seamParams: Array<{ id: string; start: number; end: number; jump: number }> = [];
    for (const p of model.parameters) {
      let best: { end: number; jump: number } | null = null;
      for (const [pa, pb] of pairs) {
        const end = Math.min(p.max, Math.max(p.min, 2 * pb.params[p.id] - pa.params[p.id]));
        const jump = p0.params[p.id] - end;
        if (!best || Math.abs(jump) < Math.abs(best.jump)) best = { end, jump };
      }
      if (Math.abs(best!.jump) > Math.max(SEAM_PARAM_SHARE * (p.max - p.min), 1e-6)) seamParams.push({ id: p.id, start: r3(p0.params[p.id]), end: r3(best!.end), jump: r3(best!.jump) });
    }
    const seamBones: Array<{ id: string; distance: number; rotation: number }> = [];
    for (const b of model.bones) {
      const S = p0.bones[b.id];
      let distance = Infinity;
      let rotation = Infinity;
      for (const [pa, pb] of pairs) {
        const A = pa.bones[b.id];
        const B = pb.bones[b.id];
        const dist = Math.hypot(S.x - (2 * B.x - A.x), S.y - (2 * B.y - A.y));
        const rot = angleDelta(S.rotation, B.rotation + angleDelta(B.rotation, A.rotation));
        if (dist < distance) distance = dist;
        if (Math.abs(rot) < Math.abs(rotation)) rotation = rot;
      }
      if (distance > SEAM_PX || Math.abs(rotation) > SEAM_DEG) seamBones.push({ id: b.id, distance: r3(distance), rotation: r3(rotation) });
    }
    let pixels: NonNullable<AnalyzeResult['seam']>['pixels'] = null;
    if (input.pixels !== false) {
      const scale = Math.min(1, SEAM_RENDER_SIDE / Math.max(model.meta.width, model.meta.height));
      const render = (pose: Pose) => renderPose(m, rig, pose, { viewBox: [0, 0, model.meta.width, model.meta.height], scale, supersample: 1 }).image;
      const diff = diffImages(render(p0), render(at(t0 + d)), { threshold: SEAM_PIXEL_THRESHOLD });
      pixels = { differentPixels: diff.differentPixels, ratio: r3(diff.differentPixels / (diff.width * diff.height)), maxDelta: diff.maxDelta, threshold: SEAM_PIXEL_THRESHOLD, scale: r3(scale) };
    }
    seam = { ok: !seamParams.length && !seamBones.length && (!pixels || pixels.ratio < 0.001), params: seamParams, bones: seamBones, pixels };
    if (seamParams.length || seamBones.length) {
      const what = [
        ...seamParams.slice(0, 6).map((s) => `${s.id} ${fmtNum(s.end)} -> ${fmtNum(s.start)}`),
        ...seamBones.slice(0, 6).map((s) => `bone ${s.id} ${fmtNum(s.distance, 1)} px / ${fmtNum(s.rotation, 1)}°`),
      ];
      // Advice by cause: keyed parameters (animation keys), physics outputs (settling), bones only (bone/part tracks).
      const physicsOn = model.physics.length > 0 && input.physics !== false;
      const outputs = new Set(physicsOn ? model.physics.flatMap((g) => g.outputs.map((o) => o.param)) : []);
      const simulated = seamParams.filter((p) => outputs.has(p.id)).map((p) => p.id);
      const keyed = seamParams.filter((p) => !outputs.has(p.id)).map((p) => p.id);
      const advice: string[] = [];
      if (keyed.length) advice.push(`make the last keys of ${listIds(keyed, 6)} equal the first (or use ease "smooth")`);
      if (simulated.length) {
        advice.push(
          plan.offset
            ? `physics outputs ${listIds(simulated, 6)} have not settled into the loop after ${fmtNum(plan.offset)}s warm-up: pass a longer warmup, or raise the damping`
            : `physics outputs ${listIds(simulated, 6)} start at rest, so the first cycle cannot close (expected without warmup, see above)`,
        );
      }
      if (!seamParams.length) advice.push('make the last keys of the bone (or warp) tracks equal the first (or use ease "smooth")');
      const unseen = pixels && pixels.ratio < 0.001 ? `; the rendered frames match (${fmtNum(pixels.ratio * 100, 2)}% of pixels differ), so the jump may be invisible (e.g. a full turn of a spinning part)` : '';
      notes.push(`the loop does not close: at t=${fmtNum(d)} -> 0 ${what.join(', ')}${seamParams.length + seamBones.length > 12 ? ', ...' : ''}; ${advice.join('; ')}${unseen}`);
    } else if (pixels && pixels.ratio >= 0.001) {
      notes.push(`the frame one loop later differs from the first in ${fmtNum(pixels.ratio * 100, 1)}% of pixels (physics or layers with other durations keep moving)${plan.offset ? '' : '; pass warmup to compare in the steady state'}`);
    }
  }

  return {
    animation: plan.animation,
    layers,
    duration: plan.duration,
    loop: plan.loop,
    frames: n,
    fps: plan.fps,
    window: [plan.times[0], plan.end],
    warmup: plan.offset,
    params,
    physics,
    ik,
    events,
    seam,
    bounds: stats.unionBounds()?.map(r3) as ViewBox | null ?? null,
    canvas: [model.meta.width, model.meta.height],
    outsideCanvas,
    notes,
  };
}

/** Readable text rendering of an AnalyzeResult. */
export function formatAnalysis(r: AnalyzeResult): string {
  const out: string[] = [];
  const title = [r.animation, ...r.layers].join(' + ');
  out.push(
    `analysis of ${title} (${fmtNum(r.duration)}s${r.loop ? ' loop' : ''}): ${r.frames} frames over t=${fmtNum(r.window[0])}..${fmtNum(r.window[1])}s${r.warmup ? ` after ${fmtNum(r.warmup)}s warm-up` : ''}`,
  );
  const changing = r.params.filter((p) => p.changes);
  out.push('', 'PARAMETERS (min..max over the frames, [range])');
  for (const p of changing) {
    const limits = [p.min <= p.range[0] + 1e-9 ? 'reaches min' : '', p.max >= p.range[1] - 1e-9 ? 'reaches max' : ''].filter(Boolean).join(', ');
    out.push(`  ${p.id}  ${fmtNum(p.min)}..${fmtNum(p.max)}  [${fmtNum(p.range[0])}..${fmtNum(p.range[1])}]${limits ? `  ${limits}` : ''}`);
  }
  const constant = r.params.filter((p) => !p.changes);
  if (constant.length) out.push(`  constant: ${listIds(constant.map((p) => `${p.id}=${fmtNum(p.min)}`), 20)}`);
  if (r.physics.length) {
    out.push('', 'PHYSICS (raw output before clamping)');
    for (const p of r.physics) {
      const clamp = p.clampedFrames ? `clamped in ${shareText(p.clampedFrames, r.frames - p.overriddenFrames)}` : 'never clamped';
      out.push(`  ${p.group}: ${p.param} ${clamp}, peak raw ${fmtNum(p.peak)} at t=${fmtNum(p.peakAt)}s vs range ${fmtNum(p.range[0])}..${fmtNum(p.range[1])}${p.overriddenFrames ? ` (overridden by an explicit value in ${p.overriddenFrames} frames)` : ''}`);
    }
  }
  if (r.ik.length) {
    out.push('', `IK (extension = distance / max reach; >= 1 out of reach, > ${SNAP_EXTENSION} snap risk)`);
    for (const k of r.ik) {
      out.push(
        `  ${k.id}: max extension ${fmtNum(k.maxExtension)} at t=${fmtNum(k.maxExtensionAt)}s; out of reach in ${k.outOfReachFrames} frames; nearly straight in ${k.nearStraightFrames} frames; max error ${fmtNum(k.maxError, 2)} px${k.maxStretch > 1 ? `; stretched up to x${fmtNum(k.maxStretch)}` : ''}`,
      );
    }
  }
  if (r.events.length) {
    out.push('', 'EVENTS');
    for (const e of r.events) out.push(`  ${e.animation}:${e.name}  t=${fmtNum(e.t)}s${e.animation !== r.animation ? ` (layer time; frame at t=${fmtNum(e.at)}s)` : ''}`);
  }
  if (r.seam) {
    out.push('', `LOOP SEAM (end of the loop extrapolated to t=${fmtNum(r.duration)} vs t=0)`);
    if (!r.seam.params.length && !r.seam.bones.length) out.push('  parameters and bones close the loop');
    for (const p of r.seam.params) out.push(`  param ${p.id}: ${fmtNum(p.end)} at the end -> ${fmtNum(p.start)} at the start (jump ${fmtNum(p.jump)})`);
    for (const b of r.seam.bones) out.push(`  bone ${b.id}: jumps ${fmtNum(b.distance, 2)} px, ${fmtNum(b.rotation, 2)}°`);
    if (r.seam.pixels) out.push(`  pixels: ${fmtNum(r.seam.pixels.ratio * 100, 2)}% differ between t=0 and one loop later (threshold ${r.seam.pixels.threshold}, max delta ${r.seam.pixels.maxDelta})`);
  }
  out.push('', 'BOUNDS');
  out.push(`  visible parts over all frames: ${r.bounds ? `[${r.bounds.map((v) => fmtNum(v, 1)).join(', ')}]` : 'nothing visible'} (canvas ${r.canvas[0]}x${r.canvas[1]})`);
  for (const o of r.outsideCanvas) {
    out.push(
      o.always
        ? `  ${o.part} extends beyond the canvas in every frame (up to ${fmtNum(o.maxOverflow, 1)} px)`
        : `  ${o.part} leaves the canvas in ${shareText(o.frames, r.frames)}, up to ${fmtNum(o.maxOverflow, 1)} px at t=${fmtNum(o.at)}s`,
    );
  }
  if (r.notes.length) out.push('', 'NOTES', ...r.notes.map((n) => `  - ${n}`));
  return out.join('\n');
}
