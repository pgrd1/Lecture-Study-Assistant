import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ICloudQueue } from '../../../src/infrastructure/queue/icloudQueue';
import { SourceBundleManifestV2Schema } from '../../../src/shared/contracts/sourceBundle';
import { createFilesystemScriptableHarness } from '../../testkit/scriptableHarness';
import { withTempDirectory } from '../../testkit/tempDirectory';

const COURSE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const NEXT_JOB_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_SOURCE_ID = '55555555-5555-4555-8555-555555555555';
const CREATED_AT = '2026-09-03T14:30:15.123+09:00';

describe('StudyAssistant queue protocol compatibility', () => {
  it('publishes a no-sentinel v2 bundle that the desktop claims in Shortcut order', async () => {
    await withTempDirectory(async (root) => {
      const inputDirectory = join(root, 'Shortcut Input');
      const audioPath = join(inputDirectory, 'lecture.m4a');
      const imagePath = join(inputDirectory, 'board.jpg');
      await mkdir(inputDirectory, { recursive: true });
      await writeFile(audioPath, 'companion audio bytes');
      await writeFile(imagePath, 'companion image bytes');
      const companion = createFilesystemScriptableHarness(root, {
        fixedClock: CREATED_AT,
        uuidValues: [JOB_ID, SOURCE_ID, SECOND_SOURCE_ID],
      });
      await companion.run({ fileURLs: [], shortcutParameter: { action: 'status' } });
      await writeFile(
        join(root, 'Catalog', 'courses.json'),
        JSON.stringify({
          protocolVersion: 1,
          generatedAt: CREATED_AT,
          courses: [{ id: COURSE_ID, name: '운영체제' }],
        }),
      );

      await expect(
        companion.run({
          fileURLs: [pathToFileURL(audioPath).toString(), pathToFileURL(imagePath).toString()],
          shortcutParameter: { action: 'enqueue', courseId: COURSE_ID },
        }),
      ).resolves.toMatchObject({ ok: true, data: { jobId: JOB_ID } });

      const stagingRoot = join(root, 'App Data', 'staging');
      await mkdir(stagingRoot, { recursive: true });
      let now = Date.parse(CREATED_AT);
      const queue = new ICloudQueue(root, { clock: () => now });
      expect(await queue.scanReady()).toEqual([]);
      now += 1_500;
      const [ready] = await queue.scanReady();
      if (ready === undefined) throw new TypeError('TEST_READY_ITEM_MISSING');
      const claimed = await queue.claim(ready, stagingRoot);

      expect(claimed.sources.map((source) => source.originalFileName)).toEqual([
        'lecture.m4a',
        'board.jpg',
      ]);
      expect(
        await Promise.all(claimed.sources.map((source) => readFile(source.stagedPath, 'utf8'))),
      ).toEqual(['companion audio bytes', 'companion image bytes']);
      expect(await readFile(audioPath, 'utf8')).toBe('companion audio bytes');
      expect(await readFile(imagePath, 'utf8')).toBe('companion image bytes');
    });
  });

  it('counts a legacy Inbox ready bundle until its completed receipt arrives', async () => {
    await withTempDirectory(async (root) => {
      const sourceBytes = Buffer.from('legacy iCloud audio bytes');
      const companion = createFilesystemScriptableHarness(root, { fixedClock: CREATED_AT });
      await companion.run({ fileURLs: [], shortcutParameter: { action: 'status' } });

      const bundlePath = join(root, 'Inbox', JOB_ID);
      await mkdir(bundlePath, { recursive: true });
      await writeFile(join(bundlePath, 'source.m4a'), sourceBytes);
      await writeFile(
        join(bundlePath, 'manifest.json'),
        JSON.stringify({
          protocolVersion: 1,
          jobId: JOB_ID,
          courseId: COURSE_ID,
          createdAt: CREATED_AT,
          source: { fileName: 'lecture.m4a', mediaType: 'audio' },
          summaryMode: 'standard',
        }),
      );
      await writeFile(join(bundlePath, 'ready'), '');

      await expect(
        companion.run({ fileURLs: [], shortcutParameter: { action: 'status' } }),
      ).resolves.toMatchObject({
        ok: true,
        action: 'status',
        data: { completed: 0, failed: 0, processing: 0, queued: 1 },
      });

      await new ICloudQueue(root).writeReceipt({
        courseId: COURSE_ID,
        displayMessage: '강의 자료 정리가 완료되었습니다.',
        jobId: JOB_ID,
        status: 'completed',
        updatedAt: '2026-09-03T05:31:15.123Z',
      });
      await expect(
        companion.run({ fileURLs: [], shortcutParameter: { action: 'status' } }),
      ).resolves.toMatchObject({
        ok: true,
        action: 'status',
        data: { completed: 1, failed: 0, processing: 0, queued: 0 },
      });
      expect(await readFile(join(bundlePath, 'source.m4a'))).toEqual(sourceBytes);
    });
  });

  it('keeps a legacy CourseInbox course selectable when writing its next v2 bundle', async () => {
    await withTempDirectory(async (root) => {
      const inputDirectory = join(root, 'Shortcut Input');
      const sourcePath = join(inputDirectory, 'follow-up.m4a');
      const sourceBytes = Buffer.from('next lecture bytes');
      await mkdir(inputDirectory, { recursive: true });
      await writeFile(sourcePath, sourceBytes);

      const companion = createFilesystemScriptableHarness(root, {
        fixedClock: CREATED_AT,
        uuidValues: [NEXT_JOB_ID, SOURCE_ID],
      });
      await companion.run({ fileURLs: [], shortcutParameter: { action: 'status' } });

      const legacyBundlePath = join(root, 'CourseInbox', JOB_ID);
      await mkdir(legacyBundlePath, { recursive: true });
      await writeFile(join(legacyBundlePath, 'source.m4a'), 'legacy lecture bytes');
      await writeFile(
        join(legacyBundlePath, 'request.json'),
        JSON.stringify({
          protocolVersion: 1,
          jobId: JOB_ID,
          createdAt: CREATED_AT,
          course: { id: COURSE_ID, name: '운영체제', professorName: '김교수' },
          source: { fileName: 'lecture.m4a', mediaType: 'audio' },
          summaryMode: 'standard',
        }),
      );
      await writeFile(join(legacyBundlePath, 'ready'), '');

      await expect(
        companion.run({ fileURLs: [], shortcutParameter: { action: 'courses' } }),
      ).resolves.toMatchObject({
        ok: true,
        action: 'courses',
        data: {
          courseIdsByLabel: { '운영체제 (생성 대기)': COURSE_ID },
          labels: ['운영체제 (생성 대기)', '＋ 과목 추가'],
        },
      });

      await expect(
        companion.run({
          fileURLs: [pathToFileURL(sourcePath).toString()],
          shortcutParameter: { action: 'enqueue', courseId: COURSE_ID },
        }),
      ).resolves.toMatchObject({ ok: true, data: { jobId: NEXT_JOB_ID } });

      const manifest = SourceBundleManifestV2Schema.parse(
        JSON.parse(await readFile(join(root, 'CourseInbox', NEXT_JOB_ID, 'manifest.json'), 'utf8')),
      );
      expect(manifest).toMatchObject({
        protocolVersion: 2,
        jobId: NEXT_JOB_ID,
        courseId: COURSE_ID,
        courseProvisioning: { id: COURSE_ID, name: '운영체제', professorName: '김교수' },
        sources: [{ id: SOURCE_ID, fileName: 'follow-up.m4a', mediaType: 'audio' }],
      });
      expect(await readFile(sourcePath)).toEqual(sourceBytes);
    });
  });
});
