/**
 * Starting and stopping agent CLIs without a shell.
 *
 * Nothing here ever goes through cmd.exe, PowerShell or /bin/sh: the program is resolved to a real
 * executable first and started with an argument ARRAY, so no text (prompt, model name, file path) can
 * be read as shell syntax. The prompt itself travels on stdin.
 *
 * Windows: the CLIs are installed as native programs (claude.exe) or as npm shims (codex.cmd, a batch
 * file that runs `node <package>/bin/codex.js`). Batch files cannot be started without cmd.exe (and
 * Node refuses to, CVE-2024-27980), so an npm shim is read and resolved to the script it runs; a .cmd
 * that is not such a shim is refused instead of being handed to a shell.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AgentError } from './types.js';

/** A program to start: `file` with the leading arguments `args` (e.g. node + the CLI's script). */
export interface ResolvedCommand {
  file: string;
  args: string[];
  /** Where it came from, for messages: the path found on PATH or given explicitly. */
  source: string;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const SCRIPT = /\.(?:js|mjs|cjs)$/i;
const BATCH = /\.(?:cmd|bat)$/i;
const NATIVE = /\.(?:exe|com)$/i;
/** Largest batch file read as an npm shim (they are a few hundred bytes). */
const MAX_SHIM_BYTES = 64 * 1024;

function isFile(p: string): boolean {
  return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Windows environment names are case-insensitive, but a copied env object is not.
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Absolute path of program `name` on PATH, or null. Only absolute PATH entries are searched: the
 * current directory (which is the workspace an agent writes to) can never provide the program.
 * Windows tries the PATHEXT extensions in order; elsewhere the file must be executable.
 */
export function findOnPath(name: string, opts: ResolveOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const dirs = (envValue(env, 'PATH') ?? '').split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1'));
  const exts = win
    ? path.extname(name)
      ? ['']
      : (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)
    : [''];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (!isFile(candidate)) continue;
      if (win) return candidate;
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not executable: keep looking
      }
    }
  }
  return null;
}

/**
 * The script an npm command shim (cmd-shim) runs, or null when `text` is not one. The shim's last
 * line is `"%_prog%"  "%dp0%\node_modules\<pkg>\bin\<cli>.js" %*` (older versions: `"%~dp0\..."`).
 */
export function parseNpmShim(text: string, dir: string): { target: string; node: boolean } | null {
  const m = /"(?:%~dp0|%dp0%)\\([^"\r\n%]+)"\s+%\*/.exec(text);
  if (!m) return null;
  const target = path.win32.join(dir, m[1]);
  return { target, node: /node(?:\.exe)?/i.test(text.slice(0, m.index)) };
}

/**
 * Turn a program path into something that can be started without a shell: a native executable as it
 * is, a .js file through Node, an npm .cmd shim through the script it wraps. Throws AgentError
 * "unavailable" for a batch file that is not an npm shim.
 */
export function commandFromPath(file: string, opts: ResolveOptions = {}): ResolvedCommand {
  const platform = opts.platform ?? process.platform;
  if (SCRIPT.test(file)) return { file: process.execPath, args: [file], source: file };
  if (platform === 'win32' && BATCH.test(file)) {
    const dir = path.dirname(file);
    let text = '';
    try {
      if (statSync(file).size <= MAX_SHIM_BYTES) text = readFileSync(file, 'utf8');
    } catch {
      // unreadable: refused below
    }
    const shim = parseNpmShim(text, dir);
    if (shim && NATIVE.test(shim.target) && isFile(shim.target)) return { file: shim.target, args: [], source: file };
    if (shim && shim.node && isFile(shim.target)) {
      // The shim prefers a node.exe installed next to it; otherwise the Node running Rev2D.
      const local = path.join(dir, 'node.exe');
      return { file: existsSync(local) ? local : process.execPath, args: [shim.target], source: file };
    }
    throw new AgentError(
      'unavailable',
      `${file} is a batch file that Rev2D cannot start safely (it is not an npm command shim)`,
      'Rev2D never runs agent CLIs through a shell; point the REV2D_AGENT_* environment variable at the real executable or the CLI\'s .js entry script',
    );
  }
  return { file, args: [], source: file };
}

/** Find `name` on PATH and make it startable (see commandFromPath); null when it is not installed. */
export function resolveCommand(name: string, opts: ResolveOptions = {}): ResolvedCommand | null {
  const found = findOnPath(name, opts);
  return found ? commandFromPath(found, opts) : null;
}

/** A command given explicitly: a path (resolved like one found on PATH) or a ready argv prefix. */
export function explicitCommand(spec: string | readonly string[], opts: ResolveOptions = {}): ResolvedCommand {
  if (typeof spec === 'string') return commandFromPath(path.resolve(spec), opts);
  if (!spec.length || !spec[0]) throw new AgentError('unavailable', 'an explicit agent command needs at least the program to run');
  return { file: spec[0], args: spec.slice(1), source: spec.join(' ') };
}

function assertNoShell(file: string): void {
  if (process.platform === 'win32' && BATCH.test(file)) {
    throw new AgentError('unavailable', `refusing to start the batch file ${file}`, 'batch files need cmd.exe; Rev2D starts agent CLIs without a shell');
  }
}

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Start `command` with `args` (never through a shell), with piped stdio and no console window. On
 * POSIX the child leads its own process group, so killTree can signal everything it started.
 */
export function spawnCommand(command: ResolvedCommand, args: readonly string[], opts: SpawnOptions): ChildProcessWithoutNullStreams {
  assertNoShell(command.file);
  return spawn(command.file, [...command.args, ...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
}

/** Run `command` to completion and collect its output (for --version); never through a shell. */
export function runCommand(
  command: ResolvedCommand,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    try {
      assertNoShell(command.file);
      execFile(
        command.file,
        [...command.args, ...args],
        { env: opts.env ?? process.env, cwd: opts.cwd, timeout: opts.timeoutMs ?? 15_000, windowsHide: true, shell: false, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const e = error as (Error & { code?: number | string; killed?: boolean }) | null;
          resolve({
            code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            ...(e && typeof e.code !== 'number' ? { error: e.killed ? 'timed out' : e.message } : {}),
          });
        },
      );
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: (e as Error).message });
    }
  });
}

/** Whether a process with this pid exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kill the process `pid` and everything it started. Windows: taskkill /T /F (called by its full
 * path, no shell). POSIX: SIGTERM to the process group, SIGKILL after `graceMs`. Resolves once the
 * kill was issued (the caller waits for the child's own "close" event).
 */
export function killTree(pid: number, graceMs = 2000): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const taskkill = path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      const fallback = () => {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
        resolve();
      };
      try {
        const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
        killer.once('error', fallback);
        // 128: the process was not found (already gone); anything else non-zero: try the plain kill.
        killer.once('exit', (code) => (code === 0 || code === 128 ? resolve() : fallback()));
      } catch {
        fallback();
      }
    });
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), graceMs);
  timer.unref();
  return Promise.resolve();
}

/**
 * Split a byte stream into text lines (UTF-8, multi-byte characters may be split across chunks; a
 * trailing CR is dropped). A line longer than `maxLineChars` is cut there and reported once with
 * `truncated`, so one endless line cannot exhaust memory.
 */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private overflow = false;

  constructor(
    private readonly onLine: (line: string, truncated: boolean) => void,
    private readonly maxLineChars = 8 * 1024 * 1024,
  ) {}

  push(chunk: Buffer): void {
    this.feed(this.decoder.write(chunk));
  }

  /** Flush the last line (one without a newline at the end). */
  end(): void {
    this.feed(this.decoder.end());
    if (this.buffer || this.overflow) this.emit(this.buffer);
    this.buffer = '';
    this.overflow = false;
  }

  private feed(text: string): void {
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) break;
      this.append(text.slice(start, nl));
      this.emit(this.buffer);
      this.buffer = '';
      this.overflow = false;
      start = nl + 1;
    }
    this.append(text.slice(start));
  }

  private append(part: string): void {
    if (this.overflow) return;
    const room = this.maxLineChars - this.buffer.length;
    if (part.length > room) {
      this.buffer += part.slice(0, room);
      this.overflow = true;
    } else {
      this.buffer += part;
    }
  }

  private emit(line: string): void {
    this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line, this.overflow);
  }
}
