# Spine and Live2D interop

Rev2D reads and writes the public JSON formats of **Spine** (skeleton JSON + texture atlas) and
**Live2D Cubism** (motion3, exp3, physics3, cdi3 and model3 JSON), so models and motions can move
between Rev2D and those tools.

| | Import into Rev2D | Export from Rev2D |
| --- | --- | --- |
| **Spine** 3.8 – 4.2 skeleton JSON + `.atlas` + PNG pages | a new Rev2D model | `<name>.json` (Spine 4.x) + `<name>.atlas` + PNG pages |
| **Live2D** `.motion3.json` | an animation | one file per animation |
| **Live2D** `.exp3.json` | a one-key animation for `add` layering | (not exported) |
| **Live2D** `.physics3.json` | physics groups (an approximation) | physics settings (an approximation) |
| **Live2D** `.cdi3.json` | parameter and part names, parameter groups | parameter names and groups |
| **Live2D** `.model3.json` | everything it lists, as edit ops on an existing model | a partial model3.json that lists the files above |
| **Live2D** `.moc3` | **not supported** (proprietary, undocumented binary) | **not written** |

**Nothing is lost silently.** Every conversion returns a report. Each feature that was approximated or
dropped is an issue with a stable `code`, a `where` (its location in the source data) and usually a
`hint` with the fix. The CLI prints the report, `--json` and the MCP tools return all of it, and the
editor shows it after every import and export.

Contents: [Where to find it](#where-to-find-it) · [Live2D: what .moc3 means](#live2d-what-moc3-means) ·
[Workflows](#workflows) · [Spine import](#spine-import) · [Spine export](#spine-export) ·
[Coordinates](#coordinates) · [Live2D files](#live2d-files) · [The parameter map](#the-parameter-map) ·
[Reports](#reports) · [Limitations](#limitations) · [Licensing](#licensing)

---

## Where to find it

| | Spine | Live2D |
| --- | --- | --- |
| CLI | `rev2d import spine <skeleton.json> -o <model.r2d.json>`<br>`rev2d export spine <model> -o <dir>` | `rev2d import live2d <file.json>... --into <model.r2d.json>`<br>`rev2d export live2d <model> -o <dir>` |
| MCP | `rev2d_import {format: "spine", path, out?}`<br>`rev2d_export {format: "spine", path, out_dir}` | `rev2d_import {format: "live2d", path, into}`<br>`rev2d_export {format: "live2d", path, out_dir}` |
| Editor | **File > Import from computer…** (pick or drop the `.json`, `.atlas` and PNG pages)<br>**File > Export to > Spine…** | **File > Import Live2D motions…** (or drop the files)<br>**File > Export to > Live2D motions…** |
| Code | `importSpine`, `exportSpine` (pure, src/interop); `importSpineFile`, `exportSpineToDir` (files, src/node/interop.ts) | `importLive2dModel3`, `importLive2dMotion`, `exportLive2d`, ... (pure); `convertLive2dSources`, `applyOpsToModelFile`, `exportLive2dToDir` (files) |

Flags and `--json` shapes: [CLI.md](CLI.md#import--export-spine-live2d). MCP arguments:
[MCP.md](MCP.md#spine-and-live2d-rev2d_import-rev2d_export). File IO for all three front ends lives in
`src/node/interop.ts`; the converters in `src/interop/` are pure. Both are exported from the package
root:

```ts
import { exportSpineToDir, importSpineFile, loadModelFile } from 'rev2d';

const spine = await importSpineFile('hero/hero.json');            // doc + textures/ files + report
console.log(spine.report.issues.filter((i) => i.severity === 'warning'));
const m = await loadModelFile('hana.r2d.json');                   // validated, textures decoded, rig compiled
if (m.model && m.rig) {
  const out = await exportSpineToDir({ model: m.model, rig: m.rig, textures: m.textures }, 'out/hana-spine', { animations: ['idle'] }, { overwrite: true });
  console.log(out.files.map((f) => `${f.rel} ${f.status}`), out.report.stats);
}
```

In the editor, an import from Live2D is **one undoable edit** (`Ctrl+Z` takes all of it back), and
exports go into a folder of the workspace (default `exports/<model>-spine` or `exports/<model>-live2d`),
asking before replacing different files.

## Live2D: what .moc3 means

A Live2D model is a `.moc3` file (the art meshes, deformers and keyforms, compiled by Cubism Editor)
plus JSON files around it. The `.moc3` format is **proprietary and undocumented**, so Rev2D never reads
or writes it. What that means in practice:

- **You can move motions, expressions, physics and display names** between Live2D models and Rev2D
  models. They only refer to **parameter ids** (`ParamAngleX`, `ParamEyeLOpen`, ...), so they work on
  any model that has those parameters.
- **You cannot move the model itself** (its geometry, textures, deformers). Importing a `model3.json`
  keeps the Rev2D model's own rig and brings in what drives it; exporting writes files for a Live2D
  model that already exists (built in Cubism Editor).
- A Rev2D model whose parameter ids follow the Live2D standard (like the `hana` example) is a good
  **proxy** for authoring motions: write and verify them in Rev2D, play them on the Live2D model.

## Workflows

### AI makes Live2D motions

An AI agent authors a motion on a Rev2D model with the same parameters as your Live2D model, checks
it with pictures and numbers, and exports it as a `.motion3.json` that Cubism plays.

1. **A proxy model.** `hana` uses the Live2D standard parameters (`AngleX`, `EyeLOpen`, `MouthOpen`,
   `BodyAngleX`, ...; see [the parameter map](#the-parameter-map)):

   ```sh
   rev2d new proxy.r2d.json --template hana
   ```

   If your Live2D model uses its own parameter ids, add parameters with those names (op `add`
   `parameter`) or write a [map file](#custom-maps).
2. **Author the motion** with key ops (see [OPS.md](OPS.md) `key`) or by asking the agent ("make a
   2 s wave: the head tilts right, the eyes smile, the body leans"):

   ```sh
   rev2d ops proxy.r2d.json wave-keys.json
   ```

3. **Verify it** like any animation: a contact sheet, exact numbers, the loop seam.

   ```sh
   rev2d sheet proxy.r2d.json -o out/wave.png --anim wave --frames 8
   rev2d analyze proxy.r2d.json --anim wave --warmup 4
   ```

4. **Export it:**

   ```sh
   rev2d export live2d proxy.r2d.json -o out/live2d --anim wave
   ```

   The report says which eases were written exactly and which were fitted (with the error), and which
   tracks Live2D motions cannot hold (bone or shape tracks: animate parameters instead).
5. **Play it in Cubism.** Copy `out/live2d/motions/wave.motion3.json` into your model's folder (for
   example `motions/`) and add it to the model's `model3.json`:

   ```json
   "Motions": {
     "Idle": [{ "File": "motions/idle.motion3.json" }],
     "Wave": [{ "File": "motions/wave.motion3.json", "FadeInTime": 0.5, "FadeOutTime": 0.5 }]
   }
   ```

   Open the model in Cubism Viewer (drop its `model3.json`) or any Cubism SDK app and play the `Wave`
   group. `out/live2d/proxy.model3.json` lists every exported file in this layout, ready to merge.

The same path works for expressions and display names in reverse: `rev2d import live2d` brings a
Live2D model's `.exp3.json` expressions, `.physics3.json` physics and `.cdi3.json` parameter names
into the proxy, so the agent works with the real model's vocabulary.

### Bring a Spine character in

1. In Spine, **Export > JSON** with texture packing on (the export folder then holds
   `hero.json`, `hero.atlas` and `hero.png`). Binary `.skel` exports are not supported.
2. Convert it:

   ```sh
   rev2d import spine exports/hero.json -o models/hero.r2d.json
   ```

   The atlas is found next to the skeleton (`hero.atlas` or `hero.atlas.txt`, also `x.atlas` for
   `x-pro.json` as in the Spine samples, or the only atlas there); pass `--atlas` otherwise. `--skin`
   picks a skin, `--scale` resizes the skeleton, `--padding` sets the canvas margin.
3. Read the report, then check the result:

   ```sh
   rev2d render models/hero.r2d.json -o out/hero.png --overlay bones,labels
   rev2d sheet models/hero.r2d.json -o out/walk.png --anim walk --frames 8
   ```

4. From here it is an ordinary Rev2D model: add parameters and bindings with ops to give it
   Live2D-style controls, layer its animations, or open it in the editor.

In the editor: **File > Import from computer…**, pick the skeleton `.json`, the `.atlas` and the PNG
pages together (or drop them on the window). The model is converted into
`<skeleton name>.r2d.json` with its pages in `textures/`, opened, and the toast's **Report** button
shows the conversion report.

### Send a Rev2D rig to Spine runtimes

1. Export:

   ```sh
   rev2d export spine hero.r2d.json -o out/hero-spine --texture-scale 2
   ```

2. Load `out/hero-spine/hero.json` with `hero.atlas` in a Spine runtime (spine-player,
   spine-webgl, spine-unity, ...) like any Spine export. The pages have **premultiplied alpha**
   (`pma: true`), the runtimes' default; `--straight-alpha` writes straight alpha instead (then
   configure the runtime with premultiplied alpha off). The Spine editor reads the JSON with
   **Import Data**; the export holds packed atlas pages, not one image per attachment
   (`skeleton.images` is `./`), so unpack the atlas first (Spine's Texture Unpacker) to see the art
   there.
3. Everything Rev2D evaluates at runtime (parameters, bindings, warps, physics, IK) is **baked** into
   the exported animations: the Spine skeleton plays them exactly, but it has no parameters to drive.
   `--param-poses` adds a one-frame animation `param/<id>/min` and `param/<id>/max` for every bound
   parameter, which Spine apps can mix like poses.

---

## Spine import

Spine 3.8, 4.0, 4.1 and 4.2 skeleton JSON (legacy 3.x field names and curve forms included), with a
4.x or legacy (libGDX) atlas.

| Spine | Rev2D | Status |
| --- | --- | --- |
| Bones (x, y, rotation, scaleX, scaleY, length, color) | bones, y flipped, angles clockwise ([Coordinates](#coordinates)) | exact; names that are not valid ids are renamed (`spine-id-renamed`, the original name is kept in the description) |
| Shear (setup and shear timelines) | two bones: an outer bone `<id>-shear` (translation, rotation, non-uniform scale) and the bone itself on it, with its own rotation (any 2×2 transform is a rotation, a non-uniform scale and a rotation) | exact in the setup pose and for animations that only move or rotate the bone; where an animation also scales or shears it, the pair's rotation and scale tracks are sampled (`spine-bone-shear-pair`); bones inside IK chains or with non-normal inheritance keep one bone and drop the shear (`spine-bone-shear`, `spine-timeline-shear`) |
| Inheritance other than `normal` (`onlyTranslation`, `noRotationOrReflection`, `noScale`, `noScaleOrReflection`) and 4.2 `inherit` timelines | emulated: the bone keeps Spine's world orientation / scale; its tracks are resampled where the rule changes the pose | exact up to sampling (`spine-bone-inherit-baked`); under a non-uniformly scaled parent the bone becomes a root bone with sampled world tracks (`spine-bone-inherit-detached`, shear it would still need: `spine-bone-inherit-shear`); a setup IK that moves a parent changes its setup rotation (`spine-bone-inherit-setup-ik`); bones inside IK chains are not emulated (`spine-bone-inherit`) |
| Slots and draw order | parts in draw order (`z` = slot index): one part per attachment of the imported skin, named `<slot>` or, when a slot has several attachments, `<slot>__<attachment>`, and tagged `spine-slot:<slot>` and `spine-attachment:<name>`; the setup attachment is visible, the others have opacity 0 | exact; `drawOrder` timelines become stepped `z` tracks |
| Region attachments | 4-vertex textured `mesh` parts (rotated and whitespace-stripped regions included) | exact |
| Mesh attachments | textured mesh parented to the slot bone; **weighted** meshes become skinned parts with explicit weights | exact; approximated when a mesh's per-bone offsets disagree, which Rev2D's one setup position per vertex cannot hold (`spine-weighted-offsets`) |
| Linked meshes | the parent mesh's geometry with their own region | exact |
| Clipping attachments | an invisible mask polygon for the clipped slots; a clip that animations show or hide switches between its outline and a polygon far around the canvas that clips nothing (`spine-clipping-animated`) | exact for unweighted clips; weighted clips follow their most influential bone (`spine-clipping-weighted`); of several clipping attachments in one slot only the first is converted (`spine-clipping-multiple`), and a clip that is both toggled and deformed keeps its outline (`spine-clipping-deform`) |
| Bounding box, point, path attachments | none | skipped (`spine-attachment-skipped`) |
| Skins | the chosen skin over `default` (`--skin`) | other skins are listed (`spine-skin-not-imported`) |
| Slot / attachment colors, alpha | `tint` and `opacity` | exact; two-color (dark) tint is dropped (`spine-dark-color`) |
| Blend modes | `normal`, `add`, `multiply`, `screen` | exact |
| Atlas pages | PNG textures in `textures/` | premultiplied pages are converted to straight alpha (`spine-page-unpremultiplied`); a page that looks premultiplied without `pma: true` is flagged (`spine-page-maybe-pma`) |
| IK constraints | `ik` with mix, bend direction, softness (px), stretch | exact; `compress` and `uniform` are not supported (`spine-ik-compress`, `spine-ik-uniform`); stretch together with softness is imported without stretch, as Spine never stretches a softened chain (`spine-ik-soft-stretch`); animated softness / bend / stretch become variant constraints whose mixes the animations drive, with in-between variants where softness is interpolated (`spine-ik-variants`); approximated on non-uniformly scaled chains (`spine-ik-nonuniform-scale`) and for a child off its parent's axis while stretching (`spine-ik-child-offset`) |
| Transform constraints | translate-only constraints between siblings become bone translation (`spine-transform-baked`); all others (world or local, absolute or relative, every mix, animated mixes) are emulated: the constrained bones' tracks are resampled wherever the constraint changes the pose, and the setup pose includes it | exact up to sampling (`spine-transform-emulated`; a bone that would need shear becomes a root bone with sampled world tracks: `spine-bone-model-space`); constraints of skins that were not imported are inactive (`spine-constraint-skin-inactive`); constraints on bones inside IK chains, and local ones toward a sheared bone, are skipped (`spine-transform-constraint`) |
| Path and physics constraints | none | skipped (`spine-path-constraint`, `spine-physics-constraint`) |
| Rotate / translate / scale timelines | absolute bone tracks | exact (Spine's relative values become absolute; Bézier curves become exact `cubic-bezier` eases, stepped keys `step`) |
| Color / alpha timelines | `tint` / `opacity` tracks | exact (channels with different curves or key times are sampled: `spine-color-curve-sampled`, `spine-color-sampled`) |
| Attachment timelines | stepped opacity of the attachment parts | exact |
| Deform timelines | `shape.vertices` tracks | exact (weighted and linked meshes included) |
| Events | events with their `int` / `float` / `string` values as `data` (a key's own values, else the event's defaults); audio events also keep `audio`, `volume` and `balance` | exact; an event key the skeleton does not define is imported and flagged (`spine-event-unknown`) |
| IK timelines | `ik:<id>.mix` tracks | exact while a timeline keeps one softness, bend direction and stretch; otherwise the mixes of the variant constraints are sampled at 30 fps plus the key times |
| Image sequences and sequence timelines | one part per frame, shown one at a time (stepped opacity) as the setup frame and the sequence timelines select (every mode: hold, once, loop, pingpong and the reverse modes) | exact (`spine-sequence`) |
| Loops | `loop: true` when the animation ends in its start pose | inferred (`spine-animation-once` otherwise) |

The canvas is the skeleton's bounds (`skeleton.x / y / width / height`) times `--scale`, with
`--padding` px (default 32) around them. When those bounds are far larger than the setup attachments
(some exports carry bogus bounds), the attachments' bounds are used instead (`spine-bounds-ignored`),
as they are when the skeleton names no bounds. The model file is written with 5 decimals, so atlas
coordinates stay sub-pixel exact on 4096 px pages; a later `rev2d ops` or editor save rewrites it
with the usual 4.

Emulated rules (inheritance modes, transform constraints, animated shear) are sampled at 30 fps plus
every key time and refined, down to 1/480 s, where linear interpolation misses the rule by more than
0.05 px / 0.05°; the samples are then thinned to the keys needed within 0.005 px / 0.005°. The result
plays what Spine shows, but the Spine rule itself is gone: moving a parent or a target in Rev2D does
not re-apply it (the report says so for every such bone; re-import after editing the motion in
Spine).

**Accuracy.** The importer was checked locally against the Spine 4.2 runtime (spine-core with exact
Bézier curves, and spine-player pixel comparisons) on Spine's example projects, which are not part of
Rev2D. Rigs without path / physics constraints or two-color tint match Spine within 0.5 px in most
animations; the exceptions are reported: `spine-ik-nonuniform-scale` (up to ~10 px on IK chains with
non-uniformly scaled bones), `spine-weighted-offsets` (up to ~6 px on meshes whose bones disagree on
a vertex) and, in the fastest motions, the 1/480 s sampling floor of emulated rules (under 0.5 px).
The Spine runtimes evaluate each Bézier curve as 10 straight segments while Rev2D evaluates the exact
curve: in fast motions that alone moves a bone by a few px, up to ~10 px, against what a Spine
runtime draws.

## Spine export

The exporter writes a Spine 4.x skeleton (`--spine-version`, default `4.2.00`; `4.0` uses the 4.0
deform layout; another major version is written as asked with a warning, `spine-export-version`), an
atlas and PNG pages. It tells Spine what Rev2D *shows*, frame by frame:

| Rev2D | Spine | Status |
| --- | --- | --- |
| Setup pose (default parameters, no animation, physics at rest, IK solved) | setup pose | exact |
| Bones | bones under a synthetic root at the canvas origin (`spine-root-renamed` names it `rev2d-root` when `root` is taken) | exact |
| Parts (fills, gradients, strokes, images, meshes, textures) | one slot each, with a textured mesh; the part's paint is rasterized alone at `--texture-scale` | exact up to rasterization |
| Tint, opacity | slot color | exact, animated too |
| Blend modes | Spine blend modes | exact with premultiplied pages (the default; with `--straight-alpha`, `spine-blend-straight-alpha` warns about multiply / screen slots) |
| Warps | a grid of bones (one per used lattice point) and meshes weighted with the bilinear weights | exact (`spine-warp-bones`) |
| Skinned parts | weighted meshes | exact |
| Shape changes (bindings or tracks on shape fields, path morphs) | deform timelines; the texture is drawn from the part's largest state | baked (`spine-morph-baked`); a gradient fill then stretches with the mesh instead of being re-evaluated (`spine-gradient-morph`) |
| Fill or stroke color that is bound or animated, stroke width changes | the paint of the part's reference state | not exportable (`spine-paint-animated`, `spine-stroke-width-animated`): Spine can only multiply a texture, so animate `tint` instead |
| Masks | clipping attachments traced from the mask's coverage (hard edge at 50% alpha), one per run of parts that share a mask | approximated (`spine-mask-clipping`); inverted masks are not supported (`spine-mask-inverted`); of several mask parts, or of separate regions of one mask, only the largest clips (`spine-mask-union`, `spine-mask-regions`); parts under a mask that covers nothing are exported unclipped, where Rev2D draws nothing (`spine-mask-empty`); a draw order change that splits a masked run makes the clip cover other slots (`spine-mask-draw-order`) |
| IK | bone rotations after IK; constraints written with mix 0 (editable, inactive) | baked (`spine-ik-baked`) |
| Physics | baked into the animations; loops are sampled after at least 5 s of warm-up cycles, so they start in the steady state | baked (`spine-physics-baked`); Rev2D physics moves in 60 Hz steps, which Spine interpolates smoothly between samples |
| Parameters, bindings | their effect in the baked animations; `--param-poses` adds min / max poses | baked (`spine-parameters-baked`) |
| Animations | sampled at `--fps` (default 30) plus every key time; an interval is halved (up to 5 times, not below 1/480 s, or 1/60 s for models with physics) while its midpoint pose is off the linear interpolation of its ends by more than the tolerance; the samples are reduced to linear and Bézier keys within `--tolerance` (default 0.05: px and degrees; scales use 1/100 of it, colors 0.04 of it). A `step` key of the source becomes a stepped key, not a short ramp: Rev2D holds the old value up to and including the next key's time, Spine switches 1 ms later | approximated within the tolerance (`spine-animations-sampled`); `--tolerance 0` keeps every sample as a linear key |
| Bone `length` bindings or tracks | none: Spine cannot animate a bone's length | their effect on IK and skinning is baked (`spine-bone-length-animated`) |
| Events | Spine events: a number, string or boolean as `int` / `float` / `string`; of an object the `int`, `float`, `string`, `volume`, `balance` and `audio` fields | exact; other fields go into `string` as JSON (`spine-event-data`) or are dropped when `string` is taken (`spine-event-data-dropped`); an event name has one audio path (`spine-event-audio`) |
| Parts with `visible: false` in the model | not exported (`spine-part-hidden`), even when a binding or track shows them later: start such a part with `opacity: 0` instead | masks among them still clip |

Pages are packed (MaxRects, power-of-two pages up to `--max-page-size`, 2 px padding) with
premultiplied alpha by default; a part larger than a page is rasterized smaller
(`spine-texture-downscaled`). Importing an export with `--padding 0` gives back the same canvas.

## Coordinates

Spine is y-up with counter-clockwise degrees; Rev2D is y-down (canvas pixels) with clockwise degrees.
With F = diag(1, -1), a bone's local transform maps as

| Spine | Rev2D |
| --- | --- |
| `x`, `y` | `x`, `-y` |
| `rotation` | `-rotation` |
| `scaleX`, `scaleY` | `scaleX`, `scaleY` |
| IK `bendPositive` | flipped (the y flip mirrors the bend side) |
| world point (X, Y) | canvas point (X · scale + ox, -Y · scale + oy) |

On import the whole skeleton is scaled by `--scale` and translated so its setup bounds fit the
canvas with `--padding`. On export the canvas origin is the Spine origin: Spine (X, Y) = canvas
(X, -Y), and the skeleton's bounds are the canvas.

Live2D files carry parameter values only, so no coordinate conversion applies to motions and
expressions. Physics (physics3) maps its units as 1 unit = 1 px, with the x axis mirrored (Cubism's
physics x points to the screen left).

## Live2D files

### motion3.json

| Direction | What | Exactness |
| --- | --- | --- |
| import | `Parameter` curves -> `param:` tracks (ids through the [parameter map](#the-parameter-map)) | linear and stepped segments are exact; Bézier segments become `cubic-bezier` eases that follow the same curve (restricted Béziers are evaluated over normalized time, like the Cubism SDK), kept with the 4 decimals of a model file; a Bézier whose handle lies outside its segment is sampled at `Meta.Fps` (`live2d-bezier-sampled`); a value jump (inverse stepped or zero-length segment) happens 1 ms late, because keys need distinct times (`live2d-jump-delayed`); points after `Meta.Duration` are cut (`live2d-curve-trimmed`) |
| import | `PartOpacity` curves -> `part:<id>.opacity` when the model has a part with that id (`live2d-part-opacity`) | exact; dropped otherwise (`live2d-part-opacity-dropped`). Cubism SDK apps do not set the part's opacity from such a curve: they keep its value under the part's id for the model's pose (pose3.json) groups, which show the part whose value is above zero |
| import | `Model` EyeBlink / LipSync curves -> the parameters of the model3.json `Groups` | a parameter without a curve of its own gets the curve (`live2d-model-curve-applied`); otherwise EyeBlink is multiplied into its curve and LipSync added to it, as the SDK does, sampled at `Meta.Fps` (`live2d-model-curve-combined`). A motion3 file imported on its own has no groups: these curves are dropped (`live2d-model-curve-dropped`). A `Model` Opacity curve is dropped unless it is constantly 1 (`live2d-model-opacity-dropped`) |
| import | `UserData` -> events | exact |
| import | parameters the model lacks | dropped with a did-you-mean, one warning per file (`live2d-unknown-parameter`); a motion where nothing imports is reported (`live2d-motion-empty`); values outside a parameter's range are kept and clamped by the rig (`live2d-value-out-of-range`; `rev2d validate` then warns `track-value-out-of-range`) |
| import | Cubism 2 parameter ids (`PARAM_ANGLE_X`, `PARAM_EYE_L_OPEN`, ...) | read by their Cubism 3 names (`ParamAngleX`, ...) (`live2d-legacy-id`) |
| import | `Meta.Loop` | `loop: true`. The Cubism SDK does not loop a motion by this flag (the app decides), and files often set it on one-shot motions too, so it is reported (`live2d-loop-flag`): set `"loop": false` on such an animation |
| import | curves out of the order Model, Parameter, PartOpacity | all read; the Cubism SDK skips such a curve and the ones after it (`live2d-curve-order`) |
| import | fade times (`Meta`, per curve, model3 motion entries) | not imported: Rev2D animations have no fades (`live2d-fade-ignored`) |
| export | `param:` tracks -> `Parameter` curves | every curve runs to `Meta.Duration` (a curve ending earlier would drift back toward its first value in a looped SDK playback); linear and step exact; `smooth`, quad, cubic, back, bounce and `cubic-bezier` (x in 0..1) as exact Bézier segments (`live2d-ease-exact`); sine and elastic are fitted with Bézier pieces within the tolerance, a `cubic-bezier` ease with x outside 0..1 is sampled 60 times a second (`live2d-ease-approximated`, with the error); a track `offset` is baked into the curve (`live2d-track-offset-baked`) |
| export | `part:<id>.opacity` tracks -> `PartOpacity` curves | exact (`live2d-part-opacity-exported`); see the import row for how SDK apps use them |
| export | events -> `UserData` | exact (event data is dropped: `live2d-event-data-dropped`) |
| export | other tracks (bones, shapes, colors) | not exportable (`live2d-track-unsupported`): animate parameters; an animation with nothing left gets no file (`live2d-motion-skipped`) |
| export | `Meta` | exact counts; `AreBeziersRestricted` only when every handle sits at 1/3 and 2/3; `Loop`, `Fps` |

The Cubism SDK loops a motion every Duration + 1/Fps and blends back during that frame; Rev2D loops
every Duration (`live2d-loop-extra-frame`, and `live2d-loop-seam` on import when a looping curve ends
on another value than it starts).

**Accuracy.** Checked locally against the Cubism SDK for Web (its motion and physics code) on the
Cubism sample models, which are not part of Rev2D: imported parameter values agree with the SDK's
evaluation within 2e-3 on parameters with a ±30 range (the rest is the 4 decimals a model file keeps
of each ease handle, at most 0.005 % of a segment's change); exported motions load in the SDK with its
consistency check on, exact eases evaluate within 1e-6 of Rev2D and fitted ones within the error the
report names.

### exp3.json (import)

An expression becomes a one-key animation named `exp_<name>` (1 s, not looping) with **absolute**
values, meant to be played as an `add` layer (`--anim idle --anim "exp_smile,add"`). `Add` is exact;
`Multiply` and `Overwrite` are exact while the parameter sits at its default
(`live2d-exp-blend-approximated`); the expression's fade times are not imported
(`live2d-fade-ignored`).

### physics3.json (both directions, an approximation)

Both systems swing pendulum chains driven by parameters, but their integrators differ. The mapping:
inputs are normalized like Cubism does (the slope comes from the parameter range and the setting's
Normalization), gravity = 900 × Acceleration × Delay² px/s², damping per 60 Hz step = 1 − Mobility^(Fps/60),
angle outputs convert radians to degrees. A one-segment chain driven by X inputs, stepped at 60 fps,
swings exactly like the Cubism SDK's physics. The differences (the report names the ones a file
runs into):

- **Angle inputs (import).** Cubism turns the pendulum's gravity, so the chain swings over to the new
  direction and overshoots; Rev2D turns the rest direction its outputs are measured from, so they
  follow a head tilt at once, without the swing. Both rest at the same value
  (`live2d-physics-angle-input`).
- **Step rate.** Rev2D always steps physics at 60 Hz. A setting made for another rate (`Meta.Fps`
  30, say) keeps its damping per second, but its swings peak about 10 % differently (the report
  states the mapping, `live2d-physics-approximation`, not this difference).
- **Outputs of later vertices (import).** Cubism measures the Angle output of vertex 2 or later
  relative to the previous segment (0 whenever the chain is straight); Rev2D measures the segment's
  angle from the rest direction, which swings more (`live2d-physics-angle-relative`). An X output of
  vertex 2 or later becomes that segment's angle, exact for small swings
  (`live2d-physics-x-as-angle`).
- **X / Y outputs.** The Cubism SDKs never read the Scale of X / Y outputs and evaluate them as 0.
  Import converts them as the file describes them and warns, because an SDK app writes 0 to that
  parameter (`live2d-physics-translation-output`; a Y output also differs by a constant,
  `live2d-physics-y-offset`). Export writes Rev2D x outputs as Angle outputs of vertex 1 scaled by
  the distance from the pivot (`live2d-physics-x-as-angle`); y outputs stay Y outputs, with the same
  warning.
- **Angle outputs of later segments (export)** are written as the Angle output of vertex 1, the
  chain's first segment: same direction and rest angle, less of the outer segments' lag
  (`live2d-physics-output-first-segment`).
- **Rev2D stiffness (export)** becomes extra acceleration per vertex, and Angle input weights are
  scaled so the tilt at rest matches (`live2d-physics-stiffness-approximated`,
  `live2d-physics-angle-weight-scaled`). Importing such a file back gives groups without stiffness.
- Per-vertex differences in acceleration, delay or mobility are averaged per group
  (`live2d-physics-vertices-averaged`); an output `Weight` below 100 is folded into its scale
  (`live2d-physics-output-weight`); a normalization that maps the two halves of a parameter's range
  with different slopes uses their mean (`live2d-physics-normalization-asymmetric`).

Check the swing with `rev2d sheet <model> --anim <motion> --warmup 2` and tune weights or scales.

### cdi3.json (both directions)

Import: a parameter's display name becomes its `description` and its parameter group its `group`
(nested groups are flattened to the parameter's own group, `live2d-cdi-nested-groups`); the name of a
Live2D part becomes the description of the Rev2D part with the same id. `--display-info fill`
(default) only sets what is missing (`live2d-cdi-kept` counts what it left alone), `overwrite`
replaces, `skip` ignores the file.

Export: every parameter with the Live2D standard display name of its id, else its Rev2D id, and its
group. Rev2D descriptions are sentences rather than names, so they are not written
(`live2d-cdi-descriptions`), and neither are parts.

### model3.json

Import reads every file the model3.json lists, relative to it, and turns them into **edit ops** on an
existing Rev2D model, applied atomically (every op applies and the result validates, or nothing is
written):

- **Motions** become animations named after their files; `Model` EyeBlink / LipSync curves use the
  model3 `Groups`.
- **Expressions** become `exp_<Name>` animations.
- **Physics**: `--physics replace` (default) removes the model's physics groups that drive the same
  parameters (`live2d-physics-replaced`), `merge` keeps them (`live2d-physics-conflict`: the later
  group wins), `skip` ignores the file.
- **Display info** as above.
- **An existing animation with the same id is replaced** (`live2d-animation-replaced`). That is a
  **warning** when the animation was made in Rev2D: its tracks and events are gone from the model.
  To keep it, rename it first (`{"op": "rename", "kind": "animation", "from": "idle", "to":
  "idle_own"}`) or import a single motion3 / exp3 file under another id (`--id`, MCP `id`). It is
  only a note when an earlier Live2D import wrote the animation (the importers mark what they write
  in its `description`; an animation whose description you changed counts as yours again). The same
  holds for motion3 / exp3 files imported on their own. Run `--dry-run` first on a model you care
  about: it prints the same report and writes nothing.
- A listed file that is missing or unreadable is skipped with a warning (`live2d-file-missing`,
  `live2d-file-invalid`); the rest is imported.
- Reported and ignored: the `.moc3` (`live2d-moc-ignored`), textures, pose (part switching), user
  data, hit areas, layout, sounds, fade times and motion sync.

Export writes `<name>.model3.json` with `Motions` (the `idle` animation in the `Idle` group, the
others in groups named after their ids), `Physics`, `DisplayInfo` and `EyeBlink` / `LipSync` groups
for the standard eye and mouth parameters. It has no `Moc` and no `Textures`
(`live2d-model3-partial`): merge its entries into the model3.json of your Live2D model.

## The parameter map

Live2D files name parameters by Live2D ids; Rev2D models by their own ids. The map translates them.

| `--param-map` (MCP `param_map`) | Mapping |
| --- | --- |
| `standard` (default) | the table below; other ids unchanged |
| `none` | ids unchanged (for models that already use Live2D ids) |
| `prefix` | Live2D id = `Param` + Rev2D id, for every parameter of the model |
| `map.json` | a JSON object `{"<Rev2D id>": "<Live2D id>"}` merged over the standard preset |

On import, an id the map does not know is also tried as it is and without its `Param` prefix, so
`ParamBlush` finds a Rev2D `Blush`; unknown ids get a did-you-mean. Where a Rev2D parameter's range
differs from the Live2D standard range, the report says so once (`live2d-param-range-mismatch`).

**Standard preset.** The Rev2D id is the Live2D id without `Param`, except `MouthOpen`:

| Rev2D | Live2D | Range | | Rev2D | Live2D | Range |
| --- | --- | --- | --- | --- | --- | --- |
| `AngleX` | `ParamAngleX` | -30..30 | | `BodyAngleX` | `ParamBodyAngleX` | -10..10 |
| `AngleY` | `ParamAngleY` | -30..30 | | `BodyAngleY` | `ParamBodyAngleY` | -10..10 |
| `AngleZ` | `ParamAngleZ` | -30..30 | | `BodyAngleZ` | `ParamBodyAngleZ` | -10..10 |
| `EyeLOpen` | `ParamEyeLOpen` | 0..1 | | `Breath` | `ParamBreath` | 0..1 |
| `EyeLSmile` | `ParamEyeLSmile` | 0..1 | | `ArmLA` | `ParamArmLA` | -30..30 |
| `EyeROpen` | `ParamEyeROpen` | 0..1 | | `ArmRA` | `ParamArmRA` | -30..30 |
| `EyeRSmile` | `ParamEyeRSmile` | 0..1 | | `ArmLB` | `ParamArmLB` | -30..30 |
| `EyeBallX` | `ParamEyeBallX` | -1..1 | | `ArmRB` | `ParamArmRB` | -30..30 |
| `EyeBallY` | `ParamEyeBallY` | -1..1 | | `HandL` | `ParamHandL` | -10..10 |
| `EyeBallForm` | `ParamEyeBallForm` | -1..1 | | `HandR` | `ParamHandR` | -10..10 |
| `BrowLY` | `ParamBrowLY` | -1..1 | | `HairFront` | `ParamHairFront` | -1..1 |
| `BrowRY` | `ParamBrowRY` | -1..1 | | `HairSide` | `ParamHairSide` | -1..1 |
| `BrowLX` | `ParamBrowLX` | -1..1 | | `HairBack` | `ParamHairBack` | -1..1 |
| `BrowRX` | `ParamBrowRX` | -1..1 | | `HairFluffy` | `ParamHairFluffy` | -1..1 |
| `BrowLAngle` | `ParamBrowLAngle` | -1..1 | | `ShoulderY` | `ParamShoulderY` | -10..10 |
| `BrowRAngle` | `ParamBrowRAngle` | -1..1 | | `BustX` | `ParamBustX` | -1..1 |
| `BrowLForm` | `ParamBrowLForm` | -1..1 | | `BustY` | `ParamBustY` | -1..1 |
| `BrowRForm` | `ParamBrowRForm` | -1..1 | | `BaseX` | `ParamBaseX` | -10..10 |
| `MouthForm` | `ParamMouthForm` | -1..1 | | `BaseY` | `ParamBaseY` | -10..10 |
| `MouthOpen` | `ParamMouthOpenY` | 0..1 | | `Cheek` | `ParamCheek` | 0..1 |

### Custom maps

```json
{ "Smile": "ParamMouthForm", "Blush": "ParamCheek", "HeadTilt": "ParamAngleZ" }
```

```sh
rev2d export live2d hero.r2d.json -o out/live2d --param-map map.json
rev2d import live2d Hiyori/hiyori.model3.json --into hero.r2d.json --param-map map.json --dry-run
```

The map must be one-to-one; entries replace the standard entries for the same ids.

## Reports

```ts
interface InteropReport {
  format: 'spine' | 'live2d-model3' | 'live2d-motion3' | 'live2d-physics3' | 'live2d-exp3' | 'live2d-cdi3';
  direction: 'import' | 'export';
  issues: Array<{ severity: 'warning' | 'info'; code: string; message: string; where?: string; hint?: string }>;
  stats: Record<string, number>; // what was converted, e.g. {bones: 12, slots: 8, animations: 2}
}
```

- **warning**: something was approximated or dropped in a way you may see (a skipped constraint, an
  unknown parameter, a physics difference, an animation of yours that an import replaced). **info**:
  a documented conversion choice or something ignored on purpose (an unused hit area, a baked
  physics group).
- **Codes are stable** (`spine-dark-color`, `live2d-unknown-parameter`, ...): search for them, filter
  on them. A few codes are a warning in one case and info in another (`live2d-animation-replaced`,
  `live2d-ease-approximated`): read the severity with the code. `where` points into the SOURCE data
  (`slots[4] (head)`, `transform[1] (other)`, `animations.walk.slots.head.rgba2`,
  `motions/idle.motion3.json: Curves[3]`). The tables above name the codes that matter most; the
  message and hint of every other one say what happened and what to do.
- The CLI prints warnings, then info, then the stats; `--json` has the whole report. The MCP tools put
  it in the result text (at most 80 issue lines) and in full in the JSON block. The editor shows it in
  the import / export dialogs and, after a Spine import, behind the toast's **Report** button.

## Limitations

- **`.moc3` is not supported**, now or later: it is proprietary and undocumented. See
  [Live2D: what .moc3 means](#live2d-what-moc3-means).
- **Spine imports read JSON exports only** (3.8 – 4.2), not binary `.skel` files, and one skin per
  import (`--skin`, over `default`).
- **Spine features Rev2D cannot express** are reported, not converted: path and physics
  constraints, two-color (dark) tint, IK `compress` / `uniform`, bounding boxes and points, and shear,
  inheritance modes or transform constraints on bones inside IK chains. Rigs that depend on path
  constraints (chains, treads, vines, legs driven along a path, as in the Spine sample
  "mix-and-match") import with visibly wrong limbs; the report lists every such constraint.
- **Emulated Spine rules are baked.** Inheritance modes, transform constraints and animated shear
  play as in Spine, but through sampled tracks: moving a parent or a target in Rev2D does not re-apply
  the rule. Animated IK softness becomes several variant constraints (a dozen or more for a
  constraint whose softness is keyed over a wide range), which match Spine closely but are heavier
  to edit by hand. Re-import after editing the motion in Spine.
- **Spine exports are baked.** Spine has no parameters, warps or pendulum physics: their effect is in
  the exported animations, sampled and reduced within the tolerance. Editing the Spine project does
  not change the Rev2D rig. An export holds atlas pages, not one image per attachment; fill or
  stroke colors that change, inverted masks and masks made of several parts cannot be expressed
  (see [Spine export](#spine-export)).
- **Physics is an approximation in both directions** (see [physics3.json](#physics3json-both-directions-an-approximation)).
- **Live2D motion3 holds parameter curves and part opacity only.** Bone, shape or color tracks of a
  Rev2D animation cannot be exported (they are reported); drive those properties with parameters and
  bindings instead. Expressions are imported but not exported (there is no exp3 export).
- **Automatic blinking and lip sync** of Cubism apps, pose (part switching) groups, user data, hit
  areas and sounds are app-side features: they are reported on import and not reproduced.
- Rev2D evaluates IK with its own solver: chains with non-uniformly scaled bones can bend differently
  from Spine's (`spine-ik-nonuniform-scale`, up to about 10 px on the Spine samples).

## Licensing

The readers and writers are implemented from the publicly documented formats (the Spine JSON and
atlas format documentation, the Live2D Cubism manual's descriptions of the motion3, exp3, physics3,
cdi3 and model3 JSON files). Where the documentation leaves behaviour open (how a runtime loops a
motion, in which order it reads curves, which physics outputs it evaluates), the conversions were
checked by running the official runtimes locally: spine-core and spine-player 4.2, and the Cubism SDK
for Web, on their makers' sample projects. Neither those runtimes nor the samples are part of Rev2D:
it contains no code from the Spine Runtimes or the Live2D Cubism SDK, does not depend on them, and
its test fixtures are hand-written. Spine and Live2D are trademarks of their owners. Using exported
files with the Spine Runtimes, the Spine editor, Cubism Editor or the Cubism SDK is subject to their
own licenses.
