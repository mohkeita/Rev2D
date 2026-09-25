/**
 * remove with "cascade": removes an item and fixes up everything that references it, logging each
 * change. Dependents are handled by object identity (not index), so removals earlier in the
 * cascade never shift later fix-ups onto the wrong item.
 *
 *   bone      child bones -> removed bone's parent, setup world pose kept (keyforms remapped);
 *             warps/parts -> removed bone's parent; skin lists drop it (weights column too; an
 *             empty skin is deleted and the part follows the removed bone's parent);
 *             bindings/tracks on it and IK constraints using it are removed
 *   warp      child warps/parts -> removed warp's parent; bindings/tracks on it removed
 *   part      mask lists drop it (empty mask deleted with maskInvert); bindings/tracks removed
 *   parameter single-parameter bindings removed (warning when that changes the rest pose);
 *             multi-parameter bindings drop that dimension, keeping the values the rig produced
 *             at the parameter default (keyforms sliced or interpolated there); tracks removed;
 *             physics inputs/outputs removed (a group left without any is removed)
 *   texture   image parts using it are removed (cascading); meshes lose texture + uvs
 *   ik        bindings/tracks on ik:<id>.mix removed
 */
import { paramDefault } from '../core/address.js';
import type { RawValue, ResolvedTarget } from '../core/types.js';
import { normalizeValue } from '../core/values.js';
import { reexpressBone, parentOf, boneTrs, trsMatrix } from './bones.js';
import { axisPosition, lerpRaw, sample1D, valueJson, valuesClose } from './keyforms.js';
import { canonicalTarget, type Doc, type Item, itemKeys, itemLabel, type Kind, resolveRaw, SECTION_KIND, sectionItems, setOrdered } from './model.js';
import { findRefs, type Ref } from './refs.js';
import { fmt, isObject, q, show } from './util.js';

export class Cascade {
  readonly log: string[] = [];

  constructor(private readonly doc: Doc) {}

  /** Remove `item` (of `kind`) and fix up its dependents. */
  remove(kind: Kind, item: Item): void {
    const id = typeof item.id === 'string' ? item.id : undefined;
    if (id !== undefined) {
      for (const ref of findRefs(this.doc, kind, id)) this.fix(kind, item, id, ref);
    }
    this.detach(kind, item);
  }

  private detach(kind: Kind, item: Item): boolean {
    const items = sectionItems(this.doc, kind) ?? [];
    const i = items.indexOf(item);
    if (i < 0) return false;
    items.splice(i, 1);
    return true;
  }

  private present(kind: Kind, item: Item): boolean {
    return (sectionItems(this.doc, kind) ?? []).includes(item);
  }

  private removeDependent(kind: Kind, item: Item, reason: string): void {
    if (!this.present(kind, item)) return;
    this.log.push(`removed ${itemLabel(kind, item)} (${reason})`);
    this.remove(kind, item);
  }

  private fix(kind: Kind, removed: Item, id: string, ref: Ref): void {
    const owner = ref.owner;
    switch (ref.type) {
      case 'parent':
        return this.fixParent(kind, removed, id, ref);
      case 'skin':
        return this.fixSkin(removed, id, owner);
      case 'mask': {
        if (!this.present('part', owner) || !Array.isArray(owner.mask)) return;
        owner.mask = owner.mask.filter((m) => m !== id);
        if ((owner.mask as unknown[]).length) {
          this.log.push(`removed ${q(id)} from ${itemLabel('part', owner)} mask`);
        } else {
          delete owner.mask;
          delete owner.maskInvert;
          this.log.push(`deleted ${itemLabel('part', owner)} mask (it only listed ${q(id)})`);
        }
        return;
      }
      case 'target':
        if (ref.track) {
          const tracks = owner.tracks;
          if (!this.present('animation', owner) || !Array.isArray(tracks)) return;
          const i = tracks.indexOf(ref.track);
          if (i < 0) return;
          tracks.splice(i, 1);
          this.log.push(`removed track ${String(ref.track.target)} from ${itemLabel('animation', owner)}`);
        } else {
          this.removeDependent('binding', owner, `it targets ${q(id)}`);
        }
        return;
      case 'binding-param':
        return this.fixBindingParam(removed, id, owner);
      case 'ik-bone':
      case 'ik-target':
        return this.removeDependent('ik', owner, `it uses bone ${q(id)}`);
      case 'physics-input':
      case 'physics-output': {
        const list = ref.type === 'physics-input' ? 'inputs' : 'outputs';
        const entries = owner[list];
        if (!this.present('physics', owner) || !Array.isArray(entries)) return;
        const i = entries.indexOf(ref.entry);
        if (i < 0) return;
        entries.splice(i, 1);
        if (entries.length) {
          this.log.push(`removed ${list === 'inputs' ? 'input' : 'output'} ${q(id)} from ${itemLabel('physics', owner)}`);
        } else {
          this.detach('physics', owner);
          this.log.push(`removed ${itemLabel('physics', owner)} (its only ${list === 'inputs' ? 'input' : 'output'} was ${q(id)})`);
        }
        return;
      }
      case 'texture': {
        const shape = owner.shape;
        if (!this.present('part', owner) || !isObject(shape)) return;
        if (shape.type === 'mesh') {
          delete shape.texture;
          delete shape.uvs;
          this.log.push(`removed texture and uvs from mesh ${itemLabel('part', owner)}`);
        } else {
          this.removeDependent('part', owner, `its image uses texture ${q(id)}`);
        }
        return;
      }
    }
  }

  /** Children of a removed bone/warp move to its parent. Child bones keep their setup world pose. */
  private fixParent(kind: Kind, removed: Item, id: string, ref: Ref): void {
    const childKind = SECTION_KIND[ref.section];
    const child = ref.owner;
    if (!this.present(childKind, child) || child.parent !== id) return;
    const newParent = parentOf(removed);
    const to = newParent === undefined ? 'model space (no parent)' : q(newParent);
    if (newParent === undefined) delete child.parent;
    else setOrdered(child, 'parent', newParent, itemKeys(childKind));
    if (childKind === 'bone' && kind === 'bone') {
      // newLocal = removedLocal · childLocal keeps world = grandparentWorld · newLocal unchanged.
      const change = reexpressBone(this.doc, child, trsMatrix(boneTrs(removed)));
      this.log.push(`reparented ${itemLabel('bone', child)} to ${to} keeping its setup world pose (${change})`);
    } else {
      this.log.push(`reparented ${itemLabel(childKind, child)} to ${to}`);
    }
  }

  private fixSkin(removed: Item, id: string, part: Item): void {
    const skin = part.skin;
    if (!this.present('part', part) || !isObject(skin) || !Array.isArray(skin.bones)) return;
    const keep = skin.bones.map((b) => b !== id);
    if (keep.every(Boolean)) return;
    skin.bones = skin.bones.filter((_, j) => keep[j]);
    if (Array.isArray(skin.weights)) {
      skin.weights = skin.weights.map((row) => (Array.isArray(row) && row.length === keep.length ? row.filter((_, j) => keep[j]) : row));
    }
    if ((skin.bones as unknown[]).length) {
      this.log.push(`removed ${q(id)} from ${itemLabel('part', part)} skin${Array.isArray(skin.weights) ? ' (and its weights column)' : ''}`);
      return;
    }
    delete part.skin;
    const newParent = parentOf(removed);
    if (newParent !== undefined && part.parent === undefined) {
      setOrdered(part, 'parent', newParent, itemKeys('part'));
      this.log.push(`deleted ${itemLabel('part', part)} skin (no bones left); it now follows ${q(newParent)}`);
    } else {
      this.log.push(`deleted ${itemLabel('part', part)} skin (no bones left); it is now in model space`);
    }
  }

  /** Resolved target of a binding, or undefined when it cannot be resolved (then values are kept as is). */
  private resolveTarget(binding: Item): ResolvedTarget | undefined {
    try {
      return resolveRaw(this.doc, binding.target, 'remove').resolved;
    } catch {
      return undefined;
    }
  }

  /**
   * Drop a removed parameter from a binding so the rig keeps looking the way it did at the
   * parameter's default. Multi-parameter bindings keep the other dimensions: their keyforms become
   * the values at the default, sliced (default on a grid value, clamped outside the grid, or
   * step interpolation) or interpolated between the two bracketing grid values, exactly as the
   * evaluator blends them. Single-parameter bindings are removed, with a warning when their value
   * at the default was not the setup value.
   */
  private fixBindingParam(removed: Item, id: string, binding: Item): void {
    if (!this.present('binding', binding) || !Array.isArray(binding.params)) return;
    const params = binding.params as unknown[];
    const d = params.indexOf(id);
    if (d < 0) return;
    const keys = (Array.isArray(binding.keys) ? binding.keys : []).filter((k): k is Item => isObject(k) && Array.isArray(k.at) && typeof k.at[d] === 'number');
    const axis = [...new Set(keys.map((k) => (k.at as number[])[d]))].sort((a, b) => a - b);
    const min = typeof removed.min === 'number' ? removed.min : 0;
    const max = typeof removed.max === 'number' ? removed.max : 0;
    const rest = paramDefault({ min, max, default: typeof removed.default === 'number' ? removed.default : undefined });
    const step = binding.interpolation === 'step';
    if (params.length === 1 || axis.length === 0) {
      this.removeDependent('binding', binding, `it is driven by ${q(id)}${this.restChange(binding, keys, id, rest, step)}`);
      return;
    }

    const label = itemLabel('binding', binding);
    const others = (k: Item) => (k.at as unknown[]).filter((_, j) => j !== d);
    const { lo, hi, frac } = axisPosition(axis, rest, step);
    const slice = keys.filter((k) => (k.at as number[])[d] === lo);
    const n = `${slice.length} keyform${slice.length === 1 ? '' : 's'}`;
    let values = slice.map((k) => k.value);
    let detail = `kept the ${n} at ${id} = ${fmt(lo)}${lo === rest ? ', its default' : `, which the rig used at its default ${fmt(rest)}`}`;
    if (frac > 0) {
      const upper = new Map(keys.filter((k) => (k.at as number[])[d] === hi).map((k) => [JSON.stringify(others(k)), k.value]));
      const target = this.resolveTarget(binding);
      const partners = slice.map((k) => upper.get(JSON.stringify(others(k))));
      let blended: unknown[] | undefined;
      if (target && partners.every((p) => p !== undefined)) {
        try {
          blended = slice.map((k, i) => lerpRaw(k.value, partners[i], frac, target));
        } catch {
          // A keyform value does not fit the target; validation reports it, keep the lower slice.
        }
      }
      if (blended) {
        values = blended;
        detail = `${n} interpolated at ${id} = ${fmt(rest)}, its default, between the ${fmt(lo)} and ${fmt(hi)} keyforms`;
      } else {
        detail = `kept the ${n} at ${id} = ${fmt(lo)}; WARNING: approximate: the rig blended the ${fmt(lo)} and ${fmt(hi)} keyforms at the default ${fmt(rest)}, but they could not be interpolated (incomplete grid or invalid values)`;
      }
    }
    binding.params = params.filter((_, j) => j !== d);
    binding.keys = slice.map((k, i) => {
      k.at = others(k);
      k.value = values[i];
      return k;
    });
    this.log.push(`dropped parameter ${q(id)} from ${label} (${detail})`);
  }

  /**
   * Warning for a single-parameter binding about to be removed whose value at the parameter
   * default differs from the setup value (so the rest pose changes), with the op that restores
   * the look when it is exact (the only binding on the property, and a settable value type).
   */
  private restChange(binding: Item, keys: Item[], id: string, rest: number, step: boolean): string {
    const target = this.resolveTarget(binding);
    if (!target) return '';
    let value: unknown;
    try {
      value = sample1D(keys, rest, step, target);
      if (value === undefined || valuesClose(normalizeValue(value as RawValue, target), target.setup, target.valueType)) return '';
    } catch {
      return '';
    }
    const others = (sectionItems(this.doc, 'binding') ?? []).filter((b) => b !== binding && isObject(b) && canonicalTarget(b.target) === target.key);
    const settable = target.address.kind !== 'warp' && (target.valueType === 'number' || target.valueType === 'color' || target.valueType === 'boolean');
    const fix = !others.length && settable ? `; to keep it: {"op": "set", "target": ${q(target.key)}, "value": ${JSON.stringify(value)}}` : '';
    return `; WARNING: at its default (${id} = ${fmt(rest)}) it held ${target.key} at ${show(value)} instead of the setup value ${show(valueJson(target.setup, target.valueType))}, so the rest pose changes${fix}`;
  }
}
