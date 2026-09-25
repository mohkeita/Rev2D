import { describe, expect, it } from 'vitest';
import { buildRenderList, Rig } from '../rig.js';
import { expectNear, makeModel, makeRig } from './rig.fixtures.js';

const A = { id: 'A', min: 0, max: 1 };
const B = { id: 'B', min: 0, max: 1 };

describe('rig: shape bindings with compiled geometry', () => {
  it('rebuilds an ellipse whose ry is bound to a parameter', () => {
    const rig = makeRig({
      parameters: [A],
      parts: [{ id: 'mouth', shape: { type: 'ellipse', cx: 100, cy: 100, rx: 20, ry: 2 }, fill: '#a0303a' }],
      bindings: [{ target: 'part:mouth.shape.ry', params: ['A'], keys: [{ at: [0], value: 2 }, { at: [1], value: 16 }] }],
    });
    // The outline is a polygon, so its extremes sit slightly inside the true ellipse.
    expectNear(rig.pose().parts.mouth.bounds!, [80, 98, 40, 4], 0.5);
    const half = rig.pose({ params: { A: 0.5 } });
    expect(half.properties['part:mouth.shape.ry']).toBe(9);
    expectNear(half.parts.mouth.bounds!, [80, 91, 40, 18], 0.5);
    expectNear(rig.pose({ params: { A: 1 } }).parts.mouth.bounds!, [80, 84, 40, 32], 0.5);
  });

  it('deforms strokes with the part and includes them in the bounds', () => {
    const rig = makeRig({
      parameters: [A],
      bones: [{ id: 'b', x: 100, y: 100 }],
      parts: [
        {
          id: 'box',
          parent: 'b',
          shape: { type: 'rect', x: 100, y: 90, w: 40, h: 20 },
          stroke: { color: '#000000', width: 4 },
        },
      ],
      bindings: [{ target: 'bone:b.rotation', params: ['A'], keys: [{ at: [0], value: 0 }, { at: [1], value: 90 }] }],
    });
    const rest = rig.pose().parts.box;
    expectNear(rest.bounds!, [98, 88, 44, 24], 0.05);
    const pose = rig.pose({ params: { A: 1 } });
    expectNear(pose.parts.box.bounds!, [88, 98, 24, 44], 0.05);
    const list = buildRenderList(rig, pose);
    expect(list.draws.map((d) => d.kind)).toEqual(['fill', 'stroke']);
    expect(list.draws[1].positions).toBe(pose.parts.box.stroke);
  });

  it('binds stroke width and color', () => {
    const rig = makeRig({
      parameters: [A],
      parts: [{ id: 'r', shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 }, stroke: { color: '#000000', width: 2 } }],
      bindings: [
        { target: 'part:r.stroke.width', params: ['A'], keys: [{ at: [0], value: 2 }, { at: [1], value: -6 }] },
        { target: 'part:r.stroke.color', params: ['A'], keys: [{ at: [0], value: '#000000' }, { at: [1], value: '#ff0000' }] },
      ],
    });
    expectNear(rig.pose().parts.r.bounds!, [-1, -1, 12, 12], 0.05);
    const quarter = rig.pose({ params: { A: 0.125 } });
    expect(quarter.properties['part:r.stroke.width']).toBe(1);
    expectNear(quarter.parts.r.bounds!, [-0.5, -0.5, 11, 11], 0.05);
    const strokeDraw = buildRenderList(rig, quarter).draws[1];
    expectNear(strokeDraw.colors.slice(0, 4), [0.125, 0, 0, 1], 1e-6);
    // Width clamps at 0: the stroke disappears.
    expect(rig.pose({ params: { A: 1 } }).parts.r.stroke).toBeNull();
  });

  it('binds polygon points (sparse) and morphs paths with the same structure', () => {
    const rig = makeRig({
      parameters: [A, B],
      parts: [
        { id: 'tri', shape: { type: 'polygon', points: [0, 0, 10, 0, 0, 10] } },
        { id: 'path', shape: { type: 'path', d: 'M0 0 L10 0 L10 10 Z' } },
      ],
      bindings: [
        { target: 'part:tri.shape.points', params: ['A'], keys: [{ at: [0], value: {} }, { at: [1], value: { '1': [30, 0] } }] },
        { target: 'part:path.shape.d', params: ['B'], keys: [{ at: [0], value: 'M0 0 L10 0 L10 10 Z' }, { at: [1], value: 'M0 0 L20 0 L20 20 Z' }] },
      ],
    });
    const pose = rig.pose({ params: { A: 0.5, B: 0.5 } });
    expectNear(pose.parts.tri.bounds!, [0, 0, 20, 10], 1e-4);
    expect(pose.properties['part:path.shape.d']).toBe('M0 0 L15 0 L15 15 Z');
    expectNear(pose.parts.path.bounds!, [0, 0, 15, 15], 1e-3);
    expect(() =>
      makeRig({
        parameters: [B],
        parts: [{ id: 'path', shape: { type: 'path', d: 'M0 0 L10 0 L10 10 Z' } }],
        bindings: [{ target: 'part:path.shape.d', params: ['B'], keys: [{ at: [0], value: 'M0 0 L5 5 Z' }] }],
      }),
    ).toThrow(/path structure differs/);
  });

  it('morphs paths at full precision and snaps interpolated arc flags to 0/1', () => {
    const arcUp = 'M0 0 A10 10 0 0 1 20 0 Z';
    const arcDown = 'M0 0 A10 10 0 0 0 20 0 Z';
    const rig = makeRig({
      parameters: [A, B],
      parts: [
        { id: 'arc', shape: { type: 'path', d: arcUp } },
        { id: 'fine', shape: { type: 'path', d: 'M0 0 L10 0 L10 10 Z' } },
      ],
      bindings: [
        { target: 'part:arc.shape.d', params: ['A'], keys: [{ at: [0], value: arcUp }, { at: [1], value: arcDown }] },
        { target: 'part:fine.shape.d', params: ['B'], keys: [{ at: [0], value: 'M0 0 L10 0 L10 10 Z' }, { at: [1], value: 'M0 0 L10 0 L10.0002 10 Z' }] },
      ],
    });
    // The sweep flag switches halfway, like a boolean: sweep 1 bulges up (y < 0), sweep 0 down.
    const early = rig.pose({ params: { A: 0.4, B: 0.5 } });
    expect(early.properties['part:arc.shape.d']).toBe(arcUp);
    expect(early.parts.arc.bounds![1]).toBeLessThan(-9);
    const late = rig.pose({ params: { A: 0.6 } });
    expect(late.properties['part:arc.shape.d']).toBe(arcDown);
    expect(late.parts.arc.bounds![1]).toBeGreaterThan(-1e-6);
    // Geometry is built from the unrounded morph (10.0001), not the 3-decimal display string.
    expect(early.parts.fine.bounds![2]).toBeCloseTo(10.0001, 5);
  });

  it('binds solid fill colors (clamped) into the render list', () => {
    const rig = makeRig({
      parameters: [A],
      parts: [{ id: 'dot', shape: { type: 'ellipse', cx: 10, cy: 10, rx: 5, ry: 5 }, fill: { type: 'solid', color: '#000000' } }],
      bindings: [{ target: 'part:dot.fill', params: ['A'], keys: [{ at: [0], value: '#000000' }, { at: [1], value: '#8040ff' }] }],
    });
    const draw = buildRenderList(rig, rig.pose({ params: { A: 0.5 } })).draws[0];
    expectNear(draw.colors.slice(0, 4), [64 / 255, 32 / 255, 0.5, 1], 1e-6);
  });

  it('combines image size bindings relative to the texture size when w/h are omitted', () => {
    const rig = makeRig({
      parameters: [A, B],
      textures: [{ id: 'tex', path: 'tex.png', width: 64, height: 32 }],
      parts: [{ id: 'img', shape: { type: 'image', texture: 'tex', x: 0, y: 0 } }],
      bindings: [
        { target: 'part:img.shape.w', params: ['A'], keys: [{ at: [0], value: 64 }, { at: [1], value: 128 }] },
        { target: 'part:img.shape.w', params: ['B'], keys: [{ at: [0], value: 64 }, { at: [1], value: 96 }] },
      ],
    });
    expectNear(rig.pose().parts.img.bounds!, [0, 0, 64, 32], 1e-4);
    // setup 64 + (128 - 64) + (96 - 64)
    expectNear(rig.pose({ params: { A: 1, B: 1 } }).parts.img.bounds!, [0, 0, 160, 32], 1e-4);
    const draw = buildRenderList(rig, rig.pose()).draws[0];
    expect(draw.texture).toBe('tex');
    expect(draw.uvs).toBeDefined();
  });

  it('takes the omitted image size setup from the crop, or from the texture sizes given to the rig', () => {
    const combinedWidth = (part: object, sizes?: Record<string, { width: number; height: number }>) => {
      const model = makeModel({
        parameters: [A],
        textures: [{ id: 'tex', path: 'tex.png', width: 64, height: 32 }],
        parts: [{ id: 'img', shape: { type: 'image', texture: 'tex', x: 0, y: 0, ...part } }],
        // A second binding on the same property: combining relies on the correct setup value.
        bindings: [
          { target: 'part:img.shape.w', params: ['A'], keys: [{ at: [0], value: 80 }, { at: [1], value: 80 }] },
          { target: 'part:img.shape.w', params: ['A'], keys: [{ at: [0], value: 90 }, { at: [1], value: 90 }] },
        ],
      });
      return new Rig(model, { textures: sizes }).pose().properties['part:img.shape.w'];
    };
    // setup + (80 - setup) + (90 - setup) = 170 - setup
    expect(combinedWidth({})).toBe(170 - 64);
    expect(combinedWidth({ crop: [0, 0, 10, 10] })).toBe(170 - 10);
    expect(combinedWidth({}, { tex: { width: 100, height: 50 } })).toBe(170 - 100);
  });

  it('rejects binding an omitted image size whose texture size is unknown', () => {
    const rig = () =>
      makeRig({
        parameters: [A],
        textures: [{ id: 'tex', path: 'tex.png' }],
        parts: [{ id: 'img', shape: { type: 'image', texture: 'tex', x: 0, y: 0, w: 10 } }],
        bindings: [{ target: 'part:img.shape.h', params: ['A'], keys: [{ at: [0], value: 1 }, { at: [1], value: 2 }] }],
      });
    expect(rig).toThrow(/^Rig: bindings\[0\] \(target "part:img.shape.h"\): size of texture "tex" is unknown \(needed as the setup value of image h\)$/);
  });
});
