/**
 * Number math shared by Slider, Stepper and NumberField: clamping, step grids without floating
 * point noise, parsing what people type and formatting what they see. Pure.
 */

export interface NumberRange {
  min?: number;
  max?: number;
  /** Grid of allowed values, anchored at `min` (at 0 when there is no finite min). */
  step?: number;
}

export function clamp(value: number, min = -Infinity, max = Infinity): number {
  if (Number.isNaN(value)) return Number.isFinite(min) ? min : 0;
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** Number of decimals needed to write `step` exactly (0.25 -> 2, 1e-3 -> 3, 5 -> 0), at most 10. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step === 0) return 0;
  const text = String(Math.abs(step));
  const exp = /e-(\d+)$/.exec(text);
  if (exp) {
    const mantissa = text.slice(0, text.indexOf('e'));
    const dot = mantissa.indexOf('.');
    return Math.min(10, Number(exp[1]) + (dot < 0 ? 0 : mantissa.length - dot - 1));
  }
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(10, text.length - dot - 1);
}

export function roundTo(value: number, decimals: number): number {
  const d = Math.min(10, Math.max(0, Math.round(decimals)));
  const f = 10 ** d;
  const r = Math.round((value + Number.EPSILON * Math.sign(value)) * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** Nearest value on the step grid inside the range. Without a step: just clamped. */
export function snapToStep(value: number, range: NumberRange = {}): number {
  const { min = -Infinity, max = Infinity, step } = range;
  const v = clamp(value, min, max);
  if (!step || !(step > 0) || !Number.isFinite(v)) return v;
  const origin = Number.isFinite(min) ? min : 0;
  const decimals = Math.max(decimalsOf(step), decimalsOf(origin));
  let snapped = roundTo(origin + Math.round((v - origin) / step) * step, decimals);
  // The last grid point may lie beyond max (range 0..1, step 0.3): stay on the grid, inside the range.
  if (snapped > max) snapped = roundTo(snapped - step, decimals);
  if (snapped < min) snapped = min;
  return snapped;
}

export interface StepOptions extends NumberRange {
  /** Steps per press: 10 with Shift, 0.1 with Alt (finer than the grid: the result is not snapped). */
  multiplier?: number;
}

/** One press of an arrow key or a stepper button. */
export function stepNumber(value: number, direction: 1 | -1, opts: StepOptions = {}): number {
  const { min = -Infinity, max = Infinity, step = 1, multiplier = 1 } = opts;
  const amount = step * multiplier;
  const decimals = Math.max(decimalsOf(step), decimalsOf(amount), decimalsOf(Number.isFinite(min) ? min : 0));
  const start = Number.isFinite(value) ? value : clamp(0, min, max);
  const raw = start + direction * amount;
  if (multiplier >= 1) {
    // Land on the grid: from 0.37 with step 0.25, "up" goes to 0.5, not to 0.62.
    const origin = Number.isFinite(min) ? min : 0;
    const cells = (start - origin) / step;
    const onGrid = Math.abs(cells - Math.round(cells)) < 1e-9;
    if (!onGrid) {
      const next = direction > 0 ? Math.ceil(cells) : Math.floor(cells);
      const extra = (multiplier - 1) * direction;
      return clamp(roundTo(origin + (next + extra) * step, decimals), min, max);
    }
  }
  return clamp(roundTo(raw, decimals), min, max);
}

/**
 * What a person typed -> a number, or null when it is not one. Accepts a decimal comma ("1,5"), a
 * leading plus, the typographic minus, thousands spaces, and a trailing unit ("30°", "12 px", "50%").
 */
export function parseNumberInput(text: string): number | null {
  let t = text.trim().replace(/[−‒–]/g, '-').replace(/[\s  ]+/g, '');
  t = t.replace(/(°|%|px|pt|ms|s|x|deg|fps)$/i, '');
  if (t === '') return null;
  if (/^[+-]?\d*,\d+$/.test(t)) t = t.replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export interface FormatOptions {
  /** Decimals to round to. Default: the decimals of `step`, else 3. */
  precision?: number;
  step?: number;
  /** Keep trailing zeros ("1.50"): for columns of numbers that should not jitter. */
  padded?: boolean;
}

export function formatNumber(value: number, opts: FormatOptions = {}): string {
  if (!Number.isFinite(value)) return '';
  const precision = opts.precision ?? (opts.step ? decimalsOf(opts.step) : 3);
  const r = roundTo(value, precision);
  if (opts.padded) return r.toFixed(Math.min(10, Math.max(0, precision)));
  return String(r);
}

/** The value a number field takes when its text is committed (Enter, blur). */
export function commitNumberInput(text: string, previous: number, opts: NumberRange & { precision?: number } = {}): number {
  const parsed = parseNumberInput(text);
  if (parsed === null) return previous;
  const precision = opts.precision ?? (opts.step ? Math.max(decimalsOf(opts.step), 3) : 6);
  return clamp(roundTo(parsed, precision), opts.min, opts.max);
}
