export type FakeInvokeEvent = Readonly<{
  sender: Readonly<{
    getURL(): string;
    mainFrame: object;
  }>;
  senderFrame: Readonly<{ url: string }>;
}>;

export const fakeInvokeEvent = (
  url: string,
  options: Readonly<{ subframe?: boolean }> = {},
): FakeInvokeEvent => {
  const mainFrame = Object.freeze({ url });
  const senderFrame = options.subframe ? Object.freeze({ url }) : mainFrame;
  return Object.freeze({
    sender: Object.freeze({ getURL: () => url, mainFrame }),
    senderFrame,
  });
};

type IpcHandler = (event: FakeInvokeEvent, input: unknown) => unknown | Promise<unknown>;

export class FakeIpcMain {
  readonly handlers = new Map<string, IpcHandler>();

  handle(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) {
      throw new TypeError('DUPLICATE_FAKE_IPC_HANDLER');
    }
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(channel: string, event: FakeInvokeEvent, input: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) {
      throw new TypeError('MISSING_FAKE_IPC_HANDLER');
    }
    return handler(event, input);
  }
}

type RendererListener = (event: unknown, payload: unknown) => void;

export class FakeIpcRenderer {
  readonly failures = new Map<string, unknown>();
  readonly invocations: Array<Readonly<{ channel: string; input: unknown }>> = [];
  readonly responses = new Map<string, unknown>();
  readonly #listeners = new Map<string, Set<RendererListener>>();

  async invoke(channel: string, input: unknown): Promise<unknown> {
    this.invocations.push(Object.freeze({ channel, input }));
    if (this.failures.has(channel)) {
      throw this.failures.get(channel);
    }
    return this.responses.get(channel);
  }

  on(channel: string, listener: RendererListener): this {
    const listeners = new Set(this.#listeners.get(channel) ?? []);
    listeners.add(listener);
    this.#listeners.set(channel, listeners);
    return this;
  }

  removeListener(channel: string, listener: RendererListener): this {
    const listeners = new Set(this.#listeners.get(channel) ?? []);
    listeners.delete(listener);
    this.#listeners.set(channel, listeners);
    return this;
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of this.#listeners.get(channel) ?? []) {
      listener(Object.freeze({}), payload);
    }
  }

  reset(): void {
    this.failures.clear();
    this.invocations.length = 0;
    this.responses.clear();
    this.#listeners.clear();
  }
}

export type FakeOpenDialogResult = Readonly<{
  canceled: boolean;
  filePaths: readonly string[];
}>;

export type FakeSaveDialogResult = Readonly<{
  canceled: boolean;
  filePath?: string;
}>;

export class FakeDialog {
  readonly openCalls: unknown[] = [];
  readonly openResults: FakeOpenDialogResult[] = [];
  readonly saveCalls: unknown[] = [];
  readonly saveResults: FakeSaveDialogResult[] = [];

  async showOpenDialog(options: unknown): Promise<FakeOpenDialogResult> {
    this.openCalls.push(options);
    return this.openResults.shift() ?? Object.freeze({ canceled: true, filePaths: [] });
  }

  async showSaveDialog(options: unknown): Promise<FakeSaveDialogResult> {
    this.saveCalls.push(options);
    return this.saveResults.shift() ?? Object.freeze({ canceled: true });
  }
}

export class FakeAppLifecycle {
  readonly loginSettings: Array<Readonly<{ openAtLogin: boolean; path?: string }>> = [];
  readonly #handlers = new Map<string, Set<() => void>>();

  on(event: string, handler: () => void): void {
    const handlers = new Set(this.#handlers.get(event) ?? []);
    handlers.add(handler);
    this.#handlers.set(event, handlers);
  }

  emit(event: string): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler();
    }
  }

  setLoginItemSettings(settings: Readonly<{ openAtLogin: boolean; path?: string }>): void {
    this.loginSettings.push(Object.freeze({ ...settings }));
  }
}
