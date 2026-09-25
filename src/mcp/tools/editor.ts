/**
 * Bridge to a running editor (`rev2d edit <model>`): read what the human sees, drive the view, take
 * screenshots. Editors are discovered through ~/.rev2d/editors (src/node/editor-registry.ts) and
 * spoken to over the editor HTTP protocol (/api/model, /api/state, /api/command, /api/screenshot).
 */
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Diagnostic, Model } from '../../core/types.js';
import { suggest } from '../../core/address.js';
import { parseModelText } from '../../core/validate.js';
import { OVERLAY_LAYERS } from '../../api/index.js';
import { formatLayerSpec, toLayer } from '../../api/layers.js';
import { findEditor, listEditors, type EditorCommand, type EditorEntry, type EditorLayer, type EditorState } from '../../node/editor-registry.js';
import { decodePNG } from '../../render/index.js';
import {
  addTool,
  autoScale,
  displayPath,
  fmtNum,
  fmtScale,
  image,
  json,
  listPreview,
  requireKnownIds,
  resolvePath,
  result,
  text,
  ToolError,
  type ToolContext,
} from '../context.js';
import { editorCommandSchema, toEditorCommand, toViewBox, viewBoxField } from '../schemas.js';
import { paramSummary } from './model.js';

const TIMEOUT_MS = 15_000;

type Rect = [number, number, number, number];

const targetShape = {
  model: z.string().min(1).optional().describe('Model file the editor has open (selects that editor when several are running).'),
  url: z.string().min(1).optional().describe('Editor base URL, e.g. "http://127.0.0.1:4777" (default: discover running editors).'),
};

type Target = { model?: string; url?: string };

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function locate(ctx: ToolContext, a: Target): EditorEntry {
  const file = a.model ? resolvePath(ctx, a.model) : undefined;
  const url = a.url && !/^https?:\/\//i.test(a.url) ? `http://${a.url}` : a.url;
  const running = url || file ? [] : listEditors();
  // Editors of several projects may be open: prefer one editing a file under the working directory.
  const entry = url || file ? findEditor({ url, file }) : (running.find((e) => isInside(ctx.cwd, e.file)) ?? running[0] ?? null);
  if (entry) return entry;
  const start = `ask the user to run \`rev2d edit ${a.model ?? '<model.r2d.json>'}\` (it starts the editor and registers it for these tools), or pass url`;
  const others = file ? listEditors() : [];
  if (others.length) {
    throw new ToolError(
      `no running Rev2D editor has ${displayPath(ctx, file!)} open`,
      [],
      `running editors: ${others.map((e) => `${e.url} (${displayPath(ctx, e.file)})`).join(', ')}; or ${start}`,
    );
  }
  throw new ToolError('no running Rev2D editor found', [], start);
}

function failureReason(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err.name === 'TimeoutError') return `no response within ${TIMEOUT_MS / 1000} s`;
  return err.cause?.code ?? err.cause?.message ?? err.message;
}

/**
 * HTTP call to the editor. Non-2xx statuses (except those in `allow`) throw a ToolError carrying the
 * server's error message, hint and diagnostics ({error, hint?, diagnostics?} bodies).
 */
async function request(entry: EditorEntry, method: 'GET' | 'POST', pathname: string, body?: unknown, allow: number[] = []): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${entry.url}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ToolError(
      `cannot reach the Rev2D editor at ${entry.url}: ${failureReason(e)}`,
      [],
      'the editor may have been closed; ask the user to run `rev2d edit <model>` again',
    );
  }
  if (res.ok || allow.includes(res.status)) return res;
  let raw = '';
  let parsed: { error?: unknown; hint?: unknown; diagnostics?: unknown } = {};
  try {
    raw = await res.text();
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object') parsed = v;
  } catch {
    // unreadable or non-JSON body: status and raw text only
  }
  const detail = typeof parsed.error === 'string' ? parsed.error : raw.trim().slice(0, 500);
  throw new ToolError(
    `editor ${method} ${pathname.split('?')[0]} failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
    Array.isArray(parsed.diagnostics) ? (parsed.diagnostics as Diagnostic[]) : [],
    typeof parsed.hint === 'string' ? parsed.hint : undefined,
  );
}

/** The editor's view state, or null when the UI has not published one yet (404). */
async function fetchState(entry: EditorEntry): Promise<EditorState | null> {
  const res = await request(entry, 'GET', '/api/state', undefined, [404]);
  return res.status === 404 ? null : ((await res.json()) as EditorState);
}

/** The model exactly as the editor has it (GET /api/model); null when missing or invalid. */
async function editorModel(entry: EditorEntry): Promise<Model | null> {
  const res = await request(entry, 'GET', '/api/model', undefined, [404]);
  if (res.status === 404) return null;
  const { text: src } = (await res.json()) as { text?: unknown };
  return typeof src === 'string' ? parseModelText(src).model : null;
}

const noStateHint = (entry: EditorEntry) => `the editor page is probably not open in a browser; ask the user to open ${entry.url}`;

/** "idle", "blink@0.5", "nod@0.5,add,once,start=1": the layer string an agent can pass back (see LAYER_STRINGS). */
export function layerString(l: EditorLayer): string {
  return formatLayerSpec(l);
}

function stateSummary(ctx: ToolContext, s: EditorState, model: Model | null): string {
  const anims = (s.animations ?? []).map(layerString);
  const params = model
    ? `params: ${paramSummary(model, s.params ?? {})}`
    : `params: ${listPreview(Object.entries(s.params ?? {}).map(([k, v]) => `${k}=${fmtNum(v)}`)) || 'none'}`;
  const physics = s.physics === undefined ? '' : `; physics ${s.physics ? 'on' : 'off'}`;
  const lines = [
    `model: ${s.file ? displayPath(ctx, s.file) : '?'}`,
    `time: ${fmtNum(s.time ?? 0)} s (${s.playing ? 'playing' : 'paused'}), animations: ${anims.length ? JSON.stringify(anims) : 'none'}${physics}`,
    params,
    `selection: ${(s.selection ?? []).join(', ') || 'none'}; overlay: ${(s.overlay ?? []).join(', ') || 'none'}`,
  ];
  if (s.pinned?.length) lines.push(`explicit (pinned) params, beating animation and physics: ${listPreview(s.pinned)}`);
  if (s.hidden?.length) lines.push(`hidden in the editor (not drawn): ${listPreview(s.hidden)}`);
  lines.push(`view: ${s.viewBox ? `[${s.viewBox.map(fmtNum).join(', ')}] (model px)` : 'whole canvas'}; updated ${s.updatedAt ?? '?'}`);
  return lines.join('\n');
}

// ----------------------------------------------------------------------------- selection ids

/** Entity kinds the editor selects, with the aliases it accepts (editor/src/state/doc.ts). */
const SELECT_KINDS = ['part', 'bone', 'warp', 'param', 'animation', 'binding', 'ik', 'physics', 'texture'] as const;
type SelectKind = (typeof SELECT_KINDS)[number];
const KIND_ALIASES: Record<string, SelectKind> = { parameter: 'param', anim: 'animation', constraint: 'ik' };

function idsOfKind(model: Model, kind: SelectKind): string[] {
  const items: Array<{ id?: string }> = {
    part: model.parts,
    bone: model.bones,
    warp: model.warps,
    param: model.parameters,
    animation: model.animations,
    binding: model.bindings,
    ik: model.ik,
    physics: model.physics,
    texture: model.textures,
  }[kind];
  // Bindings without an id are selected by index ("binding:3").
  return items.map((x, i) => x.id ?? (kind === 'binding' ? String(i) : '')).filter(Boolean);
}

const hintOf = (h: string | null) => (h ? ` (${h})` : '');

/**
 * Check `select` ids the way the editor resolves them: "kind:id" (part, bone, warp, param, animation,
 * binding, ik, physics, texture) or a bare id of any kind but binding.
 */
function checkSelection(model: Model, ids: string[]): void {
  const bare = SELECT_KINDS.filter((k) => k !== 'binding').flatMap((k) => idsOfKind(model, k));
  const problems: string[] = [];
  for (const ref of ids) {
    const colon = ref.indexOf(':');
    if (colon <= 0) {
      if (!bare.includes(ref)) problems.push(`"${ref}"${hintOf(suggest(ref, bare))}`);
      continue;
    }
    const rawKind = ref.slice(0, colon);
    const kind = (SELECT_KINDS as readonly string[]).includes(rawKind) ? (rawKind as SelectKind) : KIND_ALIASES[rawKind];
    if (!kind) {
      problems.push(`"${ref}" (unknown kind "${rawKind}"; kinds: ${SELECT_KINDS.join(', ')})`);
      continue;
    }
    const known = idsOfKind(model, kind);
    const id = ref.slice(colon + 1);
    if (!known.includes(id)) {
      const hint = suggest(id, known);
      problems.push(`"${ref}"${hint ? ` (${hint.replace(/"([^"]*)"/, `"${kind}:$1"`)})` : ` (${kind} ids: ${listPreview(known, 20) || 'none'})`}`);
    }
  }
  if (problems.length) {
    throw new ToolError(
      `unknown selection id${problems.length === 1 ? '' : 's'}: ${problems.join(', ')}`,
      [],
      'select takes bare ids ("mouth") or "kind:id" ("part:mouth", "param:AngleX", "binding:0")',
    );
  }
}


/** Catch unknown parameter/animation/object ids before the command reaches the UI. */
async function checkCommand(entry: EditorEntry, cmd: EditorCommand): Promise<void> {
  if (!['setParams', 'play', 'setAnimations', 'select'].includes(cmd.type)) return;
  const model = await editorModel(entry);
  if (!model) return; // the editor shows the model's own errors
  const params = model.parameters.map((p) => p.id);
  const anims = model.animations.map((x) => x.id);
  switch (cmd.type) {
    case 'setParams':
      return requireKnownIds('parameter', Object.keys(cmd.params), params);
    case 'play':
      return cmd.animation ? requireKnownIds('animation', [cmd.animation], anims) : undefined;
    case 'setAnimations': {
      requireKnownIds('animation', cmd.animations.map((x) => x.id), anims);
      // Options the editor would not apply (hold false on a looping animation, ...) fail here with a hint.
      for (const layer of cmd.animations) toLayer(model, layer);
      return undefined;
    }
    case 'select':
      return checkSelection(model, cmd.ids);
    default:
      return undefined;
  }
}

// ----------------------------------------------------------------------------- screenshots

interface Shot {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** Region the server rendered (X-Rev2D-ViewBox). */
  viewBox: Rect | null;
  /** Output px per model px the server used (X-Rev2D-Scale): the requested one, or its default. */
  scale: number | null;
  /** "editor-state" or "default-pose" (X-Rev2D-Source). */
  source: string | null;
  /** Ids of the view state that no longer exist in the model (X-Rev2D-Ignored). */
  ignored: string[];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function headerRect(v: string | null): Rect | null {
  const n = (v ?? '').split(',').map(Number);
  return n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0 ? (n as Rect) : null;
}

function positive(v: string | null): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Default scale for a w x h model-px region, sized like rev2d_render (autoScale: longest side 512..1024 px). */
const screenshotScale = autoScale;

async function screenshot(entry: EditorEntry, q: { overlay?: string[]; scale?: number; viewBox?: 'fit' | Rect }): Promise<Shot> {
  const params = new URLSearchParams();
  if (q.overlay) params.set('overlay', q.overlay.join(','));
  if (q.scale !== undefined) params.set('scale', String(q.scale));
  if (q.viewBox) params.set('viewBox', q.viewBox === 'fit' ? 'fit' : q.viewBox.join(','));
  const res = await request(entry, 'GET', `/api/screenshot${params.size ? `?${params}` : ''}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('image/png')) throw new ToolError(`editor screenshot returned "${type}" instead of image/png`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const img = decodePNG(bytes);
  return {
    bytes,
    width: img.width,
    height: img.height,
    viewBox: headerRect(res.headers.get('x-rev2d-viewbox')),
    scale: positive(res.headers.get('x-rev2d-scale')),
    source: res.headers.get('x-rev2d-source'),
    ignored: (res.headers.get('x-rev2d-ignored') ?? '').split(',').filter(Boolean).map(safeDecode),
  };
}

// ----------------------------------------------------------------------------- registration

export function registerEditorTools(server: McpServer, ctx: ToolContext): void {
  addTool(
    server,
    'rev2d_editor_state',
    {
      title: 'What the human sees in the editor',
      description:
        'Read the live view state of a running Rev2D editor (started by the user with `rev2d edit <model>`): model file, time, playing, animation layers (as layer strings with their options), parameter slider values, ' +
        'selected ids, overlay layers, parts hidden in the preview, the physics toggle and the visible viewBox. Use it to answer "what am I looking at?" or to reproduce the pose with ' +
        'rev2d_render/rev2d_inspect (same params/time/animations, physics: false: the params already hold the physics results). ' +
        'Without model/url, the newest editor of a file under the working directory is used.',
      input: z.strictObject(targetShape),
      effect: 'read-only',
    },
    async (a) => {
      const entry = locate(ctx, a);
      const state = await fetchState(entry);
      if (!state) throw new ToolError(`the editor at ${entry.url} has not published a view state yet`, [], noStateHint(entry));
      const model = await editorModel(entry);
      return result([text(`editor ${entry.url}\n${stateSummary(ctx, state, model)}`), json(state)]);
    },
  );

  addTool(
    server,
    'rev2d_editor_command',
    {
      title: 'Drive the editor view',
      description:
        'Send a command to the editor UI the human is looking at (forwarded live to every open editor tab). Variants: ' +
        '{type:"setParams", params:{"AngleX":30}, reset?:true} set sliders = explicit values, which beat animation and physics (reset = others to default) | {type:"play", animation?:"idle"} | {type:"pause"} | {type:"seek", time:1.5} (global seconds) | ' +
        '{type:"setAnimations", animations:[{id:"idle"}, {id:"blink", weight?:1, mode?:"add", start?:2, hold?:false}]} exactly these layers in blend order (the first is the timeline\'s main animation; mode/start/hold as in rev2d_render layers) | ' +
        '{type:"select", ids:["head", "param:AngleX", "ik:armIk", "physics:hair"]} highlight items and show them in the inspector (IK constraints and physics groups with live diagnostics) | ' +
        `{type:"setOverlay", overlay:[${OVERLAY_LAYERS.map((l) => `"${l}"`).join(',')}]} | {type:"focus", viewBox:"fit" or [x,y,w,h]} | {type:"reload"} re-read the model file | ` +
        '{type:"message", text:"..."} show a note to the human. Ids are checked against the model first. Returns how many editor tabs received it.',
      input: z.strictObject({ command: editorCommandSchema, ...targetShape }),
      effect: 'additive',
    },
    async (a) => {
      const entry = locate(ctx, a);
      const command = toEditorCommand(a.command);
      await checkCommand(entry, command);
      const res = await request(entry, 'POST', '/api/command', command);
      const { delivered } = (await res.json()) as { delivered?: number };
      const n = delivered ?? 0;
      const line =
        n > 0
          ? `sent ${command.type} to ${n} editor tab${n === 1 ? '' : 's'} at ${entry.url}`
          : `sent ${command.type}, but no editor tab is connected at ${entry.url}, so nothing received it`;
      return result([text(n > 0 ? line : `${line}\nhint: ${noStateHint(entry)}`), json({ delivered: n, url: entry.url, command })]);
    },
  );

  addTool(
    server,
    'rev2d_editor_screenshot',
    {
      title: 'Screenshot of the editor view',
      description:
        'Render exactly what the human is looking at in the running editor (its current params incl. the editor\'s own physics results and pinned values, time, animation layers with their mode/start/hold options, overlay and visible region, minus the parts hidden in its preview; rendered by the editor server, returned as a PNG), ' +
        'plus a summary of the view state. overlay/scale/viewBox override the view. Default size like rev2d_render: longest side 512..1024 px; the summary names the region and the scale actually used.',
      input: z.strictObject({
        ...targetShape,
        overlay: z.array(z.enum(OVERLAY_LAYERS)).optional().describe('Debug layers to draw (default: the editor\'s overlay; [] = none).'),
        scale: z.number().positive().max(16).optional().describe('Output px per model px (default: auto).'),
        viewBox: viewBoxField,
      }),
      effect: 'read-only',
    },
    async (a) => {
      const entry = locate(ctx, a);
      const viewBox = toViewBox(a.viewBox);
      const [state, model] = await Promise.all([fetchState(entry), editorModel(entry)]);
      let shot: Shot;
      if (a.scale !== undefined) {
        shot = await screenshot(entry, { overlay: a.overlay, scale: a.scale, viewBox });
      } else {
        // Size the image up front when the region is known: the argument, the editor's view, or its
        // canvas before the UI published a state. The region goes into the request together with the
        // scale chosen for it: the human may zoom meanwhile, and a scale only fits its own region.
        const canvas: Rect | null = model ? [0, 0, model.meta.width, model.meta.height] : null;
        const region = viewBox === 'fit' ? null : (viewBox ?? state?.viewBox ?? canvas);
        shot = region
          ? await screenshot(entry, { overlay: a.overlay, scale: screenshotScale(region[2], region[3]), viewBox: region })
          : await screenshot(entry, { overlay: a.overlay, viewBox });
        // "fit" (or an unknown region) is known only once rendered at the server's default scale:
        // resize from the region and effective scale the server reports, not from the image size
        // (output px), and keep that exact region for the second render.
        if (shot.viewBox) {
          const want = screenshotScale(shot.viewBox[2], shot.viewBox[3]);
          if (shot.scale === null || Math.abs(shot.scale - want) > want * 1e-6) {
            shot = await screenshot(entry, { overlay: a.overlay, scale: want, viewBox: shot.viewBox });
          }
        }
      }
      const region = shot.viewBox ? ` of viewBox [${shot.viewBox.map(fmtNum).join(', ')}] (model px)` : '';
      const scaleNote = shot.scale !== null ? ` at scale ${fmtScale(shot.scale)}` : '';
      const lines = [`editor ${entry.url}: ${shot.width}x${shot.height} px screenshot${region}${scaleNote}`];
      if (shot.source === 'default-pose' || !state) lines.push(`rendered the default pose: the view state is not published yet (${noStateHint(entry)})`);
      if (shot.ignored.length) lines.push(`ignored (no longer in the model): ${shot.ignored.join(', ')}`);
      if (state) lines.push(stateSummary(ctx, state, model));
      return result([text(lines.join('\n')), image(shot.bytes)]);
    },
  );
}
