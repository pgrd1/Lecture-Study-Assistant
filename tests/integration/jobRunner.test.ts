import { access, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CourseService } from '../../src/application/courses/courseService';
import { LocalSourceIntake } from '../../src/application/jobs/localSourceIntake';
import { SourceArchiver } from '../../src/application/jobs/sourceArchiver';
import type { StagingSourceCleanerPort } from '../../src/application/jobs/stagingSourceCleaner';
import { VaultIndexRebuilder } from '../../src/application/jobs/vaultIndexRebuilder';
import { sha256File } from '../../src/core/jobs/fingerprint';
import type { CourseCatalog } from '../../src/core/ports/courseCatalog';
import type { CourseProvisioner } from '../../src/core/ports/courseProvisioner';
import type { JobArtifactRepository } from '../../src/core/ports/jobArtifactRepository';
import type { JobRepository } from '../../src/core/ports/jobRepository';
import type { ProcessorPort } from '../../src/core/ports/processor';
import type { QueuePort } from '../../src/core/ports/queue';
import type { SourceBundleRepository } from '../../src/core/ports/sourceBundleRepository';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import { SqliteSourceBundleRepository } from '../../src/infrastructure/db/sqliteSourceBundleRepository';
import { ICloudQueue } from '../../src/infrastructure/queue/icloudQueue';
import { FakeProcessor } from '../../src/processors/fakeProcessor';
import { RejectionReceiptSchema, StatusReceiptSchema } from '../../src/shared/contracts/queue';
import { APP_ERROR_MESSAGES, AppError } from '../../src/shared/errors';
import { TEST_IDS } from '../testkit/fixtures';
import { createFoundationServices } from '../testkit/foundationServices';
import { seedCourseQueueJob, seedQueueJob, seedV2QueueJob } from '../testkit/queueFixture';
import { withTempDirectory } from '../testkit/tempDirectory';

const SECOND_JOB_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_COURSE_ID = '77777777-7777-4777-8777-777777777777';

describe('JobRunner', () => {
  it.each(['local-first', 'shortcut-first'] as const)(
    'deduplicates singleton local and v2 intake in %s order',
    async (order) => {
      await withTempDirectory(async (root) => {
        const services = await createFoundationServices(root);
        try {
          const course = await services.courseService.create({
            name: '자료구조',
            professorName: '',
          });
          const sourcePath = join(root, 'lecture.m4a');
          await writeFile(sourcePath, 'shared singleton bytes');
          const enqueue = () =>
            services.localIntake.enqueue({
              courseId: course.id,
              filePaths: [sourcePath],
              summaryMode: 'standard',
            });
          if (order === 'local-first') await enqueue();
          await seedV2QueueJob(services.paths.queueRoot, {
            sources: [
              {
                id: SECOND_JOB_ID,
                fileName: 'lecture.m4a',
                mediaType: 'audio',
                sourceBytes: 'shared singleton bytes',
              },
            ],
          });
          await services.queue.scanReady();
          await services.clock.advance(1_500);
          const result = await services.runner.pollOnce();
          if (order === 'shortcut-first') {
            await expect(enqueue()).rejects.toMatchObject({ code: 'DUPLICATE_JOB' });
          } else {
            expect(result.duplicates).toBe(1);
          }
          expect(services.repositories.jobs.list()).toHaveLength(1);
        } finally {
          services.database.close();
        }
      });
    },
  );

  it.each(['intact', 'tampered', 'missing', 'lost-database'] as const)(
    'verifies completed bundle evidence after restart: %s',
    async (evidence) => {
      await withTempDirectory(async (root) => {
        const services = await createFoundationServices(root);
        await services.courseService.create({ name: '자료구조', professorName: '' });
        await seedV2QueueJob(services.paths.queueRoot);
        await services.queue.scanReady();
        await services.clock.advance(1_500);
        expect(await services.runner.pollOnce()).toMatchObject({ completed: 1 });
        const bundle = services.repositories.sourceBundles.getByJobId(TEST_IDS.job);
        const second = services.repositories.sourceBundles.listRecords(bundle?.id ?? '')[1];
        if (evidence === 'tampered') await writeFile(second?.stagedPath ?? '', 'tampered');
        if (evidence === 'missing') await unlink(second?.stagedPath ?? '');
        services.database.close();
        const database = openDatabase(
          evidence === 'lost-database' ? join(root, 'fresh.sqlite') : services.paths.databasePath,
        );
        try {
          const repositories = createRepositories(database);
          const rebuilder = new VaultIndexRebuilder({
            connection: services.connection,
            courses: repositories.courses,
            jobs: repositories.jobs,
            artifacts: repositories.artifacts,
            sourceBundles: repositories.sourceBundles,
            vault: services.vault,
          });
          expect(await rebuilder.rebuild()).toMatchObject({ jobs: 0 });
          expect(rebuilder.listRecoveryIssues()).toEqual(
            evidence === 'intact' ? [] : [expect.objectContaining({ code: 'invalid-integrity' })],
          );
          if (evidence === 'intact') {
            expect(repositories.jobs.get(TEST_IDS.job)).toMatchObject({
              sourceCount: 2,
              sourceBundleId: bundle?.id,
            });
          }
          if (evidence === 'lost-database') expect(repositories.jobs.list()).toEqual([]);
        } finally {
          database.close();
        }
      });
    },
  );

  it('claims a ready job, writes a note, archives source, and completes once', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const course = await services.courseService.create({
          name: '자료구조',
          professorName: '김교수',
        });
        const seeded = await seedQueueJob(services.paths.queueRoot);
        const sourceHash = await sha256File(seeded.sourcePath);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);

        expect(await services.runner.pollOnce()).toEqual({
          completed: 1,
          failed: 0,
          duplicates: 0,
        });

        const recordingNotePath = join(
          services.connection.managedRoot,
          '과목',
          course.folderName,
          '녹음',
          `${TEST_IDS.job}.md`,
        );
        const archivedAudioPath = join(
          services.connection.managedRoot,
          '과목',
          course.folderName,
          '자료',
          '음성',
          `${TEST_IDS.job}.m4a`,
        );
        expect(await readFile(recordingNotePath, 'utf8')).toContain(
          '가짜 처리 결과 — 실제 전사 아님',
        );
        expect(await sha256File(archivedAudioPath)).toBe(sourceHash);
        expect(services.repositories.jobs.get(TEST_IDS.job)).toMatchObject({
          sourceBundleId: services.repositories.sourceBundles.getByJobId(TEST_IDS.job)?.id,
          sourceCount: 1,
          status: 'completed',
        });

        const receipt = StatusReceiptSchema.parse(
          JSON.parse(
            await readFile(
              join(services.paths.queueRoot, 'Status', `${TEST_IDS.job}.json`),
              'utf8',
            ),
          ),
        );
        expect(receipt.status).toBe('completed');
        await expect(access(seeded.folderPath)).rejects.toBeDefined();
        await expect(access(join(services.paths.stagingRoot, TEST_IDS.job))).rejects.toBeDefined();
        expect(await services.runner.pollOnce()).toEqual({
          completed: 0,
          failed: 0,
          duplicates: 0,
        });
      } finally {
        services.database.close();
      }
    });
  });

  it('links one protocol-v2 job to every immutable claimed source', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        await services.courseService.create({ name: '자료구조', professorName: '' });
        const seeded = await seedV2QueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);

        expect(await services.runner.pollOnce()).toEqual({
          completed: 1,
          failed: 0,
          duplicates: 0,
        });

        const job = services.repositories.jobs.get(TEST_IDS.job);
        expect(job).toMatchObject({
          sourceFileName: 'lecture.m4a',
          sourceBundleId: expect.any(String),
          sourceCount: 2,
          status: 'completed',
        });
        const bundle = services.repositories.sourceBundles.getByJobId(TEST_IDS.job);
        expect(bundle).toMatchObject({ sourceCount: 2, totalBytes: 28 });
        expect(services.repositories.sourceBundles.listRecords(bundle?.id ?? '')).toMatchObject([
          { ordinal: 0, originalFileName: 'lecture.m4a' },
          { ordinal: 1, originalFileName: 'board.jpg' },
        ]);
        await expect(access(bundle?.stagingDirectoryPath ?? '')).resolves.toBeUndefined();
        await expect(access(seeded.folderPath)).rejects.toBeDefined();
      } finally {
        services.database.close();
      }
    });
  });

  it('provisions one shared CourseInbox course before processing both lectures', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const publishedCourseIds: string[][] = [];
        const catalog = Object.freeze({
          publish: async (courses) => {
            publishedCourseIds.push(courses.map((course) => course.id));
          },
        } satisfies CourseCatalog);
        const courseProvisioner = new CourseService({
          repository: services.repositories.courses,
          vault: services.vault,
          catalog,
          clock: () => services.clock.now(),
        });
        const fakeProcessor = new FakeProcessor();
        const processedJobs: string[] = [];
        const processor = Object.freeze({
          process: async (input) => {
            expect(services.repositories.courses.get(input.courseId)).not.toBeNull();
            expect(publishedCourseIds.at(-1)).toContain(input.courseId);
            processedJobs.push(input.jobId);
            return fakeProcessor.process(input);
          },
        } satisfies ProcessorPort);
        const receiptStatuses = new Map<string, string[]>();
        const observedQueue = Object.freeze({
          scanReady: () => services.queue.scanReady(),
          claim: (item, stagingRoot) => services.queue.claim(item, stagingRoot),
          writeReceipt: async (receipt) => {
            receiptStatuses.set(receipt.jobId, [
              ...(receiptStatuses.get(receipt.jobId) ?? []),
              receipt.status,
            ]);
            await services.queue.writeReceipt(receipt);
          },
          writeRejection: (receipt) => services.queue.writeRejection(receipt),
          removeCompleted: (jobId, sourceKind) => services.queue.removeCompleted(jobId, sourceKind),
        } satisfies QueuePort);
        const first = await seedCourseQueueJob(services.paths.queueRoot, {
          course: { id: TEST_IDS.course, name: '운영체제', professorName: '김교수' },
        });
        const second = await seedCourseQueueJob(services.paths.queueRoot, {
          jobId: SECOND_JOB_ID,
          sourceBytes: 'second lecture bytes',
          course: { id: TEST_IDS.course, name: '운영체제', professorName: '김교수' },
        });
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        const runner = services.createRunner({
          courseProvisioner,
          processor,
          queue: observedQueue,
        });

        await expect(runner.pollOnce()).resolves.toEqual({
          completed: 2,
          failed: 0,
          duplicates: 0,
        });

        expect(services.repositories.courses.list()).toHaveLength(1);
        expect(services.repositories.courses.get(TEST_IDS.course)).toMatchObject({
          name: '운영체제',
          professorName: '김교수',
        });
        expect(processedJobs.toSorted()).toEqual([SECOND_JOB_ID, TEST_IDS.job].toSorted());
        for (const jobId of [TEST_IDS.job, SECOND_JOB_ID]) {
          expect(services.repositories.jobs.get(jobId)).toMatchObject({
            sourceKind: 'icloud_course',
            status: 'completed',
          });
          expect(receiptStatuses.get(jobId)).toEqual(['processing', 'completed']);
          const note = await readFile(
            join(services.connection.managedRoot, '과목', '운영체제', '녹음', `${jobId}.md`),
            'utf8',
          );
          expect(note).toContain('source_kind: "icloud_course"');
        }
        await expect(access(first.folderPath)).rejects.toBeDefined();
        await expect(access(second.folderPath)).rejects.toBeDefined();
      } finally {
        services.database.close();
      }
    });
  });

  it('keeps the PC-renamed active course authoritative for a CourseInbox lecture', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const created = await services.courseService.create({
          name: '운영체제',
          professorName: '모바일 교수',
        });
        const renamed = await services.courseService.update(created.id, {
          name: '고급 운영체제',
          professorName: 'PC 교수',
        });
        const seeded = await seedCourseQueueJob(services.paths.queueRoot, {
          course: { id: created.id, name: '운영체제', professorName: '모바일 교수' },
        });
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);

        expect(await services.runner.pollOnce()).toMatchObject({ completed: 1, failed: 0 });

        expect(services.repositories.courses.get(created.id)).toEqual(renamed);
        expect(services.repositories.jobs.get(TEST_IDS.job)).toMatchObject({
          sourceKind: 'icloud_course',
          status: 'completed',
        });
        await expect(access(seeded.folderPath)).rejects.toBeDefined();
      } finally {
        services.database.close();
      }
    });
  });

  it('rejects an archived CourseInbox course without reviving it', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const created = await services.courseService.create({
          name: '운영체제',
          professorName: '',
        });
        const archived = await services.courseService.archive(created.id);
        const seeded = await seedCourseQueueJob(services.paths.queueRoot, {
          course: { id: created.id, name: '모바일 운영체제', professorName: '' },
        });
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);

        expect(await services.runner.pollOnce()).toEqual({
          completed: 0,
          failed: 1,
          duplicates: 0,
        });

        expect(services.repositories.courses.get(created.id)).toEqual(archived);
        expect(services.repositories.jobs.list()).toEqual([]);
        expect(
          RejectionReceiptSchema.parse(
            JSON.parse(
              await readFile(
                join(services.paths.queueRoot, 'Rejected', `${TEST_IDS.job}.json`),
                'utf8',
              ),
            ),
          ),
        ).toMatchObject({ errorCode: 'COURSE_NOT_FOUND' });
        await expect(access(seeded.folderPath)).resolves.toBeUndefined();
      } finally {
        services.database.close();
      }
    });
  });

  it('rejects a new CourseInbox ID whose derived folder belongs to another course', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        await services.courseService.create({ name: '운영체제', professorName: '' });
        const seeded = await seedCourseQueueJob(services.paths.queueRoot, {
          course: { id: OTHER_COURSE_ID, name: '운영체제', professorName: '다른 교수' },
        });
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);

        expect(await services.runner.pollOnce()).toEqual({
          completed: 0,
          failed: 1,
          duplicates: 0,
        });

        expect(services.repositories.courses.get(OTHER_COURSE_ID)).toBeNull();
        expect(services.repositories.jobs.list()).toEqual([]);
        expect(
          RejectionReceiptSchema.parse(
            JSON.parse(
              await readFile(
                join(services.paths.queueRoot, 'Rejected', `${TEST_IDS.job}.json`),
                'utf8',
              ),
            ),
          ),
        ).toMatchObject({ errorCode: 'DUPLICATE_COURSE' });
        await expect(access(seeded.folderPath)).resolves.toBeUndefined();
      } finally {
        services.database.close();
      }
    });
  });

  it('durably rejects a trusted INVALID_COURSE provisioning failure', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const seeded = await seedCourseQueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        const runner = services.createRunner({
          courseProvisioner: Object.freeze({
            provision: async () => {
              throw new AppError('INVALID_COURSE', APP_ERROR_MESSAGES.INVALID_COURSE);
            },
          }),
        });

        expect(await runner.pollOnce()).toEqual({ completed: 0, failed: 1, duplicates: 0 });

        expect(services.repositories.jobs.list()).toEqual([]);
        await expect(access(join(services.paths.stagingRoot, TEST_IDS.job))).rejects.toBeDefined();
        expect(
          RejectionReceiptSchema.parse(
            JSON.parse(
              await readFile(
                join(services.paths.queueRoot, 'Rejected', `${TEST_IDS.job}.json`),
                'utf8',
              ),
            ),
          ),
        ).toMatchObject({ errorCode: 'INVALID_COURSE' });
        await expect(access(seeded.folderPath)).resolves.toBeUndefined();
      } finally {
        services.database.close();
      }
    });
  });

  it.each([
    ['trusted', new AppError('QUEUE_WRITE_FAILED', APP_ERROR_MESSAGES.QUEUE_WRITE_FAILED)],
    ['untrusted', new TypeError('PRIVATE_CATALOG_FAILURE')],
  ] as const)(
    'retains a CourseInbox bundle after a %s provisioning failure and completes after restart',
    async (_kind, injectedError) => {
      await withTempDirectory(async (root) => {
        const services = await createFoundationServices(root);
        try {
          let failPublication = true;
          const catalog = Object.freeze({
            publish: async () => {
              if (failPublication) {
                failPublication = false;
                throw injectedError;
              }
            },
          } satisfies CourseCatalog);
          const courseProvisioner = new CourseService({
            repository: services.repositories.courses,
            vault: services.vault,
            catalog,
            clock: () => services.clock.now(),
          });
          const seeded = await seedCourseQueueJob(services.paths.queueRoot, {
            course: { id: TEST_IDS.course, name: '운영체제', professorName: '' },
          });
          expect(await services.queue.scanReady()).toEqual([]);
          await services.clock.advance(1_500);
          const firstRunner = services.createRunner({ courseProvisioner });

          expect(await firstRunner.pollOnce()).toEqual({
            completed: 0,
            failed: 1,
            duplicates: 0,
          });

          expect(services.repositories.jobs.list()).toEqual([]);
          await expect(
            access(join(services.paths.stagingRoot, TEST_IDS.job)),
          ).rejects.toBeDefined();
          expect((await readdir(seeded.folderPath)).toSorted()).toEqual([
            'ready',
            'request.json',
            'source.m4a',
          ]);
          await expect(
            access(join(services.paths.queueRoot, 'Inbox', TEST_IDS.job)),
          ).resolves.toBeUndefined();
          await expect(
            access(join(services.paths.queueRoot, 'Rejected', `${TEST_IDS.job}.json`)),
          ).rejects.toBeDefined();
          const rawFailure = await readFile(
            join(services.paths.queueRoot, 'Status', `${TEST_IDS.job}.json`),
            'utf8',
          );
          expect(StatusReceiptSchema.parse(JSON.parse(rawFailure))).toMatchObject({
            status: 'failed',
            errorCode:
              injectedError instanceof AppError ? 'QUEUE_WRITE_FAILED' : 'UNEXPECTED_ERROR',
          });
          expect(rawFailure).not.toContain('PRIVATE_CATALOG_FAILURE');
          expect(rawFailure).not.toContain(seeded.folderPath);

          const restartedRunner = services.createRunner({ courseProvisioner });
          expect(await restartedRunner.pollOnce()).toEqual({
            completed: 1,
            failed: 0,
            duplicates: 0,
          });
          expect(services.repositories.jobs.get(TEST_IDS.job)).toMatchObject({
            sourceKind: 'icloud_course',
            status: 'completed',
          });
          await expect(access(seeded.folderPath)).rejects.toBeDefined();
          await expect(
            access(join(services.paths.queueRoot, 'Inbox', TEST_IDS.job)),
          ).rejects.toBeDefined();
        } finally {
          services.database.close();
        }
      });
    },
  );

  it('reports provisioning and cleanup failures while keeping retryable intake reachable', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const provisioningError = new TypeError('PRIVATE_PROVISIONING_FAILURE');
        const cleanupError = new TypeError('PRIVATE_STAGING_CLEANUP_FAILURE');
        const operationalErrors: unknown[] = [];
        let provisioningAttempts = 0;
        const courseProvisioner: CourseProvisioner = Object.freeze({
          provision: async (input: Parameters<CourseProvisioner['provision']>[0]) => {
            provisioningAttempts += 1;
            if (provisioningAttempts === 1) {
              throw provisioningError;
            }
            return services.courseService.provision(input);
          },
        });
        let cleanupAttempts = 0;
        const stagingCleaner = Object.freeze({
          cleanup: async (candidate) => {
            cleanupAttempts += 1;
            if (cleanupAttempts === 1) {
              throw cleanupError;
            }
            await services.stagingCleaner.cleanup(candidate);
          },
        } satisfies StagingSourceCleanerPort);
        const seeded = await seedCourseQueueJob(services.paths.queueRoot, {
          course: { id: TEST_IDS.course, name: '운영체제', professorName: '' },
        });
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        const firstRunner = services.createRunner({
          courseProvisioner,
          stagingCleaner,
          onOperationalError: (error) => operationalErrors.push(error),
        });

        expect(await firstRunner.pollOnce()).toEqual({
          completed: 0,
          failed: 1,
          duplicates: 0,
        });

        expect(operationalErrors).toEqual([provisioningError, cleanupError]);
        expect(services.repositories.jobs.list()).toEqual([]);
        await expect(
          access(join(services.paths.stagingRoot, TEST_IDS.job)),
        ).resolves.toBeUndefined();
        expect((await readdir(seeded.folderPath)).toSorted()).toEqual([
          'ready',
          'request.json',
          'source.m4a',
        ]);
        await expect(
          access(join(services.paths.queueRoot, 'Inbox', TEST_IDS.job)),
        ).resolves.toBeUndefined();
        await expect(
          access(join(services.paths.queueRoot, 'Rejected', `${TEST_IDS.job}.json`)),
        ).rejects.toBeDefined();
        const rawFailure = await readFile(
          join(services.paths.queueRoot, 'Status', `${TEST_IDS.job}.json`),
          'utf8',
        );
        expect(StatusReceiptSchema.parse(JSON.parse(rawFailure))).toMatchObject({
          status: 'failed',
          displayMessage: APP_ERROR_MESSAGES.UNEXPECTED_ERROR,
          errorCode: 'UNEXPECTED_ERROR',
        });
        expect(rawFailure).not.toContain('PRIVATE_PROVISIONING_FAILURE');
        expect(rawFailure).not.toContain('PRIVATE_STAGING_CLEANUP_FAILURE');
        expect(rawFailure).not.toContain(seeded.folderPath);

        const restartedQueue = new ICloudQueue(services.paths.queueRoot, {
          clock: () => Date.parse(services.clock.now()),
        });
        expect(await restartedQueue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        const restartedRunner = services.createRunner({
          courseProvisioner,
          queue: restartedQueue,
          stagingCleaner,
          onOperationalError: (error) => operationalErrors.push(error),
        });
        expect(await restartedRunner.pollOnce()).toEqual({
          completed: 1,
          failed: 0,
          duplicates: 0,
        });
        expect(provisioningAttempts).toBe(2);
        expect(cleanupAttempts).toBe(2);
        expect(operationalErrors).toEqual([provisioningError, cleanupError]);
        expect(services.repositories.jobs.get(TEST_IDS.job)).toMatchObject({
          sourceKind: 'icloud_course',
          status: 'completed',
        });
        await expect(access(seeded.folderPath)).rejects.toBeDefined();
        await expect(
          access(join(services.paths.queueRoot, 'Inbox', TEST_IDS.job)),
        ).rejects.toBeDefined();
        await expect(access(join(services.paths.stagingRoot, TEST_IDS.job))).rejects.toBeDefined();
      } finally {
        services.database.close();
      }
    });
  });

  it('defers permanent rejection until failed staging cleanup succeeds on a later poll', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const provisioningError = new AppError(
          'DUPLICATE_COURSE',
          APP_ERROR_MESSAGES.DUPLICATE_COURSE,
        );
        const cleanupError = new TypeError('PRIVATE_STAGING_CLEANUP_FAILURE');
        const operationalErrors: unknown[] = [];
        let provisioningAttempts = 0;
        const courseProvisioner = Object.freeze({
          provision: async () => {
            provisioningAttempts += 1;
            throw provisioningError;
          },
        });
        let cleanupAttempts = 0;
        const stagingCleaner = Object.freeze({
          cleanup: async (candidate) => {
            cleanupAttempts += 1;
            if (cleanupAttempts === 1) {
              throw cleanupError;
            }
            await services.stagingCleaner.cleanup(candidate);
          },
        } satisfies StagingSourceCleanerPort);
        const seeded = await seedCourseQueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        const runner = services.createRunner({
          courseProvisioner,
          stagingCleaner,
          onOperationalError: (error) => operationalErrors.push(error),
        });

        expect(await runner.pollOnce()).toEqual({ completed: 0, failed: 1, duplicates: 0 });

        expect(operationalErrors).toEqual([provisioningError, cleanupError]);
        expect(services.repositories.jobs.list()).toEqual([]);
        await expect(
          access(join(services.paths.stagingRoot, TEST_IDS.job)),
        ).resolves.toBeUndefined();
        await expect(access(seeded.folderPath)).resolves.toBeUndefined();
        await expect(
          access(join(services.paths.queueRoot, 'Inbox', TEST_IDS.job)),
        ).resolves.toBeUndefined();
        await expect(
          access(join(services.paths.queueRoot, 'Rejected', `${TEST_IDS.job}.json`)),
        ).rejects.toBeDefined();
        const firstStatus = await readFile(
          join(services.paths.queueRoot, 'Status', `${TEST_IDS.job}.json`),
          'utf8',
        );
        expect(StatusReceiptSchema.parse(JSON.parse(firstStatus))).toMatchObject({
          status: 'failed',
          errorCode: 'DUPLICATE_COURSE',
        });
        expect(firstStatus).not.toContain('PRIVATE_STAGING_CLEANUP_FAILURE');

        expect(await runner.pollOnce()).toEqual({ completed: 0, failed: 1, duplicates: 0 });

        expect(provisioningAttempts).toBe(2);
        expect(cleanupAttempts).toBe(2);
        expect(operationalErrors).toEqual([provisioningError, cleanupError]);
        expect(services.repositories.jobs.list()).toEqual([]);
        await expect(access(join(services.paths.stagingRoot, TEST_IDS.job))).rejects.toBeDefined();
        expect(
          RejectionReceiptSchema.parse(
            JSON.parse(
              await readFile(
                join(services.paths.queueRoot, 'Rejected', `${TEST_IDS.job}.json`),
                'utf8',
              ),
            ),
          ),
        ).toMatchObject({ status: 'failed', errorCode: 'DUPLICATE_COURSE' });
        await expect(access(seeded.folderPath)).resolves.toBeUndefined();
      } finally {
        services.database.close();
      }
    });
  });

  it('uses a completed job persisted lane when a restarted runner sees the same queue ID', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const seeded = await seedCourseQueueJob(services.paths.queueRoot, {
          course: { id: TEST_IDS.course, name: '운영체제', professorName: '' },
        });
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        const leaveBundleQueue = Object.freeze({
          scanReady: () => services.queue.scanReady(),
          claim: (item, stagingRoot) => services.queue.claim(item, stagingRoot),
          writeReceipt: (receipt) => services.queue.writeReceipt(receipt),
          writeRejection: (receipt) => services.queue.writeRejection(receipt),
          removeCompleted: async () => undefined,
        } satisfies QueuePort);
        const firstRunner = services.createRunner({
          courseProvisioner: services.courseService,
          queue: leaveBundleQueue,
        });

        expect(await firstRunner.pollOnce()).toMatchObject({ completed: 1 });
        expect(services.repositories.jobs.get(TEST_IDS.job)).toMatchObject({
          sourceKind: 'icloud_course',
          status: 'completed',
          cleanupWarningCode: null,
        });
        await expect(access(seeded.folderPath)).resolves.toBeUndefined();

        const restartedRunner = services.createRunner({
          courseProvisioner: services.courseService,
        });
        expect(await restartedRunner.pollOnce()).toEqual({
          completed: 0,
          failed: 0,
          duplicates: 0,
        });
        expect(services.repositories.jobs.get(TEST_IDS.job)?.sourceKind).toBe('icloud_course');
        await expect(access(seeded.folderPath)).rejects.toBeDefined();
        expect(
          StatusReceiptSchema.parse(
            JSON.parse(
              await readFile(
                join(services.paths.queueRoot, 'Status', `${TEST_IDS.job}.json`),
                'utf8',
              ),
            ),
          ).status,
        ).toBe('completed');
      } finally {
        services.database.close();
      }
    });
  });

  it('resumes after completed-receipt failure without producing a second note', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        await services.courseService.create({ name: '자료구조', professorName: '' });
        await seedQueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        let rejectCompletedReceipt = true;
        const faultQueue = Object.freeze({
          scanReady: () => services.queue.scanReady(),
          claim: (item, stagingRoot) => services.queue.claim(item, stagingRoot),
          writeReceipt: async (receipt) => {
            if (receipt.status === 'completed' && rejectCompletedReceipt) {
              rejectCompletedReceipt = false;
              throw new AppError('QUEUE_WRITE_FAILED', APP_ERROR_MESSAGES.QUEUE_WRITE_FAILED);
            }
            await services.queue.writeReceipt(receipt);
          },
          writeRejection: (receipt) => services.queue.writeRejection(receipt),
          removeCompleted: (jobId, sourceKind) => services.queue.removeCompleted(jobId, sourceKind),
        } satisfies QueuePort);
        const runner = services.createRunner({ queue: faultQueue });

        expect(await runner.pollOnce()).toEqual({ completed: 0, failed: 1, duplicates: 0 });
        expect(services.repositories.jobs.get(TEST_IDS.job)?.status).toBe('retryable_failed');
        const recordingDirectory = join(
          services.connection.managedRoot,
          '과목',
          '자료구조',
          '녹음',
        );
        expect((await readdir(recordingDirectory)).filter((name) => name.endsWith('.md'))).toEqual([
          `${TEST_IDS.job}.md`,
        ]);

        expect(await runner.resumeInterrupted()).toEqual({
          completed: 1,
          failed: 0,
          duplicates: 0,
        });
        expect((await readdir(recordingDirectory)).filter((name) => name.endsWith('.md'))).toEqual([
          `${TEST_IDS.job}.md`,
        ]);
        expect(services.repositories.jobs.get(TEST_IDS.job)?.status).toBe('completed');
      } finally {
        services.database.close();
      }
    });
  });

  it('removes only its claimed staging copy after a database insert crash', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        await services.courseService.create({ name: '자료구조', professorName: '' });
        await seedQueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        let failInsert = true;
        const realJobs = services.repositories.jobs;
        const failingJobs = Object.freeze({
          get: (id) => realJobs.get(id),
          list: () => realJobs.list(),
          listRecoverable: () => realJobs.listRecoverable(),
          findByFingerprint: (courseId, fingerprint) =>
            realJobs.findByFingerprint(courseId, fingerprint),
          insert: (job) => {
            if (failInsert) {
              failInsert = false;
              throw new AppError('DATABASE_ERROR', APP_ERROR_MESSAGES.DATABASE_ERROR);
            }
            return realJobs.insert(job);
          },
          update: (job, revision) => realJobs.update(job, revision),
        } satisfies JobRepository);
        const failingRunner = services.createRunner({
          jobs: failingJobs,
          sourceBundles: new SqliteSourceBundleRepository(services.database, failingJobs),
        });

        expect(await failingRunner.pollOnce()).toEqual({
          completed: 0,
          failed: 1,
          duplicates: 0,
        });
        expect(realJobs.get(TEST_IDS.job)).toBeNull();
        await expect(access(join(services.paths.stagingRoot, TEST_IDS.job))).rejects.toBeDefined();

        expect(await services.runner.pollOnce()).toEqual({
          completed: 1,
          failed: 0,
          duplicates: 0,
        });
        await expect(access(join(services.paths.stagingRoot, TEST_IDS.job))).rejects.toBeDefined();
        expect(realJobs.list()).toHaveLength(1);
      } finally {
        services.database.close();
      }
    });
  });

  it('keeps a cleanup warning and retries source deletion without duplicating the job', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        await services.courseService.create({ name: '자료구조', professorName: '' });
        const seeded = await seedQueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        let failCleanup = true;
        const faultQueue = Object.freeze({
          scanReady: () => services.queue.scanReady(),
          claim: (item, stagingRoot) => services.queue.claim(item, stagingRoot),
          writeReceipt: (receipt) => services.queue.writeReceipt(receipt),
          writeRejection: (receipt) => services.queue.writeRejection(receipt),
          removeCompleted: async (jobId, sourceKind) => {
            if (failCleanup) {
              failCleanup = false;
              throw new AppError('QUEUE_WRITE_FAILED', APP_ERROR_MESSAGES.QUEUE_WRITE_FAILED);
            }
            await services.queue.removeCompleted(jobId, sourceKind);
          },
        } satisfies QueuePort);
        const runner = services.createRunner({ queue: faultQueue });

        expect(await runner.pollOnce()).toMatchObject({ completed: 1 });
        expect(services.repositories.jobs.get(TEST_IDS.job)?.cleanupWarningCode).toBe(
          'QUEUE_CLEANUP_FAILED',
        );
        await expect(access(seeded.folderPath)).resolves.toBeUndefined();

        expect(await runner.pollOnce()).toEqual({ completed: 0, failed: 0, duplicates: 0 });
        expect(services.repositories.jobs.get(TEST_IDS.job)?.cleanupWarningCode).toBeNull();
        await expect(access(seeded.folderPath)).rejects.toBeDefined();
        expect(services.repositories.jobs.list()).toHaveLength(1);
      } finally {
        services.database.close();
      }
    });
  });

  it('removes the staged copy before durably rejecting an unknown course', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        await seedQueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);

        expect(await services.runner.pollOnce()).toEqual({
          completed: 0,
          failed: 1,
          duplicates: 0,
        });
        await expect(access(join(services.paths.stagingRoot, TEST_IDS.job))).rejects.toBeDefined();
        await expect(
          access(join(services.paths.queueRoot, 'Rejected', `${TEST_IDS.job}.json`)),
        ).resolves.toBeUndefined();
        expect(
          StatusReceiptSchema.parse(
            JSON.parse(
              await readFile(
                join(services.paths.queueRoot, 'Status', `${TEST_IDS.job}.json`),
                'utf8',
              ),
            ),
          ),
        ).toMatchObject({ status: 'failed', errorCode: 'COURSE_NOT_FOUND' });
        expect(
          RejectionReceiptSchema.parse(
            JSON.parse(
              await readFile(
                join(services.paths.queueRoot, 'Rejected', `${TEST_IDS.job}.json`),
                'utf8',
              ),
            ),
          ),
        ).toMatchObject({ status: 'failed', errorCode: 'COURSE_NOT_FOUND' });
        expect(services.repositories.jobs.list()).toEqual([]);
      } finally {
        services.database.close();
      }
    });
  });

  it('removes a duplicate claim staging copy before writing its rejection', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        await services.courseService.create({ name: '자료구조', professorName: '' });
        await seedQueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        expect(await services.runner.pollOnce()).toMatchObject({ completed: 1 });

        const duplicateId = '77777777-7777-4777-8777-777777777777';
        await seedQueueJob(services.paths.queueRoot, { jobId: duplicateId });
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        expect(await services.runner.pollOnce()).toEqual({
          completed: 0,
          failed: 0,
          duplicates: 1,
        });
        await expect(access(join(services.paths.stagingRoot, duplicateId))).rejects.toBeDefined();
        await expect(
          access(join(services.paths.queueRoot, 'Rejected', `${duplicateId}.json`)),
        ).resolves.toBeUndefined();
        expect(services.repositories.jobs.list()).toHaveLength(1);
      } finally {
        services.database.close();
      }
    });
  });

  it('copies a PC-selected file without changing it and deduplicates within each course', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const courseA = await services.courseService.create({
          name: '자료구조',
          professorName: '',
        });
        const courseB = await services.courseService.create({
          name: '알고리즘',
          professorName: '',
        });
        const sourceDirectory = join(root, 'PC 입력');
        const original = join(sourceDirectory, '직접 입력.m4a');
        const sourceBytes = Buffer.from('same local lecture bytes');
        await mkdir(sourceDirectory);
        await writeFile(original, sourceBytes);

        const [accepted] = await services.localIntake.enqueue({
          courseId: courseA.id,
          filePaths: [original],
          summaryMode: 'standard',
        });
        expect(accepted).toBeDefined();
        expect(await readFile(original)).toEqual(sourceBytes);
        expect(await readFile(accepted?.stagedSourcePath ?? '')).toEqual(sourceBytes);
        expect(await services.runner.pollOnce()).toMatchObject({ completed: 1 });
        await expect(access(accepted?.stagedSourcePath ?? '')).resolves.toBeUndefined();

        await expect(
          services.localIntake.enqueue({
            courseId: courseA.id,
            filePaths: [original],
            summaryMode: 'standard',
          }),
        ).rejects.toMatchObject({ code: 'DUPLICATE_JOB' });
        await expect(
          services.localIntake.enqueue({
            courseId: courseB.id,
            filePaths: [original],
            summaryMode: 'standard',
          }),
        ).resolves.toHaveLength(1);
        expect(await readFile(original)).toEqual(sourceBytes);
      } finally {
        services.database.close();
      }
    });
  });

  it('creates one job and two immutable source records for two dropped files', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const course = await services.courseService.create({ name: '자료구조', professorName: '' });
        const audioPath = join(root, '강의.m4a');
        const imagePath = join(root, '칠판.jpg');
        await writeFile(audioPath, 'audio bytes');
        await writeFile(imagePath, 'image bytes');

        const jobs = await services.localIntake.enqueue({
          courseId: course.id,
          filePaths: [audioPath, imagePath],
          summaryMode: 'standard',
        });

        expect(jobs).toHaveLength(1);
        const [job] = jobs;
        expect(job).toMatchObject({
          sourceFileName: '강의.m4a',
          sourceCount: 2,
        });
        const bundle = services.repositories.sourceBundles.getByJobId(job?.id ?? '');
        expect(bundle).toMatchObject({ jobId: job?.id, sourceCount: 2 });
        expect(services.repositories.sourceBundles.listRecords(bundle?.id ?? '')).toHaveLength(2);
        await expect(readFile(audioPath, 'utf8')).resolves.toBe('audio bytes');
        await expect(readFile(imagePath, 'utf8')).resolves.toBe('image bytes');
      } finally {
        services.database.close();
      }
    });
  });

  it('deduplicates an exact ordered local bundle but accepts one changed member', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const course = await services.courseService.create({ name: '자료구조', professorName: '' });
        const audioPath = join(root, '강의.m4a');
        const firstImagePath = join(root, '첫 칠판.jpg');
        const changedImagePath = join(root, '바뀐 칠판.jpg');
        await writeFile(audioPath, 'shared audio bytes');
        await writeFile(firstImagePath, 'first image bytes');
        await writeFile(changedImagePath, 'changed image bytes');

        const [first] = await services.localIntake.enqueue({
          courseId: course.id,
          filePaths: [audioPath, firstImagePath],
          summaryMode: 'standard',
        });
        await expect(
          services.localIntake.enqueue({
            courseId: course.id,
            filePaths: [audioPath, firstImagePath],
            summaryMode: 'full',
          }),
        ).rejects.toMatchObject({ code: 'DUPLICATE_JOB' });
        const [changed] = await services.localIntake.enqueue({
          courseId: course.id,
          filePaths: [audioPath, changedImagePath],
          summaryMode: 'standard',
        });

        expect(services.repositories.jobs.list()).toHaveLength(2);
        expect(changed?.fingerprint).not.toBe(first?.fingerprint);
        expect(
          services.repositories.sourceBundles.listRecords(changed?.sourceBundleId ?? ''),
        ).toMatchObject([
          { ordinal: 0, originalFileName: '강의.m4a' },
          { ordinal: 1, originalFileName: '바뀐 칠판.jpg' },
        ]);
      } finally {
        services.database.close();
      }
    });
  });

  it('rejects local intake for archived courses before creating staging or database rows', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const course = await services.courseService.create({ name: '자료구조', professorName: '' });
        await services.courseService.archive(course.id);
        const sourcePath = join(root, '강의.m4a');
        await writeFile(sourcePath, 'original audio bytes');

        await expect(
          services.localIntake.enqueue({
            courseId: course.id,
            filePaths: [sourcePath],
            summaryMode: 'standard',
          }),
        ).rejects.toMatchObject({ code: 'COURSE_NOT_FOUND' });

        expect(await readdir(services.paths.stagingRoot)).toEqual([]);
        expect(services.repositories.jobs.list()).toEqual([]);
        expect(await readFile(sourcePath, 'utf8')).toBe('original audio bytes');
      } finally {
        services.database.close();
      }
    });
  });

  it('rejects unsafe and repeated local paths without staging either source', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const course = await services.courseService.create({ name: '자료구조', professorName: '' });
        const sourcePath = join(root, '강의.m4a');
        await writeFile(sourcePath, 'original audio bytes');

        await expect(
          services.localIntake.enqueue({
            courseId: course.id,
            filePaths: ['relative.m4a'],
            summaryMode: 'standard',
          }),
        ).rejects.toMatchObject({ code: 'SOURCE_COPY_FAILED' });
        await expect(
          services.localIntake.enqueue({
            courseId: course.id,
            filePaths: [sourcePath, sourcePath],
            summaryMode: 'standard',
          }),
        ).rejects.toMatchObject({ code: 'SOURCE_COPY_FAILED' });

        expect(await readdir(services.paths.stagingRoot)).toEqual([]);
        expect(services.repositories.jobs.list()).toEqual([]);
        expect(await readFile(sourcePath, 'utf8')).toBe('original audio bytes');
      } finally {
        services.database.close();
      }
    });
  });

  it('removes only its owned staging directory when the atomic database commit fails', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const course = await services.courseService.create({ name: '자료구조', professorName: '' });
        const audioPath = join(root, '강의.m4a');
        const imagePath = join(root, '칠판.jpg');
        await writeFile(audioPath, 'original audio bytes');
        await writeFile(imagePath, 'original image bytes');
        const realBundles = services.repositories.sourceBundles;
        const failingBundles = Object.freeze({
          insert: (bundle, records) => realBundles.insert(bundle, records),
          attachLegacyBundle: (job, bundle, records) =>
            realBundles.attachLegacyBundle(job, bundle, records),
          insertJobWithBundle: () => {
            throw new AppError('DATABASE_BUSY', APP_ERROR_MESSAGES.DATABASE_BUSY);
          },
          getByJobId: (jobId) => realBundles.getByJobId(jobId),
          listRecords: (bundleId) => realBundles.listRecords(bundleId),
        } satisfies SourceBundleRepository);
        const intake = new LocalSourceIntake({
          courses: services.repositories.courses,
          jobs: services.repositories.jobs,
          sourceBundles: failingBundles,
          stagingRoot: services.paths.stagingRoot,
          clock: () => services.clock.now(),
        });

        await expect(
          intake.enqueue({
            courseId: course.id,
            filePaths: [audioPath, imagePath],
            summaryMode: 'standard',
          }),
        ).rejects.toMatchObject({ code: 'DATABASE_BUSY' });

        expect(await readdir(services.paths.stagingRoot)).toEqual([]);
        expect(services.repositories.jobs.list()).toEqual([]);
        expect(await readFile(audioPath, 'utf8')).toBe('original audio bytes');
        expect(await readFile(imagePath, 'utf8')).toBe('original image bytes');
      } finally {
        services.database.close();
      }
    });
  });

  it('adopts one deterministic generated note after a crash before artifact insertion', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const course = await services.courseService.create({ name: '자료구조', professorName: '' });
        const recordingDirectory = join(
          services.connection.managedRoot,
          '과목',
          course.folderName,
          '녹음',
        );
        await writeFile(
          join(recordingDirectory, `${TEST_IDS.job}.md`),
          '사용자가 만든 충돌 노트',
          'utf8',
        );
        await seedQueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);

        let failRecordingArtifact = true;
        const realArtifacts = services.repositories.artifacts;
        const failingArtifacts = Object.freeze({
          get: (jobId, kind) => realArtifacts.get(jobId, kind),
          listByJob: (jobId) => realArtifacts.listByJob(jobId),
          insert: (artifact) => {
            if (artifact.kind === 'recording_note' && failRecordingArtifact) {
              failRecordingArtifact = false;
              throw new AppError('DATABASE_BUSY', APP_ERROR_MESSAGES.DATABASE_BUSY);
            }
            return realArtifacts.insert(artifact);
          },
        } satisfies JobArtifactRepository);
        const crashingRunner = services.createRunner({ artifacts: failingArtifacts });

        expect(await crashingRunner.pollOnce()).toEqual({
          completed: 0,
          failed: 1,
          duplicates: 0,
        });
        expect(services.repositories.jobs.get(TEST_IDS.job)?.status).toBe('retryable_failed');
        expect(await services.runner.resumeInterrupted()).toEqual({
          completed: 1,
          failed: 0,
          duplicates: 0,
        });

        const notes = (await readdir(recordingDirectory)).filter((name) => name.endsWith('.md'));
        expect(notes).toHaveLength(2);
        expect(notes.some((name) => name.includes('.generated-'))).toBe(true);
        const appNotes = await Promise.all(
          notes.map((name) => readFile(join(recordingDirectory, name), 'utf8')),
        );
        expect(appNotes.filter((content) => content.includes('가짜 처리 결과'))).toHaveLength(1);
        expect(await readFile(join(recordingDirectory, `${TEST_IDS.job}.md`), 'utf8')).toBe(
          '사용자가 만든 충돌 노트',
        );
      } finally {
        services.database.close();
      }
    });
  });

  it('adopts one deterministic source archive after a crash before artifact insertion', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const course = await services.courseService.create({ name: '자료구조', professorName: '' });
        const archiveDirectory = join(
          services.connection.managedRoot,
          '과목',
          course.folderName,
          '자료',
          '음성',
        );
        const desiredArchive = join(archiveDirectory, `${TEST_IDS.job}.m4a`);
        await writeFile(desiredArchive, '사용자가 만든 충돌 음성', 'utf8');
        const seeded = await seedQueueJob(services.paths.queueRoot);
        const sourceHash = await sha256File(seeded.sourcePath);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);

        let failArchiveArtifact = true;
        const realArtifacts = services.repositories.artifacts;
        const failingArtifacts = Object.freeze({
          get: (jobId, kind) => realArtifacts.get(jobId, kind),
          listByJob: (jobId) => realArtifacts.listByJob(jobId),
          insert: (artifact) => {
            if (artifact.kind === 'source_archive' && failArchiveArtifact) {
              failArchiveArtifact = false;
              throw new AppError('DATABASE_BUSY', APP_ERROR_MESSAGES.DATABASE_BUSY);
            }
            return realArtifacts.insert(artifact);
          },
        } satisfies JobArtifactRepository);
        const crashingArchiver = new SourceArchiver({
          artifacts: failingArtifacts,
          connection: services.connection,
          vault: services.vault,
          clock: () => services.clock.now(),
        });
        const crashingRunner = services.createRunner({ sourceArchiver: crashingArchiver });

        expect(await crashingRunner.pollOnce()).toMatchObject({ completed: 0, failed: 1 });
        expect(await services.runner.resumeInterrupted()).toMatchObject({
          completed: 1,
          failed: 0,
        });

        const archives = (await readdir(archiveDirectory)).filter((name) => name.endsWith('.m4a'));
        expect(archives).toHaveLength(2);
        expect(archives.some((name) => name.includes('.generated-'))).toBe(true);
        const matchingSources = await Promise.all(
          archives.map(
            async (name) => (await sha256File(join(archiveDirectory, name))) === sourceHash,
          ),
        );
        expect(matchingSources.filter(Boolean)).toHaveLength(1);
        expect(await readFile(desiredArchive, 'utf8')).toBe('사용자가 만든 충돌 음성');
      } finally {
        services.database.close();
      }
    });
  });

  it('preserves immutable local bundle staging after completion', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const course = await services.courseService.create({ name: '자료구조', professorName: '' });
        const original = join(root, '로컬 강의.m4a');
        await writeFile(original, 'local cleanup fixture');
        const [job] = await services.localIntake.enqueue({
          courseId: course.id,
          filePaths: [original],
          summaryMode: 'standard',
        });
        if (job === undefined) {
          throw new TypeError('TEST_JOB_MISSING');
        }
        const cleanup = vi.fn(async () => undefined);
        const faultCleaner = Object.freeze({
          cleanup,
        } satisfies StagingSourceCleanerPort);
        const runner = services.createRunner({ stagingCleaner: faultCleaner });

        expect(await runner.pollOnce()).toMatchObject({ completed: 1 });
        expect(services.repositories.jobs.get(job.id)?.cleanupWarningCode).toBeNull();
        expect(cleanup).not.toHaveBeenCalled();
        await expect(access(job.stagedSourcePath)).resolves.toBeUndefined();

        expect(await services.runner.pollOnce()).toEqual({
          completed: 0,
          failed: 0,
          duplicates: 0,
        });
        expect(services.repositories.jobs.get(job.id)?.cleanupWarningCode).toBeNull();
        await expect(access(job.stagedSourcePath)).resolves.toBeUndefined();
        expect(await readFile(original, 'utf8')).toBe('local cleanup fixture');
      } finally {
        services.database.close();
      }
    });
  });

  it('accepts one local file per atomic intake and rejects oversized work before copying', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      try {
        const course = await services.courseService.create({ name: '자료구조', professorName: '' });
        const sourceA = join(root, 'A.m4a');
        const sourceB = join(root, 'B.m4a');
        await writeFile(sourceA, '123456');
        await writeFile(sourceB, 'abcdef');
        const boundedIntake = new LocalSourceIntake({
          courses: services.repositories.courses,
          jobs: services.repositories.jobs,
          sourceBundles: services.repositories.sourceBundles,
          stagingRoot: services.paths.stagingRoot,
          clock: () => services.clock.now(),
          maxBatchBytes: 5,
        });
        expect(
          () =>
            new LocalSourceIntake({
              courses: services.repositories.courses,
              jobs: services.repositories.jobs,
              sourceBundles: services.repositories.sourceBundles,
              stagingRoot: services.paths.stagingRoot,
              maxBatchBytes: 0,
            }),
        ).toThrow('INVALID_LOCAL_BATCH_LIMIT');
        await expect(
          boundedIntake.enqueue({
            courseId: course.id,
            filePaths: [],
            summaryMode: 'standard',
          }),
        ).rejects.toMatchObject({ code: 'SOURCE_COPY_FAILED' });

        await expect(
          boundedIntake.enqueue({
            courseId: course.id,
            filePaths: [sourceA],
            summaryMode: 'standard',
          }),
        ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
        await expect(
          boundedIntake.enqueue({
            courseId: course.id,
            filePaths: [sourceA, sourceB],
            summaryMode: 'standard',
          }),
        ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
        expect(await readdir(services.paths.stagingRoot)).toEqual([]);
        expect(services.repositories.jobs.list()).toEqual([]);
      } finally {
        services.database.close();
      }
    });
  });

  it('VaultIndexRebuilder accepts icloud_course recording-note frontmatter', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      let freshDatabase: ReturnType<typeof openDatabase> | undefined;
      try {
        const course = await services.courseService.create({
          name: '자료구조',
          professorName: '김교수',
        });
        await seedQueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        expect(await services.runner.pollOnce()).toMatchObject({ completed: 1 });
        const iCloudNotePath = join(
          services.connection.managedRoot,
          '과목',
          course.folderName,
          '녹음',
          `${TEST_IDS.job}.md`,
        );
        await writeFile(
          iCloudNotePath,
          (await readFile(iCloudNotePath, 'utf8')).replace(
            'source_kind: "icloud"',
            'source_kind: "icloud_course"',
          ),
          'utf8',
        );
        const fingerprint = services.repositories.jobs.get(TEST_IDS.job)?.fingerprint;
        expect(fingerprint).toBeDefined();
        const additionalSources = join(root, '복구 입력');
        await mkdir(additionalSources);
        await writeFile(join(additionalSources, '강의 영상.mp4'), 'video recovery fixture');
        await writeFile(join(additionalSources, '강의 자료.pdf'), 'document recovery fixture');
        await services.localIntake.enqueue({
          courseId: course.id,
          filePaths: [join(additionalSources, '강의 영상.mp4')],
          summaryMode: 'core',
        });
        await services.localIntake.enqueue({
          courseId: course.id,
          filePaths: [join(additionalSources, '강의 자료.pdf')],
          summaryMode: 'core',
        });
        expect(await services.runner.pollOnce()).toMatchObject({ completed: 2 });

        services.database.close();
        await unlink(services.paths.databasePath);
        freshDatabase = openDatabase(services.paths.databasePath);
        const freshRepositories = createRepositories(freshDatabase);
        const rebuilder = new VaultIndexRebuilder({
          connection: services.connection,
          courses: freshRepositories.courses,
          jobs: freshRepositories.jobs,
          artifacts: freshRepositories.artifacts,
          vault: services.vault,
          clock: () => services.clock.now(),
        });

        expect(await rebuilder.rebuild()).toEqual({ courses: 1, jobs: 3 });
        expect(freshRepositories.courses.get(course.id)).toMatchObject({
          name: '자료구조',
          professorName: '김교수',
        });
        expect(
          freshRepositories.jobs.findByFingerprint(course.id, fingerprint ?? ''),
        ).toMatchObject({ sourceKind: 'icloud_course', status: 'completed' });
      } finally {
        freshDatabase?.close();
        services.database.close();
      }
    });
  });

  it('reports invalid recovery metadata without changing the managed Markdown', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      let freshDatabase: ReturnType<typeof openDatabase> | undefined;
      try {
        const course = await services.courseService.create({
          name: '자료구조',
          professorName: '김교수',
        });
        await seedQueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        expect(await services.runner.pollOnce()).toMatchObject({ completed: 1 });
        const notePath = join(
          services.connection.managedRoot,
          '과목',
          course.folderName,
          '녹음',
          `${TEST_IDS.job}.md`,
        );
        const corrupted = (await readFile(notePath, 'utf8')).replace(
          /source_archive_sha256: "[a-f0-9]{64}"/u,
          `source_archive_sha256: "${'0'.repeat(64)}"`,
        );
        await writeFile(notePath, corrupted, 'utf8');

        services.database.close();
        await unlink(services.paths.databasePath);
        freshDatabase = openDatabase(services.paths.databasePath);
        const freshRepositories = createRepositories(freshDatabase);
        const rebuilder = new VaultIndexRebuilder({
          connection: services.connection,
          courses: freshRepositories.courses,
          jobs: freshRepositories.jobs,
          artifacts: freshRepositories.artifacts,
          vault: services.vault,
          clock: () => services.clock.now(),
        });

        expect(await rebuilder.rebuild()).toEqual({ courses: 1, jobs: 0 });
        expect(rebuilder.listRecoveryIssues()).toEqual([
          {
            code: 'invalid-integrity',
            relativePath: `과목/${course.folderName}/녹음/${TEST_IDS.job}.md`,
          },
        ]);
        expect(await readFile(notePath, 'utf8')).toBe(corrupted);
        expect(freshRepositories.jobs.list()).toEqual([]);
      } finally {
        freshDatabase?.close();
        services.database.close();
      }
    });
  });

  it('rejects every recording note that repeats a recovery job identity', async () => {
    await withTempDirectory(async (root) => {
      const services = await createFoundationServices(root);
      let freshDatabase: ReturnType<typeof openDatabase> | undefined;
      try {
        const course = await services.courseService.create({ name: '자료구조', professorName: '' });
        await seedQueueJob(services.paths.queueRoot);
        expect(await services.queue.scanReady()).toEqual([]);
        await services.clock.advance(1_500);
        expect(await services.runner.pollOnce()).toMatchObject({ completed: 1 });
        const recordingDirectory = join(
          services.connection.managedRoot,
          '과목',
          course.folderName,
          '녹음',
        );
        const originalPath = join(recordingDirectory, `${TEST_IDS.job}.md`);
        const duplicatePath = join(recordingDirectory, `${TEST_IDS.job}.duplicate.md`);
        await writeFile(duplicatePath, await readFile(originalPath));

        services.database.close();
        await unlink(services.paths.databasePath);
        freshDatabase = openDatabase(services.paths.databasePath);
        const freshRepositories = createRepositories(freshDatabase);
        const rebuilder = new VaultIndexRebuilder({
          connection: services.connection,
          courses: freshRepositories.courses,
          jobs: freshRepositories.jobs,
          artifacts: freshRepositories.artifacts,
          vault: services.vault,
        });

        expect(await rebuilder.rebuild()).toEqual({ courses: 1, jobs: 0 });
        expect(rebuilder.listRecoveryIssues()).toHaveLength(2);
        expect(rebuilder.listRecoveryIssues()).toEqual(
          expect.arrayContaining([
            {
              code: 'duplicate',
              relativePath: `과목/${course.folderName}/녹음/${TEST_IDS.job}.md`,
            },
            {
              code: 'duplicate',
              relativePath: `과목/${course.folderName}/녹음/${TEST_IDS.job}.duplicate.md`,
            },
          ]),
        );
      } finally {
        freshDatabase?.close();
        services.database.close();
      }
    });
  });
});
