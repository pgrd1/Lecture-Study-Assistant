import { access, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobRunner } from '../../src/application/jobs/jobRunner';
import { upgradeLegacySourceBundle } from '../../src/application/jobs/legacySourceBundle';
import { SourceArchiver } from '../../src/application/jobs/sourceArchiver';
import { VaultIndexRebuilder } from '../../src/application/jobs/vaultIndexRebuilder';
import { createJobFingerprint, sha256File } from '../../src/core/jobs/fingerprint';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import {
  MetadataError,
  type MetadataErrorCode,
} from '../../src/infrastructure/metadata/metadataError';
import { StatusReceiptSchema } from '../../src/shared/contracts/queue';
import { APP_ERROR_MESSAGES } from '../../src/shared/errors';
import { jobFixture, TEST_IDS } from '../testkit/fixtures';
import { createFoundationServices } from '../testkit/foundationServices';
import { offlineEvidenceRuntime } from '../testkit/offlineEvidenceRuntime';
import { seedV2QueueJob } from '../testkit/queueFixture';
import { withTempDirectory } from '../testkit/tempDirectory';

const text = 'An array stores ordered values.';
const seedV1 = async (queueRoot: string) => {
  const folder = join(queueRoot, 'Inbox', TEST_IDS.job);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'source.txt'), text);
  await writeFile(
    join(folder, 'manifest.json'),
    JSON.stringify({
      protocolVersion: 1,
      jobId: TEST_IDS.job,
      courseId: TEST_IDS.course,
      createdAt: '2026-09-01T00:00:00.000Z',
      source: { fileName: 'lecture.txt', mediaType: 'document' },
      summaryMode: 'standard',
    }),
  );
  await writeFile(join(folder, 'ready'), '');
  return folder;
};

describe('legacy intake into the real evidence runtime', () => {
  it.each(['intact', 'changed-hash', 'foreign-path'] as const)(
    'upgrades only the already owned immutable source: %s',
    async (mode) => {
      await withTempDirectory(async (root) => {
        const f = await createFoundationServices(root);
        try {
          await f.courseService.create({ name: 'Arrays', professorName: '' });
          const folder = join(f.paths.stagingRoot, TEST_IDS.job);
          await mkdir(folder);
          const path = join(folder, 'source.txt');
          await writeFile(path, text);
          const hash = await sha256File(path);
          const foreign = join(root, 'foreign.txt');
          await writeFile(foreign, text);
          const job = f.repositories.jobs.insert(
            jobFixture({
              sourceFileName: 'lecture.txt',
              sourceMediaType: 'document',
              stagedSourcePath: mode === 'foreign-path' ? foreign : path,
              sourceSha256: hash,
              fingerprint: createJobFingerprint(TEST_IDS.course, hash),
            }),
          );
          if (mode === 'changed-hash') await writeFile(path, 'changed original');
          const before = await lstat(path);
          const entries = await readdir(root, { recursive: true });
          if (mode !== 'intact') {
            await expect(
              upgradeLegacySourceBundle(job, f.paths.stagingRoot, f.repositories.sourceBundles),
            ).rejects.toMatchObject({ code: 'SOURCE_HASH_MISMATCH' });
            expect(f.repositories.jobs.get(job.id)).toEqual(job);
            expect(f.repositories.sourceBundles.getByJobId(job.id)).toBeNull();
          } else {
            const upgraded = await upgradeLegacySourceBundle(
              job,
              f.paths.stagingRoot,
              f.repositories.sourceBundles,
            );
            expect(
              await upgradeLegacySourceBundle(
                upgraded,
                f.paths.stagingRoot,
                f.repositories.sourceBundles,
              ),
            ).toEqual(upgraded);
            expect(
              f.repositories.sourceBundles.listRecords(upgraded.sourceBundleId ?? ''),
            ).toHaveLength(1);
          }
          const after = await lstat(path);
          expect([after.ino, after.size, after.mtimeMs]).toEqual([
            before.ino,
            before.size,
            before.mtimeMs,
          ]);
          expect(await readdir(root, { recursive: true })).toEqual(entries);
          expect(await readFile(foreign, 'utf8')).toBe(text);
        } finally {
          f.database.close();
        }
      });
    },
  );

  it('publishes an actual worker structural rejection as an unsupported-media receipt', async () => {
    await withTempDirectory(async (root) => {
      const f = await createFoundationServices(root);
      const runtime = await offlineEvidenceRuntime(join(root, 'App Data'), f.repositories);
      try {
        await f.courseService.create({ name: 'Arrays', professorName: '' });
        await seedV2QueueJob(f.paths.queueRoot, {
          sources: [
            {
              id: TEST_IDS.job,
              fileName: 'invalid.pdf',
              mediaType: 'document',
              sourceBytes: 'not a PDF',
            },
          ],
        });
        await f.queue.scanReady();
        await f.clock.advance(1500);
        expect(
          await f.createRunner({ processor: runtime.compatibilityProcessor }).pollOnce(),
        ).toMatchObject({ failed: 1 });
        expect(f.repositories.jobs.get(TEST_IDS.job)).toMatchObject({
          status: 'needs_attention',
          errorCode: 'PROVIDER_MEDIA_UNSUPPORTED',
        });
        expect(
          StatusReceiptSchema.parse(
            JSON.parse(
              await readFile(join(f.paths.queueRoot, 'Status', `${TEST_IDS.job}.json`), 'utf8'),
            ),
          ),
        ).toMatchObject({
          errorCode: 'PROVIDER_MEDIA_UNSUPPORTED',
          displayMessage: APP_ERROR_MESSAGES.PROVIDER_MEDIA_UNSUPPORTED,
        });
      } finally {
        await runtime.shutdown();
        f.database.close();
      }
    });
  });
  it('persists a new v1 singleton and completes the real six-stage path with v1 cleanup', async () => {
    await withTempDirectory(async (root) => {
      const f = await createFoundationServices(root);
      const runtime = await offlineEvidenceRuntime(join(root, 'App Data'), f.repositories);
      try {
        await f.courseService.create({ name: 'Arrays', professorName: '' });
        const folder = await seedV1(f.paths.queueRoot);
        await f.queue.scanReady();
        await f.clock.advance(1500);
        const runner = f.createRunner({ processor: runtime.compatibilityProcessor });
        const summary = await runner.pollOnce();
        expect({
          summary,
          error: f.repositories.jobs.get(TEST_IDS.job)?.errorCode,
          calls: f.repositories.providerInvocations
            .listForJob(TEST_IDS.job)
            .map((v) => [v.feature, v.errorCode]),
        }).toEqual({
          summary: { completed: 1, failed: 0, duplicates: 0 },
          error: null,
          calls: expect.any(Array),
        });
        const job = f.repositories.jobs.get(TEST_IDS.job);
        const bundle = f.repositories.sourceBundles.getByJobId(TEST_IDS.job);
        expect(job?.sourceBundleId).toBe(bundle?.id);
        expect(f.repositories.sourceBundles.listRecords(bundle?.id ?? '')).toEqual([
          expect.objectContaining({
            id: TEST_IDS.job,
            ordinal: 0,
            sizeBytes: 31,
            stagedPath: join(f.paths.stagingRoot, TEST_IDS.job, 'source.txt'),
          }),
        ]);
        expect(f.repositories.providerInvocations.listForJob(TEST_IDS.job)).toHaveLength(6);
        const archive = f.repositories.artifacts.get(TEST_IDS.job, 'source_archive');
        expect(
          await readFile(join(f.connection.managedRoot, archive?.relativePath ?? ''), 'utf8'),
        ).toBe(text);
        await expect(access(folder)).rejects.toBeDefined();
        await expect(access(join(f.paths.stagingRoot, TEST_IDS.job))).rejects.toBeDefined();
        expect(
          StatusReceiptSchema.parse(
            JSON.parse(
              await readFile(join(f.paths.queueRoot, 'Status', `${TEST_IDS.job}.json`), 'utf8'),
            ),
          ),
        ).toMatchObject({ status: 'completed' });
        expect(await runner.pollOnce()).toEqual({ completed: 0, failed: 0, duplicates: 0 });
        const rebuilder = new VaultIndexRebuilder({
          connection: f.connection,
          courses: f.repositories.courses,
          jobs: f.repositories.jobs,
          artifacts: f.repositories.artifacts,
          sourceBundles: f.repositories.sourceBundles,
          vault: f.vault,
        });
        await rebuilder.rebuild();
        expect(rebuilder.listRecoveryIssues()).toEqual([]);
        await writeFile(
          join(f.connection.managedRoot, archive?.relativePath ?? ''),
          'tampered archive',
        );
        await rebuilder.rebuild();
        expect(rebuilder.listRecoveryIssues()).toEqual([
          expect.objectContaining({ code: 'invalid-integrity' }),
        ]);
      } finally {
        await runtime.shutdown();
        f.database.close();
      }
    });
  });

  it('upgrades a restarted null-bundle job without changing its owned source and keeps deterministic identity', async () => {
    await withTempDirectory(async (root) => {
      const f = await createFoundationServices(root);
      await f.courseService.create({ name: 'Arrays', professorName: '' });
      const path = join(f.paths.stagingRoot, TEST_IDS.job, 'source.txt');
      await mkdir(join(f.paths.stagingRoot, TEST_IDS.job));
      await writeFile(path, text);
      const hash = await sha256File(path);
      f.repositories.jobs.insert(
        jobFixture({
          sourceKind: 'local',
          sourceFileName: 'lecture.txt',
          sourceMediaType: 'document',
          stagedSourcePath: path,
          sourceSha256: hash,
          fingerprint: createJobFingerprint(TEST_IDS.course, hash),
          status: 'source_ready',
          lastSuccessfulStatus: 'source_ready',
        }),
      );
      f.database.close();
      const database = openDatabase(f.paths.databasePath);
      const repositories = createRepositories(database);
      const runtime = await offlineEvidenceRuntime(join(root, 'App Data'), repositories);
      const runner = new JobRunner({
        artifacts: repositories.artifacts,
        courses: repositories.courses,
        jobs: repositories.jobs,
        sourceBundles: repositories.sourceBundles,
        queue: f.queue,
        vault: f.vault,
        courseProvisioner: f.courseService,
        processor: runtime.compatibilityProcessor,
        stagingRoot: f.paths.stagingRoot,
        sourceArchiver: new SourceArchiver({
          artifacts: repositories.artifacts,
          connection: f.connection,
          vault: f.vault,
        }),
        stagingCleaner: { cleanup: async () => undefined },
      });
      let bundleId: string | undefined;
      try {
        expect(await runner.resumeInterrupted()).toMatchObject({ completed: 1, failed: 0 });
        bundleId = repositories.sourceBundles.getByJobId(TEST_IDS.job)?.id;
        expect(bundleId).toBeDefined();
        expect(await readFile(path, 'utf8')).toBe(text);
        expect(repositories.providerInvocations.listForJob(TEST_IDS.job)).toHaveLength(6);
      } finally {
        await runtime.shutdown();
        database.close();
      }
      const reopened = openDatabase(f.paths.databasePath);
      try {
        expect(createRepositories(reopened).sourceBundles.getByJobId(TEST_IDS.job)?.id).toBe(
          bundleId,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it.each([
    ['METADATA_CANCELLED', 'PROVIDER_CANCELLED', 'needs_attention'],
    ['METADATA_TIMEOUT', 'PROVIDER_TIMEOUT', 'retryable_failed'],
    ['METADATA_BUSY', 'PROVIDER_BUSY', 'retryable_failed'],
    ['METADATA_UNSUPPORTED', 'PROVIDER_MEDIA_UNSUPPORTED', 'needs_attention'],
    ['METADATA_INVALID', 'PROVIDER_MEDIA_UNSUPPORTED', 'needs_attention'],
    ['METADATA_LIMIT', 'SOURCE_TOO_LARGE', 'needs_attention'],
    ['METADATA_IDENTITY', 'SOURCE_HASH_MISMATCH', 'needs_attention'],
    ['lookalike', 'UNEXPECTED_ERROR', 'needs_attention'],
  ] as const)(
    'publishes actionable metadata failure %s through JobRunner and receipts',
    async (metadataCode, code, status) => {
      await withTempDirectory(async (root) => {
        const f = await createFoundationServices(root);
        const runtime = await offlineEvidenceRuntime(join(root, 'App Data'), f.repositories, {
          measure: async () => {
            throw metadataCode === 'lookalike'
              ? { code: 'METADATA_TIMEOUT', private: 'secret' }
              : new MetadataError(metadataCode as MetadataErrorCode);
          },
        });
        try {
          await f.courseService.create({ name: 'Arrays', professorName: '' });
          await seedV2QueueJob(f.paths.queueRoot, {
            sources: [
              {
                id: TEST_IDS.job,
                fileName: 'lecture.txt',
                mediaType: 'document',
                sourceBytes: text,
              },
            ],
          });
          await f.queue.scanReady();
          await f.clock.advance(1500);
          expect(
            await f.createRunner({ processor: runtime.compatibilityProcessor }).pollOnce(),
          ).toMatchObject({ completed: 0, failed: 1 });
          expect(f.repositories.jobs.get(TEST_IDS.job)).toMatchObject({ status, errorCode: code });
          const raw = await readFile(
            join(f.paths.queueRoot, 'Status', `${TEST_IDS.job}.json`),
            'utf8',
          );
          expect(StatusReceiptSchema.parse(JSON.parse(raw))).toMatchObject({
            status: 'failed',
            errorCode: code,
            displayMessage: APP_ERROR_MESSAGES[code],
          });
          expect(raw).not.toContain('secret');
          expect(raw).not.toContain(root);
          expect(f.repositories.providerInvocations.listForJob(TEST_IDS.job)).toHaveLength(0);
        } finally {
          await runtime.shutdown();
          f.database.close();
        }
      });
    },
  );
});
