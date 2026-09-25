/** Model-writing commands: ops, set, new. */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Diagnostic, TextureInfo } from '../../core/types.js';
import { AddressError, parseAddress, suggest } from '../../core/address.js';
import { formatModelJson } from '../../core/format.js';
import { formatDiagnostics, parseJsonc } from '../../core/validate.js';
import { hasErrors, loadModelFile, loadModelObject } from '../../node/load.js';
import { renderFrame } from '../../api/index.js';
import { BUILTIN_TEMPLATES, EXAMPLES_DIR, listTemplates, loadTemplate } from '../../api/templates.js';
import type { Op } from '../../ops/index.js';
import { encodePNG } from '../../render/index.js';
import { UsageError, type FlagSpec } from '../args.js';
import type { Command } from '../command.js';
import { CliError, type Ctx } from '../context.js';
import { frameInput, firstPoseOrFrameFlag } from '../flags.js';
import { plural, table } from '../text.js';

// ----------------------------------------------------------------------------- shared ops runner

const WRITE_FLAGS: FlagSpec[] = [
  { name: 'dry-run', type: 'boolean', description: 'apply and validate but do not write anything' },
  { name: 'out', short: 'o', type: 'string', arg: 'out.r2d.json', description: 'write the result here instead of editing the model in place' },
  { name: 'allow-invalid', type: 'boolean', description: 'write the result even if it has validation errors' },
  { name: 'render', type: 'string', arg: 'out.png', description: 'also render the resulting model (pose and frame flags apply to this render and are rejected without it)' },
];

/** Read all of a stream as UTF-8 text. */
async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Accepts an op object, an array of ops or {"ops": [...]}. */
function normalizeOps(value: unknown, source: string): Op[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { ops?: unknown }).ops)
      ? (value as { ops: unknown[] }).ops
      : [value];
  list.forEach((op, i) => {
    if (!op || typeof op !== 'object' || Array.isArray(op) || typeof (op as { op?: unknown }).op !== 'string') {
      throw new UsageError(
        `${source}${list.length > 1 ? ` item ${i}` : ''}: expected an op object like {"op": "...", ...}`,
        'accepted forms: one op object, an array of ops, or {"ops": [...]}; see "rev2d docs ops"',
      );
    }
  });
  return list as Op[];
}

function parseOpsText(text: string, source: string): Op[] {
  const parsed = parseJsonc(stripBom(text));
  if (!parsed.ok) throw new UsageError(`${source} is not valid JSON: ${parsed.error.message}`, parsed.error.hint);
  return normalizeOps(parsed.value, source);
}

/** Width/height of PNG textures referenced by a raw model (from the IHDR header), for ops that need sizes. */
function textureSizes(doc: unknown, baseDir: string): Record<string, TextureInfo> {
  const sizes: Record<string, TextureInfo> = {};
  const list = (doc as { textures?: unknown } | null)?.textures;
  if (!Array.isArray(list)) return sizes;
  for (const t of list as Array<{ id?: unknown; path?: unknown }>) {
    if (!t || typeof t.id !== 'string' || typeof t.path !== 'string') continue;
    try {
      const bytes = t.path.startsWith('data:')
        ? Buffer.from(t.path.slice(t.path.indexOf(',') + 1), 'base64')
        : readFileSync(path.resolve(baseDir, t.path));
      if (bytes.length >= 24 && bytes.toString('latin1', 1, 4) === 'PNG' && bytes.toString('latin1', 12, 16) === 'IHDR') {
        sizes[t.id] = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
      }
    } catch {
      // unreadable textures are reported by validation of the result
    }
  }
  return sizes;
}

/** Same file? (case-insensitive on Windows, where the file system is) */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Ids of textures of a raw model whose relative path does not resolve from `dir` (the output's directory). */
function unresolvedTextures(doc: unknown, dir: string): string[] {
  const list = (doc as { textures?: unknown } | null)?.textures;
  if (!Array.isArray(list)) return [];
  return (list as Array<{ id?: unknown; path?: unknown }>)
    .filter((t) => typeof t?.path === 'string' && !t.path.startsWith('data:') && !existsSync(path.resolve(dir, t.path)))
    .map((t) => String(t.id));
}

async function runOps(ctx: Ctx, file: string, ops: Op[], origins?: string[]): Promise<number> {
  const abs = ctx.resolve(file);
  const shown = ctx.display(file);
  const renderOut = ctx.args.str('render');
  if (renderOut === undefined) {
    const stray = firstPoseOrFrameFlag(ctx.args);
    if (stray) throw new UsageError(`${stray} only applies together with --render <out.png>`, 'pose and frame flags choose how the edited model is rendered; add --render out.png or drop the flag');
  }
  let text: string;
  try {
    text = stripBom(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new CliError(`cannot read model file ${shown}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, { hint: `create one with "rev2d new ${shown}"` });
  }
  const parsed = parseJsonc(text);
  if (!parsed.ok) throw new CliError(`${shown} is not valid JSON; fix the syntax before applying ops`, { diagnostics: [parsed.error] });

  const dryRun = ctx.args.bool('dry-run') === true;
  const allowInvalid = ctx.args.bool('allow-invalid') === true;
  const baseDir = path.dirname(abs);
  const target = ctx.args.str('out') ? ctx.resolve(ctx.args.str('out')!) : abs;
  const inPlace = samePath(target, abs);
  // Loaded on demand, so the other commands keep working even if the ops engine cannot be loaded.
  const { applyOps } = await import('../../ops/index.js').catch((e: unknown) => {
    throw new CliError(`cannot load the ops engine: ${e instanceof Error ? e.message : String(e)}`, { hint: 'the rev2d installation looks broken; reinstall it' });
  });
  const res = applyOps(parsed.value, ops, { allowInvalid, textures: textureSizes(parsed.value, baseDir) });
  const formatted = formatModelJson(res.doc);
  const changed = formatModelJson(parsed.value) !== formatted;
  const failedOps = res.results.filter((r) => !r.ok).length;
  const errors = res.diagnostics.filter((d) => d.severity === 'error').length;
  // An in-place edit that changes nothing leaves the file (and its comments/formatting) alone.
  const wouldWrite = res.ok && (changed || !inPlace);
  const write = wouldWrite && !dryRun;
  const notes: string[] = [];
  if (wouldWrite && !isPlainJson(text)) notes.push('the written file does not keep the comments and trailing commas of the JSONC input');
  if (res.ok && !inPlace) {
    const missing = unresolvedTextures(res.doc, path.dirname(target));
    if (missing.length) {
      notes.push(`textures ${missing.join(', ')} do not resolve from ${ctx.display(path.dirname(target)) || '.'} (texture paths are relative to the model file): copy the texture files there or fix their paths`);
    }
  }

  // Prepare the render (and reject bad render flags) before anything is written.
  let renderJob: (() => { file: string; width: number; height: number }) | null = null;
  let renderError: string | null = null;
  if (renderOut !== undefined) {
    if (!res.ok) {
      renderError = failedOps ? 'not rendered: the ops failed' : 'not rendered: the result has validation errors';
    } else {
      const loaded = await loadModelObject(res.doc, baseDir, target);
      if (hasErrors(loaded.diagnostics) || !loaded.rig || !loaded.model) {
        renderError = 'not rendered: the resulting model has validation errors';
      } else {
        const input = frameInput(ctx.args, loaded.model, notes);
        renderJob = () => {
          const f = renderFrame(loaded, input);
          return { file: ctx.writeFile(renderOut, encodePNG(f.image)), width: f.image.width, height: f.image.height };
        };
      }
    }
  }

  // Keep the file's line endings (CRLF checkouts on Windows) so the rewrite only shows real changes.
  if (write) ctx.writeFile(target, text.includes('\r\n') ? formatted.replace(/\n/g, '\r\n') : formatted);
  let rendered: { file: string; width: number; height: number } | null = null;
  if (renderJob) {
    // The model may already be written: report a failed render next to the op results, not instead of them.
    try {
      rendered = renderJob();
    } catch (e) {
      renderError = `not rendered: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (ctx.json) {
    ctx.printJson({
      ok: res.ok && !renderError,
      file: abs,
      output: target,
      written: write,
      dryRun,
      changed,
      results: origins ? res.results.map((r) => ({ ...r, source: origins[r.index] })) : res.results,
      diagnostics: res.diagnostics,
      render: rendered,
      renderError,
      notes,
    });
  } else {
    ctx.out(`${failedOps ? `${failedOps} of ${plural(ops.length, 'op')} failed` : `applied ${plural(ops.length, 'op')}`} on ${shown}${dryRun ? ' (dry run)' : ''}`);
    ctx.out(
      ...table(
        res.results.map((r) => [
          r.ok ? 'ok' : 'FAIL',
          `#${r.index}`,
          ...(origins ? [origins[r.index] ?? '-'] : []),
          r.op,
          r.hint && !r.ok ? `${r.message}  → ${r.hint}` : r.message,
        ]),
      ),
    );
    if (res.diagnostics.length) ctx.out('validation of the result:', ...formatDiagnostics(res.diagnostics).split('\n').map((l) => `  ${l}`));
    if (write) {
      ctx.out(`${changed ? 'wrote' : 'wrote (no content change)'} ${ctx.display(target)}`);
    } else if (!res.ok) {
      ctx.out(`not written: ${failedOps ? `${plural(failedOps, 'op')} failed` : `the result has ${plural(errors, 'validation error')} (fix the ops, or pass --allow-invalid to write anyway)`}`);
    } else if (!wouldWrite) {
      ctx.out(`unchanged: the ops do not change the model, so ${ctx.display(target)} is left as it is`);
    } else {
      ctx.out(`dry run: nothing written; without --dry-run this would write ${ctx.display(target)}`);
    }
    if (rendered) ctx.out(`rendered ${ctx.display(rendered.file)} (${rendered.width}x${rendered.height})`);
    if (renderError) ctx.err(`error: --render ${renderError}`);
    ctx.notes(notes);
  }
  return res.ok && !renderError ? 0 : 1;
}

function isPlainJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------- ops

export const ops: Command = {
  name: 'ops',
  group: 'edit',
  summary: 'apply high-level edit operations (atomic, validated) to a model',
  usage: 'ops <model> [ops.json | -]... [--op <json>]... [--dry-run] [-o out.r2d.json] [--allow-invalid] [--render out.png] [--json]',
  args: ['<model>', '[ops.json|-...]'],
  flags: [{ name: 'op', type: 'string', repeat: true, arg: 'json', description: 'one op (or an array of ops) as JSON; repeatable, applied after the ops file' }, ...WRITE_FLAGS],
  flagGroups: ['pose', 'frame'],
  json: true,
  description: [
    'Reads the raw model text (JSONC allowed), applies every op in order and validates the result. All-or-nothing: the file is written (formatted) only when every op succeeded and the result is valid (or --allow-invalid).',
    'Ops come from the files given after the model, in order (or "-" once for stdin; each source holds an op, an array of ops, or {"ops": [...]}), followed by --op flags. All of them form ONE atomic batch. The op catalogue is in "rev2d docs ops".',
    'Exit 1 when an op fails or the result is invalid (nothing is written), or a requested --render fails; exit 2 for malformed op JSON. An in-place edit that changes nothing leaves the file untouched; a rewrite keeps the line endings (LF or CRLF) of the file.',
  ],
  examples: [
    'rev2d ops hero.r2d.json edits.json',
    'rev2d ops hero.r2d.json 01-skeleton.json 02-parts.json 03-bindings.json --dry-run',
    `rev2d ops hero.r2d.json --op '{"op":"set","target":"bone:head.rotation","value":10}' --dry-run`,
    'cat edits.json | rev2d ops hero.r2d.json - --render out/after.png --overlay bones',
  ],
  async run(ctx) {
    const [file, ...sources] = ctx.args.positionals;
    const list: Op[] = [];
    /** Where each op came from ("edits.json", "stdin", "--op #2"), reported when there are several sources. */
    const origins: string[] = [];
    const add = (ops: Op[], origin: string) => {
      list.push(...ops);
      origins.push(...ops.map(() => origin));
    };
    if (sources.filter((s) => s === '-').length > 1) throw new UsageError('"-" (stdin) can be given only once', 'stdin is read once; put the other ops in files');
    for (const source of sources) {
      if (source === '-') {
        const stdin = ctx.io.stdin ?? process.stdin;
        // Reading an interactive terminal would wait forever for input nobody is going to type.
        if ((stdin as { isTTY?: boolean }).isTTY) {
          throw new UsageError('"-" reads the ops from stdin, but stdin is a terminal', `pipe them in (cat edits.json | rev2d ops model.r2d.json -), pass an ops file, or use --op '{"op": ...}'`);
        }
        add(parseOpsText(await readStream(stdin), 'stdin'), 'stdin');
      } else {
        let text: string;
        try {
          text = readFileSync(ctx.resolve(source), 'utf8');
        } catch (e) {
          throw new CliError(`cannot read ops file ${ctx.display(source)}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
        }
        add(parseOpsText(text, ctx.display(source)), ctx.display(source));
      }
    }
    ctx.args.list('op').forEach((raw, i) => add(parseOpsText(raw, `--op #${i + 1}`), `--op #${i + 1}`));
    if (!list.length) throw new UsageError('no ops given', 'pass an ops file, "-" for stdin, or --op \'{"op": ...}\'');
    return runOps(ctx, file, list, origins.length > 1 && new Set(origins).size > 1 ? origins : undefined);
  },
};

// ----------------------------------------------------------------------------- set

/** "address=value": value is JSON when it parses (numbers, booleans, arrays, objects), else a plain string. */
function parseAssignment(raw: string): Op {
  const eq = raw.indexOf('=');
  if (eq <= 0) throw new UsageError(`expected <address>=<value>, got "${raw}"`, 'e.g. bone:head.rotation=15 or part:eye.fill="#223344"');
  const target = raw.slice(0, eq).trim();
  try {
    parseAddress(target);
  } catch (e) {
    if (e instanceof AddressError) throw new UsageError(`bad address "${target}": ${e.message}`, e.hint);
    throw e;
  }
  const text = raw.slice(eq + 1);
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // not JSON: keep the raw string (colors, SVG path data)
  }
  return { op: 'set', target, value };
}

export const set: Command = {
  name: 'set',
  group: 'edit',
  summary: 'set setup values by property address (shorthand for ops "set")',
  usage: 'set <model> <address>=<value>... [--dry-run] [-o out.r2d.json] [--allow-invalid] [--render out.png] [--json]',
  args: ['<model>', '<address=value...>'],
  flags: WRITE_FLAGS,
  flagGroups: ['pose', 'frame'],
  json: true,
  description: [
    'Each assignment becomes {"op": "set", "target": <address>, "value": <value>}. Values are parsed as JSON when possible (15, true, [1,2], {"4":[1,2]}), otherwise kept as strings (#ff0000, SVG path data). Quote values for your shell.',
    'Address grammar: bone:<id>.x|y|rotation|scaleX|scaleY|length, part:<id>.opacity|z|visible|tint|fill|stroke.color|stroke.width|shape.<field>, warp:<id>.offsets, ik:<id>.mix (see "rev2d docs spec").',
  ],
  examples: [
    'rev2d set hero.r2d.json bone:head.rotation=15',
    'rev2d set hero.r2d.json part:eye.fill=#223344 part:eye.shape.ry=12 --render out/eye.png --viewbox fit',
  ],
  async run(ctx) {
    const [file, ...assignments] = ctx.args.positionals;
    return runOps(ctx, file, assignments.map(parseAssignment));
  },
};

// ----------------------------------------------------------------------------- new

const MAX_CANVAS = 8192;

function parseSize(raw: string): [number, number] {
  const m = /^(\d+)x(\d+)$/i.exec(raw.trim());
  const size: [number, number] | null = m ? [Number(m[1]), Number(m[2])] : null;
  if (!size || size.some((v) => v < 1 || v > MAX_CANVAS)) {
    throw new UsageError(`--size expects WxH with sides 1..${MAX_CANVAS}, got "${raw}"`, 'e.g. --size 1024x1024');
  }
  return size;
}

function quoteArg(s: string): string {
  return /[\s"'$&|<>()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export const create: Command = {
  name: 'new',
  group: 'edit',
  summary: 'create a model from a template (blank, empty or a shipped example)',
  usage: 'new <file> [--template name] [--name n] [--size WxH] [--force] [--json]',
  args: ['<file>'],
  flags: [
    { name: 'template', type: 'string', arg: 'name', description: 'template: blank (default; a small complete rig), empty (format, version and meta only: build everything with ops) or an example name (see "rev2d docs examples")' },
    { name: 'name', type: 'string', arg: 'text', description: 'meta.name (default: the file name)' },
    { name: 'size', type: 'string', arg: 'WxH', description: 'canvas size for the blank and empty templates (default 512x512)' },
    { name: 'force', type: 'boolean', description: 'overwrite existing files' },
  ],
  json: true,
  description: [
    'Writes a valid, formatted model (and copies the template\'s texture files next to it, keeping their relative paths), validates it and prints next steps. Refuses to overwrite existing files without --force.',
  ],
  examples: [
    'rev2d new hero.r2d.json',
    'rev2d new models/cat.r2d.json --name Cat --size 1024x768',
    'rev2d new scratch.r2d.json --template empty --size 800x600',
    'rev2d new demo.r2d.json --template <example-name>',
  ],
  async run(ctx) {
    const file = ctx.args.positionals[0];
    const template = ctx.args.str('template') ?? 'blank';
    const templates = listTemplates();
    if (!templates.includes(template)) {
      throw new UsageError(`unknown template "${template}"`, suggest(template, templates) ?? `templates: ${templates.join(', ')}`);
    }
    const sizeRaw = ctx.args.str('size');
    if (sizeRaw !== undefined && !(BUILTIN_TEMPLATES as readonly string[]).includes(template)) {
      throw new UsageError('--size applies to the blank and empty templates only', 'example templates keep their own canvas size');
    }
    const size = sizeRaw !== undefined ? parseSize(sizeRaw) : undefined;
    const abs = ctx.resolve(file);
    const name = ctx.args.str('name') ?? path.basename(abs).replace(/(\.r2d)?\.jsonc?$/i, '');
    if (!name.trim()) throw new UsageError('the model name (meta.name) must not be empty', 'pass --name <text>, or use a file name like hero.r2d.json');
    const force = ctx.args.bool('force') === true;
    if (existsSync(abs) && !force) {
      throw new CliError(`${ctx.display(file)} already exists`, { hint: 'pass --force to overwrite it, or choose another file name' });
    }
    const { doc, textureFiles } = loadTemplate(template, { name, width: size?.[0], height: size?.[1] });
    const dir = path.dirname(abs);
    const copies = textureFiles.map((src) => ({ src, dest: path.resolve(dir, path.relative(path.join(EXAMPLES_DIR, template), src)) }));
    for (const c of copies) {
      if (!existsSync(c.src)) throw new CliError(`template texture is missing: ${c.src}`, { hint: 'the installation looks incomplete; reinstall rev2d' });
      if (!force && existsSync(c.dest) && !readFileSync(c.dest).equals(readFileSync(c.src))) {
        throw new CliError(`texture ${ctx.display(c.dest)} already exists with different content`, { hint: 'pass --force to overwrite it, or create the model in another directory' });
      }
    }
    ctx.writeFile(abs, formatModelJson(doc));
    for (const c of copies) {
      mkdirSync(path.dirname(c.dest), { recursive: true });
      copyFileSync(c.src, c.dest);
    }
    const check = await loadModelFile(abs);
    const diagnostics: Diagnostic[] = check.diagnostics;
    const meta = doc.meta as { width: number; height: number };
    const shown = quoteArg(ctx.display(file));
    const png = quoteArg(`${ctx.display(file).replace(/(\.r2d)?\.jsonc?$/i, '')}.png`);
    const next =
      template === 'empty'
        ? ['rev2d docs ops', `rev2d ops ${shown} edits.json --render ${png} --overlay bones,labels`, `rev2d edit ${shown}`]
        : [`rev2d info ${shown}`, `rev2d render ${shown} -o ${png} --overlay bones,labels`, `rev2d edit ${shown}`];
    if (ctx.json) {
      ctx.printJson({ file: abs, template, name, size: [meta.width, meta.height], textures: copies.map((c) => c.dest), diagnostics, next });
    } else {
      const errors = diagnostics.filter((d) => d.severity === 'error').length;
      const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
      ctx.out(`created ${ctx.display(file)} from template "${template}" (${meta.width}x${meta.height}; ${plural(errors, 'error')}, ${plural(warnings, 'warning')})`);
      if (copies.length) ctx.out(`copied ${plural(copies.length, 'texture')}: ${copies.map((c) => ctx.display(c.dest)).join(', ')}`);
      if (diagnostics.length) ctx.out(formatDiagnostics(diagnostics));
      if (!/\.r2d\.json$/i.test(abs)) ctx.notes(['model files conventionally end in .r2d.json']);
      ctx.out('next steps:', ...next.map((n) => `  ${n}`));
    }
    return hasErrors(diagnostics) ? 1 : 0;
  },
};
