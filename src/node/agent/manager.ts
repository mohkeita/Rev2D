/**
 * Agent jobs: start a provider CLI for a request, follow it as normalised events, cancel it, continue
 * its session with a follow-up message. One job runs at a time per manager; finished jobs stay in
 * memory (the newest few, each with a capped event list) and every job writes a log file.
 *
 * Safety rules enforced here, whatever the caller passes:
 * - the working directory and every image must lie inside the manager's root (real paths);
 * - the sandbox is "read-only" or "workspace-write", nothing wider, and every command line passes
 *   assertSafeArgs before a process starts;
 * - the prompt goes to the process on stdin and the process is started without a shell (exec.ts);
 * - a job that runs too long, or stays silent too long, is stopped with its whole process tree.
 */
import { randomBytes } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '../../api/templates.js';
import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';
import { LineSplitter, explicitCommand, killTree, resolveCommand, runCommand, spawnCommand, type ResolvedCommand } from './exec.js';
import { JobLog, MAX_LOG_FILES, defaultLogDir, logFileName } from './logs.js';
import { buildAgentPrompt, type PromptEnv } from './prompt.js';
import { assertSafeArgs, type AgentProvider, type ProviderRun, type StreamParser } from './provider.js';
import {
  AgentError,
  type AgentDoneReason,
  type AgentEffort,
  type AgentEvent,
  type AgentEventBody,
  type AgentJobEvents,
  type AgentJobInfo,
  type AgentJobState,
  type AgentProviderId,
  type AgentProviderInfo,
  type AgentSandbox,
  type AgentStartOptions,
  type AgentUsage,
  type CodexWindowsSandbox,
} from './types.js';

/** The providers, in the order GET /api/agent/providers lists them. */
export const PROVIDERS: Record<AgentProviderId, AgentProvider> = { codex: codexProvider, claude: claudeProvider };
export const PROVIDER_IDS = Object.keys(PROVIDERS) as AgentProviderId[];

export const SANDBOXES: AgentSandbox[] = ['read-only', 'workspace-write'];
export const EFFORTS: AgentEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULT_TIMEOUT_MS = 45 * 60_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
/** Silence of the provider after which a running job is reported as "stalled" (it keeps running). */
export const DEFAULT_STALL_MS = 90_000;
export const DEFAULT_MAX_EVENTS = 2000;
export const DEFAULT_MAX_JOBS = 20;
export const DEFAULT_MAX_PROMPT_BYTES = 32 * 1024;
/** Largest task-template context, as JSON text. */
export const MAX_CONTEXT_BYTES = 16 * 1024;
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif)$/i;
/** Model names are command-line values: plain identifiers only (never a flag, a path or key=value). */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;

const STDERR_TAIL_CHARS = 8 * 1024;
const FINAL_STATES: AgentJobState[] = ['done', 'failed', 'cancelled'];

export interface AgentManagerOptions {
  /** Allowed root: the working directory and the images of every job must lie inside it. */
  root: string;
  /** bin/rev2d.js the agents are told to call (default: the one of this package). */
  rev2dBin?: string;
  /** Directory of the job logs (default ~/.rev2d/agent-logs); null: write none. */
  logDir?: string | null;
  /** Job logs kept (default 50). */
  maxLogFiles?: number;
  /** Wall-clock limit of a job in ms (default 45 min; 0 = none). */
  timeoutMs?: number;
  /** A job without any output for this long is stopped (default 15 min; 0 = never). */
  idleTimeoutMs?: number;
  /** Events kept in memory per job (default 2000; older ones are dropped, the log file has all). */
  maxEvents?: number;
  /** Jobs kept in memory (default 20). */
  maxJobs?: number;
  /** Largest prompt in UTF-8 bytes (default 32 KiB). */
  maxPromptBytes?: number;
  /**
   * Explicit program per provider instead of the PATH lookup: a path (an executable, a .js entry
   * script or an npm .cmd shim) or a ready argv prefix. Tests point this at fake agents.
   */
  commands?: Partial<Record<AgentProviderId, string | readonly string[]>>;
  /** Environment of the provider processes and of the PATH lookup (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Clock in ms (default Date.now). */
  now?: () => number;
  /** Sink for operational messages (log-file problems). */
  log?: (message: string) => void;
  /** POSIX: time between SIGTERM and SIGKILL when a job is stopped (default 2000 ms). */
  killGraceMs?: number;
  /**
   * Codex's sandbox implementation on Windows (see CodexWindowsSandbox): a value, or a function asked
   * at every job start (the editor server passes its settings store). Default "config". Deliberately
   * not an option of a job: a request cannot choose it.
   */
  codexWindowsSandbox?: CodexWindowsSandbox | (() => CodexWindowsSandbox);
  /**
   * A running job whose provider reports nothing for this long gets a `status` event "stalled" with a
   * hint, where the provider has one (Codex on Windows); the job is not stopped. Default 90 s; 0 = never.
   */
  stallMs?: number;
  /**
   * The platform the provider-specific handling is decided by (Codex's Windows sandbox override, its
   * diagnosis and the stall notice). Default process.platform; tests set it. Processes are always
   * started and killed the way the real platform needs.
   */
  platform?: NodeJS.Platform;
}

/** Called for every event of every job, with the job as it is right after the event. */
export type AgentListener = (job: AgentJobInfo, event: AgentEvent) => void;

interface Detected {
  info: AgentProviderInfo;
  command: ResolvedCommand | null;
  help?: string;
}

interface DetectEntry {
  /** When the lookup started, then when it finished. */
  at: number;
  /** How long the answer stays valid in ms; null while the lookup runs. */
  ttl: number | null;
  result: Promise<Detected>;
}

interface JobRecord {
  info: AgentJobInfo;
  /** The request in the person's words. */
  prompt: string;
  /** The whole text written to the provider's stdin. */
  input: string;
  events: AgentEvent[];
  provider: AgentProvider;
  command: ResolvedCommand;
  run: ProviderRun;
  parser: StreamParser;
  child: ChildProcessWithoutNullStreams | null;
  log: JobLog | null;
  cancelRequested: boolean;
  timedOut: 'timeout' | 'idle-timeout' | null;
  spawnError: string | null;
  /** The provider said the turn failed. */
  failure: string | null;
  /** The last error event (used when the process exits non-zero without saying why). */
  lastError: string | null;
  /** Codes of the known problems already reported (AgentProvider.diagnose). */
  diagnosed: Set<string>;
  stderrTail: string;
  finished: boolean;
  timers: { wall?: NodeJS.Timeout; idle?: NodeJS.Timeout; kill?: NodeJS.Timeout; stall?: NodeJS.Timeout };
  done: Promise<AgentJobInfo>;
  resolveDone: (info: AgentJobInfo) => void;
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const fold = (p: string) => (CASE_INSENSITIVE ? p.toLowerCase() : p);

function within(dir: string, p: string): boolean {
  const rel = path.relative(fold(dir), fold(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const minutes = (ms: number) => {
  const m = ms / 60_000;
  return m >= 1 ? `${Number(m.toFixed(1))} min` : `${Number((ms / 1000).toFixed(1))} s`;
};

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function addUsage(a: AgentUsage | null, b: AgentUsage): AgentUsage {
  if (!a) return { ...b };
  const cost = a.costUsd !== undefined || b.costUsd !== undefined ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) } : {};
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    ...cost,
  };
}

export class AgentManager {
  readonly root: string;
  private readonly realRoot: string;
  private readonly rev2dBin: string;
  private readonly logDir: string | null;
  private readonly maxLogFiles: number;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxEvents: number;
  private readonly maxJobs: number;
  private readonly maxPromptBytes: number;
  private readonly commands: Partial<Record<AgentProviderId, string | readonly string[]>>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly killGraceMs: number;
  private readonly codexWindowsSandbox: () => CodexWindowsSandbox;
  private readonly stallMs: number;
  private readonly platform: NodeJS.Platform;

  private readonly jobs = new Map<string, JobRecord>();
  private readonly listeners = new Set<AgentListener>();
  private readonly detected = new Map<AgentProviderId, DetectEntry>();
  private active: JobRecord | null = null;
  private closed = false;

  constructor(opts: AgentManagerOptions) {
    this.root = path.resolve(opts.root);
    this.realRoot = realpathSync.native(this.root);
    this.rev2dBin = opts.rev2dBin ?? path.join(PACKAGE_ROOT, 'bin', 'rev2d.js');
    this.logDir = opts.logDir === undefined ? defaultLogDir() : opts.logDir;
    this.maxLogFiles = opts.maxLogFiles ?? MAX_LOG_FILES;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxEvents = Math.max(1, opts.maxEvents ?? DEFAULT_MAX_EVENTS);
    this.maxJobs = Math.max(1, opts.maxJobs ?? DEFAULT_MAX_JOBS);
    this.maxPromptBytes = opts.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES;
    this.commands = opts.commands ?? {};
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.killGraceMs = opts.killGraceMs ?? 2000;
    const sandbox = opts.codexWindowsSandbox ?? 'config';
    this.codexWindowsSandbox = typeof sandbox === 'function' ? sandbox : () => sandbox;
    this.stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    this.platform = opts.platform ?? process.platform;
  }

  // --------------------------------------------------------------------------- providers

  /** Every provider with whether its CLI is installed (looked up at most every 30 s). */
  async providers(): Promise<AgentProviderInfo[]> {
    return Promise.all(
      PROVIDER_IDS.map(async (id) => ({
        ...(await this.detect(id)).info,
        // Not part of the cached lookup: the setting can change between two calls.
        ...(id === 'codex' && this.platform === 'win32' ? { windowsSandbox: this.effectiveCodexWindowsSandbox() } : {}),
      })),
    );
  }

  /** The codexWindowsSandbox setting right now ("config" for anything a source should not have returned). */
  private effectiveCodexWindowsSandbox(): CodexWindowsSandbox {
    return this.codexWindowsSandbox() === 'unelevated' ? 'unelevated' : 'config';
  }

  /**
   * Where the provider's CLI is and what version it has. An answer is reused for 30 s when the CLI
   * was found and for 3 s when it was not (so installing it is noticed quickly); one lookup per
   * provider runs at a time.
   */
  private detect(id: AgentProviderId): Promise<Detected> {
    const cached = this.detected.get(id);
    if (cached && (cached.ttl === null || this.now() - cached.at < cached.ttl)) return cached.result;
    const entry: DetectEntry = { at: this.now(), ttl: null, result: this.probe(PROVIDERS[id]) };
    this.detected.set(id, entry);
    entry.result.then(
      (d) => {
        entry.at = this.now();
        entry.ttl = d.command ? 30_000 : 3_000;
      },
      () => {
        // The lookup itself failed (reported to whoever awaited it): look again next time.
        if (this.detected.get(id) === entry) this.detected.delete(id);
      },
    );
    return entry.result;
  }

  /** Look the CLI up and ask for its version (and, for providers that need it, its --help). */
  private async probe(provider: AgentProvider): Promise<Detected> {
    const info = (available: boolean, version: string | null, hint?: string): AgentProviderInfo => ({
      id: provider.id,
      name: provider.name,
      available,
      version,
      features: { ...provider.features },
      efforts: [...provider.efforts],
      ...(hint !== undefined ? { hint } : {}),
    });
    const missing = (hint: string): Detected => ({ info: info(false, null, hint), command: null });
    let command: ResolvedCommand | null;
    try {
      const explicit = this.commands[provider.id] ?? this.env[provider.envOverride];
      if (explicit !== undefined && explicit !== '') {
        command = explicitCommand(explicit, { env: this.env });
        if (!statSync(command.file, { throwIfNoEntry: false })?.isFile()) return missing(`${command.file} does not exist (${provider.envOverride} or the configured command points at it)`);
      } else {
        command = resolveCommand(provider.bin, { env: this.env });
      }
    } catch (e) {
      return missing(e instanceof AgentError && e.hint ? `${e.message}; ${e.hint}` : (e as Error).message);
    }
    if (!command) return missing(`"${provider.bin}" was not found on PATH: ${provider.installHint}`);
    const [version, h] = await Promise.all([
      runCommand(command, ['--version'], { env: this.env, timeoutMs: 20_000 }),
      provider.needsHelp ? runCommand(command, ['--help'], { env: this.env, timeoutMs: 20_000 }) : null,
    ]);
    if (version.code !== 0) {
      const why = version.error ?? (lastLine(version.stderr) || `exit code ${version.code}`);
      return missing(`"${provider.bin} --version" failed (${why}): ${provider.installHint}`);
    }
    const help = h && h.code === 0 && h.stdout ? h.stdout : undefined;
    return {
      info: info(true, provider.parseVersion(`${version.stdout}\n${version.stderr}`)),
      command,
      ...(help !== undefined ? { help } : {}),
    };
  }

  // --------------------------------------------------------------------------- reading

  subscribe(listener: AgentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The job, or null. */
  get(id: string): AgentJobInfo | null {
    const job = this.jobs.get(id);
    return job ? snapshot(job.info) : null;
  }

  /** The request of a job in the person's words. */
  prompt(id: string): string {
    return this.require(id).prompt;
  }

  /** Jobs in memory, newest first. */
  list(): AgentJobInfo[] {
    return [...this.jobs.values()].reverse().map((j) => snapshot(j.info));
  }

  /** Id of the queued or running job, or null. */
  get activeJob(): string | null {
    return this.active?.info.id ?? null;
  }

  /** Events of a job with seq > since. */
  events(id: string, since = 0): AgentJobEvents {
    const job = this.require(id);
    return {
      events: job.events.filter((e) => e.seq > since),
      firstSeq: job.events[0]?.seq ?? 0,
      lastSeq: job.info.lastSeq,
    };
  }

  /** Resolves with the job once it is done, failed or cancelled. */
  wait(id: string): Promise<AgentJobInfo> {
    return this.require(id).done;
  }

  private require(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new AgentError('unknown-job', `unknown agent job "${id}"`, 'GET /api/agent/jobs lists the jobs this editor remembers (the newest ones)');
    return job;
  }

  // --------------------------------------------------------------------------- starting

  /**
   * Start a job. Resolves with the job in state "queued" (its process starts right after); rejects
   * with an AgentError when an option is invalid, the provider CLI is missing or another job is active.
   */
  async start(opts: AgentStartOptions): Promise<AgentJobInfo> {
    if (this.closed) throw new AgentError('closed', 'the agent runner was closed');
    const provider = Object.hasOwn(PROVIDERS, opts.provider) ? PROVIDERS[opts.provider] : undefined;
    if (!provider) throw new AgentError('invalid', `unknown provider ${JSON.stringify(opts.provider)}`, `providers: ${PROVIDER_IDS.join(', ')}`);
    this.checkIdle();

    const sandbox = opts.sandbox ?? 'workspace-write';
    if (!SANDBOXES.includes(sandbox)) {
      throw new AgentError('invalid', `unknown sandbox ${JSON.stringify(sandbox)}`, `"read-only" or "workspace-write" (there is no wider mode)`);
    }
    if (opts.model !== undefined && !MODEL_NAME.test(opts.model)) {
      throw new AgentError('invalid', `invalid model name ${JSON.stringify(opts.model)}`, 'a model name is letters, digits and . _ : / @ - (at most 80 characters), e.g. "gpt-5-codex" or "sonnet"');
    }
    if (opts.effort !== undefined && !EFFORTS.includes(opts.effort)) {
      throw new AgentError('invalid', `unknown effort ${JSON.stringify(opts.effort)}`, `one of ${EFFORTS.join(', ')}`);
    }
    const prompt = opts.prompt ?? '';
    if (typeof prompt !== 'string') throw new AgentError('invalid', '"prompt" must be a string');
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    if (promptBytes > this.maxPromptBytes) {
      throw new AgentError('too-large', `the prompt is ${promptBytes} bytes; at most ${this.maxPromptBytes} are accepted`, 'shorten the request, or put long material into a file of the workspace and name the file');
    }
    const context = opts.context ?? {};
    if (typeof context !== 'object' || context === null || Array.isArray(context)) throw new AgentError('invalid', '"context" must be a JSON object');
    if (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_CONTEXT_BYTES) {
      throw new AgentError('too-large', `"context" is larger than ${MAX_CONTEXT_BYTES} bytes`, 'pass file paths instead of file contents');
    }

    let previous: JobRecord | null = null;
    if (opts.resumeOf !== undefined) {
      previous = this.require(opts.resumeOf);
      if (!FINAL_STATES.includes(previous.info.state)) {
        throw new AgentError('not-resumable', `job ${previous.info.id} is still ${previous.info.state}`, 'wait until it has finished (or cancel it), then send the follow-up');
      }
      if (previous.info.provider !== provider.id) {
        throw new AgentError('invalid', `job ${previous.info.id} ran with ${previous.info.provider}; a follow-up continues with the same provider`, `send "provider": "${previous.info.provider}", or start a new job`);
      }
      if (!previous.info.sessionId) {
        throw new AgentError('not-resumable', `job ${previous.info.id} has no ${provider.name} session to continue (it ended before one started)`, 'start a new job instead');
      }
    }

    const cwd = this.checkCwd(opts.cwd);
    const images = this.checkImages(opts.images ?? []);
    const allowImageGeneration = opts.allowImageGeneration === true;
    const env: PromptEnv = { provider: provider.id, root: this.root, cwd, rev2dBin: this.rev2dBin, sandbox, allowImageGeneration, images, file: opts.file ?? null };
    const built = buildAgentPrompt({ kind: opts.kind, prompt, context, env, followUp: previous !== null });

    const detected = await this.detect(provider.id);
    if (!detected.command) throw new AgentError('unavailable', `${provider.name} is not available`, detected.info.hint ?? provider.installHint);
    if (this.closed) throw new AgentError('closed', 'the agent runner was closed');
    // Nothing is awaited between this check and the reservation below: two starts cannot both pass.
    this.checkIdle();

    const run: ProviderRun = {
      cwd,
      sandbox,
      images,
      allowImageGeneration,
      rev2dBin: this.rev2dBin,
      platform: this.platform,
      // Read now, from the server's settings: never from the job options.
      codexWindowsSandbox: this.effectiveCodexWindowsSandbox(),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(previous ? { resumeSession: previous.info.sessionId! } : {}),
      ...(detected.help !== undefined ? { help: detected.help } : {}),
    };
    const id = randomBytes(6).toString('hex');
    const info: AgentJobInfo = {
      id,
      provider: provider.id,
      kind: opts.kind ?? 'freeform',
      title: built.title,
      state: 'queued',
      cwd,
      sandbox,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      allowImageGeneration,
      images,
      sessionId: previous?.info.sessionId ?? null,
      resumeOf: previous?.info.id ?? null,
      conversation: previous?.info.conversation ?? id,
      createdAt: this.iso(),
      startedAt: null,
      endedAt: null,
      exitCode: null,
      error: null,
      finalMessage: null,
      usage: null,
      lastSeq: 0,
      logFile: null,
    };
    let resolveDone!: (info: AgentJobInfo) => void;
    const done = new Promise<AgentJobInfo>((resolve) => (resolveDone = resolve));
    const job: JobRecord = {
      info,
      prompt: built.task,
      input: built.text + (provider.promptSuffix?.(run) ?? ''),
      events: [],
      provider,
      command: detected.command,
      run,
      parser: provider.createParser(),
      child: null,
      log: null,
      cancelRequested: false,
      timedOut: null,
      spawnError: null,
      failure: null,
      lastError: null,
      diagnosed: new Set(),
      stderrTail: '',
      finished: false,
      timers: {},
      done,
      resolveDone,
    };
    this.active = job;
    this.jobs.set(id, job);
    this.trimJobs();
    this.emit(job, { type: 'status', status: 'queued', text: `${provider.name} job queued` });
    setImmediate(() => this.launch(job));
    return snapshot(info);
  }

  /**
   * A follow-up message in the provider session of a finished job: a new job that resumes it, with
   * the same provider, working directory, sandbox, model and effort.
   */
  async message(id: string, prompt: string, opts: { images?: string[]; allowImageGeneration?: boolean } = {}): Promise<AgentJobInfo> {
    const previous = this.require(id).info;
    return this.start({
      provider: previous.provider,
      prompt,
      cwd: previous.cwd,
      sandbox: previous.sandbox,
      ...(previous.model ? { model: previous.model } : {}),
      ...(previous.effort ? { effort: previous.effort } : {}),
      ...(opts.images ? { images: opts.images } : {}),
      allowImageGeneration: opts.allowImageGeneration ?? previous.allowImageGeneration,
      resumeOf: id,
    });
  }

  private checkIdle(): void {
    const active = this.active;
    if (!active) return;
    throw new AgentError(
      'busy',
      `another agent job is ${active.info.state} (${active.info.id}, ${active.provider.name}: ${active.info.title})`,
      'one job runs at a time: wait for it to finish, or cancel it (POST /api/agent/jobs/<id>/cancel)',
      { job: active.info.id },
    );
  }

  /** The absolute working directory, checked to be a directory inside the root (links resolved). */
  private checkCwd(cwd: unknown): string {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new AgentError('invalid', 'the working directory must be an absolute path', `the workspace root ${this.root} or a folder inside it`);
    const abs = path.resolve(cwd);
    let real: string;
    try {
      if (!statSync(abs).isDirectory()) throw new Error('not a directory');
      real = realpathSync.native(abs);
    } catch {
      throw new AgentError('invalid', `the working directory ${abs} is not an existing directory`, `use the workspace root ${this.root} or a folder inside it`);
    }
    if (!within(this.realRoot, real)) {
      throw new AgentError('invalid', `the working directory ${abs} is outside the workspace root ${this.root}`, 'agents only run inside the workspace root');
    }
    return abs;
  }

  private checkImages(images: unknown): string[] {
    if (!Array.isArray(images)) throw new AgentError('invalid', '"images" must be a list of file paths');
    if (images.length > MAX_IMAGES) throw new AgentError('invalid', `at most ${MAX_IMAGES} images can be attached (got ${images.length})`);
    return images.map((image, i) => {
      if (typeof image !== 'string' || !path.isAbsolute(image)) throw new AgentError('invalid', `images.${i} must be an absolute file path`);
      const abs = path.resolve(image);
      const st = statSync(abs, { throwIfNoEntry: false });
      if (!st?.isFile()) throw new AgentError('invalid', `image ${abs} does not exist`, 'attach image files of the workspace');
      if (!IMAGE_NAME.test(abs)) throw new AgentError('invalid', `${abs} is not an image file`, 'attach PNG, JPEG, WebP or GIF files');
      if (st.size > MAX_IMAGE_BYTES) throw new AgentError('too-large', `image ${abs} is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
      let real: string;
      try {
        real = realpathSync.native(abs);
      } catch {
        throw new AgentError('invalid', `image ${abs} cannot be resolved`);
      }
      if (!within(this.realRoot, real)) throw new AgentError('invalid', `image ${abs} is outside the workspace root ${this.root}`, 'copy it into the workspace first (File > Import)');
      return abs;
    });
  }

  private trimJobs(): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.maxJobs) break;
      if (job !== this.active && job.finished) this.jobs.delete(id);
    }
  }

  // --------------------------------------------------------------------------- running

  private launch(job: JobRecord): void {
    if (job.finished) return; // cancelled while queued
    const { info, provider } = job;
    let args: string[];
    try {
      args = provider.buildArgs(job.run);
      assertSafeArgs(args);
    } catch (e) {
      job.spawnError = (e as Error).message;
      this.finish(job, null);
      return;
    }
    if (this.logDir !== null) {
      job.log = JobLog.create(this.logDir, logFileName(this.now(), provider.id, info.id), { keep: this.maxLogFiles, onError: this.log });
      info.logFile = job.log?.file ?? null;
      job.log?.write({ kind: 'job', job: snapshot(info), command: [job.command.file, ...job.command.args, ...args], prompt: job.input });
      // Events emitted before the log existed (queued).
      for (const e of job.events) job.log?.write({ kind: 'event', ...e });
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCommand(job.command, args, { cwd: info.cwd, env: this.env });
    } catch (e) {
      job.spawnError = (e as Error).message;
      this.finish(job, null);
      return;
    }
    job.child = child;
    info.state = 'running';
    info.startedAt = this.iso();
    this.emit(job, { type: 'status', status: 'running', text: `${provider.name} started${child.pid ? ` (pid ${child.pid})` : ''}` });

    const stdout = new LineSplitter((line, truncated) => this.onStdout(job, line, truncated));
    const stderr = new LineSplitter((line) => this.onStderr(job, line));
    child.stdout.on('data', (chunk: Buffer) => {
      this.touch(job);
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.touch(job);
      stderr.push(chunk);
    });
    child.on('error', (e: Error) => {
      // Without a pid the program could not be started (it vanished since it was detected): the job
      // fails. Later errors (a signal that could not be delivered) are only noted.
      if (child.pid === undefined) {
        job.spawnError = e.message;
        this.detected.delete(provider.id);
        this.finish(job, null);
      } else {
        this.log(`${provider.name} process error: ${e.message}`);
      }
    });
    child.once('close', (code) => {
      stdout.end();
      stderr.end();
      this.finish(job, code);
    });
    // The process may exit before it read everything (EPIPE): that is its exit code's story.
    child.stdin.on('error', () => undefined);
    child.stdin.end(job.input, 'utf8');

    if (this.timeoutMs > 0) {
      job.timers.wall = setTimeout(() => this.stop(job, 'timeout'), this.timeoutMs);
    }
    this.touch(job);
    this.watchStall(job);
  }

  /** Restart the idle timer: the process just produced output. */
  private touch(job: JobRecord): void {
    if (this.idleTimeoutMs <= 0 || job.finished) return;
    clearTimeout(job.timers.idle);
    job.timers.idle = setTimeout(() => this.stop(job, 'idle-timeout'), this.idleTimeoutMs);
  }

  /**
   * (Re)start the stall watchdog: called when the job starts and after every event of the provider.
   * When the provider then stays silent for `stallMs`, the job gets ONE `status` event "stalled" with
   * the provider's hint; it is not stopped (the idle timeout is what stops a job), and the watchdog
   * only starts again with the provider's next event.
   */
  private watchStall(job: JobRecord): void {
    clearTimeout(job.timers.stall);
    if (this.stallMs <= 0 || job.finished || !job.provider.stallNotice) return;
    job.timers.stall = setTimeout(() => {
      if (job.finished) return;
      const notice = job.provider.stallNotice?.(job.run, this.stallMs);
      if (notice) this.emit(job, { type: 'status', status: 'stalled', text: notice.text, hint: notice.hint, code: notice.code });
    }, this.stallMs);
  }

  /** Report a problem the provider recognises (its sandbox cannot start commands, ...) once per job and code. */
  private diagnose(job: JobRecord, seen: { event?: AgentEventBody; stderr?: string }): void {
    const known = job.provider.diagnose?.(seen, job.run);
    if (!known || job.diagnosed.has(known.code)) return;
    job.diagnosed.add(known.code);
    this.emit(job, { type: 'error', message: known.message, hint: known.hint, code: known.code });
  }

  private onStdout(job: JobRecord, line: string, truncated: boolean): void {
    if (!line.trim()) return;
    const time = this.iso();
    job.log?.raw('stdout', time, line);
    if (truncated) {
      this.emit(job, { type: 'error', message: `${job.provider.name} wrote a line too long to read; it was skipped` });
      return;
    }
    const parsed = job.parser.line(line);
    if (parsed.sessionId) job.info.sessionId = parsed.sessionId;
    if (parsed.usage) job.info.usage = addUsage(job.info.usage, parsed.usage);
    if (parsed.failure) job.failure = parsed.failure;
    for (const event of parsed.events) {
      if (event.type === 'message') job.info.finalMessage = event.text;
      if (event.type === 'error') job.lastError = event.message;
      this.emit(job, event);
      this.diagnose(job, { event });
    }
    if (parsed.finalMessage) job.info.finalMessage = parsed.finalMessage;
    // The provider is alive and reporting: the stall watchdog starts over.
    if (parsed.events.length) this.watchStall(job);
  }

  private onStderr(job: JobRecord, line: string): void {
    if (!line.trim()) return;
    job.log?.raw('stderr', this.iso(), line);
    job.stderrTail = `${job.stderrTail}${line}\n`.slice(-STDERR_TAIL_CHARS);
    this.diagnose(job, { stderr: line });
  }

  /** Stop a running job because of a timeout. */
  private stop(job: JobRecord, why: 'timeout' | 'idle-timeout'): void {
    if (job.finished || job.timedOut || job.cancelRequested) return;
    job.timedOut = why;
    this.kill(job);
  }

  /** Kill the job's process tree; if the process does not report its end, the job is closed anyway. */
  private kill(job: JobRecord): void {
    const pid = job.child?.pid;
    if (pid === undefined) {
      this.finish(job, null);
      return;
    }
    void killTree(pid, this.killGraceMs);
    job.timers.kill = setTimeout(() => this.finish(job, null), this.killGraceMs + 5000);
  }

  /**
   * Cancel a queued or running job: its process tree is killed and the job ends as "cancelled".
   * Resolves with the job once it has ended; a job that already ended is returned as it is.
   */
  async cancel(id: string): Promise<AgentJobInfo> {
    const job = this.require(id);
    if (job.finished) return snapshot(job.info);
    if (!job.cancelRequested) {
      job.cancelRequested = true;
      this.kill(job);
    }
    return job.done;
  }

  private finish(job: JobRecord, code: number | null): void {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.timers.wall);
    clearTimeout(job.timers.idle);
    clearTimeout(job.timers.kill);
    clearTimeout(job.timers.stall);
    const { info, provider } = job;
    info.exitCode = code;
    info.endedAt = this.iso();

    let state: 'done' | 'failed' | 'cancelled';
    let reason: AgentDoneReason;
    let error: { message: string; hint?: string } | null = null;
    if (job.cancelRequested) {
      state = 'cancelled';
      reason = 'cancelled';
      error = { message: 'the job was cancelled' };
    } else if (job.timedOut === 'timeout') {
      state = 'failed';
      reason = 'timeout';
      error = { message: `the job ran longer than ${minutes(this.timeoutMs)} and was stopped`, hint: 'split the task into smaller requests, or continue it with a follow-up message' };
    } else if (job.timedOut === 'idle-timeout') {
      state = 'failed';
      reason = 'idle-timeout';
      error = { message: `${provider.name} produced no output for ${minutes(this.idleTimeoutMs)} and was stopped`, hint: 'it may have been waiting for input or a network answer; try again, or continue with a follow-up message' };
    } else if (job.spawnError !== null) {
      state = 'failed';
      reason = 'spawn-error';
      error = { message: `${provider.name} could not be started: ${job.spawnError}`, hint: provider.installHint };
    } else if (code === 0 && job.failure === null) {
      state = 'done';
      reason = 'completed';
    } else {
      state = 'failed';
      reason = 'failed';
      const said = job.failure ?? job.lastError;
      const message = said ?? (lastLine(job.stderrTail) || (code === null ? `${provider.name} ended without an exit code` : `${provider.name} exited with code ${code}`));
      const auth = provider.isAuthError(`${job.failure ?? ''}\n${job.lastError ?? ''}\n${job.stderrTail}`);
      error = { message, ...(auth ? { hint: provider.loginHint } : {}) };
      // Problems the provider did not report as an event itself (stderr, a bare exit code).
      if (said === null || auth) this.emit(job, { type: 'error', message, ...(auth ? { hint: provider.loginHint } : {}) });
    }
    // Timeouts and start failures are the runner's own findings: say them in the event stream too.
    if (error && (reason === 'timeout' || reason === 'idle-timeout' || reason === 'spawn-error')) {
      this.emit(job, { type: 'error', message: error.message, ...(error.hint ? { hint: error.hint } : {}) });
    }
    info.state = state;
    info.error = error;
    this.emit(job, {
      type: 'done',
      state,
      reason,
      exitCode: code,
      message: info.finalMessage,
      ...(error ? { error: error.message } : {}),
      ...(error?.hint ? { hint: error.hint } : {}),
    });
    job.log?.close();
    job.child = null;
    if (this.active === job) this.active = null;
    job.resolveDone(snapshot(info));
  }

  private emit(job: JobRecord, body: AgentEventBody): void {
    const event = { seq: ++job.info.lastSeq, time: this.iso(), ...body } as AgentEvent;
    job.events.push(event);
    if (job.events.length > this.maxEvents) job.events.splice(0, job.events.length - this.maxEvents);
    job.log?.write({ kind: 'event', ...event });
    if (!this.listeners.size) return;
    const info = snapshot(job.info);
    for (const listener of this.listeners) {
      try {
        listener(info, event);
      } catch (e) {
        this.log(`agent listener failed: ${(e as Error).message}`);
      }
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Stop accepting jobs and cancel the active one (its process tree is killed). */
  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    if (active) await this.cancel(active.info.id).catch(() => undefined);
    this.listeners.clear();
  }
}

function snapshot(info: AgentJobInfo): AgentJobInfo {
  return { ...info, images: [...info.images], error: info.error ? { ...info.error } : null, usage: info.usage ? { ...info.usage } : null };
}
