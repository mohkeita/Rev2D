# Reusable asset libraries

A library is a local directory with `library.json` and reusable artwork: empty backgrounds,
character poses, props, bubbles and parameterized UI models. Importing artwork is not rigging it.
Every character pose is an avatar project, with its own measured landmarks and built model.

## Workflow

```sh
rev2d library init out/my-library --name my-channel --json
rev2d library import pose.png --into out/my-library --kind character --character hero --pose standing --tags standing,neutral --json
rev2d library search out/my-library --tags standing --character hero --json
rev2d library request out/my-library --kind character --character hero --pose "sitting with a phone" -o out/phone-request --json
rev2d avatar grid out/my-library/characters/hero/standing
rev2d avatar validate out/my-library/characters/hero/standing --json
# Place landmarks in avatar.json, inspect avatar overlay, then:
rev2d library rig out/my-library --character hero --pose standing --json
rev2d avatar poses out/my-library/characters/hero/standing
rev2d library validate out/my-library --json
rev2d library sheet out/my-library -o out/library.png --json
```

Generation requests contain a prompt, expected dimensions and copies of reference attachments.
Rev2D makes no network calls and generates no artwork. Send those files to your generator, inspect
the result for identity and pose, then import one PNG. `style.prompt` overrides the default style.
New character import saves its first pose as an identity reference; replace this with a canonical
reference when appropriate. The generated avatar is currently the upstream face/bust system: it
does not infer articulated arms, hands or legs from a full-body image. Those require the acting phase.

## Manifest version 1

```json
{
  "version": 1,
  "name": "my-channel",
  "style": { "prompt": "Clean 2D cartoon, white faces, dark outlines, consistent colours." },
  "backgrounds": [
    { "id": "room", "src": "backgrounds/room/source.png", "size": [960,540],
      "anchors": { "sofa_left": { "at": [190,355], "scale": 1, "pose_tags": ["sitting"] },
                   "calendar": { "rect": [700,80,100,120] } },
      "floor_y": 480, "tags": ["interior"], "variants": {} }
  ],
  "characters": [
    { "id": "hero", "name": "Hero", "description": "Blue jacket and round glasses",
      "height": 440, "references": ["characters/hero/standing/source.png"],
      "poses": [ { "id": "standing", "avatar": "characters/hero/standing",
                   "anchor": "feet", "facing": "front", "tags": ["standing"] } ] }
  ],
  "props": [ { "id": "box", "src": "props/box/source.png", "anchor": "bottom-center", "tags": ["box"] } ],
  "bubbles": [ { "id": "thought", "src": "bubbles/thought/source.png",
                 "content_rect": [20,20,200,120], "tail": [30,160] } ],
  "ui": [ { "id": "phone", "model": "ui/phone.r2d.json", "params": { "Progress": "0..1" } } ]
}
```

Paths use relative forward slashes and stay inside the library, including symlinks. Ids are unique
within each kind; pose ids are unique within a character. Named background anchors have either `at`
or `rect`, a positive scale, and optional compatible pose tags. A character pose uses `feet`, `seat`
or explicit `[x,y]` coordinates in its source image. Background anchoring/composition belongs to the
scene phase; this phase stores and validates the asset metadata. Import defaults require review:
character height is initially the cutout height; bubble content bounds initially cover the image.
Edit them to the intended standing height and interior content area.

UI entries reference an authored Rev2D model. Add them to the manifest; the PNG importer does not
pretend to create an interactive UI rig from a screenshot.

## Keying

Import accepts standard PNGs. For transparent PNGs, existing alpha is retained. For opaque cutouts,
`--key auto` estimates the border colour using channel medians in CIE Lab and refuses nonuniform
borders. `--key white` and `--key '#00FF00'` select an explicit key; `--tolerance` sets Lab distance.
Border-connected background is flooded, saturated enclosed green regions are removed with a colour
clash warning, tiny foreground islands are removed, and a two-pixel boundary neighbourhood is used
to recover antialiased dark outlines and reduce green spill. Original inputs are never modified.

`--no-trim` keeps source coordinates. Otherwise the cutout is cropped with `--padding` (default 8).
`import.json` records the original size, crop offset, estimated background and review diagnostics.
Do not reuse unshifted landmarks after trimming.

This is a uniform-background keyer, not semantic segmentation. White enclosed regions can be either
background or the subject's white face/gloves: they are preserved. Green clothing can be confused
with the key. A layered transparent source is preferable for either ambiguity. Inspect all cutouts.
An external remover is optional: `--remover /path/to/wrapper` executes that file without a shell,
passing exactly `input-path output-path`, with a 120-second timeout. A rembg wrapper can call its
`i` command. No remover, model download or Python package is required for built-in keying/tests.

## Validation and build provenance

`library validate` checks assets, PNG dimensions, references, built avatars, source/model/layer
fingerprints and the parameter contract across a character's poses. `library rig` and
`rev2d_avatar_build` record `library-build.json` inside each pose. A later edit to source.png,
avatar.json, model or layer textures makes the pose unbuilt/stale until rebuilt. For a pose built
with the upstream avatar CLI, run `library rig` once to record provenance. All poses must expose the
same parameter ids, ranges and defaults. Success checks technical readiness, not artistic approval.

Diagnostics include JSON pointers and a fix hint:

| Code | Meaning / correction |
| --- | --- |
| `library-schema-*` | Invalid version, field, type or relative path; follow this manifest. |
| `library-duplicate-id` | Rename a repeated asset or pose id. |
| `library-file-read`, `library-file-missing` | Repair the manifest or copy the referenced file. |
| `library-path-outside` | Replace traversal or an escaping symlink with an internal path. |
| `library-image-format`, `library-image-size` | Use PNG and its actual dimensions. |
| `library-avatar-invalid`, `library-model-invalid` | Repair avatar landmarks or model diagnostics. |
| `library-pose-unbuilt` | Build and fingerprint the current pose. |
| `library-unknown-anchor`, `library-unknown-param` | Correct pose coordinates/anchor or UI parameter. |
| `library-parameters-inconsistent` | Standardize parameter ids, ranges and defaults across poses. |
| `library-key-background-noisy` | Regenerate on a uniform background or import transparent art. |
| `library-key-subject-touches-border` | Regenerate with margin around hair, hands and feet. |
| `library-key-fill-color-clash`, `library-key-holes` | Review same-colour clothing or transparent holes. |
| `library-key-empty`, `library-key-color`, `library-key-options` | Repair the source or key settings. |
| `library-import-id`, `library-import-exists` | Supply ids or use a new asset id. |
| `library-busy` | Wait for the library writer; do not delete a live lock. |
| `library-remover-failed` | Repair the executable wrapper; arguments are not shell syntax. |
| `library-unknown-character`, `library-unknown-pose` | Search the catalogue and correct the id. |
| `library-request-exists`, `library-search-empty` | Choose a new output or broaden the filters. |
| `library-io` | Check the path, output collision and filesystem permissions. |

## Reproducible synthetic demo

Run `node --import tsx scripts/demo-library.ts out/demo-phase0/synthetic` to generate the original
vector figure in four poses (standing, pointing, sitting and sitting with phone), a room, a box,
a thought bubble, a parameterized phone UI, green /
white / transparent sources, quantitative keying metrics, built avatar projects and a contact sheet.
The builders are in `scripts/examples/figure.ts` and `scripts/examples/room.ts`; known joints and
independent transparent alpha masks are exposed through `test/fixtures/studio.ts`. No user art is
stored in tests, docs or fixtures.

## Agent tools

MCP exposes `rev2d_library_search`, `rev2d_library_validate`, `rev2d_library_import`,
`rev2d_library_request`, `rev2d_library_sheet`, and `rev2d_avatar_new`, `rev2d_avatar_validate`,
`rev2d_avatar_grid`, `rev2d_avatar_overlay`, `rev2d_avatar_build`, `rev2d_avatar_poses`.
The image tools return PNGs inline; review those images before accepting a pose. See
[AVATAR.md](AVATAR.md) for landmark placement and [MCP.md](MCP.md) for setup.
