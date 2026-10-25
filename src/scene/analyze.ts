import type { Diagnostic } from '../core/types.js';
import { apply, invert, multiply } from '../core/math.js';
import { cameraMatrix } from './camera.js';
import { ScenePlayer } from './evaluate.js';
import { layerBounds } from './render.js';
import { sceneDiagnostic } from './schema.js';
import type { PreparedScene } from './types.js';

export interface SceneAnalysisNote extends Diagnostic {
  intervals: [number, number][];
  max: number;
  unit: string;
}
export function analyzeScene(
  prepared: PreparedScene,
  options: { overlap?: number; maxFrames?: number } = {},
): { frames: number; fps: number; diagnostics: SceneAnalysisNote[] } {
  const scene = prepared.scene,
    count = Math.ceil(scene.duration * scene.fps),
    notes = new Map<string, SceneAnalysisNote>();
  if (count > (options.maxFrames ?? 1_000_000)) throw new RangeError('scene analysis exceeds frame budget');
  const player = new ScenePlayer(prepared);
  let previous: ReturnType<ScenePlayer['update']> | undefined;
  const note = (
    code: string,
    path: string,
    message: string,
    hint: string,
    frame: number,
    max: number,
    unit = 'px',
  ) => {
    const key = code + path;
    let n = notes.get(key);
    if (!n) {
      n = { ...sceneDiagnostic(code, path, message, hint, 'warning'), intervals: [], max: 0, unit };
      notes.set(key, n);
    }
    n.max = Math.max(n.max, max);
    const a = frame / scene.fps,
      b = Math.min(scene.duration, (frame + 1) / scene.fps),
      last = n.intervals.at(-1);
    if (last && Math.abs(last[1] - a) < 1e-8) last[1] = b;
    else n.intervals.push([a, b]);
  };
  for (let i = 0; i < count; i++) {
    const frame = player.update(i / scene.fps),
      characters: { id: string; bounds: [number, number, number, number]; path: string }[] = [];
    if (previous) {
      const speed =
        Math.hypot(frame.camera.x - previous.camera.x, frame.camera.y - previous.camera.y) * scene.fps;
      if (
        speed > scene.width * 1.5 ||
        Math.abs(frame.camera.rotation - previous.camera.rotation) * scene.fps > 90 ||
        Math.abs(frame.camera.zoom - previous.camera.zoom) * scene.fps > 1
      )
        note(
          'scene-camera-fast',
          '/camera',
          'camera motion may be uncomfortable',
          'slow the camera keys or reduce shake amplitude',
          i,
          speed,
          'px/s',
        );
    }
    for (const state of frame.layers) {
      if (state.opacity < 0.01) continue;
      const index = scene.layers.indexOf(state.layer),
        path = `/layers/${index}`;
      const [x0, y0, x1, y1] = layerBounds(scene, state, frame.camera);
      if (x1 <= 0 || y1 <= 0 || x0 >= scene.width || y0 >= scene.height)
        note(
          'scene-layer-offscreen',
          path,
          `${state.layer.id} is outside the frame`,
          'adjust placement or camera framing',
          i,
          Math.max(-x1, -y1, x0 - scene.width, y0 - scene.height),
        );
      if (state.layer.type === 'bubble' && (x0 < 0 || y0 < 0 || x1 > scene.width || y1 > scene.height))
        note(
          'scene-bubble-offscreen',
          path,
          `${state.layer.id} is cropped`,
          'move the bubble inside the safe area',
          i,
          Math.max(-x0, -y0, x1 - scene.width, y1 - scene.height),
        );
      if (state.layer.type === 'character')
        characters.push({ id: state.layer.id, bounds: [x0, y0, x1, y1], path });
      if (state.layer.type === 'background') {
        const matrix = multiply(cameraMatrix(scene, frame.camera, state.layer.depth), state.matrix);
        if (Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) < 1e-12) continue;
        const inv = invert(matrix),
          corners = [
            [0, 0],
            [scene.width, 0],
            [scene.width, scene.height],
            [0, scene.height],
          ].map(([x, y]) => apply(inv, x, y));
        const overflow =
          Math.max(
            0,
            ...corners.flatMap(([x, y]) => [-x, -y, x - state.source.width, y - state.source.height]),
          ) * Math.hypot(matrix[0], matrix[1]);
        if (overflow > 0.5)
          note(
            'scene-camera-reveal',
            path,
            'camera reveals outside the background',
            'extend the background or move/zoom the camera inside it',
            i,
            overflow,
          );
      }
    }
    for (let a = 0; a < characters.length; a++)
      for (let b = a + 1; b < characters.length; b++) {
        if (characters[a].id === characters[b].id) continue;
        const x = characters[a].bounds,
          y = characters[b].bounds;
        const intersection =
          Math.max(0, Math.min(x[2], y[2]) - Math.max(x[0], y[0])) *
          Math.max(0, Math.min(x[3], y[3]) - Math.max(x[1], y[1]));
        const area = Math.min((x[2] - x[0]) * (x[3] - x[1]), (y[2] - y[0]) * (y[3] - y[1]));
        if (area > 0 && intersection / area > (options.overlap ?? 0.3))
          note(
            'scene-overlap',
            characters[b].path,
            `${characters[a].id} overlaps ${characters[b].id}`,
            'separate characters or change the warning threshold for an intentional overlap',
            i,
            (intersection / area) * 100,
            '%',
          );
      }
    previous = frame;
  }
  return { frames: count, fps: scene.fps, diagnostics: [...notes.values()] };
}
