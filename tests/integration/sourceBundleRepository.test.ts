import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import {
  type SourceBundle,
  SourceBundleSchema,
  type SourceRecord,
  SourceRecordSchema,
} from '../../src/shared/contracts/sourceBundle';
import { courseFixture, jobFixture } from '../testkit/fixtures';
import { withTempDirectory } from '../testkit/tempDirectory';

const NOW = '2026-09-06T09:00:00.000Z';
const BUNDLE_ID = '33333333-3333-4333-8333-333333333333';
const FIRST_SOURCE_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_SOURCE_ID = '55555555-5555-4555-8555-555555555555';

const sourceBundleFixture = (overrides: Partial<SourceBundle> = {}): SourceBundle =>
  SourceBundleSchema.parse({
    id: BUNDLE_ID,
    jobId: jobFixture().id,
    manifestSha256: 'a'.repeat(64),
    sourceCount: 2,
    totalBytes: 46,
    stagingDirectoryPath: `C:\\app\\staging\\${BUNDLE_ID}`,
    createdAt: NOW,
    ...overrides,
  });

const sourceRecordFixture = (overrides: Partial<SourceRecord> = {}): SourceRecord =>
  SourceRecordSchema.parse({
    id: FIRST_SOURCE_ID,
    bundleId: BUNDLE_ID,
    ordinal: 0,
    originalFileName: 'lecture.m4a',
    mediaType: 'audio',
    stagedPath: `C:\\app\\staging\\${BUNDLE_ID}\\lecture.m4a`,
    sha256: 'b'.repeat(64),
    sizeBytes: 12,
    ...overrides,
  });

const secondSourceRecordFixture = (overrides: Partial<SourceRecord> = {}): SourceRecord =>
  sourceRecordFixture({
    id: SECOND_SOURCE_ID,
    ordinal: 1,
    originalFileName: 'board.jpg',
    mediaType: 'image',
    stagedPath: `C:\\app\\staging\\${BUNDLE_ID}\\board.jpg`,
    sha256: 'c'.repeat(64),
    sizeBytes: 34,
    ...overrides,
  });

describe('SQLite source bundle repository', () => {
  it('atomically attaches a legacy singleton or rolls back every upgrade row', async () => {
    await withTempDirectory((root) => {
      const database = openDatabase(join(root, 'upgrade.sqlite'));
      try {
        const repositories = createRepositories(database);
        repositories.courses.insert(courseFixture());
        const job = repositories.jobs.insert(jobFixture());
        const bundle = sourceBundleFixture({ sourceCount: 1, totalBytes: 12 });
        const record = sourceRecordFixture({
          id: job.id,
          originalFileName: job.sourceFileName,
          mediaType: job.sourceMediaType,
          stagedPath: job.stagedSourcePath,
          sha256: job.sourceSha256,
        });
        database
          .prepare(
            "CREATE TRIGGER reject_upgrade BEFORE INSERT ON source_records BEGIN SELECT RAISE(ABORT, 'TEST_FAIL'); END",
          )
          .run();
        expect(() => repositories.sourceBundles.attachLegacyBundle(job, bundle, [record])).toThrow(
          'DATABASE_ERROR',
        );
        expect(repositories.jobs.get(job.id)).toEqual(job);
        expect(repositories.sourceBundles.getByJobId(job.id)).toBeNull();
        expect(repositories.sourceBundles.listRecords(bundle.id)).toEqual([]);
        database.prepare('DROP TRIGGER reject_upgrade').run();
        const upgraded = repositories.sourceBundles.attachLegacyBundle(job, bundle, [record]);
        expect(upgraded).toMatchObject({ sourceBundleId: bundle.id, revision: job.revision + 1 });
        expect(repositories.sourceBundles.listRecords(bundle.id)).toEqual([record]);
        expect(() =>
          repositories.sourceBundles.attachLegacyBundle(job, bundle, [record]),
        ).toThrow();
        expect(repositories.jobs.get(job.id)).toEqual(upgraded);
      } finally {
        database.close();
      }
    });
  });
  it('inserts one immutable bundle and lists its source records by ordinal', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repositories = createRepositories(database);
        const bundle = sourceBundleFixture();
        const first = sourceRecordFixture();
        const second = secondSourceRecordFixture();
        repositories.courses.insert(courseFixture());
        const persistedJob = repositories.jobs.insert(
          jobFixture({ sourceBundleId: bundle.id, sourceCount: bundle.sourceCount }),
        );

        expect(persistedJob).toMatchObject({
          sourceBundleId: bundle.id,
          sourceCount: bundle.sourceCount,
        });
        expect(repositories.sourceBundles.insert(bundle, [second, first])).toEqual(bundle);
        const persistedBundle = repositories.sourceBundles.getByJobId(bundle.jobId);
        const persistedRecords = repositories.sourceBundles.listRecords(bundle.id);

        expect(persistedBundle).toEqual(bundle);
        expect(persistedRecords).toEqual([first, second]);
        expect(Object.isFrozen(persistedBundle)).toBe(true);
        expect(Object.isFrozen(persistedRecords)).toBe(true);
        expect(persistedRecords.every(Object.isFrozen)).toBe(true);
        expect(repositories.sourceBundles).not.toHaveProperty('delete');
        expect(() => repositories.sourceBundles.insert(bundle, [first, second])).toThrowError(
          expect.objectContaining({ code: 'STALE_WRITE' }),
        );
      } finally {
        database.close();
      }
    });
  });

  it('rolls back the bundle and every prior record when one record violates uniqueness', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repositories = createRepositories(database);
        const bundle = sourceBundleFixture();
        const first = sourceRecordFixture();
        const duplicateHash = secondSourceRecordFixture({ sha256: first.sha256 });
        repositories.courses.insert(courseFixture());
        repositories.jobs.insert(jobFixture());

        expect(() => repositories.sourceBundles.insert(bundle, [first, duplicateHash])).toThrow(
          'DATABASE_ERROR',
        );
        expect(repositories.sourceBundles.getByJobId(bundle.jobId)).toBeNull();
        expect(repositories.sourceBundles.listRecords(bundle.id)).toEqual([]);
        expect(() =>
          repositories.sourceBundles.insert(bundle, [first, secondSourceRecordFixture()]),
        ).not.toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('rolls back the job, bundle, and every record when an atomic insert fails', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repositories = createRepositories(database);
        const bundle = sourceBundleFixture();
        const job = jobFixture({ sourceBundleId: bundle.id, sourceCount: bundle.sourceCount });
        const first = sourceRecordFixture();
        const duplicateHash = secondSourceRecordFixture({ sha256: first.sha256 });
        repositories.courses.insert(courseFixture());

        expect(() =>
          repositories.sourceBundles.insertJobWithBundle(job, bundle, [first, duplicateHash]),
        ).toThrow('DATABASE_ERROR');

        expect(repositories.jobs.get(job.id)).toBeNull();
        expect(repositories.sourceBundles.getByJobId(job.id)).toBeNull();
        expect(repositories.sourceBundles.listRecords(bundle.id)).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('rejects malformed source bundle and source record rows at the read boundary', async () => {
    await withTempDirectory((directory) => {
      const databasePath = join(directory, 'study.sqlite3');
      const firstDatabase = openDatabase(databasePath);
      const bundle = sourceBundleFixture();
      try {
        const repositories = createRepositories(firstDatabase);
        repositories.courses.insert(courseFixture());
        repositories.jobs.insert(jobFixture());
        repositories.sourceBundles.insert(bundle, [
          sourceRecordFixture(),
          secondSourceRecordFixture(),
        ]);
      } finally {
        firstDatabase.close();
      }

      const corrupter = new DatabaseSync(databasePath);
      try {
        corrupter
          .prepare('UPDATE source_bundles SET manifest_sha256 = ? WHERE id = ?')
          .run('not-a-sha256', bundle.id);
        corrupter
          .prepare('UPDATE source_records SET sha256 = ? WHERE id = ?')
          .run('not-a-sha256', FIRST_SOURCE_ID);
      } finally {
        corrupter.close();
      }

      const reopened = openDatabase(databasePath);
      try {
        const repositories = createRepositories(reopened);
        expect(() => repositories.sourceBundles.getByJobId(bundle.jobId)).toThrow('DATABASE_ERROR');
        expect(() => repositories.sourceBundles.listRecords(bundle.id)).toThrow('DATABASE_ERROR');
      } finally {
        reopened.close();
      }
    });
  });

  it('validates aggregate linkage before writing and returns empty reads for missing ids', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repositories = createRepositories(database);
        const bundle = sourceBundleFixture();
        repositories.courses.insert(courseFixture());
        repositories.jobs.insert(jobFixture());

        expect(() =>
          repositories.sourceBundles.insert(bundle, [
            sourceRecordFixture(),
            secondSourceRecordFixture({ bundleId: randomUUID() }),
          ]),
        ).toThrow('DATABASE_ERROR');
        expect(repositories.sourceBundles.getByJobId(randomUUID())).toBeNull();
        expect(repositories.sourceBundles.listRecords(randomUUID())).toEqual([]);
      } finally {
        database.close();
      }
    });
  });
});
