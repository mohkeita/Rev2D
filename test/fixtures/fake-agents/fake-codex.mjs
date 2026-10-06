#!/usr/bin/env node
// A stand-in for the Codex CLI ("codex exec --json ... -"): see lib.mjs for how a scenario is chosen.
//
//   echo         one turn whose agent message is JSON {argv, prompt, cwd, resumed}: what the fake received
//   full         replays codex-full.jsonl (every item type), split into small chunks
//   recorded     replays codex-recorded.jsonl (a real one-word session)
//   noise        junk lines (text, blank, a JSON array, an unknown event) around a normal turn; no final newline
//   auth         exits 1 with a "not logged in" message on stderr
//   turn-failed  a transient error event, then turn.failed with a 401, exit 1
//   soft-fail    turn.failed but exit code 0
//   crash        writes to stderr and exits 3 without any JSON
//   hang         starts a process of its own, reports both pids in an agent message, never exits
//   silent       never writes anything, never exits
//   chatty       writes an event every 30 ms, never exits
//   edit-model   changes meta.name of model.r2d.json in its working directory, reports the file change
//   sandbox-fail two commands that the CLI's own Windows sandbox could not start, then an apology
//   helper-exit  the broken "elevated" Windows sandbox as Codex 0.160 shows it: the agent waits, the command
//                ends with exit code -1 ("orchestrator_helper_exit_nonzero"), stderr names the same failure
//   host-closed  the other face of it: "code-mode host closed its stdout" on stderr, then silence forever
//   quoted       a successful command whose output merely quotes those error texts (reading the docs)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { emit, exit, hang, readStdin, replay, scenario, spawnGrandchild } from './lib.mjs';

if (process.argv.includes('--version')) {
  console.log('codex-cli 0.0.0-fake');
  process.exit(0);
}

const prompt = await readStdin();
const { name, args } = scenario(process.argv.slice(2), prompt);

const THREAD = '0199aaaa-0000-7000-8000-000000000001';
const resumed = args.includes('resume');
// codex exec ... resume [-i image]... --json <thread id> -
const thread = resumed ? args[args.length - 2] : THREAD;
const usage = { input_tokens: 1200, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 34, reasoning_output_tokens: 12 };
const message = (text, id = 'item_0') => emit({ type: 'item.completed', item: { id, type: 'agent_message', text } });

switch (name) {
  case 'echo':
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'turn.started' });
    message(JSON.stringify({ argv: args, prompt, cwd: process.cwd(), resumed }));
    emit({ type: 'turn.completed', usage });
    exit(0);
    break;
  case 'full':
    await replay('codex-full.jsonl');
    exit(0);
    break;
  case 'recorded':
    await replay('codex-recorded.jsonl');
    exit(0);
    break;
  case 'noise':
    process.stdout.write('Reading prompt from stdin...\n\n[1,2,3]\n{"type":"future.event","detail":1}\n{not json}\n');
    emit({ type: 'thread.started', thread_id: thread });
    message('still fine');
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage }));
    exit(0);
    break;
  case 'auth':
    process.stderr.write('Reading additional input from stdin...\nERROR: Not logged in. Run `codex login` to sign in.\n');
    exit(1);
    break;
  case 'turn-failed':
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'turn.started' });
    emit({ type: 'error', message: 'Reconnecting... 1/5' });
    emit({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: token expired' } });
    exit(1);
    break;
  case 'soft-fail':
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'turn.failed', error: { message: 'the model refused the request' } });
    exit(0);
    break;
  case 'crash':
    process.stderr.write('thread main panicked: something broke\n');
    exit(3);
    break;
  case 'hang':
    emit({ type: 'thread.started', thread_id: thread });
    message(JSON.stringify({ pid: process.pid, child: spawnGrandchild() }));
    hang();
    break;
  case 'silent':
    hang();
    break;
  case 'chatty': {
    emit({ type: 'thread.started', thread_id: thread });
    let i = 0;
    setInterval(() => emit({ type: 'item.completed', item: { id: `item_${i++}`, type: 'reasoning', text: `thinking ${i}` } }), 30);
    break;
  }
  case 'edit-model': {
    const file = path.join(process.cwd(), 'model.r2d.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.meta.name = 'edited-by-agent';
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'item.started', item: { id: 'item_0', type: 'file_change', changes: [{ path: file, kind: 'update' }], status: 'in_progress' } });
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'file_change', changes: [{ path: file, kind: 'update' }], status: 'completed' } });
    message('renamed the model', 'item_1');
    emit({ type: 'turn.completed', usage });
    exit(0);
    break;
  }
  case 'sandbox-fail': {
    const failed = (id, command) =>
      emit({ type: 'item.completed', item: { id, type: 'command_execution', command, aggregated_output: 'windows sandbox failed: CreateProcessWithLogonW failed: 1326\n', exit_code: 1, status: 'failed' } });
    emit({ type: 'thread.started', thread_id: thread });
    failed('item_0', 'node C:/Rev2D/bin/rev2d.js docs agents');
    failed('item_1', 'node C:/Rev2D/bin/rev2d.js validate model.r2d.json');
    message('I could not run any command in this environment.', 'item_2');
    emit({ type: 'turn.completed', usage });
    exit(0);
    break;
  }
  case 'helper-exit': {
    const failure = 'Failed to create unified exec process: orchestrator_helper_exit_nonzero: setup helper exited with status Some(143)';
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'turn.started' });
    emit({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'node --version', aggregated_output: '', exit_code: null, status: 'in_progress' } });
    message('The command is still pending.', 'item_1');
    process.stderr.write(`2026-10-05T07:00:00.000000Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\\"${failure}\\")" }\n`);
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'node --version', aggregated_output: failure, exit_code: -1, status: 'failed' } });
    message('I could not run the command in this environment.', 'item_2');
    emit({ type: 'turn.completed', usage });
    exit(0);
    break;
  }
  case 'host-closed':
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'turn.started' });
    process.stderr.write('2026-10-05T07:00:00.000000Z ERROR codex_core::tools::router: error=code-mode host closed its stdout\n');
    hang();
    break;
  case 'quoted':
    emit({ type: 'thread.started', thread_id: thread });
    emit({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'command_execution',
        command: 'cat docs/AGENT-BRIDGE.md',
        aggregated_output: 'windows sandbox failed: CreateProcessWithLogonW failed: 1326\norchestrator_helper_exit_nonzero: setup helper exited\ncode-mode host closed its stdout\n',
        exit_code: 0,
        status: 'completed',
      },
    });
    message('I read the troubleshooting section.', 'item_1');
    emit({ type: 'turn.completed', usage });
    exit(0);
    break;
  default:
    process.stderr.write(`fake-codex: unknown scenario "${name}"\n`);
    exit(2);
}
