import { it, expect } from 'vitest';
import { parseAvatarSpec, buildAvatarLayers, compileAvatar } from '../src/avatar/index.js';
import { buildSprites } from '../src/avatar/variants-sprites.js';
import { VARIANT_IDS } from '../src/avatar/types.js';
import { VARIANTS, variantInputsHash, variantEditAreas } from '../src/avatar/variants-areas.js';
import { validateModel } from '../src/core/validate.js';
import { Rig } from '../src/core/rig.js';
import { actingDrawing } from '../scripts/examples/acting-art.js';
import { figureFixture, fullFigureAvatarDoc } from './fixtures/studio.js';
import { variantPose } from '../editor/src/avatar/variantRows.js';
import { generateGesture } from '../src/gestures/index.js';
const source = figureFixture('standing').image,
  spec = parseAvatarSpec(fullFigureAvatarDoc()).spec!,
  layers = buildAvatarLayers(spec, source);
const ids = VARIANT_IDS.filter(
  (id) => VARIANTS[id].expression !== undefined || VARIANTS[id].handForm !== undefined || id === 'eyes_wide',
);
const drawings = Object.fromEntries(ids.map((id) => [id, actingDrawing(source, spec, id)])),
  sprites = buildSprites(spec, layers.meta, source, drawings),
  compiled = compileAvatar(spec, sprites.meta),
  validated = validateModel(compiled.doc);
it('accepts every new original drawing through the normal mask/change/seam checks', () => {
  expect(ids).toHaveLength(21);
  expect(sprites.rejected, JSON.stringify(sprites.checks.filter((c) => !c.ok))).toEqual([]);
  expect(sprites.accepted).toEqual(ids);
  expect(validated.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
});
for (const id of ids)
  it(`shows ${id} only at the intended control value and preserves the rest image`, () => {
    const model = validated.model!,
      rig = new Rig(model),
      rest = rig.pose({ physics: false }),
      pose = rig.pose({ params: variantPose(id), physics: false });
    const parts = model.parts.filter((p) => p.id.startsWith('sprite_' + id + '_'));
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(rest.parts[part.id].opacity).toBe(0);
      expect(pose.parts[part.id].opacity).toBeGreaterThan(0.99);
    }
    if (id.startsWith('hand')) {
      const side = id.startsWith('handR') ? 'R' : 'L';
      expect(parts.every((p) => p.parent === 'arm' + side + 'Hand')).toBe(true);
      expect(pose.parts['arm' + side + 'HandImage'].opacity).toBe(0);
    }
  });
it('keeps discrete hand choice at low intensity and skips it when no drawing exists', () => {
  const model = validated.model!,
    a = generateGesture(model, 'point_right', { intensity: 0.3 }).animation;
  expect(a.tracks.find((t) => t.target === 'param:HandLForm')!.keys[1].v).toBe(3);
  const bare = validateModel(compileAvatar(spec, layers.meta).doc).model!;
  expect(
    generateGesture(bare, 'point_right').diagnostics.some((d) => d.code === 'gesture-missing-param'),
  ).toBe(true);
});
it('hashes hand/brow landmarks and rejects a hand request without authored arms', () => {
  const changed = structuredClone(spec);
  changed.arms![0].hand.radius++;
  expect(variantInputsHash(spec, 'handR')).not.toBe(variantInputsHash(changed, 'handR'));
  const noArms = structuredClone(spec);
  delete noArms.arms;
  expect(() => variantEditAreas(noArms, 'handR')).toThrow('requires authored');
});

it('keeps unchanged neighbouring clothing out of a moving glove sprite', () => {
  for (const side of ['R', 'L'] as const) {
    const id = `hand${side}_point` as (typeof ids)[number],
      arm = spec.arms!.find((a) => a.id === 'arm' + side)!,
      drawing = drawings[id];
    const layer = sprites.meta.layers.find((l) => l.id === `sprite_${id}_hand`)!,
      image = sprites.images[layer.file];
    let forbidden = 0;
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++) {
        const gx = x + layer.rect[0],
          gy = y + layer.rect[1],
          si = (gy * source.width + gx) * 4,
          di = (y * image.width + x) * 4;
        if (Math.hypot(gx + 0.5 - arm.hand.center[0], gy + 0.5 - arm.hand.center[1]) <= arm.hand.radius + 2)
          continue;
        const changed = [0, 1, 2, 3].some((c) => Math.abs(drawing.data[si + c] - source.data[si + c]) > 2);
        if (!changed && image.data[di + 3] > 0) forbidden++;
      }
    expect(forbidden).toBe(0);
  }
});
