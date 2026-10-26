/** Ground-truth masks are the independently rendered vector alpha, before compositing a key colour. */
import { buildFigure, figureLandmarks, type FigurePose } from '../../scripts/examples/figure.js';
import { buildRoom } from '../../scripts/examples/room.js';
import { parseModelText } from '../../src/core/validate.js';
import { Rig, buildRenderList } from '../../src/core/rig.js';
import { renderImage, createImage, blitImage } from '../../src/render/browser.js';
import type { ImageRGBA } from '../../src/core/types.js';

export function renderFixture(doc: unknown): ImageRGBA {
  const { model, diagnostics } = parseModelText(JSON.stringify(doc));
  if (!model) throw new Error(JSON.stringify(diagnostics));
  const rig = new Rig(model);
  return renderImage(
    buildRenderList(rig, rig.pose({ physics: false })),
    {},
    { supersample: 2, background: [0, 0, 0, 0] },
  );
}
export function figureFixture(pose: FigurePose = 'standing', background?: string) {
  const doc = buildFigure(pose),
    transparent = renderFixture(doc);
  const image = background ? createImage(transparent.width, transparent.height, background) : transparent;
  if (background) blitImage(image, transparent);
  return { doc, image, mask: transparent.data.filter((_, i) => i % 4 === 3), landmarks: figureLandmarks(pose) };
}
export function roomFixture() {
  return { doc: buildRoom(), image: renderFixture(buildRoom()) };
}

export function propFixtures() {
  const make = (name: string, width: number, height: number, parts: unknown[]) =>
    renderFixture({ format: 'rev2d', version: 1, meta: { name, width, height }, parts });
  return {
    box: make('box', 180, 160, [
      {
        id: 'box',
        shape: { type: 'rect', x: 20, y: 25, w: 140, h: 115, radius: 2 },
        fill: '#bd8b55',
        stroke: { color: '#26313c', width: 4 },
      },
    ]),
    thought: make('thought', 240, 180, [
      {
        id: 'cloud',
        shape: { type: 'ellipse', cx: 120, cy: 70, rx: 105, ry: 54 },
        fill: '#ffffff',
        stroke: { color: '#26313c', width: 3 },
      },
      {
        id: 'tail1',
        shape: { type: 'ellipse', cx: 60, cy: 134, rx: 12, ry: 10 },
        fill: '#ffffff',
        stroke: { color: '#26313c', width: 3 },
      },
      {
        id: 'tail2',
        shape: { type: 'ellipse', cx: 38, cy: 157, rx: 6, ry: 6 },
        fill: '#ffffff',
        stroke: { color: '#26313c', width: 2 },
      },
    ]),
  };
}

export { figureAvatarDoc, fullFigureAvatarDoc } from '../../scripts/examples/figure-avatar.js';
