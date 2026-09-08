import { describe, expect, it } from 'vitest';
import { createBundleFingerprint } from '../../../src/core/jobs/fingerprint';
import { JobSchema } from '../../../src/shared/contracts/job';
import { QueueManifestSchema } from '../../../src/shared/contracts/queue';
import {
  normalizeQueueManifest,
  SourceBundleManifestV2Schema,
  SourceBundleSchema,
  SourceRecordSchema,
} from '../../../src/shared/contracts/sourceBundle';

const COURSE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_A = '33333333-3333-4333-8333-333333333333';
const SOURCE_B = '44444444-4444-4444-8444-444444444444';
const BUNDLE_ID = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-09-06T00:00:00.000Z';

const v2Manifest = Object.freeze({
  protocolVersion: 2,
  jobId: JOB_ID,
  courseId: COURSE_ID,
  createdAt: NOW,
  summaryMode: 'standard',
  sources: [
    { id: SOURCE_A, fileName: 'lecture.m4a', mediaType: 'audio', sizeBytes: 12 },
    { id: SOURCE_B, fileName: 'board.jpg', mediaType: 'image', sizeBytes: 34 },
  ],
} as const);

describe('source bundle contracts', () => {
  it('accepts an ordered multi-source protocol-v2 manifest', () => {
    const parsed = SourceBundleManifestV2Schema.parse(v2Manifest);

    expect(parsed.sources.map((source) => source.id)).toEqual([SOURCE_A, SOURCE_B]);
    expect(Object.isFrozen(parsed.sources)).toBe(true);
  });

  it('rejects a source whose file extension conflicts with its media type', () => {
    expect(
      SourceBundleManifestV2Schema.safeParse({
        ...v2Manifest,
        sources: [{ ...v2Manifest.sources[0], fileName: 'board.jpg' }],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate source IDs and media or bundle size violations', () => {
    expect(
      SourceBundleManifestV2Schema.safeParse({
        ...v2Manifest,
        sources: [v2Manifest.sources[0], { ...v2Manifest.sources[1], id: SOURCE_A }],
      }).success,
    ).toBe(false);
    expect(
      SourceBundleManifestV2Schema.safeParse({
        ...v2Manifest,
        sources: [
          {
            id: SOURCE_A,
            fileName: 'notes.pdf',
            mediaType: 'document',
            sizeBytes: 500 * 1024 * 1024 + 1,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SourceBundleManifestV2Schema.safeParse({
        ...v2Manifest,
        sources: [
          {
            id: SOURCE_A,
            fileName: 'lecture.m4a',
            mediaType: 'audio',
            sizeBytes: 4 * 1024 * 1024 * 1024,
          },
          {
            id: SOURCE_B,
            fileName: 'lecture.mp3',
            mediaType: 'audio',
            sizeBytes: 4 * 1024 * 1024 * 1024,
          },
          {
            id: '66666666-6666-4666-8666-666666666666',
            fileName: 'slide.jpg',
            mediaType: 'image',
            sizeBytes: 1,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('allows course provisioning only for the manifest course', () => {
    expect(
      SourceBundleManifestV2Schema.safeParse({
        ...v2Manifest,
        courseProvisioning: { id: COURSE_ID, name: '운영체제' },
      }).success,
    ).toBe(true);
    expect(
      SourceBundleManifestV2Schema.safeParse({
        ...v2Manifest,
        courseProvisioning: {
          id: '77777777-7777-4777-8777-777777777777',
          name: '운영체제',
          professorName: '김교수',
        },
      }).success,
    ).toBe(false);
  });

  it('normalizes an omitted provisioning professor to the internal empty display name', () => {
    const normalized = normalizeQueueManifest(
      SourceBundleManifestV2Schema.parse({
        ...v2Manifest,
        courseProvisioning: { id: COURSE_ID, name: '운영체제' },
      }),
    );

    expect(normalized.courseProvisioning).toEqual({
      id: COURSE_ID,
      name: '운영체제',
      professorName: '',
    });
  });

  it('normalizes v1 to one source and retains v2 manifest order', () => {
    const v1 = QueueManifestSchema.parse({
      protocolVersion: 1,
      jobId: JOB_ID,
      courseId: COURSE_ID,
      createdAt: NOW,
      summaryMode: 'standard',
      source: { fileName: 'lecture.m4a', mediaType: 'audio' },
      sha256: 'a'.repeat(64),
    });

    expect(normalizeQueueManifest(v1).sources).toEqual([
      {
        id: JOB_ID,
        fileName: 'lecture.m4a',
        mediaType: 'audio',
        sizeBytes: null,
        sha256: 'a'.repeat(64),
      },
    ]);
    expect(normalizeQueueManifest(v2Manifest).sources.map((source) => source.id)).toEqual([
      SOURCE_A,
      SOURCE_B,
    ]);
  });

  it('validates strict protocol manifests before normalization', () => {
    expect(() =>
      normalizeQueueManifest({
        ...v2Manifest,
        sources: [{ ...v2Manifest.sources[0], fileName: 'board.jpg' }],
      }),
    ).toThrow();
    expect(() => normalizeQueueManifest({ ...v2Manifest, unexpected: true })).toThrow();
  });

  it('defines immutable persisted bundle and record contracts with legacy job defaults', () => {
    const bundle = SourceBundleSchema.parse({
      id: BUNDLE_ID,
      jobId: JOB_ID,
      manifestSha256: 'a'.repeat(64),
      sourceCount: 1,
      totalBytes: 12,
      stagingDirectoryPath: 'C:\\app\\staging\\bundle',
      createdAt: NOW,
    });
    const record = SourceRecordSchema.parse({
      id: SOURCE_A,
      bundleId: BUNDLE_ID,
      ordinal: 0,
      originalFileName: 'lecture.m4a',
      mediaType: 'audio',
      stagedPath: 'C:\\app\\staging\\bundle\\0-lecture.m4a',
      sha256: 'a'.repeat(64),
      sizeBytes: 12,
    });
    const legacy = JobSchema.parse({
      id: JOB_ID,
      courseId: COURSE_ID,
      sourceKind: 'local',
      sourceFileName: 'lecture.m4a',
      sourceMediaType: 'audio',
      summaryMode: 'standard',
      stagedSourcePath: 'C:\\app\\staging\\lecture.m4a',
      queueItemPath: null,
      sourceSha256: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64),
      status: 'queued',
      lastSuccessfulStatus: 'queued',
      retryCount: 0,
      errorCode: null,
      cleanupWarningCode: null,
      attentionResolutionId: null,
      createdAt: NOW,
      updatedAt: NOW,
      revision: 0,
    });

    expect([bundle, record].every(Object.isFrozen)).toBe(true);
    expect(legacy).toMatchObject({ sourceBundleId: null, sourceCount: 1 });
  });

  it('rejects a persisted source record whose extension conflicts with its media type', () => {
    expect(
      SourceRecordSchema.safeParse({
        id: SOURCE_A,
        bundleId: BUNDLE_ID,
        ordinal: 0,
        originalFileName: 'board.jpg',
        mediaType: 'audio',
        stagedPath: 'C:\\app\\staging\\bundle\\0-board.jpg',
        sha256: 'a'.repeat(64),
        sizeBytes: 12,
      }).success,
    ).toBe(false);
  });

  it('fingerprints the course and ordered source hashes', () => {
    expect(createBundleFingerprint(COURSE_ID, ['a'.repeat(64), 'b'.repeat(64)])).not.toBe(
      createBundleFingerprint(COURSE_ID, ['b'.repeat(64), 'a'.repeat(64)]),
    );
  });
});
