import { apply, fromTRS, multiply } from '../core/math.js';
import { toLayer } from '../api/layers.js';
import type { Player } from '../core/rig.js';
import type { Mat2D, PoseOptions } from '../core/types.js';
import { seconds, type SceneLayer, type Camera } from './schema.js';
import { appearanceAt, sampleNumber } from './timing.js';
import { cameraAt, CameraFollower } from './camera.js';
import type { PreparedScene, SceneSource, LayerState, EvaluatedScene } from './types.js';

export function anchorPoint(
  anchor: SceneLayer['anchor'],
  width: number,
  height: number,
  fallback: [number, number],
): [number, number] {
  if (Array.isArray(anchor)) return [anchor[0] * width, anchor[1] * height];
  if (!anchor) return fallback;
  return [
    anchor.endsWith('left') ? 0 : anchor.endsWith('right') ? width : width / 2,
    anchor.startsWith('top')
      ? 0
      : ['bottom-center', 'bottom-left', 'bottom-right', 'feet'].includes(anchor)
        ? height
        : height / 2,
  ];
}
export function activePoses(layer: SceneLayer, t: number): { id: string; weight: number }[] {
  if (layer.type !== 'character') return [{ id: '', weight: 1 }];
  const keys = [...layer.poses].sort((a, b) => seconds(a.t) - seconds(b.t));
  let i = keys.findLastIndex((k) => seconds(k.t) <= t + 1e-9);
  if (i < 0) i = 0;
  const key = keys[i],
    tr = key.transition;
  if (i && tr?.type === 'dissolve' && t < seconds(key.t) + tr.duration) {
    const u = Math.max(0, (t - seconds(key.t)) / tr.duration);
    return [
      { id: keys[i - 1].pose, weight: 1 - u },
      { id: key.pose, weight: u },
    ];
  }
  return [{ id: key.pose, weight: 1 }];
}
export function layerPoseOptions(layer: SceneLayer, source: SceneSource, t: number): PoseOptions {
  const params = { ...layer.params };
  for (const track of layer.tracks) params[track.param] = sampleNumber(track.keys, t);
  return {
    time: t,
    params,
    animations: source.rig
      ? layer.animations.map((a) => {
          if (typeof a === 'string') return toLayer(source.rig!.model, a);
          const { once, start, ...rest } = a;
          return toLayer(source.rig!.model, {
            ...rest,
            start: start === undefined ? undefined : seconds(start),
            hold: once ? false : a.hold,
          });
        })
      : [],
  };
}
/** Evaluate one frame. Players are keyed by layer and pose, so each pose keeps its physics state. */
function statesAt(
  prepared: PreparedScene,
  t: number,
  players?: Map<SceneSource, Map<string, Player>>,
): LayerState[] {
  const { scene, assets } = prepared;
  const result = new Map<string, LayerState[]>(),
    visiting = new Set<string>();
  const get = (id: string): LayerState[] => {
    if (result.has(id)) return result.get(id)!;
    if (visiting.has(id)) throw new Error('scene attachment cycle: ' + id);
    visiting.add(id);
    const layer = scene.layers.find((l) => l.id === id)!,
      asset = assets.layers[id];
    const poses = new Map<string, ReturnType<NonNullable<SceneSource['rig']>['pose']>>();
    for (const [poseId, source] of Object.entries(asset.sources)) {
      if (!source.rig) continue;
      const opts = layerPoseOptions(layer, source, t);
      if (players) {
        let byLayer = players.get(source);
        if (!byLayer) {
          byLayer = new Map();
          players.set(source, byLayer);
        }
        let player = byLayer.get(id);
        if (!player) {
          player = source.rig.player();
          byLayer.set(id, player);
        }
        poses.set(poseId, player.update(opts));
      } else poses.set(poseId, source.rig.pose(opts));
    }
    const entries = activePoses(layer, t).map(({ id: poseId, weight }) => {
      const source = asset.sources[poseId],
        pose = poses.get(poseId);
      let x = layer.x,
        y = layer.y,
        scale = layer.scale * source.scale;
      if (Array.isArray(layer.at)) {
        x += layer.at[0];
        y += layer.at[1];
      } else if (layer.at) {
        const split = layer.at.indexOf('.'),
          parent = layer.at.slice(0, split),
          name = layer.at.slice(split + 1);
        const state = get(parent).at(-1)!,
          anchor = assets.layers[parent].anchors![name];
        const point = apply(state.matrix, ...anchor.at);
        x += point[0];
        y += point[1];
        // Named anchor scale is in world units, including the decor's scale.
        scale *= anchor.scale * Math.hypot(state.matrix[0], state.matrix[1]);
      }
      if (layer.attach) {
        const split = layer.attach.indexOf('.'),
          parent = layer.attach.slice(0, split),
          name = layer.attach.slice(split + 1);
        const state = get(parent).at(-1)!;
        let point: [number, number] = [state.source.width / 2, state.source.height / 2];
        const named = state.source.points?.[name];
        if (name.startsWith('point:')) point = name.slice(6).split(',').map(Number) as [number, number];
        else if (named) point = named.at;
        const pointParent =
          named?.parent ?? (name.startsWith('point:') ? state.source.pointParent : undefined);
        if (pointParent && state.pose && state.source.rig)
          point = state.source.rig.mapPoint(state.pose, pointParent, ...point);
        const placed = apply(state.matrix, ...point);
        x += placed[0];
        y += placed[1];
      }
      let rotation = layer.rotation,
        opacity = layer.opacity;
      for (const tr of scene.tracks) {
        const prefix = `layer:${layer.id}.`;
        if (!tr.target.startsWith(prefix)) continue;
        const v = sampleNumber(tr.keys, t);
        switch (tr.target.slice(prefix.length)) {
          case 'x':
            x = v;
            break;
          case 'y':
            y = v;
            break;
          case 'scale':
            scale = v * source.scale;
            break;
          case 'rotation':
            rotation = v;
            break;
          case 'opacity':
            opacity = v;
            break;
        }
      }
      const enter = appearanceAt(layer.enter, t),
        exit = appearanceAt(layer.exit, t, true);
      x += layer.offset[0] + enter.x + exit.x;
      y += layer.offset[1] + enter.y + exit.y;
      scale *= enter.scale * exit.scale;
      const anchor = anchorPoint(layer.anchor, source.width, source.height, source.anchor);
      const matrix: Mat2D = multiply(
        fromTRS(
          x,
          y,
          rotation,
          scale * (layer.width ? layer.width / source.width : 1) * (layer.flip ? -1 : 1),
          scale * (layer.height ? layer.height / source.height : 1),
        ),
        fromTRS(-anchor[0], -anchor[1], 0, 1, 1),
      );
      return {
        layer,
        source,
        poseId,
        pose,
        matrix,
        opacity: Math.max(0, Math.min(1, opacity * weight * enter.opacity * exit.opacity)),
        reveal: enter.reveal * exit.reveal,
      };
    });
    visiting.delete(id);
    result.set(id, entries);
    return entries;
  };
  return scene.layers.flatMap((layer) => get(layer.id));
}

function follower(prepared: PreparedScene): CameraFollower | undefined {
  const follow = (prepared.scene.camera as Camera).follow;
  if (!follow) return;
  return new CameraFollower((t) => {
    const state = statesAt(prepared, t)
      .filter((s) => s.layer.id === follow.layer)
      .at(-1)!;
    const point = apply(state.matrix, state.source.width / 2, state.source.height / 2);
    return [point[0] + follow.offset[0], point[1] + follow.offset[1]];
  }, follow.frequency);
}
export function evaluateScene(prepared: PreparedScene, time: number): EvaluatedScene {
  if (!Number.isFinite(time) || time < 0) throw new RangeError('scene time must be finite and nonnegative');
  return {
    time,
    camera: cameraAt(prepared.scene, time, follower(prepared)?.at(time)),
    layers: statesAt(prepared, time),
  };
}
export class ScenePlayer {
  private players = new Map<SceneSource, Map<string, Player>>();
  private follow: CameraFollower | undefined;
  constructor(readonly prepared: PreparedScene) {
    this.follow = follower(prepared);
  }
  update(time: number): EvaluatedScene {
    if (!Number.isFinite(time) || time < 0) throw new RangeError('scene time must be finite and nonnegative');
    return {
      time,
      camera: cameraAt(this.prepared.scene, time, this.follow?.at(time)),
      layers: statesAt(this.prepared, time, this.players),
    };
  }
}
