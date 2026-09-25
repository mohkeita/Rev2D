import { describe, expect, it } from 'vitest';
import type { ModelInput, PoseOptions } from '../types.js';
import { makeRig } from './rig.fixtures.js';

type Group = NonNullable<ModelInput['physics']>[number];

/** Snaps parameter X from 0 to 50 at t = 0.5. */
const JERK_ANIMATION = {
  id: 'jerk',
  duration: 10,
  loop: false,
  tracks: [{ target: 'param:X', keys: [{ t: 0, v: 0, ease: 'step' as const }, { t: 0.5, v: 50 }] }],
};

/** Pendulum hanging from pivot x = X, driven by the `jerk` animation; bone `b` rotates by Sway degrees. */
function pendulum(group: Partial<Group> = {}, swayRange = 90) {
  return makeRig({
    bones: [{ id: 'b' }],
    bindings: [
      { target: 'bone:b.rotation', params: ['Sway'], keys: [{ at: [-90], value: -90 }, { at: [90], value: 90 }] },
    ],
    parameters: [
      { id: 'X', min: -100, max: 100 },
      { id: 'R', min: -90, max: 90 },
      { id: 'Sway', min: -swayRange, max: swayRange },
      { id: 'TipX', min: -100, max: 100 },
      { id: 'TipY', min: -100, max: 100 },
    ],
    physics: [
      {
        id: 'hair',
        inputs: [
          { param: 'X', type: 'x' },
          { param: 'R', type: 'angle' },
        ],
        outputs: [
          { param: 'Sway', type: 'angle' },
          { param: 'TipX', type: 'x' },
          { param: 'TipY', type: 'y' },
        ],
        segments: [{ length: 40 }],
        damping: 0.1,
        ...group,
      },
    ],
    animations: [JERK_ANIMATION],
  });
}

const jerk: PoseOptions = { animations: ['jerk'] };

describe('rig: physics', () => {
  it('hangs still at rest', () => {
    const p = pendulum().pose({ time: 2 }).params;
    expect([p.Sway, p.TipX, p.TipY]).toEqual([0, 0, 0]);
  });

  it('is deterministic for stateless poses', () => {
    const rig = pendulum();
    const a = rig.pose({ ...jerk, time: 1.3 });
    const b = rig.pose({ ...jerk, time: 1.3 });
    expect(a.params).toEqual(b.params);
    expect(a.params.Sway).not.toBe(0);
  });

  it('player stepping reproduces pose(t) exactly, frame by frame or in uneven steps', () => {
    const rig = pendulum({ segments: [{ length: 30 }, { length: 20, mass: 2 }], stiffness: 3 });
    const target = rig.pose({ ...jerk, time: 1.5 }).params;
    const frames = rig.player();
    for (let f = 0; f <= 90; f++) frames.update({ ...jerk, time: f / 60 });
    expect(frames.update({ ...jerk, time: 1.5 }).params).toEqual(target);
    const uneven = rig.player();
    for (const t of [0.1, 0.37, 0.5, 0.51, 1.2, 1.5]) uneven.update({ ...jerk, time: t });
    expect(uneven.update({ ...jerk, time: 1.5 }).params).toEqual(target);
    expect(uneven.time).toBe(1.5);
  });

  it('resimulates from rest when the player goes back in time', () => {
    const rig = pendulum();
    const player = rig.player();
    player.update({ ...jerk, time: 2 });
    expect(player.update({ ...jerk, time: 0.8 }).params).toEqual(rig.pose({ ...jerk, time: 0.8 }).params);
    player.reset();
    expect(player.time).toBe(0);
    expect(player.update({ ...jerk, time: 0.9 }).params).toEqual(rig.pose({ ...jerk, time: 0.9 }).params);
  });

  it('lags behind a pivot jerked to +x: positive (clockwise) angle, negative tip x', () => {
    // Moving the pivot right leaves the bob behind (to the left): the hanging segment rotates from
    // straight down toward -x, which is clockwise on screen (y down), so the angle is positive.
    const p = pendulum().pose({ ...jerk, time: 0.5 + 2 / 60 }).params;
    expect(p.Sway).toBeGreaterThan(5);
    expect(p.TipX).toBeLessThan(-3);
    expect(p.TipY).toBeLessThan(0);
  });

  it('damping settles the swing back toward 0', () => {
    const rig = pendulum();
    const early = Math.abs(rig.pose({ ...jerk, time: 0.6 }).params.Sway);
    const late = rig.pose({ ...jerk, time: 6 }).params;
    expect(early).toBeGreaterThan(10);
    expect(Math.abs(late.Sway)).toBeLessThan(0.5);
    expect(Math.abs(late.TipX)).toBeLessThan(0.5);
  });

  it('stiffness springs back without gravity', () => {
    const rig = pendulum({ gravity: 0, stiffness: 40, damping: 0.05 });
    expect(rig.pose({ ...jerk, time: 0.55 }).params.Sway).toBeGreaterThan(5);
    expect(Math.abs(rig.pose({ ...jerk, time: 5 }).params.Sway)).toBeLessThan(0.5);
  });

  it('measures the angle against the rotated rest direction', () => {
    // The pivot is rotated 30° clockwise from t=0; gravity pulls the chain straight down, which is
    // 30° counter-clockwise from the rotated rest direction.
    const p = pendulum().pose({ time: 8, params: { R: 30 } }).params;
    expect(p.Sway).toBeCloseTo(-30, 1);
    expect(pendulum().pose({ time: 0, params: { R: 30 } }).params.Sway).toBeCloseTo(0, 10);
  });

  it('writes and clamps output parameters over animated values; physics:false leaves them alone', () => {
    const rig = pendulum({}, 5);
    expect(rig.pose({ ...jerk, time: 0.6 }).params.Sway).toBe(5);
    expect(rig.pose({ ...jerk, time: 0.6, params: { Sway: 3 }, physics: false }).params.Sway).toBe(3);
    // An animation track on an output parameter is overwritten (only explicit values win, see below).
    const animated = makeRig({
      parameters: [
        { id: 'X', min: -100, max: 100 },
        { id: 'Sway', min: -90, max: 90 },
      ],
      physics: [{ id: 'hair', inputs: [{ param: 'X', type: 'x' }], outputs: [{ param: 'Sway' }], segments: [{ length: 40 }] }],
      animations: [{ id: 'hold', duration: 1, tracks: [{ target: 'param:Sway', keys: [{ t: 0, v: 40 }] }] }],
    });
    expect(animated.pose({ animations: ['hold'], time: 0.5 }).params.Sway).toBe(0);
    expect(animated.pose({ animations: ['hold'], time: 0.5, physics: false }).params.Sway).toBe(40);
  });

  describe('explicit parameter values beat physics (SPEC §9)', () => {
    it('re-applies explicit values over physics outputs, clamped; bindings follow them', () => {
      const rig = pendulum({}, 5);
      const free = rig.pose({ ...jerk, time: 0.6 });
      const pinned = rig.pose({ ...jerk, time: 0.6, params: { Sway: 3 } });
      expect(pinned.params.Sway).toBe(3);
      expect(pinned.bones.b.local.rotation).toBeCloseTo(3, 12);
      expect(rig.pose({ time: 1, params: { Sway: 3 } }).params.Sway).toBe(3);
      expect(rig.pose({ ...jerk, time: 0.6, params: { Sway: 50 } }).params.Sway).toBe(5);
      expect(rig.pose({ ...jerk, time: 0.6, params: { Sway: -50 } }).params.Sway).toBe(-5);
      // The simulation itself is unaffected: other outputs of the group keep their simulated values.
      expect(pinned.params.TipX).toBe(free.params.TipX);
      expect(pinned.params.TipY).toBe(free.params.TipY);
    });

    it('applies to the player as well', () => {
      const rig = pendulum({}, 5);
      const player = rig.player();
      for (let f = 0; f < 36; f++) player.update({ ...jerk, time: f / 60 });
      const p = player.update({ ...jerk, time: 0.6, params: { Sway: -2 } });
      expect(p.params.Sway).toBe(-2);
      expect(p.bones.b.local.rotation).toBeCloseTo(-2, 12);
      expect(p.params).toEqual(rig.pose({ ...jerk, time: 0.6, params: { Sway: -2 } }).params);
    });

    it('later groups read the explicit value of an overridden output, from the rest state on', () => {
      const rig = makeRig({
        parameters: [
          { id: 'X', min: -100, max: 100 },
          { id: 'Lag', min: -100, max: 100 },
          { id: 'Out', min: -90, max: 90 },
        ],
        physics: [
          { id: 'first', inputs: [{ param: 'X', type: 'x' }], outputs: [{ param: 'Lag', type: 'x' }], segments: [{ length: 40 }] },
          { id: 'second', inputs: [{ param: 'Lag', type: 'x' }], outputs: [{ param: 'Out' }], segments: [{ length: 20 }] },
        ],
        animations: [JERK_ANIMATION],
      });
      expect(rig.pose({ ...jerk, time: 0.6 }).params.Out).toBeLessThan(-1);
      // Lag pinned at 30 from t = 0: `second` hangs at rest from x = 30 the whole time (had it seen the
      // rest output 0 of `first` at t = 0, the jump to 30 would swing it).
      for (const time of [0, 0.3, 0.6, 2]) {
        const p = rig.pose({ ...jerk, time, params: { Lag: 30 } }).params;
        expect(p.Lag).toBe(30);
        expect(p.Out).toBeCloseTo(0, 9);
      }
    });
  });

  it('runs groups in array order: later groups read earlier outputs from the same step', () => {
    const groups: Record<'first' | 'second', Group> = {
      first: { id: 'first', inputs: [{ param: 'X', type: 'x' }], outputs: [{ param: 'Lag', type: 'x' }], segments: [{ length: 40 }] },
      // Hangs from a pivot that follows `first`'s tip offset.
      second: { id: 'second', inputs: [{ param: 'Lag', type: 'x' }], outputs: [{ param: 'Out' }], segments: [{ length: 20 }] },
    };
    const rig = (order: Array<'first' | 'second'>) =>
      makeRig({
        parameters: [
          { id: 'X', min: -100, max: 100 },
          { id: 'Lag', min: -100, max: 100 },
          { id: 'Out', min: -90, max: 90 },
        ],
        physics: order.map((id) => groups[id]),
        animations: [JERK_ANIMATION],
      });
    const chained = rig(['first', 'second']);
    const p = chained.pose({ ...jerk, time: 0.6 }).params;
    expect(p.Lag).toBeLessThan(-1);
    // The second pivot is dragged toward -x, so its bob lags toward +x: counter-clockwise, negative.
    expect(p.Out).toBeLessThan(-1);
    const player = chained.player();
    for (let f = 0; f <= 36; f++) player.update({ ...jerk, time: f / 60 });
    expect(player.update({ ...jerk, time: 0.6 }).params).toEqual(p);
    // Reversed, `second` runs before `first` writes Lag in each step and never moves.
    const reversed = rig(['second', 'first']).pose({ ...jerk, time: 0.6 }).params;
    expect(reversed.Lag).toBe(p.Lag);
    expect(reversed.Out).toBe(0);
  });

  describe('time window (SPEC §8)', () => {
    /**
     * Weightless and undamped: the jerk at t = 0.5 leaves the bob displaced (~51°) for good, since nothing
     * pulls it back, so a simulation that saw the jerk never forgets it.
     */
    const undamped = () => pendulum({ damping: 0, gravity: 0 });
    /** Player stepped in half-second increments (never restarts): the full simulation from t = 0. */
    function fullSimulation(rig: ReturnType<typeof pendulum>, until: number) {
      const player = rig.player();
      for (let t = 0; t < until; t += 0.5) player.update({ ...jerk, time: t });
      return player;
    }

    it('stateless poses simulate at most the 60 s before time, from rest', () => {
      const rig = undamped();
      const full = fullSimulation(rig, 70).update({ ...jerk, time: 70 }).params;
      expect(Math.abs(full.Sway)).toBeGreaterThan(1); // still displaced by the jerk at t = 0.5
      // The window [10, 70] starts at rest under that time's inputs (X = 50) and never sees the jerk.
      const windowed = rig.pose({ ...jerk, time: 70 }).params;
      expect(windowed.Sway).toBeCloseTo(0, 6);
      expect(windowed.TipX).toBeCloseTo(0, 6);
      // Up to 60 s nothing is cut off.
      expect(rig.pose({ ...jerk, time: 60 }).params).toEqual(fullSimulation(rig, 60).update({ ...jerk, time: 60 }).params);
    });

    it('evaluates an epoch timestamp quickly and deterministically', () => {
      const rig = pendulum();
      // The layer's own clock puts the jerk 0.1 s before the frame: the window still captures it.
      const opts: PoseOptions = { animations: [{ id: 'jerk', time: 0.6 }], time: 1.7e9 };
      const start = performance.now();
      const a = rig.pose(opts).params;
      expect(performance.now() - start).toBeLessThan(2000);
      expect(Math.abs(a.Sway)).toBeGreaterThan(1);
      expect(rig.pose(opts).params).toEqual(a);
      expect(rig.player().update(opts).params).toEqual(a);
    });

    it('terminates for any finite time, even beyond integer precision of the step counter', () => {
      const rig = pendulum();
      for (const time of [1e15, 1e20, Number.MAX_VALUE]) {
        const opts: PoseOptions = { ...jerk, time };
        expect(Number.isFinite(rig.pose(opts).params.Sway)).toBe(true);
        const player = rig.player();
        player.update({ ...jerk, time: time / 2 });
        expect(Number.isFinite(player.update(opts).params.Sway)).toBe(true);
      }
    });

    it('the player steps incrementally but restarts from rest after a jump of more than 60 s', () => {
      const rig = undamped();
      // First update and jumps > 60 s: identical to the stateless pose.
      expect(rig.player().update({ ...jerk, time: 70 }).params).toEqual(rig.pose({ ...jerk, time: 70 }).params);
      const jumped = fullSimulation(rig, 30);
      jumped.update({ ...jerk, time: 29.9 });
      expect(jumped.update({ ...jerk, time: 90 }).params).toEqual(rig.pose({ ...jerk, time: 90 }).params);
      // Exactly 60 s (3600 steps) is still incremental: the displacement carries over.
      const incremental = fullSimulation(rig, 30);
      incremental.update({ ...jerk, time: 30 });
      expect(Math.abs(incremental.update({ ...jerk, time: 90 }).params.Sway)).toBeGreaterThan(1);
      // Frame by frame past 60 s the player keeps its history (unlike the windowed stateless pose).
      expect(Math.abs(fullSimulation(rig, 70).update({ ...jerk, time: 70 }).params.Sway)).toBeGreaterThan(1);
    });
  });

  it('rejects bad physics references', () => {
    const bad = (group: Partial<Group>) => () =>
      makeRig({
        parameters: [{ id: 'X', min: 0, max: 1 }],
        physics: [{ id: 'g', inputs: [{ param: 'X', type: 'x' }], outputs: [{ param: 'X' }], ...group }],
      });
    expect(bad({ inputs: [{ param: 'Y', type: 'x' }] })).toThrow(/physics "g" input: unknown parameter "Y"/);
    expect(bad({ outputs: [{ param: 'X', segment: 3 }] })).toThrow(/output segment 3 out of range/);
  });
});
