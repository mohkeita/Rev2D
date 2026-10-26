/** Geometric diagnostics for authored full-body landmarks. No pixel guesses. */
import type { Diagnostic } from '../core/types.js';
import type { AvatarSpec } from './types.js';
import { pointInPolygon, polygonSelfIntersects } from './image/polygon.js';

export function validateArmLandmarks(spec: AvatarSpec): Diagnostic[] {
  const out: Diagnostic[] = [],
    arms = spec.arms ?? [],
    seen = new Set<string>();
  const error = (code: string, path: string, message: string, hint: string) =>
    out.push({ severity: 'error', code, path, message, hint });
  const inside = (p: readonly number[], path: string, code: string) => {
    if (p[0] < 0 || p[1] < 0 || p[0] >= spec.image.width || p[1] >= spec.image.height)
      error(
        code,
        path,
        'landmark is outside the illustration',
        'place it in source-image pixel coordinates inside the image',
      );
  };
  const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (spec.framing === 'full' && !spec.legs)
    error(
      'avatar-legs-missing',
      '/legs',
      'full framing requires legs',
      'place hips, both feet and the seated flag',
    );
  arms.forEach((arm, i) => {
    const path = '/arms/' + i;
    if (seen.has(arm.id))
      error(
        'avatar-arm-duplicate-id',
        path + '/id',
        'an arm id is duplicated',
        'use armR and armL at most once each',
      );
    seen.add(arm.id);
    for (const key of ['shoulder', 'elbow', 'wrist'] as const)
      inside(arm[key], path + '/' + key, 'avatar-arm-outside-image');
    inside(arm.hand.center, path + '/hand/center', 'avatar-arm-outside-image');
    if (
      distance(arm.shoulder, arm.elbow) < Math.max(3, arm.width[0] * 0.4) ||
      distance(arm.elbow, arm.wrist) < Math.max(3, arm.width[1] * 0.4)
    )
      error(
        'avatar-arm-segment-short',
        path,
        'an arm segment is too short for its width',
        'place distinct shoulder, elbow and wrist centers inside their anatomical joints',
      );
    if (distance(arm.wrist, arm.hand.center) > arm.hand.radius + arm.width[1])
      error(
        'avatar-arm-hand-detached',
        path + '/hand',
        'the hand does not reach the wrist',
        'move the wrist to the glove cuff or correct the hand radius/outline',
      );
    const chest = spec.body.chest;
    if (
      Math.hypot(
        (arm.shoulder[0] - chest.center[0]) / chest.radius[0],
        (arm.shoulder[1] - chest.center[1]) / chest.radius[1],
      ) > 3
    )
      error(
        'avatar-arm-shoulder-detached',
        path + '/shoulder',
        'the shoulder is far from the torso',
        'place the shoulder inside its sleeve, close to the chest',
      );
    for (const [name, polygon] of [
      ['outline', arm.outline],
      ['hand/outline', arm.hand.outline],
    ] as const) {
      if (!polygon) continue;
      if (polygon.length < 6 || polygon.length % 2)
        error(
          'avatar-arm-outline',
          path + '/' + name,
          'arm outlines need at least three point pairs',
          'trace a closed, non-crossing polygon in source pixels',
        );
      else {
        if (polygonSelfIntersects(polygon))
          error(
            'avatar-arm-outline-crosses',
            path + '/' + name,
            'the outline crosses itself',
            'trace the perimeter in one clockwise or counterclockwise direction',
          );
        for (let j = 0; j < polygon.length; j += 2)
          inside([polygon[j], polygon[j + 1]], path + '/' + name + '/' + j, 'avatar-arm-outside-image');
      }
    }
    if (arm.outline && !pointInPolygon(arm.outline, arm.elbow[0], arm.elbow[1]))
      error(
        'avatar-arm-outline-joint',
        path + '/outline',
        'the arm outline misses the elbow',
        'include the elbow joint in the arm polygon',
      );
  });
  if (spec.legs) {
    inside(spec.legs.hips, '/legs/hips', 'avatar-legs-outside-image');
    spec.legs.feet.forEach((p, i) => inside(p, '/legs/feet/' + i, 'avatar-legs-outside-image'));
    if (distance(spec.legs.feet[0], spec.legs.feet[1]) < 2)
      error(
        'avatar-legs-feet-coincident',
        '/legs/feet',
        'both feet occupy the same point',
        'place the center of each foot separately',
      );
    if (!spec.legs.seated && spec.legs.feet.some((p) => p[1] <= spec.legs!.hips[1]))
      error(
        'avatar-legs-order',
        '/legs',
        'standing feet must lie below the hips',
        'correct hips/feet or mark a seated pose',
      );
  }
  return out;
}
