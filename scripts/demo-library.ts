/** Original-art phase-0 demo. Re-run into a NEW directory; never replaces user sources. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FIGURE_POSES } from './examples/figure.js';
import { figureFixture, figureAvatarDoc, roomFixture } from '../test/fixtures/studio.js';
import {
  initLibrary,
  importLibraryImage,
  rigLibraryPose,
  librarySheet,
  validateLibrary,
  readLibrary,
} from '../src/node/library.js';
import { reviewAvatarProject } from '../src/node/avatar.js';
import { keyImage } from '../src/library/key.js';
import { encodePNG } from '../src/render/png.js';
import { formatModelJson } from '../src/core/format.js';

const root = path.resolve(process.argv[2] ?? 'out/demo-phase0/synthetic');
await mkdir(root, { recursive: true });
const library = path.join(root, 'library');
await initLibrary(library, 'synthetic-studio');
const sources = path.join(root, 'sources');
await mkdir(sources);
const metrics = [];
const room = roomFixture();
await writeFile(path.join(sources, 'room.png'), encodePNG(room.image));
await importLibraryImage(path.join(sources, 'room.png'), library, { kind: 'background', id: 'room' });
for (const pose of FIGURE_POSES) {
  for (const [name, bg] of [
    ['green', '#00ff00'],
    ['white', '#ffffff'],
    ['transparent', undefined],
  ] as const) {
    const { image, mask } = figureFixture(pose, bg);
    await writeFile(path.join(sources, `${pose}-${name}.png`), encodePNG(image));
    if (bg) {
      const cut = keyImage(image, { trim: false });
      let intersection = 0,
        union = 0,
        green = 0,
        subject = 0;
      for (let i = 0; i < mask.length; i++) {
        const a = mask[i] > 127,
          b = cut.image.data[i * 4 + 3] > 127;
        if (a && b) intersection++;
        if (a || b) union++;
        if (b) {
          subject++;
          if (cut.image.data[i * 4 + 1] > Math.max(cut.image.data[i * 4], cut.image.data[i * 4 + 2]) + 30) green++;
        }
      }
      metrics.push({ pose, background: name, iou: intersection / union, greenShare: green / subject });
      await writeFile(path.join(sources, `${pose}-${name}-keyed.png`), encodePNG(cut.image));
    }
  }
  const imported = await importLibraryImage(path.join(sources, `${pose}-green.png`), library, {
    kind: 'character',
    character: 'figure',
    pose,
    trim: false,
    tags: pose.split('_'),
    description: 'Original synthetic fixture: round glasses, blue jacket, white face and gloves.',
  });
  await writeFile(path.join(imported.directory, 'avatar.json'), formatModelJson(figureAvatarDoc('figure_' + pose)));
  const built = await rigLibraryPose(library, 'figure', pose);
  console.error(`${pose}: ${built.folds.length} fold findings`);
  await reviewAvatarProject(imported.directory, { scale: 0.25 });
}
const manifest = await readLibrary(library);
manifest.backgrounds[0].anchors = {
  sofa_left: { at: [180, 355], scale: 1, pose_tags: ['sitting'] },
  center: { at: [620, 480], scale: 1, pose_tags: ['standing'] },
};
await writeFile(path.join(library, 'library.json'), formatModelJson(manifest));
const sheet = await librarySheet(library);
await writeFile(path.join(root, 'library.png'), encodePNG(sheet.image));
const status = await validateLibrary(library);
await writeFile(path.join(root, 'validation.json'), formatModelJson(status));
await writeFile(path.join(root, 'key-metrics.json'), formatModelJson(metrics));
await writeFile(
  path.join(root, 'README.md'),
  '# Synthetic asset-library demo\n\nRegenerate into a new directory with `node --import tsx scripts/demo-library.ts <new-directory>`.\n\nContains original vector art, four authored face/avatar projects and one background. It does not demonstrate articulated arms or an episode. Inspect each character review/ folder. Key metrics compare independently rendered alpha masks.\n',
);
console.log(
  JSON.stringify({
    directory: root,
    validation: status,
    minimumIoU: Math.min(...metrics.map((m) => m.iou)),
    maximumGreenShare: Math.max(...metrics.map((m) => m.greenShare)),
  }),
);
if (!status.ok) process.exitCode = 1;
