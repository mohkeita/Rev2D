#!/usr/bin/env node
// A stand-in for Claude Code ("claude -p --output-format stream-json --verbose"): see lib.mjs for how a
// scenario is chosen.
//
//   echo          one turn whose answer is JSON {argv, prompt, cwd, resumed}: what the fake received
//   full          replays claude-full.jsonl (thinking, tools, edits, todos, a denied command), in small chunks
//   recorded      replays claude-recorded.jsonl (a real one-word session)
//   auth          a result line with is_error and "Please run /login", exit 1
//   max-turns     a result line with subtype error_max_turns, exit 1
//   result-only   no assistant line: the answer only arrives in the result line
//   hang          starts a process of its own, reports both pids, never exits
import { emit, exit, hang, readStdin, replay, scenario, spawnGrandchild } from './lib.mjs';

if (process.argv.includes('--version')) {
  console.log('0.0.0-fake (Claude Code)');
  process.exit(0);
}
if (process.argv.includes('--help')) {
  // The optional flags the provider looks for in the help text of a current version.
  console.log(
    [
      'Usage: claude [options] [command] [prompt]',
      '  --allowedTools, --allowed-tools <tools...>',
      '  --effort <level>',
      '  --permission-mode <mode>   (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")',
      '  --permission-prompts <target>',
      '  -p, --print',
      '  --restricted',
      '  -r, --resume [value]',
      '  --strict-mcp-config',
      '  --tools <tools...>',
    ].join('\n'),
  );
  process.exit(0);
}

const prompt = await readStdin();
const { name, args } = scenario(process.argv.slice(2), prompt);

const SESSION = '5b0c6f0e-0000-4000-8000-000000000001';
const resumeAt = args.indexOf('--resume');
const resumed = resumeAt >= 0;
const session = resumed ? args[resumeAt + 1] : SESSION;
const usage = { input_tokens: 12, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 40 };
const init = () => emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: session, tools: ['Read', 'Glob', 'Grep'], mcp_servers: [], model: 'claude-fake-1', permissionMode: 'acceptEdits' });
const say = (text) =>
  emit({ type: 'assistant', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: session });
const result = (text, extra = {}) =>
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 900, num_turns: 1, result: text, session_id: session, total_cost_usd: 0.0123, usage, ...extra });

switch (name) {
  case 'echo': {
    const text = JSON.stringify({ argv: args, prompt, cwd: process.cwd(), resumed });
    init();
    say(text);
    result(text);
    exit(0);
    break;
  }
  case 'full':
    await replay('claude-full.jsonl');
    exit(0);
    break;
  case 'recorded':
    await replay('claude-recorded.jsonl');
    exit(0);
    break;
  case 'auth':
    init();
    result('Invalid API key · Please run /login', { is_error: true });
    exit(1);
    break;
  case 'max-turns':
    init();
    say('working on it');
    emit({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 30, session_id: session, total_cost_usd: 0.5, usage });
    exit(1);
    break;
  case 'result-only':
    init();
    result('only in the result');
    exit(0);
    break;
  case 'hang':
    init();
    say(JSON.stringify({ pid: process.pid, child: spawnGrandchild() }));
    hang();
    break;
  default:
    process.stderr.write(`fake-claude: unknown scenario "${name}"\n`);
    exit(2);
}
