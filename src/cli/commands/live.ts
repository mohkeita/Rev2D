/** Live editing: edit (start the editor server), editor state|command|screenshot (talk to it), mcp. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Diagnostic, Model } from '../../core/types.js';
import { suggest } from '../../core/address.js';
import { parseJsonc } from '../../core/validate.js';
import { loadModelFile } from '../../node/load.js';
import { findEditor, listEditors, type EditorCommand, type EditorEntry, type EditorLayer, type EditorState } from '../../node/editor-registry.js';
import { formatLayerSpec, parseLayerSpec, parseLayerSyntax, splitLayerList } from '../../api/layers.js';
import { UsageError, type FlagSpec } from '../args.js';
import type { Command } from '../command.js';
import { CliError, stopSignal, whenAborted, type Ctx } from '../context.js';
import { idHint, parseOverlay, parseParamAssignments, parseViewBox, requireOut, usage } from '../flags.js';
import { num, rect, table } from '../text.js';

const DEFAULT_PORT = 4777;
const REQUEST_TIMEOUT_MS = 15000;
const LOOPBACK = new Set(['localhost', '::1', '[::1]']);
/** Loopback addresses: the whole 127.0.0.0/8 block, ::1 and localhost. */
const isLoopback = (host: string) => LOOPBACK.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

// ----------------------------------------------------------------------------- edit

/** Open a URL with the platform's default handler, detached. Failures only print a note. */
function openBrowser(ctx: Ctx, url: string): void {
  const [cmd, args, verbatim] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], true]
      : process.platform === 'darwin'
        ? ['open', [url], false]
        : ['xdg-open', [url], false];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: verbatim });
    child.on('error', () => ctx.err(`note: could not open a browser; open ${url} manually`));
    child.unref();
  } catch {
    ctx.err(`note: could not open a browser; open ${url} manually`);
  }
}

export const edit: Command = {
  name: 'edit',
  group: 'live',
  summary: 'start the live-reloading web editor for a model',
  usage: 'edit <model> [--port n] [--host h] [--allow-host name]... [--no-open] [--json]',
  args: ['<model>'],
  flags: [
    { name: 'port', type: 'int', min: 0, max: 65535, arg: 'n', description: `port (default ${DEFAULT_PORT}; 0 picks a free port)` },
    { name: 'host', type: 'string', arg: 'address', description: 'interface to bind (default 127.0.0.1; anything else exposes file writes to the network)' },
    { name: 'allow-host', type: 'string', repeat: true, arg: 'name', description: 'also answer requests addressed to this host name (e.g. my-pc.local with --host 0.0.0.0); other names are rejected as a DNS-rebinding guard' },
    { name: 'open', type: 'boolean', description: 'open the editor in the default browser (default; --no-open disables)' },
  ],
  json: true,
  description: [
    'Serves the editor UI and the editor protocol (/api/model, /api/events, /api/state, /api/command, /api/screenshot). External changes to the file reload the editor; edits in the editor are written back to the file.',
    'Registers itself so "rev2d editor ..." and the MCP server can find it. Runs until Ctrl+C. With --json prints NDJSON lines {"event":"listening","url","file","ui":{"mode","detail"}} and {"event":"stopped"}.',
  ],
  examples: ['rev2d edit hero.r2d.json', 'rev2d edit hero.r2d.json --port 0 --no-open'],
  async run(ctx) {
    const file = ctx.args.positionals[0];
    const abs = ctx.resolve(file);
    if (!existsSync(abs)) throw new CliError(`${ctx.display(file)} does not exist`, { hint: `create it first: rev2d new ${ctx.display(file)}` });
    const host = ctx.args.str('host') ?? '127.0.0.1';
    const port = ctx.args.num('port') ?? DEFAULT_PORT;
    // The server answers requests addressed to loopback names and its bind address(es) only
    // (DNS-rebinding guard); --allow-host adds host names.
    const allowedHosts = ctx.args.csv('allow-host');
    if (!isLoopback(host)) {
      const names = allowedHosts.length ? '' : ' by IP address (add --allow-host <name> to also accept a host name)';
      ctx.err(`note: --host ${host} makes the editor (which can write ${ctx.display(file)}) reachable from other machines${names}`);
    }
    const running = listEditors(abs);
    if (running.length) {
      ctx.err(`note: ${ctx.display(file)} is already open in an editor at ${running.map((e) => e.url).join(', ')}; "rev2d editor ..." talks to the newest one`);
    }
    const errors = (await loadModelFile(abs)).diagnostics.filter((d) => d.severity === 'error').length;
    if (errors) ctx.err(`note: ${ctx.display(file)} has ${errors} error${errors === 1 ? '' : 's'}; the editor lists them under Problems ("rev2d validate ${ctx.display(file)}" prints them)`);
    const stop = stopSignal(ctx.io);
    try {
      let server;
      try {
        // Loaded on demand: the server pulls in the editor build/dev tooling, which other commands never need.
        const { startEditorServer } = await import('../../server/index.js');
        server = await startEditorServer({ file: abs, port, host, allowedHosts, log: (m) => ctx.err(`editor: ${m}`) });
      } catch (e) {
        const err = e as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
        const inUse = err.code === 'EADDRINUSE' || err.cause?.code === 'EADDRINUSE';
        throw new CliError(inUse ? `port ${port} is already in use` : `cannot start the editor server: ${err.message}`, {
          hint: inUse ? '--port 0 picks a free port; "rev2d editor state" talks to an editor that is already running' : undefined,
        });
      }
      if (ctx.json) {
        ctx.io.stdout.write(JSON.stringify({ event: 'listening', url: server.url, file: abs, ui: server.ui }) + '\n');
      } else {
        ctx.out(`editing ${ctx.display(file)}`, `  ${server.url}`, 'press Ctrl+C to stop');
        if (server.ui.mode === 'none') ctx.err(`note: the editor UI is unavailable (${server.ui.detail}); the /api endpoints still work`);
      }
      if (ctx.args.bool('open') !== false) (ctx.io.openUrl ?? ((u: string) => openBrowser(ctx, u)))(server.url);
      await whenAborted(stop.signal);
      await server.close();
    } finally {
      stop.dispose();
    }
    if (ctx.json) ctx.io.stdout.write(JSON.stringify({ event: 'stopped' }) + '\n');
    else ctx.out('editor stopped');
    return 0;
  },
};

// ----------------------------------------------------------------------------- editor client

const TARGET_FLAGS: FlagSpec[] = [
  { name: 'model', type: 'string', arg: 'file', description: 'talk to the editor of this model (default: the most recently started editor)' },
  { name: 'url', type: 'string', arg: 'url', description: `editor base URL, e.g. http://127.0.0.1:${DEFAULT_PORT} (skips discovery)` },
];

function locateEditor(ctx: Ctx): EditorEntry {
  const model = ctx.args.str('model');
  const url = ctx.args.str('url');
  if (url !== undefined && !/^https?:\/\/[^/]+/.test(url)) throw new UsageError(`--url must be an http(s) URL, got "${url}"`, `e.g. --url http://127.0.0.1:${DEFAULT_PORT}`);
  const entry = findEditor({ url, file: model !== undefined ? ctx.resolve(model) : undefined });
  if (!entry) {
    throw new CliError(model !== undefined ? `no running editor for ${ctx.display(model)}` : 'no running editor found', {
      hint: `start one with "rev2d edit <model>", or pass --url http://127.0.0.1:${DEFAULT_PORT}`,
    });
  }
  return entry;
}

async function request(entry: EditorEntry, pathname: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  try {
    return await fetch(entry.url + pathname, {
      method: init.method ?? 'GET',
      headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message;
    throw new CliError(`cannot reach the editor at ${entry.url} (${cause})`, { hint: 'is "rev2d edit" still running? Check the URL or start the editor again' });
  }
}

interface EditorFailure {
  message: string;
  hint?: string;
  diagnostics?: Diagnostic[];
}

/** Details of a failed editor response: the server's {error, hint?, diagnostics?} JSON, or plain text. */
async function responseError(res: Response): Promise<EditorFailure> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: unknown; hint?: unknown; diagnostics?: unknown };
    if (typeof body.error === 'string') {
      return {
        message: body.error,
        hint: typeof body.hint === 'string' ? body.hint : undefined,
        diagnostics: Array.isArray(body.diagnostics) && body.diagnostics.length ? (body.diagnostics as Diagnostic[]) : undefined,
      };
    }
  } catch {
    // not JSON
  }
  return { message: text.trim() || res.statusText };
}

async function editorError(res: Response, what: string, extraHint?: string): Promise<CliError> {
  const f = await responseError(res);
  return new CliError(`${what} (${res.status}): ${f.message}`, { hint: [f.hint, extraHint].filter(Boolean).join('; ') || undefined, diagnostics: f.diagnostics });
}

function pngSize(bytes: Buffer): [number, number] | null {
  if (bytes.length < 24 || bytes.toString('latin1', 1, 4) !== 'PNG') return null;
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

export const editorState: Command = {
  name: 'editor state',
  group: 'live',
  summary: 'what the human sees in the running editor: params, time, animations, selection, overlay, view box',
  usage: 'editor state [--model f] [--url u] [--json]',
  args: [],
  flags: TARGET_FLAGS,
  json: true,
  description: ['--json prints {editor: {url, file, pid}, state: EditorState}.'],
  examples: ['rev2d editor state', 'rev2d editor state --model hero.r2d.json --json'],
  async run(ctx) {
    const entry = locateEditor(ctx);
    const res = await request(entry, '/api/state');
    if (res.status === 404) {
      throw new CliError(`the editor at ${entry.url} has not published its view state yet`, { hint: 'open the editor URL in a browser; the page publishes its state once it has loaded' });
    }
    if (!res.ok) throw await editorError(res, `the editor at ${entry.url} did not return its state`);
    const state = (await res.json()) as EditorState;
    if (ctx.json) {
      ctx.printJson({ editor: { url: entry.url, file: entry.file || state.file, pid: entry.pid }, state });
      return 0;
    }
    // Layer strings, so they can be passed back to --anims / --anim.
    const anims = state.animations.map((a) => formatLayerSpec(a));
    const params = Object.entries(state.params);
    ctx.out(
      `editor ${entry.url}  ${ctx.display(state.file || entry.file)}`,
      `time ${num(state.time)}s (${state.playing ? 'playing' : 'paused'})  animations: ${anims.join(', ') || '-'}`,
      `selection: ${state.selection.join(', ') || '-'}`,
      `overlay: ${state.overlay.join(', ') || '-'}`,
      `viewBox: ${rect(state.viewBox)}`,
      `updated: ${state.updatedAt}`,
    );
    if (params.length) ctx.out('params:', ...table(params.map(([id, v]) => [id, num(v)])));
    return 0;
  },
};

const COMMAND_TYPES: EditorCommand['type'][] = ['setParams', 'play', 'pause', 'seek', 'setAnimations', 'select', 'setOverlay', 'focus', 'reload', 'message'];

function checkCommand(value: unknown, source: string): EditorCommand {
  const type = (value as { type?: unknown } | null)?.type;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof type !== 'string') {
    throw new UsageError(`${source}: expected an editor command object like {"type": "pause"}`, `types: ${COMMAND_TYPES.join(', ')}`);
  }
  if (!(COMMAND_TYPES as string[]).includes(type)) {
    throw new UsageError(`${source}: unknown editor command type "${type}"`, suggest(type, COMMAND_TYPES) ?? `types: ${COMMAND_TYPES.join(', ')}`);
  }
  return value as EditorCommand;
}

async function editorModel(entry: EditorEntry): Promise<Model | null> {
  if (!entry.file || !existsSync(entry.file)) return null;
  return (await loadModelFile(entry.file)).model;
}

/** Commands from the sugar flags, in a fixed, documented order. */
function sugarCommands(ctx: Ctx, model: Model | null): EditorCommand[] {
  const a = ctx.args;
  const cmds: EditorCommand[] = [];
  const check = (ids: string[], options: string[] | undefined, kind: string) => {
    if (!options) return;
    for (const id of ids) if (!options.includes(id)) throw new UsageError(`unknown ${kind} "${id}"`, idHint(id, options, `${kind}s`));
  };
  const animIds = model?.animations.map((x) => x.id);
  if (a.bool('reload')) cmds.push({ type: 'reload' });
  if (a.has('anims')) {
    const animations = a.list('anims').flatMap(splitLayerList).filter(Boolean).map((spec) => editorLayer(spec, model));
    cmds.push({ type: 'setAnimations', animations });
  }
  if (a.has('params')) {
    const values = a.list('params');
    const params = model ? parseParamAssignments(values, model, '--params') : looseParams(values);
    cmds.push(a.bool('reset') ? { type: 'setParams', params, reset: true } : { type: 'setParams', params });
  } else if (a.bool('reset')) {
    cmds.push({ type: 'setParams', params: {}, reset: true });
  }
  if (a.has('seek')) cmds.push({ type: 'seek', time: a.num('seek')! });
  if (a.has('play') && a.bool('pause')) throw new UsageError('--play and --pause contradict each other');
  if (a.has('play')) {
    const id = a.str('play')!;
    if (id) check([id], animIds, 'animation');
    cmds.push(id ? { type: 'play', animation: id } : { type: 'play' });
  }
  if (a.bool('pause')) cmds.push({ type: 'pause' });
  if (a.has('select')) {
    const ids = a.csv('select');
    if (model) check(ids, [...model.parts, ...model.bones, ...model.warps].map((x) => x.id), 'part/bone/warp');
    cmds.push({ type: 'select', ids });
  }
  if (a.has('overlay')) cmds.push({ type: 'setOverlay', overlay: parseOverlay(a.csv('overlay')) });
  if (a.has('focus')) cmds.push({ type: 'focus', viewBox: parseViewBox(a.str('focus')!, '--focus') });
  if (a.has('message')) cmds.push({ type: 'message', text: a.str('message')! });
  return cmds;
}

/**
 * One --anims layer string as an editor layer. With the model it is checked like --anim (ids, weights,
 * options); without one (--url only) only its syntax is. The editor plays layers on its own clock, so
 * time= (a fixed layer time) is refused.
 */
function editorLayer(spec: string, model: Model | null): EditorLayer {
  const layer = usage(() => (model ? parseLayerSpec(model, spec) : parseLayerSyntax(spec)), '--anims: ');
  if (layer.time !== undefined) {
    throw new UsageError(`--anims: "${spec}": the editor plays layers on its own clock, so time= is not supported`, `use start=<s> to delay the layer, e.g. "${layer.id},start=${num(layer.time)}"`);
  }
  if (!model && layer.weight !== undefined && !(layer.weight >= 0 && layer.weight <= 1)) {
    throw new UsageError(`--anims: weight of "${spec}" must be within 0..1`, `e.g. "${layer.id}@0.5"`);
  }
  const out: EditorLayer = { id: layer.id };
  if (layer.weight !== undefined) out.weight = layer.weight;
  if (layer.mode !== undefined) out.mode = layer.mode;
  if (layer.start !== undefined) out.start = layer.start;
  if (layer.hold !== undefined) out.hold = layer.hold;
  return out;
}

/** --params without a model to check against (editor found by --url only). */
function looseParams(values: string[]): Record<string, number> {
  const params: Record<string, number> = {};
  for (const item of values.flatMap((v) => v.split(','))) {
    const s = item.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    const v = eq > 0 ? Number(s.slice(eq + 1)) : NaN;
    if (eq <= 0 || s.slice(eq + 1).trim() === '' || !Number.isFinite(v)) throw new UsageError(`--params expects id=value, got "${s}"`, 'e.g. --params AngleX=30,EyeOpen=0.5');
    params[s.slice(0, eq).trim()] = v;
  }
  return params;
}

export const editorCommand: Command = {
  name: 'editor command',
  group: 'live',
  summary: 'drive the running editor: set params, play/pause/seek, select, overlays, focus, messages',
  usage: "editor command ['<EditorCommand json>'] [--params A=1,B=2] [--reset] [--play [id]] [--pause] [--seek t] [--anims layers] [--select ids] [--overlay list] [--focus fit|x,y,w,h] [--message text] [--reload] [--model f] [--url u] [--json]",
  args: ['[json]'],
  flags: [
    { name: 'params', type: 'string', repeat: true, arg: 'A=1,B=2', description: 'setParams: set parameter values (checked against the model)' },
    { name: 'reset', type: 'boolean', description: 'with --params: reset all other parameters to defaults first (alone: reset all)' },
    { name: 'play', type: 'string', optionalValue: true, arg: 'id', description: 'play (optionally switching to animation <id>)' },
    { name: 'pause', type: 'boolean', description: 'pause playback' },
    { name: 'seek', type: 'number', arg: 'seconds', description: 'jump to a time' },
    { name: 'anims', type: 'string', repeat: true, arg: 'layers', description: 'setAnimations: replace the playing layers with these layer strings (comma list or repeated; options attach to the layer before them): "idle,talk@0.8,add,wink,once,start=2"' },
    { name: 'select', type: 'string', repeat: true, arg: 'ids', description: 'select parts/bones/warps (comma-separated; "" clears)' },
    { name: 'overlay', type: 'string', repeat: true, arg: 'list', description: 'setOverlay: bones,mesh,warps,bounds,labels,grid | all | none' },
    { name: 'focus', type: 'string', arg: 'fit|x,y,w,h', description: 'focus the viewport on a region' },
    { name: 'message', type: 'string', arg: 'text', description: 'show a message to the human in the editor' },
    { name: 'reload', type: 'boolean', description: 'reload the model from disk' },
    ...TARGET_FLAGS,
  ],
  json: true,
  description: [
    'Send one command as JSON (an object or an array of objects, see EditorCommand in docs/CLI.md) and/or use the sugar flags, which are sent in this order: reload, anims, params/reset, seek, play/pause, select, overlay, focus, message.',
    'Prints how many editor windows received each command; 0 means no browser has the editor open.',
  ],
  examples: [
    'rev2d editor command --params AngleX=30,EyeOpen=0 --select head',
    'rev2d editor command --play idle',
    `rev2d editor command '{"type":"focus","viewBox":"fit"}'`,
    'rev2d editor command --message "Check the new mouth shapes" --overlay warps',
  ],
  async run(ctx) {
    const raw = ctx.args.positionals[0];
    const commands: EditorCommand[] = [];
    if (raw !== undefined) {
      const parsed = parseJsonc(raw);
      if (!parsed.ok) throw new UsageError(`command JSON is invalid: ${parsed.error.message}`, 'e.g. \'{"type":"setParams","params":{"AngleX":30}}\'');
      const list = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
      list.forEach((c, i) => commands.push(checkCommand(c, list.length > 1 ? `command ${i}` : 'command')));
    }
    const entry = locateEditor(ctx);
    const needsModel = ['anims', 'params', 'play', 'select'].some((f) => ctx.args.has(f));
    commands.push(...sugarCommands(ctx, needsModel ? await editorModel(entry) : null));
    if (!commands.length) throw new UsageError('no command given', 'pass a command as JSON or use flags such as --params, --play, --pause, --seek, --select, --message');
    const sent: Array<{ command: EditorCommand; delivered: number }> = [];
    for (const command of commands) {
      const res = await request(entry, '/api/command', { method: 'POST', body: command });
      if (!res.ok) throw await editorError(res, `the editor rejected ${command.type}`, sent.length ? `${sent.length} earlier command(s) were delivered` : undefined);
      const body = (await res.json()) as { delivered?: number };
      sent.push({ command, delivered: body.delivered ?? 0 });
    }
    if (ctx.json) {
      ctx.printJson({ url: entry.url, sent });
      return 0;
    }
    for (const s of sent) ctx.out(`sent ${s.command.type} -> ${s.delivered} editor window${s.delivered === 1 ? '' : 's'}`);
    if (sent.some((s) => s.delivered === 0)) ctx.notes([`no browser has the editor open; open ${entry.url}`]);
    return 0;
  },
};

/** Render metadata the editor server reports in X-Rev2D-* response headers. */
function screenshotInfo(res: Response): { source: string | null; viewBox: number[] | null; scale: number | null; time: number | null; ignored: string[] } {
  const header = (name: string) => res.headers.get(`x-rev2d-${name}`);
  const numbers = (raw: string | null) => (raw === null ? null : raw.split(',').map(Number));
  const ignored = header('ignored');
  return {
    source: header('source'),
    viewBox: numbers(header('viewbox')),
    scale: numbers(header('scale'))?.[0] ?? null,
    time: numbers(header('time'))?.[0] ?? null,
    ignored: ignored ? ignored.split(',').map((s) => decodeURIComponent(s)) : [],
  };
}

export const editorScreenshot: Command = {
  name: 'editor screenshot',
  group: 'live',
  summary: 'render what the human is looking at (the editor\'s current params/time/animations, overlays and visible region) to a PNG',
  usage: 'editor screenshot -o <out.png> [--overlay list|none] [--scale n] [--viewbox fit|canvas|x,y,w,h] [--model f] [--url u] [--json]',
  args: [],
  flags: [
    { name: 'out', short: 'o', type: 'string', arg: 'out.png', description: 'output PNG file (required)' },
    { name: 'overlay', type: 'string', repeat: true, arg: 'list', description: 'overlay layers: bones,mesh,warps,bounds,labels,grid | all | none (default: the editor\'s overlays)' },
    { name: 'scale', type: 'number', greaterThan: 0, arg: 'n', description: 'output pixels per model pixel (default 1)' },
    { name: 'viewbox', type: 'string', arg: 'fit|canvas|x,y,w,h', description: 'region to render (default: the region visible in the editor, else the canvas)' },
    ...TARGET_FLAGS,
  ],
  json: true,
  description: [
    'Rendered server-side from the editor\'s published view state (the same renderer as "rev2d render"). Without flags it shows what the human sees: their pose, overlays and visible region.',
    '--json prints {file, width, height, url, source, viewBox, scale, time, ignored}: source is "editor-state", or "default-pose" when no browser has published a state yet; ignored lists state ids that no longer exist in the model.',
  ],
  examples: [
    'rev2d editor screenshot -o out/editor.png',
    'rev2d editor screenshot -o out/editor.png --overlay bones,labels --viewbox fit',
    'rev2d editor screenshot -o out/clean.png --overlay none --viewbox canvas',
  ],
  async run(ctx) {
    const out = requireOut(ctx.args, 'rev2d editor screenshot -o editor.png');
    const query = new URLSearchParams();
    // Present but empty ("--overlay none") means no overlays; absent means the editor's overlays.
    if (ctx.args.has('overlay')) query.set('overlay', parseOverlay(ctx.args.csv('overlay')).join(','));
    if (ctx.args.has('scale')) query.set('scale', String(ctx.args.num('scale')));
    const vb = ctx.args.str('viewbox');
    if (vb !== undefined) {
      const parsed = vb.trim() === 'canvas' ? 'canvas' : parseViewBox(vb);
      query.set('viewBox', typeof parsed === 'string' ? parsed : parsed.join(','));
    }
    const entry = locateEditor(ctx);
    const qs = query.toString();
    const res = await request(entry, `/api/screenshot${qs ? `?${qs}` : ''}`);
    if (!res.ok) throw await editorError(res, 'the editor could not take a screenshot');
    const bytes = Buffer.from(await res.arrayBuffer());
    const size = pngSize(bytes);
    if (!size) throw new CliError(`the editor at ${entry.url} returned something that is not a PNG`);
    const file = ctx.writeFile(out, bytes);
    const meta = screenshotInfo(res);
    if (ctx.json) {
      ctx.printJson({ file, width: size[0], height: size[1], url: entry.url, ...meta });
      return 0;
    }
    const details = [meta.viewBox && `viewBox ${meta.viewBox.map((v) => num(v)).join(',')}`, meta.time !== null && `t=${num(meta.time)}s`].filter(Boolean).join(', ');
    ctx.out(`wrote ${ctx.display(file)} (${size[0]}x${size[1]}${details ? `, ${details}` : ''}) from the editor at ${entry.url}`);
    if (meta.source === 'default-pose') ctx.notes(["no browser has published the editor's view state yet, so this shows the default pose"]);
    if (meta.ignored.length) ctx.notes([`the editor state refers to ids the model no longer has (ignored): ${meta.ignored.join(', ')}`]);
    return 0;
  },
};

// ----------------------------------------------------------------------------- mcp

/** Resolves when stdin ends (the MCP client disconnected). */
function stdinClosed(stdin: NodeJS.ReadableStream): Promise<void> {
  const s = stdin as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
  if (s.readableEnded || s.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    s.once('end', resolve);
    s.once('close', resolve);
  });
}

export const mcp: Command = {
  name: 'mcp',
  group: 'reference',
  summary: 'run the MCP server on stdio (for AI agents / MCP clients)',
  usage: 'mcp',
  args: [],
  flags: [],
  description: [
    'Speaks the Model Context Protocol on stdin/stdout until the client disconnects; nothing else is printed to stdout. Relative model paths resolve against the working directory. Tools are listed in "rev2d docs mcp".',
    'Client config example: {"command": "npx", "args": ["rev2d", "mcp"]}',
  ],
  examples: ['rev2d mcp'],
  async run(ctx) {
    const stop = stopSignal(ctx.io);
    try {
      try {
        const { startMcpServer } = await import('../../mcp/server.js');
        await startMcpServer({ cwd: ctx.cwd });
      } catch (e) {
        throw new CliError(`cannot start the MCP server: ${(e as Error).message}`);
      }
      await Promise.race([stdinClosed(ctx.io.stdin ?? process.stdin), whenAborted(stop.signal)]);
    } finally {
      stop.dispose();
    }
    return 0;
  },
};
