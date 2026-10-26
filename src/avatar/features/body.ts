/**
 * Feature "body": body sway (BodyAngleX) and breathing (Breath), both bindings on the root lattice.
 *
 * SWAY. A rotation about body.pivot (far below, near or under the bottom edge) whose angle is
 * weighted by the body fade band: everything above body.fade[0] leans as one piece (the head
 * follows fully), the bottom rows stay anchored.
 *
 * BREATH. The chest rises by body.breath px at the centre of the chest ellipse (a dome a quarter
 * larger than the ellipse) and widens a little; everything above the chest (shoulders, neck, head)
 * rises by a third of that, the shoulder points a little more; below the chest nothing moves.
 */
import { bandWeight, domeWeight, gaussianWeight, ramp, rotationField, type AvatarMetrics, type Ellipse, type Field } from '../fields.js';
import type { AvatarSpec } from '../types.js';
import type { AvatarFeature } from './types.js';

export const BODY_TUNING = {
  /** The chest dome reaches this far beyond the chest ellipse (in ellipse radii). */
  chestReach: 1.25,
  /** Share of the breath that everything above the chest rises by. */
  upperShare: 1 / 3,
  /** Extra rise of the shoulder points (share of the breath) and their sigma in chest radii. */
  shoulderShare: 0.25,
  shoulderSigma: 0.45,
  /** Sideways growth of the chest (share of the breath at the flank of the dome). */
  widen: 0.5,
} as const;

/** The sway field at `degrees` (clockwise: the upper body leans toward the screen right). */
export function bodySwayField(spec: AvatarSpec, degrees: number): Field {
  const geometry = bodyGeometry(spec);
  return rotationField(geometry.pivot, degrees, bandWeight(geometry.fade));
}

export function bodyGeometry(spec: AvatarSpec): {pivot:[number,number];fade:[number,number]} {
  if(spec.framing!=='full'||!spec.legs)return {pivot:spec.body.pivot,fade:spec.body.fade};
  const legs=spec.legs, feet:[number,number]=[(legs.feet[0][0]+legs.feet[1][0])/2,(legs.feet[0][1]+legs.feet[1][1])/2];
  return {pivot:legs.seated?legs.hips:feet,fade:legs.seated?[legs.hips[1]-Math.max(2,spec.image.height*0.05),legs.hips[1]]:[legs.hips[1],Math.min(...legs.feet.map(p=>p[1]))-2]};
}
export function bodyBounceField(spec: AvatarSpec, pixels:number):Field {
  const weight=bandWeight(bodyGeometry(spec).fade);
  return (x,y)=>[0,pixels*weight(x,y)];
}

/** The breath field at Breath = 1. */
export function breathField(spec: AvatarSpec, metrics: AvatarMetrics): Field {
  const T = BODY_TUNING;
  const { center, radius } = spec.body.chest;
  const reach: Ellipse = { center, radius: [radius[0] * T.chestReach, radius[1] * T.chestReach] };
  const chest = domeWeight(reach, 2);
  const anchored = bandWeight(bodyGeometry(spec).fade);
  const shoulders = (spec.body.shoulders ?? []).map((p) => gaussianWeight(p, T.shoulderSigma * radius[0]));
  const lift = metrics.breath;
  return (x, y) => {
    const c = chest(x, y);
    // 1 above the chest centre, fading to 0 at the lower rim of the dome and at the anchored bottom.
    const upper = (1 - ramp(center[1], center[1] + reach.radius[1], y)) * anchored(x, y);
    let rise = T.upperShare * upper + (1 - T.upperShare) * c;
    for (const s of shoulders) rise += T.shoulderShare * s(x, y) * upper;
    const widen = T.widen * c * ((x - center[0]) / reach.radius[0]);
    return [lift * widen, -lift * rise];
  };
}

export const body: AvatarFeature = {
  id: 'body',
  summary: 'body sway (BodyAngleX) and breathing (Breath) on the root lattice',

  compile(ctx) {
    const { spec, metrics, model, root } = ctx;
    const sway = model.parameter('BodyAngleX');
    const breath = model.parameter('Breath');

    const swayKeys = model.bindField(root, {
      id: 'bodySway',
      params: [sway],
      keys: [{ at: [-10], field: bodySwayField(spec, -metrics.sway) }, { at: [0] }, { at: [10], field: bodySwayField(spec, metrics.sway) }],
      description: `Body sway: ${Math.round(metrics.sway * 10) / 10} degrees about the body pivot at BodyAngleX = 10, fading out over the body fade band.`,
    });
    ctx.report.stat('swayPoints', Math.max(...swayKeys.map((v) => Object.keys(v).length)));

    const breathKeys = model.bindField(root, {
      id: 'breath',
      params: [breath],
      keys: [{ at: [0] }, { at: [1], field: breathField(spec, metrics) }],
      description: 'Breathing: the chest rises and widens, shoulders and head follow by a third.',
    });
    ctx.report.stat('breathPoints', Math.max(...breathKeys.map((v) => Object.keys(v).length)));
    if(spec.framing==='full'&&spec.legs){
      const bounce=model.parameter('BodyY'),lean=model.parameter('BodyAngleZ');
      model.bindField(root,{id:'bodyBounce',params:[bounce],keys:[{at:[-8],field:bodyBounceField(spec,-8)},{at:[0]},{at:[8],field:bodyBounceField(spec,8)}]});
      model.bindField(root,{id:'bodyLean',params:[lean],keys:[-15,-7.5,0,7.5,15].map(v=>({at:[v],...(v?{field:bodySwayField(spec,v)}:{})}))});
    }
  },
};
