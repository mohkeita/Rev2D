/**
 * "Import from computer": which of the picked files are sent (one model .json plus its .png
 * textures, or a Spine skeleton .json with its .atlas and .png pages), size caps, a quick
 * client-side check that the JSON is a Rev2D model or a Spine skeleton, and reading the files into
 * the ImportRequest payload (text for JSON and atlases, base64 for PNG). The server validates again
 * (and converts a Spine export). Also: which picked files a Live2D import can use.
 */
import { parseJsonc } from '../../../src/core/index.js';
import { atlasPageNames, detectInteropFile, isAtlasName, live2dFormatFromName, looksLikeSpineSkeleton, type DetectedFormat } from '../../../src/interop/detect.js';
import type { ImportRequest } from '../../../src/node/editor-registry.js';
import { formatSize } from './paths.js';

/**
 * Raw bytes accepted per import. PNGs travel base64-encoded (4/3 larger) inside a JSON body the
 * server caps at 64 MiB by default (POST /api/import), so the raw total must stay below ~48 MiB.
 */
export const MAX_IMPORT_BYTES = 40 * 1024 * 1024;

export interface PickedFile {
  name: string;
  size: number;
}

export interface ImportPlan {
  /** Name of the model file (a Rev2D model or a Spine skeleton), or null when none / several were picked. */
  model: string | null;
  textures: string[];
  /** Spine atlases (.atlas, .atlas.txt), sent along for a Spine skeleton. */
  atlases: string[];
  /** Files that are not imported (neither .json, .png nor an atlas). */
  skipped: string[];
  totalBytes: number;
  /** Why the pick cannot be imported, or null. */
  error: string | null;
}

const isJson = (name: string) => /\.jsonc?$/i.test(name);
const isPng = (name: string) => /\.png$/i.test(name);

export function planImport(files: readonly PickedFile[]): ImportPlan {
  const models = files.filter((f) => isJson(f.name));
  const textures = files.filter((f) => isPng(f.name));
  const atlases = files.filter((f) => isAtlasName(f.name));
  const skipped = files.filter((f) => !isJson(f.name) && !isPng(f.name) && !isAtlasName(f.name)).map((f) => f.name);
  const totalBytes = [...models, ...textures, ...atlases].reduce((n, f) => n + f.size, 0);
  let error: string | null = null;
  if (models.length === 0) error = 'Pick a model file (.json) with its PNG textures, or a Spine skeleton (.json) with its .atlas and PNG pages.';
  else if (models.every((m) => live2dFormatFromName(m.name) !== null)) {
    error = 'These are Live2D files: they are imported into an open model. Open or create a model, then use File > Import Live2D motions…';
  } else if (models.length > 1) error = `Pick one model file at a time (picked ${models.map((m) => m.name).join(', ')}).`;
  else if (totalBytes > MAX_IMPORT_BYTES) error = `The files are too large to import (${formatSize(totalBytes)}; the limit is ${formatSize(MAX_IMPORT_BYTES)}). Copy them into the workspace folder instead.`;
  return {
    model: models.length === 1 ? models[0].name : null,
    textures: textures.map((t) => t.name),
    atlases: atlases.map((a) => a.name),
    skipped,
    totalBytes,
    error,
  };
}

/**
 * Why `text` is neither a Rev2D model file nor a Spine skeleton export, or null when it looks like
 * one (the server validates fully).
 */
export function modelTextProblem(text: string): string | null {
  const parsed = parseJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!parsed.ok) return 'The .json file is not valid JSON.';
  const v = parsed.value as { format?: unknown } | null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'The .json file does not contain a JSON object.';
  if (v.format !== 'rev2d' && !looksLikeSpineSkeleton(v)) return 'The .json file is not a Rev2D model (it needs "format": "rev2d") nor a Spine skeleton export.';
  return null;
}

/** What a picked .json is: a Rev2D model, a Spine skeleton, a Live2D file, or null (unknown / unreadable). */
export function jsonKind(name: string, text: string): DetectedFormat | null {
  const parsed = parseJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  return detectInteropFile(name, parsed.ok ? parsed.value : undefined);
}

/**
 * Atlas pages of a Spine import compared with the picked PNGs, by file name: `pages` named in the
 * atlases, `missing` pages not picked, `unused` PNGs that are no page.
 */
export function spinePageCheck(atlasTexts: readonly string[], pickedPngs: readonly string[]): { pages: string[]; missing: string[]; unused: string[] } {
  const name = (p: string) => p.split(/[\\/]/).pop()!.toLowerCase();
  const pages = atlasTexts.flatMap((t) => atlasPageNames(t));
  const picked = new Set(pickedPngs.map(name));
  const pageNames = new Set(pages.map(name));
  return { pages, missing: pages.filter((p) => !picked.has(name(p))), unused: pickedPngs.filter((p) => !pageNames.has(name(p))) };
}

export interface Live2dPlan {
  files: Array<{ name: string; size: number; format: DetectedFormat | null }>;
  /** Number of Live2D files (by their double extension). */
  importable: number;
  /** Why nothing can be imported, or null. */
  error: string | null;
}

/** Which picked files a Live2D import uses (by name: .model3 / .motion3 / .exp3 / .physics3 / .cdi3 .json). */
export function planLive2d(files: readonly PickedFile[]): Live2dPlan {
  const list = files.map((f) => ({ name: f.name, size: f.size, format: live2dFormatFromName(f.name) }));
  const importable = list.filter((f) => f.format !== null).length;
  const model3 = list.filter((f) => f.format === 'live2d-model3').length;
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  let error: string | null = null;
  if (!importable) error = 'Pick Live2D files: .motion3.json, .exp3.json, .physics3.json, .cdi3.json, or a .model3.json with the files it lists.';
  else if (model3 > 1) error = 'Pick one .model3.json at a time.';
  else if (totalBytes > MAX_IMPORT_BYTES) error = `The files are too large to import (${formatSize(totalBytes)}; the limit is ${formatSize(MAX_IMPORT_BYTES)}).`;
  return { files: list, importable, error };
}

/**
 * Texture files the model references (textures[].path, data: URIs excluded) compared with the
 * picked PNGs, by file name: `missing` are referenced but not picked, `unused` picked but not referenced.
 */
export function textureCheck(modelText: string, pickedPngs: readonly string[]): { referenced: string[]; missing: string[]; unused: string[] } {
  const parsed = parseJsonc(modelText.charCodeAt(0) === 0xfeff ? modelText.slice(1) : modelText);
  const textures = parsed.ok ? (parsed.value as { textures?: unknown }).textures : undefined;
  const referenced: string[] = [];
  if (Array.isArray(textures)) {
    for (const t of textures) {
      const p = (t as { path?: unknown } | null)?.path;
      if (typeof p === 'string' && p && !p.startsWith('data:')) referenced.push(p);
    }
  }
  const name = (p: string) => p.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const picked = new Set(pickedPngs.map(name));
  const refNames = new Set(referenced.map(name));
  return {
    referenced,
    missing: referenced.filter((p) => !picked.has(name(p))),
    unused: pickedPngs.filter((p) => !refNames.has(name(p))),
  };
}

/** A referenced texture path as a safe relative import name ("a/b.png"), or null (absolute, "..", data:). */
function relativeImportName(p: string): string | null {
  if (!p || p.startsWith('data:') || /^([a-zA-Z]:)?[\\/]/.test(p)) return null;
  const segments = p.replace(/\\/g, '/').split('/').filter((s) => s !== '.');
  if (!segments.length || segments.some((s) => s === '' || s === '..' || /^[a-zA-Z]:$/.test(s))) return null;
  return segments.join('/');
}

/**
 * Where the picked PNGs go, relative to the import folder: a file picker only yields bare names, but
 * a model may reference its textures in a subfolder ("textures/atlas.png"). A picked PNG whose name
 * matches a referenced path's file name (case-insensitively) is placed at that path, so the model
 * finds it. Picked name -> import name, for the PNGs that move (or are renamed to the referenced case).
 */
export function texturePlacement(modelText: string, pickedPngs: readonly string[]): Record<string, string> {
  const { referenced } = textureCheck(modelText, []);
  const byName = new Map<string, string>();
  for (const ref of referenced) {
    const name = relativeImportName(ref);
    if (!name) continue;
    const key = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
    if (!byName.has(key)) byName.set(key, name);
  }
  const out: Record<string, string> = {};
  for (const picked of pickedPngs) {
    const target = byName.get(picked.toLowerCase());
    if (target && target !== picked) out[picked] = target;
  }
  return out;
}

/** Base64 of binary data (chunked: spreading a large array into fromCharCode overflows the stack). */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/**
 * Read the files of a plan into the ImportRequest payload (browser File objects). PNGs are named
 * after the path the model references them by (texturePlacement).
 */
export async function readImportFiles(files: readonly File[], plan: ImportPlan): Promise<ImportRequest['files']> {
  const model = files.find((f) => f.name === plan.model);
  const text = model ? await model.text() : '';
  const placement = texturePlacement(text, plan.textures);
  const out: ImportRequest['files'] = model ? [{ name: model.name, text }] : [];
  for (const f of files) {
    if (f !== model && plan.textures.includes(f.name)) {
      out.push({ name: placement[f.name] ?? f.name, base64: toBase64(new Uint8Array(await f.arrayBuffer())) });
    } else if (plan.atlases.includes(f.name)) {
      out.push({ name: f.name, text: await f.text() });
    }
  }
  return out;
}
