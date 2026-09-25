/**
 * Shared plumbing for the MCP tools: path resolution, fresh model loading, tool-result builders and
 * the error guard that turns every failure into a readable `isError` result (the server never crashes
 * on bad input or broken models).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { Diagnostic, Model } from '../core/types.js';
import type { Rig } from '../core/rig.js';
import { suggest } from '../core/address.js';
import { formatDiagnostics } from '../core/validate.js';
import { ApiError } from '../api/index.js';
import { hasErrors, loadModelFile, type LoadedModel } from '../node/load.js';

export interface ToolContext {
  /** Base directory for relative paths. */
  cwd: string;
}

/** A tool failure with optional model diagnostics and a fix suggestion. */
export class ToolError extends Error {
  constructor(
    message: string,
    public diagnostics: Diagnostic[] = [],
    public hint?: string,
  ) {
    super(message);
  }
}

export type Content = CallToolResult['content'][number];

/**
 * On Windows, a Git Bash / MSYS drive path ("/c/Users/me/a.r2d.json") becomes "C:/Users/me/a.r2d.json":
 * agents whose shell is Git Bash produce such paths, and Node would read them as "C:\c\Users\...".
 */
export function nativePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return p;
  const m = /^\/([a-zA-Z])(?=\/|$)/.exec(p);
  return m ? `${m[1].toUpperCase()}:${p.slice(2) || '/'}` : p;
}

export function resolvePath(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.cwd, nativePath(p));
}

/** Path as shown to the agent: relative to cwd when inside it, else absolute. Always forward slashes. */
export function displayPath(ctx: ToolContext, abs: string): string {
  const rel = path.relative(ctx.cwd, abs);
  if (rel === '') return '.';
  const inside = rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  return (inside ? rel : abs).split(path.sep).join('/');
}

// ----------------------------------------------------------------------------- results

export function text(s: string): Content {
  return { type: 'text', text: s };
}

/** Compact JSON block (machine-readable twin of the text summary). */
export function json(value: unknown): Content {
  return { type: 'text', text: JSON.stringify(value) };
}

/** Inline PNG image block. */
export function image(pngBytes: Uint8Array): Content {
  return { type: 'image', data: Buffer.from(pngBytes).toString('base64'), mimeType: 'image/png' };
}

export function result(content: Content[], isError = false): CallToolResult {
  return isError ? { content, isError: true } : { content };
}

/** Convert anything thrown by a tool into an isError result with diagnostics and hints. */
export function errorResult(e: unknown): CallToolResult {
  const err = e instanceof Error ? e : new Error(String(e));
  const diagnostics = e instanceof ToolError || e instanceof ApiError ? e.diagnostics : [];
  const hint = e instanceof ToolError || e instanceof ApiError ? e.hint : undefined;
  const lines = [`Error: ${err.message}`];
  if (hint) lines.push(`hint: ${hint}`);
  // ApiError messages from requireRig already embed the formatted errors; don't repeat them.
  if (diagnostics.length && !(e instanceof ApiError)) lines.push('', formatDiagnostics(diagnostics));
  const content = [text(lines.join('\n'))];
  if (diagnostics.length) content.push(json({ ok: false, error: err.message, ...(hint ? { hint } : {}), diagnostics }));
  return result(content, true);
}

export async function guard(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return errorResult(e);
  }
}

export interface ToolDef<S extends z.ZodObject> {
  title: string;
  description: string;
  input: S;
  /** read-only: changes nothing; additive: may write new outputs (save_to) or change the editor view; destructive: rewrites model files. */
  effect: 'read-only' | 'additive' | 'destructive';
}

/** Register a tool whose handler failures become isError results instead of protocol errors. */
export function addTool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  def: ToolDef<S>,
  handler: (args: z.output<S>) => Promise<CallToolResult>,
): void {
  // Widen to the concrete ZodObject so the SDK's conditional callback type resolves; the SDK has
  // already parsed the arguments with def.input when the callback runs.
  const input: z.ZodObject = def.input;
  server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: input,
      annotations: {
        title: def.title,
        readOnlyHint: def.effect === 'read-only',
        destructiveHint: def.effect === 'destructive',
        openWorldHint: false,
      },
    },
    (args) => guard(() => handler(args as z.output<S>)),
  );
}

// ----------------------------------------------------------------------------- models

export type ReadyModel = LoadedModel & { file: string; model: Model; rig: Rig };

/**
 * "not found" error listing nearby files of the same kind so the agent can correct the path. When
 * `abs` is a directory, the files inside it are listed instead.
 */
export function fileNotFound(ctx: ToolContext, abs: string, kind: 'model' | 'image' = 'model'): ToolError {
  const ext = kind === 'model' ? '.r2d.json' : '.png';
  const noun = kind === 'model' ? 'model file' : 'image';
  const isDir = statSync(abs, { throwIfNoEntry: false })?.isDirectory() ?? false;
  const dir = isDir ? abs : path.dirname(abs);
  let nearby: string[] = [];
  if (existsSync(dir)) {
    try {
      nearby = readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith(ext))
        .sort()
        .slice(0, 12)
        .map((n) => displayPath(ctx, path.join(dir, n)));
    } catch {
      // unreadable directory: no suggestions
    }
  }
  const hint = nearby.length
    ? `${ext} files in ${displayPath(ctx, dir)}: ${nearby.join(', ')}`
    : `relative paths resolve against ${ctx.cwd}${kind === 'model' ? '; create a model with rev2d_create_model' : ''}`;
  const message = isDir ? `${displayPath(ctx, abs)} is a directory, not ${kind === 'model' ? 'a model file' : 'a PNG file'}` : `${noun} not found: ${displayPath(ctx, abs)}`;
  return new ToolError(message, [], hint);
}

/** Load a model fresh from disk (files change between calls). Throws ToolError unless it is renderable. */
export async function loadModel(ctx: ToolContext, p: string): Promise<ReadyModel> {
  const abs = resolvePath(ctx, p);
  const m = await loadModelFile(abs);
  if (m.diagnostics.some((d) => d.code === 'file-not-found')) throw fileNotFound(ctx, abs);
  if (!m.model || !m.rig || hasErrors(m.diagnostics)) {
    const n = m.diagnostics.filter((d) => d.severity === 'error').length;
    throw new ToolError(
      `${displayPath(ctx, abs)} has ${n} error${n === 1 ? '' : 's'}; fix them before rendering or inspecting`,
      m.diagnostics,
      'each diagnostic gives a JSON pointer into the file, a code and a fix; rev2d_validate shows the same list',
    );
  }
  return m as ReadyModel;
}

/** Throw a did-you-mean ToolError when any of `wanted` is not in `all`. */
export function requireKnownIds(kind: string, wanted: string[], all: string[]): void {
  const unknown = [...new Set(wanted.filter((id) => !all.includes(id)))];
  if (!unknown.length) return;
  const known = [...new Set(all)];
  const hints = unknown.map((u) => suggest(u, known)).filter((h): h is string => h !== null);
  throw new ToolError(
    `unknown ${kind} id${unknown.length === 1 ? '' : 's'}: ${unknown.map((u) => `"${u}"`).join(', ')}`,
    [],
    hints.length ? hints.join('; ') : `${kind} ids in this model: ${listPreview(known) || 'none'}`,
  );
}

/**
 * Animation id of a pose layer: "idle", "blink@0.5" (id@weight), "talk@0.8,add" / "wink,once,start=2"
 * (comma options, as parsed by the API) or {id}.
 */
export function layerId(layer: string | { id: string }): string {
  if (typeof layer !== 'string') return layer.id;
  const head = layer.split(',')[0].trim();
  const at = head.lastIndexOf('@');
  return at > 0 ? head.slice(0, at).trim() : head;
}

/**
 * Did-you-mean checks for the parameter and animation ids of a pose (the API only lists what exists),
 * and the weight of "id@weight" layers (0..1, like the object form). Layer options (",add", ",once",
 * ",start=1") are checked by the API when the pose is evaluated (ApiError with a hint).
 */
export function requirePoseIds(model: Model, pose: { params?: Record<string, number>; animations?: Array<string | { id: string }> }): void {
  requireKnownIds('parameter', Object.keys(pose.params ?? {}), model.parameters.map((p) => p.id));
  requireKnownIds('animation', (pose.animations ?? []).map(layerId), model.animations.map((a) => a.id));
  for (const layer of pose.animations ?? []) {
    if (typeof layer !== 'string') continue;
    const head = layer.split(',')[0].trim();
    const at = head.lastIndexOf('@');
    if (at <= 0) continue;
    const w = head.slice(at + 1);
    if (!(w.trim() !== '' && Number(w) >= 0 && Number(w) <= 1)) {
      const id = layerId(layer);
      throw new ToolError(`bad layer weight in "${layer}"`, [], `write "${id}@0.5" (weight 0..1) or {"id": "${id}", "weight": 0.5}`);
    }
  }
}

/**
 * API notes name CLI flags ("(--viewbox fit)", "(--warmup 10)"); MCP callers pass arguments instead,
 * so the flags are rewritten to the tool argument ("viewBox \"fit\"", "warmup: 10").
 */
export function mcpText(s: string): string {
  return s
    .replace(/\s*\(--viewbox fit\)/g, ' (viewBox "fit")')
    .replace(/\(--warmup ([\d.]+)\)/g, '(warmup: $1)')
    .replace(/--viewbox fit/g, 'viewBox "fit"');
}

/** "N warnings (see rev2d_validate)" note, or '' when clean. */
export function warningNote(diags: Diagnostic[]): string {
  const n = diags.filter((d) => d.severity === 'warning').length;
  return n ? `${n} validation warning${n === 1 ? '' : 's'} (see rev2d_validate)` : '';
}

/** Write bytes to `p` (relative to cwd), creating directories. Returns the display path. */
export async function saveFile(ctx: ToolContext, p: string, bytes: Uint8Array): Promise<string> {
  const abs = resolvePath(ctx, p);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return displayPath(ctx, abs);
}

const fileLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` exclusively for `file` within this process. Clients issue tool calls in parallel; two
 * read-modify-write calls on one model must not overwrite each other's result.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const run = (fileLocks.get(key) ?? Promise.resolve()).then(fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  fileLocks.set(key, settled);
  try {
    return await run;
  } finally {
    if (fileLocks.get(key) === settled) fileLocks.delete(key);
  }
}

// ----------------------------------------------------------------------------- image sizing

/** Longest side of images returned inline, unless the caller sets an explicit scale. */
export const MAX_IMAGE_SIDE = 1024;
/** Small views are enlarged (up to MAX_UPSCALE x) until their longest side reaches this. */
export const MIN_IMAGE_SIDE = 512;
export const MAX_UPSCALE = 4;

/**
 * Default render scale for a w x h model-space region: fit into [MIN, MAX] image px. Rounded DOWN
 * (so the longest side never exceeds MAX_IMAGE_SIDE) to 3 decimals (0.512, 2.56), or to 4
 * significant digits below 0.1, so huge regions still get a usable scale (a 2,200,000 px region:
 * 0.0004654, not 0).
 */
export function autoScale(w: number, h: number): number {
  const side = Math.max(w, h);
  if (!(side > 0) || !Number.isFinite(side)) return 1;
  let s = 1;
  if (side > MAX_IMAGE_SIDE) s = MAX_IMAGE_SIDE / side;
  else if (side < MIN_IMAGE_SIDE) s = Math.min(MAX_UPSCALE, MIN_IMAGE_SIDE / side);
  const decimals = s >= 0.1 ? 3 : 3 - Math.floor(Math.log10(s));
  const k = 10 ** decimals;
  // The epsilon keeps exact products (0.29 * 1000 = 289.99999...) from losing a unit.
  const out = Math.floor(s * k * (1 + 1e-12)) / k;
  return out > 0 ? Number(out.toFixed(decimals)) : s;
}

/**
 * Largest rendered image side with an explicit scale. Clients downsample inline images to ~1.5k px
 * anyway, and the rasterizer's float framebuffer grows with the square of the side (2048 px = 256 MiB).
 */
export const MAX_RENDER_SIDE = 2048;
/** Largest contact sheet side (cells are composed at 4 bytes per pixel). */
export const MAX_SHEET_SIDE = 4096;

/** Reject an output of w x h px beyond `max` before anything is rendered. */
export function checkOutputSize(what: string, w: number, h: number, max: number): void {
  if (w >= 1 && h >= 1 && w <= max && h <= max) return;
  throw new ToolError(
    w < 1 || h < 1 ? `${what} would be ${w}x${h} px (empty)` : `${what} would be ${w}x${h} px; the limit is ${max} px per side`,
    [],
    w < 1 || h < 1
      ? 'raise scale or use a larger viewBox'
      : 'lower scale (omit it for automatic sizing) and zoom into details with viewBox [x, y, w, h]; for large exports use the CLI: rev2d render <model> -o out.png --scale <n>',
  );
}

/** Comma list truncated after `max` items: "a, b, c, ... (+7 more)". */
export function listPreview(items: string[], max = 40): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')}, ... (+${items.length - max} more)`;
}

export function fmtNum(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** A render scale in its shortest exact form (4 significant digits: tiny scales of huge regions stay readable). */
export function fmtScale(s: number): string {
  return String(Number(s.toPrecision(4)));
}
