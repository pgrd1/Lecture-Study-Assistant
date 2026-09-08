import type { StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type { JobArtifactRepository } from '../../core/ports/jobArtifactRepository';
import {
  type JobArtifact,
  JobArtifactKindSchema,
  JobArtifactSchema,
} from '../../shared/contracts/jobArtifact';
import type { SqliteDatabase } from './sqliteDatabase';
import { parseDatabaseEntity, translateSqliteError } from './sqliteErrors';

const ARTIFACT_COLUMNS = `
  job_id AS jobId,
  artifact_kind AS kind,
  relative_path AS relativePath,
  sha256,
  created_at AS createdAt
`;

const ArtifactRowSchema = z.strictObject({
  jobId: z.string(),
  kind: z.string(),
  relativePath: z.string(),
  sha256: z.string(),
  createdAt: z.string(),
});

const toArtifact = (value: unknown): JobArtifact =>
  parseDatabaseEntity(() => JobArtifactSchema.parse(ArtifactRowSchema.parse(value)));

export class SqliteJobArtifactRepository implements JobArtifactRepository {
  readonly #getStatement: StatementSync;
  readonly #insertStatement: StatementSync;
  readonly #listStatement: StatementSync;

  constructor(database: SqliteDatabase) {
    this.#getStatement = database.prepare(
      `SELECT ${ARTIFACT_COLUMNS} FROM job_artifacts WHERE job_id = ? AND artifact_kind = ?`,
    );
    this.#listStatement = database.prepare(
      `SELECT ${ARTIFACT_COLUMNS} FROM job_artifacts WHERE job_id = ? ORDER BY artifact_kind`,
    );
    this.#insertStatement = database.prepare(`
      INSERT INTO job_artifacts (job_id, artifact_kind, relative_path, sha256, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  get(jobId: string, kind: JobArtifact['kind']): JobArtifact | null {
    const parsedJobId = parseDatabaseEntity(() => z.uuid().parse(jobId));
    const parsedKind = parseDatabaseEntity(() => JobArtifactKindSchema.parse(kind));
    try {
      const row = this.#getStatement.get(parsedJobId, parsedKind);
      return row === undefined ? null : toArtifact(row);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  listByJob(jobId: string): readonly JobArtifact[] {
    const parsedJobId = parseDatabaseEntity(() => z.uuid().parse(jobId));
    try {
      return Object.freeze(this.#listStatement.all(parsedJobId).map(toArtifact));
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  insert(artifact: JobArtifact): JobArtifact {
    const parsed = parseDatabaseEntity(() => JobArtifactSchema.parse(artifact));
    try {
      this.#insertStatement.run(
        parsed.jobId,
        parsed.kind,
        parsed.relativePath,
        parsed.sha256,
        parsed.createdAt,
      );
      const inserted = this.get(parsed.jobId, parsed.kind);
      if (inserted === null) {
        throw new TypeError('MISSING_ARTIFACT_AFTER_INSERT');
      }
      return inserted;
    } catch (error) {
      return translateSqliteError(error);
    }
  }
}

export const createJobArtifactRepository = (database: SqliteDatabase): JobArtifactRepository =>
  new SqliteJobArtifactRepository(database);
