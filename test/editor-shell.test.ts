/**
 * The editor shell (editor/src/shell): pane layout and what is remembered, the extension registries
 * (modes, trailing panels, toolbar actions), the materials switch, how the session frames the model
 * in the area the floating chrome leaves free, and the rule that editor styles use design tokens.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankModel, PACKAGE_ROOT } from '../src/api/templates.js';
import { validateModel } from '../src/core/index.js';
import { layoutDock } from '../editor/src/design/logic/dock.js';
import { COMPACT_WIDTH, DEFAULT_SIZES, PANE_GAP, PANE_IDS, TOOLBAR_HEIGHT, dockStateOf, paneSpecs, parseLayout, serializeLayout, sizesFromDock, type PaneSetup } from '../editor/src/shell/layout.js';
import { isSoftwareRenderer, parseMaterials, resolveMaterials } from '../editor/src/shell/materials.js';
import {
  AI_PANEL_ID,
  activeDocument,
  availableModes,
  getModes,
  getPanels,
  getToolbarActions,
  labelText,
  modeDocuments,
  registerMode,
  registerPanel,
  registerToolbarAction,
  resolveMode,
  type ModeDocument,
  type ModeDocumentState,
  type WorkspaceMode,
} from '../editor/src/shell/registry.js';
import { DEFAULT_PANELS, MODE_PANEL, documentKey, documentKind, initialState, panelOpen, type AppState } from '../editor/src/state/app.js';
import { Session } from '../editor/src/state/session.js';
import { freeCenter, freeSize, visibleFreeRect, worldToScreen } from '../editor/src/view/camera.js';

const ALL: PaneSetup = { leading: true, trailing: true, bottom: true, leadingOpen: true, trailingOpen: true, bottomOpen: true, bottomBar: 52 };

describe('shell layout', () => {
  it('reads a stored layout, clamps it and falls back to the defaults', () => {
    expect(parseLayout(null)).toEqual({ sizes: DEFAULT_SIZES, panels: DEFAULT_PANELS });
    expect(parseLayout('not json')).toEqual({ sizes: DEFAULT_SIZES, panels: DEFAULT_PANELS });
    expect(parseLayout('[1]')).toEqual({ sizes: DEFAULT_SIZES, panels: DEFAULT_PANELS });
    const stored = parseLayout(JSON.stringify({ v: 2, sizes: { leading: 300, trailing: 9999, bottom: 'x' }, panels: { outliner: false, dock: 'yes' } }));
    expect(stored.sizes.leading).toBe(300);
    expect(stored.sizes.trailing).toBeLessThan(700); // clamped to the pane's maximum
    expect(stored.sizes.bottom).toBe(DEFAULT_SIZES.bottom);
    expect(stored.panels).toEqual({ outliner: false, inspector: true, dock: true });
    // The layout of the editor before the floating shell.
    const legacy = parseLayout(JSON.stringify({ left: 280, right: 340, bottom: 200, params: 0.5, panels: { inspector: false } }));
    expect(legacy.sizes).toEqual({ leading: 280, trailing: 340, bottom: 200 });
    expect(legacy.panels.inspector).toBe(false);
    // Round trip.
    expect(parseLayout(serializeLayout(stored))).toEqual(stored);
  });

  it('docks the toolbar, a full-width drawer and the sidebars; the closed drawer is a slim bar', () => {
    const specs = paneSpecs(ALL);
    expect(specs.map((s) => `${s.id}:${s.edge}`)).toEqual(['toolbar:top', 'bottom:bottom', 'leading:leading', 'trailing:trailing']);
    const size = { width: 1440, height: 900 };
    const open = layoutDock(specs, dockStateOf(DEFAULT_SIZES, ALL), size, { floating: true, gap: PANE_GAP });
    // Floating: the main area is full-bleed, the covered part is reported as safe insets.
    expect(open.main).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(open.safe.top).toBe(TOOLBAR_HEIGHT + 2 * PANE_GAP);
    expect(open.safe.bottom).toBe(DEFAULT_SIZES.bottom + 2 * PANE_GAP);
    expect(open.safe.left).toBe(DEFAULT_SIZES.leading + 2 * PANE_GAP);
    // The sidebars sit between the toolbar and the drawer.
    const leading = open.panes.find((p) => p.id === PANE_IDS.leading)!;
    expect(leading.inset.top).toBe(TOOLBAR_HEIGHT + 2 * PANE_GAP);
    expect(leading.inset.bottom).toBe(DEFAULT_SIZES.bottom + 2 * PANE_GAP);

    const closed: PaneSetup = { ...ALL, bottomOpen: false, leadingOpen: false };
    const bar = layoutDock(paneSpecs(closed), dockStateOf(DEFAULT_SIZES, closed), size, { floating: true, gap: PANE_GAP });
    expect(bar.safe.bottom).toBe(52 + 2 * PANE_GAP);
    expect(bar.safe.left).toBe(0);
    // Without a bar the closed drawer is hidden altogether.
    const hidden: PaneSetup = { ...ALL, bottomOpen: false, bottomBar: 0 };
    expect(layoutDock(paneSpecs(hidden), dockStateOf(DEFAULT_SIZES, hidden), size, { floating: true, gap: PANE_GAP }).safe.bottom).toBe(0);
    // A mode without side panels has no panes for them.
    expect(paneSpecs({ ...ALL, leading: false, trailing: false, bottom: false }).map((s) => s.id)).toEqual(['toolbar']);
  });

  it('keeps the canvas the largest area down to 1024 x 640', () => {
    const size = { width: 1024, height: 640 };
    expect(size.width).toBeLessThan(COMPACT_WIDTH);
    const l = layoutDock(paneSpecs(ALL), dockStateOf({ leading: 440, trailing: 560, bottom: 600 }, ALL), size, { floating: true, gap: PANE_GAP });
    const free = { width: size.width - l.safe.left - l.safe.right, height: size.height - l.safe.top - l.safe.bottom };
    // Even with every pane open at its largest stored size the free area stays usable.
    expect(free.width).toBeGreaterThan(280);
    expect(free.height).toBeGreaterThan(240);
  });

  it('takes resized panes from the split view, but never the height of the slim bar', () => {
    const dock = dockStateOf(DEFAULT_SIZES, ALL);
    const dragged = { ...dock, sizes: { ...dock.sizes, [PANE_IDS.leading]: 300, [PANE_IDS.bottom]: 280 } };
    expect(sizesFromDock(DEFAULT_SIZES, dragged, ALL)).toEqual({ ...DEFAULT_SIZES, leading: 300, bottom: 280 });
    expect(sizesFromDock(DEFAULT_SIZES, dock, ALL)).toBe(DEFAULT_SIZES);
    const closed: PaneSetup = { ...ALL, bottomOpen: false };
    expect(sizesFromDock(DEFAULT_SIZES, dockStateOf(DEFAULT_SIZES, closed), closed).bottom).toBe(DEFAULT_SIZES.bottom);
  });
});

describe('shell registries', () => {
  const Nothing = (): null => null;

  it('registers modes in order, replaces by id and unregisters', () => {
    const before = getModes().length;
    const offB = registerMode({ id: 'test-b', label: 'B', icon: 'avatar', order: 20, render: { canvas: Nothing } });
    const offA = registerMode({ id: 'test-a', label: () => 'A', icon: 'bone', order: 10, render: { canvas: Nothing } });
    expect(getModes().map((m) => m.id).filter((id) => id.startsWith('test-'))).toEqual(['test-a', 'test-b']);
    expect(labelText(getModes().find((m) => m.id === 'test-a')!.label)).toBe('A');
    // Same id again: replaced, not duplicated (hot reload).
    const offB2 = registerMode({ id: 'test-b', label: 'B2', icon: 'avatar', order: 5, render: {} });
    expect(getModes().filter((m) => m.id === 'test-b').map((m) => labelText(m.label))).toEqual(['B2']);
    // The remover of the replaced entry does nothing.
    offB();
    expect(getModes().some((m) => m.id === 'test-b')).toBe(true);
    offB2();
    offA();
    expect(getModes().length).toBe(before);
  });

  it('resolves the active mode by availability', () => {
    const rig: WorkspaceMode = { id: 'rig', label: 'Rig', icon: 'bone', render: {} };
    const avatar: WorkspaceMode = { id: 'avatar', label: 'Avatar', icon: 'avatar', render: {}, isAvailable: (s) => s.status === 'ready' };
    const state = initialState();
    expect(availableModes([rig, avatar], state).map((m) => m.id)).toEqual(['rig']);
    expect(resolveMode([rig, avatar], { ...state, mode: 'avatar', modeFor: documentKey(state) })?.id).toBe('rig');
    const ready = { ...state, status: 'ready' as const, file: '/m.r2d.json' };
    expect(resolveMode([rig, avatar], { ...ready, mode: 'avatar', modeFor: documentKey(ready) })?.id).toBe('avatar');
    expect(resolveMode([], state)).toBeNull();
  });

  it('shows modes without a model only when they say so, and keeps a picked mode per document', () => {
    const project = { project: '/ws/hana', projectPath: 'hana', specFile: '/ws/hana/avatar.json' };
    const projectOpen = (s: AppState): boolean => !!s.workspace?.avatar;
    const rig: WorkspaceMode = { id: 'rig', label: 'Rig', icon: 'bone', render: {} };
    const avatar: WorkspaceMode = { id: 'avatar', label: 'Avatar', icon: 'avatar', render: {}, isAvailable: projectOpen, showsWithoutModel: projectOpen, isDefault: projectOpen };
    const list = [rig, avatar];
    const workspace = { root: '/ws', current: null, recent: [] };
    // Nothing open: no mode, the start screen.
    const none: AppState = { ...initialState(), status: 'empty', workspace };
    expect(documentKind(none)).toBe('none');
    expect(resolveMode(list, none)).toBeNull();
    // An avatar project without a model: only the modes that show without one.
    const draft: AppState = { ...none, workspace: { ...workspace, avatar: project } };
    expect(documentKind(draft)).toBe('avatar-project');
    expect(availableModes(list, draft).map((m) => m.id)).toEqual(['avatar']);
    expect(resolveMode(list, draft)?.id).toBe('avatar');
    // Its first build opens the model: the same document, Avatar mode stays the default.
    const built: AppState = { ...draft, status: 'ready', file: '/ws/hana/hana.r2d.json', workspace: { ...workspace, current: '/ws/hana/hana.r2d.json', avatar: project } };
    expect(documentKind(built)).toBe('model');
    expect(documentKey(built)).toBe(documentKey(draft));
    expect(availableModes(list, built).map((m) => m.id)).toEqual(['rig', 'avatar']);
    expect(resolveMode(list, built)?.id).toBe('avatar');
    // A mode picked for the project is kept for it (a rebuild too), not for another model.
    const picked: AppState = { ...built, mode: 'rig', modeFor: documentKey(built) };
    expect(resolveMode(list, picked)?.id).toBe('rig');
    const other: AppState = { ...picked, file: '/ws/b.r2d.json', workspace };
    expect(resolveMode(list, other)?.id).toBe('rig');
    expect(resolveMode(list, { ...picked, mode: 'avatar' })?.id).toBe('avatar');
    expect(resolveMode(list, { ...other, mode: 'avatar', modeFor: documentKey(other) })?.id).toBe('rig');
  });

  it('gives the document of the mode on screen to Save / Undo / Redo, and every available one to the unsaved prompt', () => {
    const state: ModeDocumentState = { name: 'hana', path: 'hana/avatar.json', dirty: true, saving: false, canUndo: true, canRedo: false, undoLabel: 'Move', redoLabel: null };
    const document: ModeDocument = {
      subscribe: () => () => undefined,
      getState: () => state,
      save: async () => true,
      undo: () => undefined,
      redo: () => undefined,
    };
    const project = { project: '/ws/hana', projectPath: 'hana', specFile: '/ws/hana/avatar.json' };
    const rig: WorkspaceMode = { id: 'rig', label: 'Rig', icon: 'bone', render: {} };
    const avatar: WorkspaceMode = { id: 'avatar', label: 'Avatar', icon: 'avatar', render: {}, isAvailable: (s) => !!s.workspace?.avatar, document };
    const s: AppState = { ...initialState(), status: 'ready', file: '/ws/hana/hana.r2d.json', workspace: { root: '/ws', current: '/ws/hana/hana.r2d.json', recent: [], avatar: project } };
    // Rig on screen: the model is the document; the avatar's is still asked about.
    expect(activeDocument(s, [rig, avatar])).toBeNull();
    expect(activeDocument({ ...s, mode: 'avatar', modeFor: documentKey(s) }, [rig, avatar])).toBe(document);
    expect(modeDocuments(s, [rig, avatar])).toEqual([document]);
    expect(modeDocuments({ ...s, workspace: { root: '/ws', current: s.file, recent: [] } }, [rig, avatar])).toEqual([]);
  });

  it('registers trailing panels and toolbar actions', () => {
    const offPanel = registerPanel({ id: AI_PANEL_ID, title: 'AI', icon: 'sparkles', render: Nothing });
    const offAction = registerToolbarAction({ id: 'test-action', label: 'Do', icon: 'wand', run: () => undefined });
    expect(getPanels().map((p) => p.id)).toContain(AI_PANEL_ID);
    expect(getToolbarActions().map((a) => a.id)).toContain('test-action');
    offPanel();
    offAction();
    expect(getPanels().map((p) => p.id)).not.toContain(AI_PANEL_ID);
    expect(getToolbarActions().map((a) => a.id)).not.toContain('test-action');
  });
});

describe('shell materials', () => {
  it('recognizes software rasterizers', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe(true);
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer('Google SwiftShader')).toBe(true);
    expect(isSoftwareRenderer('Microsoft Basic Render Driver')).toBe(true);
    expect(isSoftwareRenderer('Apple Software Renderer')).toBe(true);
    expect(isSoftwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
    expect(isSoftwareRenderer('Apple M2')).toBe(false);
    expect(isSoftwareRenderer('')).toBe(false);
  });

  it("resolves 'auto' to solid without a GPU or with reduced transparency", () => {
    expect(resolveMaterials('auto', { software: false, reducedTransparency: false })).toBe('glass');
    expect(resolveMaterials('auto', { software: true, reducedTransparency: false })).toBe('solid');
    expect(resolveMaterials('auto', { software: false, reducedTransparency: true })).toBe('solid');
    expect(resolveMaterials('glass', { software: true, reducedTransparency: true })).toBe('glass');
    expect(resolveMaterials('solid', { software: false, reducedTransparency: false })).toBe('solid');
    expect(parseMaterials('glass')).toBe('glass');
    expect(parseMaterials('nope')).toBe('auto');
    expect(parseMaterials(null, 'solid')).toBe('solid');
  });
});

describe('session: panes and the free canvas area', () => {
  const model = validateModel(blankModel({ name: 'shell' })).model!;

  it('frames the model in the area the chrome leaves free and publishes that area', () => {
    const session = new Session();
    session.store.set({ status: 'ready', model, file: '/m.r2d.json' });
    session.setViewport({ width: 1000, height: 800 });
    const vp = session.get().viewport;
    const center = (): [number, number] => worldToScreen(session.get().camera, vp, model.meta.width / 2, model.meta.height / 2);
    // No chrome: the canvas is centred in the viewport.
    expect(center()[0]).toBeCloseTo(500, 6);
    expect(center()[1]).toBeCloseTo(400, 6);
    const zoomFull = session.get().camera.zoom;

    const insets = { top: 68, right: 336, bottom: 260, left: 280 };
    session.setInsets(insets);
    expect(freeSize(vp, insets)).toEqual({ width: 384, height: 472 });
    expect(freeCenter(vp, insets)).toEqual([472, 304]);
    // The framing follows the free area: centred in it, and smaller.
    expect(center()[0]).toBeCloseTo(472, 6);
    expect(center()[1]).toBeCloseTo(304, 6);
    expect(session.get().camera.zoom).toBeLessThan(zoomFull);
    // The whole canvas is inside the free area.
    const [x0, y0] = worldToScreen(session.get().camera, vp, 0, 0);
    const [x1, y1] = worldToScreen(session.get().camera, vp, model.meta.width, model.meta.height);
    expect(x0).toBeGreaterThanOrEqual(insets.left);
    expect(y0).toBeGreaterThanOrEqual(insets.top);
    expect(x1).toBeLessThanOrEqual(vp.width - insets.right);
    expect(y1).toBeLessThanOrEqual(vp.height - insets.bottom);
    // The published view box is what the person sees unobstructed.
    const box = session.editorState()!.viewBox!;
    const free = visibleFreeRect(session.get().camera, vp, insets);
    expect(box.map((v) => Math.round(v))).toEqual(free.map((v) => Math.round(v)));
    expect(box[0]).toBeLessThanOrEqual(0);
    expect(box[0] + box[2]).toBeGreaterThanOrEqual(model.meta.width);

    // Zooming keeps the centre of the free area fixed.
    session.zoomTo(2);
    expect(center()[0]).toBeCloseTo(472, 6);
    expect(center()[1]).toBeCloseTo(304, 6);
    // After navigating by hand the view no longer follows the panes.
    const camera = session.get().camera;
    session.setInsets({ top: 68, right: 0, bottom: 76, left: 0 });
    expect(session.get().camera).toEqual(camera);
    // Framing again does.
    session.focus('canvas');
    session.setInsets({ top: 68, right: 0, bottom: 260, left: 0 });
    expect(center()[0]).toBeCloseTo(500, 6);
  });

  it('opens one sidebar at a time on a narrow window and leaves the remembered layout alone', () => {
    const session = new Session();
    expect(session.get().panels).toEqual(DEFAULT_PANELS);
    session.setCompact(true);
    expect(panelOpen(session.get(), 'outliner')).toBe(false);
    expect(panelOpen(session.get(), 'inspector')).toBe(false);
    expect(panelOpen(session.get(), 'dock')).toBe(true);
    session.togglePanel('outliner');
    expect(panelOpen(session.get(), 'outliner')).toBe(true);
    session.showProblems();
    expect(panelOpen(session.get(), 'inspector')).toBe(true);
    expect(panelOpen(session.get(), 'outliner')).toBe(false);
    expect(session.get().inspectorTab).toBe('problems');
    expect(session.get().panels).toEqual(DEFAULT_PANELS);
    session.setCompact(false);
    expect(panelOpen(session.get(), 'outliner')).toBe(true);
    session.setPanel('dock', false);
    expect(session.get().panels.dock).toBe(false);
  });

  it('switches trailing panels like toolbar toggles', () => {
    const session = new Session();
    session.toggleTrailingPanel(MODE_PANEL);
    expect(panelOpen(session.get(), 'inspector')).toBe(false);
    session.toggleTrailingPanel(AI_PANEL_ID);
    expect(panelOpen(session.get(), 'inspector')).toBe(true);
    expect(session.get().trailingPanel).toBe(AI_PANEL_ID);
    session.toggleTrailingPanel(MODE_PANEL);
    expect(panelOpen(session.get(), 'inspector')).toBe(true);
    expect(session.get().trailingPanel).toBe(MODE_PANEL);
    session.store.set({ status: 'ready', file: '/m.r2d.json' });
    session.setMode('avatar');
    // The mode is picked for the document shown.
    expect(session.get()).toMatchObject({ mode: 'avatar', modeFor: 'model:/m.r2d.json' });
  });

  it('keeps the sliders while selecting, and shows what was picked on request', () => {
    const session = new Session();
    expect(session.get().inspectorTab).toBe('parameters');
    session.select(['part:body']);
    expect(session.get().inspectorTab).toBe('parameters');
    session.setInspectorTab('problems');
    session.select(['part:eye']);
    expect(session.get().inspectorTab).toBe('selection');
    session.setInspectorTab('parameters');
    session.setPanel('inspector', false);
    session.inspect(['part:body']);
    expect(session.get()).toMatchObject({ selection: ['part:body'], inspectorTab: 'selection', trailingPanel: MODE_PANEL });
    expect(panelOpen(session.get(), 'inspector')).toBe(true);
  });
});

describe('editor styles', () => {
  const root = path.join(PACKAGE_ROOT, 'editor', 'src');
  const cssFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === 'design' ? [] : cssFiles(full);
      return name.endsWith('.css') ? [full] : [];
    });

  it('has no legacy stylesheets and small CSS files next to the components', () => {
    const files = cssFiles(root).map((f) => path.relative(root, f).replace(/\\/g, '/'));
    expect(files).not.toContain('styles.css');
    expect(files).not.toContain('files/files.css');
    expect(files.length).toBeGreaterThan(8);
  });

  it('uses design tokens for every colour (no literals outside editor/src/design)', () => {
    const offenders: string[] = [];
    for (const file of cssFiles(root)) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      css.split('\n').forEach((line, i) => {
        if (/#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(|light-dark\(/.test(line)) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('only references design tokens that exist', () => {
    const tokens = new Set([...readFileSync(path.join(root, 'design', 'tokens.css'), 'utf8').matchAll(/(--r2-[\w-]+)\s*:/g)].map((m) => m[1]!));
    // Published by components at run time rather than defined in tokens.css.
    for (const t of ['--r2-plate', '--r2-radius-concentric', '--r2-safe-top', '--r2-safe-right', '--r2-safe-bottom', '--r2-safe-left', '--r2-floating-available', '--r2-row-level']) tokens.add(t);
    const unknown: string[] = [];
    for (const file of cssFiles(root)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/var\((--r2-[\w-]+)/g)) if (!tokens.has(m[1]!)) unknown.push(`${path.relative(root, file)}: ${m[1]}`);
    }
    expect([...new Set(unknown)]).toEqual([]);
  });
});
