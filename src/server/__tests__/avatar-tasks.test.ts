/**
 * The agent task templates of avatar mode (src/server/avatar-agent-tasks.ts): the prompt text they
 * build, what they refuse, and the in-app flow end to end with the fake Codex CLI of
 * test/fixtures/fake-agents (POST /api/avatar/new, then POST /api/agent/jobs with what it returned).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT } from '../../api/templates.js';
import { formatModelJson } from '../../core/format.js';
import { createImage, encodePNG } from '../../render/index.js';
import { draftAvatarSpec } from '../../avatar/index.js';
import { VARIANT_IDS } from '../../avatar/types.js';
import { AgentError, buildAgentPrompt, rev2dCommand, taskTemplate, taskTemplates, type PromptEnv } from '../../node/agent/index.js';
import type { AgentJobDetail, AgentJobInfo, AgentTaskInfo, AvatarNewResult, SessionInfo } from '../../node/editor-registry.js';
import { AVATAR_TASKS, RECOMMENDED_VARIANTS, avatarCreateTask, avatarVariantsTask } from '../avatar-agent-tasks.js';
import { startEditorServer } from '../index.js';
import { removeDir } from './helpers.js';

const temps: string[] = [];
afterAll(() => temps.forEach(removeDir));

function tempDir(prefix = 'rev2d-avatar-tasks-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A workspace with an avatar project "art/hero" (a draft avatar.json; `built` adds textures/layers.json). */
function workspace(built = false): { root: string; project: string } {
  const root = tempDir();
  const project = path.join(root, 'art', 'hero');
  mkdirSync(path.join(project, 'textures'), { recursive: true });
  writeFileSync(path.join(project, 'avatar.json'), formatModelJson(draftAvatarSpec('hero', 64, 80)));
  writeFileSync(path.join(project, 'source.png'), encodePNG(createImage(64, 80, '#c08080')));
  if (built) writeFileSync(path.join(project, 'textures', 'layers.json'), '{"version": 1, "inputsHash": "0", "image": {"width": 64, "height": 80}, "layers": [], "variants": []}\n');
  return { root, project };
}

const BIN = path.join(PACKAGE_ROOT, 'bin', 'rev2d.js');
const RUN = rev2dCommand(BIN);

function env(project: string, root: string, over: Partial<PromptEnv> = {}): PromptEnv {
  return { provider: 'codex', root, cwd: project, rev2dBin: BIN, sandbox: 'workspace-write', allowImageGeneration: false, images: [path.join(project, 'source.png')], file: null, ...over };
}

/** The AgentError a template throws, or a failure when it builds. */
function refusal(fn: () => unknown): AgentError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AgentError);
    return e as AgentError;
  }
  throw new Error('expected the template to refuse');
}

describe('registration', () => {
  it('registers both templates once the module is loaded (the editor server loads it)', () => {
    expect(AVATAR_TASKS.map((t) => t.kind)).toEqual(['avatar-create', 'avatar-variants']);
    for (const t of AVATAR_TASKS) {
      expect(taskTemplate(t.kind)).toBe(t);
      expect(t.needsPrompt).toBe(false);
      expect(t.title.length).toBeLessThanOrEqual(60);
      expect(t.description).toContain('"project"');
    }
    expect(taskTemplates().map((t) => t.kind)).toEqual(expect.arrayContaining(['freeform', 'avatar-create', 'avatar-variants']));
    expect(RECOMMENDED_VARIANTS.every((v) => (VARIANT_IDS as readonly string[]).includes(v))).toBe(true);
  });
});

describe('avatar-create', () => {
  it('asks for the whole workflow inside the project folder, in order, with the exact commands', () => {
    const { root, project } = workspace();
    const built = buildAgentPrompt({ kind: 'avatar-create', context: { project: 'art/hero' }, env: env(project, root) });
    // The preamble of every job comes first: where the agent is, the privacy and image rules.
    expect(built.text.startsWith('You were started from inside the Rev2D editor')).toBe(true);
    expect(built.text).toContain(`- Project folder (your working directory): ${project.split(path.sep).join('/')}`);
    expect(built.text).toContain('Image generation is NOT allowed in this job');
    expect(built.title).toBe('Create an animated avatar from the illustration in this project folder.');
    const task = built.task;
    expect(task).toContain(`Run "${RUN} docs avatar" and follow it`);
    // Until that guide exists, the CLI's own help and the schema stand in for it.
    for (const fallback of [`"${RUN} avatar --help"`, `"${RUN} help avatar <command>"`, `"${RUN} avatar schema"`]) expect(task).toContain(fallback);
    const steps = [
      `${RUN} avatar vision-check make work/vision`,
      `${RUN} avatar vision-check score work/vision work/vision/answer.json`,
      `${RUN} avatar grid . -o work/grid.png`,
      '--region x0,y0,x1,y1',
      `${RUN} avatar validate .`,
      `${RUN} avatar overlay . -o work/overlay.png`,
      `${RUN} avatar overlay . --part eyes.imageLeft --zoom -o work/eye-left.png`,
      `${RUN} avatar build .`,
      `${RUN} avatar poses .`,
      'repeat steps 4 to 7',
    ];
    let at = -1;
    for (const step of steps) {
      const next = task.indexOf(step, at + 1);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    // Vision check first, and what to do when it fails.
    expect(task.indexOf('vision-check')).toBeLessThan(task.indexOf('avatar grid'));
    expect(task).toContain('If you cannot pass it, stop and say so in your report');
    // The rules of the task, and the hand-over note.
    expect(task).toContain('Write avatar.json and your scratch files in work/, nothing else.');
    expect(task).toContain('"post" list');
    expect(task).toContain('Do not generate, redraw or retouch pictures in this task.');
    expect(task).toContain('"imageLeft" and "imageRight" are sides of the IMAGE');
    expect(task).toMatch(/Hand-over note\nFinish with a short note for the person: .* the parts you are LEAST sure about, the most doubtful first\./);
    expect(task.endsWith('so the person knows which handles to check first in the editor.')).toBe(true);
  });

  it("adds the person's own words at the end, and refuses a folder that is not an avatar project", () => {
    const { root, project } = workspace();
    const built = buildAgentPrompt({ kind: 'avatar-create', prompt: 'Her left braid should sway a lot.', context: { project: 'art/hero' }, env: env(project, root) });
    expect(built.task.endsWith('\n\nFrom the person\nHer left braid should sway a lot.')).toBe(true);
    expect(built.title).toBe('Her left braid should sway a lot.');

    const err = refusal(() => buildAgentPrompt({ kind: 'avatar-create', env: env(root, root) }));
    expect(err.code).toBe('invalid');
    expect(err.message).toBe(`the "avatar-create" task needs an avatar project: ${root} has no avatar.json`);
    expect(err.hint).toContain('POST /api/avatar/new');
  });
});

describe('avatar-variants', () => {
  const allowed = (project: string, root: string, over: Partial<PromptEnv> = {}) => env(project, root, { allowImageGeneration: true, ...over });

  it('asks to request, draw with the built-in generator only, import and review', () => {
    const { root, project } = workspace(true);
    const built = buildAgentPrompt({ kind: 'avatar-variants', context: { project: 'art/hero', variants: ['mouth_a', 'eyes_closed', 'mouth_a'] }, env: allowed(project, root) });
    expect(built.text).toContain('Image generation is allowed in this job, but ONLY with your own built-in image generation tool');
    const task = built.task;
    // Each requested id once, in the order of the tool.
    expect(task).toContain('Variants to draw: eyes_closed, mouth_a');
    const steps = [
      `${RUN} avatar variants request . eyes_closed mouth_a`,
      `"${RUN} help avatar variants"`,
      'variant-requests/<id>.mask.png',
      'variant-requests/<id>.prompt.txt',
      'variant-requests/README.md',
      'with your built-in image generation tool',
      'Save it as variants/<id>.png',
      `${RUN} avatar variants import .`,
      `${RUN} avatar build .`,
      `${RUN} avatar poses .`,
      'review/eyes.png, review/mouth.png and review/poses.png',
    ];
    let at = -1;
    for (const step of steps) {
      const next = task.indexOf(step, at + 1);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    expect(task).toContain('TRANSPARENT pixels may change, OPAQUE pixels must stay identical');
    expect(task).toContain('exactly the size of source.png');
    expect(task).toContain('Never send the illustration to an external image service, API or website.');
    expect(task).toContain('Draw only the variants listed above.');

    // Without a list the request command picks the recommended ones.
    const auto = buildAgentPrompt({ kind: 'avatar-variants', context: { project: 'art/hero' }, env: allowed(project, root) }).task;
    expect(auto).toContain(`${RUN} avatar variants request ." (`);
    expect(auto).toContain(`Variants to draw: the recommended ones (the request command picks them when you name none; usually ${RECOMMENDED_VARIANTS.join(' and ')})`);
  });

  it('refuses a job that may not generate images, a provider without a generator, read-only, an unbuilt avatar, unknown ids', () => {
    const { root, project } = workspace(true);
    const build = (e: PromptEnv, context: Record<string, unknown> = { project: 'art/hero' }) => () => buildAgentPrompt({ kind: 'avatar-variants', context, env: e });

    const forbidden = refusal(build(env(project, root)));
    expect([forbidden.code, forbidden.message]).toEqual(['invalid', 'the "avatar-variants" task draws pictures: it needs image generation to be allowed for the job']);
    expect(forbidden.hint).toContain('"allowImageGeneration": true');
    const claude = refusal(build(allowed(project, root, { provider: 'claude' })));
    expect(claude.message).toBe('Claude Code has no built-in image generator, so it cannot draw variants');
    expect(claude.hint).toContain('"codex"');
    expect(refusal(build(allowed(project, root, { sandbox: 'read-only' }))).hint).toContain('"workspace-write"');
    const unbuilt = workspace(false);
    expect(refusal(build(allowed(unbuilt.project, unbuilt.root))).message).toMatch(/is not built yet/);
    expect(refusal(build(allowed(root, root))).message).toContain('needs an avatar project');
    const unknown = refusal(build(allowed(project, root), { project: 'art/hero', variants: ['eyes_closed', 'mouth_x', 'wink'] }));
    expect(unknown.message).toBe('unknown variants "mouth_x", "wink" in "context.variants"');
    expect(unknown.hint).toContain(VARIANT_IDS.join(', '));
    expect(refusal(build(allowed(project, root), { variants: 'eyes_closed' })).message).toBe('"context.variants" must be a list of variant ids');
    expect(refusal(build(allowed(project, root), { variants: [1] })).message).toBe('"context.variants" must be a list of variant ids');
  });
});

// ----------------------------------------------------------------------------- in the editor server

describe('the in-app flow', () => {
  const FAKES = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'fake-agents');
  const commands = { codex: [process.execPath, path.join(FAKES, 'fake-codex.mjs')], claude: [process.execPath, path.join(FAKES, 'fake-claude.mjs')] };

  it('one picture -> a project -> an avatar-create job in that folder with the picture attached', async () => {
    const root = tempDir();
    const server = await startEditorServer({ root, port: 0, devVite: false, register: false, staticDir: path.join(root, '.no-ui'), log: () => undefined, agent: { commands, logDir: tempDir('rev2d-agent-logs-'), maxStartsPerMinute: 1000 } });
    try {
      const session = (await (await fetch(`${server.url}/api/session`)).json()) as SessionInfo;
      const headers = { 'Content-Type': 'application/json', 'X-Rev2D-Token': session.token! };
      const tasks = (await (await fetch(`${server.url}/api/agent/tasks`, { headers })).json()) as AgentTaskInfo[];
      expect(tasks.filter((t) => t.kind.startsWith('avatar-'))).toEqual(AVATAR_TASKS.map(({ kind, title, description, needsPrompt }) => ({ kind, title, description, needsPrompt })));

      const picture = Buffer.from(encodePNG(createImage(40, 50, '#d0a0a0'))).toString('base64');
      const res = await fetch(`${server.url}/api/avatar/new`, { method: 'POST', headers, body: JSON.stringify({ name: 'mia', image: { name: 'mia.png', base64: picture } }) });
      expect(res.status).toBe(200);
      const created = (await res.json()) as AvatarNewResult;

      // Exactly what the answer carries, passed on as it is.
      const start = await fetch(`${server.url}/api/agent/jobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider: 'codex', kind: 'avatar-create', context: { project: created.projectPath }, images: [created.image.path], prompt: 'Short hair, no accessories. [[fake:echo]]' }),
      });
      const started = (await start.json()) as { job: AgentJobInfo };
      expect(start.status, JSON.stringify(started)).toBe(202);
      expect(started.job).toMatchObject({ kind: 'avatar-create', cwd: created.project, images: [path.join(created.project, 'source.png')], allowImageGeneration: false });
      let detail: AgentJobDetail;
      for (const deadline = Date.now() + 15000; ; ) {
        detail = (await (await fetch(`${server.url}/api/agent/jobs/${started.job.id}`, { headers })).json()) as AgentJobDetail;
        if (['done', 'failed', 'cancelled'].includes(detail.job.state)) break;
        if (Date.now() > deadline) throw new Error(`the job did not finish: ${JSON.stringify(detail.job)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(detail.job.state).toBe('done');
      expect(detail.prompt).toContain(`Run "${RUN} docs avatar"`);
      const echo = JSON.parse(detail.job.finalMessage!) as { argv: string[]; prompt: string; cwd: string };
      expect(realpathSync.native(echo.cwd).toLowerCase()).toBe(realpathSync.native(created.project).toLowerCase());
      expect(echo.argv).toContain('-i');
      expect(echo.prompt).toContain('Create an animated avatar from the illustration in this project folder.');
      expect(echo.prompt).toContain('From the person\nShort hair, no accessories.');

      // Drawing variants needs a built avatar and permission to generate images: refused before anything starts.
      const refused = await fetch(`${server.url}/api/agent/jobs`, { method: 'POST', headers, body: JSON.stringify({ provider: 'codex', kind: 'avatar-variants', context: { project: created.projectPath } }) });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: 'invalid', error: expect.stringContaining('needs image generation to be allowed'), hint: expect.stringContaining('"allowImageGeneration": true') });
      const unbuilt = await fetch(`${server.url}/api/agent/jobs`, { method: 'POST', headers, body: JSON.stringify({ provider: 'codex', kind: 'avatar-variants', context: { project: created.projectPath }, allowImageGeneration: true }) });
      expect(unbuilt.status).toBe(400);
      expect(((await unbuilt.json()) as { error: string }).error).toMatch(/is not built yet/);
    } finally {
      await server.close();
    }
  }, 30000);
});
