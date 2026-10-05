/**
 * Test helpers for the Spine importer: hand-written fixtures, rigs from imported docs, and INDEPENDENT
 * reference math (plain trigonometry and dense curve sampling, not the importer's own modules).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { Rig, buildRenderList } from '../../../core/rig.js';
import type { ImageRGBA, Model, Pose, PoseOptions } from '../../../core/types.js';
import { validateModel } from '../../../core/validate.js';
import { decodePNG, renderImage } from '../../../render/index.js';
import type { SpineImportResult } from '../../types.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixtureText(name: string): string {
  return readFileSync(path.join(DIR, name), 'utf8');
}

export function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(fixtureText(name)) as Record<string, unknown>;
}

/** An RGBA8 image filled by `fill(x, y)` (straight alpha). */
export function makeImage(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): ImageRGBA {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(fill(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}

export interface Loaded {
  model: Model;
  rig: Rig;
  /** Decoded textures by texture id (from the result's files). */
  textures: Record<string, ImageRGBA>;
}

/** Validate an imported doc (no errors allowed) and compile it into a rig with its textures. */
export function load(res: SpineImportResult): Loaded {
  const v = validateModel(res.doc);
  const errors = v.diagnostics.filter((d) => d.severity === 'error');
  expect(errors, JSON.stringify(errors.slice(0, 5))).toEqual([]);
  const model = v.model!;
  const textures: Record<string, ImageRGBA> = {};
  const info: Record<string, { width: number; height: number }> = {};
  for (const t of model.textures) {
    const file = res.files.find((f) => f.path === t.path);
    expect(file, `file for texture ${t.id}`).toBeDefined();
    textures[t.id] = decodePNG(file!.bytes!);
    info[t.id] = { width: textures[t.id].width, height: textures[t.id].height };
  }
  return { model, rig: new Rig(model, { textures: info }), textures };
}

export function render(l: Loaded, opts: PoseOptions = {}): { pose: Pose; image: ImageRGBA } {
  const pose = l.rig.pose(opts);
  return { pose, image: renderImage(buildRenderList(l.rig, pose), l.textures, { background: [0, 0, 0, 0] }) };
}

export function pixel(img: ImageRGBA, x: number, y: number): [number, number, number, number] {
  const i = (Math.floor(y) * img.width + Math.floor(x)) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

export function part(doc: Record<string, unknown>, id: string): Record<string, any> {
  const p = (doc.parts as Array<Record<string, any>>).find((x) => x.id === id);
  expect(p, `part ${id}`).toBeDefined();
  return p!;
}

export function bone(doc: Record<string, unknown>, id: string): Record<string, any> {
  const b = (doc.bones as Array<Record<string, any>>).find((x) => x.id === id);
  expect(b, `bone ${id}`).toBeDefined();
  return b!;
}

export function animation(doc: Record<string, unknown>, id: string): Record<string, any> {
  const a = (doc.animations as Array<Record<string, any>>).find((x) => x.id === id);
  expect(a, `animation ${id}`).toBeDefined();
  return a!;
}

export function track(doc: Record<string, unknown>, anim: string, target: string): Array<{ t: number; v: any; ease?: unknown }> | undefined {
  return animation(doc, anim).tracks.find((t: { target: string }) => t.target === target)?.keys;
}

export function codes(res: SpineImportResult): string[] {
  return res.report.issues.map((i) => i.code);
}

export function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, tol = 1e-6): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (Math.abs(actual[i] - expected[i]) > tol) {
      throw new Error(`index ${i}: ${actual[i]} != ${expected[i]} (tol ${tol})\nactual   ${Array.from(actual).join(', ')}\nexpected ${Array.from(expected).join(', ')}`);
    }
  }
}

// ----------------------------------------------------------------------------- independent Spine math

/** Spine-space affine transform: x' = a·x + b·y + x0, y' = c·x + d·y + y0 (row-major, like the Spine docs). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Spine local transform (y up, CCW degrees, shear on each axis). */
export function spineLocal(b: { x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number; shearX?: number; shearY?: number }): Affine {
  const r = b.rotation ?? 0;
  const sx = b.scaleX ?? 1;
  const sy = b.scaleY ?? 1;
  const ax = rad(r + (b.shearX ?? 0));
  const ay = rad(r + 90 + (b.shearY ?? 0));
  return { a: Math.cos(ax) * sx, c: Math.sin(ax) * sx, b: Math.cos(ay) * sy, d: Math.sin(ay) * sy, x: b.x ?? 0, y: b.y ?? 0 };
}

export function compose(p: Affine, l: Affine): Affine {
  return {
    a: p.a * l.a + p.b * l.c,
    b: p.a * l.b + p.b * l.d,
    c: p.c * l.a + p.d * l.c,
    d: p.c * l.b + p.d * l.d,
    x: p.a * l.x + p.b * l.y + p.x,
    y: p.c * l.x + p.d * l.y + p.y,
  };
}

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m.a * x + m.b * y + m.x, m.c * x + m.d * y + m.y];
}

/** Setup world transforms by bone name, normal inheritance only. */
export function spineWorlds(bones: Array<Record<string, any>>): Record<string, Affine> {
  const out: Record<string, Affine> = {};
  for (const b of bones) {
    const l = spineLocal(b);
    out[b.name] = b.parent ? compose(out[b.parent], l) : l;
  }
  return out;
}

/** Canvas mapping of an import: root bone at Spine (0, 0) sits at (ox, oy); canvas = (ox + S·x, oy − S·y). */
export function canvasOf(doc: Record<string, unknown>, scale = 1): (x: number, y: number) => [number, number] {
  const root = (doc.bones as Array<Record<string, any>>)[0];
  const ox = root.x ?? 0;
  const oy = root.y ?? 0;
  return (x, y) => [ox + scale * x, oy - scale * y];
}

/**
 * Reference value of a Spine bezier segment at time t: the parametric curve sampled densely and
 * interpolated linearly in time (like the Spine runtimes, with far more samples).
 */
export function bezierRef(t0: number, v0: number, cx1: number, cy1: number, cx2: number, cy2: number, t1: number, v1: number, t: number): number {
  const N = 20000;
  let px = t0;
  let py = v0;
  for (let i = 1; i <= N; i++) {
    const u = i / N;
    const m = 1 - u;
    const x = m * m * m * t0 + 3 * m * m * u * cx1 + 3 * m * u * u * cx2 + u * u * u * t1;
    const y = m * m * m * v0 + 3 * m * m * u * cy1 + 3 * m * u * u * cy2 + u * u * u * v1;
    if (x >= t) return x === px ? y : py + ((t - px) / (x - px)) * (y - py);
    px = x;
    py = y;
  }
  return v1;
}
