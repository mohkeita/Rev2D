/**
 * Starter models for `rev2d new` / MCP `rev2d_create_model`.
 * "blank" and "empty" are generated in code; other templates are the example models shipped in examples/.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository/package root (two levels above src/api or dist/api). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXAMPLES_DIR = path.join(PACKAGE_ROOT, 'examples');

export interface BlankOptions {
  name?: string;
  width?: number;
  height?: number;
}

/** A small but complete model: one parameter driving a warp, a bone-attached part, an idle animation. */
export function blankModel(opts: BlankOptions = {}): Record<string, unknown> {
  const w = opts.width ?? 512;
  const h = opts.height ?? 512;
  const cx = Math.round(w / 2);
  const cy = Math.round(h / 2);
  const r = Math.round(Math.min(w, h) * 0.25);
  return {
    format: 'rev2d',
    version: 1,
    meta: { name: opts.name ?? 'untitled', width: w, height: h, background: '#20242c' },
    parameters: [
      { id: 'Lean', min: -1, max: 1, default: 0, description: 'Lean the body left/right' },
      { id: 'Squash', min: 0, max: 1, default: 0, description: 'Squash the body down' },
    ],
    bones: [{ id: 'root', x: cx, y: cy + r, length: 0 }],
    warps: [{ id: 'bodyWarp', parent: 'root', rect: [cx - r - 8, cy - r - 8, 2 * r + 16, 2 * r + 16], cols: 2, rows: 2 }],
    parts: [
      {
        id: 'body',
        parent: 'bodyWarp',
        shape: { type: 'ellipse', cx, cy, rx: r, ry: r, detail: 12 },
        fill: { type: 'radial', center: [cx - r * 0.3, cy - r * 0.3], radius: r * 1.4, stops: [[0, '#9be7ff'], [1, '#2f7fd8']] },
        stroke: { color: '#10325e', width: 3 },
      },
      {
        id: 'eye',
        parent: 'bodyWarp',
        shape: { type: 'ellipse', cx, cy: cy - Math.round(r * 0.15), rx: Math.round(r * 0.12), ry: Math.round(r * 0.2) },
        fill: '#10325e',
        z: 1,
      },
    ],
    bindings: [
      {
        target: 'warp:bodyWarp.offsets',
        params: ['Lean'],
        keys: [
          { at: [-1], value: { '0': [-r * 0.4, 0], '1': [-r * 0.4, 0], '2': [-r * 0.4, 0], '3': [-r * 0.2, 0], '4': [-r * 0.2, 0], '5': [-r * 0.2, 0] } },
          { at: [0], value: {} },
          { at: [1], value: { '0': [r * 0.4, 0], '1': [r * 0.4, 0], '2': [r * 0.4, 0], '3': [r * 0.2, 0], '4': [r * 0.2, 0], '5': [r * 0.2, 0] } },
        ],
      },
      { target: 'bone:root.scaleY', params: ['Squash'], keys: [{ at: [0], value: 1 }, { at: [1], value: 0.8 }] },
      { target: 'bone:root.scaleX', params: ['Squash'], keys: [{ at: [0], value: 1 }, { at: [1], value: 1.15 }] },
    ],
    animations: [
      {
        id: 'idle',
        duration: 2,
        loop: true,
        tracks: [
          {
            target: 'param:Lean',
            keys: [
              { t: 0, v: -0.5, ease: 'inOutSine' },
              { t: 1, v: 0.5, ease: 'inOutSine' },
              { t: 2, v: -0.5 },
            ],
          },
          {
            target: 'param:Squash',
            keys: [
              { t: 0, v: 0, ease: 'inOutSine' },
              { t: 0.5, v: 0.4, ease: 'inOutSine' },
              { t: 1, v: 0, ease: 'inOutSine' },
              { t: 1.5, v: 0.4, ease: 'inOutSine' },
              { t: 2, v: 0 },
            ],
          },
        ],
      },
    ],
  };
}

/** Templates generated in code, in list order (they shadow examples of the same name). */
export const BUILTIN_TEMPLATES = ['blank', 'empty'] as const;

/**
 * Nothing but format, version and meta: the starting point for a model built entirely with ops
 * (no sample parameters, bones or parts to delete first).
 */
export function emptyModel(opts: BlankOptions = {}): Record<string, unknown> {
  return { format: 'rev2d', version: 1, meta: { name: opts.name ?? 'untitled', width: opts.width ?? 512, height: opts.height ?? 512 } };
}

/**
 * Locale-independent name order: case-insensitive, ties broken by code units. Directory listing
 * order differs between file systems (NTFS sorts, ext4 does not), so template lists are sorted with
 * this to be identical on every OS.
 */
export function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Template names: the built-in "blank" and "empty" first, then every <dir>/<name>/<name>.r2d.json
 * sorted by name (compareNames), so the list is the same on every OS. An example named like a
 * built-in template is shadowed by it and not listed twice.
 */
export function listTemplates(examplesDir: string = EXAMPLES_DIR): string[] {
  const examples: string[] = [];
  try {
    for (const d of readdirSync(examplesDir, { withFileTypes: true })) {
      if ((BUILTIN_TEMPLATES as readonly string[]).includes(d.name) || !d.isDirectory()) continue;
      if (existsSync(path.join(examplesDir, d.name, `${d.name}.r2d.json`))) examples.push(d.name);
    }
  } catch {
    // no examples directory (e.g. trimmed install)
  }
  return [...BUILTIN_TEMPLATES, ...examples.sort(compareNames)];
}

/**
 * Load a template as raw JSON. Example templates reference textures relative to their own folder;
 * `textureFiles` lists absolute paths the caller must copy next to the new model.
 */
export function loadTemplate(name: string, opts: BlankOptions = {}): { doc: Record<string, unknown>; textureFiles: string[] } {
  if (name === 'blank') return { doc: blankModel(opts), textureFiles: [] };
  if (name === 'empty') return { doc: emptyModel(opts), textureFiles: [] };
  const file = path.join(EXAMPLES_DIR, name, `${name}.r2d.json`);
  if (!existsSync(file)) throw new Error(`unknown template "${name}" (available: ${listTemplates().join(', ')})`);
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (opts.name) (doc.meta as Record<string, unknown>).name = opts.name;
  const textureFiles = ((doc.textures as Array<{ path: string }> | undefined) ?? [])
    .filter((t) => !t.path.startsWith('data:'))
    .map((t) => path.join(EXAMPLES_DIR, name, t.path));
  return { doc, textureFiles };
}
