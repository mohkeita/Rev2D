/**
 * Feature "animations": the animations every avatar model gets, as parameter tracks only (they
 * work with any rig that has the same parameters, and Live2D motions can replace them).
 *
 *   idle         8 s seamless loop: breathing (two breaths), a slow body sway, a gentle head
 *                motion, blinks at uneven times (one of them double) and one glance to the side
 *   blink        one blink, 0.3 s, not looping (play it "once" over another animation)
 *   talk         2.4 s loop: a mouth pattern of open / half / closed with some mouth form
 *   nod          1.2 s, not looping: the head dips and comes back
 *   look_around  7 s loop: the head and the eyes look left, right and up, calmly (hair sways
 *                without staying at its limit)
 *   sweep        18 s loop for reviews: AngleX, then AngleY, then AngleZ through their whole range
 *                (physics reaches its limit at the quick ends; review with physics off)
 *
 * This feature runs LAST, so it sees every parameter the other features declared and only drives
 * those: a track whose parameter the model lacks is left out, and an animation is only added when
 * the model has a parameter it is about (`needs`: no MouthOpen = no "talk", no eyes = no "blink"). Every key list of a looping animation ends
 * on its first value at t = duration, so the loops close. Hair and attachment parameters are never
 * animated: physics writes them (the idle motion makes them sway).
 */
import type { AnimationInput } from '../builder.js';
import type { AvatarFeature } from './types.js';

type Key = { t: number; v: number; ease?: 'linear' | 'inOutSine' | 'outQuad' | 'inQuad' | 'smooth' };
type Track = { target: string; keys: Key[] };

/** A smooth back-and-forth: keys at the given times / values with an eased (sine-like) shape between them. */
function wave(times: number[], values: number[]): Key[] {
  return times.map((t, i) => ({ t, v: values[i], ease: 'inOutSine' as const }));
}

/** Blinks: the eye closes in `close` s, stays shut for `hold` s and opens in `open` s, starting at each time. */
function blinks(duration: number, starts: number[], close = 0.07, hold = 0.04, open = 0.12): Key[] {
  const keys: Key[] = [{ t: 0, v: 1 }];
  for (const s of starts) {
    keys.push({ t: s, v: 1, ease: 'inQuad' }, { t: s + close, v: 0 }, { t: s + close + hold, v: 0, ease: 'outQuad' }, { t: s + close + hold + open, v: 1 });
  }
  keys.push({ t: duration, v: 1 });
  return keys;
}

/** Round times and values so the JSON stays short. */
function tidy(keys: Key[]): Key[] {
  return keys.map((k) => ({ ...k, t: Math.round(k.t * 1000) / 1000, v: Math.round(k.v * 1000) / 1000 }));
}

/** The generated animations, before parameters the model lacks are left out. */
export interface AnimationPlan {
  id: string;
  duration: number;
  loop: boolean;
  description: string;
  /** The animation is added only when the model has at least one of these parameters (none listed: always). */
  needs: string[];
  tracks: Track[];
}

export function animationPlans(): AnimationPlan[] {
  const idleBlinks = blinks(8, [1.6, 4.3, 4.65, 7.0]);
  return [
    {
      id: 'idle',
      duration: 8,
      loop: true,
      description: 'Seamless 8 s idle: two breaths, a slow body sway, a gentle head motion, blinks at uneven times and one glance.',
      needs: [],
      tracks: [
        { target: 'param:Breath', keys: wave([0, 2, 4, 6, 8], [0, 1, 0, 1, 0]) },
        { target: 'param:BodyAngleX', keys: wave([0, 4, 8], [-2.5, 2.5, -2.5]) },
        { target: 'param:AngleX', keys: wave([0, 2.6, 5.6, 8], [-3, 6, -6, -3]) },
        { target: 'param:AngleY', keys: wave([0, 3, 6, 8], [0, 3, -2, 0]) },
        { target: 'param:AngleZ', keys: wave([0, 4, 8], [2, -3, 2]) },
        { target: 'param:EyeLOpen', keys: idleBlinks },
        { target: 'param:EyeROpen', keys: idleBlinks },
        { target: 'param:EyeBallX', keys: wave([0, 2.3, 2.6, 3.4, 3.7, 8], [0, 0, 0.6, 0.6, 0, 0]) },
        { target: 'param:EyeBallY', keys: wave([0, 2.3, 2.6, 3.4, 3.7, 8], [0, 0, 0.15, 0.15, 0, 0]) },
      ],
    },
    {
      id: 'blink',
      duration: 0.3,
      loop: false,
      description: 'One blink (play it "once" over another animation).',
      needs: ['EyeLOpen', 'EyeROpen'],
      tracks: [
        { target: 'param:EyeLOpen', keys: blinks(0.3, [0.02]) },
        { target: 'param:EyeROpen', keys: blinks(0.3, [0.02]) },
      ],
    },
    {
      id: 'talk',
      duration: 2.4,
      loop: true,
      description: 'A 2.4 s talking loop: the mouth opens to different degrees, with some mouth form.',
      needs: ['MouthOpen'],
      tracks: [
        { target: 'param:MouthOpen', keys: wave([0, 0.15, 0.3, 0.45, 0.6, 0.8, 0.95, 1.15, 1.35, 1.5, 1.7, 1.9, 2.1, 2.4], [0, 0.8, 0.2, 0.6, 0.1, 0.9, 0.3, 0.7, 0, 0.5, 0.15, 0.85, 0.25, 0]) },
        { target: 'param:MouthForm', keys: wave([0, 0.6, 1.2, 1.8, 2.4], [0, 0.4, -0.3, 0.3, 0]) },
        { target: 'param:AngleY', keys: wave([0, 0.6, 1.2, 1.8, 2.4], [0, -1.5, 0.5, -1, 0]) },
      ],
    },
    {
      id: 'nod',
      duration: 1.2,
      loop: false,
      description: 'A nod: the head dips and comes back.',
      needs: ['AngleY'],
      tracks: [
        { target: 'param:AngleY', keys: wave([0, 0.35, 0.7, 1.2], [0, -14, 3, 0]) },
        { target: 'param:AngleZ', keys: wave([0, 0.35, 1.2], [0, 1.5, 0]) },
      ],
    },
    {
      id: 'look_around',
      duration: 7,
      loop: true,
      description: 'A calm 7 s loop: the head and the eyes look left, right and up.',
      needs: ['AngleX', 'AngleY'],
      tracks: [
        { target: 'param:AngleX', keys: wave([0, 1.4, 2.4, 4, 5, 7], [0, -12, -12, 12, 12, 0]) },
        { target: 'param:AngleY', keys: wave([0, 2.4, 4, 5, 6, 7], [0, 0, 4, 4, 9, 0]) },
        { target: 'param:AngleZ', keys: wave([0, 1.4, 3.2, 5, 7], [0, 3, 0, -3, 0]) },
        { target: 'param:EyeBallX', keys: wave([0, 1.1, 2.4, 3.6, 5, 5.8, 7], [0, -0.7, -0.7, 0.7, 0.7, 0, 0]) },
        { target: 'param:EyeBallY', keys: wave([0, 5, 5.8, 6.5, 7], [0, 0, 0.5, 0.5, 0]) },
        { target: 'param:BodyAngleX', keys: wave([0, 1.8, 4.6, 7], [0, -2.5, 2.5, 0]) },
      ],
    },
    {
      id: 'sweep',
      duration: 18,
      loop: true,
      description: 'For reviews: AngleX, then AngleY, then AngleZ through their whole range (6 s each).',
      needs: ['AngleX', 'AngleY', 'AngleZ'],
      tracks: [
        { target: 'param:AngleX', keys: wave([0, 1.5, 4.5, 6, 18], [0, -30, 30, 0, 0]) },
        { target: 'param:AngleY', keys: wave([0, 6, 7.5, 10.5, 12, 18], [0, 0, 30, -30, 0, 0]) },
        { target: 'param:AngleZ', keys: wave([0, 12, 13.5, 16.5, 18], [0, 0, -30, 30, 0]) },
      ],
    },
  ];
}

export const animations: AvatarFeature = {
  id: 'animations',
  summary: 'generated animations: idle, blink, talk, nod, look_around, sweep (parameter tracks only)',

  compile(ctx) {
    const { model } = ctx;
    for (const plan of animationPlans()) {
      if (model.hasAnimation(plan.id)) continue;
      if (plan.needs.length && !plan.needs.some((id) => model.hasParameter(id))) continue;
      const tracks = plan.tracks.filter((t) => model.hasParameter(t.target.slice('param:'.length))).map((t) => ({ target: t.target, keys: tidy(t.keys) }));
      if (tracks.length === 0) continue;
      const animation: AnimationInput = { id: plan.id, duration: plan.duration, loop: plan.loop, tracks, description: plan.description };
      model.animation(animation);
    }
  },
};
