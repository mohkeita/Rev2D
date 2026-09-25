/** Shared helpers for the ops test suites. */
import { expect } from 'vitest';
import { Rig } from '../../core/rig.js';
import { formatDiagnostics, validateModel } from '../../core/validate.js';
import type { Mat2D } from '../../core/types.js';
import { applyOps, type ApplyOpsOptions, type ApplyOpsResult, type Op } from '../index.js';

type Raw = Record<string, any>;

/**
 * A small rig that uses every reference kind: bone/warp/part parents, skin, mask, image and mesh
 * textures, bindings (1 and 2 parameters, every address kind), IK, physics and animation tracks.
 *
 *   root (200,300) ── upper (up, -90°) ── fore (30°, scale 1.5) ── hand
 *        └─ target                          face warp ── mouthWarp
 */
export function rigDoc(): Raw {
  return {
    format: 'rev2d',
    version: 1,
    meta: { name: 'fixture', width: 400, height: 400 },
    parameters: [
      { id: 'AngleX', min: -30, max: 30, default: 0 },
      { id: 'AngleY', min: -30, max: 30 },
      { id: 'Bend', min: 0, max: 1 },
      { id: 'Sway', min: -10, max: 10 },
    ],
    textures: [
      { id: 'tex', path: 'tex.png', width: 16, height: 16 },
      { id: 'clothTex', path: 'cloth.png', width: 8, height: 8 },
    ],
    bones: [
      { id: 'root', x: 200, y: 300, length: 10 },
      { id: 'upper', parent: 'root', x: 0, y: -50, rotation: -90, length: 60 },
      { id: 'fore', parent: 'upper', x: 60, y: 0, rotation: 30, scaleX: 1.5, scaleY: 1.5, length: 40 },
      { id: 'hand', parent: 'fore', x: 40, y: 0, length: 20 },
      { id: 'target', parent: 'root', x: 80, y: -120 },
    ],
    warps: [
      { id: 'face', parent: 'upper', rect: [150, 100, 100, 100], cols: 2, rows: 2 },
      { id: 'mouthWarp', parent: 'face', rect: [180, 160, 40, 20], cols: 1, rows: 1 },
    ],
    parts: [
      { id: 'body', parent: 'root', shape: { type: 'rect', x: 170, y: 250, w: 60, h: 100 }, fill: '#8888aa' },
      { id: 'head', parent: 'face', shape: { type: 'ellipse', cx: 200, cy: 150, rx: 40, ry: 45 }, fill: '#ffcc99', z: 1 },
      { id: 'mouth', parent: 'mouthWarp', shape: { type: 'polygon', points: [185, 170, 215, 170, 200, 178] }, fill: '#aa3333', z: 2, mask: ['head'] },
      { id: 'sleeve', shape: { type: 'rect', x: 190, y: 150, w: 20, h: 80 }, skin: { bones: ['upper', 'fore'] }, fill: '#5555ff' },
      { id: 'photo', parent: 'hand', shape: { type: 'image', texture: 'tex', x: 0, y: 0 } },
      {
        id: 'cloth',
        parent: 'root',
        shape: { type: 'mesh', vertices: [0, 0, 10, 0, 0, 10], triangles: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1], texture: 'clothTex' },
      },
    ],
    bindings: [
      { target: 'bone:fore.rotation', params: ['Bend'], keys: [{ at: [0], value: 30 }, { at: [1], value: 90 }] },
      {
        target: 'warp:face.offsets',
        params: ['AngleX', 'AngleY'],
        keys: [
          { at: [-30, -30], value: { '4': [-10, -10] } },
          { at: [30, -30], value: { '4': [10, -10] } },
          { at: [-30, 0], value: { '4': [-10, 0] } },
          { at: [30, 0], value: { '4': [10, 0] } },
          { at: [-30, 30], value: { '4': [-10, 10] } },
          { at: [30, 30], value: { '4': [10, 10] } },
        ],
      },
      { target: 'part:mouth.shape.points', params: ['AngleX'], keys: [{ at: [-30], value: { '0': [180, 170] } }, { at: [30], value: { '1': [220, 170] } }] },
      { id: 'handTurn', target: 'bone:hand.rotation', params: ['Sway'], keys: [{ at: [-10], value: -20 }, { at: [10], value: 20 }] },
      { target: 'ik:armIk.mix', params: ['Bend'], keys: [{ at: [0], value: 1 }, { at: [1], value: 0.5 }] },
      { target: 'part:head.opacity', params: ['AngleY'], keys: [{ at: [-30], value: 1 }, { at: [30], value: 0.8 }] },
    ],
    ik: [{ id: 'armIk', bones: ['upper', 'fore'], target: 'target', mix: 1 }],
    physics: [{ id: 'hair', inputs: [{ param: 'AngleX', type: 'x', weight: 1 }], outputs: [{ param: 'Sway', type: 'angle' }] }],
    animations: [
      {
        id: 'wave',
        duration: 2,
        tracks: [
          { target: 'bone:fore.rotation', keys: [{ t: 0, v: 30 }, { t: 1, v: 60 }] },
          { target: 'param:AngleX', keys: [{ t: 0, v: 0 }, { t: 1, v: 30 }] },
          { target: 'bone:hand.rotation', keys: [{ t: 0, v: 0 }, { t: 1, v: 45 }] },
        ],
      },
    ],
  };
}

/** A minimal valid model with nothing in it. */
export function emptyDoc(): Raw {
  return { format: 'rev2d', version: 1, meta: { name: 'empty', width: 400, height: 400 } };
}

/** Apply ops and expect success with no validation errors; returns the new document. */
export function applyOk(doc: unknown, ops: Op[], opts?: ApplyOpsOptions): { doc: Raw; result: ApplyOpsResult; messages: string[] } {
  const result = applyOps(doc, ops, opts);
  const failed = result.results.find((r) => !r.ok);
  if (failed) throw new Error(`op ${failed.index} (${failed.op}) failed: ${failed.message}${failed.hint ? ` [hint: ${failed.hint}]` : ''}`);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new Error(`result does not validate:\n${formatDiagnostics(errors)}`);
  expect(result.ok).toBe(true);
  return { doc: result.doc as Raw, result, messages: result.results.map((r) => r.message) };
}

/** Apply ops expecting op `index` (default: the last one) to fail; returns that result. */
export function applyFail(doc: unknown, ops: Op[], index = ops.length - 1) {
  const result = applyOps(doc, ops);
  expect(result.ok).toBe(false);
  expect(result.doc).toBe(doc);
  const r = result.results[index];
  expect(r.ok, `op ${index} should fail`).toBe(false);
  return r;
}

/** Setup world matrix of every bone, computed by the core rig compiler (independent of ops). */
export function setupWorlds(doc: unknown): Record<string, Mat2D> {
  const { model, diagnostics } = validateModel(doc);
  if (!model) throw new Error(formatDiagnostics(diagnostics));
  const rig = new Rig(model);
  return Object.fromEntries(rig.compiled.bones.map((b) => [b.id, b.setupWorld]));
}

export function expectMatClose(a: Mat2D, b: Mat2D, digits = 6): void {
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
}

export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
}

export function find(doc: Raw, section: string, id: string): Raw {
  const item = (doc[section] as Raw[]).find((x) => x.id === id);
  if (!item) throw new Error(`${section} has no ${id}`);
  return item;
}
