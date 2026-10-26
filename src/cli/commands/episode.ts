import type { Command } from '../command.js';
import { UsageError, type FlagSpec } from '../args.js';
import { CliError, stopSignal, type Ctx } from '../context.js';
import { EpisodeError, episodeDiagnostic } from '../../episode/index.js';
const str = (name: string, description: string, short?: string): FlagSpec => ({
  name,
  description,
  short,
  type: 'string',
});
const outFlag = str('out', 'new output path', 'o'),
  onlyFlag = str('only', 'comma-separated shot ids');
const only = (ctx: Ctx) => ctx.args.str('only')?.split(',').filter(Boolean);
const out = (ctx: Ctx) => {
  const v = ctx.args.str('out');
  if (!v) throw new UsageError('--out is required');
  return ctx.resolve(v);
};
const input = (ctx: Ctx) => ctx.resolve(ctx.args.positionals[0]);
const io = () => import('../../node/episode.js');
const command = (
  name: string,
  flags: FlagSpec[],
  summary: string,
  run: (ctx: Ctx) => Promise<unknown>,
): Command => ({
  name: 'episode ' + name,
  group: 'check',
  summary,
  usage: `episode ${name} <path> [--json]`,
  args: ['<path>'],
  flags,
  json: true,
  description: [summary + '. Read docs/EPISODE.md for the tested storyboard workflow.'],
  examples: [],
  async run(ctx) {
    try {
      const value = await run(ctx);
      ctx.json ? ctx.printJson(value) : ctx.out(JSON.stringify(value, null, 2));
      return (value as { ok?: boolean }).ok === false ? 1 : 0;
    } catch (e) {
      if (e instanceof UsageError) throw e;
      throw new CliError((e as Error).message, {
        diagnostics:
          e instanceof EpisodeError
            ? e.diagnostics
            : [
                episodeDiagnostic(
                  'episode-io',
                  '',
                  (e as Error).message,
                  'check input files, encoder and output collisions',
                ),
              ],
        hint: e instanceof EpisodeError ? e.diagnostics[0]?.hint : undefined,
      });
    }
  },
});
export const EPISODE_COMMANDS: Command[] = [
  command('validate', [], 'validate storyboard timing, cues and scene assets', async (ctx) =>
    (await io()).validateEpisode(input(ctx)),
  ),
  command('plan', [outFlag], 'list missing assets and optionally write generation requests', async (ctx) =>
    (await io()).planEpisode(input(ctx), ctx.args.str('out') ? out(ctx) : undefined),
  ),
  command(
    'build',
    [
      outFlag,
      onlyFlag,
      { name: 'force', type: 'boolean', description: 'replace edited generated scenes explicitly' },
    ],
    'build complete scenes in a managed episode directory',
    async (ctx) =>
      (await io()).buildEpisode(input(ctx), out(ctx), { only: only(ctx), force: ctx.args.bool('force') }),
  ),
  command(
    'render',
    [
      onlyFlag,
      { name: 'jobs', type: 'int', min: 1, max: 16, description: 'isolated render processes (default 2)' },
      { name: 'force', type: 'boolean', description: 'bypass the shot cache' },
    ],
    'render shots using verified content hashes',
    async (ctx) => {
      const stop = stopSignal(ctx.io);
      let last = 0;
      try {
        return await (
          await import('../../node/episode-render.js')
        ).renderEpisode(input(ctx), {
          only: only(ctx),
          jobs: ctx.args.num('jobs'),
          force: ctx.args.bool('force'),
          signal: stop.signal,
          progress: (p) => {
            if (p.frame === p.frames || performance.now() - last > 1000) {
              ctx.io.stderr.write(
                `${p.completed}/${p.total} ${p.shot} ${p.frame}/${p.frames}${p.cached ? ' cached' : ''}\n`,
              );
              last = performance.now();
            }
          },
        });
      } finally {
        stop.dispose();
      }
    },
  ),
  command(
    'assemble',
    [outFlag, str('size', 'output width x height, e.g. 1080x1920')],
    'assemble transitions, narration and ducked music',
    async (ctx) => {
      let size: [number, number] | undefined;
      if (ctx.args.str('size')) {
        const m = /^(\d+)x(\d+)$/.exec(ctx.args.str('size')!);
        if (!m) throw new UsageError('--size must be WIDTHxHEIGHT');
        size = [Number(m[1]), Number(m[2])];
      }
      const stop = stopSignal(ctx.io);
      try {
        return await (
          await import('../../node/episode-assemble.js')
        ).assembleEpisode(input(ctx), out(ctx), { size, signal: stop.signal });
      } finally {
        stop.dispose();
      }
    },
  ),
  command('report', [outFlag], 'write contact sheets, analyze notes and HTML/Markdown index', async (ctx) =>
    (await import('../../node/episode-report.js')).reportEpisode(input(ctx), out(ctx)),
  ),
  command(
    'thumbnails',
    [outFlag, str('at', 'middle (default), start or end')],
    'write one thumbnail per shot',
    async (ctx) => {
      const at = ctx.args.str('at') ?? 'middle';
      if (!['middle', 'start', 'end'].includes(at)) throw new UsageError('--at must be middle, start or end');
      return (await import('../../node/episode-report.js')).episodeThumbnails(input(ctx), out(ctx), {
        at: at as 'middle' | 'start' | 'end',
      });
    },
  ),
];
export const EPISODE_PARENT = {
  summary: 'build, render, review and assemble an episode from a storyboard',
  subcommands: EPISODE_COMMANDS,
};
