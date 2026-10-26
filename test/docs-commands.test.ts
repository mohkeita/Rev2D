/**
 * Every `rev2d ...` command line the guides show (in code blocks and inline code) names a real
 * command and only flags that command accepts, so a copied command never fails with "unknown flag".
 * docs/CLI.md is checked by test/cli.test.ts; docs/RECIPES.md command blocks are run by
 * test/docs-recipes.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { COMMANDS } from '../src/cli/commands/index.js';
import { commandFlags } from '../src/cli/help.js';
import { PACKAGE_ROOT } from '../src/api/templates.js';

const FILES = ['docs/EPISODE.md','docs/SCENE.md', 'docs/LIBRARY.md', 'README.md', 'README.ko.md', 'AGENTS.md', 'CLAUDE.md', 'llms.txt', 'docs/RECIPES.md', 'docs/ARCHITECTURE.md', 'docs/INTEROP.md', 'docs/AVATAR.md', 'examples/README.md'];
const PREFIX = /^(?:npx rev2d|rev2d|node (?:\S*\/)?bin\/rev2d\.js|npm run rev2d --)\s+(.*)$/;

interface CommandLine {
  file: string;
  text: string;
}

/** Command lines from fenced code blocks (one per line) and from inline code spans. */
export function commandLines(file: string, text: string): CommandLine[] {
  const out: CommandLine[] = [];
  const fences = /^```[^\n]*\n([\s\S]*?)^```/gm;
  for (const m of text.matchAll(fences)) {
    for (const line of m[1].split(/\r?\n/)) out.push({ file, text: line.trim() });
  }
  for (const m of text.replace(fences, '').matchAll(/`([^`\n]+)`/g)) out.push({ file, text: m[1].trim() });
  return out.filter((l) => PREFIX.test(l.text));
}

/** Tokens of a shell line, keeping single-quoted arguments (JSON) together. */
function tokens(line: string): string[] {
  return [...line.replace(/\s+#\s.*$/, '').matchAll(/'[^']*'|"[^"]*"|\S+/g)].map((m) => m[0]);
}

interface Problem {
  file: string;
  text: string;
  problem: string;
}

function check(line: CommandLine): Problem | null {
  const rest = tokens(PREFIX.exec(line.text)![1]);
  const [first, second] = rest;
  // Placeholders and alternatives in prose ("rev2d <command>", "rev2d ...", "rev2d editor state|command|screenshot").
  const placeholder = (t: string | undefined) => t !== undefined && /[<[|]|\.\.\./.test(t);
  if (!first || placeholder(first) || first.startsWith('-')) return null;
  if (first === 'help') return null;
  const name = COMMANDS.some((c) => c.name === `${first} ${second}`) ? `${first} ${second}` : first;
  if (placeholder(second) && !COMMANDS.some((c) => c.name === first)) return null;
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) return { ...line, problem: `unknown command "${name}"` };
  const flags = new Set<string>();
  for (const f of commandFlags(cmd)) {
    flags.add(`--${f.name}`);
    if (f.short) flags.add(`-${f.short}`);
    if (f.type === 'boolean') flags.add(`--no-${f.name}`);
  }
  for (const tok of rest) {
    if (!/^--?[a-z]/i.test(tok)) continue;
    const flag = tok.split('=')[0];
    if (/^-o./.test(flag)) continue; // -ofile
    if (!flags.has(flag)) return { ...line, problem: `rev2d ${cmd.name} has no flag ${flag}` };
  }
  return null;
}

describe('command lines in the guides', () => {
  const all = FILES.flatMap((rel) => commandLines(rel, readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8')));

  it('finds the command lines', () => {
    expect(all.length).toBeGreaterThan(50);
    expect(check({ file: 'x', text: 'rev2d render m.r2d.json -o out.png --bogus' })?.problem).toBe('rev2d render has no flag --bogus');
    expect(check({ file: 'x', text: 'rev2d renderr m.r2d.json' })?.problem).toBe('unknown command "renderr"');
    expect(check({ file: 'x', text: "rev2d editor command '{\"type\":\"pause\"}' --json" })).toBeNull();
    expect(check({ file: 'x', text: 'rev2d gif m.r2d.json -o a.gif --anim idle --no-loop' })).toBeNull();
  });

  for (const rel of FILES) {
    it(`${rel}: every rev2d command and flag exists`, () => {
      const problems = all.filter((l) => l.file === rel).map(check).filter((p): p is Problem => p !== null);
      expect(problems.map((p) => `${p.problem}: ${p.text}`)).toEqual([]);
    });
  }
});
