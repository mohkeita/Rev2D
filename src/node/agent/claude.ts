/**
 * Provider "claude": Claude Code in print mode.
 *
 *   claude -p --allowedTools <rules>... [--tools <list>] --permission-mode <mode> [--restricted]
 *          [--strict-mcp-config] [--permission-prompts none] [--model <m>] [--effort <e>]
 *          [--resume <session id>] --output-format stream-json --verbose
 *
 * The prompt is read from stdin (no prompt argument). Claude Code has no OS sandbox on every
 * platform, so the two sandboxes are built from its permission system:
 *
 *   read-only        only Read / Glob / Grep exist and are allowed; nothing else can run
 *   workspace-write  file edits inside the working directory are accepted (acceptEdits), and the ONE
 *                    command the agent may run is the Rev2D CLI ("node <bin/rev2d.js> ..."); every
 *                    other command or tool would need a permission prompt, which print mode denies
 *
 * Newer versions add --restricted (file tools confined to the working directory, command tools only
 * when --tools names them, the person's settings files with their hooks and allow rules ignored),
 * --strict-mcp-config (none of the person's MCP servers) and --permission-prompts none; they are used
 * when `claude --help` lists them. bypassPermissions and --dangerously-skip-permissions are never used.
 *
 * With --output-format stream-json --verbose, stdout is JSON lines:
 *   {"type":"system","subtype":"init","session_id":"...","model":"...","tools":[...]}
 *   {"type":"assistant","message":{"content":[{"type":"text"|"thinking"|"tool_use",...}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":...,"is_error":false}]}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"...","usage":{...},"total_cost_usd":0.01}
 * Other lines (hook events, rate-limit notices, partial messages) are kept in the raw log only.
 */
import type { AgentEffort, AgentEventBody, AgentFileChange } from './types.js';
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
  type ProviderRun,
  type StreamParser,
} from './provider.js';

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = ['Read', 'Glob', 'Grep'];

type Pending =
  | { kind: 'command'; command: string }
  | { kind: 'file'; changes: AgentFileChange[] }
  | { kind: 'tool'; tool: string; server?: string; input?: string };

/** Text of a tool_result `content`: a string, or a list of blocks whose text parts are joined. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRecord(b) ? (b.type === 'text' ? str(b.text) : `[${str(b.type) || 'block'}]`) : ''))
    .filter(Boolean)
    .join('\n');
}

/** "mcp__server__tool" -> {server, tool}; built-in tools keep their name. */
function toolName(name: string): { tool: string; server?: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : { tool: name };
}

class ClaudeParser implements StreamParser {
  private readonly pending = new Map<string, Pending>();
  private lastText = '';

  line(text: string): ParsedLine {
    const rec = parseRecord(text);
    if (!rec) return { events: [], unknown: true };
    switch (rec.type) {
      case 'system':
        return this.system(rec);
      case 'assistant':
        return { events: this.assistant(rec) };
      case 'user':
        return { events: this.user(rec) };
      case 'result':
        return this.result(rec);
      default:
        return { events: [], unknown: true };
    }
  }

  private system(rec: Record<string, unknown>): ParsedLine {
    if (rec.subtype === 'init') {
      const id = str(rec.session_id);
      if (!SESSION_ID.test(id)) return { events: [], unknown: true };
      const model = str(rec.model);
      return { events: [{ type: 'status', status: 'session', text: `Claude Code session ${id}${model ? ` (${model})` : ''}`, sessionId: id }], sessionId: id };
    }
    if (rec.subtype === 'api_retry') {
      const attempt = count(rec.attempt);
      return { events: [{ type: 'status', status: 'retry', text: `the API request is retried${attempt ? ` (attempt ${attempt})` : ''}${str(rec.error) ? `: ${str(rec.error)}` : ''}` }] };
    }
    return { events: [], unknown: true };
  }

  private assistant(rec: Record<string, unknown>): AgentEventBody[] {
    const content = isRecord(rec.message) ? rec.message.content : undefined;
    if (!Array.isArray(content)) return [];
    const events: AgentEventBody[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text') {
        const raw = str(block.text);
        if (!raw.trim()) continue;
        this.lastText = raw;
        const t = clip(raw, MAX_MESSAGE_CHARS);
        events.push({ type: 'message', text: t.text, ...(t.truncated ? { truncated: true } : {}) });
      } else if (block.type === 'thinking') {
        const raw = str(block.thinking);
        if (!raw.trim()) continue;
        const t = clip(raw, MAX_REASONING_CHARS);
        events.push({ type: 'reasoning', text: t.text, ...(t.truncated ? { truncated: true } : {}) });
      } else if (block.type === 'tool_use') {
        const event = this.toolUse(block);
        if (event) events.push(event);
      }
    }
    return events;
  }

  private toolUse(block: Record<string, unknown>): AgentEventBody | null {
    const id = str(block.id) || 'tool';
    const name = str(block.name) || 'tool';
    const input = isRecord(block.input) ? block.input : {};
    if (COMMAND_TOOLS.has(name)) {
      const command = str(input.command);
      this.pending.set(id, { kind: 'command', command });
      return { type: 'command', id, phase: 'started', status: 'running', command, exitCode: null, output: '', outputTruncated: false };
    }
    if (FILE_TOOLS.has(name)) {
      const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
      const changes: AgentFileChange[] = file ? [{ path: file, kind: name === 'Write' ? 'add' : 'update' }] : [];
      this.pending.set(id, { kind: 'file', changes });
      return { type: 'file', id, phase: 'started', status: 'running', changes };
    }
    if (name === 'TodoWrite') {
      const todos = Array.isArray(input.todos) ? input.todos.filter(isRecord) : [];
      return { type: 'todo', id, items: todos.map((t) => ({ text: str(t.content) || str(t.activeForm), done: t.status === 'completed' })) };
    }
    const named = toolName(name);
    const shown = preview(Object.keys(input).length ? input : undefined);
    const pending: Pending = { kind: 'tool', ...named, ...(shown !== undefined ? { input: shown } : {}) };
    this.pending.set(id, pending);
    return { type: 'tool', id, phase: 'started', status: 'running', tool: pending.tool, ...(pending.server ? { server: pending.server } : {}), ...(shown !== undefined ? { input: shown } : {}) };
  }

  private user(rec: Record<string, unknown>): AgentEventBody[] {
    const content = isRecord(rec.message) ? rec.message.content : undefined;
    if (!Array.isArray(content)) return [];
    const events: AgentEventBody[] = [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      const failed = block.is_error === true;
      const text = resultText(block.content);
      const status = failed ? 'failed' : 'completed';
      if (pending.kind === 'command') {
        const out = tail(text, MAX_OUTPUT_CHARS);
        const code = /^Exit code (\d+)/m.exec(text);
        events.push({
          type: 'command',
          id,
          phase: 'completed',
          status,
          command: pending.command,
          exitCode: code ? Number(code[1]) : failed ? null : 0,
          output: out.text,
          outputTruncated: out.truncated,
        });
      } else if (pending.kind === 'file') {
        // The structured result of Write says whether the file was created or replaced.
        const kind = isRecord(rec.tool_use_result) ? rec.tool_use_result.type : undefined;
        const changes = pending.changes.map((c) => (kind === 'create' ? { ...c, kind: 'add' as const } : kind === 'update' ? { ...c, kind: 'update' as const } : c));
        events.push({ type: 'file', id, phase: 'completed', status, changes });
      } else {
        const shown = preview(text || undefined);
        events.push({
          type: 'tool',
          id,
          phase: 'completed',
          status,
          tool: pending.tool,
          ...(pending.server ? { server: pending.server } : {}),
          ...(pending.input !== undefined ? { input: pending.input } : {}),
          ...(failed ? (shown !== undefined ? { error: shown } : {}) : shown !== undefined ? { result: shown } : {}),
        });
      }
    }
    return events;
  }

  private result(rec: Record<string, unknown>): ParsedLine {
    const events: AgentEventBody[] = [];
    const text = str(rec.result);
    const failed = rec.is_error === true || (typeof rec.subtype === 'string' && rec.subtype !== 'success');
    // The final answer normally arrived as an assistant message already; show it when it did not.
    if (!failed && text.trim() && text !== this.lastText) {
      const t = clip(text, MAX_MESSAGE_CHARS);
      events.push({ type: 'message', text: t.text, ...(t.truncated ? { truncated: true } : {}) });
    }
    const u = isRecord(rec.usage) ? rec.usage : {};
    const cached = count(u.cache_read_input_tokens);
    const usage = {
      inputTokens: count(u.input_tokens) + count(u.cache_creation_input_tokens) + cached,
      cachedInputTokens: cached,
      outputTokens: count(u.output_tokens),
      reasoningTokens: isRecord(u.output_tokens_details) ? count(u.output_tokens_details.thinking_tokens) : 0,
      ...(typeof rec.total_cost_usd === 'number' ? { costUsd: rec.total_cost_usd } : {}),
    };
    events.push({ type: 'usage', ...usage });
    const out: ParsedLine = { events, usage };
    const id = str(rec.session_id);
    if (SESSION_ID.test(id)) out.sessionId = id;
    if (failed) {
      const message = text.trim() || `Claude Code ended with ${str(rec.subtype) || 'an error'}`;
      events.push({ type: 'error', message });
      out.failure = message;
    } else if (text.trim()) {
      out.finalMessage = text;
    }
    return out;
  }
}

const EFFORT: Record<AgentEffort, string> = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

/** A path as it is written in permission rules and in the preamble: forward slashes. */
const slashed = (p: string) => p.split('\\').join('/');

/** Permission rules that let the agent run the Rev2D CLI and nothing else. */
export function rev2dCommandRules(rev2dBin: string, platform: NodeJS.Platform = process.platform): string[] {
  const bin = slashed(rev2dBin);
  const tools = platform === 'win32' ? ['Bash', 'PowerShell'] : ['Bash'];
  return tools.flatMap((tool) => [`${tool}(node ${bin} *)`, `${tool}(node "${bin}" *)`]);
}

function buildArgs(run: ProviderRun): string[] {
  // Without a help text (it could not be read) only the flags every 2.x version has are used.
  const has = (flag: string) => run.help !== undefined && run.help.includes(flag);
  const write = run.sandbox === 'workspace-write';
  const win = run.platform === 'win32';
  const fileTools = write ? [...READ_TOOLS, 'Edit', 'Write', 'TodoWrite'] : READ_TOOLS;
  const commandTools = write ? (win ? ['Bash', 'PowerShell'] : ['Bash']) : [];
  const mode = write ? 'acceptEdits' : has('dontAsk') ? 'dontAsk' : 'plan';
  return [
    '-p',
    '--allowedTools',
    ...fileTools,
    ...(write ? rev2dCommandRules(run.rev2dBin, run.platform) : []),
    ...(has('--tools ') ? ['--tools', [...fileTools, ...commandTools].join(',')] : []),
    '--permission-mode',
    mode,
    ...(has('--restricted') ? ['--restricted'] : []),
    ...(has('--strict-mcp-config') ? ['--strict-mcp-config'] : []),
    ...(has('--permission-prompts') ? ['--permission-prompts', 'none'] : []),
    ...(run.model ? ['--model', run.model] : []),
    ...(run.effort && has('--effort') ? ['--effort', EFFORT[run.effort]] : []),
    ...(run.resumeSession ? ['--resume', run.resumeSession] : []),
    '--output-format',
    'stream-json',
    '--verbose',
  ];
}

export const claudeProvider: AgentProvider = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  envOverride: 'REV2D_AGENT_CLAUDE',
  features: { imageGeneration: false },
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  installHint: 'install Claude Code (https://claude.com/claude-code) and sign in by running "claude" once; or set REV2D_AGENT_CLAUDE to its executable',
  loginHint: 'sign in to Claude Code: run "claude" in a terminal and use /login, then try again',
  needsHelp: true,
  parseVersion: (text) => /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text)?.[1] ?? null,
  isAuthError: (text) => /\/login|not logged in|invalid api key|authentication_error|\b401\b|oauth token (?:has )?expired|unauthori[sz]ed/i.test(text),
  buildArgs,
  // Claude Code has no flag for image attachments: the agent opens them with its Read tool.
  promptSuffix: (run) =>
    run.images.length ? `\n\nAttached images (open each one with your file-reading tool before you answer):\n${run.images.map((i) => `- ${slashed(i)}`).join('\n')}\n` : '',
  createParser: (): StreamParser => new ClaudeParser(),
};
