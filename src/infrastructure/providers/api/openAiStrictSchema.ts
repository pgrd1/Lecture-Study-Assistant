import type { JsonValue } from '../../../shared/contracts/provider';
import { cloneOpenAiOwnedJson } from './openAiApiOwnedJson';

type Schema = Readonly<Record<string, JsonValue>>;
const object = (value: JsonValue | undefined): value is Schema =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
const reference = (schema: Schema, root: Schema): Schema | undefined => {
  if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return undefined;
  let value: JsonValue | undefined = root;
  for (const key of schema.$ref.slice(2).split('/')) {
    value = object(value) ? value[key.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined;
  }
  return object(value) ? value : undefined;
};
const nullable = (schema: Schema, root: Schema, depth = 0): boolean => {
  if (depth > 64) throw new TypeError('INVALID_OPENAI_SCHEMA');
  const ref = reference(schema, root);
  if (ref) return nullable(ref, root, depth + 1);
  if (Object.hasOwn(schema, 'const')) return schema.const === null;
  if (Array.isArray(schema.enum)) return schema.enum.includes(null);
  if (schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')))
    return true;
  for (const key of ['anyOf', 'oneOf']) {
    const branches = schema[key];
    if (Array.isArray(branches))
      return branches.some((v) => object(v) && nullable(v, root, depth + 1));
  }
  return schema.type === undefined && schema.$ref === undefined;
};

// Closed application subset of OpenAI strict Structured Outputs (base, non-fine-tuned models).
// In particular, never forward JSON Schema composition keywords that the API does not support.
const keywords = new Set([
  '$schema',
  '$defs',
  'definitions',
  '$ref',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'oneOf',
  'enum',
  'const',
  'title',
  'description',
  'readOnly',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
]);
const invalidSchema = (): never => {
  throw new TypeError('INVALID_OPENAI_SCHEMA');
};

/** A required, distinct literal shared by every object branch proves oneOf == anyOf. */
const disjointAlternatives = (value: JsonValue): readonly Schema[] => {
  if (!Array.isArray(value) || value.length < 2 || !value.every(object)) return invalidSchema();
  const first = value[0];
  if (!first || !object(first.properties)) return invalidSchema();
  const disjoint = Object.keys(first.properties).some((key) => {
    const literals = new Set<JsonValue>();
    for (const branch of value) {
      if (
        branch.type !== 'object' ||
        !object(branch.properties) ||
        !Array.isArray(branch.required) ||
        !branch.required.includes(key)
      )
        return false;
      const discriminator = branch.properties[key];
      if (!object(discriminator) || !Object.hasOwn(discriminator, 'const')) return false;
      const literal = discriminator.const;
      if (
        literal === undefined ||
        (literal !== null && typeof literal === 'object') ||
        literals.has(literal)
      )
        return false;
      literals.add(literal);
    }
    return true;
  });
  return disjoint ? value : invalidSchema();
};

/** Convert an owned, bounded schema only at the OpenAI strict wire boundary. */
export const openAiStrictWireSchema = (input: Schema): Schema => {
  const root = cloneOpenAiOwnedJson(input, 64, 100_000) as Schema;
  if (
    root.type !== 'object' ||
    root.anyOf !== undefined ||
    root.oneOf !== undefined ||
    root.$ref !== undefined
  )
    return invalidSchema();
  const convert = (schema: Schema): Schema => {
    if (Object.keys(schema).some((key) => !keywords.has(key))) return invalidSchema();
    if (schema.$ref !== undefined && !reference(schema, root)) return invalidSchema();
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
      return invalidSchema();
    const entries = Object.entries(schema).map(([key, value]): [string, JsonValue] => {
      if (key === 'oneOf') {
        if (schema.anyOf !== undefined) return invalidSchema();
        return ['anyOf', disjointAlternatives(value).map(convert)];
      }
      // Object properties are converted below exactly once (avoid exponential traversal).
      if (['$defs', 'definitions'].includes(key) && object(value))
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              object(child) ? convert(child) : invalidSchema(),
            ]),
          ),
        ];
      if (key === 'items') return [key, object(value) ? convert(value) : invalidSchema()];
      if (key === 'anyOf')
        return [
          key,
          Array.isArray(value) && value.length > 0
            ? value.map((child) => (object(child) ? convert(child) : invalidSchema()))
            : invalidSchema(),
        ];
      return [key, value];
    });
    const converted = Object.fromEntries(entries);
    if (schema.type !== 'object' && !object(schema.properties)) return converted;
    const properties = object(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    return {
      ...converted,
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, child]) => {
          const wire = object(child) ? convert(child) : invalidSchema();
          return [
            key,
            !required.includes(key) && object(child) && !nullable(child, root)
              ? { anyOf: [wire, { type: 'null' }] }
              : wire,
          ];
        }),
      ),
      required: Object.keys(properties),
      additionalProperties: false,
    };
  };
  return cloneOpenAiOwnedJson(convert(root), 64, 100_000) as Schema;
};

/** Only remove null where the local property is optional AND originally non-nullable. */
export const normalizeOpenAiOptionalNulls = (input: JsonValue, schema: Schema): JsonValue => {
  const normalize = (value: JsonValue, current: Schema, depth: number): JsonValue => {
    if (depth > 64) throw new TypeError('INVALID_OPENAI_SCHEMA');
    const ref = reference(current, schema);
    if (ref) return normalize(value, ref, depth + 1);
    for (const key of ['anyOf', 'oneOf']) {
      const branches = current[key];
      if (!Array.isArray(branches)) continue;
      const matches = branches.filter(
        (branch): branch is Schema => object(branch) && compatible(value, branch),
      );
      const candidates = matches.map((branch) => normalize(value, branch, depth + 1));
      const first = candidates[0];
      // Ambiguous unions must not discard a null that another local branch owns.
      return first !== undefined &&
        candidates.every((candidate) => JSON.stringify(candidate) === JSON.stringify(first))
        ? first
        : value;
    }
    if (Array.isArray(value) && object(current.items)) {
      const items = current.items;
      return value.map((item) => normalize(item, items, depth + 1));
    }
    if (!object(value) || !object(current.properties)) return value;
    const properties = current.properties;
    const required = Array.isArray(current.required) ? current.required : [];
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) => {
        const property = properties[key];
        if (!object(property)) return [[key, child]];
        if (child === null && !required.includes(key) && !nullable(property, schema)) return [];
        return [[key, normalize(child, property, depth + 1)]];
      }),
    );
  };
  return normalize(input, schema, 0);
};

const compatible = (value: JsonValue, schema: Schema): boolean => {
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (typeof schema.type === 'string') {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (schema.type !== type && !(schema.type === 'integer' && Number.isInteger(value)))
      return false;
  }
  if (object(value) && object(schema.properties))
    for (const [key, property] of Object.entries(schema.properties)) {
      if (object(property) && Object.hasOwn(property, 'const') && value[key] !== property.const)
        return false;
    }
  return true;
};
