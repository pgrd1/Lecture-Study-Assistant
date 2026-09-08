import { z } from 'zod';
import type { ManagedNoteRevisionRepository } from '../../core/ports/managedNoteRevisionRepository';
import {
  type ManagedNoteConflict,
  ManagedNoteIdSchema,
  ManagedNotePathSchema,
  type ManagedNoteRevision,
  parseManagedNoteConflict,
  parseManagedNoteRevision,
} from '../../shared/contracts/managedNoteRevision';
import { workspacePathKey } from '../../shared/contracts/obsidianWorkspace';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';
import type { SqliteDatabase } from './sqliteDatabase';
import { parseDatabaseEntity, translateSqliteError } from './sqliteErrors';

const REVISION_COLUMNS = `stable_id AS stableId, relative_path AS relativePath, path_key AS pathKey,
  generated_base AS generatedBase, generated_base_hash AS generatedBaseHash, published_hash AS publishedHash,
  generation_revision AS generationRevision, revision, decision, created_at AS createdAt, updated_at AS updatedAt`;
const CONFLICT_COLUMNS = `id, stable_id AS stableId, original_path AS originalPath, current_path AS currentPath,
  candidate_path AS candidatePath, current_hash AS currentHash, candidate_hash AS candidateHash,
  generation_revision AS generationRevision, reason, created_at AS createdAt`;
const Expected = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const Limit = z.number().int().min(1).max(1_000);
const Offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const stale = (): never => {
  throw new AppError('STALE_WRITE', APP_ERROR_MESSAGES.STALE_WRITE);
};

export class SqliteManagedNoteRevisionRepository implements ManagedNoteRevisionRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(stableId: string): ManagedNoteRevision | null {
    const id = parseDatabaseEntity(() => ManagedNoteIdSchema.parse(stableId));
    return this.#readOne('stable_id = ?', id);
  }

  findByPath(relativePath: string): ManagedNoteRevision | null {
    const path = parseDatabaseEntity(() => ManagedNotePathSchema.parse(relativePath));
    return this.#readOne('path_key = ?', workspacePathKey(path));
  }

  #readOne(
    condition: 'stable_id = ?' | 'path_key = ?',
    parameter: string,
  ): ManagedNoteRevision | null {
    try {
      const row = this.database
        .prepare(
          `SELECT ${REVISION_COLUMNS} FROM managed_note_history WHERE ${condition} ORDER BY revision DESC LIMIT 1`,
        )
        .get(parameter);
      return row === undefined ? null : parseDatabaseEntity(() => parseManagedNoteRevision(row));
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  #transaction<T>(stableId: string, expectedRevision: number | null, write: () => T): T {
    const expected = parseDatabaseEntity(() => Expected.parse(expectedRevision));
    this.database.beginImmediate();
    try {
      if ((this.get(stableId)?.revision ?? null) !== expected) stale();
      const result = write();
      this.database.commit();
      return result;
    } catch (error) {
      this.database.rollback();
      return translateSqliteError(error);
    }
  }

  append(input: ManagedNoteRevision, expectedRevision: number | null): ManagedNoteRevision {
    const value = parseDatabaseEntity(() => parseManagedNoteRevision(input));
    return this.#transaction(value.stableId, expectedRevision, () => {
      if (value.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) stale();
      this.database
        .prepare(`INSERT INTO managed_note_history
        (stable_id, relative_path, path_key, generated_base, generated_base_hash, published_hash,
         generation_revision, revision, decision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          value.stableId,
          value.relativePath,
          value.pathKey,
          value.generatedBase,
          value.generatedBaseHash,
          value.publishedHash,
          value.generationRevision,
          value.revision,
          value.decision,
          value.createdAt,
          value.updatedAt,
        );
      return value;
    });
  }

  recordConflict(input: ManagedNoteConflict, expectedRevision: number | null): ManagedNoteConflict {
    const value = parseDatabaseEntity(() => parseManagedNoteConflict(input));
    return this.#transaction(value.stableId, expectedRevision, () => {
      this.database
        .prepare(`INSERT INTO managed_note_conflicts
        (id, stable_id, original_path, current_path, candidate_path, current_hash, candidate_hash, generation_revision, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          value.id,
          value.stableId,
          value.originalPath,
          value.currentPath,
          value.candidatePath,
          value.currentHash,
          value.candidateHash,
          value.generationRevision,
          value.reason,
          value.createdAt,
        );
      return value;
    });
  }

  history(stableId: string, afterRevision = -1, limit = 100): readonly ManagedNoteRevision[] {
    const id = parseDatabaseEntity(() => ManagedNoteIdSchema.parse(stableId));
    const after = parseDatabaseEntity(() =>
      z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).parse(afterRevision),
    );
    const count = parseDatabaseEntity(() => Limit.parse(limit));
    try {
      return Object.freeze(
        this.database
          .prepare(
            `SELECT ${REVISION_COLUMNS} FROM managed_note_history WHERE stable_id = ? AND revision > ? ORDER BY revision LIMIT ?`,
          )
          .all(id, after, count)
          .map((row) => parseDatabaseEntity(() => parseManagedNoteRevision(row))),
      );
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  conflicts(stableId: string, offset = 0, limit = 100): readonly ManagedNoteConflict[] {
    const id = parseDatabaseEntity(() => ManagedNoteIdSchema.parse(stableId));
    const start = parseDatabaseEntity(() => Offset.parse(offset));
    const count = parseDatabaseEntity(() => Limit.parse(limit));
    try {
      return Object.freeze(
        this.database
          .prepare(
            `SELECT ${CONFLICT_COLUMNS} FROM managed_note_conflicts WHERE stable_id = ? ORDER BY rowid LIMIT ? OFFSET ?`,
          )
          .all(id, count, start)
          .map((row) => parseDatabaseEntity(() => parseManagedNoteConflict(row))),
      );
    } catch (error) {
      return translateSqliteError(error);
    }
  }
}

export const createManagedNoteRevisionRepository = (
  database: SqliteDatabase,
): ManagedNoteRevisionRepository => new SqliteManagedNoteRevisionRepository(database);
