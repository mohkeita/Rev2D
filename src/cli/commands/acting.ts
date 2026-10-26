import type { Command } from '../command.js';
import { CliError } from '../context.js';
import { UsageError, type FlagSpec } from '../args.js';
import { GESTURES, EXPRESSIONS, type ActingOptions } from '../../gestures/index.js';
const numeric = (name: string, description: string): FlagSpec => ({ name, type: 'number', description });
export const ACTING_COMMANDS: Command[] = (['gesture', 'expression'] as const).flatMap((kind) => [
  {
    name: `${kind} list`,
    group: 'reference',
    summary: `list reusable ${kind}s`,
    usage: `${kind} list [--json]`,
    args: [],
    flags: [],
    json: true,
    examples: [`rev2d ${kind} list --json`],
    async run(ctx) {
      const catalog = kind === 'gesture' ? GESTURES : EXPRESSIONS;
      ctx.json
        ? ctx.printJson(catalog)
        : ctx.out(
            Object.entries(catalog)
              .map(([n, d]) => `${n}: ${d}`)
              .join('\n'),
          );
      return 0;
    },
  },
  {
    name: `${kind} apply`,
    group: 'edit',
    summary: `add a reusable ${kind} animation to a model`,
    usage: `${kind} apply <model> --${kind} <name> [--id name] [--t seconds] [--duration seconds] [--intensity 0..1] [--side R|L|both] [--hold seconds] [--release seconds] [--dry-run] [--json]`,
    args: ['<model>'],
    flags: [
      { name: kind, type: 'string', description: `${kind} name from list` },
      { name: 'id', type: 'string', description: 'animation id (replaces the same id)' },
      ...['t', 'duration', 'intensity', 'hold', 'release'].map((n) =>
        numeric(n, n === 'intensity' ? 'intensity in 0..1' : n + ' in seconds'),
      ),
      ...(kind === 'gesture'
        ? ([
            { name: 'side', type: 'string', description: 'R, L or both' },
            {
              name: 'count',
              type: 'int',
              min: 1,
              max: 3,
              description: 'finger count (requires a corresponding drawing)',
            },
          ] as FlagSpec[])
        : []),
      { name: 'dry-run', type: 'boolean', description: 'return the generated animation without writing' },
    ],
    json: true,
    examples: [
      `rev2d ${kind} apply hero.r2d.json --${kind} ${kind === 'gesture' ? 'voila' : 'surprised'} --dry-run --json`,
    ],
    async run(ctx) {
      const name = ctx.args.str(kind);
      if (!name) throw new UsageError(`--${kind} is required`, `use ${kind} list`);
      const side = ctx.args.str('side');
      if (side && !['R', 'L', 'both'].includes(side)) throw new UsageError('--side must be R, L or both');
      const options: ActingOptions & { dryRun: boolean } = {
        id: ctx.args.str('id'),
        t: ctx.args.num('t'),
        duration: ctx.args.num('duration'),
        intensity: ctx.args.num('intensity'),
        hold: ctx.args.num('hold'),
        release: ctx.args.num('release'),
        side: side as ActingOptions['side'],
        count: ctx.args.num('count') as ActingOptions['count'],
        dryRun: ctx.args.bool('dry-run') ?? false,
      };
      try {
        const { applyActing } = await import('../../node/acting.js'),
          r = await applyActing(ctx.resolve(ctx.args.positionals[0]), kind, name, options);
        ctx.json
          ? ctx.printJson(r)
          : ctx.out(
              `${r.written ? 'wrote' : r.dryRun ? 'dry run' : 'unchanged'}: ${r.animation.id}, ${r.animation.tracks.length} tracks, ${r.diagnostics.filter((d) => d.severity === 'warning').length} warnings`,
            );
        return r.ok ? 0 : 1;
      } catch (e) {
        const err = e as Error & { diagnostics?: import('../../core/types.js').Diagnostic[] };
        throw new CliError(err.message, {
          diagnostics: err.diagnostics,
          hint: `use ${kind} list and correct the model or options`,
        });
      }
    },
  },
]);
export const GESTURE_PARENT = {
  summary: 'list and apply reusable gestures',
  subcommands: ACTING_COMMANDS.filter((c) => c.name.startsWith('gesture ')),
};
export const EXPRESSION_PARENT = {
  summary: 'list and apply reusable facial expressions',
  subcommands: ACTING_COMMANDS.filter((c) => c.name.startsWith('expression ')),
};
