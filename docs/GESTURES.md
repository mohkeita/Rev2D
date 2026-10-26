# Acting: gestures, expressions and living idle

Acting uses standard avatar parameters in an ordinary version-1 model. The pure `src/gestures/`
module has no filesystem, browser DOM or network dependency. File operations live in `src/node/acting.ts`.

```sh
rev2d gesture list --json
rev2d expression list --json
rev2d gesture apply hero.r2d.json --gesture voila --id present --dry-run --json
rev2d gesture apply hero.r2d.json --gesture point_right --hold 1.5 --intensity 0.8
rev2d expression apply hero.r2d.json --expression surprised --t 1 --hold 1.2
rev2d sheet hero.r2d.json --anim point_right --frames 8 -o out/point.png
rev2d analyze hero.r2d.json --anim point_right
```

`apply` replaces only the animation with its generated id (name by default; expressions default to
`expression_<name>`). `--dry-run` returns the complete generated animation and diagnostics without
writing; rerunning the same operation is idempotent. Invalid CLI syntax is exit 2, invalid models or
acting options are exit 1. JSON output stays on stdout. Writes check for concurrent file changes.

## Libraries and controls

Gestures: `voila`, `point_left`, `point_right`, `point_up`, `shrug`, `think`, `scratch_head`,
`facepalm`, `count`, `wave`, `nod_yes`, `shake_no`, `lean_in`, `thumbs_up`, `cross_arms`, `celebrate`.
Expressions: `neutral`, `happy`, `laugh`, `surprised`, `shocked`, `worried`, `thinking`, `annoyed`,
`sad`, `proud`, `confused`.

Common options are `id`, `t` (nonnegative seconds), `duration` (positive main-move seconds),
`intensity` (0..1), `hold` (nonnegative seconds) and `release` (positive return seconds). Defaults:
main move 0.6 s (expression 0.35), settle 0.3 s, hold 1.2 s, release 0.4 s (expression 0.25).
Gestures additionally accept `side: R|L|both` and `count: 1|2|3`. R/L are the **character's** sides;
on a front-facing drawing, R appears on the image left. Pointing names use **screen** directions.
Two-bone solving chooses the elbow branch closest to rest inside the authored control ranges.
Sleeves and forearms retain their drawn shape during elbow bends; glove drawings may still need
character-specific authoring. These are normalized gesture poses, not a motion-capture or collision-avoidance system; review contact
positions on each character. Crossing arms requires suitable cut layers and depth order.

Controls absent from the model are skipped, with a warning `gesture-missing-param`, a JSON pointer
and a correction hint. Missing hand drawings keep the original glove and warn about the absent
`HandRForm` / `HandLForm`; no invented fingers are drawn at runtime. `count` needs the corresponding
point/count2/count3 drawing. Hand form is discrete and does not scale to a different form at low
intensity. Facial mesh controls remain usable without expression drawings. Full figures also have simple
analytic mouth shapes; their sampled skin cover is an approximation of the original shading. Optional brow landmarks
or brow variants enable `BrowLY` / `BrowRY`.

## `act` motion curve

```json
{"op":"act","animation":"point","target":"param:ArmRA","from":0,"to":55,"t":0.3,"duration":0.5,"anticipation":0.15,"overshoot":0.12,"settle":0.3,"hold":1.5,"release":0.4}
```

The main-move duration includes the opposite anticipation at 20%, then a peak past the destination.
Settling crosses below the destination by one third of the overshoot and arrives exactly at it;
hold keeps that value. Optional release returns to `from`. Values are absolute. Anticipation and
overshoot are shares of `(to-from)`, each 0..1; settle/hold are nonnegative. Positive overshoot needs
positive settle. Every generated key must fit a parameter's range, including anticipation and
overshoot; invalid values return a hint with the clamped value. Other targets must be numeric.
New animations are non-looping; an existing animation is extended as needed.

Gesture generators share this curve, clamp their keys to the model's ranges, and use smaller shoulder
anticipation to keep the glove inside the synthetic fixture canvas. Wave and scratching add bounded
hold oscillations. Nod/shake return to the head's neutral pose.

## Seeded idle and scenes

`generateIdle(model, 'C1:P010', 60)` generates respiration, small body/head/gaze/wrist motion and
seeded blinks. Primary blink groups are spaced 2–6 seconds apart; some groups contain two short
pulses. The interval rule concerns groups, not the two pulses of a double blink. Events named
`blink` expose group times and `data.double`. Same seed/model/duration gives the same keys; character
id plus scene id gives independent tracks. Idle loops close at the same parameter values.

```json
{
  "animations": [
    "idle_alive",
    {"gesture":"voila","t":"@text:voilà","intensity":0.8},
    {"expression":"surprised","t":2.5,"hold":1.2}
  ]
}
```

Scene version 1 accepts an optional `id` used for idle seeding. Narration cues resolve before acting.
`compileSceneActing(scene, assets, shotId)` clones models and rigs per layer, adds generated animations
in memory and returns resolved animation references. Source objects and model files remain intact;
textures are shared read-only. The Node scene loader calls this automatically. Browser callers call
it once after loading assets and resolving cues, before validation/evaluation. Generated one-shots
use additive layers with `once: true, hold: false`; idle uses an additive loop. Explicit layer
parameters/tracks still win. Missing rigs emit `gesture-missing-rig`; unknown names and bad options
return `gesture-unknown`, `expression-unknown` or `gesture-options` errors.

MCP: `rev2d_gesture_list {}` returns both catalogues; `rev2d_gesture_apply` and
`rev2d_expression_apply` take `path`, the gesture/expression name, the same timing options, and
`dry_run`. Review the generated animation, its sheet and analysis before using it in a shot.
