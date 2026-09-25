/**
 * Relative links and #anchors in the guides resolve: every linked file exists and every anchor
 * matches a heading of the target Markdown file (GitHub slug rules, duplicates get -1, -2, ...).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '../src/api/templates.js';

/** The guides owned by the docs: README, agent guides, recipes, architecture, examples guide. */
export const GUIDE_FILES = ['README.md', 'README.ko.md', 'AGENTS.md', 'CLAUDE.md', 'llms.txt', 'docs/RECIPES.md', 'docs/ARCHITECTURE.md', 'examples/README.md'];

/** Text outside fenced code blocks (links inside code are examples, not links). */
function prose(text: string): string {
  return text.replace(/^```[\s\S]*?^```/gm, '');
}

/** GitHub heading slug: lower case, markup and punctuation removed, spaces to dashes. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');
}

function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const m of prose(readFileSync(file, 'utf8')).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

describe('guide links', () => {
  it('computes GitHub slugs', () => {
    expect(slug('14. Closed eyes that stay clean: path-morph eye + lash band')).toBe('14-closed-eyes-that-stay-clean-path-morph-eye--lash-band');
    expect(slug('Part 2: Developing Rev2D')).toBe('part-2-developing-rev2d');
    expect(slug('`rev2d sheet`')).toBe('rev2d-sheet');
  });

  for (const rel of GUIDE_FILES) {
    it(`${rel}: relative links and anchors resolve`, () => {
      const file = path.join(PACKAGE_ROOT, rel);
      const broken: string[] = [];
      for (const m of prose(readFileSync(file, 'utf8')).matchAll(/\]\(([^)\s]+)\)|src="([^"]+)"/g)) {
        const link = m[1] ?? m[2];
        if (/^[a-z]+:/i.test(link)) continue; // http(s), mailto, ...
        const [target, hash] = link.split('#');
        const abs = target ? path.resolve(path.dirname(file), decodeURIComponent(target)) : file;
        if (!existsSync(abs)) {
          broken.push(`${link}: no such file`);
          continue;
        }
        if (hash && abs.endsWith('.md') && !anchors(abs).has(decodeURIComponent(hash))) broken.push(`${link}: no heading with this anchor`);
      }
      expect(broken).toEqual([]);
    });
  }
});
