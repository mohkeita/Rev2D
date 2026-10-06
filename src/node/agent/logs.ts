/**
 * Job log files: one JSON-lines file per job under ~/.rev2d/agent-logs/ holding everything the
 * runner saw, so a run can be diagnosed after the editor is closed. Lines are objects with `kind`:
 *
 *   {"kind":"job","job":{...},"command":[...],"prompt":"..."}   first line: the job and its command line
 *   {"kind":"stdout"|"stderr","time":"...","line":"..."}         a raw line of the provider process
 *   {"kind":"event","seq":1,"time":"...","type":"...",...}       a normalised event
 *
 * The newest 50 files are kept. The log holds the person's prompt and the agent's output: it stays on
 * this machine and is never sent anywhere.
 */
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_LOG_FILES = 50;
/** Longest raw line written to a log (longer ones are cut, marked with `cut`). */
const MAX_LOG_LINE = 256 * 1024;

const LOG_NAME = /^\d{8}T\d{9}Z-[a-z]+-[0-9a-f]+\.jsonl$/;

export function defaultLogDir(): string {
  return path.join(os.homedir(), '.rev2d', 'agent-logs');
}

/** "20261005T101502123Z-codex-3fa2b1c09d4e.jsonl": sorts by start time. */
export function logFileName(timeMs: number, provider: string, jobId: string): string {
  const stamp = new Date(timeMs).toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${provider}-${jobId}.jsonl`;
}

/** The job logs in `dir`, oldest first. */
export function listLogFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => LOG_NAME.test(n)).sort();
  } catch {
    return [];
  }
}

/** Delete the oldest job logs so that at most `keep` remain; returns the removed names. Never throws. */
export function rotateLogs(dir: string, keep = MAX_LOG_FILES): string[] {
  const names = listLogFiles(dir);
  const removed: string[] = [];
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch {
      // locked by another program: it goes with a later rotation
    }
  }
  return removed;
}

/** Appends JSON lines to one job's log file. Write failures switch the log off (reported once). */
export class JobLog {
  private fd: number | null = null;

  private constructor(
    readonly file: string,
    private readonly onError: (message: string) => void,
  ) {}

  /**
   * Create the log of a new job in `dir` (created when missing), first making room so that at most
   * `keep` logs exist afterwards. Null when the directory cannot be written.
   */
  static create(dir: string, name: string, opts: { keep?: number; onError?: (message: string) => void } = {}): JobLog | null {
    const onError = opts.onError ?? (() => undefined);
    try {
      // Prompts and agent output are private: readable by the owner only (where the platform has file modes).
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      rotateLogs(dir, Math.max(0, (opts.keep ?? MAX_LOG_FILES) - 1));
      const log = new JobLog(path.join(dir, name), onError);
      log.fd = openSync(log.file, 'a', 0o600);
      return log;
    } catch (e) {
      onError(`cannot write agent logs to ${dir}: ${(e as Error).message}`);
      return null;
    }
  }

  write(record: Record<string, unknown>): void {
    if (this.fd === null) return;
    try {
      writeSync(this.fd, `${JSON.stringify(record)}\n`);
    } catch (e) {
      this.onError(`cannot write the agent log ${this.file}: ${(e as Error).message}`);
      this.close();
    }
  }

  /** A raw provider line (cut to a sane length). */
  raw(kind: 'stdout' | 'stderr', time: string, line: string): void {
    this.write(line.length > MAX_LOG_LINE ? { kind, time, line: line.slice(0, MAX_LOG_LINE), cut: line.length } : { kind, time, line });
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // nothing left to do
    }
    this.fd = null;
  }
}
