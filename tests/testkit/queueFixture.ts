import { createHash } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CourseProvisioningInput } from '../../src/shared/contracts/course';
import type { SourceMediaType } from '../../src/shared/contracts/job';
import { CourseInboxRequestSchema, QueueManifestSchema } from '../../src/shared/contracts/queue';
import { extensionOf } from '../../src/shared/contracts/sourceFile';
import { TEST_IDS } from './fixtures';

const CREATED_AT = '2026-09-01T00:00:00.000Z';

export type QueueFixtureOptions = Readonly<{
  jobId?: string;
  ready?: boolean;
  sourceBytes?: string | Buffer;
  sourceCount?: number;
  manifestBytes?: number;
  manifestHash?: 'correct' | 'wrong' | 'omit';
  symlinkSource?: boolean;
  nestedDirectory?: boolean;
  readyBytes?: string;
  unsupportedExtension?: boolean;
}>;

export type SeededQueueJob = Readonly<{
  folderPath: string;
  jobId: string;
  metadataPath: string;
  sourcePath: string;
}>;

export type CourseQueueFixtureOptions = QueueFixtureOptions &
  Readonly<{
    course?: CourseProvisioningInput;
    requestJobId?: string;
  }>;

export type V2QueueSourceFixture = Readonly<{
  fileName: string;
  id: string;
  mediaType: SourceMediaType;
  senderSha256?: 'correct' | 'wrong' | 'omit';
  sizeBytes?: number;
  sourceBytes: string | Buffer;
}>;

export type V2QueueFixtureOptions = Readonly<{
  courseId?: string;
  courseProvisioning?: CourseProvisioningInput | null;
  extraRootEntry?: boolean;
  extraSourceEntry?: boolean;
  jobId?: string;
  manifestOverrides?: Readonly<Record<string, unknown>>;
  omittedSourceIndexes?: readonly number[];
  physicalFileNameOverrides?: Readonly<Record<number, string>>;
  sourceKind?: 'icloud' | 'icloud_course';
  sources?: readonly V2QueueSourceFixture[];
  symlinkSourceIndex?: number;
}>;

export type SeededV2QueueJob = Readonly<{
  folderPath: string;
  jobId: string;
  manifestPath: string;
  sourcePaths: readonly string[];
}>;

export const V2_QUEUE_SOURCES = Object.freeze({
  audio: Object.freeze({
    fileName: 'lecture.m4a',
    id: '33333333-3333-4333-8333-333333333333',
    mediaType: 'audio',
    senderSha256: 'omit',
    sourceBytes: 'v2 audio bytes',
  }),
  image: Object.freeze({
    fileName: 'board.jpg',
    id: '44444444-4444-4444-8444-444444444444',
    mediaType: 'image',
    senderSha256: 'omit',
    sourceBytes: 'v2 image bytes',
  }),
} as const satisfies Record<string, V2QueueSourceFixture>);

export const seedReadyMarker = async (
  queueRoot: string,
  jobId: string = TEST_IDS.job,
): Promise<void> => {
  await writeFile(join(queueRoot, 'Inbox', jobId, 'ready'), Buffer.alloc(0));
};

export const seedQueueJob = async (
  queueRoot: string,
  options: QueueFixtureOptions = {},
): Promise<SeededQueueJob> => {
  const jobId = options.jobId ?? TEST_IDS.job;
  const folderPath = join(queueRoot, 'Inbox', jobId);
  const sourceBytes = options.sourceBytes ?? 'audio bytes';
  const sourceExtension = options.unsupportedExtension ? '.exe' : '.m4a';
  const sourcePath = join(folderPath, `source${sourceExtension}`);
  await mkdir(folderPath, { recursive: true });

  if (options.symlinkSource) {
    const sourceTarget = join(queueRoot, `fixture-${jobId}`);
    await mkdir(sourceTarget);
    await writeFile(join(sourceTarget, 'payload.m4a'), sourceBytes);
    await symlink(sourceTarget, sourcePath, 'junction');
  } else {
    await writeFile(sourcePath, sourceBytes);
  }
  for (let index = 1; index < (options.sourceCount ?? 1); index += 1) {
    const extension = index === 1 ? '.mp3' : '.wav';
    await writeFile(join(folderPath, `source${extension}`), `extra-${index}`);
  }
  if (options.nestedDirectory) {
    await mkdir(join(folderPath, 'nested'));
  }

  const hash = createHash('sha256').update(sourceBytes).digest('hex');
  const manifestInput = {
    protocolVersion: 1,
    jobId,
    courseId: TEST_IDS.course,
    createdAt: CREATED_AT,
    source: { fileName: `1주차 강의${sourceExtension}`, mediaType: 'audio' },
    summaryMode: 'standard',
    ...(options.manifestHash === 'omit'
      ? {}
      : { sha256: options.manifestHash === 'wrong' ? '0'.repeat(64) : hash }),
  };
  const manifest = options.unsupportedExtension
    ? manifestInput
    : QueueManifestSchema.parse(manifestInput);
  const encodedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(
    join(folderPath, 'manifest.json'),
    options.manifestBytes === undefined
      ? encodedManifest
      : encodedManifest.padEnd(options.manifestBytes, 'x'),
    'utf8',
  );
  if (options.ready ?? true) {
    await seedReadyMarker(queueRoot, jobId);
    if (options.readyBytes !== undefined) {
      await writeFile(join(folderPath, 'ready'), options.readyBytes, 'utf8');
    }
  }

  return Object.freeze({
    folderPath,
    jobId,
    metadataPath: join(folderPath, 'manifest.json'),
    sourcePath,
  });
};

export const seedInvalidQueueJob = seedQueueJob;

export const seedCourseQueueJob = async (
  queueRoot: string,
  options: CourseQueueFixtureOptions = {},
): Promise<SeededQueueJob> => {
  const jobId = options.jobId ?? TEST_IDS.job;
  const folderPath = join(queueRoot, 'CourseInbox', jobId);
  const sourceBytes = options.sourceBytes ?? 'audio bytes';
  const sourceExtension = options.unsupportedExtension ? '.exe' : '.m4a';
  const sourcePath = join(folderPath, `source${sourceExtension}`);
  const metadataPath = join(folderPath, 'request.json');
  await mkdir(folderPath, { recursive: true });

  if (options.symlinkSource) {
    const sourceTarget = join(queueRoot, `course-fixture-${jobId}`);
    await mkdir(sourceTarget);
    await writeFile(join(sourceTarget, 'payload.m4a'), sourceBytes);
    await symlink(sourceTarget, sourcePath, 'junction');
  } else {
    await writeFile(sourcePath, sourceBytes);
  }
  for (let index = 1; index < (options.sourceCount ?? 1); index += 1) {
    const extension = index === 1 ? '.mp3' : '.wav';
    await writeFile(join(folderPath, `source${extension}`), `extra-${index}`);
  }
  if (options.nestedDirectory) {
    await mkdir(join(folderPath, 'nested'));
  }

  const requestInput = {
    protocolVersion: 1,
    jobId: options.requestJobId ?? jobId,
    createdAt: CREATED_AT,
    course: options.course ?? {
      id: TEST_IDS.course,
      name: '자료구조',
      professorName: '김교수',
    },
    source: { fileName: `1주차 강의${sourceExtension}`, mediaType: 'audio' },
    summaryMode: 'standard',
  };
  const request = options.unsupportedExtension
    ? requestInput
    : CourseInboxRequestSchema.parse(requestInput);
  const encodedRequest = `${JSON.stringify(request, null, 2)}\n`;
  await writeFile(
    metadataPath,
    options.manifestBytes === undefined
      ? encodedRequest
      : encodedRequest.padEnd(options.manifestBytes, 'x'),
    'utf8',
  );
  if (options.ready ?? true) {
    await writeFile(join(folderPath, 'ready'), options.readyBytes ?? Buffer.alloc(0));
  }

  return Object.freeze({ folderPath, jobId, metadataPath, sourcePath });
};

export const seedV2QueueJob = async (
  queueRoot: string,
  options: V2QueueFixtureOptions = {},
): Promise<SeededV2QueueJob> => {
  const jobId = options.jobId ?? TEST_IDS.job;
  const courseId = options.courseId ?? TEST_IDS.course;
  const sourceKind = options.sourceKind ?? 'icloud';
  const directory = sourceKind === 'icloud' ? 'Inbox' : 'CourseInbox';
  const folderPath = join(queueRoot, directory, jobId);
  const sourcesPath = join(folderPath, 'sources');
  const sources: readonly V2QueueSourceFixture[] = options.sources ?? [
    V2_QUEUE_SOURCES.audio,
    V2_QUEUE_SOURCES.image,
  ];
  await mkdir(sourcesPath, { recursive: true });

  const omittedSourceIndexes = new Set(options.omittedSourceIndexes ?? []);
  const sourcePaths: string[] = [];
  for (const [index, source] of sources.entries()) {
    const physicalFileName =
      options.physicalFileNameOverrides?.[index] ??
      `${index}-${source.id}${extensionOf(source.fileName)}`;
    const sourcePath = join(sourcesPath, physicalFileName);
    sourcePaths.push(sourcePath);
    if (omittedSourceIndexes.has(index)) {
      continue;
    }
    if (options.symlinkSourceIndex === index) {
      const target = join(queueRoot, `v2-fixture-${jobId}-${index}`);
      await mkdir(target);
      await writeFile(join(target, 'payload.bin'), source.sourceBytes);
      await symlink(target, sourcePath, 'junction');
      continue;
    }
    await writeFile(sourcePath, source.sourceBytes);
  }

  if (options.extraRootEntry) {
    await writeFile(join(folderPath, 'ready'), '');
  }
  if (options.extraSourceEntry) {
    await writeFile(join(sourcesPath, 'extra.m4a'), 'extra source bytes');
  }

  const descriptors = sources.map((source) => {
    const sourceBytes = Buffer.isBuffer(source.sourceBytes)
      ? source.sourceBytes
      : Buffer.from(source.sourceBytes);
    const sha256 = createHash('sha256').update(sourceBytes).digest('hex');
    return {
      id: source.id,
      fileName: source.fileName,
      mediaType: source.mediaType,
      sizeBytes: source.sizeBytes ?? sourceBytes.byteLength,
      ...(source.senderSha256 === 'omit'
        ? {}
        : { sha256: source.senderSha256 === 'wrong' ? '0'.repeat(64) : sha256 }),
    };
  });
  const courseProvisioning =
    options.courseProvisioning === undefined
      ? sourceKind === 'icloud_course'
        ? { id: courseId, name: '자료구조', professorName: '김교수' }
        : null
      : options.courseProvisioning;
  const manifest = {
    protocolVersion: 2,
    jobId,
    courseId,
    createdAt: CREATED_AT,
    summaryMode: 'standard',
    sources: descriptors,
    ...(courseProvisioning === null ? {} : { courseProvisioning }),
    ...options.manifestOverrides,
  };
  const manifestPath = join(folderPath, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return Object.freeze({
    folderPath,
    jobId,
    manifestPath,
    sourcePaths: Object.freeze(sourcePaths),
  });
};
