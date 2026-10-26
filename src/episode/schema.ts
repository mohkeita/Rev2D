/** Version-1 storyboard contract. Pure and browser-safe; all times are seconds. */
import { z } from 'zod';
import type { Diagnostic } from '../core/types.js';
import { IdSchema } from '../core/schema.js';
import { SceneLayerFields, SceneLayerSchema, SceneSchema, TimeSchema } from '../scene/schema.js';
const File = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.includes('\0') && !p.includes('\\') && !p.startsWith('/') && !/^[A-Za-z]:|^[A-Za-z]+:\/\//.test(p),
    'use a relative forward-slash local file path',
  );
export const TransitionSchema = z.union([
  z
    .enum(['cut', 'dissolve', 'whip-left', 'whip-right', 'dip-to-black'])
    .transform((type) => ({ type, duration: type === 'cut' ? 0 : 0.35 })),
  z
    .strictObject({
      type: z.enum(['cut', 'dissolve', 'whip-left', 'whip-right', 'dip-to-black']),
      duration: z.number().nonnegative().max(10).default(0.35),
    })
    .refine((v) => v.type === 'cut' || v.duration > 0, 'non-cut transitions need positive duration')
    .transform((v) => ({ ...v, duration: v.type === 'cut' ? 0 : v.duration })),
]);
const Acting = {
  t: TimeSchema.default(0),
  duration: z.number().positive().optional(),
  intensity: z.number().min(0).max(1).optional(),
  hold: z.number().nonnegative().optional(),
  release: z.number().positive().optional(),
};
const Character = z.strictObject({
  ...SceneLayerFields,
  character: z.string().min(1).optional(),
  layer: IdSchema.optional(),
  pose: z.string().default('standing'),
  expressions: z.array(z.strictObject({ ...Acting, name: z.string().min(1) })).default([]),
  gestures: z
    .array(
      z.strictObject({
        ...Acting,
        name: z.string().min(1),
        side: z.enum(['R', 'L', 'both']).optional(),
        count: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      }),
    )
    .default([]),
});
const Asset = z.strictObject({
  ...SceneLayerFields,
  id: IdSchema.optional(),
  ref: z.string().min(1),
  content: z.strictObject({ type: z.literal('image'), src: File }).optional(),
});
export const ShotSchema = z
  .strictObject({
    id: IdSchema,
    start: TimeSchema,
    end: TimeSchema,
    background: z.string().min(1).optional(),
    characters: z.array(Character).default([]),
    props: z.array(Asset).default([]),
    bubbles: z.array(Asset).default([]),
    ui: z.array(Asset).default([]),
    layers: z.array(SceneLayerSchema).default([]),
    scene: File.optional(),
    external: z
      .strictObject({
        video: File,
        fit: z.enum(['cover', 'contain']).default('cover'),
        from: z.number().nonnegative().default(0),
      })
      .optional(),
    camera: SceneSchema.shape.camera.optional(),
    transition: TransitionSchema.optional(),
    focus: z
      .union([z.string().min(1), z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])])
      .optional(),
    note: z.string().default(''),
    look: z.null().optional(),
  })
  .refine((s) => !(s.scene && s.external), 'scene and external are mutually exclusive');
export const EpisodeSchema = z
  .strictObject({
    version: z.literal(1),
    id: IdSchema,
    library: File.optional(),
    size: z
      .tuple([z.number().int().min(2).max(3840), z.number().int().min(2).max(3840)])
      .default([1920, 1080]),
    fps: z.number().positive().max(120).default(24),
    narration: z.strictObject({ audio: File, alignment: File.optional() }),
    music: z
      .strictObject({
        src: File,
        gain: z.number().min(0).max(4).default(0.25),
        duck: z
          .strictObject({ under: z.literal('narration'), amount: z.number().min(0).max(1).default(0.5) })
          .optional(),
      })
      .optional(),
    defaults: z
      .strictObject({
        camera: SceneSchema.shape.camera.default('static'),
        transition: TransitionSchema.default({ type: 'cut', duration: 0 }),
        look: z.null().optional(),
      })
      .default({ camera: 'static', transition: { type: 'cut', duration: 0 } }),
    shots: z.array(ShotSchema).min(1).max(1000),
  })
  .refine((s) => s.size[0] * s.size[1] <= 3840 * 2160, {
    path: ['size'],
    message: 'maximum area is 3840 × 2160',
  });
export type Episode = z.output<typeof EpisodeSchema>;
export type EpisodeInput = z.input<typeof EpisodeSchema>;
export type Shot = Episode['shots'][number];
export type Transition = z.output<typeof TransitionSchema>;
export const episodeDiagnostic = (
  code: string,
  path: string,
  message: string,
  hint: string,
  severity: Diagnostic['severity'] = 'error',
): Diagnostic => ({ code, path, message, hint, severity });
export class EpisodeError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('; '));
  }
}
export function parseEpisode(input: unknown): { episode: Episode | null; diagnostics: Diagnostic[] } {
  const p = EpisodeSchema.safeParse(input);
  return p.success
    ? { episode: p.data, diagnostics: [] }
    : {
        episode: null,
        diagnostics: p.error.issues.map((d) =>
          episodeDiagnostic(
            'episode-schema-' + d.code.replaceAll('_', '-'),
            '/' + d.path.join('/'),
            d.message,
            'follow the version 1 storyboard format in docs/EPISODE.md',
          ),
        ),
      };
}
