import { describe, expect, it } from 'vitest';
import { easeFn } from '../easing.js';
import type { Ease, ModelInput } from '../types.js';
import { expectNear, makeRig, quad } from './rig.fixtures.js';

type Anim = NonNullable<ModelInput['animations']>[number];

const P = { id: 'P', min: -100, max: 100 };

function paramRig(...animations: Anim[]) {
  return makeRig({ parameters: [P, { id: 'Q', min: 0, max: 10, default: 3 }], animations });
}

/** 0 until t=0.5, then eases to 10 at t=1.5 (non-looping, duration 2). */
function ramp(id: string, ease: Ease): Anim {
  return {
    id,
    duration: 2,
    loop: false,
    tracks: [{ target: 'param:P', keys: [{ t: 0.5, v: 0, ease }, { t: 1.5, v: 10 }] }],
  };
}

describe('rig: animation sampling', () => {
  it('interpolates linearly and holds before the first / after the last key', () => {
    const rig = paramRig(ramp('a', 'linear'));
    const p = (time: number) => rig.pose({ time, animations: ['a'] }).params.P;
    expect(p(0)).toBe(0);
    expect(p(0.5)).toBe(0);
    expect(p(1)).toBeCloseTo(5);
    expect(p(1.5)).toBe(10);
    expect(p(1.9)).toBe(10);
  });

  it('applies the easing of the segment start key', () => {
    for (const ease of ['inQuad', 'outBack', 'inOutSine'] as const) {
      const rig = paramRig(ramp('a', ease));
      expect(rig.pose({ time: 0.75, animations: ['a'] }).params.P).toBeCloseTo(10 * easeFn(ease)(0.25), 10);
    }
    const bezier = paramRig(ramp('a', [0.25, 0.1, 0.25, 1]));
    expect(bezier.pose({ time: 1, animations: ['a'] }).params.P).toBeCloseTo(8.024, 2);
  });

  it('step easing holds the key value until the next key', () => {
    const rig = paramRig(ramp('a', 'step'));
    expect(rig.pose({ time: 1.49, animations: ['a'] }).params.P).toBe(0);
    expect(rig.pose({ time: 1.5, animations: ['a'] }).params.P).toBe(10);
  });

  it('sorts keys by time', () => {
    const rig = paramRig({
      id: 'a',
      duration: 1,
      loop: false,
      tracks: [{ target: 'param:P', keys: [{ t: 1, v: 10 }, { t: 0, v: 0 }] }],
    });
    expect(rig.pose({ time: 0.25, animations: ['a'] }).params.P).toBeCloseTo(2.5);
  });

  it('wraps looping animations and clamps non-looping ones', () => {
    const track = { target: 'param:P', keys: [{ t: 0, v: 0 }, { t: 2, v: 20 }] };
    const rig = paramRig({ id: 'loop', duration: 2, loop: true, tracks: [track] }, { id: 'once', duration: 2, loop: false, tracks: [track] });
    const p = (time: number, id: string) => rig.pose({ time, animations: [id] }).params.P;
    expect(p(2.5, 'loop')).toBeCloseTo(5);
    expect(p(-0.5, 'loop')).toBeCloseTo(15);
    expect(p(4, 'loop')).toBe(0);
    expect(p(3, 'once')).toBe(20);
    expect(p(-1, 'once')).toBe(0);
  });

  it('blends param layers in order (later layers win by weight)', () => {
    const constant = (id: string, v: number): Anim => ({ id, duration: 1, tracks: [{ target: 'param:P', keys: [{ t: 0, v }] }] });
    const rig = paramRig(constant('ten', 10), constant('twenty', 20));
    expect(rig.pose({ animations: ['ten', { id: 'twenty', weight: 0.5 }] }).params.P).toBeCloseTo(15);
    expect(rig.pose({ animations: [{ id: 'twenty', weight: 0.5 }, 'ten'] }).params.P).toBeCloseTo(10);
    // Blending starts from the parameter default.
    const q = makeRig({
      parameters: [{ id: 'Q', min: 0, max: 10, default: 4 }],
      animations: [{ id: 'q', duration: 1, tracks: [{ target: 'param:Q', keys: [{ t: 0, v: 8 }] }] }],
    });
    expect(q.pose({ animations: [{ id: 'q', weight: 0.25 }] }).params.Q).toBeCloseTo(5);
  });

  it('uses per-layer times when given', () => {
    const rig = paramRig(ramp('a', 'linear'));
    expect(rig.pose({ time: 0, animations: [{ id: 'a', time: 1 }] }).params.P).toBeCloseTo(5);
  });

  it('lets explicit params override animations, then clamps', () => {
    const rig = paramRig({ id: 'big', duration: 1, tracks: [{ target: 'param:P', keys: [{ t: 0, v: 500 }] }] });
    expect(rig.pose({ animations: ['big'] }).params.P).toBe(100);
    expect(rig.pose({ animations: ['big'], params: { P: 7 } }).params.P).toBe(7);
    expect(rig.pose({ params: { P: -1000, Q: 20 } }).params).toEqual({ P: -100, Q: 10 });
    expect(rig.pose().params.Q).toBe(3);
  });

  it('combines property tracks as weighted deltas after bindings', () => {
    const rig = makeRig({
      parameters: [{ id: 'A', min: 0, max: 1 }],
      bones: [{ id: 'b', rotation: 10 }],
      parts: [{ id: 'p', shape: quad(0, 0, 10, 10) }],
      bindings: [{ target: 'bone:b.rotation', params: ['A'], keys: [{ at: [0], value: 10 }, { at: [1], value: 30 }] }],
      animations: [
        { id: 'spin', duration: 1, tracks: [{ target: 'bone:b.rotation', keys: [{ t: 0, v: 50 }] }] },
        {
          id: 'look',
          duration: 1,
          tracks: [
            { target: 'part:p.tint', keys: [{ t: 0, v: '#000000' }, { t: 1, v: '#ffffff' }] },
            { target: 'part:p.visible', keys: [{ t: 0, v: true }, { t: 0.5, v: false, ease: 'step' }] },
          ],
        },
      ],
    });
    // setup 10 + binding (30-10) + 0.5 * (50-10)
    const pose = rig.pose({ params: { A: 1 }, animations: [{ id: 'spin', weight: 0.5 }] });
    expect(pose.bones.b.local.rotation).toBeCloseTo(50);
    expect(pose.properties['bone:b.rotation']).toBe(50);
    const look = rig.pose({ time: 0.25, animations: ['look'] });
    expectNear(look.parts.p.tint, [0.25, 0.25, 0.25, 1], 1e-6);
    expect(look.parts.p.visible).toBe(true);
    expect(rig.pose({ time: 0.5, animations: ['look'] }).parts.p.visible).toBe(false);
    // Properties only list what is bound or animated in this pose.
    expect(Object.keys(rig.pose().properties)).toEqual(['bone:b.rotation']);
  });

  it('rejects unknown animations and parameters', () => {
    const rig = paramRig(ramp('walk', 'linear'));
    expect(() => rig.pose({ animations: ['wakl'] })).toThrow(/unknown animation "wakl" \(did you mean "walk"\?\)/);
    expect(() => rig.pose({ params: { R: 1 } })).toThrow(/unknown parameter "R"/);
    expect(() => rig.pose({ time: Number.NaN })).toThrow(/finite/);
    expect(() =>
      makeRig({ animations: [{ id: 'a', duration: 1, tracks: [{ target: 'param:Nope', keys: [{ t: 0, v: 1 }] }] }] }),
    ).toThrow(/animation "a" tracks\[0\].*unknown parameter "Nope"/);
  });
});

describe('rig: animation events', () => {
  const eventRig = () =>
    makeRig({
      animations: [
        {
          id: 'walk',
          duration: 1,
          loop: true,
          events: [
            { t: 0.9, name: 'late' },
            { t: 0.1, name: 'early', data: { foot: 'L' } },
          ],
        },
        { id: 'once', duration: 1, loop: false, events: [{ t: 1, name: 'end' }] },
      ],
    });

  it('stateless poses report events exactly at the local time', () => {
    const rig = eventRig();
    expect(rig.pose({ time: 1.1, animations: ['walk'] }).events).toEqual([
      { animation: 'walk', name: 'early', t: 0.1, data: { foot: 'L' } },
    ]);
    expect(rig.pose({ time: 1.15, animations: ['walk'] }).events).toEqual([]);
    expect(rig.pose({ time: 1, animations: ['once'] }).events).toEqual([{ animation: 'once', name: 'end', t: 1 }]);
    expect(rig.pose({ time: 2, animations: ['once'] }).events).toEqual([]);
    expect(rig.pose({ time: 0.1, animations: [{ id: 'walk', weight: 0 }] }).events).toEqual([]);
  });

  it('the player reports events crossed since the previous update, across loop wraps', () => {
    const player = eventRig().player();
    const names = (time: number) => player.update({ time, animations: ['walk', 'once'] }).events.map((e) => `${e.animation}.${e.name}`);
    expect(names(0)).toEqual([]);
    expect(names(0.5)).toEqual(['walk.early']);
    expect(names(1.2)).toEqual(['walk.late', 'walk.early', 'once.end']);
    expect(names(1.2)).toEqual([]);
    // More than a full cycle elapsed: the window is the last cycle (2, 3].
    expect(names(3)).toEqual(['walk.early', 'walk.late']);
    expect(names(5.5)).toEqual(['walk.late', 'walk.early']);
  });

  it('the player counts every frame boundary exactly once when stepping', () => {
    const player = eventRig().player();
    const seen: string[] = [];
    for (let f = 0; f <= 120; f++) {
      for (const e of player.update({ time: f / 60, animations: ['walk'] }).events) seen.push(`${f}:${e.name}`);
    }
    expect(seen).toEqual(['6:early', '54:late', '66:early', '114:late']);
  });

  it('fires every looping event exactly once per cycle over a long run', () => {
    const rig = makeRig({
      animations: [{ id: 'odd', duration: 0.7, events: [{ t: 0, name: 'a' }, { t: 0.35, name: 'b' }, { t: 0.7, name: 'c' }] }],
    });
    const player = rig.player();
    const count: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let f = 0; f <= 6000; f++) for (const e of player.update({ time: f / 60, animations: ['odd'] }).events) count[e.name]++;
    // 100 s = 142 full cycles + 0.6 s: `a` fires at 0 and at every wrap, `b` in all 143 started cycles;
    // `c` sits on the wrap too (it equals t = 0 of the next cycle), so it matches `a`.
    expect(count).toEqual({ a: 143, b: 143, c: 143 });
  });

  it('non-looping events fire when a delayed layer crosses them, including t = 0', () => {
    const rig = makeRig({
      animations: [
        {
          id: 'hit',
          duration: 1,
          loop: false,
          events: [
            { t: 0, name: 'start' },
            { t: 1, name: 'end' },
            { t: 1.5, name: 'beyond' },
          ],
        },
      ],
    });
    const player = rig.player();
    const seen: string[] = [];
    for (let f = 0; f <= 120; f++) {
      const time = f / 60;
      // The layer starts 0.5 s late: its local clock is negative for the first 30 frames.
      for (const e of player.update({ time, animations: [{ id: 'hit', time: time - 0.5 }] }).events) seen.push(`${f}:${e.name}`);
    }
    expect(seen).toEqual(['30:start', '90:end']);
    // Events after the end of a non-looping animation are never reached, statelessly either.
    expect(rig.pose({ animations: [{ id: 'hit', time: 1.5 }] }).events).toEqual([]);
    expect(rig.pose({ animations: [{ id: 'hit', time: -0.5 }] }).events).toEqual([]);
  });

  it('restarts event tracking when time goes backwards', () => {
    const player = eventRig().player();
    player.update({ time: 0.5, animations: ['walk'] });
    expect(player.update({ time: 0.1, animations: ['walk'] }).events.map((e) => e.name)).toEqual(['early']);
    expect(player.time).toBe(0.1);
    expect(player.update({ time: 0.95, animations: ['walk'] }).events.map((e) => e.name)).toEqual(['late']);
  });
});
