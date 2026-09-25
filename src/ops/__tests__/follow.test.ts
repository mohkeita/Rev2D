import { describe, expect, it } from 'vitest';
import { Rig } from '../../core/rig.js';
import { formatDiagnostics, validateModel } from '../../core/validate.js';
import { applyFail, applyOk, find } from './fixtures.js';

type Raw = Record<string, any>;

/**
 * A head that turns (headWarp: yaw / pitch lattice on AngleX × AngleY) and tilts (bone "head",
 * AngleZ), with a hat lattice and a hat bone attached next to it on bone "head".
 *
 *   body (200, 300) ── head (200, 200) ─┬─ headWarp [120, 100, 160, 160] 4×4  (face)
 *                                        ├─ hatWarp  [150, 40, 100, 70] 2×1   (hat)
 *                                        └─ hatBone  at (200, 100)
 */
function hatDoc(): Raw {
  const doc: Raw = {
    format: 'rev2d',
    version: 1,
    meta: { name: 'hat', width: 400, height: 400 },
    parameters: [
      { id: 'AngleX', min: -30, max: 30 },
      { id: 'AngleY', min: -30, max: 30 },
      { id: 'AngleZ', min: -30, max: 30 },
      { id: 'Tilt', min: -1, max: 1 },
      { id: 'Breath', min: 0, max: 1 },
    ],
    bones: [
      { id: 'body', x: 200, y: 300, length: 40 },
      { id: 'head', parent: 'body', x: 0, y: -100, length: 30 },
      { id: 'hatBone', parent: 'head', x: 0, y: -100, length: 40 },
    ],
    warps: [
      { id: 'headWarp', parent: 'head', rect: [120, 100, 160, 160], cols: 4, rows: 4 },
      { id: 'hatWarp', parent: 'head', rect: [150, 40, 100, 70], cols: 2, rows: 1 },
    ],
    parts: [
      { id: 'face', parent: 'headWarp', shape: { type: 'ellipse', cx: 200, cy: 180, rx: 70, ry: 75, detail: 10 }, fill: '#f2c9a0' },
      { id: 'hat', parent: 'hatWarp', z: 1, shape: { type: 'rect', x: 160, y: 50, w: 80, h: 55, detail: 10 }, fill: '#b8304a' },
    ],
    bindings: [{ target: 'bone:head.rotation', params: ['AngleZ'], keys: [{ at: [-30], value: -10 }, { at: [30], value: 10 }] }],
  };
  const keys = [];
  for (const y of [-30, 0, 30]) for (const x of [-30, 0, 30]) keys.push({ at: [x, y], yaw: x * 0.7, pitch: -y * 0.4 });
  return applyOk(doc, [{ op: 'bind_warp', warp: 'headWarp', params: ['AngleX', 'AngleY'], keys }]).doc;
}

function rigOf(doc: unknown): Rig {
  const { model, diagnostics } = validateModel(doc);
  if (!model) throw new Error(formatDiagnostics(diagnostics));
  return new Rig(model);
}

/** Distance between a setup point mapped through two parents, at several poses. */
function gap(doc: Raw, a: string, b: string, point: [number, number], params: Record<string, number>): number {
  const rig = rigOf(doc);
  const pose = rig.pose({ params, physics: false });
  const pa = rig.mapPoint(pose, a, ...point);
  const pb = rig.mapPoint(pose, b, ...point);
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
}

/** Angle (degrees) between the probe vectors through two parents. */
function turnGap(doc: Raw, a: string, b: string, [x, y]: [number, number], r: number, params: Record<string, number>): number {
  const rig = rigOf(doc);
  const pose = rig.pose({ params, physics: false });
  const dir = (id: string) => {
    const p = rig.mapPoint(pose, id, x - r, y);
    const q = rig.mapPoint(pose, id, x + r, y);
    return Math.atan2(q[1] - p[1], q[0] - p[0]);
  };
  return (Math.abs(dir(a) - dir(b)) * 180) / Math.PI;
}

const POSES: Array<Record<string, number>> = [
  { AngleX: 30 },
  { AngleX: -30, AngleY: 30 },
  { AngleY: -30 },
  { AngleX: 30, AngleY: -30, AngleZ: 30 },
  { AngleX: -12, AngleY: 7, AngleZ: -20 },
  { AngleX: 15, AngleY: 15 },
];

describe('follow op', () => {
  it('binds an accessory warp over the key grid of the followed warp so the anchor stays on the surface', () => {
    const { doc, messages } = applyOk(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [200, 105] }]);
    const binding = doc.bindings.find((b: Raw) => b.target === 'warp:hatWarp.offsets');
    expect(binding.params).toEqual(['AngleX', 'AngleY']);
    expect(binding.keys).toHaveLength(9);
    expect(binding.keys.map((k: Raw) => k.at)).toEqual([
      [-30, -30], [-30, 0], [-30, 30],
      [0, -30], [0, 0], [0, 30],
      [30, -30], [30, 0], [30, 30],
    ]);
    // A translation: every lattice point moves the same way; the rest keyform is zero.
    for (const k of binding.keys) {
      expect(k.value).toHaveLength(2 * 3 * 2);
      for (let i = 2; i < k.value.length; i += 2) expect([k.value[i], k.value[i + 1]]).toEqual([k.value[0], k.value[1]]);
    }
    expect(binding.keys[4].value.every((v: number) => v === 0)).toBe(true);
    expect(messages[0]).toMatch(
      /^added binding warp:hatWarp\.offsets ← \[AngleX, AngleY\] as \/bindings\/2 \(9 keyforms\); warp "hatWarp" follows warp "headWarp" at \(200, 105\) over AngleX \{-30, 0, 30\} × AngleY \{-30, 0, 30\} \(params of the bindings on "headWarp"\): anchor shift up to [\d.]+ px at \[-?30, -?30\]; max residual 0(\.000\d)? px at the 9 keyforms, 0(\.000\d)? px at 16 grid midpoints \(worst at \[[-\d., ]+\]\)$/,
    );
    // AngleZ tilts bone "head", which both hang from: not a follow parameter, and followed anyway.
    for (const params of POSES) expect(gap(doc, 'hatWarp', 'headWarp', [200, 105], params), JSON.stringify(params)).toBeLessThan(1e-3);
    // Without follow the hat slides across the turning head.
    expect(gap(hatDoc(), 'hatWarp', 'headWarp', [200, 105], { AngleX: 30 })).toBeGreaterThan(10);
  });

  it('defaults "at" to the centre of the accessory rect and warns when that is outside the followed warp', () => {
    const { messages } = applyOk(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp' }]);
    expect(messages[0]).toContain('follows warp "headWarp" at (200, 75) over');
    expect(messages[0]).toContain(
      'WARNING: the anchor (200, 75) is outside the rect [120, 100, 160, 160] of warp "headWarp", where the motion is extrapolated from the edge cells; give "at" a point inside it (where the accessory touches the surface)',
    );
    expect(applyOk(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: 'center' }]).messages[0]).toContain('at (200, 75) over');
  });

  it('follows the local rotation and scale with "rotate" / "scale"', () => {
    const doc = hatDoc();
    doc.bindings = [];
    const tilted = applyOk(doc, [
      { op: 'bind_warp', warp: 'headWarp', params: ['Tilt'], keys: [{ at: [-1], rotate: -15, scale: 0.9 }, { at: [0] }, { at: [1], rotate: 15, scale: 1.2 }] },
    ]).doc;
    const { doc: out, messages } = applyOk(tilted, [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [200, 105], rotate: true, scale: true }]);
    expect(messages[0]).toContain('over Tilt {-1, 0, 1} (params of the bindings on "headWarp"): anchor shift up to');
    expect(messages[0]).toMatch(/rotation up to 15°, scale 0\.9\.\.1\.2; max residual 0(\.000\d)? px, 0°, scale ×1 at the 3 keyforms/);
    for (const Tilt of [-1, -0.5, 0.3, 1]) {
      expect(gap(out, 'hatWarp', 'headWarp', [200, 105], { Tilt }), `Tilt ${Tilt}`).toBeLessThan(1e-3);
      expect(turnGap(out, 'hatWarp', 'headWarp', [200, 105], 25, { Tilt }), `Tilt ${Tilt}`).toBeLessThan(1e-3);
    }
    // The hat keeps its shape: the lattice is rotated and scaled rigidly (edge lengths in proportion).
    const rig = rigOf(out);
    const pts = rig.pose({ params: { Tilt: 1 }, physics: false }).warps.hatWarp.points;
    const edge = (i: number, j: number) => Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]);
    expect(edge(0, 2) / 100).toBeCloseTo(1.2, 3); // top edge, 100 px at rest
    expect(edge(0, 3) / 70).toBeCloseTo(1.2, 3); // left edge, 70 px at rest
    // Without "rotate" the hat only translates.
    const plain = applyOk(tilted, [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [200, 105] }]);
    expect(turnGap(plain.doc, 'hatWarp', 'headWarp', [200, 105], 25, { Tilt: 1 })).toBeCloseTo(15, 1);
  });

  it('drives a bone accessory with x / y (and rotation) bindings on top of its setup and other bindings', () => {
    const doc = hatDoc();
    doc.bindings.push({ target: 'bone:hatBone.x', params: ['Breath'], keys: [{ at: [0], value: 0 }, { at: [1], value: 5 }] });
    const { doc: out, messages } = applyOk(doc, [{ op: 'follow', bone: 'hatBone', follow: 'headWarp', rotate: true }]);
    expect(messages[0]).toMatch(/^added binding bone:hatBone\.x ← \[AngleX, AngleY\] as \/bindings\/3 \(9 keyforms\); added binding bone:hatBone\.y ← \[AngleX, AngleY\] as \/bindings\/4 \(9 keyforms\); added binding bone:hatBone\.rotation ← \[AngleX, AngleY\] as \/bindings\/5 \(9 keyforms\); bone "hatBone" follows warp "headWarp" at \(200, 100\) over/);
    // The Breath binding on x stays and adds; the new x keyforms are absolute values around the setup x 0.
    expect(messages[0]).toContain("kept 1 other binding on the accessory's targets (bone:hatBone.x ← [Breath]): the new keyforms correct on top of it (unbind it first to leave the motion to follow alone)");
    const x = out.bindings.find((b: Raw) => b.target === 'bone:hatBone.x' && b.params.length === 2);
    expect(x.keys.find((k: Raw) => k.at[0] === 0 && k.at[1] === 0).value).toBe(0);
    for (const params of POSES) expect(gap(out, 'hatBone', 'headWarp', [200, 100], params), JSON.stringify(params)).toBeLessThan(1e-3);
    // The default probe of a bone is half its length (20 px).
    expect(turnGap(out, 'hatBone', 'headWarp', [200, 100], 20, { AngleX: 30, AngleY: 30 })).toBeLessThan(1e-3);
  });

  it('solves through a warp parent (lattice points are mapped, not the anchor): exact at keyforms, measured between them', () => {
    const doc = hatDoc();
    // hatWarp sits in its own holder lattice, which bulges with AngleX (not affine).
    doc.warps.push({ id: 'holder', parent: 'head', rect: [140, 30, 120, 90], cols: 2, rows: 2 });
    doc.warps[1].parent = 'holder';
    const bulged = applyOk(doc, [{ op: 'bind_warp', warp: 'holder', params: ['AngleX'], keys: [{ at: [-30], yaw: -40 }, { at: [0] }, { at: [30], yaw: 40 }] }]).doc;
    const { doc: out, messages } = applyOk(bulged, [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [210, 105] }]);
    expect(messages[0]).toMatch(/max residual 0(\.000\d)? px at the 9 keyforms, [\d.]+ px at 16 grid midpoints/);
    for (const params of [{ AngleX: 30 }, { AngleX: -30, AngleY: 30 }, { AngleX: 30, AngleY: -30, AngleZ: 25 }] as Array<Record<string, number>>) {
      expect(gap(out, 'hatWarp', 'headWarp', [210, 105], params), JSON.stringify(params)).toBeLessThan(1e-3);
    }
    // The reported midpoint residual is what the rig shows there.
    const worst = /at 16 grid midpoints \(worst at \[(-?[\d.]+), (-?[\d.]+)\]\)/.exec(messages[0])!;
    const reported = Number(/, ([\d.]+) px at 16 grid midpoints/.exec(messages[0])![1]);
    expect(gap(out, 'hatWarp', 'headWarp', [210, 105], { AngleX: Number(worst[1]), AngleY: Number(worst[2]) })).toBeCloseTo(reported, 2);
  });

  it('replaces its own binding when run again and uses explicit params with their own grid', () => {
    const first = applyOk(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [200, 105] }]);
    const again = applyOk(first.doc, [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [200, 105] }]);
    expect(again.messages[0]).toMatch(/^replaced binding warp:hatWarp\.offsets ← \[AngleX, AngleY\] at \/bindings\/2 \(9 keyforms, was 9\);/);
    expect(again.doc.bindings).toEqual(first.doc.bindings);
    // One parameter: its keyform values from the followed bindings; the other stays at its default.
    const only = applyOk(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [200, 105], params: ['AngleX'], description: 'hat on head' }]);
    const b = only.doc.bindings.find((x: Raw) => x.target === 'warp:hatWarp.offsets');
    expect(b).toMatchObject({ params: ['AngleX'], description: 'hat on head' });
    expect(b.keys.map((k: Raw) => k.at)).toEqual([[-30], [0], [30]]);
    expect(only.messages[0]).toContain('over AngleX {-30, 0, 30}: anchor shift');
    // A parameter nothing in either chain keys: min, default and max.
    const breath = applyOk(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [200, 105], params: ['Breath'] }]);
    expect(breath.messages[0]).toContain('over Breath {0, 1}: anchor shift up to 0 px');
  });

  it('corrects on top of kept manual bindings, exactly at keyforms', () => {
    const manual = applyOk(hatDoc(), [{ op: 'bind_warp', warp: 'hatWarp', params: ['AngleX'], keys: [{ at: [-30], translate: [-10, 0] }, { at: [0] }, { at: [30], translate: [10, 0] }] }]).doc;
    const { doc, messages } = applyOk(manual, [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [200, 105] }]);
    expect(messages[0]).toContain("kept 1 other binding on the accessory's targets (warp:hatWarp.offsets ← [AngleX])");
    for (const params of POSES) expect(gap(doc, 'hatWarp', 'headWarp', [200, 105], params), JSON.stringify(params)).toBeLessThan(1e-3);
  });

  it('warns when the followed motion is far from linear between its keyforms', () => {
    // A jaw bone swings 90° between its keyforms: the anchor 100 px away moves on an arc, the
    // interpolated keyforms along its chord, 100 · (1 − cos 45°) = 29.3 px apart at AngleX 15.
    const doc = hatDoc();
    doc.bindings = [];
    doc.bones.push({ id: 'jaw', parent: 'head', x: 0, y: 0 });
    doc.warps.push({ id: 'chin', parent: 'jaw', rect: [150, 250, 100, 100], cols: 1, rows: 1 });
    doc.bindings.push({ target: 'bone:jaw.rotation', params: ['AngleX'], keys: [{ at: [0], value: 0 }, { at: [30], value: 90 }] });
    const { messages } = applyOk(doc, [{ op: 'follow', warp: 'hatWarp', follow: 'chin', at: [200, 300] }]);
    expect(messages[0]).toContain('over AngleX {0, 30} (params of the bindings on "jaw"): anchor shift up to 141.421 px at [30]');
    expect(messages[0]).toMatch(
      /max residual 0(\.000\d)? px at the 2 keyforms, 29\.289\d px at 1 grid midpoints \(worst at \[15\]\); WARNING: up to 29\.289 px off between keyforms \(at \[15\]\): the followed motion is not linear between its keys there; add in-between keyforms to the followed binding \(follow reuses its grid\) and run follow again$/,
    );
    // Following the advice: a keyform at 15 on the jaw binding gives follow a finer grid.
    doc.bindings[0].keys.splice(1, 0, { at: [15], value: 45 });
    const finer = applyOk(doc, [{ op: 'follow', warp: 'hatWarp', follow: 'chin', at: [200, 300] }]);
    expect(finer.messages[0]).toContain('over AngleX {0, 15, 30}');
    expect(finer.messages[0]).toMatch(/, 7\.61\d+ px at 2 grid midpoints \(worst at \[(7\.5|22\.5)\]\); WARNING: up to 7\.61/);
  });

  it('reports bad accessories, targets, anchors and grids precisely', () => {
    let r = applyFail(hatDoc(), [{ op: 'follow', follow: 'headWarp' }]);
    expect(r.message).toBe('follow needs the accessory: "warp" (a warp id) or "bone" (a bone id)');
    expect(r.hint).toBe('e.g. {"op": "follow", "warp": "hatWarp", "follow": "headWarp", "at": [256, 121]}');
    r = applyFail(hatDoc(), [{ op: 'follow', warp: 'hatWarp', bone: 'hatBone', follow: 'headWarp' }]);
    expect(r.message).toBe('follow: give either "warp" or "bone" (the accessory), not both');
    r = applyFail(hatDoc(), [{ op: 'follow', warp: 'hatBone', follow: 'headWarp' }]);
    expect(r.message).toBe('follow: "hatBone" is a bone, not a warp');
    expect(r.hint).toBe('pass it as "bone": "hatBone"');
    r = applyFail(hatDoc(), [{ op: 'follow', warp: 'hatWrap', follow: 'headWarp' }]);
    expect(r.message).toBe('unknown accessory warp "hatWrap"');
    expect(r.hint).toContain('did you mean "hatWarp"?');
    r = applyFail(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'headWrap' }]);
    expect(r.message).toBe('follow: unknown warp or bone "headWrap" in "follow"');
    expect(r.hint).toContain('did you mean "headWarp"?');
    r = applyFail(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'hatWarp' }]);
    expect(r.message).toBe('follow: warp "hatWarp" cannot follow itself');
    r = applyFail(hatDoc(), [{ op: 'follow', bone: 'head', follow: 'headWarp' }]);
    expect(r.message).toBe('follow: warp "headWarp" hangs from bone "head", so moving the accessory would move what it follows');
    const nested = hatDoc();
    nested.warps[1].parent = 'headWarp';
    r = applyFail(nested, [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp' }]);
    expect(r.message).toBe('follow: warp "hatWarp" already hangs from warp "headWarp" (through its parents), so it deforms with it instead of moving rigidly');
    expect(r.hint).toBe('attach it next to "headWarp" instead, then follow it: {"op": "update", "kind": "warp", "id": "hatWarp", "set": {"parent": "head"}} (bone "head" carries "headWarp")');
    // The hint's op works: the same follow then applies.
    applyOk(nested, [
      { op: 'update', kind: 'warp', id: 'hatWarp', set: { parent: 'head' } },
      { op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [200, 105] },
    ]);
    r = applyFail(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'head' }]);
    expect(r.message).toBe('follow: warp "hatWarp" already hangs from bone "head" (through its parents), so it already moves rigidly with it');
    expect(r.hint).toBe('follow the deforming surface next to the accessory instead, e.g. the head warp on that bone');
    const still = hatDoc();
    still.bindings = [];
    r = applyFail(still, [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp' }]);
    expect(r.message).toBe('follow: nothing moves warp "headWarp" relative to warp "hatWarp": no parameter drives "headWarp"');
    expect(r.hint).toBe('bind the followed item first (e.g. bind_warp "headWarp" to AngleX / AngleY), or give "params" explicitly');
    r = applyFail(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', at: [1, 2, 3] }]);
    expect(r.message).toBe('follow: "at" must be [x, y] (setup space) or "center", got an array (3 items)');
    r = applyFail(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', probe: 0, rotate: true }]);
    expect(r.message).toBe('follow: "probe" must be > 0 px, got 0');
    r = applyFail(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', params: ['AngleX', 'Angle'] }]);
    expect(r.message).toBe('unknown parameter "Angle"');
    r = applyFail(hatDoc(), [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp', rotation: true }]);
    expect(r.message).toBe('follow: unknown field "rotation"');
    expect(r.hint).toContain('did you mean "rotate"?');
  });

  it('refuses more than 3 driving parameters with the list to choose from', () => {
    const doc = hatDoc();
    doc.bindings.push({ target: 'warp:headWarp.offsets', params: ['Tilt', 'Breath'], keys: [{ at: [0, 0], value: { '0': [0, 0] } }, { at: [1, 0], value: { '0': [0, 0] } }, { at: [0, 1], value: { '0': [0, 0] } }, { at: [1, 1], value: { '0': [0, 0] } }] });
    const r = applyFail(doc, [{ op: 'follow', warp: 'hatWarp', follow: 'headWarp' }]);
    expect(r.message).toBe('follow: 4 parameters drive the followed chain (AngleX, AngleY, Tilt, Breath), but a binding takes at most 3');
    expect(r.hint).toContain('pass "params" with the 1 to 3 that move it most');
    expect(find(doc, 'warps', 'hatWarp')).toBeDefined();
  });
});
