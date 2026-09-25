/** Reference commands: schema, docs. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { modelJsonSchema } from '../../core/schema.js';
import { suggest } from '../../core/address.js';
import { BUILTIN_TEMPLATES, listTemplates, loadTemplate, PACKAGE_ROOT } from '../../api/templates.js';
import { recipesDescription, RECIPES_SUMMARY } from '../../api/docs.js';
import { UsageError } from '../args.js';
import type { Command } from '../command.js';
import { CliError } from '../context.js';
import { outFlag } from '../flags.js';
import { wrap } from '../text.js';

export const schema: Command = {
  name: 'schema',
  group: 'reference',
  summary: 'print the JSON Schema of the model format',
  usage: 'schema [-o schema.json] [--json]',
  args: [],
  flags: [outFlag('schema.json', 'write to a file instead of stdout')],
  json: true,
  description: [
    'Point your editor or JSON tooling at it for completion; "rev2d validate" performs the full (semantic) validation.',
    'The schema itself is JSON either way; with -o, --json prints {"file": <absolute path>} instead of a message.',
  ],
  examples: ['rev2d schema -o rev2d.schema.json', 'rev2d schema > rev2d.schema.json'],
  async run(ctx) {
    const text = JSON.stringify(modelJsonSchema(), null, 2) + '\n';
    const out = ctx.args.str('out');
    if (!out) {
      ctx.io.stdout.write(text);
      return 0;
    }
    const file = ctx.writeFile(out, text);
    if (ctx.json) ctx.printJson({ file });
    else ctx.out(`wrote ${ctx.display(file)}`);
    return 0;
  },
};

interface DocTopic {
  /** Candidate files relative to the package root; the first existing one is printed. */
  files: string[];
  description: string;
  /** Description derived from the installed file's text (null = not installed), so it never drifts from the file. */
  describe?: (text: string | null) => string;
  /** Built-in text: replaces a missing file (ops) or is appended to it (examples). */
  generated?: { text: () => string | Promise<string>; append: boolean };
}

export const DOC_TOPICS: Record<string, DocTopic> = {
  spec: { files: ['docs/SPEC.md'], description: 'model format and evaluation semantics (addresses, bindings, animation, physics)' },
  ops: {
    files: ['docs/OPS.md'],
    description: 'edit operations for "rev2d ops" / "rev2d set" and the MCP server',
    generated: { text: opCatalogue, append: false },
  },
  cli: { files: ['docs/CLI.md'], description: 'this command-line tool: every command, flag and --json shape' },
  mcp: { files: ['docs/MCP.md'], description: 'MCP server tools for AI agents ("rev2d mcp")' },
  agents: { files: ['docs/AGENTS.md', 'AGENTS.md'], description: 'guide for AI agents authoring Rev2D models' },
  recipes: { files: ['docs/RECIPES.md'], description: RECIPES_SUMMARY, describe: recipesDescription },
  architecture: { files: ['docs/ARCHITECTURE.md'], description: 'how Rev2D is built: modules, evaluation pipeline, renderer, editor, MCP' },
  examples: {
    files: ['examples/README.md'],
    description: 'the shipped example models, usable as "rev2d new <file> --template <name>"',
    generated: { text: templateCatalogue, append: true },
  },
};

/** The op catalogue compiled into src/ops, as Markdown (used when docs/OPS.md is not installed). */
async function opCatalogue(): Promise<string> {
  // Loaded on demand: only this fallback needs the ops engine.
  const { describeOps } = await import('../../ops/index.js');
  const out = [
    '# Rev2D edit ops',
    '',
    '(Generated from the op catalogue built into rev2d; docs/OPS.md is not installed.)',
    '',
    'A batch of ops is atomic: ops run in order on a copy of the model; if any op fails, or the result does not validate (unless --allow-invalid), nothing is written.',
    'Coordinates and values follow docs/SPEC.md: setup-space px, +y down, degrees clockwise, absolute values.',
  ];
  for (const d of describeOps()) {
    out.push('', `## ${d.op}`, '', d.summary, '');
    for (const [k, v] of Object.entries(d.fields)) out.push(`- \`${k}\`: ${v}`);
    out.push('', `Example: \`${JSON.stringify(d.example)}\``);
  }
  return out.join('\n') + '\n';
}

/** Every template with its size, parameters and animations. */
function templateCatalogue(): string {
  const lines = ['# Templates', '', 'Create a copy with `rev2d new <file> --template <name>`.', ''];
  for (const name of listTemplates()) {
    try {
      const { doc } = loadTemplate(name);
      const meta = doc.meta as { width?: number; height?: number; description?: string };
      const ids = (key: string) => ((doc[key] as Array<{ id: string }> | undefined) ?? []).map((x) => x.id).join(', ') || 'none';
      lines.push(`## ${name}  (${(BUILTIN_TEMPLATES as readonly string[]).includes(name) ? 'generated' : `examples/${name}/${name}.r2d.json`}, ${meta.width}x${meta.height})`, '');
      if (meta.description) lines.push(meta.description, '');
      lines.push(`- parameters: ${ids('parameters')}`, `- animations: ${ids('animations')}`, '');
    } catch (e) {
      lines.push(`## ${name}`, '', `(cannot be loaded: ${(e as Error).message})`, '');
    }
  }
  return lines.join('\n');
}

/** The installed file of a topic (absolute path), or null. */
function topicFile(topic: DocTopic): string | null {
  return topic.files.map((f) => path.join(PACKAGE_ROOT, f)).find((f) => existsSync(f)) ?? null;
}

/** A topic's description; `describe` reads it from the installed file (e.g. every recipe heading). */
function describeTopic(topic: DocTopic, file: string | null): string {
  if (!topic.describe) return topic.description;
  let text: string | null = null;
  try {
    text = file ? readFileSync(file, 'utf8') : null;
  } catch {
    text = null;
  }
  return topic.describe(text);
}

/** Width of the text-mode topic listing; longer descriptions wrap under their column. */
const LIST_WIDTH = 120;

/** The text of a topic and where it came from (null when neither a file nor built-in text exists). */
async function readTopic(topic: DocTopic): Promise<{ text: string; path: string | null } | null> {
  const file = topicFile(topic);
  let text: string | null = null;
  if (file) {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      text = null;
    }
  }
  if (topic.generated && (text === null || topic.generated.append)) {
    const built = await topic.generated.text();
    text = text === null ? built : `${text.trimEnd()}\n\n${built}`;
  }
  return text === null ? null : { text, path: file };
}

export const docs: Command = {
  name: 'docs',
  group: 'reference',
  summary: 'print bundled documentation (spec, ops, cli, mcp, agents, recipes, architecture, examples)',
  usage: 'docs [topic] [--json]',
  args: ['[topic]'],
  flags: [],
  json: true,
  description: [
    'Without a topic, lists the topics with their installed file and a description ("recipes" lists every recipe heading of docs/RECIPES.md). The text is printed verbatim (Markdown). "ops" falls back to the op catalogue built into rev2d, and "examples" always ends with the list of templates.',
  ],
  examples: ['rev2d docs', 'rev2d docs spec', 'rev2d docs ops', 'rev2d docs recipes'],
  async run(ctx) {
    const topic = ctx.args.positionals[0];
    const names = Object.keys(DOC_TOPICS);
    if (topic === undefined) {
      const rows = names.map((n) => {
        const t = DOC_TOPICS[n];
        const file = topicFile(t);
        return { topic: n, path: file ?? path.join(PACKAGE_ROOT, t.files[0]), description: describeTopic(t, file), available: file !== null || t.generated !== undefined, file };
      });
      if (ctx.json) {
        ctx.printJson(rows.map(({ file: _file, ...r }) => r));
        return 0;
      }
      const where = (r: (typeof rows)[number]) => (r.file ? DOC_TOPICS[r.topic].files.find((f) => r.file === path.join(PACKAGE_ROOT, f))! : r.available ? '(built in)' : DOC_TOPICS[r.topic].files.join(' or '));
      // Aligned columns; a long description continues on the next lines under its own column.
      const cells = rows.map((r) => [r.topic, where(r), r.available ? r.description : `${r.description} (not installed)`]);
      const w0 = Math.max(...cells.map((c) => c[0].length));
      const w1 = Math.max(...cells.map((c) => c[1].length));
      const indent = ' '.repeat(2 + w0 + 2 + w1 + 2);
      const lines = cells.flatMap(([topicName, where, description]) => {
        const wrapped = wrap(description, LIST_WIDTH, indent);
        return [`  ${topicName.padEnd(w0)}  ${where.padEnd(w1)}  ${(wrapped[0] ?? '').trimStart()}`.trimEnd(), ...wrapped.slice(1)];
      });
      ctx.out('topics:', ...lines, '', 'usage: rev2d docs <topic>');
      return 0;
    }
    const entry = DOC_TOPICS[topic];
    if (!entry) throw new UsageError(`unknown docs topic "${topic}"`, suggest(topic, names) ?? `topics: ${names.join(', ')}`);
    const doc = await readTopic(entry);
    if (!doc) {
      throw new CliError(`the ${topic} docs are not available (${entry.files.join(' or ')} is missing from this installation)`, { hint: 'run "rev2d docs" to see which topics are installed' });
    }
    if (ctx.json) ctx.printJson({ topic, path: doc.path, text: doc.text });
    else ctx.io.stdout.write(doc.text.endsWith('\n') ? doc.text : doc.text + '\n');
    return 0;
  },
};
