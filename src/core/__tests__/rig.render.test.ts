import { describe, expect, it } from 'vitest';
import { buildRenderList } from '../rig.js';
import { expectNear, makeRig, quad } from './rig.fixtures.js';

describe('rig: render list', () => {
  const rig = makeRig({
    meta: { background: '#102030' },
    parameters: [{ id: 'A', min: 0, max: 1 }],
    bones: [{ id: 'b' }],
    parts: [
      { id: 'skin', shape: quad(0, 0, 100, 100), fill: '#ff8000', visible: false, tint: '#000000', opacity: 0.2 },
      { id: 'back', shape: quad(0, 0, 10, 10), fill: 'rgba(255, 255, 255, 0.5)', z: 1 },
      {
        id: 'iris',
        parent: 'b',
        shape: quad(20, 20, 10, 10),
        fill: '#8080ff',
        tint: '#ff000080',
        opacity: 0.5,
        blend: 'multiply',
        mask: ['skin'],
        maskInvert: true,
      },
    ],
    bindings: [
      { target: 'bone:b.x', params: ['A'], keys: [{ at: [0], value: 0 }, { at: [1], value: 5 }] },
      { target: 'part:iris.fill', params: ['A'], keys: [{ at: [0], value: '#8080ff' }, { at: [1], value: '#000000' }] },
    ],
  });

  it('uses meta.background unless overridden', () => {
    const pose = rig.pose();
    const list = buildRenderList(rig, pose);
    expect([list.width, list.height]).toEqual([200, 200]);
    expectNear(list.background, [16 / 255, 32 / 255, 48 / 255, 1], 1e-9);
    expect(buildRenderList(rig, pose, { background: 'transparent' }).background).toEqual([0, 0, 0, 0]);
    expect(() => buildRenderList(rig, pose, { background: 'nope' })).toThrow(/invalid background/);
  });

  it('emits visible parts in draw order with paint × tint × opacity', () => {
    const list = buildRenderList(rig, rig.pose());
    expect(list.draws.map((d) => `${d.partId}.${d.kind}`)).toEqual(['iris.fill', 'back.fill']);
    const iris = list.draws[0];
    expect(iris.blend).toBe('multiply');
    // rgb × tint rgb; alpha × tint alpha (128/255) × opacity 0.5.
    expectNear(iris.colors.slice(0, 4), [128 / 255, 0, 0, (128 / 255) * 0.5], 1e-6);
    expect(iris.indices).toEqual(new Uint32Array([0, 1, 2, 0, 2, 3]));
    expectNear(list.draws[1].colors.slice(0, 4), [1, 1, 1, 0.5], 1e-6);
  });

  it('attaches invisible mask parts with their own paint and deformed positions', () => {
    const pose = rig.pose({ params: { A: 1 } });
    const list = buildRenderList(rig, pose);
    const iris = list.draws[0];
    expectNear(iris.positions, [25, 20, 35, 20, 35, 30, 25, 30]);
    expectNear(iris.colors.slice(0, 4), [0, 0, 0, (128 / 255) * 0.5], 1e-6);
    expect(iris.maskInvert).toBe(true);
    expect(iris.masks).toHaveLength(1);
    const mask = iris.masks![0];
    expect(mask.partId).toBe('skin');
    expect(mask.positions).toBe(pose.parts.skin.fill);
    // Mask coverage ignores the mask part's tint (black), opacity (0.2) and visibility.
    expectNear(mask.colors.slice(0, 4), [1, 128 / 255, 0, 1], 1e-6);
    expect(list.draws[1].masks).toBeUndefined();
  });

  it('attaches an empty mask list when the mask parts produce no geometry', () => {
    const windowRig = makeRig({
      parameters: [{ id: 'Open', min: 0, max: 1 }],
      parts: [
        { id: 'win', shape: { type: 'rect', x: 10, y: 10, w: 20, h: 20 }, visible: false },
        { id: 'dot', shape: quad(12, 12, 16, 16), fill: '#ff0000', stroke: { color: '#000', width: 1 }, z: 1, mask: ['win'] },
      ],
      bindings: [{ target: 'part:win.shape.h', params: ['Open'], keys: [{ at: [0], value: 0 }, { at: [1], value: 20 }] }],
    });
    const closed = buildRenderList(windowRig, windowRig.pose({ params: { Open: 0 } }));
    expect(closed.draws.map((d) => `${d.partId}.${d.kind}`)).toEqual(['dot.fill', 'dot.stroke']);
    for (const d of closed.draws) {
      // Present (clipping applies) but empty: nothing covers, so the part must draw nothing.
      expect(d.masks).toEqual([]);
      expect(d.maskInvert).toBe(false);
    }
    const open = buildRenderList(windowRig, windowRig.pose({ params: { Open: 1 } }));
    expect(open.draws.map((d) => d.masks?.map((m) => m.partId))).toEqual([['win'], ['win']]);
  });

  it('never reuses the geometry of a pose produced by another rig', () => {
    const square = quad(0, 0, 10, 10);
    const a = makeRig({
      parts: [
        { id: 'p', shape: square, fill: '#ff0000' },
        { id: 'q', shape: square, fill: '#00ff00' },
      ],
    });
    const b = makeRig({
      parts: [
        { id: 'q', shape: square, fill: '#0000ff' },
        { id: 'p', shape: square, fill: '#ffffff' },
      ],
    });
    const list = buildRenderList(b, a.pose());
    expect(list.draws.map((d) => [d.partId, Array.from(d.colors.slice(0, 4))])).toEqual([
      ['p', [1, 1, 1, 1]],
      ['q', [0, 0, 1, 1]],
    ]);
  });

  it('rebuilds geometry for poses that were cloned (no identity link to the rig)', () => {
    const pose = rig.pose({ params: { A: 1 } });
    const direct = buildRenderList(rig, pose);
    const cloned = buildRenderList(rig, structuredClone(pose));
    expect(cloned.draws.map((d) => d.partId)).toEqual(direct.draws.map((d) => d.partId));
    expectNear(cloned.draws[0].colors, direct.draws[0].colors, 1e-3);
    expectNear(cloned.draws[0].positions, direct.draws[0].positions, 0);
  });
});
