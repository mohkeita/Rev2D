/**
 * Workspace file browser: breadcrumbs from the root, a filter field, and an inset list of folders
 * and model files with their modification time and size. Keyboard: arrows / Home / End / PageUp /
 * PageDown move the highlight (also while typing in the filter), Enter opens a folder or activates
 * a model, Backspace (empty filter) or Alt+Up goes to the parent folder. Double-click activates.
 *
 * mode 'open': picking a model is the goal. mode 'folder': picking a folder is the goal (Save As,
 * New, Import); model files are listed for reference and selecting one suggests its name.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import * as api from '../api.js';
import type { FileEntry } from '../api.js';
import { Badge, Button, Icon, IconButton, SearchField, Spinner } from '../design/index.js';
import { cx } from '../design/util.js';
import { useT } from '../i18n/index.js';
import { breadcrumbs, formatSize, formatWhen, isOpenable, moveHighlight, parentDir, visibleEntries } from './paths.js';
import './file-browser.css';

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
  /** Focus the filter field when mounted (the dialog's first field). */
  autoFocus?: boolean;
  /** Root-relative path of the open model (marked "open" in the list). */
  currentRel?: string | null;
  /** 'compact': a short list inside a form (no modification time); 'fill': takes the height of its container. */
  variant?: 'compact' | 'fill';
  className?: string;
  /** Lets the parent know which names exist in the listed folder (overwrite checks, unique names). */
  onEntries?(entries: FileEntry[]): void;
}

type Listing = { dir: string; entries: FileEntry[] } | null;

export function FileBrowser({ mode, dir, onDir, selected, onSelect, onActivate, rootName, autoFocus, currentRel, variant, className, onEntries }: FileBrowserProps) {
  const t = useT();
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
    // Home / End keep moving the caret while the filter field has text.
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
  const emptyText = error ? null : filter ? t('files.browser.empty.filter', { query: filter }) : mode === 'open' ? t('files.browser.empty.open') : t('files.browser.empty.folder');

  return (
    <div className={cx('ed-fb', className)} data-variant={variant} data-testid="file-browser">
      <div className="ed-fb-bar">
        <IconButton icon="arrowUp" size="sm" label={t('files.browser.parent')} shortcut="Backspace" disabled={!dir} onClick={goUp} data-testid="fb-up" />
        <nav className="ed-fb-crumbs" aria-label={t('files.browser.folder')}>
          {crumbs.map((c, i) => (
            <span key={c.path} className="ed-fb-crumb-wrap">
              {i > 0 && <Icon name="chevronRight" size={10} strokeWidth={2.6} className="ed-fb-crumb-sep" />}
              <button
                type="button"
                className="ed-fb-crumb"
                onClick={() => {
                  onSelect(null);
                  onDir(c.path);
                }}
                title={i === 0 ? t('files.browser.root') : c.path}
                aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                data-testid={`fb-crumb-${i}`}
              >
                {i === 0 && <Icon name="home" size={14} />}
                <span>{c.label}</span>
              </button>
            </span>
          ))}
        </nav>
        <SearchField
          size="sm"
          className="ed-fb-filter"
          value={filter}
          onChange={setFilter}
          placeholder={t('files.browser.filter')}
          aria-label={t('files.browser.filterLabel')}
          onKeyDown={onKeyDown}
          data-autofocus={autoFocus ? '' : undefined}
          data-testid="fb-filter"
        />
      </div>
      <div
        ref={listRef}
        className="ed-fb-list r2-scroll"
        role="listbox"
        tabIndex={0}
        aria-label={mode === 'open' ? t('files.browser.listOpen') : t('files.browser.listFolder')}
        aria-activedescendant={index >= 0 ? `${idBase}-${index}` : undefined}
        onKeyDown={onKeyDown}
        data-testid="fb-list"
      >
        <div className="ed-fb-head" aria-hidden="true">
          <span>{t('files.browser.name')}</span>
          <span className="ed-fb-when">{t('files.browser.modified')}</span>
          <span className="ed-fb-size">{t('files.browser.size')}</span>
        </div>
        {entries.map((e, i) => {
          const isCurrent = !!currentRel && e.path === currentRel;
          return (
            <div
              key={e.path}
              id={`${idBase}-${i}`}
              role="option"
              aria-selected={i === index}
              className="ed-fb-row"
              data-type={e.type}
              data-reference={mode === 'folder' && e.type !== 'dir' ? '' : undefined}
              onClick={() => onSelect(e)}
              onDoubleClick={() => enter(e)}
              title={e.path}
              data-testid="fb-row"
              data-path={e.path}
            >
              <span className="ed-fb-name">
                <Icon name={e.avatar ? 'avatar' : e.type === 'dir' ? 'folder' : 'file'} size={16} className="ed-fb-icon" />
                <span className="ed-fb-label">{e.name}</span>
                {isCurrent && <Badge tone="tint">{t('files.badge.open')}</Badge>}
              </span>
              <span className="ed-fb-when">{e.type === 'dir' ? '' : formatWhen(e.mtimeMs)}</span>
              <span className="ed-fb-size r2-num">{e.type === 'dir' ? '' : formatSize(e.size)}</span>
            </div>
          );
        })}
        {!loading && entries.length === 0 && emptyText && <div className="ed-fb-empty">{emptyText}</div>}
        {error && (
          <div className="ed-fb-empty ed-fb-error" role="alert">
            <Icon name="error" size={18} className="ed-fb-error-icon" />
            <span>{error}</span>
            {dir && (
              <Button size="sm" onClick={() => onDir('')}>
                {t('files.browser.goRoot')}
              </Button>
            )}
          </div>
        )}
        {loading && !shown && (
          <div className="ed-fb-empty">
            <Spinner size={14} />
            <span>{t('common.loading')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
