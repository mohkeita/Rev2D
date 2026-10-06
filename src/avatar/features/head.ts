/**
 * Feature "head": the pseudo-3D head turn (AngleX x AngleY) and the head tilt (AngleZ), both as
 * bindings on the root lattice. No layers: the head stays part of the one continuous base mesh
 * (DESIGN.md §3 explains why a separate head layer would ghost).
 *
 * TURN. Two domes add up, each (1 - r^2)^e over an ellipse (r = normalised radius, zero value AND
 * zero slope at the rim):
 *   - the face dome over the face oval: the features slide, the face outline stays, so the side the
 *     head turns to compresses and the other side stretches. Downward the dome reaches beyond the
 *     oval (HEAD_TUNING.chinReach): mouth and chin are at the FRONT of the head and travel with the
 *     nose, so the lower face keeps its shape and the neck takes the shear instead;
 *   - the head dome over the whole head ellipse: the hair volume follows, less and less toward the
 *     silhouette, which does not move at all.
 * A small Gaussian bump lets the nose tip lead (it sticks out of the face), the peak of the face
 * dome trails toward the near side (so the far half of the face shortens more than the near half
 * widens, as on a turning sphere), and everything is multiplied by the neck band so the body
 * below the collarbone stays still. The sum is scaled so that the face centre moves exactly
 * head.turn.x / .y px. The field is exactly zero outside the head ellipse.
 *
 * TILT. A rotation about head.pivot whose ANGLE is weighted (fields.ts rotationField), by the neck
 * band times a fan around the pivot (fields.ts fanWeight): full for everything above the pivot,
 * fading to nothing toward the level of the pivot. A weight by direction bends like a joint: the
 * strain does not grow with the distance from the pivot, so hair and shoulders far out at neck
 * height are neither squashed nor lifted.
 */
import {
  bandWeight,
  clamp01,
  domeWeight,
  ellipseLevel,
  fanWeight,
  gaussianWeight,
  multiplyWeights,
  ramp,
  rotationField,
  type AvatarMetrics,
  type Field,
  type FieldKey,
  type Weight,
} from '../fields.js';
import type { AvatarSpec } from '../types.js';
import type { AvatarFeature } from './types.js';

/** The shape of the head motion. Tuned on the two evaluation illustrations (see the task report). */
export const HEAD_TUNING = {
  /** Share of the turn carried by the face dome; the rest is the dome over the whole head. */
  faceShareX: 0.6,
  /** For pitch the whole head (chin included) carries more, or the features would slide over a fixed chin. */
  faceShareY: 0.5,
  /** Dome exponents e in (1 - r^2)^e: 2 has zero slope at the rim and a round top. */
  faceExponent: 1.5,
  headExponent: 2,
  /**
   * Below its centre the face dome reaches this many face radii: the chin is at the front of the head,
   * not at its rim, so mouth and chin travel with the nose (the neck band ends the motion below).
   */
  chinReach: 1.4,
  /**
   * The peak of the face dome sits this many face radii toward the NEAR side (the half that turns
   * toward the viewer), as on a turning sphere: the far half of the face compresses more than the
   * near half stretches.
   */
  lead: 0.1,
  /** Extra travel of the nose tip, as a share of the turn, and the bump's sigma in face radii. */
  nose: 0.14,
  noseSigma: 0.2,
  /** Yaw and pitch at once move this much less than their sum (a sphere does the same). */
  diagonal: 0.1,
  /** The face dome and the nose bump are faded out between these head-ellipse levels. */
  rimStart: 0.75,
  /** Tilt fan: full weight up to this many degrees from straight up, none from `fanZero` on. */
  fanFull: 55,
  fanZero: 95,
  /** Add keyforms at AngleZ = +/-15 when the chord of a 3-key tilt misses the arc by more than this share of the long image side. */
  arcError: 0.004,
} as const;

/**
 * The head weight of the tilt: 1 on the head, 0 on the body, smooth in between (the neck band along
 * the neck, a fan of directions around the pivot beside it).
 */
export function headTiltWeight(spec: AvatarSpec): Weight {
  return multiplyWeights(fanWeight(spec.head.pivot, HEAD_TUNING.fanFull, HEAD_TUNING.fanZero), bandWeight(spec.head.neck));
}

/** The tilt field at `degrees` (clockwise). */
export function headTiltField(spec: AvatarSpec, degrees: number): Field {
  return rotationField(spec.head.pivot, degrees, headTiltWeight(spec));
}

/**
 * The turn field at AngleX = 30 s, AngleY = 30 t (s, t in -1..1). s > 0 moves the face toward the
 * screen right, t > 0 up (smaller y).
 */
export function headTurnField(spec: AvatarSpec, metrics: AvatarMetrics, s: number, t: number): Field {
  const T = HEAD_TUNING;
  const { head, face } = metrics;
  /** The face dome with its peak moved by (du, dv) face radii. */
  const faceDome = (x: number, y: number, du: number, dv: number): number => {
    const u = (x - face.center[0]) / face.radius[0] - du;
    const below = (y - face.center[1]) / face.radius[1] - dv;
    const v = below > 0 ? below / T.chinReach : below;
    const d = 1 - u * u - v * v;
    return d <= 0 ? 0 : Math.pow(d, T.faceExponent);
  };
  const headDome = domeWeight(head, T.headExponent);
  const nose = gaussianWeight(spec.face.nose, T.noseSigma * face.radius[0]);
  const neck = bandWeight(spec.head.neck);

  /** The unscaled profile at a point: [x share, y share] for a turn in direction (sx, sy). */
  const profile = (x: number, y: number, sx: number, sy: number): [number, number] => {
    const h = headDome(x, y);
    if (h === 0) return [0, 0];
    const band = neck(x, y);
    if (band === 0) return [0, 0];
    const inside = 1 - ramp(T.rimStart, 1, ellipseLevel(head, x, y));
    const n = nose(x, y) * T.nose;
    // The half of the face that leads the motion turns away from the viewer: the peak trails it.
    const px = T.faceShareX * faceDome(x, y, -T.lead * sx, 0) * inside + (1 - T.faceShareX) * h + n * inside;
    const py = T.faceShareY * faceDome(x, y, 0, -T.lead * sy) * inside + (1 - T.faceShareY) * h + n * inside;
    return [px * band, py * band];
  };

  const sx = Math.sign(s);
  const sy = Math.sign(-t);
  // Scale so that the face centre moves exactly turn.x / turn.y px.
  const centre = profile(face.center[0], face.center[1], sx, sy);
  const kx = centre[0] > 1e-6 ? (s * metrics.turn.x * (1 - T.diagonal * Math.abs(t))) / centre[0] : 0;
  // AngleY > 0 looks up: canvas y decreases.
  const ky = centre[1] > 1e-6 ? (-t * metrics.turn.y * (1 - T.diagonal * Math.abs(s))) / centre[1] : 0;
  return (x, y) => {
    const p = profile(x, y, sx, sy);
    // "+ 0" turns a negative zero into a plain one.
    return [kx * p[0] + 0, ky * p[1] + 0];
  };
}

/** Number of tilt keyforms per side: 1 (at +/-30), or 2 (+/-15 too) when the arc is long. */
function tiltSteps(spec: AvatarSpec, metrics: AvatarMetrics): number {
  const top = Math.max(0, spec.head.center[1] - spec.head.radius[1]);
  const reach = Math.max(0, spec.head.pivot[1] - top);
  const half = (metrics.tilt * Math.PI) / 360;
  return reach * (1 - Math.cos(half)) > HEAD_TUNING.arcError * metrics.long ? 2 : 1;
}

const moved = (values: Array<Record<string, unknown>>) => values.reduce((n, v) => Math.max(n, Object.keys(v).length), 0);

export const head: AvatarFeature = {
  id: 'head',
  summary: 'head turn (AngleX x AngleY, pseudo-3D dome) and head tilt (AngleZ) on the root lattice',

  compile(ctx) {
    const { spec, metrics, model, root } = ctx;
    const ax = model.parameter('AngleX');
    const ay = model.parameter('AngleY');
    const az = model.parameter('AngleZ');

    const keys: FieldKey[] = [];
    for (const t of [-1, 0, 1]) {
      for (const s of [-1, 0, 1]) keys.push({ at: [s * 30, t * 30], field: s === 0 && t === 0 ? undefined : headTurnField(spec, metrics, s, t) });
    }
    const turn = model.bindField(root, {
      id: 'headTurn',
      params: [ax, ay],
      keys,
      description: 'Pseudo-3D head turn: a dome over the face oval plus a wider dome over the whole head; zero outside the head ellipse.',
    });
    ctx.report.stat('turnPoints', moved(turn));

    const steps = tiltSteps(spec, metrics);
    const tiltKeys: FieldKey[] = [];
    for (let k = -steps; k <= steps; k++) {
      tiltKeys.push({ at: [(k * 30) / steps], field: k === 0 ? undefined : headTiltField(spec, (metrics.tilt * k) / steps) });
    }
    const tilt = model.bindField(root, {
      id: 'headTilt',
      params: [az],
      keys: tiltKeys,
      description: `Head tilt: ${round(metrics.tilt)} degrees about the neck pivot at AngleZ = 30, the angle weighted by the neck band and a fan around the pivot.`,
    });
    ctx.report.stat('tiltPoints', moved(tilt));

    const [pivotX, pivotY] = spec.head.pivot;
    if (pivotY > spec.head.neck[1]) {
      // Below the band the band alone ends the rotation, far from the pivot: that shears instead of bending.
      ctx.report.warning('avatar-pivot-below-neck', `head.pivot (${round(pivotX)}, ${round(pivotY)}) lies below the neck band, which ends at y = ${round(spec.head.neck[1])}: the tilt will shear the neck`, {
        path: '/head/pivot',
        hint: 'the pivot is the centre of the neck, between the two rows of head.neck: move it up, or end the band lower',
      });
    }
    const chin = spec.face.chin;
    const chinWeight = clamp01(headTiltWeight(spec)(chin[0], chin[1]));
    if (chinWeight < 0.9) {
      ctx.report.warning('avatar-chin-weight', `the chin (${round(chin[0])}, ${round(chin[1])}) gets only ${Math.round(chinWeight * 100)}% of the head tilt: the jaw will bend`, {
        path: '/head/pivot',
        hint: 'put head.pivot on the neck BELOW the chin (centre of the neck, above the collarbone) and start head.neck just below the chin',
      });
    }
  },
};

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
