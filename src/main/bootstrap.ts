import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { DiagnosticsService } from '../application/diagnostics/diagnosticsService';
import { assertNoReparsePoints } from '../core/paths/safePath';
import {
  createRepositories,
  openDatabase,
  type SqliteDatabase,
} from '../infrastructure/db/sqliteDatabase';
import {
  createElectronSafeStorageEncryptor,
  ElectronSecretStore,
} from '../infrastructure/secrets/electronSecretStore';
import { APP_METADATA } from '../shared/appMetadata';
import { type BootstrapState, IPC_CHANNELS } from '../shared/contracts/ipc';
import {
  type ContentPipelineRuntime,
  createContentPipelineRuntime,
} from './contentPipelineRuntime';
import { FoundationApplication } from './foundationApplication';
import { registerIpc } from './ipc/registerIpc';
import {
  createLifecyclePreferenceStore,
  type LifecyclePreferenceStore,
  type LifecyclePreferences,
} from './lifecyclePreferences';
import {
  findStudyAppAction,
  registerStudyAppProtocolClient,
  type StudyAppAction,
} from './protocol';
import { createProviderRuntime, type ProviderRuntime } from './providerRuntime';
import {
  installRendererProtocol,
  RENDERER_ENTRY_URL,
  registerRendererScheme,
} from './rendererProtocol';
import { resolveRuntimePaths } from './runtimePaths';
import { type RegisteredTray, registerElectronTray, type TrayRegistrationOptions } from './tray';
import {
  createMainWindow,
  installCloseToTrayPolicy,
  installPermissionPolicy,
  type ManagedWindow,
  showManagedWindow,
} from './window';

export type { ManagedWindow } from './window';

export const STUDY_APP_ACTION_CHANNEL = 'study:deep-link-action';

type AppListener = (...argumentsList: unknown[]) => void;

export type DesktopAppFacade = Readonly<{
  on(event: string, listener: AppListener): void;
  quit(): void;
  requestSingleInstanceLock(): boolean;
  setAsDefaultProtocolClient(scheme: string): boolean;
  setLoginItemSettings(settings: Readonly<{ openAtLogin: boolean; path: string }>): void;
  whenReady(): Promise<void>;
}>;

type ElectronRuntimeApp = Readonly<{
  commandLine: Readonly<{
    appendSwitch(name: string): void;
  }>;
  disableHardwareAcceleration(): void;
  setPath(name: 'userData', path: string): void;
}>;

type ElectronRuntimePaths = Readonly<{
  testMode: boolean;
  userDataPath: string;
}>;

export const configureElectronRuntime = (
  app: ElectronRuntimeApp,
  runtimePaths: ElectronRuntimePaths,
): void => {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  if (runtimePaths.testMode) app.setPath('userData', runtimePaths.userDataPath);
};

export type DesktopLifecycleOptions = Readonly<{
  app: DesktopAppFacade;
  argumentsList: readonly string[];
  platform: NodeJS.Platform;
  executablePath: string;
  isPackaged: boolean;
  initialPreferences: LifecyclePreferences;
  loadPreferences?(): LifecyclePreferences | Promise<LifecyclePreferences>;
  beforeReady?(): void;
  afterReady?(): void | Promise<void>;
  beforeQuit?(): void | Promise<void>;
  createWindow(configureWindow: (window: ManagedWindow) => void): Promise<ManagedWindow>;
  createTray(options: TrayRegistrationOptions): RegisteredTray | Promise<RegisteredTray>;
  dispatchAction(action: StudyAppAction, window: ManagedWindow): void;
  persistProcessingPaused(paused: boolean): void | Promise<void>;
  persistAutoStart(enabled: boolean): void | Promise<void>;
  onError?(error: unknown): void;
}>;

export type DesktopLifecycleResult =
  | Readonly<{ primary: false }>
  | Readonly<{
      primary: true;
      tray: RegisteredTray;
      getWindow(): ManagedWindow | undefined;
      reloadPreferences(): Promise<void>;
    }>;

export const applyWindowsAutoStart = (
  app: Pick<DesktopAppFacade, 'setLoginItemSettings'>,
  isPackaged: boolean,
  platform: NodeJS.Platform,
  executablePath: string,
  enabled: boolean,
): boolean => {
  if (!isPackaged || platform !== 'win32') {
    return false;
  }

  app.setLoginItemSettings({ openAtLogin: enabled, path: executablePath });
  return true;
};

export const runDesktopLifecycle = async (
  options: DesktopLifecycleOptions,
): Promise<DesktopLifecycleResult> => {
  options.beforeReady?.();
  if (!options.app.requestSingleInstanceLock()) {
    options.app.quit();
    return Object.freeze({ primary: false });
  }

  registerStudyAppProtocolClient(options.app, options.isPackaged);

  let quitting = false;
  let quitReady = false;
  let quitPending = false;
  let initialized = false;
  let window: ManagedWindow | undefined;
  let openingWindow: Promise<ManagedWindow> | undefined;
  let pendingShow = false;
  let pendingAction = findStudyAppAction(options.argumentsList);
  const onError = options.onError ?? (() => undefined);
  let preferences = Object.freeze({ ...options.initialPreferences });
  let registeredTray: RegisteredTray | undefined;

  const reloadPreferences = async (): Promise<void> => {
    if (options.loadPreferences !== undefined) {
      preferences = Object.freeze({ ...(await options.loadPreferences()) });
      registeredTray?.refresh();
    }
  };

  const ensureWindow = async (): Promise<ManagedWindow> => {
    if (window !== undefined && !window.isDestroyed()) {
      return window;
    }
    if (openingWindow !== undefined) {
      return openingWindow;
    }

    let configuredWindow: ManagedWindow | undefined;
    const configureWindow = (createdWindow: ManagedWindow): void => {
      if (configuredWindow === createdWindow) {
        return;
      }
      configuredWindow = createdWindow;
      window = createdWindow;
      installCloseToTrayPolicy(createdWindow, () => quitting);
    };
    openingWindow = options.createWindow(configureWindow).then((createdWindow) => {
      configureWindow(createdWindow);
      return createdWindow;
    });
    try {
      return await openingWindow;
    } finally {
      openingWindow = undefined;
    }
  };

  const revealWindow = async (action?: StudyAppAction): Promise<void> => {
    const activeWindow = await ensureWindow();
    showManagedWindow(activeWindow);
    if (action !== undefined) {
      options.dispatchAction(action, activeWindow);
    }
  };

  options.app.on('second-instance', (_event, rawArguments) => {
    const argumentsList = Array.isArray(rawArguments)
      ? rawArguments.filter((value): value is string => typeof value === 'string')
      : [];
    const action = findStudyAppAction(argumentsList);
    if (!initialized) {
      pendingShow = true;
      pendingAction = action ?? pendingAction;
      return;
    }
    void revealWindow(action).catch(onError);
  });

  options.app.on('activate', () => {
    if (initialized) {
      void revealWindow().catch(onError);
    }
  });
  options.app.on('before-quit', (event) => {
    if (quitReady) return;
    const preventQuit = () => {
      if (
        event &&
        typeof event === 'object' &&
        'preventDefault' in event &&
        typeof event.preventDefault === 'function'
      )
        event.preventDefault();
    };
    if (quitPending) {
      preventQuit();
      return;
    }
    quitting = true;
    registeredTray?.destroy();
    const pending = options.beforeQuit?.();
    if (pending) {
      quitPending = true;
      preventQuit();
      void pending
        .then(() => {
          quitReady = true;
          options.app.quit();
        })
        .catch((error) => {
          quitPending = false;
          quitting = false;
          onError(error);
        });
    } else quitReady = true;
  });

  await options.app.whenReady();
  await options.afterReady?.();
  await reloadPreferences();
  await ensureWindow();
  applyWindowsAutoStart(
    options.app,
    options.isPackaged,
    options.platform,
    options.executablePath,
    preferences.autoStart,
  );

  const refreshTray = (): void => registeredTray?.refresh();
  registeredTray = await options.createTray({
    showWindow: () => {
      void revealWindow().catch(onError);
    },
    getProcessingPaused: () => preferences.processingPaused,
    getAutoStart: () => preferences.autoStart,
    pauseQueue: async () => {
      await options.persistProcessingPaused(true);
      preferences = Object.freeze({ ...preferences, processingPaused: true });
      refreshTray();
    },
    resumeQueue: async () => {
      await options.persistProcessingPaused(false);
      preferences = Object.freeze({ ...preferences, processingPaused: false });
      refreshTray();
    },
    setAutoStart: async (enabled) => {
      applyWindowsAutoStart(
        options.app,
        options.isPackaged,
        options.platform,
        options.executablePath,
        enabled,
      );
      await options.persistAutoStart(enabled);
      preferences = Object.freeze({ ...preferences, autoStart: enabled });
      refreshTray();
    },
    quit: () => {
      quitting = true;
      options.app.quit();
    },
    onError,
  });
  initialized = true;

  if (pendingAction !== undefined || pendingShow) {
    await revealWindow(pendingAction);
    pendingAction = undefined;
    pendingShow = false;
  }

  return Object.freeze({
    primary: true,
    tray: registeredTray,
    getWindow: () => window,
    reloadPreferences,
  });
};

const rendererUrl = (): string => MAIN_WINDOW_VITE_DEV_SERVER_URL || RENDERER_ENTRY_URL;

export const bootstrap = async (): Promise<void> => {
  const { app, dialog, ipcMain, protocol, safeStorage, session } = await import('electron');
  const runtimePaths = resolveRuntimePaths({
    defaultUserDataPath: app.getPath('userData'),
    environment: process.env,
    e2eBuild: __STUDYAPP_E2E_BUILD__,
  });
  configureElectronRuntime(app, runtimePaths);
  app.setAppUserModelId(APP_METADATA.appId);

  let database: SqliteDatabase | undefined;
  let preferenceStore: LifecyclePreferenceStore | undefined;
  let foundationApplication: FoundationApplication | undefined;
  let contentRuntime: ContentPipelineRuntime | undefined;
  let providerRuntime: ProviderRuntime | undefined;
  let disposeIpc: (() => void) | undefined;
  let currentWindow: BrowserWindow | undefined;
  let lifecycleResult: DesktopLifecycleResult | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const desktopAppFacade: DesktopAppFacade = {
    on: (event, listener) => {
      app.on(event as never, listener as never);
    },
    quit: () => app.quit(),
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    setAsDefaultProtocolClient: (scheme) => app.setAsDefaultProtocolClient(scheme),
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
    whenReady: () => app.whenReady(),
  };

  const requirePreferenceStore = (): LifecyclePreferenceStore => {
    if (preferenceStore === undefined) {
      throw new TypeError('LIFECYCLE_PREFERENCES_UNAVAILABLE');
    }
    return preferenceStore;
  };
  const requireFoundationApplication = (): FoundationApplication => {
    if (foundationApplication === undefined) {
      throw new TypeError('FOUNDATION_APPLICATION_UNAVAILABLE');
    }
    return foundationApplication;
  };
  const sendState = (state: BootstrapState): void => {
    if (currentWindow !== undefined && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send(IPC_CHANNELS.stateChanged, state);
    }
  };
  const logOperationalError = (): void => {
    console.error('데스크톱 작업을 완료하지 못했습니다. 코드: LIFECYCLE_ACTION_FAILED');
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    foundationApplication?.stopPolling();
    disposeIpc?.();
    disposeIpc = undefined;
    shutdownPromise = (async () => {
      await (contentRuntime?.shutdown() ?? providerRuntime?.shutdown());
      await foundationApplication?.shutdown();
      contentRuntime = undefined;
      providerRuntime = undefined;
      foundationApplication = undefined;
      preferenceStore = undefined;
      database?.close();
      database = undefined;
    })().catch((error: unknown) => {
      shutdownPromise = undefined;
      throw error;
    });
    return shutdownPromise;
  };
  const reloadLifecyclePreferences = async (): Promise<void> => {
    if (lifecycleResult?.primary) {
      await lifecycleResult.reloadPreferences();
    }
  };

  try {
    lifecycleResult = await runDesktopLifecycle({
      app: desktopAppFacade,
      argumentsList: process.argv,
      platform: process.platform,
      executablePath: process.execPath,
      isPackaged: app.isPackaged && !runtimePaths.testMode,
      initialPreferences: Object.freeze({ processingPaused: false, autoStart: false }),
      loadPreferences: () => requirePreferenceStore().load(),
      beforeReady: () => registerRendererScheme(protocol),
      afterReady: async () => {
        const secretStore = new ElectronSecretStore(
          runtimePaths.secretsPath,
          createElectronSafeStorageEncryptor(safeStorage),
        );
        await mkdir(runtimePaths.stagingRoot, { recursive: true });
        database = openDatabase(runtimePaths.databasePath);
        const repositories = createRepositories(database);
        preferenceStore = createLifecyclePreferenceStore(repositories.settings);
        requirePreferenceStore().load();
        providerRuntime = createProviderRuntime({ paths: runtimePaths, repositories, secretStore });
        const artifactRoot = join(runtimePaths.userDataPath, 'pipeline-artifacts');
        assertNoReparsePoints(artifactRoot);
        await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
        contentRuntime = await createContentPipelineRuntime({
          repositories,
          userDataRoot: runtimePaths.userDataPath,
          artifactRoot,
          providerRuntime,
        });
        await providerRuntime.secureDirectory(artifactRoot, {
          requestId: randomUUID(),
          signal: AbortSignal.timeout(15_000),
        });
        const diagnostics = new DiagnosticsService({
          database,
          jobs: repositories.jobs,
          settings: repositories.settings,
          secrets: secretStore,
          runtime: {
            appVersion: app.getVersion(),
            electronVersion: process.versions.electron ?? 'unknown',
            nodeVersion: process.versions.node,
            platform: process.platform,
            arch: process.arch,
          },
        });
        foundationApplication = new FoundationApplication({
          processor: contentRuntime.compatibilityProcessor,
          pollQuestionInboxes: contentRuntime.pollQuestionInboxes,
          validateStorageRoots: contentRuntime.validateStorageRoots,
          repositories,
          stagingRoot: runtimePaths.stagingRoot,
          diagnostics,
          setAutoStart: async (enabled) => {
            applyWindowsAutoStart(
              desktopAppFacade,
              app.isPackaged && !runtimePaths.testMode,
              process.platform,
              process.execPath,
              enabled,
            );
            requirePreferenceStore().setAutoStart(enabled);
            await reloadLifecyclePreferences();
          },
          onStateChanged: sendState,
          onOperationalError: logOperationalError,
        });
        await requireFoundationApplication().initialize();
        installPermissionPolicy(session.defaultSession);
        await installRendererProtocol(
          protocol,
          join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
        );
        disposeIpc = registerIpc({
          ipcMain,
          dialog,
          application: requireFoundationApplication(),
          trustedRendererUrl: new URL(rendererUrl()).href,
        });
      },
      beforeQuit: shutdown,
      createWindow: async (configureWindow) => {
        currentWindow = await createMainWindow(
          join(__dirname, 'preload.js'),
          rendererUrl(),
          (window) => {
            currentWindow = window;
            configureWindow(window);
          },
        );
        return currentWindow;
      },
      createTray: (options) =>
        registerElectronTray(options, join(app.getAppPath(), 'assets', 'icon.svg')),
      dispatchAction: (action, window) => {
        (window as BrowserWindow).webContents.send(STUDY_APP_ACTION_CHANNEL, action);
      },
      persistProcessingPaused: (paused) => {
        requirePreferenceStore().setProcessingPaused(paused);
        void requireFoundationApplication().refreshState().catch(logOperationalError);
      },
      persistAutoStart: (enabled) => {
        requirePreferenceStore().setAutoStart(enabled);
        void requireFoundationApplication().refreshState().catch(logOperationalError);
      },
      onError: logOperationalError,
    });
    if (lifecycleResult.primary) {
      await lifecycleResult.reloadPreferences();
      requireFoundationApplication().startPolling();
    }
  } catch (error) {
    await shutdown();
    throw error;
  }
};
