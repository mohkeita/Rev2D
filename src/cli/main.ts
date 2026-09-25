/**
 * rev2d command-line entry point.
 *
 *   main(argv, io)  testable in-process: returns the exit code (0 ok, 1 failed, 2 usage error)
 *   runCli(argv)    process entry: runs main, flushes output and exits
 *
 * Executed directly (tsx src/cli/main.ts, or via bin/rev2d.js), it calls runCli().
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDiagnostics } from '../core/validate.js';
import { AddressError, suggest } from '../core/address.js';
import { ApiError } from '../api/index.js';
import { PACKAGE_ROOT } from '../api/templates.js';
import { Args, parseArgs, UsageError } from './args.js';
import { arity, type Command } from './command.js';
import { COMMANDS, PARENTS } from './commands/index.js';
import { CliError, Ctx, type CliIO } from './context.js';
import { commandFlags, commandHelp, generalHelp, parentHelp } from './help.js';

export type { CliIO } from './context.js';
export { COMMANDS } from './commands/index.js';

function version(): string {
  try {
    return (JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const TOP_LEVEL = [...COMMANDS.filter((c) => !c.name.includes(' ')).map((c) => c.name), ...Object.keys(PARENTS), 'help'];

/** Find the command addressed by argv; returns it with the remaining arguments, or a help text. */
function resolveCommand(argv: string[]): { cmd: Command; rest: string[] } | { text: string; code: number } {
  const [first, ...rest] = argv;
  if (first === undefined) return { text: generalHelp(version()), code: 0 };
  if (first === '--version' || first === '-v' || first === 'version') return { text: version(), code: 0 };
  if (first === 'help' || first === '--help' || first === '-h') {
    if (!rest.length) return { text: generalHelp(version()), code: 0 };
    const target = resolveCommand([...rest, '--help']);
    return 'text' in target ? target : { text: commandHelp(target.cmd), code: 0 };
  }
  if (first.startsWith('-')) throw new UsageError(`expected a command before "${first}"`, `commands: ${TOP_LEVEL.join(', ')}`);
  const parent = PARENTS[first];
  if (parent) {
    const [sub, ...subRest] = rest;
    if (sub === undefined || sub === '--help' || sub === '-h') {
      if (sub === undefined) throw new UsageError(`"rev2d ${first}" needs a subcommand`, `subcommands: ${parent.subcommands.map((c) => c.name.split(' ')[1]).join(', ')}`);
      return { text: parentHelp(first), code: 0 };
    }
    const cmd = parent.subcommands.find((c) => c.name === `${first} ${sub}`);
    if (!cmd) {
      const names = parent.subcommands.map((c) => c.name.split(' ')[1]);
      throw new UsageError(`unknown subcommand "${first} ${sub}"`, suggest(sub, names) ?? `subcommands: ${names.join(', ')}`);
    }
    return { cmd, rest: subRest };
  }
  const cmd = COMMANDS.find((c) => c.name === first);
  if (!cmd) throw new UsageError(`unknown command "${first}"`, suggest(first, TOP_LEVEL) ?? 'run "rev2d help" for the list of commands');
  return { cmd, rest };
}

function checkArity(cmd: Command, positionals: string[]): void {
  const { min, max } = arity(cmd);
  if (positionals.length < min) {
    const missing = cmd.args.filter((a) => a.startsWith('<'))[positionals.length];
    throw new UsageError(`missing argument ${missing}`);
  }
  if (positionals.length > max) throw new UsageError(`unexpected argument "${positionals[max]}"`, max === 0 ? `"rev2d ${cmd.name}" takes no positional arguments` : undefined);
}

/** --json for errors in the command line itself (before parsing succeeded): the raw tokens up to "--". */
function rawJsonFlag(argv: string[]): boolean {
  const end = argv.indexOf('--');
  return (end < 0 ? argv : argv.slice(0, end)).some((t) => t === '--json' || /^--json=(true|yes|1)$/i.test(t));
}

export async function main(argv: string[], io: Partial<CliIO> = {}): Promise<number> {
  const full: CliIO = { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd(), ...io };
  let wantsJson = rawJsonFlag(argv);
  let current: Command | null = null;
  try {
    const resolved = resolveCommand(argv);
    if ('text' in resolved) {
      full.stdout.write(resolved.text + '\n');
      return resolved.code;
    }
    current = resolved.cmd;
    const parsed = parseArgs(resolved.rest, commandFlags(current));
    wantsJson = parsed.flags.json === true;
    if (parsed.flags.help === true) {
      full.stdout.write(commandHelp(current) + '\n');
      return 0;
    }
    checkArity(current, parsed.positionals);
    return await current.run(new Ctx(full, current.name, new Args(parsed)));
  } catch (e) {
    return report(e, full, wantsJson, current);
  }
}

/** Print an error (stderr, plus a JSON document on stdout with --json) and return its exit code. */
export function report(e: unknown, io: CliIO, json: boolean, cmd: Command | null): number {
  let code = 1;
  let kind = 'failed';
  let message: string;
  let hint: string | undefined;
  let diagnostics: CliError['diagnostics'];
  if (e instanceof UsageError) {
    code = 2;
    kind = 'usage';
    message = e.message;
    hint = e.hint;
  } else if (e instanceof CliError) {
    code = e.exitCode;
    message = e.message;
    hint = e.hint;
    diagnostics = e.diagnostics;
  } else if (e instanceof ApiError) {
    message = e.message.split('\n')[0];
    hint = e.hint;
    diagnostics = e.diagnostics.length ? e.diagnostics : undefined;
  } else if (e instanceof AddressError) {
    message = e.message;
    hint = e.hint;
  } else {
    message = e instanceof Error ? e.message : String(e);
  }
  const lines = [`error: ${message}`];
  if (diagnostics?.length) lines.push(...formatDiagnostics(diagnostics).split('\n').map((l) => `  ${l}`));
  if (hint) lines.push(`hint: ${hint}`);
  if (kind === 'usage') {
    lines.push(cmd ? `usage: rev2d ${cmd.usage}\nrun "rev2d help ${cmd.name}" for details` : 'run "rev2d help" for the list of commands');
  }
  if (process.env.REV2D_DEBUG && e instanceof Error && e.stack) lines.push(e.stack);
  io.stderr.write(lines.join('\n') + '\n');
  // One line, so it also fits the NDJSON streams of watch/edit.
  if (json) io.stdout.write(JSON.stringify({ ok: false, exitCode: code, error: { kind, message, hint, diagnostics } }) + '\n');
  return code;
}

/** Wait until everything written so far has been handed to the OS. */
function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) return resolve();
    stream.write('', () => resolve());
  });
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  // A closed pipe (e.g. `rev2d docs spec | head`) is not an error worth a stack trace.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e;
  });
  const code = await main(argv);
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  process.exit(code);
}

function isEntryModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const target = realpathSync(path.resolve(entry));
    return process.platform === 'win32' ? self.toLowerCase() === target.toLowerCase() : self === target;
  } catch {
    return false;
  }
}

if (isEntryModule()) await runCli();
