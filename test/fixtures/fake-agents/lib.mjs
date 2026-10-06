// Shared helpers of the fake agent CLIs (fake-codex.mjs, fake-claude.mjs). The fakes stand in for the
// real Codex CLI / Claude Code in the agent-bridge tests: they read the prompt from stdin like the real
// ones and answer with JSON lines, replay a recorded session, fail, or hang.
//
// The scenario is named by a `[[fake:<name>]]` marker in the prompt, else by a `--fake=<name>` argument
// (the tests can put one into the command they hand to AgentManager), else by the FAKE_AGENT
// environment variable, else it is "echo".
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));

/** {name, args}: the scenario and the command line without the --fake argument. */
export function scenario(argv, prompt = '') {
  const flag = argv.find((a) => a.startsWith('--fake='));
  const marker = /\[\[fake:([a-z-]+)\]\]/.exec(prompt);
  return { name: marker ? marker[1] : flag ? flag.slice('--fake='.length) : (process.env.FAKE_AGENT ?? 'echo'), args: argv.filter((a) => a !== flag) };
}

/** Everything written to stdin until it is closed, as UTF-8 text. */
export function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/**
 * Write a recorded JSON-lines file to stdout in 7-byte pieces, so lines and multi-byte characters
 * arrive split across chunks like they can from a real process.
 */
export async function replay(file) {
  const bytes = readFileSync(path.join(HERE, file));
  for (let i = 0; i < bytes.length; i += 7) {
    await new Promise((resolve) => process.stdout.write(bytes.subarray(i, i + 7), resolve));
  }
}

/** Never exit (until killed). */
export function hang() {
  setInterval(() => undefined, 1000);
}

/** Start a process of its own that never exits; returns its pid (the "process tree" of the cancel tests). */
export function spawnGrandchild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', windowsHide: true });
  return child.pid;
}

/** Exit after stdout was flushed (process.exit alone can cut piped output short). */
export function exit(code) {
  process.stdout.write('', () => process.exit(code));
}
