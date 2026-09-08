import { randomUUID } from 'node:crypto';
import { CourseService } from '../application/courses/courseService';
import type { DiagnosticsService } from '../application/diagnostics/diagnosticsService';
import { JobRunner } from '../application/jobs/jobRunner';
import { type LocalSourceInput, LocalSourceIntake } from '../application/jobs/localSourceIntake';
import { SourceArchiver } from '../application/jobs/sourceArchiver';
import {
  VaultIndexRebuilder,
  type VaultRecoveryIssue,
} from '../application/jobs/vaultIndexRebuilder';
import { transitionJob } from '../core/jobs/stateMachine';
import type { ProcessorPort } from '../core/ports/processor';
import type { VaultConnection } from '../core/ports/vault';
import type { SqliteRepositories } from '../infrastructure/db/sqliteDatabase';
import { ICloudQueue } from '../infrastructure/queue/icloudQueue';
import { JsonCourseCatalog } from '../infrastructure/queue/jsonCourseCatalog';
import { connectQueueRoot, ensureQueueLayout } from '../infrastructure/queue/queueLayout';
import { VaultService } from '../infrastructure/vault/vaultService';
import { VaultWriter } from '../infrastructure/vault/vaultWriter';
import type { CourseInput, CoursePatch } from '../shared/contracts/course';
import { type BootstrapState, BootstrapStateSchema } from '../shared/contracts/ipc';
import { type Job, toPublicQueueStatus } from '../shared/contracts/job';
import { type AppSettings, AppSettingsSchema } from '../shared/contracts/settings';
import { APP_ERROR_MESSAGES, AppError, toErrorEnvelope } from '../shared/errors';

const DEFAULT_POLL_INTERVAL_MS = 1_250;

type ProcessingRuntime = Readonly<{
  connection: VaultConnection;
  courseService: CourseService;
  localIntake: LocalSourceIntake;
  rebuilder: VaultIndexRebuilder;
  runner: JobRunner;
}>;

export type FoundationApplicationDependencies = Readonly<{
  repositories: SqliteRepositories;
  stagingRoot: string;
  processor: ProcessorPort;
  pollQuestionInboxes?(): Promise<void>;
  validateStorageRoots(roots: Pick<AppSettings, 'vaultPath' | 'icloudQueuePath'>): void;
  diagnostics: Pick<DiagnosticsService, 'export'>;
  setAutoStart(enabled: boolean): void | Promise<void>;
  onStateChanged(state: BootstrapState): void;
  onOperationalError?(error: unknown): void;
  clock?: () => string;
  idGenerator?: () => string;
  pollIntervalMs?: number;
}>;

const missingRuntime = (): AppError =>
  new AppError('VAULT_CONNECTION_FAILED', APP_ERROR_MESSAGES.VAULT_CONNECTION_FAILED);

const invalidTransition = (): AppError =>
  new AppError('INVALID_JOB_TRANSITION', APP_ERROR_MESSAGES.INVALID_JOB_TRANSITION);

const timestampAfter = (previous: string, requested: string): string =>
  new Date(Math.max(Date.parse(requested), Date.parse(previous) + 1)).toISOString();

const jobError = (job: Job) =>
  job.errorCode === null
    ? null
    : toErrorEnvelope(new AppError(job.errorCode, APP_ERROR_MESSAGES[job.errorCode]));

export class FoundationApplication {
  readonly #clock: () => string;
  readonly #dependencies: FoundationApplicationDependencies;
  readonly #idGenerator: () => string;
  readonly #pollIntervalMs: number;
  #operationTail: Promise<void> = Promise.resolve();
  #polling = false;
  #pollTimer: NodeJS.Timeout | undefined;
  #recoveryIssues: readonly VaultRecoveryIssue[] = Object.freeze([]);
  #runtime: ProcessingRuntime | undefined;

  constructor(dependencies: FoundationApplicationDependencies) {
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
    this.#pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 1_000) {
      throw new TypeError('INVALID_POLL_INTERVAL');
    }
  }

  initialize(): Promise<BootstrapState> {
    return this.#runExclusive(async () => {
      try {
        await this.#reconfigureRuntime();
      } catch (error) {
        this.#report(error);
      }
      const runtime = this.#runtime;
      if (runtime !== undefined) {
        try {
          await runtime.rebuilder.rebuild();
          this.#recoveryIssues = runtime.rebuilder.listRecoveryIssues();
        } catch (error) {
          this.#report(error);
        }
        try {
          await runtime.courseService.synchronize();
          await runtime.rebuilder.rebuild();
          this.#recoveryIssues = runtime.rebuilder.listRecoveryIssues();
        } catch (error) {
          this.#report(error);
        }
        if (!this.#settings().processingPaused) {
          try {
            await runtime.runner.resumeInterrupted();
            await runtime.runner.pollOnce();
          } catch (error) {
            this.#report(error);
          }
        }
      }
      await this.#pollQuestions();
      return this.#state();
    });
  }

  startPolling(): void {
    if (this.#polling) return;
    this.#polling = true;
    this.#schedulePoll();
  }

  stopPolling(): void {
    this.#polling = false;
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  async shutdown(): Promise<void> {
    this.stopPolling();
    await new Promise<void>((resolveDrain, rejectDrain) => {
      const timer = setTimeout(
        () =>
          rejectDrain(new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED)),
        15_000,
      );
      void this.#operationTail.then(resolveDrain, rejectDrain).finally(() => clearTimeout(timer));
    });
    this.#runtime = undefined;
  }

  getBootstrapState(): Promise<BootstrapState> {
    return this.#runExclusive(() => Promise.resolve(this.#state()));
  }

  chooseVault(path: string): Promise<BootstrapState> {
    return this.#runExclusive(async () => {
      this.#dependencies.validateStorageRoots({
        vaultPath: path,
        icloudQueuePath: this.#settings().icloudQueuePath,
      });
      const vaultService = new VaultService();
      try {
        await vaultService.connect({ path, mode: 'existing' });
      } catch {
        await vaultService.connect({ path, mode: 'create' });
      }
      this.#updateSettings({ vaultPath: path });
      await this.#reconfigureRuntime();
      await this.#runtime?.courseService.synchronize();
      return this.#stateAndEmit();
    });
  }

  chooseQueue(path: string): Promise<BootstrapState> {
    return this.#runExclusive(async () => {
      this.#dependencies.validateStorageRoots({
        vaultPath: this.#settings().vaultPath,
        icloudQueuePath: path,
      });
      const connection = await connectQueueRoot(path);
      await ensureQueueLayout(connection);
      this.#updateSettings({ icloudQueuePath: path });
      await this.#reconfigureRuntime();
      await this.#runtime?.courseService.synchronize();
      return this.#stateAndEmit();
    });
  }

  createCourse(input: CourseInput): Promise<BootstrapState> {
    return this.#runExclusive(async () => {
      await this.#requireRuntime().courseService.create(input);
      return this.#stateAndEmit();
    });
  }

  updateCourse(id: string, patch: CoursePatch): Promise<BootstrapState> {
    return this.#runExclusive(async () => {
      await this.#requireRuntime().courseService.update(id, patch);
      return this.#stateAndEmit();
    });
  }

  archiveCourse(id: string): Promise<BootstrapState> {
    return this.#runExclusive(async () => {
      await this.#requireRuntime().courseService.archive(id);
      return this.#stateAndEmit();
    });
  }

  restoreCourse(id: string): Promise<BootstrapState> {
    return this.#runExclusive(async () => {
      await this.#requireRuntime().courseService.restore(id);
      return this.#stateAndEmit();
    });
  }

  enqueueSources(input: LocalSourceInput): Promise<BootstrapState> {
    return this.#runExclusive(async () => {
      const runtime = this.#requireRuntime();
      await runtime.localIntake.enqueue(input);
      if (!this.#settings().processingPaused) await runtime.runner.resumeInterrupted();
      return this.#stateAndEmit();
    });
  }

  retryJob(id: string): Promise<BootstrapState> {
    return this.#runExclusive(async () => {
      const runtime = this.#requireRuntime();
      const job = this.#dependencies.repositories.jobs.get(id);
      if (job === null) throw invalidTransition();
      if (job.status === 'needs_attention') {
        const createdAt = timestampAfter(job.updatedAt, this.#clock());
        const queued = transitionJob(job, 'queued', createdAt, {
          attentionResolution: {
            id: this.#idGenerator(),
            jobId: job.id,
            failureRevision: job.revision,
            createdAt,
          },
        });
        this.#dependencies.repositories.jobs.update(queued, job.revision);
      } else if (job.status !== 'retryable_failed') {
        throw invalidTransition();
      }
      if (!this.#settings().processingPaused) await runtime.runner.resumeInterrupted();
      return this.#stateAndEmit();
    });
  }

  setAutoStart(enabled: boolean): Promise<BootstrapState> {
    return this.#runExclusive(async () => {
      await this.#dependencies.setAutoStart(enabled);
      return this.#stateAndEmit();
    });
  }

  exportDiagnostics(destination: string): Promise<void> {
    return this.#runExclusive(async () => {
      await this.#dependencies.diagnostics.export(destination);
    });
  }

  pollOnce(): Promise<BootstrapState> {
    return this.#runExclusive(async () => {
      if (!this.#settings().processingPaused) await this.#runtime?.runner.pollOnce();
      await this.#pollQuestions();
      return this.#stateAndEmit();
    });
  }

  async #pollQuestions(): Promise<void> {
    const settings = this.#settings();
    if (settings.processingPaused || settings.vaultPath === null) return;
    try {
      await this.#dependencies.pollQuestionInboxes?.();
    } catch (error) {
      this.#report(error);
    }
  }

  refreshState(): Promise<BootstrapState> {
    return this.#runExclusive(() => Promise.resolve(this.#stateAndEmit()));
  }

  async #reconfigureRuntime(): Promise<void> {
    this.#runtime = undefined;
    const settings = this.#settings();
    if (settings.vaultPath === null || settings.icloudQueuePath === null) {
      return;
    }
    const connection = await new VaultService().connect({
      path: settings.vaultPath,
      mode: 'existing',
    });
    const vault = new VaultWriter(connection);
    const catalog = new JsonCourseCatalog(this.#dependencies.repositories.settings);
    const courseService = new CourseService({
      repository: this.#dependencies.repositories.courses,
      vault,
      catalog,
      clock: this.#clock,
      idGenerator: this.#idGenerator,
    });
    const queue = new ICloudQueue(settings.icloudQueuePath);
    const sourceArchiver = new SourceArchiver({
      artifacts: this.#dependencies.repositories.artifacts,
      connection,
      vault,
      clock: this.#clock,
    });
    const runner = new JobRunner({
      artifacts: this.#dependencies.repositories.artifacts,
      courseProvisioner: courseService,
      courses: this.#dependencies.repositories.courses,
      jobs: this.#dependencies.repositories.jobs,
      sourceBundles: this.#dependencies.repositories.sourceBundles,
      queue,
      vault,
      processor: this.#dependencies.processor,
      sourceArchiver,
      stagingRoot: this.#dependencies.stagingRoot,
      clock: this.#clock,
      onOperationalError: (error) => this.#report(error),
    });
    this.#runtime = Object.freeze({
      connection,
      courseService,
      localIntake: new LocalSourceIntake({
        courses: this.#dependencies.repositories.courses,
        jobs: this.#dependencies.repositories.jobs,
        sourceBundles: this.#dependencies.repositories.sourceBundles,
        stagingRoot: this.#dependencies.stagingRoot,
        clock: this.#clock,
      }),
      rebuilder: new VaultIndexRebuilder({
        connection,
        courses: this.#dependencies.repositories.courses,
        jobs: this.#dependencies.repositories.jobs,
        sourceBundles: this.#dependencies.repositories.sourceBundles,
        artifacts: this.#dependencies.repositories.artifacts,
        vault,
        clock: this.#clock,
      }),
      runner,
    });
  }

  #settings(): AppSettings {
    const settings = this.#dependencies.repositories.settings.get();
    if (settings === null) throw missingRuntime();
    return settings;
  }

  #updateSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.#settings();
    return this.#dependencies.repositories.settings.update(
      AppSettingsSchema.parse({
        ...current,
        ...patch,
        updatedAt: timestampAfter(current.updatedAt, this.#clock()),
        revision: current.revision + 1,
      }),
      current.revision,
    );
  }

  #requireRuntime(): ProcessingRuntime {
    if (this.#runtime === undefined) throw missingRuntime();
    return this.#runtime;
  }

  #state(): BootstrapState {
    const settings = this.#settings();
    const courses = this.#dependencies.repositories.courses.list({ includeArchived: true });
    const allJobs = this.#dependencies.repositories.jobs.list();
    const counts = { queued: 0, processing: 0, completed: 0, failed: 0 };
    for (const job of allJobs) counts[toPublicQueueStatus(job.status)] += 1;
    const jobs = allJobs
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 500)
      .map((job) => ({
        id: job.id,
        courseId: job.courseId,
        sourceFileName: job.sourceFileName,
        sourceMediaType: job.sourceMediaType,
        sourceCount: job.sourceCount,
        summaryMode: job.summaryMode,
        status: toPublicQueueStatus(job.status),
        retryCount: job.retryCount,
        error: jobError(job),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      }));
    return BootstrapStateSchema.parse({
      settings: {
        vaultConfigured: settings.vaultPath !== null,
        queueConfigured: settings.icloudQueuePath !== null,
        defaultSummaryMode: settings.defaultSummaryMode,
        autoStart: settings.autoStart,
        processingPaused: settings.processingPaused,
        legalNoticeAccepted: settings.legalNoticeAcceptedAt !== null,
      },
      courses: courses.map((course) => ({
        id: course.id,
        name: course.name,
        professorName: course.professorName,
        userInstructions: course.userInstructions,
        archived: course.archived,
        revision: course.revision,
      })),
      jobs,
      counts,
      synchronizationIssueCount:
        this.#recoveryIssues.length +
        (this.#runtime?.courseService.listSynchronizationIssues().length ?? 0),
    });
  }

  #stateAndEmit(): BootstrapState {
    const state = this.#state();
    try {
      this.#dependencies.onStateChanged(state);
    } catch (error) {
      this.#report(error);
    }
    return state;
  }

  #report(error: unknown): void {
    this.#dependencies.onOperationalError?.(error);
  }

  #schedulePoll(): void {
    if (!this.#polling) return;
    this.#pollTimer = setTimeout(() => {
      void this.pollOnce()
        .catch((error) => this.#report(error))
        .finally(() => this.#schedulePoll());
    }, this.#pollIntervalMs);
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
