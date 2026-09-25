import { describe, expect, it } from 'vitest';
import { apply, fromTRS, multiply } from '../../core/math.js';
import { Rig } from '../../core/rig.js';
import { validateModel } from '../../core/validate.js';
import { applyFail, applyOk, emptyDoc, expectMatClose, find, rigDoc, setupWorlds } from './fixtures.js';

describe('add', () => {
  it('adds every kind, creating missing sections in canonical key order', () => {
    const { doc, messages } = applyOk(emptyDoc(), [
      { op: 'add', kind: 'animation', value: { id: 'idle', duration: 1, tracks: [] } },
      { op: 'add', kind: 'parameter', value: { id: 'Open', min: 0, max: 1 } },
      { op: 'add', kind: 'texture', value: { id: 'tex', path: 'a.png' } },
      { op: 'add', kind: 'bone', value: { id: 'root', x: 100, y: 200 } },
      { op: 'add', kind: 'bone', value: { id: 'tip', parent: 'root', x: 10 } },
      { op: 'add', kind: 'warp', value: { id: 'w', parent: 'root', rect: [0, 0, 100, 100] } },
      { op: 'add', kind: 'part', value: { id: 'p', parent: 'w', shape: { type: 'ellipse', cx: 50, cy: 50, rx: 10, ry: 10 } } },
      { op: 'add', kind: 'part', value: { id: 'img', shape: { type: 'image', texture: 'tex', x: 0, y: 0 } } },
      { op: 'add', kind: 'binding', value: { target: 'part:p.opacity', params: ['Open'], keys: [{ at: [0], value: 0 }, { at: [1], value: 1 }] } },
      { op: 'add', kind: 'ik', value: { id: 'aim', bones: ['tip'], target: 'root' } },
      { op: 'add', kind: 'physics', value: { id: 'ph', inputs: [{ param: 'Open', type: 'x' }], outputs: [{ param: 'Open' }] } },
    ], { textures: { tex: { width: 32, height: 16 } } });
    expect(Object.keys(doc)).toEqual(['format', 'version', 'meta', 'parameters', 'textures', 'bones', 'warps', 'parts', 'bindings', 'ik', 'physics', 'animations']);
    expect(messages[0]).toBe('added animation "idle" as /animations/0 (1 s, looping, 0 tracks)');
    expect(messages[1]).toBe('added parameter "Open" as /parameters/0 (range 0..1, default 0 implicit)');
    expect(messages[2]).toContain('32×16');
    expect(messages[3]).toBe('added bone "root" as /bones/0: root bone at (100, 200)');
    expect(messages[4]).toBe('added bone "tip" as /bones/1 under "root" at local (10, 0) (world 110, 200)');
    expect(messages[5]).toContain('under bone "root" (2×2 cells');
    expect(messages[6]).toBe('added part "p" as /parts/0 (ellipse) under warp "w"');
    expect(messages[8]).toBe('added binding part:p.opacity ← [Open] as /bindings/0 (2 keyforms)');
  });

  it('inserts at index / before / after', () => {
    const { doc } = applyOk(rigDoc(), [
      { op: 'add', kind: 'parameter', value: { id: 'A', min: 0, max: 1 }, index: 0 },
      { op: 'add', kind: 'parameter', value: { id: 'B', min: 0, max: 1 }, before: 'Bend' },
      { op: 'add', kind: 'parameter', value: { id: 'C', min: 0, max: 1 }, after: 'Bend' },
    ]);
    expect(doc.parameters.map((p: any) => p.id)).toEqual(['A', 'AngleX', 'AngleY', 'B', 'Bend', 'C', 'Sway']);
  });

  it('converts "world" to local under a rotated and scaled parent chain', () => {
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'add', kind: 'bone', value: { id: 'finger', parent: 'hand', world: [123, 45], length: 5 } }]);
    const finger = find(doc, 'bones', 'finger');
    expect(Object.keys(finger)).toEqual(['id', 'parent', 'x', 'y', 'length']);
    const world = setupWorlds(doc).finger;
    expect(world[4]).toBeCloseTo(123, 4);
    expect(world[5]).toBeCloseTo(45, 4);
    expect(messages[0]).toMatch(/^added bone "finger" as \/bones\/5 under "hand" at local \(-?[\d.]+, -?[\d.]+\) \(world 123, 45\)$/);
  });

  it('converts "world" for root bones as-is', () => {
    const { doc } = applyOk(emptyDoc(), [{ op: 'add', kind: 'bone', value: { id: 'r', world: [10, 20] } }]);
    expect(doc.bones[0]).toEqual({ id: 'r', x: 10, y: 20 });
  });

  it('rejects duplicates, bad ids, shared bone/warp ids and schema errors with hints', () => {
    let r = applyFail(rigDoc(), [{ op: 'add', kind: 'bone', value: { id: 'hand' } }]);
    expect(r.message).toBe('bone "hand" already exists (/bones/3)');
    expect(r.hint).toContain('"hand2"');
    r = applyFail(rigDoc(), [{ op: 'add', kind: 'warp', value: { id: 'hand', rect: [0, 0, 1, 1] } }]);
    expect(r.message).toBe('"hand" is already used by bone /bones/3');
    expect(r.hint).toContain('share one id namespace');
    r = applyFail(rigDoc(), [{ op: 'add', kind: 'parameter', value: { id: '1st', min: 0, max: 1 } }]);
    expect(r.message).toContain('invalid parameter id "1st"');
    r = applyFail(rigDoc(), [{ op: 'add', kind: 'bone', value: { id: 'b', rotate: 5 } }]);
    expect(r.message).toContain('/bones/5');
    expect(r.hint).toContain('rotation');
    r = applyFail(rigDoc(), [{ op: 'add', kind: 'bones', value: { id: 'b' } }]);
    expect(r.message).toBe('add: unknown kind "bones"');
    expect(r.hint).toContain('did you mean "bone"?');
    r = applyFail(rigDoc(), [{ op: 'add', kind: 'bone', value: { id: 'b', parent: 'nope', world: [0, 0] } }]);
    expect(r.message).toBe('unknown parent bone "nope"');
    r = applyFail(rigDoc(), [{ op: 'add', kind: 'bone', value: { id: 'b', world: [0, 0], x: 1 } }]);
    expect(r.message).toContain('either "world" or local "x"/"y"');
    r = applyFail(rigDoc(), [{ op: 'add', kind: 'meta', value: {} }]);
    expect(r.hint).toContain('patch');
    r = applyFail(rigDoc(), [{ op: 'add', kind: 'bone', value: { id: 'b' }, before: 'nope' }]);
    expect(r.message).toContain('unknown bone "nope" in "before"');
    r = applyFail(rigDoc(), [{ op: 'add', kind: 'bone', value: { x: 1 } }]);
    expect(r.message).toBe('add: the bone in "value" has no "id"');
    expect(r.hint).toContain('e.g. "leftArm"');
  });
});

/** Setup-space rotation of a bone's +x axis, from the core rig compiler. */
function worldRotationOf(doc: unknown, id: string): number {
  const m = setupWorlds(doc)[id];
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
}

/** Same angle modulo 360. */
function expectAngle(actual: number, expected: number): void {
  const d = ((((actual - expected) % 360) + 540) % 360) - 180;
  expect(Math.abs(d)).toBeLessThan(1e-6);
}

describe('worldRotation', () => {
  it('add: converts a setup-space rotation under rotated + scaled parents', () => {
    // fore: world rotation -90 + 30 = -60, uniform scale 1.5.
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'add', kind: 'bone', value: { id: 'finger', parent: 'fore', world: [100, 100], worldRotation: 45, length: 10 } }]);
    expect(find(doc, 'bones', 'finger')).toEqual({ id: 'finger', parent: 'fore', x: 18.628191, y: -87.735027, rotation: 105, length: 10 });
    expectAngle(worldRotationOf(doc, 'finger'), 45);
    expect(messages[0]).toBe('added bone "finger" as /bones/5 under "fore" at local (18.628, -87.735) (world 100, 100), rotation 105 (world rotation 45)');
  });

  it('add: handles mirrored parents, negative own scaleX and non-uniform parent scale', () => {
    for (const [parent, value] of [
      [{ id: 'mirror', x: 50, y: 50, rotation: 20, scaleX: -1 }, { id: 'b', parent: 'mirror', worldRotation: 30 }],
      [{ id: 'mirror', x: 50, y: 50, rotation: -70, scaleY: -2 }, { id: 'b', parent: 'mirror', worldRotation: -150, scaleX: -1 }],
      [{ id: 'mirror', x: 50, y: 50, rotation: 35, scaleX: 3, scaleY: 0.5 }, { id: 'b', parent: 'mirror', worldRotation: 80 }],
    ] as const) {
      const { doc } = applyOk(rigDoc(), [
        { op: 'add', kind: 'bone', value: { ...parent } },
        { op: 'add', kind: 'bone', value: { ...value } },
      ]);
      expectAngle(worldRotationOf(doc, 'b'), value.worldRotation);
    }
  });

  it('update: converts in the (new) parent frame and reports the local change', () => {
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hand', set: { worldRotation: 0 } }]);
    expect(find(doc, 'bones', 'hand').rotation).toBe(60);
    expectAngle(worldRotationOf(doc, 'hand'), 0);
    expect(messages[0]).toBe('updated bone "hand": rotation 0 → 60 (world rotation 0)');
    const moved = applyOk(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hand', set: { parent: 'upper', worldRotation: 10 } }]).doc;
    expectAngle(worldRotationOf(moved, 'hand'), 10);
    const same = applyOk(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hand', set: { worldRotation: -60 } }]);
    expect(same.messages[0]).toBe('updated bone "hand": unchanged (worldRotation already had that value)');
  });

  it('rejects worldRotation together with rotation, with keepWorld, on other kinds, and non-numbers', () => {
    let r = applyFail(rigDoc(), [{ op: 'add', kind: 'bone', value: { id: 'b', worldRotation: 10, rotation: 5 } }]);
    expect(r.message).toBe('add bone: give either "worldRotation" or local "rotation", not both');
    r = applyFail(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hand', set: { worldRotation: 10, rotation: 5 } }]);
    expect(r.message).toBe('update bone: give either "worldRotation" or "rotation", not both');
    r = applyFail(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hand', set: { parent: 'root', worldRotation: 5 }, keepWorld: true }]);
    expect(r.message).toContain('so "worldRotation" cannot be set in the same update');
    r = applyFail(rigDoc(), [{ op: 'update', kind: 'part', id: 'head', set: { worldRotation: 5 } }]);
    expect(r.message).toBe('update: "worldRotation" is only for bones');
    r = applyFail(rigDoc(), [{ op: 'add', kind: 'bone', value: { id: 'b', worldRotation: '90' } }]);
    expect(r.message).toBe('add bone: "worldRotation" must be a number of degrees (setup space, clockwise), got string "90"');
  });
});

describe('update messages', () => {
  it('list only changed fields and name the unchanged ones', () => {
    const { messages } = applyOk(rigDoc(), [{ op: 'update', kind: 'part', id: 'head', set: { 'shape.rx': 40, 'shape.ry': 50, z: 1, fill: '#ffcc99' } }]);
    expect(messages[0]).toBe('updated part "head": shape.ry 45 → 50; unchanged: shape.rx, z, fill');
  });

  it('say "unchanged" when nothing changed (including deleting an unset field)', () => {
    const { messages } = applyOk(rigDoc(), [{ op: 'update', kind: 'part', id: 'head', set: { z: 1, description: null } }]);
    expect(messages[0]).toBe('updated part "head": unchanged (z, description already had those values)');
  });

  it('summarize long arrays by what changed in them', () => {
    const doc = rigDoc();
    doc.animations[0].tracks.push(
      { target: 'part:head.shape.rx', keys: Array.from({ length: 21 }, (_, i) => ({ t: i / 10, v: 40 + i })) },
      { target: 'part:head.shape.ry', keys: [{ t: 0, v: 45 }] },
      { target: 'part:head.opacity', keys: [{ t: 0, v: 1 }] },
    );
    const next = structuredClone(doc.animations[0].tracks);
    next[3].keys[20].v = 0;
    const { messages } = applyOk(doc, [{ op: 'update', kind: 'animation', id: 'wave', set: { tracks: next } }]);
    expect(messages[0]).toBe('updated animation "wave": tracks: 1 of 6 changed (part:head.shape.rx, 21 keys)');
    next.splice(5, 1, { target: 'bone:root.x', keys: [{ t: 0, v: 1 }, { t: 1, v: 2 }] });
    const swapped = applyOk(doc, [{ op: 'update', kind: 'animation', id: 'wave', set: { tracks: next } }]);
    expect(swapped.messages[0]).toBe(
      'updated animation "wave": tracks: 1 of 6 changed (part:head.shape.rx, 21 keys) + 1 added (bone:root.x, 2 keys) + 1 removed (part:head.opacity, 1 key)',
    );
  });

  it('summarize long number lists by changed indexes and whole objects by changed fields', () => {
    const doc = rigDoc();
    find(doc, 'parts', 'mouth').shape.points = Array.from({ length: 40 }, (_, i) => 100 + i);
    const points = Array.from({ length: 40 }, (_, i) => 100 + i);
    points[6] = 0;
    points[7] = 1;
    const { messages } = applyOk(doc, [
      { op: 'update', kind: 'part', id: 'mouth', set: { 'shape.points': points } },
      { op: 'update', kind: 'part', id: 'head', set: { shape: { type: 'ellipse', cx: 200, cy: 150, rx: 20, ry: 45, rotation: 5, detail: 4 } } },
    ]);
    expect(messages[0]).toBe('updated part "mouth": shape.points: 2 of 40 values changed (indexes 6, 7)');
    expect(messages[1]).toBe('updated part "head": shape.rx 40 → 20, shape.rotation (unset) → 5, shape.detail (unset) → 4');
  });
});

describe('update', () => {
  it('sets dotted paths, deletes with null and keeps key order', () => {
    const { doc, messages } = applyOk(rigDoc(), [
      { op: 'update', kind: 'part', id: 'head', set: { 'shape.rx': 20, 'stroke.width': 3, 'stroke.color': '#000000', z: null, opacity: 0.5 } },
    ]);
    const head = find(doc, 'parts', 'head');
    expect(Object.keys(head)).toEqual(['id', 'parent', 'shape', 'fill', 'stroke', 'opacity']);
    expect(head.shape.rx).toBe(20);
    expect(head.stroke).toEqual({ width: 3, color: '#000000' });
    expect(messages[0]).toBe('updated part "head": shape.rx 40 → 20, stroke.width (unset) → 3, stroke.color (unset) → "#000000", z deleted (was 1), opacity (unset) → 0.5; note: binding part:head.opacity ← [AngleY] sets absolute values, so this setup value does not show while it exists (change the look with "bind")');
  });

  it('updates array elements by index', () => {
    const { doc } = applyOk(rigDoc(), [{ op: 'update', kind: 'warp', id: 'face', set: { 'rect.2': 120 } }]);
    expect(find(doc, 'warps', 'face').rect).toEqual([150, 100, 120, 100]);
  });

  it('bone "world" is converted in the (new) parent frame', () => {
    const { doc } = applyOk(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hand', set: { parent: 'upper', world: [250, 150] } }]);
    const w = setupWorlds(doc).hand;
    expect(find(doc, 'bones', 'hand').parent).toBe('upper');
    expect(w[4]).toBeCloseTo(250, 4);
    expect(w[5]).toBeCloseTo(150, 4);
  });

  it('keepWorld reparents a bone without moving it and remaps its keyforms', () => {
    const before = setupWorlds(rigDoc());
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hand', set: { parent: 'root' }, keepWorld: true }]);
    expectMatClose(setupWorlds(doc).hand, before.hand);
    expect(messages[0]).toContain('kept the setup world pose');
    // fore (30°) · upper (-90°) = -60° of extra rotation now lives in the hand's local rotation.
    const hand = find(doc, 'bones', 'hand');
    expect(hand.rotation).toBeCloseTo(-60, 6);
    expect(find(doc, 'bindings', 'handTurn').keys.map((k: any) => k.value)).toEqual([-80, -40]);
  });

  it('rejects ids, cycles and unknown items with hints', () => {
    let r = applyFail(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hand', set: { id: 'h' } }]);
    expect(r.hint).toContain('"op": "rename"');
    r = applyFail(rigDoc(), [{ op: 'update', kind: 'bone', id: 'upper', set: { parent: 'hand' } }]);
    expect(r.message).toContain('would create a cycle');
    r = applyFail(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hnd', set: { x: 1 } }]);
    expect(r.message).toBe('unknown bone "hnd"');
    expect(r.hint).toBe('did you mean "hand"?');
    r = applyFail(rigDoc(), [{ op: 'update', kind: 'part', id: 'head', set: { opacity: 2 } }]);
    expect(r.message).toContain('/parts/1/opacity');
    r = applyFail(rigDoc(), [{ op: 'update', kind: 'part', id: 'head', set: { 'fill.color': 'red' } }]);
    expect(r.message).toContain('cannot set "fill.color" because "fill" is string');
    r = applyFail(rigDoc(), [{ op: 'update', kind: 'part', id: 'head', set: {}, keepWorld: true }]);
    expect(r.message).toBe('update: "set" is empty');
  });

  it('says where a bone reparented without keepWorld moves to', () => {
    const { messages } = applyOk(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hand', set: { parent: 'root' } }]);
    expect(messages[0]).toBe(
      'updated bone "hand": parent "fore" → "root" (its local transform is kept, so its joint moves from world (230, 138.038) to (240, 300); "keepWorld": true keeps it in place)',
    );
    // Nothing to say when the joint stays put.
    const same = applyOk(rigDoc(), [{ op: 'update', kind: 'bone', id: 'target', set: { parent: null, x: 280, y: 180 } }]);
    expect(same.messages[0]).toBe('updated bone "target": parent deleted (was "root"), x 80 → 280, y -120 → 180');
  });

  it('keepWorld refuses explicit transform fields in the same update (the remapped keyforms would not match them)', () => {
    for (const set of [{ parent: 'root', rotation: 0 }, { parent: 'root', world: [10, 10] }, { parent: 'root', x: 1 }]) {
      const r = applyFail(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hand', set, keepWorld: true }]);
      expect(r.message).toMatch(/^update: "keepWorld" recomputes x, y, rotation, scaleX and scaleY, so "(rotation|world|x)" cannot be set in the same update$/);
      expect(r.hint).toBe(
        'reparent first: {"op": "update", "kind": "bone", "id": "hand", "set": {"parent": "root"}, "keepWorld": true}, then change the transform in a second op',
      );
    }
  });

  it('names warps given as bone parents instead of guessing a similar bone', () => {
    let r = applyFail(rigDoc(), [{ op: 'update', kind: 'bone', id: 'hand', set: { parent: 'face' }, keepWorld: true }]);
    expect(r.message).toBe('"face" is a warp, but a bone\'s parent must be a bone');
    expect(r.hint).toContain('known bones: "root", "upper", "fore", "hand", "target"');
    r = applyFail(rigDoc(), [{ op: 'add', kind: 'bone', value: { id: 'b', parent: 'face', world: [0, 0] } }]);
    expect(r.message).toBe('"face" is a warp, but a bone\'s parent must be a bone');
  });

  it('refuses world conversions under a parent with zero setup scale', () => {
    const doc = rigDoc();
    find(doc, 'bones', 'fore').scaleY = 0;
    let r = applyFail(doc, [{ op: 'add', kind: 'bone', value: { id: 'b', parent: 'hand', world: [0, 0] } }]);
    expect(r.message).toBe('cannot convert a world position into the frame of bone "hand": its setup world transform has zero scale (collapsed by bone "fore")');
    expect(r.hint).toContain('give local "x"/"y"');
    r = applyFail(doc, [{ op: 'update', kind: 'bone', id: 'target', set: { parent: 'hand' }, keepWorld: true }]);
    expect(r.message).toContain('its setup world transform has zero scale');
  });

  it('keeps a mirrored bone mirrored when its frame only moves', () => {
    const doc = rigDoc();
    Object.assign(find(doc, 'bones', 'upper'), { scaleX: -1 });
    const { doc: out } = applyOk(doc, [{ op: 'remove', kind: 'bone', id: 'root', cascade: true }]);
    expect(find(out, 'bones', 'upper')).toEqual({ id: 'upper', x: 200, y: 250, rotation: -90, scaleX: -1, length: 60 });
    expectMatClose(setupWorlds(out).hand, setupWorlds(doc).hand);
  });

  it('remaps a scaleX flip keyform exactly (a flip stays a flip)', () => {
    const doc = rigDoc();
    doc.bindings.push({ target: 'bone:target.scaleX', params: ['Bend'], keys: [{ at: [0], value: 1 }, { at: [1], value: -1 }] });
    const { doc: out, messages } = applyOk(doc, [{ op: 'remove', kind: 'bone', id: 'root', cascade: true }]);
    expect(out.bindings.find((b: any) => b.target === 'bone:target.scaleX').keys.map((k: any) => k.value)).toEqual([1, -1]);
    expect(messages[0]).not.toContain('WARNING');
  });

  it('rejects "__proto__" field paths (they would change the prototype, not the model)', () => {
    const r = applyFail(rigDoc(), [{ op: 'update', kind: 'part', id: 'body', set: JSON.parse('{"__proto__": {"z": 1}}') }]);
    expect(r.message).toBe('update: invalid field path "__proto__"');
    const deep = applyFail(rigDoc(), [{ op: 'update', kind: 'part', id: 'body', set: { 'shape.__proto__.x': 1 } }]);
    expect(deep.message).toBe('update: invalid field path "shape.__proto__.x"');
  });

  it('gives an id-less binding an id (ids of items that have one change only with rename)', () => {
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'update', kind: 'binding', target: 'part:head.opacity', set: { id: 'headFade' } }]);
    expect(doc.bindings[5]).toEqual({ id: 'headFade', target: 'part:head.opacity', params: ['AngleY'], keys: [{ at: [-30], value: 1 }, { at: [30], value: 0.8 }] });
    expect(messages[0]).toBe('updated binding part:head.opacity ← [AngleY]: id (unset) → "headFade"');
    const r = applyFail(rigDoc(), [{ op: 'update', kind: 'binding', target: 'part:head.opacity', set: { id: 'handTurn' } }]);
    expect(r.message).toBe('binding "handTurn" already exists (/bindings/3)');
  });

  it('selects bindings by target (+ params)', () => {
    const { doc } = applyOk(rigDoc(), [{ op: 'update', kind: 'binding', target: 'bone:fore.rotation', set: { interpolation: 'step' } }]);
    expect(doc.bindings[0].interpolation).toBe('step');
    const r = applyFail(rigDoc(), [{ op: 'update', kind: 'binding', target: 'bone:hand.x', set: { interpolation: 'step' } }]);
    expect(r.message).toContain('no binding targets "bone:hand.x"');
  });
});

describe('remove', () => {
  it('refuses when referenced and lists every reference as a JSON pointer', () => {
    const r = applyFail(rigDoc(), [{ op: 'remove', kind: 'bone', id: 'fore' }]);
    expect(r.message).toBe(
      'cannot remove bone "fore": it is referenced 5 times: /bones/3/parent, /parts/3/skin/bones/1, /bindings/0/target, /ik/0/bones/1, /animations/0/tracks/0/target',
    );
    expect(r.hint).toContain('"cascade": true');
  });

  it('removes unreferenced items directly', () => {
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'remove', kind: 'animation', id: 'wave' }]);
    expect(doc.animations).toEqual([]);
    expect(messages[0]).toBe('removed animation "wave" (was /animations/0)');
  });

  it('cascades a bone: world-preserving reparent, skins, bindings, tracks, IK', () => {
    const before = setupWorlds(rigDoc());
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'remove', kind: 'bone', id: 'fore', cascade: true }]);
    const worlds = setupWorlds(doc);
    expectMatClose(worlds.hand, before.hand);
    const hand = find(doc, 'bones', 'hand');
    expect(hand.parent).toBe('upper');
    expect(hand.rotation).toBeCloseTo(30, 6);
    expect(hand.scaleX).toBeCloseTo(1.5, 6);
    // Keyforms on the hand's rotation keep their deltas from setup (+30° like the setup).
    expect(find(doc, 'bindings', 'handTurn').keys.map((k: any) => k.value)).toEqual([10, 50]);
    const wave = find(doc, 'animations', 'wave');
    expect(wave.tracks.map((t: any) => t.target)).toEqual(['param:AngleX', 'bone:hand.rotation']);
    expect(wave.tracks[1].keys.map((k: any) => k.v)).toEqual([30, 75]);
    expect(find(doc, 'parts', 'sleeve').skin).toEqual({ bones: ['upper'] });
    expect(doc.ik).toEqual([]);
    expect(doc.bindings.map((b: any) => b.target)).not.toContain('ik:armIk.mix');
    expect(doc.bindings.map((b: any) => b.target)).not.toContain('bone:fore.rotation');
    const msg = messages[0];
    expect(msg).toMatch(/^removed bone "fore" \(was \/bones\/2\); cascade: /);
    expect(msg).toContain('reparented bone "hand" to "upper" keeping its setup world pose');
    expect(msg).toContain('remapped 4 keyform values of bone:hand.rotation');
    expect(msg).toContain('removed "fore" from part "sleeve" skin');
    expect(msg).toContain('removed binding bone:fore.rotation ← [Bend] (it targets "fore")');
    expect(msg).toContain('removed ik constraint "armIk" (it uses bone "fore")');
    expect(msg).toContain('removed binding ik:armIk.mix ← [Bend] (it targets "armIk")');
    expect(msg).toContain('removed track bone:fore.rotation from animation "wave"');
  });

  it('cascades a root bone: children become roots in place, parts go to model space', () => {
    const before = setupWorlds(rigDoc());
    const { doc } = applyOk(rigDoc(), [{ op: 'remove', kind: 'bone', id: 'root', cascade: true }]);
    const worlds = setupWorlds(doc);
    for (const id of ['upper', 'fore', 'hand', 'target']) expectMatClose(worlds[id], before[id]);
    expect(find(doc, 'bones', 'upper')).toEqual({ id: 'upper', x: 200, y: 250, rotation: -90, length: 60 });
    expect(find(doc, 'parts', 'body').parent).toBeUndefined();
    expect(find(doc, 'parts', 'cloth').parent).toBeUndefined();
  });

  it('flags keyforms that cannot be remapped exactly', () => {
    const doc = rigDoc();
    find(doc, 'bones', 'fore').scaleY = 1; // non-uniform scale: rotating the hand now shears
    const { messages } = applyOk(doc, [{ op: 'remove', kind: 'bone', id: 'fore', cascade: true }]);
    expect(messages[0]).toContain('WARNING: bone:hand.rotation could only be remapped approximately');
  });

  it('cascades a skin whose only bone goes: the part follows the removed bone\'s parent', () => {
    const doc = rigDoc();
    find(doc, 'parts', 'sleeve').skin = { bones: ['hand'], weights: 'auto' };
    const { doc: out, messages } = applyOk(doc, [{ op: 'remove', kind: 'bone', id: 'hand', cascade: true }]);
    const sleeve = find(out, 'parts', 'sleeve');
    expect(sleeve.skin).toBeUndefined();
    expect(sleeve.parent).toBe('fore');
    expect(Object.keys(sleeve)).toEqual(['id', 'parent', 'shape', 'fill']);
    expect(messages[0]).toContain('deleted part "sleeve" skin (no bones left); it now follows "fore"');
  });

  it('drops a removed bone\'s column from explicit skin weights', () => {
    const doc = rigDoc();
    const sleeve = find(doc, 'parts', 'sleeve');
    sleeve.shape = { type: 'mesh', vertices: [190, 150, 210, 150, 200, 230], triangles: [0, 1, 2] };
    sleeve.skin = { bones: ['upper', 'fore'], weights: [[1, 0], [0.5, 0.5], [0, 1]] };
    const { doc: out } = applyOk(doc, [{ op: 'remove', kind: 'bone', id: 'upper', cascade: true }]);
    expect(find(out, 'parts', 'sleeve').skin).toEqual({ bones: ['fore'], weights: [[0], [0.5], [1]] });
  });

  it('cascades a warp: children move to its parent, its bindings go', () => {
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'remove', kind: 'warp', id: 'face', cascade: true }]);
    expect(find(doc, 'warps', 'mouthWarp').parent).toBe('upper');
    expect(find(doc, 'parts', 'head').parent).toBe('upper');
    expect(doc.bindings.map((b: any) => b.target)).not.toContain('warp:face.offsets');
    expect(messages[0]).toContain('reparented warp "mouthWarp" to "upper"');
  });

  it('cascades a part: masks and bindings', () => {
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'remove', kind: 'part', id: 'head', cascade: true }]);
    const mouth = find(doc, 'parts', 'mouth');
    expect(mouth.mask).toBeUndefined();
    expect(messages[0]).toContain('deleted part "mouth" mask (it only listed "head")');
    expect(doc.bindings.map((b: any) => b.target)).not.toContain('part:head.opacity');
  });

  it('cascades a parameter: slices multi-parameter bindings at its default', () => {
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'remove', kind: 'parameter', id: 'AngleY', cascade: true }]);
    const face = doc.bindings.find((b: any) => b.target === 'warp:face.offsets');
    expect(face.params).toEqual(['AngleX']);
    expect(face.keys).toEqual([
      { at: [-30], value: { '4': [-10, 0] } },
      { at: [30], value: { '4': [10, 0] } },
    ]);
    expect(doc.bindings.map((b: any) => b.target)).not.toContain('part:head.opacity');
    expect(messages[0]).toContain('dropped parameter "AngleY" from binding warp:face.offsets ← [AngleX, AngleY] (kept the 2 keyforms at AngleY = 0, its default)');
  });

  it('cascades a parameter used by physics and tracks', () => {
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'remove', kind: 'parameter', id: 'AngleX', cascade: true }]);
    expect(doc.physics).toEqual([]);
    expect(find(doc, 'animations', 'wave').tracks.map((t: any) => t.target)).not.toContain('param:AngleX');
    expect(messages[0]).toContain('removed physics group "hair" (its only input was "AngleX")');
  });

  it('interpolates multi-parameter keyforms at the default when it falls between grid values', () => {
    // AngleX's grid is {-30, 30}; at its default 0 the rig blends both columns 50/50. Slicing at
    // either column would leave the face turned for good.
    const input = rigDoc();
    input.bindings[1].keys.reverse(); // key order must not matter
    const { doc, messages } = applyOk(input, [{ op: 'remove', kind: 'parameter', id: 'AngleX', cascade: true }]);
    const face = doc.bindings.find((b: any) => b.target === 'warp:face.offsets');
    expect(face.params).toEqual(['AngleY']);
    expect(face.keys).toEqual([
      { at: [30], value: { '4': [0, 10] } },
      { at: [0], value: { '4': [0, 0] } },
      { at: [-30], value: { '4': [0, -10] } },
    ]);
    expect(messages[0]).toContain(
      'dropped parameter "AngleX" from binding warp:face.offsets ← [AngleX, AngleY] (3 keyforms interpolated at AngleX = 0, its default, between the -30 and 30 keyforms)',
    );
    // The rig at AngleX = default looks exactly like the new rig without AngleX.
    for (const angleY of [-30, -12, 0, 17, 30]) {
      const before = new Rig(validateModel(rigDoc()).model!).pose({ params: { AngleY: angleY } }).warps.face.points;
      const after = new Rig(validateModel(doc).model!).pose({ params: { AngleY: angleY } }).warps.face.points;
      Array.from(after).forEach((v, i) => expect(v).toBeCloseTo(before[i], 5));
    }
  });

  it('interpolates numbers, colours and full point lists; step bindings and clamped defaults keep one slice', () => {
    const doc = rigDoc();
    doc.parameters.push({ id: 'Mood', min: 0, max: 1, default: 0.25 });
    doc.bindings.push(
      {
        target: 'bone:hand.x',
        params: ['Mood', 'Bend'],
        keys: [{ at: [0, 0], value: 40 }, { at: [1, 0], value: 80 }, { at: [0, 1], value: 0 }, { at: [1, 1], value: 100 }],
      },
      { target: 'part:head.tint', params: ['Bend', 'Mood'], keys: [{ at: [0, 0], value: '#000000' }, { at: [0, 1], value: '#ffffff' }, { at: [1, 0], value: '#ff0000' }, { at: [1, 1], value: '#ff0000' }] },
      {
        target: 'part:mouth.shape.points',
        params: ['Mood', 'Bend'],
        keys: [
          { at: [0, 0], value: [185, 170, 215, 170, 200, 178] },
          { at: [1, 0], value: { '2': [200, 190] } },
          { at: [0, 1], value: { '0': [180, 170] } },
          { at: [1, 1], value: { '0': [180, 170] } },
        ],
      },
      { target: 'part:body.opacity', params: ['Mood', 'Bend'], interpolation: 'step', keys: [{ at: [0, 0], value: 0.5 }, { at: [1, 0], value: 1 }, { at: [0, 1], value: 0.5 }, { at: [1, 1], value: 1 }] },
      { target: 'bone:root.x', params: ['Mood', 'Bend'], keys: [{ at: [0.5, 0], value: 210 }, { at: [1, 0], value: 220 }, { at: [0.5, 1], value: 230 }, { at: [1, 1], value: 240 }] },
    );
    const { doc: out, messages } = applyOk(doc, [{ op: 'remove', kind: 'parameter', id: 'Mood', cascade: true }]);
    const binding = (target: string) => out.bindings.find((b: any) => b.target === target && b.params.includes('Bend'));
    expect(binding('bone:hand.x').keys).toEqual([{ at: [0], value: 50 }, { at: [1], value: 25 }]);
    expect(binding('part:head.tint').keys).toEqual([{ at: [0], value: '#404040' }, { at: [1], value: '#ff0000' }]);
    expect(binding('part:mouth.shape.points').keys).toEqual([
      { at: [0], value: [185, 170, 215, 170, 200, 181] },
      { at: [1], value: { '0': [180, 170] } },
    ]);
    // Step bindings hold the lower grid value; a default below the grid clamps to its first value.
    expect(binding('part:body.opacity').keys).toEqual([{ at: [0], value: 0.5 }, { at: [1], value: 0.5 }]);
    expect(binding('bone:root.x').keys).toEqual([{ at: [0], value: 210 }, { at: [1], value: 230 }]);
    expect(messages[0]).toContain('(kept the 2 keyforms at Mood = 0, which the rig used at its default 0.25)');
    expect(messages[0]).toContain('(kept the 2 keyforms at Mood = 0.5, which the rig used at its default 0.25)');
  });

  it('interpolates path and boolean keyforms', () => {
    const doc = rigDoc();
    doc.parameters.push({ id: 'Mood', min: 0, max: 1, default: 0.75 });
    find(doc, 'parts', 'body').shape = { type: 'path', d: 'M0 0 L10 0 L5 5 Z' };
    doc.bindings.push(
      { target: 'part:body.shape.d', params: ['Bend', 'Mood'], keys: [{ at: [0, 0], value: 'M0 0 L10 0 L5 5 Z' }, { at: [0, 1], value: 'M0 0 L10 0 L5 9 Z' }] },
      { target: 'part:head.visible', params: ['Bend', 'Mood'], keys: [{ at: [0, 0], value: false }, { at: [0, 1], value: true }] },
    );
    const { doc: out } = applyOk(doc, [{ op: 'remove', kind: 'parameter', id: 'Mood', cascade: true }]);
    expect(out.bindings.find((b: any) => b.target === 'part:body.shape.d').keys).toEqual([{ at: [0], value: 'M0 0 L10 0 L5 8 Z' }]);
    expect(out.bindings.find((b: any) => b.target === 'part:head.visible').keys).toEqual([{ at: [0], value: true }]);
  });

  it('warns when a removed single-parameter binding was not at the setup value at the default', () => {
    const doc = rigDoc();
    doc.parameters.push({ id: 'Glow', min: 0, max: 1, default: 0.4 });
    doc.bindings.push(
      { target: 'part:body.opacity', params: ['Glow'], keys: [{ at: [0], value: 0.25 }, { at: [1], value: 1 }] },
      { target: 'part:head.shape.rx', params: ['Glow'], keys: [{ at: [0.4], value: 40 }, { at: [1], value: 50 }] },
    );
    const { messages } = applyOk(doc, [{ op: 'remove', kind: 'parameter', id: 'Glow', cascade: true }]);
    expect(messages[0]).toContain(
      'removed binding part:body.opacity ← [Glow] (it is driven by "Glow"; WARNING: at its default (Glow = 0.4) it held part:body.opacity at 0.55 instead of the setup value 1, so the rest pose changes; to keep it: {"op": "set", "target": "part:body.opacity", "value": 0.55})',
    );
    // At the default this binding equals the setup value: nothing changes, no warning.
    expect(messages[0]).toContain('removed binding part:head.shape.rx ← [Glow] (it is driven by "Glow")');
  });

  it('cascades a texture: image parts removed, meshes untextured', () => {
    let { doc, messages } = applyOk(rigDoc(), [{ op: 'remove', kind: 'texture', id: 'tex', cascade: true }]);
    expect(doc.parts.map((p: any) => p.id)).not.toContain('photo');
    expect(messages[0]).toContain('removed part "photo" (its image uses texture "tex")');
    ({ doc } = applyOk(rigDoc(), [{ op: 'remove', kind: 'texture', id: 'clothTex', cascade: true }]));
    expect(find(doc, 'parts', 'cloth').shape).toEqual({ type: 'mesh', vertices: [0, 0, 10, 0, 0, 10], triangles: [0, 1, 2] });
  });

  it('removes id-less bindings selected by target', () => {
    const { doc } = applyOk(rigDoc(), [{ op: 'remove', kind: 'binding', target: 'part:head.opacity' }]);
    expect(doc.bindings).toHaveLength(5);
  });
});

describe('rename', () => {
  it('updates every reference to a bone', () => {
    const { doc, messages } = applyOk(rigDoc(), [
      { op: 'rename', kind: 'bone', from: 'fore', to: 'forearm' },
      { op: 'rename', kind: 'bone', from: 'upper', to: 'upperArm' },
      { op: 'rename', kind: 'bone', from: 'target', to: 'goal' },
    ]);
    expect(find(doc, 'bones', 'hand').parent).toBe('forearm');
    expect(find(doc, 'bones', 'forearm').parent).toBe('upperArm');
    expect(find(doc, 'warps', 'face').parent).toBe('upperArm');
    expect(find(doc, 'parts', 'sleeve').skin.bones).toEqual(['upperArm', 'forearm']);
    expect(doc.bindings[0].target).toBe('bone:forearm.rotation');
    expect(doc.ik[0]).toEqual({ id: 'armIk', bones: ['upperArm', 'forearm'], target: 'goal', mix: 1 });
    expect(doc.animations[0].tracks[0].target).toBe('bone:forearm.rotation');
    expect(messages[0]).toBe(
      'renamed bone "fore" → "forearm"; updated 5 references: /bones/3/parent, /parts/3/skin/bones/1, /bindings/0/target, /ik/0/bones/1, /animations/0/tracks/0/target',
    );
  });

  it('updates parameter references in bindings, tracks and physics', () => {
    const { doc } = applyOk(rigDoc(), [
      { op: 'rename', kind: 'parameter', from: 'AngleX', to: 'HeadX' },
      { op: 'rename', kind: 'parameter', from: 'Sway', to: 'HairSway' },
    ]);
    expect(doc.bindings[1].params).toEqual(['HeadX', 'AngleY']);
    expect(doc.bindings[2].params).toEqual(['HeadX']);
    expect(doc.bindings[3].params).toEqual(['HairSway']);
    expect(doc.animations[0].tracks[1].target).toBe('param:HeadX');
    expect(doc.physics[0].inputs[0].param).toBe('HeadX');
    expect(doc.physics[0].outputs[0].param).toBe('HairSway');
  });

  it('updates texture, part, warp and ik references', () => {
    const { doc } = applyOk(rigDoc(), [
      { op: 'rename', kind: 'texture', from: 'tex', to: 'photoTex' },
      { op: 'rename', kind: 'texture', from: 'clothTex', to: 'fabric' },
      { op: 'rename', kind: 'part', from: 'head', to: 'skull' },
      { op: 'rename', kind: 'warp', from: 'face', to: 'faceWarp' },
      { op: 'rename', kind: 'warp', from: 'mouthWarp', to: 'lips' },
      { op: 'rename', kind: 'ik', from: 'armIk', to: 'arm' },
      { op: 'rename', kind: 'binding', from: 'handTurn', to: 'handSway' },
      { op: 'rename', kind: 'animation', from: 'wave', to: 'greet' },
    ]);
    expect(find(doc, 'parts', 'photo').shape.texture).toBe('photoTex');
    expect(find(doc, 'parts', 'cloth').shape.texture).toBe('fabric');
    expect(find(doc, 'parts', 'mouth').mask).toEqual(['skull']);
    expect(find(doc, 'parts', 'mouth').parent).toBe('lips');
    expect(find(doc, 'parts', 'skull').parent).toBe('faceWarp');
    expect(find(doc, 'warps', 'lips').parent).toBe('faceWarp');
    expect(doc.bindings.map((b: any) => b.target)).toEqual([
      'bone:fore.rotation',
      'warp:faceWarp.offsets',
      'part:mouth.shape.points',
      'bone:hand.rotation',
      'ik:arm.mix',
      'part:skull.opacity',
    ]);
    expect(doc.bindings[3].id).toBe('handSway');
    expect(doc.animations[0].id).toBe('greet');
  });

  it('rejects clashes and unknown ids', () => {
    let r = applyFail(rigDoc(), [{ op: 'rename', kind: 'bone', from: 'hand', to: 'root' }]);
    expect(r.message).toBe('bone "root" already exists (/bones/0)');
    r = applyFail(rigDoc(), [{ op: 'rename', kind: 'bone', from: 'hand', to: 'face' }]);
    expect(r.message).toBe('"face" is already used by warp /warps/0');
    r = applyFail(rigDoc(), [{ op: 'rename', kind: 'part', from: 'mouht', to: 'lips' }]);
    expect(r.hint).toBe('did you mean "mouth"?');
    r = applyFail(rigDoc(), [{ op: 'rename', kind: 'part', from: 'mouth', to: 'mouth' }]);
    expect(r.message).toContain('both "mouth"');
  });
});

describe('move', () => {
  it('reorders by index, before and after', () => {
    let { doc, messages } = applyOk(rigDoc(), [{ op: 'move', kind: 'part', id: 'cloth', index: 0 }]);
    expect(doc.parts.map((p: any) => p.id)).toEqual(['cloth', 'body', 'head', 'mouth', 'sleeve', 'photo']);
    expect(messages[0]).toContain('moved part "cloth" from index 5 to 0');
    expect(messages[0]).toContain('parts draw by z first');
    ({ doc } = applyOk(rigDoc(), [{ op: 'move', kind: 'part', id: 'body', after: 'photo' }]));
    expect(doc.parts.map((p: any) => p.id)).toEqual(['head', 'mouth', 'sleeve', 'photo', 'body', 'cloth']);
    ({ doc } = applyOk(rigDoc(), [{ op: 'move', kind: 'bone', id: 'target', before: 'root' }]));
    expect(doc.bones[0].id).toBe('target');
    ({ doc } = applyOk(rigDoc(), [{ op: 'move', kind: 'binding', target: 'part:head.opacity', index: 0 }]));
    expect(doc.bindings[0].target).toBe('part:head.opacity');
  });

  it('rejects bad positions', () => {
    let r = applyFail(rigDoc(), [{ op: 'move', kind: 'part', id: 'body' }]);
    expect(r.message).toContain('needs one of "index", "before", "after"');
    r = applyFail(rigDoc(), [{ op: 'move', kind: 'part', id: 'body', index: 9 }]);
    expect(r.hint).toBe('use an integer from 0 to 5 (5 = last)');
    r = applyFail(rigDoc(), [{ op: 'move', kind: 'part', id: 'body', after: 'body' }]);
    expect(r.message).toContain('cannot place "body" after itself');
    r = applyFail(rigDoc(), [{ op: 'move', kind: 'part', id: 'body', index: 0, after: 'head' }]);
    expect(r.message).toContain('only one of');
  });
});

describe('bone math', () => {
  it('setup worlds follow SPEC §3.2 (sanity check of the fixture chain)', () => {
    const w = setupWorlds(rigDoc());
    const expected = multiply(multiply(fromTRS(200, 300, 0, 1, 1), fromTRS(0, -50, -90, 1, 1)), fromTRS(60, 0, 30, 1.5, 1.5));
    expectMatClose(w.fore, expected);
    const [x, y] = apply(expected, 40, 0);
    expect(w.hand[4]).toBeCloseTo(x, 6);
    expect(w.hand[5]).toBeCloseTo(y, 6);
  });
});
