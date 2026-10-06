/**
 * docs/AVATAR.md is the working guide the in-app avatar tasks send agents to ("rev2d docs avatar").
 * It must be served by the CLI and the MCP server, name only diagnostic codes the avatar builder
 * really reports (a renamed code must not live on in the docs), and cover every subcommand, variant
 * id and standard parameter the builder knows. Command lines and links of AVATAR.md are checked by
 * test/docs-commands.test.ts and test/docs-links.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli/main.js';
import { COMMANDS } from '../src/cli/commands/index.js';
import { DOC_TOPICS as CLI_TOPICS } from '../src/cli/commands/reference.js';
import { DOC_TOPICS as MCP_TOPICS, readDoc } from '../src/mcp/tools/docs.js';
import { GUIDE } from '../src/mcp/guide.js';
import { PACKAGE_ROOT } from '../src/api/templates.js';
import { AVATAR_DIAGNOSTIC_CODES, STANDARD_PARAMETERS, VARIANT_IDS } from '../src/avatar/index.js';

const AVATAR_MD = path.join(PACKAGE_ROOT, 'docs', 'AVATAR.md');
/** Guides that name avatar codes. */
const DOCS = ['docs/AVATAR.md', 'docs/CLI.md', 'docs/ARCHITECTURE.md', 'AGENTS.md', 'README.md', 'README.ko.md', 'llms.txt'];
const CODE = /^avatar-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') sourceFiles(p, out);
    } else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Every "avatar-..." string literal of the builder, its file IO, the CLI and the server: diagnostic
 * and build-issue codes, agent task kinds ("avatar-create") and event names ("avatar-job").
 */
function knownCodes(): Set<string> {
  const src = path.join(PACKAGE_ROOT, 'src');
  const files = [
    ...sourceFiles(path.join(src, 'avatar')),
    path.join(src, 'node', 'avatar.ts'),
    path.join(src, 'node', 'avatar-variants.ts'),
    path.join(src, 'cli', 'commands', 'avatar.ts'),
    path.join(src, 'server', 'avatar-routes.ts'),
    path.join(src, 'server', 'avatar-agent-tasks.ts'),
  ];
  const out = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/(['"`])(avatar-[a-z0-9-]+)\1/g)) if (CODE.test(m[2])) out.add(m[2]);
  }
  return out;
}

/** Codes a guide names in backticks. */
function namedCodes(text: string): string[] {
  return [...new Set([...text.matchAll(/`(avatar-[a-z0-9-]+)`/g)].map((m) => m[1]))].filter((c) => CODE.test(c));
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const buf = { stdout: '', stderr: '' };
  const code = await main(args, {
    stdout: { write: (s: string) => ((buf.stdout += s), true) },
    stderr: { write: (s: string) => ((buf.stderr += s), true) },
    cwd: PACKAGE_ROOT,
    openUrl: () => {
      throw new Error('tests must not open a browser');
    },
  });
  return { code, ...buf };
}

describe('avatar docs', () => {
  const text = readFileSync(AVATAR_MD, 'utf8');

  it('is served as "rev2d docs avatar", MCP rev2d_docs {topic: "avatar"} and named in the quickstart', async () => {
    expect(Object.keys(CLI_TOPICS)).toContain('avatar');
    expect(MCP_TOPICS).toContain('avatar');
    const printed = await cli(['docs', 'avatar']);
    expect(printed.code).toBe(0);
    expect(printed.stdout).toBe(text);
    const list = await cli(['docs', '--json']);
    const entry = JSON.parse(list.stdout).find((t: { topic: string }) => t.topic === 'avatar');
    expect(entry).toMatchObject({ available: true, path: AVATAR_MD });
    expect(await readDoc('avatar')).toBe(text);
    expect(GUIDE).toContain('rev2d_docs {topic: "avatar"}');
  });

  it('is the guide the in-app avatar tasks point to', () => {
    const tasks = readFileSync(path.join(PACKAGE_ROOT, 'src', 'server', 'avatar-agent-tasks.ts'), 'utf8');
    expect(tasks).toMatch(/docs avatar/);
  });

  it('knows the codes of the sources', () => {
    const known = knownCodes();
    for (const code of Object.keys(AVATAR_DIAGNOSTIC_CODES)) expect(known.has(code), code).toBe(true);
    for (const code of ['avatar-mesh-fold', 'avatar-chin-weight', 'avatar-hair-mask-empty', 'avatar-variant-stale']) expect(known.has(code), code).toBe(true);
  });

  for (const rel of DOCS) {
    it(`${rel}: names only avatar codes the sources use`, () => {
      const known = knownCodes();
      const named = namedCodes(readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8'));
      expect(named.filter((c) => !known.has(c))).toEqual([]);
    });
  }

  it('covers every avatar subcommand, variant id, standard parameter and review sheet', () => {
    const subcommands = COMMANDS.filter((c) => c.name.startsWith('avatar ')).map((c) => c.name);
    expect(subcommands.length).toBeGreaterThanOrEqual(10);
    for (const name of subcommands) expect(text, name).toContain(`rev2d ${name}`);
    for (const id of VARIANT_IDS) expect(text, id).toContain(`\`${id}\``);
    for (const id of Object.keys(STANDARD_PARAMETERS)) expect(text, id).toContain(`\`${id}\``);
    for (const sheet of ['poses.png', 'turn.png', 'eyes.png', 'mouth.png', 'summary.json']) expect(text, sheet).toContain(`review/${sheet}`);
    // The frequent spec diagnostics have a fix in the common-problems table.
    const named = new Set(namedCodes(text));
    for (const code of ['avatar-missing-landmark', 'avatar-eyes-swapped', 'avatar-eye-opening-outside-region', 'avatar-outside-head', 'avatar-mesh-fold', 'avatar-chin-weight']) {
      expect(named.has(code), code).toBe(true);
    }
  });
});
