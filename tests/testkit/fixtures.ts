import { type Course, CourseSchema } from '../../src/shared/contracts/course';
import { type Job, JobSchema } from '../../src/shared/contracts/job';
import { type QueueManifest, QueueManifestSchema } from '../../src/shared/contracts/queue';

const NOW = '2026-09-01T00:00:00.000Z';

export const TEST_IDS = Object.freeze({
  course: '11111111-1111-4111-8111-111111111111',
  job: '22222222-2222-4222-8222-222222222222',
  attentionResolution: '33333333-3333-4333-8333-333333333333',
});

const DEFAULT_COURSE: Course = CourseSchema.parse({
  id: TEST_IDS.course,
  name: '자료구조',
  professorName: '김교수',
  folderName: '자료구조',
  userInstructions: '',
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  revision: 0,
});

const DEFAULT_JOB: Job = JobSchema.parse({
  id: TEST_IDS.job,
  courseId: TEST_IDS.course,
  sourceKind: 'local',
  sourceFileName: '1주차 강의.m4a',
  sourceMediaType: 'audio',
  summaryMode: 'standard',
  stagedSourcePath: `C:\\app\\staging\\${TEST_IDS.job}\\source.m4a`,
  queueItemPath: null,
  sourceSha256: 'b'.repeat(64),
  fingerprint: '9cd7e84c937ea0bcd9937ad7f2d4d67dd75718e230304793b02e071c8b1743d9',
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

const DEFAULT_MANIFEST: QueueManifest = QueueManifestSchema.parse({
  protocolVersion: 1,
  jobId: TEST_IDS.job,
  courseId: TEST_IDS.course,
  createdAt: NOW,
  source: {
    fileName: '1주차 강의.m4a',
    mediaType: 'audio',
  },
  summaryMode: 'standard',
  sha256: 'b'.repeat(64),
});

export const courseFixture = (overrides: Partial<Course> = {}): Course =>
  CourseSchema.parse({ ...DEFAULT_COURSE, ...overrides });

export const jobFixture = (overrides: Partial<Job> = {}): Job =>
  JobSchema.parse({ ...DEFAULT_JOB, ...overrides });

export const queueManifestFixture = (overrides: Partial<QueueManifest> = {}): QueueManifest =>
  QueueManifestSchema.parse({ ...DEFAULT_MANIFEST, ...overrides });
