/**
 * Hand-rolled argument parser for the rev2d CLI.
 *
 *   --flag value   --flag=value   -o value   -o=value   -ovalue
 *   --bool   --no-bool   --bool=true|false
 *   repeatable flags collect every occurrence in order
 *   `--` ends flag parsing; `-` and negative numbers ("-12", "-.5") are positional
 *
 * Every mistake is a UsageError (exit code 2) naming the flag and, when possible, the closest valid
 * spelling.
 */
import { suggest } from '../core/address.js';

export type FlagType = 'boolean' | 'string' | 'number' | 'int';

export interface FlagSpec {
  /** Long name without the leading "--". */
  name: string;
  /** Single-letter alias without the leading "-". */
  short?: string;
  type: FlagType;
  /** Collect every occurrence into an array (in command-line order). */
  repeat?: boolean;
  /** String flag whose value may be omitted ("--play" or "--play idle"); omitted = "". */
  optionalValue?: boolean;
  /** Value placeholder for help, e.g. "file.png". */
  arg?: string;
  description: string;
  /** Numeric bounds (inclusive) and exclusive lower bound, checked while parsing. */
  min?: number;
  max?: number;
  greaterThan?: number;
  /** Accepted by the parser but not listed in help (the command rejects it with a precise message). */
  hidden?: boolean;
}

export type FlagValue = string | number | boolean | Array<string | number>;

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, FlagValue>;
}

/** Wrong command-line usage: exit code 2. */
export class UsageError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

const NEGATIVE_NUMBER = /^-\.?\d/;
const BOOL_WORDS: Record<string, boolean> = { true: true, false: false, yes: true, no: false, '1': true, '0': false };

export function flagLabel(spec: FlagSpec): string {
  return `--${spec.name}`;
}

/** Parse argv against the flag specs of one command. */
export function parseArgs(argv: readonly string[], specs: readonly FlagSpec[]): ParsedArgs {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const byShort = new Map(specs.filter((s) => s.short).map((s) => [s.short!, s]));
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];

  const set = (spec: FlagSpec, value: string | number | boolean, token: string) => {
    if (spec.repeat) {
      const list = (flags[spec.name] as Array<string | number> | undefined) ?? [];
      list.push(value as string | number);
      flags[spec.name] = list;
      return;
    }
    if (spec.name in flags) {
      throw new UsageError(`${flagLabel(spec)} was given more than once (at "${token}")`, `${flagLabel(spec)} takes a single value; remove the duplicate`);
    }
    flags[spec.name] = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === '-' || !token.startsWith('-') || NEGATIVE_NUMBER.test(token)) {
      positionals.push(token);
      continue;
    }

    let spec: FlagSpec | undefined;
    let inline: string | undefined;
    let negated = false;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      inline = eq < 0 ? undefined : token.slice(eq + 1);
      spec = byName.get(name);
      if (!spec && name.startsWith('no-')) {
        const positive = byName.get(name.slice(3));
        if (positive?.type === 'boolean') {
          spec = positive;
          negated = true;
        }
      }
      if (!spec) throw unknownFlag(`--${name}`, specs);
    } else {
      const letter = token[1];
      spec = byShort.get(letter);
      if (!spec) throw unknownFlag(token.length === 2 ? token : `-${letter}`, specs);
      if (token.length > 2) inline = token[2] === '=' ? token.slice(3) : token.slice(2);
    }

    if (spec.type === 'boolean') {
      let value = !negated;
      if (inline !== undefined) {
        if (negated || !(inline.toLowerCase() in BOOL_WORDS)) {
          throw new UsageError(`${flagLabel(spec)} is a switch and does not take the value "${inline}"`, `use ${flagLabel(spec)} or --no-${spec.name}`);
        }
        value = BOOL_WORDS[inline.toLowerCase()];
      }
      set(spec, value, token);
      continue;
    }

    let raw = inline;
    if (raw === undefined) {
      const next = argv[i + 1];
      if (spec.optionalValue) {
        if (next !== undefined && !next.startsWith('-')) {
          raw = next;
          i++;
        } else {
          raw = '';
        }
      } else {
        if (next === undefined || looksLikeFlag(next)) {
          const dash = next === undefined ? '' : ` (a value that starts with "-" needs the = form: ${flagLabel(spec)}=${next})`;
          throw new UsageError(`${flagLabel(spec)} needs a value${spec.arg ? ` <${spec.arg}>` : ''}`, `e.g. ${flagLabel(spec)} ${exampleValue(spec)}${dash}`);
        }
        raw = next;
        i++;
      }
    }
    set(spec, convert(spec, raw), token);
  }
  return { positionals, flags };
}

/** A token that is a flag rather than a value: "--x..." or a single-letter "-x". */
function looksLikeFlag(token: string): boolean {
  return (token.startsWith('--') && token.length > 2) || /^-[A-Za-z]$/.test(token);
}

function exampleValue(spec: FlagSpec): string {
  if (spec.arg) return `<${spec.arg}>`;
  return spec.type === 'string' ? '<value>' : '<number>';
}

function unknownFlag(flag: string, specs: readonly FlagSpec[]): UsageError {
  const names = specs.flatMap((s) => [`--${s.name}`, ...(s.type === 'boolean' ? [`--no-${s.name}`] : []), ...(s.short ? [`-${s.short}`] : [])]);
  return new UsageError(`unknown flag "${flag}"`, suggest(flag, names) ?? undefined);
}

function convert(spec: FlagSpec, raw: string): string | number {
  if (spec.type === 'string') return raw;
  const value = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`${flagLabel(spec)} expects a number, got "${raw}"`, `e.g. ${flagLabel(spec)} ${exampleValue(spec)}`);
  if (spec.type === 'int' && !Number.isInteger(value)) throw new UsageError(`${flagLabel(spec)} expects a whole number, got "${raw}"`);
  if (spec.min !== undefined && value < spec.min) throw new UsageError(`${flagLabel(spec)} must be >= ${spec.min}, got ${raw}`);
  if (spec.max !== undefined && value > spec.max) throw new UsageError(`${flagLabel(spec)} must be <= ${spec.max}, got ${raw}`);
  if (spec.greaterThan !== undefined && !(value > spec.greaterThan)) throw new UsageError(`${flagLabel(spec)} must be > ${spec.greaterThan}, got ${raw}`);
  return value;
}

// ----------------------------------------------------------------------------- typed accessors

export class Args {
  constructor(readonly parsed: ParsedArgs) {}

  get positionals(): string[] {
    return this.parsed.positionals;
  }

  has(name: string): boolean {
    return name in this.parsed.flags;
  }

  str(name: string): string | undefined {
    const v = this.parsed.flags[name];
    return typeof v === 'string' ? v : undefined;
  }

  num(name: string): number | undefined {
    const v = this.parsed.flags[name];
    return typeof v === 'number' ? v : undefined;
  }

  bool(name: string): boolean | undefined {
    const v = this.parsed.flags[name];
    return typeof v === 'boolean' ? v : undefined;
  }

  list(name: string): string[] {
    const v = this.parsed.flags[name];
    if (Array.isArray(v)) return v.map(String);
    return v === undefined ? [] : [String(v)];
  }

  /** Repeatable comma-separated flag values flattened: --overlay a,b --overlay c -> [a, b, c]. */
  csv(name: string): string[] {
    return this.list(name)
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter(Boolean);
  }
}
