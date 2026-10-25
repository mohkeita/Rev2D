import { apply, fromTRS, multiply } from '../core/math.js';
import type { Mat2D } from '../core/types.js';
import { sampleNumber } from './timing.js';
import { CameraSchema, seconds, type Scene, type Camera, type NumberKey } from './schema.js';
import { resolveCue, type WordTiming } from './alignment.js';
import type { CameraState } from './types.js';

export function expandCamera(scene: Scene, words: readonly WordTiming[] = []): Camera {
  const camera =
    typeof scene.camera === 'string'
      ? CameraSchema.parse({ preset: scene.camera })
      : structuredClone(scene.camera);
  if (!camera.preset || camera.keys.length) return camera;
  const p = camera.preset,
    x = scene.width / 2,
    y = scene.height / 2;
  const start = { t: 0, x, y, zoom: 1, rotation: 0 };
  const end = { ...start, t: scene.duration };
  if (p === 'slow-push') end.zoom = 1.06;
  if (p === 'slow-pull') {
    start.zoom = 1.06;
    end.zoom = 1;
  }
  if (p === 'pan-left') end.x -= scene.width * 0.1;
  if (p === 'pan-right') end.x += scene.width * 0.1;
  if (p.startsWith('punch-in@')) {
    const raw = p.slice(9),
      cue = raw.startsWith('@') ? raw : Number(raw);
    const t = resolveCue(cue, words, scene.narration?.offset ?? 0);
    if (t !== null && Number.isFinite(t) && t >= 0 && t < scene.duration) {
      const keys = [
        start,
        { ...start, t, ease: 'outBack' as const },
        { ...start, t: Math.min(scene.duration, t + 0.18), zoom: 1.2 },
        { ...end, zoom: 1.2 },
      ];
      camera.keys = [...new Map(keys.map((key) => [key.t, key])).values()];
      return camera;
    }
  }
  camera.keys = [start, end];
  return camera;
}

/** Deterministic smooth value noise: integer lattice hashes, no mutable RNG state. */
function noise(t: number, seed: number): number {
  const hash = (i: number) => {
    let v = (i ^ seed) | 0;
    v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
    v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
    return (((v ^ (v >>> 16)) >>> 0) / 0xffffffff) * 2 - 1;
  };
  const i = Math.floor(t),
    f = t - i,
    u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}
export function cameraAt(scene: Scene, t: number, follow?: [number, number]): CameraState {
  const camera = typeof scene.camera === 'string' ? expandCamera(scene) : scene.camera;
  const read = (field: 'x' | 'y' | 'zoom' | 'rotation', fallback: number) =>
    camera.keys.length
      ? sampleNumber(
          camera.keys.map((k): NumberKey => ({ t: k.t, v: k[field] ?? fallback, ease: k.ease })),
          t,
        )
      : fallback;
  const out = {
    x: read('x', scene.width / 2),
    y: read('y', scene.height / 2),
    zoom: read('zoom', 1),
    rotation: read('rotation', 0),
  };
  if (follow) {
    out.x += follow[0] - scene.width / 2;
    out.y += follow[1] - scene.height / 2;
  }
  for (const s of camera.shake) {
    const a = seconds(s.start),
      b = seconds(s.end);
    if (t <= a || t >= b) continue;
    const u = (t - a) / (b - a),
      envelope = Math.sin(Math.PI * u) ** 2 * s.amplitude;
    out.x += noise((t - a) * s.frequency, s.seed) * envelope;
    out.y += noise((t - a) * s.frequency, s.seed ^ 0x513ac) * envelope;
  }
  return out;
}
/** C + R(-rotation*d) * (world - [C+(cam-C)*d]) * [1+(zoom-1)*d]. */
export function cameraMatrix(
  scene: Pick<Scene, 'width' | 'height'>,
  camera: CameraState,
  depth: number,
): Mat2D {
  const cx = scene.width / 2,
    cy = scene.height / 2;
  const z = 1 + (camera.zoom - 1) * depth;
  return multiply(
    fromTRS(cx, cy, -camera.rotation * depth, z, z),
    fromTRS(-(cx + (camera.x - cx) * depth), -(cy + (camera.y - cy) * depth), 0, 1, 1),
  );
}
export function projectPoint(
  scene: Pick<Scene, 'width' | 'height'>,
  camera: CameraState,
  depth: number,
  point: [number, number],
): [number, number] {
  return apply(cameraMatrix(scene, camera, depth), ...point);
}

/** Critically damped spring with zero-order-held targets on an absolute 60 Hz grid. */
export class CameraFollower {
  private tick = 0;
  private position: [number, number];
  private velocity: [number, number] = [0, 0];
  constructor(
    private readonly target: (t: number) => [number, number],
    private readonly frequency: number,
  ) {
    this.position = target(0);
  }
  private step(
    position: [number, number],
    velocity: [number, number],
    target: [number, number],
    dt: number,
  ): { position: [number, number]; velocity: [number, number] } {
    const w = this.frequency * Math.PI * 2,
      decay = Math.exp(-w * dt);
    return {
      position: position.map((x, i) => {
        const d = x - target[i],
          b = velocity[i] + w * d;
        return target[i] + (d + b * dt) * decay;
      }) as [number, number],
      velocity: velocity.map((v, i) => {
        const d = position[i] - target[i],
          b = v + w * d;
        return (v - w * b * dt) * decay;
      }) as [number, number],
    };
  }
  at(t: number): [number, number] {
    const tick = Math.max(0, Math.floor(t * 60 + 1e-8));
    if (tick < this.tick) {
      this.tick = 0;
      this.position = this.target(0);
      this.velocity = [0, 0];
    }
    while (this.tick < tick) {
      const s = this.step(this.position, this.velocity, this.target((this.tick + 1) / 60), 1 / 60);
      this.position = s.position;
      this.velocity = s.velocity;
      this.tick++;
    }
    return this.step(this.position, this.velocity, this.target(t), Math.max(0, t - tick / 60)).position;
  }
}
