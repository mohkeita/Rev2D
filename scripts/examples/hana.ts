/**
 * "hana": Live2D-style anime bust. Vector only.
 *
 * Rig overview
 *   bones   root -> body -> neck -> head         (AngleZ rotates head, BodyAngleX leans body, Breath lifts neck)
 *   warps   bodyWarp (body)                      BodyAngleX turn + Breath
 *           faceWarp (head)                      AngleX x AngleY 3x3 head-turn keyforms (sphere-like parallax)
 *             eyeBallWarp (faceWarp)             EyeBallX / EyeBallY move irises and highlights
 *             frontHairWarp / sideHairWarpL/R    HairFront / HairSide sway (physics outputs)
 *           backHairWarp (head)                  HairBack sway + opposite parallax on AngleX / AngleY
 *   L / R suffixes follow Live2D: the character's left / right, i.e. L is on screen RIGHT.
 */
import { d, key, loopTrack, mirrorPath, movePath, polyPath, r, warpOffsets, type Doc, type Pt, type Rect } from './common.js';

const W = 512;
const H = 640;
const CX = W / 2;

const C = {
  skin: '#fde7dc',
  skinTop: '#f6cfbf',
  skinShade: '#f1c0ae',
  skinLine: '#c98a78',
  hair: '#5d3c58',
  hairDark: '#3f2640',
  hairLight: '#86607f',
  hairShine: '#b38bab',
  hairLine: '#2b1729',
  lash: '#2a1828',
  brow: '#4a2d46',
  irisTop: '#2a1f58',
  irisMid: '#4e3fa3',
  irisBottom: '#a898f4',
  pupil: '#1b1238',
  eyeWhite: '#ffffff',
  eyeShade: '#d8d0ec',
  mouth: '#8c2a3e',
  mouthLine: '#5e1a2a',
  tongue: '#e57b8c',
  blush: '#ff8595',
  blouse: '#ffffff',
  blouseShade: '#dfe3f0',
  blouseLine: '#8a90a8',
  collar: '#2d3f75',
  collarLine: '#1c2850',
  ribbon: '#e2485f',
  ribbonShade: '#b0304a',
};

// ---------------------------------------------------------------------------------------------- rig layout

/** Head-turn lattice: covers the face, bangs and side locks so every head child deforms inside it. */
const FACE_RECT: Rect = [110, 70, 292, 400];
const FACE_COLS = 8;
const FACE_ROWS = 8;
/** Center and radii of the pseudo-sphere used to compute head-turn parallax. */
const SPHERE = { cx: 256, cy: 245, rx: 108, ry: 150 };

/** Torso lattice: 5 rows of 73 px down to y = 725, below the blouse hem (the bust is cut off by the canvas at 640). */
const BODY_RECT: Rect = [60, 360, 392, 365];
const BODY_ROWS = 5;
const EYEBALL_RECT: Rect = [184, 236, 144, 52];
const FRONT_HAIR_RECT: Rect = [132, 84, 248, 180];
const SIDE_HAIR_RECT_R: Rect = [120, 180, 76, 280];
const SIDE_HAIR_RECT_L: Rect = [W - 120 - 76, 180, 76, 280];
const BACK_HAIR_RECT: Rect = [94, 80, 324, 420];

// ---------------------------------------------------------------------------------------------- eye geometry

/** Two-segment cubic curve: [start, c1, c2, mid, c3, c4, end]. */
type Curve2 = [Pt, Pt, Pt, Pt, Pt, Pt, Pt];

const reverse = (c: Curve2): Curve2 => [c[6], c[5], c[4], c[3], c[2], c[1], c[0]];
const p = (pt: Pt) => `${r(pt[0])} ${r(pt[1])}`;
const curveCmds = (c: Curve2) => `C ${p(c[1])} ${p(c[2])} ${p(c[3])} C ${p(c[4])} ${p(c[5])} ${p(c[6])}`;

/** Character-right eye (screen left). Open upper lid, open lower lid and the shared closed line. */
const EYE = {
  upperOpen: [[181, 267], [185, 248], [199, 238], [213, 238], [225, 238], [233, 248], [236, 264]] as Curve2,
  lowerOpen: [[236, 264], [231, 279], [221, 286], [209, 286], [197, 286], [186, 280], [181, 267]] as Curve2,
  closed: [[181, 267], [186, 276], [197, 280], [209, 280], [221, 280], [231, 276], [236, 264]] as Curve2,
};

/**
 * Lower lid of the closed eye: the closed line with its interior lifted 1.2 px, so the closed eye white
 * is a hairline sliver hidden under the lash band instead of a zero-area shape. (The eye white masks
 * the iris; a mask that keeps a little geometry never depends on how empty masks are treated.)
 */
const CLOSED_LOWER = reverse(EYE.closed.map(([x, y], i) => (i === 0 || i === 6 ? [x, y] : [x, y - 1.2])) as Curve2);

function eyeWhitePath(upper: Curve2, lower: Curve2): string {
  return `M ${p(upper[0])} ${curveCmds(upper)} ${curveCmds(lower)} Z`;
}

/** Point and unit tangent of a two-segment cubic at global parameter u in [0, 1]. */
function curveAt(c: Curve2, u: number): { pt: Pt; tan: Pt } {
  const seg = u < 0.5 ? 0 : 1;
  const t = u < 0.5 ? u * 2 : u * 2 - 1;
  const [p0, p1, p2, p3] = seg === 0 ? [c[0], c[1], c[2], c[3]] : [c[3], c[4], c[5], c[6]];
  const mt = 1 - t;
  const pt: Pt = [0, 1].map((k) => mt ** 3 * p0[k] + 3 * mt ** 2 * t * p1[k] + 3 * mt * t ** 2 * p2[k] + t ** 3 * p3[k]) as Pt;
  const dv = [0, 1].map((k) => 3 * mt ** 2 * (p1[k] - p0[k]) + 6 * mt * t * (p2[k] - p1[k]) + 3 * t ** 2 * (p3[k] - p2[k]));
  const len = Math.hypot(dv[0], dv[1]) || 1;
  return { pt, tan: [dv[0] / len, dv[1] / len] };
}

/** Smooth thickness profile through (u, value) stops (cosine interpolation). */
function profile(stops: Array<[number, number]>, u: number): number {
  for (let i = 1; i < stops.length; i++) {
    const [u0, v0] = stops[i - 1];
    const [u1, v1] = stops[i];
    if (u <= u1) return v0 + (v1 - v0) * (1 - Math.cos((Math.PI * (u - u0)) / (u1 - u0))) / 2;
  }
  return stops[stops.length - 1][1];
}

const LASH_SAMPLES = 16;

/**
 * Lash band on top of the upper lid, as a polygon: the lid itself (sampled) is the bottom edge, the
 * top edge is the lid offset upward along its normal by a tapered thickness, with a flick past the
 * outer corner. Open and closed bands have identical structure, so they morph point by point.
 */
function lashPath(lid: Curve2, open: boolean): string {
  const thickness: Array<[number, number]> = open
    ? [[0, 4.5], [0.3, 6.5], [0.75, 4], [1, 1]]
    : [[0, 2.5], [0.3, 3.2], [0.75, 2.6], [1, 1]];
  const bottom: Pt[] = [];
  const top: Pt[] = [];
  for (let i = 0; i <= LASH_SAMPLES; i++) {
    const u = i / LASH_SAMPLES;
    const { pt, tan } = curveAt(lid, u);
    const th = profile(thickness, u);
    bottom.push(pt);
    // Up normal: the lid runs from the outer to the inner corner (+x on screen), so up is (ty, -tx).
    top.push([pt[0] + tan[1] * th, pt[1] - tan[0] * th]);
  }
  const start = curveAt(lid, 0);
  const flick: Pt = open
    ? [start.pt[0] - start.tan[0] * 9 + start.tan[1] * 5, start.pt[1] - start.tan[1] * 9 - start.tan[0] * 5]
    : [start.pt[0] - start.tan[0] * 6 + start.tan[1] * 1, start.pt[1] - start.tan[1] * 6 - start.tan[0] * 1];
  return polyPath([...bottom.reverse(), flick, ...top]);
}

// ---------------------------------------------------------------------------------------------- curve helpers

/** Cubic segment from a to b with controls at 1/3 and 2/3 of the chord pushed k px to the right of travel. */
function bend(a: Pt, b: Pt, k: number): string {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const c1: Pt = [a[0] + dx / 3 + nx * k, a[1] + dy / 3 + ny * k];
  const c2: Pt = [a[0] + (2 * dx) / 3 + nx * k, a[1] + (2 * dy) / 3 + ny * k];
  return `C ${p(c1)} ${p(c2)} ${p(b)}`;
}

/** Bent cubic segments from `start` through each point (no leading M). */
function curveTo(start: Pt, segments: Array<[Pt, number]>): string {
  let prev = start;
  return segments
    .map(([pt, k]) => {
      const seg = bend(prev, pt, k);
      prev = pt;
      return seg;
    })
    .join(' ');
}

/** Path through points with bent cubic segments; closed with Z unless `close` is false. */
function chain(start: Pt, segments: Array<[Pt, number]>, close = true): string {
  return `M ${p(start)} ${curveTo(start, segments)}${close ? ' Z' : ''}`;
}

/**
 * Left-right symmetric closed outline: from `top` (on the axis) through the right-half points, straight
 * across the bottom, and back up through the mirrored points. Bends keep their meaning on both halves.
 */
function symmetric(top: Pt, right: Array<[Pt, number]>, axis = CX): string {
  const m = ([x, y]: Pt): Pt => [2 * axis - x, y];
  const left: Array<[Pt, number]> = [];
  for (let i = right.length - 1; i >= 0; i--) left.push([m(i > 0 ? right[i - 1][0] : top), right[i][1]]);
  const last = right[right.length - 1][0];
  return `M ${p(top)} ${curveTo(top, right)} L ${p(m(last))} ${curveTo(m(last), left)} Z`;
}

/** Lens (leaf) shape along a circular arc: from angle a0 to a1 (degrees, 0 = +x, clockwise), half-thickness th. */
function lens(c: Pt, radius: number, a0: number, a1: number, th: number): string {
  const at = (deg: number, rr: number): Pt => [c[0] + Math.cos((deg * Math.PI) / 180) * rr, c[1] + Math.sin((deg * Math.PI) / 180) * rr];
  const m1 = a0 + (a1 - a0) / 3;
  const m2 = a0 + ((a1 - a0) * 2) / 3;
  return `M ${p(at(a0, radius))} C ${p(at(m1, radius + th))} ${p(at(m2, radius + th))} ${p(at(a1, radius))} C ${p(at(m2, radius - th))} ${p(at(m1, radius - th))} ${p(at(a0, radius))} Z`;
}

// ---------------------------------------------------------------------------------------------- mouth

/** Mouth keyforms: corners + upper lip curve + lower lip curve (one cubic each, same structure). */
function mouthPath(l: Pt, rt: Pt, up1: Pt, up2: Pt, lo1: Pt, lo2: Pt): string {
  return `M ${p(l)} C ${p(up1)} ${p(up2)} ${p(rt)} C ${p(lo1)} ${p(lo2)} ${p(l)} Z`;
}

const MOUTH: Record<string, string> = {
  // MouthOpen = 0
  closedFrown: mouthPath([246, 325], [266, 325], [251, 320.5], [261, 320.5], [261, 322], [251, 322]),
  closedNeutral: mouthPath([244, 322], [268, 322], [250, 320.8], [262, 320.8], [262, 323], [250, 323]),
  closedSmile: mouthPath([242, 318], [270, 318], [249, 324], [263, 324], [263, 326], [249, 326]),
  // MouthOpen = 1
  openFrown: mouthPath([246, 326], [266, 326], [249, 315], [263, 315], [265, 341], [247, 341]),
  openNeutral: mouthPath([243, 321], [269, 321], [249, 318], [263, 318], [268, 342], [244, 342]),
  openSmile: mouthPath([240, 316], [272, 316], [248, 320], [264, 320], [268, 344], [244, 344]),
};

// ---------------------------------------------------------------------------------------------- head turn

/**
 * Head-turn displacement for AngleX = 30*s, AngleY = 30*t. Points are pushed by their depth on a
 * pseudo-sphere: the face center moves most, the silhouette least, so the far side compresses and the
 * near side widens (the Live2D "3D" look). A small perspective term shortens the far side vertically,
 * and combined yaw + pitch move a little less than the sum (a real sphere rotation does too).
 */
function headTurn(s: number, t: number) {
  return (x: number, y: number): Pt => {
    const u = (x - SPHERE.cx) / SPHERE.rx;
    const v = (y - SPHERE.cy) / SPHERE.ry;
    const depth = Math.sqrt(Math.max(0, 1 - u * u - v * v));
    const inFace = Math.min(1, Math.max(0, 1.6 - Math.hypot(u, v)));
    const dx = s * (30 * depth + 6) * (1 - 0.15 * Math.abs(t)) - t * u * v * 6 * inFace;
    const dy = -t * (18 * depth + 3) * (1 - 0.15 * Math.abs(s)) - s * u * v * 8 * inFace;
    return [dx, dy];
  };
}

// ---------------------------------------------------------------------------------------------- builder

export function buildHana(): Doc {
  const mirror = (path: string) => mirrorPath(path, CX);
  const mirrorPt = ([x, y]: Pt): Pt => [W - x, y];

  // ------------------------------------------------------------------ parameters
  const parameters = [
    { id: 'AngleX', min: -30, max: 30, default: 0, group: 'Face', description: 'Head turn: + looks toward screen right.' },
    { id: 'AngleY', min: -30, max: 30, default: 0, group: 'Face', description: 'Head pitch: + looks up.' },
    { id: 'AngleZ', min: -30, max: 30, default: 0, group: 'Face', description: 'Head tilt: + rotates clockwise (1/3 degree per unit).' },
    { id: 'EyeLOpen', min: 0, max: 1, default: 1, group: 'Eyes', description: "Character's left eye (screen right): 0 closed, 1 open." },
    { id: 'EyeROpen', min: 0, max: 1, default: 1, group: 'Eyes', description: "Character's right eye (screen left): 0 closed, 1 open." },
    { id: 'EyeBallX', min: -1, max: 1, default: 0, group: 'Eyes', description: 'Gaze: + looks toward screen right.' },
    { id: 'EyeBallY', min: -1, max: 1, default: 0, group: 'Eyes', description: 'Gaze: + looks up.' },
    { id: 'BrowLY', min: -1, max: 1, default: 0, group: 'Brows', description: 'Left brow (screen right): -1 lowered/angry, +1 raised.' },
    { id: 'BrowRY', min: -1, max: 1, default: 0, group: 'Brows', description: 'Right brow (screen left): -1 lowered/angry, +1 raised.' },
    { id: 'MouthOpen', min: 0, max: 1, default: 0, group: 'Mouth', description: '0 closed, 1 fully open.' },
    { id: 'MouthForm', min: -1, max: 1, default: 0, group: 'Mouth', description: '-1 frown / pout, 0 neutral, +1 smile.' },
    { id: 'Cheek', min: 0, max: 1, default: 0, group: 'Face', description: 'Blush strength.' },
    { id: 'BodyAngleX', min: -10, max: 10, default: 0, group: 'Body', description: 'Upper-body turn/lean: + toward screen right.' },
    { id: 'Breath', min: 0, max: 1, default: 0, group: 'Body', description: '0 exhaled, 1 inhaled (shoulders up, chest out).' },
    { id: 'HairFront', min: -1, max: 1, default: 0, group: 'Hair', description: 'Bangs sway. Physics output (hairFront).' },
    { id: 'HairSide', min: -1, max: 1, default: 0, group: 'Hair', description: 'Side locks sway. Physics output (hairSide).' },
    { id: 'HairBack', min: -1, max: 1, default: 0, group: 'Hair', description: 'Back hair sway. Physics output (hairBack).' },
  ];

  // ------------------------------------------------------------------ bones
  const bones = [
    { id: 'root', x: CX, y: H, length: 0, description: 'Bottom center of the canvas.' },
    { id: 'body', parent: 'root', x: 0, y: -40, rotation: -90, length: 220, description: 'Hips -> shoulders. Rotated -90 so the bone points up; BodyAngleX leans it.' },
    { id: 'neck', parent: 'body', x: 220, y: 0, length: 44, description: 'Shoulder line -> head pivot.' },
    { id: 'head', parent: 'neck', x: 44, y: 0, length: 220, description: 'Pivot under the chin; AngleZ rotates it.' },
  ];

  // ------------------------------------------------------------------ warps
  const warps = [
    { id: 'bodyWarp', parent: 'body', rect: BODY_RECT, cols: 4, rows: BODY_ROWS, description: 'Torso: BodyAngleX turn and Breath.' },
    { id: 'backHairWarp', parent: 'head', rect: BACK_HAIR_RECT, cols: 2, rows: 4, description: 'Back hair: HairBack sway, moves opposite to the face on head turns (parallax).' },
    { id: 'faceWarp', parent: 'head', rect: FACE_RECT, cols: FACE_COLS, rows: FACE_ROWS, description: 'Head turn: AngleX x AngleY keyform grid. Parent of all face parts and front hair.' },
    { id: 'eyeBallWarp', parent: 'faceWarp', rect: EYEBALL_RECT, cols: 6, rows: 1, description: 'Moves both irises with EyeBallX / EyeBallY.' },
    { id: 'frontHairWarp', parent: 'faceWarp', rect: FRONT_HAIR_RECT, cols: 3, rows: 2, description: 'Bangs: HairFront sway (bottom row swings most).' },
    { id: 'sideHairWarpR', parent: 'faceWarp', rect: SIDE_HAIR_RECT_R, cols: 1, rows: 3, description: 'Right side lock (screen left): HairSide sway.' },
    { id: 'sideHairWarpL', parent: 'faceWarp', rect: SIDE_HAIR_RECT_L, cols: 1, rows: 3, description: 'Left side lock (screen right): HairSide sway.' },
  ];

  // ------------------------------------------------------------------ parts
  const parts: Doc[] = [];
  const add = (part: Doc) => parts.push(part);

  // Back hair (behind everything).
  const backHair = symmetric([256, 104], [
    [[398, 232], -36],
    [[406, 330], -3],
    [[416, 398], -4],
    [[398, 420], -3],
  ]);
  add({
    id: 'hairBack',
    parent: 'backHairWarp',
    shape: { type: 'path', d: backHair, detail: 14 },
    fill: { type: 'linear', from: [0, 100], to: [0, 420], stops: [[0, C.hairLight], [0.35, C.hair], [1, C.hairDark]] },
    stroke: { color: C.hairLine, width: 1.5 },
    z: 0,
    description: 'Hair behind the head and shoulders.',
  });
  const backStrand = chain([150, 150], [[[126, 280], 6], [[122, 400], -4]], false) + ' ' + chain([176, 124], [[[144, 260], 8], [[140, 400], -2]], false);
  add({
    id: 'hairBackStrands',
    parent: 'backHairWarp',
    shape: { type: 'path', d: `${backStrand} ${mirror(backStrand)}`, detail: 14 },
    fill: 'transparent',
    stroke: { color: C.hairLine, width: 1.2 },
    opacity: 0.5,
    z: 1,
    mask: ['hairBack'],
    description: 'Strand lines on the back hair (stroke only), clipped to it.',
  });

  // Neck.
  const neck = d`M 234 296 L 278 296 L 280 362 C 281 374 290 382 302 386 L 210 386 C 222 382 231 374 232 362 Z`;
  add({
    id: 'neck',
    parent: 'neck',
    shape: { type: 'path', d: neck, detail: 12 },
    fill: { type: 'linear', from: [0, 300], to: [0, 386], stops: [[0, C.skinShade], [1, C.skin]] },
    stroke: { color: C.skinLine, width: 1.2 },
    z: 5,
  });
  add({
    id: 'neckShadow',
    parent: 'faceWarp',
    shape: { type: 'path', d: d`M 222 300 C 236 346 276 346 290 300 L 290 346 C 282 354 270 366 256 368 C 242 366 230 354 222 346 Z`, detail: 8 },
    fill: C.skinShade,
    opacity: 0.9,
    z: 6,
    mask: ['neck'],
    description: 'Shadow the chin casts on the neck; follows the head, clipped to the neck.',
  });

  // Body (blouse, sailor collar, ribbon).
  const blouse = d`M 214 374 C 196 386 150 390 118 406 C 94 418 82 446 78 482 L 68 720 L 444 720 L 434 482
    C 430 446 418 418 394 406 C 362 390 316 386 298 374 L 256 404 Z`;
  add({
    id: 'blouse',
    parent: 'bodyWarp',
    shape: { type: 'path', d: blouse, detail: 16 },
    fill: { type: 'linear', from: [0, 380], to: [0, 640], stops: [[0, C.blouse], [1, C.blouseShade]] },
    stroke: { color: C.blouseLine, width: 1.5 },
    z: 10,
  });
  add({
    id: 'blouseFolds',
    parent: 'bodyWarp',
    shape: { type: 'path', d: d`M 128 470 C 134 530 132 620 128 720 M 384 470 C 378 530 380 620 384 720`, detail: 16 },
    fill: 'transparent',
    stroke: { color: C.blouseShade, width: 3 },
    z: 11,
    description: 'Sleeve seams (open subpaths: stroke only).',
  });
  add({
    id: 'chest',
    parent: 'bodyWarp',
    shape: { type: 'path', d: d`M 214 374 L 256 452 L 298 374 Z`, detail: 12 },
    fill: { type: 'linear', from: [0, 374], to: [0, 452], stops: [[0, C.skin], [1, '#f8d8ca']] },
    z: 12,
    description: 'Skin inside the collar V.',
  });
  const collar = d`M 214 374 C 184 386 142 392 114 408 C 150 442 202 474 256 500 C 310 474 362 442 398 408
    C 370 392 328 386 298 374 L 256 450 Z`;
  add({
    id: 'collar',
    parent: 'bodyWarp',
    shape: { type: 'path', d: collar, detail: 12 },
    fill: C.collar,
    stroke: { color: C.collarLine, width: 1.5 },
    z: 13,
    description: 'Sailor collar.',
  });
  add({
    id: 'collarShadow',
    parent: 'bodyWarp',
    shape: { type: 'path', d: movePath(collar, 0, 6), detail: 12 },
    fill: C.blouseShade,
    z: 11,
    mask: ['blouse'],
    description: 'Soft shadow the collar casts on the blouse.',
  });
  add({
    id: 'collarStripe',
    parent: 'bodyWarp',
    shape: { type: 'path', d: d`M 128 412 C 160 440 206 466 256 490 C 306 466 352 440 384 412`, detail: 10 },
    fill: 'transparent',
    stroke: { color: '#ffffff', width: 2.5 },
    z: 14,
    mask: ['collar'],
  });
  const ribbonLoopR = d`M 252 462 C 238 446 216 446 216 460 C 216 474 236 478 252 468 Z`;
  add({
    id: 'ribbonTails',
    parent: 'bodyWarp',
    shape: { type: 'path', d: d`M 250 468 C 244 492 236 512 228 536 L 240 530 L 246 542 C 250 516 254 494 256 470 Z ${mirror(d`M 250 468 C 244 492 236 512 228 536 L 240 530 L 246 542 C 250 516 254 494 256 470 Z`)}`, detail: 8 },
    fill: C.ribbonShade,
    stroke: { color: '#7d1f33', width: 1 },
    z: 15,
  });
  add({
    id: 'ribbonLoops',
    parent: 'bodyWarp',
    shape: { type: 'path', d: `${ribbonLoopR} ${mirror(ribbonLoopR)}`, detail: 8 },
    fill: { type: 'linear', from: [0, 446], to: [0, 478], stops: [[0, C.ribbon], [1, C.ribbonShade]] },
    stroke: { color: '#7d1f33', width: 1 },
    z: 16,
  });
  add({
    id: 'ribbonKnot',
    parent: 'bodyWarp',
    shape: { type: 'rect', x: 248, y: 457, w: 16, h: 14, radius: 4 },
    fill: C.ribbon,
    stroke: { color: '#7d1f33', width: 1 },
    z: 17,
  });

  // Ears (behind the face).
  const earR = d`M 166 246 C 152 238 144 254 147 270 C 150 286 158 296 170 292 Z`;
  add({
    id: 'ears',
    parent: 'faceWarp',
    shape: { type: 'path', d: `${earR} ${mirror(earR)}`, detail: 8 },
    fill: C.skinShade,
    stroke: { color: C.skinLine, width: 1.2 },
    z: 20,
  });

  // Face.
  const face = d`M 256 116 C 320 116 354 160 353 222 C 352 262 346 292 326 318 C 306 340 280 352 256 352
    C 232 352 206 340 186 318 C 166 292 160 262 159 222 C 158 160 192 116 256 116 Z`;
  add({
    id: 'face',
    parent: 'faceWarp',
    shape: { type: 'path', d: face, detail: 12 },
    fill: { type: 'linear', from: [0, 170], to: [0, 352], stops: [[0, C.skinTop], [0.4, C.skin], [1, '#fcded1']] },
    stroke: { color: C.skinLine, width: 1.5 },
    z: 21,
  });

  // Blush.
  for (const [id, cx] of [['blushR', 198], ['blushL', W - 198]] as const) {
    add({
      id,
      parent: 'faceWarp',
      shape: { type: 'ellipse', cx, cy: 300, rx: 24, ry: 11, detail: 4 },
      fill: { type: 'radial', center: [cx, 300], radius: 24, stops: [[0, 'rgba(255,133,149,0.75)'], [1, 'rgba(255,133,149,0)']] },
      opacity: 0.3,
      z: 22,
    });
  }

  // Eyes.
  const eyes = [
    { side: 'R', m: (x: string) => x, mp: (x: Pt) => x },
    { side: 'L', m: mirror, mp: mirrorPt },
  ] as const;
  for (const { side, m, mp } of eyes) {
    const white = `eyeWhite${side}`;
    add({
      id: white,
      parent: 'faceWarp',
      shape: { type: 'path', d: m(eyeWhitePath(EYE.upperOpen, EYE.lowerOpen)), tolerance: 0.2, detail: 5 },
      fill: { type: 'linear', from: [0, 238], to: [0, 262], stops: [[0, C.eyeShade], [1, C.eyeWhite]] },
      z: 23,
      description: 'Eye white. Its shape morphs closed with the Eye*Open parameter and masks the iris.',
    });
    const [icx, icy] = mp([210, 263]);
    add({
      id: `iris${side}`,
      parent: 'eyeBallWarp',
      shape: { type: 'ellipse', cx: icx, cy: icy, rx: 16, ry: 21, detail: 4 },
      fill: { type: 'linear', from: [0, 243], to: [0, 284], stops: [[0, C.irisTop], [0.45, C.irisMid], [1, C.irisBottom]] },
      stroke: { color: '#211843', width: 1.2 },
      z: 24,
      mask: [white],
    });
    add({
      id: `irisGlow${side}`,
      parent: 'eyeBallWarp',
      shape: { type: 'ellipse', cx: icx, cy: icy + 11, rx: 10, ry: 6, detail: 3 },
      fill: { type: 'radial', center: [icx, icy + 13], radius: 11, stops: [[0, 'rgba(214,204,255,0.9)'], [1, 'rgba(214,204,255,0)']] },
      z: 25,
      mask: [white],
    });
    add({
      id: `pupil${side}`,
      parent: 'eyeBallWarp',
      shape: { type: 'ellipse', cx: icx, cy: icy + 1, rx: 6.5, ry: 9.5 },
      fill: C.pupil,
      z: 26,
      mask: [white],
    });
    const [hx, hy] = mp([203, 254]);
    const [sx, sy] = mp([217, 273]);
    add({
      id: `highlight${side}`,
      parent: 'eyeBallWarp',
      shape: { type: 'path', d: `${d`M ${hx - 5} ${hy} C ${hx - 5} ${hy - 8} ${hx + 5} ${hy - 8} ${hx + 5} ${hy} C ${hx + 5} ${hy + 8} ${hx - 5} ${hy + 8} ${hx - 5} ${hy} Z`} ${d`M ${sx - 2.4} ${sy} C ${sx - 2.4} ${sy - 3.2} ${sx + 2.4} ${sy - 3.2} ${sx + 2.4} ${sy} C ${sx + 2.4} ${sy + 3.2} ${sx - 2.4} ${sy + 3.2} ${sx - 2.4} ${sy} Z`}`, tolerance: 0.1 },
      fill: '#ffffff',
      z: 27,
      mask: [white],
      description: 'Catch lights (big + small).',
    });
    add({
      id: `lash${side}`,
      parent: 'faceWarp',
      shape: { type: 'path', d: m(lashPath(EYE.upperOpen, true)), detail: 4 },
      fill: C.lash,
      z: 28,
      description: 'Upper lid line; morphs into the closed-eye line.',
    });
    add({
      id: `lowerLid${side}`,
      parent: 'faceWarp',
      shape: { type: 'path', d: m(d`M 191 285 C 200 290 216 290 227 283 C 216 288 200 288 191 285 Z`) },
      fill: '#b8666f',
      opacity: 0.85,
      z: 28,
    });
  }

  // Brows (drawn above the bangs, anime style).
  const BROW = {
    neutral: d`M 184 230 C 192 222 208 218 229 221 C 231 222 231 224 229 225 C 210 223 194 226 185 232 Z`,
    raised: d`M 184 223 C 191 213 208 208 229 212 C 231 213 231 215 229 216 C 210 213 193 216 185 225 Z`,
    lowered: d`M 184 231 C 192 225 209 224 229 228 C 231 229 231 231 229 232 C 210 230 194 229 185 233 Z`,
  };
  add({ id: 'browR', parent: 'faceWarp', shape: { type: 'path', d: BROW.neutral }, fill: C.brow, z: 60 });
  add({ id: 'browL', parent: 'faceWarp', shape: { type: 'path', d: mirror(BROW.neutral) }, fill: C.brow, z: 60 });

  // Nose and mouth.
  add({
    id: 'nose',
    parent: 'faceWarp',
    shape: { type: 'path', d: d`M 257 293 C 258 297 260 300 261 302 C 259 304 255 304 253 303 C 256 302 257 299 257 293 Z` },
    fill: '#d99583',
    z: 29,
  });
  add({
    id: 'mouth',
    parent: 'faceWarp',
    shape: { type: 'path', d: MOUTH.closedNeutral, detail: 3 },
    fill: { type: 'linear', from: [0, 318], to: [0, 344], stops: [[0, C.mouthLine], [1, C.mouth]] },
    z: 30,
    description: 'Mouth interior; MouthOpen x MouthForm path keyforms.',
  });
  add({
    id: 'teeth',
    parent: 'faceWarp',
    shape: { type: 'rect', x: 244, y: 314, w: 24, h: 8.5, radius: 3 },
    fill: '#ffffff',
    opacity: 0,
    z: 31,
    mask: ['mouth'],
  });
  add({
    id: 'tongue',
    parent: 'faceWarp',
    shape: { type: 'ellipse', cx: 256, cy: 326, rx: 10, ry: 6, detail: 3 },
    fill: C.tongue,
    opacity: 0,
    z: 31,
    mask: ['mouth'],
  });

  // Side locks (in front of the face, behind the bangs): long outer strand + shorter inner strand tip.
  const sideR = chain([176, 186], [
    [[152, 300], -10],
    [[132, 452], 6],
    [[152, 418], 2],
    [[164, 438], -3],
    [[176, 330], 8],
    [[194, 206], 4],
  ]);
  const sideStrandR = chain([170, 230], [[[158, 330], -3], [[150, 408], 2]], false);
  for (const [side, warp, shape, strand] of [
    ['R', 'sideHairWarpR', sideR, sideStrandR],
    ['L', 'sideHairWarpL', mirror(sideR), mirror(sideStrandR)],
  ] as const) {
    add({
      id: `hairSide${side}`,
      parent: warp,
      shape: { type: 'path', d: shape, detail: 10 },
      fill: { type: 'linear', from: [0, 200], to: [0, 452], stops: [[0, C.hair], [1, C.hairDark]] },
      stroke: { color: C.hairLine, width: 1.5 },
      z: 45,
    });
    add({
      id: `hairSideStrand${side}`,
      parent: warp,
      shape: { type: 'path', d: strand, detail: 10 },
      fill: 'transparent',
      stroke: { color: C.hairLine, width: 1.2 },
      opacity: 0.6,
      z: 46,
      mask: [`hairSide${side}`],
      description: 'Strand line (open path: stroke only), clipped to the lock.',
    });
  }

  // Bangs: skull outline over the top, then the strand tips across the forehead (swept to screen left).
  const skull = 'M 148 256 C 132 166 176 86 256 86 C 336 86 380 166 364 256';
  const bangs = `${skull} ${curveTo([364, 256], [
    [[350, 210], -4],
    [[338, 250], 5],
    [[324, 196], -5],
    [[300, 238], 7],
    [[290, 184], -5],
    [[266, 240], 8],
    [[252, 192], -5],
    [[230, 236], 7],
    [[218, 194], -5],
    [[194, 240], 7],
    [[184, 204], -4],
    // The last strand ends where the skull outline starts, so the outer bang is pointed like its mirror.
    [[148, 256], 6],
  ])} Z`;
  add({
    id: 'hairFront',
    parent: 'frontHairWarp',
    shape: { type: 'path', d: bangs, detail: 10 },
    fill: { type: 'linear', from: [0, 92], to: [0, 250], stops: [[0, C.hairLight], [0.45, C.hair], [1, C.hairDark]] },
    stroke: { color: C.hairLine, width: 1.5 },
    z: 50,
  });
  const strandLines = [
    chain([300, 110], [[[324, 196], 6]], false),
    chain([278, 104], [[[290, 184], 4]], false),
    chain([244, 104], [[[252, 192], -2]], false),
    chain([214, 112], [[[218, 194], -4]], false),
    chain([190, 128], [[[184, 204], -6]], false),
  ].join(' ');
  add({
    id: 'hairFrontStrands',
    parent: 'frontHairWarp',
    shape: { type: 'path', d: strandLines, detail: 10 },
    fill: 'transparent',
    stroke: { color: C.hairLine, width: 1.2 },
    opacity: 0.55,
    z: 51,
    mask: ['hairFront'],
    description: 'Strand separation lines (open paths: stroke only), clipped to the bangs.',
  });
  const shine = [
    [-158, -140],
    [-137, -119],
    [-116, -98],
    [-95, -77],
    [-74, -56],
    [-53, -35],
  ]
    .map(([a0, a1]) => lens([256, 268], 132, a0, a1, 5))
    .join(' ');
  add({
    id: 'hairFrontShine',
    parent: 'frontHairWarp',
    shape: { type: 'path', d: shine, tolerance: 0.2 },
    fill: C.hairShine,
    opacity: 0.85,
    z: 52,
    mask: ['hairFront'],
    description: 'Angel-ring highlight: lens shapes along an arc, clipped to the bangs.',
  });
  add({
    id: 'foreheadShadow',
    parent: 'frontHairWarp',
    shape: { type: 'path', d: movePath(bangs, 0, 7), detail: 10 },
    fill: C.skinShade,
    z: 22,
    mask: ['face'],
    description: 'Shadow of the bangs on the forehead (the bangs outline shifted down, clipped to the face).',
  });

  // Flower hairpin.
  const fc: Pt = [334, 168];
  const petals = [0, 72, 144, 216, 288]
    .map((a) => {
      const rad = ((a - 90) * Math.PI) / 180;
      const px = fc[0] + Math.cos(rad) * 10;
      const py = fc[1] + Math.sin(rad) * 10;
      const tx = Math.cos(rad);
      const ty = Math.sin(rad);
      // Teardrop petal from the center outward.
      const nx = -ty;
      const ny = tx;
      const tip: Pt = [px + tx * 8, py + ty * 8];
      return d`M ${fc[0] + tx * 2} ${fc[1] + ty * 2} C ${fc[0] + tx * 4 + nx * 10} ${fc[1] + ty * 4 + ny * 10} ${tip[0] + nx * 6} ${tip[1] + ny * 6} ${tip[0]} ${tip[1]}
        C ${tip[0] - nx * 6} ${tip[1] - ny * 6} ${fc[0] + tx * 4 - nx * 10} ${fc[1] + ty * 4 - ny * 10} ${fc[0] + tx * 2} ${fc[1] + ty * 2} Z`;
    })
    .join(' ');
  add({
    id: 'flowerPetals',
    parent: 'frontHairWarp',
    shape: { type: 'path', d: petals },
    fill: { type: 'radial', center: fc, radius: 20, stops: [[0, '#ffd9e3'], [1, '#ff9cb6']] },
    stroke: { color: '#d9607f', width: 1.2 },
    z: 55,
  });
  add({
    id: 'flowerCenter',
    parent: 'frontHairWarp',
    shape: { type: 'ellipse', cx: fc[0], cy: fc[1], rx: 4, ry: 4 },
    fill: '#ffd35c',
    stroke: { color: '#d99a2b', width: 1 },
    z: 56,
  });

  // ------------------------------------------------------------------ bindings
  const bindings: Doc[] = [];
  const bind = (b: Doc) => bindings.push(b);

  // Head turn: 3x3 grid over AngleX x AngleY.
  const turnKeys: Doc[] = [];
  for (const ay of [-30, 0, 30]) {
    for (const ax of [-30, 0, 30]) {
      turnKeys.push({
        at: [ax, ay],
        value: ax === 0 && ay === 0 ? {} : warpOffsets(FACE_RECT, FACE_COLS, FACE_ROWS, headTurn(ax / 30, ay / 30), { form: 'full' }),
      });
    }
  }
  bind({
    id: 'headTurn',
    target: 'warp:faceWarp.offsets',
    params: ['AngleX', 'AngleY'],
    keys: turnKeys,
    description: 'Pseudo-3D head turn: the face center shifts most, the silhouette least (far side compresses).',
  });
  bind({ id: 'headTilt', target: 'bone:head.rotation', params: ['AngleZ'], keys: [{ at: [-30], value: -10 }, { at: [30], value: 10 }] });
  bind({ id: 'neckTilt', target: 'bone:neck.rotation', params: ['AngleZ'], keys: [{ at: [-30], value: -3 }, { at: [30], value: 3 }] });

  // Back hair parallax (opposite to the face) and sway.
  bind({
    id: 'backHairTurn',
    target: 'warp:backHairWarp.offsets',
    params: ['AngleX'],
    keys: [
      { at: [-30], value: warpOffsets(BACK_HAIR_RECT, 2, 4, () => [7, 0], { form: 'full' }) },
      { at: [0], value: {} },
      { at: [30], value: warpOffsets(BACK_HAIR_RECT, 2, 4, () => [-7, 0], { form: 'full' }) },
    ],
  });
  bind({
    id: 'backHairPitch',
    target: 'warp:backHairWarp.offsets',
    params: ['AngleY'],
    keys: [
      { at: [-30], value: warpOffsets(BACK_HAIR_RECT, 2, 4, () => [0, -4], { form: 'full' }) },
      { at: [0], value: {} },
      { at: [30], value: warpOffsets(BACK_HAIR_RECT, 2, 4, () => [0, 4], { form: 'full' }) },
    ],
  });
  const sway = (rect: Rect, cols: number, rows: number, amp: number[], dir: number) =>
    warpOffsets(rect, cols, rows, (_x, _y, _c, row) => [dir * amp[row], Math.abs(amp[row]) * 0.08]);
  bind({
    id: 'backHairSway',
    target: 'warp:backHairWarp.offsets',
    params: ['HairBack'],
    keys: [
      { at: [-1], value: sway(BACK_HAIR_RECT, 2, 4, [0, 3, 8, 14, 20], 1) },
      { at: [0], value: {} },
      { at: [1], value: sway(BACK_HAIR_RECT, 2, 4, [0, 3, 8, 14, 20], -1) },
    ],
  });
  bind({
    id: 'frontHairSway',
    target: 'warp:frontHairWarp.offsets',
    params: ['HairFront'],
    keys: [
      { at: [-1], value: sway(FRONT_HAIR_RECT, 3, 2, [0, 3, 9], 1) },
      { at: [0], value: {} },
      { at: [1], value: sway(FRONT_HAIR_RECT, 3, 2, [0, 3, 9], -1) },
    ],
  });
  for (const [warp, rect] of [['sideHairWarpR', SIDE_HAIR_RECT_R], ['sideHairWarpL', SIDE_HAIR_RECT_L]] as const) {
    bind({
      target: `warp:${warp}.offsets`,
      params: ['HairSide'],
      keys: [
        { at: [-1], value: sway(rect, 1, 3, [0, 5, 12, 22], 1) },
        { at: [0], value: {} },
        { at: [1], value: sway(rect, 1, 3, [0, 5, 12, 22], -1) },
      ],
    });
  }

  // Gaze.
  bind({
    target: 'warp:eyeBallWarp.offsets',
    params: ['EyeBallX'],
    keys: [
      { at: [-1], value: warpOffsets(EYEBALL_RECT, 6, 1, () => [-6, 0], { form: 'full' }) },
      { at: [0], value: {} },
      { at: [1], value: warpOffsets(EYEBALL_RECT, 6, 1, () => [6, 0], { form: 'full' }) },
    ],
  });
  bind({
    target: 'warp:eyeBallWarp.offsets',
    params: ['EyeBallY'],
    keys: [
      { at: [-1], value: warpOffsets(EYEBALL_RECT, 6, 1, () => [0, 4], { form: 'full' }) },
      { at: [0], value: {} },
      { at: [1], value: warpOffsets(EYEBALL_RECT, 6, 1, () => [0, -4], { form: 'full' }) },
    ],
  });

  // Eyelids.
  for (const { side, m } of eyes) {
    const param = `Eye${side === 'L' ? 'L' : 'R'}Open`;
    bind({
      target: `part:eyeWhite${side}.shape.d`,
      params: [param],
      keys: [
        { at: [0], value: m(eyeWhitePath(EYE.closed, CLOSED_LOWER)) },
        { at: [1], value: m(eyeWhitePath(EYE.upperOpen, EYE.lowerOpen)) },
      ],
      description: 'Closed keyform: the lids meet; the eye white shrinks to a sliver under the lash, hiding everything it masks.',
    });
    bind({
      target: `part:lash${side}.shape.d`,
      params: [param],
      keys: [
        { at: [0], value: m(lashPath(EYE.closed, false)) },
        { at: [1], value: m(lashPath(EYE.upperOpen, true)) },
      ],
    });
    bind({ target: `part:lowerLid${side}.opacity`, params: [param], keys: [{ at: [0], value: 0 }, { at: [1], value: 0.85 }] });
  }

  // Brows.
  for (const [id, param, m] of [['browR', 'BrowRY', (x: string) => x], ['browL', 'BrowLY', mirror]] as const) {
    bind({
      target: `part:${id}.shape.d`,
      params: [param],
      keys: [
        { at: [-1], value: m(BROW.lowered) },
        { at: [0], value: m(BROW.neutral) },
        { at: [1], value: m(BROW.raised) },
      ],
    });
  }

  // Mouth.
  bind({
    id: 'mouthShape',
    target: 'part:mouth.shape.d',
    params: ['MouthOpen', 'MouthForm'],
    keys: [
      { at: [0, -1], value: MOUTH.closedFrown },
      { at: [1, -1], value: MOUTH.openFrown },
      { at: [0, 0], value: MOUTH.closedNeutral },
      { at: [1, 0], value: MOUTH.openNeutral },
      { at: [0, 1], value: MOUTH.closedSmile },
      { at: [1, 1], value: MOUTH.openSmile },
    ],
    description: '2D path keyforms: every keyform uses the same commands (M C C Z), so numbers interpolate.',
  });
  bind({ target: 'part:teeth.opacity', params: ['MouthOpen'], keys: [{ at: [0.1], value: 0 }, { at: [0.35], value: 1 }] });
  bind({ target: 'part:tongue.opacity', params: ['MouthOpen'], keys: [{ at: [0.1], value: 0 }, { at: [0.4], value: 1 }] });
  bind({ target: 'part:tongue.shape.cy', params: ['MouthOpen'], keys: [{ at: [0], value: 326 }, { at: [1], value: 338 }] });

  // Blush.
  for (const id of ['blushR', 'blushL']) {
    bind({ target: `part:${id}.opacity`, params: ['Cheek'], keys: [{ at: [0], value: 0.3 }, { at: [1], value: 1 }] });
  }

  // Body.
  const bodyTurn = (s: number) =>
    warpOffsets(BODY_RECT, 4, BODY_ROWS, (x, y) => {
      const u = (x - CX) / 180;
      const depth = Math.sqrt(Math.max(0, 1 - u * u));
      // The turn fades from the shoulders (y 360) to the canvas bottom (y 640), then stays at 0.4.
      const fade = Math.max(0, 1 - (y - BODY_RECT[1]) / (H - BODY_RECT[1])) * 0.6 + 0.4;
      return [s * (10 * depth + 3) * fade, 0];
    }, { form: 'full' });
  bind({
    id: 'bodyTurn',
    target: 'warp:bodyWarp.offsets',
    params: ['BodyAngleX'],
    keys: [
      { at: [-10], value: bodyTurn(-1) },
      { at: [0], value: {} },
      { at: [10], value: bodyTurn(1) },
    ],
  });
  bind({ id: 'bodyLean', target: 'bone:body.rotation', params: ['BodyAngleX'], keys: [{ at: [-10], value: -92.5 }, { at: [10], value: -87.5 }] });
  bind({
    id: 'breathChest',
    target: 'warp:bodyWarp.offsets',
    params: ['Breath'],
    keys: [
      { at: [0], value: {} },
      {
        at: [1],
        value: warpOffsets(BODY_RECT, 4, BODY_ROWS, (x, _y, _c, row) => [((x - CX) / 196) * [3, 2, 1, 0, 0, 0][row], -[3.5, 2.5, 1.2, 0, 0, 0][row]]),
      },
    ],
  });
  bind({ id: 'breathNeck', target: 'bone:neck.x', params: ['Breath'], keys: [{ at: [0], value: 220 }, { at: [1], value: 222.5 }] });

  // ------------------------------------------------------------------ physics
  const physics = [
    {
      id: 'hairFront',
      inputs: [
        { param: 'AngleX', type: 'x', weight: 0.6 },
        { param: 'AngleZ', type: 'angle', weight: 0.33 },
        { param: 'BodyAngleX', type: 'x', weight: 1.5 },
      ],
      outputs: [{ param: 'HairFront', type: 'angle', scale: 0.08 }],
      segments: [{ length: 22, mass: 1 }],
      damping: 0.08,
      stiffness: 40,
      description: 'Short, springy pendulum for the bangs.',
    },
    {
      id: 'hairSide',
      inputs: [
        { param: 'AngleX', type: 'x', weight: 0.8 },
        { param: 'AngleZ', type: 'angle', weight: 0.33 },
        { param: 'BodyAngleX', type: 'x', weight: 2 },
      ],
      outputs: [{ param: 'HairSide', type: 'angle', scale: 0.06 }],
      segments: [{ length: 40, mass: 1 }, { length: 40, mass: 1 }],
      damping: 0.06,
      stiffness: 12,
      description: 'Two-segment chain for the side locks (output: last segment).',
    },
    {
      id: 'hairBack',
      inputs: [
        { param: 'AngleX', type: 'x', weight: 0.8 },
        { param: 'AngleZ', type: 'angle', weight: 0.33 },
        { param: 'BodyAngleX', type: 'x', weight: 2 },
      ],
      outputs: [{ param: 'HairBack', type: 'angle', scale: 0.05 }],
      segments: [{ length: 60, mass: 1 }, { length: 60, mass: 1.5 }],
      damping: 0.05,
      stiffness: 6,
      description: 'Long, slow chain for the back hair.',
    },
  ];

  // ------------------------------------------------------------------ animations
  const blinkKeys = (t0: number) => [key(t0, 1, 'inQuad'), key(t0 + 0.08, 0), key(t0 + 0.14, 0, 'outQuad'), key(t0 + 0.32, 1)];
  /** Talk cycle (s): divides the idle (4 s) and look_around (6 s) loops, so they close when layered. */
  const TALK = 2;
  /** A held expression: ease from `rest` to `v` by t1, hold until t2, back to `rest` at t3 (zero velocity at both ends). */
  const hold = (v: number, t1: number, t2: number, t3: number, rest = 0) => [
    key(0, rest, 'inOutSine'),
    key(t1, v, 'inOutSine'),
    key(t2, v, 'inOutSine'),
    key(t3, rest),
  ];
  const animations = [
    {
      id: 'idle',
      duration: 4,
      loop: true,
      description:
        'Breathing with a gentle body/head sway and one blink per loop; loops seamlessly. The sways use ease "smooth" (Catmull-Rom through the keys, closed over the loop), so they flow through every key instead of stopping at it.',
      tracks: [
        loopTrack('param:Breath', 4, [0, 1], 'smooth'),
        loopTrack('param:BodyAngleX', 4, [0, 2.5, 0, -2.5], 'smooth'),
        loopTrack('param:AngleX', 4, [2, 5, 2, -2], 'smooth'),
        loopTrack('param:AngleY', 4, [0, 3, 0, 3], 'smooth'),
        loopTrack('param:AngleZ', 4, [-2, 3, 5, 0], 'smooth'),
        loopTrack('param:EyeBallX', 4, [0, 0.15, 0, -0.15], 'smooth'),
        { target: 'param:EyeLOpen', keys: [key(0, 1), ...blinkKeys(2.6), key(4, 1)] },
        { target: 'param:EyeROpen', keys: [key(0, 1), ...blinkKeys(2.6), key(4, 1)] },
      ],
    },
    {
      id: 'blink',
      duration: 0.5,
      loop: false,
      description:
        'One blink (one-shot, starts at t=0): lids meet at t=0.08s, reopen by 0.32s. Starts and ends open (the default), so it layers with once: idle + "blink,once,start=1.5" adds a blink and hands the eyes back.',
      tracks: [
        { target: 'param:EyeLOpen', keys: blinkKeys(0) },
        { target: 'param:EyeROpen', keys: blinkKeys(0) },
      ],
    },
    {
      id: 'wink',
      duration: 1,
      loop: false,
      description:
        'One-shot wink designed for layering with once: the left eye (screen right) shuts, the other squints, a smile and blush come and go. Every track starts and ends at its parameter default, so idle + "wink,once,start=1" hands the face back seamlessly (over a talk layer, which also drives the mouth, use "wink,add,once,start=1").',
      tracks: [
        { target: 'param:EyeLOpen', keys: [key(0, 1, 'inQuad'), key(0.1, 0), key(0.5, 0, 'outQuad'), key(0.72, 1)] },
        { target: 'param:EyeROpen', keys: hold(0.75, 0.2, 0.55, 0.9, 1) },
        { target: 'param:BrowLY', keys: hold(-0.5, 0.15, 0.55, 0.85) },
        { target: 'param:BrowRY', keys: hold(0.4, 0.2, 0.6, 0.95) },
        { target: 'param:MouthForm', keys: hold(1, 0.2, 0.6, 1) },
        { target: 'param:Cheek', keys: hold(0.6, 0.25, 0.6, 1) },
      ],
    },
    {
      id: 'talk',
      duration: TALK,
      loop: true,
      description:
        'Cheerful talking designed for mode "add": mouth flaps with a smile, small nods and raised brows, every head track centered on the parameter default (0), so look_around + "talk,add" keeps the head motion and adds the nods. 2 s divides the 4 s idle and the 6 s look_around, so layered loops close.',
      tracks: [
        {
          target: 'param:MouthOpen',
          keys: [0, 0.8, 0.25, 1, 0.1, 0.7, 0.2, 0.9, 0.3, 0.6, 0, 0.75, 0.1, 0.5, 0, 0].map((v, i, a) =>
            key((i * TALK) / (a.length - 1), v, i === a.length - 1 ? undefined : 'inOutSine'),
          ),
        },
        loopTrack('param:MouthForm', TALK, [0.5, 0.8, 0.4, 0.7], 'smooth'),
        loopTrack('param:AngleY', TALK, [0, -4, 2, -3], 'smooth'),
        loopTrack('param:AngleX', TALK, [0, 3, 0, -3], 'smooth'),
        loopTrack('param:AngleZ', TALK, [0, 2, 0, -2], 'smooth'),
        loopTrack('param:BrowLY', TALK, [0.2, 0.5, 0.2, 0.4], 'smooth'),
        loopTrack('param:BrowRY', TALK, [0.2, 0.5, 0.2, 0.4], 'smooth'),
        loopTrack('param:Cheek', TALK, [0.3, 0.45], 'smooth'),
      ],
    },
    {
      id: 'nod',
      duration: 1.2,
      loop: false,
      description: 'A friendly nod: head dips, rebounds, settles; eyes squint and she smiles.',
      tracks: [
        { target: 'param:AngleY', keys: [key(0, 0, 'outQuad'), key(0.3, -20, 'inOutSine'), key(0.6, 5, 'inOutSine'), key(0.85, -6, 'inOutSine'), key(1.2, 0)] },
        { target: 'param:AngleZ', keys: [key(0, 0, 'inOutSine'), key(0.4, 4, 'inOutSine'), key(1.2, 0)] },
        { target: 'param:EyeLOpen', keys: [key(0, 1, 'inOutSine'), key(0.3, 0.55, 'inOutSine'), key(0.8, 0.9, 'inOutSine'), key(1.2, 1)] },
        { target: 'param:EyeROpen', keys: [key(0, 1, 'inOutSine'), key(0.3, 0.55, 'inOutSine'), key(0.8, 0.9, 'inOutSine'), key(1.2, 1)] },
        { target: 'param:MouthForm', keys: [key(0, 0, 'outQuad'), key(0.3, 1, 'inOutSine'), key(1.2, 0.6)] },
        { target: 'param:Cheek', keys: [key(0, 0, 'outQuad'), key(0.4, 0.7, 'inOutSine'), key(1.2, 0.4)] },
      ],
    },
    {
      id: 'look_around',
      duration: 6,
      loop: true,
      description: 'Eyes lead, head follows: looks left, right and back; blinks while turning. Hair physics swings.',
      tracks: [
        { target: 'param:EyeBallX', keys: [key(0, 0, 'outQuad'), key(0.3, -0.9, 'inOutSine'), key(1.6, -0.6, 'outQuad'), key(2.3, 0.9, 'inOutSine'), key(3.8, 0.6, 'inOutSine'), key(4.6, 0, 'inOutSine'), key(6, 0)] },
        { target: 'param:AngleX', keys: [key(0, 0, 'inOutSine'), key(0.9, -26, 'inOutSine'), key(1.8, -22, 'inOutSine'), key(3, 26, 'inOutSine'), key(4, 22, 'inOutSine'), key(5.2, 0, 'inOutSine'), key(6, 0)] },
        { target: 'param:AngleY', keys: [key(0, 0, 'inOutSine'), key(0.9, 6, 'inOutSine'), key(2.2, -4, 'inOutSine'), key(3.2, 10, 'inOutSine'), key(5.2, 0, 'inOutSine'), key(6, 0)] },
        { target: 'param:EyeBallY', keys: [key(0, 0, 'inOutSine'), key(0.9, 0.3, 'inOutSine'), key(3.2, 0.5, 'inOutSine'), key(5.2, 0, 'inOutSine'), key(6, 0)] },
        { target: 'param:BodyAngleX', keys: [key(0, 0, 'inOutSine'), key(1.2, -4, 'inOutSine'), key(3.3, 4, 'inOutSine'), key(5.4, 0, 'inOutSine'), key(6, 0)] },
        { target: 'param:EyeLOpen', keys: [key(0, 1), ...blinkKeys(2.0), key(6, 1)] },
        { target: 'param:EyeROpen', keys: [key(0, 1), ...blinkKeys(2.0), key(6, 1)] },
      ],
    },
  ];

  return {
    format: 'rev2d',
    version: 1,
    meta: {
      name: 'hana',
      width: W,
      height: H,
      background: '#efe7f1',
      fps: 30,
      author: 'Rev2D examples',
      description:
        'Live2D-style anime bust (vector only). Head turn via a 3x3 AngleX x AngleY warp keyform grid, eye/mouth path morphs, iris masks, hair physics. L/R suffixes = character left/right (L is on screen right).',
    },
    parameters,
    bones,
    warps,
    parts,
    bindings,
    physics,
    animations,
  };
}

