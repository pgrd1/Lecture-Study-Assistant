import type { StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type { ProviderInvocationRepository } from '../../core/ports/providerRepositories';
import {
  type ProviderInvocation,
  type ProviderInvocationCompletion,
  ProviderInvocationCompletionSchema,
  ProviderInvocationSchema,
} from '../../shared/contracts/providerInvocation';
import type { SqliteDatabase } from './sqliteDatabase';
import { assertSingleChange, parseDatabaseEntity, translateSqliteError } from './sqliteErrors';

const INVOCATION_COLUMNS = `
  id,
  request_id AS requestId,
  job_id AS jobId,
  feature,
  provider_id AS providerId,
  selected_model_id AS selectedModelId,
  reported_model_id AS reportedModelId,
  prompt_version AS promptVersion,
  output_schema_id AS outputSchemaId,
  route_revision AS routeRevision,
  request_sha256 AS requestSha256,
  response_sha256 AS responseSha256,
  status,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  total_tokens AS totalTokens,
  latency_ms AS latencyMs,
  retry_of AS retryOf,
  attempt_kind AS attemptKind,
  error_code AS errorCode,
  started_at AS startedAt,
  completed_at AS completedAt,
  revision
`;

const ProviderInvocationRowSchema = z.strictObject({
  id: z.string(),
  requestId: z.string(),
  jobId: z.string().nullable(),
  feature: z.string(),
  providerId: z.string(),
  selectedModelId: z.string().nullable(),
  reportedModelId: z.string().nullable(),
  promptVersion: z.string(),
  outputSchemaId: z.string(),
  routeRevision: z.int(),
  requestSha256: z.string(),
  responseSha256: z.string().nullable(),
  status: z.string(),
  inputTokens: z.int().nullable(),
  outputTokens: z.int().nullable(),
  totalTokens: z.int().nullable(),
  latencyMs: z.int().nullable(),
  retryOf: z.string().nullable(),
  attemptKind: z.string(),
  errorCode: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  revision: z.int(),
});

const toInvocation = (value: unknown): ProviderInvocation =>
  parseDatabaseEntity(() =>
    Object.freeze(ProviderInvocationSchema.parse(ProviderInvocationRowSchema.parse(value))),
  );

const requireInvocation = (invocation: ProviderInvocation | null): ProviderInvocation =>
  parseDatabaseEntity(() => {
    if (invocation === null) {
      throw new TypeError('MISSING_PROVIDER_INVOCATION_AFTER_WRITE');
    }
    return invocation;
  });

export class SqliteProviderInvocationRepository implements ProviderInvocationRepository {
  readonly #database: SqliteDatabase;
  readonly #getStatement: StatementSync;
  readonly #listForJobStatement: StatementSync;
  readonly #insertStatement: StatementSync;
  readonly #completeStatement: StatementSync;
  readonly #recoverStatement: StatementSync;
  readonly #cancelRunningForShutdownStatement: StatementSync;

  constructor(database: SqliteDatabase) {
    this.#database = database;
    this.#getStatement = database.prepare(
      `SELECT ${INVOCATION_COLUMNS} FROM provider_invocations WHERE id = ?`,
    );
    this.#listForJobStatement = database.prepare(
      `SELECT ${INVOCATION_COLUMNS} FROM provider_invocations WHERE job_id = ? ORDER BY started_at, id`,
    );
    this.#insertStatement = database.prepare(`
      INSERT INTO provider_invocations (
        id, request_id, job_id, feature, provider_id, selected_model_id, reported_model_id,
        prompt_version, output_schema_id, route_revision, request_sha256, response_sha256,
        status, attempt_kind, retry_of, latency_ms, input_tokens, output_tokens, total_tokens,
        error_code, started_at, completed_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#completeStatement = database.prepare(`
      UPDATE provider_invocations
      SET reported_model_id = ?, response_sha256 = ?, status = ?, latency_ms = ?,
          input_tokens = ?, output_tokens = ?, total_tokens = ?, error_code = ?,
          completed_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND status = 'running'
    `);
    this.#recoverStatement = database.prepare(`
      UPDATE provider_invocations
      SET status = 'failed', error_code = 'PROVIDER_EXECUTION_FAILED', completed_at = ?,
          revision = revision + 1
      WHERE status = 'running'
    `);
    this.#cancelRunningForShutdownStatement = database.prepare(`
      UPDATE provider_invocations
      SET status = 'cancelled', error_code = 'PROVIDER_CANCELLED', completed_at = ?,
          revision = revision + 1
      WHERE status = 'running'
    `);
  }

  create(next: ProviderInvocation): ProviderInvocation {
    const parsed = parseDatabaseEntity(() => ProviderInvocationSchema.parse(next));
    if (parsed.status !== 'running' || parsed.revision !== 0) {
      return parseDatabaseEntity(() => {
        throw new TypeError('INVALID_PROVIDER_INVOCATION_CREATE');
      });
    }
    try {
      this.#insertStatement.run(
        parsed.id,
        parsed.requestId,
        parsed.jobId,
        parsed.feature,
        parsed.providerId,
        parsed.selectedModelId,
        parsed.reportedModelId,
        parsed.promptVersion,
        parsed.outputSchemaId,
        parsed.routeRevision,
        parsed.requestSha256,
        parsed.responseSha256,
        parsed.status,
        parsed.attemptKind,
        parsed.retryOf,
        parsed.latencyMs,
        parsed.inputTokens,
        parsed.outputTokens,
        parsed.totalTokens,
        parsed.errorCode,
        parsed.startedAt,
        parsed.completedAt,
        parsed.revision,
      );
    } catch (error) {
      return translateSqliteError(error);
    }
    return requireInvocation(this.get(parsed.id));
  }

  get(id: string): ProviderInvocation | null {
    const parsedId = parseDatabaseEntity(() => z.uuid().parse(id));
    try {
      const row = this.#getStatement.get(parsedId);
      return row === undefined ? null : toInvocation(row);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  complete(
    id: string,
    expectedRevision: number,
    completion: ProviderInvocationCompletion,
  ): ProviderInvocation {
    const parsedId = parseDatabaseEntity(() => z.uuid().parse(id));
    const parsedRevision = parseDatabaseEntity(() => z.int().min(0).parse(expectedRevision));
    const parsedCompletion = parseDatabaseEntity(() =>
      ProviderInvocationCompletionSchema.parse(completion),
    );
    try {
      assertSingleChange(
        this.#completeStatement.run(
          parsedCompletion.reportedModelId,
          parsedCompletion.responseSha256,
          parsedCompletion.status,
          parsedCompletion.latencyMs,
          parsedCompletion.inputTokens,
          parsedCompletion.outputTokens,
          parsedCompletion.totalTokens,
          parsedCompletion.errorCode,
          parsedCompletion.completedAt,
          parsedId,
          parsedRevision,
        ),
      );
    } catch (error) {
      return translateSqliteError(error);
    }
    return requireInvocation(this.get(parsedId));
  }

  listForJob(jobId: string): readonly ProviderInvocation[] {
    const parsedJobId = parseDatabaseEntity(() => z.uuid().parse(jobId));
    try {
      return Object.freeze(this.#listForJobStatement.all(parsedJobId).map(toInvocation));
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  recoverInterrupted(completedAt: string): number {
    const parsedCompletedAt = parseDatabaseEntity(() =>
      z.iso.datetime({ offset: true }).parse(completedAt),
    );
    try {
      this.#database.beginImmediate();
      const result = this.#recoverStatement.run(parsedCompletedAt);
      this.#database.commit();
      return Number(result.changes);
    } catch (error) {
      this.#database.rollback();
      return translateSqliteError(error);
    }
  }

  cancelRunningForShutdown(completedAt: string): number {
    const parsedCompletedAt = parseDatabaseEntity(() =>
      z.iso.datetime({ offset: true }).parse(completedAt),
    );
    try {
      this.#database.beginImmediate();
      const result = this.#cancelRunningForShutdownStatement.run(parsedCompletedAt);
      this.#database.commit();
      return Number(result.changes);
    } catch (error) {
      this.#database.rollback();
      return translateSqliteError(error);
    }
  }
}

export const createProviderInvocationRepository = (
  database: SqliteDatabase,
): ProviderInvocationRepository => new SqliteProviderInvocationRepository(database);
