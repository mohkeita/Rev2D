import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as lipsync from '../index.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const sources = readdirSync(DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: readFileSync(path.join(DIR, name), 'utf8') }));

describe('src/lipsync as a module', () => {
  it('exports the contract', () => {
    for (const name of ['VISEME_SHAPES', 'textToMorae', 'lipSyncFromText', 'mouthShapeAt', 'decodeWav', 'lipSyncFromAudio']) {
      expect(lipsync, name).toHaveProperty(name);
    }
    for (const name of ['textToMorae', 'lipSyncFromText', 'mouthShapeAt', 'decodeWav', 'lipSyncFromAudio', 'lipSyncFromMorae', 'moraeBeats', 'mouthCurves', 'mouthEnvelope']) {
      expect(typeof (lipsync as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('the viseme table is the one the avatar builder places its mouth sprites on', () => {
    expect(lipsync.VISEME_SHAPES).toEqual({
      a: { open: 1, form: 0 },
      i: { open: 0.35, form: 1 },
      u: { open: 0.35, form: -1 },
      e: { open: 0.6, form: 0.5 },
      o: { open: 0.75, form: -1 },
      n: { open: 0, form: 0 },
      rest: { open: 0, form: 0 },
    });
  });

  it('is browser-safe: it imports only its own files and src/core, and no Node API', () => {
    expect(sources.length).toBeGreaterThanOrEqual(9);
    for (const { name, text } of sources) {
      const imports = [...text.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec.startsWith('./') || spec.startsWith('../core/'), `${name} imports ${spec}`).toBe(true);
        expect(spec.endsWith('.js'), `${name}: ${spec} must end in .js`).toBe(true);
      }
      expect(/\b(require\(|process\.|Buffer\b|__dirname|import\()/.test(text), `${name} uses a Node API`).toBe(false);
    }
  });

  it('is deterministic by construction: no clock, no random numbers, no locale', () => {
    for (const { name, text } of sources) {
      expect(/Date\.now|new Date|Math\.random|performance\.now|toLocale|localeCompare|Intl\./.test(text), name).toBe(false);
    }
  });
});
