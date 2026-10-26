import { it, expect } from 'vitest';
import { applyOk, applyFail, rigDoc, find } from './fixtures.js';
it('act creates a non-looping numeric move with anticipation, settling and hold', () => {
  const { doc } = applyOk(rigDoc(), [
    {
      op: 'act',
      animation: 'act',
      target: 'param:AngleX',
      from: 0,
      to: 15,
      t: 0.3,
      duration: 0.5,
      hold: 1.5,
    },
  ]);
  const a = find(doc, 'animations', 'act'),
    keys = a.tracks[0].keys;
  expect(a.loop).toBe(false);
  expect(keys[1].v).toBeLessThan(0);
  expect(keys[2].v).toBeGreaterThan(15);
  expect(keys.at(-1).v).toBe(15);
  expect(a.duration).toBeCloseTo(2.6);
});
it('act rejects nonnumeric targets, invalid timing and out-of-range overshoot atomically', () => {
  expect(
    applyFail(rigDoc(), [{ op: 'act', animation: 'a', target: 'part:body.fill', from: 0, to: 1 }]).message,
  ).toContain('numeric');
  expect(
    applyFail(rigDoc(), [{ op: 'act', animation: 'a', target: 'param:AngleX', from: 0, to: 30 }]).hint,
  ).toContain('clamp');
  expect(
    applyFail(rigDoc(), [
      { op: 'act', animation: 'a', target: 'param:AngleX', from: 0, to: 10, duration: -1 },
    ]).message,
  ).toContain('duration');
});
