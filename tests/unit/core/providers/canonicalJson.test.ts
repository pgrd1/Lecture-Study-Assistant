import { describe, expect, it } from 'vitest';
import { freezeJsonCopy, sha256CanonicalJson } from '../../../../src/core/providers/canonicalJson';

describe('canonical JSON hashing', () => {
  it('hashes recursively equivalent object trees identically regardless of insertion order', () => {
    expect(sha256CanonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe(
      sha256CanonicalJson({ a: true, z: [{ a: 1, b: 2 }] }),
    );
  });

  it('preserves array order and normalizes negative zero', () => {
    expect(sha256CanonicalJson([1, 2])).not.toBe(sha256CanonicalJson([2, 1]));
    expect(sha256CanonicalJson(-0)).toBe(sha256CanonicalJson(0));
  });

  it.each([
    ['not-a-number', () => Number.NaN],
    ['positive infinity', () => Number.POSITIVE_INFINITY],
    ['undefined', () => undefined],
    ['class instance', () => new (class Value {})()],
    ['accessor', () => Object.defineProperty({}, 'secret', { enumerable: true, get: () => 1 })],
    ['symbol', () => Symbol('secret')],
    [
      'cyclic object',
      () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
    ],
  ])('rejects %s before hashing', (_name, createValue) => {
    expect(() => sha256CanonicalJson(createValue())).toThrow();
  });

  it('rejects accessors without reading their values', () => {
    let reads = 0;
    const value = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'never-read';
      },
    });

    expect(() => sha256CanonicalJson(value)).toThrow();
    expect(reads).toBe(0);
  });

  it('returns only a lowercase SHA-256 digest', () => {
    expect(sha256CanonicalJson({ value: 'private' })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('copies and recursively freezes JSON without changing its input', () => {
    const input = { list: [{ value: 'before' }] };
    const copy = freezeJsonCopy(input);

    expect(copy).toEqual(input);
    expect(copy).not.toBe(input);
    expect(copy.list).not.toBe(input.list);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.list)).toBe(true);
    expect(Object.isFrozen(copy.list[0])).toBe(true);
    expect(input.list[0]?.value).toBe('before');
  });
});
