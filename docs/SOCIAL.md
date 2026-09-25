# Rev2D launch copy: X (Twitter) and GitHub

Ready-to-post copy for the Rev2D launch (repository: https://github.com/RevStudio/Rev2D).
X counts every link as 23 characters whatever its length, so the lengths below stay valid.
Each post names the file to attach; all files are in `docs/media/`.

This file is launch material: it is not part of the npm package (`package.json` excludes it) and
the `rev2d docs` command does not serve it.

## Media

| File | Length | Size | Use |
| --- | --- | --- | --- |
| `rev2d-demo.mp4` | 65 s, 1280×720 | 5.0 MB | Post 1 of each thread: the full demo (English headlines, Korean captions) |
| `clip-ai-live-edit.mp4` | 19.6 s, 1280×720 | 1.5 MB | Post 2: an AI runs real commands while the real editor updates |
| `clip-verify.mp4` | 10.6 s, 1280×720 | 1.2 MB | Post 3: overlay render, sweep sheet, overview sheet, `analyze` |
| `clip-showcase.mp4` | 9.6 s, 1280×720 | 1.0 MB | Post 4: the example models animating |
| `hero.gif` | 8 s loop, 720×540 | 3.8 MB | Post 4 alternative (a GIF loops without a play button) |
| `poster.png` | 1280×720 | 0.2 MB | Optional image for post 5, and the GitHub social preview |

`poster.png` and the end of `rev2d-demo.mp4` show the test count at capture time (1,351). The
posts say "1,350+" so they agree with the media and stay true as tests are added.

## English thread

### 1/5 · attach `rev2d-demo.mp4`

```text
Meet Rev2D: Live2D/Spine-style 2D rigging & animation, built for AI agents 🧵

A rig is one JSON file. Through a CLI and an MCP server, an agent builds it, renders it, measures it, fixes it and proves it works.

Open source, MIT.
#Live2D #Spine2D #AIagents #gamedev #MCP
```

Alt text: Rev2D demo. Four example models animate, an AI edits a character in a live editor
through real commands, and the tool checks its own renders.

### 2/5 · attach `clip-ai-live-edit.mp4`

```text
The AI works in the editor you're watching.

It runs real rev2d commands: recolors the hair, turns the head, plays "talk", then takes a screenshot of exactly what you see to check its work.

The editor reloads live on every change.
```

Alt text: A terminal runs rev2d commands on the left; on the right the Rev2D editor turns the
character's hair teal, turns her head and plays a talking animation.

### 3/5 · attach `clip-verify.mp4`

```text
It checks its own work: rig overlays, a 3×3 head-turn sweep in one image, and an analyze report with physics clamping and loop seams as numbers.

Errors point to the exact spot, with the fix:
unknown parent "bodyWarpp" → did you mean "bodyWarp"?
```

Alt text: A render with bone and warp overlays, a 3 by 3 grid of head-turn poses, a grid of every
parameter, and a text report of an animation analysis.

### 4/5 · attach `clip-showcase.mp4` (or `hero.gif`)

```text
The concepts you know from Live2D and Spine: parameters, warp deformers, bones, keyform bindings, two-bone IK, skinning, pendulum physics, masks, blend modes, layered animations.

5 example models ship as templates. Renders are deterministic: same input, same pixels.
```

Alt text: An anime bust looking around, a jumping slime, a robot arm reaching with IK, and
textured carp streamers fluttering on a pole.

### 5/5 · no media (or `poster.png`)

```text
Plug it into Claude Code (16 MCP tools):

claude mcp add rev2d -- node /path/to/Rev2D/bin/rev2d.js mcp

Plus a 19-command CLI, a live web editor with a File menu, and 1,350+ tests. v0.1, Node 22+. Feedback welcome!

https://github.com/RevStudio/Rev2D
```

## Korean thread (한국어 스레드)

### 1/5 · `rev2d-demo.mp4` 첨부

```text
Rev2D를 공개합니다 🧵

AI 에이전트를 위한 Live2D·Spine 스타일 2D 리깅·애니메이션 툴킷입니다. 리그 하나가 JSON 파일 하나이고, AI가 CLI와 MCP로 직접 만들고 렌더하고 수치로 검증하고 고칩니다.

오픈소스(MIT)
#라이브2D #Live2D #게임개발 #AI에이전트
```

대체 텍스트: Rev2D 데모. 예제 모델 네 개가 움직이고, AI가 실제 명령으로 라이브 에디터 속 캐릭터를
수정하고, 렌더 결과를 스스로 검증합니다.

### 2/5 · `clip-ai-live-edit.mp4` 첨부

```text
사람이 보고 있는 에디터에서 AI가 바로 작업합니다.

실제 rev2d 명령으로 머리색을 바꾸고, 고개를 돌리고, talk 애니메이션을 재생한 뒤, 사람이 보는 화면을 그대로 스크린샷으로 찍어 확인합니다. 모든 변경이 에디터에 실시간으로 반영됩니다.
```

대체 텍스트: 왼쪽 터미널에서 rev2d 명령이 실행되고, 오른쪽 Rev2D 에디터에서 캐릭터의 머리색이
청록색으로 바뀌고 고개를 돌리며 말하는 애니메이션이 재생됩니다.

### 3/5 · `clip-verify.mp4` 첨부

```text
AI가 스스로 결과를 검증합니다.

리그 오버레이, 고개 회전 3×3 스윕을 이미지 한 장으로 보고, analyze로 물리 클램핑과 루프 이음새를 숫자로 확인합니다. 오류에는 파일 속 위치와 수정 힌트가 붙습니다:
unknown parent "bodyWarpp" → did you mean "bodyWarp"?
```

대체 텍스트: 본과 워프 오버레이가 그려진 렌더, 고개 회전 포즈 3×3 격자, 모든 파라미터 격자, 애니메이션
분석 텍스트 리포트.

### 4/5 · `clip-showcase.mp4` (또는 `hero.gif`) 첨부

```text
파라미터, 워프 디포머, 본, 키폼 바인딩, 투본 IK, 스키닝, 진자 물리, 마스크, 블렌드 모드, 애니메이션 레이어까지 Live2D·Spine의 핵심 개념을 담았습니다.

예제 모델 5종을 템플릿으로 바로 쓸 수 있고, 같은 입력이면 언제나 같은 픽셀이 렌더됩니다.
```

대체 텍스트: 주위를 둘러보는 애니메이션 캐릭터, 점프하는 슬라임, IK로 뻗는 로봇 팔, 깃대에서
펄럭이는 잉어 깃발.

### 5/5 · 미디어 없음 (또는 `poster.png`)

```text
Claude Code에 연결하면 MCP 도구 16개를 쓸 수 있습니다:

claude mcp add rev2d -- node /path/to/Rev2D/bin/rev2d.js mcp

CLI 명령 19개, 파일 메뉴가 있는 라이브 웹 에디터, 테스트 1,350개 이상. v0.1, Node 22+. 피드백 환영합니다!

https://github.com/RevStudio/Rev2D
```

## Weighted lengths

X allows 280 weighted characters per post. It counts most Latin characters and punctuation as 1,
Hangul, CJK, emoji and some symbols (`→`, `…`) as 2, and every link as 23. The table was computed
with the official `twitter-text` library (`parseTweet`, v3 rules), with the repository
link counted as a link.

<!-- x-lengths:start -->
| Thread | Post | Attach | Weighted length | Left of 280 |
| --- | --- | --- | ---: | ---: |
| English | 1/5 | `rev2d-demo.mp4` | 270 | 10 |
| English | 2/5 | `clip-ai-live-edit.mp4` | 231 | 49 |
| English | 3/5 | `clip-verify.mp4` | 246 | 34 |
| English | 4/5 | `clip-showcase.mp4` (or `hero.gif`) | 267 | 13 |
| English | 5/5 | none (or `poster.png`) | 239 | 41 |
| Korean | 1/5 | `rev2d-demo.mp4` | 243 | 37 |
| Korean | 2/5 | `clip-ai-live-edit.mp4` | 231 | 49 |
| Korean | 3/5 | `clip-verify.mp4` | 248 | 32 |
| Korean | 4/5 | `clip-showcase.mp4` (or `hero.gif`) | 239 | 41 |
| Korean | 5/5 | none (or `poster.png`) | 248 | 32 |
<!-- x-lengths:end -->

## GitHub repository

### Description (About)

GitHub allows up to 350 characters.

```text
Live2D/Spine-style 2D rigging & animation, built for AI agents. A rig is one JSON file; a deterministic headless renderer, a CLI and an MCP server (16 tools) let an agent author, render, measure and fix it, and a live web editor lets the AI see and drive what you are looking at.
```

### Topics

```text
2d-animation rigging live2d spine skeletal-animation ai-agents mcp model-context-protocol claude-code typescript webgl2 gamedev
```

### Social preview

Settings → General → Social preview: upload `docs/media/social-preview.png` (1280×640, GitHub's
recommended size; the poster cropped by 40 px top and bottom). GitHub has no API for this image,
so it has to be uploaded in the web UI.

### Hashtags

- English: `#Live2D` `#Spine2D` `#AIagents` `#gamedev` `#MCP`
- Korean: `#라이브2D` `#Live2D` `#게임개발` `#AI에이전트`
