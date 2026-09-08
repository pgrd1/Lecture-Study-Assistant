import { describe, expect, it } from 'vitest';
import { APP_METADATA } from '../../../src/shared/appMetadata';
import {
  CourseProvisioningInputSchema,
  CourseSchema,
  parseCourseInput,
  parseCoursePatch,
  parseCourseProvisioningInput,
} from '../../../src/shared/contracts/course';
import { EntityIdRequestSchema } from '../../../src/shared/contracts/ipc';
import {
  JOB_STATUSES,
  JobSchema,
  SOURCE_KINDS,
  toPublicQueueStatus,
} from '../../../src/shared/contracts/job';
import {
  CourseInboxRequestSchema,
  QueueManifestSchema,
  StatusReceiptSchema,
  toQueueManifest,
} from '../../../src/shared/contracts/queue';
import { AppSettingsSchema } from '../../../src/shared/contracts/settings';
import { APP_ERROR_MESSAGES, AppError, toErrorEnvelope } from '../../../src/shared/errors';
import { FakeClock } from '../../testkit/fakeClock';
import { courseFixture, jobFixture, queueManifestFixture, TEST_IDS } from '../../testkit/fixtures';

const NOW = '2026-09-01T00:00:00.000Z';

const courseInboxRequest = {
  protocolVersion: 1,
  jobId: '22222222-2222-4222-8222-222222222222',
  createdAt: '2026-09-05T12:00:00.000+09:00',
  course: {
    id: '11111111-1111-4111-8111-111111111111',
    name: '운영체제',
    professorName: '',
  },
  source: { fileName: '1주차.m4a', mediaType: 'audio' },
  summaryMode: 'standard',
} as const;

describe('shared contracts', () => {
  it('accepts a closed immutable mobile course-inbox request and converts it to a manifest', () => {
    const request = CourseInboxRequestSchema.parse(courseInboxRequest);

    expect(request).toEqual(courseInboxRequest);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.course)).toBe(true);
    expect(Object.isFrozen(request.source)).toBe(true);
    expect(toQueueManifest(request)).toMatchObject({
      jobId: courseInboxRequest.jobId,
      courseId: courseInboxRequest.course.id,
      source: courseInboxRequest.source,
    });
  });

  it('rejects mobile course-inbox requests with an undeclared course key', () => {
    expect(
      CourseInboxRequestSchema.safeParse({
        ...courseInboxRequest,
        course: { ...courseInboxRequest.course, folderName: '../운영체제' },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['empty course name', { course: { ...courseInboxRequest.course, name: '' } }],
    [
      '81-character course name',
      { course: { ...courseInboxRequest.course, name: '가'.repeat(81) } },
    ],
    [
      '81-character professor name',
      { course: { ...courseInboxRequest.course, professorName: '가'.repeat(81) } },
    ],
    ['CR course name', { course: { ...courseInboxRequest.course, name: '운영\r체제' } }],
    ['LF professor name', { course: { ...courseInboxRequest.course, professorName: '교수\n님' } }],
    ['C0 control', { course: { ...courseInboxRequest.course, name: '운영\u0001체제' } }],
    ['C1 control', { course: { ...courseInboxRequest.course, name: '운영\u0085체제' } }],
    ['line separator', { course: { ...courseInboxRequest.course, name: '운영\u2028체제' } }],
    ['paragraph separator', { course: { ...courseInboxRequest.course, name: '운영\u2029체제' } }],
    ['invalid course UUID', { course: { ...courseInboxRequest.course, id: 'course-1' } }],
    ['invalid job UUID', { jobId: 'job-1' }],
    ['offset-free timestamp', { createdAt: '2026-09-05T03:00:00.000' }],
    ['extra request key', { folderName: '../운영체제' }],
    ['unsupported extension', { source: { fileName: '1주차.exe', mediaType: 'audio' } }],
    ['mismatched media type', { source: { fileName: '1주차.pdf', mediaType: 'audio' } }],
  ] as const)('rejects a mobile course-inbox request with %s', (_case, override) => {
    expect(CourseInboxRequestSchema.safeParse({ ...courseInboxRequest, ...override }).success).toBe(
      false,
    );
  });

  it('parses a standalone immutable provisioning input through its trusted boundary', () => {
    const input = parseCourseProvisioningInput(courseInboxRequest.course);

    expect(input).toEqual(courseInboxRequest.course);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(CourseProvisioningInputSchema.parse(courseInboxRequest.course))).toBe(
      true,
    );
    expect(() =>
      parseCourseProvisioningInput({ ...courseInboxRequest.course, rawPath: 'C:\\private' }),
    ).toThrow('INVALID_COURSE');
  });

  it('persists every explicitly supported source kind', () => {
    expect(SOURCE_KINDS).toEqual(['icloud', 'icloud_course', 'local']);
    expect(JobSchema.parse({ ...jobFixture(), sourceKind: 'icloud_course' }).sourceKind).toBe(
      'icloud_course',
    );
    expect(() => JobSchema.parse({ ...jobFixture(), sourceKind: 'cloud' })).toThrow();
  });

  it('accepts a Korean course input, trims display fields, and freezes the value', () => {
    const course = parseCourseInput({ name: '  자료구조  ', professorName: ' 김교수 ' });

    expect(course).toEqual({ name: '자료구조', professorName: '김교수' });
    expect(Object.isFrozen(course)).toBe(true);
  });

  it.each(['', '   ', 'a'.repeat(81)])('rejects invalid course name %j', (name) => {
    expect(() => parseCourseInput({ name, professorName: '' })).toThrow(AppError);
    expect(() => parseCourseInput({ name, professorName: '' })).toThrow('INVALID_COURSE');
  });

  it.each(['자료구조\n악성 제목', '교수\u0000이름', '교수\u0085이름', '과목\u2028숨김'])(
    'rejects multiline or control course fields %j',
    (value) => {
      expect(() => parseCourseInput({ name: value, professorName: '' })).toThrow('INVALID_COURSE');
      expect(() => parseCourseInput({ name: '자료구조', professorName: value })).toThrow(
        'INVALID_COURSE',
      );
    },
  );

  it('parses a complete immutable course under the managed Vault root', () => {
    const course = CourseSchema.parse({
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

    expect(course.folderName).toBe('자료구조');
    expect(APP_METADATA.managedVaultRoot).toBe('AI 학습');
    expect(Object.isFrozen(course)).toBe(true);
  });

  it.each(['CON', 'name.', 'course:ads', 'course\u0001'])(
    'rejects an unsafe persisted course folder %s',
    (folderName) => {
      expect(() =>
        CourseSchema.parse({
          ...courseFixture(),
          folderName,
        }),
      ).toThrow();
    },
  );

  it('validates a non-empty immutable course patch', () => {
    const patch = parseCoursePatch({
      professorName: ' 새 교수 ',
      userInstructions: '시험 범위 우선',
    });

    expect(patch).toEqual({ professorName: '새 교수', userInstructions: '시험 범위 우선' });
    expect(Object.isFrozen(patch)).toBe(true);
    expect(() => parseCoursePatch({})).toThrow('INVALID_COURSE_PATCH');
  });

  it('normalizes multiline user instructions and rejects unsafe controls', () => {
    expect(parseCoursePatch({ userInstructions: '첫 줄\r\n둘째 줄' })).toEqual({
      userInstructions: '첫 줄\n둘째 줄',
    });
    expect(() => parseCoursePatch({ userInstructions: '메모\u0000숨김' })).toThrow(
      'INVALID_COURSE_PATCH',
    );
    expect(() => parseCoursePatch({ userInstructions: '메모\u0085숨김' })).toThrow(
      'INVALID_COURSE_PATCH',
    );
  });

  it.each([
    { name: undefined },
    { professorName: undefined },
    { name: undefined, professorName: undefined, userInstructions: undefined },
  ])('rejects a semantic no-op course patch %#', (patch) => {
    expect(() => parseCoursePatch(patch)).toThrow('INVALID_COURSE_PATCH');
  });

  it('accepts a safe queue manifest and deeply freezes its source descriptor', () => {
    const manifest = QueueManifestSchema.parse({
      protocolVersion: 1,
      jobId: TEST_IDS.job,
      courseId: TEST_IDS.course,
      createdAt: NOW,
      source: { fileName: '1주차 강의.m4a', mediaType: 'audio' },
      summaryMode: 'standard',
      sha256: 'a'.repeat(64),
    });

    expect(manifest.source.fileName).toBe('1주차 강의.m4a');
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.source)).toBe(true);
  });

  it.each([
    ['unsupported extension', { source: { fileName: 'attack.exe', mediaType: 'audio' } }],
    ['nested path', { source: { fileName: '../audio.m4a', mediaType: 'audio' } }],
    ['Windows path', { source: { fileName: 'C:\\audio.m4a', mediaType: 'audio' } }],
    ['drive-relative path', { source: { fileName: 'C:audio.m4a', mediaType: 'audio' } }],
    ['alternate data stream', { source: { fileName: 'lecture:evil.m4a', mediaType: 'audio' } }],
    ['Windows device name', { source: { fileName: 'CON.m4a', mediaType: 'audio' } }],
    ['trailing space', { source: { fileName: 'audio.m4a ', mediaType: 'audio' } }],
    ['control character', { source: { fileName: 'audio\u0001.m4a', mediaType: 'audio' } }],
    ['empty stem', { source: { fileName: '.m4a', mediaType: 'audio' } }],
    ['media mismatch', { source: { fileName: 'slides.pdf', mediaType: 'audio' } }],
    ['uppercase hash', { sha256: 'A'.repeat(64) }],
    ['invalid time', { createdAt: 'yesterday' }],
    ['unknown field', { secret: 'must-not-cross-boundary' }],
  ])('rejects a queue manifest with %s', (_case, override) => {
    const candidate = {
      protocolVersion: 1,
      jobId: TEST_IDS.job,
      courseId: TEST_IDS.course,
      createdAt: NOW,
      source: { fileName: 'audio.m4a', mediaType: 'audio' },
      summaryMode: 'standard',
      ...override,
    };

    expect(() => QueueManifestSchema.parse(candidate)).toThrow();
  });

  it('maps every internal job status to a privacy-safe public status', () => {
    const expected = {
      queued: 'queued',
      receiving: 'processing',
      source_ready: 'processing',
      transcribing_or_extracting: 'processing',
      structuring: 'processing',
      generating: 'processing',
      verifying: 'processing',
      writing: 'processing',
      completed: 'completed',
      retryable_failed: 'failed',
      needs_attention: 'failed',
    } as const;

    expect(JOB_STATUSES).toHaveLength(Object.keys(expected).length);
    for (const status of JOB_STATUSES) {
      expect(toPublicQueueStatus(status)).toBe(expected[status]);
    }
  });

  it('accepts only a minimal Korean status receipt', () => {
    const receipt = StatusReceiptSchema.parse({
      jobId: TEST_IDS.job,
      courseId: TEST_IDS.course,
      status: 'failed',
      displayMessage: '원본 파일의 무결성을 확인하지 못했습니다.',
      updatedAt: NOW,
      errorCode: 'SOURCE_HASH_FAILED',
    });

    expect(Object.keys(receipt).sort()).toEqual([
      'courseId',
      'displayMessage',
      'errorCode',
      'jobId',
      'status',
      'updatedAt',
    ]);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(() => StatusReceiptSchema.parse({ ...receipt, sourcePath: 'C:\\private' })).toThrow();
    expect(() => StatusReceiptSchema.parse({ ...receipt, displayMessage: 'processing' })).toThrow();
    expect(() => StatusReceiptSchema.parse({ ...receipt, status: 'processing' })).toThrow();
    expect(() =>
      StatusReceiptSchema.parse({ ...receipt, errorCode: 'INTERNAL_SQL_DETAIL' }),
    ).toThrow();
    expect(() =>
      StatusReceiptSchema.parse({
        jobId: TEST_IDS.job,
        courseId: TEST_IDS.course,
        status: 'completed',
        displayMessage: 'C:\\Users\\학생\\비밀강의.m4a 정리 완료',
        updatedAt: NOW,
      }),
    ).toThrow();
    expect(() =>
      StatusReceiptSchema.parse({
        jobId: TEST_IDS.job,
        courseId: TEST_IDS.course,
        status: 'failed',
        displayMessage: '확인이 필요합니다.',
        updatedAt: NOW,
      }),
    ).toThrow();
  });

  it('parses immutable jobs and settings for repository boundaries', () => {
    const job = JobSchema.parse(jobFixture());
    const settings = AppSettingsSchema.parse({
      schemaVersion: 1,
      vaultPath: 'C:\\Obsidian\\Study',
      icloudQueuePath: null,
      defaultSummaryMode: 'standard',
      autoStart: false,
      processingPaused: false,
      legalNoticeAcceptedAt: null,
      updatedAt: NOW,
      revision: 0,
    });

    expect(Object.isFrozen(job)).toBe(true);
    expect(Object.isFrozen(settings)).toBe(true);
    expect(() => AppSettingsSchema.parse({ ...settings, apiKey: 'secret' })).toThrow();
  });

  it('rejects impossible persisted job recovery fields', () => {
    const job = jobFixture();

    expect(() => JobSchema.parse({ ...job, lastSuccessfulStatus: 'retryable_failed' })).toThrow();
    expect(() => JobSchema.parse({ ...job, sourceFileName: '../lecture.m4a' })).toThrow();
    expect(() => JobSchema.parse({ ...job, sourceFileName: 'CON.m4a' })).toThrow();
    expect(() => JobSchema.parse({ ...job, sourceFileName: 'lecture:evil.m4a' })).toThrow();
    expect(() => JobSchema.parse({ ...job, fingerprint: 'course:hash' })).toThrow();
    expect(() => JobSchema.parse({ ...job, fingerprint: 'A'.repeat(64) })).toThrow();
    expect(() =>
      JobSchema.parse({
        ...job,
        status: 'retryable_failed',
        errorCode: null,
      }),
    ).toThrow();
    expect(() => JobSchema.parse({ ...job, errorCode: 'SOURCE_HASH_FAILED' })).toThrow();
    expect(() =>
      JobSchema.parse({
        ...job,
        status: 'retryable_failed',
        lastSuccessfulStatus: 'completed',
        errorCode: 'SOURCE_HASH_FAILED',
      }),
    ).toThrow();
    expect(() =>
      JobSchema.parse({
        ...job,
        status: 'receiving',
        lastSuccessfulStatus: 'generating',
      }),
    ).toThrow();
    expect(() =>
      JobSchema.parse({
        ...job,
        status: 'receiving',
        attentionResolutionId: TEST_IDS.attentionResolution,
      }),
    ).toThrow();
    expect(() =>
      JobSchema.parse({
        ...job,
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: NOW,
      }),
    ).toThrow();
  });

  it('accepts an interrupted job that safely rewinds to an earlier checkpoint', () => {
    const interrupted = JobSchema.parse({
      ...jobFixture(),
      status: 'structuring',
      lastSuccessfulStatus: 'source_ready',
    });

    expect(interrupted).toMatchObject({
      status: 'structuring',
      lastSuccessfulStatus: 'source_ready',
    });
    expect(Object.isFrozen(interrupted)).toBe(true);
  });

  it('serializes only safe application error fields', () => {
    const envelope = toErrorEnvelope(
      new AppError('SOURCE_COPY_FAILED', '원본을 복사하지 못했습니다.', { retryable: true }),
    );

    expect(envelope).toEqual({
      code: 'SOURCE_COPY_FAILED',
      message: '원본을 복사하지 못했습니다.',
      retryable: true,
    });
    expect(Object.keys(envelope).sort()).toEqual(['code', 'message', 'retryable']);
    expect(Object.isFrozen(envelope)).toBe(true);

    const recoverable = new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED, {
      recoveryToken: '.studyapp-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp',
      backupRecoveryToken:
        '.studyapp-backup-20260901-123456-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.bak',
    });
    expect(toErrorEnvelope(recoverable)).toEqual({
      code: 'VAULT_WRITE_FAILED',
      message: APP_ERROR_MESSAGES.VAULT_WRITE_FAILED,
      retryable: true,
    });
    expect(Object.keys(recoverable)).not.toContain('recoveryToken');
    expect(Object.keys(recoverable)).not.toContain('backupRecoveryToken');
    expect(
      () =>
        new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED, {
          recoveryToken: 'C:\\private\\temp.tmp',
        }),
    ).toThrow('INVALID_APP_ERROR_RECOVERY_TOKEN');

    const unexpected = new Error('C:\\Users\\student\\강의 원문 secret-value', {
      cause: { sourceText: 'private lecture' },
    });
    expect(toErrorEnvelope(unexpected)).toEqual({
      code: 'UNEXPECTED_ERROR',
      message: '예상하지 못한 오류가 발생했습니다.',
      retryable: false,
    });
  });

  it('keeps bounded retry metadata private, trusted, frozen, and out of public envelopes', () => {
    const limited = new AppError(
      'PROVIDER_RATE_LIMITED',
      APP_ERROR_MESSAGES.PROVIDER_RATE_LIMITED,
      { retryAfterMs: 99_999 },
    );

    expect(AppError.getRetryAfterMs(limited)).toBe(5_000);
    expect(Object.isFrozen(limited)).toBe(true);
    expect(Object.keys(limited)).not.toContain('retryAfterMs');
    expect(JSON.stringify(limited)).not.toContain('5000');
    expect(toErrorEnvelope(limited)).toEqual({
      code: 'PROVIDER_RATE_LIMITED',
      message: APP_ERROR_MESSAGES.PROVIDER_RATE_LIMITED,
      retryable: true,
    });
    expect(Object.keys(toErrorEnvelope(limited)).sort()).toEqual(['code', 'message', 'retryable']);
    expect(AppError.getRetryAfterMs(new Error('forged'))).toBeNull();
    expect(
      AppError.getRetryAfterMs(
        Object.assign(Object.create(AppError.prototype) as AppError, {
          code: 'PROVIDER_RATE_LIMITED',
          retryAfterMs: 5_000,
        }),
      ),
    ).toBeNull();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe AppError retry metadata %s',
    (retryAfterMs) => {
      expect(
        () =>
          new AppError('PROVIDER_RATE_LIMITED', APP_ERROR_MESSAGES.PROVIDER_RATE_LIMITED, {
            retryAfterMs,
          }),
      ).toThrow('INVALID_APP_ERROR_RETRY_AFTER');
    },
  );

  it.each([
    ['English-only text', 'processing failed'],
    ['Windows path', 'C:\\Users\\student\\secret.m4a 파일을 처리하지 못했습니다.'],
    ['POSIX path', '/Users/student/secret.m4a 파일을 처리하지 못했습니다.'],
    ['blank after trimming', '   '],
  ])('rejects unsafe application error display messages: %s', (_case, displayMessage) => {
    expect(() => new AppError('SOURCE_COPY_FAILED', displayMessage)).toThrow(
      'INVALID_APP_ERROR_MESSAGE',
    );
  });

  it('falls back safely for an object forged with the AppError prototype', () => {
    const forged = Object.assign(Object.create(AppError.prototype) as AppError, {
      code: 'SOURCE_COPY_FAILED',
      displayMessage: '원본을 복사하지 못했습니다.',
      retryable: true,
    });

    expect(toErrorEnvelope(forged)).toEqual({
      code: 'UNEXPECTED_ERROR',
      message: '예상하지 못한 오류가 발생했습니다.',
      retryable: false,
    });

    const catalogForged = Object.assign(Object.create(AppError.prototype) as AppError, {
      code: 'SOURCE_COPY_FAILED',
      displayMessage: APP_ERROR_MESSAGES.SOURCE_COPY_FAILED,
      retryable: true,
    });
    expect(toErrorEnvelope(catalogForged)).toEqual({
      code: 'UNEXPECTED_ERROR',
      message: '예상하지 못한 오류가 발생했습니다.',
      retryable: false,
    });
  });

  it.each([
    ['SAFE_PATH', '안전하지 않은 경로입니다.', false],
    ['INVALID_FINGERPRINT', '중복 검사 값을 확인해 주세요.', false],
    ['INVALID_JOB_TRANSITION', '허용되지 않는 작업 상태 변경입니다.', false],
    ['SOURCE_HASH_FAILED', '원본 파일의 무결성을 확인하지 못했습니다.', true],
    ['SOURCE_TOO_LARGE', '원본 파일이 허용된 크기를 초과했습니다.', false],
    ['SOURCE_HASH_CANCELLED', '원본 파일 무결성 확인이 취소되었습니다.', false],
  ] as const)('round-trips the fixed %s error envelope', (code, message, retryable) => {
    expect(toErrorEnvelope(new AppError(code, APP_ERROR_MESSAGES[code], { retryable }))).toEqual({
      code,
      message,
      retryable,
    });
  });

  it('derives retryability from the error-code policy', () => {
    expect(
      new AppError('SOURCE_HASH_FAILED', APP_ERROR_MESSAGES.SOURCE_HASH_FAILED).retryable,
    ).toBe(true);
    expect(
      new AppError('SOURCE_HASH_CANCELLED', APP_ERROR_MESSAGES.SOURCE_HASH_CANCELLED).retryable,
    ).toBe(false);
    expect(
      () =>
        new AppError('SOURCE_TOO_LARGE', APP_ERROR_MESSAGES.SOURCE_TOO_LARGE, {
          retryable: true,
        }),
    ).toThrow('INVALID_APP_ERROR_RETRY_POLICY');
  });

  it('provides frozen, stable fixtures without mutating defaults', () => {
    const course = courseFixture({ name: '알고리즘' });
    const defaultCourse = courseFixture();
    const job = jobFixture({ status: 'structuring' });
    const manifest = queueManifestFixture({ summaryMode: 'core' });

    expect(course.name).toBe('알고리즘');
    expect(defaultCourse.name).toBe('자료구조');
    expect(job.status).toBe('structuring');
    expect(manifest.summaryMode).toBe('core');
    expect([course, defaultCourse, job, manifest].every(Object.isFrozen)).toBe(true);
  });

  it('advances a fake clock without changing the process-wide clock', async () => {
    const beforeSystemTime = Date.now();
    const clock = new FakeClock(NOW);

    await clock.advance(1_500);

    expect(clock.now()).toBe('2026-09-01T00:00:01.500Z');
    expect(Date.now()).toBeGreaterThanOrEqual(beforeSystemTime);
    expect(Date.now() - beforeSystemTime).toBeLessThan(1_000);
  });

  it('validates strict immutable entity-id IPC requests', () => {
    const request = EntityIdRequestSchema.parse({ id: TEST_IDS.course });

    expect(request).toEqual({ id: TEST_IDS.course });
    expect(Object.isFrozen(request)).toBe(true);
    expect(() =>
      EntityIdRequestSchema.parse({ id: TEST_IDS.course, rawPath: 'C:\\private' }),
    ).toThrow();
  });
});
