import { describe, expect, it } from 'vitest';
import { parseColor } from '../../core/color.js';
import { Rig } from '../../core/rig.js';
import type { AnimationLayer, Pose } from '../../core/types.js';
import { validateModel } from '../../core/validate.js';
import { formatDiagnostics } from '../../core/validate.js';
import { applyFail, applyOk, find } from './fixtures.js';

type Raw = Record<string, any>;

/**
 * A face with bindings on every animated parameter and animations of every kind:
 *   idle   2 s loop: AngleX (smooth, closed loop), BodyY (inOutSine), bone:head.x (offset 0.5), part:face.tint, event "step"
 *   talk   1 s once: MouthOpen, AngleX (shared with idle), event "mid"
 *   blink  0.3 s once: EyeOpen (starts and ends at its default 1)
 *   blush  0.5 s once: Blush held at 1 (not its default 0)
 *   sway   1 s loop: BodyY (shared with idle), bone:head.rotation
 */
function composeDoc(): Raw {
  return {
    format: 'rev2d',
    version: 1,
    meta: { name: 'compose', width: 200, height: 200, fps: 20 },
    parameters: [
      { id: 'AngleX', min: -30, max: 30 },
      { id: 'BodyY', min: -10, max: 10 },
      { id: 'MouthOpen', min: 0, max: 1 },
      { id: 'EyeOpen', min: 0, max: 1, default: 1 },
      { id: 'Blush', min: 0, max: 1 },
    ],
    bones: [
      { id: 'root', x: 100, y: 150 },
      { id: 'head', parent: 'root', x: 0, y: -60, length: 20 },
    ],
    parts: [
      { id: 'face', parent: 'head', shape: { type: 'ellipse', cx: 100, cy: 80, rx: 40, ry: 45 }, fill: '#ffcc99', tint: '#ffffff' },
      { id: 'mouth', parent: 'head', shape: { type: 'ellipse', cx: 100, cy: 100, rx: 10, ry: 2 }, fill: '#aa3333', z: 1 },
      { id: 'eye', parent: 'head', shape: { type: 'ellipse', cx: 85, cy: 75, rx: 5, ry: 6 }, fill: '#222222', z: 1 },
      { id: 'cheek', parent: 'head', shape: { type: 'ellipse', cx: 120, cy: 90, rx: 6, ry: 4 }, fill: '#ff8080', opacity: 0, z: 1 },
    ],
    bindings: [
      { target: 'bone:head.rotation', params: ['AngleX'], keys: [{ at: [-30], value: -15 }, { at: [30], value: 15 }] },
      { target: 'bone:root.y', params: ['BodyY'], keys: [{ at: [-10], value: 140 }, { at: [10], value: 160 }] },
      { target: 'part:mouth.shape.ry', params: ['MouthOpen'], keys: [{ at: [0], value: 2 }, { at: [1], value: 12 }] },
      { target: 'part:eye.shape.ry', params: ['EyeOpen'], keys: [{ at: [0], value: 0.5 }, { at: [1], value: 6 }] },
      { target: 'part:cheek.opacity', params: ['Blush'], keys: [{ at: [0], value: 0 }, { at: [1], value: 1 }] },
    ],
    animations: [
      {
        id: 'idle',
        duration: 2,
        tracks: [
          { target: 'param:AngleX', keys: [{ t: 0, v: -10, ease: 'smooth' }, { t: 0.7, v: 12, ease: 'smooth' }, { t: 2, v: -10 }] },
          { target: 'param:BodyY', keys: [{ t: 0, v: 0, ease: 'inOutSine' }, { t: 1, v: 3, ease: 'inOutSine' }, { t: 2, v: 0 }] },
          { target: 'bone:head.x', offset: 0.5, keys: [{ t: 0, v: 0 }, { t: 1, v: 4 }, { t: 2, v: 0 }] },
          { target: 'part:face.tint', keys: [{ t: 0, v: '#ffffff' }, { t: 1, v: '#ffe0e0' }, { t: 2, v: '#ffffff' }] },
        ],
        events: [{ t: 0.25, name: 'step' }],
      },
      {
        id: 'talk',
        duration: 1,
        loop: false,
        tracks: [
          { target: 'param:MouthOpen', keys: [{ t: 0, v: 0 }, { t: 0.25, v: 1, ease: 'outQuad' }, { t: 0.5, v: 0.2 }, { t: 0.75, v: 0.9 }, { t: 1, v: 0 }] },
          { target: 'param:AngleX', keys: [{ t: 0, v: 0 }, { t: 0.5, v: 8, ease: 'inOutSine' }, { t: 1, v: 0 }] },
        ],
        events: [{ t: 0.5, name: 'mid', data: { word: 'hi' } }],
      },
      { id: 'blink', duration: 0.3, loop: false, tracks: [{ target: 'param:EyeOpen', keys: [{ t: 0, v: 1 }, { t: 0.15, v: 0 }, { t: 0.3, v: 1 }] }] },
      { id: 'blush', duration: 0.5, loop: false, tracks: [{ target: 'param:Blush', keys: [{ t: 0.1, v: 1 }, { t: 0.4, v: 0.6 }] }] },
      {
        id: 'sway',
        duration: 1,
        tracks: [
          { target: 'param:BodyY', keys: [{ t: 0, v: -2 }, { t: 0.5, v: 2 }, { t: 1, v: -2 }] },
          { target: 'bone:head.rotation', keys: [{ t: 0, v: 0 }, { t: 0.5, v: 6 }, { t: 1, v: 0 }] },
        ],
      },
    ],
  };
}

function rigOf(doc: unknown): Rig {
  const { model, diagnostics } = validateModel(doc);
  if (!model) throw new Error(formatDiagnostics(diagnostics));
  return new Rig(model);
}

/** Everything a viewer sees that animations drive: parameters, bound/animated properties, bone joints. */
function expectSamePose(a: Pose, b: Pose, at: string, tol: number): void {
  for (const [id, v] of Object.entries(a.params)) expect(b.params[id], `${at} param ${id}`).toBeCloseTo(v, -Math.log10(tol));
  const keys = new Set([...Object.keys(a.properties), ...Object.keys(b.properties)]);
  for (const key of keys) {
    const va = a.properties[key];
    const vb = b.properties[key];
    if (typeof va === 'string' && va.startsWith('#')) {
      // Colours are written as 8-bit hex: allow one step of rounding per channel.
      const ca = parseColor(va)!;
      const cb = parseColor(vb as string)!;
      ca.forEach((c, i) => expect(Math.abs(cb[i] - c) * 255, `${at} ${key} (${va} vs ${vb})`).toBeLessThanOrEqual(1.01));
    } else if (typeof va === 'string' || typeof vb === 'string') {
      expect(vb, `${at} ${key}`).toBe(va);
    } else if (Array.isArray(va)) {
      (va as number[]).forEach((x, i) => expect((vb as number[])[i], `${at} ${key}[${i}]`).toBeCloseTo(x, -Math.log10(tol * 10)));
    } else {
      expect(vb, `${at} ${key}`).toBeCloseTo(va as number, -Math.log10(tol * 10));
    }
  }
  for (const [id, bone] of Object.entries(a.bones)) {
    expect(b.bones[id].x, `${at} bone ${id}.x`).toBeCloseTo(bone.x, 2);
    expect(b.bones[id].y, `${at} bone ${id}.y`).toBeCloseTo(bone.y, 2);
  }
}

/** Compare layered playback with the composed animation at every sample time in [0, end]. */
function expectMatchesLayers(doc: Raw, id: string, layers: Array<string | AnimationLayer>, fps: number, opts: { tol?: number; loop?: boolean } = {}): void {
  const rig = rigOf(doc);
  const anim = find(doc, 'animations', id);
  const n = Math.round(anim.duration * fps);
  for (let j = 0; j <= n; j++) {
    const time = Math.min(anim.duration, j / fps);
    if (opts.loop && time >= anim.duration - 1e-9) continue; // a loop shows t = duration as t = 0
    const layered = rig.pose({ time, animations: layers, physics: false });
    const composed = rig.pose({ time, animations: [id], physics: false });
    expectSamePose(layered, composed, `t=${time}`, opts.tol ?? 1e-4);
  }
}

const trackOf = (doc: Raw, anim: string, target: string) => find(doc, 'animations', anim).tracks.find((t: Raw) => t.target === target);

describe('compose', () => {
  it('bakes shared targets, copies the others, and plays like the layers (idle + talk add + blink one-shot)', () => {
    const layers: AnimationLayer[] = [
      { id: 'idle' },
      { id: 'talk', mode: 'add', start: 0.5, hold: false },
      { id: 'blink', start: 1.2, hold: false },
    ];
    const { doc, messages } = applyOk(composeDoc(), [
      {
        op: 'compose',
        id: 'idleTalk',
        layers: [{ animation: 'idle' }, { animation: 'talk', mode: 'add', start: 0.5, hold: false }, { animation: 'blink', start: 1.2, hold: false }],
      },
    ]);
    const anim = find(doc, 'animations', 'idleTalk');
    // Not every layer loops -> a one-shot; duration = the longest layer (idle's 2 s loop).
    expect(anim.duration).toBe(2);
    expect(anim.loop).toBe(false);
    // One-shot layers whose ends are at rest: copied, shifted by start, eases kept.
    expect(trackOf(doc, 'idleTalk', 'param:MouthOpen').keys).toEqual([
      { t: 0.5, v: 0 },
      { t: 0.75, v: 1, ease: 'outQuad' },
      { t: 1, v: 0.2 },
      { t: 1.25, v: 0.9 },
      { t: 1.5, v: 0 },
    ]);
    expect(trackOf(doc, 'idleTalk', 'param:EyeOpen').keys.map((k: Raw) => k.t)).toEqual([1.2, 1.35, 1.5]);
    // idle (a 2 s loop played once from 0 inside the 2 s one-shot) copies as is when nothing wraps.
    expect(trackOf(doc, 'idleTalk', 'param:BodyY')).toEqual(find(doc, 'animations', 'idle').tracks[1]);
    // Shared AngleX, and idle's offset track (the offset wraps inside a loop only), are baked as linear keys.
    const angle = trackOf(doc, 'idleTalk', 'param:AngleX');
    expect(angle.keys.length).toBeGreaterThan(5);
    expect(angle.keys.every((k: Raw) => k.ease === undefined)).toBe(true);
    expect(messages[0]).toMatch(
      /^composed animation "idleTalk" as \/animations\/5 \(2 s, once\) from 3 layers \(idle, talk, blink\); copied 4 tracks \(param:BodyY, part:face\.tint, param:MouthOpen, param:EyeOpen\); baked 2 tracks at 60 fps \(param:AngleX: idle \+ talk → \d+ keys; bone:head\.x: "idle" loops every 2 s inside a one-shot composition with a track offset → \d+ keys\); merged 2 events$/,
    );
    expect(anim.events).toEqual([
      { t: 0.25, name: 'step' },
      { t: 1, name: 'mid', data: { word: 'hi' } },
    ]);
    // Baked at 60 fps (not meta.fps 20): exact at every 1/60 s sample.
    expectMatchesLayers(doc, 'idleTalk', layers, 60);
  });

  it('bakes at 60 fps by default, whatever meta.fps says', () => {
    const doc = composeDoc();
    delete doc.meta.fps;
    const { messages } = applyOk(doc, [{ op: 'compose', id: 'both', layers: ['idle', 'talk'] }]);
    expect(messages[0]).toContain('baked 2 tracks at 60 fps');
    doc.meta.fps = 12;
    expect(applyOk(doc, [{ op: 'compose', id: 'both', layers: ['idle', 'talk'] }]).messages[0]).toContain('at 60 fps');
    expect(applyOk(doc, [{ op: 'compose', id: 'both', layers: ['idle', 'talk'], fps: 24 }]).messages[0]).toContain('at 24 fps');
  });

  it('warns when source keys or hold:false boundaries fall between bake samples, with an fps that hits them all', () => {
    // talk at 0.51 s: its keys (0.51, 1.01, 1.51) and window (0.51..1.51) are off the 1/60 s grid.
    const layers = ['idle', { animation: 'talk', mode: 'add', start: 0.51, hold: false }];
    const { messages } = applyOk(composeDoc(), [{ op: 'compose', id: 'late', layers }]);
    expect(messages[0]).toContain(
      'WARNING: 3 source times of the baked tracks fall between the 60 fps bake samples, so the baked keys can miss the values there: 0.51 s ("talk" key, "talk" start), 1.01 s ("talk" key), 1.51 s ("talk" key, "talk" end); "fps": 100 puts a sample on each',
    );
    // Following the advice removes the warning, and the bake is exact at the source times.
    const fixed = applyOk(composeDoc(), [{ op: 'compose', id: 'late', layers, fps: 100 }]);
    expect(fixed.messages[0]).toContain('baked 2 tracks at 100 fps');
    expect(fixed.messages[0]).not.toContain('WARNING');
    const rig = rigOf(fixed.doc);
    const stack: AnimationLayer[] = [{ id: 'idle' }, { id: 'talk', mode: 'add', start: 0.51, hold: false }];
    for (const time of [0.51, 0.76, 1.01, 1.26, 1.51]) {
      expectSamePose(rig.pose({ time, animations: stack, physics: false }), rig.pose({ time, animations: ['late'], physics: false }), `t=${time}`, 1e-4);
    }
    // Loops list their keys every cycle; a time no rate up to 1000 fps hits gets a different fix.
    const odd = composeDoc();
    odd.animations[0].tracks[0].keys[1].t = 0.7001; // idle AngleX key: only multiples of 10000 fps sample it
    const r = applyOk(odd, [{ op: 'compose', id: 'x', layers: ['idle', 'talk'], duration: 2 }]);
    expect(r.messages[0]).toContain('0.7001 s ("idle" key)');
    expect(r.messages[0]).toContain('no "fps" up to 1000 samples them all: move those keys and starts onto multiples of 1/60 s, or raise "fps" to shrink the error');
  });

  it('merges several layers of the same one-shot animation with disjoint windows into one exact key list', () => {
    // blink starts and ends at its default (EyeOpen 1): holding layers contribute rest outside their windows.
    const layers: AnimationLayer[] = [{ id: 'blink', start: 0.4, hold: false }, { id: 'blink', start: 1.3, hold: false }, { id: 'blink', start: 0.7, hold: false }];
    const { doc, messages } = applyOk(composeDoc(), [{ op: 'compose', id: 'blinks', layers: layers.map((l) => ({ animation: l.id, start: l.start, hold: false })) }]);
    // 0.4..0.7 and 0.7..1.0 touch at rest (one key at 0.7); keys in time order whatever the layer order.
    expect(trackOf(doc, 'blinks', 'param:EyeOpen').keys).toEqual([
      { t: 0.4, v: 1 },
      { t: 0.55, v: 0 },
      { t: 0.7, v: 1 },
      { t: 0.85, v: 0 },
      { t: 1, v: 1 },
      { t: 1.3, v: 1 },
      { t: 1.45, v: 0 },
      { t: 1.6, v: 1 },
    ]);
    expect(messages[0]).toMatch(/^composed animation "blinks" as \/animations\/5 \(1\.6 s, once\) from 3 layers \(blink, blink, blink\); copied 1 track \(param:EyeOpen: 3 "blink" layers merged\)$/);
    const rig = rigOf(doc);
    for (const time of [0, 0.3, 0.47, 0.55, 0.7, 0.71, 0.9, 1.1, 1.38, 1.45, 1.59, 1.6]) {
      expectSamePose(rig.pose({ time, animations: layers, physics: false }), rig.pose({ time, animations: ['blinks'], physics: false }), `t=${time}`, 1e-6);
    }
    // Holding layers too (the defaults), in "add" mode, where their rest-valued holds add nothing.
    const addLayers: AnimationLayer[] = [{ id: 'blink', start: 0.2, mode: 'add' }, { id: 'blink', start: 1, mode: 'add' }];
    const held = applyOk(composeDoc(), [{ op: 'compose', id: 'twice', layers: addLayers.map((l) => ({ animation: l.id, start: l.start, mode: 'add' })) }]);
    expect(trackOf(held.doc, 'twice', 'param:EyeOpen').keys.map((k: Raw) => k.t)).toEqual([0.2, 0.35, 0.5, 1, 1.15, 1.3]);
    expect(held.messages[0]).toContain('copied 1 track (param:EyeOpen: 2 "blink" layers merged)');
    const heldRig = rigOf(held.doc);
    for (const time of [0.1, 0.35, 0.42, 0.8, 1.15, 1.3]) {
      expectSamePose(heldRig.pose({ time, animations: addLayers, physics: false }), heldRig.pose({ time, animations: ['twice'], physics: false }), `t=${time}`, 1e-6);
    }
    // A holding "override" layer merges when it comes first: later hold:false layers are not hidden.
    const firstHeld: AnimationLayer[] = [{ id: 'blink', start: 1 }, { id: 'blink', start: 0.2, hold: false }];
    const mixed = applyOk(composeDoc(), [{ op: 'compose', id: 'mixed', layers: [{ animation: 'blink', start: 1 }, { animation: 'blink', start: 0.2, hold: false }] }]);
    expect(mixed.messages[0]).toContain('param:EyeOpen: 2 "blink" layers merged');
    const mixedRig = rigOf(mixed.doc);
    for (const time of [0, 0.35, 0.6, 1.15, 1.3]) {
      expectSamePose(mixedRig.pose({ time, animations: firstHeld, physics: false }), mixedRig.pose({ time, animations: ['mixed'], physics: false }), `t=${time}`, 1e-6);
    }
  });

  it('merges hold:false layers whose values are not at rest with steps to rest between the windows', () => {
    const layers: AnimationLayer[] = [{ id: 'blush', start: 0.2, hold: false, weight: 0.5 }, { id: 'blush', start: 1.2, hold: false }];
    const { doc, messages } = applyOk(composeDoc(), [
      { op: 'compose', id: 'blushes', layers: [{ animation: 'blush', start: 0.2, hold: false, weight: 0.5 }, { animation: 'blush', start: 1.2, hold: false }], duration: 2 },
    ]);
    expect(messages[0]).toContain('param:Blush: 2 "blush" layers merged');
    expect(trackOf(doc, 'blushes', 'param:Blush').keys).toEqual([
      { t: 0, v: 0, ease: 'step' },
      { t: 0.2, v: 0.5 },
      { t: 0.3, v: 0.5 },
      { t: 0.6, v: 0.3, ease: 'step' },
      { t: 0.700001, v: 0, ease: 'step' },
      { t: 1.2, v: 1 },
      { t: 1.3, v: 1 },
      { t: 1.6, v: 0.6, ease: 'step' },
      { t: 1.700001, v: 0 },
    ]);
    const rig = rigOf(doc);
    for (const time of [0, 0.19, 0.2, 0.25, 0.45, 0.6, 0.65, 0.7, 0.71, 1, 1.2, 1.5, 1.7, 1.71, 2]) {
      expectSamePose(rig.pose({ time, animations: layers, physics: false }), rig.pose({ time, animations: ['blushes'], physics: false }), `t=${time}`, 1e-6);
    }
  });

  it('bakes several layers of one animation when a merge would not be exact, and says why', () => {
    const why = (layers: unknown[]) => applyOk(composeDoc(), [{ op: 'compose', id: 'x', layers, duration: 2 }]).messages[0];
    // Overlapping windows.
    expect(why([{ animation: 'blink', start: 0.2, hold: false }, { animation: 'blink', start: 0.4, hold: false }])).toContain(
      'baked 1 track at 60 fps (param:EyeOpen: 2 layers of "blink": their windows overlap (0.2..0.5 s and 0.4..0.7 s) → ',
    );
    // A later holding override layer hides the earlier one (at 0.35 s the eye stays open).
    const hidden = [{ animation: 'blink', start: 0.2 }, { animation: 'blink', start: 1 }];
    expect(why(hidden)).toContain('2 layers of "blink": layers[1] holds its keys outside its window in "override" mode, which hides layers[0] (give layers[1] "hold": false or "mode": "add")');
    const { doc } = applyOk(composeDoc(), [{ op: 'compose', id: 'x', layers: hidden, duration: 2 }]);
    expectMatchesLayers(doc, 'x', [{ id: 'blink', start: 0.2 }, { id: 'blink', start: 1 }], 60);
    expect(rigOf(doc).pose({ time: 0.35, animations: ['x'], physics: false }).params.EyeOpen).toBe(1);
    // A holding layer whose value outside the window is not rest.
    expect(why([{ animation: 'blush', start: 0.2 }, { animation: 'blush', start: 1, hold: false }])).toContain(
      '2 layers of "blush": layers[0] holds its first value outside its window, and that value is not the rest value (give it "hold": false)',
    );
    // Windows that touch where the value is not at rest.
    expect(why([{ animation: 'blush', start: 0.2, hold: false }, { animation: 'blush', start: 0.7, hold: false }])).toContain(
      '2 layers of "blush": their windows 0.2..0.7 s and 0.7..1.2 s touch where the value is not at rest',
    );
    // A looping animation does not merge; different animations keep the "a + b" reason.
    expect(why(['sway', { animation: 'sway', start: 0.5 }])).toContain('2 layers of "sway" (a loop: only layers of a one-shot animation merge)');
    expect(why(['idle', 'sway'])).toContain('param:BodyY: idle + sway → ');
  });

  it('copies looping tracks of a same-length loop with the start folded into the track offset (smooth keys stay exact)', () => {
    const layers: AnimationLayer[] = [{ id: 'idle', start: 0.5 }];
    const { doc, messages } = applyOk(composeDoc(), [{ op: 'compose', id: 'idleLate', layers: [{ animation: 'idle', start: 0.5 }] }]);
    const anim = find(doc, 'animations', 'idleLate');
    expect(anim.loop).toBeUndefined(); // looping (the default)
    const source = find(doc, 'animations', 'idle');
    expect(trackOf(doc, 'idleLate', 'param:AngleX')).toEqual({ ...source.tracks[0], offset: 0.5 });
    expect(trackOf(doc, 'idleLate', 'bone:head.x')).toEqual({ ...source.tracks[2], offset: 1 });
    expect(messages[0]).toContain('copied 4 tracks');
    expect(messages[0]).not.toContain('baked');
    // Exact everywhere, not only at sample times: compare off-grid too.
    const rig = rigOf(doc);
    for (const time of [0, 0.13, 0.5, 0.77, 1.31, 1.99]) {
      expectSamePose(rig.pose({ time, animations: layers, physics: false }), rig.pose({ time, animations: ['idleLate'], physics: false }), `t=${time}`, 1e-6);
    }
    expect(anim.events).toEqual([{ t: 0.75, name: 'step' }]);
  });

  it('bakes a looping composition of loops with different lengths (sway 1 s inside idle 2 s)', () => {
    const layers: AnimationLayer[] = [{ id: 'idle' }, { id: 'sway', weight: 0.5 }];
    const { doc, messages } = applyOk(composeDoc(), [{ op: 'compose', id: 'idleSway', layers: [{ animation: 'idle' }, { animation: 'sway', weight: 0.5 }], fps: 30 }]);
    expect(find(doc, 'animations', 'idleSway')).toMatchObject({ duration: 2 });
    expect(messages[0]).toContain('param:BodyY: idle + sway');
    expect(messages[0]).toContain('bone:head.rotation: "sway" loops every 1 s inside a 2 s loop');
    expect(messages[0]).not.toContain('WARNING');
    expectMatchesLayers(doc, 'idleSway', layers, 30, { loop: true });
  });

  it('scales a single layer with weight < 1 toward the rest value (exact for every ease)', () => {
    const layers: AnimationLayer[] = [{ id: 'idle', weight: 0.5 }];
    const { doc, messages } = applyOk(composeDoc(), [{ op: 'compose', id: 'idleHalf', layers: [{ animation: 'idle', weight: 0.5 }] }]);
    expect(messages[0]).not.toContain('baked');
    expect(trackOf(doc, 'idleHalf', 'param:AngleX').keys.map((k: Raw) => k.v)).toEqual([-5, 6, -5]);
    expect(trackOf(doc, 'idleHalf', 'part:face.tint').keys.map((k: Raw) => k.v)).toEqual(['#ffffff', '#fff0f0', '#ffffff']);
    const rig = rigOf(doc);
    for (const time of [0, 0.3, 0.9, 1.6]) {
      expectSamePose(rig.pose({ time, animations: layers, physics: false }), rig.pose({ time, animations: ['idleHalf'], physics: false }), `t=${time}`, 1e-3);
    }
  });

  it('steps a hold:false layer whose ends are not at rest in and out of its window', () => {
    const layers: AnimationLayer[] = [{ id: 'idle' }, { id: 'blush', start: 0.6, hold: false }];
    const { doc } = applyOk(composeDoc(), [{ op: 'compose', id: 'idleBlush', layers: ['idle', { animation: 'blush', start: 0.6, hold: false }], fps: 20 }]);
    expect(trackOf(doc, 'idleBlush', 'param:Blush').keys).toEqual([
      { t: 0, v: 0, ease: 'step' },
      { t: 0.6, v: 1 },
      { t: 0.7, v: 1 },
      { t: 1, v: 0.6, ease: 'step' },
      { t: 1.100001, v: 0 },
    ]);
    expectMatchesLayers(doc, 'idleBlush', layers, 20);
  });

  it('honours explicit duration, loop and fps, and warns when a loop does not fit the duration', () => {
    const { doc, messages } = applyOk(composeDoc(), [{ op: 'compose', id: 'short', layers: ['idle', 'sway'], duration: 1.5, fps: 10 }]);
    const anim = find(doc, 'animations', 'short');
    expect(anim).toMatchObject({ duration: 1.5 });
    expect(messages[0]).toContain('WARNING: "idle" (2 s loop), "sway" (1 s loop) do not fit a whole number of times into 1.5 s, so their cycles jump where the composition loops');
    expect(messages[0]).toContain('"duration": 2 loops seamlessly');
    for (const t of anim.tracks) for (const k of t.keys) expect(k.t).toBeLessThanOrEqual(1.5);
  });

  it('refuses an existing id unless replace, and replaces in place', () => {
    let r = applyFail(composeDoc(), [{ op: 'compose', id: 'talk', layers: ['idle'] }]);
    expect(r.message).toBe('compose: animation "talk" already exists (/animations/1)');
    expect(r.hint).toContain('"replace": true');
    const { doc, messages } = applyOk(composeDoc(), [{ op: 'compose', id: 'talk', layers: ['talk', { animation: 'blink', start: 0.2 }], replace: true }]);
    expect(doc.animations.map((a: Raw) => a.id)).toEqual(['idle', 'talk', 'blink', 'blush', 'sway']);
    expect(messages[0]).toMatch(/^replaced animation "talk" at \/animations\/1 \(1 s, once\)/);
    expect(trackOf(doc, 'talk', 'param:EyeOpen').keys.map((k: Raw) => k.t)).toEqual([0.2, 0.35, 0.5]);
  });

  it('rejects bad layers with precise hints', () => {
    let r = applyFail(composeDoc(), [{ op: 'compose', id: 'x', layers: ['idel'] }]);
    expect(r.message).toBe('unknown animation "idel"');
    expect(r.hint).toBe('did you mean "idle"?');
    r = applyFail(composeDoc(), [{ op: 'compose', id: 'x', layers: [{ animation: 'idle', weigth: 0.5 }] }]);
    expect(r.message).toBe('compose: layers[0]: unknown field "weigth"');
    expect(r.hint).toContain('did you mean "weight"?');
    r = applyFail(composeDoc(), [{ op: 'compose', id: 'x', layers: [{ animation: 'idle', mode: 'additive' }] }]);
    expect(r.message).toBe('compose: layers[0].mode must be "override" or "add", got string "additive"');
    r = applyFail(composeDoc(), [{ op: 'compose', id: 'x', layers: [{ animation: 'idle', weight: 2 }] }]);
    expect(r.message).toBe('compose: layers[0].weight must be between 0 and 1, got 2');
    r = applyFail(composeDoc(), [{ op: 'compose', id: 'x', layers: [] }]);
    expect(r.message).toBe('compose: "layers" is empty');
    r = applyFail(composeDoc(), [{ op: 'compose', id: 'x', layers: ['idle'], fps: 0 }]);
    expect(r.message).toBe('compose: "fps" must be > 0 and <= 1000, got 0');
  });

  it('needs a valid model only when it has to bake', () => {
    const doc = composeDoc();
    doc.parts[0].parent = 'nobody';
    // Copy only: fine even though the model has an error elsewhere (fixed later in the batch).
    const ok = applyOk(doc, [
      { op: 'compose', id: 'late', layers: [{ animation: 'idle', start: 0.5 }] },
      { op: 'update', kind: 'part', id: 'face', set: { parent: 'head' } },
    ]);
    expect(find(ok.doc, 'animations', 'late').tracks).toHaveLength(4);
    const r = applyFail(doc, [{ op: 'compose', id: 'both', layers: ['idle', 'talk'] }]);
    expect(r.message).toMatch(/^compose: baking param:AngleX, .* samples the layered playback, which needs a valid model, but validation reports 1 error \(first: .*nobody.* at \/parts\/0\/parent\)$/);
  });
});
