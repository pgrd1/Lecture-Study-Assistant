import type { PromptProfileRepository } from '../../core/ports/promptProfileRepository';
import {
  type PromptProfile,
  type PromptProfileKey,
  PromptRevisionSchema,
  parsePromptKey,
  parsePromptProfile,
  promptProfileKey,
} from '../../shared/contracts/promptProfile';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';
import type { SqliteDatabase } from './sqliteDatabase';
import { assertSingleChange, parseDatabaseEntity, translateSqliteError } from './sqliteErrors';

const COLUMNS =
  'id, scope, course_id, feature, additional_instructions, template_override, name, base_version, revision, created_at, updated_at, deleted';
const SELECT = `SELECT id, scope, course_id AS courseId, feature,
  additional_instructions AS additionalInstructions, template_override AS templateOverride,
  name, base_version AS baseVersion, revision, created_at AS createdAt, updated_at AS updatedAt, deleted`;
const KEY_WHERE = 'scope = ? AND course_id IS ? AND feature IS ?';
const parseRow = (row: Record<string, unknown>): PromptProfile =>
  parseDatabaseEntity(() => {
    if (row.deleted !== 0 && row.deleted !== 1) throw new TypeError('INVALID_PROMPT_ROW');
    return parsePromptProfile({ ...row, deleted: row.deleted === 1 });
  });
const stale = (): AppError => new AppError('STALE_WRITE', APP_ERROR_MESSAGES.STALE_WRITE);

export class SqlitePromptProfileRepository implements PromptProfileRepository {
  readonly #database: SqliteDatabase;
  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  getCurrent(key: PromptProfileKey): PromptProfile | null {
    const parsed = parseDatabaseEntity(() => parsePromptKey(key));
    try {
      const row = this.#database
        .prepare(`${SELECT} FROM prompt_profiles WHERE ${KEY_WHERE}`)
        .get(parsed.scope, parsed.courseId, parsed.feature);
      return row === undefined ? null : parseRow(row);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  list(): readonly PromptProfile[] {
    try {
      return Object.freeze(
        this.#database
          .prepare(
            `${SELECT} FROM prompt_profiles WHERE deleted = 0 ORDER BY scope, course_id, feature`,
          )
          .all()
          .map(parseRow),
      );
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  history(key: PromptProfileKey): readonly PromptProfile[] {
    const parsed = parseDatabaseEntity(() => parsePromptKey(key));
    try {
      return Object.freeze(
        this.#database
          .prepare(`${SELECT} FROM prompt_profile_history WHERE ${KEY_WHERE} ORDER BY revision`)
          .all(parsed.scope, parsed.courseId, parsed.feature)
          .map(parseRow),
      );
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  save(profile: PromptProfile, expectedRevision: number | null): PromptProfile {
    const parsed = parseDatabaseEntity(() => parsePromptProfile(profile));
    if (expectedRevision !== null)
      parseDatabaseEntity(() => PromptRevisionSchema.parse(expectedRevision));
    if (parsed.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw stale();
    this.#database.beginImmediate();
    try {
      const key = { scope: parsed.scope, courseId: parsed.courseId, feature: parsed.feature };
      const current = this.getCurrent(key);
      if (
        (current?.revision ?? null) !== expectedRevision ||
        (current !== null &&
          (current.id !== parsed.id ||
            current.createdAt !== parsed.createdAt ||
            promptProfileKey(key) !==
              promptProfileKey({
                scope: current.scope,
                courseId: current.courseId,
                feature: current.feature,
              })))
      )
        throw stale();
      if (current === null) this.#insert(parsed);
      else
        assertSingleChange(
          this.#database
            .prepare(
              `UPDATE prompt_profiles SET additional_instructions = ?, template_override = ?, name = ?, base_version = ?, revision = ?, updated_at = ?, deleted = ? WHERE id = ? AND revision = ?`,
            )
            .run(
              parsed.additionalInstructions,
              parsed.templateOverride,
              parsed.name,
              parsed.baseVersion,
              parsed.revision,
              parsed.updatedAt,
              Number(parsed.deleted),
              parsed.id,
              expectedRevision,
            ),
        );
      this.#database
        .prepare(
          `INSERT INTO prompt_profile_history (${COLUMNS}) SELECT ${COLUMNS} FROM prompt_profiles WHERE id = ?`,
        )
        .run(parsed.id);
      this.#database.commit();
      return parsed;
    } catch (error) {
      this.#database.rollback();
      return translateSqliteError(error);
    }
  }

  #insert(profile: PromptProfile): void {
    this.#database
      .prepare(
        `INSERT INTO prompt_profiles (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.scope,
        profile.courseId,
        profile.feature,
        profile.additionalInstructions,
        profile.templateOverride,
        profile.name,
        profile.baseVersion,
        profile.revision,
        profile.createdAt,
        profile.updatedAt,
        Number(profile.deleted),
      );
  }
}

export const createPromptProfileRepository = (database: SqliteDatabase): PromptProfileRepository =>
  new SqlitePromptProfileRepository(database);
