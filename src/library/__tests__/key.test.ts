import { describe, it, expect } from 'vitest';
import { FIGURE_POSES } from '../../../scripts/examples/figure.js';
import { figureFixture } from '../../../test/fixtures/studio.js';
import { keyImage } from '../key.js';
import { LibraryError } from '../schema.js';
import { createImage } from '../../render/browser.js';
import { encodePNG } from '../../render/png.js';

describe('library key ground truth', () => {
  for (const pose of FIGURE_POSES)
    for (const color of ['#00ff00', '#ffffff'])
      it(`${pose} on ${color}: IoU, spill, black outlines and deterministic bytes`, () => {
        const { image, mask } = figureFixture(pose, color),
          before = new Uint8ClampedArray(image.data),
          cut = keyImage(image, { trim: false });
        let intersection = 0,
          union = 0,
          green = 0,
          subject = 0,
          ink = 0,
          lostInk = 0;
        for (let i = 0; i < mask.length; i++) {
          const a = mask[i] > 127,
            b = cut.image.data[i * 4 + 3] > 127;
          if (a && b) intersection++;
          if (a || b) union++;
          if (b) {
            subject++;
            if (cut.image.data[i * 4 + 1] > Math.max(cut.image.data[i * 4], cut.image.data[i * 4 + 2]) + 30) green++;
          }
          if (a && image.data[i * 4] + image.data[i * 4 + 1] + image.data[i * 4 + 2] < 180) {
            ink++;
            if (!b) lostInk++;
          }
        }
        expect(intersection / union).toBeGreaterThanOrEqual(0.98);
        expect(green / subject).toBeLessThan(0.001);
        expect(lostInk / ink).toBeLessThan(0.001);
        expect(encodePNG(keyImage(image, { trim: false }).image)).toEqual(encodePNG(cut.image));
        expect(image.data).toEqual(before);
      });
  it('rejects a noisy border with a code, pointer and fix', () => {
    const image = createImage(80, 80, '#00ff00');
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 40; x++) {
        const b = (y * 80 + x) * 4;
        image.data[b] = 255;
        image.data[b + 1] = 0;
        image.data[b + 2] = 255;
      }
    try {
      keyImage(image);
      throw new Error('accepted noisy background');
    } catch (e) {
      expect(e).toBeInstanceOf(LibraryError);
      expect((e as LibraryError).diagnostics[0]).toMatchObject({
        code: 'library-key-background-noisy',
        path: '/image',
        hint: expect.any(String),
      });
    }
  });
  it('preserves a transparent cutout, trims and warns on clipped subjects', () => {
    const image = createImage(30, 30);
    for (let y = 5; y < 15; y++) for (let x = 0; x < 10; x++) image.data.set([0, 0, 0, 255], (y * 30 + x) * 4);
    const cut = keyImage(image, { padding: 2 });
    expect(cut.offset).toEqual([0, 3]);
    expect(cut.image.width).toBe(12);
    expect(cut.diagnostics.map((d) => d.code)).toContain('library-key-subject-touches-border');
  });
});
