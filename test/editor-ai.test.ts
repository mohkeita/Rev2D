/**
 * The AI panel's pure parts (editor/src/ai): the event reducer (one row per item id, in-place
 * updates, the end of a job, catching up after a reconnect by seq), the markdown-lite renderer, the
 * error mapping, the bridge client (token, retry on 401) and the controller with a fake client.
 * Recorded provider sessions (test/fixtures/fake-agents) are parsed by the real provider parsers, so
 * the reducer is tested on the events the bridge really sends.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/api/templates.js';
import { claudeProvider, codexProvider, type AgentProvider } from '../src/node/agent/index.js';
import type { AgentEvent, AgentEventBody, AgentJobDetail, AgentJobInfo, AgentJobList, AgentProviderInfo, AgentSettingsInfo, AgentTaskInfo, SessionInfo } from '../src/node/editor-registry.js';
import { createAgentClient, type AgentClient } from '../editor/src/ai/client.js';
import { jobContext, suggestionsFor, workContext } from '../editor/src/ai/context.js';
import {
  applyEvents,
  applyJobInfo,
  blocksOf,
  conversationJobs,
  emptyJobView,
  formatElapsed,
  isModelPath,
  isResumable,
  jobDuration,
  lastJob,
  noteModelUpdated,
  progressOf,
  prominentErrors,
  resolveAgentPath,
  summarize,
  type JobView,
} from '../editor/src/ai/conversation.js';
import { explainProblem, networkProblem, problemFrom } from '../editor/src/ai/errors.js';
import { parseInline, parseMarkdown, plainText } from '../editor/src/ai/markdown.js';
import { MessageText } from '../editor/src/ai/MessageText.js';
import { AiController } from '../editor/src/ai/store.js';
import { durationText, shortCommand } from '../editor/src/ai/words.js';
import { t } from '../editor/src/i18n/index.js';

const FAKES = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'fake-agents');

function job(over: Partial<AgentJobInfo> = {}): AgentJobInfo {
  return {
    id: 'job1',
    provider: 'codex',
    kind: 'freeform',
    title: 'Widen the head warp',
    state: 'running',
    cwd: 'C:/work',
    sandbox: 'workspace-write',
    model: null,
    effort: null,
    allowImageGeneration: false,
    images: [],
    sessionId: null,
    resumeOf: null,
    conversation: over.id ?? 'job1',
    createdAt: '2026-10-05T06:12:19.308Z',
    startedAt: '2026-10-05T06:12:19.321Z',
    endedAt: null,
    exitCode: null,
    error: null,
    finalMessage: null,
    usage: null,
    lastSeq: 0,
    logFile: null,
    ...over,
  };
}

/** Number event bodies 1, 2, 3, ... like the manager does. */
function numbered(bodies: AgentEventBody[], from = 1): AgentEvent[] {
  return bodies.map((b, i) => ({ seq: from + i, time: `2026-10-05T06:12:${String(20 + i).padStart(2, '0')}.000Z`, ...b }) as AgentEvent);
}

/** The events the bridge sends for a recorded provider session (the provider's own parser). */
function recorded(provider: AgentProvider, file: string): AgentEvent[] {
  const parser = provider.createParser();
  const bodies: AgentEventBody[] = [{ type: 'status', status: 'queued', text: 'queued' }, { type: 'status', status: 'running', text: 'started' }];
  for (const line of readFileSync(path.join(FAKES, file), 'utf8').split('\n')) if (line.trim()) bodies.push(...parser.line(line).events);
  bodies.push({ type: 'done', state: 'done', reason: 'completed', exitCode: 0, message: null });
  return numbered(bodies);
}

// ----------------------------------------------------------------------------- the reducer

describe('AI panel: event reducer', () => {
  it('keeps one row per item id and updates it in place', () => {
    const events = numbered([
      { type: 'status', status: 'queued', text: 'q' },
      { type: 'command', id: 'c1', phase: 'started', status: 'running', command: 'node rev2d.js validate m.json', exitCode: null, output: '', outputTruncated: false },
      { type: 'message', text: 'Checking.' },
      { type: 'file', id: 'f1', phase: 'started', status: 'running', changes: [{ path: 'm.r2d.json', kind: 'update' }] },
      { type: 'command', id: 'c1', phase: 'completed', status: 'completed', command: 'node rev2d.js validate m.json', exitCode: 0, output: 'ok\n', outputTruncated: false },
      { type: 'file', id: 'f1', phase: 'completed', status: 'completed', changes: [{ path: 'm.r2d.json', kind: 'update' }] },
    ]);
    const { view, missing } = applyEvents(emptyJobView(job()), events);
    expect(missing).toBe(false);
    expect(view.rows.map((r) => r.key)).toEqual(['command:c1', 'seq:3', 'file:f1']);
    const cmd = view.rows[0]!;
    expect(cmd).toMatchObject({ kind: 'command', status: 'completed', exitCode: 0, output: 'ok\n', seq: 2 });
    expect(view.rows[2]).toMatchObject({ kind: 'file', status: 'completed' });
    expect(view.lastSeq).toBe(6);
    expect(view.status).toMatchObject({ status: 'queued' });
  });

  it('turns a recorded Codex session into rows: one checklist, commands, files, tools, the answer, usage', () => {
    const events = recorded(codexProvider, 'codex-full.jsonl');
    const { view } = applyEvents(emptyJobView(job()), events);
    const kinds = view.rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'todo')).toHaveLength(1);
    expect(view.rows.find((r) => r.kind === 'todo')).toMatchObject({ items: [{ text: 'Read the model', done: true }, { text: 'Widen the head warp', done: false }] });
    // item_2 started and completed: one row, completed.
    const commands = view.rows.filter((r) => r.kind === 'command');
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({ id: 'item_2', status: 'completed', exitCode: 0 });
    expect(commands[1]).toMatchObject({ id: 'item_7', status: 'failed', exitCode: 1 });
    expect(view.rows.filter((r) => r.kind === 'file')).toHaveLength(1);
    expect(view.rows.filter((r) => r.kind === 'message').map((r) => (r as { text: string }).text)).toEqual(['Widened the head warp; `validate` shows 0 errors.\nUncertain: the hair strand roots (머리카락).']);
    expect(view.usage).toMatchObject({ inputTokens: 48213, outputTokens: 1582 });
    expect(view.done).toMatchObject({ state: 'done' });
    const s = summarize(view.rows.filter((r) => r.kind !== 'message') as never);
    expect(s).toMatchObject({ commands: 2, failedCommands: 1, files: 3, running: false });
  });

  it('keeps one checklist for Claude Code, whose to-do updates carry new ids', () => {
    const { view } = applyEvents(emptyJobView(job({ provider: 'claude' })), recorded(claudeProvider, 'claude-full.jsonl'));
    const todos = view.rows.filter((r) => r.kind === 'todo');
    expect(todos).toHaveLength(1);
    expect(view.rows.some((r) => r.kind === 'message')).toBe(true);
  });

  it('applies each seq once, reports a gap in a live stream, and accepts a gap the server announces', () => {
    const all = numbered([
      { type: 'status', status: 'queued', text: 'q' },
      { type: 'message', text: 'one' },
      { type: 'message', text: 'two' },
      { type: 'message', text: 'three' },
    ]);
    let v = applyEvents(emptyJobView(job()), all.slice(0, 2)).view;
    // A duplicate (SSE after a GET that already had it) is skipped.
    v = applyEvents(v, [all[1]!]).view;
    expect(v.rows).toHaveLength(1);
    // seq 4 without seq 3: nothing applied, the caller fetches since lastSeq.
    const jump = applyEvents(v, [all[3]!]);
    expect(jump.missing).toBe(true);
    expect(jump.view.lastSeq).toBe(2);
    // The answer of GET ?since=2 brings both, in any order.
    v = applyEvents(v, [all[3]!, all[2]!]).view;
    expect(v.rows.map((r) => (r as { text: string }).text)).toEqual(['one', 'two', 'three']);
    expect(v.gap).toBe(false);
    // The server dropped events 1-2 (firstSeq 3): accepted, marked.
    const late = applyEvents(emptyJobView(job()), all.slice(2), { firstSeq: 3 });
    expect(late.missing).toBe(false);
    expect(late.view.gap).toBe(true);
    expect(late.view.rows).toHaveLength(2);
  });

  it('ends a job: a failure becomes an error row once; a cancel is not an error', () => {
    const failed = numbered([
      { type: 'error', message: 'thread main panicked: something broke' },
      { type: 'done', state: 'failed', reason: 'failed', exitCode: 3, message: null, error: 'thread main panicked: something broke' },
    ]);
    const v = applyEvents(emptyJobView(job()), failed).view;
    expect(v.rows.filter((r) => r.kind === 'error')).toHaveLength(1);
    const auth = applyEvents(emptyJobView(job()), numbered([{ type: 'done', state: 'failed', reason: 'failed', exitCode: 1, message: null, error: 'Not logged in', hint: 'run codex login' }])).view;
    expect(auth.rows).toEqual([expect.objectContaining({ kind: 'error', message: 'Not logged in', hint: 'run codex login' })]);
    const cancelled = applyEvents(emptyJobView(job()), numbered([{ type: 'done', state: 'cancelled', reason: 'cancelled', exitCode: null, message: null, error: 'the job was cancelled' }])).view;
    expect(cancelled.rows).toEqual([]);
    expect(cancelled.done?.state).toBe('cancelled');
  });

  it('notes the Codex Windows sandbox problem from an error or a stalled status', () => {
    const err = applyEvents(emptyJobView(job()), numbered([{ type: 'error', message: 'Codex cannot start commands', hint: 'h', code: 'codex-windows-sandbox' }])).view;
    expect(err.sandbox).toBe('error');
    const stalled = applyEvents(emptyJobView(job()), numbered([{ type: 'status', status: 'stalled', text: 'silent', hint: 'h', code: 'codex-windows-sandbox' }])).view;
    expect(stalled.sandbox).toBe('stalled');
    expect(stalled.rows).toEqual([expect.objectContaining({ kind: 'notice', status: 'stalled' })]);
    expect(progressOf(stalled)).toEqual({ kind: 'stalled' });
  });

  it('takes newer job snapshots only', () => {
    let v = emptyJobView(job({ lastSeq: 5 }));
    v = applyJobInfo(v, job({ lastSeq: 3, state: 'queued' }));
    expect(v.job.lastSeq).toBe(5);
    v = applyJobInfo(v, job({ lastSeq: 9, state: 'done', sessionId: 's' }));
    expect(v.job.state).toBe('done');
    // A late "running" snapshot after the end changes nothing.
    expect(applyJobInfo(v, job({ lastSeq: 9, state: 'running' })).job.state).toBe('done');
    expect(isResumable(v.job)).toBe(true);
    expect(isResumable(job({ state: 'failed', sessionId: null }))).toBe(false);
  });

  it('groups rows into blocks; passing errors stay in the activity, the ones that matter stand alone', () => {
    let v = applyEvents(
      emptyJobView(job({ state: 'failed' })),
      numbered([
        { type: 'reasoning', text: 'plan' },
        { type: 'error', message: 'Reconnecting... 1/5' },
        { type: 'todo', id: 't', items: [{ text: 'a', done: false }] },
        { type: 'message', text: 'hi' },
        { type: 'command', id: 'c', phase: 'completed', status: 'completed', command: 'x', exitCode: 0, output: '', outputTruncated: false },
        { type: 'error', message: 'login', hint: 'run codex login' },
        { type: 'error', message: 'exited with 1' },
      ]),
    ).view;
    v = noteModelUpdated(v);
    v = noteModelUpdated(v);
    const blocks = blocksOf(v.rows, prominentErrors(v));
    expect(blocks.map((b) => b.type)).toEqual(['activity', 'todo', 'message', 'activity', 'error', 'error', 'model-updated']);
    expect((blocks[0] as { rows: unknown[] }).rows).toHaveLength(2);
  });

  it('orders a conversation and finds its last job', () => {
    const a = emptyJobView(job({ id: 'a', conversation: 'a', createdAt: '2026-10-05T06:00:00.000Z', state: 'done', sessionId: 's' }));
    const b = emptyJobView(job({ id: 'b', conversation: 'a', resumeOf: 'a', createdAt: '2026-10-05T06:05:00.000Z' }));
    const c = emptyJobView(job({ id: 'c', conversation: 'c' }));
    const jobs: Record<string, JobView> = { b, c, a };
    expect(conversationJobs(jobs, 'a').map((v) => v.job.id)).toEqual(['a', 'b']);
    expect(lastJob(jobs, 'a')?.job.id).toBe('b');
    expect(lastJob(jobs, null)).toBeNull();
  });

  it('says what a job does now', () => {
    const base = emptyJobView(job({ state: 'queued' }));
    expect(progressOf(base)).toEqual({ kind: 'starting' });
    const cmd = applyEvents(base, numbered([{ type: 'status', status: 'running', text: 'r' }, { type: 'command', id: 'c', phase: 'started', status: 'running', command: 'node x/bin/rev2d.js validate a.json', exitCode: null, output: '', outputTruncated: false }])).view;
    expect(progressOf({ ...cmd, job: { ...cmd.job, state: 'running' } })).toEqual({ kind: 'command', detail: 'node x/bin/rev2d.js validate a.json' });
    expect(progressOf({ ...cmd, job: { ...cmd.job, state: 'done' } })).toEqual({ kind: 'ended', state: 'done' });
    expect(shortCommand('node C:/Users/me/Rev2D/bin/rev2d.js info "m.r2d.json"')).toBe('rev2d info "m.r2d.json"');
    expect(shortCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\R\\bin\\rev2d.js" docs agents')).toBe('rev2d docs agents');
    expect(shortCommand('/usr/bin/git status')).toBe('git status');
    expect(shortCommand(`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'node C:/R/bin/rev2d.js info m.r2d.json'`)).toBe('rev2d info m.r2d.json');
    expect(shortCommand('bash -lc "ls -la"')).toBe('ls -la');
  });

  it('measures time and resolves paths the agent reports', () => {
    const j = job({ startedAt: '2026-10-05T06:00:00.000Z', endedAt: '2026-10-05T06:01:12.400Z', state: 'done' });
    expect(jobDuration(j, 0)).toBe(72_400);
    expect(jobDuration(job({ startedAt: '2026-10-05T06:00:00.000Z' }), Date.parse('2026-10-05T06:00:05.000Z'))).toBe(5000);
    expect(formatElapsed(7_900)).toBe('0:07');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(durationText(72_400, t)).toBe('1 min 12 s');
    expect(resolveAgentPath('models/../hero.r2d.json', 'C:\\work\\a')).toBe('C:/work/a/hero.r2d.json');
    expect(resolveAgentPath('C:\\x\\y.png', 'C:/work')).toBe('C:/x/y.png');
    expect(resolveAgentPath('./out/a.png', '/home/me/w')).toBe('/home/me/w/out/a.png');
    expect(isModelPath('a/hero.r2d.json')).toBe(true);
    expect(isModelPath('C:\\p\\avatar.json')).toBe(true);
    expect(isModelPath('textures/layers.json')).toBe(false);
  });
});

// ----------------------------------------------------------------------------- markdown-lite

describe('AI panel: markdown-lite', () => {
  it('parses blocks: paragraphs with line breaks, headings, lists, tasks, code, quotes, rules, tables', () => {
    const md = [
      '# Done',
      'Widened the warp;',
      'checked it.',
      '',
      '- one',
      '- [x] two',
      '  - nested',
      '1. first',
      '2. second',
      '',
      '```json',
      '{ "a": 1 }',
      '```',
      '> quoted',
      '---',
      '| Part | Moves |',
      '| --- | --- |',
      '| eye | `EyeOpen` |',
    ].join('\n');
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'code', 'quote', 'rule', 'table']);
    expect(blocks[1]).toEqual({ type: 'paragraph', inline: [{ type: 'text', text: 'Widened the warp;' }, { type: 'br' }, { type: 'text', text: 'checked it.' }] });
    const list = blocks[2] as Extract<(typeof blocks)[number], { type: 'list' }>;
    expect(list.items.map((i) => i.checked)).toEqual([null, true]);
    expect(list.items[1]!.children[0]).toMatchObject({ type: 'list', items: [{ inline: [{ type: 'text', text: 'nested' }] }] });
    expect(blocks[3]).toMatchObject({ type: 'list', ordered: true, start: 1 });
    expect(blocks[4]).toEqual({ type: 'code', lang: 'json', text: '{ "a": 1 }' });
    expect(blocks[7]).toMatchObject({ type: 'table', rows: [[[{ type: 'text', text: 'eye' }], [{ type: 'code', text: 'EyeOpen' }]]] });
    expect(plainText(blocks)).toContain('Widened the warp;');
  });

  it('parses inline markup and leaves ids alone', () => {
    expect(parseInline('Run `rev2d validate` **now** and *check*')).toEqual([
      { type: 'text', text: 'Run ' },
      { type: 'code', text: 'rev2d validate' },
      { type: 'text', text: ' ' },
      { type: 'strong', children: [{ type: 'text', text: 'now' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'check' }] },
    ]);
    // snake_case and stars inside code are not emphasis.
    expect(parseInline('bind_warp and face_warp_x')).toEqual([{ type: 'text', text: 'bind_warp and face_warp_x' }]);
    expect(parseInline('`a*b*c`')).toEqual([{ type: 'code', text: 'a*b*c' }]);
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }]);
    expect(parseInline('\\*not em\\*')).toEqual([{ type: 'text', text: '*not em*' }]);
    // Links: http(s) only; anything else stays text.
    expect(parseInline('[docs](https://example.com/a) and [x](javascript:alert(1))')).toEqual([
      { type: 'link', href: 'https://example.com/a', children: [{ type: 'text', text: 'docs' }] },
      { type: 'text', text: ' and x' },
    ]);
    expect(parseInline('see https://github.com/RevStudio/Rev2D.')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', href: 'https://github.com/RevStudio/Rev2D', children: [{ type: 'text', text: 'https://github.com/RevStudio/Rev2D' }] },
      { type: 'text', text: '.' },
    ]);
  });

  it('renders text, never HTML', () => {
    const html = renderToStaticMarkup(createElement(MessageText, { text: 'Hi <script>alert(1)</script> **bold**\n\n- `a`\n\n```\n<b>x</b>\n```' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code class="ed-md-code">a</code>');
    expect(html).toContain('<pre class="ed-md-pre"><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
    const link = renderToStaticMarkup(createElement(MessageText, { text: '[docs](https://example.com)' }));
    expect(link).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"');
  });
});

// ----------------------------------------------------------------------------- errors

describe('AI panel: error mapping', () => {
  it('sorts answers into problems by code, then by status', () => {
    expect(problemFrom(404, { error: 'the agent endpoints are disabled: …', hint: 'start…', code: 'agent-disabled' })).toMatchObject({ kind: 'disabled', hint: 'start…' });
    expect(problemFrom(401, { error: 'wrong session token', code: 'token-required' }).kind).toBe('token');
    expect(problemFrom(409, { error: 'busy', code: 'busy', job: 'abc' })).toMatchObject({ kind: 'busy', jobId: 'abc' });
    expect(problemFrom(409, { error: 'x', code: 'not-resumable' }).kind).toBe('not-resumable');
    expect(problemFrom(409, { error: 'Codex CLI is not available', code: 'unavailable', hint: 'npm i -g @openai/codex' })).toMatchObject({ kind: 'unavailable', hint: 'npm i -g @openai/codex' });
    expect(problemFrom(429, { error: 'too many', code: 'rate-limited', retryAfter: 40 })).toMatchObject({ kind: 'rate-limited', retryAfter: 40 });
    expect(problemFrom(413, { error: 'big', code: 'too-large' }).kind).toBe('too-large');
    expect(problemFrom(403, { error: 'outside the workspace root' }).kind).toBe('forbidden');
    expect(problemFrom(400, { error: 'invalid agent job request', code: 'invalid' }).kind).toBe('invalid');
    expect(problemFrom(404, { error: 'unknown agent job', code: 'unknown-job' }).kind).toBe('unknown-job');
    expect(problemFrom(500, 'not json').kind).toBe('server');
    expect(problemFrom(500, null).message).toBe('HTTP 500');
    expect(networkProblem(new TypeError('Failed to fetch'))).toEqual({ kind: 'network', status: 0, message: 'Failed to fetch' });
  });

  it('explains a problem with words, the server hint and an action, never raw JSON', () => {
    const provider: AgentProviderInfo = { id: 'claude', name: 'Claude Code', available: false, version: null, features: { imageGeneration: false }, efforts: [], hint: 'install Claude Code' };
    const unavailable = explainProblem(problemFrom(409, { error: 'Claude Code is not available', code: 'unavailable' }), provider);
    expect(t(unavailable.title.key, unavailable.title.vars)).toBe('Claude Code is not available');
    expect(unavailable.hint).toBe('install Claude Code');
    expect(explainProblem(problemFrom(409, { error: 'busy', code: 'busy', job: 'j' })).action).toBe('show-job');
    expect(explainProblem(problemFrom(401, {})).action).toBe('reload-page');
    expect(explainProblem(problemFrom(429, { code: 'rate-limited', retryAfter: 12 })).text).toEqual({ key: 'ai.problem.rate.text', vars: { s: 12 } });
    const disabled = explainProblem(problemFrom(404, { code: 'agent-disabled' }));
    expect(t(disabled.text!.key)).toMatch(/--allow-agent/);
  });
});

// ----------------------------------------------------------------------------- client

interface Call {
  url: string;
  method: string;
  token: string | null;
  body: unknown;
}

function fakeFetch(routes: (call: Call, n: number) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = { url, method: init.method ?? 'GET', token: headers['X-Rev2D-Token'] ?? null, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const { status, body } = routes(call, calls.length);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

describe('AI panel: bridge client', () => {
  it('sends the session token and fetches a new one once after a 401 (the server restarted)', async () => {
    let sessions = 0;
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.url === '/api/session') return { status: 200, body: { token: `t${++sessions}`, agent: { enabled: true } } satisfies SessionInfo };
      // The server restarted after the first session answer: only the second token is valid.
      if (call.token !== 't2') return { status: 401, body: { error: 'wrong session token', code: 'token-required' } };
      return { status: 200, body: { jobs: [], active: null } };
    });
    const client = createAgentClient(fetchImpl);
    expect(await client.jobs()).toEqual({ jobs: [], active: null });
    expect(calls.map((c) => `${c.method} ${c.url} ${c.token ?? '-'}`)).toEqual(['GET /api/session -', 'GET /api/agent/jobs t1', 'GET /api/session -', 'GET /api/agent/jobs t2']);
    // The new token is kept.
    await client.jobs();
    expect(calls.at(-1)!.token).toBe('t2');
    expect(calls.filter((c) => c.url === '/api/session')).toHaveLength(2);
  });

  it('gives up after one retry, and says when the bridge is disabled', async () => {
    const { calls, fetchImpl } = fakeFetch((call) => (call.url === '/api/session' ? { status: 200, body: { token: 'x', agent: { enabled: true } } } : { status: 401, body: { error: 'wrong', code: 'token-required' } }));
    const client = createAgentClient(fetchImpl);
    await expect(client.providers()).rejects.toMatchObject({ problem: { kind: 'token' } });
    expect(calls.filter((c) => c.url === '/api/agent/providers')).toHaveLength(2);
    const off = createAgentClient(fakeFetch(() => ({ status: 200, body: { token: null, agent: { enabled: false, reason: 'bound to 0.0.0.0' } } })).fetchImpl);
    await expect(off.jobs()).rejects.toMatchObject({ problem: { kind: 'disabled', message: 'bound to 0.0.0.0' } });
    const down = createAgentClient(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(down.jobs()).rejects.toMatchObject({ problem: { kind: 'network' } });
  });

  it('maps error answers and posts the request bodies', async () => {
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.url === '/api/session') return { status: 200, body: { token: 'k', agent: { enabled: true } } };
      if (call.url === '/api/agent/jobs' && call.method === 'POST') return { status: 409, body: { error: 'another agent job is running', code: 'busy', job: 'j9', hint: 'cancel it' } };
      if (call.url.endsWith('/message')) return { status: 202, body: { job: job({ id: 'j2' }) } };
      return { status: 404, body: { error: 'nope' } };
    });
    const client = createAgentClient(fetchImpl);
    await expect(client.start({ provider: 'codex', prompt: 'hi' })).rejects.toMatchObject({ problem: { kind: 'busy', jobId: 'j9' } });
    expect((await client.message('j1', { prompt: 'more' })).id).toBe('j2');
    expect(calls.find((c) => c.url.endsWith('/message'))).toMatchObject({ method: 'POST', token: 'k', body: { prompt: 'more' } });
  });
});

// ----------------------------------------------------------------------------- controller

interface FakeServer {
  client: AgentClient;
  jobs: AgentJobInfo[];
  events: Record<string, AgentEvent[]>;
  started: unknown[];
  messages: Array<{ id: string; prompt: string }>;
  settings: AgentSettingsInfo;
  busy: string | null;
  enabled: boolean;
}

function fakeServer(): FakeServer {
  const providers: AgentProviderInfo[] = [
    { id: 'codex', name: 'Codex CLI', available: true, version: '0.160.0', features: { imageGeneration: true }, efforts: ['low', 'medium', 'high'] },
    { id: 'claude', name: 'Claude Code', available: false, version: null, features: { imageGeneration: false }, efforts: [], hint: 'install it' },
  ];
  const tasks: AgentTaskInfo[] = [{ kind: 'freeform', title: 'Free-form request', description: '', needsPrompt: true }];
  let n = 0;
  const s: FakeServer = {
    jobs: [],
    events: {},
    started: [],
    messages: [],
    busy: null,
    enabled: true,
    settings: { settings: { codexWindowsSandbox: 'config' }, sources: { codexWindowsSandbox: 'default' }, user: {}, file: null, windows: true, notes: [] },
    client: {
      session: async () => (s.enabled ? { token: 'k', agent: { enabled: true } } : { token: null, agent: { enabled: false, reason: 'bound to 0.0.0.0' } }),
      providers: async () => providers,
      tasks: async () => tasks,
      jobs: async (): Promise<AgentJobList> => ({ jobs: [...s.jobs].reverse(), active: s.jobs.find((j) => j.state === 'running' || j.state === 'queued')?.id ?? null }),
      job: async (id, since = 0): Promise<AgentJobDetail> => {
        const j = s.jobs.find((x) => x.id === id);
        if (!j) throw Object.assign(new Error('unknown'), { problem: { kind: 'unknown-job', status: 404, message: 'unknown' } });
        const events = (s.events[id] ?? []).filter((e) => e.seq > since);
        return { job: j, prompt: `prompt of ${id}`, events, firstSeq: s.events[id]?.[0]?.seq ?? 0, lastSeq: s.events[id]?.at(-1)?.seq ?? 0 };
      },
      start: async (req) => {
        if (s.busy) {
          const { AgentApiError } = await import('../editor/src/ai/client.js');
          throw new AgentApiError({ kind: 'busy', status: 409, message: 'busy', code: 'busy', jobId: s.busy });
        }
        s.started.push(req);
        const id = `job${++n}`;
        const j = job({ id, conversation: id, state: 'queued', createdAt: `2026-10-05T06:0${n}:00.000Z` });
        s.jobs.push(j);
        return j;
      },
      message: async (id, req) => {
        s.messages.push({ id, prompt: req.prompt });
        const prev = s.jobs.find((x) => x.id === id)!;
        const nid = `job${++n}`;
        const j = job({ id: nid, conversation: prev.conversation, resumeOf: id, state: 'queued', sessionId: prev.sessionId, createdAt: `2026-10-05T06:0${n}:00.000Z` });
        s.jobs.push(j);
        return j;
      },
      cancel: async (id) => {
        const j = s.jobs.find((x) => x.id === id)!;
        j.state = 'cancelled';
        return j;
      },
      settings: async () => s.settings,
      putSettings: async (req) => {
        s.settings = { ...s.settings, settings: { codexWindowsSandbox: req.codexWindowsSandbox }, sources: { codexWindowsSandbox: 'user' }, user: { ...req } };
        return s.settings;
      },
    },
  };
  return s;
}

/** Finish a job on the fake server and deliver its events like the SSE stream would. */
function finish(server: FakeServer, ai: AiController, id: string, bodies: AgentEventBody[]): void {
  const j = server.jobs.find((x) => x.id === id)!;
  const events = numbered(bodies, (server.events[id]?.length ?? 0) + 1);
  server.events[id] = [...(server.events[id] ?? []), ...events];
  for (const e of events) {
    if (e.type === 'status' && e.sessionId) j.sessionId = e.sessionId;
    if (e.type === 'done') {
      j.state = e.state;
      j.endedAt = '2026-10-05T06:30:00.000Z';
    } else if (j.state === 'queued') j.state = 'running';
    j.lastSeq = e.seq;
    ai.onAgentJob({ job: { ...j }, state: j.state, event: e });
  }
}

describe('AI panel: controller', () => {
  it('reports a disabled bridge and starts nothing', async () => {
    const server = fakeServer();
    server.enabled = false;
    const ai = new AiController({ client: server.client, listen: false });
    await ai.init();
    expect(ai.get()).toMatchObject({ status: 'disabled', reason: 'bound to 0.0.0.0' });
    const r = await ai.start({ prompt: 'hi' });
    expect(r).toMatchObject({ error: 'bound to 0.0.0.0', problem: { kind: 'disabled' } });
    expect(server.started).toEqual([]);
  });

  it('starts a job with the context, follows its events and continues the conversation', async () => {
    const server = fakeServer();
    const ai = new AiController({ client: server.client, listen: false, context: (given) => ({ file: 'hero.r2d.json', ...given }) });
    await ai.init();
    expect(ai.get()).toMatchObject({ status: 'ready', provider: 'codex', conversation: null });
    ai.setEffort('codex', 'low');
    ai.setDraft('Widen the head');
    const r = await ai.send();
    expect(r).toEqual({ jobId: 'job1' });
    expect(server.started[0]).toEqual({ provider: 'codex', prompt: 'Widen the head', context: { file: 'hero.r2d.json' }, effort: 'low', allowImageGeneration: false });
    expect(ai.get()).toMatchObject({ conversation: 'job1', active: 'job1', draft: '' });
    finish(server, ai, 'job1', [
      { type: 'status', status: 'queued', text: 'q' },
      { type: 'status', status: 'session', text: 's', sessionId: 'thread-1' },
      { type: 'message', text: 'Done.' },
      { type: 'done', state: 'done', reason: 'completed', exitCode: 0, message: 'Done.' },
    ]);
    expect(ai.get().active).toBeNull();
    expect(ai.get().jobs.job1!.rows).toHaveLength(1);
    // A follow-up continues the provider session.
    ai.setDraft('and the hair');
    expect(await ai.send()).toEqual({ jobId: 'job2' });
    expect(server.messages).toEqual([{ id: 'job1', prompt: 'and the hair' }]);
    expect(ai.get().conversation).toBe('job1');
    // A new conversation starts a new job.
    finish(server, ai, 'job2', [{ type: 'done', state: 'done', reason: 'completed', exitCode: 0, message: null }]);
    ai.newConversation();
    ai.setDraft('something else');
    expect(await ai.send()).toEqual({ jobId: 'job3' });
    expect(server.started).toHaveLength(2);
    expect(ai.get().conversation).toBe('job3');
  });

  it('keeps a request that could not be sent and explains why (busy, with the job to show)', async () => {
    const server = fakeServer();
    server.busy = 'other';
    server.jobs.push(job({ id: 'other', conversation: 'other', state: 'running' }));
    const ai = new AiController({ client: server.client, listen: false });
    await ai.init();
    // The running job's conversation is shown after a reload.
    expect(ai.get()).toMatchObject({ conversation: 'other', active: 'other' });
    ai.newConversation();
    ai.setDraft('me too');
    const r = await ai.send();
    expect(r).toMatchObject({ problem: { kind: 'busy', jobId: 'other' } });
    expect(ai.get()).toMatchObject({ draft: 'me too', problem: { problem: { kind: 'busy' } } });
    await ai.showJob('other');
    expect(ai.get().conversation).toBe('other');
  });

  it('restores a conversation after a reload and catches up by seq', async () => {
    const server = fakeServer();
    const j = job({ id: 'j1', conversation: 'j1', state: 'running', lastSeq: 3 });
    server.jobs.push(j);
    server.events.j1 = numbered([
      { type: 'status', status: 'queued', text: 'q' },
      { type: 'message', text: 'one' },
      { type: 'message', text: 'two' },
    ]);
    const ai = new AiController({ client: server.client, listen: false });
    await ai.init();
    expect(ai.get().jobs.j1).toMatchObject({ prompt: 'prompt of j1', lastSeq: 3 });
    // A live event that skips one: the controller fetches the missing ones.
    const four = numbered([{ type: 'message', text: 'three' }, { type: 'message', text: 'four' }], 4);
    server.events.j1.push(...four);
    j.lastSeq = 5;
    ai.onAgentJob({ job: { ...j }, state: 'running', event: four[1]! });
    await new Promise((r) => setTimeout(r, 0));
    await ai.catchUp('j1');
    expect(ai.get().jobs.j1!.rows.map((r) => (r as { text: string }).text)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('notes a model change during a job, and applies the sandbox fix for the job that hit it', async () => {
    const server = fakeServer();
    let clock = 0;
    const ai = new AiController({ client: server.client, listen: false, now: () => clock });
    await ai.init();
    ai.onModelChanged({ origin: 'external', mtimeMs: 1 });
    expect(Object.keys(ai.get().jobs)).toEqual([]);
    ai.setDraft('fix');
    await ai.send();
    finish(server, ai, 'job1', [{ type: 'status', status: 'running', text: 'r' }]);
    ai.onModelChanged({ origin: 'external', mtimeMs: 2 });
    ai.onModelChanged({ origin: 'editor', mtimeMs: 3 });
    expect(ai.get().jobs.job1!.rows.filter((r) => r.kind === 'model-updated')).toHaveLength(1);
    finish(server, ai, 'job1', [
      { type: 'error', message: 'Codex cannot start commands', hint: 'h', code: 'codex-windows-sandbox' },
      { type: 'done', state: 'done', reason: 'completed', exitCode: 0, message: null },
    ]);
    // The watcher reports the last write shortly after the job ended: still this job's edit.
    clock += 1000;
    ai.onModelChanged({ origin: 'external', mtimeMs: 4 });
    expect(ai.get().jobs.job1!.rows.at(-1)!.kind).toBe('model-updated');
    clock += 60_000;
    ai.onModelChanged({ origin: 'external', mtimeMs: 5 });
    expect(ai.get().jobs.job1!.rows.filter((r) => r.kind === 'model-updated')).toHaveLength(2);

    expect(ai.get().jobs.job1!.sandbox).toBe('error');
    expect(await ai.setCodexSandbox('unelevated', 'job1')).toBe(true);
    expect(ai.get()).toMatchObject({ sandboxFixed: ['job1'], settings: { settings: { codexWindowsSandbox: 'unelevated' } } });
    const again = await ai.runAgain('job1');
    expect(again).toEqual({ jobId: 'job2' });
    expect(server.started.at(-1)).toMatchObject({ provider: 'codex', prompt: 'fix' });
  });
});

// ----------------------------------------------------------------------------- context

describe('AI panel: work context and suggestions', () => {
  it('works in the folder of the open model', () => {
    expect(workContext('C:\\w\\models\\hero.r2d.json', 'C:\\w')).toEqual({ file: 'models/hero.r2d.json', project: 'models', folder: 'models', folderPath: 'C:/w/models' });
    expect(workContext('/w/hero.r2d.json', '/w')).toEqual({ file: 'hero.r2d.json', folder: 'w', folderPath: '/w' });
    expect(workContext('', '/w')).toEqual({ folder: 'w', folderPath: '/w' });
    expect(workContext('/elsewhere/a.r2d.json', '/w')).toEqual({ folder: 'w', folderPath: '/w' });
    const base = workContext('/w/models/hero.r2d.json', '/w');
    expect(jobContext(base)).toEqual({ project: 'models', file: 'models/hero.r2d.json' });
    // The caller's project wins; the open model is only named when it lies inside it.
    expect(jobContext(base, { project: 'avatars/miko' })).toEqual({ project: 'avatars/miko' });
    expect(jobContext(workContext('/w/avatars/miko/miko.r2d.json', '/w'), { project: 'avatars/miko' })).toEqual({ project: 'avatars/miko', file: 'avatars/miko/miko.r2d.json' });
  });

  it('suggests requests that fit the document', () => {
    expect(suggestionsFor(null).map((s) => s.id)).toEqual(['new-model', 'how-to']);
    const rig = { parameters: [{ id: 'AngleX' }], animations: [{ id: 'idle' }] } as never;
    expect(suggestionsFor(rig).map((s) => s.id)).toEqual(['blink', 'analyze-idle', 'head-turn', 'validate']);
    expect(suggestionsFor({ parameters: [], animations: [] } as never).map((s) => s.id)).toEqual(['create-idle', 'validate', 'explain']);
  });
});

// ----------------------------------------------------------------------------- public API

describe('AI panel: the API for other editor modules', () => {
  it('never throws: without a server every call answers with what it can', async () => {
    const { aiAvailability, aiStore, openAiPanel, startAiTask, useAiJob } = await import('../editor/src/ai/api.js');
    const snapshot = aiAvailability();
    expect(snapshot).toMatchObject({ enabled: false, providers: [] });
    // The same call is a promise of the answer once the server was asked (here: it cannot be reached).
    const answer = await snapshot;
    expect(answer).toMatchObject({ enabled: false, loading: false });
    expect(answer.reason).toMatch(/cannot be reached/);
    const started = await startAiTask({ kind: 'avatar-create', context: { project: 'avatars/miko' }, images: ['avatars/miko/source.png'] });
    expect(started).toMatchObject({ error: expect.stringMatching(/cannot be reached/) });
    // No editor session in a unit test: opening the panel does nothing, and says nothing.
    expect(() => openAiPanel()).not.toThrow();
    const Probe = () => {
      const job = useAiJob('unknown');
      return createElement('span', null, `${job.state}|${job.done}|${job.lastStatus}`);
    };
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<span>null|false|null</span>');
    await aiAvailability();
    expect(aiStore.get().status).toBe('error');
  });
});
