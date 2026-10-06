# editor/src/shell: the editor shell and its extension points

The shell is the window: a full-bleed canvas with floating chrome, built from the design system
([`../design/README.md`](../design/README.md), [docs/DESIGN-SYSTEM.md](../../../docs/DESIGN-SYSTEM.md)).
It knows no feature. Features plug in through three registries, so a new workspace mode, a new
trailing panel or a new toolbar button never touches `App.tsx` or `Shell.tsx`.

```text
┌ toolbar: (sidebar | File ▾) (modes) … (overlays) … (undo redo) (display) (AI … inspector) [Save] ┐
│ ┌ leading ┐                                                              ┌ trailing ───────────┐ │
│ │ mode.   │                mode.render.canvas (full-bleed)               │ mode.render.trailing│ │
│ │ render. │                                                              │ or a registered     │ │
│ │ leading │  (status line)                          (the mode's own HUD) │ panel (AI, …)       │ │
│ └─────────┘                                                              └─────────────────────┘ │
│ ┌ mode.render.bottom: a drawer; closed it keeps `bottomBar` px (the timeline's transport bar) ───┐ │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| File | What it is |
| --- | --- |
| `registry.ts` | `registerMode`, `registerPanel`, `registerToolbarAction` and their hooks |
| `Shell.tsx` | the SplitView layout, slots, narrow-window behaviour, safe insets for the session |
| `EditorToolbar.tsx` | the toolbar groups; folds into menus on a narrow window |
| `StatusLine.tsx` | validation (or the mode's own items, `StatusItem`), AI bridge, file and pointer status in one capsule |
| `Overlays.tsx` | banners, toasts, the shortcut sheet, the load-failure alert, the drop target |
| `extensions.ts` | the list of feature modules of this build: one import line per feature |
| `rigMode.tsx` | the built-in "Rig" mode (registers itself; exports its slots for reuse) |
| `layout.ts` | pane sizes, limits and what is remembered (pure, tested) |
| `settings.tsx`, `materials.ts` | appearance and materials (`useSettings`) |

## Adding a workspace mode

A mode says what the whole window is for. As soon as two modes are available the toolbar shows a
segmented control to switch between them (`session.setMode(id)`, state `mode`).

```tsx
// editor/src/avatar/avatarMode.tsx; then add `import '../avatar/avatarMode.js';` to shell/extensions.ts
import { Inspector, InspectorSection, Sidebar } from '../design/index.js';
import { t } from '../i18n/index.js';
import { registerMode } from '../shell/registry.js';

function AvatarCanvas() {
  // Fills the window under the chrome. Keep the subject inside the free area:
  //   top: var(--r2-safe-top); right / bottom / left likewise (see viewport/viewport.css).
  return <div className="avatar-canvas" />;
}

function AvatarLayers() {
  return <Sidebar title={t('avatar.layers')}>…</Sidebar>;
}

function AvatarInspector() {
  return (
    <Inspector title={t('avatar.landmarks')}>
      <InspectorSection title={t('avatar.eyes')}>…</InspectorSection>
    </Inspector>
  );
}

registerMode({
  id: 'avatar',
  label: () => t('avatar.mode'), // a function: evaluated in the current language
  icon: 'avatar',
  order: 10, // Rig is 0
  isAvailable: (state) => !!state.workspace?.avatar, // optional; default: whenever a model is open
  showsWithoutModel: (state) => !!state.workspace?.avatar, // optional: also before the first build
  isDefault: (state) => !!state.workspace?.avatar, // optional: the mode a newly opened document starts in
  document: avatarDocument, // optional: the mode edits a document of its own (below)
  render: { leading: AvatarLayers, canvas: AvatarCanvas, trailing: AvatarInspector, status: AvatarStatus }, // no `bottom`: no drawer in this mode
});
```

- **Which mode shows.** The window follows the open document (`documentKind(state)` in
  `state/app.ts`): `'model'` (a model is open: every available mode can show), `'avatar-project'`
  (an avatar project WITHOUT a built model: only modes with `showsWithoutModel`) or `'none'` (the
  start screen). The mode the person picks (`session.setMode(id)`) is kept for that document
  (`state.mode`, `state.modeFor` = `documentKey(state)`; an avatar project is one document before
  and after its first build); another document starts in its default mode: the first available one
  with `isDefault`, else the first available one (Rig). `resolveMode(list, state)` does this;
  `null` means the start screen.
- **A document of its own** (`document: ModeDocument`, `registry.ts`): an external store with
  `subscribe`, `getState()` (`{name, path, dirty, saving, canUndo, canRedo, undoLabel, redoLabel}`
  or null while there is nothing to save; the same object while nothing changed), `save()`,
  `undo()`, `redo()` and `keptBy(next)` (whether opening `next`, an absolute path, or `null` for
  closing, keeps it open). While the mode is on screen the toolbar's Save, Undo and Redo, Ctrl+S /
  Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, the File button's unsaved dot, the window title and the status
  line's file item use it (`session.saveDocument()`, `undoDocument()`, `redoDocument()`); without
  it they act on the model. The unsaved-changes prompt asks about every available mode's dirty
  document that an action would replace (before the model), with Save calling its `save()`, and
  leaving the page asks while one is dirty (`session.hasUnsavedWork()`).
- **Status items** (`render.status`): shown in the status line in place of the model's validation
  badge; build them from `StatusItem` (`shell/StatusLine.js`: icon, tone, text, optional `onClick`).

- Every slot is a React component; a slot that is left out is not there in that mode (no pane, no
  toggle button). `render.bottom` receives `{ collapsed }`; with `bottomBar: 52` the closed drawer
  keeps a 52 px bar (the Rig timeline's transport), without it the closed drawer is hidden.
- Render the design system's panel shells in the slots: `<Sidebar>` (leading), `<Inspector>`
  (trailing), `<Drawer>` (bottom). They are glass; inside them use plates and fills, never glass.
- To keep parts of the Rig mode, import them: `RigCanvas`, `RigLeading`, `RigTrailing`, `RigBottom`
  from `shell/rigMode.js` (e.g. `render: { canvas: RigCanvas, trailing: MyPanel }`).
- The canvas of a mode is full-bleed. `Shell` publishes the area the chrome leaves free in two
  ways: CSS custom properties `--r2-safe-top | -right | -bottom | -left` on the split view (use them
  to position HUD elements, see `.ed-view-controls`), and `session.getInsets()` / `session.focus()`
  for camera math (the Rig viewport is framed in the free area; `freeSize`, `freeCenter` and
  `visibleFreeRect` in `view/camera.ts` do the arithmetic).
- Pane names for dividers and toggles: `paneLabels: { leading, trailing, bottom }` (default
  Sidebar / Inspector / Timeline).
- The shell's own status line, banners and toasts stay in every mode.

## Adding a trailing panel (the AI panel)

A registered panel is available in every mode, next to the mode's own inspector, and gets a toggle
button in the toolbar's panel group.

```tsx
import { Inspector } from '../design/index.js';
import { t } from '../i18n/index.js';
import { AI_PANEL_ID, registerPanel } from '../shell/registry.js';

function AiPanel() {
  return <Inspector title={t('ai.title')} icon="sparkles">…</Inspector>;
}

registerPanel({ id: AI_PANEL_ID, title: () => t('ai.title'), icon: 'sparkles', render: AiPanel });
```

(and one import line for the module in `shell/extensions.ts`).

- `AI_PANEL_ID` (`'ai'`) is reserved: the toolbar always shows the sparkles button. Until a panel
  with this id registers it is dimmed (`aria-disabled`) with the tooltip "AI Assistant"; afterwards
  it toggles the panel (`data-testid="toggle-ai"`).
- Any other id gets its own button (`data-testid="toggle-panel-<id>"`).
- Open or close it from code with `session.showTrailingPanel(id)` / `session.toggleTrailingPanel(id)`;
  the state is `trailingPanel` (`MODE_PANEL` = the mode's own) and `panelOpen(state, 'inspector')`.

## Adding a toolbar action

```ts
import { registerToolbarAction } from '../shell/registry.js';

registerToolbarAction({
  id: 'export-gif',
  label: () => t('export.gif'),
  icon: 'film',
  shortcut: 'Ctrl+E', // shown in the tooltip; handle the key yourself
  isAvailable: (state) => state.status === 'ready',
  isEnabled: (state) => state.animation !== null,
  isActive: (state) => state.playing, // optional: makes it a toggle
  run: (session) => session.toast('info', 'Exporting…'),
});
```

Every `register*` returns a function that removes the entry; registering an existing id replaces it.

## Session API the shell adds

| Call | Effect |
| --- | --- |
| `session.setMode(id)` | switch the workspace mode (kept for the open document) |
| `session.saveDocument()` / `undoDocument()` / `redoDocument()` | Save / Undo / Redo the document on screen: the active mode's `document`, else the model |
| `session.confirmUnsaved(action, {next?, modelOnly?})` | ask about unsaved edits an action replaces (mode documents first, then the model) |
| `session.hasUnsavedWork()` | the model or a mode document is not on disk |
| `session.setPanel(pane, open)` / `togglePanel(pane)` | `'outliner'` (leading), `'inspector'` (trailing), `'dock'` (bottom) |
| `session.showTrailingPanel(id)` / `toggleTrailingPanel(id)` | show a trailing panel (opens the sidebar) |
| `session.showInspector(tab)` / `setInspectorTab(tab)` | pages of the Rig inspector: `'parameters' \| 'selection' \| 'problems'` |
| `session.showProblems()` | open the problems page |
| `session.inspect(keys)` | select and show in the selection inspector |
| `session.setInsets(insets)` / `getInsets()` | the part of the canvas the chrome covers (set by the shell) |
| `session.toast(kind, text, { source, action, details })` | a toast above the status line |

On a window narrower than `COMPACT_WIDTH` (1100 px) the sidebars start closed and open one at a
time (`state.compact`, `state.compactPanels`); the remembered layout (`localStorage`
`rev2d.editor.layout`: pane sizes and open panes) is not touched meanwhile.

## Languages, appearance, materials

- Strings: `const t = useT()` in components, `t(...)` elsewhere, both from `../i18n/index.js`. Add a
  key to `i18n/locales/en/<namespace>.ts` and to the same file under `ko/` and `ja/` (the build
  fails until all three have it; `test/editor-i18n.test.ts` checks the rest). A new feature adds its
  own namespace file and spreads it in `locales/en.ts`, `ko.ts` and `ja.ts`. Messages:
  `{name}` variables, `{n|one|other}` plural choice. Model ids, file names and core diagnostics are
  not translated. The language is `useLanguage()` / `setLanguage('ko')` (stored as
  `rev2d.language`; default from the browser; `?lang=ko` for a page load).
- Appearance: `useSettings()` gives `appearance` (`'auto' | 'light' | 'dark'`),
  `resolvedAppearance` and `setAppearance` (stored as `rev2d.appearance`, default auto; `?appearance=`).
  Colours painted outside CSS come from the tokens: `readCanvasTheme()` in `overlay/theme.ts`
  (WebGL clear colour, checkerboard, overlay palette); read it again when `resolvedAppearance` changes.
- Materials: `'auto' | 'glass' | 'solid'` (`rev2d.materials`, `?materials=`). Auto sets
  `data-materials="solid"` on `<html>` when WebGL runs on a software rasterizer or the system asks
  for reduced transparency.

## Rules for new screens

1. Components and tokens come from `../design/index.js`; shared small pieces (`Dialog`, `Notice`,
   `Keys`, `FieldRow`, `Chip`, `LinkButton`) from `../ui/Dialog.js` and `../ui/kit.js`.
2. One small CSS file next to the component, classes prefixed `ed-`, design tokens only: no colour
   literals (`test/editor-shell.test.ts` fails on them), no font sizes outside the text tokens.
3. Dialogs are `Dialog` (a centred sheet; `alert` for confirmations), never a custom overlay.
4. Every control has a name in all three languages; icon-only controls use `IconButton` (`label`).
5. Check 1440 x 900 and 1024 x 640, light and dark, Korean and Japanese (`?lang=ko`,
   `?appearance=dark` and `?materials=glass` on the page URL set them for a screenshot).
