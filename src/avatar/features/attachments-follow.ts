/**
 * Rigid follow for attachments: a warp nested in the root lattice that moves like a RIGID piece
 * with the root lattice, instead of being bent by it.
 *
 * Everything nested in the root lattice is deformed by it: a tassel hanging from a bun would stretch
 * where the head turn fades out along its length, a hand under the chin would bend with the jaw.
 * For every binding on the root lattice (head turn and tilt, body sway, breath, a wobbling bun, ...)
 * this module adds a binding with the same parameters and keyforms on the attachment's warp that
 * replaces the root's deformation there by a target motion:
 *
 *   rigid     the root's motion over a set of sample points (around a pendulum's pivot, over a
 *             cut-out's outline) fitted as one rotation + translation (least squares)
 *   none      the attachment does not take part in this motion
 *   contact   a weight field times the root's motion at one point (a fingertip on the chin follows
 *             the head a little; the far end does not)
 *
 * With D the root's displacement at a keyform (bilinear over the root lattice, exactly as the rig
 * maps nested points) and T the target, the warp offset o at a lattice point p solves
 * p + o + D(p + o) = p + T(p), a fixed point found in a few iterations. Bindings add up, so the
 * combination of several motions is right to first order.
 */
import type { BindingInput, ModelBuilder, WarpHandle } from '../builder.js';
import { latticePointCount, sparseOffsets, type Field, type Lattice, type SparseOffsets, type Vec2 } from '../fields.js';

/** One keyform of a root binding as a displacement field: bilinear over the lattice (outside it: the nearest cell, extrapolated). */
export function latticeField(lattice: Lattice, sparse: SparseOffsets): Field {
  const { rect, cols, rows } = lattice;
  const n = latticePointCount(lattice);
  const dense = new Float64Array(n * 2);
  let any = false;
  for (const [key, d] of Object.entries(sparse)) {
    const i = Number(key);
    if (!(i >= 0 && i < n)) continue;
    dense[i * 2] = d[0];
    dense[i * 2 + 1] = d[1];
    any = any || d[0] !== 0 || d[1] !== 0;
  }
  if (!any) return () => [0, 0];
  const cw = rect[2] / cols;
  const ch = rect[3] / rows;
  return (x, y) => {
    const u = (x - rect[0]) / cw;
    const v = (y - rect[1]) / ch;
    const c = Math.min(cols - 1, Math.max(0, Math.floor(u)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor(v)));
    const fu = u - c;
    const fv = v - r;
    const i00 = r * (cols + 1) + c;
    const i10 = i00 + 1;
    const i01 = i00 + cols + 1;
    const i11 = i01 + 1;
    const lerp = (k: number) =>
      (1 - fv) * ((1 - fu) * dense[i00 * 2 + k] + fu * dense[i10 * 2 + k]) + fv * ((1 - fu) * dense[i01 * 2 + k] + fu * dense[i11 * 2 + k]);
    return [lerp(0), lerp(1)];
  };
}

/**
 * The rotation + translation that best matches a displacement field over sample points (least
 * squares), as a displacement field. `rotate: false` fits the translation only.
 */
export function rigidFit(field: Field, samples: readonly Vec2[], rotate = true): Field {
  if (samples.length === 0) return () => [0, 0];
  let sx = 0;
  let sy = 0;
  let qx = 0;
  let qy = 0;
  const moved = samples.map(([x, y]) => {
    const d = field(x, y);
    return [x + d[0], y + d[1]] as Vec2;
  });
  samples.forEach(([x, y], i) => {
    sx += x;
    sy += y;
    qx += moved[i][0];
    qy += moved[i][1];
  });
  const k = samples.length;
  sx /= k;
  sy /= k;
  qx /= k;
  qy /= k;
  let angle = 0;
  if (rotate && k > 1) {
    let dot = 0;
    let cross = 0;
    samples.forEach(([x, y], i) => {
      const ax = x - sx;
      const ay = y - sy;
      const bx = moved[i][0] - qx;
      const by = moved[i][1] - qy;
      dot += ax * bx + ay * by;
      cross += ax * by - ay * bx;
    });
    angle = Math.atan2(cross, dot);
  }
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  if (Math.abs(angle) < 1e-12 && Math.abs(qx - sx) < 1e-12 && Math.abs(qy - sy) < 1e-12) return () => [0, 0];
  // p -> R (p - s) + q
  return (x, y) => {
    const ax = x - sx;
    const ay = y - sy;
    return [ax * cos - ay * sin + qx - x, ax * sin + ay * cos + qy - y];
  };
}

/** What a follower does in one root binding: a target motion per keyform, or null to take the root's deformation as it is. */
export type FollowTarget = (binding: BindingInput, rootField: Field) => Field | null;

/** The warp offsets that turn the root's deformation `rootField` into `target` (see the file header). */
export function followOffsets(lattice: Lattice, rootField: Field, target: Field, iterations = 4): SparseOffsets {
  const n = latticePointCount(lattice);
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = lattice.points[i * 2];
    const y = lattice.points[i * 2 + 1];
    const t = target(x, y);
    let ox = 0;
    let oy = 0;
    for (let k = 0; k < iterations; k++) {
      const d = rootField(x + ox, y + oy);
      ox = t[0] - d[0];
      oy = t[1] - d[1];
    }
    out[i * 2] = ox;
    out[i * 2 + 1] = oy;
  }
  return sparseOffsets(out);
}

/**
 * Add the follow bindings of `warp` (nested in `root`) for every binding on the root lattice that
 * exists now. Returns the number of bindings added. `prefix` makes the binding ids
 * (`<prefix>_<root binding id or index>`).
 */
export function addFollowBindings(model: ModelBuilder, root: WarpHandle, warp: WarpHandle, prefix: string, target: FollowTarget): number {
  const doc = model.build() as { bindings: BindingInput[] };
  const rootTarget = `warp:${root.id}.offsets`;
  let added = 0;
  doc.bindings.forEach((binding, index) => {
    if (binding.target !== rootTarget) return;
    const values = binding.keys.map((key) => {
      const value = key.value;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
      const field = latticeField(root.lattice, value as SparseOffsets);
      const goal = target(binding, field);
      if (goal === null) return {};
      return followOffsets(warp.lattice, field, goal);
    });
    if (values.every((v) => Object.keys(v).length === 0)) return;
    model.bind({
      id: `${prefix}_${binding.id ?? index}`,
      target: `warp:${warp.id}.offsets`,
      params: [...binding.params],
      keys: binding.keys.map((key, k) => ({ at: [...key.at], value: values[k] })),
      description: `Keeps the attachment rigid in the root lattice's "${binding.id ?? index}" motion.`,
    });
    added++;
  });
  return added;
}
