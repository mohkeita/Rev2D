/**
 * Spring easing curves as CSS `linear()` functions.
 *
 * iOS motion is spring based: an animation is described by how long it takes to settle ("response",
 * here simply the duration of the CSS transition) and how much it overshoots ("bounce"). CSS has no
 * spring timing function, but `linear()` takes any sampled curve, so the design tokens ship a few
 * springs sampled from the closed-form step response of a damped harmonic oscillator. This module is
 * the generator (pure, deterministic); `test/editor-design.test.ts` checks that tokens.css carries
 * exactly what it produces.
 */

export interface SpringSpec {
  /**
   * Damping ratio: 1 = critically damped (no overshoot, "smooth"), below 1 overshoots and settles
   * ("snappy" 0.72, "bouncy" 0.6). Clamped to [0.2, 1].
   */
  damping: number;
  /** Number of line segments of the sampled curve (more = smoother). Default 24. */
  samples?: number;
  /** The curve is treated as settled when it stays within this distance of 1. Default 0.002. */
  epsilon?: number;
}

/** Step response of a unit spring (natural frequency 1) at time `t` for damping ratio `zeta`. */
export function springStep(t: number, zeta: number): number {
  if (t <= 0) return 0;
  if (zeta >= 1) return 1 - Math.exp(-t) * (1 + t);
  const wd = Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * t) * (Math.cos(wd * t) + (zeta / wd) * Math.sin(wd * t));
}

/** Time after which the unit spring stays within `epsilon` of its target. */
export function springSettleTime(zeta: number, epsilon = 0.002): number {
  const z = Math.min(1, Math.max(0.2, zeta));
  // Walk back from a generous horizon to the last sample still outside the band.
  const horizon = 40;
  const dt = 0.01;
  for (let t = horizon; t > 0; t -= dt) {
    if (Math.abs(springStep(t, z) - 1) > epsilon) return t + dt;
  }
  return dt;
}

/** Progress (0..1 and beyond when overshooting) of the spring at normalized time `x` in [0, 1]. */
export function springProgress(x: number, spec: SpringSpec): number {
  const z = Math.min(1, Math.max(0.2, spec.damping));
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return springStep(x * springSettleTime(z, spec.epsilon), z);
}

/** The spring as a CSS easing function: `linear(0, 0.0123, ..., 1)`. */
export function springLinearEasing(spec: SpringSpec): string {
  const n = Math.max(4, Math.round(spec.samples ?? 24));
  const points: string[] = [];
  for (let i = 0; i <= n; i++) {
    const v = i === 0 ? 0 : i === n ? 1 : springProgress(i / n, spec);
    points.push(formatNumber(v));
  }
  return `linear(${points.join(', ')})`;
}

function formatNumber(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/** The springs of the design system (token name -> spec). */
export const SPRINGS = {
  /** No overshoot: sheets, popovers, panels. */
  smooth: { damping: 1, samples: 20 },
  /** A hint of overshoot: buttons, knobs, segmented thumbs. */
  snappy: { damping: 0.72, samples: 24 },
  /** Visible bounce: playful confirmations, toasts. */
  bouncy: { damping: 0.6, samples: 32 },
} as const satisfies Record<string, SpringSpec>;

export type SpringName = keyof typeof SPRINGS;
