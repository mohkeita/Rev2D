import { describe, expect, it } from 'vitest';
import { exportLive2dDisplayInfo, importLive2dDisplayInfo } from '../index.js';
import { codes, fixture, hanaModel, hanaRaw, miniRaw } from './helpers.js';

describe('live2d cdi3', () => {
  it('imports parameter names and group names for the target model', () => {
    const { parameters, parts, report } = importLive2dDisplayInfo(fixture('mini.cdi3.json'), { model: miniRaw() });
    expect(parameters).toEqual([
      { id: 'AngleX', name: 'Angle X', group: 'Face' },
      { id: 'MouthOpen', name: 'Mouth open', group: 'Mouth' },
      { id: 'Breath', name: 'Breath', group: 'ParamGroupMissing' },
    ]);
    expect(parts).toEqual([{ id: 'PartArm', name: 'Arm' }]);
    expect(codes(report)).toEqual(expect.arrayContaining(['live2d-cdi-nested-groups', 'live2d-cdi-unknown-group', 'live2d-cdi-unknown-parameters', 'live2d-cdi-combined-ignored']));
    expect(report.issues.find((i) => i.code === 'live2d-cdi-unknown-group')?.where).toBe('Parameters[3] (ParamBreath)');
  });

  it('exports display names, group ids and round-trips the groups', () => {
    const hana = hanaModel();
    const { cdi3, report } = exportLive2dDisplayInfo(hana);
    const params = cdi3.Parameters as Array<{ Id: string; GroupId: string; Name: string }>;
    expect(params).toHaveLength(hana.parameters.length);
    expect(params[0]).toEqual({ Id: 'ParamAngleX', GroupId: 'ParamGroupFace', Name: 'Angle X' });
    expect(params.find((p) => p.Id === 'ParamMouthOpenY')).toEqual({ Id: 'ParamMouthOpenY', GroupId: 'ParamGroupMouth', Name: 'Mouth Open/Close' });
    expect(cdi3.ParameterGroups).toEqual(expect.arrayContaining([{ Id: 'ParamGroupFace', GroupId: '', Name: 'Face' }]));
    expect(cdi3.Parts).toEqual([]);
    expect(codes(report)).toContain('live2d-cdi-descriptions');
    const back = importLive2dDisplayInfo(cdi3, { model: hanaRaw() });
    for (const p of hana.parameters) expect(back.parameters.find((b) => b.id === p.id)?.group).toBe(p.group);
  });
});
