/**
 * Editor server: serves the web editor, the model file API, live-reload events (SSE), the
 * AI<->editor bridge (shared view state + commands) and file management inside a workspace root.
 * Protocol:
 *
 *   GET  /api/model                -> {file, text, mtimeMs}
 *   PUT  /api/model[?force=1]      {text} | {doc}, baseMtimeMs?, file? -> {ok, written, diagnostics, mtimeMs}, or
 *                                     409 {error, hint, mtimeMs} when the file changed on disk since baseMtimeMs,
 *                                     409 {error, hint, file} when `file` is not the open model (it was switched)
 *   GET  /api/texture/:id          -> image/png
 *   GET  /api/events               -> SSE: hello {file | null, mtimeMs, root, avatar?} | model-changed {origin, mtimeMs, files}
 *                                     | file-changed {file | null, origin: "editor" | "ai", avatar?} | command <EditorCommand>
 *                                     | avatar-changed | avatar-job | agent-job
 *   GET  /api/state                -> EditorState (404 until the UI published one)
 *   POST /api/state                EditorState -> 204 (animations: [{id, weight?, mode?, start?, hold?}]);
 *                                     409 when its absolute `file` is not the open model
 *   POST /api/command              EditorCommand -> {delivered}; {type: "open", file} is handled by the
 *                                     server -> {delivered, file, mtimeMs, notes} (tabs follow "file-changed")
 *   GET  /api/screenshot?overlay=a,b|all|none&scale=1&viewBox=fit|canvas|x,y,w,h -> image/png of the
 *                                     editor's pose (its published params with physics off, its layers
 *                                     with their options, minus its hidden parts; default: its overlay
 *                                     and visible region; without
 *                                     scale, shrunk to at most 2048*2048 px; X-Rev2D-* headers say what was used)
 *   GET  /api/info                 -> {info, diagnostics}
 *   workspace: GET /api/workspace, GET /api/files?dir=, POST /api/open, POST /api/new, POST /api/save-as,
 *              POST /api/close, POST /api/import (also converts a Spine export), GET /api/download,
 *              GET /api/templates (see src/node/editor-registry.ts and workspace-routes.ts)
 *   interop:   POST /api/live2d-import (Live2D files -> the resulting doc, not written),
 *              POST /api/export {format: spine | live2d} (files into a workspace folder)
 *              (see src/node/interop.ts and interop-routes.ts)
 *   agents:    GET /api/session -> {token, agent: {enabled, reason?}}; with the token in X-Rev2D-Token:
 *              GET /api/agent/providers, GET /api/agent/tasks, GET | POST /api/agent/jobs,
 *              GET /api/agent/jobs/:id?since=, POST /api/agent/jobs/:id/cancel | message, GET | PUT
 *              /api/agent/settings; SSE event "agent-job" {job, state, event}
 *              (see agent-routes.ts, src/node/agent and docs/AGENT-BRIDGE.md)
 *   avatar:    GET | PUT /api/avatar (the open avatar project: avatar.json, build state; saving recompiles
 *              the model), POST | GET /api/avatar/build (one build job at a time; SSE "avatar-job"),
 *              GET /api/avatar/file?path= (a file of the project folder), POST /api/avatar/new (a project
 *              from one uploaded PNG); SSE "avatar-changed" {origin, project, files, mtimeMs}. POST /api/open
 *              and the "open" command take an avatar.json or a project folder; `avatar` in hello,
 *              file-changed and /api/workspace names the open project
 *              (see avatar-routes.ts and the "avatar mode" section of src/node/editor-registry.ts)
 *   everything else                -> editor UI
 *
 * Endpoints that need a model answer 409 {error: "no model is open", hint} while none is open.
 *
 * Bound to 127.0.0.1 by default; requests must address a local Host (DNS-rebinding guard) and
 * browser writes must be same-origin (CSRF guard). The agent endpoints start local programs with the
 * person's credentials: they exist only on a loopback bind (or with `allowAgent`) and need the
 * per-server session token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../api/index.js';
import { PACKAGE_ROOT } from '../api/templates.js';
import { registerEditor, type AvatarRef } from '../node/editor-registry.js';
import { defaultSettingsFile } from '../node/agent/index.js';
import { AgentBridge, type AgentBridgeOptions } from './agent-routes.js';
import './avatar-agent-tasks.js';
import { AvatarBridge, avatarOpenTarget, avatarProjectAt, detectAvatarProject, type AvatarBridgeOptions } from './avatar-routes.js';
import { HttpError, allowedHostnames, checkRequestOrigin, sendError, sendJson } from './http.js';
import { ModelStore } from './model-store.js';
import { handleApi, relativeFiles, type ApiContext, type ChangeOrigin } from './routes.js';
import { SseHub } from './sse.js';
import { createUiHandler, type UiMode } from './ui.js';
import { FileWatcher } from './watch.js';
import { RecentFiles, WorkspaceRoot, defaultRecentFile } from './workspace.js';

export type { UiMode } from './ui.js';
export type { AgentBridgeOptions } from './agent-routes.js';
export type { AvatarBridgeOptions } from './avatar-routes.js';

export interface EditorServerOptions {
  /**
   * Model file to open at start (must exist and lie inside the workspace root). Without it the
   * server starts with no model open (the UI shows its start screen). The avatar.json of an avatar
   * project opens that project: with its built model, or without a model while it has none.
   */
  file?: string;
  /**
   * Workspace root: every file the editor opens, creates, saves or imports must lie inside it
   * (symbolic links are resolved). Default: the directory of `file`, else the current directory.
   */
  root?: string;
  /** TCP port (default 4777; 0 picks a free port). */
  port?: number;
  /** Interface to bind (default 127.0.0.1). */
  host?: string;
  /**
   * Host names accepted in addition to localhost, 127.0.0.1, [::1] and the bound address (for a
   * wildcard bind: every interface address), e.g. a LAN name when binding 0.0.0.0.
   */
  allowedHosts?: string[];
  /** Directory of the built editor UI (default <package>/dist/editor). */
  staticDir?: string;
  /** Without a built UI, serve the editor sources through Vite's dev middleware (default true). */
  devVite?: boolean;
  /** Vite config used by `devVite` (default <package>/editor/vite.config.ts). */
  viteConfig?: string;
  /** Advertise the server in ~/.rev2d/editors so the CLI/MCP can find it (default true). */
  register?: boolean;
  /** Poll file stats instead of using fs.watch (network drives, some containers). Default false. */
  poll?: boolean;
  /** Stat polling interval in ms when polling (default 300). */
  pollIntervalMs?: number;
  /** Request body limit in bytes (default 20 MiB). */
  maxBodyBytes?: number;
  /** Body limit of POST /api/import in bytes (default 64 MiB; files travel base64-encoded). */
  maxImportBytes?: number;
  /**
   * JSON file of the recently opened models, shared by editor servers. Default ~/.rev2d/recent.json
   * when `register` is on, else none; null = keep the list in memory only.
   */
  recentFile?: string | null;
  /** Sink for operational messages (watch fallbacks, internal errors). Default: console.error. */
  log?: (message: string) => void;
  /**
   * Keep the agent endpoints (/api/agent/*: they start Codex / Claude Code with the person's
   * credentials) although `host` is not a loopback address. Default false: they only exist on
   * localhost, 127.0.0.0/8 and ::1.
   */
  allowAgent?: boolean;
  /**
   * Settings of the agent bridge: timeouts, limits, the log directory, `codexWindowsSandbox` (Codex's
   * sandbox implementation on Windows) and the settings file (tests replace the CLIs with fakes).
   */
  agent?: AgentBridgeOptions;
  /** Settings of avatar mode: how builds run, their timeout, the upload limit of new projects. */
  avatar?: AvatarBridgeOptions;
}

export interface EditorServer {
  /** Base URL, e.g. "http://127.0.0.1:4777". */
  url: string;
  port: number;
  /** Absolute path of the open model file, or null (start screen). Follows open/new/save-as/import/close. */
  readonly file: string | null;
  /** Absolute workspace root. */
  root: string;
  /** How the editor UI is served ('none' = only the API; `detail` says why). */
  ui: { mode: UiMode; detail: string };
  /** Whether the agent endpoints (/api/agent/*) exist, and why not when they do not. */
  agent: { enabled: boolean; reason?: string };
  /** Stop serving: ends event streams, stops watchers and Vite, removes the registry entry. */
  close(): Promise<void>;
}

export const DEFAULT_PORT = 4777;
const DEFAULT_MAX_BODY = 20 * 1024 * 1024;
const DEFAULT_MAX_IMPORT = 64 * 1024 * 1024;

export async function startEditorServer(opts: EditorServerOptions): Promise<EditorServer> {
  const log = opts.log ?? ((m: string) => console.error(`[rev2d editor] ${m}`));
  const host = opts.host ?? '127.0.0.1';
  const allowed = allowedHostnames(host, opts.allowedHosts);
  // An avatar.json opens its project: with the built model when there is one, else the project alone.
  let startProject: string | null = null;
  if (opts.file !== undefined) {
    const abs = path.resolve(opts.file);
    const st = await stat(abs).catch(() => null);
    startProject = st?.isFile() ? await avatarProjectAt(abs, st) : null;
  }
  let initial = opts.file !== undefined && startProject === null ? await ModelStore.open(opts.file) : null;
  const root = await WorkspaceRoot.open(opts.root ?? (initial ? initial.dir : (startProject ?? process.cwd())));
  const outside = (what: string, file: string) => new Error(`the ${what} ${file} is outside the workspace root ${root.dir} (the root must contain every file the editor opens)`);
  let startAvatar: AvatarRef | null = null;
  if (startProject !== null) {
    const project = startProject;
    const target = await avatarOpenTarget(
      root,
      await root.resolve(project, 'file').catch(() => {
        throw outside('avatar project', project);
      }),
    );
    startAvatar = target.ref;
    if (target.model !== null) initial = await ModelStore.open(target.model);
  } else if (initial) {
    const model = initial;
    await root.resolve(model.file, 'model').catch(() => {
      throw outside('model', model.file);
    });
    startAvatar = await detectAvatarProject(root, model.dir);
  }
  const register = opts.register ?? true;
  const recent = new RecentFiles(opts.recentFile === undefined ? (register ? defaultRecentFile() : null) : opts.recentFile, log);
  const sse = new SseHub();
  const agent = new AgentBridge({
    host,
    allowAgent: opts.allowAgent === true,
    root: root.dir,
    sse,
    allowedHosts: allowed,
    log,
    // Like the recent-files list: the person's file for a registered editor, memory only otherwise (tests).
    defaultSettingsFile: register ? defaultSettingsFile() : null,
    options: opts.agent,
  });
  const avatar = new AvatarBridge({ root, sse, log, poll: opts.poll, pollIntervalMs: opts.pollIntervalMs, options: opts.avatar });

  /** Report what really changed among `files` of the open model `store` (watchers repeat themselves and see our own writes). */
  const reportChanges = async (store: ModelStore, files: readonly string[], origin: ChangeOrigin): Promise<void> => {
    const { changed, mtimeMs } = await store.detectChanges(files);
    if (changed.length) ctx.modelChanged(store, origin, mtimeMs, changed);
  };

  const watcher = new FileWatcher({
    poll: opts.poll,
    pollIntervalMs: opts.pollIntervalMs,
    log,
    onChange: (files) => {
      const store = ctx.store;
      if (!store) return;
      // An avatar build or save of this server is rewriting the model and its textures: it reports
      // the result itself (origin "editor") when it is done (ApiContext.syncModel).
      if (avatar.holdsModel(store.dir)) return;
      reportChanges(store, files, 'external').catch((e: Error) => log(`change detection failed: ${e.message}`));
    },
  });

  /** Registry entry of this server once it listens (its `file` follows the open model; `root` lets the CLI/MCP find it by any path of the workspace). */
  let advertised: { pid: number; url: string; startedAt: string } | null = null;
  let unregister: (() => void) | null = null;
  const advertise = (file: string | null) => {
    if (advertised) unregister = registerEditor({ pid: advertised.pid, url: advertised.url, file: file ?? '', root: root.dir, startedAt: advertised.startedAt });
  };
  let queue: Promise<unknown> = Promise.resolve();

  const ctx: ApiContext = {
    store: initial,
    root,
    recent,
    sse,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY,
    maxImportBytes: opts.maxImportBytes ?? DEFAULT_MAX_IMPORT,
    state: null,
    agent,
    avatar,
    modelChanged(store, origin, mtimeMs, files) {
      if (store !== ctx.store) return; // a late event of a model that was switched away from
      watcher.setFiles(store.watchedFiles());
      sse.broadcast('model-changed', { origin, mtimeMs, files: relativeFiles(store, files) });
    },
    async syncModel(origin) {
      const store = ctx.store;
      if (store) await reportChanges(store, store.watchedFiles(), origin);
    },
    async switchTo(next, origin, project) {
      const prev = ctx.store;
      // The avatar project that is open with the model: the one named, else the one whose folder the model is in.
      const ref = project ?? (next ? await detectAvatarProject(root, next.dir) : null);
      ctx.store = next;
      ctx.state = null;
      watcher.setFiles(next ? next.watchedFiles() : []);
      await avatar.attach(ref);
      if (next) recent.add(next.file);
      else if (ref) recent.add(ref.specFile);
      advertise(next?.file ?? null);
      const delivered = sse.broadcast('file-changed', { file: next?.file ?? null, origin, ...(ref ? { avatar: ref } : {}) });
      if (prev && prev !== next) await prev.idle();
      return delivered;
    },
    exclusive<T>(fn: () => Promise<T>): Promise<T> {
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    },
  };
  if (initial) recent.add(initial.file);
  else if (startAvatar) recent.add(startAvatar.specFile);

  const server = createServer();
  const ui = await createUiHandler({
    staticDir: opts.staticDir ?? path.join(PACKAGE_ROOT, 'dist', 'editor'),
    viteConfig: opts.viteConfig ?? path.join(PACKAGE_ROOT, 'editor', 'vite.config.ts'),
    devVite: opts.devVite ?? true,
    httpServer: server,
    packageRoot: PACKAGE_ROOT,
  });

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e: unknown) => respondError(res, e));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const blocked = checkRequestOrigin(req, allowed);
    if (blocked) return sendError(res, blocked);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(ctx, req, res, url);
    return ui.handle(req, res);
  }

  function respondError(res: ServerResponse, e: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (e instanceof HttpError) return sendError(res, e);
    if (e instanceof ApiError) return sendJson(res, 422, { error: e.message, ...(e.hint ? { hint: e.hint } : {}), diagnostics: e.diagnostics });
    log(`internal error: ${(e as Error).stack ?? String(e)}`);
    sendJson(res, 500, { error: `internal error: ${(e as Error).message ?? String(e)}` });
  }

  const port = opts.port ?? DEFAULT_PORT;
  // Before the first request can arrive: the open avatar project and its watcher.
  await avatar.attach(startAvatar);
  try {
    await listenReachable(server, port, host);
  } catch (e) {
    await ui.close();
    await agent.close();
    await avatar.close();
    sse.close();
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      err.code === 'EADDRINUSE'
        ? `port ${port} on ${host} is already in use (another rev2d editor?); choose another port, or 0 for any free port`
        : `cannot listen on ${host}:${port}: ${err.message}`,
      { cause: e },
    );
  }
  watcher.setFiles(initial ? initial.watchedFiles() : []);

  const boundPort = (server.address() as AddressInfo).port;
  if (BROWSER_BLOCKED_PORTS.has(boundPort)) log(`browsers refuse to connect to port ${boundPort} (ERR_UNSAFE_PORT); the editor UI will not open there`);
  const url = `http://${urlHost(host)}:${boundPort}`;
  if (register) {
    advertised = { pid: process.pid, url, startedAt: new Date().toISOString() };
    advertise(ctx.store?.file ?? null);
  }

  let closing: Promise<void> | null = null;
  return {
    url,
    port: boundPort,
    get file() {
      return ctx.store?.file ?? null;
    },
    root: root.dir,
    ui: { mode: ui.mode, detail: ui.detail },
    agent: agent.enabled ? { enabled: true } : { enabled: false, reason: agent.reason! },
    close() {
      closing ??= (async () => {
        advertised = null;
        unregister?.();
        // A running agent job is cancelled first (its process tree is killed); its last events still go out.
        await agent.close();
        // So is a running avatar build; the avatar watcher stops.
        await avatar.close();
        watcher.close();
        sse.close();
        await ui.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await queue;
        await ctx.store?.idle();
      })();
      return closing;
    },
  };
}

/** Ports browsers and fetch() refuse to connect to (WHATWG Fetch "bad ports"). */
const BROWSER_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113,
  115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556,
  563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080,
]);

/**
 * Listen on `port`; for port 0, re-roll ports browsers would refuse (dynamic port ranges can start
 * as low as 1024, e.g. on Windows with Hyper-V).
 */
async function listenReachable(server: Server, port: number, host: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await listen(server, port, host);
    if (port !== 0 || attempt >= 20 || !BROWSER_BLOCKED_PORTS.has((server.address() as AddressInfo).port)) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Host part of the advertised URL: wildcard binds are reached through loopback. */
function urlHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '::1') return '[::1]';
  return host.includes(':') ? `[${host}]` : host;
}
