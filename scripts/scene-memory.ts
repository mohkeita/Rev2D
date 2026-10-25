/** Reproducible streaming-memory probe. A full-resolution simple scene, not user artwork. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadScene } from '../src/node/scene.js';
import { renderScene } from '../src/node/video.js';
const root = path.resolve(process.argv[2] ?? 'out/demo-phase1/memory');
const frames = Number(process.argv[3] ?? 2000);
if (!Number.isInteger(frames) || frames < 1) throw new Error('frame count must be positive');
await mkdir(root);
const file = path.join(root, 'scene.json');
await writeFile(
  file,
  JSON.stringify({
    version: 1,
    width: 1920,
    height: 1080,
    fps: 24,
    duration: frames / 24,
    background: '#384c68',
    layers: [],
  }),
);
const rendered = await renderScene(await loadScene(file), path.join(root, 'stream.mp4'), {
  progress: (p) => {
    if (p.frame % 100 === 0 || p.frame === p.frames)
      process.stderr.write(
        `frame ${p.frame}/${p.frames} ${p.percent.toFixed(1)}% ${p.fps.toFixed(1)} fps ETA ${p.remaining.toFixed(1)}s\n`,
      );
  },
});
const result = {
  ...rendered,
  processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
  limitBytes: 500 * 1024 * 1024,
};
await writeFile(path.join(root, 'memory.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
if (result.processMaxRssBytes > result.limitBytes) process.exitCode = 1;
