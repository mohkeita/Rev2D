import { describe, expect, it } from 'vitest';
import { Rig } from '../../../core/rig.js';
import { importLive2dExpression } from '../index.js';
import { codes, fixture, miniRaw, normalize } from './helpers.js';

type Track = { target: string; keys: Array<{ t: number; v: number }> };

describe('live2d exp3 import', () => {
  it('turns Add / Multiply / Overwrite into absolute one-key tracks', () => {
    const { animation, report } = importLive2dExpression(fixture('expressions/smile.exp3.json'), 'exp_Smile', { model: miniRaw() });
    expect(animation).toMatchObject({ id: 'exp_Smile', duration: 1, loop: false });
    expect(animation.description).toContain('--anim "exp_Smile,add"');
    const values = Object.fromEntries((animation.tracks as Track[]).map((t) => [t.target, t.keys.map((k) => [k.t, k.v])]));
    expect(values).toEqual({
      'param:MouthForm': [[0, 1]], // Add: default 0 + 1
      'param:EyeLOpen': [[0, 0.5]], // Multiply: default 1 x 0.5
      'param:BrowLY': [[0, 0.3]], // Blend omitted = Add
      'param:Cheek': [[0, 1]], // Overwrite
    });
    const byCode = new Map(report.issues.map((i) => [i.code, i]));
    expect(byCode.get('live2d-unknown-parameter')).toMatchObject({ severity: 'warning', where: 'Parameters[4]', message: expect.stringContaining('ParamNope') });
    expect(byCode.get('live2d-exp-blend-approximated')?.message).toContain('EyeLOpen (Multiply), Cheek (Overwrite)');
    expect(byCode.get('live2d-fade-ignored')).toMatchObject({ severity: 'info' });
    expect(report.stats).toMatchObject({ tracks: 4, droppedParameters: 1 });
  });

  it('layers additively on top of a motion like a Cubism expression', () => {
    const { animation } = importLive2dExpression(fixture('expressions/smile.exp3.json'), 'exp_Smile', { model: miniRaw() });
    const raw = miniRaw();
    raw.animations = [
      { id: 'base', duration: 1, loop: true, tracks: [{ target: 'param:MouthForm', keys: [{ t: 0, v: -0.5 }] }, { target: 'param:BrowLY', keys: [{ t: 0, v: 0.2 }] }] },
      animation,
    ];
    const rig = new Rig(normalize(raw));
    const p = rig.pose({ time: 0.3, animations: ['base', { id: 'exp_Smile', mode: 'add' }], physics: false }).params;
    expect(p.MouthForm).toBeCloseTo(0.5); // -0.5 + 1 (Add)
    expect(p.BrowLY).toBeCloseTo(0.5); // 0.2 + 0.3 (Add)
    expect(p.EyeLOpen).toBeCloseTo(0.5); // default 1 x 0.5 (Multiply, exact at the default)
    expect(p.Cheek).toBeCloseTo(1); // Overwrite, exact from the default
  });

  it('uses standard defaults without a model and validates the file', () => {
    const { animation } = importLive2dExpression({ Type: 'Live2D Expression', Parameters: [{ Id: 'ParamEyeLOpen', Value: 0.5, Blend: 'Multiply' }, { Id: 'ParamCustom', Value: 2 }] }, 'e');
    expect((animation.tracks as Track[]).map((t) => [t.target, t.keys[0].v])).toEqual([
      ['param:EyeLOpen', 0.5],
      ['param:ParamCustom', 2],
    ]);
    const odd = importLive2dExpression({ Type: 'Expression', Parameters: [{ Id: 'ParamMouthForm', Value: 2, Blend: 'Multiply' }, { Id: 'ParamBrowLY', Value: 1, Blend: 'Screen' }, { Value: 1 }] }, 'e', { model: miniRaw() });
    expect(codes(odd.report)).toEqual(expect.arrayContaining(['live2d-exp-type', 'live2d-exp-invalid', 'live2d-exp-multiply-noop']));
    expect(() => importLive2dExpression({ Type: 'Live2D Expression' }, 'e')).toThrow(/Parameters/);
  });

  it('reads Cubism 2 parameter ids, with their standard defaults', () => {
    const doc = { Type: 'Live2D Expression', Parameters: [{ Id: 'PARAM_EYE_L_OPEN', Value: 0.5, Blend: 'Multiply' }, { Id: 'PARAM_MOUTH_FORM', Value: 1 }] };
    for (const opts of [{}, { model: miniRaw() }]) {
      const { animation, report } = importLive2dExpression(doc, 'e', opts);
      expect((animation.tracks as Track[]).map((t) => [t.target, t.keys[0].v])).toEqual([
        ['param:EyeLOpen', 0.5],
        ['param:MouthForm', 1],
      ]);
      expect(report.issues.find((i) => i.code === 'live2d-legacy-id')?.message).toContain('PARAM_EYE_L_OPEN -> ParamEyeLOpen (EyeLOpen)');
    }
  });
});
