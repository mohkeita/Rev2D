# Rev2D Model Format & Evaluation Semantics (v1)

Rev2D is a 2D rigging/animation system in the spirit of Live2D Cubism and Spine, designed so that
**AI agents can author, inspect and verify models as plain text**. A model is one JSON file
(`*.r2d.json`). Everything is addressed by string ids, and every animatable property has a single
address grammar. Evaluation is deterministic: the same model + inputs always produce the same pixels.

The authoritative schema is `src/core/schema.ts` (JSON Schema: `rev2d schema`).

Models generated from one illustration (`rev2d avatar build`) are ordinary v1 models in canvas =
image pixels. Their source of truth is the avatar spec `avatar.json`, a separate format described in
[AVATAR.md](AVATAR.md) (`rev2d avatar schema`).

---

## 1. Coordinate system

| Concept | Convention |
| --- | --- |
| Setup space | The canvas in pixels, `meta.width × meta.height`. Origin **top-left**, **+x right, +y down** (like SVG/images). |
| Angles | Degrees. **Positive = clockwise on screen** (SVG `rotate()`). 0° points along +x. |
| Geometry | All part & warp geometry is written in **setup space**: absolute canvas coordinates of the rest pose. You draw the character as it appears on the canvas, then attach pieces to bones/warps. |
| Bones | Bone `x, y, rotation, scale` are **local to the parent bone** (root bones: setup space). |

## 2. File layout

```jsonc
{
  "format": "rev2d", "version": 1,
  "meta": { "name": "demo", "width": 512, "height": 512, "background": "transparent", "fps": 30 },
  "parameters": [ ... ],   // named scalar controls (Live2D-style)
  "textures":   [ ... ],   // optional PNG images
  "bones":      [ ... ],   // transform hierarchy (Spine-style)
  "warps":      [ ... ],   // lattice deformers (Live2D warp deformers)
  "parts":      [ ... ],   // drawables (shapes/images), array order = default draw order
  "bindings":   [ ... ],   // parameter -> property keyforms
  "ik":         [ ... ],   // inverse kinematics constraints
  "physics":    [ ... ],   // pendulum physics driving parameters
  "animations": [ ... ]    // timelines
}
```

Unknown keys are errors (catches typos). Ids match `^[A-Za-z_][A-Za-z0-9_-]*$` and are unique per kind.
Bones and warps also share **one id namespace**, because either can be a `parent`: a bone and a warp
with the same id is a validation error (`duplicate-id`), and a `parent` naming such an id is rejected
as ambiguous at load. `parent` may be omitted (or `null` for bones) for model space.

## 3. Objects

### 3.1 Parameters
`{ "id": "AngleX", "min": -30, "max": 30, "default": 0, "group": "Face" }`
A parameter is a named number clamped to `[min, max]`. Parameters are the **main control surface**:
animations and physics set parameters; bindings turn parameter values into deformations. Prefer
animating parameters over animating bones directly — it keeps rigs reusable (like Live2D motions).

**Naming and sign conventions.** Names follow the Live2D Cubism standard parameters (without the
`Param` prefix); the signs below are the convention of the shipped examples (verified on
`examples/hana`) — use them so motions, physics and tools can be shared between models. "Left/right"
in ids is the **character's**: the character faces the viewer, so `L` (the character's left) is on the
**screen's right**. Signs are what the viewer sees:

| Parameter | Range | Positive value means |
| --- | --- | --- |
| `AngleX` | −30..30 | head turns toward **screen right** (the character's left): features slide to +x |
| `AngleY` | −30..30 | head looks **up**: features slide up (−y on the canvas) |
| `AngleZ` | −30..30 | head tilts **clockwise** on screen (top of the head toward screen right) |
| `BodyAngleX` | −10..10 | upper body turns/leans toward screen right |
| `EyeBallX` / `EyeBallY` | −1..1 | gaze toward screen right / up |
| `EyeLOpen` / `EyeROpen` | 0..1, default 1 | eye open (0 = closed); `L` = the eye on screen right |
| `BrowLY` / `BrowRY` | −1..1 | brow raised (−1 = lowered/angry) |
| `MouthOpen` | 0..1 | mouth open |
| `MouthForm` | −1..1 | smile (−1 = frown) |
| `Breath` | 0..1 | inhaled |

Note the vertical axis: **`AngleY > 0` looks up although canvas +y points down**, so an AngleY
binding moves face features by a *negative* y offset at its positive end. Keyforms at a parameter's
default must equal the setup values (the rest pose).

### 3.2 Bones
`{ "id": "head", "parent": "neck", "x": 0, "y": -40, "rotation": 0, "scaleX": 1, "scaleY": 1, "length": 60 }`

`world = parentWorld · translate(x, y) · rotate(rotation) · scale(scaleX, scaleY)`.
The bone joint is the world position of its local origin; the tip is `joint + length` along local +x.
A root bone with `x=256, y=400` sits at canvas pixel (256, 400).

### 3.3 Warps (lattice deformers)
`{ "id": "faceWarp", "parent": "head", "rect": [176, 120, 160, 180], "cols": 3, "rows": 3 }`

A grid of `(cols+1) × (rows+1)` control points over `rect` (setup space); `cols` and `rows` are whole
numbers from 1 to 64 (default 2). Point index
`i = row * (cols + 1) + col`, rest position `(x + w·col/cols, y + h·row/rows)`.
Bind `warp:<id>.offsets` (a point list of offsets from rest, setup-space pixels) to bend everything
inside. Children (parts or warps whose `parent` is this warp) are mapped **bilinearly** through the
deformed cell that contains them (points outside the rect extrapolate from the nearest edge cell).
Warps can be parented to a bone (the lattice follows the bone) or to another warp (nested deformation).
A nested warp's `rect` should lie **inside its parent warp's `rect`**: lattice points outside the
parent are extrapolated from the parent's edge cells, so they drift or stretch more than the parent's
border (validation warning `warp-outside-parent`, which reports the overhang per side and a covering
rect). Enlarge the parent, shrink the child, or parent the child to the bone the parent follows.
The same holds for **parts** parented to a warp: every vertex outside the rect is extrapolated
(validation warning `part-outside-warp`). The check measures the part's setup outline (ellipse and
rounded-rect outlines as drawn, rotation included; polygon points; the flattened path; mesh vertices
used by a triangle; the image rect, when its size is known from `w`/`h`, `crop` or the texture's
`width`/`height`) grown by the stroke (half its width for `align: "center"`, all of it for
`"outside"`, nothing for `"inside"`), tolerates 0.5 px, and reports the overhang per side, a covering
rect (only the overhanging sides move, outward to whole pixels) and where else to parent the part (the
nearest ancestor warp whose rect contains it, else the bone the warp follows). Enlarging a warp's
`rect` moves its rest lattice points, so re-check its offset keyforms afterwards.
`Rig.mapPoint` (§9.1) maps any setup-space point through a bone, warp or part the way attached parts move.

### 3.4 Parts (drawables)
```jsonc
{ "id": "mouth", "parent": "faceWarp",
  "shape": { "type": "ellipse", "cx": 256, "cy": 250, "rx": 14, "ry": 3 },
  "fill": "#a0303a", "stroke": { "color": "#40101a", "width": 2 },
  "opacity": 1, "tint": "#ffffff", "blend": "normal", "z": 5,
  "mask": ["faceSkin"], "maskInvert": false }
```
Shapes (setup space):

| type | fields | notes |
| --- | --- | --- |
| `ellipse` | `cx cy rx ry rotation segments? detail?` | |
| `rect` | `x y w h radius detail?` | rounded corners with `radius` |
| `polygon` | `points [x0,y0,...] detail?` | simple polygon, no self-intersections |
| `path` | `d tolerance detail?` | SVG path data `M L H V C S Q T A Z` (abs/rel). Each subpath filled separately (no holes). |
| `mesh` | `vertices triangles uvs? texture?` | raw triangle mesh |
| `image` | `texture x y w? h? crop? cols rows` | textured quad grid (cols×rows cells); omitted `w`/`h` = crop size, else texture size |

**Curve flattening.** Path curves (`C S Q T`) and arcs (`A`) become polylines that stay within
`tolerance` px of the curve **and** turn at most about 15° per segment (sub-steps are refined where the
curvature concentrates, ≤ 16.5°; genuine cusps stay sharp). So small curves stay round (a 3 px circle
is at least a 24-gon) while large curves are governed by the distance tolerance alone. Ellipses use
`segments` (default: one per ~4 px of perimeter, 16..128); rounded-rect corners a 0.1 px tolerance.

`detail` (px) = maximum triangle edge length: set it (e.g. 8–16) on parts that sit in warps or are
skinned so they deform smoothly. Fill: color string, `{type:"solid"}`, `{type:"linear", from, to, stops}`
or `{type:"radial", center, radius, stops}`; gradients are in setup space, evaluated per vertex.
Stroke: `{color, width, join: round|miter|bevel, align: center|inside|outside}`, drawn above the fill.

Parent: a bone (rigid follow), a warp (lattice deformation; keep the part, stroke included, inside the
warp's `rect`, §3.3 `part-outside-warp`), or none (model space).
`skin: { bones: [...], weights: "auto" | [[...]], falloff: 2 }` = linear blend skinning across several
bones (use instead of `parent`). `"auto"` weights come from the distance of each vertex to each bone
segment in the setup pose.

**Visibility and draw order.** A part is drawn when its static `visible` is true, its evaluated
`visible` is ≥ 0.5 and its opacity is > 0 (bindings/tracks can hide a visible part but cannot show a
part with `"visible": false`; animate `opacity` for show/hide). Drawn parts are sorted by evaluated `z`
(bindable), ties by array index; each emits its fill, then its stroke. Colors = paint × tint, alpha ×
tint alpha × opacity. Blend modes: `normal add multiply screen` (premultiplied alpha).

**Masks.** `mask: [ids]` clips the part to the **union coverage** of the listed parts in the current
pose: their deformed fill and stroke geometry weighted by paint alpha (× texture alpha), combined as
`c = 1 − Π(1 − aᵢ)` and multiplied into the part per sample (soft, antialiased edges). The mask parts'
own opacity, tint, visibility, blend and `mask` are ignored. If the mask parts produce **no geometry**
in the pose (e.g. a rect bound to `h = 0`), `c = 0` and the part draws **nothing**. `maskInvert: true`
multiplies by `1 − c` instead: draws only outside, i.e. fully when the masks are empty. `mask: []` is
the same as no mask.

### 3.5 Textures
`{ "id": "armTex", "path": "arm.png" }` — PNG relative to the model file or a `data:image/png;base64,` URI.

## 4. Property addresses

One grammar everywhere (bindings, animation tracks, CLI `--set`, ops, MCP):

| Address | Type | Meaning |
| --- | --- | --- |
| `param:<id>` | number | parameter value (**animation tracks only**) |
| `bone:<id>.x` `.y` `.rotation` `.scaleX` `.scaleY` `.length` | number | local bone values |
| `warp:<id>.offsets` | points | control point offsets from rest (setup value = all zeros) |
| `part:<id>.opacity` `.z` | number | |
| `part:<id>.visible` | boolean | |
| `part:<id>.tint` `.fill` `.stroke.color` | color | `fill` only for solid fills |
| `part:<id>.stroke.width` | number | |
| `part:<id>.shape.<field>` | per shape | ellipse `cx cy rx ry rotation` · rect `x y w h radius` · polygon `points` · path `d` · mesh `vertices` · image `x y w h` |
| `ik:<id>.mix` | number | |

Values in JSON: numbers; point lists `[x0,y0,x1,y1,...]` (full length) **or sparse maps**
`{"4": [x, y], "5": [x, y]}` (only listed points change, others keep setup values); color strings;
SVG path strings with **the same commands in the same order** as the setup path (letters and case;
an implicit repeat counts as its command, e.g. `M0 0 5 5` = `M0 0 L5 5`), whose numbers interpolate so
a mouth can morph between path shapes; booleans.

**All values are absolute** (what the property should be), except warp offsets which are offsets from
the rest lattice. The setup value of an omitted image `w`/`h` is the size the image is drawn with
(crop size, else texture size).

## 5. Bindings (parameter → property keyforms)

```jsonc
{ "target": "part:mouth.shape.ry", "params": ["MouthOpen"],
  "keys": [ { "at": [0], "value": 2 }, { "at": [1], "value": 16 } ] }
```
- `params`: 1–3 parameters. `keys[].at` has one value per parameter.
- Keys must form a **full grid**: the Cartesian product of the distinct `at` values of each parameter
  (e.g. AngleX ∈ {-30,0,30} × AngleY ∈ {-30,0,30} → 9 keys).
- Evaluation: per parameter find the bracketing grid values (clamped at the ends), then
  **multilinear interpolation** of the 2^N surrounding keyforms. `interpolation: "step"` holds the lower key.
- **Combination**: several bindings/tracks on one property combine by summing deltas from setup:
  `final = setup + Σ weight_i · (value_i − setup)` (element-wise for points/colors/paths). So an
  `AngleX` binding and an `AngleY` binding on the same warp simply add up.
- **Post-processing** of the combined value: color channels clamp to [0, 1]; `opacity` and `ik mix`
  clamp to [0, 1]; `visible` is true when ≥ 0.5; `bone length`, `stroke.width` and shape
  `rx ry w h radius` clamp to ≥ 0 (a zero-size shape draws nothing); path arc flags (large-arc, sweep)
  snap to 0/1 (≥ 0.5 → 1), so an arc morph switches halfway. Other numbers are not clamped (a negative
  scale mirrors).
- A binding whose keyforms **all** equal the target's setup value (within 1e-9, element-wise for
  points, colors and path numbers; for warp offsets: all zero) changes nothing: validation info
  `binding-no-effect`. Usually the values were written as offsets of 0 instead of absolute values,
  or the binding names the wrong target.

## 6. Animations

```jsonc
{ "id": "walk", "duration": 1, "loop": true,
  "tracks": [
    { "target": "param:LegL", "keys": [
        { "t": 0, "v": -20, "ease": "smooth" }, { "t": 0.5, "v": 20, "ease": "smooth" }, { "t": 1, "v": -20 } ] },
    { "target": "param:LegR", "offset": 0.5, "keys": [ /* the same keys as LegL */ ] } ],
  "events": [ { "t": 0.5, "name": "footstep", "data": { "foot": "L" } } ] }
```

### 6.1 Keys, easing and sampling
- `ease` shapes the segment **from this key to the next**: `linear step inSine outSine inOutSine inQuad
  outQuad inOutQuad inCubic outCubic inOutCubic inBack outBack inOutBack outElastic outBounce smooth` or
  `[x1, y1, x2, y2]` cubic-bezier. `step` holds the key's value until the next key.
- Before the first key the first value holds; after the last key the last value holds (in a looping
  animation too: the gap between the last key and `duration` is not interpolated back to the first
  key — put a key at `t = duration` equal to the first for a seamless loop).
- Looping animations wrap time (`t mod duration`); non-looping clamp to `[0, duration]`.

### 6.2 `smooth` ease (automatic Catmull-Rom tangents)
A segment whose **start key** has `"ease": "smooth"` is a cubic Hermite curve through its two keys with
tangents computed from the neighbouring keys (Catmull-Rom for non-uniform key times). Tangent of key
`i` in value units per second, with `p` = previous and `n` = next key:

- both neighbours: `m_i = (v_n − v_p) / (t_n − t_p)` (so velocity is continuous through every inner key,
  even with uneven key spacing);
- first / last key of the track: one-sided, `m_0 = (v_1 − v_0) / (t_1 − t_0)` and likewise at the end
  (two smooth keys alone interpolate exactly linearly);
- **closed loops**: in a looping animation, when the track's first key is at `t = 0` and its last at
  `t = duration`, those two keys are the same instant of the loop, so neighbours wrap: key 0's previous
  neighbour is the second-to-last key at `t − duration` and the last key's next neighbour is key 1 at
  `t + duration`. Both ends get the same tangent, so a cycle whose last value equals its first (a walk)
  has **no velocity jump at the seam**. Other looping tracks use one-sided ends.

Segment value at progress `s = (t − t_i) / Δ`, `Δ = t_{i+1} − t_i`:
`h00·v_i + h10·Δ·m_i + h01·v_{i+1} + h11·Δ·m_{i+1}` with `h00 = 2s³−3s²+1`, `h10 = s³−2s²+s`,
`h01 = −2s³+3s²`, `h11 = s³−s²`. Numbers, point lists, colors and path numbers are interpolated
element-wise. The curve can overshoot between keys (colors, opacity and parameters are then clamped as
usual, §5/§9). Tangents use the neighbours' values whatever their own eases; only segments whose start
key is `smooth` use the curve.

### 6.3 Track `offset`
`"offset": s` (seconds, default 0) samples the track at `local time − offset`. In a looping animation
the result wraps into `[0, duration)`, so the opposite leg of a walk reuses the same keys with
`offset = duration / 2` (half a cycle later: `v_R(t) = v_L(t − duration/2)`). In a non-looping animation
the shifted time is not wrapped: before the first key the first value holds, after the last the last
(an offset that moves the sampled window `[−offset, duration − offset]` past all keys makes the track
constant: validation warning `track-offset-no-effect`). Events are not shifted.

### 6.4 Layers
Several animations play together as **layers** (`PoseOptions.animations`, applied in order; a string
is `{ id }`):

```ts
{ id: 'talk', weight?: 1, mode?: 'override' | 'add', start?: 0, time?: number, hold?: true }
```

- **Clock**: a layer's unwrapped local time is `time − start` on the global clock, or its explicit
  `time` (then `start` is ignored). Physics steps (§8) advance explicit-time layers together with the
  global clock. The local time is then wrapped (looping) or clamped (non-looping) as in §6.1.
- **`mode`** (param tracks): `'override'` (default) blends toward the track value,
  `p = p + weight·(v − p)`, so later layers win; `'add'` adds the track's offset from the parameter's
  default, `p = p + weight·(v − default)`, so a gesture layers on top of what is below (talk nods over
  an idle sway, a breath over any pose). Author additive animations around the default (keys at the
  default = no change). All layers are applied first; parameters are clamped to `[min, max]` after the
  last layer. Non-param tracks always contribute `weight·(v − setup)` (§5), whatever the mode.
- **`hold`**: `true` (default): outside `[0, duration]` a non-looping layer holds its first/last
  values, and a looping layer keeps looping (also before `start`). `false`: the layer contributes
  **nothing** — no values, no events — while its local time is before 0 or, for non-looping layers,
  after `duration` (both ends inclusive: at exactly `duration` it still applies its last keys). Use it
  for one-shot overlays: `['idle', { id: 'wink', start: 3, hold: false }]` winks at t = 3 and then hands
  the eye back to the idle blink.
- **Remix recipes**: idle + talk → `['idle', { id: 'talk', mode: 'add' }]` keeps idle's head motion and
  adds talk's; idle + one-shot → `['idle', { id: 'wave', start: t0, hold: false }]`; cross-fade → two
  override layers with complementary weights.
- The Player (sequential playback) and stateless poses use exactly the same layer semantics.

### 6.5 Events
Events appear in `pose.events` as `{animation, name, t, data?}`; layers with weight ≤ 0 or outside their
active window (`hold: false`, §6.4) report none. Event times are compared with the layer's unwrapped
local time (so `start` delays them; track `offset` does not). A stateless pose reports the events
exactly at each layer's time (±1e-6; looping: modulo `duration`, so an event at `duration` also fires
at 0; non-looping: against the unclamped time, so an end event fires once, not on every later frame).
The Player reports, per layer (position + animation id), every event crossed in `(previous, current]`
of the layer's clock, chronologically (looping: every crossed cycle counts, but a jump of more than one
cycle reports each event once; non-looping: nothing after `duration`; `hold: false` looping layers:
nothing before local time 0). A new layer, or one whose clock went backwards (including after a Player
reset), reports only the events exactly at its current time.

## 7. IK

`{ "id": "armIk", "bones": ["upperArm", "foreArm"], "target": "handTarget", "mix": 1, "bendPositive": true, "stretch": false, "softness": 0 }`
The goal is the target bone's world joint. Rotations are solved in each bone's parent frame.
- One bone: rotate it so its +x axis points at the target (exact for any invertible parent transform).
- Two bones (child must be a direct child of parent): law-of-cosines solve with `l1` = distance
  parent joint → child joint and `l2` = `child.length` × the child's world x scale. `bendPositive`
  bends the child clockwise relative to the parent in the parent bone's own frame (a mirrored frame
  flips the on-screen side). The tip lands exactly on a reachable target when the chain's parent world
  transform and the first bone's own scale are **similarity transforms** (uniform |scale|, mirroring
  allowed, no shear); the child's own scale may be anything. Non-uniform scale there changes `l1`/`l2`
  as the bones rotate, so the result is approximate. Out of reach (and without `stretch`), the tip lands
  on the ray toward the target at the nearest reachable distance (stretched `l1 + l2` or folded `|l1 − l2|`).

A target at the (parent) joint changes nothing. `mix` blends each rotation change along the shortest
angle (and the stretch scale linearly). Constraints are solved after bone transforms, in array order;
each sees the previous results.

**Softness** (two-bone only; px, default 0; one-bone IK ignores it — warning `ik-softness-one-bone`).
Without it, the elbow/knee angle changes ever faster as the target approaches full reach and then
snaps straight. With `softness = s` (limited to the reach `R = l1 + l2`), a target at distance `d`
beyond `R − s` is pulled in along the line to the root joint to

```
d' = d                        if d ≤ R − s
d' = d − (d − R + s)² / (4s)   if R − s < d < R + s     (quadratic ease-out, C1 at both ends)
d' = R                        if d ≥ R + s
```

so the chain straightens only once the target is `s` px **beyond** the reach, and its angle changes
smoothly. The price: from `R − s` on, the tip trails the target by `d − d'` (`s/4` at `d = R`, `s` at
`d = R + s`; `reached` is false there unless `stretch` is on). Typical: 5–15% of `R` (warning
`ik-softness-too-large` when `s ≥ R` in the setup pose).

**Stretch** (`"stretch": true`). One bone: when the target is farther than the bone's world length
`L`, the bone's local `scaleX` is multiplied by `d / L` so its tip reaches the target (needs
`length > 0`, else warning `ik-stretch-zero-length`). Two bones: the stretch factor is `k = d / R`
beyond full reach, or with softness `k = d / d'` from `R − s` on (the soft bend, scaled up so that the
tip always reaches the target while `k` grows smoothly from 1). The chain is scaled by `k` along the
bones: the first bone's `scaleX` so that `l1` becomes `k·l1` (exact also for a child joint off the
bone axis), and the child's `scaleX` so that its world length becomes `k·l2` whatever it inherits.
While the chain is still bent (soft zone) the child's attachments inherit a slight shear from the
parent's non-uniform scale. The scaled values show in `pose.bones[id].local.scaleX`; `mix` blends `k`.

**Diagnostics.** Every constraint appears in `pose.ik[id]` (also with mix 0):

| Field | Meaning |
| --- | --- |
| `reached` | the full solve (as if mix = 1) puts the tip within 0.01 px of the target. One-bone aim IK reaches only a target exactly one bone length away (or with stretch). |
| `error` | final distance tip → target in px, after mix, softness and stretch |
| `distance` | distance root joint → target in px |
| `maxReach` | unstretched reach in px: `l1 + l2` (one bone: its world length along the solved direction) |
| `extension` | `distance / maxReach` (0 when `maxReach` is 0): ≥ 1 = out of reach; 0.95–1 without softness = visible snapping risk |
| `bend` | two-bone only: final interior angle at the middle joint in degrees (180 = straight); omitted if a segment has zero length |
| `stretch` | only with `stretch: true`: applied factor after mix (1 = none) |

## 8. Physics (pendulums → parameters)

```jsonc
{ "id": "hair", "inputs": [ { "param": "AngleX", "type": "x", "weight": 1.5 } ],
  "outputs": [ { "param": "HairSway", "type": "angle", "scale": 1 } ],
  "segments": [ { "length": 40, "mass": 1 } ], "gravity": 980, "damping": 0.1, "stiffness": 0 }
```
Each group is a pendulum chain hanging from a pivot, stepped at a fixed **60 Hz**: step `k` happens at
time `k/60`, and a frame at time `t` shows step `n = ⌊60·t⌋`.
- **Step**: parameters are evaluated at the step time (§9 steps 1–3, so inputs see animations and
  explicit values). The pivot is placed at `(Σ x-inputs, Σ y-inputs)` px (`value · weight`) and
  rotated by Σ angle inputs (degrees); the rest direction is straight down rotated by that angle.
  Particles move by Verlet integration: velocity × `(1 − damping)` per step, gravity (+y, px/s²,
  mass-independent) and, with `stiffness`, a spring toward the particle's rest position on the straight
  chain (acceleration `stiffness / mass · offset`); then segment lengths are restored from the pivot
  outward.
- **Outputs** (of chain segment `segment`, default −1 = last): `angle` = signed angle of the segment
  from the rest direction (degrees, clockwise +); `x`/`y` = offset of the segment's end from its rest
  position (px, canvas axes). Multiplied by `scale`, clamped to the parameter range and **written**
  over the parameter (animated values included); explicit values are re-applied right after, so
  **explicit values always win** (§9). Groups run in array order, so later groups read earlier
  groups' outputs (or the explicit values that replace them) of the same step.
- **Start and time window**: a simulation starts at rest (every chain straight along its rest
  direction) at step `max(0, n − 3600)`, under the inputs at that step's time. So **stateless
  evaluation simulates at most the 60 s before `time`** (from t=0 while `time` ≤ 60); older inputs are
  forgotten. The Player steps incrementally from its previous update (so its state may keep history
  older than 60 s); when time goes backwards or jumps forward by more than 60 s it starts over exactly
  like a stateless pose.
- `physics: false` skips the simulation: output parameters keep their animated/default/explicit values.
- **Diagnostics**: `pose.physics[groupId].outputs` lists every output in order as
  `{ param, raw, value, clamped, overridden }`: `raw` = simulated value × `scale` before clamping,
  `value` = what this output makes the parameter (clamped `raw`, or the explicit value when
  `overridden`), `clamped` = `raw` was outside `[min, max]` (widen the range or lower `scale` if the
  swing flattens at the limits), `overridden` = an explicit `params` value replaced it. `pose.physics`
  is `{}` when physics is off or the model has none; the Player reports the same values as the
  stateless pose.

## 9. Evaluation pipeline (per frame)

1. Parameters start at their defaults.
2. Animation layers apply in order (§6.4; layers outside their active window are skipped): `param:`
   tracks blend (`override`) or add (`add`); other tracks are collected as contributions.
3. All parameters are clamped to `[min, max]`; then explicit values (the `params` option: CLI
   `--param`, sweeps, editor sliders), each clamped, replace them.
4. Physics (§8) advances to the current step and writes its output parameters (clamped); explicit
   values are then re-applied. **Explicit values always win**, over animations and physics alike.
5. The resulting values are the pose's `params`; bindings read them.
6. Every bound/animated property: `setup + Σ deltas` (bindings then animation contributions), then
   post-processing (§5).
7. Bones: local TRS → world transforms (parents first).
8. IK constraints adjust bone rotations (with stretch also scaleX; descendants updated) and report
   `pose.ik` (§7).
9. Warps (parents first): rest lattice + offsets, then deformed by the parent
   (bone: `boneWorld · inverse(boneSetupWorld)`; warp: bilinear mapping; none: identity).
10. Parts: geometry rebuilt from the effective shape (only if its shape fields changed), then deformed
    by skinning / parent bone / parent warp exactly like warp points.
11. Draw list (§3.4): drawn parts sorted by (z, index), fill then stroke; colors = paint × tint ×
    opacity; masked parts carry their mask geometry.

The "setup world" of a bone is its world transform from the unmodified setup values (no IK).

### 9.1 Pose and point mapping

`rig.pose(opts)` / `player.update(opts)` return a `Pose`:

| Field | Content |
| --- | --- |
| `time` | the frame time |
| `params` | final parameter values (after layers, clamping, physics and explicit values) |
| `bones[id]` | `world` matrix, joint `x y`, world `rotation` (degrees), `scaleX scaleY`, `tip`, final `local` values |
| `warps[id]` | deformed lattice `points` (world space, row-major), `cols`, `rows` |
| `parts[id]` | `visible`, `opacity`, `z`, `tint`, world `bounds [x, y, w, h]`, deformed `fill` / `stroke` positions |
| `drawOrder` | visible part ids, back to front |
| `properties` | final value of every bound/animated property, by address |
| `events` | §6.5 |
| `ik` | §7 diagnostics per constraint |
| `physics` | §8 diagnostics per group |

`rig.mapPoint(pose, parent, x, y)` returns where the setup-space point `(x, y)` is in `pose` when it is
attached to `parent`, exactly as a part vertex attached there moves:

| `parent` | Mapping |
| --- | --- |
| bone id | `boneWorld · inverse(boneSetupWorld)` |
| warp id | bilinear mapping through the warp's deformed lattice, which already includes its parent bone/warps (nested warps compose) |
| skinned part id | linear blend skinning over the part's `skin.bones` (`Σ wᵢ · boneWorldᵢ · inverse(boneSetupWorldᵢ) · p / Σ wᵢ`) with the weights a vertex at `(x, y)` would get: `"auto"` → `1 / (distance to the bone's setup segment + 1)^falloff` with the part's `falloff`; explicit rows → the row of the nearest setup mesh vertex. A setup vertex maps exactly onto the posed vertex |
| other part id | like the part's `parent` (bone or warp); unchanged for a part in model space |
| `null` | unchanged |

A bare id is looked up among bones and warps first, then parts (a part may share its id with a bone
or warp, e.g. a part and a bone both called `neck`); `bone:<id>`, `warp:<id>` or `part:<id>` picks the
kind explicitly. Use it to pin effects, hit points or overlays to a deforming model (a bolt on a skinned
cable: `mapPoint(pose, "cable", x, y)`), or to check where a feature ends up without rendering. An
unknown id throws `unknown parent "…" (not a bone, warp or part id) (did you mean "…"?)`; a prefixed one
names only its kind (`(not a part id)`), and an unknown prefix throws `unknown parent kind "…"`.

## 10. AI workflow

1. Write/modify JSON (or use `rev2d ops` with high-level edits).
2. `rev2d validate model.r2d.json` — every diagnostic has a JSON pointer, a code and a hint.
3. `rev2d render model.r2d.json -o out.png --overlay bones,labels,grid` — look at the result.
4. `rev2d sheet model.r2d.json --sweep AngleX` or `--anim idle` — verify motion in one image.
5. `rev2d inspect model.r2d.json --param AngleX=30 --json` — exact numbers (bone world transforms,
   part bounds) to check geometry without looking.

Reusable asset metadata uses a separate versioned `library.json` format, documented in [LIBRARY.md](LIBRARY.md). It references ordinary avatar projects and model files; it does not alter the model v1 schema.
