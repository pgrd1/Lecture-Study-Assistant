import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CourseProvisioningInputSchema } from '../../../src/shared/contracts/course';
import {
  CourseCatalogSchema,
  CourseInboxRequestSchema,
  SOURCE_MEDIA_TYPES,
  SUPPORTED_EXTENSIONS,
} from '../../../src/shared/contracts/queue';
import { SourceBundleManifestV2Schema } from '../../../src/shared/contracts/sourceBundle';
import { APP_ERROR_MESSAGES } from '../../../src/shared/errors';
import { createScriptableHarness, loadStudyAssistant } from '../../testkit/scriptableHarness';

const api = loadStudyAssistant();
const courseId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-09-03T14:30:15.123+09:00';
const markerPath = '.lecture-study-assistant-root.json';
const ownerMarker = JSON.stringify({
  schemaVersion: 1,
  owner: 'lecture-study-assistant',
  queueProtocolVersion: 1,
});
const reservedDirectories = ['Catalog', 'Inbox', 'CourseInbox', 'Status', 'Rejected'];
const catalog = (courses = [{ id: courseId, name: '운영체제' }]) =>
  JSON.stringify({ protocolVersion: 1, generatedAt: timestamp, courses });
const courseInboxRequest = (
  pendingJobId = jobId,
  course: Readonly<{ id: string; name: string; professorName: string }> = {
    id: courseId,
    name: '운영체제',
    professorName: '김교수',
  },
) => ({
  protocolVersion: 1,
  jobId: pendingJobId,
  createdAt: timestamp,
  course,
  source: { fileName: 'lecture.m4a', mediaType: 'audio' },
  summaryMode: 'standard',
});
const pendingBundle = (
  pendingJobId: string,
  course?: Readonly<{ id: string; name: string; professorName: string }>,
) => ({
  existingDirectories: [`CourseInbox/${pendingJobId}`],
  fileContents: {
    [`CourseInbox/${pendingJobId}/request.json`]: JSON.stringify(
      courseInboxRequest(pendingJobId, course),
    ),
    [`CourseInbox/${pendingJobId}/source.m4a`]: 'source bytes that discovery must not read',
    [`CourseInbox/${pendingJobId}/ready`]: '',
  },
});
const inboxBundle = (inboxJobId: string, inboxCourseId = courseId) => ({
  existingDirectories: [`Inbox/${inboxJobId}`],
  fileContents: {
    [`Inbox/${inboxJobId}/manifest.json`]: JSON.stringify({
      protocolVersion: 1,
      jobId: inboxJobId,
      courseId: inboxCourseId,
      createdAt: timestamp,
      source: { fileName: 'lecture.m4a', mediaType: 'audio' },
      summaryMode: 'standard',
    }),
    [`Inbox/${inboxJobId}/source.m4a`]: 'source bytes that status must not read',
    [`Inbox/${inboxJobId}/ready`]: '',
  },
});

describe('StudyAssistant invocation contract', () => {
  it('treats a shortcut file URL as enqueue even when its text says status', () => {
    expect(
      api.parseInvocation({
        fileURLs: ['file:///private/tmp/status.txt'],
        shortcutParameter: 'status',
      }),
    ).toEqual({ action: 'enqueue', sourcePaths: ['/private/tmp/status.txt'] });
  });

  it('treats an absolute file path in shortcutParameter as enqueue input', () => {
    expect(
      api.parseInvocation({
        fileURLs: [],
        shortcutParameter: '/private/tmp/recorded-audio.m4a',
      }),
    ).toEqual({ action: 'enqueue', sourcePaths: ['/private/tmp/recorded-audio.m4a'] });
  });

  it('treats a file URL string in shortcutParameter as enqueue input', () => {
    expect(
      api.parseInvocation({
        fileURLs: [],
        shortcutParameter: 'file:///private/tmp/recorded%20audio.m4a',
      }),
    ).toEqual({ action: 'enqueue', sourcePaths: ['/private/tmp/recorded audio.m4a'] });
  });

  it('rejects an explicit status dictionary combined with a file', () => {
    expect(() =>
      api.parseInvocation({
        fileURLs: ['file:///private/tmp/lecture.m4a'],
        shortcutParameter: { action: 'status' },
      }),
    ).toThrowError('AMBIGUOUS_INPUT');
  });

  it('allows only the exact status dictionary without a file', () => {
    expect(api.parseInvocation({ fileURLs: [], shortcutParameter: { action: 'status' } })).toEqual({
      action: 'status',
    });
    expect(() =>
      api.parseInvocation({ fileURLs: [], shortcutParameter: { action: 'status', extra: true } }),
    ).toThrowError('INVALID_ACTION');
  });

  it('accepts the exact headless course-list request without a file', () => {
    expect(api.parseInvocation({ fileURLs: [], shortcutParameter: { action: 'courses' } })).toEqual(
      {
        action: 'courses',
      },
    );
    expect(() =>
      api.parseInvocation({ fileURLs: [], shortcutParameter: { action: 'courses', extra: true } }),
    ).toThrowError('INVALID_ACTION');
  });

  it('accepts an exact existing-course enqueue request with ordered files', () => {
    expect(
      api.parseInvocation({
        fileURLs: ['file:///private/tmp/lecture.m4a', 'file:///private/tmp/board.jpg'],
        shortcutParameter: { action: 'enqueue', courseId },
      }),
    ).toEqual({
      action: 'enqueue',
      courseId,
      sourcePaths: ['/private/tmp/lecture.m4a', '/private/tmp/board.jpg'],
    });
  });

  it('accepts an exact new-course enqueue request with ordered files', () => {
    expect(
      api.parseInvocation({
        fileURLs: ['file:///private/tmp/lecture.m4a', 'file:///private/tmp/board.jpg'],
        shortcutParameter: {
          action: 'enqueue',
          newCourseName: '  자료구조  ',
          professorName: '  김교수  ',
        },
      }),
    ).toEqual({
      action: 'enqueue',
      newCourse: { name: '  자료구조  ', professorName: '  김교수  ' },
      sourcePaths: ['/private/tmp/lecture.m4a', '/private/tmp/board.jpg'],
    });
  });

  it.each([
    {
      expected: 'AMBIGUOUS_INPUT',
      input: {
        fileURLs: ['file:///private/tmp/lecture.m4a'],
        shortcutParameter: { action: 'courses' },
      },
    },
    {
      expected: 'INVALID_INPUT',
      input: { fileURLs: [], shortcutParameter: { action: 'enqueue', courseId } },
    },
    {
      expected: 'INVALID_ACTION',
      input: {
        fileURLs: ['file:///private/tmp/lecture.m4a'],
        shortcutParameter: { action: 'enqueue', courseId, extra: true },
      },
    },
    {
      expected: 'INVALID_ACTION',
      input: {
        fileURLs: ['file:///private/tmp/lecture.m4a'],
        shortcutParameter: {
          action: 'enqueue',
          courseId,
          newCourseName: '자료구조',
          professorName: '',
        },
      },
    },
    {
      expected: 'INVALID_COURSE',
      input: {
        fileURLs: ['file:///private/tmp/lecture.m4a'],
        shortcutParameter: { action: 'enqueue', courseId: 'not-a-uuid' },
      },
    },
  ])('rejects an invalid headless request with $expected', ({ expected, input }) => {
    expect(() => api.parseInvocation(input)).toThrowError(expected);
  });

  it('accepts two Shortcut files as one ordered enqueue bundle', () => {
    expect(
      api.parseInvocation({
        fileURLs: ['file:///private/tmp/one.m4a', 'file:///private/tmp/board.jpg'],
        shortcutParameter: null,
      }),
    ).toEqual({
      action: 'enqueue',
      sourcePaths: ['/private/tmp/one.m4a', '/private/tmp/board.jpg'],
    });
  });

  it('rejects thirty-three Shortcut files before resolving storage', () => {
    expect(() =>
      api.parseInvocation({
        fileURLs: Array.from(
          { length: 33 },
          (_, index) => `file:///private/tmp/source-${index}.m4a`,
        ),
        shortcutParameter: null,
      }),
    ).toThrowError('INVALID_INPUT');
  });

  it('accepts exactly thirty-two distinct Shortcut files', () => {
    const sourcePaths = Array.from(
      { length: 32 },
      (_, index) => `/private/tmp/source-${index}.m4a`,
    );

    expect(
      api.parseInvocation({
        fileURLs: sourcePaths,
        shortcutParameter: null,
      }),
    ).toEqual({ action: 'enqueue', sourcePaths });
  });

  it('rejects duplicate resolved Shortcut source paths', () => {
    expect(() =>
      api.parseInvocation({
        fileURLs: ['file:///private/tmp/lecture%20one.m4a', '/private/tmp/lecture one.m4a'],
        shortcutParameter: null,
      }),
    ).toThrowError('INVALID_INPUT');
  });

  it('rejects an exact status dictionary with any number of files as ambiguous', () => {
    expect(() =>
      api.parseInvocation({
        fileURLs: ['file:///private/tmp/one.m4a', 'file:///private/tmp/two.m4a'],
        shortcutParameter: { action: 'status' },
      }),
    ).toThrowError('AMBIGUOUS_INPUT');
  });

  it('rejects a direct Scriptable launch without changing storage', async () => {
    const harness = createScriptableHarness();
    await expect(harness.run({ fileURLs: [], shortcutParameter: null })).resolves.toMatchObject({
      ok: false,
      code: 'SHORTCUT_ONLY',
    });
    expect(harness.fs.operations).toEqual([]);
  });
});

describe('StudyAssistant status aggregation contract', () => {
  const receipt = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      courseId,
      displayMessage: '강의 자료 정리가 완료되었습니다.',
      jobId,
      status: 'completed',
      updatedAt: timestamp,
      ...overrides,
    });

  it('derives queued, latest receipts, and sanitized failed details without reading source bytes', async () => {
    const queuedId = '33333333-3333-4333-8333-333333333333';
    const failedId = '44444444-4444-4444-8444-444444444444';
    const processingBundle = inboxBundle(jobId);
    const queuedBundle = inboxBundle(queuedId);
    const harness = createScriptableHarness({
      existingDirectories: [
        ...processingBundle.existingDirectories,
        ...queuedBundle.existingDirectories,
        'Inbox/not-a-job',
      ],
      fileContents: {
        ...processingBundle.fileContents,
        ...queuedBundle.fileContents,
        'Status/old.json': receipt({
          status: 'queued',
          displayMessage: '강의 자료가 안전하게 대기 중입니다.',
          updatedAt: '2026-09-03T01:00:00.000Z',
        }),
        'Status/new.json': receipt({
          status: 'processing',
          displayMessage: '강의 자료를 처리하고 있습니다.',
          updatedAt: '2026-09-03T02:00:00.000Z',
        }),
        'Status/failed.json': receipt({
          jobId: failedId,
          status: 'failed',
          errorCode: 'SOURCE_TOO_LARGE',
          displayMessage: APP_ERROR_MESSAGES.SOURCE_TOO_LARGE,
        }),
        'Status/notes.txt': 'ignored',
      },
      initiallyNotDownloaded: ['Status/new.json'],
    });

    await expect(harness.runStatus()).resolves.toMatchObject({
      ok: true,
      action: 'status',
      data: {
        queued: 1,
        processing: 1,
        completed: 0,
        failed: 1,
        unreadableStatusFiles: 0,
        failedItems: [{ jobId: failedId, displayMessage: APP_ERROR_MESSAGES.SOURCE_TOO_LARGE }],
      },
    });
    expect(harness.fs.reads).not.toContain(`Inbox/${jobId}/source.m4a`);
    expect(harness.calls.downloads).toContain('Status/new.json');
  });

  it('ignores uncommitted Inbox folders and counts malformed or oversized JSON as unreadable', async () => {
    const harness = createScriptableHarness({
      existingDirectories: [`Inbox/${jobId}`, `Inbox/${courseId}`],
      fileContents: {
        [`Inbox/${jobId}/ready`]: 'nonzero',
        [`Inbox/${courseId}/source.m4a`]: 'not committed',
        'Status/bad.json': '{private/raw/path}',
        'Status/large.json': receipt(),
        'Status/ignored.txt': '{not JSON}',
      },
      fileSizes: { 'Status/large.json': 64 * 1024 + 1 },
    });

    await expect(harness.runStatus()).resolves.toMatchObject({
      ok: true,
      data: {
        queued: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        unreadableStatusFiles: 2,
        failedItems: [],
      },
    });
  });

  it('fails closed with STATUS_READ_PARTIAL when a required status directory cannot be listed', async () => {
    const harness = createScriptableHarness({ listContentsThrows: ['Inbox'] });

    await expect(harness.runStatus()).resolves.toEqual({
      ok: false,
      code: 'STATUS_READ_PARTIAL',
      message: '일부 상태 파일을 확인할 수 없습니다. Windows 앱에서 진단해 주세요.',
    });
  });

  it('uses sorted filenames as the stable winner for equal actual receipt instants', async () => {
    const harness = createScriptableHarness({
      fileContents: {
        'Status/a.json': receipt({
          displayMessage: '강의 자료가 안전하게 대기 중입니다.',
          status: 'queued',
          updatedAt: '2026-09-03T00:00:00.000Z',
        }),
        'Status/z.json': receipt({
          displayMessage: '강의 자료를 처리하고 있습니다.',
          status: 'processing',
          updatedAt: '2026-09-03T09:00:00.000+09:00',
        }),
      },
    });

    await expect(harness.runStatus()).resolves.toMatchObject({
      ok: true,
      data: { processing: 0, queued: 1 },
    });
  });

  it('counts unsafe status names and read-time byte mismatches as unreadable without exposing them', async () => {
    const statusName = 'private\u0000receipt.json';
    const traversalName = '../escape.json';
    const overlongName = `${'a'.repeat(176)}.json`;
    const harness = createScriptableHarness({
      afterStatusRead: (_path, text) => {
        harness.fileManager.writeString('Status/race.json', `${text} `);
      },
      fileContents: {
        'Status/race.json': receipt(),
        'Status/utf8.json': receipt({ displayMessage: '강의 자료 정리가 완료되었습니다.' }),
      },
      fileSizes: { 'Status/utf8.json': receipt().length },
      listContentsValues: {
        Status: ['race.json', 'utf8.json', statusName, traversalName, overlongName],
      },
    });

    const result = await harness.runStatus();
    expect(result).toMatchObject({
      ok: true,
      data: { completed: 0, unreadableStatusFiles: 5 },
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(harness.fs.reads).not.toContain(`Status/${statusName}`);
    expect(harness.calls.joinedPaths).not.toContain(`/documents/Status/${traversalName}`);
    expect(harness.calls.joinedPaths).not.toContain(`/documents/Status/${overlongName}`);
  });

  it('counts exact stable bundles in both queue lanes without reading metadata or source content', async () => {
    const inboxJobId = '33333333-3333-4333-8333-333333333333';
    const courseJobId = '44444444-4444-4444-8444-444444444444';
    const normal = inboxBundle(inboxJobId);
    const course = pendingBundle(courseJobId, {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'private pending course text',
      professorName: 'private professor text',
    });
    const harness = createScriptableHarness({
      existingDirectories: [
        ...reservedDirectories,
        ...normal.existingDirectories,
        ...course.existingDirectories,
      ],
      fileContents: {
        [markerPath]: ownerMarker,
        ...normal.fileContents,
        ...course.fileContents,
      },
    });

    const result = await harness.runStatus();

    expect(result).toMatchObject({
      ok: true,
      data: { queued: 2, queueConflicts: 0 },
      message: expect.stringContaining('대기 2'),
    });
    expect(Object.isFrozen((result as { data: unknown }).data)).toBe(true);
    expect(harness.fs.reads.some((path) => /\/(?:manifest|request)\.json$/u.test(path))).toBe(
      false,
    );
    expect(harness.fs.reads.some((path) => path.includes('/source.'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('deduplicates a ready UUID in both lanes and reports one queue conflict', async () => {
    const normal = inboxBundle(jobId);
    const course = pendingBundle(jobId);
    const harness = createScriptableHarness({
      existingDirectories: [
        ...reservedDirectories,
        ...normal.existingDirectories,
        ...course.existingDirectories,
      ],
      fileContents: {
        [markerPath]: ownerMarker,
        ...normal.fileContents,
        ...course.fileContents,
      },
    });

    await expect(harness.runStatus()).resolves.toMatchObject({
      ok: true,
      data: { queued: 1, queueConflicts: 1 },
      message: expect.stringContaining('확인 필요 1'),
    });
  });

  it('lets a valid newest receipt override a ready CourseInbox bundle', async () => {
    const course = pendingBundle(jobId);
    const harness = createScriptableHarness({
      existingDirectories: [...reservedDirectories, ...course.existingDirectories],
      fileContents: {
        [markerPath]: ownerMarker,
        ...course.fileContents,
        'Status/completed.json': receipt(),
      },
    });

    await expect(harness.runStatus()).resolves.toMatchObject({
      ok: true,
      data: { completed: 1, queued: 0, queueConflicts: 0 },
    });
  });

  it('does not count incomplete or metadata-changing CourseInbox bundles', async () => {
    const changingId = '33333333-3333-4333-8333-333333333333';
    const incompleteId = '44444444-4444-4444-8444-444444444444';
    const changing = pendingBundle(changingId);
    let changed = false;
    const harness = createScriptableHarness({
      afterCourseReadyRead: () => {
        if (changed) return;
        changed = true;
        harness.fileManager.writeString(`CourseInbox/${changingId}/request.json`, '{}');
      },
      existingDirectories: [
        ...reservedDirectories,
        ...changing.existingDirectories,
        `CourseInbox/${incompleteId}`,
      ],
      fileContents: {
        [markerPath]: ownerMarker,
        ...changing.fileContents,
        [`CourseInbox/${incompleteId}/source.m4a`]: 'incomplete source',
        [`CourseInbox/${incompleteId}/ready`]: '',
      },
    });

    await expect(harness.runStatus()).resolves.toMatchObject({
      ok: true,
      data: { queued: 0, queueConflicts: 0 },
    });
    expect(changed).toBe(true);
    expect(harness.fs.reads.some((path) => path.endsWith('/request.json'))).toBe(false);
  });

  it.each(['Inbox', 'CourseInbox'] as const)(
    'fails closed when the %s queue lane cannot be listed',
    async (lane) => {
      const harness = createScriptableHarness({ listContentsThrows: [lane] });

      await expect(harness.runStatus()).resolves.toEqual({
        ok: false,
        code: 'STATUS_READ_PARTIAL',
        message: '일부 상태 파일을 확인할 수 없습니다. Windows 앱에서 진단해 주세요.',
      });
    },
  );
});

describe('StudyAssistant shared protocol contract', () => {
  it('uses no post-ES6 String trimEnd call in the distributable', () => {
    const distributable = readFileSync(
      new URL('../../../mobile/scriptable/StudyAssistant.js', import.meta.url),
      'utf8',
    );

    expect(distributable).not.toContain('.trimEnd(');
  });

  it('accepts only the exact course catalog shape', () => {
    expect(
      api.validateCourseCatalog({
        protocolVersion: 1,
        generatedAt: timestamp,
        courses: [{ id: courseId, name: '  운영체제  ' }],
      }),
    ).toEqual({
      protocolVersion: 1,
      generatedAt: timestamp,
      courses: [{ id: courseId, name: '운영체제' }],
    });
    expect(() =>
      api.validateCourseCatalog({
        protocolVersion: 2,
        generatedAt: timestamp,
        courses: [],
      }),
    ).toThrowError('INVALID_COURSE_CATALOG');
    expect(() =>
      api.validateCourseCatalog({
        protocolVersion: 1,
        generatedAt: '2026-09-03T14:30:15.123',
        courses: [],
      }),
    ).toThrowError('INVALID_COURSE_CATALOG');
  });

  it('accepts a course name of exactly 80 characters', () => {
    expect(
      api.validateCourseCatalog({
        protocolVersion: 1,
        generatedAt: timestamp,
        courses: [{ id: courseId, name: 'a'.repeat(80) }],
      }),
    ).toEqual({
      protocolVersion: 1,
      generatedAt: timestamp,
      courses: [{ id: courseId, name: 'a'.repeat(80) }],
    });
  });

  it('rejects a course name of exactly 81 characters', () => {
    expect(() =>
      api.validateCourseCatalog({
        protocolVersion: 1,
        generatedAt: timestamp,
        courses: [{ id: courseId, name: 'a'.repeat(81) }],
      }),
    ).toThrowError('INVALID_COURSE_CATALOG');
  });

  it('matches desktop general UUID validation for accepted and rejected course IDs', () => {
    const acceptedNonV4Id = '11111111-1111-1111-8111-111111111111';
    const rejectedId = '11111111-1111-9111-8111-111111111111';
    const catalog = {
      protocolVersion: 1,
      generatedAt: timestamp,
      courses: [{ id: acceptedNonV4Id, name: '분산 시스템' }],
    };

    expect(CourseCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(api.validateCourseCatalog(catalog)).toEqual(catalog);
    expect(
      CourseCatalogSchema.safeParse({
        ...catalog,
        courses: [{ id: rejectedId, name: '분산 시스템' }],
      }).success,
    ).toBe(false);
    expect(() =>
      api.validateCourseCatalog({
        ...catalog,
        courses: [{ id: rejectedId, name: '분산 시스템' }],
      }),
    ).toThrowError('INVALID_COURSE_CATALOG');
  });

  it('accepts the nil UUID exactly as the desktop catalog schema does', () => {
    const catalog = {
      protocolVersion: 1,
      generatedAt: timestamp,
      courses: [{ id: '00000000-0000-0000-0000-000000000000', name: '기초' }],
    };

    expect(CourseCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(api.validateCourseCatalog(catalog)).toEqual(catalog);
  });

  it('accepts the max UUID exactly as the desktop catalog schema does', () => {
    const catalog = {
      protocolVersion: 1,
      generatedAt: timestamp,
      courses: [{ id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', name: '심화' }],
    };

    expect(CourseCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(api.validateCourseCatalog(catalog)).toEqual(catalog);
  });

  it('rejects a non-nil version-0 UUID exactly as the desktop catalog schema does', () => {
    const catalog = {
      protocolVersion: 1,
      generatedAt: timestamp,
      courses: [{ id: '00000001-0000-0000-8000-000000000000', name: '오류' }],
    };

    expect(CourseCatalogSchema.safeParse(catalog).success).toBe(false);
    expect(() => api.validateCourseCatalog(catalog)).toThrowError('INVALID_COURSE_CATALOG');
  });

  it('rejects duplicate, overlong, and extra course catalog values', () => {
    expect(() =>
      api.validateCourseCatalog({
        protocolVersion: 1,
        generatedAt: timestamp,
        courses: [
          { id: courseId, name: 'a'.repeat(80) },
          { id: courseId, name: '다른 과목' },
        ],
      }),
    ).toThrowError('INVALID_COURSE_CATALOG');
    expect(() =>
      api.validateCourseCatalog({
        protocolVersion: 1,
        generatedAt: timestamp,
        courses: [{ id: courseId, name: 'a'.repeat(81) }],
        extra: true,
      }),
    ).toThrowError('INVALID_COURSE_CATALOG');
  });

  it('mirrors the exact immutable desktop course provisioning contract', () => {
    const input = { id: courseId, name: '  운영체제  ', professorName: '  김교수  ' };

    expect(CourseProvisioningInputSchema.safeParse(input).success).toBe(true);
    const parsed = api.validateCourseProvisioningInput(input);
    expect(parsed).toEqual({ id: courseId, name: '운영체제', professorName: '김교수' });
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const invalidInput of [
      { ...input, extra: true },
      { ...input, name: '' },
      { ...input, name: ' '.repeat(3) },
      { ...input, name: 'a'.repeat(81) },
      { ...input, name: 'line\nfeed' },
      { ...input, name: 'line\u2028separator' },
      { ...input, professorName: 'tab\tname' },
      { ...input, professorName: 'a'.repeat(81) },
      { ...input, id: 'not-a-uuid' },
    ]) {
      expect(CourseProvisioningInputSchema.safeParse(invalidInput).success).toBe(false);
      expect(() => api.validateCourseProvisioningInput(invalidInput)).toThrowError(
        'INVALID_COURSE',
      );
    }
  });

  it('mirrors the exact immutable desktop CourseInbox request contract', () => {
    const request = courseInboxRequest();

    expect(CourseInboxRequestSchema.safeParse(request).success).toBe(true);
    const parsed = api.validateCourseInboxRequest(request);
    expect(parsed).toEqual(request);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen((parsed as typeof request).course)).toBe(true);
    expect(Object.isFrozen((parsed as typeof request).source)).toBe(true);

    for (const invalidRequest of [
      { ...request, extra: true },
      { ...request, protocolVersion: 2 },
      { ...request, jobId: 'not-a-uuid' },
      { ...request, createdAt: '2026-09-03T14:30:15.123' },
      { ...request, course: { ...request.course, extra: true } },
      { ...request, source: { ...request.source, extra: true } },
      { ...request, source: { fileName: 'slides.pdf', mediaType: 'audio' } },
      { ...request, source: { fileName: 'CON.m4a', mediaType: 'audio' } },
      { ...request, source: { fileName: 'lecture.exe', mediaType: 'audio' } },
      { ...request, summaryMode: 'verbose' },
    ]) {
      expect(CourseInboxRequestSchema.safeParse(invalidRequest).success).toBe(false);
      expect(() => api.validateCourseInboxRequest(invalidRequest)).toThrowError(
        'INVALID_COURSE_INBOX_REQUEST',
      );
    }
  });

  it('accepts only closed status receipt variants and public messages', () => {
    expect(
      api.validateStatusReceipt({
        jobId,
        courseId,
        updatedAt: timestamp,
        status: 'failed',
        errorCode: 'SOURCE_TOO_LARGE',
        displayMessage: APP_ERROR_MESSAGES.SOURCE_TOO_LARGE,
      }),
    ).toEqual({
      jobId,
      courseId,
      updatedAt: timestamp,
      status: 'failed',
      errorCode: 'SOURCE_TOO_LARGE',
      displayMessage: APP_ERROR_MESSAGES.SOURCE_TOO_LARGE,
    });
    expect(() =>
      api.validateStatusReceipt({
        jobId,
        courseId,
        updatedAt: '2026-09-03T14:30:15.123',
        status: 'failed',
        errorCode: 'SOURCE_TOO_LARGE',
        displayMessage: APP_ERROR_MESSAGES.SOURCE_TOO_LARGE,
      }),
    ).toThrowError('INVALID_STATUS_RECEIPT');
    expect(() =>
      api.validateStatusReceipt({
        jobId,
        courseId,
        updatedAt: timestamp,
        status: 'completed',
        displayMessage: '강의 자료 정리가 완료되었습니다.',
        extra: true,
      }),
    ).toThrowError('INVALID_STATUS_RECEIPT');
  });

  it('rejects a failed receipt whose message belongs to a different public error code', () => {
    expect(() =>
      api.validateStatusReceipt({
        jobId,
        courseId,
        updatedAt: timestamp,
        status: 'failed',
        errorCode: 'SOURCE_TOO_LARGE',
        displayMessage: APP_ERROR_MESSAGES.INVALID_INPUT,
      }),
    ).toThrowError('INVALID_STATUS_RECEIPT');
  });

  it('rejects a failed receipt with a non-public message', () => {
    expect(() =>
      api.validateStatusReceipt({
        jobId,
        courseId,
        updatedAt: timestamp,
        status: 'failed',
        errorCode: 'SOURCE_TOO_LARGE',
        displayMessage: '원본 경로를 포함한 비공개 메시지',
      }),
    ).toThrowError('INVALID_STATUS_RECEIPT');
  });

  it('keeps the companion failed-receipt map exactly aligned with desktop errors', () => {
    expect(createScriptableHarness().assistant.failedReceiptMessages).toEqual(APP_ERROR_MESSAGES);
  });
});

describe('StudyAssistant source boundary contract', () => {
  it('maps each supported extension to a shared source media type', () => {
    const expected = {
      '.m4a': 'audio',
      '.mp3': 'audio',
      '.wav': 'audio',
      '.aac': 'audio',
      '.flac': 'audio',
      '.mp4': 'video',
      '.pdf': 'document',
      '.pptx': 'document',
      '.txt': 'document',
      '.md': 'document',
      '.png': 'image',
      '.jpg': 'image',
      '.jpeg': 'image',
      '.heic': 'image',
    } as const;
    expect(Object.keys(expected).sort()).toEqual([...SUPPORTED_EXTENSIONS].sort());
    expect([...new Set(Object.values(expected))].sort()).toEqual([...SOURCE_MEDIA_TYPES].sort());
    for (const [extension, mediaType] of Object.entries(expected)) {
      expect(api.mediaTypeForExtension(extension)).toBe(mediaType);
    }
    expect(api.mediaTypeForExtension('.exe')).toBeNull();
  });

  it('enforces the 4 GiB audio/video and 500 MiB document/image limits', () => {
    const assistant = createScriptableHarness().assistant;
    expect(assistant.validateSource({ fileName: 'lecture.m4a', sizeBytes: 4 * 1024 ** 3 })).toEqual(
      {
        fileName: 'lecture.m4a',
        mediaType: 'audio',
        sizeBytes: 4 * 1024 ** 3,
      },
    );
    expect(() =>
      assistant.validateSource({ fileName: 'lecture.m4a', sizeBytes: 4 * 1024 ** 3 + 1 }),
    ).toThrowError('SOURCE_TOO_LARGE');
    expect(
      assistant.validateSource({ fileName: 'slides.pdf', sizeBytes: 500 * 1024 ** 2 }),
    ).toEqual({
      fileName: 'slides.pdf',
      mediaType: 'document',
      sizeBytes: 500 * 1024 ** 2,
    });
    expect(() =>
      assistant.validateSource({ fileName: 'slides.pdf', sizeBytes: 500 * 1024 ** 2 + 1 }),
    ).toThrowError('SOURCE_TOO_LARGE');
  });

  it('rejects malformed source metadata with a public input code', () => {
    expect(() =>
      createScriptableHarness().assistant.validateSource({
        fileName: 7 as unknown as string,
        sizeBytes: 1,
      }),
    ).toThrowError('UNSUPPORTED_SOURCE');
  });

  it('uses a bounded Windows-safe display file name', () => {
    expect(api.safeDisplayFileName('1주차 강의.m4a', '.m4a', jobId)).toBe('1주차 강의.m4a');
    expect(api.safeDisplayFileName('CON.m4a', '.m4a', jobId)).toBe('강의자료-22222222.m4a');
    expect(api.safeDisplayFileName('lecture .m4a', '.m4a', jobId)).toBe('lecture .m4a');
    expect(api.safeDisplayFileName('lecture.m4a ', '.m4a', jobId)).toBe('강의자료-22222222.m4a');
    expect(api.safeDisplayFileName(`${'a'.repeat(177)}.m4a`, '.m4a', jobId)).toBe(
      '강의자료-22222222.m4a',
    );
    expect(api.safeDisplayFileName('unsafe?.m4a', '.m4a', jobId)).toBe('강의자료-22222222.m4a');
  });

  it('preserves a Windows-safe display file name of exactly 180 characters', () => {
    const fileName = `${'a'.repeat(176)}.m4a`;

    expect(fileName).toHaveLength(180);
    expect(api.safeDisplayFileName(fileName, '.m4a', jobId)).toBe(fileName);
  });

  it('returns immutable harness recording snapshots', () => {
    const harness = createScriptableHarness();

    expect(Object.isFrozen(harness.fs.operations)).toBe(true);
    expect(Object.isFrozen(harness.calls.shortcutOutputs)).toBe(true);
  });
});

describe('StudyAssistant course discovery and picker contract', () => {
  it('returns immutable Shortcut-native labels and a prototype-safe UUID mapping', async () => {
    const secondCourseId = '22222222-2222-4222-8222-222222222222';
    const reservedLabelId = '33333333-3333-4333-8333-333333333333';
    const prototypeLabelId = '44444444-4444-4444-8444-444444444444';
    const constructorLabelId = '55555555-5555-4555-8555-555555555555';
    const harness = createScriptableHarness({
      fileContents: {
        'Catalog/courses.json': catalog([
          { id: courseId, name: '자료구조' },
          { id: secondCourseId, name: '자료구조' },
          { id: reservedLabelId, name: '＋ 과목 추가' },
          { id: prototypeLabelId, name: '__proto__' },
          { id: constructorLabelId, name: 'constructor' },
        ]),
      },
    });

    const result = (await harness.run({
      fileURLs: [],
      shortcutParameter: { action: 'courses' },
    })) as {
      action: string;
      data: { labels: string[]; courseIdsByLabel: Record<string, string> };
      message: string;
      ok: boolean;
      protocolVersion: number;
    };

    expect(result).toMatchObject({
      action: 'courses',
      message: '과목을 선택해 주세요.',
      ok: true,
      protocolVersion: 1,
    });
    expect(result.data.labels.at(-1)).toBe('＋ 과목 추가');
    expect(new Set(result.data.labels).size).toBe(result.data.labels.length);
    expect(result.data.labels).toEqual(
      expect.arrayContaining([
        '자료구조',
        '자료구조 · 1',
        '＋ 과목 추가 · 1',
        '__proto__',
        'constructor',
      ]),
    );
    expect(Object.hasOwn(result.data.courseIdsByLabel, '__proto__')).toBe(true);
    expect(Object.hasOwn(result.data.courseIdsByLabel, 'constructor')).toBe(true);
    expect(Reflect.get(result.data.courseIdsByLabel, '__proto__')).toBe(prototypeLabelId);
    expect(result.data.courseIdsByLabel.constructor).toBe(constructorLabelId);
    expect(Object.values(result.data.courseIdsByLabel).sort()).toEqual(
      [courseId, secondCourseId, reservedLabelId, prototypeLabelId, constructorLabelId].sort(),
    );
    expect(Reflect.get(JSON.parse(JSON.stringify(result)).data.courseIdsByLabel, '__proto__')).toBe(
      prototypeLabelId,
    );
    expect(Object.isFrozen(result.data.labels)).toBe(true);
    expect(Object.isFrozen(result.data.courseIdsByLabel)).toBe(true);
    expect(harness.calls.courseChoices).toEqual([]);
    expect(harness.calls.coursePrompts).toEqual([]);
  });

  it('includes a stable pending course in the Shortcut-native course response', async () => {
    const pendingJobId = '33333333-3333-4333-8333-333333333333';
    const pendingCourseId = '44444444-4444-4444-8444-444444444444';
    const pending = pendingBundle(pendingJobId, {
      id: pendingCourseId,
      name: '오프라인 과목',
      professorName: '표시하지 않을 교수',
    });
    const harness = createScriptableHarness({
      existingDirectories: [...reservedDirectories, ...pending.existingDirectories],
      fileContents: { [markerPath]: ownerMarker, ...pending.fileContents },
    });

    const result = (await harness.run({
      fileURLs: [],
      shortcutParameter: { action: 'courses' },
    })) as { data: { labels: string[]; courseIdsByLabel: Record<string, string> } };

    expect(result.data).toEqual({
      labels: ['오프라인 과목 (생성 대기)', '＋ 과목 추가'],
      courseIdsByLabel: { '오프라인 과목 (생성 대기)': pendingCourseId },
    });
    expect(JSON.stringify(result)).not.toContain('표시하지 않을 교수');
  });

  it('treats a missing catalog and a valid empty catalog as empty immutable choices', async () => {
    for (const fileContents of [
      { '/private/tmp/lecture.m4a': 'audio bytes' },
      { '/private/tmp/lecture.m4a': 'audio bytes', 'Catalog/courses.json': catalog([]) },
    ]) {
      const harness = createScriptableHarness({ chooseCourseResult: -1, fileContents });

      await expect(
        harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
      ).resolves.toMatchObject({ ok: true, data: { cancelled: true } });
      expect(harness.calls.courseChoices).toEqual([['＋ 과목 추가']]);
      expect(Object.isFrozen(harness.calls.courseChoices[0])).toBe(true);
    }
  });

  it('keeps a present malformed, oversized, or changing catalog fail-closed', async () => {
    const malformed = createScriptableHarness({
      fileContents: { '/private/tmp/lecture.m4a': 'audio', 'Catalog/courses.json': '{bad' },
    });
    const oversized = createScriptableHarness({
      fileContents: { '/private/tmp/lecture.m4a': 'audio', 'Catalog/courses.json': catalog([]) },
      fileSizes: { 'Catalog/courses.json': 256 * 1024 + 1 },
    });
    const changing = createScriptableHarness({
      afterCatalogRead: () => changing.fileManager.writeString('Catalog/courses.json', '{}'),
      fileContents: { '/private/tmp/lecture.m4a': 'audio', 'Catalog/courses.json': catalog([]) },
    });
    const undecodable = createScriptableHarness({
      fileContents: { '/private/tmp/lecture.m4a': 'audio', 'Catalog/courses.json': catalog([]) },
      readStringThrows: ['Catalog/courses.json'],
    });

    for (const harness of [malformed, oversized, changing, undecodable]) {
      await expect(
        harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
      ).resolves.toMatchObject({ ok: false, code: 'CATALOG_INVALID' });
      expect(harness.calls.courseChoices).toEqual([]);
    }
  });

  it('discovers stable pending courses deterministically without professor labels or source reads', async () => {
    const firstJobId = '33333333-3333-4333-8333-333333333333';
    const secondJobId = '44444444-4444-4444-8444-444444444444';
    const first = pendingBundle(firstJobId, {
      id: '55555555-5555-4555-8555-555555555555',
      name: '자료구조',
      professorName: '비공개교수',
    });
    const second = pendingBundle(secondJobId, {
      id: '66666666-6666-4666-8666-666666666666',
      name: '알고리즘',
      professorName: '다른교수',
    });
    const harness = createScriptableHarness({
      chooseCourseResult: -1,
      existingDirectories: [
        ...reservedDirectories,
        ...first.existingDirectories,
        ...second.existingDirectories,
      ],
      fileContents: {
        [markerPath]: ownerMarker,
        '/private/tmp/lecture.m4a': 'audio',
        ...first.fileContents,
        ...second.fileContents,
      },
    });

    await harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null });

    expect(harness.calls.courseChoices).toEqual([
      ['알고리즘 (생성 대기)', '자료구조 (생성 대기)', '＋ 과목 추가'],
    ]);
    expect(JSON.stringify(harness.calls.courseChoices)).not.toContain('교수');
    expect(harness.fs.reads.filter((path) => path.includes('/source.'))).toEqual([]);
  });

  it('uses canonical definitions over pending conflicts and deduplicates identical pending definitions', async () => {
    const canonicalId = courseId;
    const duplicateId = '77777777-7777-4777-8777-777777777777';
    const conflictId = '88888888-8888-4888-8888-888888888888';
    const definitions = [
      ['33333333-3333-4333-8333-333333333333', canonicalId, '대기 이름', 'A'],
      ['44444444-4444-4444-8444-444444444444', canonicalId, '다른 대기 이름', 'B'],
      ['55555555-5555-4555-8555-555555555555', duplicateId, '동일 과목', 'C'],
      ['66666666-6666-4666-8666-666666666666', duplicateId, '동일 과목', 'C'],
      ['99999999-9999-4999-8999-999999999999', conflictId, '충돌 A', 'D'],
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', conflictId, '충돌 B', 'D'],
    ] as const;
    const bundles = definitions.map(([pendingJobId, id, name, professorName]) =>
      pendingBundle(pendingJobId, { id, name, professorName }),
    );
    const harness = createScriptableHarness({
      chooseCourseResult: -1,
      existingDirectories: [
        ...reservedDirectories,
        ...bundles.flatMap((bundle) => bundle.existingDirectories),
      ],
      fileContents: {
        [markerPath]: ownerMarker,
        '/private/tmp/lecture.m4a': 'audio',
        'Catalog/courses.json': catalog([{ id: canonicalId, name: '정식 이름' }]),
        ...Object.assign({}, ...bundles.map((bundle) => bundle.fileContents)),
      },
    });

    await harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null });

    expect(harness.calls.courseChoices).toEqual([
      ['동일 과목 (생성 대기)', '정식 이름', '＋ 과목 추가'],
    ]);
  });

  it('skips partial, changed, or rejected pending bundles and downloads only small metadata', async () => {
    const validJobId = '33333333-3333-4333-8333-333333333333';
    const changedJobId = '44444444-4444-4444-8444-444444444444';
    const rejectedJobId = '55555555-5555-4555-8555-555555555555';
    const valid = pendingBundle(validJobId, {
      id: '66666666-6666-4666-8666-666666666666',
      name: '원격 과목',
      professorName: '',
    });
    const changed = pendingBundle(changedJobId, {
      id: '77777777-7777-4777-8777-777777777777',
      name: '변경 과목',
      professorName: '',
    });
    const rejected = pendingBundle(rejectedJobId, {
      id: '88888888-8888-4888-8888-888888888888',
      name: '거절 과목',
      professorName: '',
    });
    const validRequestPath = `CourseInbox/${validJobId}/request.json`;
    const validReadyPath = `CourseInbox/${validJobId}/ready`;
    const changedRequestPath = `CourseInbox/${changedJobId}/request.json`;
    const rejectedReceiptPath = `Rejected/${rejectedJobId}.json`;
    const harness = createScriptableHarness({
      afterCourseRequestRead: (path) => {
        if (path === changedRequestPath) harness.fileManager.writeString(path, '{}');
      },
      chooseCourseResult: -1,
      existingDirectories: [
        ...reservedDirectories,
        ...valid.existingDirectories,
        ...changed.existingDirectories,
        ...rejected.existingDirectories,
        'CourseInbox/99999999-9999-4999-8999-999999999999',
      ],
      fileContents: {
        [markerPath]: ownerMarker,
        '/private/tmp/lecture.m4a': 'audio',
        ...valid.fileContents,
        ...changed.fileContents,
        ...rejected.fileContents,
        [rejectedReceiptPath]: JSON.stringify({
          jobId: rejectedJobId,
          status: 'failed',
          displayMessage: APP_ERROR_MESSAGES.INVALID_QUEUE_ITEM,
          updatedAt: timestamp,
          errorCode: 'INVALID_QUEUE_ITEM',
        }),
      },
      initiallyNotDownloaded: [validRequestPath, validReadyPath, rejectedReceiptPath],
    });
    await harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null });

    expect(harness.calls.courseChoices).toEqual([['원격 과목 (생성 대기)', '＋ 과목 추가']]);
    expect(harness.calls.downloads).toEqual(
      expect.arrayContaining([validRequestPath, validReadyPath, rejectedReceiptPath]),
    );
    expect(harness.calls.downloads.some((path) => path.includes('/source.'))).toBe(false);
    expect(harness.fs.reads.some((path) => path.includes('/source.'))).toBe(false);
  });

  it('skips a pending course whose request changes after its first stable read', async () => {
    const pendingJobId = '33333333-3333-4333-8333-333333333333';
    const pendingCourseId = '44444444-4444-4444-8444-444444444444';
    const bundle = pendingBundle(pendingJobId, {
      id: pendingCourseId,
      name: '원본A',
      professorName: '',
    });
    let requestMutated = false;
    const harness = createScriptableHarness({
      afterCourseReadyRead: () => {
        if (requestMutated) return;
        requestMutated = true;
        harness.fileManager.writeString(
          `CourseInbox/${pendingJobId}/request.json`,
          JSON.stringify(
            courseInboxRequest(pendingJobId, {
              id: pendingCourseId,
              name: '변조B',
              professorName: '',
            }),
          ),
        );
      },
      chooseCourseResult: -1,
      existingDirectories: [...reservedDirectories, ...bundle.existingDirectories],
      fileContents: {
        [markerPath]: ownerMarker,
        '/private/tmp/lecture.m4a': 'audio',
        ...bundle.fileContents,
      },
    });

    await harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null });

    expect(requestMutated).toBe(true);
    expect(harness.calls.courseChoices).toEqual([['＋ 과목 추가']]);
    expect(harness.fs.reads.some((path) => path.includes('/source.'))).toBe(false);
  });

  it('skips a pending course when a valid matching rejection appears during ready observation', async () => {
    const pendingJobId = '33333333-3333-4333-8333-333333333333';
    const bundle = pendingBundle(pendingJobId, {
      id: '44444444-4444-4444-8444-444444444444',
      name: '곧 거절될 과목',
      professorName: '',
    });
    let rejectionWritten = false;
    const harness = createScriptableHarness({
      afterCourseReadyRead: () => {
        if (rejectionWritten) return;
        rejectionWritten = true;
        harness.fileManager.writeString(
          `Rejected/${pendingJobId}.json`,
          JSON.stringify({
            jobId: pendingJobId,
            status: 'failed',
            displayMessage: APP_ERROR_MESSAGES.INVALID_QUEUE_ITEM,
            updatedAt: timestamp,
            errorCode: 'INVALID_QUEUE_ITEM',
          }),
        );
      },
      chooseCourseResult: -1,
      existingDirectories: [...reservedDirectories, ...bundle.existingDirectories],
      fileContents: {
        [markerPath]: ownerMarker,
        '/private/tmp/lecture.m4a': 'audio',
        ...bundle.fileContents,
      },
    });

    await harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null });

    expect(rejectionWritten).toBe(true);
    expect(harness.calls.courseChoices).toEqual([['＋ 과목 추가']]);
    expect(harness.fs.reads.some((path) => path.includes('/source.'))).toBe(false);
  });

  it('skips over-limit, ambiguous, changing-ready, mismatched, and wrong-kind pending entries', async () => {
    const oversizedId = '33333333-3333-4333-8333-333333333333';
    const ambiguousId = '44444444-4444-4444-8444-444444444444';
    const changingReadyId = '55555555-5555-4555-8555-555555555555';
    const mismatchedId = '66666666-6666-4666-8666-666666666666';
    const wrongKindId = '77777777-7777-4777-8777-777777777777';
    const bundles = [oversizedId, ambiguousId, changingReadyId, wrongKindId].map((id) =>
      pendingBundle(id, { id, name: `pending-${id.slice(0, 4)}`, professorName: '' }),
    );
    const mismatched = pendingBundle(mismatchedId, {
      id: mismatchedId,
      name: 'mismatched',
      professorName: '',
    });
    const harness = createScriptableHarness({
      afterCourseReadyRead: (path) => {
        if (path === `CourseInbox/${changingReadyId}/ready`) {
          harness.fileManager.writeString(path, 'changed');
        }
      },
      chooseCourseResult: -1,
      existingDirectories: [
        ...reservedDirectories,
        ...bundles.flatMap((bundle) => bundle.existingDirectories),
        ...mismatched.existingDirectories,
      ],
      fileContents: {
        [markerPath]: ownerMarker,
        '/private/tmp/lecture.m4a': 'audio',
        ...Object.assign({}, ...bundles.map((bundle) => bundle.fileContents)),
        ...mismatched.fileContents,
        [`CourseInbox/${ambiguousId}/extra.txt`]: 'extra',
        [`CourseInbox/${mismatchedId}/request.json`]: JSON.stringify(
          courseInboxRequest('88888888-8888-4888-8888-888888888888', {
            id: mismatchedId,
            name: 'mismatched',
            professorName: '',
          }),
        ),
      },
      fileSizes: { [`CourseInbox/${oversizedId}/request.json`]: 64 * 1024 + 1 },
    });
    harness.fileManager.createDirectory(`CourseInbox/${wrongKindId}/source.m4a`);

    await harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null });

    expect(harness.calls.courseChoices).toEqual([['＋ 과목 추가']]);
    expect(harness.fs.reads.some((path) => path.includes('/source.'))).toBe(false);
    expect(JSON.stringify(await harness.runStatus())).not.toContain('pending-');
  });

  it('does not read an oversized rejection receipt or let it hide a stable pending course', async () => {
    const pendingJobId = '33333333-3333-4333-8333-333333333333';
    const bundle = pendingBundle(pendingJobId, {
      id: '44444444-4444-4444-8444-444444444444',
      name: '보존 과목',
      professorName: '',
    });
    const receiptPath = `Rejected/${pendingJobId}.json`;
    const harness = createScriptableHarness({
      chooseCourseResult: -1,
      existingDirectories: [...reservedDirectories, ...bundle.existingDirectories],
      fileContents: {
        [markerPath]: ownerMarker,
        '/private/tmp/lecture.m4a': 'audio',
        ...bundle.fileContents,
        [receiptPath]: '{}',
      },
      fileSizes: { [receiptPath]: 64 * 1024 + 1 },
      initiallyNotDownloaded: [receiptPath],
    });

    await harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null });

    expect(harness.calls.courseChoices).toEqual([['보존 과목 (생성 대기)', '＋ 과목 추가']]);
    expect(harness.fs.reads).not.toContain(receiptPath);
    expect(harness.calls.downloads).not.toContain(receiptPath);
  });

  it('fails safely when the CourseInbox scan exceeds its entry bound', async () => {
    const harness = createScriptableHarness({
      fileContents: { '/private/tmp/lecture.m4a': 'audio' },
      listContentsValues: {
        CourseInbox: Array.from({ length: 1001 }, (_, index) => `entry-${index}`),
      },
    });

    const result = await harness.run({
      fileURLs: ['file:///private/tmp/lecture.m4a'],
      shortcutParameter: null,
    });
    expect(result).toMatchObject({ ok: false, code: 'CATALOG_INVALID' });
    expect(JSON.stringify(result)).not.toContain('entry-');
  });

  it('returns frozen catalog, pending, and collision-free create selections', async () => {
    const choices = [
      { kind: 'catalog' as const, course: { id: courseId, name: '정식' }, label: '정식' },
      {
        kind: 'pending' as const,
        course: { id: jobId, name: '대기', professorName: '' },
        label: '대기 (생성 대기)',
      },
    ];
    await expect(api.selectCourse({ chooseCourse: () => 0 }, choices)).resolves.toEqual({
      kind: 'catalog',
      course: { id: courseId, name: '정식' },
    });
    await expect(api.selectCourse({ chooseCourse: () => 1 }, choices)).resolves.toEqual({
      kind: 'pending',
      course: { id: jobId, name: '대기', professorName: '' },
    });
    const created = await api.selectCourse(
      {
        chooseCourse: () => 2,
        promptCourse: () => ({ name: '  새 과목  ', professorName: '  교수  ' }),
        uuid: (() => {
          const values = [courseId, '33333333-3333-4333-8333-333333333333'];
          return () => values.shift();
        })(),
      },
      choices,
      [courseId, jobId],
    );
    expect(created).toEqual({
      kind: 'create',
      course: {
        id: '33333333-3333-4333-8333-333333333333',
        name: '새 과목',
        professorName: '교수',
      },
    });
    expect(Object.isFrozen(created)).toBe(true);
  });

  it('returns cancellation for picker or form cancellation and rejects invalid form fields safely', async () => {
    await expect(api.selectCourse({ chooseCourse: () => -1 }, [])).resolves.toBeNull();
    await expect(
      api.selectCourse({ chooseCourse: () => 0, promptCourse: () => null }, []),
    ).resolves.toBeNull();
    await expect(
      api.selectCourse(
        { chooseCourse: () => 0, promptCourse: () => ({ name: 'bad\nname', professorName: '' }) },
        [],
      ),
    ).rejects.toThrowError('INVALID_COURSE');
  });

  it('writes a new course and lecture as an exact self-contained CourseInbox transaction', async () => {
    const newCourseId = '33333333-3333-4333-8333-333333333333';
    const harness = createScriptableHarness({
      chooseCourseResult: 0,
      fileContents: { '/private/tmp/lecture.m4a': 'audio bytes' },
      fixedClock: timestamp,
      promptCourseResult: { name: '운영체제', professorName: '' },
      uuidValues: [newCourseId, jobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId } });
    expect(harness.fs.operations.slice(-4)).toEqual([
      `mkdir:CourseInbox/.upload-${jobId}/sources`,
      'copy:0-44444444-4444-4444-8444-444444444444.m4a',
      'write:manifest.json',
      `move:CourseInbox/.upload-${jobId}->CourseInbox/${jobId}`,
    ]);
    const manifest = SourceBundleManifestV2Schema.parse(
      harness.fs.readJson(`CourseInbox/${jobId}/manifest.json`),
    );
    expect(manifest).toEqual({
      protocolVersion: 2,
      jobId,
      courseId: newCourseId,
      createdAt: timestamp,
      courseProvisioning: { id: newCourseId, name: '운영체제', professorName: '' },
      sources: [
        {
          fileName: 'lecture.m4a',
          id: '44444444-4444-4444-8444-444444444444',
          mediaType: 'audio',
          sizeBytes: 11,
        },
      ],
      summaryMode: 'standard',
    });
    expect(JSON.stringify(manifest)).not.toContain('/private/tmp');
    expect(
      harness.fs
        .snapshot()
        .filter((entry) => entry.path.startsWith(`CourseInbox/${jobId}/`))
        .map((entry) => entry.path),
    ).toEqual([
      `CourseInbox/${jobId}/manifest.json`,
      `CourseInbox/${jobId}/sources`,
      `CourseInbox/${jobId}/sources/0-44444444-4444-4444-8444-444444444444.m4a`,
    ]);
  });

  it('queues an existing course selected by UUID without opening Scriptable course UI', async () => {
    const harness = createScriptableHarness({
      fileContents: {
        '/private/tmp/native-menu.m4a': 'audio bytes',
        'Catalog/courses.json': catalog(),
      },
      uuidValues: [jobId],
    });

    await expect(
      harness.run({
        fileURLs: ['file:///private/tmp/native-menu.m4a'],
        shortcutParameter: { action: 'enqueue', courseId },
      }),
    ).resolves.toMatchObject({ ok: true, action: 'enqueue', data: { jobId } });
    expect(
      SourceBundleManifestV2Schema.parse(harness.fs.readJson(`Inbox/${jobId}/manifest.json`)),
    ).toMatchObject({ courseId, jobId, protocolVersion: 2 });
    expect(harness.calls.courseChoices).toEqual([]);
    expect(harness.calls.coursePrompts).toEqual([]);
  });

  it('queues a stable pending course selected by UUID without creating another course', async () => {
    const pendingJobId = '33333333-3333-4333-8333-333333333333';
    const pendingCourseId = '44444444-4444-4444-8444-444444444444';
    const nextJobId = '55555555-5555-4555-8555-555555555555';
    const pending = pendingBundle(pendingJobId, {
      id: pendingCourseId,
      name: '대기 과목',
      professorName: '김교수',
    });
    const harness = createScriptableHarness({
      existingDirectories: [...reservedDirectories, ...pending.existingDirectories],
      fileContents: {
        [markerPath]: ownerMarker,
        '/private/tmp/pending.m4a': 'next lecture',
        ...pending.fileContents,
      },
      uuidValues: [nextJobId],
    });

    await expect(
      harness.run({
        fileURLs: ['file:///private/tmp/pending.m4a'],
        shortcutParameter: { action: 'enqueue', courseId: pendingCourseId },
      }),
    ).resolves.toMatchObject({ ok: true, data: { jobId: nextJobId } });
    expect(
      SourceBundleManifestV2Schema.parse(
        harness.fs.readJson(`CourseInbox/${nextJobId}/manifest.json`),
      ).courseProvisioning,
    ).toEqual({ id: pendingCourseId, name: '대기 과목', professorName: '김교수' });
    expect(harness.calls.courseChoices).toEqual([]);
    expect(harness.calls.coursePrompts).toEqual([]);
  });

  it('fails closed when a Shortcut-selected course UUID is stale or tampered', async () => {
    const harness = createScriptableHarness({
      fileContents: { '/private/tmp/stale.m4a': 'audio bytes' },
    });

    await expect(
      harness.run({
        fileURLs: ['file:///private/tmp/stale.m4a'],
        shortcutParameter: { action: 'enqueue', courseId },
      }),
    ).resolves.toEqual({
      code: 'COURSE_SELECTION_STALE',
      message: '과목 목록이 변경되었습니다. 다시 선택해 주세요.',
      ok: false,
    });
    expect(harness.fs.snapshot().some((entry) => entry.path.startsWith('Inbox/'))).toBe(false);
    expect(harness.fs.snapshot().some((entry) => entry.path.startsWith('CourseInbox/'))).toBe(
      false,
    );
  });

  it('queues a Shortcut-native new-course request without opening a Scriptable form', async () => {
    const newCourseId = '33333333-3333-4333-8333-333333333333';
    const nextJobId = '44444444-4444-4444-8444-444444444444';
    const harness = createScriptableHarness({
      fileContents: { '/private/tmp/new-course.m4a': 'audio bytes' },
      uuidValues: [newCourseId, nextJobId],
    });

    await expect(
      harness.run({
        fileURLs: ['file:///private/tmp/new-course.m4a'],
        shortcutParameter: {
          action: 'enqueue',
          newCourseName: '  자료구조  ',
          professorName: '  김교수  ',
        },
      }),
    ).resolves.toMatchObject({ ok: true, data: { jobId: nextJobId } });
    expect(
      SourceBundleManifestV2Schema.parse(
        harness.fs.readJson(`CourseInbox/${nextJobId}/manifest.json`),
      ).courseProvisioning,
    ).toEqual({ id: newCourseId, name: '자료구조', professorName: '김교수' });
    expect(harness.calls.courseChoices).toEqual([]);
    expect(harness.calls.coursePrompts).toEqual([]);
  });

  it('queues a second pending-course lecture with the same course UUID and a new job UUID', async () => {
    const pendingJobId = '33333333-3333-4333-8333-333333333333';
    const secondJobId = '44444444-4444-4444-8444-444444444444';
    const pendingCourseId = '55555555-5555-4555-8555-555555555555';
    const pending = pendingBundle(pendingJobId, {
      id: pendingCourseId,
      name: '대기 과목',
      professorName: '김교수',
    });
    const harness = createScriptableHarness({
      chooseCourseResult: 0,
      existingDirectories: [...reservedDirectories, ...pending.existingDirectories],
      fileContents: {
        [markerPath]: ownerMarker,
        '/private/tmp/second.m4a': 'second lecture',
        ...pending.fileContents,
      },
      uuidValues: [secondJobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/second.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId: secondJobId } });
    expect(
      SourceBundleManifestV2Schema.parse(
        harness.fs.readJson(`CourseInbox/${secondJobId}/manifest.json`),
      ).courseProvisioning,
    ).toEqual({ id: pendingCourseId, name: '대기 과목', professorName: '김교수' });
  });

  it('supports two offline sends for one newly-created course as independent bundles', async () => {
    const newCourseId = '33333333-3333-4333-8333-333333333333';
    const firstJobId = '44444444-4444-4444-8444-444444444444';
    const secondJobId = '55555555-5555-4555-8555-555555555555';
    const harness = createScriptableHarness({
      chooseCourseResult: 0,
      fileContents: {
        '/private/tmp/first.m4a': 'first lecture',
        '/private/tmp/second.m4a': 'second lecture',
      },
      promptCourseResult: { name: '분산 시스템', professorName: '' },
      uuidValues: [
        newCourseId,
        firstJobId,
        '66666666-6666-4666-8666-666666666666',
        secondJobId,
        '77777777-7777-4777-8777-777777777777',
      ],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/first.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId: firstJobId } });
    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/second.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId: secondJobId } });

    const manifests = [firstJobId, secondJobId].map((id) =>
      SourceBundleManifestV2Schema.parse(harness.fs.readJson(`CourseInbox/${id}/manifest.json`)),
    );
    expect(manifests.map((manifest) => manifest.jobId)).toEqual([firstJobId, secondJobId]);
    expect(manifests.map((manifest) => manifest.courseProvisioning?.id)).toEqual([
      newCourseId,
      newCourseId,
    ]);
    expect(harness.calls.coursePrompts).toEqual([{}]);
  });

  it('rejects a new course UUID that becomes pending before its job is leased', async () => {
    const newCourseId = '33333333-3333-4333-8333-333333333333';
    const competingJobId = '44444444-4444-4444-8444-444444444444';
    const unusedJobId = '55555555-5555-4555-8555-555555555555';
    const harness = createScriptableHarness({
      afterUuid: (value, index) => {
        if (index !== 0) return;
        harness.fileManager.createDirectory(`CourseInbox/${competingJobId}`);
        harness.fileManager.writeString(
          `CourseInbox/${competingJobId}/request.json`,
          JSON.stringify(
            courseInboxRequest(competingJobId, {
              id: value,
              name: '다른 기기 과목',
              professorName: '',
            }),
          ),
        );
        harness.fileManager.writeString(
          `CourseInbox/${competingJobId}/source.m4a`,
          'other device source',
        );
        harness.fileManager.writeString(`CourseInbox/${competingJobId}/ready`, '');
      },
      chooseCourseResult: 0,
      fileContents: { '/private/tmp/lecture.m4a': 'audio bytes' },
      promptCourseResult: { name: '내 과목', professorName: '' },
      uuidValues: [newCourseId, unusedJobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: false, code: 'CATALOG_INVALID' });
    expect(
      harness.fs.snapshot().some((entry) => entry.path.includes(`.reservation-${unusedJobId}`)),
    ).toBe(false);
    expect(harness.fs.readText(`CourseInbox/${competingJobId}/source.m4a`)).toBe(
      'other device source',
    );
  });

  it('returns only the generic public course error for invalid form fields', async () => {
    const privateValue = 'private/path\ncourse';
    const harness = createScriptableHarness({
      chooseCourseResult: 0,
      fileContents: { '/private/tmp/lecture.m4a': 'audio' },
      promptCourseResult: { name: privateValue, professorName: '' },
    });

    const result = await harness.run({
      fileURLs: ['file:///private/tmp/lecture.m4a'],
      shortcutParameter: null,
    });

    expect(result).toEqual({
      ok: false,
      code: 'INVALID_COURSE',
      message: APP_ERROR_MESSAGES.INVALID_COURSE,
    });
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(harness.fs.snapshot().some((entry) => entry.path.startsWith('Inbox/'))).toBe(false);
  });
});

describe('StudyAssistant enqueue transaction contract', () => {
  it('opens the picker for one course and commits a canonical queue job last', async () => {
    const harness = createScriptableHarness({
      fileContents: {
        '/private/tmp/lecture.m4a': 'audio bytes',
        'Catalog/courses.json': catalog(),
      },
      fixedClock: timestamp,
      uuidValues: [jobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toEqual({
      protocolVersion: 1,
      ok: true,
      action: 'enqueue',
      message: '강의 자료가 안전하게 대기 중입니다.',
      data: { jobId },
    });
    expect(harness.calls.courseChoices).toEqual([['운영체제', '＋ 과목 추가']]);
    expect(harness.fs.operations.slice(-4)).toEqual([
      `mkdir:Inbox/.upload-${jobId}/sources`,
      'copy:0-44444444-4444-4444-8444-444444444444.m4a',
      'write:manifest.json',
      `move:Inbox/.upload-${jobId}->Inbox/${jobId}`,
    ]);
    const bundle = SourceBundleManifestV2Schema.parse(
      harness.fs.readJson(`Inbox/${jobId}/manifest.json`),
    );
    expect(bundle).toMatchObject({
      protocolVersion: 2,
      jobId,
      courseId,
      sources: [{ fileName: 'lecture.m4a', mediaType: 'audio', sizeBytes: 11 }],
      summaryMode: 'standard',
    });
    expect(JSON.stringify(bundle)).not.toContain('/private/tmp');
  });

  it('shows course names exactly once and treats cancellation as a successful no-job result', async () => {
    const secondCourseId = '33333333-3333-4333-8333-333333333333';
    const harness = createScriptableHarness({
      chooseCourseResult: -1,
      fileContents: {
        '/private/tmp/lecture.m4a': 'audio bytes',
        'Catalog/courses.json': catalog([
          { id: courseId, name: '운영체제' },
          { id: secondCourseId, name: '데이터베이스' },
        ]),
      },
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, action: 'enqueue', data: { cancelled: true } });
    expect(harness.calls.courseChoices).toEqual([['데이터베이스', '운영체제', '＋ 과목 추가']]);
    expect(harness.fs.snapshot().filter((entry) => entry.path.startsWith('Inbox/'))).toEqual([]);
    expect(harness.fs.snapshot().some((entry) => entry.path.includes('/.reservation-'))).toBe(
      false,
    );
  });

  it('downloads an iCloud-only source before copying while leaving the Shortcut input unchanged', async () => {
    const harness = createScriptableHarness({
      fileContents: {
        '/private/tmp/lecture.m4a': 'original downloaded bytes',
        'Catalog/courses.json': catalog(),
      },
      fixedClock: timestamp,
      initiallyNotDownloaded: ['/private/tmp/lecture.m4a'],
      uuidValues: [jobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId } });
    expect(harness.calls.downloads).toEqual(['private/tmp/lecture.m4a']);
    expect(harness.fs.readText('/private/tmp/lecture.m4a')).toBe('original downloaded bytes');
  });

  it('rejects a course selection invalidated while the chooser awaits without creating a job', async () => {
    const harness = createScriptableHarness({
      chooseCourse: async () => {
        harness.fileManager.writeString('Catalog/courses.json', catalog([]));
        return 0;
      },
      fileContents: {
        '/private/tmp/lecture.m4a': 'audio bytes',
        'Catalog/courses.json': catalog([
          { id: courseId, name: '운영체제' },
          { id: '33333333-3333-4333-8333-333333333333', name: '데이터베이스' },
        ]),
      },
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: false, code: 'CATALOG_INVALID' });
    expect(harness.fs.snapshot().filter((entry) => entry.path.startsWith('Inbox/'))).toEqual([]);
  });

  it('revalidates a source changed to a directory while the course chooser awaits', async () => {
    const harness = createScriptableHarness({
      chooseCourse: async () => {
        harness.fileManager.createDirectory('/private/tmp/lecture.m4a');
        return 0;
      },
      fileContents: {
        '/private/tmp/lecture.m4a': 'original bytes',
        'Catalog/courses.json': catalog([
          { id: courseId, name: '운영체제' },
          { id: '33333333-3333-4333-8333-333333333333', name: '데이터베이스' },
        ]),
      },
      uuidValues: [jobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: false, code: 'UNSUPPORTED_SOURCE' });
    expect(harness.fs.snapshot().some((entry) => entry.path.startsWith(`Inbox/${jobId}`))).toBe(
      false,
    );
  });

  it('rejects a copied source whose size changes during copy and cleans only its leased job', async () => {
    const unrelatedJobId = '33333333-3333-4333-8333-333333333333';
    const harness = createScriptableHarness({
      afterSourceCopy: (_sourcePath, copiedPath) => {
        harness.fileManager.writeString(copiedPath, 'changed copied source bytes');
      },
      fileContents: {
        '/private/tmp/lecture.m4a': 'original source bytes',
        'Catalog/courses.json': catalog(),
      },
      uuidValues: [jobId],
    });
    await harness.runStatus();
    harness.fileManager.createDirectory(`Inbox/${unrelatedJobId}`);

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: false, code: 'QUEUE_WRITE_FAILED' });
    expect(harness.fs.readText('/private/tmp/lecture.m4a')).toBe('original source bytes');
    expect(harness.fs.snapshot()).toContainEqual({
      contents: undefined,
      kind: 'directory',
      path: `Inbox/${unrelatedJobId}`,
    });
    expect(harness.fs.snapshot().some((entry) => entry.path.startsWith(`Inbox/${jobId}`))).toBe(
      false,
    );
  });

  it('uses a copied owner-marker reservation to preserve a job that appears after candidate observation', async () => {
    const nextJobId = '33333333-3333-4333-8333-333333333333';
    const harness = createScriptableHarness({
      afterLeaseCopy: () => {
        harness.fileManager.createDirectory(`Inbox/${jobId}`);
        harness.fileManager.writeString(`Inbox/${jobId}/other-owner.txt`, 'other owner bytes');
      },
      fileContents: {
        '/private/tmp/lecture.m4a': 'audio bytes',
        'Catalog/courses.json': catalog(),
      },
      fixedClock: timestamp,
      uuidValues: [jobId, nextJobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId: nextJobId } });
    expect(harness.fs.readText(`Inbox/${jobId}/other-owner.txt`)).toBe('other owner bytes');
    expect(harness.fs.snapshot()).toContainEqual({
      contents: expect.any(String),
      kind: 'file',
      path: `Rejected/.reservation-${jobId}`,
    });
  });

  it('accepts an exact published bundle after the directory move reports a late error', async () => {
    const harness = createScriptableHarness({
      fileContents: {
        '/private/tmp/lecture.m4a': 'audio bytes',
        'Catalog/courses.json': catalog(),
      },
      fixedClock: timestamp,
      moveCreatesThenThrows: true,
      uuidValues: [jobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId } });
    expect(
      harness.fs.snapshot().some((entry) => entry.path === `Inbox/${jobId}/manifest.json`),
    ).toBe(true);
    expect(harness.fs.snapshot().some((entry) => entry.path.endsWith('/ready'))).toBe(false);
  });

  it('fails a catalog whose observed size changes after its read without creating a job', async () => {
    const harness = createScriptableHarness({
      afterCatalogRead: () => {
        harness.fileManager.writeString('Catalog/courses.json', `${catalog()} `);
      },
      fileContents: {
        '/private/tmp/lecture.m4a': 'audio bytes',
        'Catalog/courses.json': catalog(),
      },
      uuidValues: [jobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: false, code: 'CATALOG_INVALID' });
    expect(harness.fs.snapshot().some((entry) => entry.path.startsWith(`Inbox/${jobId}`))).toBe(
      false,
    );
  });

  it('preserves a potentially committed job when publication observation is unavailable', async () => {
    const harness = createScriptableHarness({
      fileContents: {
        '/private/tmp/lecture.m4a': 'audio bytes',
        'Catalog/courses.json': catalog(),
      },
      fileSizeThrows: [`Inbox/${jobId}/sources/0-44444444-4444-4444-8444-444444444444.m4a`],
      fixedClock: timestamp,
      moveCreatesThenThrows: true,
      uuidValues: [jobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: false, code: 'QUEUE_WRITE_FAILED' });
    expect(
      harness.fs.snapshot().some((entry) => entry.path === `Inbox/${jobId}/manifest.json`),
    ).toBe(true);
  });

  it.each([
    ['.m4a', 'audio'],
    ['.mp3', 'audio'],
    ['.wav', 'audio'],
    ['.aac', 'audio'],
    ['.flac', 'audio'],
    ['.mp4', 'video'],
    ['.pdf', 'document'],
    ['.pptx', 'document'],
    ['.txt', 'document'],
    ['.md', 'document'],
    ['.png', 'image'],
    ['.jpg', 'image'],
    ['.jpeg', 'image'],
    ['.heic', 'image'],
  ] as const)('enqueues supported %s sources with media type %s', async (extension, mediaType) => {
    const harness = createScriptableHarness({
      fileContents: {
        [`/private/tmp/lecture${extension}`]: 'source bytes',
        'Catalog/courses.json': catalog(),
      },
      fixedClock: timestamp,
      uuidValues: [jobId],
    });

    await expect(
      harness.run({
        fileURLs: [`file:///private/tmp/lecture${extension}`],
        shortcutParameter: null,
      }),
    ).resolves.toMatchObject({ ok: true, data: { jobId } });
    expect(
      SourceBundleManifestV2Schema.parse(harness.fs.readJson(`Inbox/${jobId}/manifest.json`)),
    ).toMatchObject({
      sources: [{ fileName: `lecture${extension}`, mediaType, sizeBytes: 12 }],
    });
  });

  it.each([
    ['audio at 4 GiB', 'lecture.m4a', 4 * 1024 ** 3],
    ['document at 500 MiB', 'slides.pdf', 500 * 1024 ** 2],
  ])('accepts the exact supported size boundary for %s', async (_name, fileName, sizeBytes) => {
    const sourcePath = `/private/tmp/${fileName}`;
    const harness = createScriptableHarness({
      fileContents: {
        [sourcePath]: 'small but size-observable',
        'Catalog/courses.json': catalog(),
      },
      fileSizes: { [sourcePath.slice(1)]: sizeBytes },
      fixedClock: timestamp,
      uuidValues: [jobId],
    });

    await expect(
      harness.run({ fileURLs: [`file://${sourcePath}`], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId } });
  });

  it('rejects unsupported and oversized Shortcut sources before creating an Inbox child', async () => {
    const unsupported = createScriptableHarness({
      fileContents: { '/private/tmp/lecture.exe': 'bad', 'Catalog/courses.json': catalog() },
    });
    const oversized = createScriptableHarness({
      fileContents: { '/private/tmp/lecture.m4a': 'bad', 'Catalog/courses.json': catalog() },
      fileSizes: { 'private/tmp/lecture.m4a': 4 * 1024 ** 3 + 1 },
    });

    await expect(
      unsupported.run({ fileURLs: ['file:///private/tmp/lecture.exe'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: false, code: 'UNSUPPORTED_SOURCE' });
    await expect(
      oversized.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: false, code: 'SOURCE_TOO_LARGE' });
    expect(unsupported.fs.snapshot().filter((entry) => entry.path.startsWith('Inbox/'))).toEqual(
      [],
    );
    expect(oversized.fs.snapshot().filter((entry) => entry.path.startsWith('Inbox/'))).toEqual([]);
  });

  it.each(['jobMkdir', 'copy', 'manifest', 'move'] as const)(
    'removes only this invocation temporary directory after a pre-publication %s failure without exposing source details',
    async (failAt) => {
      const unrelatedJobId = '33333333-3333-4333-8333-333333333333';
      const harness = createScriptableHarness({
        failAt,
        fileContents: {
          '/private/tmp/private-lecture.m4a': 'unaltered source bytes',
          'Catalog/courses.json': catalog(),
        },
        uuidValues: [jobId],
      });
      await harness.runStatus();
      harness.fileManager.createDirectory(`Inbox/${unrelatedJobId}`);

      const result = await harness.run({
        fileURLs: ['file:///private/tmp/private-lecture.m4a'],
        shortcutParameter: null,
      });

      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain('/private/tmp');
      expect(JSON.stringify(result)).not.toContain('private-lecture.m4a');
      expect(harness.fs.readText('/private/tmp/private-lecture.m4a')).toBe(
        'unaltered source bytes',
      );
      expect(harness.fs.snapshot()).toContainEqual({
        contents: undefined,
        kind: 'directory',
        path: `Inbox/${unrelatedJobId}`,
      });
      expect(harness.fs.snapshot().some((entry) => entry.path.startsWith(`Inbox/${jobId}`))).toBe(
        false,
      );
    },
  );

  it('preserves a collided job directory and retries the next generated UUID candidate', async () => {
    const nextJobId = '33333333-3333-4333-8333-333333333333';
    const harness = createScriptableHarness({
      fileContents: {
        '/private/tmp/lecture.m4a': 'audio bytes',
        'Catalog/courses.json': catalog(),
      },
      fixedClock: timestamp,
      uuidValues: [jobId, nextJobId],
    });
    await harness.runStatus();
    harness.fileManager.createDirectory(`Inbox/${jobId}`);
    harness.fileManager.writeString(`Inbox/${jobId}/preserve.txt`, 'existing job bytes');

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId: nextJobId } });
    expect(harness.fs.readText(`Inbox/${jobId}/preserve.txt`)).toBe('existing job bytes');
  });

  it.each(['jobMkdir', 'sourceCopy', 'manifest', 'move'] as const)(
    'cleans only its hidden CourseInbox directory after a pre-publication %s failure',
    async (failAt) => {
      const newCourseId = '33333333-3333-4333-8333-333333333333';
      const unrelatedJobId = '44444444-4444-4444-8444-444444444444';
      const harness = createScriptableHarness({
        chooseCourseResult: 0,
        failAt,
        failJobId: jobId,
        fileContents: { '/private/tmp/private-lecture.m4a': 'unaltered source bytes' },
        promptCourseResult: { name: '새 과목', professorName: '' },
        uuidValues: [newCourseId, jobId],
      });
      await harness.runStatus();
      harness.fileManager.createDirectory(`CourseInbox/${unrelatedJobId}`);
      harness.fileManager.writeString(
        `CourseInbox/${unrelatedJobId}/other-owner.txt`,
        'preserve me',
      );

      const result = await harness.run({
        fileURLs: ['file:///private/tmp/private-lecture.m4a'],
        shortcutParameter: null,
      });

      expect(result).toMatchObject({ ok: false, code: 'QUEUE_WRITE_FAILED' });
      expect(JSON.stringify(result)).not.toContain('/private/tmp');
      expect(JSON.stringify(result)).not.toContain('private-lecture.m4a');
      expect(harness.fs.readText('/private/tmp/private-lecture.m4a')).toBe(
        'unaltered source bytes',
      );
      expect(harness.fs.readText(`CourseInbox/${unrelatedJobId}/other-owner.txt`)).toBe(
        'preserve me',
      );
      expect(
        harness.fs.snapshot().some((entry) => entry.path.startsWith(`CourseInbox/${jobId}`)),
      ).toBe(false);
    },
  );

  it('rejects a same-size source mutation during CourseInbox copy and removes the uncommitted bundle', async () => {
    const newCourseId = '33333333-3333-4333-8333-333333333333';
    const sourcePath = '/private/tmp/lecture.m4a';
    const harness = createScriptableHarness({
      afterSourceCopy: () => {
        harness.fileManager.writeString(sourcePath, 'bbbbbbbbbb');
      },
      chooseCourseResult: 0,
      fileContents: { [sourcePath]: 'aaaaaaaaaa' },
      promptCourseResult: { name: '새 과목', professorName: '' },
      uuidValues: [newCourseId, jobId],
    });

    await expect(
      harness.run({ fileURLs: [`file://${sourcePath}`], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: false, code: 'QUEUE_WRITE_FAILED' });
    expect(
      harness.fs.snapshot().some((entry) => entry.path.startsWith(`CourseInbox/${jobId}`)),
    ).toBe(false);
  });

  it('accepts an exact committed CourseInbox bundle after move reports a late error', async () => {
    const newCourseId = '33333333-3333-4333-8333-333333333333';
    const harness = createScriptableHarness({
      chooseCourseResult: 0,
      fileContents: { '/private/tmp/lecture.m4a': 'audio bytes' },
      fixedClock: timestamp,
      promptCourseResult: { name: '새 과목', professorName: '' },
      moveCreatesThenThrows: true,
      uuidValues: [newCourseId, jobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId } });
    expect(
      SourceBundleManifestV2Schema.parse(harness.fs.readJson(`CourseInbox/${jobId}/manifest.json`)),
    ).toMatchObject({ courseId: newCourseId, jobId, protocolVersion: 2 });
  });

  it('preserves but does not accept an uncertain CourseInbox bundle after a late move error', async () => {
    const newCourseId = '33333333-3333-4333-8333-333333333333';
    const harness = createScriptableHarness({
      afterMove: () => {
        harness.fileManager.writeString(`CourseInbox/${jobId}/unexpected.txt`, 'external data');
      },
      chooseCourseResult: 0,
      fileContents: { '/private/tmp/lecture.m4a': 'audio bytes' },
      fixedClock: timestamp,
      promptCourseResult: { name: '새 과목', professorName: '' },
      moveCreatesThenThrows: true,
      uuidValues: [newCourseId, jobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: false, code: 'QUEUE_WRITE_FAILED' });
    expect(harness.fs.readText(`CourseInbox/${jobId}/unexpected.txt`)).toBe('external data');
    expect(harness.fs.snapshot().some((entry) => entry.path.endsWith('/ready'))).toBe(false);
  });

  it.each(['Inbox', 'CourseInbox'] as const)(
    'leases a CourseInbox job UUID only when it is absent from the %s lane',
    async (collisionLane) => {
      const newCourseId = '33333333-3333-4333-8333-333333333333';
      const nextJobId = '44444444-4444-4444-8444-444444444444';
      const harness = createScriptableHarness({
        chooseCourseResult: 0,
        fileContents: { '/private/tmp/lecture.m4a': 'audio bytes' },
        promptCourseResult: { name: '새 과목', professorName: '' },
        uuidValues: [newCourseId, jobId, nextJobId],
      });
      await harness.runStatus();
      harness.fileManager.createDirectory(`${collisionLane}/${jobId}`);
      harness.fileManager.writeString(`${collisionLane}/${jobId}/preserve.txt`, 'existing data');

      await expect(
        harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
      ).resolves.toMatchObject({ ok: true, data: { jobId: nextJobId } });
      expect(harness.fs.readText(`${collisionLane}/${jobId}/preserve.txt`)).toBe('existing data');
    },
  );

  it('bounds CourseInbox job UUID retries and preserves every collided directory', async () => {
    const newCourseId = '33333333-3333-4333-8333-333333333333';
    const collisions = [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    const harness = createScriptableHarness({
      chooseCourseResult: 0,
      fileContents: { '/private/tmp/lecture.m4a': 'audio bytes' },
      promptCourseResult: { name: '새 과목', professorName: '' },
      uuidValues: [newCourseId, ...collisions],
    });
    await harness.runStatus();
    collisions.forEach((collision, index) => {
      const lane = index % 2 === 0 ? 'Inbox' : 'CourseInbox';
      harness.fileManager.createDirectory(`${lane}/${collision}`);
      harness.fileManager.writeString(`${lane}/${collision}/preserve.txt`, `collision-${index}`);
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: false, code: 'QUEUE_WRITE_FAILED' });
    collisions.forEach((collision, index) => {
      const lane = index % 2 === 0 ? 'Inbox' : 'CourseInbox';
      expect(harness.fs.readText(`${lane}/${collision}/preserve.txt`)).toBe(`collision-${index}`);
    });
  });

  it('leases canonical Inbox job UUIDs against CourseInbox collisions too', async () => {
    const nextJobId = '33333333-3333-4333-8333-333333333333';
    const harness = createScriptableHarness({
      fileContents: {
        '/private/tmp/lecture.m4a': 'audio bytes',
        'Catalog/courses.json': catalog(),
      },
      uuidValues: [jobId, nextJobId],
    });
    await harness.runStatus();
    harness.fileManager.createDirectory(`CourseInbox/${jobId}`);
    harness.fileManager.writeString(`CourseInbox/${jobId}/preserve.txt`, 'course lane collision');

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId: nextJobId } });
    expect(harness.fs.readText(`CourseInbox/${jobId}/preserve.txt`)).toBe('course lane collision');
  });

  it('routes a pending selection through canonical Inbox when PC publishes it before write', async () => {
    const pendingJobId = '33333333-3333-4333-8333-333333333333';
    const pendingCourseId = '44444444-4444-4444-8444-444444444444';
    const nextJobId = '55555555-5555-4555-8555-555555555555';
    const pending = pendingBundle(pendingJobId, {
      id: pendingCourseId,
      name: '모바일 대기 이름',
      professorName: '모바일 교수',
    });
    const harness = createScriptableHarness({
      chooseCourse: () => {
        harness.fileManager.writeString(
          'Catalog/courses.json',
          catalog([{ id: pendingCourseId, name: 'PC 정식 이름' }]),
        );
        return 0;
      },
      existingDirectories: [...reservedDirectories, ...pending.existingDirectories],
      fileContents: {
        [markerPath]: ownerMarker,
        '/private/tmp/lecture.m4a': 'audio bytes',
        ...pending.fileContents,
      },
      uuidValues: [nextJobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId: nextJobId } });
    expect(
      harness.fs.snapshot().some((entry) => entry.path === `Inbox/${nextJobId}/manifest.json`),
    ).toBe(true);
    expect(harness.fs.snapshot().some((entry) => entry.path === `CourseInbox/${nextJobId}`)).toBe(
      false,
    );
  });

  it('rechecks canonical data after refreshing a pending selection and before queue write', async () => {
    const pendingJobId = '33333333-3333-4333-8333-333333333333';
    const pendingCourseId = '44444444-4444-4444-8444-444444444444';
    const nextJobId = '55555555-5555-4555-8555-555555555555';
    const pending = pendingBundle(pendingJobId, {
      id: pendingCourseId,
      name: '모바일 대기 이름',
      professorName: '',
    });
    let courseInboxLists = 0;
    const harness = createScriptableHarness({
      afterCourseInboxList: () => {
        courseInboxLists += 1;
        if (courseInboxLists === 2) {
          harness.fileManager.writeString(
            'Catalog/courses.json',
            catalog([{ id: pendingCourseId, name: 'PC 정식 이름' }]),
          );
        }
      },
      chooseCourseResult: 0,
      existingDirectories: [...reservedDirectories, ...pending.existingDirectories],
      fileContents: {
        [markerPath]: ownerMarker,
        '/private/tmp/lecture.m4a': 'audio bytes',
        ...pending.fileContents,
      },
      uuidValues: [nextJobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId: nextJobId } });
    expect(courseInboxLists).toBeGreaterThanOrEqual(2);
    expect(
      harness.fs.snapshot().some((entry) => entry.path === `Inbox/${nextJobId}/manifest.json`),
    ).toBe(true);
    expect(harness.fs.snapshot().some((entry) => entry.path === `CourseInbox/${nextJobId}`)).toBe(
      false,
    );
  });

  it('routes a newly-created UUID through canonical Inbox if PC publishes the same ID', async () => {
    const newCourseId = '33333333-3333-4333-8333-333333333333';
    const nextJobId = '44444444-4444-4444-8444-444444444444';
    const harness = createScriptableHarness({
      afterUuid: (value, index) => {
        if (index === 0) {
          harness.fileManager.writeString(
            'Catalog/courses.json',
            catalog([{ id: value, name: 'PC 정식 이름' }]),
          );
        }
      },
      chooseCourseResult: 0,
      fileContents: { '/private/tmp/lecture.m4a': 'audio bytes' },
      promptCourseResult: { name: '모바일 입력 이름', professorName: '모바일 교수' },
      uuidValues: [newCourseId, nextJobId],
    });

    await expect(
      harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null }),
    ).resolves.toMatchObject({ ok: true, data: { jobId: nextJobId } });
    const manifest = SourceBundleManifestV2Schema.parse(
      harness.fs.readJson(`Inbox/${nextJobId}/manifest.json`),
    );
    expect(manifest.courseId).toBe(newCourseId);
    expect(JSON.stringify(manifest)).not.toContain('모바일');
  });
});
