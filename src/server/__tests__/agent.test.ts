/**
 * The agent bridge endpoints over real HTTP (port 0): the session token, the Host / Origin guards,
 * the loopback rule, jobs with live SSE progress, follow-ups, cancel, limits, and that an agent's edit
 * of the open model and an editor save do not overwrite each other.
 * The CLIs are the fake agents of test/fixtures/fake-agents; no real provider is ever started.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT } from '../../api/templates.js';
import { processAlive, rev2dCommand } from '../../node/agent/index.js';
import type { AgentEvent, AgentJobDetail, AgentJobEventPayload, AgentJobInfo, AgentJobList, SessionInfo } from '../../node/editor-registry.js';
import { isLoopbackHost, type AgentBridgeOptions } from '../agent-routes.js';
import { startEditorServer, type EditorServer } from '../index.js';
import { openEvents, rawRequest, startFixture, texturePng, type Fixture, type SseEvent } from './helpers.js';

const FAKES = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'fake-agents');
const COMMANDS = {
  codex: [process.execPath, path.join(FAKES, 'fake-codex.mjs')],
  claude: [process.execPath, path.join(FAKES, 'fake-claude.mjs')],
};

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
/** Bridge settings for a test server: the fake CLIs, logs in a temp directory, no practical rate limit. */
const agentOptions = (over: Partial<AgentBridgeOptions> = {}): AgentBridgeOptions => ({ commands: COMMANDS, logDir: tempDir('rev2d-agent-logs-'), maxStartsPerMinute: 1000, ...over });

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface Client {
  token: string;
  get(p: string, headers?: Record<string, string>): Promise<Response>;
  post(p: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  /** Start a job and return it (202 expected). */
  start(body: Record<string, unknown>): Promise<AgentJobInfo>;
  /** Poll the job until it is done, failed or cancelled. */
  finished(id: string): Promise<AgentJobDetail>;
}

async function client(base: string): Promise<Client> {
  const session = (await (await fetch(`${base}/api/session`)).json()) as SessionInfo;
  const token = session.token ?? '';
  const c: Client = {
    token,
    get: (p, headers = {}) => fetch(base + p, { headers: { 'X-Rev2D-Token': token, ...headers } }),
    post: (p, body, headers = {}) =>
      fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rev2D-Token': token, ...headers }, body: JSON.stringify(body ?? {}) }),
    async start(body) {
      const res = await c.post('/api/agent/jobs', body);
      const json = (await res.json()) as { job: AgentJobInfo; error?: string };
      expect(res.status, JSON.stringify(json)).toBe(202);
      return json.job;
    },
    async finished(id) {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const detail = (await (await c.get(`/api/agent/jobs/${id}`)).json()) as AgentJobDetail;
        if (['done', 'failed', 'cancelled'].includes(detail.job.state)) return detail;
        if (Date.now() > deadline) throw new Error(`job ${id} did not finish: ${JSON.stringify(detail.job)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
  return c;
}

const agentJob = (id: string) => (e: SseEvent) => e.event === 'agent-job' && (e.data as AgentJobEventPayload).job.id === id;
const sameDir = (a: string, b: string) => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

async function until(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ----------------------------------------------------------------------------- guards

describe('agent bridge: who may use it', () => {
  let fx: Fixture;
  let api: Client;

  beforeAll(async () => {
    fx = await startFixture({ agent: agentOptions() });
    api = await client(fx.base);
  });

  afterAll(async () => {
    await fx.close();
  });

  it('GET /api/session hands the token to same-origin pages and non-browser clients only', async () => {
    const res = await fetch(`${fx.base}/api/session`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const session = (await res.json()) as SessionInfo;
    expect(session).toEqual({ token: api.token, agent: { enabled: true } });
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fx.server.agent).toEqual({ enabled: true });

    const ask = (headers: Record<string, string>) => rawRequest(fx.base, { path: '/api/session', headers });
    // The editor's own page (also through the Vite dev server on another port) and a typed URL.
    expect((await ask({ 'Sec-Fetch-Site': 'same-origin', Origin: fx.base })).status).toBe(200);
    expect((await ask({ 'Sec-Fetch-Site': 'same-origin', Origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await ask({ 'Sec-Fetch-Site': 'none' })).status).toBe(200);
    // A foreign page, a page on another localhost port, a rebinding host.
    for (const headers of [
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site', Origin: 'http://localhost:3000' },
      { Origin: 'https://evil.example' },
      { Origin: 'null' },
    ] as Array<Record<string, string>>) {
      const denied = await ask(headers);
      expect(denied.status, JSON.stringify(headers)).toBe(403);
      expect(denied.body.toString()).not.toContain(api.token);
    }
    const rebinding = await rawRequest(fx.base, { path: '/api/session', headers: { Host: 'evil.example' } });
    expect(rebinding.status).toBe(403);
    expect(rebinding.body.toString()).not.toContain(api.token);
  });

  it('gives every server its own token', async () => {
    const other = await startFixture({ agent: agentOptions() });
    try {
      const token = ((await (await fetch(`${other.base}/api/session`)).json()) as SessionInfo).token!;
      expect(token).not.toBe(api.token);
      // A token of another server is as good as none.
      expect((await fetch(`${fx.base}/api/agent/jobs`, { headers: { 'X-Rev2D-Token': token } })).status).toBe(401);
    } finally {
      await other.close();
    }
  });

  it('every agent endpoint needs the token', async () => {
    const endpoints: Array<[string, string]> = [
      ['GET', '/api/agent/providers'],
      ['GET', '/api/agent/tasks'],
      ['GET', '/api/agent/jobs'],
      ['POST', '/api/agent/jobs'],
      ['GET', '/api/agent/jobs/abc'],
      ['POST', '/api/agent/jobs/abc/cancel'],
      ['POST', '/api/agent/jobs/abc/message'],
      ['GET', '/api/agent/settings'],
      ['PUT', '/api/agent/settings'],
      ['GET', '/api/agent/nope'],
    ];
    for (const [method, p] of endpoints) {
      const body = method === 'POST' ? JSON.stringify({ provider: 'codex', prompt: 'hi' }) : undefined;
      const none = await fetch(fx.base + p, { method, body, headers: { 'Content-Type': 'application/json' } });
      expect(none.status, `${method} ${p}`).toBe(401);
      expect(await none.json()).toMatchObject({ error: 'the agent endpoints need the session token (X-Rev2D-Token header)', code: 'token-required' });
      for (const wrong of ['nope', `${api.token}x`, api.token.slice(1), '']) {
        const res = await fetch(fx.base + p, { method, body, headers: { 'Content-Type': 'application/json', 'X-Rev2D-Token': wrong } });
        expect(res.status, `${method} ${p} with ${JSON.stringify(wrong)}`).toBe(401);
      }
    }
    // Nothing was started by any of them.
    expect(((await (await api.get('/api/agent/jobs')).json()) as AgentJobList).jobs).toEqual([]);
    // The token in a query string or a cookie does not count.
    expect((await fetch(`${fx.base}/api/agent/jobs?token=${api.token}`, { headers: { Cookie: `token=${api.token}` } })).status).toBe(401);
  });

  it('rejects a foreign origin and a foreign Host even with the right token', async () => {
    const body = JSON.stringify({ provider: 'codex', prompt: 'hi' });
    const post = (headers: Record<string, string>) => rawRequest(fx.base, { method: 'POST', path: '/api/agent/jobs', headers: { 'Content-Type': 'application/json', 'X-Rev2D-Token': api.token, ...headers }, body });
    for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site', Origin: 'http://localhost:3000' }, { Host: 'evil.example' }] as Array<Record<string, string>>) {
      const res = await post(headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    // The preflight a browser sends before a cross-origin request with the token header fails too.
    const preflight = await rawRequest(fx.base, {
      method: 'OPTIONS',
      path: '/api/agent/jobs',
      headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-rev2d-token' },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-headers']).toBeUndefined();
    const reads = await rawRequest(fx.base, { path: '/api/agent/jobs', headers: { 'X-Rev2D-Token': api.token, Host: 'evil.example' } });
    expect(reads.status).toBe(403);
    expect(((await (await api.get('/api/agent/jobs')).json()) as AgentJobList).jobs).toEqual([]);
  });

  it('knows which bind addresses are loopback', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '127.255.255.254', 'localhost', 'LOCALHOST', '::1', '[::1]']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['0.0.0.0', '::', '', '192.168.1.5', '10.0.0.1', 'my-pc.local', '128.0.0.1', '127.0.0.1.evil.example', 'fe80::1', 'not a host']) expect(isLoopbackHost(host), host).toBe(false);
  });

  it('a non-loopback bind disables the agent endpoints unless allowAgent is set', async () => {
    const base = { file: fx.file, port: 0, devVite: false, register: false, staticDir: path.join(fx.dir, 'no-ui'), log: () => undefined };
    let open: EditorServer;
    try {
      open = await startEditorServer({ ...base, host: '0.0.0.0', agent: agentOptions() });
    } catch (e) {
      // Sandboxes without a non-loopback interface cannot run this test.
      console.warn(`skipped: cannot bind 0.0.0.0 (${(e as Error).message})`);
      return;
    }
    try {
      expect(open.agent.enabled).toBe(false);
      expect(open.agent.reason).toMatch(/bound to 0\.0\.0\.0, not a loopback address/);
      const session = (await (await fetch(`${open.url}/api/session`)).json()) as SessionInfo;
      expect(session).toEqual({ token: null, agent: { enabled: false, reason: open.agent.reason } });
      for (const [method, p] of [
        ['GET', '/api/agent/providers'],
        ['GET', '/api/agent/jobs'],
        ['POST', '/api/agent/jobs'],
        ['POST', '/api/agent/jobs/abc/cancel'],
      ]) {
        const res = await fetch(open.url + p, { method, headers: { 'Content-Type': 'application/json', 'X-Rev2D-Token': api.token }, body: method === 'POST' ? JSON.stringify({ provider: 'codex', prompt: 'hi' }) : undefined });
        expect(res.status, `${method} ${p}`).toBe(404);
        const body = (await res.json()) as { error: string; hint: string; code: string };
        expect(body.code).toBe('agent-disabled');
        expect(body.error).toMatch(/^the agent endpoints are disabled: the editor is bound to 0\.0\.0\.0/);
        expect(body.hint).toContain('--allow-agent');
      }
      // The rest of the API is unaffected.
      expect((await fetch(`${open.url}/api/workspace`)).status).toBe(200);
    } finally {
      await open.close();
    }

    const allowed = await startEditorServer({ ...base, host: '0.0.0.0', allowAgent: true, agent: agentOptions() });
    try {
      expect(allowed.agent).toEqual({ enabled: true });
      const c = await client(allowed.url);
      expect(c.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await c.get('/api/agent/jobs')).status).toBe(200);
      expect((await fetch(`${allowed.url}/api/agent/jobs`)).status).toBe(401);
    } finally {
      await allowed.close();
    }

    // localhost is portable; extra 127/8 addresses need aliases on macOS. The predicate test above
    // covers those addresses without requiring the operating system to assign them to an interface.
    const loop = await startEditorServer({ ...base, host: 'localhost', agent: agentOptions() });
    try {
      expect(loop.agent).toEqual({ enabled: true });
    } finally {
      await loop.close();
    }
  });
});

// ----------------------------------------------------------------------------- jobs

describe('agent bridge: jobs', () => {
  let fx: Fixture;
  let api: Client;

  beforeAll(async () => {
    fx = await startFixture({ agent: agentOptions() });
    api = await client(fx.base);
  });

  afterAll(async () => {
    await fx.close();
  });

  afterEach(async () => {
    // No test may leave a job running for the next one.
    const { active } = (await (await api.get('/api/agent/jobs')).json()) as AgentJobList;
    if (active) await api.post(`/api/agent/jobs/${active}/cancel`);
  });

  it('lists the providers and the task templates', async () => {
    const providers = await (await api.get('/api/agent/providers')).json();
    expect(providers).toEqual([
      // On Windows the Codex entry also names the sandbox implementation the bridge asks for.
      {
        id: 'codex',
        name: 'Codex CLI',
        available: true,
        version: '0.0.0-fake',
        features: { imageGeneration: true },
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        ...(process.platform === 'win32' ? { windowsSandbox: 'config' } : {}),
      },
      { id: 'claude', name: 'Claude Code', available: true, version: '0.0.0-fake', features: { imageGeneration: false }, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ]);
    const tasks = (await (await api.get('/api/agent/tasks')).json()) as Array<{ kind: string }>;
    expect(tasks.find((t) => t.kind === 'freeform')).toEqual({
      kind: 'freeform',
      title: 'Free-form request',
      description: "The person's own request, sent as it is after the Rev2D preamble.",
      needsPrompt: true,
    });
  });

  it('starts a job, streams its progress over SSE and serves its events', async () => {
    const tab = await openEvents(fx.base);
    try {
      const res = await api.post('/api/agent/jobs', { provider: 'codex', prompt: 'Widen the head warp. [[fake:full]]' });
      expect(res.status).toBe(202);
      const { job } = (await res.json()) as { job: AgentJobInfo };
      expect(job).toMatchObject({ provider: 'codex', kind: 'freeform', state: 'queued', title: 'Widen the head warp. [[fake:full]]', sandbox: 'workspace-write', allowImageGeneration: false, resumeOf: null });
      expect(sameDir(job.cwd, fx.dir)).toBe(true);

      // Live: every event arrives on the editor's event stream, in order, with the job state.
      const live: AgentJobEventPayload[] = [];
      for (;;) {
        const e = (await tab.next(agentJob(job.id))).data as AgentJobEventPayload;
        live.push(e);
        if (e.event!.type === 'done') break;
      }
      expect(live.map((e) => e.event!.seq)).toEqual(live.map((_, i) => i + 1));
      expect(live[0]).toMatchObject({ state: 'queued', event: { type: 'status', status: 'queued' } });
      expect(live[1]).toMatchObject({ state: 'running', event: { type: 'status', status: 'running' } });
      expect(live.at(-1)).toMatchObject({ state: 'done', job: { state: 'done', exitCode: 0 }, event: { type: 'done', state: 'done', reason: 'completed' } });
      expect(live.every((e) => e.state === e.job.state && !('prompt' in e.job))).toBe(true);
      expect(new Set(live.map((e) => e.event!.type))).toEqual(new Set(['status', 'reasoning', 'todo', 'command', 'tool', 'file', 'error', 'message', 'usage', 'done']));

      const detail = (await (await api.get(`/api/agent/jobs/${job.id}`)).json()) as AgentJobDetail;
      expect(detail.prompt).toBe('Widen the head warp. [[fake:full]]');
      expect(detail.events).toEqual(live.map((e) => e.event));
      expect([detail.firstSeq, detail.lastSeq]).toEqual([1, 23]);
      expect(detail.job).toMatchObject({
        state: 'done',
        sessionId: '0199f3a1-7c2e-7d43-9b1a-2f6c5d4e3b2a',
        finalMessage: 'Widened the head warp; `validate` shows 0 errors.\nUncertain: the hair strand roots (머리카락).',
        usage: { inputTokens: 48213, cachedInputTokens: 31744, outputTokens: 1582, reasoningTokens: 640 },
        lastSeq: 23,
      });
      expect(detail.job.logFile).toMatch(/-codex-[0-9a-f]{12}\.jsonl$/);
      const since = (await (await api.get(`/api/agent/jobs/${job.id}?since=21`)).json()) as AgentJobDetail;
      expect(since.events.map((e: AgentEvent) => e.seq)).toEqual([22, 23]);
      const list = (await (await api.get('/api/agent/jobs')).json()) as AgentJobList;
      expect(list.active).toBeNull();
      expect(list.jobs[0]).toEqual(detail.job);
    } finally {
      tab.close();
    }
  });

  it('sends the prompt with the Rev2D preamble; the working directory is the workspace root, or a project folder inside it', async () => {
    const prompt = 'Say "hi" & run `calc.exe` | echo %PATH%\n한국어 🎨 line two';
    const atRoot = await api.finished((await api.start({ provider: 'codex', prompt })).id);
    const echo = JSON.parse(atRoot.job.finalMessage!) as { argv: string[]; prompt: string; cwd: string };
    expect(sameDir(echo.cwd, fx.dir)).toBe(true);
    expect(echo.prompt).toContain(`\n\nRequest\n${prompt}\n`);
    expect(echo.prompt).toContain(`- Workspace root: ${fx.dir.split(path.sep).join('/')}`);
    // The open model is named without being asked for.
    expect(echo.prompt).toContain('- Model open in the editor: model.r2d.json');
    expect(echo.prompt).toContain(`- ${rev2dCommand(path.join(PACKAGE_ROOT, 'bin', 'rev2d.js'))} <command> ...`);
    expect(echo.argv).toEqual(expect.arrayContaining(['-s', 'workspace-write', '--disable', 'image_generation']));
    expect(echo.argv.join('\n')).not.toContain('calc.exe');

    const project = path.join(fx.dir, 'avatars', 'miko');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'bust ref.png'), texturePng());
    const inProject = await api.finished(
      (
        await api.start({
          provider: 'claude',
          prompt: 'look',
          context: { project: 'avatars/miko', file: 'avatars/miko/miko.r2d.json' },
          images: ['avatars/miko/bust ref.png'],
          sandbox: 'read-only',
          model: 'sonnet',
          effort: 'high',
          allowImageGeneration: true,
        })
      ).id,
    );
    expect(inProject.job).toMatchObject({ provider: 'claude', sandbox: 'read-only', model: 'sonnet', effort: 'high', allowImageGeneration: true, images: [path.join(project, 'bust ref.png')] });
    const second = JSON.parse(inProject.job.finalMessage!) as { argv: string[]; prompt: string; cwd: string };
    expect(sameDir(second.cwd, project)).toBe(true);
    expect(second.prompt).toContain(`- Project folder (your working directory): ${project.split(path.sep).join('/')}`);
    expect(second.prompt).toContain('- Model open in the editor: miko.r2d.json');
    expect(second.prompt).toContain('- Attached image: bust ref.png');
    expect(second.argv).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk', '--model', 'sonnet', '--effort', 'high']));
  });

  it('a follow-up continues the session of the finished job', async () => {
    const first = await api.finished((await api.start({ provider: 'codex', prompt: 'first', sandbox: 'read-only' })).id);
    const res = await api.post(`/api/agent/jobs/${first.job.id}/message`, { prompt: 'and again' });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: AgentJobInfo };
    expect(job).toMatchObject({ resumeOf: first.job.id, conversation: first.job.id, provider: 'codex', sandbox: 'read-only', sessionId: first.job.sessionId });
    const second = await api.finished(job.id);
    const echo = JSON.parse(second.job.finalMessage!) as { argv: string[]; prompt: string; resumed: boolean };
    expect(echo.resumed).toBe(true);
    expect(echo.argv.slice(-4)).toEqual(['resume', '--json', first.job.sessionId, '-']);
    expect(echo.argv).toEqual(expect.arrayContaining(['-s', 'read-only']));
    expect(echo.prompt.endsWith('\n\nMessage\nand again\n')).toBe(true);
    expect(second.prompt).toBe('and again');

    // What cannot be continued says why.
    const unknown = await api.post('/api/agent/jobs/000000000000/message', { prompt: 'x' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: 'unknown-job' });
    const crashed = await api.finished((await api.start({ provider: 'codex', prompt: '[[fake:crash]]' })).id);
    expect(crashed.job).toMatchObject({ state: 'failed', exitCode: 3, error: { message: 'thread main panicked: something broke' } });
    const dead = await api.post(`/api/agent/jobs/${crashed.job.id}/message`, { prompt: 'x' });
    expect(dead.status).toBe(409);
    expect(await dead.json()).toMatchObject({ code: 'not-resumable', hint: 'start a new job instead' });
    expect((await api.post(`/api/agent/jobs/${first.job.id}/message`, { prompt: '   ' })).status).toBe(400);
    expect((await api.post(`/api/agent/jobs/${first.job.id}/message`, { prompt: 'x', provider: 'claude' })).status).toBe(400);
  });

  it('runs one job at a time; cancel stops the job and its processes', async () => {
    const tab = await openEvents(fx.base);
    try {
      const job = await api.start({ provider: 'codex', prompt: 'work forever [[fake:hang]]' });
      const busy = await api.post('/api/agent/jobs', { provider: 'claude', prompt: 'me too' });
      expect(busy.status).toBe(409);
      expect(await busy.json()).toMatchObject({ code: 'busy', job: job.id, hint: expect.stringContaining('cancel') });
      const follow = await api.post(`/api/agent/jobs/${job.id}/message`, { prompt: 'faster' });
      expect(follow.status).toBe(409);
      expect(((await (await api.get('/api/agent/jobs')).json()) as AgentJobList).active).toBe(job.id);

      const said = (await tab.next((e) => agentJob(job.id)(e) && (e.data as AgentJobEventPayload).event!.type === 'message')).data as AgentJobEventPayload;
      const { pid, child } = JSON.parse((said.event as { text: string }).text) as { pid: number; child: number };
      expect(processAlive(pid) && processAlive(child)).toBe(true);

      const res = await api.post(`/api/agent/jobs/${job.id}/cancel`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { job: AgentJobInfo }).job).toMatchObject({ id: job.id, state: 'cancelled', error: { message: 'the job was cancelled' } });
      const done = (await tab.next((e) => agentJob(job.id)(e) && (e.data as AgentJobEventPayload).event!.type === 'done')).data as AgentJobEventPayload;
      expect(done).toMatchObject({ state: 'cancelled', event: { state: 'cancelled', reason: 'cancelled' } });
      await until(() => !processAlive(pid) && !processAlive(child), 'the agent processes to be gone');

      // Cancelling a finished job is harmless; the slot is free again.
      expect((await api.post(`/api/agent/jobs/${job.id}/cancel`)).status).toBe(200);
      expect((await api.post('/api/agent/jobs/000000000000/cancel')).status).toBe(404);
      const next = await api.finished((await api.start({ provider: 'claude', prompt: 'me too' })).id);
      expect(next.job.state).toBe('done');
    } finally {
      tab.close();
    }
  });

  it('reports a failed run with the hint to sign in', async () => {
    const failed = await api.finished((await api.start({ provider: 'codex', prompt: '[[fake:auth]]' })).id);
    expect(failed.job).toMatchObject({ state: 'failed', exitCode: 1, error: { message: 'ERROR: Not logged in. Run `codex login` to sign in.', hint: expect.stringContaining('codex login') } });
    expect(failed.events.at(-1)).toMatchObject({ type: 'done', state: 'failed', reason: 'failed', hint: expect.stringContaining('codex login') });
  });

  it('rejects malformed requests and paths outside the workspace', async () => {
    const outside = tempDir('rev2d-agent-outside-');
    writeFileSync(path.join(outside, 'secret.png'), texturePng());
    writeFileSync(path.join(fx.dir, 'notes.txt'), 'text');
    const cases: Array<[Record<string, unknown>, number, RegExp]> = [
      [{ prompt: 'x' }, 400, /invalid agent job request: provider/],
      [{ provider: 'gemini', prompt: 'x' }, 400, /provider/],
      [{ provider: 'codex', prompt: 'x', cwd: outside }, 400, /cwd/],
      [{ provider: 'codex', prompt: 'x', sandbox: 'danger-full-access' }, 400, /sandbox/],
      [{ provider: 'codex', prompt: 'x', effort: 'ludicrous' }, 400, /effort/],
      [{ provider: 'codex', prompt: 'x', model: '--dangerously-bypass-approvals-and-sandbox' }, 400, /invalid model name/],
      [{ provider: 'codex', prompt: 'x', kind: 'no-such-kind' }, 400, /unknown task kind/],
      [{ provider: 'codex' }, 400, /needs a prompt/],
      [{ provider: 'codex', prompt: 'x', context: { project: outside } }, 403, /context\.project .* is outside the workspace root/],
      [{ provider: 'codex', prompt: 'x', context: { project: '../..' } }, 403, /outside the workspace root/],
      [{ provider: 'codex', prompt: 'x', context: { project: 'no/such/folder' } }, 404, /directory not found/],
      [{ provider: 'codex', prompt: 'x', context: { project: 'model.r2d.json' } }, 400, /is a file, not a directory/],
      [{ provider: 'codex', prompt: 'x', context: { project: 7 } }, 400, /must be a string path/],
      [{ provider: 'codex', prompt: 'x', context: { file: path.join(outside, 'm.r2d.json') } }, 403, /outside the workspace root/],
      [{ provider: 'codex', prompt: 'x', images: [path.join(outside, 'secret.png')] }, 403, /images\.0 .* is outside the workspace root/],
      [{ provider: 'codex', prompt: 'x', images: ['notes.txt'] }, 400, /not an image file/],
      [{ provider: 'codex', prompt: 'x', images: ['missing.png'] }, 400, /does not exist/],
      [{ provider: 'codex', prompt: 'x', images: Array.from({ length: 9 }, () => 'tex.png') }, 400, /at most 8 images/],
      [{ provider: 'codex', prompt: 'x'.repeat(32 * 1024 + 1) }, 413, /at most 32768 are accepted/],
    ];
    for (const [body, status, message] of cases) {
      const res = await api.post('/api/agent/jobs', body);
      const json = (await res.json()) as { error: string; hint?: string };
      expect(res.status, `${JSON.stringify(body).slice(0, 90)} -> ${json.error}`).toBe(status);
      expect(json.error).toMatch(message);
    }
    const huge = await api.post('/api/agent/jobs', { provider: 'codex', prompt: 'x'.repeat(300 * 1024) });
    expect(huge.status).toBe(413);
    expect((await api.get('/api/agent/jobs/a%20b')).status).toBe(400);
    expect((await api.get('/api/agent/jobs/000000000000')).status).toBe(404);
    const since = await api.get('/api/agent/jobs/000000000000?since=-1');
    expect(since.status).toBe(400);
    const unknown = await api.get('/api/agent/nope');
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { hint: string }).hint).toContain('POST /api/agent/jobs/:id/message');
    const method = await api.post('/api/agent/providers');
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET');
    // None of them started anything.
    expect(((await (await api.get('/api/agent/jobs')).json()) as AgentJobList).active).toBeNull();
  });

  it("an agent's edit reloads the editor, and a save based on the older version is refused instead of overwriting it", async () => {
    const tab = await openEvents(fx.base);
    try {
      const before = (await (await fetch(`${fx.base}/api/model`)).json()) as { text: string; mtimeMs: number };
      const mine = JSON.parse(before.text) as { meta: { name: string } };
      mine.meta.name = 'edited-in-the-editor';

      const job = await api.finished((await api.start({ provider: 'codex', prompt: 'rename it [[fake:edit-model]]' })).id);
      expect(job.job.state).toBe('done');
      expect(job.events.filter((e) => e.type === 'file')).toMatchObject([
        { phase: 'started', changes: [{ kind: 'update' }] },
        { phase: 'completed', status: 'completed' },
      ]);
      // The watcher tells every tab that the file changed on disk (not through the editor).
      const changed = await tab.next((e) => e.event === 'model-changed');
      expect(changed.data).toMatchObject({ origin: 'external', files: ['model.r2d.json'] });

      // The editor still holds the version from before the job: its save must not win silently.
      const put = (body: unknown) => fetch(`${fx.base}/api/model`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const stale = await put({ doc: mine, baseMtimeMs: before.mtimeMs });
      expect(stale.status).toBe(409);
      const conflict = (await stale.json()) as { error: string; mtimeMs: number };
      expect(conflict.error).toMatch(/changed on disk since the version this write is based on/);
      expect(JSON.parse(readFileSync(fx.file, 'utf8')).meta.name).toBe('edited-by-agent');

      // After reloading, the editor's change is based on the agent's version and goes through.
      const now = (await (await fetch(`${fx.base}/api/model`)).json()) as { text: string; mtimeMs: number };
      expect(now.mtimeMs).toBe(conflict.mtimeMs);
      const merged = JSON.parse(now.text) as { meta: { name: string; description?: string } };
      expect(merged.meta.name).toBe('edited-by-agent');
      merged.meta.description = 'kept both';
      const ok = await put({ doc: merged, baseMtimeMs: now.mtimeMs });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, written: true });
      expect(JSON.parse(readFileSync(fx.file, 'utf8')).meta).toMatchObject({ name: 'edited-by-agent', description: 'kept both' });
    } finally {
      tab.close();
    }
  });

  it('a save made while a job runs is not blocked, and the job is not disturbed', async () => {
    const job = await api.start({ provider: 'codex', prompt: 'think [[fake:hang]]' });
    const current = (await (await fetch(`${fx.base}/api/model`)).json()) as { text: string; mtimeMs: number };
    const doc = JSON.parse(current.text) as { meta: { description?: string } };
    doc.meta.description = 'saved during a job';
    const res = await fetch(`${fx.base}/api/model`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc, baseMtimeMs: current.mtimeMs }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ written: true });
    const state = ((await (await api.get(`/api/agent/jobs/${job.id}`)).json()) as AgentJobDetail).job.state;
    expect(['queued', 'running']).toContain(state);
    expect(((await (await api.post(`/api/agent/jobs/${job.id}/cancel`)).json()) as { job: AgentJobInfo }).job.state).toBe('cancelled');
  });
});

// ----------------------------------------------------------------------------- limits and shutdown

describe('agent bridge: limits and shutdown', () => {
  // One server for the three tests, in this order: the last one closes it.
  let fx: Fixture;
  let api: Client;
  let clock = Date.UTC(2026, 0, 1);

  beforeAll(async () => {
    fx = await startFixture({ agent: agentOptions({ maxStartsPerMinute: 2, maxPromptBytes: 64, now: () => clock }) });
    api = await client(fx.base);
  });

  afterAll(async () => {
    await fx.close();
  });

  it('applies the configured prompt cap', async () => {
    // Bytes, not characters: 30 Korean syllables are 90 bytes.
    const res = await api.post('/api/agent/jobs', { provider: 'codex', prompt: '가'.repeat(30) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'the prompt is 90 bytes; at most 64 are accepted', code: 'too-large' });
  });

  it('rate-limits starts and follow-ups', async () => {
    const first = await api.finished((await api.start({ provider: 'codex', prompt: '가'.repeat(20) })).id);
    expect(first.job.state).toBe('done');
    // Requests that start nothing do not count.
    expect((await api.post('/api/agent/jobs', { provider: 'codex' })).status).toBe(400);
    clock += 10_000;
    const follow = await api.post(`/api/agent/jobs/${first.job.id}/message`, { prompt: 'two' });
    expect(follow.status).toBe(202);
    await api.finished(((await follow.json()) as { job: AgentJobInfo }).job.id);
    clock += 10_000;
    for (const send of [() => api.post('/api/agent/jobs', { provider: 'codex', prompt: 'three' }), () => api.post(`/api/agent/jobs/${first.job.id}/message`, { prompt: 'three' })]) {
      const limited = await send();
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('40');
      expect(await limited.json()).toMatchObject({ error: 'too many agent jobs were started (2 in the last minute)', hint: 'wait 40 s before starting another one', code: 'rate-limited', retryAfter: 40 });
    }
    expect(((await (await api.get('/api/agent/jobs')).json()) as AgentJobList).jobs).toHaveLength(2);
    // A minute after the first start, one slot is free again.
    clock += 40_000;
    expect((await api.finished((await api.start({ provider: 'codex', prompt: 'three' })).id)).job.state).toBe('done');
    expect((await api.post('/api/agent/jobs', { provider: 'codex', prompt: 'four' })).status).toBe(429);
  });

  it('stops the running job when the server closes', async () => {
    clock += 120_000;
    const tab = await openEvents(fx.base);
    const job = await api.start({ provider: 'codex', prompt: 'work forever [[fake:hang]]' });
    const said = (await tab.next((e) => agentJob(job.id)(e) && (e.data as AgentJobEventPayload).event!.type === 'message')).data as AgentJobEventPayload;
    const { pid, child } = JSON.parse((said.event as { text: string }).text) as { pid: number; child: number };
    expect(processAlive(pid) && processAlive(child)).toBe(true);
    await fx.close();
    await tab.ended;
    // The tab still received the end of the job before its stream closed.
    expect(tab.events.filter(agentJob(job.id)).at(-1)!.data).toMatchObject({ state: 'cancelled', event: { type: 'done', reason: 'cancelled' } });
    await until(() => !processAlive(pid) && !processAlive(child), 'the agent processes to be gone');
    tab.close();
  });
});

// ----------------------------------------------------------------------------- settings

describe('agent bridge: settings (the Codex Windows sandbox)', () => {
  const OVERRIDE = 'windows.sandbox="unelevated"';
  const hasOverride = (job: AgentJobInfo) => {
    const { argv } = JSON.parse(job.finalMessage!) as { argv: string[] };
    return argv.some((a, i) => a === OVERRIDE && argv[i - 1] === '-c');
  };
  const put = (api: Client, base: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/agent/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Rev2D-Token': api.token, ...headers }, body: JSON.stringify(body) });

  it('reports the effective settings with their sources; without a settings file they live in memory', async () => {
    // A test server does not register itself, so it never touches ~/.rev2d/settings.json.
    const fx = await startFixture({ agent: agentOptions() });
    try {
      const api = await client(fx.base);
      expect((await fetch(`${fx.base}/api/agent/settings`)).status).toBe(401);
      const res = await api.get('/api/agent/settings');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ settings: { codexWindowsSandbox: 'config' }, sources: { codexWindowsSandbox: 'default' }, user: {}, file: null, windows: process.platform === 'win32', notes: [] });
      const saved = await put(api, fx.base, { codexWindowsSandbox: 'unelevated' });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ settings: { codexWindowsSandbox: 'unelevated' }, sources: { codexWindowsSandbox: 'user' }, user: { codexWindowsSandbox: 'unelevated' }, file: null });
      expect(await (await api.get('/api/agent/settings')).json()).toMatchObject({ settings: { codexWindowsSandbox: 'unelevated' }, sources: { codexWindowsSandbox: 'user' } });
    } finally {
      await fx.close();
    }
  });

  it('PUT saves the user setting to the settings file, and the next job, the providers list and the hints follow it', async () => {
    const file = path.join(tempDir('rev2d-agent-settings-'), 'settings.json');
    writeFileSync(file, JSON.stringify({ theme: 'dark' }));
    // platform: the Windows handling is tested on every host; the fake CLIs run either way.
    const fx = await startFixture({ agent: agentOptions({ settingsFile: file, platform: 'win32' }) });
    try {
      const api = await client(fx.base);
      expect(await (await api.get('/api/agent/settings')).json()).toEqual({ settings: { codexWindowsSandbox: 'config' }, sources: { codexWindowsSandbox: 'default' }, user: {}, file, windows: true, notes: [] });
      expect(((await (await api.get('/api/agent/providers')).json()) as Array<{ windowsSandbox?: string }>).map((p) => p.windowsSandbox)).toEqual(['config', undefined]);

      // With the default, a broken sandbox is explained with both fixes, live.
      const broken = await api.finished((await api.start({ provider: 'codex', prompt: '[[fake:helper-exit]]' })).id);
      expect(hasOverride(await api.finished((await api.start({ provider: 'codex', prompt: 'echo' })).id).then((d) => d.job))).toBe(false);
      const explained = broken.events.filter((e) => e.type === 'error');
      expect(explained).toHaveLength(1);
      expect(explained[0]).toMatchObject({ code: 'codex-windows-sandbox', hint: expect.stringContaining('PUT /api/agent/settings {"codexWindowsSandbox": "unelevated"}') });

      // The one-click fix.
      const res = await put(api, fx.base, { codexWindowsSandbox: 'unelevated' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ settings: { codexWindowsSandbox: 'unelevated' }, sources: { codexWindowsSandbox: 'user' }, user: { codexWindowsSandbox: 'unelevated' }, file, windows: true, notes: [] });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'dark', agent: { codexWindowsSandbox: 'unelevated' } });
      expect(((await (await api.get('/api/agent/providers')).json()) as Array<{ windowsSandbox?: string }>)[0].windowsSandbox).toBe('unelevated');
      const next = await api.finished((await api.start({ provider: 'codex', prompt: 'echo', sandbox: 'read-only' })).id);
      expect(hasOverride(next.job)).toBe(true);
      expect((JSON.parse(next.job.finalMessage!) as { argv: string[] }).argv).toEqual(expect.arrayContaining(['-s', 'read-only']));
      // Still broken with the unelevated sandbox: the hint no longer offers it.
      const still = await api.finished((await api.start({ provider: 'codex', prompt: '[[fake:helper-exit]]' })).id);
      const hint = (still.events.find((e) => e.type === 'error') as { hint: string }).hint;
      expect(hint).toContain('already');
      expect(hint).not.toContain('PUT /api/agent/settings');

      // Back to the person's Codex configuration; an edit of the file by hand counts too.
      expect((await put(api, fx.base, { codexWindowsSandbox: 'config' })).status).toBe(200);
      expect(hasOverride((await api.finished((await api.start({ provider: 'codex', prompt: 'echo' })).id)).job)).toBe(false);
      writeFileSync(file, JSON.stringify({ agent: { codexWindowsSandbox: 'unelevated' } }));
      expect(hasOverride((await api.finished((await api.start({ provider: 'codex', prompt: 'echo' })).id)).job)).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it('an option of the server (or the --agent-codex-sandbox flag) beats the saved setting; saving still works', async () => {
    const file = path.join(tempDir('rev2d-agent-settings-'), 'settings.json');
    writeFileSync(file, JSON.stringify({ agent: { codexWindowsSandbox: 'unelevated' } }));
    const fx = await startFixture({ agent: agentOptions({ settingsFile: file, platform: 'win32', codexWindowsSandbox: 'config', settingsSource: 'flag' }) });
    try {
      const api = await client(fx.base);
      const info = (await (await api.get('/api/agent/settings')).json()) as { notes: string[] };
      expect(info).toMatchObject({ settings: { codexWindowsSandbox: 'config' }, sources: { codexWindowsSandbox: 'flag' }, user: { codexWindowsSandbox: 'unelevated' }, file });
      expect(info.notes).toEqual([expect.stringContaining('this editor was started with a flag that sets "config"')]);
      expect(hasOverride((await api.finished((await api.start({ provider: 'codex', prompt: 'echo' })).id)).job)).toBe(false);
      writeFileSync(file, JSON.stringify({ agent: { codexWindowsSandbox: 'config' } }));
      const saved = await put(api, fx.base, { codexWindowsSandbox: 'unelevated' });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ settings: { codexWindowsSandbox: 'config' }, sources: { codexWindowsSandbox: 'flag' }, user: { codexWindowsSandbox: 'unelevated' } });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ agent: { codexWindowsSandbox: 'unelevated' } });
      expect(hasOverride((await api.finished((await api.start({ provider: 'codex', prompt: 'echo' })).id)).job)).toBe(false);
    } finally {
      await fx.close();
    }
    const option = await startFixture({ agent: agentOptions({ settingsFile: file, platform: 'win32', codexWindowsSandbox: 'unelevated' }) });
    try {
      const api = await client(option.base);
      expect(await (await api.get('/api/agent/settings')).json()).toMatchObject({ settings: { codexWindowsSandbox: 'unelevated' }, sources: { codexWindowsSandbox: 'option' }, notes: [] });
      expect(hasOverride((await api.finished((await api.start({ provider: 'codex', prompt: 'echo' })).id)).job)).toBe(true);
    } finally {
      await option.close();
    }
  });

  it('guards the settings like every agent endpoint, and a job request cannot carry them', async () => {
    const file = path.join(tempDir('rev2d-agent-settings-'), 'settings.json');
    const fx = await startFixture({ agent: agentOptions({ settingsFile: file, platform: 'win32' }) });
    try {
      const api = await client(fx.base);
      const body = JSON.stringify({ codexWindowsSandbox: 'unelevated' });
      // No token, a wrong token, a foreign origin, a foreign Host: nothing is written.
      expect((await fetch(`${fx.base}/api/agent/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(401);
      expect((await put(api, fx.base, { codexWindowsSandbox: 'unelevated' }, { 'X-Rev2D-Token': 'nope' })).status).toBe(401);
      for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'evil.example' }] as Array<Record<string, string>>) {
        const res = await rawRequest(fx.base, { method: 'PUT', path: '/api/agent/settings', headers: { 'Content-Type': 'application/json', 'X-Rev2D-Token': api.token, ...headers }, body });
        expect(res.status, JSON.stringify(headers)).toBe(403);
      }
      for (const [bad, message] of [
        [{ codexWindowsSandbox: 'elevated' }, /codexWindowsSandbox/],
        [{ codexWindowsSandbox: 'danger-full-access' }, /codexWindowsSandbox/],
        [{}, /nothing to save/],
        [{ codexWindowsSandbox: 'unelevated', sandbox: 'danger-full-access' }, /sandbox/],
        [['unelevated'], /invalid agent settings request/],
      ] as Array<[unknown, RegExp]>) {
        const res = await put(api, fx.base, bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(((await res.json()) as { error: string }).error).toMatch(message);
      }
      const method = await api.post('/api/agent/settings', { codexWindowsSandbox: 'unelevated' });
      expect(method.status).toBe(405);
      expect(method.headers.get('allow')).toBe('GET, PUT');
      expect(existsSync(file)).toBe(false);

      // The setting is not a field of a job: as a field it is refused, inside "context" it is only template input.
      const inBody = await api.post('/api/agent/jobs', { provider: 'codex', prompt: 'x', codexWindowsSandbox: 'unelevated' });
      expect(inBody.status).toBe(400);
      expect(((await inBody.json()) as { error: string }).error).toMatch(/codexWindowsSandbox/);
      const inContext = await api.finished((await api.start({ provider: 'codex', prompt: 'x', context: { codexWindowsSandbox: 'unelevated' } })).id);
      expect(hasOverride(inContext.job)).toBe(false);
      const follow = await api.post(`/api/agent/jobs/${inContext.job.id}/message`, { prompt: 'x', codexWindowsSandbox: 'unelevated' });
      expect(follow.status).toBe(400);

      // A settings file that is not JSON is reported and never overwritten.
      writeFileSync(file, '{ not json');
      const info = (await (await api.get('/api/agent/settings')).json()) as { settings: unknown; notes: string[] };
      expect(info.settings).toEqual({ codexWindowsSandbox: 'config' });
      expect(info.notes[0]).toMatch(/is not valid JSON/);
      const refused = await put(api, fx.base, { codexWindowsSandbox: 'unelevated' });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: 'settings-file', hint: expect.stringContaining('delete it') });
      expect(readFileSync(file, 'utf8')).toBe('{ not json');
    } finally {
      await fx.close();
    }
  });
});
