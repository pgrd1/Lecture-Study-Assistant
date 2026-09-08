import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import {
  applyWindowsAutoStart,
  configureElectronRuntime,
  type DesktopAppFacade,
  type ManagedWindow,
  runDesktopLifecycle,
} from '../../src/main/bootstrap';
import { createLifecyclePreferenceStore } from '../../src/main/lifecyclePreferences';
import {
  registerTray,
  type TrayLike,
  type TrayMenuItem,
  type TrayRuntime,
} from '../../src/main/tray';
import { withTempDirectory } from '../testkit/tempDirectory';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const DEEP_LINK = `studyapp://play/${SOURCE_ID}?t=125.5`;

class FakeApp implements DesktopAppFacade {
  readonly defaultProtocols: string[] = [];
  readonly loginSettings: Array<Readonly<{ openAtLogin: boolean; path: string }>> = [];
  readonly quit = vi.fn();
  readonly requestSingleInstanceLock = vi.fn(() => true);
  readonly whenReady = vi.fn(async () => undefined);
  readonly #listeners = new Map<string, Set<(...argumentsList: never[]) => void>>();

  on(event: string, listener: (...argumentsList: never[]) => void): void {
    const listeners = new Set(this.#listeners.get(event) ?? []);
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  }

  emit(event: 'activate' | 'before-quit'): void;
  emit(event: 'second-instance', argumentsList: readonly string[]): void;
  emit(event: string, argumentsList: readonly string[] = []): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      if (event === 'second-instance') {
        listener(...([Object.freeze({}), argumentsList] as never[]));
      } else {
        listener(...([] as never[]));
      }
    }
  }

  setAsDefaultProtocolClient(scheme: string): boolean {
    this.defaultProtocols.push(scheme);
    return true;
  }

  setLoginItemSettings(settings: Readonly<{ openAtLogin: boolean; path: string }>): void {
    this.loginSettings.push(Object.freeze({ ...settings }));
  }
}

class FakeWindow implements ManagedWindow {
  readonly focus = vi.fn();
  readonly hide = vi.fn();
  readonly restore = vi.fn();
  readonly show = vi.fn();
  destroyed = false;
  minimized = false;
  closeHandler: ((event: Readonly<{ preventDefault(): void }>) => void) | undefined;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  on(event: 'close', listener: (event: Readonly<{ preventDefault(): void }>) => void): void {
    if (event === 'close') this.closeHandler = listener;
  }
}

class FakeTray implements TrayLike {
  readonly destroy = vi.fn();
  readonly setToolTip = vi.fn();
  readonly menus: Array<readonly TrayMenuItem[]> = [];
  clickHandler: (() => void) | undefined;

  on(event: 'click', listener: () => void): void {
    if (event === 'click') this.clickHandler = listener;
  }

  setContextMenu(menu: unknown): void {
    this.menus.push(menu as readonly TrayMenuItem[]);
  }
}

const createTrayHarness = () => {
  const tray = new FakeTray();
  const runtime: TrayRuntime = {
    createTray: () => tray,
    buildMenu: (template) => template,
  };
  return Object.freeze({ tray, runtime });
};

const latestMenu = (tray: FakeTray): readonly TrayMenuItem[] => tray.menus.at(-1) ?? [];

const clickMenu = async (tray: FakeTray, label: string): Promise<void> => {
  const item = latestMenu(tray).find((candidate) => candidate.label === label);
  expect(item).toBeDefined();
  await item?.click?.();
};

describe('Electron desktop lifecycle', () => {
  it('prevents quit until asynchronous runtime drain and database close complete', async () => {
    const app = new FakeApp();
    const listeners = vi.spyOn(app, 'on');
    const trayHarness = createTrayHarness();
    let release: () => void = () => undefined;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closed = vi.fn();
    await runDesktopLifecycle({
      app,
      argumentsList: [],
      platform: 'win32',
      executablePath: 'StudyApp.exe',
      isPackaged: false,
      initialPreferences: { processingPaused: false, autoStart: false },
      beforeQuit: async () => {
        await drained;
        closed();
      },
      createWindow: async () => new FakeWindow(),
      createTray: (options) => registerTray(options, trayHarness.runtime),
      dispatchAction: vi.fn(),
      persistProcessingPaused: vi.fn(),
      persistAutoStart: vi.fn(),
    });
    const beforeQuit = listeners.mock.calls.find(([name]) => name === 'before-quit')?.[1];
    const event = { preventDefault: vi.fn() };
    beforeQuit?.(...([event] as never[]));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    beforeQuit?.(...([event] as never[]));
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    release();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(closed).toHaveBeenCalledOnce();
    beforeQuit?.(...([event] as never[]));
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['production', false],
    ['test', true],
  ] as const)('disables the GPU process before readiness in %s mode', (_mode, testMode) => {
    const calls: string[] = [];
    const app = {
      commandLine: {
        appendSwitch: (name: string) => calls.push(`switch:${name}`),
      },
      disableHardwareAcceleration: () => calls.push('disable-hardware-acceleration'),
      setPath: (name: string, value: string) => calls.push(`path:${name}:${value}`),
    };

    configureElectronRuntime(
      app,
      Object.freeze({
        testMode,
        userDataPath: 'C:\\StudyApp\\user-data',
      }),
    );

    expect(calls).toEqual([
      'disable-hardware-acceleration',
      'switch:disable-gpu',
      ...(testMode ? ['path:userData:C:\\StudyApp\\user-data'] : []),
    ]);
  });

  it('owns one instance, dispatches validated links, hides on close, and quits explicitly', async () => {
    const app = new FakeApp();
    const window = new FakeWindow();
    const trayHarness = createTrayHarness();
    const dispatched = vi.fn();
    const persistedPauses: boolean[] = [];
    const persistedAutoStarts: boolean[] = [];
    const beforeReady = vi.fn();
    const afterReady = vi.fn(async () => undefined);

    const lifecycle = await runDesktopLifecycle({
      app,
      argumentsList: ['Lecture Study Assistant.exe', DEEP_LINK],
      platform: 'win32',
      executablePath: 'C:\\Program Files\\StudyApp\\StudyApp.exe',
      isPackaged: true,
      initialPreferences: Object.freeze({ processingPaused: false, autoStart: false }),
      beforeReady,
      afterReady,
      createWindow: async () => window,
      createTray: (options) => registerTray(options, trayHarness.runtime),
      dispatchAction: dispatched,
      persistProcessingPaused: async (paused) => {
        persistedPauses.push(paused);
      },
      persistAutoStart: async (enabled) => {
        persistedAutoStarts.push(enabled);
      },
    });

    expect(lifecycle.primary).toBe(true);
    expect(beforeReady).toHaveBeenCalledOnce();
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(app.defaultProtocols).toEqual(['studyapp']);
    expect(app.whenReady).toHaveBeenCalledOnce();
    expect(afterReady).toHaveBeenCalledOnce();
    expect(app.loginSettings).toEqual([
      {
        openAtLogin: false,
        path: 'C:\\Program Files\\StudyApp\\StudyApp.exe',
      },
    ]);
    expect(dispatched).toHaveBeenCalledWith(
      { type: 'play', sourceId: SOURCE_ID, seconds: 125.5 },
      window,
    );

    expect(latestMenu(trayHarness.tray).map((item) => item.label)).toEqual([
      '열기',
      '대기열 상태: 처리 중',
      '처리 일시정지',
      'Windows 시작 시 실행',
      '종료',
    ]);

    const closeEvent = { preventDefault: vi.fn() };
    window.closeHandler?.(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();

    await clickMenu(trayHarness.tray, '처리 일시정지');
    expect(persistedPauses).toEqual([true]);
    expect(latestMenu(trayHarness.tray).map((item) => item.label)).toContain('처리 재개');
    expect(latestMenu(trayHarness.tray).map((item) => item.label)).toContain(
      '대기열 상태: 일시정지',
    );

    await clickMenu(trayHarness.tray, 'Windows 시작 시 실행');
    expect(persistedAutoStarts).toEqual([true]);
    expect(app.loginSettings.at(-1)).toEqual({
      openAtLogin: true,
      path: 'C:\\Program Files\\StudyApp\\StudyApp.exe',
    });
    expect(
      latestMenu(trayHarness.tray).find((item) => item.label === 'Windows 시작 시 실행'),
    ).toMatchObject({ type: 'checkbox', checked: true });

    app.emit('second-instance', ['StudyApp.exe', `studyapp://play/${SOURCE_ID}?t=9`]);
    await vi.waitFor(() =>
      expect(dispatched).toHaveBeenLastCalledWith(
        { type: 'play', sourceId: SOURCE_ID, seconds: 9 },
        window,
      ),
    );
    expect(window.show).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();

    const callsBeforeInvalidLink = dispatched.mock.calls.length;
    app.emit('second-instance', ['StudyApp.exe', 'studyapp://play/not-a-uuid?t=9']);
    expect(dispatched).toHaveBeenCalledTimes(callsBeforeInvalidLink);

    await clickMenu(trayHarness.tray, '열기');
    trayHarness.tray.clickHandler?.();
    expect(window.show).toHaveBeenCalled();

    await clickMenu(trayHarness.tray, '종료');
    expect(app.quit).toHaveBeenCalledOnce();
    app.emit('before-quit');
    expect(trayHarness.tray.destroy).toHaveBeenCalledOnce();
    const quitCloseEvent = { preventDefault: vi.fn() };
    window.closeHandler?.(quitCloseEvent);
    expect(quitCloseEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('stops before readiness when another instance owns the lock', async () => {
    const app = new FakeApp();
    app.requestSingleInstanceLock.mockReturnValue(false);
    const createWindow = vi.fn(async () => new FakeWindow());
    const createTrayRegistration = vi.fn();

    const lifecycle = await runDesktopLifecycle({
      app,
      argumentsList: ['StudyApp.exe'],
      platform: 'win32',
      executablePath: 'StudyApp.exe',
      isPackaged: true,
      initialPreferences: Object.freeze({ processingPaused: false, autoStart: false }),
      beforeReady: vi.fn(),
      afterReady: vi.fn(),
      createWindow,
      createTray: createTrayRegistration,
      dispatchAction: vi.fn(),
      persistProcessingPaused: vi.fn(),
      persistAutoStart: vi.fn(),
    });

    expect(lifecycle).toEqual({ primary: false });
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(app.defaultProtocols).toEqual([]);
    expect(createWindow).not.toHaveBeenCalled();
    expect(createTrayRegistration).not.toHaveBeenCalled();
  });

  it('recreates a destroyed window on activation and keeps invalid arguments inert', async () => {
    const app = new FakeApp();
    const firstWindow = new FakeWindow();
    const replacementWindow = new FakeWindow();
    const windows = [firstWindow, replacementWindow];
    const createWindow = vi.fn(async () => windows.shift() ?? replacementWindow);
    const dispatched = vi.fn();
    const trayHarness = createTrayHarness();

    await runDesktopLifecycle({
      app,
      argumentsList: ['StudyApp.exe', 'studyapp://play/not-a-uuid?t=1'],
      platform: 'linux',
      executablePath: '/opt/study-app',
      isPackaged: false,
      initialPreferences: Object.freeze({ processingPaused: true, autoStart: true }),
      createWindow,
      createTray: (options) => registerTray(options, trayHarness.runtime),
      dispatchAction: dispatched,
      persistProcessingPaused: vi.fn(),
      persistAutoStart: vi.fn(),
    });

    expect(app.defaultProtocols).toEqual([]);
    expect(app.loginSettings).toEqual([]);
    expect(dispatched).not.toHaveBeenCalled();

    firstWindow.destroyed = true;
    app.emit('activate');
    await vi.waitFor(() => expect(replacementWindow.show).toHaveBeenCalledOnce());
    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(replacementWindow.focus).toHaveBeenCalledOnce();
  });

  it('contains tray action failures and leaves the displayed state unchanged', async () => {
    const trayHarness = createTrayHarness();
    const errors: unknown[] = [];
    let paused = false;

    registerTray(
      {
        showWindow: vi.fn(),
        getProcessingPaused: () => paused,
        getAutoStart: () => false,
        pauseQueue: async () => {
          throw new Error('private failure');
        },
        resumeQueue: async () => {
          paused = false;
        },
        setAutoStart: vi.fn(),
        quit: vi.fn(),
        onError: (error) => errors.push(error),
      },
      trayHarness.runtime,
    );

    await clickMenu(trayHarness.tray, '처리 일시정지');
    expect(errors).toHaveLength(1);
    expect(latestMenu(trayHarness.tray).map((item) => item.label)).toContain('처리 일시정지');
  });

  it('applies login settings only to a packaged Windows executable', () => {
    const app = new FakeApp();

    expect(applyWindowsAutoStart(app, false, 'win32', 'app.exe', true)).toBe(false);
    expect(applyWindowsAutoStart(app, true, 'linux', '/app', true)).toBe(false);
    expect(applyWindowsAutoStart(app, true, 'win32', 'app.exe', true)).toBe(true);
    expect(app.loginSettings).toEqual([{ openAtLogin: true, path: 'app.exe' }]);
  });

  it('persists pause and Windows startup preferences across a database reopen', async () => {
    await withTempDirectory((directory) => {
      const databasePath = join(directory, 'study.sqlite3');
      const firstDatabase = openDatabase(databasePath);
      const firstStore = createLifecyclePreferenceStore(
        createRepositories(firstDatabase).settings,
        () => '2026-09-02T00:00:00.000Z',
      );

      expect(firstStore.load()).toEqual({ processingPaused: false, autoStart: false });
      expect(firstStore.setProcessingPaused(true)).toEqual({
        processingPaused: true,
        autoStart: false,
      });
      expect(firstStore.setAutoStart(true)).toEqual({ processingPaused: true, autoStart: true });
      firstDatabase.close();

      const reopenedDatabase = openDatabase(databasePath);
      try {
        const reopenedStore = createLifecyclePreferenceStore(
          createRepositories(reopenedDatabase).settings,
          () => '2026-09-02T01:00:00.000Z',
        );
        expect(reopenedStore.load()).toEqual({ processingPaused: true, autoStart: true });
      } finally {
        reopenedDatabase.close();
      }
    });
  });
});
