/**
 * follow: make a RIGID accessory (a small warp or a bone, e.g. a hat, glasses, a hair clip) follow
 * one point of a DEFORMING surface (usually a head warp turned by AngleX / AngleY), without
 * nesting it in that surface (nested, it would bend with it).
 *
 * Grid: the parameters (default: those that drive the bindings of the followed item and of its
 * ancestors up to, not including, the first ancestor the accessory already hangs from) and, per
 * parameter, every distinct keyform value of those bindings: the key grid of the followed motion.
 *
 * Per grid point the rig is posed (no animations, no physics, every other parameter at its
 * default; any existing follow binding being replaced left out) and the anchor `at` is mapped
 * through the followed item with Rig.mapPoint. The accessory then gets the rigid motion that puts
 * its own copy of the anchor exactly there:
 *   - warp accessory: every lattice point of its current lattice L (rest + other bindings) goes
 *     through T(p) = x* + s·R(θ)·(p − q), where q is the anchor in L, x* the pre-image of the
 *     target under the accessory's parent (Newton on Rig.mapPoint of the parent; a warp parent
 *     gets a final Newton correction of the translation, since its lattice is not affine), and
 *     θ / s (only with "rotate" / "scale") the change of the vector between two probe points
 *     at ± "probe" px left and right of the anchor. Offsets = T(L) − L, one "warp:<id>.offsets"
 *     binding.
 *   - bone accessory: the bone's world matrix W becomes D·W, D the similarity that moves the
 *     anchor onto the target (rotating / scaling about it when asked); the local values follow
 *     from the parent's posed world matrix and are stored as bone x / y (/ rotation, scaleX,
 *     scaleY) bindings, as deltas on top of the setup value and any other bindings.
 * Keyforms are exact up to rounding (1e-4 px); between keyforms the motion is interpolated
 * multilinearly, like the followed binding. The message reports the largest anchor error at the
 * keyforms and at the grid midpoints, measured on the resulting rig.
 */
import { DEG, identity, invert, multiply, wrapDeg } from '../core/math.js';
import { mapThroughWarp, Rig } from '../core/rig.js';
import { WarpSchema } from '../core/schema.js';
import type { Mat2D, Pose } from '../core/types.js';
import { validateModel } from '../core/validate.js';
import { formatQuotedList, referenceHint } from '../core/validate/text.js';
import { boneTrs, decompose, setupWorld, validPoint } from './bones.js';
import type { OpContext } from './context.js';
import { bindingSignature, canonicalTarget, type Doc, findItem, idsOf, type Item, requireItem, sameParamSet, sectionItems } from './model.js';
import { checkParams, upsertBinding } from './values.js';
import { clean, describe, type Fields, fmt, fmtPoint, isObject, OpError, q } from './util.js';

type Point = [number, number];
type NodeKind = 'bone' | 'warp';

interface Node {
  kind: NodeKind;
  id: string;
}

const BONE_PROPS = ['x', 'y', 'rotation', 'scaleX', 'scaleY'] as const;
/** Most keyforms a follow binding may get (product of the axis lengths). */
const MAX_KEYFORMS = 1000;
/** Most grid midpoints measured; beyond this only cell centres are. */
const MAX_MIDPOINTS = 2000;
/** Midpoint anchor error (px) above which the message warns. */
const WARN_MIDPOINT_PX = 1;

export function opFollow(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const acc = readAccessory(doc, f);
  const followId = f.string('follow', 'id of the warp or bone to follow');
  const follow = readNode(doc, followId, 'follow');
  if (follow.id === acc.id) throw new OpError(`follow: ${label(acc)} cannot follow itself`, 'give "follow" the warp or bone the accessory sits on, e.g. "follow": "headWarp"');
  const accChain = chainFrom(doc, parentNode(doc, acc));
  const followChain = chainFrom(doc, follow);
  if (followChain.some((n) => n.id === acc.id)) {
    throw new OpError(
      `follow: ${label(follow)} hangs from ${label(acc)}, so moving the accessory would move what it follows`,
      'follow a warp or bone that is not inside the accessory',
    );
  }
  if (accChain.some((n) => n.id === follow.id)) {
    if (follow.kind === 'bone') {
      throw new OpError(
        `follow: ${label(acc)} already hangs from ${label(follow)} (through its parents), so it already moves rigidly with it`,
        'follow the deforming surface next to the accessory instead, e.g. the head warp on that bone',
      );
    }
    // Rigid again: hang it from the bone the followed warp hangs from (or from nothing).
    const bone = followChain.find((n) => n.kind === 'bone');
    throw new OpError(
      `follow: ${label(acc)} already hangs from ${label(follow)} (through its parents), so it deforms with it instead of moving rigidly`,
      `attach it next to ${q(follow.id)} instead, then follow it: {"op": "update", "kind": "${acc.kind}", "id": ${q(acc.id)}, "set": {"parent": ${bone ? q(bone.id) : 'null'}}}` +
        (bone ? ` (bone ${q(bone.id)} carries ${q(follow.id)})` : ` (${q(follow.id)} hangs from no bone)`),
    );
  }
  // The part of the followed chain the accessory does not already inherit.
  const own = followChain.slice(0, indexOfShared(followChain, accChain));
  const ownBindings = bindingsOn(doc, own);
  const allBindings = bindingsOn(doc, [...followChain, ...accChain]);

  const explicit = f.has('params');
  const params = explicit ? checkParams(doc, f) : defaultParams(doc, own, ownBindings, acc, follow);
  const axes = params.map((p) => axisOf(p, ownBindings) ?? axisOf(p, allBindings) ?? rangeAxis(doc, p));
  const total = axes.reduce((n, a) => n * a.length, 1);
  if (total > MAX_KEYFORMS) {
    throw new OpError(`follow: the grid ${gridText(params, axes)} has ${total} keyforms (limit ${MAX_KEYFORMS})`, 'pass fewer "params" (e.g. only the head-turn parameters)');
  }

  const anchor = readAnchor(doc, f, acc);
  const probe = f.optNumber('probe', 'probe distance in px for rotate / scale');
  if (probe !== undefined && !(probe > 0)) throw new OpError(`follow: "probe" must be > 0 px, got ${probe}`, 'e.g. "probe": 20');
  const rotate = f.optBoolean('rotate', 'also follow the local rotation') ?? false;
  const scale = f.optBoolean('scale', 'also follow the local scale') ?? false;
  const description = f.optString('description', 'note on the generated bindings');
  const radius = probe ?? defaultProbe(doc, acc);

  const targets = acc.kind === 'warp' ? [`warp:${acc.id}.offsets`] : ['x', 'y', ...(rotate ? ['rotation'] : []), ...(scale ? ['scaleX', 'scaleY'] : [])].map((p) => `bone:${acc.id}.${p}`);
  const rig = evaluationRig(ctx, targets, params, acc);
  const combos = gridPoints(axes);
  const solver = acc.kind === 'warp' ? warpSolver(rig, acc, anchor, radius, rotate, scale) : boneSolver(doc, rig, acc, anchor, radius, rotate, scale);

  const keys: Array<Array<{ at: number[]; value: unknown }>> = targets.map(() => []);
  let maxShift = { d: -1, at: combos[0] };
  let maxTurn = 0;
  let scales = [Infinity, -Infinity];
  for (const at of combos) {
    const pose = rig.pose({ params: paramsAt(params, at), physics: false });
    const target = (x: number, y: number) => rig.mapPoint(pose, follow.id, x, y);
    const r = solver(pose, target);
    r.values.forEach((v, i) => keys[i].push({ at, value: v }));
    if (r.shift > maxShift.d) maxShift = { d: r.shift, at };
    maxTurn = Math.max(maxTurn, Math.abs(r.theta));
    scales = [Math.min(scales[0], r.scale), Math.max(scales[1], r.scale)];
  }

  const messages = targets.map((target, i) =>
    upsertBinding(doc, { target, key: canonicalTarget(target)!, params, keys: keys[i], forceLinear: true, ...(description !== undefined ? { description } : {}) }),
  );
  const kept = keptBindings(doc, targets, params);

  // Measure on the resulting rig: keyforms, then midpoints between them.
  const check = resultRig(ctx);
  const measure = (at: number[]) => residual(check, paramsAt(params, at), acc.id, follow.id, anchor, radius, rotate, scale);
  const atKeys = worst(combos.map((at) => ({ at, ...measure(at) })));
  const mids = midpoints(axes);
  const atMids = mids.length ? worst(mids.map((at) => ({ at, ...measure(at) }))) : undefined;

  const motion = [
    `anchor shift up to ${fmt(maxShift.d)} px at ${atText(maxShift.at)}`,
    rotate ? `rotation up to ${fmt(maxTurn)}°` : '',
    scale ? `scale ${fmt(scales[0])}..${fmt(scales[1])}` : '',
  ].filter(Boolean);
  const residualText = (w: Worst) => `${fmt4(w.px)} px${rotate ? `, ${fmt(w.deg)}°` : ''}${scale ? `, scale ×${fmt4(w.ratio)}` : ''}`;
  const source = explicit ? '' : ` (params of the bindings on ${formatQuotedList(nodesWithBindings(own, ownBindings), 6)})`;
  const notes: string[] = [];
  notes.push(
    `${label(acc)} follows ${label(follow)} at ${fmtPoint(anchor[0], anchor[1])} over ${gridText(params, axes)}${source}: ${motion.join(', ')}; ` +
      `max residual ${residualText(atKeys)} at the ${combos.length} keyforms` +
      (atMids ? `, ${residualText(atMids)} at ${mids.length} grid midpoints (worst at ${atText(atMids.at)})` : ''),
  );
  if (kept.length) {
    notes.push(
      `kept ${kept.length} other binding${kept.length === 1 ? '' : 's'} on the accessory's targets (${kept.join(', ')}): the new keyforms correct on top of ${kept.length === 1 ? 'it' : 'them'} (unbind ${kept.length === 1 ? 'it' : 'them'} first to leave the motion to follow alone)`,
    );
  }
  const outside = outsideWarp(doc, follow, anchor);
  if (outside) notes.push(`WARNING: the anchor ${fmtPoint(anchor[0], anchor[1])} is ${outside}, where the motion is extrapolated from the edge cells; give "at" a point inside it (where the accessory touches the surface)`);
  if (atMids && atMids.px > WARN_MIDPOINT_PX) {
    notes.push(
      `WARNING: up to ${fmt(atMids.px)} px off between keyforms (at ${atText(atMids.at)}): the followed motion is not linear between its keys there; add in-between keyforms to the followed binding (follow reuses its grid) and run follow again`,
    );
  }
  return [...messages, ...notes].join('; ');
}

// ----------------------------------------------------------------------------- reading the op

function readAccessory(doc: Doc, f: Fields): Node {
  const warp = f.optString('warp', 'id of the accessory warp');
  const bone = f.optString('bone', 'id of the accessory bone');
  if ((warp === undefined) === (bone === undefined)) {
    throw new OpError(
      warp === undefined ? 'follow needs the accessory: "warp" (a warp id) or "bone" (a bone id)' : 'follow: give either "warp" or "bone" (the accessory), not both',
      'e.g. {"op": "follow", "warp": "hatWarp", "follow": "headWarp", "at": [256, 121]}',
    );
  }
  const kind: NodeKind = warp !== undefined ? 'warp' : 'bone';
  const id = (warp ?? bone)!;
  if (!findItem(doc, kind, id)) {
    const other: NodeKind = kind === 'warp' ? 'bone' : 'warp';
    if (findItem(doc, other, id)) throw new OpError(`follow: ${q(id)} is a ${other}, not a ${kind}`, `pass it as "${other}": ${q(id)}`);
    requireItem(doc, kind, id, `accessory ${kind}`);
  }
  return { kind, id };
}

/** A bone or warp by id (bones and warps share one id namespace). */
function readNode(doc: Doc, id: string, field: string): Node {
  const bone = findItem(doc, 'bone', id);
  const warp = findItem(doc, 'warp', id);
  if (bone && warp) throw new OpError(`follow: ${q(id)} is both a bone and a warp`, 'rename one of them (bones and warps share one id namespace)');
  if (bone) return { kind: 'bone', id };
  if (warp) return { kind: 'warp', id };
  throw new OpError(`follow: unknown ${field === 'follow' ? 'warp or bone' : field} ${q(id)} in "${field}"`, referenceHint(id, [...idsOf(doc, 'warp'), ...idsOf(doc, 'bone')], 'warps and bones'));
}

function readAnchor(doc: Doc, f: Fields, acc: Node): Point {
  const raw = f.raw('at');
  if (raw !== undefined && raw !== 'center' && !validPoint(raw)) {
    throw new OpError(`follow: "at" must be [x, y] (setup space) or "center", got ${describe(raw)}`, 'e.g. "at": [256, 121] (where the accessory touches the surface)');
  }
  if (validPoint(raw)) return [raw[0], raw[1]];
  if (acc.kind === 'warp') {
    const [x, y, w, h] = warpShape(doc, acc.id).rect;
    return [x + w / 2, y + h / 2];
  }
  const m = setupWorld(doc, acc.id);
  return [clean(m[4]), clean(m[5])];
}

/** Probe distance for rotate / scale: a quarter of the accessory warp's width; a bone: half its length (10 px when it has none). */
function defaultProbe(doc: Doc, acc: Node): number {
  if (acc.kind === 'warp') return warpShape(doc, acc.id).rect[2] / 4;
  const length = requireItem(doc, 'bone', acc.id).item.length;
  return typeof length === 'number' && length > 0 ? length / 2 : 10;
}

function label(n: Node): string {
  return `${n.kind} ${q(n.id)}`;
}

function warpShape(doc: Doc, id: string): { rect: [number, number, number, number]; cols: number; rows: number; parent?: string } {
  const { item } = requireItem(doc, 'warp', id);
  const parsed = WarpSchema.safeParse(item);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OpError(`follow: warp ${q(id)} is not valid (${issue.message} at ${issue.path.join('.') || 'the warp'})`, 'fix the warp first (rect [x, y, w, h] with positive w/h, integer cols/rows)');
  }
  return { rect: parsed.data.rect, cols: parsed.data.cols, rows: parsed.data.rows, parent: parsed.data.parent };
}

// ----------------------------------------------------------------------------- chains and grids

function parentNode(doc: Doc, n: Node): Node | undefined {
  const { item } = requireItem(doc, n.kind, n.id);
  const parent = item.parent;
  if (typeof parent !== 'string' || parent === '') return undefined;
  if (n.kind === 'bone') return { kind: 'bone', id: parent };
  return findItem(doc, 'warp', parent) ? { kind: 'warp', id: parent } : { kind: 'bone', id: parent };
}

/** `start` and its ancestors, nearest first. */
function chainFrom(doc: Doc, start: Node | undefined): Node[] {
  const out: Node[] = [];
  for (let n = start; n; n = parentNode(doc, n)) {
    if (out.some((o) => o.id === n!.id)) throw new OpError(`follow: parent cycle through ${q(n.id)}`, 'remove "parent" from one of the items in the cycle');
    if (!findItem(doc, n.kind, n.id)) throw new OpError(`follow: unknown parent ${n.kind} ${q(n.id)}`, 'fix the "parent" references first (rev2d validate lists them)');
    out.push(n);
  }
  return out;
}

function indexOfShared(chain: Node[], other: Node[]): number {
  const i = chain.findIndex((n) => other.some((o) => o.id === n.id));
  return i < 0 ? chain.length : i;
}

function nodeTargets(n: Node): string[] {
  return n.kind === 'warp' ? [`warp:${n.id}.offsets`] : BONE_PROPS.map((p) => `bone:${n.id}.${p}`);
}

/** Bindings that move any of the nodes (warp offsets, bone transforms). */
function bindingsOn(doc: Doc, nodes: Node[]): Item[] {
  const keys = new Set(nodes.flatMap(nodeTargets));
  return (sectionItems(doc, 'binding') ?? []).filter((b) => isObject(b) && keys.has(canonicalTarget(b.target) ?? '') && Array.isArray(b.params));
}

function nodesWithBindings(nodes: Node[], bindings: Item[]): string[] {
  return nodes.filter((n) => bindings.some((b) => nodeTargets(n).includes(canonicalTarget(b.target) ?? ''))).map((n) => n.id);
}

function defaultParams(doc: Doc, own: Node[], bindings: Item[], acc: Node, follow: Node): string[] {
  const params: string[] = [];
  for (const b of bindings) for (const p of b.params as unknown[]) if (typeof p === 'string' && !params.includes(p)) params.push(p);
  if (!params.length) {
    throw new OpError(
      `follow: nothing moves ${label(follow)} relative to ${label(acc)}: no parameter drives ${own.length ? formatQuotedList(own.map((n) => n.id), 6) : 'the followed chain'}`,
      `bind the followed item first (e.g. bind_warp ${q(follow.id)} to AngleX / AngleY), or give "params" explicitly`,
    );
  }
  if (params.length > 3) {
    throw new OpError(
      `follow: ${params.length} parameters drive the followed chain (${params.join(', ')}), but a binding takes at most 3`,
      `pass "params" with the 1 to 3 that move it most (e.g. ["AngleX", "AngleY"]); run follow again with the others if needed (bindings on one target add up)`,
    );
  }
  for (const p of params) requireItem(doc, 'parameter', p);
  return params;
}

/** Distinct keyform values of `param` in the bindings, ascending; undefined when none uses it. */
function axisOf(param: string, bindings: Item[]): number[] | undefined {
  const values = new Set<number>();
  for (const b of bindings) {
    const d = (b.params as unknown[]).indexOf(param);
    if (d < 0 || !Array.isArray(b.keys)) continue;
    for (const k of b.keys) if (isObject(k) && Array.isArray(k.at) && typeof k.at[d] === 'number') values.add(k.at[d]);
  }
  return values.size ? [...values].sort((a, b) => a - b) : undefined;
}

/** min, default, max of a parameter that no related binding keys. */
function rangeAxis(doc: Doc, param: string): number[] {
  const p = requireItem(doc, 'parameter', param).item;
  const min = typeof p.min === 'number' ? p.min : 0;
  const max = typeof p.max === 'number' ? p.max : 1;
  const def = Math.min(max, Math.max(min, typeof p.default === 'number' ? p.default : 0));
  return [...new Set([min, def, max])].sort((a, b) => a - b);
}

function gridPoints(axes: number[][]): number[][] {
  let out: number[][] = [[]];
  for (const axis of axes) out = out.flatMap((c) => axis.map((v) => [...c, v]));
  return out;
}

/** Grid points with at least one coordinate halfway between two keyform values (cell centres only when there are too many). */
function midpoints(axes: number[][]): number[][] {
  const halves = axes.map((a) => a.slice(1).map((v, i) => (a[i] + v) / 2));
  const refined = axes.map((a, d) => [...a, ...halves[d]].sort((x, y) => x - y));
  const count = refined.reduce((n, a) => n * a.length, 1) - axes.reduce((n, a) => n * a.length, 1);
  if (count <= MAX_MIDPOINTS) {
    return gridPoints(refined).filter((p) => p.some((v, d) => halves[d].includes(v)));
  }
  return gridPoints(halves.map((h, d) => (h.length ? h : axes[d])));
}

function paramsAt(params: string[], at: number[]): Record<string, number> {
  return Object.fromEntries(params.map((p, i) => [p, at[i]]));
}

function gridText(params: string[], axes: number[][]): string {
  return params.map((p, d) => `${p} {${axes[d].map((v) => fmt(v)).join(', ')}}`).join(' × ');
}

function atText(at: number[]): string {
  return `[${at.map((v) => fmt(v)).join(', ')}]`;
}

function fmt4(n: number): string {
  return String(clean(n, 4));
}

// ----------------------------------------------------------------------------- rigs

/** The model without the bindings this op replaces (same target and parameter set). */
function evaluationRig(ctx: OpContext, targets: string[], params: string[], acc: Node): Rig {
  const doc = structuredClone(ctx.doc);
  const keys = new Set(targets.map((t) => canonicalTarget(t)));
  const items = sectionItems(doc, 'binding');
  if (items) {
    const keep = items.filter((b) => !(isObject(b) && keys.has(canonicalTarget(b.target)) && sameParamSet(b.params, params)));
    items.splice(0, items.length, ...keep);
  }
  return buildRig(ctx, doc, `posing the rig to measure where ${label(acc)} has to go`);
}

function resultRig(ctx: OpContext): Rig {
  return buildRig(ctx, ctx.doc, 'measuring the result');
}

function buildRig(ctx: OpContext, doc: Doc, why: string): Rig {
  const { model, diagnostics } = validateModel(doc);
  if (!model) {
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const first = errors[0];
    throw new OpError(
      `follow: ${why} needs a valid model, but validation reports ${errors.length} error${errors.length === 1 ? '' : 's'}${first ? ` (first: ${first.message} at ${first.path})` : ''}`,
      'fix those first (earlier ops in the same batch can)',
    );
  }
  try {
    return new Rig({ ...model, physics: [] }, { textures: ctx.textures });
  } catch (e) {
    throw new OpError(`follow: cannot evaluate the model (${why}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

function keptBindings(doc: Doc, targets: string[], params: string[]): string[] {
  const keys = new Set(targets.map((t) => canonicalTarget(t)));
  return (sectionItems(doc, 'binding') ?? []).filter((b) => isObject(b) && keys.has(canonicalTarget(b.target)) && !sameParamSet(b.params, params)).map(bindingSignature);
}

function outsideWarp(doc: Doc, n: Node, [x, y]: Point): string | undefined {
  if (n.kind !== 'warp') return undefined;
  const [rx, ry, w, h] = warpShape(doc, n.id).rect;
  const e = 1e-9;
  if (x >= rx - e && x <= rx + w + e && y >= ry - e && y <= ry + h + e) return undefined;
  return `outside the rect [${[rx, ry, w, h].map((v) => fmt(v)).join(', ')}] of warp ${q(n.id)}`;
}

// ----------------------------------------------------------------------------- solving

interface Solution {
  /** One value per target (warp: the full offsets list; bone: x, y, rotation?, scaleX?, scaleY?). */
  values: unknown[];
  /** Distance the anchor has to move from where it would be without the new binding (px). */
  shift: number;
  /** Rotation applied (degrees; 0 without "rotate"). */
  theta: number;
  /** Scale applied (1 without "scale"). */
  scale: number;
}

type Map2 = (x: number, y: number) => Point;

function probes([ax, ay]: Point, r: number): [Point, Point] {
  return [
    [ax - r, ay],
    [ax + r, ay],
  ];
}

/** Rotation (degrees) and length ratio that take vector u to vector v. */
function turnAndStretch(u: Point, v: Point): { theta: number; ratio: number } {
  const lu = Math.hypot(u[0], u[1]);
  const lv = Math.hypot(v[0], v[1]);
  if (lu < 1e-9 || lv < 1e-9) throw new OpError('follow: the probe points collapse onto each other in some pose, so the local rotation / scale is undefined', 'use a larger "probe", or follow without "rotate" / "scale"');
  return { theta: wrapDeg((Math.atan2(v[1], v[0]) - Math.atan2(u[1], u[0])) / DEG), ratio: lv / lu };
}

/** Solve g(x) = target by Newton's method (finite-difference Jacobian), starting at x0. */
function inverse(g: Map2, target: Point, x0: Point, what: string): Point {
  let [x, y] = x0;
  for (let it = 0; it < 30; it++) {
    const [fx, fy] = g(x, y);
    const ex = fx - target[0];
    const ey = fy - target[1];
    if (Math.hypot(ex, ey) < 1e-7) break;
    const h = 0.5;
    const [ax, ay] = g(x + h, y);
    const [bx, by] = g(x, y + h);
    const j00 = (ax - fx) / h;
    const j10 = (ay - fy) / h;
    const j01 = (bx - fx) / h;
    const j11 = (by - fy) / h;
    const det = j00 * j11 - j01 * j10;
    if (Math.abs(det) < 1e-12) throw new OpError(`follow: ${what} is collapsed (zero area) near ${fmtPoint(x, y)} in some pose, so no position maps onto the target`, 'check its scale and lattice offsets at the extreme parameter values');
    x -= (j11 * ex - j01 * ey) / det;
    y -= (-j10 * ex + j00 * ey) / det;
  }
  return [x, y];
}

function warpSolver(rig: Rig, acc: Node, anchor: Point, radius: number, rotate: boolean, scale: boolean) {
  const cw = rig.compiled.warps.find((w) => w.id === acc.id)!;
  const { rect, cols, rows } = cw;
  const rest = Array.from(cw.rest);
  const parent = cw.parent.kind === 'bone' ? rig.compiled.bones[cw.parent.index].id : cw.parent.kind === 'warp' ? rig.compiled.warps[cw.parent.index].id : null;
  const parentWarp = cw.parent.kind === 'warp';
  const key = `warp:${acc.id}.offsets`;
  const what = parent ? `the parent of ${label(acc)} (${q(parent)})` : 'model space';
  return (pose: Pose, target: Map2): Solution => {
    const g: Map2 = (x, y) => rig.mapPoint(pose, parent, x, y);
    const current = pose.properties[key] as number[] | undefined;
    const L = current ? rest.map((v, i) => v + current[i]) : rest.slice();
    const mapL: Map2 = (x, y) => mapThroughWarp(L, cols, rows, rect, x, y);
    const goal = target(anchor[0], anchor[1]);
    const q0 = mapL(anchor[0], anchor[1]);
    const [tx, ty] = inverse(g, goal, q0, what);
    let theta = 0;
    let s = 1;
    if (rotate || scale) {
      const [p1, p2] = probes(anchor, radius);
      const q1 = mapL(...p1);
      const q2 = mapL(...p2);
      const x1 = inverse(g, target(...p1), q1, what);
      const x2 = inverse(g, target(...p2), q2, what);
      const t = turnAndStretch([q2[0] - q1[0], q2[1] - q1[1]], [x2[0] - x1[0], x2[1] - x1[1]]);
      if (rotate) theta = t.theta;
      if (scale) s = t.ratio;
    }
    const c = Math.cos(theta * DEG) * s;
    const sn = Math.sin(theta * DEG) * s;
    const moved = (dx: number, dy: number): number[] => {
      const out = new Array<number>(L.length);
      for (let i = 0; i < L.length; i += 2) {
        const rx = L[i] - q0[0];
        const ry = L[i + 1] - q0[1];
        out[i] = tx + dx + c * rx - sn * ry;
        out[i + 1] = ty + dy + sn * rx + c * ry;
      }
      return out;
    };
    let lattice = moved(0, 0);
    if (parentWarp) {
      // The parent warp maps the lattice points, not the anchor, and is not affine: solve for the
      // extra translation that lands the anchor on the goal after both mappings.
      const final: Map2 = (dx, dy) => {
        const pts = moved(dx, dy);
        for (let i = 0; i < pts.length; i += 2) [pts[i], pts[i + 1]] = g(pts[i], pts[i + 1]);
        return mapThroughWarp(pts, cols, rows, rect, anchor[0], anchor[1]);
      };
      lattice = moved(...inverse(final, goal, [0, 0], what));
    }
    const value = lattice.map((v, i) => clean(v - L[i], 4));
    const before = rig.mapPoint(pose, acc.id, anchor[0], anchor[1]);
    return { values: [value], shift: Math.hypot(goal[0] - before[0], goal[1] - before[1]), theta, scale: s };
  };
}

function boneSolver(doc: Doc, rig: Rig, acc: Node, anchor: Point, radius: number, rotate: boolean, scale: boolean) {
  const cb = rig.compiled.bones.find((b) => b.id === acc.id)!;
  const parent = cb.parent >= 0 ? rig.compiled.bones[cb.parent].id : undefined;
  const setup = boneTrs(requireItem(doc, 'bone', acc.id).item);
  return (pose: Pose, target: Map2): Solution => {
    const bp = pose.bones[acc.id];
    const now: Map2 = (x, y) => rig.mapPoint(pose, acc.id, x, y);
    const goal = target(anchor[0], anchor[1]);
    const here = now(anchor[0], anchor[1]);
    let theta = 0;
    let s = 1;
    if (rotate || scale) {
      const [p1, p2] = probes(anchor, radius);
      const [a1, a2] = [now(...p1), now(...p2)];
      const [b1, b2] = [target(...p1), target(...p2)];
      const t = turnAndStretch([a2[0] - a1[0], a2[1] - a1[1]], [b2[0] - b1[0], b2[1] - b1[1]]);
      if (rotate) theta = t.theta;
      if (scale) s = t.ratio;
    }
    const c = Math.cos(theta * DEG) * s;
    const sn = Math.sin(theta * DEG) * s;
    // D = translate(goal) · rotate/scale · translate(−here): moves the anchor onto the goal.
    const D: Mat2D = [c, sn, -sn, c, goal[0] - (c * here[0] - sn * here[1]), goal[1] - (sn * here[0] + c * here[1])];
    const parentWorld = parent !== undefined ? pose.bones[parent].world : identity();
    const det = parentWorld[0] * parentWorld[3] - parentWorld[1] * parentWorld[2];
    if (Math.abs(det) < 1e-12) throw new OpError(`follow: the parent bone ${q(parent!)} of ${label(acc)} has zero scale in some pose, so no local value moves the accessory`, 'give it a non-zero scale at every keyform');
    const local = multiply(invert(parentWorld), multiply(D, bp.world));
    const next = decompose(local, bp.local.rotation, bp.local.scaleX);
    const delta = (field: 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY') => next[field] - bp.local[field];
    const values: number[] = [clean(setup.x + delta('x'), 4), clean(setup.y + delta('y'), 4)];
    if (rotate) values.push(clean(setup.rotation + delta('rotation'), 4));
    if (scale) values.push(clean(setup.scaleX + delta('scaleX'), 6), clean(setup.scaleY + delta('scaleY'), 6));
    return { values, shift: Math.hypot(goal[0] - here[0], goal[1] - here[1]), theta, scale: s };
  };
}

// ----------------------------------------------------------------------------- residuals

interface Worst {
  at: number[];
  px: number;
  deg: number;
  ratio: number;
}

function residual(rig: Rig, params: Record<string, number>, acc: string, follow: string, anchor: Point, radius: number, rotate: boolean, scale: boolean): Omit<Worst, 'at'> {
  const pose = rig.pose({ params, physics: false });
  const a = rig.mapPoint(pose, acc, anchor[0], anchor[1]);
  const b = rig.mapPoint(pose, follow, anchor[0], anchor[1]);
  const out = { px: Math.hypot(a[0] - b[0], a[1] - b[1]), deg: 0, ratio: 1 };
  if (rotate || scale) {
    const [p1, p2] = probes(anchor, radius);
    const u = sub(rig.mapPoint(pose, acc, ...p2), rig.mapPoint(pose, acc, ...p1));
    const v = sub(rig.mapPoint(pose, follow, ...p2), rig.mapPoint(pose, follow, ...p1));
    const t = turnAndStretch(u, v);
    out.deg = Math.abs(t.theta);
    out.ratio = t.ratio;
  }
  return out;
}

function sub(a: Point, b: Point): Point {
  return [a[0] - b[0], a[1] - b[1]];
}

function worst(list: Worst[]): Worst {
  let w = list[0];
  for (const x of list) if (x.px > w.px) w = x;
  return {
    at: w.at,
    px: w.px,
    deg: Math.max(...list.map((x) => x.deg)),
    ratio: list.reduce((r, x) => (Math.abs(x.ratio - 1) > Math.abs(r - 1) ? x.ratio : r), 1),
  };
}
