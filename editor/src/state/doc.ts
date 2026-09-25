/**
 * Raw-document helpers (pure): entity references ("part:mouth"), lookup/replacement of objects in
 * the RAW model JSON (as written on disk, before defaults are filled in), JSON-pointer resolution
 * for diagnostics and a simple snapshot undo history.
 *
 * Reference strings follow the property-address grammar: "<kind>:<id>". Bindings may have no id;
 * they are then referenced by array index ("binding:3"; ids never start with a digit, so this
 * cannot collide).
 */

export type EntityKind = 'part' | 'bone' | 'warp' | 'param' | 'animation' | 'binding' | 'ik' | 'physics' | 'texture';

export const ENTITY_KINDS: EntityKind[] = ['part', 'bone', 'warp', 'param', 'animation', 'binding', 'ik', 'physics', 'texture'];

/** Model section holding each kind. */
export const KIND_SECTION: Record<EntityKind, string> = {
  part: 'parts',
  bone: 'bones',
  warp: 'warps',
  param: 'parameters',
  animation: 'animations',
  binding: 'bindings',
  ik: 'ik',
  physics: 'physics',
  texture: 'textures',
};

const SECTION_KIND = new Map(Object.entries(KIND_SECTION).map(([k, s]) => [s, k as EntityKind]));

/** Aliases accepted in commands ("select" from AI tools) besides the canonical kind names. */
const KIND_ALIASES: Record<string, EntityKind> = {
  parameter: 'param',
  anim: 'animation',
  constraint: 'ik',
};

export interface EntityRef {
  kind: EntityKind;
  id: string;
}

export type RawDoc = Record<string, unknown>;

export function refKey(ref: EntityRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** Parse "kind:id" (canonical or alias kind). Returns null for malformed strings. */
export function parseRefKey(key: string): EntityRef | null {
  const colon = key.indexOf(':');
  if (colon <= 0) return null;
  const rawKind = key.slice(0, colon);
  const kind = (ENTITY_KINDS as string[]).includes(rawKind) ? (rawKind as EntityKind) : KIND_ALIASES[rawKind];
  const id = key.slice(colon + 1);
  return kind && id ? { kind, id } : null;
}

function section(doc: RawDoc | null, kind: EntityKind): unknown[] {
  const arr = doc?.[KIND_SECTION[kind]];
  return Array.isArray(arr) ? arr : [];
}

function idOf(value: unknown): string | undefined {
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return undefined;
}

/** Reference id of the item at `index` of a section (bindings without id use the index). */
export function entityIdAt(doc: RawDoc | null, kind: EntityKind, index: number): string | null {
  const item = section(doc, kind)[index];
  if (item === undefined) return null;
  return idOf(item) ?? (kind === 'binding' ? String(index) : null);
}

/** Index of the referenced object in its section, or -1. */
export function findEntityIndex(doc: RawDoc | null, ref: EntityRef): number {
  const items = section(doc, ref.kind);
  const byId = items.findIndex((it) => idOf(it) === ref.id);
  if (byId >= 0) return byId;
  if (ref.kind === 'binding' && /^\d+$/.test(ref.id)) {
    const i = Number(ref.id);
    return i < items.length ? i : -1;
  }
  return -1;
}

export function getEntity(doc: RawDoc | null, ref: EntityRef): unknown {
  const i = findEntityIndex(doc, ref);
  return i < 0 ? undefined : section(doc, ref.kind)[i];
}

/**
 * Resolve a selection string from the UI or an AI command: "kind:id" is checked against the doc;
 * a bare id is looked up in kind order (parts first, since that is what people click on).
 */
export function resolveRef(doc: RawDoc | null, key: string): EntityRef | null {
  const parsed = parseRefKey(key);
  if (parsed) return findEntityIndex(doc, parsed) >= 0 ? canonicalRef(doc, parsed) : null;
  for (const kind of ENTITY_KINDS) {
    const ref = { kind, id: key };
    if (kind !== 'binding' && findEntityIndex(doc, ref) >= 0) return ref;
  }
  return null;
}

/** Bindings that have an id are referenced by it, even when addressed by index. */
function canonicalRef(doc: RawDoc | null, ref: EntityRef): EntityRef {
  if (ref.kind !== 'binding') return ref;
  const i = findEntityIndex(doc, ref);
  return { kind: 'binding', id: entityIdAt(doc, 'binding', i) ?? ref.id };
}

/** JSON pointer of an entity, e.g. "/parts/3". */
export function entityPointer(doc: RawDoc | null, ref: EntityRef): string | null {
  const i = findEntityIndex(doc, ref);
  return i < 0 ? null : `/${KIND_SECTION[ref.kind]}/${i}`;
}

/**
 * Entity addressed by a diagnostic's JSON pointer ("/parts/3/shape/rx" -> part:<id of parts[3]>).
 * Null for pointers outside entity sections (e.g. "/meta/width") or out-of-range indices.
 */
export function refFromPointer(doc: RawDoc | null, pointer: string): EntityRef | null {
  const [, sec, index] = pointer.split('/').map(unescapePointer);
  const kind = sec === undefined ? undefined : SECTION_KIND.get(sec);
  if (!kind || index === undefined || !/^\d+$/.test(index)) return null;
  const id = entityIdAt(doc, kind, Number(index));
  return id === null ? null : { kind, id };
}

function unescapePointer(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** New document with the referenced object replaced (structural sharing for untouched sections). */
export function replaceEntity(doc: RawDoc, ref: EntityRef, value: unknown): RawDoc {
  const i = findEntityIndex(doc, ref);
  if (i < 0) throw new Error(`${refKey(ref)} not found in the document`);
  const items = [...section(doc, ref.kind)];
  items[i] = value;
  return { ...doc, [KIND_SECTION[ref.kind]]: items };
}

/**
 * Reference of `value` after it replaced `ref`: follows an id rename, keeps index references for
 * id-less bindings.
 */
export function refAfterEdit(ref: EntityRef, value: unknown, index: number): EntityRef {
  const id = idOf(value);
  if (id) return { kind: ref.kind, id };
  return ref.kind === 'binding' ? { kind: 'binding', id: String(index) } : ref;
}

/**
 * True when JSONC text contains a `//` or `/* *\/` comment outside string literals. Writes from the
 * editor (PUT {doc}) produce canonical JSON, so such comments would be lost.
 */
export function hasJsonComments(text: string): boolean {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      return true;
    }
  }
  return false;
}

// ----------------------------------------------------------------------------------- history

export interface HistoryEntry {
  doc: RawDoc;
  /** What produced this state, e.g. "Edit part:mouth" or "External change". */
  label: string;
}

/**
 * Linear snapshot history. The entry at `index` is the current document; `push` drops any redo
 * branch. Snapshots share structure (see replaceEntity), so memory stays proportional to edits.
 */
export class DocHistory {
  private entries: HistoryEntry[] = [];
  private index = -1;

  constructor(private readonly limit = 100) {}

  get current(): HistoryEntry | null {
    return this.entries[this.index] ?? null;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }

  /** Label of the change that undo would revert. */
  get undoLabel(): string | null {
    return this.canUndo ? this.entries[this.index].label : null;
  }

  get redoLabel(): string | null {
    return this.canRedo ? this.entries[this.index + 1].label : null;
  }

  /** Forget everything and start from `doc`. */
  reset(doc: RawDoc, label = 'Open'): void {
    this.entries = [{ doc, label }];
    this.index = 0;
  }

  push(doc: RawDoc, label: string): void {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ doc, label });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.index = this.entries.length - 1;
  }

  /** Step back; returns the entry that becomes current and the label of the undone change. */
  undo(): { entry: HistoryEntry; undone: string } | null {
    if (!this.canUndo) return null;
    const undone = this.entries[this.index].label;
    this.index--;
    return { entry: this.entries[this.index], undone };
  }

  redo(): HistoryEntry | null {
    if (!this.canRedo) return null;
    this.index++;
    return this.entries[this.index];
  }
}
