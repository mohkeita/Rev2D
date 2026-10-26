# Episodes: narration to a finished timeline

A version 1 `storyboard.json` describes shots; the episode adapter builds explicit scenes,
checks their assets, renders isolated shot MP4s, then assembles one continuous narration track.
It performs no image generation, downloads or network calls. Original illustrations and authored
scenes remain reusable sources. Use [libraries](LIBRARY.md), [scenes](SCENE.md) and
[acting](GESTURES.md) to prepare them first.

## 1. Runnable original example

From a checkout with Node 22+, installed dependencies, and optional local ffmpeg **and ffprobe**:

```sh
node bin/rev2d.js episode validate examples/episodes/demo/storyboard.json --json
node bin/rev2d.js episode plan examples/episodes/demo/storyboard.json --json
node bin/rev2d.js episode build examples/episodes/demo/storyboard.json -o out/episode-demo --json
node bin/rev2d.js episode thumbnails out/episode-demo -o out/episode-thumbs --at middle --json
node bin/rev2d.js episode render out/episode-demo --jobs 2 --json
node bin/rev2d.js episode report out/episode-demo -o out/episode-report --json
node bin/rev2d.js episode assemble out/episode-demo -o out/episode-demo.mp4 --json
node bin/rev2d.js episode assemble out/episode-demo -o out/episode-portrait.mp4 --size 1080x1920 --json
```

Choose new output paths when repeating exports or reports. A second `episode render` reuses
all six cached shots. The example lasts 12 seconds at 24fps (288 frames) and includes two
characters, native phone controls, a generated gesture, a thought bubble and an **explicit**
external procedural clip. Voice/music are original timing tones, not synthesized speech.
`node --import tsx scripts/build-episode-example.ts <new-directory>` regenerates its source pack;
it reuses original shared scene artwork from the checkout.

## 2. Prepare narration and assets

1. Keep the final narration in PCM WAV. Convert another format with
   `ffmpeg -i voice.mp3 -c:a pcm_s16le voice.wav`. Retain the original.
2. Supply an optional alignment JSON: ordered `{word,start,end}` entries in seconds, or ElevenLabs
   `alignment` / `normalized_alignment` character arrays. Timings must belong to this exact WAV.
   Without alignment, numeric shot times work; symbolic word/text cues require alignment.
3. Select backgrounds, character poses, props, bubbles and native UI from `library.json`.
   Rig and review missing poses before building. A request is a prompt/references package, not an
   image, a rig or artistic approval. Character identity requires canonical reference artwork.
4. Author difficult interactions as separate scenes. Separate foreground furniture from a flattened
   room image and explicitly order the layers. Review hand contact, expressions and occlusion in
   the pictures. Episode assembly cannot infer these from a still illustration.

## 3. Storyboard contract

```json
{
  "version": 1,
  "id": "my_episode",
  "library": "library",
  "size": [1920, 1080],
  "fps": 24,
  "narration": {"audio": "voice.wav", "alignment": "voice.alignment.json"},
  "music": {"src": "music.wav", "gain": 0.25, "duck": {"under": "narration", "amount": 0.5}},
  "defaults": {"camera": "static", "transition": "cut", "look": null},
  "shots": [
    {
      "id": "P001", "start": 0, "end": "@text:Next sentence",
      "background": "room",
      "characters": [{"id": "hero", "character": "figure", "at": "sofa_left", "pose": "sitting_phone",
        "expressions": [{"t": 0, "name": "neutral"}], "gestures": []}],
      "focus": "hero", "note": "The opening sentence."
    },
    {"id": "P002", "start": "@text:Next sentence", "end": "@end",
      "scene": "authored/P002.json", "transition": {"type": "dissolve", "duration": 0.35}}
  ]
}
```

Paths are relative local forward-slash paths, including `../` when needed. Shot ids use model-id
syntax. `size` defaults to 1920×1080 and `fps` to 24; MP4 dimensions must be even, at most 3840
on either axis and within 3840×2160 area. All times are seconds.

- `start`/`end`: numeric seconds or scene cues (`@text:phrase`, `@text:phrase@end`, `@word:N`,
  optional `+seconds` / `-seconds`). Repeated text searches advance in shot order. Episode `@end`
  means **WAV duration**, including final silence. Inside scene animations, `@end` retains the
  scene cue semantics (last aligned word), so prefer explicit local seconds for the final hold.
- Shots must be contiguous from zero. Gaps/overlaps return `episode-gap` / `episode-overlap`.
  Shared cut frames are `round(time * fps)`; their differences determine shot frame counts.
  The total must match narration within one frame. This prevents cumulative rounding drift.
- `background`, `characters`, `props`, `bubbles`, `ui`, `layers`: optional scene content. A character
  `id` is also its default library character id; `character` overrides the asset id for two instances
  of one asset. `layer` optionally overrides the instance id. `pose` defaults to `standing`.
  Characters receive `idle_alive`; explicit gestures/expressions use their names and timing fields.
  Raw `layers` support all scene-layer fields. Native UI uses `{ref,tracks:[{param,keys}]}`.
  Assets support normal scene placement/appearance fields. `sofa_left` expands to
  `room.sofa_left`; explicit `layer.anchor` references remain unchanged.
- Scene animation times are local seconds; symbolic cues resolve against global narration with
  the shot's original unquantized start as offset. A cue outside the shot is an error.
- `scene`: import an authored scene instead of compiling shorthand content. Its original geometry,
  tracks, z order, rig references and camera are retained. The build rebases paths and sets id,
  duration, fps and narration offset. Shorthand content/camera fields do not override an imported
  scene. A different native size is letterboxed into episode size by the worker. No source rewrite.
- `external`: `{video,fit:"cover"|"contain",from:0}` instead of a native scene. It must be explicitly
  declared; the adapter never discovers or substitutes old video clips. External audio is discarded;
  global narration/music are used. It must cover the shot duration (one-frame tolerance). Its built
  `external.json` is the complete source descriptor; `scene.json` is an empty timeline placeholder,
  not a renderer for embedded video. `scene` and `external` are mutually exclusive.
- `focus`: a visible layer id (first character/model by default), or normalized `[x,y]`. The portrait
  crop centers it where possible. It is static per shot; it does not track a moving hand.
- `transition`: `cut` (default), `dissolve`, `whip-left`, `whip-right`, `dip-to-black`; either a string
  (default 0.35s) or `{type,duration}`. Durations quantize to frames and must be shorter than the
  incoming shot. The first shot always starts with a cut.
- `note`: informational narration/action text, visible in the report. `look` only accepts null;
  finishing effects belong to the next phase.

## 4. Agent work loop and output ownership

Validate timing first, then run `episode plan --out <new-request-directory>`. It deduplicates missing
assets by kind/id/pose and lists every affected shot. Existing characters use `library request`
with their canonical references. Unknown characters receive an explicit request for identity inputs;
UI requests ask for a native Rev2D model exposing the requested parameters. Import generated art,
rig it, review sheets/analysis and validate again. Validation also loads authored scene resources
without writing scratch files beside the source.

`episode build` writes `episode.json`, `shots/<id>/scene.json` and an explicit descriptor for each
external shot. `--only P001,P060` supports staged builds; unbuilt shots cannot be rendered or
assembled. Managed scenes can be regenerated, but local edits require `build --force`. Prefer
moving a polished scene to an authored source and referencing it through `scene`. A changed
storyboard, narration audio or alignment requires a rebuild; a partial rebuild then invalidates
other built ids until they are rebuilt. Rebuild before relocating the project.

Render a few shots first using `--only`. Each worker is a separate Node process, streams frames
to ffmpeg, discards local scene audio and normalizes the result to episode dimensions. `--jobs`
is an integer 1–16, default 2; choose it to fit RAM. Progress goes to stderr; `--json` stdout remains
machine-readable. SIGINT/SIGTERM cancels workers and their encoder and removes owned temporary
files. `REV2D_FFMPEG` and `REV2D_FFPROBE` can name local executables.

Cache records include scene bytes, library manifest, selected referenced images/rigs/textures,
avatar specs/source metadata, narration inputs, render engine sources, encoder version, fps,
size and frame count. Output bytes are also checked. Changed assets or corrupted videos invalidate
only affected entries (a library-manifest change can affect multiple shots). `render --force`
bypasses cache. An unknown existing `shot.mp4` requires explicit `--force` before replacement.
Assembly refuses stale input/output hashes. Original files and unknown output directories are
never overwritten. Exported final MP4s, reports and thumbnail directories always use new paths.

## 5. Assembly, music and vertical review

Transitions **start at the incoming cut**. During the transition the outgoing last frame is held,
while the incoming scene advances. This preserves every cut frame and total narration duration;
there is no transition overlap that progressively shortens an episode. Dissolve uses ffmpeg fade,
dip uses fadeblack; whip uses directional slide plus a three-frame weighted motion blur during
that transition. Hard-cut-only episodes use concatenation without intermediate re-encoding.

Narration is mixed once over the final timeline. `music.gain` is linear amplitude. With word
alignment, `duck.amount` attenuates the bed by that fraction during speech windows (50ms before,
120ms after, gaps ≤200ms merged); it returns to normal in gaps. Without alignment, ffmpeg
sidechain compression follows the actual narration; `amount` controls wet mix, so attenuation
then depends on signal level. The bed loops if short. A limiter protects a mixed bed/voice output;
AAC output duration is verified within one frame, including encoder padding.

`assemble --size 1080x1920` crops each cached clip around its focus and scales to portrait.
Review `episode-vertical-crop` warnings for important layers outside that crop. Geometry is sampled
at start/middle/end; transparent bitmap margins are excluded, while rig bounds are conservative.
A warning is a review aid, not proof of continuous visibility or automatic recomposition. For
precise results, author portrait geometry in a separate storyboard.

Run `episode report` for six-frame sheets, per-shot scene/model analysis and linked HTML/Markdown/
JSON indexes. Native thumbnails render at `--at middle|start|end`; explicit external shots use their
video images. Inspect gestures, hands, furniture overlap, typography and every cut in motion before
calling the episode artistically finished. A structurally valid build can still contain a still
illustration with camera motion; that does not establish character animation fidelity.

## 6. Automation and diagnostics

CLI commands and matching `rev2d_episode_*` MCP tools call the same Node adapters. Offline help is
`rev2d docs episode` / `rev2d_docs {"topic":"episode"}`. Machine results contain `ok`, output paths,
shot ids, frame counts and diagnostics. Error codes use `episode-*`, with a JSON pointer and a
repair hint; referenced scene/rig failures retain their diagnostic codes. CLI exit codes are 0
success, 1 failed validation/operation, 2 invalid command usage. No shell is used to launch media
processes. Browser-safe schema/timing/compilation live in `src/episode`; file/process code lives in
`src/node/episode*.ts`.
