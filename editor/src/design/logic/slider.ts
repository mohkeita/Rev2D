/**
 * Slider value math: value <-> position, keyboard steps, the filled part of the track, tick marks.
 * Pure (the component in components/Slider.tsx does the DOM work).
 */
import { clamp, snapToStep, stepNumber } from './number.js';

export interface SliderRange {
  min: number;
  max: number;
  step?: number;
}

/** Position of a value along the track, 0 (min) .. 1 (max). */
export function valueToRatio(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

/** Value at a track position (0..1), snapped to the step grid. */
export function ratioToValue(ratio: number, range: SliderRange): number {
  const r = clamp(ratio, 0, 1);
  return snapToStep(range.min + r * (range.max - range.min), range);
}

/**
 * Track position under a pointer. The thumb never leaves the track, so its centre travels over
 * `trackWidth - thumbWidth`; `grabOffset` is where inside the thumb the drag started (px from its
 * centre), which keeps the thumb from jumping under the finger.
 */
export function pointerToRatio(clientX: number, trackLeft: number, trackWidth: number, thumbWidth: number, grabOffset = 0, rtl = false): number {
  const travel = trackWidth - thumbWidth;
  if (!(travel > 0)) return 0;
  const r = clamp((clientX - grabOffset - trackLeft - thumbWidth / 2) / travel, 0, 1);
  return rtl ? 1 - r : r;
}

export interface SliderKeyOptions {
  shiftKey?: boolean;
  /** Steps for PageUp / PageDown and for Shift + arrow. Default 10. */
  largeStep?: number;
  rtl?: boolean;
}

/**
 * The value after a key press, or null when the key does not belong to the slider. Arrows move one
 * step (ten with Shift), PageUp / PageDown ten steps, Home / End jump to the ends. Without a `step`
 * the range is divided into 100.
 */
export function sliderKeyValue(key: string, value: number, range: SliderRange, opts: SliderKeyOptions = {}): number | null {
  const step = range.step && range.step > 0 ? range.step : (range.max - range.min) / 100;
  const large = opts.largeStep ?? 10;
  const grid = { min: range.min, max: range.max, step };
  const forward = opts.rtl ? 'ArrowLeft' : 'ArrowRight';
  const backward = opts.rtl ? 'ArrowRight' : 'ArrowLeft';
  switch (key) {
    case forward:
    case 'ArrowUp':
      return stepNumber(value, 1, { ...grid, multiplier: opts.shiftKey ? large : 1 });
    case backward:
    case 'ArrowDown':
      return stepNumber(value, -1, { ...grid, multiplier: opts.shiftKey ? large : 1 });
    case 'PageUp':
      return stepNumber(value, 1, { ...grid, multiplier: large });
    case 'PageDown':
      return stepNumber(value, -1, { ...grid, multiplier: large });
    case 'Home':
      return range.min;
    case 'End':
      return range.max;
    default:
      return null;
  }
}

/**
 * The filled part of the track as two ratios. It starts at `origin` (a neutral value such as 0 in a
 * -30..30 range) or at the minimum, and ends at the value, whichever side that is.
 */
export function fillSegment(value: number, range: SliderRange, origin?: number): { start: number; end: number } {
  const v = valueToRatio(value, range.min, range.max);
  const o = origin === undefined ? 0 : valueToRatio(origin, range.min, range.max);
  return { start: Math.min(o, v), end: Math.max(o, v) };
}

/**
 * Tick positions as ratios. `ticks` is a list of values, a count of evenly spaced marks (ends
 * included, at least 2), or `true` for one mark per step (capped at 41 marks: more is noise).
 */
export function tickRatios(ticks: readonly number[] | number | boolean | undefined, range: SliderRange): number[] {
  if (!ticks || !(range.max > range.min)) return [];
  if (Array.isArray(ticks)) {
    return ticks.filter((t) => t >= range.min && t <= range.max).map((t) => valueToRatio(t, range.min, range.max));
  }
  let count: number;
  if (ticks === true) {
    if (!range.step || !(range.step > 0)) return [];
    count = Math.round((range.max - range.min) / range.step) + 1;
    if (count > 41) return [];
  } else {
    count = Math.floor(ticks as number);
  }
  if (count < 2) return [];
  return Array.from({ length: count }, (_, i) => i / (count - 1));
}
