import { it, expect } from 'vitest';
import path from 'node:path';
import { build } from 'vite';
import { PACKAGE_ROOT } from '../src/api/templates.js';
it('bundles the entire episode engine for browsers without Node or DOM shims', async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: path.join(PACKAGE_ROOT, 'src/episode/index.ts'), formats: ['es'] },
    },
  });
  const code = (Array.isArray(result) ? result : [result])
    .flatMap((r) => ('output' in r ? r.output : []))
    .filter((r) => r.type === 'chunk')
    .map((r) => r.code)
    .join('\n');
  expect(code).not.toMatch(/__vite-browser-external|from\s*["']node:|require\(["']node:/);
  for (const name of ['EpisodeSchema', 'resolveEpisode', 'compileShot', 'planAssets', 'coverCrop'])
    expect(code).toContain(name);
});
