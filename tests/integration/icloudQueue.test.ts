import {
  access,
  link as linkFile,
  mkdir,
  opendir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ICloudQueue,
  type ICloudQueueDependencies,
} from '../../src/infrastructure/queue/icloudQueue';
import {
  acquireClaimReservation,
  readClaimReservation,
} from '../../src/infrastructure/queue/icloudSourceBundle';
import { RejectionReceiptSchema, StatusReceiptSchema } from '../../src/shared/contracts/queue';
import { AppError } from '../../src/shared/errors';
import { FakeClock } from '../testkit/fakeClock';
import { TEST_IDS } from '../testkit/fixtures';
import {
  seedCourseQueueJob,
  seedInvalidQueueJob,
  seedQueueJob,
  seedReadyMarker,
  seedV2QueueJob,
  V2_QUEUE_SOURCES,
} from '../testkit/queueFixture';
import { withTempDirectory } from '../testkit/tempDirectory';

const NOW = '2026-09-01T00:00:00.000Z';
const AFTER_STABILITY = '2026-09-01T00:00:01.500Z';

const requireReadyItem = <T>(item: T | undefined): T => {
  if (item === undefined) {
    throw new TypeError('TEST_READY_ITEM_MISSING');
  }
  return item;
};

const createHarness = async (
  root: string,
  dependencies: Pick<
    ICloudQueueDependencies,
    | 'afterClaimReservation'
    | 'afterStagingCopy'
    | 'beforeClaimReservationCommit'
    | 'beforeClaimReservationRemoval'
    | 'beforeClaimReservationSync'
    | 'beforeClaimReservationWrite'
    | 'beforeCompletedCleanupRename'
    | 'beforeCompletedEntryRemoval'
    | 'claimReservationLink'
    | 'maxReadyItems'
    | 'maxScanEntries'
    | 'openScanDirectory'
    | 'readBundleMetadata'
    | 'sourceLimits'
  > = {},
) => {
  const queueRoot = join(root, 'iCloud Queue');
  const stagingRoot = join(root, 'App Data', 'staging');
  await mkdir(queueRoot);
  await mkdir(stagingRoot, { recursive: true });
  const clock = new FakeClock(NOW);
  const queue = new ICloudQueue(queueRoot, {
    ...dependencies,
    clock: () => Date.parse(clock.now()),
  });
  return Object.freeze({ clock, queue, queueRoot, stagingRoot });
};

const scanAfterStableInterval = async (queue: ICloudQueue, clock: FakeClock) => {
  expect(await queue.scanReady()).toEqual([]);
  await clock.advance(1_500);
  return queue.scanReady();
};

const findPreservedClaimPath = async (queueRoot: string): Promise<string> => {
  const rejectedPath = join(queueRoot, 'Rejected');
  const entries = await readdir(rejectedPath, { withFileTypes: true });
  const preserved = entries.find((entry) => entry.name.startsWith('.claim-quarantine-'));
  return join(rejectedPath, requireReadyItem(preserved).name);
};

describe('ICloudQueue', () => {
  it.each([1, 2] as const)(
    'rejects a v%s staging junction on restart and preserves its target',
    async (version) => {
      await withTempDirectory(async (root) => {
        const harness = await createHarness(root);
        if (version === 1) await seedQueueJob(harness.queueRoot);
        else await seedV2QueueJob(harness.queueRoot);
        const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
        const claimed = await harness.queue.claim(requireReadyItem(item), harness.stagingRoot);
        const originalDirectory = join(root, 'preserved-originals');
        await rename(claimed.stagingDirectoryPath, originalDirectory);
        await symlink(originalDirectory, claimed.stagingDirectoryPath, 'junction');
        const restarted = new ICloudQueue(harness.queueRoot, {
          clock: () => Date.parse(harness.clock.now()),
        });
        const [retry] = await scanAfterStableInterval(restarted, harness.clock);
        await expect(
          restarted.claim(requireReadyItem(retry), harness.stagingRoot),
        ).rejects.toMatchObject({ code: 'SAFE_PATH' });
        expect(
          await readFile(join(originalDirectory, basename(claimed.stagedSourcePath)), 'utf8'),
        ).toBe(version === 1 ? 'audio bytes' : 'v2 audio bytes');
      });
    },
  );

  it('retains the reservation when failed staging cleanup cannot prove ownership', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root, {
        afterStagingCopy: async (stagedPath) => {
          await writeFile(join(stagedPath, '..', 'foreign.txt'), 'preserve me');
          throw new AppError('SOURCE_COPY_FAILED', 'SOURCE_COPY_FAILED');
        },
      });
      const seeded = await seedV2QueueJob(harness.queueRoot);
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'SOURCE_COPY_FAILED' });
      expect((await stat(join(harness.queueRoot, 'CourseInbox', seeded.jobId))).isFile()).toBe(
        true,
      );
      const [preserved] = await readdir(harness.stagingRoot);
      expect(
        await readFile(
          join(harness.stagingRoot, requireReadyItem(preserved), 'foreign.txt'),
          'utf8',
        ),
      ).toBe('preserve me');
      const restarted = new ICloudQueue(harness.queueRoot, {
        clock: () => Date.parse(harness.clock.now()),
      });
      const [retry] = await scanAfterStableInterval(restarted, harness.clock);
      const recovered = await restarted.claim(requireReadyItem(retry), harness.stagingRoot);
      expect(await readFile(recovered.stagedSourcePath, 'utf8')).toBe('v2 audio bytes');
      expect(
        await readFile(
          join(harness.stagingRoot, requireReadyItem(preserved), 'foreign.txt'),
          'utf8',
        ),
      ).toBe('preserve me');
    });
  });

  it.each([1, 2] as const)(
    'recovers v%s reservation before staging publication',
    async (version) => {
      await withTempDirectory(async (root) => {
        const harness = await createHarness(root);
        const seeded =
          version === 1
            ? await seedQueueJob(harness.queueRoot)
            : await seedV2QueueJob(harness.queueRoot);
        const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
        const ready = requireReadyItem(item);
        await acquireClaimReservation(
          {
            path: join(harness.queueRoot, 'CourseInbox', seeded.jobId),
            anchorPath: join(harness.queueRoot, 'Rejected', `.claim-icloud-${seeded.jobId}.json`),
            quarantineRoot: join(harness.queueRoot, 'Rejected'),
          },
          ready,
        );
        expect(await readdir(harness.stagingRoot)).toEqual([]);
        const restarted = new ICloudQueue(harness.queueRoot, {
          clock: () => Date.parse(harness.clock.now()),
        });
        const [retry] = await scanAfterStableInterval(restarted, harness.clock);
        const claimed = await restarted.claim(requireReadyItem(retry), harness.stagingRoot);
        expect(
          await Promise.all(claimed.sources.map((source) => readFile(source.stagedPath, 'utf8'))),
        ).toEqual(version === 1 ? ['audio bytes'] : ['v2 audio bytes', 'v2 image bytes']);
        expect(await readdir(harness.stagingRoot)).toEqual([seeded.jobId]);
      });
    },
  );

  it.each([1, 2] as const)('preserves matching but unowned v%s staging', async (version) => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded =
        version === 1
          ? await seedQueueJob(harness.queueRoot)
          : await seedV2QueueJob(harness.queueRoot);
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
      const claimed = await harness.queue.claim(requireReadyItem(item), harness.stagingRoot);
      await rm(join(harness.queueRoot, 'CourseInbox', seeded.jobId));
      await rm(join(harness.queueRoot, 'Rejected', `.claim-icloud-${seeded.jobId}.json`));
      const before = await Promise.all(
        claimed.sources.map((source) => readFile(source.stagedPath)),
      );
      const restarted = new ICloudQueue(harness.queueRoot, {
        clock: () => Date.parse(harness.clock.now()),
      });
      const [retry] = await scanAfterStableInterval(restarted, harness.clock);
      await expect(
        restarted.claim(requireReadyItem(retry), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'SOURCE_COPY_FAILED' });
      expect(
        await Promise.all(claimed.sources.map((source) => readFile(source.stagedPath))),
      ).toEqual(before);
    });
  });

  it.each([1, 2] as const)(
    'rejects changed v%s staging on restart without overwriting it',
    async (version) => {
      await withTempDirectory(async (root) => {
        const harness = await createHarness(root);
        if (version === 1) await seedQueueJob(harness.queueRoot);
        else await seedV2QueueJob(harness.queueRoot);
        const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
        const claimed = await harness.queue.claim(requireReadyItem(item), harness.stagingRoot);
        await writeFile(claimed.stagedSourcePath, 'foreign replacement');
        const restarted = new ICloudQueue(harness.queueRoot, {
          clock: () => Date.parse(harness.clock.now()),
        });
        const [retry] = await scanAfterStableInterval(restarted, harness.clock);
        await expect(
          restarted.claim(requireReadyItem(retry), harness.stagingRoot),
        ).rejects.toMatchObject({ code: 'SOURCE_COPY_FAILED' });
        expect(await readFile(claimed.stagedSourcePath, 'utf8')).toBe('foreign replacement');
      });
    },
  );

  it.each([1, 2] as const)(
    'recovers published v%s staging across restart before the claim returns',
    async (version) => {
      await withTempDirectory(async (root) => {
        let recoveredPaths: readonly string[] = [];
        const harness = await createHarness(root, {
          afterStagingCopy: async (stagedPath) => {
            const before = await stat(stagedPath);
            const restarted = new ICloudQueue(harness.queueRoot, {
              clock: () => Date.parse(harness.clock.now()),
            });
            const [retry] = await scanAfterStableInterval(restarted, harness.clock);
            const recovered = await restarted.claim(requireReadyItem(retry), harness.stagingRoot);
            recoveredPaths = recovered.sources.map((source) => source.stagedPath);
            expect(await stat(stagedPath)).toMatchObject({
              ino: before.ino,
              mtimeMs: before.mtimeMs,
            });
          },
        });
        const seeded =
          version === 1
            ? await seedQueueJob(harness.queueRoot)
            : await seedV2QueueJob(harness.queueRoot);
        const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
        const claimed = await harness.queue.claim(requireReadyItem(item), harness.stagingRoot);
        expect(recoveredPaths).toEqual(claimed.sources.map((source) => source.stagedPath));
        expect(await readdir(harness.stagingRoot)).toEqual([seeded.jobId]);
        expect(
          await Promise.all(claimed.sources.map((source) => readFile(source.stagedPath, 'utf8'))),
        ).toEqual(version === 1 ? ['audio bytes'] : ['v2 audio bytes', 'v2 image bytes']);
      });
    },
  );

  it('claims every stable protocol-v2 source in manifest order as an immutable bundle', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedV2QueueJob(harness.queueRoot, {
        sources: [
          { ...V2_QUEUE_SOURCES.audio, fileName: 'z-lecture.m4a' },
          { ...V2_QUEUE_SOURCES.image, fileName: 'a-board.jpg' },
        ],
      });

      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
      const claimed = await harness.queue.claim(requireReadyItem(item), harness.stagingRoot);

      expect(claimed.manifest).toMatchObject({ protocolVersion: 2, jobId: seeded.jobId });
      expect(claimed.sources.map((source) => source.originalFileName)).toEqual([
        'z-lecture.m4a',
        'a-board.jpg',
      ]);
      expect(claimed.sources.map((source) => basename(source.stagedPath))).toEqual([
        `0-${V2_QUEUE_SOURCES.audio.id}.m4a`,
        `1-${V2_QUEUE_SOURCES.image.id}.jpg`,
      ]);
      expect(
        await Promise.all(claimed.sources.map((source) => readFile(source.stagedPath, 'utf8'))),
      ).toEqual(['v2 audio bytes', 'v2 image bytes']);
      expect(claimed.sources.every((source) => /^[a-f0-9]{64}$/u.test(source.sha256))).toBe(true);
      expect(Object.isFrozen(claimed)).toBe(true);
      expect(Object.isFrozen(claimed.manifest)).toBe(true);
      expect(Object.isFrozen(claimed.sources)).toBe(true);
      expect(claimed.sources.every(Object.isFrozen)).toBe(true);
      expect(await Promise.all(seeded.sourcePaths.map((path) => readFile(path, 'utf8')))).toEqual([
        'v2 audio bytes',
        'v2 image bytes',
      ]);
      await expect(access(join(seeded.folderPath, 'ready'))).rejects.toBeDefined();
    });
  });

  it('claims a protocol-v2 CourseInbox bundle only with same-ID course provisioning', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedV2QueueJob(harness.queueRoot, {
        sourceKind: 'icloud_course',
        sources: [V2_QUEUE_SOURCES.audio],
      });

      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
      const claimed = await harness.queue.claim(requireReadyItem(item), harness.stagingRoot);

      expect(claimed).toMatchObject({
        sourceKind: 'icloud_course',
        queueItemPath: seeded.folderPath,
        courseProvisioning: {
          id: TEST_IDS.course,
          name: '자료구조',
          professorName: '김교수',
        },
      });
    });
  });

  it.each([
    ['missing source', { omittedSourceIndexes: [1] }],
    [
      'placeholder-sized source',
      {
        sources: [
          V2_QUEUE_SOURCES.audio,
          { ...V2_QUEUE_SOURCES.image, sizeBytes: 128, sourceBytes: Buffer.alloc(0) },
        ],
      },
    ],
  ] as const)('does not expose a protocol-v2 bundle with a %s', async (_name, options) => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedV2QueueJob(harness.queueRoot, options);

      expect(await harness.queue.scanReady()).toEqual([]);
      await harness.clock.advance(1_500);
      expect(await harness.queue.scanReady()).toEqual([]);
      await harness.clock.advance(1_500);
      expect(await harness.queue.scanReady()).toEqual([]);
      await expect(
        access(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`)),
      ).rejects.toBeDefined();
    });
  });

  it('restarts protocol-v2 stability when any declared source changes', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedV2QueueJob(harness.queueRoot);
      expect(await harness.queue.scanReady()).toEqual([]);
      await harness.clock.advance(1_500);
      await writeFile(seeded.sourcePaths[1] ?? '', 'V2 image bytes');

      expect(await harness.queue.scanReady()).toEqual([]);
      await harness.clock.advance(1_500);
      expect(await harness.queue.scanReady()).toHaveLength(1);
    });
  });

  it.each([
    ['an extra root entry', { extraRootEntry: true }],
    ['an extra source entry', { extraSourceEntry: true }],
    ['a source symlink or reparse point', { symlinkSourceIndex: 1 }],
    [
      'duplicate source IDs',
      {
        sources: [
          V2_QUEUE_SOURCES.audio,
          { ...V2_QUEUE_SOURCES.image, id: V2_QUEUE_SOURCES.audio.id },
        ],
      },
    ],
    [
      'an unsupported media and extension pair',
      {
        sources: [{ ...V2_QUEUE_SOURCES.audio, fileName: 'board.jpg', mediaType: 'audio' }],
      },
    ],
    [
      'mismatched course provisioning',
      {
        sourceKind: 'icloud_course',
        courseProvisioning: {
          id: '55555555-5555-4555-8555-555555555555',
          name: '운영체제',
          professorName: '',
        },
      },
    ],
  ] as const)(
    'rejects a complete protocol-v2 bundle with %s without deleting it',
    async (_name, options) => {
      await withTempDirectory(async (root) => {
        const harness = await createHarness(root);
        const seeded = await seedV2QueueJob(harness.queueRoot, options);
        const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

        await expect(
          harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
        ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' });
        await expect(access(seeded.folderPath)).resolves.toBeUndefined();
        await expect(
          access(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`)),
        ).resolves.toBeUndefined();
        await expect(access(join(harness.stagingRoot, seeded.jobId))).rejects.toBeDefined();
      });
    },
  );

  it.each([
    [
      'a duplicate staged source hash',
      {
        sources: [
          V2_QUEUE_SOURCES.audio,
          { ...V2_QUEUE_SOURCES.image, sourceBytes: V2_QUEUE_SOURCES.audio.sourceBytes },
        ],
      },
    ],
    [
      'a sender hash mismatch',
      {
        sources: [{ ...V2_QUEUE_SOURCES.audio, senderSha256: 'wrong' }],
      },
    ],
  ] as const)(
    'rejects protocol-v2 bundle with %s after copying staged bytes',
    async (_name, options) => {
      await withTempDirectory(async (root) => {
        const harness = await createHarness(root);
        const seeded = await seedV2QueueJob(harness.queueRoot, options);
        const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

        await expect(
          harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
        ).rejects.toMatchObject({
          code: _name === 'a sender hash mismatch' ? 'SOURCE_HASH_MISMATCH' : 'INVALID_QUEUE_ITEM',
        });
        await expect(access(join(harness.stagingRoot, seeded.jobId))).rejects.toBeDefined();
        await expect(access(seeded.folderPath)).resolves.toBeUndefined();
      });
    },
  );

  it('re-snapshots every v2 source after staging and removes only its new failed staging', async () => {
    await withTempDirectory(async (root) => {
      let changedSourcePath = '';
      const harness = await createHarness(root, {
        afterStagingCopy: async () => writeFile(changedSourcePath, 'changed after v2 copy'),
      });
      const seeded = await seedV2QueueJob(harness.queueRoot);
      changedSourcePath = seeded.sourcePaths[1] ?? '';
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'QUEUE_ITEM_NOT_STABLE' });
      await expect(access(join(harness.stagingRoot, seeded.jobId))).rejects.toBeDefined();
      expect(await readFile(changedSourcePath, 'utf8')).toBe('changed after v2 copy');
      expect(await readFile(seeded.sourcePaths[0] ?? '', 'utf8')).toBe('v2 audio bytes');
    });
  });

  it('preserves a pre-existing staging directory instead of treating it as claim-owned', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedV2QueueJob(harness.queueRoot, {
        sources: [V2_QUEUE_SOURCES.audio],
      });
      const stagingDirectory = join(harness.stagingRoot, seeded.jobId);
      await mkdir(stagingDirectory);
      await writeFile(join(stagingDirectory, 'sentinel.txt'), 'pre-existing staging');
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'SOURCE_COPY_FAILED' });
      expect(await readFile(join(stagingDirectory, 'sentinel.txt'), 'utf8')).toBe(
        'pre-existing staging',
      );
      await expect(access(seeded.folderPath)).resolves.toBeUndefined();
    });
  });

  it('claims a stable CourseInbox request as a normalized course queue source', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedCourseQueueJob(harness.queueRoot, {
        course: { id: TEST_IDS.course, name: '운영체제', professorName: '' },
      });
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      expect(item?.sourceKind).toBe('icloud_course');
      const claimed = await harness.queue.claim(requireReadyItem(item), harness.stagingRoot);

      expect(claimed).toMatchObject({
        sourceKind: 'icloud_course',
        courseProvisioning: { id: TEST_IDS.course, name: '운영체제', professorName: '' },
        manifest: { jobId: seeded.jobId, courseId: TEST_IDS.course },
        queueItemPath: seeded.folderPath,
      });
      expect(await readFile(claimed.stagedSourcePath, 'utf8')).toBe('audio bytes');
    });
  });

  it('returns ready CourseInbox jobs before ready Inbox jobs', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root, { maxReadyItems: 1 });
      const courseJob = await seedCourseQueueJob(harness.queueRoot, {
        jobId: '33333333-3333-4333-8333-333333333333',
      });
      const normalJob = await seedQueueJob(harness.queueRoot, {
        jobId: '44444444-4444-4444-8444-444444444444',
      });

      const ready = await scanAfterStableInterval(harness.queue, harness.clock);

      expect(ready.map(({ jobId, sourceKind }) => ({ jobId, sourceKind }))).toEqual([
        { jobId: courseJob.jobId, sourceKind: 'icloud_course' },
      ]);
      expect(ready).not.toContainEqual(expect.objectContaining({ jobId: normalJob.jobId }));
    });
  });

  it('rejects a CourseInbox request whose job ID differs from its folder', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedCourseQueueJob(harness.queueRoot, {
        requestJobId: '33333333-3333-4333-8333-333333333333',
      });
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' });
      expect(
        RejectionReceiptSchema.parse(
          JSON.parse(
            await readFile(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`), 'utf8'),
          ),
        ),
      ).toMatchObject({ jobId: seeded.jobId, errorCode: 'INVALID_QUEUE_ITEM' });
    });
  });

  it.each([
    ['request over 64 KiB', { manifestBytes: 65_537 }],
    ['multiple source files', { sourceCount: 2 }],
    ['symlink source', { symlinkSource: true }],
    ['nested directory', { nestedDirectory: true }],
    ['non-empty ready marker', { readyBytes: 'not-ready' }],
    ['unsupported source extension', { unsupportedExtension: true }],
  ] as const)('rejects CourseInbox %s with a durable safe receipt', async (_name, options) => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedCourseQueueJob(harness.queueRoot, options);
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toBeInstanceOf(AppError);
      await expect(access(seeded.folderPath)).resolves.toBeUndefined();
      const rawReceipt = await readFile(
        join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`),
        'utf8',
      );
      expect(RejectionReceiptSchema.parse(JSON.parse(rawReceipt))).toMatchObject({
        jobId: seeded.jobId,
        errorCode: 'INVALID_QUEUE_ITEM',
      });
      expect(rawReceipt).not.toContain(seeded.folderPath);
      expect(rawReceipt).not.toContain('audio bytes');
    });
  });

  it.each(['metadata', 'source', 'ready'] as const)(
    'does not observe a CourseInbox bundle with missing %s',
    async (missingFile) => {
      await withTempDirectory(async (root) => {
        const harness = await createHarness(root);
        const seeded = await seedCourseQueueJob(harness.queueRoot);
        const missingPath =
          missingFile === 'metadata'
            ? seeded.metadataPath
            : missingFile === 'source'
              ? seeded.sourcePath
              : join(seeded.folderPath, 'ready');
        await rm(missingPath);

        expect(await scanAfterStableInterval(harness.queue, harness.clock)).toEqual([]);
        await expect(
          access(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`)),
        ).rejects.toBeDefined();
      });
    },
  );

  it('normalizes an unreadable collision receipt reparse point to INVALID_QUEUE_ITEM', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      await seedQueueJob(harness.queueRoot, { jobId: courseJob.jobId });
      const rejectionDirectory = join(harness.queueRoot, 'Rejected');
      const rejectionPath = join(rejectionDirectory, `${courseJob.jobId}.json`);
      const externalTarget = join(root, 'untrusted-rejection-target');
      await mkdir(rejectionDirectory, { recursive: true });
      await mkdir(externalTarget);
      await writeFile(join(externalTarget, 'private.txt'), 'private attacker data', 'utf8');
      await symlink(externalTarget, rejectionPath, 'junction');

      const error = await harness.queue.scanReady().catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'INVALID_QUEUE_ITEM',
        displayMessage: 'iCloud 대기열 항목 형식을 확인해 주세요.',
      });
      expect(String(error)).not.toContain(rejectionPath);
      expect(String(error)).not.toContain('private attacker data');
      expect(await readFile(join(externalTarget, 'private.txt'), 'utf8')).toBe(
        'private attacker data',
      );
    });
  });

  it.each(['metadata', 'source', 'ready'] as const)(
    'resets CourseInbox stability when %s changes between scans',
    async (changedFile) => {
      await withTempDirectory(async (root) => {
        const harness = await createHarness(root);
        const seeded = await seedCourseQueueJob(harness.queueRoot);
        expect(await harness.queue.scanReady()).toEqual([]);
        await harness.clock.advance(1_500);
        if (changedFile === 'metadata') {
          const request = JSON.parse(await readFile(seeded.metadataPath, 'utf8')) as Record<
            string,
            unknown
          >;
          await writeFile(
            seeded.metadataPath,
            `${JSON.stringify({ ...request, summaryMode: 'deep' })}\n`,
          );
        } else if (changedFile === 'source') {
          await writeFile(seeded.sourcePath, 'changed audio bytes');
        } else {
          await writeFile(join(seeded.folderPath, 'ready'), 'changed');
        }

        expect(await harness.queue.scanReady()).toEqual([]);
      });
    },
  );

  it('rejects a CourseInbox source over its media limit', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root, {
        sourceLimits: { audioVideoMaxBytes: 8, documentImageMaxBytes: 8 },
      });
      const seeded = await seedCourseQueueJob(harness.queueRoot, { sourceBytes: 'ninebytes' });
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
      expect(
        RejectionReceiptSchema.parse(
          JSON.parse(
            await readFile(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`), 'utf8'),
          ),
        ),
      ).toMatchObject({ errorCode: 'SOURCE_TOO_LARGE' });
    });
  });

  it('rejects a UUID present in both lanes instead of choosing either bundle', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const normalJob = await seedQueueJob(harness.queueRoot, { jobId: courseJob.jobId });

      expect(await harness.queue.scanReady()).toEqual([]);
      const rawReceipt = await readFile(
        join(harness.queueRoot, 'Rejected', `${courseJob.jobId}.json`),
        'utf8',
      );
      expect(RejectionReceiptSchema.parse(JSON.parse(rawReceipt))).toMatchObject({
        jobId: courseJob.jobId,
        errorCode: 'INVALID_QUEUE_ITEM',
      });
      await expect(access(courseJob.folderPath)).resolves.toBeUndefined();
      await expect(access(normalJob.folderPath)).resolves.toBeUndefined();
      expect(await harness.queue.scanReady()).toEqual([]);
    });
  });

  it('invalidates a ready item when the same UUID appears in the other lane before claim', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
      await seedQueueJob(harness.queueRoot, { jobId: courseJob.jobId });

      await expect(
        harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' });
      await expect(access(join(harness.stagingRoot, courseJob.jobId))).rejects.toBeDefined();
      const rawReceipt = await readFile(
        join(harness.queueRoot, 'Rejected', `${courseJob.jobId}.json`),
        'utf8',
      );
      expect(RejectionReceiptSchema.parse(JSON.parse(rawReceipt))).toMatchObject({
        jobId: courseJob.jobId,
        errorCode: 'INVALID_QUEUE_ITEM',
      });
      expect(rawReceipt).not.toContain(courseJob.folderPath);
      expect(rawReceipt).not.toContain('audio bytes');
    });
  });

  it('rolls back a claim when the opposite lane appears after atomic reservation', async () => {
    await withTempDirectory(async (root) => {
      const queueRoot = join(root, 'iCloud Queue');
      const originalPath = join(queueRoot, 'CourseInbox', TEST_IDS.job);
      const expectedReservationPath = join(queueRoot, 'Inbox', TEST_IDS.job);
      let observedReservationPath = '';
      let reservationWasRegularFile = false;
      let originalWasPresentDuringReservation = false;
      const harness = await createHarness(root, {
        afterClaimReservation: async (reservationPath: string) => {
          observedReservationPath = reservationPath;
          reservationWasRegularFile = (await stat(reservationPath)).isFile();
          originalWasPresentDuringReservation = await access(originalPath).then(
            () => true,
            () => false,
          );
          await rm(reservationPath);
          await seedQueueJob(queueRoot, { jobId: TEST_IDS.job });
        },
      });
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' });

      expect(observedReservationPath).toBe(expectedReservationPath);
      expect(reservationWasRegularFile).toBe(true);
      expect(originalWasPresentDuringReservation).toBe(true);
      await expect(access(courseJob.folderPath)).resolves.toBeUndefined();
      await expect(
        access(join(harness.queueRoot, 'Inbox', courseJob.jobId)),
      ).resolves.toBeUndefined();
      await expect(access(join(harness.stagingRoot, courseJob.jobId))).rejects.toBeDefined();
      const rawReceipt = await readFile(
        join(harness.queueRoot, 'Rejected', `${courseJob.jobId}.json`),
        'utf8',
      );
      expect(RejectionReceiptSchema.parse(JSON.parse(rawReceipt))).toMatchObject({
        jobId: courseJob.jobId,
        errorCode: 'INVALID_QUEUE_ITEM',
      });
      expect(rawReceipt).not.toContain(courseJob.folderPath);
      expect(rawReceipt).not.toContain('audio bytes');
    });
  });

  it('does not claim a marker replaced in the final pre-commit interval', async () => {
    await withTempDirectory(async (root) => {
      const queueRoot = join(root, 'iCloud Queue');
      const reservationPath = join(queueRoot, 'Inbox', TEST_IDS.job);
      let injected = false;
      const dependencies = {
        beforeClaimReservationCommit: async () => {
          injected = true;
          await rm(reservationPath);
          await seedQueueJob(queueRoot, {
            jobId: TEST_IDS.job,
            sourceBytes: 'replacement bytes',
          });
        },
      };
      const harness = await createHarness(root, dependencies);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' });

      expect(injected).toBe(true);
      await expect(access(courseJob.folderPath)).resolves.toBeUndefined();
      await expect(access(join(harness.stagingRoot, courseJob.jobId))).rejects.toBeDefined();
      const preservedPath = await findPreservedClaimPath(harness.queueRoot);
      await expect(access(preservedPath)).resolves.toBeUndefined();
      expect(await readFile(join(preservedPath, 'source.m4a'), 'utf8')).toBe('replacement bytes');
    });
  });

  it.each(['write', 'sync'] as const)(
    'cleans an incomplete reservation when its %s step fails',
    async (failureStep) => {
      await withTempDirectory(async (root) => {
        const queueRoot = join(root, 'iCloud Queue');
        const reservationPath = join(queueRoot, 'Inbox', TEST_IDS.job);
        const dependencies = {
          ...(failureStep === 'write'
            ? {
                beforeClaimReservationWrite: async () => {
                  throw new Error('INJECTED_RESERVATION_WRITE_FAILURE');
                },
              }
            : {
                beforeClaimReservationSync: async () => {
                  throw new Error('INJECTED_RESERVATION_SYNC_FAILURE');
                },
              }),
        };
        const harness = await createHarness(root, dependencies);
        const courseJob = await seedCourseQueueJob(harness.queueRoot);
        const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);

        await expect(
          harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot),
        ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' });

        await expect(access(courseJob.folderPath)).resolves.toBeUndefined();
        await expect(access(reservationPath)).rejects.toBeDefined();
        await mkdir(reservationPath);
        expect((await stat(reservationPath)).isDirectory()).toBe(true);
      });
    },
  );

  it('does not delete a replacement while recovering from reservation sync failure', async () => {
    await withTempDirectory(async (root) => {
      const queueRoot = join(root, 'iCloud Queue');
      const reservationPath = join(queueRoot, 'Inbox', TEST_IDS.job);
      const dependencies = {
        beforeClaimReservationSync: async () => {
          await rm(reservationPath);
          await seedQueueJob(queueRoot, {
            jobId: TEST_IDS.job,
            sourceBytes: 'replacement bytes',
          });
          throw new Error('INJECTED_RESERVATION_SYNC_FAILURE');
        },
      };
      const harness = await createHarness(root, dependencies);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' });

      expect(
        await readFile(join(await findPreservedClaimPath(harness.queueRoot), 'source.m4a'), 'utf8'),
      ).toBe('replacement bytes');
      await expect(access(courseJob.folderPath)).resolves.toBeUndefined();
      await expect(access(join(harness.stagingRoot, courseJob.jobId))).rejects.toBeDefined();
    });
  });

  it('replaces a non-collision rejection receipt when a UUID exists in both lanes', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      await seedQueueJob(harness.queueRoot, { jobId: courseJob.jobId });
      await harness.queue.writeRejection(
        RejectionReceiptSchema.parse({
          jobId: courseJob.jobId,
          status: 'failed',
          displayMessage: '원본 파일이 허용된 크기를 초과했습니다.',
          updatedAt: NOW,
          errorCode: 'SOURCE_TOO_LARGE',
        }),
      );

      expect(await harness.queue.scanReady()).toEqual([]);
      const receipt = RejectionReceiptSchema.parse(
        JSON.parse(
          await readFile(join(harness.queueRoot, 'Rejected', `${courseJob.jobId}.json`), 'utf8'),
        ),
      );
      expect(receipt).toMatchObject({
        jobId: courseJob.jobId,
        errorCode: 'INVALID_QUEUE_ITEM',
      });
    });
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['over-limit data', 'x'.repeat(16 * 1024 + 1)],
  ] as const)(
    'normalizes %s in an existing collision receipt to INVALID_QUEUE_ITEM',
    async (_name, existingReceipt) => {
      await withTempDirectory(async (root) => {
        const harness = await createHarness(root);
        const courseJob = await seedCourseQueueJob(harness.queueRoot);
        await seedQueueJob(harness.queueRoot, { jobId: courseJob.jobId });
        const rejectionPath = join(harness.queueRoot, 'Rejected', `${courseJob.jobId}.json`);
        await mkdir(join(harness.queueRoot, 'Rejected'), { recursive: true });
        await writeFile(rejectionPath, existingReceipt, 'utf8');

        await expect(harness.queue.scanReady()).resolves.toEqual([]);
        const rawReceipt = await readFile(rejectionPath, 'utf8');
        expect(RejectionReceiptSchema.parse(JSON.parse(rawReceipt))).toMatchObject({
          jobId: courseJob.jobId,
          errorCode: 'INVALID_QUEUE_ITEM',
        });
        expect(rawReceipt).not.toContain('{not-json');
        expect(rawReceipt).not.toContain(courseJob.folderPath);
      });
    },
  );

  it('removes completed data only from the claimed CourseInbox lane', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const normalJob = await seedQueueJob(harness.queueRoot, {
        jobId: '33333333-3333-4333-8333-333333333333',
      });
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
      const claimed = await harness.queue.claim(requireReadyItem(item), harness.stagingRoot);
      const reservationPath = join(harness.queueRoot, 'Inbox', courseJob.jobId);
      expect((await stat(reservationPath)).isFile()).toBe(true);
      await harness.queue.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: courseJob.jobId,
          courseId: claimed.manifest.courseId,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: AFTER_STABILITY,
        }),
      );

      await harness.queue.removeCompleted(courseJob.jobId, 'icloud_course');
      await harness.queue.removeCompleted(courseJob.jobId, 'icloud_course');

      await expect(access(courseJob.folderPath)).rejects.toBeDefined();
      await expect(access(reservationPath)).rejects.toBeDefined();
      await expect(access(normalJob.folderPath)).resolves.toBeUndefined();
    });
  });

  it('removes a completed v2 queue bundle without touching its immutable staging copy', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedV2QueueJob(harness.queueRoot);
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
      const claimed = await harness.queue.claim(requireReadyItem(item), harness.stagingRoot);
      const reservationPath = join(harness.queueRoot, 'CourseInbox', seeded.jobId);
      expect((await stat(reservationPath)).isFile()).toBe(true);
      await harness.queue.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: seeded.jobId,
          courseId: claimed.manifest.courseId,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: AFTER_STABILITY,
        }),
      );

      await harness.queue.removeCompleted(seeded.jobId, 'icloud');
      await harness.queue.removeCompleted(seeded.jobId, 'icloud');

      await expect(access(seeded.folderPath)).rejects.toBeDefined();
      await expect(access(reservationPath)).rejects.toBeDefined();
      await expect(access(claimed.stagingDirectoryPath)).resolves.toBeUndefined();
      expect(
        await Promise.all(claimed.sources.map((source) => readFile(source.stagedPath, 'utf8'))),
      ).toEqual(['v2 audio bytes', 'v2 image bytes']);
    });
  });

  it.each(['icloud', 'icloud_course'] as const)(
    'preserves a replacement moved between %s validation and completed cleanup rename',
    async (sourceKind) => {
      await withTempDirectory(async (root) => {
        const queueRoot = join(root, 'iCloud Queue');
        const originalPath = join(root, `claimed-${sourceKind}`);
        let replaceBeforeRename = false;
        let replacementCleanupPath = '';
        const harness = await createHarness(root, {
          beforeCompletedCleanupRename: async (sourcePath, cleanupPath) => {
            if (!replaceBeforeRename) {
              return;
            }
            replacementCleanupPath = cleanupPath;
            await rename(sourcePath, originalPath);
            if (sourceKind === 'icloud') {
              await seedQueueJob(queueRoot, {
                jobId: TEST_IDS.job,
                sourceBytes: 'replacement bytes',
              });
            } else {
              await seedCourseQueueJob(queueRoot, {
                jobId: TEST_IDS.job,
                sourceBytes: 'replacement bytes',
              });
            }
          },
        });
        const seeded =
          sourceKind === 'icloud'
            ? await seedQueueJob(harness.queueRoot)
            : await seedCourseQueueJob(harness.queueRoot);
        const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
        const claimed = await harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot);
        await harness.queue.writeReceipt(
          StatusReceiptSchema.parse({
            jobId: seeded.jobId,
            courseId: claimed.manifest.courseId,
            status: 'completed',
            displayMessage: '강의 자료 정리가 완료되었습니다.',
            updatedAt: AFTER_STABILITY,
          }),
        );
        replaceBeforeRename = true;

        await expect(harness.queue.removeCompleted(seeded.jobId, sourceKind)).rejects.toMatchObject(
          {
            code: 'QUEUE_WRITE_FAILED',
          },
        );

        expect(await readFile(join(originalPath, 'source.m4a'), 'utf8')).toBe('audio bytes');
        expect(await readFile(join(replacementCleanupPath, 'source.m4a'), 'utf8')).toBe(
          'replacement bytes',
        );
      });
    },
  );

  it('preserves a completed-bundle entry replaced after validation before removal', async () => {
    await withTempDirectory(async (root) => {
      let injectReplacement = false;
      let replacementInjected = false;
      const harness = await createHarness(root, {
        beforeCompletedEntryRemoval: async (entryPath) => {
          if (!injectReplacement || replacementInjected || !entryPath.endsWith('source.m4a')) {
            return;
          }
          replacementInjected = true;
          await rm(entryPath);
          await writeFile(entryPath, 'entry replacement bytes', 'utf8');
        },
      });
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
      const claimed = await harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot);
      await harness.queue.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: courseJob.jobId,
          courseId: claimed.manifest.courseId,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: AFTER_STABILITY,
        }),
      );
      injectReplacement = true;

      await expect(
        harness.queue.removeCompleted(courseJob.jobId, 'icloud_course'),
      ).rejects.toMatchObject({ code: 'QUEUE_WRITE_FAILED' });

      expect(replacementInjected).toBe(true);
      const preservedPaths = (await readdir(join(harness.queueRoot, 'Rejected')))
        .filter((name) => name.startsWith('.completed-entry-quarantine-'))
        .map((name) => join(harness.queueRoot, 'Rejected', name));
      expect(preservedPaths).toHaveLength(1);
      expect(await readFile(requireReadyItem(preservedPaths[0]), 'utf8')).toBe(
        'entry replacement bytes',
      );
    });
  });

  it('preserves a marker replacement from the final pre-removal interval', async () => {
    await withTempDirectory(async (root) => {
      const queueRoot = join(root, 'iCloud Queue');
      const reservationPath = join(queueRoot, 'CourseInbox', TEST_IDS.job);
      let injectReplacement = false;
      const dependencies = {
        beforeClaimReservationRemoval: async () => {
          if (!injectReplacement) {
            return;
          }
          await rm(reservationPath);
          await writeFile(reservationPath, 'replacement bytes', 'utf8');
        },
      };
      const harness = await createHarness(root, dependencies);
      const normalJob = await seedQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
      const claimed = await harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot);
      await harness.queue.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: normalJob.jobId,
          courseId: claimed.manifest.courseId,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: AFTER_STABILITY,
        }),
      );
      injectReplacement = true;

      await expect(harness.queue.removeCompleted(normalJob.jobId, 'icloud')).rejects.toMatchObject({
        code: 'QUEUE_WRITE_FAILED',
      });

      expect(await readFile(await findPreservedClaimPath(harness.queueRoot), 'utf8')).toBe(
        'replacement bytes',
      );
    });
  });

  it('reclaims transient work while the durable marker keeps the opposite lane serialized', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);

      const first = await harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot);
      const second = await harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot);
      const reservationPath = join(harness.queueRoot, 'Inbox', courseJob.jobId);

      expect(second.sourceSha256).toBe(first.sourceSha256);
      expect((await stat(reservationPath)).isFile()).toBe(true);
      await expect(mkdir(reservationPath)).rejects.toMatchObject({ code: 'EEXIST' });
    });
  });

  it('recovers a known reservation when hard links are unsupported during anchor publication', async () => {
    await withTempDirectory(async (root) => {
      const queueRoot = join(root, 'iCloud Queue');
      const reservationPath = join(queueRoot, 'Inbox', TEST_IDS.job);
      const anchorPath = join(queueRoot, 'Rejected', `.claim-icloud_course-${TEST_IDS.job}.json`);
      const harness = await createHarness(root, {
        claimReservationLink: async (sourcePath, targetPath) => {
          if (targetPath === anchorPath) {
            throw Object.assign(new Error('INJECTED_HARD_LINK_UNSUPPORTED'), {
              code: 'EOPNOTSUPP',
            });
          }
          await linkFile(sourcePath, targetPath);
        },
      });
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'QUEUE_ITEM_NOT_STABLE' });

      expect((await stat(reservationPath)).isFile()).toBe(true);
      await expect(mkdir(reservationPath)).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(
        access(join(harness.queueRoot, 'Rejected', `${courseJob.jobId}.json`)),
      ).rejects.toBeDefined();
      expect(
        (await readdir(join(harness.queueRoot, 'Rejected'))).filter((name) =>
          name.startsWith('.claim-quarantine-'),
        ),
      ).toEqual([]);

      const restarted = new ICloudQueue(harness.queueRoot, {
        clock: () => Date.parse(harness.clock.now()),
      });
      const [retryItem] = await scanAfterStableInterval(restarted, harness.clock);
      const claimed = await restarted.claim(requireReadyItem(retryItem), harness.stagingRoot);
      await restarted.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: courseJob.jobId,
          courseId: claimed.manifest.courseId,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: harness.clock.now(),
        }),
      );

      await restarted.removeCompleted(courseJob.jobId, 'icloud_course');

      await expect(access(reservationPath)).rejects.toBeDefined();
      await expect(access(anchorPath)).rejects.toBeDefined();
      expect(
        (await readdir(join(harness.queueRoot, 'Rejected'))).filter((name) =>
          name.startsWith('.claim-quarantine-'),
        ),
      ).toEqual([]);
    });
  });

  it('recovers a transient re-claim when exact marker hard-link publication fails', async () => {
    await withTempDirectory(async (root) => {
      const queueRoot = join(root, 'iCloud Queue');
      const reservationPath = join(queueRoot, 'Inbox', TEST_IDS.job);
      const anchorPath = join(queueRoot, 'Rejected', `.claim-icloud_course-${TEST_IDS.job}.json`);
      let failMarkerPublication = false;
      const harness = await createHarness(root, {
        claimReservationLink: async (sourcePath, targetPath) => {
          if (failMarkerPublication && targetPath === reservationPath) {
            throw Object.assign(new Error('INJECTED_MARKER_LINK_FAILURE'), { code: 'EIO' });
          }
          await linkFile(sourcePath, targetPath);
        },
      });
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
      await harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot);
      failMarkerPublication = true;

      await expect(
        harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'QUEUE_ITEM_NOT_STABLE' });

      expect((await stat(anchorPath)).isFile()).toBe(true);
      expect((await stat(reservationPath)).isFile()).toBe(true);
      await expect(mkdir(reservationPath)).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(
        access(join(harness.queueRoot, 'Rejected', `${courseJob.jobId}.json`)),
      ).rejects.toBeDefined();
      expect(
        (await readdir(join(harness.queueRoot, 'Rejected'))).filter((name) =>
          name.startsWith('.claim-quarantine-'),
        ),
      ).toEqual([]);

      const restarted = new ICloudQueue(harness.queueRoot, {
        clock: () => Date.parse(harness.clock.now()),
      });
      const [retryItem] = await scanAfterStableInterval(restarted, harness.clock);
      const claimed = await restarted.claim(requireReadyItem(retryItem), harness.stagingRoot);
      await restarted.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: courseJob.jobId,
          courseId: claimed.manifest.courseId,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: harness.clock.now(),
        }),
      );

      await restarted.removeCompleted(courseJob.jobId, 'icloud_course');

      await expect(access(reservationPath)).rejects.toBeDefined();
      await expect(access(anchorPath)).rejects.toBeDefined();
      expect(
        (await readdir(join(harness.queueRoot, 'Rejected'))).filter((name) =>
          name.startsWith('.claim-quarantine-'),
        ),
      ).toEqual([]);
    });
  });

  it('preserves a deterministic-quarantine replacement after commit validation', async () => {
    await withTempDirectory(async (root) => {
      const queueRoot = join(root, 'iCloud Queue');
      const reservationPath = join(queueRoot, 'Inbox', TEST_IDS.job);
      const quarantinePath = join(
        queueRoot,
        'Rejected',
        `.claim-quarantine-icloud_course-${TEST_IDS.job}.json`,
      );
      const harness = await createHarness(root, {
        claimReservationLink: async (sourcePath, targetPath) => {
          await linkFile(sourcePath, targetPath);
          if (sourcePath === quarantinePath && targetPath === reservationPath) {
            await rm(sourcePath);
            await writeFile(sourcePath, 'commit replacement bytes', 'utf8');
          }
        },
      });
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' });

      expect(await readFile(await findPreservedClaimPath(harness.queueRoot), 'utf8')).toBe(
        'commit replacement bytes',
      );
      expect(await readFile(courseJob.sourcePath, 'utf8')).toBe('audio bytes');
    });
  });

  it('recovers a reservation stranded after its marker is renamed before restart', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
      await harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot);
      const reservationPath = join(harness.queueRoot, 'Inbox', courseJob.jobId);
      const anchorPath = join(
        harness.queueRoot,
        'Rejected',
        `.claim-icloud_course-${courseJob.jobId}.json`,
      );
      const quarantinePath = join(
        harness.queueRoot,
        'Rejected',
        `.claim-quarantine-icloud_course-${courseJob.jobId}.json`,
      );
      await rename(reservationPath, quarantinePath);

      await expect(access(reservationPath)).rejects.toBeDefined();
      await expect(access(anchorPath)).resolves.toBeUndefined();
      await expect(access(quarantinePath)).resolves.toBeUndefined();

      const restarted = new ICloudQueue(harness.queueRoot, {
        clock: () => Date.parse(harness.clock.now()),
      });
      expect(await restarted.scanReady()).toEqual([]);
      expect((await stat(reservationPath)).isFile()).toBe(true);
      await expect(mkdir(reservationPath)).rejects.toMatchObject({ code: 'EEXIST' });
      await harness.clock.advance(1_500);
      const [retryItem] = await restarted.scanReady();
      const claimed = await restarted.claim(requireReadyItem(retryItem), harness.stagingRoot);
      await restarted.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: courseJob.jobId,
          courseId: claimed.manifest.courseId,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: harness.clock.now(),
        }),
      );

      await restarted.removeCompleted(courseJob.jobId, 'icloud_course');

      await expect(access(courseJob.folderPath)).rejects.toBeDefined();
      await expect(access(reservationPath)).rejects.toBeDefined();
      await expect(access(anchorPath)).rejects.toBeDefined();
      await expect(access(quarantinePath)).rejects.toBeDefined();
      expect(
        (await readdir(join(harness.queueRoot, 'Rejected'))).filter((name) =>
          name.startsWith('.claim-quarantine-'),
        ),
      ).toEqual([]);
    });
  });

  it('preserves a deterministic-quarantine replacement after restart recovery validation', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
      await harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot);
      const reservationPath = join(harness.queueRoot, 'Inbox', courseJob.jobId);
      const anchorPath = join(
        harness.queueRoot,
        'Rejected',
        `.claim-icloud_course-${courseJob.jobId}.json`,
      );
      const quarantinePath = join(
        harness.queueRoot,
        'Rejected',
        `.claim-quarantine-icloud_course-${courseJob.jobId}.json`,
      );
      await rename(reservationPath, quarantinePath);

      await expect(
        readClaimReservation(reservationPath, anchorPath, join(harness.queueRoot, 'Rejected'), {
          link: async (sourcePath, targetPath) => {
            await linkFile(sourcePath, targetPath);
            if (sourcePath === quarantinePath && targetPath === reservationPath) {
              await rm(sourcePath);
              await writeFile(sourcePath, 'recovery replacement bytes', 'utf8');
            }
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' });

      expect(await readFile(await findPreservedClaimPath(harness.queueRoot), 'utf8')).toBe(
        'recovery replacement bytes',
      );
      expect(await readFile(courseJob.sourcePath, 'utf8')).toBe('audio bytes');
    });
  });

  it('preserves a forged deterministic quarantine that has no owned marker or anchor', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
      const item = requireReadyItem(readyItem);
      const quarantinePath = join(
        harness.queueRoot,
        'Rejected',
        `.claim-quarantine-icloud_course-${courseJob.jobId}.json`,
      );
      const forgedRecord = `${JSON.stringify({
        jobId: courseJob.jobId,
        sourceKind: 'icloud_course',
        claimToken: item.claimToken,
      })}\n`;
      await writeFile(quarantinePath, forgedRecord, 'utf8');

      await expect(harness.queue.claim(item, harness.stagingRoot)).rejects.toMatchObject({
        code: 'INVALID_QUEUE_ITEM',
      });

      expect(await readFile(quarantinePath, 'utf8')).toBe(forgedRecord);
      expect(await readFile(courseJob.sourcePath, 'utf8')).toBe('audio bytes');
      await expect(access(courseJob.folderPath)).resolves.toBeUndefined();
      await expect(access(join(harness.queueRoot, 'Inbox', courseJob.jobId))).rejects.toBeDefined();
    });
  });

  it('keeps the exact marker across restart when every hard-link publication fails', async () => {
    await withTempDirectory(async (root) => {
      const queueRoot = join(root, 'iCloud Queue');
      const reservationPath = join(queueRoot, 'Inbox', TEST_IDS.job);
      let linkAttempts = 0;
      const failHardLink: NonNullable<
        ICloudQueueDependencies['claimReservationLink']
      > = async () => {
        linkAttempts += 1;
        throw Object.assign(new Error('INJECTED_HARD_LINK_UNSUPPORTED'), {
          code: 'EOPNOTSUPP',
        });
      };
      const harness = await createHarness(root, { claimReservationLink: failHardLink });
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'QUEUE_ITEM_NOT_STABLE' });
      expect((await stat(reservationPath)).isFile()).toBe(true);
      await expect(mkdir(reservationPath)).rejects.toMatchObject({ code: 'EEXIST' });

      const restarted = new ICloudQueue(harness.queueRoot, {
        claimReservationLink: failHardLink,
        clock: () => Date.parse(harness.clock.now()),
      });
      const [retryItem] = await scanAfterStableInterval(restarted, harness.clock);
      await expect(
        restarted.claim(requireReadyItem(retryItem), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'QUEUE_ITEM_NOT_STABLE' });

      expect(linkAttempts).toBe(2);
      expect(await readFile(courseJob.sourcePath, 'utf8')).toBe('audio bytes');
      await expect(access(courseJob.folderPath)).resolves.toBeUndefined();
      expect((await stat(reservationPath)).isFile()).toBe(true);
      await expect(mkdir(reservationPath)).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(
        access(join(harness.queueRoot, 'Rejected', `${courseJob.jobId}.json`)),
      ).rejects.toBeDefined();
      await expect(
        access(join(harness.queueRoot, 'Status', `${courseJob.jobId}.json`)),
      ).rejects.toBeDefined();
      expect(
        (await readdir(join(harness.queueRoot, 'Rejected'))).filter((name) =>
          name.startsWith('.claim-quarantine-'),
        ),
      ).toEqual([]);
    });
  });

  it('preserves a conflicting opposite-lane replacement after marker publication fails', async () => {
    await withTempDirectory(async (root) => {
      const queueRoot = join(root, 'iCloud Queue');
      const reservationPath = join(queueRoot, 'Inbox', TEST_IDS.job);
      const anchorPath = join(queueRoot, 'Rejected', `.claim-icloud_course-${TEST_IDS.job}.json`);
      let injectConflict = false;
      const harness = await createHarness(root, {
        claimReservationLink: async (sourcePath, targetPath) => {
          if (injectConflict && targetPath === reservationPath) {
            await seedQueueJob(queueRoot, {
              jobId: TEST_IDS.job,
              sourceBytes: 'conflicting replacement bytes',
            });
          }
          await linkFile(sourcePath, targetPath);
        },
      });
      await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
      await harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot);
      injectConflict = true;

      await expect(
        harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' });

      expect((await stat(anchorPath)).isFile()).toBe(true);
      expect(await readFile(join(reservationPath, 'source.m4a'), 'utf8')).toBe(
        'conflicting replacement bytes',
      );
      const quarantinePaths = (await readdir(join(harness.queueRoot, 'Rejected')))
        .filter((name) => name.startsWith('.claim-quarantine-'))
        .map((name) => join(harness.queueRoot, 'Rejected', name));
      expect(quarantinePaths).toHaveLength(1);
      expect((await stat(requireReadyItem(quarantinePaths[0]))).isFile()).toBe(true);

      const restarted = new ICloudQueue(harness.queueRoot);
      await expect(restarted.scanReady()).resolves.toEqual([]);
      expect(await readFile(join(reservationPath, 'source.m4a'), 'utf8')).toBe(
        'conflicting replacement bytes',
      );
      await expect(access(anchorPath)).resolves.toBeUndefined();
      await expect(access(requireReadyItem(quarantinePaths[0]))).resolves.toBeUndefined();
    });
  });

  it('finishes interrupted cleanup from the durable anchor after restart', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const normalJob = await seedQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
      const claimed = await harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot);
      const reservationPath = join(harness.queueRoot, 'CourseInbox', normalJob.jobId);
      const anchorPath = join(
        harness.queueRoot,
        'Rejected',
        `.claim-icloud-${normalJob.jobId}.json`,
      );
      await harness.queue.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: normalJob.jobId,
          courseId: claimed.manifest.courseId,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: AFTER_STABILITY,
        }),
      );
      await rm(normalJob.folderPath, { recursive: true });
      await rm(reservationPath);
      await expect(access(anchorPath)).resolves.toBeUndefined();

      const restarted = new ICloudQueue(harness.queueRoot);
      await restarted.removeCompleted(normalJob.jobId, 'icloud');

      await expect(access(anchorPath)).rejects.toBeDefined();
      await expect(access(reservationPath)).rejects.toBeDefined();
    });
  });

  it('preserves an interrupted cleanup quarantine containing multiple sources', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      await harness.queue.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: courseJob.jobId,
          courseId: TEST_IDS.course,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: AFTER_STABILITY,
        }),
      );
      const quarantinePath = join(
        harness.queueRoot,
        'Rejected',
        `.completed-icloud_course-${courseJob.jobId}`,
      );
      await rename(courseJob.folderPath, quarantinePath);
      await writeFile(join(quarantinePath, 'source.mp3'), 'attacker bytes', 'utf8');

      await expect(
        harness.queue.removeCompleted(courseJob.jobId, 'icloud_course'),
      ).rejects.toMatchObject({ code: 'QUEUE_WRITE_FAILED' });
      await expect(access(quarantinePath)).resolves.toBeUndefined();
      expect((await readdir(quarantinePath)).toSorted()).toEqual([
        'ready',
        'request.json',
        'source.m4a',
        'source.mp3',
      ]);
      expect(await readFile(join(quarantinePath, 'source.mp3'), 'utf8')).toBe('attacker bytes');
    });
  });

  it('rejects a forged deterministic cleanup directory after restart without deleting it', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot, {
        sourceBytes: 'forged cleanup bytes',
      });
      await harness.queue.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: courseJob.jobId,
          courseId: TEST_IDS.course,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: AFTER_STABILITY,
        }),
      );
      const cleanupPath = join(
        harness.queueRoot,
        'Rejected',
        `.completed-icloud_course-${courseJob.jobId}`,
      );
      await rename(courseJob.folderPath, cleanupPath);

      const restarted = new ICloudQueue(harness.queueRoot);
      await expect(
        restarted.removeCompleted(courseJob.jobId, 'icloud_course'),
      ).rejects.toMatchObject({ code: 'QUEUE_WRITE_FAILED' });

      expect(await readFile(join(cleanupPath, 'source.m4a'), 'utf8')).toBe('forged cleanup bytes');
    });
  });

  it.each(['icloud', 'icloud_course'] as const)(
    'rejects a forged %s cleanup authorized only by a lone matching claim anchor',
    async (sourceKind) => {
      await withTempDirectory(async (root) => {
        const harness = await createHarness(root);
        const seeded =
          sourceKind === 'icloud'
            ? await seedQueueJob(harness.queueRoot, { sourceBytes: 'forged cleanup bytes' })
            : await seedCourseQueueJob(harness.queueRoot, {
                sourceBytes: 'forged cleanup bytes',
              });
        const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
        const item = requireReadyItem(readyItem);
        await harness.queue.writeReceipt(
          StatusReceiptSchema.parse({
            jobId: seeded.jobId,
            courseId: TEST_IDS.course,
            status: 'completed',
            displayMessage: '강의 자료 정리가 완료되었습니다.',
            updatedAt: AFTER_STABILITY,
          }),
        );
        const cleanupPath = join(
          harness.queueRoot,
          'Rejected',
          `.completed-${sourceKind}-${seeded.jobId}`,
        );
        const anchorPath = join(
          harness.queueRoot,
          'Rejected',
          `.claim-${sourceKind}-${seeded.jobId}.json`,
        );
        const reservationPath = join(
          harness.queueRoot,
          sourceKind === 'icloud' ? 'CourseInbox' : 'Inbox',
          seeded.jobId,
        );
        const forgedRecord = `${JSON.stringify({
          jobId: seeded.jobId,
          sourceKind,
          claimToken: item.claimToken,
        })}\n`;
        await rename(seeded.folderPath, cleanupPath);
        await writeFile(anchorPath, forgedRecord, 'utf8');

        const restarted = new ICloudQueue(harness.queueRoot);
        await expect(restarted.removeCompleted(seeded.jobId, sourceKind)).rejects.toMatchObject({
          code: 'QUEUE_WRITE_FAILED',
        });

        expect(await readFile(join(cleanupPath, 'source.m4a'), 'utf8')).toBe(
          'forged cleanup bytes',
        );
        expect(await readFile(anchorPath, 'utf8')).toBe(forgedRecord);
        await expect(access(reservationPath)).rejects.toBeDefined();
      });
    },
  );

  it('normalizes malformed completed-cleanup claim evidence to QUEUE_WRITE_FAILED', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      await harness.queue.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: courseJob.jobId,
          courseId: TEST_IDS.course,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: AFTER_STABILITY,
        }),
      );
      const anchorPath = join(
        harness.queueRoot,
        'Rejected',
        `.claim-icloud_course-${courseJob.jobId}.json`,
      );
      const malformedEvidence = '{not-json';
      await writeFile(anchorPath, malformedEvidence, 'utf8');

      await expect(
        harness.queue.removeCompleted(courseJob.jobId, 'icloud_course'),
      ).rejects.toMatchObject({ code: 'QUEUE_WRITE_FAILED' });

      expect(await readFile(courseJob.sourcePath, 'utf8')).toBe('audio bytes');
      expect(await readFile(anchorPath, 'utf8')).toBe(malformedEvidence);
    });
  });

  it('finishes a claimed deterministic cleanup directory after restart', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const courseJob = await seedCourseQueueJob(harness.queueRoot);
      const [readyItem] = await scanAfterStableInterval(harness.queue, harness.clock);
      const claimed = await harness.queue.claim(requireReadyItem(readyItem), harness.stagingRoot);
      await harness.queue.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: courseJob.jobId,
          courseId: claimed.manifest.courseId,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: AFTER_STABILITY,
        }),
      );
      const cleanupPath = join(
        harness.queueRoot,
        'Rejected',
        `.completed-icloud_course-${courseJob.jobId}`,
      );
      await rename(courseJob.folderPath, cleanupPath);

      const restarted = new ICloudQueue(harness.queueRoot);
      await restarted.removeCompleted(courseJob.jobId, 'icloud_course');

      await expect(access(cleanupPath)).rejects.toBeDefined();
      await expect(access(join(harness.queueRoot, 'Inbox', courseJob.jobId))).rejects.toBeDefined();
      await expect(
        access(join(harness.queueRoot, 'Rejected', `.claim-icloud_course-${courseJob.jobId}.json`)),
      ).rejects.toBeDefined();
    });
  });

  it('bounds each scan while rotating fairly through a large inbox', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root, { maxScanEntries: 1, maxReadyItems: 1 });
      const jobIds = [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
      ] as const;
      for (const jobId of jobIds) {
        await seedQueueJob(harness.queueRoot, { jobId, sourceBytes: jobId });
      }

      const observed = new Set<string>();
      for (let scan = 0; scan < 9; scan += 1) {
        const ready = await harness.queue.scanReady();
        expect(ready.length).toBeLessThanOrEqual(1);
        for (const item of ready) {
          observed.add(item.jobId);
        }
        await harness.clock.advance(1_500);
      }
      expect(observed).toEqual(new Set(jobIds));
    });
  });

  it('evicts and closes a scan directory after read fails so the next scans recover', async () => {
    await withTempDirectory(async (root) => {
      const inboxPath = join(root, 'iCloud Queue', 'Inbox');
      let inboxOpenCount = 0;
      let failedDirectoryCloseCount = 0;
      const harness = await createHarness(root, {
        openScanDirectory: async (path) => {
          const directory = await opendir(path);
          if (path !== inboxPath || inboxOpenCount > 0) {
            return directory;
          }
          inboxOpenCount += 1;
          return Object.freeze({
            close: async () => {
              failedDirectoryCloseCount += 1;
              await directory.close();
              throw new Error('INJECTED_SCAN_CLOSE_FAILURE');
            },
            read: async () => {
              throw new Error('INJECTED_SCAN_READ_FAILURE');
            },
          });
        },
      });
      const seeded = await seedQueueJob(harness.queueRoot);

      await expect(harness.queue.scanReady()).rejects.toThrow('INJECTED_SCAN_READ_FAILURE');
      expect(failedDirectoryCloseCount).toBe(1);
      expect(await harness.queue.scanReady()).toEqual([]);
      await harness.clock.advance(1_500);

      await expect(harness.queue.scanReady()).resolves.toContainEqual(
        expect.objectContaining({ jobId: seeded.jobId, sourceKind: 'icloud' }),
      );
    });
  });

  it('rejects a job directory with many junk entries without accepting its source', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedQueueJob(harness.queueRoot);
      for (let index = 0; index < 64; index += 1) {
        await writeFile(join(seeded.folderPath, `junk-${index.toString().padStart(2, '0')}`), 'x');
      }

      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' });
      await expect(access(seeded.folderPath)).resolves.toBeUndefined();
      await expect(
        access(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`)),
      ).resolves.toBeUndefined();
    });
  });

  it('cleans the staged copy when the queue item changes after copying', async () => {
    await withTempDirectory(async (root) => {
      let sourcePath = '';
      const harness = await createHarness(root, {
        afterStagingCopy: async () => writeFile(sourcePath, 'changed after staging copy'),
      });
      const seeded = await seedQueueJob(harness.queueRoot);
      sourcePath = seeded.sourcePath;
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'QUEUE_ITEM_NOT_STABLE' });
      await expect(access(join(harness.stagingRoot, seeded.jobId))).rejects.toBeDefined();

      expect(await harness.queue.scanReady()).toEqual([]);
      await harness.clock.advance(1_500);
      const [changedItem] = await harness.queue.scanReady();
      await expect(
        harness.queue.claim(requireReadyItem(changedItem), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'SOURCE_HASH_MISMATCH' });
      await expect(access(join(harness.stagingRoot, seeded.jobId))).rejects.toBeDefined();
      await expect(
        access(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`)),
      ).resolves.toBeUndefined();
    });
  });

  it('preserves a pre-existing v1 staging directory that this claim does not own', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedQueueJob(harness.queueRoot);
      const stagedJobDirectory = join(harness.stagingRoot, seeded.jobId);
      await mkdir(stagedJobDirectory);
      await writeFile(join(stagedJobDirectory, 'source.m4a'), 'audio bytes');
      await writeFile(seeded.sourcePath, 'changed before restart');
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'SOURCE_COPY_FAILED' });
      expect(await readFile(join(stagedJobDirectory, 'source.m4a'), 'utf8')).toBe('audio bytes');
      await expect(
        access(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`)),
      ).rejects.toBeDefined();
      await expect(access(seeded.folderPath)).resolves.toBeUndefined();
    });
  });

  it('validates scan work limits and clock output', async () => {
    await withTempDirectory(async (root) => {
      const queueRoot = join(root, 'iCloud Queue');
      await mkdir(queueRoot);

      expect(() => new ICloudQueue(queueRoot, { maxScanEntries: 0 })).toThrow(
        'INVALID_QUEUE_WORK_LIMITS',
      );
      expect(() => new ICloudQueue(queueRoot, { maxReadyItems: 51 })).toThrow(
        'INVALID_QUEUE_WORK_LIMITS',
      );
      await expect(
        new ICloudQueue(queueRoot, { clock: () => Number.NaN }).scanReady(),
      ).rejects.toThrow('INVALID_QUEUE_CLOCK');
      await expect(new ICloudQueue(queueRoot).scanReady()).resolves.toEqual([]);
    });
  });

  it('ignores input until manifest and ready marker are stable across two scans', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedQueueJob(harness.queueRoot, { ready: false });

      expect(await harness.queue.scanReady()).toEqual([]);
      await seedReadyMarker(harness.queueRoot, seeded.jobId);
      expect(await harness.queue.scanReady()).toEqual([]);
      await harness.clock.advance(1_500);
      expect(await harness.queue.scanReady()).toEqual([
        expect.objectContaining({ jobId: seeded.jobId }),
      ]);
    });
  });

  it('resets stability when the source changes between scans', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedQueueJob(harness.queueRoot);
      expect(await harness.queue.scanReady()).toEqual([]);
      await harness.clock.advance(1_500);
      await writeFile(seeded.sourcePath, 'changed audio bytes');
      expect(await harness.queue.scanReady()).toEqual([]);
      await harness.clock.advance(1_500);
      expect(await harness.queue.scanReady()).toHaveLength(1);
    });
  });

  it('does not allow a caller to bypass stable scanning with a forged item', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedQueueJob(harness.queueRoot);

      await expect(
        harness.queue.claim(
          { jobId: seeded.jobId, claimToken: '0'.repeat(64), sourceKind: 'icloud' },
          harness.stagingRoot,
        ),
      ).rejects.toMatchObject({ code: 'QUEUE_ITEM_NOT_STABLE' });
      await expect(
        access(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`)),
      ).rejects.toBeDefined();
    });
  });

  it('invalidates a ready item when source bytes change before claim', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedQueueJob(harness.queueRoot);
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);
      await writeFile(seeded.sourcePath, 'changed after ready');

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'QUEUE_ITEM_NOT_STABLE' });
      await expect(
        access(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`)),
      ).rejects.toBeDefined();
    });
  });

  it('retries cloud hydration drift instead of durably rejecting the queue item', async () => {
    await withTempDirectory(async (root) => {
      let manifestPath = '';
      const harness = await createHarness(root, {
        readBundleMetadata: async () => {
          const bytes = await readFile(manifestPath);
          await writeFile(manifestPath, bytes);
          throw new AppError('INVALID_QUEUE_ITEM', 'iCloud 대기열 항목 형식을 확인해 주세요.');
        },
      });
      const seeded = await seedQueueJob(harness.queueRoot);
      manifestPath = join(seeded.folderPath, 'manifest.json');
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'QUEUE_ITEM_NOT_STABLE' });
      await expect(
        access(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`)),
      ).rejects.toBeDefined();
    });
  });

  it.each([
    ['manifest over 64 KiB', { manifestBytes: 65_537 }],
    ['multiple source files', { sourceCount: 2 }],
    ['symlink source', { symlinkSource: true }],
    ['nested directory', { nestedDirectory: true }],
    ['non-empty ready marker', { readyBytes: 'not-ready' }],
    ['unsupported source extension', { unsupportedExtension: true }],
  ] as const)('rejects %s without deleting or moving input', async (_name, options) => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedInvalidQueueJob(harness.queueRoot, options);
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toBeInstanceOf(AppError);
      await expect(access(seeded.folderPath)).resolves.toBeUndefined();
      expect((await stat(seeded.folderPath)).isDirectory()).toBe(true);
      const rawRejection = await readFile(
        join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`),
        'utf8',
      );
      expect(RejectionReceiptSchema.parse(JSON.parse(rawRejection))).toMatchObject({
        jobId: seeded.jobId,
        status: 'failed',
        errorCode: 'INVALID_QUEUE_ITEM',
      });
      expect(rawRejection).not.toContain(seeded.folderPath);
      expect(rawRejection).not.toContain('audio bytes');
      expect(await harness.queue.scanReady()).toEqual([]);
    });
  });

  it('rejects a source over its media limit and writes a safe attention receipt', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root, {
        sourceLimits: { audioVideoMaxBytes: 8, documentImageMaxBytes: 8 },
      });
      const seeded = await seedQueueJob(harness.queueRoot, { sourceBytes: 'ninebytes' });
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });

      const rawReceipt = await readFile(
        join(harness.queueRoot, 'Status', `${seeded.jobId}.json`),
        'utf8',
      );
      expect(StatusReceiptSchema.parse(JSON.parse(rawReceipt))).toMatchObject({
        jobId: seeded.jobId,
        status: 'failed',
        errorCode: 'SOURCE_TOO_LARGE',
        displayMessage: '원본 파일이 허용된 크기를 초과했습니다.',
      });
      expect(rawReceipt).not.toContain(seeded.sourcePath);
      await expect(access(seeded.folderPath)).resolves.toBeUndefined();
      expect(
        RejectionReceiptSchema.parse(
          JSON.parse(
            await readFile(join(harness.queueRoot, 'Rejected', `${seeded.jobId}.json`), 'utf8'),
          ),
        ),
      ).toMatchObject({ errorCode: 'SOURCE_TOO_LARGE' });
    });
  });

  it('claims a verified copy while leaving the iCloud source untouched', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedQueueJob(harness.queueRoot);
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      const claimed = await harness.queue.claim(requireReadyItem(item), harness.stagingRoot);

      expect(claimed).toMatchObject({
        manifest: { jobId: seeded.jobId },
        courseProvisioning: null,
        queueItemPath: seeded.folderPath,
        sourceKind: 'icloud',
      });
      expect(await readFile(claimed.stagedSourcePath, 'utf8')).toBe('audio bytes');
      expect(await readFile(seeded.sourcePath, 'utf8')).toBe('audio bytes');
      expect(claimed.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
      const reservationPath = join(harness.queueRoot, 'CourseInbox', seeded.jobId);
      expect((await stat(reservationPath)).isFile()).toBe(true);

      await harness.queue.writeReceipt(
        StatusReceiptSchema.parse({
          jobId: seeded.jobId,
          courseId: claimed.manifest.courseId,
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: AFTER_STABILITY,
        }),
      );
      await expect(
        harness.queue.removeCompleted(seeded.jobId, 'icloud_course'),
      ).rejects.toMatchObject({
        code: 'QUEUE_WRITE_FAILED',
      });
      await harness.queue.removeCompleted(seeded.jobId, 'icloud');
      await harness.queue.removeCompleted(seeded.jobId, 'icloud');
      await expect(access(seeded.folderPath)).rejects.toBeDefined();
      await expect(access(reservationPath)).rejects.toBeDefined();
    });
  });

  it('rejects a manifest hash mismatch and writes only a privacy-safe failure receipt', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const seeded = await seedQueueJob(harness.queueRoot, { manifestHash: 'wrong' });
      const [item] = await scanAfterStableInterval(harness.queue, harness.clock);

      await expect(
        harness.queue.claim(requireReadyItem(item), harness.stagingRoot),
      ).rejects.toMatchObject({ code: 'SOURCE_HASH_MISMATCH' });
      const rawReceipt = await readFile(
        join(harness.queueRoot, 'Status', `${seeded.jobId}.json`),
        'utf8',
      );
      const receipt = StatusReceiptSchema.parse(JSON.parse(rawReceipt));
      expect(receipt).toEqual({
        jobId: seeded.jobId,
        courseId: '11111111-1111-4111-8111-111111111111',
        status: 'failed',
        displayMessage: '원본 파일의 무결성 값이 일치하지 않습니다.',
        updatedAt: AFTER_STABILITY,
        errorCode: 'SOURCE_HASH_MISMATCH',
      });
      expect(rawReceipt).not.toContain(seeded.folderPath);
      expect(rawReceipt).not.toContain('audio bytes');
      await expect(access(seeded.folderPath)).resolves.toBeUndefined();
    });
  });
});
