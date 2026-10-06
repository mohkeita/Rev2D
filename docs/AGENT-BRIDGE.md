# Agent bridge: coding agents inside the Rev2D editor

The editor can start a coding agent itself: the person types a request, the editor server starts the
**Codex CLI** or **Claude Code** in the workspace, shows what the agent does while it works (messages,
commands, file changes, to-dos) and reloads the model the moment the agent writes it. Nothing is
copied into a terminal by hand.

```text
 editor UI ──POST /api/agent/jobs──► editor server ──spawn (no shell, prompt on stdin)──► codex exec / claude -p
     ▲                                    │  AgentManager (src/node/agent)                    │ JSON lines
     └──SSE "agent-job" {job, state, event}◄── one normalised event stream ◄──────────────────┘
```

In the editor this is the **AI panel**: the sparkles button of the toolbar opens it in the trailing
sidebar, next to the inspector. The person picks Codex or Claude Code (with the reasoning effort),
types a request or picks a suggestion, and follows the conversation: the agent's messages, the
commands it runs, the files it changes and its to-do list, with Stop and follow-up messages that
continue the same conversation. Above the input it says where the agent works (the folder of the
open model, or the avatar project) and what it may do (edit files there; image generation is an
opt-in switch for Codex). When the bridge is off (no CLI installed, the editor not on a loopback
address) the panel explains why and how to turn it on. Other parts of the editor start their tasks
through it: Avatar mode's "Let AI Place Them" (the `avatar-create` template) and "Ask AI to Fix
This Part". The panel's code is `editor/src/ai/` (`api.ts` is what other modules call:
`openAiPanel`, `startAiTask`, `useAiJob`, `aiAvailability`).

- [1. Using it](#1-using-it)
- [2. Protocol](#2-protocol)
- [3. Security model](#3-security-model)
- [4. Providers](#4-providers)
- [5. The preamble and task templates](#5-the-preamble-and-task-templates)
- [6. Adding a provider](#6-adding-a-provider)
- [7. Logs](#7-logs)
- [8. Troubleshooting](#8-troubleshooting)

Code: `src/node/agent/` (the runner: providers, jobs, prompt, logs), `src/server/agent-routes.ts`
(the endpoints), types for the UI in `src/node/editor-registry.ts`. Tests: `test/agent-bridge*.test.ts`
and `src/server/__tests__/agent.test.ts`, with fake CLIs in `test/fixtures/fake-agents/`.

## 1. Using it

Install and sign in to at least one agent CLI, then start the editor as usual:

```sh
npm install -g @openai/codex && codex login     # Codex CLI
claude                                          # Claude Code: run it once and sign in (/login)
rev2d edit hero.r2d.json                        # the agent endpoints exist on 127.0.0.1 only
```

The agent works in the editor's **workspace root** (or a project folder inside it) with **your** login
of that CLI. One job runs at a time. A job is limited to 45 minutes, and is stopped when the CLI stays
silent for 15 minutes.

Trying the endpoints without the UI:

```sh
TOKEN=$(curl -s http://127.0.0.1:4777/api/session | node -pe "JSON.parse(require('fs').readFileSync(0)).token")
curl -s -H "X-Rev2D-Token: $TOKEN" http://127.0.0.1:4777/api/agent/providers
curl -s -H "X-Rev2D-Token: $TOKEN" -H "Content-Type: application/json" \
     -d '{"provider":"codex","prompt":"What does the Lean parameter drive?","sandbox":"read-only"}' \
     http://127.0.0.1:4777/api/agent/jobs
curl -s -H "X-Rev2D-Token: $TOKEN" http://127.0.0.1:4777/api/agent/jobs          # then /api/agent/jobs/<id>
```

## 2. Protocol

All endpoints are JSON over the editor server's HTTP API. Every `/api/agent/*` request needs the
header `X-Rev2D-Token` (see [Security model](#3-security-model)).

| Endpoint | Answer |
| --- | --- |
| `GET /api/session` | `{token, agent: {enabled, reason?}}`: the token for the calls below; `enabled: false` (with `token: null`) when the bridge is off |
| `GET /api/agent/providers` | `[{id, name, available, version, features: {imageGeneration}, efforts, hint?, windowsSandbox?}]` (`windowsSandbox`: Codex on Windows only, the effective [setting](#settings)) |
| `GET /api/agent/tasks` | `[{kind, title, description, needsPrompt}]`: the task templates |
| `GET /api/agent/jobs` | `{jobs: [job...], active: id \| null}`: the jobs the server remembers (newest first, at most 20) |
| `POST /api/agent/jobs` | `202 {job}`: starts a job |
| `GET /api/agent/jobs/:id?since=<seq>` | `{job, prompt, events, firstSeq, lastSeq}`: events with `seq > since` |
| `POST /api/agent/jobs/:id/cancel` | `{job}`: kills the agent and everything it started; answers once the job has ended |
| `POST /api/agent/jobs/:id/message` | `202 {job}`: a follow-up in the same provider session (a new job that resumes it) |
| `GET /api/agent/settings` | `{settings, sources, user, file, windows, notes}`: the effective [settings](#settings) and where each comes from |
| `PUT /api/agent/settings` | the same answer, after saving `{codexWindowsSandbox}` to the person's settings file |
| SSE `agent-job` on `GET /api/events` | `{job, state, event}` for every event of every job, live |

### Starting a job

```json
{
  "provider": "codex",
  "prompt": "Make the head turn further to the right and check it with a sweep sheet.",
  "kind": "freeform",
  "context": { "project": "avatars/miko", "file": "avatars/miko/miko.r2d.json" },
  "images": ["avatars/miko/source.png"],
  "model": "gpt-5-codex",
  "effort": "medium",
  "sandbox": "workspace-write",
  "allowImageGeneration": false
}
```

| Field | Meaning |
| --- | --- |
| `provider` | `"codex"` or `"claude"` (required) |
| `prompt` | the request in the person's words, at most 32 KiB of UTF-8; required by the `freeform` kind |
| `kind` | task template (default `freeform`; `GET /api/agent/tasks` lists them) |
| `context` | input of the task template. The server reads two entries itself: `project` (a folder of the workspace, relative to its root: the agent's working directory; default: the workspace root) and `file` (the model the request is about; default: the open model). At most 16 KiB as JSON |
| `images` | image files of the workspace to attach (paths relative to the root; at most 8; PNG, JPEG, WebP or GIF; 20 MB each) |
| `model` | model name passed to the CLI (default: the CLI's own default) |
| `effort` | `minimal`, `low`, `medium`, `high`, `xhigh` or `max` (a provider maps a level it lacks to its nearest one) |
| `sandbox` | `workspace-write` (default: the agent may change files in its working directory) or `read-only` (look and answer). There is no wider mode |
| `allowImageGeneration` | default `false`. `true` lets the agent use its **built-in** image generator (Codex has one); the preamble forbids every other image service either way |

A follow-up (`POST /api/agent/jobs/:id/message`) takes `{"prompt", "images"?, "allowImageGeneration"?}`
and keeps the provider, working directory, sandbox, model and effort of the job it continues. The job
`:id` must have ended, and must have got a provider session (`job.sessionId`).

### The job object

```json
{
  "id": "781fc2da7363",
  "provider": "codex",
  "kind": "freeform",
  "title": "Make the head turn further to the right and check it with a sweep sheet.",
  "state": "running",
  "cwd": "C:/work/avatars/miko",
  "sandbox": "workspace-write",
  "model": null,
  "effort": "medium",
  "allowImageGeneration": false,
  "images": ["C:/work/avatars/miko/source.png"],
  "sessionId": "01a10ab1-1441-7323-8408-c1b5e7199219",
  "resumeOf": null,
  "conversation": "781fc2da7363",
  "createdAt": "2026-10-05T06:12:19.308Z",
  "startedAt": "2026-10-05T06:12:19.321Z",
  "endedAt": null,
  "exitCode": null,
  "error": null,
  "finalMessage": null,
  "usage": null,
  "lastSeq": 4,
  "logFile": "C:/Users/me/.rev2d/agent-logs/20261005T061219309Z-codex-781fc2da7363.jsonl"
}
```

- `state`: `queued` (accepted, the process starts right after) → `running` → `done` (the agent
  finished its turn), `failed` (it could not start, reported an error, exited non-zero or hit a
  timeout) or `cancelled`. `error: {message, hint?}` says why a job failed or was cancelled.
- `sessionId` is the provider's session (Codex thread id, Claude session id). A follow-up job has
  `resumeOf` (the job it continues) and the same `conversation` (the id of the first job), so a UI can
  show the turns of one conversation together.
- `finalMessage` is the agent's last message, `usage` its token usage
  (`{inputTokens, cachedInputTokens, outputTokens, reasoningTokens, costUsd?}`, as the CLI reports it).
- The request text is not part of the job object: `GET /api/agent/jobs/:id` returns it as `prompt`.

### Events

Every event is `{seq, time, type, ...}`: `seq` counts from 1 inside its job, `time` is an ISO 8601
timestamp. The server keeps the newest 2000 events of a job in memory (`firstSeq` tells when older
ones were dropped); the log file has all of them.

| `type` | Fields | Meaning |
| --- | --- | --- |
| `status` | `status`, `text`, `sessionId?`, `hint?`, `code?` | progress that is not agent output: `queued`, `running`, `session` (the provider session started), `turn`, `retry`, and `stalled` (the provider has been silent for a while; the job keeps running; `hint` says what may be wrong) |
| `message` | `text`, `truncated?` | a message of the agent to the person; the last one is the final message |
| `reasoning` | `text`, `truncated?` | a reasoning summary |
| `command` | `id`, `phase`, `status`, `command`, `exitCode`, `output`, `outputTruncated` | a shell command: its command line, its exit code (`null` while it runs or when unknown) and the last 4000 characters of its output |
| `file` | `id`, `phase`, `status`, `changes: [{path, kind}]` | files the agent created (`add`), changed (`update`) or deleted (`delete`) |
| `tool` | `id`, `phase`, `status`, `tool`, `server?`, `input?`, `result?`, `error?` | any other tool call (MCP tools, web search, image generation, file reads) with short previews |
| `todo` | `id`, `items: [{text, done}]` | the agent's to-do list (the whole list every time) |
| `usage` | `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningTokens`, `costUsd?` | token usage of the turn |
| `error` | `message`, `hint?`, `code?` | a problem reported by the provider or the runner; `hint` says what to do (sign in, repair the sandbox, ...). Not every error ends the job. A problem the runner recognises has a stable `code` and is reported once per job: `codex-windows-sandbox` (see [Troubleshooting](#8-troubleshooting)) |
| `done` | `state`, `reason`, `exitCode`, `message`, `error?`, `hint?` | always the last event. `reason`: `completed`, `failed`, `cancelled`, `timeout`, `idle-timeout` or `spawn-error`; `message` is the final message or `null` |

Items (`command`, `file`, `tool`, `todo`) keep the provider's item `id`: an item is reported when it
starts (`phase: "started"`, `status: "running"`) and again when it changes or ends
(`phase: "completed"`, `status: "completed" | "failed" | "declined"`). A UI keeps one row per `id` and
replaces it. Long texts are cut (messages at 64 000 characters, reasoning at 16 000, previews at 2000).

A whole job, as the SSE stream delivers it (a real Codex run of "Reply with exactly: OK"):

```text
{"seq":1,"type":"status","status":"queued","text":"Codex CLI job queued"}
{"seq":2,"type":"status","status":"running","text":"Codex CLI started (pid 32448)"}
{"seq":3,"type":"status","status":"session","text":"Codex session 01a10ab1-...","sessionId":"01a10ab1-..."}
{"seq":4,"type":"status","status":"turn","text":"the agent is working"}
{"seq":5,"type":"message","text":"OK"}
{"seq":6,"type":"usage","inputTokens":29260,"cachedInputTokens":0,"outputTokens":5,"reasoningTokens":0}
{"seq":7,"type":"done","state":"done","reason":"completed","exitCode":0,"message":"OK"}
```

A client that (re)connects reads `GET /api/agent/jobs`, then `GET /api/agent/jobs/:id?since=<last seq it has>`
for the jobs it shows, and from then on applies the `agent-job` SSE events (ignoring a `seq` it
already has).

### Errors

Errors are JSON `{error, hint?, code?}`.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid` | a malformed request: unknown field, unknown provider / kind / effort / sandbox, bad model name, missing prompt, a path that is not an image or not a directory |
| 401 | `token-required` | the `X-Rev2D-Token` header is missing or wrong |
| 403 | | a foreign `Host` / `Origin` (the server's general guards), or a path outside the workspace root |
| 404 | `agent-disabled` | the bridge is off: the server is not bound to a loopback address |
| 404 | `unknown-job` | no such job (the server remembers the newest 20) |
| 404 | | `context.project` names a folder that does not exist |
| 409 | `busy` | another job is queued or running (`job` names it) |
| 409 | `not-resumable` | a follow-up to a job that still runs, or that never got a provider session |
| 409 | `unavailable` | the provider's CLI is not installed or does not start (`hint` says what to do) |
| 413 | `too-large` | the prompt, the context or the request body is too large |
| 409 | `settings-file` | `PUT /api/agent/settings`: the settings file is not a JSON object (it is not overwritten) or cannot be written |
| 429 | `rate-limited` | more than 10 jobs were started within a minute (`Retry-After`, `retryAfter` seconds) |

### Settings

The bridge has one setting a person can change: **`codexWindowsSandbox`**, which of Codex's two
sandbox implementations on Windows a job uses.

- `"config"` (default): whatever the person's Codex configuration says (`[windows] sandbox` in
  `~/.codex/config.toml`). The bridge leaves it alone.
- `"unelevated"`: the bridge adds `-c windows.sandbox="unelevated"` to the Codex command line, the
  implementation that needs no administrator setup. It is the fix when Codex cannot start commands
  (see [Troubleshooting](#8-troubleshooting)).

Both keep the job's `read-only` / `workspace-write` sandbox. The setting has no effect outside
Windows or for Claude Code. It is **never part of a job request** (`POST /api/agent/jobs` refuses the
field). Its sources, strongest first:

| Source | Set by |
| --- | --- |
| `option` | `startEditorServer({agent: {codexWindowsSandbox}})` |
| `flag` | `rev2d edit --agent-codex-sandbox unelevated` (the CLI passes it as that option) |
| `user` | the person's settings file `~/.rev2d/settings.json`: `{"agent": {"codexWindowsSandbox": "unelevated"}}`, written by `PUT /api/agent/settings` |
| `default` | `"config"` |

```json
{
  "settings": { "codexWindowsSandbox": "unelevated" },
  "sources": { "codexWindowsSandbox": "user" },
  "user": { "codexWindowsSandbox": "unelevated" },
  "file": "C:/Users/me/.rev2d/settings.json",
  "windows": true,
  "notes": []
}
```

`GET /api/agent/settings` returns this: `settings` is what the next job uses, `sources` where each
value comes from, `user` what the settings file holds, `file` its path (`null`: the server keeps the
user settings in memory only, as test servers do), `windows` whether the setting has any effect here,
`notes` what is worth telling the person (the file cannot be read; a saved value is overridden by a
flag). `PUT /api/agent/settings {"codexWindowsSandbox": "unelevated"}` saves the user setting and
returns the same object; it counts from the next job on, without a restart. When the editor was
started with the flag (or the option), the saved value is kept for later and `sources` still says
`flag`. The settings file is read every time, so an edit by hand counts at once; its other keys are
preserved. `GET /api/agent/providers` repeats the effective value as `windowsSandbox` of the Codex
entry on Windows.

### Model files while a job runs

The agent edits files on disk like any other program: the editor's file watcher reports the change
(SSE `model-changed`, origin `external`) and every tab reloads. Saves of the editor itself carry the
version they are based on (`PUT /api/model {doc, baseMtimeMs}`): when the agent changed the file in
between, the save is refused with **409** and nothing is overwritten; the editor reloads and the
change can be made again on top of the agent's version. A job does not lock the model: a save made
while a job runs goes through, and the agent sees the new file the next time it reads it. The preamble
tells the agent to make small validated edits and to expect the person to edit too.

## 3. Security model

The agent endpoints start programs on this machine with the person's credentials for a paid service.
The threat is a **foreign web page** (any site open in the same browser, or a host name rebound to
127.0.0.1) that makes the browser send requests to the editor server. The guards:

1. **Loopback only.** The endpoints exist only while the server is bound to a loopback address
   (`127.0.0.1`, any `127.x.x.x`, `localhost`, `::1`). With `rev2d edit --host 0.0.0.0` (or any other
   address) every `/api/agent/*` request answers 404 `agent-disabled` and `GET /api/session` returns
   `token: null`. `--allow-agent` keeps them on such a bind and prints a warning: every machine that
   can reach the port could then start agent runs with your login. Only use it on a network you trust.
2. **Host and Origin.** As for the whole API: the `Host` header must name the server (DNS-rebinding
   guard), and writes that a browser marks as cross-site or that carry a foreign `Origin` are refused.
3. **A per-server token.** Each server start creates a random token (256 bits). `GET /api/session`
   returns it, but not to requests a browser marks as coming from another site or origin; the server
   sends no CORS headers, so a foreign page could not read the answer either. Every `/api/agent/*`
   request must carry it in `X-Rev2D-Token`, a header a foreign page cannot send without a CORS
   preflight, which is refused. The token is not a cookie: nothing attaches it automatically.
4. **The working directory is never taken from the request unchecked.** It is the workspace root, or
   `context.project` resolved through the same check as every file path of the editor (inside the
   root, symbolic links and junctions followed). Images must lie inside the root too. The runner
   checks both again against real paths.
5. **No shell, ever.** The CLI is resolved to a real executable and started with an argument array;
   the prompt is written to its stdin. On Windows an npm `.cmd` shim is read and resolved to the
   `node <script>` it wraps; a batch file that is not such a shim is refused. Model names and session
   ids are validated before they become arguments.
6. **Two sandboxes, nothing wider.** `read-only` and `workspace-write` are the only modes. The command
   line never contains `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`,
   `--dangerously-skip-permissions` or `bypassPermissions`; a last check (`assertSafeArgs`) refuses to
   start a process whose arguments contain one, whatever a provider builds. The same check allows
   exactly two config overrides on a Codex command line: the reasoning effort, and
   `windows.sandbox="unelevated"` (the [setting](#settings) that swaps one Windows sandbox
   implementation for the other; `-s` still names one of the two modes). That setting comes from the
   server's options, a `rev2d edit` flag or the person's settings file, never from a job request.
7. **Limits.** The prompt is capped (32 KiB), one job runs at a time, starts are rate-limited (10 per
   minute), a job ends after 45 minutes or 15 silent minutes, and cancelling kills the whole process
   tree (`taskkill /T /F` on Windows, the process group elsewhere). Closing the editor server cancels
   the running job.

The numbers are defaults of the server (`startEditorServer({agent: {...}})`, `AgentBridgeOptions`):
`timeoutMs`, `idleTimeoutMs`, `stallMs`, `maxPromptBytes`, `maxStartsPerMinute`, `maxEvents`,
`maxJobs`, `maxLogFiles`, `logDir`; the same object takes `codexWindowsSandbox` and `settingsFile`.

What the sandboxes mean per provider:

| | `read-only` | `workspace-write` |
| --- | --- | --- |
| **Codex** | the CLI's OS sandbox: commands run, nothing can be written, no network | commands may write inside the working directory (and temp), no network |
| **Claude Code** | only the Read / Glob / Grep tools exist | file edits inside the working directory are accepted; the only command the agent may run is the Rev2D CLI (`node <bin/rev2d.js> ...`); everything else would need a permission prompt, which print mode denies |

Claude Code has no OS sandbox on every platform, so its two modes are built from its permission
system; with a version whose `--help` lists `--restricted`, `--strict-mcp-config` and
`--permission-prompts` (2.1.289 does) the person's own settings files, hooks and MCP servers are left
out of the run as well.

What the guards do **not** cover: another program of the same user on this machine can read the
token (`GET /api/session`) and start jobs, as it could start the CLIs itself. Both sandboxes let the
agent *read* files outside the workspace (Codex's sandbox restricts writing, not reading); the
preamble forbids it, and the person's images are never passed anywhere but to the provider the person
chose. The prompt and the agent's output are stored in the job log on this machine (see
[Logs](#7-logs)).

## 4. Providers

### Codex CLI (`codex`)

```text
codex exec [-i <image>]... --json --color never -s <sandbox> --skip-git-repo-check -C <cwd>
           [-m <model>] [-c model_reasoning_effort="<effort>"] [-c windows.sandbox="unelevated"]
           --enable|--disable image_generation -
codex exec <the same options> resume [-i <image>]... --json <thread id> -
```

The prompt argument is `-`: the prompt is read from stdin. `-s` and `-C` are options of `codex exec`,
not of `resume`, so they come before it. The explicit `-s` overrides the sandbox mode of
`~/.codex/config.toml`; exec mode never asks for approval, so whatever the sandbox forbids fails.
Codex's image generator is switched on only for jobs with `allowImageGeneration`.
`-c windows.sandbox="unelevated"` is added on Windows only, and only when the
[`codexWindowsSandbox` setting](#settings) is `"unelevated"`.

On Windows a running Codex job is watched for silence: when Codex reports no event for 90 seconds
(`stallMs`), the job gets one `status` event `stalled` with the hint of the sandbox problem below. The
job is not stopped (a long command or image generation can be silent that long); the watchdog starts
again with Codex's next event, and the idle timeout is what ends a job that never comes back.

### Claude Code (`claude`)

```text
claude -p --allowedTools <rules>... [--tools <list>] --permission-mode <mode> [--restricted]
       [--strict-mcp-config] [--permission-prompts none] [--model <m>] [--effort <e>]
       [--resume <session id>] --output-format stream-json --verbose
```

The prompt is read from stdin. `<mode>` is `acceptEdits` (workspace-write) or `dontAsk` (read-only;
`plan` on versions without it). The newer flags are used when `claude --help` lists them. Claude Code
has no flag for image attachments: the preamble lists the image paths and the agent opens them with
its Read tool. It has no image generator.

### Finding the CLI

The program is looked up on `PATH` (absolute entries only: the current directory, which is the
workspace an agent writes to, can never provide it). `REV2D_AGENT_CODEX` / `REV2D_AGENT_CLAUDE` name
an executable (or the CLI's `.js` entry script) instead. `GET /api/agent/providers` runs
`<cli> --version` and reports `available`, `version` and, when something is wrong, a `hint`; the
answer is reused for 30 seconds (3 seconds while the CLI is missing).

## 5. The preamble and task templates

Every prompt starts with a preamble built by `buildPreamble` (`src/node/agent/prompt.ts`): where the
agent is (workspace root, project folder, the open model, the attached images), how to call Rev2D
(`node <absolute path>/bin/rev2d.js <command>`, and that `docs <topic>` prints the guides), and the
rules: stay inside the workspace; never upload the person's images or copy them elsewhere; image
generation only when the job allows it, and then only with the agent's built-in generator; look at
the images you produce; validate after every edit; report what is uncertain. A follow-up message gets
a short form of the same rules. The request follows under `Request`.

The task part comes from a **template**: `kind` → a function that builds the task text from the
request and a context object. The editor server registers these:

| `kind` | `context` | The task |
| --- | --- | --- |
| `freeform` | | the person's own words (`prompt`, required) |
| `avatar-create` | `{project}` | an avatar from the illustration of the avatar project `project` (its folder relative to the workspace root): the vision check, then reading coordinates off grids, placing the landmarks in `avatar.json`, validating, checking them on overlays, building, reviewing the pose sheets and fixing what is off, all inside the project folder; it ends with a hand-over note naming the parts the agent is least sure about. Attach the illustration (`images`); `prompt` is optional (added as the person's wishes) |
| `avatar-variants` | `{project, variants?}` | drawn eye / mouth variants (`eyes_closed`, `mouth_a`, ...; default: the recommended ones) for a built avatar: request the masks and prompts, draw each one with the agent's **built-in** image generator, save it as `variants/<id>.png`, import, rebuild and review. Refused (400 `invalid`) unless the job has `allowImageGeneration: true`, a provider with an image generator, `workspace-write` and a built avatar |

The avatar flow in the editor: `POST /api/avatar/new` (one picture becomes a project, see
[CLI.md](CLI.md#editor-protocol-types)) answers with `projectPath` and `image.path`, which the job
takes as they are: `POST /api/agent/jobs {"provider", "kind": "avatar-create", "context": {"project":
projectPath}, "images": [image.path]}`. The avatar templates live in `src/server/avatar-agent-tasks.ts`.

To add a template, register it where the server loads it (for example next to the feature it belongs to):

```ts
import { AgentError, registerTaskTemplate } from '../node/agent/index.js';

registerTaskTemplate({
  kind: 'model-rename',                        // lower-case letters, digits, dashes
  title: 'Rename the model',
  description: 'Sets meta.name of the open model.',
  needsPrompt: false,                          // true: POST /api/agent/jobs must carry "prompt"
  build({ prompt, context, env }) {
    // context: the request's "context" object; env: {root, cwd, images, sandbox, allowImageGeneration, file, ...}
    if (typeof context.name !== 'string') throw new AgentError('invalid', 'the "model-rename" task needs context.name', 'send "context": {"name": "<new name>"}');
    return [`Set meta.name of ${env.file ?? 'the open model'} to ${JSON.stringify(context.name)}.`, prompt].filter(Boolean).join('\n\n');
  },
});
```

`GET /api/agent/tasks` then lists it, and `POST /api/agent/jobs {"provider", "kind": "model-rename", "context": {"name": "Miko"}}`
uses it. A template never sees or changes the preamble, so the rules hold for every kind. Test it
with `buildAgentPrompt({kind, prompt, context, env})`.

## 6. Adding a provider

A provider is one object implementing `AgentProvider` (`src/node/agent/provider.ts`); `codex.ts` and
`claude.ts` are the examples.

1. **Describe the CLI**: `id`, `name`, `bin` (the program on PATH), `envOverride`, `features`,
   `efforts`, `installHint`, `loginHint`, `parseVersion`, `isAuthError` (which error texts mean "not
   signed in").
2. **Build the command line** in `buildArgs(run)`: non-interactive mode, JSON-lines output, the
   working directory, the sandbox mapped to the CLI's strictest matching mode, the model, the session
   to resume. The prompt is not an argument: the manager writes it to stdin (use `promptSuffix` when
   something has to be appended, as Claude's image list). Never add a flag that widens the sandbox;
   `assertSafeArgs` is the net, not the plan.
3. **Parse the stream** in `createParser()`: `line(text)` turns one stdout line into
   `{events, sessionId?, failure?, finalMessage?, usage?}`. Never throw; return `{events: [], unknown: true}`
   for a line you do not know (it stays in the raw log). Map tool calls to `command`, `file`, `todo`
   or `tool` events and keep the provider's item ids.
   Optional: `diagnose` turns a known failure text (in an event or a stderr line) into an `error`
   event with a stable code and a hint, reported once per job; `stallNotice` supplies the `stalled`
   status for a provider that can hang silently (Codex on Windows has both).
4. **Register it**: add the id to `AgentProviderId` (`types.ts`), the object to `PROVIDERS`
   (`manager.ts`) and the id to the `provider` enum of `parseAgentStartRequest`
   (`src/server/protocol.ts`).
5. **Test it without the real CLI**: a fake executable in `test/fixtures/fake-agents/` that reads
   stdin and prints recorded lines, a parser test over a recorded session, and the command lines in
   `test/agent-bridge.test.ts`. Then one real, tiny run by hand ("Reply with exactly: OK", read-only)
   and a follow-up through the resume path.

## 7. Logs

Every job writes `~/.rev2d/agent-logs/<start time>-<provider>-<job id>.jsonl`; the newest 50 files
are kept. Lines are JSON objects:

```text
{"kind":"job","job":{...},"command":["node",".../codex.js","exec",...],"prompt":"<the whole text sent>"}
{"kind":"stdout","time":"...","line":"<a raw line of the CLI>"}
{"kind":"stderr","time":"...","line":"..."}
{"kind":"event","seq":1,"time":"...","type":"status",...}
```

The log holds the prompt and everything the agent printed. It stays on this machine. `job.logFile`
names it.

## 8. Troubleshooting

**"… is not available" (409 `unavailable`) / the provider shows `available: false`.** The CLI was not
found on `PATH`, or `<cli> --version` failed; the `hint` says which. Install it
(`npm install -g @openai/codex`; Claude Code from its installer), open a new terminal so `PATH` is
current, and restart `rev2d edit` from it. When the CLI is installed somewhere `PATH` does not reach,
set `REV2D_AGENT_CODEX` or `REV2D_AGENT_CLAUDE` to the executable (or to the CLI's `.js` entry script).
On Windows a CLI that is only a hand-written `.cmd` or `.ps1` wrapper is refused on purpose: point the
variable at the real program.

**The job fails with a hint to sign in.** The CLI is not logged in, or its token expired. Codex: run
`codex login` in a terminal (`codex login status` shows the state). Claude Code: run `claude` and use
`/login`. Then start the job again; no editor restart is needed.

**Windows: Codex cannot run commands, or a Codex job goes silent (`codex-windows-sandbox`).**

*Symptoms.* The agent answers, but every command it tries fails or never finishes, so it cannot call
the Rev2D CLI. In the job this shows as one of:

- an `error` event with the code `codex-windows-sandbox` ("Codex cannot start commands in its Windows
  sandbox, so it cannot run the Rev2D CLI");
- a `command` that ends with exit code -1 and the output "Failed to create unified exec process:
  orchestrator_helper_exit_nonzero: setup helper exited with status Some(143)", often after messages
  like "the command is still pending";
- no event at all for minutes: a `status` event `stalled` after 90 seconds, and in the job log the
  stderr line "error=code-mode host closed its stdout";
- "windows sandbox failed: CreateProcessWithLogonW failed: 1326" in a command's output.

*Cause.* On Windows, Codex starts every command through one of two sandbox implementations
(`[windows] sandbox` in `~/.codex/config.toml`). The "elevated" one needs a one-time administrator
setup; when that setup is missing, broken or out of date, no command can start. `codex doctor` is not
a reliable signal for it (it can report the sandbox as complete while commands still fail).

*Two fixes.* Either one is enough:

1. **Repair the elevated sandbox**: run `codex` once in an administrator terminal and accept its
   sandbox setup. Nothing changes in Rev2D.
2. **Let the bridge use the unelevated sandbox**, which needs no setup: set
   [`codexWindowsSandbox`](#settings) to `"unelevated"`, either saved for every editor
   (`PUT /api/agent/settings {"codexWindowsSandbox": "unelevated"}`, i.e.
   `{"agent": {"codexWindowsSandbox": "unelevated"}}` in `~/.rev2d/settings.json`) or for one editor
   with `rev2d edit --agent-codex-sandbox unelevated`. It counts from the next job on. Codex jobs then
   run with `-c windows.sandbox="unelevated"`; your Codex configuration file is not touched, and the
   job keeps its `read-only` / `workspace-write` sandbox.

The hint of the `error` and `stalled` events names both. When the setting is already `"unelevated"`
and commands still do not start, the hint says so instead of offering it again: update Codex
(`codex update`), or repair the elevated sandbox and set the setting back to `"config"`. Rev2D never
works around the problem by lifting the sandbox.

**PUT /api/agent/settings answers 409 `settings-file`.** `~/.rev2d/settings.json` exists but is not a
JSON object, so it was not overwritten. Fix it by hand or delete it, then save again.

**Claude Code says a command was denied.** In `workspace-write` jobs the only command it may run is
`node <bin/rev2d.js> ...` (through its Bash tool, on Windows also PowerShell); in `read-only` jobs it
has no command tool at all. A denied command was something else (a pipe into another program, `cd`
first, another interpreter): ask it to call the Rev2D CLI directly, one command at a time, exactly as
the preamble spells it.

**The job ends with "produced no output for 15 min" or "ran longer than 45 min".** The first means
the CLI hung (waiting for a network answer or for input it never gets); the second that the task is
too large for one job. The provider session survives: send a follow-up message to continue, or split
the task.

**401 `token-required` after a restart.** The token changes with every server start. Read it again
from `GET /api/session` (the editor UI does this when it loads: reload the page).

**404 `agent-disabled`.** The editor was started with a `--host` that is not a loopback address.
Start it without `--host`, or, on a network you trust, add `--allow-agent`.

**409 `busy`.** One job runs at a time. Wait for it, or cancel it
(`POST /api/agent/jobs/<id>/cancel`; `GET /api/agent/jobs` names the active one).

**The agent changed the model while I was editing.** The editor refuses to save over the agent's
version (409) and reloads; make your change again on top of it. Nothing on disk is overwritten.

**Where is the full output?** In the job's log file (`job.logFile`): raw lines of the CLI, stderr
included.
