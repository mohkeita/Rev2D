/**
 * Shared state for the semantic checks: id indexes per kind, cross-reference usage, and helpers for
 * reporting unknown references with did-you-mean hints.
 */
import type { Address, Mat2D, Model, Parameter } from '../types.js';
import { AddressError, parseAddress } from '../address.js';
import { fromTRS, multiply } from '../math.js';
import { DiagnosticSink, toPointer } from './diagnostics.js';
import { referenceHint, q } from './text.js';

/** Model sections that hold id'd objects, in file order. */
const ID_SECTIONS = ['parameters', 'textures', 'bones', 'warps', 'parts', 'bindings', 'ik', 'physics', 'animations'] as const;
export type IdSection = (typeof ID_SECTIONS)[number];

export const SINGULAR: Record<IdSection, string> = {
  parameters: 'parameter',
  textures: 'texture',
  bones: 'bone',
  warps: 'warp',
  parts: 'part',
  bindings: 'binding',
  ik: 'ik constraint',
  physics: 'physics group',
  animations: 'animation',
};

/** Sections that can be referenced by id from elsewhere, with their unknown-reference codes. */
type RefSection = 'parameters' | 'textures' | 'bones' | 'parts';
const UNKNOWN_CODE: Record<RefSection, string> = {
  parameters: 'unknown-parameter',
  textures: 'unknown-texture',
  bones: 'unknown-bone',
  parts: 'unknown-part',
};

export class SemanticContext {
  readonly sink = new DiagnosticSink();
  /** id -> index of its first definition, per section. */
  readonly ids: Record<IdSection, Map<string, number>>;
  /** Parts whose shape is invalid; binding/track targets on their shape fields are not checked further. */
  readonly brokenShapes = new Set<string>();

  // Usage, collected once up front.
  /** Parameters listed in some binding's `params`. */
  readonly boundParams = new Set<string>();
  readonly physicsInputs = new Set<string>();
  /** Parameter id -> pointer of the first animation track driving it. */
  readonly animatedParams = new Map<string, string>();
  /** Warps targeted by a binding or animation track. */
  readonly drivenWarps = new Set<string>();
  readonly usedTextures = new Set<string>();
  /** Ids referenced as `parent` by parts and warps. */
  readonly parentRefs = new Set<string>();
  private readonly idLists = new Map<IdSection, readonly string[]>();
  /** Setup world matrices by bone id (null = unknown bone or parent cycle). */
  private readonly setupWorlds = new Map<string, Mat2D | null>();

  constructor(readonly model: Model) {
    this.ids = Object.fromEntries(
      ID_SECTIONS.map((section) => {
        const map = new Map<string, number>();
        (model[section] as ReadonlyArray<{ id?: string }>).forEach((item, i) => {
          if (item.id !== undefined && !map.has(item.id)) map.set(item.id, i);
        });
        return [section, map];
      }),
    ) as Record<IdSection, Map<string, number>>;
    this.collectUsage();
  }

  private collectUsage(): void {
    const m = this.model;
    for (const b of m.bindings) {
      for (const p of b.params) this.boundParams.add(p);
      this.noteTarget(b.target);
    }
    for (const g of m.physics) for (const input of g.inputs) this.physicsInputs.add(input.param);
    m.animations.forEach((a, i) =>
      a.tracks.forEach((t, j) => {
        const address = this.noteTarget(t.target);
        if (address?.kind === 'param' && !this.animatedParams.has(address.id)) {
          this.animatedParams.set(address.id, toPointer(['animations', i, 'tracks', j]));
        }
      }),
    );
    for (const part of m.parts) {
      if (part.parent !== undefined) this.parentRefs.add(part.parent);
      const shape = part.shape;
      if (shape.type === 'image') this.usedTextures.add(shape.texture);
      else if (shape.type === 'mesh' && shape.texture !== undefined) this.usedTextures.add(shape.texture);
    }
    for (const w of m.warps) if (w.parent !== undefined) this.parentRefs.add(w.parent);
  }

  /** Records warp usage for a target address; undefined when malformed (reported by the target checks). */
  private noteTarget(target: string): Address | undefined {
    let address: Address;
    try {
      address = parseAddress(target);
    } catch (e) {
      if (e instanceof AddressError) return undefined;
      throw e;
    }
    if (address.kind === 'warp') this.drivenWarps.add(address.id);
    return address;
  }

  param(id: string): Parameter | undefined {
    const i = this.ids.parameters.get(id);
    return i === undefined ? undefined : this.model.parameters[i];
  }

  boneParent(id: string): string | undefined {
    const i = this.ids.bones.get(id);
    return i === undefined ? undefined : (this.model.bones[i].parent ?? undefined);
  }

  /** Ancestors of a bone, nearest first (stops at cycles and unknown parents). */
  boneAncestors(id: string): string[] {
    const out: string[] = [];
    const seen = new Set([id]);
    for (let p = this.boneParent(id); p !== undefined && !seen.has(p) && this.ids.bones.has(p); p = this.boneParent(p)) {
      out.push(p);
      seen.add(p);
    }
    return out;
  }

  /**
   * Setup-pose world matrix of a bone (first definition of its id), or null when the bone is unknown or
   * its parent chain is broken (unknown parent, cycle).
   */
  boneSetupWorld(id: string): Mat2D | null {
    const cached = this.setupWorlds.get(id);
    if (cached !== undefined) return cached;
    this.setupWorlds.set(id, null); // cycle guard
    const i = this.ids.bones.get(id);
    let world: Mat2D | null = null;
    if (i !== undefined) {
      const b = this.model.bones[i];
      const local = fromTRS(b.x, b.y, b.rotation, b.scaleX, b.scaleY);
      if (b.parent == null) world = local;
      else {
        const parent = this.boneSetupWorld(b.parent);
        world = parent ? multiply(parent, local) : null;
      }
    }
    this.setupWorlds.set(id, world);
    return world;
  }

  /** First section (in file order) that defines `id`. */
  sectionOf(id: string): IdSection | undefined {
    return ID_SECTIONS.find((s) => this.ids[s].has(id));
  }

  /** Ids defined in `section`, in file order (cached: unknown-reference hints compare against them). */
  idsOf(section: IdSection): readonly string[] {
    let list = this.idLists.get(section);
    if (list === undefined) {
      list = [...this.ids[section].keys()];
      this.idLists.set(section, list);
    }
    return list;
  }

  /** Report an unknown reference unless `id` exists in `section`. Returns whether it exists. */
  checkRef(section: RefSection, id: string, path: readonly PropertyKey[]): boolean {
    if (this.ids[section].has(id)) return true;
    this.sink.error(UNKNOWN_CODE[section], path, `unknown ${SINGULAR[section]} ${q(id)}`, referenceHint(id, this.idsOf(section), section));
    return false;
  }

  /** duplicate-id for every item whose id was already defined earlier in its section. */
  checkDuplicateIds(section: IdSection): void {
    const first = this.ids[section];
    (this.model[section] as ReadonlyArray<{ id?: string }>).forEach((item, i) => {
      if (item.id === undefined) return;
      const j = first.get(item.id)!;
      if (j !== i) {
        this.sink.error(
          'duplicate-id',
          [section, i, 'id'],
          `duplicate ${SINGULAR[section]} id ${q(item.id)}`,
          `already defined at ${toPointer([section, j])}; ids must be unique per kind`,
        );
      }
    });
  }
}
