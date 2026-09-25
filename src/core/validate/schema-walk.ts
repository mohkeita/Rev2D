/**
 * Zod schema introspection for diagnostics: follow an issue path through ModelSchema (objects,
 * arrays, tuples, records, wrappers and unions), list the keys an object accepts, and build example
 * values for missing fields.
 */
import { z } from 'zod';
import { AnimationEventSchema, ColorSchema, IkSchema, MetaSchema, StrokeSchema } from '../schema.js';
import { ownValue } from './diagnostics.js';

export type Schema = z.core.$ZodType;
type ObjectSchema = z.ZodObject;
type DiscriminatedUnion = z.ZodDiscriminatedUnion;

/** Strip optional / default / nullable wrappers. */
export function unwrap(schema: Schema): Schema {
  let s = schema;
  while (s instanceof z.ZodOptional || s instanceof z.ZodDefault || s instanceof z.ZodNullable) s = s.unwrap();
  return s;
}

/** True when the field may be omitted (optional or has a default). */
export function isOmittable(schema: Schema): boolean {
  let s = schema;
  while (s instanceof z.ZodNullable) s = s.unwrap();
  return s instanceof z.ZodOptional || s instanceof z.ZodDefault;
}

export function isObject(schema: Schema): schema is ObjectSchema {
  return schema instanceof z.ZodObject;
}

export function isUnion(schema: Schema): schema is z.ZodUnion {
  return schema instanceof z.ZodUnion;
}

export function isDiscriminatedUnion(schema: Schema): schema is DiscriminatedUnion {
  return schema instanceof z.ZodDiscriminatedUnion;
}

export function isTuple(schema: Schema): schema is z.ZodTuple {
  return schema instanceof z.ZodTuple;
}

export function description(schema: Schema): string | undefined {
  return z.globalRegistry.get(schema)?.description;
}

/** Literal values of a (possibly wrapped) literal schema; empty for anything else. */
function literalValues(schema: Schema): unknown[] {
  const s = unwrap(schema);
  return s instanceof z.ZodLiteral ? [...s.values] : [];
}

/** Discriminator values of each option, in option order. */
export function discriminatorOptions(du: DiscriminatedUnion): string[] {
  const disc = du.def.discriminator;
  return du.options.flatMap((o) => (isObject(o) ? literalValues(o.shape[disc]).map(String) : []));
}

export function objectKeys(schema: ObjectSchema): string[] {
  return Object.keys(schema.shape);
}

/** Keys of an object schema that must be present (neither optional nor defaulted). */
export function requiredKeys(schema: ObjectSchema): string[] {
  return Object.entries(schema.shape)
    .filter(([, s]) => !isOmittable(s))
    .map(([k]) => k);
}

export interface SchemaLocation {
  /** Unwrapped schema at the path (a union option when the input selects one). */
  schema: Schema;
  /** Schema as declared by the parent (keeps optional/default wrappers and descriptions). */
  declared: Schema;
  /** Unwrapped schema of the parent container, if any. */
  parent?: Schema;
  /** The discriminated union `schema` was selected from, when applicable. */
  union?: DiscriminatedUnion;
}

/** Resolve a discriminated union to the option matching the input's discriminator, if any. */
function select(schema: Schema, value: unknown): { schema: Schema; union?: DiscriminatedUnion } {
  if (!isDiscriminatedUnion(schema)) return { schema };
  const disc = schema.def.discriminator;
  const tag = ownValue(value, disc);
  const option = schema.options.find((o) => isObject(o) && literalValues(o.shape[disc]).includes(tag));
  return option ? { schema: option, union: schema } : { schema };
}

function childOf(schema: Schema, seg: PropertyKey): Schema | undefined {
  if (schema instanceof z.ZodObject) {
    return typeof seg === 'string' && Object.hasOwn(schema.shape, seg) ? schema.shape[seg] : undefined;
  }
  if (schema instanceof z.ZodArray) return schema.element;
  if (schema instanceof z.ZodTuple) return schema.def.items[Number(seg)] ?? schema.def.rest ?? undefined;
  if (schema instanceof z.ZodRecord) return schema.valueType;
  if (schema instanceof z.ZodUnion) {
    // Plain unions (or a discriminated union without a matching option): first option that has the child.
    for (const option of schema.options) {
      const child = childOf(unwrap(option), seg);
      if (child) return child;
    }
  }
  return undefined;
}

/** Follow `path` from `root`, using `input` (the value at `root`) to pick union options. */
export function locate(root: Schema, input: unknown, path: readonly PropertyKey[]): SchemaLocation | undefined {
  let declared = root;
  let parent: Schema | undefined;
  let value = input;
  for (const seg of path) {
    const container = select(unwrap(declared), value).schema;
    const child = childOf(container, seg);
    if (!child) return undefined;
    parent = container;
    declared = child;
    value = ownValue(value, seg);
  }
  const { schema, union } = select(unwrap(declared), value);
  return { schema, declared, parent, union };
}

// ----------------------------------------------------------------------------- examples

/** Examples for fields whose meaning depends on the owning object (e.g. meta.width vs stroke.width). */
const FIELD_EXAMPLES = new Map<Schema, Record<string, unknown>>([
  [MetaSchema, { name: 'my-model', width: 512, height: 512 }],
  [StrokeSchema, { width: 2 }],
  [AnimationEventSchema, { name: 'footstep' }],
  [IkSchema, { target: '<boneId>' }],
]);

/** Example leaf values by field name. */
const NUMBER_EXAMPLES: Record<string, number> = {
  max: 1,
  duration: 1,
  rx: 20,
  ry: 20,
  w: 100,
  h: 100,
  radius: 10,
  length: 30,
};

const STRING_EXAMPLES: Record<string, string> = {
  id: '<id>',
  target: 'bone:<boneId>.rotation',
  d: 'M0 0 L100 0 L100 100 Z',
  path: 'image.png',
  color: '#000000',
  fill: '#ffffff',
  tint: '#ffffff',
  background: 'transparent',
  texture: '<textureId>',
  param: '<parameterId>',
  parent: '<boneId>',
};

const ARRAY_EXAMPLES: Record<string, unknown[]> = {
  points: [0, 0, 100, 0, 50, 80],
  vertices: [0, 0, 100, 0, 0, 100],
  triangles: [0, 1, 2],
  params: ['<parameterId>'],
  bones: ['<boneId>'],
  mask: ['<partId>'],
  at: [0],
  stops: [
    [0, '#ffffff'],
    [1, '#000000'],
  ],
  rect: [0, 0, 100, 100],
  crop: [0, 0, 64, 64],
};

const MAX_EXAMPLE_DEPTH = 3;

/**
 * A plausible value for field `key` (schema `schema`) of the object schema `owner`, or undefined
 * when no sensible example exists. Object examples include only their required keys.
 */
export function exampleValue(schema: Schema, key?: string, owner?: Schema, depth = 0): unknown {
  if (key !== undefined && owner !== undefined) {
    const curated = FIELD_EXAMPLES.get(owner);
    if (curated && Object.hasOwn(curated, key)) return curated[key];
  }
  const s = unwrap(schema);
  if (key !== undefined && Object.hasOwn(ARRAY_EXAMPLES, key) && (s instanceof z.ZodArray || s instanceof z.ZodTuple)) {
    return ARRAY_EXAMPLES[key];
  }
  if (s instanceof z.ZodLiteral) return [...s.values][0];
  if (s instanceof z.ZodEnum) return s.options[0];
  if (s instanceof z.ZodNumber) {
    if (key !== undefined && Object.hasOwn(NUMBER_EXAMPLES, key)) return NUMBER_EXAMPLES[key];
    // Unbounded numbers report -Infinity / -MAX_SAFE_INTEGER. For ">= 0" and "> 0" use 1 (valid for both).
    const min = s.minValue;
    return min !== null && min >= 0 ? Math.max(min, 1) : 0;
  }
  if (s instanceof z.ZodString) {
    if (key !== undefined && Object.hasOwn(STRING_EXAMPLES, key)) return STRING_EXAMPLES[key];
    return s === ColorSchema ? '#ffffff' : '...';
  }
  if (s instanceof z.ZodBoolean) return true;
  if (s instanceof z.ZodTuple) return s.def.items.map((item) => exampleValue(item, undefined, undefined, depth + 1) ?? 0);
  if (depth >= MAX_EXAMPLE_DEPTH) return undefined;
  if (s instanceof z.ZodArray) {
    const element = exampleValue(s.element, undefined, undefined, depth + 1);
    return element === undefined ? [] : [element];
  }
  if (s instanceof z.ZodObject) {
    const out: Record<string, unknown> = {};
    for (const k of requiredKeys(s)) {
      const v = exampleValue(s.shape[k], k, s, depth + 1);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (s instanceof z.ZodUnion) return exampleValue(s.options[0], key, undefined, depth);
  if (s instanceof z.ZodRecord) return {};
  return undefined;
}
