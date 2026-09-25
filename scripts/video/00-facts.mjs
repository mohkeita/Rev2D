/**
 * Step 0 - facts the video may state, measured instead of typed: the CLI command list
 * (`rev2d help`), the example models, the MCP tool count (see 05-mcp) and the test count
 * (`npx vitest run`, JSON reporter).
 *
 *   node scripts/video/00-facts.mjs            # includes the test run (~1 min)
 *   node scripts/video/00-facts.mjs --no-tests
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ASSETS, ROOT, bytesOf, commandEntry, ensureDir, log, must, rel, runCli, updateManifest } from './lib.mjs';

const dir = ensureDir(path.join(ASSETS, 'facts'));
const entries = [];

const help = must(runCli(['help']));
writeFileSync(path.join(dir, 'rev2d-help.txt'), help.stdout);
const commands = [...help.stdout.matchAll(/^ {2}(\w+) {2,}/gm)].map((m) => m[1]);
entries.push({ ...commandEntry('facts/cli-help', help), kind: 'command-output', path: rel(path.join(dir, 'rev2d-help.txt')), bytes: bytesOf(path.join(dir, 'rev2d-help.txt')), commands, count: commands.length });
log(`${commands.length} CLI commands: ${commands.join(', ')}`);

const examples = readdirSync(path.join(ROOT, 'examples'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
entries.push({ id: 'facts/examples', kind: 'fact', examples, count: examples.length });

if (!process.argv.includes('--no-tests')) {
  const out = path.join(dir, 'vitest.json');
  rmSync(out, { force: true });
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile=${rel(out)}`], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 });
  const durationMs = Math.round(performance.now() - t0);
  writeFileSync(path.join(dir, 'vitest-stdout.txt'), (r.stdout ?? '') + (r.stderr ?? ''));
  if (!existsSync(out)) throw new Error(`vitest wrote no JSON report (exit ${r.status})`);
  const j = JSON.parse(readFileSync(out, 'utf8'));
  const failed = j.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'failed').map((a) => `${path.relative(ROOT, f.name)} > ${a.fullName}`));
  const summary = { total: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, skipped: j.numPendingTests + (j.numTodoTests ?? 0), files: j.numTotalTestSuites, success: j.success, failedTests: failed };
  writeFileSync(out, JSON.stringify({ summary, report: j }));
  entries.push({ id: 'facts/tests', kind: 'fact', command: 'npx vitest run', exitCode: r.status, startedAt, durationMs, ...summary, path: rel(path.join(dir, 'vitest-stdout.txt')) });
  log(`tests: ${summary.passed} passed / ${summary.total} total, ${summary.failed} failed, ${summary.skipped} skipped`);
}
updateManifest('00-facts', entries);
