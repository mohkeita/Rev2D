/**
 * Test helpers for the Spine exporter: example models and an INDEPENDENT evaluation of an exported
 * Spine skeleton (bone timelines with linear / Bézier keys, deform keys with percent curves, weighted
 * and unweighted mesh vertices, slot colors, draw order), written from the Spine JSON format
 * documentation without using the exporter's or the importer's modules.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { loadModelFile } from '../../../node/load.js';
import type { ImageRGBA, Model } from '../../../core/types.js';
import type { Rig } from '../../../core/rig.js';
import { compose, makeImage, spineLocal, type Affine } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface Example {
  model: Model;
  rig: Rig;
  textures: Record<string, ImageRGBA>;
}

const cache = new Map<string, Promise<Example>>();

export function loadExample(name: string): Promise<Example> {
  let p = cache.get(name);
  if (!p) {
    p = loadModelFile(path.join(ROOT, 'examples', name, `${name}.r2d.json`)).then((l) => {
      expect(l.rig, JSON.stringify(l.diagnostics.slice(0, 3))).toBeTruthy();
      return { model: l.model!, rig: l.rig!, textures: l.textures };
    });
    cache.set(name, p);
  }
  return p;
}

// ----------------------------------------------------------------------------- independent Spine evaluation

type Json = Record<string, any>;

/** Value of a Bézier segment at time t: solve x(u) = t by bisection, then y(u). */
function bezierAt(t0: number, v0: number, c: number[], t1: number, v1: number, t: number): number {
  const b = (p0: number, p1: number, p2: number, p3: number, u: number) =>
    (1 - u) ** 3 * p0 + 3 * (1 - u) ** 2 * u * p1 + 3 * (1 - u) * u * u * p2 + u ** 3 * p3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (b(t0, c[0], c[2], t1, mid) < t) lo = mid;
    else hi = mid;
  }
  return b(v0, c[1], c[3], v1, (lo + hi) / 2);
}

/** Channel `ch` of a keyed timeline at time t (keys: {time?, curve?} plus values via get). */
function channelAt(keys: Json[], t: number, get: (k: Json) => number, ch: number, percent = false): number {
  const time = (k: Json) => k.time ?? 0;
  if (t <= time(keys[0])) return get(keys[0]);
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= time(b)) continue;
    const t0 = time(a);
    const t1 = time(b);
    const v0 = percent ? 0 : get(a);
    const v1 = percent ? 1 : get(b);
    if (a.curve === 'stepped') return v0;
    if (Array.isArray(a.curve)) return bezierAt(t0, v0, a.curve.slice(ch * 4, ch * 4 + 4), t1, v1, t);
    return v0 + ((t - t0) / (t1 - t0)) * (v1 - v0);
  }
  return percent ? 1 : get(keys[keys.length - 1]);
}

function hexColor(s: string): number[] {
  return [0, 2, 4, 6].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
}

export interface SpineState {
  /** World transforms by bone name (Spine space, y up). */
  bones: Map<string, Affine>;
  /** World vertices (Spine space) of each slot's setup attachment. */
  vertices: Map<string, number[]>;
  /** Slot colors (RGBA 0..1). */
  colors: Map<string, number[]>;
  /** Slot names in draw order. */
  order: string[];
}

/** Evaluate a Spine skeleton JSON (4.x layout) at time `t` of `anim` (null = setup pose). */
export function evalSpine(json: Json, anim: string | null, t: number): SpineState {
  const a: Json = anim ? json.animations[anim] : {};
  const bones = new Map<string, Affine>();
  const boneIndex: string[] = [];
  for (const b of json.bones as Json[]) {
    const tl = a.bones?.[b.name] ?? {};
    const local = { x: b.x ?? 0, y: b.y ?? 0, rotation: b.rotation ?? 0, scaleX: b.scaleX ?? 1, scaleY: b.scaleY ?? 1 };
    if (tl.rotate) local.rotation += channelAt(tl.rotate, t, (k) => k.value ?? 0, 0);
    if (tl.translate) {
      local.x += channelAt(tl.translate, t, (k) => k.x ?? 0, 0);
      local.y += channelAt(tl.translate, t, (k) => k.y ?? 0, 1);
    }
    if (tl.scale) {
      local.scaleX *= channelAt(tl.scale, t, (k) => k.x ?? 1, 0);
      local.scaleY *= channelAt(tl.scale, t, (k) => k.y ?? 1, 1);
    }
    const l = spineLocal(local);
    bones.set(b.name, b.parent ? compose(bones.get(b.parent)!, l) : l);
    boneIndex.push(b.name);
  }
  const skin = (json.skins as Json[]).find((s) => s.name === 'default')!;
  const vertices = new Map<string, number[]>();
  const colors = new Map<string, number[]>();
  for (const slot of json.slots as Json[]) {
    const setupColor = hexColor(slot.color ?? 'ffffffff');
    const rgba = a.slots?.[slot.name]?.rgba;
    colors.set(slot.name, rgba ? [0, 1, 2, 3].map((ch) => channelAt(rgba, t, (k) => hexColor(k.color)[ch], ch)) : setupColor);
    const att = skin.attachments[slot.name]?.[slot.attachment];
    if (!att || (att.type !== 'mesh' && att.type !== 'clipping')) continue;
    const count = att.type === 'mesh' ? att.uvs.length / 2 : att.vertexCount;
    const weighted = att.vertices.length !== count * 2;
    const deformKeys: Json[] | undefined = a.attachments?.default?.[slot.name]?.[slot.attachment]?.deform;
    const deformLen = weighted ? (att.vertices.length - count) / 2 : count * 2;
    const deform = new Float64Array(deformLen);
    if (deformKeys) {
      const row = (k: Json) => {
        const out = new Float64Array(deformLen);
        (k.vertices ?? []).forEach((v: number, i: number) => (out[(k.offset ?? 0) + i] = v));
        return out;
      };
      const time = (k: Json) => k.time ?? 0;
      let i = 0;
      while (i + 1 < deformKeys.length && t >= time(deformKeys[i + 1])) i++;
      const A = row(deformKeys[i]);
      if (t <= time(deformKeys[0]) || i + 1 >= deformKeys.length) deform.set(t <= time(deformKeys[0]) ? row(deformKeys[0]) : A);
      else {
        const B = row(deformKeys[i + 1]);
        const p = channelAt([deformKeys[i], deformKeys[i + 1]], t, () => 0, 0, true);
        for (let j = 0; j < deformLen; j++) deform[j] = A[j] + (B[j] - A[j]) * p;
      }
    }
    const out: number[] = [];
    if (!weighted) {
      const m = bones.get(slot.bone)!;
      for (let v = 0; v < count; v++) {
        const x = att.vertices[2 * v] + deform[2 * v];
        const y = att.vertices[2 * v + 1] + deform[2 * v + 1];
        out.push(m.a * x + m.b * y + m.x, m.c * x + m.d * y + m.y);
      }
    } else {
      let i = 0;
      let d = 0;
      for (let v = 0; v < count; v++) {
        const n = att.vertices[i++];
        let wx = 0;
        let wy = 0;
        for (let k = 0; k < n; k++) {
          const m = bones.get(boneIndex[att.vertices[i]])!;
          const x = att.vertices[i + 1] + deform[d++];
          const y = att.vertices[i + 2] + deform[d++];
          const w = att.vertices[i + 3];
          wx += (m.a * x + m.b * y + m.x) * w;
          wy += (m.c * x + m.d * y + m.y) * w;
          i += 4;
        }
        out.push(wx, wy);
      }
    }
    vertices.set(slot.name, out);
  }
  // Draw order: the last key at or before t (stepped), offsets per the Spine format.
  const names = (json.slots as Json[]).map((s) => s.name);
  let order = names;
  const keys: Json[] = a.drawOrder ?? [];
  const key = [...keys].reverse().find((k) => (k.time ?? 0) <= t + 1e-9);
  if (key?.offsets) {
    const n = names.length;
    const result = new Array<number>(n).fill(-1);
    const moved = new Set<number>();
    for (const o of key.offsets) {
      const i = names.indexOf(o.slot);
      result[i + o.offset] = i;
      moved.add(i);
    }
    const rest = names.map((_, i) => i).filter((i) => !moved.has(i));
    for (let i = 0; i < n; i++) if (result[i] === -1) result[i] = rest.shift()!;
    order = result.map((i) => names[i]);
  }
  return { bones, vertices, colors, order };
}

/** Spine space -> canvas (x, −y). */
export function toCanvas(pts: number[]): number[] {
  return pts.map((v, i) => (i % 2 ? -v : v));
}

// ----------------------------------------------------------------------------- a probe model

export const CHECKER = makeImage(8, 8, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? [240, 200, 40, 255] : [40, 90, 200, 255]);

/** Hand-written model touching every exporter feature: bones with rotation/scale/color, a warp, a morphing path with a gradient, a mask and an inverted mask, a texture, a skinned mesh, IK with softness, a hidden part, a stroke-only open path, step keys, z and tint tracks, events and a paint animation. */
export const PROBE = {
  format: 'rev2d',
  version: 1,
  meta: { name: 'probe', width: 200, height: 200 },
  parameters: [
    { id: 'Bend', min: -1, max: 1 },
    { id: 'Mouth', min: 0, max: 1 },
  ],
  textures: [{ id: 'checker', path: 'checker.png', width: 8, height: 8 }],
  bones: [
    { id: 'root', x: 100, y: 150 },
    { id: 'spine', parent: 'root', y: -40, rotation: -90, length: 40, color: '#ff8800' },
    { id: 'arm', parent: 'spine', x: 40, rotation: 120, scaleX: 1.2, length: 30 },
    { id: 'forearm', parent: 'arm', x: 30, length: 25 },
    { id: 'target', x: 60, y: 150 },
  ],
  warps: [{ id: 'faceWarp', parent: 'spine', rect: [70, 30, 60, 50], cols: 2, rows: 2 }],
  parts: [
    { id: 'body', parent: 'root', shape: { type: 'rect', x: 80, y: 110, w: 40, h: 50, radius: 6 }, fill: '#3366cc', stroke: { color: '#112244', width: 2 } },
    { id: 'face', parent: 'faceWarp', shape: { type: 'ellipse', cx: 100, cy: 55, rx: 25, ry: 18, detail: 6 }, fill: { type: 'radial', center: [100, 50], radius: 30, stops: [[0, '#ffe0c0'], [1, '#e0a080']] }, z: 1 },
    {
      id: 'mouth',
      parent: 'faceWarp',
      shape: { type: 'path', d: 'M 90 62 C 95 64 105 64 110 62 C 105 66 95 66 90 62 Z' },
      fill: { type: 'linear', from: [0, 60], to: [0, 70], stops: [[0, '#aa2233'], [1, '#661122']] },
      z: 2,
    },
    { id: 'eye', parent: 'faceWarp', shape: { type: 'ellipse', cx: 100, cy: 45, rx: 6, ry: 6 }, fill: '#222222', z: 2, mask: ['face'] },
    { id: 'badge', parent: 'root', shape: { type: 'image', texture: 'checker', x: 90, y: 120, w: 20, h: 20, cols: 2, rows: 2 }, z: 3 },
    {
      id: 'sleeve',
      skin: { bones: ['arm', 'forearm'], weights: [[1, 0], [1, 0], [0.5, 0.5], [0.5, 0.5], [0, 1], [0, 1]] },
      shape: { type: 'mesh', vertices: [100, 110, 100, 100, 127, 110, 127, 100, 150, 110, 150, 100], triangles: [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4] },
      fill: '#55aa55',
      z: 4,
    },
    { id: 'hidden', shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 }, visible: false },
    { id: 'strand', parent: 'spine', shape: { type: 'path', d: 'M 100 30 Q 110 15 125 20' }, fill: 'transparent', stroke: { color: '#443322', width: 3 }, z: 5 },
    { id: 'inv', parent: 'root', shape: { type: 'ellipse', cx: 100, cy: 175, rx: 10, ry: 5 }, fill: '#000000', mask: ['body'], maskInvert: true, z: 6 },
  ],
  bindings: [
    { target: 'warp:faceWarp.offsets', params: ['Bend'], keys: [{ at: [-1], value: { '1': [-6, 0], '4': [-4, 2] } }, { at: [0], value: {} }, { at: [1], value: { '1': [6, 0], '4': [4, -2] } }] },
    { target: 'part:mouth.shape.d', params: ['Mouth'], keys: [{ at: [0], value: 'M 90 62 C 95 64 105 64 110 62 C 105 66 95 66 90 62 Z' }, { at: [1], value: 'M 88 60 C 95 62 105 62 112 60 C 106 74 94 74 88 60 Z' }] },
  ],
  ik: [{ id: 'armIk', bones: ['arm', 'forearm'], target: 'target', bendPositive: false, softness: 4 }],
  animations: [
    {
      id: 'wave',
      duration: 1,
      tracks: [
        { target: 'param:Bend', keys: [{ t: 0, v: -1, ease: 'smooth' }, { t: 0.5, v: 1, ease: 'smooth' }, { t: 1, v: -1 }] },
        { target: 'bone:target.y', keys: [{ t: 0, v: 150, ease: 'inOutSine' }, { t: 0.5, v: 110, ease: 'inOutSine' }, { t: 1, v: 150 }] },
        { target: 'part:body.tint', keys: [{ t: 0, v: '#ffffff' }, { t: 0.5, v: '#ff8080' }, { t: 1, v: '#ffffff' }] },
        { target: 'part:eye.opacity', keys: [{ t: 0, v: 1, ease: 'step' }, { t: 0.4, v: 0.25, ease: 'step' }, { t: 0.6, v: 1 }] },
        { target: 'part:strand.z', keys: [{ t: 0, v: 5, ease: 'step' }, { t: 0.5, v: -1 }] },
      ],
      events: [
        { t: 0.5, name: 'hit', data: { int: 3, string: 'x', extra: true } },
        { t: 0.25, name: 'tick', data: 2.5 },
      ],
    },
    { id: 'talk', duration: 0.6, loop: false, tracks: [{ target: 'param:Mouth', keys: [{ t: 0, v: 0 }, { t: 0.3, v: 1 }, { t: 0.6, v: 0 }] }] },
    { id: 'paint', duration: 0.5, tracks: [{ target: 'part:body.fill', keys: [{ t: 0, v: '#3366cc' }, { t: 0.5, v: '#cc3366' }] }] },
  ],
};

