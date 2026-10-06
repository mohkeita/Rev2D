/**
 * The Codex Windows sandbox problem and its opt-in fix (src/node/agent): the `codexWindowsSandbox`
 * setting and the one command-line override it may add, the settings store with its sources, the
 * detection of a sandbox that cannot start commands, and the stall watchdog.
 * Every process started here is a fake agent from test/fixtures/fake-agents; no test calls a real CLI.
 * Windows-specific behaviour is tested on every host through the manager's `platform` option.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT } from '../src/api/templates.js';
import {
  AgentError,
  AgentManager,
  AgentSettingsStore,
  CODEX_WINDOWS_SANDBOX_CODE,
  assertSafeArgs,
  claudeProvider,
  codexProvider,
  readUserAgentSettings,
  windowsSandboxHint,
  writeUserAgentSettings,
  type AgentEvent,
  type AgentJobInfo,
  type AgentManagerOptions,
  type CodexWindowsSandbox,
  type ProviderRun,
} from '../src/node/agent/index.js';

const FAKES = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'fake-agents');
const FAKE_COMMANDS = {
  codex: [process.execPath, path.join(FAKES, 'fake-codex.mjs')],
  claude: [process.execPath, path.join(FAKES, 'fake-claude.mjs')],
};

const temps: string[] = [];
function tempDir(prefix = 'rev2d-agent-sandbox-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const managers: AgentManager[] = [];
function makeManager(opts: Partial<AgentManagerOptions> = {}): { manager: AgentManager; root: string } {
  const root = opts.root ?? tempDir();
  const manager = new AgentManager({ root, logDir: null, commands: FAKE_COMMANDS, ...opts });
  managers.push(manager);
  return { manager, root };
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

async function runJob(manager: AgentManager, opts: Parameters<AgentManager['start']>[0]): Promise<{ job: AgentJobInfo; events: AgentEvent[] }> {
  const started = await manager.start(opts);
  const job = await manager.wait(started.id);
  return { job, events: manager.events(job.id).events };
}

const run = (over: Partial<ProviderRun> = {}): ProviderRun => ({
  cwd: path.resolve('/work/space'),
  sandbox: 'workspace-write',
  images: [],
  allowImageGeneration: false,
  rev2dBin: path.resolve('/opt/rev2d/bin/rev2d.js'),
  platform: 'win32',
  codexWindowsSandbox: 'config',
  ...over,
});

const OVERRIDE = 'windows.sandbox="unelevated"';
/** Whether a command line carries the override, as its own `-c` value. */
const hasOverride = (args: string[]) => args.some((a, i) => a === OVERRIDE && args[i - 1] === '-c');
const argvOf = (job: AgentJobInfo) => (JSON.parse(job.finalMessage!) as { argv: string[] }).argv;

// ----------------------------------------------------------------------------- the command line

describe('codexWindowsSandbox: the command line', () => {
  it('adds the unelevated override for Codex on Windows only, and only when the setting asks for it', () => {
    const cwd = path.resolve('/work/space');
    expect(codexProvider.buildArgs(run({ codexWindowsSandbox: 'unelevated', effort: 'low' }))).toEqual([
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
      'model_reasoning_effort="low"',
      '-c',
      OVERRIDE,
      '--disable',
      'image_generation',
      '-',
    ]);
    // A follow-up keeps it, before "resume" like every option of codex exec.
    const resumed = codexProvider.buildArgs(run({ codexWindowsSandbox: 'unelevated', resumeSession: 'abc-123', sandbox: 'read-only' }));
    expect(hasOverride(resumed)).toBe(true);
    expect(resumed.indexOf(OVERRIDE)).toBeLessThan(resumed.indexOf('resume'));
    expect(resumed).toEqual(expect.arrayContaining(['-s', 'read-only']));

    expect(hasOverride(codexProvider.buildArgs(run({ codexWindowsSandbox: 'config' })))).toBe(false);
    for (const platform of ['linux', 'darwin'] as const) expect(hasOverride(codexProvider.buildArgs(run({ platform, codexWindowsSandbox: 'unelevated' })))).toBe(false);
    const help = '--restricted --tools <tools...> --strict-mcp-config --permission-prompts <target> --effort <level> "dontAsk"';
    expect(claudeProvider.buildArgs(run({ codexWindowsSandbox: 'unelevated', help })).join(' ')).not.toContain('windows.sandbox');
    // The sandbox itself is untouched: -s still names one of the two modes.
    expect(() => assertSafeArgs(codexProvider.buildArgs(run({ codexWindowsSandbox: 'unelevated', effort: 'max', model: 'm' })))).not.toThrow();
  });

  it('assertSafeArgs allows exactly this one extra override', () => {
    expect(() => assertSafeArgs(['exec', '-c', OVERRIDE, '-s', 'workspace-write', '-'])).not.toThrow();
    expect(() => assertSafeArgs(['exec', '--config', OVERRIDE, '-'])).not.toThrow();
    for (const bad of [
      'windows.sandbox="elevated"',
      'windows.sandbox="disabled"',
      'windows.sandbox=unelevated',
      'windows.sandbox="unelevated" ',
      'windows.sandbox="unelevated"\nsandbox_mode="danger-full-access"',
      'windows.sandbox_private_desktop=false',
      'windows="unelevated"',
      'sandbox_mode="unelevated"',
      'model_reasoning_effort="low"; sandbox_mode="danger-full-access"',
      'model_reasoning_effort=low',
    ]) {
      expect(() => assertSafeArgs(['exec', '-c', bad, '-']), bad).toThrow(/refusing to start an agent with the config override/);
      expect(() => assertSafeArgs(['exec', `--config=${bad}`, '-']), bad).toThrow(/refusing/);
    }
    // The attached spellings are checked like the separate ones.
    expect(() => assertSafeArgs(['exec', '-csandbox_mode="danger-full-access"', '-'])).toThrow(/refusing/);
    expect(() => assertSafeArgs(['exec', `--config=${OVERRIDE}`, '-'])).not.toThrow();
  });

  it('a job gets the setting from the manager, read at every start; a job option cannot set it', async () => {
    let setting: CodexWindowsSandbox = 'config';
    const { manager, root } = makeManager({ platform: 'win32', codexWindowsSandbox: () => setting });
    expect((await manager.providers())[0]).toMatchObject({ id: 'codex', windowsSandbox: 'config' });
    const first = await runJob(manager, { provider: 'codex', prompt: 'one', cwd: root });
    expect(hasOverride(argvOf(first.job))).toBe(false);

    setting = 'unelevated';
    expect((await manager.providers())[0]).toMatchObject({ id: 'codex', windowsSandbox: 'unelevated' });
    expect((await manager.providers())[1]).not.toHaveProperty('windowsSandbox');
    const second = await runJob(manager, { provider: 'codex', prompt: 'two', cwd: root });
    const argv = argvOf(second.job);
    expect(hasOverride(argv)).toBe(true);
    expect(argv).toEqual(expect.arrayContaining(['-s', 'workspace-write']));
    // The follow-up of a job started before the change uses the setting of now.
    const follow = await manager.wait((await manager.message(first.job.id, 'again')).id);
    expect(hasOverride(argvOf(follow))).toBe(true);
    // Claude Code never gets it.
    const claude = await runJob(manager, { provider: 'claude', prompt: 'three', cwd: root });
    expect(argvOf(claude.job).join(' ')).not.toContain('windows.sandbox');

    // Something that looks like the setting in the job options is not an option: it changes nothing.
    setting = 'config';
    const sneaky = await runJob(manager, { provider: 'codex', prompt: 'four', cwd: root, codexWindowsSandbox: 'unelevated' } as Parameters<AgentManager['start']>[0]);
    expect(hasOverride(argvOf(sneaky.job))).toBe(false);
  });

  it('has no effect outside Windows, and a fixed value works like a function', async () => {
    const posix = makeManager({ platform: 'linux', codexWindowsSandbox: 'unelevated' });
    expect((await posix.manager.providers())[0]).not.toHaveProperty('windowsSandbox');
    expect(hasOverride(argvOf((await runJob(posix.manager, { provider: 'codex', prompt: 'x', cwd: posix.root })).job))).toBe(false);
    const win = makeManager({ platform: 'win32', codexWindowsSandbox: 'unelevated' });
    expect(hasOverride(argvOf((await runJob(win.manager, { provider: 'codex', prompt: 'x', cwd: win.root })).job))).toBe(true);
    // A source that returns nonsense counts as "config".
    const odd = makeManager({ platform: 'win32', codexWindowsSandbox: (() => 'danger-full-access') as unknown as () => CodexWindowsSandbox });
    expect((await odd.manager.providers())[0]).toMatchObject({ windowsSandbox: 'config' });
    expect(hasOverride(argvOf((await runJob(odd.manager, { provider: 'codex', prompt: 'x', cwd: odd.root })).job))).toBe(false);
  });
});

// ----------------------------------------------------------------------------- detection

const coded = (events: AgentEvent[]) => events.filter((e) => (e.type === 'error' || e.type === 'status') && e.code === CODEX_WINDOWS_SANDBOX_CODE);

describe('codexWindowsSandbox: a sandbox that cannot start commands', () => {
  it('the hint names both fixes, and does not offer the unelevated sandbox when it is already on', () => {
    const config = windowsSandboxHint({ codexWindowsSandbox: 'config' });
    expect(config).toContain('run "codex" once in an administrator terminal and accept its sandbox setup');
    expect(config).toContain('PUT /api/agent/settings {"codexWindowsSandbox": "unelevated"}');
    expect(config).toContain('rev2d edit --agent-codex-sandbox unelevated');
    const unelevated = windowsSandboxHint({ codexWindowsSandbox: 'unelevated' });
    expect(unelevated).toContain('run "codex" once in an administrator terminal and accept its sandbox setup');
    expect(unelevated).toContain('already');
    expect(unelevated).not.toContain('PUT /api/agent/settings');
    expect(unelevated).not.toContain('--agent-codex-sandbox');
    expect(unelevated).not.toMatch(/use Codex's unelevated sandbox|switch/);
  });

  it('recognises every known face of the failure, in stderr and in failed commands, on Windows only', () => {
    const diagnose = codexProvider.diagnose!;
    const stderrLines = [
      'ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\\"Failed to create unified exec process: orchestrator_helper_exit_nonzero: setup helper exited with status Some(143)\\")" }',
      'something: setup helper exited with status Some(1)',
      'windows sandbox failed: CreateProcessWithLogonW failed: 1326',
      'CreateProcessWithLogonW failed',
      'ERROR codex_core::tools::router: error=code-mode host closed its stdout',
    ];
    for (const stderr of stderrLines) {
      expect(diagnose({ stderr }, run()), stderr).toMatchObject({ code: 'codex-windows-sandbox', message: 'Codex cannot start commands in its Windows sandbox, so it cannot run the Rev2D CLI' });
      expect(diagnose({ stderr }, run({ platform: 'linux' })), stderr).toBeNull();
    }
    const command = (over: Record<string, unknown>) => ({ type: 'command', id: 'i', phase: 'completed', status: 'failed', command: 'node --version', exitCode: -1, output: stderrLines[0], outputTruncated: false, ...over }) as AgentEvent;
    expect(diagnose({ event: command({}) }, run())?.code).toBe('codex-windows-sandbox');
    expect(diagnose({ event: command({ status: 'completed', exitCode: 1 }) }, run())?.code).toBe('codex-windows-sandbox');
    // A command that worked, or still runs, and merely prints those words is no failure.
    expect(diagnose({ event: command({ status: 'completed', exitCode: 0 }) }, run())).toBeNull();
    expect(diagnose({ event: command({ status: 'running', phase: 'started', exitCode: null }) }, run())).toBeNull();
    expect(diagnose({ event: { type: 'message', text: stderrLines[2] } }, run())).toBeNull();
    expect(diagnose({ event: { type: 'error', message: stderrLines[2] } }, run())?.code).toBe('codex-windows-sandbox');
    expect(diagnose({ stderr: 'Reading additional input from stdin...' }, run())).toBeNull();
    // The hint follows the setting.
    expect(diagnose({ stderr: stderrLines[4] }, run())!.hint).toBe(windowsSandboxHint({ codexWindowsSandbox: 'config' }));
    expect(diagnose({ stderr: stderrLines[4] }, run({ codexWindowsSandbox: 'unelevated' }))!.hint).toBe(windowsSandboxHint({ codexWindowsSandbox: 'unelevated' }));
    expect(claudeProvider.diagnose).toBeUndefined();
  });

  it('reports it once per job as an error event with the code and both fixes', async () => {
    const { manager, root } = makeManager({ platform: 'win32' });
    // The failure shows twice (stderr and the failed command): one error event.
    const helper = await runJob(manager, { provider: 'codex', prompt: '[[fake:helper-exit]]', cwd: root });
    expect(helper.job).toMatchObject({ state: 'done', finalMessage: 'I could not run the command in this environment.' });
    const errors = coded(helper.events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: 'error',
      code: 'codex-windows-sandbox',
      message: 'Codex cannot start commands in its Windows sandbox, so it cannot run the Rev2D CLI',
      hint: windowsSandboxHint({ codexWindowsSandbox: 'config' }),
    });
    expect(helper.events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(helper.events.filter((e) => e.type === 'command').map((e) => (e.type === 'command' ? [e.phase, e.status, e.exitCode] : null))).toEqual([
      ['started', 'running', null],
      ['completed', 'failed', -1],
    ]);
    // Two failed commands: still one error event.
    const twice = await runJob(manager, { provider: 'codex', prompt: '[[fake:sandbox-fail]]', cwd: root });
    expect(coded(twice.events)).toHaveLength(1);
    expect(twice.events.map((e) => e.type)).toEqual(['status', 'status', 'status', 'command', 'error', 'command', 'message', 'usage', 'done']);
    // Output that only quotes the error texts (the agent read the docs) is not the failure.
    const quoted = await runJob(manager, { provider: 'codex', prompt: '[[fake:quoted]]', cwd: root });
    expect(quoted.job.state).toBe('done');
    expect(quoted.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('with the unelevated sandbox already on, the hint does not suggest switching to it; elsewhere nothing is reported', async () => {
    const on = makeManager({ platform: 'win32', codexWindowsSandbox: 'unelevated' });
    const { events } = await runJob(on.manager, { provider: 'codex', prompt: '[[fake:helper-exit]]', cwd: on.root });
    expect(coded(events)).toHaveLength(1);
    const hint = (coded(events)[0] as { hint: string }).hint;
    expect(hint).toBe(windowsSandboxHint({ codexWindowsSandbox: 'unelevated' }));
    expect(hint).not.toContain('PUT /api/agent/settings');

    const posix = makeManager({ platform: 'linux' });
    const elsewhere = await runJob(posix.manager, { provider: 'codex', prompt: '[[fake:helper-exit]]', cwd: posix.root });
    expect(coded(elsewhere.events)).toEqual([]);
  });
});

// ----------------------------------------------------------------------------- the stall watchdog

describe('codexWindowsSandbox: the stall watchdog', () => {
  it('reports a silent Codex once as "stalled" with the hint, without stopping it; the idle timeout still ends the job', async () => {
    const { manager, root } = makeManager({ platform: 'win32', stallMs: 300, idleTimeoutMs: 1500 });
    const started = await manager.start({ provider: 'codex', prompt: '[[fake:host-closed]]', cwd: root });
    const types = () => manager.events(started.id).events.map((e) => (e.type === 'status' ? `status:${e.status}` : e.type));
    // The fake reports its session and turn, names the failure on stderr, then stays silent.
    await until(() => types().lastIndexOf('status:stalled') > types().indexOf('status:turn') && types().includes('status:turn'), 'the stalled status after the last event');
    // Still running: the watchdog only tells.
    expect(manager.get(started.id)!.state).toBe('running');
    expect(manager.activeJob).toBe(started.id);
    const job = await manager.wait(started.id);
    const events = manager.events(job.id).events;
    // stderr named the failure: one error event.
    expect(events.filter((e) => e.type === 'error' && e.code === 'codex-windows-sandbox')).toHaveLength(1);
    // The silence after the provider's last event lasted four stall times: ONE stalled status, not four.
    // (A process slow to start may have earned one more before its first event.)
    const lastProviderEvent = events.findIndex((e) => e.type === 'status' && e.status === 'turn');
    const stalled = events.filter((e) => e.type === 'status' && e.status === 'stalled');
    expect(stalled.filter((e) => events.indexOf(e) > lastProviderEvent)).toHaveLength(1);
    expect(stalled.length).toBeLessThanOrEqual(2);
    expect(stalled.at(-1)).toMatchObject({
      type: 'status',
      status: 'stalled',
      code: 'codex-windows-sandbox',
      text: expect.stringMatching(/^Codex has reported nothing for 300 ms\. .*The job keeps running\.$/),
      hint: `if nothing arrives: cancel the job; then ${windowsSandboxHint({ codexWindowsSandbox: 'config' })}`,
    });
    // The idle timeout is what ended the job, as without the watchdog.
    expect(job).toMatchObject({ state: 'failed', error: { message: 'Codex CLI produced no output for 1.5 s and was stopped' } });
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'idle-timeout' });
  });

  it('starts over with every provider event, and says what the setting is', async () => {
    const { manager, root } = makeManager({ platform: 'win32', stallMs: 600, codexWindowsSandbox: 'unelevated' });
    // An event every 30 ms, for longer than the stall time: never stalled.
    const chatty = await manager.start({ provider: 'codex', prompt: '[[fake:chatty]]', cwd: root });
    await until(() => manager.events(chatty.id).events.filter((e) => e.type === 'reasoning').length > 30, 'the chatty fake to talk for a while');
    await manager.cancel(chatty.id);
    // (Counted from its first event on: a process slow to start may be called stalled before it.)
    const talk = manager.events(chatty.id).events;
    expect(talk.slice(talk.findIndex((e) => e.type === 'reasoning')).filter((e) => e.type === 'status' && e.status === 'stalled')).toEqual([]);
    // Silent from the start: stalled, with a hint that does not offer the sandbox that is already on.
    const silent = await manager.start({ provider: 'codex', prompt: '[[fake:silent]]', cwd: root });
    await until(() => manager.events(silent.id).events.some((e) => e.type === 'status' && e.status === 'stalled'), 'the stalled status');
    const stalled = manager.events(silent.id).events.find((e) => e.type === 'status' && e.status === 'stalled') as { hint: string };
    expect(stalled.hint).toContain(windowsSandboxHint({ codexWindowsSandbox: 'unelevated' }));
    expect(stalled.hint).not.toContain('PUT /api/agent/settings');
    expect((await manager.cancel(silent.id)).state).toBe('cancelled');
  });

  it('is for Codex on Windows only, and can be switched off', async () => {
    const stalledIn = (manager: AgentManager, id: string) => manager.events(id).events.filter((e) => e.type === 'status' && e.status === 'stalled');
    // Another platform: the silent job just runs into its idle timeout.
    const posix = makeManager({ platform: 'linux', stallMs: 100, idleTimeoutMs: 500 });
    const elsewhere = await runJob(posix.manager, { provider: 'codex', prompt: '[[fake:silent]]', cwd: posix.root });
    expect(elsewhere.events.at(-1)).toMatchObject({ type: 'done', reason: 'idle-timeout' });
    expect(stalledIn(posix.manager, elsewhere.job.id)).toEqual([]);
    // stallMs 0: off, also on Windows. Claude Code has no such notice.
    const off = makeManager({ platform: 'win32', stallMs: 0, idleTimeoutMs: 500 });
    const quiet = await runJob(off.manager, { provider: 'codex', prompt: '[[fake:silent]]', cwd: off.root });
    expect(stalledIn(off.manager, quiet.job.id)).toEqual([]);
    const win = makeManager({ platform: 'win32', stallMs: 100, idleTimeoutMs: 500 });
    const claude = await runJob(win.manager, { provider: 'claude', prompt: '[[fake:hang]]', cwd: win.root });
    expect(claude.events.at(-1)).toMatchObject({ type: 'done', reason: 'idle-timeout' });
    expect(stalledIn(win.manager, claude.job.id)).toEqual([]);
  });
});

// ----------------------------------------------------------------------------- the settings store

describe('agent settings: sources and the settings file', () => {
  it('defaults to "config", and an option or a flag beats the saved user setting', () => {
    const file = path.join(tempDir(), 'nested', 'settings.json');
    const plain = new AgentSettingsStore({ file, platform: 'win32' });
    expect(plain.info()).toEqual({ settings: { codexWindowsSandbox: 'config' }, sources: { codexWindowsSandbox: 'default' }, user: {}, file, windows: true, notes: [] });
    expect(existsSync(file)).toBe(false);

    // Saving creates the file (and its directory) and counts at once.
    expect(plain.setUser({ codexWindowsSandbox: 'unelevated' })).toEqual({
      settings: { codexWindowsSandbox: 'unelevated' },
      sources: { codexWindowsSandbox: 'user' },
      user: { codexWindowsSandbox: 'unelevated' },
      file,
      windows: true,
      notes: [],
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ agent: { codexWindowsSandbox: 'unelevated' } });
    expect(plain.get()).toEqual({ codexWindowsSandbox: 'unelevated' });

    // The same file under a server started with an option / a flag: the option wins, and says so.
    const option = new AgentSettingsStore({ file, option: { codexWindowsSandbox: 'config' }, platform: 'win32' });
    expect(option.info()).toMatchObject({ settings: { codexWindowsSandbox: 'config' }, sources: { codexWindowsSandbox: 'option' }, user: { codexWindowsSandbox: 'unelevated' } });
    expect(option.info().notes).toEqual([
      'codexWindowsSandbox: the saved value "unelevated" is not used, because this editor server was started with an option that sets "config"; it counts once the editor is started without it',
    ]);
    const flag = new AgentSettingsStore({ file, option: { codexWindowsSandbox: 'config' }, optionSource: 'flag', platform: 'win32' });
    expect(flag.info().sources).toEqual({ codexWindowsSandbox: 'flag' });
    expect(flag.info().notes[0]).toContain('this editor was started with a flag that sets "config"');
    // Saving under a flag writes the file but does not change what is used.
    writeFileSync(file, JSON.stringify({ agent: { codexWindowsSandbox: 'config' } }));
    const saved = flag.setUser({ codexWindowsSandbox: 'unelevated' });
    expect(saved).toMatchObject({ settings: { codexWindowsSandbox: 'config' }, sources: { codexWindowsSandbox: 'flag' }, user: { codexWindowsSandbox: 'unelevated' } });
    expect(JSON.parse(readFileSync(file, 'utf8')).agent.codexWindowsSandbox).toBe('unelevated');
    // An option equal to the saved value needs no note.
    expect(new AgentSettingsStore({ file, option: { codexWindowsSandbox: 'unelevated' }, platform: 'win32' }).info().notes).toEqual([]);
    expect(() => new AgentSettingsStore({ file, option: { codexWindowsSandbox: 'elevated' as CodexWindowsSandbox } })).toThrow(/must be "config" or "unelevated"/);
  });

  it('reads the file every time, keeps its other keys, and ignores what it cannot use', () => {
    const file = path.join(tempDir(), 'settings.json');
    const store = new AgentSettingsStore({ file, platform: 'win32' });
    // Written by hand while the server runs: counts at once.
    writeFileSync(file, '﻿' + JSON.stringify({ theme: 'dark', agent: { codexWindowsSandbox: 'unelevated', future: 1 } }));
    expect(store.get()).toEqual({ codexWindowsSandbox: 'unelevated' });
    store.setUser({ codexWindowsSandbox: 'config' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'dark', agent: { codexWindowsSandbox: 'config', future: 1 } });
    expect(readFileSync(file, 'utf8').endsWith('}\n')).toBe(true);

    // An unknown value is ignored with a note.
    writeFileSync(file, JSON.stringify({ agent: { codexWindowsSandbox: 'danger-full-access' } }));
    expect(store.info()).toMatchObject({ settings: { codexWindowsSandbox: 'config' }, sources: { codexWindowsSandbox: 'default' }, user: {} });
    expect(store.info().notes[0]).toMatch(/agent\.codexWindowsSandbox in .* is "danger-full-access", not one of "config", "unelevated"; it is ignored/);
    writeFileSync(file, JSON.stringify({ agent: 'nope' }));
    expect(readUserAgentSettings(file)).toEqual({ settings: {}, notes: [`"agent" in ${file} is not an object; it is ignored`] });

    // A file that is not JSON is ignored when reading and never overwritten.
    writeFileSync(file, '{ not json');
    expect(store.info().settings).toEqual({ codexWindowsSandbox: 'config' });
    expect(store.info().notes[0]).toMatch(/is not valid JSON .*; it is ignored$/);
    const err = (() => {
      try {
        store.setUser({ codexWindowsSandbox: 'unelevated' });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ code: 'settings-file', hint: expect.stringContaining('delete it') });
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
    writeFileSync(file, '[1, 2]');
    expect(() => writeUserAgentSettings(file, { codexWindowsSandbox: 'unelevated' })).toThrow(/is not a JSON object/);
    expect(() => store.setUser({ codexWindowsSandbox: 'elevated' as CodexWindowsSandbox })).toThrow(/must be "config" or "unelevated"/);
  });

  it('without a file keeps the user settings in memory, and says when the setting has no effect', () => {
    const memory = new AgentSettingsStore({ file: null, platform: 'linux' });
    expect(memory.info()).toEqual({ settings: { codexWindowsSandbox: 'config' }, sources: { codexWindowsSandbox: 'default' }, user: {}, file: null, windows: false, notes: [] });
    expect(memory.setUser({ codexWindowsSandbox: 'unelevated' })).toEqual({
      settings: { codexWindowsSandbox: 'unelevated' },
      sources: { codexWindowsSandbox: 'user' },
      user: { codexWindowsSandbox: 'unelevated' },
      file: null,
      windows: false,
      notes: ['codexWindowsSandbox only has an effect on Windows'],
    });
    // Another store shares nothing.
    expect(new AgentSettingsStore({ file: null }).get()).toEqual({ codexWindowsSandbox: 'config' });
  });
});
