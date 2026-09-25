import { describe, expect, it } from 'vitest';
import { applyFail, applyOk, find, rigDoc } from './fixtures.js';

describe('patch', () => {
  it('applies add, remove, replace, move, copy and test in order', () => {
    const { doc, messages } = applyOk(rigDoc(), [
      {
        op: 'patch',
        patch: [
          { op: 'test', path: '/meta/name', value: 'fixture' },
          { op: 'replace', path: '/meta/name', value: 'hero' },
          { op: 'add', path: '/meta/author', value: 'ops' },
          { op: 'add', path: '/parameters/-', value: { id: 'Extra', min: 0, max: 1 } },
          { op: 'add', path: '/parameters/0', value: { id: 'First', min: 0, max: 1 } },
          { op: 'remove', path: '/parts/5' },
          { op: 'copy', from: '/parts/0', path: '/parts/-' },
          { op: 'replace', path: '/parts/5/id', value: 'body2' },
          { op: 'move', from: '/parts/5', path: '/parts/0' },
          { op: 'add', path: '/bindings/0/keys/0/value', value: 45 },
        ],
      },
    ], { allowInvalid: true });
    expect(doc.meta).toEqual({ name: 'hero', width: 400, height: 400, author: 'ops' });
    expect(doc.parameters.map((p: any) => p.id)).toEqual(['First', 'AngleX', 'AngleY', 'Bend', 'Sway', 'Extra']);
    expect(doc.parts.map((p: any) => p.id)).toEqual(['body2', 'body', 'head', 'mouth', 'sleeve', 'photo']);
    expect(doc.bindings[0].keys[0].value).toBe(45);
    expect(messages[0]).toMatch(/^applied 10 patch operations: test \/meta\/name ok; replace \/meta\/name: "fixture" → "hero"; add \/meta\/author = "ops"; /);
  });

  it('resolves item ids in array segments (extension) and escapes ~0 ~1', () => {
    const { doc, messages } = applyOk(rigDoc(), [
      {
        op: 'patch',
        patch: [
          { op: 'add', path: '/parts/head/opacity', value: 0.5 },
          { op: 'add', path: '/parts/mouth/tags', value: ['face'] },
          { op: 'add', path: '/meta/description', value: 'a/b~c' },
        ],
      },
    ]);
    expect(find(doc, 'parts', 'head').opacity).toBe(0.5);
    expect(Object.keys(find(doc, 'parts', 'mouth'))).toEqual(['id', 'parent', 'shape', 'fill', 'z', 'mask', 'tags']);
    expect(messages[0]).toContain('add /parts/1/opacity = 0.5');
    const { doc: out } = applyOk(doc, [{ op: 'patch', patch: [{ op: 'test', path: '/meta/description', value: 'a/b~c' }, { op: 'add', path: '/meta/x~1y', value: 1 }] }], { validate: false });
    expect(out.meta['x/y']).toBe(1);
  });

  it('adds model-level keys and item fields at their canonical position', () => {
    const doc = rigDoc();
    const textures = doc.textures;
    delete doc.textures;
    const { doc: out } = applyOk(doc, [
      {
        op: 'patch',
        patch: [
          { op: 'add', path: '/textures', value: textures },
          { op: 'add', path: '/bones/hand/rotation', value: 5 },
        ],
      },
    ]);
    expect(Object.keys(out).indexOf('textures')).toBe(Object.keys(out).indexOf('parameters') + 1);
    expect(Object.keys(find(out, 'bones', 'hand'))).toEqual(['id', 'parent', 'x', 'y', 'rotation', 'length']);
  });

  it('replaces the whole document with an object', () => {
    const replacement = { format: 'rev2d', version: 1, meta: { name: 'new', width: 10, height: 10 } };
    const { doc } = applyOk(rigDoc(), [{ op: 'patch', patch: [{ op: 'replace', path: '', value: replacement }] }]);
    expect(doc).toEqual(replacement);
  });

  it('fails precisely: missing paths, bad indexes, failed tests, bad pointers', () => {
    let r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'replace', path: '/meta/nmae', value: 'x' }] }]);
    expect(r.message).toBe('patch[0] (replace /meta/nmae): /meta/nmae does not exist');
    expect(r.hint).toBe('did you mean "name"?');
    r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'remove', path: '/parts/9' }] }]);
    expect(r.message).toBe('patch[0] (remove /parts/9): index 9 is out of range for /parts (6 items)');
    expect(r.hint).toBe('use 0..5');
    r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'test', path: '/version', value: 2 }] }]);
    expect(r.message).toBe('patch[0] (test /version): test failed: /version is 1, expected 2');
    r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'replace', path: 'meta/name', value: 'x' }] }]);
    expect(r.hint).toBe('did you mean "/meta/name"?');
    r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'remove', path: '/parts/-' }] }]);
    expect(r.message).toContain('"-" (end of array) only works for adding');
    r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'move', from: '/meta', path: '/meta/inner' }] }]);
    expect(r.message).toContain('cannot move /meta into its own child');
    r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'replace', path: '/parts/hed/opacity', value: 1 }] }]);
    expect(r.hint).toBe('did you mean "head"?');
    r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'rename', path: '/meta' }] }]);
    expect(r.hint).toContain('ops: add, remove, replace, move, copy, test');
    r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'add', path: '/meta/name/x', value: 1 }] }]);
    expect(r.message).toContain('/meta/name is string "fixture", so it has no member "x"');
    r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'replace', path: '', value: [] }] }]);
    expect(r.message).toContain('the document must stay a JSON object');
  });

  it('suggests "add" when "replace" targets a member that does not exist yet', () => {
    const r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'replace', path: '/parts/mouth/opacity', value: 0.5 }] }]);
    expect(r.message).toBe('patch[0] (replace /parts/mouth/opacity): /parts/2/opacity does not exist');
    expect(r.hint).toBe('"replace" only changes existing members; create it with {"op": "add", "path": "/parts/2/opacity", "value": ...} (existing keys: "id", "parent", "shape", "fill", "z", "mask")');
  });

  it('names the whole document as "" in messages', () => {
    const replacement = { format: 'rev2d', version: 1, meta: { name: 'new', width: 10, height: 10 } };
    const { messages } = applyOk(rigDoc(), [{ op: 'patch', patch: [{ op: 'test', path: '/version', value: 1 }, { op: 'replace', path: '', value: replacement }] }]);
    expect(messages[0]).toMatch(/^applied 2 patch operations: test \/version ok; replace "" \(the whole document\): /);
  });

  it('rejects "__proto__" segments (they would change the prototype, not the model)', () => {
    for (const path of ['/__proto__', '/meta/__proto__', '/parts/0/__proto__/z']) {
      const r = applyFail(rigDoc(), [{ op: 'patch', patch: [{ op: 'add', path, value: { z: 1 } }] }]);
      expect(r.message).toBe(`patch[0] (add ${path}): "__proto__" is not a valid member name`);
    }
  });
});
