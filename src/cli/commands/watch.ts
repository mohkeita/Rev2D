/** watch: re-validate (and re-render) a model whenever it or one of its textures changes. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { formatDiagnostics } from '../../core/validate.js';
import { hasErrors, loadModelFile } from '../../node/load.js';
import { renderFrame } from '../../api/index.js';
import { encodePNG } from '../../render/index.js';
import type { Command } from '../command.js';
import { CliError, stopSignal, whenAborted } from '../context.js';
import { checkColor, frameInput, outFlag, parseOverlay, parseViewBox } from '../flags.js';
import { plural } from '../text.js';

const DEBOUNCE_MS = 100;

/** Case-insensitive on Windows, where the file system is. */
function key(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** Content hash of the model plus mtime/size of its textures: skips duplicate change events. */
function signature(model: string, textures: string[]): string {
  const h = createHash('sha1');
  try {
    h.update(readFileSync(model));
  } catch {
    h.update('missing');
  }
  for (const t of textures) {
    try {
      const s = statSync(t);
      h.update(`${t}:${s.mtimeMs}:${s.size}`);
    } catch {
      h.update(`${t}:missing`);
    }
  }
  return h.digest('hex');
}

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

export const watch: Command = {
  name: 'watch',
  group: 'live',
  summary: 're-validate (and re-render with -o) whenever the model or its textures change',
  usage: 'watch <model> [-o out.png] [pose flags] [frame flags] [--json]',
  args: ['<model>'],
  flags: [outFlag('out.png', 're-render to this PNG after every change that validates')],
  flagGroups: ['pose', 'frame'],
  json: true,
  description: [
    'Runs once immediately, then after every change (debounced). Runs until Ctrl+C. With --json every run prints one JSON line (NDJSON): {"event":"check", ...}.',
  ],
  examples: ['rev2d watch hero.r2d.json', 'rev2d watch hero.r2d.json -o out/live.png --overlay bones,labels --viewbox fit'],
  async run(ctx) {
    const abs = ctx.resolve(ctx.args.positionals[0]);
    const dir = path.dirname(abs);
    if (!existsSync(dir)) throw new CliError(`directory ${ctx.display(dir)} does not exist`);
    // Model-independent flag errors must fail now, not on the first valid save.
    parseOverlay(ctx.args.csv('overlay'));
    if (ctx.args.str('viewbox') !== undefined) parseViewBox(ctx.args.str('viewbox')!);
    if (ctx.args.str('bg') !== undefined) checkColor(ctx.args.str('bg')!, '--bg');

    const stop = stopSignal(ctx.io);
    const watchers = new Map<string, FSWatcher>();
    let textures: string[] = [];
    let watched = new Set([key(abs)]);
    let last = '';
    let timer: NodeJS.Timeout | null = null;
    let chain: Promise<void> = Promise.resolve();
    let failure: unknown = null;

    const watchDir = (d: string) => {
      if (watchers.has(key(d)) || !existsSync(d)) return;
      const w = fsWatch(d, (_event, name) => {
        // Events can still arrive between the stop signal and closing the watchers.
        if (stop.signal.aborted) return;
        if (name && !watched.has(key(path.resolve(d, name.toString())))) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => schedule(), DEBOUNCE_MS);
      });
      w.on('error', () => watchers.delete(key(d)));
      watchers.set(key(d), w);
    };

    const check = async (first: boolean) => {
      const sig = signature(abs, textures);
      if (!first && sig === last) return;
      last = sig;
      const m = await loadModelFile(abs);
      if (m.model) {
        textures = m.model.textures.filter((t) => !t.path.startsWith('data:')).map((t) => path.resolve(dir, t.path));
        watched = new Set([abs, ...textures].map(key));
        for (const t of textures) watchDir(path.dirname(t));
        last = signature(abs, textures);
      }
      const errors = m.diagnostics.filter((d) => d.severity === 'error').length;
      const warnings = m.diagnostics.filter((d) => d.severity === 'warning').length;
      let rendered: { file: string; width: number; height: number } | null = null;
      let renderError: string | null = null;
      const notes: string[] = [];
      const out = ctx.args.str('out');
      if (out && m.rig && m.model && !hasErrors(m.diagnostics)) {
        try {
          const f = renderFrame(m, frameInput(ctx.args, m.model, notes));
          rendered = { file: ctx.writeFile(out, encodePNG(f.image)), width: f.image.width, height: f.image.height };
        } catch (e) {
          // A flag that no longer matches the edited model (e.g. a renamed parameter) must not stop watching.
          renderError = e instanceof Error ? e.message : String(e);
        }
      }
      if (ctx.json) {
        ctx.io.stdout.write(
          JSON.stringify({ event: 'check', time: new Date().toISOString(), file: abs, ok: errors === 0, errors, warnings, diagnostics: m.diagnostics, render: rendered, renderError, notes }) + '\n',
        );
        return;
      }
      const status = errors ? 'FAIL' : 'ok';
      ctx.out(`[${clock()}] ${ctx.display(abs)}: ${status} (${plural(errors, 'error')}, ${plural(warnings, 'warning')})`);
      if (m.diagnostics.length) ctx.out(...formatDiagnostics(m.diagnostics).split('\n').map((l) => `  ${l}`));
      if (rendered) ctx.out(`  rendered ${ctx.display(rendered.file)} (${rendered.width}x${rendered.height})`);
      if (renderError) ctx.out(`  not rendered: ${renderError}`);
      for (const n of notes) ctx.out(`  note: ${n}`);
    };

    // Runs never overlap; an unexpected failure of the first run ends the command.
    const schedule = (first = false) => {
      chain = chain.then(() => check(first)).catch((e) => {
        if (first) failure = e;
        else ctx.err(`error: ${e instanceof Error ? e.message : String(e)}`);
      });
      return chain;
    };

    try {
      watchDir(dir);
      if (ctx.json) ctx.io.stdout.write(JSON.stringify({ event: 'watching', file: abs }) + '\n');
      else ctx.out(`watching ${ctx.display(abs)} (Ctrl+C to stop)`);
      await schedule(true);
      if (failure) throw failure;
      await whenAborted(stop.signal);
      if (timer) clearTimeout(timer);
      await chain;
    } finally {
      stop.dispose();
      for (const w of watchers.values()) w.close();
    }
    if (ctx.json) ctx.io.stdout.write(JSON.stringify({ event: 'stopped' }) + '\n');
    else ctx.out('stopped');
    return 0;
  },
};
