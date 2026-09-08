import type { MenuItemConstructorOptions } from 'electron';

export type TrayMenuItem = Readonly<{
  label: string;
  type?: 'normal' | 'checkbox';
  enabled?: boolean;
  checked?: boolean;
  click?: () => void | Promise<void>;
}>;

export type TrayLike = Readonly<{
  destroy(): void;
  on(event: 'click', listener: () => void): unknown;
  setContextMenu(menu: unknown): void;
  setToolTip(toolTip: string): void;
}>;

export type TrayRuntime = Readonly<{
  createTray(): TrayLike;
  buildMenu(template: readonly TrayMenuItem[]): unknown;
}>;

export type TrayRegistrationOptions = Readonly<{
  showWindow(): void;
  getProcessingPaused(): boolean;
  getAutoStart(): boolean;
  pauseQueue(): void | Promise<void>;
  resumeQueue(): void | Promise<void>;
  setAutoStart(enabled: boolean): void | Promise<void>;
  quit(): void;
  onError?(error: unknown): void;
}>;

export type RegisteredTray = Readonly<{
  tray: TrayLike;
  destroy(): void;
  refresh(): void;
}>;

const runTrayAction = async (
  action: () => void | Promise<void>,
  refresh: () => void,
  onError: (error: unknown) => void,
): Promise<void> => {
  try {
    await action();
    refresh();
  } catch (error) {
    onError(error);
  }
};

export const registerTray = (
  options: TrayRegistrationOptions,
  runtime: TrayRuntime,
): RegisteredTray => {
  const tray = runtime.createTray();
  const onError = options.onError ?? (() => undefined);

  const refresh = (): void => {
    const processingPaused = options.getProcessingPaused();
    const template: readonly TrayMenuItem[] = Object.freeze([
      Object.freeze({ label: '열기', click: options.showWindow }),
      Object.freeze({
        label: processingPaused ? '대기열 상태: 일시정지' : '대기열 상태: 처리 중',
        enabled: false,
      }),
      Object.freeze({
        label: processingPaused ? '처리 재개' : '처리 일시정지',
        click: () =>
          runTrayAction(
            processingPaused ? options.resumeQueue : options.pauseQueue,
            refresh,
            onError,
          ),
      }),
      Object.freeze({
        label: 'Windows 시작 시 실행',
        type: 'checkbox' as const,
        checked: options.getAutoStart(),
        click: () =>
          runTrayAction(() => options.setAutoStart(!options.getAutoStart()), refresh, onError),
      }),
      Object.freeze({ label: '종료', click: options.quit }),
    ]);
    tray.setContextMenu(runtime.buildMenu(template));
  };

  tray.setToolTip('Lecture Study Assistant');
  tray.on('click', options.showWindow);
  refresh();
  return Object.freeze({ tray, destroy: () => tray.destroy(), refresh });
};

export const registerElectronTray = async (
  options: TrayRegistrationOptions,
  iconPath: string,
): Promise<RegisteredTray> => {
  const { Menu, nativeImage, Tray } = await import('electron');
  const icon = nativeImage.createFromPath(iconPath);
  const tray = new Tray(icon);

  return registerTray(options, {
    createTray: () => tray,
    buildMenu: (template) => Menu.buildFromTemplate([...template] as MenuItemConstructorOptions[]),
  });
};
