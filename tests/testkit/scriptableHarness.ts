import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type ScriptableInvocationInput = Readonly<{
  fileURLs: readonly string[];
  shortcutParameter: unknown;
}>;

export type StudyAssistantApi = Readonly<{
  createStudyAssistant: (dependencies: Readonly<Record<string, unknown>>) => Readonly<{
    failedReceiptMessages: Readonly<Record<string, string>>;
    run: (input: ScriptableInvocationInput) => Promise<unknown>;
    validateSource: (value: Readonly<{ fileName: string; sizeBytes: number }>) => unknown;
  }>;
  mediaTypeForExtension: (extension: string) => string | null;
  parseInvocation: (input: ScriptableInvocationInput) => unknown;
  runScriptableRuntime: (globals: Readonly<Record<string, unknown>>) => Promise<unknown>;
  safeDisplayFileName: (fileName: string, extension: string, jobId: string) => string;
  selectCourse: (
    dependencies: Readonly<Record<string, unknown>>,
    choices: readonly Readonly<{
      course: Readonly<{ id: string; name: string; professorName?: string }>;
      kind: 'catalog' | 'pending';
      label: string;
    }>[],
    unavailableIds?: readonly string[],
  ) => Promise<unknown>;
  validateCourseCatalog: (value: unknown) => unknown;
  validateCourseInboxRequest: (value: unknown) => unknown;
  validateCourseProvisioningInput: (value: unknown) => unknown;
  validateStatusReceipt: (value: unknown) => unknown;
}>;

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...values: unknown[]) => Promise<unknown>;
// Scriptable wraps scripts in an async host function, so its distributable can use top-level await.
// Evaluate that trusted artifact through the same boundary instead of treating it as CommonJS.
const scriptableModule = { exports: {} as unknown };
const studyAssistantUrl = new URL('../../mobile/scriptable/StudyAssistant.js', import.meta.url);
const evaluateStudyAssistant = new AsyncFunction(
  'module',
  `${readFileSync(
    studyAssistantUrl,
    'utf8',
  )}\nreturn module.exports;\n//# sourceURL=${studyAssistantUrl.href}`,
);
const studyAssistantApi = (await evaluateStudyAssistant(scriptableModule)) as StudyAssistantApi;

type ScriptableEntry = Readonly<{
  contents?: string;
  kind: 'directory' | 'file';
}>;

type HarnessOptions = Readonly<{
  afterCatalogRead?: (path: string, text: string) => void;
  afterCourseInboxList?: (path: string, entries: readonly string[]) => void;
  afterCourseReadyRead?: (path: string, text: string) => void;
  afterCourseRequestRead?: (path: string, text: string) => void;
  afterLeaseCopy?: (path: string) => void;
  afterMove?: (sourcePath: string, targetPath: string) => void;
  afterReadyWrite?: (path: string) => void;
  afterReadyRead?: (path: string, text: string) => void;
  afterSourceCopy?: (sourcePath: string, targetPath: string) => void;
  afterStatusRead?: (path: string, text: string) => void;
  afterUuid?: (value: string, index: number) => void;
  chooseCourse?: (names: readonly string[]) => number | null | Promise<number | null>;
  chooseCourseResult?: number | null;
  promptCourse?: () =>
    | Readonly<{ name: string; professorName: string }>
    | null
    | Promise<Readonly<{ name: string; professorName: string }> | null>;
  promptCourseResult?: Readonly<{ name: string; professorName: string }> | null;
  existingDirectories?: readonly string[];
  existingFiles?: readonly string[];
  fileContents?: Readonly<Record<string, string>>;
  fileSizeThrows?: readonly string[];
  fileSizes?: Readonly<Record<string, number>>;
  fixedClock?: string;
  failAt?: 'copy' | 'jobMkdir' | 'manifest' | 'move' | 'ready' | 'request' | 'sourceCopy';
  failSourceCopyAt?: number;
  failJobId?: string;
  initiallyNotDownloaded?: readonly string[];
  listContentsThrows?: readonly string[];
  listContentsValues?: Readonly<Record<string, readonly string[]>>;
  moveCreatesThenThrows?: boolean;
  omitFileSize?: boolean;
  readyCreatesThenThrows?: boolean;
  readStringThrows?: readonly string[];
  remoteFileSizes?: Readonly<Record<string, number>>;
  uuidValues?: readonly string[];
}>;

const ROOT = '/documents';

const normalizeRelativePath = (path: string): string =>
  path.replace(/^\/documents\/?/u, '').replace(/^\/+|\/+$/gu, '');

const scriptableFileName = (path: string, includeFileExtension = false): string => {
  const name = path.replace(/\\/gu, '/').split('/').at(-1) ?? '';
  if (includeFileExtension) return name;
  const extensionIndex = name.lastIndexOf('.');
  return extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
};

const snapshotEntries = (entries: ReadonlyMap<string, ScriptableEntry>) =>
  Object.freeze(
    [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, entry]) =>
        Object.freeze({
          contents: entry.kind === 'file' ? (entry.contents ?? '') : undefined,
          kind: entry.kind,
          path,
        }),
      ),
  );

export const loadStudyAssistant = (): StudyAssistantApi => studyAssistantApi;

export const createScriptableHarness = (options: HarnessOptions = {}) => {
  let uuidIndex = 0;
  let sourceCopyIndex = 0;
  const operations: string[] = [];
  const reads: string[] = [];
  const downloads: string[] = [];
  const notDownloaded = new Set(
    (options.initiallyNotDownloaded ?? []).map((path) => normalizeRelativePath(path)),
  );
  const observedSizes = new Map(
    Object.entries(options.fileSizes ?? {}).map(([path, size]) => [
      normalizeRelativePath(path),
      size,
    ]),
  );
  const remoteSizes = new Map(
    Object.entries(options.remoteFileSizes ?? {}).map(([path, size]) => [
      normalizeRelativePath(path),
      size,
    ]),
  );
  const courseChoices: (readonly string[])[] = [];
  const coursePrompts: Readonly<Record<string, never>>[] = [];
  const joinedPaths: string[] = [];
  const shortcutOutputs: unknown[] = [];
  const entries = new Map<string, ScriptableEntry>();
  const modificationDates = new Map<string, number>();
  let modificationTick = 1;
  for (const directory of options.existingDirectories ?? []) {
    entries.set(normalizeRelativePath(directory), Object.freeze({ kind: 'directory' }));
  }
  for (const file of options.existingFiles ?? []) {
    entries.set(
      normalizeRelativePath(file),
      Object.freeze({ contents: options.fileContents?.[file] ?? '', kind: 'file' }),
    );
  }
  for (const [file, contents] of Object.entries(options.fileContents ?? {})) {
    entries.set(normalizeRelativePath(file), Object.freeze({ contents, kind: 'file' }));
  }
  for (const path of entries.keys()) {
    modificationDates.set(path, modificationTick);
    modificationTick += 1;
  }
  const touch = (path: string) => {
    modificationDates.set(path, modificationTick);
    modificationTick += 1;
  };

  const fileManager = Object.freeze({
    copy: (sourcePath: string, targetPath: string) => {
      if (options.failAt === 'copy') throw new Error('COPY_FAILED');
      const source = entries.get(normalizeRelativePath(sourcePath));
      if (source?.kind !== 'file') throw new Error('SOURCE_NOT_FOUND');
      const relativeTarget = normalizeRelativePath(targetPath);
      if (relativeTarget.includes('/sources/')) {
        const copyIndex = sourceCopyIndex;
        sourceCopyIndex += 1;
        if (options.failAt === 'sourceCopy' && copyIndex === (options.failSourceCopyAt ?? 0)) {
          throw new Error('SOURCE_COPY_FAILED');
        }
      }
      if (entries.has(relativeTarget)) throw new Error('DESTINATION_EXISTS');
      entries.set(relativeTarget, Object.freeze({ contents: source.contents ?? '', kind: 'file' }));
      touch(relativeTarget);
      if (observedSizes.has(normalizeRelativePath(sourcePath))) {
        observedSizes.set(
          relativeTarget,
          observedSizes.get(normalizeRelativePath(sourcePath)) ?? 0,
        );
      }
      operations.push(`copy:${relativeTarget.split('/').at(-1)}`);
      if (relativeTarget.startsWith('Rejected/.reservation-'))
        options.afterLeaseCopy?.(relativeTarget);
      if (
        (relativeTarget.startsWith('Inbox/') || relativeTarget.startsWith('CourseInbox/')) &&
        relativeTarget.includes('/sources/')
      ) {
        options.afterSourceCopy?.(normalizeRelativePath(sourcePath), relativeTarget);
      }
    },
    createDirectory: (path: string) => {
      const relativePath = normalizeRelativePath(path);
      if (
        options.failAt === 'jobMkdir' &&
        (relativePath ===
          `Inbox/.upload-${options.failJobId ?? '22222222-2222-4222-8222-222222222222'}` ||
          relativePath ===
            `CourseInbox/.upload-${options.failJobId ?? '22222222-2222-4222-8222-222222222222'}`)
      ) {
        throw new Error('MKDIR_FAILED');
      }
      entries.set(relativePath, Object.freeze({ kind: 'directory' }));
      touch(relativePath);
      operations.push(`mkdir:${relativePath}`);
    },
    documentsDirectory: () => ROOT,
    fileExists: (path: string) => entries.has(normalizeRelativePath(path)),
    ...(options.omitFileSize
      ? {}
      : {
          fileSize: (path: string) => {
            const relativePath = normalizeRelativePath(path);
            if ((options.fileSizeThrows ?? []).includes(relativePath)) {
              throw new Error('FILE_SIZE_FAILED');
            }
            const entry = entries.get(relativePath);
            if (entry?.kind !== 'file') throw new Error('FILE_NOT_FOUND');
            if (notDownloaded.has(relativePath) && remoteSizes.has(relativePath)) {
              return remoteSizes.get(relativePath) ?? 0;
            }
            return (
              observedSizes.get(relativePath) ?? Buffer.byteLength(entry.contents ?? '', 'utf8')
            );
          },
        }),
    isDirectory: (path: string) => entries.get(normalizeRelativePath(path))?.kind === 'directory',
    isFileDownloaded: (path: string) => !notDownloaded.has(normalizeRelativePath(path)),
    joinPath: (parentPath: string, childPath: string) => {
      const path = `${parentPath.replace(/\/$/u, '')}/${childPath}`;
      joinedPaths.push(path);
      return path;
    },
    listContents: (path: string) => {
      const relativePath = normalizeRelativePath(path);
      if ((options.listContentsThrows ?? []).includes(relativePath)) {
        throw new Error('LIST_CONTENTS_FAILED');
      }
      if (options.listContentsValues?.[relativePath]) {
        const listed = [...(options.listContentsValues[relativePath] ?? [])];
        if (relativePath === 'CourseInbox') options.afterCourseInboxList?.(relativePath, listed);
        return listed;
      }
      if (entries.get(relativePath)?.kind !== 'directory') throw new Error('NOT_A_DIRECTORY');
      const prefix = relativePath.length === 0 ? '' : `${relativePath}/`;
      const listed = [...entries.keys()]
        .filter((entryPath) => {
          if (!entryPath.startsWith(prefix)) return false;
          return entryPath.slice(prefix.length).indexOf('/') === -1;
        })
        .map((entryPath) => entryPath.slice(prefix.length));
      if (relativePath === 'CourseInbox') options.afterCourseInboxList?.(relativePath, listed);
      return listed;
    },
    modificationDate: (path: string) => {
      const relativePath = normalizeRelativePath(path);
      if (!entries.has(relativePath)) return null;
      return new Date(modificationDates.get(relativePath) ?? 0);
    },
    move: (sourcePath: string, targetPath: string) => {
      const relativeSource = normalizeRelativePath(sourcePath);
      const relativeTarget = normalizeRelativePath(targetPath);
      if (options.failAt === 'move') throw new Error('MOVE_FAILED');
      if (entries.get(relativeSource)?.kind !== 'directory') throw new Error('SOURCE_NOT_FOUND');
      if (entries.has(relativeTarget)) throw new Error('DESTINATION_EXISTS');
      const movedEntries = [...entries.entries()]
        .filter(([path]) => path === relativeSource || path.startsWith(`${relativeSource}/`))
        .map(
          ([path, entry]) =>
            [
              `${relativeTarget}${path.slice(relativeSource.length)}`,
              entry,
              observedSizes.get(path),
              modificationDates.get(path),
              path,
            ] as const,
        );
      for (const [, , , , path] of movedEntries) {
        entries.delete(path);
        observedSizes.delete(path);
        modificationDates.delete(path);
      }
      for (const [path, entry, size, modificationDate] of movedEntries) {
        entries.set(path, entry);
        if (size !== undefined) observedSizes.set(path, size);
        if (modificationDate !== undefined) modificationDates.set(path, modificationDate);
      }
      operations.push(`move:${relativeSource}->${relativeTarget}`);
      options.afterMove?.(relativeSource, relativeTarget);
      if (options.moveCreatesThenThrows) throw new Error('MOVE_LATE_FAILURE');
    },
    readString: (path: string) => {
      const relativePath = normalizeRelativePath(path);
      reads.push(relativePath);
      if ((options.readStringThrows ?? []).includes(relativePath)) {
        throw new Error('TEXT_DECODE_FAILED');
      }
      if (notDownloaded.has(relativePath)) throw new Error('FILE_NOT_DOWNLOADED');
      const entry = entries.get(relativePath);
      if (entry?.kind !== 'file') throw new Error('FILE_NOT_FOUND');
      const text = entry.contents ?? '';
      if (relativePath === 'Catalog/courses.json') options.afterCatalogRead?.(relativePath, text);
      if (relativePath.startsWith('CourseInbox/') && relativePath.endsWith('/request.json'))
        options.afterCourseRequestRead?.(relativePath, text);
      if (relativePath.startsWith('CourseInbox/') && relativePath.endsWith('/ready'))
        options.afterCourseReadyRead?.(relativePath, text);
      if (relativePath.startsWith('Inbox/') && relativePath.endsWith('/ready'))
        options.afterReadyRead?.(relativePath, text);
      if (relativePath.startsWith('Status/')) options.afterStatusRead?.(relativePath, text);
      return text;
    },
    remove: (path: string) => {
      const relativePath = normalizeRelativePath(path);
      for (const existingPath of [...entries.keys()]) {
        if (existingPath === relativePath || existingPath.startsWith(`${relativePath}/`)) {
          entries.delete(existingPath);
          observedSizes.delete(existingPath);
          modificationDates.delete(existingPath);
        }
      }
      operations.push(`remove:${relativePath}`);
    },
    downloadFileFromiCloud: async (path: string) => {
      const relativePath = normalizeRelativePath(path);
      downloads.push(relativePath);
      notDownloaded.delete(relativePath);
    },
    fileName: (path: string, includeFileExtension = false) =>
      scriptableFileName(normalizeRelativePath(path), includeFileExtension),
    write: (path: string, data: Readonly<{ bytes: readonly number[] }>) => {
      const relativePath = normalizeRelativePath(path);
      if (options.failAt === 'ready' && relativePath.split('/').at(-1) === 'ready') {
        throw new Error('READY_FAILED');
      }
      entries.set(
        relativePath,
        Object.freeze({ contents: String.fromCharCode(...data.bytes), kind: 'file' }),
      );
      touch(relativePath);
      observedSizes.delete(relativePath);
      operations.push(`write:${relativePath.split('/').at(-1)}:${data.bytes.length}`);
      if (relativePath.split('/').at(-1) === 'ready') options.afterReadyWrite?.(relativePath);
      if (options.readyCreatesThenThrows && relativePath.split('/').at(-1) === 'ready') {
        throw new Error('READY_LATE_FAILURE');
      }
    },
    writeString: (path: string, contents: string) => {
      const relativePath = normalizeRelativePath(path);
      if (options.failAt === 'manifest' && relativePath.split('/').at(-1) === 'manifest.json') {
        throw new Error('MANIFEST_FAILED');
      }
      if (options.failAt === 'request' && relativePath.split('/').at(-1) === 'request.json') {
        throw new Error('REQUEST_FAILED');
      }
      entries.set(relativePath, Object.freeze({ contents, kind: 'file' }));
      touch(relativePath);
      observedSizes.delete(relativePath);
      operations.push(`write:${relativePath.split('/').at(-1)}`);
    },
  });
  const calls = Object.freeze({
    get courseChoices(): readonly (readonly string[])[] {
      return Object.freeze(courseChoices.map((names) => Object.freeze([...names])));
    },
    get coursePrompts(): readonly Readonly<Record<string, never>>[] {
      return Object.freeze(coursePrompts.map((prompt) => Object.freeze({ ...prompt })));
    },
    get shortcutOutputs(): readonly unknown[] {
      return Object.freeze([...shortcutOutputs]);
    },
    get downloads(): readonly string[] {
      return Object.freeze([...downloads]);
    },
    get joinedPaths(): readonly string[] {
      return Object.freeze([...joinedPaths]);
    },
  });
  const fs = Object.freeze({
    existingFiles: Object.freeze([...(options.existingFiles ?? [])]),
    get initialSnapshot(): ReturnType<typeof snapshotEntries> {
      return initialSnapshot;
    },
    get operations(): readonly string[] {
      return Object.freeze([...operations]);
    },
    get reads(): readonly string[] {
      return Object.freeze([...reads]);
    },
    readText: (path: string): string => {
      const entry = entries.get(normalizeRelativePath(path));
      if (entry?.kind !== 'file') throw new Error('FILE_NOT_FOUND');
      return entry.contents ?? '';
    },
    readJson: (path: string): unknown => JSON.parse(fs.readText(path)),
    list: (path: string): readonly string[] =>
      Object.freeze([...fileManager.listContents(path)].sort()),
    snapshot: (): ReturnType<typeof snapshotEntries> => snapshotEntries(entries),
  });
  const initialSnapshot = snapshotEntries(entries);
  const assistant = loadStudyAssistant().createStudyAssistant(
    Object.freeze({
      chooseCourse: async (names: readonly string[]) => {
        courseChoices.push(Object.freeze([...names]));
        if (options.chooseCourse) return options.chooseCourse(Object.freeze([...names]));
        return options.chooseCourseResult ?? 0;
      },
      clock: () => options.fixedClock ?? timestamp,
      dataFromBytes: (bytes: readonly number[]) =>
        Object.freeze({ bytes: Object.freeze([...bytes]) }),
      dataFromString: (text: string) =>
        Object.freeze({ getBytes: () => Object.freeze([...Buffer.from(text, 'utf8')]) }),
      fileManager,
      promptCourse: async () => {
        coursePrompts.push(Object.freeze({}));
        if (options.promptCourse) return options.promptCourse();
        return options.promptCourseResult ?? null;
      },
      uuid: () => {
        const index = uuidIndex;
        const value = options.uuidValues?.[uuidIndex++] ?? '44444444-4444-4444-8444-444444444444';
        options.afterUuid?.(value, index);
        return value;
      },
    }),
  );

  return Object.freeze({
    assistant,
    calls,
    fileManager,
    fs,
    run: (input: ScriptableInvocationInput) => assistant.run(input),
    runStatus: () => assistant.run({ fileURLs: [], shortcutParameter: { action: 'status' } }),
  });
};

const timestamp = '2026-09-03T14:30:15.123+09:00';

const nativePath = (path: string): string =>
  process.platform === 'win32' && /^\/[A-Za-z]:\//u.test(path) ? path.slice(1) : path;

export const createFilesystemScriptableHarness = (
  root: string,
  options: Pick<
    HarnessOptions,
    | 'chooseCourse'
    | 'chooseCourseResult'
    | 'fixedClock'
    | 'promptCourse'
    | 'promptCourseResult'
    | 'uuidValues'
  > = {},
) => {
  let uuidIndex = 0;
  const courseChoices: (readonly string[])[] = [];
  const coursePrompts: Readonly<Record<string, never>>[] = [];
  const fileManager = Object.freeze({
    copy: (sourcePath: string, targetPath: string) =>
      copyFileSync(nativePath(sourcePath), nativePath(targetPath), constants.COPYFILE_EXCL),
    createDirectory: (path: string) => mkdirSync(nativePath(path), { recursive: true }),
    documentsDirectory: () => root,
    downloadFileFromiCloud: async (_path: string) => undefined,
    fileExists: (path: string) => existsSync(nativePath(path)),
    fileName: (path: string, includeFileExtension = false) =>
      scriptableFileName(basename(nativePath(path)), includeFileExtension),
    fileSize: (path: string) => statSync(nativePath(path)).size,
    isDirectory: (path: string) => statSync(nativePath(path)).isDirectory(),
    isFileDownloaded: (_path: string) => true,
    joinPath: (parentPath: string, childPath: string) => join(nativePath(parentPath), childPath),
    listContents: (path: string) => readdirSync(nativePath(path)),
    modificationDate: (path: string) => statSync(nativePath(path)).mtime,
    move: (sourcePath: string, targetPath: string) =>
      renameSync(nativePath(sourcePath), nativePath(targetPath)),
    readString: (path: string) => readFileSync(nativePath(path), 'utf8'),
    remove: (path: string) => rmSync(nativePath(path), { recursive: true, force: true }),
    write: (path: string, data: Uint8Array) => writeFileSync(nativePath(path), data),
    writeString: (path: string, contents: string) => {
      mkdirSync(dirname(nativePath(path)), { recursive: true });
      writeFileSync(nativePath(path), contents, 'utf8');
    },
  });
  const assistant = loadStudyAssistant().createStudyAssistant(
    Object.freeze({
      chooseCourse: async (names: readonly string[]) => {
        courseChoices.push(Object.freeze([...names]));
        if (options.chooseCourse) return options.chooseCourse(Object.freeze([...names]));
        return options.chooseCourseResult ?? 0;
      },
      clock: () => options.fixedClock ?? timestamp,
      dataFromBytes: (bytes: readonly number[]) => Uint8Array.from(bytes),
      dataFromString: (text: string) =>
        Object.freeze({ getBytes: () => Object.freeze([...Buffer.from(text, 'utf8')]) }),
      fileManager,
      promptCourse: async () => {
        coursePrompts.push(Object.freeze({}));
        if (options.promptCourse) return options.promptCourse();
        return options.promptCourseResult ?? null;
      },
      uuid: () => options.uuidValues?.[uuidIndex++] ?? '44444444-4444-4444-8444-444444444444',
    }),
  );

  return Object.freeze({
    assistant,
    calls: Object.freeze({
      get courseChoices(): readonly (readonly string[])[] {
        return Object.freeze(courseChoices.map((names) => Object.freeze([...names])));
      },
      get coursePrompts(): readonly Readonly<Record<string, never>>[] {
        return Object.freeze(coursePrompts.map((prompt) => Object.freeze({ ...prompt })));
      },
    }),
    fileManager,
    run: (input: ScriptableInvocationInput) => assistant.run(input),
  });
};

type RuntimeAlertSnapshot = Readonly<{
  actions: readonly string[];
  cancelActions: readonly string[];
  message: string;
  textFieldPlaceholders: readonly string[];
  title: string;
}>;

export const createScriptableRuntimeAlertHarness = (
  options: Readonly<{
    formResult?: number;
    formValues?: readonly string[];
    pickerResult?: number;
  }> = {},
) => {
  const pickerAlerts: RuntimeAlertSnapshot[] = [];
  const formAlerts: RuntimeAlertSnapshot[] = [];
  class Alert {
    title = '';
    message = '';
    readonly actions: string[] = [];
    readonly cancelActions: string[] = [];
    readonly textFieldPlaceholders: string[] = [];

    addAction(name: string) {
      this.actions.push(name);
    }

    addCancelAction(name: string) {
      this.cancelActions.push(name);
    }

    addTextField(placeholder: string) {
      this.textFieldPlaceholders.push(placeholder);
    }

    presentAlert() {
      formAlerts.push(this.snapshot());
      return options.formResult ?? -1;
    }

    presentSheet() {
      pickerAlerts.push(this.snapshot());
      return options.pickerResult ?? -1;
    }

    textFieldValue(index: number) {
      return options.formValues?.[index] ?? '';
    }

    private snapshot(): RuntimeAlertSnapshot {
      return Object.freeze({
        actions: Object.freeze([...this.actions]),
        cancelActions: Object.freeze([...this.cancelActions]),
        message: this.message,
        textFieldPlaceholders: Object.freeze([...this.textFieldPlaceholders]),
        title: this.title,
      });
    }
  }
  return Object.freeze({
    Alert,
    calls: Object.freeze({
      get forms(): readonly RuntimeAlertSnapshot[] {
        return Object.freeze(formAlerts.map((alert) => Object.freeze({ ...alert })));
      },
      get pickers(): readonly RuntimeAlertSnapshot[] {
        return Object.freeze(pickerAlerts.map((alert) => Object.freeze({ ...alert })));
      },
    }),
  });
};
