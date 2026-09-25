/**
 * Model validation: structural (zod) + semantic checks, reported as Diagnostics with JSON pointers,
 * stable codes and actionable hints. Validation is how AI authors learn what they got wrong, so
 * every diagnostic names the exact location and, where possible, the fix.
 *
 *   parseModelText(text)  JSONC text -> 'json-syntax' error, or validateModel(value)
 *   validateModel(value)  structural diagnostics ('schema-*'); if none, semantic diagnostics
 *   formatDiagnostics()   one line per diagnostic + "N errors, M warnings"
 *
 * Implementation lives in ./validate/.
 */
import type { Diagnostic, Model } from './types.js';
import { ModelSchema } from './schema.js';
import { parseJsonc } from './validate/jsonc.js';
import { semanticDiagnostics } from './validate/semantic.js';
import { structuralDiagnostics } from './validate/structural.js';

export { formatDiagnostics } from './validate/format.js';
export { parseJsonc, type JsoncResult } from './validate/jsonc.js';

export interface ValidationResult {
  /** Normalized model (defaults filled) when there are no errors; null otherwise. */
  model: Model | null;
  diagnostics: Diagnostic[];
}

/** Validate an already-parsed JSON value. Semantic checks run only when the structure is valid. */
export function validateModel(input: unknown): ValidationResult {
  const parsed = ModelSchema.safeParse(input);
  if (!parsed.success) return { model: null, diagnostics: structuralDiagnostics(parsed.error.issues, input) };
  const diagnostics = semanticDiagnostics(parsed.data);
  return { model: diagnostics.some((d) => d.severity === 'error') ? null : parsed.data, diagnostics };
}

/**
 * Parse model text (BOM, comments and trailing commas allowed) then validate. Syntax errors are
 * reported as a single 'json-syntax' diagnostic with line/column and a caret excerpt.
 */
export function parseModelText(text: string): ValidationResult {
  const parsed = parseJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!parsed.ok) return { model: null, diagnostics: [parsed.error] };
  const result = validateModel(parsed.value);
  return { model: result.model, diagnostics: [...parsed.warnings, ...result.diagnostics] };
}
