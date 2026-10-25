/** Versioned reusable artwork catalogue. Pure and browser-safe. */
import { z } from 'zod';
import { IdSchema } from '../core/schema.js';
import type { Diagnostic } from '../core/types.js';

const Point = z.tuple([z.number(), z.number()]);
const Size = z.tuple([z.number().int().positive(), z.number().int().positive()]);
const File = z
  .string()
  .min(1)
  .refine(
    (p) => !p.includes('\\') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..'),
    'use a relative forward-slash path inside the library',
  );
const Tags = z.array(z.string()).default([]);
const Anchor = z.union([
  Point,
  z.enum(['feet', 'seat', 'center', 'bottom-center', 'top-left', 'top-center', 'bottom-left', 'bottom-right']),
]);
const NamedAnchor = z
  .strictObject({
    at: Point.optional(),
    rect: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).optional(),
    scale: z.number().positive().default(1),
    pose_tags: Tags,
  })
  .refine((a) => Boolean(a.at) !== Boolean(a.rect), 'provide at or rect, not both');
const Pose = z.strictObject({
  id: IdSchema,
  avatar: File,
  anchor: Anchor.default('feet'),
  facing: z.enum(['front', 'back', 'left', 'right', 'three-quarter']).default('front'),
  tags: Tags,
});
export const LibrarySchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1),
  style: z.strictObject({ prompt: z.string() }).optional(),
  backgrounds: z
    .array(
      z.strictObject({
        id: IdSchema,
        src: File,
        size: Size,
        tags: Tags,
        anchors: z.record(z.string(), NamedAnchor).default({}),
        floor_y: z.number().optional(),
        variants: z.record(z.string(), File).default({}),
      }),
    )
    .default([]),
  characters: z
    .array(
      z.strictObject({
        id: IdSchema,
        name: z.string(),
        description: z.string().default(''),
        references: z.array(File).default([]),
        height: z.number().positive(),
        poses: z.array(Pose).default([]),
      }),
    )
    .default([]),
  props: z
    .array(z.strictObject({ id: IdSchema, src: File, anchor: Anchor.default('bottom-center'), tags: Tags }))
    .default([]),
  bubbles: z
    .array(
      z.strictObject({
        id: IdSchema,
        src: File,
        content_rect: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]),
        tail: Point,
        tags: Tags,
      }),
    )
    .default([]),
  ui: z
    .array(
      z.strictObject({ id: IdSchema, model: File, params: z.record(z.string(), z.string()).default({}), tags: Tags }),
    )
    .default([]),
});
export type Library = z.output<typeof LibrarySchema>;
export const LIBRARY_KINDS = ['background', 'character', 'prop', 'bubble', 'ui'] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];
export function libraryDiagnostic(
  code: string,
  path: string,
  message: string,
  hint: string,
  severity: Diagnostic['severity'] = 'error',
): Diagnostic {
  return { code, path, message, hint, severity };
}
export class LibraryError extends Error {
  constructor(public diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('; '));
  }
}
export function parseLibrary(input: unknown): { library: Library | null; diagnostics: Diagnostic[] } {
  const parsed = LibrarySchema.safeParse(input);
  if (!parsed.success)
    return {
      library: null,
      diagnostics: parsed.error.issues.map((d) =>
        libraryDiagnostic(
          'library-schema-' + d.code.replaceAll('_', '-'),
          '/' + d.path.map((x) => String(x).replaceAll('~', '~0').replaceAll('/', '~1')).join('/'),
          d.message,
          'follow the version 1 library format in docs/LIBRARY.md',
        ),
      ),
    };
  const library = parsed.data,
    diagnostics: Diagnostic[] = [];
  const check = (items: { id: string }[], pointer: string) => {
    const ids = new Set<string>();
    items.forEach((v, i) => {
      if (ids.has(v.id))
        diagnostics.push(
          libraryDiagnostic(
            'library-duplicate-id',
            `${pointer}/${i}/id`,
            `duplicate id "${v.id}"`,
            'give every item within its kind a unique id',
          ),
        );
      ids.add(v.id);
    });
  };
  for (const [kind, items] of Object.entries({
    backgrounds: library.backgrounds,
    characters: library.characters,
    props: library.props,
    bubbles: library.bubbles,
    ui: library.ui,
  }))
    check(items, '/' + kind);
  library.characters.forEach((c, i) => check(c.poses, `/characters/${i}/poses`));
  return { library, diagnostics };
}
