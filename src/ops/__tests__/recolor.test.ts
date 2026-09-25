import { describe, expect, it } from 'vitest';
import { hslToRgb, rgbToHsl } from '../recolor.js';
import { applyFail, applyOk, find, rigDoc } from './fixtures.js';

/** rigDoc with a gradient body, a stroked + tinted head, and colour bindings / tracks on the head. */
function colourDoc() {
  const d = rigDoc();
  find(d, 'parts', 'body').fill = { type: 'linear', from: [0, 0], to: [0, 100], stops: [[0, '#ffcc99'], [1, '#8888aa80']] };
  find(d, 'parts', 'body').tags = ['skin', 'cloth'];
  Object.assign(find(d, 'parts', 'head'), { stroke: { color: '#FFCC99', width: 2 }, tint: '#ffcc99', tags: ['skin'] });
  d.bindings.push({ target: 'part:head.fill', params: ['Bend'], keys: [{ at: [0], value: '#ffcc99' }, { at: [1], value: '#ff0000' }] });
  d.animations[0].tracks.push({ target: 'part:head.tint', keys: [{ t: 0, v: '#ffcc99' }] });
  return d;
}

describe('recolor', () => {
  it('map: replaces exact RGB matches in fills, gradient stops, strokes and colour keyforms, keeping alpha', () => {
    const { doc, messages } = applyOk(colourDoc(), [{ op: 'recolor', all: true, map: { '#ffcc99': '#e0b080', '#8888aa': '#445566', '#123456': '#000000' } }]);
    expect(find(doc, 'parts', 'body').fill.stops).toEqual([
      [0, '#e0b080'],
      [1, '#44556680'],
    ]);
    const head = find(doc, 'parts', 'head');
    expect(head.fill).toBe('#e0b080');
    expect(head.stroke.color).toBe('#e0b080');
    expect(head.tint).toBe('#ffcc99'); // tints only with include: ["tint"]
    expect(doc.bindings.at(-1).keys.map((k: any) => k.value)).toEqual(['#e0b080', '#ff0000']);
    expect(doc.animations[0].tracks.at(-1).keys[0].v).toBe('#ffcc99');
    expect(find(doc, 'parts', 'mouth').fill).toBe('#aa3333');
    expect(messages[0]).toBe(
      'recolored 5 colours in 2 of 6 parts: body (2 gradient stops), head (fill, stroke, binding keyform); unchanged: mouth, sleeve, photo, cloth; map entries that matched nothing: "#123456"',
    );
  });

  it('a map key with alpha only matches that alpha', () => {
    const { doc, messages } = applyOk(colourDoc(), [{ op: 'recolor', parts: ['body'], map: { '#8888aa80': '#000000', '#ffcc9980': '#111111' } }]);
    expect(find(doc, 'parts', 'body').fill.stops).toEqual([
      [0, '#ffcc99'],
      [1, '#00000080'],
    ]);
    expect(messages[0]).toBe('recolored 1 colour in 1 of 1 part: body (gradient stop); map entries that matched nothing: "#ffcc9980"');
    // An explicit opaque alpha matches opaque colours only.
    const opaque = applyOk(colourDoc(), [{ op: 'recolor', parts: ['body'], map: { '#ffcc99ff': '#111111', '#8888aaff': '#222222' } }]).doc;
    expect(find(opaque, 'parts', 'body').fill.stops).toEqual([
      [0, '#111111'],
      [1, '#8888aa80'],
    ]);
  });

  it('hsl: shifts hue / saturation / lightness of the selected parts, tints and their keys with include tint', () => {
    const { doc, messages } = applyOk(colourDoc(), [{ op: 'recolor', tag: 'skin', hsl: { h: 180 }, include: ['tint'] }]);
    const head = find(doc, 'parts', 'head');
    expect(head.fill).toBe('#99ccff');
    expect(head.tint).toBe('#99ccff');
    expect(doc.animations[0].tracks.at(-1).keys[0].v).toBe('#99ccff');
    expect(doc.bindings.at(-1).keys.map((k: any) => k.value)).toEqual(['#99ccff', '#00ffff']);
    expect(messages[0]).toBe('recolored 8 colours in 2 of 2 parts: body (2 gradient stops), head (fill, stroke, tint, 2 binding keyforms, animation key)');
    const lighter = applyOk(colourDoc(), [{ op: 'recolor', parts: ['mouth'], hsl: { l: 0.2, s: -1 } }]).doc;
    expect(find(lighter, 'parts', 'mouth').fill).toBe('#a2a2a2');
  });

  it('fails when nothing changed, listing the colours it found', () => {
    let r = applyFail(colourDoc(), [{ op: 'recolor', parts: ['body'], map: { '#000000': '#ffffff' } }]);
    expect(r.message).toBe('recolor: no colour changed in the 1 selected part');
    expect(r.hint).toBe('colours there: #ffcc99 (body gradient stop), #8888aa80 (body gradient stop)');
    const grey = rigDoc();
    find(grey, 'parts', 'body').fill = '#808080';
    r = applyFail(grey, [{ op: 'recolor', parts: ['body'], hsl: { h: 90 } }]);
    expect(r.hint).toBe('colours there: #808080 (body fill); greys, white and black have no hue, so an "h" shift leaves them unchanged (use "l" / "s", or "map")');
  });

  it('rejects bad selections and transforms with hints', () => {
    let r = applyFail(colourDoc(), [{ op: 'recolor', tag: 'skn', hsl: { h: 10 } }]);
    expect(r.message).toBe('recolor: no part has the tag "skn"');
    expect(r.hint).toBe('did you mean "skin"?');
    r = applyFail(colourDoc(), [{ op: 'recolor', parts: ['hed'], hsl: { h: 10 } }]);
    expect(r.hint).toBe('did you mean "head"?');
    r = applyFail(colourDoc(), [{ op: 'recolor', parts: ['head'], tag: 'skin', hsl: { h: 10 } }]);
    expect(r.message).toBe('recolor: give only one of "parts", "tag", "all" (got parts, tag)');
    r = applyFail(colourDoc(), [{ op: 'recolor', parts: ['head'] }]);
    expect(r.message).toBe('recolor needs "map" (exact colour replacements) or "hsl" (a shift)');
    r = applyFail(colourDoc(), [{ op: 'recolor', parts: ['head'], hsl: { hue: 10 } }]);
    expect(r.hint).toBe('did you mean "h"? (hsl fields: h, s, l)');
    r = applyFail(colourDoc(), [{ op: 'recolor', parts: ['head'], hsl: { s: 20 } }]);
    expect(r.message).toBe('recolor: hsl.s must be between -1 and 1, got 20');
    expect(r.hint).toContain('"s": 0.2');
    r = applyFail(colourDoc(), [{ op: 'recolor', parts: ['head'], map: { '#ffcc99': '#ff000080' } }]);
    expect(r.message).toBe('recolor: map value "#ff000080" has an alpha channel; recolor keeps each colour\'s own alpha');
    r = applyFail(colourDoc(), [{ op: 'recolor', parts: ['head'], map: { red: '#000000', '#ff0000': '#111111' } }]);
    expect(r.message).toBe('recolor: map keys "red" and "#ff0000" are the same colour (#ff0000)');
    r = applyFail(colourDoc(), [{ op: 'recolor', parts: ['head'], map: { '#ffcc99': '#000000' }, include: ['fill'] }]);
    expect(r.message).toBe('recolor: unknown "include" entry "fill" (fills and strokes are always recoloured)');
  });

  it('HSL round-trips', () => {
    for (const c of [
      [1, 0.8, 0.6],
      [0.2, 0.4, 0.9],
      [0.5, 0.5, 0.5],
      [0, 1, 0],
    ] as Array<[number, number, number]>) {
      const back = hslToRgb(...rgbToHsl(c));
      back.forEach((v, i) => expect(v).toBeCloseTo(c[i], 9));
    }
  });
});
