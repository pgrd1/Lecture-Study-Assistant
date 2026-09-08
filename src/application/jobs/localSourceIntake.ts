import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  createBundleFingerprint,
  createJobFingerprint,
  sha256File,
} from '../../core/jobs/fingerprint';
import { assertNoReparsePoints, resolveManagedPath } from '../../core/paths/safePath';
import type { CourseRepository } from '../../core/ports/courseRepository';
import type { JobRepository } from '../../core/ports/jobRepository';
import type { SourceBundleRepository } from '../../core/ports/sourceBundleRepository';
import { createSafeRootConnection } from '../../infrastructure/queue/queueLayout';
import { VaultWriter } from '../../infrastructure/vault/vaultWriter';
import {
  type Job,
  JobSchema,
  SOURCE_MEDIA_TYPES,
  type SourceMediaType,
  SummaryModeSchema,
} from '../../shared/contracts/job';
import { QueueSourceSchema } from '../../shared/contracts/queue';
import {
  MAX_AUDIO_VIDEO_SOURCE_BYTES,
  MAX_BUNDLE_BYTES,
  MAX_DOCUMENT_IMAGE_SOURCE_BYTES,
  MAX_SOURCES_PER_BUNDLE,
  type SourceBundle,
  SourceBundleSchema,
  type SourceRecord,
  SourceRecordSchema,
} from '../../shared/contracts/sourceBundle';
import { extensionOf, SupportedSourceFileNameSchema } from '../../shared/contracts/sourceFile';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const LocalSourceInputSchema = z
  .strictObject({
    courseId: z.uuid(),
    filePaths: z
      .array(
        z
          .string()
          .min(1)
          .max(32_767)
          .refine((value) => isAbsolute(value) && !value.includes('\0')),
      )
      .min(1)
      .max(MAX_SOURCES_PER_BUNDLE)
      .readonly(),
    summaryMode: SummaryModeSchema,
  })
  .readonly();

export type LocalSourceInput = z.infer<typeof LocalSourceInputSchema>;

export type LocalSourceIntakeDependencies = Readonly<{
  courses: CourseRepository;
  jobs: JobRepository;
  sourceBundles: SourceBundleRepository;
  stagingRoot: string;
  clock?: () => string;
  maxBatchBytes?: number;
}>;

type InspectedSource = Readonly<{
  fileName: string;
  filePath: string;
  maxBytes: number;
  mediaType: SourceMediaType;
  size: number;
}>;

type PreparedSource = InspectedSource & Readonly<{ sha256: string }>;

type FileIdentity = Readonly<{
  ctimeMs: number;
  dev: number | bigint;
  ino: number | bigint;
  mtimeMs: number;
  size: number;
}>;

type OwnedStagingFile = Readonly<{
  filePath: string;
  identity: FileIdentity;
  sha256: string;
}>;

export type OwnedStagingBundle = Readonly<{
  directoryIdentity: FileIdentity;
  directoryPath: string;
  files: readonly OwnedStagingFile[];
  jobId: string;
  stagingRoot: string;
}>;

export type StagedBundleSource = Readonly<{
  sha256: string;
  sizeBytes: number;
  stagedPath: string;
}>;

const invalidSource = (): AppError =>
  new AppError('SOURCE_COPY_FAILED', APP_ERROR_MESSAGES.SOURCE_COPY_FAILED);

const duplicateJob = (): AppError =>
  new AppError('DUPLICATE_JOB', APP_ERROR_MESSAGES.DUPLICATE_JOB);

const toIdentity = (stats: Stats): FileIdentity =>
  Object.freeze({
    ctimeMs: stats.ctimeMs,
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  });

const hasIdentity = (stats: Stats, identity: FileIdentity): boolean =>
  stats.dev === identity.dev &&
  stats.ino === identity.ino &&
  stats.size === identity.size &&
  stats.mtimeMs === identity.mtimeMs &&
  stats.ctimeMs === identity.ctimeMs;

const samePath = (left: string, right: string): boolean =>
  resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US');

const assertRealContainedDirectory = async (
  stagingRoot: string,
  jobId: string,
  directoryPath: string,
): Promise<void> => {
  const connection = await createSafeRootConnection(stagingRoot);
  const expectedDirectory = resolveManagedPath(connection.managedRoot, jobId);
  if (!samePath(expectedDirectory, directoryPath)) {
    throw invalidSource();
  }
  const realDirectory = resolve(await realpath(directoryPath));
  const containment = relative(connection.realManagedRoot, realDirectory);
  if (
    containment === '' ||
    containment === '..' ||
    containment.startsWith(`..${sep}`) ||
    isAbsolute(containment) ||
    !samePath(realDirectory, expectedDirectory)
  ) {
    throw invalidSource();
  }
};

const inspectOwnedFile = async (source: StagedBundleSource): Promise<OwnedStagingFile> => {
  assertNoReparsePoints(source.stagedPath);
  const stats = await lstat(source.stagedPath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size !== source.sizeBytes ||
    (await sha256File(source.stagedPath, { maxBytes: source.sizeBytes })) !== source.sha256
  ) {
    throw invalidSource();
  }
  return Object.freeze({
    filePath: source.stagedPath,
    identity: toIdentity(stats),
    sha256: source.sha256,
  });
};

export const captureOwnedStagingBundle = async (
  stagingRoot: string,
  jobId: string,
  directoryPath: string,
  sources: readonly StagedBundleSource[],
): Promise<OwnedStagingBundle> => {
  await assertRealContainedDirectory(stagingRoot, jobId, directoryPath);
  assertNoReparsePoints(directoryPath);
  const directoryStats = await lstat(directoryPath);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw invalidSource();
  }
  const expectedNames = new Set(sources.map((source) => basename(source.stagedPath)));
  const entries = await readdir(directoryPath, { withFileTypes: true });
  if (
    expectedNames.size !== sources.length ||
    entries.length !== sources.length ||
    entries.some(
      (entry) => !expectedNames.has(entry.name) || !entry.isFile() || entry.isSymbolicLink(),
    )
  ) {
    throw invalidSource();
  }
  for (const source of sources) {
    if (
      !samePath(resolveManagedPath(directoryPath, basename(source.stagedPath)), source.stagedPath)
    ) {
      throw invalidSource();
    }
  }
  const files = Object.freeze(await Promise.all(sources.map(inspectOwnedFile)));
  return Object.freeze({
    directoryIdentity: toIdentity(directoryStats),
    directoryPath,
    files,
    jobId,
    stagingRoot,
  });
};

export const cleanupOwnedStagingBundle = async (owned: OwnedStagingBundle): Promise<void> => {
  await assertRealContainedDirectory(owned.stagingRoot, owned.jobId, owned.directoryPath);
  assertNoReparsePoints(owned.directoryPath);
  const directoryStats = await lstat(owned.directoryPath);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    !hasIdentity(directoryStats, owned.directoryIdentity)
  ) {
    throw invalidSource();
  }
  const expectedNames = new Set(owned.files.map((file) => basename(file.filePath)));
  const entries = await readdir(owned.directoryPath, { withFileTypes: true });
  if (
    entries.length !== owned.files.length ||
    entries.some(
      (entry) => !expectedNames.has(entry.name) || !entry.isFile() || entry.isSymbolicLink(),
    )
  ) {
    throw invalidSource();
  }
  for (const file of owned.files) {
    assertNoReparsePoints(file.filePath);
    const stats = await lstat(file.filePath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      !hasIdentity(stats, file.identity) ||
      (await sha256File(file.filePath, { maxBytes: file.identity.size })) !== file.sha256
    ) {
      throw invalidSource();
    }
  }
  for (const file of owned.files) {
    await unlink(file.filePath);
  }
  if ((await readdir(owned.directoryPath)).length !== 0) {
    throw invalidSource();
  }
  await rmdir(owned.directoryPath);
};

const mediaTypeForFileName = (fileName: string): SourceMediaType => {
  for (const mediaType of SOURCE_MEDIA_TYPES) {
    if (QueueSourceSchema.safeParse({ fileName, mediaType }).success) {
      return mediaType;
    }
  }
  throw invalidSource();
};

const sourceLimit = (mediaType: SourceMediaType): number =>
  mediaType === 'audio' || mediaType === 'video'
    ? MAX_AUDIO_VIDEO_SOURCE_BYTES
    : MAX_DOCUMENT_IMAGE_SOURCE_BYTES;

const deterministicUuid = (seed: string): string => {
  const bytes = Buffer.from(
    createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32),
    'hex',
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const stagingFileName = (source: PreparedSource, ordinal: number): string =>
  ordinal === 0
    ? `source${extensionOf(source.fileName)}`
    : `source-${ordinal.toString().padStart(2, '0')}${extensionOf(source.fileName)}`;

export class LocalSourceIntake {
  readonly #clock: () => string;
  readonly #courses: CourseRepository;
  readonly #jobs: JobRepository;
  readonly #maxBatchBytes: number;
  readonly #sourceBundles: SourceBundleRepository;
  readonly #stagingRoot: string;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(dependencies: LocalSourceIntakeDependencies) {
    this.#courses = dependencies.courses;
    this.#jobs = dependencies.jobs;
    this.#sourceBundles = dependencies.sourceBundles;
    this.#stagingRoot = dependencies.stagingRoot;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
    const maxBatchBytes = z
      .int()
      .positive()
      .max(MAX_BUNDLE_BYTES)
      .safeParse(dependencies.maxBatchBytes ?? MAX_BUNDLE_BYTES);
    if (!maxBatchBytes.success) {
      throw new TypeError('INVALID_LOCAL_BATCH_LIMIT');
    }
    this.#maxBatchBytes = maxBatchBytes.data;
  }

  enqueue(input: LocalSourceInput): Promise<readonly Job[]> {
    return this.#runExclusive(() => this.#enqueue(input));
  }

  async #enqueue(input: LocalSourceInput): Promise<readonly Job[]> {
    const parsed = LocalSourceInputSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidSource();
    }
    const course = this.#courses.get(parsed.data.courseId);
    if (course === null || course.archived) {
      throw new AppError('COURSE_NOT_FOUND', APP_ERROR_MESSAGES.COURSE_NOT_FOUND);
    }

    let inspected: readonly InspectedSource[] = Object.freeze([]);
    let totalBytes = 0;
    const normalizedPaths = new Set<string>();
    for (const filePath of parsed.data.filePaths) {
      const normalizedPath = resolve(filePath).toLocaleLowerCase('en-US');
      if (normalizedPaths.has(normalizedPath)) {
        throw invalidSource();
      }
      normalizedPaths.add(normalizedPath);
      const source = await this.#inspect(filePath);
      totalBytes += source.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.#maxBatchBytes) {
        throw new AppError('SOURCE_TOO_LARGE', APP_ERROR_MESSAGES.SOURCE_TOO_LARGE);
      }
      inspected = Object.freeze([...inspected, source]);
    }

    let prepared: readonly PreparedSource[] = Object.freeze([]);
    let hashedBytes = 0;
    for (const source of inspected) {
      prepared = Object.freeze([
        ...prepared,
        await this.#prepare(source, Math.max(1, this.#maxBatchBytes - hashedBytes)),
      ]);
      hashedBytes += source.size;
    }
    const sourceHashes = prepared.map((source) => source.sha256);
    if (new Set(sourceHashes).size !== sourceHashes.length) {
      throw invalidSource();
    }
    const fingerprint =
      sourceHashes.length === 1
        ? createJobFingerprint(course.id, sourceHashes[0] ?? '')
        : createBundleFingerprint(course.id, sourceHashes);
    const jobId = deterministicUuid(`local-job:${fingerprint}`);
    if (
      this.#jobs.findByFingerprint(course.id, fingerprint) !== null ||
      this.#jobs.get(jobId) !== null
    ) {
      throw duplicateJob();
    }

    let stagingConnection: Awaited<ReturnType<typeof createSafeRootConnection>>;
    try {
      stagingConnection = await createSafeRootConnection(this.#stagingRoot);
    } catch {
      throw invalidSource();
    }
    const stagingDirectoryPath = resolveManagedPath(stagingConnection.managedRoot, jobId);
    try {
      await mkdir(stagingDirectoryPath);
    } catch {
      throw invalidSource();
    }

    const stagingVault = new VaultWriter(stagingConnection);
    const createdAt = IsoDateTimeSchema.parse(this.#clock());
    const bundleId = deterministicUuid(`local-bundle:${fingerprint}`);
    let stagedSources: readonly StagedBundleSource[] = Object.freeze([]);
    let records: readonly SourceRecord[] = Object.freeze([]);
    let ownership: OwnedStagingBundle | undefined;
    try {
      for (const [ordinal, source] of prepared.entries()) {
        const relativePath = `${jobId}/${stagingFileName(source, ordinal)}`;
        const stagedRelativePath = await stagingVault.copyAttachment({
          sourcePath: source.filePath,
          relativePath,
          expectedSha256: source.sha256,
          maxBytes: source.size,
        });
        if (stagedRelativePath !== relativePath) {
          throw invalidSource();
        }
        const stagedPath = join(stagingConnection.managedRoot, ...stagedRelativePath.split('/'));
        const stagedSource = Object.freeze({
          sha256: source.sha256,
          sizeBytes: source.size,
          stagedPath,
        });
        stagedSources = Object.freeze([...stagedSources, stagedSource]);
        records = Object.freeze([
          ...records,
          SourceRecordSchema.parse({
            id: deterministicUuid(`local-source:${fingerprint}:${ordinal}:${source.sha256}`),
            bundleId,
            ordinal,
            originalFileName: source.fileName,
            mediaType: source.mediaType,
            stagedPath,
            sha256: source.sha256,
            sizeBytes: source.size,
          }),
        ]);
      }
      ownership = await captureOwnedStagingBundle(
        this.#stagingRoot,
        jobId,
        stagingDirectoryPath,
        stagedSources,
      );
    } catch (error) {
      try {
        ownership ??= await captureOwnedStagingBundle(
          this.#stagingRoot,
          jobId,
          stagingDirectoryPath,
          stagedSources,
        );
        await cleanupOwnedStagingBundle(ownership);
      } catch {
        throw invalidSource();
      }
      if (AppError.isTrusted(error)) {
        throw error;
      }
      throw invalidSource();
    }

    const primaryRecord = records[0];
    if (primaryRecord === undefined || ownership === undefined) {
      throw invalidSource();
    }
    const bundle: SourceBundle = SourceBundleSchema.parse({
      id: bundleId,
      jobId,
      manifestSha256: fingerprint,
      sourceCount: records.length,
      totalBytes,
      stagingDirectoryPath,
      createdAt,
    });
    const job = JobSchema.parse({
      id: jobId,
      courseId: course.id,
      sourceKind: 'local',
      sourceFileName: primaryRecord.originalFileName,
      sourceMediaType: primaryRecord.mediaType,
      summaryMode: parsed.data.summaryMode,
      stagedSourcePath: primaryRecord.stagedPath,
      queueItemPath: null,
      sourceSha256: primaryRecord.sha256,
      fingerprint,
      sourceBundleId: bundle.id,
      sourceCount: bundle.sourceCount,
      status: 'queued',
      lastSuccessfulStatus: 'queued',
      retryCount: 0,
      errorCode: null,
      cleanupWarningCode: null,
      attentionResolutionId: null,
      createdAt,
      updatedAt: createdAt,
      revision: 0,
    });
    try {
      return Object.freeze([this.#sourceBundles.insertJobWithBundle(job, bundle, records)]);
    } catch (error) {
      try {
        await cleanupOwnedStagingBundle(ownership);
      } catch {
        throw invalidSource();
      }
      throw error;
    }
  }

  async #inspect(filePath: string): Promise<InspectedSource> {
    const fileNameResult = SupportedSourceFileNameSchema.safeParse(basename(filePath));
    if (!fileNameResult.success) {
      throw invalidSource();
    }
    const mediaType = mediaTypeForFileName(fileNameResult.data);
    const maxBytes = sourceLimit(mediaType);
    try {
      assertNoReparsePoints(filePath);
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1) {
        throw invalidSource();
      }
      if (stats.size > maxBytes) {
        throw new AppError('SOURCE_TOO_LARGE', APP_ERROR_MESSAGES.SOURCE_TOO_LARGE);
      }
      return Object.freeze({
        fileName: fileNameResult.data,
        filePath,
        maxBytes,
        mediaType,
        size: stats.size,
      });
    } catch (error) {
      if (AppError.isTrusted(error)) {
        throw error;
      }
      throw new AppError('SOURCE_HASH_FAILED', APP_ERROR_MESSAGES.SOURCE_HASH_FAILED);
    }
  }

  async #prepare(source: InspectedSource, remainingBatchBytes: number): Promise<PreparedSource> {
    const sha256 = await sha256File(source.filePath, {
      maxBytes: Math.min(source.maxBytes, remainingBatchBytes),
    });
    try {
      assertNoReparsePoints(source.filePath);
      const after = await lstat(source.filePath);
      if (after.isFile() && !after.isSymbolicLink() && after.size === source.size) {
        return Object.freeze({ ...source, sha256 });
      }
    } catch (error) {
      if (AppError.isTrusted(error)) {
        throw error;
      }
    }
    throw new AppError('SOURCE_HASH_FAILED', APP_ERROR_MESSAGES.SOURCE_HASH_FAILED);
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
