import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createBundleFingerprint,
  createJobFingerprint,
  sha256File,
} from '../../core/jobs/fingerprint';
import { classifyFailure, resumeStatus, transitionJob } from '../../core/jobs/stateMachine';
import type { CourseProvisioner } from '../../core/ports/courseProvisioner';
import type { CourseRepository } from '../../core/ports/courseRepository';
import type { JobArtifactRepository } from '../../core/ports/jobArtifactRepository';
import type { JobRepository } from '../../core/ports/jobRepository';
import {
  type ProcessorPort,
  type ProcessorResult,
  ProcessorResultSchema,
} from '../../core/ports/processor';
import type { ClaimedSourceBundle, QueuePort } from '../../core/ports/queue';
import type { SourceBundleRepository } from '../../core/ports/sourceBundleRepository';
import type { VaultWriterPort } from '../../core/ports/vault';
import type { Course } from '../../shared/contracts/course';
import { type Job, JobSchema, type JobStatus } from '../../shared/contracts/job';
import { type JobArtifact, JobArtifactSchema } from '../../shared/contracts/jobArtifact';
import {
  type NormalizedSourceBundleManifest,
  PUBLIC_STATUS_MESSAGES,
  RejectionReceiptSchema,
  StatusReceiptSchema,
} from '../../shared/contracts/queue';
import {
  type SourceBundle,
  SourceBundleSchema,
  type SourceRecord,
  SourceRecordSchema,
} from '../../shared/contracts/sourceBundle';
import {
  APP_ERROR_MESSAGES,
  AppError,
  type AppErrorCode,
  toErrorEnvelope,
} from '../../shared/errors';
import {
  deterministicBundleId,
  upgradeLegacySourceBundle,
  usesLegacyStagingLayout,
} from './legacySourceBundle';
import { captureOwnedStagingBundle, cleanupOwnedStagingBundle } from './localSourceIntake';
import type { SourceArchiver } from './sourceArchiver';
import { StagingSourceCleaner, type StagingSourceCleanerPort } from './stagingSourceCleaner';

const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const MAX_READY_JOBS_PER_POLL = 5;
const MAX_RECOVERABLE_JOBS_PER_RUN = 5;
const MAX_CLEANUP_RETRIES_PER_POLL = 20;
const PERMANENT_COURSE_PROVISIONING_ERRORS: ReadonlySet<AppErrorCode> = new Set([
  'INVALID_COURSE',
  'DUPLICATE_COURSE',
  'COURSE_NOT_FOUND',
]);

export const RunSummarySchema = z
  .strictObject({
    completed: z.int().min(0),
    failed: z.int().min(0),
    duplicates: z.int().min(0),
  })
  .readonly();

export type RunSummary = z.infer<typeof RunSummarySchema>;

type CleanupAttempt = Readonly<{ kind: 'cleaned' }> | Readonly<{ error: unknown; kind: 'failed' }>;

export type JobRunnerDependencies = Readonly<{
  artifacts: JobArtifactRepository;
  courseProvisioner: CourseProvisioner;
  courses: CourseRepository;
  jobs: JobRepository;
  sourceBundles: SourceBundleRepository;
  queue: QueuePort;
  vault: VaultWriterPort;
  processor: ProcessorPort;
  sourceArchiver: SourceArchiver;
  stagingRoot: string;
  stagingCleaner?: StagingSourceCleanerPort;
  clock?: () => string;
  onOperationalError?: (error: unknown) => void;
}>;

const normalizeError = (error: unknown): AppError =>
  AppError.isTrusted(error)
    ? error
    : new AppError('UNEXPECTED_ERROR', APP_ERROR_MESSAGES.UNEXPECTED_ERROR);

const recordingNotePath = (job: Job, course: Course): string =>
  `과목/${course.folderName}/녹음/${job.id}.md`;

const renderRecordingNote = (
  job: Job,
  result: ProcessorResult,
  archive: JobArtifact,
): string => `---
studyapp-note-version: 1
studyapp-note-kind: "recording"
course_id: ${JSON.stringify(job.courseId)}
job_id: ${JSON.stringify(job.id)}
source_id: ${JSON.stringify(job.id)}
source_kind: ${JSON.stringify(job.sourceKind)}
source_sha256: ${JSON.stringify(job.sourceSha256)}
source_fingerprint: ${JSON.stringify(job.fingerprint)}
source_file_name: ${JSON.stringify(job.sourceFileName)}
source_media_type: ${JSON.stringify(job.sourceMediaType)}
summary_mode: ${JSON.stringify(job.summaryMode)}
source_archive_path: ${JSON.stringify(archive.relativePath)}
source_archive_sha256: ${JSON.stringify(archive.sha256)}
created_at: ${JSON.stringify(job.createdAt)}
app_generated_base_hash: ${JSON.stringify(result.baseSha256)}
---

${result.markdownBody}`;

type ClaimedIntake = Readonly<{
  bundle: SourceBundle;
  job: Job;
  records: readonly SourceRecord[];
}>;

const initialClaimedIntake = (claimed: ClaimedSourceBundle): ClaimedIntake => {
  const sourceHashes = claimed.sources.map((source) => source.sha256);
  const firstSource = claimed.sources[0];
  if (firstSource === undefined) {
    throw new AppError('INVALID_QUEUE_ITEM', APP_ERROR_MESSAGES.INVALID_QUEUE_ITEM);
  }
  const fingerprint =
    sourceHashes.length === 1
      ? createJobFingerprint(claimed.manifest.courseId, firstSource.sha256)
      : createBundleFingerprint(claimed.manifest.courseId, sourceHashes);
  const bundleId = deterministicBundleId(claimed.manifest.jobId, fingerprint);
  const records = Object.freeze(
    claimed.sources.map((source) =>
      SourceRecordSchema.parse({
        id: source.id,
        bundleId,
        ordinal: source.ordinal,
        originalFileName: source.originalFileName,
        mediaType: source.mediaType,
        stagedPath: source.stagedPath,
        sha256: source.sha256,
        sizeBytes: source.sizeBytes,
      }),
    ),
  );
  const bundle = SourceBundleSchema.parse({
    id: bundleId,
    jobId: claimed.manifest.jobId,
    manifestSha256: createHash('sha256')
      .update(
        JSON.stringify({
          ...claimed.manifest,
          sources: records.map((record) => ({
            id: record.id,
            fileName: record.originalFileName,
            mediaType: record.mediaType,
            sizeBytes: record.sizeBytes,
            sha256: record.sha256,
          })),
        }),
        'utf8',
      )
      .digest('hex'),
    sourceCount: records.length,
    totalBytes: records.reduce((sum, record) => sum + record.sizeBytes, 0),
    stagingDirectoryPath: claimed.stagingDirectoryPath,
    createdAt: claimed.manifest.createdAt,
  });
  const job = JobSchema.parse({
    id: claimed.manifest.jobId,
    courseId: claimed.manifest.courseId,
    sourceKind: claimed.sourceKind,
    sourceFileName: firstSource.originalFileName,
    sourceMediaType: firstSource.mediaType,
    summaryMode: claimed.manifest.summaryMode,
    stagedSourcePath: firstSource.stagedPath,
    queueItemPath: claimed.queueItemPath,
    sourceSha256: firstSource.sha256,
    fingerprint,
    sourceBundleId: bundle.id,
    sourceCount: bundle.sourceCount,
    status: 'source_ready',
    lastSuccessfulStatus: 'source_ready',
    retryCount: 0,
    errorCode: null,
    cleanupWarningCode: null,
    attentionResolutionId: null,
    createdAt: claimed.manifest.createdAt,
    updatedAt: claimed.manifest.createdAt,
    revision: 0,
  });
  return Object.freeze({ bundle, job, records });
};

export class JobRunner {
  readonly #artifacts: JobArtifactRepository;
  readonly #clock: () => string;
  readonly #courseProvisioner: CourseProvisioner;
  readonly #courses: CourseRepository;
  readonly #jobs: JobRepository;
  readonly #onOperationalError: (error: unknown) => void;
  readonly #processor: ProcessorPort;
  readonly #queue: QueuePort;
  readonly #sourceArchiver: SourceArchiver;
  readonly #sourceBundles: SourceBundleRepository;
  readonly #stagingRoot: string;
  readonly #stagingCleaner: StagingSourceCleanerPort;
  readonly #vault: VaultWriterPort;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(dependencies: JobRunnerDependencies) {
    this.#artifacts = dependencies.artifacts;
    this.#courseProvisioner = dependencies.courseProvisioner;
    this.#courses = dependencies.courses;
    this.#jobs = dependencies.jobs;
    this.#sourceBundles = dependencies.sourceBundles;
    this.#queue = dependencies.queue;
    this.#vault = dependencies.vault;
    this.#processor = dependencies.processor;
    this.#sourceArchiver = dependencies.sourceArchiver;
    this.#stagingRoot = dependencies.stagingRoot;
    this.#stagingCleaner =
      dependencies.stagingCleaner ?? new StagingSourceCleaner(dependencies.stagingRoot);
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
    this.#onOperationalError = dependencies.onOperationalError ?? (() => undefined);
  }

  pollOnce(): Promise<RunSummary> {
    return this.#runExclusive(() => this.#pollOnce());
  }

  resumeInterrupted(): Promise<RunSummary> {
    return this.#runExclusive(() => this.#resumeInterrupted());
  }

  async #pollOnce(): Promise<RunSummary> {
    await this.#retryCleanupWarnings();
    let duplicates = 0;
    let intakeFailures = 0;
    const ready = (await this.#queue.scanReady()).slice(0, MAX_READY_JOBS_PER_POLL);
    for (const item of ready) {
      try {
        const existingById = this.#jobs.get(item.jobId);
        if (existingById !== null) {
          if (existingById.status === 'completed') {
            await this.#ensureCompletedReceipt(existingById);
            await this.#cleanupCompleted(existingById);
          }
          continue;
        }
        const claimed: ClaimedSourceBundle = await this.#queue.claim(item, this.#stagingRoot);
        const intake = initialClaimedIntake(claimed);
        const candidate = intake.job;
        if (!(await this.#provisionClaimedCourse(claimed, candidate))) {
          intakeFailures += 1;
          continue;
        }
        const course = this.#courses.get(claimed.manifest.courseId);
        if (course === null || course.archived) {
          const error = new AppError('COURSE_NOT_FOUND', APP_ERROR_MESSAGES.COURSE_NOT_FOUND);
          await this.#cleanupClaimedStaging(claimed, candidate);
          await this.#rejectClaim(claimed.manifest, error);
          intakeFailures += 1;
          continue;
        }
        if (this.#jobs.findByFingerprint(candidate.courseId, candidate.fingerprint) !== null) {
          await this.#cleanupClaimedStaging(claimed, candidate);
          await this.#rejectClaim(
            claimed.manifest,
            new AppError('DUPLICATE_JOB', APP_ERROR_MESSAGES.DUPLICATE_JOB),
          );
          duplicates += 1;
          continue;
        }
        try {
          this.#sourceBundles.insertJobWithBundle(candidate, intake.bundle, intake.records);
        } catch (error) {
          try {
            await this.#cleanupClaimedStaging(claimed, candidate);
          } catch (cleanupError) {
            this.#onOperationalError(cleanupError);
          }
          throw error;
        }
      } catch (error) {
        this.#onOperationalError(error);
        intakeFailures += 1;
      }
    }
    return this.#runRecoverable(duplicates, intakeFailures);
  }

  async #provisionClaimedCourse(claimed: ClaimedSourceBundle, candidate: Job): Promise<boolean> {
    if (claimed.courseProvisioning === null) {
      return true;
    }
    try {
      await this.#courseProvisioner.provision(claimed.courseProvisioning);
      return true;
    } catch (error) {
      const normalized = normalizeError(error);
      const cleanup = await this.#tryCleanupClaimedStaging(claimed, candidate);
      if (cleanup.kind === 'failed') {
        this.#onOperationalError(error);
        this.#onOperationalError(cleanup.error);
        await this.#writeClaimFailureReceipt(claimed.manifest, normalized);
        return false;
      }
      if (AppError.isTrusted(error) && PERMANENT_COURSE_PROVISIONING_ERRORS.has(error.code)) {
        await this.#rejectClaim(claimed.manifest, error);
      } else {
        await this.#writeClaimFailureReceipt(claimed.manifest, normalized);
        this.#onOperationalError(error);
      }
      return false;
    }
  }

  async #tryCleanupClaimedStaging(claimed: ClaimedSourceBundle, job: Job): Promise<CleanupAttempt> {
    try {
      await this.#cleanupClaimedStaging(claimed, job);
      return Object.freeze({ kind: 'cleaned' });
    } catch (error) {
      return Object.freeze({ error, kind: 'failed' });
    }
  }

  async #cleanupClaimedStaging(claimed: ClaimedSourceBundle, job: Job): Promise<void> {
    if (claimed.manifest.protocolVersion === 1) {
      await this.#stagingCleaner.cleanup(job);
      return;
    }
    const owned = await captureOwnedStagingBundle(
      this.#stagingRoot,
      job.id,
      claimed.stagingDirectoryPath,
      claimed.sources.map((source) => ({
        stagedPath: source.stagedPath,
        sha256: source.sha256,
        sizeBytes: source.sizeBytes,
      })),
    );
    await cleanupOwnedStagingBundle(owned);
  }

  async #resumeInterrupted(): Promise<RunSummary> {
    await this.#retryCleanupWarnings();
    return this.#runRecoverable(0, 0);
  }

  async #runRecoverable(duplicates: number, initialFailures: number): Promise<RunSummary> {
    let completed = 0;
    let failed = initialFailures;
    for (const recoverable of this.#jobs.listRecoverable().slice(0, MAX_RECOVERABLE_JOBS_PER_RUN)) {
      const result = await this.#runJob(recoverable);
      if (result === 'completed') {
        completed += 1;
      } else {
        failed += 1;
      }
    }
    return RunSummarySchema.parse({ completed, failed, duplicates });
  }

  async #runJob(job: Job): Promise<'completed' | 'failed'> {
    let current = job;
    try {
      current = this.#prepareRecovery(current);
      current = await upgradeLegacySourceBundle(current, this.#stagingRoot, this.#sourceBundles);
      let processed: ProcessorResult | undefined;
      while (current.status !== 'completed') {
        switch (current.status) {
          case 'queued':
            current = this.#transition(current, 'receiving');
            await this.#writeProcessingReceipt(current);
            break;
          case 'receiving':
            await this.#assertStagedSource(current);
            current = this.#transition(current, 'source_ready');
            break;
          case 'source_ready':
            await this.#assertStagedSource(current);
            current = this.#transition(current, 'transcribing_or_extracting');
            await this.#writeProcessingReceipt(current);
            break;
          case 'transcribing_or_extracting':
            processed = await this.#process(current);
            current = this.#transition(current, 'structuring');
            break;
          case 'structuring':
            current = this.#transition(current, 'generating');
            break;
          case 'generating':
            current = this.#transition(current, 'verifying');
            break;
          case 'verifying':
            current = this.#transition(current, 'writing');
            break;
          case 'writing':
            processed ??= await this.#process(current);
            current = await this.#finalize(current, processed);
            break;
          case 'retryable_failed':
          case 'needs_attention':
            throw new AppError('INVALID_JOB_TRANSITION', APP_ERROR_MESSAGES.INVALID_JOB_TRANSITION);
        }
      }
      return 'completed';
    } catch (error) {
      const normalized = normalizeError(error);
      try {
        const failedStatus = classifyFailure(normalized, current.retryCount);
        const failedJob = transitionJob(
          current,
          failedStatus,
          this.#timestampAfter(current.updatedAt),
          { failure: normalized },
        );
        current = this.#jobs.update(failedJob, current.revision);
        await this.#writeFailureReceipt(current, normalized);
      } catch (failureError) {
        this.#onOperationalError(failureError);
      }
      return 'failed';
    }
  }

  #prepareRecovery(job: Job): Job {
    if (job.status === 'retryable_failed') {
      const recovered = transitionJob(
        job,
        job.lastSuccessfulStatus,
        this.#timestampAfter(job.updatedAt),
      );
      return this.#jobs.update(recovered, job.revision);
    }
    if (job.status === 'needs_attention' || job.status === 'completed') {
      return job;
    }
    const checkpoint = resumeStatus(job.status);
    if (checkpoint === job.status) {
      return job;
    }
    const recovered = JobSchema.parse({
      ...job,
      status: checkpoint,
      lastSuccessfulStatus: checkpoint,
      updatedAt: this.#timestampAfter(job.updatedAt),
      revision: job.revision + 1,
    });
    return this.#jobs.update(recovered, job.revision);
  }

  #transition(job: Job, status: JobStatus): Job {
    const transitioned = transitionJob(job, status, this.#timestampAfter(job.updatedAt));
    return this.#jobs.update(transitioned, job.revision);
  }

  async #process(job: Job): Promise<ProcessorResult> {
    return ProcessorResultSchema.parse(
      await this.#processor.process({
        jobId: job.id,
        courseId: job.courseId,
        sourceFileName: job.sourceFileName,
        sourceMediaType: job.sourceMediaType,
        sourceSha256: job.sourceSha256,
        summaryMode: job.summaryMode,
      }),
    );
  }

  async #finalize(job: Job, processed: ProcessorResult): Promise<Job> {
    const course = this.#requireCourse(job.courseId);
    const archive = await this.#sourceArchiver.archive(job, course);
    await this.#writeRecordingNote(job, course, processed, archive);
    await this.#writeCompletedReceipt(job);
    const completed = this.#completeWithCleanupPending(job);
    await this.#cleanupCompleted(completed);
    return this.#jobs.get(completed.id) ?? completed;
  }

  async #writeRecordingNote(
    job: Job,
    course: Course,
    processed: ProcessorResult,
    archive: JobArtifact,
  ): Promise<JobArtifact> {
    const existingArtifact = this.#artifacts.get(job.id, 'recording_note');
    if (existingArtifact !== null) {
      const existing = await this.#vault.readMarkdown(existingArtifact.relativePath);
      if (existing === null || existing.sha256 !== existingArtifact.sha256) {
        throw new AppError('STALE_WRITE', APP_ERROR_MESSAGES.STALE_WRITE);
      }
      return existingArtifact;
    }

    const content = renderRecordingNote(job, processed, archive);
    const expectedSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    const desiredPath = recordingNotePath(job, course);
    const current = await this.#vault.readMarkdown(desiredPath);
    let relativePath = desiredPath;
    let sha256 = expectedSha256;
    if (current?.sha256 !== expectedSha256) {
      const generatedPath = `과목/${course.folderName}/녹음/${job.id}.generated-${expectedSha256.slice(0, 12)}.md`;
      const generated = await this.#vault.readMarkdown(generatedPath);
      if (generated?.sha256 === expectedSha256) {
        relativePath = generated.relativePath;
        sha256 = generated.sha256;
      } else if (generated !== null) {
        throw new AppError('STALE_WRITE', APP_ERROR_MESSAGES.STALE_WRITE);
      } else {
        const selectedPath = current === null ? desiredPath : generatedPath;
        const written = await this.#vault.writeMarkdown({
          relativePath: selectedPath,
          content,
          expectedBaseHash: null,
        });
        if (written.kind !== 'written') {
          throw new AppError('STALE_WRITE', APP_ERROR_MESSAGES.STALE_WRITE);
        }
        relativePath = written.relativePath;
        sha256 = written.sha256;
      }
    }
    return this.#artifacts.insert(
      JobArtifactSchema.parse({
        jobId: job.id,
        kind: 'recording_note',
        relativePath,
        sha256,
        createdAt: this.#now(),
      }),
    );
  }

  async #assertStagedSource(job: Job): Promise<void> {
    if ((await sha256File(job.stagedSourcePath)) !== job.sourceSha256) {
      throw new AppError('SOURCE_HASH_MISMATCH', APP_ERROR_MESSAGES.SOURCE_HASH_MISMATCH);
    }
  }

  #requireCourse(courseId: string): Course {
    const course = this.#courses.get(courseId);
    if (course === null) {
      throw new AppError('COURSE_NOT_FOUND', APP_ERROR_MESSAGES.COURSE_NOT_FOUND);
    }
    return course;
  }

  async #rejectClaim(manifest: NormalizedSourceBundleManifest, error: AppError): Promise<void> {
    const envelope = toErrorEnvelope(error);
    const updatedAt = this.#now();
    await this.#queue.writeReceipt(
      StatusReceiptSchema.parse({
        jobId: manifest.jobId,
        courseId: manifest.courseId,
        status: 'failed',
        displayMessage: envelope.message,
        updatedAt,
        errorCode: envelope.code,
      }),
    );
    await this.#queue.writeRejection(
      RejectionReceiptSchema.parse({
        jobId: manifest.jobId,
        status: 'failed',
        displayMessage: envelope.message,
        updatedAt,
        errorCode: envelope.code,
      }),
    );
  }

  async #writeProcessingReceipt(job: Job): Promise<void> {
    if (job.sourceKind === 'local') {
      return;
    }
    await this.#queue.writeReceipt(
      StatusReceiptSchema.parse({
        jobId: job.id,
        courseId: job.courseId,
        status: 'processing',
        displayMessage: PUBLIC_STATUS_MESSAGES.processing,
        updatedAt: this.#now(),
      }),
    );
  }

  async #writeCompletedReceipt(job: Job): Promise<void> {
    if (job.sourceKind === 'local') {
      return;
    }
    await this.#queue.writeReceipt(
      StatusReceiptSchema.parse({
        jobId: job.id,
        courseId: job.courseId,
        status: 'completed',
        displayMessage: PUBLIC_STATUS_MESSAGES.completed,
        updatedAt: this.#now(),
      }),
    );
  }

  async #ensureCompletedReceipt(job: Job): Promise<void> {
    await this.#writeCompletedReceipt(job);
  }

  async #writeFailureReceipt(job: Job, error: AppError): Promise<void> {
    if (job.sourceKind === 'local') {
      return;
    }
    const envelope = toErrorEnvelope(error);
    await this.#queue.writeReceipt(
      StatusReceiptSchema.parse({
        jobId: job.id,
        courseId: job.courseId,
        status: 'failed',
        displayMessage: envelope.message,
        updatedAt: this.#now(),
        errorCode: envelope.code,
      }),
    );
  }

  async #writeClaimFailureReceipt(
    manifest: NormalizedSourceBundleManifest,
    error: AppError,
  ): Promise<void> {
    const envelope = toErrorEnvelope(error);
    await this.#queue.writeReceipt(
      StatusReceiptSchema.parse({
        jobId: manifest.jobId,
        courseId: manifest.courseId,
        status: 'failed',
        displayMessage: envelope.message,
        updatedAt: this.#now(),
        errorCode: envelope.code,
      }),
    );
  }

  async #cleanupCompleted(job: Job): Promise<void> {
    let stagingFailed = false;
    let queueFailed = false;
    if (job.sourceBundleId === null || usesLegacyStagingLayout(job, this.#stagingRoot)) {
      try {
        await this.#stagingCleaner.cleanup(job);
      } catch (error) {
        this.#onOperationalError(error);
        stagingFailed = true;
      }
    }
    if (job.sourceKind !== 'local') {
      try {
        await this.#queue.removeCompleted(job.id, job.sourceKind);
      } catch (error) {
        this.#onOperationalError(error);
        queueFailed = true;
      }
    }
    const cleanupWarningCode = stagingFailed
      ? queueFailed
        ? 'STAGING_AND_QUEUE_CLEANUP_FAILED'
        : 'STAGING_CLEANUP_FAILED'
      : queueFailed
        ? 'QUEUE_CLEANUP_FAILED'
        : null;
    try {
      const current = this.#jobs.get(job.id) ?? job;
      if (current.cleanupWarningCode !== cleanupWarningCode) {
        this.#updateCleanupWarning(current, cleanupWarningCode);
      }
    } catch (error) {
      this.#onOperationalError(error);
    }
  }

  async #retryCleanupWarnings(): Promise<void> {
    const pending = this.#jobs
      .list()
      .filter((job) => job.status === 'completed' && job.cleanupWarningCode !== null)
      .slice(0, MAX_CLEANUP_RETRIES_PER_POLL);
    for (const job of pending) {
      await this.#cleanupCompleted(job);
    }
  }

  #completeWithCleanupPending(job: Job): Job {
    const transitioned = transitionJob(job, 'completed', this.#timestampAfter(job.updatedAt));
    const pending = JobSchema.parse({
      ...transitioned,
      cleanupWarningCode: 'CLEANUP_PENDING',
    });
    return this.#jobs.update(pending, job.revision);
  }

  #updateCleanupWarning(job: Job, cleanupWarningCode: string | null): Job {
    const updated = JobSchema.parse({
      ...job,
      cleanupWarningCode,
      updatedAt: this.#timestampAfter(job.updatedAt),
      revision: job.revision + 1,
    });
    return this.#jobs.update(updated, job.revision);
  }

  #now(): string {
    return IsoDateTimeSchema.parse(this.#clock());
  }

  #timestampAfter(previous: string): string {
    const requested = Date.parse(this.#now());
    const minimum = Date.parse(previous) + 1;
    return new Date(Math.max(requested, minimum)).toISOString();
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
