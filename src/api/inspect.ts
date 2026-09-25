/**
 * Numeric inspection: one pose (InspectResult), a time series of poses, a compact track table
 * (chosen columns per time) and posed positions of setup-space points.
 */
import type { Model, Pose } from '../core/types.js';
import type { Rig } from '../core/rig.js';
import { parseAddress, suggest } from '../core/address.js';
import type { LoadedModel } from '../node/load.js';
import { ApiError, idHint, listIds, show } from './errors.js';
import { requireRig, toPoseOptions, type PoseInput } from './pose.js';
import { MAX_SAMPLE_TIMES, planSamples, samplePoses } from './sampling.js';

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r1 = (v: number) => Math.round(v * 10) / 10;

export interface InspectResult {
  time: number;
  params: Record<string, number>;
  bones: Array<{
    id: string;
    parent: string | null;
    x: number;
    y: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
    tip: [number, number];
    local: { x: number; y: number; rotation: number; scaleX: number; scaleY: number };
  }>;
  warps: Array<{ id: string; cols: number; rows: number; points: Array<[number, number]> }>;
  parts: Array<{
    id: string;
    visible: boolean;
    opacity: number;
    z: number;
    bounds: [number, number, number, number] | null;
    center: [number, number] | null;
  }>;
  drawOrder: string[];
  properties: Record<string, number | number[] | string>;
  events: Pose['events'];
  /** IK diagnostics per constraint (model order): extension = distance / maxReach (>= 1 out of reach, > 0.98 snap risk). */
  ik: Array<{
    id: string;
    bones: string[];
    target: string;
    reached: boolean;
    extension: number;
    error: number;
    distance: number;
    maxReach: number;
    bend?: number;
    stretch?: number;
  }>;
  /** Physics outputs per group (model order): raw = before clamping; empty when physics is off. */
  physics: Array<{ id: string; outputs: Array<{ param: string; raw: number; value: number; clamped: boolean; overridden: boolean }> }>;
  /** Posed positions of the requested setup-space points (only when points were requested). */
  points?: PointResult[];
}

export interface PointQuery {
  x: number;
  y: number;
  /**
   * What the point is attached to: a bone, warp or part id (a bare id is looked up among bones and
   * warps first, then parts; "bone:", "warp:" or "part:" picks the kind); null/undefined = model space
   * (does not move). A skinned part blends its skin bones with the weights the point would get as one
   * of its vertices; a part with a parent maps like that parent.
   */
  parent?: string | null;
}

export interface PointResult {
  /** The query as "x,y" or "x,y@parent". */
  spec: string;
  parent: string | null;
  setup: [number, number];
  posed: [number, number];
}

const POINT_FORMS =
  'use "x,y" (model space) or "x,y@parent" (a setup-space point attached to a bone, warp or part, e.g. "120,80@head"; a skinned part blends its skin bones like its own vertices, e.g. "40,210@arm"; write "bone:id", "warp:id" or "part:id" when ids are shared)';

const POINT_KINDS = ['bone', 'warp', 'part'] as const;

/**
 * Check a point parent the way Rig.mapPoint resolves it: "bone:id" / "warp:id" / "part:id", or a
 * bare id looked up among bones and warps first, then parts. Unknown ids and a bare id shared by a
 * bone and a warp are ApiErrors with the fix in the hint.
 */
function checkPointParent(model: Model, parent: string): void {
  const ids = { bone: model.bones.map((b) => b.id), warp: model.warps.map((w) => w.id), part: model.parts.map((p) => p.id) };
  const colon = parent.indexOf(':');
  if (colon >= 0) {
    const kind = parent.slice(0, colon);
    const id = parent.slice(colon + 1);
    if (!(POINT_KINDS as readonly string[]).includes(kind)) {
      const near = suggest(kind, [...POINT_KINDS]);
      throw new ApiError(`bad point parent "${parent}": unknown kind "${kind}"`, [], `write a bare id or prefix it with "bone:", "warp:" or "part:"${near ? ` (${near})` : ''}`);
    }
    const list = ids[kind as (typeof POINT_KINDS)[number]];
    if (!list.includes(id)) throw new ApiError(`unknown point parent "${parent}": the model has no ${kind} "${id}"`, [], idHint(id, list, `${kind}s`));
    return;
  }
  const bone = ids.bone.includes(parent);
  if (bone && ids.warp.includes(parent)) {
    throw new ApiError(`point parent "${parent}" is ambiguous: a bone and a warp share this id`, [], `write "bone:${parent}" or "warp:${parent}"`);
  }
  if (bone || ids.warp.includes(parent) || ids.part.includes(parent)) return;
  throw new ApiError(`unknown point parent "${parent}"`, [], idHint(parent, [...ids.bone, ...ids.warp, ...ids.part], 'bones, warps or parts'));
}

/** Parse "x,y" or "x,y@parent" and check the parent against the model's bones, warps and parts. */
export function parsePointSpec(model: Model, spec: string): PointQuery {
  if (typeof spec !== 'string') throw new ApiError(`a point must be a string like "120,80@head", got ${show(spec)}`, [], POINT_FORMS);
  const at = spec.indexOf('@');
  const coords = (at < 0 ? spec : spec.slice(0, at)).split(',');
  const parent = at < 0 ? null : spec.slice(at + 1).trim();
  if (coords.length !== 2) throw new ApiError(`bad point "${spec}": expected two coordinates "x,y"`, [], POINT_FORMS);
  const [x, y] = coords.map((c) => (c.trim() === '' ? NaN : Number(c)));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ApiError(`bad point "${spec}": coordinates must be finite numbers (setup-space px)`, [], POINT_FORMS);
  if (parent === '') throw new ApiError(`bad point "${spec}": nothing after "@"`, [], POINT_FORMS);
  return checkPoint(model, { x, y, parent });
}

function checkPoint(model: Model, q: PointQuery): PointQuery {
  if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) throw new ApiError(`point coordinates must be finite numbers, got ${show([q.x, q.y])}`, [], POINT_FORMS);
  const parent = q.parent ?? null;
  if (parent !== null) {
    if (typeof parent !== 'string' || parent.trim() === '') throw new ApiError(`point parent must be a bone, warp or part id, got ${show(parent)}`, [], POINT_FORMS);
    checkPointParent(model, parent);
  }
  return { x: q.x, y: q.y, parent };
}

function pointSpec(q: PointQuery): string {
  return `${q.x},${q.y}${q.parent ? `@${q.parent}` : ''}`;
}

function mapPoints(rig: Rig, pose: Pose, points: PointQuery[]): PointResult[] {
  return points.map((q) => {
    const [px, py] = rig.mapPoint(pose, q.parent ?? null, q.x, q.y);
    return { spec: pointSpec(q), parent: q.parent ?? null, setup: [q.x, q.y], posed: [r3(px), r3(py)] };
  });
}

export function summarizePose(model: Model, pose: Pose): InspectResult {
  return {
    time: pose.time,
    params: Object.fromEntries(Object.entries(pose.params).map(([k, v]) => [k, r3(v)])),
    bones: model.bones.map((b) => {
      const p = pose.bones[b.id];
      return {
        id: b.id,
        parent: b.parent ?? null,
        x: r3(p.x),
        y: r3(p.y),
        rotation: r3(p.rotation),
        scaleX: r3(p.scaleX),
        scaleY: r3(p.scaleY),
        tip: [r3(p.tip[0]), r3(p.tip[1])],
        local: { x: r3(p.local.x), y: r3(p.local.y), rotation: r3(p.local.rotation), scaleX: r3(p.local.scaleX), scaleY: r3(p.local.scaleY) },
      };
    }),
    warps: model.warps.map((w) => {
      const p = pose.warps[w.id];
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < p.points.length; i += 2) pts.push([r1(p.points[i]), r1(p.points[i + 1])]);
      return { id: w.id, cols: p.cols, rows: p.rows, points: pts };
    }),
    parts: model.parts.map((pt) => {
      const p = pose.parts[pt.id];
      const b = p.bounds ? (p.bounds.map(r1) as [number, number, number, number]) : null;
      return {
        id: pt.id,
        visible: p.visible,
        opacity: r3(p.opacity),
        z: r3(p.z),
        bounds: b,
        center: b ? [r1(b[0] + b[2] / 2), r1(b[1] + b[3] / 2)] : null,
      };
    }),
    drawOrder: pose.drawOrder,
    properties: pose.properties,
    events: pose.events,
    ik: model.ik.flatMap((k) => {
      const p = pose.ik?.[k.id];
      if (!p) return [];
      return [
        {
          id: k.id,
          bones: k.bones,
          target: k.target,
          reached: p.reached,
          extension: r3(p.extension),
          error: r3(p.error),
          distance: r3(p.distance),
          maxReach: r3(p.maxReach),
          ...(p.bend !== undefined ? { bend: r3(p.bend) } : {}),
          ...(p.stretch !== undefined ? { stretch: r3(p.stretch) } : {}),
        },
      ];
    }),
    physics: model.physics.flatMap((g) => {
      const p = pose.physics?.[g.id];
      if (!p) return [];
      return [{ id: g.id, outputs: p.outputs.map((o) => ({ param: o.param, raw: r3(o.raw), value: r3(o.value), clamped: o.clamped, overridden: o.overridden })) }];
    }),
  };
}

export interface InspectInput extends PoseInput {
  /** Setup-space points to map through the pose: "x,y", "x,y@parent" or {x, y, parent}. */
  points?: Array<string | PointQuery>;
}

function toPoints(model: Model, points: InspectInput['points']): PointQuery[] {
  if (points === undefined) return [];
  if (!Array.isArray(points)) throw new ApiError(`points must be a list, got ${show(points)}`, [], POINT_FORMS);
  return points.map((p) => (typeof p === 'string' ? parsePointSpec(model, p) : p && typeof p === 'object' ? checkPoint(model, p) : parsePointSpec(model, p as never)));
}

export function inspectPose(m: LoadedModel, input: InspectInput = {}): InspectResult {
  const rig = requireRig(m);
  const points = toPoints(rig.model, input.points);
  const pose = rig.pose(toPoseOptions(rig.model, input));
  const r = summarizePose(rig.model, pose);
  if (input.points !== undefined) r.points = mapPoints(rig, pose, points);
  return r;
}

// ----------------------------------------------------------------------------- series

export interface SeriesInput extends InspectInput {
  /** Global times in seconds (>= 0). */
  times?: number[];
  /** Instead of `times`: this many frames over the first animation layer (like sequenceTimes). */
  frames?: number;
}

/** The times of a series (checked), and the poses at them. */
function evaluateSeries(m: LoadedModel, input: SeriesInput): { rig: Rig; times: number[]; poses: Pose[] } {
  const rig = requireRig(m);
  const model = rig.model;
  if (input.time !== undefined) throw new ApiError('time and a series (times / frames) are exclusive', [], 'drop time; the series gives every time');
  let times: number[];
  if (input.times !== undefined) {
    if (input.frames !== undefined) throw new ApiError('give times or frames, not both', [], 'times lists the sample times; frames spreads n frames over the first animation');
    if (!Array.isArray(input.times) || !input.times.length) throw new ApiError(`times must be a non-empty list of seconds, got ${show(input.times)}`, [], 'e.g. [0, 0.5, 1]');
    if (input.times.length > MAX_SAMPLE_TIMES) throw new ApiError(`${input.times.length} times is too many (max ${MAX_SAMPLE_TIMES})`);
    times = input.times.map((t, i) => {
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) throw new ApiError(`times[${i}] must be a finite number of seconds >= 0, got ${show(t)}`);
      return t;
    });
  } else if (input.frames !== undefined) {
    const first = input.animations?.[0];
    if (first === undefined) throw new ApiError('frames samples the first animation layer, but no animation is given', [], `add an animation, e.g. animations ["${model.animations[0]?.id ?? 'idle'}"]`);
    const id = typeof first === 'string' ? first.split(/[@,]/)[0].trim() : first.id;
    times = planSamples(model, { animation: id, frames: input.frames }).times;
  } else {
    throw new ApiError('a series needs times or frames', [], 'e.g. times [0, 0.5, 1], or frames 8 with an animation');
  }
  const base = toPoseOptions(model, { ...input, time: undefined });
  const ascending = times.every((t, i) => i === 0 || t > times[i - 1]);
  // Ascending times play like a game loop (incremental physics, crossed events); others are stateless.
  const poses = ascending ? [...samplePoses(rig, base, times)] : times.map((time) => rig.pose({ ...base, time }));
  return { rig, times, poses };
}

/**
 * One InspectResult per time. Ascending times are evaluated sequentially (one Player: incremental
 * physics; `events` = events crossed since the previous time, the first time only those exactly at it);
 * other orders statelessly.
 */
export function inspectSeries(m: LoadedModel, input: SeriesInput): { times: number[]; results: InspectResult[] } {
  const rig = requireRig(m);
  const points = toPoints(rig.model, input.points);
  const { times, poses } = evaluateSeries(m, input);
  const results = poses.map((pose) => {
    const r = summarizePose(rig.model, pose);
    if (input.points !== undefined) r.points = mapPoints(rig, pose, points);
    return r;
  });
  return { times, results };
}

// ----------------------------------------------------------------------------- track tables

export type TrackCell = number | number[] | string | boolean | null;

export interface TrackResult {
  times: number[];
  /** Column names, canonical (e.g. "bone:head", "part:mouth.center", "point:120,80@head"). */
  columns: string[];
  /** Field names of array-valued columns, e.g. {"bone:head": ["x", "y", "rotation"]}. */
  fields: Record<string, string[]>;
  /** One row per time, one cell per column (null = not present at that time). */
  rows: TrackCell[][];
}

export const TRACK_COLUMN_FORMS =
  'param:<id>, bone:<id> (world x, y, rotation), bone:<id>.tip (world x, y), bone:<id>.<x|y|rotation|scaleX|scaleY|length> (local, after bindings/animation/IK), part:<id>.<center|bounds|opacity|z|visible>, ik:<id> (extension, error) or ik:<id>.<reached|extension|error|distance|maxReach|bend|stretch>, physics:<group>.<param> (raw output), point:<x>,<y>[@parent] (parent: a bone, warp or part id; a skinned part blends its bones), or any address in the pose properties (e.g. part:mouth.shape.ry, warp:face.offsets)';

/**
 * Split a comma-separated column list. "point:x,y[@parent]" keeps its inner comma, so
 * "param:A,point:10,20@head,bone:b" is ["param:A", "point:10,20@head", "bone:b"].
 */
export function parseTrackColumns(spec: string | string[]): string[] {
  const raw = (Array.isArray(spec) ? spec : [spec]).flatMap((s) => String(s).split(','));
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i].trim();
    if (!token) continue;
    if (token.startsWith('point:') && !token.slice(6).includes(',') && i + 1 < raw.length && /^\s*-?[\d.]/.test(raw[i + 1])) {
      out.push(`${token},${raw[++i].trim()}`);
      continue;
    }
    out.push(token);
  }
  return out;
}

interface Column {
  name: string;
  fields?: string[];
  /** Property-address columns are checked against the evaluated poses. */
  property?: string;
  get(pose: Pose): TrackCell;
}

const BONE_LOCAL = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'length'] as const;
const IK_FIELDS = ['reached', 'extension', 'error', 'distance', 'maxReach', 'bend', 'stretch'] as const;

function trackError(name: string, why: string, hint?: string): ApiError {
  return new ApiError(`bad track column "${name}": ${why}`, [], hint ?? `columns: ${TRACK_COLUMN_FORMS}`);
}

function resolveColumn(rig: Rig, name: string): Column {
  const model = rig.model;
  const colon = name.indexOf(':');
  const kind = colon < 0 ? '' : name.slice(0, colon);
  const rest = colon < 0 ? name : name.slice(colon + 1);
  const dot = rest.indexOf('.');
  const id = dot < 0 ? rest : rest.slice(0, dot);
  const prop = dot < 0 ? '' : rest.slice(dot + 1);
  const known = (list: Array<{ id: string }>, noun: string) => {
    const ids = list.map((x) => x.id);
    if (!ids.includes(id)) throw trackError(name, `unknown ${noun} "${id}"`, idHint(id, ids, `${noun}s`));
  };
  switch (kind) {
    case 'param': {
      known(model.parameters, 'parameter');
      if (prop) throw trackError(name, 'a parameter column has no property', `write "param:${id}"`);
      return { name, get: (p) => r3(p.params[id]) };
    }
    case 'bone': {
      known(model.bones, 'bone');
      if (!prop) return { name, fields: ['x', 'y', 'rotation'], get: (p) => [r3(p.bones[id].x), r3(p.bones[id].y), r3(p.bones[id].rotation)] };
      if (prop === 'tip') return { name, fields: ['x', 'y'], get: (p) => [r3(p.bones[id].tip[0]), r3(p.bones[id].tip[1])] };
      if ((BONE_LOCAL as readonly string[]).includes(prop)) return { name, get: (p) => r3(p.bones[id].local[prop as (typeof BONE_LOCAL)[number]]) };
      throw trackError(name, `unknown bone property "${prop}"`, suggest(prop, ['tip', ...BONE_LOCAL]) ?? `bone columns: bone:${id}, bone:${id}.tip, bone:${id}.<${BONE_LOCAL.join('|')}>`);
    }
    case 'part': {
      known(model.parts, 'part');
      switch (prop) {
        case 'center':
          return { name, fields: ['x', 'y'], get: (p) => { const b = p.parts[id].bounds; return b ? [r1(b[0] + b[2] / 2), r1(b[1] + b[3] / 2)] : null; } };
        case 'bounds':
          return { name, fields: ['x', 'y', 'w', 'h'], get: (p) => p.parts[id].bounds?.map(r1) ?? null };
        case 'opacity':
          return { name, get: (p) => r3(p.parts[id].opacity) };
        case 'z':
          return { name, get: (p) => r3(p.parts[id].z) };
        case 'visible':
          return { name, get: (p) => p.parts[id].visible };
        case '':
          throw trackError(name, 'a part column needs a property', `e.g. part:${id}.center, part:${id}.bounds, part:${id}.opacity`);
        default:
          return propertyColumn(name);
      }
    }
    case 'ik': {
      known(model.ik, 'IK constraint');
      if (!prop) return { name, fields: ['extension', 'error'], get: (p) => (p.ik?.[id] ? [r3(p.ik[id].extension), r3(p.ik[id].error)] : null) };
      if (prop === 'mix') {
        const setup = model.ik.find((k) => k.id === id)!.mix;
        return { name, get: (p) => { const v = p.properties[name]; return typeof v === 'number' ? r3(v) : setup; } };
      }
      if (!(IK_FIELDS as readonly string[]).includes(prop)) throw trackError(name, `unknown IK field "${prop}"`, suggest(prop, [...IK_FIELDS, 'mix']) ?? `IK fields: ${IK_FIELDS.join(', ')}, mix`);
      return {
        name,
        get: (p) => {
          const v = p.ik?.[id]?.[prop as (typeof IK_FIELDS)[number]];
          return v === undefined ? null : typeof v === 'number' ? r3(v) : v;
        },
      };
    }
    case 'physics': {
      known(model.physics, 'physics group');
      const group = model.physics.find((g) => g.id === id)!;
      const params = group.outputs.map((o) => o.param);
      if (!params.includes(prop)) throw trackError(name, prop ? `physics group "${id}" has no output "${prop}"` : `name the output parameter`, `outputs of "${id}": ${params.map((q) => `physics:${id}.${q}`).join(', ')}`);
      return { name, get: (p) => { const o = p.physics?.[id]?.outputs.find((x) => x.param === prop); return o ? r3(o.raw) : null; } };
    }
    case 'point': {
      const q = parsePointSpec(model, rest);
      return { name: `point:${pointSpec(q)}`, fields: ['x', 'y'], get: (p) => rig.mapPoint(p, q.parent ?? null, q.x, q.y).map(r3) };
    }
    default: {
      try {
        parseAddress(name);
      } catch {
        throw trackError(name, kind ? `unknown column kind "${kind}"` : 'expected kind:id', suggest(kind, ['param', 'bone', 'part', 'ik', 'physics', 'point', 'warp']) ?? undefined);
      }
      return propertyColumn(name);
    }
  }
}

function propertyColumn(name: string): Column {
  return { name, property: name, get: (p) => { const v = p.properties[name]; return v === undefined ? null : typeof v === 'number' ? r3(v) : Array.isArray(v) ? v.map(r3) : v; } };
}

/**
 * A compact table: one row per time, one cell per requested column (see TRACK_COLUMN_FORMS). The times
 * are evaluated like inspectSeries. Property-address columns must exist in the evaluated poses.
 */
export function trackSeries(m: LoadedModel, input: SeriesInput & { columns: string | string[] }): TrackResult {
  const rig = requireRig(m);
  const names = parseTrackColumns(input.columns);
  if (!names.length) throw new ApiError('no track columns given', [], `columns: ${TRACK_COLUMN_FORMS}`);
  const columns = names.map((n) => resolveColumn(rig, n));
  const { times, poses } = evaluateSeries(m, input);
  for (const c of columns) {
    if (!c.property || poses.some((p) => Object.hasOwn(p.properties, c.property!))) continue;
    const keys = [...new Set(poses.flatMap((p) => Object.keys(p.properties)))];
    throw trackError(
      c.name,
      'not a special column and no animated or bound property with that address',
      suggest(c.name, keys) ?? (keys.length ? `properties in these poses: ${listIds(keys, 20)} (or ${TRACK_COLUMN_FORMS})` : `columns: ${TRACK_COLUMN_FORMS}`),
    );
  }
  const fields: Record<string, string[]> = {};
  for (const c of columns) if (c.fields) fields[c.name] = c.fields;
  return { times, columns: columns.map((c) => c.name), fields, rows: poses.map((pose) => columns.map((c) => c.get(pose))) };
}
