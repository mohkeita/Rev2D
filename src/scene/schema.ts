/** Scene version 1. Pure, deterministic, and safe to import in browsers. */
import { z } from 'zod';
import { EaseSchema, IdSchema } from '../core/schema.js';
import type { Diagnostic } from '../core/types.js';

export const TimeSchema = z.union([z.number().finite(), z.string().startsWith('@')]);
const Point = z.tuple([z.number(), z.number()]);
const Anchor = z.union([
  Point,
  z.enum([
    'center',
    'top-left',
    'top-center',
    'bottom-center',
    'bottom-left',
    'bottom-right',
    'feet',
    'seat',
  ]),
]);
const Key = z.strictObject({ t: TimeSchema, v: z.number(), ease: EaseSchema.optional() });
const Appearance = z.strictObject({
  t: TimeSchema,
  type: z.enum(['pop', 'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'wipe', 'draw-on']),
  duration: z.number().positive().default(0.35),
  overshoot: z.number().min(0).max(1).default(0.15),
  ease: EaseSchema.optional(),
});
const Animation = z.union([
  z.string().min(1),
  z.strictObject({
    id: z.string().min(1),
    start: TimeSchema.optional(),
    time: z.number().optional(),
    once: z.boolean().optional(),
    hold: z.boolean().optional(),
    mode: z.enum(['add', 'override']).optional(),
    weight: z.number().min(0).max(1).optional(),
  }),
]);
const common = {
  id: IdSchema,
  z: z.number().optional(),
  depth: z.number().min(0).max(4).default(1),
  x: z.number().default(0),
  y: z.number().default(0),
  scale: z.number().positive().default(1),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  anchor: Anchor.optional(),
  flip: z.boolean().default(false),
  at: z.union([Point, z.string().min(1)]).optional(),
  attach: z.string().min(1).optional(),
  offset: Point.default([0, 0]),
  enter: Appearance.optional(),
  exit: Appearance.optional(),
  animations: z.array(Animation).default([]),
  params: z.record(z.string(), z.number()).default({}),
  tracks: z.array(z.strictObject({ param: z.string().min(1), keys: z.array(Key).min(1) })).default([]),
};
export const SceneLayerSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('background'), ref: z.string().min(1) }),
  z.strictObject({
    ...common,
    type: z.literal('character'),
    character: z.string().min(1),
    poses: z
      .array(
        z.strictObject({
          t: TimeSchema,
          pose: z.string().min(1),
          transition: z
            .strictObject({
              type: z.enum(['cut', 'dissolve']).default('cut'),
              duration: z.number().positive().default(0.3),
            })
            .optional(),
        }),
      )
      .min(1),
  }),
  z.strictObject({ ...common, type: z.literal('prop'), ref: z.string().min(1) }),
  z.strictObject({
    ...common,
    type: z.literal('bubble'),
    ref: z.string().min(1),
    content: z.strictObject({ type: z.literal('image'), src: z.string().min(1) }).optional(),
  }),
  z.strictObject({ ...common, type: z.literal('ui'), ref: z.string().min(1) }),
  z.strictObject({ ...common, type: z.literal('image'), src: z.string().min(1) }),
  z.strictObject({ ...common, type: z.literal('model'), src: z.string().min(1) }),
  z.strictObject({ ...common, type: z.literal('color'), color: z.string().min(1) }),
]);
const CameraKey = z.strictObject({
  t: TimeSchema,
  x: z.number().optional(),
  y: z.number().optional(),
  zoom: z.number().positive().default(1),
  rotation: z.number().default(0),
  ease: EaseSchema.optional(),
});
export const CameraSchema = z.strictObject({
  keys: z.array(CameraKey).default([]),
  preset: z.string().optional(),
  shake: z
    .array(
      z.strictObject({
        start: TimeSchema,
        end: TimeSchema,
        amplitude: z.number().nonnegative(),
        frequency: z.number().positive().default(14),
        seed: z.number().int(),
      }),
    )
    .default([]),
  follow: z
    .strictObject({
      layer: z.string().min(1),
      frequency: z.number().positive().max(20).default(2),
      offset: Point.default([0, 0]),
    })
    .nullable()
    .default(null),
});
export const SceneSchema = z
  .strictObject({
    version: z.literal(1),
    library: z.string().min(1).optional(),
    width: z.number().int().min(2).max(3840).default(1920),
    height: z.number().int().min(2).max(3840).default(1080),
    fps: z.number().positive().max(120).default(24),
    duration: z.number().positive().max(86400),
    background: z.string().default('#000000'),
    narration: z
      .strictObject({
        audio: z.string().optional(),
        alignment: z.string().optional(),
        offset: z.number().nonnegative().default(0),
      })
      .optional(),
    layers: z.array(SceneLayerSchema).default([]),
    tracks: z.array(z.strictObject({ target: z.string().min(1), keys: z.array(Key).min(1) })).default([]),
    camera: z.union([CameraSchema, z.string().min(1)]).default({ keys: [], shake: [], follow: null }),
    look: z.null().optional(),
  })
  .refine((s) => s.width * s.height <= 3840 * 2160, {
    path: ['width'],
    message: 'maximum area is 3840 × 2160 (portrait allowed)',
  });
export type Scene = z.output<typeof SceneSchema>;
export type SceneInput = z.input<typeof SceneSchema>;
export type SceneLayer = Scene['layers'][number];
export type SceneTime = z.output<typeof TimeSchema>;
export type Appearance = z.output<typeof Appearance>;
export type Camera = z.output<typeof CameraSchema>;
export type NumberKey = z.output<typeof Key>;
export function sceneDiagnostic(
  code: string,
  path: string,
  message: string,
  hint: string,
  severity: Diagnostic['severity'] = 'error',
): Diagnostic {
  return { severity, code, path, message, hint };
}
export class SceneError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('; '));
  }
}
export function parseScene(input: unknown): { scene: Scene | null; diagnostics: Diagnostic[] } {
  const r = SceneSchema.safeParse(input);
  if (r.success) return { scene: r.data, diagnostics: [] };
  return {
    scene: null,
    diagnostics: r.error.issues.map((d) =>
      sceneDiagnostic(
        d.path[0] === 'fps'
          ? 'scene-fps-range'
          : ['width', 'height'].includes(String(d.path[0]))
            ? 'scene-size-range'
            : 'scene-schema-' + d.code.replaceAll('_', '-'),
        '/' + d.path.map((p) => String(p).replaceAll('~', '~0').replaceAll('/', '~1')).join('/'),
        d.message,
        'follow the version 1 scene format in docs/SCENE.md',
      ),
    ),
  };
}
/** A resolved scene contains numbers at every time position. */
export function seconds(t: SceneTime): number {
  if (typeof t !== 'number')
    throw new SceneError([
      sceneDiagnostic(
        'scene-cue-not-found',
        '',
        `unresolved cue ${t}`,
        'load the narration alignment before evaluating the scene',
      ),
    ]);
  return t;
}
