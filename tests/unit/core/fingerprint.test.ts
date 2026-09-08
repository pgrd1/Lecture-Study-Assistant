import { mkdir, open, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBundleFingerprint,
  createJobFingerprint,
  sha256File,
} from '../../../src/core/jobs/fingerprint';
import { fixtureFile, withTempDirectory } from '../../testkit/tempDirectory';

describe('job fingerprints', () => {
  it('creates a stable course-scoped fingerprint', async () => {
    const file = await fixtureFile('강의.m4a', Buffer.from('same bytes'));
    const hash = await sha256File(file);

    expect(hash).toBe('58100dc8fc06562ce3e578231dc948e083520ee49c4b4ee5a5a28bb4b4003feb');
    expect(createJobFingerprint('course-a', hash)).toBe(
      'ca4d458a93726424fba2cbdb9a99cd3c37d7d19a976775c9379453af67c15bd6',
    );
    expect(createJobFingerprint('course-a', hash)).not.toBe(createJobFingerprint('course-b', hash));
    expect(createJobFingerprint('course-a', hash)).toBe(createJobFingerprint('course-a', hash));
  });

  it.each(['A'.repeat(64), 'not-a-sha'])('rejects invalid source hash %s', (hash) => {
    expect(() => createJobFingerprint('course-a', hash)).toThrow('INVALID_FINGERPRINT');
  });

  it('rejects a blank course identifier', () => {
    expect(() => createJobFingerprint('   ', 'a'.repeat(64))).toThrow('INVALID_FINGERPRINT');
  });

  it('creates a stable, order-sensitive bundle fingerprint', () => {
    const hashes = ['a'.repeat(64), 'b'.repeat(64)];

    expect(createBundleFingerprint('course-a', hashes)).toBe(
      createBundleFingerprint('course-a', hashes),
    );
    expect(createBundleFingerprint('course-a', hashes)).not.toBe(
      createBundleFingerprint('course-a', [...hashes].reverse()),
    );
  });

  it.each([
    ['empty sequence', []],
    ['uppercase hash', ['A'.repeat(64)]],
    ['malformed hash', ['a'.repeat(64), 'not-a-sha']],
  ] as const)('rejects %s bundle hashes', (_case, hashes) => {
    expect(() => createBundleFingerprint('course-a', hashes)).toThrow('INVALID_FINGERPRINT');
  });

  it('returns a fixed application error without leaking a missing file path', async () => {
    await withTempDirectory(async (directory) => {
      const missingFile = join(directory, '비공개-강의.m4a');

      await expect(sha256File(missingFile)).rejects.toMatchObject({
        code: 'SOURCE_HASH_FAILED',
        displayMessage: '원본 파일의 무결성을 확인하지 못했습니다.',
        retryable: true,
      });
    });
  });

  it('rejects a source reached through a directory junction', async () => {
    await withTempDirectory(async (root) => {
      await withTempDirectory(async (outside) => {
        const target = join(outside, 'target');
        const source = join(target, 'lecture.m4a');
        await mkdir(target);
        await writeFile(source, 'private lecture');
        await symlink(target, join(root, 'linked'), 'junction');

        await expect(sha256File(join(root, 'linked', 'lecture.m4a'))).rejects.toMatchObject({
          code: 'SOURCE_HASH_FAILED',
        });
      });
    });
  });

  it('stops hashing when the configured byte limit is exceeded', async () => {
    const file = await fixtureFile('oversized.m4a', Buffer.from('five!'));

    await expect(sha256File(file, { maxBytes: 4 })).rejects.toMatchObject({
      code: 'SOURCE_TOO_LARGE',
      retryable: false,
    });
  });

  it('rejects a different file opened after validation before streaming any bytes', async () => {
    await withTempDirectory(async (root) => {
      const source = join(root, 'lecture.m4a');
      const displaced = join(root, 'lecture-original.m4a');
      const outside = join(root, 'outside.m4a');
      await writeFile(source, 'trusted-data');
      await writeFile(outside, 'outside-data');
      let streamStarted = false;

      await expect(
        sha256File(source, {
          openFile: async (path) => {
            await rename(path, displaced);
            await rename(outside, path);
            const substituted = await open(path, 'r');
            await rename(path, outside);
            await rename(displaced, path);
            return Object.freeze({
              close: () => substituted.close(),
              createReadStream: (options) => {
                streamStarted = true;
                return substituted.createReadStream(options);
              },
              stat: () => substituted.stat(),
            });
          },
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_HASH_FAILED' });

      expect(streamStarted).toBe(false);
      expect(await readFile(source, 'utf8')).toBe('trusted-data');
      expect(await readFile(outside, 'utf8')).toBe('outside-data');
    });
  });

  it('supports cancellation without exposing the abort reason', async () => {
    const file = await fixtureFile('cancelled.m4a', Buffer.from('lecture'));
    const controller = new AbortController();
    controller.abort('C:\\private\\reason.txt');

    await expect(sha256File(file, { signal: controller.signal })).rejects.toMatchObject({
      code: 'SOURCE_HASH_CANCELLED',
      displayMessage: '원본 파일 무결성 확인이 취소되었습니다.',
      retryable: false,
    });
  });
});
