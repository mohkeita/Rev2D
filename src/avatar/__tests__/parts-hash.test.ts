/**
 * describeAvatarParts / avatarLandmarks (the editable geometry of a raw spec document) and
 * layerInputsHash (what makes the layer images stale).
 */
import { describe, expect, it } from 'vitest';
import { parseColor } from '../../core/color.js';
import { formatModelJson } from '../../core/format.js';
import { canonicalJson, fnv1a64, layerInputs, layerInputsHash } from '../hash.js';
import { AVATAR_PART_GROUPS, avatarLandmarks, describeAvatarParts, pointerSegments, resolvePointer, resolveShape, setPointer, toSpecPointer } from '../parts.js';
import { draftAvatarSpec, parseAvatarSpec } from '../spec.js';
import type { AvatarSpec, HandleShape } from '../types.js';
import { validDoc, type Json } from './fixtures.js';

function pointersOf(shape: HandleShape): string[] {
  switch (shape.type) {
    case 'point':
      return [shape.at];
    case 'ellipse':
      return [shape.center, shape.radius, ...(shape.rotation ? [shape.rotation] : [])];
    case 'polygon':
    case 'polyline':
      return [shape.points];
    case 'band':
      return [shape.range];
    case 'segment':
      return [shape.a, shape.b];
  }
}

function spec(doc: Json = validDoc()): AvatarSpec {
  const r = parseAvatarSpec(doc);
  if (!r.spec) throw new Error(r.diagnostics.map((d) => `${d.path} ${d.message}`).join('\n'));
  return r.spec;
}

describe('describeAvatarParts', () => {
  const groups = describeAvatarParts(validDoc());

  it('lists the ten groups in editor order with their categories', () => {
    expect(groups.map((g) => [g.id, g.category])).toEqual([
      ['head', 'face'],
      ['eyes', 'face'],
      ['mouth', 'face'],
      ['face', 'face'],
      ['cheeks', 'face'],
      ['strands', 'hair'],
      ['attachments', 'body'],
      ['arms','body'],['legs','body'],
      ['body', 'body'],
    ]);
    for (const g of groups) {
      expect(g.label.length).toBeGreaterThan(2);
      expect(g.description.length).toBeGreaterThan(10);
      expect(g.present).toBe(!['arms','legs'].includes(g.id));
    }
  });

  it('gives every group its own colour, distinct in hue and brightness', () => {
    const colors = groups.map((g) => parseColor(g.color)!);
    expect(new Set(groups.map((g) => g.color)).size).toBe(10);
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const d = Math.hypot(colors[i][0] - colors[j][0], colors[i][1] - colors[j][1], colors[i][2] - colors[j][2]);
        expect(d, `${groups[i].id} vs ${groups[j].id}`).toBeGreaterThan(0.25);
      }
    }
    expect(AVATAR_PART_GROUPS.map((g) => g.color)).toEqual(groups.map((g) => g.color));
  });

  it('lists the items with unique ids, labels, tips and handle shapes', () => {
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'head.ellipse',
      'head.pivot',
      'head.neck',
      'eyes.imageLeft.opening',
      'eyes.imageLeft.region',
      'eyes.imageLeft.iris',
      'eyes.imageRight.opening',
      'eyes.imageRight.region',
      'eyes.imageRight.iris',
      'mouth.corners',
      'mouth.area',
      'face.oval',
      'face.nose',
      'face.chin',
      'face.brows.imageLeft',
      'face.brows.imageRight',
      'face.ears.imageLeft',
      'face.ears.imageRight',
      'cheeks.imageLeft',
      'cheeks.imageRight',
      'strand.bangL',
      'strand.sideR',
      'attachment.tassel.outline',
      'attachment.tassel.swing',
      'attachment.bun.ellipse',
      'attachment.hand.outline',
      'attachment.hand.contact',
      'body.pivot',
      'body.fade',
      'body.chest',
      'body.shoulders.imageLeft',
      'body.shoulders.imageRight',
    ]);
    for (const item of groups.flatMap((g) => g.items)) {
      expect(item.label.length, item.id).toBeGreaterThan(2);
      expect(item.tip!.length, item.id).toBeGreaterThan(15);
    }
  });

  it('addresses the raw document: every pointer of a placed item resolves', () => {
    const doc = validDoc();
    for (const item of groups.flatMap((g) => g.items)) {
      if (!item.placed) {
        // The only optional landmark the fixture leaves out.
        expect(item.id).toBe('eyes.imageRight.iris');
        expect(item.required).toBe(false);
        continue;
      }
      for (const p of pointersOf(item.shape)) expect(resolvePointer(doc, p), `${item.id} ${p}`).toBeDefined();
      expect(resolveShape(doc, item.shape)).not.toBeNull();
    }
    const shape = (id: string) => groups.flatMap((g) => g.items).find((i) => i.id === id)!.shape;
    expect(shape('eyes.imageLeft.opening')).toEqual({ type: 'polygon', points: '/face/eyes/imageLeft/opening' });
    expect(shape('strand.sideR')).toEqual({ type: 'polyline', points: '/hair/strands/1/nodes' });
    expect(shape('mouth.corners')).toEqual({ type: 'segment', a: '/face/mouth/imageLeft', b: '/face/mouth/imageRight' });
    expect(shape('mouth.area')).toEqual({ type: 'ellipse', center: '/face/mouth/area/center', radius: '/face/mouth/area/radius', rotation: '/face/mouth/area/rotation' });
    expect(shape('head.neck')).toEqual({ type: 'band', range: '/head/neck' });
    expect(shape('attachment.tassel.swing')).toEqual({ type: 'segment', a: '/attachments/0/pivot', b: '/attachments/0/tip' });
    expect(shape('body.shoulders.imageRight')).toEqual({ type: 'point', at: '/body/shoulders/1' });
    // The iris is a circle: its radius pointer addresses a single number.
    expect(resolveShape(doc, shape('eyes.imageLeft.iris'))).toEqual({ type: 'ellipse', center: [165, 195], radius: [8, 8], rotation: 0 });
    expect(resolveShape(doc, shape('mouth.area'))).toMatchObject({ rotation: 0, radius: [24, 14] });
  });

  it('marks what requires rebuilding the layer images', () => {
    const cuts = groups.flatMap((g) => g.items.filter((i) => i.cutsLayers).map((i) => i.id));
    expect(cuts).toEqual([
      'head.ellipse',
      'eyes.imageLeft.opening',
      'eyes.imageLeft.region',
      'eyes.imageRight.opening',
      'eyes.imageRight.region',
      'mouth.area',
      'strand.bangL',
      'strand.sideR',
      'attachment.tassel.outline',
      'attachment.hand.outline',
    ]);
  });

  it('works on a draft: required groups present, nothing placed, optional groups absent', () => {
    const draft = describeAvatarParts(draftAvatarSpec('x', 100, 100));
    expect(draft.filter((g) => !g.present).map((g) => g.id)).toEqual(['cheeks', 'strands', 'attachments','arms','legs']);
    expect(draft.flatMap((g) => g.items).every((i) => !i.placed)).toBe(true);
    expect(draft.find((g) => g.id === 'cheeks')!.items.map((i) => i.id)).toEqual(['cheeks.imageLeft', 'cheeks.imageRight']);
    expect(draft.find((g) => g.id === 'strands')!.items).toEqual([]);
    expect(draft.flatMap((g) => g.items).filter((i) => i.required).map((i) => i.id)).toEqual([
      'head.ellipse',
      'head.pivot',
      'head.neck',
      'eyes.imageLeft.opening',
      'eyes.imageLeft.region',
      'eyes.imageRight.opening',
      'eyes.imageRight.region',
      'mouth.corners',
      'mouth.area',
      'face.oval',
      'face.nose',
      'face.chin',
      'body.pivot',
      'body.fade',
      'body.chest',
    ]);
  });

  it('never throws on malformed documents', () => {
    for (const doc of [null, 7, 'x', [], {}, { head: 3, face: [], hair: { strands: 'no' }, attachments: {} }]) {
      const g = describeAvatarParts(doc);
      expect(g).toHaveLength(10);
      expect(g.flatMap((x) => x.items).some((i) => i.placed)).toBe(false);
    }
    const odd = describeAvatarParts({
      hair: { strands: [{ nodes: [1, 2, 3] }, 5, { id: 'a', nodes: [1, 2, 3, 4] }, { id: 'a', nodes: [] }] },
      attachments: [{ kind: 'pendulum' }, { kind: 'mystery', id: 'm' }, { id: 'j', kind: 'jiggle', center: [1, 2], radius: [3, 0] }],
    });
    // Entries without a usable id are named by their index; duplicate ids stay unique.
    expect(odd.find((g) => g.id === 'strands')!.items.map((i) => [i.id, i.placed])).toEqual([
      ['strand.#0', true],
      ['strand.a', true],
      ['strand.a#3', false],
    ]);
    expect(odd.find((g) => g.id === 'attachments')!.items.map((i) => [i.id, i.placed])).toEqual([
      ['attachment.#0.outline', false],
      ['attachment.#0.swing', false],
      ['attachment.j.ellipse', false],
    ]);
    expect(resolveShape({ p: [1, 2, 3] }, { type: 'polyline', points: '/p' })).toEqual({ type: 'polyline', points: [1, 2] });
    expect(resolveShape({ p: [1, 'a'] }, { type: 'point', at: '/p' })).toBeNull();
  });
});

describe('avatarLandmarks', () => {
  it('has one entry per value with its pointer, label, form and tip', () => {
    const marks = avatarLandmarks(validDoc());
    const at = (p: string) => marks.find((m) => m.pointer === p)!;
    expect(new Set(marks.map((m) => m.pointer)).size).toBe(marks.length);
    expect(at('/head/center')).toMatchObject({ group: 'head', item: 'head.ellipse', role: 'center', label: 'Head ellipse: centre', form: '[x, y]', required: true, cutsLayers: true });
    expect(at('/head/radius')).toMatchObject({ role: 'radius', form: '[rx, ry]' });
    expect(at('/face/mouth/area/rotation')).toMatchObject({ role: 'rotation', required: false, cutsLayers: true });
    expect(at('/face/eyes/imageLeft/iris/radius')).toMatchObject({ form: 'radius in px', required: false });
    expect(at('/face/mouth/imageRight')).toMatchObject({ item: 'mouth.corners', role: 'b', label: 'Mouth corner (image right)' });
    expect(at('/attachments/0/pivot').label).toBe('Pendulum "tassel": pivot');
    expect(at('/hair/strands/0/nodes')).toMatchObject({ form: '[x0, y0, x1, y1, ...]', group: 'strands' });
    expect(at('/body/fade').form).toBe('[yStart, yEnd]');
  });
});

describe('pointers', () => {
  it('round-trips segments with escapes', () => {
    expect(toSpecPointer(['hair', 'strands', 0, 'nodes'])).toBe('/hair/strands/0/nodes');
    expect(pointerSegments('/a~1b/c~0d/0')).toEqual(['a/b', 'c~d', '0']);
    expect(pointerSegments('')).toEqual([]);
    expect(resolvePointer({ 'a/b': { 'c~d': [7] } }, '/a~1b/c~0d/0')).toBe(7);
    expect(resolvePointer({ a: 1 }, '/a/b/c')).toBeUndefined();
    expect(resolvePointer({ a: 1 }, '/toString')).toBeUndefined();
  });

  it('sets values in place, creating containers and deleting with undefined', () => {
    const doc: Json = { face: {} };
    setPointer(doc, '/face/cheeks/imageLeft', [10, 20]);
    setPointer(doc, '/body/shoulders/0', [1, 2]);
    setPointer(doc, '/body/shoulders/1', [3, 4]);
    expect(doc).toEqual({ face: { cheeks: { imageLeft: [10, 20] } }, body: { shoulders: [[1, 2], [3, 4]] } });
    setPointer(doc, '/face/cheeks', undefined);
    setPointer(doc, '/body/shoulders/0', undefined);
    expect(doc).toEqual({ face: {}, body: { shoulders: [[3, 4]] } });
    expect(() => setPointer({ a: 5 }, '/a/b', 1)).toThrow(/\/a is not an object or array/);
    expect(() => setPointer({}, '', 1)).toThrow(/root/);
  });
});

describe('layerInputsHash', () => {
  it('computes FNV-1a 64 of UTF-8 bytes', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
    // Against a BigInt reference, including multi-byte characters.
    const reference = (text: string) => {
      let h = 0xcbf29ce484222325n;
      for (const b of new TextEncoder().encode(text)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
      return h.toString(16).padStart(16, '0');
    };
    for (const text of ['{"a":[1,2.5,-3]}', 'héllo ✓ 日本語', 'x'.repeat(1000), JSON.stringify(validDoc())]) expect(fnv1a64(text)).toBe(reference(text));
  });

  it('writes canonical JSON: sorted keys, rounded numbers, no undefined', () => {
    expect(canonicalJson({ b: 1.00049, a: [true, null, 'x', -0, 2.0005], c: undefined, d: { z: 1, y: Infinity } })).toBe('{"a":[true,null,"x",0,2.001],"b":1,"d":{"y":null,"z":1}}');
  });

  it('is stable: key order, defaults, formatting to disk and back', () => {
    const hash = layerInputsHash(spec());
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(layerInputsHash(spec())).toBe(hash);
    // The same spec with keys in another order.
    const reordered = validDoc();
    reordered.face = Object.fromEntries(Object.entries(reordered.face).reverse());
    reordered.head = Object.fromEntries(Object.entries(reordered.head).reverse());
    expect(layerInputsHash(spec(reordered))).toBe(hash);
    // Written with the model formatter (numbers rounded to 4 decimals) and read back.
    const noisy = validDoc();
    noisy.face.eyes.imageLeft.opening[0] += 0.00004;
    noisy.head.radius[0] -= 0.00003;
    expect(layerInputsHash(spec(noisy))).toBe(hash);
    expect(layerInputsHash(spec(JSON.parse(formatModelJson(noisy))))).toBe(hash);
  });

  it('pins the hash of the fixture (a change here invalidates every built project)', () => {
    expect(layerInputsHash(spec())).toBe('ced8e0bf787ff066');
  });

  const CHANGES: Array<[string, (d: Json) => void]> = [
    ['image size', (d) => (d.image.height = 501)],
    ['image file', (d) => (d.image.file = 'other.png')],
    ['head ellipse centre', (d) => (d.head.center[0] += 1)],
    ['head ellipse radius', (d) => (d.head.radius[1] += 1)],
    ['eye opening', (d) => (d.face.eyes.imageRight.opening[3] += 0.5)],
    ['eye region', (d) => (d.face.eyes.imageLeft.region[2] -= 1)],
    ['mouth area centre', (d) => (d.face.mouth.area.center[1] += 1)],
    ['mouth area radius', (d) => (d.face.mouth.area.radius[0] += 1)],
    ['mouth area rotation', (d) => (d.face.mouth.area.rotation = 5)],
    ['strand nodes', (d) => (d.hair.strands[0].nodes[4] += 2)],
    ['strand width', (d) => (d.hair.strands[0].width = 26)],
    ['strand group', (d) => (d.hair.strands[0].group = 'side')],
    ['strand id', (d) => (d.hair.strands[0].id = 'bang')],
    ['a new strand', (d) => d.hair.strands.push({ id: 'new', nodes: [200, 50, 200, 120], width: 18 })],
    ['pendulum outline', (d) => (d.attachments[0].outline[0] -= 1)],
    ['cut-out outline', (d) => (d.attachments[2].outline[1] += 1)],
    ['attachment id', (d) => (d.attachments[0].id = 'tasselR')],
    ['a removed cut-out', (d) => d.attachments.pop()],
    ['feather', (d) => (d.build = { feather: 3 })],
  ];
  const KEEPS: Array<[string, (d: Json) => void]> = [
    ['name', (d) => (d.name = 'other')],
    ['turn, tilt', (d) => Object.assign(d.head, { turn: { x: 20, y: 9 }, tilt: 6 })],
    ['neck pivot and band', (d) => Object.assign(d.head, { pivot: [201, 301], neck: [286, 345] })],
    ['face oval, nose, chin', (d) => Object.assign(d.face, { center: [201, 199], radius: [74, 79], nose: [201, 226], chin: [200, 279] })],
    ['iris, brows, cheeks, ears', (d) => {
      d.face.eyes.imageLeft.iris.radius = 9;
      delete d.face.brows;
      d.face.cheeks.radius = 12;
      delete d.face.ears;
    }],
    ['mouth corners and bow', (d) => Object.assign(d.face.mouth, { imageLeft: [186, 249], bow: 4 })],
    ['strand swing and stiffness', (d) => Object.assign(d.hair.strands[0], { swing: 14, stiffness: 0.7 })],
    ['pendulum pivot, tip, swing, follow', (d) => Object.assign(d.attachments[0], { pivot: [333, 153], tip: [331, 227], swing: 20, follow: 'body' })],
    ['jiggle', (d) => Object.assign(d.attachments[1], { center: [121, 61], radius: [41, 36], swing: 6 })],
    ['cut-out contact and follow', (d) => Object.assign(d.attachments[2], { contact: [181, 286], follow: 'head' })],
    ['body', (d) => Object.assign(d.body, { pivot: [201, 640], fade: [390, 500], sway: 3, breath: 2, chest: { center: [201, 421], radius: [100, 60] } })],
    ['build cells and tolerance', (d) => (d.build = { cell: { body: 20, head: 12, detail: 4 }, variantTolerance: 3 })],
    ['post and notes', (d) => Object.assign(d, { post: [{ op: 'key', animation: 'a', target: 'param:AngleX', t: 0, v: 0, duration: 1 }], notes: ['hello'] })],
  ];

  it.each(CHANGES)('changes with the %s', (_name, mutate) => {
    const doc = validDoc();
    mutate(doc);
    expect(layerInputsHash(spec(doc))).not.toBe(layerInputsHash(spec()));
  });

  it.each(KEEPS)('ignores the %s', (_name, mutate) => {
    const doc = validDoc();
    mutate(doc);
    expect(layerInputsHash(spec(doc))).toBe(layerInputsHash(spec()));
  });

  it('agrees with cutsLayers: moving an item changes the hash exactly when it cuts layers', () => {
    const base = layerInputsHash(spec());
    for (const item of describeAvatarParts(validDoc()).flatMap((g) => g.items)) {
      if (!item.placed) continue;
      const doc = validDoc();
      // Nudge the first number the item owns by half a pixel (small enough to keep the spec valid).
      const pointer = pointersOf(item.shape)[0];
      const value = structuredClone(resolvePointer(doc, pointer)) as number[];
      value[0] += 0.5;
      setPointer(doc, pointer, value);
      expect(layerInputsHash(spec(doc)) !== base, item.id).toBe(item.cutsLayers);
    }
  });

  it('exposes the hashed fields', () => {
    expect(Object.keys(layerInputs(spec())).sort()).toEqual(['cuts', 'eyes', 'feather', 'head', 'image', 'mouthArea', 'strands']);
    expect(layerInputs(spec()).cuts).toEqual([
      { id: 'tassel', kind: 'pendulum', outline: [320, 150, 345, 150, 345, 230, 320, 230] },
      { id: 'hand', kind: 'cutout', outline: [140, 300, 190, 300, 190, 420, 140, 420] },
    ]);
  });
});
