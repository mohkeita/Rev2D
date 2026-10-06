/**
 * Fold checker: does the mesh of a built avatar flip or collapse anywhere at the parameter extremes
 * and their combinations? A flipped lattice cell or triangle shows as a tear or a mirrored sliver,
 * a collapsed one as a pinch. The check evaluates the real model (core Rig), so nested warps and
 * summed bindings are covered exactly as they render.
 *
 *   findFolds(model, plan?)   -> FoldFinding[]   (per warp / part and pose: the worst cell)
 *   foldIssues(findings)      -> AvatarIssue[]   ("avatar-mesh-fold" warnings for the build report)
 *
 * Measure: the signed area of every lattice cell corner (a bilinear cell is fold-free exactly when
 * the triangle at each of its four corners keeps its orientation) and of every fill triangle of
 * every drawn part, relative to the rest pose. <= 0 is a flip; below `minRatio` a collapse.
 */
import { Rig, buildRenderList } from '../core/rig.js';
import type { Model, Pose, TextureInfo } from '../core/types.js';
import type { AvatarIssue } from './types.js';

export const FOLD_CODE = 'avatar-mesh-fold';

export interface FoldPlan {
  /** Parameter sets to check in addition to defaultFoldPoses (e.g. a strand at its limit while the head is turned). */
  poses?: Array<Record<string, number>>;
  /**
   * "warp:<id>" / "part:<id>" whose cells may collapse to zero area by design (the lattice of a
   * closing eye): only real flips are reported for them.
   */
  collapsible?: string[];
  /** "warp:<id>" / "part:<id>" that are not checked at all. */
  skip?: string[];
}

export interface FoldOptions {
  /** Area relative to rest below which a cell counts as collapsed (default 0.1). */
  minRatio?: number;
  /** Texture sizes for image parts without w / h (default: the sizes declared in the model). */
  textures?: Record<string, TextureInfo>;
  /** Replace the default poses entirely (the plan's poses are still added). */
  poses?: Array<Record<string, number>>;
}

export interface FoldFinding {
  kind: 'warp' | 'part';
  id: string;
  /** The explicit parameter values of the pose. */
  params: Record<string, number>;
  /** Rest position of the worst cell / triangle (source pixels). */
  at: [number, number];
  /** Its area relative to rest (<= 0: flipped). */
  ratio: number;
  flipped: boolean;
  /** How many cells / triangles of this object fold in this pose. */
  count: number;
}

/** Collapsible objects may reach zero area; numerical noise around zero is not a flip. */
const FLIP_TOLERANCE = 0.05;

/** The parameters whose extremes are combined: the motions that add up on the whole-image lattice. */
const COMBINED = ['AngleX', 'AngleY', 'AngleZ', 'BodyAngleX'];

/**
 * The poses checked by default: every parameter alone at its minimum and maximum, and every corner
 * of AngleX x AngleY x AngleZ x BodyAngleX (with Breath at 1 when the model breathes).
 */
export function defaultFoldPoses(model: Model): Array<Record<string, number>> {
  const poses: Array<Record<string, number>> = [];
  for (const p of model.parameters) {
    const rest = p.default ?? Math.min(p.max, Math.max(p.min, 0));
    for (const v of [p.min, p.max]) if (v !== rest) poses.push({ [p.id]: v });
  }
  const combined = model.parameters.filter((p) => COMBINED.includes(p.id) && p.min < p.max);
  if (combined.length > 1) {
    const breath = model.parameters.find((p) => p.id === 'Breath');
    for (let mask = 0; mask < 1 << combined.length; mask++) {
      const pose: Record<string, number> = {};
      combined.forEach((p, i) => {
        pose[p.id] = mask & (1 << i) ? p.max : p.min;
      });
      if (breath) pose.Breath = breath.max;
      poses.push(pose);
    }
  }
  return poses;
}

interface Worst {
  ratio: number;
  at: [number, number];
  count: number;
}

function track(worst: Worst | null, ratio: number, x: number, y: number): Worst {
  if (!worst) return { ratio, at: [x, y], count: 1 };
  worst.count++;
  if (ratio < worst.ratio) {
    worst.ratio = ratio;
    worst.at = [x, y];
  }
  return worst;
}

/** Worst folding cell of one deformed lattice against its rest points. */
function warpWorst(rest: ArrayLike<number>, now: ArrayLike<number>, cols: number, rows: number, limit: number): Worst | null {
  const cross = (p: ArrayLike<number>, o: number, a: number, b: number) => (p[a * 2] - p[o * 2]) * (p[b * 2 + 1] - p[o * 2 + 1]) - (p[a * 2 + 1] - p[o * 2 + 1]) * (p[b * 2] - p[o * 2]);
  let worst: Worst | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i00 = r * (cols + 1) + c;
      const i10 = i00 + 1;
      const i01 = i00 + cols + 1;
      const i11 = i01 + 1;
      let ratio = Infinity;
      for (const [o, a, b] of [[i00, i10, i01], [i10, i11, i00], [i11, i01, i10], [i01, i00, i11]]) {
        const base = cross(rest, o, a, b);
        if (Math.abs(base) < 1e-9) continue;
        ratio = Math.min(ratio, cross(now, o, a, b) / base);
      }
      if (ratio < limit) worst = track(worst, ratio, (rest[i00 * 2] + rest[i11 * 2]) / 2, (rest[i00 * 2 + 1] + rest[i11 * 2 + 1]) / 2);
    }
  }
  return worst;
}

/** Worst folding triangle of one fill batch against its rest positions. */
function trianglesWorst(rest: ArrayLike<number>, now: ArrayLike<number>, indices: ArrayLike<number>, limit: number): Worst | null {
  const area = (p: ArrayLike<number>, a: number, b: number, c: number) => (p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) - (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2]);
  let worst: Worst | null = null;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const base = area(rest, a, b, c);
    if (Math.abs(base) < 1e-6) continue;
    const ratio = area(now, a, b, c) / base;
    if (ratio < limit) worst = track(worst, ratio, (rest[a * 2] + rest[b * 2] + rest[c * 2]) / 3, (rest[a * 2 + 1] + rest[b * 2 + 1] + rest[c * 2 + 1]) / 3);
  }
  return worst;
}

/**
 * Evaluate the model at every pose of the plan and report the warps and parts whose mesh flips or
 * collapses, one finding per object and pose (the worst cell). Physics is off: explicit parameter
 * values are the whole pose. Throws when the model cannot be compiled into a Rig.
 */
export function findFolds(model: Model, plan: FoldPlan = {}, options: FoldOptions = {}): FoldFinding[] {
  const minRatio = options.minRatio ?? 0.1;
  const rig = new Rig(model, options.textures ? { textures: options.textures } : {});
  const skip = new Set(plan.skip ?? []);
  const collapsible = new Set(plan.collapsible ?? []);
  const limitOf = (key: string) => (collapsible.has(key) ? -FLIP_TOLERANCE : minRatio);
  const ids = new Set(model.parameters.map((p) => p.id));

  const rest = rig.pose({ physics: false });
  const restFills = fillsOf(rig, rest);
  const findings: FoldFinding[] = [];
  const seen = new Set<string>();
  for (const raw of [...(options.poses ?? defaultFoldPoses(model)), ...(plan.poses ?? [])]) {
    // Parameters the model does not have (a feature that is not built) are left out of the pose.
    const params: Record<string, number> = {};
    for (const [id, v] of Object.entries(raw)) if (ids.has(id)) params[id] = v;
    const key = JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (seen.has(key) || Object.keys(params).length === 0) continue;
    seen.add(key);

    const pose = rig.pose({ params, physics: false });
    for (const warp of model.warps) {
      const tag = `warp:${warp.id}`;
      if (skip.has(tag)) continue;
      const worst = warpWorst(rest.warps[warp.id].points, pose.warps[warp.id].points, warp.cols, warp.rows, limitOf(tag));
      if (worst) findings.push({ kind: 'warp', id: warp.id, params, at: worst.at, ratio: worst.ratio, flipped: worst.ratio <= 0, count: worst.count });
    }
    for (const [id, fill] of fillsOf(rig, pose)) {
      const tag = `part:${id}`;
      const base = restFills.get(id);
      // A part whose geometry itself changes with the pose (bound shape fields) has no rest twin.
      if (skip.has(tag) || !base || base.positions.length !== fill.positions.length || base.indices !== fill.indices) continue;
      const worst = trianglesWorst(base.positions, fill.positions, fill.indices, limitOf(tag));
      if (worst) findings.push({ kind: 'part', id, params, at: worst.at, ratio: worst.ratio, flipped: worst.ratio <= 0, count: worst.count });
    }
  }
  return findings;
}

function fillsOf(rig: Rig, pose: Pose): Map<string, { positions: Float32Array; indices: Uint32Array }> {
  const out = new Map<string, { positions: Float32Array; indices: Uint32Array }>();
  for (const item of buildRenderList(rig, pose).draws) {
    if (item.kind === 'fill') out.set(item.partId, { positions: item.positions, indices: item.indices });
  }
  return out;
}

function formatParams(params: Record<string, number>): string {
  return Object.entries(params)
    .map(([id, v]) => `${id}=${Math.round(v * 1000) / 1000}`)
    .join(', ');
}

/**
 * Findings as build-report warnings: one per warp / part, naming its worst pose and place and how
 * many other poses fold too.
 */
export function foldIssues(findings: readonly FoldFinding[]): AvatarIssue[] {
  const groups = new Map<string, FoldFinding[]>();
  for (const f of findings) {
    const key = `${f.kind}:${f.id}`;
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }
  const issues: AvatarIssue[] = [];
  for (const list of groups.values()) {
    const worst = list.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    const what = worst.kind === 'warp' ? `the lattice of warp "${worst.id}"` : `the mesh of part "${worst.id}"`;
    const unit = worst.kind === 'warp' ? 'cell' : 'triangle';
    const how = worst.flipped ? 'flips' : 'collapses';
    const more = list.length > 1 ? ` (and in ${list.length - 1} more of the checked poses)` : '';
    issues.push({
      severity: 'warning',
      code: FOLD_CODE,
      message: `${what} ${how} at ${formatParams(worst.params)}: ${worst.count} ${unit}${worst.count === 1 ? '' : 's'}, the worst near (${Math.round(worst.at[0])}, ${Math.round(worst.at[1])}) with ${Math.round(worst.ratio * 100)}% of its rest area${more}`,
      hint: 'lower the amounts that move this place (head.turn, head.tilt, body.sway, a strand swing) or let them fade over a longer distance (a larger head ellipse or face oval, a longer neck band); "rev2d render <model> --param <id>=<value> --overlay warps" shows it',
    });
  }
  return issues;
}
