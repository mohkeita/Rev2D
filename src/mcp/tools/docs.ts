/**
 * Knowledge tools and resources: the quickstart guide, JSON Schemas and the package documentation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as schemas from '../../core/schema.js';
import { suggest } from '../../core/address.js';
import { BUILTIN_TEMPLATES, listTemplates, loadTemplate, PACKAGE_ROOT } from '../../api/templates.js';
import { recipeTitles } from '../../api/docs.js';
import { describeOps, type OpDescription } from '../../ops/index.js';
import { addTool, json, result, text, ToolError } from '../context.js';
import { GUIDE } from '../guide.js';

/** Sub-schemas by name: every `<Name>Schema` zod export of core/schema.ts ("Model", "Part", "Binding", ...). */
const SCHEMAS = new Map<string, z.ZodType>();
for (const [key, value] of Object.entries(schemas) as Array<[string, unknown]>) {
  if (key.endsWith('Schema') && value instanceof z.ZodType) SCHEMAS.set(key.slice(0, -'Schema'.length), value);
}

export function schemaNames(): string[] {
  return [...SCHEMAS.keys()];
}

/**
 * JSON Schema (input side: defaults optional) of the whole model or of one sub-schema, looked up
 * case-insensitively ("binding", "BindingSchema"); `name` is the canonical name.
 */
export function jsonSchemaFor(name?: string): { name: string; schema: unknown } {
  if (!name) return { name: 'Model', schema: schemas.modelJsonSchema() };
  const key = schemaNames().find((n) => n.toLowerCase() === name.trim().toLowerCase().replace(/schema$/, ''));
  if (!key) {
    throw new ToolError(`unknown schema "${name}"`, [], suggest(name, schemaNames()) ?? `available: ${schemaNames().join(', ')}`);
  }
  return { name: key, schema: z.toJSONSchema(SCHEMAS.get(key)!, { io: 'input', unrepresentable: 'any' }) };
}

// ----------------------------------------------------------------------------- op catalogue

/**
 * Longest tool description that reaches the model intact: Claude Code cuts MCP tool descriptions (and
 * server instructions) after 2048 characters. Longer reference material goes into input-field
 * descriptions or rev2d_docs.
 */
export const MAX_TOOL_DESCRIPTION = 2048;

const isRequired = (fieldDoc: string) => fieldDoc.startsWith('(required');

/** First sentence of a summary ("e.g. x" and "a.b" do not end a sentence). */
function firstSentence(s: string): string {
  const m = /^(.*?[.!?])(?=\s+[A-Z"(]|$)/s.exec(s.trim());
  return m ? m[1] : s.trim();
}

/** Cut at a word boundary within `max` characters, marking the cut with "…". */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:(]+$/, '')}…`;
}

/**
 * One line per op: name, fields (* = required) and the first sentence of its summary, shortened
 * step by step (down to names and fields only) until the list fits `budget` characters.
 */
export function formatOpBrief(budget: number): string {
  const ops = describeOps();
  const line = (d: OpDescription, max: number) => {
    const fields = Object.entries(d.fields).map(([k, v]) => (isRequired(v) ? `${k}*` : k));
    const head = `- ${d.op} {${fields.join(', ')}}`;
    return max > 0 ? `${head}: ${clip(firstSentence(d.summary), max)}` : head;
  };
  for (let max = 200; max >= 20; max -= 5) {
    const text = ops.map((d) => line(d, max)).join('\n');
    if (text.length <= budget) return text;
  }
  return ops.map((d) => line(d, 0)).join('\n');
}

/** Every op's example, one JSON object per line (for the `ops` input-field description). */
export function formatOpExamples(): string {
  return describeOps()
    .map((d) => JSON.stringify(d.example))
    .join('\n');
}

/** The op catalogue as markdown with every field documented (fallback for docs/OPS.md). */
export function formatOpCatalogue(): string {
  const ops = describeOps();
  const out = [
    '# Rev2D edit ops (rev2d_apply_ops)',
    '',
    'A batch of ops is atomic: ops run in order on a copy of the model; if any op fails, or the result does not validate (unless allow_invalid), nothing is written.',
    'Addresses, coordinates and values follow docs/SPEC.md: setup-space px, +y down, degrees clockwise, absolute values.',
  ];
  for (const d of ops) {
    out.push('', `## ${d.op}`, '', d.summary, '');
    for (const [k, v] of Object.entries(d.fields)) out.push(`- \`${k}\`: ${v}`);
    out.push('', `Example: \`${JSON.stringify(d.example)}\``);
  }
  return out.join('\n');
}

// ----------------------------------------------------------------------------- docs

export const DOC_TOPICS = ['library', 'spec', 'ops', 'cli', 'mcp', 'recipes', 'interop', 'avatar', 'architecture', 'examples', 'agents'] as const;
export type DocTopic = (typeof DOC_TOPICS)[number];

/** Candidate files per topic, relative to the package root (first existing wins). */
const DOC_FILES: Record<Exclude<DocTopic, 'examples'>, string[]> = {
  library: ['docs/LIBRARY.md'],
  spec: ['docs/SPEC.md'],
  ops: ['docs/OPS.md'],
  cli: ['docs/CLI.md'],
  mcp: ['docs/MCP.md'],
  recipes: ['docs/RECIPES.md'],
  interop: ['docs/INTEROP.md'],
  avatar: ['docs/AVATAR.md'],
  architecture: ['docs/ARCHITECTURE.md'],
  agents: ['docs/AGENTS.md', 'AGENTS.md'],
};

async function readDocFile(root: string, candidates: string[]): Promise<string | null> {
  for (const rel of candidates) {
    const abs = path.join(root, rel);
    if (existsSync(abs)) return readFile(abs, 'utf8');
  }
  return null;
}

/** Example catalogue: every template with its description, parameters and animations. */
function examplesCatalogue(): string {
  const lines = ['# Rev2D templates / examples', '', 'Create a copy with rev2d_create_model {path, template}.', ''];
  for (const name of listTemplates()) {
    try {
      const { doc } = loadTemplate(name);
      const meta = doc.meta as { name?: string; width?: number; height?: number; description?: string };
      const ids = (key: string) => ((doc[key] as Array<{ id: string }> | undefined) ?? []).map((x) => x.id);
      const where = (BUILTIN_TEMPLATES as readonly string[]).includes(name) ? 'generated' : `examples/${name}/${name}.r2d.json`;
      lines.push(`## ${name}  (${where}, ${meta.width}x${meta.height})`);
      if (meta.description) lines.push(meta.description);
      lines.push(`parameters: ${ids('parameters').join(', ') || 'none'}`);
      lines.push(`animations: ${ids('animations').join(', ') || 'none'}`, '');
    } catch (e) {
      lines.push(`## ${name}`, `(cannot be loaded: ${(e as Error).message})`, '');
    }
  }
  return lines.join('\n');
}

/** The documentation of `topic` from the package at `root` (tests pass another root to check fallbacks). */
export async function readDoc(topic: DocTopic, root: string = PACKAGE_ROOT): Promise<string> {
  if (topic === 'examples') {
    const readme = await readDocFile(root, ['examples/README.md']);
    return readme ? `${readme.trimEnd()}\n\n${examplesCatalogue()}` : examplesCatalogue();
  }
  const doc = await readDocFile(root, DOC_FILES[topic]);
  // docs/OPS.md is preferred; without it, the catalogue compiled into the ops module still answers.
  if (doc === null && topic === 'ops') return formatOpCatalogue();
  // Without a separate agents guide, the quickstart is the guidance for AI agents.
  if (doc === null && topic === 'agents') return `(No AGENTS.md in this installation; this is the rev2d_guide quickstart for AI agents.)\n\n${GUIDE}`;
  if (doc === null) {
    throw new ToolError(
      `the "${topic}" documentation (${DOC_FILES[topic].join(' or ')}) is not present in ${root}`,
      [],
      `other topics: ${DOC_TOPICS.filter((t) => t !== topic).join(', ')}; rev2d_guide is always available`,
    );
  }
  return doc;
}

/**
 * The recipes entry of the rev2d_docs description, listing the recipes of the installed
 * docs/RECIPES.md by their numbered headings so it never drifts from the file.
 */
export function recipesTopicText(root: string = PACKAGE_ROOT): string {
  let titles: string[] = [];
  try {
    titles = recipeTitles(readFileSync(path.join(root, 'docs', 'RECIPES.md'), 'utf8'));
  } catch {
    // Not installed: fall back to the generic text.
  }
  return titles.length
    ? `recipes = copy-paste op batches with the commands that verify them (${titles.length} recipes: ${titles.join(', ')})`
    : 'recipes = copy-paste op batches with the commands that verify them';
}

// ----------------------------------------------------------------------------- registration

export function registerDocTools(server: McpServer): void {
  addTool(
    server,
    'rev2d_guide',
    {
      title: 'Rev2D quickstart (call this first)',
      description:
        'CALL THIS FIRST when working with Rev2D models (*.r2d.json). Returns the quickstart for AI authors: coordinate conventions (setup-space px, +y down, degrees clockwise), ' +
        'the authoring/verification workflow, the property address grammar (bone:<id>.rotation, warp:<id>.offsets, part:<id>.shape.ry, param:<id>), ' +
        'binding/warp/physics concepts, copy-paste op recipes (head turn with bind_warp, blink via a shape binding, physics hair, idle loop), pitfalls and a map of the other tools.',
      input: z.strictObject({}),
      effect: 'read-only',
    },
    async () => result([text(GUIDE)]),
  );

  addTool(
    server,
    'rev2d_schema',
    {
      title: 'Rev2D JSON Schema',
      description:
        'JSON Schema of the model format (input form: fields with defaults are optional; descriptions document every field). Without `name`: the whole model schema. ' +
        `With \`name\`: one sub-schema, one of ${schemaNames().join(', ')}.`,
      input: z.strictObject({
        name: z.string().min(1).optional().describe('Sub-schema name, e.g. "Part", "Shape", "Binding", "Animation", "Physics" (case-insensitive).'),
      }),
      effect: 'read-only',
    },
    async (a) => {
      const { name, schema } = jsonSchemaFor(a.name);
      const head = a.name ? `JSON Schema of ${name}:` : `JSON Schema of a Rev2D model file. Sub-schemas by name: ${schemaNames().join(', ')}.`;
      return result([text(head), json(schema)]);
    },
  );

  addTool(
    server,
    'rev2d_docs',
    {
      title: 'Rev2D documentation',
      description:
        'Full documentation by topic: spec = model format and evaluation semantics (coordinates, objects, addresses, bindings, animations, IK, physics, pipeline); ' +
        'ops = every edit op of rev2d_apply_ops with fields and examples; cli = the rev2d command line; mcp = this server (setup, tools, editor bridge); ' +
        `${recipesTopicText()}; ` +
        'interop = Spine / Live2D import and export (support matrix, parameter map, limitations, workflows); ' +
        'avatar = an animated avatar from ONE illustration (the rev2d avatar CLI workflow: landmarks, build, review, drawn variants, lip sync, the editor\'s Avatar mode); ' +
        'library = reusable asset catalogue, keying, generation requests and avatar rig review; ' +
        'architecture = pipeline and module map (for changing Rev2D itself); ' +
        'examples = the templates/example models with their parameters and animations; agents = the working guide for AI agents (AGENTS.md, else the rev2d_guide quickstart).',
      input: z.strictObject({ topic: z.enum(DOC_TOPICS).describe('Documentation topic.') }),
      effect: 'read-only',
    },
    async (a) => result([text(await readDoc(a.topic))]),
  );
}

export function registerDocResources(server: McpServer): void {
  const markdown = (name: string, uri: string, title: string, description: string, read: () => Promise<string>) =>
    server.registerResource(name, uri, { title, description, mimeType: 'text/markdown' }, async (u) => ({
      contents: [{ uri: u.href, mimeType: 'text/markdown', text: await read() }],
    }));
  markdown('guide', 'rev2d://guide', 'Rev2D quickstart', 'Quickstart for AI authors (same as the rev2d_guide tool).', async () => GUIDE);
  markdown('spec', 'rev2d://docs/spec', 'Rev2D format spec', 'Model format and evaluation semantics (docs/SPEC.md).', () => readDoc('spec'));
  markdown('ops', 'rev2d://docs/ops', 'Rev2D edit ops', 'Op catalogue for rev2d_apply_ops (docs/OPS.md).', () => readDoc('ops'));
  markdown('recipes', 'rev2d://docs/recipes', 'Rev2D rig recipes', 'Copy-paste rig recipes with their verification (docs/RECIPES.md).', () => readDoc('recipes'));
  markdown('interop', 'rev2d://docs/interop', 'Rev2D interop', 'Spine and Live2D import / export (docs/INTEROP.md).', () => readDoc('interop'));
  markdown('avatar', 'rev2d://docs/avatar', 'Rev2D avatars', 'An animated avatar from one illustration: the working guide (docs/AVATAR.md).', () => readDoc('avatar'));
  server.registerResource(
    'schema',
    'rev2d://schema',
    { title: 'Rev2D JSON Schema', description: 'JSON Schema of a model file.', mimeType: 'application/json' },
    async (u) => ({ contents: [{ uri: u.href, mimeType: 'application/json', text: JSON.stringify(schemas.modelJsonSchema(), null, 2) }] }),
  );
}
