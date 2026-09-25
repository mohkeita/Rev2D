/**
 * Quickstart served by the rev2d_guide tool and the rev2d://guide resource: the minimum an AI author
 * needs to build and verify a rig, with copy-paste recipes. Recipes are data (tests apply them with
 * the real ops engine, so they cannot drift from it); the prose follows docs/SPEC.md.
 */
import type { Op } from '../ops/index.js';

export interface Recipe {
  title: string;
  /** Ops for rev2d_apply_ops, applied in order to a model that has the ids named in `requires`. */
  ops: Op[];
  /** Ids the recipe expects to exist beforehand (bones, parts, parameters from earlier recipes). */
  requires: string[];
  notes: string;
}

export const RECIPES: Recipe[] = [
  {
    title: 'Head turn (AngleX) with a warp',
    requires: ['bone head', 'part eyeL'],
    ops: [
      { op: 'add', kind: 'parameter', value: { id: 'AngleX', min: -30, max: 30, default: 0, group: 'Face' } },
      { op: 'add', kind: 'warp', value: { id: 'faceWarp', parent: 'head', rect: [176, 120, 160, 180], cols: 3, rows: 3 } },
      { op: 'update', kind: 'part', id: 'eyeL', set: { parent: 'faceWarp', 'shape.detail': 8 } },
      { op: 'bind_warp', warp: 'faceWarp', params: ['AngleX'], keys: [{ at: [-30], yaw: -25 }, { at: [0] }, { at: [30], yaw: 25 }] },
    ],
    notes:
      'Parent every face feature (eyes, brows, nose, mouth, face shape) to faceWarp the same way so they turn together.\n' +
      'Verify: rev2d_sheet {sweeps: ["AngleX=-30:30:5"], overlay: ["warps"]}. For a 2D turn bind params ["AngleX", "AngleY"]\n' +
      'with 9 keys (yaw from AngleX, pitch from AngleY). Positive pitch looks DOWN; with the Live2D convention\n' +
      '(AngleY > 0 = looks up) use pitch -20 at AngleY 30 and pitch 20 at AngleY -30.',
  },
  {
    title: 'Blink via a shape binding',
    requires: ['part eyeL (ellipse, ry 12)'],
    ops: [
      { op: 'add', kind: 'parameter', value: { id: 'EyeOpen', min: 0, max: 1, default: 1 } },
      { op: 'bind', target: 'part:eyeL.shape.ry', params: ['EyeOpen'], keys: [{ at: [0], value: 1 }, { at: [1], value: 12 }] },
      { op: 'key', animation: 'blink', target: 'param:EyeOpen', t: 0, v: 1, duration: 4 },
      { op: 'key', animation: 'blink', target: 'param:EyeOpen', t: 3.8, v: 1, ease: 'inQuad' },
      { op: 'key', animation: 'blink', target: 'param:EyeOpen', t: 3.9, v: 0, ease: 'outQuad' },
      { op: 'key', animation: 'blink', target: 'param:EyeOpen', t: 4, v: 1 },
    ],
    notes: '12 = the eye\'s setup ry, so EyeOpen = 1 (the default) is the rest pose. Verify: rev2d_sheet {sweeps: ["EyeOpen=0:1:3"]}.',
  },
  {
    title: 'Physics hair (pendulum -> parameter -> bone)',
    requires: ['bone head', 'part hairBack', 'parameter AngleX'],
    ops: [
      { op: 'add', kind: 'parameter', value: { id: 'HairSway', min: -30, max: 30 } },
      { op: 'add', kind: 'bone', value: { id: 'hairBone', parent: 'head', world: [256, 140], rotation: 90, length: 80 } },
      { op: 'update', kind: 'part', id: 'hairBack', set: { parent: 'hairBone' } },
      { op: 'bind', target: 'bone:hairBone.rotation', params: ['HairSway'], keys: [{ at: [-30], value: 60 }, { at: [30], value: 120 }] },
      {
        op: 'add',
        kind: 'physics',
        value: {
          id: 'hairPhys',
          inputs: [{ param: 'AngleX', type: 'x', weight: 1 }],
          outputs: [{ param: 'HairSway', type: 'angle', scale: 1 }],
          segments: [{ length: 60 }],
          damping: 0.15,
        },
      },
    ],
    notes:
      'Rotation keys are absolute local values: with an unrotated head bone, 90 deg = hanging straight down, and the\n' +
      'keys swing +/-30 around it. Physics is simulated from t=0 at\n' +
      '60 Hz, so it only moves when its inputs change over time: verify with an animation that moves AngleX,\n' +
      'e.g. rev2d_sheet {animation: "turn", frames: 12}.',
  },
  {
    title: 'Idle breathing loop',
    requires: ['bone chest'],
    ops: [
      { op: 'add', kind: 'parameter', value: { id: 'Breath', min: 0, max: 1 } },
      { op: 'bind', target: 'bone:chest.scaleY', params: ['Breath'], keys: [{ at: [0], value: 1 }, { at: [1], value: 1.03 }] },
      { op: 'key', animation: 'idle', target: 'param:Breath', t: 0, v: 0, ease: 'inOutSine', duration: 3 },
      { op: 'key', animation: 'idle', target: 'param:Breath', t: 1.5, v: 1, ease: 'inOutSine' },
      { op: 'key', animation: 'idle', target: 'param:Breath', t: 3, v: 0 },
    ],
    notes: 'Verify: rev2d_sheet {animation: "idle", frames: 6}.',
  },
];

function renderRecipe(r: Recipe): string {
  return [`### ${r.title}  (expects: ${r.requires.join(', ')})`, `[${r.ops.map((o) => JSON.stringify(o)).join(',\n ')}]`, r.notes].join('\n');
}

export const GUIDE = `# Rev2D quickstart for AI authors

A Rev2D model is ONE JSON file (*.r2d.json; comments and trailing commas allowed) describing a 2D rig
in the spirit of Live2D + Spine: parameters -> bindings -> bones / warps / parts, plus animations,
IK and physics. You write it as text and VERIFY it with deterministic renders and exact numbers.

## Conventions (get these right first)
- Setup space = canvas pixels (meta.width x meta.height). Origin top-left, +x right, **+y DOWN**.
- Angles in degrees, **positive = clockwise on screen**; 0 deg points along +x, 90 deg points down.
- Part and warp geometry is written in ABSOLUTE setup-space coordinates of the rest pose: draw each
  piece where it appears on the canvas, then attach it (parent) to a bone or warp.
- Bone x / y / rotation / scale are LOCAL to the parent bone (root bones: canvas coordinates).
- Ids match ^[A-Za-z_][A-Za-z0-9_-]*$, unique per kind; bones and warps share one parent namespace.
- Unknown keys are errors (typos are caught). Draw order: lower z first, ties keep array order.

## Workflow (loop until the pictures and numbers are right)
1. rev2d_create_model {path, template: "blank"} - a small valid rig to start from (or write JSON;
   rev2d_schema gives exact fields, rev2d_docs {topic: "spec"} the full semantics).
2. Edit with rev2d_apply_ops (atomic, validated, id-addressed; dry_run: true to preview) or edit the
   file directly and run rev2d_validate. Every diagnostic has a JSON pointer, a code and a hint.
3. Look: rev2d_render {overlay: ["bones", "labels"]} (add "warps", "grid", "bounds"; viewBox "fit").
4. Measure: rev2d_inspect {params: {...}} - world bone joints/tips, part bounds, warp points, IK
   reach, physics outputs; points: ["120,80@head"] = where a setup point attached to a bone, warp or
   part ends up. rev2d_hit_test maps a pixel position back to part ids.
5. Verify motion in one image: rev2d_sheet {sweeps: ["AngleX=-30:30:5"]}, {animation: "idle"} or
   {overview: true} (every parameter over its range). Find animation problems without watching:
   rev2d_analyze {animation: "idle"} (loop seam, parameter ranges, physics clamping, IK reach).
   Over time in numbers: rev2d_inspect {animations: ["idle"], frames: 8, track: "param:AngleX,bone:head"}.
6. Human in the loop: if the user runs \`rev2d edit <model>\`, the editor live-reloads your writes.
   rev2d_editor_state / rev2d_editor_screenshot show what they see; rev2d_editor_command drives it
   ({type: "open", file} shows them another model of the editor's workspace).

Animation layers (render, sheet, inspect, analyze): ["idle", "blink@0.5"]; comma options: "talk@0.8,add"
(param tracks add on top of the layers below instead of replacing them), "wink,once,start=2.5" (a
one-shot starting at t=2.5 that stops affecting the pose after its end). Explicit params beat
animation AND physics.

## Property addresses (bindings, animation tracks, ops "set"/"bind"/"key")
  param:<id>                        parameter value (animation tracks only)
  bone:<id>.x|y|rotation|scaleX|scaleY|length
  warp:<id>.offsets                 control-point offsets from rest (points)
  part:<id>.opacity|z|visible|tint|fill|stroke.color|stroke.width
  part:<id>.shape.<field>           ellipse cx cy rx ry rotation | rect x y w h radius |
                                    polygon points | path d | mesh vertices | image x y w h
  ik:<id>.mix
Values are ABSOLUTE (what the property should be), except warp offsets (relative to the rest grid).
Point values: full flat list [x0,y0,x1,y1,...] or sparse map {"4": [x, y]} (other points keep setup).
Path values must keep the setup path's command structure (numbers are interpolated).
Several bindings/tracks on one property ADD their deltas from the setup value.

## Core ideas
- Parameters (id, min, max, default) are the control surface. Animate parameters, not bones.
- Binding: {target, params: [1-3 ids], keys: [{at: [one value per param], value}]}. Keys must form a
  FULL GRID over the distinct "at" values (2 params x 3 values each = 9 keys). The key at the
  parameter default should equal the setup value, otherwise the rest pose changes.
- Warp = lattice deformer {id, parent, rect: [x,y,w,h], cols, rows}; (cols+1)*(rows+1) points,
  index = row*(cols+1)+col. Parts/warps parented to it bend with it. Give parts inside warps or skins
  "detail": 8-16 (max triangle edge px) so they deform smoothly.
- Parent: bone = rigid follow; warp = lattice deformation; skin {bones: [...]} = blend several bones.
- mask: ["eyeWhite"] clips a part to other parts' coverage (iris inside the eye white).

## Recipes (ops for rev2d_apply_ops; ids and coordinates are examples for a 512x512 character)
${RECIPES.map(renderRecipe).join('\n\n')}

## Pitfalls
- Setup (rest) values are not poses. Changing a bone's setup x / y / rotation (op "set" or "update")
  moves its rest frame, NOT the parts attached to it (their geometry is absolute): use it to fix a
  misplaced joint. To move or pose things, bind the property to a parameter or animate it.
- A rect/ellipse without "detail" is a handful of triangles: it will not bend inside a warp.
- Binding keys hold absolute values (bone rotation keys include the setup rotation).
- Warp offsets bindings: key {"at":[0], "value": {}} (empty sparse map) = rest.
- Visual check is not enough for alignment: use rev2d_inspect numbers (joints, tips, bounds).
- A part must lie inside its warp's rect (warning part-outside-warp): outside it the lattice
  extrapolates and the part drifts. Enlarge the rect (the hint gives it) or reparent the part.
- Rigid accessories (hat, glasses) on a turning head: do not nest them in the face warp. Put them in
  their own small warp (or on a bone) next to it, then op {"op": "follow", "warp": "hatWarp",
  "follow": "headWarp", "at": [x, y]} generates keyforms that keep the anchor on the head.
- More ops than add/update/bind: bind_linear (value = setup + scale x param), bind with
  "relative": true (offsets from setup), bind_warp (yaw/pitch turns), recolor (palette),
  compose (bake animation layers into one clip), add/update bones by "world" / "worldRotation".
- Writes by rev2d_apply_ops reformat the file (comments are not preserved).

## Tools
rev2d_guide (this) | rev2d_schema {name?} JSON Schema | rev2d_docs {topic} spec, ops, cli, mcp, recipes, architecture, examples, agents
rev2d_create_model | rev2d_validate | rev2d_info | rev2d_render | rev2d_sheet | rev2d_inspect | rev2d_analyze | rev2d_hit_test
rev2d_apply_ops (edits; the tool description lists every op) | rev2d_diff_images (before/after pixels)
rev2d_editor_state | rev2d_editor_command | rev2d_editor_screenshot (live editor bridge)
All paths are relative to the MCP server working directory unless absolute.
`;
