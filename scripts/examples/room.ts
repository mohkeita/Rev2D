/** Original vector room for library/scene tests; no third-party artwork. */
import type { Doc } from './common.js';
export function buildRoom(): Doc {
  const shapes = [
    ['wall', 0, 0, 960, 540, '#f4e7d5'],
    ['floor', 0, 390, 960, 150, '#bd916c'],
    ['window_frame', 650, 40, 240, 260, '#fffaf0'],
    ['window', 660, 50, 220, 240, '#b7dded'],
    ['sofa_back', 70, 230, 410, 150, '#7a9a76'],
    ['sofa_seat', 55, 330, 440, 85, '#91ac86'],
    ['sofa_legR', 85, 415, 25, 40, '#65513d'],
    ['sofa_legL', 430, 415, 25, 40, '#65513d'],
    ['table_top', 300, 420, 370, 25, '#a16f48'],
    ['table_legR', 325, 445, 20, 70, '#a16f48'],
    ['table_legL', 625, 445, 20, 70, '#a16f48'],
  ] as const;
  return {
    format: 'rev2d',
    version: 1,
    meta: { name: 'room', width: 960, height: 540 },
    parts: shapes.map(([id, x, y, w, h, fill], z) => ({
      id,
      z,
      shape: { type: 'rect', x, y, w, h, radius: 3 },
      fill,
      stroke: { color: '#293442', width: 3 },
    })),
  };
}
