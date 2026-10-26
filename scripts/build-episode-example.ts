import path from 'node:path';
import { buildEpisodeExample } from './examples/episode-demo.js';
await buildEpisodeExample(path.resolve(process.argv[2] ?? 'examples/episodes/demo'));
