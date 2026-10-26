import { figureLandmarks, type FigurePose } from './figure.js';

/** Authored face landmarks for the fixture only. User images must have their own measured landmarks. */
export function figureAvatarDoc(name = 'figure') {
  const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
    Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2;
      return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
    }).flat();
  const eye = (cx: number) => ({
    opening: ellipse(cx, 117, 12, 15),
    region: ellipse(cx, 117, 23, 25),
    iris: { center: [cx + 2, 119], radius: 5 },
  });
  return {
    format: 'rev2d-avatar',
    version: 1,
    name,
    image: { file: 'source.png', width: 360, height: 480 },
    head: {
      center: [180, 110],
      radius: [64, 77],
      pivot: [180, 187],
      neck: [181, 198],
      turn: { x: 2, y: 2 },
      tilt: 2,
    },
    face: {
      center: [180, 125],
      radius: [54, 54],
      eyes: { imageLeft: eye(155), imageRight: eye(205) },
      nose: [178, 136],
      chin: [180, 178],
      mouth: {
        imageLeft: [162, 150],
        imageRight: [198, 150],
        bow: 6,
        area: { center: [180, 155], radius: [25, 15] },
      },
    },
    hair: { strands: [] },
    attachments: [],
    body: {
      pivot: [180, 326],
      fade: [200, 330],
      sway: 1,
      breath: 1,
      chest: { center: [180, 248], radius: [45, 50] },
    },
  };
}

/** Full-body truth from the original vector builder, used only for synthetic figures. */
export function fullFigureAvatarDoc(pose: FigurePose = 'standing', name = 'figure_full') {
  const points = figureLandmarks(pose);
  return {
    ...figureAvatarDoc(name),
    framing: 'full' as const,
    arms: [
      {
        id: 'armR' as const,
        shoulder: points.shoulderR,
        elbow: points.elbowR,
        wrist: points.wristR,
        width: [28, 28],
        hand: { center: points.wristR, radius: 20 },
        front: true,
      },
      {
        id: 'armL' as const,
        shoulder: points.shoulderL,
        elbow: points.elbowL,
        wrist: points.wristL,
        width: [28, 28],
        hand: { center: points.wristL, radius: 20 },
        front: true,
      },
    ],
    legs: { hips: points.hips, feet: points.feet, seated: pose.startsWith('sitting') },
  };
}
