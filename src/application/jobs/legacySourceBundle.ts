import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';
import { createJobFingerprint, sha256File } from '../../core/jobs/fingerprint';
import { resolveManagedPath } from '../../core/paths/safePath';
import type { SourceBundleRepository } from '../../core/ports/sourceBundleRepository';
import { sha256CanonicalJson } from '../../core/providers/canonicalJson';
import type { Job } from '../../shared/contracts/job';
import { SourceBundleSchema, SourceRecordSchema } from '../../shared/contracts/sourceBundle';
import { extensionOf } from '../../shared/contracts/sourceFile';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

export const deterministicBundleId = (jobId: string, fingerprint: string): string => {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`claimed-bundle:${jobId}:${fingerprint}`, 'utf8')
      .digest('hex')
      .slice(0, 32),
    'hex',
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Old singleton layout is distinct from v2/local bundle filenames. */
export const usesLegacyStagingLayout = (job: Job, root: string): boolean =>
  job.sourceCount === 1 &&
  (job.sourceBundleId === null ||
    job.sourceBundleId === deterministicBundleId(job.id, job.fingerprint)) &&
  win32.normalize(job.stagedSourcePath).toLowerCase() ===
    win32
      .normalize(resolveManagedPath(root, job.id, `source${extensionOf(job.sourceFileName)}`))
      .toLowerCase();

export const upgradeLegacySourceBundle = async (
  job: Job,
  root: string,
  repository: SourceBundleRepository,
): Promise<Job> => {
  if (job.sourceBundleId !== null) return job;
  const mismatch = () =>
    new AppError('SOURCE_HASH_MISMATCH', APP_ERROR_MESSAGES.SOURCE_HASH_MISMATCH);
  if (
    !usesLegacyStagingLayout(job, root) ||
    job.fingerprint !== createJobFingerprint(job.courseId, job.sourceSha256)
  )
    throw mismatch();
  const before = await lstat(job.stagedSourcePath);
  const sha256 = await sha256File(job.stagedSourcePath);
  const after = await lstat(job.stagedSourcePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    sha256 !== job.sourceSha256 ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw mismatch();
  const bundleId = deterministicBundleId(job.id, job.fingerprint);
  const record = SourceRecordSchema.parse({
    id: job.id,
    bundleId,
    ordinal: 0,
    originalFileName: job.sourceFileName,
    mediaType: job.sourceMediaType,
    stagedPath: job.stagedSourcePath,
    sha256,
    sizeBytes: after.size,
  });
  const bundle = SourceBundleSchema.parse({
    id: bundleId,
    jobId: job.id,
    manifestSha256: sha256CanonicalJson({
      identityVersion: 'legacy-singleton-v1',
      jobId: job.id,
      courseId: job.courseId,
      fingerprint: job.fingerprint,
      sourceFileName: job.sourceFileName,
      sourceMediaType: job.sourceMediaType,
      sha256,
      sizeBytes: after.size,
      summaryMode: job.summaryMode,
      createdAt: job.createdAt,
    }),
    sourceCount: 1,
    totalBytes: after.size,
    stagingDirectoryPath: dirname(job.stagedSourcePath),
    createdAt: job.createdAt,
  });
  // One database transaction owns job linkage + bundle + source record. No filesystem mutation.
  return repository.attachLegacyBundle(job, bundle, [record]);
};
