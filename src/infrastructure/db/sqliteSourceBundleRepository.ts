import type { StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type { JobRepository } from '../../core/ports/jobRepository';
import type { SourceBundleRepository } from '../../core/ports/sourceBundleRepository';
import { type Job, JobSchema } from '../../shared/contracts/job';
import {
  MAX_SOURCES_PER_BUNDLE,
  type SourceBundle,
  SourceBundleSchema,
  type SourceRecord,
  SourceRecordSchema,
} from '../../shared/contracts/sourceBundle';
import type { SqliteDatabase } from './sqliteDatabase';
import { assertSingleChange, parseDatabaseEntity, translateSqliteError } from './sqliteErrors';
import { createJobRepository } from './sqliteJobRepository';

const SOURCE_BUNDLE_COLUMNS = `
  id,
  job_id AS jobId,
  manifest_sha256 AS manifestSha256,
  source_count AS sourceCount,
  total_bytes AS totalBytes,
  staging_directory_path AS stagingDirectoryPath,
  created_at AS createdAt
`;

const SOURCE_RECORD_COLUMNS = `
  id,
  bundle_id AS bundleId,
  ordinal,
  original_file_name AS originalFileName,
  media_type AS mediaType,
  staged_path AS stagedPath,
  sha256,
  size_bytes AS sizeBytes
`;

const SourceBundleRowSchema = z.strictObject({
  id: z.string(),
  jobId: z.string(),
  manifestSha256: z.string(),
  sourceCount: z.int(),
  totalBytes: z.int(),
  stagingDirectoryPath: z.string(),
  createdAt: z.string(),
});

const SourceRecordRowSchema = z.strictObject({
  id: z.string(),
  bundleId: z.string(),
  ordinal: z.int(),
  originalFileName: z.string(),
  mediaType: z.string(),
  stagedPath: z.string(),
  sha256: z.string(),
  sizeBytes: z.int(),
});

const SourceBundleInsertSchema = z
  .strictObject({
    bundle: SourceBundleSchema,
    records: z.array(SourceRecordSchema).min(1).max(MAX_SOURCES_PER_BUNDLE).readonly(),
  })
  .superRefine(({ bundle, records }, context) => {
    if (records.length !== bundle.sourceCount) {
      context.addIssue({
        code: 'custom',
        message: '원본 레코드 수가 묶음의 원본 수와 일치해야 합니다.',
        path: ['records'],
      });
    }

    const totalBytes = records.reduce((sum, record) => sum + record.sizeBytes, 0);
    if (totalBytes !== bundle.totalBytes) {
      context.addIssue({
        code: 'custom',
        message: '원본 레코드 크기 합계가 묶음의 전체 크기와 일치해야 합니다.',
        path: ['records'],
      });
    }

    const ordinals = new Set<number>();
    records.forEach((record, index) => {
      if (record.bundleId !== bundle.id) {
        context.addIssue({
          code: 'custom',
          message: '원본 레코드는 같은 묶음을 참조해야 합니다.',
          path: ['records', index, 'bundleId'],
        });
      }
      ordinals.add(record.ordinal);
    });
    for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
      if (!ordinals.has(ordinal)) {
        context.addIssue({
          code: 'custom',
          message: '원본 레코드 순서는 0부터 연속되어야 합니다.',
          path: ['records'],
        });
        break;
      }
    }
  })
  .readonly();

const toSourceBundle = (value: unknown): SourceBundle =>
  parseDatabaseEntity(() => SourceBundleSchema.parse(SourceBundleRowSchema.parse(value)));

const toSourceRecord = (value: unknown): SourceRecord =>
  parseDatabaseEntity(() => SourceRecordSchema.parse(SourceRecordRowSchema.parse(value)));

const requireSourceBundle = (bundle: SourceBundle | null): SourceBundle =>
  parseDatabaseEntity(() => {
    if (bundle === null) {
      throw new TypeError('MISSING_SOURCE_BUNDLE_AFTER_WRITE');
    }
    return bundle;
  });

export class SqliteSourceBundleRepository implements SourceBundleRepository {
  readonly #database: SqliteDatabase;
  readonly #jobs: JobRepository;
  readonly #getByJobIdStatement: StatementSync;
  readonly #listRecordsStatement: StatementSync;
  readonly #insertBundleStatement: StatementSync;
  readonly #insertRecordStatement: StatementSync;

  constructor(database: SqliteDatabase, jobs: JobRepository = createJobRepository(database)) {
    this.#database = database;
    this.#jobs = jobs;
    this.#getByJobIdStatement = database.prepare(
      `SELECT ${SOURCE_BUNDLE_COLUMNS} FROM source_bundles WHERE job_id = ?`,
    );
    this.#listRecordsStatement = database.prepare(
      `SELECT ${SOURCE_RECORD_COLUMNS} FROM source_records WHERE bundle_id = ? ORDER BY ordinal`,
    );
    this.#insertBundleStatement = database.prepare(`
      INSERT INTO source_bundles (
        id, job_id, manifest_sha256, source_count, total_bytes,
        staging_directory_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `);
    this.#insertRecordStatement = database.prepare(`
      INSERT INTO source_records (
        id, bundle_id, ordinal, original_file_name, media_type,
        staged_path, sha256, size_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  insert(bundle: SourceBundle, records: readonly SourceRecord[]): SourceBundle {
    const parsed = parseDatabaseEntity(() => SourceBundleInsertSchema.parse({ bundle, records }));
    const orderedRecords = parsed.records.toSorted((left, right) => left.ordinal - right.ordinal);
    try {
      this.#database.beginImmediate();
      this.#insertRows(parsed.bundle, orderedRecords);
      this.#database.commit();
    } catch (error) {
      this.#database.rollback();
      return translateSqliteError(error);
    }
    return requireSourceBundle(this.getByJobId(parsed.bundle.jobId));
  }

  insertJobWithBundle(job: Job, bundle: SourceBundle, records: readonly SourceRecord[]): Job {
    return this.#persistLinkedJob(job, bundle, records);
  }

  attachLegacyBundle(job: Job, bundle: SourceBundle, records: readonly SourceRecord[]): Job {
    const previous = parseDatabaseEntity(() => JobSchema.parse(job));
    if (
      previous.sourceBundleId !== null ||
      previous.sourceCount !== 1 ||
      records.length !== 1 ||
      records[0]?.id !== previous.id
    )
      return translateSqliteError(new TypeError('INVALID_LEGACY_BUNDLE_UPGRADE'));
    const updated = {
      ...previous,
      sourceBundleId: bundle.id,
      revision: previous.revision + 1,
      updatedAt: new Date(Date.parse(previous.updatedAt) + 1).toISOString(),
    };
    return this.#persistLinkedJob(updated, bundle, records, previous);
  }

  #persistLinkedJob(
    job: Job,
    bundle: SourceBundle,
    records: readonly SourceRecord[],
    previous?: Job,
  ): Job {
    const parsedJob = parseDatabaseEntity(() => JobSchema.parse(job));
    const parsed = parseDatabaseEntity(() => SourceBundleInsertSchema.parse({ bundle, records }));
    const orderedRecords = parsed.records.toSorted((left, right) => left.ordinal - right.ordinal);
    const primary = orderedRecords[0];
    if (
      parsedJob.id !== parsed.bundle.jobId ||
      parsedJob.sourceBundleId !== parsed.bundle.id ||
      parsedJob.sourceCount !== parsed.bundle.sourceCount ||
      primary === undefined ||
      parsedJob.sourceFileName !== primary.originalFileName ||
      parsedJob.sourceMediaType !== primary.mediaType ||
      parsedJob.stagedSourcePath !== primary.stagedPath ||
      parsedJob.sourceSha256 !== primary.sha256
    ) {
      return translateSqliteError(new TypeError('JOB_SOURCE_BUNDLE_LINKAGE_MISMATCH'));
    }

    try {
      this.#database.beginImmediate();
      if (previous && JSON.stringify(this.#jobs.get(previous.id)) !== JSON.stringify(previous))
        return translateSqliteError(new TypeError('LEGACY_JOB_CHANGED'));
      // Normal JobRepository.update deliberately forbids source identity changes.
      // This transaction is the sole null -> complete-bundle upgrade boundary.
      if (previous)
        assertSingleChange(
          this.#database
            .prepare(
              'UPDATE jobs SET source_bundle_id = ?, updated_at = ?, revision = ? WHERE id = ? AND revision = ? AND source_bundle_id IS NULL AND source_count = 1',
            )
            .run(
              parsedJob.sourceBundleId,
              parsedJob.updatedAt,
              parsedJob.revision,
              previous.id,
              previous.revision,
            ),
        );
      const persistedJob = previous ? parsedJob : this.#jobs.insert(parsedJob);
      this.#insertRows(parsed.bundle, orderedRecords);
      this.#database.commit();
      return persistedJob;
    } catch (error) {
      this.#database.rollback();
      return translateSqliteError(error);
    }
  }

  getByJobId(jobId: string): SourceBundle | null {
    const parsedJobId = parseDatabaseEntity(() => z.uuid().parse(jobId));
    try {
      const row = this.#getByJobIdStatement.get(parsedJobId);
      return row === undefined ? null : toSourceBundle(row);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  listRecords(bundleId: string): readonly SourceRecord[] {
    const parsedBundleId = parseDatabaseEntity(() => z.uuid().parse(bundleId));
    try {
      return Object.freeze(this.#listRecordsStatement.all(parsedBundleId).map(toSourceRecord));
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  #insertRows(bundle: SourceBundle, records: readonly SourceRecord[]): void {
    assertSingleChange(
      this.#insertBundleStatement.run(
        bundle.id,
        bundle.jobId,
        bundle.manifestSha256,
        bundle.sourceCount,
        bundle.totalBytes,
        bundle.stagingDirectoryPath,
        bundle.createdAt,
      ),
    );
    for (const record of records) {
      this.#insertRecordStatement.run(
        record.id,
        record.bundleId,
        record.ordinal,
        record.originalFileName,
        record.mediaType,
        record.stagedPath,
        record.sha256,
        record.sizeBytes,
      );
    }
  }
}

export const createSourceBundleRepository = (
  database: SqliteDatabase,
  jobs?: JobRepository,
): SourceBundleRepository => new SqliteSourceBundleRepository(database, jobs);
