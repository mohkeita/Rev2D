# Rev2D

**An AI-friendly 2D rigging and animation toolkit in the spirit of Live2D Cubism and Spine.**
Models are plain JSON text, renders are deterministic and headless, and every step of authoring
comes with a way to check it: overlays, contact sheets, exact numbers, precise diagnostics, atomic
edit operations, an MCP server, and a live editor in which the AI and the human look at the same
model.

[한국어 소개](#한국어-소개) · [Quick start](#quick-start) · [Guide for AI agents](AGENTS.md) ·
[Recipes](docs/RECIPES.md) · [Format spec](docs/SPEC.md)

<p>
  <img src="docs/images/hana.png" width="312" alt="hana, a Live2D-style anime bust built from vector parts, rendered in its default pose">
  <img src="docs/images/hana-turn.png" width="304" alt="3x3 contact sheet of hana turning her head: AngleX -30, 0, 30 across, AngleY 30, 0, -30 down">
</p>
<p>
  <img src="docs/images/robot-arm-bones.png" width="373" alt="robot arm reaching with two-bone IK, rendered with the bone overlay">
  <img src="docs/images/minimal-overlay.png" width="280" alt="the minimal example bent to one side, with its 2x2 warp lattice, bone, labels and coordinate grid overlaid">
</p>
<p>
  <img src="docs/images/slime-jump.png" width="573" alt="8-frame contact sheet of the slime's jump animation: anticipation squash, stretch, apex, landing squash, settle, with the takeoff and land events under their frames">
</p>

Every image above is CLI output (see [Regenerating the images](#regenerating-the-images)).

## Why Rev2D

Rigging tools are built for mouse and eyes. Rev2D keeps the concepts of Live2D and Spine but makes
every one of them readable, writable and checkable by a program:

- **Text-first format.** One `*.r2d.json` file (JSONC allowed) holds parameters, bones, warps,
  parts, bindings, IK, physics and animations, all addressed by id. Geometry is in canvas pixels,
  so an agent can reason about positions directly. [SPEC.md](docs/SPEC.md)
- **Deterministic headless renders.** A pure TypeScript rasterizer with no GPU or browser: the same
  model and inputs always give the same pixels, so a render is evidence, not a guess.
- **Self-verification built in.** Debug overlays (bones, warp lattices, meshes, bounds, labels,
  coordinate grid; `--only` focuses them on a few ids), contact sheets of parameter sweeps,
  parameter overviews and animation windows, GIFs and frame sequences, `inspect` for exact world
  transforms, bounds, IK reach and physics outputs (also as a table over time, or for any point
  attached to a bone, warp or part), `analyze` for a whole animation (ranges, physics clamping, IK snap
  risk, events, loop seam), `hit` for "what is under this pixel", image diffs. Renders add notes
  when something looks wrong.
- **Precise diagnostics.** Every problem has a JSON pointer, a stable code and a fix hint
  (`unknown parent "bodyWarpp" → did you mean "bodyWarp"?`).
- **Atomic edit operations.** `add` and `update` (bones by `world` position and `worldRotation`
  if you like), `remove` (with cascade), `rename` (rewrites every reference), `set`, `bind`
  (absolute or relative), `bind_linear`, `bind_warp` (pseudo-3D head turns from yaw/pitch),
  `follow` (a rigid accessory that stays on a deforming head), `key`, `recolor`, `compose` (bake
  layered animations), `patch`... A batch applies completely and validates, or nothing is written.
  [OPS.md](docs/OPS.md)
- **MCP server.** 16 tools for Claude Code and other MCP clients; renders come back as images.
  [MCP.md](docs/MCP.md)
- **Live editor bridge.** `rev2d edit` opens a web editor that live-reloads every change the AI
  writes; the AI can read the human's view state, take a screenshot of exactly what they see, and
  pose the model or play animations for them.

## Feature map: Live2D / Spine concepts in Rev2D

| Concept | In Rev2D | See |
| --- | --- | --- |
| Parameters (Live2D) | `parameters`: named scalars with range, default and group; the control surface that bindings, animations and physics share | every example |
| Warp deformers (Live2D) | `warps`: `cols × rows` lattices, nestable, parented to bones or other warps; `bind_warp` generates pseudo-3D turns from yaw/pitch; `follow` keeps a rigid accessory on a turning head | `hana` 8×8 `faceWarp`, [recipe 16](docs/RECIPES.md#16-rigid-accessory-on-a-turning-head-hat) |
| Rotation deformers (Live2D) | bones: a bone is a pivot with a rotation you bind to a parameter | `hana` `AngleZ` → `bone:head.rotation` |
| Keyform bindings | 1-3 parameters per binding, full keyform grid, multilinear (or step) interpolation; bindings on one property add up | `hana` 3×3 `AngleX × AngleY` head turn |
| Shape keyforms / deform keys | bind shape fields: SVG path morphs (`shape.d`), polygon points, mesh vertices, ellipse/rect fields | `hana` mouth: 6 path keyforms over 2 parameters |
| Bones (Spine) | hierarchy with local x/y/rotation/scale/length | `robot-arm` |
| IK constraints (Spine) | one-bone aim and two-bone IK with `mix`, bend direction, `softness` (no knee snap near full reach) and `stretch` | `robot-arm` `armIk`, [recipe 19](docs/RECIPES.md#19-walk-cycle-smooth-keys-track-offset-soft-ik) |
| Skinning / weighted meshes (Spine) | `skin`: linear blend skinning with automatic (distance-based) or explicit weights | `robot-arm` elbow boot and cable |
| Physics (Live2D) | pendulum chains at a fixed 60 Hz: inputs x / y / angle → output parameters; explicit parameter values override the outputs | `hana` hair, `robot-arm` cable |
| Clipping masks | `mask`: clip to the union of other parts (geometry and texture alpha), `maskInvert` | `hana` irises, `textured` sheen |
| Blend modes | `normal`, `add`, `multiply`, `screen` | `slime` glow and shadow |
| Draw order | `z` then array order; `z` is bindable and animatable | [recipe 9](docs/RECIPES.md#9-draw-order-swap-step-binding-on-z) |
| Animations / motions | tracks on parameters (preferred) or any property; named easings, `smooth` (Catmull-Rom through the keys) and cubic-bezier; per-track time `offset`; loop or one-shot | `hana` `idle` + `blink` |
| Motion layering | several animations at once with weights, `override` or `add` mode, a `start` time and `once` one-shots; the `compose` op bakes a layer stack into one animation | [recipe 15](docs/RECIPES.md#15-gestures-over-an-idle-add-once-compose) |
| Events | timed named events with JSON data | `slime` `takeoff` / `land` |
| Textures and meshes | PNG textures, atlas crops as subdivided image grids, textured meshes with uvs | `textured` |
| Paint | solid colors, linear/radial gradients, strokes with joins and inside/center/outside alignment, tint, opacity | every example |
| Editor | web editor: outliner, WebGL viewport with overlays, parameter sliders (pin a physics output to hold it), inspector (live IK and physics diagnostics), timeline with layer options, problems panel, undo/redo, live reload | `rev2d edit` |

## Quick start

Requirements: Node 22+.

```sh
git clone <this repository> Rev2D && cd Rev2D
npm install

npx rev2d new hero.r2d.json                        # a small valid rig (or --template empty|hana|robot-arm|slime|textured|minimal)
npx rev2d validate hero.r2d.json                   # diagnostics with JSON pointers and hints
npx rev2d render hero.r2d.json -o out/hero.png --overlay bones,warps,labels
npx rev2d sheet hero.r2d.json -o out/lean.png --sweep Lean --sweep Squash=0,1 --scale 0.5
npx rev2d sheet hero.r2d.json -o out/params.png --overview --scale 0.4   # every parameter over its range
npx rev2d sheet hero.r2d.json -o out/idle.png --anim idle --frames 8 --scale 0.5
npx rev2d inspect hero.r2d.json --param Lean=1 --part eye --json
npx rev2d analyze hero.r2d.json --anim idle         # ranges, physics clamping, IK reach, loop seam
npx rev2d set hero.r2d.json part:eye.fill=#ffcc00 --render out/eye.png
npx rev2d gif hero.r2d.json -o out/idle.gif --anim idle --scale 0.5
npx rev2d edit hero.r2d.json                       # live editor at http://127.0.0.1:4777
```

`--template empty` gives a model with nothing but its canvas, for building everything with ops.

`npx rev2d` works inside the repository; from anywhere else run
`node /path/to/Rev2D/bin/rev2d.js <command>`. `rev2d help <command>` lists every flag, and
[CLI.md](docs/CLI.md) documents every command and its `--json` output.

A model is ordinary JSON. This is the core of [`examples/minimal`](examples/minimal/minimal.r2d.json):
a parameter, a bone, a warp, two parts, a binding and an animation.

```jsonc
{
  "format": "rev2d", "version": 1,
  "meta": { "name": "minimal", "width": 256, "height": 256, "background": "#1f2430" },
  "parameters": [ { "id": "Lean", "min": -1, "max": 1, "default": 0 } ],
  "bones": [ { "id": "root", "x": 128, "y": 210 } ],
  "warps": [ { "id": "bodyWarp", "parent": "root", "rect": [68, 60, 120, 150], "cols": 2, "rows": 2 } ],
  "parts": [
    { "id": "body", "parent": "bodyWarp", "shape": { "type": "ellipse", "cx": 128, "cy": 140, "rx": 56, "ry": 66, "detail": 10 }, "fill": "#2f9e6e" },
    { "id": "eye", "parent": "bodyWarp", "shape": { "type": "ellipse", "cx": 128, "cy": 124, "rx": 9, "ry": 14 }, "fill": "#14432f", "z": 1 }
  ],
  "bindings": [
    { "target": "warp:bodyWarp.offsets", "params": ["Lean"], "keys": [
      { "at": [-1], "value": { "0": [-28, 4], "1": [-28, 4], "2": [-28, 4], "3": [-14, 0], "4": [-14, 0], "5": [-14, 0] } },
      { "at": [0], "value": {} },
      { "at": [1], "value": { "0": [28, 4], "1": [28, 4], "2": [28, 4], "3": [14, 0], "4": [14, 0], "5": [14, 0] } } ] }
  ],
  "animations": [
    { "id": "sway", "duration": 2, "loop": true, "tracks": [ { "target": "param:Lean", "keys": [
      { "t": 0, "v": -1, "ease": "inOutSine" }, { "t": 1, "v": 1, "ease": "inOutSine" }, { "t": 2, "v": -1 } ] } ] }
  ]
}
```

**Conventions.** Coordinates are canvas pixels with the origin top-left and **+y down**; angles are
degrees, **positive = clockwise**. Standard parameters follow Live2D names and signs
([SPEC.md §3.1](docs/SPEC.md#31-parameters)): `AngleX > 0` turns the face toward the screen
right, `AngleY > 0` looks **up** (features move to smaller y), `AngleZ > 0` tilts clockwise, and
`L` in an id is the character's left, which is on the screen right.

### Edit with operations

```sh
npx rev2d ops hero.r2d.json --dry-run --op '{"op":"add","kind":"parameter","value":{"id":"EyeOpen","min":0,"max":1,"default":1}}' --op '{"op":"bind","target":"part:eye.shape.ry","params":["EyeOpen"],"keys":[{"at":[0],"value":2},{"at":[1],"value":26}]}'
```

Drop `--dry-run` to write. Ops are validated as a batch; nothing is written unless all of them
apply and the result is valid. Copy-paste batches for head turns, blinks, mouths, physics, IK,
skinning and more are in [docs/RECIPES.md](docs/RECIPES.md).

### Use it from Claude Code (MCP)

```sh
claude mcp add rev2d -- node /absolute/path/to/Rev2D/bin/rev2d.js mcp
```

Add `--scope project` to share it through the project's `.mcp.json`. Ask the agent to call
`rev2d_guide` first; tools such as `rev2d_render`, `rev2d_sheet`, `rev2d_inspect`,
`rev2d_analyze` and `rev2d_apply_ops` then cover the whole authoring loop. Other MCP clients use the same command
(`node .../bin/rev2d.js mcp`, stdio). See [MCP.md](docs/MCP.md).

### Work together in the live editor

```sh
npx rev2d edit hero.r2d.json                                      # the human's window
npx rev2d editor command --params Lean=1 --message "lean check"   # the AI poses the model for them
npx rev2d editor screenshot -o out/seen.png                       # ...and sees exactly what they see
```

## The verification loop

This is the loop the tooling is designed around (full guide: [AGENTS.md](AGENTS.md)):

1. **Validate**: `rev2d validate model.r2d.json --json`, until there are no errors.
2. **Look**: `rev2d render ... --overlay bones,warps,labels,grid --viewbox fit`, and read the
   notes (IK out of reach, physics clamped, parts outside the view).
3. **Sweep**: `rev2d sheet ... --sweep AngleX --sweep AngleY=30,0,-30`, `--overview`, or
   `--anim idle`: a whole parameter range, every parameter, or an animation in one captioned image.
4. **Measure**: `rev2d inspect ... --param AngleX=30 --json`: bone world transforms, part bounds,
   warp points, draw order, bound values, events, IK reach, physics outputs;
   `--point 256,120@head` for where an attached point goes; `--times 0:2:9 --track ...` for a table
   over time.
5. **Analyze motion**: `rev2d analyze ... --anim idle --warmup 10`: parameter ranges, physics
   clamping, IK snap risk, events and whether the loop closes.
6. **Fix**: `rev2d ops model.r2d.json edits.json --dry-run`, then write; back to 1.

## Architecture

```text
 .r2d.json ─► validate (schema + semantic diagnostics) ─► Rig compile ─► pose(params, animations, time)
            ─► render list ─► software rasterizer (PNG, sheets, GIFs, overlays)   or   WebGL2 (editor)
 front ends: CLI (rev2d) · MCP server · editor server (HTTP + SSE) + React editor
 shared:     src/api (render/sheet/inspect/hit) · src/ops (edit engine) · src/node (files, textures)
```

The core (`src/core`) has no Node or DOM dependencies and runs unchanged in the browser editor,
so the editor, the CLI and the MCP server evaluate models with the same code. Details:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository layout

```text
bin/rev2d.js           CLI launcher
src/core/              format schema, types, addresses, validation, geometry compiler, rig evaluation
src/render/            software rasterizer, overlays, bitmap font, sheets, diff, GIF, PNG
src/node/              file and texture loading, running-editor registry
src/api/               high-level operations shared by CLI / MCP / editor server (layers, sampling, sheets, inspect, analyze), templates
src/ops/               edit operations engine
src/cli/               the rev2d command line
src/mcp/               MCP server (tools, resources, quickstart guide)
src/server/            editor server: model API, live reload (SSE), AI bridge, screenshots
editor/                React 19 + WebGL2 editor UI (Vite)
examples/              hana, robot-arm, slime, textured, minimal (generated by scripts/examples/)
scripts/               example builders, texture generator, render scripts
docs/                  SPEC, CLI, OPS, MCP, ARCHITECTURE, RECIPES, images
test/                  cross-module and end-to-end tests (unit tests live in src/**/__tests__/)
```

## Documentation

| Document | What it covers |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Guide for AI agents: mental model, verification loop, diagnostics, addresses, pitfalls, MCP tools; developing Rev2D |
| [docs/SPEC.md](docs/SPEC.md) | Model format and evaluation semantics (authoritative) |
| [docs/RECIPES.md](docs/RECIPES.md) | Copy-paste rig recipes, each with the commands that verify it (all executed by the test suite) |
| [docs/OPS.md](docs/OPS.md) | Edit operations, reference handling, `bind_warp` math, worked example |
| [docs/CLI.md](docs/CLI.md) | Every command, flag, exit code and `--json` shape |
| [docs/MCP.md](docs/MCP.md) | MCP server setup and tools |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Pipeline, modules, data contracts, determinism, editor protocol |
| [examples/README.md](examples/README.md) | The example models and the techniques each one shows |
| [llms.txt](llms.txt) | Index for LLM tools |

SPEC, OPS, CLI, MCP, AGENTS, RECIPES, ARCHITECTURE and the examples guide are also served by the
tool itself: `rev2d docs <spec|ops|cli|mcp|agents|recipes|architecture|examples>` and MCP
`rev2d_docs {topic}`.

## Development

```sh
npm test                               # the full vitest suite
npx vitest run src/ops                 # one area
npx tsc --noEmit -p tsconfig.json      # typecheck (npm run typecheck)
npm run editor:dev                     # editor UI with hot reload (proxies /api to rev2d edit on :4777)
npm run editor:build                   # build the editor UI into dist/editor (served by rev2d edit)
npx tsx scripts/build-examples.ts      # regenerate examples/ from their builders
npx tsx scripts/render-examples.ts     # render every example into out/examples/
```

The editor end-to-end test uses playwright-core with an installed Chrome and skips (with the reason)
when the UI is not built or Chrome is unavailable. Conventions, module boundaries and where to add
features: [AGENTS.md, Part 2](AGENTS.md#part-2-developing-rev2d).

### Regenerating the images

```sh
npx rev2d render examples/hana/hana.r2d.json -o docs/images/hana.png --scale 0.625
npx rev2d sheet examples/hana/hana.r2d.json -o docs/images/hana-turn.png --sweep AngleX=-30,0,30 --sweep AngleY=30,0,-30 --scale 0.6 --viewbox 96,50,320,390 --title "hana: AngleX x AngleY (3x3 warp keyform grid)"
npx rev2d render examples/robot-arm/robot-arm.r2d.json -o docs/images/robot-arm-bones.png --overlay bones --param ReachX=0.5 --viewbox 40,60,560,420
npx rev2d render examples/minimal/minimal.r2d.json -o docs/images/minimal-overlay.png --overlay warps,bones,labels,grid --param Lean=1 --scale 1.25
npx rev2d sheet examples/slime/slime.r2d.json -o docs/images/slime-jump.png --anim jump --frames 8 --columns 4 --viewbox fit --scale 0.4
```

## License

MIT. See [LICENSE](LICENSE).

---

## 한국어 소개

**Rev2D**는 Live2D Cubism과 Spine의 개념(파라미터, 워프 디포머, 본, 키폼 바인딩, 물리, IK,
스키닝, 마스크, 블렌드 모드, 애니메이션)을 그대로 가져오면서, **AI 에이전트가 텍스트만으로 리깅
모델을 만들고 스스로 검증할 수 있도록** 설계한 2D 리깅·애니메이션 툴킷입니다.

- **텍스트 포맷**: 모델 하나가 JSON 파일(`*.r2d.json`) 하나입니다. 모든 좌표는 캔버스 픽셀
  (원점 왼쪽 위, +y 아래 방향), 각도는 시계 방향이 양수입니다. 표준 파라미터는 Live2D 규칙을
  따릅니다: `AngleX > 0`은 화면 오른쪽으로 고개를 돌리고, `AngleY > 0`은 **위를** 봅니다(특징점의
  y가 작아짐). `L`은 캐릭터의 왼쪽, 즉 화면의 오른쪽입니다.
- **결정론적 헤드리스 렌더링**: 순수 TypeScript 래스터라이저라서 GPU나 브라우저 없이도
  같은 모델과 입력이면 언제나 같은 픽셀이 나옵니다.
- **자기 검증 도구**: 본·워프·메시·라벨·좌표 격자 오버레이(`--only`로 일부만 표시), 파라미터
  스윕·전체 파라미터 개요·애니메이션 컨택트 시트, `inspect`의 정확한 수치(본 월드 좌표, 파츠 경계,
  IK 도달 여부, 물리 출력, 본·워프·파츠에 붙은 점의 위치, 시간별 표), `analyze`의 애니메이션 분석
  (물리 클램핑, IK 튐 위험, 이벤트, 루프 이음새), 이미지 diff.
- **정확한 진단**: 모든 오류에 JSON 포인터, 고정 코드, 수정 힌트(did-you-mean)가 붙습니다.
- **원자적 편집 연산(ops)**: 배치 전체가 성공하고 검증을 통과할 때만 파일에 기록됩니다.
  `recolor`(팔레트 변경), `compose`(레이어 애니메이션 굽기), `bind_linear`, `follow`(돌아가는
  머리 위에 모자 같은 강체 액세서리 고정)도 있습니다.
- **MCP 서버와 라이브 에디터**: Claude Code 등에서 바로 쓸 수 있는 MCP 도구 16개를 제공하며,
  `rev2d edit`로 연 웹 에디터는 AI의 수정을 즉시 반영하고, AI는 사람이 보고 있는 화면을 그대로
  확인하고 조작할 수 있습니다.

빠른 시작:

```sh
npm install
npx rev2d new hero.r2d.json --template hana
npx rev2d render hero.r2d.json -o out/hero.png --overlay bones,warps,labels
npx rev2d sheet hero.r2d.json -o out/turn.png --sweep AngleX --sweep AngleY=30,0,-30 --scale 0.5
npx rev2d analyze hero.r2d.json --anim idle --warmup 10
claude mcp add rev2d -- node /absolute/path/to/Rev2D/bin/rev2d.js mcp
```

AI 에이전트용 안내는 [AGENTS.md](AGENTS.md), 따라 하기 쉬운 리깅 레시피는
[docs/RECIPES.md](docs/RECIPES.md), 포맷 명세는 [docs/SPEC.md](docs/SPEC.md)를 참고하세요.
