import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import type { SourceRecord } from '../../src/shared/contracts/sourceBundle';
import { createFoundationFixture, type FoundationE2eFixture } from '../testkit/e2eFixture';
import { TEST_IDS } from '../testkit/fixtures';
import { launchStudyApp } from '../testkit/launchStudyApp';
import { seedV2QueueJob, V2_QUEUE_SOURCES } from '../testkit/queueFixture';

const sources = Object.freeze([V2_QUEUE_SOURCES.audio, V2_QUEUE_SOURCES.image]);

const readIntake = (fixture: FoundationE2eFixture) => {
  const database = openDatabase(join(fixture.userDataPath, 'study.sqlite3'));
  try {
    const repositories = createRepositories(database);
    const bundle = repositories.sourceBundles.getByJobId(TEST_IDS.job);
    return Object.freeze({
      jobs: repositories.jobs.list(),
      bundle,
      records: bundle === null ? [] : repositories.sourceBundles.listRecords(bundle.id),
      artifacts: repositories.artifacts.listByJob(TEST_IDS.job),
    });
  } finally {
    database.close();
  }
};

const expectCompletedBundle = async (window: Page): Promise<void> => {
  await expect(window.locator('.job-row')).toHaveCount(1);
  await expect(window.getByText('파일 2개', { exact: true })).toBeVisible();
  await expect(window.locator('.job-row .status-completed')).toContainText('완료');
  await expect(
    window.locator('.metric-grid > div').filter({ hasText: '완료' }).locator('dd'),
  ).toHaveText('1');
  await expect(window.locator('.sync-warning')).toHaveCount(0);
};

const expectOriginals = async (records: readonly SourceRecord[]): Promise<void> => {
  expect(records).toHaveLength(2);
  for (const [ordinal, source] of sources.entries()) {
    const expectedBytes = Buffer.from(source.sourceBytes);
    const record = records[ordinal];
    expect(record).toMatchObject({
      id: source.id,
      ordinal,
      originalFileName: source.fileName,
      mediaType: source.mediaType,
      sizeBytes: expectedBytes.byteLength,
      sha256: createHash('sha256').update(expectedBytes).digest('hex'),
    });
    expect(await readFile(record?.stagedPath ?? '')).toEqual(expectedBytes);
  }
};

test('receives an offline-created audio and image bundle exactly once across restart', async () => {
  const fixture = await createFoundationFixture({ pcWasOffline: false });
  let runningApp: Awaited<ReturnType<typeof launchStudyApp>> | undefined;
  try {
    // Both files and the v2 manifest exist before the packaged app starts.
    await seedV2QueueJob(fixture.queueRoot, { sources });
    runningApp = await launchStudyApp(fixture);
    await expectCompletedBundle(await runningApp.firstWindow());
    await expect.poll(() => fixture.recordingNotes()).toHaveLength(1);
    await runningApp.close();
    runningApp = undefined;

    const before = readIntake(fixture);
    expect(before.jobs).toHaveLength(1);
    expect(before.jobs[0]).toMatchObject({
      id: TEST_IDS.job,
      status: 'completed',
      sourceCount: 2,
      cleanupWarningCode: null,
    });
    expect(before.bundle).toMatchObject({ jobId: TEST_IDS.job, sourceCount: 2 });
    await expectOriginals(before.records);
    const notesBefore = await fixture.recordingNotes();

    runningApp = await launchStudyApp(fixture);
    await expectCompletedBundle(await runningApp.firstWindow());
    await runningApp.close();
    runningApp = undefined;

    expect(readIntake(fixture)).toEqual(before);
    expect(await fixture.recordingNotes()).toEqual(notesBefore);
    await expectOriginals(readIntake(fixture).records);
  } finally {
    await runningApp?.close();
    await fixture.dispose();
  }
});
