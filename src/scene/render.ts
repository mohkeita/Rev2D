import type { DrawItem, ImageRGBA, Mat2D, RenderList, RGBA } from '../core/types.js';
import { buildRenderList } from '../core/rig.js';
import { apply, applyToPoints, multiply } from '../core/math.js';
import { color } from '../core/color.js';
import {
  renderImage,
  createImage,
  drawLine,
  strokeRect,
  drawText,
  composeSheet,
  RasterWorkspace,
} from '../render/browser.js';
import { cameraMatrix } from './camera.js';
import { evaluateScene, ScenePlayer } from './evaluate.js';
import type { EvaluatedScene, LayerState, PreparedScene } from './types.js';

export function quad(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: RGBA = [1, 1, 1, 1],
  texture?: string,
): DrawItem {
  return {
    partId: id,
    kind: 'fill',
    positions: new Float32Array([x, y, x + w, y, x + w, y + h, x, y + h]),
    colors: new Float32Array([...fill, ...fill, ...fill, ...fill]),
    uvs: texture ? new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) : undefined,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    blend: 'normal',
    texture,
  };
}
/** Clip triangles in source space; existing model masks remain independent intersections. */
function clip(item: DrawItem, limit: number, axis: 0 | 1): DrawItem {
  const positions: number[] = [],
    colors: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  for (let i = 0; i < item.indices.length; i += 3) {
    const vertex = (index: number) => [
      item.positions[index * 2],
      item.positions[index * 2 + 1],
      ...item.colors.subarray(index * 4, index * 4 + 4),
      ...(item.uvs ? item.uvs.subarray(index * 2, index * 2 + 2) : []),
    ];
    const poly = [vertex(item.indices[i]), vertex(item.indices[i + 1]), vertex(item.indices[i + 2])],
      clipped: number[][] = [];
    for (let j = 0; j < 3; j++) {
      const a = poly[j],
        b = poly[(j + 1) % 3],
        insideA = a[axis] <= limit,
        insideB = b[axis] <= limit;
      if (insideA) clipped.push(a);
      if (insideA !== insideB) {
        const u = (limit - a[axis]) / (b[axis] - a[axis]);
        clipped.push(a.map((v, k) => v + (b[k] - v) * u));
      }
    }
    const first = positions.length / 2;
    for (const v of clipped) {
      positions.push(v[0], v[1]);
      colors.push(...v.slice(2, 6));
      if (item.uvs) uvs.push(v[6], v[7]);
    }
    for (let j = 1; j + 1 < clipped.length; j++) indices.push(first, first + j, first + j + 1);
  }
  return {
    ...item,
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    uvs: item.uvs ? new Float32Array(uvs) : undefined,
    indices: new Uint32Array(indices),
  };
}
function transformed(
  item: DrawItem,
  matrix: Mat2D,
  opacity: number,
  namespace: string,
  reveal?: { limit: number; axis: 0 | 1 },
): DrawItem {
  const src = reveal ? clip(item, reveal.limit, reveal.axis) : item;
  const positions = new Float32Array(src.positions.length);
  applyToPoints(matrix, src.positions, positions);
  const colors = new Float32Array(src.colors);
  for (let i = 3; i < colors.length; i += 4) colors[i] *= opacity;
  return {
    ...src,
    partId: namespace + item.partId,
    positions,
    colors,
    texture: item.texture === undefined ? undefined : namespace + item.texture,
    masks: item.masks?.map((m) => transformed(m, matrix, 1, namespace)),
  };
}
export type SceneOverlay = 'camera' | 'bounds' | 'safe' | 'anchors';
export interface SceneFrameOptions {
  scale?: number;
  supersample?: number;
  overlay?: SceneOverlay[];
  workspace?: RasterWorkspace;
}
export function layerBounds(
  scene: PreparedScene['scene'],
  state: LayerState,
  camera: EvaluatedScene['camera'],
): [number, number, number, number] {
  const matrix = multiply(cameraMatrix(scene, camera, state.layer.depth), state.matrix);
  const points = [
    [0, 0],
    [state.source.width, 0],
    [state.source.width, state.source.height],
    [0, state.source.height],
  ].map(([x, y]) => apply(matrix, x, y));
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
export function sceneRenderList(
  prepared: PreparedScene,
  evaluated: EvaluatedScene,
): { list: RenderList; textures: Record<string, ImageRGBA> } {
  const { scene, assets } = prepared,
    draws: DrawItem[] = [],
    textures: Record<string, ImageRGBA> = Object.create(null);
  const indexed = evaluated.layers.map((s, i) => ({ s, i }));
  indexed.sort(
    (a, b) =>
      (a.s.layer.z ?? scene.layers.indexOf(a.s.layer)) - (b.s.layer.z ?? scene.layers.indexOf(b.s.layer)) ||
      a.i - b.i,
  );
  for (const { s, i } of indexed) {
    if (s.opacity <= 0 || s.reveal <= 0) continue;
    const namespace = i + ':',
      source = s.source;
    const matrix = multiply(cameraMatrix(scene, evaluated.camera, s.layer.depth), s.matrix);
    let local: DrawItem[];
    if (source.rig && s.pose) local = buildRenderList(source.rig, s.pose).draws;
    else if (source.image) {
      textures[namespace + 'image'] = source.image;
      local = [quad('image', 0, 0, source.width, source.height, undefined, 'image')];
    } else
      local = [
        quad(
          'color',
          0,
          0,
          source.width,
          source.height,
          color(s.layer.type === 'color' ? s.layer.color : '#ffffff'),
        ),
      ];
    for (const [id, image] of Object.entries(source.textures)) textures[namespace + id] = image;
    const content = assets.layers[s.layer.id];
    if (content.content && content.contentRect) {
      const [x, y, w, h] = content.contentRect,
        ratio = Math.min(w / content.content.width, h / content.content.height);
      const cw = content.content.width * ratio,
        ch = content.content.height * ratio;
      textures[namespace + 'content'] = content.content;
      local = [...local, quad('content', x + (w - cw) / 2, y + (h - ch) / 2, cw, ch, undefined, 'content')];
    }
    const vertical = s.layer.enter?.type === 'draw-on' || s.layer.exit?.type === 'draw-on';
    const reveal =
      s.reveal < 1
        ? {
            limit: (vertical ? source.height : source.width) * s.reveal,
            axis: vertical ? (1 as const) : (0 as const),
          }
        : undefined;
    draws.push(...local.map((item) => transformed(item, matrix, s.opacity, namespace, reveal)));
  }
  return {
    list: { width: scene.width, height: scene.height, background: color(scene.background), draws },
    textures,
  };
}
export function renderSceneFrame(
  prepared: PreparedScene,
  time: number,
  options: SceneFrameOptions = {},
  evaluated = evaluateScene(prepared, time),
): ImageRGBA {
  const scene = prepared.scene;
  const { list, textures } = sceneRenderList(prepared, evaluated);
  const image = list.draws.length
    ? renderImage(list, textures, {
        scale: options.scale ?? 1,
        supersample: options.supersample ?? 1,
        workspace: options.workspace,
      })
    : createImage(
        Math.round(scene.width * (options.scale ?? 1)),
        Math.round(scene.height * (options.scale ?? 1)),
        list.background,
      );
  const scale = options.scale ?? 1,
    overlay = options.overlay ?? [];
  if (overlay.includes('safe'))
    strokeRect(
      image,
      image.width * 0.05,
      image.height * 0.05,
      image.width * 0.9,
      image.height * 0.9,
      '#55d9cb',
    );
  if (overlay.includes('camera'))
    drawText(image, 8, 8, `t=${time.toFixed(3)} zoom=${evaluated.camera.zoom.toFixed(3)}`, '#f8df51');
  for (const state of evaluated.layers) {
    const m = multiply(cameraMatrix(scene, evaluated.camera, state.layer.depth), state.matrix);
    if (overlay.includes('bounds')) {
      const [x0, y0, x1, y1] = layerBounds(scene, state, evaluated.camera);
      strokeRect(image, x0 * scale, y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale, '#f665ab');
      drawText(image, x0 * scale, y0 * scale, state.layer.id, '#f665ab');
    }
    if (overlay.includes('anchors')) {
      const points = Object.values(prepared.assets.layers[state.layer.id].anchors ?? {}).map((a) => a.at);
      points.push(state.source.anchor);
      for (const point of points) {
        const [x, y] = apply(m, ...point);
        drawLine(image, x * scale - 5, y * scale, x * scale + 5, y * scale, '#ffdb4e');
        drawLine(image, x * scale, y * scale - 5, x * scale, y * scale + 5, '#ffdb4e');
      }
    }
  }
  return image;
}
export function sceneSheet(
  prepared: PreparedScene,
  options: { frames?: number; times?: number[]; scale?: number } = {},
): { image: ImageRGBA; times: number[] } {
  const n = options.frames ?? 12;
  if (!Number.isInteger(n) || n < 1 || n > 100)
    throw new RangeError('sheet frames must be an integer in 1..100');
  const times =
    options.times ??
    Array.from(
      { length: n },
      (_, i) => (i * Math.max(0, prepared.scene.duration - 1 / prepared.scene.fps)) / Math.max(1, n - 1),
    );
  const player = new ScenePlayer(prepared);
  return {
    times,
    image: composeSheet(
      times.map((t) => ({
        image: renderSceneFrame(prepared, t, { scale: options.scale ?? 0.25 }, player.update(t)),
        caption: `t=${t.toFixed(3)}`,
      })),
      { title: 'SCENE' },
    ),
  };
}
