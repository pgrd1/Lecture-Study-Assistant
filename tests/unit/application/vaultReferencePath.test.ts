import { describe, expect, it } from 'vitest';
import { toVaultRelativePath } from '../../../src/application/obsidian/vaultReferencePath';

describe('managed artifact to Vault reference boundary', () => {
  it('prefixes files and folders exactly once without changing managed identities', () => {
    for (const path of [
      '과목/자료구조/a.md',
      '과목',
      '과목/자료구조/시험',
      "과목/O'Brien [x] # yes",
    ]) {
      expect(toVaultRelativePath(path)).toBe(`AI 학습/${path}`);
      expect(() => toVaultRelativePath(toVaultRelativePath(path))).toThrow();
    }
  });

  it.each([
    '',
    '../a.md',
    '/a.md',
    'C:/a.md',
    'a\\b.md',
    'a//b.md',
    'a/../b.md',
    'AI 학습',
    'AI 학습/a.md',
    'AI 학습/AI 학습/a.md',
    'ai 학습/a.md',
    'a\u202e.md',
    'a\0.md',
    'CON',
    'a%2fb.md',
    `${'a'.repeat(250)}/${'b'.repeat(250)}/${'c'.repeat(250)}/${'d'.repeat(250)}/${'e'.repeat(16)}`,
  ])('rejects malformed, already encoded, or overflowing paths %j', (path) => {
    expect(() => toVaultRelativePath(path)).toThrow();
  });

  it('never coerces objects or invokes accessors', () => {
    let calls = 0;
    expect(() =>
      toVaultRelativePath({
        toString: () => {
          calls++;
          return 'a.md';
        },
      }),
    ).toThrow();
    expect(calls).toBe(0);
  });
});
