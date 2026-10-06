/**
 * parseAvatarSpec and draftAvatarSpec: structural diagnostics (the model validator's conversion on
 * AvatarSpecSchema), the list of missing landmarks of a draft, and every semantic "avatar-*" code.
 */
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../core/types.js';
import { formatDiagnostics } from '../../core/validate.js';
import { AVATAR_DIAGNOSTIC_CODES, AVATAR_RESERVED_IDS, avatarSpecName, draftAvatarSpec, parseAvatarSpec } from '../spec.js';
import { byCode, HEIGHT, validDoc, WIDTH, type Json } from './fixtures.js';

function check(mutate: (doc: Json) => void, options?: Parameters<typeof parseAvatarSpec>[1]) {
  const doc = validDoc();
  mutate(doc);
  return parseAvatarSpec(doc, options);
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

describe('parseAvatarSpec: a valid spec', () => {
  it('reports nothing and returns the normalized spec', () => {
    const r = parseAvatarSpec(validDoc());
    expect(formatDiagnostics(r.diagnostics)).toBe('0 errors, 0 warnings');
    expect(r.spec).not.toBeNull();
    // Defaults are filled in.
    expect(r.spec!.hair!.strands[0]).toMatchObject({ swing: 10, stiffness: 1, group: 'front' });
    expect(r.spec!.attachments![0]).toMatchObject({ kind: 'pendulum', swing: 12, follow: 'head' });
    expect(r.spec!.attachments![2]).toMatchObject({ kind: 'cutout', follow: 'body' });
    expect(r.doc).toEqual(validDoc());
  });

  it('accepts JSON text with comments, trailing commas and a BOM', () => {
    const text = `﻿// my avatar\n${JSON.stringify(validDoc(), null, 2).replace(/\n}$/, ',\n}')}`;
    const r = parseAvatarSpec(text);
    expect(r.diagnostics).toEqual([]);
    expect(r.spec?.name).toBe('tester');
  });

  it('accepts the real image size when it matches', () => {
    expect(parseAvatarSpec(validDoc(), { imageSize: { width: WIDTH, height: HEIGHT } }).diagnostics).toEqual([]);
  });
});

describe('parseAvatarSpec: structural diagnostics', () => {
  it('reports a JSON syntax error with its position', () => {
    const r = parseAvatarSpec('{ "format": "rev2d-avatar", "version": 1,, }');
    expect(r.spec).toBeNull();
    expect(r.doc).toBeUndefined();
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error', code: 'json-syntax' });
    expect(r.diagnostics[0].message).toMatch(/line 1, column \d+/);
  });

  it('explains what an avatar spec is when the root is not an object', () => {
    const r = parseAvatarSpec([1, 2]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ code: 'schema-invalid-type', path: '', message: 'an avatar spec must be a JSON object, got array (2 items)' });
    expect(r.diagnostics[0].hint).toContain('"format": "rev2d-avatar"');
    expect(r.diagnostics[0].hint).toContain('rev2d avatar new');
  });

  it('names the avatar format when a model file is passed', () => {
    const r = check((d) => (d.format = 'rev2d'));
    const d = r.diagnostics.find((x) => x.path === '/format')!;
    expect(d.message).toBe('"format" must be "rev2d-avatar", got string "rev2d"');
    expect(d.hint).toBe('"format": "rev2d-avatar", "version": 1');
    expect(r.spec).toBeNull();
    // A document of another kind gets that one message, not a list of everything it is not.
    const model = parseAvatarSpec({ format: 'rev2d', version: 1, meta: { name: 'm', width: 512, height: 512 }, parts: [] });
    expect(model.diagnostics).toHaveLength(1);
    expect(model.diagnostics[0]).toMatchObject({ code: 'schema-invalid-value', path: '/format' });
  });

  it('suggests the right key for a typo and still reports the landmark it hides', () => {
    const r = check((d) => {
      d.head.centre = d.head.center;
      delete d.head.center;
    });
    expect(r.diagnostics.find((d) => d.path === '/head/centre')).toMatchObject({ code: 'schema-unrecognized-keys', hint: 'did you mean "center"?' });
    expect(r.diagnostics.find((d) => d.path === '/head/center')).toMatchObject({ code: 'avatar-missing-landmark' });
    // One diagnostic per problem: no "missing required field" on top.
    expect(r.diagnostics).toHaveLength(2);
  });

  it('says where a misplaced key belongs', () => {
    const r = check((d) => (d.face.tilt = 9));
    expect(r.diagnostics[0]).toMatchObject({ code: 'schema-unrecognized-keys', path: '/face/tilt' });
  });

  it('reports wrong types with the field description', () => {
    const r = check((d) => (d.head.tilt = '9'));
    expect(r.diagnostics[0]).toMatchObject({ code: 'schema-invalid-type', path: '/head/tilt', message: 'expected a number, got string "9"', hint: 'write 9 without quotes' });
  });

  it('reports refinements with the value and the field description', () => {
    const r = check((d) => (d.head.radius = [130, -150]));
    expect(r.diagnostics[0]).toMatchObject({ code: 'schema-custom', path: '/head/radius/1', message: 'must be > 0, got number -150' });
    expect(r.diagnostics[0].hint).toContain('WHOLE head');
  });

  it('guides through the attachment kinds', () => {
    const unknown = check((d) => (d.attachments[0].kind = 'pendulm'));
    expect(unknown.diagnostics[0]).toMatchObject({ code: 'schema-invalid-union', path: '/attachments/0/kind', message: 'unknown kind "pendulm"' });
    expect(unknown.diagnostics[0].hint).toContain('did you mean "pendulum"?');
    const missing = check((d) => delete d.attachments[1].kind);
    expect(missing.diagnostics[0]).toMatchObject({ path: '/attachments/1/kind', message: 'missing required field "kind"' });
    expect(missing.diagnostics[0].hint).toContain('"jiggle"');
    const foreign = check((d) => (d.attachments[1].pivot = [1, 2]));
    expect(foreign.diagnostics[0].hint).toContain('"pivot" is a field of kind "pendulum", not "jiggle"');
  });

  it('gives curated examples for missing fields that are not landmarks', () => {
    const noImage = check((d) => delete d.image);
    expect(noImage.diagnostics[0]).toMatchObject({ path: '/image', message: 'missing required field "image"', hint: 'e.g. "image": { "width": 1024, "height": 1024 }' });
    const noWidth = check((d) => delete d.hair.strands[0].width);
    expect(noWidth.diagnostics[0]).toMatchObject({ path: '/hair/strands/0/width', hint: 'e.g. "width": 30' });
    const noId = check((d) => delete d.attachments[0].id);
    expect(noId.diagnostics[0]).toMatchObject({ path: '/attachments/0/id', hint: 'e.g. "id": "tassel"' });
    const badName = check((d) => (d.name = '3 heads'));
    expect(badName.diagnostics[0]).toMatchObject({ path: '/name', message: 'invalid id "3 heads"' });
  });

  it('keeps the schema error when a container has the wrong type', () => {
    const r = check((d) => (d.head = 'round'));
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ code: 'schema-invalid-type', path: '/head', message: 'expected an object, got string "round"' });
  });
});

describe('draftAvatarSpec', () => {
  it('is a raw document with the image size and every landmark still null', () => {
    const draft = draftAvatarSpec('hero', 800, 1000) as Json;
    expect(draft).toMatchObject({ format: 'rev2d-avatar', version: 1, name: 'hero', image: { file: 'source.png', width: 800, height: 1000 } });
    expect(draft.head).toEqual({ center: null, radius: null, pivot: null, neck: null });
    expect(draft.face.eyes.imageLeft).toEqual({ opening: null, region: null });
    expect(draft.hair).toEqual({ strands: [] });
    expect(draft.attachments).toEqual([]);
  });

  it('validates to ONE list of missing landmarks, each with a placement hint', () => {
    const r = parseAvatarSpec(draftAvatarSpec('hero', 800, 1000));
    expect(r.spec).toBeNull();
    expect(new Set(codes(r.diagnostics))).toEqual(new Set(['avatar-missing-landmark']));
    expect(r.diagnostics.map((d) => d.path)).toEqual([
      '/head/center',
      '/head/radius',
      '/head/pivot',
      '/head/neck',
      '/face/eyes/imageLeft/opening',
      '/face/eyes/imageLeft/region',
      '/face/eyes/imageRight/opening',
      '/face/eyes/imageRight/region',
      '/face/mouth/imageLeft',
      '/face/mouth/imageRight',
      '/face/mouth/area/center',
      '/face/mouth/area/radius',
      '/face/center',
      '/face/radius',
      '/face/nose',
      '/face/chin',
      '/body/pivot',
      '/body/fade',
      '/body/chest/center',
      '/body/chest/radius',
    ]);
    for (const d of r.diagnostics) {
      expect(d.severity).toBe('error');
      expect(d.message).toMatch(/is not placed yet$/);
      expect(d.hint).toMatch(/^set ".+" to \[.+\] in source-image pixels: .{10,}/);
    }
    expect(r.diagnostics[0]).toMatchObject({ message: 'Head ellipse: centre is not placed yet', hint: 'set "center" to [x, y] in source-image pixels: horizontally on the face centre, vertically slightly above the eyes' });
    expect(byCode(r.diagnostics.filter((d) => d.path === '/head/neck'), 'avatar-missing-landmark')!.hint).toContain('[yStart, yEnd]');
  });

  it('lists every landmark of a section that is missing altogether', () => {
    const r = parseAvatarSpec({ format: 'rev2d-avatar', version: 1, name: 'x', image: { width: 800, height: 1000 } });
    expect(new Set(codes(r.diagnostics))).toEqual(new Set(['avatar-missing-landmark']));
    expect(r.diagnostics).toHaveLength(20);
  });

  it('treats an empty point list as not placed and reports entries of lists', () => {
    const r = check((d) => {
      d.face.eyes.imageLeft.opening = [];
      d.hair.strands[1].nodes = null;
      delete d.attachments[0].tip;
      delete d.attachments[1].radius;
    });
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['avatar-missing-landmark', '/face/eyes/imageLeft/opening'],
      ['avatar-missing-landmark', '/hair/strands/1/nodes'],
      ['avatar-missing-landmark', '/attachments/0/tip'],
      ['avatar-missing-landmark', '/attachments/1/radius'],
    ]);
    expect(r.diagnostics[1].message).toBe('Strand "sideR" is not placed yet');
    expect(r.diagnostics[2].message).toBe('Pendulum "tassel": tip is not placed yet');
  });

  it('checks what is already placed in an unfinished draft', () => {
    const draft = draftAvatarSpec('hero', WIDTH, HEIGHT) as Json;
    const full = validDoc();
    draft.face.eyes = { imageLeft: full.face.eyes.imageRight, imageRight: full.face.eyes.imageLeft };
    draft.head.neck = [340, 285];
    const r = parseAvatarSpec(draft);
    expect(byCode(r.diagnostics, 'avatar-eyes-swapped')).toMatchObject({ severity: 'error', path: '/face/eyes' });
    expect(byCode(r.diagnostics, 'avatar-band-order')).toMatchObject({ path: '/head/neck' });
    expect(r.diagnostics.filter((d) => d.code === 'avatar-missing-landmark')).toHaveLength(15);
    expect(codes(r.diagnostics).some((c) => c.startsWith('schema-'))).toBe(false);
  });

  it('makes any text a valid name', () => {
    expect(avatarSpecName('My Avatar (v2)')).toBe('My_Avatar_v2');
    expect(avatarSpecName('2nd')).toBe('_2nd');
    expect(avatarSpecName('  ')).toBe('avatar');
    expect((draftAvatarSpec('new hero!', 10, 10) as Json).name).toBe('new_hero');
  });
});

// ----------------------------------------------------------------------------- semantic codes

interface Case {
  code: keyof typeof AVATAR_DIAGNOSTIC_CODES;
  what: string;
  mutate: (doc: Json) => void;
  path: string;
  message?: RegExp;
  hint?: RegExp;
  options?: Parameters<typeof parseAvatarSpec>[1];
}

const LEFT_OPENING = () => validDoc().face.eyes.imageLeft.opening as number[];

const CASES: Case[] = [
  {
    code: 'avatar-image-size-mismatch',
    what: 'the declared size differs from the real image',
    mutate: () => {},
    options: { imageSize: { width: 800, height: 1000 }, imageName: 'art.png' },
    path: '/image',
    message: /the spec says the image is 400x500, but art\.png is 800x1000/,
    hint: /"width": 800, "height": 1000/,
  },
  { code: 'avatar-image-size', what: 'a tiny image', mutate: (d) => (d.image = { width: 120, height: 150 }), path: '/image', message: /only 120x150/ },
  { code: 'avatar-image-size', what: 'a huge image', mutate: (d) => (d.image = { width: 6000, height: 7500 }), path: '/image', message: /6000x7500/, hint: /1000-2000 px/ },
  { code: 'avatar-points-odd', what: 'an odd point list', mutate: (d) => d.face.eyes.imageLeft.opening.push(150), path: '/face/eyes/imageLeft/opening', message: /17 values, an odd number/ },
  { code: 'avatar-too-few-points', what: 'a polygon of two points', mutate: (d) => (d.face.eyes.imageLeft.opening = [150, 195, 180, 195]), path: '/face/eyes/imageLeft/opening', message: /has 2 points; a polygon needs at least 3/ },
  { code: 'avatar-too-few-points', what: 'a strand of one node', mutate: (d) => (d.hair.strands[0].nodes = [170, 60]), path: '/hair/strands/0/nodes', message: /has 1 point; a polyline needs at least 2/ },
  {
    code: 'avatar-polygon-self-intersects',
    what: 'a bow-tie outline',
    mutate: (d) => (d.attachments[2].outline = [140, 300, 190, 420, 190, 300, 140, 420]),
    path: '/attachments/2/outline',
    message: /crosses itself: the edge from point 0 and the edge from point 2 intersect near \(165, 360\)/,
  },
  { code: 'avatar-outside-image', what: 'a strand node below the image', mutate: (d) => (d.hair.strands[1].nodes = [300, 120, 310, 220, 305, 520]), path: '/hair/strands/1/nodes', message: /1 of 3 points is outside the image \(point 2 at \(305, 520\)\)/, hint: /y runs 0\.\.500 downward/ },
  { code: 'avatar-outside-image', what: 'a point right of the image', mutate: (d) => (d.face.cheeks.imageRight = [420, 225]), path: '/face/cheeks/imageRight', message: /Cheek \(image right\) \(420, 225\) is outside the image/ },
  { code: 'avatar-outside-image', what: 'a band below the image', mutate: (d) => (d.body.fade = [600, 700]), path: '/body/fade' },
  { code: 'avatar-polygon-outside-image', what: 'a cut polygon with no pixels', mutate: (d) => (d.attachments[0].outline = [420, 150, 445, 150, 445, 230, 420, 230]), path: '/attachments/0/outline', message: /lies entirely outside the image/ },
  { code: 'avatar-polygon-outside-image', what: 'a mouth area off the image', mutate: (d) => (d.face.mouth.area.center = [200, 600]), path: '/face/mouth/area/center' },
  {
    code: 'avatar-eye-opening-outside-region',
    what: 'an opening beside its region',
    mutate: (d) => (d.face.eyes.imageLeft.opening = LEFT_OPENING().map((v, i) => (i % 2 ? v + 40 : v))),
    path: '/face/eyes/imageLeft/opening',
    message: /not inside its region \(8 of 8 points outside/,
  },
  {
    code: 'avatar-eye-opening-outside-region',
    what: 'opening and region swapped',
    mutate: (d) => {
      const eye = d.face.eyes.imageRight;
      [eye.opening, eye.region] = [eye.region, eye.opening];
    },
    path: '/face/eyes/imageRight/opening',
    hint: /look swapped/,
  },
  {
    code: 'avatar-eye-opening-exceeds-region',
    what: 'one opening point outside the region',
    mutate: (d) => (d.face.eyes.imageLeft.opening[0] = 138),
    path: '/face/eyes/imageLeft/opening',
    message: /1 point of the imageLeft eye opening sticks out of its region by up to 4 px \(point 0\)/,
  },
  {
    code: 'avatar-eyes-swapped',
    what: 'imageLeft on the right',
    mutate: (d) => ([d.face.eyes.imageLeft, d.face.eyes.imageRight] = [d.face.eyes.imageRight, d.face.eyes.imageLeft]),
    path: '/face/eyes',
    message: /imageLeft eye \(x = 235\) is not left of the imageRight eye \(x = 165\)/,
    hint: /LEFT SIDE OF THE IMAGE/,
  },
  {
    code: 'avatar-eyes-overlap',
    what: 'both openings on one eye',
    mutate: (d) => {
      d.face.eyes.imageRight.opening = LEFT_OPENING().map((v, i) => (i % 2 ? v : v + 10));
      d.face.eyes.imageRight.region = d.face.eyes.imageLeft.region.map((v: number, i: number) => (i % 2 ? v : v + 10));
    },
    path: '/face/eyes',
  },
  {
    code: 'avatar-eye-region-contains-other',
    what: 'a region over both eyes',
    mutate: (d) => (d.face.eyes.imageLeft.region = [142, 195, 150, 176, 262, 176, 262, 214, 150, 214]),
    path: '/face/eyes/imageLeft/region',
    message: /reaches into the imageRight eye \(8 of its 8 opening points are inside\)/,
  },
  { code: 'avatar-outside-head', what: 'the chin below the head ellipse', mutate: (d) => (d.face.chin = [200, 330]), path: '/face/chin', message: /the chin \(200, 330\) is outside the head ellipse/, hint: /WHOLE head/ },
  { code: 'avatar-outside-head', what: 'an eye outside the head ellipse', mutate: (d) => (d.head.center = [330, 170]), path: '/face/eyes/imageLeft', message: /the imageLeft eye/ },
  { code: 'avatar-face-outside-head', what: 'a face oval wider than the head', mutate: (d) => (d.face.radius = [150, 80]), path: '/face/radius', message: /sticks out of the head ellipse by up to \d+(\.\d)? px/ },
  { code: 'avatar-band-order', what: 'an upside-down neck band', mutate: (d) => (d.head.neck = [340, 285]), path: '/head/neck', message: /\[340, 285\]: yStart must be smaller than yEnd/ },
  { code: 'avatar-band-order', what: 'an empty body fade', mutate: (d) => (d.body.fade = [500, 500]), path: '/body/fade' },
  { code: 'avatar-neck-above-chin', what: 'a neck band that starts on the face', mutate: (d) => (d.head.neck = [240, 340]), path: '/head/neck', message: /above the chin \(y = 278\): the chin gets only 68% of the head motion/, hint: /\[280, 340\]/ },
  {
    code: 'avatar-mouth-corners-swapped',
    what: 'swapped mouth corners',
    mutate: (d) => ([d.face.mouth.imageLeft, d.face.mouth.imageRight] = [d.face.mouth.imageRight, d.face.mouth.imageLeft]),
    path: '/face/mouth',
  },
  { code: 'avatar-mouth-area', what: 'an area beside the mouth', mutate: (d) => (d.face.mouth.area.center = [240, 250]), path: '/face/mouth/area', message: /does not contain the imageLeft mouth corner \(185, 248\)/ },
  { code: 'avatar-mouth-area', what: 'an area rotated away from the corners', mutate: (d) => Object.assign(d.face.mouth.area, { radius: [24, 4], rotation: 60 }), path: '/face/mouth/area', hint: /rotation/ },
  { code: 'avatar-duplicate-id', what: 'two strands with one id', mutate: (d) => (d.hair.strands[1].id = 'bangL'), path: '/hair/strands/1/id', message: /duplicate strand id "bangL" \(first used by \/hair\/strands\/0\)/ },
  { code: 'avatar-duplicate-id', what: 'two attachments with one id', mutate: (d) => (d.attachments[2].id = 'tassel'), path: '/attachments/2/id', message: /duplicate attachment id "tassel"/ },
  { code: 'avatar-reserved-id', what: 'an attachment named like a layer', mutate: (d) => (d.attachments[1].id = 'hair'), path: '/attachments/1/id', message: /"hair" is reserved/ },
  {
    code: 'avatar-strand-root-outside-head',
    what: 'a strand listed from tip to root',
    mutate: (d) => (d.hair.strands[1].nodes = [305, 320, 310, 220, 300, 120]),
    path: '/hair/strands/1/nodes',
    message: /strand "sideR" starts at \(305, 320\), outside the head ellipse/,
    hint: /looks reversed/,
  },
  { code: 'avatar-pendulum-degenerate', what: 'pivot == tip', mutate: (d) => (d.attachments[0].tip = [332, 152.4]), path: '/attachments/0/tip', message: /pendulum "tassel": pivot and tip are the same point/ },
  { code: 'avatar-implausible-value', what: 'a turn of a fifth of the image', mutate: (d) => (d.head.turn.x = 80), path: '/head/turn/x', message: /20% of the image width/, hint: /8-20 px/ },
  { code: 'avatar-implausible-value', what: 'a negative turn', mutate: (d) => (d.head.turn.y = -12), path: '/head/turn/y', message: /must be positive/ },
  { code: 'avatar-implausible-value', what: 'a tilt in radians', mutate: (d) => (d.head.tilt = 0.15), path: '/head/tilt', hint: /degrees, not radians/ },
  { code: 'avatar-implausible-value', what: 'a huge tilt', mutate: (d) => (d.head.tilt = 45), path: '/head/tilt', message: /very strong head roll/ },
  { code: 'avatar-implausible-value', what: 'a huge sway', mutate: (d) => (d.body.sway = 20), path: '/body/sway' },
  { code: 'avatar-implausible-value', what: 'a deep breath', mutate: (d) => (d.body.breath = 30), path: '/body/breath' },
  { code: 'avatar-implausible-value', what: 'a flying strand', mutate: (d) => (d.hair.strands[0].swing = 60), path: '/hair/strands/0/swing' },
  { code: 'avatar-implausible-value', what: 'a pendulum swing in radians', mutate: (d) => (d.attachments[0].swing = 0.2), path: '/attachments/0/swing', hint: /degrees, not radians/ },
  { code: 'avatar-implausible-value', what: 'a jiggle across the image', mutate: (d) => (d.attachments[1].swing = 40), path: '/attachments/1/swing' },
  { code: 'avatar-post-op', what: 'a post entry without an op', mutate: (d) => (d.post = [{ target: 'param:AngleZ', t: 0 }]), path: '/post/0', message: /post entry 0 has no "op"/, hint: /rev2d docs ops/ },
  { code: 'avatar-post-op', what: 'a post entry that is no object', mutate: (d) => (d.post = ['key']), path: '/post/0', message: /is not an op object/ },
  { code: 'avatar-post-op', what: 'a misspelled op', mutate: (d) => (d.post = [{ op: 'kee', animation: 'wave' }]), path: '/post/0/op', message: /unknown op "kee"/, hint: /did you mean "key"\?/ },
];

describe('parseAvatarSpec: semantic checks', () => {
  for (const c of CASES) {
    it(`${c.code}: ${c.what}`, () => {
      const r = check(c.mutate, c.options);
      const d = r.diagnostics.find((x) => x.code === c.code && x.path === c.path);
      expect(d, formatDiagnostics(r.diagnostics)).toBeDefined();
      expect(d!.severity).toBe(AVATAR_DIAGNOSTIC_CODES[c.code]);
      expect(d!.hint, 'every diagnostic carries a hint').toBeTruthy();
      if (c.message) expect(d!.message).toMatch(c.message);
      if (c.hint) expect(d!.hint).toMatch(c.hint);
      // An error blocks the spec; warnings and infos alone do not.
      expect(r.spec === null).toBe(r.diagnostics.some((x) => x.severity === 'error'));
      // No schema noise next to a semantic diagnostic.
      expect(r.diagnostics.filter((x) => x.code.startsWith('schema-'))).toEqual([]);
    });
  }

  it('covers every documented code', () => {
    const tested = new Set<string>([...CASES.map((c) => c.code), 'avatar-missing-landmark']);
    expect([...tested].sort()).toEqual(Object.keys(AVATAR_DIAGNOSTIC_CODES).sort());
  });

  it('isolates each case: a single mutation gives a single semantic diagnostic where the geometry allows', () => {
    const single = ['avatar-points-odd', 'avatar-band-order', 'avatar-mouth-corners-swapped', 'avatar-duplicate-id', 'avatar-reserved-id', 'avatar-pendulum-degenerate', 'avatar-neck-above-chin', 'avatar-eyes-swapped', 'avatar-strand-root-outside-head'];
    for (const c of CASES.filter((x) => single.includes(x.code))) {
      expect(check(c.mutate, c.options).diagnostics.map((d) => d.code), c.what).toEqual([c.code]);
    }
  });

  it('accepts what looks unusual but is fine', () => {
    // The body pivot below the image, a polygon touching the border, a neck band starting a little above the chin.
    const r = check((d) => {
      d.body.pivot = [200, 900];
      d.attachments[2].outline = [140, 300, 190, 300, 190, 500, 140, 500];
      d.head.neck = [272, 340];
      d.body.sway = 0;
      d.post = [{ op: 'key', animation: 'wave', target: 'param:AngleZ', t: 0, v: 0, duration: 2 }];
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.spec).not.toBeNull();
  });

  it('tolerates an opening that touches its region', () => {
    const r = check((d) => (d.face.eyes.imageLeft.opening[0] = 141.5));
    expect(r.diagnostics).toEqual([]);
  });

  it('lists the reserved ids', () => {
    expect(AVATAR_RESERVED_IDS).toContain('base');
    for (const id of AVATAR_RESERVED_IDS) {
      const r = check((d) => (d.attachments[0].id = id));
      expect(byCode(r.diagnostics, 'avatar-reserved-id'), id).toBeDefined();
    }
  });

  it('formats like model diagnostics', () => {
    const text = formatDiagnostics(check((d) => (d.head.neck = [340, 285])).diagnostics);
    expect(text).toContain('error   /head/neck  avatar-band-order  the neck band is [340, 285]: yStart must be smaller than yEnd  → yStart = just below the chin');
    expect(text).toContain('1 error, 0 warnings');
  });
});
