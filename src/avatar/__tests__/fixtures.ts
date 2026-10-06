/**
 * Hand-written fixtures of the avatar spec tests: a complete, valid spec for an imaginary 400 x 500
 * illustration, a synthetic picture of that size, and a small Mesh Avatar Studio rig. Nothing here
 * comes from third-party art.
 */
import type { ImageRGBA } from '../../core/types.js';
import { drawCircle, fillRect } from '../../render/draw.js';
import { createImage } from '../../render/image.js';

// Tests mutate deep copies of JSON fixtures, so loose typing keeps them readable.
export type Json = any;

export const WIDTH = 400;
export const HEIGHT = 500;

/** A valid spec that uses every optional group: parseAvatarSpec reports nothing for it. */
export function validDoc(): Json {
  return {
    format: 'rev2d-avatar',
    version: 1,
    name: 'tester',
    image: { file: 'source.png', width: WIDTH, height: HEIGHT },
    head: { center: [200, 170], radius: [130, 150], pivot: [200, 300], neck: [285, 340], turn: { x: 14, y: 12 }, tilt: 8.5 },
    face: {
      center: [200, 200],
      radius: [75, 80],
      eyes: {
        imageLeft: {
          opening: [150, 195, 155, 188, 165, 185, 175, 188, 180, 195, 175, 202, 165, 205, 155, 202],
          region: [142, 195, 150, 180, 165, 176, 180, 180, 188, 195, 180, 210, 165, 214, 150, 210],
          iris: { center: [165, 195], radius: 8 },
        },
        imageRight: {
          opening: [220, 195, 225, 188, 235, 185, 245, 188, 250, 195, 245, 202, 235, 205, 225, 202],
          region: [212, 195, 220, 180, 235, 176, 250, 180, 258, 195, 250, 210, 235, 214, 220, 210],
        },
      },
      brows: { imageLeft: [150, 170, 165, 166, 180, 170], imageRight: [220, 170, 235, 166, 250, 170] },
      nose: [200, 225],
      mouth: { imageLeft: [185, 248], imageRight: [215, 248], bow: 2, area: { center: [200, 250], radius: [24, 14], rotation: 0 } },
      chin: [200, 278],
      cheeks: { imageLeft: [155, 225], imageRight: [245, 225] },
      ears: { imageLeft: [122, 200], imageRight: [278, 200] },
    },
    hair: {
      strands: [
        { id: 'bangL', nodes: [170, 60, 165, 110, 160, 160], width: 20 },
        { id: 'sideR', nodes: [300, 120, 310, 220, 305, 320], width: 24, group: 'side' },
      ],
    },
    attachments: [
      { id: 'tassel', kind: 'pendulum', outline: [320, 150, 345, 150, 345, 230, 320, 230], pivot: [332, 152], tip: [332, 228] },
      { id: 'bun', kind: 'jiggle', center: [120, 60], radius: [40, 35] },
      { id: 'hand', kind: 'cutout', outline: [140, 300, 190, 300, 190, 420, 140, 420], contact: [180, 285] },
    ],
    body: { pivot: [200, 620], fade: [380, 500], sway: 2, chest: { center: [200, 420], radius: [110, 70] }, shoulders: [[90, 380], [310, 380]] },
  };
}

/**
 * A 400 x 500 picture on a transparent background: a dark "hair" disc, a skin "face" disc, two
 * white eyes, a red tassel and a dark body. Flat colours make pixel assertions exact.
 */
export function testImage(): ImageRGBA {
  const img = createImage(WIDTH, HEIGHT);
  fillRect(img, 90, 340, 220, 160, '#22262e');
  drawCircle(img, 200, 170, 120, '#5a3324', { antialias: false });
  drawCircle(img, 200, 200, 75, '#f6d8c6', { antialias: false });
  drawCircle(img, 165, 195, 14, '#ffffff', { antialias: false });
  drawCircle(img, 235, 195, 14, '#ffffff', { antialias: false });
  fillRect(img, 322, 152, 20, 76, '#c81e1e');
  return img;
}

/** A minimal Mesh Avatar Studio rig (version 1) for a 400 x 500 illustration; angles in radians. */
export function masRig(): Json {
  return {
    version: 1,
    image: { width: WIDTH, height: HEIGHT },
    head: { cx: 200, cy: 170, rx: 130, ry: 150, shiftX: 14, shiftY: 11, pivotX: 200, pivotY: 300, maxRoll: Math.PI / 20, weightBand: [285, 340], turnBand: [290, 380] },
    body: {
      pivotX: 200,
      pivotY: 620,
      maxRoll: Math.PI / 60,
      breathBand: [400, 500],
      rollBand: [380, 500],
      chest: { cx: 200, cy: 420, rx: 110, ry: 70 },
      shoulders: [
        { cx: 310, cy: 380, rx: 50, ry: 40 },
        { cx: 90, cy: 380, rx: 50, ry: 40 },
      ],
    },
    face: {
      nose: { cx: 200, cy: 225, rx: 14, ry: 14 },
      mouth: { cx: 200, cy: 250, rx: 22, ry: 12 },
      eyeA: { cx: 165, cy: 195, rx: 24, ry: 18 },
      eyeB: { cx: 235, cy: 195, rx: 24, ry: 18 },
      earL: { cx: 122, cy: 200, rx: 10, ry: 18 },
      earR: { cx: 278, cy: 200, rx: 10, ry: 18 },
      brow: { cx: 235, cy: 168, rx: 20, ry: 6, band: [174, 180] },
      jaw: { cx: 200, cy: 262, rx: 40, ry: 24, band: [250, 262] },
    },
    buns: { bunL: { cx: 120, cy: 60, rx: 40, ry: 35 } },
    eyes: [
      {
        opening: [[150, 195], [155, 188], [165, 185], [175, 188], [180, 195], [175, 202], [165, 205], [155, 202]],
        roi: [[142, 195], [150, 180], [165, 176], [180, 180], [188, 195], [180, 210], [165, 214], [150, 210]],
        x0: 150,
        x1: 180,
        top: [195, 186, 195],
        bot: [195, 204, 195],
      },
      {
        opening: [[220, 195], [225, 188], [235, 185], [245, 188], [250, 195], [245, 202], [235, 205], [225, 202]],
        roi: [[212, 195], [220, 180], [235, 176], [250, 180], [258, 195], [250, 210], [235, 214], [220, 210]],
      },
    ],
    mouth: { cx: 200, cy: 248, angle: Math.PI / 6, halfLen: 16, bow: 2, area: { cx: 200, cy: 250, rx: 24, ry: 14, angle: Math.PI / 12 } },
    cheeks: [[155, 225], [245, 225]],
    strands: [
      { name: 'bang1', nodes: [[170, 60], [165, 110], [160, 160]], sigma: 10, k: 1.1, max: 6 },
      { name: 'lock right', nodes: [[300, 120], [310, 220], [305, 320]], sigma: 12, k: 0.6, max: 9 },
    ],
    accessories: [{ name: 'tassel_r', pivot: [322, 152], tip: [322, 228], split: 0.4, box: [310, 150, 335, 230], color: { redness: 0.5, minRed: 60 } }],
    hand: { outline: [[140, 300], [190, 300], [190, 420], [140, 420]], contact: [180, 285], elbow: [100, 600], wrist: [160, 380], forearmShare: 0.3 },
    mesh: { baseCell: 14 },
    view: { padTop: 0, padSide: 0 },
  };
}

/** The first diagnostic with a code, or undefined. */
export function byCode<T extends { code: string }>(diagnostics: readonly T[], code: string): T | undefined {
  return diagnostics.find((d) => d.code === code);
}
