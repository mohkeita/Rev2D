# Rev2D example models

Five ready-to-run models. Each is a template (`rev2d new my.r2d.json --template <name>`) and a
reference for authoring techniques: open the JSON next to this page and copy what you need.

| Example | File | Canvas | What it shows |
| --- | --- | --- | --- |
| minimal | `minimal/minimal.r2d.json` | 256×256 | The smallest complete rig: 1 parameter, 1 bone, 1 warp, 2 parts, 1 binding, 1 animation. Start here. |
| hana | `hana/hana.r2d.json` | 512×640 | Live2D-style anime bust: 3×3 head-turn warp grid, eye/mouth path morphs, iris masks, hair physics, layered animations (a `once` wink, an additive talk). |
| robot-arm | `robot-arm/robot-arm.r2d.json` | 640×480 | Spine-style skeleton: two-bone IK with softness, rigid bone-parented plates, skinned rubber boot and cable, gripper, a claw gait built from one track shifted by `offset`. |
| slime | `slime/slime.r2d.json` | 400×400 | Squash & stretch with warp keyforms, jump (one-shot + loop), a blink made for `once` layering, add/multiply blending, events. |
| textured | `textured/textured.r2d.json` | 512×384 | Bitmap textures: atlas crops on image grids bent by warps, textured mesh with uvs, texture-alpha mask. |

## Feature matrix

| Feature | minimal | hana | robot-arm | slime | textured |
| --- | :-: | :-: | :-: | :-: | :-: |
| Parameters driving bindings | ✓ | ✓ | ✓ | ✓ | ✓ |
| Warp keyforms (sparse or full point lists) | ✓ | ✓ | | ✓ | ✓ |
| Nested warps (warp parented to a warp) | | ✓ | | | |
| Warp parented to a bone | ✓ | ✓ | | ✓ | |
| 2D / 3D binding grids (2+ parameters) | | ✓ | | | ✓ |
| Several bindings summed on one property | | ✓ | ✓ | ✓ | ✓ |
| Path morphs (`shape.d` keyforms) | | ✓ | | ✓ | |
| Ellipse / polygon field bindings (`shape.ry`, `shape.points`) | | ✓ | | ✓ | ✓ |
| Opacity bindings | | ✓ | | ✓ | |
| Bone rotation / translation bindings | | ✓ | ✓ | ✓ | ✓ |
| Two-bone IK | | | ✓ | | |
| IK softness (`softness`) | | | ✓ | | |
| Skinning with auto weights (`skin`, `detail`) | | | ✓ | | |
| Physics → parameters | | ✓ | ✓ | | |
| Masks (`mask`) | | ✓ | ✓ | ✓ | ✓ |
| Mask by texture alpha | | | | | ✓ |
| Gradients (linear / radial) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Strokes | ✓ | ✓ | ✓ | ✓ | ✓ |
| Stroke-only open paths (fill `transparent`) | | ✓ | ✓ | | |
| Blend modes | | | `add` `multiply` | `add` `multiply` | `screen` |
| Textures: `image` with `crop` + `cols`/`rows` | | | | | ✓ |
| Textures: `mesh` with `uvs` | | | | | ✓ |
| Looping animations | ✓ | ✓ | ✓ | ✓ | ✓ |
| One-shot animations (`loop: false`) | | ✓ | | ✓ | ✓ |
| One-shots that start and end at the defaults (layer with `once`) | | ✓ | | ✓ | |
| Ease `smooth` (automatic tangents) | | ✓ | ✓ | | ✓ |
| Track `offset` (one track's keys replayed out of phase) | | | ✓ | | |
| Animation events | | | ✓ | ✓ | |

## minimal

`Lean` → one binding on `warp:bodyWarp.offsets` (sparse keyforms: only the moved lattice points are
listed; `{}` is the rest pose) → the warp bends `body` and `eye`. The warp is parented to bone `root`,
so moving the bone moves everything. Animation `sway` drives `Lean`.

## hana

A Live2D-style bust built only from vector parts. Parameters follow Live2D names: `AngleX` `AngleY`
`AngleZ` `EyeLOpen` `EyeROpen` `EyeBallX` `EyeBallY` `BrowLY` `BrowRY` `MouthOpen` `MouthForm` `Cheek`
`BodyAngleX` `Breath`, plus the physics outputs `HairFront` `HairSide` `HairBack`.
**L/R suffixes mean the character's left/right, so `L` parts are on the screen right.** The signs
are the standard ones of SPEC §3.1: `AngleX > 0` turns the face toward the screen right, `AngleY > 0`
looks **up** (the features move to smaller y), `AngleZ > 0` tilts clockwise, `EyeBallX/Y > 0` look
right / up.

- **Head turn**: binding `headTurn` puts a 3×3 keyform grid (`AngleX` × `AngleY` ∈ {-30, 0, 30}) on the
  8×8 `faceWarp`. Offsets come from a pseudo-sphere: the face center moves most, the silhouette least,
  so the far side compresses and the near side widens. `backHairWarp` moves the opposite way (parallax).
- **Tilt / lean / breath**: `AngleZ` rotates bone `head`, `BodyAngleX` rotates bone `body` and turns
  `bodyWarp`, `Breath` lifts the shoulders (warp) and the neck (bone `neck.x`). `bodyWarp` reaches
  below the canvas (to y 725) because the blouse does: every warp covers the parts it carries.
- **Eyes**: `eyeWhite*` paths morph closed with `Eye*Open`; iris, pupil, glow and highlights are masked
  by the eye white, so they disappear as the lids meet. The closed eye white keeps a hairline sliver
  hidden under the lash instead of collapsing to zero area. `lash*` bands share the lid curve, so lash
  and eye white stay glued at every value. Gaze moves `eyeBallWarp`, a warp nested in `faceWarp`.
- **Mouth**: one binding with 6 path keyforms over `MouthOpen` × `MouthForm` (all `M C C Z`); `teeth`
  and `tongue` are masked by `mouth` and fade in with opacity bindings.
- **Hair physics**: groups `hairFront`, `hairSide`, `hairBack` take `AngleX` / `BodyAngleX` (pivot x)
  and `AngleZ` (pivot angle) and write the swing into the hair parameters, which bend the hair warps.
- **Animations**: `idle` (seamless 4 s loop with one blink), `blink` and `wink` (one-shots), `talk`
  (2 s loop), `nod` (one-shot), `look_around` (6 s loop). The sways of `idle` and the nods of `talk`
  use ease `smooth`: the curve passes through every key with continuous speed (Catmull-Rom tangents,
  closed over the loop), where `inOutSine` would stop at each key.
- **Layering**: `blink` and `wink` start and end at the parameter defaults, so they layer with `once`
  and hand the face back when they end: `--anim idle --anim "wink,once,start=1"` winks at 1 s (left
  eye shut, right eye squinting, smile and blush), `--anim idle --anim blink,once,start=1.5` adds one
  extra blink. A `once` layer overrides only the parameters it keys, and only inside its window.
  `talk` is designed for mode `add`: its head nods are centered on the defaults, so
  `--anim look_around --anim talk,add` keeps the head motion and adds the nods, and its 2 s cycle
  divides both the 4 s `idle` and the 6 s `look_around`, so the stacked loops still close. Over a talk
  layer, which also drives the mouth, add the wink too:
  `--anim look_around --anim talk,add --anim "wink,add,once,start=1.5"`.

## robot-arm

Spine-style: bones point along their local +x; plates are authored in setup space on top of their bone
and parented to it (rigid). Constraint `armIk` bends `upperArm` + `foreArm` so the wrist reaches bone
`ikTarget`, which `ReachX` / `ReachY` move. Its `softness` is 30 px (about 10% of the 285 px reach): a
target farther than 255 px is pulled in along a smooth curve, so the elbow straightens gradually and
only 30 px beyond the reach instead of snapping straight at it; the price is that the wrist trails the
target a little there (7.5 px at full reach). `elbowBoot` and its `elbowBootRibs` are skinned to both arm
bones with auto weights and `detail`, so the rubber bends at the elbow. The `cable` strip is skinned to the
chain `cable1..3`; physics group `cableSwing` writes each segment's swing into `Cable1..3`, and the chain
bone rotations subtract the parent swing with a second binding (bindings on one property add up).
`Grip` curls the three claws, `TapTop` / `TapMid` / `TapBot` lift one claw each (a second binding on
the same bones, so they add to `Grip`), `Wrist` turns the hand.

Animations: `idle`, `reach` (events `grab`, `release`; the target stays within reach and gets to 99%
of it at the grab, where the soft elbow stays slightly bent), `wave`, and `drum`, a walk-like gait:
the hand hovers over the floor and the claws tap in turn. The gait is one set of keys: `TapMid` and
`TapBot` replay the `TapTop` track with `offset` 0.3 s and 0.6 s (a third and two thirds of the 0.9 s
cycle), the way a walk reuses one leg's keys for the other with `offset = duration / 2`. Meanwhile
the hand circles a little over the claws: `ReachX` and `ReachY` have three keys each with ease
`smooth`, which passes through them on a round loop where `inOutSine` would stop at every key and
trace a triangle.

## slime

`Squash` and `Lean` are two bindings on the same warp that add up; the bottom lattice row stays on the
ground. `Jump` lifts bone `body` (`bone:body.y`, 140 px at 1, so the glow around it stays on the
canvas); the `shadow` is parented to `root`, so it stays on the floor, shrinks and fades (a `multiply`
blend over the floor). `glow`, `core` and `sparkles` use `add` blending driven by `Glow`. Eyes blink by
binding `shape.ry`; the mouth morphs between two paths. Animations: `idle`, `blink` (a one-shot made
for `once` layering: only `EyeOpen`, from 1 back to 1, so `--anim idle --anim blink,once,start=0.5`
adds a blink and hands the eyes back to `idle`), `jump` (one-shot: anticipation, stretch, apex, impact,
settle; events `takeoff` and `land`) and `jump_loop` (continuous hopping).

## textured

Koinobori (carp streamers). `koiRed` and `koiBlue` are `image` shapes cropping two halves of
`koi-atlas.png` (the blue one drawn smaller), subdivided into 16×4 grids so their warps bend them
smoothly. `Wind` droops them (0) or flies them (1); in calm air the red carp hangs steeply and the blue
one, attached lower, sags less, so its tail stays on the canvas. A traveling wave comes from two
keyform sets, `WaveSin` and `WaveCos`, animated 90° apart with quarter-period keys 0, 1, 0, -1 and ease
`smooth`, which keeps its speed through zero like a sine (each is a 2D binding with `Wind`, so calm air
also stops the wave). `pinwheel` is a `mesh` fan whose `uvs` map onto `pinwheel.png`; `Spin` rotates
its bone. `sheen` uses `screen` blending and is masked by `koiRed`, so the texture's alpha clips it.
`CloudDrift` slides the clouds 60 px either way, inside the canvas. Animations: `flutter` (loop),
`gust` (calm to windy). The PNGs are generated by `scripts/gen-textures.ts`.

## Commands

```sh
rev2d validate examples/hana/hana.r2d.json --strict
rev2d info examples/hana/hana.r2d.json
rev2d render examples/hana/hana.r2d.json -o out/hana.png --scale 2
rev2d render examples/hana/hana.r2d.json -o out/hana-rig.png --overlay bones,warps,labels
rev2d render examples/hana/hana.r2d.json -o out/hana-look.png --param AngleX=30 --param EyeBallX=1
rev2d sheet examples/hana/hana.r2d.json -o out/turn.png --sweep AngleX=-30:30:5 --sweep AngleY=30,0,-30 --scale 0.5
rev2d sheet examples/hana/hana.r2d.json -o out/mouth.png --sweep MouthForm=-1:1:3 --sweep MouthOpen=0:1:3
rev2d sheet examples/hana/hana.r2d.json -o out/params.png --overview AngleX,AngleY,AngleZ,EyeLOpen,MouthOpen,MouthForm --steps 3 --scale 0.25
rev2d sheet examples/hana/hana.r2d.json -o out/talk.png --anim look_around --anim talk,add --frames 8 --viewbox 96,50,320,390 --scale 0.4
rev2d sheet examples/hana/hana.r2d.json -o out/wink.png --anim idle --anim "wink,once,start=1" --times 0.9,1.05,1.2,1.4,1.6,1.8,2 --columns 7 --viewbox 130,120,252,260 --scale 0.5
rev2d analyze examples/hana/hana.r2d.json --anim idle --warmup 8
rev2d analyze examples/hana/hana.r2d.json --anim look_around --anim talk,add --warmup 10
rev2d analyze examples/hana/hana.r2d.json --anim idle --anim "wink,once,start=1" --warmup 10
rev2d render examples/hana/hana.r2d.json -o out/hana-hair.png --param HairFront=1
rev2d sheet examples/slime/slime.r2d.json -o out/jump.png --anim jump --frames 10
rev2d sheet examples/slime/slime.r2d.json -o out/blink.png --anim idle --anim "blink,once,start=0.5" --times 0.45,0.52,0.56,0.62,0.7,0.85 --columns 6 --viewbox 100,170,200,170 --scale 0.6
rev2d gif examples/robot-arm/robot-arm.r2d.json -o out/reach.gif --anim reach
rev2d sheet examples/robot-arm/robot-arm.r2d.json -o out/drum.png --anim drum --frames 9 --viewbox 300,220,240,210 --scale 0.6 --warmup 9
rev2d analyze examples/robot-arm/robot-arm.r2d.json --anim reach --warmup 8
rev2d inspect examples/robot-arm/robot-arm.r2d.json --param ReachX=0.5 --json
rev2d inspect examples/robot-arm/robot-arm.r2d.json --anim reach --times 0:4:9 --track ik:armIk,param:ReachX,physics:cableSwing.Cable1
rev2d render examples/robot-arm/robot-arm.r2d.json -o out/far.png --param ReachX=1,ReachY=-1
rev2d new my-koi.r2d.json --template textured   # copies the model and its textures
rev2d edit my-koi.r2d.json
```

`rev2d edit` writes every change back to the file it opened, so edit a copy made with `rev2d new`,
not the shipped example.

Physics outputs (`HairFront`, `Cable1`, ...) are written by the simulation every frame, but an
explicit value wins: `--param HairFront=1` (or a sweep of `HairFront`, MCP `params`, a pinned
editor slider) shows exactly that value, and `inspect` lists the output as overridden. No
`--no-physics` is needed to check an output's binding.

The `--track` table above follows the robot arm's IK through `reach`: the extension peaks at 0.99 at
the grab (t = 1 s, `ReachX` 0.8), where the soft chain keeps the elbow slightly bent and the wrist
trails the target by 6.2 px; everywhere else the error is 0 or a few px. `analyze` counts those
frames as nearly straight (extension > 0.98) but adds no note, because the chain has softness;
with `"softness": 0` it would warn that the elbow may snap. `--param ReachX=1,ReachY=-1` puts the
target beyond the reach (extension 1.08): that pose shows the out-of-reach IK note in `render`,
`sheet` and `analyze`.

Every example rests each bound property at its setup value when all parameters are at their
defaults, so the numbers you read in a part are what the default pose shows.

## Analysis

Every animation of every example passes `rev2d analyze` without a finding: no physics output is
clamped, no IK chain goes out of reach or straightens without softness, and no part leaves the
canvas during an animation. Parts that extend past the edge in every frame (the floors, the hills,
the pole, hana's bust) are framing: `analyze` lists them under BOUNDS as `always` and does not note
them. Give looping animations of the models with physics (hana, robot-arm) `--warmup 10`, so the
steady state is measured instead of the settling from rest. The layer stacks suggested above analyze
clean too (`look_around` + `talk,add`, `idle` + `wink,once,start=1`, slime `idle` +
`blink,once,start=0.5`). `test/examples.test.ts` checks all of this.

One note is intentional: textured `flutter` wraps `Spin` (one full pinwheel turn per loop) and
`Sheen` (the light band is off the carp at both 0 and 1), so `analyze` reports those parameters
jumping from 1 to 0 at the loop seam and adds that the rendered frames match. A parameter that counts
turns loops this way; a jump that also shows in the pixels would be a real seam.

## Regenerating

The shipped files are generated by builders in `scripts/examples/` (they compute keyform lattices,
mirrored features and bone-space geometry). The builders are the source of truth:
`test/examples.test.ts` checks that every model and texture is exactly its builder's output, so change
an example in its builder and regenerate. Copies made with `rev2d new` are ordinary model files you
edit freely.

```sh
npx tsx scripts/gen-textures.ts     # examples/textured/*.png
npx tsx scripts/build-examples.ts   # examples/*/*.r2d.json (validated first; not written on any diagnostic)
npx tsx scripts/render-examples.ts  # out/examples/<name>/: frame, overlay, sweeps, grids, sheets, GIFs
npx vitest run test/examples.test.ts
```

## Studio development fixtures

Original vector full-body poses and an empty room are generated by `scripts/examples/figure.ts` and `room.ts`. Run `node --import tsx scripts/demo-library.ts out/demo-phase0/synthetic` to create their local asset library, keying metrics and review sheets. See [LIBRARY.md](../docs/LIBRARY.md); no user artwork is checked in.
