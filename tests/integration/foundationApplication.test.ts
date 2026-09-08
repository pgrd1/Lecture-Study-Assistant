import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticsService } from '../../src/application/diagnostics/diagnosticsService';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import { VaultService } from '../../src/infrastructure/vault/vaultService';
import {
  FoundationApplication,
  type FoundationApplicationDependencies,
} from '../../src/main/foundationApplication';
import { FakeProcessor } from '../../src/processors/fakeProcessor';
import { CourseCatalogSchema, StatusReceiptSchema } from '../../src/shared/contracts/queue';
import { AppSettingsSchema } from '../../src/shared/contracts/settings';
import { courseFixture, jobFixture, TEST_IDS } from '../testkit/fixtures';
import { seedCourseQueueJob } from '../testkit/queueFixture';
import { withTempDirectory } from '../testkit/tempDirectory';

const NOW = '2026-09-01T00:00:00.000Z';
const RESOLUTION_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_JOB_ID = '44444444-4444-4444-8444-444444444444';
const THIRD_JOB_ID = '55555555-5555-4555-8555-555555555555';
const FOURTH_JOB_ID = '66666666-6666-4666-8666-666666666666';

const openedDatabases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const database of openedDatabases.splice(0)) database.close();
});

type HarnessOptions = Readonly<{
  configured?: boolean;
  processingPaused?: boolean;
  pollQuestionInboxes?: FoundationApplicationDependencies['pollQuestionInboxes'];
  ids?: readonly string[];
  onStateChanged?: FoundationApplicationDependencies['onStateChanged'];
  onOperationalError?: FoundationApplicationDependencies['onOperationalError'];
}>;

const createHarness = async (root: string, options: HarnessOptions = {}) => {
  const vaultRoot = join(root, 'Obsidian Vault');
  const queueRoot = join(root, 'iCloud Queue');
  const stagingRoot = join(root, 'App Data', 'staging');
  await Promise.all([mkdir(queueRoot), mkdir(stagingRoot, { recursive: true })]);
  if (options.configured) {
    await new VaultService().connect({ path: vaultRoot, mode: 'create' });
  }

  const database = openDatabase(join(root, 'App Data', 'study.sqlite3'));
  openedDatabases.push(database);
  const repositories = createRepositories(database);
  repositories.settings.insert(
    AppSettingsSchema.parse({
      schemaVersion: 1,
      vaultPath: options.configured ? vaultRoot : null,
      icloudQueuePath: options.configured ? queueRoot : null,
      defaultSummaryMode: 'standard',
      autoStart: false,
      processingPaused: options.processingPaused ?? false,
      legalNoticeAcceptedAt: null,
      updatedAt: NOW,
      revision: 0,
    }),
  );

  const exportedDiagnostics: string[] = [];
  const diagnostics: Pick<DiagnosticsService, 'export'> = Object.freeze({
    export: async (destination: string) => {
      exportedDiagnostics.push(destination);
      return destination;
    },
  });
  const generatedIds = [...(options.ids ?? [TEST_IDS.course, RESOLUTION_ID])];
  const setAutoStart = vi.fn(async (enabled: boolean) => {
    const current = repositories.settings.get();
    if (current === null) throw new TypeError('MISSING_TEST_SETTINGS');
    repositories.settings.update(
      AppSettingsSchema.parse({
        ...current,
        autoStart: enabled,
        updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
        revision: current.revision + 1,
      }),
      current.revision,
    );
  });
  const application = new FoundationApplication({
    processor: new FakeProcessor(),
    ...(options.pollQuestionInboxes ? { pollQuestionInboxes: options.pollQuestionInboxes } : {}),
    validateStorageRoots: () => undefined,
    repositories,
    stagingRoot,
    diagnostics,
    setAutoStart,
    onStateChanged: options.onStateChanged ?? (() => undefined),
    ...(options.onOperationalError === undefined
      ? {}
      : { onOperationalError: options.onOperationalError }),
    clock: () => NOW,
    idGenerator: () => generatedIds.shift() ?? randomUUID(),
  });

  return Object.freeze({
    application,
    exportedDiagnostics,
    queueRoot,
    repositories,
    setAutoStart,
    stagingRoot,
    vaultRoot,
  });
};

const setPaused = (
  repositories: Awaited<ReturnType<typeof createHarness>>['repositories'],
  paused: boolean,
): void => {
  const current = repositories.settings.get();
  if (current === null) throw new TypeError('MISSING_TEST_SETTINGS');
  repositories.settings.update(
    AppSettingsSchema.parse({
      ...current,
      processingPaused: paused,
      updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
      revision: current.revision + 1,
    }),
    current.revision,
  );
};

describe('FoundationApplication', () => {
  it('polls questions on startup and periodic polls only while configured and active', async () => {
    await withTempDirectory(async (root) => {
      const poll = vi.fn(async () => undefined);
      const harness = await createHarness(root, { configured: true, pollQuestionInboxes: poll });
      await harness.application.initialize();
      expect(poll).toHaveBeenCalledTimes(1);
      await harness.application.pollOnce();
      expect(poll).toHaveBeenCalledTimes(2);
      setPaused(harness.repositories, true);
      await harness.application.pollOnce();
      expect(poll).toHaveBeenCalledTimes(2);
      await harness.application.shutdown();
    });
    await withTempDirectory(async (root) => {
      const poll = vi.fn(async () => undefined);
      const harness = await createHarness(root, { pollQuestionInboxes: poll });
      await harness.application.initialize();
      await harness.application.pollOnce();
      expect(poll).not.toHaveBeenCalled();
    });
  });
  it('onboards paths, manages a course, and processes a local source through the public port', async () => {
    await withTempDirectory(async (root) => {
      const states: unknown[] = [];
      const harness = await createHarness(root, {
        onStateChanged: (state) => states.push(state),
      });

      expect(await harness.application.initialize()).toMatchObject({
        settings: { vaultConfigured: false, queueConfigured: false },
        courses: [],
      });
      expect(await harness.application.chooseVault(harness.vaultRoot)).toMatchObject({
        settings: { vaultConfigured: true, queueConfigured: false },
      });
      await harness.application.chooseVault(harness.vaultRoot);
      await harness.application.chooseQueue(harness.queueRoot);
      await harness.application.chooseQueue(harness.queueRoot);

      const createdState = await harness.application.createCourse({
        name: '자료구조',
        professorName: '김교수',
      });
      const courseId = createdState.courses[0]?.id;
      expect(courseId).toBe(TEST_IDS.course);
      const updatedState = await harness.application.updateCourse(courseId ?? '', {
        name: '고급 자료구조',
        professorName: '박교수',
        userInstructions: '계산형 문제를 우선 정리',
      });
      expect(updatedState.courses[0]).toMatchObject({
        name: '고급 자료구조',
        professorName: '박교수',
        userInstructions: '계산형 문제를 우선 정리',
      });

      const sourcePath = join(root, '1주차 강의.m4a');
      const companionPath = join(root, '1주차 칠판.jpg');
      await writeFile(sourcePath, 'audio bytes', 'utf8');
      await writeFile(companionPath, 'image bytes', 'utf8');
      const completed = await harness.application.enqueueSources({
        courseId: courseId ?? '',
        filePaths: [sourcePath, companionPath],
        summaryMode: 'standard',
      });
      expect(completed.counts).toMatchObject({ completed: 1, failed: 0 });
      expect(completed.jobs[0]).toMatchObject({
        sourceFileName: '1주차 강의.m4a',
        sourceCount: 2,
        status: 'completed',
      });
      const bundle = harness.repositories.sourceBundles.getByJobId(completed.jobs[0]?.id ?? '');
      expect(bundle).toMatchObject({ sourceCount: 2 });
      expect(harness.repositories.sourceBundles.listRecords(bundle?.id ?? '')).toHaveLength(2);
      const restarted = await harness.application.initialize();
      expect(restarted.synchronizationIssueCount).toBe(0);
      expect(restarted.jobs[0]).toMatchObject({ sourceCount: 2, status: 'completed' });

      expect(await harness.application.setAutoStart(true)).toMatchObject({
        settings: { autoStart: true },
      });
      expect(harness.setAutoStart).toHaveBeenCalledWith(true);
      const destination = join(root, 'diagnostics.json');
      await harness.application.exportDiagnostics(destination);
      expect(harness.exportedDiagnostics).toEqual([destination]);

      expect(await harness.application.archiveCourse(courseId ?? '')).toMatchObject({
        courses: [{ id: courseId, archived: true }],
      });
      expect(await harness.application.restoreCourse(courseId ?? '')).toMatchObject({
        courses: [{ id: courseId, archived: false }],
      });
      expect(await harness.application.getBootstrapState()).toMatchObject({
        counts: { completed: 1 },
      });
      expect(states.length).toBeGreaterThanOrEqual(9);
    });
  });

  it('rechecks recovery warnings after startup synchronization repairs vault drift', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root, { configured: true });
      await harness.application.initialize();
      const created = await harness.application.createCourse({
        name: '자료구조',
        professorName: '김교수',
      });
      const course = created.courses[0];
      if (course === undefined) throw new TypeError('TEST_COURSE_MISSING');
      const notePath = join(harness.vaultRoot, 'AI 학습', '과목', '자료구조', '자료구조.md');
      const drifted = (await readFile(notePath, 'utf8')).replace(
        /^studyapp-professor-name:.*\r?\n/mu,
        '',
      );
      await writeFile(notePath, drifted, 'utf8');

      const repaired = await harness.application.initialize();

      expect(repaired.synchronizationIssueCount).toBe(0);
      await expect(readFile(notePath, 'utf8')).resolves.toContain(
        'studyapp-professor-name: "김교수"',
      );
    });
  });

  it('provisions and completes a CourseInbox job through the application runtime', async () => {
    await withTempDirectory(async (root) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
      const harness = await createHarness(root, { configured: true });
      const seeded = await seedCourseQueueJob(harness.queueRoot, {
        course: { id: TEST_IDS.course, name: '운영체제', professorName: '김교수' },
      });

      expect(await harness.application.initialize()).toMatchObject({
        courses: [],
        counts: { completed: 0 },
      });
      await vi.advanceTimersByTimeAsync(1_500);

      const completed = await harness.application.pollOnce();

      expect(completed).toMatchObject({
        courses: [{ id: TEST_IDS.course, name: '운영체제', professorName: '김교수' }],
        counts: { completed: 1, failed: 0 },
        jobs: [{ id: TEST_IDS.job, status: 'completed' }],
      });
      expect(harness.repositories.jobs.get(TEST_IDS.job)).toMatchObject({
        sourceKind: 'icloud_course',
        status: 'completed',
      });
      expect(
        CourseCatalogSchema.parse(
          JSON.parse(await readFile(join(harness.queueRoot, 'Catalog', 'courses.json'), 'utf8')),
        ).courses,
      ).toEqual([{ id: TEST_IDS.course, name: '운영체제' }]);
      expect(
        StatusReceiptSchema.parse(
          JSON.parse(
            await readFile(join(harness.queueRoot, 'Status', `${TEST_IDS.job}.json`), 'utf8'),
          ),
        ).status,
      ).toBe('completed');
      await expect(access(seeded.folderPath)).rejects.toBeDefined();
    });
  });

  it('maps all queue states and permits only valid paused retries', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root, {
        configured: true,
        ids: [RESOLUTION_ID],
      });
      harness.repositories.courses.insert(courseFixture());
      await harness.application.initialize();
      setPaused(harness.repositories, true);

      harness.repositories.jobs.insert(
        jobFixture({
          status: 'retryable_failed',
          errorCode: 'SOURCE_COPY_FAILED',
          retryCount: 1,
        }),
      );
      harness.repositories.jobs.insert(
        jobFixture({
          id: SECOND_JOB_ID,
          fingerprint: '2'.repeat(64),
          status: 'needs_attention',
          errorCode: 'SOURCE_COPY_FAILED',
          retryCount: 3,
        }),
      );
      harness.repositories.jobs.insert(
        jobFixture({
          id: THIRD_JOB_ID,
          fingerprint: '3'.repeat(64),
          status: 'receiving',
        }),
      );
      harness.repositories.jobs.insert(
        jobFixture({
          id: FOURTH_JOB_ID,
          fingerprint: '4'.repeat(64),
          status: 'completed',
          lastSuccessfulStatus: 'completed',
        }),
      );

      const state = await harness.application.pollOnce();
      expect(state.counts).toEqual({ queued: 0, processing: 1, completed: 1, failed: 2 });
      expect(state.jobs.find((job) => job.id === TEST_IDS.job)?.error).toMatchObject({
        code: 'SOURCE_COPY_FAILED',
      });
      await expect(harness.application.retryJob(randomUUID())).rejects.toMatchObject({
        code: 'INVALID_JOB_TRANSITION',
      });
      await harness.application.retryJob(TEST_IDS.job);
      const retried = await harness.application.retryJob(SECOND_JOB_ID);
      expect(retried.counts.queued).toBe(1);
      expect(harness.repositories.jobs.get(SECOND_JOB_ID)).toMatchObject({
        status: 'queued',
        attentionResolutionId: RESOLUTION_ID,
      });
      await expect(harness.application.retryJob(FOURTH_JOB_ID)).rejects.toMatchObject({
        code: 'INVALID_JOB_TRANSITION',
      });
    });
  });

  it('contains startup failures, reports state-listener errors, and controls one polling loop', async () => {
    await withTempDirectory(async (root) => {
      const operationalErrors: unknown[] = [];
      const harness = await createHarness(root, {
        onStateChanged: () => {
          throw new TypeError('TEST_LISTENER_FAILED');
        },
        onOperationalError: (error) => operationalErrors.push(error),
      });
      const current = harness.repositories.settings.get();
      if (current === null) throw new TypeError('MISSING_TEST_SETTINGS');
      harness.repositories.settings.update(
        AppSettingsSchema.parse({
          ...current,
          vaultPath: join(root, 'missing-vault'),
          icloudQueuePath: harness.queueRoot,
          updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
          revision: current.revision + 1,
        }),
        current.revision,
      );

      await expect(harness.application.initialize()).resolves.toMatchObject({
        settings: { vaultConfigured: true, queueConfigured: true },
      });
      await harness.application.refreshState();
      expect(operationalErrors).toHaveLength(2);

      expect(
        () =>
          new FoundationApplication({
            processor: new FakeProcessor(),
            validateStorageRoots: () => undefined,
            repositories: harness.repositories,
            stagingRoot: harness.stagingRoot,
            diagnostics: { export: async (destination) => destination },
            setAutoStart: () => undefined,
            onStateChanged: () => undefined,
            pollIntervalMs: 999,
          }),
      ).toThrow('INVALID_POLL_INTERVAL');

      vi.useFakeTimers();
      harness.application.startPolling();
      harness.application.startPolling();
      await vi.advanceTimersByTimeAsync(1_250);
      harness.application.stopPolling();
      harness.application.stopPolling();
      expect(operationalErrors.length).toBeGreaterThanOrEqual(3);
    });
  });
});
