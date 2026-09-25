/**
 * Workspace file browser: breadcrumbs from the root, a filter box, folders and model files with
 * their modification time. Keyboard: arrows / Home / End / PageUp / PageDown move the highlight
 * (also while typing in the filter), Enter opens a folder or activates a model, Backspace (empty
 * filter) or Alt+Up goes to the parent folder. Double-click activates.
 *
 * mode 'open': picking a model is the goal. mode 'folder': picking a folder is the goal (Save As,
 * New, Import); model files are listed for reference and selecting one suggests its name.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import * as api from '../api.js';
import type { FileEntry } from '../api.js';
import { Icon } from '../ui/icons.js';
import { breadcrumbs, formatSize, formatWhen, isOpenable, moveHighlight, parentDir, visibleEntries } from './paths.js';

export interface FileBrowserProps {
  mode: 'open' | 'folder';
  dir: string;
  onDir(dir: string): void;
  /** Root-relative path of the highlighted entry. */
  selected: string | null;
  onSelect(entry: FileEntry | null): void;
  /** Enter / double-click on a model file. */
  onActivate(entry: FileEntry): void;
  rootName: string;
  /** Focus the filter box when mounted (the dialog's first field). */
  autoFocus?: boolean;
  /** Root-relative path of the open model (marked "open" in the list). */
  currentRel?: string | null;
  className?: string;
  /** Lets the parent know which names exist in the listed folder (overwrite checks, unique names). */
  onEntries?(entries: FileEntry[]): void;
}

type Listing = { dir: string; entries: FileEntry[] } | null;

export function FileBrowser({ mode, dir, onDir, selected, onSelect, onActivate, rootName, autoFocus, currentRel, className = '', onEntries }: FileBrowserProps) {
  const [listing, setListing] = useState<Listing>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const idBase = useRef(`fb-${Math.random().toString(36).slice(2, 8)}`).current;
  const onEntriesRef = useRef(onEntries);
  onEntriesRef.current = onEntries;

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    // The names of the previous folder no longer apply (overwrite checks, unique names).
    onEntriesRef.current?.([]);
    api
      .listFiles(dir, ctl.signal)
      .then((l) => {
        setListing({ dir, entries: l.entries });
        onEntriesRef.current?.(l.entries);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setListing({ dir, entries: [] });
        onEntriesRef.current?.([]);
        setError((e as { detail?: string }).detail ?? String(e));
        setLoading(false);
      });
    return () => ctl.abort();
  }, [dir]);

  // A new folder starts unfiltered.
  useEffect(() => setFilter(''), [dir]);

  // Rows of the folder shown. While another folder loads there are none: keys pressed meanwhile
  // must not pick (or Enter into) a row of the folder that was left.
  const shown = listing && listing.dir === dir ? listing : null;
  const entries = useMemo(() => (shown ? visibleEntries(shown.entries, filter) : []), [shown, filter]);
  const index = entries.findIndex((e) => e.path === selected);

  // Keep the highlighted row visible.
  useEffect(() => {
    if (index < 0) return;
    document.getElementById(`${idBase}-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index, idBase]);

  const enter = (e: FileEntry): void => {
    if (e.type === 'dir') {
      onSelect(null);
      onDir(e.path);
    } else if (isOpenable(e)) {
      onSelect(e);
      onActivate(e);
    }
  };

  const goUp = (): void => {
    const up = parentDir(dir);
    if (up === null) return;
    onSelect(null);
    onDir(up);
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLElement>): void => {
    const inInput = (ev.target as HTMLElement).tagName === 'INPUT';
    if ((ev.key === 'ArrowUp' && ev.altKey) || (ev.key === 'Backspace' && inInput && !filter)) {
      if (parentDir(dir) !== null) {
        ev.preventDefault();
        goUp();
      }
      return;
    }
    // Home / End keep moving the caret while the filter box has text.
    const caretKey = (ev.key === 'Home' || ev.key === 'End') && inInput && filter !== '';
    const next = caretKey || ev.altKey ? null : moveHighlight(index, ev.key, entries.length);
    if (next !== null) {
      ev.preventDefault();
      onSelect(entries[next]);
      return;
    }
    if (ev.key === 'Enter' && index >= 0) {
      const entry = entries[index];
      // In a folder picker Enter on a model only picks its name (the dialog confirms).
      if (entry.type === 'dir' || mode === 'open') {
        ev.preventDefault();
        enter(entry);
      }
    }
  };

  const crumbs = breadcrumbs(dir, rootName);
  const emptyText = error
    ? null
    : filter
      ? `Nothing in this folder matches "${filter}".`
      : mode === 'open'
        ? 'No models or folders here.'
        : 'No folders here yet. The file is saved in this folder.';

  return (
    <div className={`file-browser ${className}`.trim()} data-testid="file-browser">
      <div className="fb-bar">
        <button className="icon-button" title="Parent folder (Backspace)" aria-label="Parent folder" disabled={!dir} onClick={goUp} data-testid="fb-up">
          <Icon name="arrowUp" />
        </button>
        <nav className="fb-crumbs" aria-label="Folder">
          {crumbs.map((c, i) => (
            <span key={c.path} className="fb-crumb-wrap">
              {i > 0 && <Icon name="chevronRight" size={12} className="icon fb-crumb-sep" />}
              <button
                className={`fb-crumb${i === crumbs.length - 1 ? ' is-current' : ''}`}
                onClick={() => {
                  onSelect(null);
                  onDir(c.path);
                }}
                title={i === 0 ? 'Workspace root' : c.path}
                aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                data-testid={`fb-crumb-${i}`}
              >
                {i === 0 && <Icon name="home" size={13} />}
                <span>{c.label}</span>
              </button>
            </span>
          ))}
        </nav>
        <label className="search fb-filter">
          <Icon name="search" size={13} />
          <input
            type="text"
            value={filter}
            placeholder="Filter"
            aria-label="Filter files"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onKeyDown}
            data-autofocus={autoFocus ? '' : undefined}
            data-testid="fb-filter"
            spellCheck={false}
          />
        </label>
      </div>
      <div
        ref={listRef}
        className="fb-list"
        role="listbox"
        tabIndex={0}
        aria-label={mode === 'open' ? 'Models and folders' : 'Folders'}
        aria-activedescendant={index >= 0 ? `${idBase}-${index}` : undefined}
        onKeyDown={onKeyDown}
        data-testid="fb-list"
      >
        <div className="fb-head" aria-hidden="true">
          <span>Name</span>
          <span>Modified</span>
          <span className="fb-size">Size</span>
        </div>
        {entries.map((e, i) => {
          const isCurrent = !!currentRel && e.path === currentRel;
          return (
            <div
              key={e.path}
              id={`${idBase}-${i}`}
              role="option"
              aria-selected={i === index}
              className={`fb-row fb-${e.type}${i === index ? ' is-selected' : ''}${mode === 'folder' && e.type !== 'dir' ? ' is-reference' : ''}`}
              onClick={() => onSelect(e)}
              onDoubleClick={() => enter(e)}
              title={e.path}
              data-testid="fb-row"
              data-path={e.path}
            >
              <span className="fb-name">
                <Icon name={e.type === 'dir' ? 'folder' : 'file'} className={`icon fb-icon fb-icon-${e.type}`} />
                <span className="fb-label">{e.name}</span>
                {isCurrent && <span className="tag tag-accent">open</span>}
              </span>
              <span className="fb-when">{e.type === 'dir' ? '' : formatWhen(e.mtimeMs)}</span>
              <span className="fb-size">{e.type === 'dir' ? '' : formatSize(e.size)}</span>
            </div>
          );
        })}
        {!loading && entries.length === 0 && emptyText && <div className="fb-empty">{emptyText}</div>}
        {error && (
          <div className="fb-empty fb-error" role="alert">
            <Icon name="error" />
            <span>{error}</span>
            {dir && (
              <button className="button button-small" onClick={() => onDir('')}>
                Go to the workspace root
              </button>
            )}
          </div>
        )}
        {loading && !shown && <div className="fb-empty">Loading…</div>}
      </div>
    </div>
  );
}
