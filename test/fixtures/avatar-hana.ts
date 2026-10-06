/**
 * The repository's test illustration for the avatar builder: Rev2D's own `hana` example rendered
 * with the software renderer on a transparent background, and a COMPLETE avatar spec derived from
 * hana's geometry (the rest pose of the rig, part bounds, flattened eye-white / brow / mouth / hair
 * paths). No third-party art: everything here comes from examples/hana/hana.r2d.json.
 *
 *   const { image, doc } = hanaIllustration(0.5);   // 256 x 320; scale 1 = 512 x 640, 2 = 1024 x 1280
 *   const { spec } = parseAvatarSpec(doc);           // no errors, no warnings
 *
 * The landmarks are placed the way the spec asks an agent to place them (opening inside the lashes
 * starting at the outer corner, region around lashes and lids, face oval on the skin, head ellipse
 * around all hair, strands from root to tip on hair, ...). Every optional group is present: irises,
 * brows, cheeks, ears, seven bangs + two side locks + two back strands, shoulders, and one attachment
 * of each kind (cut-out "flower" on the head, jiggle "bow" and pendulum "ribbon" on the body). Look at them with
 * avatarOverlay(image, doc) when hana changes. Results are cached per scale.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { flattenPath } from '../../src/core/geometry/index.js';
import { Rig, buildRenderList } from '../../src/core/rig.js';
import type { ImageRGBA, Model, Pose } from '../../src/core/types.js';
import { parseModelText } from '../../src/core/validate.js';
import { polygonEnvelope, resamplePolyline } from '../../src/avatar/image/polygon.js';
import { renderImage } from '../../src/render/index.js';

export interface HanaIllustration {
  /** The rendered bust, straight-alpha RGBA on a transparent background. */
  image: ImageRGBA;
  /** A raw avatar spec document (what avatar.json holds), complete and valid for `image`. */
  doc: Record<string, any>;
  scale: number;
  width: number;
  height: number;
}

type Pt = [number, number];
/** [x0, y0, x1, y1] */
type Box = [number, number, number, number];

const HANA_FILE = fileURLToPath(new URL('../../examples/hana/hana.r2d.json', import.meta.url));

let loaded: { model: Model; rig: Rig; pose: Pose } | null = null;

function hana(): { model: Model; rig: Rig; pose: Pose } {
  if (!loaded) {
    const { model, diagnostics } = parseModelText(readFileSync(HANA_FILE, 'utf8'));
    if (!model) throw new Error(`examples/hana does not validate: ${diagnostics.map((d) => d.message).join('; ')}`);
    const rig = new Rig(model);
    loaded = { model, rig, pose: rig.pose({ physics: false }) };
  }
  return loaded;
}

// ----------------------------------------------------------------------------- geometry of hana's parts

function boxOf(points: ArrayLike<number>, into?: Box): Box {
  const b: Box = into ? [...into] : [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < points.length; i += 2) {
    b[0] = Math.min(b[0], points[i]);
    b[1] = Math.min(b[1], points[i + 1]);
    b[2] = Math.max(b[2], points[i]);
    b[3] = Math.max(b[3], points[i + 1]);
  }
  return b;
}

/** The flattened outlines (one per subpath) of a path part, in canvas pixels of the rest pose. */
function outlines(id: string, d?: string): number[][] {
  const part = hana().model.parts.find((p) => p.id === id);
  if (!part || part.shape.type !== 'path') throw new Error(`hana has no path part "${id}"`);
  return flattenPath(d ?? part.shape.d, 0.2).map((s) => Array.from(s.points));
}

/** Rest-pose bounds [x0, y0, x1, y1] of parts (fill and stroke). */
function partsBox(...ids: string[]): Box {
  let box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const id of ids) {
    const b = hana().pose.parts[id]?.bounds;
    if (!b) throw new Error(`hana has no visible part "${id}"`);
    box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[0] + b[2]), Math.max(box[3], b[1] + b[3])];
  }
  return box;
}

/** Every rest-pose fill vertex of parts, flat. */
function partsPoints(...ids: string[]): number[] {
  const out: number[] = [];
  for (const id of ids) {
    const pose = hana().pose.parts[id];
    if (!pose) throw new Error(`hana has no part "${id}"`);
    for (const batch of [pose.fill, pose.stroke]) if (batch) for (const v of batch) out.push(v);
  }
  return out;
}

/** Convex hull (Andrew's monotone chain), clockwise on screen, flat. */
function convexHull(points: ArrayLike<number>): number[] {
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) pts.push([points[i], points[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Pt[]) => {
    const h: Pt[] = [];
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  return [...half(pts), ...half([...pts].reverse())].flat();
}

/** The convex hull of `points` grown by `margin` px, as a polygon of `count` points. */
function hullAround(points: ArrayLike<number>, margin: number, count: number): number[] {
  const grown: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      grown.push(points[i] + Math.cos(a) * margin, points[i + 1] + Math.sin(a) * margin);
    }
  }
  return resamplePolyline(convexHull(grown), count, true);
}

/** Leftmost and rightmost x of a closed outline on the row y (null when the row misses it). */
function rowSpan(outline: ArrayLike<number>, y: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const n = outline.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const y0 = outline[i * 2 + 1];
    const y1 = outline[j * 2 + 1];
    if ((y0 - y) * (y1 - y) > 0 || y0 === y1) continue;
    const x = outline[i * 2] + ((y - y0) / (y1 - y0)) * (outline[j * 2] - outline[i * 2]);
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Topmost y of a closed outline in the column x (Infinity when the column misses it). */
function columnTop(outline: ArrayLike<number>, x: number): number {
  let top = Infinity;
  const n = outline.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = outline[i * 2];
    const x1 = outline[j * 2];
    if ((x0 - x) * (x1 - x) > 0 || x0 === x1) continue;
    top = Math.min(top, outline[i * 2 + 1] + ((x - x0) / (x1 - x0)) * (outline[j * 2 + 1] - outline[i * 2 + 1]));
  }
  return top;
}

/** Downward tips of a closed outline: vertices lower than everything within `window` px along it, below `minY`. */
function lowerTips(outline: number[], minY: number, window: number): Pt[] {
  const n = outline.length / 2;
  const tips: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const y = outline[i * 2 + 1];
    if (y < minY) continue;
    let isTip = true;
    for (const dir of [1, -1]) {
      let walked = 0;
      for (let k = 1; k < n && walked < window && isTip; k++) {
        const a = (i + dir * (k - 1) + n * k) % n;
        const b = (i + dir * k + n * k) % n;
        walked += Math.hypot(outline[b * 2] - outline[a * 2], outline[b * 2 + 1] - outline[a * 2 + 1]);
        // Ties go to the first vertex in walking order, so a flat tip is reported once.
        if (outline[b * 2 + 1] > y || (outline[b * 2 + 1] === y && dir === -1)) isTip = false;
      }
    }
    if (isTip) tips.push([outline[i * 2], y]);
  }
  return tips.sort((a, b) => a[0] - b[0]);
}

// ----------------------------------------------------------------------------- the spec

/** The landmarks in hana's own units (512 x 640); hanaIllustration scales them. */
function hanaLandmarks(): Record<string, any> {
  const { model } = hana();
  const W = model.meta.width;
  const H = model.meta.height;
  const cx = W / 2;

  // Eyes. hana's R parts are the character's right eye = the eye on the image LEFT.
  const eye = (side: 'R' | 'L') => {
    const white = outlines(`eyeWhite${side}`)[0];
    // The eye-white path starts at the outer corner and runs over the upper lid first.
    const opening = resamplePolyline(white, 18, true);
    const region = hullAround(partsPoints(`eyeWhite${side}`, `lash${side}`, `lowerLid${side}`), 4.5, 16);
    const iris = model.parts.find((p) => p.id === `iris${side}`)!.shape as { cx: number; cy: number; rx: number; ry: number };
    return { opening, region, iris: { center: [iris.cx, iris.cy], radius: (iris.rx + iris.ry) / 2 } };
  };
  const eyes = { imageLeft: eye('R'), imageRight: eye('L') };
  const eyeY = (eyes.imageLeft.iris.center[1] + eyes.imageRight.iris.center[1]) / 2;

  const brow = (id: string) => {
    const env = polygonEnvelope(outlines(id)[0], 6);
    // The middle line of the thin brow shape, without its pointed ends.
    return [1, 2, 3, 4].flatMap((k) => [env.x[k], (env.upper[k] + env.lower[k]) / 2]);
  };

  const noseBox = partsBox('nose');
  const nose: Pt = [(noseBox[0] + noseBox[2]) / 2, noseBox[1] + (noseBox[3] - noseBox[1]) * 0.75];

  // Mouth: the closed line of the setup shape; the area covers every keyform of the mouth binding.
  const closed = outlines('mouth')[0];
  const mouthBox = boxOf(closed);
  const corner = (x: number): Pt => {
    let best = 0;
    for (let i = 0; i < closed.length; i += 2) if (Math.abs(closed[i] - x) < Math.abs(closed[best] - x)) best = i;
    return [closed[best], closed[best + 1]];
  };
  const left = corner(mouthBox[0]);
  const right = corner(mouthBox[2]);
  const bow = (mouthBox[1] + mouthBox[3]) / 2 - (left[1] + right[1]) / 2;
  let mouthAll = mouthBox;
  for (const b of model.bindings) {
    if (b.target !== 'part:mouth.shape.d') continue;
    for (const k of b.keys) if (typeof k.value === 'string') mouthAll = boxOf(outlines('mouth', k.value)[0], mouthAll);
  }
  const faceBox = partsBox('face');
  const chin: Pt = [(faceBox[0] + faceBox[2]) / 2, faceBox[3] - 0.75];
  const areaCy = (mouthAll[1] + mouthAll[3]) / 2;
  const area = {
    center: [(mouthAll[0] + mouthAll[2]) / 2, areaCy],
    // A little larger than the widest / most open keyform, but clear of the nose and the chin.
    radius: [(mouthAll[2] - mouthAll[0]) / 2 + 6, Math.min((mouthAll[3] - mouthAll[1]) / 2 + 4, chin[1] - 3 - areaCy, areaCy - (noseBox[3] + 3))],
    rotation: 0,
  };

  // Face oval: the skin between the hairline and the chin, cheek to cheek.
  const faceCy = eyeY + 0.3 * (nose[1] - eyeY);
  const face = { center: [chin[0], faceCy], radius: [(faceBox[2] - faceBox[0]) / 2 - 1, chin[1] - faceCy] };

  const blush = (id: string): Pt => {
    const b = partsBox(id);
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  };
  const ears = outlines('ears')
    .map((o) => boxOf(o))
    .map((b): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])
    .sort((a, b) => a[0] - b[0]);

  // Head: the ellipse around the head and ALL hair, the neck pivot and the neck band.
  const hairIds = ['hairBack', 'hairFront', 'hairSideR', 'hairSideL'];
  const hairPoints = partsPoints(...hairIds, 'face', 'ears');
  const hairBox = boxOf(hairPoints);
  const headCenter: Pt = [cx, (hairBox[1] + hairBox[3]) / 2];
  let grow = 1;
  for (let i = 0; i + 1 < hairPoints.length; i += 2) {
    const u = (hairPoints[i] - headCenter[0]) / ((hairBox[2] - hairBox[0]) / 2);
    const v = (hairPoints[i + 1] - headCenter[1]) / ((hairBox[3] - hairBox[1]) / 2);
    grow = Math.max(grow, Math.sqrt(u * u + v * v));
  }
  grow += 0.02;
  const neckBox = partsBox('neck');
  const head = {
    center: headCenter,
    radius: [((hairBox[2] - hairBox[0]) / 2) * grow, ((hairBox[3] - hairBox[1]) / 2) * grow],
    pivot: [cx, chin[1] + 0.45 * (neckBox[3] - chin[1])],
    neck: [chin[1] + 3, neckBox[3]],
  };

  // Hair strands: one per bang (root on the skull, tip just inside the tip of the lock), the two
  // side locks along their middle line, and the back hair beside the neck.
  const front = outlines('hairFront')[0];
  const frontBox = boxOf(front);
  const tips = lowerTips(front, frontBox[1] + (frontBox[3] - frontBox[1]) * 0.75, 14);
  const strands: Array<Record<string, any>> = tips.map(([tx, ty], i) => {
    const rootX = cx + (tx - cx) * 0.72;
    const rootY = columnTop(front, rootX) + 16;
    return {
      id: `bang${i + 1}`,
      nodes: [rootX, rootY, rootX + (tx - rootX) * 0.6, rootY + (ty - rootY) * 0.5, tx + (cx - tx) * 0.03, ty - 7],
      width: 26,
      swing: 5,
      stiffness: 1 + ((i % 3) - 1) * 0.06,
      group: 'front',
    };
  });
  for (const [id, name] of [['hairSideR', 'sideL'], ['hairSideL', 'sideR']] as const) {
    const lock = outlines(id)[0];
    const b = boxOf(lock);
    const nodes: number[] = [];
    let width = 0;
    for (const t of [0.1, 0.38, 0.66, 0.9]) {
      const y = b[1] + (b[3] - b[1]) * t;
      const span = rowSpan(lock, y)!;
      nodes.push((span[0] + span[1]) / 2, y);
      width = Math.max(width, span[1] - span[0]);
    }
    strands.push({ id: name, nodes, width: width + 4, swing: 9, stiffness: 0.6, group: 'side' });
  }
  const back = outlines('hairBack')[0];
  const backBox = boxOf(back);
  for (const [name, sign] of [['backL', -1], ['backR', 1]] as const) {
    const nodes: number[] = [];
    for (const t of [0.55, 0.72, 0.9]) {
      const y = backBox[1] + (backBox[3] - backBox[1]) * t;
      const span = rowSpan(back, y)!;
      nodes.push(sign < 0 ? span[0] + 20 : span[1] - 20, y);
    }
    strands.push({ id: name, nodes, width: 44, swing: 8, stiffness: 0.5, group: 'back' });
  }

  // Attachments, one of each kind: the flower hairpin lies in front of the hair (a cut-out on the
  // head), the bow on the collar is a springy mass (a jiggle, not cut), and the ribbon tails hang
  // from the knot (a pendulum on the body).
  const tails = partsBox('ribbonTails');
  const knot = partsBox('ribbonKnot');
  const loops = partsBox('ribbonLoops', 'ribbonKnot');
  const attachments = [
    { id: 'flower', kind: 'cutout', outline: hullAround(partsPoints('flowerPetals', 'flowerCenter'), 2, 12), follow: 'head' },
    { id: 'bow', kind: 'jiggle', center: [(loops[0] + loops[2]) / 2, (loops[1] + loops[3]) / 2], radius: [(loops[2] - loops[0]) / 2 + 2, (loops[3] - loops[1]) / 2 + 2], swing: 2, follow: 'body' },
    {
      id: 'ribbon',
      kind: 'pendulum',
      outline: hullAround(partsPoints('ribbonTails'), 2.5, 12),
      pivot: [(knot[0] + knot[2]) / 2, (knot[1] + knot[3]) / 2 + 2],
      tip: [(tails[0] + tails[2]) / 2, tails[3] - 4],
      swing: 6,
      follow: 'body',
    },
  ];

  // Body: sway about a pivot below the image, the chest under the collar, the shoulder tops.
  const blouse = partsBox('blouse');
  const bodyTop = blouse[1];
  const body = {
    pivot: [cx, H * 1.3],
    fade: [bodyTop + (H - bodyTop) * 0.45, H],
    sway: 2,
    chest: { center: [cx, bodyTop + (H - bodyTop) * 0.4], radius: [(blouse[2] - blouse[0]) * 0.3, (H - bodyTop) * 0.28] },
    shoulders: [
      [blouse[0] + (blouse[2] - blouse[0]) * 0.15, bodyTop + 44],
      [blouse[2] - (blouse[2] - blouse[0]) * 0.15, bodyTop + 44],
    ],
  };

  return {
    head,
    face: {
      ...face,
      eyes,
      brows: { imageLeft: brow('browR'), imageRight: brow('browL') },
      nose,
      mouth: { imageLeft: left, imageRight: right, bow, area },
      chin,
      cheeks: { imageLeft: blush('blushR'), imageRight: blush('blushL'), radius: 20 },
      ears: { imageLeft: ears[0], imageRight: ears[1] },
    },
    hair: { strands },
    attachments,
    body,
  };
}

/** Multiply every coordinate and length by `k`; ids, kinds, angles and factors stay. */
function scaleLandmarks(value: any, k: number, key = '', unscaled: readonly string[] = ['rotation', 'sway', 'stiffness', 'tilt']): any {
  if (typeof value === 'number') return unscaled.includes(key) ? value : Math.round(value * k * 100) / 100;
  if (Array.isArray(value)) return value.map((v) => scaleLandmarks(v, k, key, unscaled));
  if (value !== null && typeof value === 'object') {
    // A pendulum's swing is an angle; a strand's and a jiggle's are pixels.
    const keep = value.kind === 'pendulum' ? [...unscaled, 'swing'] : unscaled;
    return Object.fromEntries(Object.entries(value).map(([name, v]) => [name, scaleLandmarks(v, k, name, keep)]));
  }
  return value;
}

const cache = new Map<number, HanaIllustration>();

/**
 * hana as an illustration at `scale` output pixels per model pixel (512 x 640 at scale 1; the sizes
 * must come out whole), with the avatar spec for exactly that image. The caller must not modify
 * the returned image; `doc` is a fresh copy on every call.
 */
export function hanaIllustration(scale = 1): HanaIllustration {
  let hit = cache.get(scale);
  if (!hit) {
    const { model, rig, pose } = hana();
    const width = model.meta.width * scale;
    const height = model.meta.height * scale;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1) throw new RangeError(`hanaIllustration: scale ${scale} does not give a whole image size`);
    const image = renderImage(buildRenderList(rig, pose, { background: 'transparent' }), {}, { scale, supersample: 3 });
    const doc = {
      format: 'rev2d-avatar',
      version: 1,
      name: 'hana',
      image: { file: 'source.png', width, height },
      ...scaleLandmarks(hanaLandmarks(), scale),
      notes: ['Derived from examples/hana (test/fixtures/avatar-hana.ts): a render of the rest pose and landmarks from its geometry.'],
    };
    hit = { image, doc, scale, width, height };
    cache.set(scale, hit);
  }
  return { ...hit, doc: structuredClone(hit.doc) };
}
