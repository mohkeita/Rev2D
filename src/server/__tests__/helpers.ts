/** Test fixtures for the editor server: temp model dirs, raw HTTP requests and an SSE client. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { formatModelJson } from '../../core/format.js';
import { blankModel } from '../../api/templates.js';
import { createImage, encodePNG } from '../../render/index.js';
import { startEditorServer, type EditorServer, type EditorServerOptions } from '../index.js';

export const TEX_W = 8;
export const TEX_H = 4;

export function texturePng(color = '#ff0000', w = TEX_W, h = TEX_H): Uint8Array {
  return encodePNG(createImage(w, h, color));
}

/** blankModel (64x64) plus a file texture "tex" shown by an image part and an inline data-URI texture. */
export function testModel(): Record<string, any> {
  const doc = blankModel({ name: 'server-test', width: 64, height: 64 }) as Record<string, any>;
  doc.textures = [
    { id: 'tex', path: 'tex.png' },
    { id: 'inline', path: `data:image/png;base64,${Buffer.from(texturePng('#00ff00', 2, 2)).toString('base64')}` },
  ];
  doc.parts.push({ id: 'badge', shape: { type: 'image', texture: 'tex', x: 4, y: 4 }, z: 2 });
  return doc;
}

export interface Fixture {
  dir: string;
  file: string;
  server: EditorServer;
  base: string;
  /** Messages the server logged. */
  logs: string[];
  close(): Promise<void>;
}

export function makeModelDir(doc: unknown = testModel()): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rev2d-server-'));
  const file = path.join(dir, 'model.r2d.json');
  writeFileSync(file, formatModelJson(doc));
  writeFileSync(path.join(dir, 'tex.png'), texturePng());
  return { dir, file };
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export async function startFixture(opts: Partial<EditorServerOptions> = {}): Promise<Fixture> {
  const { dir, file } = makeModelDir();
  const logs: string[] = [];
  const server = await startEditorServer({
    file,
    port: 0,
    devVite: false,
    register: false,
    staticDir: path.join(dir, 'no-ui'),
    log: (m) => logs.push(m),
    ...opts,
  });
  return {
    dir,
    file,
    server,
    base: server.url,
    logs,
    async close() {
      await server.close();
      removeDir(dir);
    },
  };
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Plain node:http request (fetch cannot set Host or send unnormalized paths). */
export function rawRequest(base: string, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

export interface SseEvent {
  event: string;
  data: any;
}

/** Minimal EventSource: collects events; `next` waits for the first matching event after the cursor. */
export class SseClient {
  readonly events: SseEvent[] = [];
  private cursor = 0;
  private waiters: Array<() => void> = [];
  private buffer = '';
  private markEnded!: () => void;
  /** Resolves when the server ends the stream. */
  readonly ended = new Promise<void>((resolve) => (this.markEnded = resolve));

  constructor(private readonly req: http.ClientRequest) {}

  end(): void {
    this.markEnded();
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length) this.events.push({ event, data: JSON.parse(data.join('\n')) });
    }
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolve with the next event (after previously consumed ones) matching `pred`. */
  async next(pred: (e: SseEvent) => boolean, timeoutMs = 5000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.cursor; i < this.events.length; i++) {
        if (pred(this.events[i])) {
          this.cursor = i + 1;
          return this.events[i];
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for an SSE event; got ${JSON.stringify(this.events.slice(this.cursor))}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Events after the cursor that match `pred`, without consuming them. */
  pending(pred: (e: SseEvent) => boolean): SseEvent[] {
    return this.events.slice(this.cursor).filter(pred);
  }

  close(): void {
    this.req.destroy();
  }
}

/** Connect to /api/events and wait for the hello event. */
export async function openEvents(base: string): Promise<SseClient> {
  const u = new URL('/api/events', base);
  const client = await new Promise<SseClient>((resolve, reject) => {
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, agent: false }, (res) => {
      if (res.statusCode !== 200) reject(new Error(`events: HTTP ${res.statusCode}`));
      res.setEncoding('utf8');
      res.on('data', (c: string) => c && sse.feed(c));
      res.on('error', () => undefined);
      res.on('close', () => sse.end());
      resolve(sse);
    });
    const sse = new SseClient(req);
    req.on('error', (e) => (e as NodeJS.ErrnoException).code === 'ECONNRESET' || reject(e));
  });
  await client.next((e) => e.event === 'hello');
  return client;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
