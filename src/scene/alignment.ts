/** ElevenLabs character timing and word timing, without audio or filesystem dependencies. */
import type { Diagnostic } from '../core/types.js';
import { suggest } from '../core/address.js';
import { sceneDiagnostic, type Scene, type SceneTime } from './schema.js';

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}
export interface ResolvedCue {
  path: string;
  cue: string;
  time: number;
}
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function parseAlignment(input: unknown): { words: WordTiming[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const bad = (path: string, message: string) =>
    diagnostics.push(
      sceneDiagnostic(
        'scene-alignment-format',
        path,
        message,
        'provide ordered {word,start,end} entries or ElevenLabs character timestamps in seconds',
      ),
    );
  const words: WordTiming[] = [];
  const object = input as Record<string, unknown> | null;
  const data = Array.isArray(input) ? input : (object?.normalized_alignment ?? object?.alignment ?? input);
  if (Array.isArray(data)) {
    data.forEach((entry: unknown, i) => {
      const w = entry as Partial<WordTiming> | null;
      if (
        !w ||
        typeof w.word !== 'string' ||
        !Number.isFinite(w.start) ||
        !Number.isFinite(w.end) ||
        w.start! < 0 ||
        w.end! < w.start!
      )
        bad('/' + i, 'invalid word timing');
      else words.push({ word: w.word, start: w.start!, end: w.end! });
    });
  } else {
    const a = data as {
      characters?: unknown[];
      character_start_times_seconds?: unknown[];
      character_end_times_seconds?: unknown[];
    } | null;
    const chars = a?.characters,
      starts = a?.character_start_times_seconds,
      ends = a?.character_end_times_seconds;
    if (
      !Array.isArray(chars) ||
      !Array.isArray(starts) ||
      !Array.isArray(ends) ||
      chars.length !== starts.length ||
      chars.length !== ends.length
    )
      bad('', 'character and timing arrays must have equal lengths');
    else {
      let current: WordTiming | null = null;
      let previousStart = -Infinity;
      const flush = () => {
        if (current && normalizeText(current.word)) words.push(current);
        current = null;
      };
      chars.forEach((c, i) => {
        const start = starts[i],
          end = ends[i];
        if (
          typeof c !== 'string' ||
          typeof start !== 'number' ||
          typeof end !== 'number' ||
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end < start
        ) {
          bad('/characters/' + i, 'invalid character timing');
          return;
        }
        if (start < previousStart) bad('/characters/' + i, 'character starts must be ordered');
        previousStart = start;
        for (const ch of c) {
          if (/\s/u.test(ch)) flush();
          else {
            current ??= { word: '', start, end };
            current.word += ch;
            current.end = end;
          }
        }
      });
      flush();
    }
  }
  words.forEach((w, i) => {
    if (i && w.start < words[i - 1].start) bad('/' + i, 'word starts must be ordered');
  });
  return { words, diagnostics };
}

export function resolveCue(
  cue: SceneTime,
  words: readonly WordTiming[],
  offset = 0,
  after = -Infinity,
): number | null {
  if (typeof cue === 'number') return cue;
  let text = cue;
  const shift = /([+-]\d+(?:\.\d+)?)$/.exec(text);
  const delta = shift ? Number(shift[1]) : 0;
  if (shift) text = text.slice(0, -shift[0].length);
  if (text === '@end') return words.length ? words[words.length - 1].end - offset + delta : null;
  const end = text.endsWith('@end');
  if (end) text = text.slice(0, -4);
  const local = words.filter((w) => w.end > offset && w.start >= offset - 1e-8);
  let match: WordTiming | undefined;
  if (/^@word:[1-9]\d*$/.test(text)) match = local[Number(text.slice(6)) - 1];
  else if (text.startsWith('@text:')) {
    const query = normalizeText(text.slice(6));
    for (let i = 0; query && i < local.length; i++) {
      if (local[i].start - offset <= after + 1e-8) continue;
      let phrase = '';
      for (let j = i; j < local.length; j++) {
        phrase = normalizeText(phrase + ' ' + local[j].word);
        if (phrase === query) {
          match = { word: phrase, start: local[i].start, end: local[j].end };
          break;
        }
        if (!query.startsWith(phrase)) break;
      }
      if (match) break;
    }
  }
  return match ? (end ? match.end : match.start) - offset + delta : null;
}

/** Each ordered list has its own previous-cue cursor; other lists never affect its matches. */
export function resolveSceneCues(
  input: Scene,
  words: readonly WordTiming[],
): { scene: Scene; cues: ResolvedCue[]; diagnostics: Diagnostic[] } {
  const scene = structuredClone(input),
    cues: ResolvedCue[] = [],
    diagnostics: Diagnostic[] = [];
  const offset = scene.narration?.offset ?? 0;
  const timeNames = new Set(['t', 'start', 'end']);
  function visit(value: unknown, path: string, cursor: { after: number }): void {
    if (Array.isArray(value)) {
      const listCursor = { after: -Infinity };
      const ordered = value.some((v) => v && typeof v === 'object' && ('t' in v || 'start' in v));
      value.forEach((v, i) => visit(v, path + '/' + i, ordered ? listCursor : { after: -Infinity }));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      const pointer = path + '/' + k.replaceAll('~', '~0').replaceAll('/', '~1');
      if (timeNames.has(k) && (typeof v === 'number' || typeof v === 'string')) {
        const t = resolveCue(v, words, offset, cursor.after);
        if (t === null) {
          const nearby = words
            .filter((w) => w.start >= offset)
            .slice(0, 30)
            .map((w) => w.word);
          diagnostics.push(
            sceneDiagnostic(
              'scene-cue-not-found',
              pointer,
              `narration cue not found: ${v}`,
              suggest(String(v).replace(/^@text:/, ''), nearby) ??
                `available words: ${nearby.join(', ') || '(alignment missing)'}`,
            ),
          );
        } else {
          (value as Record<string, unknown>)[k] = t;
          cursor.after = t;
          if (typeof v === 'string') cues.push({ path: pointer, cue: v, time: t });
        }
      } else visit(v, pointer, cursor);
    }
  }
  visit(scene.layers, '/layers', { after: -Infinity });
  visit(scene.tracks, '/tracks', { after: -Infinity });
  visit(scene.camera, '/camera', { after: -Infinity });
  return { scene, cues, diagnostics };
}
