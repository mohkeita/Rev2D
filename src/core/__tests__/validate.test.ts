import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../types.js';
import { Rig } from '../rig.js';
import { formatDiagnostics, parseModelText, validateModel } from '../validate.js';
import { compileGeometry } from '../geometry/index.js';
import { MAX_DETAIL_VERTICES } from '../geometry/triangulate.js';
import { ModelSchema } from '../schema.js';

// Tests mutate deep copies of JSON fixtures, so loose typing keeps them readable.
type Json = any;

/** A realistic, fully valid model: every check below breaks exactly one thing in a copy of it. */
const VALID = {
  format: 'rev2d',
  version: 1,
  meta: { name: 'demo', width: 512, height: 512 },
  parameters: [
    { id: 'AngleX', min: -30, max: 30, default: 0 },
    { id: 'AngleY', min: -30, max: 30 },
    { id: 'MouthOpen', min: 0, max: 1 },
    { id: 'HairSway', min: -30, max: 30 },
  ],
  textures: [{ id: 'armTex', path: 'arm.png' }],
  bones: [
    { id: 'root', x: 256, y: 400 },
    { id: 'neck', parent: 'root', y: -100, length: 40 },
    { id: 'head', parent: 'neck', y: -40, length: 60 },
    { id: 'upperArm', parent: 'root', x: 40, y: -80, length: 50 },
    { id: 'foreArm', parent: 'upperArm', x: 50, length: 50 },
    { id: 'handTarget', parent: 'root', x: 120, y: -60 },
  ],
  warps: [{ id: 'faceWarp', parent: 'head', rect: [176, 120, 160, 180], cols: 2, rows: 2 }],
  parts: [
    { id: 'face', parent: 'faceWarp', shape: { type: 'ellipse', cx: 256, cy: 210, rx: 70, ry: 90 }, fill: '#ffe0c0' },
    {
      id: 'mouth',
      parent: 'faceWarp',
      shape: { type: 'path', d: 'M236 250 Q256 260 276 250 Z' },
      fill: '#a0303a',
      stroke: { color: '#40101a', width: 2 },
      mask: ['face'],
    },
    {
      id: 'arm',
      shape: {
        type: 'mesh',
        vertices: [296, 320, 346, 320, 346, 330, 296, 330],
        triangles: [0, 1, 2, 0, 2, 3],
        uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        texture: 'armTex',
      },
      skin: { bones: ['upperArm', 'foreArm'], weights: [[1, 0], [0, 1], [0, 1], [1, 0]] },
    },
    {
      id: 'hair',
      parent: 'head',
      shape: { type: 'polygon', points: [200, 100, 312, 100, 256, 40] },
      fill: { type: 'linear', from: [0, 40], to: [0, 100], stops: [[0, '#402010'], [1, '#603020']] },
    },
  ],
  bindings: [
    {
      target: 'part:mouth.shape.d',
      params: ['MouthOpen'],
      keys: [
        { at: [0], value: 'M236 250 Q256 260 276 250 Z' },
        { at: [1], value: 'M236 250 Q256 290 276 250 Z' },
      ],
    },
    {
      target: 'warp:faceWarp.offsets',
      params: ['AngleX', 'AngleY'],
      keys: [
        { at: [-30, -30], value: { '4': [-10, -10] } },
        { at: [30, -30], value: { '4': [10, -10] } },
        { at: [-30, 30], value: { '4': [-10, 10] } },
        { at: [30, 30], value: { '4': [10, 10] } },
      ],
    },
    { target: 'bone:head.rotation', params: ['AngleX'], keys: [{ at: [-30], value: -10 }, { at: [30], value: 10 }] },
    {
      target: 'part:hair.shape.points',
      params: ['HairSway'],
      keys: [
        { at: [-30], value: { '2': [246, 40] } },
        { at: [30], value: { '2': [266, 40] } },
      ],
    },
  ],
  ik: [{ id: 'armIk', bones: ['upperArm', 'foreArm'], target: 'handTarget' }],
  physics: [
    {
      id: 'hairPhysics',
      inputs: [{ param: 'AngleX', type: 'x', weight: 1.5 }],
      outputs: [{ param: 'HairSway', type: 'angle' }],
      segments: [{ length: 40, mass: 1 }],
    },
  ],
  animations: [
    {
      id: 'idle',
      duration: 2,
      tracks: [
        {
          target: 'param:AngleY',
          keys: [
            { t: 0, v: 0, ease: 'inOutSine' },
            { t: 1, v: 10, ease: 'inOutSine' },
            { t: 2, v: 0 },
          ],
        },
        { target: 'part:mouth.opacity', keys: [{ t: 0, v: 1 }, { t: 2, v: 0.8 }] },
      ],
      events: [{ t: 1, name: 'blink' }],
    },
  ],
};

function variant(edit: (m: Json) => void): Json {
  const m = structuredClone(VALID) as Json;
  edit(m);
  return m;
}

function diagnosticsOf(edit: (m: Json) => void): Diagnostic[] {
  return validateModel(variant(edit)).diagnostics;
}

/** The single diagnostic with `code` (fails if there is none or several). */
function only(diags: Diagnostic[], code: string): Diagnostic {
  const found = diags.filter((d) => d.code === code);
  expect(found, `diagnostics: ${formatDiagnostics(diags)}`).toHaveLength(1);
  return found[0];
}

function codes(diags: Diagnostic[]): string[] {
  return diags.map((d) => d.code);
}

const minimal = { format: 'rev2d', version: 1, meta: { name: 't', width: 10, height: 10 } };

// ------------------------------------------------------------------------------------------------

describe('validateModel: valid input', () => {
  it('accepts a realistic rig without any diagnostics and fills defaults', () => {
    const r = validateModel(VALID);
    expect(formatDiagnostics(r.diagnostics)).toBe('0 errors, 0 warnings');
    expect(r.model).not.toBeNull();
    expect(r.model!.bones[0].rotation).toBe(0);
    expect(r.model!.parts[0].opacity).toBe(1);
    expect(r.model!.warps[0].cols).toBe(2);
  });

  it('only accepts models the rig can compile', () => {
    const accepted = [
      VALID,
      variant((m) => m.parameters.push({ id: 'Spare', min: 0, max: 1, default: 5 })),
      variant((m) => {
        m.parts[0].shape.detail = 8;
        m.parts[3].shape.detail = 4;
      }),
    ];
    for (const input of accepted) {
      const { model, diagnostics } = validateModel(input);
      expect(model, formatDiagnostics(diagnostics)).not.toBeNull();
      expect(() => new Rig(model!)).not.toThrow();
    }
  });

  it('still returns the model when there are only warnings and infos', () => {
    const r = validateModel(variant((m) => m.parameters.push({ id: 'Spare', min: 0, max: 1, default: 5 })));
    expect(codes(r.diagnostics)).toEqual(['param-default-out-of-range', 'unused-parameter']);
    expect(r.model).not.toBeNull();
  });

  it('uses stable kebab-case codes and JSON pointer paths everywhere', () => {
    const inputs = [
      variant((m) => (m.bones[1].rotaton = 5)),
      variant((m) => (m.parts[0].shape.type = 'circle')),
      variant((m) => (m.parts[1].parent = 'hed')),
      variant((m) => m.bindings[1].keys.pop()),
    ];
    for (const input of inputs) {
      for (const d of validateModel(input).diagnostics) {
        expect(d.code).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(d.path).toMatch(/^(\/[^/]*)*$/);
        expect(['error', 'warning', 'info']).toContain(d.severity);
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------

describe('structural diagnostics', () => {
  it('reports each typo-ed key separately with a did-you-mean hint', () => {
    const diags = diagnosticsOf((m) => {
      m.bones[1].rotaton = 5;
      m.bones[1].sclaeX = 2;
    });
    expect(diags).toEqual([
      { severity: 'error', code: 'schema-unrecognized-keys', message: 'unknown key "rotaton"', path: '/bones/1/rotaton', hint: 'did you mean "rotation"?' },
      { severity: 'error', code: 'schema-unrecognized-keys', message: 'unknown key "sclaeX"', path: '/bones/1/sclaeX', hint: 'did you mean "scaleX"?' },
    ]);
  });

  it('suggests top-level section names', () => {
    const d = only(validateModel({ ...minimal, bonez: [] }).diagnostics, 'schema-unrecognized-keys');
    expect(d.path).toBe('/bonez');
    expect(d.hint).toBe('did you mean "bones"?');
  });

  it('lists allowed keys when nothing is close, and never suggests unrelated short words', () => {
    const d = only(validateModel({ ...minimal, a: 1 }).diagnostics, 'schema-unrecognized-keys');
    expect(d.hint).toMatch(/^allowed keys: \$schema, format, version, meta, parameters/);
  });

  it('explains keys that belong to another shape type', () => {
    const d = only(diagnosticsOf((m) => (m.parts[0].shape.radius = 4)), 'schema-unrecognized-keys');
    expect(d.path).toBe('/parts/0/shape/radius');
    expect(d.hint).toContain('"radius" is a field of type "rect", not "ellipse"');
    expect(d.hint).toContain('allowed here: type, cx, cy, rx, ry, rotation, segments, detail');
  });

  it('explains shape fields written directly on the part', () => {
    const diags = diagnosticsOf((m) => {
      m.parts[0] = { id: 'face', type: 'ellipse', cx: 256, cy: 200, rx: 70, ry: 90 };
    });
    const missing = diags.find((d) => d.path === '/parts/0/shape')!;
    expect(missing.message).toBe('missing required field "shape"');
    expect(missing.hint).toBe('move "type", "cx", "cy", "rx", "ry" into "shape"');
    expect(diags.find((d) => d.path === '/parts/0/cx')!.hint).toBe('"cx" belongs inside "shape"');
  });

  it('reports a missing shape "type", guessing it from the fields', () => {
    const diags = diagnosticsOf((m) => delete m.parts[0].shape.type);
    expect(diags).toEqual([
      {
        severity: 'error',
        code: 'schema-invalid-union',
        message: 'missing required field "type"',
        path: '/parts/0/shape/type',
        hint: 'add "type": "ellipse" (valid types: ellipse, rect, polygon, path, mesh, image)',
      },
    ]);
  });

  it('guesses rect over image from x/y/w/h fields', () => {
    const d = only(diagnosticsOf((m) => (m.parts[0].shape = { x: 0, y: 0, w: 10, h: 10 })), 'schema-invalid-union');
    expect(d.hint).toMatch(/^add "type": "rect"/);
  });

  it('suggests the right shape type for wrong names and wrong case', () => {
    const circle = only(diagnosticsOf((m) => (m.parts[0].shape.type = 'circle')), 'schema-invalid-union');
    expect(circle.message).toBe('unknown type "circle"');
    expect(circle.hint).toBe('did you mean "ellipse"? (valid types: ellipse, rect, polygon, path, mesh, image)');
    const upper = only(diagnosticsOf((m) => (m.parts[0].shape.type = 'Ellipse')), 'schema-invalid-union');
    expect(upper.hint).toMatch(/^did you mean "ellipse"\?/);
    const num = only(diagnosticsOf((m) => (m.parts[0].shape.type = 3)), 'schema-invalid-union');
    expect(num.message).toBe('"type" must be a string, got number 3');
  });

  it('collapses fill union noise to the branch matching the given type', () => {
    const diags = diagnosticsOf((m) => (m.parts[3].fill = { type: 'linear', from: [0, 0], stops: [] }));
    expect(diags.map((d) => [d.path, d.code, d.message])).toEqual([
      ['/parts/3/fill/to', 'schema-invalid-type', 'missing required field "to"'],
      ['/parts/3/fill/stops', 'schema-too-small', 'needs at least 1 item, got 0'],
    ]);
    expect(diags[0].hint).toBe('e.g. "to": [0, 0]');
    expect(diags[1].hint).toBe('e.g. "stops": [[0, "#ffffff"], [1, "#000000"]]');
  });

  it('treats a missing or unknown fill type like a discriminator', () => {
    const missing = only(diagnosticsOf((m) => (m.parts[0].fill = { color: 'red' })), 'schema-invalid-union');
    expect(missing.path).toBe('/parts/0/fill/type');
    expect(missing.hint).toBe('add "type": "solid" (valid types: solid, linear, radial)');
    const wrong = only(
      diagnosticsOf((m) => (m.parts[0].fill = { type: 'gradient', from: [0, 0], to: [1, 1], stops: [[0, 'red']] })),
      'schema-invalid-union',
    );
    expect(wrong.message).toBe('unknown type "gradient"');
    expect(wrong.hint).toMatch(/^did you mean "linear"\?/);
  });

  it('summarizes a union when the value has none of the accepted JSON types', () => {
    const fill = only(diagnosticsOf((m) => (m.parts[0].fill = 5)), 'schema-invalid-union');
    expect(fill.message).toBe('expected string or object, got number 5');
    expect(fill.hint).toMatch(/^Fill paint/);
    const value = only(diagnosticsOf((m) => (m.bindings[2].keys[0].value = null)), 'schema-invalid-union');
    expect(value.path).toBe('/bindings/2/keys/0/value');
    expect(value.message).toBe('expected number, array, string, boolean or object, got null');
  });

  it('reports errors inside sparse point maps precisely', () => {
    const diags = diagnosticsOf((m) => (m.bindings[1].keys[0].value = { '4': [1], x: [1, 2] }));
    expect(diags.map((d) => [d.path, d.code, d.message])).toEqual([
      ['/bindings/1/keys/0/value/4', 'schema-too-small', 'expected 2 items, got 1'],
      ['/bindings/1/keys/0/value/x', 'schema-invalid-key', 'invalid point index "x"'],
    ]);
    expect(diags[1].hint).toContain('{"3": [10, 20]}');
  });

  it('points at the bad element of a point list value', () => {
    const d = only(diagnosticsOf((m) => (m.bindings[3].keys[0].value = [1, 'a'])), 'schema-invalid-type');
    expect(d.path).toBe('/bindings/3/keys/0/value/1');
    expect(d.message).toBe('expected a number, got string "a"');
  });

  it('reports missing required fields with an example or a rename hint', () => {
    const noMax = only(diagnosticsOf((m) => delete m.parameters[0].max), 'schema-invalid-type');
    expect(noMax).toMatchObject({ path: '/parameters/0/max', message: 'missing required field "max"', hint: 'e.g. "max": 1' });
    const renamed = diagnosticsOf((m) => {
      m.parameters[0].mn = m.parameters[0].min;
      delete m.parameters[0].min;
    });
    expect(renamed.find((d) => d.path === '/parameters/0/min')!.hint).toBe('rename "mn" to "min"');
    expect(renamed.find((d) => d.path === '/parameters/0/mn')!.hint).toBe('did you mean "min"?');
    const noMeta = only(validateModel({ format: 'rev2d', version: 1 }).diagnostics, 'schema-invalid-type');
    expect(noMeta.hint).toBe('e.g. "meta": { "name": "my-model", "width": 512, "height": 512 }');
    const noShape = only(diagnosticsOf((m) => delete m.parts[0].shape), 'schema-invalid-type');
    expect(noShape.hint).toBe('e.g. "shape": { "type": "ellipse", "cx": 0, "cy": 0, "rx": 20, "ry": 20 }');
  });

  it('gives the format/version hint for wrong or missing header fields', () => {
    const wrong = validateModel({ ...minimal, format: 'r2d', version: 2 }).diagnostics;
    expect(wrong.map((d) => [d.path, d.code, d.message, d.hint])).toEqual([
      ['/format', 'schema-invalid-value', '"format" must be "rev2d", got string "r2d"', '"format": "rev2d", "version": 1'],
      ['/version', 'schema-invalid-value', '"version" must be 1, got number 2', '"format": "rev2d", "version": 1'],
    ]);
    const missing = validateModel({ meta: minimal.meta }).diagnostics;
    expect(missing.map((d) => d.message)).toEqual(['missing required field "format"', 'missing required field "version"']);
    expect(missing.every((d) => d.hint === '"format": "rev2d", "version": 1')).toBe(true);
  });

  it('rejects a non-object model with a skeleton hint', () => {
    const d = only(validateModel([]).diagnostics, 'schema-invalid-type');
    expect(d.path).toBe('');
    expect(d.message).toBe('a model must be a JSON object, got array (0 items)');
    expect(d.hint).toContain('"format": "rev2d", "version": 1');
    expect(validateModel(undefined).diagnostics[0].message).toBe('a model must be a JSON object, got nothing');
  });

  it('explains invalid ids and address-style references', () => {
    const diags = diagnosticsOf((m) => {
      m.bones[0].id = 'root.bone';
      m.bones[1].parent = 'bone:root';
    });
    expect(diags.map((d) => [d.path, d.code, d.message, d.hint])).toEqual([
      ['/bones/0/id', 'schema-invalid-format', 'invalid id "root.bone"', 'ids use letters, digits, _ and - and must not start with a digit, e.g. "root_bone"'],
      ['/bones/1/parent', 'schema-invalid-format', 'invalid id "bone:root"', 'use the bare id "root" (no "kind:" prefix)'],
    ]);
  });

  it('maps enum mistakes to valid options, including CSS/Penner ease names', () => {
    const ease = only(diagnosticsOf((m) => (m.animations[0].tracks[0].keys[0].ease = 'easeInOutSine')), 'schema-invalid-value');
    expect(ease.path).toBe('/animations/0/tracks/0/keys/0/ease');
    expect(ease.message).toBe('invalid value "easeInOutSine" for "ease"');
    expect(ease.hint).toMatch(/^did you mean "inOutSine"\? \(valid: linear, step, /);
    const blend = only(diagnosticsOf((m) => (m.parts[0].blend = 'overlay')), 'schema-invalid-value');
    expect(blend.hint).toBe('valid: normal, add, multiply, screen');
  });

  it('gives targeted hints for wrong primitive types', () => {
    const diags = diagnosticsOf((m) => {
      m.meta.width = '512';
      m.meta.height = 511.5;
      m.parts[0].visible = 'false';
      m.warps[0].parent = null;
    });
    expect(diags.map((d) => [d.path, d.message, d.hint])).toEqual([
      ['/meta/width', 'expected a number, got string "512"', 'write 512 without quotes'],
      ['/meta/height', 'expected an integer, got number 511.5', 'use a whole number, e.g. 512'],
      ['/warps/0/parent', 'expected a string, got null', 'omit "parent" instead of setting it to null'],
      ['/parts/0/visible', 'expected true or false, got string "false"', 'write false without quotes'],
    ]);
  });

  it('shows an example when an object is expected', () => {
    const d = only(diagnosticsOf((m) => (m.parts[1].stroke = '#000')), 'schema-invalid-type');
    expect(d.message).toBe('expected an object, got string "#000"');
    expect(d.hint).toBe('e.g. "stroke": { "color": "#000000", "width": 2 }');
  });

  it('reports tuple lengths and numeric/array bounds', () => {
    const diags = diagnosticsOf((m) => {
      m.warps[0].rect = [0, 0, 10];
      m.parts[0].shape.rx = -1;
      m.parts[0].opacity = 2;
      m.bindings[1].params = ['AngleX', 'AngleY', 'MouthOpen', 'HairSway'];
      m.bindings[2].keys = [];
      m.meta.name = '';
    });
    expect(diags.map((d) => [d.path, d.code, d.message])).toEqual([
      ['/meta/name', 'schema-too-small', 'must not be empty'],
      ['/warps/0/rect', 'schema-too-small', 'expected 4 items, got 3'],
      ['/parts/0/shape/rx', 'schema-too-small', 'must be >= 0, got number -1'],
      ['/parts/0/opacity', 'schema-too-big', 'must be <= 1, got number 2'],
      ['/bindings/1/params', 'schema-too-big', 'allows at most 3 items, got 4'],
      ['/bindings/2/keys', 'schema-too-small', 'needs at least 1 item, got 0'],
    ]);
    expect(diags[1].hint).toMatch(/^\[x, y, width, height\]/);
  });

  it('accepts -1 as the last physics segment but nothing below', () => {
    expect(diagnosticsOf((m) => (m.physics[0].outputs[0].segment = -1))).toEqual([]);
    const d = only(diagnosticsOf((m) => (m.physics[0].outputs[0].segment = -2)), 'schema-too-small');
    expect(d).toMatchObject({ path: '/physics/0/outputs/0/segment', message: 'must be >= -1, got number -2', hint: 'Chain segment index (-1 = last).' });
  });

  it('ignores length checks zod runs on a value of the wrong type', () => {
    // zod still applies `.max(2)` to the string "upperArm" ("allows at most 2 characters").
    const bones = diagnosticsOf((m) => (m.ik[0].bones = 'upperArm'));
    expect(bones.map((d) => [d.path, d.code, d.message])).toEqual([['/ik/0/bones', 'schema-invalid-type', 'expected an array, got string "upperArm"']]);
    // ...and `.min(1)` of the color branch to [], which used to hide the real union mismatch.
    const fill = diagnosticsOf((m) => (m.parts[0].fill = []));
    expect(fill.map((d) => [d.path, d.code, d.message])).toEqual([['/parts/0/fill', 'schema-invalid-union', 'expected string or object, got array (0 items)']]);
  });

  it('reports missing union-typed fields as missing, with rename hints for common key names', () => {
    const track = diagnosticsOf((m) => (m.animations[0].tracks[1].keys = [{ time: 0, value: 1 }]));
    expect(track.map((d) => [d.path, d.code, d.message, d.hint])).toEqual([
      ['/animations/0/tracks/1/keys/0/t', 'schema-invalid-type', 'missing required field "t"', 'rename "time" to "t"'],
      ['/animations/0/tracks/1/keys/0/v', 'schema-invalid-union', 'missing required field "v"', 'rename "value" to "v"'],
      ['/animations/0/tracks/1/keys/0/time', 'schema-unrecognized-keys', 'unknown key "time"', 'did you mean "t"?'],
      ['/animations/0/tracks/1/keys/0/value', 'schema-unrecognized-keys', 'unknown key "value"', 'did you mean "v"?'],
    ]);
    const binding = diagnosticsOf((m) => (m.bindings[2].keys[0] = { at: [-30], v: -10 }));
    expect(binding.map((d) => [d.path, d.message, d.hint])).toEqual([
      ['/bindings/2/keys/0/value', 'missing required field "value"', 'rename "v" to "value"'],
      ['/bindings/2/keys/0/v', 'unknown key "v"', 'did you mean "value"?'],
    ]);
    const noValue = only(diagnosticsOf((m) => delete m.bindings[2].keys[0].value), 'schema-invalid-union');
    expect(noValue).toMatchObject({ message: 'missing required field "value"', hint: 'e.g. "value": 0' });
  });

  it('maps key names AI authors commonly use to the Rev2D spelling', () => {
    const hintAt = (edit: (m: Json) => void, path: string) => diagnosticsOf(edit).find((d) => d.path === path)?.hint;
    expect(hintAt((m) => (m.parameters[0] = { name: 'AngleX', min: -30, max: 30 }), '/parameters/0/name')).toBe('did you mean "id"?');
    expect(hintAt((m) => (m.parameters[0] = { name: 'AngleX', min: -30, max: 30 }), '/parameters/0/id')).toBe('rename "name" to "id"');
    expect(hintAt((m) => (m.parts[0].color = '#fff'), '/parts/0/color')).toBe('did you mean "fill"?');
    expect(hintAt((m) => (m.parts[0].shape = { type: 'rect', x: 0, y: 0, width: 5, h: 5 }), '/parts/0/shape/width')).toBe('did you mean "w"?');
    // Edit distance alone would propose "name" here.
    expect(hintAt((m) => (m.animations[0].events[0] = { time: 1, name: 'blink' }), '/animations/0/events/0/time')).toBe('did you mean "t"?');
  });

  it('shows examples for array items without a key', () => {
    const d = only(diagnosticsOf((m) => (m.parts = [5])), 'schema-invalid-type');
    expect(d.hint).toBe('e.g. { "id": "<id>", "shape": { "type": "ellipse", "cx": 0, "cy": 0, "rx": 20, "ry": 20 } }');
    const stop = only(diagnosticsOf((m) => (m.parts[3].fill.stops = [5])), 'schema-invalid-type');
    expect(stop).toMatchObject({ path: '/parts/3/fill/stops/0', message: 'expected an array of 2 items, got number 5', hint: 'e.g. [1, "#ffffff"]' });
  });

  it('picks the union branch whose JSON type matches the value', () => {
    const bezier = only(diagnosticsOf((m) => (m.animations[0].tracks[0].keys[0].ease = [0.1, 0.2, 0.3])), 'schema-too-small');
    expect(bezier).toMatchObject({ path: '/animations/0/tracks/0/keys/0/ease', message: 'expected 4 items, got 3', hint: 'cubic-bezier(x1, y1, x2, y2)' });
    const num = only(diagnosticsOf((m) => (m.animations[0].tracks[0].keys[0].ease = 5)), 'schema-invalid-union');
    expect(num.message).toBe('expected string or array, got number 5');
    const auto = only(diagnosticsOf((m) => (m.parts[2].skin.weights = 'Auto')), 'schema-invalid-value');
    expect(auto).toMatchObject({ message: 'expected "auto", got string "Auto"', hint: 'did you mean "auto"?' });
  });

  it('skips semantic checks while the structure is invalid', () => {
    const r = validateModel(
      variant((m) => {
        m.bones[1].parent = 'nope'; // semantic problem
        m.bones[2].rotaton = 1; // structural problem
      }),
    );
    expect(r.model).toBeNull();
    expect(codes(r.diagnostics)).toEqual(['schema-unrecognized-keys']);
  });
});

// ------------------------------------------------------------------------------------------------

describe('semantic diagnostics: ids and hierarchy', () => {
  it('reports duplicate ids per kind, allowing the same id across kinds', () => {
    const diags = diagnosticsOf((m) => {
      m.parameters.push({ id: 'AngleX', min: 0, max: 1 });
      m.parts.push({ id: 'face', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 } });
      m.animations.push({ id: 'idle', duration: 1 });
      m.ik.push({ id: 'root', bones: ['head'], target: 'handTarget' }); // same id as a bone: fine
    });
    const dups = diags.filter((d) => d.code === 'duplicate-id');
    expect(dups.map((d) => [d.path, d.message, d.hint])).toEqual([
      ['/parameters/4/id', 'duplicate parameter id "AngleX"', 'already defined at /parameters/0; ids must be unique per kind'],
      ['/parts/4/id', 'duplicate part id "face"', 'already defined at /parts/0; ids must be unique per kind'],
      ['/animations/1/id', 'duplicate animation id "idle"', 'already defined at /animations/0; ids must be unique per kind'],
    ]);
  });

  it('rejects a warp that reuses a bone id (bones and warps share one namespace)', () => {
    const r = validateModel(
      variant((m) => {
        m.warps.push({ id: 'neck', rect: [0, 0, 10, 10] });
        m.parts[3].parent = 'neck'; // resolves, but would be ambiguous: reported once, at the definition
      }),
    );
    expect(r.model).toBeNull();
    expect(r.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'duplicate-id',
        message: 'warp id "neck" is already used by bone /bones/1',
        path: '/warps/1/id',
        hint: 'bones and warps share one id namespace (either can be a "parent"); rename one of them, e.g. "neckWarp"',
      },
    ]);
  });

  it('reports unknown bone parents with did-you-mean', () => {
    const d = only(diagnosticsOf((m) => (m.bones[2].parent = 'nek')), 'unknown-bone');
    expect(d).toMatchObject({ path: '/bones/2/parent', message: 'unknown parent bone "nek"', hint: 'did you mean "neck"?' });
  });

  it('rejects bones parented to warps', () => {
    const d = only(diagnosticsOf((m) => (m.bones[5].parent = 'faceWarp')), 'invalid-parent');
    expect(d.message).toBe(`"faceWarp" is a warp; a bone's parent must be another bone`);
  });

  it('requires part and warp parents to be bones or warps', () => {
    const partParent = only(diagnosticsOf((m) => (m.parts[1].parent = 'face')), 'invalid-parent');
    expect(partParent.message).toBe(`"face" is a part; a part's parent must be a bone or warp`);
    expect(partParent.hint).toContain('"mask": ["face"]');
    const paramParent = only(diagnosticsOf((m) => (m.warps[0].parent = 'AngleX')), 'invalid-parent');
    expect(paramParent.message).toBe(`"AngleX" is a parameter; a warp's parent must be a bone or warp`);
    const unknown = only(diagnosticsOf((m) => (m.parts[1].parent = 'faceWrap')), 'unknown-parent');
    expect(unknown).toMatchObject({ path: '/parts/1/parent', hint: 'did you mean "faceWarp"?' });
  });

  it('detects bone cycles (including self-parenting) once per cycle', () => {
    const diags = diagnosticsOf((m) => {
      m.bones[0].parent = 'head';
      m.bones[5].parent = 'handTarget';
    });
    const cycles = diags.filter((d) => d.code === 'bone-cycle');
    expect(cycles.map((d) => [d.path, d.message])).toEqual([
      ['/bones/0/parent', 'bone parent cycle: "root" → "head" → "neck" → "root"'],
      ['/bones/5/parent', 'bone parent cycle: "handTarget" → "handTarget"'],
    ]);
  });

  it('detects warp cycles through warp parents', () => {
    const diags = diagnosticsOf((m) => {
      m.warps.push({ id: 'inner', parent: 'outer', rect: [0, 0, 10, 10] }, { id: 'outer', parent: 'inner', rect: [0, 0, 10, 10] });
      m.parts[0].parent = 'inner';
    });
    const d = only(diags, 'warp-cycle');
    expect(d).toMatchObject({ path: '/warps/1/parent', message: 'warp parent cycle: "inner" → "outer" → "inner"' });
  });
});

describe('semantic diagnostics: parts', () => {
  it('rejects a part masking itself and unknown mask parts', () => {
    const diags = diagnosticsOf((m) => (m.parts[1].mask = ['mouth', 'fase']));
    expect(only(diags, 'mask-self').path).toBe('/parts/1/mask/0');
    expect(only(diags, 'unknown-part')).toMatchObject({ path: '/parts/1/mask/1', hint: 'did you mean "face"?' });
  });

  it('rejects skin together with parent and checks skin bones', () => {
    const diags = diagnosticsOf((m) => {
      m.parts[2].parent = 'root';
      m.parts[2].skin.bones = ['upperArm', 'upperArm'];
    });
    expect(only(diags, 'skin-with-parent')).toMatchObject({ severity: 'error', path: '/parts/2/parent' });
    expect(only(diags, 'skin-duplicate-bone')).toMatchObject({ severity: 'warning', path: '/parts/2/skin/bones/1' });
    const unknown = only(diagnosticsOf((m) => (m.parts[2].skin.bones[1] = 'forearm')), 'unknown-bone');
    expect(unknown).toMatchObject({ path: '/parts/2/skin/bones/1', hint: 'did you mean "foreArm"?' });
  });

  it('validates explicit skin weights', () => {
    const notMesh = only(diagnosticsOf((m) => (m.parts[0].skin = { bones: ['head'], weights: [[1]] })), 'skin-weights-not-mesh');
    expect(notMesh.path).toBe('/parts/0/skin/weights');
    const diags = diagnosticsOf((m) => (m.parts[2].skin.weights = [[1, 0], [0, 1, 0], [0, 0]]));
    expect(only(diags, 'skin-weights-count').message).toBe('3 weight rows for 4 vertices; there must be one row per vertex');
    expect(only(diags, 'skin-weights-row-length')).toMatchObject({ path: '/parts/2/skin/weights/1', message: 'weight row 1 has 3 values but the skin has 2 bones' });
    expect(only(diags, 'skin-weights-zero-row')).toMatchObject({ severity: 'warning', path: '/parts/2/skin/weights/2' });
    // Weights that cancel out leave the vertex in place just like all-zero weights.
    const cancel = only(diagnosticsOf((m) => (m.parts[2].skin.weights[3] = [1, -1])), 'skin-weights-zero-row');
    expect(cancel).toMatchObject({ path: '/parts/2/skin/weights/3', message: 'the weights of vertex 3 sum to 0, so no bone moves it' });
  });

  it('checks mesh structure', () => {
    const diags = diagnosticsOf((m) => {
      const s = m.parts[2].shape;
      s.vertices.push(5);
      s.triangles = [0, 1, 9, 0, 2, 12, 3];
      s.uvs = [0, 0];
    });
    expect(only(diags, 'mesh-odd-vertices').path).toBe('/parts/2/shape/vertices');
    expect(only(diags, 'mesh-triangles-length').message).toContain('7 indices');
    expect(only(diags, 'mesh-index-out-of-range')).toMatchObject({
      path: '/parts/2/shape/triangles/2',
      message: 'triangle index 9 is out of range: the mesh has 4 vertices (valid 0..3) (+1 more out-of-range)',
    });
    expect(only(diags, 'mesh-uv-count').message).toBe('"uvs" has 2 numbers but "vertices" has 9; they need one [u, v] per vertex');
  });

  it('warns about uvs without texture and empty meshes; checks mesh textures', () => {
    const diags = diagnosticsOf((m) => {
      delete m.parts[2].shape.texture;
      m.parts[2].shape.triangles = [];
    });
    expect(only(diags, 'mesh-uvs-without-texture').severity).toBe('warning');
    expect(only(diags, 'mesh-empty').severity).toBe('warning');
    const unknown = only(diagnosticsOf((m) => (m.parts[2].shape.texture = 'armtex')), 'unknown-texture');
    expect(unknown).toMatchObject({ path: '/parts/2/shape/texture', hint: 'did you mean "armTex"?' });
  });

  it('requires uvs on textured meshes', () => {
    const d = only(diagnosticsOf((m) => delete m.parts[2].shape.uvs), 'mesh-missing-uvs');
    expect(d).toMatchObject({ severity: 'error', path: '/parts/2/shape/uvs', message: 'a textured mesh needs "uvs" to sample "armTex"' });
  });

  it('rejects a detail so fine that the mesh would exceed the vertex budget', () => {
    const diags = diagnosticsOf((m) => {
      m.parts[0].shape.detail = 0.1;
      m.parts[1].shape = { type: 'path', d: 'M0 0 L10 0 L10 10 Z M100 100 L600 100 L600 600 L100 600 Z', detail: 0.5 };
      m.parts[3].shape.detail = 12; // fine
    });
    expect(diags.filter((d) => d.code === 'detail-too-fine').map((d) => [d.path, d.message, d.hint])).toEqual([
      [
        '/parts/0/shape/detail',
        'detail 0.1 would refine this shape into ~2289501 vertices (limit 262144)',
        'use "detail" >= 0.3 (8–16 px is typical for parts in warps or skinned parts)',
      ],
      [
        '/parts/1/shape/detail',
        'detail 0.5 would refine this shape into ~1158701 vertices (limit 262144)',
        'use "detail" >= 1.1 (8–16 px is typical for parts in warps or skinned parts)',
      ],
    ]);
    expect(diagnosticsOf((m) => (m.parts[0].shape.detail = 8))).toEqual([]);
  });

  it('estimates curved paths from the same flattening as the geometry compiler', () => {
    // A scalloped edge of 100 small arcs: the max segment angle refines each of them.
    const d = `M0 0 ${'a3 3 0 0 1 6 0 '.repeat(100)}L600 600 L0 600 Z`;
    const shape = { type: 'path', d, detail: 1 };
    const diag = only(diagnosticsOf((m) => (m.parts[1].shape = shape)), 'detail-too-fine');
    const estimate = /~(\d+) vertices/.exec(diag.message)![1];
    let compileError = '';
    try {
      compileGeometry(ModelSchema.parse({ ...minimal, parts: [{ id: 'p', shape }] }).parts[0], { textures: {} });
    } catch (e) {
      compileError = (e as Error).message;
    }
    expect(compileError).toContain(`(~${estimate} vertices, limit ${MAX_DETAIL_VERTICES})`);
  });

  it('checks image textures', () => {
    const d = only(diagnosticsOf((m) => m.parts.push({ id: 'img', shape: { type: 'image', texture: 'armTexture', x: 0, y: 0 } })), 'unknown-texture');
    expect(d.path).toBe('/parts/4/shape/texture');
  });

  it('checks polygon point lists', () => {
    const odd = only(diagnosticsOf((m) => m.parts[3].shape.points.push(1)), 'polygon-odd-length');
    expect(odd.path).toBe('/parts/3/shape/points');
    const few = only(diagnosticsOf((m) => (m.parts[3].shape.points = [0, 0, 10, 10])), 'polygon-too-few-points');
    expect(few.message).toBe('a polygon needs at least 3 points, got 2');
  });

  it('reports SVG path syntax errors with the parser message', () => {
    const d = only(diagnosticsOf((m) => (m.parts[1].shape.d = 'M0 0 X10 10')), 'path-syntax');
    expect(d.path).toBe('/parts/1/shape/d');
    expect(d.message).toBe('invalid SVG path: unsupported path command "X" at offset 5');
  });

  it('rejects SVG path numbers that overflow to infinity, in shapes and keyforms', () => {
    const diags = diagnosticsOf((m) => (m.parts[1].shape.d = 'M0 0 L1e999 0 Z'));
    expect(diags.map((d) => [d.code, d.path, d.message, d.hint])).toEqual([
      ['path-syntax', '/parts/1/shape/d', 'invalid SVG path: number "1e999" is too large', 'path numbers must be finite'],
    ]);
    const keyform = only(diagnosticsOf((m) => (m.bindings[0].keys[1].value = 'M236 250 Q256 1e400 276 250 Z')), 'invalid-value');
    expect(keyform).toMatchObject({ path: '/bindings/0/keys/1/value', message: 'SVG path number "1e400" is too large for "part:mouth.shape.d"' });
  });

  it('does not pile value errors on bindings of a broken shape', () => {
    const diags = diagnosticsOf((m) => (m.parts[1].shape.d = 'M0 0 L'));
    expect(codes(diags)).toEqual(['path-syntax']);
  });

  it('validates every color string', () => {
    const diags = diagnosticsOf((m) => {
      m.meta.background = 'skyblue';
      m.bones[0].color = '#12';
      m.parts[0].tint = 'rgb(1,2)';
      m.parts[1].stroke.color = '#ggg';
      m.parts[3].fill.stops[1][1] = 'bleu';
    });
    expect(diags.filter((d) => d.code === 'invalid-color').map((d) => d.path)).toEqual([
      '/meta/background',
      '/bones/0/color',
      '/parts/0/tint',
      '/parts/1/stroke/color',
      '/parts/3/fill/stops/1/1',
    ]);
  });
});

describe('semantic diagnostics: parameters and textures', () => {
  it('checks parameter ranges and defaults', () => {
    const diags = diagnosticsOf((m) => {
      m.parameters[0].min = 40;
      m.parameters[1].min = 30;
      m.parameters[2].default = 2;
    });
    expect(only(diags, 'param-range-inverted')).toMatchObject({ severity: 'error', path: '/parameters/0/min', hint: 'swap "min" and "max"' });
    expect(only(diags, 'param-range-empty')).toMatchObject({ severity: 'warning', path: '/parameters/1/max' });
    expect(only(diags, 'param-default-out-of-range')).toMatchObject({
      severity: 'warning',
      path: '/parameters/2/default',
      message: 'default 2 is outside [0, 1] and will be clamped to 1',
    });
  });

  it('rejects empty texture paths', () => {
    expect(only(diagnosticsOf((m) => (m.textures[0].path = ' ')), 'texture-empty-path').path).toBe('/textures/0/path');
  });

  it('reports unused parameters, textures and warps as info', () => {
    const diags = diagnosticsOf((m) => {
      m.parameters.push({ id: 'Blink', min: 0, max: 1 });
      m.animations[0].tracks.push({ target: 'param:Blink', keys: [{ t: 0, v: 1 }] });
      m.textures.push({ id: 'spare', path: 'spare.png' });
      m.warps.push({ id: 'bodyWarp', rect: [0, 0, 10, 10] });
      m.warps.push({ id: 'boundWarp', rect: [0, 0, 10, 10] });
      m.bindings.push({ target: 'warp:boundWarp.offsets', params: ['AngleX'], keys: [{ at: [0], value: {} }, { at: [30], value: { '0': [2, 0] } }] });
    });
    expect(diags.every((d) => d.severity === 'info')).toBe(true);
    expect(diags.map((d) => [d.code, d.path])).toEqual([
      ['unused-parameter', '/parameters/4'],
      ['unused-texture', '/textures/1'],
      ['unused-warp', '/warps/1'],
      ['unused-warp', '/warps/2'],
    ]);
    expect(diags[0].hint).toContain('is animated (/animations/0/tracks/2)');
    expect(diags[2].message).toBe('warp "bodyWarp" has no children and nothing drives it');
    expect(diags[3].message).toContain('deforms nothing');
  });
});

describe('semantic diagnostics: bindings', () => {
  it('reports unresolvable targets with the address hint', () => {
    const typo = only(diagnosticsOf((m) => (m.bindings[2].target = 'bone:head.rotaton')), 'invalid-target');
    expect(typo).toMatchObject({ path: '/bindings/2/target', message: 'bone has no property "rotaton"', hint: 'did you mean "rotation"?' });
    const unknown = only(diagnosticsOf((m) => (m.bindings[2].target = 'bone:hed.rotation')), 'invalid-target');
    expect(unknown).toMatchObject({ message: 'unknown bone "hed"', hint: 'did you mean "head"?' });
    const noKind = only(diagnosticsOf((m) => (m.bindings[2].target = 'head.rotation')), 'invalid-target');
    expect(noKind.message).toBe('address "head.rotation" has no kind prefix');
    const gradient = only(diagnosticsOf((m) => (m.bindings[2].target = 'part:hair.fill')), 'invalid-target');
    expect(gradient.message).toContain('gradient');
    const noStroke = only(diagnosticsOf((m) => (m.bindings[2].target = 'part:face.stroke.width')), 'invalid-target');
    expect(noStroke.hint).toBe('add a "stroke" object first');
  });

  it('never proposes unrelated words for short address parts', () => {
    const hint = (target: string) => only(diagnosticsOf((m) => (m.bindings[2].target = target)), 'invalid-target').hint;
    expect(hint('part:face.shape')).toBe('valid: cx, cy, rx, ry, rotation');
    expect(hint('bone:head.r')).toBe('valid: x, y, rotation, scaleX, scaleY, length');
    expect(hint('a:head.x')).toBe('kinds: param, bone, warp, part, ik');
    expect(hint('part:face.shape.Rx')).toBe('did you mean "rx"?');
    expect(hint('warp:faceWrap.offsets')).toBe('did you mean "faceWarp"?');
    expect(hint('ik:nope.mix')).toBe('valid: armIk');
  });

  it('stays fast when many references are unknown (did-you-mean against every id)', () => {
    const input = variant((m) => {
      for (let i = 0; i < 2000; i++) m.bones.push({ id: `bone${i}`, parent: `missing${i}` });
    });
    const start = performance.now();
    const diags = validateModel(input).diagnostics;
    expect(diags.filter((d) => d.code === 'unknown-bone')).toHaveLength(2000);
    expect(diags[0].hint).toBe('known bones: "root", "neck", "head", "upperArm", "foreArm", "handTarget", "bone0", "bone1", "bone2", "bone3", … (+1996 more)');
    expect(performance.now() - start).toBeLessThan(2000); // ~8 s with an unbounded Levenshtein per id
  });

  it('forbids param targets in bindings', () => {
    const d = only(diagnosticsOf((m) => (m.bindings[2].target = 'param:AngleY')), 'binding-param-target');
    expect(d.path).toBe('/bindings/2/target');
  });

  it('checks binding parameters', () => {
    const unknown = only(diagnosticsOf((m) => (m.bindings[2].params = ['AngelX'])), 'unknown-parameter');
    expect(unknown).toMatchObject({ path: '/bindings/2/params/0', message: 'unknown parameter "AngelX"', hint: 'did you mean "AngleX"?' });
    const dup = only(
      diagnosticsOf((m) => {
        m.bindings[2].params = ['AngleX', 'AngleX'];
        m.bindings[2].keys = [{ at: [0, 0], value: 1 }];
      }),
      'binding-duplicate-param',
    );
    expect(dup.path).toBe('/bindings/2/params/1');
  });

  it('checks that every key has one "at" value per parameter', () => {
    const d = only(diagnosticsOf((m) => (m.bindings[1].keys[2].at = [-30])), 'binding-at-length');
    expect(d).toMatchObject({
      path: '/bindings/1/keys/2/at',
      message: '"at" has 1 value(s) but the binding has 2 parameter(s) ("AngleX", "AngleY")',
      hint: 'one value per parameter, in "params" order, e.g. "at": [0, 0]',
    });
  });

  it('reports a binding grid with a missing corner, listing the missing combination', () => {
    const d = only(diagnosticsOf((m) => m.bindings[1].keys.pop()), 'binding-grid-incomplete');
    expect(d).toMatchObject({
      path: '/bindings/1/keys',
      message: 'keyforms do not form a full grid: AngleX {-30, 30} × AngleY {-30, 30} needs 4 keys, 1 missing',
      hint: 'add keys with "at": [30, 30]',
    });
  });

  it('caps the list of missing grid combinations', () => {
    const d = only(
      diagnosticsOf((m) => {
        m.bindings[1].keys = [...Array(5).keys()].map((k) => ({ at: [k * 10 - 20, k * 10 - 20], value: {} }));
      }),
      'binding-grid-incomplete',
    );
    expect(d.message).toContain('needs 25 keys, 20 missing');
    expect(d.hint).toBe('add keys with "at": [-20, -10], [-20, 0], [-20, 10], [-20, 20], [-10, -20], [-10, 0], [-10, 10], [-10, 20], … (+12 more)');
  });

  it('rejects duplicate keyforms', () => {
    const diags = diagnosticsOf((m) => m.bindings[2].keys.push({ at: [30], value: 12 }));
    expect(only(diags, 'binding-duplicate-key')).toMatchObject({
      path: '/bindings/2/keys/2',
      message: 'duplicate keyform at [30] (same "at" as /bindings/2/keys/1)',
    });
  });

  it('warns about keyforms outside the parameter range', () => {
    const d = only(diagnosticsOf((m) => (m.bindings[2].keys[1].at = [45])), 'binding-key-out-of-range');
    expect(d).toMatchObject({ severity: 'warning', path: '/bindings/2/keys/1/at/0', message: '"AngleX" value 45 is outside its range [-30, 30]' });
  });

  it('validates keyform values against the target type', () => {
    const points = only(diagnosticsOf((m) => (m.bindings[1].keys[0].value = [1, 2, 3, 4])), 'invalid-value');
    expect(points).toMatchObject({
      path: '/bindings/1/keys/0/value',
      message: 'expected 18 numbers (9 points), got 4 for "warp:faceWarp.offsets"',
    });
    expect(points.hint).toContain('sparse map');
    const sparse = only(diagnosticsOf((m) => (m.bindings[3].keys[0].value = { '3': [0, 0] })), 'invalid-value');
    expect(sparse.message).toBe('point index 3 out of range (0..2) for "part:hair.shape.points"');
    const path = only(diagnosticsOf((m) => (m.bindings[0].keys[1].value = 'M236 250 L276 250 Z')), 'invalid-value');
    expect(path.message).toBe('path structure differs from the setup path for "part:mouth.shape.d"');
    expect(path.hint).toContain('"M2 Q4 Z0" (got "M2 L2 Z0")');
    const num = only(diagnosticsOf((m) => (m.bindings[2].keys[0].value = '-10')), 'invalid-value');
    expect(num.message).toBe('expected a number, got "-10" for "bone:head.rotation"');
  });
});

describe('semantic diagnostics: animations', () => {
  it('checks track targets, allowing parameters', () => {
    const d = only(diagnosticsOf((m) => (m.animations[0].tracks[0].target = 'param:AngleZ')), 'invalid-target');
    expect(d).toMatchObject({ path: '/animations/0/tracks/0/target', message: 'unknown parameter "AngleZ"' });
  });

  it('warns about two tracks on the same property', () => {
    const d = only(
      diagnosticsOf((m) => m.animations[0].tracks.push({ target: 'part:mouth.opacity', keys: [{ t: 0, v: 0.5 }] })),
      'duplicate-track',
    );
    expect(d).toMatchObject({ severity: 'warning', path: '/animations/0/tracks/2/target' });
    expect(d.message).toBe('"part:mouth.opacity" is already animated by /animations/0/tracks/1 in this animation');
    expect(d.hint).toBe('both tracks apply and their changes add up; merge their keys into one track');
    // Parameter tracks blend toward their value, so the later one wins instead (SPEC §6).
    const param = only(
      diagnosticsOf((m) => m.animations[0].tracks.push({ target: 'param:AngleY', keys: [{ t: 0, v: 5 }] })),
      'duplicate-track',
    );
    expect(param.hint).toBe('the later track overrides the earlier one; merge their keys into one track');
  });

  it('requires strictly increasing key times', () => {
    const diags = diagnosticsOf((m) => {
      m.animations[0].tracks[0].keys = [
        { t: 0, v: 0 },
        { t: 1.5, v: 5 },
        { t: 1, v: 3 },
        { t: 1, v: 4 },
      ];
    });
    expect(only(diags, 'keys-unsorted')).toMatchObject({ path: '/animations/0/tracks/0/keys/2/t', message: 'key time 1 comes after a key at t=1.5' });
    expect(only(diags, 'duplicate-key-time')).toMatchObject({
      path: '/animations/0/tracks/0/keys/3/t',
      message: 'two keys at t=1',
      hint: 'same "t" as /animations/0/tracks/0/keys/2; key times must be strictly increasing, so remove or move one of them',
    });
  });

  it('finds duplicate key times that are not next to each other', () => {
    const diags = diagnosticsOf((m) => {
      m.animations[0].tracks[1].keys = [
        { t: 0, v: 1 },
        { t: 1, v: 1 },
        { t: 0.5, v: 1 },
        { t: 1, v: 0.5 },
      ];
    });
    expect(diags.map((d) => [d.code, d.path])).toEqual([
      ['keys-unsorted', '/animations/0/tracks/1/keys/2/t'],
      ['duplicate-key-time', '/animations/0/tracks/1/keys/3/t'],
    ]);
  });

  it('warns about keys and events after the duration', () => {
    const diags = diagnosticsOf((m) => {
      m.animations[0].tracks[1].keys[1].t = 2.5;
      m.animations[0].events[0].t = 3;
    });
    expect(only(diags, 'key-after-duration')).toMatchObject({ severity: 'warning', path: '/animations/0/tracks/1/keys/1/t' });
    expect(only(diags, 'event-after-duration')).toMatchObject({ severity: 'warning', path: '/animations/0/events/0/t' });
  });

  it('validates track values and warns about parameter values outside the range', () => {
    const color = only(
      diagnosticsOf((m) => m.animations[0].tracks.push({ target: 'part:face.tint', keys: [{ t: 0, v: 'nope' }] })),
      'invalid-value',
    );
    expect(color).toMatchObject({ path: '/animations/0/tracks/2/keys/0/v', message: 'invalid color "nope" for "part:face.tint"' });
    const range = only(diagnosticsOf((m) => (m.animations[0].tracks[0].keys[1].v = 90)), 'track-value-out-of-range');
    expect(range).toMatchObject({ severity: 'warning', path: '/animations/0/tracks/0/keys/1/v' });
  });
});

describe('semantic diagnostics: ik and physics', () => {
  it('reports unknown ik bones and targets', () => {
    const diags = diagnosticsOf((m) => {
      m.ik[0].bones = ['uperArm', 'foreArm'];
      m.ik[0].target = 'handTarge';
    });
    expect(diags.map((d) => [d.code, d.path, d.hint])).toEqual([
      ['unknown-bone', '/ik/0/bones/0', 'did you mean "upperArm"?'],
      ['unknown-bone', '/ik/0/target', 'did you mean "handTarget"?'],
    ]);
  });

  it('detects a reversed two-bone chain', () => {
    const d = only(diagnosticsOf((m) => (m.ik[0].bones = ['foreArm', 'upperArm'])), 'ik-not-chain');
    expect(d).toMatchObject({
      path: '/ik/0/bones/1',
      message: '"upperArm" is not a direct child of "foreArm"',
      hint: 'the order is reversed: use ["upperArm", "foreArm"] (parent first)',
    });
  });

  it('detects a chain whose second bone is not a direct child', () => {
    const diags = diagnosticsOf((m) => (m.ik[0].bones = ['root', 'foreArm']));
    expect(only(diags, 'ik-not-chain').hint).toContain(`"foreArm"'s parent is "upperArm"`);
    const twice = only(diagnosticsOf((m) => (m.ik[0].bones = ['foreArm', 'foreArm'])), 'ik-not-chain');
    expect(twice.message).toBe('the chain lists "foreArm" twice');
  });

  it('rejects targets inside or below the chain', () => {
    const inChain = only(diagnosticsOf((m) => (m.ik[0].target = 'foreArm')), 'ik-target-in-chain');
    expect(inChain.message).toBe('IK target "foreArm" is one of the chain bones');
    const below = only(diagnosticsOf((m) => (m.bones[5].parent = 'foreArm')), 'ik-target-in-chain');
    expect(below).toMatchObject({ path: '/ik/0/target' });
    expect(below.message).toContain('descendant of chain bone "foreArm"');
  });

  it('checks physics parameters and segments', () => {
    const diags = diagnosticsOf((m) => {
      m.physics[0].inputs[0].param = 'AngleXX';
      m.physics[0].outputs[0].segment = 1;
    });
    expect(only(diags, 'unknown-parameter')).toMatchObject({ path: '/physics/0/inputs/0/param', hint: 'did you mean "AngleX"?' });
    expect(only(diags, 'physics-bad-segment')).toMatchObject({
      path: '/physics/0/outputs/0/segment',
      message: 'segment 1 does not exist: the chain has 1 segment(s) (0..0)',
    });
  });

  it('warns when a physics output is animated or feeds itself', () => {
    const animated = only(
      diagnosticsOf((m) => m.animations[0].tracks.push({ target: 'param:HairSway', keys: [{ t: 0, v: 0 }] })),
      'physics-output-animated',
    );
    expect(animated).toMatchObject({ severity: 'warning', path: '/physics/0/outputs/0/param' });
    expect(animated.message).toContain('/animations/0/tracks/2');
    const feedback = only(
      diagnosticsOf((m) => m.physics[0].inputs.push({ param: 'HairSway', type: 'angle' })),
      'physics-feedback',
    );
    expect(feedback).toMatchObject({ severity: 'warning', path: '/physics/0/outputs/0/param' });
  });
});

describe('semantic diagnostics: ordering', () => {
  it('orders diagnostics by section and item, not by check', () => {
    const diags = diagnosticsOf((m) => {
      m.animations[0].tracks[0].target = 'param:Nope';
      m.parts[3].parent = 'nope';
      m.bones[5].parent = 'nope';
      m.bones[1].parent = 'nope';
      m.bones.push({ id: 'neck' });
      m.parameters[0].min = 99;
    });
    expect(diags.map((d) => d.path)).toEqual([
      '/parameters/0/min',
      '/bones/1/parent',
      '/bones/5/parent',
      '/bones/6/id',
      '/parts/3/parent',
      '/animations/0/tracks/0/target',
    ]);
  });
});

// ------------------------------------------------------------------------------------------------

describe('parseModelText', () => {
  const text = JSON.stringify(VALID, null, 2);

  it('parses plain JSON identically to validateModel', () => {
    const r = parseModelText(text);
    expect(r.diagnostics).toEqual([]);
    expect(r.model).toEqual(validateModel(VALID).model);
  });

  it('accepts a BOM, comments and trailing commas (JSONC)', () => {
    const jsonc = `﻿// Rev2D demo
{
  /* header */ "format": "rev2d", "version": 1, // trailing comment
  "meta": { "name": "a // not a comment /* nor this */", "width": 64, "height": 64, },
  "parameters": [ { "id": "A", "min": 0, "max": 1, }, ],
}
`;
    const r = parseModelText(jsonc);
    expect(r.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(r.model!.meta.name).toBe('a // not a comment /* nor this */');
    expect(r.model!.parameters).toHaveLength(1);
  });

  it('decodes string escapes', () => {
    const r = parseModelText('{"format":"rev2d","version":1,"meta":{"name":"\\u0041\\n\\"x\\"","width":1,"height":1}}');
    expect(r.model!.meta.name).toBe('A\n"x"');
  });

  it('reports a missing comma at the place the comma belongs', () => {
    const r = parseModelText('{\n  "format": "rev2d",\n  "meta": { "name": "x" "width": 1 }\n}');
    expect(r.model).toBeNull();
    expect(r.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'json-syntax',
        message: 'line 3, column 24: missing "," after the value of "name"',
        path: '/meta',
        hint: `3 |   "meta": { "name": "x" "width": 1 }\n  | ${' '.repeat(23)}^`,
      },
    ]);
  });

  it('reports unclosed containers with where they were opened', () => {
    const [d] = parseModelText('{\n  "parts": [\n    { "id": "a" }\n').diagnostics;
    expect(d.code).toBe('json-syntax');
    expect(d.message).toBe('line 4, column 1: unexpected end of input: the array opened at line 2, column 12 is never closed');
    expect(d.path).toBe('/parts');
  });

  it('explains common non-JSON syntax', () => {
    const cases: Array<[string, string]> = [
      ["{'format': 1}", 'line 1, column 2: property names must use double quotes ("...")'],
      ['{format: 1}', 'line 1, column 2: property names must be double-quoted: "format"'],
      ['{"a": 01}', 'line 1, column 7: invalid number "01"'],
      ['{"a": .5}', 'line 1, column 7: numbers need a leading digit (e.g. 0.5)'],
      ['{"a": True}', 'line 1, column 7: use lowercase true'],
      ['{"a": NaN}', 'line 1, column 7: NaN is not valid JSON; use a finite number'],
      ['{"a": "x\n"}', 'line 1, column 9: unterminated string (strings cannot span lines; close it or use \\n)'],
      ['{"a": "x', 'line 1, column 7: unterminated string (missing closing ")'],
      ['{"a": 1} x', 'line 1, column 10: unexpected "x" after the end of the document'],
      ['{"a": [1,, 2]}', 'line 1, column 10: unexpected "," (expected a value)'],
      ['{"a": [1 2]}', 'line 1, column 9: missing "," after array item 0'],
      ['{"a": 1 /* open', 'line 1, column 9: unterminated /* comment'],
      ['{"a": "\\q"}', 'line 1, column 8: invalid escape "\\q" (valid: \\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX)'],
      ['  ', 'line 1, column 3: the document is empty (expected a JSON object)'],
    ];
    for (const [input, message] of cases) {
      const r = parseModelText(input);
      expect(r.diagnostics, input).toHaveLength(1);
      expect(r.diagnostics[0].code).toBe('json-syntax');
      expect(r.diagnostics[0].message, input).toBe(message);
    }
  });

  it('counts lines across CRLF and keeps the caret aligned past tabs', () => {
    const [d] = parseModelText('{\r\n\t"a": 1\r\n\t"b": 2\r\n}').diagnostics;
    expect(d.message).toBe('line 2, column 8: missing "," after the value of "a"');
    expect(d.hint).toBe('2 |  "a": 1\n  |        ^');
  });

  it('treats a lone CR as a line break (and as the end of a // comment)', () => {
    const [d] = parseModelText('{\r"a": 1, // note\r"b" 2\r}').diagnostics;
    expect(d.message).toBe('line 3, column 5: expected ":" after property name "b", got "2"');
    expect(d.hint).toBe('3 | "b" 2\n  |     ^');
  });

  it('reports absurdly deep nesting as a syntax error instead of overflowing the stack', () => {
    const cases: Array<[string, number]> = [
      ['['.repeat(100_000) + ']'.repeat(100_000), 513],
      ['{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000), 512 * 5 + 1],
    ];
    for (const [text, column] of cases) {
      const r = parseModelText(text);
      expect(r.diagnostics).toHaveLength(1);
      expect(r.diagnostics[0].code).toBe('json-syntax');
      expect(r.diagnostics[0].message).toBe(`line 1, column ${column}: nesting is too deep (more than 512 levels)`);
    }
    // Deep but reasonable nesting (e.g. inside event data) still parses.
    const nested = '['.repeat(100) + ']'.repeat(100);
    const r = parseModelText(`{"format":"rev2d","version":1,"meta":{"name":"a","width":1,"height":1},"animations":[{"id":"a","duration":1,"events":[{"t":0,"name":"e","data":${nested}}]}]}`);
    expect(r.diagnostics).toEqual([]);
  });

  it('windows long lines in the excerpt and keeps the caret aligned', () => {
    const long = `{"meta": {"name": "${'x'.repeat(200)}" "width": 1}}`;
    const [d] = parseModelText(long).diagnostics;
    const [line, caret] = d.hint!.split('\n');
    expect(line.startsWith('1 | …')).toBe(true);
    expect(line.length).toBeLessThan(120);
    const caretCol = caret.indexOf('^');
    expect(line.slice(caretCol - 1, caretCol + 2)).toBe('" "');
  });

  it('warns about duplicate keys, keeping the last value like JSON.parse', () => {
    const r = parseModelText('{"format":"rev2d","version":1,"meta":{"name":"a","name":"b","width":1,"height":1}}');
    expect(r.diagnostics).toEqual([
      { severity: 'warning', code: 'json-duplicate-key', message: 'duplicate key "name"; the last value wins', path: '/meta/name', hint: 'remove one of the duplicates' },
    ]);
    expect(r.model!.meta.name).toBe('b');
  });

  it('keeps "__proto__" as a plain (unknown) key', () => {
    const r = parseModelText('{"format":"rev2d","version":1,"meta":{"name":"a","width":1,"height":1},"__proto__":{"x":1}}');
    expect(codes(r.diagnostics)).toEqual(['schema-unrecognized-keys']);
    expect(r.diagnostics[0].path).toBe('/__proto__');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('runs full validation after parsing', () => {
    const r = parseModelText(text.replace('"parent": "neck"', '"parent": "nek"'));
    expect(only(r.diagnostics, 'unknown-bone').hint).toBe('did you mean "neck"?');
  });
});

// ------------------------------------------------------------------------------------------------

describe('formatDiagnostics', () => {
  it('renders one line per diagnostic plus a summary', () => {
    const out = formatDiagnostics([
      { severity: 'error', code: 'unknown-bone', message: 'unknown bone "hed"', path: '/parts/3/parent', hint: 'did you mean "head"?' },
    ]);
    expect(out).toBe('error   /parts/3/parent  unknown-bone  unknown bone "hed"  → did you mean "head"?\n1 error, 0 warnings');
  });

  it('aligns columns, pluralizes the summary and shows the root as (root)', () => {
    const out = formatDiagnostics([
      { severity: 'error', code: 'a', message: 'm1', path: '' },
      { severity: 'error', code: 'long-code', message: 'm2', path: '/bones/10/parent' },
      { severity: 'warning', code: 'w', message: 'm3', path: '/x' },
      { severity: 'info', code: 'i', message: 'm4', path: '/y' },
    ]);
    expect(out.split('\n')).toEqual([
      'error   (root)            a          m1',
      'error   /bones/10/parent  long-code  m2',
      'warning /x                w          m3',
      'info    /y                i          m4',
      '2 errors, 1 warning, 1 info',
    ]);
  });

  it('prints multi-line hints indented below the diagnostic', () => {
    const [d] = parseModelText('{"a" 1}').diagnostics;
    expect(formatDiagnostics([d]).split('\n')).toEqual([
      'error   (root)  json-syntax  line 1, column 6: expected ":" after property name "a", got "1"',
      '        1 | {"a" 1}',
      '          |      ^',
      '1 error, 0 warnings',
    ]);
  });

  it('summarizes an empty list', () => {
    expect(formatDiagnostics([])).toBe('0 errors, 0 warnings');
  });
});

describe('semantic diagnostics: nested warps, IK options, track offsets', () => {
  const nested = (rect: number[]) => (m: Json) => {
    m.warps.push({ id: 'eyeWarp', parent: 'faceWarp', rect, cols: 1, rows: 1 });
    m.parts[1].parent = 'eyeWarp';
  };

  it('accepts a child warp inside its parent warp (touching edges included)', () => {
    expect(diagnosticsOf(nested([176, 120, 160, 180]))).toEqual([]);
    // The mouth (with its stroke: x 235..277, y 249..256) must stay inside its new warp too.
    expect(diagnosticsOf(nested([200, 150, 100, 110]))).toEqual([]);
  });

  it('warns when a child warp extends outside its parent warp, per side, with a covering rect', () => {
    // faceWarp is [176, 120, 160, 180] -> x 176..336, y 120..300.
    const d = only(diagnosticsOf(nested([170, 110, 100, 200.5])), 'warp-outside-parent');
    expect(d).toMatchObject({ severity: 'warning', path: '/warps/1/rect' });
    expect(d.message).toBe(
      'warp "eyeWarp" rect [170, 110, 100, 200.5] extends outside its parent warp "faceWarp" rect [176, 120, 160, 180] by 6 px on the left, 10 px at the top, 10.5 px at the bottom; ' +
        `lattice points there are extrapolated from "faceWarp"'s edge cells, so they drift or stretch more than the parent's border when it deforms`,
    );
    expect(d.hint).toBe(
      'enlarge "faceWarp" to cover it ("rect": [170, 110, 166, 200.5]), shrink this rect to fit inside [176, 120, 160, 180], or parent "eyeWarp" to bone "head" (which "faceWarp" follows) instead',
    );
    const right = only(diagnosticsOf(nested([300, 200, 50, 20])), 'warp-outside-parent');
    expect(right.message).toContain('by 14 px on the right;');
  });

  it('omits the re-parent suggestion when the parent warp is in model space', () => {
    const d = only(
      diagnosticsOf((m) => {
        delete m.warps[0].parent;
        nested([0, 0, 10, 10])(m);
      }),
      'warp-outside-parent',
    );
    expect(d.hint).toBe('enlarge "faceWarp" to cover it ("rect": [0, 0, 336, 300]), shrink this rect to fit inside [176, 120, 160, 180]');
  });

  it('warns about softness on one-bone IK, and stretch on a zero-length aim bone', () => {
    const soft = only(
      diagnosticsOf((m) => m.ik.push({ id: 'look', bones: ['head'], target: 'handTarget', softness: 5 })),
      'ik-softness-one-bone',
    );
    expect(soft).toMatchObject({ severity: 'warning', path: '/ik/1/softness', message: 'softness has no effect on a one-bone (aim) IK constraint' });
    // Stretch on a one-bone IK scales its length: fine, unless there is no length.
    expect(diagnosticsOf((m) => m.ik.push({ id: 'look', bones: ['head'], target: 'handTarget', stretch: true }))).toEqual([]);
    const zero = only(
      diagnosticsOf((m) => m.ik.push({ id: 'look', bones: ['handTarget'], target: 'head', stretch: true })),
      'ik-stretch-zero-length',
    );
    expect(zero).toMatchObject({ severity: 'warning', path: '/ik/1/stretch' });
    expect(zero.message).toBe('stretch has no effect: bone "handTarget" has length 0, so there is no length to scale toward the target');
  });

  it('accepts sensible two-bone softness and warns when it reaches the chain length', () => {
    expect(diagnosticsOf((m) => Object.assign(m.ik[0], { softness: 10, stretch: true }))).toEqual([]);
    const d = only(diagnosticsOf((m) => (m.ik[0].softness = 100)), 'ik-softness-too-large');
    expect(d).toMatchObject({ severity: 'warning', path: '/ik/0/softness' });
    expect(d.message).toBe(
      "softness 100 px is at least the chain's reach 100 px (setup pose), so the chain bends short of every target and never straightens before it is 200 px away",
    );
    expect(d.hint).toBe('use a softness well below the reach, typically 5–15% of it (e.g. 10)');
  });

  it('warns when a non-looping track offset leaves the keys entirely', () => {
    const late = only(
      diagnosticsOf((m) => {
        m.animations[0].loop = false;
        m.animations[0].tracks[0].offset = 2;
      }),
      'track-offset-no-effect',
    );
    expect(late).toMatchObject({ severity: 'warning', path: '/animations/0/tracks/0/offset' });
    expect(late.message).toBe(
      'offset 2 makes this track sample t = -2..0 s, entirely before its first key (keys 0..2 s), so it holds the first value for the whole (non-looping) animation',
    );
    expect(late.hint).toBe('use an offset between -2 and 2 (exclusive), or set "loop": true so the offset wraps around the duration');
    const early = only(
      diagnosticsOf((m) => {
        m.animations[0].loop = false;
        m.animations[0].tracks[0].offset = -2.5;
      }),
      'track-offset-no-effect',
    );
    expect(early.message).toContain('entirely after its last key');
    // Looping animations wrap any offset; partial overlap is fine.
    expect(diagnosticsOf((m) => (m.animations[0].tracks[0].offset = 5))).toEqual([]);
    expect(diagnosticsOf((m) => ((m.animations[0].loop = false), (m.animations[0].tracks[0].offset = 1.5)))).toEqual([]);
  });

  it('accepts the smooth ease and suggests it for spline-like names', () => {
    expect(diagnosticsOf((m) => (m.animations[0].tracks[0].keys[0].ease = 'smooth'))).toEqual([]);
    const d = only(diagnosticsOf((m) => (m.animations[0].tracks[0].keys[0].ease = 'catmullRom')), 'schema-invalid-value');
    expect(d.hint).toContain('did you mean "smooth"?');
  });
});

describe('semantic diagnostics: parts outside their warp', () => {
  // faceWarp is [176, 120, 160, 180] -> x 176..336, y 120..300; "face" (parts[0]) touches it at the top and bottom.
  const face = (shape: Json, extra: Json = {}) => (m: Json) => Object.assign(m.parts[0], { shape }, extra);

  it('accepts parts inside or touching the warp rect, within 0.5 px', () => {
    expect(diagnosticsOf(face({ type: 'rect', x: 176, y: 120, w: 160, h: 180 }))).toEqual([]);
    expect(diagnosticsOf(face({ type: 'rect', x: 175.5, y: 120, w: 161, h: 180.5 }))).toEqual([]);
    expect(codes(diagnosticsOf(face({ type: 'rect', x: 175.4, y: 120, w: 160, h: 180 })))).toEqual(['part-outside-warp']);
  });

  it('reports the overhang per side, the stroke included, with a covering rect and a re-parent hint', () => {
    const d = only(
      diagnosticsOf(face({ type: 'rect', x: 170, y: 130, w: 100, h: 172 }, { stroke: { color: '#000', width: 4 } })),
      'part-outside-warp',
    );
    expect(d).toMatchObject({ severity: 'warning', path: '/parts/0/parent' });
    expect(d.message).toBe(
      'part "face" (setup bounds [168, 128, 104, 176] incl. stroke) extends outside its parent warp "faceWarp" rect [176, 120, 160, 180] by 8 px on the left, 4 px at the bottom; ' +
        `vertices there are extrapolated from "faceWarp"'s edge cells, so they drift or stretch more than the warp's border when it deforms`,
    );
    expect(d.hint).toBe(
      'enlarge "faceWarp" to cover it ("rect": [168, 120, 168, 184]; its lattice points move with the rect, so re-check its offset keyforms), ' +
        'or parent "face" to bone "head" (which "faceWarp" follows; give it its own warp there if it must bend)',
    );
  });

  it('grows the bounds by the stroke according to its align', () => {
    const rect = { type: 'rect', x: 180, y: 124, w: 100, h: 100 };
    const stroke = (align: string, width = 10) => face(rect, { stroke: { color: '#000', width, align } });
    expect(diagnosticsOf(stroke('inside'))).toEqual([]);
    expect(only(diagnosticsOf(stroke('center')), 'part-outside-warp').message).toContain('by 1 px on the left, 1 px at the top;');
    expect(only(diagnosticsOf(stroke('outside')), 'part-outside-warp').message).toContain('by 6 px on the left, 6 px at the top;');
    expect(diagnosticsOf(stroke('outside', 0))).toEqual([]);
  });

  it('measures rotated ellipses by their outline', () => {
    // rx 70 / ry 90 turned by 90°: 180 px wide, 140 px tall around (256, 210).
    const turned = { type: 'ellipse', cx: 256, cy: 210, rx: 70, ry: 90, rotation: 90, segments: 64 };
    const d = only(diagnosticsOf(face(turned)), 'part-outside-warp');
    expect(d.message).toContain('(setup bounds [166, 140, 180, 140])');
    expect(d.message).toContain('by 10 px on the left, 10 px on the right;');
    expect(d.hint).toContain('"rect": [166, 120, 180, 180]');
    expect(diagnosticsOf(face(turned, { parent: 'head' }))).toEqual([]);
  });

  it('measures polygons, flattened paths, used mesh vertices and images', () => {
    const poly = only(diagnosticsOf(face({ type: 'polygon', points: [200, 130, 340, 150, 250, 250] })), 'part-outside-warp');
    expect(poly.message).toContain('by 4 px on the right;');
    // Quadratic through (180, 250) - (256, 370) - (330, 250): its lowest point is y = 310 at t = 0.5.
    const path = only(diagnosticsOf(face({ type: 'path', d: 'M180 250 Q256 370 330 250 Z' })), 'part-outside-warp');
    const by = Number(/by ([\d.]+) px at the bottom;/.exec(path.message)?.[1]);
    expect(by).toBeGreaterThan(9.9);
    expect(by).toBeLessThanOrEqual(10);
    // Vertex 3 is not used by any triangle, so it is never drawn and never deformed.
    const mesh = { type: 'mesh', vertices: [200, 130, 300, 130, 250, 200, 900, 900], triangles: [0, 1, 2] };
    expect(diagnosticsOf(face(mesh))).toEqual([]);
    const image = (shape: Json, size = true) => (m: Json) => {
      if (size) Object.assign(m.textures[0], { width: 64, height: 32 });
      face({ type: 'image', texture: 'armTex', x: 300, y: 200, ...shape })(m);
    };
    expect(only(diagnosticsOf(image({})), 'part-outside-warp').message).toContain('(setup bounds [300, 200, 64, 32]) extends outside');
    expect(only(diagnosticsOf(image({ crop: [0, 0, 16, 120] })), 'part-outside-warp').message).toContain('by 20 px at the bottom;');
    expect(diagnosticsOf(image({ w: 30, h: 30 }))).toEqual([]);
    // Unknown texture size (known only once the PNG is decoded): not measured.
    expect(diagnosticsOf(image({}, false))).toEqual([]);
  });

  it('suggests the nearest ancestor warp that contains the part, or nothing in model space', () => {
    const inner = (m: Json) => {
      m.warps.push({ id: 'eyeWarp', parent: 'faceWarp', rect: [200, 150, 50, 40], cols: 1, rows: 1 });
      m.parts[1].parent = 'eyeWarp';
    };
    const d = only(diagnosticsOf(inner), 'part-outside-warp');
    expect(d.path).toBe('/parts/1/parent');
    expect(d.message).toContain(
      'part "mouth" (setup bounds [235, 249, 42, 7] incl. stroke) extends outside its parent warp "eyeWarp" rect [200, 150, 50, 40] by 27 px on the right, 66 px at the bottom;',
    );
    expect(d.hint).toBe(
      'enlarge "eyeWarp" to cover it ("rect": [200, 150, 77, 106]; its lattice points move with the rect, so re-check its offset keyforms), ' +
        'or parent "mouth" to warp "faceWarp" (an ancestor of "eyeWarp" whose rect [176, 120, 160, 180] contains it)',
    );
    const free = only(
      diagnosticsOf((m) => {
        delete m.warps[0].parent;
        face({ type: 'rect', x: 170, y: 130, w: 10, h: 10 })(m);
      }),
      'part-outside-warp',
    );
    expect(free.hint).toBe('enlarge "faceWarp" to cover it ("rect": [170, 120, 166, 180]; its lattice points move with the rect, so re-check its offset keyforms)');
  });

  it('does not measure parts that are skinned, broken, empty or not parented to a warp', () => {
    const outside = { type: 'rect', x: 0, y: 0, w: 10, h: 10 };
    expect(codes(diagnosticsOf(face(outside, { skin: { bones: ['head'] } })))).toEqual(['skin-with-parent']);
    expect(codes(diagnosticsOf(face({ type: 'polygon', points: [0, 0, 10, 0] })))).toEqual(['polygon-too-few-points']);
    expect(diagnosticsOf(face(outside, { parent: 'head' }))).toEqual([]);
    expect(diagnosticsOf(face({ type: 'ellipse', cx: 0, cy: 0, rx: 0, ry: 10 }))).toEqual([]);
  });
});

describe('semantic diagnostics: bindings without effect', () => {
  const bind =
    (target: string, values: Json[], params = ['MouthOpen']) =>
    (m: Json) =>
      m.bindings.push({ target, params, keys: values.map((value, k) => ({ at: [k], value })) });

  it('reports a binding whose keyforms all equal the setup value (numbers, within 1e-9)', () => {
    const d = only(diagnosticsOf(bind('bone:neck.rotation', [0, 1e-10])), 'binding-no-effect');
    expect(d).toMatchObject({ severity: 'info', path: '/bindings/4' });
    expect(d.message).toBe(
      'binding on "bone:neck.rotation" (driven by "MouthOpen") has no effect: all 2 keyforms equal its setup value 0, so the property never changes',
    );
    expect(d.hint).toContain('keyform values are absolute (only warp offsets are relative)');
    expect(d.hint).toContain('"relative": true');
    expect(only(diagnosticsOf(bind('bone:neck.y', [-100])), 'binding-no-effect').message).toContain('its only keyform equal its setup value -100');
    expect(codes(diagnosticsOf(bind('bone:neck.rotation', [0, 1e-6])))).toEqual([]);
  });

  it('compares colors, booleans, points and paths element-wise', () => {
    const color = only(diagnosticsOf(bind('part:face.fill', ['#ffe0c0', 'rgba(255, 224, 192, 1)'])), 'binding-no-effect');
    expect(color.message).toContain('equal its setup color "#ffe0c0"');
    expect(only(diagnosticsOf(bind('part:face.visible', [true, 1])), 'binding-no-effect').message).toContain('its setup value true');
    const points = only(diagnosticsOf(bind('part:hair.shape.points', [{ '2': [256, 40] }, [200, 100, 312, 100, 256, 40]])), 'binding-no-effect');
    expect(points.message).toContain('its setup points');
    const path = only(diagnosticsOf(bind('part:mouth.shape.d', ['M236 250 Q256 260 276 250 Z', 'M 236,250 Q 256,260 276,250 Z'])), 'binding-no-effect');
    expect(path.message).toContain('its setup path');
    expect(codes(diagnosticsOf(bind('part:face.fill', ['#ffe0c0', '#ffe0c1'])))).toEqual([]);
    expect(codes(diagnosticsOf(bind('part:hair.shape.points', [{}, { '0': [200, 100.5] }])))).toEqual([]);
  });

  it('reports all-zero warp offsets with a warp-specific hint', () => {
    const d = only(diagnosticsOf(bind('warp:faceWarp.offsets', [{}, new Array(18).fill(0)])), 'binding-no-effect');
    expect(d.message).toBe(
      'binding on "warp:faceWarp.offsets" (driven by "MouthOpen") has no effect: all 2 keyforms are all-zero offsets, so the lattice never moves',
    );
    expect(d.hint).toContain('warp offsets are relative to the rest lattice');
  });

  it('stays quiet when a keyform is invalid or the setup value is unknown', () => {
    expect(codes(diagnosticsOf(bind('bone:neck.rotation', [0, 'x'])))).toEqual(['invalid-value']);
    // An image without w/h, crop or a texture size in the model: its setup width is only known after decoding.
    const image = (m: Json) => {
      m.parts[2].shape = { type: 'image', texture: 'armTex', x: 0, y: 0 };
      delete m.parts[2].skin;
    };
    expect(codes(diagnosticsOf((m) => (image(m), bind('part:arm.shape.w', [0, 0])(m))))).toEqual([]);
    const known = only(
      diagnosticsOf((m) => {
        image(m);
        m.textures[0].width = 64;
        bind('part:arm.shape.w', [64, 64])(m);
      }),
      'binding-no-effect',
    );
    expect(known.message).toContain('its setup value 64');
  });
});
