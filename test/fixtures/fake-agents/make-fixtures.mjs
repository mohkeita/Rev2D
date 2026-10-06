// Writes the JSON-lines sessions the fake agents replay (*.jsonl next to this file). They are checked
// in; run this again after changing a session: node test/fixtures/fake-agents/make-fixtures.mjs
//
//   codex-full.jsonl / claude-full.jsonl          every item / tool kind the parsers know, written by
//                                                 hand after the CLIs' stream formats
//   codex-recorded.jsonl / claude-recorded.jsonl  what the real CLIs printed for a one-word answer
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const write = (name, lines) => writeFileSync(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// ----------------------------------------------------------------------------- codex exec --json
const THREAD = '0199f3a1-7c2e-7d43-9b1a-2f6c5d4e3b2a';
const validate = 'node C:/Rev2D/bin/rev2d.js validate hero.r2d.json --json';
const renderArgs = { path: 'hero.r2d.json', overlay: ['bones'] };
const changes = [
  { path: 'hero.r2d.json', kind: 'update' },
  { path: 'out/head.png', kind: 'add' },
  { path: 'old.r2d.json', kind: 'delete' },
];
write('codex-full.jsonl', [
  { type: 'thread.started', thread_id: THREAD },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Planning the edit**\n\nRead the model, then widen the head warp.' } },
  { type: 'item.started', item: { id: 'item_1', type: 'todo_list', items: [{ text: 'Read the model', completed: false }, { text: 'Widen the head warp', completed: false }] } },
  { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: validate, aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: validate, aggregated_output: '[{"file":"hero.r2d.json","ok":true,"errors":0,"warnings":0}]\n', exit_code: 0, status: 'completed' } },
  { type: 'item.updated', item: { id: 'item_1', type: 'todo_list', items: [{ text: 'Read the model', completed: true }, { text: 'Widen the head warp', completed: false }] } },
  { type: 'item.started', item: { id: 'item_3', type: 'mcp_tool_call', server: 'rev2d', tool: 'rev2d_render', arguments: renderArgs, result: null, error: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'rev2d', tool: 'rev2d_render', arguments: renderArgs, result: { content: [{ type: 'text', text: 'rendered 512x512' }], structured_content: null }, error: null, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_4', type: 'mcp_tool_call', server: 'rev2d', tool: 'rev2d_inspect', arguments: { path: 'nope.r2d.json' }, result: null, error: { message: 'model file not found' }, status: 'failed' } },
  { type: 'item.started', item: { id: 'item_5', type: 'web_search', query: 'live2d head turn warp grid' } },
  { type: 'item.completed', item: { id: 'item_5', type: 'web_search', query: 'live2d head turn warp grid' } },
  { type: 'item.started', item: { id: 'item_6', type: 'file_change', changes, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_6', type: 'file_change', changes, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_7', type: 'command_execution', command: 'node C:/Rev2D/bin/rev2d.js render missing.r2d.json', aggregated_output: 'error: cannot read model file missing.r2d.json\n', exit_code: 1, status: 'failed' } },
  { type: 'item.completed', item: { id: 'item_8', type: 'error', message: 'command timed out after 120s' } },
  { type: 'item.completed', item: { id: 'item_9', type: 'image_generation', prompt: 'closed eye, same style', saved_path: 'variants/eye-closed.png', status: 'completed' } },
  { type: 'error', message: 'Reconnecting... 1/5' },
  { type: 'item.completed', item: { id: 'item_10', type: 'agent_message', text: 'Widened the head warp; `validate` shows 0 errors.\nUncertain: the hair strand roots (머리카락).' } },
  { type: 'turn.completed', usage: { input_tokens: 48213, cached_input_tokens: 31744, cache_write_input_tokens: 0, output_tokens: 1582, reasoning_output_tokens: 640 } },
]);

// ----------------------------------------------------------------------------- claude -p --output-format stream-json --verbose
const SESSION = '5b0c6f0e-93a4-4b7e-8f55-0a1b2c3d4e5f';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const assistant = (content) => ({
  type: 'assistant',
  message: { id: `msg_${n + 1}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content, stop_reason: null, usage: { input_tokens: 4, output_tokens: 20 } },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: uuid(),
});
const toolUse = (id, name, input) => assistant([{ type: 'tool_use', id, name, input }]);
const toolResult = (id, content, extra = {}, isError = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }] },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: uuid(),
  ...extra,
});
const final = 'Widened the head warp; validate shows 0 errors.\nUncertain: the hair strand roots (머리카락).';
write('claude-full.jsonl', [
  { type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', uuid: uuid(), session_id: SESSION },
  { type: 'system', subtype: 'init', cwd: 'C:\\work', session_id: SESSION, tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite'], mcp_servers: [], model: 'claude-sonnet-4-5', permissionMode: 'acceptEdits', apiKeySource: 'none', uuid: uuid() },
  assistant([{ type: 'thinking', thinking: 'The person wants a wider head warp. Read the model first.', signature: 'sig' }]),
  assistant([
    { type: 'text', text: "I'll read the model first." },
    { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'C:\\work\\hero.r2d.json' } },
  ]),
  toolResult('toolu_01', '     1\t{\n     2\t  "format": "rev2d"\n', { tool_use_result: { type: 'text', file: { filePath: 'C:\\work\\hero.r2d.json', numLines: 2 } } }),
  toolUse('toolu_02', 'TodoWrite', {
    todos: [
      { content: 'Read the model', status: 'completed', activeForm: 'Reading the model' },
      { content: 'Widen the head warp', status: 'in_progress', activeForm: 'Widening the head warp' },
    ],
  }),
  toolResult('toolu_02', 'Todos have been modified successfully.'),
  toolUse('toolu_03', 'Bash', { command: validate, description: 'Validate the model' }),
  toolResult('toolu_03', '[{"file":"hero.r2d.json","ok":true,"errors":0,"warnings":0}]', { tool_use_result: { stdout: '[{"file":"hero.r2d.json","ok":true,"errors":0,"warnings":0}]', stderr: '', interrupted: false } }),
  toolUse('toolu_04', 'Edit', { file_path: 'C:\\work\\hero.r2d.json', old_string: '"cols": 2', new_string: '"cols": 4' }),
  toolResult('toolu_04', 'The file C:\\work\\hero.r2d.json has been updated.', { tool_use_result: { filePath: 'C:\\work\\hero.r2d.json', oldString: '"cols": 2', newString: '"cols": 4' } }),
  toolUse('toolu_05', 'Write', { file_path: 'C:\\work\\out\\notes.txt', content: 'widened the head warp' }),
  toolResult('toolu_05', 'File created successfully at: C:\\work\\out\\notes.txt', { tool_use_result: { type: 'create', filePath: 'C:\\work\\out\\notes.txt' } }),
  toolUse('toolu_06', 'Write', { file_path: 'C:\\work\\hero.r2d.json', content: '{}' }),
  toolResult('toolu_06', 'The file C:\\work\\hero.r2d.json has been updated.', { tool_use_result: { type: 'update', filePath: 'C:\\work\\hero.r2d.json' } }),
  toolUse('toolu_07', 'Bash', { command: 'node C:/Rev2D/bin/rev2d.js render missing.r2d.json' }),
  toolResult('toolu_07', 'Exit code 1\nerror: cannot read model file missing.r2d.json', {}, true),
  toolUse('toolu_08', 'mcp__rev2d__rev2d_render', { path: 'hero.r2d.json' }),
  toolResult('toolu_08', [{ type: 'text', text: 'rendered 512x512' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }]),
  toolUse('toolu_09', 'Bash', { command: 'curl https://example.com' }),
  toolResult('toolu_09', "Claude requested permissions to use Bash, but you haven't granted it yet.", {}, true),
  { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 600, error: 'overloaded_error', uuid: uuid(), session_id: SESSION },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: uuid(), session_id: SESSION },
  assistant([{ type: 'text', text: final }]),
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 41234,
    duration_api_ms: 30211,
    num_turns: 9,
    result: final,
    stop_reason: 'end_turn',
    session_id: SESSION,
    total_cost_usd: 0.0931,
    usage: { input_tokens: 32, cache_creation_input_tokens: 5120, cache_read_input_tokens: 40960, output_tokens: 1204 },
    permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_09', tool_input: { command: 'curl https://example.com' } }],
    uuid: uuid(),
  },
]);
// ----------------------------------------------------------------------------- recorded sessions
// What the real CLIs printed for "Reply with exactly: OK" (Codex CLI 0.160.0, Claude Code 2.1.289 on
// Windows, October 2026), with ids, paths and account details replaced by neutral values and the long
// lists of the Claude init line (slash commands, skills, plugins) emptied.
write('codex-recorded.jsonl', [
  { type: 'thread.started', thread_id: '01a10ab1-0000-7000-8000-00000000c0de' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'OK' } },
  { type: 'turn.completed', usage: { input_tokens: 29260, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
]);

const REC = '8901b2bb-0000-4000-8000-00000000c0de';
const recUsage = {
  input_tokens: 2,
  cache_creation_input_tokens: 3666,
  cache_read_input_tokens: 3005,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3666 },
  output_tokens: 4,
  service_tier: 'standard',
  inference_geo: 'not_available',
};
write('claude-recorded.jsonl', [
  {
    type: 'system',
    subtype: 'init',
    cwd: 'C:\\work',
    session_id: REC,
    tools: ['Glob', 'Grep', 'Read'],
    mcp_servers: [],
    model: 'claude-opus-5-5',
    permissionMode: 'dontAsk',
    slash_commands: [],
    terminal_slash_commands: [],
    apiKeySource: 'none',
    claude_code_version: '2.1.289',
    output_style: 'default',
    agents: ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'],
    skills: [],
    plugins: [],
    capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'],
    analytics_disabled: false,
    product_feedback_disabled: false,
    uuid: '00000000-0000-4000-8000-0000000000a1',
    fast_mode_state: 'off',
    fast_mode_disabled_reason: 'sdk_opt_in_required',
    per_turn_effort_active: true,
    view_mode: 'default',
  },
  {
    type: 'assistant',
    message: {
      model: 'claude-opus-5-5',
      id: 'msg_00000000000000000000000a',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'OK' }],
      container: null,
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: recUsage,
      input_transformations: [],
      diagnostics: null,
      context_management: null,
    },
    parent_tool_use_id: null,
    session_id: REC,
    uuid: '00000000-0000-4000-8000-0000000000a2',
    timestamp: '2026-10-05T06:13:21.861Z',
    request_id: 'req_00000000000000000000000a',
  },
  {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', resetsAt: 1791655200, rateLimitType: 'seven_day', utilization: 0.1, isUsingOverage: false },
    uuid: '00000000-0000-4000-8000-0000000000a3',
    session_id: REC,
  },
  {
    duration_api_ms: 802,
    stop_reason: 'end_turn',
    session_id: REC,
    total_cost_usd: 0.030017,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 3666,
      cache_read_input_tokens: 3005,
      output_tokens: 4,
      output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      iterations: [{ input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 3005, cache_creation_input_tokens: 3666, type: 'message' }],
      speed: 'standard',
    },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 3005, cacheCreationInputTokens: 3666, costUSD: 0.030017, thinkingTokens: 0 } },
    permission_denials: [],
    terminal_reason: 'completed',
    is_error: false,
    num_turns: 1,
    subtype: 'success',
    api_error_status: null,
    result: 'OK',
    type: 'result',
    duration_ms: 2364,
    uuid: '00000000-0000-4000-8000-0000000000a4',
  },
]);
console.log('wrote the sessions to', dir);
