/**
 * Client for the editor server protocol (see src/server). All endpoints are same-origin under /api;
 * in development Vite proxies /api to the server on 127.0.0.1:4777.
 *
 * The EditorState / EditorCommand types come from the shared registry module. The import is
 * type-only (erased at build time), so no Node code reaches the browser bundle.
 */
import type { Diagnostic } from '../../src/core/index.js';
import type {
  EditorCommand,
  EditorState,
  FileEntry,
  FileListing,
  ImportRequest,
  NewRequest,
  OpenResult,
  SaveAsRequest,
  TemplateInfo,
  WorkspaceInfo,
} from '../../src/node/editor-registry.js';
import type { ExportRequest, ExportResponse, Live2dImportRequest, Live2dImportResponse } from '../../src/node/interop.js';
import type { InteropReport } from '../../src/interop/types.js';

export type { EditorCommand, EditorState, FileEntry, FileListing, ImportRequest, NewRequest, OpenResult, SaveAsRequest, TemplateInfo, WorkspaceInfo };
export type { ExportRequest, ExportResponse, InteropReport, Live2dImportRequest, Live2dImportResponse };

/** POST /api/import answer: a Spine export converted on the way carries its conversion report. */
export type ImportResult = OpenResult & { report?: InteropReport };

export interface ModelFile {
  /** Absolute path of the model file on the server. */
  file: string;
  /** Raw file text (JSON / JSONC). */
  text: string;
  mtimeMs: number;
}

export interface PutResult {
  ok: boolean;
  written: boolean;
  diagnostics: Diagnostic[];
  mtimeMs: number;
}

export interface ModelChangedEvent {
  origin: 'external' | 'editor';
  mtimeMs: number;
}

/** SSE "file-changed": the server switched the open model (null: none is open now). */
export interface FileChangedEvent {
  file: string | null;
  origin: 'editor' | 'ai';
}

export interface ErrorDetail {
  /** The server's own `error` text (without the "GET /api/x failed" prefix). */
  detail?: string;
  hint?: string;
}

export class ApiRequestError extends Error {
  readonly detail: string;
  readonly hint: string | undefined;
  constructor(
    message: string,
    readonly status: number,
    extra: ErrorDetail = {},
  ) {
    super(message);
    this.detail = extra.detail ?? message;
    this.hint = extra.hint;
  }
}

/** A model-dependent endpoint answered 409 "no model is open": the UI shows its start screen. */
export class NoModelError extends ApiRequestError {}

/** new / save-as / import answered 409 because the target exists (retry with overwrite: true). */
export class FileExistsError extends ApiRequestError {}

/** True for the server's 409 {error: "no model is open"}. */
export function isNoModelResponse(status: number, detail: string | undefined): boolean {
  return status === 409 && /no model is open/i.test(detail ?? '');
}

/** PUT /api/model answered 409: the file changed on disk since the version the write was based on. */
export class ConflictError extends ApiRequestError {
  constructor(
    message: string,
    /** mtime of the version now on disk (base a deliberate overwrite on it). */
    readonly mtimeMs: number,
  ) {
    super(message, 409);
  }
}

export interface PutOptions {
  /** Write even when the model has validation errors (?force=1). */
  force?: boolean;
  /**
   * mtime of the file version the document was derived from: the server refuses the write (409,
   * ConflictError) when the file changed on disk since, instead of silently replacing that change.
   */
  baseMtimeMs?: number;
  /**
   * Absolute path of the model the document belongs to: the server refuses the write (409,
   * FileSwitchedError) when another model was opened meanwhile, so it never lands in the wrong file.
   */
  file?: string;
}

/** PUT /api/model answered 409 because the server has another model open now (it was switched). */
export class FileSwitchedError extends ApiRequestError {
  constructor(
    message: string,
    /** The model the server has open now. */
    readonly file: string,
  ) {
    super(message, 409);
  }
}

const COMMAND_TYPES = new Set<EditorCommand['type']>([
  'setParams',
  'play',
  'pause',
  'seek',
  'setAnimations',
  'select',
  'setOverlay',
  'focus',
  'reload',
  'open',
  'message',
]);

/**
 * Error for a failed response: NoModelError for 409 "no model is open", FileExistsError for other
 * 409s of the endpoints that create files (`exists`), else ApiRequestError. The server's hint is kept.
 */
async function errorFrom(res: Response, what: string, opts: { exists?: boolean } = {}): Promise<ApiRequestError> {
  let detail = res.statusText;
  let hint: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; hint?: unknown };
    if (typeof body.error === 'string') detail = body.error;
    if (typeof body.hint === 'string') hint = body.hint;
  } catch {
    // non-JSON error body: keep the status text
  }
  const message = `${what} failed (HTTP ${res.status}): ${detail}`;
  if (isNoModelResponse(res.status, detail)) return new NoModelError(message, res.status, { detail, hint });
  if (res.status === 409 && opts.exists) return new FileExistsError(message, res.status, { detail, hint });
  return new ApiRequestError(message, res.status, { detail, hint });
}

export async function fetchModel(signal?: AbortSignal): Promise<ModelFile> {
  const res = await fetch('/api/model', { cache: 'no-store', signal });
  if (!res.ok) throw await errorFrom(res, 'GET /api/model');
  const body = (await res.json()) as Partial<ModelFile>;
  if (typeof body.text !== 'string' || typeof body.file !== 'string') {
    throw new ApiRequestError('GET /api/model returned an unexpected body (need {file, text, mtimeMs})', res.status);
  }
  return { file: body.file, text: body.text, mtimeMs: Number(body.mtimeMs) || 0 };
}

/**
 * Write the model. `{doc}` is formatted server-side (formatModelJson). Validation failures come back
 * as `written: false` with diagnostics (either as 200 or as an error status carrying the same body);
 * a write based on an outdated version throws ConflictError.
 */
export async function putModel(body: { doc: unknown } | { text: string }, opts: PutOptions = {}): Promise<PutResult> {
  const res = await fetch(`/api/model${opts.force ? '?force=1' : ''}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...body,
      ...(opts.baseMtimeMs !== undefined ? { baseMtimeMs: opts.baseMtimeMs } : {}),
      ...(opts.file ? { file: opts.file } : {}),
    }),
  });
  let parsed: Partial<PutResult> & { error?: string; file?: unknown };
  try {
    parsed = (await res.json()) as Partial<PutResult> & { error?: string; file?: unknown };
  } catch {
    throw new ApiRequestError(`PUT /api/model failed (HTTP ${res.status}): ${res.statusText}`, res.status);
  }
  if (isNoModelResponse(res.status, parsed.error)) {
    throw new NoModelError(`PUT /api/model failed (HTTP 409): ${parsed.error}`, 409, { detail: parsed.error });
  }
  if (res.status === 409 && typeof parsed.file === 'string') {
    throw new FileSwitchedError(parsed.error ?? 'another model was opened meanwhile', parsed.file);
  }
  if (res.status === 409 && typeof parsed.mtimeMs === 'number') {
    throw new ConflictError(parsed.error ?? 'the file changed on disk', parsed.mtimeMs);
  }
  if (typeof parsed.written !== 'boolean') {
    throw new ApiRequestError(`PUT /api/model failed (HTTP ${res.status}): ${parsed.error ?? res.statusText}`, res.status);
  }
  return {
    ok: parsed.ok ?? parsed.written,
    written: parsed.written,
    diagnostics: parsed.diagnostics ?? [],
    mtimeMs: Number(parsed.mtimeMs) || 0,
  };
}

export function textureUrl(id: string, version: number): string {
  return `/api/texture/${encodeURIComponent(id)}?v=${version}`;
}

/** Fetch and decode a texture into a premultiplied ImageBitmap (what the GL renderer uploads). */
export async function fetchTexture(id: string, version: number, signal?: AbortSignal): Promise<ImageBitmap> {
  const res = await fetch(textureUrl(id, version), { cache: 'no-store', signal });
  if (!res.ok) throw await errorFrom(res, `GET /api/texture/${id}`);
  const blob = await res.blob();
  return createImageBitmap(blob, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
}

// ----------------------------------------------------------------------------- workspace (file management)

async function getJson<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw await errorFrom(res, what);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown, what: string, opts: { exists?: boolean } = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw await errorFrom(res, what, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

function openResult(body: Partial<OpenResult> | null, what: string): OpenResult {
  if (!body || typeof body.file !== 'string' || typeof body.text !== 'string') {
    throw new ApiRequestError(`${what} returned an unexpected body (need {file, text, mtimeMs, notes})`, 200);
  }
  return {
    file: body.file,
    text: body.text,
    mtimeMs: Number(body.mtimeMs) || 0,
    notes: Array.isArray(body.notes) ? body.notes.filter((n): n is string => typeof n === 'string') : [],
  };
}

export async function fetchWorkspace(): Promise<WorkspaceInfo> {
  const body = await getJson<Partial<WorkspaceInfo>>('/api/workspace', 'GET /api/workspace');
  return {
    root: String(body.root ?? ''),
    current: typeof body.current === 'string' ? body.current : null,
    recent: Array.isArray(body.recent) ? body.recent.filter((r): r is string => typeof r === 'string') : [],
  };
}

/** Directory listing, `dir` relative to the workspace root ('' = the root). */
export async function listFiles(dir: string, signal?: AbortSignal): Promise<FileListing> {
  const res = await fetch(`/api/files?dir=${encodeURIComponent(dir)}`, { cache: 'no-store', signal });
  if (!res.ok) throw await errorFrom(res, 'GET /api/files');
  const body = (await res.json()) as Partial<FileListing>;
  return {
    dir: typeof body.dir === 'string' ? body.dir : dir,
    parent: typeof body.parent === 'string' ? body.parent : null,
    entries: Array.isArray(body.entries) ? (body.entries as FileEntry[]) : [],
  };
}

export async function fetchTemplates(): Promise<TemplateInfo[]> {
  const body = await getJson<TemplateInfo[] | { templates?: TemplateInfo[] }>('/api/templates', 'GET /api/templates');
  const list = Array.isArray(body) ? body : (body.templates ?? []);
  return list.filter((t) => t && typeof t.name === 'string').map((t) => ({ name: t.name, description: String(t.description ?? '') }));
}

export async function openModel(file: string): Promise<OpenResult> {
  return openResult(await postJson<Partial<OpenResult>>('/api/open', { file }, 'POST /api/open'), 'POST /api/open');
}

export async function newModel(req: NewRequest): Promise<OpenResult> {
  return openResult(await postJson<Partial<OpenResult>>('/api/new', req, 'POST /api/new', { exists: true }), 'POST /api/new');
}

export async function saveAs(req: SaveAsRequest): Promise<OpenResult> {
  return openResult(await postJson<Partial<OpenResult>>('/api/save-as', req, 'POST /api/save-as', { exists: true }), 'POST /api/save-as');
}

export async function importFiles(req: ImportRequest): Promise<ImportResult> {
  const body = await postJson<Partial<ImportResult>>('/api/import', req, 'POST /api/import', { exists: true });
  const report = body?.report;
  const valid = !!report && Array.isArray(report.issues) && typeof report.stats === 'object';
  return { ...openResult(body, 'POST /api/import'), ...(valid ? { report } : {}) };
}

/** Convert Live2D files into the editor's document; nothing is written (the answer holds the resulting doc). */
export async function live2dImport(req: Live2dImportRequest): Promise<Live2dImportResponse> {
  const body = await postJson<Live2dImportResponse>('/api/live2d-import', req, 'POST /api/live2d-import');
  if (!body || typeof body.ok !== 'boolean' || !body.report) throw new ApiRequestError('POST /api/live2d-import returned an unexpected body', 200);
  return body;
}

/** Export the model into a workspace folder (409 FileExistsError when different files are there). */
export async function exportModel(req: ExportRequest): Promise<ExportResponse> {
  const body = await postJson<ExportResponse>('/api/export', req, 'POST /api/export', { exists: true });
  if (!body || !Array.isArray(body.files) || !body.report) throw new ApiRequestError('POST /api/export returned an unexpected body', 200);
  return body;
}

export async function closeModel(): Promise<void> {
  await postJson<unknown>('/api/close', {}, 'POST /api/close');
}

/** The current model file as an attachment (Content-Disposition from the server). */
export const DOWNLOAD_URL = '/api/download';

/** PNG of the editor's current view, rendered by the server from the published view state. */
export async function fetchScreenshot(): Promise<Blob> {
  const res = await fetch('/api/screenshot', { cache: 'no-store' });
  if (!res.ok) throw await errorFrom(res, 'GET /api/screenshot');
  return res.blob();
}

export async function postState(state: EditorState): Promise<void> {
  const res = await fetch('/api/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
    keepalive: true,
  });
  if (!res.ok) throw await errorFrom(res, 'POST /api/state');
}

export interface EventHandlers {
  onOpen(file: string | null): void;
  onError(): void;
  onModelChanged(e: ModelChangedEvent): void;
  /** Another model was opened (or the model was closed) by any tab or an AI. */
  onFileChanged?(e: FileChangedEvent): void;
  onCommand(c: EditorCommand): void;
  /** Malformed payloads are reported, never thrown. */
  onProtocolError(message: string): void;
}

/** Delays before re-opening an event stream the browser gave up on (the last one repeats). */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

/**
 * Subscribe to /api/events; returns a disposer. EventSource retries network errors by itself but
 * gives up for good on an HTTP error answer (e.g. the dev server proxy's 502 while the editor server
 * restarts); such a stream is re-opened here with a back-off, so the bridge always comes back.
 */
export function connectEvents(h: EventHandlers): () => void {
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let disposed = false;
  const open = (): void => {
    timer = null;
    es = new EventSource('/api/events');
    attach(es, h, () => {
      failures = 0;
    });
    const source = es;
    source.onerror = () => {
      h.onError();
      if (disposed || source.readyState !== EventSource.CLOSED || timer) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(failures++, RECONNECT_DELAYS_MS.length - 1)];
      timer = setTimeout(open, delay);
    };
  };
  open();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}

/** Wire the protocol's named events of one EventSource to the handlers (`connected` on "hello"). */
function attach(es: EventSource, h: EventHandlers, connected: () => void): void {
  const parse = (ev: Event, name: string): unknown => {
    try {
      return JSON.parse((ev as MessageEvent<string>).data);
    } catch {
      h.onProtocolError(`malformed "${name}" event: ${String((ev as MessageEvent).data).slice(0, 120)}`);
      return undefined;
    }
  };
  es.addEventListener('hello', (ev) => {
    connected();
    const data = parse(ev, 'hello') as { file?: unknown } | undefined;
    h.onOpen(typeof data?.file === 'string' ? data.file : null);
  });
  es.addEventListener('model-changed', (ev) => {
    const data = parse(ev, 'model-changed') as Partial<ModelChangedEvent> | undefined;
    if (!data) return;
    h.onModelChanged({ origin: data.origin === 'editor' ? 'editor' : 'external', mtimeMs: Number(data.mtimeMs) || 0 });
  });
  es.addEventListener('file-changed', (ev) => {
    const data = parse(ev, 'file-changed') as { file?: unknown; origin?: unknown } | undefined;
    if (!data) return;
    h.onFileChanged?.({ file: typeof data.file === 'string' ? data.file : null, origin: data.origin === 'ai' ? 'ai' : 'editor' });
  });
  es.addEventListener('command', (ev) => {
    const data = parse(ev, 'command') as { type?: unknown } | undefined;
    if (!data) return;
    if (typeof data.type !== 'string' || !COMMAND_TYPES.has(data.type as EditorCommand['type'])) {
      h.onProtocolError(`unknown command type ${JSON.stringify(data.type)}`);
      return;
    }
    h.onCommand(data as EditorCommand);
  });
}
