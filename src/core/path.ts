/**
 * SVG path tokenizer. Produces a PathValue whose numbers can be interpolated between paths with the
 * same command structure (template). Geometry (flattening to polylines) lives in geometry/.
 */
import type { PathValue } from './types.js';

const ARG_COUNT: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

export class PathSyntaxError extends Error {}

/** Parse SVG path data. Implicit repeated commands are expanded (e.g. "M0 0 10 10" -> M, L). */
export function parsePath(d: string): PathValue {
  const commands: string[] = [];
  const nums: number[] = [];
  const counts: number[] = [];
  let i = 0;
  const n = d.length;
  let cmd: string | null = null;

  const skipSep = () => {
    while (i < n && /[\s,]/.test(d[i])) i++;
  };
  const readNumber = (): number => {
    skipSep();
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(d.slice(i));
    if (!m) throw new PathSyntaxError(`expected number at offset ${i} in path "${d.slice(0, 60)}"`);
    i += m[0].length;
    const v = parseFloat(m[0]);
    if (!Number.isFinite(v)) throw new PathSyntaxError(`number "${m[0]}" is too large at offset ${i - m[0].length} (path numbers must be finite)`);
    return v;
  };
  const readFlag = (): number => {
    skipSep();
    const ch = d[i];
    if (ch !== '0' && ch !== '1') throw new PathSyntaxError(`expected arc flag 0/1 at offset ${i}`);
    i++;
    return ch === '1' ? 1 : 0;
  };

  while (true) {
    skipSep();
    if (i >= n) break;
    const ch = d[i];
    if (/[a-zA-Z]/.test(ch)) {
      if (!(ch.toUpperCase() in ARG_COUNT)) throw new PathSyntaxError(`unsupported path command "${ch}" at offset ${i}`);
      cmd = ch;
      i++;
    } else if (cmd === null) {
      throw new PathSyntaxError(`path must start with a command (M), got "${ch}"`);
    } else if (cmd === 'Z' || cmd === 'z') {
      throw new PathSyntaxError(`unexpected number after Z at offset ${i}`);
    } else if (cmd === 'M') {
      cmd = 'L';
    } else if (cmd === 'm') {
      cmd = 'l';
    }
    const upper = cmd.toUpperCase();
    const argc = ARG_COUNT[upper];
    commands.push(cmd);
    counts.push(argc);
    for (let k = 0; k < argc; k++) {
      if (upper === 'A' && (k === 3 || k === 4)) nums.push(readFlag());
      else nums.push(readNumber());
    }
  }
  if (commands.length === 0) throw new PathSyntaxError('empty path');
  if (commands[0].toUpperCase() !== 'M') throw new PathSyntaxError('path must start with M/m');
  return { template: commands.map((c, k) => c + counts[k]).join(' '), commands, nums };
}

export function tryParsePath(d: string): PathValue | null {
  try {
    return parsePath(d);
  } catch {
    return null;
  }
}

/** Serialize back to SVG path data (numbers rounded to 3 decimals). */
export function formatPath(p: PathValue): string {
  const out: string[] = [];
  let k = 0;
  for (const c of p.commands) {
    const argc = ARG_COUNT[c.toUpperCase()];
    const args = p.nums.slice(k, k + argc).map((v) => +v.toFixed(3));
    k += argc;
    out.push(argc ? `${c}${args.join(' ')}` : c);
  }
  return out.join(' ');
}

export function pathArgCount(command: string): number {
  return ARG_COUNT[command.toUpperCase()] ?? -1;
}
