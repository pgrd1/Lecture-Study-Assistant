import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type DesktopApplicationPort, registerIpc } from '../../../src/main/ipc/registerIpc';
import {
  BootstrapStateSchema,
  IPC_CHANNELS,
  IpcResponseSchema,
} from '../../../src/shared/contracts/ipc';
import { AppError } from '../../../src/shared/errors';
import { FakeDialog, FakeIpcMain, fakeInvokeEvent } from '../../testkit/fakeElectron';
import { withTempDirectory } from '../../testkit/tempDirectory';

const TRUSTED_URL = 'studyapp-renderer://app/index.html';
const TOKEN = '33333333-3333-4333-8333-333333333333';

const bootstrapState = () =>
  BootstrapStateSchema.parse({
    settings: {
      vaultConfigured: false,
      queueConfigured: false,
      defaultSummaryMode: 'standard',
      autoStart: false,
      processingPaused: false,
      legalNoticeAccepted: false,
    },
    courses: [],
    jobs: [],
    counts: { queued: 0, processing: 0, completed: 0, failed: 0 },
    synchronizationIssueCount: 0,
  });

const createApplication = (): DesktopApplicationPort => {
  const state = bootstrapState();
  return {
    getBootstrapState: vi.fn(async () => state),
    chooseVault: vi.fn(async () => state),
    chooseQueue: vi.fn(async () => state),
    createCourse: vi.fn(async () => state),
    updateCourse: vi.fn(async () => state),
    archiveCourse: vi.fn(async () => state),
    restoreCourse: vi.fn(async () => state),
    enqueueSources: vi.fn(async () => state),
    retryJob: vi.fn(async () => state),
    setAutoStart: vi.fn(async () => state),
    exportDiagnostics: vi.fn(async () => undefined),
  };
};

const createHarness = (
  application = createApplication(),
  options: Readonly<{ clock?: () => number }> = {},
) => {
  const ipcMain = new FakeIpcMain();
  const dialog = new FakeDialog();
  const dispose = registerIpc({
    ipcMain,
    dialog,
    application,
    trustedRendererUrl: TRUSTED_URL,
    clock: options.clock ?? (() => Date.parse('2026-09-02T00:00:00.000Z')),
    idGenerator: () => TOKEN,
  });
  return Object.freeze({ application, dialog, dispose, ipcMain });
};

describe('registerIpc', () => {
  it('registers only the named invoke allowlist', () => {
    const { ipcMain } = createHarness();

    expect([...ipcMain.handlers.keys()].sort()).toEqual(
      Object.values(IPC_CHANNELS)
        .filter((channel) => channel !== IPC_CHANNELS.stateChanged)
        .sort(),
    );
  });

  it('removes every named handler when disposed', () => {
    const { dispose, ipcMain } = createHarness();

    dispose();

    expect(ipcMain.handlers.size).toBe(0);
  });

  it('returns a cancellation DTO without calling a directory service', async () => {
    const { application, ipcMain } = createHarness();

    const raw = await ipcMain.invoke(IPC_CHANNELS.chooseVault, fakeInvokeEvent(TRUSTED_URL), {});

    expect(raw).toEqual({ ok: true, data: { cancelled: true } });
    expect(application.chooseVault).not.toHaveBeenCalled();
  });

  it('rejects malformed renderer input before calling a service', async () => {
    const { application, ipcMain } = createHarness();

    const raw = await ipcMain.invoke(IPC_CHANNELS.createCourse, fakeInvokeEvent(TRUSTED_URL), {
      name: '../',
      professorName: 7,
    });

    expect(IpcResponseSchema(BootstrapStateSchema).parse(raw)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(application.createCourse).not.toHaveBeenCalled();
  });

  it('rejects subframes and untrusted renderer documents', async () => {
    const { application, ipcMain } = createHarness();

    for (const event of [
      fakeInvokeEvent('https://example.com/'),
      fakeInvokeEvent(TRUSTED_URL, { subframe: true }),
    ]) {
      const raw = await ipcMain.invoke(IPC_CHANNELS.getBootstrapState, event, {});
      expect(IpcResponseSchema(BootstrapStateSchema).parse(raw)).toMatchObject({
        ok: false,
        error: { code: 'UNTRUSTED_IPC_SENDER' },
      });
    }
    expect(application.getBootstrapState).not.toHaveBeenCalled();
  });

  it('calls exactly one application method for a valid course request', async () => {
    const { application, ipcMain } = createHarness();

    const raw = await ipcMain.invoke(
      IPC_CHANNELS.createCourse,
      fakeInvokeEvent(`${TRUSTED_URL}#courses`),
      { name: '자료구조', professorName: '김교수' },
    );

    expect(IpcResponseSchema(BootstrapStateSchema).parse(raw)).toEqual({
      ok: true,
      data: bootstrapState(),
    });
    expect(application.createCourse).toHaveBeenCalledExactlyOnceWith({
      name: '자료구조',
      professorName: '김교수',
    });
  });

  it('restores a course only through the named restore channel', async () => {
    const { application, ipcMain } = createHarness();

    const raw = await ipcMain.invoke(IPC_CHANNELS.restoreCourse, fakeInvokeEvent(TRUSTED_URL), {
      id: '11111111-1111-4111-8111-111111111111',
    });

    expect(IpcResponseSchema(BootstrapStateSchema).parse(raw)).toEqual({
      ok: true,
      data: bootstrapState(),
    });
    expect(application.restoreCourse).toHaveBeenCalledExactlyOnceWith(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('keeps an ordered source bundle behind one single-use token', async () => {
    await withTempDirectory(async (directory) => {
      const sourcePath = join(directory, '1주차 강의.m4a');
      const companionPath = join(directory, '1주차 슬라이드.pdf');
      await writeFile(sourcePath, 'audio bytes');
      await writeFile(companionPath, 'slide bytes');
      const { application, dialog, ipcMain } = createHarness();
      dialog.openResults.push({ canceled: false, filePaths: [sourcePath, companionPath] });

      const choice = await ipcMain.invoke(
        IPC_CHANNELS.chooseSources,
        fakeInvokeEvent(TRUSTED_URL),
        {},
      );
      const choiceJson = JSON.stringify(choice);
      expect(choiceJson).not.toContain(directory);
      expect(choice).toMatchObject({
        ok: true,
        data: {
          selectionToken: TOKEN,
          files: [
            { name: '1주차 강의.m4a', size: 11 },
            { name: '1주차 슬라이드.pdf', size: 11 },
          ],
        },
      });
      expect(dialog.openCalls).toEqual([
        expect.objectContaining({ properties: ['openFile', 'multiSelections'] }),
      ]);

      const request = {
        selectionToken: TOKEN,
        courseId: '11111111-1111-4111-8111-111111111111',
        summaryMode: 'standard',
      };
      const first = await ipcMain.invoke(
        IPC_CHANNELS.enqueueSelection,
        fakeInvokeEvent(TRUSTED_URL),
        request,
      );
      expect(first).toMatchObject({ ok: true });
      expect(application.enqueueSources).toHaveBeenCalledExactlyOnceWith({
        courseId: request.courseId,
        filePaths: [sourcePath, companionPath],
        summaryMode: 'standard',
      });

      const replay = await ipcMain.invoke(
        IPC_CHANNELS.enqueueSelection,
        fakeInvokeEvent(TRUSTED_URL),
        request,
      );
      expect(replay).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(application.enqueueSources).toHaveBeenCalledTimes(1);
    });
  });

  it('expires an unconsumed source-selection token', async () => {
    await withTempDirectory(async (directory) => {
      let now = Date.parse('2026-09-02T00:00:00.000Z');
      const sourcePath = join(directory, '2주차 강의.m4a');
      await writeFile(sourcePath, 'audio bytes');
      const application = createApplication();
      const { dialog, ipcMain } = createHarness(application, { clock: () => now });
      dialog.openResults.push({ canceled: false, filePaths: [sourcePath] });
      await ipcMain.invoke(IPC_CHANNELS.chooseSources, fakeInvokeEvent(TRUSTED_URL), {});
      now += 11 * 60 * 1_000;

      const raw = await ipcMain.invoke(
        IPC_CHANNELS.enqueueSelection,
        fakeInvokeEvent(TRUSTED_URL),
        {
          selectionToken: TOKEN,
          courseId: '11111111-1111-4111-8111-111111111111',
          summaryMode: 'standard',
        },
      );

      expect(raw).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(application.enqueueSources).not.toHaveBeenCalled();
    });
  });

  it('does not expose dialog paths or underlying failure messages', async () => {
    await withTempDirectory(async (directory) => {
      const application = createApplication();
      vi.mocked(application.exportDiagnostics).mockRejectedValue(
        new Error(`C:\\Users\\student\\secret-value ${directory}`),
      );
      const { dialog, ipcMain } = createHarness(application);
      const destination = join(directory, 'diagnostics.json');
      dialog.saveResults.push({ canceled: false, filePath: destination });

      const raw = await ipcMain.invoke(
        IPC_CHANNELS.exportDiagnostics,
        fakeInvokeEvent(TRUSTED_URL),
        {},
      );
      const encoded = JSON.stringify(raw);
      expect(raw).toMatchObject({
        ok: false,
        error: { code: 'UNEXPECTED_ERROR' },
      });
      expect(encoded).not.toContain(destination);
      expect(encoded).not.toContain('secret-value');
    });
  });

  it('preserves only trusted fixed service errors', async () => {
    const application = createApplication();
    vi.mocked(application.retryJob).mockRejectedValue(
      new AppError('COURSE_NOT_FOUND', '과목을 찾지 못했습니다.'),
    );
    const { ipcMain } = createHarness(application);

    const raw = await ipcMain.invoke(IPC_CHANNELS.retryJob, fakeInvokeEvent(TRUSTED_URL), {
      id: '22222222-2222-4222-8222-222222222222',
    });
    expect(raw).toMatchObject({
      ok: false,
      error: {
        code: 'COURSE_NOT_FOUND',
        message: '과목을 찾지 못했습니다.',
        retryable: false,
      },
    });
  });
});
