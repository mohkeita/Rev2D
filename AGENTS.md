# AGENTS.md: Rev2D for AI agents

Rev2D is a 2D rigging and animation toolkit in the spirit of Live2D Cubism and Spine, built so that
an AI agent can **author a rigged model as text, render it headlessly, measure it, and fix it**
without a human in the loop. This file is the working guide for agents. It has two parts:

- **[Part 1: Using Rev2D to build models](#part-1-using-rev2d-to-build-models)**: mental model,
  the verify loop, diagnostics, addresses, common mistakes, MCP tools, the live editor, Spine and
  Live2D files, avatars from one illustration.
- **[Part 2: Developing Rev2D](#part-2-developing-rev2d)**: architecture, module boundaries,
  commands, conventions, where to add features.

Reference docs: [docs/SPEC.md](docs/SPEC.md) (format and semantics, authoritative),
[docs/OPS.md](docs/OPS.md) (edit ops), [docs/CLI.md](docs/CLI.md) (every command and `--json`
shape), [docs/MCP.md](docs/MCP.md) (MCP server), [docs/RECIPES.md](docs/RECIPES.md) (copy-paste
rig recipes), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (pipeline and modules),
[examples/README.md](examples/README.md) (five annotated example models),
[docs/INTEROP.md](docs/INTEROP.md) (Spine and Live2D import / export),
[docs/AVATAR.md](docs/AVATAR.md) (an animated avatar from one illustration),
[docs/AGENT-BRIDGE.md](docs/AGENT-BRIDGE.md) (coding agents inside the editor),
[docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) (the editor's design language). The same docs are
available offline: `rev2d docs <spec|ops|cli|mcp|agents|recipes|interop|avatar|architecture|examples>` and MCP
`rev2d_docs {topic}`.

---

# Part 1: Using Rev2D to build models

## 1.1 Running rev2d

From a checkout with dependencies installed (`npm install`, Node 22+):

```sh
npx rev2d help                # inside the repository (runs bin/rev2d.js)
node bin/rev2d.js help        # same, from anywhere: node /path/to/Rev2D/bin/rev2d.js ...
rev2d help render             # flags and examples of one command
```

In a checkout, `bin/rev2d.js` runs the TypeScript sources through tsx (no build step); an installed
package runs the compiled `dist/`.
Examples below write `rev2d`; substitute `npx rev2d` or `node <repo>/bin/rev2d.js`.

MCP (preferred for agents that support it, e.g. Claude Code):

```sh
claude mcp add rev2d -- node /absolute/path/to/Rev2D/bin/rev2d.js mcp
```

Then call `rev2d_guide` first. Every CLI command below has an MCP counterpart (table in
[§1.9](#19-mcp-tools)).

## 1.2 Mental model

A model is **one JSON file** (`*.r2d.json`; comments and trailing commas are allowed) with these
sections, all addressed by string ids:

```text
parameters ──► bindings ──┬─► bones (transforms, Spine-style) ────┬─► parts (drawables) ──► render list
    ▲                     ├─► warps (lattice deformers, Live2D) ──┘
    │                     └─► part fields (opacity, z, shape.ry, path d, colors, ...)
animations, physics
```

- **Parameters are the control surface.** `AngleX`, `EyeOpen`, `MouthOpen`, ... are named numbers
  with a range. Bindings turn parameter values into property values; animations and physics set
  parameters. Animate parameters, not bones (like Live2D motions): the rig stays reusable.
- **Bindings** map 1-3 parameters to one property through keyforms on a full grid (2 parameters ×
  3 values = 9 keyforms) with multilinear interpolation. Several bindings/tracks on one property
  **add their deltas** from the setup value.
- **Everything is in canvas pixels.** Setup space = the canvas (`meta.width × meta.height`),
  origin top-left, **+x right, +y down**.
- **Angles are degrees, positive = clockwise on screen.** 0° points along +x, 90° points **down**.
- **Geometry is absolute.** Parts and warp rects are drawn where they appear in the rest pose
  (setup space), then attached. Reparenting a part never moves it.
- **Bones are local.** A bone's `x`, `y`, `rotation`, `scaleX`, `scaleY` are relative to its parent
  bone (root bones: canvas coordinates). `world = parentWorld · translate · rotate · scale`; the tip
  is `length` px along local +x.
- **Attachment decides deformation:** `parent` = a bone (rigid follow) or a warp (bilinear lattice
  deformation) or nothing (model space); `skin: {bones: [...]}` blends several bones per vertex.
- **Values are absolute** (what the property should be at that keyform), except warp offsets,
  which are offsets from the rest lattice. The keyform at the parameter's default should equal the
  setup value; otherwise the rest pose is not what the file says.
- **Draw order** is `(z, array index)`; `z` is bindable.
- **Standard parameter signs** (SPEC §3.1, the Live2D convention, verified on `examples/hana`):
  `AngleX > 0` turns the face toward the **screen right**; `AngleY > 0` looks **up** (features move
  to *smaller* y although +y is down); `AngleZ > 0` tilts **clockwise**; `EyeBallX/Y > 0` look
  right / up; `BodyAngleX > 0` leans right. `L` in an id is the character's left, which is on the
  **screen right** for a character facing the viewer.
- **Animations play as layers** (SPEC §6.4): `override` (default; later layers win) or `add` (a
  gesture on top of an idle), with a `start` time, and `once` / `hold: false` so a one-shot stops
  affecting the pose after its end (a looping layer with `once` stays silent until its `start`;
  without `once`, `start` only shifts a loop's phase). Keys can use the `smooth` ease (Catmull-Rom through the
  neighbouring keys) and a track can be time-shifted with `offset`.
- **Physics** starts at rest, steps at a fixed 60 Hz and writes its output parameters. A single
  pose simulates at most the 60 s before its time; sequences (sheets, GIFs, `analyze`) step it
  frame to frame, and `--warmup` starts them in the steady state.
- **Explicit values win.** A parameter set explicitly (`--param`, a sweep, MCP `params`, a pinned
  editor slider) beats animations **and physics**: sweep a physics output to check its binding,
  no `--no-physics` needed.
- **Deterministic:** the same model and inputs give the same numbers and pixels everywhere (CLI,
  MCP, editor server).

Evaluation per frame (SPEC §9): parameter defaults → animation layers → clamp → explicit `params`
→ physics (explicit values re-applied) → bindings + tracks → bones → IK → warps → parts → draw
list.

## 1.3 The verify loop

Never declare a rig done from the JSON alone. Loop until the pictures **and** the numbers are right:

| Step | CLI | MCP |
| --- | --- | --- |
| 0. Start | `rev2d new hero.r2d.json` (`--template hana`, or `--template empty` to build everything with ops), `rev2d info hero.r2d.json` | `rev2d_create_model`, `rev2d_info` |
| 1. Validate | `rev2d validate hero.r2d.json --json` | `rev2d_validate` |
| 2. Look (with overlays) | `rev2d render hero.r2d.json -o out/rig.png --overlay bones,warps,labels,grid --viewbox fit --scale 2` | `rev2d_render {overlay, viewBox: "fit"}` |
| 3. Motion in one image | `rev2d sheet hero.r2d.json -o out/x.png --sweep AngleX --sweep AngleY=30,0,-30`, `--overview`, or `--anim idle --frames 12` | `rev2d_sheet {sweeps}` / `{overview}` / `{animation}` |
| 4. Measure | `rev2d inspect hero.r2d.json --param AngleX=30 --bone head --part mouth --json`; `--point 256,180@head`; `--anim walk --times 0:1:11 --track ik:legIk,bone:foot.tip`; `rev2d hit hero.r2d.json 256 180` | `rev2d_inspect {points, times, track}`, `rev2d_hit_test` |
| 5. Analyze motion | `rev2d analyze hero.r2d.json --anim idle --warmup 10` | `rev2d_analyze` |
| 6. Fix | `rev2d ops hero.r2d.json edits.json --dry-run`, then without `--dry-run` (add `--render out/after.png`) | `rev2d_apply_ops {dry_run, render_after}` |
| 7. Regressions | render before/after with the same flags, `rev2d diff a.png b.png -o out/d.png` | `rev2d_diff_images` |

Details that make the loop effective:

- **Overlays** (`--overlay`): `bones` (joints, direction, IK links), `warps` (deformed lattices),
  `mesh` (triangles: shows missing `detail`), `bounds` (part boxes), `labels` (bone and part ids),
  `grid` (canvas coordinates: lines every 50 px, labels every 100, so you can read positions off the
  image). `all` = every layer. `--only foreArm,faceWarp` limits the overlays to those bone / warp /
  part ids and `--only-chain` adds a bone's ancestors, so a busy rig stays readable (MCP `only`,
  `onlyChain`).
- **Sweeps**: `--sweep AngleX` = 5 steps over the range; `AngleX=-30:30:7` = min:max:steps;
  `AngleX=-30,0,30` = explicit values; `EyeLOpen,EyeROpen=0:1:5` sweeps linked parameters together.
  A second `--sweep` makes a grid. Every cell shares one view box, so cells are directly
  comparable. Check the extremes and the diagonals, not only the default. `--overview` renders one
  row per parameter over its whole range: the fastest check that each parameter does what its name
  says.
- **Animation sheets** sample the first `--anim`; extra `--anim` flags are layers
  (`--anim look_around --anim talk,add --anim wink,once,start=2.5`). `--from`/`--to` pick a window,
  `--times 0.2,0.86` exact moments, and `--warmup 10` runs whole cycles first so physics is in its
  steady state. Events are captioned under the cell they fall in. `gif` and `frames` export
  real-time playback (with incremental physics) and take the same sampling flags.
- **inspect** is the ground truth: parameter values after animation/physics/clamping, bone world
  joints/rotations/tips, part bounds and centers, deformed warp points, draw order, every bound
  property, events, IK diagnostics (`reached`, `extension` = distance / reach, `error`, `bend`,
  `stretch`) and physics outputs (`raw`, `value`, `clamped`, `overridden`). Assert with numbers
  ("the mouth center moved +12 px in x", "the elbow is at (339, 424)") instead of eyeballing.
  `--point x,y@parent` says where a setup point attached to a bone, warp or part ends up (a skinned
  part blends its bones like its own vertices; `bone:`/`warp:`/`part:` pick the kind when ids are
  shared), e.g. to check an accessory on a deforming head; `--times a:b:n` / `--frames n`
  evaluate a series and `--track col,...` prints it as a compact table (`param:X`,
  `bone:hand.tip`, `ik:armIk`, `physics:hair.HairSway`, `point:120,80@head`, any bound address).
- **analyze** samples an animation at 60 fps and reports what you would otherwise have to watch
  for: parameter ranges used, physics outputs clamped (share of frames, peak raw value), IK chains
  out of reach or nearly straight, events with times, whether the loop seam closes (parameters,
  bones and pixels at `t = duration` vs `t = 0`) and parts leaving the canvas, plus notes with the
  fix. Pass `--warmup` for animations with physics.
- **Read the notes.** `render`, `sheet`, `gif`, `frames` and `analyze` add notes for suspicious
  results: IK targets out of reach or chains nearly straight (snap risk), physics outputs clamped
  to their range, visible parts entirely outside the canvas (only with the default view box: an
  explicit `--viewbox` crop leaves parts out on purpose), nothing visible in the view box, clamped
  `--param` values. `render` splits visible parts into "in view" and "outside the view box".
- **Physics** only responds to inputs that change over time: verify it with an animation sheet or
  `analyze --warmup 10`, and check its output bindings with `--sweep <output>` (explicit values beat
  physics).

Evidence checklist before you report success: `validate` shows 0 errors (warnings explained or
fixed); a render of the default pose looks right; a sweep sheet for every parameter you touched
(both ends; `AngleY=30` must look up); an animation sheet and an `analyze` report (its notes fixed
or explained) for every animation you touched; `inspect` numbers for anything that must line up
(joints, pivots, eye/mouth positions, accessories via `--point`).

## 1.4 Reading diagnostics

Every problem is a `Diagnostic`: `severity` (`error` | `warning` | `info`), a stable `code`, a JSON
pointer `path` into the file, a `message` and usually a `hint` with the fix.

```text
$ rev2d validate bad.r2d.json
FAIL  bad.r2d.json
  info    /warps/0          unused-warp              warp "bodyWarp" has no children and nothing drives it  → parent parts to it and bind "warp:bodyWarp.offsets", or remove it
  error   /parts/0/parent   unknown-parent           unknown parent "bodyWarpp" (must be a bone or warp id)  → did you mean "bodyWarp"?
  error   /bindings/0/keys  binding-grid-incomplete  keyforms do not form a full grid: Lean {-1, 1} × Blink {0, 1} needs 4 keys, 1 missing  → add keys with "at": [1, 1]
  2 errors, 0 warnings, 1 info
```

- Validation runs in two stages. **Structural** (`schema-*` codes: unknown keys, wrong types,
  missing fields) comes first; semantic checks only run once the structure is valid. After fixing
  a `schema-unrecognized-keys` typo, expect a new round of semantic diagnostics.
- `path` is an RFC 6901 pointer: `/bindings/0/keys/3/value` = 4th keyform of the first binding.
- Commands that load a model refuse to render or inspect one with errors (exit 1, diagnostics
  printed). Warnings do not block; `validate --strict` fails on them too.
- `--json` puts the same objects on stdout: `rev2d validate --json` returns
  `[{file, ok, errors, warnings, diagnostics}]`. Failed commands print
  `{"ok": false, "exitCode", "error": {kind, message, hint, diagnostics?}}`.
- Exit codes: `0` ok, `1` model errors or failed operation, `2` usage error (unknown flag,
  parameter id or animation id; the hint suggests the right one).
- Ops report per-op results with hints; a batch is atomic, so fix the failing op and resend the
  whole batch:

```text
$ rev2d ops hero.r2d.json --op '{"op":"set","target":"bone:rot.rotation","value":10}'
1 of 1 op failed on hero.r2d.json
  FAIL  #0  set  unknown bone "rot"  → did you mean "root"?
not written: 1 op failed
```

Frequent codes and their usual fix:

| Code | Meaning | Fix |
| --- | --- | --- |
| `json-syntax` | the file is not JSON/JSONC | fix the syntax at the reported line/column |
| `schema-unrecognized-keys` | unknown key (typo) | use the did-you-mean key; `rev2d_schema {name}` lists fields |
| `schema-invalid-type`, `schema-invalid-union` | wrong type or shape | check the field in `rev2d schema` / SPEC §3 |
| `duplicate-id` | two items of one kind share an id (bones and warps share one namespace) | rename one (`rename` op updates references) |
| `unknown-parent`, `unknown-bone`, `unknown-part`, `unknown-parameter`, `unknown-texture` | dangling reference | use the suggested id, or add the missing item |
| `bone-cycle`, `warp-cycle` | parent loop | re-parent one item |
| `invalid-target` | a binding/track address that does not resolve | check the address grammar ([§1.5](#15-address-grammar-cheat-sheet)) |
| `binding-grid-incomplete` | keys are not the full grid | add the listed `at` combinations |
| `binding-at-length` | `at` has the wrong number of values | one value per parameter, in `params` order |
| `binding-key-out-of-range`, `track-value-out-of-range` | value outside the parameter range | keep keys inside `[min, max]` |
| `invalid-value` | a keyform value of the wrong type or length (point count, path structure, color) | match the setup value's type; paths keep the setup commands |
| `skin-with-parent` | a skinned part also has `parent` | remove `parent` |
| `ik-not-chain`, `ik-target-in-chain` | IK bones are not parent/child, or the target moves with the chain | fix the bone list; parent the target outside the chain |
| `physics-output-animated`, `physics-feedback` | physics fights an animation track, or feeds itself | animate an input instead; use a different input parameter |
| `warp-outside-parent` (warning) | a nested warp's `rect` sticks out of its parent warp's `rect`; points there are extrapolated and drift | enlarge the parent, shrink the child, or parent the child to the bone the parent follows (the message gives the covering rect) |
| `part-outside-warp` (warning) | a part's setup outline (stroke included, 0.5 px tolerance) sticks out of its warp's `rect`; those vertices are extrapolated and drift | enlarge the rect to the covering rect in the hint (it moves the lattice points, so check the warp's bindings), shrink the part, or parent it to the ancestor warp or bone the hint names |
| `ik-softness-one-bone`, `ik-stretch-zero-length`, `ik-softness-too-large` (warnings) | `softness` on one-bone aim IK (ignored), `stretch` on a zero-length bone, `softness` ≥ the chain's reach | remove the option, give the bone a `length`, use 5-15% of the reach |
| `track-offset-no-effect` (warning) | a track `offset` in a non-looping animation moves the sampled window past every key, so the track is constant | a smaller offset, or make the animation loop (looping tracks wrap) |
| `detail-too-fine` | `detail` would create too many vertices | use the suggested minimum |
| `texture-load` | PNG missing or unreadable | paths are relative to the model file |
| `key-after-duration`, `event-after-duration` | time past the animation's end | extend `duration` or move the key |
| `unused-parameter`, `unused-warp`, `unused-texture` (info) | defined but has no effect | bind it, parent something to it, or remove it |
| `binding-no-effect` (info) | every keyform equals the target's setup value (warp offsets: all zero), so the binding changes nothing | write absolute values (not offsets of 0), or `bind` with `"relative": true`; check the target |

## 1.5 Address grammar cheat sheet

One grammar for bindings, animation tracks, `rev2d set`, ops and MCP:

| Address | Value | Notes |
| --- | --- | --- |
| `param:<id>` | number | animation tracks only (bindings are driven *by* parameters) |
| `bone:<id>.x` `.y` `.rotation` `.scaleX` `.scaleY` `.length` | number | local to the parent bone |
| `warp:<id>.offsets` | points | offsets from the rest lattice; setup = all zeros |
| `part:<id>.opacity` `.z` | number | |
| `part:<id>.visible` | boolean | |
| `part:<id>.tint` `.fill` `.stroke.color` | color | `fill` only for solid fills |
| `part:<id>.stroke.width` | number | the part must have a stroke |
| `part:<id>.shape.cx` `.cy` `.rx` `.ry` `.rotation` | number | ellipse |
| `part:<id>.shape.x` `.y` `.w` `.h` `.radius` | number | rect (`image`: `x y w h`) |
| `part:<id>.shape.points` | points | polygon |
| `part:<id>.shape.d` | path | same command structure as the setup path |
| `part:<id>.shape.vertices` | points | mesh |
| `ik:<id>.mix` | number | 0..1 |

Value forms: numbers; colors (`"#rgb"`, `"#rrggbbaa"`, `"rgba(...)"`, names); booleans; point lists
as a full flat list `[x0, y0, x1, y1, ...]` or a **sparse map** `{"4": [x, y]}` (unlisted points keep
their setup value; for warp offsets, unlisted = 0); SVG path strings. Warp lattice point index =
`row * (cols + 1) + col`, row-major from the top-left.

Not addressable (change them with `update`): ids, `parent`, `blend`, `mask`, `skin`, gradient fills,
warp `rect`/`cols`/`rows`, parameter ranges.

## 1.6 Edit ops cheat sheet

Prefer ops over rewriting the file: they are atomic, validated, id-addressed, keep references
consistent and explain what they did (world positions of new bones, largest warp displacement,
cascaded changes). Full reference: [docs/OPS.md](docs/OPS.md).

| Op | Use it to |
| --- | --- |
| `add {kind, value, index/before/after?}` | add an item; bones may give `"world": [x, y]` instead of local x/y and `"worldRotation"` (screen direction, converted through the parent) instead of `rotation` |
| `update {kind, id, set: {"shape.rx": 20, "stroke.width": 3, "x": null}, keepWorld?}` | change fields (dotted paths, `null` deletes; `world` / `worldRotation` for bones); reparent bones with `keepWorld: true`. The message lists only the fields that changed |
| `remove {kind, id, cascade?}` | delete; without `cascade` it fails and lists every reference (use it as a query) |
| `rename {kind, from, to}` | rename and rewrite every reference, including address strings |
| `set {target, value}` | change a **setup** value by address (`rev2d set hero.r2d.json bone:head.rotation=10`) |
| `bind {target, params, keys, interpolation?, relative?}` | create or replace a binding; `"relative": true` = values are offsets from the setup value |
| `bind_linear {target, param, scale, at?}` | `value = setup + scale × param` as a two-key binding (parameters in px or degrees) |
| `bind_warp {warp, params, keys: [{at, yaw, pitch, scale, rotate, pivot, translate, offsets}]}` | generate warp keyforms (pseudo-3D turns, breathing); `pitch > 0` looks down, so use negative pitch at `AngleY > 0` |
| `follow {warp \| bone, follow, at?, params?, rotate?, scale?}` | keep a rigid accessory (hat, glasses) on a deforming head: keyforms that move the accessory warp/bone so its anchor `at` stays on `follow` at every keyform of the head turn; the message reports the residual (0 at keyforms) |
| `unbind {target, params?}` | remove bindings on a target |
| `key {animation, target, t, v, ease?, duration?, loop?}` | upsert a keyframe (creates the animation when `duration` is given) |
| `unkey {animation, target, t}` | remove a keyframe |
| `move {kind, id, index/before/after}` | reorder within a section (draw-order ties) |
| `recolor {parts \| tag \| all, map \| hsl, include?}` | palette changes: exact colour map or hue/saturation/lightness shift, including gradient stops, strokes and colour keyforms |
| `compose {id, layers, duration?, fps?, loop?, replace?}` | bake layered animations (`add`, `start`, `hold`) into one animation that plays the same alone: single layers are copied exactly, repeats of one one-shot merged, the rest sampled at `fps` (default 60); a `WARNING` names the fps that samples every source key |
| `patch {patch: [RFC 6902 ops]}` | anything else (`meta`, events append); no reference updates |

`kind` ∈ `parameter texture bone warp part binding ik physics animation`. Bindings may be selected by
`target` (+ `params`) instead of `id`. `rev2d ops model.r2d.json ops.json --dry-run` previews;
`--render out.png` renders the result in the same step; `-o other.r2d.json` writes elsewhere;
several ops files (`rev2d ops m.r2d.json 01-bones.json 02-parts.json`) form one atomic batch.

## 1.7 Recipes and examples

- **[docs/RECIPES.md](docs/RECIPES.md)** (`rev2d docs recipes`): op batches on a starter model,
  each with the commands that verify it (all executed by `npm test`): head turn (`bind_warp` 3×3
  yaw/pitch grid), eye blink (shape binding + mask), mouth (path morph 2D grid), breathing, hair
  physics, arm IK, skinned limb, squash & stretch, draw-order swap, blend-mode glow, textured parts,
  layered animations, events, clean closed eyes (path-morph lids, mask sliver inside the lash),
  gestures over an idle (`add`, `once`, `compose`), a rigid hat on a turning head
  (`follow`, `inspect --point`), markings under an outline, pixel parameter rigs (`bind_linear`, relative
  `bind`), a walk cycle (`smooth` keys, track `offset`, IK `softness`/`stretch`, `analyze`), physics
  tuning with `analyze` and `--warmup`, and `recolor`.
- **`rev2d_guide`** (MCP) / `src/mcp/guide.ts`: a compact quickstart with four recipes.
- **[examples/](examples/README.md)**: `minimal` (start here), `hana` (Live2D-style bust: 8×8 face warp,
  path-morph eyes and mouth, masks, hair physics), `robot-arm` (Spine-style: IK, skinning, cable
  physics), `slime` (squash & stretch, blend modes, events), `textured` (atlas crops, textured
  mesh). Copy one with `rev2d new my.r2d.json --template hana`; read its JSON for patterns.

## 1.8 Common mistakes and fixes

1. **Angles backwards.** +degrees are clockwise because +y is down. A bone pointing up has
   rotation -90. If a rotation binding turns the wrong way, negate the delta. `worldRotation` in
   `add`/`update` takes the on-screen direction and converts it for you.
2. **AngleY upside down.** `AngleY > 0` looks **up**, but canvas +y points down and `bind_warp`
   `pitch > 0` looks down. Use negative pitch (or negative y offsets) at `AngleY = 30`, and check:
   `rev2d inspect --param AngleY=30 --part mouth` must show a *smaller* center y than at rest.
3. **Relative keyform values.** Binding/track values are absolute: a head bone at local `y: -140`
   that should rise 9 px needs keyform `-149`, and a bone rotation keyform includes the setup
   rotation. Only warp offsets are relative (to the rest lattice). When you think in offsets, let
   the op do the sum: `bind` with `"relative": true`, or `bind_linear` for "n px per unit".
4. **Rest pose drift.** The keyform at the parameter default differs from the setup value, so the
   model no longer rests where the file says. Make them equal (`rev2d inspect` at default params
   shows the effective values).
5. **Parts that do not bend.** A rect or ellipse without `detail` is a few triangles; images need
   `cols`/`rows`. Check with `--overlay mesh`.
6. **Moving the rest frame instead of posing.** `set bone:head.y` (or `update`) changes the setup
   frame of the bone, but its parts' geometry is absolute, so they do not move with it at rest. Use
   `set`/`update` to fix a misplaced joint; bind or animate the property to pose.
7. **Incomplete binding grids.** 2 parameters with 3 and 2 distinct `at` values need all 6 keys.
8. **Path morphs with different commands.** Every keyform path needs the setup path's command
   sequence. Author all mouth/eye shapes from one template (e.g. `M C C Z`).
9. **Masks that lose their area.** A mask whose parts have no geometry in a pose gives zero
   coverage: every part it masks disappears (a `maskInvert` part draws in full). For closing eyes,
   keep a sliver of eye white and put it **inside** the lash band, so neither an empty mask nor a
   line of iris under the lash can show ([RECIPES 14](docs/RECIPES.md#14-closed-eyes-that-stay-clean-path-morph-eye--lash-band)).
   Markings masked by an outlined part paint over its outline: draw the outline as a stroke-only
   copy above them (RECIPES 17).
10. **Physics that "does nothing".** It starts at rest and reacts to inputs that change over time;
    a single-frame render with a constant `--param` shows no swing. Its outputs are written every
    frame: do not animate them. To check an output's binding, sweep or `--param` the output itself
    (explicit values beat physics). Measure clamping with `analyze --warmup 10`.
11. **Bone and warp id clash.** Bones and warps share one parent namespace (`duplicate-id`).
12. **IK target inside the chain.** Parent the target to the root or another bone that does not
    move with the chain.
13. **IK snapping.** A two-bone chain whose target comes close to full reach (extension > 0.98)
    straightens abruptly, and one out of reach snaps straight and misses. `analyze` and the
    `render`/`sheet` notes report both; add `"softness"` (px) and, if the tip must stay on target,
    `"stretch": true`.
14. **Mirrored L/R.** Live2D naming: `L` = the character's left = the screen's right (for a
    character facing the viewer; in a side view facing right, `L` is the far side). Stick to one
    convention and say which.
15. **Parts left out of a deformer.** A part added later to a turning head (lashes, a hat, a
    tongue) must join the warp its neighbours are in, or it stays behind when the head turns. It
    must also lie inside that warp's rect (`part-outside-warp`), as a nested warp must lie inside
    its parent (`warp-outside-parent`). For accessories sticking out of the head lattice, give them
    their own lattice (or bone) on the head bone and let the `follow` op match its motion to the
    head; check with `inspect --point` (RECIPES 16).
16. **Layers that fight.** A gesture played as `override` replaces the idle's values (the head stops
    looking around while it talks): play it as `add`. A finished one-shot holds its last key and
    overrides later motion (one eye stays open when the idle blinks): play it `once`. RECIPES 15.
17. **Trusting one frame.** Check parameter extremes and diagonals with sweep grids, and animation
    loops with `analyze` (the loop seam at `t = duration` vs `t = 0`; with physics, `--warmup`).
18. **Editing a shipped example in place.** `rev2d edit` and ops write the file. Work on a copy
    (`rev2d new mine.r2d.json --template slime`; the editor's example cards copy too).
19. **Hand-formatted JSON diffs.** Ops and the editor rewrite files with the stable formatter
    (comments are dropped). Keep comments out of models you edit with tools.

## 1.9 MCP tools

`rev2d mcp` serves these tools over stdio (details and argument tables: [docs/MCP.md](docs/MCP.md)).
Renders come back as inline PNG images plus a JSON summary; failures come back as `isError` results
with a hint and diagnostics, never as a crash.

| Tool | Purpose |
| --- | --- |
| `rev2d_guide` | The **Rev2D quickstart for AI authors**: conventions, workflow, addresses, recipes. Call first. |
| `rev2d_schema {name?}` | JSON Schema of the model or one sub-schema (`Part`, `Binding`, `Physics`, ...) |
| `rev2d_docs {topic}` | `spec`, `ops`, `cli`, `mcp`, `recipes`, `interop`, `avatar`, `architecture`, `examples`, `agents` (this file) |
| `rev2d_create_model {path, template?, width?, height?}` | new model from `blank`, `empty` or an example |
| `rev2d_validate {path}` | diagnostics |
| `rev2d_info {path}` | outline: parameters and what they drive, bone tree, warps, parts, ... |
| `rev2d_render {path, params?, animations?, time?, overlay?, only?, onlyChain?, viewBox?, scale?, save_to?}` | one pose as an image, with IK reach and notes |
| `rev2d_sheet {path, sweeps? \| overview? \| animation?, frames?, from?, to?, times?, warmup?}` | captioned contact sheet (max 64 cells); linked sweeps `"EyeLOpen,EyeROpen=0:1:5"` |
| `rev2d_inspect {path, pose..., bones?, warps?, parts?, points?, times?, frames?, track?}` | exact numbers for a pose, a series, or a compact track table |
| `rev2d_analyze {path, animation, animations?, warmup?, fps?, frames?}` | ranges, physics clamping, IK reach, events, loop seam, parts leaving the canvas |
| `rev2d_hit_test {path, x, y}` | parts under a canvas point |
| `rev2d_apply_ops {path, ops, dry_run?, render_after?}` | atomic, validated edits |
| `rev2d_diff_images {a, b}` | pixel diff with a visualization |
| `rev2d_import {format: "spine" \| "live2d", path, out? \| into}` | a Spine skeleton export -> a new model; Live2D motion3 / exp3 / physics3 / cdi3 / model3 files -> ops on `into` ([§1.11](#111-spine-and-live2d-files)) |
| `rev2d_export {format, path, out_dir}` | Spine JSON + atlas + PNG pages, or Live2D motion3 / physics3 / cdi3 / model3 JSON |
| `rev2d_editor_state` / `rev2d_editor_command` / `rev2d_editor_screenshot` | see and drive the human's live editor; `{type: "open", file}` switches it to another model of its workspace ([§1.10](#110-working-with-a-human-the-live-editor)) |

Pose arguments: `params` (explicit values beat animations and physics), `animations` as layer
strings (`["look_around", "talk@0.8,add", "wink,once,start=2.5"]`) or objects
`{id, weight?, mode?, start?, hold?, time?}`, `time`, `physics`.

Resources: `rev2d://guide`, `rev2d://docs/spec`, `rev2d://docs/ops`, `rev2d://docs/recipes`,
`rev2d://docs/interop`, `rev2d://docs/avatar`, `rev2d://schema`. Relative paths resolve against the server's working directory; models are
re-read from disk on every call.

## 1.10 Working with a human: the live editor

The human runs `rev2d edit hero.r2d.json` (web editor on `http://127.0.0.1:4777`). The editor
live-reloads every file change, so each `rev2d ops` / `rev2d_apply_ops` write shows up on their
screen immediately, and their edits are written to the same file: re-read it (`rev2d info`)
before your next batch. `rev2d_apply_ops` refuses to overwrite a file that another program saved while the call
was running; send the batch again.

- `rev2d editor state --json` / `rev2d_editor_state`: the model they have open and the workspace
  root, their parameters (physics results included), time, playing animation layers, the
  parameters they pinned (explicit values that beat animation and physics), selection, overlays,
  visible region and parts hidden in the preview. With no model open it reports the start screen
  and the recent files (exit 0, not an error).
- `rev2d editor screenshot -o out/seen.png` / `rev2d_editor_screenshot`: exactly what they see,
  rendered by the same renderer.
- `rev2d editor command --params AngleX=30 --select head --message "check the turn"` /
  `rev2d_editor_command`: pose the model, play animations (`--play idle`, `--anims idle,blink@0.5`),
  select items (`ik:armIk` or `physics:hair` shows their live diagnostics in the inspector), toggle
  overlays, focus a region, or show a message. Layer options (`mode`, `start`, `hold`) go through
  the JSON form: `rev2d editor command '{"type":"setAnimations","animations":[{"id":"idle"},{"id":"talk","mode":"add"}]}'`
  or MCP `rev2d_editor_command`.
- If you write the model while the human has unsaved edits, their next save is refused with a
  conflict (HTTP 409) instead of overwriting your change; they choose to reload or overwrite.

### Files and the workspace root

The editor manages files inside a **workspace root** and has at most one model open:

```sh
rev2d edit hero.r2d.json                     # one model; workspace = its directory
rev2d edit                                   # start screen; workspace = the current directory
rev2d edit models                            # a directory: that directory is the workspace, no model open yet
rev2d edit models/hero.r2d.json --root .     # a model, with the whole project as the workspace
```

- The human's **File menu** has New from a template (Alt+N), Open (Ctrl+O), Open Recent, Save
  (Ctrl+S), Save As (Ctrl+Shift+S), Import from computer (a model plus its PNG textures), Download
  copy, Export PNG of the view, Reload from disk and Close. Without a model the editor shows a
  **start screen**: New / Open / Import, the recent files of the workspace and example cards; an
  example card *copies* the example into the workspace (through the New dialog), it never edits the
  shipped file. Before New, Open, Import, Close or Reload replaces a document with unsaved changes
  the editor asks "Save changes?".
- **Every path stays inside the root**: files the editor opens, creates, saves or imports must lie
  inside it, also after following symbolic links and junctions. Anything else is refused with HTTP
  403 and a hint (restart with `--root <dir>`). New files need portable names, and existing files
  are only replaced when the human confirms (overwrite).
- **You can switch the model the human sees**: `rev2d editor command --open models/cat.r2d.json`
  or MCP `rev2d_editor_command {command: {type: "open", file: "models/cat.r2d.json"}}` (a relative
  path resolves against your working directory; it must lie inside the editor's root). Every editor
  tab follows, the view state resets, and commands sent right after the open (in the same call:
  `--open m.r2d.json --params AngleX=30`) apply to the newly opened model. To show a model that does
  not exist yet, create it inside the root first (`rev2d new models/cat.r2d.json --template blank`,
  or `rev2d_create_model`), then open it. Opening replaces what the human is looking at, and an edit
  they could not save (a conflict, a rejected invalid model, a deleted file) is discarded with a
  warning: check `rev2d editor state` first and do not switch away from their work unasked.
- **Which editor you talk to**: running editors register their URL, the file they have open now and
  their workspace root in `~/.rev2d/editors/`. `--model <file>` (MCP `model`) picks the editor that
  has that file open, else the one whose workspace root contains it (innermost root first; this
  also finds an editor on its start screen); a directory picks the editor of that workspace.
  `--open <file>` without `--model` / `--url` goes to the editor whose workspace holds the file.
  When the chosen editor has another model (or none) open, `editor state` adds a note, while
  commands other than open and screenshots are refused (they would act on the wrong model): add
  `--open <file>`. `--url` (MCP `url`) skips discovery; entries of older editor versions carry no root and
  are found by their open file only.
- While no model is open, model commands and screenshots fail with `409 no model is open` and a hint
  to open one. If the open model's file is deleted or moved away on disk, the editor keeps it open
  as unsaved (Save writes it back).

### Avatar mode

An avatar project (a folder with `avatar.json` and the illustration, `rev2d avatar new`) opens in
**Avatar mode**: the human sees the parts of `avatar.json`, the illustration with a handle on every
landmark, and a live preview of the avatar (pose sliders, lip sync). Before the first build there is
no model yet; Avatar mode shows the project anyway, with a checklist of the landmarks still to place
and a Build button. In Avatar mode the toolbar's Save / Undo / Redo and Ctrl+S / Ctrl+Z act on
`avatar.json`; the Rig mode (once built) edits the generated model.

- Show a project to the human with `rev2d editor command --open <project>/avatar.json` (or the
  folder): its built model, or the project alone. Ask before switching away from their work: an
  `open` cannot wait for their "Save changes?" answer, so their unsaved `avatar.json` edits are lost
  (they are told so).
- `rev2d editor state` names the project (`avatar project <dir> (no built model yet)` before the
  first build) and, once built, `avatar part: <id>`: the part they selected, e.g.
  `eyes.imageLeft.opening` (`state.avatar.part` with `--json`). Look at that part with
  `rev2d avatar overlay <project> --part <id> --zoom`.
- Write `avatar.json` and build with `rev2d avatar build <project>`: the editor shows every change at
  once (their unsaved edits are kept and they choose to reload or keep theirs). The workflow itself:
  [§1.12](#112-avatars-from-one-illustration) and `rev2d docs avatar`.

### In-app AI panel

The sparkles button of the editor's toolbar opens the **AI panel**: the human types a request and
the editor itself starts the Codex CLI or Claude Code in the workspace with their login, showing
the agent's messages, commands and file changes as it works ([docs/AGENT-BRIDGE.md](docs/AGENT-BRIDGE.md)).
It needs one of those CLIs installed and signed in, and the editor on a loopback address (the
default). Avatar mode starts it for "Let AI Place Them" (a new project) and "Ask AI to Fix This
Part". If you are the agent in that panel, you work inside the workspace: follow this guide as
usual, and the human sees your edits live.

## 1.11 Spine and Live2D files

Rev2D converts from and to the public JSON formats of Spine and Live2D Cubism
([docs/INTEROP.md](docs/INTEROP.md) has the support matrix and the workflows):

```sh
rev2d import spine hero/hero.json -o models/hero.r2d.json          # Spine 3.8-4.2 JSON + atlas + PNG pages -> a new model
rev2d export spine models/hero.r2d.json -o out/hero-spine           # -> Spine 4.x JSON + atlas + pages (everything baked)
rev2d import live2d idle.motion3.json --into hana.r2d.json          # motion3 / exp3 / physics3 / cdi3 / model3 -> ops
rev2d export live2d hana.r2d.json -o out/hana-live2d --anim wave    # -> motions/*.motion3.json, physics3, cdi3, model3
```

- **Read the report.** Every conversion lists what it approximated or dropped: severity, a stable
  `code`, `where` in the SOURCE data, a `hint`. Warnings matter (a skipped constraint, an unknown
  parameter); info notes document choices (baked physics, renamed ids). Mention the warnings to the
  human instead of claiming a perfect conversion.
- **Verify an import like any rig**: `validate`, a `render` with `--overlay bones`, a `sheet` per
  animation and `analyze` for loops and physics. Spine rigs that rely on path or physics constraints
  import with visibly wrong limbs; the report names them. Shear, inheritance modes and transform
  constraints are emulated with sampled tracks: moving those bones' parents or targets in Rev2D does
  not re-apply the Spine rule (the report says which bones), so edit their motion in Spine and
  re-import.
- **Live2D: the `.moc3` model is not supported** (proprietary). Motions, expressions, physics and
  display names move between models by **parameter id**; the model's art does not. To write a motion
  for a Live2D model, author it on a Rev2D model with the same parameters (`hana` uses the Live2D
  standard ids), verify it, export it, and tell the human where to add the `.motion3.json` in their
  model3.json (`Motions`). `--param-map` (MCP `param_map`) maps other ids: `standard` (default),
  `none`, `prefix` or a JSON file `{"<Rev2D id>": "<Live2D id>"}`.
- **A Live2D import is an atomic op batch**: `--dry-run` first on a model you care about. An
  animation with the same id is replaced: the report **warns** (`live2d-animation-replaced`) when
  that animation was made in Rev2D, and only notes it when an earlier Live2D import wrote it. To keep
  it, rename it first (`rename` op) or pass `--id` for a single motion3 / exp3 file. `--physics
  replace` (default) removes the model's physics groups that drive the same parameters (`merge`
  keeps them).
- **Spine exports are baked**: parameters, warps, physics and IK end up in the animations. Export the
  animations the human needs (`--anim`), add `--param-poses` for min / max poses of each parameter,
  and raise `--texture-scale` for crisper vector parts.
- In the live editor the human has File > Import from computer (Spine exports), File > Import Live2D
  motions… (one undoable edit) and File > Export to > Spine… / Live2D motions… (into
  `exports/<model>-spine|-live2d`).

## 1.12 Avatars from one illustration

Given ONE picture (ideally a front-facing bust on a transparent background), you place landmarks on
it in `avatar.json`; Rev2D cuts the picture into layers and generates an ordinary model that blinks,
talks, turns and tilts its head, breathes and sways its hair. **The working guide is
`rev2d docs avatar`** ([docs/AVATAR.md](docs/AVATAR.md)): read it before you start. In short:

| Step | Command | |
| --- | --- | --- |
| 1. Start | `rev2d avatar new picture.png avatars/hana` | the project folder: `source.png` (never modified) + a draft `avatar.json` |
| 2. Vision check | `rev2d avatar vision-check make avatars/hana/work/vision`, then `score` | prove you read pixel coordinates accurately (mean ≤ 4 px); stop if you cannot |
| 3. Read | `rev2d avatar grid avatars/hana --region x0,y0,x1,y1` | source-pixel grids of the whole picture and each detail |
| 4. Place | edit `avatar.json` group by group | head ellipse around ALL hair, neck pivot below the chin, face oval, eye opening (inside the lashes) and region (outside them), mouth corners and area, nose, chin, strands root → tip, attachments, body. `imageLeft` / `imageRight` are sides of the IMAGE |
| 5. Validate | `rev2d avatar validate avatars/hana` | after every group: what is missing or wrong, with hints |
| 6. Look | `rev2d avatar overlay avatars/hana --part eyes.imageLeft --zoom` | the landmarks on the picture, vertices numbered |
| 7. Build | `rev2d avatar build avatars/hana` | layers + `<name>.r2d.json`; read the warnings (folds name the place) |
| 8. Review | `rev2d avatar poses avatars/hana` | look at `review/poses.png`, `turn.png`, `eyes.png`, `mouth.png`; fix the landmark behind each problem, back to 5 |

- The model is **regenerated by every build**: never edit it; customise it with edit ops in the
  `post` list of `avatar.json`. Drawn closed eyes and mouth shapes
  (`rev2d avatar variants request|import|status`) beat the mesh deformation; draw them with an image
  generator **only when the human allowed it**.
- The generated model is a normal model: check it with `rev2d sheet --sweep AngleX --sweep AngleY`,
  `rev2d analyze --anim idle --warmup 10` and `inspect --point`, as in [§1.3](#13-the-verify-loop).
- Avatar MCP wrappers are available: `rev2d_avatar_new`, `rev2d_avatar_validate`, `rev2d_avatar_grid`, `rev2d_avatar_overlay`, `rev2d_avatar_build`, `rev2d_avatar_poses`; image tools return PNGs inline.

Evidence before you report an avatar as done: `avatar validate` shows 0 errors (warnings explained);
`avatar build` reports no folds (or each one explained); you looked at all four review sheets: the
rest pose is the illustration, closed eyes show one clean lash line and no iris or eye white, turning
and tilting do not tear the picture, cut the chin or ears, or bend rigid accessories, the open mouth
does not stretch the chin, hair sways while the face stays; `summary.json` moves are plausible (the
nose travels farther than the ears at `AngleX = 30`); and a hand-over note names the landmarks you are
least sure about by their place in `avatar.json`.

---

# Part 2: Developing Rev2D

## 2.1 Commands

```sh
npm install                                   # Node 22+
npm test                                      # vitest run: the whole suite
npx vitest run src/ops test/cli.test.ts       # a subset while iterating
npx tsc --noEmit -p tsconfig.json             # typecheck (also: npm run typecheck); must stay clean
npm run editor:build                          # editor UI -> dist/editor (served by rev2d edit; enables the e2e test)
npm run build                                 # compile src/ -> dist/ (tsconfig.build.json) + the editor UI: what the package ships
npm run editor:dev                            # Vite dev server with HMR; proxies /api to an editor server on :4777
npx tsx scripts/build-examples.ts             # regenerate examples/*/*.r2d.json from their builders
npx tsx scripts/render-examples.ts            # render every example into out/examples/
```

The `test/*-e2e.test.ts` files drive the built UI in headless Chrome through playwright-core
(SwiftShader WebGL2) and skip with a logged reason when `dist/editor` or Chrome is missing. Software
WebGL takes many threads, so `vitest.config.ts` runs them as a project of their own (`chrome`) after
the other files (`node`), one file at a time: `npx vitest run --project node` skips them, and a new
test that launches Chrome belongs in a `*-e2e.test.ts` file. Scratch output goes to `out/`
(git-ignored).

## 2.2 Architecture in one screen

```text
 .r2d.json ─► parse + validate ─► Rig compile ─► rig.pose(opts) ─► buildRenderList ─┬─► renderImage ─► PNG / GIF / sheets / overlays
              src/core/validate   src/core/rig   Pose              RenderList       │   (src/render, pure TS)
                                                                                    └─► WebGL2 viewport (editor/src/gl)
 front ends: src/cli (rev2d) · src/mcp (MCP server) · src/server (editor HTTP/SSE) · editor/ (React UI)
 shared:     src/api (render/sheet/inspect/hit/info) · src/ops (edit engine) · src/node (files, registry, interop IO)
 interop:    src/interop (Spine JSON + atlas, Live2D motion3/exp3/physics3/cdi3/model3; pure) ◄─► src/node/interop.ts
 avatars:    avatar.json + source.png ─► src/avatar (spec, image ops, features, compileAvatar; pure) ─► .r2d.json
             file IO src/node/avatar.ts, avatar-variants.ts · lip sync src/lipsync (pure)
 agents:     editor AI panel ─► src/server/agent-routes.ts ─► src/node/agent (Codex CLI / Claude Code, no shell)
```

Details, data contracts and extension points: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 2.3 Module boundaries

| Module | Responsibility | May depend on |
| --- | --- | --- |
| `src/core` | schema (single source of truth), types, addresses, values, validation, geometry compiler, rig compile + evaluation, render list | zod only. **No Node APIs, no DOM**: the editor imports it in the browser. |
| `src/render` | software rasterizer, overlays, bitmap font, sheets, diff, GIF, PNG | core types. Browser-safe except `png.ts` (node:zlib); browser code imports `src/render/browser.ts`. |
| `src/node` | loading model files and textures, editor registry (`~/.rev2d/editors`: URL, open file and workspace root of each running editor) and the editor protocol types | core, render, Node |
| `src/api` | JSON-friendly high-level operations shared by CLI/MCP/server: layer syntax (`layers.ts`), pose options (`pose.ts`), frames and view boxes (`frame.ts`), sampling plans (`sampling.ts`), notes (`stats.ts`), sheets (`sheet.ts`), inspect/series/tracks (`inspect.ts`), `analyze.ts`, hit, info, templates, doc summaries (`docs.ts`); `index.ts` re-exports them | core, render, node |
| `src/ops` | edit ops on the **raw** document (`applyOps`, `describeOps`); `compose` and `follow` evaluate the model through `Rig` | core |
| `src/interop` | pure converters: Spine import / export (`spine/`), Live2D JSON files (`live2d/`), file detection (`detect.ts`); every result carries an `InteropReport` | core, render (raster, PNG); ops types only |
| `src/node/interop.ts` | interop file IO shared by CLI, MCP and server: reading a Spine export folder, writing output files, Live2D files -> ops, atomic model-file edits, report text | interop, ops, core, render, Node |
| `src/avatar` | the avatar builder: spec schema and checks, image operations (`image/`), agent tools (`tools/`: grid, overlay, vision check), features (`features/`), deformation fields, model builder, fold checker, `compileAvatar`, review poses, drawn variants, Mesh Avatar Studio import; `DESIGN.md` | core, ops (the op catalogue), lipsync (types), render **through its browser-safe files only** (`src/render/browser.ts` or `image.ts`, `draw.ts`, `font.ts`, `raster.ts`, `sheet.ts`; never `render/index.ts` or `png.ts`). **No Node APIs** (only tests use them): the editor compiles avatars in the browser |
| `src/lipsync` | text (kana, Hangul, romaji) and WAV loudness -> mouth animations on `MouthOpen` / `MouthForm`; the viseme table | core (easing) only. Browser-safe |
| `src/node/avatar.ts`, `src/node/avatar-variants.ts` | avatar project IO: create, load, build, review, vision-check files, variants request / import / status, MAS import | avatar, core, render, ops, Node |
| `src/node/agent` | the in-app agent runner: providers (Codex CLI, Claude Code), process start without a shell, preamble and task templates, jobs, logs, settings | Node, `src/api/templates.ts` (the package root); no core. Its UI types are re-exported by `src/node/editor-registry.ts` |
| `src/cli` | `rev2d` commands, flags, help, `--json` output | api, ops, node, render, core; server and mcp are imported lazily by `edit` / `mcp` |
| `src/mcp` | MCP server and tools | api, ops, node, render, core |
| `src/server` | editor HTTP server: model file API, SSE live reload, AI bridge (state/command/screenshot), file management confined to a workspace root (`workspace.ts`, `workspace-routes.ts`), interop routes, avatar mode (`avatar-routes.ts`, task templates in `avatar-agent-tasks.ts`), the in-app agent endpoints (`agent-routes.ts`) | api, node (incl. `node/agent`, `node/avatar.ts`), interop, avatar (loaded on first use), render, core |
| `editor/` | React 19 + WebGL2 editor UI (the rows below describe its main folders) | `src/core`, `src/avatar`, `src/lipsync` via relative imports (`src/render/browser.ts` is available when it needs raster code), `src/interop/detect.ts` (file detection); type-only imports from `src/node/editor-registry.ts` and `src/node/interop.ts` |
| `editor/src/shell` | the window: SplitView layout, toolbar, status line, overlays; the registries for workspace modes, trailing panels and toolbar actions (`registry.ts`); `extensions.ts` imports the feature modules; the Rig mode (`rigMode.tsx`) | design, i18n, state, the Rig mode's panels and viewport, `files/`; never Avatar mode or the AI panel (feature modules register themselves) |
| `editor/src/design` | the design system: tokens, base styles, components, icons, appearance (see docs/DESIGN-SYSTEM.md) | React only. No editor state, no i18n (components get their few words through `setDesignStrings`) |
| `editor/src/i18n` | `t()` / `useT()`, languages en / ko / ja, one namespace file per feature under `locales/<lang>/` | design (`setDesignStrings`) |
| `editor/src/ai` | the AI panel and its public API (`api.ts`: `openAiPanel`, `startAiTask`, `useAiJob`, `aiAvailability`) | shell, design, i18n, state, `editor/src/api.ts`; type-only imports from `src/node/editor-registry.ts` |
| `editor/src/avatar` | Avatar mode: store, mode document (`avatar.json`), canvas with handles, parts list, live preview (`compileAvatar` in the browser), lip-sync page, new-avatar sheet | shell, design, i18n, state, `src/avatar`, `src/lipsync`, `src/core`; the AI panel only through `editor/src/avatar/ai.ts` (an `import.meta.glob` adapter for `editor/src/ai/api.ts`, so the mode works without it) |
| `scripts/` | example builders, texture generator, render scripts, demo media pipeline (`scripts/video/` → `docs/media/`) | anything |

Keep these boundaries: anything the editor imports must stay browser-safe (`src/core`,
`src/avatar`, `src/lipsync`: file IO goes into `src/node/avatar*.ts`), and `stdout` inside
`src/mcp` belongs to the protocol (never `console.log` there).

## 2.4 Conventions

- **ESM + NodeNext**: relative imports end in `.js` even for `.ts` sources
  (`import { Rig } from './rig.js'`). `verbatimModuleSyntax` is on: type-only imports use
  `import type`.
- **TypeScript strict**, no `any` leaks in public signatures; model types are inferred from
  `src/core/schema.ts` (`z.output` = normalized with defaults, `z.input` = what authors write).
- **Determinism is a feature.** No `Date.now()`, `Math.random()`, locale or platform dependence in
  core/render/api output. Physics steps at a fixed 60 Hz and re-evaluates its inputs per step. Renders, PNG and GIF bytes are
  tested for byte-identical output.
- **Writes use `formatModelJson`** (`src/core/format.ts`): stable, diff-friendly, numbers rounded.
  Preserve the file's line endings (CRLF stays CRLF) and do not rewrite unchanged files.
- **Diagnostics are the UX.** Every error names a JSON pointer, a stable kebab-case `code` and,
  whenever possible, a `hint` with the fix (did-you-mean via `suggest()` in `src/core/address.ts`).
  Ops errors carry a hint that is often a complete corrected op.
- **Stable machine output.** CLI `--json` shapes and MCP result JSON only ever gain fields. Data on
  stdout, notes/errors on stderr. Exit codes 0/1/2.
- **Tests live next to what they test**: `src/<module>/__tests__/*.test.ts` for unit tests,
  `test/*.test.ts` for cross-module and end-to-end tests (CLI, API, editor, examples). Write the
  failing test first for bug fixes. Docs with runnable content are tested too
  (`src/ops/__tests__/docs.test.ts` runs the OPS.md worked example; `src/mcp/__tests__/guide.test.ts`
  applies the guide recipes; `test/docs-recipes.test.ts` applies every RECIPES.md batch, runs every
  command block and checks the numbers the recipes quote; `test/docs-links.test.ts` checks links
  and anchors; `test/docs-commands.test.ts` checks that every `rev2d` command line in the guides
  uses real commands and flags; `test/docs-interop.test.ts` checks that every Spine / Live2D report
  code the guides name is one the converters use; `test/docs-avatar.test.ts` does the same for
  `avatar-*` codes and checks that docs/AVATAR.md covers every avatar subcommand, variant id and
  standard parameter).
- **No third-party art in the repository.** Avatar tests and docs images use Rev2D's own `hana`
  example rendered to a PNG (`test/fixtures/avatar-hana.ts`) or synthetic images; keep evaluation
  pictures of other people's characters in `out/` (git-ignored), never in tests, fixtures or docs.
- **Examples are generated.** Change `scripts/examples/<name>.ts`, run
  `npx tsx scripts/build-examples.ts`; `test/examples.test.ts` checks that each shipped file equals
  its builder's output and that the examples/README.md feature matrix is true.
- **Docs are product.** `rev2d docs` and MCP `rev2d_docs` serve docs/*.md and this file verbatim.
  When behavior changes, update SPEC/CLI/OPS/MCP and the relevant examples in the same change. MCP
  tool descriptions must stay under 2048 characters (Claude Code truncates longer ones).

## 2.5 Where to add features

Layered scenes: read [docs/SCENE.md](docs/SCENE.md). `src/scene` is browser-safe (schema, alignment,
timing, camera, evaluation, render-list composition and analysis). Files/models/WAV loading and
resource caches belong in `src/node/scene.ts`; optional ffmpeg and streaming output belong in
`src/node/video.ts`. CLI/MCP share those adapters. Keep a physics player per layer and pose, keep
symbolic narration times out of numeric evaluation, and never buffer the whole video. Synthetic
scene builders live in `scripts/examples/scene-assets.ts`; user assets remain local under `out/`.

Reusable asset libraries: read [docs/LIBRARY.md](docs/LIBRARY.md). Pure schema/keying/search/prompts live in `src/library`; files, external removers and build fingerprints live in `src/node/library.ts`. CLI and MCP share that IO. Fixtures are original vector builders in `scripts/examples/figure.ts` and `room.ts`, exposed by `test/fixtures/studio.ts`. Keep user artwork in ignored `out/`; import is not rigging or artistic approval.

| Feature | Touch |
| --- | --- |
| New model field / object | `src/core/schema.ts` (with `.describe()` text: it becomes the JSON Schema docs), semantic checks in `src/core/validate/checks-*.ts`, compile/evaluate in `src/core/rig/`, SPEC.md |
| New shape type | `ShapeSchema` in schema.ts, `SHAPE_FIELDS` in `src/core/address.ts`, `src/core/geometry/shapes.ts` + `compile.ts`, `src/core/rig/parts.ts`, editor inspector, SPEC §3.4 |
| New bindable property | `src/core/address.ts` (`*_PROPS`, `resolveTarget`), slots in `src/core/rig/compile.ts` + `evaluate.ts`, `set` checks in `src/ops/values.ts`, SPEC §4 |
| New diagnostic | `ctx.sink.error/warning/info(code, path, message, hint)` in `src/core/validate/`, a test in `src/core/__tests__/validate.test.ts` |
| New edit op | entry in `src/ops/catalog.ts` (summary, fields, example: drives MCP descriptions and hints), handler in `src/ops/*.ts` + `HANDLERS` in `src/ops/index.ts`, tests in `src/ops/__tests__/`, OPS.md |
| New CLI command | a `Command` in `src/cli/commands/*.ts`, registered in `src/cli/commands/index.ts` (help is generated), `test/cli.test.ts`, CLI.md |
| New MCP tool | `addTool` in `src/mcp/tools/*.ts` (input schemas in `src/mcp/schemas.ts`), tests in `src/mcp/__tests__/`, MCP.md, the tool list in `src/mcp/guide.ts` |
| New overlay layer | `src/render/overlay.ts`, `OVERLAY_LAYERS` in `src/api/frame.ts`, the editor overlay (`editor/src/overlay/`) |
| New animation-layer option | `AnimationLayer` in `src/core/types.ts` + schema, `src/core/rig/sampling.ts` / `events.ts`, the layer string syntax in `src/api/layers.ts` (CLI and MCP share it), `compose` in `src/ops/compose.ts`, `EditorLayer` in `src/node/editor-registry.ts`, SPEC §6.4 |
| New note (render/sheet/analyze) | `PoseStats` in `src/api/stats.ts`, the notes table in CLI.md |
| New recipe | a section in `docs/RECIPES.md` with `<!-- check:ops name=... -->` and `<!-- check:run chain=... -->` markers (see the comment at its top); `test/docs-recipes.test.ts` runs it, and quoted numbers get an assertion there |
| New editor bridge command | `EditorCommand` in `src/node/editor-registry.ts`, parsing in `src/server/protocol.ts`, handling in `editor/src/state/session.ts`, CLI sugar in `src/cli/commands/live.ts`, MCP `rev2d_editor_command` |
| New workspace (file-management) endpoint | a handler in `src/server/workspace-routes.ts` + `ROUTES` in `src/server/routes.ts`, request/result types in `src/node/editor-registry.ts`, validation in `src/server/protocol.ts`; resolve every path through `WorkspaceRoot` (`src/server/workspace.ts`); the client in `editor/src/api.ts`, UI in `editor/src/files/`; tests in `src/server/__tests__/workspace.test.ts`; the protocol section of CLI.md and ARCHITECTURE §5 |
| New example | `scripts/examples/<name>.ts` + `scripts/examples/index.ts`, rebuild, examples/README.md (text and feature matrix), predicates in `test/examples.test.ts` |
| New interop feature (a Spine / Live2D field) | the converter in `src/interop/spine/` or `src/interop/live2d/` (report what it cannot convert with a stable code), its tests with hand-written fixtures (never official sample assets); file IO in `src/node/interop.ts`; front ends in `src/cli/commands/interop.ts`, `src/mcp/tools/interop.ts`, `src/server/interop-routes.ts`, `editor/src/files/InteropDialogs.tsx`; docs/INTEROP.md |
| New avatar landmark / spec field | `src/avatar/schema.ts` (its `.describe()` text is the `rev2d avatar schema` documentation; mark fields that cut pixels "CUTS LAYERS"), checks with an `avatar-*` code and a hint in `src/avatar/spec.ts`, the editable part in `src/avatar/parts.ts` (editor handles, `avatar overlay --part`), `src/avatar/hash.ts` when it changes the layer images, labels and tips in `editor/src/i18n/locales/*/avatar.ts`, docs/AVATAR.md §4 |
| New avatar feature | a module in `src/avatar/features/` implementing `AvatarFeature` (`layers` / `compile` / `poses`; read `features/types.ts`) and an entry in `AVATAR_FEATURES`, its `AVATAR_Z` range, its parameters in `STANDARD_PARAMETERS` (Live2D ids) when standard; claim the pixels you cut; tests on the `hana` fixture (rest pose = illustration, no folds, determinism); `src/avatar/DESIGN.md`; the parameter / structure tables and common problems of docs/AVATAR.md |
| New drawn-variant id | `VARIANT_IDS` in `src/avatar/types.ts`, its edit area in `variants-areas.ts`, prompt in `variants-text.ts`, where it shows in `features/sprites.ts`, tests in `src/avatar/__tests__/variants*.test.ts`; the variant tables of CLI.md (`rev2d avatar variants`) and docs/AVATAR.md §7 |
| New agent task template | `registerTaskTemplate({kind, title, description, needsPrompt, build})` in a server module that the editor server imports (avatar ones in `src/server/avatar-agent-tasks.ts`); the title in `editor/src/ai/words.ts`; test it with `buildAgentPrompt`; docs/AGENT-BRIDGE.md §5 |
| New editor mode, trailing panel or toolbar action | `registerMode` / `registerPanel` / `registerToolbarAction` (`editor/src/shell/registry.ts`) in the feature's own folder, plus one import line in `editor/src/shell/extensions.ts`; a mode with its own file implements `ModeDocument` (Save / Undo / Redo / unsaved prompt); see `editor/src/shell/README.md`; e2e tests in a `test/*-e2e.test.ts` file |
| New UI string | the key in `editor/src/i18n/locales/en/<namespace>.ts` and the same key in `ko/` and `ja/` (the build and `test/editor-i18n.test.ts` fail without them); a new feature adds its own namespace file and spreads it in `locales/en.ts`, `ko.ts`, `ja.ts`; components use `useT()`, other code `t()` |

## 2.6 Before you finish

1. `npx vitest run <the paths you touched>` while iterating, then `npm test`.
2. `npx tsc --noEmit -p tsconfig.json` is clean.
3. `npm run editor:build` when you touched `editor/` or anything it imports (`src/core`,
   `src/avatar`, `src/lipsync`).
4. Docs updated (SPEC/CLI/OPS/MCP/RECIPES/AVATAR, examples/README.md) and still true: run the commands you
   documented; `npx vitest run test/docs-recipes.test.ts test/docs-links.test.ts test/docs-commands.test.ts test/docs-avatar.test.ts`
   checks the recipes, links, command lines and avatar codes.


Acting: read [docs/GESTURES.md](docs/GESTURES.md) before using `gesture apply`, `expression apply`,
the `act` op or scene `idle_alive`/gesture/expression references. New names belong in the pure
`src/gestures/` catalogue/generators; IO is shared in `src/node/acting.ts`. Review both motion and
contact positions; generated numeric gestures do not establish artistic fidelity.

Episodes: read [docs/EPISODE.md](docs/EPISODE.md) before storyboard work. `src/episode` is pure and
browser-safe (schema, cue/frame timeline, asset planning and scene compilation). All file IO,
worker processes, content hashes, ffmpeg/ffprobe, assembly and review belong in `src/node/episode*.ts`.
CLI/MCP share those adapters. Preserve polished source scenes through storyboard `scene` references;
do not flatten their tracks or replace them with old clips. A passing build proves timing/resource
validity, not artistic equivalence. Original episode builders live in `scripts/examples/episode-demo.ts`;
private user assets and renders stay in ignored `out/`.
