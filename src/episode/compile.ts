import type { Diagnostic } from '../core/types.js';
import type { Library, LibraryKind } from '../library/schema.js';
import { parseScene, type SceneInput } from '../scene/schema.js';
import { episodeDiagnostic, type Shot } from './schema.js';
import type { EpisodeTimeline, TimedShot } from './timeline.js';
export interface MissingAsset {
  kind: LibraryKind;
  id: string;
  pose?: string;
  shots: string[];
}
export function planAssets(timeline: EpisodeTimeline, library: Library | undefined): MissingAsset[] {
  const found = new Map<string, MissingAsset>();
  const add = (kind: LibraryKind, id: string, shot: string, pose?: string) => {
    const key = [kind, id, pose ?? ''].join(':');
    const v = found.get(key) ?? { kind, id, ...(pose ? { pose } : {}), shots: [] };
    if (!v.shots.includes(shot)) v.shots.push(shot);
    found.set(key, v);
  };
  for (const { shot: s } of timeline.shots) {
    if (s.external || s.scene) continue;
    if (s.background && !library?.backgrounds.some((x) => x.id === s.background))
      add('background', s.background, s.id);
    for (const c of s.characters) {
      const id = c.character ?? c.id,
        character = library?.characters.find((x) => x.id === id);
      if (!character || !character.poses.some((p) => p.id === c.pose)) add('character', id, s.id, c.pose);
    }
    for (const kind of ['props', 'bubbles', 'ui'] as const)
      for (const a of s[kind])
        if (!library?.[kind].some((x) => x.id === a.ref))
          add(kind === 'props' ? 'prop' : kind === 'bubbles' ? 'bubble' : 'ui', a.ref, s.id);
  }
  return [...found.values()];
}
const place = (at: unknown) => (typeof at === 'string' && !at.includes('.') ? 'room.' + at : at);
export function compileShot(
  timeline: EpisodeTimeline,
  timed: TimedShot,
): { scene: SceneInput | null; diagnostics: Diagnostic[] } {
  const { episode } = timeline,
    s = timed.shot,
    layers: unknown[] = [];
  if (s.external || s.scene) return { scene: null, diagnostics: [] };
  if (s.background) layers.push({ id: 'room', type: 'background', ref: s.background });
  for (const c of s.characters) {
    const { character, layer, pose, expressions, gestures, ...common } = c;
    layers.push({
      ...common,
      id: layer ?? c.id,
      type: 'character',
      character: character ?? c.id,
      at: place(c.at),
      poses: [{ t: 0, pose }],
      animations: [
        'idle_alive',
        ...c.animations,
        ...gestures.map(({ name, ...g }) => ({ gesture: name, ...g })),
        ...expressions.map(({ name, ...e }) => ({ expression: name, ...e })),
      ],
    });
  }
  for (const kind of ['props', 'bubbles', 'ui'] as const)
    for (const [i, a] of s[kind].entries()) {
      const { content, ...rest } = a;
      layers.push({
        ...rest,
        id: a.id ?? `${kind}_${i}`,
        type: kind === 'props' ? 'prop' : kind === 'bubbles' ? 'bubble' : 'ui',
        at: place(a.at),
        ...(kind === 'bubbles' && content ? { content } : {}),
      });
    }
  layers.push(...s.layers);
  const raw = {
    version: 1,
    id: s.id,
    library: episode.library,
    width: episode.size[0],
    height: episode.size[1],
    fps: episode.fps,
    duration: timed.duration,
    narration: { ...episode.narration, offset: timed.start },
    layers,
    camera: s.camera ?? episode.defaults.camera,
    look: null,
  };
  const parsed = parseScene(raw);
  return {
    scene: parsed.scene,
    diagnostics: parsed.diagnostics.map((d) => ({
      ...d,
      code: 'episode-' + d.code,
      path: `/shots/${s.id}` + d.path,
    })),
  };
}
export function shotAssetDiagnostics(missing: MissingAsset[]): Diagnostic[] {
  return missing.map((m) =>
    episodeDiagnostic(
      'episode-asset-missing',
      '/shots',
      `missing ${m.kind} ${m.id}${m.pose ? '/' + m.pose : ''} for ${m.shots.join(', ')}`,
      'run episode plan to write an asset request, then add and rig the asset',
    ),
  );
}
