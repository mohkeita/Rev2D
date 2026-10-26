# Layered scenes and video

A version 1 `scene.json` places reusable assets in a world, evaluates their models on a shared
clock, moves a camera, resolves narration cues and streams the result to MP4, GIF or PNG frames.
It does not generate images or call a network service. A scene is separate from the model v1
format: the existing rig, bindings and physics remain ordinary Rev2D models.

## Quickstart

The checked-in example contains original synthetic artwork, two built avatar poses, a room,
a box, a thought bubble and a parameterized phone. Its WAV is a quiet timing reference tone,
not spoken narration. Replace it with your PCM WAV and word/character alignment for production.

```sh
rev2d scene validate examples/scenes/room-demo/scene.json --json
rev2d scene info examples/scenes/room-demo/scene.json --json
rev2d scene sheet examples/scenes/room-demo/scene.json -o out/scene-sheet.png --scale 0.25
rev2d scene frame examples/scenes/room-demo/scene.json -o out/scene-frame.png --time 3.5 --overlay camera,bounds,safe,anchors
rev2d scene analyze examples/scenes/room-demo/scene.json --json
rev2d scene render examples/scenes/room-demo/scene.json -o out/scene.mp4
rev2d scene render examples/scenes/room-demo/portrait.json -o out/portrait.mp4
rev2d scene render examples/scenes/room-demo/scene.json -o out/scene-frames --format png
rev2d scene render examples/scenes/room-demo/scene.json -o out/scene.gif --scale 0.25
```

Every output path must be new. In a checkout, regenerate all synthetic inputs into a new directory:
`node --import tsx scripts/build-scenes.ts out/new-scene-example`.

## Document and layers

```json
{
  "version": 1,
  "library": "../library",
  "width": 1920, "height": 1080, "fps": 24, "duration": 6,
  "background": "#000000",
  "layers": [
    { "id": "room", "type": "background", "ref": "living_room", "scale": 2 },
    { "id": "hero", "type": "character", "character": "malik", "at": "room.sofa_left",
      "poses": [{ "t": 0, "pose": "sitting_phone" }, { "t": 2.5, "pose": "standing" }],
      "animations": ["idle", "blink"] },
    { "id": "box", "type": "prop", "ref": "box", "at": [1200, 950],
      "enter": { "t": 3, "type": "pop", "duration": 0.35, "overshoot": 0.15 } }
  ],
  "camera": "slow-push"
}
```

`background`, `character`, `prop`, `bubble` and `ui` resolve library ids. `image` loads `src` as
PNG, `model` loads `src` as a Rev2D model, and `color` draws a rectangle using `color`.
These last three need no library. Paths are relative to the scene file, including `library` and
narration files; library-internal paths retain the library's confinement and symlink checks.

World coordinates are pixels, +x right and +y down, with clockwise degrees. A layer has `x`, `y`,
`scale`, `width`, `height`, `rotation`, `opacity`, `flip`, `offset: [x,y]`, `depth` and optional `z`.
Without `z`, array order is the draw order. Scaling is around the layer's anchor; `flip` mirrors
horizontally. `anchor` accepts a fraction pair such as `[0.5,1]`, or `center`, `top-left`,
`top-center`, `bottom-left`, `bottom-center`, `bottom-right`, `feet` or `seat`.

Bitmap defaults: backgrounds/images/colors use top-left, props bottom-center, bubbles their
library tail. Models/UI use center. Characters use the pose's source-pixel anchor from the library;
`feet` is measured from opaque source bounds, while `seat` is a fallback at 68% of image height.
For production use a measured source-pixel pair for seated poses. Character height normalizes the
source's opaque height before layer and background-anchor scales are applied.

`at: [x,y]` adds a world position. `at: "room.sofa_left"` transforms the background's named anchor
through its placement and applies both the anchor's depth scale and background scale. Rect anchors
use their center. `x/y` add offsets; scene tracks targeting `x/y` replace the resulting world coordinate.

`attach: "hero.head"` follows the authored avatar head through `rig.mapPoint` and then through the
parent layer's transform. `attach: "hero.point:180,110"` follows a source-space point. Add `offset`
in world pixels to place a bubble beside the head. Circular placement references are rejected.

## Poses, tracks and appearances

Character `poses` are strictly increasing `{t,pose,transition?}` entries. The first pose holds before
its first key. The default transition is `cut`: the new pose is selected exactly at `t`.
`transition: {type:"dissolve",duration:0.3}` crossfades from the preceding pose beginning at the key.
Every pose uses the scene clock, including while hidden; sequential rendering keeps a separate
`rig.player()` per layer and pose, so switching does not restart physics or animated parameters.

`animations` accepts the existing strings (`"idle"`, `"nod@0.8,add"`, `"blink,once,start=2"`) or
objects `{id,start,time,once,hold,mode,weight}`. Scene objects additionally accept cues in `start`.
Core restrictions on one-shot looping animations still apply. `params` are explicit model parameters;
`tracks: [{param:"Progress",keys:[{t:0,v:0},{t:3,v:1}]}]` animate those overrides on the scene clock.

Global scene `tracks` target `layer:<id>.x`, `.y`, `.scale`, `.rotation`, or `.opacity`. Number keys
use `{t,v,ease?}`. Easing belongs to the segment **from** a key to the next key. All core easings,
cubic-bezier arrays and `smooth` (the core Catmull-Rom tangent implementation) are supported.

Any layer can have `enter` and `exit`, with `{t,type,duration,overshoot,ease}`. Supported effects:
`pop`, `fade`, `slide-left`, `slide-right`, `slide-up`, `slide-down`, `wipe`, `draw-on`.
Entry starts at `t`; before it the layer is invisible. Exit starts at `t` and finishes at
`t+duration`. Pop overshoots scale 1 and settles exactly; fade is monotone with the default ease.
Slides travel 160 world pixels. Wipe reveals horizontally; draw-on is a progressive vertical
geometry reveal, not automatic pen-path tracing. Existing model masks remain effective.

A bubble may contain `{type:"image",src:"coin.png"}`. Its content is fitted inside the library's
`content_rect`, and is transformed and revealed with the bubble.

## Narration cues

```json
{ "narration": { "audio": "voice.wav", "alignment": "voice.alignment.json", "offset": 41.2 } }
```

Audio is optional PCM WAV decoded for validation. Alignment accepts an array of `{word,start,end}`
entries in seconds, or ElevenLabs `alignment` / `normalized_alignment` with `characters`,
`character_start_times_seconds` and `character_end_times_seconds`. Normalized alignment takes
precedence. Whitespace separates words and punctuation is ignored for matching.

Every time field (`t`, animation `start`, shake `start/end`) accepts seconds or a cue:

- `@word:14`: the **one-based** fourteenth aligned word beginning within the scene's narration slice.
- `@text:se lève`: the first accent/case-insensitive phrase after the preceding key in that list.
  Each ordered list has its own cursor; unrelated layers do not consume each other's words.
- `@word:14@end`, `@text:se lève@end`: end of the word/phrase.
- `@end`: end of the last aligned word, relative to narration offset.
- Optional signed suffix: `@text:se lève+0.2` or `@word:14@end-0.1`.

`offset` selects the absolute episode-audio position corresponding to scene time zero. Cues and
audio trims both subtract/use that same offset. `scene info` lists every resolved cue with its
JSON pointer and resulting scene time. Missing cues fail validation with nearby words in the hint.

## Camera

`camera` accepts a preset string or `{keys,preset?,shake,follow}`. Keys have
`{t,x,y,zoom,rotation,ease}`; omitted positions use the screen center. Presets: `static`,
`slow-push` (1 → 1.06), `slow-pull`, `pan-left/right` (10% of width), `focus:<layer>` (fit at t=0),
and `punch-in@<seconds>` or `punch-in@@text:<phrase>` (fast zoom to 1.2).

For screen center C, camera center cam and layer depth d:

```text
zoom_d = 1 + (zoom - 1) * d
cam_d = C + (cam - C) * d
screen = C + R(-rotation * d) * (world - cam_d) * zoom_d
```

Depth 0 stays fixed to the screen, 1 follows the full camera, 0.5 moves halfway. Use a matching
depth for an attached bubble and its character if their screen alignment must remain exact.

`shake: [{start,end,amplitude,frequency,seed}]` uses deterministic smooth value noise under a
sine-squared envelope, with zero displacement and velocity at each boundary. `follow` is null or
`{layer,frequency:2,offset:[0,0]}`: a critically damped spring follows the layer center on an absolute
60 Hz grid and adds its displacement to the camera keys. Random-access and sequential sampling
agree. No wall-clock state or unseeded randomness enters scene evaluation.

## Validation and analysis

`scene validate` returns `{ok,diagnostics}` and exit 1 on errors. Codes include `scene-schema-*`,
`scene-fps-range`, `scene-size-range`, `scene-file-missing`, `scene-library-ref`, `scene-duplicate-id`,
`scene-unknown-layer`, `scene-unknown-anchor`, `scene-attachment-cycle`, `scene-unknown-pose`,
`scene-model-invalid` / `scene-model-invalid-*`, `scene-unknown-animation`, `scene-unknown-param`,
`scene-track-target`, `scene-cue-not-found`, `scene-alignment-format` and `scene-audio-format`.
Each diagnostic carries a JSON pointer and a repair hint.

`scene analyze` samples at scene fps. Warnings include `scene-camera-reveal` (intervals and maximum
pixel overflow), `scene-camera-fast`, `scene-layer-offscreen`, `scene-bubble-offscreen` and
`scene-overlap` (>30% of the smaller character's source rectangle). Bounds are conservative image
rectangles, so intentional overlaps need visual review. Model animation analysis is returned under
`models` using the existing analyzer. Analysis does not render pixels or change models.

## Export, memory and integration

MP4/GIF require external ffmpeg, discovered on PATH or via `REV2D_FFMPEG`; it is launched without a
shell. Missing ffmpeg yields `scene-ffmpeg-missing` and an installation hint. PNG export never needs
the binary. MP4 uses H.264, `yuv420p`, `veryfast`, CRF 18 and `+faststart`; narration is AAC. Missing
audio at the tail is padded with silence to the encoded video duration. `--no-audio` mutes it.

`--from` / `--to` choose a scene-relative half-open render window. Frames sample `from+n/fps`;
count is `ceil((to-from)*fps)` and encoded duration is count/fps. Both render size axes are rounded
after `--scale`; MP4 needs even dimensions. Maximum dimension is 3840, maximum area 3840×2160,
including portrait 1080×1920. Supported fps is >0 through 120.

Rendering awaits the encoder's write callback before generating the next RGBA frame. No frame array
is retained. A raster workspace reuses the framebuffer and immutable source-texture conversions.
Browser callers can also pass a `RasterWorkspace` in frame options. Its texture caching is opt-in;
call `resetTextures()` after editing source pixels when enabled. Progress (frame/count, percent, fps,
ETA) goes to CLI stderr; JSON stays on stdout.
Publication is atomic and never replaces an existing file. Cancellation removes incomplete outputs.
PNG sequence output has `frame-000000.png` and a version 1 `manifest.json` describing fps, dimensions,
window and narration reference. GIF is streamed with a fixed RGB8 palette, so it has fewer colors.

MCP: `rev2d_scene_validate`, `rev2d_scene_frame`, `rev2d_scene_sheet`, `rev2d_scene_analyze`,
`rev2d_scene_render`. Frame and sheet return PNGs inline. Node entry points are in `src/node/scene.ts`
and `src/node/video.ts`; browser clients import `src/scene/index.ts`. See [LIBRARY.md](LIBRARY.md)
for asset preparation and [AVATAR.md](AVATAR.md) for landmark/build/review work.


## Acting on characters

Layers may use `"idle_alive"` and `{gesture:"voila",t:"@text:voilà",intensity:0.8}` or
`{expression:"surprised",t:2.5,hold:1.2}` alongside existing animation references. These are JSON
objects with quoted keys in scene files. Generation happens after narration cue resolution, on
cloned models in memory; source model files are unchanged. Set an optional scene `id` for stable
character-plus-shot idle seeding. See [GESTURES.md](GESTURES.md#seeded-idle-and-scenes).
