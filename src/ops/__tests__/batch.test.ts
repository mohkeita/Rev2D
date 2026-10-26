import { describe, expect, it } from 'vitest';
import { applyOps, describeOps, type Op } from '../index.js';
import { OP_NAMES } from '../catalog.js';
import { applyOk, deepFreeze, find, rigDoc } from './fixtures.js';

describe('applyOps batch semantics', () => {
  it('never mutates the input (deep-frozen input still works)', () => {
    const input = deepFreeze(rigDoc());
    const snapshot = JSON.stringify(input);
    const result = applyOps(input, [
      { op: 'set', target: 'bone:hand.rotation', value: 10 },
      { op: 'rename', kind: 'bone', from: 'fore', to: 'forearm' },
      { op: 'remove', kind: 'part', id: 'head', cascade: true },
      { op: 'key', animation: 'wave', target: 'param:AngleX', t: 0.5, v: 3 },
      { op: 'patch', patch: [{ op: 'replace', path: '/meta/name', value: 'x' }] },
    ]);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(result.doc).not.toBe(input);
  });

  it('shares no objects with the ops (mutating the ops later does not change the result)', () => {
    const ops: Op[] = [
      { op: 'bind', target: 'bone:hand.x', params: ['Bend'], keys: [{ at: [0], value: 40 }, { at: [1], value: 50 }] },
      { op: 'bind_warp', warp: 'mouthWarp', params: ['Bend'], keys: [{ at: [0] }, { at: [1], yaw: 10 }] },
      { op: 'add', kind: 'bone', value: { id: 'b', world: [1, 2] } },
      { op: 'update', kind: 'part', id: 'body', set: { tags: ['a'] } },
      { op: 'key', animation: 'wave', target: 'warp:face.offsets', t: 0.5, v: { '4': [1, 1] }, ease: [0, 0, 1, 1] },
      { op: 'patch', patch: [{ op: 'add', path: '/animations/0/events', value: [{ t: 0.5, name: 'step' }] }] },
    ];
    const result = applyOps(rigDoc(), ops);
    expect(result.ok).toBe(true);
    const snapshot = JSON.stringify(result.doc);
    const scramble = (v: unknown): void => {
      if (Array.isArray(v)) {
        v.forEach(scramble);
        v.push(999);
      } else if (v && typeof v === 'object') {
        for (const x of Object.values(v)) scramble(x);
        (v as Record<string, unknown>).scrambled = true;
      }
    };
    scramble(ops);
    expect(JSON.stringify(result.doc)).toBe(snapshot);
  });

  it('is atomic: a failing op returns the original input and skips the rest', () => {
    const input = rigDoc();
    const result = applyOps(input, [
      { op: 'set', target: 'bone:hand.rotation', value: 10 },
      { op: 'remove', kind: 'bone', id: 'zzzzzz' },
      { op: 'set', target: 'bone:hand.rotation', value: 20 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.doc).toBe(input);
    expect(find(input, 'bones', 'hand').rotation).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
    expect(result.results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(result.results[1]).toEqual({ index: 1, op: 'remove', ok: false, message: 'unknown bone "zzzzzz"', hint: 'known bones: "root", "upper", "fore", "hand", "target"' });
    expect(result.results[2].message).toMatch(/^skipped: an earlier op failed/);
  });

  it('rejects results with validation errors unless allowInvalid', () => {
    const input = rigDoc();
    const ops: Op[] = [{ op: 'update', kind: 'part', id: 'mouth', set: { parent: 'ghost' } }];
    const strict = applyOps(input, ops);
    expect(strict.ok).toBe(false);
    expect(strict.doc).toBe(input);
    expect(strict.results[0].ok).toBe(true);
    expect(strict.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', code: 'unknown-parent', path: '/parts/2/parent' }));

    const lenient = applyOps(input, ops, { allowInvalid: true });
    expect(lenient.ok).toBe(true);
    expect(find(lenient.doc as any, 'parts', 'mouth').parent).toBe('ghost');
    expect(lenient.diagnostics.some((d) => d.severity === 'error')).toBe(true);

    const unchecked = applyOps(input, ops, { validate: false });
    expect(unchecked.ok).toBe(true);
    expect(unchecked.diagnostics).toEqual([]);
  });

  it('returns warnings/infos of a valid result', () => {
    const result = applyOps(rigDoc(), [{ op: 'add', kind: 'parameter', value: { id: 'Unused', min: 0, max: 1 } }]);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: 'info', code: 'unused-parameter' }));
  });

  it('rejects malformed ops with hints', () => {
    const check = (op: unknown, message: string, hint?: string) => {
      const r = applyOps(rigDoc(), [op as Op]).results[0];
      expect(r.ok).toBe(false);
      expect(r.message).toBe(message);
      if (hint !== undefined) expect(r.hint).toBe(hint);
    };
    check({ op: 'ad', kind: 'bone', value: {} }, 'unknown op "ad"', `did you mean "add"? (ops: ${OP_NAMES.join(', ')})`);
    check({ kind: 'bone' }, 'the op has no "op" field');
    check(5, 'each op must be an object like {"op": "add", ...}, got number 5');
    check({ op: 'add', kind: 'bone', item: { id: 'x' } }, 'add: unknown field "item"', 'did you mean "value"? (fields of add: kind, value, index, before, after)');
    check({ op: 'key', animation: 'wave', target: 'param:AngleX', time: 1, v: 0 }, 'key: unknown field "time"');
    check({ op: 'add', kind: 'bone' }, 'add needs "value" (the bone object as it appears in the model file)');
    check({ op: 'set', target: 'bone:hand.x', value: 1, cascade: true }, 'set: unknown field "cascade"');
  });

  it('rejects non-array ops and non-object documents', () => {
    let result = applyOps(rigDoc(), { op: 'add' } as unknown as Op[]);
    expect(result.ok).toBe(false);
    expect(result.results[0].message).toBe('ops must be an array of op objects, got an object');
    result = applyOps([1, 2], [{ op: 'set', target: 'bone:a.x', value: 1 }]);
    expect(result.results[0].message).toBe('the model must be a JSON object, got an array (2 items)');
  });

  it('an empty batch validates and returns a copy', () => {
    const input = rigDoc();
    const result = applyOps(input, []);
    expect(result.ok).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.doc).toEqual(input);
    expect(result.doc).not.toBe(input);
  });

  it('later ops see the effects of earlier ones', () => {
    const { doc } = applyOk(rigDoc(), [
      { op: 'add', kind: 'parameter', value: { id: 'Wink', min: 0, max: 1 } },
      { op: 'add', kind: 'part', value: { id: 'lid', parent: 'face', shape: { type: 'rect', x: 180, y: 130, w: 20, h: 6 } } },
      { op: 'bind', target: 'part:lid.opacity', params: ['Wink'], keys: [{ at: [0], value: 0 }, { at: [1], value: 1 }] },
      { op: 'rename', kind: 'part', from: 'lid', to: 'eyelid' },
    ]);
    expect(doc.bindings[6].target).toBe('part:eyelid.opacity');
  });
});

describe('describeOps', () => {
  it('describes every op with fields and a runnable example shape', () => {
    const ops = describeOps();
    expect(ops.map((d) => d.op)).toEqual([
      'act',
      'add',
      'update',
      'remove',
      'rename',
      'set',
      'bind',
      'bind_linear',
      'bind_warp',
      'follow',
      'unbind',
      'key',
      'unkey',
      'move',
      'recolor',
      'compose',
      'patch',
    ]);
    for (const d of ops) {
      expect(d.summary.length).toBeGreaterThan(40);
      expect(Object.keys(d.fields).length).toBeGreaterThan(0);
      expect(d.example.op).toBe(d.op);
      for (const key of Object.keys(d.example)) if (key !== 'op') expect(Object.keys(d.fields)).toContain(key);
    }
  });

  it('keeps the first sentence of every summary short (the MCP op list shows only that sentence, within 2048 chars)', () => {
    // Same sentence split as the MCP brief: "e.g. x" and "a.b" do not end a sentence.
    const first = (s: string) => /^(.*?[.!?])(?=\s+[A-Z"(]|$)/s.exec(s)?.[1] ?? s;
    const lines = describeOps().map((d) => {
      const sentence = first(d.summary);
      expect(sentence.length, `${d.op}: ${sentence}`).toBeLessThanOrEqual(60);
      return `- ${d.op} {${Object.keys(d.fields).join(', ')}}: ${sentence}`;
    });
    // The MCP intro takes ~600 of the 2048 characters.
    expect(lines.join('\n').length).toBeLessThanOrEqual(1400);
  });

  it('every catalogue example applies to a model that has what it references', () => {
    const doc = {
      format: 'rev2d',
      version: 1,
      meta: { name: 'examples', width: 400, height: 400, background: '#000000' },
      parameters: [
        { id: 'MouthOpen', min: 0, max: 1 },
        { id: 'AngleX', min: -30, max: 30 },
        { id: 'FootLY', min: -30, max: 30 },
        { id: 'Breath', min: 0, max: 1 },
      ],
      bones: [
        { id: 'forearm', x: 200, y: 200, length: 40 },
        { id: 'footL', x: 150, y: 380 },
        { id: 'arm', x: 100, y: 100 },
        { id: 'head', x: 256, y: 250 },
      ],
      warps: [
        { id: 'faceWarp', rect: [150, 100, 100, 100], cols: 2, rows: 2 },
        { id: 'headWarp', parent: 'head', rect: [140, 100, 232, 270], cols: 2, rows: 2 },
        { id: 'hatWarp', parent: 'head', rect: [176, 56, 160, 80], cols: 2, rows: 1 },
      ],
      parts: [
        { id: 'mouth', shape: { type: 'ellipse', cx: 200, cy: 150, rx: 20, ry: 4 }, fill: '#aa3333', stroke: { color: '#000000', width: 1 } },
        { id: 'hairBack', shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 }, fill: '#553311', tags: ['hair'] },
      ],
      bindings: [
        { target: 'part:mouth.shape.ry', params: ['MouthOpen'], keys: [{ at: [0], value: 2 }] },
        { target: 'warp:headWarp.offsets', params: ['AngleX'], keys: [{ at: [0], value: { '4': [0, 0] } }, { at: [30], value: { '4': [20, 0] } }] },
      ],
      animations: [
        { id: 'idle', duration: 2, tracks: [{ target: 'param:Breath', keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }] },
        { id: 'talk', duration: 1, loop: false, tracks: [{ target: 'param:MouthOpen', keys: [{ t: 0, v: 0 }, { t: 0.5, v: 1 }, { t: 1, v: 0 }] }] },
      ],
    };
    for (const d of describeOps()) {
      if (d.op === 'set') continue; // addresses polygon points; the mouth here is an ellipse (bind's example needs shape.ry)
      const result = applyOps(doc, [d.example as Op], { validate: false });
      expect(result.results[0], `${d.op}: ${result.results[0].message} ${result.results[0].hint ?? ''}`).toMatchObject({ ok: true });
    }
  });

  it('returns copies', () => {
    describeOps()[0].fields.kind = 'changed';
    expect(describeOps()[0].fields.kind).not.toBe('changed');
  });
});
