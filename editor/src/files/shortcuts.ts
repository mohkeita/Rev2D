/**
 * File shortcuts as shown in the File menu and the shortcut sheet. Browsers keep some combinations
 * for themselves and never pass them to a page (Ctrl+N new window, Ctrl+W close tab, Ctrl+T), so
 * New is Alt+N; Ctrl+N still works where the browser lets it through (installed app windows).
 */
export const FILE_SHORTCUTS = {
  new: 'Alt+N',
  open: 'Ctrl+O',
  save: 'Ctrl+S',
  saveAs: 'Ctrl+Shift+S',
} as const;

export type FileShortcut = 'new' | 'open' | 'save' | 'saveAs';

/** Which file command a key press asks for (null: none). Pure, for the global key handler and tests. */
export function fileShortcut(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): FileShortcut | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && !e.altKey && key === 's') return e.shiftKey ? 'saveAs' : 'save';
  if (mod && !e.altKey && !e.shiftKey && key === 'o') return 'open';
  // Option+N on a Mac types a dead key: match the physical key as well.
  const n = key === 'n' || e.code === 'KeyN';
  if (!e.shiftKey && n && ((e.altKey && !mod) || (mod && !e.altKey))) return 'new';
  return null;
}
