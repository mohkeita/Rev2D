/** Shared acting-file operation for the CLI and MCP. No render or network side effects. */
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseModelText, parseJsonc, validateModel } from '../core/validate.js';
import { formatModelJson } from '../core/format.js';
import { generateGesture, generateExpression, ActingError, type ActingOptions } from '../gestures/index.js';
export async function applyActing(
  file: string,
  kind: 'gesture' | 'expression',
  name: string,
  options: ActingOptions & { dryRun?: boolean } = {},
) {
  file = path.resolve(file);
  const original = await readFile(file, 'utf8'),
    parsed = parseModelText(original);
  if (!parsed.model) throw new ActingError(parsed.diagnostics);
  const result = (kind === 'gesture' ? generateGesture : generateExpression)(parsed.model, name, options);
  const raw = parseJsonc(original);
  if (!raw.ok) throw new ActingError([raw.error]);
  const source = raw.value as Record<string, unknown>;
  const previous = (source.animations ?? []) as { id: string }[];
  const doc = {
    ...source,
    animations: [...previous.filter((a) => a.id !== result.animation.id), result.animation],
  };
  const validated = validateModel(doc),
    diagnostics = [...result.diagnostics, ...validated.diagnostics];
  const ok = !diagnostics.some((d) => d.severity === 'error'),
    text = formatModelJson(doc),
    changed = formatModelJson(source) !== text;
  let written = false;
  if (ok && changed && !options.dryRun) {
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { flag: 'wx' });
      if ((await readFile(file, 'utf8')) !== original)
        throw new Error('the model changed during generation; retry against the current file');
      await rename(temporary, file);
      written = true;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  return {
    ok,
    file,
    written,
    changed,
    dryRun: options.dryRun ?? false,
    animation: result.animation,
    diagnostics,
  };
}
