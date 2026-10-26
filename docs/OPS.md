# Rev2D Edit Ops

Scene placement, camera and appearances are authored in [scene documents](SCENE.md), not model ops.
Rendering a scene evaluates its rigs without rewriting the models or adding baked tracks to them.

Ops are small JSON edits addressed by id: "add this bone under that one", "bind this property
to that parameter", "rename this texture everywhere". AI agents send a list of ops instead of
rewriting the whole model file. The same ops run everywhere: `applyOps()` in `src/ops`, the
`rev2d ops` CLI command and the MCP edit tool all take these JSON objects unchanged.

```sh
rev2d ops hero.r2d.json ops.json --dry-run          # apply + validate, print the results, write nothing
rev2d ops hero.r2d.json --op '{"op": "set", "target": "bone:arm.rotation", "value": 30}'
```

```ts
import { applyOps, describeOps } from 'rev2d';

const { ok, doc, results, diagnostics } = applyOps(model, [
  { op: 'add', kind: 'bone', value: { id: 'hand', parent: 'forearm', world: [300, 220], length: 30 } },
  { op: 'set', target: 'bone:hand.rotation', value: 15 },
]);
```

Read [SPEC.md](SPEC.md) first for the model format and property addresses (`bone:arm.rotation`,
`part:mouth.shape.ry`, `warp:face.offsets`, `param:AngleX`, ...).

## Contents

1. [Batches: atomicity, validation, results](#1-batches-atomicity-validation-results)
2. [Op catalogue](#2-op-catalogue): [add](#add) · [update](#update) · [remove](#remove) · [rename](#rename) · [set](#set) · [bind](#bind) · [bind_linear](#bind_linear) · [bind_warp](#bind_warp) · [follow](#follow) · [unbind](#unbind) · [key](#key) · [unkey](#unkey) · [move](#move) · [recolor](#recolor) · [compose](#compose) · [patch](#patch)
3. [References: what rename rewrites and remove cascades](#3-references)
4. [bind_warp math: pseudo-3D head turns](#4-bind_warp-math-pseudo-3d-head-turns)
5. [Worked example: a rig from scratch, only ops](#5-worked-example-a-rig-from-scratch-only-ops)
6. [Tips for agents](#6-tips-for-agents)

---

## 1. Batches: atomicity, validation, results

`applyOps(doc, ops, options?) → { ok, doc, results, diagnostics }`

- **Raw documents.** Ops edit the model JSON as written: defaults are not filled in. Untouched
  items, fields and key order stay as they were. New fields go in their schema position (for
  example, `rotation` is added after `y` on a bone), and missing sections (`"bones": []`) are
  created in model key order.
- **The input is never mutated.** Ops run on a deep copy.
- **Order.** Ops run in order, and each op sees the result of the ones before it. You can add a
  parameter and bind it in the same batch.
- **Atomic.** If any op fails, the rest are skipped (`"skipped: an earlier op failed ..."`),
  `ok` is `false` and `doc` is **the original input**. Fix the failing op and resend the
  whole batch.
- **Validation.** After the last op, the result goes through `validateModel` (the same check as
  `rev2d validate`). `diagnostics` holds everything it reports (errors, warnings, infos) with
  JSON pointers into the *result*. With any error, `ok` is `false` and `doc` is the original
  input. Semantic problems such as dangling references are checked only here, at the end, so a
  batch may pass through intermediate states. Errors that were already in the model count too:
  fix them in the same batch.
- **Per-op structure check.** `add`, `update`, `set`, `bind`, `bind_linear`, `bind_warp`, `follow`,
  `key` and `compose` also check the item they touched against the schema immediately. That catches typos (`"rotate"` on a bone
  → `did you mean "rotation"?`) at the op that caused them.

| option | default | effect |
| --- | --- | --- |
| `validate` | `true` | `false` skips the final validation (`diagnostics` = `[]`). |
| `allowInvalid` | `false` | keep the result even when validation reports errors (`ok` = `true`, errors still listed). |
| `textures` | `{}` | known texture sizes by id (`{ "skin": { "width": 256, "height": 256 } }`), used in messages. |

Each entry in `results` is `{ index, op, ok, message, hint? }`. The message says exactly what
changed, with ids, JSON pointers and before → after values:

```text
added bone "hand" as /bones/3 under "forearm" at local (40, 0) (world 300, 220)
updated part "head": shape.rx 40 → 20, stroke.width (unset) → 3, z deleted (was 1); unchanged: fill
updated animation "walk": tracks: 1 of 13 changed (param:BodyY, 21 keys)
replaced binding bone:hand.rotation ← [Sway] at /bindings/3 (3 keyforms, was 2)
removed bone "fore" (was /bones/2); cascade: reparented bone "hand" to "upper" keeping its setup world pose (...); removed ik constraint "armIk" (it uses bone "fore"); ...
```

Errors come with a `hint`: the closest match (`did you mean "hand"?`), the valid options, or a
complete op that fixes the problem.

```json
{ "index": 1, "op": "key", "ok": false,
  "message": "key: t=3 is after the end of animation \"wave\" (duration 2)",
  "hint": "extend it first: {\"op\": \"update\", \"kind\": \"animation\", \"id\": \"wave\", \"set\": {\"duration\": 3}}" }
```

Unknown ops and fields are errors too, and common synonyms are recognised (`"item"` →
`did you mean "value"?`, `"time"` → `"t"`, `"rotation"` in a `bind_warp` key → `"rotate"`).
`describeOps()` returns the catalogue below as data (`{ op, summary, fields, example }` per op).
The MCP tool descriptions are generated from it.

---

## 2. Op catalogue

`kind` is one of `parameter`, `texture`, `bone`, `warp`, `part`, `binding`, `ik`, `physics` or
`animation`. The kind names the model section (`bone` → `"bones"`). Items are addressed by `id`.
Bindings may have no id, so any op that takes `kind` + `id` also accepts `"target"` (plus
`"params"` when several bindings share a target) for `kind: "binding"`. `meta` is not a kind:
edit it with [`patch`](#patch).

### add

Add an item. `value` is the item exactly as it appears in the model file.

| field | |
| --- | --- |
| `kind` | required |
| `value` | required: the item object |
| `index` / `before` / `after` | optional position: index `0..length`, or next to an item id. Default: append. |

Bones may give `"world": [x, y]` (setup-space position) instead of local `x`/`y`, and
`"worldRotation"` (setup-space degrees, clockwise: the direction the bone points on screen)
instead of local `rotation`. Both are converted with the parent's **setup world transform**, which
already accounts for rotated, scaled and mirrored (negative scale) parents; a bone with negative
`scaleX` gets the rotation that still points it at `worldRotation` along its flipped axis. The
parent must already exist (add it earlier in the batch). The message gives both frames:
`added bone "finger" as /bones/5 under "fore" at local (18.628, -87.735) (world 100, 100), rotation 105 (world rotation 45)`.

```json
{ "op": "add", "kind": "bone", "value": { "id": "hand", "parent": "forearm", "world": [300, 220], "worldRotation": 90, "length": 30 } }
```
```json
{ "op": "add", "kind": "part", "value": { "id": "mouth", "parent": "faceWarp", "shape": { "type": "ellipse", "cx": 256, "cy": 262, "rx": 24, "ry": 3 }, "fill": "#a0303a", "z": 2 }, "after": "eyeR" }
```

Errors: duplicate id (the hint suggests a free id, e.g. `"hand2"`), invalid id, a bone id that
is already a warp id or the other way round (they share one namespace), and schema errors in `value`.

### update

Change fields of an item. `set` maps field paths to values:

- dotted paths reach nested fields: `"shape.rx"`, `"stroke.width"`, `"rect.2"` (array index);
- missing intermediate objects are created (`"stroke.width"` on a part without a stroke creates
  `"stroke": {"width": ...}`, and the schema check then asks for `color`);
- `null` deletes the field;
- ids cannot change here (use [`rename`](#rename), which also rewrites references). The one
  exception: a binding without an id can get one (`"set": {"id": "mouthOpen"}`).

Bones also accept `"world": [x, y]` and `"worldRotation"` (converted in the bone's parent frame
after the other fields of the same update, so `{"parent": "root", "worldRotation": 0}` works).
With `"keepWorld": true`, a bone whose `parent` changes
keeps its setup world pose: x/y/rotation/scale are recomputed in the new parent frame. Keyforms
and animation keys on its transform are remapped the same way, see [remove](#remove). Because
keepWorld computes x, y, rotation, scaleX and scaleY itself, the same update cannot also set them
(or `world` / `worldRotation`); change the transform in a second op. Parts and warps never need `keepWorld`,
because their geometry is in setup space and reparenting them does not move their rest pose.
A bone's parent must be a bone (a warp id is rejected with that reason), and world conversions
fail when the parent frame has zero scale. A reparent *without* `keepWorld` keeps the local
values, so the bone moves; the message says where its joint goes, e.g.
`parent "fore" → "root" (its local transform is kept, so its joint moves from world (230, 138.038) to (240, 300); "keepWorld": true keeps it in place)`.

The message lists **only the fields whose value changed** (`before → after`) and then names the
ones that already had the given value: `updated part "head": shape.ry 45 → 50; unchanged: shape.rx, z`.
When nothing changed it says so: `updated part "head": unchanged (z, description already had those values)`.
Values too long to show are summarized: a replaced object by its changed fields
(`shape.rx 40 → 20, shape.detail (unset) → 4`), an array of items by what changed in it, matched by
`id` or track/binding `target` (`tracks: 1 of 13 changed (param:BodyY, 21 keys) + 1 added (bone:root.x, 2 keys)`),
and a long number list by index (`shape.points: 2 of 40 values changed (indexes 6, 7)`).

```json
{ "op": "update", "kind": "part", "id": "mouth", "set": { "shape.rx": 20, "stroke.width": 3, "description": null } }
```
```json
{ "op": "update", "kind": "bone", "id": "hand", "set": { "parent": "root" }, "keepWorld": true }
```
```json
{ "op": "update", "kind": "bone", "id": "hand", "set": { "worldRotation": 0 } }
```
```json
{ "op": "update", "kind": "binding", "target": "part:mouth.shape.ry", "set": { "interpolation": "step" } }
```

### remove

Remove an item. Without `cascade`, the op **fails if anything references the item** and lists
every reference as a JSON pointer:

```text
cannot remove bone "fore": it is referenced 5 times: /bones/3/parent, /parts/3/skin/bones/1,
/bindings/0/target, /ik/0/bones/1, /animations/0/tracks/0/target
hint: pass "cascade": true to reparent its children to "upper" (child bones keep their world pose) ...
```

With `"cascade": true`, the dependents are fixed or removed, and the message lists every change
(see [§3](#3-references) for the full table):

- **child bones** move to the removed bone's parent and **keep their setup world pose**
  (new local = removedLocal · childLocal). Keyform values of bindings and animation tracks on
  their `x/y/rotation/scaleX/scaleY` are remapped the same way, so the motion stays the same.
  If the new frame mixes axes (for example, a non-uniformly scaled parent), the message warns
  that the remapping is approximate;
- **warps and parts** move to the removed item's parent (their setup geometry does not change);
- **skins** drop the bone, including its column of explicit weights. A skin left with no bones
  is deleted, and the part then follows the removed bone's parent;
- **masks** drop the part (an empty mask is deleted along with `maskInvert`);
- **bindings / tracks** on the removed item are removed. **IK** constraints that use a removed
  bone are removed, which also removes the bindings and tracks on their `mix`;
- **parameters**: the rig should keep looking the way it did with the parameter at its default.
  Multi-parameter bindings **drop that dimension** and keep the values the rig produced at the
  default, exactly as it blends keyforms: the keyforms at the default when it is a grid value
  (or at the nearest end when it is outside the grid, or at the lower grid value for `"step"`
  bindings), otherwise the keyforms **interpolated** between the two grid values around it
  (numbers, colours, paths and point lists; two sparse maps stay sparse). Single-parameter
  bindings are removed; if one held its property away from the setup value at the default, the
  message says `WARNING: ... so the rest pose changes` and, when it can be exact, gives the `set`
  op that keeps the look. Tracks on `param:<id>` are removed. Physics inputs and outputs are
  removed, and a group left with no inputs or no outputs is removed;
- **textures**: image parts that use the texture are removed (and their own references cascade).
  Meshes lose `texture` and `uvs`.

```json
{ "op": "remove", "kind": "bone", "id": "forearm", "cascade": true }
```
```json
{ "op": "remove", "kind": "binding", "target": "part:head.opacity" }
```

### rename

Rename an item and rewrite every reference to it: parents, masks, skin bones, IK bones and
targets, binding params, physics params, texture refs, and address strings
(`"bone:arm.rotation"` → `"bone:upperArm.rotation"`, `"param:Old"` → `"param:New"`). The message
lists every rewritten JSON pointer.

```json
{ "op": "rename", "kind": "bone", "from": "arm", "to": "upperArm" }
```

### set

Set the **setup (rest) value** of one addressed property. The value is checked the same way the
evaluator reads it (`resolveTarget` + `normalizeValue`) and against the schema (for example,
opacity must be in 0..1).

| target | value |
| --- | --- |
| `bone:<id>.x` `.y` `.rotation` `.scaleX` `.scaleY` `.length` | number |
| `part:<id>.opacity` `.z` | number |
| `part:<id>.visible` | `true` / `false` |
| `part:<id>.tint`, `.fill` (solid fills only), `.stroke.color` | colour string |
| `part:<id>.stroke.width` | number (the part must have a stroke) |
| `part:<id>.shape.<field>` | per shape type. Point lists take a full list **or a sparse map** `{"2": [x, y]}` (the file gets the full list). `shape.d` takes any valid path (the setup path defines the command structure). |
| `ik:<id>.mix` | number |

Rejected with hints: `param:` (use `update kind parameter set default`, or animate with `key`),
`warp:<id>.offsets` (no setup value: change `rect` with update, or deform with `bind`/`bind_warp`),
gradient fills (the hint shows the `update` that replaces the fill or edits its stops), strokes
that do not exist yet (the hint is the `update` that adds one), full point lists of a different
length (the setup point count only changes with `update`), and fields that exist but are not
animatable, such as `part:<id>.blend` or `bone:<id>.parent` (the hint is the equivalent
`update`; for `id` it is `rename`).

Binding keyforms are absolute values, so a property driven by one binding never shows its setup
value (with several, what shows is `setup + Σ(keyform − setup)`). When that is the case, the
message of `set` (and of `update` on such a field) ends with a note, e.g.
`set part:mouth.shape.ry = 10 (was 3); note: binding part:mouth.shape.ry ← [MouthOpen] sets absolute values, so this setup value does not show while it exists (change the look with "bind")`.
Point bindings with sparse maps keep the setup value of the points they do not list, so they get
no note.

```json
{ "op": "set", "target": "part:mouth.shape.points", "value": { "2": [260, 250] } }
```
```json
{ "op": "set", "target": "bone:head.rotation", "value": -5 }
```

### bind

Create or **replace** a binding (parameter → property keyforms). A binding with the same target
and the same *set* of parameters (order does not matter) is replaced in place, keeping its `id`,
`description` and `interpolation` unless new ones are given (the message notes a kept
`"step"`). The message says `added` or `replaced`.

| field | |
| --- | --- |
| `target` | required: property address (not `param:`) |
| `params` | required: 1-3 parameter ids (a single string is fine for one) |
| `keys` | required: `[{ "at": [one value per param], "value": ... }]`. `at` may be a bare number for one parameter. |
| `relative` | `true`: each `value` is an **offset** added to the target's current setup value |
| `interpolation` | `"linear"` (default) or `"step"` |
| `id`, `description` | optional |

The keys must form a **full grid** over the distinct `at` values of each parameter. If they do
not, the error lists the missing `at` combinations. Values are absolute (warp offsets: offsets
from rest). Point lists may be sparse maps.

**Relative values.** With `"relative": true` you give offsets from the current setup value and the
op stores the sums as ordinary absolute keyforms: `bone:hand.x` with setup 40 and offsets 0 / 15
is stored as 40 / 55 (`relative: stored absolute keyforms 40, 55 (setup 40 + offsets)`). Point
lists add element-wise; a sparse offset map stays sparse (`{"2": [0, 10]}` → `{"2": [200, 188]}`,
and `{}` = the setup points). Numbers, point lists and warp offsets only: colours, paths and
booleans have no meaningful offset and are rejected with the setup value as an absolute example.
The offsets are the binding's delta from setup, which is also what several bindings on one
property add up (SPEC §5). Later `set`s do not move the stored keyforms.

```json
{ "op": "bind", "target": "part:mouth.shape.ry", "params": ["MouthOpen"],
  "keys": [{ "at": [0], "value": 3 }, { "at": [1], "value": 18 }] }
```
```json
{ "op": "bind", "target": "part:eyeL.shape.ry", "params": ["EyeOpen", "Smile"],
  "keys": [
    { "at": [0, 0], "value": 1 },  { "at": [1, 0], "value": 14 },
    { "at": [0, 1], "value": 1 },  { "at": [1, 1], "value": 9 } ] }
```
```json
{ "op": "bind", "target": "bone:hand.x", "params": ["Reach"], "relative": true,
  "keys": [{ "at": [0], "value": 0 }, { "at": [1], "value": 15 }] }
```

### bind_linear

Make a numeric property follow one parameter linearly: `value = setup + scale × param`. The op
upserts a two-key binding (same replace rule as `bind`, always linear) keyed at `at` (default: the
parameter's `[min, max]`). Typical use: a parameter in pixels that moves a bone or an IK target,
e.g. `FootLY` → `bone:footL.y` with `scale: 1`.

| field | |
| --- | --- |
| `target` | required: a numeric property address (not `param:`; point lists: use `bind` with `relative`) |
| `param` | required: parameter id |
| `scale` | required: property units per parameter unit (negative = opposite direction) |
| `at` | `[low, high]` parameter values to key (default: the parameter range) |
| `id`, `description` | optional |

The message shows the formula and the keyed values:
`added binding bone:footL.y ← [FootLY] as /bindings/3 (2 keyforms); bone:footL.y = 380 + 1 × FootLY (-30 → 350, 30 → 410)`.
When the parameter's default is not 0 the rest pose moves, and the message says
`WARNING: at the parameter default Open=1 the value is 50, not the setup value 45, so the rest pose moves (...)`.

```json
{ "op": "bind_linear", "target": "bone:footL.y", "param": "FootLY", "scale": 1 }
```
```json
{ "op": "bind_linear", "target": "bone:tail.rotation", "param": "TailSwing", "scale": -2, "at": [-10, 10] }
```

### bind_warp

Generate full `warp:<id>.offsets` keyforms from high-level poses and upsert the binding (same
replace rule as `bind`). This is the helper for Live2D-style head turns. The math is in
[§4](#4-bind_warp-math-pseudo-3d-head-turns).

| key field | meaning |
| --- | --- |
| `at` | required: one value per parameter |
| `yaw` | degrees, pseudo-3D horizontal turn, strictly between -90 and 90. Positive turns toward +x: content shifts right, far (+x) side compresses. |
| `pitch` | degrees, vertical turn, strictly between -90 and 90. Positive looks **down**: content shifts +y. With the Live2D convention (`AngleY > 0` looks up) use **negative** pitch at positive AngleY, see [Building a head turn](#building-a-head-turn). |
| `scale` | number or `[sx, sy]` (not 0), about `pivot` |
| `rotate` | degrees clockwise, about `pivot` |
| `pivot` | `[x, y]` setup space. Default: rect centre. |
| `translate` | `[dx, dy]` |
| `offsets` | sparse map or full list, **added** on top of the generated offsets |

A key with only `at` is the rest pose (all zeros). Other op fields: `warp`, `params`, `keys`,
`interpolation`, `id`, `description`.

```json
{ "op": "bind_warp", "warp": "faceWarp", "params": ["AngleX"],
  "keys": [{ "at": [-30], "yaw": -20 }, { "at": [0] }, { "at": [30], "yaw": 20 }] }
```
```json
{ "op": "bind_warp", "warp": "bodyWarp", "params": ["Breath"],
  "keys": [{ "at": [0] }, { "at": [1], "scale": [1.02, 1.04], "pivot": [256, 470], "translate": [0, -2] }] }
```

The message reports the lattice size and the largest displacement:
`added binding warp:faceWarp.offsets ← [AngleX] as /bindings/0 (3 keyforms); 25 control points per keyform, largest displacement 26.175 px (at [-30])`.

### follow

Make a **rigid accessory** (a hat, glasses, a hair clip, an earring) follow one point of a
**deforming** surface, usually a head warp turned by `AngleX` / `AngleY`. Nesting the accessory
in that warp would bend it with the face; instead, attach it **next to** the followed item (for
example both on bone `head`) and let `follow` generate the keyforms that move it rigidly so its
anchor stays exactly on the surface. This replaces measuring points with `inspect --point` and
tuning `translate` by hand.

| field | |
| --- | --- |
| `warp` / `bone` | required, exactly one: the accessory. A warp gets one `warp:<id>.offsets` binding; a bone gets `bone:<id>.x` and `.y` bindings (plus `.rotation`, `.scaleX` / `.scaleY` with `rotate` / `scale`). |
| `follow` | required: the warp or bone to follow. It must not hang from the accessory, and the accessory must not hang from it (then it already deforms or moves with it; for a warp the error's hint gives the `update` op that attaches the accessory to the bone carrying that warp). |
| `at` | `[x, y]` in setup space: the anchor, the point that must stay on the followed surface (where the hat touches the head), or `"center"`. Default: the centre of the accessory warp's rect; a bone: its joint. |
| `params` | 1 to 3 parameter ids. Default: the parameters of the bindings on `follow` and on its parents, up to (not including) the first parent the accessory also hangs from. A tilt bound on bone `head` moves both already, so it is not repeated. |
| `rotate` | `true` = also follow the local rotation of the surface |
| `scale` | `true` = also follow its local (uniform) scale |
| `probe` | px: the two probe points at `at ± [probe, 0]` that measure the local rotation / scale. Default: a quarter of the accessory warp's width; a bone: half its length, else 10. |
| `description` | optional note on the generated bindings |

How it works:

- **Grid.** Per parameter, every distinct keyform value (`at`) it has in the bindings that
  define the default `params`. An explicit parameter that none of them uses takes its values
  from the other bindings on either parent chain, else `min`, default and `max`. A head turn keyed
  at `{-30, 0, 30}` on both angles gives a 3 × 3 grid of 9 keyforms, the same grid as the head.
- **Per grid point** the rig is posed with those parameter values (every other parameter at its
  default, no animations, no physics, the binding being replaced left out). The anchor is mapped
  through `follow` with `Rig.mapPoint` (what `inspect --point x,y@<follow>` shows): that is where
  the accessory's anchor has to be.
- **Warp accessory:** its current lattice (rest + other bindings) is moved rigidly: translated
  so the anchor lands there (the accessory's own parent is inverted exactly, a parent warp by
  Newton iteration), and with `rotate` / `scale` rotated / scaled about the anchor by the change
  of the vector between the probe points. Offsets = moved lattice − current lattice.
- **Bone accessory:** its posed world matrix gets the same rigid correction; the new local x / y
  (/ rotation / scale) follow from the parent bone's posed world matrix. The keyform values are
  the setup value plus the change, so other bindings on those properties keep adding.
- **Replace and keep.** A binding with the same target and parameter set is replaced (run
  `follow` again after changing the head turn). Other bindings on the accessory's targets are
  kept and included in the measurement, so the new keyforms correct on top of them. The message
  lists them: unbind them to leave the motion to `follow` alone, or keep a `bind_warp` `yaw` on
  the hat for perspective (below).

The message reports the grid, the largest anchor correction, and the **residual**: the distance
between the accessory's anchor and the followed surface point, measured on the resulting rig at
every keyform (0 up to the 1e-4 px rounding) and at the grid midpoints (halfway between keyform
values, where both motions are interpolated). A single lattice level is linear in its parameters,
so a head turn gives 0 there too. Rotating bones or nested lattice offsets in the followed chain
are not linear: above 1 px the message adds a `WARNING` with the worst midpoint; add an
in-between keyform to the followed binding (`follow` then uses the finer grid) and run it again.
A `WARNING` also flags an anchor outside the followed warp's rect (extrapolated motion).

The hat from [RECIPES.md recipe 16](RECIPES.md#16-rigid-accessory-on-a-turning-head-hat), on the
hero after recipe 1, without any manual tuning:

<!-- follow-example:start -->
```json
[
  { "op": "add", "kind": "warp", "value": { "id": "hatWarp", "parent": "head", "rect": [176, 56, 160, 80], "cols": 2, "rows": 1 } },
  { "op": "add", "kind": "part", "value": { "id": "hatCrown", "parent": "hatWarp", "z": 6,
      "shape": { "type": "path", "d": "M 202 120 C 202 64 310 64 310 120 Z", "detail": 8 },
      "fill": "#b8304a", "stroke": { "color": "#5e1224", "width": 2 } } },
  { "op": "add", "kind": "part", "value": { "id": "hatBrim", "parent": "hatWarp", "z": 6,
      "shape": { "type": "ellipse", "cx": 256, "cy": 121, "rx": 76, "ry": 9, "detail": 6 },
      "fill": "#8a1e34", "stroke": { "color": "#5e1224", "width": 2 } } },
  { "op": "follow", "warp": "hatWarp", "follow": "headWarp", "at": [256, 121] }
]
```
<!-- follow-example:end -->

<!-- follow-example-message:start -->
`added binding warp:hatWarp.offsets ← [AngleX, AngleY] as /bindings/2 (9 keyforms); warp "hatWarp" follows warp "headWarp" at (256, 121) over AngleX {-30, 0, 30} × AngleY {-30, 0, 30} (params of the bindings on "headWarp"): anchor shift up to 21.111 px at [-30, -30]; max residual 0.0001 px at the 9 keyforms, 0.0001 px at 16 grid midpoints (worst at [-30, -15])`
<!-- follow-example-message:end -->

Check it with `rev2d inspect hero.r2d.json --param AngleX=30,AngleY=30 --point 256,121@headWarp --point 256,121@hatWarp`:
both land on (275.4, 115). **Rigid** means only the anchor is exact: at `AngleX=30` the head's far
side compresses in perspective, so the brim ends (190, 124) and (322, 124) are 4.4 and 6.4 px
off their spots on the head. For perspective on the accessory itself, bind a small turn first and
let `follow` correct the position on top of it; the brim ends then stay within about 1 px:

<!-- follow-perspective:start -->
```json
[
  { "op": "bind_warp", "warp": "hatWarp", "params": ["AngleX"], "keys": [{ "at": [-30], "yaw": -6 }, { "at": [0] }, { "at": [30], "yaw": 6 }] },
  { "op": "follow", "warp": "hatWarp", "follow": "headWarp", "at": [256, 121] }
]
```
<!-- follow-perspective:end -->

A head **tilt** that the hat does not share (the face warp rotates, or a bone between them does)
needs `rotate`; a zoom or squash of the surface, `scale`. A bone accessory works the same way:

```json
{ "op": "follow", "bone": "glasses", "follow": "faceWarp", "rotate": true }
```

### unbind

Remove the binding(s) on a target. With `params`, only the one driven by exactly that parameter set.

```json
{ "op": "unbind", "target": "part:mouth.shape.ry", "params": ["MouthOpen"] }
```

### key

Upsert one animation keyframe.

| field | |
| --- | --- |
| `animation`, `target`, `t`, `v` | required. `target` is `param:<id>` (preferred) or any property address. |
| `ease` | easing from this key to the next (`"inOutSine"`, `"step"`, `[x1, y1, x2, y2]`, ...) |
| `duration`, `loop` | only used to **create** the animation when it does not exist |

- Creates the track if it is missing. A key within 1e-6 s of an existing key replaces it; the
  old `ease` is kept unless a new one is given.
- Keys stay sorted by `t`. A track it touches that was out of order is sorted, and the message says so.
- The animation is created only when `duration` is given; otherwise the op errors with a hint.
  If `duration`/`loop` are given for an existing animation, they must match its values.
- **Nothing is extended silently:** `t > duration` is an error whose hint is the `update` op
  that extends the duration.

```json
{ "op": "key", "animation": "idle", "target": "param:Breath", "t": 1, "v": 1, "ease": "inOutSine", "duration": 2 }
```

### unkey

Remove the key at `t` (within 1e-6). A track whose last key is removed is removed too. If
there is no key at `t`, the hint lists the key times the track has.

```json
{ "op": "unkey", "animation": "idle", "target": "param:Breath", "t": 1 }
```

### move

Reorder an item within its section. Give exactly one of `index` (final position), `before` or
`after`. Parts draw sorted by `(z, array index)`, so array order only decides ties. When the
parts have different `z` values, the message says what the order is among parts with the same z.

```json
{ "op": "move", "kind": "part", "id": "hairBack", "index": 0 }
```

### recolor

Recolour a set of parts in one op: skin tones, a palette swap, a darker variant.

| field | |
| --- | --- |
| `parts` / `tag` / `all` | exactly one: part ids, every part with that tag, or `true` for every part |
| `map` | `{"#old": "#new", ...}`: exact colour replacements. Matching compares RGB (8-bit), so `"#ffcc99"`, `"#FC9"` and `"#ffcc9980"` all match `"#ffcc99"`; a key that spells out an alpha (`"#ffcc9980"`, `"rgba(...)"`) matches only that alpha. Each colour keeps its own alpha; new colours must be opaque. |
| `hsl` | `{"h"?: degrees, "s"?: delta, "l"?: delta}`: rotate the hue and add to saturation / lightness in 0..1 units (`"s": -0.2` = 20 percentage points less, clamped to 0..1) |
| `include` | `["tint"]` = also recolour tints (fills and strokes are always recoloured) |

Give exactly one of `map` / `hsl`. Recoloured: **written** solid fills (string or
`{"type": "solid"}`), every gradient stop, stroke colours and, with `include`, tints. Unset fills
(the default white, which leaves image textures untouched) and unset tints are left alone.
Binding keyforms and animation keys on `part:<id>.fill`, `.stroke.color` (and `.tint` with
`include`) of the selected parts get the same change, because their values are absolute colours
that would otherwise hide the new setup colour.

The message counts what changed per part and names map entries that matched nothing (typos):
`recolored 5 colours in 2 of 6 parts: body (2 gradient stops), head (fill, stroke, binding keyform); unchanged: mouth, ...; map entries that matched nothing: "#123456"`.
If nothing changed the op fails, and the hint lists the colours it found
(`colours there: #808080 (body fill); greys, white and black have no hue, so an "h" shift leaves them unchanged ...`).

```json
{ "op": "recolor", "tag": "hair", "hsl": { "h": 30, "s": -0.1 } }
```
```json
{ "op": "recolor", "all": true, "map": { "#f2c9a0": "#c68e63", "#8a5a3c": "#5c3a24" } }
```

### compose

Bake several animations, layered the way playback layers them, into **one new animation** that
plays the same on its own at weight 1: idle + a talk overlay → `idleTalk` for an exporter or a
state machine that plays one clip at a time.

| field | |
| --- | --- |
| `id` | required: id of the new animation |
| `layers` | required, bottom first: `[{"animation": id, "weight"?, "mode"?, "start"?, "hold"?}]`. A bare id string is a full-weight layer. Same meaning as `PoseOptions.animations` layers (SPEC §9): `weight` 0..1 (default 1); `mode` `"override"` (default: param tracks blend toward their value) or `"add"` (they add their offset from the parameter default); `start` in seconds (the layer's clock is `time - start`); `hold: false` = a one-shot layer contributes nothing outside `[start, start + duration]` (a looping one: nothing before `start`). |
| `duration` | seconds. Default: the longest layer (a looping layer's duration, a one-shot layer's `start + duration`). |
| `fps` | sample rate for baked tracks, up to 1000. Default **60**, whatever `meta.fps` says: a bake keeps keys only at samples, so a coarse rate cuts the corners of fast motion (a 0.15 s blink at 20 fps). |
| `loop` | loop flag of the result (default: `true` when every layer loops) |
| `replace` | `true` = overwrite an existing animation with this id (in place). Without it an existing id fails. |
| `description` | optional |

Per track target:

- **Copied** when only one layer animates it and a copy is exact: keys shifted by `start`, eases
  (including `"smooth"`) and the track `offset` kept. A weight below 1 scales the values toward
  the rest value (parameter default / setup value), which is exact for every ease. A loop of the
  same length as a looping composition is copied unshifted, with `start` folded into the track
  `offset`. A `hold: false` layer whose values do not end at rest gets `"step"` keys to rest
  before its start and 1 µs after its end.
- **Merged** when several layers of the **same one-shot animation** animate it and nothing else
  does, with disjoint windows (`blink` at 1.2 s and again at 3.5 s): their copies go into one key
  list, in time order, with the same steps to rest between windows. Exact because at most one of
  them is away from the rest value at any time, so it needs: non-overlapping windows (touching
  only where both sides are at rest), no track offset or `"smooth"` keys, and for holding layers
  (`hold` not false) first and last values at rest; a holding parameter layer in `"override"`
  mode must also come first in `layers` (a later one pulls the value back to rest while an
  earlier one plays, and the bake shows exactly that). The message says `param:EyeOpen: 2 "blink"
  layers merged`, or why they were baked instead
  (`2 layers of "blink": their windows overlap (1.2..1.5 s and 1.4..1.7 s)`).
- **Baked** otherwise (different layers on one target, a loop inside a composition of another
  length, a layer cut off by `duration`, ...): `Rig.pose` is sampled with the layers at every
  `1 / fps` s (bindings and physics excluded, so the values are the animation's own) and stored as
  linear keys; samples that the straight line between their neighbours already reproduces are
  dropped. Boolean tracks get `"step"` keys at each change. Baking needs a valid model.
- **Events** of every layer with weight > 0 are merged, shifted by `start`; looping layers repeat
  theirs every cycle. Events outside `0..duration` are dropped (the message counts them).

The message says what was copied, what was baked and why:
`composed animation "idleTalk" as /animations/5 (2 s, once) from 3 layers (idle, talk, blink); copied 4 tracks (param:BodyY, part:face.tint, param:MouthOpen, param:EyeOpen); baked 2 tracks at 60 fps (param:AngleX: idle + talk → 120 keys; bone:head.x: "idle" loops every 2 s inside a one-shot composition with a track offset → 4 keys); merged 2 events`.

Warnings in the message:

- **Between samples.** A baked track has keys only at the samples, so a source key or a
  `hold: false` window boundary between two samples loses its exact value (a peak gets cut, a
  step gets a ramp). Every such time of the baked targets' sources is listed (key times in every
  cycle of a loop, `start` of `hold: false` layers and, for one-shots, `start + duration`), with
  the lowest rate at or above `fps` that puts a sample on each:
  `WARNING: 3 source times of the baked tracks fall between the 60 fps bake samples, so the baked keys can miss the values there: 0.51 s ("talk" key, "talk" start), 1.01 s ("talk" key), 1.51 s ("talk" key, "talk" end); "fps": 100 puts a sample on each`.
  When no rate up to 1000 fps does, it says so: move those keys and starts onto multiples of
  `1 / fps`, or raise `fps` to shrink the error.
- **Loop length.** In a looping composition, a looping layer whose duration does not divide
  `duration` gets a `WARNING` with the duration that loops seamlessly (their least common
  multiple).

```json
{ "op": "compose", "id": "idleTalk", "layers": [
  { "animation": "idle" },
  { "animation": "talk", "mode": "add", "start": 0.5, "hold": false },
  { "animation": "blink", "start": 1.2, "hold": false } ] }
```
```json
{ "op": "compose", "id": "blinkTwice", "layers": [
  { "animation": "blink", "start": 0.4, "hold": false },
  { "animation": "blink", "start": 1.3, "hold": false } ] }
```

Look at the result with `rev2d sheet hero.r2d.json -o out/idleTalk.png --anim idleTalk --frames 8`.
To compare numbers, evaluate both in code: `rig.pose({ time, animations: [{ id: "idle" }, { id: "talk", mode: "add", start: 0.5, hold: false }] })`
against `rig.pose({ time, animations: ["idleTalk"] })` at the sample times.

### patch

The fallback for anything the other ops do not cover: [RFC 6902](https://www.rfc-editor.org/rfc/rfc6902)
JSON Patch operations (`add`, `remove`, `replace`, `move`, `copy`, `test`) with RFC 6901 pointers
(`~1` = `/`, `~0` = `~`, `""` = the whole document, `-` = end of an array for `add`).
**Extension:** inside an array of id'd items, a segment may be an item id instead of an index:
`/parts/mouth/opacity`. Messages report the resolved pointer (`/parts/4/opacity`). No
references are updated: use the high-level ops when ids are involved.

```json
{ "op": "patch", "patch": [
  { "op": "test", "path": "/meta/name", "value": "demo" },
  { "op": "replace", "path": "/meta/background", "value": "#202830" },
  { "op": "add", "path": "/parts/mouth/tags", "value": ["face"] } ] }
```

---

## 3. References

Every id reference in a model, and what `rename` and `remove` (with `cascade`) do with it:

| referenced kind | referenced from | rename | remove + cascade |
| --- | --- | --- | --- |
| bone | `bones[].parent` | rewritten | child moves to the removed bone's parent, **world pose kept** (keyforms remapped) |
| bone | `warps[].parent`, `parts[].parent` | rewritten | moves to the removed bone's parent |
| bone | `parts[].skin.bones[]` | rewritten | dropped (and its explicit-weights column). Empty skin → deleted, part follows the removed bone's parent. |
| bone | `ik[].bones[]`, `ik[].target` | rewritten | IK constraint removed (cascades to `ik:<id>.mix`) |
| warp | `warps[].parent`, `parts[].parent` | rewritten | moves to the removed warp's parent |
| part | `parts[].mask[]` | rewritten | dropped. Empty mask → `mask` and `maskInvert` deleted. |
| texture | `parts[].shape.texture` | rewritten | image part removed (cascades). Mesh: `texture` + `uvs` deleted. |
| parameter | `bindings[].params[]` | rewritten | 1 param: binding removed (warning if that changes the rest pose). 2-3 params: dimension dropped, values kept (or interpolated) at the default. |
| parameter | `physics[].inputs[].param`, `.outputs[].param` | rewritten | entry removed. Group removed when no inputs or no outputs are left. |
| bone, warp, part, ik, parameter | `bindings[].target`, `animations[].tracks[].target` (addresses) | id inside the address rewritten | binding / track removed |

Bindings, physics groups and animations are not referenced by id anywhere in the model.

---

## 4. bind_warp math: pseudo-3D head turns

A warp is a lattice of `(cols+1) × (rows+1)` control points over `rect = [x, y, w, h]`. Point
`(col, row)` has index `row·(cols+1) + col` and rest position `(x + w·col/cols, y + h·row/rows)`.
For every key, `bind_warp` computes where each control point should go and stores
`offset = final − rest` for every point. The keyform is a full list of `2·(cols+1)·(rows+1)`
numbers, rounded to 1e-4 px.

Each point goes through these steps in order:

```text
rest ──► 1. yaw / pitch ──► 2. scale about pivot ──► 3. rotate about pivot ──► 4. translate ──► 5. + offsets
         (pseudo-3D)                                  (clockwise degrees)
```

### Yaw and pitch: points on a virtual cylinder

Seen from above, the rect's width is wrapped around a vertical cylinder. A column at normalized
position `u` (−1 = left edge, 0 = centre, +1 = right edge) sits at angle `φ` on the cylinder.
Turning the head by `yaw` rotates the cylinder, and the column's new screen position is the sine
of the new angle:

```text
        top view                          u  = (px − centreX) / (w/2)            ∈ [−1, 1]
                                          φ  = asin(clamp(0.98·u, −1, 1))
         far (+z)                         u' = sin(clamp(φ + yaw, −90°, 90°)) / 0.98
       .-~~~~~~~-.                        x' = centreX + u' · w/2
     /      ↻ yaw  \
    |  φ            |                     pitch: the same with v = (py − centreY)/(h/2),
     \   ·     ·   /                             h, and y' (positive = look down, +y)
       '-._____.-'
    ──────┼─────┼──────► screen x
         u=−1   u=+1
```

- `yaw = 0` is the identity (`u' = u` exactly), so the rest keyform is all zeros.
- The `0.98` keeps the edge columns off the pole of `asin` (where the slope is infinite), so they
  still move smoothly. Dividing by 0.98 again makes the mapping exact at zero.
- `φ + yaw` is clamped to ±90° (the limb). Points that would turn past the limb stop there, so
  large turns on dense lattices compress the far side to nothing instead of folding the lattice
  over itself.

Worked numbers: `yaw = +25°` on a 4-column lattice:

```text
                 near side (−x)                       far side (+x)
rest   u:        -1         -0.5         0          0.5         1
                  o-----------o-----------o-----------o-----------o
yaw +25°  u':       -0.82              -0.08       0.43     0.83   1.02
                      o-----------------o-----------o---------o-----o
gap (rest 0.50):          0.74               0.51       0.40     0.19
```

The centre moves right by 0.43·w/2, and the edges move much less. The near half is stretched and
the far half compressed, which is the classic Live2D turn. Pitch does the same vertically.

### Scale, rotate, translate

With pivot `P` (default: rect centre), scale `(sx, sy)` and rotation `θ` (clockwise on screen,
since +y is down):

```text
d  = (p − P) · (sx, sy)
p' = P + (cos θ · dx − sin θ · dy,  sin θ · dx + cos θ · dy) + translate
```

`rotate: 90` sends each corner of a square lattice to the next corner clockwise
(top-left → top-right).

### Building a head turn

**Sign convention.** Rev2D follows Live2D: `AngleX > 0` turns the head toward +x (screen right)
and `AngleY > 0` looks **up**. `yaw` has the sign of AngleX (positive yaw shifts content right),
but positive `pitch` shifts content **down** (+y, screen coordinates), so **pitch has the opposite
sign of AngleY**: `"pitch": -15` at `AngleY = 30` (look up), `"pitch": 15` at `AngleY = -30`
(look down). Every example in this document, RECIPES.md and `examples/hana` uses this convention.

For each parameter grid point, a key names the pose. The rig blends between keyforms
multilinearly, so a 3×3 grid over `AngleX × AngleY` gives smooth diagonals:

```json
{ "op": "bind_warp", "warp": "faceWarp", "params": ["AngleX", "AngleY"], "keys": [
  { "at": [-30, -30], "yaw": -20, "pitch": 15 },  { "at": [0, -30], "pitch": 15 },  { "at": [30, -30], "yaw": 20, "pitch": 15 },
  { "at": [-30, 0], "yaw": -20 },                 { "at": [0, 0] },                 { "at": [30, 0], "yaw": 20 },
  { "at": [-30, 30], "yaw": -20, "pitch": -15 },  { "at": [0, 30], "pitch": -15 },  { "at": [30, 30], "yaw": 20, "pitch": -15 } ] }
```

Tips:

- **Nest warps.** Give the outline warp a gentle turn (yaw ≈ ±10°) and the features warp inside
  it a stronger one (yaw ≈ ±20°). One strong warp on the whole head would visibly distort the
  silhouette. The features then slide across the face while the outline barely changes.
- Use 3-4 columns and rows for faces. A 1×1 lattice can only shear, so a yaw there just shifts
  the whole content.
- Parts inside warps need `"detail"` (for example 8-16 px) so their meshes bend smoothly.
- Several bindings on one warp add up (SPEC §5): you can bind `AngleX` and `AngleY` separately
  instead of as one grid, at the cost of less control over the diagonals.

---

## 5. Worked example: a rig from scratch, only ops

Start from the smallest valid model:

<!-- worked-example-doc:start -->
```json
{ "format": "rev2d", "version": 1, "meta": { "name": "head-demo", "width": 512, "height": 512, "background": "#20242c" } }
```
<!-- worked-example-doc:end -->

One batch builds a character with a head that turns in pseudo-3D (nested warps), a mouth that
opens, breathing, and an idle animation. It also shows rename and set. The ops run in order, so
each one can use what the earlier ones created:

<!-- worked-example:start -->
```json
[
  { "op": "add", "kind": "parameter", "value": { "id": "AngleX", "min": -30, "max": 30, "group": "Head" } },
  { "op": "add", "kind": "parameter", "value": { "id": "AngleY", "min": -30, "max": 30, "group": "Head" } },
  { "op": "add", "kind": "parameter", "value": { "id": "MouthOpen", "min": 0, "max": 1, "group": "Face" } },
  { "op": "add", "kind": "parameter", "value": { "id": "Breath", "min": 0, "max": 1, "group": "Body" } },

  { "op": "add", "kind": "bone", "value": { "id": "body", "x": 256, "y": 470 } },
  { "op": "add", "kind": "bone", "value": { "id": "neck", "parent": "body", "world": [256, 330], "rotation": -90, "length": 40 } },

  { "op": "add", "kind": "warp", "value": { "id": "headWarp", "parent": "neck", "rect": [146, 100, 220, 230], "cols": 2, "rows": 2 } },
  { "op": "add", "kind": "warp", "value": { "id": "faceWarp", "parent": "headWarp", "rect": [181, 160, 150, 130], "cols": 4, "rows": 4 } },

  { "op": "add", "kind": "part", "value": { "id": "torso", "parent": "body", "shape": { "type": "rect", "x": 181, "y": 320, "w": 150, "h": 160, "radius": 40 }, "fill": "#4a6fa5" } },
  { "op": "add", "kind": "part", "value": { "id": "head", "parent": "headWarp", "shape": { "type": "ellipse", "cx": 256, "cy": 215, "rx": 95, "ry": 105, "detail": 12 }, "fill": "#f2c9a0", "stroke": { "color": "#8a5a3c", "width": 3 }, "z": 1 } },
  { "op": "add", "kind": "part", "value": { "id": "eyeL", "parent": "faceWarp", "shape": { "type": "ellipse", "cx": 220, "cy": 200, "rx": 10, "ry": 14, "detail": 4 }, "fill": "#2b2b2b", "z": 2 } },
  { "op": "add", "kind": "part", "value": { "id": "eyeR", "parent": "faceWarp", "shape": { "type": "ellipse", "cx": 292, "cy": 200, "rx": 10, "ry": 14, "detail": 4 }, "fill": "#2b2b2b", "z": 2 } },
  { "op": "add", "kind": "part", "value": { "id": "mouth", "parent": "faceWarp", "shape": { "type": "ellipse", "cx": 256, "cy": 262, "rx": 24, "ry": 3 }, "fill": "#a0303a", "z": 2 } },

  { "op": "bind_warp", "warp": "headWarp", "params": ["AngleX", "AngleY"], "keys": [
      { "at": [-30, -30], "yaw": -10, "pitch": 8 },  { "at": [0, -30], "pitch": 8 },  { "at": [30, -30], "yaw": 10, "pitch": 8 },
      { "at": [-30, 0], "yaw": -10 },                { "at": [0, 0] },                { "at": [30, 0], "yaw": 10 },
      { "at": [-30, 30], "yaw": -10, "pitch": -8 },  { "at": [0, 30], "pitch": -8 },  { "at": [30, 30], "yaw": 10, "pitch": -8 }
  ] },
  { "op": "bind_warp", "warp": "faceWarp", "params": ["AngleX", "AngleY"], "keys": [
      { "at": [-30, -30], "yaw": -20, "pitch": 15 }, { "at": [0, -30], "pitch": 15 }, { "at": [30, -30], "yaw": 20, "pitch": 15 },
      { "at": [-30, 0], "yaw": -20 },                { "at": [0, 0] },                { "at": [30, 0], "yaw": 20 },
      { "at": [-30, 30], "yaw": -20, "pitch": -15 }, { "at": [0, 30], "pitch": -15 }, { "at": [30, 30], "yaw": 20, "pitch": -15 }
  ] },
  { "op": "bind", "target": "bone:neck.rotation", "params": ["AngleX"], "keys": [{ "at": [-30], "value": -95 }, { "at": [30], "value": -85 }] },
  { "op": "bind", "target": "part:mouth.shape.ry", "params": ["MouthOpen"], "keys": [{ "at": [0], "value": 3 }, { "at": [1], "value": 18 }] },
  { "op": "bind", "target": "bone:body.scaleY", "params": ["Breath"], "keys": [{ "at": [0], "value": 1 }, { "at": [1], "value": 1.03 }] },

  { "op": "key", "animation": "idle", "target": "param:Breath", "t": 0, "v": 0, "ease": "inOutSine", "duration": 4 },
  { "op": "key", "animation": "idle", "target": "param:Breath", "t": 2, "v": 1, "ease": "inOutSine" },
  { "op": "key", "animation": "idle", "target": "param:Breath", "t": 4, "v": 0 },
  { "op": "key", "animation": "idle", "target": "param:AngleX", "t": 0, "v": -15, "ease": "inOutSine" },
  { "op": "key", "animation": "idle", "target": "param:AngleX", "t": 2, "v": 15, "ease": "inOutSine" },
  { "op": "key", "animation": "idle", "target": "param:AngleX", "t": 4, "v": -15 },

  { "op": "rename", "kind": "parameter", "from": "Breath", "to": "BodyBreath" },
  { "op": "set", "target": "part:head.fill", "value": "#f5d0a9" }
]
```
<!-- worked-example:end -->

What happens, step by step:

- **Parameters** first, so that later bindings can refer to them.
- **Bones.** `body` is a root bone at the bottom centre. `neck` uses `"world": [256, 330]`, and the
  message shows the conversion: `added bone "neck" as /bones/1 under "body" at local (0, -140) (world 256, 330)`.
  `rotation: -90` points the neck up.
- **Nested warps.** `headWarp` follows the neck bone, and `faceWarp` sits inside `headWarp`. The
  head outline is in the outer warp, and the eyes and mouth are in the inner one.
- **Two `bind_warp` grids** over AngleX × AngleY (9 keyforms each): a gentle ±10° yaw / ±8° pitch
  for the outline and ±20° / ±15° for the features, with pitch negative at `AngleY = 30` (looking
  up, see the [sign convention](#building-a-head-turn)). The neck binding adds a slight tilt.
- **`bind`** makes the mouth open and the body breathe (`scaleY` about the bottom-centre root).
- **`key` ×6** creates `idle`. The first key passes `"duration": 4`, which creates the
  animation; the other keys only add to it.
- **`rename`** rewrites `/bindings/4/params/0` and `/animations/0/tracks/0/target`
  (`param:Breath` → `param:BodyBreath`) in one step.
- **`set`** changes a setup value in place: `set part:head.fill = "#f5d0a9" (was "#f2c9a0")`.

The result validates with 0 errors and 0 warnings. Check it the way an agent would:

```sh
rev2d ops head-demo.r2d.json worked-example.json
rev2d validate head-demo.r2d.json
rev2d sheet head-demo.r2d.json -o turn.png --sweep AngleX=-30,0,30 --sweep AngleY=30,0,-30
rev2d sheet head-demo.r2d.json -o idle.png --anim idle
```

The AngleX × AngleY sheet shows the features sliding toward the turn direction and the far eye
narrowing; the top row (`AngleY = 30`) looks up, with the eyes and mouth moved toward the top of
the face, and the bottom row looks down. The outline changes only a little.

---

## 6. Tips for agents

- **Batch related edits.** One batch = one atomic change. If anything fails, nothing is applied.
  Read the failing result's `hint`, fix that op, and resend the batch.
- **Prefer high-level ops over patch.** They keep references consistent (rename, remove
  cascade), convert coordinates (`world`), check values against the rig, and describe what they
  did. Use `patch` for `meta` and for rare structural edits.
- **Use `remove` without `cascade` as a query.** The error lists every reference to the item.
- **Read the messages.** They carry computed facts you would otherwise have to derive: world
  positions of new bones, the largest warp displacement, cascaded changes, key counts.
- **Think in offsets when that is what you know.** "The foot moves 1 px per FootLY unit" is
  `bind_linear`; "the hand moves 15 px right at Reach = 1" is `bind` with `"relative": true`. Both
  read the current setup value for you and store ordinary absolute keyforms.
- **Rotate bones in screen terms** with `"worldRotation"` (add / update): no need to subtract the
  parent chain's rotation yourself, even under mirrored parents.
- **Palette changes are one op:** `recolor` with a `map` (exact colours) or an `hsl` shift, by
  part ids, tag or all parts. The message counts the changes per part and lists map entries that
  matched nothing.
- **One clip per state:** `compose` bakes layered animations (idle + a talk overlay + a blink)
  into one animation; its message says which tracks were copied exactly and which were sampled.
  Act on its between-samples `WARNING` (the `fps` it names) before shipping the clip.
- **Rigid accessories follow, they do not nest:** attach a hat or glasses next to the head warp
  (on the same bone) and run `follow`; rerun it whenever the head turn changes. Its residuals say
  how exact the result is at and between keyforms.
- **Verify visually** after rig changes: render a sweep sheet of the parameters you bound.

Library imports preserve existing avatar projects. Customize generated rigs through `avatar.json` post ops as described in [AVATAR.md](AVATAR.md), then rebuild with `library rig` to refresh the build fingerprints. See [LIBRARY.md](LIBRARY.md).


### act

`act` authors a numeric anticipation/main/overshoot/settle/hold/release animation. Required fields:
`animation`, `target`, `from`, `to`. Optional `t`, `duration`, `anticipation`, `overshoot`, `settle`,
`hold`, `release`. Parameter keys, including overshoot, must remain in range.
See [GESTURES.md](GESTURES.md#act-motion-curve) for timings and an executable JSON example.
