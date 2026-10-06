/**
 * Sway physics of the avatar builder, shared by hair strands (./hair.ts) and attachments
 * (./attachments.ts): one Rev2D physics group (docs/SPEC.md §8) per swaying thing, a single pendulum
 * segment whose swing drives one parameter in -1..1.
 *
 * A group is described by what one can see, and this module turns that into the numbers of the
 * physics model:
 *
 *   frequency, damping ratio   how fast it swings and how soon it settles. The pendulum's natural
 *                              frequency is omega^2 = gravity / length + stiffness; the per-step
 *                              damping follows from the damping ratio.
 *   hang                       the share of omega^2 that is gravity. With a frame rotation (the head
 *                              tilts) a pendulum of pure gravity keeps hanging straight down, one of
 *                              pure stiffness tilts along rigidly; `hang` sets the mix.
 *   drives                     the parameters that shake it, each with the distance (px) the thing
 *                              travels per unit of the parameter: the pivot of the pendulum moves
 *                              sideways by that much, the weight lags behind and swings.
 *   peak                       how strongly it responds: the output for the REFERENCE MOTION, the
 *                              first drive moving by REFERENCE_SHARE of its range (from rest
 *                              toward its limit) in REFERENCE_TIME seconds with an eased start and
 *                              stop: a calm motion, as in an idle animation. (A pendulum lags in
 *                              proportion to the acceleration, so a gain set by a brisk turn would
 *                              leave an idle without any visible sway.) The response of this very
 *                              pendulum to that motion is simulated here and the input weights are
 *                              scaled to it, so quick short bangs and slow long locks both use
 *                              their range. Motions much brisker than the reference reach the
 *                              limit of the output for a moment (the swing is then at its largest).
 *
 * The pendulum stays in its linear range (its length is many times the largest lag), so the output
 * is proportional to the inputs up to the clamp.
 */
import type { PhysicsInput } from '../builder.js';

const HZ = 60;
const DEG = Math.PI / 180;

/** The reference motion: a drive moves by this share of its range (from rest toward its limit) in this many seconds (cosine ease). */
export const REFERENCE_SHARE = 1 / 3;
export const REFERENCE_TIME = 1;

export interface SwayDrive {
  /** The driving parameter. */
  param: string;
  /** Px the thing travels toward +x per unit of the parameter (signed). */
  travel: number;
  /** The parameter's largest distance from rest (30 for AngleX, 10 for BodyAngleX). */
  limit: number;
}

export interface SwayTilt {
  param: string;
  /** Degrees (clockwise) the frame of the thing rotates per unit of the parameter. */
  degrees: number;
}

export interface SwayOptions {
  /** Id of the physics group. */
  id: string;
  /** The parameter it writes (range -1..1). */
  output: string;
  /** "x": sideways offset of the weight in px; "angle": swing angle in degrees (clockwise +). */
  kind: 'x' | 'angle';
  /** The offset (px) or angle (degrees) that is 1 on the output; negative when the output counts the other way. */
  full: number;
  /** Pendulum length in px (the length of the lock, the distance from pivot to tip). */
  length: number;
  /** Natural frequency in Hz and damping ratio (0.1 = swings for a while, 1 = no overshoot). */
  frequency: number;
  dampingRatio: number;
  /** Share of the restoring force that is gravity, 0..1 (see the file header). */
  hang: number;
  /** What shakes it; the first drive is the reference, no other drive is allowed to be stronger. */
  drives: SwayDrive[];
  /** Frame rotations (need `hang` > 0 to show). */
  tilts?: SwayTilt[];
  /** Output for the reference motion (may exceed 1: then that motion clamps). */
  peak: number;
  description?: string;
}

/**
 * Largest lag of a damped oscillator (natural frequency `omega` rad/s, per-step velocity factor
 * `keep`) behind a pivot that moves by 1 in `seconds` with a cosine ease, as a share of that move.
 * Integrated exactly like the model's physics (Verlet at 60 Hz).
 */
export function referenceLag(omega: number, keep: number, seconds: number = REFERENCE_TIME): number {
  const dt2 = 1 / (HZ * HZ);
  const period = (2 * Math.PI) / Math.max(omega, 1e-6);
  const steps = Math.ceil((seconds + 1.5 * period) * HZ);
  let p = 0;
  let prev = 0;
  let worst = 0;
  for (let k = 1; k <= steps; k++) {
    const t = k / HZ;
    const u = t >= seconds ? 1 : (1 - Math.cos((Math.PI * t) / seconds)) / 2;
    const next = p + (p - prev) * keep - omega * omega * (p - u) * dt2;
    prev = p;
    p = next;
    worst = Math.max(worst, Math.abs(p - u));
  }
  return worst;
}

const round = (v: number, digits: number): number => {
  const k = 10 ** digits;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
};

/** The physics group of one swaying thing (see the file header). The parameters must be declared by the caller. */
export function swayPhysics(o: SwayOptions): PhysicsInput {
  const omega = 2 * Math.PI * o.frequency;
  const keep = Math.exp((-2 * o.dampingRatio * omega) / HZ);
  const hang = Math.min(1, Math.max(0, o.hang));
  const length = Math.max(1, o.length);
  const gravity = hang * omega * omega * length;
  const stiffness = (1 - hang) * omega * omega;

  // The lag (px) that gives `peak` on the output, and the pivot travel that produces it in the reference motion.
  const lagAtPeak = Math.abs(o.kind === 'x' ? o.peak * o.full : o.peak * o.full * DEG * length);
  const share = referenceLag(omega, keep);
  const reference = o.drives[0];
  const strongest = reference ? Math.abs(reference.travel) * reference.limit : 0;
  const gain = strongest > 1e-9 && share > 1e-9 ? lagAtPeak / (strongest * REFERENCE_SHARE * share) : 0;

  const inputs: PhysicsInput['inputs'] = [];
  for (const drive of o.drives) {
    // No drive may be stronger than the reference at its limit.
    const reach = Math.min(Math.abs(drive.travel) * drive.limit, strongest);
    const weight = round((Math.sign(drive.travel) * reach * gain) / drive.limit, 4);
    if (weight !== 0) inputs.push({ param: drive.param, type: 'x', weight });
  }
  for (const tilt of o.tilts ?? []) {
    const weight = round(tilt.degrees, 4);
    if (weight !== 0 && hang > 0) inputs.push({ param: tilt.param, type: 'angle', weight });
  }
  const group: PhysicsInput = {
    id: o.id,
    inputs,
    outputs: [{ param: o.output, type: o.kind, scale: round(1 / o.full, 5) }],
    segments: [{ length: round(length, 2), mass: 1 }],
    gravity: round(gravity, 2),
    damping: round(1 - keep, 4),
    stiffness: round(stiffness, 3),
  };
  if (o.description !== undefined) group.description = o.description;
  return group;
}
