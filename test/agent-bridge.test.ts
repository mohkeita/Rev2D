/**
 * The agent runner (src/node/agent): parsing of both providers' JSON-lines streams, command lines,
 * shell-free process start, and jobs (stdin prompts, resume, cancel, timeouts, the one-job rule, logs).
 * Every process started here is a fake agent from test/fixtures/fake-agents; no test calls a real CLI.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../src/api/templates.js';
import {
  AgentError,
  AgentManager,
  LineSplitter,
  assertSafeArgs,
  buildAgentPrompt,
  buildPreamble,
  claudeProvider,
  codexProvider,
  commandFromPath,
  findOnPath,
  listLogFiles,
  logFileName,
  parseNpmShim,
  processAlive,
  registerTaskTemplate,
  resolveCommand,
  rev2dCommandRules,
  rotateLogs,
  taskTemplates,
  type AgentEvent,
  type AgentEventBody,
  type AgentJobInfo,
  type AgentManagerOptions,
  type AgentProvider,
  type AgentProviderId,
  type PromptEnv,
  type ProviderRun,
} from '../src/node/agent/index.js';

const FAKES = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'fake-agents');
const fake = (provider: AgentProviderId, scenario = 'echo') => [process.execPath, path.join(FAKES, `fake-${provider}.mjs`), `--fake=${scenario}`];
const FAKE_COMMANDS = { codex: fake('codex'), claude: fake('claude') };
const WIN = process.platform === 'win32';

const temps: string[] = [];
function tempDir(prefix = 'rev2d-agent-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const managers: AgentManager[] = [];
/** A manager whose providers are the fakes, with its own workspace root and log directory. */
function makeManager(opts: Partial<AgentManagerOptions> = {}): { manager: AgentManager; root: string; logDir: string } {
  const root = opts.root ?? tempDir();
  const logDir = typeof opts.logDir === 'string' ? opts.logDir : tempDir('rev2d-agent-logs-');
  const manager = new AgentManager({ root, logDir, commands: FAKE_COMMANDS, ...opts });
  managers.push(manager);
  return { manager, root, logDir };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function until(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Start a job and wait for its end. */
async function runJob(manager: AgentManager, opts: Parameters<AgentManager['start']>[0]): Promise<{ job: AgentJobInfo; events: AgentEvent[] }> {
  const started = await manager.start(opts);
  const job = await manager.wait(started.id);
  return { job, events: manager.events(job.id).events };
}

const lines = (file: string) => readFileSync(path.join(FAKES, file), 'utf8').split('\n').filter(Boolean);

function parseAll(provider: AgentProvider, file: string) {
  const parser = provider.createParser();
  const parsed = lines(file).map((l) => parser.line(l));
  return { parsed, events: parsed.flatMap((p) => p.events) };
}

/** An event without the fields that are irrelevant for a comparison. */
const brief = (e: AgentEventBody): Record<string, unknown> => ({ ...e });

const run = (over: Partial<ProviderRun> = {}): ProviderRun => ({
  cwd: path.resolve('/work/space'),
  sandbox: 'workspace-write',
  images: [],
  allowImageGeneration: false,
  rev2dBin: path.resolve('/opt/rev2d/bin/rev2d.js'),
  platform: process.platform,
  codexWindowsSandbox: 'config',
  ...over,
});

// ----------------------------------------------------------------------------- parsing

describe('codex stream parsing', () => {
  const { parsed, events } = parseAll(codexProvider, 'codex-full.jsonl');

  it('turns every item type into normalised events', () => {
    const validate = 'node C:/Rev2D/bin/rev2d.js validate hero.r2d.json --json';
    const changes = [
      { path: 'hero.r2d.json', kind: 'update' },
      { path: 'out/head.png', kind: 'add' },
      { path: 'old.r2d.json', kind: 'delete' },
    ];
    expect(events.map(brief)).toEqual([
      { type: 'status', status: 'session', text: 'Codex session 0199f3a1-7c2e-7d43-9b1a-2f6c5d4e3b2a', sessionId: '0199f3a1-7c2e-7d43-9b1a-2f6c5d4e3b2a' },
      { type: 'status', status: 'turn', text: 'the agent is working' },
      { type: 'reasoning', text: '**Planning the edit**\n\nRead the model, then widen the head warp.' },
      { type: 'todo', id: 'item_1', items: [{ text: 'Read the model', done: false }, { text: 'Widen the head warp', done: false }] },
      { type: 'command', id: 'item_2', phase: 'started', status: 'running', command: validate, exitCode: null, output: '', outputTruncated: false },
      { type: 'command', id: 'item_2', phase: 'completed', status: 'completed', command: validate, exitCode: 0, output: '[{"file":"hero.r2d.json","ok":true,"errors":0,"warnings":0}]\n', outputTruncated: false },
      { type: 'todo', id: 'item_1', items: [{ text: 'Read the model', done: true }, { text: 'Widen the head warp', done: false }] },
      { type: 'tool', id: 'item_3', phase: 'started', status: 'running', tool: 'rev2d_render', server: 'rev2d', input: '{"path":"hero.r2d.json","overlay":["bones"]}' },
      {
        type: 'tool',
        id: 'item_3',
        phase: 'completed',
        status: 'completed',
        tool: 'rev2d_render',
        server: 'rev2d',
        input: '{"path":"hero.r2d.json","overlay":["bones"]}',
        result: '[{"type":"text","text":"rendered 512x512"}]',
      },
      { type: 'tool', id: 'item_4', phase: 'completed', status: 'failed', tool: 'rev2d_inspect', server: 'rev2d', input: '{"path":"nope.r2d.json"}', error: 'model file not found' },
      { type: 'tool', id: 'item_5', phase: 'started', status: 'running', tool: 'web_search', input: 'live2d head turn warp grid' },
      { type: 'tool', id: 'item_5', phase: 'completed', status: 'completed', tool: 'web_search', input: 'live2d head turn warp grid' },
      { type: 'file', id: 'item_6', phase: 'started', status: 'running', changes },
      { type: 'file', id: 'item_6', phase: 'completed', status: 'completed', changes },
      {
        type: 'command',
        id: 'item_7',
        phase: 'completed',
        status: 'failed',
        command: 'node C:/Rev2D/bin/rev2d.js render missing.r2d.json',
        exitCode: 1,
        output: 'error: cannot read model file missing.r2d.json\n',
        outputTruncated: false,
      },
      { type: 'error', message: 'command timed out after 120s' },
      { type: 'tool', id: 'item_9', phase: 'completed', status: 'completed', tool: 'image_generation', input: '{"prompt":"closed eye, same style","saved_path":"variants/eye-closed.png"}' },
      { type: 'error', message: 'Reconnecting... 1/5' },
      { type: 'message', text: 'Widened the head warp; `validate` shows 0 errors.\nUncertain: the hair strand roots (머리카락).' },
      { type: 'usage', inputTokens: 48213, cachedInputTokens: 31744, outputTokens: 1582, reasoningTokens: 640 },
    ]);
  });

  it('reports the session id and the usage, and no failure for a completed turn', () => {
    expect(parsed[0].sessionId).toBe('0199f3a1-7c2e-7d43-9b1a-2f6c5d4e3b2a');
    expect(parsed.at(-1)!.usage).toEqual({ inputTokens: 48213, cachedInputTokens: 31744, outputTokens: 1582, reasoningTokens: 640 });
    expect(parsed.some((p) => p.failure !== undefined || p.unknown)).toBe(false);
  });

  it('parses a recorded real session', () => {
    const recorded = parseAll(codexProvider, 'codex-recorded.jsonl');
    expect(recorded.events).toEqual([
      { type: 'status', status: 'session', text: 'Codex session 01a10ab1-0000-7000-8000-00000000c0de', sessionId: '01a10ab1-0000-7000-8000-00000000c0de' },
      { type: 'status', status: 'turn', text: 'the agent is working' },
      { type: 'message', text: 'OK' },
      { type: 'usage', inputTokens: 29260, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0 },
    ]);
    expect(recorded.parsed.some((p) => p.unknown || p.failure !== undefined)).toBe(false);
  });

  it('marks a failed turn, keeps transient errors non-fatal and ignores what it does not know', () => {
    const p = codexProvider.createParser();
    expect(p.line('{"type":"turn.failed","error":{"message":"quota exceeded"}}')).toEqual({ events: [{ type: 'error', message: 'quota exceeded' }], failure: 'quota exceeded' });
    expect(p.line('{"type":"error","message":"Reconnecting... 2/5"}').failure).toBeUndefined();
    for (const junk of ['', 'Reading additional input from stdin...', '[1,2]', '{broken', '{"type":"future.event"}', '{"type":"item.completed"}']) {
      expect(p.line(junk), junk).toEqual({ events: [], unknown: true });
    }
    // A session id is passed back on a command line later: one that looks like a flag is not accepted.
    expect(p.line('{"type":"thread.started","thread_id":"--dangerously-bypass-approvals-and-sandbox"}')).toEqual({ events: [], unknown: true });
    expect(p.line('{"type":"thread.started","thread_id":"a b"}').sessionId).toBeUndefined();
  });

  it('keeps the tail of long command output and cuts long messages', () => {
    const p = codexProvider.createParser();
    const output = `${'x'.repeat(5000)}THE END`;
    const [cmd] = p.line(JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'command_execution', command: 'ls', aggregated_output: output, exit_code: 0, status: 'completed' } })).events;
    expect(cmd).toMatchObject({ type: 'command', outputTruncated: true });
    expect((cmd as { output: string }).output).toHaveLength(4000);
    expect((cmd as { output: string }).output.endsWith('THE END')).toBe(true);
    const [msg] = p.line(JSON.stringify({ type: 'item.completed', item: { id: 'j', type: 'agent_message', text: 'm'.repeat(70_000) } })).events;
    expect(msg).toMatchObject({ type: 'message', truncated: true });
    expect((msg as { text: string }).text).toHaveLength(64_000);
  });
});

describe('claude stream parsing', () => {
  const { parsed, events } = parseAll(claudeProvider, 'claude-full.jsonl');
  const SESSION = '5b0c6f0e-93a4-4b7e-8f55-0a1b2c3d4e5f';
  const final = 'Widened the head warp; validate shows 0 errors.\nUncertain: the hair strand roots (머리카락).';

  it('turns thinking, text, tool calls and their results into normalised events', () => {
    const validate = 'node C:/Rev2D/bin/rev2d.js validate hero.r2d.json --json';
    const hero = 'C:\\work\\hero.r2d.json';
    const notes = 'C:\\work\\out\\notes.txt';
    const readInput = JSON.stringify({ file_path: hero });
    expect(events.map(brief)).toEqual([
      { type: 'status', status: 'session', text: `Claude Code session ${SESSION} (claude-sonnet-4-5)`, sessionId: SESSION },
      { type: 'reasoning', text: 'The person wants a wider head warp. Read the model first.' },
      { type: 'message', text: "I'll read the model first." },
      { type: 'tool', id: 'toolu_01', phase: 'started', status: 'running', tool: 'Read', input: readInput },
      { type: 'tool', id: 'toolu_01', phase: 'completed', status: 'completed', tool: 'Read', input: readInput, result: '     1\t{\n     2\t  "format": "rev2d"\n' },
      { type: 'todo', id: 'toolu_02', items: [{ text: 'Read the model', done: true }, { text: 'Widen the head warp', done: false }] },
      { type: 'command', id: 'toolu_03', phase: 'started', status: 'running', command: validate, exitCode: null, output: '', outputTruncated: false },
      { type: 'command', id: 'toolu_03', phase: 'completed', status: 'completed', command: validate, exitCode: 0, output: '[{"file":"hero.r2d.json","ok":true,"errors":0,"warnings":0}]', outputTruncated: false },
      { type: 'file', id: 'toolu_04', phase: 'started', status: 'running', changes: [{ path: hero, kind: 'update' }] },
      { type: 'file', id: 'toolu_04', phase: 'completed', status: 'completed', changes: [{ path: hero, kind: 'update' }] },
      { type: 'file', id: 'toolu_05', phase: 'started', status: 'running', changes: [{ path: notes, kind: 'add' }] },
      { type: 'file', id: 'toolu_05', phase: 'completed', status: 'completed', changes: [{ path: notes, kind: 'add' }] },
      // Write over an existing file: the result says it was an update.
      { type: 'file', id: 'toolu_06', phase: 'started', status: 'running', changes: [{ path: hero, kind: 'add' }] },
      { type: 'file', id: 'toolu_06', phase: 'completed', status: 'completed', changes: [{ path: hero, kind: 'update' }] },
      { type: 'command', id: 'toolu_07', phase: 'started', status: 'running', command: 'node C:/Rev2D/bin/rev2d.js render missing.r2d.json', exitCode: null, output: '', outputTruncated: false },
      {
        type: 'command',
        id: 'toolu_07',
        phase: 'completed',
        status: 'failed',
        command: 'node C:/Rev2D/bin/rev2d.js render missing.r2d.json',
        exitCode: 1,
        output: 'Exit code 1\nerror: cannot read model file missing.r2d.json',
        outputTruncated: false,
      },
      { type: 'tool', id: 'toolu_08', phase: 'started', status: 'running', tool: 'rev2d_render', server: 'rev2d', input: '{"path":"hero.r2d.json"}' },
      { type: 'tool', id: 'toolu_08', phase: 'completed', status: 'completed', tool: 'rev2d_render', server: 'rev2d', input: '{"path":"hero.r2d.json"}', result: 'rendered 512x512\n[image]' },
      { type: 'command', id: 'toolu_09', phase: 'started', status: 'running', command: 'curl https://example.com', exitCode: null, output: '', outputTruncated: false },
      {
        type: 'command',
        id: 'toolu_09',
        phase: 'completed',
        status: 'failed',
        command: 'curl https://example.com',
        exitCode: null,
        output: "Claude requested permissions to use Bash, but you haven't granted it yet.",
        outputTruncated: false,
      },
      { type: 'status', status: 'retry', text: 'the API request is retried (attempt 1): overloaded_error' },
      { type: 'message', text: final },
      { type: 'usage', inputTokens: 32 + 5120 + 40960, cachedInputTokens: 40960, outputTokens: 1204, reasoningTokens: 0, costUsd: 0.0931 },
    ]);
  });

  it('reports the session, the final answer and the usage; hook and rate-limit lines are only raw log', () => {
    expect(parsed.find((p) => p.sessionId)?.sessionId).toBe(SESSION);
    expect(parsed.at(-1)).toMatchObject({ finalMessage: final, sessionId: SESSION });
    expect(parsed.at(-1)!.failure).toBeUndefined();
    expect(parsed.filter((p) => p.unknown)).toHaveLength(2); // hook_started, rate_limit_event
  });

  it('parses a recorded real session', () => {
    const recorded = parseAll(claudeProvider, 'claude-recorded.jsonl');
    expect(recorded.events).toEqual([
      { type: 'status', status: 'session', text: 'Claude Code session 8901b2bb-0000-4000-8000-00000000c0de (claude-opus-5-5)', sessionId: '8901b2bb-0000-4000-8000-00000000c0de' },
      { type: 'message', text: 'OK' },
      { type: 'usage', inputTokens: 6673, cachedInputTokens: 3005, outputTokens: 4, reasoningTokens: 0, costUsd: 0.030017 },
    ]);
    expect(recorded.parsed.at(-1)).toMatchObject({ finalMessage: 'OK', sessionId: '8901b2bb-0000-4000-8000-00000000c0de' });
    expect(recorded.parsed.filter((p) => p.unknown)).toHaveLength(1); // rate_limit_event
    expect(recorded.parsed.some((p) => p.failure !== undefined)).toBe(false);
  });

  it('fails the job for an error result and shows an answer that only the result line carries', () => {
    const p = claudeProvider.createParser();
    const auth = p.line('{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login","session_id":"s1","usage":{}}');
    expect(auth.failure).toBe('Invalid API key · Please run /login');
    expect(auth.events.map((e) => e.type)).toEqual(['usage', 'error']);
    expect(claudeProvider.isAuthError(auth.failure!)).toBe(true);
    const turns = p.line('{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s1"}');
    expect(turns.failure).toBe('Claude Code ended with error_max_turns');
    const only = claudeProvider.createParser().line('{"type":"result","subtype":"success","is_error":false,"result":"42","session_id":"s1"}');
    expect(only.events[0]).toEqual({ type: 'message', text: '42' });
    expect(only.finalMessage).toBe('42');
    for (const junk of ['', 'not json', '{"type":"stream_event"}', '{"type":"system","subtype":"init","session_id":"--resume"}']) {
      expect(claudeProvider.createParser().line(junk), junk).toEqual({ events: [], unknown: true });
    }
  });
});

// ----------------------------------------------------------------------------- command lines

describe('command lines', () => {
  const cwd = path.resolve('/work/space');

  it('codex: a new session reads the prompt from stdin, with an explicit sandbox', () => {
    expect(codexProvider.buildArgs(run())).toEqual(['exec', '--json', '--color', 'never', '-s', 'workspace-write', '--skip-git-repo-check', '-C', cwd, '--disable', 'image_generation', '-']);
    const full = codexProvider.buildArgs(run({ sandbox: 'read-only', images: ['/w/a b.png', '/w/c.png'], model: 'gpt-5-codex', effort: 'low', allowImageGeneration: true }));
    expect(full).toEqual([
      'exec',
      // Images first: "-i" takes several values, so a flag must follow before the "-" prompt.
      '-i',
      '/w/a b.png',
      '-i',
      '/w/c.png',
      '--json',
      '--color',
      'never',
      '-s',
      'read-only',
      '--skip-git-repo-check',
      '-C',
      cwd,
      '-m',
      'gpt-5-codex',
      '-c',
      'model_reasoning_effort="low"',
      '--enable',
      'image_generation',
      '-',
    ]);
  });

  it('codex: a follow-up resumes the thread, with the exec options before "resume"', () => {
    const args = codexProvider.buildArgs(run({ resumeSession: '0199aaaa-0000-7000-8000-000000000001', images: ['/w/x.png'], effort: 'high' }));
    expect(args).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '-s',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      cwd,
      '-c',
      'model_reasoning_effort="high"',
      '--disable',
      'image_generation',
      'resume',
      '-i',
      '/w/x.png',
      '--json',
      '0199aaaa-0000-7000-8000-000000000001',
      '-',
    ]);
    // -s and -C are not options of "resume": they must come before it.
    expect(args.indexOf('-s')).toBeLessThan(args.indexOf('resume'));
    expect(args.indexOf('-C')).toBeLessThan(args.indexOf('resume'));
  });

  it('claude: workspace-write accepts edits and allows only the Rev2D CLI as a command', () => {
    const help = '--restricted --tools <tools...> --strict-mcp-config --permission-prompts <target> --effort <level> "dontAsk"';
    const rules = rev2dCommandRules(run().rev2dBin);
    const bin = run().rev2dBin.split('\\').join('/');
    expect(rules).toEqual(WIN ? [`Bash(node ${bin} *)`, `Bash(node "${bin}" *)`, `PowerShell(node ${bin} *)`, `PowerShell(node "${bin}" *)`] : [`Bash(node ${bin} *)`, `Bash(node "${bin}" *)`]);
    expect(claudeProvider.buildArgs(run({ help, model: 'sonnet', effort: 'minimal', resumeSession: 'abc-123' }))).toEqual([
      '-p',
      '--allowedTools',
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'TodoWrite',
      ...rules,
      '--tools',
      WIN ? 'Read,Glob,Grep,Edit,Write,TodoWrite,Bash,PowerShell' : 'Read,Glob,Grep,Edit,Write,TodoWrite,Bash',
      '--permission-mode',
      'acceptEdits',
      '--restricted',
      '--strict-mcp-config',
      '--permission-prompts',
      'none',
      '--model',
      'sonnet',
      '--effort',
      'low',
      '--resume',
      'abc-123',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
  });

  it('claude: read-only offers the read tools only; an old version gets only the flags it has', () => {
    const help = '--restricted --tools <tools...> --strict-mcp-config --permission-prompts <target> --effort <level> "dontAsk"';
    expect(claudeProvider.buildArgs(run({ help, sandbox: 'read-only' }))).toEqual([
      '-p',
      '--allowedTools',
      'Read',
      'Glob',
      'Grep',
      '--tools',
      'Read,Glob,Grep',
      '--permission-mode',
      'dontAsk',
      '--restricted',
      '--strict-mcp-config',
      '--permission-prompts',
      'none',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    // No help text (or one without the newer flags): plan mode, no --effort.
    expect(claudeProvider.buildArgs(run({ sandbox: 'read-only', effort: 'high' }))).toEqual(['-p', '--allowedTools', 'Read', 'Glob', 'Grep', '--permission-mode', 'plan', '--output-format', 'stream-json', '--verbose']);
    expect(claudeProvider.promptSuffix!(run({ images: [path.resolve('/w/ref one.png')] }))).toContain(`- ${path.resolve('/w/ref one.png').split('\\').join('/')}`);
    expect(claudeProvider.promptSuffix!(run())).toBe('');
  });

  it('never contains a bypass flag or the full-access sandbox, whatever the options', () => {
    const help = '--restricted --tools <tools...> --strict-mcp-config --permission-prompts <target> --effort <level> "dontAsk"';
    for (const provider of [codexProvider, claudeProvider]) {
      for (const sandbox of ['read-only', 'workspace-write'] as const) {
        for (const resumeSession of [undefined, 'abc-123']) {
          for (const allowImageGeneration of [false, true]) {
            const args = provider.buildArgs(run({ sandbox, resumeSession, allowImageGeneration, help, model: 'm', effort: 'max', images: ['/w/danger-full-access/a.png'] }));
            expect(() => assertSafeArgs(args)).not.toThrow();
            expect(args.join(' ')).not.toMatch(/--dangerously|bypassPermissions|--yolo|-s danger-full-access/);
            expect(args.filter((a) => a === 'danger-full-access')).toEqual([]);
          }
        }
      }
    }
  });

  it('assertSafeArgs refuses every way to lift the sandbox', () => {
    for (const bad of [
      ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'],
      ['exec', '--dangerously-bypass-hook-trust', '-'],
      ['exec', '-s', 'danger-full-access', '-'],
      ['exec', '--sandbox=danger-full-access', '-'],
      ['exec', '-c', 'sandbox_mode="danger-full-access"', '-'],
      ['exec', '-c', 'approval_policy="never"', '-'],
      ['exec', '--config', 'shell_environment_policy.inherit=all', '-'],
      ['-p', '--dangerously-skip-permissions'],
      ['-p', '--allow-dangerously-skip-permissions'],
      ['-p', '--permission-mode', 'bypassPermissions'],
      ['-p', '--permission-mode=bypassPermissions'],
      ['exec', '--yolo'],
    ]) {
      expect(() => assertSafeArgs(bad), bad.join(' ')).toThrow(/refusing/);
    }
    expect(() => assertSafeArgs(['exec', '-c', 'model_reasoning_effort="low"', '-s', 'read-only', '-'])).not.toThrow();
  });
});

// ----------------------------------------------------------------------------- finding and starting programs

/** The batch file npm writes for a global package's command (cmd-shim). */
const npmShim = (script: string) =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
    '',
  ].join('\r\n');

/**
 * A directory with a `codex` command as the platform installs it: on Windows an npm .cmd shim around
 * node_modules/@fake/codex/bin/codex.js, elsewhere an executable script. Both run the fake agent.
 */
function installFakeCli(name: 'codex' | 'claude'): string {
  const bin = tempDir('rev2d agent bin & more ');
  // No top-level await: these wrappers are CommonJS (a .js file without a package.json, a script without an extension).
  const wrapper = `import(${JSON.stringify(pathToFileURL(path.join(FAKES, `fake-${name}.mjs`)).href)});\n`;
  if (WIN) {
    const dir = path.join(bin, 'node_modules', '@fake', name, 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.js`), wrapper);
    writeFileSync(path.join(bin, `${name}.cmd`), npmShim(`node_modules\\@fake\\${name}\\bin\\${name}.js`));
  } else {
    // The isolated PATH must also provide the interpreter of this env-node script.
    symlinkSync(process.execPath, path.join(bin, 'node'));
    const file = path.join(bin, name);
    writeFileSync(file, `#!/usr/bin/env node\n${wrapper}`);
    chmodSync(file, 0o755);
  }
  return bin;
}

describe('finding a CLI without a shell', () => {
  it('reads an npm command shim', () => {
    expect(parseNpmShim(npmShim('node_modules\\@openai\\codex\\bin\\codex.js'), 'C:\\npm')).toEqual({ target: 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', node: true });
    expect(parseNpmShim('@"%~dp0\\node_modules\\tool\\bin\\tool.exe" %*', 'C:\\npm')).toEqual({ target: 'C:\\npm\\node_modules\\tool\\bin\\tool.exe', node: false });
    // A wrapper around something that is neither a program nor a Node script is not started (see commandFromPath).
    expect(parseNpmShim('@echo off\r\npowershell -File "%~dp0\\run.ps1" %*\r\n', 'C:\\npm')).toEqual({ target: 'C:\\npm\\run.ps1', node: false });
    expect(parseNpmShim('@echo off\r\ncalc.exe %*\r\n', 'C:\\npm')).toBeNull();
    expect(parseNpmShim('', 'C:\\npm')).toBeNull();
  });

  it('runs a .js entry script through Node and leaves other programs alone', () => {
    const script = path.join(FAKES, 'fake-codex.mjs');
    expect(commandFromPath(script)).toEqual({ file: process.execPath, args: [script], source: script });
    expect(commandFromPath('/usr/local/bin/codex', { platform: 'linux' })).toEqual({ file: '/usr/local/bin/codex', args: [], source: '/usr/local/bin/codex' });
  });

  it('searches absolute PATH entries only (never the current directory)', () => {
    const bin = installFakeCli('codex');
    const sep = WIN ? ';' : ':';
    const found = findOnPath('codex', { env: { PATH: ['', '.', 'relative/dir', bin].join(sep), PATHEXT: '.COM;.EXE;.BAT;.CMD' } });
    expect(found).toBe(path.join(bin, WIN ? 'codex.cmd' : 'codex'));
    expect(findOnPath('codex', { env: { PATH: ['', '.', 'relative/dir'].join(sep) } })).toBeNull();
    expect(findOnPath('no-such-agent-cli', { env: { PATH: bin } })).toBeNull();
    expect(resolveCommand('no-such-agent-cli', { env: { PATH: bin } })).toBeNull();
  });

  it.runIf(WIN)('Windows: resolves an npm .cmd shim to node + its script, and refuses any other batch file', () => {
    const bin = installFakeCli('codex');
    const resolved = resolveCommand('codex', { env: { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' } });
    expect(resolved).toEqual({ file: process.execPath, args: [path.join(bin, 'node_modules', '@fake', 'codex', 'bin', 'codex.js')], source: path.join(bin, 'codex.cmd') });
    const evil = path.join(bin, 'evil.cmd');
    writeFileSync(evil, '@echo off\r\ncalc.exe %*\r\n');
    expect(() => commandFromPath(evil)).toThrow(AgentError);
    expect(() => commandFromPath(evil)).toThrow(/cannot start safely/);
    // A shim whose script is gone is refused too (nothing is guessed), and so is a wrapper around a non-Node script.
    const stale = path.join(bin, 'stale.cmd');
    writeFileSync(stale, npmShim('node_modules\\gone\\cli.js'));
    expect(() => commandFromPath(stale)).toThrow(/cannot start safely/);
    const ps = path.join(bin, 'ps.cmd');
    writeFileSync(path.join(bin, 'run.ps1'), 'Write-Output hi');
    writeFileSync(ps, '@echo off\r\npowershell -File "%~dp0\\run.ps1" %*\r\n');
    expect(() => commandFromPath(ps)).toThrow(/cannot start safely/);
  });

  it.runIf(!WIN)('POSIX: finds an executable script and skips files that are not executable', () => {
    const bin = installFakeCli('codex');
    expect(resolveCommand('codex', { env: { PATH: bin } })).toEqual({ file: path.join(bin, 'codex'), args: [], source: path.join(bin, 'codex') });
    writeFileSync(path.join(bin, 'plain'), 'not executable');
    expect(findOnPath('plain', { env: { PATH: bin } })).toBeNull();
  });
});

describe('LineSplitter', () => {
  const collect = (chunks: Array<Buffer | string>, max?: number) => {
    const out: Array<[string, boolean]> = [];
    const s = new LineSplitter((line, truncated) => out.push([line, truncated]), max);
    for (const c of chunks) s.push(Buffer.from(c));
    s.end();
    return out;
  };

  it('joins chunks into lines, also inside multi-byte characters, and drops CR', () => {
    const bytes = Buffer.from('{"a":"머리"}\r\nsecond ✓\nlast without newline');
    const pieces: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 3) pieces.push(bytes.subarray(i, i + 3));
    expect(collect(pieces)).toEqual([
      ['{"a":"머리"}', false],
      ['second ✓', false],
      ['last without newline', false],
    ]);
    expect(collect(['a\n\nb\n'])).toEqual([
      ['a', false],
      ['', false],
      ['b', false],
    ]);
    expect(collect([])).toEqual([]);
  });

  it('cuts an endless line instead of buffering it', () => {
    expect(collect(['x'.repeat(50), 'y'.repeat(50), '\nok\n'], 20)).toEqual([
      ['x'.repeat(20), true],
      ['ok', false],
    ]);
  });
});

// ----------------------------------------------------------------------------- the preamble

describe('preamble and task templates', () => {
  const root = path.resolve('/work/space');
  const env = (over: Partial<PromptEnv> = {}): PromptEnv => ({
    provider: 'codex',
    root,
    cwd: root,
    rev2dBin: path.resolve('/opt/rev2d/bin/rev2d.js'),
    sandbox: 'workspace-write',
    allowImageGeneration: false,
    images: [],
    ...over,
  });
  const slashed = (p: string) => p.split(path.sep).join('/');

  it('tells the agent where it is, how to call Rev2D and the rules', () => {
    const text = buildPreamble(env({ file: path.join(root, 'models', 'hero.r2d.json'), images: [path.join(root, 'ref.png')] }));
    expect(text).toContain(`- Workspace root: ${slashed(root)}`);
    expect(text).toContain(`- Working directory: ${slashed(root)} (the workspace root)`);
    expect(text).toContain('- Model open in the editor: models/hero.r2d.json');
    expect(text).toContain('- Attached image: ref.png');
    expect(text).toContain(`- node ${slashed(path.resolve('/opt/rev2d/bin/rev2d.js'))} <command> ...`);
    expect(text).toContain('docs agents');
    expect(text).toMatch(/1\. Stay inside the workspace root\./);
    expect(text).toMatch(/Never upload them or send them to a web service, and never copy them outside the workspace\./);
    expect(text).toContain('Image generation is NOT allowed in this job');
    expect(text).toMatch(/Look at the images you produce/);
    expect(text).toMatch(/what is uncertain or still wrong/);
  });

  it('allows image generation only when the job says so, and only the built-in generator', () => {
    const allowed = buildPreamble(env({ allowImageGeneration: true }));
    expect(allowed).toContain('Image generation is allowed in this job, but ONLY with your own built-in image generation tool');
    expect(allowed).not.toContain('NOT allowed');
    expect(buildPreamble(env({ allowImageGeneration: true, sandbox: 'read-only' }))).toContain('the job is read-only');
    expect(buildPreamble(env({ sandbox: 'read-only' }))).toContain('This job is read-only: do not create or change files.');
  });

  it('names the project folder, quotes a path with spaces, and has a short form for follow-ups', () => {
    const project = path.join(root, 'avatars', 'miko');
    const text = buildPreamble(env({ cwd: project, rev2dBin: path.resolve('/opt/my tools/rev2d/bin/rev2d.js') }));
    expect(text).toContain(`- Project folder (your working directory): ${slashed(project)}`);
    expect(text).toContain(`- node "${slashed(path.resolve('/opt/my tools/rev2d/bin/rev2d.js'))}" <command> ...`);
    const follow = buildPreamble(env({ allowImageGeneration: true }), { followUp: true });
    expect(follow).toMatch(/^Follow-up message in the same Rev2D editor session/);
    expect(follow).toContain("Never upload the person's images");
    expect(follow).toContain('Image generation is allowed');
    expect(follow.length).toBeLessThan(buildPreamble(env()).length / 2);
  });

  it('builds freeform prompts and lets later steps register task templates', () => {
    const built = buildAgentPrompt({ prompt: '  Make the head turn further.\nKeep the eyes.  ', env: env() });
    expect(built.task).toBe('Make the head turn further.\nKeep the eyes.');
    expect(built.title).toBe('Make the head turn further.');
    expect(built.text.endsWith('\n\nRequest\nMake the head turn further.\nKeep the eyes.\n')).toBe(true);
    expect(built.text.startsWith('You were started from inside the Rev2D editor')).toBe(true);
    expect(buildAgentPrompt({ prompt: 'x'.repeat(200), env: env() }).title).toHaveLength(80);

    registerTaskTemplate({
      kind: 'test-rename',
      title: 'Rename the model',
      description: 'Sets meta.name.',
      needsPrompt: false,
      build: ({ context, env: e }) => {
        if (typeof context.name !== 'string') throw new AgentError('invalid', 'the "test-rename" task needs context.name', 'send {"context": {"name": "..."}}');
        return `Set meta.name of the open model to ${JSON.stringify(context.name)} (sandbox: ${e.sandbox}).`;
      },
    });
    expect(taskTemplates().map((t) => t.kind)).toEqual(expect.arrayContaining(['freeform', 'test-rename']));
    const task = buildAgentPrompt({ kind: 'test-rename', context: { name: 'Miko' }, env: env() });
    expect(task.task).toBe('Set meta.name of the open model to "Miko" (sandbox: workspace-write).');
    expect(task.title).toBe(task.task);
    expect(() => buildAgentPrompt({ kind: 'test-rename', env: env() })).toThrow(/needs context\.name/);
    expect(() => buildAgentPrompt({ kind: 'nope', prompt: 'x', env: env() })).toThrow(/unknown task kind "nope"/);
    expect(() => buildAgentPrompt({ prompt: '   ', env: env() })).toThrow(/needs a prompt/);
    expect(() => registerTaskTemplate({ kind: 'Bad Kind', title: '', description: '', needsPrompt: false, build: () => '' })).toThrow(/lower-case/);
  });
});

// ----------------------------------------------------------------------------- jobs

/** What the "echo" fakes report back in their final message. */
interface Echo {
  argv: string[];
  prompt: string;
  cwd: string;
  resumed: boolean;
}
const echoOf = (job: AgentJobInfo): Echo => JSON.parse(job.finalMessage!) as Echo;
/** Same directory, whatever the spelling (links, 8.3 short names, letter case). */
const sameDir = (a: string, b: string) => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

describe('jobs', () => {
  let shared: ReturnType<typeof makeManager>;
  const sharedManagers: AgentManager[] = [];

  beforeAll(() => {
    // One manager for the tests that only differ in their prompt: the CLIs are detected once.
    const root = tempDir();
    const logDir = tempDir('rev2d-agent-logs-');
    shared = { manager: new AgentManager({ root, logDir, commands: FAKE_COMMANDS }), root, logDir };
    sharedManagers.push(shared.manager);
  });

  afterAll(async () => {
    await Promise.all(sharedManagers.map((m) => m.close()));
  });

  it('detects the providers and their versions', async () => {
    const providers = await shared.manager.providers();
    expect(providers).toEqual([
      // On Windows the Codex entry also says which sandbox implementation the bridge asks for.
      { id: 'codex', name: 'Codex CLI', available: true, version: '0.0.0-fake', features: { imageGeneration: true }, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], ...(WIN ? { windowsSandbox: 'config' } : {}) },
      { id: 'claude', name: 'Claude Code', available: true, version: '0.0.0-fake', features: { imageGeneration: false }, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ]);
  });

  it('says how to install a CLI that is missing, and refuses to start a job with it', async () => {
    const emptyBin = tempDir();
    const { manager, root } = makeManager({ commands: { claude: path.join(emptyBin, 'claude.exe') }, env: { PATH: emptyBin } });
    const [codex, claude] = await manager.providers();
    expect(codex).toMatchObject({ id: 'codex', available: false, version: null });
    expect(codex.hint).toMatch(/"codex" was not found on PATH: install the Codex CLI/);
    expect(claude).toMatchObject({ id: 'claude', available: false, version: null });
    expect(claude.hint).toContain('does not exist');
    const err = await manager.start({ provider: 'codex', prompt: 'hi', cwd: root }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ code: 'unavailable', message: 'Codex CLI is not available' });
    expect(manager.list()).toEqual([]);
  });

  it('runs a whole Codex session: states, ordered events, final message, usage, session id', async () => {
    const seen: Array<[string, string]> = [];
    const off = shared.manager.subscribe((job, event) => seen.push([job.state, event.type]));
    const started = await shared.manager.start({ provider: 'codex', prompt: 'Widen the head warp. [[fake:full]]', cwd: shared.root });
    expect(started).toMatchObject({ provider: 'codex', kind: 'freeform', state: 'queued', title: 'Widen the head warp. [[fake:full]]', sandbox: 'workspace-write', resumeOf: null, conversation: started.id, lastSeq: 1 });
    expect(shared.manager.activeJob).toBe(started.id);
    const job = await shared.manager.wait(started.id);
    off();
    expect(job).toMatchObject({
      state: 'done',
      exitCode: 0,
      error: null,
      sessionId: '0199f3a1-7c2e-7d43-9b1a-2f6c5d4e3b2a',
      finalMessage: 'Widened the head warp; `validate` shows 0 errors.\nUncertain: the hair strand roots (머리카락).',
      usage: { inputTokens: 48213, cachedInputTokens: 31744, outputTokens: 1582, reasoningTokens: 640 },
    });
    expect(shared.manager.activeJob).toBeNull();
    expect(job.startedAt! >= job.createdAt && job.endedAt! >= job.startedAt!).toBe(true);
    const { events, firstSeq, lastSeq } = shared.manager.events(job.id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect([firstSeq, lastSeq]).toEqual([1, events.length]);
    expect(job.lastSeq).toBe(events.length);
    expect(events.every((e) => !Number.isNaN(Date.parse(e.time)))).toBe(true);
    // queued, running, then the provider's 20 events (see the parsing test), then done.
    expect(events.map((e) => e.type)).toEqual([
      'status',
      'status',
      'status',
      'status',
      'reasoning',
      'todo',
      'command',
      'command',
      'todo',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'file',
      'file',
      'command',
      'error',
      'tool',
      'error',
      'message',
      'usage',
      'done',
    ]);
    expect(events.slice(0, 2)).toMatchObject([{ status: 'queued' }, { status: 'running' }]);
    expect(events.at(-1)).toMatchObject({ type: 'done', state: 'done', reason: 'completed', exitCode: 0, message: job.finalMessage });
    expect(shared.manager.events(job.id, 20).events.map((e) => e.seq)).toEqual([21, 22, 23]);
    // Listeners saw every event, with the job state at that moment.
    expect(seen.map(([, type]) => type)).toEqual(events.map((e) => e.type));
    expect(seen[0][0]).toBe('queued');
    expect(seen[1][0]).toBe('running');
    expect(seen.at(-1)![0]).toBe('done');
    expect(shared.manager.prompt(job.id)).toBe('Widen the head warp. [[fake:full]]');
  });

  it('runs a whole Claude Code session', async () => {
    const { job, events } = await runJob(shared.manager, { provider: 'claude', prompt: 'Widen the head warp. [[fake:full]]', cwd: shared.root, sandbox: 'read-only' });
    expect(job).toMatchObject({
      state: 'done',
      exitCode: 0,
      sandbox: 'read-only',
      sessionId: '5b0c6f0e-93a4-4b7e-8f55-0a1b2c3d4e5f',
      finalMessage: 'Widened the head warp; validate shows 0 errors.\nUncertain: the hair strand roots (머리카락).',
      usage: { inputTokens: 46112, cachedInputTokens: 40960, outputTokens: 1204, reasoningTokens: 0, costUsd: 0.0931 },
    });
    expect(events.filter((e) => e.type === 'command').map((e) => (e.type === 'command' ? [e.id, e.phase, e.status, e.exitCode] : null))).toEqual([
      ['toolu_03', 'started', 'running', null],
      ['toolu_03', 'completed', 'completed', 0],
      ['toolu_07', 'started', 'running', null],
      ['toolu_07', 'completed', 'failed', 1],
      ['toolu_09', 'started', 'running', null],
      ['toolu_09', 'completed', 'failed', null],
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', state: 'done', message: job.finalMessage });
  });

  const NASTY = [
    'Say "hi" & run `calc.exe` | echo %PATH% ^ > out.txt; $(whoami) \'single\' \\ end',
    '  second line with tabs\tand trailing spaces  ',
    '한국어 日本語 émoji 🎨 — “quotes”',
    '--dangerously-bypass-approvals-and-sandbox -s danger-full-access',
    '',
    'last line',
  ].join('\n');

  for (const provider of ['codex', 'claude'] as const) {
    it(`${provider}: the prompt arrives on stdin exactly as written, never as an argument`, async () => {
      const image = path.join(shared.root, 'ref pics & more', 'bust 100%.png');
      mkdirSync(path.dirname(image), { recursive: true });
      writeFileSync(image, 'png');
      const { job } = await runJob(shared.manager, { provider, prompt: NASTY, cwd: shared.root, images: [image], model: 'some-model_1.5', effort: 'low' });
      expect(job.state, JSON.stringify(job.error)).toBe('done');
      const echo = echoOf(job);
      // Preamble, then the request, byte for byte.
      expect(echo.prompt.startsWith('You were started from inside the Rev2D editor')).toBe(true);
      expect(echo.prompt).toContain(`\n\nRequest\n${NASTY}\n`);
      expect(echo.prompt).toContain('Image generation is NOT allowed in this job');
      expect(echo.argv.join('\n')).not.toContain('calc.exe');
      expect(echo.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(echo.argv).not.toContain('danger-full-access');
      expect(sameDir(echo.cwd, shared.root)).toBe(true);
      expect(echo.resumed).toBe(false);
      if (provider === 'codex') {
        // The image path with a space, "&" and "%" is one argument.
        expect(echo.argv.slice(0, 3)).toEqual(['exec', '-i', image]);
        expect(echo.argv.at(-1)).toBe('-');
        expect(echo.argv).toEqual(expect.arrayContaining(['-s', 'workspace-write', '-m', 'some-model_1.5', '-c', 'model_reasoning_effort="low"', '--disable', 'image_generation']));
      } else {
        expect(echo.prompt).toContain(`- ${image.split('\\').join('/')}\n`);
        expect(echo.argv).toEqual(expect.arrayContaining(['-p', '--model', 'some-model_1.5', '--effort', 'low', '--permission-mode', 'acceptEdits', '--restricted', '--strict-mcp-config']));
      }
    });
  }

  it('starts a CLI found on PATH as the platform installs it (npm .cmd shim / executable script), without a shell', async () => {
    const bin = installFakeCli('codex');
    const root = tempDir('rev2d agent ws & co ');
    // Only the fake's directory is on PATH: the real CLIs cannot be found.
    const { manager } = makeManager({ root, commands: {}, env: { ...process.env, PATH: bin, Path: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD', REV2D_AGENT_CODEX: '', REV2D_AGENT_CLAUDE: '' } });
    const providers = await manager.providers();
    expect(providers[0]).toMatchObject({ id: 'codex', available: true, version: '0.0.0-fake' });
    expect(providers[1]).toMatchObject({ id: 'claude', available: false });
    const { job } = await runJob(manager, { provider: 'codex', prompt: NASTY, cwd: root });
    expect(job.state, JSON.stringify(job.error)).toBe('done');
    const echo = echoOf(job);
    expect(echo.prompt).toContain(`\n\nRequest\n${NASTY}\n`);
    expect(sameDir(echo.cwd, root)).toBe(true);
    expect(echo.argv).toEqual(['exec', '--json', '--color', 'never', '-s', 'workspace-write', '--skip-git-repo-check', '-C', root, '--disable', 'image_generation', '-']);
  });

  it('uses the executable named by REV2D_AGENT_CODEX instead of PATH', async () => {
    const empty = tempDir();
    const { manager, root } = makeManager({ commands: {}, env: { ...process.env, PATH: empty, Path: empty, REV2D_AGENT_CODEX: path.join(FAKES, 'fake-codex.mjs'), REV2D_AGENT_CLAUDE: '' } });
    const { job } = await runJob(manager, { provider: 'codex', prompt: 'hello', cwd: root });
    expect(job.state, JSON.stringify(job.error)).toBe('done');
    expect(echoOf(job).argv[0]).toBe('exec');
  });

  it('a follow-up resumes the provider session of the finished job', async () => {
    const first = await runJob(shared.manager, { provider: 'codex', prompt: 'first', cwd: shared.root, sandbox: 'read-only', model: 'm1', effort: 'high', allowImageGeneration: true });
    expect(first.job).toMatchObject({ state: 'done', sessionId: '0199aaaa-0000-7000-8000-000000000001', allowImageGeneration: true });
    const started = await shared.manager.message(first.job.id, 'and again');
    expect(started).toMatchObject({ resumeOf: first.job.id, conversation: first.job.id, sessionId: first.job.sessionId, provider: 'codex', sandbox: 'read-only', model: 'm1', effort: 'high', allowImageGeneration: true });
    const second = await shared.manager.wait(started.id);
    const echo = echoOf(second);
    expect(echo.resumed).toBe(true);
    expect(echo.argv).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '-s',
      'read-only',
      '--skip-git-repo-check',
      '-C',
      shared.root,
      '-m',
      'm1',
      '-c',
      'model_reasoning_effort="high"',
      '--enable',
      'image_generation',
      'resume',
      '--json',
      '0199aaaa-0000-7000-8000-000000000001',
      '-',
    ]);
    // The short preamble of a follow-up, then the message.
    expect(echo.prompt.startsWith('Follow-up message in the same Rev2D editor session.')).toBe(true);
    expect(echo.prompt.endsWith('\n\nMessage\nand again\n')).toBe(true);
    // A third turn continues the same conversation; image generation can be switched per message.
    const third = await shared.manager.wait((await shared.manager.message(second.id, 'third', { allowImageGeneration: false })).id);
    expect(third).toMatchObject({ resumeOf: second.id, conversation: first.job.id, allowImageGeneration: false });
    expect(echoOf(third).argv).toEqual(expect.arrayContaining(['--disable', 'image_generation', 'resume']));

    const claude = await runJob(shared.manager, { provider: 'claude', prompt: 'first', cwd: shared.root });
    const again = await shared.manager.wait((await shared.manager.message(claude.job.id, 'more')).id);
    const argv = echoOf(again).argv;
    expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2)).toEqual(['--resume', '5b0c6f0e-0000-4000-8000-000000000001']);
    expect(again.sessionId).toBe('5b0c6f0e-0000-4000-8000-000000000001');
  });

  it('refuses follow-ups that cannot work', async () => {
    const crashed = await runJob(shared.manager, { provider: 'codex', prompt: '[[fake:crash]]', cwd: shared.root });
    expect(crashed.job.sessionId).toBeNull();
    await expect(shared.manager.message(crashed.job.id, 'again')).rejects.toMatchObject({ code: 'not-resumable', hint: 'start a new job instead' });
    await expect(shared.manager.message('nope', 'again').catch((e: unknown) => e)).resolves.toMatchObject({ code: 'unknown-job' });
    const done = await runJob(shared.manager, { provider: 'codex', prompt: 'x', cwd: shared.root });
    await expect(shared.manager.start({ provider: 'claude', prompt: 'x', cwd: shared.root, resumeOf: done.job.id })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('runs one job at a time; cancel kills the whole process tree and frees the slot', async () => {
    const { manager, root } = makeManager();
    const first = await manager.start({ provider: 'codex', prompt: 'work forever [[fake:hang]]', cwd: root });
    const busy = await manager.start({ provider: 'claude', prompt: 'second', cwd: root }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(AgentError);
    expect(busy).toMatchObject({ code: 'busy', extra: { job: first.id } });
    expect((busy as AgentError).message).toMatch(/another agent job is (queued|running)/);
    expect((busy as AgentError).hint).toContain('cancel');
    await expect(manager.message(first.id, 'follow-up')).rejects.toMatchObject({ code: 'busy' });
    expect(manager.list().map((j) => j.id)).toEqual([first.id]);

    // The fake started a process of its own: both must be gone after the cancel.
    await until(() => manager.get(first.id)!.finalMessage !== null, 'the fake to report its pids');
    const { pid, child } = JSON.parse(manager.get(first.id)!.finalMessage!) as { pid: number; child: number };
    expect(processAlive(pid)).toBe(true);
    expect(processAlive(child)).toBe(true);
    const cancelled = await manager.cancel(first.id);
    expect(cancelled).toMatchObject({ state: 'cancelled', error: { message: 'the job was cancelled' } });
    expect(manager.events(first.id).events.at(-1)).toMatchObject({ type: 'done', state: 'cancelled', reason: 'cancelled' });
    await until(() => !processAlive(pid) && !processAlive(child), 'the agent and the process it started to be gone');
    // Cancelling again changes nothing.
    expect((await manager.cancel(first.id)).state).toBe('cancelled');
    expect(manager.activeJob).toBeNull();

    const next = await runJob(manager, { provider: 'claude', prompt: 'second', cwd: root });
    expect(next.job.state).toBe('done');
    expect(manager.list().map((j) => j.id)).toEqual([next.job.id, first.id]);
  });

  it('cancels a job that is still queued, and close() stops the running job', async () => {
    const { manager, root } = makeManager();
    await manager.providers(); // the lookup is done: start() resolves with the job still queued
    const started = await manager.start({ provider: 'codex', prompt: 'never runs [[fake:hang]]', cwd: root });
    expect(started.state).toBe('queued');
    const cancelled = await manager.cancel(started.id);
    expect(cancelled).toMatchObject({ state: 'cancelled', startedAt: null, exitCode: null });
    expect(manager.events(started.id).events.map((e) => e.type)).toEqual(['status', 'done']);

    const running = await manager.start({ provider: 'codex', prompt: 'work [[fake:hang]]', cwd: root });
    await until(() => manager.get(running.id)!.finalMessage !== null, 'the fake to report its pids');
    const { pid, child } = JSON.parse(manager.get(running.id)!.finalMessage!) as { pid: number; child: number };
    await manager.close();
    expect(manager.get(running.id)!.state).toBe('cancelled');
    await until(() => !processAlive(pid) && !processAlive(child), 'the processes to be gone');
    await expect(manager.start({ provider: 'codex', prompt: 'late', cwd: root })).rejects.toMatchObject({ code: 'closed' });
  });

  it('stops a silent job after the idle timeout', async () => {
    const { manager, root } = makeManager({ idleTimeoutMs: 400 });
    const { job, events } = await runJob(manager, { provider: 'codex', prompt: '[[fake:silent]]', cwd: root });
    expect(job.state).toBe('failed');
    expect(job.error!.message).toBe('Codex CLI produced no output for 0.4 s and was stopped');
    expect(job.error!.hint).toMatch(/follow-up message/);
    expect(events.slice(-2)).toMatchObject([
      { type: 'error', message: job.error!.message },
      { type: 'done', state: 'failed', reason: 'idle-timeout' },
    ]);
  });

  it('stops a job at the wall-clock limit even while it keeps producing output', async () => {
    const { manager, root } = makeManager({ timeoutMs: 600, idleTimeoutMs: 30_000 });
    const { job, events } = await runJob(manager, { provider: 'codex', prompt: '[[fake:chatty]]', cwd: root });
    expect(job.state).toBe('failed');
    expect(job.error!.message).toBe('the job ran longer than 0.6 s and was stopped');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'timeout' });
    expect(events.filter((e) => e.type === 'reasoning').length).toBeGreaterThan(2);
    // The session it had started can still be continued.
    expect(job.sessionId).toBe('0199aaaa-0000-7000-8000-000000000001');
  });

  it('reports failures with what to do: not signed in, a failed turn, a crash', async () => {
    const auth = await runJob(shared.manager, { provider: 'codex', prompt: '[[fake:auth]]', cwd: shared.root });
    expect(auth.job).toMatchObject({ state: 'failed', exitCode: 1, error: { message: 'ERROR: Not logged in. Run `codex login` to sign in.', hint: codexProvider.loginHint } });
    expect(auth.events.slice(-2)).toMatchObject([
      { type: 'error', message: 'ERROR: Not logged in. Run `codex login` to sign in.', hint: codexProvider.loginHint },
      { type: 'done', state: 'failed', reason: 'failed', exitCode: 1, hint: codexProvider.loginHint },
    ]);

    const turn = await runJob(shared.manager, { provider: 'codex', prompt: '[[fake:turn-failed]]', cwd: shared.root });
    expect(turn.job).toMatchObject({ state: 'failed', error: { message: 'unexpected status 401 Unauthorized: token expired', hint: codexProvider.loginHint } });
    expect(turn.events.filter((e) => e.type === 'error').map((e) => (e.type === 'error' ? e.message : ''))).toEqual([
      'Reconnecting... 1/5',
      'unexpected status 401 Unauthorized: token expired',
      'unexpected status 401 Unauthorized: token expired',
    ]);

    // The provider says the turn failed although the process exits 0.
    const soft = await runJob(shared.manager, { provider: 'codex', prompt: '[[fake:soft-fail]]', cwd: shared.root });
    expect(soft.job).toMatchObject({ state: 'failed', exitCode: 0, error: { message: 'the model refused the request' } });
    expect(soft.job.error!.hint).toBeUndefined();

    const crash = await runJob(shared.manager, { provider: 'codex', prompt: '[[fake:crash]]', cwd: shared.root });
    expect(crash.job).toMatchObject({ state: 'failed', exitCode: 3, error: { message: 'thread main panicked: something broke' }, finalMessage: null });
    expect(crash.events.at(-1)).toMatchObject({ type: 'done', state: 'failed', message: null, error: 'thread main panicked: something broke' });

    const claudeAuth = await runJob(shared.manager, { provider: 'claude', prompt: '[[fake:auth]]', cwd: shared.root });
    expect(claudeAuth.job).toMatchObject({ state: 'failed', error: { message: 'Invalid API key · Please run /login', hint: claudeProvider.loginHint } });
    const turns = await runJob(shared.manager, { provider: 'claude', prompt: '[[fake:max-turns]]', cwd: shared.root });
    expect(turns.job).toMatchObject({ state: 'failed', error: { message: 'Claude Code ended with error_max_turns' }, finalMessage: 'working on it' });
    const only = await runJob(shared.manager, { provider: 'claude', prompt: '[[fake:result-only]]', cwd: shared.root });
    expect(only.job).toMatchObject({ state: 'done', finalMessage: 'only in the result' });
    expect(only.events.filter((e) => e.type === 'message')).toHaveLength(1);
  });

  it('survives junk on stdout and a last line without a newline', async () => {
    const { job, events } = await runJob(shared.manager, { provider: 'codex', prompt: '[[fake:noise]]', cwd: shared.root });
    expect(job).toMatchObject({ state: 'done', finalMessage: 'still fine', usage: { inputTokens: 1200, outputTokens: 34 } });
    expect(events.map((e) => e.type)).toEqual(['status', 'status', 'status', 'message', 'usage', 'done']);
  });

  it('replays the recorded real sessions of both CLIs', async () => {
    const codex = await runJob(shared.manager, { provider: 'codex', prompt: 'Reply with exactly: OK [[fake:recorded]]', cwd: shared.root, sandbox: 'read-only' });
    expect(codex.job).toMatchObject({ state: 'done', finalMessage: 'OK', sessionId: '01a10ab1-0000-7000-8000-00000000c0de', usage: { inputTokens: 29260, outputTokens: 5 } });
    expect(codex.events.map((e) => e.type)).toEqual(['status', 'status', 'status', 'status', 'message', 'usage', 'done']);
    const claude = await runJob(shared.manager, { provider: 'claude', prompt: 'Reply with exactly: OK [[fake:recorded]]', cwd: shared.root, sandbox: 'read-only' });
    expect(claude.job).toMatchObject({ state: 'done', finalMessage: 'OK', sessionId: '8901b2bb-0000-4000-8000-00000000c0de', usage: { inputTokens: 6673, cachedInputTokens: 3005, outputTokens: 4, costUsd: 0.030017 } });
    expect(claude.events.map((e) => e.type)).toEqual(['status', 'status', 'status', 'message', 'usage', 'done']);
  });

  it('rejects options that would leave the workspace or the two sandboxes', async () => {
    const { manager, root } = shared;
    const outside = tempDir();
    writeFileSync(path.join(outside, 'secret.png'), 'png');
    writeFileSync(path.join(root, 'notes.txt'), 'text');
    writeFileSync(path.join(root, 'ok.png'), 'png');
    const start = (over: Record<string, unknown>) => manager.start({ provider: 'codex', prompt: 'x', cwd: root, ...over } as Parameters<AgentManager['start']>[0]).catch((e: unknown) => e);
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ cwd: outside }, 'invalid', /outside the workspace root/],
      [{ cwd: path.dirname(root) }, 'invalid', /outside the workspace root/],
      [{ cwd: path.join(root, 'missing') }, 'invalid', /not an existing directory/],
      [{ cwd: path.join(root, 'ok.png') }, 'invalid', /not an existing directory/],
      [{ cwd: 'relative/dir' }, 'invalid', /absolute path/],
      [{ images: [path.join(outside, 'secret.png')] }, 'invalid', /outside the workspace root/],
      [{ images: [path.join(root, 'notes.txt')] }, 'invalid', /not an image file/],
      [{ images: [path.join(root, 'missing.png')] }, 'invalid', /does not exist/],
      [{ images: ['ok.png'] }, 'invalid', /absolute file path/],
      [{ images: Array.from({ length: 9 }, () => path.join(root, 'ok.png')) }, 'invalid', /at most 8 images/],
      [{ sandbox: 'danger-full-access' }, 'invalid', /unknown sandbox/],
      [{ model: '--dangerously-bypass-approvals-and-sandbox' }, 'invalid', /invalid model name/],
      [{ model: 'a b' }, 'invalid', /invalid model name/],
      [{ model: 'sandbox_mode=danger-full-access' }, 'invalid', /invalid model name/],
      [{ effort: 'ludicrous' }, 'invalid', /unknown effort/],
      [{ provider: 'gemini' }, 'invalid', /unknown provider/],
      [{ kind: 'no-such-kind' }, 'invalid', /unknown task kind/],
      [{ prompt: '   ' }, 'invalid', /needs a prompt/],
      [{ prompt: 'x'.repeat(32 * 1024 + 1) }, 'too-large', /at most 32768 are accepted/],
      [{ context: { blob: 'y'.repeat(17 * 1024) } }, 'too-large', /"context" is larger/],
      [{ resumeOf: 'nope' }, 'unknown-job', /unknown agent job/],
    ];
    for (const [over, code, message] of cases) {
      const err = await start(over);
      expect(err, JSON.stringify(over).slice(0, 80)).toBeInstanceOf(AgentError);
      expect((err as AgentError).code, JSON.stringify(over).slice(0, 80)).toBe(code);
      expect((err as AgentError).message).toMatch(message);
    }
    expect(manager.activeJob).toBeNull();
  });

  it.runIf(!WIN)('refuses a working directory that leaves the root through a symbolic link', async () => {
    const { symlinkSync } = await import('node:fs');
    const outside = tempDir();
    symlinkSync(outside, path.join(shared.root, 'escape'));
    await expect(shared.manager.start({ provider: 'codex', prompt: 'x', cwd: path.join(shared.root, 'escape') })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('runs in a project folder inside the root and tells the agent so', async () => {
    const project = path.join(shared.root, 'avatars', 'miko');
    mkdirSync(project, { recursive: true });
    const { job } = await runJob(shared.manager, { provider: 'codex', prompt: 'look around', cwd: project, file: path.join(project, 'miko.r2d.json') });
    const echo = echoOf(job);
    expect(sameDir(echo.cwd, project)).toBe(true);
    expect(echo.prompt).toContain(`- Project folder (your working directory): ${project.split(path.sep).join('/')}`);
    expect(echo.prompt).toContain('- Model open in the editor: miko.r2d.json');
    expect(echo.argv[echo.argv.indexOf('-C') + 1]).toBe(project);
  });

  it('keeps a capped number of events per job in memory (the log has all)', async () => {
    const { manager, root, logDir } = makeManager({ maxEvents: 5 });
    const { job } = await runJob(manager, { provider: 'codex', prompt: '[[fake:full]]', cwd: root });
    const { events, firstSeq, lastSeq } = manager.events(job.id);
    expect(events.map((e) => e.seq)).toEqual([19, 20, 21, 22, 23]);
    expect([firstSeq, lastSeq, job.lastSeq]).toEqual([19, 23, 23]);
    expect(manager.events(job.id, 21).events.map((e) => e.seq)).toEqual([22, 23]);
    const logged = readFileSync(path.join(logDir, readdirSync(logDir)[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string });
    expect(logged.filter((l) => l.kind === 'event')).toHaveLength(23);
  });

  it('remembers only the newest jobs', async () => {
    const { manager, root } = makeManager({ maxJobs: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await runJob(manager, { provider: 'codex', prompt: `job ${i}`, cwd: root })).job.id);
    expect(manager.list().map((j) => j.id)).toEqual([ids[2], ids[1]]);
    expect(manager.get(ids[0])).toBeNull();
    expect(() => manager.events(ids[0])).toThrow(/unknown agent job/);
  });
});

// ----------------------------------------------------------------------------- logs

describe('job logs', () => {
  it('writes the command line, the raw provider lines and the normalised events', async () => {
    const { manager, root, logDir } = makeManager();
    const { job, events } = await runJob(manager, { provider: 'codex', prompt: 'log me [[fake:full]]', cwd: root });
    expect(job.logFile).toBe(path.join(logDir, readdirSync(logDir)[0]));
    expect(path.basename(job.logFile!)).toMatch(new RegExp(`^\\d{8}T\\d{9}Z-codex-${job.id}\\.jsonl$`));
    const records = readFileSync(job.logFile!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
    expect(records[0]).toMatchObject({ kind: 'job', job: { id: job.id, provider: 'codex', state: 'queued' } });
    expect(records[0].command.slice(0, 3)).toEqual([process.execPath, path.join(FAKES, 'fake-codex.mjs'), '--fake=echo']);
    expect(records[0].command.at(-1)).toBe('-');
    expect(records[0].prompt).toContain('\n\nRequest\nlog me [[fake:full]]\n');
    expect(records.filter((r) => r.kind === 'stdout').map((r) => r.line)).toEqual(lines('codex-full.jsonl'));
    expect(records.filter((r) => r.kind === 'event').map(({ kind: _kind, ...e }) => e)).toEqual(events);
  });

  it('keeps stderr in the log', async () => {
    const { manager, root } = makeManager();
    const { job } = await runJob(manager, { provider: 'codex', prompt: '[[fake:auth]]', cwd: root });
    const records = readFileSync(job.logFile!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
    expect(records.filter((r) => r.kind === 'stderr').map((r) => r.line)).toEqual(['Reading additional input from stdin...', 'ERROR: Not logged in. Run `codex login` to sign in.']);
  });

  it('keeps the newest log files only', async () => {
    let clock = Date.UTC(2026, 0, 1);
    const { manager, root, logDir } = makeManager({ maxLogFiles: 3, now: () => (clock += 1000) });
    writeFileSync(path.join(logDir, 'notes.txt'), 'not a job log');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await runJob(manager, { provider: 'codex', prompt: `job ${i}`, cwd: root })).job.id);
    const names = listLogFiles(logDir);
    expect(names).toHaveLength(3);
    expect(names.map((n) => n.replace(/^.*-codex-|\.jsonl$/g, ''))).toEqual(ids.slice(2));
    expect(existsSync(path.join(logDir, 'notes.txt'))).toBe(true);
  });

  it('rotates by name (oldest first) and writes no file when logging is off', async () => {
    const dir = tempDir();
    const names = [1, 2, 3, 4].map((d) => logFileName(Date.UTC(2026, 4, d, 10, 15, 2, 123), 'codex', `0000000000a${d}`));
    expect(names[0]).toBe('20260501T101502123Z-codex-0000000000a1.jsonl');
    for (const n of [...names].reverse()) writeFileSync(path.join(dir, n), '');
    expect(rotateLogs(dir, 2)).toEqual(names.slice(0, 2));
    expect(listLogFiles(dir)).toEqual(names.slice(2));
    expect(rotateLogs(path.join(dir, 'missing'), 2)).toEqual([]);

    const { manager, root } = makeManager({ logDir: null });
    const { job } = await runJob(manager, { provider: 'codex', prompt: 'quiet', cwd: root });
    expect(job).toMatchObject({ state: 'done', logFile: null });
  });
});
