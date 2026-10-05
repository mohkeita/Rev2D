/**
 * Toolbar "File" menu (WAI-ARIA menu button): New, Open, Open Recent ▸, Save, Save As, Import,
 * Import Live2D motions, Download, Export PNG, Export to ▸ (Spine, Live2D motions), Reload, Close.
 * Keyboard: Enter / Space / ↓ open it, ↑ ↓ Home End move, → opens a submenu (← closes it), a letter
 * jumps to the next item starting with it, Enter / Space activate, Esc closes (focus returns to the
 * button), Tab closes and moves on.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useApp, useSession } from '../state/context.js';
import { shallowEqual } from '../state/store.js';
import { Icon, type IconName } from '../ui/icons.js';
import { baseName, dirOf, relativeToRoot, rootLabel } from './paths.js';
import { FILE_SHORTCUTS, fileShortcut, type FileShortcut } from './shortcuts.js';

/** Menu item of each file shortcut (pressed while the menu is open, the shortcut still runs it). */
const SHORTCUT_ITEM: Record<FileShortcut, string> = { new: 'new', open: 'open', save: 'save', saveAs: 'save-as' };

/** The submenus: Open Recent and Export to. */
type SubMenu = 'recent' | 'export-to';

interface Item {
  id: string;
  label: string;
  icon: IconName;
  shortcut?: string;
  disabled?: boolean;
  title?: string;
  run?: () => void;
  submenu?: SubMenu;
}

type Entry = Item | 'sep';

function focusables(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]:not([aria-disabled="true"])')] : [];
}

function moveFocus(root: HTMLElement | null, key: string): boolean {
  const items = focusables(root);
  if (!items.length) return false;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next: number | null = null;
  if (key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
  else if (key === 'ArrowUp') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = items.length - 1;
  else if (key.length === 1 && /\S/.test(key)) {
    const k = key.toLowerCase();
    for (let step = 1; step <= items.length; step++) {
      const cand = items[(Math.max(i, 0) + step) % items.length];
      if ((cand.dataset.label ?? '').toLowerCase().startsWith(k)) {
        next = items.indexOf(cand);
        break;
      }
    }
  }
  if (next === null) return false;
  items[next].focus();
  return true;
}

export function FileMenu() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<SubMenu | null>(null);
  /** Offset of the open submenu so it lines up with its row (null: the stylesheet's default). */
  const [subTop, setSubTop] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<'first' | 'last' | 'menu' | null>(null);
  const st = useApp(
    (s) => ({
      status: s.status,
      hasModel: s.model !== null,
      unsaved: s.unsaved,
      file: s.file,
      workspace: s.workspace !== null,
      root: s.workspace?.root ?? null,
    }),
    shallowEqual,
  );
  const recent = useApp((s) => s.workspace?.recent ?? []);
  const ready = st.status === 'ready';
  const ws = st.workspace;
  const noWs = ws ? undefined : 'This editor server has no workspace API (update rev2d)';

  const close = (refocus: boolean): void => {
    setOpen(false);
    setSub(null);
    if (refocus) buttonRef.current?.focus();
  };

  // Close on a press outside the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // Focus the first / last item (keyboard) or the menu itself (mouse: arrows then pick an item).
  useEffect(() => {
    if (!open) return;
    const items = focusables(menuRef.current);
    const which = focusOnOpen.current ?? 'first';
    if (which === 'menu') menuRef.current?.focus();
    else (which === 'last' ? items[items.length - 1] : items[0])?.focus();
    focusOnOpen.current = null;
    void session.refreshWorkspace();
  }, [open, session]);

  const act = (run?: () => void) => () => {
    close(true);
    run?.();
  };

  const entries: Entry[] = [
    { id: 'new', label: 'New…', icon: 'fileNew', shortcut: FILE_SHORTCUTS.new, disabled: !ws, title: noWs, run: () => session.openDialog({ kind: 'new' }) },
    { id: 'open', label: 'Open…', icon: 'folderOpen', shortcut: FILE_SHORTCUTS.open, disabled: !ws, title: noWs, run: () => session.openDialog({ kind: 'open' }) },
    { id: 'recent', label: 'Open Recent', icon: 'clock', disabled: !ws, title: noWs, submenu: 'recent' },
    'sep',
    { id: 'save', label: 'Save', icon: 'save', shortcut: FILE_SHORTCUTS.save, disabled: !ready, run: () => void session.save() },
    { id: 'save-as', label: 'Save As…', icon: 'saveAs', shortcut: FILE_SHORTCUTS.saveAs, disabled: !ready || !ws, title: noWs, run: () => session.openDialog({ kind: 'saveAs' }) },
    'sep',
    {
      id: 'import',
      label: 'Import from computer…',
      icon: 'upload',
      disabled: !ws,
      title: noWs ?? 'Copy a model (.json) and its PNG textures from your computer into the workspace and open it',
      // Runs inside the click / key handler: browsers only open file pickers on a user gesture.
      run: () => session.pickImportFiles(),
    },
    {
      id: 'import-live2d',
      label: 'Import Live2D motions…',
      icon: 'film',
      disabled: !ready || !ws,
      title: noWs ?? 'Import Live2D .motion3 / .exp3 / .physics3 / .cdi3 .json files (or a .model3.json with them) into the open model',
      run: () => session.pickLive2dFiles(),
    },
    { id: 'download', label: 'Download copy', icon: 'download', disabled: !ready || !ws, title: noWs ?? 'Save a copy of the model file to your downloads (the version shown, while it is not saved to disk)', run: () => session.downloadCopy() },
    { id: 'export', label: 'Export PNG of the view', icon: 'camera', disabled: !st.hasModel, title: 'Render what the viewport shows (pose, overlays, visible region) to a PNG', run: () => void session.exportPng() },
    { id: 'export-to', label: 'Export to', icon: 'layers', disabled: !ready || !ws, title: noWs ?? 'Export the model to Spine or Live2D files in a workspace folder', submenu: 'export-to' },
    'sep',
    { id: 'reload', label: 'Reload from disk', icon: 'refresh', disabled: !ready, run: () => void session.reloadFromDisk() },
    { id: 'close', label: 'Close', icon: 'fileClose', disabled: !(ready || st.status === 'failed') || !ws, title: noWs, run: () => void session.closeModel() },
  ];

  const openMenu = (focus: 'first' | 'last' | 'menu'): void => {
    focusOnOpen.current = focus;
    setOpen(true);
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.key === 'ArrowUp' ? 'last' : 'first');
    }
  };

  const openSub = (which: SubMenu, focusFirst: boolean): void => {
    const row = menuRef.current?.querySelector<HTMLElement>(`[data-id="${which}"]`);
    setSubTop(row ? row.offsetTop - 4 : null);
    setSub(which);
    if (focusFirst) requestAnimationFrame(() => focusables(subRef.current)[0]?.focus());
  };

  /** Back from a submenu to its row. */
  const leaveSub = (): void => {
    const row = sub;
    setSub(null);
    if (row) menuRef.current?.querySelector<HTMLElement>(`[data-id="${row}"]`)?.focus();
  };

  const exportItems: Item[] = [
    { id: 'export-spine', label: 'Spine…', icon: 'bone', title: 'Skeleton JSON + atlas + PNG pages for the Spine editor and runtimes', run: () => session.openDialog({ kind: 'export', format: 'spine' }) },
    {
      id: 'export-live2d',
      label: 'Live2D motions…',
      icon: 'film',
      title: 'motion3 / physics3 / cdi3 JSON for a Live2D model with matching parameter ids (the .moc3 model is not written)',
      run: () => session.openDialog({ kind: 'export', format: 'live2d' }),
    },
  ];

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // The editor's global shortcuts never see keys pressed in the menu...
    e.stopPropagation();
    // ...so the file shortcuts the menu lists are run here (Ctrl+S is not the letter "s").
    const shortcut = fileShortcut(e);
    if (shortcut) {
      e.preventDefault();
      const item = entries.find((x): x is Item => x !== 'sep' && x.id === SHORTCUT_ITEM[shortcut]);
      if (item && !item.disabled) act(item.run)();
      else close(true);
      return;
    }
    const inSub = !!subRef.current?.contains(document.activeElement);
    const focusedSub = (): SubMenu | null => {
      const id = (document.activeElement as HTMLElement | null)?.dataset.id;
      const item = entries.find((x): x is Item => x !== 'sep' && x.id === id);
      return item?.submenu && !item.disabled ? item.submenu : null;
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      if (inSub) leaveSub();
      else close(true);
      return;
    }
    if (e.key === 'Tab') {
      close(false);
      return;
    }
    if (e.key === 'ArrowLeft' && inSub) {
      e.preventDefault();
      leaveSub();
      return;
    }
    if (e.key === 'ArrowRight' && !inSub && focusedSub()) {
      e.preventDefault();
      openSub(focusedSub()!, true);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const el = document.activeElement as HTMLElement | null;
      if (!inSub && focusedSub()) {
        e.preventDefault();
        openSub(focusedSub()!, true);
        return;
      }
      if (el?.getAttribute('role') === 'menuitem') {
        e.preventDefault();
        el.click();
      }
      return;
    }
    if (moveFocus(inSub ? subRef.current : menuRef.current, e.key)) {
      e.preventDefault();
      if (!inSub) setSub(null);
    }
  };

  const recentItems = recent.map((abs) => {
    const rel = st.root ? relativeToRoot(abs, st.root) : null;
    return { abs, rel };
  });

  return (
    <div className="menu-root" ref={rootRef}>
      <button
        ref={buttonRef}
        className={`menu-button${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="file-menu"
        // A mouse click opens without highlighting an item; Enter / Space (a click with detail 0) highlights the first.
        onClick={(e) => (open ? close(false) : openMenu(e.detail === 0 ? 'first' : 'menu'))}
        onKeyDown={onButtonKey}
        title="File (New, Open, Save As, Import, …)"
        data-testid="file-menu-button"
      >
        <Icon name="menu" size={14} />
        <span>File</span>
        <Icon name="chevronDown" size={12} className="icon menu-caret" />
      </button>
      {open && (
        <div className="menu-pop" onKeyDown={onMenuKey}>
          <div className="menu" role="menu" id="file-menu" aria-label="File" ref={menuRef} tabIndex={-1} data-testid="file-menu">
            {entries.map((en, i) =>
              en === 'sep' ? (
                <div key={`sep-${i}`} className="menu-sep" role="separator" />
              ) : (
                <MenuItem
                  key={en.id}
                  item={en}
                  expanded={en.submenu ? sub === en.submenu : undefined}
                  onRun={en.submenu ? () => openSub(en.submenu!, true) : act(en.run)}
                  onHover={() => {
                    if (en.submenu) {
                      if (!en.disabled) openSub(en.submenu, false);
                    } else setSub(null);
                  }}
                />
              ),
            )}
            <div className="menu-foot" title={st.root ?? undefined}>
              <Icon name="home" size={12} />
              <span className="ellipsis">{st.root ? `Workspace: ${st.root}` : 'No workspace'}</span>
            </div>
          </div>
          {sub === 'export-to' && (
            <div className="menu menu-sub menu-sub-short" role="menu" aria-label="Export to" ref={subRef} style={subTop !== null ? { marginTop: subTop } : undefined} data-testid="export-menu">
              {exportItems.map((it) => (
                <MenuItem key={it.id} item={it} onRun={act(it.run)} onHover={() => undefined} />
              ))}
            </div>
          )}
          {sub === 'recent' && (
            <div className="menu menu-sub" role="menu" aria-label="Open Recent" ref={subRef} style={subTop !== null ? { marginTop: subTop } : undefined} data-testid="recent-menu">
              {recentItems.length === 0 && (
                <div className="menu-empty" role="menuitem" aria-disabled="true">
                  No recent files yet
                </div>
              )}
              {recentItems.map((r) => (
                <MenuItem
                  key={r.abs}
                  item={{
                    id: `recent:${r.abs}`,
                    label: baseName(r.abs),
                    icon: 'file',
                    disabled: r.rel === null,
                    title: r.rel === null ? `${r.abs}\nOutside this workspace (${st.root}); start \`rev2d edit\` there to open it.` : r.abs,
                  }}
                  detail={r.rel !== null ? dirOf(r.rel) || rootLabel(st.root) : 'outside workspace'}
                  current={r.rel !== null && !!st.file && relativeToRoot(st.file, st.root ?? '') === r.rel}
                  onRun={act(() => void session.openRecent(r.abs))}
                  onHover={() => undefined}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  item,
  onRun,
  onHover,
  expanded,
  detail,
  current,
}: {
  item: Item;
  onRun(): void;
  onHover(): void;
  expanded?: boolean;
  detail?: ReactNode;
  current?: boolean;
}) {
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-disabled={item.disabled || undefined}
      aria-haspopup={item.submenu ? 'menu' : undefined}
      aria-expanded={item.submenu ? expanded : undefined}
      className={`menu-item${item.disabled ? ' is-disabled' : ''}${expanded ? ' is-expanded' : ''}${current ? ' is-current' : ''}`}
      title={item.title}
      data-id={item.id}
      data-label={item.label}
      data-testid={`menu-${item.id.startsWith('recent:') ? 'recent-item' : item.id}`}
      onClick={() => !item.disabled && onRun()}
      onMouseEnter={(e) => {
        if (!item.disabled) (e.currentTarget as HTMLElement).focus();
        onHover();
      }}
    >
      <Icon name={item.icon} size={15} />
      <span className="menu-label">
        {item.label}
        {detail && <span className="menu-detail">{detail}</span>}
      </span>
      {current && <span className="tag tag-accent">open</span>}
      {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
      {item.submenu && <Icon name="chevronRight" size={13} className="icon menu-sub-caret" />}
    </div>
  );
}
