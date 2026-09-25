/**
 * "textured": koinobori (carp streamers) on a pole. Shows bitmap textures in Rev2D:
 *   - image shapes with `crop` into an atlas and a cols x rows grid so warps can bend them,
 *   - warps that wave the textured grids (a traveling wave from two phase-shifted keyform sets),
 *   - a textured mesh shape with explicit uvs (the spinning pinwheel fan),
 *   - a mask that uses a texture's alpha (the sheen is clipped to the red carp's silhouette).
 * Textures come from scripts/gen-textures.ts.
 */
import { d, flat, key, r, warpOffsets, type Doc, type Pt, type Rect } from './common.js';

const W = 512;
const H = 384;
const POLE_X = 75;

interface Koi {
  id: string;
  crop: [number, number, number, number];
  x: number;
  y: number;
  w: number;
  h: number;
  rect: Rect;
  /** Wave phase offset (radians) so the two carp do not move in lockstep. */
  phase: number;
  /** Tail wave amplitude in px. */
  amp: number;
  /**
   * Droop angle at the tail when there is no wind (degrees). The hanging carp must stay on the canvas:
   * the blue one hangs from y = 261, so it droops less than the red one (its tail ends near y = 370).
   */
  droop: number;
}

const RED: Koi = { id: 'koiRed', crop: [0, 0, 256, 96], x: 82, y: 100, w: 256, h: 96, rect: [78, 92, 268, 112], phase: 0, amp: 14, droop: 72 };
/** The smaller carp (the atlas crop drawn at 69%), close enough under the red one to hang inside the canvas. */
const BLUE: Koi = { id: 'koiBlue', crop: [0, 96, 256, 96], x: 82, y: 228, w: 176, h: 66, rect: [78, 220, 188, 82], phase: Math.PI / 2, amp: 11, droop: 40 };
const WARP_COLS = 8;
const WARP_ROWS = 2;

/** Position along the carp: 0 at the mouth (pinned to the pole), 1 at the tail tip. */
const along = (k: Koi, x: number) => Math.min(1, Math.max(0, (x - k.x) / k.w));

/** No wind: the streamer hangs, bending down progressively toward the tail and deflating a little. */
function droopOffsets(k: Koi) {
  const pivot: Pt = [k.x, k.y + k.h / 2];
  return warpOffsets(k.rect, WARP_COLS, WARP_ROWS, (x, y) => {
    const u = along(k, x);
    const theta = ((k.droop * Math.PI) / 180) * u;
    const dx = (x - pivot[0]) * 0.84;
    const dy = (y - pivot[1]) * (1 - 0.3 * u);
    const nx = pivot[0] + dx * Math.cos(theta) - dy * Math.sin(theta);
    const ny = pivot[1] + dx * Math.sin(theta) + dy * Math.cos(theta);
    return [nx - x, ny - y];
  }, { form: 'full' });
}

/**
 * One component of a traveling wave. WaveSin = sin(wt) and WaveCos = cos(wt) weight the "sin" and
 * "cos" keyforms, and their sum is A(u) cos(2 pi u + phase - wt): a wave running from mouth to tail.
 */
function waveOffsets(k: Koi, component: 'sin' | 'cos', sign: number) {
  return warpOffsets(k.rect, WARP_COLS, WARP_ROWS, (x, _y, _c, row) => {
    const u = along(k, x);
    const a = 2 * Math.PI * 0.9 * u + k.phase;
    const s = component === 'sin' ? Math.sin(a) : Math.cos(a);
    // The body also breathes: top and bottom rows move apart / together slightly with the wave.
    const bulge = (row - 1) * 0.18 * k.amp * u * (component === 'sin' ? Math.cos(a) : -Math.sin(a));
    return [0, sign * (k.amp * u * s + bulge)];
  }, { form: 'full' });
}

/** Fan mesh (center + rim) with uvs mapping onto the round pinwheel texture. */
function pinwheelMesh(cx: number, cy: number, radius: number, rim: number) {
  const vertices: number[] = [cx, cy];
  const uvs: number[] = [0.5, 0.5];
  const triangles: number[] = [];
  for (let i = 0; i < rim; i++) {
    const a = (2 * Math.PI * i) / rim;
    vertices.push(r(cx + Math.cos(a) * radius, 2), r(cy + Math.sin(a) * radius, 2));
    uvs.push(r(0.5 + Math.cos(a) * 0.475, 4), r(0.5 + Math.sin(a) * 0.475, 4));
    triangles.push(0, 1 + i, 1 + ((i + 1) % rim));
  }
  return { type: 'mesh', vertices, triangles, uvs, texture: 'pinwheel' };
}

export function buildTextured(): Doc {
  const parameters = [
    { id: 'Wind', min: 0, max: 1, default: 1, group: 'Wind', description: '0 calm (streamers hang), 1 full wind (streamers fly).' },
    { id: 'WaveSin', min: -1, max: 1, default: 0, group: 'Wind', description: 'Traveling-wave sine component; animate with WaveCos 90 degrees apart.' },
    { id: 'WaveCos', min: -1, max: 1, default: 0, group: 'Wind', description: 'Traveling-wave cosine component.' },
    { id: 'Spin', min: 0, max: 4, default: 0, group: 'Wind', description: 'Pinwheel turns (1 = 360 degrees).' },
    { id: 'Sheen', min: 0, max: 1, default: 0.5, group: 'Effects', description: 'Position of the light sweep across the red carp (0 = before the mouth, 1 = past the tail).' },
    { id: 'CloudDrift', min: -1, max: 1, default: 0, group: 'Scene', description: 'Clouds slide left/right by 60 px.' },
  ];

  const bones = [
    { id: 'pinwheelHub', x: POLE_X, y: 66, length: 0, description: 'Pinwheel axle; Spin rotates it.' },
    { id: 'clouds', x: 0, y: 0, length: 0, description: 'Carrier for the clouds; CloudDrift moves it.' },
  ];

  const warps = [RED, BLUE].map((k) => ({
    id: `${k.id}Warp`,
    rect: k.rect,
    cols: WARP_COLS,
    rows: WARP_ROWS,
    description: `Bends the ${k.id} image grid: droop (Wind) + traveling wave (WaveSin/WaveCos).`,
  }));

  const cloud = (cx: number, cy: number, s: number) =>
    d`M ${cx - 40 * s} ${cy + 10 * s} C ${cx - 56 * s} ${cy + 10 * s} ${cx - 56 * s} ${cy - 12 * s} ${cx - 36 * s} ${cy - 10 * s}
      C ${cx - 32 * s} ${cy - 30 * s} ${cx - 4 * s} ${cy - 34 * s} ${cx + 4 * s} ${cy - 16 * s}
      C ${cx + 16 * s} ${cy - 30 * s} ${cx + 42 * s} ${cy - 22 * s} ${cx + 38 * s} ${cy - 4 * s}
      C ${cx + 58 * s} ${cy - 4 * s} ${cx + 58 * s} ${cy + 10 * s} ${cx + 40 * s} ${cy + 10 * s} Z`;

  const parts: Doc[] = [
    {
      id: 'sky',
      shape: { type: 'rect', x: 0, y: 0, w: W, h: H },
      fill: { type: 'linear', from: [0, 0], to: [0, H], stops: [[0, '#6fbdf0'], [1, '#e2f4ff']] },
      z: 0,
    },
    {
      id: 'cloudShapes',
      parent: 'clouds',
      shape: { type: 'path', d: `${cloud(250, 60, 1)} ${cloud(396, 110, 0.8)} ${cloud(360, 330, 0.7)}`, detail: 16 },
      description: 'CloudDrift slides them 60 px either way; placed so they stay on the canvas at both ends.',
      fill: 'rgba(255,255,255,0.9)',
      z: 1,
    },
    {
      id: 'hills',
      shape: { type: 'path', d: d`M -10 ${H + 10} L -10 344 C 80 318 160 330 240 342 C 330 356 420 326 522 334 L 522 ${H + 10} Z`, detail: 20 },
      fill: { type: 'linear', from: [0, 320], to: [0, H], stops: [[0, '#7cc36a'], [1, '#4f9a4a']] },
      z: 2,
    },
    {
      id: 'pole',
      shape: { type: 'rect', x: POLE_X - 5, y: 34, w: 10, h: H - 24, radius: 2 },
      fill: { type: 'linear', from: [POLE_X - 5, 0], to: [POLE_X + 5, 0], stops: [[0, '#8a5a32'], [0.4, '#c89060'], [1, '#6e4424']] },
      stroke: { color: '#4a2c14', width: 1.5 },
      z: 3,
    },
    {
      id: 'poleBall',
      shape: { type: 'ellipse', cx: POLE_X, cy: 30, rx: 8, ry: 8 },
      fill: { type: 'radial', center: [POLE_X - 3, 27], radius: 10, stops: [[0, '#fff1b0'], [1, '#d49a1c']] },
      stroke: { color: '#7a5210', width: 1.2 },
      z: 4,
    },
    {
      id: BLUE.id,
      parent: `${BLUE.id}Warp`,
      shape: { type: 'image', texture: 'koiAtlas', crop: BLUE.crop, x: BLUE.x, y: BLUE.y, w: BLUE.w, h: BLUE.h, cols: 16, rows: 4 },
      z: 5,
      description: 'Blue carp: lower half of the atlas (crop), drawn smaller; 16x4 grid so the warp bends it smoothly.',
    },
    {
      id: RED.id,
      parent: `${RED.id}Warp`,
      shape: { type: 'image', texture: 'koiAtlas', crop: RED.crop, x: RED.x, y: RED.y, w: RED.w, h: RED.h, cols: 16, rows: 4 },
      z: 6,
      description: 'Red carp: upper half of the atlas (crop) as a 16x4 textured grid.',
    },
    {
      id: 'sheen',
      parent: `${RED.id}Warp`,
      shape: { type: 'polygon', points: sheenPoints(0.5), detail: 12 },
      fill: 'rgba(255,255,255,0.45)',
      blend: 'screen',
      z: 7,
      mask: [RED.id],
      description: 'Light sweep clipped by the red carp texture alpha (mask on an image part).',
    },
    {
      id: 'pinwheel',
      parent: 'pinwheelHub',
      shape: pinwheelMesh(POLE_X, 66, 28, 24),
      z: 9,
      description: 'Textured mesh: a 24-segment fan whose uvs map onto the round pinwheel texture.',
    },
    {
      id: 'pinwheelPin',
      shape: { type: 'ellipse', cx: POLE_X, cy: 66, rx: 3, ry: 3 },
      fill: '#5a3a1c',
      z: 10,
    },
  ];

  const bindings: Doc[] = [];
  for (const k of [RED, BLUE]) {
    const warp = `warp:${k.id}Warp.offsets`;
    bindings.push({ target: warp, params: ['Wind'], keys: [{ at: [0], value: droopOffsets(k) }, { at: [1], value: {} }] });
    for (const [param, component] of [['WaveSin', 'sin'], ['WaveCos', 'cos']] as const) {
      bindings.push({
        target: warp,
        params: [param, 'Wind'],
        keys: [
          { at: [-1, 0], value: {} },
          { at: [1, 0], value: {} },
          { at: [-1, 1], value: waveOffsets(k, component, -1) },
          { at: [1, 1], value: waveOffsets(k, component, 1) },
        ],
        description: `${component} component of the ${k.id} wave; the Wind axis fades the wave out when calm.`,
      });
    }
  }
  bindings.push(
    { target: 'bone:pinwheelHub.rotation', params: ['Spin'], keys: [{ at: [0], value: 0 }, { at: [4], value: 1440 }] },
    { target: 'bone:clouds.x', params: ['CloudDrift'], keys: [{ at: [-1], value: -60 }, { at: [1], value: 60 }] },
    { target: 'part:sheen.shape.points', params: ['Sheen'], keys: [{ at: [0], value: sheenPoints(0) }, { at: [1], value: sheenPoints(1) }] },
  );

  // Quarter-period keys (0, 1, 0, -1) with ease "smooth" approximate sin/cos: the curve keeps its
  // speed through the zero crossings and slows only at the peaks (inOutSine would stop at every key,
  // so the wave would pause four times per cycle).
  const waveTrack = (param: string, period: number, cycles: number, startPhase: number) => {
    const keys: Doc[] = [];
    const steps = cycles * 4;
    for (let i = 0; i <= steps; i++) {
      const v = [0, 1, 0, -1][(i + startPhase) % 4];
      keys.push(key((i * period) / 4, v, i < steps ? 'smooth' : undefined));
    }
    return { target: `param:${param}`, keys };
  };
  const animations = [
    {
      id: 'flutter',
      duration: 1.6,
      loop: true,
      description: 'Steady wind: waves run from mouth to tail, the pinwheel spins, a light sweep crosses the red carp.',
      tracks: [
        { target: 'param:Wind', keys: [key(0, 1)] },
        waveTrack('WaveSin', 1.6, 1, 0),
        waveTrack('WaveCos', 1.6, 1, 1),
        { target: 'param:Spin', keys: [key(0, 0, 'linear'), key(1.6, 1)] },
        { target: 'param:Sheen', keys: [key(0, 0, 'linear'), key(1.6, 1)] },
      ],
    },
    {
      id: 'gust',
      duration: 4.8,
      loop: false,
      description: 'Calm to windy: the streamers lift from hanging to flying as the pinwheel spins up; clouds drift.',
      tracks: [
        { target: 'param:Wind', keys: [key(0, 0, 'inOutCubic'), key(2, 1)] },
        waveTrack('WaveSin', 1.6, 3, 0),
        waveTrack('WaveCos', 1.6, 3, 1),
        { target: 'param:Spin', keys: [key(0, 0, 'inQuad'), key(4.8, 4)] },
        { target: 'param:CloudDrift', keys: [key(0, -1, 'inOutSine'), key(4.8, 1)] },
        { target: 'param:Sheen', keys: [key(0, 0), key(2.4, 0, 'inOutSine'), key(4.8, 1)] },
      ],
    },
  ];

  return {
    format: 'rev2d',
    version: 1,
    meta: {
      name: 'textured',
      width: W,
      height: H,
      background: '#9fd6f7',
      fps: 30,
      author: 'Rev2D examples',
      description:
        'Koinobori: atlas-cropped image grids bent by warps (droop + traveling wave), a textured pinwheel mesh with uvs, and a sheen masked by texture alpha.',
    },
    parameters,
    textures: [
      { id: 'koiAtlas', path: 'koi-atlas.png', width: 256, height: 192 },
      { id: 'pinwheel', path: 'pinwheel.png', width: 128, height: 128 },
    ],
    bones,
    warps,
    parts,
    bindings,
    animations,
  };
}

/**
 * Diagonal light band across the red carp at sweep position s (0..1). It spans exactly the height of
 * koiRedWarp's rect (y 92..204), so at the default Sheen it lies inside the warp (part-outside-warp).
 */
function sheenPoints(s: number): number[] {
  const x = RED.x - 60 + s * (RED.w + 120);
  const pts: Pt[] = [
    [x, RED.y - 8],
    [x + 26, RED.y - 8],
    [x + 6, RED.y + RED.h + 8],
    [x - 20, RED.y + RED.h + 8],
  ];
  return flat(pts);
}
