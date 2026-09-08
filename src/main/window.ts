import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

type NavigationEvent = Readonly<{
  preventDefault(): void;
}>;

type WindowCloseEvent = Readonly<{
  preventDefault(): void;
}>;

export type ManagedWindow = Readonly<{
  focus(): void;
  hide(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  on(event: 'close', listener: (event: WindowCloseEvent) => void): unknown;
  restore(): void;
  show(): void;
}>;

type NavigationHandler = (event: NavigationEvent, navigationUrl: string) => void;

export type NavigationWebContents = Readonly<{
  on(event: 'will-navigate' | 'will-redirect', handler: NavigationHandler): unknown;
  setWindowOpenHandler(handler: () => Readonly<{ action: 'deny' }>): unknown;
}>;

export type PermissionPolicySession = Readonly<{
  setPermissionCheckHandler(handler: () => boolean): unknown;
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (allowed: boolean) => void,
    ) => void,
  ): unknown;
}>;

export const createMainWindowOptions = (
  preloadPath: string,
): Readonly<BrowserWindowConstructorOptions> => ({
  width: 1180,
  height: 760,
  minWidth: 880,
  minHeight: 600,
  show: false,
  autoHideMenuBar: true,
  backgroundColor: '#0b1220',
  webPreferences: {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  },
});

const withoutHash = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
};

export const isTrustedRendererNavigation = (
  navigationUrl: string,
  trustedRendererUrl: string,
): boolean => {
  const normalizedNavigationUrl = withoutHash(navigationUrl);
  const normalizedTrustedUrl = withoutHash(trustedRendererUrl);

  return normalizedNavigationUrl !== undefined && normalizedNavigationUrl === normalizedTrustedUrl;
};

export const installNavigationPolicy = (
  webContents: NavigationWebContents,
  trustedRendererUrl: string,
): void => {
  const denyUntrustedNavigation: NavigationHandler = (event, navigationUrl) => {
    if (!isTrustedRendererNavigation(navigationUrl, trustedRendererUrl)) {
      event.preventDefault();
    }
  };

  webContents.on('will-navigate', denyUntrustedNavigation);
  webContents.on('will-redirect', denyUntrustedNavigation);
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
};

export const installPermissionPolicy = (permissionSession: PermissionPolicySession): void => {
  permissionSession.setPermissionCheckHandler(() => false);
  permissionSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
};

export const showManagedWindow = (window: ManagedWindow): boolean => {
  if (window.isDestroyed()) {
    return false;
  }

  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
  return true;
};

export const installCloseToTrayPolicy = (
  window: ManagedWindow,
  shouldQuit: () => boolean,
): void => {
  window.on('close', (event) => {
    if (shouldQuit()) {
      return;
    }

    event.preventDefault();
    window.hide();
  });
};

export const createMainWindow = async (
  preloadPath: string,
  rendererUrl: string,
  configureWindow: (window: BrowserWindow) => void = () => undefined,
): Promise<BrowserWindow> => {
  const { BrowserWindow } = await import('electron');
  const mainWindow = new BrowserWindow(createMainWindowOptions(preloadPath));
  const trustedRendererUrl = new URL(rendererUrl).href;

  configureWindow(mainWindow);
  mainWindow.setMenuBarVisibility(false);
  installNavigationPolicy(mainWindow.webContents, trustedRendererUrl);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  await mainWindow.loadURL(trustedRendererUrl);

  return mainWindow;
};
