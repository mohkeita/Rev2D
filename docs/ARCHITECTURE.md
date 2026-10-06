# Rev2D architecture

How a `*.r2d.json` file becomes pixels, which module owns which step, the data contracts between
them, what is guaranteed to be deterministic, how the editor talks to the CLI/MCP side and confines
file management to a workspace root, how the editor UI is put together (shell, modes, design system,
languages, the AI panel), how one illustration becomes an avatar model, and where to extend the
system. For the file format itself see [SPEC.md](SPEC.md); for the avatar workflow
[AVATAR.md](AVATAR.md); for the in-app agents [AGENT-BRIDGE.md](AGENT-BRIDGE.md); for day-to-day
development rules [AGENTS.md, Part 2](../AGENTS.md#part-2-developing-rev2d).

## 1. Pipeline

```text
 model file (*.r2d.json, JSON or JSONC)
   │
   │  parseModelText ─ src/core/validate/jsonc.ts      json-syntax (line:col), json-duplicate-key
   ▼
 validateModel ─ src/core/validate.ts
   ├─ structural: ModelSchema (zod, src/core/schema.ts) ──► schema-* diagnostics
   └─ semantic:   references, cycles, binding grids, values, geometry limits, IK, physics, animations
   │                                    ──► Diagnostic[] {severity, code, path (JSON pointer), message, hint}
   │  Model (normalized: defaults filled in)
   ▼
 loadModelFile / loadModelObject ─ src/node/load.ts    PNG textures decoded (texture-load diagnostics)
   │  LoadedModel {model, diagnostics, textures, textureInfo, rig}
   ▼
 new Rig(model, {textures}) ─ src/core/rig/compile.ts  ("Rig compile")
   ids → indices, parents-first order, setup world transforms, binding grids, sorted keys,
   static part geometry via compileGeometry (src/core/geometry: flatten, triangulate + detail,
   strokes, per-vertex paint, auto skin weights)
   │  CompiledRig
   ▼
 rig.pose(PoseOptions)            stateless: any time, physics simulated from rest (at most 60 s back)
 rig.player().update(PoseOptions) sequential: incremental physics, crossed events
   └─ evaluateFrame ─ src/core/rig/evaluate.ts  (SPEC §9)
        params → animation layers (override / add, start, hold; smooth keys, track offset)
        → clamp → explicit params → physics (60 Hz; explicit params re-applied: they always win)
        → bindings + tracks → bones → IK (softness, stretch) → warps
        → parts (rebuild changed shapes, deform by bone / warp / skin)
   │  Pose {params, bones, warps, parts, drawOrder, properties, events, ik, physics}
   │  rig.mapPoint(pose, parent, x, y): where a setup point attached to a bone / warp / part is posed
   ▼
 buildRenderList(rig, pose) ─ src/core/rig/render.ts
   │  RenderList {width, height, background, draws: DrawItem[]}
   ├──► renderImage ─ src/render/raster.ts   deterministic software rasterizer → ImageRGBA
   │       └─► drawOverlay (overlay.ts) · composeSheet (sheet.ts) · encodePNG (png.ts)
   │           encodeGIF (gif.ts) · diffImages (diff.ts)
   └──► WebGL2 viewport ─ editor/src/gl/renderer.ts   interactive preview in the browser
```

The high-level operations used by every front end (parse layer strings, plan sample times, render a
frame, a sequence, a sheet; inspect a pose, a series or a track table; analyze an animation; compute
notes; hit-test; model outline) live in `src/api` and take/return JSON-friendly values, so the CLI,
the MCP server and the editor server produce the same results and the same notes from the same
inputs.

```text
 src/cli     (rev2d command line)  ──┐
 src/mcp     (MCP server, stdio)   ──┼──► src/api ──► src/core + src/render
 src/server  (editor HTTP + SSE)   ──┘
     ▲ HTTP + SSE                   │ spawns (no shell)
 editor/     (React + WebGL2 UI;     └──► Codex CLI / Claude Code   via src/node/agent
              also runs src/core, src/avatar and src/lipsync in the browser)

 shared by the front ends: src/ops (edit engine) · src/node (files, textures, editor registry,
                           avatar projects, agent runner) · src/interop (Spine / Live2D)
 avatar builder:           src/avatar (pure: spec, image ops, features, compile) ◄─► src/node/avatar*.ts
 lip sync:                 src/lipsync (pure: text / WAV -> MouthOpen, MouthForm)
```

`loadModelFile` (`src/node/load.ts`) runs the first stages (parse, validate, decode textures,
compile the rig) in one call and never throws for model problems: they come back as diagnostics
with `rig: null`.

## 2. Module responsibilities

| Path | Responsibility | Notes |
| --- | --- | --- |
| `src/core/schema.ts` | The model format: zod schemas, the single source of truth. `rev2d schema` is generated from it. | `.describe()` texts are user-facing docs. |
| `src/core/types.ts` | Model types (inferred from the schema) and the runtime contracts between modules. | See §3. |
| `src/core/address.ts`, `values.ts` | Property address grammar (`kind:id.prop`), bindable fields, value normalization, interpolation and the delta-sum combination rule; `suggest()` for did-you-mean. | Shared by rig, ops, validation, CLI and MCP. |
| `src/core/validate/` | JSONC parsing, structural and semantic checks, diagnostic formatting. | Every check produces a pointer, a code and a hint. |
| `src/core/geometry/` | Shape + paint → triangle meshes in setup space: path flattening (distance tolerance and at most ~15° of turn per segment), ear clipping, `detail` refinement (half-edge Delaunay), strokes (align, joins), gradients per vertex, auto skin weights. | Pure; throws `GeometryError`. |
| `src/core/rig/` | Compile (`compile.ts`, `compiled.ts`), sampling of animations, layers and binding grids (`sampling.ts`), the `smooth` ease (`curves.ts`, Catmull-Rom Hermite), physics (`physics.ts`), IK with softness, stretch and diagnostics (`ik.ts`), warp mapping (`warp.ts`), part deformation (`parts.ts`, `paths.ts`), per-frame evaluation (`evaluate.ts`), events (`events.ts`), render list (`render.ts`). `src/core/rig.ts` is the public `Rig` / `Player` facade (`pose`, `player`, `mapPoint`). | No Node or DOM APIs. |
| `src/render/` | Software rasterizer, overlays, 5×7 bitmap font, contact sheets, image diff, GIF encoder, PNG codec. | Browser-safe except `png.ts` (node:zlib); `browser.ts` is the browser entry. |
| `src/node/` | File loading (`load.ts`) and the running-editor registry (`editor-registry.ts`, `~/.rev2d/editors/`: each editor's URL, open model and workspace root; `findEditor` / `listEditors` discovery), which also holds the editor protocol types (workspace, avatar mode, agent bridge). | The only place core models touch the filesystem. |
| `src/avatar/` | The avatar builder ([§6](#6-avatar-builder-and-lip-sync)): the spec (`schema.ts`, `spec.ts`: zod schema and the `avatar-*` checks), the editable parts of a spec (`parts.ts`), image processing (`image/`: masks, rasterizing, distance fields, blur, connected components, Lab colour, inpainting, cutting and compositing), agent tools (`tools/`: coordinate grids, landmark overlays, the vision check), the layer stage (`layers.ts`), the feature modules (`features/`), the model builder, deformation fields and fold checker (`builder.ts`, `fields.ts`, `folds.ts`), compile (`compile.ts`), review poses (`poses.ts`), drawn variants (`variants*.ts`), the Mesh Avatar Studio importer (`mas.ts`). `DESIGN.md` documents the generated model. | Pure and browser-safe (no Node APIs; raster utilities from `src/render/browser.ts`): the editor compiles avatars in the browser. Deterministic. |
| `src/node/avatar.ts`, `src/node/avatar-variants.ts` | Avatar project IO: create / load a project, `buildAvatarProject` (layers → model → `post` ops → validate → fold check → write, unchanged files untouched), `reviewAvatarProject` (the review sheets), vision-check files, Mesh Avatar Studio import, variant requests / import / status. | Never throws for problems in the project: they come back as diagnostics. |
| `src/lipsync/` | Text (kana, Hangul, romaji, an English-like fallback) → beats with visemes → a Rev2D animation on `MouthOpen` / `MouthForm`, or the mouth shape at a time for live preview; WAV decoding and loudness-driven `MouthOpen`. | Pure and browser-safe; the viseme table is shared with the avatar builder's drawn mouths. |
| `src/node/agent/` | The in-app agent runner ([AGENT-BRIDGE.md](AGENT-BRIDGE.md)): providers (`codex.ts`, `claude.ts`, `provider.ts`: command lines, event parsing), process start without a shell (`exec.ts`), the preamble and task templates (`prompt.ts`), jobs, limits and cancellation (`manager.ts`), logs, settings (`settings.ts`: `~/.rev2d/settings.json`). | Only `read-only` and `workspace-write` sandboxes; `assertSafeArgs` refuses anything wider. |
| `src/api/` | `layers.ts` (layer strings `"talk@0.8,add"`, `"wink,once,start=2"` → `AnimationLayer`), `pose.ts` (`toPoseOptions`), `frame.ts` (`renderFrame`, view boxes, `--only` checks), `sampling.ts` (time specs, sample plans with window and warm-up, sequential poses, frame events), `stats.ts` (`PoseStats`: the IK / physics / view-box notes), `sheet.ts` (sweeps incl. linked ones, `buildSheet` for animation / sweep / overview sheets), `inspect.ts` (`inspectPose`, `inspectSeries`, `trackSeries`, mapped points), `analyze.ts` (`analyzeAnimation`), `info.ts`, `templates.ts` (`blank`, `empty`, examples), `docs.ts` (the recipe list of docs/RECIPES.md for `rev2d docs` and MCP `rev2d_docs`); `index.ts` re-exports them and holds `hitTest`. | Throws `ApiError` with a hint and diagnostics. |
| `src/ops/` | `applyOps` (atomic batches on the raw JSON document), `describeOps` (the catalogue behind MCP descriptions and hints), reference tracking for rename/cascade, `bind_warp` math, `recolor`, `compose` (evaluates the layers through `Rig` to bake them), `follow` (poses the rig and maps the anchor with `Rig.mapPoint` per keyform), change summaries for `update` messages (`diff.ts`). | Operates on raw documents so untouched text stays as written. |
| `src/interop/` | Format converters: Spine skeleton JSON + atlas import and export (`spine/`: atlas reader/writer, curve and transform math, importer with emulation of what Rev2D bones lack (shear pairs, inheritance modes, transform constraints, sampled where needed), exporter with rasterization, lattice bones, key reduction and page packing), Live2D Cubism JSON files (`live2d/`: motion3, exp3, physics3, cdi3, model3, the parameter map), file detection (`detect.ts`). Every result carries an `InteropReport` (issues with stable codes, stats). See [INTEROP.md](INTEROP.md). | Pure (no Node APIs); the `.moc3` binary is never read. |
| `src/node/interop.ts` | Interop file IO for the CLI, MCP and editor server: reading a Spine export folder (atlas lookup, page decoding), writing output files (new / replaced / unchanged, refusing overwrites unless asked), Live2D files turned into ops and applied atomically to a model file, report text. | Throws `InteropError` with a kind each front end maps (exit code, isError, HTTP status). |
| `src/cli/` | The `rev2d` command line: argument parser, command registry, help, `--json` output, exit codes. | `main(argv, io)` is testable in-process. |
| `src/mcp/` | MCP server over stdio: tools, resources, the quickstart guide. | stdout belongs to the protocol. |
| `src/server/` | Editor server: model file API, texture serving, SSE live reload, shared view state, commands, server-side screenshots, file watching, file management inside a workspace root (`workspace.ts`, `workspace-routes.ts`), interop (`interop-routes.ts`), avatar mode (`avatar-routes.ts`, `avatar-agent-tasks.ts`) and the agent bridge (`agent-routes.ts`). Modules in [§5.1](#51-server-modules). | Loopback-only by default; no path outside the workspace root is read or written; agent endpoints need a per-server token. |
| `editor/` | React 19 editor UI ([§5.6](#56-the-editor-ui)): the shell (`shell/`: full-bleed canvas under floating chrome, registries for workspace modes, trailing panels and toolbar actions), the design system (`design/`), languages (`i18n/`: English, Korean, Japanese), the Rig mode (outliner, WebGL2 viewport, parameters, inspector with live IK and physics diagnostics, timeline with layers, problems), Avatar mode (`avatar/`), the AI panel (`ai/`), file management (`files/`: File menu, start screen, dialogs, import, unsaved-changes guard). Validates and evaluates models in the browser with `src/core`. | Built into `dist/editor` by `npm run editor:build`. |
| `scripts/` | Example builders (`scripts/examples/`), texture generator, render scripts, and the demo media pipeline (`scripts/video/`: `capture-all.mjs` records real CLI output, renders and editor screencasts; `compose.mjs` builds `docs/media/`). | Examples are generated; see examples/README.md. `docs/media/` is not in the npm package. |

## 3. Data contracts (`src/core/types.ts`)

| Type | Produced by → consumed by | Content |
| --- | --- | --- |
| `ModelInput` / `Model` | author → `validateModel` → everything | `z.input` (defaults optional) vs `z.output` (normalized) of `ModelSchema` |
| `Diagnostic` | validation, loader, ops → CLI/MCP/editor | `severity`, stable `code`, `message`, JSON-pointer `path`, optional `hint` |
| `Address`, `ResolvedTarget` | `parseAddress` / `resolveTarget` → rig, ops | parsed `kind:id.prop`, value type, setup value, point count |
| `Value`, `PathValue` | `normalizeValue` → sampling, combination | numbers, flat point arrays, RGBA, paths as template + numbers |
| `CompiledGeometry`, `MeshBatch` | `compileGeometry` → rig | fill/stroke triangle batches in setup space, per-vertex straight RGBA, optional uvs + texture |
| `PoseOptions`, `AnimationLayer` | callers → `Rig.pose` / `Player.update` | `time`, `animations` (ids or `{id, time?, weight?, mode?: 'override' \| 'add', start?, hold?}`), `params` (explicit values: beat animations and physics), `physics` |
| `Pose` | rig → render list, api, editor | final params; `BonePose` (world matrix, joint, rotation, scale, tip, local values), `WarpPose` (deformed lattice), `PartPose` (visibility, opacity, z, tint, bounds, deformed positions), `drawOrder`, `properties` (every bound/animated value by address), `events`, `ik` (`IkPose`: reached, error, distance, maxReach, extension, bend, stretch), `physics` (`PhysicsPose`: per output raw, value, clamped, overridden) |
| `DrawItem`, `RenderList` | `buildRenderList` → rasterizer, WebGL | world positions, indices, per-vertex colors with paint × tint × opacity baked in, uvs/texture, `blend`, mask items (`masks`, `maskInvert`) |
| `ImageRGBA`, `TextureInfo` | loader, rasterizer → PNG/GIF/sheet/diff | straight-alpha RGBA8, row-major, top-down |

API-level contracts (JSON over CLI `--json`, MCP and HTTP) are defined next to their producers:
`FrameInput` (`src/api/frame.ts`), `InspectResult` (`src/api/inspect.ts`), `SheetResult`
(`src/api/sheet.ts`), `AnalyzeResult` (`src/api/analyze.ts`), `HitResult` (`src/api/index.ts`),
`ModelInfo` (`src/api/info.ts`), `ApplyOpsResult` / `OpResult` / `OpDescription` (`src/ops`),
`EditorEntry` / `EditorState` / `EditorLayer` / `EditorCommand` and the workspace types `WorkspaceInfo` /
`FileListing` / `OpenRequest` / `NewRequest` / `SaveAsRequest` / `ImportRequest` / `OpenResult` /
`TemplateInfo`, the avatar-mode types `AvatarRef` / `AvatarInfo` / `AvatarSaveResult` /
`AvatarJobEvent` / `AvatarNewResult` and the agent-bridge types `SessionInfo` / `AgentStartRequest` /
`AgentJobInfo` / `AgentEvent` / `AgentSettingsInfo` (`src/node/editor-registry.ts`). The avatar
builder's own contracts are in `src/avatar/types.ts`: `AvatarSpec` (the parsed `avatar.json`),
`LayersMeta` (`textures/layers.json`: layer rects, the input fingerprint, per-feature data, sprites),
`AvatarReport` / `AvatarIssue` (build issues with a code and a hint), `AvatarPose` (review poses).
These shapes only ever gain fields.

Positions in `Pose` and `RenderList` are views into rig-owned arrays: treat them as read-only.

## 4. Determinism guarantees

Same model + same textures + same inputs ⇒ same numbers and same pixels, and repeated runs write
identical files:

- **Evaluation** is a pure function of the model and `PoseOptions`; no clocks, randomness, locale or
  platform APIs. `rig.pose(t)` is stateless.
- **Physics** uses a fixed 60 Hz step: step *k* happens at *k*/60 s and re-evaluates its input
  parameters at that time. A stateless pose simulates from rest over at most the 60 s before *t*
  (`PHYSICS_WINDOW_STEPS` = 3600 in `src/core/rig/physics.ts`), and a `Player` advancing frame by
  frame reaches the same state, so sheets, GIFs, the editor and single renders agree (beyond 60 s a
  Player may keep older history; after a jump backwards or of more than 60 s it restarts exactly
  like a stateless pose). Explicit parameter values are re-applied after every physics step, so they
  always beat physics outputs. Warm-up (`--warmup`) shifts every layer clock by whole cycles, which
  keeps sampled times and captions animation-local.
- **Rasterization** is pure TypeScript: vertex positions are snapped to 1/256 of a sample, triangles
  use integer edge functions with a top-left fill rule (shared edges are covered exactly once),
  blending happens in premultiplied float space, and supersampling is a fixed box filter. No GPU is
  involved, so a headless render does not depend on graphics drivers.
- **Encoders**: PNG filter selection and the GIF palette (exact, or a deterministic median cut) do
  not depend on anything but the pixels. Tests assert byte-identical output for repeated renders.
- **Formatting**: `formatModelJson` produces a stable layout with rounded numbers, so tool edits
  give minimal diffs; unchanged models are not rewritten.

The editor's WebGL viewport is for interaction and is not bit-exact with the software renderer.
When an agent needs to know exactly what the human sees, the editor server renders a screenshot
from the editor's published state with the software renderer (`/api/screenshot`,
`rev2d editor screenshot`, MCP `rev2d_editor_screenshot`).

## 5. Editor protocol

`rev2d edit [model | dir] [--root dir]` starts `src/server` (default `http://127.0.0.1:4777`), serves
the built UI from `dist/editor` (or the Vite dev middleware when unbuilt), and registers itself in
`~/.rev2d/editors/<pid>-<port>.json` as `EditorEntry {pid, url, file, root, startedAt}` so
`rev2d editor ...` and the MCP editor tools can find it. `file` is the model the editor has open
**now** (`""` on the start screen; the entry is rewritten on every switch) and `root` its workspace
root. Discovery (`findEditor` in `src/node/editor-registry.ts`): an explicit URL; else, for a
path, the newest editor that has that file open, else the editor whose workspace root contains it
(innermost root first; this finds an editor on its start screen); `{root}` selects the editor of a
workspace directory; without either, the newest editor. The CLI (`--model`, and the file of an
`open` command) and the MCP tools (`model`, `open`) use it; a request for a file the chosen editor
does not have open reads its state with a note, but commands other than `open` and screenshots are
refused with the hint to open the file first, so they never act on another model.

### 5.1 Server modules

| Module | Responsibility |
| --- | --- |
| `index.ts` | `startEditorServer`: opens the initial model and the workspace root, wires routes, watcher and event hub, owns the registry entry. `ApiContext.switchTo` makes another model current (or none): resets the view state, retargets the watcher, rewrites the registry entry, records the recent file and broadcasts `file-changed`. `exclusive` runs workspace operations one at a time. |
| `routes.ts` | Dispatch of every `/api/*` route (unknown paths answer 404 listing the endpoints, wrong methods 405 with `Allow`) and the model, texture, events, state, command, screenshot and info handlers. |
| `workspace-routes.ts` | File-management handlers: workspace, files, templates, open, new, save as, close, import, download, and the `open` command. |
| `interop-routes.ts` | Live2D import into the open model (validated ops, nothing written) and Spine / Live2D export into the workspace. |
| `avatar-routes.ts` | Avatar mode: which avatar project belongs to the open model (or is open without one), the spec with lost-update protection (`avatar.json.bak` on every write), recompiling the model from existing layers, build and variant-import jobs (a `rev2d avatar build` child process, so cutting layers never blocks the server), project files, new projects from one picture, a watcher for the project folder. The avatar modules load on first use. |
| `avatar-agent-tasks.ts` | The agent task templates of avatar mode (`avatar-create`, `avatar-variants`); importing the module registers them. |
| `agent-routes.ts` | The agent bridge endpoints (`/api/session`, `/api/agent/*`): token check, providers, task list, jobs, cancel, follow-up messages, settings; job events go out as SSE `agent-job`. Present only on a loopback bind unless `--allow-agent`. |
| `workspace.ts` | `WorkspaceRoot` (path confinement, [§5.4](#54-workspace-root-and-path-safety)), directory listings, portable-name checks, the recent list (`~/.rev2d/recent.json`), template descriptions, texture-path rewriting for save as. |
| `protocol.ts` | Validation of every payload (view state, commands, open / new / save-as / import requests, screenshot query) into 400 errors that name the field and the fix. |
| `model-store.ts` | The open model file: raw reads, conflict-checked writes (`baseMtimeMs`), change detection (content hash for the model, stat signature for textures), the `LoadedModel` cache for screenshots. |
| `watch.ts` | Debounced directory watching of the model and its textures, with a stat-polling fallback. |
| `sse.ts` | The `GET /api/events` hub (one stream per tab or watcher, keep-alive comments). |
| `http.ts` | JSON responses, `HttpError`, bounded body reading, the Host (DNS rebinding) and Origin (CSRF) guards. |
| `ui.ts` | The built UI, the Vite dev middleware, or a page that says how to build it. |

### 5.2 Endpoints

Model and AI bridge (all but `GET /api/events` and the message command need an open model, else
**409** `{error: "no model is open", hint}`):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/model` | `{file, text, mtimeMs}`: the raw file text |
| `PUT /api/model[?force=1]` | write `{text}` or `{doc}` plus optional `baseMtimeMs` and `file` (the model the write is for); returns `{ok, written, diagnostics, mtimeMs}`, or **409** `{error, hint, mtimeMs}` when the file changed on disk since `baseMtimeMs`, or **409** `{error, hint, file}` when the editor has switched to another model (nothing is written) |
| `GET /api/texture/:id` | a texture PNG |
| `GET /api/events` | SSE, see [§5.3](#53-events) |
| `GET` / `POST /api/state` | the UI's published `EditorState`: the evaluated params as shown (physics outputs and pinned values included), time, animation layers (`EditorLayer`: id, weight, mode, start, hold), playing, selection, overlay, visible region, physics toggle, preview-hidden parts, pinned params; a POST whose absolute `file` is not the open model gets **409** |
| `POST /api/command` | broadcast an `EditorCommand` to the open tabs; returns `{delivered}`. `{type: "open", file}` is handled by the server instead (like `POST /api/open`, origin `ai`) and returns `{delivered, file, mtimeMs, notes}` |
| `GET /api/screenshot?overlay=&scale=&viewBox=` | PNG of the editor's current pose, rendered server-side from the published state (layer options applied, physics not re-simulated); headers `X-Rev2D-ViewBox`, `X-Rev2D-Scale`, `X-Rev2D-Source`, `X-Rev2D-Hidden`, `X-Rev2D-Ignored` |
| `GET /api/info` | `{info, diagnostics}` |

Workspace (file management; request and result types in `src/node/editor-registry.ts`):

| Endpoint | Body → answer |
| --- | --- |
| `GET /api/workspace` | → `WorkspaceInfo {root, current, recent}` (`current` null on the start screen; `recent`: at most 10 existing models inside this root) |
| `GET /api/files?dir=<rel>` | → `FileListing {dir, parent, entries}`: directories first, then models (`*.r2d.json` / `*.r2d.jsonc`), PNGs and other `*.json`; hidden entries and links leading outside the root are left out |
| `GET /api/templates` | → `TemplateInfo[]` (`blank`, `empty`, then every example) |
| `POST /api/open` | `{file}` → `OpenResult {file, text, mtimeMs, notes}`; 404 missing, 400 directory, 422 a file not named `*.r2d.json` that does not hold `"format": "rev2d"` (a model with validation errors still opens: the editor lists them) |
| `POST /api/new` | `{file, template?, name?, width?, height?, overwrite?}` → `OpenResult`; appends `.r2d.json` to a bare name, creates parent directories, copies an example's PNGs next to the model |
| `POST /api/save-as` | `{file, doc? \| text?, overwrite?}` → `OpenResult`; writes the doc (or the open file as it is on disk) and opens the copy, rewriting relative texture paths so they still point at the same PNGs |
| `POST /api/close` | → `WorkspaceInfo` with no model open |
| `POST /api/import` | `{dir?, files: [{name, text? \| base64?}], overwrite?}` → `OpenResult`; exactly one model plus PNG textures from the user's computer, all checked before anything is written. A Spine skeleton JSON with its `.atlas` and PNG pages is converted (`<name>.r2d.json` + `textures/`) and the answer adds its `report` |
| `GET /api/download` | the open model file as an attachment |

Interop (`src/server/interop-routes.ts`; request and result types in `src/node/interop.ts`):

| Endpoint | Body → answer |
| --- | --- |
| `POST /api/live2d-import` | `Live2dImportRequest {files: [{name, text}], doc?, paramMap?, id?, physics?, displayInfo?, motions?, expressions?}` → `Live2dImportResponse {ok, changed, doc, results, diagnostics, report, summary, sources}`: the ops applied to `doc` (default: the open file) and validated, nothing written; the editor writes the doc as one undoable edit (`PUT /api/model` with `baseMtimeMs`) |
| `POST /api/export` | `ExportRequest {format: "spine" \| "live2d", dir?, doc?, overwrite?, animations?, fps?, ...}` → `ExportResponse {dir, files, report, notes}`: files written into `dir` (default `exports/<model>-<format>`) inside the workspace root; 409 naming different existing files without `overwrite` |

Avatar mode (`src/server/avatar-routes.ts`; types in the avatar-mode section of
`src/node/editor-registry.ts`). The open avatar project follows the open model (a model whose folder
holds an `avatar.json` attaches that project); `POST /api/open` and the `open` command also accept an
`avatar.json` or a project folder and open its built model, or the project without a model
(`{file: null, avatar}`) before the first build:

| Endpoint | Body → answer |
| --- | --- |
| `GET /api/avatar` | → `AvatarInfo`: the project (`AvatarRef {project, projectPath, specFile}`), the spec text, the illustration's size, the build state (model, `LayersMeta`, `stale`, accepted variants), project files, diagnostics, the running job; 404 when no avatar project is open |
| `PUT /api/avatar` | `{text \| doc, baseMtimeMs?, compile?}` → `AvatarSaveResult`: writes `avatar.json` (drafts with errors too) and recompiles the model from the existing layers when the spec is valid; **409** `{mtimeMs}` when the file changed since `baseMtimeMs` |
| `POST /api/avatar/build` | `{layers?}` → **202** `AvatarJobEvent`; progress and the report (`AvatarBuildReport`) as SSE `avatar-job`; `GET` answers the latest event; **409** while a job runs |
| `GET /api/avatar/file?path=` | a file of the project folder (images, JSON, text), with an ETag |
| `POST /api/avatar/new` | `{image: {name, base64}, name?, dir?, unique?}` → `AvatarNewResult`: a project from one PNG, opened without a model (the input of the `avatar-create` agent task) |
| `GET /api/avatar/variants`, `POST /api/avatar/variants/request`, `POST /api/avatar/variants/import` | drawn variants: their states, writing masks and prompts, and an import job like a build (`{ids?, remove?}`) |

Agent bridge (`src/server/agent-routes.ts`; protocol and security in
[AGENT-BRIDGE.md](AGENT-BRIDGE.md)): `GET /api/session` gives the per-server token, and every
`/api/agent/*` request carries it in `X-Rev2D-Token`: providers, task templates, jobs (start,
read with events since a sequence number, cancel, follow-up message) and settings.

Errors are JSON `{error, hint?, diagnostics?, ...}`: **400** malformed request or invalid file name,
**403** a path outside the workspace root, **404** missing file, **409** conflict (file exists
without `overwrite`, no model open, file changed on disk, model switched), **413** body too large
(20 MiB; imports 64 MiB), **422** not a Rev2D model, unparseable JSON, or a model or state that
cannot be posed (with the API error's hint and the diagnostics).

### 5.3 Events

`GET /api/events` is a server-sent event stream; every tab (and any AI watcher) holds one.

| Event | Data | When |
| --- | --- | --- |
| `hello` | `{file \| null, mtimeMs, root, avatar?}` | first event of every stream (`avatar`: the open avatar project, `AvatarRef`) |
| `model-changed` | `{origin: "external" \| "editor", mtimeMs, files}` | the open model or one of its textures changed on disk (`files` relative to the model's directory). Deleting or moving the open model away also arrives as `model-changed`: the UI re-reads it, gets 404 and keeps its document open as unsaved, so Save writes it back. Events of a model that was switched away from are dropped. |
| `file-changed` | `{file \| null, origin: "editor" \| "ai", avatar?}` | the open model was switched (open, new, save as, import, close); `null` = start screen, `ai` = an `open` command. Every tab loads the new model or shows its start screen; `{file: null, avatar}` is an avatar project without a built model (Avatar mode), not the start screen. |
| `command` | `EditorCommand` | an AI command other than `open`, forwarded to the UI |
| `avatar-changed` | `{origin: "editor" \| "external", project, files, mtimeMs}` | `avatar.json`, the illustration, `textures/`, `variants/`, `variant-requests/` or `review/` of the open project changed on disk (debounced) |
| `avatar-job` | `AvatarJobEvent` | progress and result of a build or variant import (`state`: running, done, failed; `step`; the report) |
| `agent-job` | `{job, state, event}` | every event of every in-app agent job, live ([AGENT-BRIDGE.md](AGENT-BRIDGE.md#events)) |

### 5.4 Workspace root and path safety

- **The root** is `--root <dir>`, else the model's directory, else the directory the editor was
  started in. The initial model must lie inside it (checked by the CLI and the server).
- **Every request path** (absolute, or relative to the root) goes through `WorkspaceRoot.resolve`:
  it is resolved, symbolic links and junctions are followed (for a path that does not exist yet,
  those of its nearest existing ancestor), and the real path must be the real root or lie inside it.
  `..`, absolute paths elsewhere and links leading out are refused with **403** and a hint (restart
  with `--root`); so is a path through a broken link, since writing through it would create a file
  wherever it points.
- **New files** (new, save as, import) need portable names for every segment that does not exist
  yet: no `\ : * ? " < > |` or control characters, no trailing dot or space, no device names such as
  `CON` or `NUL` (**400**), so a write never lands on a device or an alternate data stream.
- **Nothing is replaced silently**: new, save as and import answer **409** when a different file
  exists at the target unless the request says `overwrite` (identical files are fine; save as onto
  the open model needs no flag). An import writes nothing unless every file passes its checks.
- **Switches are serialized** (`exclusive`), reset the view state (`GET /api/state` is 404 until the
  UI publishes again) and carry over to writes: `PUT /api/model` and `POST /api/state` name the file
  they are for and are refused with **409** `{file}` after a switch, so a tab that has not followed
  yet cannot write its old model over the new one.
- **Unsaved changes** are the UI's concern: before New, Open, Open Recent, Import, Close or Reload
  it asks "Save changes?" (Save / Don't save / Cancel; "Save anyway" for a model with errors), and
  it warns before the page is closed.

### 5.5 Flow

The UI loads the model text, validates and compiles it in the browser, and keeps the last valid rig
on screen while a newer version has errors. External writes (CLI, MCP, a text editor) are detected
by the file watcher (content hash for the model, stat signature for textures) and pushed as
`model-changed`; the UI reloads and keeps params, time, selection and camera. Inspector edits
change the raw document, go through an undo history and are written with
`PUT {doc, baseMtimeMs, file}`; a 409 means another program (an agent, a text editor) wrote the file
meanwhile, and the human chooses to reload or overwrite. The UI publishes its view state at most
every 200 ms; commands (`setParams`, `play`, `pause`, `seek`, `setAnimations` with layer options,
`select`, `setOverlay`, `focus`, `reload`, `message`) arrive over SSE. The editor evaluates the same
`Pose` as the CLI, so its inspector shows the live `pose.ik` and `pose.physics` diagnostics of a
selected constraint or physics group, and a pinned physics output is an explicit value (it beats
physics until released).

Without a model the UI shows its start screen: New (from a template), Open, Import, the recent files
of this workspace and example cards (an example is copied into the workspace through the New dialog,
never edited in place). The File menu offers New (Alt+N), Open (Ctrl+O), Open Recent, Save (Ctrl+S),
Save As (Ctrl+Shift+S), Import from computer, Download copy, Export PNG of the view, Reload from disk
and Close. An agent switches models with `rev2d editor command --open <file>` or MCP
`rev2d_editor_command {command: {type: "open", file}}`: the server opens the file and every tab
follows `file-changed`; commands sent right after it apply to the newly opened model.

Safety: the server binds to loopback by default, answers only requests whose `Host` is local or
explicitly allowed (DNS-rebinding guard), accepts browser writes only from the same origin, and
reads or writes nothing outside the workspace root. The agent endpoints additionally need the
per-server token (a header a foreign page cannot send) and exist only on a loopback bind unless
`--allow-agent`; the agent runs in the workspace root or a project folder inside it, with one of two
sandboxes ([AGENT-BRIDGE.md](AGENT-BRIDGE.md#3-security-model)).

### 5.6 The editor UI

```text
 editor/src/
   main.tsx, App.tsx       mount; the session drives everything (state/session.ts, state/app.ts)
   shell/                  the window: SplitView with floating panes, toolbar, status line, overlays;
                           registries: registerMode, registerPanel, registerToolbarAction
   shell/extensions.ts     one import line per feature module (rigMode, ai, avatar)
   design/                 the design system: tokens.css, base.css, components, icons (no dependencies)
   i18n/                   t() / useT(); locales/en|ko|ja/<namespace>.ts, one namespace per feature
   viewport/, gl/, overlay/, view/   the Rig mode's WebGL2 viewport, overlays, camera
   panels/                 outliner, inspector pages, parameters, timeline, problems
   files/                  File menu, start screen, dialogs, workspace browser, import, interop dialogs
   avatar/                 Avatar mode: store, canvas with handles, parts list, live preview, mode document
   ai/                     the AI panel: store, client (agent endpoints + SSE), conversation, composer
   ui/                     small shared pieces (Dialog, Notice, Keys, FieldRow, Chip, LinkButton)
```

- **Shell and modes.** The window is a full-bleed canvas under floating, translucent chrome
  (leading sidebar, trailing sidebar, bottom drawer, toolbar). A **workspace mode** says what the
  window is for and fills those slots: the built-in **Rig** mode (outliner, viewport, inspector,
  timeline) and **Avatar** mode. Which modes can show follows the open document
  (`documentKind`: a model, an avatar project without a built model, or none = the start screen);
  the mode picked for a document is remembered for it, and a newly opened document starts in its
  default mode (Avatar mode for an avatar project). A mode with a **document of its own**
  (`ModeDocument`: `getState`, `save`, `undo`, `redo`, `keptBy`) takes over Save, Undo, Redo, the
  shortcuts, the unsaved dot and the unsaved-changes prompt while it is on screen; Avatar mode's
  document is `avatar.json` (`editor/src/avatar/document.ts`). Extension points with examples:
  `editor/src/shell/README.md`.
- **Panels and toolbar actions.** A registered trailing panel is available in every mode next to the
  mode's own inspector; the AI panel registers under the reserved id `ai` (the sparkles button).
- **Design system.** iOS / iPadOS-inspired: one blue tint, light and dark appearance (or auto),
  glass or solid materials (solid when WebGL runs on a software rasterizer or the system asks for
  reduced transparency), concentric rounded shapes, the system font stack, an original icon set.
  Tokens and components in `editor/src/design/` (its README is the API), rationale in
  [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md), a live gallery in `editor/gallery.html`. Editor CSS uses
  tokens only (a test fails on colour literals).
- **Languages.** English, Korean and Japanese; the browser language decides (`?lang=ko` for one page
  load, or the setting). One typed dictionary per language: `locales/en.ts` defines the keys, and the
  compiler and `test/editor-i18n.test.ts` require Korean and Japanese for every key. Model ids, file
  names and core diagnostics are never translated.
- **Avatar mode** (`editor/src/avatar/`): the parts list of the spec (`describeAvatarParts`), the
  illustration with a handle per landmark, and a live preview compiled in the browser with
  `compileAvatar` from the spec and the current layer images on every edit; Pose, Lip Sync (through
  `src/lipsync`) and Selected pages; the stale-layers banner (a landmark that cuts layers moved) with
  Save and Rebuild Layers; the Drawn Variants section (states from `GET /api/avatar/variants`,
  imports as `POST /api/avatar/variants/import` jobs, drawing through the `avatar-variants` agent
  task); new projects from one picture (`POST /api/avatar/new`) placed by hand or by the
  `avatar-create` agent task.
- **AI panel** (`editor/src/ai/`): a conversation with Codex or Claude Code through the agent bridge:
  provider and reasoning effort, suggestions and task templates, the agent's messages, commands, file
  changes and to-dos as they arrive (SSE `agent-job`, resumed by sequence number after a reconnect),
  Stop, follow-up messages, the Allow Image Generation switch, and the one-click fix for the Windows
  Codex sandbox. Other features start tasks with `startAiTask` from `editor/src/ai/api.ts`.

## 6. Avatar builder and lip sync

```text
 picture.png ──► rev2d avatar new ──► source.png + avatar.json (draft: every landmark null)
                                          │  landmarks placed by an agent (grid, overlay, vision check)
                                          │  or by a person in Avatar mode
                                          ▼
 parseAvatarSpec ─ src/avatar/spec.ts           zod structure + avatar-* geometry checks (pointers, hints)
   ▼
 buildAvatarLayers(spec, source) ─ layers.ts    stage 1, image processing (src/avatar/image), slow
   each feature cuts its layers, fills the base behind them, claims its pixels, stores metadata
   ▼  textures/*.png + layers.json (LayersMeta)
 compileAvatar(spec, meta) ─ compile.ts         stage 2, fast (the editor runs it on every drag)
   ModelBuilder: one root lattice (avatarWarp) + nested warps, image / mesh parts, additive
   offset bindings from deformation fields, physics, animations, sprites of drawn variants
   ▼  model document
 spec.post ops (applyOps) ─► validateModel (0 errors) ─► findFolds (every parameter extreme) ─► <name>.r2d.json
   ▼
 avatarReviewPoses + the software renderer ─► review/*.png, summary.json
```

- **Features** (`src/avatar/features/`) run in a fixed order: head, body, eyes, mouth, brows,
  cheeks, hair, attachments, sprites, animations. Each implements up to three hooks of one interface
  (`features/types.ts`): `layers` (stage 1), `compile` (stage 2), `poses` (review poses). Features
  share deformation fields and weights (`fields.ts`), the draw-order ranges (`AVATAR_Z`) and the
  standard parameters (`STANDARD_PARAMETERS`, Live2D ids) of `builder.ts`.
- **Determinism.** The image operations are pure TypeScript with seeded randomness where any is used;
  the same spec and picture give the same layer bytes and the same model.
- **Stale layers.** `layerInputsHash(spec)` (`hash.ts`) fingerprints everything that changes the
  layer images (the fields marked "CUTS LAYERS"); a spec whose fingerprint differs from
  `layers.json` has stale layers. Saving in the editor recompiles from the existing layers; only a
  build cuts them again.
- **Drawn variants** (`variants*.ts`, `features/sprites.ts`, file IO in
  `src/node/avatar-variants.ts`): edit masks and prompts for an image generator, a check of every
  drawing against the source outside its mask, sprites cut from the accepted drawings and stored in
  `layers.json` with fingerprints, so a later landmark or layer change marks them stale.
- **Agent tools** (`tools/`): `avatarGrid` and `avatarOverlay` draw source-pixel grids and the
  landmarks, `makeVisionCheck` / `scoreVisionCheck` test whether an agent reads coordinates
  accurately.
- **Lip sync** (`src/lipsync/`): `textToMorae` splits kana, Hangul and romaji into beats with a
  viseme each; `lipSyncFromText` turns them into eased keys on `MouthOpen` / `MouthForm` (a Rev2D
  animation); `mouthShapeAt` gives the shape at a time for live preview (the editor's Lip Sync page);
  `decodeWav` + `lipSyncFromAudio` key `MouthOpen` from loudness. `VISEME_SHAPES` is the table the
  avatar builder places its drawn mouths on.

What the generated model looks like and why (one lattice, difference mattes, the eye closing, the
quality bar): [src/avatar/DESIGN.md](../src/avatar/DESIGN.md). The workflow: [AVATAR.md](AVATAR.md).

## 7. Extension points

| To add | Start in | Also update |
| --- | --- | --- |
| A model field or object | `src/core/schema.ts` | semantic checks, rig compile/evaluate, SPEC.md, editor inspector |
| A shape type | `ShapeSchema`, `src/core/geometry/shapes.ts` | `SHAPE_FIELDS` (`address.ts`), `rig/parts.ts`, SPEC §3.4 |
| A bindable property | `src/core/address.ts` | rig slots (`compile.ts`, `evaluate.ts`), `set` checks in `src/ops/values.ts`, SPEC §4 |
| A diagnostic | `src/core/validate/checks-*.ts` | `src/core/__tests__/validate.test.ts` |
| An edit op | `src/ops/catalog.ts` + a handler | `src/ops/index.ts` (`HANDLERS`), OPS.md |
| A CLI command | `src/cli/commands/*.ts` | registry `src/cli/commands/index.ts`, CLI.md, `test/cli.test.ts` |
| An MCP tool | `src/mcp/tools/*.ts` | MCP.md, tool list in `src/mcp/guide.ts`, `src/mcp/__tests__` |
| An overlay layer | `src/render/overlay.ts` | `OVERLAY_LAYERS` (`src/api/frame.ts`), `editor/src/overlay/` |
| An animation-layer option | `AnimationLayer` (`src/core/types.ts`) + schema | `src/core/rig/sampling.ts` / `events.ts`, `src/api/layers.ts` (string syntax shared by CLI and MCP), `src/ops/compose.ts`, `EditorLayer`, SPEC §6.4 |
| A result note | `PoseStats` (`src/api/stats.ts`) | the notes table in CLI.md; MCP rewrites CLI flags in notes to arguments (`src/mcp/context.ts`) |
| An editor command | `EditorCommand` (`src/node/editor-registry.ts`) | `src/server/protocol.ts`, `editor/src/state/session.ts`, CLI sugar, MCP tool |
| A workspace endpoint | a handler in `src/server/workspace-routes.ts` + `ROUTES` (`src/server/routes.ts`) | request/result types in `src/node/editor-registry.ts`, validation in `src/server/protocol.ts`, paths only through `WorkspaceRoot`, `editor/src/api.ts`, the protocol section of CLI.md, `src/server/__tests__/workspace.test.ts` |
| An interop feature | the converter in `src/interop/spine/` or `src/interop/live2d/` (report what is not converted with a stable code) | tests with hand-written fixtures, `src/node/interop.ts` for file IO, the CLI / MCP / server / editor front ends, INTEROP.md |
| An example model | `scripts/examples/<name>.ts` | examples/README.md + its feature matrix, `test/examples.test.ts` |
| A recipe | `docs/RECIPES.md` with check markers | `test/docs-recipes.test.ts` runs it; add assertions for numbers the text quotes |
| An avatar landmark / spec field | `src/avatar/schema.ts` (`.describe()` text is the `rev2d avatar schema` docs) | checks in `src/avatar/spec.ts`, `parts.ts` (editor handles, overlay), `hash.ts` if it cuts layers, the feature that uses it, AVATAR.md |
| An avatar feature | `src/avatar/features/<name>.ts` (the `AvatarFeature` interface) + `AVATAR_FEATURES` | its `AVATAR_Z` range, its review poses, tests with the `hana` fixture (`test/fixtures/avatar-hana.ts`), DESIGN.md, the parameter table of AVATAR.md |
| A drawn-variant id | `VARIANT_IDS` (`src/avatar/types.ts`) | `variants-areas.ts` (edit area), `variants-text.ts` (prompt), `features/sprites.ts` (where it shows), CLI.md and AVATAR.md variant tables |
| An agent task template | `registerTaskTemplate` next to the feature it belongs to (e.g. `src/server/avatar-agent-tasks.ts`) | a title in `editor/src/ai/words.ts`, AGENT-BRIDGE.md §5 |
| An agent provider | `src/node/agent/<name>.ts` + `PROVIDERS` | AGENT-BRIDGE.md §6, fake CLI in `test/fixtures/fake-agents/` |
| An editor mode, trailing panel or toolbar action | `registerMode` / `registerPanel` / `registerToolbarAction` (`editor/src/shell/registry.ts`) in the feature's module | one import line in `editor/src/shell/extensions.ts`; `editor/src/shell/README.md` |
| A UI string | `editor/src/i18n/locales/en/<namespace>.ts` | the same key in `ko/` and `ja/` (the build fails without them) |
| A design component or token | `editor/src/design/` (`components/`, `tokens.css`) | its README, the gallery, DESIGN-SYSTEM.md |

Programmatic use (Node): the model pipeline above is exported from the package root (the avatar
builder, lip sync and the agent runner are not yet: import `src/avatar/index.ts`,
`src/node/avatar.ts`, `src/lipsync/index.ts` from a checkout). Inside this repository,
run TypeScript against the sources with the `rev2d-source` export condition
(`npx tsx --conditions=rev2d-source script.ts`); a built package (`npm run build`) resolves to `dist/`.

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { loadModelFile, renderFrame, inspectPose, encodePNG, applyOps, parseJsonc, formatModelJson } from 'rev2d';

const m = await loadModelFile('examples/hana/hana.r2d.json');        // never throws for model problems
const { image } = renderFrame(m, { params: { AngleX: 30 }, overlay: ['warps'], scale: 0.5 });
writeFileSync('out/hana-turn.png', encodePNG(image));
const mouth = inspectPose(m, { params: { AngleX: 30 } }).parts?.find((p) => p.id === 'mouth');

const raw = parseJsonc(readFileSync('examples/minimal/minimal.r2d.json', 'utf8'));
const { ok, doc, results } = applyOps(raw.ok ? raw.value : null, [{ op: 'set', target: 'bone:root.rotation', value: 10 }]);
if (ok) writeFileSync('out/minimal-rotated.r2d.json', formatModelJson(doc));

const player = m.rig!.player();                                       // sequential playback
for (const time of [0, 0.5, 1]) console.log(player.update({ time, animations: ['idle'] }).params);

const rig = m.rig!;                                                   // layers, diagnostics, point mapping
const pose = rig.pose({ time: 2, animations: ['look_around', { id: 'talk', mode: 'add' }, { id: 'blink', start: 1.5, hold: false }] });
console.log(pose.physics.hairFront?.outputs, rig.mapPoint(pose, 'faceWarp', 256, 200));
```

The layer-string syntax of the CLI and MCP (`"talk@0.8,add"`, `"wink,once,start=2.5"`) is parsed
by `parseLayerSpec` / `toLayer` in `src/api/layers.ts`.
