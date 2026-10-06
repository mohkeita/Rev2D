/**
 * Avatar spec (`avatar.json`): the landmarks an AI agent (or a human, by dragging handles in the
 * editor) places on ONE illustration so Rev2D can build an animated avatar from it.
 *
 * The spec is the source of truth of an avatar project; the Rev2D model (`<name>.r2d.json`) and the
 * layer images under `textures/` are BUILT from it (`rev2d avatar build`) and are regenerated.
 *
 * Conventions:
 * - Coordinates are pixels of the source image: origin top-left, +x right, +y down.
 * - "imageLeft" / "imageRight" always mean the left / right side OF THE IMAGE as you look at it
 *   (not the character's own left / right). The builder maps them to the Live2D-style parameter ids
 *   (the eye on the image's left is the character's right eye: EyeROpen).
 * - Angles are degrees, clockwise-positive on screen (the Rev2D convention).
 * - Point lists are flat: [x0, y0, x1, y1, ...].
 * - Regions such as the head ellipse are areas of influence (smooth weights), not cut-outs; the
 *   polygons that DO cut pixels into separate layers are marked "cuts layers" below, and changing
 *   them requires rebuilding the layer images.
 *
 * The JSON Schema served to agents (`rev2d avatar schema`) is generated from this file, so the
 * descriptions are user-facing documentation.
 */
import { z } from 'zod';
import { IdSchema } from '../core/schema.js';

export const AVATAR_FORMAT = 'rev2d-avatar' as const;
export const AVATAR_VERSION = 1 as const;

const Finite = z.number().refine(Number.isFinite, 'must be a finite number');

export const AvatarVec2Schema = z.tuple([Finite, Finite]).describe('[x, y] in source-image pixels (origin top-left, +y down).');

export const AvatarRadiusSchema = z
  .tuple([Finite.refine((v) => v > 0, 'must be > 0'), Finite.refine((v) => v > 0, 'must be > 0')])
  .describe('[rx, ry]: horizontal and vertical radius in pixels.');

export const AvatarPointsSchema = z.array(Finite).describe('Flat point list [x0, y0, x1, y1, ...] in source-image pixels.');

export const AvatarBandSchema = z
  .tuple([Finite, Finite])
  .describe('[yStart, yEnd] with yStart < yEnd (image rows): the influence is full above yStart and fades to zero at yEnd.');

export const AvatarEllipseSchema = z.strictObject({
  center: AvatarVec2Schema,
  radius: AvatarRadiusSchema,
});

// ----------------------------------------------------------------------------- head

export const AvatarHeadSchema = z
  .strictObject({
    center: AvatarVec2Schema.describe('Centre of the head ellipse: horizontally on the face centre, vertically slightly above the eyes.'),
    radius: AvatarRadiusSchema.describe(
      'Ellipse covering the WHOLE head including all hair and head accessories. An area of influence, not a cut-out; avoid the shoulders where possible.',
    ),
    pivot: AvatarVec2Schema.describe('Neck pivot the head tilts around (AngleZ): centre of the neck, above the collarbone.'),
    neck: AvatarBandSchema.describe(
      'Rows where the head influence fades out: yStart just below the chin (full head motion above it), yEnd near the collarbone (no head motion below it).',
    ),
    turn: z
      .strictObject({
        x: Finite.describe('Pixels the face centre moves at AngleX = ±30.'),
        y: Finite.describe('Pixels the face centre moves at AngleY = ±30.'),
      })
      .optional()
      .describe('Strength of the pseudo-3D head turn. Default: 3.5% of the image width / 2.5% of the image height.'),
    tilt: Finite.optional().describe('Head roll in degrees at AngleZ = ±30. Default 8.5.'),
  })
  .describe('The head: what turns (AngleX / AngleY) and tilts (AngleZ).');

// ----------------------------------------------------------------------------- face

export const AvatarEyeSchema = z
  .strictObject({
    opening: AvatarPointsSchema.describe(
      'CUTS LAYERS. Polygon along the visible eye white + iris, INSIDE the lashes: 14-20 points, starting at the outer corner and going over the top. Trace it on a zoomed 5 px grid; it must not include lashes or skin.',
    ),
    region: AvatarPointsSchema.describe(
      'CUTS LAYERS. Polygon 10-20 px OUTSIDE the lashes and the lower lid line: it must contain every lash, lid and crease stroke of this eye and no hair where avoidable.',
    ),
    iris: z
      .strictObject({ center: AvatarVec2Schema, radius: Finite.refine((v) => v > 0, 'must be > 0') })
      .optional()
      .describe('Optional iris circle (improves the gaze parameters EyeBallX / EyeBallY).'),
  })
  .describe('One eye. The opening is what closes when the eye blinks.');

export const AvatarMouthSchema = z
  .strictObject({
    imageLeft: AvatarVec2Schema.describe('Mouth corner on the image left.'),
    imageRight: AvatarVec2Schema.describe('Mouth corner on the image right.'),
    bow: Finite.default(0).describe('How far the middle of the closed mouth line lies below the straight line through the corners, px (negative = above, e.g. a smile is positive).'),
    area: z
      .strictObject({
        center: AvatarVec2Schema,
        radius: AvatarRadiusSchema,
        rotation: Finite.default(0).describe('Degrees, clockwise.'),
      })
      .describe('CUTS LAYERS (for drawn mouths). Ellipse a little larger than the lips: large enough for an open mouth, not reaching the chin or the nose.'),
  })
  .describe('The mouth: the closed-mouth line through both corners and the area drawn mouths may change.');

export const AvatarFaceSchema = z
  .strictObject({
    center: AvatarVec2Schema.describe('Centre of the face oval (roughly between the eyes and the nose tip).'),
    radius: AvatarRadiusSchema.describe('Face oval, skin only: from the hairline to the chin and from cheek to cheek. The head turn is strongest at its centre and fades toward its edge.'),
    eyes: z.strictObject({ imageLeft: AvatarEyeSchema, imageRight: AvatarEyeSchema }),
    brows: z
      .strictObject({
        imageLeft: AvatarPointsSchema.describe('Polyline along the brow, 3-5 points.'),
        imageRight: AvatarPointsSchema.describe('Polyline along the brow, 3-5 points.'),
      })
      .optional()
      .describe('Optional eyebrows (enables BrowLY / BrowRY). Leave out when hair hides them.'),
    nose: AvatarVec2Schema.describe('Nose tip.'),
    mouth: AvatarMouthSchema,
    chin: AvatarVec2Schema.describe('Tip of the chin.'),
    cheeks: z
      .strictObject({
        imageLeft: AvatarVec2Schema,
        imageRight: AvatarVec2Schema,
        radius: Finite.refine((v) => v > 0, 'must be > 0').optional().describe('Blush radius, px. Default: 9% of the face width.'),
      })
      .optional()
      .describe('Optional blush centres (enables Cheek).'),
    ears: z
      .strictObject({ imageLeft: AvatarVec2Schema.optional(), imageRight: AvatarVec2Schema.optional() })
      .optional()
      .describe('Optional visible ears (they move less than the face centre when the head turns).'),
  })
  .describe('Face landmarks.');

// ----------------------------------------------------------------------------- hair

export const AvatarStrandSchema = z
  .strictObject({
    id: IdSchema,
    nodes: AvatarPointsSchema.describe('Polyline from the ROOT of the lock to its TIP, 2-6 points, entirely on hair.'),
    width: Finite.refine((v) => v > 0, 'must be > 0').describe('Width of the lock in px (how wide the sway reaches around the polyline).'),
    swing: Finite.refine((v) => v > 0, 'must be > 0').default(10).describe('Largest tip displacement in px.'),
    stiffness: Finite.refine((v) => v > 0, 'must be > 0').default(1).describe('Spring response: > 1 is stiffer and faster, < 1 is looser and slower.'),
    group: z.enum(['front', 'side', 'back']).default('front').describe('front = bangs, side = locks beside the face, back = hair behind the shoulders.'),
  })
  .describe('One lock of hair that sways with physics.');

export const AvatarHairSchema = z
  .strictObject({
    strands: z.array(AvatarStrandSchema).default([]),
  })
  .describe('Hair that sways. Bangs: 3-5 strands; side hair: about 2 per side.');

// ----------------------------------------------------------------------------- attachments

export const AvatarPendulumSchema = z
  .strictObject({
    id: IdSchema,
    kind: z.literal('pendulum'),
    outline: AvatarPointsSchema.describe('CUTS LAYERS. Polygon around the whole hanging object (tassel, earring, ribbon end).'),
    pivot: AvatarVec2Schema.describe('Where it hangs from (fixed point).'),
    tip: AvatarVec2Schema.describe('Its free end.'),
    swing: Finite.refine((v) => v > 0, 'must be > 0').default(12).describe('Largest swing angle in degrees.'),
    follow: z.enum(['head', 'body']).default('head').describe('What the pivot is attached to.'),
  })
  .describe('A hanging accessory cut into its own layer; it swings from its pivot with physics.');

export const AvatarJiggleSchema = z
  .strictObject({
    id: IdSchema,
    kind: z.literal('jiggle'),
    center: AvatarVec2Schema,
    radius: AvatarRadiusSchema.describe('Ellipse around the whole mass (e.g. a hair bun, without its ribbons).'),
    swing: Finite.refine((v) => v > 0, 'must be > 0').default(4).describe('Largest displacement in px.'),
    follow: z.enum(['head', 'body']).default('head'),
  })
  .describe('A springy mass that wobbles as a whole (hair buns, pom-poms). Not cut out.');

export const AvatarCutoutSchema = z
  .strictObject({
    id: IdSchema,
    kind: z.literal('cutout'),
    outline: AvatarPointsSchema.describe('CUTS LAYERS. Polygon around everything that lies IN FRONT (e.g. a hand and forearm over the chin).'),
    follow: z.enum(['head', 'body']).default('body').describe('What the cut-out moves with.'),
    contact: AvatarVec2Schema.optional().describe('Optional point where it touches the head (e.g. a fingertip on the chin): that end follows the head a little.'),
  })
  .describe('Something in front of the face or body, cut into its own layer; the picture behind it is filled in (approximately).');

export const AvatarAttachmentSchema = z.discriminatedUnion('kind', [AvatarPendulumSchema, AvatarJiggleSchema, AvatarCutoutSchema]);

// ----------------------------------------------------------------------------- body

export const AvatarBodySchema = z
  .strictObject({
    pivot: AvatarVec2Schema.describe('Body sway pivot: middle of the lower torso, near the bottom of the image.'),
    fade: AvatarBandSchema.describe('Rows where the body sway fades out: full above yStart (upper body), none at yEnd (the anchored bottom).'),
    sway: Finite.default(2).describe('Body rotation in degrees at BodyAngleX = ±10.'),
    chest: AvatarEllipseSchema.describe('Chest ellipse: the region that rises when breathing.'),
    breath: Finite.optional().describe('Pixels the chest rises at Breath = 1. Default: 0.35% of the image height.'),
    shoulders: z.tuple([AvatarVec2Schema, AvatarVec2Schema]).optional().describe('Optional shoulder centres [imageLeft, imageRight] (they rise slightly with the breath).'),
  })
  .describe('The body: sway (BodyAngleX) and breathing (Breath).');

// ----------------------------------------------------------------------------- build options

export const AvatarBuildSchema = z
  .strictObject({
    cell: z
      .strictObject({
        body: Finite.refine((v) => v >= 4, 'must be >= 4').optional().describe('Lattice cell of the whole-image warp, px.'),
        head: Finite.refine((v) => v >= 4, 'must be >= 4').optional().describe('Lattice cell of the head warp, px.'),
        detail: Finite.refine((v) => v >= 2, 'must be >= 2').optional().describe('Lattice cell of the eye / mouth warps, px.'),
      })
      .optional()
      .describe('Lattice resolutions. Defaults are chosen from the image size; smaller = smoother but heavier.'),
    feather: Finite.refine((v) => v >= 0, 'must be >= 0').optional().describe('Soft edge of cut layers in px. Default 1.5.'),
    variantTolerance: Finite.refine((v) => v >= 0, 'must be >= 0').optional().describe('How much a drawn variant may differ from the source OUTSIDE its mask (mean absolute difference, 0-255). Default 2.'),
  })
  .describe('Optional tuning of the build. Leave it out unless the review shows a problem.');

// ----------------------------------------------------------------------------- spec

export const AvatarSpecSchema = z
  .strictObject({
    $schema: z.string().optional(),
    format: z.literal(AVATAR_FORMAT),
    version: z.literal(AVATAR_VERSION),
    name: IdSchema.describe('Name of the avatar; the built model is <name>.r2d.json.'),
    image: z
      .strictObject({
        file: z.string().min(1).default('source.png').describe('The illustration, relative to the project folder.'),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .describe('The source illustration and its exact pixel size.'),
    head: AvatarHeadSchema,
    face: AvatarFaceSchema,
    hair: AvatarHairSchema.optional(),
    attachments: z.array(AvatarAttachmentSchema).optional().describe('Optional extra pieces: hanging accessories, wobbling buns, things in front of the face.'),
    body: AvatarBodySchema,
    build: AvatarBuildSchema.optional(),
    post: z
      .array(z.looseObject({ op: z.string() }))
      .optional()
      .describe('Edit ops (docs/OPS.md) applied to the generated model after every build: custom animations, extra bindings. They survive rebuilds.'),
    notes: z.array(z.string()).optional().describe('Free-form notes, e.g. which parts the author is least sure about.'),
  })
  .describe('Rev2D avatar spec (avatar.json): landmarks on one illustration.');

export function avatarJsonSchema(): unknown {
  return z.toJSONSchema(AvatarSpecSchema, { io: 'input', unrepresentable: 'any' });
}
