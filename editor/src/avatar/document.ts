/**
 * avatar.json as the document of Avatar mode (shell/registry.ts ModeDocument): the toolbar's Save,
 * Undo and Redo, their shortcuts, the unsaved marker, the status line and the unsaved-changes
 * prompt act on it while Avatar mode is on screen (the prompt also while another mode is).
 */
import type { ModeDocument, ModeDocumentState } from '../shell/registry.js';
import { normalizeSlashes, samePath } from '../files/paths.js';
import type { AvatarRef } from '../api.js';
import { avatarStore, type AvatarState } from './store.js';

/** avatar.json of a project, relative to the workspace root. */
export function specPath(ref: Pick<AvatarRef, 'projectPath'>): string {
  return ref.projectPath ? `${ref.projectPath}/avatar.json` : 'avatar.json';
}

/** The last folder name of a path ("" for none). */
function lastName(path: string): string {
  const parts = normalizeSlashes(path).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** The document state of an avatar store state, or null while there is no document to save. */
export function avatarDocumentState(s: AvatarState): ModeDocumentState | null {
  if (!s.ref || s.status !== 'ready' || !s.doc) return null;
  const name = s.info?.name ?? (typeof s.doc.name === 'string' && s.doc.name ? s.doc.name : lastName(s.ref.project));
  return {
    name,
    path: specPath(s.ref),
    dirty: s.unsaved,
    saving: s.saving,
    canUndo: s.canUndo,
    canRedo: s.canRedo,
    undoLabel: s.undoLabel,
    redoLabel: s.redoLabel,
  };
}

function sameState(a: ModeDocumentState | null, b: ModeDocumentState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.name === b.name &&
    a.path === b.path &&
    a.dirty === b.dirty &&
    a.saving === b.saving &&
    a.canUndo === b.canUndo &&
    a.canRedo === b.canRedo &&
    a.undoLabel === b.undoLabel &&
    a.redoLabel === b.redoLabel
  );
}

/**
 * Whether opening `next` keeps the avatar project of `ref` open: its avatar.json, its folder, or a
 * model in its folder (the built model; the server opens the project with it).
 */
export function projectKeptBy(ref: Pick<AvatarRef, 'project' | 'specFile'> | null, next: string | null): boolean {
  if (!ref || next === null) return false;
  const n = normalizeSlashes(next);
  const dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
  return samePath(n, ref.project) || samePath(n, ref.specFile) || samePath(dir, ref.project);
}

let last: ModeDocumentState | null = null;

/** Avatar mode's document: avatar.json of the open project (avatarStore). */
export const avatarDocument: ModeDocument = {
  subscribe: (listener) => avatarStore.store.subscribe(listener),
  getState: () => {
    const next = avatarDocumentState(avatarStore.get());
    // The same object while nothing the chrome shows changed (React snapshots, the prompt's memory).
    if (!sameState(last, next)) last = next;
    return last;
  },
  save: () => avatarStore.save(),
  undo: () => avatarStore.undo(),
  redo: () => avatarStore.redo(),
  keptBy: (next) => projectKeptBy(avatarStore.get().ref, next),
};
