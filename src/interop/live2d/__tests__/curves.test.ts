import { describe, expect, it } from 'vitest';
import { easeFn } from '../../../core/easing.js';
import { keyTangents } from '../../../core/rig/curves.js';
import type { Ease } from '../../../core/types.js';
import {
  clipCurve,
  type Curve,
  curveToKeys,
  decodeSegments,
  encodeSegments,
  evalCurve,
  JUMP,
  keysToCurve,
  type Piece,
  rotateLoop,
  splitPiece,
} from '../curves.js';
import { normalize, refEval, sampleParams } from './helpers.js';

function decode(seg: number[], restricted = true): Curve {
  const r = decodeSegments(seg, restricted);
  if (!r.ok) throw new Error(r.error);
  return r.curve;
}

/** Evaluate Rev2D keys through a real rig (one parameter P with a huge range). */
function rev2dEval(keys: Array<{ t: number; v: number; ease?: Ease }>, duration: number): (t: number) => number {
  const model = normalize({
    format: 'rev2d',
    version: 1,
    meta: { name: 'c', width: 10, height: 10 },
    parameters: [{ id: 'P', min: -1e6, max: 1e6 }],
    animations: [{ id: 'a', duration, loop: false, tracks: [{ target: 'param:P', keys }] }],
  });
  return (t) => sampleParams(model, 'a', t).P;
}

const times = (d: number, n = 200) => Array.from({ length: n + 1 }, (_, i) => (d * i) / n);

describe('live2d curves: motion3 segments', () => {
  it('decodes every segment type and evaluates like the Cubism runtime', () => {
    const seg = [0, 1, 0, 1, 3, 1, 1.5, 3, 1.75, 0, 2, 1, 2, 2.5, 4, 3, 3, 6];
    const c = decode(seg);
    expect(c.pieces.map((p) => p.kind)).toEqual(['linear', 'bezier', 'step', 'inverse']);
    for (const t of [-1, 0, 0.5, 1, 1.25, 2, 2.2, 2.5, 2.7, 3, 4]) expect(evalCurve(c, t)).toBeCloseTo(refEval(seg, true, t), 12);
    // Boundaries: the later segment wins; inverse stepped jumps at its start, stepped at its end.
    expect(evalCurve(c, 2.4999)).toBe(1);
    expect(evalCurve(c, 2.5)).toBe(6);
    expect(evalCurve(c, 3)).toBe(6);
  });

  it('reports malformed segments with their position', () => {
    expect(decodeSegments([0], true)).toMatchObject({ ok: false });
    expect(decodeSegments([0, 1, 7, 1, 1], true)).toMatchObject({ ok: false, at: 2 });
    expect(decodeSegments([0, 1, 1, 0.3, 1, 0.6], true)).toMatchObject({ ok: false, error: expect.stringContaining('cut short') });
    expect(decodeSegments([1, 1, 0, 0.5, 2], true)).toMatchObject({ ok: false, error: expect.stringContaining('before its start') });
    expect(decodeSegments([0, 'x'], true)).toMatchObject({ ok: false, at: 1 });
    expect(decodeSegments('nope', true)).toMatchObject({ ok: false });
  });

  it('encodes with the SDK point counts and marks restricted Béziers', () => {
    const c = decode([0, 0, 0, 1, 1, 1, 1.2, 1, 1.4, 2, 2, 3, 2, 2.5, 3, 3, 3, 1], false);
    const enc = encodeSegments(c, 3);
    expect(enc.segmentCount).toBe(4);
    expect(enc.pointCount).toBe(1 + 1 + 3 + 1 + 1);
    expect(enc.restrictedOk).toBe(false); // handles at 0.2 / 0.4 of a 1 s segment
    const thirds = encodeSegments(decode([0, 0, 1, 1 / 3, 1, 2 / 3, 2, 1, 3], false), 1);
    expect(thirds.restrictedOk).toBe(true);
    // A curve without segments becomes one constant segment over the duration.
    expect(encodeSegments({ t: 0.5, v: 7, pieces: [] }, 2).segments).toEqual([0, 7, 0, 2, 7]);
    // A value jump between pieces becomes a zero-length stepped segment.
    const jump: Curve = { t: 0, v: 0, pieces: [{ kind: 'linear', t0: 0, v0: 0, t1: 1, v1: 1 }, { kind: 'linear', t0: 1, v0: 5, t1: 2, v1: 5 }] };
    const j = encodeSegments(jump, 2);
    expect(j.segments).toEqual([0, 0, 0, 1, 1, 2, 1, 5, 0, 2, 5]);
    expect(refEval(j.segments, true, 1)).toBe(5);
    expect(refEval(j.segments, true, 0.999)).toBeCloseTo(0.999, 9);
  });

  it('splits every piece kind exactly', () => {
    const pieces: Piece[] = [
      { kind: 'linear', t0: 0, v0: 1, t1: 2, v1: 5 },
      { kind: 'step', t0: 0, v0: 1, t1: 2, v1: 5 },
      { kind: 'inverse', t0: 0, v0: 1, t1: 2, v1: 5 },
      { kind: 'bezier', t0: 0, v0: 1, t1: 2, v1: 5, c1t: 2 / 3, c1v: 9, c2t: 4 / 3, c2v: -3, byTime: true },
      { kind: 'bezier', t0: 0, v0: 1, t1: 2, v1: 5, c1t: 0.2, c1v: 9, c2t: 1.9, c2v: -3, byTime: false },
    ];
    for (const p of pieces) {
      const whole: Curve = { t: 0, v: p.v0, pieces: [p] };
      const [a, b] = splitPiece(p, 0.7);
      const split: Curve = { t: 0, v: p.v0, pieces: [a, b] };
      for (const t of times(2, 50)) if (Math.abs(t - 0.7) > 1e-9) expect(evalCurve(split, t)).toBeCloseTo(evalCurve(whole, t), 9);
    }
  });

  it('clips curves and rotates loops', () => {
    const c = decode([0.5, 0, 0, 1.5, 10]);
    const clipped = clipCurve(c, 1, 1.2);
    expect(clipped.pieces).toHaveLength(1);
    expect(evalCurve(clipped, 1)).toBeCloseTo(5);
    expect(evalCurve(clipped, 1.2)).toBeCloseTo(7);
    // Loop of 2 s shifted by 0.5 s: f(t) = g((t - 0.5) mod 2).
    const g = decode([0, 0, 0, 1, 10, 0, 2, 0]);
    const f = rotateLoop(g, 2, 0.5);
    for (const t of times(2, 40)) expect(evalCurve(f, t)).toBeCloseTo(evalCurve(g, (((t - 0.5) % 2) + 2) % 2), 9);
  });
});

describe('live2d curves: Rev2D keys', () => {
  it('turns segments into keys that the Rev2D rig evaluates exactly like Cubism', () => {
    const cases: Array<[number[], boolean]> = [
      [[0, 0, 1, 0.333, 10, 0.667, 20, 1, 20, 0, 1.5, -10, 2, 1.8, 5, 0, 2, 0], true],
      [[0, 0, 1, 0.1, 10, 0.3, 10, 0.5, 10, 1, 0.6, -4, 0.95, 12, 1, 0], false],
      // Flat Bézier (same start and end value): split at its extremum.
      [[0, 0, 1, 0.2, 1, 0.4, 1, 0.6, 0, 0, 1, 0], true],
      // S-shaped flat Bézier: two extrema.
      [[0, 0, 1, 0.333, 3, 0.667, -3, 1, 0], true],
    ];
    for (const [seg, restricted] of cases) {
      const res = curveToKeys(decode(seg, restricted), 30);
      const f = rev2dEval(res.keys, 2);
      for (const t of times(1.99)) expect(f(t)).toBeCloseTo(refEval(seg, restricted, t), 5);
    }
    const flat = curveToKeys(decode([0, 0, 1, 0.2, 1, 0.4, 1, 0.6, 0], true), 30);
    expect(flat.splitKeys).toBe(1);
  });

  it('delays jumps (inverse stepped, zero-length segments) by JUMP seconds', () => {
    const seg = [0, 0, 0, 1, 1, 3, 2, 5, 0, 3, 5];
    const res = curveToKeys(decode(seg), 30);
    expect(res.jumps).toBe(1);
    const f = rev2dEval(res.keys, 3);
    for (const t of [0.5, 0.99, 1 + 2 * JUMP, 1.5, 2.5, 3]) expect(f(t)).toBeCloseTo(refEval(seg, true, t), 6);
    for (let i = 1; i < res.keys.length; i++) expect(res.keys[i].t - res.keys[i - 1].t).toBeGreaterThanOrEqual(JUMP - 1e-12);
  });

  it('samples Béziers whose handle times leave the segment', () => {
    // Handles outside [t0, t1] but a monotonic time curve: exact at every sample.
    const seg = [0, 0, 1, 1.1, 10, 0.9, -5, 1, 0];
    const res = curveToKeys(decode(seg, false), 30);
    expect(res.sampledSegments).toBe(1);
    expect(res.keys.length).toBeGreaterThan(20);
    const f = rev2dEval(res.keys, 1);
    for (let k = 0; k <= 30; k++) expect(f(k / 30)).toBeCloseTo(refEval(seg, false, k / 30), 9);
    // A time curve that folds back has several points per time: the smallest curve parameter is used.
    const folded = curveToKeys(decode([0, 0, 1, 1.4, 10, -0.2, -5, 1, 0], false), 30);
    expect(folded.sampledSegments).toBe(1);
    for (let i = 1; i < folded.keys.length; i++) expect(folded.keys[i].t).toBeGreaterThan(folded.keys[i - 1].t);
  });

  it('converts every Rev2D ease: exact where polynomial, fitted within tolerance otherwise', () => {
    const eases: Ease[] = ['linear', 'step', 'inQuad', 'outQuad', 'inOutQuad', 'inCubic', 'outCubic', 'inOutCubic', 'inBack', 'outBack', 'inOutBack', 'outBounce', 'inSine', 'outSine', 'inOutSine', 'outElastic', [0.42, 0, 0.58, 1], [0.3333, 0.2, 0.6667, 1.4], [0.5, -0.5, 1.5, 1]];
    for (const ease of eases) {
      const conv: Array<{ exact: boolean; maxError: number }> = [];
      const curve = keysToCurve([{ t: 0.25, v: -3, ease }, { t: 1.25, v: 7, ease: 'linear' }], null, 0.001, (_i, c) => conv.push(c));
      const enc = encodeSegments(curve, 2);
      const exact = conv.every((c) => c.exact);
      if (Array.isArray(ease) && ease[2] > 1) {
        // Not a CSS timing function: Rev2D's own solver is erratic there; sampled, never "exact".
        expect(conv[0]).toMatchObject({ exact: false, ease: 'cubic-bezier (x outside 0..1)' });
        continue;
      }
      // Written files keep 6 decimals: "exact" means within that rounding.
      const tol = exact ? 1e-4 : 10 * 0.001 + 1e-4;
      const fn = easeFn(ease);
      for (const t of times(1.5, 150)) {
        const s = Math.min(1, Math.max(0, (t - 0.25) / 1));
        const want = ease === 'step' ? (t < 1.25 ? -3 : 7) : -3 + 10 * fn(s);
        expect(Math.abs(refEval(enc.segments, enc.restrictedOk, t) - want)).toBeLessThanOrEqual(tol);
      }
      if (['inQuad', 'outQuad', 'inOutQuad', 'inCubic', 'outCubic', 'inOutCubic', 'inBack', 'outBack', 'inOutBack', 'outBounce'].includes(ease as string)) expect(exact).toBe(true);
      if (ease === 'inOutSine') expect(conv[0]).toMatchObject({ exact: false });
    }
  });

  it('writes smooth (Catmull-Rom) segments as exact Béziers', () => {
    const keys = [
      { t: 0, v: 0, ease: 'smooth' as const },
      { t: 0.4, v: 10, ease: 'smooth' as const },
      { t: 1.3, v: -4, ease: 'smooth' as const },
      { t: 2, v: 0, ease: 'linear' as const },
    ];
    const model = normalize({
      format: 'rev2d',
      version: 1,
      meta: { name: 'c', width: 10, height: 10 },
      parameters: [{ id: 'P', min: -100, max: 100 }],
      animations: [{ id: 'a', duration: 2, loop: true, tracks: [{ target: 'param:P', keys }] }],
    });
    const tangents = keyTangents(keys.map((k) => k.t), keys.map((k) => k.v), true, 2);
    const curve = keysToCurve(keys, tangents, 0.001, () => {});
    const enc = encodeSegments(curve, 2);
    expect(enc.restrictedOk).toBe(true);
    for (const t of times(2, 100)) expect(refEval(enc.segments, true, t)).toBeCloseTo(sampleParams(model, 'a', t).P, 6);
  });
});

