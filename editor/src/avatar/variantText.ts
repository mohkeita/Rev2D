/**
 * Words of the drawn variants in the person's language: the name of a variant and why a drawing was
 * rejected (from the stable code of the check, src/avatar/variants-check.ts; the English reason of the
 * check stays the fallback and the tooltip).
 */
import type { VariantId } from '../../../src/avatar/types.js';
import type { Translate } from '../i18n/index.js';

export function variantLabel(t: Translate, id: VariantId): string {
  return t(`avatar.variant.${id}` as 'avatar.variant.eyes_closed');
}

/** A rejection in the person's language, or `fallback` (the check's English reason) for an unknown code. */
export function rejectText(t: Translate, code: string | undefined, values: Record<string, number | string> | undefined, fallback: string): string {
  const v = values ?? {};
  switch (code) {
    case 'size':
      return t('avatar.variants.reject.size', { width: v.width ?? '?', height: v.height ?? '?', sourceWidth: v.sourceWidth ?? '?', sourceHeight: v.sourceHeight ?? '?' });
    case 'zoom':
      return v.direction === 'out' ? t('avatar.variants.reject.zoomOut', { percent: v.percent ?? '?' }) : t('avatar.variants.reject.zoomIn', { percent: v.percent ?? '?' });
    case 'shift':
      return t('avatar.variants.reject.shift', { dx: v.dx ?? 0, dy: v.dy ?? 0 });
    case 'outside':
      return t('avatar.variants.reject.outside', { diff: v.diff ?? '?', limit: v.limit ?? '?' });
    case 'bad':
      return t('avatar.variants.reject.bad', { share: v.share ?? '?' });
    case 'seam':
      return t('avatar.variants.reject.seam');
    case 'unchanged':
      return t('avatar.variants.reject.unchanged');
    case 'one-eye':
      return t('avatar.variants.reject.oneEye', { side: v.unchanged === 'imageRight' ? t('avatar.side.imageRight') : t('avatar.side.imageLeft') });
    case 'unreadable':
      return t('avatar.variants.reject.unreadable');
    default:
      return fallback;
  }
}
