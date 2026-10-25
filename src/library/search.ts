import type { Library, LibraryKind } from './schema.js';

export interface LibraryEntry {
  kind: LibraryKind;
  id: string;
  character?: string;
  name: string;
  tags: string[];
  source: string;
  description: string;
}
export function libraryEntries(library: Library): LibraryEntry[] {
  const entries: LibraryEntry[] = [];
  for (const c of library.characters)
    for (const p of c.poses)
      entries.push({
        kind: 'character',
        id: p.id,
        character: c.id,
        name: c.name,
        tags: p.tags,
        source: p.avatar,
        description: c.description,
      });
  for (const [kind, items] of [
    ['background', library.backgrounds],
    ['prop', library.props],
    ['bubble', library.bubbles],
  ] as const)
    for (const item of items)
      entries.push({ kind, id: item.id, name: item.id, tags: item.tags, source: item.src, description: '' });
  for (const item of library.ui)
    entries.push({ kind: 'ui', id: item.id, name: item.id, tags: item.tags, source: item.model, description: '' });
  return entries;
}
export interface SearchOptions {
  kind?: LibraryKind;
  character?: string;
  tags?: string[];
  text?: string;
}
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
export function searchLibrary(library: Library, options: SearchOptions = {}): LibraryEntry[] {
  const words = normalize(options.text ?? '')
    .split(/\s+/)
    .filter(Boolean);
  return libraryEntries(library).filter(
    (e) =>
      (!options.kind || e.kind === options.kind) &&
      (!options.character || e.character === options.character) &&
      (options.tags ?? []).every((tag) => e.tags.some((t) => normalize(t) === normalize(tag))) &&
      words.every((w) => normalize([e.id, e.character, e.name, e.description, ...e.tags].join(' ')).includes(w)),
  );
}
