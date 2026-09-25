# Rev2D recipes

Task-oriented cookbook for AI authors (and humans). Each recipe is **one batch of edit ops** that
you can paste into `rev2d ops` or MCP `rev2d_apply_ops`, followed by the commands that prove it
works. The recipes apply to the same small starter model (the walk cycle starts from the `empty`
template), so you can try any of them in a minute and then transfer the pattern to your own rig.

Every batch and every command on this page is executed by the test suite
(`test/docs-recipes.test.ts`, part of `npm test`): each batch applies to the starter (plus the
recipes it builds on) with 0 errors and 0 warnings, and each verification command exits with 0.

Read first: [SPEC.md](SPEC.md) (format and semantics), [OPS.md](OPS.md) (every op), and the
verification loop in [AGENTS.md](../AGENTS.md).

<!--
Test markers (read by test/docs-recipes.test.ts; keep them when editing):
  <!- - check:starter - ->            the next ```json block is the starter model
  <!- - check:ops name=X - ->         the next ```json block is ops batch X; "base=empty:WxH" starts it
                                     from the empty template instead of the starter (must come first in a chain)
  <!- - check:run chain=a,b - ->      apply batches a, b to a fresh starter, then run every `rev2d ...` line
                                     of the next ```sh block in that directory (exit code 0 expected)
(written with "- -" here so this comment stays one comment)
-->

| # | Recipe | Techniques | Builds on |
| --- | --- | --- | --- |
| 0 | [Starter model](#0-starter-model) | bones, parts, draw order | — |
| 1 | [Head turn](#1-head-turn-anglex--angley-warp-grid) | nested warps, `bind_warp` yaw/pitch, 3×3 keyform grid | starter |
| 2 | [Eye blink](#2-eye-blink-shape-binding--mask) | shape field binding, masks, keyed animation | starter |
| 3 | [Mouth open / form](#3-mouth-open--form-path-morph-over-a-2d-grid) | SVG path morph, 2-parameter grid, masked part | starter |
| 4 | [Breathing](#4-breathing-warp-scale--bone-offset) | `bind_warp` scale about a pivot, bone binding, idle loop | starter |
| 5 | [Hair physics](#5-hair-physics-pendulum--parameter--warp) | physics group, sparse warp offsets | starter |
| 6 | [Arm IK](#6-arm-ik-two-bone-constraint--target-bone) | bones by world position, two-bone IK, rigid parts | starter |
| 7 | [Skinned limb](#7-skinned-limb-one-mesh-two-bones) | `skin` with auto weights, `detail` | starter |
| 8 | [Squash & stretch](#8-squash--stretch-and-a-one-shot-hop) | bone scale bindings, whole-animation `add`, easing | starter |
| 9 | [Draw-order swap](#9-draw-order-swap-step-binding-on-z) | `part.z` binding, `"interpolation": "step"` | starter |
| 10 | [Glow and blush](#10-glow-and-blush-blend-modes) | `add` / `multiply` blending, gradients, opacity bindings | starter |
| 11 | [Textured parts](#11-textured-parts-atlas-crop-in-a-warp-textured-mesh) | textures, `image` crop + grid, `mesh` + `uvs` | starter |
| 12 | [Layered animations](#12-layered-animations-idle--blink) | several animations at once, weights | 4 + 2 |
| 13 | [Animation events](#13-animation-events) | `events` with data, finding them in a pose | 8 |
| 14 | [Closed eyes that stay clean](#14-closed-eyes-that-stay-clean-path-morph-eye--lash-band) | path-morph eye, lash band, mask sliver inside the lash | 1 |
| 15 | [Gestures over an idle](#15-gestures-over-an-idle-add-once-compose) | layer `add` / `once` / `start`, `compose` bake, `inspect --track` | 1 + 3 + 14 |
| 16 | [Rigid accessory on a turning head](#16-rigid-accessory-on-a-turning-head-hat) | own coarse lattice, `follow`, `inspect --point`, `warp-outside-parent` | 1 |
| 17 | [Markings with an outline](#17-markings-clipped-to-an-outlined-part) | mask + stroke-only line part on top | starter |
| 18 | [Parameter rigs in pixels](#18-parameter-rigs-in-pixels-and-degrees-bind_linear-relative-bind) | `bind_linear`, `bind` with `relative`, `sheet --overview` | starter |
| 19 | [Walk cycle](#19-walk-cycle-smooth-keys-track-offset-soft-ik) | `empty` template, `worldRotation`, `smooth` ease, track `offset`, IK `softness` / `stretch`, `analyze` | empty |
| 20 | [Physics tuning](#20-physics-tuning-with-analyze-and-seamless-loops) | `analyze` clamping + loop seam, `--warmup` GIFs | 5 |
| 21 | [Palette changes](#21-palette-changes-with-recolor) | `recolor` map / hsl | starter |

**Conventions** (SPEC.md §1, §3.1): setup space is canvas pixels, origin top-left, **+y down**;
angles are degrees, **positive = clockwise**; part and warp geometry is absolute setup-space
coordinates; bone `x`/`y`/`rotation` are local to the parent bone. Binding and animation values
are **absolute** (what the property should be), except warp offsets, which are offsets from the
rest lattice. The keyform at a parameter's default must equal the setup value, or the rest pose
changes. Standard parameters follow Live2D names and signs: `AngleX > 0` turns the face toward the
**screen right**, `AngleY > 0` looks **up** (features move to smaller y, although +y is down),
`AngleZ > 0` tilts **clockwise**, `EyeBallX/Y > 0` look right / up; `L` in an id is the
character's left, which is on the **screen right** for a character facing the viewer.

---

## 0. Starter model

A 512×512 bust: bones `root` (ground) → `body` → `head`, a back-hair block, a torso, a face, two eyes
(white + iris) and a path mouth. `L`/`R` follow Live2D: **`L` is the character's left, which is
on the screen's right**. The bones are unrotated, so a bone's local offsets equal world offsets.

Save this as `hero.r2d.json`:

<!-- check:starter -->
```json
{
  "format": "rev2d", "version": 1,
  "meta": { "name": "hero", "width": 512, "height": 512, "background": "#20242c" },
  "bones": [
    { "id": "root", "x": 256, "y": 500 },
    { "id": "body", "parent": "root", "x": 0, "y": -20 },
    { "id": "head", "parent": "body", "x": 0, "y": -140 }
  ],
  "parts": [
    { "id": "hairBack", "parent": "head", "shape": { "type": "rect", "x": 150, "y": 110, "w": 212, "h": 250, "radius": 90 }, "fill": "#3b2a4a", "z": 0 },
    { "id": "torso", "parent": "body", "shape": { "type": "rect", "x": 181, "y": 330, "w": 150, "h": 178, "radius": 50 }, "fill": "#4a6fa5", "z": 1 },
    { "id": "face", "parent": "head", "shape": { "type": "ellipse", "cx": 256, "cy": 230, "rx": 88, "ry": 100 },
      "fill": "#f2c9a0", "stroke": { "color": "#8a5a3c", "width": 3 }, "z": 2 },
    { "id": "eyeWhiteL", "parent": "head", "shape": { "type": "ellipse", "cx": 290, "cy": 225, "rx": 17, "ry": 12 }, "fill": "#ffffff", "z": 3 },
    { "id": "eyeWhiteR", "parent": "head", "shape": { "type": "ellipse", "cx": 222, "cy": 225, "rx": 17, "ry": 12 }, "fill": "#ffffff", "z": 3 },
    { "id": "irisL", "parent": "head", "shape": { "type": "ellipse", "cx": 290, "cy": 225, "rx": 9, "ry": 11 }, "fill": "#3a2f6b", "z": 4 },
    { "id": "irisR", "parent": "head", "shape": { "type": "ellipse", "cx": 222, "cy": 225, "rx": 9, "ry": 11 }, "fill": "#3a2f6b", "z": 4 },
    { "id": "mouth", "parent": "head", "shape": { "type": "path", "d": "M 236 282 C 248 285 264 285 276 282 C 264 287 248 287 236 282 Z", "tolerance": 0.1 },
      "fill": "#a0303a", "stroke": { "color": "#5a1a22", "width": 2 }, "z": 4 }
  ]
}
```

<!-- check:run chain= -->
```sh
rev2d validate hero.r2d.json
rev2d render hero.r2d.json -o out/starter.png --overlay bones,labels
```

**Applying a recipe.** Save the recipe's ops array as a file (say `head-turn.json`), preview, then
write:

```sh
rev2d ops hero.r2d.json head-turn.json --dry-run    # applies + validates, writes nothing
rev2d ops hero.r2d.json head-turn.json              # atomic: all ops or nothing
```

Try recipes on copies (`cp hero.r2d.json try.r2d.json`): each one assumes the plain starter unless
its "Builds on" column says otherwise. Over MCP, send the same array:
`rev2d_apply_ops {path: "hero.r2d.json", ops: [...], dry_run: true}`, then without `dry_run`.

| CLI | MCP tool |
| --- | --- |
| `rev2d ops <model> ops.json` | `rev2d_apply_ops {path, ops}` |
| `rev2d validate <model>` | `rev2d_validate {path}` |
| `rev2d render <model> -o x.png --param A=1 --overlay bones` | `rev2d_render {path, params: {A: 1}, overlay: ["bones"]}` |
| `rev2d sheet <model> -o x.png --sweep A=0:1:3` | `rev2d_sheet {path, sweeps: ["A=0:1:3"]}` |
| `rev2d sheet <model> -o x.png --anim idle --frames 8` | `rev2d_sheet {path, animation: "idle", frames: 8}` |
| `rev2d sheet <model> -o x.png --overview` | `rev2d_sheet {path, overview: true}` |
| `rev2d inspect <model> --param A=1 --part p --json` | `rev2d_inspect {path, params: {A: 1}, parts: ["p"]}` |
| `rev2d inspect <model> --anim walk --times 0:1:5 --track param:A,ik:legIk` | `rev2d_inspect {path, animations: ["walk"], times: [0, 0.25, 0.5, 0.75, 1], track: ["param:A", "ik:legIk"]}` |
| `rev2d inspect <model> --point 120,80@head` | `rev2d_inspect {path, points: ["120,80@head"]}` |
| `rev2d analyze <model> --anim idle --warmup 10` | `rev2d_analyze {path, animation: "idle", warmup: 10}` |

**Adapting to your model.** Replace the ids and coordinates. `rev2d info` lists ids and the bone
tree; `rev2d inspect --json` gives exact joints and part bounds (for warp `rect`s, pivots and bone
`world` positions); `rev2d hit <model> x y` tells you which part is under a pixel.

---

## 1. Head turn: AngleX × AngleY warp grid

Live2D-style pseudo-3D turn. Two nested warps: `headWarp` (face outline + hair) turns gently,
`faceWarp` inside it (eyes, mouth) turns more, so the features slide across the face while the
silhouette barely changes. `bind_warp` computes every lattice offset from `yaw` / `pitch`, and the
3×3 grid over `AngleX × AngleY` makes the diagonals (look up-left, ...) blend correctly.

<!-- check:ops name=head-turn -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "AngleX", "min": -30, "max": 30, "group": "Head" } },
  { "op": "add", "kind": "parameter", "value": { "id": "AngleY", "min": -30, "max": 30, "group": "Head" } },
  { "op": "add", "kind": "warp", "value": { "id": "headWarp", "parent": "head", "rect": [140, 100, 232, 270], "cols": 3, "rows": 3 } },
  { "op": "add", "kind": "warp", "value": { "id": "faceWarp", "parent": "headWarp", "rect": [180, 180, 152, 130], "cols": 4, "rows": 4 } },
  { "op": "update", "kind": "part", "id": "hairBack", "set": { "parent": "headWarp", "shape.detail": 16 } },
  { "op": "update", "kind": "part", "id": "face", "set": { "parent": "headWarp", "shape.detail": 12 } },
  { "op": "update", "kind": "part", "id": "eyeWhiteL", "set": { "parent": "faceWarp", "shape.detail": 6 } },
  { "op": "update", "kind": "part", "id": "eyeWhiteR", "set": { "parent": "faceWarp", "shape.detail": 6 } },
  { "op": "update", "kind": "part", "id": "irisL", "set": { "parent": "faceWarp", "shape.detail": 6 } },
  { "op": "update", "kind": "part", "id": "irisR", "set": { "parent": "faceWarp", "shape.detail": 6 } },
  { "op": "update", "kind": "part", "id": "mouth", "set": { "parent": "faceWarp", "shape.detail": 6 } },
  { "op": "bind_warp", "warp": "headWarp", "params": ["AngleX", "AngleY"], "keys": [
      { "at": [-30, -30], "yaw": -10, "pitch": 8 },  { "at": [0, -30], "pitch": 8 },  { "at": [30, -30], "yaw": 10, "pitch": 8 },
      { "at": [-30, 0], "yaw": -10 },                { "at": [0, 0] },                { "at": [30, 0], "yaw": 10 },
      { "at": [-30, 30], "yaw": -10, "pitch": -8 },  { "at": [0, 30], "pitch": -8 },  { "at": [30, 30], "yaw": 10, "pitch": -8 } ] },
  { "op": "bind_warp", "warp": "faceWarp", "params": ["AngleX", "AngleY"], "keys": [
      { "at": [-30, -30], "yaw": -20, "pitch": 15 }, { "at": [0, -30], "pitch": 15 }, { "at": [30, -30], "yaw": 20, "pitch": 15 },
      { "at": [-30, 0], "yaw": -20 },                { "at": [0, 0] },                { "at": [30, 0], "yaw": 20 },
      { "at": [-30, 30], "yaw": -20, "pitch": -15 }, { "at": [0, 30], "pitch": -15 }, { "at": [30, 30], "yaw": 20, "pitch": -15 } ] }
]
```

<!-- check:run chain=head-turn -->
```sh
rev2d sheet hero.r2d.json -o out/turn.png --sweep AngleX=-30,0,30 --sweep AngleY=30,0,-30 --viewbox 130,90,252,290
rev2d sheet hero.r2d.json -o out/turn-rig.png --sweep AngleX=-30,0,30 --overlay warps --scale 0.5
rev2d render hero.r2d.json -o out/face-lattice.png --param AngleX=30 --overlay warps --only faceWarp --viewbox fit
rev2d inspect hero.r2d.json --param AngleX=30 --part eyeWhiteL,eyeWhiteR,mouth
rev2d inspect hero.r2d.json --param AngleY=30 --part mouth
```

What to check: at `AngleX=30` the features move right (mouth center x 256 → 298.6), the far eye
(`eyeWhiteL`, screen right) is narrower than the near one (bounds widths 20.3 vs 40.9), and the
face outline moves much less than the features. At `AngleY=30` the head looks **up**: the mouth
center moves from y 283.9 to 252.2 (smaller y = higher on screen), and the top row of the sheet
(`AngleY=30`) shows the features raised.

- **Pitch sign.** Positive `yaw` turns toward +x (content shifts right). Positive `pitch` looks
  **down** (content shifts +y), because canvas y points down. The Live2D convention is
  `AngleY > 0` = look **up**, so the keyforms at `AngleY = 30` use **negative** pitch (−8 / −15
  above) and those at `AngleY = −30` positive pitch. Check it every time with
  `inspect --param AngleY=30`: feature centers must get smaller y values.
- The child warp's `rect` must lie inside the parent warp's `rect`; points outside a warp are
  extrapolated from its edge cells (validation warning `warp-outside-parent`, see
  [recipe 16](#16-rigid-accessory-on-a-turning-head-hat)).
- `--only faceWarp` limits the overlay to that warp (add `--only-chain` for a bone's ancestors), so
  a busy rig stays readable.
- Reparenting a part never moves it (its geometry is in setup space); only its deformation changes.
- Parts inside warps need `detail` (maximum triangle edge in px); without it a rect or ellipse is a
  handful of triangles and cannot bend.
- Parallax: put the back hair into its own warp and give it a small **opposite** yaw
  (`examples/hana`, binding on `backHairWarp`).

## 2. Eye blink: shape binding + mask

`EyeOpen` squeezes the eye whites (`shape.ry`) and lowers the lashes (`shape.y`). The irises are
**masked** by the eye whites, so they disappear with them instead of poking out of a closed eye.

<!-- check:ops name=blink -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "EyeOpen", "min": 0, "max": 1, "default": 1, "group": "Eyes" } },
  { "op": "update", "kind": "part", "id": "irisL", "set": { "mask": ["eyeWhiteL"] } },
  { "op": "update", "kind": "part", "id": "irisR", "set": { "mask": ["eyeWhiteR"] } },
  { "op": "add", "kind": "part", "value": { "id": "lashL", "parent": "head", "shape": { "type": "rect", "x": 271, "y": 211, "w": 38, "h": 4, "radius": 2 }, "fill": "#2b1d33", "z": 5 } },
  { "op": "add", "kind": "part", "value": { "id": "lashR", "parent": "head", "shape": { "type": "rect", "x": 203, "y": 211, "w": 38, "h": 4, "radius": 2 }, "fill": "#2b1d33", "z": 5 } },
  { "op": "bind", "target": "part:eyeWhiteL.shape.ry", "params": ["EyeOpen"], "keys": [{ "at": [0], "value": 1 }, { "at": [1], "value": 12 }] },
  { "op": "bind", "target": "part:eyeWhiteR.shape.ry", "params": ["EyeOpen"], "keys": [{ "at": [0], "value": 1 }, { "at": [1], "value": 12 }] },
  { "op": "bind", "target": "part:lashL.shape.y", "params": ["EyeOpen"], "keys": [{ "at": [0], "value": 223 }, { "at": [1], "value": 211 }] },
  { "op": "bind", "target": "part:lashR.shape.y", "params": ["EyeOpen"], "keys": [{ "at": [0], "value": 223 }, { "at": [1], "value": 211 }] },
  { "op": "key", "animation": "blink", "target": "param:EyeOpen", "t": 0, "v": 1, "duration": 4 },
  { "op": "key", "animation": "blink", "target": "param:EyeOpen", "t": 3.7, "v": 1, "ease": "inQuad" },
  { "op": "key", "animation": "blink", "target": "param:EyeOpen", "t": 3.82, "v": 0, "ease": "outQuad" },
  { "op": "key", "animation": "blink", "target": "param:EyeOpen", "t": 4, "v": 1 }
]
```

<!-- check:run chain=blink -->
```sh
rev2d sheet hero.r2d.json -o out/eyes.png --sweep EyeOpen=0:1:3 --viewbox 190,195,132,50 --scale 2
rev2d render hero.r2d.json -o out/blink.png --anim blink --time 3.82 --viewbox 190,195,132,50 --scale 2
rev2d inspect hero.r2d.json --param EyeOpen=0 --part eyeWhiteL,lashL
```

- `EyeOpen` defaults to 1, and the keyform at 1 (`ry` 12, lash `y` 211) equals the setup values,
  so the rest pose is unchanged.
- Close to a thin sliver (`ry` 1: y 224..226) that lies **inside** the closed lash (y 223..227),
  not to 0 and not below the lash: whatever the eye white still covers is where the iris can show.
  [Recipe 14](#14-closed-eyes-that-stay-clean-path-morph-eye--lash-band) explains why and does the
  same with curved lids.
- A mask clips to the union of the listed parts' **geometry and paint alpha**; the mask parts' own
  opacity and visibility are ignored. `"maskInvert": true` draws only outside.
- `key` creates the animation only when the first key passes `duration`. Keys keep `t` order, and
  `ease` shapes the segment from that key to the next.
- Winks: use `EyeLOpen` / `EyeROpen` (one parameter per eye) instead of one shared `EyeOpen`;
  `rev2d sheet --sweep EyeLOpen,EyeROpen=0:1:5` sweeps both together.
- For lids that follow the eye curve, morph an eye-white **path** instead
  ([recipe 14](#14-closed-eyes-that-stay-clean-path-morph-eye--lash-band), `examples/hana`).

## 3. Mouth open / form: path morph over a 2D grid

One binding over `MouthOpen × MouthForm` (2 × 3 = 6 keyforms) morphs the mouth path. Every keyform
keeps the setup path's command structure (`M C C Z`), so the numbers interpolate. A tongue masked
by the mouth appears only inside the opening.

<!-- check:ops name=mouth -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "MouthOpen", "min": 0, "max": 1, "group": "Mouth" } },
  { "op": "add", "kind": "parameter", "value": { "id": "MouthForm", "min": -1, "max": 1, "group": "Mouth" } },
  { "op": "bind", "target": "part:mouth.shape.d", "params": ["MouthOpen", "MouthForm"], "keys": [
      { "at": [0, -1], "value": "M 238 286 C 248 280 264 280 274 286 C 264 283 248 283 238 286 Z" },
      { "at": [0, 0],  "value": "M 236 282 C 248 285 264 285 276 282 C 264 287 248 287 236 282 Z" },
      { "at": [0, 1],  "value": "M 232 277 C 246 288 266 288 280 277 C 266 291 246 291 232 277 Z" },
      { "at": [1, -1], "value": "M 238 290 C 248 274 264 274 274 290 C 266 304 246 304 238 290 Z" },
      { "at": [1, 0],  "value": "M 236 280 C 248 277 264 277 276 280 C 268 310 244 310 236 280 Z" },
      { "at": [1, 1],  "value": "M 232 277 C 246 283 266 283 280 277 C 268 312 244 312 232 277 Z" } ] },
  { "op": "add", "kind": "part", "value": { "id": "tongue", "parent": "head", "shape": { "type": "ellipse", "cx": 256, "cy": 302, "rx": 15, "ry": 8 },
      "fill": "#e07a82", "mask": ["mouth"], "z": 4 }, "after": "mouth" }
]
```

<!-- check:run chain=mouth -->
```sh
rev2d sheet hero.r2d.json -o out/mouth.png --sweep MouthForm=-1,0,1 --sweep MouthOpen=0,0.5,1 --viewbox 216,262,80,60 --scale 2.5
```

- The keyform at `[0, 0]` (both defaults) is exactly the setup `d`.
- A path keyform must have the same commands in the same order as the setup path (absolute stays
  absolute, relative stays relative). `bind` and the validator reject a mismatch and print both
  structures, e.g. `"M2 C6 C6 Z0" (got "M2 L2 L2 Z0")` (command letter + number count).
- Curves are flattened with `tolerance` (px, default 0.5). The setup mouth is a thin sliver, so the
  starter sets `"tolerance": 0.1`; without it the open mouth looks polygonal.
- The tongue has the same `z` as the mouth and comes after it in the array (`"after": "mouth"`), so
  it draws on top of the mouth fill, clipped to the mouth.

## 4. Breathing: warp scale + bone offset

The torso sits in `bodyWarp`; `Breath` scales the lattice about the bottom of the torso and lifts
the head bone by the same amount, so the head rides on the chest. `idle` loops it.

<!-- check:ops name=breathing -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "Breath", "min": 0, "max": 1, "group": "Body" } },
  { "op": "add", "kind": "warp", "value": { "id": "bodyWarp", "parent": "body", "rect": [171, 320, 170, 200], "cols": 2, "rows": 2 } },
  { "op": "update", "kind": "part", "id": "torso", "set": { "parent": "bodyWarp", "shape.detail": 16 } },
  { "op": "bind_warp", "warp": "bodyWarp", "params": ["Breath"], "keys": [
      { "at": [0] }, { "at": [1], "scale": [1.03, 1.05], "pivot": [256, 508] } ] },
  { "op": "bind", "target": "bone:head.y", "params": ["Breath"], "keys": [{ "at": [0], "value": -140 }, { "at": [1], "value": -149 }] },
  { "op": "key", "animation": "idle", "target": "param:Breath", "t": 0, "v": 0, "ease": "inOutSine", "duration": 3 },
  { "op": "key", "animation": "idle", "target": "param:Breath", "t": 1.5, "v": 1, "ease": "inOutSine" },
  { "op": "key", "animation": "idle", "target": "param:Breath", "t": 3, "v": 0 }
]
```

<!-- check:run chain=breathing -->
```sh
rev2d inspect hero.r2d.json --param Breath=1 --bone head --part torso
rev2d sheet hero.r2d.json -o out/idle.png --anim idle --frames 6 --scale 0.5
```

- Bone binding values are **absolute local values**: `head.y` is -140 at rest, so the keyform
  is -149, not -9. `inspect` shows the torso top rising from 330 to about 321 at `Breath=1`,
  which is why the head moves 9 px.
- A key with only `at` is the rest keyform (all offsets zero).
- `inOutSine` on every key plus the same value at `t=0` and `t=duration` gives a seamless loop.

## 5. Hair physics: pendulum → parameter → warp

`BodyX` sways the whole character (bone `root.x`). A physics pendulum feels that motion and writes
its swing angle into `HairSway`, which bends `hairWarp` with sparse offsets (only the middle and
bottom rows move, the top stays on the head).

<!-- check:ops name=hair-physics -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "BodyX", "min": -1, "max": 1, "group": "Body" } },
  { "op": "add", "kind": "parameter", "value": { "id": "HairSway", "min": -30, "max": 30, "group": "Hair" } },
  { "op": "bind", "target": "bone:root.x", "params": ["BodyX"], "keys": [{ "at": [-1], "value": 206 }, { "at": [1], "value": 306 }] },
  { "op": "add", "kind": "warp", "value": { "id": "hairWarp", "parent": "head", "rect": [140, 100, 232, 270], "cols": 2, "rows": 2 } },
  { "op": "update", "kind": "part", "id": "hairBack", "set": { "parent": "hairWarp", "shape.detail": 16 } },
  { "op": "bind", "target": "warp:hairWarp.offsets", "params": ["HairSway"], "keys": [
      { "at": [-30], "value": { "3": [12, 0], "4": [12, 0], "5": [12, 0], "6": [34, -6], "7": [34, -6], "8": [34, -6] } },
      { "at": [0], "value": {} },
      { "at": [30], "value": { "3": [-12, 0], "4": [-12, 0], "5": [-12, 0], "6": [-34, -6], "7": [-34, -6], "8": [-34, -6] } } ] },
  { "op": "add", "kind": "physics", "value": { "id": "hairPhysics",
      "inputs": [{ "param": "BodyX", "type": "x", "weight": 50 }],
      "outputs": [{ "param": "HairSway", "type": "angle", "scale": 1 }],
      "segments": [{ "length": 120 }], "damping": 0.12 } },
  { "op": "key", "animation": "sway", "target": "param:BodyX", "t": 0, "v": -1, "ease": "inOutSine", "duration": 2 },
  { "op": "key", "animation": "sway", "target": "param:BodyX", "t": 1, "v": 1, "ease": "inOutSine" },
  { "op": "key", "animation": "sway", "target": "param:BodyX", "t": 2, "v": -1 }
]
```

<!-- check:run chain=hair-physics -->
```sh
rev2d sheet hero.r2d.json -o out/sway.png --anim sway --frames 8 --columns 4 --scale 0.4
rev2d sheet hero.r2d.json -o out/hair-range.png --sweep HairSway=-30,0,30 --overlay warps --scale 0.4
rev2d inspect hero.r2d.json --anim sway --time 0.75 --warp hairWarp
```

- Physics starts **at rest** and steps at a fixed 60 Hz, so it only moves when its inputs change
  over time. A single `render --param BodyX=1` shows no swing; verify with an animation
  (`--anim sway`). A single pose simulates from rest over at most the 60 s before `--time`.
- **Explicit values beat physics.** The `HairSway` sweep above sets the output parameter
  explicitly, so every cell shows exactly the swept value and the binding can be checked alone (no
  `--no-physics` needed). The same holds for `--param HairSway=10`, MCP `params` and a pinned
  editor slider; `inspect` then lists the output as `overridden`.
- Input `x` moves the pendulum pivot by `value × weight` px. `weight: 50` matches the 50 px that
  `BodyX = 1` moves the body.
- Output `angle` is the swing in degrees, clockwise-positive from hanging straight down. When the
  body moves right, the bob lags to the left, which is a **positive** angle, so the keyform at +30
  moves the hair's lower rows to the left (negative x).
- Outputs are clamped to the parameter range. The `sway` sheet prints
  `note: physics "hairPhysics": HairSway clamped in 1 of 8 frames; raw output up to 30.702 ...`:
  that is the first swing from rest. `rev2d analyze hero.r2d.json --anim sway --warmup 10` shows
  that the steady state never clamps (peak raw 24.5); [recipe 20](#20-physics-tuning-with-analyze-and-seamless-loops)
  tunes a group that does.
- Physics writes its output parameters every frame: do not animate `HairSway` (the validator
  warns with `physics-output-animated`), and do not use it as an input of the same group.
- Sparse offsets `{"6": [dx, dy]}` list only moved lattice points; `{}` is the rest keyform.
  Points are row-major: index = `row * (cols + 1) + col`.

## 6. Arm IK: two-bone constraint + target bone

A two-bone arm reaches for `handTargetL`, which `ReachX` / `ReachY` move. Bones are placed with
`"world"` (the op converts to local coordinates for you); plates are drawn in setup space over the
bones and parented to them rigidly.

<!-- check:ops name=arm-ik -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "ReachX", "min": -1, "max": 1, "group": "Arm" } },
  { "op": "add", "kind": "parameter", "value": { "id": "ReachY", "min": 0, "max": 1, "group": "Arm" } },
  { "op": "add", "kind": "bone", "value": { "id": "upperArmL", "parent": "body", "world": [326, 350], "rotation": 80, "length": 75 } },
  { "op": "add", "kind": "bone", "value": { "id": "foreArmL", "parent": "upperArmL", "x": 75, "rotation": 20, "length": 75 } },
  { "op": "add", "kind": "bone", "value": { "id": "handTargetL", "parent": "root", "world": [326, 497.7] } },
  { "op": "add", "kind": "part", "value": { "id": "upperArmPlateL", "parent": "upperArmL",
      "shape": { "type": "ellipse", "cx": 332.5, "cy": 386.9, "rx": 46, "ry": 12, "rotation": 80 }, "fill": "#3d5d8f", "z": 6 } },
  { "op": "add", "kind": "part", "value": { "id": "foreArmPlateL", "parent": "foreArmL",
      "shape": { "type": "ellipse", "cx": 332.5, "cy": 460.8, "rx": 44, "ry": 10, "rotation": 100 }, "fill": "#f2c9a0", "z": 6 } },
  { "op": "add", "kind": "part", "value": { "id": "handL", "parent": "foreArmL",
      "shape": { "type": "ellipse", "cx": 326, "cy": 497.7, "rx": 13, "ry": 13 }, "fill": "#f2c9a0", "z": 7 } },
  { "op": "add", "kind": "ik", "value": { "id": "armIkL", "bones": ["upperArmL", "foreArmL"], "target": "handTargetL" } },
  { "op": "bind", "target": "bone:handTargetL.x", "params": ["ReachX"], "keys": [{ "at": [-1], "value": 20 }, { "at": [0], "value": 70 }, { "at": [1], "value": 190 }] },
  { "op": "bind", "target": "bone:handTargetL.y", "params": ["ReachY"], "keys": [{ "at": [0], "value": -2.3 }, { "at": [1], "value": -160 }] }
]
```

<!-- check:run chain=arm-ik -->
```sh
rev2d inspect hero.r2d.json --bone upperArmL,foreArmL,handTargetL
rev2d sheet hero.r2d.json -o out/reach.png --sweep ReachX=-1,0,1 --sweep ReachY=0,0.5,1 --overlay bones --scale 0.4
rev2d inspect hero.r2d.json --param ReachX=1,ReachY=0 --bone upperArmL,foreArmL
```

- The geometry: shoulder (326, 350), upper arm 75 px at 80° → elbow ≈ (339.0, 423.9); forearm
  turned +20° → 100° world → wrist ≈ (326, 497.7). The target sits on the wrist, so at rest the IK
  reproduces the setup pose (`inspect`: `upperArmL` ≈ 80°, `foreArmL` ≈ 20° local).
- The `add` messages print each bone's local and world position (`at local (70, -2.3) (world 326,
  497.7)`). Binding values for `handTargetL.x/y` are **local** to `root`, so rest = 70 / -2.3.
- IK bones: `[parent, child]`, the child a direct child of the parent. The first segment is the
  distance parent joint → child joint, the second is `child.length`. `bendPositive` (default true)
  picks the elbow side; flip it if the elbow bends the wrong way. `mix` 0..1 blends the IK in and
  can itself be bound (`ik:armIkL.mix`).
- The target must not be a chain bone or a descendant of one (`ik-target-in-chain`): parent it to
  something that does not move with the arm (here `root`).
- Out of reach (`ReachX=1, ReachY=0`), the arm straightens and points at the target. The sheet
  says so: `note: IK "armIkL": target out of reach in 2 of 9 frames; extension up to 1.269, the
  chain tip misses the target by up to 40.3 px and the chain snaps straight`, and `inspect` has an
  `IK` section (`reached NO, extension 1.269 !, error 40.3, bend 180°`). Fixes: move the target
  closer, lengthen the bones, or add `"stretch": true` (the bones scale along their length to
  reach). A chain that gets **nearly** straight (extension > 0.98) snaps visibly as it straightens:
  `"softness"` (px) eases the last stretch ([recipe 19](#19-walk-cycle-smooth-keys-track-offset-soft-ik)).

## 7. Skinned limb: one mesh, two bones

One rounded rect bends smoothly at the elbow because each vertex blends the two arm bones
(`skin`, automatic weights from the distance to each bone segment). `ArmRRaise` swings the arm
out and bends the forearm up.

<!-- check:ops name=skinned-limb -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "ArmRRaise", "min": 0, "max": 1, "group": "Arm" } },
  { "op": "add", "kind": "bone", "value": { "id": "upperArmR", "parent": "body", "world": [186, 350], "rotation": 90, "length": 75 } },
  { "op": "add", "kind": "bone", "value": { "id": "foreArmR", "parent": "upperArmR", "x": 75, "length": 75 } },
  { "op": "add", "kind": "part", "value": { "id": "armR",
      "shape": { "type": "rect", "x": 173, "y": 338, "w": 26, "h": 172, "radius": 13, "detail": 8 },
      "fill": "#f2c9a0", "stroke": { "color": "#8a5a3c", "width": 2 },
      "skin": { "bones": ["upperArmR", "foreArmR"], "weights": "auto" }, "z": 6 } },
  { "op": "bind", "target": "bone:upperArmR.rotation", "params": ["ArmRRaise"], "keys": [{ "at": [0], "value": 90 }, { "at": [1], "value": 165 }] },
  { "op": "bind", "target": "bone:foreArmR.rotation", "params": ["ArmRRaise"], "keys": [{ "at": [0], "value": 0 }, { "at": [1], "value": 80 }] }
]
```

<!-- check:run chain=skinned-limb -->
```sh
rev2d sheet hero.r2d.json -o out/raise.png --sweep ArmRRaise=0:1:4 --overlay bones --viewbox 0,200,340,312 --scale 0.6
rev2d sheet hero.r2d.json -o out/raise-mesh.png --sweep ArmRRaise=0,1 --overlay mesh --viewbox 0,200,340,312 --scale 0.6
```

- A skinned part has **no `parent`** (`skin-with-parent` is an error): the skin bones move it.
- `detail` is essential: the vertices must be dense along the arm, or there is nothing to bend.
  Check the triangles with `--overlay mesh`.
- `rotation: 90` points the bone down (+y); a positive rotation turns it clockwise, so the arm on
  the screen's left swings out and up.
- `"falloff"` (default 2) sharpens or softens the auto-weight transition at the joint. Explicit
  per-vertex `weights` work for `mesh` shapes.

## 8. Squash & stretch and a one-shot hop

`Squash` scales the `root` bone, which sits on the ground, so the character squashes onto the floor
(and stretches up), roughly preserving area. `Jump` lifts `root`. The `hop` animation is added in one
`add` op with complete tracks: anticipation, stretch on take-off, apex, impact squash, settle.

<!-- check:ops name=squash -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "Squash", "min": -1, "max": 1, "group": "Body" } },
  { "op": "add", "kind": "parameter", "value": { "id": "Jump", "min": 0, "max": 1, "group": "Body" } },
  { "op": "bind", "target": "bone:root.scaleX", "params": ["Squash"], "keys": [{ "at": [-1], "value": 0.88 }, { "at": [0], "value": 1 }, { "at": [1], "value": 1.2 }] },
  { "op": "bind", "target": "bone:root.scaleY", "params": ["Squash"], "keys": [{ "at": [-1], "value": 1.15 }, { "at": [0], "value": 1 }, { "at": [1], "value": 0.8 }] },
  { "op": "bind", "target": "bone:root.y", "params": ["Jump"], "keys": [{ "at": [0], "value": 500 }, { "at": [1], "value": 380 }] },
  { "op": "add", "kind": "animation", "value": { "id": "hop", "duration": 1.2, "loop": false, "tracks": [
      { "target": "param:Squash", "keys": [
          { "t": 0, "v": 0, "ease": "outQuad" }, { "t": 0.15, "v": 1, "ease": "inQuad" }, { "t": 0.3, "v": -1, "ease": "outQuad" },
          { "t": 0.55, "v": 0, "ease": "inQuad" }, { "t": 0.8, "v": -0.6 }, { "t": 0.86, "v": 1, "ease": "outBack" }, { "t": 1.2, "v": 0 } ] },
      { "target": "param:Jump", "keys": [
          { "t": 0, "v": 0 }, { "t": 0.2, "v": 0, "ease": "outQuad" }, { "t": 0.55, "v": 1, "ease": "inQuad" }, { "t": 0.86, "v": 0 } ] } ] } }
]
```

<!-- check:run chain=squash -->
```sh
rev2d sheet hero.r2d.json -o out/hop.png --anim hop --frames 9 --columns 9 --viewbox fit --scale 0.3
rev2d gif hero.r2d.json -o out/hop.gif --anim hop --viewbox fit --scale 0.5
```

- Scaling a bone scales everything below it about the bone's joint. Put the joint where the
  squash should be anchored (feet on the floor, or a slime's base).
- Several bindings may target the same property (e.g. a second `Squash` warp binding plus this
  bone binding); their deltas from the setup value add up.
- `"loop": false` clamps time to `[0, duration]`; before the first key the first value holds, after
  the last key the last value holds.
- A complete `add` of an animation is often shorter than many `key` ops; use `key` for small edits
  to existing animations.

## 9. Draw-order swap: step binding on z

A moon orbits the head: behind it for the first half of `Orbit`, in front for the second half.
Position is two linear bindings; the draw order is a **step** binding on `part:moon.z`.

<!-- check:ops name=draw-order -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "Orbit", "min": 0, "max": 1, "group": "Props" } },
  { "op": "add", "kind": "part", "value": { "id": "moon", "shape": { "type": "ellipse", "cx": 110, "cy": 250, "rx": 22, "ry": 22 },
      "fill": { "type": "radial", "center": [104, 244], "radius": 26, "stops": [[0, "#fff6c8"], [1, "#e0b84a"]] }, "z": -1 } },
  { "op": "bind", "target": "part:moon.shape.cx", "params": ["Orbit"], "keys": [
      { "at": [0], "value": 110 }, { "at": [0.25], "value": 256 }, { "at": [0.5], "value": 402 }, { "at": [0.75], "value": 256 }, { "at": [1], "value": 110 } ] },
  { "op": "bind", "target": "part:moon.shape.cy", "params": ["Orbit"], "keys": [
      { "at": [0], "value": 250 }, { "at": [0.25], "value": 200 }, { "at": [0.5], "value": 250 }, { "at": [0.75], "value": 300 }, { "at": [1], "value": 250 } ] },
  { "op": "bind", "target": "part:moon.z", "params": ["Orbit"], "interpolation": "step", "keys": [
      { "at": [0], "value": -1 }, { "at": [0.5], "value": 10 }, { "at": [1], "value": 10 } ] },
  { "op": "key", "animation": "orbit", "target": "param:Orbit", "t": 0, "v": 0, "duration": 2 },
  { "op": "key", "animation": "orbit", "target": "param:Orbit", "t": 2, "v": 1 }
]
```

<!-- check:run chain=draw-order -->
```sh
rev2d sheet hero.r2d.json -o out/orbit.png --anim orbit --frames 8 --columns 4 --scale 0.3
rev2d inspect hero.r2d.json --param Orbit=0.6 --part moon
```

- Parts draw sorted by `(z, array index)`; `z` is bindable and animatable. `inspect` prints the
  final `DRAW ORDER`, so you can assert it without looking.
- `"interpolation": "step"` holds the lower keyform: z stays -1 up to `Orbit = 0.5`, then jumps
  to 10. With linear interpolation, z would pass through intermediate values and the swap point
  would depend on the other parts' z values.
- The typical use: a far arm or side hair that goes behind the body when the character turns
  (bind its `z` to `AngleX` with step interpolation).

## 10. Glow and blush: blend modes

An `add`-blended aura brightens what is behind the character, and `multiply`-blended cheeks tint
the skin without covering it. Both fade in with `Glow`; `pulse` animates it.

<!-- check:ops name=glow -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "Glow", "min": 0, "max": 1, "group": "Effects" } },
  { "op": "add", "kind": "part", "value": { "id": "aura", "parent": "body",
      "shape": { "type": "ellipse", "cx": 256, "cy": 300, "rx": 210, "ry": 210, "detail": 16 },
      "fill": { "type": "radial", "center": [256, 300], "radius": 210, "stops": [[0, "#ffcf6a"], [0.6, "#ff9a3c80"], [1, "#ff9a3c00"]] },
      "blend": "add", "opacity": 0, "z": -1 } },
  { "op": "add", "kind": "part", "value": { "id": "blushL", "parent": "head",
      "shape": { "type": "ellipse", "cx": 300, "cy": 258, "rx": 20, "ry": 10, "detail": 4 },
      "fill": { "type": "radial", "center": [300, 258], "radius": 20, "stops": [[0, "#ff7a7a"], [1, "#ff7a7a00"]] },
      "blend": "multiply", "opacity": 0, "z": 3 } },
  { "op": "add", "kind": "part", "value": { "id": "blushR", "parent": "head",
      "shape": { "type": "ellipse", "cx": 212, "cy": 258, "rx": 20, "ry": 10, "detail": 4 },
      "fill": { "type": "radial", "center": [212, 258], "radius": 20, "stops": [[0, "#ff7a7a"], [1, "#ff7a7a00"]] },
      "blend": "multiply", "opacity": 0, "z": 3 } },
  { "op": "bind", "target": "part:aura.opacity", "params": ["Glow"], "keys": [{ "at": [0], "value": 0 }, { "at": [1], "value": 1 }] },
  { "op": "bind", "target": "part:blushL.opacity", "params": ["Glow"], "keys": [{ "at": [0], "value": 0 }, { "at": [1], "value": 1 }] },
  { "op": "bind", "target": "part:blushR.opacity", "params": ["Glow"], "keys": [{ "at": [0], "value": 0 }, { "at": [1], "value": 1 }] },
  { "op": "key", "animation": "pulse", "target": "param:Glow", "t": 0, "v": 0.3, "ease": "inOutSine", "duration": 1.6 },
  { "op": "key", "animation": "pulse", "target": "param:Glow", "t": 0.8, "v": 1, "ease": "inOutSine" },
  { "op": "key", "animation": "pulse", "target": "param:Glow", "t": 1.6, "v": 0.3 }
]
```

<!-- check:run chain=glow -->
```sh
rev2d sheet hero.r2d.json -o out/glow.png --sweep Glow=0,0.5,1 --scale 0.5
```

- Blend modes: `normal`, `add` (lightens, good for glows and sparkles), `multiply` (darkens, good for
  shadows and blush), `screen` (soft lightening, good for sheens). `blend` is a setup field (set it
  with `update`), not bindable; fade the effect with an opacity binding instead.
- Setup `opacity` is 0 because the keyform at the default (`Glow = 0`) is 0.
- Gradients are evaluated **per vertex**: give gradient-filled parts a `detail` so the gradient has
  vertices to vary across. End a glow gradient at a fully transparent stop (`#rrggbb00`) and make the
  shape as large as the gradient radius, or its edge shows.
- `multiply` over a dark background is almost invisible; use it over lighter parts.

## 11. Textured parts: atlas crop in a warp, textured mesh

Bitmaps come from PNG textures. An `image` shape shows a crop of the texture as a `cols × rows`
grid, so a warp can bend it; a `mesh` shape maps any triangles onto the texture with `uvs`.

Put a PNG next to the model. To follow along, copy the atlas shipped with the textured example
(256×192: a red carp in the top half, a blue one in the bottom half):
`cp <Rev2D>/examples/textured/koi-atlas.png .`

<!-- check:ops name=textured -->
```json
[
  { "op": "add", "kind": "texture", "value": { "id": "koi", "path": "koi-atlas.png" } },
  { "op": "add", "kind": "parameter", "value": { "id": "Wave", "min": -1, "max": 1, "group": "Props" } },
  { "op": "add", "kind": "warp", "value": { "id": "flagWarp", "rect": [10, 20, 170, 70], "cols": 6, "rows": 1 } },
  { "op": "add", "kind": "part", "value": { "id": "flagRed", "parent": "flagWarp",
      "shape": { "type": "image", "texture": "koi", "crop": [0, 0, 256, 96], "x": 14, "y": 24, "w": 160, "h": 60, "cols": 12, "rows": 3 }, "z": 8 } },
  { "op": "bind", "target": "warp:flagWarp.offsets", "params": ["Wave"], "keys": [
      { "at": [-1], "value": { "1": [0, 4], "2": [0, 7], "3": [0, 3], "4": [0, -5], "5": [0, -9], "6": [0, -6],
                               "8": [0, 4], "9": [0, 7], "10": [0, 3], "11": [0, -5], "12": [0, -9], "13": [0, -6] } },
      { "at": [0], "value": {} },
      { "at": [1], "value": { "1": [0, -4], "2": [0, -7], "3": [0, -3], "4": [0, 5], "5": [0, 9], "6": [0, 6],
                              "8": [0, -4], "9": [0, -7], "10": [0, -3], "11": [0, 5], "12": [0, 9], "13": [0, 6] } } ] },
  { "op": "add", "kind": "part", "value": { "id": "flagBlue",
      "shape": { "type": "mesh", "texture": "koi",
                 "vertices": [340, 24, 500, 24, 500, 84, 340, 84],
                 "triangles": [0, 1, 2, 0, 2, 3],
                 "uvs": [0, 0.5, 1, 0.5, 1, 1, 0, 1] }, "z": 8 } },
  { "op": "key", "animation": "flutter", "target": "param:Wave", "t": 0, "v": -1, "ease": "inOutSine", "duration": 1 },
  { "op": "key", "animation": "flutter", "target": "param:Wave", "t": 0.5, "v": 1, "ease": "inOutSine" },
  { "op": "key", "animation": "flutter", "target": "param:Wave", "t": 1, "v": -1 }
]
```

<!-- check:run chain=textured -->
```sh
rev2d validate hero.r2d.json
rev2d sheet hero.r2d.json -o out/flags.png --sweep Wave=-1,0,1 --viewbox 0,0,512,110 --scale 0.8 --overlay warps
```

- Texture `path` is relative to the **model file** (or a `data:image/png;base64,...` URI). The
  loader reads the size; `rev2d validate` reports a missing or undecodable PNG (`texture-load`).
  `rev2d ops -o other/dir/x.r2d.json` warns when relative texture paths stop resolving.
- `crop` is `[sx, sy, sw, sh]` in texture pixels; `w`/`h` default to the crop size. `cols`/`rows`
  subdivide the quad: without them, a warp can only move its four corners.
- `uvs` are 0..1 across the whole texture, one pair per vertex, in `vertices` order (v = 0 is the
  top). Mesh vertices are bindable as a point list: `part:flagBlue.shape.vertices`.
- The part `fill` defaults to white, so the texture shows unchanged; `tint` multiplies it.
- Masks respect texture alpha: a part masked by a textured part is clipped to the opaque pixels
  (`examples/textured`, `sheen`).

## 12. Layered animations: idle + blink

Builds on [4. Breathing](#4-breathing-warp-scale--bone-offset) (`idle`, 3 s) and
[2. Eye blink](#2-eye-blink-shape-binding--mask) (`blink`, 4 s). Keep independent motions in
separate animations and play them as layers: the different lengths keep the loop from looking
mechanical, and each animation stays simple to edit. No new ops are needed.

<!-- check:run chain=breathing,blink -->
```sh
rev2d render hero.r2d.json -o out/both.png --anim idle --anim blink --time 3.82 --viewbox fit
rev2d inspect hero.r2d.json --anim idle --anim blink@0.5 --time 3.82 --part eyeWhiteL
rev2d sheet hero.r2d.json -o out/layers.png --anim blink --anim idle --frames 16 --columns 8 --viewbox 150,100,212,420 --scale 0.35
rev2d gif hero.r2d.json -o out/layers.gif --anim blink --anim idle --fps 20 --viewbox fit --scale 0.5
```

- `--anim a --anim b` plays both at `--time`; each layer wraps its own time when it loops.
  `id@weight` blends a layer partially. MCP: `animations: ["idle", "blink@0.5"]`; editor:
  `rev2d editor command --anims idle,blink`.
- `param:` tracks blend layer by layer toward each layer's value, `p = p + weight × (v − p)`, so a
  later layer wins where both animate the same parameter. With `blink@0.5` at the blink moment,
  `EyeOpen` = 1 + 0.5 × (0 − 1) = 0.5 (`inspect` shows `ry` 6.5). Other tracks add their deltas.
- Layer options (comma after the id): `add` adds the layer's offset from the parameter default
  instead of replacing the value below (a talk nod over a look-around), `once` makes a one-shot
  stop affecting the pose after its end (a wink hands the eye back to the blink), `start=2.5` starts
  the layer at 2.5 s. [Recipe 15](#15-gestures-over-an-idle-add-once-compose) shows each one and
  bakes the stack into one animation with `compose`.
- In `sheet`, `gif` and `frames` the **first** `--anim` is the one sampled (its duration sets the
  time range) and the others are extra layers. Sample the longer animation (`blink`), or a 3 s
  `idle` sheet never reaches the blink at 3.7 s (or pick the window: `--from 3.5 --to 4`).
- Use explicit `--param` values to hold a parameter while animations play: explicit values replace
  animated values **and physics outputs** (SPEC §9).

## 13. Animation events

Builds on [8. Squash & stretch](#8-squash--stretch-and-a-one-shot-hop). Events mark moments in an
animation for the host application (sounds, particles, gameplay). `data` is any JSON.

<!-- check:ops name=events -->
```json
[
  { "op": "update", "kind": "animation", "id": "hop", "set": { "events": [
      { "t": 0.2, "name": "takeoff" },
      { "t": 0.86, "name": "land", "data": { "sfx": "thud.wav", "volume": 0.8 } } ] } }
]
```

<!-- check:run chain=squash,events -->
```sh
rev2d render hero.r2d.json -o out/land.png --anim hop --time 0.86 --json
rev2d inspect hero.r2d.json --anim hop --time 0.2 --bone root --json
rev2d sheet hero.r2d.json -o out/hop-events.png --anim hop --frames 6 --viewbox fit --scale 0.3
rev2d analyze hero.r2d.json --anim hop --no-pixels
```

- A single pose (`render`, `inspect`, MCP `rev2d_render`/`rev2d_inspect`) reports the events
  **exactly at** its time in `events`. Sequential playback (`rig.player()`, the editor,
  `inspect --times` with ascending times) reports every event crossed since the previous frame.
- Animation sheets print the events of each cell's interval `[t, next t)` on a second caption line
  (`takeoff` under `t=0.00s`, `land` under `t=0.72s` here), and `analyze` lists every event with its
  time under `EVENTS`.
- An event after `duration` is a warning (`event-after-duration`), because it never fires.
- To add one event without rewriting the list, use a JSON Patch append:
  `{"op": "patch", "patch": [{"op": "add", "path": "/animations/hop/events/-", "value": {"t": 1.1, "name": "settle"}}]}`
  (the animation must already have an `events` array).

## 14. Closed eyes that stay clean: path-morph eye + lash band

Builds on [1. Head turn](#1-head-turn-anglex--angley-warp-grid) (the eyes sit in `faceWarp`). Each
eye white becomes a path whose lids morph closed with `EyeLOpen` / `EyeROpen`; a lash band (a
filled path along the upper lid) morphs with the same parameter, and the iris is masked by the eye
white. The trick is in the **closed keyform**: the lower lid is lifted **1 px above** the closed
upper-lid line, so the eye white keeps a hairline sliver, and that sliver lies **inside** the closed
lash band.

<!-- check:ops name=eyes -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "EyeLOpen", "min": 0, "max": 1, "default": 1, "group": "Eyes" } },
  { "op": "add", "kind": "parameter", "value": { "id": "EyeROpen", "min": 0, "max": 1, "default": 1, "group": "Eyes" } },
  { "op": "update", "kind": "part", "id": "eyeWhiteL", "set": { "shape": { "type": "path", "detail": 4,
      "d": "M 307 225 C 301 212 279 212 273 225 C 279 236 301 236 307 225 Z" } } },
  { "op": "update", "kind": "part", "id": "eyeWhiteR", "set": { "shape": { "type": "path", "detail": 4,
      "d": "M 239 225 C 233 212 211 212 205 225 C 211 236 233 236 239 225 Z" } } },
  { "op": "update", "kind": "part", "id": "irisL", "set": { "mask": ["eyeWhiteL"] } },
  { "op": "update", "kind": "part", "id": "irisR", "set": { "mask": ["eyeWhiteR"] } },
  { "op": "add", "kind": "part", "value": { "id": "lashL", "parent": "faceWarp", "fill": "#2b1d33", "z": 5, "shape": { "type": "path", "detail": 4,
      "d": "M 308 226 C 301.5 213 278.5 213 272 226 L 271 222 C 278 207 302 207 309 222 Z" } } },
  { "op": "add", "kind": "part", "value": { "id": "lashR", "parent": "faceWarp", "fill": "#2b1d33", "z": 5, "shape": { "type": "path", "detail": 4,
      "d": "M 240 226 C 233.5 213 210.5 213 204 226 L 203 222 C 210 207 234 207 241 222 Z" } } },
  { "op": "bind", "target": "part:eyeWhiteL.shape.d", "params": ["EyeLOpen"], "keys": [
      { "at": [0], "value": "M 307 225 C 301 230 279 230 273 225 C 279 229 301 229 307 225 Z" },
      { "at": [1], "value": "M 307 225 C 301 212 279 212 273 225 C 279 236 301 236 307 225 Z" } ] },
  { "op": "bind", "target": "part:lashL.shape.d", "params": ["EyeLOpen"], "keys": [
      { "at": [0], "value": "M 308 226 C 301.5 231 278.5 231 272 226 L 271 223 C 278 228 302 228 309 223 Z" },
      { "at": [1], "value": "M 308 226 C 301.5 213 278.5 213 272 226 L 271 222 C 278 207 302 207 309 222 Z" } ] },
  { "op": "bind", "target": "part:eyeWhiteR.shape.d", "params": ["EyeROpen"], "keys": [
      { "at": [0], "value": "M 239 225 C 233 230 211 230 205 225 C 211 229 233 229 239 225 Z" },
      { "at": [1], "value": "M 239 225 C 233 212 211 212 205 225 C 211 236 233 236 239 225 Z" } ] },
  { "op": "bind", "target": "part:lashR.shape.d", "params": ["EyeROpen"], "keys": [
      { "at": [0], "value": "M 240 226 C 233.5 231 210.5 231 204 226 L 203 223 C 210 228 234 228 241 223 Z" },
      { "at": [1], "value": "M 240 226 C 233.5 213 210.5 213 204 226 L 203 222 C 210 207 234 207 241 222 Z" } ] },
  { "op": "add", "kind": "animation", "value": { "id": "blink", "duration": 4, "loop": true, "tracks": [
      { "target": "param:EyeLOpen", "keys": [ { "t": 0, "v": 1 }, { "t": 3.7, "v": 1, "ease": "inQuad" }, { "t": 3.82, "v": 0, "ease": "outQuad" }, { "t": 4, "v": 1 } ] },
      { "target": "param:EyeROpen", "keys": [ { "t": 0, "v": 1 }, { "t": 3.7, "v": 1, "ease": "inQuad" }, { "t": 3.82, "v": 0, "ease": "outQuad" }, { "t": 4, "v": 1 } ] } ] } }
]
```

<!-- check:run chain=head-turn,eyes -->
```sh
rev2d sheet hero.r2d.json -o out/lids.png --sweep EyeLOpen,EyeROpen=0:1:5 --viewbox 196,200,120,40 --scale 3
rev2d render hero.r2d.json -o out/closed.png --param EyeLOpen=0,EyeROpen=0 --viewbox 262,212,56,24 --scale 8
rev2d inspect hero.r2d.json --param EyeLOpen=0 --part eyeWhiteL,lashL
rev2d hit hero.r2d.json 290 228.4 --param EyeLOpen=0
rev2d sheet hero.r2d.json -o out/blink-turned.png --anim blink --from 3.6 --to 4 --frames 5 --columns 5 --param AngleX=30 --viewbox 196,195,150,50 --scale 2
```

What to check: `closed.png` shows only the lash band, with no white or iris line under it.
`inspect --param EyeLOpen=0` puts the eye white at `[273, 225, 34, 3.8]`, inside the lash band's
`[271, 223, 38, 6.8]`, and `hit` at a point of the sliver lists `lashL` first: the band covers it.
`blink-turned.png` shows the lashes turning with the eyes.

- **Why the sliver goes inside the band.** Whatever area the eye white still has is where the
  masked iris can show. Every blink passes through hairline eye whites just before it closes, so
  the lash band must cover a thin strip anyway; the closed keyform decides where that strip ends
  up. With the lower lid lifted *above* the closed lid line, the strip lies under the band at every
  value near 0. With the lower lid *below* the lid line, a line of iris shows under the closed
  lash: try `C 279 232 301 232 307 225` as the closed eye white's lower lid and render
  `closed.png` again.
- **Why the area stays non-zero.** A mask whose parts produce no geometry gives zero coverage:
  Rev2D (CLI, MCP and editor alike) then draws nothing of the masked parts, and a `maskInvert` part
  draws in full (SPEC §3.4). A sliver never depends on that edge case (nor on another renderer or
  exporter that treats an empty mask as "no mask" and would draw the whole iris over the closed
  eye), and `inspect` can still measure it: a zero-area part has no bounds.
- Open and closed keyforms of one path need the same commands (`M C C Z` for the eye white,
  `M C L C Z` for the band). Write both from one template and change only the numbers.
- The band's lower edge sits 1 px below the eye white's upper lid in both keyforms, so no skin
  shows between lash and white while the eye closes.
- The lashes are parented to `faceWarp` like the eyes (with `detail`, so the warp can bend them). A
  part added to a rig later has to join the deformer its neighbours are in, or it stays behind
  when the head turns.
- `EyeLOpen` / `EyeROpen` default to 1 and their keyforms at 1 equal the setup paths, so the rest
  pose is unchanged. `blink` closes both eyes; a wink animates one of them
  ([recipe 15](#15-gestures-over-an-idle-add-once-compose)).

## 15. Gestures over an idle: add, once, compose

Builds on 1, 3 and 14 (`AngleX`/`AngleY`, `MouthOpen`/`MouthForm`, `EyeLOpen` and `blink`). Three
simple animations: `look_around` (4 s loop, `smooth` keys on `AngleX` and `AngleY`), `talk` (1 s
loop: `MouthOpen` plus a small nod on `AngleY` around its default 0) and `wink` (a 0.6 s one-shot on
`EyeLOpen` and `MouthForm`). Layer options decide how they combine, and `compose` bakes a stack into
one animation for players that play one clip at a time.

<!-- check:ops name=gestures -->
```json
[
  { "op": "update", "kind": "part", "id": "tongue", "set": { "parent": "faceWarp", "shape.detail": 6 } },
  { "op": "add", "kind": "animation", "value": { "id": "look_around", "duration": 4, "loop": true, "tracks": [
      { "target": "param:AngleX", "keys": [ { "t": 0, "v": 0, "ease": "smooth" }, { "t": 1, "v": 20, "ease": "smooth" }, { "t": 2, "v": 0, "ease": "smooth" },
                                           { "t": 3, "v": -20, "ease": "smooth" }, { "t": 4, "v": 0 } ] },
      { "target": "param:AngleY", "keys": [ { "t": 0, "v": 0, "ease": "smooth" }, { "t": 1, "v": 12, "ease": "smooth" }, { "t": 2.5, "v": -8, "ease": "smooth" }, { "t": 4, "v": 0 } ] } ] } },
  { "op": "add", "kind": "animation", "value": { "id": "talk", "duration": 1, "loop": true, "tracks": [
      { "target": "param:MouthOpen", "keys": [ { "t": 0, "v": 0 }, { "t": 0.15, "v": 0.8 }, { "t": 0.3, "v": 0.2 }, { "t": 0.5, "v": 0.9 }, { "t": 0.75, "v": 0.1 }, { "t": 1, "v": 0 } ] },
      { "target": "param:AngleY", "keys": [ { "t": 0, "v": 0, "ease": "inOutSine" }, { "t": 0.25, "v": -4, "ease": "inOutSine" }, { "t": 0.5, "v": 0, "ease": "inOutSine" },
                                           { "t": 0.75, "v": -4, "ease": "inOutSine" }, { "t": 1, "v": 0 } ] } ] } },
  { "op": "add", "kind": "animation", "value": { "id": "wink", "duration": 0.6, "loop": false, "tracks": [
      { "target": "param:EyeLOpen", "keys": [ { "t": 0, "v": 1, "ease": "inQuad" }, { "t": 0.12, "v": 0 }, { "t": 0.4, "v": 0, "ease": "outQuad" }, { "t": 0.6, "v": 1 } ] },
      { "target": "param:MouthForm", "keys": [ { "t": 0, "v": 0, "ease": "outQuad" }, { "t": 0.15, "v": 1 }, { "t": 0.45, "v": 1, "ease": "inOutSine" }, { "t": 0.6, "v": 0 } ] } ] } },
  { "op": "compose", "id": "chatter", "loop": true, "fps": 100, "layers": [
      "look_around", "blink", { "animation": "talk", "mode": "add" }, { "animation": "wink", "start": 1.5, "hold": false } ] }
]
```

<!-- check:run chain=head-turn,mouth,eyes,gestures -->
```sh
rev2d inspect hero.r2d.json --anim look_around --anim talk --times 0:1:5 --track param:AngleY,param:MouthOpen
rev2d inspect hero.r2d.json --anim look_around --anim talk,add --times 0:1:5 --track param:AngleY,param:MouthOpen
rev2d inspect hero.r2d.json --anim look_around --anim blink --anim wink,start=1.5 --times 1.6,3.82 --track param:EyeLOpen,param:EyeROpen
rev2d inspect hero.r2d.json --anim look_around --anim blink --anim wink,once,start=1.5 --times 1.6,3.82 --track param:EyeLOpen,param:EyeROpen
rev2d sheet hero.r2d.json -o out/chatter.png --anim look_around --anim blink --anim talk,add --anim wink,once,start=1.5 --times 0.5,1.2,1.62,2.5,3.2,3.82 --columns 6 --viewbox 130,90,252,290 --scale 0.6
rev2d inspect hero.r2d.json --anim chatter --times 0:4:9 --track param:AngleY,param:EyeLOpen,param:MouthOpen
rev2d analyze hero.r2d.json --anim chatter --no-pixels
```

The first two tables differ only in the mode of `talk`:

```text
--anim look_around --anim talk          --anim look_around --anim talk,add
t     param:AngleY  param:MouthOpen     t     param:AngleY  param:MouthOpen
0.5   0             0.9                 0.5   7.4           0.9
1     0             0                   1     12            0
```

- **`override`** (the default) blends each `param:` track toward its value, so talk's `AngleY`
  replaces look_around's and the head stops looking up while it talks. **`add`** adds
  `weight × (value − default)` to the value below: look_around's 12 plus talk's nod. Author
  additive animations around the parameter default (a key at the default adds nothing).
- **`once`**: a non-looping layer **holds** its first/last keys outside its window by default, so
  `wink,start=1.5` keeps `EyeLOpen` at 1 long after the wink, and the `blink` loop at 3.82 s closes
  only the right eye (`EyeLOpen 1, EyeROpen 0`). With `once` (object form `"hold": false`) the layer
  contributes nothing outside `[start, start + duration]` and both eyes blink (`0, 0`).
- **`start=1.5`** shifts the layer's clock (layer time = time − 1.5); `time=0.2` pins a layer to a
  fixed local time instead. A **looping** layer with a `start` plays before it too (phase-shifted);
  add `once` to keep it silent until then (`talk,add,once,start=2` starts talking at 2 s).
- **`compose`** bakes the stack into `chatter`, a 4 s loop that plays the same on its own: its
  table equals the layered one at every time. The message says which tracks were copied exactly
  (`param:AngleX`, `param:EyeROpen`, `param:MouthForm`) and which were sampled, and why
  (`param:AngleY: look_around + talk → 401 keys`). The result loops only when every layer loops,
  so pass `"loop": true` when a one-shot layer sits inside a loop.
- **Read the compose message.** At the default 60 fps it warns: `WARNING: 2 source times of the
  baked tracks fall between the 60 fps bake samples, so the baked keys can miss the values there:
  1.62 s ("wink" key), 3.82 s ("blink" key); "fps": 100 puts a sample on each`. A baked track only
  has keys at the samples, so the closed-eye keys would be cut short; the batch passes the
  suggested `"fps": 100`, and the message then lists the baked tracks without a warning.
- `sheet --times` picks exact moments (the wink at 1.62 s, the blink at 3.82 s); the title lists
  the layers with their options (`look_around + blink + talk(add) + wink(once, start 1.5s)`).
- The first op moves the tongue from recipe 3 into `faceWarp`: after recipe 1 the mouth turns with
  that warp, and a masked part should follow the same deformer as its mask.
- MCP: `animations: ["look_around", "blink", "talk,add", "wink,once,start=1.5"]`, or objects
  `{id, weight?, mode?, start?, hold?, time?}`.

## 16. Rigid accessory on a turning head (hat)

Builds on 1. A hat has to follow the head turn without bending like the face. Two options:

- **Rigid**: parent the parts to the `head` bone. They follow tilt, breathing and body motion, but
  not the warp turn, so the hat slides across a turning head.
- **Own coarse lattice** (below): a 2×1 `hatWarp` parented to the `head` bone, with keyforms that
  reproduce the motion of `headWarp` where the hat sits. The `follow` op generates them, so the hat
  moves with the head and keeps its shape; a small `bind_warp` yaw adds a little perspective.

First measure where the brim's contact points go when the head turns:

<!-- check:run chain=head-turn -->
```sh
rev2d inspect hero.r2d.json --param AngleX=30 --point 256,121@headWarp --point 190,124@headWarp --point 322,124@headWarp
rev2d inspect hero.r2d.json --param AngleY=30 --point 256,121@headWarp --point 190,124@headWarp --point 322,124@headWarp
```

`--point x,y@headWarp` maps a setup-space point through the posed lattice exactly as a part vertex
in that warp moves. At `AngleX=30` the brim center (256, 121) goes to (275.4, 121) and the sides to
(205.0, 124) and (335.0, 124): the center moves 19.4 px, the sides 13-15 px (the head's far side
compresses in perspective). At `AngleY=30` everything rises 6.0-6.6 px, at `AngleY=-30` it sinks
8.3-8.7 px. `follow` takes this measurement at every keyform of the head turn and moves the hat's
lattice rigidly so the brim center (the anchor, `at`) stays on its spot. A `bind_warp` yaw of ±6
before it turns the hat a little, so its sides move less than its center, like the head's:

<!-- check:ops name=hat -->
```json
[
  { "op": "add", "kind": "warp", "value": { "id": "hatWarp", "parent": "head", "rect": [176, 56, 160, 80], "cols": 2, "rows": 1 } },
  { "op": "add", "kind": "part", "value": { "id": "hatCrown", "parent": "hatWarp", "z": 6,
      "shape": { "type": "path", "d": "M 202 120 C 202 64 310 64 310 120 Z", "detail": 8 },
      "fill": "#b8304a", "stroke": { "color": "#5e1224", "width": 2 } } },
  { "op": "add", "kind": "part", "value": { "id": "hatBrim", "parent": "hatWarp", "z": 6,
      "shape": { "type": "ellipse", "cx": 256, "cy": 121, "rx": 76, "ry": 9, "detail": 6 },
      "fill": "#8a1e34", "stroke": { "color": "#5e1224", "width": 2 } } },
  { "op": "bind_warp", "warp": "hatWarp", "params": ["AngleX"], "keys": [
      { "at": [-30], "yaw": -6 }, { "at": [0] }, { "at": [30], "yaw": 6 } ] },
  { "op": "follow", "warp": "hatWarp", "follow": "headWarp", "at": [256, 121] }
]
```

<!-- check:run chain=head-turn,hat -->
```sh
rev2d inspect hero.r2d.json --param AngleX=30,AngleY=30 --point 256,121@headWarp --point 256,121@hatWarp --point 190,124@headWarp --point 190,124@hatWarp
rev2d sheet hero.r2d.json -o out/hat-turn.png --sweep AngleX=-30,0,30 --sweep AngleY=30,0,-30 --viewbox 120,40,272,330 --scale 0.6
rev2d render hero.r2d.json -o out/hat-rig.png --param AngleX=30 --overlay warps --only hatWarp,headWarp --viewbox 120,40,272,330 --scale 1.5
```

What to check: the `follow` message ends in `max residual 0.0001 px at the 9 keyforms, 0.0001 px at
16 grid midpoints`, so the brim center mapped through `headWarp` and through `hatWarp` lands on the
same point in every pose (at `AngleX=30, AngleY=30`: (275.43, 114.96) both), and the brim sides
stay within 1 px of their spots on the head ((205.01, 117.45) vs (204.15, 117.96)).
`--only hatWarp,headWarp` draws just those two lattices.

- **What `follow` does.** Its grid is every keyform of the bindings that move the followed warp
  (here `AngleX × AngleY` at -30, 0, 30: 9 keyforms). At each it poses the rig, maps the anchor
  through `headWarp` (what `inspect --point` shows) and translates the hat's lattice so its anchor
  lands there, on top of the other bindings on the hat (the yaw, which the message lists as kept).
  Run it again after changing the head turn: it replaces its own binding. `"rotate": true` /
  `"scale": true` also follow a tilt or zoom of the surface. Details: [OPS.md](OPS.md#follow).
- **Rigid means only the anchor is exact.** Without the yaw the brim sides are 4.4 and 6.4 px off
  at `AngleX=30`; with it they stay within 1 px.
- **By hand** it takes one `bind_warp` per parameter (the motion is nearly additive) with a
  `translate` tuned against `--point`, e.g. `[11, 0]` at `AngleX=30` and `[0, -6.3]` at
  `AngleY=30`: within 1 px too, but only after a few rounds of measuring.
- **Why not nest `hatWarp` in `headWarp`?** The hat sticks out above the head lattice (y 56 < 100),
  and lattice points outside a warp are extrapolated from its edge cells, so they drift and
  stretch. Validation warns: `warning /warps/2/rect warp-outside-parent warp "hatWarp" rect [176,
  56, 160, 80] extends outside its parent warp "headWarp" rect [140, 100, 232, 270] by 44 px at the
  top; ... → enlarge "headWarp" to cover it ("rect": [140, 56, 232, 314]), shrink this rect to fit
  inside [140, 100, 232, 270], or parent "hatWarp" to bone "head" (which "headWarp" follows)
  instead`. `follow` refuses that setup as well: the accessory must not hang from what it follows.
- Two bindings on one warp (the yaw and the `follow` result) add their offsets, like all bindings
  on one property.
- Glasses, hair clips and earrings work the same way: a small lattice or a bone
  (`{"op": "follow", "bone": "glasses", "follow": "faceWarp", "rotate": true}`) whose motion is
  matched to the deformer under it, checked with `inspect --point`. In code,
  `rig.mapPoint(pose, "headWarp", x, y)` does the same mapping (SPEC §9.1).

## 17. Markings clipped to an outlined part

Stripes, freckles, face paint or a belly patch should stay inside a part: mask them with it. But
the mask is the part's fill **and stroke** coverage, and the markings draw above the part, so where
they cross its edge they paint over its outline. The fix is to move the outline into a stroke-only
copy of the part, drawn above the markings.

<!-- check:ops name=markings -->
```json
[
  { "op": "add", "kind": "part", "after": "face", "value": { "id": "cheekMarks", "parent": "head", "z": 2, "mask": ["face"], "fill": "#b5563f",
      "shape": { "type": "path", "d": "M 158 236 L 206 246 L 158 252 Z M 160 262 L 200 266 L 162 274 Z M 354 236 L 306 246 L 354 252 Z M 352 262 L 312 266 L 350 274 Z" } } },
  { "op": "add", "kind": "part", "after": "cheekMarks", "value": { "id": "faceLine", "parent": "head", "z": 2, "fill": "transparent",
      "shape": { "type": "ellipse", "cx": 256, "cy": 230, "rx": 88, "ry": 100 }, "stroke": { "color": "#8a5a3c", "width": 3 } } },
  { "op": "update", "kind": "part", "id": "face", "set": { "stroke": null } }
]
```

<!-- check:run chain=markings -->
```sh
rev2d render hero.r2d.json -o out/marks.png --viewbox 150,225,60,55 --scale 5
rev2d hit hero.r2d.json 168.5 246
```

- `faceLine` has the same shape and parent as `face`, `"fill": "transparent"` and the stroke. It
  has the same `z` and comes after `cheekMarks` in the array, so it draws on top: `hit` at the edge
  lists `faceLine (stroke)` above `cheekMarks (fill)`.
- Removing the stroke from `face` avoids drawing the line twice and shrinks the mask to the fill;
  the inner half of the centered line stroke then covers the ends of the marks.
- Keep the pair in sync: a new parent (a warp) or a shape binding on `face` needs the same on
  `faceLine`.
- Each subpath of a path is filled separately, so one part holds all four stripes.

## 18. Parameter rigs in pixels and degrees: bind_linear, relative bind

Spine-style rigs often want parameters in real units: `BodyX` moves the body 1 px per unit,
`AngleZ` tilts the head 0.5° per unit. `bind_linear` writes that two-key binding from the current
setup value; `bind` with `"relative": true` takes **offsets** from the setup value instead of
absolute keyforms. Both store ordinary absolute keyforms, so the file reads like any other binding.

<!-- check:ops name=param-rig -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "BodyX", "min": -40, "max": 40, "group": "Body", "description": "px; + moves the character to the screen right" } },
  { "op": "add", "kind": "parameter", "value": { "id": "AngleZ", "min": -30, "max": 30, "group": "Head", "description": "+ tilts the head clockwise" } },
  { "op": "add", "kind": "parameter", "value": { "id": "Shrug", "min": 0, "max": 1, "group": "Body" } },
  { "op": "bind_linear", "target": "bone:root.x", "param": "BodyX", "scale": 1 },
  { "op": "bind_linear", "target": "bone:head.rotation", "param": "AngleZ", "scale": 0.5 },
  { "op": "bind", "target": "bone:head.y", "params": ["Shrug"], "relative": true, "keys": [ { "at": [0], "value": 0 }, { "at": [1], "value": 10 } ] },
  { "op": "bind", "target": "part:torso.shape.w", "params": ["Shrug"], "relative": true, "keys": [ { "at": [0], "value": 0 }, { "at": [1], "value": 16 } ] },
  { "op": "bind", "target": "part:torso.shape.x", "params": ["Shrug"], "relative": true, "keys": [ { "at": [0], "value": 0 }, { "at": [1], "value": -8 } ] }
]
```

<!-- check:run chain=param-rig -->
```sh
rev2d sheet hero.r2d.json -o out/overview.png --overview --steps 3 --scale 0.4
rev2d inspect hero.r2d.json --param BodyX=40,AngleZ=30,Shrug=1 --bone root,head --part torso
```

- The messages state the result: `bone:root.x = 256 + 1 × BodyX (-40 → 216, 40 → 296)` and
  `relative: stored absolute keyforms -140, -130 (setup -140 + offsets)`.
- `bind_linear` keys the parameter's `[min, max]` (or `"at": [lo, hi]`); `scale` is property units
  per parameter unit, negative for the opposite direction. When the parameter's default is not 0
  the rest pose moves, and the message says so.
- `relative` works for numbers, point lists (a sparse offset map stays sparse) and warp offsets;
  colors, paths and booleans are rejected with an absolute example. A later `set` does not move
  the stored keyforms.
- `sheet --overview` renders one row per parameter over its whole range: the fastest check that
  every parameter does what its name says (here `AngleZ=30` tilts the head clockwise, `Shrug=1`
  lowers it 10 px and widens the torso).
- Put the unit in the parameter's `description`: the next agent reads it in `rev2d info`.

## 19. Walk cycle: smooth keys, track offset, soft IK

A side-view walker built from nothing with ops, starting from the `empty` template (format, version
and meta only):

```sh
rev2d new walker.r2d.json --template empty --size 320x320
rev2d ops walker.r2d.json walk.json
```

Each leg is a two-bone IK chain whose target bone (`footL`, `footR`) is moved by pixel parameters
(`bind_linear`, recipe 18); the skinned leg bends at the knee. The walk animates only parameters,
and the right foot reuses the left foot's keys half a cycle later with a track `offset`.

<!-- check:ops name=walk base=empty:320x320 -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "FootLX", "min": -40, "max": 40, "group": "Legs" } },
  { "op": "add", "kind": "parameter", "value": { "id": "FootLY", "min": -30, "max": 30, "group": "Legs" } },
  { "op": "add", "kind": "parameter", "value": { "id": "FootRX", "min": -40, "max": 40, "group": "Legs" } },
  { "op": "add", "kind": "parameter", "value": { "id": "FootRY", "min": -30, "max": 30, "group": "Legs" } },
  { "op": "add", "kind": "parameter", "value": { "id": "BodyY", "min": -10, "max": 10, "group": "Body" } },
  { "op": "add", "kind": "bone", "value": { "id": "root", "x": 160, "y": 280 } },
  { "op": "add", "kind": "bone", "value": { "id": "hips", "parent": "root", "world": [160, 172] } },
  { "op": "add", "kind": "bone", "value": { "id": "thighL", "parent": "hips", "world": [164, 172], "worldRotation": 90, "length": 55 } },
  { "op": "add", "kind": "bone", "value": { "id": "shinL", "parent": "thighL", "world": [164, 227], "worldRotation": 90, "length": 55 } },
  { "op": "add", "kind": "bone", "value": { "id": "thighR", "parent": "hips", "world": [156, 172], "worldRotation": 90, "length": 55 } },
  { "op": "add", "kind": "bone", "value": { "id": "shinR", "parent": "thighR", "world": [156, 227], "worldRotation": 90, "length": 55 } },
  { "op": "add", "kind": "bone", "value": { "id": "footL", "parent": "root", "world": [164, 275] } },
  { "op": "add", "kind": "bone", "value": { "id": "footR", "parent": "root", "world": [156, 275] } },
  { "op": "add", "kind": "ik", "value": { "id": "legIkL", "bones": ["thighL", "shinL"], "target": "footL", "softness": 10, "stretch": true } },
  { "op": "add", "kind": "ik", "value": { "id": "legIkR", "bones": ["thighR", "shinR"], "target": "footR", "softness": 10, "stretch": true } },
  { "op": "bind_linear", "target": "bone:footL.x", "param": "FootLX", "scale": 1 },
  { "op": "bind_linear", "target": "bone:footL.y", "param": "FootLY", "scale": 1 },
  { "op": "bind_linear", "target": "bone:footR.x", "param": "FootRX", "scale": 1 },
  { "op": "bind_linear", "target": "bone:footR.y", "param": "FootRY", "scale": 1 },
  { "op": "bind_linear", "target": "bone:hips.y", "param": "BodyY", "scale": 1 },
  { "op": "add", "kind": "part", "value": { "id": "legL", "skin": { "bones": ["thighL", "shinL"] }, "z": 0, "fill": "#2c4468",
      "shape": { "type": "rect", "x": 157, "y": 166, "w": 14, "h": 112, "radius": 7, "detail": 6 } } },
  { "op": "add", "kind": "part", "value": { "id": "shoeL", "parent": "footL", "z": 0, "fill": "#1e2230",
      "shape": { "type": "ellipse", "cx": 170, "cy": 278, "rx": 14, "ry": 6 } } },
  { "op": "add", "kind": "part", "value": { "id": "legR", "skin": { "bones": ["thighR", "shinR"] }, "z": 0, "fill": "#3f5f8f",
      "shape": { "type": "rect", "x": 149, "y": 166, "w": 14, "h": 112, "radius": 7, "detail": 6 } } },
  { "op": "add", "kind": "part", "value": { "id": "shoeR", "parent": "footR", "z": 0, "fill": "#2b2f3d",
      "shape": { "type": "ellipse", "cx": 162, "cy": 278, "rx": 14, "ry": 6 } } },
  { "op": "add", "kind": "part", "value": { "id": "body", "parent": "hips", "z": 1, "fill": "#e0a040", "stroke": { "color": "#8a5a1c", "width": 3 },
      "shape": { "type": "ellipse", "cx": 160, "cy": 140, "rx": 40, "ry": 48, "detail": 10 } } },
  { "op": "add", "kind": "part", "value": { "id": "eye", "parent": "hips", "z": 1, "fill": "#20242c",
      "shape": { "type": "ellipse", "cx": 178, "cy": 124, "rx": 6, "ry": 8 } } },
  { "op": "add", "kind": "animation", "value": { "id": "walk", "duration": 1, "loop": true, "tracks": [
      { "target": "param:FootLX", "keys": [ { "t": 0, "v": 36 }, { "t": 0.5, "v": -36, "ease": "smooth" }, { "t": 0.9, "v": 40, "ease": "smooth" }, { "t": 1, "v": 36 } ] },
      { "target": "param:FootLY", "keys": [ { "t": 0, "v": 0 }, { "t": 0.5, "v": 0, "ease": "smooth" }, { "t": 0.75, "v": -18, "ease": "smooth" }, { "t": 1, "v": 0 } ] },
      { "target": "param:FootRX", "offset": 0.5, "keys": [ { "t": 0, "v": 36 }, { "t": 0.5, "v": -36, "ease": "smooth" }, { "t": 0.9, "v": 40, "ease": "smooth" }, { "t": 1, "v": 36 } ] },
      { "target": "param:FootRY", "offset": 0.5, "keys": [ { "t": 0, "v": 0 }, { "t": 0.5, "v": 0, "ease": "smooth" }, { "t": 0.75, "v": -18, "ease": "smooth" }, { "t": 1, "v": 0 } ] },
      { "target": "param:BodyY", "keys": [ { "t": 0, "v": 0, "ease": "smooth" }, { "t": 0.25, "v": -4, "ease": "smooth" }, { "t": 0.5, "v": 0, "ease": "smooth" },
                                          { "t": 0.75, "v": -4, "ease": "smooth" }, { "t": 1, "v": 0 } ] } ],
    "events": [ { "t": 0, "name": "footstep", "data": { "foot": "L" } }, { "t": 0.5, "name": "footstep", "data": { "foot": "R" } } ] } }
]
```

<!-- check:run chain=walk -->
```sh
rev2d analyze walker.r2d.json --anim walk
rev2d inspect walker.r2d.json --anim walk --times 0:1:11 --track ik:legIkL,ik:legIkL.stretch,bone:shinL.rotation,bone:shinL.tip
rev2d sheet walker.r2d.json -o out/walk.png --anim walk --frames 8 --columns 8 --overlay bones --viewbox fit --scale 0.8
rev2d gif walker.r2d.json -o out/walk.gif --anim walk --viewbox fit
```

- **`worldRotation`** gives a bone's direction in screen terms: 90 points down whatever the
  parent's rotation. The op converts it (`shinL` gets local rotation 0 under `thighL`) and prints
  both: `rotation 0 (world rotation 90)`.
- **Track `offset`**: `FootRX`/`FootRY` carry the same keys as `FootLX`/`FootLY` with
  `"offset": 0.5`, so `v_R(t) = v_L(t − 0.5)`, wrapped in the loop. Edit the L keys, paste them
  into R, and the legs stay in antiphase.
- **`smooth` ease**: a segment whose start key has `"ease": "smooth"` follows a Catmull-Rom curve
  through the neighbouring keys, so the swing and the bob have no corners, and in a looping track
  with keys at 0 and `duration` the curve continues across the seam. The stance (t 0 → 0.5) stays
  linear: the planted foot slides back at a constant 144 px/s. The key at 0.9 (40, past the contact
  point 36) makes the foot reach forward and land already moving back.
- **IK `softness` and `stretch`**: at contact the leg reaches extension 0.994 (distance / reach).
  Without `softness`, `analyze` notes `IK "legIkL": chain nearly straight in 10 of 60 frames (17%);
  extension up to 0.994 (> 0.98), so the joint may visibly snap as it straightens. Set "softness"
  (px, e.g. 10) ...` and the loop seam shows the knee jumping (`bone shinL: jumps 1.03 px, 1.16°`).
  With `"softness": 10` the knee straightens gradually (`shinL` rotation stays at 27° or more
  instead of dropping to 14.6°) and the seam closes. Softness alone leaves the foot up to 2.2 px
  short of its target near full reach; `"stretch": true` scales the bones instead (the
  `ik:legIkL.stretch` column: at most ×1.02), so the error stays 0.
- **Verify with numbers**: `analyze` reports the IK extension, the events, the loop seam
  (`parameters and bones close the loop`) and nothing to fix. The `--track` table shows
  `bone:shinL.tip` at y 275 through the stance (the foot is planted) while x drops 14.4 px per
  0.1 s.
- The walker faces the screen right, so its **left** side faces away from the viewer: `legL` is the
  far leg, drawn first and darker. `L`/`R` always name the character's own sides.
- The `footstep` events (with `data`) mark the contacts; the sheet captions them under `t=0.00s`
  and `t=0.50s`.

## 20. Physics tuning with analyze and seamless loops

Builds on [5. Hair physics](#5-hair-physics-pendulum--parameter--warp). `analyze` samples an
animation at 60 frames per second (the physics rate) and reports parameter ranges, physics
clamping, IK reach, events, the loop seam and parts leaving the canvas. First the plain recipe 5:

<!-- check:run chain=hair-physics -->
```sh
rev2d analyze hero.r2d.json --anim sway
rev2d analyze hero.r2d.json --anim sway --warmup 10
```

```text
PHYSICS (raw output before clamping)
  hairPhysics: HairSway clamped in 15 of 120 frames (13%), peak raw 31.576 at t=0.85s vs range -30..30
LOOP SEAM (end of the loop extrapolated to t=2 vs t=0)
  param HairSway: -21.519 at the end -> 0 at the start (jump 21.519)
NOTES
  - physics starts at rest at t=0, so this first cycle includes its settling (and the seam compares against the rest pose); pass warmup (--warmup 10) to analyze the steady state
```

With `--warmup 10` (5 whole cycles first) the same analysis says `HairSway never clamped, peak raw
24.532` and `parameters and bones close the loop`: the clamping and the seam were the start-up
from rest. Analyze and export physics loops with a warm-up. Now make the hair livelier:

<!-- check:ops name=hair-lively -->
```json
[
  { "op": "update", "kind": "physics", "id": "hairPhysics", "set": { "damping": 0.04 } }
]
```

<!-- check:run chain=hair-physics,hair-lively -->
```sh
rev2d analyze hero.r2d.json --anim sway --warmup 10
rev2d inspect hero.r2d.json --anim sway --times 10.6:11:5 --track physics:hairPhysics.HairSway,param:HairSway
```

`analyze` now reports `HairSway clamped in 36 of 120 frames (30%), peak raw 33.552 at t=0.8s vs
range -30..30`, with the note `... so the swing stops hard at the limit. Lower the output "scale"
or widen the parameter range`. The track table shows it frame by frame: the raw output
(`physics:hairPhysics.HairSway`) reaches 33.552 while `param:HairSway` sits at 30. Scale the
output down:

<!-- check:ops name=hair-tune -->
```json
[
  { "op": "update", "kind": "physics", "id": "hairPhysics", "set": { "outputs.0.scale": 0.85 } }
]
```

<!-- check:run chain=hair-physics,hair-lively,hair-tune -->
```sh
rev2d analyze hero.r2d.json --anim sway --warmup 10
rev2d gif hero.r2d.json -o out/sway.gif --anim sway --warmup 10 --viewbox fit --scale 0.4
```

- Result: `HairSway never clamped, peak raw 28.519`. 30 / 33.55 ≈ 0.89 is the largest scale that
  never clamps; 0.85 leaves some headroom.
- Widening the parameter range instead also needs keyforms at the new ends: a binding holds its
  end keyforms beyond its grid, so with keys at ±30 the hair would still stop at the ±30 shape.
- `--warmup 10` runs `ceil(10 / 2) = 5` whole cycles before the first frame, so the GIF starts in
  the steady state and its last frame flows into its first. Captions and `times` stay
  animation-local. `sheet` and `frames` take `--warmup` too; `inspect` series use absolute times
  (10.6 s here).
- `analyze` samples at 60 fps by default because physics steps at 60 Hz; `--frames n` or `--fps f`
  change that, and `--no-pixels` skips the rendered seam comparison.

## 21. Palette changes with recolor

One op per palette change: an exact colour map (a darker skin tone with a matching outline) or an
HSL shift (hair color), over a list of parts, a tag or all parts.

<!-- check:ops name=recolor -->
```json
[
  { "op": "recolor", "all": true, "map": { "#f2c9a0": "#c68e63", "#8a5a3c": "#5c3a24" } },
  { "op": "recolor", "parts": ["hairBack"], "hsl": { "h": 115, "s": 0.1, "l": 0.08 } },
  { "op": "recolor", "parts": ["irisL", "irisR"], "map": { "#3a2f6b": "#2f6b4a" } }
]
```

<!-- check:run chain=recolor -->
```sh
rev2d render hero.r2d.json -o out/recolored.png --viewbox fit --scale 0.5
rev2d info hero.r2d.json
```

- The messages count what changed: `recolored 2 colours in 1 of 8 parts: face (fill, stroke);
  unchanged: hairBack, torso, ...` and `recolored 1 colour in 1 of 1 part: hairBack (fill)`
  (#3b2a4a becomes #6c4b31, chestnut brown).
- `map` matches exact RGB (`"#FC9"` = `"#ffcc99"`; a key with alpha matches only that alpha), keeps
  each colour's own alpha, and needs opaque new colours. `hsl` rotates the hue by `h` degrees and
  adds `s` / `l` in 0..1 units; greys, white and black have no hue.
- Gradient stops, strokes, and binding keyforms and animation keys on `part:<id>.fill` /
  `.stroke.color` change too (with `"include": ["tint"]` also tints), because their absolute
  colours would otherwise hide the new setup colour.
- If nothing changes the op fails, and the hint lists the colours that are there:
  `recolor: no colour changed in the 1 selected part → colours there: #c68e63 (face fill), #5c3a24 (face stroke)`.
- Tag parts (`"tags": ["hair"]`) to make palette swaps a single `{"op": "recolor", "tag": "hair", ...}`.
  Compare before and after with two renders at the same flags and `rev2d diff`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A part does not bend in a warp | no `detail` (or `cols`/`rows` for images) | `update` → `"shape.detail": 8` |
| The rest pose changed after adding a binding | the keyform at the parameter default differs from the setup value | make that keyform equal the setup value (see `inspect` with default params) |
| `binding-grid-incomplete` | keys are not the full Cartesian product of the `at` values | add the missing `at` combinations the message lists |
| Rotation binding spins the wrong way | +degrees are clockwise on screen (+y down) | negate the keyform delta |
| `AngleY = 30` looks down | positive `bind_warp` pitch shifts content down (+y) | negative pitch at `AngleY > 0` (recipe 1); check with `inspect --param AngleY=30`: feature y must decrease |
| Head turn looks like a slide | lattice too coarse (1×1 can only shear) or features and outline in one warp | 3-4 cols/rows, nested warps with a weaker outer turn |
| A new part stays behind when the head turns | it is parented to the bone while its neighbours are in a warp | give it the same parent (and `detail`) as the parts around it |
| An accessory stretches or drifts at the turn extremes | its warp extends outside its parent warp (`warp-outside-parent`) | parent it to the bone and match the motion with its own lattice (recipe 16) |
| Physics does nothing in a render | physics starts at rest and needs inputs that change over time | verify with `--anim` or `analyze`; check the output binding with a sweep of the output parameter (explicit values beat physics) |
| Physics swing flattens at the ends | the output is clamped to its parameter range | `analyze --warmup 10` gives the clamped share and peak raw value; lower the output `scale` (recipe 20) |
| A physics GIF jumps at the loop point | the first cycle includes the settling from rest | `--warmup 10` on `gif`, `sheet`, `frames` and `analyze` |
| Path morph invalid | keyform commands differ from the setup path | same commands, same order, same absolute/relative form |
| A line of iris shows under a closed eye | the closed eye white's sliver lies outside the lash | put the sliver inside the lash band (recipe 14) |
| Masked parts vanish | the mask parts have no geometry at this pose (zero coverage) | keep a sliver of area (recipe 14); check with `inspect` bounds |
| Markings paint over an outline | the mask includes the stroke and the markings draw above it | a stroke-only copy of the part above the markings (recipe 17) |
| One eye stays open during a blink after a wink | the one-shot layer holds its last key | play it with `once` (`hold: false`) (recipe 15) |
| A gesture layer cancels the idle's head motion | `override` layers replace param values | play it with `add` and author it around the defaults (recipe 15) |
| Knee or elbow snaps straight | IK extension close to 1 | `"softness"` (px), plus `"stretch": true` if the tip must stay on target (recipe 19) |
| `analyze` reports a loop seam | last keys differ from the first, or physics not settled | equal first/last values (or `smooth` keys through the seam), `--warmup` |
| Part missing from the render | `opacity` 0, `visible` false, off-canvas, or behind an opaque part | `render --json` lists `visibleParts`/`hiddenParts`/`outsideView`; `inspect` gives bounds and draw order |
