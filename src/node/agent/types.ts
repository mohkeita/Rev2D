/**
 * Types of the in-app agent bridge: the editor starts a coding agent (the Codex CLI or Claude Code),
 * follows its progress as ONE normalised event stream and reloads the result (docs/AGENT-BRIDGE.md).
 *
 * This file holds types only (plus AgentError and one event code, which import nothing), so the editor
 * UI can import it type-only; src/node/editor-registry.ts re-exports the protocol types.
 */

export type AgentProviderId = 'codex' | 'claude';

/**
 * What the agent may do to the file system. "read-only": look and answer. "workspace-write": also
 * create and change files inside the job's working directory. There is no wider mode on purpose.
 */
export type AgentSandbox = 'read-only' | 'workspace-write';

/** Reasoning effort; each provider maps the levels it does not have to its nearest one. */
export type AgentEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * queued: accepted, the process is not started yet; running: the provider process runs;
 * done: it finished its turn; failed: it could not start, reported an error, exited non-zero or hit a
 * timeout; cancelled: stopped by POST .../cancel (or the editor server shutting down).
 */
export type AgentJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** One provider as GET /api/agent/providers lists it. */
export interface AgentProviderInfo {
  id: AgentProviderId;
  /** Display name, e.g. "Codex CLI". */
  name: string;
  /** Whether the CLI was found (on PATH or through its REV2D_AGENT_* override) and answered --version. */
  available: boolean;
  /** Version the CLI reports, e.g. "0.160.0"; null when it is not available. */
  version: string | null;
  features: {
    /** The agent has a built-in image generator (jobs still need allowImageGeneration to use it). */
    imageGeneration: boolean;
  };
  /** Effort levels the provider knows (others are mapped to the nearest of these). */
  efforts: AgentEffort[];
  /** What to do when it is not available (how to install it, what went wrong). */
  hint?: string;
  /**
   * Codex on Windows only: the sandbox implementation the bridge asks Codex for (the effective
   * `codexWindowsSandbox` setting, see AgentSettings).
   */
  windowsSandbox?: CodexWindowsSandbox;
}

/**
 * Which of Codex's two Windows sandbox implementations a job uses. "config": whatever the person's
 * Codex configuration says (`[windows] sandbox` in ~/.codex/config.toml; "elevated" needs a one-time
 * administrator setup and fails to start commands when that setup is broken). "unelevated": the bridge
 * adds `-c windows.sandbox="unelevated"`, the implementation that needs no setup. Both keep the job's
 * read-only / workspace-write sandbox; the setting has no effect outside Windows or for Claude Code.
 */
export type CodexWindowsSandbox = 'config' | 'unelevated';

/** Settings of the agent bridge a person can change (GET / PUT /api/agent/settings). */
export interface AgentSettings {
  codexWindowsSandbox: CodexWindowsSandbox;
}

/**
 * Where an effective setting comes from, strongest first: "option" (startEditorServer({agent})),
 * "flag" (a `rev2d edit` flag), "user" (~/.rev2d/settings.json, written by PUT /api/agent/settings),
 * "default".
 */
export type AgentSettingSource = 'option' | 'flag' | 'user' | 'default';

/** GET / PUT /api/agent/settings. */
export interface AgentSettingsInfo {
  /** The effective settings: what the next job uses. */
  settings: AgentSettings;
  /** Where each effective value comes from. */
  sources: Record<keyof AgentSettings, AgentSettingSource>;
  /** What the person's settings file holds (it loses against an option or a flag). */
  user: Partial<AgentSettings>;
  /** Absolute path of the settings file; null: this server keeps the user settings in memory only. */
  file: string | null;
  /** Whether the server runs on Windows (codexWindowsSandbox has no effect elsewhere). */
  windows: boolean;
  /** Things worth telling the person: an unreadable settings file, a saved value that a flag overrides. */
  notes: string[];
}

/** Code of the error / status events about a Codex Windows sandbox that cannot start commands. */
export const CODEX_WINDOWS_SANDBOX_CODE = 'codex-windows-sandbox';

/** started / updated: the item is in progress; completed: its final form (status says how it ended). */
export type AgentItemPhase = 'started' | 'updated' | 'completed';
export type AgentItemStatus = 'running' | 'completed' | 'failed' | 'declined';

export interface AgentFileChange {
  /** Path as the provider reports it (absolute, or relative to the job's working directory). */
  path: string;
  kind: 'add' | 'update' | 'delete';
}

export interface AgentUsage {
  inputTokens: number;
  /** Part of inputTokens served from the provider's prompt cache. */
  cachedInputTokens: number;
  outputTokens: number;
  /** Part of outputTokens spent on reasoning (0 when the provider does not say). */
  reasoningTokens: number;
  /** Cost in USD when the provider reports one (Claude Code). */
  costUsd?: number;
}

/** Why a job ended (the "done" event). */
export type AgentDoneReason = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'idle-timeout' | 'spawn-error';

/**
 * A normalised event without its envelope. Items (command, file, tool, todo) keep the provider's item
 * id: an item is reported when it starts and again when it changes or completes, so a UI keeps one row
 * per `id` and replaces it. Long texts are cut (`truncated`); command output keeps its tail.
 */
export type AgentEventBody =
  /**
   * Progress that is not agent output: queued, running, session (with sessionId), turn, retry, and
   * stalled (the provider has been silent for a while; the job keeps running; `hint` and `code` say
   * what may be wrong).
   */
  | { type: 'status'; status: string; text: string; sessionId?: string; hint?: string; code?: string }
  /** A message of the agent to the person. The last one of a job is its final message. */
  | { type: 'message'; text: string; truncated?: boolean }
  /** A reasoning summary. */
  | { type: 'reasoning'; text: string; truncated?: boolean }
  /** A shell command: its command line, exit code (null while running / unknown) and the tail of its output. */
  | { type: 'command'; id: string; phase: AgentItemPhase; status: AgentItemStatus; command: string; exitCode: number | null; output: string; outputTruncated: boolean }
  /** Files the agent created, changed or deleted. */
  | { type: 'file'; id: string; phase: AgentItemPhase; status: AgentItemStatus; changes: AgentFileChange[] }
  /** Any other tool call (MCP tools, web search, image generation, file reads): name plus short previews. */
  | { type: 'tool'; id: string; phase: AgentItemPhase; status: AgentItemStatus; tool: string; server?: string; input?: string; result?: string; error?: string }
  /** The agent's to-do list (the whole list every time). */
  | { type: 'todo'; id: string; items: Array<{ text: string; done: boolean }> }
  /** Token usage of the turn. */
  | ({ type: 'usage' } & AgentUsage)
  /**
   * A problem the provider or the runner reports; `hint` says what to do (e.g. how to log in). A
   * problem the runner recognises has a stable `code` (e.g. "codex-windows-sandbox") and is reported
   * once per job.
   */
  | { type: 'error'; message: string; hint?: string; code?: string }
  /** Always the last event of a job. `message` is the agent's final message (null when it wrote none). */
  | { type: 'done'; state: 'done' | 'failed' | 'cancelled'; reason: AgentDoneReason; exitCode: number | null; message: string | null; error?: string; hint?: string };

export type AgentEventType = AgentEventBody['type'];

/** A normalised event: `seq` counts from 1 inside its job, `time` is an ISO 8601 timestamp. */
export type AgentEvent = { seq: number; time: string } & AgentEventBody;

/** A job without its events and without the full prompt (GET /api/agent/jobs/:id returns those). */
export interface AgentJobInfo {
  id: string;
  provider: AgentProviderId;
  /** Task template the prompt was built with ("freeform" = the person's own text). */
  kind: string;
  /** First line of the request, at most 80 characters (for lists). */
  title: string;
  state: AgentJobState;
  /** Absolute working directory of the agent: the workspace root or a project folder inside it. */
  cwd: string;
  sandbox: AgentSandbox;
  model: string | null;
  effort: AgentEffort | null;
  allowImageGeneration: boolean;
  /** Absolute paths of the attached images. */
  images: string[];
  /** Provider session (Codex thread id, Claude session id) once known; follow-ups resume it. */
  sessionId: string | null;
  /** The job this one continues (a follow-up message), else null. */
  resumeOf: string | null;
  /** Id of the first job of the conversation (its own id for a job that starts one). */
  conversation: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Exit code of the provider process (null while it runs, or when it was killed). */
  exitCode: number | null;
  /** Why it failed or was cancelled, with what to do about it. */
  error: { message: string; hint?: string } | null;
  /** The agent's final message. */
  finalMessage: string | null;
  usage: AgentUsage | null;
  /** Sequence number of the newest event (0: none yet). */
  lastSeq: number;
  /** Absolute path of the job's log file (raw provider lines + normalised events), or null. */
  logFile: string | null;
}

/** Events of a job after `since`. `firstSeq` > since + 1 means older events were dropped (the in-memory cap). */
export interface AgentJobEvents {
  events: AgentEvent[];
  /** Sequence number of the oldest event still in memory (0: none). */
  firstSeq: number;
  lastSeq: number;
}

/** What a caller passes to AgentManager.start. */
export interface AgentStartOptions {
  provider: AgentProviderId;
  /** The request in the person's words (task templates may not need one). */
  prompt?: string;
  /** Task template (default "freeform"). */
  kind?: string;
  /** Input of the task template (JSON values). */
  context?: Record<string, unknown>;
  /** Absolute working directory; must be the manager's root or lie inside it. */
  cwd: string;
  /** Absolute image paths inside the root (attached to the prompt). */
  images?: string[];
  model?: string;
  effort?: AgentEffort;
  /** Default "workspace-write". */
  sandbox?: AgentSandbox;
  /** Default false: the agent is told not to generate images (and Codex's generator is switched off). */
  allowImageGeneration?: boolean;
  /** Id of a finished job whose provider session this job continues. */
  resumeOf?: string;
  /** Model file the request is about (absolute; told to the agent). */
  file?: string | null;
}

export type AgentErrorCode =
  /** A malformed option (400). */
  | 'invalid'
  /** The prompt is larger than the cap (413). */
  | 'too-large'
  /** No such job (404). */
  | 'unknown-job'
  /** Another job is queued or running (409). */
  | 'busy'
  /** The job cannot be continued: still running, or it never got a provider session (409). */
  | 'not-resumable'
  /** The provider CLI is not installed or does not start (409). */
  | 'unavailable'
  /** Too many starts in a short time (429). */
  | 'rate-limited'
  /** The person's settings file cannot be read as JSON or cannot be written (409). */
  | 'settings-file'
  /** The manager was closed (503). */
  | 'closed';

/** An error of the agent runner: a stable `code`, a message and, whenever possible, a hint with the fix. */
export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly hint?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AgentError';
  }
}
