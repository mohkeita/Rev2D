/**
 * The toolbar: glass capsule groups floating over the canvas (no bar background).
 *
 *   (sidebar | document ▾)  (modes)      (overlays | backdrop)      (undo redo) (display) (AI … inspector) [Save]
 *
 * - document: the leading-sidebar toggle and the File menu (its button shows the open model);
 * - modes: a segmented control, shown once two workspace modes are available (registry.ts);
 * - overlays: one toggle per viewport overlay and the backdrop menu (Rig canvas);
 * - history: undo / redo;
 * - display: appearance and materials, language, keyboard shortcuts;
 * - panels: the AI button (reserved: dimmed until a panel with id AI_PANEL_ID registers), one button
 *   per registered trailing panel and toolbar action, the inspector toggle;
 * - the one filled button: Save.
 *
 * History and Save act on the document on screen: the mode's own document when it has one
 * (WorkspaceMode.document, e.g. avatar.json in Avatar mode), else the model.
 *
 * On a narrow window (`compact`) the overlay toggles fold into one menu and the display settings
 * into the "More" menu, so the bar still fits at 1024 px.
 */
import { Button, IconButton, Menu, SegmentedControl, Toolbar, ToolbarGroup, ToolbarSeparator, ToolbarSpacer, type IconName, type MenuEntry } from '../design/index.js';
import { FileMenu } from '../files/FileMenu.js';
import { FILE_SHORTCUTS } from '../files/shortcuts.js';
import { LANGUAGES, setLanguage, useLanguage, useT, type MessageKey, type Translate } from '../i18n/index.js';
import { BACKGROUND_MODES, MODE_PANEL, OVERLAY_LAYERS, panelOpen, type BackgroundMode, type OverlayLayer } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import type { Session } from '../state/session.js';
import { shallowEqual } from '../state/store.js';
import { AI_PANEL_ID, labelText, useDocumentState, useModes, usePanels, useToolbarActions, availableModes, type WorkspaceMode } from './registry.js';
import { MATERIALS, useSettings, type Settings } from './settings.js';

export const OVERLAY_META: Record<OverlayLayer, { icon: IconName; label: MessageKey; key: string }> = {
  bones: { icon: 'bone', label: 'overlay.bones', key: 'B' },
  mesh: { icon: 'mesh', label: 'overlay.mesh', key: 'M' },
  warps: { icon: 'warp', label: 'overlay.warps', key: 'W' },
  bounds: { icon: 'bounds', label: 'overlay.bounds', key: 'X' },
  labels: { icon: 'label', label: 'overlay.labels', key: 'L' },
  grid: { icon: 'grid', label: 'overlay.grid', key: 'G' },
};

const BACKGROUND_LABEL: Record<BackgroundMode, MessageKey> = {
  model: 'backdrop.model',
  checker: 'backdrop.checker',
  dark: 'backdrop.dark',
  light: 'backdrop.light',
};

const APPEARANCE_LABEL = { auto: 'appearance.auto', light: 'appearance.light', dark: 'appearance.dark' } as const satisfies Record<string, MessageKey>;
const MATERIALS_LABEL = { auto: 'materials.auto', glass: 'materials.glass', solid: 'materials.solid' } as const satisfies Record<string, MessageKey>;

function backdropItems(t: Translate, session: Session, current: BackgroundMode): MenuEntry[] {
  return [
    { type: 'label', label: t('backdrop.title') },
    ...BACKGROUND_MODES.map((mode): MenuEntry => ({ id: `backdrop-${mode}`, label: t(BACKGROUND_LABEL[mode]), checked: current === mode, onSelect: () => session.setBackground(mode) })),
  ];
}

function appearanceItems(t: Translate, settings: Settings): MenuEntry[] {
  return [
    { type: 'label', label: t('appearance.title') },
    ...(['auto', 'light', 'dark'] as const).map((a): MenuEntry => ({ id: `appearance-${a}`, label: t(APPEARANCE_LABEL[a]), checked: settings.appearance === a, onSelect: () => settings.setAppearance(a) })),
    { type: 'separator' },
    { type: 'label', label: t('materials.title') },
    ...MATERIALS.map((m): MenuEntry => ({ id: `materials-${m}`, label: t(MATERIALS_LABEL[m]), checked: settings.materials === m, onSelect: () => settings.setMaterials(m) })),
  ];
}

function languageItems(t: Translate, current: string): MenuEntry[] {
  return [
    { type: 'label', label: t('language.title') },
    ...LANGUAGES.map((l): MenuEntry => ({ id: `language-${l.id}`, label: l.name, checked: current === l.id, onSelect: () => setLanguage(l.id) })),
  ];
}

export function EditorToolbar({ mode, compact }: { mode: WorkspaceMode | null; compact: boolean }) {
  const session = useSession();
  const t = useT();
  const language = useLanguage();
  const settings = useSettings();
  const modes = useModes();
  const panels = usePanels();
  const actions = useToolbarActions();
  const status = useApp((s) => s.status);
  const ready = status === 'ready';
  // No mode on screen: the start screen.
  const empty = mode === null;
  const modelSaving = useApp((s) => s.saving);
  const modelHistory = useApp((s) => ({ canUndo: s.canUndo, canRedo: s.canRedo, undo: s.undoLabel, redo: s.redoLabel }), shallowEqual);
  // The document on screen: the mode's own (dimmed while it has nothing to save), else the model.
  const modeDoc = mode?.document;
  const docState = useDocumentState(modeDoc);
  const editable = modeDoc ? true : ready;
  const saving = modeDoc ? (docState?.saving ?? false) : modelSaving;
  const history = modeDoc
    ? { canUndo: docState?.canUndo ?? false, canRedo: docState?.canRedo ?? false, undo: docState?.undoLabel ?? null, redo: docState?.redoLabel ?? null }
    : modelHistory;
  const overlays = useApp((s) => s.overlays);
  const background = useApp((s) => s.background);
  const open = useApp((s) => ({ leading: panelOpen(s, 'outliner'), trailing: panelOpen(s, 'inspector') }), shallowEqual);
  const trailingPanel = useApp((s) => s.trailingPanel);
  // Availability depends on the state: joined ids, so the bar re-renders only when the sets change.
  const modeIds = useApp((s) => availableModes(modes, s).map((m) => m.id).join('|'));
  const panelIds = useApp((s) => panels.filter((p) => (p.isAvailable ? p.isAvailable(s) : true)).map((p) => p.id).join('|'));
  const actionState = useApp((s) =>
    actions
      .filter((a) => (a.isAvailable ? a.isAvailable(s) : true))
      .map((a) => `${a.id}:${a.isEnabled && !a.isEnabled(s) ? 0 : 1}${a.isActive?.(s) ? 1 : 0}`)
      .join('|'),
  );
  const shownModes = modes.filter((m) => modeIds.split('|').includes(m.id));
  const shownPanels = panels.filter((p) => panelIds.split('|').includes(p.id));
  const aiPanel = shownPanels.find((p) => p.id === AI_PANEL_ID);
  const hasLeading = !empty && mode?.render.leading !== undefined;
  const hasTrailing = !empty && mode?.render.trailing !== undefined;
  const rigCanvas = ready && mode?.id === 'rig';

  const overlayItems: MenuEntry[] = [
    { type: 'label', label: t('overlay.title') },
    ...OVERLAY_LAYERS.map((layer): MenuEntry => {
      const meta = OVERLAY_META[layer];
      return { id: `overlay-${layer}`, label: t(meta.label), icon: meta.icon, shortcut: meta.key, checked: overlays.includes(layer), onSelect: () => session.toggleOverlay(layer) };
    }),
    { type: 'separator' },
    ...backdropItems(t, session, background),
  ];

  const moreItems: MenuEntry[] = [
    ...appearanceItems(t, settings),
    { type: 'separator' },
    ...languageItems(t, language),
    { type: 'separator' },
    { id: 'shortcuts', label: t('help.title'), icon: 'help', shortcut: '?', onSelect: () => session.store.set({ helpOpen: true }) },
  ];

  return (
    <Toolbar aria-label={t('toolbar.label')} className="ed-toolbar" data-testid="toolbar">
      <ToolbarGroup aria-label={t('toolbar.document')}>
        {hasLeading && (
          <IconButton
            icon="sidebarLeft"
            size="lg"
            label={open.leading ? t('toolbar.hideSidebar') : t('toolbar.showSidebar')}
            aria-expanded={open.leading}
            onClick={() => session.togglePanel('outliner')}
            data-testid="toggle-outliner"
          />
        )}
        <FileMenu />
      </ToolbarGroup>

      {shownModes.length > 1 && !empty && (
        <ToolbarGroup aria-label={t('toolbar.mode')} className="ed-toolbar-modes">
          <SegmentedControl
            aria-label={t('toolbar.mode')}
            size="md"
            value={mode?.id}
            onChange={(id) => session.setMode(id)}
            options={shownModes.map((m) => (compact ? { value: m.id, icon: m.icon, ariaLabel: labelText(m.label) } : { value: m.id, label: labelText(m.label) }))}
            data-testid="mode-switch"
          />
        </ToolbarGroup>
      )}

      <ToolbarSpacer />

      {rigCanvas &&
        (compact ? (
          <ToolbarGroup aria-label={t('overlay.title')}>
            <Menu items={overlayItems} aria-label={t('overlay.title')} placement="bottom-center">
              <IconButton icon="layers" size="lg" label={t('overlay.title')} data-testid="overlay-menu" />
            </Menu>
          </ToolbarGroup>
        ) : (
          <ToolbarGroup aria-label={t('overlay.title')}>
            {OVERLAY_LAYERS.map((layer) => {
              const meta = OVERLAY_META[layer];
              return (
                <IconButton
                  key={layer}
                  icon={meta.icon}
                  size="lg"
                  label={t(meta.label)}
                  shortcut={meta.key}
                  pressed={overlays.includes(layer)}
                  onClick={() => session.toggleOverlay(layer)}
                  data-testid={`overlay-${layer}`}
                />
              );
            })}
            <ToolbarSeparator />
            <Menu items={backdropItems(t, session, background)} aria-label={t('backdrop.title')} placement="bottom-center">
              <IconButton icon="image" size="lg" label={t('backdrop.title')} data-testid="backdrop-menu" />
            </Menu>
          </ToolbarGroup>
        ))}

      <ToolbarSpacer />

      {editable && (
        <ToolbarGroup aria-label={t('toolbar.history')}>
          <IconButton
            icon="undo"
            size="lg"
            label={history.undo ? t('toolbar.undoWhat', { label: history.undo }) : t('toolbar.undo')}
            shortcut="Ctrl+Z"
            disabled={!history.canUndo}
            onClick={() => void session.undoDocument()}
            data-testid="undo"
          />
          <IconButton
            icon="redo"
            size="lg"
            label={history.redo ? t('toolbar.redoWhat', { label: history.redo }) : t('toolbar.redo')}
            shortcut="Ctrl+Shift+Z"
            disabled={!history.canRedo}
            onClick={() => void session.redoDocument()}
            data-testid="redo"
          />
        </ToolbarGroup>
      )}

      {!compact && (
        <ToolbarGroup aria-label={t('toolbar.display')}>
          <Menu items={appearanceItems(t, settings)} aria-label={t('appearance.title')} placement="bottom-end">
            <IconButton icon="appearance" size="lg" label={t('appearance.title')} data-testid="appearance-menu" />
          </Menu>
          <Menu items={languageItems(t, language)} aria-label={t('language.title')} placement="bottom-end">
            <IconButton icon="globe" size="lg" label={t('language.title')} data-testid="language-menu" />
          </Menu>
          <IconButton icon="help" size="lg" label={t('help.title')} shortcut="?" onClick={() => session.store.set({ helpOpen: true })} data-testid="help" />
        </ToolbarGroup>
      )}

      <ToolbarGroup aria-label={t('toolbar.panels')}>
        {aiPanel ? (
          <IconButton
            icon="sparkles"
            size="lg"
            label={labelText(aiPanel.title)}
            shortcut={aiPanel.shortcut}
            aria-expanded={open.trailing && trailingPanel === AI_PANEL_ID}
            pressed={open.trailing && trailingPanel === AI_PANEL_ID}
            onClick={() => session.toggleTrailingPanel(AI_PANEL_ID)}
            data-testid="toggle-ai"
          />
        ) : (
          // Reserved for the AI panel: visible and named, but not available yet.
          <IconButton icon="sparkles" size="lg" label={t('toolbar.ai')} aria-disabled="true" className="ed-toolbar-unavailable" data-testid="toggle-ai" />
        )}
        {shownPanels
          .filter((p) => p.id !== AI_PANEL_ID)
          .map((p) => (
            <IconButton
              key={p.id}
              icon={p.icon}
              size="lg"
              label={labelText(p.title)}
              shortcut={p.shortcut}
              aria-expanded={open.trailing && trailingPanel === p.id}
              pressed={open.trailing && trailingPanel === p.id}
              onClick={() => session.toggleTrailingPanel(p.id)}
              data-testid={`toggle-panel-${p.id}`}
            />
          ))}
        {actions.map((a) => {
          const state = actionState.split('|').find((x) => x.startsWith(`${a.id}:`));
          if (!state) return null;
          const enabled = state.at(-2) === '1';
          return (
            <IconButton
              key={a.id}
              icon={a.icon}
              size="lg"
              label={labelText(a.label)}
              shortcut={a.shortcut}
              pressed={a.isActive ? state.at(-1) === '1' : undefined}
              aria-disabled={enabled ? undefined : 'true'}
              className={enabled ? undefined : 'ed-toolbar-unavailable'}
              onClick={() => enabled && a.run(session)}
              data-testid={`action-${a.id}`}
            />
          );
        })}
        {compact && (
          <Menu items={moreItems} aria-label={t('common.more')} placement="bottom-end">
            <IconButton icon="more" size="lg" label={t('common.more')} data-testid="more-menu" />
          </Menu>
        )}
        {hasTrailing && (
          <IconButton
            icon="sidebarRight"
            size="lg"
            label={open.trailing && trailingPanel === MODE_PANEL ? t('toolbar.hideInspector') : t('toolbar.showInspector')}
            aria-expanded={open.trailing && trailingPanel === MODE_PANEL}
            onClick={() => session.toggleTrailingPanel(MODE_PANEL)}
            data-testid="toggle-inspector"
          />
        )}
      </ToolbarGroup>

      {editable && (
        <Button
          variant="filled"
          size="xl"
          className="ed-toolbar-save"
          loading={saving}
          disabled={modeDoc ? docState === null : false}
          title={`${t('common.save')}${docState ? ` ${docState.path}` : ''} (${FILE_SHORTCUTS.save})`}
          onClick={() => void session.saveDocument()}
          data-testid="save"
        >
          {t('common.save')}
        </Button>
      )}
    </Toolbar>
  );
}
