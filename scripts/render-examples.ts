/**
 * Render every example model into out/examples/<name>/ for visual review:
 *   frame.png           default pose
 *   overlay.png         default pose with bones + warp lattices
 *   sweep-<Param>.png   one sheet per parameter (physics off so the value shows as set)
 *   grid-<A>-<B>.png    2D sweeps for parameters that are designed together (e.g. AngleX x AngleY)
 *   anim-<id>.png/.gif  contact sheet and full-rate GIF per animation (physics on)
 *   layers-<name>.png   contact sheets of the layer stacks examples/README.md suggests (a once wink, an add talk)
 *
 *   npx tsx scripts/render-examples.ts                     # all examples, all outputs
 *   npx tsx scripts/render-examples.ts hana --only frame,grids --scale 0.75
 *
 * Flags: --only <list> (frame, overlay, sweeps, grids, anims, gifs, layers), --scale <n> (sheet scale; frames
 * render at twice it; default 0.5 for canvases over 400 px, else 1), --out <dir> (default out/examples).
 * Exit codes: 0 ok, 1 a model has errors, 2 usage error.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadModelFile } from '../src/node/load.js';
import { formatDiagnostics } from '../src/core/validate.js';
import { EXAMPLES_DIR, listTemplates, PACKAGE_ROOT } from '../src/api/templates.js';
import { parseSweep, renderFrame, renderSequence, renderSheet } from '../src/api/index.js';
import { encodeGIF, encodePNG } from '../src/render/index.js';

/** 2D sweeps worth looking at per example: [columns spec, rows spec]. */
const GRIDS: Record<string, Array<[string, string]>> = {
  hana: [
    ['AngleX=-30:30:5', 'AngleY=-30:30:3'],
    ['MouthForm=-1:1:3', 'MouthOpen=0:1:3'],
    ['EyeBallX=-1:1:3', 'EyeBallY=-1:1:3'],
  ],
  slime: [['Squash=-1:1:5', 'Lean=-1:1:3']],
  'robot-arm': [['ReachX=-1:1:5', 'ReachY=-1:1:3']],
};

/** Layer stacks worth looking at per example: the first animation is sampled, the rest are layers. */
const LAYERS: Record<string, Array<{ name: string; animations: string[]; times: number[]; viewBox?: [number, number, number, number] }>> = {
  hana: [
    { name: 'idle+wink', animations: ['idle', 'wink,once,start=1'], times: [0.9, 1.05, 1.2, 1.4, 1.6, 1.8, 2], viewBox: [130, 120, 252, 260] },
    { name: 'look_around+talk', animations: ['look_around', 'talk,add'], times: [0, 0.75, 1.5, 2.25, 3, 3.75, 4.5, 5.25] },
  ],
  slime: [{ name: 'idle+blink', animations: ['idle', 'blink,once,start=0.5'], times: [0.45, 0.52, 0.56, 0.62, 0.7, 0.85], viewBox: [100, 170, 200, 170] }],
};

const ALL = ['frame', 'overlay', 'sweeps', 'grids', 'anims', 'gifs', 'layers'];

class UsageError extends Error {}

function parseCli(): { names: string[]; only: Set<string>; scale: number | null; outRoot: string } {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { only: { type: 'string' }, scale: { type: 'string' }, out: { type: 'string' } },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values, positionals } = parsed;
  const only = new Set(values.only ? values.only.split(',').map((s) => s.trim()) : ALL);
  const badOnly = [...only].filter((o) => !ALL.includes(o));
  if (badOnly.length) throw new UsageError(`--only: unknown output(s) ${badOnly.join(', ')} (use ${ALL.join(', ')})`);
  let scale: number | null = null;
  if (values.scale !== undefined) {
    scale = Number(values.scale);
    if (!Number.isFinite(scale) || scale <= 0) throw new UsageError(`--scale: expected a positive number, got "${values.scale}"`);
  }
  const available = listTemplates().filter((t) => t !== 'blank');
  const badNames = positionals.filter((n) => !available.includes(n));
  if (badNames.length) throw new UsageError(`unknown example(s) ${badNames.join(', ')} (available: ${available.join(', ')})`);
  return {
    names: positionals.length ? positionals : available,
    only,
    scale,
    outRoot: path.resolve(values.out ?? path.join(PACKAGE_ROOT, 'out', 'examples')),
  };
}

async function main(): Promise<number> {
  let cli;
  try {
    cli = parseCli();
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`error: ${e.message}`);
    console.error('usage: npx tsx scripts/render-examples.ts [example...] [--only list] [--scale n] [--out dir]');
    return 2;
  }
  const { names, only, outRoot } = cli;

  for (const name of names) {
    const m = await loadModelFile(path.join(EXAMPLES_DIR, name, `${name}.r2d.json`));
    if (!m.model || !m.rig) {
      console.error(`${name}: model has errors\n${formatDiagnostics(m.diagnostics)}`);
      return 1;
    }
    const model = m.model;
    const dir = path.join(outRoot, name);
    mkdirSync(dir, { recursive: true });
    const scale = cli.scale ?? (Math.max(model.meta.width, model.meta.height) > 400 ? 0.5 : 1);
    const write = (file: string, bytes: Uint8Array) => {
      writeFileSync(path.join(dir, file), bytes);
      console.log(`  ${path.relative(PACKAGE_ROOT, path.join(dir, file))}`);
    };
    console.log(name);
    const t0 = performance.now();

    if (only.has('frame')) write('frame.png', encodePNG(renderFrame(m, { scale: scale * 2 }).image));
    if (only.has('overlay')) write('overlay.png', encodePNG(renderFrame(m, { scale: scale * 2, overlay: ['bones', 'warps'] }).image));
    const physicsOutputs = new Set(model.physics.flatMap((g) => g.outputs.map((o) => o.param)));
    if (only.has('sweeps')) {
      for (const p of model.parameters) {
        const sheet = renderSheet(m, { sweeps: [parseSweep(model, p.id)], scale, physics: false });
        write(`sweep-${p.id}${physicsOutputs.has(p.id) ? '-physics-off' : ''}.png`, encodePNG(sheet));
      }
    }
    if (only.has('grids')) {
      for (const [a, b] of GRIDS[name] ?? []) {
        const sweeps = [parseSweep(model, a), parseSweep(model, b)];
        write(`grid-${sweeps[0].param}-${sweeps[1].param}.png`, encodePNG(renderSheet(m, { sweeps, scale, physics: false })));
      }
    }
    if (only.has('layers')) {
      for (const l of LAYERS[name] ?? []) {
        const [animation, ...layers] = l.animations;
        const sheet = renderSheet(m, { animation, animations: layers, times: l.times, columns: l.times.length, viewBox: l.viewBox, scale: l.viewBox ? scale * 2 : scale });
        write(`layers-${l.name}.png`, encodePNG(sheet));
      }
    }
    for (const a of model.animations) {
      if (only.has('anims')) write(`anim-${a.id}.png`, encodePNG(renderSheet(m, { animation: a.id, frames: 8, scale })));
      if (only.has('gifs')) {
        const { frames } = renderSequence(m, { animation: a.id, scale });
        write(`anim-${a.id}.gif`, encodeGIF(frames.map((f) => f.image), { fps: model.meta.fps, loop: true }));
      }
    }
    console.log(`  (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  }
  return 0;
}

process.exitCode = await main();
