/** Original synthetic acting drawings, for fixtures and reproducible demos only. */
import type { ImageRGBA } from '../../src/core/types.js';
import type { AvatarSpec, VariantId } from '../../src/avatar/types.js';
import { VARIANTS, variantEditAreas, variantEditable } from '../../src/avatar/variants-areas.js';
import { ellipseMask, strokeMask } from '../../src/avatar/image/raster.js';
import type { Mask } from '../../src/avatar/image/types.js';

export function actingDrawing(source: ImageRGBA, spec: AvatarSpec, id: VariantId): ImageRGBA {
  const out = { ...source, data: new Uint8ClampedArray(source.data) },
    def = VARIANTS[id],
    editable = variantEditable(variantEditAreas(spec, def.group));
  const paint = (mask: Mask, color: readonly number[]) => {
    for (let i = 0; i < mask.data.length; i++) {
      const a = mask.data[i];
      if (!a) continue;
      const j = i * 4,
        old = out.data[j + 3] / 255,
        newA = a + old * (1 - a);
      for (let c = 0; c < 3; c++)
        out.data[j + c] = (color[c] * a + out.data[j + c] * old * (1 - a)) / (newA || 1);
      out.data[j + 3] = newA * 255;
    }
  };
  const ellipse = (x: number, y: number, rx: number, ry: number, color: readonly number[]) =>
    paint(ellipseMask(source.width, source.height, x, y, rx, ry), color);
  const line = (points: number[], width: number, color: readonly number[]) =>
    paint(strokeMask(source.width, source.height, points, width), color);
  const ink = [38, 49, 60],
    white = [255, 255, 255],
    skin = [247, 203, 166];
  if (def.handForm !== undefined) {
    const arm = spec.arms!.find((a) => a.id === (def.group === 'handR' ? 'armR' : 'armL'))!,
      [cx, cy] = arm.hand.center,
      r = arm.hand.radius,
      angle = Math.atan2(arm.wrist[1] - arm.elbow[1], arm.wrist[0] - arm.elbow[0]);
    const at = (x: number, y: number) => [
      cx + Math.cos(angle) * x - Math.sin(angle) * y,
      cy + Math.sin(angle) * x + Math.cos(angle) * y,
    ];
    for (let y = 0; y < source.height; y++)
      for (let x = 0; x < source.width; x++)
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r + 1) out.data[(y * source.width + x) * 4 + 3] = 0;
    line([...at(-r * 0.9, 0), ...at(r * 0.08, 0)], r * 0.65, ink);
    line([...at(-r * 0.9, 0), ...at(r * 0.08, 0)], r * 0.45, white);
    const palm = def.handForm === 2 ? at(r * 0.1, 0) : at(0, 0);
    ellipse(...(palm as [number, number]), r * 0.58, r * 0.56, ink);
    ellipse(...(palm as [number, number]), r * 0.48, r * 0.46, white);
    let fingers =
      def.handForm === 1 ? 4 : def.handForm === 3 ? 1 : def.handForm === 6 ? 2 : def.handForm === 7 ? 3 : 0;
    for (let i = 0; i < fingers; i++) {
      const spread = (i - (fingers - 1) / 2) * 0.28,
        start = at(r * 0.15, spread * r),
        end = at(r * (def.handForm === 3 ? 1.25 : 1.05), spread * r * 1.8);
      line([...start, ...end], r * 0.3, ink);
      line([...start, ...end], r * 0.19, white);
    }
    if (def.handForm === 5) {
      line([...at(0, r * 0.2), ...at(r * 0.9, r * 0.8)], r * 0.4, ink);
      line([...at(0, r * 0.2), ...at(r * 0.9, r * 0.8)], r * 0.28, white);
    }
    if (def.handForm === 2) {
      line([...at(-r * 0.2, -r * 0.3), ...at(r * 1.1, -r * 0.3)], r * 0.5, ink);
      line([...at(-r * 0.2, -r * 0.3), ...at(r * 1.1, -r * 0.3)], r * 0.36, white);
    }
  } else if (def.eye === 'wide') {
    for (const eye of Object.values(spec.face.eyes)) {
      const xs = eye.opening.filter((_, i) => i % 2 === 0),
        ys = eye.opening.filter((_, i) => i % 2 === 1),
        cx = (Math.min(...xs) + Math.max(...xs)) / 2,
        cy = (Math.min(...ys) + Math.max(...ys)) / 2,
        rx = (Math.max(...xs) - Math.min(...xs)) / 2,
        ry = (Math.max(...ys) - Math.min(...ys)) * 0.6;
      ellipse(cx, cy, rx + 2, ry + 2, ink);
      ellipse(cx, cy, rx, ry, white);
      ellipse(cx + 2, cy, 5, 7, ink);
      ellipse(cx + 3, cy - 2, 1.5, 2, white);
    }
  } else if (def.group === 'brows') {
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const eye = spec.face.eyes[side],
        xs = eye.region.filter((_, i) => i % 2 === 0),
        ys = eye.region.filter((_, i) => i % 2 === 1),
        cx = (Math.min(...xs) + Math.max(...xs)) / 2,
        cy = Math.min(...ys) - 8,
        sign = side === 'imageLeft' ? 1 : -1;
      line(
        [
          cx - 14,
          cy + (id === 'brows_worried' ? -sign : sign) * 5,
          cx,
          cy - 2,
          cx + 14,
          cy + (id === 'brows_worried' ? sign : -sign) * 5,
        ],
        4,
        [100, 55, 35],
      );
    }
  } else if (def.group === 'mouth') {
    const {
      center: [cx, cy],
      radius: [rx, ry],
    } = spec.face.mouth.area;
    ellipse(cx, cy, rx * 0.95, ry * 0.95, skin);
    if (id === 'mouth_shock') {
      ellipse(cx, cy, rx * 0.36, ry * 0.8, ink);
      ellipse(cx, cy + ry * 0.4, rx * 0.18, ry * 0.2, [200, 80, 90]);
    } else if (id === 'mouth_grin') {
      ellipse(cx, cy, rx * 0.8, ry * 0.65, ink);
      ellipse(cx, cy - ry * 0.15, rx * 0.64, ry * 0.28, white);
    } else {
      const sign = id === 'mouth_frown' ? -1 : 1;
      line(
        Array.from({ length: 13 }, (_, i) => {
          const x = (i / 12) * 2 - 1;
          return [cx + x * rx * 0.7, cy + sign * (1 - x * x) * ry * 0.5];
        }).flat(),
        3,
        ink,
      );
    }
  }
  // Requests/checks require exact unchanged pixels outside the editable core, including alpha.
  for (let i = 0; i < editable.data.length; i++)
    if (editable.data[i] < 0.999) out.data.set(source.data.subarray(i * 4, i * 4 + 4), i * 4);
  return out;
}
