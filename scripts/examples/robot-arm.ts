/**
 * "robot-arm": Spine-style skeletal rig. Bones point along their local +x axis; rigid plates are
 * parented to bones; a rubber boot over the elbow and a hanging cable are skinned meshes with auto
 * weights; two-bone IK drives the arm toward a target bone that parameters move; a physics chain
 * swings the cable.
 *
 * Geometry is authored in setup space by mapping bone-local rectangles through the setup pose, so
 * every plate sits exactly on its bone.
 */
import { apply, type Mat2D } from '../../src/core/index.js';
import { boneWorlds, boneRectPath, d, flat, key, polyPath, r, toSetup, type BoneSpec, type Doc, type Pt } from './common.js';

const W = 640;
const H = 480;
const FLOOR = 420;
const SHOULDER: Pt = [180, 314];
/** armIk softness in px (about 10% of the 285 px reach). */
const IK_SOFTNESS = 30;

const C = {
  plate: '#f39a2e',
  plateLight: '#ffc063',
  plateDark: '#c96a14',
  metal: '#3c4556',
  metalLight: '#6b7890',
  metalDark: '#232935',
  line: '#141821',
  rubber: '#2a2e38',
  rib: '#14171d',
  glow: '#5ef2ff',
};

/** Circle as a closed cubic path (for multi-circle parts like bolts). */
function circle(cx: number, cy: number, rad: number): string {
  const k = rad * 0.5523;
  return d`M ${cx + rad} ${cy} C ${cx + rad} ${cy + k} ${cx + k} ${cy + rad} ${cx} ${cy + rad} C ${cx - k} ${cy + rad} ${cx - rad} ${cy + k} ${cx - rad} ${cy}
    C ${cx - rad} ${cy - k} ${cx - k} ${cy - rad} ${cx} ${cy - rad} C ${cx + k} ${cy - rad} ${cx + rad} ${cy - k} ${cx + rad} ${cy} Z`;
}

/** Tapered claw along a bone: from x0 (half-height h) to a point at x1, bone-local, mapped to setup space. */
function clawPath(m: Mat2D, x0: number, x1: number, h: number, hook: number): string {
  return polyPath(toSetup(m, [[x0, -h], [x1 - 6, -h * 0.7], [x1, hook], [x1 - 7, h * 0.9], [x0, h]]));
}

export function buildRobotArm(): Doc {
  // ------------------------------------------------------------------ skeleton (setup pose)
  const bones: BoneSpec[] = [
    { id: 'root', x: 180, y: FLOOR, length: 0 },
    { id: 'turret', parent: 'root', x: 0, y: SHOULDER[1] - FLOOR, length: 0 },
    { id: 'upperArm', parent: 'turret', rotation: -60, length: 150 },
    { id: 'foreArm', parent: 'upperArm', x: 150, rotation: 95, length: 135 },
    { id: 'hand', parent: 'foreArm', x: 135, rotation: -35, length: 34 },
    { id: 'fingerTop1', parent: 'hand', x: 30, y: -9, rotation: -25, length: 20 },
    { id: 'fingerTop2', parent: 'fingerTop1', x: 20, rotation: 35, length: 16 },
    { id: 'fingerMid1', parent: 'hand', x: 33, y: 0, rotation: 0, length: 20 },
    { id: 'fingerMid2', parent: 'fingerMid1', x: 20, rotation: 12, length: 15 },
    { id: 'fingerBot1', parent: 'hand', x: 30, y: 9, rotation: 25, length: 20 },
    { id: 'fingerBot2', parent: 'fingerBot1', x: 20, rotation: -35, length: 16 },
    { id: 'cable1', parent: 'turret', x: -44, y: 22, rotation: 90, length: 24 },
    { id: 'cable2', parent: 'cable1', x: 24, length: 24 },
    { id: 'cable3', parent: 'cable2', x: 24, length: 24 },
  ];
  const world = boneWorlds(bones);
  // The IK target starts exactly at the setup wrist, so the default pose equals the authored pose.
  const wrist = apply(world.foreArm, 135, 0);
  bones.push({ id: 'ikTarget', parent: 'root', x: r(wrist[0] - 180), y: r(wrist[1] - FLOOR), length: 0 });
  const descriptions: Record<string, string> = {
    root: 'Floor contact under the pedestal.',
    turret: 'Shoulder mount on top of the pedestal.',
    upperArm: 'Solved by IK (armIk).',
    foreArm: 'Solved by IK (armIk); its tip is the wrist.',
    hand: 'Follows the forearm; Wrist adds rotation.',
    cable1: 'Cable chain root; rotations come from physics outputs Cable1..3.',
    ikTarget: 'Where the wrist reaches. ReachX / ReachY move it.',
  };
  const boneDocs = bones.map((b) => ({ ...b, ...(descriptions[b.id] ? { description: descriptions[b.id] } : {}) }));

  // ------------------------------------------------------------------ parameters
  const parameters = [
    {
      id: 'ReachX',
      min: -1,
      max: 1,
      default: 0,
      group: 'Arm',
      description: 'IK target: -1 = 110 px left, +1 = 120 px right. Near the corners (ReachX 1 with ReachY -1 or 1) the target is beyond reach: the arm points at it.',
    },
    { id: 'ReachY', min: -1, max: 1, default: 0, group: 'Arm', description: 'IK target: -1 = 80 px down, +1 = 150 px up.' },
    { id: 'Wrist', min: -1, max: 1, default: 0, group: 'Arm', description: 'Hand rotation: +-40 degrees (+ = clockwise).' },
    { id: 'Grip', min: 0, max: 1, default: 0, group: 'Hand', description: '0 claws open, 1 closed.' },
    ...(['Top', 'Mid', 'Bot'] as const).map((c) => ({
      id: `Tap${c}`,
      min: 0,
      max: 1,
      default: 0,
      group: 'Hand',
      description: `Lifts the ${c === 'Top' ? 'top' : c === 'Mid' ? 'middle' : 'bottom'} claw (1 = raised); adds to Grip. Animation "drum" taps the claws in turn.`,
    })),
    { id: 'Cable1', min: -60, max: 60, default: 0, group: 'Physics', description: 'Cable segment 1 swing in degrees (physics output).' },
    { id: 'Cable2', min: -60, max: 60, default: 0, group: 'Physics', description: 'Cable segment 2 swing in degrees (physics output).' },
    { id: 'Cable3', min: -60, max: 60, default: 0, group: 'Physics', description: 'Cable segment 3 swing in degrees (physics output).' },
  ];

  // ------------------------------------------------------------------ parts
  const parts: Doc[] = [];
  const add = (p: Doc) => parts.push(p);

  add({
    id: 'floor',
    shape: { type: 'rect', x: -10, y: FLOOR, w: W + 20, h: H - FLOOR + 10 },
    fill: { type: 'linear', from: [0, FLOOR], to: [0, H], stops: [[0, '#394257'], [1, '#232a38']] },
    z: 0,
  });
  add({
    id: 'floorShadow',
    parent: 'root',
    shape: { type: 'ellipse', cx: 180, cy: FLOOR + 2, rx: 96, ry: 11, detail: 8 },
    fill: { type: 'radial', center: [180, FLOOR + 2], radius: 96, stops: [[0, '#0e1118'], [1, '#ffffff']] },
    blend: 'multiply',
    z: 1,
    description: 'Multiply-blended contact shadow.',
  });

  // Cable: skinned strip along the chain (auto weights), plug + additive LED at the end.
  const cableSide = (sign: number): Pt[] => {
    const pts: Pt[] = [];
    for (const [bone, x0, x1] of [['cable1', -4, 24], ['cable2', 0, 24], ['cable3', 0, 26]] as const) {
      for (let x = x0; x <= x1; x += 4) pts.push(apply(world[bone], x, sign * 4.5) as Pt);
    }
    return pts;
  };
  const cableOutline = [...cableSide(-1), ...cableSide(1).reverse()];
  add({
    id: 'cable',
    skin: { bones: ['cable1', 'cable2', 'cable3'], weights: 'auto', falloff: 3 },
    shape: { type: 'polygon', points: flat(cableOutline), detail: 5 },
    fill: { type: 'linear', from: apply(world.cable1, 0, -4.5), to: apply(world.cable1, 0, 4.5), stops: [[0, '#6a7488'], [1, '#262b36']] },
    stroke: { color: C.line, width: 1.5 },
    z: 8,
    description: 'Skinned to cable1..3 with auto weights; bends smoothly as physics swings the chain.',
  });
  add({
    id: 'cablePlug',
    parent: 'cable3',
    shape: { type: 'path', d: boneRectPath(world.cable3, 22, 40, 7, 7, 2) },
    fill: C.metalLight,
    stroke: { color: C.line, width: 1.5 },
    z: 8.5,
  });
  const [sx, sy] = apply(world.cable1, 0, 0);
  add({
    id: 'cableSocket',
    parent: 'turret',
    shape: { type: 'rect', x: r(sx - 8), y: r(sy - 6), w: 16, h: 10, radius: 3 },
    fill: { type: 'linear', from: [r(sx - 8), 0], to: [r(sx + 8), 0], stops: [[0, C.metalDark], [0.4, C.metalLight], [1, C.metalDark]] },
    stroke: { color: C.line, width: 1.5 },
    z: 8.6,
    description: 'Socket on the turret that the cable hangs from (drawn over the cable root).',
  });
  const led = apply(world.cable3, 36, 0);
  add({
    id: 'cableLed',
    parent: 'cable3',
    shape: { type: 'ellipse', cx: r(led[0]), cy: r(led[1]), rx: 9, ry: 9, detail: 3 },
    fill: { type: 'radial', center: [r(led[0]), r(led[1])], radius: 9, stops: [[0, 'rgba(94,242,255,0.95)'], [0.35, 'rgba(94,242,255,0.5)'], [1, 'rgba(94,242,255,0)']] },
    blend: 'add',
    z: 9,
  });

  // Pedestal.
  add({
    id: 'pedestal',
    parent: 'root',
    shape: { type: 'path', d: d`M 116 ${FLOOR} L 128 352 Q 130 344 138 344 L 222 344 Q 230 344 232 352 L 244 ${FLOOR} Z`, detail: 12 },
    fill: { type: 'linear', from: [116, 0], to: [244, 0], stops: [[0, C.metalDark], [0.35, C.metalLight], [1, C.metalDark]] },
    stroke: { color: C.line, width: 2 },
    z: 5,
  });
  add({
    id: 'pedestalStripe',
    parent: 'root',
    shape: { type: 'path', d: d`M 124 392 L 236 392 L 238 402 L 122 402 Z` },
    fill: C.plate,
    stroke: { color: C.line, width: 1.5 },
    z: 6,
  });
  add({
    id: 'turretDome',
    parent: 'turret',
    shape: { type: 'path', d: d`M 136 346 C 136 318 156 300 180 300 C 204 300 224 318 224 346 Z`, detail: 10 },
    fill: { type: 'radial', center: [168, 312], radius: 52, stops: [[0, C.metalLight], [1, C.metalDark]] },
    stroke: { color: C.line, width: 2 },
    z: 7,
  });

  // Upper arm plate (rigid, parented to its bone).
  const ua = world.upperArm;
  add({
    id: 'upperArmPlate',
    parent: 'upperArm',
    shape: { type: 'path', d: boneRectPath(ua, 12, 116, 18, 16, 10), detail: 12 },
    fill: { type: 'linear', from: apply(ua, 60, -18), to: apply(ua, 60, 16), stops: [[0, C.plateLight], [0.5, C.plate], [1, C.plateDark]] },
    stroke: { color: C.line, width: 2 },
    z: 10,
    description: 'Rigid plate: parent = bone, so it moves without deforming.',
  });
  const uaBolts = [18, 104].flatMap((x) => [apply(ua, x, -10), apply(ua, x, 10)]).map(([x, y]) => circle(x, y, 2.6)).join(' ');
  add({ id: 'upperArmBolts', parent: 'upperArm', shape: { type: 'path', d: uaBolts, tolerance: 0.1 }, fill: C.metalDark, z: 11 });
  add({
    id: 'upperArmStripe',
    parent: 'upperArm',
    shape: { type: 'path', d: boneRectPath(ua, 40, 84, 5, 5, 2) },
    fill: C.metalDark,
    z: 11,
  });

  // Forearm plate.
  const fa = world.foreArm;
  add({
    id: 'foreArmPlate',
    parent: 'foreArm',
    shape: { type: 'path', d: boneRectPath(fa, 44, 128, 15, 12, 8), detail: 12 },
    fill: { type: 'linear', from: apply(fa, 86, -15), to: apply(fa, 86, 12), stops: [[0, C.plateLight], [0.5, C.plate], [1, C.plateDark]] },
    stroke: { color: C.line, width: 2 },
    z: 10,
  });
  const faBolts = [52, 120].flatMap((x) => [apply(fa, x, -7), apply(fa, x, 7)]).map(([x, y]) => circle(x, y, 2.3)).join(' ');
  add({ id: 'foreArmBolts', parent: 'foreArm', shape: { type: 'path', d: faBolts, tolerance: 0.1 }, fill: C.metalDark, z: 11 });

  // Rubber elbow boot: skinned across upperArm + foreArm with auto weights.
  const { outline, ribs } = elbowBoot(ua, fa, 150, 19);
  add({
    id: 'elbowBoot',
    skin: { bones: ['upperArm', 'foreArm'], weights: 'auto', falloff: 2 },
    shape: { type: 'polygon', points: flat(outline), detail: 6 },
    fill: C.rubber,
    stroke: { color: C.line, width: 2 },
    z: 12,
    description: 'Soft sleeve over the elbow: linear-blend skinned to upperArm + foreArm (auto weights, detail 6).',
  });
  add({
    id: 'elbowBootRibs',
    skin: { bones: ['upperArm', 'foreArm'], weights: 'auto', falloff: 2 },
    shape: { type: 'path', d: ribs, detail: 4 },
    fill: 'transparent',
    stroke: { color: C.rib, width: 3 },
    z: 13,
    mask: ['elbowBoot'],
    description: 'Rib lines (open paths, stroke only) skinned like the boot so they bend with it.',
  });

  // Shoulder hub (on top of the arm root).
  add({
    id: 'shoulderHub',
    parent: 'upperArm',
    shape: { type: 'ellipse', cx: SHOULDER[0], cy: SHOULDER[1], rx: 24, ry: 24, detail: 8 },
    fill: { type: 'radial', center: [SHOULDER[0] - 8, SHOULDER[1] - 8], radius: 34, stops: [[0, C.metalLight], [1, C.metalDark]] },
    stroke: { color: C.line, width: 2 },
    z: 14,
  });
  const notch = toSetup(ua, [[4, -3], [20, -3], [20, 3], [4, 3]]);
  add({ id: 'shoulderNotch', parent: 'upperArm', shape: { type: 'polygon', points: flat(notch) }, fill: C.plate, z: 15, description: 'Shows the hub rotating.' });

  // Hand, wrist and claws.
  const hd = world.hand;
  add({
    id: 'palm',
    parent: 'hand',
    shape: { type: 'path', d: boneRectPath(hd, -4, 36, 15, 13, 6), detail: 8 },
    fill: { type: 'linear', from: apply(hd, 16, -15), to: apply(hd, 16, 13), stops: [[0, C.metalLight], [1, C.metalDark]] },
    stroke: { color: C.line, width: 2 },
    z: 16,
  });
  const fingerParts: Array<[string, string, number]> = [
    ['fingerTop1', 'fingerTop2', 17],
    ['fingerMid1', 'fingerMid2', 18],
    ['fingerBot1', 'fingerBot2', 17],
  ];
  for (const [seg1, seg2, z] of fingerParts) {
    const m1 = world[seg1];
    const m2 = world[seg2];
    add({
      id: `${seg1}Link`,
      parent: seg1,
      shape: { type: 'path', d: boneRectPath(m1, -3, 23, 5, 4.5, 3) },
      fill: C.metalLight,
      stroke: { color: C.line, width: 1.5 },
      z,
    });
    add({
      id: `${seg2}Claw`,
      parent: seg2,
      shape: { type: 'path', d: clawPath(m2, -3, 17, 4.5, seg2 === 'fingerTop2' ? 3 : seg2 === 'fingerBot2' ? -3 : 0) },
      fill: C.plate,
      stroke: { color: C.line, width: 1.5 },
      z: z + 0.5,
    });
  }
  add({
    id: 'wristHub',
    parent: 'hand',
    shape: { type: 'ellipse', cx: r(wrist[0]), cy: r(wrist[1]), rx: 11, ry: 11, detail: 6 },
    fill: { type: 'radial', center: [r(wrist[0]) - 4, r(wrist[1]) - 4], radius: 16, stops: [[0, C.metalLight], [1, C.metalDark]] },
    stroke: { color: C.line, width: 2 },
    z: 19,
  });

  // IK target marker.
  add({
    id: 'targetMarker',
    parent: 'ikTarget',
    shape: {
      type: 'path',
      d: `${circle(r(wrist[0]), r(wrist[1]), 14)} ${d`M ${wrist[0] - 22} ${wrist[1]} L ${wrist[0] - 8} ${wrist[1]} M ${wrist[0] + 8} ${wrist[1]} L ${wrist[0] + 22} ${wrist[1]}
        M ${wrist[0]} ${wrist[1] - 22} L ${wrist[0]} ${wrist[1] - 8} M ${wrist[0]} ${wrist[1] + 8} L ${wrist[0]} ${wrist[1] + 22}`}`,
    },
    fill: 'transparent',
    stroke: { color: C.glow, width: 1.5 },
    opacity: 0.55,
    blend: 'add',
    z: 30,
    description: 'Crosshair on the IK target bone (additive, semi-transparent).',
  });

  // ------------------------------------------------------------------ bindings
  const bindings: Doc[] = [
    { target: 'bone:ikTarget.x', params: ['ReachX'], keys: [{ at: [-1], value: r(wrist[0] - 180 - 110) }, { at: [0], value: r(wrist[0] - 180) }, { at: [1], value: r(wrist[0] - 180 + 120) }] },
    { target: 'bone:ikTarget.y', params: ['ReachY'], keys: [{ at: [-1], value: r(wrist[1] - FLOOR + 80) }, { at: [0], value: r(wrist[1] - FLOOR) }, { at: [1], value: r(wrist[1] - FLOOR - 150) }] },
    { target: 'bone:hand.rotation', params: ['Wrist'], keys: [{ at: [-1], value: -75 }, { at: [1], value: 5 }] },
    { target: 'bone:fingerTop1.rotation', params: ['Grip'], keys: [{ at: [0], value: -25 }, { at: [1], value: 6 }] },
    { target: 'bone:fingerTop2.rotation', params: ['Grip'], keys: [{ at: [0], value: 35 }, { at: [1], value: 58 }] },
    { target: 'bone:fingerMid2.rotation', params: ['Grip'], keys: [{ at: [0], value: 12 }, { at: [1], value: 40 }] },
    { target: 'bone:fingerBot1.rotation', params: ['Grip'], keys: [{ at: [0], value: 25 }, { at: [1], value: -6 }] },
    { target: 'bone:fingerBot2.rotation', params: ['Grip'], keys: [{ at: [0], value: -35 }, { at: [1], value: -58 }] },
    // One Tap parameter per claw raises it away from the others (adds to Grip on the same bones).
    { target: 'bone:fingerTop1.rotation', params: ['TapTop'], keys: [{ at: [0], value: -25 }, { at: [1], value: -55 }] },
    { target: 'bone:fingerTop2.rotation', params: ['TapTop'], keys: [{ at: [0], value: 35 }, { at: [1], value: 20 }] },
    { target: 'bone:fingerMid1.rotation', params: ['TapMid'], keys: [{ at: [0], value: 0 }, { at: [1], value: -16 }] },
    { target: 'bone:fingerMid2.rotation', params: ['TapMid'], keys: [{ at: [0], value: 12 }, { at: [1], value: -28 }] },
    { target: 'bone:fingerBot1.rotation', params: ['TapBot'], keys: [{ at: [0], value: 25 }, { at: [1], value: 55 }] },
    { target: 'bone:fingerBot2.rotation', params: ['TapBot'], keys: [{ at: [0], value: -35 }, { at: [1], value: -20 }] },
    // Physics angles are world swings; local rotation of link k = swing_k - swing_(k-1). Bindings on
    // one property add their deltas, so the subtraction is a second binding with inverted values.
    { target: 'bone:cable1.rotation', params: ['Cable1'], keys: [{ at: [-60], value: 30 }, { at: [60], value: 150 }], description: 'Hangs straight down (90) at rest.' },
    { target: 'bone:cable2.rotation', params: ['Cable2'], keys: [{ at: [-60], value: -60 }, { at: [60], value: 60 }] },
    { target: 'bone:cable2.rotation', params: ['Cable1'], keys: [{ at: [-60], value: 60 }, { at: [60], value: -60 }], description: 'Subtracts the parent swing.' },
    { target: 'bone:cable3.rotation', params: ['Cable3'], keys: [{ at: [-60], value: -60 }, { at: [60], value: 60 }] },
    { target: 'bone:cable3.rotation', params: ['Cable2'], keys: [{ at: [-60], value: 60 }, { at: [60], value: -60 }], description: 'Subtracts the parent swing.' },
  ];

  // ------------------------------------------------------------------ constraints & physics
  // softness (px): the elbow straightens smoothly as the target nears full reach (285 px) instead of
  // snapping; from 285 - 30 px on the wrist trails the target slightly (7.5 px at full reach).
  const ik = [{ id: 'armIk', bones: ['upperArm', 'foreArm'], target: 'ikTarget', mix: 1, bendPositive: true, softness: IK_SOFTNESS }];
  const physics = [
    {
      id: 'cableSwing',
      inputs: [
        { param: 'ReachX', type: 'x', weight: 18 },
        { param: 'ReachY', type: 'x', weight: -8 },
        { param: 'Wrist', type: 'x', weight: 4 },
      ],
      outputs: [
        { param: 'Cable1', type: 'angle', segment: 0, scale: 1 },
        { param: 'Cable2', type: 'angle', segment: 1, scale: 1 },
        { param: 'Cable3', type: 'angle', segment: 2, scale: 1 },
      ],
      segments: [{ length: 24, mass: 1 }, { length: 24, mass: 1 }, { length: 24, mass: 1.5 }],
      damping: 0.08,
      stiffness: 10,
      description: 'The pedestal shakes as the arm moves (input weights are px of pivot motion per unit); the chain swing drives cable1..3.',
    },
  ];

  // ------------------------------------------------------------------ animations
  /** Cycle of the "drum" gait (s): each claw taps once. */
  const DRUM = 0.9;
  /** One coordinate of a small circle over the drum cycle: three keys (120 degrees apart) plus the closing key. */
  const circleKeys = (center: number, radius: number, phase: number) =>
    [0, 1, 2, 3].map((i) => key((i * DRUM) / 3, center + radius * Math.cos(phase + (2 * Math.PI * i) / 3), i < 3 ? 'smooth' : undefined));
  const animations = [
    {
      id: 'idle',
      duration: 3,
      loop: true,
      description: 'Servo hover: tiny target drift, wrist and claw fidget.',
      tracks: [
        { target: 'param:ReachX', keys: [key(0, 0, 'inOutSine'), key(1.5, 0.06, 'inOutSine'), key(3, 0)] },
        { target: 'param:ReachY', keys: [key(0, 0, 'inOutSine'), key(0.75, 0.08, 'inOutSine'), key(2.25, -0.06, 'inOutSine'), key(3, 0)] },
        { target: 'param:Wrist', keys: [key(0, 0, 'inOutSine'), key(1, 0.15, 'inOutSine'), key(2, -0.1, 'inOutSine'), key(3, 0)] },
        { target: 'param:Grip', keys: [key(0, 0.1, 'inOutSine'), key(1.5, 0.25, 'inOutSine'), key(3, 0.1)] },
      ],
    },
    {
      id: 'reach',
      duration: 4,
      loop: true,
      description:
        'IK target travels a loop: reach far right and low, grab, swing up and left, release, return. At the grab the target is at 99% of the reach: softness keeps the elbow from snapping straight.',
      tracks: [
        { target: 'param:ReachX', keys: [key(0, 0, 'inOutSine'), key(1, 0.8, 'inOutSine'), key(1.4, 0.76, 'inOutSine'), key(2.4, -0.3, 'inOutSine'), key(3.1, -0.9, 'inOutSine'), key(4, 0)] },
        { target: 'param:ReachY', keys: [key(0, 0, 'inOutSine'), key(1, -0.9, 'inOutSine'), key(1.4, -0.85, 'inOutSine'), key(2.4, 0.9, 'inOutSine'), key(3.1, 0.2, 'inOutSine'), key(4, 0)] },
        { target: 'param:Grip', keys: [key(0, 0), key(1.0, 0, 'outQuad'), key(1.2, 1), key(3.0, 1, 'outQuad'), key(3.2, 0)] },
        { target: 'param:Wrist', keys: [key(0, 0, 'inOutSine'), key(1, 0.8, 'inOutSine'), key(2.4, -0.6, 'inOutSine'), key(4, 0)] },
      ],
      events: [
        { t: 1.2, name: 'grab' },
        { t: 3.2, name: 'release' },
      ],
    },
    {
      id: 'wave',
      duration: 2,
      loop: true,
      description: 'Arm raised; the target sways left-right while the wrist waves and the claws flutter.',
      tracks: [
        { target: 'param:ReachY', keys: [key(0, 0.85)] },
        { target: 'param:ReachX', keys: [key(0, -0.35, 'inOutSine'), key(0.5, -0.1, 'inOutSine'), key(1, -0.35, 'inOutSine'), key(1.5, -0.1, 'inOutSine'), key(2, -0.35)] },
        { target: 'param:Wrist', keys: [key(0, -1, 'inOutSine'), key(0.5, 0.6, 'inOutSine'), key(1, -1, 'inOutSine'), key(1.5, 0.6, 'inOutSine'), key(2, -1)] },
        { target: 'param:Grip', keys: [key(0, 0, 'inOutSine'), key(0.25, 0.3, 'inOutSine'), key(0.5, 0, 'inOutSine'), key(0.75, 0.3, 'inOutSine'), key(1, 0, 'inOutSine'), key(1.25, 0.3, 'inOutSine'), key(1.5, 0, 'inOutSine'), key(1.75, 0.3, 'inOutSine'), key(2, 0)] },
      ],
    },
    {
      id: 'drum',
      duration: DRUM,
      loop: true,
      description:
        'Walk-like gait: the hand hovers over the floor and the three claws tap in turn, like drumming fingers. TapMid and TapBot reuse the TapTop keys with offset 1/3 and 2/3 of the cycle. The hand circles a little: ReachX and ReachY each have three keys with ease "smooth", which pass through them on a round loop (inOutSine would stop at every key and trace a triangle).',
      tracks: [
        { target: 'param:Wrist', keys: [key(0, 0.9)] },
        { target: 'param:ReachX', keys: circleKeys(0.3, 0.06, 0) },
        { target: 'param:ReachY', keys: circleKeys(-0.93, 0.05, -Math.PI / 2) },
        ...(['Top', 'Mid', 'Bot'] as const).map((c, i) => ({
          target: `param:Tap${c}`,
          ...(i ? { offset: r((i * DRUM) / 3, 3) } : {}),
          // Lift (smooth), strike at a third of the cycle, rest until the next turn.
          keys: [key(0, 0, 'smooth'), key(DRUM / 6, 1, 'smooth'), key(DRUM / 3, 0), key(DRUM, 0)],
        })),
      ],
    },
  ];

  return {
    format: 'rev2d',
    version: 1,
    meta: {
      name: 'robot-arm',
      width: W,
      height: H,
      background: '#1b202b',
      fps: 30,
      author: 'Rev2D examples',
      description:
        'Spine-style rig: two-bone IK (armIk) toward a parameter-driven target bone, rigid bone-parented plates, a skinned rubber elbow boot (auto weights), a 3-claw gripper and a physics-driven skinned cable.',
    },
    parameters,
    bones: boneDocs,
    parts,
    bindings,
    ik,
    physics,
    animations,
  };
}

/**
 * Outline of a sleeve of half-width `hw` around the elbow (upper arm local x 92..len, forearm local
 * x 0..48): the outer side wraps around the joint with an arc, the inner side meets at the miter point
 * of the two offset lines (no self-overlap). Also returns rib lines across the sleeve.
 */
function elbowBoot(ua: Mat2D, fa: Mat2D, len: number, hw: number): { outline: Pt[]; ribs: string } {
  const elbow = apply(ua, len, 0);
  const a1 = Math.atan2(ua[1], ua[0]);
  const a2 = Math.atan2(fa[1], fa[0]);
  let turn = a2 - a1;
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn < -Math.PI) turn += 2 * Math.PI;
  // A clockwise (positive) turn puts the inner side on local +y.
  const inner = Math.sign(turn);
  const miter = hw * Math.tan(Math.abs(turn) / 2);
  const outerSide: Pt[] = [];
  const innerSide: Pt[] = [];
  for (let x = 92; x <= len; x += 8) outerSide.push(apply(ua, x, -inner * hw) as Pt);
  const arcSteps = 6;
  for (let i = 1; i < arcSteps; i++) {
    const a = a1 + (turn * i) / arcSteps - (inner * Math.PI) / 2;
    outerSide.push([elbow[0] + Math.cos(a) * hw, elbow[1] + Math.sin(a) * hw]);
  }
  for (let x = 0; x <= 48; x += 8) outerSide.push(apply(fa, x, -inner * hw) as Pt);
  for (let x = 48; x > miter; x -= 8) innerSide.push(apply(fa, x, inner * hw) as Pt);
  innerSide.push(apply(fa, miter, inner * hw) as Pt);
  for (let x = len - miter - 8; x >= 92; x -= 8) innerSide.push(apply(ua, x, inner * hw) as Pt);
  const rib = (m: Mat2D, x: number) => {
    const [ax, ay] = apply(m, x, -hw - 2);
    const [bx, by] = apply(m, x, hw + 2);
    return d`M ${ax} ${ay} L ${bx} ${by}`;
  };
  const ribs = [rib(ua, 104), rib(ua, 118), rib(fa, 30), rib(fa, 42)].join(' ');
  return { outline: [...outerSide, ...innerSide].map(([x, y]) => [r(x), r(y)] as Pt), ribs };
}

