/**
 * The interop docs name report codes ("spine-dark-color", "live2d-animation-replaced", ...) so that
 * readers can search for them. Every code a guide names must be one the converters really report:
 * a code that was renamed or removed in the source must not live on in the docs.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '../src/api/templates.js';

const DOCS = ['docs/INTEROP.md', 'docs/CLI.md', 'docs/MCP.md', 'AGENTS.md', 'README.md', 'README.ko.md', 'llms.txt'];
const CODE = /^(?:spine|live2d)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') sourceFiles(p, out);
    } else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every string literal in the converters and their file IO that has the form of a report code. */
function reportedCodes(): Set<string> {
  const files = [...sourceFiles(path.join(PACKAGE_ROOT, 'src', 'interop')), path.join(PACKAGE_ROOT, 'src', 'node', 'interop.ts')];
  const out = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/(['"`])((?:spine|live2d)-[a-z0-9-]+)\1/g)) if (CODE.test(m[2])) out.add(m[2]);
  }
  return out;
}

/** Codes a guide names: `code` in backticks, and the first column of report lines in output samples. */
function namedCodes(text: string): string[] {
  const inline = [...text.matchAll(/`((?:spine|live2d)-[a-z0-9-]+)`/g)].map((m) => m[1]);
  const lines = [...text.matchAll(/^ {2}((?:spine|live2d)-[a-z0-9-]+) {2,}\S/gm)].map((m) => m[1]);
  return [...new Set([...inline, ...lines])].filter((c) => CODE.test(c));
}

describe('interop docs', () => {
  const known = reportedCodes();

  it('finds the report codes in the sources', () => {
    expect(known.size).toBeGreaterThan(150);
    for (const code of ['spine-dark-color', 'spine-path-constraint', 'spine-timeline-physics', 'live2d-animation-replaced', 'live2d-unknown-parameter']) {
      expect(known.has(code), code).toBe(true);
    }
  });

  for (const rel of DOCS) {
    it(`${rel}: names only report codes the converters use`, () => {
      const named = namedCodes(readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8'));
      expect(named.filter((c) => !known.has(c))).toEqual([]);
    });
  }

  it('docs/INTEROP.md names the codes of everything a user should not miss', () => {
    const named = new Set(namedCodes(readFileSync(path.join(PACKAGE_ROOT, 'docs', 'INTEROP.md'), 'utf8')));
    expect(named.size).toBeGreaterThan(100);
    // Lost or replaced data, and behaviour that differs from the other tool.
    for (const code of [
      'spine-path-constraint',
      'spine-physics-constraint',
      'spine-dark-color',
      'spine-ik-nonuniform-scale',
      'spine-weighted-offsets',
      'spine-paint-animated',
      'spine-mask-inverted',
      'live2d-animation-replaced',
      'live2d-physics-replaced',
      'live2d-unknown-parameter',
      'live2d-loop-flag',
      'live2d-curve-order',
      'live2d-physics-translation-output',
    ]) {
      expect(named.has(code), code).toBe(true);
    }
  });
});
