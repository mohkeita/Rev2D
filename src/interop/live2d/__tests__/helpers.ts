/**
 * Test helpers for the Live2D converters: a small hand-written Rev2D model, fixture loading, a
 * reference motion3 evaluator written independently from the converter (straight from the public
 * motion3.json description) and Rev2D rig sampling.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rig } from '../../../core/rig.js';
import type { Model } from '../../../core/types.js';
import { validateModel } from '../../../core/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, 'fixtures', 'mini');
export const REPO = join(here, '..', '..', '..', '..');

export function fixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8');
}

/** readFile for importLive2dModel3 over the fixture directory. */
export function fixtureReader(path: string): string | undefined {
  const p = join(FIXTURES, path);
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
}

export function hanaRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO, 'examples', 'hana', 'hana.r2d.json'), 'utf8'));
}

export function hanaModel(): Model {
  return normalize(hanaRaw());
}

/** A minimal valid Rev2D model with Live2D-style parameters (raw JSON). */
export function miniRaw(): Record<string, unknown> {
  return {
    format: 'rev2d',
    version: 1,
    meta: { name: 'mini', width: 100, height: 100 },
    parameters: [
      { id: 'AngleX', min: -30, max: 30, default: 0, description: 'existing', group: 'Head' },
      { id: 'AngleY', min: -30, max: 30, default: 0 },
      { id: 'AngleZ', min: -30, max: 30, default: 0 },
      { id: 'EyeLOpen', min: 0, max: 1, default: 1 },
      { id: 'EyeROpen', min: 0, max: 1, default: 1 },
      { id: 'MouthOpen', min: 0, max: 1, default: 0 },
      { id: 'MouthForm', min: -1, max: 1, default: 0 },
      { id: 'BrowLY', min: -1, max: 1, default: 0 },
      { id: 'Cheek', min: 0, max: 1, default: 0 },
      { id: 'BodyAngleX', min: -10, max: 10, default: 0 },
      { id: 'Breath', min: 0, max: 1, default: 0 },
      { id: 'HairFront', min: -1, max: 1, default: 0 },
      { id: 'HairBack', min: -1, max: 1, default: 0 },
    ],
    parts: [
      { id: 'PartArm', shape: { type: 'rect', x: 10, y: 10, w: 20, h: 30 }, fill: '#c08040' },
      { id: 'face', shape: { type: 'ellipse', cx: 50, cy: 40, rx: 20, ry: 24 }, fill: '#f0d0c0' },
    ],
    physics: [
      {
        id: 'oldHair',
        inputs: [{ param: 'AngleX', type: 'x', weight: 1 }],
        outputs: [{ param: 'HairFront', type: 'angle', scale: 0.05 }],
        segments: [{ length: 30, mass: 1 }],
      },
    ],
    animations: [{ id: 'wave', duration: 1, loop: true, tracks: [{ target: 'param:AngleX', keys: [{ t: 0, v: 0 }] }] }],
  };
}

export function normalize(raw: unknown): Model {
  const v = validateModel(raw);
  if (!v.model) throw new Error(`invalid model: ${v.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.path} ${d.code} ${d.message}`).join('; ')}`);
  return v.model;
}

/** Replace (or add) an animation in a raw model and normalize the result. */
export function withAnimation(raw: Record<string, unknown>, animation: Record<string, unknown>, extraParams: Array<Record<string, unknown>> = []): Model {
  const doc = structuredClone(raw) as Record<string, unknown>;
  const anims = ((doc.animations as unknown[]) ?? []).filter((a) => (a as { id: string }).id !== animation.id);
  doc.animations = [...anims, animation];
  if (extraParams.length) doc.parameters = [...(doc.parameters as unknown[]), ...extraParams];
  return normalize(doc);
}

const rigs = new WeakMap<Model, Rig>();

/** Parameter values of one animation played alone at local time t (no physics). Rigs are cached per model. */
export function sampleParams(model: Model, animationId: string, t: number): Record<string, number> {
  let rig = rigs.get(model);
  if (!rig) rigs.set(model, (rig = new Rig(model)));
  return rig.pose({ time: t, animations: [{ id: animationId, time: t }], physics: false }).params;
}

// ----------------------------------------------------------------------------- reference evaluator

interface RefSegment {
  type: number;
  pts: Array<[number, number]>;
}

/**
 * Value of a motion3 curve at time t, per the public motion3.json description and the Cubism runtime
 * rules: the first segment whose end time is after t is evaluated (linear: interpolation clamped at the
 * start; Bézier: restricted files use normalized time as the curve parameter, others solve the time
 * cubic; stepped: start value; inverse stepped: end value); after the last point its value holds.
 */
export function refEval(segments: number[], restricted: boolean, t: number): number {
  const segs: RefSegment[] = [];
  let prev: [number, number] = [segments[0], segments[1]];
  for (let i = 2; i < segments.length; ) {
    const type = segments[i];
    const n = type === 1 ? 3 : 1;
    const pts: Array<[number, number]> = [prev];
    for (let k = 0; k < n; k++) pts.push([segments[i + 1 + 2 * k], segments[i + 2 + 2 * k]]);
    segs.push({ type, pts });
    prev = pts[pts.length - 1];
    i += 1 + 2 * n;
  }
  const seg = segs.find((s) => s.pts[s.pts.length - 1][0] > t);
  if (!seg) return prev[1];
  const [p0, ...rest] = seg.pts;
  const end = rest[rest.length - 1];
  if (seg.type === 2) return p0[1];
  if (seg.type === 3) return end[1];
  if (seg.type === 0) return p0[1] + (end[1] - p0[1]) * Math.max(0, (t - p0[0]) / (end[0] - p0[0]));
  const [p1, p2, p3] = rest;
  const bez = (a: number, b: number, c: number, d: number, u: number) => (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * b + 3 * (1 - u) * u * u * c + u ** 3 * d;
  let u: number;
  if (restricted) u = Math.max(0, (t - p0[0]) / (p3[0] - p0[0]));
  else {
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 80; k++) {
      const mid = (lo + hi) / 2;
      if (bez(p0[0], p1[0], p2[0], p3[0], mid) < t) lo = mid;
      else hi = mid;
    }
    u = t <= p0[0] ? 0 : (lo + hi) / 2;
  }
  return bez(p0[1], p1[1], p2[1], p3[1], u);
}

/** Recount a motion3 file's curves, segments and points the way the Cubism SDK does. */
export function countMotion(motion3: Record<string, unknown>): { curves: number; segments: number; points: number } {
  const curves = motion3.Curves as Array<{ Segments: number[] }>;
  let segments = 0;
  let points = 0;
  for (const c of curves) {
    const s = c.Segments;
    points++;
    for (let i = 2; i < s.length; ) {
      const bez = s[i] === 1;
      points += bez ? 3 : 1;
      segments++;
      i += bez ? 7 : 3;
    }
  }
  return { curves: curves.length, segments, points };
}

export function codes(report: { issues: Array<{ code: string }> }): string[] {
  return report.issues.map((i) => i.code);
}

// ----------------------------------------------------------------------------- reference physics

export interface RefRange {
  min: number;
  max: number;
}

/**
 * Pendulum simulation of ONE physics3 setting, written for these tests independently of the converter.
 * It is not Cubism SDK code; its results were compared locally with the physics of the Cubism SDK for
 * Web, which is how the details below were settled.
 *
 * Inputs are normalized from the middle of the parameter range onto
 * the Normalization range and negated unless Reflect, then scaled by Weight / 100; Angle inputs turn the
 * gravity direction (sin a, cos a); each step (1 / fps) a particle is turned by 1/5 of the gravity's
 * change, moved by velocity × delay + gravity × Acceleration × delay² (delay = Delay × dt × 30), put
 * back at Radius from the previous particle, and keeps (move / delay) × Mobility as velocity. Outputs:
 * X / Y = the segment's extent, Angle = its angle from straight down (vertex 1) or from the previous
 * segment (vertex >= 2), × Scale, negated when Reflect. Returns, per step, the output values (unclamped).
 */
export function refCubismPhysics(setting: any, ranges: Record<string, RefRange>, drive: (t: number) => Record<string, number>, fps: number, seconds: number): number[][] {
  type V = { x: number; y: number };
  const ps = (setting.Vertices as any[]).map((v) => ({ pos: { x: 0, y: 0 } as V, vel: { x: 0, y: 0 } as V, lastG: { x: 0, y: 1 } as V, v }));
  for (let i = 1; i < ps.length; i++) ps[i].pos = { x: 0, y: ps[i - 1].pos.y + ps[i].v.Radius };
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const norm = (value: number, r: RefRange, n: any, reflect: boolean) => {
    const v = Math.min(Math.max(value, r.min), r.max);
    const mid = (r.min + r.max) / 2;
    const d = v - mid;
    const out = d > 0 ? (d * (n.Maximum - n.Default)) / (r.max - mid) + n.Default : d < 0 ? (d * (n.Minimum - n.Default)) / (r.min - mid) + n.Default : n.Default;
    return reflect ? out : -out;
  };
  const dt = 1 / fps;
  const rows: number[][] = [];
  for (let k = 1; k <= Math.round(seconds * fps); k++) {
    const params = drive(k * dt);
    let tx = 0;
    let ty = 0;
    let ta = 0;
    for (const inp of setting.Input) {
      const value = params[inp.Source.Id] ?? 0;
      const w = inp.Weight / 100;
      const n = inp.Type === 'Angle' ? setting.Normalization.Angle : setting.Normalization.Position;
      const x = norm(value, ranges[inp.Source.Id], n, inp.Reflect === true) * w;
      if (inp.Type === 'X') tx += x;
      else if (inp.Type === 'Y') ty += x;
      else ta += x;
    }
    const ra = (-ta * Math.PI) / 180;
    const px = tx * Math.cos(ra) - ty * Math.sin(ra);
    ps[0].pos = { x: px, y: px * Math.sin(ra) + ty * Math.cos(ra) };
    const g = { x: Math.sin((ta * Math.PI) / 180), y: Math.cos((ta * Math.PI) / 180) };
    for (let i = 1; i < ps.length; i++) {
      const p = ps[i];
      const last = { ...p.pos };
      const delay = p.v.Delay * dt * 30;
      const d = { x: p.pos.x - ps[i - 1].pos.x, y: p.pos.y - ps[i - 1].pos.y };
      const rad = wrap(Math.atan2(g.y, g.x) - Math.atan2(p.lastG.y, p.lastG.x)) / 5;
      const rx = Math.cos(rad) * d.x - d.y * Math.sin(rad);
      const ry = Math.sin(rad) * rx + d.y * Math.cos(rad);
      const nx = rx + p.vel.x * delay + g.x * p.v.Acceleration * delay * delay;
      const ny = ry + p.vel.y * delay + g.y * p.v.Acceleration * delay * delay;
      const len = Math.hypot(nx, ny) || 1;
      p.pos = { x: ps[i - 1].pos.x + (nx / len) * p.v.Radius, y: ps[i - 1].pos.y + (ny / len) * p.v.Radius };
      if (Math.abs(p.pos.x) < 0.001 * setting.Normalization.Position.Maximum) p.pos.x = 0;
      if (delay !== 0) p.vel = { x: ((p.pos.x - last.x) / delay) * p.v.Mobility, y: ((p.pos.y - last.y) / delay) * p.v.Mobility };
      p.lastG = g;
    }
    rows.push(
      (setting.Output as any[]).map((o) => {
        const vi = o.VertexIndex;
        const seg = { x: ps[vi].pos.x - ps[vi - 1].pos.x, y: ps[vi].pos.y - ps[vi - 1].pos.y };
        let value: number;
        if (o.Type === 'X') value = seg.x;
        else if (o.Type === 'Y') value = seg.y;
        else {
          const parent = vi >= 2 ? { x: ps[vi - 1].pos.x - ps[vi - 2].pos.x, y: ps[vi - 1].pos.y - ps[vi - 2].pos.y } : { x: 0, y: 1 };
          value = wrap(Math.atan2(seg.y, seg.x) - Math.atan2(parent.y, parent.x));
        }
        return (o.Reflect ? -value : value) * o.Scale;
      }),
    );
  }
  return rows;
}
