/**
 * docs/AGENT-BRIDGE.md stays true: it names every endpoint, event type, error code and limit the code
 * has, its links resolve, and the `rev2d` command lines it shows use real flags.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '../src/api/templates.js';
import { COMMANDS } from '../src/cli/commands/index.js';
import { commandFlags } from '../src/cli/help.js';
import {
  CODEX_WINDOWS_SANDBOXES,
  CODEX_WINDOWS_SANDBOX_CODE,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_PROMPT_BYTES,
  DEFAULT_STALL_MS,
  DEFAULT_TIMEOUT_MS,
  EFFORTS,
  MAX_IMAGES,
  MAX_LOG_FILES,
  PROVIDERS,
  PROVIDER_IDS,
  SANDBOXES,
  taskTemplates,
  windowsSandboxHint,
  type AgentDoneReason,
  type AgentErrorCode,
  type AgentEventType,
  type AgentSettingSource,
} from '../src/node/agent/index.js';
import { AGENT_ENDPOINTS, DEFAULT_STARTS_PER_MINUTE } from '../src/server/agent-routes.js';

const file = path.join(PACKAGE_ROOT, 'docs', 'AGENT-BRIDGE.md');
const doc = readFileSync(file, 'utf8');
const prose = doc.replace(/^```[\s\S]*?^```/gm, '');

/** GitHub heading slug (see test/docs-links.test.ts). */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');

describe('docs/AGENT-BRIDGE.md', () => {
  it('names every endpoint, event type, done reason and error code', () => {
    for (const endpoint of AGENT_ENDPOINTS) expect(doc, endpoint).toContain(endpoint);
    expect(doc).toContain('SSE `agent-job`');
    expect(doc).toContain('X-Rev2D-Token');
    // Record keys: adding an event type, a reason or an error code without documenting it fails to compile or to pass.
    const events: Record<AgentEventType, true> = { status: true, message: true, reasoning: true, command: true, file: true, tool: true, todo: true, usage: true, error: true, done: true };
    for (const type of Object.keys(events)) expect(doc, type).toContain(`| \`${type}\` |`);
    const reasons: Record<AgentDoneReason, true> = { completed: true, failed: true, cancelled: true, timeout: true, 'idle-timeout': true, 'spawn-error': true };
    for (const reason of Object.keys(reasons)) expect(doc, reason).toContain(`\`${reason}\``);
    const codes: Record<Exclude<AgentErrorCode, 'closed'>, true> = { invalid: true, 'too-large': true, 'unknown-job': true, busy: true, 'not-resumable': true, unavailable: true, 'rate-limited': true, 'settings-file': true };
    for (const code of [...Object.keys(codes), 'token-required', 'agent-disabled']) expect(doc, code).toContain(`\`${code}\``);
  });

  it('names the providers, their overrides, the options and the limits as they are', () => {
    for (const id of PROVIDER_IDS) {
      expect(doc).toContain(`"${id}"`);
      expect(doc, PROVIDERS[id].envOverride).toContain(PROVIDERS[id].envOverride);
      expect(doc).toContain(`(\`${PROVIDERS[id].bin}\`)`);
    }
    for (const effort of EFFORTS) expect(doc).toContain(`\`${effort}\``);
    for (const sandbox of SANDBOXES) expect(doc).toContain(`\`${sandbox}\``);
    for (const template of taskTemplates().filter((t) => t.kind === 'freeform')) expect(doc).toContain(`\`${template.kind}\``);
    // Phrases may wrap: compare with every run of white space as one blank.
    const flat = doc.replace(/\s+/g, ' ');
    expect(flat).toContain(`limited to ${DEFAULT_TIMEOUT_MS / 60_000} minutes`);
    expect(flat).toContain(`silent for ${DEFAULT_IDLE_TIMEOUT_MS / 60_000} minutes`);
    expect(flat).toContain(`at most ${DEFAULT_MAX_PROMPT_BYTES / 1024} KiB`);
    expect(flat).toContain(`at most ${MAX_IMAGES};`);
    expect(flat).toContain(`the newest ${MAX_LOG_FILES} files are kept`);
    expect(flat).toContain(`rate-limited (${DEFAULT_STARTS_PER_MINUTE} per minute)`);
    expect(flat).toContain(`more than ${DEFAULT_STARTS_PER_MINUTE} jobs were started within a minute`);
    // The flags that would lift the sandbox are named as never used.
    for (const never of ['danger-full-access', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-skip-permissions', 'bypassPermissions']) expect(doc).toContain(never);
  });

  it('documents the Codex Windows sandbox setting, its sources, its event code and the two fixes', () => {
    const flat = doc.replace(/\s+/g, ' ');
    expect(doc).toContain('### Settings');
    expect(doc).toContain('`codexWindowsSandbox`');
    for (const value of CODEX_WINDOWS_SANDBOXES) expect(doc, value).toContain(`\`"${value}"\``);
    expect(DEFAULT_AGENT_SETTINGS).toEqual({ codexWindowsSandbox: 'config' });
    expect(flat).toContain('`"config"` (default)');
    // Every source of AgentSettingsInfo.sources, strongest first.
    const sources: Record<AgentSettingSource, true> = { option: true, flag: true, user: true, default: true };
    const rows = Object.keys(sources).map((s) => doc.indexOf(`| \`${s}\` |`));
    expect(rows.every((at) => at > 0)).toBe(true);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    // The fields of the settings answer, the file, the override, the flag (a real flag: see the command-line test).
    for (const field of ['settings', 'sources', 'user', 'file', 'windows', 'notes']) expect(doc, field).toContain(`"${field}":`);
    expect(doc).toContain('~/.rev2d/settings.json');
    expect(doc).toContain('{"agent": {"codexWindowsSandbox": "unelevated"}}');
    expect(doc).toContain('-c windows.sandbox="unelevated"');
    expect(doc).toContain('`rev2d edit --agent-codex-sandbox unelevated`');
    expect(doc).toContain('PUT /api/agent/settings {"codexWindowsSandbox": "unelevated"}');
    expect(flat).toContain('never part of a job request');
    // The event code, the stalled status and its time, the known error texts, both fixes.
    expect(doc).toContain(`\`${CODEX_WINDOWS_SANDBOX_CODE}\``);
    expect(doc).toContain('`stalled`');
    expect(flat).toContain(`no event for ${DEFAULT_STALL_MS / 1000} seconds`);
    for (const text of ['orchestrator_helper_exit_nonzero', 'setup helper exited', 'CreateProcessWithLogonW', 'windows sandbox failed', 'code-mode host closed its stdout']) expect(doc, text).toContain(text);
    expect(flat).toContain('run `codex` once in an administrator terminal and accept its sandbox setup');
    expect(flat).toContain('`codex doctor` is not a reliable signal');
    // The hints the events carry say the same as the documentation.
    expect(windowsSandboxHint({ codexWindowsSandbox: 'config' })).toContain('run "codex" once in an administrator terminal and accept its sandbox setup');
    expect(windowsSandboxHint({ codexWindowsSandbox: 'config' })).toContain('PUT /api/agent/settings {"codexWindowsSandbox": "unelevated"}');
  });

  it('has working links and anchors', () => {
    const anchors = new Set([...prose.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1])));
    const links = [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(8);
    for (const link of links) {
      if (/^[a-z]+:/i.test(link)) continue;
      const [target, hash] = link.split('#');
      if (target) expect(existsSync(path.resolve(path.dirname(file), target)), link).toBe(true);
      else expect(anchors.has(hash), link).toBe(true);
    }
    // The CLI reference points here.
    expect(readFileSync(path.join(PACKAGE_ROOT, 'docs', 'CLI.md'), 'utf8')).toContain('](AGENT-BRIDGE.md)');
  });

  it('shows rev2d command lines with real commands and flags', () => {
    const lines = [...doc.matchAll(/^(?:rev2d|npx rev2d) +(\S+)(.*)$/gm), ...prose.matchAll(/`rev2d +([a-z]+)([^`]*)`/g)];
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const [text, name, rest] of lines) {
      const command = COMMANDS.find((c) => c.name === name);
      expect(command, text).toBeDefined();
      const flags = new Set(commandFlags(command!).flatMap((f) => [`--${f.name}`, ...(f.type === 'boolean' ? [`--no-${f.name}`] : [])]));
      for (const flag of rest.replace(/\s+#\s.*$/, '').match(/--[a-z][a-z-]*/g) ?? []) expect(flags.has(flag), `${text}: ${flag}`).toBe(true);
    }
  });
});
