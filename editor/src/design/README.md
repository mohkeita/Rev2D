# editor/src/design: the Rev2D design system

Tokens, base styles, React 19 components and icons with an iOS / iPadOS sensibility. No dependencies
beyond React. The rationale, the research and the editor layout are in
[docs/DESIGN-SYSTEM.md](../../../docs/DESIGN-SYSTEM.md); the gallery (`editor/gallery.html`) shows
everything live.

```text
design/
  index.ts          import everything from here (loads tokens.css, base.css and each component's CSS)
  tokens.css        custom properties: colour, materials, radii, space, type, motion, focus, layers
  base.css          .r2-app / .r2-layer scope, materials and glass classes, text classes, keyframes
  icons.tsx         Icon, IconName, ICON_NAMES (117 original glyphs)
  appearance.ts     useAppearance, applyAppearance, readColorToken
  strings.ts        designStrings, setDesignStrings: the few words the components say themselves
  util.ts           cx, mergeRefs, useControllable, usePresence, useOutsidePress, useElementSize
  logic/            pure functions behind the components (tested without a DOM)
  components/       one .tsx and one .css per component
  gallery/          the gallery page (not part of the system: prefix g-)
```

## Setup

```tsx
import { Button, Icon, useAppearance } from './design/index.js'; // path relative to editor/src

// 1. The root element of the app (usually <body>) gets the class r2-app.
// 2. The appearance is an attribute on <html>: "light" | "dark" | "auto" (auto follows the system).
const { appearance, resolved, setAppearance } = useAppearance(); // applies and remembers it
```

- `<meta name="color-scheme" content="light dark">` belongs in the page head.
- Import from `design/index.js`, not from the component files: the index loads the tokens first.
- Browsers: `light-dark()` is required (Chrome / Edge 123, Firefox 120, Safari 17.5).
  `editor/vite.config.ts` sets `build.cssTarget` so that the build does not lower it.
- Everything is scoped: classes start with `r2-`, custom properties with `--r2-`, page defaults apply
  under `.r2-app` and in portaled layers (`.r2-layer`) only. The system can live next to legacy styles.

## Usage rules

1. **Tokens, not values.** Colours, radii, spacing, type and motion come from `--r2-*` tokens. If a
   value is missing, add a token (and its dark value) instead of a literal.
2. **Glass is for floating chrome.** `.r2-glass` (compact controls) and `.r2-glass-panel` (panels,
   menus, sheets) go on surfaces that float above the canvas. Never nest them. On glass, use fills
   (`--r2-fill-*`) and the plate (`--r2-plate`).
3. **Concentric radii.** A container sets `--r2-radius-concentric` (its radius minus its padding);
   nested groups read it. Do not pick inner radii by eye.
4. **One tint.** One `filled` button per view. `--r2-tint` for text and glyphs, `--r2-tint-solid`
   behind white labels, `--r2-tint-fill` for tinted plates. Red only for destructive, green and
   orange only for status.
5. **Text styles.** `font: var(--r2-text-body)` (or the class `.r2-text-body`), label levels
   `--r2-label` / `-2` / `-3`. Numbers that change in place get `.r2-num`.
6. **Names.** Icon-only controls need `label`; fields need `label` or `aria-label`; rows label
   their trailing control (`trailing={(id) => <Switch aria-labelledby={id} />}`).
7. **Controlled or uncontrolled.** Every input takes `value` + `onChange` (controlled) or
   `defaultValue` (uncontrolled). `onChange` receives the value, not an event.
8. **Motion.** `transition: ... var(--r2-duration-base) var(--r2-spring-snappy)`. Do not hard-code
   durations: the reduced-motion switch works through the tokens.
9. **Painting outside CSS** (WebGL clear colour, canvas overlays): `readColorToken('--r2-canvas')`
   returns `[r, g, b, a]` as the browser resolves it; read it again when the appearance changes.
10. **Check both appearances**, Korean / Japanese labels, and `data-transparency="reduce"`,
    `data-contrast="more"`, `data-motion="reduce"` on `<html>` (the gallery's Display options set them).

## Token naming

`--r2-<group>[-<level or role>]`. Levels count down in emphasis (`--r2-label`, `--r2-label-2` ...).

| Group | Tokens |
| --- | --- |
| Type | `--r2-font`, `-font-display`, `-font-mono`; `--r2-weight-regular\|medium\|semibold\|bold`; `--r2-text-large-title\|title-1\|title-2\|title-3\|headline\|body\|callout\|subhead\|footnote\|caption\|mono\|mono-small`; `--r2-tracking-display\|body\|caption` |
| Space | `--r2-space-0\|0-5\|1\|1-5\|2\|3\|4\|5\|6\|8\|10\|12\|16` (4 pt grid) |
| Radius | `--r2-radius-2xs\|xs\|sm\|md\|lg\|xl\|2xl\|3xl\|capsule`; roles `--r2-radius-control-sm\|control\|control-lg\|group\|menu\|popover\|panel\|sheet`; `--r2-radius-concentric` (set by containers) |
| Size | `--r2-control-sm\|md\|lg\|xl` (24 / 28 / 36 / 44), `--r2-hit-min`, `--r2-hit-touch`, `--r2-row-height`, `--r2-toolbar-height`, `--r2-panel-inset`, `--r2-hairline` |
| Labels, fills, lines | `--r2-label`, `-2`, `-3`, `-4`, `--r2-placeholder`; `--r2-fill`, `-2`, `-3`, `-4`, `--r2-fill-raised`; `--r2-separator`, `-strong`, `-opaque` |
| Backgrounds | `--r2-bg`, `-2`, `-3`, `--r2-bg-grouped`, `-2`, `-3`, `--r2-bg-elevated`; `--r2-plate` (context: card or translucent plate) |
| Tint | `--r2-tint`, `--r2-tint-solid`, `-solid-hover`, `-solid-pressed`, `--r2-on-tint`, `--r2-tint-fill`, `-fill-hover`, `-fill-pressed`, `--r2-selection`, `--r2-selection-text` |
| Palette | `--r2-red\|orange\|yellow\|green\|mint\|teal\|cyan\|blue\|indigo\|purple\|pink\|brown\|gray`, `--r2-gray-2` ... `-6` |
| Semantic | `--r2-success\|warning\|danger\|info` with `-text` and `-fill`; `--r2-danger-solid`, `-solid-hover`, `-solid-pressed` |
| Rig kinds | `--r2-kind-part\|bone\|warp\|parameter\|animation\|binding\|ik\|physics\|texture` |
| Canvas | `--r2-canvas`, `-canvas-glow`, `-canvas-check-a`, `-canvas-check-b`, `-canvas-grid`, `-canvas-guide`, `--r2-scrim` |
| Materials | `--r2-material-ultrathin\|thin\|regular\|thick`, each with `-solid`; `--r2-material-filter-*`; `--r2-glass-plate\|solid\|filter\|rim\|hairline\|highlight\|shadow`, `--r2-glass-panel-plate\|solid\|filter\|shadow`, `--r2-glass-clear-plate\|filter` |
| Elevation | `--r2-shadow-1\|2\|3\|4` |
| Motion | `--r2-duration-instant\|fast\|base\|slow\|slower`, `--r2-ease-out\|in\|in-out\|standard`, `--r2-spring-smooth\|snappy\|bouncy`, `--r2-motion-distance`, `--r2-motion-scale`, `--r2-press-scale` |
| Focus | `--r2-focus-color`, `--r2-focus-width`, `--r2-focus-offset`, `--r2-focus-ring` |
| Layers | `--r2-z-base\|raised\|chrome\|overlay\|toast\|tooltip` |

Root attributes: `data-appearance="light|dark|auto"`, `data-transparency="reduce"` (or
`data-materials="solid"`), `data-contrast="more"`, `data-motion="reduce"`. Each mirrors a media query
(`prefers-color-scheme`, `prefers-reduced-transparency`, `prefers-contrast`, `prefers-reduced-motion`).

Utility classes: `.r2-app`, `.r2-layer`, `.r2-glass`, `.r2-glass-panel`, `.r2-glass-clear`,
`.r2-material-ultrathin|thin|regular|thick`, `.r2-text-*` (one per text token), `.r2-num`,
`.r2-label-2`, `.r2-label-3`, `.r2-tint`, `.r2-truncate`, `.r2-visually-hidden`, `.r2-scroll`,
`.r2-hit` (44 px touch target), `.r2-icon`.

## Components

Sizes: `ControlSize = 'sm' | 'md' | 'lg' | 'xl'`. All components accept `className`; those that wrap
one DOM element pass other props (`data-testid`, `aria-*`, `ref`) through to it.

### Buttons

| Component | Props |
| --- | --- |
| `Button` | `variant?: 'filled' \| 'tinted' \| 'gray' \| 'plain' \| 'glass'` (default `gray`), `size?`, `shape?: 'rounded' \| 'capsule'` (default: rounded for sm / md, capsule for lg / xl), `destructive?`, `icon?: IconName`, `trailingIcon?`, `loading?`, `block?`, + `<button>` props |
| `IconButton` | `icon: IconName`, `label: string` (required), `shortcut?`, `variant?` (default `plain`), `size?`, `shape?: 'circle' \| 'rounded'`, `pressed?: boolean` (toggle), `destructive?`, `tooltip?: boolean \| Placement`, + `<button>` props |

### Inputs

| Component | Props |
| --- | --- |
| `SegmentedControl<T>` | `options: { value: T; label?; icon?; ariaLabel?; disabled? }[]`, `value?`, `defaultValue?`, `onChange?(value)`, `size?: 'sm' \| 'md' \| 'lg'`, `shape?: 'capsule' \| 'rounded'`, `block?`, `disabled?`, `aria-label` |
| `Switch` | `checked?`, `defaultChecked?`, `onChange?(checked)`, `size?: 'sm' \| 'md'`, `label?` (visible, clickable), + `<button>` props |
| `Slider` | `value?`, `defaultValue?`, `min?` (0), `max?` (1), `step?`, `onChange?(value)`, `onChangeEnd?(value)`, `origin?` (fill from this value), `ticks?: number[] \| number \| boolean`, `showValue?: 'auto' \| 'always' \| 'never'`, `formatValue?(value)`, `resetValue?` (double-click / Alt-click), `disabled?`, `size?: 'sm' \| 'md'`, `aria-label` / `aria-labelledby` |
| `Stepper` | `value?`, `defaultValue?`, `onChange?(value)`, `min?`, `max?`, `step?`, `size?`, `disabled?`, `decrementLabel?`, `incrementLabel?` |
| `TextField` | `value?`, `defaultValue?`, `onChange?(text)`, `onCommit?(text)` (Enter), `label?`, `hint?`, `error?`, `icon?`, `leading?`, `trailing?`, `clearable?`, `size?: 'sm' \| 'md' \| 'lg'`, `shape?`, `mono?`, `width?`, + `<input>` props |
| `SearchField` | `TextField` props; capsule, magnifier, clear button, Escape clears |
| `NumberField` | `value?`, `defaultValue?`, `onChange?(number)`, `onChangeEnd?(number)`, `min?`, `max?`, `step?` (1), `precision?`, `unit?`, `prefix?` (scrub handle), + `TextField` props |
| `Select<T>` | `options: { value: T; label: string; icon?; description?; disabled? }[]`, `value?`, `defaultValue?`, `onChange?(value)`, `placeholder?`, `size?`, `variant?: 'gray' \| 'plain'`, `block?`, `disabled?`, `aria-label` |

### Menus and overlays

| Component | Props |
| --- | --- |
| `Menu` | `items: MenuEntry[]`, `children` (the trigger element), `placement?`, `onAction?(id)`, `open?`, `onOpenChange?`, `aria-label` |
| `ContextMenu` | `items: MenuEntry[] \| ((target: Element) => MenuEntry[])`, `children`, `onAction?(id)`, `disabled?` |
| `MenuList` | The list both use (and `Select`): `items`, `anchor`, `placement?`, `onClose(reason)`, `onAction?`, `initialFocus?`, `role?: 'menu' \| 'listbox'`, `selectedId?`, `matchWidth?` |
| `Popover` | `trigger?` (element) or `anchor?` + `open`, `defaultOpen?`, `onOpenChange?`, `placement?`, `offset?`, `title?`, `width?`, `padded?`, `children` (node or `(close) => node`) |
| `Sheet` | `open`, `onClose()`, `onConfirm?()` (Enter), `onEscape?()` (Escape runs it instead of `onClose`), `presentation?: 'sheet' \| 'dialog' \| 'alert'`, `size?: 'sm' \| 'md' \| 'lg'`, `title?`, `description?`, `icon?`, `leading?` / `trailing?` (header actions), `actions?` (footer), `grabber?`, `dismissible?`, `modal?` (false: static, in place) |
| `Alert` | `open`, `title`, `message?`, `icon?`, `actions: { label; role?: 'default' \| 'cancel' \| 'destructive'; onSelect? }[]`, `onClose()` |
| `ToastProvider`, `useToast()` | Provider: `placement?: 'top' \| 'bottom'`, `offset?`, `limit?`. Hook: `show({ id?, title, description?, tone?, icon?, duration?, action? }) => id`, `dismiss(id)`, `clear()` |
| `Toast` | Presentational: `title`, `description?`, `tone?: 'neutral' \| 'success' \| 'warning' \| 'danger' \| 'info'`, `icon?`, `action?`, `onDismiss?` |
| `Tooltip` | `label`, `shortcut?`, `placement?`, `delay?`, `disabled?`, `describes?`, `children` (one element) |

`MenuEntry` = `{ id, label, icon?, shortcut?, description?, destructive?, disabled?, checked?, onSelect? }`
| `{ type: 'separator' }` | `{ type: 'label', label }`. `Placement` = `'top' | 'bottom' | 'left' | 'right'`
optionally with `-start | -center | -end`.

Mark the control that should get the focus when a sheet or popover opens with `data-autofocus`.

### Status

| Component | Props |
| --- | --- |
| `ProgressView` | `variant?: 'linear' \| 'circular'`, `value?` (0..1; omit = indeterminate), `size?`, `label?`, `tone?: 'tint' \| 'current'` |
| `Spinner` | `size?` (px) |
| `Badge` | `tone?: 'neutral' \| 'tint' \| 'success' \| 'warning' \| 'danger'`, `variant?: 'soft' \| 'solid' \| 'outline'`, `icon?`, `dot?` |

### Structure

| Component | Props |
| --- | --- |
| `Tabs<T>` | `tabs: { id: T; label; icon?; badge?; disabled? }[]`, `value?`, `defaultValue?`, `onChange?(id)`, `size?: 'sm' \| 'md'`, `trailing?`, `children?: (id) => panel`, `idBase?`; `tabPanelProps(idBase, id)` for a panel rendered elsewhere |
| `List` | `variant?: 'inset' \| 'sidebar' \| 'plain'`, `size?: 'sm' \| 'md'` |
| `ListSection` | `header?`, `headerTrailing?`, `footer?` |
| `ListRow` | `title`, `subtitle?`, `icon?`, `iconColor?`, `leading?`, `trailing?: node \| ((labelId) => node)`, `disclosure?`, `onSelect?(event)`, `selected?`, `disabled?`, `destructive?`, `level?` (tree indent), `expanded?` + `onExpandedChange?` |
| `Sidebar`, `Inspector`, `Drawer` | `title?`, `subtitle?`, `icon?`, `actions?`, `header?`, `footer?`, `floating?` (default true: glass; false: docked), `padded?`, `aria-label` |
| `InspectorSection` | `title`, `trailing?`, `collapsible?`, `open?`, `defaultOpen?`, `onOpenChange?` |
| `InspectorRow` | `label`, `value?`, `layout?: 'inline' \| 'stack'`, `children: node \| ((labelId) => node)` |
| `Toolbar` | `size?: 'md' \| 'lg'`, `orientation?`, `aria-label` |
| `ToolbarGroup` | `glass?` (default true), `aria-label` |
| `ToolbarSpacer`, `ToolbarSeparator`, `ToolbarTitle` | `size?` (fixed gap); (none); `title`, `subtitle?` |
| `SplitView` | `panes: SplitPane[]`, `children` (main area), `floating?`, `gap?`, `state?: DockState`, `onStateChange?`, `defaultCollapsed?: string[]` |
| `EmptyState` | `icon?`, `title`, `description?`, `actions?`, `size?: 'sm' \| 'md'` |
| `Checkerboard` | `cell?` (px, default 8) |

`SplitPane` = `{ id, edge: 'leading' | 'trailing' | 'top' | 'bottom', size, min, max, collapsible?,
maxFraction?, content, label, dividerLabel?, resizable?, passthrough? }`. Panes claim their edge in
array order. `DockState` = `{ sizes: Record<id, number>, collapsed: Record<id, boolean> }`; helpers
`initialDockState(panes, collapsedIds?)`, `toggleDock(state, id, collapsed?)` and
`layoutDock(panes, state, size, { floating, gap })` (the same layout the view computes: pane rectangles
and the `safe` insets, for code that needs them outside CSS). In floating mode
the root publishes `--r2-safe-top | -right | -bottom | -left` (px covered by chrome on each side).

### Icons

```tsx
<Icon name="sparkles" />            // 18 px, decorative (aria-hidden)
<Icon name="warning" size={16} title="Warning" />   // labelled
```

`IconName` is the union of the 117 names; `ICON_NAMES` lists them; `isIconName(text)` narrows.
Sizes: 16 in dense rows, 18 default, 20 in toolbars. The stroke is 2 grid units below 20 px and 1.75
from 20 px. Every name of the legacy set (`editor/src/ui/icons.tsx`) exists with the same meaning.

Drawing a new glyph: 24 x 24 grid, live area 3..21, round caps and joins, one stroke weight, corners
of containers rounded by 1.5 to 2.5 units, solid shapes only for transport glyphs and small dots,
optically centred. Add it to `GLYPHS` in `icons.tsx` (helpers `ring`, `dot`, `rrect`, `star4`) and
check it in the gallery at 16 and 24 px. Never trace a glyph from another icon set.

### Hooks and helpers

`useAppearance(initial?)`, `applyAppearance(appearance, root?)`, `readStoredAppearance()`,
`storeAppearance()`, `readColorToken(token, scope?)`, `parseComputedColor(text)`,
`resolveAppearance(pref, systemDark)`, `nextAppearance(a)`, `useFocusScope(ref, { active, trap?,
autoFocus?, restore? })`, `Layer` (portal that keeps the appearance scope) and `Floating` (anchored
surface) for new overlay components.

Languages: the components say a few words themselves (the clear button of a field, the default
search placeholder, "Expand" / "Collapse", "Resize <pane>"). They are English by default;
`setDesignStrings({ clear, dismiss, expand, collapse, search, select, inProgress, dragToChange,
notifications, resize })` replaces them (the editor's i18n layer calls it when the language changes).

## Keyboard

| Component | Keys |
| --- | --- |
| `SegmentedControl`, `Tabs` | Tab to the selection; Left / Right move and select; Home / End |
| `Switch` | Space / Enter toggle; Left = off, Right = on |
| `Slider` | Arrows = one step; Shift + arrows, PageUp / PageDown = ten steps; Home / End |
| `NumberField` | Up / Down step (Shift x10, Alt x0.1); Enter commits; Escape restores |
| `Menu`, `Select`, `ContextMenu` | Enter / Space / Down open; Up / Down, Home / End, type-ahead; Enter chooses; Escape or Tab closes; the context-menu key or Shift+F10 opens a context menu |
| `Popover`, `Sheet`, `Alert` | Focus moves in and is trapped; Escape closes; Enter confirms a sheet (`onConfirm`); focus returns to the opener |
| `List` | Up / Down between rows; Right / Left expand and collapse a tree row |
| `Toolbar` | Left / Right between controls; Home / End |
| `SplitView` divider | Arrows resize (Shift = larger steps); Home / End = minimum / maximum; Enter collapses or expands; double-click restores the default size |

## Adding a component

1. Pure logic (value math, key maps, layout) goes to `logic/<name>.ts` with tests in
   `test/editor-design.test.ts`.
2. `components/<Name>.tsx` + `components/<name>.css` (classes `r2-<name>...`, variants as
   `data-*` attributes, private custom properties `--_x`), exported from `index.ts`.
3. States for both appearances, `:focus-visible`, `:disabled`, `forced-colors`, touch size.
4. A specimen in `gallery/Specimens.tsx` and, for interactive behaviour, a case in
   `test/editor-design-e2e.test.ts`.
