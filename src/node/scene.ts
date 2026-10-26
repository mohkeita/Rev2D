/** Scene IO and per-load resource caches. All paths in scene documents are relative to the scene. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, ImageRGBA } from '../core/types.js';
import { parseJsonc } from '../core/validate.js';
import { apply } from '../core/math.js';
import { decodePNG, encodePNG } from '../render/png.js';
import { decodeWav } from '../lipsync/wav.js';
import type { Library } from '../library/schema.js';
import { readLibrary, libraryFile } from './library.js';
import { loadModelFile, type LoadedModel } from './load.js';
import { loadAvatarProject } from './avatar.js';
import { analyzeAnimation } from '../api/analyze.js';
import {
  compileSceneActing,
  parseScene,
  sceneDiagnostic,
  SceneError,
  validateScene,
  resolveSceneCues,
  parseAlignment,
  expandCamera,
  resolveCue,
  evaluateScene,
  analyzeScene,
  sceneSheet,
  renderSceneFrame,
  type PreparedScene,
  type SceneSource,
  type LayerAssets,
  type WordTiming,
  type SceneFrameOptions,
} from '../scene/index.js';
import { suggest } from '../core/address.js';

export interface LoadedScene {
  file: string;
  prepared: PreparedScene | null;
  diagnostics: Diagnostic[];
  models: Map<string, LoadedModel>;
  audio?: { file: string; duration: number; offset: number };
}
export async function loadScene(file: string, document?: unknown): Promise<LoadedScene> {
  file = path.resolve(file);
  const out: LoadedScene = { file, prepared: null, diagnostics: [], models: new Map() },
    base = path.dirname(file);
  const fail = (code: string, pointer: string, message: string, hint: string) =>
    out.diagnostics.push(sceneDiagnostic(code, pointer, message, hint));
  const relative = (name: string) => {
    if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.includes('\0'))
      throw new Error('use a relative asset path');
    return path.resolve(base, name);
  };
  let input: unknown = document;
  if (document === undefined) try {
    const r = parseJsonc(await readFile(file, 'utf8'));
    if (!r.ok) {
      fail('scene-schema-json', '', r.error.message, 'repair the scene JSON or JSONC syntax');
      return out;
    }
    input = r.value;
  } catch (e) {
    fail(
      'scene-file-missing',
      '',
      (e as Error).message,
      'provide a readable scene.json with valid JSON or JSONC',
    );
    return out;
  }
  const parsed = parseScene(input);
  out.diagnostics.push(...parsed.diagnostics);
  if (!parsed.scene) return out;
  let scene = parsed.scene;
  let words: WordTiming[] = [];
  if (scene.narration?.alignment) {
    try {
      const alignment = parseAlignment(
        JSON.parse(await readFile(relative(scene.narration.alignment), 'utf8')),
      );
      words = alignment.words;
      out.diagnostics.push(
        ...alignment.diagnostics.map((d) => ({ ...d, path: '/narration/alignment' + d.path })),
      );
    } catch (e) {
      fail(
        'scene-file-missing',
        '/narration/alignment',
        (e as Error).message,
        'provide a readable ElevenLabs or word-timing JSON file',
      );
    }
  }
  if (scene.narration?.audio) {
    try {
      const audioFile = relative(scene.narration.audio),
        audio = decodeWav(await readFile(audioFile));
      out.audio = {
        file: audioFile,
        duration: audio.samples.length / audio.sampleRate,
        offset: scene.narration.offset,
      };
    } catch (e) {
      fail(
        'scene-audio-format',
        '/narration/audio',
        (e as Error).message,
        'provide a readable PCM WAV; convert other formats with ffmpeg -i voice.mp3 -c:a pcm_s16le voice.wav',
      );
    }
  }
  const originalCamera = scene.camera;
  const usePreset = typeof originalCamera === 'string' || !originalCamera.keys.length;
  scene.camera = expandCamera(scene, words);
  if (
    usePreset &&
    (typeof originalCamera === 'string' ? originalCamera : originalCamera.preset)?.startsWith('punch-in@')
  ) {
    const preset = typeof originalCamera === 'string' ? originalCamera : originalCamera.preset!;
    if (scene.camera.keys.length === 2)
      fail(
        'scene-cue-not-found',
        '/camera/preset',
        `invalid punch-in time: ${preset}`,
        'use punch-in@2 or punch-in@@text:phrase',
      );
  }
  const resolved = resolveSceneCues(scene, words);
  const preset = typeof originalCamera === 'string' ? originalCamera : originalCamera.preset;
  if (usePreset && preset?.startsWith('punch-in@')) {
    const cue = preset.slice(9);
    const time = resolveCue(cue.startsWith('@') ? cue : Number(cue), words, scene.narration?.offset ?? 0);
    if (cue.startsWith('@') && time !== null) resolved.cues.push({ path: '/camera/preset', cue, time });
  }
  scene = resolved.scene;
  out.diagnostics.push(...resolved.diagnostics);
  if (out.diagnostics.some((d) => d.severity === 'error')) return out;
  let library: Library | undefined, libraryDir: string | undefined;
  if (scene.library) {
    try {
      libraryDir = relative(scene.library);
      library = await readLibrary(libraryDir);
    } catch (e) {
      fail(
        'scene-library-ref',
        '/library',
        (e as Error).message,
        'provide a valid library directory relative to scene.json',
      );
    }
  }
  const images = new Map<string, Promise<ImageRGBA>>(),
    models = new Map<string, Promise<LoadedModel>>();
  const image = (name: string) => {
    let p = images.get(name);
    if (!p) {
      p = readFile(name).then(decodePNG);
      images.set(name, p);
    }
    return p;
  };
  const model = async (name: string, pointer: string): Promise<SceneSource> => {
    let p = models.get(name);
    if (!p) {
      p = loadModelFile(name);
      models.set(name, p);
    }
    const m = await p;
    out.models.set(name, m);
    out.diagnostics.push(
      ...m.diagnostics
        .filter((d) => d.severity !== 'info')
        .map((d) => ({
          ...d,
          code: 'scene-model-invalid-' + d.code,
          path: pointer + d.path,
          hint: d.hint ?? 'repair the referenced model before rendering the scene',
        })),
    );
    if (!m.rig || !m.model) throw new Error('referenced model is invalid: ' + name);
    return {
      width: m.model.meta.width,
      height: m.model.meta.height,
      rig: m.rig,
      textures: m.textures,
      anchor: [m.model.meta.width / 2, m.model.meta.height / 2],
      scale: 1,
    };
  };
  const bitmap = async (name: string, anchor: [number, number] = [0, 0]): Promise<SceneSource> => {
    const img = await image(name);
    return { width: img.width, height: img.height, image: img, textures: {}, anchor, scale: 1 };
  };
  const libraryPath = async (name: string) => libraryFile(libraryDir!, name);
  let assets: PreparedScene['assets'] = { layers: Object.create(null) };
  for (const [index, layer] of scene.layers.entries()) {
    const pointer = `/layers/${index}`,
      asset: LayerAssets = { sources: Object.create(null) };
    // Keep the first definition: duplicate ids are diagnosed below rather than hiding the first asset.
    if (!Object.hasOwn(assets.layers, layer.id)) assets.layers[layer.id] = asset;
    try {
      if (layer.type === 'image') asset.sources[''] = await bitmap(relative(layer.src));
      else if (layer.type === 'model') asset.sources[''] = await model(relative(layer.src), pointer + '/src');
      else if (layer.type === 'color')
        asset.sources[''] = {
          width: layer.width ?? scene.width,
          height: layer.height ?? scene.height,
          textures: {},
          anchor: [0, 0],
          scale: 1,
        };
      else {
        if (!library) {
          fail(
            'scene-library-ref',
            pointer,
            'this layer requires a library',
            'set library to a valid directory or use image/model/color layers',
          );
          continue;
        }
        if (layer.type === 'character') {
          const character = library.characters.find((c) => c.id === layer.character);
          if (!character) {
            fail(
              'scene-library-ref',
              pointer + '/character',
              `unknown character ${layer.character}`,
              suggest(
                layer.character,
                library.characters.map((c) => c.id),
              ) ?? 'choose an id from library.characters',
            );
            continue;
          }
          for (const id of new Set(layer.poses.map((p) => p.pose))) {
            const pose = character.poses.find((p) => p.id === id);
            if (!pose) {
              fail(
                'scene-unknown-pose',
                pointer + '/poses',
                `unknown pose ${id}`,
                suggest(
                  id,
                  character.poses.map((p) => p.id),
                ) ?? 'add and build the missing pose',
              );
              continue;
            }
            const project = await loadAvatarProject(await libraryPath(pose.avatar));
            if (!project.spec || !project.modelFile || !project.modelExists || project.layersStale) {
              fail(
                'scene-model-invalid',
                pointer + '/poses',
                `avatar ${id} is missing or stale`,
                'validate the landmarks, then run library rig and avatar build',
              );
              continue;
            }
            const source = await model(project.modelFile, pointer + '/poses');
            const alpha = project.source;
            let x0 = source.width,
              x1 = 0,
              y0 = source.height,
              y1 = 0;
            if (alpha)
              for (let y = 0; y < alpha.height; y++)
                for (let x = 0; x < alpha.width; x++)
                  if (alpha.data[(y * alpha.width + x) * 4 + 3] > 127) {
                    x0 = Math.min(x0, x);
                    x1 = Math.max(x1, x);
                    y0 = Math.min(y0, y);
                    y1 = Math.max(y1, y);
                  }
            if (y1 <= y0) {
              x0 = 0;
              y0 = 0;
              x1 = source.width;
              y1 = source.height;
            }
            source.scale = character.height / (y1 - y0 + 1);
            const anchor = pose.anchor;
            source.anchor = Array.isArray(anchor)
              ? anchor
              : anchor === 'feet'
                ? [(x0 + x1) / 2, y1]
                : anchor === 'seat'
                  ? [source.width / 2, source.height * 0.68]
                  : anchor === 'top-left'
                    ? [0, 0]
                    : anchor.startsWith('bottom')
                      ? [
                          anchor.endsWith('left')
                            ? 0
                            : anchor.endsWith('right')
                              ? source.width
                              : source.width / 2,
                          source.height,
                        ]
                      : [source.width / 2, source.height / 2];
            source.points = { head: { at: project.spec.head.center, parent: 'warp:avatarWarp' } };
            source.pointParent = 'warp:avatarWarp';
            asset.sources[id] = source;
          }
        } else if (layer.type === 'ui') {
          const ui = library.ui.find((v) => v.id === layer.ref);
          if (!ui)
            fail(
              'scene-library-ref',
              pointer + '/ref',
              `unknown UI ${layer.ref}`,
              suggest(
                layer.ref,
                library.ui.map((v) => v.id),
              ) ?? 'choose an id from library.ui',
            );
          else asset.sources[''] = await model(await libraryPath(ui.model), pointer + '/ref');
        } else {
          const entries =
            layer.type === 'background'
              ? library.backgrounds
              : layer.type === 'prop'
                ? library.props
                : library.bubbles;
          const entry = entries.find((v) => v.id === layer.ref);
          if (!entry) {
            fail(
              'scene-library-ref',
              pointer + '/ref',
              `unknown ${layer.type} ${layer.ref}`,
              suggest(
                layer.ref,
                entries.map((v) => v.id),
              ) ?? 'choose an existing asset id',
            );
            continue;
          }
          const source = await bitmap(await libraryPath(entry.src));
          asset.sources[''] = source;
          if ('anchors' in entry)
            asset.anchors = Object.fromEntries(
              Object.entries(entry.anchors).map(([name, a]) => [
                name,
                { at: a.at ?? [a.rect![0] + a.rect![2] / 2, a.rect![1] + a.rect![3] / 2], scale: a.scale },
              ]),
            );
          if ('anchor' in entry)
            source.anchor = Array.isArray(entry.anchor)
              ? entry.anchor
              : entry.anchor === 'center'
                ? [source.width / 2, source.height / 2]
                : entry.anchor === 'top-left'
                  ? [0, 0]
                  : [source.width / 2, source.height];
          if ('content_rect' in entry) {
            source.anchor = entry.tail;
            asset.contentRect = entry.content_rect;
          }
          if (layer.type === 'bubble' && layer.content)
            asset.content = await image(relative(layer.content.src));
        }
      }
    } catch (e) {
      fail(
        'scene-file-missing',
        pointer,
        (e as Error).message,
        'check the relative path, PNG data and referenced model diagnostics',
      );
    }
  }
  if (out.diagnostics.some((d) => d.severity === 'error')) return out;
  const acting=compileSceneActing(scene,assets,path.basename(file));
  scene=acting.scene;assets=acting.assets;out.diagnostics.push(...acting.diagnostics);
  out.diagnostics.push(...validateScene(scene, assets));
  if (out.diagnostics.some((d) => d.severity === 'error')) return out;
  const prepared: PreparedScene = { scene, assets, cues: resolved.cues };
  const camera = scene.camera as import('../scene/schema.js').Camera;
  if (usePreset && camera.preset?.startsWith('focus:')) {
    const id = camera.preset.slice(6);
    const fullSize = {
      ...scene,
      layers: scene.layers.map((l) => (l.id === id ? { ...l, enter: undefined, exit: undefined } : l)),
    };
    const s = evaluateScene({ ...prepared, scene: fullSize }, 0).layers.find((l) => l.layer.id === id)!;
    const center = apply(s.matrix, s.source.width / 2, s.source.height / 2);
    const width = Math.hypot(s.matrix[0], s.matrix[1]) * s.source.width || s.source.width * s.source.scale,
      height = Math.hypot(s.matrix[2], s.matrix[3]) * s.source.height || s.source.height * s.source.scale;
    camera.keys = [
      {
        t: 0,
        x: center[0],
        y: center[1],
        zoom: Math.min((scene.width * 0.8) / width, (scene.height * 0.8) / height),
        rotation: 0,
      },
    ];
  }
  out.prepared = prepared;
  return out;
}
export function requireScene(loaded: LoadedScene): PreparedScene {
  if (!loaded.prepared) throw new SceneError(loaded.diagnostics);
  return loaded.prepared;
}
export function sceneInfo(loaded: LoadedScene) {
  const p = requireScene(loaded),
    scene = p.scene;
  return {
    version: scene.version,
    width: scene.width,
    height: scene.height,
    fps: scene.fps,
    duration: scene.duration,
    frames: Math.ceil(scene.duration * scene.fps),
    layers: scene.layers.map((l) => ({
      id: l.id,
      type: l.type,
      poses: Object.keys(p.assets.layers[l.id].sources).filter(Boolean),
    })),
    cues: p.cues,
    audio: loaded.audio ?? null,
    diagnostics: loaded.diagnostics,
  };
}
export function analyzeLoadedScene(loaded: LoadedScene) {
  const p = requireScene(loaded),
    analysis = analyzeScene(p),
    models = [];
  for (const [file, m] of loaded.models)
    for (const animation of m.model?.animations ?? []) {
      models.push({
        file,
        animation: animation.id,
        analysis: analyzeAnimation(m, { animation: animation.id, fps: p.scene.fps, pixels: false }),
      });
    }
  for(const [layer,asset]of Object.entries(p.assets.layers))for(const [pose,source]of Object.entries(asset.sources)){
    if(!source.rig||!source.generatedAnimations?.length)continue;
    const model=source.rig.model,textureInfo=Object.fromEntries(Object.entries(source.textures).map(([id,image])=>[id,{width:image.width,height:image.height}]));
    const m:LoadedModel={file:null,baseDir:path.dirname(loaded.file),model,rig:source.rig,textures:source.textures,textureInfo,diagnostics:[]};
    for(const id of source.generatedAnimations){const duration=model.animations.find(a=>a.id===id)!.duration;models.push({file:`${loaded.file}#${layer}:${pose}`,animation:id,analysis:analyzeAnimation(m,{animation:id,fps:Math.min(p.scene.fps,1999/duration),pixels:false})});}
  }
  return { ...analysis, models };
}
export async function newScene(
  file: string,
  options: { library?: string; background?: string; width?: number; height?: number } = {},
) {
  const doc: Record<string, unknown> = {
    version: 1,
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    fps: 24,
    duration: 6,
    layers: [],
    camera: 'static',
  };
  if (options.library)
    doc.library = path.relative(path.dirname(file), options.library).split(path.sep).join('/') || '.';
  if (options.background) doc.layers = [{ id: 'room', type: 'background', ref: options.background }];
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
  return { file };
}
export async function writeSceneSheet(
  loaded: LoadedScene,
  file: string,
  options: Parameters<typeof sceneSheet>[1] = {},
) {
  const r = sceneSheet(requireScene(loaded), options);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, encodePNG(r.image), { flag: 'wx' });
  return { file, times: r.times, width: r.image.width, height: r.image.height };
}
export async function writeSceneFrame(
  loaded: LoadedScene,
  file: string,
  time: number,
  options: SceneFrameOptions = {},
) {
  const image = renderSceneFrame(requireScene(loaded), time, options);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, encodePNG(image), { flag: 'wx' });
  return { file, time, width: image.width, height: image.height };
}
