import { describe, expect, it } from 'vitest';
import { applyOps } from '../../../ops/index.js';
import { exportLive2d, importLive2dModel3 } from '../index.js';
import { codes, countMotion, fixture, fixtureReader, hanaModel, hanaRaw, miniRaw, normalize, sampleParams } from './helpers.js';

type Json = Record<string, unknown>;
type Doc = { animations: Array<{ id: string; tracks: Array<{ target: string }> }>; physics: Array<{ id: string }>; parameters: Array<Json>; parts: Array<Json> };

describe('live2d model3 import', () => {
  it('produces ops that bring motions, expressions, physics and display info into a Rev2D model', () => {
    const { ops, report } = importLive2dModel3(fixture('mini.model3.json'), fixtureReader, { model: miniRaw() });
    const res = applyOps(miniRaw(), ops);
    expect(res.results.filter((r) => !r.ok)).toEqual([]);
    expect(res.ok).toBe(true);
    const doc = res.doc as Doc;
    expect(doc.animations.map((a) => a.id)).toEqual(['exp_Smile', 'wave', 'free']);
    // EyeBlink (model3 Groups) applied to both eyes.
    expect(doc.animations.find((a) => a.id === 'wave')!.tracks.map((t) => t.target)).toEqual(expect.arrayContaining(['param:EyeLOpen', 'param:EyeROpen']));
    // Imported physics replaces the group that drove the same parameter.
    expect(doc.physics.map((g) => g.id)).toEqual(['PhysicsSetting1', 'PhysicsSetting2']);
    // Display info fills what the model lacks and keeps what it has.
    const param = (id: string) => doc.parameters.find((p) => p.id === id)!;
    expect(param('AngleX')).toMatchObject({ description: 'existing', group: 'Head' });
    expect(param('MouthOpen')).toMatchObject({ description: 'Mouth open', group: 'Mouth' });
    expect(doc.parts.find((p) => p.id === 'PartArm')).toMatchObject({ description: 'Arm' });

    expect(report).toMatchObject({ format: 'live2d-model3', direction: 'import', stats: { motions: 2, expressions: 1 } });
    const c = codes(report);
    expect(c).toEqual(
      expect.arrayContaining([
        'live2d-moc-ignored',
        'live2d-textures-ignored',
        'live2d-pose-ignored',
        'live2d-hitareas-ignored',
        'live2d-group',
        'live2d-file-missing',
        'live2d-sound-ignored',
        'live2d-fade-ignored',
        'live2d-animation-replaced',
        'live2d-physics-replaced',
        'live2d-cdi-kept',
        'live2d-model-curve-applied',
        'live2d-model-curve-combined',
      ]),
    );
    expect(report.issues.find((i) => i.code === 'live2d-file-missing')?.where).toBe('FileReferences.Expressions[1]');
    expect(report.issues.find((i) => i.code === 'live2d-unknown-parameter' && i.where?.startsWith('motions/wave'))?.where).toBe('motions/wave.motion3.json: Curves[4]');
  });

  it('warns when it replaces an animation made in Rev2D, and only notes replacing an earlier import', () => {
    // miniRaw has its own "wave" (no import wrote it), and the model3 lists motions/wave.motion3.json.
    const first = importLive2dModel3(fixture('mini.model3.json'), fixtureReader, { model: miniRaw() });
    const replaced = first.report.issues.filter((i) => i.code === 'live2d-animation-replaced');
    expect(replaced).toEqual([expect.objectContaining({ severity: 'warning', where: 'FileReferences.Motions.Idle[0]' })]);
    expect(replaced[0].message).toMatch(/"wave".*not .*Live2D import.*replace/);
    expect(replaced[0].hint).toMatch(/rename/);
    // The same import again replaces what the first one brought (the expression and both motions).
    const doc = applyOps(miniRaw(), first.ops).doc as Json;
    const again = importLive2dModel3(fixture('mini.model3.json'), fixtureReader, { model: doc });
    const second = again.report.issues.filter((i) => i.code === 'live2d-animation-replaced');
    expect(second.map((i) => [i.severity, i.where])).toEqual([
      ['info', 'FileReferences.Expressions[0]'],
      ['info', 'FileReferences.Motions.Idle[0]'],
      ['info', 'FileReferences.Motions.Tap[0]'],
    ]);
    expect(second.every((i) => i.hint === undefined)).toBe(true);
    // An imported animation that was renamed or re-described by hand counts as made in Rev2D again.
    const edited = structuredClone(doc) as { animations: Array<{ id: string; description?: string }> };
    edited.animations.find((a) => a.id === 'free')!.description = 'my tap, retimed by hand';
    const third = importLive2dModel3(fixture('mini.model3.json'), fixtureReader, { model: edited as unknown as Json });
    expect(third.report.issues.filter((i) => i.code === 'live2d-animation-replaced').map((i) => i.severity)).toEqual(['info', 'info', 'warning']);
  });

  it('honours the physics, display info, motion and expression options', () => {
    const merge = importLive2dModel3(fixture('mini.model3.json'), fixtureReader, { model: miniRaw(), physics: 'merge', displayInfo: 'overwrite', expressions: false });
    const doc = applyOps(miniRaw(), merge.ops).doc as Doc;
    expect(doc.physics.map((g) => g.id)).toEqual(['oldHair', 'PhysicsSetting1', 'PhysicsSetting2']);
    expect(codes(merge.report)).toContain('live2d-physics-conflict');
    expect(doc.parameters.find((p) => p.id === 'AngleX')).toMatchObject({ description: 'Angle X', group: 'Face' });
    expect(doc.animations.map((a) => a.id)).toEqual(['wave', 'free']);
    const skip = importLive2dModel3(fixture('mini.model3.json'), fixtureReader, { model: miniRaw(), physics: 'skip', displayInfo: 'skip', motions: false });
    const doc2 = applyOps(miniRaw(), skip.ops).doc as Doc;
    expect(doc2.physics.map((g) => g.id)).toEqual(['oldHair']);
    expect(doc2.animations.map((a) => a.id)).toEqual(['wave', 'exp_Smile']);
    expect(() => importLive2dModel3('{"Version": 3}', fixtureReader, {} as never)).toThrow(/opts.model/);
    expect(() => importLive2dModel3('nope', fixtureReader, { model: miniRaw() })).toThrow(/invalid JSON/);
  });
});

describe('live2d export (all files)', () => {
  it('exports hana as motions, physics, display info and a partial model3', () => {
    const hana = hanaModel();
    const { files, report } = exportLive2d(hana);
    const byPath = new Map(files.map((f) => [f.path, JSON.parse(f.text!)]));
    expect([...byPath.keys()]).toEqual([
      'motions/idle.motion3.json',
      'motions/blink.motion3.json',
      'motions/wink.motion3.json',
      'motions/talk.motion3.json',
      'motions/nod.motion3.json',
      'motions/look_around.motion3.json',
      'hana.physics3.json',
      'hana.cdi3.json',
      'hana.model3.json',
    ]);
    for (const [path, json] of byPath) {
      if (!path.endsWith('.motion3.json')) continue;
      const n = countMotion(json);
      expect(json.Meta).toMatchObject({ CurveCount: n.curves, TotalSegmentCount: n.segments, TotalPointCount: n.points });
      expect(json.Version).toBe(3);
    }
    const model3 = byPath.get('hana.model3.json');
    expect(model3.FileReferences.Moc).toBeUndefined();
    expect(model3.FileReferences.Physics).toBe('hana.physics3.json');
    expect(model3.FileReferences.DisplayInfo).toBe('hana.cdi3.json');
    expect(model3.FileReferences.Motions.Idle).toEqual([{ File: 'motions/idle.motion3.json' }]);
    for (const group of Object.values(model3.FileReferences.Motions) as Array<Array<{ File: string }>>) for (const m of group) expect(byPath.has(m.File)).toBe(true);
    expect(model3.Groups).toEqual([
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
    ]);
    expect(report.issues.find((i) => i.code === 'live2d-model3-partial')).toMatchObject({ severity: 'info', hint: expect.stringContaining('merge') });
    expect(report.stats).toMatchObject({ motions: 6, files: 9 });
    // Deterministic.
    expect(exportLive2d(hana).files).toEqual(files);
    expect(exportLive2d(hana, { animations: ['blink'], name: 'my model' }).files.map((f) => f.path)).toEqual(['motions/blink.motion3.json', 'my_model.physics3.json', 'my_model.cdi3.json', 'my_model.model3.json']);
    expect(() => exportLive2d(hana, { animations: ['blnk'] })).toThrow(/did you mean "blink"/);
  });

  it('round-trips hana: export all, import the model3 into hana without animations, same motion', () => {
    const hana = hanaModel();
    const { files } = exportLive2d(hana);
    const texts = new Map(files.map((f) => [f.path, f.text!]));
    const target = hanaRaw();
    target.animations = [];
    const { ops, report } = importLive2dModel3(texts.get('hana.model3.json')!, (p) => texts.get(p), { model: target });
    expect(codes(report)).not.toContain('live2d-unknown-parameter');
    const res = applyOps(target, ops);
    expect(res.ok).toBe(true);
    const back = normalize(res.doc);
    expect(back.animations.map((a) => a.id).sort()).toEqual(hana.animations.map((a) => a.id).sort());
    for (const a of hana.animations) {
      const b = back.animations.find((x) => x.id === a.id)!;
      expect(b.duration).toBe(a.duration);
      expect(b.loop).toBe(a.loop);
      for (let i = 0; i < 60; i++) {
        const t = (a.duration * (i + 0.37)) / 60;
        const p = sampleParams(hana, a.id, t);
        const q = sampleParams(back, a.id, t);
        for (const param of hana.parameters) {
          const range = param.max - param.min;
          expect(Math.abs(p[param.id] - q[param.id])).toBeLessThan(0.002 * range);
        }
      }
    }
    // Physics comes back as groups on the same parameters (approximation: stiffness folded into gravity).
    expect(back.physics.map((g) => g.outputs.map((o) => o.param))).toEqual(hana.physics.map((g) => g.outputs.map((o) => o.param)));
  });
});
