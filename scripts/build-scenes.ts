/** Generate the shipped scene example from original synthetic artwork into a new directory. */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { buildSceneExample } from './examples/scene-assets.js';
const output = path.resolve(process.argv[2] ?? 'examples/scenes/room-demo');
await mkdir(path.dirname(output), { recursive: true });
await buildSceneExample(output);
console.log(JSON.stringify({ directory: output }));
