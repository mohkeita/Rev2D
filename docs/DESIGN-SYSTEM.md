# Rev2D design system

The Rev2D app (the web editor and every screen around it) follows the design sensibility of iOS and
iPadOS: the canvas comes first, controls float above it on translucent rounded surfaces, shapes
nest concentrically, there is one tint colour, and everything has a light and a dark appearance.

This document records the research behind that direction, states the principles in Rev2D's own
words, and describes the system that implements them:

- tokens, base styles, components and icons: [`editor/src/design/`](../editor/src/design/README.md)
  (the README there is the API reference);
- a live gallery of every token and component plus a mock of the editor:
  `editor/gallery.html` (`npm run editor:dev`, then `http://127.0.0.1:5173/gallery.html`; or
  `npm run editor:build` and open `dist/editor/gallery.html` through any static server).

Rev2D is not an Apple product and ships no Apple assets: no San Francisco font files, no SF Symbols,
no Apple artwork. Fonts come from the system font stack, and the icon set is drawn for this project
(see [Assets and legal limits](#8-assets-and-legal-limits)).

Contents: [1. Research](#1-research) · [2. Principles](#2-principles) · [3. Do and don't](#3-do-and-dont) ·
[4. Tokens](#4-tokens) · [5. Components](#5-components) · [6. The editor layout](#6-the-editor-layout) ·
[7. Accessibility](#7-accessibility) · [8. Assets and legal limits](#8-assets-and-legal-limits) ·
[9. Gallery and tests](#9-gallery-and-tests) · [10. Sources](#10-sources)

---

## 1. Research

Sources were read in October 2026; numbers in brackets refer to [10. Sources](#10-sources). Text in
quotation marks is quoted from the cited page.

### 1.1 Apple Human Interface Guidelines: foundations

**Materials** [1]. A material "establishes visual hierarchy to help people retain a sense of place".
The HIG now distinguishes two kinds. *Liquid Glass* "forms a distinct functional layer for controls
and navigation elements" that floats above the content layer; *standard materials* (ultra-thin,
thin, regular, thick) give structure *inside* the content layer. Two rules shaped this system
directly: "Don't use Liquid Glass in the content layer", and "Use Liquid Glass effects sparingly ...
Limit these effects to the most important functional elements in your app". Thicker materials "can
provide better contrast for text and other elements with fine features"; thinner ones "help people
retain their context". Text on a material uses the vibrant label levels, and the lowest level is not
used on thin materials.

**Colour** [2]. System colours are semantic (label, secondary / tertiary / quaternary label, fills,
separators, plain and grouped backgrounds), each defined for light, dark and increased contrast;
"Avoid redefining the semantic meanings of dynamic system colors". On glass: "Apply color sparingly
to the Liquid Glass material ... reserve it for elements that truly benefit from emphasis, such as
status indicators or primary actions", and "To emphasize primary actions, apply color to the
background rather than to symbols or text". Colour is never the only carrier of information. The
page lists the system palette for light and dark (for example blue 0, 136, 255 and 0, 145, 255);
Rev2D's palette tokens use those values.

**Typography** [3]. The system font is used through *text styles* (Large Title, Title 1 to 3,
Headline, Body, Callout, Subhead, Footnote, Caption) that pair a size, a weight and a leading. The
default body size is 17 pt on iOS / iPadOS and 13 pt on macOS; the minimums are 11 pt and 10 pt.
"In general, avoid light font weights." Hierarchy comes from "font weight, size, and color", with as
few typefaces as possible.

**Layout** [4]. "Group related items" with "negative space, container shapes, or separator lines";
"extend [full-screen background content] underneath sidebars, toolbars, and tab bars"; instead of
"a solid or semi-opaque background color beneath controls", elevate controls with the glass material
and a scroll edge effect. Layouts adapt to the space available, not to the device.

**Motion** [5]. "Add motion purposefully, supporting the experience without overshadowing it."
Feedback animation is brief and precise, follows gestures, can be interrupted ("don't make people
wait for an animation to complete"), and is optional: nothing is communicated by motion alone.

**Icons** [6]. Interface icons are simplified ("a simple, universal design that most people will
recognize quickly") and consistent in size, level of detail, stroke weight and perspective. They are
optically (not geometrically) centred, matched in weight to the adjacent text, drawn as vectors, and
always given an alternative text label.

**Accessibility** [7]. Controls measure 44 x 44 pt by default on iOS / iPadOS (28 x 28 pt minimum)
and 28 x 28 pt on macOS (20 x 20 pt minimum), with about 12 pt of padding around bezelled elements.
Text contrast follows WCAG AA: 4.5:1 up to 17 pt, 3:1 for 18 pt and larger or bold text. With Reduce
Motion, apps tighten springs, replace transitions with fades and avoid animating into and out of
blurs. Everything is reachable from the keyboard.

### 1.2 Apple Human Interface Guidelines: components

| Component | What the HIG asks for | Source |
| --- | --- | --- |
| Toolbars | Three areas (leading: navigation and title; centre: common controls; trailing: important items, inspector buttons, search). "Group toolbar items logically by function and frequency of use", "aim for a maximum of three" groups, prefer symbols to text, keep text buttons apart, one `prominent` (tinted) primary action on the trailing side, and "Reduce the use of toolbar backgrounds and tinted controls". | [8] |
| Sidebars | Navigation on the leading side that "can float above content in the Liquid Glass layer"; "Extend visually rich content beneath the sidebar"; at most two levels of hierarchy; let people hide it, but do not hide it by default. | [9] |
| Split views | Panes for navigation, content and detail; "persistently highlight the current selection in each pane"; reasonable minimum and maximum pane sizes; "Prefer the thin divider style"; "Consider letting people hide a pane" and "Provide multiple ways to reveal hidden panes". | [10] |
| Sheets | "A sheet helps people perform a scoped task that's closely related to their current context." Resizable sheets show a grabber; Cancel sits on the leading edge of the header and Done on the trailing edge; swipe to dismiss; "Display only one sheet at a time"; on iPadOS prefer the centred page / form sheet styles. | [11] |
| Popovers | "A transient view that appears above other content"; it points to the element that revealed it, closes on a press outside, saves work when it closes, and "Show one popover at a time". Not for compact widths. | [12] |
| Menus | Verb labels in title-style capitalization, an ellipsis when more input follows, important items first, separators between groups, icons "for all menu items in a group, or none of them", checkmarks for attributes in effect, unavailable items dimmed rather than hidden, submenus "sparingly" and one level deep. | [13] |
| Segmented controls | "Closely related choices that affect an object, state, or view"; "no more than about five to seven segments"; equal segment widths; "either text or images — not a mix of both". | [14] |
| Sliders | A track and a thumb between a minimum and a maximum; minimum on the leading side; "Consider supplementing a slider with a corresponding text field and stepper"; tick marks on macOS; live feedback. | [15] |
| Toggles | Two opposing states that take effect immediately; on iOS a switch belongs in a list row, whose text is its label; keep the default green, or use the accent colour "only if necessary". | [16] |
| Lists and tables | Plain, grouped and inset grouped styles; succinct row text; a disclosure indicator for rows that lead somewhere; persistent highlight of the selection in navigation lists; headers in title-style capitalization. | [17] |
| Text fields | A separate label besides the placeholder (which disappears); a Clear button at the trailing end; a field sized for the expected input; leading image for purpose, trailing for extra features. | [18] |
| Progress indicators | "When possible, use a determinate progress indicator"; "Keep progress indicators moving"; a consistent place; a description that is more than "loading"; a way to cancel. | [19] |
| Buttons | Style, not size, marks the preferred action; "Keep the number of prominent buttons to one or two per view"; never give a destructive action the primary role; "Always include a press state"; a 44 x 44 pt hit region. | [20] |

### 1.3 The iOS / iPadOS 26 design language: Liquid Glass

*What it is.* Apple describes Liquid Glass as a "translucent material [that] reflects and refracts
its surroundings, while dynamically transforming to help bring greater focus to content" [23]. In
the design session it is "a new digital meta-material that dynamically bends and shapes light": its
defining traits are *lensing* (it bends light instead of scattering it), specular highlights that
follow the geometry, shadows that adapt to what is underneath, and "materialization" instead of
fading in and out [21].

*How controls float.* "Liquid Glass defines a new functional layer in the UI, floating above your
content to bring structure and clarity, without ever stealing focus" [22]. Toolbar items sit on
shared glass capsules, grouped "by function and frequency"; symbols and text buttons do not share
a capsule; the primary action "stays separate and appears tinted". Sidebars "are now inset and
built with Liquid Glass, allowing content to flow behind them". Menus and action sheets spring from
the control that opened them. Scroll edge effects replace hard dividers where content passes under
controls [21] [22]. "Hierarchy should be expressed through layout and grouping", not decoration:
existing custom bar backgrounds and borders are to be removed [22] [24].

*Concentric corner radii.* Three kinds of shape: "Fixed shapes have a constant corner radius.
Capsules use a radius that's half the height of the container. Concentric shapes calculate their
radius by subtracting padding from the parent's." Capsules "bring focus and clarity to touch-friendly
layouts, but in dense desktop environments, they're best used for standout actions"; on macOS,
mini, small and medium controls stay rounded rectangles and large controls become capsules [22].

*When not to use glass.* "It is best reserved for the navigation layer that floats above the
content of your app"; a table view made of glass would "compete with other elements and muddy the
hierarchy". "Always avoid glass on glass ... use fills, transparency, and vibrancy for the top
elements". "Avoid tinting all your elements. When every element is tinted, nothing stands out." The
*clear* variant is only for media-rich backgrounds and needs a dimming layer; *regular* is the
default and the one for text-heavy surfaces such as "alerts, sidebars, or popovers" [1] [21].

*Accessibility settings that tone it down.* "Reduced Transparency makes Liquid Glass frostier and
obscures more of the content behind it. Increased contrast makes elements predominantly black or
white and highlights them with a contrasting border. Reduced Motion decreases the intensity of some
effects and disables any elastic properties" [21]. Apps are asked to test custom elements with these
settings [24].

*Other changes that matter here.* Lists, tables and forms got "a larger row height and padding";
section headers are written in title-style capitalization instead of all caps; typography is
"bolder and left-aligned ... in key moments like alerts"; sheets are inset from the window edge with
a larger corner radius [22] [24].

### 1.4 Pro creative apps on iPadOS

Rev2D's editor is a canvas with a parts list, an inspector and a timeline. These apps solve the same
layout on a touch screen:

- **Procreate Dreams** [25] [26] [27]. The Stage (the viewport of the movie, also where content is
  moved and scaled directly) takes the top of the screen and the Timeline the bottom; the split
  between them is dragged ("Tap and hold just above the Ruler and drag up and down to change the
  ratio of your Timeline → Stage area"). The Timeline is a ruler, a playhead and tracks; the playhead
  is a handle that changes shape with the mode; a Create (+) menu adds content; multi-selection is
  drawn around items. *Borrowed:* the stage / timeline split with a draggable boundary, a ruler with
  a large playhead head, tracks as rounded lanes, direct manipulation on the stage.
- **Final Cut Pro for iPad** [28]. The viewer is at the top, the Magnetic Timeline at the bottom,
  the browser in a corner, and the inspector opens beside the viewer when Inspect is tapped; sections
  can be shown, hidden and resized to focus on one task. *Borrowed:* the inspector as a panel that is
  summoned and dismissed by a toolbar button, hideable sections, a timeline that spans the full width.
- **Logic Pro for iPad** [29]. A control bar with transport and position runs along the top; a view
  control bar holds buttons that show and hide the Browser, inspector, Fader, editors and Mixer;
  areas are resized by dragging their borders. *Borrowed:* one consistent place with toggle buttons
  for every panel, transport controls as a compact group with the time display next to them.
- **Keynote and Freeform** [30] [31]. Keynote for iPad keeps a slide navigator on the leading side
  and opens formatting and layout controls from toolbar buttons; in Freeform a selected item is moved
  by dragging and resized "by dragging a blue dot". *Borrowed:* large round selection handles in the
  tint colour on the canvas, and formatting controls that appear near the toolbar button rather than
  in permanent chrome.

Patterns adopted from all four: floating toolbars over a full-bleed canvas; a timeline drawer at the
bottom that can be resized and hidden; an inspector as a trailing panel (or a popover for small
sets of options); a parts sidebar on the leading side; large direct-manipulation handles.

### 1.5 Web techniques for these materials

- **`backdrop-filter`** [32] blurs and adjusts what is behind an element (`blur()`, `saturate()`,
  `brightness()` ...); the element's own background must be partly transparent. It is Baseline since
  2024; Safari before 18 needs the `-webkit-` prefix. An ancestor with `opacity` below 1, `filter`,
  `mask` or `clip-path` becomes a *backdrop root*: the blur then only sees content inside that
  ancestor, so floating chrome must not sit inside such an element.
- **Layered highlights and hairlines.** One blur does not look like glass; a rim does. This system
  layers a gradient plate, the backdrop filter, a 1 px gradient stroke that is brightest where the
  light comes from (a masked `::before`), a hairline and a soft shadow. Extending the blurred area
  beyond the element and adding an edge highlight are described in [35].
- **Performance over a WebGL canvas.** "Backdrop filters trigger GPU-accelerated compositing but can
  impact performance on mobile devices", and the advice is to limit how many elements use them at
  once [36]. The blur has to be recomputed whenever what is behind the element changes, and the
  editor's canvas repaints on every frame while an animation plays. Measured while building this
  system: with Chrome's software rasterizer (no GPU), the first frame of a glass menu in the gallery
  took about 350 ms. Hence: glass only on chrome that is small (toolbar capsules) or that sits mostly
  over the flat workspace (panels); blur radii of 18 to 30 px; the radius is never animated; no glass
  inside glass; and one switch (`data-materials="solid"`) that turns every material solid.
- **Fallbacks.** `prefers-reduced-transparency` [33] (still experimental in browsers, so it is
  mirrored by a root attribute), `prefers-contrast`, `prefers-reduced-motion`, `@supports` for
  browsers without `backdrop-filter`, and `forced-colors` [34], where `box-shadow` and
  `background-image` are dropped by the browser and borders in system colours must take over.

---

## 2. Principles

1. **The canvas comes first.** The model is the content; the interface is a thin layer above it.
   The canvas is full-bleed and keeps the largest share of the window at every size. Chrome is
   neutral in colour so that the artwork carries the colour on screen.
2. **Controls float on translucent surfaces.** Toolbars, panels, menus and sheets are glass: a
   translucent plate with a rim highlight, a hairline and a soft shadow, inset from the window edge.
   The canvas continues underneath; the uncovered part is reported to the canvas so the model stays
   centred in it.
3. **One layer of glass.** Glass is for the controls layer only. What sits on glass (rows, groups,
   fields, buttons) uses translucent fills and plates, never another glass. Inside the content layer
   (cards on a page, wells) the standard materials or opaque backgrounds are used.
4. **Shapes are concentric.** A shape inside another shape has the outer radius minus the padding
   between them: a row in a group, a group in a panel, a button in a toolbar capsule. Small controls
   are rounded rectangles, prominent and floating ones are capsules.
5. **Content is grouped, not boxed.** Related rows share one inset plate with hairlines that start
   at the text; sections have a short title in title-style capitalization. Spacing and plates carry
   the structure; borders are for the increased-contrast and forced-colours modes.
6. **One tint.** System blue marks what is interactive-and-current: the primary action, the
   selection, the value of a slider, the focus ring. At most one filled tint button per view.
   Semantic colours (green, orange, red) mean success, warning and danger and nothing else; rig item
   kinds have one system colour each, used for small glyphs only.
7. **A clear type hierarchy.** System fonts, eleven text styles named after the iOS styles and sized
   for a dense desktop tool. Weight and colour level, not size alone, separate title, value and
   secondary text. Numbers that change in place use tabular figures.
8. **Motion is physical and brief.** State changes use springs: smooth for surfaces, snappy for
   controls. Surfaces grow out of the control that opened them and go back to it. Nothing blocks
   input while it animates, and nothing is said by motion alone.
9. **Light and dark are equals.** Every colour is defined for both; the app follows the system
   unless the person chooses. A nested region can have its own appearance.
10. **Accessible by construction.** Every control works from the keyboard with a visible focus ring,
    has a name, meets AA contrast in both appearances, and keeps a 44 px target on touch screens.
    Reduce Transparency, Increase Contrast, Reduce Motion and forced colours each have a defined
    result, not a best effort.

## 3. Do and don't

| Do | Don't |
| --- | --- |
| Let the canvas run under the chrome; read `--r2-safe-*` to centre the model in the free area. | Give the editor a solid frame of docked, opaque bars around a boxed-in canvas. |
| Group toolbar buttons in glass capsules by function; at most three groups and one tinted action. | Put a background behind the whole toolbar, or mix icon buttons and text buttons in one capsule. |
| Use `.r2-glass` / `.r2-glass-panel` for floating chrome only. | Put glass on rows, cards or anything that sits on glass ("glass on glass"). |
| Use fills (`--r2-fill-*`) and the plate (`--r2-plate`) for controls and groups on any surface. | Use opaque greys from the palette as control backgrounds on a material. |
| Derive inner radii from the container (`--r2-radius-concentric`). | Pick radii per component by eye, or use one radius for everything. |
| Keep one filled tint button per view; step down with tinted, gray and plain. | Tint several controls, or use the tint as decoration. |
| Use `--r2-danger` for destructive actions and keep them out of the default position. | Make Delete the Enter-key action of a dialog. |
| Label every icon-only control (`IconButton` requires `label`). | Rely on an icon, a colour or an animation alone to say something. |
| Write labels in title-style capitalization: "Add Keyframe", "Save As…". | Use ALL CAPS section headers or sentence fragments such as "loading". |
| Use text tokens (`--r2-text-*`) and label levels. | Set font sizes and greys ad hoc; use weights lighter than regular. |
| Animate with the spring tokens and let reduced motion turn them into fades. | Animate blur radii, or make people wait for an animation before they can act. |
| Pair a slider with its value (and a NumberField for exact input). | Show a slider whose value can only be guessed. |
| Test both appearances, Korean and Japanese text, and the three accessibility switches. | Design in dark mode only. |

---

## 4. Tokens

All tokens are CSS custom properties in [`editor/src/design/tokens.css`](../editor/src/design/tokens.css),
named `--r2-<group>[-<level or role>]`. Classes of the system start with `r2-`. Nothing collides with
the legacy editor variables.

### 4.1 Appearance

`data-appearance="light" | "dark" | "auto"` on the root element (or on any subtree) selects the
appearance; `auto`, and no attribute at all, follow `prefers-color-scheme`. Colours are written once
with `light-dark(light, dark)` and the attribute only switches `color-scheme`, so there is no second
"dark" block that could drift. This needs browsers with `light-dark()` (Chrome and Edge 123, Firefox
120, Safari 17.5); the Vite build keeps it unlowered (`build.cssTarget`), because the lowered form
resolves on the root element and breaks nested appearance scopes.

Code that paints outside CSS (the WebGL clear colour, canvas overlays) reads resolved colours with
`readColorToken('--r2-canvas')`.

### 4.2 Colour

| Group | Tokens | Use |
| --- | --- | --- |
| Labels | `--r2-label`, `-2`, `-3`, `-4`, `--r2-placeholder` | Text and glyphs: primary, secondary, tertiary (placeholders, disabled glyphs), quaternary (decoration). `-2` keeps 4.5:1 on the base backgrounds. |
| Fills | `--r2-fill`, `-2`, `-3`, `-4`, `--r2-fill-raised` | Translucent control backgrounds, from strongest to faintest; `raised` is the lighter plate for groups on a material. |
| Separators | `--r2-separator`, `-strong`, `-opaque` | Hairlines. |
| Backgrounds | `--r2-bg`, `-2`, `-3`, `--r2-bg-grouped`, `-2`, `-3`, `--r2-bg-elevated` | Opaque page and card backgrounds (plain set and grouped set). |
| Tint | `--r2-tint`, `--r2-tint-solid` (`-hover`, `-pressed`), `--r2-on-tint`, `--r2-tint-fill` (`-hover`, `-pressed`), `--r2-selection`, `--r2-focus-color` | `tint` for text and glyphs, `tint-solid` behind a white label, `tint-fill` for tinted plates. |
| Palette | `--r2-red` ... `--r2-brown`, `--r2-gray`, `--r2-gray-2` ... `-6` | The system palette. Vivid: for fills, glyphs and dots, not for small text. |
| Semantic | `--r2-success`, `--r2-warning`, `--r2-danger`, `--r2-info`, each with `-text` and `-fill`; `--r2-danger-solid` | `-text` passes 4.5:1 as small text; `-fill` is the tinted plate of badges. |
| Rig kinds | `--r2-kind-part`, `-bone`, `-warp`, `-parameter`, `-animation`, `-binding`, `-ik`, `-physics`, `-texture` | The glyph colour of each kind of rig item. |
| Canvas | `--r2-canvas`, `--r2-canvas-glow`, `--r2-canvas-check-a`, `-b`, `--r2-canvas-grid`, `--r2-canvas-guide`, `--r2-scrim` | The workspace behind the model, the transparency checkerboard, the dimming layer behind sheets. |

The tint is system blue at the depth Apple uses on its own web pages (`#0071e3` behind white labels,
a slightly deeper blue for text on light backgrounds), because the brighter app blue does not reach
4.5:1 with 13 px text. The contrast pairs are asserted in `test/editor-design.test.ts`.

### 4.3 Materials and glass

| Class | Recipe | Use |
| --- | --- | --- |
| `.r2-material-ultrathin`, `-thin`, `-regular`, `-thick` | Translucent plate (40 % to 86 % opaque) + `blur(10 – 28px) saturate(160 – 180%)` | Content-layer surfaces: tooltips, value bubbles, docked panels, overlays on images. |
| `.r2-glass` | Gradient plate (56 – 74 % opaque) + `blur(18px) saturate(190%)` + rim highlight + hairline + soft shadow | Compact controls that float: toolbar groups, floating buttons. |
| `.r2-glass-panel` | The same with a more opaque plate (80 – 86 %), `blur(30px)` and a deeper shadow | Text-heavy floating surfaces: sidebar, inspector, timeline drawer, menus, popovers, sheets, toasts. |
| `.r2-glass-clear` | A nearly clear plate with a light blur | Controls over photos or video only, on a dimmed backdrop. |

Every plate has a solid fallback (`--r2-material-*-solid`, `--r2-glass-solid`,
`--r2-glass-panel-solid`). The fallbacks take over, and the filters become `none`, when the person
asks for reduced transparency (`prefers-reduced-transparency: reduce`), when the app sets
`data-transparency="reduce"` or `data-materials="solid"` on the root (a performance switch for weak
GPUs), and in browsers without `backdrop-filter`. Grouped content reads its plate from `--r2-plate`,
which is a white card on page backgrounds and a translucent lighter plate on materials.

### 4.4 Shape

Fixed radii `--r2-radius-2xs` (4) `xs` (6) `sm` (8) `md` (10) `lg` (14) `xl` (18) `2xl` (22) `3xl`
(28) and `--r2-radius-capsule`; roles `--r2-radius-control-sm` / `-control` / `-control-lg` (6 / 8 /
10), `--r2-radius-group` (14), `--r2-radius-menu` (14), `--r2-radius-popover` (18),
`--r2-radius-panel` (22), `--r2-radius-sheet` (28). Containers publish `--r2-radius-concentric`
(their radius minus their padding) and nested groups use it: a group inside a panel gets 22 − 8 = 14.

### 4.5 Type

System fonts only: `--r2-font` (`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable
Text", "Segoe UI", "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", "Malgun Gothic", "Hiragino
Sans", "Yu Gothic UI", sans-serif`), `--r2-font-display` for titles and `--r2-font-mono`. Korean text
breaks between words (`word-break: keep-all` under `:lang(ko)`).

The names are the iOS text styles; the sizes are those of the macOS column of the HIG type table,
with slightly more leading for Korean and Japanese, because the editor is a dense, pointer-driven
tool. Use them as `font: var(--r2-text-body)` or with the classes `.r2-text-body` ...

| Token | iOS text style (size at "Large") | Rev2D size / leading, weight |
| --- | --- | --- |
| `--r2-text-large-title` | Large Title (34 / 41) | 26 / 32 bold |
| `--r2-text-title-1` | Title 1 (28 / 34) | 22 / 28 bold |
| `--r2-text-title-2` | Title 2 (22 / 28) | 17 / 22 semibold |
| `--r2-text-title-3` | Title 3 (20 / 25) | 15 / 20 semibold |
| `--r2-text-headline` | Headline (17 / 22 semibold) | 13 / 18 semibold |
| `--r2-text-body` | Body (17 / 22) | 13 / 18 regular |
| `--r2-text-callout` | Callout (16 / 21) | 12 / 16 regular |
| `--r2-text-subhead` | Subhead (15 / 20), emphasized | 12 / 16 semibold |
| `--r2-text-footnote` | Footnote (13 / 18) | 11 / 14 regular |
| `--r2-text-caption` | Caption 2 (11 / 13) | 10 / 13 medium |
| `--r2-text-mono`, `-mono-small` | (monospaced digits, ids, code) | 12 / 16, 11 / 14 |

### 4.6 Space, size, elevation, motion, focus, layers

- **Spacing**: a 4 pt grid, `--r2-space-1` (4) `2` (8) `3` (12) `4` (16) `5` (20) `6` (24) `8` (32)
  `10` (40) `12` (48) `16` (64), plus half steps `0-5` (2) and `1-5` (6) for optical corrections.
- **Control sizes**: `--r2-control-sm` / `md` / `lg` / `xl` = 24 / 28 / 36 / 44 px with a pointer;
  32 / 36 / 44 / 50 on touch screens (`pointer: coarse`), where every control also keeps an
  invisible 44 px target (`.r2-hit`). `--r2-row-height` 32 (44 on touch), `--r2-toolbar-height` 44
  (52), `--r2-panel-inset` 12, `--r2-hairline` 1 px (0.5 px on high-density screens).
- **Elevation**: `--r2-shadow-1` knobs, `-2` cards, `-3` menus and popovers, `-4` sheets;
  `--r2-glass-shadow` and `--r2-glass-panel-shadow` include the hairline.
- **Motion**: durations `--r2-duration-instant` (90 ms) `fast` (160) `base` (260) `slow` (420)
  `slower` (600); easings `--r2-ease-out`, `-in`, `-in-out`, `-standard`; springs
  `--r2-spring-smooth` (no overshoot), `-snappy` (about 4 %), `-bouncy` (about 10 %) as `linear()`
  curves sampled from a damped spring (`logic/spring.ts` generates them and a test keeps the tokens
  in step); `--r2-motion-distance`, `--r2-motion-scale`, `--r2-press-scale` for entering and pressed
  states. Under reduced motion the springs become `ease-out`, travel and scale go to zero and the
  durations shorten.
- **Focus**: `--r2-focus-color`, `--r2-focus-width` (2 px, 3 with increased contrast),
  `--r2-focus-offset` (2 px): a tint outline around the focused control.
- **Layers**: `--r2-z-raised` 10, `--r2-z-chrome` 100 (floating panels), `--r2-z-overlay` 400
  (sheets, popovers and menus share one level and stack in the order they open), `--r2-z-toast` 600,
  `--r2-z-tooltip` 700.

---

## 5. Components

React 19 components without dependencies, in `editor/src/design/components/`; one small CSS file
each. Props and import paths are in the [README](../editor/src/design/README.md). The rules:

| Component | Rule of use |
| --- | --- |
| `Button` | `filled` once per view for the primary action; `tinted`, `gray`, `plain` step down; `glass` for a lone control over the canvas; `destructive` recolours any of them. Small and medium are rounded rectangles, large and extra large capsules. |
| `IconButton` | Always has a `label` (accessible name and tooltip). `pressed` makes it a toggle shown in the tint. |
| `SegmentedControl` | Two to seven related choices, equal widths, text or icons. A radio group for the keyboard. |
| `Switch` | An immediate on / off setting, green when on. In a row, the row title labels it. |
| `Slider` | Capsule track and knob. `origin` fills from a neutral value, `ticks` marks values, the value bubble shows while dragging, double-click returns to `resetValue`. Show the value next to it. |
| `Stepper`, `NumberField` | Exact numbers: arrow keys step (Shift x10, Alt x0.1), the prefix scrubs, Enter commits, Escape restores. |
| `TextField`, `SearchField` | Filled fields with a label above or beside; the tint ring marks focus; errors are text under the field, not colour alone. |
| `Select`, `Menu`, `ContextMenu` | One-level menus on glass that grow out of their control; checkmarks for attributes, red for destructive items, shortcuts at the trailing edge. |
| `Popover` | A small transient panel for the options of one control. One at a time, never nested. |
| `Sheet`, `Alert` | A sheet is one scoped task: bottom card with a grabber, centred dialog, or alert. Focus is trapped and returned; Escape cancels; a destructive action is never the default. |
| `Toast` | A status in a glass capsule with at most one action; errors stay until dismissed. |
| `ProgressView`, `Spinner` | Determinate when the amount of work is known; the label says what is happening. |
| `Badge` | A count or status with text; colour is secondary. |
| `Tooltip` | The name of a control and its shortcut, after a hover delay or on keyboard focus. |
| `Tabs` | A few views sharing one area (the panels of a drawer). |
| `List`, `ListSection`, `ListRow` | Inset grouped rows (settings, forms), sidebar rows (outliners, trees), plain rows. Leading icon, title, subtitle, trailing accessory, disclosure. |
| `Sidebar`, `Inspector`, `Drawer`, `InspectorSection`, `InspectorRow` | Panel shells: glass when floating, a thick material with a hairline when docked. |
| `Toolbar`, `ToolbarGroup`, `ToolbarSpacer`, `ToolbarSeparator`, `ToolbarTitle` | Glass capsule groups; the bar itself has no background and lets presses through between groups. |
| `SplitView` | A main area with resizable, collapsible panes on its edges; `floating` overlays them on a full-bleed main area and publishes `--r2-safe-*`. |
| `EmptyState`, `Checkerboard` | What an empty area says and offers; the transparency backdrop of a canvas or an image well. |

Icons: `Icon` with 117 original glyphs on a 24 px grid (`editor/src/design/icons.tsx`).

---

## 6. The editor layout

The gallery's editor mock (`gallery.html#mock`) is the reference for restyling the real editor:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ (sidebar ▸ document ▾)        (tools | overlays)        (undo redo) (… ) [Save] │  floating glass groups
│ ┌─────────────┐                                              ┌───────────────┐ │
│ │ Parts       │                                              │ Inspector     │ │
│ │ (segmented) │              full-bleed canvas               │  Pose         │ │
│ │ (search)    │         model centred in the free area       │  Appearance   │ │
│ │ outline     │                                   (zoom)     │  Bindings     │ │
│ └─────────────┘              (toast)                         └───────────────┘ │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ ⏮ ▶ ⟳  00:01.06 / 00:04.00  idle ▾                        30 fps  ◇  ⌄ │ │  timeline drawer
│ │ ruler · tracks · keyframes · playhead                                    │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

- `SplitView floating` with four panes: the toolbar (`top`, fixed, `passthrough`), the timeline
  (`bottom`, listed before the side panes so that it spans the full width), the parts sidebar
  (`leading`) and the inspector (`trailing`). The WebGL viewport is the main area and fills the
  window; its camera fits the model into the rectangle left by `--r2-safe-top / -right / -bottom /
  -left` (also available from the `SplitView` layout).
- Toolbar groups: document (sidebar toggle, file menu with the model name), tools and overlays in
  the centre, history, panels (AI, export, inspector toggle), and one filled capsule for the primary
  action. Panel toggles use `aria-expanded`, tools use `pressed`.
- The sidebar is a `Sidebar` with a `SegmentedControl` (Parts / Bones / Parameters), a `SearchField`
  and a `List variant="sidebar"` whose rows carry the kind colour and an eye toggle.
- The inspector is an `Inspector` with collapsible `InspectorSection`s; parameter rows are a label,
  the value and a `Slider` (`origin` and `resetValue` at the parameter default).
- The timeline is a `Drawer`: transport in a compact group, time display in tabular figures, the
  animation in a plain `Select`, then a ruler, track lanes and a playhead in the tint.
- Dialogs become `Sheet`s (`presentation="dialog"` for forms, `"alert"` for confirmations), the
  file menu a `Menu`, status messages `Toast`s, diagnostics a `Tabs` page of the drawer.
- The canvas backdrop is `--r2-canvas` with a faint glow at the centre; transparency inside the
  model's canvas is a `Checkerboard`; selection handles are white discs with a tint ring, at least
  14 px across (44 px hit area on touch).

At 1024 x 700 the same layout holds: panes are capped by a share of the window (`maxFraction`) and
the model keeps the centre.

---

## 7. Accessibility

- **Keyboard.** Every control is reachable and operable: Tab moves between controls and composite
  widgets; inside them the arrow keys move (segmented controls, tabs, menus, lists, toolbars,
  sliders, split-view dividers). Sheets and popovers take the focus, keep Tab inside and return the
  focus to the control that opened them. Keys pressed inside an overlay never reach the editor's
  global shortcuts.
- **Focus.** A 2 px tint outline, offset by 2 px, on `:focus-visible`; highlighted rows in menus use
  the highlight itself.
- **Names and roles.** Native elements where they exist; otherwise ARIA roles (`radiogroup`,
  `switch`, `slider`, `menu`, `listbox`, `dialog`, `alertdialog`, `tablist`, `separator`,
  `progressbar`, `toolbar`). Icon-only controls require a label.
- **Contrast.** Primary and secondary text, tinted text, and white on the tint and on the danger
  colour reach 4.5:1 in both appearances (tested). Vivid palette colours are for glyphs and fills.
- **Targets.** 28 px controls with a pointer; on touch screens controls grow and keep a 44 px hit area.
- **Reduce Transparency** (`prefers-reduced-transparency`, `data-transparency="reduce"`): materials
  and glass become solid, backdrop filters are removed, hairlines get stronger.
- **Increase Contrast** (`prefers-contrast: more`, `data-contrast="more"`): stronger label levels,
  separators and fills, a deeper tint, a visible outline around glass, a 3 px focus ring.
- **Reduce Motion** (`prefers-reduced-motion`, `data-motion="reduce"`): springs become short fades,
  sheets and menus cross-fade instead of travelling, progress indicators pulse instead of sliding.
- **Forced colours** (Windows contrast themes): surfaces fall back to `Canvas` with `CanvasText`
  borders, selections use `Highlight`.
- **Language.** System fonts cover Korean and Japanese; Korean wraps between words; layouts must
  tolerate labels that are longer than the English ones.

## 8. Assets and legal limits

- No font files are shipped or loaded from a network. The font stack names system fonts only.
- No SF Symbols and no Apple artwork. The icon set is original work for this project, drawn as
  inline SVG on a 24 px grid (round caps and joins, 1.75 px strokes, 2 px below 20 px). Where a glyph
  expresses a common idea (a tray with an arrow for "save", a magnifier for "search"), it is a new
  drawing with its own geometry, not a trace.
- The names "iOS", "iPadOS", "Liquid Glass", "San Francisco" and "SF Symbols" refer to Apple's
  products and guidelines, which this system takes as a reference for its sensibility. The system
  colour values come from the public HIG colour table [2].
- The gallery's placeholder character is Rev2D's own `hana` example, rendered in the browser by the
  Rev2D core.

## 9. Gallery and tests

`editor/gallery.html` is a second page of the editor build. Its header switches between the editor
mock, the components, the tokens and the icons, and between the appearances; "Display options" adds
a light / dark comparison, a Korean interface and the three accessibility switches. Query parameters
set the same state for screenshots: `?appearance=dark&bare#mock`, `?sheet`, `?lang=ko`, `?compare`,
`?transparency=reduce`, `?contrast=more`, `?motion=reduce`.

- `test/editor-design.test.ts`: the pure logic of the primitives (number and slider math, keyboard
  maps, placement, dock layout, toast queue, springs), and the consistency of tokens, styles and
  icons (defined custom properties, contrast pairs, mirrored accessibility blocks, legacy icon names).
- `test/editor-design-e2e.test.ts`: the built gallery in headless Chrome: keyboard operation of the
  segmented control, switch, slider, menu and sheet (focus trap, Escape, focus return), appearance
  switching and nested scopes, the accessibility switches, Korean text, no page errors. It writes
  `out/design-*.png`.

---

## 10. Sources

Apple Human Interface Guidelines (developer.apple.com/design/human-interface-guidelines):

1. Materials: <https://developer.apple.com/design/human-interface-guidelines/materials>
2. Color: <https://developer.apple.com/design/human-interface-guidelines/color>
3. Typography: <https://developer.apple.com/design/human-interface-guidelines/typography>
4. Layout: <https://developer.apple.com/design/human-interface-guidelines/layout>
5. Motion: <https://developer.apple.com/design/human-interface-guidelines/motion>
6. Icons: <https://developer.apple.com/design/human-interface-guidelines/icons>
7. Accessibility: <https://developer.apple.com/design/human-interface-guidelines/accessibility>
8. Toolbars: <https://developer.apple.com/design/human-interface-guidelines/toolbars>
9. Sidebars: <https://developer.apple.com/design/human-interface-guidelines/sidebars>
10. Split views: <https://developer.apple.com/design/human-interface-guidelines/split-views>
11. Sheets: <https://developer.apple.com/design/human-interface-guidelines/sheets>
12. Popovers: <https://developer.apple.com/design/human-interface-guidelines/popovers>
13. Menus: <https://developer.apple.com/design/human-interface-guidelines/menus>
14. Segmented controls: <https://developer.apple.com/design/human-interface-guidelines/segmented-controls>
15. Sliders: <https://developer.apple.com/design/human-interface-guidelines/sliders>
16. Toggles: <https://developer.apple.com/design/human-interface-guidelines/toggles>
17. Lists and tables: <https://developer.apple.com/design/human-interface-guidelines/lists-and-tables>
18. Text fields: <https://developer.apple.com/design/human-interface-guidelines/text-fields>
19. Progress indicators: <https://developer.apple.com/design/human-interface-guidelines/progress-indicators>
20. Buttons: <https://developer.apple.com/design/human-interface-guidelines/buttons>

Liquid Glass and the iOS / iPadOS 26 design language:

21. WWDC25, "Meet Liquid Glass": <https://developer.apple.com/videos/play/wwdc2025/219/>
22. WWDC25, "Get to know the new design system": <https://developer.apple.com/videos/play/wwdc2025/356/>
23. Apple Newsroom, "Apple introduces a delightful and elegant new software design" (9 June 2025):
    <https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/>
24. Apple Developer Documentation, "Adopting Liquid Glass":
    <https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass>

Pro creative apps on iPadOS:

25. Procreate Dreams Handbook, "Interface and gestures: Interface": <https://help.procreate.com/dreams/handbook/interface-and-gestures/interface>
26. Procreate Dreams Handbook, "Timeline": <https://help.procreate.com/dreams/handbook/interface-and-gestures/timeline>
27. Procreate Dreams Handbook, "Stage": <https://help.procreate.com/dreams/handbook/interface-and-gestures/stage>
28. Final Cut Pro User Guide for iPad, "Edit screen": <https://support.apple.com/guide/final-cut-pro-ipad/dev3de99654f/ipados>
29. Logic Pro User Guide for iPad, interface overview: <https://support.apple.com/guide/logicpro-ipad/lpip33be754d/ipados>
30. Keynote User Guide for iPad: <https://support.apple.com/en-jo/guide/keynote-ipad/tan98841ef85/ipados>
31. iPad User Guide, "Position items on a Freeform board on iPad": <https://support.apple.com/en-kw/guide/ipad/ipad0b4f22b0/ipados>

Web techniques:

32. MDN, `backdrop-filter`: <https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter>
33. MDN, `prefers-reduced-transparency`: <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency>
34. MDN, `forced-colors`: <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/forced-colors>
35. Josh W. Comeau, "Next-level frosted glass with backdrop-filter": <https://www.joshwcomeau.com/css/backdrop-filter/>
36. OpenReplay Blog, "Creating blurred backgrounds using CSS backdrop-filter" (performance notes):
    <https://blog.openreplay.com/creating-blurred-backgrounds-css-backdrop-filter/>
