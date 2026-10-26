export const GESTURES = {
  voila: 'Open both arms with palms facing up.',
  point_left: 'Point toward screen left.',
  point_right: 'Point toward screen right.',
  point_up: 'Point above the head.',
  shrug: 'Lift the hands and shoulders in uncertainty.',
  think: 'Rest a hand near the chin.',
  scratch_head: 'Reach the side of the head and scratch gently.',
  facepalm: 'Place an open palm over the face.',
  count: 'Count one, two or three on an authored hand drawing.',
  wave: 'Raise a hand and wave at the wrist.',
  nod_yes: 'Nod the head.',
  shake_no: 'Shake the head.',
  lean_in: 'Lean the upper body toward the viewer.',
  thumbs_up: 'Show an authored thumb-up hand.',
  cross_arms: 'Bring both hands across the chest.',
  celebrate: 'Lift both arms in celebration.',
} as const;
export type GestureName = keyof typeof GESTURES;
export const EXPRESSIONS = {
  neutral: 'Return the face to its neutral controls.',
  happy: 'Soft smile and raised brows.',
  laugh: 'Laugh with smiling eyes.',
  surprised: 'Widen eyes and open a small round mouth.',
  shocked: 'Wide eyes and a large round mouth.',
  worried: 'Raise brows inward and narrow the mouth.',
  thinking: 'Look aside with a thoughtful brow.',
  annoyed: 'Lower brows and look aside.',
  sad: 'Lower the head and frown.',
  proud: 'Raise the head with a small grin.',
  confused: 'Asymmetric brows and a tilted head.',
} as const;
export type ExpressionName = keyof typeof EXPRESSIONS;
