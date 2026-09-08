import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open } from 'node:fs/promises';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';
import { assertNoReparsePoints } from '../paths/safePath';

const SHA_256 = /^[a-f0-9]{64}$/;
export const DEFAULT_MAX_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;

export type Sha256FileOptions = Readonly<{
  maxBytes?: number;
  openFile?: (filePath: string) => Promise<Sha256FileHandle>;
  signal?: AbortSignal;
}>;

export type Sha256FileHandle = Readonly<{
  close: () => Promise<void>;
  createReadStream: (
    options?: Parameters<FileHandle['createReadStream']>[0],
  ) => ReturnType<FileHandle['createReadStream']>;
  stat: () => Promise<Stats>;
}>;

class SourceTooLargeError extends Error {}
class SourceHashCancelledError extends Error {}

const streamSha256 = async (
  handle: Sha256FileHandle,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> => {
  const hash = createHash('sha256');
  const stream = handle.createReadStream({ autoClose: false, signal });
  let bytesRead = 0;

  for await (const chunk of stream) {
    bytesRead += chunk.byteLength;
    if (bytesRead > maxBytes) {
      throw new SourceTooLargeError();
    }
    hash.update(chunk);
  }

  return hash.digest('hex');
};

const sameFileSnapshot = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

export const sha256File = async (
  filePath: string,
  options: Sha256FileOptions = {},
): Promise<string> => {
  let handle: Sha256FileHandle | undefined;
  try {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError('INVALID_MAX_SOURCE_BYTES');
    }
    if (options.signal?.aborted) {
      throw new SourceHashCancelledError();
    }

    assertNoReparsePoints(filePath);
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new TypeError('SOURCE_NOT_REGULAR_FILE');
    }
    if (stats.size > maxBytes) {
      throw new SourceTooLargeError();
    }

    handle = await (options.openFile ?? ((path) => open(path, 'r')))(filePath);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > maxBytes ||
      !sameFileSnapshot(stats, before)
    ) {
      throw new TypeError('SOURCE_OPEN_IDENTITY_MISMATCH');
    }
    const sha256 = await streamSha256(handle, maxBytes, options.signal);
    const after = await handle.stat();
    assertNoReparsePoints(filePath);
    const current = await lstat(filePath);
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, current)) {
      throw new TypeError('SOURCE_CHANGED_DURING_HASH');
    }
    return sha256;
  } catch (error) {
    if (error instanceof SourceTooLargeError) {
      throw new AppError('SOURCE_TOO_LARGE', APP_ERROR_MESSAGES.SOURCE_TOO_LARGE);
    }
    if (error instanceof SourceHashCancelledError || options.signal?.aborted) {
      throw new AppError('SOURCE_HASH_CANCELLED', APP_ERROR_MESSAGES.SOURCE_HASH_CANCELLED);
    }
    throw new AppError('SOURCE_HASH_FAILED', APP_ERROR_MESSAGES.SOURCE_HASH_FAILED, {
      retryable: true,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const createJobFingerprint = (courseId: string, sha256: string): string => {
  if (courseId.trim().length === 0 || !SHA_256.test(sha256)) {
    throw new AppError('INVALID_FINGERPRINT', APP_ERROR_MESSAGES.INVALID_FINGERPRINT);
  }

  return createHash('sha256').update(`${courseId}:${sha256}`, 'utf8').digest('hex');
};

export const createBundleFingerprint = (
  courseId: string,
  sourceHashes: readonly string[],
): string => {
  if (
    courseId.trim().length === 0 ||
    sourceHashes.length < 1 ||
    sourceHashes.length > 32 ||
    sourceHashes.some((hash) => !SHA_256.test(hash))
  ) {
    throw new AppError('INVALID_FINGERPRINT', APP_ERROR_MESSAGES.INVALID_FINGERPRINT);
  }

  const fingerprint = createHash('sha256').update(courseId, 'utf8').update('\0', 'utf8');
  for (const sourceHash of sourceHashes) {
    fingerprint.update(sourceHash, 'utf8').update('\0', 'utf8');
  }
  return fingerprint.digest('hex');
};
