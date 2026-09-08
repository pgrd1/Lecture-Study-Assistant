import type { StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type { SettingsRepository } from '../../core/ports/settingsRepository';
import { type AppSettings, AppSettingsSchema } from '../../shared/contracts/settings';
import type { SqliteDatabase } from './sqliteDatabase';
import {
  assertNextRevision,
  assertSingleChange,
  parseDatabaseEntity,
  translateSqliteError,
} from './sqliteErrors';

const SETTINGS_COLUMNS = `
  schema_version AS schemaVersion,
  vault_path AS vaultPath,
  icloud_queue_path AS icloudQueuePath,
  default_summary_mode AS defaultSummaryMode,
  auto_start AS autoStart,
  processing_paused AS processingPaused,
  legal_notice_accepted_at AS legalNoticeAcceptedAt,
  updated_at AS updatedAt,
  revision
`;

const SettingsRowSchema = z.strictObject({
  schemaVersion: z.int(),
  vaultPath: z.string().nullable(),
  icloudQueuePath: z.string().nullable(),
  defaultSummaryMode: z.string(),
  autoStart: z.union([z.literal(0), z.literal(1)]),
  processingPaused: z.union([z.literal(0), z.literal(1)]),
  legalNoticeAcceptedAt: z.string().nullable(),
  updatedAt: z.string(),
  revision: z.int(),
});

const toSettings = (value: unknown): AppSettings =>
  parseDatabaseEntity(() => {
    const row = SettingsRowSchema.parse(value);
    return AppSettingsSchema.parse({
      ...row,
      autoStart: row.autoStart === 1,
      processingPaused: row.processingPaused === 1,
    });
  });

const requireSettings = (settings: AppSettings | null): AppSettings =>
  parseDatabaseEntity(() => {
    if (settings === null) {
      throw new TypeError('MISSING_SETTINGS_AFTER_WRITE');
    }
    return settings;
  });

export class SqliteSettingsRepository implements SettingsRepository {
  readonly #getStatement: StatementSync;
  readonly #insertStatement: StatementSync;
  readonly #updateStatement: StatementSync;

  constructor(database: SqliteDatabase) {
    this.#getStatement = database.prepare(
      `SELECT ${SETTINGS_COLUMNS} FROM settings WHERE singleton_id = 1`,
    );
    this.#insertStatement = database.prepare(`
      INSERT INTO settings (
        singleton_id, schema_version, vault_path, icloud_queue_path,
        default_summary_mode, auto_start, processing_paused,
        legal_notice_accepted_at, updated_at, revision
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#updateStatement = database.prepare(`
      UPDATE settings
      SET schema_version = ?, vault_path = ?, icloud_queue_path = ?,
          default_summary_mode = ?, auto_start = ?, processing_paused = ?,
          legal_notice_accepted_at = ?, updated_at = ?, revision = ?
      WHERE singleton_id = 1 AND revision = ?
    `);
  }

  get(): AppSettings | null {
    try {
      const row = this.#getStatement.get();
      return row === undefined ? null : toSettings(row);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  insert(settings: AppSettings): AppSettings {
    const parsed = parseDatabaseEntity(() => AppSettingsSchema.parse(settings));
    try {
      this.#insertStatement.run(
        parsed.schemaVersion,
        parsed.vaultPath,
        parsed.icloudQueuePath,
        parsed.defaultSummaryMode,
        parsed.autoStart ? 1 : 0,
        parsed.processingPaused ? 1 : 0,
        parsed.legalNoticeAcceptedAt,
        parsed.updatedAt,
        parsed.revision,
      );
    } catch (error) {
      return translateSqliteError(error);
    }
    return requireSettings(this.get());
  }

  update(settings: AppSettings, expectedRevision: number): AppSettings {
    const parsed = parseDatabaseEntity(() => AppSettingsSchema.parse(settings));
    assertNextRevision(parsed.revision, expectedRevision);
    try {
      const result = this.#updateStatement.run(
        parsed.schemaVersion,
        parsed.vaultPath,
        parsed.icloudQueuePath,
        parsed.defaultSummaryMode,
        parsed.autoStart ? 1 : 0,
        parsed.processingPaused ? 1 : 0,
        parsed.legalNoticeAcceptedAt,
        parsed.updatedAt,
        parsed.revision,
        expectedRevision,
      );
      assertSingleChange(result);
    } catch (error) {
      return translateSqliteError(error);
    }
    return requireSettings(this.get());
  }
}

export const createSettingsRepository = (database: SqliteDatabase): SettingsRepository =>
  new SqliteSettingsRepository(database);
