/**
 * The package works when installed, not only in the repo: the manifest points at the compiled
 * build, the build runs under plain node (no tsx), and bin/rev2d.js picks the right entry point.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../templates.js';

const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const BIN = path.join(PACKAGE_ROOT, 'bin', 'rev2d.js');
/** Scratch dirs inside the repo (out/ is git-ignored) resolve the repo's node_modules; os.tmpdir() ones do not. */
const OUT = path.join(PACKAGE_ROOT, 'out');
const cleanup: string[] = [];

function scratch(inRepo: boolean): string {
  const base = inRepo ? OUT : os.tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'rev2d-pkgtest-'));
  cleanup.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function node(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): SpawnSyncReturns<string> {
  const env = { ...process.env, ...opts.env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, args, { cwd: opts.cwd ?? PACKAGE_ROOT, encoding: 'utf8', env, timeout: 60_000 });
}

describe('package manifest', () => {
  const conditions = Object.entries(pkg.exports as Record<string, string | Record<string, string>>).filter(([k]) => k !== './package.json');

  it('exports the compiled build (types + default) and the sources under the "rev2d-source" condition', () => {
    expect(conditions.length).toBeGreaterThan(0);
    for (const [subpath, target] of conditions) {
      expect(typeof target, subpath).toBe('object');
      const entry = target as Record<string, string>;
      // Node picks the first matching condition: the source condition must come first, "default" last.
      expect(Object.keys(entry), subpath).toEqual(['rev2d-source', 'types', 'default']);
      const src = entry['rev2d-source'];
      expect(src, subpath).toMatch(/^\.\/src\/.+\.ts$/);
      expect(existsSync(path.join(PACKAGE_ROOT, src)), `${subpath}: ${src}`).toBe(true);
      const rel = src.slice('./src/'.length, -'.ts'.length);
      expect(entry.types, subpath).toBe(`./dist/${rel}.d.ts`);
      expect(entry.default, subpath).toBe(`./dist/${rel}.js`);
    }
    expect(pkg.exports['./package.json']).toBe('./package.json');
    expect(pkg.main).toBe(pkg.exports['.'].default);
    expect(pkg.types).toBe(pkg.exports['.'].types);
  });

  it('ships the build, launcher, docs and examples but not the sources, and installs without scripts', () => {
    for (const f of ['dist', 'bin', 'docs', 'examples', 'LICENSE']) expect(pkg.files).toContain(f);
    expect(pkg.files.some((f: string) => /^(\.\/)?src(\/|$)/.test(f))).toBe(false);
    expect(pkg.bin).toEqual({ rev2d: './bin/rev2d.js' });
    expect(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(existsSync(path.join(PACKAGE_ROOT, 'LICENSE'))).toBe(true);
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.build.json && npm run editor:build');
    // Installing the package must stay cheap: no lifecycle scripts that run on install.
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) expect(pkg.scripts[hook], hook).toBeUndefined();
  });

  it('declares every package the build imports as a dependency', () => {
    // Dev-only packages the build may load lazily (never in an installed package): vite serves the
    // editor sources only when dist/editor is not built.
    const DEV_ONLY_DYNAMIC = new Set(['vite']);
    const files = readdirSync(path.join(PACKAGE_ROOT, 'src'), { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.split(/[\\/]/).includes('__tests__'),
    );
    const used = new Map<string, Set<'static' | 'dynamic'>>();
    for (const f of files) {
      const text = readFileSync(path.join(PACKAGE_ROOT, 'src', f), 'utf8');
      for (const m of text.matchAll(/^\s*(?:import|export)\s(?!type\s)[^'"]*?from\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/gm)) {
        const spec = m[1] ?? m[2];
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!used.has(name)) used.set(name, new Set());
        used.get(name)!.add(m[1] ? 'static' : 'dynamic');
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const [name, kinds] of used) {
      if (DEV_ONLY_DYNAMIC.has(name)) {
        expect([...kinds], `${name} may only be imported lazily`).toEqual(['dynamic']);
        continue;
      }
      expect(Object.keys(pkg.dependencies ?? {}), `${name} is imported by src/ but not a dependency`).toContain(name);
    }
  });

  it('builds src/ (without tests) into dist/ with declarations', () => {
    const build = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'tsconfig.build.json'), 'utf8'));
    expect(build.extends).toBe('./tsconfig.json');
    expect(build.compilerOptions).toMatchObject({ noEmit: false, rootDir: 'src', outDir: 'dist', declaration: true });
    expect(build.include).toEqual(['src/**/*.ts']);
    expect(build.exclude).toEqual(expect.arrayContaining(['src/**/*.test.ts', 'src/**/__tests__/**']));
  });
});

describe('compiled build', () => {
  let stage: string;
  let build: SpawnSyncReturns<string>;

  beforeAll(() => {
    // An installed-package layout: package.json + bin + dist (compiled here), no src/.
    stage = scratch(true);
    const tsc = path.join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    build = node([tsc, '-p', 'tsconfig.build.json', '--outDir', path.join(stage, 'dist')]);
    copyFileSync(path.join(PACKAGE_ROOT, 'package.json'), path.join(stage, 'package.json'));
    mkdirSync(path.join(stage, 'bin'));
    copyFileSync(BIN, path.join(stage, 'bin', 'rev2d.js'));
  }, 120_000);

  it('compiles without errors and emits every exported entry point', () => {
    expect(build.status, build.stdout + build.stderr).toBe(0);
    for (const [, target] of Object.entries(pkg.exports as Record<string, string | Record<string, string>>)) {
      if (typeof target === 'string') continue;
      for (const f of [target.types, target.default]) expect(existsSync(path.join(stage, f)), f).toBe(true);
    }
    expect(existsSync(path.join(stage, 'dist', 'ops', '__tests__'))).toBe(false);
  });

  it('runs the CLI under plain node', () => {
    const version = node([path.join(stage, 'dist', 'cli', 'main.js'), '--version']);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(pkg.version);
    const png = path.join(stage, 'minimal.png');
    const render = node([path.join(stage, 'dist', 'cli', 'main.js'), 'render', 'examples/minimal/minimal.r2d.json', '-o', png]);
    expect(render.status, render.stderr).toBe(0);
    expect(readFileSync(png).subarray(1, 4).toString('latin1')).toBe('PNG');
    // Without src/ the launcher runs the build.
    const bin = node([path.join(stage, 'bin', 'rev2d.js'), '--version']);
    expect(bin.status, bin.stderr).toBe(0);
    expect(bin.stdout.trim()).toBe(pkg.version);
  });

  it('imports the library entry under plain node', () => {
    const entry = pathToFileURL(path.join(stage, 'dist', 'index.js')).href;
    const script = `const r = await import(${JSON.stringify(entry)});
const m = await r.loadModelObject(r.blankModel({ width: 40, height: 30 }), process.cwd());
const f = r.renderFrame(m, { viewBox: 'fit' });
const ops = r.applyOps(r.blankModel(), [{ op: 'set', target: 'part:eye.opacity', value: 0.5 }]);
console.log(JSON.stringify({ size: [r.renderFrame(m).image.width, r.renderFrame(m).image.height], fit: f.viewBox.length, ok: ops.ok }));`;
    const out = node(['--input-type=module', '-e', script], { cwd: stage });
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ size: [40, 30], fit: 4, ok: true });
  });
});

describe('bin/rev2d.js', () => {
  const SOURCE_STUB = "export async function runCli(argv: string[]): Promise<void> {\n  const via: string = 'source';\n  process.stdout.write(`${via} ${argv.join(' ')}\\n`);\n}\n";
  const DIST_STUB = "export async function runCli(argv) {\n  process.stdout.write(`compiled ${argv.join(' ')}\\n`);\n}\n";

  /** A package root with the real launcher and stub entry points. */
  function layout(inRepo: boolean, parts: { source?: boolean; dist?: boolean }): string {
    const dir = scratch(inRepo);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'rev2d-stub', type: 'module' }));
    mkdirSync(path.join(dir, 'bin'));
    copyFileSync(BIN, path.join(dir, 'bin', 'rev2d.js'));
    if (parts.source) {
      mkdirSync(path.join(dir, 'src', 'cli'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'cli', 'main.ts'), SOURCE_STUB);
    }
    if (parts.dist) {
      mkdirSync(path.join(dir, 'dist', 'cli'), { recursive: true });
      writeFileSync(path.join(dir, 'dist', 'cli', 'main.js'), DIST_STUB);
    }
    return dir;
  }

  const run = (dir: string, env: Record<string, string | undefined> = {}) =>
    node([path.join(dir, 'bin', 'rev2d.js'), 'a', 'b'], { cwd: dir, env: { REV2D_RUNTIME: undefined, ...env } });

  /** tsx must not be resolvable from os.tmpdir() for the "installed package" cases. */
  function tsxReachable(dir: string): boolean {
    for (let d = dir; ; d = path.dirname(d)) {
      if (existsSync(path.join(d, 'node_modules', 'tsx'))) return true;
      if (path.dirname(d) === d) return false;
    }
  }

  it('prefers the TypeScript sources in a dev checkout, even when a (stale) dist exists', () => {
    const dir = layout(true, { source: true, dist: true });
    const r = run(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('source a b\n');
    const forced = run(dir, { REV2D_RUNTIME: 'dist' });
    expect(forced.stdout).toBe('compiled a b\n');
    const bad = run(dir, { REV2D_RUNTIME: 'bogus' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('REV2D_RUNTIME must be "dist" or "source", got "bogus"');
  });

  it('runs dist when there are no sources, and explains what is missing otherwise', () => {
    const installed = layout(true, { dist: true });
    expect(run(installed).stdout).toBe('compiled a b\n');
    const forced = run(installed, { REV2D_RUNTIME: 'source' });
    expect(forced.status).toBe(1);
    expect(forced.stderr).toMatch(/^error: REV2D_RUNTIME=source, but .*main\.ts does not exist\nhint: /);

    const empty = layout(false, {});
    const r = run(empty);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^error: rev2d is incomplete: .*main\.js is missing\nhint: reinstall the package/);
    const unbuilt = layout(true, { source: true });
    const d = run(unbuilt, { REV2D_RUNTIME: 'dist' });
    expect(d.status).toBe(1);
    expect(d.stderr).toContain('is not built');
  });

  it('falls back to dist when tsx is not installed', (ctx) => {
    const dir = layout(false, { source: true, dist: true });
    if (tsxReachable(dir)) ctx.skip();
    expect(run(dir).stdout).toBe('compiled a b\n');
    const forced = run(dir, { REV2D_RUNTIME: 'source' });
    expect(forced.status).toBe(1);
    expect(forced.stderr).toContain('REV2D_RUNTIME=source, but tsx is not installed');
    const sourceOnly = layout(false, { source: true });
    const r = run(sourceOnly);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('tsx is not installed to run the TypeScript sources, and dist/cli/main.js is not built');
  });
});
