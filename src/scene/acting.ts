/** Generate per-layer acting on cloned models. Never edits a source model or texture. */
import { Rig } from '../core/rig.js';
import type { Diagnostic, Animation } from '../core/types.js';
import { generateGesture, generateExpression, generateIdle, ActingError } from '../gestures/index.js';
import { seconds, type Scene } from './schema.js';
import type { SceneAssets, LayerAssets } from './types.js';

export function compileSceneActing(
  scene: Scene,
  assets: SceneAssets,
  shotId = 'scene',
): { scene: Scene; assets: SceneAssets; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [],
    layers: SceneAssets['layers'] = Object.create(null);
  const output: Scene = {
    ...scene,
    layers: scene.layers.map((layer, index) => {
      const original = assets.layers[layer.id];
      if (!original) return layer;
      const generated = new Map<string, Animation[]>(),
        used = new Set(
          Object.values(original.sources).flatMap((s) => s.rig?.model.animations.map((a) => a.id) ?? []),
        );
      const unique = (n: number) => {
        let id = `acting_${layer.id}_${n}`;
        while (used.has(id)) id += '_';
        used.add(id);
        return id;
      };
      const refs = layer.animations.map((a, n) => {
        const idle = a === 'idle_alive',
          acting = typeof a !== 'string' && ('gesture' in a || 'expression' in a);
        if (!idle && !acting) return a;
        const id = unique(n),
          path = `/layers/${index}/animations/${n}`;
        for (const [pose, source] of Object.entries(original.sources)) {
          if (!source.rig) {
            diagnostics.push({
              severity: 'warning',
              code: 'gesture-missing-rig',
              path,
              message: `${layer.id} has no rig for acting`,
              hint: 'use a rigged character or model layer',
            });
            continue;
          }
          try {
            const options = typeof a === 'string' ? {} : { ...a, id, t: 0 };
            const result = idle
              ? generateIdle(
                  source.rig.model,
                  `${layer.type === 'character' ? layer.character : layer.id}:${scene.id ?? shotId}`,
                  Math.max(1, scene.duration),
                  id,
                )
              : 'gesture' in a
                ? generateGesture(source.rig.model, a.gesture, options)
                : generateExpression(source.rig.model, (a as { expression: string }).expression, options);
            generated.set(pose, [...(generated.get(pose) ?? []), result.animation]);
            diagnostics.push(...result.diagnostics.map((d) => ({ ...d, path: path + d.path })));
          } catch (e) {
            if (!(e instanceof ActingError)) throw e;
            diagnostics.push(...e.diagnostics.map((d) => ({ ...d, path: path + d.path })));
          }
        }
        return idle
          ? { id, mode: 'add' as const }
          : {
              id,
              start: seconds((a as { t?: number | string }).t ?? 0),
              once: true,
              hold: false,
              mode: 'add' as const,
            };
      });
      const asset: LayerAssets = {
        ...original,
        sources: Object.fromEntries(
          Object.entries(original.sources).map(([pose, source]) => {
            const additions = generated.get(pose);
            if (!source.rig || !additions?.length) return [pose, source];
            const model = { ...source.rig.model, animations: [...source.rig.model.animations, ...additions] };
            const textures = Object.fromEntries(
              Object.entries(source.textures).map(([id, image]) => [
                id,
                { width: image.width, height: image.height },
              ]),
            );
            return [
              pose,
              {
                ...source,
                rig: new Rig(model, { textures }),
                generatedAnimations: [...(source.generatedAnimations ?? []), ...additions.map((a) => a.id)],
              },
            ];
          }),
        ),
      };
      layers[layer.id] = asset;
      return { ...layer, animations: refs };
    }),
  };
  for (const [id, asset] of Object.entries(assets.layers)) if (!Object.hasOwn(layers, id)) layers[id] = asset;
  return { scene: output, assets: { ...assets, layers }, diagnostics };
}
