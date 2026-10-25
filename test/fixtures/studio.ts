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

/** Authored face landmarks for the fixture only. User images must have their own measured landmarks. */
export function figureAvatarDoc(name = 'figure') {
  const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
    Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2;
      return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
    }).flat();
  const eye = (cx: number) => ({
    opening: ellipse(cx, 117, 12, 15),
    region: ellipse(cx, 117, 23, 25),
    iris: { center: [cx + 2, 119], radius: 5 },
  });
  return {
    format: 'rev2d-avatar',
    version: 1,
    name,
    image: { file: 'source.png', width: 360, height: 480 },
    head: { center: [180, 110], radius: [64, 77], pivot: [180, 187], neck: [181, 198], turn: { x: 2, y: 2 }, tilt: 2 },
    face: {
      center: [180, 125],
      radius: [54, 54],
      eyes: { imageLeft: eye(155), imageRight: eye(205) },
      nose: [178, 136],
      chin: [180, 178],
      mouth: { imageLeft: [162, 150], imageRight: [198, 150], bow: 6, area: { center: [180, 155], radius: [25, 15] } },
    },
    hair: { strands: [] },
    attachments: [],
    body: { pivot: [180, 326], fade: [200, 330], sway: 1, breath: 1, chest: { center: [180, 248], radius: [45, 50] } },
  };
}
