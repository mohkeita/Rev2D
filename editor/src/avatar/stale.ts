/**
 * Which edits need new layer images (pure). The layer images (textures/) are cut from the
 * illustration along the polygons that "cut layers"; layerInputsHash(spec) fingerprints those
 * values, and the build stores it as LayersMeta.inputsHash. When the two differ, the preview still
 * shows the old cut-outs: the person has to rebuild the layers.
 *
 *   layersStale(spec, meta)          the layers no longer match the spec
 *   changedCutItems(baseline, doc)   the items that cut layers and changed since `baseline` (the
 *                                    document the layers were built from), for the banner
 */
import { canonicalJson, describeAvatarParts, layerInputsHash, resolvePointer, type AvatarPartItemInfo, type AvatarSpec, type LayersMeta } from '../../../src/avatar/index.js';
import { entryPointer } from './placement.js';

/** True when layer images exist and were cut from other values than `spec` has (false while the spec is invalid). */
export function layersStale(spec: AvatarSpec | null, meta: LayersMeta | null): boolean {
  if (!spec || !meta || typeof meta.inputsHash !== 'string') return false;
  return layerInputsHash(spec) !== meta.inputsHash;
}

/** The values of an item that decide its cut-out (a strand's width and group count too). */
function cutValue(doc: unknown, item: AvatarPartItemInfo): string {
  const values: unknown[] = Object.entries(item.shape)
    .filter(([key]) => key !== 'type')
    .map(([, pointer]) => resolvePointer(doc, pointer as string));
  const entry = entryPointer(item);
  if (entry && item.id.startsWith('strand.')) {
    const strand = resolvePointer(doc, entry) as Record<string, unknown> | undefined;
    values.push(strand?.width, strand?.group ?? 'front');
  }
  return canonicalJson(values);
}

/**
 * Ids of the items that cut layers and differ between `baseline` and `doc` (added, removed or
 * moved), in list order; items of `doc` first, then ones only `baseline` has.
 */
export function changedCutItems(baseline: unknown, doc: unknown): string[] {
  const now = describeAvatarParts(doc).flatMap((g) => g.items.filter((i) => i.cutsLayers));
  const before = new Map(
    describeAvatarParts(baseline)
      .flatMap((g) => g.items.filter((i) => i.cutsLayers))
      .map((i) => [i.id, i] as const),
  );
  const out: string[] = [];
  for (const item of now) {
    const old = before.get(item.id);
    if (!old || cutValue(baseline, old) !== cutValue(doc, item)) out.push(item.id);
    before.delete(item.id);
  }
  for (const id of before.keys()) out.push(id);
  return out;
}
