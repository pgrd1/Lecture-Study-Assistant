import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BootstrapStateSchema,
  EXPECTED_API_METHODS,
  IPC_CHANNELS,
} from '../../../src/shared/contracts/ipc';

const electronMocks = vi.hoisted(() => {
  type RendererListener = (event: unknown, payload: unknown) => void;
  const listeners = new Map<string, Set<RendererListener>>();
  const failures = new Map<string, unknown>();
  const invocations: Array<Readonly<{ channel: string; input: unknown }>> = [];
  const responses = new Map<string, unknown>();
  const renderer = {
    failures,
    invocations,
    responses,
    invoke: vi.fn(async (channel: string, input: unknown): Promise<unknown> => {
      invocations.push(Object.freeze({ channel, input }));
      if (failures.has(channel)) {
        throw failures.get(channel);
      }
      return responses.get(channel);
    }),
    on: vi.fn((channel: string, listener: RendererListener) => {
      const next = new Set(listeners.get(channel) ?? []);
      next.add(listener);
      listeners.set(channel, next);
      return renderer;
    }),
    removeListener: vi.fn((channel: string, listener: RendererListener) => {
      const next = new Set(listeners.get(channel) ?? []);
      next.delete(listener);
      listeners.set(channel, next);
      return renderer;
    }),
    emit: (channel: string, payload: unknown): void => {
      for (const listener of listeners.get(channel) ?? []) {
        listener(Object.freeze({}), payload);
      }
    },
    reset: (): void => {
      failures.clear();
      invocations.length = 0;
      responses.clear();
      listeners.clear();
      renderer.invoke.mockClear();
      renderer.on.mockClear();
      renderer.removeListener.mockClear();
    },
  };
  return {
    exposeInMainWorld: vi.fn(),
    getPathForFile: vi.fn<(file: File) => string>(),
    renderer,
  };
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: electronMocks.renderer,
  webUtils: { getPathForFile: electronMocks.getPathForFile },
}));

import { createPreloadApi } from '../../../src/preload/index';

const bootstrapState = () =>
  BootstrapStateSchema.parse({
    settings: {
      vaultConfigured: true,
      queueConfigured: true,
      defaultSummaryMode: 'standard',
      autoStart: false,
      processingPaused: false,
      legalNoticeAccepted: true,
    },
    courses: [],
    jobs: [],
    counts: { queued: 0, processing: 0, completed: 0, failed: 0 },
    synchronizationIssueCount: 0,
  });

describe('preload API surface', () => {
  beforeEach(() => {
    electronMocks.renderer.reset();
    electronMocks.getPathForFile.mockReset();
  });

  it('exposes named frozen methods but no generic send or invoke', () => {
    const api = createPreloadApi(electronMocks.renderer, {
      getPathForFile: electronMocks.getPathForFile,
    });

    expect(Object.keys(api).sort()).toEqual([...EXPECTED_API_METHODS].sort());
    expect(Object.isFrozen(api)).toBe(true);
    expect(api).not.toHaveProperty('send');
    expect(api).not.toHaveProperty('invoke');
  });

  it('publishes only the named API under the fixed studyApp key', () => {
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledOnce();
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledWith(
      'studyApp',
      expect.not.objectContaining({ invoke: expect.anything(), send: expect.anything() }),
    );
  });

  it('invokes only its fixed channel and parses the response envelope', async () => {
    electronMocks.renderer.responses.set(IPC_CHANNELS.getBootstrapState, {
      ok: true,
      data: bootstrapState(),
    });
    const api = createPreloadApi(electronMocks.renderer, {
      getPathForFile: electronMocks.getPathForFile,
    });

    await expect(api.getBootstrapState()).resolves.toEqual({
      ok: true,
      data: bootstrapState(),
    });
    expect(electronMocks.renderer.invocations).toEqual([
      { channel: IPC_CHANNELS.getBootstrapState, input: {} },
    ]);
  });

  it('sends course restoration through its fixed validated channel', async () => {
    const state = bootstrapState();
    electronMocks.renderer.responses.set(IPC_CHANNELS.restoreCourse, {
      ok: true,
      data: state,
    });
    const api = createPreloadApi(electronMocks.renderer, {
      getPathForFile: electronMocks.getPathForFile,
    });

    await expect(api.restoreCourse('11111111-1111-4111-8111-111111111111')).resolves.toEqual({
      ok: true,
      data: state,
    });
    expect(electronMocks.renderer.invocations).toEqual([
      {
        channel: IPC_CHANNELS.restoreCourse,
        input: { id: '11111111-1111-4111-8111-111111111111' },
      },
    ]);
  });

  it('converts every dropped File to an ordered path bundle without returning those paths', async () => {
    const state = bootstrapState();
    electronMocks.renderer.responses.set(IPC_CHANNELS.enqueueDroppedFiles, {
      ok: true,
      data: state,
    });
    const dropped = { name: '직접 입력.m4a' } as File;
    const companion = { name: '직접 입력.pdf' } as File;
    electronMocks.getPathForFile
      .mockReturnValueOnce('C:\\Users\\student\\직접 입력.m4a')
      .mockReturnValueOnce('C:\\Users\\student\\직접 입력.pdf');
    const api = createPreloadApi(electronMocks.renderer, {
      getPathForFile: electronMocks.getPathForFile,
    });

    const response = await api.enqueueDroppedFiles({
      courseId: '11111111-1111-4111-8111-111111111111',
      files: [dropped, companion],
      summaryMode: 'core',
    });

    expect(response).toEqual({ ok: true, data: state });
    expect(electronMocks.getPathForFile).toHaveBeenNthCalledWith(1, dropped);
    expect(electronMocks.getPathForFile).toHaveBeenNthCalledWith(2, companion);
    expect(electronMocks.renderer.invocations).toEqual([
      {
        channel: IPC_CHANNELS.enqueueDroppedFiles,
        input: {
          courseId: '11111111-1111-4111-8111-111111111111',
          filePaths: ['C:\\Users\\student\\직접 입력.m4a', 'C:\\Users\\student\\직접 입력.pdf'],
          summaryMode: 'core',
        },
      },
    ]);
    expect(JSON.stringify(response)).not.toContain('Users');
  });

  it('rejects empty or 33-file drops before asking Electron for paths', async () => {
    const api = createPreloadApi(electronMocks.renderer, {
      getPathForFile: electronMocks.getPathForFile,
    });
    const baseInput = {
      courseId: '11111111-1111-4111-8111-111111111111',
      summaryMode: 'standard' as const,
    };

    for (const files of [
      [],
      Array.from({ length: 33 }, (_, index) => ({ name: `${index}.m4a` })) as File[],
    ]) {
      await expect(api.enqueueDroppedFiles({ ...baseInput, files })).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
    }

    expect(electronMocks.getPathForFile).not.toHaveBeenCalled();
    expect(electronMocks.renderer.invocations).toEqual([]);
  });

  it('maps hostile dropped-file values to a fixed invalid-input envelope', async () => {
    const api = createPreloadApi(electronMocks.renderer, {
      getPathForFile: electronMocks.getPathForFile,
    });
    const throwingInput = Object.defineProperty({}, 'files', {
      get: () => {
        throw new Error('C:\\Users\\student\\private.md');
      },
    });

    for (const input of [null, undefined, 7, 'path', throwingInput]) {
      const response = await api.enqueueDroppedFiles(input as never);
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      expect(JSON.stringify(response)).not.toContain('private.md');
    }

    expect(electronMocks.getPathForFile).not.toHaveBeenCalled();
    expect(electronMocks.renderer.invocations).toEqual([]);
  });

  it('subscribes with a parsed payload and returns an idempotent unsubscribe function', () => {
    const api = createPreloadApi(electronMocks.renderer, {
      getPathForFile: electronMocks.getPathForFile,
    });
    const callback = vi.fn();
    const unsubscribe = api.subscribeToState(callback);

    electronMocks.renderer.emit(IPC_CHANNELS.stateChanged, bootstrapState());
    electronMocks.renderer.emit(IPC_CHANNELS.stateChanged, {
      ...bootstrapState(),
      absolutePath: 'C:\\Users\\student',
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(bootstrapState());

    unsubscribe();
    unsubscribe();
    electronMocks.renderer.emit(IPC_CHANNELS.stateChanged, bootstrapState());
    expect(callback).toHaveBeenCalledOnce();
  });

  it('maps malformed or rejected main-process responses to a generic fixed envelope', async () => {
    const api = createPreloadApi(electronMocks.renderer, {
      getPathForFile: electronMocks.getPathForFile,
    });
    electronMocks.renderer.responses.set(IPC_CHANNELS.getBootstrapState, {
      ok: true,
      data: { vaultPath: 'C:\\Users\\student' },
    });
    await expect(api.getBootstrapState()).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNEXPECTED_ERROR' },
    });

    electronMocks.renderer.failures.set(
      IPC_CHANNELS.getBootstrapState,
      new Error('C:\\Users\\student\\secret-value'),
    );
    const response = await api.getBootstrapState();
    expect(response).toMatchObject({ ok: false, error: { code: 'UNEXPECTED_ERROR' } });
    expect(JSON.stringify(response)).not.toContain('secret-value');
  });

  it('contains request property traps inside the fixed input-error boundary', async () => {
    const api = createPreloadApi(electronMocks.renderer, {
      getPathForFile: electronMocks.getPathForFile,
    });
    const hostileCourse = Object.defineProperty({}, 'name', {
      get: () => {
        throw new Error('C:\\Users\\student\\private-course.md');
      },
    });

    const response = await api.createCourse(hostileCourse as never);

    expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(JSON.stringify(response)).not.toContain('private-course.md');
    expect(electronMocks.renderer.invocations).toEqual([]);
  });
});
