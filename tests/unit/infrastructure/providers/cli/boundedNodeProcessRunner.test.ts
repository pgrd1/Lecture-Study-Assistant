import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProviderConnectionOperation } from '../../../../../src/core/ports/aiProvider';
import type { CliProcessRequest } from '../../../../../src/core/ports/cliProcessRunner';
import {
  type CliChildProcess,
  type CliSpawnFacade,
  type CliSpawnOptions,
  createBoundedNodeProcessRunnerForTest,
  MAX_CLI_STDIN_BYTES,
} from '../../../../../src/infrastructure/providers/cli/boundedNodeProcessRunner';
import { createCliExecutableInspectorForTest } from '../../../../../src/infrastructure/providers/cli/cliExecutableInspector';
import {
  createWindowsProcessTreeTerminatorForTest,
  WINDOWS_TASKKILL_PATH,
} from '../../../../../src/infrastructure/providers/cli/nodeCliProcessRunner';
import { createWindowsKnownFoldersForTest } from '../../../../../src/infrastructure/providers/cli/windowsKnownFolders';
import {
  runVerifiedWindowsPowerShell,
  WINDOWS_POWERSHELL_PATH,
} from '../../../../../src/infrastructure/providers/cli/windowsPowerShell';
import {
  createWindowsSubstMappingPortForTest,
  WINDOWS_SUBST_PATH,
} from '../../../../../src/infrastructure/providers/cli/windowsWorkspaceAlias';

type Listener = (...args: never[]) => void;

class ControlledStream {
  readonly #listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped = (...args: never[]) => {
      this.#listeners.set(
        event,
        (this.#listeners.get(event) ?? []).filter((entry) => entry !== wrapped),
      );
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event: string, ...args: never[]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(...args);
  }
}

class SuccessfulChild implements CliChildProcess {
  readonly pid = 4321;
  readonly stdout = new ControlledStream();
  readonly stderr = new ControlledStream();
  readonly stdin = Object.assign(new ControlledStream(), {
    end: (data?: Uint8Array) => {
      queueMicrotask(() => {
        this.stdin.emit('finish');
        this.stdout.emit('data', (data ?? new Uint8Array()) as never);
        this.exitCode = 0;
        this.#events.emit('close', 0 as never);
      });
    },
  });
  exitCode: number | null = null;
  readonly #events = new ControlledStream();

  once(event: 'close' | 'error', listener: Listener): this {
    this.#events.once(event, listener);
    return this;
  }

  kill(): boolean {
    this.exitCode = 1;
    return true;
  }
}

class ScriptedChild implements CliChildProcess {
  readonly pid = 4321;
  readonly stdout = new ControlledStream();
  readonly stderr = new ControlledStream();
  readonly stdin = Object.assign(new ControlledStream(), {
    end: () => {
      queueMicrotask(() => {
        const response = this.#response();
        this.stdin.emit('finish');
        if (response.stdout.length > 0) this.stdout.emit('data', response.stdout as never);
        if (response.stderr.length > 0) this.stderr.emit('data', response.stderr as never);
        this.exitCode = response.exitCode;
        this.#events.emit('close', response.exitCode as never);
      });
    },
  });
  exitCode: number | null = null;
  readonly #events = new ControlledStream();
  readonly #response: () => Readonly<{ exitCode: number; stdout: string; stderr: string }>;

  constructor(response: () => Readonly<{ exitCode: number; stdout: string; stderr: string }>) {
    this.#response = response;
  }

  once(event: 'close' | 'error', listener: Listener): this {
    this.#events.once(event, listener);
    return this;
  }

  kill(): boolean {
    this.exitCode = 1;
    return true;
  }
}

class HangingChild implements CliChildProcess {
  readonly pid = 4321;
  readonly stdout = new ControlledStream();
  readonly stderr = new ControlledStream();
  readonly stdin = Object.assign(new ControlledStream(), {
    end: () => queueMicrotask(() => this.stdin.emit('finish')),
  });
  exitCode: number | null = null;
  kills = 0;
  readonly #events = new ControlledStream();

  once(event: 'close' | 'error', listener: Listener): this {
    this.#events.once(event, listener);
    return this;
  }

  kill(): boolean {
    this.kills += 1;
    this.exitCode = 1;
    return true;
  }
}

class CloseBeforeStdinErrorChild implements CliChildProcess {
  readonly pid = 4321;
  readonly stdout = new ControlledStream();
  readonly stderr = new ControlledStream();
  readonly stdin = Object.assign(new ControlledStream(), {
    end: () => {
      this.exitCode = 0;
      this.#events.emit('close', 0 as never);
      this.stdin.emit('error', new Error('EPIPE C:\\private') as never);
    },
  });
  exitCode: number | null = null;
  readonly #events = new ControlledStream();

  once(event: 'close' | 'error', listener: Listener): this {
    this.#events.once(event, listener);
    return this;
  }

  kill(): boolean {
    this.exitCode = 1;
    return true;
  }
}

class ThrowingStdinChild implements CliChildProcess {
  readonly pid = 4321;
  readonly stdout = new ControlledStream();
  readonly stderr = new ControlledStream();
  readonly stdin = Object.assign(new ControlledStream(), {
    end: () => {
      throw new Error('EPIPE C:\\Users\\student\\private');
    },
  });
  readonly exitCode = null;
  readonly #events = new ControlledStream();

  once(event: 'close' | 'error', listener: Listener): this {
    this.#events.once(event, listener);
    return this;
  }

  kill(): boolean {
    return true;
  }
}

const request = (overrides: Partial<CliProcessRequest> = {}): CliProcessRequest =>
  Object.freeze({
    requestId: randomUUID(),
    launcherPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: Object.freeze(['-NoProfile', '-NonInteractive', '-EncodedCommand', 'ZgBpeABlAGQA']),
    cwd: 'C:\\Windows\\System32',
    env: Object.freeze({ NO_COLOR: '1' }),
    stdin: 'private helper input',
    timeoutMs: 5_000,
    stdoutLimitBytes: 4_096,
    stderrLimitBytes: 1_024,
    signal: new AbortController().signal,
    shell: false,
    ...overrides,
  });

const connectionOperation = (controller = new AbortController()): ProviderConnectionOperation =>
  Object.freeze({ requestId: randomUUID(), signal: controller.signal });

describe('bounded low-level Node process runner', () => {
  it('runs a fixed helper shell-free without provider binding or alias dependencies', async () => {
    const calls: Array<
      Readonly<{ file: string; args: readonly string[]; options: CliSpawnOptions }>
    > = [];
    const spawner: CliSpawnFacade = {
      spawn: (file, args, options) => {
        calls.push(Object.freeze({ file, args: Object.freeze([...args]), options }));
        return new SuccessfulChild();
      },
    };
    const runner = createBoundedNodeProcessRunnerForTest({ spawner });

    const result = await runner.run(request());

    expect(result).toEqual({ exitCode: 0, stdout: 'private helper input', stderr: '' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      options: {
        shell: false,
        windowsHide: true,
        cwd: 'C:\\Windows\\System32',
        env: { NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    });
  });

  it('rejects provider post-process validation before spawning a low-level helper', async () => {
    let spawnCalls = 0;
    let validationCalls = 0;
    const runner = createBoundedNodeProcessRunnerForTest({
      spawner: {
        spawn: () => {
          spawnCalls += 1;
          return new SuccessfulChild();
        },
      },
    });

    await expect(
      runner.run(
        request({
          postProcessValidation: async () => {
            validationCalls += 1;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect(spawnCalls).toBe(0);
    expect(validationCalls).toBe(0);
  });

  it.each([
    ['missing', undefined],
    ['lookalike', Object.freeze({ aborted: false })],
  ] as const)('rejects a %s process signal before spawning a helper', async (_name, signal) => {
    let spawnCalls = 0;
    const runner = createBoundedNodeProcessRunnerForTest({
      spawner: {
        spawn: () => {
          spawnCalls += 1;
          return new SuccessfulChild();
        },
      },
    });

    await expect(
      runner.run(request({ signal: signal as unknown as AbortSignal })),
    ).rejects.toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect(spawnCalls).toBe(0);
  });

  it('composes fixed PowerShell, subst, taskkill, and version inspection without provider validation', async () => {
    const mappings = new Map<string, string>();
    const launched: string[] = [];
    const spawner: CliSpawnFacade = {
      spawn: (file, args) => {
        launched.push(file);
        return new ScriptedChild(() => {
          if (file === WINDOWS_POWERSHELL_PATH) {
            return { exitCode: 0, stdout: 'fixed-helper-ok', stderr: '' };
          }
          if (file === WINDOWS_SUBST_PATH) {
            if (args.length === 0) {
              const stdout = [...mappings.entries()]
                .map(([drive, target]) => `${drive}\\: => ${target}`)
                .join('\r\n');
              return { exitCode: 0, stdout, stderr: '' };
            }
            const [drive, target] = args;
            if (drive !== undefined && target !== undefined && target !== '/D') {
              mappings.set(drive, target);
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (file === WINDOWS_TASKKILL_PATH) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          return { exitCode: 0, stdout: 'agy 1.1.12\n', stderr: '' };
        });
      },
    };
    const runner = createBoundedNodeProcessRunnerForTest({ spawner });
    const files = Object.freeze({
      canonicalize: async (path: string) => path,
      assertNoReparsePoints: async () => {},
      readFile: async () => new Uint8Array(),
      listChildren: async () => Object.freeze([] as string[]),
    });
    const hasher = Object.freeze({ sha256: async () => 'a'.repeat(64) });
    const tools = Object.freeze({
      runVerified: async <T>(
        _path: string,
        _operation: ProviderConnectionOperation,
        run: () => Promise<T>,
      ) => run(),
    });
    const operation = connectionOperation();

    const helperResult = await runVerifiedWindowsPowerShell(
      { runner, files, hasher },
      {
        encodedCommand: 'ZgBpeABlAGQA',
        env: Object.freeze({ NO_COLOR: '1' }),
        timeoutMs: 5_000,
        stdoutLimitBytes: 4_096,
        stderrLimitBytes: 1_024,
      },
      operation,
    );
    const subst = createWindowsSubstMappingPortForTest({ runner, tools });
    await subst.map('R:', 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers', operation);
    const terminator = createWindowsProcessTreeTerminatorForTest({ runner, tools });
    await terminator.terminate({
      pid: 4321,
      creationTime: '2026-09-02T00:00:00.000Z',
      canonicalImagePath: 'C:\\Program Files\\agy\\agy.exe',
    });
    const roots = createWindowsKnownFoldersForTest({
      localAppData: 'C:\\Users\\student\\AppData\\Local',
      appData: 'C:\\Users\\student\\AppData\\Roaming',
      programFiles: 'C:\\Program Files',
      architecture: 'x64',
    });
    const inspector = createCliExecutableInspectorForTest({
      files,
      hasher,
      signatures: {
        verify: async (_path, signerClassification) => ({
          signerClassification,
          certificateThumbprint: 'A'.repeat(40),
        }),
      },
      runner,
      knownFolders: roots,
      now: () => '2026-09-02T00:00:00.000Z',
    });
    const inspected = await inspector.inspect('antigravity_cli', operation);

    expect(helperResult.stdout).toBe('fixed-helper-ok');
    await expect(subst.list(operation)).resolves.toEqual(
      new Map([['R:', 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers']]),
    );
    expect(inspected.version).toBe('1.1.12');
    expect(launched).toContain(WINDOWS_POWERSHELL_PATH);
    expect(launched).toContain(WINDOWS_SUBST_PATH);
    expect(launched).toContain(WINDOWS_TASKKILL_PATH);
    expect(launched).toContain('C:\\Users\\student\\AppData\\Local\\agy\\bin\\agy.exe');
  });

  it('rejects oversized stdin before starting a helper', async () => {
    let spawnCalls = 0;
    const runner = createBoundedNodeProcessRunnerForTest({
      spawner: {
        spawn: () => {
          spawnCalls += 1;
          return new HangingChild();
        },
      },
    });

    await expect(
      runner.run(request({ stdin: 'a'.repeat(MAX_CLI_STDIN_BYTES + 1) })),
    ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_TOO_LARGE' });
    expect(spawnCalls).toBe(0);
  });

  it.each(['stdout', 'stderr'] as const)(
    'enforces the raw %s byte limit before UTF-8 decoding without exposing private output',
    async (stream) => {
      const runner = createBoundedNodeProcessRunnerForTest({
        spawner: {
          spawn: () =>
            new ScriptedChild(() => ({
              exitCode: 0,
              stdout: stream === 'stdout' ? '비밀' : '',
              stderr: stream === 'stderr' ? '비밀' : '',
            })),
        },
      });

      let failure: unknown;
      try {
        await runner.run(
          request({
            stdin: '',
            ...(stream === 'stdout' ? { stdoutLimitBytes: 5 } : { stderrLimitBytes: 5 }),
          }),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
      expect(failure instanceof Error ? failure.message : String(failure)).not.toContain('비밀');
    },
  );

  it.each([
    ['timeout', undefined],
    ['abort', new AbortController()],
  ] as const)(
    'bounds a hanging helper on %s and terminates it locally',
    async (kind, controller) => {
      const child = new HangingChild();
      const runner = createBoundedNodeProcessRunnerForTest({ spawner: { spawn: () => child } });
      const pending = runner.run(
        request({
          stdin: '',
          timeoutMs: kind === 'timeout' ? 10 : 5_000,
          ...(controller === undefined ? {} : { signal: controller.signal }),
        }),
      );
      if (controller !== undefined) controller.abort();

      await expect(pending).rejects.toMatchObject({
        code: kind === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_CANCELLED',
      });
      expect(child.kills).toBe(1);
    },
  );

  it('rejects close-before-EPIPE for nonempty stdin and redacts the stream error', async () => {
    const runner = createBoundedNodeProcessRunnerForTest({
      spawner: { spawn: () => new CloseBeforeStdinErrorChild() },
    });
    let failure: unknown;

    try {
      await runner.run(request({ stdin: 'private request body' }));
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect(failure instanceof Error ? failure.message : String(failure)).not.toContain(
      'C:\\private',
    );
  });

  it('does not leak a synchronous spawn error through its public failure', async () => {
    const privatePath = 'C:\\Users\\student\\private-helper.exe';
    const runner = createBoundedNodeProcessRunnerForTest({
      spawner: {
        spawn: () => {
          throw new Error(privatePath);
        },
      },
    });
    let failure: unknown;

    try {
      await runner.run(request());
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect(failure instanceof Error ? failure.message : String(failure)).not.toContain(privatePath);
  });

  it('does not leak a synchronous stdin write error through its public failure', async () => {
    const privatePath = 'C:\\Users\\student\\private';
    const runner = createBoundedNodeProcessRunnerForTest({
      spawner: { spawn: () => new ThrowingStdinChild() },
    });
    let failure: unknown;

    try {
      await runner.run(request());
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect(failure instanceof Error ? failure.message : String(failure)).not.toContain(privatePath);
  });
});
