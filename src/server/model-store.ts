/**
 * The editor server's view of the model file on disk: raw text reads, writes made through the API,
 * change detection for watcher events (content hash for the model, stat signature for textures) and
 * a LoadedModel cache for rendering.
 *
 * Reads/writes and change detection are serialized so a watcher event can never observe a
 * half-finished API write, and a write's own file events are recognized as already known.
 *
 * Writes may name the version they are based on (its mtime): when the file changed on disk since,
 * the write is refused with 409 instead of silently replacing the other change (lost update).
 */
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJsonc } from '../core/validate.js';
import { loadModelFile, type LoadedModel } from '../node/load.js';
import { HttpError } from './http.js';

export interface ModelText {
  text: string;
  mtimeMs: number;
}

interface TextureRef {
  id: string;
  path: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Versions (mtime -> content hash) remembered for write-conflict checks. */
const KNOWN_VERSIONS = 64;

function sha1(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** Texture entries of a model text, read leniently (works while the model has validation errors). */
function textureRefs(text: string): TextureRef[] | null {
  const parsed = parseJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!parsed.ok) return null;
  const textures = (parsed.value as { textures?: unknown } | null)?.textures;
  if (!Array.isArray(textures)) return [];
  return textures.filter(
    (t): t is TextureRef => typeof t === 'object' && t !== null && typeof t.id === 'string' && typeof t.path === 'string',
  );
}

export class ModelStore {
  readonly dir: string;
  /** Content hash of the model file as last seen or written (null: missing). */
  private hash: string | null = null;
  private mtimeMs = 0;
  /** Texture files referenced by the model (absolute) -> stat signature. */
  private textureSigs = new Map<string, string>();
  /** Bumped on every detected or written change; part of the render cache key. */
  private version = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private cache: { key: string; loaded: Promise<LoadedModel> } | null = null;
  /** Content hashes of versions served, written or detected, by mtime (insertion order = age). */
  private readonly versions = new Map<number, string>();

  private constructor(readonly file: string) {
    this.dir = path.dirname(file);
  }

  /** Open an existing model file (throws a descriptive Error when it is missing). */
  static async open(file: string): Promise<ModelStore> {
    const store = new ModelStore(path.resolve(file));
    const bytes = await readFile(store.file).catch((e: NodeJS.ErrnoException) => {
      throw new Error(
        e.code === 'ENOENT'
          ? `model file not found: ${store.file} (create it first, e.g. with \`rev2d new\`)`
          : `cannot read model file ${store.file}: ${e.message}`,
      );
    });
    store.hash = sha1(bytes);
    store.mtimeMs = (await stat(store.file)).mtimeMs;
    store.remember(store.mtimeMs, store.hash);
    await store.retarget(bytes.toString('utf8'));
    return store;
  }

  /** Model file plus every texture file it references: what the watcher should watch. */
  watchedFiles(): string[] {
    return [this.file, ...this.textureSigs.keys()];
  }

  /** Current raw text (never a half-finished API write); 404 when the file is gone. */
  read(): Promise<ModelText> {
    return this.exclusive(async () => {
      try {
        const [bytes, st] = await Promise.all([readFile(this.file), stat(this.file)]);
        this.remember(st.mtimeMs, sha1(bytes));
        return { text: bytes.toString('utf8'), mtimeMs: st.mtimeMs };
      } catch (e) {
        throw this.readError(e as NodeJS.ErrnoException);
      }
    });
  }

  /**
   * Write new model text (verbatim) and record it as known, so its file events are not reported.
   *
   * With `baseMtimeMs` (the mtime of the version the text was derived from), the write is refused
   * with 409 {mtimeMs} when the file changed on disk since: its mtime differs AND its content is
   * neither that version's (e.g. a touch) nor the text being written. A missing file has nothing to lose.
   */
  write(text: string, baseMtimeMs?: number): Promise<number> {
    return this.exclusive(async () => {
      const bytes = Buffer.from(text, 'utf8');
      if (baseMtimeMs !== undefined) await this.checkBase(baseMtimeMs, bytes);
      try {
        await writeFile(this.file, bytes);
      } catch (e) {
        throw new HttpError(500, `cannot write ${this.file}: ${(e as Error).message}`, 'check that the file is writable and not locked by another program');
      }
      this.hash = sha1(bytes);
      this.mtimeMs = (await stat(this.file)).mtimeMs;
      this.remember(this.mtimeMs, this.hash);
      this.version++;
      await this.retarget(text);
      return this.mtimeMs;
    });
  }

  /**
   * Given files reported by the watcher, return those whose content really changed since last seen
   * (watchers report duplicates and our own writes). Updates the watched texture set as needed.
   */
  detectChanges(files: readonly string[]): Promise<{ changed: string[]; mtimeMs: number }> {
    return this.exclusive(async () => {
      const changed: string[] = [];
      const touched = new Set(files.map((f) => path.resolve(f)));
      if (touched.has(this.file)) {
        const bytes = await readFile(this.file).catch(() => null);
        const hash = bytes ? sha1(bytes) : null;
        if (hash !== this.hash) {
          this.hash = hash;
          // Deleted (or moved away) counts as a change too: the editor re-reads it, gets 404 and
          // keeps its document as unsaved, so it can be written back.
          changed.push(this.file);
          if (bytes) {
            this.mtimeMs = (await stat(this.file).catch(() => null))?.mtimeMs ?? this.mtimeMs;
            this.remember(this.mtimeMs, hash!);
            await this.retarget(bytes.toString('utf8'));
          }
        }
      }
      for (const [tex, sig] of this.textureSigs) {
        if (!touched.has(tex)) continue;
        const now = await statSignature(tex);
        if (now !== sig) {
          this.textureSigs.set(tex, now);
          changed.push(tex);
        }
      }
      if (changed.length) this.version++;
      return { changed, mtimeMs: this.mtimeMs };
    });
  }

  /** Validated + compiled model, cached until the model or one of its textures changes. */
  loaded(): Promise<LoadedModel> {
    return this.exclusive(async () => {
      const st = await stat(this.file).catch((e: NodeJS.ErrnoException) => {
        throw this.readError(e);
      });
      // The stat part also catches edits the watcher missed (e.g. while it fell back to polling).
      const key = `${this.version}:${st.mtimeMs}:${st.size}`;
      if (this.cache?.key !== key) this.cache = { key, loaded: loadModelFile(this.file) };
      return this.cache.loaded;
    });
  }

  /** PNG bytes of texture `id` of the current model (file relative to the model, or data: URI). */
  async texture(id: string): Promise<Buffer> {
    const { text } = await this.read();
    const refs = textureRefs(text);
    if (!refs) throw new HttpError(422, 'the model file has a JSON syntax error; textures cannot be resolved', 'GET /api/info shows the error location');
    const ref = refs.find((t) => t.id === id);
    if (!ref) {
      throw new HttpError(404, `unknown texture "${id}"`, refs.length ? `available: ${refs.map((t) => t.id).join(', ')}` : 'the model declares no textures');
    }
    let bytes: Buffer;
    if (ref.path.startsWith('data:')) {
      const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(ref.path);
      if (!m) throw new HttpError(422, `texture "${id}" has a malformed data URI`, 'expected data:image/png;base64,<data>');
      bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'latin1');
    } else {
      const abs = path.resolve(this.dir, ref.path);
      try {
        bytes = await readFile(abs);
      } catch (e) {
        throw new HttpError(404, `texture "${id}": cannot read ${abs}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, 'texture paths are relative to the model file');
      }
    }
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new HttpError(422, `texture "${id}" is not a PNG file`, 'only PNG textures are supported');
    }
    return bytes;
  }

  /** Resolves once queued reads/writes have finished. */
  async idle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  /** Throw 409 when the file on disk is a different version than `baseMtimeMs` (see write). */
  private async checkBase(baseMtimeMs: number, next: Buffer): Promise<void> {
    let current: Buffer;
    let mtimeMs: number;
    try {
      const [bytes, st] = await Promise.all([readFile(this.file), stat(this.file)]);
      current = bytes;
      mtimeMs = st.mtimeMs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw this.readError(e as NodeJS.ErrnoException);
    }
    if (mtimeMs === baseMtimeMs) return;
    const hash = sha1(current);
    this.remember(mtimeMs, hash);
    if (hash === this.versions.get(baseMtimeMs) || current.equals(next)) return;
    throw new HttpError(
      409,
      `the model file changed on disk since the version this write is based on (mtime ${baseMtimeMs}, now ${mtimeMs}); nothing was written`,
      'GET /api/model and apply the change to the new version; to overwrite the other change on purpose, PUT again with baseMtimeMs set to this mtimeMs',
      { mtimeMs },
    );
  }

  private remember(mtimeMs: number, hash: string): void {
    this.versions.delete(mtimeMs);
    this.versions.set(mtimeMs, hash);
    if (this.versions.size > KNOWN_VERSIONS) this.versions.delete(this.versions.keys().next().value!);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Re-derive the watched texture files from model text; new textures start from their current stat. */
  private async retarget(text: string): Promise<void> {
    const refs = textureRefs(text);
    if (!refs) return; // keep the previous set while the file does not parse
    const next = new Map<string, string>();
    for (const r of refs) {
      if (r.path.startsWith('data:')) continue;
      const abs = path.resolve(this.dir, r.path);
      next.set(abs, this.textureSigs.get(abs) ?? (await statSignature(abs)));
    }
    this.textureSigs = next;
  }

  private readError(e: NodeJS.ErrnoException): HttpError {
    return e.code === 'ENOENT'
      ? new HttpError(404, `model file not found: ${this.file}`, 'it was moved or deleted; restore it, or PUT /api/model to write it again')
      : new HttpError(500, `cannot read ${this.file}: ${e.message}`);
  }
}

async function statSignature(file: string): Promise<string> {
  try {
    const st = await stat(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}
