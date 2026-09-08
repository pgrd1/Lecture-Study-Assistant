import { types as nodeUtilTypes } from 'node:util';
import type { JsonValue } from '../../../shared/contracts/provider';

const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/;
const MAX_CLOSED_OBJECT_ITERATIONS = 64;

export type ClosedDataObject = Readonly<Record<string, unknown>>;

type JsonAncestor = Readonly<{ value: object; next: JsonAncestor | null }>;
type MutableJsonContainer = Record<string, JsonValue> | JsonValue[];
type VisitWork = Readonly<{
  kind: 'visit';
  source: unknown;
  parent: MutableJsonContainer | null;
  key: string | null;
  depth: number;
  ancestors: JsonAncestor | null;
  next: JsonWork | null;
}>;
type FreezeWork = Readonly<{
  kind: 'freeze';
  target: MutableJsonContainer;
  next: JsonWork | null;
}>;
type JsonWork = VisitWork | FreezeWork;

const requirePlainObject = (value: unknown, errorCode: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) {
    throw new TypeError(errorCode);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(errorCode);
  return value as Record<string, unknown>;
};

export const readClosedDataObject = (
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: ReadonlySet<string>,
): ClosedDataObject => {
  const source = requirePlainObject(value, 'INVALID_PROVIDER_HTTP_OBJECT');
  const values = Object.create(null) as Record<string, unknown>;
  let iterations = 0;
  for (const key in source) {
    iterations += 1;
    if (iterations > MAX_CLOSED_OBJECT_ITERATIONS) {
      throw new TypeError('PROVIDER_HTTP_OBJECT_TOO_WIDE');
    }
    if (!Object.hasOwn(source, key)) continue;
    if (!allowedKeys.has(key)) throw new TypeError('INVALID_PROVIDER_HTTP_KEYS');
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('INVALID_PROVIDER_HTTP_PROPERTY');
    }
    Object.defineProperty(values, key, {
      enumerable: true,
      value: descriptor.value,
    });
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(values, key)) throw new TypeError('INVALID_PROVIDER_HTTP_KEYS');
  }
  return Object.freeze(values);
};

const containsAncestor = (ancestors: JsonAncestor | null, value: object): boolean => {
  let current = ancestors;
  while (current !== null) {
    if (current.value === value) return true;
    current = current.next;
  }
  return false;
};

const assignValue = (
  parent: MutableJsonContainer | null,
  key: string | null,
  value: JsonValue,
  setRoot: (root: JsonValue) => void,
): void => {
  if (parent === null) {
    setRoot(value);
    return;
  }
  if (key === null) throw new TypeError('INVALID_PROVIDER_JSON_KEY');
  Object.defineProperty(parent, key, { value });
};

const createContainer = (
  source: object,
  maxEntries: number,
  arrayPrototype: 'none' | 'standard',
): MutableJsonContainer => {
  if (!Array.isArray(source)) return Object.create(null) as Record<string, JsonValue>;
  if (Object.getPrototypeOf(source) !== Array.prototype || source.length > maxEntries) {
    throw new TypeError('INVALID_PROVIDER_JSON_ARRAY');
  }
  const array = new Array<JsonValue>(source.length);
  if (arrayPrototype === 'none') Object.setPrototypeOf(array, null);
  return array;
};

export const cloneBoundedJsonValue = (
  root: unknown,
  maxDepth: number,
  maxEntries: number,
  arrayPrototype: 'none' | 'standard' = 'standard',
): JsonValue => {
  let clonedRoot: JsonValue | undefined;
  let entries = 0;
  let work: JsonWork | null = Object.freeze({
    kind: 'visit',
    source: root,
    parent: null,
    key: null,
    depth: 0,
    ancestors: null,
    next: null,
  });
  const setRoot = (value: JsonValue) => {
    clonedRoot = value;
  };

  while (work !== null) {
    const current: JsonWork = work;
    work = current.next;
    if (current.kind === 'freeze') {
      Object.freeze(current.target);
      continue;
    }
    const value = current.source;
    if (current.depth > maxDepth) throw new TypeError('PROVIDER_JSON_TOO_DEEP');
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      assignValue(current.parent, current.key, value, setRoot);
      continue;
    }
    if (typeof value !== 'object' || nodeUtilTypes.isProxy(value)) {
      throw new TypeError('INVALID_PROVIDER_JSON_VALUE');
    }
    if (containsAncestor(current.ancestors, value)) {
      throw new TypeError('CYCLIC_PROVIDER_JSON');
    }
    const isArray = Array.isArray(value);
    if (!isArray) requirePlainObject(value, 'INVALID_PROVIDER_JSON_OBJECT');
    const target = createContainer(value, maxEntries - entries, arrayPrototype);
    assignValue(current.parent, current.key, target, setRoot);
    const childAncestors: JsonAncestor = Object.freeze({
      value,
      next: current.ancestors,
    });
    let ownEntries = 0;
    let pending: JsonWork = Object.freeze({ kind: 'freeze', target, next: work });
    for (const key in value) {
      entries += 1;
      if (entries > maxEntries) throw new TypeError('PROVIDER_JSON_TOO_WIDE');
      if (!Object.hasOwn(value, key)) continue;
      if (isArray && (!ARRAY_INDEX_PATTERN.test(key) || Number(key) >= value.length)) {
        throw new TypeError('INVALID_PROVIDER_JSON_ARRAY');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('INVALID_PROVIDER_JSON_PROPERTY');
      }
      ownEntries += 1;
      Object.defineProperty(target, key, {
        configurable: false,
        enumerable: true,
        value: null,
        writable: true,
      });
      pending = Object.freeze({
        kind: 'visit',
        source: descriptor.value,
        parent: target,
        key,
        depth: current.depth + 1,
        ancestors: childAncestors,
        next: pending,
      });
    }
    if (isArray && ownEntries !== value.length) {
      throw new TypeError('INVALID_PROVIDER_JSON_ARRAY');
    }
    work = pending;
  }
  if (clonedRoot === undefined) throw new TypeError('INVALID_PROVIDER_JSON_VALUE');
  return clonedRoot;
};
