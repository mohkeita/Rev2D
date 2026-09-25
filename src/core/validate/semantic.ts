/**
 * Semantic pass over a structurally valid (normalized) model. Checks run in dependency order
 * (parts before bindings, so broken shapes are known); the output is ordered by model section and
 * item index so diagnostics read top to bottom like the file.
 */
import type { Diagnostic, Model } from '../types.js';
import { ModelSchema } from '../schema.js';
import { SemanticContext } from './context.js';
import { checkBones, checkMeta, checkParameters, checkParts, checkTextures, checkWarps } from './checks-scene.js';
import { checkAnimations, checkBindings, checkIk, checkPhysics } from './checks-motion.js';

const SECTION_RANK = new Map(Object.keys(ModelSchema.shape).map((k, i) => [k, i]));

export function semanticDiagnostics(model: Model): Diagnostic[] {
  const ctx = new SemanticContext(model);
  checkMeta(ctx);
  checkParameters(ctx);
  checkTextures(ctx);
  checkBones(ctx);
  checkWarps(ctx);
  checkParts(ctx);
  checkBindings(ctx);
  checkIk(ctx);
  checkPhysics(ctx);
  checkAnimations(ctx);
  return sortByLocation(ctx.sink.items);
}

/** Stable sort by (section, item index); diagnostics of one item keep their check order. */
function sortByLocation(items: Diagnostic[]): Diagnostic[] {
  const keyOf = (d: Diagnostic): [number, number] => {
    const [, section = '', index = ''] = d.path.split('/');
    return [SECTION_RANK.get(section) ?? -1, /^\d+$/.test(index) ? Number(index) : -1];
  };
  const keyed = items.map((d) => ({ d, key: keyOf(d) }));
  keyed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]);
  return keyed.map((k) => k.d);
}
