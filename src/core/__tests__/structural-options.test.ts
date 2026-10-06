/**
 * structuralDiagnostics on a schema other than the model's (StructuralOptions), refinement issues
 * and curated field examples: the generalisations the avatar spec validation builds on.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateModel } from '../validate.js';
import { registerFieldExamples } from '../validate/schema-walk.js';
import { structuralDiagnostics } from '../validate/structural.js';

const Item = z.strictObject({ id: z.string(), amount: z.number() });
const Doc = z
  .strictObject({
    format: z.literal('thing'),
    version: z.literal(2),
    size: z
      .number()
      .refine((v) => v > 0, 'must be > 0')
      .describe('Size in px.'),
    pair: z.tuple([z.number().refine((v) => v >= 0, 'must not be negative'), z.number()]).describe('[a, b] of the thing.').optional(),
    items: z.array(Item).default([]),
  })
  .describe('A thing.');

const OPTIONS = { schema: Doc, noun: 'a thing', formatHint: '"format": "thing", "version": 2', skeleton: 'a thing looks like { "format": "thing", ... }' };

function diagnose(input: unknown, options = OPTIONS) {
  const r = Doc.safeParse(input);
  return r.success ? [] : structuralDiagnostics(r.error.issues, input, options);
}

describe('structuralDiagnostics with another root schema', () => {
  it('names the document and shows its skeleton when the root is not an object', () => {
    expect(diagnose('x')).toEqual([{ severity: 'error', code: 'schema-invalid-type', path: '', message: 'a thing must be a JSON object, got string "x"', hint: 'a thing looks like { "format": "thing", ... }' }]);
  });

  it('uses the given format hint for the root format and version fields', () => {
    const d = diagnose({ version: 1, size: 3 });
    expect(d.find((x) => x.path === '/format')).toMatchObject({ message: 'missing required field "format"', hint: '"format": "thing", "version": 2' });
    expect(d.find((x) => x.path === '/version')).toMatchObject({ message: '"version" must be 2, got number 1', hint: '"format": "thing", "version": 2' });
  });

  it('follows issue paths through the given schema (did-you-mean for its keys)', () => {
    const d = diagnose({ format: 'thing', version: 2, size: 1, sise: 2, items: [{ id: 'a', amout: 1 }] });
    expect(d.find((x) => x.path === '/sise')).toMatchObject({ code: 'schema-unrecognized-keys', hint: 'did you mean "size"?' });
    expect(d.find((x) => x.path === '/items/0/amout')).toMatchObject({ hint: 'did you mean "amount"?' });
    expect(d.find((x) => x.path === '/items/0/amount')).toMatchObject({ message: 'missing required field "amount"', hint: 'rename "amout" to "amount"' });
  });

  it('reports a refinement with the value found and the description of the field', () => {
    const d = diagnose({ format: 'thing', version: 2, size: -4, pair: [-1, 2] });
    expect(d).toEqual([
      { severity: 'error', code: 'schema-custom', path: '/size', message: 'must be > 0, got number -4', hint: 'Size in px.' },
      { severity: 'error', code: 'schema-custom', path: '/pair/0', message: 'must not be negative, got number -1', hint: '[a, b] of the thing.' },
    ]);
  });

  it('shows registered examples for the fields of an object schema', () => {
    const before = diagnose({ format: 'thing', version: 2, size: 1, items: [{ id: 'a' }] });
    expect(before[0]).toMatchObject({ path: '/items/0/amount', hint: 'e.g. "amount": 0' });
    registerFieldExamples(Item, { amount: 42 });
    const after = diagnose({ format: 'thing', version: 2, size: 1, items: [{ id: 'a' }] });
    expect(after[0]).toMatchObject({ path: '/items/0/amount', hint: 'e.g. "amount": 42' });
  });

  it('keeps the model wording by default', () => {
    const d = validateModel(7).diagnostics;
    expect(d[0].message).toBe('a model must be a JSON object, got number 7');
    expect(d[0].hint).toContain('"format": "rev2d"');
    expect(validateModel({ version: 1, meta: { name: 'm', width: 1, height: 1 } }).diagnostics.find((x) => x.path === '/format')!.hint).toBe('"format": "rev2d", "version": 1');
  });
});
