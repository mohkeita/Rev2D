/**
 * Spine bones of an export: the synthetic root, the Rev2D bones and, for warps, one bone per used
 * lattice point.
 *
 * Warp lattice bones make warp deformation exact in Spine: the rig maps a point inside a warp cell
 * bilinearly, p = Σ wᵢ·Pᵢ with the cell's four lattice points Pᵢ and weights that sum to 1 (outside
 * the rect the nearest edge cell extrapolates with the same formula). A weighted mesh vertex in Spine
 * is Σ wᵢ·Mᵢ·lᵢ with lᵢ = Mᵢ(setup)⁻¹·p(setup). When every Mᵢ has the same linear part A (the lattice
 * bones are children of one bone and only translate) and translation Pᵢ, this is
 * Σ wᵢ·Pᵢ + A·A(setup)⁻¹·(p(setup) − Σ wᵢ·Pᵢ(setup)) = Σ wᵢ·Pᵢ exactly.
 */
import { invert } from '../../core/math.js';
import type { CompiledRig } from '../../core/rig/compiled.js';
import type { Mat2D, Pose } from '../../core/types.js';

export interface LocalValues {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  length: number;
}

export interface SpineBone {
  name: string;
  /** Spine index of the parent bone, -1 for the root. */
  parent: number;
  /** Rev2D bone index, -1 for the synthetic root and lattice bones. */
  rev: number;
  /** Warp lattice point this bone carries. */
  lattice?: { warp: number; point: number };
  /** Rev2D-convention local values (relative to the parent's world) in a pose. */
  local(pose: Pose): LocalValues;
  /** Rev2D world matrix in a pose. */
  world(pose: Pose): Mat2D;
}

const IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0];

/** The nearest bone above a warp (Rev2D index), or -1. */
export function warpBone(c: CompiledRig, warp: number): number {
  let parent = c.warps[warp].parent;
  for (let guard = 0; guard < 1000; guard++) {
    if (parent.kind === 'bone') return parent.index;
    if (parent.kind === 'none') return -1;
    parent = c.warps[parent.index].parent;
  }
  return -1;
}

/** Bilinear weights of a setup point in a warp: [lattice point index, weight] pairs (non-zero). */
export function warpWeights(c: CompiledRig, warp: number, x: number, y: number): Array<[number, number]> {
  const w = c.warps[warp];
  const { cols, rows, rect } = w;
  const u = ((x - rect[0]) / rect[2]) * cols;
  const v = ((y - rect[1]) / rect[3]) * rows;
  const col = u < 0 ? 0 : u >= cols ? cols - 1 : Math.floor(u);
  const row = v < 0 ? 0 : v >= rows ? rows - 1 : Math.floor(v);
  const fu = u - col;
  const fv = v - row;
  const i00 = row * (cols + 1) + col;
  const i01 = i00 + cols + 1;
  const out: Array<[number, number]> = [];
  for (const [i, wt] of [
    [i00, (1 - fu) * (1 - fv)],
    [i00 + 1, fu * (1 - fv)],
    [i01, (1 - fu) * fv],
    [i01 + 1, fu * fv],
  ] as Array<[number, number]>) {
    if (Math.abs(wt) > 1e-9) out.push([i, wt]);
  }
  return out;
}

export class BoneTable {
  readonly bones: SpineBone[] = [];
  private readonly revIndex = new Map<number, number>();
  private readonly latticeIndex = new Map<string, number>();
  private readonly names = new Set<string>();

  constructor(
    readonly c: CompiledRig,
    rootName: string,
  ) {
    for (const b of c.bones) this.names.add(b.id);
    this.names.add(rootName);
    this.bones.push({ name: rootName, parent: -1, rev: -1, local: () => ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0 }), world: () => IDENTITY });
    for (const i of c.boneOrder) {
      const b = c.bones[i];
      const id = b.id;
      this.revIndex.set(i, this.bones.length);
      this.bones.push({
        name: id,
        parent: b.parent >= 0 ? this.revIndex.get(b.parent)! : 0,
        rev: i,
        local: (pose) => pose.bones[id].local,
        world: (pose) => pose.bones[id].world,
      });
    }
  }

  /** Spine index of a Rev2D bone (-1 = the synthetic root). */
  ofRev(rev: number): number {
    return rev < 0 ? 0 : this.revIndex.get(rev)!;
  }

  /** Spine index of the bone of a warp lattice point, created on first use (see addLattice for order). */
  lattice(warp: number, point: number): number {
    const i = this.latticeIndex.get(`${warp}:${point}`);
    if (i === undefined) throw new Error(`BoneTable: lattice bone ${warp}:${point} was not added`);
    return i;
  }

  /** Add lattice bones for the given (warp, point) pairs, sorted for a deterministic order. */
  addLattice(pairs: Iterable<[number, number]>): void {
    const list = [...new Set([...pairs].map(([w, p]) => `${w}:${p}`))]
      .map((k) => k.split(':').map(Number) as [number, number])
      .filter(([w, p]) => !this.latticeIndex.has(`${w}:${p}`))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const c = this.c;
    for (const [w, p] of list) {
      const warp = c.warps[w];
      const anchor = warpBone(c, w);
      const parentSpine = this.ofRev(anchor);
      const parentId = anchor >= 0 ? c.bones[anchor].id : null;
      const col = p % (warp.cols + 1);
      const row = Math.floor(p / (warp.cols + 1));
      let name = `${warp.id}-${row}-${col}`;
      for (let k = 2; this.names.has(name); k++) name = `${warp.id}-${row}-${col}-${k}`;
      this.names.add(name);
      const parentWorld = (pose: Pose): Mat2D => (parentId ? pose.bones[parentId].world : IDENTITY);
      const point = (pose: Pose): [number, number] => {
        const pts = pose.warps[warp.id].points;
        return [pts[2 * p], pts[2 * p + 1]];
      };
      this.latticeIndex.set(`${w}:${p}`, this.bones.length);
      this.bones.push({
        name,
        parent: parentSpine,
        rev: -1,
        lattice: { warp: w, point: p },
        local: (pose) => {
          const inv = invert(parentWorld(pose));
          const [x, y] = point(pose);
          return { x: inv[0] * x + inv[2] * y + inv[4], y: inv[1] * x + inv[3] * y + inv[5], rotation: 0, scaleX: 1, scaleY: 1, length: 0 };
        },
        world: (pose) => {
          const m = parentWorld(pose);
          const [x, y] = point(pose);
          return [m[0], m[1], m[2], m[3], x, y];
        },
      });
    }
  }
}
