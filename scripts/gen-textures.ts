/**
 * Write the procedural example textures (painters in scripts/examples/textures.ts, registered in
 * scripts/examples/index.ts) as PNG files next to their models. Deterministic: identical bytes on
 * every run.
 *
 *   npx tsx scripts/gen-textures.ts            # all examples with textures
 *   npx tsx scripts/gen-textures.ts textured   # selected ones
 *
 * Run it before scripts/build-examples.ts on a fresh checkout (models are validated with their textures).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXAMPLES_DIR } from '../src/api/templates.js';
import { encodePNG } from '../src/render/index.js';
import { TEXTURES } from './examples/index.js';

function main(): number {
  const names = process.argv.slice(2);
  const unknown = names.filter((n) => !TEXTURES[n]);
  if (unknown.length) {
    console.error(`error: no textures for example(s) ${unknown.map((n) => `"${n}"`).join(', ')}`);
    console.error(`hint: examples with textures: ${Object.keys(TEXTURES).join(', ')}`);
    return 2;
  }
  for (const name of names.length ? names : Object.keys(TEXTURES)) {
    const dir = path.join(EXAMPLES_DIR, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, paint] of Object.entries(TEXTURES[name])) {
      const image = paint();
      const out = path.join(dir, file);
      writeFileSync(out, encodePNG(image));
      console.log(`${path.relative(process.cwd(), out)}  ${image.width}x${image.height}`);
    }
  }
  return 0;
}

process.exitCode = main();
