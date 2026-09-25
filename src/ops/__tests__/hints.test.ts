/**
 * Every rejected property address or value of set / bind / key comes with an actionable hint:
 * gradient fills, missing strokes, unparseable setup paths, missing properties, property names
 * from other tools (color, alpha, rx, ...) and values of the wrong type.
 */
import { describe, expect, it } from 'vitest';
import { applyFail, applyOk, find, rigDoc } from './fixtures.js';

const GRADIENT = { type: 'linear', from: [0, 0], to: [1, 1], stops: [[0, '#000'], [1, '#fff']] };

/** rigDoc with a gradient-filled "body" and a path part "wave" (valid, so edits of it validate). */
function doc() {
  const d = rigDoc();
  find(d, 'parts', 'body').fill = structuredClone(GRADIENT);
  d.parts.push({ id: 'wave', shape: { type: 'path', d: 'M0 0 L10 0 L5 8 Z' } });
  return d;
}

/** doc() plus a part whose setup path does not parse. */
function withBadPath() {
  const d = doc();
  d.parts.push({ id: 'badPath', shape: { type: 'path', d: 'not a path' }, fill: '#ffffff' });
  return d;
}

const UPDATE_BODY_FILL = (fill: string) => `{"op": "update", "kind": "part", "id": "body", "set": {"fill": ${fill}}}`;

describe('gradient fills', () => {
  it('set: suggests a solid fill, editing the stops, or the tint', () => {
    let r = applyFail(doc(), [{ op: 'set', target: 'part:body.fill', value: '#336699' }]);
    expect(r.message).toBe('set: part "body" has a linear gradient fill; "set" only changes solid fill colours');
    expect(r.hint).toBe(
      `make the fill solid with ${UPDATE_BODY_FILL('"#336699"')}, edit the gradient with {"op": "update", "kind": "part", "id": "body", "set": {"fill.stops": [[0, "#000"], [1, "#fff"]]}}, or tint the whole part with {"op": "set", "target": "part:body.tint", "value": "#336699"}`,
    );
    // Not a colour: the hint shows a placeholder instead of repeating the bad value.
    r = applyFail(doc(), [{ op: 'set', target: 'part:body.fill', value: 5 }]);
    expect(r.hint).toContain(`make the fill solid with ${UPDATE_BODY_FILL('"#rrggbb"')}`);
    expect(r.hint).toContain('{"op": "set", "target": "part:body.tint", "value": "#rrggbb"}');
    // A whole fill object: replace the fill with it.
    const radial = { type: 'radial', center: [0, 0], radius: 5, stops: [[0, '#fff']] };
    r = applyFail(doc(), [{ op: 'set', target: 'part:body.fill', value: radial }]);
    expect(r.hint).toBe(`replace the whole fill with ${UPDATE_BODY_FILL('{"type": "radial", "center": [0, 0], "radius": 5, "stops": [[0, "#fff"]]}')}`);
    // ...which works.
    applyOk(doc(), [{ op: 'update', kind: 'part', id: 'body', set: { fill: '#336699' } }, { op: 'set', target: 'part:body.fill', value: '#112233' }]);
  });

  it('bind / key: suggests making the fill solid or driving the tint', () => {
    let r = applyFail(doc(), [{ op: 'bind', target: 'part:body.fill', params: ['Bend'], keys: [{ at: [0], value: '#fff' }, { at: [1], value: '#000' }] }]);
    expect(r.message).toBe('bind: invalid target "part:body.fill": part "body" fill is a gradient; only solid fills are bindable');
    expect(r.hint).toBe(`bindings drive solid fill colours only: make the fill solid first with ${UPDATE_BODY_FILL('"#rrggbb"')}, or bind "part:body.tint" instead (the tint multiplies the gradient's colours)`);
    r = applyFail(doc(), [{ op: 'key', animation: 'wave', target: 'part:body.fill', t: 0, v: '#fff' }]);
    expect(r.hint).toBe(`animation tracks drive solid fill colours only: make the fill solid first with ${UPDATE_BODY_FILL('"#rrggbb"')}, or key "part:body.tint" instead (the tint multiplies the gradient's colours)`);
    // The suggested alternative works.
    applyOk(doc(), [{ op: 'bind', target: 'part:body.tint', params: ['Bend'], keys: [{ at: [0], value: '#ffffff' }, { at: [1], value: '#ff8080' }] }]);
  });

  it('gradient fields: "set" points to update, bind/key to the tint', () => {
    let r = applyFail(doc(), [{ op: 'set', target: 'part:body.fill.stops', value: [[0, '#fff']] }]);
    expect(r.message).toBe('set: "fill.stops" of part "body" is not an animatable property ("set" changes setup values of properties that bindings and animations drive)');
    expect(r.hint).toBe('use update: {"op": "update", "kind": "part", "id": "body", "set": {"fill.stops": [[0, "#fff"]]}}');
    r = applyFail(doc(), [{ op: 'set', target: 'part:body.fill.color', value: '#fff' }]);
    expect(r.hint).toContain(`make the fill solid with ${UPDATE_BODY_FILL('"#fff"')}`);
    r = applyFail(doc(), [{ op: 'bind', target: 'part:body.fill.stops', params: ['Bend'], keys: [{ at: [0], value: 1 }] }]);
    expect(r.hint).toContain('or bind "part:body.tint" instead');
  });
});

describe('strokes and paths', () => {
  it('bind / key on a missing stroke: the update that adds one', () => {
    const add = 'add the stroke with {"op": "update", "kind": "part", "id": "head", "set": {"stroke": {"color": "#000000", "width": 2}}}';
    let r = applyFail(doc(), [{ op: 'bind', target: 'part:head.stroke.color', params: ['Bend'], keys: [{ at: [0], value: '#fff' }] }]);
    expect(r.message).toBe('bind: invalid target "part:head.stroke.color": part "head" has no stroke');
    expect(r.hint).toBe(add);
    r = applyFail(doc(), [{ op: 'key', animation: 'wave', target: 'part:head.stroke.width', t: 0, v: 4 }]);
    expect(r.hint).toBe(add);
    // set keeps its own wording and uses the given value; an unusable value falls back to defaults.
    r = applyFail(doc(), [{ op: 'set', target: 'part:head.stroke.width', value: 'thick' }]);
    expect(r.hint).toBe(add);
    r = applyFail(doc(), [{ op: 'set', target: 'part:head.stroke.color', value: 5 }]);
    expect(r.hint).toBe(add);
  });

  it('"stroke" itself: the colour or width address', () => {
    let r = applyFail(doc(), [{ op: 'set', target: 'part:head.stroke', value: '#ff0000' }]);
    expect(r.hint).toBe('did you mean "part:head.stroke.color"? (or add a stroke with {"op": "update", "kind": "part", "id": "head", "set": {"stroke": {"color": "#ff0000", "width": 2}}})');
    r = applyFail(doc(), [{ op: 'set', target: 'part:head.stroke', value: 3 }]);
    expect(r.hint).toBe('did you mean "part:head.stroke.width"? (or add a stroke with {"op": "update", "kind": "part", "id": "head", "set": {"stroke": {"color": "#000000", "width": 3}}})');
    // A whole stroke object is an update.
    r = applyFail(doc(), [{ op: 'set', target: 'part:head.stroke', value: { color: '#fff', width: 1 } }]);
    expect(r.hint).toBe('use update: {"op": "update", "kind": "part", "id": "head", "set": {"stroke": {"color": "#fff", "width": 1}}}');
  });

  it('an unparseable setup path: the update that replaces it', () => {
    let r = applyFail(withBadPath(), [{ op: 'set', target: 'part:badPath.shape.d', value: 'M0 0 L10 10' }]);
    expect(r.message).toBe('set: invalid target "part:badPath.shape.d": part "badPath" has an invalid path');
    expect(r.hint).toBe('its setup path "not a path" does not parse; replace it with {"op": "update", "kind": "part", "id": "badPath", "set": {"shape.d": "M0 0 L10 10"}}');
    r = applyFail(withBadPath(), [{ op: 'bind', target: 'part:badPath.shape.d', params: ['Bend'], keys: [{ at: [0], value: 'M0 0' }] }]);
    expect(r.hint).toBe('its setup path "not a path" does not parse; fix it first, e.g. {"op": "update", "kind": "part", "id": "badPath", "set": {"shape.d": "M0 0 L100 0 L50 80 Z"}}');
  });
});

describe('addresses', () => {
  it('lists the properties when the address has none', () => {
    let r = applyFail(doc(), [{ op: 'set', target: 'bone:hand', value: 1 }]);
    expect(r.message).toBe('set: invalid target "bone:hand": address "bone:hand" needs a property, e.g. "bone:hand.rotation"');
    expect(r.hint).toBe('properties of bone "hand": x, y, rotation, scaleX, scaleY, length');
    r = applyFail(doc(), [{ op: 'bind', target: 'part:head', params: ['Bend'], keys: [{ at: [0], value: 1 }] }]);
    expect(r.hint).toBe('properties of part "head": opacity, z, tint, visible, fill, stroke.color, stroke.width, shape.cx, shape.cy, shape.rx, shape.ry, shape.rotation');
    r = applyFail(doc(), [{ op: 'key', animation: 'wave', target: 'ik:nope', t: 0, v: 1 }]);
    expect(r.hint).toBe('ik properties: mix');
  });

  it.each([
    ['set', 'part:head.color', 'part:head.fill', '#fff'],
    ['set', 'part:head.colour', 'part:head.fill', '#fff'],
    ['set', 'part:head.alpha', 'part:head.opacity', 0.5],
    ['set', 'part:head.zIndex', 'part:head.z', 3],
    ['set', 'part:head.hidden', 'part:head.visible', true],
    ['set', 'part:head.lineWidth', 'part:head.stroke.width', 2],
    ['set', 'part:head.rx', 'part:head.shape.rx', 30],
    ['set', 'part:head.x', 'part:head.shape.cx', 30],
    ['set', 'part:head.shape.x', 'part:head.shape.cx', 30],
    ['set', 'part:body.width', 'part:body.shape.w', 30],
    ['set', 'part:mouth.shape.vertices', 'part:mouth.shape.points', [0, 0, 1, 1, 2, 2]],
    ['set', 'part:cloth.points', 'part:cloth.shape.vertices', [0, 0, 1, 1, 2, 2]],
    ['set', 'part:head.fill.color', 'part:head.fill', '#fff'],
    ['set', 'bone:hand.rot', 'bone:hand.rotation', 10],
    ['set', 'bone:hand.angle', 'bone:hand.rotation', 10],
    ['set', 'bone:hand.len', 'bone:hand.length', 10],
    ['set', 'ik:armIk.weight', 'ik:armIk.mix', 0.5],
    ['bind', 'warp:face.points', 'warp:face.offsets', {}],
  ])('%s %s: did you mean %s', (op, target, fixed, value) => {
    const o =
      op === 'set'
        ? { op, target, value }
        : { op, target, params: ['Bend'], keys: [{ at: [0], value }] };
    const r = applyFail(doc(), [o]);
    expect(r.hint).toMatch(new RegExp(`^did you mean "${fixed.replace(/\./g, '\\.')}"\\? \\(valid: `));
  });

  it('keeps the resolver\'s own did-you-mean for plain typos', () => {
    let r = applyFail(doc(), [{ op: 'set', target: 'part:head.opacty', value: 1 }]);
    expect(r.hint).toBe('did you mean "opacity"?');
    r = applyFail(doc(), [{ op: 'set', target: 'part:head.nonsense', value: 1 }]);
    expect(r.hint).toBe('valid: opacity, z, tint, visible, fill, stroke.color, stroke.width, shape.cx, shape.cy, shape.rx, shape.ry, shape.rotation');
  });
});

describe('values', () => {
  it.each([
    [{ op: 'set', target: 'bone:hand.rotation', value: '10' }, 'set: expected a number, got "10" for "bone:hand.rotation"', 'write the number without quotes: 10'],
    [{ op: 'set', target: 'bone:hand.rotation', value: null }, 'set: expected a number, got null for "bone:hand.rotation"', 'a finite number, e.g. 0 (the setup value)'],
    [{ op: 'set', target: 'part:head.shape.rx', value: 'wide' }, 'set: expected a number, got "wide" for "part:head.shape.rx"', 'a finite number, e.g. 40 (the setup value)'],
    [{ op: 'set', target: 'ik:armIk.mix', value: true }, 'set: expected a number, got true for "ik:armIk.mix"', 'a finite number, e.g. 1 (the setup value)'],
    [{ op: 'set', target: 'part:head.visible', value: 1 }, 'set: "part:head.visible" needs true or false, got number 1', 'write true (setup values are booleans; bindings and tracks also take numbers, >= 0.5 = visible)'],
    [{ op: 'set', target: 'part:head.visible', value: 'false' }, 'set: "part:head.visible" needs true or false, got string "false"', 'write false without quotes'],
    [{ op: 'key', animation: 'wave', target: 'part:head.visible', t: 0, v: 'yes' }, 'key: "v": expected true/false, got "yes" for "part:head.visible"', 'true or false (numbers work too: >= 0.5 is true)'],
    [{ op: 'set', target: 'part:mouth.shape.points', value: 'x' }, 'set: expected a point list or sparse point map, got "x" for "part:mouth.shape.points"', 'a list of 6 numbers [x0, y0, x1, y1, ...] or a sparse map {"<pointIndex>": [x, y]}'],
    [{ op: 'set', target: 'part:mouth.shape.points', value: { '1': 5 } }, 'set: point 1 must be [x, y] for "part:mouth.shape.points"', 'e.g. {"1": [215, 170]} (its setup position)'],
    [{ op: 'set', target: 'part:mouth.shape.points', value: { '7': [0, 0] } }, 'set: point index 7 out of range (0..2) for "part:mouth.shape.points"', 'sparse map keys are point indices 0..2, e.g. {"2": [200, 178]}'],
    [{ op: 'bind', target: 'part:wave.shape.d', params: ['Bend'], keys: [{ at: [0], value: 5 }] }, 'bind: keys[0].value: expected an SVG path string, got 5 for "part:wave.shape.d"', 'the setup path with changed numbers, e.g. "M0 0 L10 0 L5 8 Z"'],
    [{ op: 'key', animation: 'wave', target: 'part:wave.shape.d', t: 0, v: 'zigzag' }, 'key: "v": invalid SVG path "zigzag" for "part:wave.shape.d"', 'the setup path with changed numbers, e.g. "M0 0 L10 0 L5 8 Z"'],
  ])('%j', (op, message, hint) => {
    const r = applyFail(doc(), [op]);
    expect(r.message).toBe(message);
    expect(r.hint).toBe(hint);
  });
});
