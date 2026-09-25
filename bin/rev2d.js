#!/usr/bin/env node
// rev2d CLI launcher.
//
//   dev checkout (src/cli/main.ts exists and tsx resolves)  run the TypeScript sources through tsx,
//                                                           so edits apply without a rebuild even
//                                                           when a stale dist/ exists
//   installed package (or no tsx)                            run the compiled dist/cli/main.js
//
// REV2D_RUNTIME=dist forces the compiled CLI (e.g. to try a fresh build in a checkout);
// REV2D_RUNTIME=source forces the sources (an error when they cannot run).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = new URL('src/cli/main.ts', root);
const compiled = new URL('dist/cli/main.js', root);
const tsconfig = new URL('tsconfig.json', root);
const runtime = process.env.REV2D_RUNTIME ?? '';

function fail(message, hint) {
  process.stderr.write(`error: ${message}\n${hint ? `hint: ${hint}\n` : ''}`);
  process.exit(1);
}

if (runtime !== '' && runtime !== 'dist' && runtime !== 'source') {
  fail(`REV2D_RUNTIME must be "dist" or "source", got "${runtime}"`, 'unset it to pick automatically');
}

/** tsx's ESM loader API, or null when tsx is not installed where this package can resolve it. */
async function loadTsx() {
  try {
    return await import('tsx/esm/api');
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
}

const hasSource = existsSync(fileURLToPath(source));
const hasCompiled = existsSync(fileURLToPath(compiled));
const tsx = runtime !== 'dist' && hasSource ? await loadTsx() : null;

let cli;
if (tsx) {
  tsx.register(existsSync(fileURLToPath(tsconfig)) ? { tsconfig: fileURLToPath(tsconfig) } : {});
  cli = await import(source.href);
} else if (runtime === 'source') {
  fail(
    hasSource ? 'REV2D_RUNTIME=source, but tsx is not installed' : `REV2D_RUNTIME=source, but ${fileURLToPath(source)} does not exist`,
    hasSource ? 'run "npm install" in the rev2d checkout' : 'the sources are only in a git checkout; unset REV2D_RUNTIME to use the compiled CLI',
  );
} else if (hasCompiled) {
  cli = await import(compiled.href);
} else if (runtime === 'dist') {
  fail(`REV2D_RUNTIME=dist, but ${fileURLToPath(compiled)} is not built`, 'run "npm run build" in the rev2d checkout');
} else if (hasSource) {
  fail(
    'rev2d cannot start: tsx is not installed to run the TypeScript sources, and dist/cli/main.js is not built',
    'in the rev2d checkout run "npm install" (installs tsx), or "npm run build"',
  );
} else {
  fail(`rev2d is incomplete: ${fileURLToPath(compiled)} is missing`, 'reinstall the package (npm install rev2d)');
}

await cli.runCli(process.argv.slice(2));
