import { describe, expect, it } from 'vitest';
import { AtlasParseError, findRegion, parseAtlas, regionImageToPage, regionPageRect, regionPageToImage, writeAtlas, type AtlasRegion } from '../atlas.js';
import { fixtureText } from './helpers.js';

describe('spine atlas: reading', () => {
  it('reads the Spine 4.x dialect (bounds, offsets, rotate degrees, pma, scale)', () => {
    const atlas = parseAtlas(fixtureText('hero.atlas'));
    expect(atlas.pages).toEqual([{ name: 'hero.png', width: 64, height: 32, minFilter: 'Linear', magFilter: 'Linear', pma: true, scale: 0.5 }]);
    expect(atlas.regions.map((r) => r.name)).toEqual(['bg', 'head', 'head-alt', 'body', 'body-b']);
    expect(findRegion(atlas, 'bg')).toMatchObject({ page: 0, x: 2, y: 2, width: 10, height: 20, degrees: 90, originalWidth: 10, originalHeight: 20, offsetX: 0, offsetY: 0, index: -1 });
    expect(findRegion(atlas, 'head')).toMatchObject({ x: 30, y: 2, width: 12, height: 10, offsetX: 2, offsetY: 3, originalWidth: 16, originalHeight: 16, degrees: 0 });
  });

  it('reads the legacy libGDX / Spine 3.x dialect (xy, size, orig, offset, rotate: true)', () => {
    const atlas = parseAtlas(fixtureText('legacy.atlas'));
    expect(atlas.pages).toEqual([{ name: 'legacy.png', width: 32, height: 32, format: 'RGBA8888', minFilter: 'Linear', magFilter: 'Linear', repeat: 'none', pma: false }]);
    expect(findRegion(atlas, 'arm')).toEqual({
      name: 'arm',
      page: 0,
      x: 2,
      y: 2,
      width: 8,
      height: 12,
      offsetX: 1,
      offsetY: 2,
      originalWidth: 10,
      originalHeight: 14,
      degrees: 90,
      index: -1,
    });
    expect(findRegion(atlas, 'body')?.degrees).toBe(0);
  });

  it('reads several pages, nine-patch values, unknown fields and CRLF line ends', () => {
    const text = [
      'a.png',
      'size: 16, 16',
      'custom: yes',
      'r1',
      '  xy: 1, 1',
      '  size: 4, 4',
      '  split: 1, 2, 3, 4',
      '  pad: 0, 1, 0, 1',
      '  index: 3',
      '  rotate: 270',
      '  names: 7, 8',
      '',
      'b.png',
      'size: 8, 8',
      'r2',
      '  bounds: 0, 0, 8, 8',
      '',
    ].join('\r\n');
    const atlas = parseAtlas(text);
    expect(atlas.pages.map((p) => p.name)).toEqual(['a.png', 'b.png']);
    expect(atlas.pages[0].extra).toEqual({ custom: ['yes'] });
    expect(atlas.regions[0]).toMatchObject({ page: 0, splits: [1, 2, 3, 4], pads: [0, 1, 0, 1], index: 3, degrees: 270, extra: { names: [7, 8] } });
    expect(atlas.regions[1]).toMatchObject({ name: 'r2', page: 1, width: 8, height: 8, originalWidth: 8, originalHeight: 8 });
    expect(findRegion(atlas, 'r1', 3)?.name).toBe('r1');
    expect(findRegion(atlas, 'r1', 0)).toBeUndefined();
  });

  it('reports malformed values with their line', () => {
    expect(() => parseAtlas('p.png\nsize: 4, x\n')).toThrow(AtlasParseError);
    expect(() => parseAtlas('p.png\nsize: 4, x\n')).toThrow(/line 2/);
    expect(() => parseAtlas('p.png\nr\n  bounds: 1, 2\n')).toThrow(/needs 4 values/);
    expect(() => parseAtlas('p.png\nr\n  rotate: sideways\n')).toThrow(/rotate/);
  });
});

describe('spine atlas: region geometry', () => {
  const base: AtlasRegion = { name: 'r', page: 0, x: 10, y: 20, width: 6, height: 4, offsetX: 1, offsetY: 2, originalWidth: 9, originalHeight: 8, degrees: 0, index: -1 };

  it('maps original-image pixels to the page for every rotation, and back', () => {
    // Packed pixels start at original (1, 8 - 2 - 4) = (1, 2).
    expect(regionImageToPage(base, 1, 2)).toEqual([10, 20]);
    expect(regionImageToPage(base, 7, 6)).toEqual([16, 24]);
    // 90°: the image's top edge runs up the left edge of the page rect (top-left of the image at the
    // bottom-left of the rect).
    const r90 = { ...base, degrees: 90 };
    expect(regionPageRect(r90)).toEqual([10, 20, 4, 6]);
    expect(regionImageToPage(r90, 1, 2)).toEqual([10, 26]);
    expect(regionImageToPage(r90, 7, 2)).toEqual([10, 20]);
    expect(regionImageToPage(r90, 1, 6)).toEqual([14, 26]);
    const r180 = { ...base, degrees: 180 };
    expect(regionImageToPage(r180, 1, 2)).toEqual([16, 24]);
    const r270 = { ...base, degrees: 270 };
    expect(regionImageToPage(r270, 1, 2)).toEqual([14, 20]);
    for (const r of [base, r90, r180, r270]) {
      for (const [px, py] of [[0, 0], [3.5, 1.25], [9, 8], [2, 7]]) {
        const [qx, qy] = regionImageToPage(r, px, py);
        const [bx, by] = regionPageToImage(r, qx, qy);
        expect(bx).toBeCloseTo(px, 12);
        expect(by).toBeCloseTo(py, 12);
      }
    }
  });
});

describe('spine atlas: writing', () => {
  it('round-trips both dialects', () => {
    for (const name of ['hero.atlas', 'legacy.atlas']) {
      const atlas = parseAtlas(fixtureText(name));
      for (const dialect of ['4', 'legacy'] as const) {
        const again = parseAtlas(writeAtlas(atlas, { dialect }));
        expect(again.regions).toEqual(atlas.regions);
        expect(again.pages.map((p) => [p.name, p.width, p.height])).toEqual(atlas.pages.map((p) => [p.name, p.width, p.height]));
        if (dialect === '4') expect(again.pages.map((p) => p.pma)).toEqual(atlas.pages.map((p) => p.pma));
      }
    }
  });

  it('writes the compact 4.x form and the verbose legacy form', () => {
    const atlas = parseAtlas(fixtureText('hero.atlas'));
    const v4 = writeAtlas(atlas);
    expect(v4.startsWith('hero.png\n\tsize: 64, 32\n\tfilter: Linear, Linear\n\tpma: true\n\tscale: 0.5\nbg\n\tbounds: 2, 2, 10, 20\n\trotate: 90\n')).toBe(true);
    expect(v4).toContain('head\n\tbounds: 30, 2, 12, 10\n\toffsets: 2, 3, 16, 16\n');
    const legacy = writeAtlas(parseAtlas(fixtureText('legacy.atlas')), { dialect: 'legacy' });
    expect(legacy).toBe(fixtureText('legacy.atlas'));
  });
});
