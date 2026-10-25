/** Original synthetic full-body fixture. All landmarks are authored, never inferred from user art. */
import type { Doc, Pt } from './common.js';

export const FIGURE_POSES = ['standing', 'standing_point', 'sitting', 'sitting_phone'] as const;
export type FigurePose = (typeof FIGURE_POSES)[number];

export function figureLandmarks(pose: FigurePose) {
  const sitting = pose.startsWith('sitting');
  return {
    shoulderR: [130, 210] as Pt,
    elbowR: [108, 266] as Pt,
    wristR: [116, 312] as Pt,
    shoulderL: [230, 210] as Pt,
    elbowL: (pose === 'standing_point' ? [282, 210] : pose === 'sitting_phone' ? [260, 244] : [252, 266]) as Pt,
    wristL: (pose === 'standing_point' ? [320, 168] : pose === 'sitting_phone' ? [222, 238] : [244, 312]) as Pt,
    hips: [180, 326] as Pt,
    feet: (sitting
      ? [
          [132, 430],
          [272, 430],
        ]
      : [
          [150, 445],
          [210, 445],
        ]) as [Pt, Pt],
    seat: [180, 330] as Pt,
  };
}

export function buildFigure(pose: FigurePose = 'standing'): Doc {
  const p = figureLandmarks(pose),
    parts: Record<string, unknown>[] = [];
  const add = (id: string, shape: unknown, fill: string, width = 4) =>
    parts.push({ id, shape, fill, stroke: { color: '#17202b', width }, z: parts.length });
  const line = (id: string, points: Pt[], fill: string, width: number) => {
    parts.push({
      id,
      shape: { type: 'path', d: points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ') },
      fill: 'transparent',
      stroke: { color: '#17202b', width: width + 6 },
      z: parts.length,
    });
    parts.push({
      id: id + '_fill',
      shape: { type: 'path', d: points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ') },
      fill: 'transparent',
      stroke: { color: fill, width },
      z: parts.length,
    });
  };
  line('legR', [[153, 316], ...(pose.startsWith('sitting') ? [[114, 350] as Pt] : []), p.feet[0]], '#364354', 25);
  line('legL', [[207, 316], ...(pose.startsWith('sitting') ? [[260, 350] as Pt] : []), p.feet[1]], '#364354', 25);
  for (const [i, foot] of p.feet.entries())
    add(`shoe${i}`, { type: 'rect', x: foot[0] - 22, y: foot[1] - 10, w: 50, h: 20, radius: 8 }, '#29384f');
  line('armR', [p.shoulderR, p.elbowR, p.wristR], '#327fba', 20);
  line('armL', [p.shoulderL, p.elbowL, p.wristL], '#327fba', 20);
  add('jacket', { type: 'path', d: 'M 130 198 Q 180 181 230 198 L 230 321 Q 180 340 130 321 Z' }, '#328bc7');
  add('shirt', { type: 'rect', x: 169, y: 204, w: 22, h: 118 }, '#ece9dc', 2);
  add('neck', { type: 'rect', x: 164, y: 163, w: 32, h: 36, radius: 8 }, '#ffffff');
  add('head', { type: 'ellipse', cx: 180, cy: 115, rx: 59, ry: 65 }, '#ffffff');
  add(
    'hair',
    {
      type: 'path',
      d: 'M 123 103 L 118 65 L 139 74 L 147 43 L 166 58 L 186 36 L 202 58 L 230 51 L 239 100 L 222 81 L 207 90 L 183 74 L 158 91 L 138 87 Z',
    },
    '#26313c',
  );
  for (const [id, x] of [
    ['R', 155],
    ['L', 205],
  ] as const) {
    add('eye' + id, { type: 'ellipse', cx: x, cy: 117, rx: 13, ry: 16 }, '#ffffff', 2);
    add('pupil' + id, { type: 'ellipse', cx: x + 2, cy: 119, rx: 5, ry: 8 }, '#26313c', 0);
    add('glasses' + id, { type: 'ellipse', cx: x, cy: 117, rx: 21, ry: 23 }, 'transparent', 3);
  }
  line(
    'bridge',
    [
      [176, 114],
      [184, 114],
    ],
    '#17202b',
    2,
  );
  add('nose', { type: 'path', d: 'M 178 128 L 173 137 L 183 137' }, 'transparent', 2);
  add('mouth', { type: 'path', d: 'M 162 150 Q 180 162 198 150' }, 'transparent', 3);
  for (const [id, hand] of [
    ['R', p.wristR],
    ['L', p.wristL],
  ] as const)
    add('hand' + id, { type: 'ellipse', cx: hand[0], cy: hand[1], rx: 13, ry: 15 }, '#ffffff', 3);
  if (pose === 'sitting_phone') add('phone', { type: 'rect', x: 215, y: 213, w: 25, h: 42, radius: 4 }, '#26313c');
  return {
    format: 'rev2d',
    version: 1,
    meta: { name: 'figure_' + pose, width: 360, height: 480 },
    bones: [{ id: 'root' }],
    parts,
  };
}
