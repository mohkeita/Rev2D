/**
 * The live preview of avatar mode: the Rev2D model compiled IN THE BROWSER from the current
 * (unsaved) spec and the layer metadata of the last build, with the layer images of that build.
 *
 *   preview.setLayers(meta, version)   fetch the layer images (unchanged ones are kept)
 *   preview.compile(spec, meta)        compileAvatar -> validate -> Rig; on failure the last good
 *                                      rig stays and `error` says why
 *   preview.evaluate(inputs)           pose + render list for the WebGL renderer
 *
 * Compiling is fast (tens of ms for a 1024 px avatar), so it runs on the main thread, debounced by
 * the store. Textures are decoded premultiplied, as the editor's renderer uploads them.
 */
import { compileAvatar, type AvatarSpec, type LayersMeta } from '../../../src/avatar/index.js';
import { Rig, buildRenderList, validateModel, type Model, type Player, type Pose, type PoseOptions, type RenderList, type TextureInfo } from '../../../src/core/index.js';
import { fetchAvatarBitmap } from '../api.js';

export interface PreviewTexture {
  /** layer file + fetch version: a new key means a new bitmap. */
  key: string;
  bitmap: ImageBitmap;
}

export interface PreviewFrame {
  rig: Rig;
  pose: Pose;
  list: RenderList;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class AvatarPreview {
  /** Layer images by texture id (= layer id). */
  textures = new Map<string, PreviewTexture>();
  /** Bumps when `textures` is replaced (the renderer re-uploads). */
  textureVersion = 0;
  /** Compiled model of the last good compile, or null. */
  rig: Rig | null = null;
  /** Bumps on every successful compile. */
  modelVersion = 0;
  /** Why the last compile failed (the last good rig stays on screen), or null. */
  error: string | null = null;
  /** Milliseconds the last compile took (compile + validate + rig). */
  lastCompileMs = 0;
  private player: Player | null = null;
  private frame: PreviewFrame | null = null;
  private frameKey = '';
  private loading: Promise<void> | null = null;
  private layersKey = '';

  /** The model on screen (last good compile). */
  get model(): Model | null {
    return this.rig?.model ?? null;
  }

  /** Whether the layer images of `meta` at `version` are loaded. */
  hasLayers(meta: LayersMeta | null, version: number): boolean {
    return meta !== null && this.layersKey === layersKey(meta, version);
  }

  /**
   * Load the layer images of `meta` (fetch `version` busts the browser cache after a rebuild). The
   * previous images stay until all new ones are decoded. Resolves when done; throws on a failed fetch.
   */
  async setLayers(meta: LayersMeta, version: number): Promise<boolean> {
    const key = layersKey(meta, version);
    if (key === this.layersKey) return false;
    const next = new Map<string, PreviewTexture>();
    await Promise.all(
      meta.layers.map(async (layer) => {
        const k = `${version}|${layer.file}`;
        const old = this.textures.get(layer.id);
        if (old && old.key === k) {
          next.set(layer.id, old);
          return;
        }
        next.set(layer.id, { key: k, bitmap: await fetchAvatarBitmap(layer.file, version, { premultiply: true }) });
      }),
    );
    for (const [id, t] of this.textures) if (next.get(id) !== t) t.bitmap.close();
    this.textures = next;
    this.textureVersion++;
    this.layersKey = key;
    this.frameKey = '';
    return true;
  }

  /** Compile `spec` against `meta`. Returns whether the rig on screen changed. */
  compile(spec: AvatarSpec, meta: LayersMeta): boolean {
    const t0 = performance.now();
    try {
      const compiled = compileAvatar(spec, meta);
      const validation = validateModel(compiled.doc);
      const errors = validation.diagnostics.filter((d) => d.severity === 'error');
      if (!validation.model || errors.length) throw new Error(errors[0] ? `${errors[0].message} (${errors[0].path})` : 'the generated model does not validate');
      const info: Record<string, TextureInfo> = {};
      for (const l of meta.layers) {
        const t = this.textures.get(l.id);
        info[l.id] = t ? { width: t.bitmap.width, height: t.bitmap.height } : { width: l.rect[2], height: l.rect[3] };
      }
      this.rig = new Rig(validation.model, { textures: info });
      this.player = this.rig.player();
      this.frame = null;
      this.frameKey = '';
      this.error = null;
      this.modelVersion++;
      this.lastCompileMs = performance.now() - t0;
      return true;
    } catch (e) {
      this.error = messageOf(e);
      this.lastCompileMs = performance.now() - t0;
      return false;
    }
  }

  /** Pose and render list for these inputs (cached while they do not change). */
  evaluate(inputs: PoseOptions): PreviewFrame | null {
    const rig = this.rig;
    if (!rig || !this.player) return null;
    const known = new Set(rig.model.parameters.map((p) => p.id));
    const params = Object.fromEntries(Object.entries(inputs.params ?? {}).filter(([id]) => known.has(id)));
    const animations = (inputs.animations ?? []).filter((a) => rig.model.animations.some((m) => m.id === (typeof a === 'string' ? a : a.id)));
    const opts: PoseOptions = { ...inputs, params, animations };
    const key = JSON.stringify(opts);
    if (this.frame && this.frame.rig === rig && key === this.frameKey) return this.frame;
    try {
      const pose = this.player.update(opts);
      this.frame = { rig, pose, list: buildRenderList(rig, pose) };
      this.frameKey = key;
    } catch (e) {
      this.error = messageOf(e);
    }
    return this.frame;
  }

  /** Forget everything (another project was opened). */
  clear(): void {
    for (const t of this.textures.values()) t.bitmap.close();
    this.textures = new Map();
    this.textureVersion++;
    this.rig = null;
    this.player = null;
    this.frame = null;
    this.frameKey = '';
    this.error = null;
    this.layersKey = '';
    this.loading = null;
  }

  /** Run one texture load at a time (later calls wait for the earlier one). */
  queue(task: () => Promise<unknown>): Promise<void> {
    const run = (this.loading ?? Promise.resolve()).then(task, task).then(
      () => undefined,
      () => undefined,
    );
    this.loading = run;
    return run;
  }
}

function layersKey(meta: LayersMeta, version: number): string {
  return `${version}|${meta.inputsHash}|${meta.layers.map((l) => `${l.id}:${l.file}:${l.rect.join(',')}`).join(';')}`;
}
