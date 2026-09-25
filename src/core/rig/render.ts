/**
 * Render list construction: visible parts in draw order, fill then stroke, with tint/opacity baked
 * into vertex colors and mask geometry attached.
 */
import { parseColor } from '../color.js';
import type { DrawItem, MeshBatch, PartPose, Pose, RenderList, RGBA, Value } from '../types.js';
import { normalizeValue } from '../values.js';
import type { CompiledPart, CompiledRig, GeometryEntry } from './compiled.js';
import { geometryOfPose, partGeometry } from './evaluate.js';

export function buildRenderListFor(c: CompiledRig, pose: Pose, backgroundOverride: string | undefined): RenderList {
  const bg = backgroundOverride ?? c.model.meta.background;
  const background = parseColor(bg);
  if (!background) throw new Error(`Rig: invalid background color "${bg}"`);
  const geometry = geometryOfPose(pose, c) ?? geometryFromProperties(c, pose);
  const maskCache = new Map<number, DrawItem[]>();
  const maskDraws = (m: number): DrawItem[] => {
    let items = maskCache.get(m);
    if (!items) {
      const cp = c.parts[m];
      items = partDraws(cp, geometry[m], posePart(pose, cp), null);
      maskCache.set(m, items);
    }
    return items;
  };

  const draws: DrawItem[] = [];
  for (const id of pose.drawOrder) {
    const index = c.partIndex.get(id);
    if (index === undefined) throw new Error(`Rig: pose draws unknown part "${id}"`);
    const cp = c.parts[index];
    const pp = posePart(pose, cp);
    const items = partDraws(cp, geometry[index], pp, pp);
    if (cp.masks.length) {
      // Attached even when empty (every mask part lacks geometry in this pose): a present list means
      // "clip", and the union of nothing covers nothing, so the part draws nowhere (everywhere inverted).
      // All items of the part share this one array.
      const masks = cp.masks.flatMap(maskDraws);
      for (const item of items) {
        item.masks = masks;
        item.maskInvert = cp.maskInvert;
      }
    }
    draws.push(...items);
  }
  return { width: c.model.meta.width, height: c.model.meta.height, background, draws };
}

function posePart(pose: Pose, cp: CompiledPart): PartPose {
  const pp = pose.parts[cp.id];
  if (!pp) throw new Error(`Rig: pose has no entry for part "${cp.id}"`);
  return pp;
}

/**
 * Fill then stroke draws of a part. With `paint` (tint + opacity) the colors are modulated; without it
 * the batch paint is used as is (mask coverage ignores the mask part's own tint/opacity/visibility).
 */
function partDraws(cp: CompiledPart, entry: GeometryEntry, pp: PartPose, paint: PartPose | null): DrawItem[] {
  const out: DrawItem[] = [];
  const add = (kind: 'fill' | 'stroke', batch: MeshBatch | null, positions: Float32Array | null) => {
    if (!batch || batch.indices.length === 0) return;
    if (!positions || positions.length !== batch.positions.length) {
      throw new Error(`Rig: pose ${kind} positions of part "${cp.id}" do not match the rig geometry`);
    }
    const item: DrawItem = {
      partId: cp.id,
      kind,
      positions,
      colors: paint ? modulate(batch.colors, paint.tint, paint.opacity) : batch.colors,
      indices: batch.indices,
      blend: paint ? cp.blend : 'normal',
    };
    if (batch.uvs) item.uvs = batch.uvs;
    if (batch.texture !== undefined) item.texture = batch.texture;
    out.push(item);
  };
  add('fill', entry.geometry.fill, pp.fill);
  add('stroke', entry.geometry.stroke, pp.stroke);
  return out;
}

function modulate(colors: Float32Array, tint: RGBA, opacity: number): Float32Array {
  const out = new Float32Array(colors.length);
  const a = tint[3] * opacity;
  for (let i = 0; i < colors.length; i += 4) {
    out[i] = colors[i] * tint[0];
    out[i + 1] = colors[i + 1] * tint[1];
    out[i + 2] = colors[i + 2] * tint[2];
    out[i + 3] = colors[i + 3] * a;
  }
  return out;
}

/**
 * Geometry for a pose that did not come from this rig's evaluator (a structured clone, or a pose of
 * another Rig instance): dynamic parts are rebuilt from the pose's recorded property values.
 */
function geometryFromProperties(c: CompiledRig, pose: Pose): GeometryEntry[] {
  const values: Array<Value | undefined> = new Array(c.slots.length);
  c.slots.forEach((slot, s) => {
    const json = pose.properties[slot.key];
    if (slot.target.kind === 'geometry' && json !== undefined) values[s] = normalizeValue(json, slot);
  });
  return c.parts.map((cp) => partGeometry(c, cp, values));
}
