/**
 * What a provider (an agent CLI) has to supply: how to find it, how to build its command line and how
 * to turn its JSON-lines output into normalised events. docs/AGENT-BRIDGE.md explains how to add one.
 */
import type { AgentEffort, AgentEventBody, AgentProviderId, AgentSandbox, AgentUsage, CodexWindowsSandbox } from './types.js';

/** One run of a provider, after every option was validated by the manager. */
export interface ProviderRun {
  /** Absolute working directory. */
  cwd: string;
  sandbox: AgentSandbox;
  /** Absolute image paths. */
  images: string[];
  model?: string;
  effort?: AgentEffort;
  allowImageGeneration: boolean;
  /** Provider session to continue (a follow-up), else undefined. */
  resumeSession?: string;
  /** Absolute path of bin/rev2d.js: the one program a provider without an OS sandbox may run. */
  rev2dBin: string;
  /** The CLI's --help text when the provider asked for it (`needsHelp`), to adapt to its version. */
  help?: string;
  /** The platform the command line is built for (process.platform; tests set it). */
  platform: NodeJS.Platform;
  /** The effective `codexWindowsSandbox` setting (it only matters to Codex on Windows). */
  codexWindowsSandbox: CodexWindowsSandbox;
}

/** A problem a provider recognises, with a stable code and what to do about it. */
export interface ProviderProblem {
  code: string;
  message: string;
  hint: string;
}

/** What one line of provider output means. */
export interface ParsedLine {
  events: AgentEventBody[];
  /** The provider session id announced by this line. */
  sessionId?: string;
  /** The provider says the turn failed; the job fails even when the process exits 0. */
  failure?: string;
  /** The provider's own final answer of the turn (when it repeats it in a result line). */
  finalMessage?: string;
  usage?: AgentUsage;
  /** The line was not understood (kept in the raw log only). */
  unknown?: boolean;
}

export interface StreamParser {
  /** Parse one stdout line. Never throws: a line that is not JSON gives {events: [], unknown: true}. */
  line(text: string): ParsedLine;
}

export interface AgentProvider {
  id: AgentProviderId;
  name: string;
  /** Program name looked up on PATH. */
  bin: string;
  /** Environment variable naming the executable (or its .js entry script) instead of PATH. */
  envOverride: string;
  features: { imageGeneration: boolean };
  efforts: AgentEffort[];
  /** How to install the CLI (shown when it is not found). */
  installHint: string;
  /** How to sign in (shown when a run fails with an authentication error). */
  loginHint: string;
  /** Whether --help is read once before the first run (to use only flags this version has). */
  needsHelp?: boolean;
  /** Version from the CLI's --version output, or null. */
  parseVersion(text: string): string | null;
  /** Whether an error text / stderr tail means "not signed in". */
  isAuthError(text: string): boolean;
  /** Arguments after the program. The prompt is NOT among them: it is written to stdin. */
  buildArgs(run: ProviderRun): string[];
  /** How the images reach the agent when the CLI has no flag for them: text appended to the prompt. */
  promptSuffix?(run: ProviderRun): string;
  /**
   * A known problem visible in an event or in a line the CLI wrote to stderr (e.g. its own sandbox
   * failing to start a command), with what to do about it. The manager reports each code once per job
   * as an `error` event.
   */
  diagnose?(seen: { event?: AgentEventBody; stderr?: string }, run: ProviderRun): ProviderProblem | null;
  /**
   * What to tell the person when the provider has produced no event for `silentMs` while the job
   * runs (a `status` event "stalled"; the job is not stopped). Null: no such notice for this run.
   */
  stallNotice?(run: ProviderRun, silentMs: number): { text: string; hint: string; code: string } | null;
  createParser(): StreamParser;
}

// ----------------------------------------------------------------------------- text limits

/** Longest agent message kept in an event. */
export const MAX_MESSAGE_CHARS = 64_000;
/** Longest reasoning summary kept in an event. */
export const MAX_REASONING_CHARS = 16_000;
/** Tail of a command's output kept in an event. */
export const MAX_OUTPUT_CHARS = 4_000;
/** Longest tool input / result preview. */
export const MAX_PREVIEW_CHARS = 2_000;

/** `text` cut to its first `max` characters. */
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** The last `max` characters of `text`. */
export function tail(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(text.length - max), truncated: true } : { text, truncated: false };
}

/** A short one-value preview: strings as they are, everything else as compact JSON. */
export function preview(value: unknown, max = MAX_PREVIEW_CHARS): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Session ids are passed back on a command line: accept only plain identifiers (UUIDs, thread names). */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Parse a JSON-lines record; null when the line is not a JSON object. */
export function parseRecord(line: string): Record<string, unknown> | null {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------- command-line safety

/**
 * The config overrides a provider may put on the command line (Codex `-c key=value`), as whole
 * arguments: the reasoning effort, and the one Windows sandbox implementation that needs no setup
 * (it replaces another sandbox implementation, not the sandbox: -s still says read-only / workspace-write).
 */
const ALLOWED_CONFIG_OVERRIDES = [/^model_reasoning_effort="(?:minimal|low|medium|high|xhigh|max)"$/, /^windows\.sandbox="unelevated"$/];

function checkConfigOverride(override: string): void {
  if (!ALLOWED_CONFIG_OVERRIDES.some((allowed) => allowed.test(override))) {
    throw new Error(`refusing to start an agent with the config override ${override.split('=')[0].trim() || override}`);
  }
}

/**
 * Last line of defence against a command line that would lift the sandbox: throws when `args`
 * contains a bypass flag, the danger-full-access sandbox, the bypassPermissions mode or a config
 * override other than the exact few a provider is allowed to set. Every provider's arguments pass
 * through here before a process starts.
 */
export function assertSafeArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const lower = a.toLowerCase();
    if (lower.startsWith('--dangerously') || lower.startsWith('--allow-dangerously') || lower === '--yolo' || lower === '--full-auto') {
      throw new Error(`refusing to start an agent with the bypass flag ${a}`);
    }
    if (lower === 'danger-full-access' || lower === 'bypasspermissions') throw new Error(`refusing to start an agent with ${a}`);
    const prev = args[i - 1];
    if (prev === '-c' || prev === '--config') checkConfigOverride(a);
    // The attached spellings: --config=key=value and -ckey=value.
    const attached = /^--config=(.*)$/s.exec(a) ?? /^-c(.+=.*)$/s.exec(a);
    if (attached) checkConfigOverride(attached[1]);
    if (/^(?:-s|--sandbox|--permission-mode)=/.test(lower) && /danger|bypass/.test(lower)) throw new Error(`refusing to start an agent with ${a}`);
  }
}
