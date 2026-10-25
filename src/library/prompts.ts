import { suggest } from '../core/address.js';
import { LibraryError, libraryDiagnostic, type Library, type LibraryKind } from './schema.js';

export interface RequestOptions {
  kind: Exclude<LibraryKind, 'ui'>;
  id?: string;
  character?: string;
  pose?: string;
  size?: [number, number];
}
export function generationRequest(library: Library, options: RequestOptions) {
  const character = library.characters.find((c) => c.id === options.character);
  if (options.kind === 'character' && !character)
    throw new LibraryError([
      libraryDiagnostic(
        'library-unknown-character',
        '/character',
        `unknown character "${options.character ?? ''}"`,
        suggest(
          options.character ?? '',
          library.characters.map((c) => c.id),
        ) ?? 'add a character with references to library.json first',
      ),
    ]);
  const size = options.size ?? (options.kind === 'background' ? [1920, 1080] : [1024, 1536]);
  const prompt = [
    library.style?.prompt ?? 'Clean 2D cartoon, crisp dark outlines, consistent flat colours.',
    options.kind === 'character'
      ? `Character ${character!.name}: ${character!.description}. Pose: ${options.pose ?? 'standing'}. Full body, hands and feet entirely in frame, same character as the attached references.`
      : options.kind === 'background'
        ? `Empty reusable background: ${options.id ?? 'room'}. No people, no captions. Leave space for characters and props.`
        : `${options.kind}: ${options.id ?? options.kind}. Isolated, complete silhouette.`,
    options.kind === 'background'
      ? 'Keep the requested composition and perspective.'
      : 'Plain #00FF00 background, no shadow, no gradient, no green in the subject. Leave a clear margin on all sides.',
    `Output one PNG, ${size[0]}x${size[1]} pixels. No sheet, collage, labels or watermark.`,
  ].join('\n');
  return {
    version: 1 as const,
    kind: options.kind,
    character: options.character,
    pose: options.pose,
    id: options.id,
    size,
    prompt,
    references: character?.references ?? [],
  };
}
