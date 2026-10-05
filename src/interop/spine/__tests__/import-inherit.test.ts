/**
 * Spine transform inheritance modes, emulated by the importer (import-rules.ts), checked against
 * hand-computed Spine world transforms (plain trigonometry, not the importer's transform module).
 * Regression tests for differences found by comparing imports of the official examples with the
 * spine-core runtime (feet that stay level, snow that orbits without turning, IK-compensated hands).
 */
import { describe, expect, it } from 'vitest';
import { importSpine } from '../index.js';
import { bone, canvasOf, codes, expectClose, load, part } from './helpers.js';

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Posed position of a part's setup vertex i (Rev2D maps setup vertices through the pose). */
function posedVertex(l: ReturnType<typeof load>, pose: ReturnType<ReturnType<typeof load>['rig']['pose']>, partId: string, i: number): [number, number] {
  const v = part(l.model as unknown as Record<string, unknown>, partId).shape.vertices as number[];
  return l.rig.mapPoint(pose, `part:${partId}`, v[2 * i], v[2 * i + 1]);
}

describe('spine import: transform inheritance', () => {
  it('keeps a noRotationOrReflection foot level while its leg swings', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'leg', parent: 'root', rotation: -90, length: 50 },
          { name: 'foot', parent: 'leg', x: 50, length: 20, inherit: 'noRotationOrReflection' },
        ],
        slots: [{ name: 'foot', bone: 'foot', attachment: 'f' }],
        skins: [{ name: 'default', attachments: { foot: { f: { x: 10, width: 20, height: 6 } } } }],
        animations: { swing: { bones: { leg: { rotate: [{ value: 0 }, { time: 1, value: 60 }] } } } },
      },
    });
    const l = load(res);
    const toCanvas = canvasOf(res.doc);
    expect(bone(res.doc, 'foot').parent).toBe('leg');
    const setup = l.rig.pose();
    const setupCorners = [0, 1, 2, 3].map((i) => posedVertex(l, setup, 'foot', i));
    for (const t of [0, 0.3, 0.5, 0.77, 1]) {
      const pose = l.rig.pose({ animations: ['swing'], time: t });
      // Spine: the leg turns from -90° to -30°; the foot's world rotation stays its own 0°.
      const a = rad(-90 + 60 * t);
      const joint = toCanvas(50 * Math.cos(a), 50 * Math.sin(a));
      expectClose([pose.bones.foot.x, pose.bones.foot.y], joint, 1e-6);
      expect(pose.bones.foot.rotation).toBeCloseTo(0, 1);
      // The attachment only translates with the leg tip.
      for (let i = 0; i < 4; i++) {
        const c = setupCorners[i];
        expectClose(posedVertex(l, pose, 'foot', i), [c[0] - setup.bones.foot.x + joint[0], c[1] - setup.bones.foot.y + joint[1]], 0.1);
      }
    }
    const info = res.report.issues.find((i) => i.code === 'spine-bone-inherit-baked');
    expect(info).toMatchObject({ severity: 'info', where: 'bones[2] (foot)' });
    expect(info!.message).toMatch(/sampled in 1 animation \(swing\)/);
  });

  it("keeps an onlyTranslation bone's own rotation and scale under a turning, growing parent", () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'arm', parent: 'root', length: 40, scaleX: 2, scaleY: 2 },
          { name: 'hand', parent: 'arm', x: 40, rotation: 30, length: 10, inherit: 'onlyTranslation' },
        ],
        animations: {
          grow: { bones: { arm: { rotate: [{ value: 0 }, { time: 1, value: 90 }], scale: [{ x: 1, y: 1 }, { time: 1, x: 1.5, y: 1.5 }] } } },
        },
      },
    });
    const { rig } = load(res);
    const toCanvas = canvasOf(res.doc);
    for (const t of [0, 0.25, 0.6, 1]) {
      const pose = rig.pose({ animations: ['grow'], time: t });
      const r = rad(90 * t);
      const k = 2 * (1 + 0.5 * t);
      expectClose([pose.bones.hand.x, pose.bones.hand.y], toCanvas(40 * k * Math.cos(r), 40 * k * Math.sin(r)), 1e-6);
      // Spine world: rotation 30° (counter-clockwise, -30° in Rev2D), scale 1.
      expect(pose.bones.hand.rotation).toBeCloseTo(-30, 1);
      expect(pose.bones.hand.scaleX).toBeCloseTo(1, 3);
      expect(pose.bones.hand.scaleY).toBeCloseTo(1, 3);
    }
  });

  it('compensates the setup IK for a bone that does not inherit rotation', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'upper', parent: 'root', length: 50 },
          { name: 'lower', parent: 'upper', x: 50, length: 50 },
          { name: 'hand', parent: 'lower', x: 50, length: 10, inherit: 'onlyTranslation' },
          { name: 'target', parent: 'root', x: 60 },
        ],
        slots: [{ name: 'hand', bone: 'hand', attachment: 'h' }],
        skins: [{ name: 'default', attachments: { hand: { h: { x: 5, width: 10, height: 4 } } } }],
        ik: [{ name: 'k', bones: ['upper', 'lower'], target: 'target' }],
      },
    });
    const l = load(res);
    const toCanvas = canvasOf(res.doc);
    const pose = l.rig.pose();
    // Spine: the IK folds the straight chain onto the target at (60, 0); the hand keeps its own 0°.
    expectClose([pose.bones.hand.x, pose.bones.hand.y], toCanvas(60, 0), 1e-6);
    expect(pose.bones.hand.rotation).toBeCloseTo(0, 6);
    // Its attachment is drawn level around (65, 0): corners (60..70, -2..2).
    const corners = [0, 1, 2, 3].map((i) => posedVertex(l, pose, 'hand', i));
    const xs = corners.map((c) => c[0]).sort((a, b) => a - b);
    const ys = corners.map((c) => c[1]).sort((a, b) => a - b);
    expectClose([xs[0], xs[3], ys[0], ys[3]], [toCanvas(60, 0)[0], toCanvas(70, 0)[0], toCanvas(0, 2)[1], toCanvas(0, -2)[1]], 1e-6);
    expect(res.report.issues.find((i) => i.code === 'spine-bone-inherit-setup-ik')?.where).toBe('bones[3] (hand)');
  });

  it('moves a bone to model space when its parent scales non-uniformly while it must not turn', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'body', parent: 'root', length: 40, scaleX: 2 },
          { name: 'badge', parent: 'body', x: 20, length: 8, inherit: 'onlyTranslation' },
        ],
        slots: [{ name: 'badge', bone: 'badge', attachment: 'b' }],
        skins: [{ name: 'default', attachments: { badge: { b: { width: 8, height: 8 } } } }],
        animations: { spin: { bones: { body: { rotate: [{ value: 0 }, { time: 1, value: 90 }] } } } },
      },
    });
    const l = load(res);
    const toCanvas = canvasOf(res.doc);
    // A parented Rev2D bone would need a sheared local transform: the badge has no parent in Rev2D.
    expect(bone(res.doc, 'badge').parent).toBeUndefined();
    const setup = l.rig.pose();
    const setupCorner = posedVertex(l, setup, 'badge', 0);
    for (const t of [0, 0.2, 0.5, 0.9]) {
      const pose = l.rig.pose({ animations: ['spin'], time: t });
      const r = rad(90 * t);
      const joint = toCanvas(40 * Math.cos(r), 40 * Math.sin(r));
      expectClose([pose.bones.badge.x, pose.bones.badge.y], joint, 0.01);
      expect(pose.bones.badge.rotation).toBeCloseTo(0, 2);
      expect(pose.bones.badge.scaleX).toBeCloseTo(1, 3);
      expect(pose.bones.badge.scaleY).toBeCloseTo(1, 3);
      // The 8 x 8 square is neither turned nor sheared.
      expectClose(posedVertex(l, pose, 'badge', 0), [setupCorner[0] - setup.bones.badge.x + joint[0], setupCorner[1] - setup.bones.badge.y + joint[1]], 0.02);
    }
    expect(res.report.issues.find((i) => i.code === 'spine-bone-inherit-detached')?.where).toBe('bones[2] (badge)');
    expect(codes(res)).not.toContain('spine-bone-inherit-shear');
  });

  it('follows the 4.2 inherit timeline', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'arm', parent: 'root', length: 30 },
          { name: 'tip', parent: 'arm', x: 30, length: 10 },
        ],
        animations: {
          lock: {
            bones: {
              arm: { rotate: [{ value: 0 }, { time: 1, value: 90 }] },
              tip: { inherit: [{ time: 0.5, inherit: 'onlyTranslation' }] },
            },
          },
        },
      },
    });
    const { rig } = load(res);
    // Before 0.5 the tip turns with the arm (22.5° counter-clockwise at 0.25); from 0.5 on it keeps 0°.
    expect(rig.pose({ animations: ['lock'], time: 0.25 }).bones.tip.rotation).toBeCloseTo(-22.5, 1);
    expect(rig.pose({ animations: ['lock'], time: 0.75 }).bones.tip.rotation).toBeCloseTo(0, 1);
    expect(rig.pose({ animations: ['lock'], time: 1 }).bones.tip.rotation).toBeCloseTo(0, 1);
    expect(res.report.issues.find((i) => i.code === 'spine-bone-inherit-baked')?.message).toMatch(/inherit timeline of lock/);
    expect(codes(res)).not.toContain('spine-timeline-inherit');
  });

  it('reports inheritance it cannot emulate inside IK chains', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'a', parent: 'root', length: 20, inherit: 'noScale' },
          { name: 't', parent: 'root', x: 10, y: 10 },
        ],
        ik: [{ name: 'aim', bones: ['a'], target: 't' }],
      },
    });
    expect(res.report.issues.find((i) => i.code === 'spine-bone-inherit')).toMatchObject({ severity: 'warning', where: 'bones[1] (a)' });
  });
});
