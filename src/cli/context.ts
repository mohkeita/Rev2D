/**
 * Execution context shared by all commands: injectable IO (so main() is testable in-process),
 * output helpers, path handling, the failure type and model loading.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Diagnostic, Model } from '../core/types.js';
import type { Rig } from '../core/rig.js';
import { formatModelJson } from '../core/format.js';
import { hasErrors, loadModelFile, modelFilesIn, type LoadedModel } from '../node/load.js';
import type { Args } from './args.js';

export interface Writable {
  write(chunk: string): unknown;
}

export interface CliIO {
  stdout: Writable;
  stderr: Writable;
  /** Directory relative paths resolve against. */
  cwd: string;
  /** Source for "-" arguments (default process.stdin). */
  stdin?: NodeJS.ReadableStream;
  /** Stops long-running commands (watch, edit, mcp). Default: SIGINT / SIGTERM. */
  signal?: AbortSignal;
  /** Opens a URL in the user's browser (default: platform opener). */
  openUrl?: (url: string) => void;
}

/** A failed operation (exit code 1 unless `exitCode` says otherwise). */
export class CliError extends Error {
  hint?: string;
  diagnostics?: Diagnostic[];
  exitCode: number;
  constructor(message: string, opts: { hint?: string; diagnostics?: Diagnostic[]; exitCode?: number } = {}) {
    super(message);
    this.hint = opts.hint;
    this.diagnostics = opts.diagnostics;
    this.exitCode = opts.exitCode ?? 1;
  }
}

/**
 * Stop signal for long-running commands: io.signal when given, else SIGINT/SIGTERM.
 * dispose() removes the process listeners.
 */
export function stopSignal(io: CliIO): { signal: AbortSignal; dispose(): void } {
  if (io.signal) return { signal: io.signal, dispose() {} };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    signal: controller.signal,
    dispose() {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    },
  };
}

/** Resolves when the signal aborts (immediately if it already has). */
export function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

export interface LoadedRig extends LoadedModel {
  model: Model;
  rig: Rig;
}

export class Ctx {
  readonly json: boolean;
  constructor(
    readonly io: CliIO,
    readonly command: string,
    readonly args: Args,
  ) {
    this.json = args.bool('json') === true;
  }

  get cwd(): string {
    return this.io.cwd;
  }

  /** Write lines to stdout. */
  out(...lines: string[]): void {
    for (const l of lines) this.io.stdout.write(l + '\n');
  }

  /** Write lines to stderr (notes, warnings, errors). */
  err(...lines: string[]): void {
    for (const l of lines) this.io.stderr.write(l + '\n');
  }

  /** Print notes as "note: ..." lines on stderr (in every output mode; stdout stays pure data). */
  notes(list: readonly string[]): void {
    for (const n of list) this.err(`note: ${n}`);
  }

  /** Stable machine-readable output: compact, diff-friendly JSON (one document). */
  printJson(value: unknown): void {
    this.io.stdout.write(formatModelJson(value, { precision: 6 }));
  }

  resolve(p: string): string {
    return path.resolve(this.io.cwd, p);
  }

  /** Path for messages: relative to cwd when inside it, absolute otherwise; always forward slashes. */
  display(p: string): string {
    const abs = this.resolve(p);
    const rel = path.relative(this.io.cwd, abs);
    const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
    return shown.split(path.sep).join('/');
  }

  /** Write a file, creating parent directories. Returns the absolute path. */
  writeFile(p: string, data: string | Uint8Array): string {
    const abs = this.resolve(p);
    try {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, data);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const hints: Record<string, string> = {
        EISDIR: 'the output path is a directory; pass a file name',
        ENOTDIR: 'a parent of the output path is a file, not a directory',
        EEXIST: 'a parent of the output path is a file, not a directory',
      };
      throw new CliError(`cannot write ${this.display(p)} (${code ?? (e as Error).message})`, {
        hint: (code && hints[code]) ?? 'check that the directory is writable',
      });
    }
    return abs;
  }

  /** Load a model that must be valid; otherwise fail with its diagnostics (exit 1). */
  async loadRig(file: string): Promise<LoadedRig> {
    const m = await loadModelFile(this.resolve(file));
    const shown = this.display(file);
    const missing = m.diagnostics.find((d) => d.code === 'file-not-found');
    if (missing) {
      const abs = this.resolve(file);
      const isDir = statSync(abs, { throwIfNoEntry: false })?.isDirectory() ?? false;
      const dir = isDir ? abs : path.dirname(abs);
      const files = modelFilesIn(dir).map((n) => this.display(path.join(dir, n)));
      const list = files.length > 12 ? `${files.slice(0, 12).join(', ')}, ... (+${files.length - 12})` : files.join(', ');
      if (isDir) {
        throw new CliError(`${shown} is a directory, not a model file`, {
          hint: files.length === 1 ? `did you mean ${files[0]}?` : files.length ? `model files in it: ${list}` : 'it contains no *.r2d.json file; give the path of a model file',
        });
      }
      const nearby = files.length ? `model files in ${this.display(dir) || '.'}: ${list}; or ` : '';
      throw new CliError(`cannot read model file ${shown}`, { hint: `${nearby}check the path (relative to ${this.display('.') || '.'}) or create it with "rev2d new ${shown}"` });
    }
    if (hasErrors(m.diagnostics) || !m.rig || !m.model) {
      const errors = m.diagnostics.filter((d) => d.severity === 'error').length;
      throw new CliError(`${shown} has ${errors} error${errors === 1 ? '' : 's'}`, {
        diagnostics: m.diagnostics,
        hint: `fix them first; "rev2d validate ${shown}" lists every diagnostic with its JSON pointer and hint`,
      });
    }
    const warnings = m.diagnostics.filter((d) => d.severity === 'warning').length;
    if (warnings && !this.json) this.err(`note: ${shown} has ${warnings} warning${warnings === 1 ? '' : 's'} (see "rev2d validate ${shown}")`);
    return m as LoadedRig;
  }
}
