import { describe, expect, it } from 'vitest';
import { applyFail, applyOk, find, rigDoc } from './fixtures.js';

describe('set', () => {
  it('sets setup values of bones, parts and IK', () => {
    const { doc, messages } = applyOk(rigDoc(), [
      { op: 'set', target: 'bone:hand.rotation', value: 15 },
      { op: 'set', target: 'part:head.shape.rx', value: 30 },
      { op: 'set', target: 'part:head.opacity', value: 0.5 },
      { op: 'set', target: 'part:head.fill', value: '#112233' },
      { op: 'set', target: 'part:body.visible', value: false },
      { op: 'set', target: 'part:head.shape.rotation', value: 10 },
      { op: 'set', target: 'ik:armIk.mix', value: 0.25 },
    ]);
    const hand = find(doc, 'bones', 'hand');
    expect(Object.keys(hand)).toEqual(['id', 'parent', 'x', 'y', 'rotation', 'length']);
    expect(hand.rotation).toBe(15);
    const head = find(doc, 'parts', 'head');
    expect(head.shape).toEqual({ type: 'ellipse', cx: 200, cy: 150, rx: 30, ry: 45, rotation: 10 });
    expect(Object.keys(head)).toEqual(['id', 'parent', 'shape', 'fill', 'opacity', 'z']);
    expect(head.fill).toBe('#112233');
    expect(find(doc, 'parts', 'body').visible).toBe(false);
    expect(doc.ik[0].mix).toBe(0.25);
    expect(messages[0]).toBe(
      'set bone:hand.rotation = 15 (was unset, default 0); note: binding bone:hand.rotation ← [Sway] sets absolute values, so this setup value does not show while it exists (change the look with "bind")',
    );
    expect(messages[1]).toBe('set part:head.shape.rx = 30 (was 40)');
    expect(messages[4]).toBe('set part:body.visible = false (was unset, default true)');
  });

  it('notes when several bindings override the setup value', () => {
    const doc = rigDoc();
    doc.bindings.push({ target: 'part:head.opacity', params: ['Bend'], keys: [{ at: [0], value: 1 }, { at: [1], value: 0.5 }] });
    const { messages } = applyOk(doc, [{ op: 'set', target: 'part:head.opacity', value: 0.9 }, { op: 'set', target: 'part:body.opacity', value: 0.9 }]);
    expect(messages[0]).toBe(
      'set part:head.opacity = 0.9 (was unset, default 1); note: 2 bindings (part:head.opacity ← [AngleY], part:head.opacity ← [Bend]) set absolute values; what shows is setup + Σ(keyform − setup) (change the look with "bind")',
    );
    expect(messages[1]).toBe('set part:body.opacity = 0.9 (was unset, default 1)');
  });

  it('keeps a solid fill object and sets its colour', () => {
    const doc = rigDoc();
    find(doc, 'parts', 'body').fill = { type: 'solid', color: '#ffffff' };
    const { doc: out } = applyOk(doc, [{ op: 'set', target: 'part:body.fill', value: 'red' }]);
    expect(find(out, 'parts', 'body').fill).toEqual({ type: 'solid', color: 'red' });
  });

  it('expands sparse point maps into the full setup list', () => {
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'set', target: 'part:mouth.shape.points', value: { '2': [200, 185] } }]);
    expect(find(doc, 'parts', 'mouth').shape.points).toEqual([185, 170, 215, 170, 200, 185]);
    expect(messages[0]).toBe('set part:mouth.shape.points = [185,170,215,170,200,185] (was [185,170,215,170,200,178])');
  });

  it('accepts any valid path structure for the setup path', () => {
    const doc = rigDoc();
    find(doc, 'parts', 'body').shape = { type: 'path', d: 'M0 0 L10 0 L5 8 Z' };
    const { doc: out } = applyOk(doc, [{ op: 'set', target: 'part:body.shape.d', value: 'M0 0 C 5 5 10 5 10 0 Z' }]);
    expect(find(out, 'parts', 'body').shape.d).toBe('M0 0 C 5 5 10 5 10 0 Z');
  });

  it('rejects parameters, warp offsets, gradients, missing strokes and bad values with hints', () => {
    let r = applyFail(rigDoc(), [{ op: 'set', target: 'param:AngleX', value: 3 }]);
    expect(r.message).toBe('set: parameters have no setup value to "set" ("param:AngleX")');
    expect(r.hint).toContain('{"op": "update", "kind": "parameter", "id": "AngleX", "set": {"default": <value>}}');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'warp:face.offsets', value: {} }]);
    expect(r.hint).toContain('bind_warp');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'part:head.stroke.width', value: 2 }]);
    expect(r.message).toBe('set: part "head" has no stroke, so "part:head.stroke.width" has no setup value yet');
    expect(r.hint).toBe('add the stroke with {"op": "update", "kind": "part", "id": "head", "set": {"stroke": {"color": "#000000", "width": 2}}}');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'part:head.stroke.color', value: 'red' }]);
    expect(r.hint).toBe('add the stroke with {"op": "update", "kind": "part", "id": "head", "set": {"stroke": {"color": "red", "width": 2}}}');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'part:head.opacity', value: 1.5 }]);
    expect(r.message).toContain('/parts/1/opacity');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'part:head.opacity', value: 'high' }]);
    expect(r.message).toBe('set: expected a number, got "high" for "part:head.opacity"');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'part:head.shape.rz', value: 1 }]);
    expect(r.hint).toBe('did you mean "rx"?');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'bone:hnad.x', value: 1 }]);
    expect(r.message).toBe('unknown bone "hnad"');
    expect(r.hint).toBe('did you mean "hand"?');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'part:mouth.shape.points', value: { '7': [0, 0] } }]);
    expect(r.message).toContain('point index 7 out of range (0..2)');
    const doc = rigDoc();
    find(doc, 'parts', 'body').fill = { type: 'linear', from: [0, 0], to: [1, 1], stops: [[0, '#000'], [1, '#fff']] };
    r = applyFail(doc, [{ op: 'set', target: 'part:body.fill', value: 'red' }]);
    expect(r.message).toBe('set: part "body" has a linear gradient fill; "set" only changes solid fill colours');
    expect(r.hint).toBe(
      'make the fill solid with {"op": "update", "kind": "part", "id": "body", "set": {"fill": "red"}}, edit the gradient with {"op": "update", "kind": "part", "id": "body", "set": {"fill.stops": [[0, "#000"], [1, "#fff"]]}}, or tint the whole part with {"op": "set", "target": "part:body.tint", "value": "red"}',
    );
  });

  it('points non-animatable fields to update (and ids to rename)', () => {
    let r = applyFail(rigDoc(), [{ op: 'set', target: 'part:body.blend', value: 'add' }]);
    expect(r.message).toBe('set: "blend" of part "body" is not an animatable property ("set" changes setup values of properties that bindings and animations drive)');
    expect(r.hint).toBe('use update: {"op": "update", "kind": "part", "id": "body", "set": {"blend": "add"}}');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'part:body.shape.detail', value: 8 }]);
    expect(r.hint).toBe('use update: {"op": "update", "kind": "part", "id": "body", "set": {"shape.detail": 8}}');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'bone:hand.parent', value: 'root' }]);
    expect(r.hint).toBe('use update: {"op": "update", "kind": "bone", "id": "hand", "set": {"parent": "root"}}');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'ik:armIk.bendPositive', value: false }]);
    expect(r.hint).toBe('use update: {"op": "update", "kind": "ik", "id": "armIk", "set": {"bendPositive": false}}');
    r = applyFail(rigDoc(), [{ op: 'set', target: 'bone:hand.id', value: 'paw' }]);
    expect(r.hint).toBe('use rename, which also rewrites every reference: {"op": "rename", "kind": "bone", "from": "hand", "to": "paw"}');
    // Typos still get did-you-mean from the address resolver.
    r = applyFail(rigDoc(), [{ op: 'set', target: 'part:body.opacty', value: 1 }]);
    expect(r.hint).toContain('did you mean "opacity"?');
  });

  it('explains how to change the number of points', () => {
    const r = applyFail(rigDoc(), [{ op: 'set', target: 'part:mouth.shape.points', value: [1, 2, 3, 4, 5, 6, 7, 8] }]);
    expect(r.message).toBe('set: expected 6 numbers (3 points), got 8 for "part:mouth.shape.points"');
    expect(r.hint).toBe(
      'or use a sparse map {"<pointIndex>": [x, y]} to change only some points; to change the number of points use update: {"op": "update", "kind": "part", "id": "mouth", "set": {"shape.points": [...]}} (bindings and tracks on it must then match)',
    );
  });

  it('describes the default of an unset image size as the texture size', () => {
    const { messages } = applyOk(rigDoc(), [{ op: 'set', target: 'part:photo.shape.w', value: 20 }], { textures: { tex: { width: 16, height: 16 } } });
    expect(messages[0]).toBe('set part:photo.shape.w = 20 (was unset, default: the texture width, 16)');
    const doc = rigDoc();
    find(doc, 'parts', 'photo').shape.crop = [0, 0, 8, 4];
    const cropped = applyOk(doc, [{ op: 'set', target: 'part:photo.shape.h', value: 5 }]);
    expect(cropped.messages[0]).toBe('set part:photo.shape.h = 5 (was unset, default: the crop height, 4)');
  });
});

describe('bind', () => {
  it('adds a binding, then replaces the one with the same target and parameter set', () => {
    const first = applyOk(rigDoc(), [
      { op: 'bind', target: 'part:body.opacity', params: 'Bend', keys: [{ at: 0, value: 1 }, { at: [1], value: 0 }] },
    ]);
    expect(first.messages[0]).toBe('added binding part:body.opacity ← [Bend] as /bindings/6 (2 keyforms)');
    expect(first.doc.bindings[6]).toEqual({ target: 'part:body.opacity', params: ['Bend'], keys: [{ at: [0], value: 1 }, { at: [1], value: 0 }] });

    const second = applyOk(first.doc, [
      { op: 'bind', target: 'bone:hand.rotation', params: ['Sway'], keys: [{ at: [-10], value: -5 }, { at: [0], value: 0 }, { at: [10], value: 5 }], interpolation: 'step' },
    ]);
    expect(second.messages[0]).toBe('replaced binding bone:hand.rotation ← [Sway] at /bindings/3 (3 keyforms, was 2)');
    expect(second.doc.bindings[3]).toEqual({
      id: 'handTurn',
      target: 'bone:hand.rotation',
      params: ['Sway'],
      keys: [{ at: [-10], value: -5 }, { at: [0], value: 0 }, { at: [10], value: 5 }],
      interpolation: 'step',
    });
    expect(second.doc.bindings).toHaveLength(7);
  });

  it('keeps the replaced binding\'s interpolation unless a new one is given', () => {
    const doc = rigDoc();
    find(doc, 'bindings', 'handTurn').interpolation = 'step';
    const keys = [{ at: [-10], value: -30 }, { at: [10], value: 30 }];
    const kept = applyOk(doc, [{ op: 'bind', target: 'bone:hand.rotation', params: ['Sway'], keys }]);
    expect(find(kept.doc, 'bindings', 'handTurn').interpolation).toBe('step');
    expect(kept.messages[0]).toBe('replaced binding bone:hand.rotation ← [Sway] at /bindings/3 (2 keyforms, was 2; interpolation "step" kept)');
    const changed = applyOk(doc, [{ op: 'bind', target: 'bone:hand.rotation', params: ['Sway'], keys, interpolation: 'linear' }]);
    expect(find(changed.doc, 'bindings', 'handTurn').interpolation).toBe('linear');
  });

  it('treats the parameter set as unordered when matching', () => {
    const { doc, messages } = applyOk(rigDoc(), [
      {
        op: 'bind',
        target: 'warp:face.offsets',
        params: ['AngleY', 'AngleX'],
        keys: [
          { at: [-30, -30], value: {} },
          { at: [-30, 30], value: {} },
          { at: [30, -30], value: {} },
          { at: [30, 30], value: { '4': [0, 5] } },
        ],
      },
    ]);
    expect(messages[0]).toContain('replaced binding warp:face.offsets ← [AngleY, AngleX]');
    expect(doc.bindings.filter((b: any) => b.target === 'warp:face.offsets')).toHaveLength(1);
  });

  it('checks params, at lengths, values and the keyform grid', () => {
    let r = applyFail(rigDoc(), [{ op: 'bind', target: 'part:body.opacity', params: ['Bnd'], keys: [{ at: [0], value: 1 }] }]);
    expect(r.message).toBe('unknown parameter "Bnd"');
    expect(r.hint).toBe('did you mean "Bend"?');
    r = applyFail(rigDoc(), [{ op: 'bind', target: 'part:body.opacity', params: ['Bend'], keys: [{ at: [0, 1], value: 1 }] }]);
    expect(r.message).toBe('bind: keys[0].at has 2 value(s) but there are 1 parameter(s) (Bend)');
    r = applyFail(rigDoc(), [{ op: 'bind', target: 'part:body.tint', params: ['Bend'], keys: [{ at: [0], value: 3 }] }]);
    expect(r.message).toBe('bind: keys[0].value: expected a color string, got 3 for "part:body.tint"');
    r = applyFail(rigDoc(), [
      { op: 'bind', target: 'part:body.opacity', params: ['AngleX', 'AngleY'], keys: [{ at: [0, 0], value: 1 }, { at: [30, 30], value: 0 }] },
    ]);
    expect(r.message).toBe('bind: keys do not form a full grid: AngleX {0, 30} × AngleY {0, 30} needs 4 keys, got 2');
    expect(r.hint).toBe('add keys with "at": [0, 30], [30, 0]');
    r = applyFail(rigDoc(), [{ op: 'bind', target: 'param:AngleX', params: ['Bend'], keys: [{ at: [0], value: 1 }] }]);
    expect(r.message).toContain('bindings cannot target a parameter');
    r = applyFail(rigDoc(), [{ op: 'bind', target: 'part:body.opacity', params: ['Bend'], keys: [{ at: [0], val: 1 }] }]);
    expect(r.message).toBe('bind: keys[0]: unknown field "val"');
    r = applyFail(rigDoc(), [{ op: 'bind', target: 'part:body.opacity', params: ['Bend'], keys: [{ at: [0], value: 1 }, { at: [0], value: 0 }] }]);
    expect(r.message).toContain('repeats "at" [0]');
  });
});

describe('unbind', () => {
  it('removes bindings by target, optionally filtered by params', () => {
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'unbind', target: 'part:head.opacity' }]);
    expect(doc.bindings.map((b: any) => b.target)).not.toContain('part:head.opacity');
    expect(messages[0]).toBe('removed binding part:head.opacity ← [AngleY] (was /bindings/5)');
    const r = applyFail(rigDoc(), [{ op: 'unbind', target: 'part:head.opacity', params: ['AngleX'] }]);
    expect(r.hint).toBe('bindings on it: [AngleY]');
    const r2 = applyFail(rigDoc(), [{ op: 'unbind', target: 'part:head.opacty' }]);
    expect(r2.hint).toBe('did you mean "part:head.opacity"?');
  });

  it('reports the pointers the removed bindings had before the op', () => {
    const second = { op: 'bind', target: 'part:head.opacity', params: ['AngleX'], keys: [{ at: [-30], value: 1 }, { at: [0], value: 1 }, { at: [30], value: 1 }] };
    const { doc, messages } = applyOk(rigDoc(), [second, { op: 'unbind', target: 'part:head.opacity' }]);
    expect(doc.bindings.map((b: any) => b.target)).not.toContain('part:head.opacity');
    const added = /as \/bindings\/(\d+)/.exec(messages[0])![1];
    expect(messages[1]).toBe(`removed 2 bindings: part:head.opacity ← [AngleY] (was /bindings/5), part:head.opacity ← [AngleX] (was /bindings/${added})`);
  });
});

describe('key', () => {
  it('creates the animation only when a duration is given', () => {
    const r = applyFail(rigDoc(), [{ op: 'key', animation: 'blink', target: 'param:AngleX', t: 0, v: 1 }]);
    expect(r.message).toBe('key: unknown animation "blink"');
    expect(r.hint).toContain('"duration"');
    const { doc, messages } = applyOk(rigDoc(), [
      { op: 'key', animation: 'blink', target: 'param:AngleX', t: 0, v: 1, duration: 1.5, loop: false },
      { op: 'key', animation: 'blink', target: 'param:AngleX', t: 1, v: -1, duration: 1.5 },
    ]);
    expect(find(doc, 'animations', 'blink')).toEqual({
      id: 'blink',
      duration: 1.5,
      loop: false,
      tracks: [{ target: 'param:AngleX', keys: [{ t: 0, v: 1 }, { t: 1, v: -1 }] }],
    });
    expect(messages[0]).toBe('added a key at t=0 (v 1) on new track param:AngleX of animation "blink", now 1 key; created animation "blink" (duration 1.5 s)');
  });

  it('upserts keys, keeps them sorted and keeps the old ease when none is given', () => {
    const doc = rigDoc();
    find(doc, 'animations', 'wave').tracks[0].keys[1].ease = 'outBack';
    const { doc: out, messages } = applyOk(doc, [
      { op: 'key', animation: 'wave', target: 'bone:fore.rotation', t: 0.5, v: 45, ease: 'inOutSine' },
      { op: 'key', animation: 'wave', target: 'bone:fore.rotation', t: 1 + 5e-7, v: 70 },
      { op: 'key', animation: 'wave', target: 'bone:fore.rotation', t: 2, v: 30 },
    ]);
    expect(find(out, 'animations', 'wave').tracks[0].keys).toEqual([
      { t: 0, v: 30 },
      { t: 0.5, v: 45, ease: 'inOutSine' },
      { t: 1, v: 70, ease: 'outBack' },
      { t: 2, v: 30 },
    ]);
    expect(messages[1]).toBe('replaced the key at t=1 (v 60 → 70, ease "outBack" kept) on track bone:fore.rotation of animation "wave", now 3 keys');
  });

  it('sorts unsorted tracks it touches', () => {
    const doc = rigDoc();
    find(doc, 'animations', 'wave').tracks[1].keys.reverse();
    const { doc: out, messages } = applyOk(doc, [{ op: 'key', animation: 'wave', target: 'param:AngleX', t: 0.5, v: 10 }]);
    expect(find(out, 'animations', 'wave').tracks[1].keys.map((k: any) => k.t)).toEqual([0, 0.5, 1]);
    expect(messages[0]).toContain('sorted the existing keys by t');
  });

  it('rejects keys after the duration, bad values and eases, and conflicting durations', () => {
    let r = applyFail(rigDoc(), [{ op: 'key', animation: 'wave', target: 'param:AngleX', t: 3, v: 1 }]);
    expect(r.message).toBe('key: t=3 is after the end of animation "wave" (duration 2)');
    expect(r.hint).toBe('extend it first: {"op": "update", "kind": "animation", "id": "wave", "set": {"duration": 3}}');
    r = applyFail(rigDoc(), [{ op: 'key', animation: 'wave', target: 'part:head.tint', t: 1, v: 1 }]);
    expect(r.message).toBe('key: "v": expected a color string, got 1 for "part:head.tint"');
    r = applyFail(rigDoc(), [{ op: 'key', animation: 'wave', target: 'param:AngleX', t: 1, v: 1, ease: 'easeInOutSine' }]);
    expect(r.hint).toContain('did you mean "inOutSine"?');
    r = applyFail(rigDoc(), [{ op: 'key', animation: 'wave', target: 'param:AngleX', t: 1, v: 1, duration: 4 }]);
    expect(r.message).toBe('key: animation "wave" already exists with duration 2');
    r = applyFail(rigDoc(), [{ op: 'key', animation: 'wave', target: 'param:Angle', t: 1, v: 1 }]);
    expect(r.message).toBe('unknown parameter "Angle"');
  });

  it('asks for a longer duration (not an update) when the animation is being created', () => {
    const r = applyFail(rigDoc(), [{ op: 'key', animation: 'jump', target: 'param:AngleX', t: 3, v: 1, duration: 2 }]);
    expect(r.message).toBe('key: t=3 is after the end of animation "jump" (duration 2)');
    expect(r.hint).toBe('pass a "duration" of at least 3 to create the animation long enough');
  });
});

describe('unkey', () => {
  it('removes keys and drops empty tracks', () => {
    const { doc, messages } = applyOk(rigDoc(), [
      { op: 'unkey', animation: 'wave', target: 'param:AngleX', t: 1 },
      { op: 'unkey', animation: 'wave', target: 'param:AngleX', t: 0 },
    ]);
    expect(find(doc, 'animations', 'wave').tracks.map((t: any) => t.target)).toEqual(['bone:fore.rotation', 'bone:hand.rotation']);
    expect(messages[0]).toBe('removed the key at t=1 (v 30) from track param:AngleX of animation "wave"; 1 key left');
    expect(messages[1]).toContain('the track had no keys left and was removed');
  });

  it('lists existing key times when the key is missing', () => {
    const r = applyFail(rigDoc(), [{ op: 'unkey', animation: 'wave', target: 'param:AngleX', t: 0.5 }]);
    expect(r.hint).toBe('key times: 0, 1');
    const r2 = applyFail(rigDoc(), [{ op: 'unkey', animation: 'wave', target: 'param:AngleY', t: 0 }]);
    expect(r2.message).toBe('animation "wave" has no track for "param:AngleY"');
  });
});
