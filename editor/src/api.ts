/**
 * Client for the editor server protocol (see src/server). All endpoints are same-origin under /api;
 * in development Vite proxies /api to the server on 127.0.0.1:4777.
 *
 * The EditorState / EditorCommand types come from the shared registry module. The import is
 * type-only (erased at build time), so no Node code reaches the browser bundle.
 */
import type { Diagnostic } from '../../src/core/index.js';
import type { EditorCommand, EditorState } from '../../src/node/editor-registry.js';

export type { EditorCommand, EditorState };

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

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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
  'message',
]);

async function errorFrom(res: Response, what: string): Promise<ApiRequestError> {
  let detail = res.statusText;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') detail = body.error;
  } catch {
    // non-JSON error body: keep the status text
  }
  return new ApiRequestError(`${what} failed (HTTP ${res.status}): ${detail}`, res.status);
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
    body: JSON.stringify(opts.baseMtimeMs !== undefined ? { ...body, baseMtimeMs: opts.baseMtimeMs } : body),
  });
  let parsed: Partial<PutResult> & { error?: string };
  try {
    parsed = (await res.json()) as Partial<PutResult> & { error?: string };
  } catch {
    throw new ApiRequestError(`PUT /api/model failed (HTTP ${res.status}): ${res.statusText}`, res.status);
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
