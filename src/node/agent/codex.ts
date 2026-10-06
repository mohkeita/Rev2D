/**
 * Provider "codex": the OpenAI Codex CLI in non-interactive mode.
 *
 *   codex exec [-i <image>]... --json --color never -s <sandbox> --skip-git-repo-check -C <cwd>
 *              [-m <model>] [-c model_reasoning_effort="<effort>"] [-c windows.sandbox="unelevated"]
 *              --enable|--disable image_generation -
 *   codex exec <the same options> resume [-i <image>]... <thread id> -
 *
 * The prompt is "-" (read from stdin). Options of `codex exec` such as -s and -C are not accepted
 * after `resume`, so they come before it. The sandbox is always given explicitly (read-only or
 * workspace-write), which overrides whatever ~/.codex/config.toml says; exec mode never asks for
 * approval, so anything outside the sandbox simply fails. `-c windows.sandbox="unelevated"` is only
 * added on Windows when the bridge's codexWindowsSandbox setting asks for it (see below).
 *
 * With --json, stdout is JSON lines (codex-rs exec events):
 *   {"type":"thread.started","thread_id":"..."}        {"type":"turn.started"}
 *   {"type":"item.started|item.updated|item.completed","item":{"id":"item_0","type":"...",...}}
 *   {"type":"turn.completed","usage":{...}}            {"type":"turn.failed","error":{"message":"..."}}
 *   {"type":"error","message":"..."}
 * Item types: agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search,
 * todo_list, error (anything else is reported as a generic tool call).
 */
import { CODEX_WINDOWS_SANDBOX_CODE, type AgentEventBody, type AgentFileChange, type AgentItemPhase, type AgentItemStatus } from './types.js';
import {
  MAX_MESSAGE_CHARS,
  MAX_OUTPUT_CHARS,
  MAX_REASONING_CHARS,
  SESSION_ID,
  clip,
  count,
  isRecord,
  parseRecord,
  preview,
  str,
  tail,
  type AgentProvider,
  type ParsedLine,
  type ProviderProblem,
  type ProviderRun,
  type StreamParser,
} from './provider.js';

const PHASES: Record<string, AgentItemPhase> = { 'item.started': 'started', 'item.updated': 'updated', 'item.completed': 'completed' };

function itemStatus(raw: unknown, phase: AgentItemPhase): AgentItemStatus {
  switch (raw) {
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'declined':
      return 'declined';
    default:
      return phase === 'completed' ? 'completed' : 'running';
  }
}

function fileChanges(raw: unknown): AgentFileChange[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentFileChange[] = [];
  for (const c of raw) {
    if (!isRecord(c) || typeof c.path !== 'string') continue;
    out.push({ path: c.path, kind: c.kind === 'add' || c.kind === 'delete' ? c.kind : 'update' });
  }
  return out;
}

function itemEvents(item: Record<string, unknown>, phase: AgentItemPhase): AgentEventBody[] {
  const id = str(item.id) || 'item';
  const status = itemStatus(item.status, phase);
  switch (item.type) {
    case 'agent_message': {
      if (phase !== 'completed') return [];
      const t = clip(str(item.text), MAX_MESSAGE_CHARS);
      return [{ type: 'message', text: t.text, ...(t.truncated ? { truncated: true } : {}) }];
    }
    case 'reasoning': {
      if (phase !== 'completed') return [];
      const t = clip(str(item.text), MAX_REASONING_CHARS);
      return [{ type: 'reasoning', text: t.text, ...(t.truncated ? { truncated: true } : {}) }];
    }
    case 'command_execution': {
      const out = tail(str(item.aggregated_output), MAX_OUTPUT_CHARS);
      return [
        {
          type: 'command',
          id,
          phase,
          status,
          command: str(item.command),
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          output: out.text,
          outputTruncated: out.truncated,
        },
      ];
    }
    case 'file_change':
      return [{ type: 'file', id, phase, status, changes: fileChanges(item.changes) }];
    case 'mcp_tool_call': {
      const error = isRecord(item.error) ? str(item.error.message) : str(item.error);
      const input = preview(item.arguments);
      const result = preview(isRecord(item.result) ? (item.result.structured_content ?? item.result.content ?? item.result) : item.result);
      return [
        {
          type: 'tool',
          id,
          phase,
          status,
          tool: str(item.tool) || 'tool',
          ...(str(item.server) ? { server: str(item.server) } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(result !== undefined ? { result } : {}),
          ...(error ? { error } : {}),
        },
      ];
    }
    case 'web_search': {
      const input = preview(item.query);
      return [{ type: 'tool', id, phase, status, tool: 'web_search', ...(input !== undefined ? { input } : {}) }];
    }
    case 'todo_list': {
      const items = Array.isArray(item.items) ? item.items.filter(isRecord).map((t) => ({ text: str(t.text), done: t.completed === true })) : [];
      return [{ type: 'todo', id, items }];
    }
    case 'error':
      return [{ type: 'error', message: str(item.message) || 'the agent reported an error' }];
    default: {
      // An item type this version does not know (image generation, collaboration tools, ...): show it
      // as a tool call named after the type, with the rest of the item as its input.
      const { id: _id, type, status: _status, ...rest } = item;
      const input = Object.keys(rest).length ? preview(rest) : undefined;
      return [{ type: 'tool', id, phase, status, tool: str(type) || 'unknown', ...(input !== undefined ? { input } : {}) }];
    }
  }
}

function parseLine(text: string): ParsedLine {
  const rec = parseRecord(text);
  if (!rec) return { events: [], unknown: true };
  const type = str(rec.type);
  if (type === 'thread.started') {
    const id = str(rec.thread_id);
    if (!SESSION_ID.test(id)) return { events: [], unknown: true };
    return { events: [{ type: 'status', status: 'session', text: `Codex session ${id}`, sessionId: id }], sessionId: id };
  }
  if (type === 'turn.started') return { events: [{ type: 'status', status: 'turn', text: 'the agent is working' }] };
  if (type === 'turn.completed') {
    const u = isRecord(rec.usage) ? rec.usage : {};
    const usage = {
      inputTokens: count(u.input_tokens),
      cachedInputTokens: count(u.cached_input_tokens),
      outputTokens: count(u.output_tokens),
      reasoningTokens: count(u.reasoning_output_tokens),
    };
    return { events: [{ type: 'usage', ...usage }], usage };
  }
  if (type === 'turn.failed') {
    const message = (isRecord(rec.error) ? str(rec.error.message) : str(rec.error)) || 'the turn failed';
    return { events: [{ type: 'error', message }], failure: message };
  }
  if (type === 'error') return { events: [{ type: 'error', message: str(rec.message) || 'the agent reported an error' }] };
  const phase = PHASES[type];
  if (phase && isRecord(rec.item)) return { events: itemEvents(rec.item, phase) };
  return { events: [], unknown: true };
}

const usesUnelevatedSandbox = (run: ProviderRun) => run.platform === 'win32' && run.codexWindowsSandbox === 'unelevated';

// ----------------------------------------------------------------------------- the Windows sandbox problem
//
// On Windows, Codex starts every command through one of two sandbox implementations ([windows] sandbox
// in ~/.codex/config.toml). "elevated" needs a one-time administrator setup; when that setup is broken
// or out of date no command starts, and the agent cannot call the Rev2D CLI. Seen with Codex 0.160:
//   - a command item with exit code -1 and the output "Failed to create unified exec process:
//     orchestrator_helper_exit_nonzero: setup helper exited with status Some(143)", and on stderr
//     "ERROR codex_core::tools::router: error=exec_command failed: CreateProcess {...}";
//   - no item at all for minutes, with "error=code-mode host closed its stdout" on stderr;
//   - "windows sandbox failed: CreateProcessWithLogonW failed: 1326" (codex sandbox).
// "codex doctor" is not a reliable signal for it. "unelevated" works without any setup.

const WINDOWS_SANDBOX_FAILURE = /orchestrator_helper_exit_nonzero|setup helper exited|CreateProcessWithLogonW|windows sandbox failed|code-mode host closed its stdout/i;

const REPAIR_ELEVATED = 'run "codex" once in an administrator terminal and accept its sandbox setup';

/** What to do about a Codex Windows sandbox that cannot start commands (never "switch to unelevated" when that is already on). */
export function windowsSandboxHint(run: Pick<ProviderRun, 'codexWindowsSandbox'>): string {
  if (run.codexWindowsSandbox === 'unelevated') {
    return `the bridge already asks Codex for its unelevated sandbox (codexWindowsSandbox is "unelevated"), and commands still do not start: update Codex ("codex update"), or repair its elevated sandbox (${REPAIR_ELEVATED}) and set codexWindowsSandbox back to "config"`;
  }
  return (
    `two ways to fix it: (1) repair Codex's elevated sandbox: ${REPAIR_ELEVATED}; or (2) let the bridge use Codex's unelevated sandbox, which needs no setup: ` +
    'PUT /api/agent/settings {"codexWindowsSandbox": "unelevated"} (the agent settings of the editor), or start the editor with "rev2d edit --agent-codex-sandbox unelevated"'
  );
}

/** The text of an event in which a sandbox failure would show: a failed command's output, an error, a failed tool call. */
function failureText(event: AgentEventBody): string {
  if (event.type === 'command') return event.status === 'failed' || (event.exitCode !== null && event.exitCode !== 0) ? event.output : '';
  if (event.type === 'error') return event.message;
  if (event.type === 'tool') return event.error ?? '';
  return '';
}

function diagnose(seen: { event?: AgentEventBody; stderr?: string }, run: ProviderRun): ProviderProblem | null {
  if (run.platform !== 'win32') return null;
  const text = seen.stderr ?? (seen.event ? failureText(seen.event) : '');
  if (!text || !WINDOWS_SANDBOX_FAILURE.test(text)) return null;
  return {
    code: CODEX_WINDOWS_SANDBOX_CODE,
    message: 'Codex cannot start commands in its Windows sandbox, so it cannot run the Rev2D CLI',
    hint: windowsSandboxHint(run),
  };
}

function stallNotice(run: ProviderRun, silentMs: number): { text: string; hint: string; code: string } | null {
  if (run.platform !== 'win32') return null;
  const silent = silentMs >= 1000 ? `${Math.round(silentMs / 1000)} s` : `${silentMs} ms`;
  return {
    code: CODEX_WINDOWS_SANDBOX_CODE,
    text: `Codex has reported nothing for ${silent}. A long command or image generation can take that long; it is also how a Codex Windows sandbox that cannot start commands looks. The job keeps running.`,
    hint: `if nothing arrives: cancel the job; then ${windowsSandboxHint(run)}`,
  };
}

function buildArgs(run: ProviderRun): string[] {
  // Images come first: "-i" takes several values, so a flag has to follow them before the "-" prompt.
  const images = run.images.flatMap((image) => ['-i', image]);
  const options = [
    '--json',
    '--color',
    'never',
    '-s',
    run.sandbox,
    '--skip-git-repo-check',
    '-C',
    run.cwd,
    ...(run.model ? ['-m', run.model] : []),
    ...(run.effort ? ['-c', `model_reasoning_effort="${run.effort}"`] : []),
    // Opt-in (the codexWindowsSandbox setting): Codex's sandbox implementation that needs no setup.
    ...(usesUnelevatedSandbox(run) ? ['-c', 'windows.sandbox="unelevated"'] : []),
    run.allowImageGeneration ? '--enable' : '--disable',
    'image_generation',
  ];
  if (run.resumeSession) return ['exec', ...options, 'resume', ...images, '--json', run.resumeSession, '-'];
  return ['exec', ...images, ...options, '-'];
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  envOverride: 'REV2D_AGENT_CODEX',
  features: { imageGeneration: true },
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  installHint: 'install the Codex CLI ("npm install -g @openai/codex") and sign in with "codex login"; or set REV2D_AGENT_CODEX to its executable',
  loginHint: 'sign in to Codex: run "codex login" in a terminal ("codex login status" tells whether you are signed in), then try again',
  parseVersion: (text) => /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text)?.[1] ?? null,
  isAuthError: (text) => /not logged in|codex login|\b401\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|token (?:is |has )?expired|refresh token|sign in again|login required|authentication (?:failed|required|error)/i.test(text),
  buildArgs,
  diagnose,
  stallNotice,
  createParser: (): StreamParser => ({ line: parseLine }),
};
