import type { Diagnostic } from '../core/types.js';
import { parseColor } from '../core/color.js';
import { suggest } from '../core/address.js';
import { seconds, sceneDiagnostic, type Scene, type Camera } from './schema.js';
import { layerPoseOptions } from './evaluate.js';
import type { SceneAssets } from './types.js';

/** Check the resolved scene against decoded/compiled assets; no filesystem work here. */
export function validateScene(scene: Scene, assets: SceneAssets): Diagnostic[] {
  const diagnostics: Diagnostic[] = [],
    ids = new Set<string>(),
    dependencies = new Map<string, string[]>();
  const fail = (code: string, path: string, message: string, hint: string) =>
    diagnostics.push(sceneDiagnostic(code, path, message, hint));
  if (!parseColor(scene.background))
    fail('scene-schema-color', '/background', 'invalid background color', 'use a CSS basic color or #RRGGBB');
  scene.layers.forEach((layer, i) => {
    if (ids.has(layer.id))
      fail(
        'scene-duplicate-id',
        `/layers/${i}/id`,
        `duplicate layer ${layer.id}`,
        'give every scene layer a unique id',
      );
    ids.add(layer.id);
  });
  scene.layers.forEach((layer, i) => {
    const path = `/layers/${i}`,
      deps: string[] = [];
    if (layer.type === 'color' && !parseColor(layer.color))
      fail('scene-schema-color', path + '/color', 'invalid layer color', 'use a CSS basic color or #RRGGBB');
    for (const [name, value] of [
      ['at', typeof layer.at === 'string' ? layer.at : undefined],
      ['attach', layer.attach],
    ] as const) {
      if (!value) continue;
      const split = value.indexOf('.'),
        parent = value.slice(0, split),
        anchor = value.slice(split + 1);
      if (split < 1 || !ids.has(parent)) {
        fail(
          'scene-unknown-layer',
          path + '/' + name,
          `unknown placement layer in ${value}`,
          suggest(parent, [...ids]) ?? 'use layer.anchor or layer.point:x,y',
        );
        continue;
      }
      deps.push(parent);
      const asset = assets.layers[parent];
      const sources = asset ? Object.values(asset.sources) : [];
      const point = /^point:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.test(anchor);
      if (
        name === 'at'
          ? !Object.hasOwn(asset?.anchors ?? {}, anchor)
          : !point && !sources.every((s) => Object.hasOwn(s.points ?? {}, anchor))
      ) {
        fail(
          'scene-unknown-anchor',
          path + '/' + name,
          `unknown anchor ${value}`,
          'choose an anchor from the background, a known model point, or point:x,y',
        );
      }
    }
    if (!dependencies.has(layer.id)) dependencies.set(layer.id, deps);
    const asset = assets.layers[layer.id];
    if (!asset) return;
    if (layer.type === 'character')
      layer.poses.forEach((p, j) => {
        if (!Object.hasOwn(asset.sources, p.pose))
          fail(
            'scene-unknown-pose',
            `${path}/poses/${j}/pose`,
            `unknown pose ${p.pose}`,
            suggest(p.pose, Object.keys(asset.sources)) ?? 'add and build this pose in the library',
          );
      });
    for (const [pose, source] of Object.entries(asset.sources)) {
      const rig = source.rig;
      if (!rig && (layer.tracks.length || layer.animations.length || Object.keys(layer.params).length)) {
        fail(
          'scene-unknown-param',
          path + '/tracks',
          'static images have no animation parameters',
          'use a model, UI or rigged character layer',
        );
        continue;
      }
      if (!rig) continue;
      const known = rig.model.parameters.map((p) => p.id);
      const check = (id: string, pointer: string) => {
        if (!known.includes(id))
          fail(
            'scene-unknown-param',
            pointer,
            `unknown parameter ${id} in pose ${pose || '(model)'}`,
            suggest(id, known) ?? `available: ${known.join(', ')}`,
          );
      };
      Object.keys(layer.params).forEach((p) => check(p, path + '/params/' + p));
      layer.tracks.forEach((tr, j) => check(tr.param, `${path}/tracks/${j}/param`));
      try {
        layerPoseOptions(layer, source, 0);
      } catch (e) {
        fail(
          'scene-unknown-animation',
          path + '/animations',
          (e as Error).message,
          `available: ${rig.model.animations.map((a) => a.id).join(', ')}`,
        );
      }
    }
  });
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) {
      fail(
        'scene-attachment-cycle',
        `/layers/${scene.layers.findIndex((l) => l.id === id)}`,
        `placement cycle at ${id}`,
        'remove a circular at/attach reference',
      );
      return;
    }
    if (done.has(id)) return;
    visiting.add(id);
    for (const dep of dependencies.get(id) ?? []) visit(dep);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of ids) visit(id);
  scene.tracks.forEach((tr, i) => {
    const m = /^layer:([A-Za-z_][A-Za-z0-9_-]*)\.(x|y|scale|rotation|opacity)$/.exec(tr.target);
    if (!m || !ids.has(m[1]))
      fail(
        'scene-track-target',
        `/tracks/${i}/target`,
        `invalid scene target ${tr.target}`,
        'use layer:<id>.x, .y, .scale, .rotation or .opacity',
      );
  });
  const camera = scene.camera as Camera;
  if (camera.follow && !ids.has(camera.follow.layer))
    fail(
      'scene-unknown-layer',
      '/camera/follow/layer',
      `unknown follow layer ${camera.follow.layer}`,
      'choose an existing scene layer',
    );
  const preset = camera.preset;
  if (
    preset &&
    !['static', 'slow-push', 'slow-pull', 'pan-left', 'pan-right'].includes(preset) &&
    !preset.startsWith('punch-in@') &&
    !preset.startsWith('focus:')
  )
    fail(
      'scene-schema-camera',
      '/camera/preset',
      `unknown camera preset ${preset}`,
      'use static, slow-push, slow-pull, pan-left, pan-right, focus:<layer> or punch-in@<time>',
    );
  if (preset?.startsWith('focus:') && !ids.has(preset.slice(6)))
    fail(
      'scene-unknown-layer',
      '/camera/preset',
      `unknown focus layer ${preset.slice(6)}`,
      'use focus:<existing layer id>',
    );
  camera.shake.forEach((s, i) => {
    if (seconds(s.end) <= seconds(s.start))
      fail(
        'scene-schema-time',
        `/camera/shake/${i}/end`,
        'shake end must follow start',
        'give a positive shake interval',
      );
  });
  function times(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      let previous = -Infinity;
      value.forEach((v, i) => {
        if (v && typeof v === 'object' && 't' in v && typeof v.t === 'number') {
          if (v.t < 0 || v.t <= previous)
            fail(
              'scene-schema-time',
              `${path}/${i}/t`,
              'key times must be nonnegative and strictly increasing',
              'sort keys and remove duplicate times',
            );
          previous = v.t;
        }
        times(v, path + '/' + i);
      });
    } else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) times(v, path + '/' + k);
  }
  times(scene, '');
  return diagnostics;
}
