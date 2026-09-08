import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyMigrations, type SqliteMigration } from '../../src/infrastructure/db/migrations';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import { CourseSchema } from '../../src/shared/contracts/course';
import { JobSchema } from '../../src/shared/contracts/job';
import { JobArtifactSchema } from '../../src/shared/contracts/jobArtifact';
import { AppSettingsSchema } from '../../src/shared/contracts/settings';
import { courseFixture, jobFixture, TEST_IDS } from '../testkit/fixtures';
import { withTempDirectory } from '../testkit/tempDirectory';

const NOW = '2026-09-01T00:00:00.000Z';
const LATER = '2026-09-01T01:00:00.000Z';

const settingsFixture = () =>
  AppSettingsSchema.parse({
    schemaVersion: 1,
    vaultPath: 'C:\\Obsidian\\Study',
    icloudQueuePath: null,
    defaultSummaryMode: 'standard',
    autoStart: false,
    processingPaused: false,
    legalNoticeAcceptedAt: null,
    updatedAt: NOW,
    revision: 0,
  });

describe('SQLite repositories', () => {
  it('rejects an in-memory database that cannot provide WAL durability', () => {
    const unexpectedlyOpened: ReturnType<typeof openDatabase>[] = [];
    try {
      expect(() => unexpectedlyOpened.push(openDatabase(':memory:'))).toThrow('DATABASE_ERROR');
    } finally {
      for (const database of unexpectedlyOpened) {
        database.close();
      }
    }
  });

  it('persists courses, settings, and an interrupted job across reopen', async () => {
    await withTempDirectory((directory) => {
      const databasePath = join(directory, 'study.sqlite3');
      const first = openDatabase(databasePath);
      const reposA = createRepositories(first);

      reposA.courses.insert(courseFixture());
      reposA.jobs.insert(
        jobFixture({ status: 'structuring', lastSuccessfulStatus: 'source_ready' }),
      );
      reposA.settings.insert(settingsFixture());
      first.close();

      const second = openDatabase(databasePath);
      try {
        const reposB = createRepositories(second);
        expect(reposB.courses.list({ includeArchived: false })).toEqual([courseFixture()]);
        expect(reposB.jobs.listRecoverable()).toEqual([
          expect.objectContaining({
            status: 'structuring',
            lastSuccessfulStatus: 'source_ready',
          }),
        ]);
        expect(reposB.settings.get()).toEqual(settingsFixture());
        expect(Object.isFrozen(reposB.courses.list())).toBe(true);
      } finally {
        second.close();
      }
    });
  });

  it('enforces course-folder and course-scoped source-fingerprint uniqueness', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repos = createRepositories(database);
        const firstCourse = courseFixture();
        const secondCourse = courseFixture({
          id: randomUUID(),
          name: '운영체제',
          folderName: '운영체제',
        });
        repos.courses.insert(firstCourse);
        repos.courses.insert(secondCourse);

        expect(() =>
          repos.courses.insert(
            courseFixture({ id: randomUUID(), name: '자료구조 복제', folderName: '자료구조' }),
          ),
        ).toThrow('DUPLICATE_COURSE');

        const fingerprint = 'a'.repeat(64);
        repos.jobs.insert(jobFixture({ fingerprint }));
        expect(() => repos.jobs.insert(jobFixture({ id: randomUUID(), fingerprint }))).toThrow(
          'DUPLICATE_JOB',
        );

        expect(() =>
          repos.jobs.insert(
            jobFixture({ id: randomUUID(), courseId: secondCourse.id, fingerprint }),
          ),
        ).not.toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('uses immutable optimistic updates and rejects stale revisions', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repos = createRepositories(database);
        const originalCourse = repos.courses.insert(courseFixture());
        const originalJob = repos.jobs.insert(jobFixture());
        const originalSettings = repos.settings.insert(settingsFixture());

        const updatedCourse = CourseSchema.parse({
          ...originalCourse,
          name: '고급 자료구조',
          updatedAt: LATER,
          revision: 1,
        });
        const updatedJob = JobSchema.parse({
          ...originalJob,
          status: 'receiving',
          updatedAt: LATER,
          revision: 1,
        });
        const updatedSettings = AppSettingsSchema.parse({
          ...originalSettings,
          processingPaused: true,
          updatedAt: LATER,
          revision: 1,
        });

        expect(repos.courses.update(updatedCourse, 0)).toEqual(updatedCourse);
        expect(repos.jobs.update(updatedJob, 0)).toEqual(updatedJob);
        expect(repos.settings.update(updatedSettings, 0)).toEqual(updatedSettings);
        expect(originalCourse.name).toBe('자료구조');
        expect(originalJob.status).toBe('queued');
        expect(originalSettings.processingPaused).toBe(false);

        expect(() => repos.courses.update(updatedCourse, 0)).toThrow('STALE_WRITE');
        expect(() => repos.jobs.update(updatedJob, 0)).toThrow('STALE_WRITE');
        expect(() => repos.settings.update(updatedSettings, 0)).toThrow('STALE_WRITE');
        expect(() =>
          repos.jobs.update(
            JobSchema.parse({
              ...updatedJob,
              stagedSourcePath: 'C:\\app\\staging\\changed\\source.m4a',
              updatedAt: '2026-09-01T02:00:00.000Z',
              revision: 2,
            }),
            1,
          ),
        ).toThrow('STALE_WRITE');
      } finally {
        database.close();
      }
    });
  });

  it('lists all jobs while recovering only unattended work and finds fingerprints', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repos = createRepositories(database);
        repos.courses.insert(courseFixture());
        const queued = repos.jobs.insert(jobFixture());
        repos.jobs.insert(
          jobFixture({
            id: '44444444-4444-4444-8444-444444444444',
            fingerprint: 'c'.repeat(64),
            status: 'completed',
            lastSuccessfulStatus: 'completed',
          }),
        );
        repos.jobs.insert(
          jobFixture({
            id: '55555555-5555-4555-8555-555555555555',
            fingerprint: 'd'.repeat(64),
            status: 'needs_attention',
            errorCode: 'DATABASE_ERROR',
          }),
        );

        expect(repos.jobs.list()).toHaveLength(3);
        expect(repos.jobs.listRecoverable()).toEqual([queued]);
        expect(repos.jobs.get(queued.id)).toEqual(queued);
        expect(repos.jobs.get(randomUUID())).toBeNull();
        expect(repos.jobs.findByFingerprint(queued.courseId, queued.fingerprint)).toEqual(queued);
        expect(repos.jobs.findByFingerprint(queued.courseId, 'e'.repeat(64))).toBeNull();
        expect(Object.isFrozen(repos.jobs.list())).toBe(true);
        expect(() => repos.jobs.get('not-a-uuid')).toThrow('DATABASE_ERROR');
        expect(() =>
          repos.jobs.findByFingerprint(queued.courseId, queued.fingerprint.toUpperCase()),
        ).toThrow('DATABASE_ERROR');
      } finally {
        database.close();
      }
    });
  });

  it('persists immutable job artifacts and enforces one record per artifact kind', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repos = createRepositories(database);
        repos.courses.insert(courseFixture());
        const job = repos.jobs.insert(jobFixture());
        const artifact = JobArtifactSchema.parse({
          jobId: job.id,
          kind: 'recording_note',
          relativePath: `과목/자료구조/녹음/${job.id}.md`,
          sha256: 'f'.repeat(64),
          createdAt: NOW,
        });

        expect(repos.artifacts.insert(artifact)).toEqual(artifact);
        expect(repos.artifacts.get(job.id, 'recording_note')).toEqual(artifact);
        expect(repos.artifacts.listByJob(job.id)).toEqual([artifact]);
        expect(Object.isFrozen(repos.artifacts.listByJob(job.id))).toBe(true);
        expect(() => repos.artifacts.insert(artifact)).toThrow('DATABASE_ERROR');
      } finally {
        database.close();
      }
    });
  });

  it('creates strict versioned tables with hardened runtime pragmas', async () => {
    await withTempDirectory((directory) => {
      const databasePath = join(directory, 'study.sqlite3');
      const database = openDatabase(databasePath);
      try {
        expect(database.getRuntimeConfiguration()).toEqual({
          journalMode: 'wal',
          foreignKeys: true,
          busyTimeoutMs: 5_000,
          synchronous: 'full',
        });
        expect(database.getSchemaVersion()).toBeGreaterThan(0);
      } finally {
        database.close();
      }

      const inspector = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const tables = z
          .array(z.strictObject({ name: z.string(), sql: z.string() }))
          .parse(
            inspector
              .prepare(
                "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
              )
              .all(),
          );
        expect(tables.map(({ name }) => name)).toEqual([
          'courses',
          'job_artifacts',
          'jobs',
          'managed_note_conflicts',
          'managed_note_history',
          'pipeline_artifacts',
          'prompt_profile_history',
          'prompt_profiles',
          'provider_diagnostics',
          'provider_invocations',
          'provider_routes',
          'schema_migrations',
          'settings',
          'source_bundles',
          'source_records',
        ]);
        expect(tables.every(({ sql }) => /\bSTRICT\s*$/i.test(sql))).toBe(true);
      } finally {
        inspector.close();
      }
    });
  });

  it('rolls back an entire migration before recording its version', () => {
    const database = new DatabaseSync(':memory:');
    const failingMigration: SqliteMigration = Object.freeze({
      version: 99,
      statements: Object.freeze([
        'CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY) STRICT',
        'THIS IS NOT VALID SQL',
      ]),
    });

    try {
      expect(() => applyMigrations(database, [failingMigration], LATER)).toThrow(
        'DATABASE_MIGRATION_FAILED',
      );
      const probe = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('rollback_probe');
      const recorded = database
        .prepare('SELECT version FROM schema_migrations WHERE version = ?')
        .get(failingMigration.version);
      expect(probe).toBeUndefined();
      expect(recorded).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('rejects jobs whose course does not exist', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repos = createRepositories(database);
        expect(() => repos.jobs.insert(jobFixture({ courseId: randomUUID() }))).toThrow(
          'DATABASE_ERROR',
        );
        expect(repos.jobs.get(TEST_IDS.job)).toBeNull();
      } finally {
        database.close();
      }
    });
  });

  it('rejects a persisted row that fails the shared job contract', async () => {
    await withTempDirectory((directory) => {
      const databasePath = join(directory, 'study.sqlite3');
      const database = openDatabase(databasePath);
      const repos = createRepositories(database);
      repos.courses.insert(courseFixture());
      repos.jobs.insert(jobFixture());
      database.close();

      const corrupter = new DatabaseSync(databasePath);
      try {
        corrupter.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('forged', TEST_IDS.job);
      } finally {
        corrupter.close();
      }

      const reopened = openDatabase(databasePath);
      try {
        expect(() => createRepositories(reopened).jobs.get(TEST_IDS.job)).toThrow('DATABASE_ERROR');
      } finally {
        reopened.close();
      }
    });
  });
});
