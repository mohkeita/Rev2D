import { describe, expect, it } from 'vitest';
import { applyFail, applyOk, find, rigDoc } from './fixtures.js';

const bindingOn = (doc: any, target: string) => doc.bindings.find((b: any) => b.target === target);

describe('bind "relative": true', () => {
  it('adds number offsets to the current setup value and stores absolute keyforms', () => {
    const { doc, messages } = applyOk(rigDoc(), [
      { op: 'bind', target: 'bone:hand.x', params: ['Bend'], relative: true, keys: [{ at: [0], value: 0 }, { at: [1], value: 15 }] },
    ]);
    expect(bindingOn(doc, 'bone:hand.x')).toEqual({ target: 'bone:hand.x', params: ['Bend'], keys: [{ at: [0], value: 40 }, { at: [1], value: 55 }] });
    expect(messages[0]).toBe('added binding bone:hand.x ← [Bend] as /bindings/6 (2 keyforms); relative: stored absolute keyforms 40, 55 (setup 40 + offsets)');
  });

  it('uses schema defaults for unset setup values (bone y and rotation default to 0)', () => {
    const { doc } = applyOk(rigDoc(), [
      { op: 'bind', target: 'bone:hand.y', params: ['Sway'], relative: true, keys: [{ at: [-10], value: -3 }, { at: [10], value: 3 }] },
    ]);
    expect(bindingOn(doc, 'bone:hand.y').keys.map((k: any) => k.value)).toEqual([-3, 3]);
  });

  it('adds point offsets element-wise; sparse offset maps stay sparse', () => {
    const { doc } = applyOk(rigDoc(), [
      { op: 'bind', target: 'part:mouth.shape.points', params: ['Bend'], relative: true, keys: [{ at: [0], value: {} }, { at: [1], value: { '2': [0, 10] } }] },
    ]);
    const b = doc.bindings.filter((x: any) => x.target === 'part:mouth.shape.points').find((x: any) => x.params[0] === 'Bend');
    expect(b.keys).toEqual([
      { at: [0], value: {} },
      { at: [1], value: { '2': [200, 188] } },
    ]);
    const full = applyOk(rigDoc(), [
      { op: 'bind', target: 'part:mouth.shape.points', params: ['Bend'], relative: true, keys: [{ at: [0], value: [0, 0, 0, 0, 0, 0] }, { at: [1], value: [1, 1, 2, 2, 3, 3] }] },
    ]).doc;
    expect(full.bindings.find((x: any) => x.params[0] === 'Bend' && x.target === 'part:mouth.shape.points').keys[1].value).toEqual([186, 171, 217, 172, 203, 181]);
  });

  it('warp offsets are relative to the rest lattice either way', () => {
    const { doc } = applyOk(rigDoc(), [{ op: 'bind', target: 'warp:mouthWarp.offsets', params: ['Bend'], relative: true, keys: [{ at: [0], value: {} }, { at: [1], value: { '3': [2, 2] } }] }]);
    expect(bindingOn(doc, 'warp:mouthWarp.offsets').keys[1].value).toEqual({ '3': [2, 2] });
  });

  it('rejects colours, paths and booleans with the absolute alternative, and non-numeric offsets', () => {
    let r = applyFail(rigDoc(), [{ op: 'bind', target: 'part:head.fill', params: ['Bend'], relative: true, keys: [{ at: [0], value: '#000000' }] }]);
    expect(r.message).toBe('bind: "relative" offsets need a numeric or point-list property, but "part:head.fill" is a colour');
    expect(r.hint).toBe('drop "relative" and give absolute values (keyform values are absolute), e.g. "value": "#ffcc99" is the current setup value');
    r = applyFail(rigDoc(), [{ op: 'bind', target: 'part:body.visible', params: ['Bend'], relative: true, keys: [{ at: [0], value: true }] }]);
    expect(r.message).toContain('"part:body.visible" is a boolean');
    r = applyFail(rigDoc(), [{ op: 'bind', target: 'bone:hand.x', params: ['Bend'], relative: true, keys: [{ at: [0], value: '5' }] }]);
    expect(r.message).toBe('bind: keys[0].value: expected a number (offset from the setup value 40), got string "5"');
    r = applyFail(rigDoc(), [{ op: 'bind', target: 'part:mouth.shape.points', params: ['Bend'], relative: true, keys: [{ at: [0], value: { '9': [1, 1] } }] }]);
    expect(r.message).toContain('point index 9 out of range');
  });

  it('an unset image size is taken from the texture; unknown sizes are refused', () => {
    const { doc } = applyOk(rigDoc(), [{ op: 'bind', target: 'part:photo.shape.w', params: ['Bend'], relative: true, keys: [{ at: [0], value: 0 }, { at: [1], value: 4 }] }]);
    expect(bindingOn(doc, 'part:photo.shape.w').keys.map((k: any) => k.value)).toEqual([16, 20]);
    const noSize = rigDoc();
    delete noSize.textures[0].width;
    delete noSize.textures[0].height;
    const r = applyFail(noSize, [{ op: 'bind', target: 'part:photo.shape.w', params: ['Bend'], relative: true, keys: [{ at: [0], value: 0 }] }]);
    expect(r.message).toBe('bind: "part:photo.shape.w" is unset and the size of texture "tex" is unknown, so there is no setup value to add offsets to');
  });
});

describe('bind_linear', () => {
  it('binds value = setup + scale × param over the parameter range', () => {
    const { doc, messages } = applyOk(rigDoc(), [{ op: 'bind_linear', target: 'bone:target.y', param: 'AngleY', scale: 2 }]);
    expect(bindingOn(doc, 'bone:target.y')).toEqual({ target: 'bone:target.y', params: ['AngleY'], keys: [{ at: [-30], value: -180 }, { at: [30], value: -60 }] });
    expect(messages[0]).toBe('added binding bone:target.y ← [AngleY] as /bindings/6 (2 keyforms); bone:target.y = -120 + 2 × AngleY (-30 → -180, 30 → -60)');
  });

  it('keys at "at" when given, and replaces an existing binding dropping its step interpolation', () => {
    const doc = rigDoc();
    doc.bindings[0].interpolation = 'step';
    const { doc: out, messages } = applyOk(doc, [{ op: 'bind_linear', target: 'bone:fore.rotation', param: 'Bend', scale: -10, at: [0, 0.5] }]);
    expect(out.bindings[0]).toEqual({ target: 'bone:fore.rotation', params: ['Bend'], keys: [{ at: [0], value: 30 }, { at: [0.5], value: 25 }] });
    expect(messages[0]).toBe('replaced binding bone:fore.rotation ← [Bend] at /bindings/0 (2 keyforms, was 2); bone:fore.rotation = 30 - 10 × Bend (0 → 30, 0.5 → 25)');
  });

  it('warns when the parameter default is not 0 (the rest pose moves)', () => {
    const doc = rigDoc();
    doc.parameters.push({ id: 'Open', min: 0, max: 1, default: 1 });
    const { messages } = applyOk(doc, [{ op: 'bind_linear', target: 'part:head.shape.ry', param: 'Open', scale: 5 }]);
    expect(messages[0]).toContain(
      '; WARNING: at the parameter default Open=1 the value is 50, not the setup value 45, so the rest pose moves (use a parameter whose default is 0, or bind explicit keys)',
    );
  });

  it('rejects non-numeric targets, bad "at" and unknown parameters with hints', () => {
    let r = applyFail(rigDoc(), [{ op: 'bind_linear', target: 'part:mouth.shape.points', param: 'Bend', scale: 1 }]);
    expect(r.message).toBe('bind_linear: "part:mouth.shape.points" is a point list; bind_linear drives numeric properties');
    expect(r.hint).toContain('"relative": true');
    r = applyFail(rigDoc(), [{ op: 'bind_linear', target: 'bone:hand.x', param: 'Bend', scale: 1, at: [1, 0] }]);
    expect(r.message).toBe('bind_linear: "at" must be [low, high] with low < high (the two parameter values to key), got [1,0]');
    r = applyFail(rigDoc(), [{ op: 'bind_linear', target: 'bone:hand.x', param: 'Bnd', scale: 1 }]);
    expect(r.message).toBe('unknown parameter "Bnd"');
    expect(r.hint).toBe('did you mean "Bend"?');
    r = applyFail(rigDoc(), [{ op: 'bind_linear', target: 'param:Bend', param: 'Bend', scale: 1 }]);
    expect(r.message).toBe('bind_linear: bindings cannot target a parameter ("param:Bend")');
    r = applyFail(rigDoc(), [{ op: 'bind_linear', target: 'bone:hand.x', params: ['Bend'], scale: 1 }]);
    expect(r.message).toBe('bind_linear: unknown field "params"');
    expect(r.hint).toContain('did you mean "param"?');
  });

  it('the bound property follows the parameter in the rig', async () => {
    const { Rig } = await import('../../core/rig.js');
    const { validateModel } = await import('../../core/validate.js');
    const { doc } = applyOk(rigDoc(), [{ op: 'bind_linear', target: 'bone:target.y', param: 'AngleY', scale: 2 }]);
    const rig = new Rig(validateModel(doc).model!);
    expect(rig.pose({ params: { AngleY: 10 }, physics: false }).bones.target.local.y).toBeCloseTo(-100, 6);
    expect(find(doc, 'bones', 'target').y).toBe(-120);
  });
});
