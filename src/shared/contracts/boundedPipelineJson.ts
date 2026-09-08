export const PIPELINE_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export const PIPELINE_ARTIFACT_MAX_NODES = 250_000;
export const PIPELINE_ARTIFACT_MAX_DEPTH = 32;

const invalid: () => never = () => {
  throw new TypeError('INVALID_PIPELINE_ARTIFACT');
};

// Count JSON-escaped UTF-8 bytes without allocating a serialized copy first.
const stringBytes = (text: string, remaining: number): number => {
  let bytes = 2;
  if (text.length > remaining) return invalid();
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes += 1;
    else if (code < 2048) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > remaining) return invalid();
  }
  return bytes;
};

/** Before Zod, cloning or hashing. Repeated object references are refused as well as cycles. */
export const assertBoundedPipelineJson = (value: unknown): void => {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  const add = (count: number): void => {
    bytes += count;
    if (bytes > PIPELINE_ARTIFACT_MAX_BYTES) invalid();
  };
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > PIPELINE_ARTIFACT_MAX_NODES || depth > PIPELINE_ARTIFACT_MAX_DEPTH) invalid();
    if (typeof node === 'string') {
      add(stringBytes(node, PIPELINE_ARTIFACT_MAX_BYTES - bytes));
      return;
    }
    if (node === null || typeof node === 'boolean') {
      add(node === null ? 4 : node ? 4 : 5);
      return;
    }
    if (typeof node === 'number' && Number.isFinite(node)) {
      add(JSON.stringify(node).length);
      return;
    }
    if (typeof node !== 'object' || node === null || seen.has(node)) invalid();
    seen.add(node);
    const array = Array.isArray(node);
    const prototype = Object.getPrototypeOf(node);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      invalid();
    if (array && node.length > PIPELINE_ARTIFACT_MAX_NODES - nodes) invalid();
    const keys = Reflect.ownKeys(node);
    if (keys.length > PIPELINE_ARTIFACT_MAX_NODES - nodes + (array ? 1 : 0)) invalid();
    add(2);
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
        invalid();
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
      if (array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= node.length)) invalid();
      if (count++ > 0) add(1);
      if (!array) add(stringBytes(key, PIPELINE_ARTIFACT_MAX_BYTES - bytes) + 1);
      visit(descriptor.value, depth + 1);
    }
    if (array && count !== node.length) invalid();
  };
  visit(value, 0);
};
