# Rev2D architecture

How a `*.r2d.json` file becomes pixels, which module owns which step, the data contracts between
them, what is guaranteed to be deterministic, how the editor talks to the CLI/MCP side, and where to
extend the system. For the file format itself see [SPEC.md](SPEC.md); for day-to-day development
rules see [AGENTS.md, Part 2](../AGENTS.md#part-2-developing-rev2d).

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
     ▲ HTTP + SSE
 editor/     (React + WebGL2 UI; also runs src/core in the browser)

 shared by the front ends: src/ops (edit engine) · src/node (files, textures, editor registry)
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
| `src/node/` | File loading (`load.ts`) and the running-editor registry (`editor-registry.ts`, `~/.rev2d/editors/`). | The only place core models touch the filesystem. |
| `src/api/` | `layers.ts` (layer strings `"talk@0.8,add"`, `"wink,once,start=2"` → `AnimationLayer`), `pose.ts` (`toPoseOptions`), `frame.ts` (`renderFrame`, view boxes, `--only` checks), `sampling.ts` (time specs, sample plans with window and warm-up, sequential poses, frame events), `stats.ts` (`PoseStats`: the IK / physics / view-box notes), `sheet.ts` (sweeps incl. linked ones, `buildSheet` for animation / sweep / overview sheets), `inspect.ts` (`inspectPose`, `inspectSeries`, `trackSeries`, mapped points), `analyze.ts` (`analyzeAnimation`), `info.ts`, `templates.ts` (`blank`, `empty`, examples), `docs.ts` (the recipe list of docs/RECIPES.md for `rev2d docs` and MCP `rev2d_docs`); `index.ts` re-exports them and holds `hitTest`. | Throws `ApiError` with a hint and diagnostics. |
| `src/ops/` | `applyOps` (atomic batches on the raw JSON document), `describeOps` (the catalogue behind MCP descriptions and hints), reference tracking for rename/cascade, `bind_warp` math, `recolor`, `compose` (evaluates the layers through `Rig` to bake them), `follow` (poses the rig and maps the anchor with `Rig.mapPoint` per keyform), change summaries for `update` messages (`diff.ts`). | Operates on raw documents so untouched text stays as written. |
| `src/cli/` | The `rev2d` command line: argument parser, command registry, help, `--json` output, exit codes. | `main(argv, io)` is testable in-process. |
| `src/mcp/` | MCP server over stdio: tools, resources, the quickstart guide. | stdout belongs to the protocol. |
| `src/server/` | Editor server: model file API, texture serving, SSE live reload, shared view state, commands, server-side screenshots, file watching. | Loopback-only by default. |
| `editor/` | React 19 editor UI: outliner, viewport (WebGL2), parameters (pin physics outputs, sliders tinted by their driver), inspector (live IK and physics diagnostics), timeline (layers with over/add, start, hold/once), problems panel. Validates and evaluates models in the browser with `src/core`. | Built into `dist/editor` by `npm run editor:build`. |
| `scripts/` | Example builders (`scripts/examples/`), texture generator, render scripts. | Examples are generated; see examples/README.md. |

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
`EditorState` / `EditorLayer` / `EditorCommand` (`src/node/editor-registry.ts`). These shapes only
ever gain fields.

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

`rev2d edit <model>` starts `src/server` (default `http://127.0.0.1:4777`), serves the built UI from
`dist/editor` (or the Vite dev middleware when unbuilt), and registers itself in
`~/.rev2d/editors/<pid>-<port>.json` so `rev2d editor ...` and the MCP editor tools can find it.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/model` | `{file, text, mtimeMs}`: the raw file text |
| `PUT /api/model[?force=1]` | write `{text}` or `{doc}` plus optional `baseMtimeMs`; returns `{ok, written, diagnostics, mtimeMs}`, or **409** `{error, hint, mtimeMs}` when the file changed on disk since `baseMtimeMs` (nothing is written) |
| `GET /api/texture/:id` | a texture PNG |
| `GET /api/events` | SSE: `hello`, `model-changed {origin, mtimeMs, files}`, `command <EditorCommand>` |
| `GET` / `POST /api/state` | the UI's published `EditorState`: the evaluated params as shown (physics outputs and pinned values included), time, animation layers (`EditorLayer`: id, weight, mode, start, hold), playing, selection, overlay, visible region, physics toggle, preview-hidden parts, pinned params |
| `POST /api/command` | broadcast an `EditorCommand` to the open tabs; returns `{delivered}` |
| `GET /api/screenshot?overlay=&scale=&viewBox=` | PNG of the editor's current pose, rendered server-side from the published state (layer options applied, physics not re-simulated); headers `X-Rev2D-ViewBox`, `X-Rev2D-Scale`, `X-Rev2D-Source`, `X-Rev2D-Hidden`, `X-Rev2D-Ignored` |
| `GET /api/info` | `{info, diagnostics}` |

Errors are JSON `{error, hint?, ...}`; a model or state that cannot be posed is **422** with the
API error's hint and the diagnostics.

Flow: the UI loads the model text, validates and compiles it in the browser, and keeps the last
valid rig on screen while a newer version has errors. External writes (CLI, MCP, a text editor) are
detected by the file watcher (content hash for the model, stat signature for textures) and pushed
as `model-changed`; the UI reloads and keeps params, time, selection and camera. Inspector edits
change the raw document, go through an undo history and are written with `PUT {doc, baseMtimeMs}`;
a 409 means another program (an agent, a text editor) wrote the file meanwhile, and the human
chooses to reload or overwrite. The UI publishes its view state at most every 200 ms; commands
(`setParams`, `play`, `pause`, `seek`, `setAnimations` with layer options, `select`, `setOverlay`,
`focus`, `reload`, `message`) arrive over SSE. The editor evaluates the same `Pose` as the CLI, so
its inspector shows the live `pose.ik` and `pose.physics` diagnostics of a selected constraint or
physics group, and a pinned physics output is an explicit value (it beats physics until released).

Safety: the server binds to loopback by default, answers only requests whose `Host` is local or
explicitly allowed (DNS-rebinding guard), and accepts browser writes only from the same origin.

## 6. Extension points

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
| An example model | `scripts/examples/<name>.ts` | examples/README.md + its feature matrix, `test/examples.test.ts` |
| A recipe | `docs/RECIPES.md` with check markers | `test/docs-recipes.test.ts` runs it; add assertions for numbers the text quotes |

Programmatic use (Node): everything above is exported from the package root. Inside this repository,
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
