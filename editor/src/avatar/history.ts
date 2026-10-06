/**
 * Undo / redo of the avatar spec (pure): snapshots of the raw document with a label per step. A
 * drag is ONE step (the store pushes when the gesture ends); a change that arrived from disk is a
 * step too, so it can be undone like an edit.
 */
import type { SpecDoc } from './geometry.js';

export interface HistoryEntry {
  doc: SpecDoc;
  /** What produced this version ("Move Left eye · opening"); empty for the first one. */
  label: string;
}

export const HISTORY_LIMIT = 200;

export class SpecHistory {
  private entries: HistoryEntry[] = [];
  private index = -1;

  /** Start over with `doc` as the only version. */
  reset(doc: SpecDoc): void {
    this.entries = [{ doc, label: '' }];
    this.index = 0;
  }

  get current(): HistoryEntry | null {
    return this.entries[this.index] ?? null;
  }

  /** Record a new version after the current one (the redo steps are dropped). */
  push(doc: SpecDoc, label: string): void {
    if (this.index < 0) {
      this.reset(doc);
      return;
    }
    this.entries = [...this.entries.slice(0, this.index + 1), { doc, label }];
    if (this.entries.length > HISTORY_LIMIT) this.entries = this.entries.slice(this.entries.length - HISTORY_LIMIT);
    this.index = this.entries.length - 1;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  /** Label of the step undo would revert. */
  get undoLabel(): string | null {
    return this.canUndo ? this.entries[this.index].label : null;
  }

  get redoLabel(): string | null {
    return this.canRedo ? this.entries[this.index + 1].label : null;
  }

  /** Go one step back: the version before, and the label of the step that was undone. */
  undo(): { doc: SpecDoc; undone: string } | null {
    if (!this.canUndo) return null;
    const undone = this.entries[this.index].label;
    this.index--;
    return { doc: this.entries[this.index].doc, undone };
  }

  redo(): HistoryEntry | null {
    if (!this.canRedo) return null;
    this.index++;
    return this.entries[this.index];
  }

  /** Number of versions kept (for tests). */
  get size(): number {
    return this.entries.length;
  }
}
