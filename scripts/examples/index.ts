/**
 * Registry of the example model builders and texture painters. The shipped files in examples/ are
 * exactly their output (test/examples.test.ts checks it), so change an example here and regenerate:
 *
 *   npx tsx scripts/gen-textures.ts     # examples/<name>/*.png from TEXTURES
 *   npx tsx scripts/build-examples.ts   # examples/<name>/<name>.r2d.json from BUILDERS
 */
import type { ImageRGBA } from '../../src/core/types.js';
import type { Doc } from './common.js';
import { buildHana } from './hana.js';
import { buildMinimal } from './minimal.js';
import { buildRobotArm } from './robot-arm.js';
import { buildSlime } from './slime.js';
import { buildTextured } from './textured.js';
import { koiAtlas, pinwheel } from './textures.js';

/** Example name -> model document (written to examples/<name>/<name>.r2d.json). */
export const BUILDERS: Record<string, () => Doc> = {
  minimal: buildMinimal,
  hana: buildHana,
  'robot-arm': buildRobotArm,
  slime: buildSlime,
  textured: buildTextured,
};

/** Example name -> texture file name (relative to the example folder) -> painter. */
export const TEXTURES: Record<string, Record<string, () => ImageRGBA>> = {
  textured: { 'koi-atlas.png': koiAtlas, 'pinwheel.png': pinwheel },
};
