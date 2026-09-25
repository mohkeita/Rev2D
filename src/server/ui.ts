/**
 * Serving the editor UI: the production build (dist/editor) when present, else the Vite dev server
 * in middleware mode (source in editor/), else a page explaining how to build the UI.
 */
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import path from 'node:path';
import { HttpError, sendError } from './http.js';

export type UiMode = 'static' | 'vite' | 'none';

export interface UiHandler {
  mode: UiMode;
  /** Where the UI comes from, or why it is unavailable. */
  detail: string;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void> | void;
  close(): Promise<void>;
}

export interface UiOptions {
  staticDir: string;
  /** Vite config of the editor sources; used when `devVite` is set and no build exists. */
  viteConfig: string;
  devVite: boolean;
  httpServer: Server;
  /** Shown on the fallback page. */
  packageRoot: string;
}

export async function createUiHandler(opts: UiOptions): Promise<UiHandler> {
  const staticDir = path.resolve(opts.staticDir);
  if (existsSync(path.join(staticDir, 'index.html'))) {
    return { mode: 'static', detail: staticDir, handle: (req, res) => serveStatic(staticDir, req, res), close: async () => undefined };
  }
  let reason = `no built UI at ${staticDir}`;
  if (opts.devVite) {
    if (!existsSync(opts.viteConfig)) {
      reason += `; no Vite config at ${opts.viteConfig}`;
    } else {
      try {
        const { createServer } = await import('vite');
        const vite = await createServer({
          configFile: opts.viteConfig,
          server: { middlewareMode: true, ws: { server: opts.httpServer } },
          appType: 'spa',
          clearScreen: false,
        });
        return {
          mode: 'vite',
          detail: `Vite dev middleware (${opts.viteConfig})`,
          // In middleware mode Vite logs compile errors (and shows them in the page overlay), then
          // passes the request on without the error: the 404 must not claim the file is missing.
          handle: (req, res) =>
            vite.middlewares(req, res, () =>
              sendError(res, new HttpError(404, `not found: ${req.url}`, 'if this source file exists, it failed to compile: see the editor server log or the browser error overlay')),
            ),
          close: () => vite.close(),
        };
      } catch (e) {
        reason += `; Vite dev middleware failed: ${(e as Error).message}`;
      }
    }
  }
  return { mode: 'none', detail: reason, handle: (req, res) => serveFallback(req, res, reason, opts.packageRoot), close: async () => undefined };
}

// ----------------------------------------------------------------------------- static build

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== '' && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, new HttpError(405, `${req.method} is not allowed for UI files`, 'use GET', {}, { Allow: 'GET, HEAD' }));
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendError(res, new HttpError(400, `malformed URL path ${JSON.stringify(pathname)}`));
  }
  // Backslashes and NULs never occur in built asset names; rejecting them closes Windows traversal tricks.
  if (decoded.includes('\0') || decoded.includes('\\')) return sendError(res, new HttpError(400, `invalid path ${JSON.stringify(decoded)}`));
  const rel = path.posix.normalize(decoded).replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (rel && isInside(root, abs)) {
    const st = await stat(abs).catch(() => null);
    if (st?.isFile()) return sendFile(req, res, abs, st.size, rel.startsWith('assets/'));
  }
  // SPA fallback: extension-less routes get index.html; missing assets are real 404s.
  if (path.posix.extname(rel) && rel !== 'index.html') return sendError(res, new HttpError(404, `not found: ${decoded}`));
  const index = path.join(root, 'index.html');
  const st = await stat(index);
  return sendFile(req, res, index, st.size, false);
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, size: number, immutable: boolean): void {
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': size,
    // Vite puts content-hashed bundles under assets/; everything else must revalidate.
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ----------------------------------------------------------------------------- no UI available

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function serveFallback(req: IncomingMessage, res: ServerResponse, reason: string, packageRoot: string): void {
  const wantsHtml = req.method === 'GET' && (req.headers.accept ?? 'text/html').includes('text/html');
  if (!wantsHtml) {
    return sendError(res, new HttpError(404, 'the editor UI is not available', `build it: cd "${packageRoot}" && npm run editor:build`, { reason }));
  }
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Rev2D editor - UI not built</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;color:#dde;background:#20242c}
code,pre{background:#11141a;padding:.15em .4em;border-radius:4px}pre{padding:.8em}a{color:#9be7ff}</style></head>
<body><h1>Rev2D editor UI is not built</h1>
<p>The editor server is running, but it has no user interface to serve.</p>
<p>Build the UI once, then reload this page:</p>
<pre>cd "${escapeHtml(packageRoot)}"
npm run editor:build</pre>
<p>Reason: <code>${escapeHtml(reason)}</code></p>
<h2>The API works without the UI</h2>
<ul>
<li><a href="/api/model">GET /api/model</a> - model file text</li>
<li><a href="/api/info">GET /api/info</a> - structure summary and diagnostics</li>
<li><a href="/api/screenshot">GET /api/screenshot</a> - server-side render (PNG)</li>
<li><a href="/api/state">GET /api/state</a> - editor view state</li>
<li>GET /api/events - live change events (SSE)</li>
<li><a href="/api/workspace">GET /api/workspace</a> - workspace root, open model, recent files</li>
<li><a href="/api/files">GET /api/files</a> - files of the workspace (POST /api/open, /api/new, /api/save-as, /api/close, /api/import manage them)</li>
</ul></body></html>
`;
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
  res.end(html);
}
