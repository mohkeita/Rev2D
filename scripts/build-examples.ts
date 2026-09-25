/**
 * Generate the example models in examples/<name>/<name>.r2d.json from their builders (registered in
 * scripts/examples/index.ts). Each model is validated in memory first and written only when it has no
 * diagnostics at all (examples are reference material: no errors and no warnings), so a broken builder
 * never overwrites a shipped example. Exit code 1 when any example was not written.
 *
 *   npx tsx scripts/build-examples.ts            # all examples
 *   npx tsx scripts/build-examples.ts hana slime # selected ones
 *
 * Textures come from scripts/gen-textures.ts (run it first on a fresh checkout).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatModelJson } from '../src/core/format.js';
import { formatDiagnostics } from '../src/core/validate.js';
import { loadModelObject } from '../src/node/load.js';
import { EXAMPLES_DIR } from '../src/api/templates.js';
import { BUILDERS } from './examples/index.js';

async function main(): Promise<number> {
  const names = process.argv.slice(2);
  const unknown = names.filter((n) => !BUILDERS[n]);
  if (unknown.length) {
    console.error(`error: unknown example(s) ${unknown.map((n) => `"${n}"`).join(', ')}`);
    console.error(`hint: available: ${Object.keys(BUILDERS).join(', ')}`);
    return 2;
  }
  let failed = 0;
  for (const name of names.length ? names : Object.keys(BUILDERS)) {
    const dir = path.join(EXAMPLES_DIR, name);
    const file = path.join(dir, `${name}.r2d.json`);
    const shown = path.relative(process.cwd(), file);
    // Round-trip through the canonical text so the validated document is exactly what gets written.
    const text = formatModelJson(BUILDERS[name]());
    const loaded = await loadModelObject(JSON.parse(text), dir, file);
    if (loaded.diagnostics.length || !loaded.rig) {
      failed++;
      console.error(`${shown}: NOT written (${loaded.diagnostics.length} diagnostic(s); examples must have none)`);
      console.error(formatDiagnostics(loaded.diagnostics));
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
    console.log(`${shown}: written (0 diagnostics)`);
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
