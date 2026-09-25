import { describe, expect, it } from 'vitest';
import { buildRenderList } from '../rig.js';
import type { ModelInput } from '../types.js';
import { gridMesh, makeRig } from './rig.fixtures.js';

type Body = Omit<ModelInput, 'format' | 'version' | 'meta'>;

/** 30 bones (3 chains), 4 warps, 50 parts (bone / warp / skinned / free), 20 bindings. */
function benchmarkBody(): Body {
  const bones: NonNullable<Body['bones']> = [];
  for (let chain = 0; chain < 3; chain++) {
    for (let i = 0; i < 10; i++) {
      bones.push({ id: `b${chain}_${i}`, parent: i ? `b${chain}_${i - 1}` : undefined, x: i ? 20 : 100 + chain * 150, y: i ? 0 : 100, length: 20 });
    }
  }
  const parameters = Array.from({ length: 10 }, (_, i) => ({ id: `P${i}`, min: -1, max: 1 }));
  const warps: NonNullable<Body['warps']> = [
    { id: 'w0', rect: [0, 0, 250, 250], cols: 4, rows: 4 },
    { id: 'w1', parent: 'w0', rect: [50, 50, 150, 150], cols: 3, rows: 3 },
    { id: 'w2', parent: 'b1_2', rect: [250, 50, 150, 150], cols: 3, rows: 3 },
    { id: 'w3', rect: [300, 250, 200, 200], cols: 4, rows: 4 },
  ];
  const parts: NonNullable<Body['parts']> = [];
  for (let i = 0; i < 50; i++) {
    const x = (i % 10) * 45;
    const y = Math.floor(i / 10) * 90;
    const kind = i % 4;
    parts.push({
      id: `p${i}`,
      shape: gridMesh(x, y, 40, 40, 4, 4),
      z: i % 3,
      ...(kind === 0 ? { parent: `b${i % 3}_${i % 10}` } : {}),
      ...(kind === 1 ? { parent: `w${i % 4}` } : {}),
      ...(kind === 2 ? { skin: { bones: [`b${i % 3}_1`, `b${i % 3}_2`, `b${i % 3}_3`] } } : {}),
    });
  }
  const bindings: NonNullable<Body['bindings']> = [];
  for (let i = 0; i < 20; i++) {
    const p = `P${i % 10}`;
    if (i % 4 === 0) {
      bindings.push({
        target: `warp:w${(i / 4) % 4}.offsets`,
        params: [p, `P${(i + 1) % 10}`],
        keys: [
          { at: [-1, -1], value: { '6': [-5, -5] } },
          { at: [1, -1], value: { '6': [5, -5] } },
          { at: [-1, 1], value: { '6': [-5, 5] } },
          { at: [1, 1], value: { '6': [5, 5] } },
        ],
      });
    } else if (i % 4 === 1) {
      bindings.push({ target: `bone:b${i % 3}_${i % 10}.rotation`, params: [p], keys: [{ at: [-1], value: -20 }, { at: [1], value: 20 }] });
    } else if (i % 4 === 2) {
      bindings.push({ target: `part:p${i}.opacity`, params: [p], keys: [{ at: [-1], value: 0.5 }, { at: [1], value: 1 }] });
    } else {
      bindings.push({ target: `part:p${i}.tint`, params: [p], keys: [{ at: [-1], value: '#ff0000' }, { at: [1], value: '#ffffff' }] });
    }
  }
  return { parameters, bones, warps, parts, bindings };
}

describe('rig: performance', () => {
  it('poses a 50-part / 30-bone / 20-binding model in a few milliseconds', () => {
    const rig = makeRig(benchmarkBody());
    const frames = 200;
    for (let i = 0; i < 20; i++) rig.pose({ params: { P0: Math.sin(i) } });
    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      const pose = rig.pose({ params: { P0: Math.sin(i), P1: Math.cos(i), P4: (i % 20) / 10 - 1 } });
      buildRenderList(rig, pose);
    }
    const perFrame = (performance.now() - start) / frames;
    // Typically ~0.1-0.2 ms per pose + render list (target: 1-2 ms); 5 ms leaves headroom for slow CI.
    expect(perFrame).toBeLessThan(5);
  });
});
