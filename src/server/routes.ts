/**
 * /api/* endpoints of the editor protocol. Each handler either writes a response or throws an
 * HttpError / ApiError that the server turns into a JSON error body. The workspace endpoints (file
 * management) live in workspace-routes.ts, the interop endpoints (Live2D import, Spine / Live2D export)
 * in interop-routes.ts, the agent bridge (/api/session, /api/agent/*) in agent-routes.ts, avatar mode
 * (/api/avatar, /api/avatar/build | file | new | variants | variants/import | variants/request) in avatar-routes.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { AnimationLayer, Model, Pose, PoseOptions, RenderList } from '../core/types.js';
import { buildRenderList } from '../core/rig.js';
import { formatModelJson } from '../core/format.js';
import { parseModelText } from '../core/validate.js';
import { hasErrors } from '../node/load.js';
import type { AvatarRef, EditorLayer, EditorState } from '../node/editor-registry.js';
import { OVERLAY_LAYERS, modelInfo, resolveViewBox, toPoseOptions, type PoseInput } from '../api/index.js';
import { drawOverlay, encodePNG, renderImage, type OverlayLayer } from '../render/index.js';
import { AGENT_ENDPOINTS, AGENT_PREFIX, getSession, handleAgentApi, type AgentBridge } from './agent-routes.js';
import { getAvatar, getAvatarBuild, getAvatarFile, getAvatarVariants, postAvatarBuild, postAvatarNew, postAvatarVariantRequests, postAvatarVariantsImport, putAvatar, type AvatarBridge } from './avatar-routes.js';
import { HttpError, readJson, sendJson } from './http.js';
import { postExport, postLive2dImport } from './interop-routes.js';
import type { ModelStore } from './model-store.js';
import { MAX_SCREENSHOT_PIXELS, parseCommand, parseEditorState, parseScreenshotQuery } from './protocol.js';
import type { SseHub } from './sse.js';
import { samePath, type RecentFiles, type WorkspaceRoot } from './workspace.js';
import {
  getDownload,
  getFiles,
  getTemplates,
  getWorkspace,
  openCommand,
  postClose,
  postImport,
  postNew,
  postOpen,
  postSaveAs,
  requireStore,
} from './workspace-routes.js';

export type ChangeOrigin = 'external' | 'editor';
/** Who switched the open model: the editor UI (workspace endpoints) or an AI (EditorCommand "open"). */
export type FileOrigin = 'editor' | 'ai';

export interface ApiContext {
  /** The open model, or null while none is open (the UI shows its start screen). */
  store: ModelStore | null;
  /** Workspace root every file-management path is confined to. */
  root: WorkspaceRoot;
  recent: RecentFiles;
  sse: SseHub;
  maxBodyBytes: number;
  /** Body limit of POST /api/import (files travel base64-encoded). */
  maxImportBytes: number;
  /** Latest view state published by the editor UI for the open model (reset when it is switched). */
  state: EditorState | null;
  /** The in-app agent bridge: session token, agent jobs (agent-routes.ts). */
  agent: AgentBridge;
  /** Avatar mode: the open avatar project, its watcher and build job (avatar-routes.ts). */
  avatar: AvatarBridge;
  /** Broadcast a model-changed event for `store` (ignored once another model is open) and refresh the watched file set. */
  modelChanged(store: ModelStore, origin: ChangeOrigin, mtimeMs: number, files: string[]): void;
  /**
   * Compare the open model and its textures with what was last seen and broadcast "model-changed"
   * with `origin` when they differ (after the server itself rewrote them: an avatar build or save).
   */
  syncModel(origin: ChangeOrigin): Promise<void>;
  /**
   * Make `store` the open model (null: close it): resets the view state, retargets the watcher and
   * the registry entry, records the file as recently opened and broadcasts "file-changed". Returns
   * how many event streams received it. Only call inside `exclusive`.
   *
   * `avatar` is the avatar project that is open with it. Left out, a model whose folder holds an
   * avatar.json attaches that project, and closing the model closes the project; given with a null
   * `store`, the project is open without a model (it has none built yet).
   */
  switchTo(store: ModelStore | null, origin: FileOrigin, avatar?: AvatarRef | null): Promise<number>;
  /** Run a workspace operation (open, new, save as, import, close) after every earlier one finished. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

type Handler = (ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  '/api/model': { GET: getModel, PUT: putModel },
  '/api/events': { GET: events },
  '/api/state': { GET: getState, POST: postState },
  '/api/command': { POST: postCommand },
  '/api/screenshot': { GET: screenshot },
  '/api/info': { GET: info },
  '/api/workspace': { GET: getWorkspace },
  '/api/files': { GET: getFiles },
  '/api/open': { POST: postOpen },
  '/api/new': { POST: postNew },
  '/api/save-as': { POST: postSaveAs },
  '/api/close': { POST: postClose },
  '/api/import': { POST: postImport },
  '/api/download': { GET: getDownload },
  '/api/templates': { GET: getTemplates },
  '/api/live2d-import': { POST: postLive2dImport },
  '/api/export': { POST: postExport },
  '/api/session': { GET: getSession },
  '/api/avatar': { GET: getAvatar, PUT: putAvatar },
  '/api/avatar/build': { GET: getAvatarBuild, POST: postAvatarBuild },
  '/api/avatar/file': { GET: getAvatarFile },
  '/api/avatar/new': { POST: postAvatarNew },
  '/api/avatar/variants': { GET: getAvatarVariants },
  '/api/avatar/variants/import': { POST: postAvatarVariantsImport },
  '/api/avatar/variants/request': { POST: postAvatarVariantRequests },
};

const TEXTURE_PREFIX = '/api/texture/';

const ENDPOINTS = [
  ...Object.entries(ROUTES).flatMap(([p, methods]) => Object.keys(methods).map((m) => `${m} ${p}`)),
  `GET ${TEXTURE_PREFIX}:id`,
  ...AGENT_ENDPOINTS.filter((e) => e.includes(`${AGENT_PREFIX}/`)),
].join(', ');

export async function handleApi(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname.startsWith(TEXTURE_PREFIX)) {
    if (method !== 'GET') throw new HttpError(405, `${method} ${TEXTURE_PREFIX}:id is not supported`, 'use GET', {}, { Allow: 'GET' });
    return texture(ctx, res, pathname.slice(TEXTURE_PREFIX.length));
  }
  // The agent bridge has its own guards (loopback bind, session token) and routes with job ids.
  if (pathname === AGENT_PREFIX || pathname.startsWith(`${AGENT_PREFIX}/`)) return handleAgentApi(ctx, req, res, url, pathname);
  const methods = ROUTES[pathname];
  if (!methods) throw new HttpError(404, `unknown endpoint ${method} ${pathname}`, `endpoints: ${ENDPOINTS}`);
  const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
  if (!handler) {
    const allow = Object.keys(methods).join(', ');
    throw new HttpError(405, `${method} ${pathname} is not supported`, `use ${allow}`, {}, { Allow: allow });
  }
  return handler(ctx, req, res, url);
}

/** 409 when a request names a model file (`file`) other than the open one: the model was switched meanwhile. */
function checkSameFile(ctx: ApiContext, store: ModelStore, file: unknown, what: string): void {
  if (file === undefined || file === null || file === '') return;
  if (typeof file !== 'string') throw new HttpError(400, `"file" must be a string (the model the ${what} is for)`, 'send the file of GET /api/model, or omit it');
  const abs = path.resolve(ctx.root.dir, file);
  if (!samePath(abs, store.file)) {
    throw new HttpError(
      409,
      `the ${what} is for ${abs}, but the editor now has ${store.file} open`,
      'the open model was switched (SSE event "file-changed"); load the open model (GET /api/model) and try again',
      { file: store.file },
    );
  }
}

// ----------------------------------------------------------------------------- model file

async function getModel(ctx: ApiContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const store = requireStore(ctx);
  const { text, mtimeMs } = await store.read();
  sendJson(res, 200, { file: store.file, text, mtimeMs });
}

async function putModel(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const body = await readJson(req, ctx.maxBodyBytes);
  const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as { text?: unknown; doc?: unknown; baseMtimeMs?: unknown; file?: unknown };
  const store = requireStore(ctx);
  checkSameFile(ctx, store, b.file, 'write');
  const hasText = b.text !== undefined;
  const hasDoc = b.doc !== undefined;
  if (hasText === hasDoc) {
    throw new HttpError(400, 'body must have exactly one of "text" (raw JSON/JSONC string) or "doc" (model object)', 'e.g. {"text": "{\\"format\\": \\"rev2d\\", ...}"} or {"doc": {...}}');
  }
  if (hasText && typeof b.text !== 'string') throw new HttpError(400, '"text" must be a string', 'send the raw file contents as a JSON string');
  if (hasDoc && (typeof b.doc !== 'object' || b.doc === null || Array.isArray(b.doc))) {
    throw new HttpError(400, '"doc" must be a JSON object', 'send the whole model object');
  }
  const base = b.baseMtimeMs ?? undefined;
  if (base !== undefined && (typeof base !== 'number' || !Number.isFinite(base))) {
    throw new HttpError(
      400,
      '"baseMtimeMs" must be a number',
      'send the mtimeMs of the version the edit is based on (from GET /api/model or the last PUT), or omit it to write unconditionally',
    );
  }
  let text = hasText ? (b.text as string) : formatModelJson(b.doc);
  // Formatted writes keep the file's line endings (a CRLF checkout must not turn into a whole-file diff).
  if (hasDoc && (await usesCrlf(store))) text = text.replace(/\n/g, '\r\n');
  const { diagnostics } = parseModelText(text);
  const ok = !hasErrors(diagnostics);
  const force = ['1', 'true'].includes(url.searchParams.get('force') ?? '');
  if (!ok && !force) {
    const { mtimeMs } = await store.read().catch(() => ({ mtimeMs: 0 }));
    sendJson(res, 200, {
      ok,
      written: false,
      diagnostics,
      mtimeMs,
      hint: 'the model has validation errors and was NOT written; fix them, or PUT with ?force=1 to write anyway',
    });
    return;
  }
  const mtimeMs = await store.write(text, base);
  ctx.modelChanged(store, 'editor', mtimeMs, [store.file]);
  sendJson(res, 200, { ok, written: true, diagnostics, mtimeMs });
}

/** Whether the model file's first line ends with CRLF (false when it is missing). */
async function usesCrlf(store: ModelStore): Promise<boolean> {
  const current = await store.read().catch(() => null);
  const nl = current ? current.text.indexOf('\n') : -1;
  return nl > 0 && current!.text[nl - 1] === '\r';
}

async function texture(ctx: ApiContext, res: ServerResponse, rawId: string): Promise<void> {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    throw new HttpError(400, `malformed texture id ${JSON.stringify(rawId)}`);
  }
  const bytes = await requireStore(ctx).texture(id);
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
  res.end(bytes);
}

// ----------------------------------------------------------------------------- live bridge

async function events(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const store = ctx.store;
  const { mtimeMs } = store ? await store.read().catch(() => ({ mtimeMs: 0 })) : { mtimeMs: 0 };
  const avatar = ctx.avatar.ref();
  ctx.sse.open(req, res, { event: 'hello', data: { file: store?.file ?? null, mtimeMs, root: ctx.root.dir, ...(avatar ? { avatar } : {}) } });
}

function getState(ctx: ApiContext, _req: IncomingMessage, res: ServerResponse): void {
  requireStore(ctx);
  if (!ctx.state) {
    throw new HttpError(404, 'no editor state yet', 'the editor UI publishes its view state once it is open in a browser; screenshots use the default pose until then');
  }
  sendJson(res, 200, ctx.state);
}

async function postState(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, ctx.maxBodyBytes);
  const store = requireStore(ctx);
  // A tab that has not followed a switch yet must not publish its old model's view as the new one's.
  const file = (body as { file?: unknown } | null)?.file;
  if (typeof file === 'string' && path.isAbsolute(file)) checkSameFile(ctx, store, file, 'view state');
  ctx.state = parseEditorState(body, store.file);
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

async function postCommand(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const command = parseCommand(await readJson(req, ctx.maxBodyBytes));
  if (command.type === 'open') {
    // Handled here: the server switches the model and every tab follows the "file-changed" event.
    const { result, delivered } = await openCommand(ctx, command.file);
    sendJson(res, 200, { delivered, file: result.file, mtimeMs: result.mtimeMs, notes: result.notes, ...(result.avatar ? { avatar: result.avatar } : {}) });
    return;
  }
  if (command.type !== 'message') requireStore(ctx);
  const delivered = ctx.sse.broadcast('command', command);
  sendJson(res, 200, { delivered });
}

// ----------------------------------------------------------------------------- rendering

async function info(ctx: ApiContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const m = await requireStore(ctx).loaded();
  sendJson(res, 200, { info: m.model ? modelInfo(m.model) : null, diagnostics: m.diagnostics });
}

/**
 * Pose options from the editor state, dropping ids that no longer exist in the (edited) model.
 * The published params are the values the editor shows, physics outputs included, so they define the
 * pose: physics is off (re-simulating would replace the editor's physics results with the server's).
 * Layer options (mode, start, hold) are passed on as the editor used them. Dropped ids are
 * URI-encoded so they are always safe in a response header.
 */
function poseFromState(model: Model, state: EditorState | null): { options: PoseOptions; hidden: Set<string>; ignored: string[] } {
  const { input, hidden, ignored } = inputFromState(model, state);
  // toPoseOptions checks ids, weights (0..1) and time (ApiError with a hint -> 422).
  const options = toPoseOptions(model, { ...input, animations: input.animations.map((a) => ({ id: a.id, ...(a.weight !== undefined ? { weight: a.weight } : {}) })) });
  options.animations = (options.animations ?? []).map((layer, i) => {
    const { mode, start, hold } = input.animations[i];
    const l = layer as AnimationLayer;
    return { ...l, ...(mode !== undefined ? { mode } : {}), ...(start !== undefined ? { start } : {}), ...(hold !== undefined ? { hold } : {}) };
  });
  return { options, hidden, ignored };
}

function inputFromState(
  model: Model,
  state: EditorState | null,
): { input: Omit<PoseInput, 'animations'> & { animations: EditorLayer[] }; hidden: Set<string>; ignored: string[] } {
  if (!state) return { input: { animations: [] }, hidden: new Set(), ignored: [] };
  const ignored: string[] = [];
  const params: Record<string, number> = {};
  for (const [id, v] of Object.entries(state.params)) {
    if (model.parameters.some((p) => p.id === id)) params[id] = v;
    else ignored.push(`param:${encodeURIComponent(id)}`);
  }
  const animations = state.animations.filter((a) => {
    const known = model.animations.some((x) => x.id === a.id);
    if (!known) ignored.push(`animation:${encodeURIComponent(a.id)}`);
    return known;
  });
  const hidden = new Set<string>();
  for (const id of state.hidden ?? []) {
    if (model.parts.some((p) => p.id === id)) hidden.add(id);
    else ignored.push(`part:${encodeURIComponent(id)}`);
  }
  return { input: { time: state.time, params, animations, physics: false }, hidden, ignored };
}

type Rect = [number, number, number, number];

function outputSize(viewBox: Rect, scale: number): [number, number] {
  return [Math.round(viewBox[2] * scale), Math.round(viewBox[3] * scale)];
}

/**
 * Scale used when the request names none: 1, or (e.g. for an editor view zoomed far out) the largest
 * 4-significant-digit scale whose output fits MAX_SCREENSHOT_PIXELS.
 */
function defaultScale(viewBox: Rect): number {
  const fits = (s: number) => {
    const [w, h] = outputSize(viewBox, s);
    return w * h <= MAX_SCREENSHOT_PIXELS;
  };
  if (fits(1)) return 1;
  let s = Number(Math.sqrt(MAX_SCREENSHOT_PIXELS / (viewBox[2] * viewBox[3])).toPrecision(4));
  while (s > 0 && !fits(s)) s = Number((s * 0.999).toPrecision(4));
  return s;
}

async function screenshot(ctx: ApiContext, _req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const q = parseScreenshotQuery(url.searchParams);
  const m = await requireStore(ctx).loaded();
  if (!m.rig || hasErrors(m.diagnostics)) {
    throw new HttpError(422, 'the model has errors and cannot be rendered', 'fix the listed errors (GET /api/info shows all diagnostics)', {
      diagnostics: m.diagnostics.filter((d) => d.severity === 'error'),
    });
  }
  const rig = m.rig;
  const model = rig.model;
  const state = ctx.state;
  const { options, hidden, ignored } = poseFromState(model, state);
  const pose = rig.pose(options);
  // What the editor draws: its preview-hidden parts are left out (they still clip as masks).
  const shown: Pose = hidden.size ? { ...pose, drawOrder: pose.drawOrder.filter((id) => !hidden.has(id)) } : pose;
  const canvas: Rect = [0, 0, model.meta.width, model.meta.height];
  const viewBox =
    q.viewBox === 'canvas'
      ? canvas
      : q.viewBox === 'fit'
        ? resolveViewBox(model, shown, { viewBox: 'fit' })
        : (q.viewBox ?? state?.viewBox ?? canvas);
  const scale = q.scale ?? defaultScale(viewBox);
  const [width, height] = outputSize(viewBox, scale);
  if (width < 1 || height < 1 || width * height > MAX_SCREENSHOT_PIXELS) {
    throw new HttpError(
      400,
      `screenshot would be ${width}x${height} px (viewBox ${viewBox.join(',')} at scale ${scale})`,
      width < 1 || height < 1
        ? 'pass a larger viewBox or a larger scale'
        : `keep it within ${MAX_SCREENSHOT_PIXELS} px: lower scale, omit scale to shrink automatically, or pass a smaller viewBox`,
    );
  }
  const overlay = q.overlay ?? (state?.overlay ?? []).filter((l): l is OverlayLayer => (OVERLAY_LAYERS as string[]).includes(l));
  // renderPose, minus the hidden parts' draws (the list is built from the evaluated pose itself,
  // whose geometry the rig caches; the editor's WebGL renderer filters the same list).
  const full = buildRenderList(rig, pose);
  const list: RenderList = hidden.size ? { ...full, draws: full.draws.filter((d) => !hidden.has(d.partId)) } : full;
  const image = renderImage(list, m.textures, { viewBox, scale, background: null });
  if (overlay.length) drawOverlay(image, { model, pose: shown, list }, { layers: overlay, viewBox, scale });
  const png = encodePNG(image);
  const headers: Record<string, string | number> = {
    'Content-Type': 'image/png',
    'Content-Length': png.length,
    'Cache-Control': 'no-store',
    'X-Rev2D-Source': state ? 'editor-state' : 'default-pose',
    'X-Rev2D-ViewBox': viewBox.join(','),
    'X-Rev2D-Scale': String(scale),
    'X-Rev2D-Time': String(pose.time),
  };
  if (hidden.size) headers['X-Rev2D-Hidden'] = [...hidden].map(encodeURIComponent).join(',');
  if (ignored.length) headers['X-Rev2D-Ignored'] = ignored.join(',');
  res.writeHead(200, headers);
  res.end(png);
}

/** Model-relative, forward-slash paths for event payloads. */
export function relativeFiles(store: ModelStore, files: readonly string[]): string[] {
  return files.map((f) => path.relative(store.dir, f).split(path.sep).join('/'));
}
