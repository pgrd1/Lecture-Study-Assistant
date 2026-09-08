import { describe, expect, it, vi } from 'vitest';
import {
  createMainWindow,
  createMainWindowOptions,
  installNavigationPolicy,
  installPermissionPolicy,
  isTrustedRendererNavigation,
} from '../../../src/main/window';

describe('main window security policy', () => {
  it('isolates and sandboxes the renderer without Node.js access', () => {
    const options = createMainWindowOptions('C:\\app\\preload.js');

    expect(options.autoHideMenuBar).toBe(true);
    expect(options.webPreferences).toMatchObject({
      preload: 'C:\\app\\preload.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });

  it('allows only the trusted renderer document and its hash routes', () => {
    const trusted = 'file:///C:/app/renderer/main_window/index.html';

    expect(isTrustedRendererNavigation(trusted, trusted)).toBe(true);
    expect(isTrustedRendererNavigation(`${trusted}#settings`, trusted)).toBe(true);
    expect(
      isTrustedRendererNavigation('file:///C:/app/renderer/main_window/other.html', trusted),
    ).toBe(false);
    expect(isTrustedRendererNavigation('https://example.com/', trusted)).toBe(false);
    expect(isTrustedRendererNavigation('not a URL', trusted)).toBe(false);
  });

  it('blocks popups and prevents untrusted navigation', () => {
    const navigationHandlers = new Map<
      'will-navigate' | 'will-redirect',
      (event: { preventDefault(): void }, navigationUrl: string) => void
    >();
    let windowOpenHandler: (() => { action: 'deny' }) | undefined;
    const webContents = {
      on: vi.fn(
        (
          event: 'will-navigate' | 'will-redirect',
          handler: (event: { preventDefault(): void }, navigationUrl: string) => void,
        ) => {
          navigationHandlers.set(event, handler);
        },
      ),
      setWindowOpenHandler: vi.fn((handler: () => { action: 'deny' }) => {
        windowOpenHandler = handler;
      }),
    };
    const trusted = 'http://localhost:5173/';

    installNavigationPolicy(webContents, trusted);

    expect(windowOpenHandler?.()).toEqual({ action: 'deny' });
    expect(webContents.on).toHaveBeenCalledTimes(2);

    const trustedEvent = { preventDefault: vi.fn() };
    navigationHandlers.get('will-navigate')?.(trustedEvent, `${trusted}#courses`);
    expect(trustedEvent.preventDefault).not.toHaveBeenCalled();

    const externalEvent = { preventDefault: vi.fn() };
    navigationHandlers.get('will-redirect')?.(externalEvent, 'https://example.com/');
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it('denies every browser permission request and permission check by default', () => {
    let checkHandler: (() => boolean) | undefined;
    let requestHandler: ((callback: (allowed: boolean) => void) => void) | undefined;
    const permissionSession = {
      setPermissionCheckHandler: vi.fn((handler: () => boolean) => {
        checkHandler = handler;
      }),
      setPermissionRequestHandler: vi.fn(
        (
          handler: (
            webContents: unknown,
            permission: string,
            callback: (allowed: boolean) => void,
          ) => void,
        ) => {
          requestHandler = (callback) => handler(undefined, 'media', callback);
        },
      ),
    };

    installPermissionPolicy(permissionSession);

    expect(checkHandler?.()).toBe(false);
    const callback = vi.fn();
    requestHandler?.(callback);
    expect(callback).toHaveBeenCalledWith(false);
  });

  it('loads a trusted URL through a hidden, menu-less window', async () => {
    const instances: MockBrowserWindow[] = [];

    class MockBrowserWindow {
      readonly loadFile = vi.fn(async () => undefined);
      readonly loadURL = vi.fn(async () => undefined);
      readonly once = vi.fn((_event: string, handler: () => void) => handler());
      readonly setMenuBarVisibility = vi.fn();
      readonly show = vi.fn();
      readonly webContents = {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      };

      constructor(readonly options: unknown) {
        instances.push(this);
      }
    }

    vi.doMock('electron', () => ({ BrowserWindow: MockBrowserWindow }));

    const urlWindow = (await createMainWindow(
      'C:\\app\\preload.js',
      'studyapp-renderer://app/index.html',
    )) as unknown as MockBrowserWindow;

    expect(instances).toHaveLength(1);
    expect(urlWindow.loadURL).toHaveBeenCalledWith('studyapp-renderer://app/index.html');
    expect(urlWindow.loadFile).not.toHaveBeenCalled();
    expect(urlWindow.setMenuBarVisibility).toHaveBeenCalledWith(false);
    expect(urlWindow.show).toHaveBeenCalledOnce();
  });

  it('configures lifecycle policy before the window can become visible', async () => {
    const order: string[] = [];

    class OrderedBrowserWindow {
      readonly loadURL = vi.fn(async () => {
        order.push('load');
      });
      readonly once = vi.fn((_event: string, handler: () => void) => {
        order.push('ready-listener');
        handler();
      });
      readonly setMenuBarVisibility = vi.fn();
      readonly show = vi.fn(() => {
        order.push('show');
      });
      readonly webContents = {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      };
    }

    vi.doMock('electron', () => ({ BrowserWindow: OrderedBrowserWindow }));

    await createMainWindow('C:\\app\\preload.js', 'studyapp-renderer://app/index.html', () => {
      order.push('configure');
    });

    expect(order).toEqual(['configure', 'ready-listener', 'show', 'load']);
  });
});
