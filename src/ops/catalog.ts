/**
 * The op catalogue: one entry per op with a summary, its fields and a complete example. It drives
 * `describeOps()` (MCP tool descriptions, docs), unknown-field checks and "example: ..." hints.
 * Pure data: no imports from the op implementations.
 *
 * Keep the FIRST sentence of every summary short (about 60 characters): the MCP edit tool lists
 * every op with only that sentence, and its whole description must fit in 2048 characters.
 */

export interface OpDescription {
  /** Op name, the value of the "op" field. */
  op: string;
  /** One-paragraph description of what the op does; the first sentence is the one-line brief. */
  summary: string;
  /** Accepted fields (besides "op") -> description. Required fields are marked "(required)". */
  fields: Record<string, string>;
  /** A complete, valid op object. */
  example: { op: string; [key: string]: unknown };
}

const KIND = 'parameter | texture | bone | warp | part | binding | ik | physics | animation';
const BINDING_SELECTOR = 'bindings only (they may have no id): select the binding by its target address instead of "id"';

export const OP_CATALOG: readonly OpDescription[] = [
  {
    op: 'act',
    summary:
      'Anticipate, move, settle and hold. Writes numeric keys into an animation, creating or extending it; generated parameter values must stay inside the declared range.',
    fields: {
      animation: '(required) animation id',
      target: '(required) numeric address, e.g. param:ArmRA',
      from: '(required) initial absolute value',
      to: '(required) destination absolute value',
      t: 'start time in seconds (default 0)',
      duration: 'main move seconds (default 0.6)',
      anticipation: 'opposite amplitude share in 0..1 (default 0.15)',
      overshoot: 'overshoot share in 0..1 (default 0.12)',
      settle: 'settling seconds (default 0.3)',
      hold: 'hold seconds (default 0)',
      release: 'optional positive return duration in seconds',
    },
    example: {
      op: 'act', animation: 'point', target: 'param:AngleX', from: 0, to: 15,
      t: 0.3, duration: 0.5, anticipation: 0.15, overshoot: 0.12, settle: 0.3, hold: 1.5, release: 0.4,
    },
  },
  {
    op: 'add',
    summary:
      'Add a model item. The array is created if missing; duplicate ids fail. Bones may give "world": [x, y] (setup-space position) instead of local x/y, and "worldRotation" (setup-space degrees) instead of local rotation; both are converted with the parent\'s setup world transform (rotated, scaled and mirrored parents included).',
    fields: {
      kind: `(required) ${KIND}`,
      value: '(required) the item object exactly as in the model file (see docs/SPEC.md); bones also accept "world" and "worldRotation"',
      index: 'insert position (0 = first; default: append)',
      before: 'insert before the item with this id',
      after: 'insert after the item with this id',
    },
    example: { op: 'add', kind: 'bone', value: { id: 'hand', parent: 'forearm', world: [300, 220], worldRotation: 90, length: 30 } },
  },
  {
    op: 'update',
    summary:
      'Change item fields. "set" maps field paths to new values: dotted paths reach nested fields ("shape.rx", "stroke.width"), null deletes a field. Bones accept "world": [x, y] and "worldRotation": degrees (setup space); with "keepWorld": true a bone whose parent changes keeps its setup world pose (x/y/rotation/scale are recomputed, so they cannot be set in the same update). Ids change only with rename (an id-less binding can get one here). The message lists only fields whose value changed (long arrays summarized) and names the unchanged ones.',
    fields: {
      kind: `(required) ${KIND}`,
      id: '(required unless kind is binding) id of the item',
      set: '(required) {"<field.path>": value | null}; bones also accept "world" and "worldRotation"',
      keepWorld: 'bones: when "parent" changes, recompute x/y/rotation/scale (and remap their keyforms) so the bone stays where it is',
      target: BINDING_SELECTOR,
      params: 'bindings: disambiguate by driving parameters when several bindings share a target',
    },
    example: { op: 'update', kind: 'part', id: 'mouth', set: { 'shape.rx': 20, 'stroke.width': 3, description: null } },
  },
  {
    op: 'remove',
    summary:
      'Remove an item. Without "cascade" it fails when anything references the item and lists every reference as a JSON pointer. With "cascade": true dependents are fixed up: child bones are reparented to the removed bone\'s parent keeping their setup world pose, warps/parts are reparented, mask and skin references dropped, and bindings/tracks/IK/physics entries that cannot exist without the item are removed. A removed parameter leaves multi-parameter bindings with the values they had at its default. The message lists everything cascaded, with WARNINGs where the rest pose or motion changes.',
    fields: {
      kind: `(required) ${KIND}`,
      id: '(required unless kind is binding) id of the item',
      cascade: 'true = also fix up / remove everything that references the item',
      target: BINDING_SELECTOR,
      params: 'bindings: disambiguate by driving parameters',
    },
    example: { op: 'remove', kind: 'bone', id: 'forearm', cascade: true },
  },
  {
    op: 'rename',
    summary:
      'Rename and update references. That covers parents, masks, skin bones, IK bones/targets, binding params, physics params, texture refs and address strings ("bone:old.rotation" -> "bone:new.rotation", "param:Old" -> "param:New").',
    fields: {
      kind: `(required) ${KIND}`,
      from: '(required) current id',
      to: '(required) new id',
    },
    example: { op: 'rename', kind: 'bone', from: 'arm', to: 'upperArm' },
  },
  {
    op: 'set',
    summary:
      'Set a property’s rest value. Addresses: bone:<id>.x|y|rotation|scaleX|scaleY|length, part:<id>.opacity|z|visible|tint|fill (solid colour)|stroke.color|stroke.width|shape.<field>, ik:<id>.mix. Point lists accept a full list or a sparse map {"<index>": [x, y]}. Parameter defaults and non-animatable fields (blend, parent, shape.detail, ...) use update; warp offsets have no setup value (bind them).',
    fields: {
      target: '(required) property address, e.g. "part:mouth.shape.rx"',
      value: '(required) absolute value (number, colour string, point list / sparse map, path string, boolean)',
    },
    example: { op: 'set', target: 'part:mouth.shape.points', value: { '2': [260, 250] } },
  },
  {
    op: 'bind',
    summary:
      'Bind parameters to a property. A binding with the same target and the same parameter set is replaced (keeping its id, description and interpolation unless given); the message says added or replaced. Keys must form a full grid over the distinct "at" values of each parameter. Values are absolute; with "relative": true they are offsets added to the current setup value (numbers, point lists and sparse point maps; not colours, paths or booleans) and stored as absolute keyforms.',
    fields: {
      target: '(required) property address (not param:)',
      params: '(required) 1 to 3 parameter ids (a single id string is accepted)',
      keys: '(required) [{"at": [one value per param], "value": absolute value (an offset with "relative")}]',
      relative: 'true = key values are offsets from the current setup value (e.g. "value": 10 means setup + 10)',
      interpolation: '"linear" (default) or "step"',
      id: 'optional binding id',
      description: 'optional note',
    },
    example: {
      op: 'bind',
      target: 'part:mouth.shape.ry',
      params: ['MouthOpen'],
      keys: [
        { at: [0], value: 2 },
        { at: [1], value: 16 },
      ],
    },
  },
  {
    op: 'bind_linear',
    summary:
      'Drive a numeric property linearly. Upserts the 2-key binding value = setup + scale × param, keyed at "at" (default: the parameter range), e.g. FootLY -> bone:footL.y with scale 1 moves the foot 1 px per unit. The message shows the formula and warns when the parameter default is not 0 (the rest pose would move).',
    fields: {
      target: '(required) address of a numeric property, e.g. "bone:footL.y"',
      param: '(required) parameter id',
      scale: '(required) property units per parameter unit (negative = opposite direction)',
      at: '[low, high] parameter values to key (default: [min, max] of the parameter)',
      id: 'optional binding id',
      description: 'optional note',
    },
    example: { op: 'bind_linear', target: 'bone:footL.y', param: 'FootLY', scale: 1 },
  },
  {
    op: 'bind_warp',
    summary:
      'Bind head-turn warp offsets. Generates full "warp:<id>.offsets" keyforms and upserts the binding. Per key: yaw/pitch (pseudo-3D turn: positive yaw turns toward +x, content shifts right and the far side compresses; positive pitch looks DOWN, content shifts +y, so with the Live2D convention "AngleY > 0 looks up" use negative pitch at AngleY > 0), then scale and rotate (clockwise degrees) about "pivot" (default: rect centre), then translate, plus optional raw "offsets" added on top.',
    fields: {
      warp: '(required) warp id',
      params: '(required) 1 to 3 parameter ids',
      keys:
        '(required) [{"at": [...], "yaw"?: deg (-90..90 exclusive), "pitch"?: deg (-90..90 exclusive; positive looks down), "scale"?: s | [sx, sy] (not 0), "rotate"?: deg, "pivot"?: [x, y], "translate"?: [dx, dy], "offsets"?: sparse map or full list}]',
      interpolation: '"linear" (default) or "step"',
      id: 'optional binding id',
      description: 'optional note',
    },
    example: {
      op: 'bind_warp',
      warp: 'faceWarp',
      params: ['AngleX'],
      keys: [
        { at: [-30], yaw: -25 },
        { at: [0] },
        { at: [30], yaw: 25 },
      ],
    },
  },
  {
    op: 'follow',
    summary:
      'Attach a rigid accessory to a deformer. E.g. a hat on a turning head: the accessory ("warp" or "bone", attached next to the followed item, e.g. both on bone "head") gets keyforms over the key grid of the followed motion that put its anchor "at" exactly where Rig.mapPoint maps that point through "follow"; "rotate" / "scale" also match the local rotation / scale (from two probe points). A warp gets one "warp:<id>.offsets" binding, a bone x / y (rotation, scaleX / scaleY) bindings; a binding with the same target and params is replaced. The message reports the anchor shift and the residual error at keyforms and at grid midpoints.',
    fields: {
      warp: 'accessory warp id (give "warp" or "bone")',
      bone: 'accessory bone id (instead of "warp")',
      follow: '(required) warp or bone id to follow (e.g. the head warp); must not contain the accessory',
      at: '[x, y] setup-space anchor that must stay on the followed surface (e.g. where the hat touches the head), or "center" (default: centre of the accessory warp rect; a bone: its joint)',
      params:
        '1 to 3 parameter ids (default: those driving the bindings of "follow" and of its parents up to the first one the accessory also hangs from); the grid is every keyform value those bindings use',
      rotate: 'true = also follow the local rotation',
      scale: 'true = also follow the local (uniform) scale',
      probe: 'distance in px of the two probe points left and right of the anchor for rotate / scale (default: a quarter of the accessory warp width; a bone: half its length, else 10)',
      description: 'optional note on the generated bindings',
    },
    example: { op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [256, 121] },
  },
  {
    op: 'unbind',
    summary: 'Remove target bindings. With "params", only the binding driven by exactly that parameter set.',
    fields: {
      target: '(required) property address',
      params: 'parameter ids of the binding to remove (default: every binding on the target)',
    },
    example: { op: 'unbind', target: 'part:mouth.shape.ry', params: ['MouthOpen'] },
  },
  {
    op: 'key',
    summary:
      'Upsert one animation keyframe. Creates the track if missing, replaces a key at the same time (within 1e-6; its ease is kept unless given) and keeps keys sorted. The animation is created only when "duration" is given. Keys after the duration are rejected (update the duration first).',
    fields: {
      animation: '(required) animation id',
      target: '(required) "param:<id>" or a property address',
      t: '(required) time in seconds (0..duration)',
      v: '(required) absolute value at t',
      ease: 'easing from this key to the next (e.g. "inOutSine", "smooth", "step", [x1, y1, x2, y2])',
      duration: 'seconds; creates the animation when it does not exist',
      loop: 'loop flag for a newly created animation',
    },
    example: { op: 'key', animation: 'idle', target: 'param:Breath', t: 1, v: 1, ease: 'inOutSine', duration: 2 },
  },
  {
    op: 'unkey',
    summary: 'Remove one animation keyframe. The key at time t (within 1e-6) goes; the track is removed when its last key goes.',
    fields: {
      animation: '(required) animation id',
      target: '(required) track target address',
      t: '(required) key time',
    },
    example: { op: 'unkey', animation: 'idle', target: 'param:Breath', t: 1 },
  },
  {
    op: 'move',
    summary: 'Reorder a section item. E.g. part draw order for equal z. Give exactly one of index, before, after.',
    fields: {
      kind: `(required) ${KIND}`,
      id: '(required unless kind is binding) id of the item',
      index: 'final position (0 = first)',
      before: 'place directly before this id',
      after: 'place directly after this id',
      target: BINDING_SELECTOR,
      params: 'bindings: disambiguate by driving parameters',
    },
    example: { op: 'move', kind: 'part', id: 'hairBack', index: 0 },
  },
  {
    op: 'recolor',
    summary:
      'Recolour with a map or HSL shift. Select parts with "parts", "tag" or "all". "map": {"#old": "#new"} replaces exact colour matches (RGB; a key with alpha also matches alpha) and keeps each colour\'s own alpha; "hsl": {"h": degrees, "s": delta, "l": delta} rotates the hue and adds to saturation / lightness (0..1 units). Applies to written solid fills, gradient stops and stroke colours (tints with "include": ["tint"]) and to the binding keyforms and animation keys on those colour properties. Reports counts per part; fails when nothing changed (the hint lists the colours found).',
    fields: {
      parts: 'part ids to recolour',
      tag: 'recolour every part with this tag',
      all: 'true = recolour every part',
      map: '{"#old": "#new", ...} exact colour replacements (alpha kept)',
      hsl: '{"h"?: degrees, "s"?: -1..1, "l"?: -1..1} shift',
      include: '["tint"] = also recolour written tints',
    },
    example: { op: 'recolor', tag: 'hair', hsl: { h: 30, s: -0.1 } },
  },
  {
    op: 'compose',
    summary:
      'Bake layered animations. Layers combine exactly like playback layers (weight, mode, start, hold); the result played alone at weight 1 matches them. Tracks on targets only one layer animates are copied (shifted by start, eases and offset kept) when that is exact, and layers of the same one-shot animation with disjoint windows (e.g. "blink" at 1 s and 3 s) are merged into one key list; other targets are baked by sampling the rig at "fps" (default 60) into linear keys, with a WARNING listing source key times and "hold": false window boundaries that fall between samples (and an fps that hits them). Events are merged. Duration defaults to the longest layer, loop to true when every layer loops. Fails on an existing id unless "replace": true.',
    fields: {
      id: '(required) id of the new animation',
      layers:
        '(required) bottom first: [{"animation": id, "weight"?: 0..1 (default 1), "mode"?: "override" | "add", "start"?: seconds, "hold"?: false = nothing outside the layer\'s window}] (a bare animation id is a full-weight layer)',
      duration: 'seconds (default: the longest layer; start + duration for one-shot layers)',
      fps: 'bake sample rate, 0 < fps <= 1000 (default 60, whatever meta.fps says)',
      loop: 'loop flag of the new animation (default: true when every layer loops)',
      replace: 'true = overwrite an existing animation with this id',
      description: 'optional note',
    },
    example: {
      op: 'compose',
      id: 'idleTalk',
      layers: [{ animation: 'idle' }, { animation: 'talk', mode: 'add', start: 0.5, hold: false }],
    },
  },
  {
    op: 'patch',
    summary:
      'Apply JSON Patch. RFC 6902 operations (add, remove, replace, move, copy, test) with RFC 6901 JSON pointers, applied in order. Extension: an array segment may be an item id ("/parts/mouth/opacity").',
    fields: {
      patch: '(required) [{"op": "replace", "path": "/meta/name", "value": "hero"}, ...]',
    },
    example: {
      op: 'patch',
      patch: [
        { op: 'replace', path: '/meta/background', value: '#202830' },
        { op: 'add', path: '/parts/mouth/tags', value: ['face'] },
      ],
    },
  },
];

export const OP_NAMES: readonly string[] = OP_CATALOG.map((d) => d.op);
