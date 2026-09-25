/**
 * Diagnostic plumbing shared by the validation passes: JSON pointers, safe value lookup and a
 * collector with severity helpers.
 */
import type { Diagnostic, Severity } from '../types.js';

/** RFC 6901 JSON pointer, e.g. ["parts", 3, "shape"] -> "/parts/3/shape". The root is "". */
export function toPointer(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) out += '/' + String(seg).replace(/~/g, '~0').replace(/\//g, '~1');
  return out;
}

/** Own-property lookup along a path; undefined when any step is missing (never reads prototypes). */
export function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let value = root;
  for (const seg of path) value = ownValue(value, seg);
  return value;
}

export function ownValue(container: unknown, key: PropertyKey): unknown {
  if (container === null || typeof container !== 'object' || !Object.hasOwn(container, key)) return undefined;
  return (container as Record<PropertyKey, unknown>)[key];
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class DiagnosticSink {
  readonly items: Diagnostic[] = [];

  add(severity: Severity, code: string, path: readonly PropertyKey[] | string, message: string, hint?: string): void {
    const d: Diagnostic = { severity, code, message, path: typeof path === 'string' ? path : toPointer(path) };
    if (hint) d.hint = hint;
    this.items.push(d);
  }
  error(code: string, path: readonly PropertyKey[] | string, message: string, hint?: string): void {
    this.add('error', code, path, message, hint);
  }
  warning(code: string, path: readonly PropertyKey[] | string, message: string, hint?: string): void {
    this.add('warning', code, path, message, hint);
  }
  info(code: string, path: readonly PropertyKey[] | string, message: string, hint?: string): void {
    this.add('info', code, path, message, hint);
  }
}
