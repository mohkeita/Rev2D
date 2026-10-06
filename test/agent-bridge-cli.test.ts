/**
 * `rev2d edit` and the agent bridge: the endpoints exist on the default loopback bind, are off with
 * a non-loopback --host (with a note), and --allow-agent keeps them (with a warning). No agent job is
 * started here, so no provider CLI is ever looked up.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli/main.js';
import { blankModel } from '../src/api/templates.js';
import { formatModelJson } from '../src/core/format.js';
import type { AgentSettingsInfo, SessionInfo } from '../src/node/editor-registry.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-agent-cli-'));
writeFileSync(path.join(root, 'model.r2d.json'), formatModelJson(blankModel({ name: 'agent-cli', width: 32, height: 32 })));

afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** Start `rev2d edit ... --json`; resolves once it listens (or failed to). */
async function edit(args: string[]) {
  const buf = { stdout: '', stderr: '' };
  const controller = new AbortController();
  const done = main(['edit', 'model.r2d.json', '--port', '0', '--no-open', '--json', ...args], {
    stdout: { write: (s: string) => ((buf.stdout += s), true) },
    stderr: { write: (s: string) => ((buf.stderr += s), true) },
    cwd: root,
    signal: controller.signal,
    openUrl: () => {
      throw new Error('tests must not open a browser');
    },
  });
  const deadline = Date.now() + 60_000;
  while (!buf.stdout.includes('listening') && !buf.stderr.includes('error:')) {
    if (Date.now() > deadline) throw new Error(`the editor did not start: ${buf.stderr}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  const listening = buf.stdout.includes('listening') ? (JSON.parse(buf.stdout.split('\n')[0]) as { url: string; agent: { enabled: boolean; reason?: string } }) : null;
  return {
    buf,
    listening,
    async stop() {
      controller.abort();
      return done;
    },
  };
}

describe('rev2d edit and the agent bridge', () => {
  it('offers the agent endpoints on the default loopback bind', async () => {
    const e = await edit([]);
    try {
      expect(e.listening, e.buf.stderr).toMatchObject({ event: 'listening', agent: { enabled: true } });
      expect(e.buf.stderr).not.toMatch(/agent/i);
      const session = (await (await fetch(`${e.listening!.url}/api/session`)).json()) as SessionInfo;
      expect(session.agent).toEqual({ enabled: true });
      expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await fetch(`${e.listening!.url}/api/agent/jobs`)).status).toBe(401);
      const jobs = await fetch(`${e.listening!.url}/api/agent/jobs`, { headers: { 'X-Rev2D-Token': session.token! } });
      expect(jobs.status).toBe(200);
      expect(await jobs.json()).toEqual({ jobs: [], active: null });
      // Without the flag the Codex sandbox setting comes from the person's settings file, else the default.
      // (Read only: this test never saves a setting, the file is the real one of this machine.)
      const settings = (await (await fetch(`${e.listening!.url}/api/agent/settings`, { headers: { 'X-Rev2D-Token': session.token! } })).json()) as AgentSettingsInfo;
      expect(['default', 'user']).toContain(settings.sources.codexWindowsSandbox);
      expect(['config', 'unelevated']).toContain(settings.settings.codexWindowsSandbox);
      expect(settings.file).toBe(path.join(os.homedir(), '.rev2d', 'settings.json'));
      expect(settings.windows).toBe(process.platform === 'win32');
    } finally {
      expect(await e.stop()).toBe(0);
    }
  });

  it('--agent-codex-sandbox sets the Codex Windows sandbox for this editor, whatever is saved', async () => {
    const e = await edit(['--agent-codex-sandbox', 'unelevated']);
    try {
      expect(e.listening, e.buf.stderr).toMatchObject({ event: 'listening', agent: { enabled: true } });
      const session = (await (await fetch(`${e.listening!.url}/api/session`)).json()) as SessionInfo;
      const settings = (await (await fetch(`${e.listening!.url}/api/agent/settings`, { headers: { 'X-Rev2D-Token': session.token! } })).json()) as AgentSettingsInfo;
      expect(settings).toMatchObject({ settings: { codexWindowsSandbox: 'unelevated' }, sources: { codexWindowsSandbox: 'flag' }, windows: process.platform === 'win32' });
      const note = 'note: --agent-codex-sandbox only has an effect on Windows';
      if (process.platform === 'win32') expect(e.buf.stderr).not.toContain(note);
      else expect(e.buf.stderr).toContain(note);
    } finally {
      expect(await e.stop()).toBe(0);
    }
    const config = await edit(['--agent-codex-sandbox', 'config']);
    try {
      const session = (await (await fetch(`${config.listening!.url}/api/session`)).json()) as SessionInfo;
      const settings = (await (await fetch(`${config.listening!.url}/api/agent/settings`, { headers: { 'X-Rev2D-Token': session.token! } })).json()) as AgentSettingsInfo;
      expect(settings).toMatchObject({ settings: { codexWindowsSandbox: 'config' }, sources: { codexWindowsSandbox: 'flag' } });
    } finally {
      expect(await config.stop()).toBe(0);
    }

    // Any other value is a usage error before a server starts.
    const buf = { stdout: '', stderr: '' };
    const code = await main(['edit', 'model.r2d.json', '--port', '0', '--no-open', '--agent-codex-sandbox', 'elevated'], {
      stdout: { write: (s: string) => ((buf.stdout += s), true) },
      stderr: { write: (s: string) => ((buf.stderr += s), true) },
      cwd: root,
      openUrl: () => {
        throw new Error('tests must not open a browser');
      },
    });
    expect(code).toBe(2);
    expect(buf.stderr).toContain('--agent-codex-sandbox must be config or unelevated, got "elevated"');
    expect(buf.stdout).toBe('');
  });

  it('switches them off for a non-loopback --host unless --allow-agent is given (with a warning)', async () => {
    const off = await edit(['--host', '0.0.0.0']);
    if (!off.listening) {
      // Sandboxes without a non-loopback interface cannot run this test.
      console.warn(`skipped: cannot bind 0.0.0.0 (${off.buf.stderr.trim()})`);
      await off.stop();
      return;
    }
    try {
      expect(off.listening.agent.enabled).toBe(false);
      expect(off.listening.agent.reason).toMatch(/not a loopback address/);
      expect(off.buf.stderr).toContain('note: the in-app agent (Codex / Claude Code runs started from the editor) is disabled on a non-loopback --host; --allow-agent enables it anyway');
      expect(off.buf.stderr).not.toContain('warning:');
      const session = (await (await fetch(`${off.listening.url}/api/session`)).json()) as SessionInfo;
      expect(session).toMatchObject({ token: null, agent: { enabled: false } });
      const res = await fetch(`${off.listening.url}/api/agent/providers`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'agent-disabled' });
    } finally {
      expect(await off.stop()).toBe(0);
    }

    const on = await edit(['--host', '0.0.0.0', '--allow-agent']);
    try {
      expect(on.listening, on.buf.stderr).toMatchObject({ agent: { enabled: true } });
      expect(on.buf.stderr).toMatch(/warning: --allow-agent with --host 0\.0\.0\.0: every machine that can reach this port can start Codex \/ Claude Code runs with YOUR login/);
      expect(on.buf.stderr).not.toContain('is disabled on a non-loopback');
      const session = (await (await fetch(`${on.listening!.url}/api/session`)).json()) as SessionInfo;
      expect(session.agent.enabled).toBe(true);
      expect((await fetch(`${on.listening!.url}/api/agent/jobs`)).status).toBe(401);
    } finally {
      expect(await on.stop()).toBe(0);
    }
  });
});
