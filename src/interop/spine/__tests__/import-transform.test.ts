/**
 * Spine transform constraints, emulated by the importer (import-rules.ts), checked against
 * hand-computed Spine world transforms (plain trigonometry, not the importer's transform module).
 * Regression tests for constraints the importer used to skip on real data (aim and hoverboard
 * constraints that rotate and move bones towards a target).
 */
import { describe, expect, it } from 'vitest';
import { importSpine } from '../index.js';
import { bezierRef, canvasOf, codes, expectClose, load, part } from './helpers.js';

const rad = (deg: number) => (deg * Math.PI) / 180;
/** Sampled emulation: tracks are refined until linear interpolation is within 0.05 px / 0.05°. */
const POS_TOL = 0.05;
const ROT_TOL = 0.05;

describe('spine import: transform constraints', () => {
  it('emulates a world, absolute constraint that turns and pulls a bone towards a rotating target', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 't', parent: 'root', x: 30 },
          { name: 'b', parent: 'root', y: 20, length: 10 },
        ],
        // mixY defaults to mixX, mixScaleY to mixScaleX.
        transform: [{ name: 'c', bones: ['b'], target: 't', rotation: 10, x: 5, mixRotate: 1, mixX: 0.5, mixScaleX: 0, mixShearY: 0 }],
        animations: { turn: { bones: { t: { rotate: [{ value: 0 }, { time: 1, value: 90 }] } } } },
      },
    });
    const { rig } = load(res);
    const toCanvas = canvasOf(res.doc);
    // The setup pose includes the constraint (mixes are on): halfway to (35, 0), turned by 10°.
    const setup = rig.pose();
    expectClose([setup.bones.b.x, setup.bones.b.y], toCanvas(17.5, 10), 1e-6);
    expect(setup.bones.b.rotation).toBeCloseTo(-10, 6);
    // Regression: animations used to apply the constraint again on top of that setup pose.
    for (const t of [0, 0.25, 0.5, 0.8, 0.999]) {
      const pose = rig.pose({ animations: ['turn'], time: t });
      const a = rad(90 * t);
      // Target point: the offset (5, 0) in t's frame; b moves halfway there and takes t's rotation + 10°.
      const px = 30 + 5 * Math.cos(a);
      const py = 5 * Math.sin(a);
      expectClose([pose.bones.b.x, pose.bones.b.y], toCanvas(0.5 * px, 20 + 0.5 * (py - 20)), POS_TOL);
      expect(Math.abs(pose.bones.b.rotation + 90 * t + 10)).toBeLessThan(ROT_TOL);
      expect(pose.bones.b.scaleX).toBeCloseTo(1, 4);
    }
    expect(res.report.issues.find((i) => i.code === 'spine-transform-emulated')).toMatchObject({ severity: 'info', where: 'transform[0] (c)' });
    expect(codes(res)).not.toContain('spine-constraint-transform');
  });

  it('emulates a local, relative constraint that adds the target rotation and scale', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 't', parent: 'root', x: 30 },
          { name: 'b', parent: 'root', y: 20, rotation: 10, length: 10 },
        ],
        transform: [{ name: 'c', bones: ['b'], target: 't', local: true, relative: true, mixRotate: 1, mixX: 0, mixScaleX: 1, mixScaleY: 0, mixShearY: 0 }],
        animations: {
          grow: { bones: { t: { rotate: [{ value: 0 }, { time: 1, value: 60 }], scale: [{ x: 1, y: 1 }, { time: 1, x: 2, y: 1 }] } } },
        },
      },
    });
    const { rig } = load(res);
    const toCanvas = canvasOf(res.doc);
    for (const t of [0, 0.3, 0.5, 0.999]) {
      const pose = rig.pose({ animations: ['grow'], time: t });
      // Spine: rotation = 10 + t.rotation; scaleX = 1 * ((t.scaleX - 1) + 1); position unchanged.
      expectClose([pose.bones.b.x, pose.bones.b.y], toCanvas(0, 20), 1e-3);
      expect(Math.abs(pose.bones.b.rotation + 10 + 60 * t)).toBeLessThan(ROT_TOL);
      expect(pose.bones.b.scaleX).toBeCloseTo(1 + t, 3);
      expect(pose.bones.b.scaleY).toBeCloseTo(1, 3);
    }
  });

  it('follows animated constraint mixes', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 't', parent: 'root', x: 30, rotation: 90 },
          { name: 'b', parent: 'root', y: 20, length: 10 },
        ],
        transform: [{ name: 'c', bones: ['b'], target: 't', mixRotate: 0, mixX: 0, mixScaleX: 0, mixShearY: 0 }],
        animations: {
          fade: {
            transform: {
              c: [
                { mixRotate: 0, mixX: 0, mixScaleX: 0, mixShearY: 0 },
                { time: 1, mixRotate: 1, mixX: 0, mixScaleX: 0, mixShearY: 0 },
              ],
            },
          },
        },
      },
    });
    const { rig } = load(res);
    const toCanvas = canvasOf(res.doc);
    // The setup pose has mix 0: b keeps its own rotation.
    expect(rig.pose().bones.b.rotation).toBeCloseTo(0, 6);
    for (const t of [0, 0.25, 0.5, 0.75, 0.999]) {
      const pose = rig.pose({ animations: ['fade'], time: t });
      expectClose([pose.bones.b.x, pose.bones.b.y], toCanvas(0, 20), 1e-3);
      // World absolute rotation: b turns from 0° towards t's 90° by the mix (linear keys).
      expect(Math.abs(pose.bones.b.rotation + 90 * t)).toBeLessThan(ROT_TOL);
    }
    expect(codes(res)).not.toContain('spine-timeline-transform');
  });

  it('samples a baked translate-only constraint finely enough for a fast target curve', () => {
    // Regression (sack-pro "hello"): the baked translation was sampled at 30 fps only, so a target that
    // moves fast between two frames was followed by up to 7 px off.
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'p', parent: 'root', rotation: 30 },
          { name: 'b', parent: 'p', x: 10 },
          { name: 't', parent: 'p', x: 30 },
        ],
        transform: [{ name: 'c', bones: ['b'], target: 't', mixRotate: 0, mixX: 0.5, mixScaleX: 0, mixShearY: 0 }],
        animations: {
          dash: {
            bones: {
              t: {
                translate: [
                  { x: 0, curve: [0.19, 0, 0.2, 60, 0.19, 0, 0.2, 0] },
                  { time: 0.2, x: 60, y: 0 },
                  { time: 0.5, x: 60, y: 0 },
                ],
              },
            },
          },
        },
      },
    });
    expect(codes(res)).toContain('spine-transform-baked');
    const { rig } = load(res);
    for (const t of [0.01, 0.07, 0.13, 0.17, 0.185, 0.19, 0.195, 0.3]) {
      const tx = t < 0.2 ? bezierRef(0, 0, 0.19, 0, 0.2, 60, 0.2, 60, t) : 60;
      // In p's frame: b = (10, 0) + 0.5 * ((30 + tx, 0) - (10, 0)).
      const local = rig.pose({ animations: ['dash'], time: t }).bones.b.local;
      expect(Math.abs(local.x - (20 + 0.5 * tx)), `t = ${t}`).toBeLessThan(POS_TOL);
      expect(Math.abs(local.y), `t = ${t}`).toBeLessThan(POS_TOL);
    }
  });

  it('emulates a constraint on a sheared bone (two Rev2D bones) by sampling both bones', () => {
    // Regression (alien-pro "eye"): the constraint used to be skipped because the bone is sheared, so
    // the eye stayed behind while the head moved. With every mix at 1 (the 4.x defaults) the bone takes
    // its target's world transform: the shear is gone and it turns with the target.
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 't', parent: 'root', x: 30 },
          { name: 'b', parent: 'root', y: 20, length: 10, shearX: 20, scaleY: 1.5 },
        ],
        slots: [{ name: 'b', bone: 'b', attachment: 'r' }],
        skins: [{ name: 'default', attachments: { b: { r: { x: 5, width: 10, height: 4 } } } }],
        transform: [{ name: 'c', bones: ['b'], target: 't' }],
        animations: { turn: { bones: { t: { rotate: [{ value: 0 }, { time: 1, value: 90 }] } } } },
      },
    });
    expect(codes(res)).toContain('spine-bone-shear-pair');
    expect(res.report.issues.find((i) => i.code === 'spine-transform-emulated')?.where).toBe('transform[0] (c)');
    expect(codes(res)).not.toContain('spine-transform-constraint');
    const l = load(res);
    const toCanvas = canvasOf(res.doc);
    const v = part(l.model as unknown as Record<string, unknown>, 'b').shape.vertices as number[];
    for (const t of [null, 0, 0.3, 0.5, 0.75, 0.999]) {
      const pose = t === null ? l.rig.pose() : l.rig.pose({ animations: ['turn'], time: t });
      const a = rad(90 * (t ?? 0));
      // Rev2D world (y down) of Spine's R(a) at (30, 0): linear part R(-a).
      const w = pose.bones.b.world;
      expectClose([w[0], w[1], w[2], w[3]], [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)], 2e-3);
      expectClose([w[4], w[5]], toCanvas(30, 0), POS_TOL);
      // The region (0..10, -2..2 around the bone) is drawn unsheared in the target's frame.
      const corners = [0, 1, 2, 3].map((i) => l.rig.mapPoint(pose, 'part:b', v[2 * i], v[2 * i + 1]));
      const want = [[0, -2], [10, -2], [10, 2], [0, 2]].map(([u, y]) => toCanvas(30 + u * Math.cos(a) - y * Math.sin(a), u * Math.sin(a) + y * Math.cos(a)));
      for (const c of corners) expect(Math.min(...want.map((q) => Math.hypot(c[0] - q[0], c[1] - q[1])))).toBeLessThan(POS_TOL);
    }
  });
});
