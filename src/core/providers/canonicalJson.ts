import { createHash } from 'node:crypto';
import type { JsonValue } from '../../shared/contracts/provider';

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const copyJsonValue = (value: unknown, ancestors: ReadonlySet<object>): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('INVALID_CANONICAL_JSON_NUMBER');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('INVALID_CANONICAL_JSON_VALUE');
  }
  if (ancestors.has(value)) {
    throw new TypeError('CYCLIC_CANONICAL_JSON');
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        throw new TypeError('INVALID_CANONICAL_JSON_SYMBOL');
      }
      if (key !== 'length') {
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          !descriptor.enumerable ||
          !/^(?:0|[1-9]\d*)$/.test(key) ||
          Number(key) >= value.length
        ) {
          throw new TypeError('INVALID_CANONICAL_JSON_PROPERTY');
        }
      }
    }
    const copied: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new TypeError('INVALID_CANONICAL_JSON_ARRAY');
      }
      copied.push(copyJsonValue(descriptor.value, nextAncestors));
    }
    return copied;
  }
  if (!isPlainObject(value)) {
    throw new TypeError('INVALID_CANONICAL_JSON_OBJECT');
  }

  const objectValue = value as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(objectValue);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('INVALID_CANONICAL_JSON_SYMBOL');
  }
  const stringKeys = keys.filter((key): key is string => typeof key === 'string').sort();
  const copied: Record<string, JsonValue> = {};
  for (const key of stringKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('INVALID_CANONICAL_JSON_PROPERTY');
    }
    copied[key] = copyJsonValue(descriptor.value, nextAncestors);
  }
  return copied;
};

const canonicalize = (value: JsonValue): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const objectValue = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(objectValue[key] as JsonValue)}`)
    .join(',')}}`;
};

export const freezeJsonCopy = <Value extends JsonValue>(value: Value): Value => {
  const copy = copyJsonValue(value, new Set());
  const freeze = (node: JsonValue): JsonValue => {
    if (Array.isArray(node)) {
      return Object.freeze(node.map(freeze));
    }
    if (node !== null && typeof node === 'object') {
      const frozen: Record<string, JsonValue> = {};
      const objectNode = node as Readonly<Record<string, JsonValue>>;
      for (const key of Object.keys(objectNode)) {
        frozen[key] = freeze(objectNode[key] as JsonValue);
      }
      return Object.freeze(frozen);
    }
    return node;
  };
  return freeze(copy) as Value;
};

export const sha256CanonicalJson = (value: unknown): string => {
  const validated = copyJsonValue(value, new Set());
  return createHash('sha256').update(canonicalize(validated), 'utf8').digest('hex');
};
