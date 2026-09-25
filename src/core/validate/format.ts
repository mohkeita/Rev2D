/** Human/agent-readable rendering of diagnostics, one line each plus a summary line. */
import type { Diagnostic } from '../types.js';

/** Column widths stop growing here so one very long path does not push every line right. */
const MAX_PATH_WIDTH = 32;
const MAX_CODE_WIDTH = 28;
const SEVERITY_WIDTH = 8;
const INDENT = ' '.repeat(SEVERITY_WIDTH);

function displayPath(path: string): string {
  return path === '' ? '(root)' : path;
}

/**
 * e.g.
 *   error   /parts/3/parent  unknown-bone  unknown bone "hed"  → did you mean "head"?
 *   1 error, 0 warnings
 * Multi-line hints (such as JSON syntax excerpts) are printed indented below their diagnostic.
 */
export function formatDiagnostics(diags: readonly Diagnostic[]): string {
  const pathWidth = Math.min(MAX_PATH_WIDTH, Math.max(0, ...diags.map((d) => displayPath(d.path).length)));
  const codeWidth = Math.min(MAX_CODE_WIDTH, Math.max(0, ...diags.map((d) => d.code.length)));
  const lines = diags.map((d) => {
    const head = `${d.severity.padEnd(SEVERITY_WIDTH)}${displayPath(d.path).padEnd(pathWidth)}  ${d.code.padEnd(codeWidth)}  ${d.message}`;
    if (!d.hint) return head;
    const hint = d.hint.split('\n');
    return hint.length === 1 ? `${head}  → ${d.hint}` : [head, ...hint.map((l) => INDENT + l)].join('\n');
  });
  lines.push(summarize(diags));
  return lines.join('\n');
}

function summarize(diags: readonly Diagnostic[]): string {
  const count = (s: Diagnostic['severity']) => diags.filter((d) => d.severity === s).length;
  const errors = count('error');
  const warnings = count('warning');
  const infos = count('info');
  const parts = [`${errors} error${errors === 1 ? '' : 's'}`, `${warnings} warning${warnings === 1 ? '' : 's'}`];
  if (infos) parts.push(`${infos} info`);
  return parts.join(', ');
}
