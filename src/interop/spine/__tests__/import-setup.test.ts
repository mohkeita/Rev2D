import { describe, expect, it } from 'vitest';
import { importSpine } from '../index.js';
import type { SpineImportInput } from '../../types.js';
import {
  applyAffine,
  bone,
  canvasOf,
  codes,
  expectClose,
  fixtureJson,
  fixtureText,
  load,
  makeImage,
  part,
  pixel,
  render,
  spineWorlds,
} from './helpers.js';

const white = makeImage(64, 32, () => [255, 255, 255, 255]);

function hero(extra: Partial<SpineImportInput> = {}) {
  return importSpine({ skeleton: fixtureText('hero-4x.json'), atlas: fixtureText('hero.atlas'), pages: { 'hero.png': white }, name: 'hero', ...extra });
}

describe('spine import: document and report', () => {
  it('produces a valid Rev2D model with textures, stats and located issues', () => {
    const res = hero();
    const l = load(res);
    expect(res.doc.meta).toEqual({ name: 'hero', width: 164, height: 224, fps: 24, description: 'Imported from Spine 4.2.22 (skin "default")' });
    expect(res.files.map((f) => f.path)).toEqual(['textures/hero.png']);
    expect(l.model.textures).toEqual([{ id: 'hero', path: 'textures/hero.png', width: 64, height: 32 }]);
    expect(res.report).toMatchObject({ format: 'spine', direction: 'import' });
    expect(res.report.stats).toMatchObject({
      bones: 12,
      shearBones: 2,
      slots: 8,
      parts: 9,
      textures: 1,
      animations: 2,
      events: 2,
      'attachments.region': 5,
      'attachments.mesh': 2,
      'attachments.linkedmesh': 1,
      'attachments.clipping': 1,
      'attachments.boundingbox': 1,
      'attachments.point': 1,
    });
    const expected = [
      'spine-id-renamed',
      'spine-bone-shear-pair',
      'spine-bone-inherit-detached',
      'spine-bone-inherit-shear',
      'spine-ik-soft-stretch',
      'spine-skin-not-imported',
      'spine-page-unpremultiplied',
      'spine-dark-color',
      'spine-region-missing',
      'spine-attachment-skipped',
      'spine-clipping-animated',
      'spine-ik-compress',
      'spine-ik-uniform',
      'spine-transform-baked',
      'spine-transform-emulated',
      'spine-path-constraint',
      'spine-physics-constraint',
      'spine-ik-variants',
      'spine-timeline-path',
      'spine-timeline-physics',
    ];
    for (const code of expected) expect(codes(res)).toContain(code);
    for (const issue of res.report.issues) {
      expect(issue.code).toMatch(/^spine-[a-z0-9-]+$/);
      expect(issue.where, issue.code).toBeTruthy();
      expect(['warning', 'info']).toContain(issue.severity);
    }
    // Deterministic output.
    expect(JSON.stringify(hero().doc)).toBe(JSON.stringify(res.doc));
  });

  it('renders the imported model', () => {
    const l = load(hero());
    const { image, pose } = render(l);
    expect(pose.drawOrder).toContain('body__body');
    let opaque = 0;
    for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 0) opaque++;
    expect(opaque).toBeGreaterThan(500);
  });

  it('rejects input that is not a Spine skeleton', () => {
    expect(() => importSpine({ skeleton: '{nope' })).toThrow(/not valid JSON/);
    expect(() => importSpine({ skeleton: { skins: [] } })).toThrow(/no "bones"/);
    expect(() => importSpine({ skeleton: fixtureText('hero-4x.json'), scale: 0 })).toThrow(/scale/);
    expect(() => importSpine({ skeleton: fixtureText('hero-4x.json'), atlas: 'p.png\nsize: x, 1\n' })).toThrow(/atlas/);
    expect(() => importSpine({ skeleton: { bones: [{ name: 'a', parent: 'b' }] } })).toThrow(/parent "b"/);
  });
});

describe('spine import: bones', () => {
  it('flips y and rotations and fits the setup bounds into the canvas with padding', () => {
    const res = hero();
    const json = fixtureJson('hero-4x.json');
    const spine = spineWorlds(json.bones as Array<Record<string, unknown>>);
    const toCanvas = canvasOf(res.doc);
    // Skeleton bounds x -50..50, y -20..140 with 32 px padding.
    expect(toCanvas(-50, 140)).toEqual([32, 32]);
    // torso is sheared in an animation: "torso-shear" carries its rotation (and scale), torso sits on it.
    expect(bone(res.doc, 'torso-shear')).toMatchObject({ parent: 'hip', rotation: -90 });
    expect(bone(res.doc, 'torso')).toMatchObject({ parent: 'torso-shear', length: 50 });
    expect(bone(res.doc, 'torso').rotation).toBeUndefined();
    expect(bone(res.doc, 'upper_arm')).toMatchObject({ x: 40, y: -5, rotation: 150, description: 'Spine bone "upper arm"' });
    expect(bone(res.doc, 'head').color).toBe('#ff0000ff');
    expect(bone(res.doc, 'scaled')).toMatchObject({ x: 20, y: 10, rotation: -30, scaleX: 2, scaleY: 0.5 });
    const { rig } = load(res);
    const pose = rig.pose();
    // Bones not moved by IK: joints and tips land where the Spine setup pose puts them.
    const ids: Record<string, string> = { root: 'root', hip: 'hip', torso: 'torso', head: 'head', scaled: 'scaled', 'hand-target': 'hand-target', 'front-shoulder': 'front-shoulder', 'back-shoulder': 'back-shoulder' };
    const lengths: Record<string, number> = { torso: 50, head: 30, scaled: 10 };
    for (const [name, id] of Object.entries(ids)) {
      const w = spine[name];
      const b = pose.bones[id];
      expectClose([b.x, b.y], toCanvas(w.x, w.y), 1e-6);
      expectClose(b.tip, toCanvas(...applyAffine(w, lengths[name] ?? 0, 0)), 1e-6);
    }
    expect(pose.bones.head.rotation).toBeCloseTo(-75, 9);
  });

  it('keeps the setup world of bones with shear or non-normal inheritance', () => {
    const res = hero();
    const { rig } = load(res);
    const pose = rig.pose();
    // "sheared" (shearX 10°): x axis turned 10° CCW (-10° in Rev2D), y axis still straight up.
    expect(pose.bones.sheared.rotation).toBeCloseTo(-10, 6);
    expectClose(pose.bones.sheared.world.slice(0, 4), [Math.cos(Math.PI / 18), -Math.sin(Math.PI / 18), 0, 1], 1e-8);
    // "tip" (noRotationOrReflection under the 75°-rotated head) keeps world rotation 0; the transform
    // constraint "other" (mixRotate 0.5, the other mixes default 1) then moves it onto "hip" at (0, 40),
    // whose rotation is also 0.
    expect(pose.bones.tip.rotation).toBeCloseTo(0, 6);
    expectClose([pose.bones.tip.x, pose.bones.tip.y], canvasOf(res.doc)(0, 40), 1e-6);
  });

  it('applies the scale option to translations, lengths and the canvas', () => {
    const res = hero({ scale: 2, padding: 10 });
    expect(res.doc.meta).toMatchObject({ width: 220, height: 340 });
    expect(bone(res.doc, 'torso').length).toBe(100);
    expect(bone(res.doc, 'upper_arm')).toMatchObject({ x: 80, y: -10 });
    expect(bone(res.doc, 'root')).toMatchObject({ x: 110, y: 290 });
  });

  it('frames the setup attachments when the skeleton bounds are implausibly large', () => {
    // Seen in an official export: bounds 756 x 273928 around 1000 px of art (a 274k px tall canvas).
    const skeleton = (bounds: Record<string, number>) => ({
      skeleton: { spine: '4.2.0', ...bounds },
      bones: [{ name: 'root' }],
      slots: [{ name: 's', bone: 'root', attachment: 'a' }],
      skins: [{ name: 'default', attachments: { s: { a: { y: 20, width: 20, height: 40 } } } }],
    });
    const bogus = importSpine({ skeleton: skeleton({ x: -10, y: -100000, width: 20, height: 100040 }) });
    expect(bogus.doc.meta).toMatchObject({ width: 84, height: 104 });
    expect(canvasOf(bogus.doc)(-10, 40)).toEqual([32, 32]);
    expect(bogus.report.issues.find((i) => i.code === 'spine-bounds-ignored')).toMatchObject({ severity: 'info', where: 'skeleton' });
    // Plausible bounds (what Spine computed, a little larger than the art) are kept.
    const kept = importSpine({ skeleton: skeleton({ x: -20, y: -10, width: 60, height: 80 }) });
    expect(kept.doc.meta).toMatchObject({ width: 124, height: 144 });
    expect(codes(kept)).not.toContain('spine-bounds-ignored');
  });

  it('renames ids that Rev2D does not allow', () => {
    const res = importSpine({ skeleton: { bones: [{ name: 'root' }, { name: '1 arm.L', parent: 'root' }, { name: '1_arm_L', parent: 'root' }] } });
    expect((res.doc.bones as Array<{ id: string }>).map((b) => b.id)).toEqual(['root', '_1_arm_L', '_1_arm_L-2']);
    expect(res.report.issues.filter((i) => i.code === 'spine-id-renamed').map((i) => i.where)).toEqual(['bones[1] (1 arm.L)', 'bones[2] (1_arm_L)']);
  });
});

describe('spine import: attachments', () => {
  it('maps rotated regions to their page pixels (uvs) and quad corners', () => {
    const res = hero();
    const toCanvas = canvasOf(res.doc);
    const back = part(res.doc, 'back');
    // Region 20 x 40 at (0, 60) on the root bone: corners BL, TL, TR, BR.
    expect(back.shape.vertices).toEqual([...toCanvas(-10, 40), ...toCanvas(-10, 80), ...toCanvas(10, 80), ...toCanvas(10, 40)]);
    // 90° rotated region at (2, 2), original 10 x 20: the image's top-left is at the rect's bottom-left.
    expectClose(back.shape.uvs, [22 / 64, 12 / 32, 2 / 64, 12 / 32, 2 / 64, 2 / 32, 22 / 64, 2 / 32], 1e-12);
    expect(back.shape).toMatchObject({ triangles: [0, 1, 2, 2, 3, 0], texture: 'hero' });
    expect(back.parent).toBe('root');
  });

  it('draws rotated regions the right way up', () => {
    // Page: the bg region's original image has red (top-left), green (top-right), blue (bottom-left)
    // and white (bottom-right) quadrants; stored rotated by 90° at (2, 2) (page x = 2 + imageY,
    // page y = 12 - imageX).
    const page = makeImage(64, 32, (qx, qy) => {
      if (qx < 2 || qx >= 22 || qy < 2 || qy >= 12) return [0, 0, 0, 0];
      const ix = 12 - (qy + 0.5);
      const iy = qx + 0.5 - 2;
      const top = iy < 10;
      const left = ix < 5;
      return top ? (left ? [255, 0, 0, 255] : [0, 255, 0, 255]) : left ? [0, 0, 255, 255] : [255, 255, 255, 255];
    });
    const res = importSpine({
      skeleton: { skeleton: { spine: '4.2.1' }, bones: [{ name: 'root' }], slots: [{ name: 's', bone: 'root', attachment: 'bg' }], skins: [{ name: 'default', attachments: { s: { bg: { width: 20, height: 40 } } } }] },
      atlas: fixtureText('hero.atlas'),
      pages: { 'hero.png': page },
      padding: 0,
    });
    const { image } = render(load(res));
    expect(image.width).toBe(20);
    expect(image.height).toBe(40);
    expect(pixel(image, 4, 8)).toEqual([255, 0, 0, 255]);
    expect(pixel(image, 15, 8)).toEqual([0, 255, 0, 255]);
    expect(pixel(image, 4, 30)).toEqual([0, 0, 255, 255]);
    expect(pixel(image, 15, 30)).toEqual([255, 255, 255, 255]);
  });

  it('places whitespace-stripped regions by their offsets (with attachment rotation and bone)', () => {
    const res = hero();
    const json = fixtureJson('hero-4x.json');
    const head = spineWorlds(json.bones as Array<Record<string, unknown>>).head;
    const toCanvas = canvasOf(res.doc);
    // Original 16 x 16 drawn at 32 x 32 (2x): packed 12 x 10 at offset (2, 3) -> quad x -12..12,
    // y -10..10, rotated -90° (x, y) -> (y, -x), moved to (15, 0).
    const local = [
      [-12, -10],
      [-12, 10],
      [12, 10],
      [12, -10],
    ].map(([x, y]) => [y + 15, -x]);
    const expected = local.flatMap(([x, y]) => toCanvas(...applyAffine(head, x, y)));
    expectClose(part(res.doc, 'head__head').shape.vertices, expected, 1e-9);
    expectClose(part(res.doc, 'head__head').shape.uvs, [30 / 64, 12 / 32, 30 / 64, 2 / 32, 42 / 64, 2 / 32, 42 / 64, 12 / 32], 1e-12);
  });

  it('imports unweighted meshes on the slot bone and weighted meshes as explicit skins', () => {
    const res = hero();
    const toCanvas = canvasOf(res.doc);
    const body = part(res.doc, 'body__body');
    expect(body.parent).toBe('torso');
    // Torso-local (x, y) is Spine world (-y, 40 + x).
    expect(body.shape.vertices).toEqual([...toCanvas(10, 40), ...toCanvas(10, 90), ...toCanvas(-10, 90), ...toCanvas(-10, 40)]);
    expectClose(body.shape.uvs, [2 / 64, 14 / 32, 22 / 64, 14 / 32, 22 / 64, 30 / 32, 2 / 64, 30 / 32], 1e-12);
    const skin = part(res.doc, 'skin');
    expect(skin.parent).toBeUndefined();
    expect(skin.skin).toEqual({ bones: ['hip', 'torso'], weights: [[1, 0], [0.5, 0.5], [0.5, 0.5], [0, 1]] });
    expect(skin.shape.vertices).toEqual([...toCanvas(-10, 40), ...toCanvas(10, 40), ...toCanvas(10, 70), ...toCanvas(-10, 70)]);
  });

  it('skins weighted meshes like Spine when bones move', () => {
    // Two bones; the vertex is bound 50/50 with consistent per-bone offsets.
    const skeleton = {
      skeleton: { spine: '4.2.0' },
      bones: [{ name: 'root' }, { name: 'a', parent: 'root', rotation: 0 }, { name: 'b', parent: 'root', x: 20 }],
      slots: [{ name: 's', bone: 'root', attachment: 'm' }],
      skins: [
        {
          name: 'default',
          attachments: {
            s: {
              m: {
                type: 'mesh',
                uvs: [0, 0, 1, 0, 0, 1],
                triangles: [0, 1, 2],
                vertices: [1, 1, 0, 0, 1, 2, 1, 10, 5, 0.5, 2, -10, 5, 0.5, 1, 2, 0, 10, 1],
              },
            },
          },
        },
      ],
      animations: { turn: { bones: { a: { rotate: [{ value: 30 }] }, b: { translate: [{ x: 4, y: -6 }] } } } },
    };
    const res = importSpine({ skeleton, padding: 0 });
    const { rig } = load(res);
    const pose = rig.pose({ animations: ['turn'] });
    const toCanvas = canvasOf(res.doc);
    // Spine: vertex 1 = 0.5 · A(pose)·(10, 5) + 0.5 · B(pose)·(-10, 5).
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const a = [10 * c - 5 * s, 10 * s + 5 * c];
    const b = [20 + 4 - 10, 5 - 6];
    const spineX = 0.5 * a[0] + 0.5 * b[0];
    const spineY = 0.5 * a[1] + 0.5 * b[1];
    const setup = part(res.doc, 's').shape.vertices as number[];
    expectClose(rig.mapPoint(pose, 'part:s', setup[2], setup[3]), toCanvas(spineX, spineY), 1e-9);
  });

  it('links linked meshes to their parent geometry with their own region', () => {
    const res = hero();
    const linked = part(res.doc, 'body__body-linked');
    const body = part(res.doc, 'body__body');
    expect(linked.shape.vertices).toEqual(body.shape.vertices);
    expect(linked.shape.triangles).toEqual(body.shape.triangles);
    expect(linked.parent).toBe('torso');
    expectClose(linked.shape.uvs, [24 / 64, 14 / 32, 44 / 64, 14 / 32, 44 / 64, 30 / 32, 24 / 64, 30 / 32], 1e-12);
    expect(linked.opacity).toBe(0);
  });

  it('turns clipping attachments into invisible mask parts over the clipped slots', () => {
    const res = hero();
    const toCanvas = canvasOf(res.doc);
    const clip = part(res.doc, 'clip');
    expect(clip).toMatchObject({ parent: 'root', opacity: 0, fill: '#ffffff', z: 3 });
    expect(clip.shape).toEqual({ type: 'polygon', points: [...toCanvas(-40, 0), ...toCanvas(40, 0), ...toCanvas(40, 120), ...toCanvas(-40, 120)] });
    // Clipped: the slots after "clip" up to its end slot "head".
    expect(part(res.doc, 'head__head').mask).toEqual(['clip']);
    expect(part(res.doc, 'head__head-alt').mask).toEqual(['clip']);
    expect(part(res.doc, 'hand').mask).toBeUndefined();
    expect(part(res.doc, 'body__body').mask).toBeUndefined();
    // Masking works: the head outside the clip polygon is not drawn.
    const clipped = importSpine({
      skeleton: {
        bones: [{ name: 'root' }],
        slots: [
          { name: 'c', bone: 'root', attachment: 'c' },
          { name: 'q', bone: 'root', attachment: 'q' },
        ],
        skins: [{ name: 'default', attachments: { c: { c: { type: 'clipping', end: 'q', vertexCount: 3, vertices: [0, 0, 20, 0, 0, 20] } }, q: { q: { x: 10, y: 10, width: 20, height: 20 } } } }],
      },
      padding: 0,
    });
    expect(codes(clipped)).toContain('spine-no-atlas');
    const { image } = render(load(clipped));
    expect(pixel(image, 3, 16)[3]).toBe(255); // inside the triangle (Spine (3, 4))
    expect(pixel(image, 17, 3)[3]).toBe(0); // outside (Spine (17, 17))
  });

  it('skips bounding boxes, points and paths, and imports untextured shapes without an atlas', () => {
    const res = importSpine({ skeleton: fixtureText('hero-4x.json') });
    expect((res.doc.parts as Array<{ id: string }>).map((p) => p.id)).not.toContain('marker');
    expect(part(res.doc, 'back')).toMatchObject({ fill: '#a0a0a0' });
    expect(part(res.doc, 'back').shape.uvs).toBeUndefined();
    expect(res.doc.textures).toBeUndefined();
    expect(codes(res)).toContain('spine-no-atlas');
    load(res);
    const noPages = importSpine({ skeleton: fixtureText('hero-4x.json'), atlas: fixtureText('hero.atlas') });
    expect(codes(noPages)).toContain('spine-page-missing');
    expect(part(noPages.doc, 'back').fill).toBe('#a0a0a0');
  });
});

describe('spine import: slots, colors and skins', () => {
  it('maps slot and attachment colors to tint and opacity, and blend modes', () => {
    const res = hero();
    expect(part(res.doc, 'back')).toMatchObject({ tint: '#80ff80', blend: 'add', z: 0 });
    expect(part(res.doc, 'back').opacity).toBeCloseTo(0xc0 / 255, 12);
    // Hidden attachments start at opacity 0 (not visible:false, so animations can show them).
    expect(part(res.doc, 'head__head-alt')).toMatchObject({ opacity: 0, tint: '#ff0000' });
    expect(part(res.doc, 'head__head-alt').visible).toBeUndefined();
    expect(part(res.doc, 'front')).toMatchObject({ opacity: 0, blend: 'multiply', z: 7 });
    expect(part(res.doc, 'head__head').tags).toEqual(['spine-slot:head', 'spine-attachment:head']);
    expect(res.report.issues.find((i) => i.code === 'spine-dark-color')?.where).toBe('slots[4] (head)');
  });

  it('un-premultiplies pma pages', () => {
    const page = makeImage(64, 32, () => [64, 32, 0, 128]);
    const res = hero({ pages: { 'hero.png': page } });
    const l = load(res);
    expect(Array.from(l.textures.hero.data.slice(0, 4))).toEqual([128, 64, 0, 128]);
  });

  it('imports the selected skin over the default skin and reports the others', () => {
    const alt = hero({ skin: 'alt' });
    expect(alt.doc.meta).toMatchObject({ description: 'Imported from Spine 4.2.22 (skin "alt")' });
    // The alt skin's "head" attachment uses the head-alt region; default attachments still fill in.
    expectClose(part(alt.doc, 'head__head').shape.uvs, [44 / 64, 10 / 32, 44 / 64, 2 / 32, 52 / 64, 2 / 32, 52 / 64, 10 / 32], 1e-12);
    expect(part(alt.doc, 'head__head-alt')).toBeDefined();
    expect(codes(alt)).not.toContain('spine-skin-not-imported');
    const missing = hero({ skin: 'nope' });
    expect(missing.report.issues.find((i) => i.code === 'spine-skin-missing')?.message).toMatch(/importing "default"/);
  });

  it('reads 3.7-style skin objects', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '3.7.94' },
        bones: [{ name: 'root' }],
        slots: [{ name: 's', bone: 'root', attachment: 'a' }],
        skins: { default: { s: { a: { width: 10, height: 10 } } }, red: { s: { a: { width: 20, height: 20, color: 'ff0000ff' } } } },
      },
      skin: 'red',
    });
    expect(part(res.doc, 's')).toMatchObject({ tint: '#ff0000' });
    expect(codes(res)).toContain('spine-version-old');
    expect(res.report.issues.find((i) => i.code === 'spine-skin-not-imported')).toBeUndefined();
  });
});

describe('spine import: IK', () => {
  it('converts IK constraints in solve order with the bend direction flipped by the y axis', () => {
    const res = hero();
    const ik = res.doc.ik as Array<Record<string, unknown>>;
    expect(ik[0]).toEqual({ id: 'aim', bones: ['head'], target: 'hand-target', mix: 0, bendPositive: false });
    // Stretch with softness never stretches in Spine's two-bone solve: imported without stretch.
    expect(ik[1]).toEqual({ id: 'arm-ik', bones: ['upper_arm', 'fore-arm'], target: 'hand-target', bendPositive: true, softness: 4 });
    expect(res.report.issues.filter((i) => i.code === 'spine-ik-soft-stretch').map((i) => i.where)).toEqual(['ik[0] (arm-ik)', 'ik "arm-ik"']);
    expect(res.report.issues.filter((i) => i.code === 'spine-ik-compress' || i.code === 'spine-ik-uniform').map((i) => i.where)).toEqual(['ik[1] (aim)', 'ik[1] (aim)']);
  });

  it('imports stretch with softness as softness only, like Spine (which never stretches then)', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'a', parent: 'root', length: 50 },
          { name: 'b', parent: 'a', x: 50, length: 50 },
          { name: 'c', parent: 'root', y: -100, length: 50 },
          { name: 'd', parent: 'c', x: 50, length: 50 },
          { name: 't', parent: 'root', x: 200 },
          { name: 'u', parent: 'root', x: 200, y: -100 },
        ],
        ik: [
          { name: 'soft', bones: ['a', 'b'], target: 't', softness: 10, stretch: true },
          { name: 'hard', bones: ['c', 'd'], target: 'u', stretch: true },
        ],
      },
    });
    const ik = res.doc.ik as Array<Record<string, unknown>>;
    expect(ik.find((k) => k.id === 'soft')?.stretch).toBeUndefined();
    expect(ik.find((k) => k.id === 'hard')?.stretch).toBe(true);
    const pose = load(res).rig.pose();
    const toCanvas = canvasOf(res.doc);
    // Spine: the softened target (200 >= reach 100 + softness 10) sits at full reach: straight, unstretched.
    expectClose(pose.bones.b.tip, toCanvas(100, 0), 1e-6);
    expect(pose.bones.a.local.scaleX).toBe(1);
    // Without softness, stretch reaches the target.
    expectClose(pose.bones.d.tip, toCanvas(200, -100), 1e-6);
    expect(res.report.issues.find((i) => i.code === 'spine-ik-soft-stretch')?.where).toBe('ik[0] (soft)');
  });

  it('reports two-bone IK on non-uniformly scaled chains and child joints off the axis under stretch', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'body', parent: 'root', scaleY: 2 },
          { name: 'a', parent: 'body', length: 50 },
          { name: 'b', parent: 'a', x: 50, y: 3, length: 50 },
          { name: 'c', parent: 'root', length: 50 },
          { name: 'd', parent: 'c', x: 50, length: 50 },
          { name: 't', parent: 'root', x: 60 },
        ],
        ik: [
          { name: 'squashed', bones: ['a', 'b'], target: 't', stretch: true },
          { name: 'plain', bones: ['c', 'd'], target: 't' },
        ],
        animations: { squash: { bones: { c: { scale: [{ x: 1.2, y: 0.8 }] } } }, even: { bones: { c: { scale: [{ x: 1.2, y: 1.2 }] } } } },
      },
    });
    const warnings = res.report.issues.filter((i) => i.code === 'spine-ik-nonuniform-scale');
    expect(warnings.map((i) => i.where)).toEqual(['ik[0] (squashed)', 'ik[1] (plain)']);
    expect(warnings[0].message).toMatch(/"body" is not a similarity/);
    expect(warnings[1].message).toMatch(/^animation squash scales "c"/);
    expect(res.report.issues.find((i) => i.code === 'spine-ik-child-offset')).toMatchObject({ severity: 'info', where: 'ik[0] (squashed)' });
  });

  it('bends like Spine: bendPositive puts the elbow on the counter-clockwise side', () => {
    const skeleton = (bendPositive: boolean) => ({
      skeleton: { spine: '4.2.0' },
      bones: [
        { name: 'root' },
        { name: 'a', parent: 'root', length: 50 },
        { name: 'b', parent: 'a', x: 50, length: 50 },
        { name: 't', parent: 'root', x: 60 },
      ],
      ik: [{ name: 'k', bones: ['a', 'b'], target: 't', bendPositive }],
    });
    for (const bend of [true, false]) {
      const res = importSpine({ skeleton: skeleton(bend) });
      const toCanvas = canvasOf(res.doc);
      const pose = load(res).rig.pose();
      // Law of cosines: elbow at (30, ∓40); Spine's positive bend turns the chain clockwise (elbow
      // below the root-target line in y-up space) so the child bends back counter-clockwise.
      expectClose([pose.bones.b.x, pose.bones.b.y], toCanvas(30, bend ? -40 : 40), 1e-6);
      expectClose(pose.bones.b.tip, toCanvas(60, 0), 1e-6);
    }
  });

  it('splits constraints whose softness, bend or stretch is animated into mix-driven variants', () => {
    const res = hero();
    const ik = (res.doc.ik as Array<Record<string, unknown>>).slice(1);
    const row = (id: string) => ik.filter((k) => k.id === id).map((k) => [k.id, k.mix ?? 1, k.softness, k.bendPositive, k.stretch])[0];
    // One variant per key state (setup first, fully mixed) ...
    expect(row('arm-ik')).toEqual(['arm-ik', 1, 4, true, undefined]);
    expect(row('arm-ik__s20')).toEqual(['arm-ik__s20', 0, 20, true, undefined]);
    expect(row('arm-ik__flip')).toEqual(['arm-ik__flip', 0, 4, false, undefined]);
    // ... plus in-between softness values, because the solve is not linear in softness: blending
    // only the key values would bend the elbow wrongly while softness is interpolated.
    const soft = ik.filter((k) => k.bendPositive === true).map((k) => k.softness as number);
    expect(soft).toEqual([...soft].sort((a, b) => a - b));
    expect(soft.length).toBeGreaterThan(3);
    expect(Math.max(...soft.slice(1).map((s, i) => s - soft[i]))).toBeLessThanOrEqual(4);
    expect(ik.slice(1).every((k) => k.mix === 0)).toBe(true);
    expect(res.report.issues.find((i) => i.code === 'spine-ik-variants')?.message).toMatch(new RegExp(`split into ${ik.length} variants`));
  });
});

describe('spine import: transform constraints', () => {
  it('bakes translate-only constraints between sibling bones into the setup pose', () => {
    // Offset target point moved: the constrained bone lands between itself and the target point.
    const res = importSpine({
      skeleton: {
        bones: [
          { name: 'root' },
          { name: 'p', parent: 'root', rotation: 90 },
          { name: 'b', parent: 'p', x: 10 },
          { name: 't', parent: 'p', x: 30, y: 10, rotation: 90 },
        ],
        transform: [{ name: 'c', bones: ['b'], target: 't', x: 10, mixRotate: 0, mixX: 0.5, mixScaleX: 0, mixShearY: 0 }],
      },
    });
    // Target point in p's frame: t + R(90)·(10, 0) = (30, 20); b' = (10, 0) + 0.5·((30, 20) − (10, 0)) = (20, 10).
    expect(bone(res.doc, 'b')).toMatchObject({ x: 20, y: -10 });
    expect(codes(res)).toContain('spine-transform-baked');
  });
});

describe('spine import: robustness', () => {
  const one = (attachments: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    skeleton: { spine: '4.2.0' },
    bones: [{ name: 'root' }],
    slots: [{ name: 's', bone: 'root', attachment: Object.keys(attachments)[0] }],
    skins: [{ name: 'default', attachments: { s: attachments } }],
    ...extra,
  });

  it('imports image sequences as one part per frame, showing the setup frame', () => {
    const atlas = 'p.png\n\tsize: 8, 8\nfx01\n\tbounds: 0, 0, 4, 4\nfx02\n\tbounds: 4, 0, 4, 4\n';
    const res = importSpine({
      skeleton: one({ fx: { width: 4, height: 4, path: 'fx', sequence: { count: 2, start: 1, digits: 2, setup: 1 } } }),
      atlas,
      pages: { 'p.png': makeImage(8, 8, () => [255, 255, 255, 255]) },
    });
    // Frame "02" (the setup frame) is shown, frame "01" waits at opacity 0; same quad, own region.
    expect(part(res.doc, 's__02').shape.uvs).toEqual([0.5, 0.5, 0.5, 0, 1, 0, 1, 0.5]);
    expect(part(res.doc, 's__02').opacity).toBeUndefined();
    expect(part(res.doc, 's__01').shape.uvs).toEqual([0, 0.5, 0, 0, 0.5, 0, 0.5, 0.5]);
    expect(part(res.doc, 's__01').opacity).toBe(0);
    expect(part(res.doc, 's__01').shape.vertices).toEqual(part(res.doc, 's__02').shape.vertices);
    expect(part(res.doc, 's__01').tags).toEqual(['spine-slot:s', 'spine-attachment:fx', 'spine-sequence-frame:0']);
    expect(res.report.issues.find((i) => i.code === 'spine-sequence')).toMatchObject({ severity: 'info', where: 'skins.default.s.fx' });
    expect(res.report.stats).toMatchObject({ 'attachments.region': 1, sequenceFrames: 2 });
  });

  it('skips malformed meshes, unknown attachment types and linked meshes without a parent', () => {
    const res = importSpine({
      skeleton: {
        bones: [{ name: 'root' }],
        slots: [{ name: 'a', bone: 'root' }, { name: 'b', bone: 'root' }, { name: 'c', bone: 'root' }, { name: 'd', bone: 'root' }],
        skins: [
          {
            name: 'default',
            attachments: {
              a: { m: { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 5], vertices: [0, 0, 1, 0, 0, 1] } },
              b: { w: { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], vertices: [1, 9, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1] } },
              c: { x: { type: 'hologram' } },
              d: { l: { type: 'linkedmesh', parent: 'nope' } },
            },
          },
        ],
      },
    });
    expect(res.doc.parts).toEqual([]);
    expect(codes(res).filter((c) => c === 'spine-mesh-invalid')).toHaveLength(2);
    expect(codes(res)).toContain('spine-attachment-unknown');
    expect(codes(res)).toContain('spine-linkedmesh-parent-missing');
    load(res);
  });

  it('warns about pages that look premultiplied when the atlas does not say so', () => {
    const atlas = 'p.png\n\tsize: 16, 16\nr\n\tbounds: 0, 0, 16, 16\n';
    const dark = makeImage(16, 16, () => [40, 20, 10, 100]);
    expect(codes(importSpine({ skeleton: one({ r: { width: 16, height: 16 } }), atlas, pages: { 'p.png': dark } }))).toContain('spine-page-maybe-pma');
    const straight = makeImage(16, 16, () => [250, 20, 10, 100]);
    expect(codes(importSpine({ skeleton: one({ r: { width: 16, height: 16 } }), atlas, pages: { 'p.png': straight } }))).not.toContain('spine-page-maybe-pma');
  });

  it('reports timelines of things that do not exist and unknown events', () => {
    const res = importSpine({
      skeleton: one(
        { r: { width: 4, height: 4 } },
        {
          animations: {
            a: {
              bones: { ghost: { rotate: [{ value: 1 }] } },
              slots: { ghost: { rgba: [{ color: 'ffffffff' }] }, s: { attachment: [{ name: 'missing' }] } },
              ik: { nope: [{ mix: 0 }] },
              drawOrder: [{ offsets: [{ slot: 'ghost', offset: 1 }] }],
              events: [{ time: 0.1, name: 'undeclared' }],
              wobble: {},
            },
          },
        },
      ),
    });
    const where = res.report.issues.filter((i) => i.code === 'spine-timeline-target-missing').map((i) => i.where);
    expect(where).toEqual(['animations.a.bones.ghost', 'animations.a.slots.ghost', 'animations.a.drawOrder.0', 'animations.a.ik.nope']);
    expect(codes(res)).toContain('spine-attachment-missing');
    expect(codes(res)).toContain('spine-event-unknown');
    expect(codes(res)).toContain('spine-timeline-unknown');
    load(res);
  });
});
