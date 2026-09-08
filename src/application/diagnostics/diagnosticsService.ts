import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { dirname, extname, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { DatabasePort } from '../../core/ports/database';
import type { JobRepository } from '../../core/ports/jobRepository';
import {
  SECRET_KEYS,
  SecretKeySchema,
  type SecretStore,
  type SecretStoreOperation,
} from '../../core/ports/secretStore';
import type { SettingsRepository } from '../../core/ports/settingsRepository';
import { atomicReplace } from '../../infrastructure/filesystem/atomicWrite';
import { createSafeRootConnection } from '../../infrastructure/queue/queueLayout';
import { JOB_STATUSES, JobStatusSchema, SummaryModeSchema } from '../../shared/contracts/job';
import { APP_ERROR_MESSAGES, AppError, AppErrorCodeSchema } from '../../shared/errors';

const REPORT_VERSION = 1;
const MIN_SALT_BYTES = 32;
const MAX_REPORT_BYTES = 512 * 1024;

const DestinationSchema = z
  .string()
  .min(1)
  .max(32_767)
  .refine(
    (value) =>
      isAbsolute(value) && !value.includes('\0') && extname(value).toLowerCase() === '.json',
  );

const RuntimeTokenSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/u);

const RuntimeSchema = z
  .strictObject({
    appVersion: RuntimeTokenSchema,
    electronVersion: RuntimeTokenSchema,
    nodeVersion: RuntimeTokenSchema,
    platform: RuntimeTokenSchema,
    arch: RuntimeTokenSchema,
  })
  .readonly();

const PathHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .nullable();

export const DiagnosticsReportSchema = z
  .strictObject({
    reportVersion: z.literal(REPORT_VERSION),
    generatedAt: z.iso.datetime({ offset: true }),
    runtime: RuntimeSchema,
    databaseSchemaVersion: z.int().min(0),
    settings: z
      .strictObject({
        configured: z.boolean(),
        vaultConfigured: z.boolean(),
        icloudQueueConfigured: z.boolean(),
        vaultPathHash: PathHashSchema,
        icloudQueuePathHash: PathHashSchema,
        defaultSummaryMode: SummaryModeSchema.nullable(),
        autoStart: z.boolean().nullable(),
        processingPaused: z.boolean().nullable(),
        legalNoticeAccepted: z.boolean(),
      })
      .readonly(),
    secrets: z.record(SecretKeySchema, z.boolean()).readonly(),
    jobs: z
      .strictObject({
        total: z.int().min(0),
        byStatus: z.record(JobStatusSchema, z.int().min(0)).readonly(),
        byErrorCode: z.partialRecord(AppErrorCodeSchema, z.int().min(1)).readonly(),
      })
      .readonly(),
  })
  .readonly();

export type DiagnosticsReport = z.infer<typeof DiagnosticsReportSchema>;

export type DiagnosticsRuntime = z.input<typeof RuntimeSchema>;

export type DiagnosticsServiceDependencies = Readonly<{
  database: Pick<DatabasePort, 'getSchemaVersion'>;
  jobs: Pick<JobRepository, 'list'>;
  settings: Pick<SettingsRepository, 'get'>;
  secrets: Pick<SecretStore, 'has'>;
  runtime: DiagnosticsRuntime;
  clock?: () => string;
  saltGenerator?: () => Buffer;
}>;

const diagnosticsExportFailed = (): AppError =>
  new AppError('DIAGNOSTICS_EXPORT_FAILED', APP_ERROR_MESSAGES.DIAGNOSTICS_EXPORT_FAILED);

const normalizeDiagnosticsError = (error: unknown): AppError =>
  AppError.isTrusted(error) && error.code === 'DIAGNOSTICS_EXPORT_FAILED'
    ? error
    : diagnosticsExportFailed();

const hashPrivatePath = (salt: Buffer, value: string | null): string | null =>
  value === null
    ? null
    : createHash('sha256').update(salt).update('\0', 'utf8').update(value, 'utf8').digest('hex');

const assertDiagnosticsActive = (signal: AbortSignal): void => {
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw diagnosticsExportFailed();
  }
};

export class DiagnosticsService {
  readonly #clock: () => string;
  readonly #database: Pick<DatabasePort, 'getSchemaVersion'>;
  readonly #jobs: Pick<JobRepository, 'list'>;
  readonly #runtime: DiagnosticsRuntime;
  readonly #saltGenerator: () => Buffer;
  readonly #secrets: Pick<SecretStore, 'has'>;
  readonly #settings: Pick<SettingsRepository, 'get'>;

  constructor(dependencies: DiagnosticsServiceDependencies) {
    this.#database = dependencies.database;
    this.#jobs = dependencies.jobs;
    this.#settings = dependencies.settings;
    this.#secrets = dependencies.secrets;
    this.#runtime = RuntimeSchema.parse(dependencies.runtime);
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
    this.#saltGenerator = dependencies.saltGenerator ?? (() => randomBytes(MIN_SALT_BYTES));
  }

  async export(destination: string, signal?: AbortSignal): Promise<string> {
    try {
      const exportSignal = signal ?? new AbortController().signal;
      assertDiagnosticsActive(exportSignal);
      const secretOperation: SecretStoreOperation = Object.freeze({
        requestId: randomUUID(),
        signal: exportSignal,
      });
      const parsedDestination = DestinationSchema.parse(destination);
      const report = await this.#buildReport(secretOperation);
      assertDiagnosticsActive(exportSignal);
      const content = `${JSON.stringify(report, null, 2)}\n`;
      if (Buffer.byteLength(content, 'utf8') > MAX_REPORT_BYTES) {
        throw diagnosticsExportFailed();
      }
      assertDiagnosticsActive(exportSignal);
      const connection = await createSafeRootConnection(dirname(parsedDestination));
      assertDiagnosticsActive(exportSignal);
      await atomicReplace({
        connection,
        targetPath: parsedDestination,
        replaceExisting: true,
        write: async (handle) => {
          assertDiagnosticsActive(exportSignal);
          await handle.writeFile(content, 'utf8');
          assertDiagnosticsActive(exportSignal);
          return undefined;
        },
        selectTarget: async () => {
          assertDiagnosticsActive(exportSignal);
          return Object.freeze({ targetPath: parsedDestination, replaceExisting: true });
        },
        dependencies: {
          beforeMutation: () => assertDiagnosticsActive(exportSignal),
        },
      });
      // Atomic publication is the commit boundary; permission hardening completes afterward.
      await chmod(parsedDestination, 0o600);
      return parsedDestination;
    } catch (error) {
      throw normalizeDiagnosticsError(error);
    }
  }

  async #buildReport(secretOperation: SecretStoreOperation): Promise<DiagnosticsReport> {
    assertDiagnosticsActive(secretOperation.signal);
    const salt = this.#saltGenerator();
    if (!Buffer.isBuffer(salt) || salt.length < MIN_SALT_BYTES) {
      throw diagnosticsExportFailed();
    }
    const settings = this.#settings.get();
    const jobs = this.#jobs.list();
    const byStatus = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0]));
    const byErrorCode: Record<string, number> = {};
    for (const job of jobs) {
      byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
      if (job.errorCode !== null) {
        byErrorCode[job.errorCode] = (byErrorCode[job.errorCode] ?? 0) + 1;
      }
    }
    const secretEntries = await Promise.all(
      SECRET_KEYS.map(async (key) => {
        assertDiagnosticsActive(secretOperation.signal);
        const present = await this.#secrets.has(key, secretOperation);
        assertDiagnosticsActive(secretOperation.signal);
        return [key, present] as const;
      }),
    );
    assertDiagnosticsActive(secretOperation.signal);

    return DiagnosticsReportSchema.parse({
      reportVersion: REPORT_VERSION,
      generatedAt: this.#clock(),
      runtime: this.#runtime,
      databaseSchemaVersion: this.#database.getSchemaVersion(),
      settings: {
        configured: settings !== null,
        vaultConfigured: settings?.vaultPath !== null && settings !== null,
        icloudQueueConfigured: settings?.icloudQueuePath !== null && settings !== null,
        vaultPathHash: hashPrivatePath(salt, settings?.vaultPath ?? null),
        icloudQueuePathHash: hashPrivatePath(salt, settings?.icloudQueuePath ?? null),
        defaultSummaryMode: settings?.defaultSummaryMode ?? null,
        autoStart: settings?.autoStart ?? null,
        processingPaused: settings?.processingPaused ?? null,
        legalNoticeAccepted: settings?.legalNoticeAcceptedAt !== null && settings !== null,
      },
      secrets: Object.fromEntries(secretEntries),
      jobs: {
        total: jobs.length,
        byStatus,
        byErrorCode,
      },
    });
  }
}
