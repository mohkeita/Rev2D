import { it, expect } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadModelFile } from '../src/node/load.js';
import { analyzeAnimation } from '../src/api/analyze.js';
import { GESTURES, EXPRESSIONS } from '../src/gestures/index.js';
import { parseAvatarSpec, compileAvatar } from '../src/avatar/index.js';
import { findFolds } from '../src/avatar/folds.js';
import { PACKAGE_ROOT } from '../src/api/templates.js';
const root = path.join(PACKAGE_ROOT, 'examples/scenes/acting-demo/figure');
it('ships original full-body art whose complete acting catalogue validates and analyzes cleanly', async () => {
  const loaded = await loadModelFile(path.join(root, 'figure_full.r2d.json'));
  expect(loaded.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warning')).toEqual([]);
  const expected = [
    ...Object.keys(GESTURES),
    ...Object.keys(EXPRESSIONS).map((n) => 'expression_' + n),
    'idle_alive',
  ];
  expect(loaded.model!.animations.map((a) => a.id)).toEqual(expected);
  for (const animation of expected) {
    const analysis = analyzeAnimation(loaded, { animation, fps: 24, pixels: false, physics: false });
    expect(analysis.notes, animation).toEqual([]);
  }
}, 120000);
it('has no folds in the full rig with every imported glove and expression variant', async () => {
  const spec = parseAvatarSpec(JSON.parse(await readFile(path.join(root, 'avatar.json'), 'utf8'))).spec!,
    meta = JSON.parse(await readFile(path.join(root, 'textures/layers.json'), 'utf8'));
  const compiled = compileAvatar(spec, meta),
    model = (await loadModelFile(path.join(root, 'figure_full.r2d.json'))).model!;
  expect(findFolds(model, compiled.folds)).toEqual([]);
});
