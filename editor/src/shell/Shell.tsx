/**
 * The editor shell: a full-bleed canvas with floating chrome (the design system's SplitView in
 * floating mode).
 *
 *   ┌ toolbar: glass groups ─────────────────────────────────────────────┐
 *   │ ┌ leading ┐                                          ┌ trailing ┐ │
 *   │ │ sidebar │            canvas (full-bleed)           │ panel    │ │
 *   │ └─────────┘  (status line)            (mode's HUD)   └──────────┘ │
 *   │ ┌ bottom drawer (closed: a slim bar) ─────────────────────────────┐│
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * What fills the slots comes from the active workspace mode and the registered trailing panels
 * (registry.ts): the shell knows no feature. With no mode to show (nothing open, or no mode shows
 * the open document without a model) the main area is the start screen. The shell owns the pane
 * sizes (remembered per browser, with which panes are open), the narrow-window behaviour (below
 * COMPACT_WIDTH the sidebars start closed and open one at a time), and it tells the session which
 * part of the canvas the chrome covers, so the model is framed in the free area.
 */
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { SplitView, layoutDock, type DockState, type SplitPane } from '../design/index.js';
import { useElementSize } from '../design/util.js';
import { FileDialogs } from '../files/FileDialogs.js';
import { StartScreen } from '../files/StartScreen.js';
import { useT } from '../i18n/index.js';
import { MODE_PANEL, panelOpen } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import { shallowEqual } from '../state/store.js';
import { EditorToolbar } from './EditorToolbar.js';
import { COMPACT_WIDTH, PANE_GAP, PANE_IDS, dockStateOf, loadLayout, paneSpecs, saveLayout, sizesFromDock, type PaneSetup, type PaneSizes } from './layout.js';
import { Banners, HelpSheet, LoadFailure, Toasts } from './Overlays.js';
import { labelText, resolveMode, useModes, usePanels } from './registry.js';
import { StatusLine } from './StatusLine.js';
import './shell.css';

/** Height the status line takes at the bottom of the free area (the model is framed above it). */
const HUD_ROW = 40;

export function Shell() {
  const session = useSession();
  const t = useT();
  const modes = useModes();
  const panels = usePanels();
  const status = useApp((s) => s.status);
  const mode = useApp((s) => resolveMode(modes, s));
  // No mode shows the open document (nothing is open): the start screen.
  const empty = mode === null && status === 'empty';
  const trailingId = useApp((s) => s.trailingPanel);
  const panelIds = useApp((s) => panels.filter((p) => (p.isAvailable ? p.isAvailable(s) : true)).map((p) => p.id).join('|'));
  const open = useApp((s) => ({ leading: panelOpen(s, 'outliner'), trailing: panelOpen(s, 'inspector'), bottom: panelOpen(s, 'dock') }), shallowEqual);
  const storedPanels = useApp((s) => s.panels);
  const [sizes, setSizes] = useState<PaneSizes>(() => loadLayout().sizes);
  useEffect(() => saveLayout({ sizes, panels: storedPanels }), [sizes, storedPanels]);

  const [measure, size] = useElementSize<HTMLDivElement>();
  const compact = (size?.width ?? window.innerWidth) < COMPACT_WIDTH;
  useEffect(() => session.setCompact(compact), [session, compact]);

  // The slots of the window.
  const registered = panels.find((p) => p.id === trailingId && panelIds.split('|').includes(p.id));
  const Leading = empty ? undefined : mode?.render.leading;
  const Canvas = empty ? undefined : mode?.render.canvas;
  const Bottom = empty ? undefined : mode?.render.bottom;
  const Trailing = empty ? undefined : trailingId !== MODE_PANEL && registered ? registered.render : (mode?.render.trailing ?? registered?.render);
  const bottomBar = Bottom ? (mode?.bottomBar ?? 0) : 0;

  const setup = useMemo<PaneSetup>(
    () => ({
      leading: Leading !== undefined,
      trailing: Trailing !== undefined,
      bottom: Bottom !== undefined,
      leadingOpen: open.leading,
      trailingOpen: open.trailing,
      bottomOpen: open.bottom,
      bottomBar,
    }),
    [Leading, Trailing, Bottom, open, bottomBar],
  );
  const specs = useMemo(() => paneSpecs(setup), [setup]);
  const dock = useMemo(() => dockStateOf(sizes, setup), [sizes, setup]);
  const safe = useMemo(() => layoutDock(specs, dock, size, { floating: true, gap: PANE_GAP }).safe, [specs, dock, size]);

  // The session frames the model in what the chrome leaves free (and above the status line).
  useLayoutEffect(() => {
    session.setInsets({ top: safe.top, right: safe.right, bottom: safe.bottom + (empty ? 0 : HUD_ROW), left: safe.left });
    // Surfaces in layers outside the split view (toasts) centre themselves in the free area too.
    const root = document.documentElement.style;
    root.setProperty('--ed-free-left', `${safe.left}px`);
    root.setProperty('--ed-free-right', `${safe.right}px`);
    root.setProperty('--ed-free-bottom', `${safe.bottom}px`);
  }, [session, safe, empty]);

  const onDock = (next: DockState): void => {
    setSizes((prev) => sizesFromDock(prev, next, setup));
    if (setup.leading && next.collapsed[PANE_IDS.leading] !== dock.collapsed[PANE_IDS.leading]) session.setPanel('outliner', !next.collapsed[PANE_IDS.leading]);
    if (setup.trailing && next.collapsed[PANE_IDS.trailing] !== dock.collapsed[PANE_IDS.trailing]) session.setPanel('inspector', !next.collapsed[PANE_IDS.trailing]);
    // Dragged shut: the drawer becomes its slim bar (or hides); dragged back out of hiding: it opens.
    if (setup.bottom && next.collapsed[PANE_IDS.bottom] !== dock.collapsed[PANE_IDS.bottom]) session.setPanel('dock', !next.collapsed[PANE_IDS.bottom]);
  };

  const names = mode?.paneLabels;
  const panes: SplitPane[] = specs.map((spec): SplitPane => {
    switch (spec.id) {
      case PANE_IDS.bottom:
        return { ...spec, label: names?.bottom ? labelText(names.bottom) : t('shell.pane.bottom'), content: Bottom ? <Bottom collapsed={!open.bottom} /> : null };
      case PANE_IDS.leading:
        return { ...spec, label: names?.leading ? labelText(names.leading) : t('shell.pane.leading'), content: Leading ? <Leading /> : null };
      case PANE_IDS.trailing:
        return { ...spec, label: registered && Trailing === registered.render ? labelText(registered.title) : names?.trailing ? labelText(names.trailing) : t('shell.pane.trailing'), content: Trailing ? <Trailing /> : null };
      default:
        return { ...spec, label: t('toolbar.label'), content: <EditorToolbar mode={mode} compact={compact} />, resizable: false, passthrough: true };
    }
  });

  return (
    <div ref={measure} className="ed-shell" data-status={status} data-mode={mode?.id} data-compact={compact ? '' : undefined}>
      <SplitView floating gap={PANE_GAP} panes={panes} state={dock} onStateChange={onDock}>
        {empty ? <StartScreen /> : Canvas ? <Canvas /> : <div className="ed-canvas-empty" />}
        {!empty && (
          <div className="ed-hud">
            <Banners />
            <div className="ed-hud-status">
              <StatusLine mode={mode} />
            </div>
          </div>
        )}
        <Toasts />
      </SplitView>
      <HelpSheet />
      <LoadFailure />
      <FileDialogs />
    </div>
  );
}
