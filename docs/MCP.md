# Rev2D MCP server

`rev2d mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. It is
the main way AI agents (Claude Code, Claude Desktop, any MCP client) author, inspect and verify Rev2D
models: every tool takes plain JSON arguments, renders come back as inline PNG images, and every
problem comes back as a readable result with diagnostics instead of a crash.

## Setup

Requirements: Node 22+, and this repository with its dependencies installed (`npm install`).

### Claude Code

```sh
claude mcp add rev2d -- node /absolute/path/to/Rev2D/bin/rev2d.js mcp
```

Use `--scope project` to share the server with everyone working in a project; Claude Code then writes
`.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "rev2d": {
      "command": "node",
      "args": ["/absolute/path/to/Rev2D/bin/rev2d.js", "mcp"]
    }
  }
}
```

On Windows use forward slashes or escaped backslashes in JSON, e.g.
`"C:/Users/me/Rev2D/bin/rev2d.js"`. Check the connection with `claude mcp list` or `/mcp` inside
Claude Code.

### Other clients

Any client that launches stdio servers works with the same command, e.g. Claude Desktop
(`claude_desktop_config.json`):

```json
{ "mcpServers": { "rev2d": { "command": "node", "args": ["/absolute/path/to/Rev2D/bin/rev2d.js", "mcp"] } } }
```

### Paths

Relative paths in tool arguments (`path`, `save_to`, `a`/`b`, `model`) resolve against the server's
working directory: the directory the client started it in (for Claude Code, the project directory).
Absolute paths work anywhere; on Windows, Git Bash style drive paths (`/c/Users/me/hero.r2d.json`)
are accepted too. Models are loaded fresh from disk on every call, so edits made by hand, by the CLI
or by the editor are always picked up.

Programmatic use: `startMcpServer({ cwd })` starts serving on stdio and resolves once connected; the
server closes itself when the client disconnects (stdin ends), so the process can exit.
`createMcpServer({ cwd })` returns the configured `McpServer` without a transport (used by the tests
with `InMemoryTransport`). Both live in `src/mcp/server.ts`.

## Conventions

- **Coordinates**: setup space = canvas pixels, origin top-left, +x right, **+y down**. Angles are
  degrees, **positive = clockwise**. Geometry is absolute setup-space; bone transforms are local to
  the parent bone. Times are in seconds. See [SPEC.md](SPEC.md).
- **Results**: a human-readable text block, usually followed by a compact JSON block with the same
  data for exact parsing, and for render tools an `image/png` block.
- **Errors**: problems with the model or the arguments return `isError: true` with a message, a
  `hint:` line when there is a fix to suggest (did-you-mean for parameter, animation, part, bone,
  layer-option, track-column and template ids, accepted forms of sweeps, time lists and layer
  strings, the model files in a directory or next to a wrong path, the command to run) and, for
  model problems, the diagnostics as text and as JSON `{ok: false, error, hint?, diagnostics}`. Each
  diagnostic has `severity`, a stable `code`, a JSON-pointer `path` into the file, `message` and
  `hint`. Arguments that do not match a tool's schema (unknown keys, wrong types, out-of-range
  numbers) are rejected by the protocol layer with the offending key named.
- **Animation layers** (`animations` of every pose, `rev2d_sheet`, `rev2d_analyze`): applied in
  order, later layers win for `param:` tracks. Strings: `"idle"`, `"blink@0.5"` (weight 0..1), plus
  comma options `add` | `override` (param tracks add `weight × (value − default)` on top of the
  layers below instead of replacing them), `once` | `hold` (`once`: the layer contributes nothing outside its window
  instead of holding its first/last key: a one-shot only plays in `[start, start + duration]`, a
  looping layer only from `start` on; on a loop it needs `start` > 0),
  `start=<s>` (global time the layer starts: layer time = time − start; without `once` a looping
  layer also plays before it, phase-shifted), `time=<s>` (fixed layer
  time). Examples: `["look_around", "talk@0.8,add"]`, `["idle", "wink,once,start=2.5"]`. Objects:
  `{id, weight?, mode?: "override"|"add", start?, hold?, time?}`.
- **Explicit parameters win**: `params` override animation values AND physics outputs (a pinned
  hair parameter stays where you put it); physics diagnostics then report the output as
  `overridden`.
- **Image size**: without `scale`, renders are sized automatically: 1× reduced so the longest side is
  at most 1024 px, small views enlarged (up to 4×) to reach 512 px (the automatic scale keeps 3
  decimals, or 4 significant digits below 0.1, so even a view 2,000,000 px wide gets a positive
  scale such as 0.0004654; summaries print it that way). Contact sheets are kept within
  about 1024 px. An explicit `scale` is honored up to 2048 px per image side (4096 px for a whole
  sheet); beyond that the call fails with a hint (zoom with `viewBox` instead, or export large images
  with `rev2d render -o`). `save_to` writes the same PNG to disk.
- **Time**: `time` is at most 3600 s. Physics is simulated from t=0 at 60 Hz, so a timestamp or a
  value in milliseconds would otherwise stall the server.
- **Tool descriptions** stay within 2048 characters (Claude Code truncates longer MCP tool
  descriptions and server instructions). Longer reference material lives in input-field
  descriptions (e.g. one example per op in `rev2d_apply_ops.ops`) and in `rev2d_docs`.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `rev2d_guide` | — | Quickstart for AI authors: conventions, workflow, address grammar, op recipes (head turn with `bind_warp`, blink, physics hair, idle), pitfalls. **Call first.** |
| `rev2d_schema` | `name?` | JSON Schema of the model, or of one sub-schema (`Part`, `Shape`, `Binding`, `Animation`, `Physics`, ...; case-insensitive). |
| `rev2d_docs` | `topic`: `library` \| `spec` \| `ops` \| `cli` \| `mcp` \| `recipes` \| `interop` \| `avatar` \| `architecture` \| `examples` \| `agents` | The documentation file for the topic (`recipes` = docs/RECIPES.md, copy-paste op batches with their checks; the tool description lists every recipe by name; `interop` = docs/INTEROP.md, Spine and Live2D import / export; `avatar` = docs/AVATAR.md, an animated avatar from one illustration with the `rev2d avatar` CLI commands, also exposed through the avatar tools below; `architecture` = docs/ARCHITECTURE.md); `examples` lists every template with its parameters and animations; `agents` is AGENTS.md (the quickstart when an installation has none). |
| `rev2d_validate` | `path` | One line per diagnostic + JSON `{ok, file, errors, warnings, diagnostics}`; `isError` when the model has errors. |
| `rev2d_info` | `path` | Outline (parameters and what they drive, bone tree, warps, parts, bindings, IK, physics, animations) + the same as JSON. |
| `rev2d_render` | `path`, pose, `overlay?`, `only?` + `onlyChain?` (overlay focus on these bone/warp/part ids), `scale?`, `viewBox?` (`"fit"` or `[x,y,w,h]`), `padding?`, `background?`, `save_to?` | PNG + summary: image size, viewBox, scale, non-default params, visible and hidden parts, events, IK reach per constraint (`IK: armIk extension 1.08 (out of reach: misses the target by 12 px)`; otherwise `reaches the target`, `within reach; softness keeps the tip 2 px short` or, for a one-bone constraint, `one bone aiming at the target`) and `note:` lines for problems: IK targets out of reach or chains nearly straight (snap risk), physics outputs clamped to their parameter range, visible parts entirely outside the view (only when the view box is the canvas: an explicit crop leaves parts out on purpose) and nothing visible in the view box. |
| `rev2d_sheet` | `path`; one of `animation` (+ `frames?`/`fps?`, window `from?`/`to?`, explicit `times?`, `warmup?` seconds of physics pre-roll for loops), `sweeps` (`["AngleX=-30:30:5", "AngleY=-30,0,30"]`, max 2; linked `"EyeLOpen,EyeROpen=0:1:5"`) or `overview` (`true` or `{params?, steps?}`: one row per parameter over its range); `columns?`, `title?`, frame options, `save_to?` | One captioned grid image (max 64 cells); all cells share one viewBox (`"fit"` = union of all cells). Captions wrap onto up to 3 lines in narrow cells (the automatic scale accounts for them). Animation cells list the events that fall into them. `time` applies to sweep/overview cells only. `note:` lines as for `rev2d_render`, plus sweep values outside a parameter range. |
| `rev2d_inspect` | `path`, pose, `bones?`, `warps?`, `parts?` (id filters), `points?` (`["120,80@head"]` or `{x, y, parent}`; the parent is a bone, warp or part: a skinned part blends its skin bones like its own vertices, another part maps like its parent; `bone:`/`warp:`/`part:` pick the kind when ids are shared), series `times?` or `frames?`, `track?` columns | One pose: JSON with final params; bones (world joint, rotation, scale, tip, local values); warp points; part bounds/centers/visibility; draw order; bound property values; events; `ik` (reached, extension, error, distance, maxReach, bend, stretch); `physics` (outputs: raw, value, clamped, overridden); `points` (setup -> posed position of each point). A series (`times` or `frames` over the first animation): `{times, results}` (ascending times are played in order: incremental physics, crossed events; at most 120 poses). With `track`: a compact table `{times, columns, fields, rows}` plus aligned text; columns `param:<id>`, `bone:<id>` (x, y, rotation), `bone:<id>.tip`, `part:<id>.center`/`.bounds`/`.opacity`, `ik:<id>`, `physics:<group>.<param>`, `point:<x>,<y>@<parent>` or any bound/animated address. |
| `rev2d_analyze` | `path`, `animation`, `animations?` (extra layers), `params?`, `physics?`, `fps?` (default 60) / `frames?`, `from?`/`to?`, `times?`, `warmup?`, `pixels?` | Text report + JSON: parameter ranges used (and which reach their limits), physics outputs clamped (peak raw value and when), IK max extension / out-of-reach / nearly-straight frames, events with their frame, the loop seam of looping animations (parameters and bones that jump back at t=0, pixel difference one loop later), union bounds, parts leaving the canvas, and actionable notes. |
| `rev2d_hit_test` | `path`, `x`, `y`, pose | Parts covering the point, top-most first (fill/stroke); nearest parts when nothing is hit. |
| `rev2d_apply_ops` | `path`, `ops`, `dry_run?`, `allow_invalid?`, `render_after?` (`true` or render options) | Per-op results, validation of the result, JSON `{ok, written, changed, dryRun, file, results, diagnostics}`, optional render. See below. |
| `rev2d_create_model` | `path`, `template?` (`blank` or an example), `name?`, `width?`, `height?`, `overwrite?` | Writes the model (and copies example textures), returns its outline. Refuses to overwrite without `overwrite: true`. |
| `rev2d_diff_images` | `a`, `b`, `threshold?`, `save_to?` | Differing pixel count, max/mean delta, and a visualization (differences in red). |
| `rev2d_editor_state` | `model?`, `url?` | What the human sees in a running editor: the model it has open and its workspace root (or that no model is open: start screen, with the recent files), time, playing, animation layers (as layer strings you can pass back, e.g. `["idle","blink,add,once,start=1"]`), non-default params, the params the human pinned (explicit values that beat animation and physics), physics toggle, selection, overlay, hidden parts, view; full state as JSON. |
| `rev2d_editor_command` | `command`, `model?`, `url?` | Sends `setParams`, `play`, `pause`, `seek`, `setAnimations` (layers with `weight`, `mode`, `start`, `hold`), `select`, `setOverlay`, `focus`, `reload` or `message` to the editor tabs; ids and layer options are checked against the model first. `{type: "open", file}` switches the editor to another model of its workspace (the tabs follow). |
| `rev2d_editor_screenshot` | `model?`, `url?`, `overlay?`, `scale?`, `viewBox?` | PNG of exactly what the editor shows (rendered by the editor server from its current state) + the state summary. |
| `rev2d_import` | `format` (`"spine"` \| `"live2d"`), `path` (a skeleton .json; or Live2D file(s)), spine: `out?`, `atlas?`, `skin?`, `scale?`, `padding?`, `name?`, `overwrite?`; live2d: `into`, `param_map?`, `id?`, `physics?`, `display_info?`, `motions?`, `expressions?`, `dry_run?` | Spine: a new model (+ `textures/`) with its conversion report; Live2D: ops applied to `into` atomically. Text: summary, files, report lines; JSON `{ok, file, files, report, ...}`. See below. |
| `rev2d_export` | `format`, `path`, `out_dir`, `animations?`, `fps?`, `name?`, `tolerance?`; spine: `texture_scale?`, `param_poses?`, `max_page_size?`, `spine_version?`, `premultiplied_alpha?`; live2d: `param_map?` | Spine JSON + atlas + PNG pages, or Live2D motion3 / physics3 / cdi3 / model3 JSON, in `out_dir`; each file new / replaced / unchanged; the report. |

"pose" = `time?` (seconds), `animations?` (layer strings or objects, see Conventions),
`params?` (`{"AngleX": 30}`, beat animation and physics), `physics?` (default on when the model has
physics).

### Editing with `rev2d_apply_ops`

The description lists every op with its fields (`add`, `update`, `remove`, `rename`, `set`, `bind`,
`bind_linear`, `bind_warp`, `follow`, `unbind`, `key`, `unkey`, `move`, `recolor`, `compose`,
`patch`; the list is generated from the ops module, so it never misses one); the `ops` field
carries one example per op and `rev2d_docs {topic: "ops"}` the full catalogue.

- **Atomic**: nothing is written unless every op applies and the result validates
  (`allow_invalid: true` writes a result with validation errors so later calls can fix them).
- **Minimal writes**: the file is rewritten in the stable diff-friendly format (comments are
  dropped) only when the model actually changed (`changed: false` otherwise), keeping its CRLF line
  endings if it had them.
- **Safe with parallel calls**: calls on the same file are serialized within the server, and a call
  refuses to overwrite a file that another program (the editor, a human) saved while it was running.
- **`render_after`** renders the result (with `dry_run`: a preview). A render problem, e.g. an unknown
  parameter in its options, is reported as text; it never hides that the edit was written.

### Spine and Live2D: `rev2d_import`, `rev2d_export`

Conversions from and to the public JSON formats of Spine and Live2D Cubism; what is converted and
how is in [INTEROP.md](INTEROP.md) (`rev2d_docs {topic: "interop"}`). Every result carries the
**report**: each approximated or dropped feature with a stable `code`, a `where` in the source data
and a `hint`. The text lists up to 80 issues (warnings first); the JSON block has all of them as
`report: {format, direction, issues, stats}`.

- **Spine import** (`{format: "spine", path: "hero/hero.json", out: "models/hero.r2d.json"}`): reads
  the skeleton (3.8 - 4.2 JSON), its atlas (`atlas`, default found next to it) and PNG pages, writes
  a new model and its pages in `textures/` next to it, and validates it. Refuses to replace an
  existing `out` unless `overwrite: true`.
- **Live2D import** (`{format: "live2d", path: ["idle.motion3.json", "F01.exp3.json"], into: "hana.r2d.json"}`):
  motions become animations, expressions `exp_<name>` animations for `add` layering, physics3
  physics groups (`physics`: replace / merge / skip), cdi3 names (`display_info`), a model3.json
  everything it lists. Applied as ops, atomically, like `rev2d_apply_ops` (`dry_run` reports without
  writing). An animation with the same id is replaced: the report has a **warning**
  (`live2d-animation-replaced`) when that animation was made in Rev2D rather than by an earlier
  Live2D import, so run with `dry_run` first on a model the human cares about, and rename the
  animation (`rename` op) or pass `id` to keep it. The `.moc3` model binary is proprietary and never
  read: the model's own rig stays.
- **Exports** (`{format: "spine" | "live2d", path, out_dir}`) write into `out_dir` (files of an
  earlier export are replaced; the result says which files changed). Spine exports bake parameters,
  warps, physics and IK into the animations; Live2D exports need a Live2D model whose parameter ids
  match `param_map` (`"standard"` by default: `AngleX` <-> `ParamAngleX`, `MouthOpen` <->
  `ParamMouthOpenY`, ...; or `"none"`, `"prefix"`, an object, a JSON file).
- Options of the other format are refused with a hint (`into` with `format: "spine"`,
  `texture_scale` with `format: "live2d"`), as are unknown animation ids (did-you-mean).

### Editor bridge

The editor tools talk to an editor started by the human with `rev2d edit [model]`. Running editors
register themselves in `~/.rev2d/editors/` under the file they have open **now**; the tools use the
one at `url`, else the one that has `model` open, else the newest editor of a file under the working
directory (else the newest editor). When none is running the tools say so and suggest the exact
`rev2d edit` command to give the user. Files written by `rev2d_apply_ops` are live-reloaded by the
editor, so the human sees every edit.

- **Workspace**: an editor works inside a workspace root (`rev2d edit --root <dir>`; default: the
  model's directory, else the directory it was started in). The human opens, creates, saves as,
  closes, imports and downloads models from its File menu; `rev2d_editor_state` names the open model
  and the root, or reports the start screen (no model open) with the recent files instead of failing.
- **Opening a model**: `rev2d_editor_command {command: {type: "open", file}}` switches the editor to
  another model (a relative `file` resolves against the working directory, like every path of this
  server). The editor server opens it, resets the view state and updates its registry entry; every
  tab follows; commands sent right after it (`setParams`, `play`, `select`, ...) apply to the newly
  opened model once a tab has loaded it. Files outside the workspace root (also through symbolic links) are refused with HTTP
  403 and a hint; a missing file is 404; a JSON file that is not a Rev2D model is 422. To show a new
  model, create it inside the root with `rev2d_create_model`, then open it. While no model is open,
  the other commands and `rev2d_editor_screenshot` fail with `HTTP 409: no model is open` and a hint.

- Ids in commands are checked against the model the editor has open (`GET /api/model`) with
  did-you-mean hints. `select` takes what the editor resolves: bare ids (`"mouth"`) or `kind:id` refs
  with kind `part`, `bone`, `warp`, `param`, `animation`, `binding` (id or index), `ik`, `physics`,
  `texture` (`"param:AngleX"`, `"binding:0"`).
- **Screenshots show what the human sees**: the editor publishes its evaluated parameter values
  (its own incremental physics results and the values the human pinned), time, animation layers
  with their `mode` / `start` / `hold` options, overlay, visible region and the parts hidden in its
  preview; the editor server renders exactly that (physics is not re-simulated, hidden parts are
  left out but still clip as masks). The summary lists the hidden parts.
- **Size and scale**: screenshots are sized like `rev2d_render` from the region shown (the editor's
  view, its canvas, or the `viewBox` argument), also for views zoomed far out (the scale is never
  rounded to 0). The editor server reports the region and scale it actually used in the
  `X-Rev2D-ViewBox` and `X-Rev2D-Scale` headers (also `X-Rev2D-Source`: `editor-state` or
  `default-pose`, `X-Rev2D-Hidden`, `X-Rev2D-Ignored`); the tool sizes a `"fit"` or unknown region
  from these effective values and prints them (`... of viewBox [x, y, w, h] (model px) at scale s`).
  Before a browser tab has published its view state the editor renders the default pose, and the
  summary says so; state entries that no longer exist in the model are listed as ignored.
- **Errors keep their hints**: editor-side failures come back with the editor's message, `hint` and
  diagnostics (HTTP 422 bodies are `{error, hint?, diagnostics}`: a model with errors, or a view
  state that cannot be posed).
- **No lost edits (409)**: when you write the model (e.g. `rev2d_apply_ops`) while the human is
  editing it in the editor, the editor's next write is refused with HTTP 409 (the file changed on disk
  since the version it edits) and the human chooses to reload your version or overwrite it; nothing
  is overwritten silently. `rev2d_apply_ops` in turn refuses to overwrite a file saved by the editor
  while the call was running (send the ops again).
- **Inspector**: `select` an IK constraint (`"ik:armIk"`) or a physics group (`"physics:hairFront"`)
  to show the human its live diagnostics (extension, error, reached, bend; outputs raw / value /
  clamped / pinned).

## Resources

| URI | Content |
| --- | --- |
| `rev2d://guide` | The quickstart (same as `rev2d_guide`). |
| `rev2d://docs/spec` | docs/SPEC.md |
| `rev2d://docs/ops` | docs/OPS.md (or the op catalogue compiled into the ops module) |
| `rev2d://docs/recipes` | docs/RECIPES.md |
| `rev2d://docs/interop` | docs/INTEROP.md |
| `rev2d://docs/avatar` | docs/AVATAR.md |
| `rev2d://schema` | JSON Schema of a model file. |

## Example session

A typical agent loop giving the blank template a blink (arguments abbreviated):

1. `rev2d_guide` — learn the conventions and recipes.
2. `rev2d_create_model {path: "hero.r2d.json", width: 400, height: 600}` →
   `created hero.r2d.json from template "blank"` plus the outline.
3. `rev2d_apply_ops {path: "hero.r2d.json", dry_run: true, ops: [...]}` — add an `EyeOpen` parameter,
   bind `part:eye.shape.ry` to it and key a `blink` animation; the report shows each op and the
   validation of the result:
   ```
   hero.r2d.json: 6 ops would apply cleanly; dry run, file unchanged
     ok   #0 add: added parameter "EyeOpen" as /parameters/2 (range 0..1, default 1)
     ok   #1 bind: added binding part:eye.shape.ry ← [EyeOpen] as /bindings/3 (2 keyforms)
     ...
   ```
   Repeat without `dry_run` to write.
4. `rev2d_render {path: "hero.r2d.json", params: {"EyeOpen": 0}, overlay: ["bones", "warps", "labels"]}`
   → image + `hero.r2d.json: 400x600 px image of viewBox [0, 0, 400, 600] (model px) at scale 1, t=0s` ...
5. `rev2d_inspect {path: "hero.r2d.json", params: {"EyeOpen": 0}, parts: ["eye"]}` → exact bounds to
   confirm the eye closes to a line: `"bounds":[188,283,24,4]`.
6. `rev2d_sheet {path: "hero.r2d.json", sweeps: ["EyeOpen=0:1:3"]}` and
   `rev2d_sheet {path: "hero.r2d.json", animation: "blink", frames: 12}` — verify the motion;
   `rev2d_sheet {path: "hero.r2d.json", animation: "idle", animations: ["blink,once,start=0.5"]}`
   shows the blink as a one-shot over the idle loop.
   `rev2d_analyze {path: "hero.r2d.json", animation: "idle"}` reports the parameter ranges, the loop
   seam and any clamping without looking at frames.
7. The user opens `rev2d edit hero.r2d.json`; `rev2d_editor_command {command: {type: "play",
   animation: "blink"}}` shows it to them, `rev2d_editor_screenshot` confirms what they see.

Error example — `rev2d_render {path: "hero.r2d.json"}` after a typo in the file:

```
Error: hero.r2d.json has 1 error; fix them before rendering or inspecting
hint: each diagnostic gives a JSON pointer into the file, a code and a fix; rev2d_validate shows the same list

error   /parts/1/fil  schema-unrecognized-keys  unknown key "fil"  → did you mean "fill"?
1 error, 0 warnings
```

## Troubleshooting

- **Server does not start**: run `node /absolute/path/to/Rev2D/bin/rev2d.js mcp` in a terminal; it
  should wait silently for input (stdout is reserved for the protocol, so nothing is printed).
  Check Node is 22+ and `npm install` ran.
- **"model file not found"**: the hint lists the `.r2d.json` files next to the path (or inside it, when
  the path is a directory); relative paths resolve against the server's working directory.
- **"no running Rev2D editor found"**: ask the user to run `rev2d edit <model>`, or pass `url`.
- **"changed on disk while the ops were being applied"**: the editor or another program saved the
  model during the call; send the same ops again.


## Asset library and avatar tools

Eleven Studio tools supplement the upstream eighteen (29 total). See [LIBRARY.md](LIBRARY.md).

| Tool | Inputs | Result |
| --- | --- | --- |
| `rev2d_library_search` | `path`, optional `kind`, `character`, `tags`, `text` | Matching assets/poses and relative paths |
| `rev2d_library_validate` | `path` | Readiness diagnostics; isError when invalid |
| `rev2d_library_import` | `path`, `image`, `kind`, ids, optional key/trim settings | New PNG asset or draft avatar; never replaces a pose |
| `rev2d_library_request` | `path`, `out`, `kind`, ids/description, optional `size` | Local prompt and copied reference attachments; no network |
| `rev2d_library_sheet` | `path`, optional `kind`, `character`, `save_to` | Contact sheet inline and entry list |
| `rev2d_avatar_new` | `path` (PNG), `out`, optional `name` | New project with unplaced landmarks |
| `rev2d_avatar_validate` | `path` | Spec diagnostics, model existence and layer freshness |
| `rev2d_avatar_grid` | `path`, optional `region`, `step`, `scale`, `save_to` | Coordinate grid PNG inline |
| `rev2d_avatar_overlay` | `path`, optional `part`, `zoom`, `grid`, `scale`, `save_to` | Landmark overlay PNG inline and missing items |
| `rev2d_avatar_build` | `path` | Built model, layers, fold findings and input fingerprints |
| `rev2d_avatar_poses` | `path`, optional `scale` | Four inline review sheets and summary file |

`save_to` creates new files and refuses replacement. Image previews fit within 1024 px; full-size
saved images retain their coordinates. Inspect every pose sheet and fix landmarks before accepting a
character. The current face/bust builder does not infer articulated arms/legs. A library character
import is explicitly a draft, even though its cutout and avatar.json exist.
