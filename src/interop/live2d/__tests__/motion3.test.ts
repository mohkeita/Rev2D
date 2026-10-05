import { describe, expect, it } from 'vitest';
import { exportLive2dMotion, IDENTITY_PARAM_MAP, importLive2dMotion } from '../index.js';
import { JUMP } from '../curves.js';
import { codes, countMotion, fixture, miniRaw, normalize, refEval, sampleParams, withAnimation } from './helpers.js';

type Json = Record<string, unknown>;
// Sample between key times: a looping rig wraps t with float noise ((1.8 + 2) % 2 = 1.7999...), which would
// put samples taken exactly at a jump on its other side.
const times = (d: number, n = 240) => Array.from({ length: n }, (_, i) => (d * (i + 0.37)) / n);

function motionFixture(name: string): Json {
  return JSON.parse(fixture(`motions/${name}.motion3.json`));
}

function curveOf(m: Json, id: string): number[] {
  return (m.Curves as Array<{ Id: string; Segments: number[] }>).find((c) => c.Id === id)!.Segments;
}

describe('live2d motion3 import', () => {
  it('imports every segment type into keys the rig plays like the Cubism runtime', () => {
    const src = motionFixture('wave');
    const { animation, report } = importLive2dMotion(fixture('motions/wave.motion3.json'), 'wave', { model: miniRaw() });
    expect(animation).toMatchObject({ id: 'wave', duration: 2, loop: true, events: [{ t: 0.5, name: 'step' }, { t: 1.5, name: '開始' }] });
    const targets = (animation.tracks as Array<{ target: string }>).map((t) => t.target);
    expect(targets).toEqual(['param:AngleX', 'param:EyeLOpen', 'param:MouthOpen', 'part:PartArm.opacity']);
    expect(report).toMatchObject({ format: 'live2d-motion3', direction: 'import', stats: { curves: 7, segments: 15, points: 26, tracks: 4, events: 2 } });

    const model = withAnimation(miniRaw(), animation);
    for (const t of times(2)) {
      const p = sampleParams(model, 'wave', t);
      expect(p.AngleX).toBeCloseTo(refEval(curveOf(src, 'ParamAngleX'), true, t), 6);
      expect(p.EyeLOpen).toBeCloseTo(refEval(curveOf(src, 'ParamEyeLOpen'), true, t), 6);
      // Inverse stepped first segment: 1 from the start; linear down; flat Bézier bump; cut at the duration.
      if (Math.abs(t - 0.5) > 2 * JUMP) expect(p.MouthOpen).toBeCloseTo(Math.min(1, refEval(curveOf(src, 'ParamMouthOpenY'), true, t)), 6);
    }
    const arm = (t: number) => {
      const { Rig } = requireRig();
      return new Rig(model).pose({ time: t, animations: [{ id: 'wave', time: t }], physics: false }).parts.PartArm.opacity;
    };
    expect(arm(1)).toBeCloseTo(0.5, 6);
  });

  it('reports every dropped or approximated feature with a location', () => {
    const { report } = importLive2dMotion(fixture('motions/wave.motion3.json'), 'wave', { model: miniRaw() });
    const byCode = new Map(report.issues.map((i) => [i.code, i]));
    expect(byCode.get('live2d-unknown-parameter')).toMatchObject({ severity: 'warning', where: 'Curves[4]', message: expect.stringContaining('ParamUnknownThing') });
    expect(byCode.get('live2d-part-opacity-dropped')).toMatchObject({ severity: 'warning', where: 'Curves[6]', message: expect.stringContaining('PartHat') });
    expect(byCode.get('live2d-model-curve-dropped')).toMatchObject({ severity: 'info', where: 'Curves[0] (Model EyeBlink)' });
    expect(byCode.get('live2d-part-opacity')).toMatchObject({ severity: 'info', where: 'Curves[5] (PartOpacity PartArm)' });
    expect(byCode.get('live2d-curve-trimmed')).toMatchObject({ severity: 'info' });
    expect(byCode.get('live2d-loop-seam')).toMatchObject({ severity: 'info' });
    // The SDK never loops by Meta.Loop (apps decide): noted, since the import makes a looping animation.
    expect(byCode.get('live2d-loop-flag')).toMatchObject({ severity: 'info', where: 'Meta.Loop' });
    for (const i of report.issues) expect(i.code).toMatch(/^live2d-[a-z0-9-]+$/);
    expect(codes(report)).not.toContain('live2d-meta-count-mismatch');
  });

  it('applies Model EyeBlink curves to the EyeBlink group (multiplied into an existing curve)', () => {
    const src = motionFixture('wave');
    const { animation, report } = importLive2dMotion(src, 'wave', { model: miniRaw(), groups: { EyeBlink: ['ParamEyeLOpen', 'ParamEyeROpen'], LipSync: ['ParamMouthOpenY'] } });
    expect(codes(report)).toEqual(expect.arrayContaining(['live2d-model-curve-combined', 'live2d-model-curve-applied']));
    const model = withAnimation(miniRaw(), animation);
    const blink = curveOf(src, 'EyeBlink');
    for (const t of [0, 1, 1.5, 1.55, 1.6, 1.65, 1.7, 1.9]) {
      const p = sampleParams(model, 'wave', t);
      expect(p.EyeROpen).toBeCloseTo(refEval(blink, true, t), 6);
      expect(p.EyeLOpen).toBeCloseTo(refEval(blink, true, t) * refEval(curveOf(src, 'ParamEyeLOpen'), true, t), 6);
    }
  });

  it('keeps every parameter curve without a target model (ids through the map)', () => {
    const { animation, report } = importLive2dMotion(fixture('motions/wave.motion3.json'), 'wave');
    expect((animation.tracks as Array<{ target: string }>).map((t) => t.target)).toEqual(['param:AngleX', 'param:EyeLOpen', 'param:MouthOpen', 'param:ParamUnknownThing']);
    expect(report.issues.find((i) => i.code === 'live2d-part-opacity-dropped')?.message).toContain('no target model');
    const identity = importLive2dMotion(fixture('motions/wave.motion3.json'), 'wave', { paramMap: IDENTITY_PARAM_MAP });
    expect((identity.animation.tracks as Array<{ target: string }>)[0].target).toBe('param:ParamAngleX');
  });

  it('imports unrestricted Béziers exactly (true time curve) and reports curve fades', () => {
    const src = motionFixture('free');
    const { animation, report } = importLive2dMotion(src, 'free', { model: miniRaw() });
    expect(animation).toMatchObject({ duration: 1, loop: false });
    const keys = (animation.tracks as Array<{ keys: Array<{ ease?: unknown }> }>)[0].keys;
    expect(keys[0].ease).toEqual([0.2, 1, 0.6, 1]);
    const model = withAnimation(miniRaw(), animation);
    const seg = curveOf(src, 'ParamAngleY');
    // First Bézier (handles inside the segment): exact.
    for (const t of times(0.5, 100)) expect(sampleParams(model, 'free', t).AngleY).toBeCloseTo(refEval(seg, false, t), 5);
    // Second Bézier: a handle at t = 1.05 lies after the segment end, so it is sampled at the motion's 30 fps.
    for (let k = 15; k <= 30; k++) expect(sampleParams(model, 'free', k / 30).AngleY).toBeCloseTo(refEval(seg, false, k / 30), 5);
    expect(report.issues.find((i) => i.code === 'live2d-bezier-sampled')).toMatchObject({ severity: 'warning', message: expect.stringContaining('1 Bézier segment(s)') });
    expect(report.issues.find((i) => i.code === 'live2d-fade-ignored')?.message).toContain('1 curve(s) with their own fades');
    expect(report.stats.freeBezierHandles).toBe(2);
  });

  it('checks Meta counts, versions and malformed curves', () => {
    const bad = {
      Version: 2,
      Meta: { Fps: 30, CurveCount: 3, TotalSegmentCount: 9, TotalPointCount: 1, UserDataCount: 5 },
      Curves: [
        { Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 1.5, 10] },
        { Target: 'Parameter', Id: 'ParamAngleY', Segments: [0, 0, 9, 1, 1] },
        { Target: 'Parameter', Segments: [0, 0, 0, 1, 1] },
        'nope',
      ],
      UserData: [{ Time: 9, Value: 'late' }, { Time: 0.2 }],
    };
    const { animation, report } = importLive2dMotion(bad, 'bad', { model: miniRaw() });
    expect(animation.duration).toBe(1.5);
    const c = codes(report);
    expect(c).toEqual(expect.arrayContaining(['live2d-version', 'live2d-duration-missing', 'live2d-meta-count-mismatch', 'live2d-curve-invalid', 'live2d-userdata-out-of-range', 'live2d-userdata-invalid']));
    expect(report.issues.filter((i) => i.code === 'live2d-meta-count-mismatch' && i.severity === 'warning').map((i) => i.where)).toEqual(['Meta.CurveCount', 'Meta.TotalSegmentCount', 'Meta.TotalPointCount']);
    expect(report.issues.find((i) => i.where === 'Meta.UserDataCount')).toMatchObject({ severity: 'info' });
    expect(report.issues.find((i) => i.code === 'live2d-curve-invalid' && i.where?.includes('Segments[2]'))?.message).toContain('unknown segment type 9');
    expect(() => importLive2dMotion('{"Curves": 3}', 'x')).toThrow(/Curves/);
    expect(() => importLive2dMotion('[1]', 'x')).toThrow(/JSON object/);
    expect(() => importLive2dMotion('{', 'x')).toThrow(/invalid JSON/);
  });

  it('warns when the curve order makes the Cubism SDK skip curves', () => {
    const doc = motionFixture('wave');
    const curves = doc.Curves as Json[];
    // A Parameter curve after a PartOpacity curve: the SDK stops at it (and never reads the rest).
    doc.Curves = [...curves.slice(0, 5), curves[5], curves[1], curves[6]];
    (doc.Meta as Json).CurveCount = 8;
    (doc.Meta as Json).TotalSegmentCount = 17;
    (doc.Meta as Json).TotalPointCount = 30;
    const { report } = importLive2dMotion(doc, 'wave', { model: miniRaw() });
    expect(report.issues.find((i) => i.code === 'live2d-curve-order')).toMatchObject({
      severity: 'warning',
      where: 'Curves[6]',
      message: expect.stringContaining('Curves[6] (Parameter ParamAngleX)'),
    });
    expect(report.issues.find((i) => i.code === 'live2d-curve-order')?.message).toContain('the 1 curve(s) after it');
    expect(codes(importLive2dMotion(motionFixture('wave'), 'wave', { model: miniRaw() }).report)).not.toContain('live2d-curve-order');
  });

  it('warns when nothing of a motion can be imported', () => {
    const doc = { Version: 3, Meta: { Duration: 1, Fps: 30, CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 2 }, Curves: [{ Target: 'Parameter', Id: 'ParamTail', Segments: [0, 0, 0, 1, 1] }] };
    const { animation, report } = importLive2dMotion(doc, 'tail', { model: miniRaw() });
    expect(animation.tracks).toEqual([]);
    expect(report.issues.find((i) => i.code === 'live2d-motion-empty')).toMatchObject({ severity: 'warning', message: expect.stringContaining('"tail" is empty') });
    // User data alone is something.
    const withEvent = importLive2dMotion({ ...doc, UserData: [{ Time: 0.5, Value: 'go' }] }, 'tail', { model: miniRaw() });
    expect(codes(withEvent.report)).not.toContain('live2d-motion-empty');
  });

  it('reads Cubism 2 parameter ids (PARAM_ANGLE_X) by their Cubism 3 names, in curves and model3 groups', () => {
    const doc = {
      Version: 3,
      Meta: { Duration: 1, Fps: 30, Loop: false, AreBeziersRestricted: true, CurveCount: 4, TotalSegmentCount: 4, TotalPointCount: 8 },
      Curves: [
        { Target: 'Model', Id: 'EyeBlink', Segments: [0, 1, 0, 1, 0] },
        { Target: 'Parameter', Id: 'PARAM_ANGLE_X', Segments: [0, 0, 0, 1, 30] },
        { Target: 'Parameter', Id: 'PARAM_MOUTH_OPEN_Y', Segments: [0, 0, 0, 1, 1] },
        { Target: 'Parameter', Id: 'PARAM_BOWL_LID', Segments: [0, 0, 0, 1, 1] },
      ],
    };
    const { animation, report } = importLive2dMotion(doc, 'legacy', { model: miniRaw(), groups: { EyeBlink: ['PARAM_EYE_L_OPEN'] } });
    expect((animation.tracks as Array<{ target: string }>).map((t) => t.target)).toEqual(['param:AngleX', 'param:MouthOpen', 'param:EyeLOpen']);
    const legacy = report.issues.find((i) => i.code === 'live2d-legacy-id');
    expect(legacy).toMatchObject({ severity: 'info', where: 'Curves' });
    expect(legacy?.message).toContain('PARAM_ANGLE_X -> ParamAngleX (AngleX)');
    expect(legacy?.message).toContain('PARAM_MOUTH_OPEN_Y -> ParamMouthOpenY (MouthOpen)');
    expect(legacy?.message).toContain('PARAM_EYE_L_OPEN -> ParamEyeLOpen (EyeLOpen)');
    // Ids without a Cubism 3 counterpart in the model are still reported as unknown.
    expect(report.issues.find((i) => i.code === 'live2d-unknown-parameter')?.message).toContain('PARAM_BOWL_LID');
  });
});

// Imported lazily to keep the top of the file focused on the converter.
import { Rig } from '../../../core/rig.js';
function requireRig() {
  return { Rig };
}

describe('live2d motion3 export', () => {
  const anim = {
    id: 'act',
    duration: 2,
    loop: false,
    tracks: [
      { target: 'param:AngleX', keys: [{ t: 0, v: 0, ease: 'smooth' }, { t: 0.6, v: 25, ease: 'smooth' }, { t: 1.4, v: -20, ease: 'smooth' }, { t: 2, v: 0 }] },
      { target: 'param:MouthOpen', keys: [{ t: 0, v: 0, ease: 'step' }, { t: 0.5, v: 1, ease: 'inQuad' }, { t: 1.5, v: 0.2 }] },
      { target: 'param:MouthForm', keys: [{ t: 0.2, v: -1, ease: [0.42, 0, 0.58, 1] }, { t: 1.2, v: 1 }] },
      { target: 'param:BrowLY', keys: [{ t: 0, v: 0, ease: 'inOutSine' }, { t: 1, v: 1, ease: 'outBack' }, { t: 2, v: -1 }] },
      { target: 'param:Cheek', keys: [{ t: 0, v: 0.7 }] },
      { target: 'part:PartArm.opacity', keys: [{ t: 0, v: 1 }, { t: 2, v: 0 }] },
      { target: 'part:face.tint', keys: [{ t: 0, v: '#ffffff' }, { t: 1, v: '#ff8080' }] },
    ],
    events: [{ t: 0.5, name: '開始' }, { t: 1, name: 'hit', data: { power: 3 } }],
  };

  it('writes exact Meta counts, mapped ids and user data', () => {
    const model = withAnimation(miniRaw(), anim);
    const { motion3, report } = exportLive2dMotion(model, 'act');
    const meta = motion3.Meta as Json;
    const recount = countMotion(motion3);
    expect(meta).toMatchObject({ Duration: 2, Fps: 30, Loop: false, CurveCount: recount.curves, TotalSegmentCount: recount.segments, TotalPointCount: recount.points, UserDataCount: 2, TotalUserDataSize: 6 + 3 });
    expect(Object.keys(meta)).toEqual(['Duration', 'Fps', 'Loop', 'AreBeziersRestricted', 'CurveCount', 'TotalSegmentCount', 'TotalPointCount', 'UserDataCount', 'TotalUserDataSize']);
    expect((motion3.Curves as Array<{ Target: string; Id: string }>).map((c) => `${c.Target}:${c.Id}`)).toEqual([
      'Parameter:ParamAngleX',
      'Parameter:ParamMouthOpenY',
      'Parameter:ParamMouthForm',
      'Parameter:ParamBrowLY',
      'Parameter:ParamCheek',
      'PartOpacity:PartArm',
    ]);
    // The CSS ease [0.42, 0, 0.58, 1] has handles off the thirds: the file must not claim restricted Béziers.
    expect(meta.AreBeziersRestricted).toBe(false);
    expect(motion3.UserData).toEqual([{ Time: 0.5, Value: '開始' }, { Time: 1, Value: 'hit' }]);
    // A single key becomes one constant segment (the SDK cannot evaluate a lone point).
    expect(curveOf(motion3, 'ParamCheek')).toEqual([0, 0.7, 0, 2, 0.7]);
    const c = codes(report);
    expect(c).toEqual(expect.arrayContaining(['live2d-track-unsupported', 'live2d-event-data-dropped', 'live2d-ease-approximated', 'live2d-ease-exact', 'live2d-part-opacity-exported']));
    expect(report.issues.find((i) => i.code === 'live2d-track-unsupported')?.where).toBe('animations.act.tracks[6] (part:face.tint)');
    expect(report.issues.find((i) => i.code === 'live2d-ease-exact')?.message).toMatch(/smooth.*inQuad|inQuad.*smooth/);
  });

  it('plays back in Cubism like in Rev2D (exact eases to rounding, sine within the tolerance)', () => {
    const model = withAnimation(miniRaw(), anim);
    const { motion3 } = exportLive2dMotion(model, 'act');
    const restricted = (motion3.Meta as Json).AreBeziersRestricted as boolean;
    for (const t of times(2)) {
      const p = sampleParams(model, 'act', t);
      expect(refEval(curveOf(motion3, 'ParamAngleX'), restricted, t)).toBeCloseTo(p.AngleX, 4);
      expect(refEval(curveOf(motion3, 'ParamMouthOpenY'), restricted, t)).toBeCloseTo(p.MouthOpen, 5);
      expect(refEval(curveOf(motion3, 'ParamMouthForm'), restricted, t)).toBeCloseTo(p.MouthForm, 5);
      // outBack overshoots below -1; the rig (and the Cubism core) clamp to the parameter range.
      const brow = Math.max(-1, Math.min(1, refEval(curveOf(motion3, 'ParamBrowLY'), restricted, t)));
      expect(Math.abs(brow - p.BrowLY)).toBeLessThan(0.001 * 2);
    }
  });

  it('round-trips Rev2D -> motion3 -> Rev2D', () => {
    const model = withAnimation(miniRaw(), anim);
    const { motion3 } = exportLive2dMotion(model, 'act');
    const back = importLive2dMotion(JSON.parse(JSON.stringify(motion3)), 'act', { model: miniRaw() });
    const model2 = withAnimation(miniRaw(), back.animation);
    expect(back.animation).toMatchObject({ duration: 2, loop: false, events: [{ t: 0.5, name: '開始' }, { t: 1, name: 'hit' }] });
    for (const t of times(2)) {
      const a = sampleParams(model, 'act', t);
      const b = sampleParams(model2, 'act', t);
      for (const id of ['AngleX', 'MouthOpen', 'MouthForm', 'Cheek']) expect(b[id]).toBeCloseTo(a[id], 4);
      expect(Math.abs(b.BrowLY - a.BrowLY)).toBeLessThan(0.004);
    }
    expect(codes(back.report)).not.toContain('live2d-meta-count-mismatch');
  });

  it('bakes track offsets, wrapping looping tracks around the duration', () => {
    const loopAnim = {
      id: 'walk',
      duration: 2,
      loop: true,
      tracks: [
        { target: 'param:AngleX', keys: [{ t: 0, v: -10, ease: 'smooth' }, { t: 1, v: 10, ease: 'smooth' }, { t: 2, v: -10 }] },
        { target: 'param:AngleY', offset: 0.5, keys: [{ t: 0, v: -10, ease: 'smooth' }, { t: 1, v: 10, ease: 'smooth' }, { t: 2, v: -10 }] },
        // Ends before the duration: Rev2D holds, so must Cubism (a hold segment to the loop end).
        { target: 'param:AngleZ', keys: [{ t: 0, v: 0 }, { t: 1, v: 20 }] },
        // A non-seamless loop with an offset: the seam becomes a jump.
        { target: 'param:BodyAngleX', offset: 0.75, keys: [{ t: 0, v: 0 }, { t: 2, v: 8 }] },
      ],
    };
    const model = withAnimation(miniRaw(), loopAnim);
    const { motion3, report } = exportLive2dMotion(model, 'walk');
    expect(codes(report)).toEqual(expect.arrayContaining(['live2d-track-offset-baked', 'live2d-loop-extra-frame']));
    const restricted = (motion3.Meta as Json).AreBeziersRestricted as boolean;
    expect(restricted).toBe(true);
    expect(curveOf(motion3, 'ParamAngleZ').slice(-3)).toEqual([0, 2, 20]);
    for (const t of times(2)) {
      const p = sampleParams(model, 'walk', t);
      expect(refEval(curveOf(motion3, 'ParamAngleX'), restricted, t)).toBeCloseTo(p.AngleX, 4);
      expect(refEval(curveOf(motion3, 'ParamAngleY'), restricted, t)).toBeCloseTo(p.AngleY, 4);
      expect(refEval(curveOf(motion3, 'ParamAngleZ'), restricted, t)).toBeCloseTo(p.AngleZ, 5);
      expect(refEval(curveOf(motion3, 'ParamBodyAngleX'), restricted, t)).toBeCloseTo(p.BodyAngleX, 5);
    }
    // Non-looping offset: shifted, holding the first value before it.
    const shifted = withAnimation(miniRaw(), { id: 's', duration: 2, loop: false, tracks: [{ target: 'param:AngleX', offset: 0.3, keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }] }] });
    const s = exportLive2dMotion(shifted, 's').motion3;
    for (const t of times(2)) expect(refEval(curveOf(s, 'ParamAngleX'), true, t)).toBeCloseTo(sampleParams(shifted, 's', t).AngleX, 6);
  });

  it('runs every curve of a non-looping motion to the Duration (Cubism holds nothing past the last point when looping)', () => {
    const model = withAnimation(miniRaw(), anim);
    const { motion3 } = exportLive2dMotion(model, 'act');
    for (const c of motion3.Curves as Array<{ Id: string; Segments: number[] }>) {
      const s = c.Segments;
      let i = 2;
      let end = s[0];
      while (i < s.length) {
        end = s[i] === 1 ? s[i + 5] : s[i + 1];
        i += s[i] === 1 ? 7 : 3;
      }
      expect({ id: c.Id, end }).toEqual({ id: c.Id, end: 2 });
    }
    // MouthForm's last key is at 1.2 s: the curve holds its value from there to the Duration.
    expect(curveOf(motion3, 'ParamMouthForm').slice(-3)).toEqual([0, 2, 1]);
    // Played looped by the SDK (MotionBehavior V2), a curve blends from its last point back to its first
    // over [last point, Duration + 1/Fps]: with the hold, only during the extra frame.
    const loopValue = (segments: number[], t: number, duration: number, fps: number) => {
      let last = segments[0];
      for (let k = 2; k < segments.length; k += segments[k] === 1 ? 7 : 3) last = segments[k] === 1 ? segments[k + 5] : segments[k + 1];
      if (t < last) return refEval(segments, true, t);
      const end = refEval(segments, true, last);
      return end + ((segments[1] - end) * (t - last)) / (duration + 1 / fps - last);
    };
    expect(loopValue(curveOf(motion3, 'ParamMouthForm'), 1.9, 2, 30)).toBeCloseTo(sampleParams(model, 'act', 1.9).MouthForm, 6);
  });

  it('tells exact eases apart from approximations with a negligible error', () => {
    const model = withAnimation(miniRaw(), {
      id: 'tiny',
      duration: 2,
      loop: false,
      tracks: [{ target: 'param:AngleX', keys: [{ t: 0, v: 0, ease: 'inQuad' }, { t: 1, v: 20, ease: 'inOutSine' }, { t: 2, v: 20.001 }] }],
    });
    const { report } = exportLive2dMotion(model, 'tiny');
    const msg = report.issues.find((i) => i.code === 'live2d-ease-exact')?.message ?? '';
    expect(msg).toContain('written as exact Bézier segments: 1 inQuad');
    expect(msg).toContain("within 0.01 % of their track's largest change: 1 inOutSine");
  });

  it('rejects unknown animations with a hint', () => {
    expect(() => exportLive2dMotion(normalize(miniRaw()), 'wav')).toThrow(/unknown animation "wav".*did you mean "wave"/);
  });
});
