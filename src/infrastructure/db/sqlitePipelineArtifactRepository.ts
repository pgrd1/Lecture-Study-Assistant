import type { StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type { PipelineArtifactRepository } from '../../core/ports/pipelineArtifactRepository';
import {
  assertBoundedPipelineJson,
  type PipelineArtifact,
  PipelineArtifactSchema,
  type PipelineStage,
  PipelineStageSchema,
} from '../../shared/contracts/pipelineArtifact';
import type { SqliteDatabase } from './sqliteDatabase';
import { parseDatabaseEntity, translateSqliteError } from './sqliteErrors';

export class SqlitePipelineArtifactRepository implements PipelineArtifactRepository {
  readonly #get: StatementSync;
  readonly #put: StatementSync;

  constructor(database: SqliteDatabase) {
    this.#get = database.prepare(`SELECT job_id AS jobId, stage, schema_version AS schemaVersion,
      relative_path AS relativePath, sha256, identity_sha256 AS identitySha256, created_at AS createdAt
      FROM pipeline_artifacts WHERE job_id = ? AND stage = ?`);
    this.#put = database.prepare(`INSERT INTO pipeline_artifacts
      (job_id, stage, schema_version, relative_path, sha256, identity_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, stage) DO UPDATE SET
      schema_version = excluded.schema_version, relative_path = excluded.relative_path,
      sha256 = excluded.sha256, identity_sha256 = excluded.identity_sha256, created_at = excluded.created_at`);
  }

  get(jobId: string, stage: PipelineStage): PipelineArtifact | null {
    const id = parseDatabaseEntity(() => z.uuid().parse(jobId));
    const parsedStage = parseDatabaseEntity(() => PipelineStageSchema.parse(stage));
    try {
      const row = this.#get.get(id, parsedStage);
      return row === undefined
        ? null
        : parseDatabaseEntity(() => PipelineArtifactSchema.parse(row));
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  put(artifact: PipelineArtifact): PipelineArtifact {
    const parsed = parseDatabaseEntity(() => {
      assertBoundedPipelineJson(artifact);
      return PipelineArtifactSchema.parse(artifact);
    });
    try {
      this.#put.run(
        parsed.jobId,
        parsed.stage,
        parsed.schemaVersion,
        parsed.relativePath,
        parsed.sha256,
        parsed.identitySha256,
        parsed.createdAt,
      );
      return parsed;
    } catch (error) {
      return translateSqliteError(error);
    }
  }
}

export const createPipelineArtifactRepository = (
  database: SqliteDatabase,
): PipelineArtifactRepository => new SqlitePipelineArtifactRepository(database);
