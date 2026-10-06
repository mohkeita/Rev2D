# rev2d command-line reference

`rev2d` is the text-first front end of Rev2D: create, validate, render, inspect and edit rigged 2D
models (`*.r2d.json`, see [SPEC.md](SPEC.md)), run the live editor, and serve the MCP server.
Every command is deterministic (same model + same flags = same bytes) and designed to be driven by
AI agents as well as humans.

```sh
npx rev2d help                 # list commands
npx rev2d help render          # flags and examples of one command (same as: rev2d render --help)
node bin/rev2d.js ...          # from a checkout (runs the TypeScript sources through tsx)
npm run rev2d -- ...           # same, via the package script
```

Contents: [Conventions](#conventions) · [AI verification loop](#ai-verification-loop) ·
[Shared flags](#shared-flags) ([animation layers](#animation-layers), [sampling](#sampling-flags)) ·
[Commands](#commands) ([import & export: Spine, Live2D](#import--export-spine-live2d)) ·
[Editor protocol types](#editor-protocol-types)

---

## Conventions

### Arguments

| Form | Meaning |
| --- | --- |
| `--flag value`, `--flag=value` | flag with a value |
| `-o value`, `-o=value`, `-ovalue` | short form (only `-o` for output and `-h` for help) |
| `--switch`, `--no-switch`, `--switch=false` | boolean switches |
| `--param A=1 --param B=2` | repeatable flags collect every occurrence; most also accept comma lists (`--param A=1,B=2`) |
| `--` | everything after it is positional |
| `-`, `-12`, `-.5` | positional values (stdin marker, negative numbers) |
| `--title=--x` | a value that itself looks like a flag needs the `=` form |

Flags may appear before, between or after positional arguments. A non-repeatable flag given twice
is a usage error (no silent "last one wins"). Unknown commands, subcommands, flags, parameter ids,
animation ids, overlay layers and doc topics are rejected with a did-you-mean hint.

Relative paths resolve against the current directory. Output files (`-o`) get their parent
directories created. In messages, paths inside the current directory are shown relative with `/`
separators; in `--json` output every path is absolute.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success (also: `diff` found differences but `--fail-on-diff` was not given; `hit` found nothing) |
| `1` | the model has errors, or the operation failed (unreadable file, failed op, size mismatch, editor unreachable, ...) |
| `2` | usage error: unknown command/flag, missing or malformed argument, unknown id in a flag |

### Output streams and `--json`

Data goes to **stdout**; notes, warnings and errors go to **stderr**. Every command that prints
data accepts `--json` and then prints exactly one JSON document to stdout (long-running commands
`watch` and `edit` print one JSON object per line, NDJSON). The shapes are listed with each command
and are stable: fields are only ever added.

Errors are always printed to stderr as text:

```
error: unknown parameter "Laen" in --param
hint: did you mean "Lean"?
usage: rev2d render <model> -o <out.png> [pose flags] [frame flags] [--json]
run "rev2d help render" for details
```

With `--json`, stdout additionally receives:

```json
{"ok":false,"exitCode":2,"error":{"kind":"usage","message":"unknown parameter \"Laen\" in --param","hint":"did you mean \"Lean\"?"}}
```

This error document is always a single line, so it also fits the NDJSON streams of `watch` and
`edit`. `kind` is `"usage"` (exit 2) or `"failed"` (exit 1). `hint` is present whenever the error
has one (did-you-mean, accepted forms, the fix), in text mode as the `hint:` line. Model errors
include `"diagnostics"`: the same `Diagnostic` objects as `validate --json`. `--json` counts when
given as `--json` or `--json=true` before any `--`. Set `REV2D_DEBUG=1` to append stack traces.

Notes are hints about results that are probably not what you meant. In text mode they are
`note: ...` lines on stderr; commands whose `--json` output has a `notes` array (`render`, `sheet`,
`gif`, `frames`, `analyze`, `ops`/`set`, `watch`) put them there instead. They cover:

| Note | Emitted by | Meaning / fix |
| --- | --- | --- |
| `--param AngleX=45 is outside its range [-30..30] and is clamped to 30` | every command with pose flags | evaluation clamps parameter values (SPEC.md §9) |
| `IK "legIk": target out of reach in 3 of 8 frames; extension up to 1.12, ...` | render, sheet, gif, frames, analyze | a two-bone chain cannot reach its target (extension = distance / max reach > 1) and snaps straight: move the target, lengthen the bones or set `"stretch": true` |
| `IK "legIk": chain nearly straight in 2 of 8 frames; extension up to 0.991 (> 0.98), ...` | same | visible knee/elbow snapping risk: set `"softness"` (px) or keep the target closer (not emitted when softness > 0) |
| `physics "hair": HairSway clamped in 34% of frames; raw output up to 1.8 vs range -1..1, ...` | same | the pendulum output exceeds the parameter range and stops hard at the limit: lower the output `scale` or widen the range |
| `visible parts entirely outside the view box: tail (3 of 8 frames); ...` | render, sheet, gif, frames | only with the default (canvas) view box: parts that left the canvas. Use `--viewbox fit` to include them. A part only partly outside is not noted, and an explicit `--viewbox x,y,w,h` crop leaves parts out on purpose, so it gets no such note (the `inView`/`outsideView` split of `render` is still reported) |
| `the visible parts [45, 95, 179, 60] lie entirely outside the view box; ...` | render, sheet, gif, frames | nothing visible is in the view box (also for an explicit crop): the image shows only the background. The brackets hold the bounds of what is visible; move the `--viewbox` there or use `--viewbox fit` |
| `no part is visible in this frame (...)` | render, sheet, gif, frames | check opacity/visible values, bindings and animations |
| `warmup changes nothing here: the model has no physics` | sheet, gif, frames, analyze | `--warmup` only matters for physics |
| `cells are drawn at scale 0.344 so the 85-cell sheet fits 4096 px per side (...)` | sheet | without `--scale`, a sheet larger than 4096 px is drawn smaller; pass `--scale`, fewer cells (`--overview AngleX,AngleY`) or `--viewbox fit` |

Shares are written as "this frame" (one frame), "3 of 8 frames", "all 8 frames" or "53 of 240
frames (22%)".

Commands that load a model refuse to work on a model with errors (exit 1, diagnostics printed). A
model with warnings still works; text mode prints a one-line note on stderr.

---

## AI verification loop

The CLI is built so an agent can change a model and *prove* the change is right without a human.
Iterate on this loop:

1. **Validate** — `rev2d validate model.r2d.json --json`
   Every diagnostic has a stable `code`, a JSON pointer `path` into the file and usually a `hint`
   (did-you-mean, expected shape). Fix until `ok` is true. Use `--strict` to also clear warnings.
2. **Render with overlays** — `rev2d render model.r2d.json -o out/rig.png --overlay bones,warps,labels --viewbox fit --scale 2`
   Look at the image. The text/JSON summary also tells you which parts are visible (in the view box
   or outside it) and notes IK chains out of reach, clamped physics outputs and nothing visible.
   `--only foreArm --only-chain` focuses the overlays on one bone chain.
3. **Sheet sweeps** — `rev2d sheet model.r2d.json -o out/anglex.png --sweep AngleX` (and a second
   `--sweep AngleY` for a grid, `--overview` for every parameter at once, or `--anim idle --frames 12`
   for motion, with events under the frame they fall in). One image verifies a whole parameter
   range or animation; every cell is captioned with its values (long captions wrap onto up to 3
   lines instead of being cut).
4. **Inspect numbers** — `rev2d inspect model.r2d.json --param AngleX=30 --bone head --part mouth --json`
   Exact bone world transforms, part bounds/centers, deformed warp lattices, draw order, IK reach,
   physics outputs and every bound property. Assert geometry numerically ("the mouth center moved
   right by ~12 px") instead of eyeballing it. `--point 120,80@head` says where a point attached to
   a bone, warp or part ends up (`@sleeve` on a skinned part blends its bones); `--times 0:2:9 --track bone:hand.tip,ik:armIk` prints a compact table over time.
   `rev2d hit model.r2d.json x y` answers "what is under this pixel?".
5. **Analyze animations** — `rev2d analyze model.r2d.json --anim walk --warmup 10`
   One report per animation: parameter ranges used, physics outputs clamped (share of frames, peak
   raw value), IK chains out of reach or nearly straight, events with times, the loop seam (does the
   end match the start?) and parts leaving the canvas.
6. **Edit with ops** — `rev2d ops model.r2d.json edits.json --dry-run` then without `--dry-run`
   (or `rev2d set model.r2d.json bone:head.rotation=10`). Ops are atomic and validated: nothing is
   written unless every op succeeds and the result is valid. Add `--render out/after.png` to see
   the result in the same step. Then go back to 1.

Regression checks: render before and after a change at the same flags and compare with
`rev2d diff before.png after.png -o out/diff.png --fail-on-diff`; its `region` is the bounding box
of the changed pixels, so an unintended change elsewhere shows up as a region you did not expect. When a human is watching in the
editor (`rev2d edit`), `rev2d editor state --json` and `rev2d editor screenshot -o out/seen.png`
show exactly what they see, and `rev2d editor command` can pose the model for them.

---

## Shared flags

### Pose flags

Accepted by `render`, `sheet`, `inspect`, `hit`, `watch`, `ops`/`set` (for `--render`); `gif`,
`frames` and `analyze` accept them without `--time` (they sample the animation over time; see
[Sampling flags](#sampling-flags)). They follow the evaluation pipeline of SPEC.md §9.

| Flag | Meaning |
| --- | --- |
| `--time <seconds>` | global time for animation layers and physics (default 0; must be >= 0, else exit 2) |
| `--anim <layer>` | play an animation layer at `--time`; repeatable, later layers win. Layer syntax: [below](#animation-layers) (`idle`, `blink@0.5`, `talk@0.8,add`, `wink,once,start=2.5`) |
| `--param <id=value>` | set a parameter; repeatable or comma-separated `A=1,B=2`. Explicit values beat animations **and physics** (a physics output parameter given explicitly keeps that value; `inspect` shows the output as overridden) |
| `--physics` / `--no-physics` | simulate physics (default on). A single pose simulates from rest over at most the 60 s before `--time` (from t=0 when `--time` <= 60); sequences (`sheet --anim`, `gif`, `frames`, `analyze`, `inspect --times`) step it frame to frame |

In `sheet` (animation mode), `gif`, `frames` and `analyze` the first `--anim` is the animation being
sampled and further `--anim` flags are extra layers. The sampled animation follows the sampling
times, so it takes no `start=`/`time=` option (and in `sheet`/`analyze` no weight either). A
`--param` value outside the parameter's `[min, max]` is clamped by evaluation (SPEC.md §9, step 5);
a note says so.

### Animation layers

`--anim` (and the MCP `animations` array) takes a layer string:

```
id[@weight][,option]...
```

| Part | Meaning |
| --- | --- |
| `id` | animation id (did-you-mean on typos) |
| `@weight` | blend weight 0..1 (default 1); outside 0..1 is a usage error (exit 2) |
| `add` | `param:` tracks add `weight × (value − parameter default)` on top of the layers below (a gesture over an idle: `look_around` + `talk,add`) |
| `override` | the default: `param:` tracks blend toward their value (`p + weight × (value − p)`; the later layer wins) |
| `once` | the layer contributes nothing outside its window instead of holding its first/last key: a non-looping layer only plays in `[start, start + duration]` (one-shot blinks and winks); a looping layer only from `start` on (`talk,add,once,start=2` starts talking at 2 s). `once` on a looping animation without `start` > 0 changes nothing and is an error |
| `hold` | the default for non-looping animations: hold the first/last key outside `[0, duration]` |
| `start=<s>` | global time at which the layer starts: its local time is `time − start` (a wink at 2.5 s: `wink,once,start=2.5`). Without `once`, a non-looping layer holds its first key before `start` and a looping layer already plays there (only its phase shifts) |
| `time=<s>` | fixed layer-local time, independent of `--time` (not together with `start=`) |

Non-param tracks (bone/part/warp properties) are always additive deltas from the setup value,
whatever the mode (SPEC.md §5). Examples: `--anim idle --anim blink@0.5`, `--anim look_around --anim talk@0.8,add`,
`--anim idle --anim wink,once,start=1.2`. Errors name the offending piece: `unknown option "ad" in animation layer "talk,ad"` / `hint: did you mean "add"?`.

### Sampling flags

Accepted by `sheet` (animation mode), `gif` and `frames` (`analyze` takes `--frames`, `--fps` and
`--warmup`). They choose the times at which the first `--anim` is sampled; physics runs
incrementally from frame to frame.

| Flag | Meaning |
| --- | --- |
| `--fps <n>` | frames per second of animation time (default `meta.fps`; `analyze`: 60) |
| `--frames <n>` | exact frame count spread over the window (overrides `--fps` for sampling; `sheet` default 8) |
| `--from <s>` / `--to <s>` | the window in animation seconds (default 0 .. duration). `--to` may exceed the duration: looping animations wrap, others hold their last pose (a note says so) |
| `--times <a:b:n\|t1,t2,...>` | explicit sample times instead of `--frames`/`--fps`/`--from`/`--to`: `n` evenly spaced times from `a` to `b` (both included), or a comma list; every time >= 0 |
| `--warmup <s>` | looping animations only: run `k = ceil(warmup / duration)` whole cycles before the window, i.e. sample at `t + k × duration`, so physics is in its steady state. Captions, `times` and events stay animation-local; every layer's clock is shifted by the same amount. For a non-looping animation it is a usage error (sample later moments with `--from`/`--to` or `--times` instead) |

A window of exactly one cycle of a looping animation excludes its end (`t = to` looks like
`t = from`); other windows include both ends. At most 2000 frames.

### Frame flags

Accepted by `render`, `sheet`, `gif`, `frames`, `watch`, `ops`/`set` (for `--render`).

| Flag | Meaning |
| --- | --- |
| `--overlay <list\|all>` | debug layers `bones,mesh,warps,bounds,labels,grid` (comma list, repeatable), `all`, or `none` |
| `--only <ids>` | overlay focus: only these bone / warp / part ids are drawn by the bones, warps, mesh, bounds and labels layers (comma list, repeatable; the grid is unaffected). Needs `--overlay`; unknown ids are usage errors with did-you-mean |
| `--only-chain` | with `--only`: also draw the ancestor bones of the listed bones (their chain up to the root) |
| `--scale <n>` | output pixels per model pixel (default 1, must be > 0) |
| `--viewbox <x,y,w,h\|fit>` | model-space region to render; `fit` = union bounds of visible parts + padding, taken over all cells/frames in `sheet`, `gif` and `frames` (default: the canvas) |
| `--padding <px>` | padding for `--viewbox fit` in model px (default 16; only valid with `fit`) |
| `--bg <color>` | background override: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`, CSS names, `transparent` |
| `--ss <n>` | supersampling per axis, integer 1..4 (default 2) |

Overlay labels are placed greedily without overlapping: labels that share an anchor (bones with
the same joint, parts with the same bounds corner) are stacked directly below each other. A label
block that had to move away from its anchor gets a **leader line**: thin and dashed, in a lighter
tint of the label's color, from a dot on the anchor (bone joint or bounds top-left corner) to the
middle of the label's facing side. Solid lines are bounds (yellow) and bones; white dashed lines
are bone parent links. A moved part label is also indented 10 px to the right, so its leader leaves
the bounds edge at an angle instead of running along it; bone labels may move to the left of the
joint. Placement is deterministic.

---

## Commands

### Check & look

### rev2d validate

```
rev2d validate <model...> [--strict] [--json]
```

Loads each file like every other command does (JSONC parse, schema, semantic checks, texture
decoding, rig compile) and prints its diagnostics. Exit 1 when any file has errors (or warnings with
`--strict`).

Wildcards are expanded by rev2d itself (`rev2d validate "models/*.r2d.json"`), because cmd.exe and
PowerShell pass them to programs literally. Matches are validated in sorted order; a pattern that
matches nothing becomes a failed entry with a `file-not-found` diagnostic (`no file matches "..."`).

| Flag | Meaning |
| --- | --- |
| `--strict` | warnings also fail the file |
| `--json` | machine-readable report |

```
ok    hero.r2d.json  (0 errors, 0 warnings)
FAIL  bad.r2d.json
  error   /parts/0/parent  unknown-parent  unknown parent "bodyWarpp"  → did you mean "bodyWarp"?
  1 error, 0 warnings
2 files: 1 ok, 1 failed
```

`--json`: an array with one entry per argument, in order:

```json
[
  {
    "file": "/abs/bad.r2d.json", "ok": false, "errors": 1, "warnings": 0,
    "diagnostics": [
      { "severity": "error", "code": "unknown-parent", "message": "...", "path": "/parts/0/parent", "hint": "did you mean \"bodyWarp\"?" }
    ]
  }
]
```

A missing file is reported as a `file-not-found` diagnostic (not a crash).

### rev2d info

```
rev2d info <model> [--json]
```

Structure overview: every parameter with its range and what it drives / what drives it, the bone
tree with attached warps/parts and the parts skinned to each bone (`<- part:palm, skin:sleeve`),
warps, parts, bindings, IK constraints with their options, physics and animations. Start here with
an unfamiliar model.

```
BONES (local x,y rotation length)
  └─ root (180, 420) 0° len 0  <- part:pedestal
     └─ upperArm (0, -106) -60° len 150  <- part:upperArmPlate, skin:elbowBoot
        └─ foreArm (150, 0) 95° len 135  <- part:foreArmPlate, skin:elbowBoot
...
IK
  armIk: upperArm -> foreArm reaching ikTarget (mix 1, bendPositive true, stretch false, softness 0)
```

`--json` prints the `ModelInfo` object:

```jsonc
{
  "name": "hero", "size": [512, 512],
  "counts": { "parameters": 2, "textures": 0, "bones": 1, "warps": 1, "parts": 2, "bindings": 3, "ik": 0, "physics": 0, "animations": 1 },
  "parameters": [ { "id": "Lean", "min": -1, "max": 1, "default": 0, "group": "Body", "drives": ["warp:bodyWarp.offsets"], "drivenBy": ["animation:idle"] } ],
  "bones": [ { "id": "root", "x": 256, "y": 384, "rotation": 0, "length": 0, "children": [], "attached": ["warp:bodyWarp"], "skinned": [] } ],
  "warps": [ { "id": "bodyWarp", "parent": "root", "rect": [120, 120, 272, 272], "grid": "2x2", "children": ["part:body"] } ],
  "parts": [ { "id": "body", "shape": "ellipse", "parent": "bodyWarp", "skin": null, "z": 0, "mask": null, "tags": [] } ],
  "bindings": [ { "target": "warp:bodyWarp.offsets", "params": ["Lean"], "keys": 3 } ],
  "animations": [ { "id": "idle", "duration": 2, "loop": true, "targets": ["param:Lean"], "events": 0 } ],
  "ik": [ { "id": "armIk", "bones": ["upper", "fore"], "target": "handTarget", "mix": 1, "bendPositive": true, "stretch": false, "softness": 0 } ],
  "physics": [ { "id": "hair", "inputs": ["AngleX(x)"], "outputs": ["HairSway(angle)"] } ]
}
```

`attached` lists warps and parts parented to the bone, `skinned` the parts skinned to it (as
`"skin:<part id>"`; a part skinned to several bones appears under each).

### rev2d render

```
rev2d render <model> -o <out.png> [pose flags] [frame flags] [--json]
```

Renders one pose to a PNG and prints the size, view box, and which parts are visible (back to
front), split into those in the view box and those entirely outside it, and which are hidden.
[Notes](#output-streams-and---json) flag suspicious frames: IK chains out of reach or nearly
straight, physics outputs clamped to their range, parts entirely outside the canvas (the default
view box; not for a deliberate `--viewbox x,y,w,h` crop, whose split is still printed), nothing
visible in the view box, or `--param` values that are clamped.

| Flag | Meaning |
| --- | --- |
| `-o, --out <out.png>` | output file (required) |
| pose / frame flags | see [Shared flags](#shared-flags) |
| `--json` | machine-readable summary |

```
wrote out/hero.png (293x291, viewBox 122,110,293,291, scale 1, t=0s)
visible parts (2, back to front): body, eye
```

With parts outside the view box the second line splits (the note only for the default canvas view
box; an explicit `--viewbox x,y,w,h` crop prints the two lines without it):

```
visible parts in view (1, back to front): body
visible parts outside the view box (1): tail
note: visible parts entirely outside the view box: tail; use a "fit" view box (--viewbox fit) to include them
```

`--json`:

```json
{
  "file": "/abs/out/hero.png", "width": 293, "height": 291,
  "viewBox": [122, 110, 293, 291], "scale": 1, "time": 0, "overlay": ["bones", "labels"],
  "params": { "Lean": 0.5, "Squash": 0 },
  "visibleParts": ["body", "eye"], "inView": ["body", "eye"], "outsideView": [],
  "hiddenParts": [], "events": [], "notes": []
}
```

`visibleParts` = `inView` + `outsideView` (back to front); a part whose bounds merely touch the view
box counts as in view.

Examples:

```sh
rev2d render hero.r2d.json -o out/hero.png
rev2d render hero.r2d.json -o out/rig.png --overlay bones,warps,labels --viewbox fit --scale 2
rev2d render hero.r2d.json -o out/arm.png --overlay bones,labels --only foreArm --only-chain
rev2d render hero.r2d.json -o out/look-left.png --param AngleX=-30 --param EyeOpen=0.2
rev2d render hero.r2d.json -o out/idle-1s.png --anim idle --anim talk@0.8,add --time 1
```

### rev2d sheet

```
rev2d sheet <model> -o <out.png> (--anim <id> [sampling flags] | --sweep <spec> [--sweep <spec>] | --overview [ids] [--steps n])
            [--columns n] [--title t] [pose flags] [frame flags] [--json]
```

A contact sheet: many captioned renders in one PNG. Exactly one of three modes:

- **Animation sheet** (`--anim id`): cells at `--frames` (default 8) evenly spaced times over the
  window `--from`/`--to` (default the whole animation; a looping animation over exactly one cycle
  excludes `t = duration`), or at `--times`; `--warmup` for looping animations with physics (see
  [Sampling flags](#sampling-flags)). Physics runs incrementally frame to frame. The sampled
  animation plays at full weight from its own clock (`id@w` and options are rejected); extra
  `--anim` layers play on top and are named in the title (`hana - look_around + talk(add)`).
  Captions are the frame times (`t=0.50s`); the animation events in each cell's interval
  `[t, next t)` are listed on a second caption line in an accent color (`walk:footstep` for events
  of extra layers). `--time` is rejected (hint: `--from`/`--to`, `--frames`, `--times`).
- **Sweep sheet** (`--sweep spec`): one sweep is a row of cells; a second sweep makes a grid (the
  first varies across columns, the second down rows). Spec forms: `AngleX` (5 steps over the
  parameter's range), `AngleX=-30:30:7` (min:max:steps, steps a whole number >= 1),
  `AngleX=-30:30` (5 steps), `AngleX=-30,0,30` (explicit values), and **linked** parameters
  `EyeLOpen,EyeROpen=0:1:5` (every listed parameter gets the same value in each cell; the bare
  form `EyeLOpen,EyeROpen` needs equal ranges). Empty or malformed parts (`AngleX=`,
  `AngleX=0,,1`, `AngleX=0:1:0`) are usage errors; values outside the parameter's range are clamped
  by evaluation and reported in `notes`. `--param`, `--anim` and `--time` set the rest of the pose.
- **Overview** (`--overview [ids]`): one row per parameter (all parameters in model order, or the
  comma-listed ids), `--steps` values (default 5) evenly over each parameter's whole range,
  captioned `AngleX=-30`. The fastest way to see what every parameter does.

Captions wrap to the cell width onto up to 3 lines (events: 2), breaking at spaces first, then
after `,` / `;` / `:`, then before `=`; every cell reserves as many lines as the most wrapped
caption, so rows stay aligned and the layout is deterministic. A 2D linked sweep in a narrow cell
reads `EyeLOpen,` / `EyeROpen=0.333` / `AngleX=-30`. Only when 3 lines are not enough are the
parameter ids before `=` shortened (`EyeLO.,` / `EyeRO.=0.333`; values are never shortened), and
only then is text cut with `..`. Cells narrower than 4 characters keep one cut line.

Every cell uses the same view box, so cells are directly comparable: the canvas, an explicit
`--viewbox`, or with `--viewbox fit` the union of the visible bounds of **all** cells (plus
`--padding`). Notes cover all cells (IK reach, clamped physics, parts entirely outside the canvas
view box, nothing visible in an explicit crop).

| Flag | Meaning |
| --- | --- |
| `-o, --out <out.png>` | output file (required) |
| `--anim <id>` | animation to sample (first occurrence; see above) |
| sampling flags | `--frames` (default 8), `--fps`, `--from`, `--to`, `--times`, `--warmup` (animation sheets only) |
| `--sweep <spec>` | parameter sweep (max 2) |
| `--overview [ids]` | overview of all or the listed parameters |
| `--steps <n>` | overview: values per parameter, 1..64 (default 5) |
| `--columns <n>` | cells per row (default: first sweep length, overview steps, or a square-ish grid) |
| `--title <text>` | title bar (default: model name and what is shown, incl. extra layers, window and warm-up) |

At most 256 cells. Cells are drawn at `--scale` (default 1); without `--scale`, a sheet that would be
larger than 4096 px on a side is drawn at the largest scale that fits, with a note
(`note: cells are drawn at scale 0.344 so the 85-cell sheet fits 4096 px per side (at scale 1 it would be 2608x11226 px); ...`).
`--json` (`viewBox` is the model-space region of every cell, `scale` the cell scale):

```jsonc
{ "file": "/abs/sheet.png", "width": 1568, "height": 1085, "cells": 6, "columns": 3, "viewBox": [0, 0, 512, 512], "scale": 1,
  "mode": "sweep", "title": "hero - sweep Lean x Squash",
  "sweeps": [ { "param": "Lean", "values": [-1, 0, 1] }, { "param": "Squash", "values": [0, 1] } ], "notes": [] }
// linked sweep: { "param": "EyeLOpen", "values": [0, 0.5, 1], "linked": ["EyeROpen"] }
// animation mode:
{ "file": "...", "width": 0, "height": 0, "cells": 4, "columns": 2, "viewBox": [104, 96, 304, 312],
  "mode": "animation", "title": "hero - idle + talk(add)", "animation": "idle", "layers": ["talk,add"],
  "times": [0, 0.5, 1, 1.5], "warmup": 0, "events": [ { "cell": 1, "animation": "idle", "name": "breath", "t": 0.6 } ], "notes": [] }
// overview mode:
{ "...": "...", "mode": "overview", "overview": { "params": ["AngleX", "EyeOpen"], "steps": 5 } }
```

`layers` are the extra `--anim` specs as given; `warmup` is the pre-roll actually run (whole cycles,
seconds); `events[].cell` is the cell whose interval contains the event, `t` the event's own time.

```sh
rev2d sheet hero.r2d.json -o out/idle.png --anim idle --frames 12
rev2d sheet hero.r2d.json -o out/talk.png --anim look_around --anim talk,add --from 1 --to 3 --frames 9
rev2d sheet hero.r2d.json -o out/hair.png --anim idle --warmup 10 --frames 8
rev2d sheet hero.r2d.json -o out/anglex.png --sweep AngleX
rev2d sheet hero.r2d.json -o out/eyes.png --sweep EyeLOpen,EyeROpen=0:1:5
rev2d sheet hero.r2d.json -o out/grid.png --sweep AngleX=-30:30:5 --sweep AngleY=-30,0,30 --overlay warps
rev2d sheet hero.r2d.json -o out/overview.png --overview --steps 5
```

### rev2d gif

```
rev2d gif <model> -o <out.gif> --anim <id> [sampling flags] [--no-loop] [pose flags] [frame flags] [--json]
```

Renders an animation frame by frame (incremental physics) into an animated GIF with one shared
palette. The frames are the [sampling flags](#sampling-flags)' times (default: the whole animation
at `meta.fps`). Playback runs in real time: at `--fps`, or `frames / window` when only `--frames`
is given. GIF frame delays are whole centiseconds of at least 2 (browsers slow shorter delays down
to 10 cs), so a GIF above 50 fps plays at about 50 fps; a note says so. `--time` is rejected
(hint: `--from`/`--to`, `--fps`/`--frames`, `--times`).

All frames share one view box (like `sheet`): `--viewbox fit` covers the visible parts of every
frame, so the GIF does not jitter and every frame has the same size. The GIF is encoded from all
frames in memory: frames × width × height may not exceed 134M pixels (exit 2 with a hint; lower
`--scale`, crop with `--viewbox`, or use `frames`, which writes PNGs one by one). Notes cover all
frames.

| Flag | Meaning |
| --- | --- |
| `-o, --out <out.gif>` | output file (required) |
| `--anim <id>` | animation to play (required; `id@weight`/`add` allowed, no `start=`/`time=`); more `--anim` flags add layers |
| sampling flags | `--fps` (default `meta.fps`), `--frames`, `--from`, `--to`, `--times`, `--warmup` |
| `--loop` / `--no-loop` | loop forever (default) or play once |

At most 2000 frames. `--json`:

```json
{ "file": "/abs/idle.gif", "width": 128, "height": 128, "viewBox": [0, 0, 128, 128], "animation": "idle", "layers": [],
  "frames": 20, "fps": 10, "loop": true, "bytes": 65454, "times": [0, 0.1, 0.2], "warmup": 0, "notes": [] }
```

```sh
rev2d gif hero.r2d.json -o out/idle.gif --anim idle
rev2d gif hero.r2d.json -o out/walk.gif --anim walk --fps 15 --viewbox fit --scale 0.5
rev2d gif hero.r2d.json -o out/hair.gif --anim idle --warmup 10
```

### rev2d frames

```
rev2d frames <model> -o <dir> --anim <id> [sampling flags] [pose flags] [frame flags] [--json]
```

Writes `dir/frame_0000.png`, `frame_0001.png`, ... and `dir/manifest.json`. Sampling as for
`gif`. Stale `frame_NNNN.png` files from an earlier, longer run are deleted so the directory always
matches the manifest (other files are left alone). All frames share one view box (`--viewbox fit`
covers every frame), so they all have the manifest's `width` × `height`.

| Flag | Meaning |
| --- | --- |
| `-o, --out <dir>` | output directory (required, created if missing) |
| `--anim <id>` | animation (required) |
| sampling flags | as for `gif` |

`manifest.json`:

```json
{ "animation": "idle", "layers": [], "fps": 2, "width": 128, "height": 128, "viewBox": [0, 0, 128, 128],
  "times": [0, 0.5, 1, 1.5], "files": ["frame_0000.png", "frame_0001.png", "frame_0002.png", "frame_0003.png"] }
```

`times` are animation-local; with `--warmup` the manifest also has `"warmup": <seconds run before
the window>` (frame `i` shows global time `times[i] + warmup`). `viewBox` is the model-space region
of every frame (`[x, y, w, h]`; the top-left corner of pixel `(px, py)` is model point
`(x + px / scale, y + py / scale)`). `--json` prints the manifest fields plus `"dir"`,
`"manifest"` (absolute path of manifest.json), `"removedStale"` (number of deleted stale frames)
and `"notes"`.

```sh
rev2d frames hero.r2d.json -o out/idle --anim idle
rev2d frames hero.r2d.json -o out/walk --anim walk --frames 16 --overlay bones
rev2d frames hero.r2d.json -o out/jump --anim jump --times 0.4,0.5,0.6
```

### rev2d inspect

```
rev2d inspect <model> [pose flags] [--bone id]... [--part id]... [--warp id]... [--point x,y[@parent]]...
              [--times a:b:n|t1,t2,... | --frames n] [--track col,col,...] [--json]
```

Exact numbers for one pose, in canvas pixels (+y down, degrees clockwise): parameter values (after
animation, overrides, physics and clamping), bone world joints/rotation/scale/tips and final local
values, part visibility/opacity/z/bounds/center, deformed warp lattices, IK diagnostics, physics
outputs, draw order, every bound or animated property, and animation events at that time.

| Flag | Meaning |
| --- | --- |
| `--bone <id>` | only these bones (repeatable or comma list) |
| `--part <id>` | only these parts |
| `--warp <id>` | only these warps |
| `--point <x,y[@parent]>` | where a setup-space point ends up, deformed exactly like a part vertex attached there: to a bone (`120,80@head`, rigid), a warp (lattice) or a part: a **skinned part** (`150,300@sleeve`) blends its skin bones with the weights the point would get as one of its vertices, a part with a parent maps like that parent, a part in model space leaves it; or in model space (`120,80`, does not move). A bare id is looked up among bones and warps first, then parts; `bone:id`, `warp:id` or `part:id` picks the kind. Unknown ids are usage errors with did-you-mean; repeatable |
| `--times <a:b:n\|t1,...>` | a series: one result per time (`n` evenly spaced from `a` to `b`, or a list) |
| `--frames <n>` | a series of `n` frames over the first `--anim` (like `sheet` sampling: a loop excludes its end) |
| `--track <cols>` | compact table: one row per time, only these columns (repeatable, comma list; see below) |

With any of `--bone/--part/--warp`, only the selected kinds are reported: the other kinds' keys
are **omitted** (not empty), and `properties` is limited to the selected ids. `params`,
`drawOrder`, `events`, `ik`, `physics` (and `points` when requested) are always present.

**IK** (`ik`): per constraint, `reached` (the tip reaches the target within 0.01 px before `mix`),
`extension` = `distance` / `maxReach` (>= 1: the target is out of reach; > 0.98: nearly straight,
visible knee/elbow snapping risk), `error` (px between the chain tip and the target after solving),
`distance` (root joint to target), `maxReach` (sum of the world segment lengths), `bend` (two-bone:
interior angle at the middle joint, 180 = straight) and `stretch` (scale applied by `stretch`).
In text mode an extension above 0.98 of a two-bone chain is marked with `!`, and the `reached`
column reads `yes`, `NO` (out of reach), `soft` (within reach, but `softness` lets the tip trail the
target, so `reached` is false; not a problem) or `aim` (a one-bone constraint only points at its
target; it "reaches" only a target exactly one bone length away).

**Physics** (`physics`): per group and output parameter, `raw` (the pendulum output × scale before
clamping), `value` (written to the parameter), `clamped` (raw was outside the range) and
`overridden` (an explicit `--param` replaced it). Empty with `--no-physics`.

`--json` (`InspectResult`):

```jsonc
{
  "time": 0.5,
  "params": { "Lean": 1, "Squash": 0.4 },
  "bones": [ { "id": "root", "parent": null, "x": 256, "y": 384, "rotation": 0, "scaleX": 1.06, "scaleY": 0.92,
               "tip": [256, 384], "local": { "x": 256, "y": 384, "rotation": 0, "scaleX": 1.06, "scaleY": 0.92 } } ],
  "warps": [ { "id": "bodyWarp", "cols": 2, "rows": 2, "points": [[166.1, 141.1], [310.3, 141.1]] } ],
  "parts": [ { "id": "body", "visible": true, "opacity": 1, "z": 0, "bounds": [143.5, 147.1, 279.3, 238.3], "center": [283.2, 266.3] } ],
  "drawOrder": ["body", "eye"],
  "properties": { "bone:root.scaleY": 0.92, "warp:bodyWarp.offsets": [51.2, 0] },
  "events": [ { "animation": "walk", "name": "footstep", "t": 0.5 } ],
  "ik": [ { "id": "armIk", "bones": ["upper", "fore"], "target": "handTarget", "reached": false, "extension": 1.088,
            "error": 25.08, "distance": 310.08, "maxReach": 285, "bend": 180 } ],
  "physics": [ { "id": "hair", "outputs": [ { "param": "HairSway", "raw": 1.8, "value": 1, "clamped": true, "overridden": false } ] } ],
  "points": [ { "spec": "300,200@foreArm", "parent": "foreArm", "setup": [300, 200], "posed": [370.99, 268.22] } ]
}
```

Warp points are row-major, `(cols+1) × (rows+1)` of them. `bounds` is `[x, y, w, h]` or `null`.

**Series** (`--times` or `--frames n` with `--anim`): `--json` prints `{ "times": [...], "results":
[InspectResult, ...] }` (focus flags apply to every result); text mode prints one block per time
under `=== t=0.5s (2 of 9) ===`. Ascending times are evaluated like a game loop (one player:
incremental physics; `events` = the events crossed since the previous time, the first time only
those exactly at it); other orders are evaluated one by one. `--time` together with a series is a
usage error.

**Track tables** (`--track`): only the listed columns, one row per time (the series times, or the
single `--time`). Columns:

| Column | Cell |
| --- | --- |
| `param:<id>` | parameter value |
| `bone:<id>` | world `[x, y, rotation]` of the joint |
| `bone:<id>.tip` | world `[x, y]` of the tip |
| `bone:<id>.<x\|y\|rotation\|scaleX\|scaleY\|length>` | final **local** value (after bindings, animation and IK) |
| `part:<id>.center` / `.bounds` | `[x, y]` / `[x, y, w, h]` of the deformed bounds (`null` when empty) |
| `part:<id>.opacity` / `.z` / `.visible` | final opacity / z / static visibility |
| `ik:<id>` | `[extension, error]`; `ik:<id>.<reached\|extension\|error\|distance\|maxReach\|bend\|stretch\|mix>` for one field |
| `physics:<group>.<param>` | raw output (before clamping) |
| `point:<x>,<y>[@parent]` | posed `[x, y]` of a setup-space point (the comma inside is kept; `parent` as for `--point`: a bone, warp or part, e.g. `point:150,300@part:sleeve`) |
| any other address | its value in the pose's `properties` (e.g. `part:mouth.shape.ry`, `warp:face.offsets`); it must be animated or bound in the evaluated poses |

```
$ rev2d inspect examples/robot-arm/robot-arm.r2d.json --anim reach --times 0,1 --track ik:armIk,bone:hand.tip,param:ReachX,physics:cableSwing.Cable1
t  ik:armIk (extension, error)  bone:hand.tip (x, y)  param:ReachX  physics:cableSwing.Cable1
0  0.68, 0                      399.6, 261.49         0             0
1  0.99, 6.2                    488.08, 342.52        0.8           -2.3
```

(At t=1 the target is within reach, and the arm's IK `softness` lets the tip trail it by 6.2 px
instead of snapping straight.)

`--json`: `{ "times": [0, 1], "columns": ["ik:armIk", ...], "fields": { "ik:armIk": ["extension", "error"], "bone:hand.tip": ["x", "y"] }, "rows": [[[0.677, 0], [399.6, 261.492], 0, 0], ...] }`
(`fields` names the entries of array-valued cells). `--track` cannot be combined with
`--bone/--part/--warp/--point` (add them as columns); unknown columns are usage errors with a
did-you-mean hint.

```sh
rev2d inspect hero.r2d.json
rev2d inspect hero.r2d.json --param AngleX=30 --bone head --part mouth --json
rev2d inspect hero.r2d.json --anim idle --time 0.5 --point 256,180@head
rev2d inspect robot.r2d.json --anim reach --times 0:4:9 --track ik:armIk,bone:hand.tip,param:ReachX
rev2d inspect hero.r2d.json --anim idle --frames 8 --track physics:hair.HairSway,part:tail.center --json
```

### rev2d analyze

```
rev2d analyze <model> --anim <id> [--anim layer]... [--frames n | --fps f] [--warmup s] [--no-pixels] [pose flags] [--json]
```

Samples the first `--anim` densely (default 60 frames per second of animation time, because
physics runs at 60 Hz) with incremental physics, extra `--anim` layers on top, and reports what you
would otherwise have to find by watching the animation:

- **PARAMETERS**: min..max of every changing parameter over the frames, and whether the range ends
  are reached; constant parameters on one line.
- **PHYSICS**: per output, the share of frames in which the raw output was clamped and the peak raw
  value (with its time) against the parameter range, e.g.
  `hair: HairSway clamped in 82 of 240 frames (34%), peak raw 1.8 at t=0.53s vs range -1..1`.
- **IK**: per constraint, the max extension (and when), frames out of reach (extension > 1) and
  nearly straight (> 0.98), the max tip error and the max stretch.
- **EVENTS**: every event with its time (events of extra layers with the frame they fall in).
- **LOOP SEAM** (looping animations): parameters and bone world transforms at the end of the loop,
  extrapolated to `t = duration` from the last two 1/60 s steps, against `t = 0` (a jump above 1%
  of a parameter's range, 0.5 px or 0.5° is listed), plus the share of pixels that differ between
  the first frame and the frame one loop later (physics and layers with other durations keep
  running; skip with `--no-pixels`).
- **BOUNDS**: the union of the visible bounds over all frames and every part that leaves the canvas
  (share of frames, max overflow and when); a part beyond the canvas in every frame (a floor wider
  than the canvas, a bust cut off at the bottom edge) is marked `always` and not repeated in the
  notes, which only report parts that leave the canvas during the animation.
- **NOTES**: the findings that need action, with the fix.

With physics, pass `--warmup` (e.g. 10): the analysis then starts after whole cycles of warm-up, so
clamping and the seam are measured in the steady state instead of from rest (a note reminds you).

| Flag | Meaning |
| --- | --- |
| `--anim <id>` | the analyzed animation (required, plain id); more `--anim` flags are layers (`talk,add`) |
| `--frames <n>` | exact frame count over the animation |
| `--fps <n>` | sampling rate in frames per second of animation time (default 60) |
| `--warmup <s>` | looping animations: whole cycles of warm-up first (usage error for non-looping ones) |
| `--pixels` / `--no-pixels` | render and compare the seam frames (default on) |

`--json` (`AnalyzeResult`):

```jsonc
{
  "animation": "reach", "layers": [], "duration": 4, "loop": true, "frames": 240, "fps": 60, "window": [0, 4], "warmup": 8,
  "params": [ { "id": "ReachX", "min": -0.9, "max": 0.8, "range": [-1, 1], "changes": true } ],
  "physics": [ { "group": "cableSwing", "param": "Cable1", "range": [-60, 60], "rawMin": -17.049, "rawMax": 12.82, "peak": -17.049,
                 "peakAt": 1.916667, "clampedFrames": 0, "clampedShare": 0, "overriddenFrames": 0 } ],
  "ik": [ { "id": "armIk", "bones": ["upperArm", "foreArm"], "maxExtension": 0.99, "maxExtensionAt": 1,
            "outOfReachFrames": 0, "nearStraightFrames": 20, "maxError": 6.199, "maxStretch": 1 } ],
  "events": [ { "animation": "reach", "name": "grab", "t": 1.2, "frame": 72, "at": 1.2 } ],
  "seam": { "ok": true, "params": [], "bones": [],
            "pixels": { "differentPixels": 0, "ratio": 0, "maxDelta": 0, "threshold": 8, "scale": 0.4 } },
  // a seam that does not close lists the jumps, e.g. "params": [ { "id": "Cable3", "start": 0, "end": 10.64, "jump": -10.64 } ],
  // "bones": [ { "id": "cable3", "distance": 0.22, "rotation": -10.64 } ]
  "bounds": [-10, 64.399, 660, 425.601], "canvas": [640, 480],
  "outsideCanvas": [ { "part": "floor", "frames": 240, "share": 1, "maxOverflow": 10, "at": 0, "always": true } ],
  "notes": []  // e.g. "IK \"armIk\": target out of reach in 53 of 240 frames (22%); ..." when a target leaves the reach
}
```

`seam` is `null` for non-looping animations (`pixels` is `null` with `--no-pixels`). Times are
animation-local. Usage errors (exit 2): no `--anim`, `--time`, `--frames` with `--fps`, `--warmup`
on a non-looping animation, options on the analyzed animation.

```sh
rev2d analyze hero.r2d.json --anim idle
rev2d analyze hero.r2d.json --anim look_around --anim talk,add --warmup 10
rev2d analyze robot.r2d.json --anim reach --fps 120 --json
```

### rev2d hit

```
rev2d hit <model> <x> <y> [pose flags] [--json]
```

Which parts cover canvas pixel (x, y), top-most first, testing the deformed fill and stroke
triangles of visible parts (masks and texture alpha are ignored). Negative coordinates are fine
(`rev2d hit m.r2d.json -5 10`). Finding nothing is not an error (exit 0).

`--json`: `{ "x": 256, "y": 180, "hits": [ { "partId": "eye", "kind": "fill" }, { "partId": "body", "kind": "fill" } ] }`

### rev2d diff

```
rev2d diff <a.png> <b.png> [-o diff.png] [--threshold n] [--fail-on-diff] [--json]
```

Pixel comparison of two same-size PNGs. A pixel differs when its largest channel delta (R, G, B or
A, 0..255) exceeds `--threshold`. Different sizes are an error (exit 1). The output locates the
change: `region` is the bounding box `[x, y, w, h]` (image pixels) of all differing pixels, `null`
when identical.

```
368 of 327680 pixels differ (0.112%) at threshold 0; max delta 227, mean delta 0.163; changed region [243, 319, 26, 18] (x, y, w, h)
```

| Flag | Meaning |
| --- | --- |
| `-o, --out <diff.png>` | write a visualization: image `a` dimmed to gray, differing pixels red |
| `--threshold <0..255>` | tolerance (default 0 = any change) |
| `--fail-on-diff` | exit 1 when any pixel differs |

`--json`:

```json
{ "a": "/abs/a.png", "b": "/abs/b.png", "width": 128, "height": 128, "threshold": 0, "identical": false,
  "differentPixels": 3671, "totalPixels": 16384, "ratio": 0.224, "maxDelta": 201, "meanDelta": 12.17,
  "region": [12, 30, 101, 88], "diff": "/abs/d.png" }
```

`diff` is `null` without `-o`.

### Create & edit

### rev2d new

```
rev2d new <file> [--template name] [--name n] [--size WxH] [--force] [--json]
```

Creates a model from a template, validates it and prints next steps. `blank` (default) is a small
complete rig: two parameters driving a warp and a bone, a gradient body, an idle animation.
`empty` is nothing but `format`, `version` and `meta` (name, width, height): the starting point
when you build the whole model with ops, without sample content to delete first (its next steps
point at `rev2d docs ops` and `rev2d ops`). Other templates are the shipped examples (`rev2d docs examples`); their texture files are copied next to
the new model, keeping their relative paths. Existing files (the model or a different texture file)
are never overwritten without `--force` (exit 1).

| Flag | Meaning |
| --- | --- |
| `--template <name>` | `blank`, `empty` or an example name |
| `--name <text>` | `meta.name` (default: the file name without `.r2d.json`; must not be empty) |
| `--size <WxH>` | canvas size for `blank` and `empty` (default 512x512, sides 1..8192); example templates keep their size (usage error) |
| `--force` | overwrite existing files |

`--json`:

```json
{ "file": "/abs/hero.r2d.json", "template": "blank", "name": "hero", "size": [512, 512], "textures": [],
  "diagnostics": [], "next": ["rev2d info hero.r2d.json", "rev2d render hero.r2d.json -o hero.png --overlay bones,labels", "rev2d edit hero.r2d.json"] }
```

### rev2d ops

```
rev2d ops <model> [ops.json | -]... [--op <json>]... [--dry-run] [-o out.r2d.json] [--allow-invalid]
          [--render out.png] [pose flags] [frame flags] [--json]
```

Applies high-level edit operations (add/update/remove/rename items, set setup values, ...; the
catalogue is in [OPS.md](OPS.md) / `rev2d docs ops`). The model's **raw** text is read (JSONC
allowed, defaults are not filled in, so edits stay minimal), the ops are applied in order and the
result is validated. It is all-or-nothing: the file is written — formatted with the diff-friendly
model formatter — only when every op succeeded and the result has no validation errors (or
`--allow-invalid`). Comments and trailing commas of a JSONC file are not preserved (a note says so).
An in-place edit that changes nothing (e.g. setting a value it already has) leaves the file
untouched, comments included (`written: false, changed: false`). A rewrite keeps the file's line
endings (LF or CRLF).

With `-o` into another directory, a note lists textures whose relative paths do not resolve from
there (texture paths are relative to the model file). Pose and frame flags only apply to
`--render`; without `--render` they are a usage error instead of being silently ignored.

Ops come from the file arguments in order (`-` = stdin, at most once), then from each `--op` in
order, and form **one** atomic batch: e.g. `rev2d ops hero.r2d.json 01-bones.json 02-parts.json
03-bindings.json` applies all three files or nothing. Each source may be a single op object, an
array of ops, or `{"ops": [...]}`. With more than one source, every op result names its source
(`"source": "02-parts.json"`, `"stdin"` or `"--op #2"`; also a column of the text table), and op
indexes count across the whole batch.

| Flag | Meaning |
| --- | --- |
| `--op <json>` | an op (or array of ops) as JSON; repeatable |
| `--dry-run` | apply and validate, write nothing |
| `-o, --out <out.r2d.json>` | write the result to another file (the model is left untouched) |
| `--allow-invalid` | write even if the result has validation errors |
| `--render <out.png>` | render the result (pose/frame flags apply to it); also works with `--dry-run` |

Exit 1 when an op fails, the result is invalid, or a requested `--render` is impossible; exit 2
for malformed op JSON, no ops at all, or pose/frame flags without `--render`. The render runs after
the model is written: if it fails (e.g. the PNG path is a directory), the op results are still
printed, `written` says whether the model changed on disk, and `renderError` says why there is no
image.

```
applied 2 ops on hero.r2d.json
  ok  #0  add  added bone "arm" (local 12, -40)
  ok  #1  set  bone:arm.rotation = 20
wrote hero.r2d.json
```

`--json`:

```jsonc
{
  "ok": true,                         // every op applied, result valid (or --allow-invalid), render (if asked) done
  "file": "/abs/hero.r2d.json",       // the input model
  "output": "/abs/hero.r2d.json",     // where the result is (or would be) written
  "written": true, "dryRun": false,
  "changed": true,                    // the model content differs from the input
  "results": [ { "index": 0, "op": "add", "ok": true, "message": "added bone \"arm\" (local 12, -40)" },
               { "index": 1, "op": "set", "ok": false, "message": "unknown bone \"hed\"", "hint": "did you mean \"head\"?" } ],
                                      // with several sources each result also has "source": "edits.json" | "stdin" | "--op #1"
  "diagnostics": [],                  // validation of the result
  "render": { "file": "/abs/after.png", "width": 512, "height": 512 },   // null without --render
  "renderError": null,                // e.g. "not rendered: the ops failed" / "...: the result has validation errors"
  "notes": []                         // JSONC comments dropped, textures not resolvable from -o, clamped --param values
}
```

```sh
rev2d ops hero.r2d.json edits.json
rev2d ops hero.r2d.json 01-skeleton.json 02-parts.json 03-bindings.json --dry-run
rev2d ops hero.r2d.json --op '{"op":"set","target":"bone:head.rotation","value":10}' --dry-run
cat edits.json | rev2d ops hero.r2d.json - --render out/after.png --overlay bones
```

### rev2d set

```
rev2d set <model> <address>=<value>... [--dry-run] [-o out.r2d.json] [--allow-invalid] [--render out.png] [--json]
```

Shorthand for the `set` op: each assignment becomes `{"op": "set", "target": "<address>", "value": <value>}`
(changes the SETUP value). The value is parsed as JSON when possible (`15`, `true`, `[1,2]`,
`{"4":[1,2]}`), otherwise used as a string (`#ff0000`, SVG path data). The address syntax is
checked before anything runs (`bon:head.x` → did you mean "bone"?). Same flags, output and exit
codes as `ops`.

```sh
rev2d set hero.r2d.json bone:head.rotation=15
rev2d set hero.r2d.json part:eye.fill=#223344 part:eye.shape.ry=12 --render out/eye.png --viewbox fit
```

### Avatar from one illustration

`rev2d avatar <subcommand>` works on an **avatar project**: a folder with `avatar.json` (the avatar
spec: landmarks placed on one illustration) and `source.png` (the illustration, never modified).
Coordinates in the spec are pixels of the source image: origin top-left, +x right, +y down;
`imageLeft` / `imageRight` mean the left / right side of the image as you look at it. The picture
stays on this machine: nothing is uploaded. `<project>` is the folder or its `avatar.json`.

The loop for an agent: `avatar new` → look at `avatar grid` (whole image, then `--region` zooms) and
write the landmarks into `avatar.json` → `avatar validate` (what is missing or wrong, with hints) →
`avatar overlay` (see the landmarks on the picture) → fix → repeat. `avatar vision-check` tells an
agent beforehand whether it reads coordinates off images accurately enough. Then `avatar build`
(layer images and the model `<name>.r2d.json`) → `avatar poses` (review sheets: look at every one) →
adjust `avatar.json` → build again. The step-by-step guide (where each landmark goes, what to look
for in the review sheets, common problems) is [AVATAR.md](AVATAR.md) (`rev2d docs avatar`).

### rev2d avatar new

```
rev2d avatar new <image.png> <dir> [--name id] [--force] [--json]
```

Copies the PNG (ideally a front-facing bust with a transparent background) byte for byte to
`<dir>/source.png` and writes the draft `<dir>/avatar.json`: the image size filled in, every
landmark still `null`. Other image formats are refused with the way to convert them; an existing
project is not overwritten without `--force` (exit 1).

| Flag | Meaning |
| --- | --- |
| `--name <id>` | name of the avatar and of its built model `<name>.r2d.json` (default: the folder name made a valid id) |
| `--force` | replace an existing `avatar.json` / `source.png` in the folder (its landmarks are lost) |

```
created avatar project projects/miko: "miko", 1254x1254
  projects/miko/source.png   the illustration (a copy; never modified)
  projects/miko/avatar.json  draft spec: 20 landmarks to place
next steps:
  rev2d avatar grid projects/miko -o projects/miko/work/grid.png
  ...
```

`--json`: `{ok, dir, specFile, sourceFile, name, width, height, landmarksToPlace, notes, next}`.

### rev2d avatar import-mas

```
rev2d avatar import-mas <mas-project-dir> <dir> [--name id] [--image file.png] [--force] [--json]
```

Imports a Mesh Avatar Studio project (its `rig.json` version 1 and `source.png`; `<mas-project-dir>`
may also be the `rig.json` itself) as an avatar project: `<dir>/avatar.json`, a copy of the
illustration, and the drawn variants whose names Rev2D knows (`variants/eyes_closed.png`,
`mouth_a.png`, ...). Radians become degrees; `eyes[0]` / `eyes[1]` become `imageLeft` /
`imageRight` (`roi` → `region`); the mouth line (centre, angle, half length, bow) becomes two
corners; strands (`sigma` → `width` = 2 × sigma, `k` → `stiffness`, `max` → `swing`), buns (jiggle
attachments), accessories (pendulum attachments with their box as outline) and the hand (a cut-out
with its contact point) are carried over. Mesh Avatar Studio has no face oval and no chin point: both
are estimated from its face ellipses. Everything estimated, approximated or not imported is printed
as a `note:`; the imported spec is validated against the image (exit 1 when it has errors).

| Flag | Meaning |
| --- | --- |
| `--name <id>` | name of the avatar (default: the folder name) |
| `--image <file.png>` | the illustration the rig was made for (default: `source.png` in the Mesh Avatar Studio folder, else the only PNG there) |
| `--force` | replace an existing project in `<dir>` |

`--json`: `{ok, dir, specFile, sourceFile, name, width, height, sources: {rig, image}, variants, errors, warnings, diagnostics, notes, next}`.

### rev2d avatar validate

```
rev2d avatar validate <project> [--strict] [--json]
```

Checks the spec against its illustration. Diagnostics have the shape of `rev2d validate`: severity,
stable code, JSON pointer into `avatar.json`, message and a hint with the fix.

- **Structural** (`schema-*`, `json-syntax`): unknown keys with a did-you-mean, wrong types, unknown
  attachment kinds.
- **`avatar-missing-landmark`**: one per landmark that is still `null`, absent or an empty list,
  with the way to place it. A draft validates to one list of what is left to do.
- **Geometry** of everything already placed, so a half-finished draft gets feedback too:

| Code | Severity | Meaning |
| --- | --- | --- |
| `avatar-image-size-mismatch` | error | `image.width` / `height` differ from the real size of the illustration |
| `avatar-image-size` | warning | a very small (< 256 px) or very large (> 4096 px) image |
| `avatar-points-odd` | error | a point list with an odd number of values |
| `avatar-too-few-points` | error | a polygon with fewer than 3 points, a polyline (strand, brow) with fewer than 2 |
| `avatar-polygon-self-intersects` | warning | edges of a polygon cross (the message names the edges and the place) |
| `avatar-outside-image` | warning | coordinates outside the image (the body pivot may lie below it) |
| `avatar-polygon-outside-image` | error | a shape that cuts layers lies entirely outside the image |
| `avatar-eye-opening-outside-region` | error | an eye opening that is not inside its region (also: the two polygons swapped) |
| `avatar-eye-opening-exceeds-region` | warning | a few opening points stick out of the region by more than 1 px |
| `avatar-eyes-swapped` | error | `imageLeft` is not left of `imageRight` (by centroid) |
| `avatar-eyes-overlap` | error | the two openings overlap |
| `avatar-eye-region-contains-other` | error | a region reaches into the other eye |
| `avatar-outside-head` | error | an eye, the nose, a mouth corner or the chin outside the head ellipse |
| `avatar-face-outside-head` | warning | the face oval sticks out of the head ellipse |
| `avatar-band-order` | error | `head.neck` / `body.fade` with yStart >= yEnd |
| `avatar-neck-above-chin` | warning | the neck band starts so far above the chin that the chin keeps less than 90% of the head motion |
| `avatar-mouth-corners-swapped` | error | `mouth.imageLeft` is not left of `mouth.imageRight` |
| `avatar-mouth-area` | error | the mouth area does not contain a mouth corner |
| `avatar-duplicate-id` | error | two strands, or two attachments, share an id |
| `avatar-reserved-id` | error | an attachment id that names a generated layer (`base`, `hair`, `mouth`, ...) |
| `avatar-strand-root-outside-head` | info | a strand starts outside the head ellipse (reversed, or the ellipse is too small) |
| `avatar-pendulum-degenerate` | error | a pendulum whose pivot and tip coincide |
| `avatar-implausible-value` | warning | turn / tilt / sway / breath / swing far from usable values (often radians instead of degrees) |
| `avatar-post-op` | error | a `post` entry without an `"op"`, or with an unknown op |

File problems are diagnostics too: `avatar-source-missing`, `avatar-source-load` (not a PNG),
`avatar-source-outside-project` (`image.file` leaves the folder), `avatar-layers-load` (warning).

| Flag | Meaning |
| --- | --- |
| `--strict` | also fail (exit 1) on warnings |

```
FAIL  projects/miko/avatar.json
  error   /head/center  avatar-missing-landmark  Head ellipse: centre is not placed yet  → set "center" to [x, y] in source-image pixels: horizontally on the face centre, vertically slightly above the eyes
  ...
  20 errors, 0 warnings
20 landmarks to place: read coordinates with "rev2d avatar grid projects/miko" (add --region x0,y0,x1,y1 to zoom in), then look at them with "rev2d avatar overlay"
```

`--json`: `{file, ok, errors, warnings, landmarksToPlace, diagnostics, image: {file, width, height} | null, layers}`
where `layers` is `"not built"`, `"current"`, `"stale"` (the spec changed what the layer images are
cut from) or `"unknown"`. Exit 1 on errors (with `--strict` also on warnings).

### rev2d avatar grid

```
rev2d avatar grid <project | image.png> [--region x0,y0,x1,y1] [--step n] [--scale n] [-o out.png] [--json]
```

Draws a coordinate grid over the illustration: how coordinates are read off a picture. Labels are
**source pixel coordinates** on all four sides at any magnification, so the numbers read are the
numbers `avatar.json` wants. Every line is a dark and a light pixel side by side with the coordinate
exactly between them (readable on any artwork); lines on round coordinates are stronger; transparent
pixels show a checkerboard; the footer states region, magnification and spacing.

Without `--region` the whole image is shown (a 1254 px image: a line every 50 px, a label every
100 px). With `--region` the rectangle is enlarged by a whole number so its long side is about
1000-1600 px, pixels stay crisp squares, and an eye-sized region gets a line every 5 or 10 px:
coordinates can be read to about 2 px.

| Flag | Meaning |
| --- | --- |
| `--region <x0,y0,x1,y1>` | magnify this rectangle (two corners in source pixels; clipped to the image) |
| `--step <px>` | source pixels between grid lines (default: chosen from the magnification) |
| `--scale <n>` | output pixels per source pixel, a whole number 1..40 (default: chosen so the long side is about 1000-1600 px) |
| `-o, --out <out.png>` | the PNG to write (default for a project: `<project>/work/grid.png`, or `grid-x0-y0-x1-y1.png` for a region; required for an image file) |

`--json`: `{file, width, height, source, region: [x0, y0, x1, y1], scale, step, labelStep, origin: [x, y]}`;
the source point `(x, y)` is at output pixel `origin + (x - x0, y - y0) * scale`.

```sh
rev2d avatar grid projects/miko -o projects/miko/work/grid.png
rev2d avatar grid projects/miko --region 420,410,580,530 -o projects/miko/work/eye.png
```

### rev2d avatar overlay

```
rev2d avatar overlay <project> [--part group|item] [--zoom] [--grid] [--scale n] [-o out.png] [--json]
```

Draws the landmarks of `avatar.json` over the illustration in their group colours (fixed and
colour-blind friendly; legend in the footer), with rulers in source pixels. Ellipses get a cross at
their centre; polygons are closed; polylines (strands, brows) start with a ring at their root; points
are a ring around a dot; a band is a solid line at yStart and a dashed line at yEnd; a segment (mouth
corners, pendulum pivot → tip) runs from a ring to a dot. Works on an unfinished draft: what is not
placed is skipped and reported.

| Flag | Meaning |
| --- | --- |
| `--part <group\|item>` | one group (`head`, `eyes`, `mouth`, `face`, `cheeks`, `strands`, `attachments`, `body`) or the items whose id starts with the text (`eyes.imageLeft`, `strand.bang1`, `attachment.tassel`); every item is labelled with its id |
| `--zoom` | crop to what is drawn plus a margin, magnified; polygon and polyline vertices are numbered from 0 (their index in the point list) |
| `--grid` | also draw the grid lines of `avatar grid` over the picture |
| `--scale <n>` | output pixels per source pixel, a whole number 1..40 |
| `-o, --out <out.png>` | the PNG to write (default: `<project>/work/overlay.png`, with the part and `zoom` in the name) |

`--json`: `{file, width, height, region, scale, origin, drawn: [item ids], missing: [required item ids not placed], notes}`.

```sh
rev2d avatar overlay projects/miko -o projects/miko/work/overlay.png
rev2d avatar overlay projects/miko --part eyes.imageLeft --zoom -o projects/miko/work/eye.png
```

### rev2d avatar build

```
rev2d avatar build <project> [--json]
```

Builds the project: `avatar.json` + `source.png` → `textures/*.png` (the base layer and the layers cut
from the illustration), `textures/layers.json` (what the model compiler needs besides the spec) and
`<name>.r2d.json`, an ordinary Rev2D model: `render`, `sheet`, `inspect`, `analyze`, `edit` and the
exporters work on it. The model is **regenerated by every build**: change `avatar.json`, or add edit
ops ([OPS.md](OPS.md)) to its `"post"` list (they are applied after every build), never the model
file. Files whose content did not change are not rewritten; layer images of an earlier build that are
no longer produced are deleted.

The generated model: one warp `avatarWarp` over the whole image (a lattice with cells of about 2% of
the long side; `build.cell.body` in the spec overrides it) with the base image as its child, and
bindings for `AngleX` × `AngleY` (head turn, a 3 × 3 keyform grid), `AngleZ` (tilt), `BodyAngleX`
(sway) and `Breath`; the features built from the other landmarks (eyes, mouth, hair, attachments,
animations) add their layers, nested warps and parameters. Coordinates of the model are pixels of the
illustration.

The spec must have no errors (`avatar validate`). The built model is validated (0 errors, or the
build fails) and **checked for folds**: with every parameter at each end of its range, and at every
corner of `AngleX` × `AngleY` × `AngleZ` × `BodyAngleX`, no lattice cell and no mesh triangle may flip
or collapse.

| Report | Meaning |
| --- | --- |
| build issue `avatar-mesh-fold` (warning) | a warp lattice or a part mesh flips or collapses in a pose: the message names the parameters, the place (source pixels) and the remaining area; the hint says what to lower or widen |
| build issue `avatar-chin-weight` (warning) | the chin gets less than 90% of the head tilt: `head.pivot` sits too high |
| build issue `avatar-pivot-below-neck` (warning) | `head.pivot` lies below the end of `head.neck`: the tilt shears the neck instead of bending it |
| build issue `avatar-cell-clamped` (info) | `build.cell.body` would need more than 64 lattice cells per side and was raised |
| `model validation` | warnings and info of the model validator on the built model (same codes as `rev2d validate`) |

Warnings do not fail the build. Exit 1 when the spec has errors, a `"post"` op fails or the model
does not validate (nothing of the model is written then).

`--json`: `{ok, dir, name, modelFile, modelBytes, layersFile, layers: [project-relative PNG paths],
removed, postOps, warnings, issues: [{severity, code, message, path?, hint?}], stats: {layers,
parameters, textures, warps, latticePoints, latticeCols, latticeRows, parts, bindings, physics,
animations, turnPoints, tiltPoints, swayPoints, breathPoints, foldPoses, ...}, diagnostics, timings:
{loadMs, layersMs, compileMs, validateMs, foldsMs, writeMs, totalMs}, next}`.

```text
$ rev2d avatar build projects/hana
built projects/hana: "hana", 478 KB model, 1 layer image, 0 warnings
  projects/hana/hana.r2d.json  5 parameters, 1 warp (2091 lattice points; root 40 x 50 cells), 1 part, 4 bindings
  projects/hana/textures       base.png + layers.json
  time                         451 ms (layers 4 ms, compile 31 ms, validate 51 ms, fold check 109 ms, write 158 ms)
next steps:
  rev2d avatar poses projects/hana
```

### rev2d avatar poses

```
rev2d avatar poses <project> [--scale n] [--json]
```

Renders the review sheets of a **built** project into `<project>/review/`. Look at every one of them:

| File | Content |
| --- | --- |
| `review/poses.png` | one captioned contact sheet of the review poses: rest, eyes half / closed, mouth open, turn left / right, look up / down, tilt both ways, body sway both ways, plus the poses of the built features |
| `review/turn.png` | the 3 × 3 grid `AngleX` × `AngleY` (columns −30, 0, 30; the top row looks up) |
| `review/eyes.png` | the eye poses, cropped to both eyes and magnified |
| `review/mouth.png` | the mouth poses, cropped to the mouth and magnified |
| `review/summary.json` | the sheets (file, size, cells, scale, view box, captions), every pose with the parameter values used and its `moves` (how far each landmark of the spec travels in that pose, `[dx, dy]` in source pixels: `faceCenter`, `nose`, `chin`, `eyeImageLeft`, `earImageRight`, `neckPivot`, `shoulderImageLeft`, `chest`, ...), notes and timings |

Cells are small (about 400 px) on a mid-grey background with room around the canvas, because a
tilting or swaying head leaves the image: halos, a torn or folded mesh, a cut chin or a double edge
show, and a review takes a few seconds. Poses whose parameters the model does not have (a feature
that is not built) are skipped and named in a note. Check what you see against the numbers: the
`moves` in `summary.json` say, for example, that the nose travels 49 px and the ears 10 px at
`AngleX = 30`, and `rev2d diff` compares two renders pixel by pixel (cells of one sheet that look
alike or different at a glance are easy to misjudge). For one pose at full size use
`rev2d render <project>/<name>.r2d.json --param AngleX=30 -o out.png` (add `--overlay warps` for the
lattice), for motion `rev2d sheet` / `rev2d gif` on the built model.

| Flag | Meaning |
| --- | --- |
| `--scale <n>` | multiply the size of every cell (default 1; 2 shows more detail and takes about four times as long) |

Exit 1 when the project is not built yet (`avatar build` first) or its spec has errors.

`--json`: `{ok, dir, modelFile, sheets: [{kind, file, name, width, height, cells, columns, scale,
viewBox, captions, ms}], poses: [{id, label, params, moves?, skipped?}], summaryFile, notes, timings:
{loadMs, renderMs, writeMs, totalMs}}`.

```sh
rev2d avatar poses projects/hana
rev2d avatar poses projects/hana --scale 2 --json
```

### rev2d avatar variants

```
rev2d avatar variants <request|import|status> <project> [ids...] [--all] [--json]
```

Drawn eye and mouth variants. Closed eyes and an open mouth look far better **drawn** than deformed:
an image generator redraws the eyes or the mouth of a full-size copy of the illustration, and Rev2D
cuts the redrawn area out as a **sprite** that replaces the mesh deformation (the mesh stays the
fallback of every variant without a drawing). `[ids...]` may also be comma-separated.

| Variant | Shown |
| --- | --- |
| `eyes_closed` (recommended) | per eye, fully up to `EyeLOpen` / `EyeROpen` 0.12, gone at 0.2 |
| `eyes_half` | per eye, fully from `EyeOpen` 0.3 to 0.6, gone at 0.2 and 0.7 (under a closed sprite down to 0) |
| `eyes_smile` | per eye, by `EyeLSmile` / `EyeRSmile` (declared only with this variant), on top |
| `mouth_a` (recommended), `mouth_a_half`, `mouth_i`, `mouth_u`, `mouth_e`, `mouth_o` | at their point of the `MouthOpen` × `MouthForm` viseme table: a (1, 0), a_half (0.5, 0), i (0.35, 1), u (0.35, −1), e (0.6, 0.5), o (0.75, −1); above `MouthOpen` 0.15 the nearest drawn shape shows (it stands in for a missing one), at 0.15 and below the closed mouth; with drawn mouths the mesh mouth keeps `MouthForm` only |

While sprites cover an eye completely, its open-eye layers are hidden; every change between a sprite
and the mesh eye, or between two sprites, is one picture fading over another fully drawn one.

**`request <project> [ids...]`** writes, per variant, into `<project>/variant-requests/`:

| File | Content |
| --- | --- |
| `<id>.mask.png` | the edit mask at the source size: OPAQUE black = must stay identical, TRANSPARENT (white) = may change, soft in between. Eye variants share both eye regions slightly grown; mouth variants the mouth area ellipse |
| `<id>.prompt.txt` | the prompt for the image generator: what to draw, where (coordinates), and the hard constraints: the exact size and framing, every pixel outside the mask unchanged (the transparent background too), nothing added, the same style |
| `README.md` | the flow, the files, the mask convention and the rules of the check |
| `preview.png` | the illustration around the edit areas with them tinted (eyes yellow, mouth orange) |

Without ids it requests `eyes_closed` and `mouth_a`; `--all` requests every variant. Requests written
before are written again (the landmarks may have moved). The drawing of a variant goes to
`<project>/variants/<id>.png`, full size.

**`import <project> [ids...]`** checks every `variants/<id>.png` (or the named ones) and cuts the
accepted ones into sprites. A drawing is accepted when:

- its size is exactly the size of the source;
- outside the mask, the mean difference is at most `build.variantTolerance` of avatar.json (default
  2 of 255: recompression noise passes), at most 0.5% of the pixels changed by more than 40 levels,
  and the ring just around the edit area (where the sprite blends in) differs by at most 2.5 × the
  tolerance. Pixels of the source's transparent background do not count (a filled-in background is
  only noted);
- the picture is not shifted or zoomed: when the outside does not match, the check looks for the
  global shift (up to 8 px) or zoom (up to 8%) that explains it and names it ("shifted by 3 px to the
  right"); a shift of 2 px or more is rejected even when the rest is within the tolerance;
- inside the mask at least 2% of the editable area changed, for **each** eye of an eye variant.

Accepted drawings become feathered sprite layers `textures/sprite_<id>_<area>.png` (one per eye,
`imageLeft` / `imageRight`, or `mouth`). Where layers drawn above the sprites cover the area (hair
over the eyes, brows), the sprite holds what lies under them, so the composite at the sprite's pose is
the drawing itself. They are recorded in `textures/layers.json` (`variants` and `sprites`, with
fingerprints of the drawing, of the eye regions / mouth area and of the layers), and the model is
rebuilt from the existing layers. A **rejected** drawing is reported with the reason and a hint that
says what to ask the image generator next; an earlier accepted sprite of that variant stays. Deleting
`variants/<id>.png` and importing again removes its sprite. Other files in `variants/` are listed as
ignored (with a did-you-mean). `rev2d avatar build` keeps the sprites (a sprite image deleted by hand:
`avatar-variant-sprite-missing`; sprites cut for other eye regions, mouth area or layers:
`avatar-variant-stale`, import again). Review them with `rev2d avatar poses` (`review/eyes.png`,
`review/mouth.png`).

**`status <project>`** lists every variant with one state: `missing`, `requested` (mask and prompt
written), `drawn` (a drawing not imported yet), `accepted`, `rejected` (the last import refused the
current drawing; the reason is shown) or `stale` (the drawing, the eye regions / mouth area or the
layers changed since the sprite was cut: import again).

| Flag | Meaning |
| --- | --- |
| `--all` | `request`: every variant instead of the recommended ones |

Exit 1 when the project is missing, its spec has errors, `import` finds nothing to import (or the
avatar is not built yet), or a drawing is **rejected** (the accepted ones are imported all the same);
exit 2 for an unknown action or variant id.

`--json`:
- `request` → `{ok, dir, size: [w, h], transparent, requests: [{id, group, label, recommended, file,
  maskFile, promptFile, prompt, areas: [{key, bounds, grow, feather}]}], readme, preview, files, notes,
  next}`;
- `import` → `{ok, dir, accepted, rejected, kept, removed, variants, checks: [{id, ok, reason?, hint?,
  outsideDiff, insideChanged, group, tolerance, badShare, badBounds, nearDiff, nearLimit, areas: [{key,
  changed}], size, shift, scale, backgroundFilled, drawingHash, notes}], unreadable: [{id, file, reason,
  hint?}], ignored: [{file, reason, hint?}], sprites, deleted, layersFile, modelFile, modelBytes,
  warnings, issues, diagnostics, notes, timings: {loadMs, checkMs, compileMs, writeMs, totalMs}, next}`
  (`ok` is false when a drawing was rejected);
- `status` → `{ok, dir, name, built, variants: [{id, group, label, recommended, state, requested,
  drawn, sprite, stale: [reasons], rejection: {reason, hint?, ...} | null, check, file, maskFile,
  promptFile, unreadable?}], counts, ignored, notes}`.

```text
$ rev2d avatar variants import projects/hana
imported 2 drawings of projects/hana: 1 accepted, 1 rejected
  eyes_closed  accepted  outside 0 (limit 2), changed inside 42.8% (image left 42.8%, image right 42.8%)
  mouth_a      REJECTED  the whole drawing is shifted by 3 px to the right against source.png: edges outside the editable area differ by 49.5 on average, 0 with the shift undone
                         hint: Ask the image generator again with source.png and the mask variant-requests/mouth_a.mask.png (...) and add: "Keep exactly the same framing as the input image: no shift, crop, zoom or padding; only the transparent area of the mask changes." Or move the drawing back by 3 px to the left in an image editor and import it again.
model: projects/hana/hana.r2d.json (895 KB), sprites: eyes_closed
```

```sh
rev2d avatar variants request projects/hana
rev2d avatar variants request projects/hana eyes_closed eyes_half mouth_a --json
rev2d avatar variants import projects/hana
rev2d avatar variants status projects/hana --json
```

### rev2d avatar vision-check

```
rev2d avatar vision-check <make|score> <dir> [answer.json] [--seed n] [--size px] [--json]
```

A self-test for agents: can you read pixel coordinates off an image? `make <dir>` writes
`<dir>/vision-check.png`, a busy illustration-like picture with 12 numbered crosshair markers, and
`<dir>/vision-check.key.json`, the answer key (encoded; do not decode it). Find the point each
crosshair's four arms point at (a whole number in both axes) the way landmarks are read (`avatar
grid` on the PNG, then `--region` zooms) and write `{"1": [x, y], ..., "12": [x, y]}` to a JSON
file. `score <dir> <answer.json>` prints the error per marker, the mean and the largest error, and
advice (a constant shift, a scale factor from measuring in a resized copy, swapped axes). It passes
(exit 0) when the mean error is at most 4 px and the largest at most 10 px on a 1024 px image (the
limits scale with `--size`); otherwise exit 1.

| Flag | Meaning |
| --- | --- |
| `--seed <n>` | `make`: which image to generate (default 1); the same seed gives the same image |
| `--size <px>` | `make`: width and height, 256..4096 (default 1024) |

`--json`: `make` → `{ok, image, key, seed, size, markers, answerFormat, next}`; `score` →
`{ok, pass, mean, max, answered, total, limits: {mean, max}, markers: [{id, expected, answer, error}], bias, advice}`.

### rev2d avatar schema

```
rev2d avatar schema [-o schema.json] [--json]
```

Prints the JSON Schema of `avatar.json` (every field with its description; fields marked "CUTS
LAYERS" are the ones whose change requires rebuilding the layer images). With `-o` it is written to
a file (`--json` then prints `{"file": <absolute path>}`).

### Import & export (Spine, Live2D)

Convert between Rev2D and the public JSON formats of Spine and Live2D Cubism. Every conversion prints
a **report**: each approximated or dropped feature with a stable code, where it was found in the
source data and a hint (`report: 3 warnings, 12 info`, then `warnings:` and `info:` lines of the form
`code  where: message  → hint`, then `stats:`). `--json` adds the whole report as
`{format, direction, issues: [{severity, code, message, where?, hint?}], stats}`. What is converted
and how: [INTEROP.md](INTEROP.md) (`rev2d docs interop`). The Live2D `.moc3` model binary is
proprietary and is never read or written.

### rev2d import spine

```
rev2d import spine <skeleton.json> -o <out.r2d.json> [--atlas file] [--skin name] [--scale n] [--padding px]
                   [--name text] [--force] [--json]
```

Reads a Spine 3.8 - 4.2 skeleton JSON export with its atlas and page PNGs and writes a new model: the
model file at `-o` and the pages in `textures/` next to it (written with 5 decimals, so atlas
coordinates stay sub-pixel exact). Shear, non-normal transform inheritance, transform constraints and
image sequences are emulated (sampled where needed); path and physics constraints, two-color tint and
the other skins are not converted. The report lists all of them. The written model is validated with
its textures; exit 1 when it has errors. Existing files are never overwritten without `--force`
(identical texture files are fine). Binary `.skel` files are refused with a hint to export JSON.

| Flag | Meaning |
| --- | --- |
| `-o, --out <out.r2d.json>` | the model file to write (required) |
| `--atlas <file>` | the texture atlas (default: `<skeleton>.atlas` or `.atlas.txt` next to the skeleton, `x.atlas` for `x-pro.json` / `x-ess.json`, else the only atlas in that folder; several candidates are a usage error). Without any atlas the attachments are imported untextured (a note says so) |
| `--skin <name>` | the skin to import over `default` (default: `default`; the other skins are listed in the report) |
| `--scale <n>` | extra uniform scale of the skeleton (default 1) |
| `--padding <px>` | canvas margin around the setup-pose bounds (default 32) |
| `--name <text>` | `meta.name` (default: the output file name) |
| `--force` | overwrite an existing model or different texture files |

```
imported Spine skeleton spine/hero.json into models/hero.r2d.json: 12 bones, 9 parts, 2 animations
  atlas  spine/hero.atlas
  pages  spine/hero.png
wrote models/hero.r2d.json, models/textures/hero.png
report: 11 warnings, 16 info
warnings:
  spine-dark-color             slots[4] (head): two-color tint (dark color 202020) is not supported; ...  → bake the dark tint into the texture, ...
  ...
info:
  spine-bone-shear-pair        bones[8] (sheared): shear (setup 10°, 0°) is reproduced exactly with an extra bone "sheared-shear" ...
  ...
stats: animations 2, attachments.boundingbox 1, ..., bones 12, ..., parts 9, ..., slots 8, ..., tracks 39
validation: 0 errors, 0 warnings
next steps:
  rev2d render models/hero.r2d.json -o models/hero.png --overlay bones,labels
  ...
```

`--json`:

```jsonc
{
  "ok": true,                                   // the written model has no validation errors
  "file": "/abs/models/hero.r2d.json",
  "sources": { "skeleton": "/abs/spine/hero.json", "atlas": "/abs/spine/hero.atlas", "pages": ["/abs/spine/hero.png"] },
  "files": [ { "path": "/abs/models/hero.r2d.json", "status": "new", "bytes": 12877 },   // status: new | replaced | unchanged
             { "path": "/abs/models/textures/hero.png", "status": "new", "bytes": 143 } ],
  "report": { "format": "spine", "direction": "import", "issues": [...], "stats": {...} },
  "diagnostics": [],                            // validation of the written model (textures included)
  "notes": [],                                  // atlas choice, pages that could not be read
  "next": ["rev2d render ...", "rev2d sheet ...", "rev2d edit ..."]
}
```

```sh
rev2d import spine spineboy/spineboy-pro.json -o models/spineboy.r2d.json
rev2d import spine hero.json --atlas hero-pma.atlas --skin armored -o hero.r2d.json --json
```

### rev2d import live2d

```
rev2d import live2d <file.json>... --into <model.r2d.json> [--param-map standard|none|prefix|map.json] [--id name]
                    [--physics replace|merge|skip] [--display-info fill|overwrite|skip] [--no-motions] [--no-expressions]
                    [--dry-run] [--json]
```

Imports Live2D JSON files into an existing model, as edit ops applied atomically like
[`rev2d ops`](#rev2d-ops): every op applies and the result validates, or nothing is written (exit 1).
The file is rewritten formatted, keeping its line endings; the files are read as given (JSONC is not
accepted for Live2D files).

| File | Becomes |
| --- | --- |
| `.motion3.json` | an animation named after the file (parameter tracks, part opacity, events) |
| `.exp3.json` | a one-key animation `exp_<name>` for `add` layering (`--anim "exp_smile,add"`) |
| `.physics3.json` | physics groups (an approximation) |
| `.cdi3.json` | parameter and part descriptions, parameter groups |
| `.model3.json` | all of the above that it lists, read relative to it (at most one per call); files it lists that are also given on the command line are imported once, through it |

| Flag | Meaning |
| --- | --- |
| `--into <model.r2d.json>` | the model to import into, edited in place (required) |
| `--param-map <spec>` | Live2D <-> Rev2D parameter ids: `standard` (default: `AngleX` <-> `ParamAngleX`, `MouthOpen` <-> `ParamMouthOpenY`, ...), `none`, `prefix` (`Param` + id), or a JSON file `{"<Rev2D id>": "<Live2D id>"}` merged over the standard preset. Curves for parameters the model lacks are dropped and reported with a did-you-mean |
| `--id <name>` | the animation id of a single motion3 / exp3 file (usage error with several) |
| `--physics <mode>` | `replace` (default: removes the model's physics groups that drive the same parameters), `merge` (keeps them), `skip` |
| `--display-info <mode>` | `fill` (default: only missing descriptions / groups), `overwrite`, `skip` |
| `--motions`, `--expressions` | import the motions / expressions a model3.json lists (default on; `--no-motions`, `--no-expressions`) |
| `--dry-run` | convert, apply and validate, write nothing |

```
import into hana.r2d.json: 3 animations (exp_Smile, wave, free), 2 physics groups (PhysicsSetting1, PhysicsSetting2), removed physics hairFront, hairBack
  mini/mini.model3.json           model3
  mini/motions/wave.motion3.json  motion3  via mini/mini.model3.json
wrote hana.r2d.json
report: 12 warnings, 22 info
warnings:
  live2d-physics-replaced           mini/mini.model3.json: mini.physics3.json: existing physics group(s) hairFront, hairBack removed: ...  → use physics "merge" to keep them
  ...
info:
  live2d-moc-ignored                mini/mini.model3.json: FileReferences.Moc: the model binary "mini.moc3" is not read (the .moc3 format is proprietary and undocumented)  → ...
  ...
stats: parameters 3, parameterGroups 2, parts 1, physicsSettings 2, ...
```

**An animation with the same id is replaced.** When the model's animation was made in Rev2D (not
written by an earlier Live2D import), the report says so with a warning, because its tracks and
events are gone afterwards; replacing an earlier import is only noted. Check with `--dry-run` first,
and keep an animation by renaming it (`rev2d ops` with a `rename` op) or by importing the file under
another id (`--id`):

```
import into hana.r2d.json (dry run): 1 animation (idle; replaced: idle)
  idle.motion3.json  motion3
dry run: nothing written; without --dry-run this would write hana.r2d.json
report: 3 warnings, 4 info
warnings:
  ...
  live2d-animation-replaced    idle.motion3.json: animation "idle" already exists and was not written by a Live2D import: the imported animation replaces it (its tracks and events are no longer in the model)  → to keep it, rename it first ({"op":"rename","kind":"animation","from":"idle","to":"idle_own"}) and import again, or give a single motion3 / exp3 file another animation id (CLI --id, MCP id)
info:
  ...
```

`--json`: `{ok, file, written, dryRun, changed, sources: [{file, kind, via?}], summary: {animations,
replaced, physics, removedPhysics, updates}, files: [{path, status}] (the model when written),
results (per op, as in rev2d ops), diagnostics (validation of the result), report}`.

```sh
rev2d import live2d idle.motion3.json --into hana.r2d.json
rev2d import live2d Hiyori/hiyori.model3.json --into hana.r2d.json --physics merge --dry-run
rev2d import live2d F01.exp3.json --into hana.r2d.json --id smile --param-map map.json
```

### rev2d export spine

```
rev2d export spine <model> -o <dir> [--anim ids] [--fps n] [--texture-scale n] [--param-poses] [--name base]
                   [--tolerance n] [--max-page-size px] [--spine-version v] [--straight-alpha] [--json]
```

Writes `<base>.json` (a Spine 4.x skeleton), `<base>.atlas` and its PNG pages into the directory
(created; files of an earlier export are replaced, and the file list says which ones changed). Each
visible part becomes a slot with a textured mesh (its paint rasterized), warps become grids of bones
with exactly weighted meshes, shape changes deform timelines; parameters, bindings, physics and IK
are **baked** into the sampled animations. The pages have premultiplied alpha (`pma: true`), which
Spine runtimes expect.

| Flag | Meaning |
| --- | --- |
| `-o, --out <dir>` | output directory (required) |
| `--anim <ids>` | animations to export, comma list or repeated (default: all; did-you-mean on typos) |
| `--fps <n>` | sampling rate of the baked motion (default 30); key times are sampled too and fast motion is refined |
| `--texture-scale <n>` | raster scale of the part textures (default 1; 2 = crisper vector parts) |
| `--param-poses` | also export every bound parameter's min and max pose as one-frame animations `param/<id>/min`, `param/<id>/max` |
| `--name <base>` | base file name (default: `meta.name`) |
| `--tolerance <n>` | key reduction tolerance in px and degrees (default 0.05; 0 keeps every sampled key) |
| `--max-page-size <px>` | largest atlas page side (default 2048) |
| `--spine-version <v>` | version written to `skeleton.spine` (default `4.2.00`; `4.0.x` uses the 4.0 deform layout) |
| `--straight-alpha` | straight-alpha pages instead (configure the runtime with premultiplied alpha off) |

```
exported hero.r2d.json to Spine in out/hero-spine: 16 bones, 28 slots, 4 animations, 1 atlas page
  out/hero-spine/hero.json   220.4 kB  new
  out/hero-spine/hero.atlas  1.1 kB    new
  out/hero-spine/hero.png    37.9 kB   new
report: 0 warnings, 6 info
info:
  spine-root-renamed        bones: the synthetic Spine root bone is "rev2d-root" because a Rev2D bone is already called "root"
  ...
  spine-ik-baked            ik: 1 IK constraint(s) are baked into the bone rotations of every animation and exported with mix 0 ...
  ...
stats: animations 4, attachments 27, bones 16, ..., keys 560, keysSampled 4967, ..., slots 28
next: load out/hero-spine/hero.json with its atlas in a Spine runtime or the Spine editor (Import Data); the pages have premultiplied alpha (pma: true)
```

`--json`: `{ok, file, dir, files: [{path, status: new | replaced | unchanged, bytes}], report}`.

```sh
rev2d export spine hero.r2d.json -o out/hero-spine
rev2d export spine hero.r2d.json -o out/hero-spine --anim idle,walk --texture-scale 2 --param-poses
```

### rev2d export live2d

```
rev2d export live2d <model> -o <dir> [--anim ids] [--param-map standard|none|prefix|map.json] [--fps n] [--name base]
                    [--tolerance n] [--json]
```

Writes `motions/<id>.motion3.json` for every animation, `<base>.physics3.json` (when the model has
physics; an approximation), `<base>.cdi3.json` (parameter names and groups) and a partial
`<base>.model3.json` that lists them (no `Moc`, no `Textures`). The files drive a Live2D model built
in Cubism Editor whose parameter ids match (`--param-map`): copy them into its folder and merge the
model3.json `FileReferences` into its own. Eases are written as exact Bézier segments where Live2D can
express them and fitted within the tolerance otherwise (both reported); tracks a motion3 cannot hold
(bones, shapes) are reported.

| Flag | Meaning |
| --- | --- |
| `-o, --out <dir>` | output directory (required) |
| `--anim <ids>` | animations to export (default: all) |
| `--param-map <spec>` | as for `import live2d` |
| `--fps <n>` | `Meta.Fps` and the rate where curves must be sampled (default 30) |
| `--name <base>` | base name of the physics3 / cdi3 / model3 files (default: `meta.name`) |
| `--tolerance <n>` | allowed error of fitted eases, as a fraction of each segment's change (default 0.001) |

`--json`: `{ok, file, dir, files: [{path, status, bytes}], report}`.

```sh
rev2d export live2d hana.r2d.json -o out/hana-live2d
rev2d export live2d hana.r2d.json -o out/motions --anim idle,talk --param-map map.json --json
```

### Live editing

### rev2d watch

```
rev2d watch <model> [-o out.png] [pose flags] [frame flags] [--json]
```

Validates immediately and again whenever the model file or one of its texture files changes
(debounced ~100 ms; identical content is skipped), printing the diagnostics each time. With `-o`
every valid version is re-rendered. Runs until Ctrl+C (exit 0). Pose flags that stop matching the
model (e.g. a renamed parameter) are reported per run instead of ending the watch.

| Flag | Meaning |
| --- | --- |
| `-o, --out <out.png>` | re-render after every change that validates |

Text output: `[12:01:02] hero.r2d.json: ok (0 errors, 1 warning)` followed by the diagnostics and
`rendered out.png (512x512)`. `--json` prints NDJSON:

```
{"event":"watching","file":"/abs/hero.r2d.json"}
{"event":"check","time":"2026-01-01T12:01:02.000Z","file":"/abs/hero.r2d.json","ok":true,"errors":0,"warnings":0,"diagnostics":[],"render":{"file":"/abs/out.png","width":512,"height":512},"renderError":null,"notes":[]}
{"event":"stopped"}
```

### rev2d edit

```
rev2d edit [model | dir] [--root dir] [--port n] [--host h] [--allow-host name]... [--allow-agent] [--agent-codex-sandbox config|unelevated] [--no-open] [--json]
```

Starts the editor server (default `http://127.0.0.1:4777`) and opens it in the default browser.
With a model it opens that model; without one (or with a directory, which becomes the workspace
root) the editor starts on its **start screen** (new from template, open, recent files, import). An
**avatar project** (a folder with an `avatar.json`, or that `avatar.json` itself) opens in avatar
mode with the folder that holds the project as the default workspace root, so the editor can create
sibling avatars there; its spec is checked with the avatar validator, not as a model. The
editor live-reloads on external file changes and writes edits back to the file. The server registers
itself as `~/.rev2d/editors/<pid>-<port>.json` (`{pid, url, file, startedAt}`; `file` is the model
the editor has open **now**, `""` on the start screen; one process may run several servers, stale
entries of dead processes are ignored and cleaned up) so `rev2d editor ...` and the MCP server can
find it. Runs until Ctrl+C, then shuts down cleanly (exit 0) and removes its entry.

**File management.** The editor's File menu opens, creates (from a template), saves as, closes,
imports (model + PNG textures picked on your computer) and downloads models. It works inside a
**workspace root**:

- `--root <dir>` if given, else the model's directory, else the current directory. The model must
  lie inside the root (`rev2d edit models/hero.r2d.json --root .` gives the editor the whole project).
- Every path the editor or an agent names (absolute, or relative to the root) must resolve inside
  the root after following symbolic links / junctions: `..`, absolute paths elsewhere and links
  leading out are refused (HTTP 403 with a hint), and so are broken links. New files need portable
  names (no `\ : * ? " < > |`, no trailing dot or space, no device names such as `CON`).
- Recently opened models are kept in `~/.rev2d/recent.json` (`{"files": [...]}`, newest first, at
  most 10, shared by all editors); the editor lists the ones that still exist inside its root.
- "Save as" rewrites relative texture paths so they still point at the same PNG files from the new
  location (the result lists every rewrite); "new" copies an example template's PNGs next to the
  model; "import" refuses to replace different existing files unless you confirm (overwrite), and
  writes each picked PNG where the model references it (a model using `textures/atlas.png` gets
  the picked `atlas.png` in `textures/`: a file picker only yields file names).
- An agent switches the model with `rev2d editor command --open <file>` (or MCP
  `rev2d_editor_command {type: "open"}`); every editor tab follows, and commands sent right after
  the open (params, play, select, ...) apply to the newly opened model once it is loaded. Unsaved
  changes are the UI's concern: it asks before switching and warns before the page is closed.
- When the open model's file is deleted or moved away on disk, the editor keeps the model open as
  unsaved: Save writes it back, Save As stores it elsewhere, switching files asks first.

Edits from the editor are written with `PUT /api/model` `{text | doc, baseMtimeMs}`: when the file
changed on disk since the version the edit is based on (another program or an agent wrote it), the
write is refused with **409** `{mtimeMs}` and nothing is written, instead of silently overwriting
the other change; the editor reloads and the change can be re-applied. Without `baseMtimeMs` the
write is unconditional.

**Avatar mode.** An avatar project (`rev2d avatar new`, File > New Avatar from Illustration…, or
the start screen's "Avatar from an Illustration" card, which creates one from a single PNG) opens
in Avatar mode: the parts of `avatar.json` on the leading side, the illustration with a handle for
every landmark in the middle (drag to move, click a part to select it), and the live preview with
Pose, Lip sync and Selected on the trailing side. Before its first build the project has no model
yet: Avatar mode shows it all the same, and the trailing side lists the landmarks still to place
with Build Avatar once they are all there. After the build the mode switcher in the toolbar also
offers the Rig mode for the generated model; a newly opened avatar project starts in Avatar mode.

- In Avatar mode the toolbar's Save, Undo and Redo, Ctrl+S, Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y, the
  unsaved dot of the File button and the status line work on `avatar.json`; in the Rig mode on the
  model. Saving recompiles the model from the existing layer images; when an outline that cuts the
  layers moved, a banner offers Save and Rebuild Layers.
- Before New, Open, Import, Close, or a new avatar replaces a project with unsaved `avatar.json`
  edits, the editor asks "Save changes to `<project>/avatar.json`?" (opening the project's own
  model keeps them). An agent's `open` command cannot wait for an answer: the edits are reported
  as discarded.
- The first build opens the generated model in the same window and mode; changes an agent makes to
  `avatar.json`, the illustration or the layers show up at once.
- An agent opens a project in the human's editor with `rev2d editor command --open <project>/avatar.json`
  (or the folder); `rev2d editor state` names the project and the avatar part the human has selected.
- **Drawn Variants** (trailing side, under the preview pages) lists the drawn closed eyes and mouth
  shapes (`rev2d avatar variants`): a thumbnail of the area, the state (In Use, Out of Date, Rejected
  with the reason, Not Imported, Requested, Not Drawn) and, in a row's menu, Show in Preview and Remove
  Drawing. **Draw with AI…** starts an `avatar-variants` job of the AI panel with an agent that has an
  image generator (Codex); its sheet picks the variants and says that the illustration and the edit
  masks are sent to that provider's image generator. When no AI can draw, the reason shows with
  **Copy the Request** (the same flow as text for an agent in a terminal). **Import Drawings** imports
  drawings placed in `variants/` by hand as a job (its banner shows, like a build); the section's menu
  writes the masks and prompts and opens the instructions.

**AI panel.** The sparkles button in the toolbar opens the AI panel in the trailing sidebar: a
conversation with the **Codex CLI** or **Claude Code**, started by the editor in the workspace with
your login of that CLI (see In-app agents below and [AGENT-BRIDGE.md](AGENT-BRIDGE.md)). The panel
shows the agent's messages, commands, file changes and to-dos while it works; the model or avatar it
writes reloads at once. It needs at least one of the two CLIs installed and signed in, and the editor
bound to a loopback address (the default; otherwise `--allow-agent`); without that the panel says
what is missing. Avatar mode uses it for "Let AI Place Them" when a project is created (the agent
places the landmarks, builds and reviews), for "Ask AI to Fix This Part" in a part's menu and for
"Draw with AI…" in Drawn Variants (the `avatar-variants` task: Codex draws with its own image generator).

The model may have errors (the editor shows them under Problems); a note on stderr says how many.
Another note names editors that already have the same model open (a second editor still starts;
`rev2d editor ...` talks to the newest one).

| Flag | Meaning |
| --- | --- |
| `--root <dir>` | workspace root: the editor opens, creates, saves and imports files only inside it (default: the model's directory, else the current directory) |
| `--port <n>` | port, 0..65535 (default 4777; `0` picks a free port) |
| `--host <address>` | interface to bind (default `127.0.0.1`; other values print a warning, the editor can write files in the workspace) |
| `--allow-host <name>` | also answer requests addressed to this host name (repeatable or comma list) |
| `--allow-agent` | keep the in-app agent endpoints (`/api/agent/*`) although `--host` is not a loopback address (prints a warning) |
| `--agent-codex-sandbox <config\|unelevated>` | Windows only: the sandbox implementation in-app Codex runs use. `config` (default) leaves your Codex configuration alone; `unelevated` adds `-c windows.sandbox="unelevated"`, the one that needs no administrator setup. Beats the setting saved in `~/.rev2d/settings.json` |
| `--open` / `--no-open` | open a browser (default) or not |

As a DNS-rebinding guard the editor only answers requests whose `Host` is a loopback name or the
address it is bound to (with `--host 0.0.0.0`: any of the machine's IP addresses). To reach it
through a host name, e.g. `http://my-pc.local:4777` from another machine, add
`--allow-host my-pc.local`.

**In-app agents.** The editor can start the Codex CLI or Claude Code for a request and show its
progress (`GET /api/session`, `/api/agent/*`; protocol, security model and troubleshooting:
[AGENT-BRIDGE.md](AGENT-BRIDGE.md)). A run uses your login of that CLI and works inside the workspace
root, so these endpoints need a per-server token and exist only while the editor is bound to a
loopback address (`127.0.0.1`, `localhost`, `::1`). With any other `--host` they answer 404 unless
`--allow-agent` is given, which prints a warning: every machine that can reach the port could then
start agent runs with your login. On Windows, when Codex cannot start commands (its "elevated"
sandbox is not set up), `--agent-codex-sandbox unelevated` makes its runs use the sandbox that needs
no setup; the same setting can be saved for every editor with `PUT /api/agent/settings`
([AGENT-BRIDGE.md](AGENT-BRIDGE.md#8-troubleshooting)).

`--json` prints NDJSON: `{"event":"listening","url":"http://127.0.0.1:4777","file":"/abs/hero.r2d.json","root":"/abs","ui":{"mode":"static","detail":"..."},"agent":{"enabled":true}}`
(`file` is `null` without a model) then `{"event":"stopped"}`. `ui.mode` is `static` (built UI),
`vite` (development sources) or `none` (API only; `detail` says why). `agent.enabled` says whether
the agent endpoints exist (`false` comes with a `reason`).

```sh
rev2d edit hero.r2d.json                     # edit one model (workspace: its directory)
rev2d edit                                   # start screen, workspace: the current directory
rev2d edit models/hero.r2d.json --root .     # the whole project is the workspace
rev2d edit avatars/hana/avatar.json          # an avatar project in Avatar mode (workspace: avatars/)
rev2d edit hero.r2d.json --port 0 --no-open  # any free port, no browser
```

### rev2d editor state

```
rev2d editor state [--model f] [--url u] [--json]
```

What the human currently sees in a running editor: the model it has open and its workspace root,
parameter values (physics outputs included), time, playing animations, selection, overlays, the
visible region, the physics toggle and the parts hidden in the preview. In avatar mode it adds the
avatar part the human has selected (`avatar part: eyes.imageLeft.opening`, an id of `rev2d avatar
overlay --part`). The editor is found through the registry: the most recently started one, or the
one that has `--model` open now; `--url` skips discovery. With no model open (start screen) it
prints `no model open (start screen)`, the workspace root and the recent files, and exits 0; with an
avatar project that has no built model yet it prints `avatar project <dir> (no built model yet)`
and exits 0. Exit 1 when no editor is running, it is unreachable, or no browser has published its
state yet.

| Flag | Meaning |
| --- | --- |
| `--model <file>` | the editor of this model |
| `--url <url>` | explicit editor base URL, e.g. `http://127.0.0.1:4777` |

`--json`: `{ "editor": { "url": "...", "file": "/abs/hero.r2d.json", "root": "/abs", "pid": 1234 }, "state": <EditorState> }`
(see [Editor protocol types](#editor-protocol-types)); `file` and `state` are `null` when no model is
open. While an avatar project is open `editor` adds `avatar` (`AvatarRef`) and `state.avatar.part`
is the selected avatar part (`null` when none is; the state is published once the project has a
built model).

### rev2d editor command

```
rev2d editor command ['<EditorCommand json>'] [--open file] [--params A=1,B=2] [--reset] [--play [id]]
                     [--pause] [--seek t] [--anims layers] [--select ids] [--overlay list]
                     [--focus fit|x,y,w,h] [--message text] [--reload] [--model f] [--url u] [--json]
```

Drives the editor for the human: open another model, pose it, play animations, select items, show a
message. Pass `EditorCommand` JSON (an object or an array) and/or sugar flags; sugar commands are
sent after the JSON ones in this fixed order: open, reload, anims, params/reset, seek, play/pause,
select, overlay, focus, message. Parameter, animation and selection ids are checked against the
editor's model (with `--open`: the model being opened) with did-you-mean hints.

`open` switches the editor to another model of its workspace: the server opens it (it must lie
inside the workspace root; errors such as 403 outside the root or 404 missing come back with their
hint), resets the view state, updates its registry entry and every editor tab follows. As
everywhere in the CLI, a relative `file` (in `--open` or in the JSON) resolves against the current
directory. Model commands sent while no model is open are refused (`409 no model is open`).

| Flag | Command sent |
| --- | --- |
| `--open <file>` | `{"type":"open","file":"/abs/file"}` (sent first; prints `opened <file> ...`, `--json` adds `file` and `notes` to its `sent` entry) |
| `--params <A=1,B=2>` | `{"type":"setParams","params":{...}}` (repeatable) |
| `--reset` | with `--params`: `reset: true` (others back to defaults); alone: reset all parameters |
| `--play [id]` | `{"type":"play"}` or `{"type":"play","animation":"id"}` |
| `--pause` | `{"type":"pause"}` |
| `--seek <seconds>` | `{"type":"seek","time":t}` |
| `--anims <layers>` | `{"type":"setAnimations","animations":[{"id", "weight", "mode", "start", "hold"}]}`: layer strings as for `--anim` ([Animation layers](#animation-layers)), comma-separated or repeated; options attach to the layer before them (`--anims idle,talk@0.8,add,wink,once,start=2` = three layers). `time=` is refused: the editor plays layers on its own clock |
| `--select <ids>` | `{"type":"select","ids":[...]}` (`--select ""` clears) |
| `--overlay <list>` | `{"type":"setOverlay","overlay":[...]}` (`all`, `none` accepted) |
| `--focus <fit\|x,y,w,h>` | `{"type":"focus","viewBox":...}` |
| `--message <text>` | `{"type":"message","text":"..."}` |
| `--reload` | `{"type":"reload"}` |
| `--model <file>`, `--url <url>` | which editor (as for `editor state`) |

Prints how many editor windows received each command (`0` = no browser has the editor open).
`--json`: `{ "url": "...", "sent": [ { "command": { "type": "pause" }, "delivered": 1 } ] }`

```sh
rev2d editor command --open models/cat.r2d.json
rev2d editor command '{"type":"open","file":"hero.r2d.json"}'
rev2d editor command --open hero.r2d.json --params AngleX=30 --play idle
rev2d editor command --params AngleX=30,EyeOpen=0 --select head
rev2d editor command --play idle
rev2d editor command --anims idle,talk@0.8,add --play
rev2d editor command '{"type":"focus","viewBox":"fit"}'
rev2d editor command --message "Check the new mouth shapes" --overlay warps
```

### rev2d editor screenshot

```
rev2d editor screenshot -o <out.png> [--overlay list|none] [--scale n] [--viewbox fit|canvas|x,y,w,h] [--model f] [--url u] [--json]
```

Renders "what the human is looking at" server-side from the editor's published state (params,
time, animations), with the same renderer as `rev2d render`. Without flags it matches the editor
view: the human's pose, their overlays and the region visible in their viewport.

| Flag | Meaning |
| --- | --- |
| `-o, --out <out.png>` | output file (required) |
| `--overlay <list>` | overlay layers, `all`, or `none` (default: the overlays enabled in the editor) |
| `--scale <n>` | output pixels per model pixel (default 1) |
| `--viewbox <fit\|canvas\|x,y,w,h>` | region (default: the region visible in the editor, else the canvas) |
| `--model <file>`, `--url <url>` | which editor |

`--json`:

```json
{ "file": "/abs/seen.png", "width": 512, "height": 512, "url": "http://127.0.0.1:4777",
  "source": "editor-state", "viewBox": [0, 0, 512, 512], "scale": 1, "time": 0.5, "ignored": [] }
```

`source` is `"editor-state"`, or `"default-pose"` when no browser has published its view state yet
(a note says so). `ignored` lists ids in the editor state that the (edited) model no longer has,
e.g. `"param:AngleX"`. Server errors keep their hint and diagnostics (a model with errors cannot be
rendered: exit 1 with the diagnostics).

### Reference & integration

### rev2d schema

```
rev2d schema [-o schema.json] [--json]
```

Prints the JSON Schema (draft 2020-12) of the model format, or writes it with `-o, --out`. Use it
for editor completion; `validate` does the full semantic validation. The output is JSON either
way; with `-o`, `--json` prints `{"file": "/abs/schema.json"}` instead of `wrote schema.json`.

### rev2d docs

```
rev2d docs [topic] [--json]
```

Prints bundled documentation verbatim (Markdown). Topics: `spec` (docs/SPEC.md), `ops`
(docs/OPS.md), `cli` (this file), `mcp` (docs/MCP.md), `agents` (docs/AGENTS.md or AGENTS.md),
`recipes` (docs/RECIPES.md: one ops batch per technique, each with the commands that verify it),
`interop` (docs/INTEROP.md: Spine and Live2D import / export), `avatar` (docs/AVATAR.md: an
animated avatar from one illustration, the working guide for the `rev2d avatar` commands),
`architecture` (docs/ARCHITECTURE.md: modules, evaluation pipeline, renderer, editor, MCP),
`examples` (examples/README.md). Without a topic, lists them and whether each is installed; the
`recipes` description names every recipe, read from the numbered `## N. Name: ...` headings of the
installed docs/RECIPES.md, so it never drifts from the file (`22 recipes: starter model, head turn,
eye blink, ...`). Long descriptions wrap under their column. `ops`
falls back to the op catalogue built into rev2d when docs/OPS.md is missing, and `examples` always
ends with the generated list of templates (size, parameters, animations) for `rev2d new --template`.
The same fallbacks are used by the MCP `rev2d_docs` tool.

`--json`: `[ { "topic": "spec", "path": "/abs/docs/SPEC.md", "description": "...", "available": true } ]`
or, for a topic, `{ "topic": "spec", "path": "/abs/docs/SPEC.md", "text": "..." }` (`path` is
`null` when the text is entirely built in).

### rev2d mcp

```
rev2d mcp
```

Runs the Model Context Protocol server on stdin/stdout until the client disconnects (nothing else
is written to stdout). Relative model paths resolve against the working directory. Tools are
described in [MCP.md](MCP.md). Client configuration:

```json
{ "mcpServers": { "rev2d": { "command": "npx", "args": ["rev2d", "mcp"] } } }
```

Every command also accepts `-h, --help`.

---

## Editor protocol types

```ts
interface EditorState {
  file: string;                                   // absolute path of the open model
  params: Record<string, number>;                 // every parameter as shown, physics outputs included
  time: number;
  animations: Array<{ id: string; weight?: number }>;
  playing: boolean;
  selection: string[];
  overlay: string[];
  viewBox: [number, number, number, number] | null; // visible region in model space
  physics?: boolean;                              // the editor's physics toggle (its results are already in params)
  hidden?: string[];                              // parts hidden in the editor preview (not in the model)
  avatar?: { part?: string | null };              // avatar mode: the selected avatar part ("eyes.imageLeft.opening", ...)
  updatedAt: string;                              // ISO time of the last update
}

type EditorCommand =
  | { type: 'setParams'; params: Record<string, number>; reset?: boolean }
  | { type: 'play'; animation?: string }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  | { type: 'setAnimations'; animations: Array<{ id: string; weight?: number }> }
  | { type: 'select'; ids: string[] }
  | { type: 'setOverlay'; overlay: string[] }
  | { type: 'focus'; viewBox: [number, number, number, number] | 'fit' }
  | { type: 'reload' }
  | { type: 'open'; file: string }               // handled by the server (see below)
  | { type: 'message'; text: string };

// File management (the editor's workspace)
interface WorkspaceInfo { root: string; current: string | null; recent: string[]; avatar?: AvatarRef }
interface FileListing {
  dir: string;                                    // relative to the root, '' = the root
  parent: string | null;
  entries: Array<{ name: string; path: string; type: 'dir' | 'model' | 'image' | 'other'; size: number; mtimeMs: number;
    avatar?: { spec: string; name: string | null; model: string | null } }>;   // an avatar project folder, or its avatar.json
}
interface OpenResult { file: string; text: string; mtimeMs: number; notes: string[]; avatar?: AvatarRef }
interface TemplateInfo { name: string; description: string }

// Avatar mode (src/server/avatar-routes.ts; full field comments in src/node/editor-registry.ts)
interface AvatarRef { project: string; projectPath: string; specFile: string }   // projectPath: relative to the root
interface AvatarOpenResult { file: null; text: null; mtimeMs: 0; notes: string[]; avatar: AvatarRef }
interface AvatarInfo extends AvatarRef {
  name: string | null; specText: string | null; mtimeMs: number;
  image: { file: string; width: number; height: number } | null;
  built: { model: string | null; modelMtimeMs: number | null; meta: LayersMeta | null; stale: boolean; variants: string[] };
  files: Array<{ path: string; size: number; mtimeMs: number }>;
  diagnostics: Diagnostic[]; job: AvatarJobEvent | null;
}
interface AvatarSaveRequest { text?: string; doc?: object; baseMtimeMs?: number; compile?: boolean }
interface AvatarSaveResult {
  ok: boolean; written: boolean; diagnostics: Diagnostic[]; stale: boolean; mtimeMs: number;
  compiled: boolean; model: { file: string; mtimeMs: number; changed: boolean } | null; notes: string[];
  error?: { message: string; hint?: string; diagnostics?: Diagnostic[] }; hint?: string;
}
interface AvatarJobEvent {
  job: string; state: 'running' | 'done' | 'failed'; project: string; layers: boolean;
  step?: 'start' | 'build' | 'compile' | 'reload'; message?: string; hint?: string; diagnostics?: Diagnostic[]; log?: string;
  report?: AvatarBuildReport; stale?: boolean; startedAt: string; endedAt?: string; elapsedMs: number;
}
interface AvatarBuildReport {
  layers: boolean; name: string; modelFile: string; modelBytes: number; layerFiles: string[]; removed: string[];
  postOps: number; warnings: number; issues: AvatarIssue[]; stats: Record<string, number>;
  diagnostics: Diagnostic[]; timings: Record<string, number>;
}
interface AvatarNewRequest { image: { name: string; base64: string }; name?: string; dir?: string; unique?: boolean }
interface AvatarNewResult extends AvatarRef {
  specPath: string; name: string; mtimeMs: number; landmarksToPlace: number; notes: string[];
  image: { file: string; path: string; width: number; height: number; bytes: number };
}
interface AvatarChangedEvent { origin: 'editor' | 'external'; project: string; files: string[]; mtimeMs: number }

// Interop (src/node/interop.ts)
interface Live2dImportRequest {
  files: Array<{ name: string; text: string }>;   // .model3 / .motion3 / .exp3 / .physics3 / .cdi3 .json
  doc?: object;                                   // the model to import into (default: the open file)
  paramMap?: 'standard' | 'none' | 'prefix' | Record<string, string>;
  id?: string; physics?: 'replace' | 'merge' | 'skip'; displayInfo?: 'fill' | 'overwrite' | 'skip';
  motions?: boolean; expressions?: boolean;
}
interface Live2dImportResponse {
  ok: boolean; changed: boolean; doc: object;     // the resulting model (not written)
  results: OpResult[]; diagnostics: Diagnostic[]; report: InteropReport;
  summary: { animations: string[]; replaced: string[]; physics: string[]; removedPhysics: string[]; updates: number };
  sources: Array<{ file: string; kind: 'model3' | 'motion3' | 'exp3' | 'physics3' | 'cdi3'; via?: string }>;
}
interface ExportRequest {
  format: 'spine' | 'live2d';
  dir?: string;                                   // default exports/<model file name>-spine | -live2d
  doc?: object;                                   // default: the open file
  overwrite?: boolean; animations?: string[]; fps?: number; name?: string; tolerance?: number;
  textureScale?: number; paramPoses?: boolean; premultipliedAlpha?: boolean;   // spine
  paramMap?: 'standard' | 'none' | 'prefix' | Record<string, string>;          // live2d
}
interface ExportResponse { dir: string; files: Array<{ path: string; status: 'new' | 'replaced' | 'unchanged'; bytes: number }>; report: InteropReport; notes: string[] }
```

Because `params` already hold the physics results the human sees, `editor screenshot` renders the
state with physics off (re-simulating would replace them) and leaves the `hidden` parts out (they
still clip as masks); the response lists them in the `X-Rev2D-Hidden` header.

The HTTP endpoints behind these commands (`/api/state`, `/api/command`, `/api/screenshot`,
`/api/model`, ...) are served by `rev2d edit` on 127.0.0.1 only and reject requests whose `Host`
is not local. `GET /api/model` returns `{file, text, mtimeMs}`; `PUT /api/model` takes
`{text}` (raw JSON/JSONC) or `{doc}` (a model object, formatted on write, keeping the file's line
endings) plus an optional `baseMtimeMs`: when the file changed on disk since that version the write
is refused with **409** `{error, hint, mtimeMs}` and nothing is written (GET the model again and
re-apply the change; to overwrite on purpose, PUT again with `baseMtimeMs` = the returned mtimeMs).
A result with validation errors is not written either (200 `{ok: false, written: false,
diagnostics}`) unless `?force=1`. `PUT /api/model` also takes an optional `file` (the model the write
is for): when the editor has switched to another model meanwhile, the write is refused with **409**
`{error, hint, file}` instead of landing in the wrong file (POST `/api/state` checks its absolute
`file` the same way).

Workspace endpoints (file management; every path is absolute or relative to the workspace root and
must resolve inside it, else **403** with a hint):

| Endpoint | Body | Answer |
| --- | --- | --- |
| `GET /api/workspace` | | `WorkspaceInfo` |
| `GET /api/files?dir=<rel>` | | `FileListing`: directories, models (`*.r2d.json`), PNGs and other `*.json`; hidden entries and links leading outside the root are left out |
| `GET /api/templates` | | `TemplateInfo[]` (`blank`, `empty`, then every example) |
| `POST /api/open` | `{file}` | `OpenResult`; 404 missing, 400 directory, 422 not a Rev2D model (files not named `*.r2d.json` must hold `"format": "rev2d"`) |
| `POST /api/new` | `{file, template?, name?, width?, height?, overwrite?}` | `OpenResult`; creates parent directories, copies example textures, appends `.r2d.json` to a bare name; 409 when the file (or a different texture file) exists without `overwrite` |
| `POST /api/save-as` | `{file, doc? \| text?, overwrite?}` | `OpenResult`; writes the doc (or the open file as it is on disk), rewriting relative texture paths for the new location; 409 when the file exists without `overwrite` |
| `POST /api/close` | | `WorkspaceInfo` (no model open) |
| `POST /api/import` | `{dir?, files: [{name, text? \| base64?}], overwrite?}` | `OpenResult`; one model plus PNG textures written into `dir`; invalid JSON / non-models are refused with 422 and diagnostics, different existing files with 409, nothing is written on any error. A **Spine skeleton** JSON with its `.atlas` (text) and PNG pages is converted into `<skeleton name>.r2d.json` + `textures/` and opened; the answer adds `report` (the conversion report) and the notes summarize it |
| `POST /api/live2d-import` | `Live2dImportRequest` | `Live2dImportResponse`: the Live2D files converted into ops and applied to `doc` (or the open file), validated, **not written**: the editor writes the resulting `doc` with `PUT /api/model {doc, baseMtimeMs}` as one undoable edit. A model3.json finds the files it lists among `files` by path, else by file name. 400 bad options, 422 files that are not Live2D JSON |
| `POST /api/export` | `ExportRequest` | `ExportResponse`: `doc` (or the open file) exported into `dir` inside the workspace root; 422 with diagnostics when the model has errors, 400 unknown animations, 409 `{error, hint, files}` when different files exist without `overwrite` |
| `GET /api/download` | | the open model file with `Content-Disposition: attachment` |

While no model is open, the endpoints that need one (`/api/model`, `/api/texture/:id`,
`/api/screenshot`, `/api/info`, `/api/state`, `/api/download`, `/api/save-as` and commands other
than `open` / `message`) answer **409** `{"error": "no model is open", "hint": ...}`. The event
stream (`GET /api/events`) starts with `hello {file | null, mtimeMs, root}` and sends
`file-changed {file | null, origin: "editor" | "ai"}` whenever the open model changes (open, new,
save as, import, close; `ai` = an `open` command); `POST /api/command {"type":"open","file"}`
answers `{delivered, file, mtimeMs, notes}` (`delivered` = tabs that received `file-changed`).

**Avatar mode.** An avatar project is a folder with `avatar.json` and the illustration (`rev2d avatar
new`). The editor is in avatar mode while the open model has a sibling `avatar.json`, or after
`POST /api/open` (or the `open` command) named an `avatar.json` or a project folder: that opens the
built model, or, while there is none, the project **without a model** (`AvatarOpenResult`;
`/api/model` answers 409 until the first build). `hello`, `file-changed`, `GET /api/workspace` and
the open answers then carry `avatar` (`AvatarRef`), and `GET /api/files` marks project folders and
their `avatar.json` with `avatar`. `rev2d edit <project>/avatar.json` starts the editor on a project.

| Endpoint | Body | Answer |
| --- | --- | --- |
| `GET /api/avatar` | | `AvatarInfo`: the spec text and its `mtimeMs`, the illustration's size, the build state (`stale`: the layer images are older than the spec), the watched files, diagnostics, the last build job; 404 when no avatar project is open |
| `PUT /api/avatar` | `AvatarSaveRequest` | `AvatarSaveResult`: writes `avatar.json` (the previous content stays as `avatar.json.bak`; a draft with errors is saved too) and, when the spec is valid, the layers exist and `compile` is not false, recompiles the model from the existing layers and rewrites it (`model-changed`, origin `editor`); **409** `{error, hint, mtimeMs}` when `avatar.json` changed on disk since `baseMtimeMs` |
| `POST /api/avatar/build` | `{layers?}` or nothing | **202** `AvatarJobEvent` (state `running`, step `start`); `layers: false` only recompiles the model. One job at a time: **409** `{error, hint, job}` while one runs. The build runs `rev2d avatar build` as a child process; progress and the result arrive as SSE `avatar-job` events, the last one `done` (with `report`) or `failed` (with `hint`, `diagnostics`, `log`). On `done` the textures, `layers.json` and the model were rewritten and the model is open |
| `GET /api/avatar/build` | | `{job: AvatarJobEvent \| null}`: the latest event of the last job |
| `GET /api/avatar/file?path=<rel>` | | a file of the project folder (`source.png`, `textures/*`, `variants/*`, `variant-requests/*`, `review/*`, ...: PNG, JPEG, WebP, GIF, JSON, text) with its content type and an `ETag`; **403** outside the folder (also through a link) or a hidden file, **415** other types, 404 missing |
| `POST /api/avatar/new` | `AvatarNewRequest` | `AvatarNewResult`: creates `<dir or name>/` with `source.png` (the PNG byte for byte) and a draft `avatar.json`, and opens the project; **422** not a PNG (the hint says how to convert it) or more than 8192 px per side, **413** larger than 20 MB, **409** when the folder exists and is not empty (`unique: true` picks `<dir>-2`, ...) |
| `GET /api/avatar/variants` | | `AvatarVariantsInfo`: every drawn variant (`rev2d avatar variants status`) with its state (`missing`, `requested`, `drawn`, `accepted`, `rejected` with the reason, its stable `code` and `values`, `stale` with why), the check numbers, the edit areas in source pixels (`areas.eyes`, `areas.mouth`, for thumbnails) and the request files |
| `POST /api/avatar/variants/request` | `{ids?}` or nothing | `AvatarVariantRequestsResult`: writes the masks, prompts, `README.md` and `preview.png` of `rev2d avatar variants request` (no ids: the recommended ones and every earlier request); **400** unknown ids |
| `POST /api/avatar/variants/import` | `{ids?, remove?}` or nothing | **202** `AvatarJobEvent` with `kind: "variants"`: a job like a build (one job at a time, **409** while one runs) that deletes the `remove` drawings, runs `rev2d avatar variants import` and recompiles the model; the `done` event carries `variants` (`AvatarVariantsImport`: accepted, rejected with reason / hint / code, kept, removed, the variants in use, ignored files) |

SSE `avatar-changed` (`AvatarChangedEvent`) reports changes of `avatar.json`, the illustration and the
files in `textures/`, `variants/`, `variant-requests/` and `review/` (debounced): origin `editor`
for the server's own writes (a save, a build), `external` for every other program (an agent). The
in-app agent bridge has two avatar task templates: `avatar-create` (`context: {project}`: place the
landmarks, build, review, hand over) and `avatar-variants` (`context: {project, variants?}`, needs
`allowImageGeneration`: draw eye / mouth variants with the agent's own image generator); see
[AGENT-BRIDGE.md](AGENT-BRIDGE.md#5-the-preamble-and-task-templates).
