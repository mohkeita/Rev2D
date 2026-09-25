import { describe, expect, it } from 'vitest';
import {
  DocHistory,
  entityPointer,
  findEntityIndex,
  getEntity,
  hasJsonComments,
  parseRefKey,
  refAfterEdit,
  refFromPointer,
  replaceEntity,
  resolveRef,
  type RawDoc,
} from '../editor/src/state/doc.js';
import {
  activeLayers,
  advanceClock,
  animatedParams,
  explicitOptions,
  layerPhase,
  localTime,
  optionsLabel,
  physicsOutputsByParam,
  physicsParams,
  trackGroups,
} from '../editor/src/state/playback.js';
import { validateModel, type Model } from '../src/core/index.js';
import { blankModel } from '../src/api/templates.js';

const doc: RawDoc = {
  format: 'rev2d',
  version: 1,
  meta: { name: 't', width: 10, height: 10 },
  parameters: [{ id: 'A', min: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'body' }],
  parts: [
    { id: 'body', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 } },
    { id: 'eye', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 } },
  ],
  bindings: [{ target: 'part:eye.opacity', params: ['A'], keys: [] }, { id: 'named', target: 'part:body.z', params: ['A'], keys: [] }],
};

describe('editor document helpers', () => {
  it('parses reference keys with aliases', () => {
    expect(parseRefKey('part:eye')).toEqual({ kind: 'part', id: 'eye' });
    expect(parseRefKey('parameter:A')).toEqual({ kind: 'param', id: 'A' });
    expect(parseRefKey('anim:idle')).toEqual({ kind: 'animation', id: 'idle' });
    expect(parseRefKey('eye')).toBeNull();
    expect(parseRefKey('nope:eye')).toBeNull();
  });

  it('resolves bare ids (parts first) and checks kind:id against the document', () => {
    expect(resolveRef(doc, 'body')).toEqual({ kind: 'part', id: 'body' });
    expect(resolveRef(doc, 'root')).toEqual({ kind: 'bone', id: 'root' });
    expect(resolveRef(doc, 'bone:body')).toEqual({ kind: 'bone', id: 'body' });
    expect(resolveRef(doc, 'bone:eye')).toBeNull();
    expect(resolveRef(doc, 'missing')).toBeNull();
    // Bindings: by index when they have no id, canonicalized to the id when they do.
    expect(resolveRef(doc, 'binding:0')).toEqual({ kind: 'binding', id: '0' });
    expect(resolveRef(doc, 'binding:1')).toEqual({ kind: 'binding', id: 'named' });
    expect(resolveRef(doc, 'binding:5')).toBeNull();
  });

  it('maps diagnostic JSON pointers to entities', () => {
    expect(refFromPointer(doc, '/parts/1/shape/w')).toEqual({ kind: 'part', id: 'eye' });
    expect(refFromPointer(doc, '/bindings/0/keys')).toEqual({ kind: 'binding', id: '0' });
    expect(refFromPointer(doc, '/parameters/0')).toEqual({ kind: 'param', id: 'A' });
    expect(refFromPointer(doc, '/meta/width')).toBeNull();
    expect(refFromPointer(doc, '/parts/9')).toBeNull();
    expect(refFromPointer(doc, '')).toBeNull();
    expect(entityPointer(doc, { kind: 'part', id: 'eye' })).toBe('/parts/1');
  });

  it('replaces an entity immutably and follows renames', () => {
    const ref = { kind: 'part' as const, id: 'eye' };
    const next = replaceEntity(doc, ref, { id: 'eyeL', shape: { type: 'rect', x: 1, y: 1, w: 2, h: 2 } });
    expect(next).not.toBe(doc);
    expect(next.bones).toBe(doc.bones);
    expect((doc.parts as unknown[])[1]).toMatchObject({ id: 'eye' });
    expect(getEntity(next, { kind: 'part', id: 'eyeL' })).toMatchObject({ shape: { x: 1 } });
    expect(findEntityIndex(next, ref)).toBe(-1);
    expect(refAfterEdit(ref, { id: 'eyeL' }, 1)).toEqual({ kind: 'part', id: 'eyeL' });
    expect(refAfterEdit({ kind: 'binding', id: '0' }, { target: 'x' }, 0)).toEqual({ kind: 'binding', id: '0' });
    expect(() => replaceEntity(doc, { kind: 'warp', id: 'w' }, {})).toThrow(/not found/);
  });

  it('detects JSONC comments outside strings', () => {
    expect(hasJsonComments('{"a": 1}')).toBe(false);
    expect(hasJsonComments('{"url": "http://x/*y*/"}')).toBe(false);
    expect(hasJsonComments('{"q": "\\"//\\""}')).toBe(false);
    expect(hasJsonComments('{\n  // note\n  "a": 1}')).toBe(true);
    expect(hasJsonComments('{"a": /* inline */ 1}')).toBe(true);
    expect(hasJsonComments('{"a": 1 / 2}')).toBe(false);
  });

  it('keeps a linear undo/redo history', () => {
    const h = new DocHistory(3);
    h.reset({ v: 0 });
    expect(h.canUndo).toBe(false);
    h.push({ v: 1 }, 'one');
    h.push({ v: 2 }, 'two');
    expect(h.undoLabel).toBe('two');
    expect(h.undo()).toEqual({ entry: { doc: { v: 1 }, label: 'one' }, undone: 'two' });
    expect(h.redoLabel).toBe('two');
    h.push({ v: 3 }, 'three');
    expect(h.canRedo).toBe(false);
    h.push({ v: 4 }, 'four');
    // Limit 3: the oldest snapshot was dropped.
    expect(h.undo()?.entry.doc).toEqual({ v: 3 });
    expect(h.undo()?.entry.doc).toEqual({ v: 1 });
    expect(h.undo()).toBeNull();
    expect(h.redo()?.doc).toEqual({ v: 3 });
  });
});

function model(): Model {
  const raw = blankModel() as { animations: unknown[]; physics?: unknown[]; parameters: unknown[] };
  raw.parameters.push({ id: 'Sway', min: -10, max: 10 });
  raw.animations.push({ id: 'once', duration: 1, loop: false, tracks: [{ target: 'bone:root.rotation', keys: [{ t: 0, v: 0 }, { t: 1, v: 5 }] }] });
  raw.physics = [{ id: 'p', inputs: [{ param: 'Lean', type: 'x' }], outputs: [{ param: 'Sway' }] }];
  const r = validateModel(raw);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return r.model!;
}

describe('editor playback logic', () => {
  const m = model();

  it('builds active layers: primary first, enabled extras, no duplicates or unknown ids', () => {
    expect(activeLayers(m, { animation: 'idle', layers: [] })).toEqual([{ id: 'idle', weight: 1 }]);
    expect(
      activeLayers(m, {
        animation: 'idle',
        layers: [
          { id: 'once', weight: 0.5 },
          { id: 'idle', weight: 0.3 },
          { id: 'ghost', weight: 1 },
          { id: 'once', weight: 1 },
        ],
      }),
    ).toEqual([
      { id: 'idle', weight: 1 },
      { id: 'once', weight: 0.5 },
    ]);
    expect(activeLayers(m, { animation: null, layers: [{ id: 'once', weight: 0 }] })).toEqual([]);
    expect(activeLayers(m, { animation: 'idle', animationWeight: 0.25, layers: [] })).toEqual([{ id: 'idle', weight: 0.25 }]);
    expect(activeLayers(m, { animation: 'idle', animationWeight: 0, layers: [{ id: 'once', weight: 1 }] })).toEqual([{ id: 'once', weight: 1 }]);
  });

  it('knows which params animations and physics drive', () => {
    expect([...animatedParams(m, [{ id: 'idle', weight: 1 }])].sort()).toEqual(['Lean', 'Squash']);
    expect([...animatedParams(m, [{ id: 'once', weight: 1 }])]).toEqual([]);
    expect([...physicsParams(m)]).toEqual(['Sway']);
  });

  it('wraps looping and clamps one-shot local time', () => {
    expect(localTime(2.5, { duration: 2, loop: true })).toBeCloseTo(0.5, 12);
    expect(localTime(-0.5, { duration: 2, loop: true })).toBeCloseTo(1.5, 12);
    expect(localTime(2.5, { duration: 2, loop: false })).toBe(2);
  });

  it('advances the clock: stop at the end, run on for loops, restart one-shots', () => {
    const loop = { duration: 2, loop: true };
    const once = { duration: 1, loop: false };
    expect(advanceClock(1.9, 0.2, loop, false)).toEqual({ time: 2, ended: true });
    expect(advanceClock(2.5, 0.2, loop, false).ended).toBe(false);
    expect(advanceClock(3.9, 0.2, loop, false)).toEqual({ time: 4, ended: true });
    const run = advanceClock(1.9, 0.2, loop, true);
    expect(run.ended).toBe(false);
    expect(run.time).toBeCloseTo(2.1, 12);
    expect(advanceClock(0.95, 0.1, once, true).time).toBeCloseTo(0.05, 12);
    expect(advanceClock(0.95, 0.1, once, false)).toEqual({ time: 1, ended: true });
    expect(advanceClock(5, 0.5, null, false)).toEqual({ time: 5.5, ended: false });
  });

  it('passes layer options (mode, start, hold) to the rig, only where they differ from the defaults', () => {
    expect(
      activeLayers(m, {
        animation: 'idle',
        animationOptions: { start: 0.5, mode: 'override', hold: true },
        layers: [
          { id: 'once', weight: 0.5, mode: 'add', start: 1, hold: false },
          { id: 'idle', weight: 1, mode: 'add' },
        ],
      }),
    ).toEqual([
      { id: 'idle', weight: 1, start: 0.5 },
      { id: 'once', weight: 0.5, mode: 'add', start: 1, hold: false },
    ]);
    expect(explicitOptions({ mode: 'override', start: 0, hold: true })).toEqual({});
    expect(explicitOptions({ start: Number.NaN })).toEqual({});
    expect(optionsLabel({ mode: 'add', start: 1.5, hold: false })).toBe('add · from 1.5s · once');
    expect(optionsLabel({})).toBe('');
  });

  it('knows where a delayed or one-shot layer is (waiting, playing, held or done)', () => {
    const once = { duration: 1, loop: false };
    expect(layerPhase(0.5, once, { start: 1 })).toEqual({ local: 0, state: 'before', active: true });
    expect(layerPhase(1.25, once, { start: 1 })).toEqual({ local: 0.25, state: 'playing', active: true });
    expect(layerPhase(2.5, once, { start: 1 })).toEqual({ local: 1, state: 'after', active: true });
    expect(layerPhase(2.5, once, { start: 1, hold: false })).toMatchObject({ state: 'after', active: false });
    expect(layerPhase(0.5, once, { start: 1, hold: false })).toMatchObject({ state: 'before', active: false });
    expect(layerPhase(7.5, { duration: 2, loop: true }, { start: 1 })).toMatchObject({ local: 0.5, state: 'playing' });
    // Before its start a looping layer already plays, phase-shifted (as the rig samples it), unless hold is false.
    expect(layerPhase(0.5, { duration: 2, loop: true }, { start: 1 })).toEqual({ local: 1.5, state: 'before', active: true });
    expect(layerPhase(0.5, { duration: 2, loop: true }, { start: 1, hold: false })).toEqual({ local: 0, state: 'before', active: false });
  });

  it('ends and repeats a delayed main animation at start + duration', () => {
    const once = { duration: 1, loop: false };
    expect(advanceClock(0.5, 0.2, once, false, 1)).toEqual({ time: 0.7, ended: false });
    expect(advanceClock(1.9, 0.2, once, false, 1)).toEqual({ time: 2, ended: true });
    expect(advanceClock(1.95, 0.1, once, true, 1).time).toBeCloseTo(1.05, 12);
    expect(advanceClock(2.9, 0.2, { duration: 2, loop: true }, false, 1)).toEqual({ time: 3, ended: true });
  });

  it('reads physics outputs of a pose by parameter', () => {
    const outputs = physicsOutputsByParam({
      hair: { outputs: [{ param: 'Sway', raw: 14, value: 10, clamped: true, overridden: false }] },
      tail: { outputs: [{ param: 'Sway', raw: 2, value: 3, clamped: false, overridden: true }] },
    });
    expect(outputs.get('Sway')!.map((o) => [o.group, o.raw, o.clamped, o.overridden])).toEqual([
      ['hair', 14, true, false],
      ['tail', 2, false, true],
    ]);
    expect(physicsOutputsByParam(undefined).size).toBe(0);
    expect(physicsOutputsByParam({}).size).toBe(0);
  });

  it('groups tracks by kind for the timeline', () => {
    const idle = m.animations.find((a) => a.id === 'idle')!;
    const groups = trackGroups(idle);
    expect(groups.map((g) => g.kind)).toEqual(['param']);
    expect(groups[0].rows.map((r) => r.label)).toEqual(['Lean', 'Squash']);
    expect(groups[0].rows[1].times).toEqual([0, 0.5, 1, 1.5, 2]);
  });
});
