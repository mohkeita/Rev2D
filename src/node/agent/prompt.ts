/**
 * The text an agent receives: a preamble (where it is, how to call Rev2D, the rules) followed by the
 * task. Tasks come from a small registry of templates, kind -> function building the task text from a
 * context object: "freeform" (the person's own words) is built in; the editor server registers the
 * avatar templates ("avatar-create", "avatar-variants" in src/server/avatar-agent-tasks.ts).
 */
import path from 'node:path';
import { AgentError, type AgentProviderId, type AgentSandbox } from './types.js';

/** Where a job runs and what it may do: everything the preamble states. */
export interface PromptEnv {
  provider: AgentProviderId;
  /** Absolute workspace root. */
  root: string;
  /** Absolute working directory (the root or a project folder inside it). */
  cwd: string;
  /** Absolute path of bin/rev2d.js. */
  rev2dBin: string;
  sandbox: AgentSandbox;
  allowImageGeneration: boolean;
  /** Absolute paths of the attached images. */
  images: string[];
  /** Model file the request is about (absolute), when there is one. */
  file?: string | null;
}

export interface TaskInput {
  /** The request in the person's words ('' when none was given). */
  prompt: string;
  /** Template-specific input (JSON values). */
  context: Record<string, unknown>;
  env: PromptEnv;
}

export interface TaskTemplate {
  kind: string;
  /** Short name for menus. */
  title: string;
  description: string;
  /** Whether the template needs the person's own text. */
  needsPrompt: boolean;
  /**
   * The task text (it follows the preamble). Throw AgentError("invalid", message, hint) when the
   * context lacks something the template needs.
   */
  build(input: TaskInput): string;
}

const TEMPLATES = new Map<string, TaskTemplate>();

/** Add (or replace) a task template. */
export function registerTaskTemplate(template: TaskTemplate): void {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(template.kind)) throw new Error(`task kind "${template.kind}" must be lower-case letters, digits and dashes`);
  TEMPLATES.set(template.kind, template);
}

export function taskTemplate(kind: string): TaskTemplate | undefined {
  return TEMPLATES.get(kind);
}

/** Every registered template, in registration order. */
export function taskTemplates(): TaskTemplate[] {
  return [...TEMPLATES.values()];
}

registerTaskTemplate({
  kind: 'freeform',
  title: 'Free-form request',
  description: "The person's own request, sent as it is after the Rev2D preamble.",
  needsPrompt: true,
  build: ({ prompt }) => prompt,
});

/** A path as agents should type it: forward slashes work in every shell. */
const slashed = (p: string) => p.split(path.sep).join('/');
/** Quoted when it contains a space, so the line can be copied into a shell. */
const quoted = (p: string) => (/\s/.test(p) ? `"${p}"` : p);

/** `p` relative to the working directory when it lies inside it, else absolute; forward slashes. */
function shown(env: PromptEnv, p: string): string {
  const rel = path.relative(env.cwd, p);
  return slashed(rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p);
}

/** The command line that runs the Rev2D CLI ("node <bin/rev2d.js>"). */
export function rev2dCommand(rev2dBin: string): string {
  return `node ${quoted(slashed(rev2dBin))}`;
}

function imageRule(env: PromptEnv): string {
  if (!env.allowImageGeneration) {
    return 'Image generation is NOT allowed in this job: do not create or edit pictures with an image generator, neither a built-in one nor an external service or API. Work with the images that exist; if the task cannot be done without generating one, say so in your report.';
  }
  if (env.sandbox === 'read-only') {
    return 'Image generation is allowed in this job, but the job is read-only: you cannot save a generated image, so only describe what you would generate.';
  }
  return 'Image generation is allowed in this job, but ONLY with your own built-in image generation tool: never call an external image service, API or website. Save every generated image inside the working directory and look at it before you use it.';
}

/**
 * The preamble: where the agent is, how to call Rev2D and the rules. `followUp` gives the short form
 * for a later message of the same session (the agent already read the long one).
 */
export function buildPreamble(env: PromptEnv, opts: { followUp?: boolean } = {}): string {
  const rev2d = rev2dCommand(env.rev2dBin);
  const root = slashed(env.root);
  const cwd = slashed(env.cwd);
  const inProject = path.relative(env.root, env.cwd) !== '';
  const readOnly = env.sandbox === 'read-only';
  if (opts.followUp) {
    return [
      'Follow-up message in the same Rev2D editor session. The rules of the first message still apply:',
      `- Stay inside the workspace root ${root} (working directory: ${cwd}); call Rev2D as: ${rev2d} <command>`,
      "- Never upload the person's images or copy them outside the workspace.",
      `- ${imageRule(env)}`,
      readOnly ? '- This message is read-only: do not create or change files; answer in text.' : '- Validate and look at what you change; report what is uncertain.',
    ].join('\n');
  }
  const where = [
    `- Workspace root: ${root}`,
    inProject ? `- Project folder (your working directory): ${cwd}` : `- Working directory: ${cwd} (the workspace root)`,
    ...(env.file ? [`- Model open in the editor: ${shown(env, env.file)}`] : []),
    ...(env.images.length ? [`- Attached image${env.images.length === 1 ? '' : 's'}: ${env.images.map((i) => shown(env, i)).join(', ')}`] : []),
  ];
  const rules = [
    `Stay inside the workspace root. Do not read, create, change, move or delete anything outside ${root}${inProject ? `, and keep your changes inside the project folder unless the request says otherwise` : ''}.`,
    "The person's images are private. Never upload them or send them to a web service, and never copy them outside the workspace.",
    imageRule(env),
    'Look at the images you produce: render to PNG files under out/ in the working directory and open them before you rely on them. Numbers ("inspect", "analyze") and "validate" come before pictures where they answer the question.',
    readOnly
      ? 'This job is read-only: do not create or change files. Answer in text.'
      : 'The editor reloads a model file the moment it changes on disk, and the person may be editing it too: make small, valid edits (prefer "ops" over rewriting a file), run "validate" after each one, and do not delete files you did not create.',
    'Do not start servers or watchers ("edit", "watch", "mcp"): the editor is already running. Do not install packages, and do not commit or push with git.',
    'Finish with a short report for the person: what you did (files), how you checked it, and what is uncertain or still wrong. Say so plainly when something did not work.',
  ];
  return [
    'You were started from inside the Rev2D editor by the person using it. Rev2D is a 2D rigging and animation toolkit: a model is one JSON file (*.r2d.json) that Rev2D validates, renders and animates headlessly.',
    '',
    'Where you are',
    ...where,
    '',
    'How to call Rev2D',
    `- ${rev2d} <command> ...   (the "rev2d" command of the guides; "help" lists the commands)`,
    `- ${rev2d} docs agents   prints the working guide for AI agents; read it before you edit a model. Other topics: spec, ops, cli, recipes, examples, avatar ("docs" alone lists them).`,
    '',
    'Rules',
    ...rules.map((r, i) => `${i + 1}. ${r}`),
  ].join('\n');
}

export interface BuiltPrompt {
  /** The whole text sent to the agent. */
  text: string;
  /** The task part alone (what the template built). */
  task: string;
  /** First line of the request, at most 80 characters. */
  title: string;
}

function titleOf(text: string, fallback: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? fallback;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Preamble + task for a job. Throws AgentError "invalid" for an unknown kind, a missing prompt or a
 * context the template rejects.
 */
export function buildAgentPrompt(input: { kind?: string; prompt?: string; context?: Record<string, unknown>; env: PromptEnv; followUp?: boolean }): BuiltPrompt {
  const kind = input.kind ?? 'freeform';
  const template = TEMPLATES.get(kind);
  if (!template) throw new AgentError('invalid', `unknown task kind "${kind}"`, `kinds: ${[...TEMPLATES.keys()].join(', ')}`);
  const prompt = (input.prompt ?? '').trim();
  if (template.needsPrompt && !prompt) throw new AgentError('invalid', `a "${kind}" job needs a prompt`, 'send the request text as "prompt"');
  const task = template.build({ prompt, context: input.context ?? {}, env: input.env }).trim();
  if (!task) throw new AgentError('invalid', `the "${kind}" template built an empty task`, 'send the request text as "prompt"');
  const text = `${buildPreamble(input.env, { followUp: input.followUp })}\n\n${input.followUp ? 'Message' : 'Request'}\n${task}\n`;
  return { text, task, title: titleOf(prompt || task, template.title) };
}
