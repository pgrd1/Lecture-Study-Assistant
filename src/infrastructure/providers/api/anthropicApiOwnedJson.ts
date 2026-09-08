import { types as nodeUtilTypes } from 'node:util';
import type { JsonValue } from '../../../shared/contracts/provider';

const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/u;

type JsonAncestor = Readonly<{
  value: object;
  next: JsonAncestor | null;
}>;

type DataEntry = Readonly<{
  key: string;
  value: unknown;
}>;

const invalidJson = (): TypeError => new TypeError('INVALID_ANTHROPIC_JSON');

const hasAncestor = (ancestors: JsonAncestor | null, value: object): boolean => {
  let current = ancestors;
  while (current !== null) {
    if (current.value === value) return true;
    current = current.next;
  }
  return false;
};

const rejectInheritedEnumeration = (value: object, expectedCount: number): void => {
  let count = 0;
  for (const key in value) {
    count += 1;
    if (count > expectedCount || !Object.hasOwn(value, key)) throw invalidJson();
  }
  if (count !== expectedCount) throw invalidJson();
};

const readObjectEntries = (value: object, remainingEntries: number): readonly DataEntry[] => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidJson();
  const keys = Reflect.ownKeys(value);
  if (keys.length > remainingEntries) throw invalidJson();
  const entries: DataEntry[] = [];
  for (const key of keys) {
    if (typeof key !== 'string') throw invalidJson();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalidJson();
    }
    entries.push(Object.freeze({ key, value: descriptor.value }));
  }
  rejectInheritedEnumeration(value, entries.length);
  return Object.freeze(entries);
};

const readArrayEntries = (value: unknown[], remainingEntries: number): readonly DataEntry[] => {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw invalidJson();
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    lengthDescriptor.enumerable ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > remainingEntries
  ) {
    throw invalidJson();
  }
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1) throw invalidJson();
  const entries: DataEntry[] = [];
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !ARRAY_INDEX_PATTERN.test(key) || Number(key) >= length) {
      throw invalidJson();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalidJson();
    }
    entries.push(Object.freeze({ key, value: descriptor.value }));
  }
  if (entries.length !== length) throw invalidJson();
  rejectInheritedEnumeration(value, length);
  return Object.freeze(entries);
};

export const cloneAnthropicOwnedJson = (
  root: unknown,
  maxDepth: number,
  maxEntries: number,
): JsonValue => {
  if (
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 0 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 0
  ) {
    throw invalidJson();
  }
  let visitedEntries = 0;

  const visit = (value: unknown, depth: number, ancestors: JsonAncestor | null): JsonValue => {
    if (depth > maxDepth) throw invalidJson();
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      return value;
    }
    if (typeof value !== 'object' || nodeUtilTypes.isProxy(value)) throw invalidJson();
    if (hasAncestor(ancestors, value)) throw invalidJson();
    const nextAncestors = Object.freeze({ value, next: ancestors });
    const remainingEntries = maxEntries - visitedEntries;
    const isArray = Array.isArray(value);
    const entries = isArray
      ? readArrayEntries(value as unknown[], remainingEntries)
      : readObjectEntries(value, remainingEntries);
    visitedEntries += entries.length;

    if (isArray) {
      const result = new Array<JsonValue>(entries.length);
      for (const entry of entries) {
        Object.defineProperty(result, entry.key, {
          configurable: false,
          enumerable: true,
          value: visit(entry.value, depth + 1, nextAncestors),
          writable: false,
        });
      }
      return Object.freeze(result);
    }

    const result = Object.create(null) as Record<string, JsonValue>;
    for (const entry of entries) {
      Object.defineProperty(result, entry.key, {
        configurable: false,
        enumerable: true,
        value: visit(entry.value, depth + 1, nextAncestors),
        writable: false,
      });
    }
    return Object.freeze(result);
  };

  return visit(root, 0, null);
};

const hasDuplicateObjectKeys = (text: string): boolean => {
  const scopes: Array<Set<string> | null> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') {
      scopes.push(new Set());
      continue;
    }
    if (character === '[') {
      scopes.push(null);
      continue;
    }
    if (character === '}' || character === ']') {
      scopes.pop();
      continue;
    }
    if (character !== '"') continue;
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === '"') break;
      index += 1;
    }
    let next = index + 1;
    while (next < text.length && /\s/u.test(text[next] ?? '')) next += 1;
    const scope = scopes.at(-1);
    if (text[next] === ':' && scope instanceof Set) {
      try {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (scope.has(key)) return true;
        scope.add(key);
      } catch {}
    }
  }
  return false;
};

export const parseAnthropicOwnedJsonText = (
  text: string,
  maxDepth: number,
  maxEntries: number,
): JsonValue => {
  if (hasDuplicateObjectKeys(text)) throw invalidJson();
  return cloneAnthropicOwnedJson(JSON.parse(text), maxDepth, maxEntries);
};
