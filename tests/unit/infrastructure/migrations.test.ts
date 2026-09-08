import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  SQLITE_MIGRATIONS,
  type SqliteMigration,
} from '../../../src/infrastructure/db/migrations';

const NOW = '2026-09-06T09:00:00.000Z';
const LATER = '2026-09-06T10:00:00.000Z';
const COURSE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

const insertLegacyJob = (database: DatabaseSync): void => {
  database
    .prepare(`
      INSERT INTO courses (
        id, name, professor_name, folder_name, user_instructions,
        archived, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(COURSE_ID, '자료구조', '김교수', '자료구조', '', 0, NOW, NOW, 0);
  database
    .prepare(`
      INSERT INTO jobs (
        id, course_id, source_kind, source_file_name, source_media_type,
        summary_mode, staged_source_path, queue_item_path, source_sha256,
        fingerprint, status, last_successful_status, retry_count, error_code,
        cleanup_warning_code, attention_resolution_id, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      JOB_ID,
      COURSE_ID,
      'local',
      'lecture.m4a',
      'audio',
      'standard',
      'C:\\app\\staging\\lecture.m4a',
      null,
      'a'.repeat(64),
      'b'.repeat(64),
      'queued',
      'queued',
      0,
      null,
      null,
      null,
      NOW,
      NOW,
      0,
    );
};

class RecordingDatabase {
  readonly events: string[] = [];
  #inImmediateTransaction = false;

  exec(sql: string): void {
    if (sql === 'BEGIN IMMEDIATE') {
      this.#inImmediateTransaction = true;
      this.events.push('begin');
      return;
    }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      this.events.push(sql.toLowerCase());
      this.#inImmediateTransaction = false;
      return;
    }
    this.events.push(`exec:${this.#inImmediateTransaction ? 'locked' : 'unlocked'}`);
  }

  prepare(sql: string): unknown {
    if (sql.startsWith('SELECT MAX(version)')) {
      return {
        get: () => {
          this.events.push(`max-version:${this.#lockState()}`);
          return { version: null };
        },
      };
    }
    if (sql.startsWith('SELECT version FROM schema_migrations WHERE')) {
      return {
        get: () => {
          this.events.push(`find-version:${this.#lockState()}`);
          return undefined;
        },
      };
    }
    if (sql.startsWith('INSERT INTO schema_migrations')) {
      return {
        run: () => {
          this.events.push(`record-version:${this.#lockState()}`);
          return { changes: 1, lastInsertRowid: 1 };
        },
      };
    }
    throw new TypeError('UNEXPECTED_SQL');
  }

  #lockState(): 'locked' | 'unlocked' {
    return this.#inImmediateTransaction ? 'locked' : 'unlocked';
  }
}

describe('SQLite migrations', () => {
  it('rejects an embedded NUL in a direct-SQL conflict identity', () => {
    const database = new DatabaseSync(':memory:');
    try {
      applyMigrations(database);
      expect(() =>
        database
          .prepare(`INSERT INTO managed_note_conflicts
        (id, stable_id, original_path, current_path, candidate_path, current_hash, candidate_hash, generation_revision, reason, created_at)
        VALUES (?, 'note_a', 'note.md', 'note.md', 'candidate.md', NULL, ?, 'r1', 'untracked_path', ?)`)
          .run('11111111-1111-4111-8111-111111111111\0hidden', 'a'.repeat(64), NOW),
      ).toThrow();
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM managed_note_conflicts').get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('adds schema v10 after the immutable provider, intake, artifact and prompt migrations', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(10);
    expect(SQLITE_MIGRATIONS).toHaveLength(10);
    expect(SQLITE_MIGRATIONS[7]?.statements.join('\n')).toContain('prompt_profile_history');
    expect(SQLITE_MIGRATIONS[1]?.parameterizedStatements).toHaveLength(7);
    expect(SQLITE_MIGRATIONS[2]?.version).toBe(3);
    expect(SQLITE_MIGRATIONS[2]?.statements.join('\n')).toContain('platform_package_manifest_path');
    expect(SQLITE_MIGRATIONS[3]?.version).toBe(4);
    expect(SQLITE_MIGRATIONS[3]?.statements.join('\n')).toContain('checked_at TEXT');
    expect(SQLITE_MIGRATIONS[4]?.version).toBe(5);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
    'upgrades a schema-v%i database while preserving legacy single-source jobs',
    (startingVersion) => {
      const database = new DatabaseSync(':memory:');
      try {
        applyMigrations(database, SQLITE_MIGRATIONS.slice(0, startingVersion), NOW);
        insertLegacyJob(database);

        applyMigrations(database, SQLITE_MIGRATIONS, LATER);

        expect(
          database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
        ).toEqual({ version: 10 });
        expect(
          database
            .prepare(
              'SELECT source_bundle_id AS sourceBundleId, source_count AS sourceCount FROM jobs WHERE id = ?',
            )
            .get(JOB_ID),
        ).toEqual({ sourceBundleId: null, sourceCount: 1 });

        const sourceTables = database
          .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('source_bundles', 'source_records') ORDER BY name",
          )
          .all() as { readonly name: string; readonly sql: string }[];
        expect(sourceTables.map(({ name }) => name)).toEqual(['source_bundles', 'source_records']);
        expect(sourceTables.every(({ sql }) => /\bSTRICT\s*$/iu.test(sql))).toBe(true);
      } finally {
        database.close();
      }
    },
  );

  it('rechecks migration state only after acquiring the immediate write lock', () => {
    const database = new RecordingDatabase();
    const migration: SqliteMigration = Object.freeze({
      version: 1,
      statements: Object.freeze(['CREATE TABLE probe (id INTEGER PRIMARY KEY) STRICT']),
    });

    applyMigrations(database as unknown as DatabaseSync, [migration], '2026-09-01T00:00:00.000Z');

    expect(database.events).toContain('max-version:locked');
    expect(database.events).toContain('find-version:locked');
    expect(database.events).toContain('record-version:locked');
    expect(database.events).not.toContain('max-version:unlocked');
    expect(database.events).not.toContain('find-version:unlocked');
  });

  it('creates strict managed tables idempotently and rolls a failed schema-9 upgrade back', () => {
    const database = new DatabaseSync(':memory:');
    try {
      applyMigrations(database, SQLITE_MIGRATIONS.slice(0, 9), NOW);
      insertLegacyJob(database);
      const migration = SQLITE_MIGRATIONS.at(-1);
      if (!migration) throw new Error('MISSING_MIGRATION');
      expect(() =>
        applyMigrations(
          database,
          [
            ...SQLITE_MIGRATIONS.slice(0, 9),
            { ...migration, statements: [...migration.statements, 'INVALID SQL'] },
          ],
          LATER,
        ),
      ).toThrow();
      expect(
        database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
      ).toEqual({ version: 9 });
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'managed_note_%'").all(),
      ).toEqual([]);
      applyMigrations(database);
      applyMigrations(database);
      expect(
        database
          .prepare(
            "SELECT name FROM pragma_table_list WHERE name LIKE 'managed_note_%' AND strict = 1 ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: 'managed_note_conflicts' }, { name: 'managed_note_history' }]);
      expect(database.prepare('SELECT id FROM jobs').all()).toEqual([{ id: JOB_ID }]);
    } finally {
      database.close();
    }
  });

  it.each([
    ['generated_base_hash', 'A'.repeat(64)],
    ['generated_base_hash', `${'a'.repeat(64)}\0hidden`],
    ['published_hash', 'short'],
    ['decision', 'conflict_preserved'],
    ['relative_path', '../escape.md'],
    ['relative_path', 'C:/escape.md'],
    ['path_key', '/absolute.md'],
    ['revision', -1],
    ['revision', 1.5],
    ['generation_revision', '../unsafe'],
    ['generation_revision', 'r1\0hidden'],
    ['stable_id', 'unsafe space'],
    ['stable_id', 'note_a\0hidden'],
  ])('rejects invalid SQL history %s = %j', (column, value) => {
    const database = new DatabaseSync(':memory:');
    try {
      applyMigrations(database);
      const fields = [
        'stable_id',
        'relative_path',
        'path_key',
        'generated_base',
        'generated_base_hash',
        'published_hash',
        'generation_revision',
        'revision',
        'decision',
        'created_at',
        'updated_at',
      ];
      const values = [
        'note_a',
        'note.md',
        'note.md',
        'base',
        'a'.repeat(64),
        'b'.repeat(64),
        'r1',
        0,
        'written',
        NOW,
        NOW,
      ];
      const parameters = values.map((original, index) =>
        fields[index] === column ? value : original,
      );
      expect(() =>
        database
          .prepare(
            `INSERT INTO managed_note_history (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
          )
          .run(...parameters),
      ).toThrow();
      expect(database.prepare('SELECT COUNT(*) AS count FROM managed_note_history').get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });
});
