/**
 * Node-side model loading: read a .r2d.json file, validate it, decode its textures and build a Rig.
 * Everything that touches the filesystem lives here so core/ and render/ stay platform-neutral.
 */
import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, ImageRGBA, Model, TextureInfo } from '../core/types.js';
import { parseModelText, validateModel } from '../core/validate.js';
import { Rig } from '../core/rig.js';
import { decodePNG } from '../render/index.js';

export interface LoadedModel {
  /** Absolute path of the model file (null when loaded from an in-memory object). */
  file: string | null;
  /** Directory that texture paths resolve against. */
  baseDir: string;
  /** Normalized model; null when validation found errors. */
  model: Model | null;
  diagnostics: Diagnostic[];
  /** Decoded textures by id. */
  textures: Record<string, ImageRGBA>;
  /** Texture sizes by id (from decoded images, falling back to declared sizes). */
  textureInfo: Record<string, TextureInfo>;
  /** Ready-to-evaluate rig; null when the model is invalid or the rig failed to compile. */
  rig: Rig | null;
}

export function hasErrors(diags: Diagnostic[]): boolean {
  return diags.some((d) => d.severity === 'error');
}

/** Load, validate and compile a model file. Never throws for model problems; they become diagnostics. */
export async function loadModelFile(file: string): Promise<LoadedModel> {
  const abs = path.resolve(file);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (e) {
    return emptyResult(abs, path.dirname(abs), [unreadableModel(abs, e as NodeJS.ErrnoException)]);
  }
  const result = parseModelText(text);
  return finishLoad(abs, path.dirname(abs), result.model, result.diagnostics);
}

/** *.r2d.json files directly in `dir` (sorted; empty when it cannot be listed). */
export function modelFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.r2d.json'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The 'file-not-found' diagnostic for a model path that cannot be read. A directory names the model
 * files in it (did-you-mean when there is exactly one); a missing file names model files next to it.
 */
function unreadableModel(abs: string, e: NodeJS.ErrnoException): Diagnostic {
  const isDir = e.code === 'EISDIR' || (statSync(abs, { throwIfNoEntry: false })?.isDirectory() ?? false);
  const dir = isDir ? abs : path.dirname(abs);
  const files = modelFilesIn(dir).map((n) => path.join(dir, n));
  const list = files.length > 12 ? `${files.slice(0, 12).join(', ')}, ... (+${files.length - 12})` : files.join(', ');
  if (isDir) {
    const hint =
      files.length === 1 ? `did you mean ${files[0]}?` : files.length ? `model files in it: ${list}` : 'it contains no *.r2d.json file; give the path of a model file';
    return { severity: 'error', code: 'file-not-found', message: `${abs} is a directory, not a model file`, path: '', hint };
  }
  const diag: Diagnostic = { severity: 'error', code: 'file-not-found', message: `cannot read ${abs}: ${e.message}`, path: '' };
  if (e.code === 'ENOENT' && files.length) diag.hint = `model files in ${dir}: ${list}`;
  return diag;
}

/** Load from an already-parsed JSON object (e.g. an edited model in memory). */
export async function loadModelObject(obj: unknown, baseDir: string, file: string | null = null): Promise<LoadedModel> {
  const result = validateModel(obj);
  return finishLoad(file, baseDir, result.model, result.diagnostics);
}

function emptyResult(file: string | null, baseDir: string, diagnostics: Diagnostic[]): LoadedModel {
  return { file, baseDir, model: null, diagnostics, textures: {}, textureInfo: {}, rig: null };
}

async function finishLoad(
  file: string | null,
  baseDir: string,
  model: Model | null,
  diagnostics: Diagnostic[],
): Promise<LoadedModel> {
  if (!model) return emptyResult(file, baseDir, diagnostics);
  const { textures, textureInfo, diagnostics: texDiags } = await loadTextures(model, baseDir);
  const all = [...diagnostics, ...texDiags];
  if (hasErrors(texDiags)) return { file, baseDir, model, diagnostics: all, textures, textureInfo, rig: null };
  let rig: Rig | null = null;
  try {
    rig = new Rig(model, { textures: textureInfo });
  } catch (e) {
    all.push({ severity: 'error', code: 'rig-compile', message: (e as Error).message, path: '' });
  }
  return { file, baseDir, model, diagnostics: all, textures, textureInfo, rig };
}

/** Decode every texture of a model. Missing/corrupt files become 'texture-load' error diagnostics. */
export async function loadTextures(
  model: Model,
  baseDir: string,
): Promise<{ textures: Record<string, ImageRGBA>; textureInfo: Record<string, TextureInfo>; diagnostics: Diagnostic[] }> {
  const textures: Record<string, ImageRGBA> = {};
  const textureInfo: Record<string, TextureInfo> = {};
  const diagnostics: Diagnostic[] = [];
  await Promise.all(
    model.textures.map(async (tex, i) => {
      try {
        const bytes = await readTextureBytes(tex.path, baseDir);
        const img = decodePNG(bytes);
        textures[tex.id] = img;
        textureInfo[tex.id] = { width: img.width, height: img.height };
        if ((tex.width && tex.width !== img.width) || (tex.height && tex.height !== img.height)) {
          diagnostics.push({
            severity: 'warning',
            code: 'texture-size-mismatch',
            message: `texture "${tex.id}" is ${img.width}x${img.height} but declares ${tex.width ?? '?'}x${tex.height ?? '?'}`,
            path: `/textures/${i}`,
            hint: 'remove width/height or fix them; the decoded size is used',
          });
        }
      } catch (e) {
        diagnostics.push({
          severity: 'error',
          code: 'texture-load',
          message: `cannot load texture "${tex.id}" from "${tex.path.startsWith('data:') ? 'data URI' : tex.path}": ${(e as Error).message}`,
          path: `/textures/${i}/path`,
          hint: 'paths are relative to the model file; only PNG is supported',
        });
      }
    }),
  );
  return { textures, textureInfo, diagnostics };
}

async function readTextureBytes(src: string, baseDir: string): Promise<Uint8Array> {
  if (src.startsWith('data:')) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src);
    if (!m) throw new Error('malformed data URI');
    return m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'latin1');
  }
  return readFile(path.resolve(baseDir, src));
}
