/**
 * The "Drawn variants" section of Avatar mode without a browser (editor/src/avatar/variantRows.ts and
 * the drawn-variant requests of editor/src/avatar/ai.ts): what each row says, which rows show first,
 * how a thumbnail crops the edit area, what "Draw with AI" suggests and sends, and the text for an
 * agent in a terminal.
 */
import { describe, expect, it } from 'vitest';
import type { AvatarVariantsInfo, AvatarVariantStatus } from '../editor/src/api.js';
import { avatarVariantsRequest, drawingProvider, variantsTerminalRequest } from '../editor/src/avatar/ai.js';
import { splitRows, STATE_TONE, suggestedDrawIds, thumbCrop, variantPose, variantRows } from '../editor/src/avatar/variantRows.js';
import { VARIANT_IDS, type VariantId } from '../src/avatar/types.js';
import { VARIANTS } from '../src/avatar/variants-areas.js';

function status(id: VariantId, patch: Partial<AvatarVariantStatus> = {}): AvatarVariantStatus {
  return {
    id,
    group: VARIANTS[id].group,
    label: VARIANTS[id].label,
    recommended: VARIANTS[id].recommended,
    state: 'missing',
    requested: false,
    drawn: false,
    sprite: false,
    stale: [],
    rejection: null,
    check: null,
    file: `variants/${id}.png`,
    maskFile: `variant-requests/${id}.mask.png`,
    promptFile: `variant-requests/${id}.prompt.txt`,
    ...patch,
  };
}

function info(patches: Partial<Record<VariantId, Partial<AvatarVariantStatus>>> = {}): AvatarVariantsInfo {
  const variants = VARIANT_IDS.map((id) => status(id, patches[id]));
  const counts = { missing: 0, requested: 0, drawn: 0, accepted: 0, rejected: 0, stale: 0 };
  for (const v of variants) counts[v.state]++;
  return { project: '/ws/hana', built: true, variants, counts, ignored: [], areas: { eyes: [100, 80, 120, 40], mouth: [140, 160, 40, 20] }, requests: { readme: null, preview: null }, notes: [] };
}

const sample = info({
  eyes_closed: { state: 'accepted', drawn: true, sprite: true, check: { outsideDiff: 0.41, insideChanged: 0.53, badShare: 0, nearDiff: 0.2, tolerance: 2 } },
  mouth_a: { state: 'rejected', drawn: true, rejection: { id: 'mouth_a', drawingHash: 'ab', reason: 'the whole drawing is shifted by 3 px to the right', hint: 'ask again', outsideDiff: 9, insideChanged: 0.2 } },
  eyes_smile: { state: 'stale', drawn: true, sprite: true, stale: ['variants/eyes_smile.png changed since it was imported'] },
  mouth_o: { state: 'drawn', drawn: true },
  eyes_half: { state: 'requested', requested: true },
});

describe('variant rows', () => {
  const files = [
    { path: 'variants/eyes_closed.png', size: 1000, mtimeMs: 1234.5 },
    { path: 'source.png', size: 9, mtimeMs: 7 },
  ];
  const rows = variantRows(sample, files, 'source.png');

  it('say the state, its tone and the line under the name', () => {
    expect(rows.map((r) => [r.id, r.state, r.tone])).toEqual([
      ['eyes_closed', 'accepted', 'success'],
      ['eyes_half', 'requested', 'neutral'],
      ['eyes_smile', 'stale', 'warning'],
      ['mouth_a', 'rejected', 'danger'],
      ['mouth_a_half', 'missing', 'neutral'],
      ['mouth_i', 'missing', 'neutral'],
      ['mouth_u', 'missing', 'neutral'],
      ['mouth_e', 'missing', 'neutral'],
      ['mouth_o', 'drawn', 'tint'],
      ...VARIANT_IDS.slice(9).map(id=>[id,'missing','neutral']),
    ]);
    expect(rows[0].detail).toEqual({ kind: 'check', outside: 0.41, inside: 0.53 });
    expect(rows[1].detail).toEqual({ kind: 'requested' });
    expect(rows[2].detail).toEqual({ kind: 'stale', text: 'variants/eyes_smile.png changed since it was imported' });
    expect(rows[3].detail).toEqual({ kind: 'reason', text: 'the whole drawing is shifted by 3 px to the right', hint: 'ask again' });
    expect(rows[8].detail).toEqual({ kind: 'drawn' });
    expect(rows[4].detail).toEqual({ kind: 'none' });
    expect(Object.keys(STATE_TONE).sort()).toEqual(['accepted', 'drawn', 'missing', 'rejected', 'requested', 'stale']);
  });

  it('show the drawing in the thumbnail when there is one, else the illustration, with a version for caches', () => {
    expect(rows[0].thumb).toEqual({ file: 'variants/eyes_closed.png', version: '1000-1235' });
    expect(rows[1].thumb).toEqual({ file: 'source.png', version: '9-7' });
    expect(rows[8].thumb).toEqual({ file: 'variants/mouth_o.png', version: '' });
    const unreadable = variantRows(info({ mouth_a: { state: 'rejected', drawn: true, unreadable: 'variants/mouth_a.png is a JPEG image' } }), [], 'source.png');
    expect(unreadable[3].thumb.file).toBe('source.png');
    expect(unreadable[3].detail).toEqual({ kind: 'reason', text: 'variants/mouth_a.png is a JPEG image', code: 'unreadable', values: {} });
  });

  it('show the recommended ones and those with something to say first', () => {
    const { shown, hidden } = splitRows(rows);
    expect(shown.map((r) => r.id)).toEqual(['eyes_closed', 'eyes_half', 'eyes_smile', 'mouth_a', 'mouth_o']);
    expect(hidden.map((r) => r.id)).toEqual(['mouth_a_half', 'mouth_i', 'mouth_u', 'mouth_e',...VARIANT_IDS.slice(9)]);
    expect(splitRows(variantRows(info(), [], 'source.png')).shown.map((r) => r.id)).toEqual(['eyes_closed', 'mouth_a']);
  });
});

describe('thumbnails', () => {
  it('fit the whole edit area into the box, centred', () => {
    // A 120 x 40 area into 64 x 32: scale 64 / 120, the area 21.33 px high, centred vertically.
    const c = thumbCrop([100, 80, 120, 40], { width: 512, height: 640 }, { width: 64, height: 32 })!;
    const s = 64 / 120;
    expect(c.backgroundSize).toBe(`${Math.round(512 * s * 100) / 100}px ${Math.round(640 * s * 100) / 100}px`);
    expect(c.backgroundPosition).toBe(`${Math.round(-100 * s * 100) / 100}px ${Math.round(((32 - 40 * s) / 2 - 80 * s) * 100) / 100}px`);
    // A tall area is limited by the height.
    const tall = thumbCrop([0, 0, 10, 64], { width: 100, height: 100 }, { width: 64, height: 32 })!;
    expect(tall.backgroundSize).toBe('50px 50px');
    expect(tall.backgroundPosition).toBe('29.5px 0px');
    expect(thumbCrop(null, { width: 1, height: 1 }, { width: 64, height: 32 })).toBeNull();
    expect(thumbCrop([0, 0, 0, 10], { width: 1, height: 1 }, { width: 64, height: 32 })).toBeNull();
  });
});

describe('Draw with AI', () => {
  it('suggests the recommended variants not in use and every one to redo', () => {
    expect(suggestedDrawIds(info())).toEqual(['eyes_closed', 'mouth_a']);
    expect(suggestedDrawIds(sample)).toEqual(['eyes_smile', 'mouth_a']);
    expect(suggestedDrawIds(info({ eyes_closed: { state: 'accepted' }, mouth_a: { state: 'accepted' } }))).toEqual(['eyes_half', 'mouth_a_half']);
    expect(suggestedDrawIds(null)).toEqual(['eyes_closed', 'mouth_a']);
  });

  it('shows each variant in the preview at its own parameters', () => {
    expect(variantPose('eyes_closed')).toEqual({ EyeLOpen: 0, EyeROpen: 0 });
    expect(variantPose('eyes_half')).toEqual({ EyeLOpen: 0.45, EyeROpen: 0.45 });
    expect(variantPose('eyes_smile')).toEqual({ EyeLSmile: 1, EyeRSmile: 1 });
    expect(variantPose('mouth_u')).toEqual({ MouthOpen: 0.35, MouthForm: -1 });
    expect(variantPose('mouth_a')).toEqual({ MouthOpen: 1, MouthForm: 0 });
  });

  it('sends an avatar-variants job that may generate images, to a provider that can draw', () => {
    expect(avatarVariantsRequest('art/hana', ['eyes_closed', 'mouth_a'], 'codex')).toEqual({
      kind: 'avatar-variants',
      context: { project: 'art/hana', variants: ['eyes_closed', 'mouth_a'] },
      allowImageGeneration: true,
      provider: 'codex',
    });
    expect(avatarVariantsRequest('', [])).toEqual({ kind: 'avatar-variants', context: { project: '' }, allowImageGeneration: true });
    const providers = [
      { id: 'claude', name: 'Claude Code', available: true, features: { imageGeneration: false } },
      { id: 'codex', name: 'Codex', available: false, features: { imageGeneration: true } },
    ];
    expect(drawingProvider({ enabled: true, providers })).toBeNull();
    expect(drawingProvider({ enabled: true, providers: [...providers, { id: 'codex', name: 'Codex', available: true, features: { imageGeneration: true } }] })).toEqual({ id: 'codex', name: 'Codex' });
    expect(drawingProvider(null)).toBeNull();
  });

  it('gives an agent in a terminal the same flow as text', () => {
    const text = variantsTerminalRequest('/ws/art/hana', 'art/hana', ['eyes_closed', 'mouth_a']);
    expect(text).toContain('Rev2D avatar project "art/hana" (/ws/art/hana)');
    for (const s of ['rev2d avatar variants request . eyes_closed mouth_a', 'variant-requests/README.md', 'variants/<id>.png', 'rev2d avatar variants import .', 'rev2d avatar poses .', 'Never modify source.png']) expect(text).toContain(s);
    expect(variantsTerminalRequest('/ws', '', [])).toContain('`rev2d avatar variants request .`');
  });
});
