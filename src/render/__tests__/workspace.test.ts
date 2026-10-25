import { it, expect } from 'vitest';
import { RasterWorkspace } from '../workspace.js';
import { renderImage } from '../raster.js';
import { createImage } from '../image.js';
import type { DrawItem, RenderList } from '../../core/types.js';

it('reuses framebuffer storage without ghosting, output aliases or changing masked texture pixels', () => {
  const workspace = new RasterWorkspace();
  const item: DrawItem = {
    partId: 'image',
    kind: 'fill',
    positions: new Float32Array([2, 2, 22, 2, 22, 22, 2, 22]),
    colors: new Float32Array([1, 1, 1, 0.8, 1, 1, 1, 0.8, 1, 1, 1, 0.8, 1, 1, 1, 0.8]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    texture: 't',
    blend: 'normal',
  };
  item.masks = [
    {
      ...item,
      texture: undefined,
      masks: undefined,
      colors: new Float32Array([1, 1, 1, 0.5, 1, 1, 1, 0.5, 1, 1, 1, 0.5, 1, 1, 1, 0.5]),
    },
  ];
  const list: RenderList = { width: 24, height: 24, background: [0, 0, 0, 0], draws: [item] },
    textures = { t: createImage(4, 4, '#37aaccaa') };
  const a = renderImage(list, textures, { workspace }),
    snapshot = new Uint8ClampedArray(a.data);
  expect(a.data).toEqual(renderImage(list, textures).data);
  const empty = { ...list, draws: [] };
  expect(renderImage(empty, textures, { workspace }).data).toEqual(renderImage(empty, textures).data);
  for (const scale of [0.5, 1, 2, 1])
    for (const supersample of [1, 2])
      expect(renderImage(list, textures, { workspace, scale, supersample }).data).toEqual(
        renderImage(list, textures, { scale, supersample }).data,
      );
  expect(a.data).toEqual(snapshot);
  const cached = new RasterWorkspace({ cacheTextures: true });
  expect(renderImage(list, textures, { workspace: cached }).data).toEqual(renderImage(list, textures).data);
  const other = { t: createImage(4, 4, '#ff8844cc') };
  expect(renderImage(list, other, { workspace: cached }).data).toEqual(renderImage(list, other).data);
  other.t.data.fill(0);
  cached.resetTextures();
  expect(renderImage(list, other, { workspace: cached }).data).toEqual(renderImage(list, other).data);
});
