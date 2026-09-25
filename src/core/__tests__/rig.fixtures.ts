/** Shared helpers for the rig test suites. */
import { ModelSchema } from '../schema.js';
import { Rig } from '../rig.js';
import type { Model, ModelInput, Pose } from '../types.js';

type ModelBody = Omit<ModelInput, 'format' | 'version' | 'meta'> & { meta?: Partial<ModelInput['meta']> };

export function makeModel(body: ModelBody = {}): Model {
  const { meta, ...rest } = body;
  return ModelSchema.parse({ format: 'rev2d', version: 1, meta: { name: 'test', width: 200, height: 200, ...meta }, ...rest });
}

export function makeRig(body: ModelBody = {}): Rig {
  return new Rig(makeModel(body));
}

/** Axis-aligned quad mesh: vertices TL, TR, BR, BL. */
export function quad(x: number, y: number, w: number, h: number) {
  return {
    type: 'mesh' as const,
    vertices: [x, y, x + w, y, x + w, y + h, x, y + h],
    triangles: [0, 1, 2, 0, 2, 3],
  };
}

/** Regular grid mesh with (cols+1)*(rows+1) vertices, row-major. */
export function gridMesh(x: number, y: number, w: number, h: number, cols: number, rows: number) {
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) vertices.push(x + (w * c) / cols, y + (h * r) / rows);
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * (cols + 1) + c;
      triangles.push(i, i + 1, i + cols + 2, i, i + cols + 2, i + cols + 1);
    }
  }
  return { type: 'mesh' as const, vertices, triangles };
}

/** Mesh from arbitrary points (triangulated as a fan; tests only read positions). */
export function pointsMesh(points: number[]) {
  const n = points.length / 2;
  const triangles: number[] = [];
  for (let i = 1; i + 1 < n; i++) triangles.push(0, i, i + 1);
  return { type: 'mesh' as const, vertices: points, triangles: triangles.length ? triangles : [0, 0, 0] };
}

/** Vertex `i` of a deformed batch. */
export function vertex(positions: Float32Array | null, i: number): [number, number] {
  if (!positions) throw new Error('batch is null');
  return [positions[i * 2], positions[i * 2 + 1]];
}

export function fillOf(pose: Pose, part: string): Float32Array {
  const f = pose.parts[part].fill;
  if (!f) throw new Error(`part ${part} has no fill`);
  return f;
}

/** Assert two points are within `eps` (default 1e-3 px). */
export function expectNear(actual: ArrayLike<number>, expected: ArrayLike<number>, eps = 1e-3): void {
  if (actual.length !== expected.length) throw new Error(`length ${actual.length} != ${expected.length}`);
  for (let i = 0; i < actual.length; i++) {
    if (!(Math.abs(actual[i] - expected[i]) <= eps)) {
      throw new Error(`component ${i}: expected ${Array.from(expected).join(', ')} got ${Array.from(actual).join(', ')} (eps ${eps})`);
    }
  }
}
