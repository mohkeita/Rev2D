/**
 * "minimal": the smallest instructive Rev2D model. One parameter bends one warp through one binding,
 * one bone carries the warp, two parts live inside it, and one looping animation drives the parameter.
 */
import { warpOffsets, type Doc, type Rect } from './common.js';

export function buildMinimal(): Doc {
  const rect: Rect = [68, 60, 120, 150];
  const cols = 2;
  const rows = 2;
  // Lean: the top row slides sideways the most, the middle row half as much, the base stays planted.
  const lean = (dir: number) =>
    warpOffsets(rect, cols, rows, (_x, _y, _c, row) => [dir * [28, 14, 0][row], row === 0 ? 4 : 0], { form: 'sparse' });

  return {
    format: 'rev2d',
    version: 1,
    meta: {
      name: 'minimal',
      width: 256,
      height: 256,
      background: '#1f2430',
      fps: 30,
      description:
        'Smallest instructive model: parameter "Lean" -> binding -> warp "bodyWarp" (parented to bone "root") bends the two parts inside it; animation "sway" drives Lean.',
    },
    parameters: [{ id: 'Lean', min: -1, max: 1, default: 0, description: 'Lean the blob left (-1) or right (+1).' }],
    bones: [{ id: 'root', x: 128, y: 210, length: 0, description: 'Ground contact point; moving it moves everything.' }],
    warps: [
      {
        id: 'bodyWarp',
        parent: 'root',
        rect,
        cols,
        rows,
        description: '2x2 lattice over the body. Points are row-major: 0-2 top row, 3-5 middle, 6-8 bottom.',
      },
    ],
    parts: [
      {
        id: 'body',
        parent: 'bodyWarp',
        shape: { type: 'ellipse', cx: 128, cy: 140, rx: 56, ry: 66, detail: 10 },
        fill: { type: 'radial', center: [110, 112], radius: 96, stops: [[0, '#a7f3c8'], [1, '#2f9e6e']] },
        stroke: { color: '#14432f', width: 3 },
        description: '"detail" densifies the mesh so the warp bends it smoothly.',
      },
      {
        id: 'eye',
        parent: 'bodyWarp',
        shape: { type: 'ellipse', cx: 128, cy: 124, rx: 9, ry: 14 },
        fill: '#14432f',
        z: 1,
        description: 'Higher z draws on top of the body.',
      },
    ],
    bindings: [
      {
        target: 'warp:bodyWarp.offsets',
        params: ['Lean'],
        keys: [
          { at: [-1], value: lean(-1) },
          { at: [0], value: {} },
          { at: [1], value: lean(1) },
        ],
        description: 'Sparse offsets: only the listed lattice points move; {} = rest.',
      },
    ],
    animations: [
      {
        id: 'sway',
        duration: 2,
        loop: true,
        tracks: [
          {
            target: 'param:Lean',
            keys: [
              { t: 0, v: -1, ease: 'inOutSine' },
              { t: 1, v: 1, ease: 'inOutSine' },
              { t: 2, v: -1 },
            ],
          },
        ],
        description: 'Animations drive parameters; the binding turns Lean into the bend.',
      },
    ],
  };
}
