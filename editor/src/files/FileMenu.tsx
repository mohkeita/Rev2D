/**
 * The document button of the toolbar and its "File" menu (WAI-ARIA menu button): New, Open, Open
 * Recent ▸, Save, Save As, Import, Import Live2D Motions, Download, Export PNG, Export To ▸ (Spine,
 * Live2D Motions), Reload, Close.
 *
 * The button shows the name of the document on screen with its save state (a dot while an edit is
 * not on disk, a spinner while saving): the active mode's own document (the avatar in Avatar mode,
 * whose Save writes avatar.json), else the open model; with nothing open it reads "File". It is
 * rendered as a direct child of the toolbar group it sits in.
 *
 * Keyboard: Enter / Space / ↓ open it, ↑ ↓ Home End move, → opens a submenu (← closes it), a letter
 * jumps to the next item starting with it, Enter / Space activate, Esc closes (focus returns to the
 * button), Tab closes and moves on. The menu is a design-system menu surface (glass, same rows as
 * every other menu); its two submenus open beside their row.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { openNewAvatarSheet } from '../avatar/actions.js';
import { Badge, Button, Floating, Icon, Layer, Spinner, type IconName } from '../design/index.js';
import { cx, useOutsidePress } from '../design/util.js';
import { useT } from '../i18n/index.js';
import { resolveMode, useDocumentState, useModes } from '../shell/registry.js';
import { documentKind } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import { shallowEqual } from '../state/store.js';
import { baseName, dirOf, relativeToRoot, rootLabel } from './paths.js';
import { FILE_SHORTCUTS, fileShortcut, type FileShortcut } from './shortcuts.js';
import './file-menu.css';

/** Menu item of each file shortcut (pressed while the menu is open, the shortcut still runs it). */
const SHORTCUT_ITEM: Record<FileShortcut, string> = { new: 'new', open: 'open', save: 'save', saveAs: 'save-as' };

/** The submenus: Open Recent and Export To. */
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

/** "hana.r2d.json" -> "hana": the document name shown in the toolbar. */
function documentName(file: string): string {
  const base = baseName(file);
  return base.replace(/(\.r2d)?\.jsonc?$/i, '') || base;
}

export function FileMenu() {
  const t = useT();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<SubMenu | null>(null);
  /** The row a submenu opens beside. */
  const [subAnchor, setSubAnchor] = useState<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** Wraps the menu and its submenu inside the layer: one key handler, one "inside" for outside presses. */
  const popRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<'first' | 'last' | 'menu' | null>(null);
  const st = useApp(
    (s) => ({
      status: s.status,
      hasModel: s.model !== null,
      unsaved: s.unsaved,
      saving: s.saving,
      file: s.file,
      workspace: s.workspace !== null,
      root: s.workspace?.root ?? null,
      avatarProject: documentKind(s) === 'avatar-project',
    }),
    shallowEqual,
  );
  // The document on screen: the active mode's own one (avatar.json), else the model.
  const modes = useModes();
  const modeDoc = useApp((s) => resolveMode(modes, s)?.document);
  const doc = useDocumentState(modeDoc);
  const recent = useApp((s) => s.workspace?.recent ?? []);
  const ready = st.status === 'ready';
  const ws = st.workspace;
  const noWs = ws ? undefined : t('files.menu.noWorkspaceApi');

  const close = (refocus: boolean): void => {
    setOpen(false);
    setSub(null);
    setSubAnchor(null);
    if (refocus) buttonRef.current?.focus();
  };

  // A press outside the menu (and its button, which toggles it) closes it.
  useOutsidePress(open, [popRef, buttonRef], () => close(false));

  // Focus the first / last item (keyboard) or the menu itself (mouse: arrows then pick an item).
  useEffect(() => {
    if (!open) return;
    const items = focusables(menuRef.current);
    const which = focusOnOpen.current ?? 'first';
    if (which === 'menu') menuRef.current?.focus({ preventScroll: true });
    else (which === 'last' ? items[items.length - 1] : items[0])?.focus({ preventScroll: true });
    focusOnOpen.current = null;
    void session.refreshWorkspace();
  }, [open, session]);

  const act = (run?: () => void) => () => {
    close(true);
    run?.();
  };

  const entries: Entry[] = [
    { id: 'new', label: t('files.menu.new'), icon: 'fileNew', shortcut: FILE_SHORTCUTS.new, disabled: !ws, title: noWs, run: () => session.openDialog({ kind: 'new' }) },
    { id: 'open', label: t('files.menu.open'), icon: 'folderOpen', shortcut: FILE_SHORTCUTS.open, disabled: !ws, title: noWs, run: () => session.openDialog({ kind: 'open' }) },
    { id: 'recent', label: t('files.menu.recent'), icon: 'clock', disabled: !ws, title: noWs, submenu: 'recent' },
    { id: 'new-avatar', label: t('avatar.file.new'), icon: 'avatar', disabled: !ws, title: noWs ?? t('avatar.file.new.hint'), run: () => openNewAvatarSheet() },
    'sep',
    { id: 'save', label: t('common.save'), icon: 'save', shortcut: FILE_SHORTCUTS.save, disabled: modeDoc ? !doc : !ready, title: doc?.path, run: () => void session.saveDocument() },
    { id: 'save-as', label: t('files.menu.saveAs'), icon: 'saveAs', shortcut: FILE_SHORTCUTS.saveAs, disabled: !ready || !ws, title: noWs, run: () => session.openDialog({ kind: 'saveAs' }) },
    'sep',
    {
      id: 'import',
      label: t('files.menu.import'),
      icon: 'upload',
      disabled: !ws,
      title: noWs ?? t('files.menu.import.hint'),
      // Runs inside the click / key handler: browsers only open file pickers on a user gesture.
      run: () => session.pickImportFiles(),
    },
    {
      id: 'import-live2d',
      label: t('files.menu.importLive2d'),
      icon: 'film',
      disabled: !ready || !ws,
      title: noWs ?? t('files.menu.importLive2d.hint'),
      run: () => session.pickLive2dFiles(),
    },
    { id: 'download', label: t('files.menu.download'), icon: 'download', disabled: !ready || !ws, title: noWs ?? t('files.menu.download.hint'), run: () => session.downloadCopy() },
    { id: 'export', label: t('files.menu.exportPng'), icon: 'camera', disabled: !st.hasModel, title: t('files.menu.exportPng.hint'), run: () => void session.exportPng() },
    { id: 'export-to', label: t('files.menu.exportTo'), icon: 'export', disabled: !ready || !ws, title: noWs ?? t('files.menu.exportTo.hint'), submenu: 'export-to' },
    'sep',
    { id: 'reload', label: t('files.menu.reload'), icon: 'refresh', disabled: !ready, run: () => void session.reloadFromDisk() },
    { id: 'close', label: t('common.close'), icon: 'fileClose', disabled: !(ready || st.status === 'failed' || st.avatarProject) || !ws, title: noWs, run: () => void session.closeModel() },
  ];

  const openMenu = (focus: 'first' | 'last' | 'menu'): void => {
    focusOnOpen.current = focus;
    setOpen(true);
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (!open) openMenu(e.key === 'ArrowUp' ? 'last' : 'first');
    }
  };

  const openSub = (which: SubMenu, focusFirst: boolean): void => {
    setSubAnchor(menuRef.current?.querySelector<HTMLElement>(`[data-id="${which}"]`) ?? null);
    setSub(which);
    // After the submenu was placed (it is not focusable before).
    if (focusFirst) requestAnimationFrame(() => focusables(subRef.current)[0]?.focus({ preventScroll: true }));
  };

  /** Back from a submenu to its row. */
  const leaveSub = (): void => {
    const row = sub;
    setSub(null);
    setSubAnchor(null);
    if (row) menuRef.current?.querySelector<HTMLElement>(`[data-id="${row}"]`)?.focus({ preventScroll: true });
  };

  const exportItems: Item[] = [
    { id: 'export-spine', label: t('files.menu.exportSpine'), icon: 'bone', title: t('files.menu.exportSpine.hint'), run: () => session.openDialog({ kind: 'export', format: 'spine' }) },
    {
      id: 'export-live2d',
      label: t('files.menu.exportLive2d'),
      icon: 'film',
      title: t('files.menu.exportLive2d.hint'),
      run: () => session.openDialog({ kind: 'export', format: 'live2d' }),
    },
  ];

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // The editor's global shortcuts (and the toolbar's arrow keys) never see keys pressed in the menu...
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
      if (!inSub) {
        setSub(null);
        setSubAnchor(null);
      }
    }
  };

  const recentItems = recent.map((abs) => {
    const rel = st.root ? relativeToRoot(abs, st.root) : null;
    return { abs, rel };
  });

  // ---- the document button
  const modelOpen = st.file !== '' && st.status !== 'empty';
  const hasFile = doc !== null || modelOpen;
  const name = doc ? doc.name : modelOpen ? documentName(st.file) : '';
  const rel = doc ? doc.path : modelOpen ? session.displayPath(st.file) : '';
  const buttonTitle = doc ? doc.path : modelOpen ? (rel !== st.file ? `${rel}\n${st.file}` : st.file) : t('files.menu.buttonHint');
  const saving = doc ? doc.saving : st.saving;
  const unsaved = doc ? doc.dirty : st.unsaved;

  return (
    <>
      <Button
        ref={buttonRef}
        variant="plain"
        size="lg"
        icon={hasFile ? undefined : 'menu'}
        trailingIcon="chevronDown"
        className={cx('ed-doc-title', !hasFile && 'ed-doc-title-empty')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'file-menu' : undefined}
        aria-label={hasFile ? t('files.menu.buttonLabel', { name: doc ? doc.name : baseName(st.file) }) : t('files.menu.title')}
        data-open={open ? '' : undefined}
        // A mouse click opens without highlighting an item; Enter / Space (a click with detail 0) highlights the first.
        onClick={(e) => (open ? close(false) : openMenu(e.detail === 0 ? 'first' : 'menu'))}
        onKeyDown={onButtonKey}
        title={buttonTitle}
        data-testid="file-menu-button"
      >
        {hasFile ? (
          <>
            <span className="ed-doc-name">{name}</span>
            {saving ? (
              <Spinner size={12} aria-label={t('common.saving')} className="ed-doc-saving" />
            ) : unsaved ? (
              <span className="ed-doc-dot" role="img" aria-label={t('files.menu.unsaved', { shortcut: FILE_SHORTCUTS.save })} title={t('files.menu.unsaved', { shortcut: FILE_SHORTCUTS.save })} data-testid="unsaved-dot" />
            ) : null}
          </>
        ) : (
          t('files.menu.title')
        )}
      </Button>
      {open && (
        <Layer>
          <div ref={popRef} className="ed-filemenu-pop" onKeyDown={onMenuKey} onKeyUp={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <Floating
              ref={menuRef}
              anchor={buttonRef.current}
              placement="bottom-start"
              offset={8}
              className="r2-menu r2-glass-panel r2-scroll ed-filemenu"
              role="menu"
              id="file-menu"
              aria-label={t('files.menu.title')}
              aria-orientation="vertical"
              tabIndex={-1}
              data-testid="file-menu"
            >
              {entries.map((en, i) =>
                en === 'sep' ? (
                  <div key={`sep-${i}`} className="r2-menu-separator" role="separator" />
                ) : (
                  <MenuRow
                    key={en.id}
                    item={en}
                    expanded={en.submenu ? sub === en.submenu : undefined}
                    onRun={en.submenu ? () => openSub(en.submenu!, true) : act(en.run)}
                    onHover={() => {
                      if (en.submenu) {
                        if (!en.disabled) openSub(en.submenu, false);
                      } else {
                        setSub(null);
                        setSubAnchor(null);
                      }
                    }}
                  />
                ),
              )}
              <div className="ed-filemenu-foot" title={st.root ?? undefined}>
                <Icon name="home" size={12} />
                <span className="ed-ellipsis">{st.root ? t('files.menu.workspace', { root: st.root }) : t('files.menu.noWorkspace')}</span>
              </div>
            </Floating>
            {sub === 'export-to' && subAnchor && (
              <Floating ref={subRef} anchor={subAnchor} placement="right-start" offset={4} className="r2-menu r2-glass-panel r2-scroll ed-filemenu ed-filemenu-sub" role="menu" aria-label={t('files.menu.exportTo')} aria-orientation="vertical" tabIndex={-1} data-testid="export-menu">
                {exportItems.map((it) => (
                  <MenuRow key={it.id} item={it} onRun={act(it.run)} onHover={() => undefined} />
                ))}
              </Floating>
            )}
            {sub === 'recent' && subAnchor && (
              <Floating ref={subRef} anchor={subAnchor} placement="right-start" offset={4} className="r2-menu r2-glass-panel r2-scroll ed-filemenu ed-filemenu-sub ed-filemenu-recent" role="menu" aria-label={t('files.menu.recent')} aria-orientation="vertical" tabIndex={-1} data-testid="recent-menu">
                {recentItems.length === 0 && (
                  <div className="r2-menu-item ed-filemenu-empty" role="menuitem" aria-disabled="true">
                    {t('files.menu.noRecent')}
                  </div>
                )}
                {recentItems.map((r) => (
                  <MenuRow
                    key={r.abs}
                    item={{
                      id: `recent:${r.abs}`,
                      label: baseName(r.abs),
                      icon: 'file',
                      disabled: r.rel === null,
                      title: r.rel === null ? t('files.menu.outside.hint', { path: r.abs, root: st.root ?? '' }) : r.abs,
                    }}
                    detail={r.rel !== null ? dirOf(r.rel) || rootLabel(st.root) : t('files.menu.outside')}
                    current={r.rel !== null && !!st.file && relativeToRoot(st.file, st.root ?? '') === r.rel}
                    currentLabel={t('files.badge.open')}
                    onRun={act(() => void session.openRecent(r.abs))}
                    onHover={() => undefined}
                  />
                ))}
              </Floating>
            )}
          </div>
        </Layer>
      )}
    </>
  );
}

function MenuRow({
  item,
  onRun,
  onHover,
  expanded,
  detail,
  current,
  currentLabel,
}: {
  item: Item;
  onRun(): void;
  onHover(): void;
  expanded?: boolean;
  detail?: ReactNode;
  current?: boolean;
  currentLabel?: string;
}) {
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-disabled={item.disabled || undefined}
      aria-haspopup={item.submenu ? 'menu' : undefined}
      aria-expanded={item.submenu ? expanded : undefined}
      className="r2-menu-item ed-filemenu-item"
      // The row whose submenu is open keeps the highlight while the focus is in the submenu.
      data-active={expanded ? '' : undefined}
      title={item.title}
      data-id={item.id}
      data-label={item.label}
      data-testid={`menu-${item.id.startsWith('recent:') ? 'recent-item' : item.id}`}
      onClick={() => !item.disabled && onRun()}
      onMouseEnter={(e) => {
        if (!item.disabled) (e.currentTarget as HTMLElement).focus({ preventScroll: true });
        onHover();
      }}
    >
      <Icon name={item.icon} size={16} className="r2-menu-icon" />
      <span className="r2-menu-text">
        <span className="r2-menu-title">{item.label}</span>
        {detail != null && <span className="r2-menu-description ed-ellipsis">{detail}</span>}
      </span>
      {current && <Badge tone="tint">{currentLabel}</Badge>}
      {item.shortcut && <kbd className="r2-menu-shortcut">{item.shortcut}</kbd>}
      {item.submenu && <Icon name="chevronRight" size={12} strokeWidth={2.4} className="ed-filemenu-chevron" />}
    </div>
  );
}
