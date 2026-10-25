/** Deterministic border-connected Lab keying. No model, IO or network dependency. */
import type { Diagnostic, ImageRGBA } from '../core/types.js';
import { rgbToLab, labToRgb, deltaE } from '../avatar/image/color.js';
import type { Lab } from '../avatar/image/types.js';
import { assertImage, cloneImage, cropImage } from '../render/browser.js';
import { LibraryError, libraryDiagnostic } from './schema.js';

export interface KeyOptions {
  key?: string;
  tolerance?: number;
  trim?: boolean;
  padding?: number;
  minIsland?: number;
}
export interface KeyResult {
  image: ImageRGBA;
  offset: [number, number];
  background: [number, number, number] | null;
  diagnostics: Diagnostic[];
  removedPixels: number;
}
const median = (a: number[]) => {
  a.sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

export function keyImage(source: ImageRGBA, options: KeyOptions = {}): KeyResult {
  assertImage(source, 'keyImage');
  if (!source.width || !source.height)
    throw new LibraryError([
      libraryDiagnostic('library-key-empty', '/image', 'image is empty', 'provide an image with a visible subject'),
    ]);
  const tolerance = options.tolerance ?? 18,
    padding = options.padding ?? 8,
    minIsland = options.minIsland ?? 8;
  if (
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    tolerance > 100 ||
    !Number.isInteger(padding) ||
    padding < 0 ||
    padding > 4096 ||
    !Number.isInteger(minIsland) ||
    minIsland < 0
  )
    throw new LibraryError([
      libraryDiagnostic(
        'library-key-options',
        '/key',
        'invalid key options',
        'use tolerance in (0,100], integer padding in [0,4096], and a non-negative minIsland',
      ),
    ]);
  const w = source.width,
    h = source.height,
    n = w * h,
    image = cloneImage(source),
    diagnostics: Diagnostic[] = [];
  const border: number[] = [];
  for (let x = 0; x < w; x++) {
    border.push(x);
    if (h > 1) border.push((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    border.push(y * w);
    if (w > 1) border.push(y * w + w - 1);
  }
  const transparent = border.filter((i) => source.data[i * 4 + 3] < 5).length / border.length > 0.8;
  let background: KeyResult['background'] = null,
    removedPixels = 0;
  if (!transparent) {
    const opaque = border.filter((i) => source.data[i * 4 + 3] > 250);
    if (!opaque.length)
      throw new LibraryError([
        libraryDiagnostic(
          'library-key-background-noisy',
          '/image',
          'cannot estimate an opaque uniform background',
          'use a transparent PNG or regenerate on a flat #00FF00 background',
        ),
      ]);
    const labs = opaque.map((i) =>
      rgbToLab(...([source.data[i * 4], source.data[i * 4 + 1], source.data[i * 4 + 2]] as [number, number, number])),
    );
    const estimated: Lab = [0, 1, 2].map((c) => median(labs.map((v) => v[c]))) as Lab;
    let keyLab = estimated;
    if (options.key && options.key !== 'auto') {
      const value = options.key === 'white' ? '#ffffff' : options.key;
      if (!/^#[a-fA-F0-9]{6}$/.test(value))
        throw new LibraryError([
          libraryDiagnostic(
            'library-key-color',
            '/key',
            `invalid key colour "${options.key}"`,
            'use auto, white or #RRGGBB',
          ),
        ]);
      background = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
      keyLab = rgbToLab(...background);
    } else background = labToRgb(...keyLab).map(Math.round) as [number, number, number];
    if (labs.filter((v) => deltaE(v, keyLab) <= tolerance).length / labs.length < 0.75)
      throw new LibraryError([
        libraryDiagnostic(
          'library-key-background-noisy',
          '/image',
          'the image border is not a uniform key background',
          'regenerate on a flat colour without shadows, or use a transparent PNG / external remover',
        ),
      ]);
    const distances = new Float32Array(n),
      seen = new Uint8Array(n),
      queue = new Int32Array(n);
    let head = 0,
      tail = 0;
    for (let i = 0; i < n; i++)
      distances[i] = deltaE(rgbToLab(source.data[i * 4], source.data[i * 4 + 1], source.data[i * 4 + 2]), keyLab);
    const push = (i: number) => {
      if (!seen[i] && (source.data[i * 4 + 3] === 0 || distances[i] <= tolerance)) {
        seen[i] = 1;
        queue[tail++] = i;
      }
    };
    for (const i of border) push(i);
    while (head < tail) {
      const i = queue[head++],
        x = i % w;
      if (x) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < n - w) push(i + w);
    }
    const green = background[1] > background[0] + 50 && background[1] > background[2] + 50;
    // Enclosed saturated key regions can be removed. White regions are ambiguous (e.g. a white face).
    let enclosed = 0;
    if (green)
      for (let i = 0; i < n; i++)
        if (!seen[i] && distances[i] < Math.min(3, tolerance / 4)) {
          seen[i] = 1;
          enclosed++;
        }
    if (enclosed)
      diagnostics.push(
        libraryDiagnostic(
          'library-key-fill-color-clash',
          '/image',
          `${enclosed} enclosed key-colour pixels removed; same-colour clothing is ambiguous`,
          'review the silhouette; regenerate using a background colour absent from the subject',
          'warning',
        ),
      );
    for (let i = 0; i < n; i++) {
      const b = i * 4;
      if (seen[i]) {
        image.data[b + 3] = 0;
        image.data[b] = image.data[b + 1] = image.data[b + 2] = 0;
        removedPixels++;
        continue;
      }
      const x = i % w,
        y = Math.floor(i / w);
      let edge = false;
      for (let dy = -2; dy <= 2 && !edge; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h && seen[yy * w + xx]) {
            edge = true;
            break;
          }
        }
      if (!edge) continue;
      // Against a dark outline, solve C = a F + (1-a) B, retaining the original subpixel alpha.
      let darkest = -1,
        dark = Infinity;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const j = yy * w + xx,
            k = j * 4;
          const light = source.data[k] + source.data[k + 1] + source.data[k + 2];
          if (!seen[j] && light < dark) {
            dark = light;
            darkest = k;
          }
        }
      if (darkest >= 0 && dark < 300) {
        let channel = 0;
        for (let c = 1; c < 3; c++)
          if (
            Math.abs(background[c] - source.data[darkest + c]) >
            Math.abs(background[channel] - source.data[darkest + channel])
          )
            channel = c;
        const denom = source.data[darkest + channel] - background[channel];
        const a = denom ? Math.max(0, Math.min(1, (source.data[b + channel] - background[channel]) / denom)) : 1;
        if (a > 0 && a < 0.999) {
          image.data[b + 3] = Math.round(source.data[b + 3] * a);
          for (let c = 0; c < 3; c++) image.data[b + c] = (source.data[b + c] - (1 - a) * background[c]) / a;
        }
      }
      if (green) image.data[b + 1] = Math.min(image.data[b + 1], Math.max(image.data[b], image.data[b + 2]));
    }
  }
  // Remove tiny disconnected foreground islands, never change the input array.
  const visited = new Uint8Array(n),
    queue = new Int32Array(n);
  for (let start = 0; start < n; start++)
    if (!visited[start] && image.data[start * 4 + 3] > 0) {
      let head = 0,
        tail = 1;
      queue[0] = start;
      visited[start] = 1;
      while (head < tail) {
        const i = queue[head++],
          x = i % w;
        for (const j of [x ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1])
          if (j >= 0 && !visited[j] && image.data[j * 4 + 3] > 0) {
            visited[j] = 1;
            queue[tail++] = j;
          }
      }
      if (tail < minIsland) for (let k = 0; k < tail; k++) image.data[queue[k] * 4 + 3] = 0;
    }
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let i = 0; i < n; i++)
    if (image.data[i * 4 + 3] > 0) {
      const x = i % w,
        y = Math.floor(i / w);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  if (x1 < 0)
    throw new LibraryError([
      libraryDiagnostic(
        'library-key-empty',
        '/image',
        'no visible subject remains after keying',
        'choose a different key colour or use a transparent PNG',
      ),
    ]);
  if (x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1)
    diagnostics.push(
      libraryDiagnostic(
        'library-key-subject-touches-border',
        '/image',
        'the subject touches the source border and may be cut off',
        'regenerate with a clear margin around hands, hair and feet',
        'warning',
      ),
    );
  // Count small enclosed transparent components as suspicious holes; large keyed arm gaps are legitimate.
  const transparentSeen = new Uint8Array(n);
  let holes = 0;
  for (let start = 0; start < n; start++)
    if (!transparentSeen[start] && image.data[start * 4 + 3] === 0) {
      let head = 0,
        tail = 1,
        touches = false;
      queue[0] = start;
      transparentSeen[start] = 1;
      while (head < tail) {
        const i = queue[head++],
          x = i % w;
        if (x === 0 || x === w - 1 || i < w || i >= n - w) touches = true;
        for (const j of [x ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1])
          if (j >= 0 && !transparentSeen[j] && image.data[j * 4 + 3] === 0) {
            transparentSeen[j] = 1;
            queue[tail++] = j;
          }
      }
      if (!touches && tail <= 16) holes++;
    }
  if (holes)
    diagnostics.push(
      libraryDiagnostic(
        'library-key-holes',
        '/image',
        `${holes} small enclosed transparent regions need review`,
        'inspect for holes inside clothing or the face; change the key colour if necessary',
        'warning',
      ),
    );
  if (options.trim === false) return { image, offset: [0, 0], background, diagnostics, removedPixels };
  x0 = Math.max(0, x0 - padding);
  y0 = Math.max(0, y0 - padding);
  x1 = Math.min(w - 1, x1 + padding);
  y1 = Math.min(h - 1, y1 + padding);
  return {
    image: cropImage(image, x0, y0, x1 - x0 + 1, y1 - y0 + 1),
    offset: [x0, y0],
    background,
    diagnostics,
    removedPixels,
  };
}
