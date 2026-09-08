import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, extname, isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { LocalSourceInput } from '../../application/jobs/localSourceIntake';
import { assertNoReparsePoints } from '../../core/paths/safePath';
import {
  type CourseInput,
  CourseInputSchema,
  type CoursePatch,
} from '../../shared/contracts/course';
import {
  type BootstrapState,
  BootstrapStateSchema,
  DirectoryChoiceSchema,
  EmptyRequestSchema,
  type EnqueueDroppedFilesRequest,
  EnqueueDroppedFilesRequestSchema,
  EnqueueSelectionRequestSchema,
  EntityIdRequestSchema,
  ExportDiagnosticsResultSchema,
  IPC_CHANNELS,
  IPC_INVOKE_CHANNELS,
  IpcResponseSchema,
  SetAutoStartRequestSchema,
  SourceSelectionSchema,
  UpdateCourseRequestSchema,
} from '../../shared/contracts/ipc';
import { MAX_SOURCES_PER_BUNDLE } from '../../shared/contracts/sourceBundle';
import { SupportedSourceFileNameSchema } from '../../shared/contracts/sourceFile';
import { APP_ERROR_MESSAGES, AppError, toErrorEnvelope } from '../../shared/errors';
import { isTrustedRendererNavigation } from '../window';

const SELECTION_TTL_MS = 10 * 60 * 1_000;
const MAX_SELECTIONS = 100;

const DialogPathSchema = z
  .string()
  .min(1)
  .max(32_767)
  .refine((value) => isAbsolute(value) && !value.includes('\0'));

const DiagnosticsPathSchema = DialogPathSchema.refine(
  (value) => extname(value).toLowerCase() === '.json',
);

export interface DesktopApplicationPort {
  getBootstrapState(): Promise<BootstrapState>;
  chooseVault(path: string): Promise<BootstrapState>;
  chooseQueue(path: string): Promise<BootstrapState>;
  createCourse(input: CourseInput): Promise<BootstrapState>;
  updateCourse(id: string, patch: CoursePatch): Promise<BootstrapState>;
  archiveCourse(id: string): Promise<BootstrapState>;
  restoreCourse(id: string): Promise<BootstrapState>;
  enqueueSources(input: LocalSourceInput): Promise<BootstrapState>;
  retryJob(id: string): Promise<BootstrapState>;
  setAutoStart(enabled: boolean): Promise<BootstrapState>;
  exportDiagnostics(destination: string): Promise<void>;
}

export type IpcInvokeEventLike = Readonly<{
  sender: Readonly<{
    getURL(): string;
    mainFrame: object;
  }>;
  senderFrame: Readonly<{ url: string }> | null;
}>;

export type IpcMainFacade = Readonly<{
  handle(
    channel: string,
    listener: (event: IpcInvokeEventLike, input: unknown) => unknown | Promise<unknown>,
  ): void;
  removeHandler(channel: string): void;
}>;

export type DialogFacade = Readonly<{
  showOpenDialog(
    options: unknown,
  ): Promise<Readonly<{ canceled: boolean; filePaths: readonly string[] }>>;
  showSaveDialog(options: unknown): Promise<Readonly<{ canceled: boolean; filePath?: string }>>;
}>;

export type RegisterIpcDependencies = Readonly<{
  ipcMain: IpcMainFacade;
  dialog: DialogFacade;
  application: DesktopApplicationPort;
  trustedRendererUrl: string;
  clock?: () => number;
  idGenerator?: () => string;
}>;

type SelectedSource = Readonly<{
  fileName: string;
  filePath: string;
  size: number;
}>;

type SelectedSourceBundle = Readonly<{
  createdAt: number;
  sources: readonly SelectedSource[];
}>;

const invalidInput = (): AppError =>
  new AppError('INVALID_INPUT', APP_ERROR_MESSAGES.INVALID_INPUT);

const untrustedSender = (): AppError =>
  new AppError('UNTRUSTED_IPC_SENDER', APP_ERROR_MESSAGES.UNTRUSTED_IPC_SENDER);

const parseInput = <Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput();
  }
  return parsed.data;
};

const assertTrustedSender = (event: IpcInvokeEventLike, trustedRendererUrl: string): void => {
  const frame = event.senderFrame;
  if (
    frame === null ||
    frame !== event.sender.mainFrame ||
    !isTrustedRendererNavigation(frame.url, trustedRendererUrl) ||
    !isTrustedRendererNavigation(event.sender.getURL(), trustedRendererUrl)
  ) {
    throw untrustedSender();
  }
};

class SourceSelectionStore {
  readonly #clock: () => number;
  readonly #idGenerator: () => string;
  #selections: ReadonlyMap<string, SelectedSourceBundle> = new Map();

  constructor(clock: () => number, idGenerator: () => string) {
    this.#clock = clock;
    this.#idGenerator = idGenerator;
  }

  issue(sources: readonly SelectedSource[]): string {
    if (sources.length < 1 || sources.length > MAX_SOURCES_PER_BUNDLE) {
      throw invalidInput();
    }
    const now = this.#now();
    let next = this.#pruned(now);
    while (next.size >= MAX_SELECTIONS) {
      next = new Map([...next].slice(1));
    }
    const token = z.uuid().safeParse(this.#idGenerator());
    if (!token.success || next.has(token.data)) {
      throw invalidInput();
    }
    next = new Map(next).set(
      token.data,
      Object.freeze({ createdAt: now, sources: Object.freeze([...sources]) }),
    );
    this.#selections = next;
    return token.data;
  }

  consume(token: string): SelectedSourceBundle {
    const parsedToken = z.uuid().safeParse(token);
    if (!parsedToken.success) {
      throw invalidInput();
    }
    const next = this.#pruned(this.#now());
    const selected = next.get(parsedToken.data);
    this.#selections = new Map([...next].filter(([key]) => key !== parsedToken.data));
    if (selected === undefined) {
      throw invalidInput();
    }
    return selected;
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isFinite(now)) {
      throw invalidInput();
    }
    return now;
  }

  #pruned(now: number): Map<string, SelectedSourceBundle> {
    return new Map(
      [...this.#selections].filter(
        ([, selected]) => now >= selected.createdAt && now - selected.createdAt <= SELECTION_TTL_MS,
      ),
    );
  }
}

const inspectSelectedSource = async (filePath: string): Promise<SelectedSource> => {
  try {
    const parsedPath = DialogPathSchema.parse(filePath);
    const fileName = SupportedSourceFileNameSchema.parse(basename(parsedPath));
    assertNoReparsePoints(parsedPath);
    const before = await lstat(parsedPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw invalidInput();
    }
    assertNoReparsePoints(parsedPath);
    const after = await lstat(parsedPath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw invalidInput();
    }
    return Object.freeze({ fileName, filePath: parsedPath, size: after.size });
  } catch (error) {
    if (AppError.isTrusted(error) && error.code === 'INVALID_INPUT') {
      throw error;
    }
    throw invalidInput();
  }
};

export const registerIpc = (dependencies: RegisterIpcDependencies): (() => void) => {
  const selectionStore = new SourceSelectionStore(
    dependencies.clock ?? Date.now,
    dependencies.idGenerator ?? randomUUID,
  );

  const register = <RequestSchema extends z.ZodType, ResponseSchema extends z.ZodType>(
    channel: (typeof IPC_INVOKE_CHANNELS)[number],
    requestSchema: RequestSchema,
    responseSchema: ResponseSchema,
    operation: (request: z.output<RequestSchema>) => Promise<z.input<ResponseSchema>>,
  ): void => {
    dependencies.ipcMain.handle(channel, async (event, rawInput) => {
      try {
        assertTrustedSender(event, dependencies.trustedRendererUrl);
        const request = parseInput(requestSchema, rawInput);
        const data = responseSchema.parse(await operation(request));
        return IpcResponseSchema(responseSchema).parse({ ok: true, data });
      } catch (error) {
        return IpcResponseSchema(responseSchema).parse({
          ok: false,
          error: toErrorEnvelope(error),
        });
      }
    });
  };

  register(IPC_CHANNELS.getBootstrapState, EmptyRequestSchema, BootstrapStateSchema, () =>
    dependencies.application.getBootstrapState(),
  );

  const registerDirectoryChoice = (
    channel: typeof IPC_CHANNELS.chooseVault | typeof IPC_CHANNELS.chooseQueue,
    title: string,
    choose: (path: string) => Promise<BootstrapState>,
  ): void => {
    register(channel, EmptyRequestSchema, DirectoryChoiceSchema, async () => {
      const result = await dependencies.dialog.showOpenDialog({
        title,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled) {
        return { cancelled: true as const };
      }
      if (result.filePaths.length !== 1) {
        throw invalidInput();
      }
      const selectedPath = parseInput(DialogPathSchema, result.filePaths[0]);
      return { cancelled: false as const, state: await choose(selectedPath) };
    });
  };

  registerDirectoryChoice(IPC_CHANNELS.chooseVault, 'Obsidian Vault 선택', (path) =>
    dependencies.application.chooseVault(path),
  );
  registerDirectoryChoice(IPC_CHANNELS.chooseQueue, 'iCloud 대기열 선택', (path) =>
    dependencies.application.chooseQueue(path),
  );

  register(IPC_CHANNELS.createCourse, CourseInputSchema, BootstrapStateSchema, (request) =>
    dependencies.application.createCourse(request),
  );
  register(IPC_CHANNELS.updateCourse, UpdateCourseRequestSchema, BootstrapStateSchema, (request) =>
    dependencies.application.updateCourse(request.id, request.patch),
  );
  register(IPC_CHANNELS.archiveCourse, EntityIdRequestSchema, BootstrapStateSchema, (request) =>
    dependencies.application.archiveCourse(request.id),
  );
  register(IPC_CHANNELS.restoreCourse, EntityIdRequestSchema, BootstrapStateSchema, (request) =>
    dependencies.application.restoreCourse(request.id),
  );

  register(IPC_CHANNELS.chooseSources, EmptyRequestSchema, SourceSelectionSchema, async () => {
    const result = await dependencies.dialog.showOpenDialog({
      title: '강의 자료 선택',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '지원 파일',
          extensions: [
            'm4a',
            'mp3',
            'wav',
            'aac',
            'flac',
            'mp4',
            'pdf',
            'pptx',
            'txt',
            'md',
            'png',
            'jpg',
            'jpeg',
            'heic',
          ],
        },
      ],
    });
    if (result.canceled) {
      return { cancelled: true as const, selectionToken: null, files: [] as const };
    }
    if (result.filePaths.length < 1 || result.filePaths.length > MAX_SOURCES_PER_BUNDLE) {
      throw invalidInput();
    }
    const normalizedPaths = result.filePaths.map((filePath) => normalize(filePath).toLowerCase());
    if (new Set(normalizedPaths).size !== normalizedPaths.length) {
      throw invalidInput();
    }
    const selected = Object.freeze(await Promise.all(result.filePaths.map(inspectSelectedSource)));
    return {
      cancelled: false as const,
      selectionToken: selectionStore.issue(selected),
      files: selected.map((source) => ({ name: source.fileName, size: source.size })),
    };
  });

  register(
    IPC_CHANNELS.enqueueSelection,
    EnqueueSelectionRequestSchema,
    BootstrapStateSchema,
    (request) => {
      const selected = selectionStore.consume(request.selectionToken);
      return dependencies.application.enqueueSources({
        courseId: request.courseId,
        filePaths: selected.sources.map((source) => source.filePath),
        summaryMode: request.summaryMode,
      });
    },
  );

  register(
    IPC_CHANNELS.enqueueDroppedFiles,
    EnqueueDroppedFilesRequestSchema,
    BootstrapStateSchema,
    (request: EnqueueDroppedFilesRequest) => dependencies.application.enqueueSources(request),
  );
  register(IPC_CHANNELS.retryJob, EntityIdRequestSchema, BootstrapStateSchema, (request) =>
    dependencies.application.retryJob(request.id),
  );
  register(IPC_CHANNELS.setAutoStart, SetAutoStartRequestSchema, BootstrapStateSchema, (request) =>
    dependencies.application.setAutoStart(request.enabled),
  );

  register(
    IPC_CHANNELS.exportDiagnostics,
    EmptyRequestSchema,
    ExportDiagnosticsResultSchema,
    async () => {
      const result = await dependencies.dialog.showSaveDialog({
        title: '진단 보고서 내보내기',
        defaultPath: 'lecture-study-assistant-diagnostics.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled) {
        return { cancelled: true as const };
      }
      const destination = parseInput(DiagnosticsPathSchema, result.filePath);
      await dependencies.application.exportDiagnostics(destination);
      return { cancelled: false as const };
    },
  );

  return () => {
    for (const channel of IPC_INVOKE_CHANNELS) {
      dependencies.ipcMain.removeHandler(channel);
    }
  };
};
