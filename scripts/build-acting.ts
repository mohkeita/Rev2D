/** Original synthetic acting example. Always generates into a new output directory. */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildFigure } from './examples/figure.js';
import { fullFigureAvatarDoc } from './examples/figure-avatar.js';
import { actingDrawing } from './examples/acting-art.js';
import { parseAvatarSpec } from '../src/avatar/spec.js';
import { VARIANT_IDS } from '../src/avatar/types.js';
import { VARIANTS } from '../src/avatar/variants-areas.js';
import { validateModel } from '../src/core/validate.js';
import { Rig, buildRenderList } from '../src/core/rig.js';
import { formatModelJson } from '../src/core/format.js';
import { renderImage } from '../src/render/browser.js';
import { encodePNG } from '../src/render/png.js';
import { buildAvatarProject } from '../src/node/avatar.js';
import { importAvatarVariants } from '../src/node/avatar-variants.js';
import { loadModelFile } from '../src/node/load.js';
import {
  generateGesture,
  generateExpression,
  generateIdle,
  GESTURES,
  EXPRESSIONS,
} from '../src/gestures/index.js';
import { analyzeAnimation } from '../src/api/analyze.js';
import { renderSheet } from '../src/api/sheet.js';
const root = path.resolve(process.argv[2] ?? 'examples/scenes/acting-demo'),
  review = process.argv.includes('--review');
await mkdir(path.dirname(root), { recursive: true });
await mkdir(root);
const avatar = path.join(root, 'figure');
await mkdir(avatar);
await mkdir(path.join(avatar, 'variants'));
const figure = validateModel(buildFigure()).model!,
  rig = new Rig(figure),
  source = renderImage(buildRenderList(rig, rig.pose({ physics: false })), {}, { supersample: 1 });
const doc = fullFigureAvatarDoc(),
  spec = parseAvatarSpec(doc).spec!;
await writeFile(path.join(avatar, 'source.png'), encodePNG(source));
await writeFile(path.join(avatar, 'avatar.json'), formatModelJson(doc));
const built = await buildAvatarProject(avatar);
if (built.report.issues.some((i) => i.code === 'avatar-mesh-fold'))
  throw new Error(JSON.stringify(built.report.issues));
const ids = VARIANT_IDS.filter(
  (id) => VARIANTS[id].expression !== undefined || VARIANTS[id].handForm !== undefined || id === 'eyes_wide',
);
for (const id of ids)
  await writeFile(path.join(avatar, 'variants', id + '.png'), encodePNG(actingDrawing(source, spec, id)));
const imported = await importAvatarVariants(avatar);
if (imported.rejected.length) throw new Error(JSON.stringify(imported.checks.filter((c) => !c.ok)));
const file = path.join(avatar, 'figure_full.r2d.json'),
  loaded = await loadModelFile(file);
if (!loaded.model) throw new Error(JSON.stringify(loaded.diagnostics));
const model = loaded.model,
  animations = [
    ...Object.keys(GESTURES).map((n) => generateGesture(model, n).animation),
    ...Object.keys(EXPRESSIONS).map((n) => generateExpression(model, n).animation),
    generateIdle(model, 'figure:acting-demo').animation,
  ];
const animated = { ...model, animations };
await writeFile(file, formatModelJson(animated));
const ready = await loadModelFile(file),
  analyses = review
    ? animations.map((a) =>
        analyzeAnimation(ready, { animation: a.id, pixels: false, physics: false, fps: 24 }),
      )
    : [];
if (review) await writeFile(path.join(root, 'analysis.json'), JSON.stringify(analyses, null, 2));
if (review)
  for (const a of animations)
    await writeFile(
      path.join(root, a.id + '.png'),
      encodePNG(
        renderSheet(ready, {
          animation: a.id,
          frames: 6,
          columns: 3,
          scale: 0.55,
          physics: false,
          background: '#f4e7d5',
        }),
      ),
    );
const scene = {
  version: 1,
  id: 'acting-demo',
  width: 960,
  height: 540,
  fps: 24,
  duration: 12,
  background: '#f4e7d5',
  layers: [
    {
      id: 'hero',
      type: 'model',
      src: 'figure/figure_full.r2d.json',
      x: 470,
      y: 510,
      anchor: 'bottom-center',
      animations: [
        'idle_alive',
        { gesture: 'voila', t: 0.3, hold: 0.7 },
        { gesture: 'point_right', t: 3, hold: 0.7 },
        { gesture: 'scratch_head', t: 5.7, hold: 0.7 },
        { expression: 'shocked', t: 8.3, hold: 0.7 },
        { expression: 'thinking', t: 10, hold: 0.7 },
      ],
    },
  ],
};
await writeFile(path.join(root, 'scene.json'), formatModelJson(scene));
await writeFile(
  path.join(root, 'README.md'),
  '# Original synthetic acting example\n\nRegenerate into a new directory: `node --import tsx scripts/build-acting.ts out/new-acting-demo --review`.\nAll artwork is generated from the original vector figure, including the 21 acting drawings.\nWith `--review`, `analysis.json` records every gesture/expression and idle. PNGs sample their animations.\n',
);
console.log(
  JSON.stringify({
    directory: root,
    drawings: imported.accepted.length,
    animations: animations.length,
    notes: analyses.filter((a) => a.notes.length).map((a) => ({ id: a.animation, notes: a.notes })),
  }),
);
