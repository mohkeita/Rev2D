/**
 * Bound / animated SVG path values (`part:<id>.shape.d`). Keyform paths share one command template,
 * so their numbers interpolate element-wise; arc flags are the exception and must stay 0 or 1.
 */
import { pathArgCount } from '../path.js';
import type { PathValue } from '../types.js';

/** Snap interpolated arc flags (large-arc, sweep) to 0/1, switching halfway like booleans. */
export function snapArcFlags(p: PathValue): PathValue {
  let nums: number[] | null = null;
  let k = 0;
  for (const cmd of p.commands) {
    if (cmd === 'A' || cmd === 'a') {
      for (const f of [k + 3, k + 4]) {
        const v = p.nums[f];
        if (v !== 0 && v !== 1) (nums ??= p.nums.slice())[f] = v >= 0.5 ? 1 : 0;
      }
    }
    k += pathArgCount(cmd);
  }
  return nums ? { template: p.template, commands: p.commands, nums } : p;
}

/** SVG path data at full precision (formatPath rounds to 3 decimals, which is for display only). */
export function pathData(p: PathValue): string {
  let k = 0;
  return p.commands
    .map((cmd) => {
      const n = pathArgCount(cmd);
      const args = p.nums.slice(k, (k += n));
      return n ? `${cmd}${args.join(' ')}` : cmd;
    })
    .join(' ');
}
