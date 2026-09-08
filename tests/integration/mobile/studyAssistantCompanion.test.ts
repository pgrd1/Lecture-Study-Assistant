import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SourceBundleManifestV2Schema } from '../../../src/shared/contracts/sourceBundle';
import {
  createScriptableHarness,
  createScriptableRuntimeAlertHarness,
  loadStudyAssistant,
} from '../../testkit/scriptableHarness';

const MARKER_PATH = '.lecture-study-assistant-root.json';
const OWNER_MARKER = JSON.stringify({
  schemaVersion: 1,
  owner: 'lecture-study-assistant',
  queueProtocolVersion: 1,
});

describe('StudyAssistant protocol-v2 multi-file publication', () => {
  const courseId = '11111111-1111-4111-8111-111111111111';
  const jobId = '22222222-2222-4222-8222-222222222222';
  const sourceA = '33333333-3333-4333-8333-333333333333';
  const sourceB = '44444444-4444-4444-8444-444444444444';
  const catalog = JSON.stringify({
    protocolVersion: 1,
    generatedAt: '2026-09-03T14:30:15.123+09:00',
    courses: [{ id: courseId, name: '운영체제' }],
  });

  it('commits all Shortcut files under one course and one job id with the manifest last', async () => {
    const lecturePath = '/local/lecture.m4a';
    const boardPath = '/local/board.jpg';
    const harness = createScriptableHarness({
      fileContents: {
        [lecturePath]: 'audio bytes',
        [boardPath]: 'image bytes',
        'Catalog/courses.json': catalog,
      },
      uuidValues: [jobId, sourceA, sourceB],
    });

    const result = await harness.run({
      shortcutParameter: { action: 'enqueue', courseId },
      fileURLs: [lecturePath, boardPath],
    });

    expect(result).toMatchObject({ ok: true, action: 'enqueue', data: { jobId } });
    const manifest = SourceBundleManifestV2Schema.parse(
      harness.fs.readJson(`Inbox/${jobId}/manifest.json`),
    );
    expect(manifest).toEqual({
      protocolVersion: 2,
      jobId,
      courseId,
      createdAt: '2026-09-03T14:30:15.123+09:00',
      summaryMode: 'standard',
      sources: [
        { id: sourceA, fileName: 'lecture.m4a', mediaType: 'audio', sizeBytes: 11 },
        { id: sourceB, fileName: 'board.jpg', mediaType: 'image', sizeBytes: 11 },
      ],
    });
    expect(harness.fs.list(`Inbox/${jobId}/sources`)).toEqual([
      `0-${sourceA}.m4a`,
      `1-${sourceB}.jpg`,
    ]);
    expect(harness.fs.readText(lecturePath)).toBe('audio bytes');
    expect(harness.fs.readText(boardPath)).toBe('image bytes');
    expect(harness.fs.snapshot().some((entry) => entry.path.includes('.upload-'))).toBe(false);
    expect(harness.fs.snapshot().some((entry) => entry.path.endsWith('/ready'))).toBe(false);
    const publishOperations = harness.fs.operations.filter(
      (operation) => operation.startsWith('write:manifest.json') || operation.startsWith('move:'),
    );
    expect(publishOperations).toEqual([
      'write:manifest.json',
      `move:Inbox/.upload-${jobId}->Inbox/${jobId}`,
    ]);
  });

  it('writes a strict same-id courseProvisioning value for one new-course bundle', async () => {
    const newCourseId = '55555555-5555-4555-8555-555555555555';
    const harness = createScriptableHarness({
      fileContents: { '/local/lecture.m4a': 'audio bytes' },
      uuidValues: [newCourseId, jobId, sourceA],
    });

    const result = await harness.run({
      shortcutParameter: {
        action: 'enqueue',
        newCourseName: '자료구조',
        professorName: '김교수',
      },
      fileURLs: ['/local/lecture.m4a'],
    });

    expect(result).toMatchObject({ ok: true, data: { jobId } });
    const manifest = SourceBundleManifestV2Schema.parse(
      harness.fs.readJson(`CourseInbox/${jobId}/manifest.json`),
    );
    expect(manifest.courseId).toBe(newCourseId);
    expect(manifest.courseProvisioning).toEqual({
      id: newCourseId,
      name: '자료구조',
      professorName: '김교수',
    });
    expect(harness.fs.list(`CourseInbox/${jobId}`)).toEqual(['manifest.json', 'sources']);
  });

  it('rejects an aggregate above 8 GiB before creating a temporary bundle', async () => {
    const paths = ['/local/a.m4a', '/local/b.m4a', '/local/c.m4a'];
    const harness = createScriptableHarness({
      fileContents: {
        '/local/a.m4a': 'a',
        '/local/b.m4a': 'b',
        '/local/c.m4a': 'c',
        'Catalog/courses.json': catalog,
      },
      fileSizes: Object.fromEntries(paths.map((path) => [path, 3 * 1024 ** 3])),
    });

    await expect(
      harness.run({ shortcutParameter: { action: 'enqueue', courseId }, fileURLs: paths }),
    ).resolves.toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' });
    expect(harness.fs.snapshot().some((entry) => entry.path.includes('.upload-'))).toBe(false);
    expect(harness.fs.snapshot().some((entry) => entry.path.startsWith(`Inbox/${jobId}`))).toBe(
      false,
    );
  });

  it('removes only its hidden temporary directory when the second source copy fails', async () => {
    const unrelatedJobId = '66666666-6666-4666-8666-666666666666';
    const harness = createScriptableHarness({
      existingDirectories: [`Inbox/${unrelatedJobId}`],
      failAt: 'sourceCopy',
      failSourceCopyAt: 1,
      fileContents: {
        '/local/lecture.m4a': 'audio bytes',
        '/local/board.jpg': 'image bytes',
        [`Inbox/${unrelatedJobId}/preserve.txt`]: 'preserve me',
        'Catalog/courses.json': catalog,
      },
      uuidValues: [jobId, sourceA, sourceB],
    });

    await expect(
      harness.run({
        shortcutParameter: { action: 'enqueue', courseId },
        fileURLs: ['/local/lecture.m4a', '/local/board.jpg'],
      }),
    ).resolves.toMatchObject({ ok: false, code: 'QUEUE_WRITE_FAILED' });
    expect(harness.fs.operations).toContain(`remove:Inbox/.upload-${jobId}`);
    expect(harness.fs.operations).not.toContain(`remove:Inbox/${jobId}`);
    expect(harness.fs.readText(`Inbox/${unrelatedJobId}/preserve.txt`)).toBe('preserve me');
    expect(harness.fs.readText('/local/lecture.m4a')).toBe('audio bytes');
    expect(harness.fs.readText('/local/board.jpg')).toBe('image bytes');
  });

  it('rejects a same-size source metadata change during copy and never publishes the bundle', async () => {
    const changingPath = '/local/board.jpg';
    const harness = createScriptableHarness({
      afterSourceCopy: (sourcePath) => {
        if (sourcePath === 'local/board.jpg')
          harness.fileManager.writeString(changingPath, 'other bytes');
      },
      fileContents: {
        '/local/lecture.m4a': 'audio bytes',
        [changingPath]: 'image bytes',
        'Catalog/courses.json': catalog,
      },
      uuidValues: [jobId, sourceA, sourceB],
    });

    await expect(
      harness.run({
        shortcutParameter: { action: 'enqueue', courseId },
        fileURLs: ['/local/lecture.m4a', changingPath],
      }),
    ).resolves.toMatchObject({ ok: false, code: 'QUEUE_WRITE_FAILED' });
    expect(harness.fs.snapshot().some((entry) => entry.path.startsWith(`Inbox/${jobId}`))).toBe(
      false,
    );
    expect(harness.fs.operations).toContain(`remove:Inbox/.upload-${jobId}`);
  });
});
const RESERVED_DIRECTORIES = ['Catalog', 'Inbox', 'CourseInbox', 'Status', 'Rejected'];
class SelectFirstCourseAlert {
  addAction(_name: string) {}
  addCancelAction(_name: string) {}
  presentSheet() {
    return 0;
  }
}
const byteSize = (harness: ReturnType<typeof createScriptableHarness>, path: string): number => {
  const fileSize = harness.fileManager.fileSize;
  if (!fileSize) throw new Error('TEST_FILE_SIZE_MISSING');
  return fileSize(path);
};
const receiverBrandedFileManager = (
  harness: ReturnType<typeof createScriptableHarness>,
  divisor = 1,
): Readonly<Record<string, unknown>> => {
  const raw: Record<string, unknown> = {};
  const base = harness.fileManager as unknown as Record<string, unknown>;
  const names = [
    'copy',
    'createDirectory',
    'documentsDirectory',
    'downloadFileFromiCloud',
    'fileExists',
    'fileName',
    'isDirectory',
    'isFileDownloaded',
    'joinPath',
    'listContents',
    'modificationDate',
    'move',
    'readString',
    'remove',
    'write',
    'writeString',
  ];
  for (const name of names) {
    const method = base[name];
    if (typeof method !== 'function') continue;
    raw[name] = function (this: unknown, ...args: unknown[]) {
      if (this !== raw) throw new Error(`WRONG_RECEIVER:${name}`);
      return method.apply(base, args);
    };
  }
  const fileSize = base.fileSize;
  if (typeof fileSize === 'function') {
    raw.fileSize = function (this: unknown, ...args: unknown[]) {
      if (this !== raw) throw new Error('WRONG_RECEIVER:fileSize');
      return fileSize.apply(base, args) / divisor;
    };
  }
  return Object.freeze(raw);
};
const ownedRootSnapshot = () =>
  [
    { contents: OWNER_MARKER, kind: 'file', path: MARKER_PATH },
    ...RESERVED_DIRECTORIES.map((path) => ({ contents: undefined, kind: 'directory', path })),
  ].sort((left, right) => left.path.localeCompare(right.path));
const readyInboxFiles = (jobId: string, ready = '') => ({
  [`Inbox/${jobId}/manifest.json`]: JSON.stringify({
    protocolVersion: 1,
    jobId,
    courseId: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-03T14:30:15.123+09:00',
    source: { fileName: 'lecture.m4a', mediaType: 'audio' },
    summaryMode: 'standard',
  }),
  [`Inbox/${jobId}/source.m4a`]: 'status source bytes',
  [`Inbox/${jobId}/ready`]: ready,
});
const api = loadStudyAssistant();

describe('StudyAssistant owned Scriptable queue initialization', () => {
  it.each(RESERVED_DIRECTORIES)(
    'fails closed when %s already exists without the ownership marker',
    async (reservedName) => {
      const harness = createScriptableHarness({ existingFiles: [reservedName] });

      await expect(harness.runStatus()).resolves.toMatchObject({
        ok: false,
        code: 'QUEUE_ROOT_CONFLICT',
        diagnostic: { build: '20260905-2', stage: 'R02' },
      });
      expect(harness.fs.snapshot()).toEqual(harness.fs.initialSnapshot);
    },
  );

  it.each(RESERVED_DIRECTORIES)(
    'fails closed when %s is already a directory without the ownership marker',
    async (reservedName) => {
      const harness = createScriptableHarness({ existingDirectories: [reservedName] });

      await expect(harness.runStatus()).resolves.toMatchObject({
        ok: false,
        code: 'QUEUE_ROOT_CONFLICT',
      });
      expect(harness.fs.snapshot()).toEqual(harness.fs.initialSnapshot);
    },
  );

  it('writes the exact ownership marker and all reserved directories on a clean root', async () => {
    const harness = createScriptableHarness();

    await harness.runStatus();

    expect(harness.fs.snapshot()).toEqual(ownedRootSnapshot());
    expect(harness.fs.operations).toEqual([
      `write:${MARKER_PATH}`,
      ...RESERVED_DIRECTORIES.map((path) => `mkdir:${path}`),
    ]);
  });

  it('does not change an initialized root on a second valid invocation', async () => {
    const harness = createScriptableHarness();
    await harness.runStatus();
    const operationsAfterFirstRun = harness.fs.operations;
    const snapshotAfterFirstRun = harness.fs.snapshot();

    await harness.run({ fileURLs: ['file:///private/tmp/lecture.m4a'], shortcutParameter: null });

    expect(harness.fs.operations).toEqual(operationsAfterFirstRun);
    expect(harness.fs.snapshot()).toEqual(snapshotAfterFirstRun);
  });

  it.each([
    '{not valid JSON',
    JSON.stringify({
      schemaVersion: 1,
      owner: 'lecture-study-assistant',
      queueProtocolVersion: 2,
    }),
    JSON.stringify({
      schemaVersion: 1,
      owner: 'lecture-study-assistant',
      queueProtocolVersion: 1,
      extra: true,
    }),
  ])('fails closed for invalid or extra marker fields', async (marker) => {
    const harness = createScriptableHarness({
      existingFiles: [MARKER_PATH],
      fileContents: { [MARKER_PATH]: marker },
    });

    await expect(harness.runStatus()).resolves.toMatchObject({
      ok: false,
      code: 'QUEUE_ROOT_CONFLICT',
    });
    expect(harness.fs.snapshot()).toEqual(harness.fs.initialSnapshot);
  });

  it.each(['__proto__', 'constructor'])(
    'fails closed for an own %s marker field',
    async (unsafeKey) => {
      const marker = JSON.stringify({
        schemaVersion: 1,
        owner: 'lecture-study-assistant',
        queueProtocolVersion: 1,
        [unsafeKey]: { injected: true },
      });
      const harness = createScriptableHarness({
        existingFiles: [MARKER_PATH],
        fileContents: { [MARKER_PATH]: marker },
      });

      await expect(harness.runStatus()).resolves.toMatchObject({
        ok: false,
        code: 'QUEUE_ROOT_CONFLICT',
      });
      expect(harness.fs.snapshot()).toEqual(harness.fs.initialSnapshot);
    },
  );

  it.each([1025, Number.NaN, -1])(
    'fails closed before reading a marker with an unsafe observed byte size (%s)',
    async (fileSize) => {
      const harness = createScriptableHarness({
        existingFiles: [MARKER_PATH],
        fileContents: { [MARKER_PATH]: OWNER_MARKER },
        fileSizes: { [MARKER_PATH]: fileSize },
      });

      await expect(harness.runStatus()).resolves.toMatchObject({
        ok: false,
        code: 'QUEUE_ROOT_CONFLICT',
      });
      expect(harness.fs.reads).toEqual([]);
      expect(harness.fs.snapshot()).toEqual(harness.fs.initialSnapshot);
    },
  );

  it.each([{ fileSizeThrows: [MARKER_PATH] }, { omitFileSize: true }])(
    'fails closed before reading when marker size is unavailable',
    async (options) => {
      const harness = createScriptableHarness({
        existingFiles: [MARKER_PATH],
        fileContents: { [MARKER_PATH]: OWNER_MARKER },
        ...options,
      });

      await expect(harness.runStatus()).resolves.toMatchObject({
        ok: false,
        code: 'QUEUE_ROOT_CONFLICT',
      });
      expect(harness.fs.reads).toEqual([]);
      expect(harness.fs.snapshot()).toEqual(harness.fs.initialSnapshot);
    },
  );

  it('fails closed when a reserved directory has the wrong observable type', async () => {
    const harness = createScriptableHarness({
      existingFiles: [MARKER_PATH, 'Inbox'],
      fileContents: { [MARKER_PATH]: OWNER_MARKER },
    });

    await expect(harness.runStatus()).resolves.toMatchObject({
      ok: false,
      code: 'QUEUE_ROOT_CONFLICT',
    });
    expect(harness.fs.snapshot()).toEqual(harness.fs.initialSnapshot);
  });

  it('fails closed when the ownership marker has the wrong observable type', async () => {
    const harness = createScriptableHarness({ existingDirectories: [MARKER_PATH] });

    await expect(harness.runStatus()).resolves.toMatchObject({
      ok: false,
      code: 'QUEUE_ROOT_CONFLICT',
    });
    expect(harness.fs.snapshot()).toEqual(harness.fs.initialSnapshot);
  });

  it('resumes a partial post-marker initialization by creating only missing directories', async () => {
    const harness = createScriptableHarness({
      existingDirectories: ['Catalog'],
      existingFiles: [MARKER_PATH],
      fileContents: { [MARKER_PATH]: OWNER_MARKER },
    });

    await harness.runStatus();

    expect(harness.fs.operations).toEqual([
      'mkdir:Inbox',
      'mkdir:CourseInbox',
      'mkdir:Status',
      'mkdir:Rejected',
    ]);
    expect(harness.fs.snapshot()).toEqual(ownedRootSnapshot());
  });

  it('upgrades an owned protocol-1 root by creating only its missing CourseInbox', async () => {
    const legacyDirectories = RESERVED_DIRECTORIES.filter((name) => name !== 'CourseInbox');
    const harness = createScriptableHarness({
      existingDirectories: legacyDirectories,
      fileContents: { [MARKER_PATH]: OWNER_MARKER },
    });

    await harness.runStatus();

    expect(harness.fs.operations).toEqual(['mkdir:CourseInbox']);
    expect(harness.fs.snapshot()).toEqual(ownedRootSnapshot());
  });

  it('preserves unknown root file bytes while initializing the owned paths', async () => {
    const unknownBytes = '\u0000non-UTF8-opaque\u00ff';
    const harness = createScriptableHarness({
      existingFiles: ['OtherAutomation.js'],
      fileContents: { 'OtherAutomation.js': unknownBytes },
    });

    await harness.runStatus();

    expect(harness.fs.snapshot()).toContainEqual({
      contents: unknownBytes,
      kind: 'file',
      path: 'OtherAutomation.js',
    });
  });

  it('initializes the exact Scriptable iCloud manager only for a valid runtime status dispatch', async () => {
    const harness = createScriptableHarness();
    let iCloudCalls = 0;
    const result = await api.runScriptableRuntime({
      Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
      FileManager: {
        iCloud: () => {
          iCloudCalls += 1;
          return harness.fileManager;
        },
      },
      args: { fileURLs: [], shortcutParameter: { action: 'status' } },
    });

    expect(iCloudCalls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      action: 'status',
      data: { completed: 0, failed: 0, processing: 0, queued: 0, unreadableStatusFiles: 0 },
    });
    expect(harness.fs.snapshot()).toEqual(ownedRootSnapshot());
  });

  it('returns native Shortcut course choices without constructing an Alert', async () => {
    const harness = createScriptableHarness({
      fileContents: {
        'Catalog/courses.json': JSON.stringify({
          protocolVersion: 1,
          generatedAt: '2026-09-03T14:30:15.123+09:00',
          courses: [{ id: '11111111-1111-4111-8111-111111111111', name: '운영체제' }],
        }),
      },
    });
    let alertConstructions = 0;
    const result = await api.runScriptableRuntime({
      Alert: class {
        constructor() {
          alertConstructions += 1;
          throw new Error('Alert must not be constructed');
        }
      },
      Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
      FileManager: { iCloud: () => harness.fileManager },
      Script: { complete: () => undefined, setShortcutOutput: () => undefined },
      args: { fileURLs: [], shortcutParameter: { action: 'courses' } },
    });

    expect(result).toMatchObject({
      action: 'courses',
      data: {
        labels: ['운영체제', '＋ 과목 추가'],
        courseIdsByLabel: { 운영체제: '11111111-1111-4111-8111-111111111111' },
      },
      ok: true,
    });
    expect(alertConstructions).toBe(0);
  });

  it('enqueues a native Shortcut course selection without constructing an Alert', async () => {
    const sourcePath = '/private/native-shortcut-selection.m4a';
    const jobId = '33333333-3333-4333-8333-333333333333';
    const courseId = '11111111-1111-4111-8111-111111111111';
    const harness = createScriptableHarness({
      fileContents: {
        [sourcePath]: 'audio bytes',
        'Catalog/courses.json': JSON.stringify({
          protocolVersion: 1,
          generatedAt: '2026-09-03T14:30:15.123+09:00',
          courses: [{ id: courseId, name: '운영체제' }],
        }),
      },
    });
    let alertConstructions = 0;
    const result = await api.runScriptableRuntime({
      Alert: class {
        constructor() {
          alertConstructions += 1;
          throw new Error('Alert must not be constructed');
        }
      },
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => harness.fileManager },
      UUID: { string: () => jobId },
      Script: { complete: () => undefined, setShortcutOutput: () => undefined },
      args: {
        fileURLs: [`file://${sourcePath}`],
        shortcutParameter: { action: 'enqueue', courseId },
      },
    });

    expect(result).toMatchObject({ ok: true, action: 'enqueue', data: { jobId } });
    expect(
      SourceBundleManifestV2Schema.parse(harness.fs.readJson(`Inbox/${jobId}/manifest.json`)),
    ).toMatchObject({ jobId, protocolVersion: 2 });
    expect(alertConstructions).toBe(0);
  });

  it('reports only a compact runtime shape when Shortcut supplies an unsupported parameter', async () => {
    let iCloudCalls = 0;
    const privatePath = '/private/var/mobile/recording.m4a';

    const result = await api.runScriptableRuntime({
      FileManager: {
        iCloud: () => {
          iCloudCalls += 1;
          throw new Error('invalid input must not initialize storage');
        },
      },
      args: { fileURLs: [], shortcutParameter: [privatePath] },
    });

    expect(result).toEqual({
      code: 'INVALID_ACTION',
      diagnostic: {
        build: '20260905-3',
        fileURLs: 'F0',
        shortcutParameter: 'A1-SP',
      },
      message: '단축어 입력을 확인해 주세요. [진단 20260905-3/F0/A1-SP]',
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(iCloudCalls).toBe(0);
  });

  it('reports the file count and dictionary shape when a new-course enqueue receives no file', async () => {
    let iCloudCalls = 0;

    const result = await api.runScriptableRuntime({
      FileManager: {
        iCloud: () => {
          iCloudCalls += 1;
          throw new Error('invalid input must not initialize storage');
        },
      },
      args: {
        fileURLs: [],
        shortcutParameter: {
          action: 'enqueue',
          newCourseName: '자료구조',
          professorName: '김교수',
        },
      },
    });

    expect(result).toEqual({
      code: 'INVALID_INPUT',
      diagnostic: {
        build: '20260905-3',
        fileURLs: 'F0',
        shortcutParameter: 'OM',
      },
      message: '입력 내용을 확인해 주세요. [진단 20260905-3/F0/OM]',
      ok: false,
    });
    expect(iCloudCalls).toBe(0);
  });

  it('enqueues a new course when iOS supplies the Shortcut file as an absolute path', async () => {
    const sourcePath = '/private/var/mobile/recording.m4a';
    const newCourseId = '33333333-3333-4333-8333-333333333333';
    const newJobId = '44444444-4444-4444-8444-444444444444';
    const sourceId = '55555555-5555-4555-8555-555555555555';
    const uuidValues = [newCourseId, newJobId, sourceId];
    const harness = createScriptableHarness({
      fileContents: { [sourcePath]: 'audio bytes' },
    });

    const result = await api.runScriptableRuntime({
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => harness.fileManager },
      UUID: { string: () => uuidValues.shift() },
      Script: { complete: () => undefined, setShortcutOutput: () => undefined },
      args: {
        fileURLs: [sourcePath],
        shortcutParameter: {
          action: 'enqueue',
          newCourseName: '자료구조',
          professorName: '김교수',
        },
      },
    });

    expect(result).toMatchObject({
      action: 'enqueue',
      data: { jobId: newJobId },
      ok: true,
    });
    expect(
      SourceBundleManifestV2Schema.parse(
        harness.fs.readJson(`CourseInbox/${newJobId}/manifest.json`),
      ),
    ).toMatchObject({ jobId: newJobId, protocolVersion: 2 });
  });

  it('snapshots runtime args before enqueue so a later getter failure cannot mask a committed job', async () => {
    const jobId = '55555555-5555-4555-8555-555555555555';
    const sourcePath = '/private/runtime-args-getter.m4a';
    const harness = createScriptableHarness({
      fileContents: {
        [sourcePath]: 'runtime audio bytes',
        'Catalog/courses.json': JSON.stringify({
          protocolVersion: 1,
          generatedAt: '2026-09-03T14:30:15.123+09:00',
          courses: [{ id: '11111111-1111-4111-8111-111111111111', name: '운영체제' }],
        }),
      },
      uuidValues: [jobId],
    });
    const stableArgs = {
      fileURLs: [`file://${sourcePath}`],
      shortcutParameter: null,
    };
    let argsReads = 0;

    const result = await api.runScriptableRuntime({
      Alert: SelectFirstCourseAlert,
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => harness.fileManager },
      UUID: { string: () => jobId },
      get args() {
        argsReads += 1;
        if (argsReads > 5) throw new Error('runtime args changed after queue commit');
        return stableArgs;
      },
    });

    expect(result).toMatchObject({ ok: true, action: 'enqueue', data: { jobId } });
    expect(argsReads).toBe(1);
    expect(
      SourceBundleManifestV2Schema.parse(harness.fs.readJson(`Inbox/${jobId}/manifest.json`)),
    ).toMatchObject({ jobId, protocolVersion: 2 });
  });

  it('downloads an iCloud-only ownership marker before runtime validation', async () => {
    const harness = createScriptableHarness({
      existingDirectories: RESERVED_DIRECTORIES,
      fileContents: { [MARKER_PATH]: OWNER_MARKER },
      initiallyNotDownloaded: [MARKER_PATH],
    });

    const result = await api.runScriptableRuntime({
      Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
      FileManager: { iCloud: () => harness.fileManager },
      args: { fileURLs: [], shortcutParameter: { action: 'status' } },
    });

    expect(result).toMatchObject({ ok: true, action: 'status' });
    expect(harness.calls.downloads).toEqual([MARKER_PATH]);
    expect(harness.fs.snapshot()).toEqual(harness.fs.initialSnapshot);
  });

  it('keeps the Scriptable host invocation pending until shortcut output is published', async () => {
    const source = readFileSync(
      new URL('../../../mobile/scriptable/StudyAssistant.js', import.meta.url),
      'utf8',
    );
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...parameters: string[]
    ) => (...values: unknown[]) => Promise<unknown>;
    const execute = new AsyncFunction(
      'Alert',
      'Data',
      'FileManager',
      'Script',
      'UUID',
      'args',
      source,
    );
    const harness = createScriptableHarness();
    let releaseICloud: ((fileManager: unknown) => void) | undefined;
    const iCloudManager = new Promise<unknown>((resolve) => {
      releaseICloud = resolve;
    });
    let publishComplete: (() => void) | undefined;
    const published = new Promise<void>((resolve) => {
      publishComplete = resolve;
    });
    let observeOutput: (() => void) | undefined;
    const outputObserved = new Promise<void>((resolve) => {
      observeOutput = resolve;
    });
    let releaseOutput: (() => void) | undefined;
    const outputPublication = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    const outputs: unknown[] = [];
    let completes = 0;
    const execution = execute(
      undefined,
      { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
      { iCloud: () => iCloudManager },
      {
        complete: () => {
          completes += 1;
          publishComplete?.();
        },
        setShortcutOutput: (output: unknown) => {
          outputs.push(output);
          observeOutput?.();
          return outputPublication;
        },
      },
      undefined,
      { fileURLs: [], shortcutParameter: { action: 'status' } },
    );
    let hostInvocationSettled = false;
    void execution.then(() => {
      hostInvocationSettled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeICloud = hostInvocationSettled;
    releaseICloud?.(harness.fileManager);
    await outputObserved;
    expect(completes).toBe(0);
    releaseOutput?.();
    await published;
    await execution;

    expect(settledBeforeICloud).toBe(false);
    expect(completes).toBe(1);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ action: 'status', ok: true });
  });

  it('does not resolve Scriptable iCloud storage for a direct no-input runtime launch', async () => {
    const harness = createScriptableHarness();
    let iCloudCalls = 0;
    const result = await api.runScriptableRuntime({
      FileManager: {
        iCloud: () => {
          iCloudCalls += 1;
          return harness.fileManager;
        },
      },
      args: { fileURLs: [], shortcutParameter: null },
    });

    expect(result).toMatchObject({ ok: false, code: 'SHORTCUT_ONLY' });
    expect(iCloudCalls).toBe(0);
    expect(harness.fs.operations).toEqual([]);
  });

  it('publishes one sanitized runtime result and completes once for direct no-input invocation', async () => {
    const outputs: unknown[] = [];
    let completes = 0;
    const result = await api.runScriptableRuntime({
      Script: {
        complete: () => {
          completes += 1;
        },
        setShortcutOutput: (output: unknown) => {
          outputs.push(output);
        },
      },
      args: { fileURLs: [], shortcutParameter: null },
    });

    expect(result).toMatchObject({ ok: false, code: 'SHORTCUT_ONLY' });
    expect(outputs).toEqual([result]);
    expect(completes).toBe(1);
    expect(JSON.stringify(outputs[0])).not.toContain('/private/');
    expect(outputs[0]).not.toHaveProperty('stack');
  });

  it('publishes one fixed result and completes once when runtime iCloud access rejects', async () => {
    const outputs: unknown[] = [];
    let completes = 0;
    const result = await api.runScriptableRuntime({
      FileManager: { iCloud: () => Promise.reject(new Error('/private/secret')) },
      Script: {
        complete: () => {
          completes += 1;
        },
        setShortcutOutput: (output: unknown) => {
          outputs.push(output);
          throw new Error('publish failure');
        },
      },
      args: { fileURLs: [], shortcutParameter: { action: 'status' } },
    });

    expect(result).toEqual({
      ok: false,
      code: 'UNEXPECTED_ERROR',
      diagnostic: { build: '20260906-4', stage: 'F01' },
      message: '예상하지 못한 오류가 발생했습니다. 다시 시도해 주세요. [진단 20260906-4/F01]',
    });
    expect(outputs).toHaveLength(1);
    expect(completes).toBe(1);
    expect(JSON.stringify(outputs[0])).not.toContain('/private/');
  });

  it('does not trust a dependency error that imitates an internal queue diagnostic', async () => {
    const result = await api.runScriptableRuntime({
      FileManager: {
        iCloud: () => Promise.reject(new Error('QUEUE_ROOT_CONFLICT|R16|1')),
      },
      args: { fileURLs: [], shortcutParameter: { action: 'status' } },
    });

    expect(result).toEqual({
      ok: false,
      code: 'UNEXPECTED_ERROR',
      diagnostic: { build: '20260906-4', stage: 'F01' },
      message: '예상하지 못한 오류가 발생했습니다. 다시 시도해 주세요. [진단 20260906-4/F01]',
    });
    expect(JSON.stringify(result)).not.toContain('QUEUE_ROOT_CONFLICT');
    expect(JSON.stringify(result)).not.toContain('R16');
  });

  it('returns a safe ownership-stage diagnostic when native queue verification throws', async () => {
    const harness = createScriptableHarness({
      existingDirectories: ['Catalog', 'Inbox', 'CourseInbox', 'Status', 'Rejected'],
      fileContents: {
        '.lecture-study-assistant-root.json': JSON.stringify({
          schemaVersion: 1,
          owner: 'lecture-study-assistant',
          queueProtocolVersion: 1,
        }),
      },
    });
    let markerChecks = 0;
    const fileManager = {
      ...harness.fileManager,
      fileExists: (path: string) => {
        if (path.endsWith('/.lecture-study-assistant-root.json') && ++markerChecks === 2) {
          throw new Error('/private/owner');
        }
        return harness.fileManager.fileExists(path);
      },
    };

    const result = await api.runScriptableRuntime({
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => fileManager },
      Script: { complete: () => undefined, setShortcutOutput: () => undefined },
      args: { fileURLs: [], shortcutParameter: { action: 'status' } },
    });

    expect(result).toEqual({
      ok: false,
      code: 'UNEXPECTED_ERROR',
      diagnostic: { build: '20260906-4', stage: 'F02' },
      message: '예상하지 못한 오류가 발생했습니다. 다시 시도해 주세요. [진단 20260906-4/F02]',
    });
    expect(JSON.stringify(result)).not.toContain('/private/');
  });

  it('returns a safe source-stage diagnostic when native source inspection throws', async () => {
    const sourcePath = '/private/source-inspection.m4a';
    const harness = createScriptableHarness({ fileContents: { [sourcePath]: 'audio bytes' } });
    const fileManager = {
      ...harness.fileManager,
      fileExists: (path: string) => {
        if (path === sourcePath) throw new Error('/private/source');
        return harness.fileManager.fileExists(path);
      },
    };

    const result = await api.runScriptableRuntime({
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => fileManager },
      Script: { complete: () => undefined, setShortcutOutput: () => undefined },
      args: { fileURLs: [`file://${sourcePath}`], shortcutParameter: null },
    });

    expect(result).toEqual({
      ok: false,
      code: 'UNEXPECTED_ERROR',
      diagnostic: { build: '20260906-4', stage: 'E01' },
      message: '예상하지 못한 오류가 발생했습니다. 다시 시도해 주세요. [진단 20260906-4/E01]',
    });
    expect(JSON.stringify(result)).not.toContain('/private/');
  });

  it('falls back to a modal picker when the native course sheet rejects', async () => {
    const harness = createScriptableHarness({
      fileContents: {
        '/private/lecture.m4a': 'audio bytes',
        'Catalog/courses.json': JSON.stringify({
          protocolVersion: 1,
          generatedAt: '2026-09-03T14:30:15.123+09:00',
          courses: [
            { id: '11111111-1111-4111-8111-111111111111', name: '운영체제' },
            { id: '22222222-2222-4222-8222-222222222222', name: '데이터베이스' },
          ],
        }),
      },
    });
    const outputs: unknown[] = [];
    let completes = 0;
    let alertCount = 0;
    const result = await api.runScriptableRuntime({
      Alert: class {
        readonly index = alertCount++;
        addAction(_name: string) {}
        addCancelAction(_name: string) {}
        presentAlert() {
          return Promise.resolve(0);
        }
        presentSheet() {
          if (this.index === 0) return Promise.reject(new Error('/private/alert'));
          return Promise.resolve(-1);
        }
      },
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => harness.fileManager },
      UUID: { string: () => '33333333-3333-4333-8333-333333333333' },
      Script: {
        complete: () => {
          completes += 1;
        },
        setShortcutOutput: (output: unknown) => {
          outputs.push(output);
        },
      },
      args: { fileURLs: ['file:///private/lecture.m4a'], shortcutParameter: null },
    });

    expect(result).toMatchObject({
      ok: true,
      action: 'enqueue',
      data: { jobId: '33333333-3333-4333-8333-333333333333' },
    });
    expect(alertCount).toBe(2);
    expect(outputs).toEqual([result]);
    expect(completes).toBe(1);
    expect(
      SourceBundleManifestV2Schema.parse(
        harness.fs.readJson('Inbox/33333333-3333-4333-8333-333333333333/manifest.json'),
      ),
    ).toMatchObject({ protocolVersion: 2 });
  });

  it('uses a direct native alert factory instead of a transported constructor', async () => {
    const sourcePath = '/private/direct-alert-factory.m4a';
    const harness = createScriptableHarness({ fileContents: { [sourcePath]: 'audio bytes' } });
    const alerts = createScriptableRuntimeAlertHarness({ pickerResult: -1 });

    const result = await api.runScriptableRuntime({
      Alert: class {
        constructor() {
          throw new Error('transported constructor must not run');
        }
      },
      createAlert: () => new alerts.Alert(),
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => harness.fileManager },
      Script: { complete: () => undefined, setShortcutOutput: () => undefined },
      args: { fileURLs: [`file://${sourcePath}`], shortcutParameter: null },
    });

    expect(result).toMatchObject({ ok: true, action: 'enqueue', data: { cancelled: true } });
    expect(alerts.calls.pickers).toHaveLength(1);
  });

  it('does not treat a native Alert object as a promise while constructing the picker', async () => {
    const sourcePath = '/private/native-alert-object.m4a';
    const harness = createScriptableHarness({ fileContents: { [sourcePath]: 'audio bytes' } });
    let thenReads = 0;
    class NativeAlert {
      constructor() {
        Object.defineProperty(this, 'then', {
          get: () => {
            thenReads += 1;
            throw new Error('/private/native-then');
          },
        });
      }
      addAction(_name: string) {}
      addCancelAction(_name: string) {}
      presentSheet() {
        return Promise.resolve(-1);
      }
    }

    const result = await api.runScriptableRuntime({
      createAlert: () => new NativeAlert(),
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => harness.fileManager },
      Script: { complete: () => undefined, setShortcutOutput: () => undefined },
      args: { fileURLs: [`file://${sourcePath}`], shortcutParameter: null },
    });

    expect(result).toMatchObject({ ok: true, action: 'enqueue', data: { cancelled: true } });
    expect(thenReads).toBe(0);
  });

  it('classifies each native picker construction failure without exposing its error', async () => {
    const scenarios = [
      {
        Alert: class {
          constructor() {
            throw new Error('/private/constructor');
          }
        },
        stage: 'U111',
      },
      {
        Alert: class {
          addAction(_name: string) {
            throw new Error('/private/action');
          }
          addCancelAction(_name: string) {}
        },
        stage: 'U112',
      },
      {
        Alert: class {
          addAction(_name: string) {}
          addCancelAction(_name: string) {
            throw new Error('/private/cancel');
          }
        },
        stage: 'U113',
      },
    ] as const;

    for (const scenario of scenarios) {
      const sourcePath = `/private/${scenario.stage}.m4a`;
      const harness = createScriptableHarness({ fileContents: { [sourcePath]: 'audio bytes' } });
      const result = await api.runScriptableRuntime({
        Alert: scenario.Alert,
        Data: {
          fromBytes: (bytes: readonly number[]) => ({ bytes }),
          fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
        },
        FileManager: { iCloud: () => harness.fileManager },
        Script: { complete: () => undefined, setShortcutOutput: () => undefined },
        args: { fileURLs: [`file://${sourcePath}`], shortcutParameter: null },
      });

      expect(result).toEqual({
        ok: false,
        code: 'UNEXPECTED_ERROR',
        diagnostic: { build: '20260906-4', stage: scenario.stage },
        message: `예상하지 못한 오류가 발생했습니다. 다시 시도해 주세요. [진단 20260906-4/${scenario.stage}]`,
      });
      expect(JSON.stringify(result)).not.toContain('/private/');
    }
  });

  it('returns a safe diagnostic when the modal picker fallback also rejects', async () => {
    const sourcePath = '/private/modal-fallback.m4a';
    const harness = createScriptableHarness({ fileContents: { [sourcePath]: 'audio bytes' } });
    let alertCount = 0;
    const result = await api.runScriptableRuntime({
      Alert: class {
        readonly index = alertCount++;
        addAction(_name: string) {}
        addCancelAction(_name: string) {}
        presentAlert() {
          return Promise.reject(new Error('/private/modal'));
        }
        presentSheet() {
          if (this.index === 0) return Promise.reject(new Error('/private/sheet'));
          return Promise.resolve(-1);
        }
      },
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => harness.fileManager },
      Script: { complete: () => undefined, setShortcutOutput: () => undefined },
      args: { fileURLs: [`file://${sourcePath}`], shortcutParameter: null },
    });

    expect(result).toEqual({
      ok: false,
      code: 'UNEXPECTED_ERROR',
      diagnostic: { build: '20260906-4', stage: 'U13' },
      message: '예상하지 못한 오류가 발생했습니다. 다시 시도해 주세요. [진단 20260906-4/U13]',
    });
    expect(alertCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain('/private/');
  });

  it('returns a safe form-stage diagnostic when the native course form rejects', async () => {
    const sourcePath = '/private/form-reject.m4a';
    const harness = createScriptableHarness({ fileContents: { [sourcePath]: 'audio bytes' } });
    let alertCount = 0;
    const result = await api.runScriptableRuntime({
      Alert: class {
        readonly index = alertCount++;
        addAction(_name: string) {}
        addCancelAction(_name: string) {}
        addTextField(_placeholder: string) {}
        presentAlert() {
          return Promise.reject(new Error('/private/form'));
        }
        presentSheet() {
          return Promise.resolve(this.index === 0 ? 0 : -1);
        }
      },
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => harness.fileManager },
      Script: { complete: () => undefined, setShortcutOutput: () => undefined },
      args: { fileURLs: [`file://${sourcePath}`], shortcutParameter: null },
    });

    expect(result).toEqual({
      ok: false,
      code: 'UNEXPECTED_ERROR',
      diagnostic: { build: '20260906-4', stage: 'U02' },
      message: '예상하지 못한 오류가 발생했습니다. 다시 시도해 주세요. [진단 20260906-4/U02]',
    });
    expect(JSON.stringify(result)).not.toContain('/private/');
  });

  it('shows the picker and course form in one runtime invocation with exact Scriptable copy', async () => {
    const sourcePath = '/private/runtime-course-form.m4a';
    const harness = createScriptableHarness({ fileContents: { [sourcePath]: 'audio bytes' } });
    const alerts = createScriptableRuntimeAlertHarness({
      pickerResult: 0,
      formResult: 0,
      formValues: ['  새 과목  ', '  김교수  '],
    });

    const result = await api.runScriptableRuntime({
      Alert: alerts.Alert,
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => harness.fileManager },
      UUID: { string: () => '33333333-3333-4333-8333-333333333333' },
      args: { fileURLs: [`file://${sourcePath}`], shortcutParameter: null },
    });

    expect(result).toMatchObject({
      ok: true,
      data: { jobId: '33333333-3333-4333-8333-333333333333' },
    });
    expect(alerts.calls.pickers).toEqual([
      {
        title: '',
        message: '',
        actions: ['＋ 과목 추가'],
        cancelActions: ['취소'],
        textFieldPlaceholders: [],
      },
    ]);
    expect(alerts.calls.forms).toEqual([
      {
        title: '새 과목 추가',
        message: '현재 강의와 함께 생성 요청을 보냅니다.',
        actions: ['추가하고 보내기'],
        cancelActions: ['취소'],
        textFieldPlaceholders: ['과목명', '교수 표시명 (선택)'],
      },
    ]);
    expect(harness.fs.snapshot().some((entry) => entry.path.startsWith('Inbox/'))).toBe(false);
    expect(harness.fs.snapshot().some((entry) => entry.path.startsWith('CourseInbox/'))).toBe(true);
  });

  it('keeps picker and form cancellation separate and creates no queue child', async () => {
    for (const alertOptions of [{ pickerResult: -1 }, { pickerResult: 0, formResult: -1 }]) {
      const sourcePath = '/private/runtime-course-cancel.m4a';
      const harness = createScriptableHarness({ fileContents: { [sourcePath]: 'audio bytes' } });
      const alerts = createScriptableRuntimeAlertHarness(alertOptions);

      const result = await api.runScriptableRuntime({
        Alert: alerts.Alert,
        Data: {
          fromBytes: (bytes: readonly number[]) => ({ bytes }),
          fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
        },
        FileManager: { iCloud: () => harness.fileManager },
        UUID: { string: () => '33333333-3333-4333-8333-333333333333' },
        args: { fileURLs: [`file://${sourcePath}`], shortcutParameter: null },
      });

      expect(result).toMatchObject({ ok: true, data: { cancelled: true } });
      expect(alerts.calls.pickers).toHaveLength(1);
      expect(alerts.calls.forms).toHaveLength(alertOptions.pickerResult === -1 ? 0 : 1);
      expect(harness.fs.snapshot().some((entry) => entry.path.startsWith('Inbox/'))).toBe(false);
      expect(harness.fs.snapshot().some((entry) => entry.path.startsWith('CourseInbox/'))).toBe(
        false,
      );
      expect(harness.fs.snapshot().some((entry) => entry.path.includes('/.reservation-'))).toBe(
        false,
      );
    }
  });

  it('awaits rejected runtime publication before completing without leaking its private error', async () => {
    let completes = 0;
    let outputs = 0;
    await expect(
      api.runScriptableRuntime({
        Script: {
          complete: () => {
            completes += 1;
            return Promise.resolve();
          },
          setShortcutOutput: () => {
            outputs += 1;
            return Promise.reject(new Error('/private/output'));
          },
        },
        args: { fileURLs: [], shortcutParameter: null },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'SHORTCUT_ONLY' });
    expect(outputs).toBe(1);
    expect(completes).toBe(1);
  });

  it('awaits rejected runtime completion without leaking its private error', async () => {
    let completes = 0;
    let outputs = 0;
    await expect(
      api.runScriptableRuntime({
        Script: {
          complete: () => {
            completes += 1;
            return Promise.reject(new Error('/private/complete'));
          },
          setShortcutOutput: () => {
            outputs += 1;
            return Promise.resolve();
          },
        },
        args: { fileURLs: [], shortcutParameter: null },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'SHORTCUT_ONLY' });
    expect(outputs).toBe(1);
    expect(completes).toBe(1);
  });

  it.each([
    ['bytes', 1],
    ['decimal kilobytes', 1000],
    ['binary kibibytes', 1024],
  ] as const)(
    'calibrates %s fileSize values for runtime catalog, source, copied source, and ready checks',
    async (_name, divisor) => {
      const jobId = '44444444-4444-4444-8444-444444444444';
      const harness = createScriptableHarness({
        fileContents: {
          '/private/runtime-lecture.m4a': 'runtime audio bytes',
          'Catalog/courses.json': JSON.stringify({
            protocolVersion: 1,
            generatedAt: '2026-09-03T14:30:15.123+09:00',
            courses: [{ id: '11111111-1111-4111-8111-111111111111', name: '운영체제' }],
          }),
        },
        uuidValues: [jobId],
      });
      const rawFileManager = {
        ...harness.fileManager,
        fileSize: (path: string) => byteSize(harness, path) / divisor,
      };

      await expect(
        api.runScriptableRuntime({
          Alert: SelectFirstCourseAlert,
          Data: {
            fromBytes: (bytes: readonly number[]) => ({ bytes }),
            fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
          },
          FileManager: { iCloud: () => rawFileManager },
          UUID: { string: () => jobId },
          args: { fileURLs: ['file:///private/runtime-lecture.m4a'], shortcutParameter: null },
        }),
      ).resolves.toMatchObject({ ok: true, data: { jobId } });
      expect(
        SourceBundleManifestV2Schema.parse(harness.fs.readJson(`Inbox/${jobId}/manifest.json`)),
      ).toMatchObject({ jobId, protocolVersion: 2 });
    },
  );

  it('supports Scriptable whole-kilobyte file sizes across enqueue and status', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const catalogValue = JSON.stringify({
      protocolVersion: 1,
      generatedAt: '2026-09-03T14:30:15.123+09:00',
      courses: [{ id: '11111111-1111-4111-8111-111111111111', name: '운영체제' }],
    });
    const catalogText = `${catalogValue}${' '.repeat(1536 - Buffer.byteLength(catalogValue))}`;
    const harness = createScriptableHarness({
      fileContents: {
        '/private/runtime-lecture.m4a': 'a'.repeat(1536),
        'Catalog/courses.json': catalogText,
      },
      uuidValues: [jobId],
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };
    const runtime = {
      Alert: SelectFirstCourseAlert,
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => rawFileManager },
      UUID: { string: () => jobId },
    };

    await expect(
      api.runScriptableRuntime({
        ...runtime,
        args: { fileURLs: ['file:///private/runtime-lecture.m4a'], shortcutParameter: null },
      }),
    ).resolves.toMatchObject({ ok: true, data: { jobId } });
    const receiptValue = JSON.stringify({
      jobId,
      courseId: '11111111-1111-4111-8111-111111111111',
      status: 'completed',
      displayMessage: '강의 자료 정리가 완료되었습니다.',
      updatedAt: '2026-09-03T14:30:15.123+09:00',
    });
    harness.fileManager.writeString(
      'Status/complete.json',
      `${receiptValue}${' '.repeat(1536 - Buffer.byteLength(receiptValue))}`,
    );
    await expect(
      api.runScriptableRuntime({
        ...runtime,
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { completed: 1, queued: 0, unreadableStatusFiles: 0 },
    });
  });

  it('accepts exact text limits when Scriptable reports whole-kilobyte buckets', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const catalogValue = JSON.stringify({
      protocolVersion: 1,
      generatedAt: '2026-09-03T14:30:15.123+09:00',
      courses: [{ id: '11111111-1111-4111-8111-111111111111', name: '운영체제' }],
    });
    const exactCatalog = `${catalogValue}${' '.repeat(256 * 1024 - Buffer.byteLength(catalogValue))}`;
    const harness = createScriptableHarness({
      fileContents: {
        '/private/runtime-lecture.m4a': 'a'.repeat(1536),
        'Catalog/courses.json': exactCatalog,
      },
      uuidValues: [jobId],
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };
    const runtime = {
      Alert: SelectFirstCourseAlert,
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => rawFileManager },
      UUID: { string: () => jobId },
    };

    await expect(
      api.runScriptableRuntime({
        ...runtime,
        args: { fileURLs: ['file:///private/runtime-lecture.m4a'], shortcutParameter: null },
      }),
    ).resolves.toMatchObject({ ok: true, data: { jobId } });

    const receiptValue = JSON.stringify({
      jobId,
      courseId: '11111111-1111-4111-8111-111111111111',
      status: 'completed',
      displayMessage: '강의 자료 정리가 완료되었습니다.',
      updatedAt: '2026-09-03T14:30:15.123+09:00',
    });
    harness.fileManager.writeString(
      'Status/limit.json',
      `${receiptValue}${' '.repeat(64 * 1024 - Buffer.byteLength(receiptValue))}`,
    );

    await expect(
      api.runScriptableRuntime({
        ...runtime,
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { completed: 1, queued: 0, unreadableStatusFiles: 0 },
    });
  });

  it('downloads an iCloud-only course catalog before enqueueing', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const catalogPath = 'Catalog/courses.json';
    const catalogValue = JSON.stringify({
      protocolVersion: 1,
      generatedAt: '2026-09-03T14:30:15.123+09:00',
      courses: [{ id: '11111111-1111-4111-8111-111111111111', name: '운영체제' }],
    });
    const harness = createScriptableHarness({
      existingDirectories: RESERVED_DIRECTORIES,
      fileContents: {
        [MARKER_PATH]: OWNER_MARKER,
        '/private/runtime-lecture.m4a': 'a'.repeat(1536),
        [catalogPath]: `${catalogValue}${' '.repeat(1536 - Buffer.byteLength(catalogValue))}`,
      },
      initiallyNotDownloaded: [catalogPath],
      uuidValues: [jobId],
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Alert: SelectFirstCourseAlert,
        Data: {
          fromBytes: (bytes: readonly number[]) => ({ bytes }),
          fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
        },
        FileManager: { iCloud: () => rawFileManager },
        UUID: { string: () => jobId },
        args: { fileURLs: ['file:///private/runtime-lecture.m4a'], shortcutParameter: null },
      }),
    ).resolves.toMatchObject({ ok: true, data: { jobId } });
    expect(harness.calls.downloads).toContain(catalogPath);
    expect(harness.fs.reads).toContain(catalogPath);
  });

  it('enqueues recorded audio delivered as a shortcutParameter file path', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const sourcePath = '/private/runtime-recording.m4a';
    const harness = createScriptableHarness({
      fileContents: {
        [sourcePath]: 'runtime audio bytes',
        'Catalog/courses.json': JSON.stringify({
          protocolVersion: 1,
          generatedAt: '2026-09-03T14:30:15.123+09:00',
          courses: [{ id: '11111111-1111-4111-8111-111111111111', name: '운영체제' }],
        }),
      },
      uuidValues: [jobId],
    });

    await expect(
      api.runScriptableRuntime({
        Alert: SelectFirstCourseAlert,
        Data: {
          fromBytes: (bytes: readonly number[]) => ({ bytes }),
          fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
        },
        FileManager: { iCloud: () => harness.fileManager },
        UUID: { string: () => jobId },
        args: { fileURLs: [], shortcutParameter: sourcePath },
      }),
    ).resolves.toMatchObject({ ok: true, action: 'enqueue', data: { jobId } });
    expect(
      SourceBundleManifestV2Schema.parse(harness.fs.readJson(`Inbox/${jobId}/manifest.json`)),
    ).toMatchObject({ jobId, protocolVersion: 2 });
  });

  it('enqueues recorded audio delivered as a shortcutParameter file URL string', async () => {
    const jobId = '66666666-6666-4666-8666-666666666666';
    const sourcePath = '/private/runtime recording.m4a';
    const harness = createScriptableHarness({
      fileContents: {
        [sourcePath]: 'runtime audio bytes',
        'Catalog/courses.json': JSON.stringify({
          protocolVersion: 1,
          generatedAt: '2026-09-03T14:30:15.123+09:00',
          courses: [{ id: '11111111-1111-4111-8111-111111111111', name: '운영체제' }],
        }),
      },
      uuidValues: [jobId],
    });

    await expect(
      api.runScriptableRuntime({
        Alert: SelectFirstCourseAlert,
        Data: {
          fromBytes: (bytes: readonly number[]) => ({ bytes }),
          fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
        },
        FileManager: { iCloud: () => harness.fileManager },
        UUID: { string: () => jobId },
        args: {
          fileURLs: [],
          shortcutParameter: 'file:///private/runtime%20recording.m4a',
        },
      }),
    ).resolves.toMatchObject({ ok: true, action: 'enqueue', data: { jobId } });
    expect(
      SourceBundleManifestV2Schema.parse(harness.fs.readJson(`Inbox/${jobId}/manifest.json`)),
    ).toMatchObject({ jobId, protocolVersion: 2 });
  });

  it('rejects a course catalog whose iCloud size token changes during download', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const catalogPath = 'Catalog/courses.json';
    const catalogValue = JSON.stringify({
      protocolVersion: 1,
      generatedAt: '2026-09-03T14:30:15.123+09:00',
      courses: [{ id: '11111111-1111-4111-8111-111111111111', name: '운영체제' }],
    });
    const harness = createScriptableHarness({
      existingDirectories: RESERVED_DIRECTORIES,
      fileContents: {
        [MARKER_PATH]: OWNER_MARKER,
        '/private/runtime-lecture.m4a': 'a'.repeat(1536),
        [catalogPath]: `${catalogValue}${' '.repeat(1536 - Buffer.byteLength(catalogValue))}`,
      },
      initiallyNotDownloaded: [catalogPath],
      remoteFileSizes: { [catalogPath]: 0 },
      uuidValues: [jobId],
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Data: {
          fromBytes: (bytes: readonly number[]) => ({ bytes }),
          fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
        },
        FileManager: { iCloud: () => rawFileManager },
        UUID: { string: () => jobId },
        args: { fileURLs: ['file:///private/runtime-lecture.m4a'], shortcutParameter: null },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'CATALOG_INVALID' });
  });

  it('does not treat a non-empty sub-kilobyte ready file as committed', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const harness = createScriptableHarness({
      existingDirectories: [...RESERVED_DIRECTORIES, `Inbox/${jobId}`],
      fileContents: {
        [MARKER_PATH]: OWNER_MARKER,
        ...readyInboxFiles(jobId, 'not empty'),
      },
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
        FileManager: { iCloud: () => rawFileManager },
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      }),
    ).resolves.toMatchObject({ ok: true, data: { queued: 0 } });
  });

  it('downloads and observes a valid iCloud-only ready marker', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const readyPath = `Inbox/${jobId}/ready`;
    const harness = createScriptableHarness({
      existingDirectories: [...RESERVED_DIRECTORIES, `Inbox/${jobId}`],
      fileContents: {
        [MARKER_PATH]: OWNER_MARKER,
        ...readyInboxFiles(jobId),
      },
      initiallyNotDownloaded: [readyPath],
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
        FileManager: { iCloud: () => rawFileManager },
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      }),
    ).resolves.toMatchObject({ ok: true, data: { queued: 1 } });
    expect(harness.calls.downloads).toContain(readyPath);
    expect(harness.fs.reads).toContain(readyPath);
  });

  it('does not download or read a whole-kilobyte ready marker that is already too large', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const readyPath = `Inbox/${jobId}/ready`;
    const harness = createScriptableHarness({
      existingDirectories: [...RESERVED_DIRECTORIES, `Inbox/${jobId}`],
      fileContents: {
        [MARKER_PATH]: OWNER_MARKER,
        ...readyInboxFiles(jobId, 'x'.repeat(2 * 1024)),
      },
      initiallyNotDownloaded: [readyPath],
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
        FileManager: { iCloud: () => rawFileManager },
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      }),
    ).resolves.toMatchObject({ ok: true, data: { queued: 0 } });
    expect(harness.calls.downloads).not.toContain(readyPath);
    expect(harness.fs.reads).not.toContain(readyPath);
  });

  it('does not download a ready marker whose remote size cannot be verified', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const readyPath = `Inbox/${jobId}/ready`;
    const harness = createScriptableHarness({
      existingDirectories: [...RESERVED_DIRECTORIES, `Inbox/${jobId}`],
      fileContents: {
        [MARKER_PATH]: OWNER_MARKER,
        ...readyInboxFiles(jobId),
      },
      fileSizeThrows: [readyPath],
      initiallyNotDownloaded: [readyPath],
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
        FileManager: { iCloud: () => rawFileManager },
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'STATUS_READ_PARTIAL' });
    expect(harness.calls.downloads).not.toContain(readyPath);
    expect(harness.fs.reads).not.toContain(readyPath);
  });

  it.each([1, 2, 3])(
    'does not commit a ready file changed after whole-kilobyte read %i',
    async (mutationRead) => {
      const jobId = '44444444-4444-4444-8444-444444444444';
      let readyReads = 0;
      const harness = createScriptableHarness({
        afterReadyRead: (path) => {
          readyReads += 1;
          if (readyReads === mutationRead)
            harness.fileManager.writeString(path, 'changed after read');
        },
        existingDirectories: [...RESERVED_DIRECTORIES, `Inbox/${jobId}`],
        fileContents: {
          [MARKER_PATH]: OWNER_MARKER,
          ...readyInboxFiles(jobId),
        },
      });
      const rawFileManager = {
        ...harness.fileManager,
        fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
      };

      await expect(
        api.runScriptableRuntime({
          Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
          FileManager: { iCloud: () => rawFileManager },
          args: { fileURLs: [], shortcutParameter: { action: 'status' } },
        }),
      ).resolves.toMatchObject({ ok: true, data: { queued: 0 } });
    },
  );

  it.each([
    ['too large', 'x'.repeat(65 * 1024), false],
    ['unknown-sized', '{}', true],
  ] as const)(
    'does not download an iCloud-only %s status receipt',
    async (_description, contents, sizeThrows) => {
      const receiptPath = 'Status/remote.json';
      const harness = createScriptableHarness({
        existingDirectories: RESERVED_DIRECTORIES,
        fileContents: {
          [MARKER_PATH]: OWNER_MARKER,
          [receiptPath]: contents,
        },
        fileSizeThrows: sizeThrows ? [receiptPath] : [],
        initiallyNotDownloaded: [receiptPath],
      });
      const rawFileManager = {
        ...harness.fileManager,
        fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
      };

      await expect(
        api.runScriptableRuntime({
          Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
          FileManager: { iCloud: () => rawFileManager },
          args: { fileURLs: [], shortcutParameter: { action: 'status' } },
        }),
      ).resolves.toMatchObject({
        ok: true,
        data: { completed: 0, unreadableStatusFiles: 1 },
      });
      expect(harness.calls.downloads).not.toContain(receiptPath);
      expect(harness.fs.reads).not.toContain(receiptPath);
    },
  );

  it('downloads and reads a valid iCloud-only status receipt', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const receiptPath = 'Status/remote.json';
    const receiptValue = JSON.stringify({
      jobId,
      courseId: '11111111-1111-4111-8111-111111111111',
      status: 'completed',
      displayMessage: '강의 자료 정리가 완료되었습니다.',
      updatedAt: '2026-09-03T14:30:15.123+09:00',
    });
    const harness = createScriptableHarness({
      existingDirectories: RESERVED_DIRECTORIES,
      fileContents: {
        [MARKER_PATH]: OWNER_MARKER,
        [receiptPath]: `${receiptValue}${' '.repeat(1536 - Buffer.byteLength(receiptValue))}`,
      },
      initiallyNotDownloaded: [receiptPath],
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
        FileManager: { iCloud: () => rawFileManager },
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { completed: 1, unreadableStatusFiles: 0 },
    });
    expect(harness.calls.downloads).toContain(receiptPath);
    expect(harness.fs.reads).toContain(receiptPath);
  });

  it('rejects a status receipt whose iCloud size token changes during download', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const receiptPath = 'Status/remote.json';
    const receiptValue = JSON.stringify({
      jobId,
      courseId: '11111111-1111-4111-8111-111111111111',
      status: 'completed',
      displayMessage: '강의 자료 정리가 완료되었습니다.',
      updatedAt: '2026-09-03T14:30:15.123+09:00',
    });
    const harness = createScriptableHarness({
      existingDirectories: RESERVED_DIRECTORIES,
      fileContents: {
        [MARKER_PATH]: OWNER_MARKER,
        [receiptPath]: `${receiptValue}${' '.repeat(1536 - Buffer.byteLength(receiptValue))}`,
      },
      initiallyNotDownloaded: [receiptPath],
      remoteFileSizes: { [receiptPath]: 0 },
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
        FileManager: { iCloud: () => rawFileManager },
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { completed: 0, unreadableStatusFiles: 1 },
    });
  });

  it('rejects a whole-kilobyte status receipt changed while it is read', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const receiptPath = 'Status/receipt.json';
    const harness = createScriptableHarness({
      afterStatusRead: (path) => harness.fileManager.writeString(path, '{}'),
      existingDirectories: RESERVED_DIRECTORIES,
      fileContents: {
        [MARKER_PATH]: OWNER_MARKER,
        [receiptPath]: JSON.stringify({
          jobId,
          courseId: '11111111-1111-4111-8111-111111111111',
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: '2026-09-03T14:30:15.123+09:00',
        }),
      },
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
        FileManager: { iCloud: () => rawFileManager },
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { completed: 0, unreadableStatusFiles: 1 },
    });
  });

  it('rejects a whole-kilobyte catalog changed during the refreshed read', async () => {
    const selectedCourseId = '11111111-1111-4111-8111-111111111111';
    const otherCourseId = '22222222-2222-4222-8222-222222222222';
    const originalCatalog = JSON.stringify({
      protocolVersion: 1,
      generatedAt: '2026-09-03T14:30:15.123+09:00',
      courses: [
        { id: selectedCourseId, name: '운영체제' },
        { id: otherCourseId, name: '자료구조' },
      ],
    });
    const harness = createScriptableHarness({
      afterCatalogRead: (path) => {
        harness.fileManager.writeString(
          path,
          JSON.stringify({
            protocolVersion: 1,
            generatedAt: '2026-09-03T14:30:15.123+09:00',
            courses: [
              { id: selectedCourseId, name: '운영체제 변경됨' },
              { id: otherCourseId, name: '자료구조 변경됨' },
            ],
          }),
        );
      },
      chooseCourseResult: 0,
      fileContents: {
        '/private/runtime-lecture.m4a': 'a'.repeat(1536),
        'Catalog/courses.json': originalCatalog,
      },
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Data: {
          fromBytes: (bytes: readonly number[]) => ({ bytes }),
          fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
        },
        FileManager: { iCloud: () => rawFileManager },
        UUID: { string: () => '44444444-4444-4444-8444-444444444444' },
        args: { fileURLs: ['file:///private/runtime-lecture.m4a'], shortcutParameter: null },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'CATALOG_INVALID' });
  });

  it.each([Number.NaN, -1])(
    'rejects an invalid whole-kilobyte receipt UTF-8 length (%s)',
    async (invalidLength) => {
      const jobId = '44444444-4444-4444-8444-444444444444';
      const harness = createScriptableHarness({
        existingDirectories: RESERVED_DIRECTORIES,
        fileContents: {
          [MARKER_PATH]: OWNER_MARKER,
          'Status/complete.json': JSON.stringify({
            jobId,
            courseId: '11111111-1111-4111-8111-111111111111',
            status: 'completed',
            displayMessage: '강의 자료 정리가 완료되었습니다.',
            updatedAt: '2026-09-03T14:30:15.123+09:00',
          }),
        },
      });
      const rawFileManager = {
        ...harness.fileManager,
        fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
      };

      await expect(
        api.runScriptableRuntime({
          Data: {
            fromString: (text: string) => ({
              getBytes: () =>
                text === OWNER_MARKER ? Buffer.from(text, 'utf8') : { length: invalidLength },
            }),
          },
          FileManager: { iCloud: () => rawFileManager },
          args: { fileURLs: [], shortcutParameter: { action: 'status' } },
        }),
      ).resolves.toMatchObject({
        ok: true,
        data: { completed: 0, unreadableStatusFiles: 1 },
      });
    },
  );

  it('rejects a negative whole-kilobyte catalog UTF-8 length', async () => {
    const harness = createScriptableHarness({
      fileContents: {
        '/private/runtime-lecture.m4a': 'runtime audio bytes',
        'Catalog/courses.json': JSON.stringify({
          protocolVersion: 1,
          generatedAt: '2026-09-03T14:30:15.123+09:00',
          courses: [{ id: '11111111-1111-4111-8111-111111111111', name: '운영체제' }],
        }),
      },
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.floor(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Data: {
          fromBytes: (bytes: readonly number[]) => ({ bytes }),
          fromString: (text: string) => ({
            getBytes: () => (text === OWNER_MARKER ? Buffer.from(text, 'utf8') : { length: -1 }),
          }),
        },
        FileManager: { iCloud: () => rawFileManager },
        UUID: { string: () => '44444444-4444-4444-8444-444444444444' },
        args: { fileURLs: ['file:///private/runtime-lecture.m4a'], shortcutParameter: null },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'CATALOG_INVALID' });
  });

  it.each([1000, 1024] as const)(
    'calibrates documented runtime receipt bounds for divisor %i',
    async (divisor) => {
      const harness = createScriptableHarness();
      const rawFileManager = {
        ...harness.fileManager,
        fileSize: (path: string) => byteSize(harness, path) / divisor,
      };
      const runtime = {
        Data: { fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
        FileManager: { iCloud: () => rawFileManager },
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      };
      await expect(api.runScriptableRuntime(runtime)).resolves.toMatchObject({ ok: true });
      harness.fileManager.writeString(
        'Status/receipt.json',
        JSON.stringify({
          jobId: '22222222-2222-4222-8222-222222222222',
          courseId: '11111111-1111-4111-8111-111111111111',
          status: 'completed',
          displayMessage: '강의 자료 정리가 완료되었습니다.',
          updatedAt: '2026-09-03T14:30:15.123+09:00',
        }),
      );
      await expect(api.runScriptableRuntime(runtime)).resolves.toMatchObject({
        ok: true,
        data: { completed: 1, unreadableStatusFiles: 0 },
      });
    },
  );

  it('fails closed without creating a job when runtime fileSize calibration is rounded or invalid', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const harness = createScriptableHarness({
      fileContents: {
        '/private/runtime-lecture.m4a': 'runtime audio bytes',
        'Catalog/courses.json': JSON.stringify({
          protocolVersion: 1,
          generatedAt: '2026-09-03T14:30:15.123+09:00',
          courses: [{ id: '11111111-1111-4111-8111-811111111111', name: '운영체제' }],
        }),
      },
      uuidValues: [jobId],
    });
    const roundedFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => Math.ceil(byteSize(harness, path) / 1024),
    };

    await expect(
      api.runScriptableRuntime({
        Data: {
          fromBytes: (bytes: readonly number[]) => ({ bytes }),
          fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
        },
        FileManager: { iCloud: () => roundedFileManager },
        UUID: { string: () => jobId },
        args: { fileURLs: ['file:///private/runtime-lecture.m4a'], shortcutParameter: null },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'QUEUE_ROOT_CONFLICT',
      diagnostic: { build: '20260905-2', observedFileSize: 1, stage: 'R16' },
      message:
        'Scriptable 폴더에 같은 이름의 기존 데이터가 있어 자동 설정을 중단했습니다. [진단 20260905-2/R16/1]',
    });
    expect(harness.fs.snapshot().some((entry) => entry.path.startsWith(`Inbox/${jobId}`))).toBe(
      false,
    );
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'fails closed without creating a job for invalid runtime owner-marker observations (%s)',
    async (invalidSize) => {
      const jobId = '44444444-4444-4444-8444-444444444444';
      const harness = createScriptableHarness({
        fileContents: {
          '/private/runtime-lecture.m4a': 'runtime audio bytes',
          'Catalog/courses.json': JSON.stringify({
            protocolVersion: 1,
            generatedAt: '2026-09-03T14:30:15.123+09:00',
            courses: [{ id: '11111111-1111-4111-8111-811111111111', name: '운영체제' }],
          }),
        },
      });
      const invalidFileManager = { ...harness.fileManager, fileSize: () => invalidSize };

      await expect(
        api.runScriptableRuntime({
          Data: {
            fromBytes: (bytes: readonly number[]) => ({ bytes }),
            fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
          },
          FileManager: { iCloud: () => invalidFileManager },
          UUID: { string: () => jobId },
          args: { fileURLs: ['file:///private/runtime-lecture.m4a'], shortcutParameter: null },
        }),
      ).resolves.toMatchObject({ ok: false, code: 'QUEUE_ROOT_CONFLICT' });
      expect(harness.fs.snapshot().some((entry) => entry.path.startsWith(`Inbox/${jobId}`))).toBe(
        false,
      );
    },
  );

  it('preserves exact runtime-normalized catalog, source, and status byte limits', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const catalogValue = JSON.stringify({
      protocolVersion: 1,
      generatedAt: '2026-09-03T14:30:15.123+09:00',
      courses: [{ id: '11111111-1111-4111-8111-811111111111', name: '운영체제' }],
    });
    const exactCatalog = `${catalogValue}${' '.repeat(256 * 1024 - Buffer.byteLength(catalogValue))}`;
    const harness = createScriptableHarness({
      fileContents: {
        '/private/runtime-limit.m4a': 'small observable source',
        'Catalog/courses.json': exactCatalog,
      },
      fileSizes: { 'private/runtime-limit.m4a': 4 * 1024 ** 3 },
      uuidValues: [jobId],
    });
    const rawFileManager = {
      ...harness.fileManager,
      fileSize: (path: string) => byteSize(harness, path) / 1000,
    };
    const runtime = {
      Alert: SelectFirstCourseAlert,
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => rawFileManager },
      UUID: { string: () => jobId },
      args: { fileURLs: ['file:///private/runtime-limit.m4a'], shortcutParameter: null },
    };

    await expect(api.runScriptableRuntime(runtime)).resolves.toMatchObject({ ok: true });
    const receiptValue = JSON.stringify({
      jobId,
      courseId: '11111111-1111-4111-8111-811111111111',
      status: 'completed',
      displayMessage: '강의 자료 정리가 완료되었습니다.',
      updatedAt: '2026-09-03T14:30:15.123+09:00',
    });
    harness.fileManager.writeString(
      'Status/limit.json',
      `${receiptValue}${' '.repeat(64 * 1024 - Buffer.byteLength(receiptValue))}`,
    );
    await expect(
      api.runScriptableRuntime({
        ...runtime,
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { completed: 1, unreadableStatusFiles: 0 },
    });
  });

  it('uses the exact raw FileManager receiver for calibrated runtime status and enqueue', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    const harness = createScriptableHarness({
      fileContents: {
        '/private/receiver-lecture.m4a': 'receiver-safe audio bytes',
        'Catalog/courses.json': JSON.stringify({
          protocolVersion: 1,
          generatedAt: '2026-09-03T14:30:15.123+09:00',
          courses: [{ id: '11111111-1111-4111-8111-811111111111', name: '운영체제' }],
        }),
      },
      uuidValues: [jobId],
    });
    const rawFileManager = receiverBrandedFileManager(harness, 1024);
    const runtime = {
      Alert: SelectFirstCourseAlert,
      Data: {
        fromBytes: (bytes: readonly number[]) => ({ bytes }),
        fromString: (text: string) => ({ getBytes: () => Buffer.from(text, 'utf8') }),
      },
      FileManager: { iCloud: () => rawFileManager },
      UUID: { string: () => jobId },
    };

    await expect(
      api.runScriptableRuntime({
        ...runtime,
        args: { fileURLs: [], shortcutParameter: { action: 'status' } },
      }),
    ).resolves.toMatchObject({ ok: true, action: 'status' });
    await expect(
      api.runScriptableRuntime({
        ...runtime,
        args: { fileURLs: ['file:///private/receiver-lecture.m4a'], shortcutParameter: null },
      }),
    ).resolves.toMatchObject({ ok: true, data: { jobId } });
  });
});
