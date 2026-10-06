/** Appearance preference (light / dark / follow the system) and sheet drag physics. Pure. */

export type Appearance = 'auto' | 'light' | 'dark';

export const APPEARANCES: readonly Appearance[] = ['auto', 'light', 'dark'];

export function parseAppearance(value: unknown, fallback: Appearance = 'auto'): Appearance {
  return value === 'light' || value === 'dark' || value === 'auto' ? value : fallback;
}

/** What is actually shown for a preference. */
export function resolveAppearance(preference: Appearance, systemDark: boolean): 'light' | 'dark' {
  return preference === 'auto' ? (systemDark ? 'dark' : 'light') : preference;
}

/** Auto -> Light -> Dark -> Auto (a single "appearance" button cycles through them). */
export function nextAppearance(current: Appearance): Appearance {
  return APPEARANCES[(APPEARANCES.indexOf(current) + 1) % APPEARANCES.length]!;
}

/**
 * Rubber band: resistance when something is dragged past its limit. `overshoot` px beyond the limit
 * of a surface of size `dimension` move it by the returned distance (always less, levelling off).
 */
export function rubberBand(overshoot: number, dimension: number, stiffness = 0.55): number {
  if (!(dimension > 0)) return 0;
  const sign = Math.sign(overshoot);
  const x = Math.abs(overshoot);
  return sign * (1 - 1 / ((x * stiffness) / dimension + 1)) * dimension;
}

export interface SheetDrag {
  /** Downward travel in px (negative = dragged up). */
  distance: number;
  /** Downward speed at release, px per ms. */
  velocity: number;
  /** Height of the sheet. */
  height: number;
}

/**
 * Where a dragged sheet goes on release: dismissed after a third of its height (at most 180 px), or
 * on a quick downward flick; otherwise it springs back.
 */
export function sheetDragOutcome(drag: SheetDrag): 'dismiss' | 'stay' {
  if (drag.distance <= 0) return 'stay';
  const threshold = Math.min(180, drag.height / 3);
  if (drag.distance >= threshold) return 'dismiss';
  if (drag.velocity > 0.6 && drag.distance > 24) return 'dismiss';
  return 'stay';
}

/** Translation of a sheet during a drag: follows the finger down, resists being pulled up. */
export function sheetDragOffset(distance: number, height: number): number {
  return distance >= 0 ? distance : rubberBand(distance, height, 0.2);
}
