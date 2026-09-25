/**
 * "slime": a cute jelly mascot showing squash & stretch with a warp, a jump (one-shot and looping),
 * blend modes ("add" glow and sparkles, "multiply" ground shadow), an ellipse-ry eye blink, a mouth
 * path morph and animation events ("takeoff", "land").
 */
import { d, key, warpOffsets, type Doc, type Rect } from './common.js';

const W = 400;
const H = 400;
const CX = 200;
const GROUND = 330;

/** Squash lattice; its bottom row (y 336) is the ground line, just below the body outline and its stroke. */
const BODY_RECT: Rect = [92, 176, 216, 160];
/** Jump = 1 lifts the body this far (px): the additive glow around it still clears the top of the canvas. */
const JUMP_HEIGHT = 140;
const COLS = 3;
const ROWS = 3;

/** Squash (+1: flatter and wider) / stretch (-1: taller and narrower); the bottom row stays on the ground. */
function squash(s: number) {
  return warpOffsets(BODY_RECT, COLS, ROWS, (x, _y, _c, row) => {
    const up = 1 - row / ROWS; // 1 at the top row, 0 at the ground
    const side = (x - CX) / (BODY_RECT[2] / 2); // -1 .. 1
    const spread = 0.55 + 0.45 * (row / ROWS); // the base spreads more than the top
    return s > 0 ? [side * 30 * spread, 46 * up] : [side * -20 * spread, -52 * up];
  }, { form: 'full' });
}

function lean(l: number) {
  return warpOffsets(BODY_RECT, COLS, ROWS, (_x, _y, _c, row) => [l * [34, 22, 8, 0][row], Math.abs(l) * [4, 2, 0, 0][row]], {
    form: 'full',
  });
}

/** Four-pointed sparkle star. */
function star(cx: number, cy: number, r: number): string {
  const k = r * 0.22;
  return d`M ${cx} ${cy - r} C ${cx + k} ${cy - k} ${cx + k} ${cy - k} ${cx + r} ${cy} C ${cx + k} ${cy + k} ${cx + k} ${cy + k} ${cx} ${cy + r}
    C ${cx - k} ${cy + k} ${cx - k} ${cy + k} ${cx - r} ${cy} C ${cx - k} ${cy - k} ${cx - k} ${cy - k} ${cx} ${cy - r} Z`;
}

const MOUTH = {
  closed: d`M 188 284 C 192 291 208 291 212 284 C 208 287 192 287 188 284 Z`,
  open: d`M 186 282 C 190 280 210 280 214 282 C 214 302 186 302 186 282 Z`,
};

export function buildSlime(): Doc {
  const parameters = [
    { id: 'Squash', min: -1, max: 1, default: 0, group: 'Body', description: '+1 squashed flat and wide, -1 stretched tall and thin.' },
    { id: 'Lean', min: -1, max: 1, default: 0, group: 'Body', description: 'Top of the body leans left (-1) / right (+1).' },
    { id: 'Jump', min: 0, max: 1, default: 0, group: 'Body', description: `Height above the ground: 0 grounded, 1 = ${JUMP_HEIGHT} px up.` },
    { id: 'EyeOpen', min: 0, max: 1, default: 1, group: 'Face', description: 'Both eyes: 0 closed (ellipse ry shrinks), 1 open.' },
    { id: 'MouthOpen', min: 0, max: 1, default: 0, group: 'Face', description: '0 small smile, 1 open "wheee".' },
    { id: 'Glow', min: 0, max: 1, default: 0.4, group: 'Effects', description: 'Inner glow and sparkles (additive blending).' },
  ];

  const bones = [
    { id: 'root', x: CX, y: GROUND, length: 0, description: 'Ground contact point (the shadow stays here).' },
    { id: 'body', parent: 'root', x: 0, y: 0, rotation: -90, length: 150, description: 'Lifted by Jump; everything but the shadow and floor rides on it.' },
  ];

  const warps = [
    { id: 'bodyWarp', parent: 'body', rect: BODY_RECT, cols: COLS, rows: ROWS, description: 'Squash & stretch and lean lattice. Bottom row = ground line.' },
  ];

  const bodyPath = d`M 104 326 C 96 276 126 186 200 186 C 274 186 304 276 296 326 C 282 336 118 336 104 326 Z`;
  const parts = [
    {
      id: 'floor',
      shape: { type: 'rect', x: -10, y: GROUND - 6, w: W + 20, h: H - GROUND + 16 },
      fill: { type: 'linear', from: [0, GROUND - 6], to: [0, H], stops: [[0, '#5b6f96'], [1, '#34405c']] },
      z: 0,
      description: 'Static floor (no parent = model space).',
    },
    {
      id: 'shadow',
      parent: 'root',
      shape: { type: 'ellipse', cx: CX, cy: GROUND, rx: 96, ry: 14, detail: 8 },
      fill: { type: 'radial', center: [CX, GROUND], radius: 96, stops: [[0, '#1c2438'], [0.7, '#3d4a68'], [1, '#ffffff']] },
      blend: 'multiply',
      opacity: 0.9,
      z: 1,
      description: 'Multiply blend darkens the floor; the white rim multiplies to no change. Shrinks and fades with Jump.',
    },
    {
      id: 'glow',
      parent: 'body',
      shape: { type: 'ellipse', cx: CX, cy: 262, rx: 150, ry: 120, detail: 14 },
      fill: { type: 'radial', center: [CX, 262], radius: 150, stops: [[0, 'rgba(90,255,200,0.55)'], [0.55, 'rgba(60,200,220,0.18)'], [1, 'rgba(40,120,200,0)']] },
      blend: 'add',
      opacity: 0.55,
      z: 2,
      description: 'Additive halo behind the body; Glow drives its opacity (0.55 at the default Glow 0.4).',
    },
    {
      id: 'body',
      parent: 'bodyWarp',
      shape: { type: 'path', d: bodyPath, detail: 10 },
      fill: { type: 'radial', center: [170, 226], radius: 150, stops: [[0, '#c9fff0'], [0.45, '#5fe3c0'], [1, '#1f9e93']] },
      stroke: { color: '#0f5c5c', width: 3 },
      z: 3,
    },
    {
      id: 'core',
      parent: 'bodyWarp',
      shape: { type: 'rect', x: 134, y: 256, w: 144, h: 80, detail: 6 },
      fill: { type: 'radial', center: [206, 328], radius: 72, stops: [[0, 'rgba(120,255,220,0.55)'], [1, 'rgba(120,255,220,0)']] },
      blend: 'add',
      opacity: 0.58,
      z: 4,
      mask: ['body'],
      description:
        'Additive inner light near the base, clipped to the body. The radial gradient is transparent beyond its 72 px radius, so a rect covering the visible top of that circle (inside bodyWarp) looks like the whole circle.',
    },
    {
      id: 'shine',
      parent: 'bodyWarp',
      shape: { type: 'path', d: d`M 134 250 C 132 222 150 204 172 200 C 158 212 148 230 146 252 C 144 260 136 260 134 250 Z`, detail: 6 },
      fill: 'rgba(255,255,255,0.85)',
      z: 5,
      description: 'Glossy rim highlight.',
    },
    {
      id: 'shineDot',
      parent: 'bodyWarp',
      shape: { type: 'ellipse', cx: 150, cy: 272, rx: 5, ry: 7 },
      fill: 'rgba(255,255,255,0.8)',
      z: 5,
    },
    {
      id: 'cheeks',
      parent: 'bodyWarp',
      shape: { type: 'path', d: `${d`M 140 282 C 140 274 164 274 164 282 C 164 290 140 290 140 282 Z`} ${d`M 236 282 C 236 274 260 274 260 282 C 260 290 236 290 236 282 Z`}`, detail: 4 },
      fill: 'rgba(255,105,150,0.6)',
      z: 6,
    },
    ...(['eyeL', 'eyeR'] as const).map((id, i) => ({
      id,
      parent: 'bodyWarp',
      shape: { type: 'ellipse', cx: i === 0 ? 172 : 228, cy: 262, rx: 9, ry: 14 },
      fill: '#12303a',
      z: 7,
      description: 'Blinks by binding shape.ry to EyeOpen.',
    })),
    ...(['eyeShineL', 'eyeShineR'] as const).map((id, i) => ({
      id,
      parent: 'bodyWarp',
      shape: { type: 'ellipse', cx: (i === 0 ? 172 : 228) - 3, cy: 256, rx: 3.5, ry: 4 },
      fill: '#ffffff',
      z: 8,
    })),
    {
      id: 'mouth',
      parent: 'bodyWarp',
      shape: { type: 'path', d: MOUTH.closed, tolerance: 0.2 },
      fill: '#12303a',
      z: 7,
      description: 'Path morph between a small smile and an open mouth (same M C C Z structure).',
    },
    {
      id: 'sparkles',
      parent: 'body',
      shape: { type: 'path', d: `${star(118, 196, 11)} ${star(290, 214, 8)} ${star(262, 168, 6)}`, tolerance: 0.2 },
      fill: '#bffff0',
      blend: 'add',
      opacity: 0.2,
      z: 9,
      description: 'Additive sparkles; opacity follows Glow.',
    },
  ];

  const bindings = [
    {
      id: 'squashStretch',
      target: 'warp:bodyWarp.offsets',
      params: ['Squash'],
      keys: [
        { at: [-1], value: squash(-1) },
        { at: [0], value: {} },
        { at: [1], value: squash(1) },
      ],
    },
    {
      id: 'lean',
      target: 'warp:bodyWarp.offsets',
      params: ['Lean'],
      keys: [
        { at: [-1], value: lean(-1) },
        { at: [0], value: {} },
        { at: [1], value: lean(1) },
      ],
      description: 'Adds to squashStretch (bindings on one property sum their deltas).',
    },
    { target: 'bone:body.y', params: ['Jump'], keys: [{ at: [0], value: 0 }, { at: [1], value: -JUMP_HEIGHT }], description: 'Bone x/y are in the parent (root) frame: -y is up.' },
    { target: 'part:shadow.shape.rx', params: ['Jump'], keys: [{ at: [0], value: 96 }, { at: [1], value: 52 }] },
    { target: 'part:shadow.shape.ry', params: ['Jump'], keys: [{ at: [0], value: 14 }, { at: [1], value: 8 }] },
    { target: 'part:shadow.opacity', params: ['Jump'], keys: [{ at: [0], value: 0.9 }, { at: [1], value: 0.35 }] },
    { target: 'part:shadow.shape.rx', params: ['Squash'], keys: [{ at: [-1], value: 84 }, { at: [0], value: 96 }, { at: [1], value: 112 }] },
    { target: 'part:eyeL.shape.ry', params: ['EyeOpen'], keys: [{ at: [0], value: 1.5 }, { at: [1], value: 14 }] },
    { target: 'part:eyeR.shape.ry', params: ['EyeOpen'], keys: [{ at: [0], value: 1.5 }, { at: [1], value: 14 }] },
    { target: 'part:eyeShineL.opacity', params: ['EyeOpen'], keys: [{ at: [0.4], value: 0 }, { at: [0.8], value: 1 }] },
    { target: 'part:eyeShineR.opacity', params: ['EyeOpen'], keys: [{ at: [0.4], value: 0 }, { at: [0.8], value: 1 }] },
    { target: 'part:mouth.shape.d', params: ['MouthOpen'], keys: [{ at: [0], value: MOUTH.closed }, { at: [1], value: MOUTH.open }] },
    { target: 'part:glow.opacity', params: ['Glow'], keys: [{ at: [0], value: 0.25 }, { at: [1], value: 1 }] },
    { target: 'part:core.opacity', params: ['Glow'], keys: [{ at: [0], value: 0.3 }, { at: [1], value: 1 }] },
    { target: 'part:sparkles.opacity', params: ['Glow'], keys: [{ at: [0.25], value: 0 }, { at: [1], value: 1 }] },
  ];

  const blink = (t: number) => [key(t, 1, 'inQuad'), key(t + 0.06, 0), key(t + 0.12, 0, 'outQuad'), key(t + 0.26, 1)];
  const animations = [
    {
      id: 'idle',
      duration: 2,
      loop: true,
      description: 'Jelly wobble with a glow pulse and a blink; loops seamlessly.',
      tracks: [
        { target: 'param:Squash', keys: [key(0, 0.12, 'inOutSine'), key(0.5, -0.12, 'inOutSine'), key(1, 0.12, 'inOutSine'), key(1.5, -0.12, 'inOutSine'), key(2, 0.12)] },
        { target: 'param:Lean', keys: [key(0, -0.15, 'inOutSine'), key(1, 0.15, 'inOutSine'), key(2, -0.15)] },
        { target: 'param:Glow', keys: [key(0, 0.3, 'inOutSine'), key(1, 0.7, 'inOutSine'), key(2, 0.3)] },
        { target: 'param:EyeOpen', keys: [key(0, 1), ...blink(1.3), key(2, 1)] },
      ],
    },
    {
      id: 'blink',
      duration: 0.3,
      loop: false,
      description:
        'One blink designed as a once-layer: EyeOpen starts and ends at 1 (the default) and nothing else moves, so idle + "blink,once,start=0.5" adds a blink and hands the eyes back to idle.',
      tracks: [{ target: 'param:EyeOpen', keys: blink(0) }],
    },
    {
      id: 'jump',
      duration: 1.5,
      loop: false,
      description: 'One jump: anticipation squash, stretch on takeoff, apex, stretch while falling, impact squash, wobble settle.',
      tracks: [
        {
          target: 'param:Squash',
          keys: [
            key(0, 0, 'outQuad'),
            key(0.28, 0.9, 'inQuad'),
            key(0.38, -0.9, 'outQuad'),
            key(0.72, -0.1, 'inQuad'),
            key(0.98, -0.7, 'linear'),
            key(1.04, 1, 'outQuad'),
            key(1.18, -0.35, 'inOutSine'),
            key(1.32, 0.15, 'inOutSine'),
            key(1.5, 0),
          ],
        },
        { target: 'param:Jump', keys: [key(0, 0), key(0.36, 0, 'outQuad'), key(0.72, 1, 'inQuad'), key(1.04, 0)] },
        { target: 'param:Lean', keys: [key(0, 0, 'inOutSine'), key(0.28, -0.3, 'outQuad'), key(0.6, 0.2, 'inOutSine'), key(1.04, 0, 'outQuad'), key(1.2, 0.25, 'inOutSine'), key(1.5, 0)] },
        { target: 'param:EyeOpen', keys: [key(0, 1), key(0.22, 1, 'outQuad'), key(0.3, 0.2, 'outQuad'), key(0.42, 1), key(1.0, 1, 'outQuad'), key(1.06, 0.1), key(1.2, 0.1, 'outQuad'), key(1.34, 1)] },
        { target: 'param:MouthOpen', keys: [key(0.3, 0, 'outQuad'), key(0.45, 1), key(0.9, 1, 'inQuad'), key(1.04, 0)] },
        { target: 'param:Glow', keys: [key(0, 0.4), key(1.02, 0.4, 'outQuad'), key(1.08, 1, 'inOutSine'), key(1.5, 0.4)] },
      ],
      events: [
        { t: 0.38, name: 'takeoff' },
        { t: 1.04, name: 'land', data: { impact: 1 } },
      ],
    },
    {
      id: 'jump_loop',
      duration: 1,
      loop: true,
      description: 'Continuous hopping: lands and immediately takes off again (first key = last key).',
      tracks: [
        {
          target: 'param:Squash',
          keys: [key(0, 0.85, 'outQuad'), key(0.1, -0.85, 'outQuad'), key(0.45, -0.1, 'inQuad'), key(0.8, -0.6, 'linear'), key(0.86, 1, 'outQuad'), key(1, 0.85)],
        },
        { target: 'param:Jump', keys: [key(0, 0), key(0.08, 0, 'outQuad'), key(0.45, 0.85, 'inQuad'), key(0.86, 0), key(1, 0)] },
        { target: 'param:MouthOpen', keys: [key(0, 0, 'outQuad'), key(0.2, 0.8, 'inOutSine'), key(0.7, 0.8, 'inQuad'), key(0.86, 0), key(1, 0)] },
        { target: 'param:Glow', keys: [key(0, 0.8, 'outQuad'), key(0.5, 0.35, 'inQuad'), key(0.86, 0.9, 'outQuad'), key(1, 0.8)] },
      ],
      events: [
        { t: 0.1, name: 'takeoff' },
        { t: 0.86, name: 'land', data: { impact: 0.8 } },
      ],
    },
  ];

  return {
    format: 'rev2d',
    version: 1,
    meta: {
      name: 'slime',
      width: W,
      height: H,
      background: '#232c42',
      fps: 30,
      author: 'Rev2D examples',
      description:
        'Squash & stretch mascot: warp keyforms for Squash/Lean, bone lift for Jump, add/multiply blending, ellipse-ry blink, mouth path morph, "takeoff"/"land" events.',
    },
    parameters,
    bones,
    warps,
    parts,
    bindings,
    animations,
  };
}
