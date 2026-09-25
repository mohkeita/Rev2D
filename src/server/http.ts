/**
 * Small HTTP helpers for the editor server (node:http only): JSON responses, typed errors, bounded
 * body reading and the localhost guards (Host header against DNS rebinding, Origin against CSRF).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import os, { type NetworkInterfaceInfo } from 'node:os';

/** An error that maps to an HTTP status and a JSON body `{error, hint?, ...extra}`. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly hint?: string,
    public readonly extra: Record<string, unknown> = {},
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, err: HttpError): void {
  const body: Record<string, unknown> = { error: err.message };
  if (err.hint) body.hint = err.hint;
  Object.assign(body, err.extra);
  sendJson(res, err.status, body, err.headers);
}

/** Read the whole request body, rejecting with 413 as soon as it exceeds `maxBytes`. */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const tooLarge = () =>
    new HttpError(413, `request body exceeds the ${maxBytes}-byte limit`, 'send a smaller body (large textures belong in PNG files next to the model)', {}, {
      Connection: 'close',
    });
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.reject(tooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.off('data', onData);
        req.resume(); // discard the rest; the 413 response closes the connection
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

/** Read and parse a JSON request body. */
export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const raw = (await readBody(req, maxBytes)).toString('utf8');
  if (!raw.trim()) throw new HttpError(400, 'request body is empty', 'send a JSON object');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new HttpError(400, `request body is not valid JSON: ${(e as Error).message}`, 'send a JSON object (Content-Type: application/json)');
  }
}

/** Host names the server answers to by default. */
export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Bind addresses meaning "every interface". */
const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::', '[::]']);

/** `name[:port]` where name is a DNS name, an IPv4 address or a bracketed IPv6 address. */
const HOST_PORT = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?$/;

/** URL-canonical hostname (lower-cased, IPv4 normalized, IPv6 compressed in brackets), or null. */
function canonicalHostname(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Canonical hostname of a Host header value, or null unless it is exactly `name[:port]`. */
export function parseHostHeader(value: string): string | null {
  const m = HOST_PORT.exec(value);
  if (!m || (m[2] !== undefined && Number(m[2]) > 65535)) return null;
  return canonicalHostname(m[1]);
}

/** Canonical hostname of a user-supplied host name, address, `host:port` or URL; throws for anything else. */
export function normalizeHostname(name: string): string {
  const s = name.trim();
  let host: string | null;
  if (s.includes('://')) {
    host = canonicalHostname(URL.canParse(s) ? new URL(s).host : '');
  } else if (/^[0-9A-Fa-f:.]+$/.test(s) && s.split(':').length > 2) {
    host = canonicalHostname(`[${s}]`); // bare IPv6 address
  } else {
    host = parseHostHeader(s);
  }
  if (!host) throw new Error(`"${name}" is not a host name or address (e.g. "my-pc.local", "192.168.1.5" or "::1")`);
  return host;
}

/**
 * Host names the server answers to: the loopback names, the address it is bound to (every interface
 * address for a wildcard bind, so other machines can use the IP they reach it by) and `extra`.
 * Accepting IP literals is safe: DNS rebinding needs an attacker-controlled host *name*.
 */
export function allowedHostnames(
  bindHost: string,
  extra: readonly string[] = [],
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = os.networkInterfaces(),
): Set<string> {
  const allowed = new Set(LOCAL_HOSTS);
  if (WILDCARD_HOSTS.has(bindHost)) {
    for (const list of Object.values(interfaces)) {
      for (const i of list ?? []) allowed.add(normalizeHostname(i.address.replace(/%.*$/, ''))); // drop IPv6 zone ids
    }
  } else {
    allowed.add(normalizeHostname(bindHost));
  }
  for (const name of extra) allowed.add(normalizeHostname(name));
  return allowed;
}

/**
 * Localhost guards. Returns an HttpError to send, or null when the request may proceed.
 * - Host must be exactly `name[:port]` naming an allowed host (a DNS-rebinding page sends its own
 *   domain as Host).
 * - State-changing requests from browsers must be same-origin (blocks cross-site "simple" POSTs,
 *   which browsers send without a CORS preflight): Sec-Fetch-Site must be same-origin or none, and
 *   an Origin must name an allowed host. The Origin port is not compared so the Vite dev server
 *   (`npm run editor:dev`) can proxy its page's /api requests here.
 */
export function checkRequestOrigin(req: IncomingMessage, allowed: ReadonlySet<string>): HttpError | null {
  const host = req.headers.host;
  const hostname = host ? parseHostHeader(host) : null;
  if (!hostname || !allowed.has(hostname)) {
    return new HttpError(
      403,
      `forbidden Host header ${host ? JSON.stringify(host) : '(missing)'}`,
      `the editor only answers requests addressed to ${[...allowed].join(', ')} (DNS-rebinding guard); use http://127.0.0.1:<port>`,
    );
  }
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  // Browsers label every request with its initiator; a page on another localhost port is "same-site".
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return new HttpError(403, `forbidden ${site} request (Sec-Fetch-Site: ${site})`, 'the editor API only accepts writes from its own page or from non-browser clients');
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const originHost = URL.canParse(origin) ? canonicalHostname(new URL(origin).host) : null;
    if (!originHost || !allowed.has(originHost)) {
      return new HttpError(403, `forbidden cross-origin request from ${JSON.stringify(origin)}`, 'the editor API only accepts writes from its own page or from non-browser clients');
    }
  }
  return null;
}
