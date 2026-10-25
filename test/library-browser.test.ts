import { it, expect } from 'vitest';
import path from 'node:path';
import { build } from 'vite';
import { PACKAGE_ROOT } from '../src/api/templates.js';

it('bundles the whole pure library API for browsers without Node shims', async () => {
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: path.join(PACKAGE_ROOT, 'src/library/index.ts'), formats: ['es'] },
    },
  });
  const outputs = Array.isArray(built) ? built : [built];
  const chunks = outputs.flatMap((o) => ('output' in o ? o.output : [])).filter((o) => o.type === 'chunk');
  expect(chunks.length).toBeGreaterThan(0);
  const code = chunks.map((c) => c.code).join('\n');
  expect(code).not.toMatch(/__vite-browser-external|from\s*["']node:|require\(["']node:/);
  for (const name of ['LibrarySchema', 'keyImage', 'searchLibrary', 'generationRequest']) expect(code).toContain(name);
});
