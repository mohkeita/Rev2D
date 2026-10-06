/**
 * Rev2D model format — the single source of truth.
 *
 * Every model file (`*.r2d.json`) is validated by `ModelSchema`. Types used across the codebase are
 * inferred from these schemas (see types.ts). The JSON Schema served to AI agents (`rev2d schema`)
 * is generated from this file, so descriptions here are user-facing documentation.
 *
 * Conventions (see docs/SPEC.md for full semantics):
 * - Setup space = canvas pixel space. Origin top-left, +x right, +y down (same as SVG / images).
 * - Angles are degrees; positive rotates clockwise on screen (SVG convention).
 * - All part/warp geometry is authored in setup space (absolute canvas coordinates of the rest pose).
 * - Objects are referenced by `id`. Properties are addressed as `kind:id.prop` (e.g. `bone:head.rotation`).
 */
import { z } from 'zod';

export const FORMAT = 'rev2d' as const;
export const FORMAT_VERSION = 1 as const;

export const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export const IdSchema = z
  .string()
  .regex(ID_PATTERN, 'ids must match ^[A-Za-z_][A-Za-z0-9_-]*$ (no spaces, dots or colons)')
  .describe('Identifier, unique within its kind. Letters, digits, _ and -; must not start with a digit.');

/** "#rgb", "#rgba", "#rrggbb", "#rrggbbaa", "rgb(r,g,b)", "rgba(r,g,b,a)" or a CSS basic color name. */
export const ColorSchema = z
  .string()
  .min(1)
  .describe('Color: "#rgb", "#rrggbb", "#rrggbbaa", "rgba(255,0,0,0.5)" or basic names like "white", "transparent".');

export const Vec2Schema = z.tuple([z.number(), z.number()]).describe('[x, y] in setup space (pixels).');

/** Flat list of coordinates: [x0, y0, x1, y1, ...]. */
export const PointListSchema = z.array(z.number()).describe('Flat coordinate list [x0, y0, x1, y1, ...].');

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

export const ParameterSchema = z
  .strictObject({
    id: IdSchema,
    min: z.number().describe('Minimum value (inclusive).'),
    max: z.number().describe('Maximum value (inclusive).'),
    default: z.number().optional().describe('Rest value. Defaults to 0 clamped into [min, max].'),
    description: z.string().optional(),
    group: z.string().optional().describe('UI grouping label, e.g. "Face", "Body".'),
  })
  .describe(
    'A named scalar control (like Live2D parameters). Bindings map parameter values to property values; animations and physics drive parameters.',
  );

// ---------------------------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------------------------

export const TextureSchema = z
  .strictObject({
    id: IdSchema,
    path: z
      .string()
      .describe('PNG path relative to the model file, or a data: URI (data:image/png;base64,...).'),
    width: z.number().int().positive().optional().describe('Pixel width (filled in by the loader if omitted).'),
    height: z.number().int().positive().optional().describe('Pixel height (filled in by the loader if omitted).'),
  })
  .describe('A bitmap image referenced by `image` shapes.');

// ---------------------------------------------------------------------------------------------
// Bones
// ---------------------------------------------------------------------------------------------

export const BoneSchema = z
  .strictObject({
    id: IdSchema,
    parent: IdSchema.nullable().optional().describe('Parent bone id. Omit/null for a root bone.'),
    x: z.number().default(0).describe('Local x in the parent bone frame (setup space for root bones).'),
    y: z.number().default(0).describe('Local y in the parent bone frame (setup space for root bones).'),
    rotation: z.number().default(0).describe('Local rotation in degrees, clockwise-positive.'),
    scaleX: z.number().default(1),
    scaleY: z.number().default(1),
    length: z.number().min(0).default(0).describe('Visual length along the local +x axis (used by overlays, IK and auto weights).'),
    color: ColorSchema.optional().describe('Overlay color for debugging.'),
    description: z.string().optional(),
  })
  .describe('A transform node. World = parentWorld * translate(x,y) * rotate(rotation) * scale(scaleX,scaleY).');

// ---------------------------------------------------------------------------------------------
// Warp deformers
// ---------------------------------------------------------------------------------------------

export const WarpSchema = z
  .strictObject({
    id: IdSchema,
    parent: IdSchema.optional().describe('Bone id or warp id this deformer follows. Omit for model space.'),
    rect: z
      .tuple([z.number(), z.number(), z.number().positive(), z.number().positive()])
      .describe('[x, y, width, height] of the rest lattice in setup space.'),
    cols: z.number().int().min(1).max(64).default(2).describe('Lattice cells horizontally (1 to 64).'),
    rows: z.number().int().min(1).max(64).default(2).describe('Lattice cells vertically (1 to 64).'),
    description: z.string().optional(),
  })
  .describe(
    'A lattice (grid) deformer like Live2D warp deformers. It has (cols+1)*(rows+1) control points, row-major: index = row*(cols+1)+col. Bind `warp:<id>.offsets` to move points; children (parts / warps) inside the rect are bilinearly deformed.',
  );

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

const shapeCommon = {
  detail: z
    .number()
    .positive()
    .optional()
    .describe('Max triangle edge length in px. Smaller = denser mesh = smoother deformation. Default: none (minimal mesh).'),
};

export const EllipseShapeSchema = z.strictObject({
  type: z.literal('ellipse'),
  cx: z.number(),
  cy: z.number(),
  rx: z.number().min(0),
  ry: z.number().min(0),
  rotation: z.number().default(0).describe('Degrees, clockwise.'),
  segments: z.number().int().min(3).max(512).optional().describe('Outline segments. Default: auto from size.'),
  ...shapeCommon,
});

export const RectShapeSchema = z.strictObject({
  type: z.literal('rect'),
  x: z.number(),
  y: z.number(),
  w: z.number().min(0),
  h: z.number().min(0),
  radius: z.number().min(0).default(0).describe('Corner radius.'),
  ...shapeCommon,
});

export const PolygonShapeSchema = z.strictObject({
  type: z.literal('polygon'),
  points: PointListSchema.describe('Closed outline [x0,y0,x1,y1,...] (at least 3 points, no self-intersections).'),
  ...shapeCommon,
});

export const PathShapeSchema = z.strictObject({
  type: z.literal('path'),
  d: z
    .string()
    .describe(
      'SVG path data. Supported: M L H V C S Q T A Z (absolute and relative). Each closed subpath is filled independently (no holes). Open subpaths are closed implicitly for fill.',
    ),
  tolerance: z
    .number()
    .positive()
    .default(0.5)
    .describe(
      'Curve flattening tolerance in px (max distance between a curve and its polyline). Independently, no flattened curve/arc segment turns more than about 15°, so small curves stay round.',
    ),
  ...shapeCommon,
});

export const MeshShapeSchema = z.strictObject({
  type: z.literal('mesh'),
  vertices: PointListSchema.describe('Vertex positions [x0,y0,...] in setup space.'),
  triangles: z.array(z.number().int().min(0)).describe('Triangle vertex indices, 3 per triangle.'),
  uvs: PointListSchema.optional().describe('Texture coordinates 0..1 per vertex (requires `texture`).'),
  texture: IdSchema.optional().describe('Texture id sampled with `uvs`.'),
});

export const ImageShapeSchema = z.strictObject({
  type: z.literal('image'),
  texture: IdSchema,
  x: z.number().describe('Left edge in setup space.'),
  y: z.number().describe('Top edge in setup space.'),
  w: z.number().positive().optional().describe('Width in px. Default: texture/crop width.'),
  h: z.number().positive().optional().describe('Height in px. Default: texture/crop height.'),
  crop: z
    .tuple([z.number(), z.number(), z.number().positive(), z.number().positive()])
    .optional()
    .describe('[sx, sy, sw, sh] sub-rectangle of the texture in texture pixels.'),
  cols: z.number().int().min(1).max(64).default(1).describe('Grid mesh columns (more = smoother deformation).'),
  rows: z.number().int().min(1).max(64).default(1).describe('Grid mesh rows.'),
});

export const ShapeSchema = z
  .discriminatedUnion('type', [
    EllipseShapeSchema,
    RectShapeSchema,
    PolygonShapeSchema,
    PathShapeSchema,
    MeshShapeSchema,
    ImageShapeSchema,
  ])
  .describe('Geometry of a part in setup space. Numeric fields, `points`, `vertices` and `d` are bindable/animatable.');

// ---------------------------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------------------------

export const GradientStopSchema = z
  .tuple([z.number().min(0).max(1), ColorSchema])
  .describe('[offset 0..1, color]');

export const FillSchema = z
  .union([
    ColorSchema,
    z.strictObject({ type: z.literal('solid'), color: ColorSchema }),
    z.strictObject({
      type: z.literal('linear'),
      from: Vec2Schema,
      to: Vec2Schema,
      stops: z.array(GradientStopSchema).min(1),
    }),
    z.strictObject({
      type: z.literal('radial'),
      center: Vec2Schema,
      radius: z.number().positive(),
      stops: z.array(GradientStopSchema).min(1),
    }),
  ])
  .describe(
    'Fill paint. A color string is shorthand for solid. Gradients are in setup space and are evaluated per vertex (use `detail` for smooth multi-stop gradients).',
  );

export const StrokeSchema = z
  .strictObject({
    color: ColorSchema,
    width: z.number().min(0),
    join: z.enum(['round', 'miter', 'bevel']).default('round'),
    align: z.enum(['center', 'inside', 'outside']).default('center'),
  })
  .describe('Outline drawn on top of the fill.');

export const BlendModeSchema = z.enum(['normal', 'add', 'multiply', 'screen']);

// ---------------------------------------------------------------------------------------------
// Parts (drawables)
// ---------------------------------------------------------------------------------------------

export const SkinSchema = z
  .strictObject({
    bones: z.array(IdSchema).min(1).describe('Influencing bones.'),
    weights: z
      .union([z.literal('auto'), z.array(z.array(z.number()))])
      .default('auto')
      .describe(
        '"auto" = computed from distance to each bone segment in the setup pose. Or explicit per-vertex weight rows [[w_bone0, w_bone1, ...], ...] (mesh shapes only; one row per vertex).',
      ),
    falloff: z.number().positive().default(2).describe('Auto weights: inverse-distance exponent. Higher = sharper.'),
  })
  .describe('Linear blend skinning. The part deforms with several bones. Incompatible with `parent`.');

export const PartSchema = z
  .strictObject({
    id: IdSchema,
    parent: IdSchema.optional().describe('Bone id or warp id. Omit for model space.'),
    shape: ShapeSchema,
    fill: FillSchema.optional().describe('Default: "#ffffff" (so image shapes show the texture unchanged).'),
    stroke: StrokeSchema.optional(),
    opacity: z.number().min(0).max(1).default(1),
    tint: ColorSchema.default('#ffffff').describe('Color multiplied with fill and stroke.'),
    blend: BlendModeSchema.default('normal'),
    visible: z.boolean().default(true).describe('Static visibility. Use opacity bindings for animated show/hide.'),
    z: z.number().default(0).describe('Draw order key: lower draws first. Ties keep array order.'),
    mask: z.array(IdSchema).optional().describe('Clip this part to the union coverage of these parts (e.g. iris clipped by eye white).'),
    maskInvert: z.boolean().default(false).describe('Invert the mask: draw only outside the mask parts.'),
    skin: SkinSchema.optional(),
    tags: z.array(z.string()).optional().describe('Free-form labels for grouping/search.'),
    description: z.string().optional(),
  })
  .describe('A drawable. Parts are drawn in order of (z, array index).');

// ---------------------------------------------------------------------------------------------
// Values, bindings, animations
// ---------------------------------------------------------------------------------------------

export const SparsePointsSchema = z
  .record(z.string().regex(/^\d+$/), z.tuple([z.number(), z.number()]))
  .describe('Sparse point list: {"<pointIndex>": [x, y]}. Unlisted points keep their setup value.');

export const ValueSchema = z
  .union([z.number(), z.array(z.number()), z.string(), z.boolean(), SparsePointsSchema])
  .describe(
    'A property value: number, point list [x0,y0,...], sparse point map {"3":[x,y]}, color string, SVG path string (same command structure as the setup path) or boolean.',
  );

export const BindingKeySchema = z.strictObject({
  at: z.array(z.number()).min(1).describe('Parameter values, one per entry in `params`.'),
  value: ValueSchema.describe('Absolute property value at this keyform (warp offsets are offsets from rest).'),
});

export const BindingSchema = z
  .strictObject({
    id: IdSchema.optional(),
    target: z
      .string()
      .describe('Property address, e.g. "bone:head.rotation", "warp:face.offsets", "part:mouth.shape.ry", "part:eyeL.opacity".'),
    params: z.array(IdSchema).min(1).max(3).describe('Driving parameters (1 to 3).'),
    keys: z
      .array(BindingKeySchema)
      .min(1)
      .describe('Keyforms. Must form a full grid over the distinct `at` values of each parameter.'),
    interpolation: z.enum(['linear', 'step']).default('linear'),
    description: z.string().optional(),
  })
  .describe(
    'Maps parameter values to a property value by multilinear interpolation over a keyform grid (clamped outside the grid). Several bindings on one property add their deltas from the setup value.',
  );

export const EaseSchema = z
  .union([
    z.enum([
      'linear',
      'step',
      'inSine',
      'outSine',
      'inOutSine',
      'inQuad',
      'outQuad',
      'inOutQuad',
      'inCubic',
      'outCubic',
      'inOutCubic',
      'inBack',
      'outBack',
      'inOutBack',
      'outElastic',
      'outBounce',
      'smooth',
    ]),
    z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('cubic-bezier(x1, y1, x2, y2)'),
  ])
  .describe(
    'Easing from this key to the next key. "smooth" = Catmull-Rom curve through the neighbouring keys (automatic tangents from the previous and next key; in a looping animation whose track has keys at t=0 and t=duration the tangents wrap around the loop, so a cycle such as a walk has no velocity jump at the seam).',
  );

export const KeySchema = z.strictObject({
  t: z.number().min(0).describe('Time in seconds.'),
  v: ValueSchema,
  ease: EaseSchema.default('linear'),
});

export const TrackSchema = z
  .strictObject({
    target: z
      .string()
      .describe('"param:<id>" (preferred: animate parameters) or any property address like "bone:arm.rotation".'),
    keys: z.array(KeySchema).min(1),
    offset: z
      .number()
      .default(0)
      .describe(
        'Time shift in seconds: the track is sampled at (t - offset). In looping animations the curve wraps around the duration, so the opposite leg of a walk can reuse the same keys with offset = duration / 2.',
      ),
  })
  .describe('Keyframes for one property. Values are absolute (same meaning as binding values).');

export const AnimationEventSchema = z.strictObject({
  t: z.number().min(0),
  name: z.string().min(1),
  data: z.unknown().optional(),
});

export const AnimationSchema = z
  .strictObject({
    id: IdSchema,
    duration: z.number().positive().describe('Seconds.'),
    loop: z.boolean().default(true),
    tracks: z.array(TrackSchema).default([]),
    events: z.array(AnimationEventSchema).optional(),
    description: z.string().optional(),
  })
  .describe('A timeline of tracks. Several animations can be layered with weights at playback.');

// ---------------------------------------------------------------------------------------------
// Constraints & physics
// ---------------------------------------------------------------------------------------------

export const IkSchema = z
  .strictObject({
    id: IdSchema,
    bones: z
      .array(IdSchema)
      .min(1)
      .max(2)
      .describe('1 bone (aim) or 2 bones [parent, child] (two-bone IK). The child must be a direct child of the parent.'),
    target: IdSchema.describe('Bone whose world position is the goal.'),
    mix: z.number().min(0).max(1).default(1),
    bendPositive: z.boolean().default(true).describe('Two-bone IK bend direction (true = clockwise elbow).'),
    stretch: z
      .boolean()
      .default(false)
      .describe(
        'When the target is out of reach, scale the chain bones along their length (local scaleX) so the tip still reaches it (Spine "stretch"). Works for one-bone IK too.',
      ),
    softness: z
      .number()
      .min(0)
      .default(0)
      .describe(
        'Two-bone IK only: px. Targets farther than (reach - softness) are pulled in along a smooth curve, so the chain straightens only at reach + softness instead of snapping straight at reach (Spine "softness"). With stretch, the chain stretches smoothly from reach - softness on and the tip always reaches. Typical: 5-15% of the reach.',
      ),
  })
  .describe('Inverse kinematics: rotates bones so the chain tip reaches the target bone.');

export const PhysicsInputSchema = z.strictObject({
  param: IdSchema,
  type: z
    .enum(['x', 'y', 'angle'])
    .describe('x/y: moves the pendulum pivot by value*weight px. angle: rotates the pivot by value*weight degrees.'),
  weight: z.number().default(1),
});

export const PhysicsOutputSchema = z.strictObject({
  param: IdSchema,
  type: z
    .enum(['angle', 'x', 'y'])
    .default('angle')
    .describe('angle: swing angle of the segment (degrees, clockwise from rest). x/y: tip offset from rest in px.'),
  segment: z.number().int().min(-1).default(-1).describe('Chain segment index (-1 = last).'),
  scale: z.number().default(1).describe('Output multiplier before clamping to the parameter range.'),
});

export const PhysicsSchema = z
  .strictObject({
    id: IdSchema,
    inputs: z.array(PhysicsInputSchema).min(1),
    outputs: z.array(PhysicsOutputSchema).min(1),
    segments: z
      .array(
        z.strictObject({
          length: z.number().positive().default(30).describe('Segment length in px.'),
          mass: z.number().positive().default(1),
        }),
      )
      .min(1)
      .default([{ length: 30, mass: 1 }])
      .describe('Pendulum chain hanging from the pivot.'),
    gravity: z.number().default(980).describe('Downward acceleration in px/s^2.'),
    damping: z.number().min(0).max(1).default(0.1).describe('Velocity damping per step (0 = none, 1 = frozen).'),
    stiffness: z.number().min(0).default(0).describe('Spring pulling each segment back to its rest direction.'),
    description: z.string().optional(),
  })
  .describe(
    'Live2D-style pendulum physics: input parameters shake a pendulum chain whose swing drives output parameters. Simulated at a fixed 60 Hz from t=0.',
  );

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------

export const MetaSchema = z.strictObject({
  name: z.string().min(1),
  width: z.number().int().positive().describe('Canvas width in px.'),
  height: z.number().int().positive().describe('Canvas height in px.'),
  background: ColorSchema.default('transparent'),
  fps: z.number().positive().default(30).describe('Default frame rate for exports.'),
  description: z.string().optional(),
  author: z.string().optional(),
});

export const ModelSchema = z
  .strictObject({
    $schema: z.string().optional(),
    format: z.literal(FORMAT),
    version: z.literal(FORMAT_VERSION),
    meta: MetaSchema,
    parameters: z.array(ParameterSchema).default([]),
    textures: z.array(TextureSchema).default([]),
    bones: z.array(BoneSchema).default([]),
    warps: z.array(WarpSchema).default([]),
    parts: z.array(PartSchema).default([]),
    bindings: z.array(BindingSchema).default([]),
    ik: z.array(IkSchema).default([]),
    physics: z.array(PhysicsSchema).default([]),
    animations: z.array(AnimationSchema).default([]),
  })
  .describe('Rev2D model (.r2d.json).');

export function modelJsonSchema(): unknown {
  return z.toJSONSchema(ModelSchema, { io: 'input', unrepresentable: 'any' });
}
