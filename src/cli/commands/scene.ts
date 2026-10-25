import type { Command } from '../command.js';
import { UsageError, type FlagSpec } from '../args.js';
import { CliError, stopSignal, type Ctx } from '../context.js';
import { SceneError, sceneDiagnostic } from '../../scene/schema.js';
import type { SceneOverlay } from '../../scene/render.js';

const str = (name: string, description: string, short?: string): FlagSpec => ({
  name,
  description,
  short,
  type: 'string',
});
const num = (name: string, description: string, min = 0): FlagSpec => ({
  name,
  description,
  type: 'number',
  min,
});
const output = str('out', 'new output path', 'o'),
  scale = num('scale', 'output pixels per scene unit (default 1)', 0.001);
function out(ctx: Ctx): string {
  const value = ctx.args.str('out');
  if (!value) throw new UsageError('--out is required');
  return ctx.resolve(value);
}
async function guarded(ctx: Ctx, run: () => Promise<{ data: unknown; ok?: boolean }>): Promise<number> {
  try {
    const r = await run();
    ctx.json ? ctx.printJson(r.data) : ctx.out(JSON.stringify(r.data, null, 2));
    return r.ok === false ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) throw e;
    const err = e as Error;
    throw new CliError(err.message, {
      diagnostics:
        e instanceof SceneError
          ? e.diagnostics
          : [
              sceneDiagnostic(
                'scene-io',
                '',
                err.message,
                'check file paths, output collisions and permissions',
              ),
            ],
      hint: e instanceof SceneError ? e.diagnostics[0]?.hint : undefined,
    });
  }
}
const command = (
  name: string,
  flags: FlagSpec[],
  summary: string,
  run: (ctx: Ctx) => Promise<{ data: unknown; ok?: boolean }>,
): Command => ({
  name: 'scene ' + name,
  group: 'check',
  summary,
  usage: `scene ${name} <scene.json> [--json]`,
  args: ['<scene.json>'],
  flags,
  json: true,
  description: [
    summary + '. Read docs/SCENE.md for scene coordinates, library placement, camera and narration cues.',
  ],
  examples: [],
  run: (ctx) => guarded(ctx, () => run(ctx)),
});
const io = () => import('../../node/scene.js');
const load = async (ctx: Ctx) => (await io()).loadScene(ctx.resolve(ctx.args.positionals[0]));
export const SCENE_COMMANDS: Command[] = [
  command(
    'new',
    [
      str('library', 'library directory'),
      str('background', 'background library id'),
      str('size', 'width x height, e.g. 1920x1080'),
    ],
    'create a scene document',
    async (ctx) => {
      const size = /^(\d+)x(\d+)$/.exec(ctx.args.str('size') ?? '1920x1080');
      if (!size) throw new UsageError('--size must be WIDTHxHEIGHT');
      const width = Number(size[1]),
        height = Number(size[2]);
      if (Math.min(width, height) < 2 || Math.max(width, height) > 3840 || width * height > 3840 * 2160)
        throw new UsageError('--size exceeds the supported scene dimensions');
      return {
        data: await (
          await io()
        ).newScene(ctx.resolve(ctx.args.positionals[0]), {
          width,
          height,
          library: ctx.args.str('library') ? ctx.resolve(ctx.args.str('library')!) : undefined,
          background: ctx.args.str('background'),
        }),
      };
    },
  ),
  command('validate', [], 'validate scene files, assets, poses, cues and animation targets', async (ctx) => {
    const loaded = await load(ctx),
      ok = Boolean(loaded.prepared);
    return { data: { ok, diagnostics: loaded.diagnostics }, ok };
  }),
  command('info', [], 'describe scene layers, timing and resolved narration cues', async (ctx) => ({
    data: (await io()).sceneInfo(await load(ctx)),
  })),
  command(
    'frame',
    [output, scale, num('time', 'scene time in seconds'), str('overlay', 'camera,bounds,safe,anchors')],
    'render one scene frame',
    async (ctx) => {
      const overlay = ctx.args.str('overlay')?.split(',') ?? [];
      if (overlay.some((s) => !['camera', 'bounds', 'safe', 'anchors'].includes(s)))
        throw new UsageError('unknown scene overlay');
      return {
        data: await (
          await io()
        ).writeSceneFrame(await load(ctx), out(ctx), ctx.args.num('time') ?? 0, {
          scale: ctx.args.num('scale'),
          overlay: overlay as SceneOverlay[],
        }),
      };
    },
  ),
  command(
    'sheet',
    [
      output,
      scale,
      num('frames', 'number of samples (default 12)', 1),
      str('times', 'comma-separated sample times'),
    ],
    'render a scene contact sheet',
    async (ctx) => {
      const times = ctx.args.str('times')?.split(',').map(Number);
      if (times?.some((t) => !Number.isFinite(t) || t < 0))
        throw new UsageError('--times requires nonnegative seconds');
      return {
        data: await (
          await io()
        ).writeSceneSheet(await load(ctx), out(ctx), {
          scale: ctx.args.num('scale'),
          frames: ctx.args.num('frames'),
          times,
        }),
      };
    },
  ),
  command(
    'analyze',
    [],
    'sample camera reveals, offscreen layers, overlaps and model motion',
    async (ctx) => ({ data: (await io()).analyzeLoadedScene(await load(ctx)) }),
  ),
  command(
    'render',
    [
      output,
      scale,
      num('from', 'first scene time'),
      num('to', 'exclusive end scene time'),
      num('crf', 'H.264 quality in 0..51 (default 18)'),
      str('format', 'mp4, gif or png sequence'),
      { name: 'audio', type: 'boolean', description: 'include narration when present (default true)' },
    ],
    'stream a scene to MP4, GIF or a PNG sequence',
    async (ctx) => {
      const format = ctx.args.str('format');
      if (format && !['mp4', 'gif', 'png'].includes(format))
        throw new UsageError('--format must be mp4, gif or png');
      const loaded = await load(ctx);
      (await io()).requireScene(loaded);
      const { renderScene } = await import('../../node/video.js');
      const stop = stopSignal(ctx.io);
      let last = -Infinity;
      try {
        const data = await renderScene(loaded, out(ctx), {
          format: format as 'mp4' | 'gif' | 'png' | undefined,
          scale: ctx.args.num('scale'),
          from: ctx.args.num('from'),
          to: ctx.args.num('to'),
          crf: ctx.args.num('crf'),
          audio: ctx.args.bool('audio'),
          signal: stop.signal,
          progress: (p) => {
            const now = performance.now();
            if (p.frame === p.frames || now - last > 1000) {
              ctx.io.stderr.write(
                `frame ${p.frame}/${p.frames} ${p.percent.toFixed(1)}% ${p.fps.toFixed(1)} fps ETA ${p.remaining.toFixed(1)}s\n`,
              );
              last = now;
            }
          },
        });
        return { data };
      } finally {
        stop.dispose();
      }
    },
  ),
];
export const SCENE_PARENT = {
  summary: 'compose, validate, inspect and render layered scenes',
  subcommands: SCENE_COMMANDS,
};
