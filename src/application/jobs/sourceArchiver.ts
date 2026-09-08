import { lstat } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import { sha256File } from '../../core/jobs/fingerprint';
import { assertNoReparsePoints, resolveManagedPath } from '../../core/paths/safePath';
import type { JobArtifactRepository } from '../../core/ports/jobArtifactRepository';
import type { VaultConnection, VaultWriterPort } from '../../core/ports/vault';
import { type Course, CourseSchema } from '../../shared/contracts/course';
import { type Job, JobSchema } from '../../shared/contracts/job';
import { type JobArtifact, JobArtifactSchema } from '../../shared/contracts/jobArtifact';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export type SourceArchiverDependencies = Readonly<{
  artifacts: JobArtifactRepository;
  connection: VaultConnection;
  vault: VaultWriterPort;
  clock?: () => string;
}>;

const archiveDirectory = (job: Job): '문서' | '음성' =>
  job.sourceMediaType === 'audio' || job.sourceMediaType === 'video' ? '음성' : '문서';

const archiveRelativePath = (job: Job, course: Course): string =>
  `과목/${course.folderName}/자료/${archiveDirectory(job)}/${job.id}${extname(job.sourceFileName).toLocaleLowerCase('en-US')}`;

const generatedArchiveRelativePath = (job: Job, course: Course): string => {
  const extension = extname(job.sourceFileName).toLocaleLowerCase('en-US');
  return `과목/${course.folderName}/자료/${archiveDirectory(job)}/${job.id}.generated-${job.sourceSha256.slice(0, 12)}${extension}`;
};

const integrityError = (): AppError =>
  new AppError('ATTACHMENT_HASH_MISMATCH', APP_ERROR_MESSAGES.ATTACHMENT_HASH_MISMATCH);

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export class SourceArchiver {
  readonly #artifacts: JobArtifactRepository;
  readonly #clock: () => string;
  readonly #connection: VaultConnection;
  readonly #vault: VaultWriterPort;

  constructor(dependencies: SourceArchiverDependencies) {
    this.#artifacts = dependencies.artifacts;
    this.#connection = dependencies.connection;
    this.#vault = dependencies.vault;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async archive(job: Job, course: Course): Promise<JobArtifact> {
    const parsedJob = JobSchema.parse(job);
    const parsedCourse = CourseSchema.parse(course);
    const existing = this.#artifacts.get(parsedJob.id, 'source_archive');
    if (existing !== null) {
      await this.#assertArtifact(existing, parsedJob.sourceSha256);
      return existing;
    }

    const desiredPath = archiveRelativePath(parsedJob, parsedCourse);
    const desiredHash = await this.#managedHash(desiredPath);
    const generatedPath = generatedArchiveRelativePath(parsedJob, parsedCourse);
    const generatedHash =
      desiredHash === parsedJob.sourceSha256 ? null : await this.#managedHash(generatedPath);
    const selectedPath =
      desiredHash === parsedJob.sourceSha256 ||
      (desiredHash === null && generatedHash !== parsedJob.sourceSha256)
        ? desiredPath
        : generatedPath;
    const selectedHash = selectedPath === desiredPath ? desiredHash : generatedHash;
    if (selectedHash !== null && selectedHash !== parsedJob.sourceSha256) {
      throw new AppError('STALE_WRITE', APP_ERROR_MESSAGES.STALE_WRITE);
    }
    const relativePath =
      selectedHash === parsedJob.sourceSha256
        ? selectedPath
        : await this.#vault.copyAttachment({
            sourcePath: parsedJob.stagedSourcePath,
            relativePath: selectedPath,
            expectedSha256: parsedJob.sourceSha256,
          });
    if (relativePath !== selectedPath) {
      throw new AppError('STALE_WRITE', APP_ERROR_MESSAGES.STALE_WRITE);
    }
    const artifact = JobArtifactSchema.parse({
      jobId: parsedJob.id,
      kind: 'source_archive',
      relativePath,
      sha256: parsedJob.sourceSha256,
      createdAt: IsoDateTimeSchema.parse(this.#clock()),
    });
    await this.#assertArtifact(artifact, parsedJob.sourceSha256);
    return this.#artifacts.insert(artifact);
  }

  async #assertArtifact(artifact: JobArtifact, expectedSha256: string): Promise<void> {
    const absolutePath = resolveManagedPath(
      this.#connection.managedRoot,
      ...artifact.relativePath.split('/'),
    );
    const actual = await sha256File(absolutePath);
    if (artifact.sha256 !== expectedSha256 || actual !== expectedSha256) {
      throw integrityError();
    }
  }

  async #managedHash(relativePath: string): Promise<string | null> {
    const absolutePath = resolveManagedPath(
      this.#connection.managedRoot,
      ...relativePath.split('/'),
    );
    try {
      assertNoReparsePoints(absolutePath);
      const stats = await lstat(absolutePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw integrityError();
      }
      return await sha256File(absolutePath);
    } catch (error) {
      if (isMissingPathError(error)) {
        return null;
      }
      throw error;
    }
  }
}
