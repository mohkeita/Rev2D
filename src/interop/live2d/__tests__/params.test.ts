import { describe, expect, it } from 'vitest';
import {
  IDENTITY_PARAM_MAP,
  LIVE2D_STANDARD_PARAMS,
  STANDARD_PARAM_MAP,
  exportLive2d,
  fromLive2dId,
  importLive2dMotion,
  paramMapFromJson,
  prefixParamMap,
  toLive2dId,
} from '../index.js';
import { compactLocations, modernLive2dId, resolveLive2dParam } from '../params.js';
import { modelInfo } from '../util.js';
import { codes, hanaModel, hanaRaw, miniRaw, normalize } from './helpers.js';

describe('live2d: Cubism 2 parameter ids', () => {
  it('names them like Cubism 3 does', () => {
    expect(modernLive2dId('PARAM_ANGLE_X')).toBe('ParamAngleX');
    expect(modernLive2dId('PARAM_EYE_L_OPEN')).toBe('ParamEyeLOpen');
    expect(modernLive2dId('PARAM_EYE_BALL_FORM')).toBe('ParamEyeBallForm');
    expect(modernLive2dId('PARAM_BROW_R_ANGLE')).toBe('ParamBrowRAngle');
    expect(modernLive2dId('PARAM_MOUTH_OPEN_Y')).toBe('ParamMouthOpenY');
    expect(modernLive2dId('PARAM_YUGE_01')).toBe('ParamYuge01');
    for (const id of ['ParamAngleX', 'PARAM', 'PARAM_', 'PARTS_01_FACE', 'Param_Angle_Rotation_1']) expect(modernLive2dId(id)).toBeUndefined();
  });

  it('resolves them after the Cubism 3 ids, with and without a target model', () => {
    const info = modelInfo(miniRaw());
    expect(resolveLive2dParam('PARAM_ANGLE_X', STANDARD_PARAM_MAP, info)).toMatchObject({ ok: true, id: 'AngleX', legacy: 'ParamAngleX' });
    expect(resolveLive2dParam('PARAM_MOUTH_OPEN_Y', STANDARD_PARAM_MAP, info)).toMatchObject({ ok: true, id: 'MouthOpen', legacy: 'ParamMouthOpenY' });
    expect(resolveLive2dParam('PARAM_TAIL', STANDARD_PARAM_MAP, info)).toMatchObject({ ok: false, id: 'PARAM_TAIL' });
    // A model that uses the legacy id itself wins over the conversion.
    const raw = miniRaw();
    (raw.parameters as unknown[]).push({ id: 'PARAM_ANGLE_X', min: -1, max: 1 });
    expect(resolveLive2dParam('PARAM_ANGLE_X', STANDARD_PARAM_MAP, modelInfo(raw))).toEqual({ ok: true, param: expect.anything(), id: 'PARAM_ANGLE_X' });
    // Without a model: standard (or mapped) ids only.
    expect(resolveLive2dParam('PARAM_EYE_R_OPEN', STANDARD_PARAM_MAP, undefined)).toMatchObject({ ok: true, id: 'EyeROpen', legacy: 'ParamEyeROpen' });
    expect(resolveLive2dParam('PARAM_TAIL', STANDARD_PARAM_MAP, undefined)).toEqual({ ok: true, param: undefined, id: 'PARAM_TAIL' });
  });
});

describe('live2d: parameter maps', () => {
  it('maps the Rev2D example ids to the Live2D standard ids and back', () => {
    const pairs: Array<[string, string]> = [
      ['AngleX', 'ParamAngleX'],
      ['AngleY', 'ParamAngleY'],
      ['AngleZ', 'ParamAngleZ'],
      ['EyeLOpen', 'ParamEyeLOpen'],
      ['EyeROpen', 'ParamEyeROpen'],
      ['EyeLSmile', 'ParamEyeLSmile'],
      ['EyeRSmile', 'ParamEyeRSmile'],
      ['EyeBallX', 'ParamEyeBallX'],
      ['EyeBallY', 'ParamEyeBallY'],
      ['EyeBallForm', 'ParamEyeBallForm'],
      ['BrowLY', 'ParamBrowLY'],
      ['BrowRX', 'ParamBrowRX'],
      ['BrowLAngle', 'ParamBrowLAngle'],
      ['BrowRForm', 'ParamBrowRForm'],
      ['MouthForm', 'ParamMouthForm'],
      ['MouthOpen', 'ParamMouthOpenY'],
      ['Cheek', 'ParamCheek'],
      ['BodyAngleX', 'ParamBodyAngleX'],
      ['BodyAngleZ', 'ParamBodyAngleZ'],
      ['Breath', 'ParamBreath'],
      ['HairFront', 'ParamHairFront'],
      ['HairSide', 'ParamHairSide'],
      ['HairBack', 'ParamHairBack'],
      ['HairFluffy', 'ParamHairFluffy'],
      ['ArmLA', 'ParamArmLA'],
      ['ArmRB', 'ParamArmRB'],
      ['HandL', 'ParamHandL'],
      ['ShoulderY', 'ParamShoulderY'],
      ['BustX', 'ParamBustX'],
      ['BaseY', 'ParamBaseY'],
    ];
    for (const [rev, l2d] of pairs) {
      expect(toLive2dId(rev, STANDARD_PARAM_MAP)).toBe(l2d);
      expect(fromLive2dId(l2d, STANDARD_PARAM_MAP)).toBe(rev);
    }
    // One-to-one, one entry per standard parameter.
    expect(Object.keys(STANDARD_PARAM_MAP.toLive2d)).toHaveLength(Object.keys(LIVE2D_STANDARD_PARAMS).length);
    expect(new Set(Object.values(STANDARD_PARAM_MAP.toLive2d)).size).toBe(Object.keys(STANDARD_PARAM_MAP.toLive2d).length);
    // Unmapped ids pass through.
    expect(toLive2dId('Blush', STANDARD_PARAM_MAP)).toBe('Blush');
    expect(fromLive2dId('ParamCustom', STANDARD_PARAM_MAP)).toBe('ParamCustom');
    expect(toLive2dId('AngleX', IDENTITY_PARAM_MAP)).toBe('AngleX');
    expect(Object.isFrozen(STANDARD_PARAM_MAP.toLive2d)).toBe(true);
  });

  it('lists the standard ranges from the Cubism manual', () => {
    expect(LIVE2D_STANDARD_PARAMS.ParamAngleX).toMatchObject({ min: -30, default: 0, max: 30 });
    expect(LIVE2D_STANDARD_PARAMS.ParamEyeLOpen).toMatchObject({ min: 0, default: 1, max: 1 });
    expect(LIVE2D_STANDARD_PARAMS.ParamMouthOpenY).toMatchObject({ min: 0, default: 0, max: 1 });
    expect(LIVE2D_STANDARD_PARAMS.ParamMouthForm).toMatchObject({ min: -1, default: 0, max: 1 });
    expect(LIVE2D_STANDARD_PARAMS.ParamBodyAngleX).toMatchObject({ min: -10, default: 0, max: 10 });
    expect(LIVE2D_STANDARD_PARAMS.ParamBreath).toMatchObject({ min: 0, default: 0, max: 1 });
    expect(LIVE2D_STANDARD_PARAMS.ParamCheek.default).toBeNull();
  });

  it('builds a map from a user mapping file over the standard preset', () => {
    const map = paramMapFromJson('{"Blush": "ParamCheek", "Smile": "ParamMouthForm"}');
    expect(toLive2dId('Blush', map)).toBe('ParamCheek');
    expect(fromLive2dId('ParamCheek', map)).toBe('Blush');
    // The standard entries that the user re-mapped are gone (one-to-one), the rest stay.
    expect(map.toLive2d.Cheek).toBeUndefined();
    expect(map.toLive2d.MouthForm).toBeUndefined();
    expect(toLive2dId('AngleX', map)).toBe('ParamAngleX');
    // Only the user entries on top of the identity map.
    const only = paramMapFromJson({ Blush: 'ParamCheek' }, IDENTITY_PARAM_MAP);
    expect(only.toLive2d).toEqual({ Blush: 'ParamCheek' });
    expect(() => paramMapFromJson('{"A": 3}')).toThrow(/non-empty Live2D parameter id/);
    expect(() => paramMapFromJson('{"A": "ParamX", "B": "ParamX"}')).toThrow(/one-to-one/);
    expect(() => paramMapFromJson('{nope')).toThrow(/invalid JSON/);
  });

  it('supports a prefix strategy for custom ids', () => {
    const map = prefixParamMap(['Blush', 'ParamAlready', 'Tail']);
    expect(map.toLive2d).toEqual({ Blush: 'ParamBlush', ParamAlready: 'ParamAlready', Tail: 'ParamTail' });
    expect(fromLive2dId('ParamTail', map)).toBe('Tail');
    const onStandard = prefixParamMap(['Tail', 'AngleX'], 'Param', STANDARD_PARAM_MAP);
    expect(toLive2dId('AngleX', onStandard)).toBe('ParamAngleX');
    expect(toLive2dId('Tail', onStandard)).toBe('ParamTail');
  });

  it('resolves Live2D ids against a target model (mapped, raw, prefix-stripped, else did-you-mean)', () => {
    const raw = miniRaw();
    (raw.parameters as unknown[]).push({ id: 'ParamCustom', min: 0, max: 1 }, { id: 'Tail', min: -1, max: 1 });
    const info = modelInfo(raw);
    expect(resolveLive2dParam('ParamAngleX', STANDARD_PARAM_MAP, info)).toMatchObject({ ok: true, id: 'AngleX' });
    expect(resolveLive2dParam('ParamCustom', STANDARD_PARAM_MAP, info)).toMatchObject({ ok: true, id: 'ParamCustom' });
    expect(resolveLive2dParam('ParamTail', STANDARD_PARAM_MAP, info)).toMatchObject({ ok: true, id: 'Tail' });
    const miss = resolveLive2dParam('ParamAngelX', STANDARD_PARAM_MAP, info);
    expect(miss.ok).toBe(false);
    expect(!miss.ok && miss.hint).toMatch(/AngleX/);
    expect(resolveLive2dParam('ParamWhatever', STANDARD_PARAM_MAP, undefined)).toMatchObject({ ok: true, id: 'ParamWhatever' });
  });

  it('compacts location lists', () => {
    expect(compactLocations(['Curves[3]', 'Curves[4]', 'Curves[5]', 'Curves[9]'])).toBe('Curves[3-5, 9]');
    expect(compactLocations(['A[1].Input[0]', 'A[1].Input[1]', 'Meta'])).toBe('A[1].Input[0, 1], Meta');
  });
});

describe('live2d: standard range checks', () => {
  it('finds hana consistent with the Live2D standard ranges', () => {
    const { report } = exportLive2d(hanaModel());
    expect(codes(report)).not.toContain('live2d-param-range-mismatch');
  });

  it('reports each mismatching parameter once per conversion, on export and import', () => {
    const raw = hanaRaw();
    const params = raw.parameters as Array<Record<string, unknown>>;
    params.find((p) => p.id === 'BodyAngleX')!.min = -30;
    params.find((p) => p.id === 'BodyAngleX')!.max = 30;
    params.find((p) => p.id === 'EyeLOpen')!.default = 0;
    const { report } = exportLive2d(normalize(raw));
    const mismatches = report.issues.filter((i) => i.code === 'live2d-param-range-mismatch');
    expect(mismatches.map((i) => i.where)).toEqual(['parameters.EyeLOpen', 'parameters.BodyAngleX']);
    expect(mismatches[1].message).toContain('[-10, 10]');
    const motion = { Version: 3, Meta: { Duration: 1, Fps: 30 }, Curves: [{ Target: 'Parameter', Id: 'ParamBodyAngleX', Segments: [0, 0, 0, 1, 5] }, { Target: 'Parameter', Id: 'ParamBodyAngleX', Segments: [0, 0, 0, 1, 5] }] };
    const imported = importLive2dMotion(motion, 'm', { model: raw });
    expect(imported.report.issues.filter((i) => i.code === 'live2d-param-range-mismatch')).toHaveLength(1);
  });
});
