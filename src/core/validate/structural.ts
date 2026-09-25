/**
 * Structural pass: turn ModelSchema (zod) issues into precise diagnostics.
 *
 * Codes are `schema-<zod issue code>` (kebab-case). Diagnostics that summarize a whole union
 * (bad discriminator, no branch matching the value's type) use `schema-invalid-union`; otherwise a
 * union is collapsed to the issues of its most relevant branch so authors see one actionable error
 * instead of one per alternative.
 */
import type { z } from 'zod';
import type { Diagnostic } from '../types.js';
import { ID_PATTERN, ModelSchema, SparsePointsSchema } from '../schema.js';
import { DiagnosticSink, isPlainObject, ownValue, toPointer, valueAt } from './diagnostics.js';
import {
  description,
  discriminatorOptions,
  exampleValue,
  isDiscriminatedUnion,
  isObject,
  isOmittable,
  isTuple,
  isUnion,
  locate,
  objectKeys,
  requiredKeys,
  unwrap,
  type Schema,
  type SchemaLocation,
} from './schema-walk.js';
import { compactJson, describeJson, didYouMean, formatList, formatQuotedList, keyAlias, optionsHint, q, suggestKey } from './text.js';

type Issue = z.core.$ZodIssue;

const FORMAT_HINT = '"format": "rev2d", "version": 1';
const MODEL_SKELETON =
  'a model looks like { "format": "rev2d", "version": 1, "meta": { "name": "my-model", "width": 512, "height": 512 }, ... }';
const ID_RULE = 'ids use letters, digits, _ and - and must not start with a digit';

/** The value an issue list is relative to (the whole model, or one union branch's input). */
interface Frame {
  path: readonly PropertyKey[];
  /** Schema describing `input`; undefined when it could not be determined. */
  schema: Schema | undefined;
  input: unknown;
}

/** Where one issue points, resolved once for all handlers. */
interface Site {
  frame: Frame;
  /** Issue path relative to the frame. */
  rel: readonly PropertyKey[];
  /** Absolute path in the model (becomes the diagnostic's JSON pointer). */
  abs: PropertyKey[];
  /** Last path segment ('' at the root). */
  key: string;
  /** True when the last path segment is an array index (examples then omit the key). */
  item: boolean;
  /** Input value at the path (undefined when missing). */
  value: unknown;
  loc: SchemaLocation | undefined;
  /** `schema-<zod issue code>`. */
  code: string;
}

/** One alternative of a discriminator: its tag value and (when known) its object schema. */
interface Variant {
  tag: string;
  schema: Schema | undefined;
}

export function structuralDiagnostics(issues: readonly Issue[], input: unknown): Diagnostic[] {
  const sink = new DiagnosticSink();
  new IssueConverter(sink).convert(issues, { path: [], schema: ModelSchema, input });
  const seen = new Set<string>();
  return sink.items.filter((d) => {
    const key = `${d.path}\u0000${d.code}\u0000${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

class IssueConverter {
  constructor(private readonly sink: DiagnosticSink) {}

  convert(issues: readonly Issue[], frame: Frame): void {
    for (const issue of withoutLengthArtifacts(issues)) this.convertOne(issue, frame);
  }

  private convertOne(issue: Issue, frame: Frame): void {
    const rel = issue.path;
    const abs = [...frame.path, ...rel];
    const site: Site = {
      frame,
      rel,
      abs,
      key: abs.length ? String(abs[abs.length - 1]) : '',
      item: typeof abs[abs.length - 1] === 'number',
      value: valueAt(frame.input, rel),
      loc: frame.schema ? locate(frame.schema, frame.input, rel) : undefined,
      code: `schema-${issue.code.replace(/_/g, '-')}`,
    };
    switch (issue.code) {
      case 'invalid_type':
        return site.value === undefined && abs.length > 0 ? this.missingField(site) : this.invalidType(site, issue.expected);
      case 'unrecognized_keys':
        for (const k of issue.keys) this.sink.error(site.code, [...abs, k], `unknown key ${q(k)}`, unknownKeyHint(k, site.loc));
        return;
      case 'invalid_union':
        return this.invalidUnion(site, issue);
      case 'invalid_value':
        return this.invalidValue(site, issue.values);
      case 'too_small':
      case 'too_big':
        return this.outOfRange(site, issue);
      case 'invalid_format':
        return this.invalidFormat(site, issue);
      case 'invalid_key': {
        const sparse = site.loc?.parent === SparsePointsSchema;
        this.sink.error(
          site.code,
          abs,
          sparse ? `invalid point index ${q(site.key)}` : `invalid key ${q(site.key)}`,
          sparse
            ? 'sparse point maps use point indices as keys, e.g. {"3": [10, 20]}'
            : issue.issues.map((i) => i.message).join('; '),
        );
        return;
      }
      default:
        this.sink.error(site.code, abs, issue.message);
    }
  }

  // --------------------------------------------------------------------------- types & presence

  private missingField({ code, abs, key, frame, rel, loc }: Site): void {
    const hint = isFormatField(abs) ? FORMAT_HINT : missingFieldHint(key, valueAt(frame.input, rel.slice(0, -1)), loc);
    this.sink.error(code, abs, `missing required field ${q(key)}`, hint);
  }

  private invalidType(site: Site, expected: string): void {
    const { code, abs, value, loc } = site;
    if (abs.length === 0) {
      this.sink.error(code, abs, `a model must be a JSON object, got ${describeJson(value)}`, MODEL_SKELETON);
      return;
    }
    const nonFinite = typeof value === 'number' && !Number.isFinite(value);
    const message = `expected ${nonFinite ? 'a finite number' : expectedName(expected, loc)}, got ${describeJson(value)}`;
    this.sink.error(code, abs, message, typeHint(site, expected));
  }

  private invalidValue(site: Site, values: readonly unknown[]): void {
    const { code, abs, key, value } = site;
    const expected = values.map((v) => JSON.stringify(v));
    if (isFormatField(abs)) {
      const message =
        value === undefined ? `missing required field ${q(key)}` : `${q(key)} must be ${expected[0]}, got ${describeJson(value)}`;
      this.sink.error(code, abs, message, FORMAT_HINT);
      return;
    }
    if (value === undefined) return this.missingField(site);
    if (values.length === 1) {
      const hint = typeof value === 'string' && typeof values[0] === 'string' ? didYouMean(value, [values[0]]) : null;
      this.sink.error(code, abs, `expected ${expected[0]}, got ${describeJson(value)}`, hint ?? undefined);
      return;
    }
    const options = values.map(String);
    const hint = typeof value === 'string' ? optionsHint(value, options) : `valid: ${formatList(options)}`;
    this.sink.error(code, abs, `invalid value ${JSON.stringify(value)} for ${q(key)}`, hint);
  }

  private outOfRange(site: Site, issue: z.core.$ZodIssueTooSmall | z.core.$ZodIssueTooBig): void {
    const { code, abs, key, value, loc } = site;
    const small = issue.code === 'too_small';
    const bound = Number(small ? issue.minimum : issue.maximum);
    let message: string;
    let hint = describedHint(loc);
    switch (issue.origin) {
      case 'array': {
        const len = Array.isArray(value) ? value.length : 0;
        if (loc && isTuple(loc.schema)) {
          message = `expected ${loc.schema.def.items.length} items, got ${len}`;
        } else if (small) {
          message = `needs at least ${plural(bound, 'item')}, got ${len}`;
          const example = loc ? exampleValue(loc.declared, key, loc.parent) : undefined;
          if (example !== undefined && hint === undefined) hint = exampleHint(site, example);
        } else {
          message = `allows at most ${plural(bound, 'item')}, got ${len}`;
        }
        break;
      }
      case 'string':
        message = small && bound === 1 ? 'must not be empty' : `${small ? 'needs at least' : 'allows at most'} ${plural(bound, 'character')}`;
        break;
      case 'number':
      case 'int': {
        const op = small ? (issue.inclusive ? '>=' : '>') : issue.inclusive ? '<=' : '<';
        message = `must be ${op} ${bound}, got ${describeJson(value)}`;
        break;
      }
      default:
        message = issue.message;
    }
    this.sink.error(code, abs, message, hint);
  }

  private invalidFormat({ code, abs, value }: Site, issue: z.core.$ZodIssueInvalidStringFormat): void {
    if (issue.format === 'regex' && issue.pattern === String(ID_PATTERN) && typeof value === 'string') {
      this.sink.error(code, abs, `invalid id ${q(value)}`, idHint(value));
      return;
    }
    this.sink.error(code, abs, issue.message);
  }

  // --------------------------------------------------------------------------- unions

  private invalidUnion(site: Site, issue: z.core.$ZodIssueInvalidUnion): void {
    const { frame, abs, value, loc } = site;
    const code = 'schema-invalid-union';
    const disc = issue.discriminator;
    if (disc !== undefined) {
      // Discriminated union: zod reports the discriminator's own path.
      const objRel = issue.path[issue.path.length - 1] === disc ? issue.path.slice(0, -1) : issue.path;
      const obj = valueAt(frame.input, objRel);
      const du = frame.schema ? locate(frame.schema, frame.input, objRel)?.schema : undefined;
      let variants: Variant[];
      if (du && isDiscriminatedUnion(du)) {
        const tags = discriminatorOptions(du);
        variants = du.options.map((o, i) => ({ tag: tags[i], schema: o }));
      } else {
        const tags = 'options' in issue && issue.options ? issue.options : [];
        variants = tags.map((tag) => ({ tag: String(tag), schema: undefined }));
      }
      this.discriminator(code, [...frame.path, ...objRel], disc, obj, variants);
      return;
    }
    if (value === undefined && abs.length > 0) return this.missingField(site);
    if (issue.inclusive === false || issue.errors.length === 0) {
      this.sink.error(code, abs, issue.message, describedHint(loc));
      return;
    }

    const unionSchema = loc?.schema;
    const branchSchemas = unionSchema && isUnion(unionSchema) ? unionSchema.options : [];
    const branches = issue.errors.map((issues, i) => ({
      issues: withoutLengthArtifacts(issues),
      schema: branchSchemas[i] as Schema | undefined,
    }));
    const viable = branches.filter((b) => !isTypeMismatch(b.issues, value));

    if (viable.length === 0) {
      const expected = [...new Set(branches.map((b) => typeName(b.issues[0])))];
      const hint = loc ? (description(loc.schema) ?? description(loc.declared)) : undefined;
      this.sink.error(code, abs, `expected ${joinOr(expected)}, got ${describeJson(value)}`, hint);
      return;
    }

    // Object alternatives told apart by a literal field (e.g. fill "type": solid | linear | radial).
    const tagKey = sharedLiteralMismatch(viable);
    if (tagKey !== undefined) {
      const variants = viable.map((b) => ({ tag: String(literalExpected(b.issues, tagKey)), schema: b.schema }));
      this.discriminator(code, abs, tagKey, value, variants);
      return;
    }

    const best = viable.reduce((a, b) => (branchScore(b.issues) < branchScore(a.issues) ? b : a));
    this.convert(best.issues, { path: abs, schema: best.schema, input: value });
  }

  private discriminator(code: string, objPath: PropertyKey[], disc: string, obj: unknown, variants: Variant[]): void {
    const tags = variants.map((v) => v.tag);
    const valid = `valid ${disc}s: ${formatList(tags)}`;
    const tag = ownValue(obj, disc);
    const path = [...objPath, disc];
    const guess = guessVariant(obj, disc, variants);
    if (tag === undefined) {
      const hint = guess ? `add ${q(disc)}: ${q(guess)} (${valid})` : `add ${q(disc)}: one of ${formatQuotedList(tags)}`;
      this.sink.error(code, path, `missing required field ${q(disc)}`, hint);
    } else if (typeof tag !== 'string') {
      this.sink.error(code, path, `${q(disc)} must be a string, got ${describeJson(tag)}`, valid);
    } else {
      const dym = didYouMean(tag, tags) ?? (guess ? `the fields look like ${q(guess)}` : null);
      this.sink.error(code, path, `unknown ${disc} ${q(tag)}`, dym ? `${dym} (${valid})` : valid);
    }
  }
}

// ----------------------------------------------------------------------------- helpers

function isFormatField(abs: readonly PropertyKey[]): boolean {
  return abs.length === 1 && (abs[0] === 'format' || abs[0] === 'version');
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function joinOr(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** Description of the field (or of the tuple it is an item of) as a fallback hint. */
function describedHint(loc: SchemaLocation | undefined): string | undefined {
  if (!loc) return undefined;
  return (
    description(loc.declared) ??
    description(loc.schema) ??
    (loc.parent && isTuple(loc.parent) ? description(loc.parent) : undefined)
  );
}

const TYPE_NOUNS: Record<string, string> = {
  int: 'an integer',
  number: 'a number',
  string: 'a string',
  boolean: 'true or false',
  array: 'an array',
  tuple: 'an array',
  object: 'an object',
  record: 'an object',
  null: 'null',
};

function expectedName(expected: string, loc: SchemaLocation | undefined): string {
  if (expected === 'tuple' && loc && isTuple(loc.schema)) return `an array of ${loc.schema.def.items.length} items`;
  return TYPE_NOUNS[expected] ?? expected;
}

const TYPE_NAMES: Record<string, string> = { int: 'integer', tuple: 'array', record: 'object' };

/** JSON type of a value: "array", "null", "string", "number", "boolean" or "object". */
function jsonType(v: unknown): string {
  return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
}

/** Bare JSON type name expected by a branch's root mismatch, for "expected x, y or z". */
function typeName(issue: Issue | undefined): string {
  if (issue?.code === 'invalid_type') return TYPE_NAMES[issue.expected] ?? issue.expected;
  if (issue?.code === 'invalid_value') {
    const types = new Set(issue.values.map(jsonType));
    if (types.size === 1) return [...types][0];
  }
  return 'another value';
}

/** `e.g. "key": <example>`, or `e.g. <example>` for an array item. */
function exampleHint({ key, item }: Pick<Site, 'key' | 'item'>, example: unknown): string {
  return item ? `e.g. ${compactJson(example)}` : `e.g. ${q(key)}: ${compactJson(example)}`;
}

function typeHint(site: Site, expected: string): string | undefined {
  const { key, value, loc } = site;
  if (value === null && loc && isOmittable(loc.declared)) return `omit ${q(key)} instead of setting it to null`;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((expected === 'number' || expected === 'int') && trimmed !== '' && Number.isFinite(Number(trimmed))) {
      return `write ${trimmed} without quotes`;
    }
    if (expected === 'boolean' && (trimmed === 'true' || trimmed === 'false')) return `write ${trimmed} without quotes`;
  }
  if (expected === 'int' && typeof value === 'number' && Number.isFinite(value)) return `use a whole number, e.g. ${Math.round(value)}`;
  if (loc && (expected === 'object' || expected === 'array' || expected === 'tuple')) {
    const example = exampleValue(loc.declared, site.item ? undefined : key, loc.parent);
    if (example !== undefined) return exampleHint(site, example);
  }
  return describedHint(loc);
}

function missingFieldHint(key: string, container: unknown, loc: SchemaLocation | undefined): string | undefined {
  const owner = loc?.parent;
  if (isPlainObject(container) && owner && isObject(owner)) {
    const allowed = new Set(objectKeys(owner));
    const strays = Object.keys(container).filter((k) => !allowed.has(k));
    const renamed = strays.find((k) => suggestKey(k, [key]) !== null);
    if (renamed !== undefined) return `rename ${q(renamed)} to ${q(key)}`;
    const nested = loc && strays.filter((k) => childKeys(loc.schema).has(k));
    if (nested && nested.length) return `move ${formatQuotedList(nested)} into ${q(key)}`;
  }
  if (!loc) return undefined;
  const example = exampleValue(loc.declared, key, owner);
  return example === undefined ? describedHint(loc) : `e.g. ${q(key)}: ${compactJson(example)}`;
}

/** Keys accepted by an object schema, or by any object option of a union. */
function childKeys(schema: Schema): Set<string> {
  const s = unwrap(schema);
  if (isObject(s)) return new Set(objectKeys(s));
  if (isUnion(s)) return new Set(s.options.flatMap((o) => [...childKeys(o)]));
  return new Set();
}

function unknownKeyHint(key: string, loc: SchemaLocation | undefined): string | undefined {
  if (!loc || !isObject(loc.schema)) return undefined;
  const shape = loc.schema.shape;
  const allowed = objectKeys(loc.schema);
  const alias = keyAlias(key, allowed);
  if (alias !== null) return `did you mean ${q(alias)}?`;
  for (const k of allowed) {
    const child = unwrap(shape[k]);
    if ((isObject(child) || isUnion(child)) && childKeys(child).has(key)) return `${q(key)} belongs inside ${q(k)}`;
  }
  if (loc.union) {
    const du = loc.union;
    const disc = du.def.discriminator;
    const tags = discriminatorOptions(du);
    const owners = du.options.flatMap((o, i) => (isObject(o) && o !== loc.schema && Object.hasOwn(o.shape, key) ? [tags[i]] : []));
    if (owners.length) {
      const current = tags[du.options.indexOf(loc.schema)];
      return `${q(key)} is a field of ${disc} ${formatQuotedList(owners)}, not ${q(current)}; allowed here: ${formatList(allowed)}`;
    }
  }
  const match = suggestKey(key, allowed);
  return match !== null ? `did you mean ${q(match)}?` : `allowed keys: ${formatList(allowed, 20)}`;
}

function idHint(value: string): string {
  const prefixed = /^(?:param|bone|warp|part|ik|texture):([^.]+)/.exec(value);
  if (prefixed) return `use the bare id ${q(prefixed[1])} (no "kind:" prefix)`;
  let fixed = value.replace(/[^A-Za-z0-9_-]+/g, '_');
  if (!/^[A-Za-z_]/.test(fixed)) fixed = '_' + fixed;
  return `${ID_RULE}, e.g. ${q(fixed)}`;
}

/**
 * zod still runs length checks after a type mismatch when the value has a `length` (e.g. `.max(2)`
 * on the string "upperArm" gives "too big: <= 2 characters"). Drop those; the type error says it all.
 */
function withoutLengthArtifacts(issues: readonly Issue[]): readonly Issue[] {
  const mistyped = new Set(issues.filter((i) => i.code === 'invalid_type').map((i) => toPointer(i.path)));
  if (mistyped.size === 0) return issues;
  return issues.filter((i) => !((i.code === 'too_small' || i.code === 'too_big') && mistyped.has(toPointer(i.path))));
}

/**
 * A union branch that rejects the value's JSON type outright: a root type error, or a root literal /
 * enum mismatch whose allowed values all have another JSON type (e.g. an ease name vs an array).
 */
function isTypeMismatch(issues: readonly Issue[], value: unknown): boolean {
  const type = jsonType(value);
  return (
    issues.length > 0 &&
    issues.every(
      (i) =>
        i.path.length === 0 &&
        (i.code === 'invalid_type' || (i.code === 'invalid_value' && i.values.every((v) => jsonType(v) !== type))),
    )
  );
}

function literalMismatchKey(issue: Issue): string | undefined {
  return issue.code === 'invalid_value' && issue.path.length === 1 && typeof issue.path[0] === 'string' ? issue.path[0] : undefined;
}

function literalExpected(issues: readonly Issue[], key: string): unknown {
  const issue = issues.find((i) => literalMismatchKey(i) === key);
  return issue?.code === 'invalid_value' ? issue.values[0] : undefined;
}

/** A top-level key on which every branch reports a literal mismatch, if there are >= 2 branches. */
function sharedLiteralMismatch(branches: ReadonlyArray<{ issues: readonly Issue[] }>): string | undefined {
  if (branches.length < 2) return undefined;
  const first = branches[0].issues.map(literalMismatchKey).filter((k) => k !== undefined);
  return first.find((k) => branches.every((b) => b.issues.some((i) => literalMismatchKey(i) === k)));
}

/** Lower is more relevant: branches whose literal tag mismatched are unlikely to be the intended one. */
function branchScore(issues: readonly Issue[]): number {
  return (issues.some((i) => literalMismatchKey(i) !== undefined) ? 1000 : 0) + issues.length;
}

/** The variant whose keys best explain the object's keys (all keys allowed, most required present). */
function guessVariant(obj: unknown, disc: string, variants: readonly Variant[]): string | undefined {
  if (!isPlainObject(obj)) return undefined;
  const keys = Object.keys(obj).filter((k) => k !== disc);
  if (keys.length === 0) return undefined;
  let best: string | undefined;
  let bestScore = 0;
  for (const v of variants) {
    if (!v.schema || !isObject(v.schema)) continue;
    const shape = v.schema.shape;
    if (!keys.every((k) => Object.hasOwn(shape, k))) continue;
    const required = requiredKeys(v.schema).filter((k) => k !== disc);
    const present = required.filter((k) => Object.hasOwn(obj, k)).length;
    const score = present - (required.length - present);
    if (score > bestScore) {
      bestScore = score;
      best = v.tag;
    }
  }
  return best;
}
