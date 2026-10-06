/**
 * The fixed poses an avatar is reviewed in (`rev2d avatar poses` renders them as contact sheets).
 * Parameter ids are the Live2D standard ids of the built model; a pose whose parameters the model
 * does not have (a feature that is not built) is skipped by the renderer.
 *
 * Features append their own poses through AvatarFeature.poses (a hair strand at its limit, a smile).
 */
import { AVATAR_FEATURES } from './features/index.js';
import type { AvatarFeature } from './features/types.js';
import { avatarMetrics } from './fields.js';
import type { AvatarPose, AvatarSpec, LayersMeta } from './types.js';

/** The standard review poses, in sheet order. */
export const STANDARD_POSES: readonly AvatarPose[] = [
  { id: 'rest', label: 'rest', params: {} },
  { id: 'eyes_half', label: 'eyes half', params: { EyeLOpen: 0.5, EyeROpen: 0.5 }, zoom: 'eyes' },
  { id: 'eyes_closed', label: 'eyes closed', params: { EyeLOpen: 0, EyeROpen: 0 }, zoom: 'eyes' },
  { id: 'mouth_open', label: 'mouth open', params: { MouthOpen: 1 }, zoom: 'mouth' },
  { id: 'turn_left', label: 'turn left (AngleX -30)', params: { AngleX: -30 } },
  { id: 'turn_right', label: 'turn right (AngleX 30)', params: { AngleX: 30 } },
  { id: 'look_up', label: 'look up (AngleY 30)', params: { AngleY: 30 } },
  { id: 'look_down', label: 'look down (AngleY -30)', params: { AngleY: -30 } },
  { id: 'tilt_left', label: 'tilt left (AngleZ -30)', params: { AngleZ: -30 } },
  { id: 'tilt_right', label: 'tilt right (AngleZ 30)', params: { AngleZ: 30 } },
  { id: 'sway_left', label: 'sway left (BodyAngleX -10)', params: { BodyAngleX: -10 } },
  { id: 'sway_right', label: 'sway right (BodyAngleX 10)', params: { BodyAngleX: 10 } },
];

/** avatarReviewPoses with an explicit feature list. */
export function reviewPoses(spec: AvatarSpec, meta: LayersMeta, features: readonly AvatarFeature[] = AVATAR_FEATURES): AvatarPose[] {
  const poses: AvatarPose[] = STANDARD_POSES.map((p) => ({ ...p, params: { ...p.params } }));
  const ctx = { spec, meta, metrics: avatarMetrics(spec) };
  for (const feature of features) {
    for (const pose of feature.poses?.(ctx) ?? []) {
      if (poses.some((p) => p.id === pose.id)) throw new Error(`avatarReviewPoses: the pose id "${pose.id}" is used twice (feature "${feature.id}")`);
      poses.push(pose);
    }
  }
  return poses;
}
