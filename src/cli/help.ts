/** Help text for the whole CLI and for single commands. */
import type { FlagSpec } from './args.js';
import { GROUP_TITLES, type Command, type CommandGroup, type FlagGroup } from './command.js';
import { COMMANDS, PARENTS } from './commands/index.js';
import { FRAME_FLAGS, JSON_FLAG, POSE_FLAGS, SAMPLE_FLAGS, SEQUENCE_POSE_FLAGS } from './flags.js';
import { table, wrap } from './text.js';

const WIDTH = 100;

export const HELP_FLAG: FlagSpec = { name: 'help', short: 'h', type: 'boolean', description: 'show help for this command' };

const GROUP_FLAGS: Record<FlagGroup, FlagSpec[]> = { pose: POSE_FLAGS, sequencePose: SEQUENCE_POSE_FLAGS, sample: SAMPLE_FLAGS, frame: FRAME_FLAGS };
/** Help tables of the shared groups, in display order. */
const GROUP_TABLES: Array<[FlagGroup, string]> = [
  ['sample', 'Sampling flags:'],
  ['pose', 'Pose flags:'],
  ['sequencePose', 'Pose flags:'],
  ['frame', 'Frame flags:'],
];

export const EXIT_CODES = 'Exit codes: 0 ok, 1 model errors or failed operation, 2 usage error.';

export function generalHelp(version: string): string {
  const lines = [
    `rev2d ${version} - AI-friendly 2D rigging & animation toolkit`,
    '',
    'usage: rev2d <command> [arguments] [flags]',
  ];
  const groups = Object.keys(GROUP_TITLES) as CommandGroup[];
  for (const g of groups) {
    const rows: string[][] = [];
    for (const c of COMMANDS.filter((x) => x.group === g)) {
      const parent = c.name.split(' ')[0];
      if (c.name.includes(' ')) {
        if (!rows.some((r) => r[0] === parent)) rows.push([parent, PARENTS[parent].summary]);
        continue;
      }
      rows.push([c.name, c.summary]);
    }
    if (!rows.length) continue;
    lines.push('', `${GROUP_TITLES[g]}:`, ...table(rows));
  }
  lines.push(
    '',
    'Run "rev2d help <command>" (or "rev2d <command> --help") for flags and examples.',
    'Every command that prints data accepts --json. Errors go to stderr (with --json also as {"ok": false, "error": {...}} on stdout).',
    EXIT_CODES,
    'Docs: "rev2d docs spec" (model format), "rev2d docs cli" (this tool), "rev2d docs ops" (edit operations), "rev2d docs recipes" (worked examples).',
  );
  return lines.join('\n');
}

function flagRows(flags: FlagSpec[], notes: Record<string, string> = {}): string[][] {
  return flags.filter((f) => !f.hidden).map((f) => {
    const names = `${f.short ? `-${f.short}, ` : '    '}--${f.name}${f.arg ? (f.optionalValue ? ` [${f.arg}]` : ` <${f.arg}>`) : ''}`;
    return [names, notes[f.name] ?? f.description];
  });
}

export function parentHelp(name: string): string {
  const p = PARENTS[name];
  return [
    `rev2d ${name} <subcommand> - ${p.summary}`,
    '',
    'subcommands:',
    ...table(p.subcommands.map((c) => [c.name.split(' ')[1], c.summary])),
    '',
    `Run "rev2d help ${name} <subcommand>" for flags and examples.`,
  ].join('\n');
}

export function commandHelp(cmd: Command): string {
  const lines = [`usage: rev2d ${cmd.usage}`, '', ...wrap(cmd.summary, WIDTH, '')];
  for (const d of cmd.description ?? []) lines.push('', ...wrap(d, WIDTH, ''));
  const own = [...cmd.flags, ...(cmd.json ? [JSON_FLAG] : []), HELP_FLAG];
  const notes = cmd.flagNotes ?? {};
  lines.push('', 'Flags:', ...table(flagRows(own, notes)));
  for (const [group, title] of GROUP_TABLES) {
    if (cmd.flagGroups?.includes(group)) lines.push('', title, ...table(flagRows(GROUP_FLAGS[group], notes)));
  }
  lines.push('', 'Examples:', ...cmd.examples.map((e) => `  ${e}`), '', EXIT_CODES);
  return lines.join('\n');
}

/** All flags a command accepts (own + groups + --json + --help), hidden ones included. */
export function commandFlags(cmd: Command): FlagSpec[] {
  return [...cmd.flags, ...GROUP_TABLES.flatMap(([g]) => (cmd.flagGroups?.includes(g) ? GROUP_FLAGS[g] : [])), ...(cmd.json ? [JSON_FLAG] : []), HELP_FLAG];
}
