/** ApiError and the message helpers shared by the src/api modules. */
import type { Diagnostic } from '../core/types.js';
import { suggest } from '../core/address.js';

/**
 * A rejected API call. `message` is one line saying what is wrong (except for model errors, where
 * the formatted diagnostics follow on the next lines); `hint`, when present, says how to fix it
 * (did-you-mean, accepted forms).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public diagnostics: Diagnostic[] = [],
    public hint?: string,
  ) {
    super(message);
  }
}

/** Did-you-mean for an id, else the list of valid ids. */
export function idHint(got: string, options: string[], noun: string): string {
  return suggest(got, options) ?? (options.length ? `available ${noun}: ${listIds(options)}` : `the model has no ${noun}`);
}

/** Comma list of ids, abbreviated after `max`. */
export function listIds(ids: string[], max = 40): string {
  return ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')}, ... (+${ids.length - max})`;
}

/** A JSON-ish rendering of a user value for messages ("abc" quoted, numbers as is). */
export function show(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Compact number for messages: at most `digits` decimals, no trailing zeros, no "-0". */
export function fmtNum(v: number, digits = 3): string {
  const r = Number(v.toFixed(digits));
  return Object.is(r, -0) ? '0' : String(r);
}

/** "3 of 8 frames" / "this frame" / "34% of frames" style share text. */
export function shareText(count: number, total: number): string {
  if (total <= 1) return 'this frame';
  if (count === total) return `all ${total} frames`;
  if (total <= 20) return `${count} of ${total} frames`;
  return `${count} of ${total} frames (${Math.round((count / total) * 100)}%)`;
}
