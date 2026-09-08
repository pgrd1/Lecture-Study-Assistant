import type { StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type { JobRepository } from '../../core/ports/jobRepository';
import { type Job, JobSchema } from '../../shared/contracts/job';
import type { SqliteDatabase } from './sqliteDatabase';
import {
  assertNextRevision,
  assertSingleChange,
  parseDatabaseEntity,
  translateSqliteError,
} from './sqliteErrors';

const JOB_COLUMNS = `
  id,
  course_id AS courseId,
  source_kind AS sourceKind,
  source_file_name AS sourceFileName,
  source_media_type AS sourceMediaType,
  summary_mode AS summaryMode,
  staged_source_path AS stagedSourcePath,
  queue_item_path AS queueItemPath,
  source_sha256 AS sourceSha256,
  fingerprint,
  source_bundle_id AS sourceBundleId,
  source_count AS sourceCount,
  status,
  last_successful_status AS lastSuccessfulStatus,
  retry_count AS retryCount,
  error_code AS errorCode,
  cleanup_warning_code AS cleanupWarningCode,
  attention_resolution_id AS attentionResolutionId,
  created_at AS createdAt,
  updated_at AS updatedAt,
  revision
`;

const JobRowSchema = z.strictObject({
  id: z.string(),
  courseId: z.string(),
  sourceKind: z.string(),
  sourceFileName: z.string(),
  sourceMediaType: z.string(),
  summaryMode: z.string(),
  stagedSourcePath: z.string(),
  queueItemPath: z.string().nullable(),
  sourceSha256: z.string(),
  fingerprint: z.string(),
  sourceBundleId: z.string().nullable(),
  sourceCount: z.int(),
  status: z.string(),
  lastSuccessfulStatus: z.string(),
  retryCount: z.int(),
  errorCode: z.string().nullable(),
  cleanupWarningCode: z.string().nullable(),
  attentionResolutionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.int(),
});

const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

const toJob = (value: unknown): Job =>
  parseDatabaseEntity(() => JobSchema.parse(JobRowSchema.parse(value)));

const requireJob = (job: Job | null): Job =>
  parseDatabaseEntity(() => {
    if (job === null) {
      throw new TypeError('MISSING_JOB_AFTER_WRITE');
    }
    return job;
  });

export class SqliteJobRepository implements JobRepository {
  readonly #getStatement: StatementSync;
  readonly #listStatement: StatementSync;
  readonly #listRecoverableStatement: StatementSync;
  readonly #findFingerprintStatement: StatementSync;
  readonly #insertStatement: StatementSync;
  readonly #updateStatement: StatementSync;

  constructor(database: SqliteDatabase) {
    this.#getStatement = database.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`);
    this.#listStatement = database.prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs ORDER BY created_at, id`,
    );
    this.#listRecoverableStatement = database.prepare(`
      SELECT ${JOB_COLUMNS}
      FROM jobs
      WHERE status NOT IN ('completed', 'needs_attention')
      ORDER BY updated_at, id
    `);
    this.#findFingerprintStatement = database.prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE course_id = ? AND fingerprint = ?`,
    );
    this.#insertStatement = database.prepare(`
      INSERT INTO jobs (
        id, course_id, source_kind, source_file_name, source_media_type,
        summary_mode, staged_source_path, queue_item_path, source_sha256,
        fingerprint, source_bundle_id, source_count, status, last_successful_status,
        retry_count, error_code, cleanup_warning_code, attention_resolution_id,
        created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#updateStatement = database.prepare(`
      UPDATE jobs
      SET summary_mode = ?, queue_item_path = ?, status = ?, last_successful_status = ?,
          retry_count = ?, error_code = ?, cleanup_warning_code = ?,
          attention_resolution_id = ?, updated_at = ?, revision = ?
      WHERE id = ? AND revision = ? AND course_id = ? AND source_kind = ?
        AND source_file_name = ? AND source_media_type = ? AND staged_source_path = ?
        AND source_sha256 = ? AND fingerprint = ? AND source_bundle_id IS ?
        AND source_count = ? AND created_at = ?
    `);
  }

  get(id: string): Job | null {
    const parsedId = parseDatabaseEntity(() => z.uuid().parse(id));
    try {
      const row = this.#getStatement.get(parsedId);
      return row === undefined ? null : toJob(row);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  list(): readonly Job[] {
    try {
      return Object.freeze(this.#listStatement.all().map(toJob));
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  listRecoverable(): readonly Job[] {
    try {
      return Object.freeze(this.#listRecoverableStatement.all().map(toJob));
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  findByFingerprint(courseId: string, fingerprint: string): Job | null {
    const parsedCourseId = parseDatabaseEntity(() => z.uuid().parse(courseId));
    const parsedFingerprint = parseDatabaseEntity(() => FingerprintSchema.parse(fingerprint));
    try {
      const row = this.#findFingerprintStatement.get(parsedCourseId, parsedFingerprint);
      return row === undefined ? null : toJob(row);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  insert(job: Job): Job {
    const parsed = parseDatabaseEntity(() => JobSchema.parse(job));
    try {
      this.#insertStatement.run(
        parsed.id,
        parsed.courseId,
        parsed.sourceKind,
        parsed.sourceFileName,
        parsed.sourceMediaType,
        parsed.summaryMode,
        parsed.stagedSourcePath,
        parsed.queueItemPath,
        parsed.sourceSha256,
        parsed.fingerprint,
        parsed.sourceBundleId,
        parsed.sourceCount,
        parsed.status,
        parsed.lastSuccessfulStatus,
        parsed.retryCount,
        parsed.errorCode,
        parsed.cleanupWarningCode,
        parsed.attentionResolutionId,
        parsed.createdAt,
        parsed.updatedAt,
        parsed.revision,
      );
    } catch (error) {
      return translateSqliteError(error, 'DUPLICATE_JOB');
    }
    return requireJob(this.get(parsed.id));
  }

  update(job: Job, expectedRevision: number): Job {
    const parsed = parseDatabaseEntity(() => JobSchema.parse(job));
    assertNextRevision(parsed.revision, expectedRevision);
    try {
      const result = this.#updateStatement.run(
        parsed.summaryMode,
        parsed.queueItemPath,
        parsed.status,
        parsed.lastSuccessfulStatus,
        parsed.retryCount,
        parsed.errorCode,
        parsed.cleanupWarningCode,
        parsed.attentionResolutionId,
        parsed.updatedAt,
        parsed.revision,
        parsed.id,
        expectedRevision,
        parsed.courseId,
        parsed.sourceKind,
        parsed.sourceFileName,
        parsed.sourceMediaType,
        parsed.stagedSourcePath,
        parsed.sourceSha256,
        parsed.fingerprint,
        parsed.sourceBundleId,
        parsed.sourceCount,
        parsed.createdAt,
      );
      assertSingleChange(result);
    } catch (error) {
      return translateSqliteError(error);
    }
    return requireJob(this.get(parsed.id));
  }
}

export const createJobRepository = (database: SqliteDatabase): JobRepository =>
  new SqliteJobRepository(database);
