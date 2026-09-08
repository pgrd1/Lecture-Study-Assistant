import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { z } from 'zod';
import { CourseInputSchema } from '../shared/contracts/course';
import {
  type BootstrapState,
  BootstrapStateSchema,
  DirectoryChoiceSchema,
  type DroppedFilesInput,
  EmptyRequestSchema,
  EnqueueDroppedFilesRequestSchema,
  EnqueueSelectionRequestSchema,
  EntityIdRequestSchema,
  ExportDiagnosticsResultSchema,
  IPC_CHANNELS,
  type IpcResponse,
  IpcResponseSchema,
  SetAutoStartRequestSchema,
  SourceSelectionSchema,
  type StudyAppApi,
  UpdateCourseRequestSchema,
} from '../shared/contracts/ipc';
import { APP_ERROR_MESSAGES, AppError, toErrorEnvelope } from '../shared/errors';

export type IpcRendererFacade = Readonly<{
  invoke(channel: string, input: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
}>;

export type WebUtilsFacade = Readonly<{
  getPathForFile(file: File): string;
}>;

const fixedFailure = <Data>(code: 'INVALID_INPUT' | 'UNEXPECTED_ERROR'): IpcResponse<Data> =>
  Object.freeze({
    ok: false,
    error: toErrorEnvelope(new AppError(code, APP_ERROR_MESSAGES[code])),
  });

const invokeValidated = async <RequestSchema extends z.ZodType, ResponseSchema extends z.ZodType>(
  renderer: IpcRendererFacade,
  channel: string,
  requestSchema: RequestSchema,
  responseSchema: ResponseSchema,
  input: unknown,
): Promise<IpcResponse<z.output<ResponseSchema>>> => {
  const request = (() => {
    try {
      return requestSchema.safeParse(input);
    } catch {
      return undefined;
    }
  })();
  if (request === undefined || !request.success) {
    return fixedFailure('INVALID_INPUT');
  }
  try {
    const response = IpcResponseSchema(responseSchema).safeParse(
      await renderer.invoke(channel, request.data),
    );
    return response.success
      ? (response.data as IpcResponse<z.output<ResponseSchema>>)
      : fixedFailure('UNEXPECTED_ERROR');
  } catch {
    return fixedFailure('UNEXPECTED_ERROR');
  }
};

export const createPreloadApi = (
  renderer: IpcRendererFacade,
  fileUtils: WebUtilsFacade,
): StudyAppApi => {
  const emptyInvoke = <ResponseSchema extends z.ZodType>(
    channel: string,
    responseSchema: ResponseSchema,
  ): Promise<IpcResponse<z.output<ResponseSchema>>> =>
    invokeValidated(renderer, channel, EmptyRequestSchema, responseSchema, {});

  const api: StudyAppApi = {
    getBootstrapState: () => emptyInvoke(IPC_CHANNELS.getBootstrapState, BootstrapStateSchema),
    chooseVault: () => emptyInvoke(IPC_CHANNELS.chooseVault, DirectoryChoiceSchema),
    chooseQueue: () => emptyInvoke(IPC_CHANNELS.chooseQueue, DirectoryChoiceSchema),
    createCourse: (input) =>
      invokeValidated(
        renderer,
        IPC_CHANNELS.createCourse,
        CourseInputSchema,
        BootstrapStateSchema,
        input,
      ),
    updateCourse: (id, patch) =>
      invokeValidated(
        renderer,
        IPC_CHANNELS.updateCourse,
        UpdateCourseRequestSchema,
        BootstrapStateSchema,
        { id, patch },
      ),
    archiveCourse: (id) =>
      invokeValidated(
        renderer,
        IPC_CHANNELS.archiveCourse,
        EntityIdRequestSchema,
        BootstrapStateSchema,
        { id },
      ),
    restoreCourse: (id) =>
      invokeValidated(
        renderer,
        IPC_CHANNELS.restoreCourse,
        EntityIdRequestSchema,
        BootstrapStateSchema,
        { id },
      ),
    chooseSources: () => emptyInvoke(IPC_CHANNELS.chooseSources, SourceSelectionSchema),
    enqueueSelection: (input) =>
      invokeValidated(
        renderer,
        IPC_CHANNELS.enqueueSelection,
        EnqueueSelectionRequestSchema,
        BootstrapStateSchema,
        input,
      ),
    enqueueDroppedFiles: async (input: DroppedFilesInput) => {
      try {
        if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 32) {
          return fixedFailure('INVALID_INPUT');
        }
        const filePaths = input.files.map((file) => fileUtils.getPathForFile(file));
        return await invokeValidated(
          renderer,
          IPC_CHANNELS.enqueueDroppedFiles,
          EnqueueDroppedFilesRequestSchema,
          BootstrapStateSchema,
          {
            courseId: input.courseId,
            filePaths,
            summaryMode: input.summaryMode,
          },
        );
      } catch {
        return fixedFailure('INVALID_INPUT');
      }
    },
    retryJob: (id) =>
      invokeValidated(
        renderer,
        IPC_CHANNELS.retryJob,
        EntityIdRequestSchema,
        BootstrapStateSchema,
        { id },
      ),
    setAutoStart: (enabled) =>
      invokeValidated(
        renderer,
        IPC_CHANNELS.setAutoStart,
        SetAutoStartRequestSchema,
        BootstrapStateSchema,
        { enabled },
      ),
    exportDiagnostics: () =>
      emptyInvoke(IPC_CHANNELS.exportDiagnostics, ExportDiagnosticsResultSchema),
    subscribeToState: (callback: (state: BootstrapState) => void) => {
      if (typeof callback !== 'function') {
        return () => undefined;
      }
      let subscribed = true;
      const listener = (_event: unknown, payload: unknown): void => {
        const parsed = BootstrapStateSchema.safeParse(payload);
        if (subscribed && parsed.success) {
          callback(parsed.data);
        }
      };
      renderer.on(IPC_CHANNELS.stateChanged, listener);
      return () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        renderer.removeListener(IPC_CHANNELS.stateChanged, listener);
      };
    },
  };

  return Object.freeze(api);
};

contextBridge.exposeInMainWorld('studyApp', createPreloadApi(ipcRenderer, webUtils));
