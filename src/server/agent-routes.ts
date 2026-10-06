/**
 * The in-app agent bridge of the editor server (docs/AGENT-BRIDGE.md): the editor UI starts a coding
 * agent (Codex CLI, Claude Code) for a request, follows it live and continues it with follow-ups.
 *
 *   GET  /api/session                        -> {token, agent: {enabled, reason?}}
 *   GET  /api/agent/providers                -> AgentProviderInfo[]
 *   GET  /api/agent/tasks                    -> AgentTaskInfo[] (task templates; "freeform" = the person's own text)
 *   GET  /api/agent/jobs                     -> {jobs: AgentJobInfo[] (newest first), active: id | null}
 *   POST /api/agent/jobs   AgentStartRequest -> 202 {job}
 *   GET  /api/agent/jobs/:id?since=<seq>     -> {job, prompt, events, firstSeq, lastSeq}
 *   POST /api/agent/jobs/:id/cancel          -> {job}
 *   POST /api/agent/jobs/:id/message {prompt, images?, allowImageGeneration?} -> 202 {job} (same provider session)
 *   GET  /api/agent/settings                 -> AgentSettingsInfo {settings, sources, user, file, windows, notes}
 *   PUT  /api/agent/settings {codexWindowsSandbox} -> AgentSettingsInfo (writes the person's settings file)
 *   SSE "agent-job" {job, state, event} on GET /api/events for every event of every job
 *
 * These endpoints start local programs with the person's credentials, so they are guarded more
 * strictly than the rest of the API:
 * - they only exist while the server is bound to a loopback address (or was started with allowAgent:
 *   `rev2d edit --allow-agent`); otherwise every /api/agent/* request answers 404;
 * - the server's Host / Origin checks apply as everywhere (index.ts);
 * - every request needs the per-server random token in an X-Rev2D-Token header. GET /api/session
 *   hands it out, to same-origin pages and non-browser clients only: a foreign web page can neither
 *   read it (no CORS headers; cross-site fetches are refused) nor send the header (preflight refused);
 * - the working directory is the workspace root or a folder inside it (`context.project`, resolved
 *   through WorkspaceRoot like every file path), images must lie inside the root, the prompt size is
 *   capped and starts are rate-limited;
 * - the runner (src/node/agent) only knows the read-only and workspace-write sandboxes and never
 *   passes user text through a shell;
 * - settings of the bridge (which Windows sandbox implementation Codex uses) come from the server's
 *   options, a `rev2d edit` flag or the person's settings file, never from a job request.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentJobDetail, AgentJobEventPayload, AgentJobList, AgentTaskInfo, SessionInfo } from '../node/editor-registry.js';
import { AgentError, AgentManager, AgentSettingsStore, taskTemplates, type AgentErrorCode, type AgentManagerOptions, type CodexWindowsSandbox } from '../node/agent/index.js';
import { HttpError, normalizeHostname, readJson, sendJson } from './http.js';
import { parseAgentMessageRequest, parseAgentSettingsRequest, parseAgentStartRequest } from './protocol.js';
import type { ApiContext } from './routes.js';
import type { SseHub } from './sse.js';

/** Settings of the agent bridge (EditorServerOptions.agent); tests point `commands` at fake agents. */
export interface AgentBridgeOptions
  extends Pick<AgentManagerOptions, 'commands' | 'logDir' | 'maxLogFiles' | 'timeoutMs' | 'idleTimeoutMs' | 'stallMs' | 'maxEvents' | 'maxJobs' | 'maxPromptBytes' | 'env' | 'rev2dBin' | 'platform'> {
  /** Jobs (starts and follow-ups) accepted per minute (default 10). */
  maxStartsPerMinute?: number;
  /** Clock in ms (default Date.now). */
  now?: () => number;
  /**
   * Codex's sandbox implementation on Windows: "config" (leave the person's Codex configuration
   * alone) or "unelevated" (add `-c windows.sandbox="unelevated"`). Given here it beats the person's
   * settings file; left out, the file decides (default "config"). A job request can never set it.
   */
  codexWindowsSandbox?: CodexWindowsSandbox;
  /** What a `codexWindowsSandbox` given here is called in GET /api/agent/settings (default "option"; the CLI passes "flag"). */
  settingsSource?: 'option' | 'flag';
  /**
   * The person's settings file, read for the settings not given here and written by PUT
   * /api/agent/settings. Default ~/.rev2d/settings.json when the server registers itself (`register`),
   * else none; null = keep the user settings in memory only.
   */
  settingsFile?: string | null;
}

export const AGENT_PREFIX = '/api/agent';
export const AGENT_ENDPOINTS = [
  'GET /api/session',
  'GET /api/agent/providers',
  'GET /api/agent/tasks',
  'GET /api/agent/jobs',
  'POST /api/agent/jobs',
  'GET /api/agent/jobs/:id',
  'POST /api/agent/jobs/:id/cancel',
  'POST /api/agent/jobs/:id/message',
  'GET /api/agent/settings',
  'PUT /api/agent/settings',
];

export const DEFAULT_STARTS_PER_MINUTE = 10;
/** Body limit of the agent endpoints (a prompt plus a few paths). */
const MAX_AGENT_BODY = 256 * 1024;
const TOKEN_HEADER = 'x-rev2d-token';

/** Whether a bind address is a loopback address: localhost, 127.0.0.0/8 or ::1. */
export function isLoopbackHost(host: string): boolean {
  let name: string;
  try {
    name = normalizeHostname(host);
  } catch {
    return false;
  }
  return name === 'localhost' || name === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

const HTTP_STATUS: Record<AgentErrorCode, number> = {
  invalid: 400,
  'too-large': 413,
  'unknown-job': 404,
  busy: 409,
  'not-resumable': 409,
  unavailable: 409,
  'rate-limited': 429,
  'settings-file': 409,
  closed: 503,
};

/** AgentError -> HttpError {error, hint, code, ...}; anything else is rethrown. */
function httpError(e: unknown): never {
  if (e instanceof AgentError) throw new HttpError(HTTP_STATUS[e.code], e.message, e.hint, { code: e.code, ...e.extra });
  throw e;
}

/** The server side of the bridge: the session token, the job manager and the start rate limit. */
export class AgentBridge {
  /** Random per server start; required in X-Rev2D-Token on every /api/agent request. */
  readonly token = randomBytes(32).toString('base64url');
  readonly enabled: boolean;
  /** Why the endpoints are disabled (null when they are enabled). */
  readonly reason: string | null;
  readonly manager: AgentManager | null;
  /** The settings a person can change (the Codex Windows sandbox) and where they come from. */
  readonly settings: AgentSettingsStore;
  /** Host names the server answers to (the Origin of a token request must name one of them). */
  readonly allowedHosts: ReadonlySet<string>;
  private readonly maxStarts: number;
  private readonly now: () => number;
  private starts: number[] = [];

  constructor(opts: {
    /** The address the server binds. */
    host: string;
    /** Keep the endpoints although `host` is not a loopback address. */
    allowAgent: boolean;
    /** Absolute workspace root: where agents may work. */
    root: string;
    sse: SseHub;
    allowedHosts: ReadonlySet<string>;
    log: (message: string) => void;
    /** The settings file used when the options name none (null: memory only). */
    defaultSettingsFile: string | null;
    options?: AgentBridgeOptions;
  }) {
    const { maxStartsPerMinute, now, codexWindowsSandbox, settingsSource, settingsFile, ...manager } = opts.options ?? {};
    this.settings = new AgentSettingsStore({
      file: settingsFile === undefined ? opts.defaultSettingsFile : settingsFile,
      ...(codexWindowsSandbox !== undefined ? { option: { codexWindowsSandbox } } : {}),
      ...(settingsSource !== undefined ? { optionSource: settingsSource } : {}),
      ...(manager.platform !== undefined ? { platform: manager.platform } : {}),
    });
    this.maxStarts = maxStartsPerMinute ?? DEFAULT_STARTS_PER_MINUTE;
    this.now = now ?? Date.now;
    this.allowedHosts = opts.allowedHosts;
    this.enabled = opts.allowAgent || isLoopbackHost(opts.host);
    this.reason = this.enabled
      ? null
      : `the editor is bound to ${opts.host || 'every interface'}, not a loopback address: agent runs (they use your Codex / Claude Code login) are only offered on 127.0.0.1 unless the editor is started with --allow-agent`;
    this.manager = this.enabled
      ? new AgentManager({
          root: opts.root,
          log: opts.log,
          ...(now ? { now } : {}),
          ...manager,
          // Asked at every job start, so a saved setting counts for the next job without a restart.
          codexWindowsSandbox: () => this.settings.get().codexWindowsSandbox,
        })
      : null;
    this.manager?.subscribe((job, event) => {
      const payload: AgentJobEventPayload = { job, state: job.state, event };
      opts.sse.broadcast('agent-job', payload);
    });
  }

  session(): SessionInfo {
    return this.enabled ? { token: this.token, agent: { enabled: true } } : { token: null, agent: { enabled: false, reason: this.reason! } };
  }

  /** Whether `given` is this server's token (compared in constant time). */
  checkToken(given: unknown): boolean {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(this.token, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** 429 when the starts of the last minute reached the limit. */
  checkRate(): void {
    const now = this.now();
    this.starts = this.starts.filter((t) => now - t < 60_000);
    if (this.starts.length < this.maxStarts) return;
    const wait = Math.max(1, Math.ceil((60_000 - (now - this.starts[0])) / 1000));
    throw new HttpError(
      429,
      `too many agent jobs were started (${this.maxStarts} in the last minute)`,
      `wait ${wait} s before starting another one`,
      { code: 'rate-limited' satisfies AgentErrorCode, retryAfter: wait },
      { 'Retry-After': String(wait) },
    );
  }

  recordStart(): void {
    this.starts.push(this.now());
  }

  /** Cancel the running job (its process tree is killed) and stop accepting jobs. */
  async close(): Promise<void> {
    await this.manager?.close();
  }
}

// ----------------------------------------------------------------------------- session

/**
 * GET /api/session: the token for /api/agent requests, and whether the bridge is enabled. Refused for
 * requests a browser marks as coming from another site or origin (their pages could not read the
 * answer anyway: the server sends no CORS headers).
 */
export function getSession(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): void {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, `forbidden ${site} request (Sec-Fetch-Site: ${site})`, "the session token is only given to the editor's own page and to non-browser clients");
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host: string | null = null;
    try {
      host = URL.canParse(origin) ? normalizeHostname(new URL(origin).host) : null;
    } catch {
      host = null;
    }
    if (!host || !ctx.agent.allowedHosts.has(host)) {
      throw new HttpError(403, `forbidden cross-origin request from ${JSON.stringify(origin)}`, "the session token is only given to the editor's own page and to non-browser clients");
    }
  }
  sendJson(res, 200, ctx.agent.session(), { 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' });
}

// ----------------------------------------------------------------------------- /api/agent/*

type AgentHandler = (ctx: ApiContext, manager: AgentManager, req: IncomingMessage, res: ServerResponse, url: URL, id: string) => Promise<void> | void;

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Route table: path below /api/agent with ":id" for a job id. */
const AGENT_ROUTES: Record<string, Partial<Record<string, AgentHandler>>> = {
  '/providers': { GET: getProviders },
  '/tasks': { GET: getTasks },
  '/jobs': { GET: getJobs, POST: postJob },
  '/jobs/:id': { GET: getJob },
  '/jobs/:id/cancel': { POST: postCancel },
  '/jobs/:id/message': { POST: postMessage },
  '/settings': { GET: getSettings, PUT: putSettings },
};

export async function handleAgentApi(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, pathname: string): Promise<void> {
  const bridge = ctx.agent;
  const method = req.method ?? 'GET';
  if (!bridge.enabled || !bridge.manager) {
    throw new HttpError(404, `the agent endpoints are disabled: ${bridge.reason}`, 'start the editor on a loopback address (the default: rev2d edit), or pass --allow-agent to enable them on this address', {
      code: 'agent-disabled',
    });
  }
  if (!bridge.checkToken(req.headers[TOKEN_HEADER])) {
    throw new HttpError(
      401,
      req.headers[TOKEN_HEADER] === undefined ? 'the agent endpoints need the session token (X-Rev2D-Token header)' : 'wrong session token (X-Rev2D-Token header)',
      'GET /api/session returns the token of this editor server; it changes whenever the server restarts',
      { code: 'token-required' },
    );
  }
  const rest = pathname.slice(AGENT_PREFIX.length);
  const parts = rest.split('/'); // ['', 'jobs', '<id>', 'cancel']
  let key = rest;
  let id = '';
  if (parts[1] === 'jobs' && parts.length >= 3 && parts.length <= 4) {
    try {
      id = decodeURIComponent(parts[2]);
    } catch {
      id = '';
    }
    if (!JOB_ID.test(id)) throw new HttpError(400, `malformed job id ${JSON.stringify(parts[2])}`, 'job ids come from POST /api/agent/jobs and GET /api/agent/jobs');
    key = `/jobs/:id${parts.length === 4 ? `/${parts[3]}` : ''}`;
  }
  const methods = Object.hasOwn(AGENT_ROUTES, key) ? AGENT_ROUTES[key] : undefined;
  if (!methods) throw new HttpError(404, `unknown endpoint ${method} ${pathname}`, `agent endpoints: ${AGENT_ENDPOINTS.join(', ')}`);
  const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
  if (!handler) {
    const allow = Object.keys(methods).join(', ');
    throw new HttpError(405, `${method} ${pathname} is not supported`, `use ${allow}`, {}, { Allow: allow });
  }
  try {
    await handler(ctx, bridge.manager, req, res, url, id);
  } catch (e) {
    httpError(e);
  }
}

async function getProviders(_ctx: ApiContext, manager: AgentManager, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, await manager.providers());
}

function getTasks(_ctx: ApiContext, _manager: AgentManager, _req: IncomingMessage, res: ServerResponse): void {
  const tasks: AgentTaskInfo[] = taskTemplates().map(({ kind, title, description, needsPrompt }) => ({ kind, title, description, needsPrompt }));
  sendJson(res, 200, tasks);
}

function getJobs(_ctx: ApiContext, manager: AgentManager, _req: IncomingMessage, res: ServerResponse): void {
  const list: AgentJobList = { jobs: manager.list(), active: manager.activeJob };
  sendJson(res, 200, list);
}

function getJob(_ctx: ApiContext, manager: AgentManager, _req: IncomingMessage, res: ServerResponse, url: URL, id: string): void {
  const raw = url.searchParams.get('since');
  const since = raw === null ? 0 : Number(raw);
  if (raw !== null && (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(since))) {
    throw new HttpError(400, `bad since "${raw}"`, 'the sequence number of the last event you have (events after it are returned); omit it for all events');
  }
  const job = manager.get(id);
  if (!job) throw new AgentError('unknown-job', `unknown agent job "${id}"`, 'GET /api/agent/jobs lists the jobs this editor remembers (the newest ones)');
  const detail: AgentJobDetail = { job, prompt: manager.prompt(id), ...manager.events(id, since) };
  sendJson(res, 200, detail);
}

/** A directory of the workspace as an absolute path (403 outside the root, 400 / 404 otherwise). */
async function resolveDirectory(ctx: ApiContext, dir: unknown, field: string): Promise<string> {
  const abs = await ctx.root.resolve(dir, field);
  const st = await stat(abs).catch(() => null);
  if (!st) throw new HttpError(404, `${field}: directory not found: ${ctx.root.rel(abs) || '.'}`, 'give a folder of the workspace (GET /api/files lists it), relative to the workspace root');
  if (!st.isDirectory()) throw new HttpError(400, `${field}: ${ctx.root.rel(abs)} is a file, not a directory`, 'give the project folder, not a file in it');
  return abs;
}

async function resolveImages(ctx: ApiContext, images: readonly string[] | undefined): Promise<string[]> {
  const out: string[] = [];
  for (const [i, image] of (images ?? []).entries()) out.push(await ctx.root.resolve(image, `images.${i}`));
  return out;
}

async function postJob(ctx: ApiContext, manager: AgentManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parseAgentStartRequest(await readJson(req, MAX_AGENT_BODY));
  ctx.agent.checkRate();
  const context = body.context ?? {};
  // Where the agent works never comes from the request unchecked: the root, or a folder inside it.
  const cwd = context.project === undefined || context.project === null || context.project === '' ? ctx.root.dir : await resolveDirectory(ctx, context.project, 'context.project');
  const file = context.file === undefined || context.file === null || context.file === '' ? (ctx.store?.file ?? null) : await ctx.root.resolve(context.file, 'context.file');
  const images = await resolveImages(ctx, body.images);
  const job = await manager.start({
    provider: body.provider,
    cwd,
    images,
    file,
    context,
    ...(body.kind !== undefined ? { kind: body.kind } : {}),
    ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.effort !== undefined ? { effort: body.effort } : {}),
    ...(body.sandbox !== undefined ? { sandbox: body.sandbox } : {}),
    ...(body.allowImageGeneration !== undefined ? { allowImageGeneration: body.allowImageGeneration } : {}),
  });
  ctx.agent.recordStart();
  sendJson(res, 202, { job });
}

async function postCancel(_ctx: ApiContext, manager: AgentManager, _req: IncomingMessage, res: ServerResponse, _url: URL, id: string): Promise<void> {
  sendJson(res, 200, { job: await manager.cancel(id) });
}

async function postMessage(ctx: ApiContext, manager: AgentManager, req: IncomingMessage, res: ServerResponse, _url: URL, id: string): Promise<void> {
  const body = parseAgentMessageRequest(await readJson(req, MAX_AGENT_BODY));
  ctx.agent.checkRate();
  const images = await resolveImages(ctx, body.images);
  const job = await manager.message(id, body.prompt, {
    ...(images.length ? { images } : {}),
    ...(body.allowImageGeneration !== undefined ? { allowImageGeneration: body.allowImageGeneration } : {}),
  });
  ctx.agent.recordStart();
  sendJson(res, 202, { job });
}

// ----------------------------------------------------------------------------- settings

function getSettings(ctx: ApiContext, _manager: AgentManager, _req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, ctx.agent.settings.info());
}

/**
 * Save a setting to the person's settings file. It counts from the next job on, unless an option or a
 * flag of this server overrides it (`notes` says so).
 */
async function putSettings(ctx: ApiContext, _manager: AgentManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parseAgentSettingsRequest(await readJson(req, MAX_AGENT_BODY));
  sendJson(res, 200, ctx.agent.settings.setUser(body));
}
