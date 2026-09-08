import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { win32 } from 'node:path';
import { sha256File } from '../../core/jobs/fingerprint';
import { assertNoReparsePoints, resolveManagedPath } from '../../core/paths/safePath';
import { createSafeRootConnection } from '../../infrastructure/queue/queueLayout';
import { type Job, JobSchema } from '../../shared/contracts/job';
import { extensionOf } from '../../shared/contracts/sourceFile';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

const LARGE_SOURCE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const SMALL_SOURCE_MAX_BYTES = 500 * 1024 * 1024;

export interface StagingSourceCleanerPort {
  cleanup(job: Job): Promise<void>;
}

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

const sameSnapshot = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const normalizedPath = (value: string): string => win32.normalize(value).toLocaleLowerCase('en-US');

const sourceLimit = (job: Job): number =>
  job.sourceMediaType === 'audio' || job.sourceMediaType === 'video'
    ? LARGE_SOURCE_MAX_BYTES
    : SMALL_SOURCE_MAX_BYTES;

const cleanupError = (): AppError =>
  new AppError('SOURCE_COPY_FAILED', APP_ERROR_MESSAGES.SOURCE_COPY_FAILED);

const validateDirectory = async (
  directoryPath: string,
  expectedSourceName: string,
  requireSource: boolean,
): Promise<readonly Dirent[]> => {
  assertNoReparsePoints(directoryPath);
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw cleanupError();
  }
  const entries = await readdir(directoryPath, { withFileTypes: true });
  if (
    entries.length > 1 ||
    (requireSource && entries.length !== 1) ||
    entries.some(
      (entry) => entry.name !== expectedSourceName || !entry.isFile() || entry.isSymbolicLink(),
    )
  ) {
    throw cleanupError();
  }
  for (const entry of entries) {
    assertNoReparsePoints(resolveManagedPath(directoryPath, entry.name));
  }
  return Object.freeze(entries);
};

export class StagingSourceCleaner implements StagingSourceCleanerPort {
  readonly #stagingRoot: string;

  constructor(stagingRoot: string) {
    this.#stagingRoot = stagingRoot;
  }

  async cleanup(job: Job): Promise<void> {
    const parsed = JobSchema.parse(job);
    const connection = await createSafeRootConnection(this.#stagingRoot);
    const sourceName = `source${extensionOf(parsed.sourceFileName)}`;
    const activeDirectory = resolveManagedPath(connection.managedRoot, parsed.id);
    const expectedSource = resolveManagedPath(connection.managedRoot, parsed.id, sourceName);
    const cleanupDirectory = resolveManagedPath(connection.managedRoot, `.completed-${parsed.id}`);
    const [activeExists, cleanupExists] = await Promise.all([
      pathExists(activeDirectory),
      pathExists(cleanupDirectory),
    ]);
    if (activeExists && cleanupExists) {
      await this.#removeCleanupDirectory(parsed, cleanupDirectory, sourceName);
    }
    if (!activeExists && !cleanupExists) {
      return;
    }
    if (activeExists) {
      if (normalizedPath(parsed.stagedSourcePath) !== normalizedPath(expectedSource)) {
        throw cleanupError();
      }
      await validateDirectory(activeDirectory, sourceName, true);
      assertNoReparsePoints(activeDirectory);
      assertNoReparsePoints(cleanupDirectory);
      await rename(activeDirectory, cleanupDirectory);
    }

    await this.#removeCleanupDirectory(parsed, cleanupDirectory, sourceName);
  }

  async #removeCleanupDirectory(
    job: Job,
    cleanupDirectory: string,
    sourceName: string,
  ): Promise<void> {
    const entries = await validateDirectory(cleanupDirectory, sourceName, false);
    if (entries.length === 1) {
      const cleanupSource = resolveManagedPath(cleanupDirectory, sourceName);
      const before = await lstat(cleanupSource);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        (await sha256File(cleanupSource, { maxBytes: sourceLimit(job) })) !== job.sourceSha256
      ) {
        throw cleanupError();
      }
      assertNoReparsePoints(cleanupSource);
      const after = await lstat(cleanupSource);
      if (!sameSnapshot(before, after)) {
        throw cleanupError();
      }
      await unlink(cleanupSource);
    }
    if ((await readdir(cleanupDirectory)).length !== 0) {
      throw cleanupError();
    }
    await rmdir(cleanupDirectory);
  }
}
