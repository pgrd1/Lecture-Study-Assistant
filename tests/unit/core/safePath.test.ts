import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveManagedPath, toSafeCourseFolder } from '../../../src/core/paths/safePath';
import { withTempDirectory } from '../../testkit/tempDirectory';

describe('safe managed paths', () => {
  it.each(['CON.base', 'NUL.canvas', 'aux.svg', 'COM¹.json', 'LPT².base'])(
    'rejects device names with Obsidian artifact extensions %s',
    (segment) => {
      expect(() => resolveManagedPath('C:\\vault\\AI 학습', segment)).toThrow('SAFE_PATH');
    },
  );
  it.each(['..', '../outside', 'C:\\Windows', '\\\\server\\share', 'CON', 'name.'])(
    'rejects unsafe segment %s',
    (segment) => {
      expect(() => resolveManagedPath('C:\\vault\\AI 학습', segment)).toThrow('SAFE_PATH');
    },
  );

  it.each(['CON.txt', 'nul.MD', 'COM1', 'lpt1'])('rejects Windows device name %s', (segment) => {
    expect(() => resolveManagedPath('C:\\vault\\AI 학습', segment)).toThrow('SAFE_PATH');
  });

  it.each(['lecture:evil.m4a', 'lecture ', 'lecture\u0000.m4a', 'lecture\u0001.m4a'])(
    'rejects unsafe Windows file segment %s',
    (segment) => {
      expect(() => resolveManagedPath('C:\\vault\\AI 학습', '자료구조', segment)).toThrow(
        'SAFE_PATH',
      );
    },
  );

  it('keeps readable Korean course names while replacing Windows separators', () => {
    expect(toSafeCourseFolder('자료구조 / 1분반')).toBe('자료구조 - 1분반');
  });

  it.each([
    ['CON', 'CON 과목'],
    ['  운영체제...  ', '운영체제'],
    ['   ', '새 과목'],
  ])('normalizes course folder %s', (input, expected) => {
    expect(toSafeCourseFolder(input)).toBe(expected);
  });

  it('keeps expanded separator-heavy course folders within the persisted segment limit', () => {
    const name = Array.from({ length: 21 }, (_, index) => `a${index % 10}`).join('/');
    const folder = toSafeCourseFolder(name);

    expect(name.length).toBeLessThanOrEqual(80);
    expect(folder.length).toBeLessThanOrEqual(100);
    expect(folder).toMatch(/-[a-f0-9]{10}$/u);
    expect(toSafeCourseFolder(name)).toBe(folder);
  });

  it('resolves nested safe segments under the managed root', () => {
    expect(resolveManagedPath('C:\\vault\\AI 학습', '자료구조', '1주차.md')).toBe(
      'C:\\vault\\AI 학습\\자료구조\\1주차.md',
    );
  });

  it('requires an absolute managed root', () => {
    expect(() => resolveManagedPath('relative-vault', '자료구조')).toThrow('SAFE_PATH');
  });

  it.each([
    '\\\\?\\C:\\vault',
    '\\\\.\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\vault',
    '\\\\server\\share\\vault',
    'C:\\vault\\name.',
    'C:\\vault:stream',
    'C:\\',
  ])('rejects an unsafe managed root %s', (root) => {
    expect(() => resolveManagedPath(root, '자료구조')).toThrow('SAFE_PATH');
  });

  it('allows a safe segment that merely starts with two dots', () => {
    expect(resolveManagedPath('C:\\vault\\AI 학습', '..자료구조')).toBe(
      'C:\\vault\\AI 학습\\..자료구조',
    );
  });

  it('rejects an existing junction below the managed root', async () => {
    await withTempDirectory(async (root) => {
      await withTempDirectory(async (outside) => {
        const linkedDirectory = join(root, 'linked');
        await mkdir(join(outside, 'target'));
        await symlink(join(outside, 'target'), linkedDirectory, 'junction');

        expect(() => resolveManagedPath(root, 'linked', 'escape.md')).toThrow('SAFE_PATH');
      });
    });
  });
});
