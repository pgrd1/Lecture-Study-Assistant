import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type {
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../../../src/core/ports/aiProvider';
import type {
  CliProcessRequest,
  CliProcessResult,
} from '../../../../../src/core/ports/cliProcessRunner';
import {
  type CliChildProcess,
  type CliPrivateDirectoryManager,
  type CliProcessIdentity,
  type CliProcessIdentityProvider,
  type CliProcessTreeTerminator,
  type CliSpawnFacade,
  createCliPrivateDirectoryManagerForTest,
  createNodeCliProcessRunnerForTest,
  createWindowsPrivateDirectoryAclForTest,
  createWindowsProcessIdentityProviderForTest,
  createWindowsProcessTreeTerminatorForTest,
  MAX_CLI_STDIN_BYTES,
  PRIVATE_DIRECTORY_TARGET_ENVIRONMENT_KEY,
  PROCESS_IDENTITY_PID_ENVIRONMENT_KEY,
  WINDOWS_PRIVATE_DIRECTORY_ACL_ENCODED_COMMAND,
  WINDOWS_PROCESS_IDENTITY_ENCODED_COMMAND,
  WINDOWS_TASKKILL_PATH,
} from '../../../../../src/infrastructure/providers/cli/nodeCliProcessRunner';
import { WINDOWS_POWERSHELL_PATH } from '../../../../../src/infrastructure/providers/cli/windowsPowerShell';
import type {
  WindowsToolIdentityGuard,
  WindowsWorkspaceAlias,
  WindowsWorkspaceAliasLease,
} from '../../../../../src/infrastructure/providers/cli/windowsWorkspaceAlias';
import { parseSafeSemVer } from '../../../../../src/shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../../../src/shared/errors';

const fixturePath = fileURLToPath(
  new URL('../../../../fixtures/cli/controlled-cli.mjs', import.meta.url),
);
const runtimeRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers';
const requestId = randomUUID();
const workspace = `${runtimeRoot}\\workspace\\${requestId}`;
const connectionOperation = (
  id = requestId,
  controller = new AbortController(),
): ProviderConnectionOperation => Object.freeze({ requestId: id, signal: controller.signal });
const binding = Object.freeze({
  providerId: 'gemini_cli',
  canonicalLauncherPath: process.execPath,
  canonicalEntryPath: fixturePath,
  canonicalPackageManifestPath: `${fixturePath}.package.json`,
  canonicalPlatformPackageManifestPath: null,
  fixedPrefixArgs: Object.freeze([fixturePath]),
  version: parseSafeSemVer('0.55.1'),
  launcherSha256: 'a'.repeat(64),
  entrySha256: 'b'.repeat(64),
  packageManifestSha256: 'c'.repeat(64),
  platformPackageManifestSha256: null,
  bindingSha256: 'd'.repeat(64),
  recipeId: 'gemini-0.55-policy-json-v1',
  credentialScope: 'provider_global',
  signerClassification: 'nodejs',
  checkedAt: '2026-09-02T00:00:00.000Z',
}) satisfies CliRuntimeBinding<'gemini_cli', 'provider_global'>;

class AliasService implements WindowsWorkspaceAlias {
  releases = 0;
  revalidations = 0;
  readonly acquireOperations: ProviderConnectionOperation[] = [];
  readonly revalidationOperations: ProviderConnectionOperation[] = [];
  profileRoot = 'R:\\profiles\\gemini_cli';
  releaseFails = false;

  async acquire(
    _binding: CliRuntimeBinding,
    operation: ProviderConnectionOperation,
  ): Promise<WindowsWorkspaceAliasLease> {
    this.acquireOperations.push(operation);
    const rewritePath = (path: string): string => {
      if (path.toLowerCase().startsWith(runtimeRoot.toLowerCase())) {
        return `R:${path.slice(runtimeRoot.length)}`;
      }
      if (path === fixturePath) return 'S:\\controlled-cli.mjs';
      return path;
    };
    return Object.freeze({
      providerId: 'gemini_cli' as const,
      runtimeRoot: 'R:\\',
      profileRoot: this.profileRoot,
      workspaceRoot: 'R:\\workspace',
      tempRoot: 'R:\\temp',
      launcherPath: 'S:\\node.exe',
      fixedPrefixArgs: Object.freeze(['S:\\controlled-cli.mjs']),
      rewritePath,
      assertNoCanonicalPathDisclosure: (value: string) => {
        const normalized = value.replaceAll('/', '\\').toLowerCase();
        if (normalized.includes('c:\\users\\student\\')) {
          throw new AppError('PROVIDER_UNSAFE_VERSION', APP_ERROR_MESSAGES.PROVIDER_UNSAFE_VERSION);
        }
      },
      revalidate: async (leaseOperation) => {
        this.revalidations += 1;
        this.revalidationOperations.push(leaseOperation);
      },
      release: async () => {
        this.releases += 1;
        if (this.releaseFails) throw new Error('private alias release detail');
      },
    });
  }

  async cleanupStale(
    _binding: CliRuntimeBinding,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {}
}

class PrivateDirectories implements CliPrivateDirectoryManager {
  readonly prepared: string[] = [];
  readonly preparedOperations: ProviderConnectionOperation[] = [];
  readonly cleaned: string[] = [];
  cleanupFails = false;

  async prepareProfile(
    _providerId: string,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {}

  async prepareRequest(
    _providerId: string,
    id: string,
    cwd: string,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    this.prepared.push(`${id}:${cwd}`);
    this.preparedOperations.push(operation);
  }

  async cleanupRequest(id: string, cwd: string): Promise<void> {
    this.cleaned.push(`${id}:${cwd}`);
    if (this.cleanupFails) throw new Error('private path must not escape');
  }
}

class IdentityProvider implements CliProcessIdentityProvider {
  mismatch = false;
  readonly operations: ProviderConnectionOperation[] = [];

  async capture(pid: number, operation: ProviderConnectionOperation): Promise<CliProcessIdentity> {
    this.operations.push(operation);
    return Object.freeze({
      pid,
      creationTime: this.mismatch ? '2026-09-02T00:00:01.000Z' : '2026-09-02T00:00:00.000Z',
      canonicalImagePath: 'S:\\node.exe',
    });
  }
}

class Terminator implements CliProcessTreeTerminator {
  readonly identities: CliProcessIdentity[] = [];
  readonly children = new Map<number, CliChildProcess>();
  fail = false;

  async terminate(identity: CliProcessIdentity): Promise<void> {
    this.identities.push(identity);
    if (this.fail) throw new Error('TASKKILL_FAILED');
    this.children.get(identity.pid)?.kill();
  }
}

class TranslatingSpawner implements CliSpawnFacade {
  lastFile = '';
  lastArgs: readonly string[] = [];
  lastOptions: Parameters<CliSpawnFacade['spawn']>[2] | null = null;
  readonly terminator: Terminator;

  constructor(terminator: Terminator) {
    this.terminator = terminator;
  }

  spawn(file: string, args: readonly string[], options: Parameters<CliSpawnFacade['spawn']>[2]) {
    this.lastFile = file;
    this.lastArgs = Object.freeze([...args]);
    this.lastOptions = options;
    const translatedArgs = args.map((argument) =>
      argument === 'S:\\controlled-cli.mjs' ? fixturePath : argument,
    );
    const translatedFile = file === 'S:\\node.exe' ? process.execPath : file;
    const child = spawn(translatedFile, translatedArgs, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
      env: { ...options.env },
    }) as CliChildProcess;
    if (child.pid !== undefined) this.terminator.children.set(child.pid, child);
    return child;
  }
}

const createHarness = () => {
  const aliases = new AliasService();
  const directories = new PrivateDirectories();
  const identities = new IdentityProvider();
  const terminator = new Terminator();
  const spawner = new TranslatingSpawner(terminator);
  const processToolPaths: string[] = [];
  const processToolOperations: ProviderConnectionOperation[] = [];
  let revalidationCalls = 0;
  const revalidationOperations: ProviderConnectionOperation[] = [];
  let onRevalidate: ((operation: ProviderConnectionOperation) => void | Promise<void>) | null =
    null;
  let drift = false;
  let revalidatedBinding: CliRuntimeBinding = binding;
  const runner = createNodeCliProcessRunnerForTest({
    binding,
    inspector: {
      revalidate: async (_binding, operation) => {
        revalidationCalls += 1;
        revalidationOperations.push(operation);
        await onRevalidate?.(operation);
        if (drift) throw new Error('drift');
        return revalidatedBinding;
      },
    },
    aliases,
    directories,
    spawner,
    identities,
    terminator,
    tools: {
      runVerified: async (path, operation, run) => {
        processToolPaths.push(path);
        processToolOperations.push(operation);
        return run();
      },
    },
  });
  return {
    aliases,
    directories,
    identities,
    terminator,
    spawner,
    processToolPaths,
    processToolOperations,
    runner,
    revalidationCalls: () => revalidationCalls,
    revalidationOperations,
    onRevalidate: (callback: (operation: ProviderConnectionOperation) => void | Promise<void>) => {
      onRevalidate = callback;
    },
    drift: () => {
      drift = true;
    },
    returnBinding: (value: CliRuntimeBinding) => {
      revalidatedBinding = value;
    },
  };
};

const request = (mode: string, overrides: Partial<CliProcessRequest> = {}): CliProcessRequest =>
  Object.freeze({
    requestId,
    launcherPath: process.execPath,
    args: Object.freeze([fixturePath, mode, '16384']),
    cwd: workspace,
    env: Object.freeze({
      PATH: 'C:\\Attacker',
      SystemRoot: 'C:\\Attacker\\Windows',
      NO_COLOR: '0',
      LANG: 'ko_KR.UTF-8',
      OPENAI_API_KEY: 'must-not-be-copied',
      HTTPS_PROXY: 'http://proxy.invalid',
      NODE_OPTIONS: '--require attacker.js',
      GEMINI_CLI_HOME: 'C:\\Users\\student\\.gemini',
      GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
      GEMINI_FORCE_FILE_STORAGE: 'true',
      NO_BROWSER: 'false',
    }),
    stdin: '',
    timeoutMs: 2_000,
    stdoutLimitBytes: 32_768,
    stderrLimitBytes: 32_768,
    signal: new AbortController().signal,
    ...overrides,
  });

const useImmediatelySettledChild = (
  setup: ReturnType<typeof createHarness>,
  exitCode = 0,
): void => {
  let visibleExitCode: number | null = null;
  let close: ((code: number | null) => void) | null = null;
  let child: CliChildProcess;
  child = {
    pid: 4321,
    stdout: { on: () => child.stdout },
    stderr: { on: () => child.stderr },
    stdin: {
      end: () => {
        visibleExitCode = exitCode;
        setImmediate(() => close?.(exitCode));
      },
      once: () => child.stdin,
    },
    get exitCode() {
      return visibleExitCode;
    },
    once: (
      event: 'close' | 'error',
      listener: ((code: number | null) => void) | ((error: Error) => void),
    ) => {
      if (event === 'close') close = listener as (code: number | null) => void;
      return child;
    },
    kill: () => false,
  } as CliChildProcess;
  setup.spawner.spawn = () => child;
};

describe('bounded Node CLI process runner', () => {
  it('rewrites each generated image argument through the verified lease without canonical path disclosure', async () => {
    const setup = createHarness();
    await setup.runner.run(
      request('echo-stdin-json', {
        args: [
          fixturePath,
          'echo-stdin-json',
          '--image',
          `${runtimeRoot}\\temp\\${requestId}\\image-000.png`,
          '--',
          '-',
        ],
      }),
    );
    expect(setup.spawner.lastArgs.slice(-4)).toEqual([
      '--image',
      `R:\\temp\\${requestId}\\image-000.png`,
      '--',
      '-',
    ]);
    expect(setup.spawner.lastArgs.join(' ')).not.toContain(runtimeRoot);
    expect(setup.spawner.lastOptions?.shell).toBe(false);
  });
  it('sends private content only through stdin with a shell-free allowlisted environment', async () => {
    const setup = createHarness();
    const privateContent = '{"private":"강의 내용"}\n';

    const result = await setup.runner.run(
      request('echo-stdin-json', { stdin: privateContent, args: [fixturePath, 'echo-stdin-json'] }),
    );

    expect(result.stdout).toBe(privateContent);
    expect(setup.spawner.lastOptions).toMatchObject({
      shell: false,
      windowsHide: true,
      cwd: `R:\\workspace\\${requestId}`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(setup.spawner.lastArgs.join(' ')).not.toContain('강의 내용');
    expect(setup.spawner.lastFile).toBe('S:\\node.exe');
    expect(setup.spawner.lastArgs[0]).toBe('S:\\controlled-cli.mjs');
    expect(setup.spawner.lastOptions?.env).toEqual({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32',
      LANG: 'ko_KR.UTF-8',
      NO_COLOR: '1',
      USERPROFILE: 'R:\\profiles\\gemini_cli\\user',
      APPDATA: 'R:\\profiles\\gemini_cli\\user\\AppData\\Roaming',
      LOCALAPPDATA: 'R:\\profiles\\gemini_cli\\user\\AppData\\Local',
      TEMP: `R:\\temp\\${requestId}`,
      TMP: `R:\\temp\\${requestId}`,
      GEMINI_CLI_HOME: 'R:\\profiles\\gemini_cli\\settings',
      GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true',
      GEMINI_FORCE_FILE_STORAGE: 'false',
      NO_BROWSER: 'true',
    });
    expect(setup.revalidationCalls()).toBe(3);
    expect(setup.aliases.revalidations).toBe(2);
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.directories.preparedOperations).toHaveLength(1);
    expect(setup.directories.preparedOperations[0]?.requestId).toBe(requestId);
    expect(setup.aliases.acquireOperations[0]).toBe(setup.directories.preparedOperations[0]);
    expect(setup.identities.operations[0]).toBe(setup.directories.preparedOperations[0]);
    expect(setup.revalidationOperations.slice(0, 2)).toEqual([
      setup.directories.preparedOperations[0],
      setup.directories.preparedOperations[0],
    ]);
    const cleanupOperation = setup.revalidationOperations[2];
    expect(cleanupOperation?.requestId).not.toBe(requestId);
    expect(cleanupOperation?.signal.aborted).toBe(false);
    expect(setup.aliases.revalidationOperations).toEqual([
      setup.directories.preparedOperations[0],
      cleanupOperation,
    ]);
    expect(setup.processToolOperations.slice(0, 4)).toEqual([
      setup.directories.preparedOperations[0],
      setup.directories.preparedOperations[0],
      setup.directories.preparedOperations[0],
      setup.directories.preparedOperations[0],
    ]);
    expect(setup.processToolOperations.slice(4)).toEqual([cleanupOperation, cleanupOperation]);
  });

  it.each([
    {
      label: 'embedded canonical managed path',
      privateArgument: `--schema=${runtimeRoot}\\workspace\\${requestId}\\schema.json`,
    },
    {
      label: 'forward-slash managed path',
      privateArgument: `--schema=${runtimeRoot.replaceAll('\\', '/').toUpperCase()}/workspace/${requestId}/schema.json`,
    },
    {
      label: 'extended-prefix managed path',
      privateArgument: `--schema=//?/${runtimeRoot.replaceAll('\\', '/')}\\workspace\\${requestId}\\schema.json`,
    },
  ])(
    'rejects an unaliased $label before spawn without exposing it in the error',
    async ({ privateArgument }) => {
      const setup = createHarness();
      let failure: unknown;

      try {
        await setup.runner.run(
          request('echo-stdin-json', {
            args: Object.freeze([fixturePath, 'echo-stdin-json', privateArgument]),
          }),
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
      expect(failure instanceof Error ? failure.message : String(failure)).not.toContain(
        privateArgument,
      );
      expect(setup.spawner.lastFile).toBe('');
    },
  );

  it('rejects an unaliased mixed-separator private path in generated environment values', async () => {
    const setup = createHarness();
    const privateProfile = `${runtimeRoot.replaceAll('\\', '/').toUpperCase()}/profiles/gemini_cli`;
    setup.aliases.profileRoot = privateProfile;
    let failure: unknown;

    try {
      await setup.runner.run(request('echo-stdin-json'));
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(failure instanceof Error ? failure.message : String(failure)).not.toContain(
      privateProfile,
    );
    expect(setup.spawner.lastFile).toBe('');
  });

  it('delegates cleanup to the artifact owner and never deletes foreign trees after its refusal', async () => {
    const setup = createHarness();
    let called = false;
    await expect(
      setup.runner.run(
        request('exit-code', {
          args: [fixturePath, 'exit-code', '0'],
          requestCleanup: async (signal: AbortSignal) => {
            called = true;
            expect(signal.aborted).toBe(false);
            throw new Error('foreign file');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(called).toBe(true);
    expect(setup.directories.cleaned).toEqual([]);
  });

  it('rejects stdin above 8 MiB before starting a process', async () => {
    const setup = createHarness();

    await expect(
      setup.runner.run(request('echo-stdin-json', { stdin: 'a'.repeat(MAX_CLI_STDIN_BYTES + 1) })),
    ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_TOO_LARGE' });
    expect(setup.spawner.lastOptions).toBeNull();
  });

  it('rejects a malformed post-process callback before starting a provider process', async () => {
    const setup = createHarness();

    await expect(
      setup.runner.run(
        request('exit-code', {
          args: [fixturePath, 'exit-code', '0'],
          postProcessValidation: 'not-a-function' as unknown as () => Promise<void>,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect(setup.spawner.lastOptions).toBeNull();
    expect(setup.directories.prepared).toHaveLength(0);
  });

  it.each([
    ['timeout', { timeoutMs: 900_001 }],
    ['stdout', { stdoutLimitBytes: 8 * 1024 * 1024 + 1 }],
    ['stderr', { stderrLimitBytes: 8 * 1024 * 1024 + 1 }],
  ])('rejects an unbounded configured %s limit before starting a process', async (_name, limit) => {
    const setup = createHarness();

    await expect(
      setup.runner.run(request('exit-code', { args: [fixturePath, 'exit-code', '0'], ...limit })),
    ).rejects.toBeInstanceOf(Error);
    expect(setup.spawner.lastOptions).toBeNull();
  });

  it('revalidates fixed PowerShell and taskkill identities around every process operation', async () => {
    const setup = createHarness();

    await setup.runner.run(request('exit-code', { args: [fixturePath, 'exit-code', '0'] }));

    expect(setup.processToolPaths).toEqual([
      WINDOWS_POWERSHELL_PATH,
      WINDOWS_TASKKILL_PATH,
      WINDOWS_POWERSHELL_PATH,
      WINDOWS_TASKKILL_PATH,
      WINDOWS_POWERSHELL_PATH,
      WINDOWS_TASKKILL_PATH,
    ]);
  });

  it('observes a fast child exit while process identity capture is still pending', async () => {
    const setup = createHarness();
    let stdinEnds = 0;
    let stdinError: ((error: Error) => void) | null = null;
    let exitedChild: CliChildProcess;
    exitedChild = {
      pid: 4321,
      stdout: { on: () => exitedChild.stdout },
      stderr: { on: () => exitedChild.stderr },
      stdin: {
        end: () => {
          stdinEnds += 1;
          stdinError?.(new Error('EPIPE'));
        },
        once: (event: 'error' | 'finish', listener: ((error: Error) => void) | (() => void)) => {
          if (event === 'error') stdinError = listener as (error: Error) => void;
          return exitedChild.stdin;
        },
      },
      exitCode: 0,
      once: (
        event: 'close' | 'error',
        listener: ((code: number | null) => void) | ((error: Error) => void),
      ) => {
        if (event === 'close') {
          setTimeout(() => (listener as (code: number | null) => void)(0), 10);
        }
        return exitedChild;
      },
      kill: () => false,
    } as CliChildProcess;
    setup.spawner.spawn = () => exitedChild;

    await expect(
      setup.runner.run(
        request('exit-code', {
          args: [fixturePath, 'exit-code', '0'],
          timeoutMs: 500,
        }),
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(stdinEnds).toBe(0);
  });

  it('waits for a successful fast close when empty-stdin shutdown reports EPIPE first', async () => {
    const setup = createHarness();
    let stdinEnds = 0;
    let visibleExitCode: number | null = null;
    let stdinError: ((error: Error) => void) | null = null;
    let close: ((code: number | null) => void) | null = null;
    let exitingChild: CliChildProcess;
    exitingChild = {
      pid: 4321,
      stdout: { on: () => exitingChild.stdout },
      stderr: { on: () => exitingChild.stderr },
      stdin: {
        end: () => {
          stdinEnds += 1;
          stdinError?.(new Error('EPIPE'));
          visibleExitCode = 0;
          setTimeout(() => close?.(0), 0);
        },
        once: (event: 'error' | 'finish', listener: ((error: Error) => void) | (() => void)) => {
          if (event === 'error') stdinError = listener as (error: Error) => void;
          return exitingChild.stdin;
        },
      },
      get exitCode() {
        return visibleExitCode;
      },
      once: (
        event: 'close' | 'error',
        listener: ((code: number | null) => void) | ((error: Error) => void),
      ) => {
        if (event === 'close') close = listener as (code: number | null) => void;
        return exitingChild;
      },
      kill: () => false,
    } as CliChildProcess;
    setup.spawner.spawn = () => exitingChild;

    await expect(
      setup.runner.run(
        request('exit-code', {
          args: [fixturePath, 'exit-code', '0'],
          stdin: '',
          timeoutMs: 500,
        }),
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(stdinEnds).toBe(1);
  });

  it('rejects exit zero when close wins the race before nonempty stdin reports EPIPE', async () => {
    const setup = createHarness();
    let visibleExitCode: number | null = null;
    let stdinError: ((error: Error) => void) | null = null;
    let stdinFinish: (() => void) | null = null;
    let close: ((code: number | null) => void) | null = null;
    let exitingChild: CliChildProcess;
    exitingChild = {
      pid: 4321,
      stdout: { on: () => exitingChild.stdout },
      stderr: { on: () => exitingChild.stderr },
      stdin: {
        end: () => {
          visibleExitCode = 0;
          close?.(0);
          stdinError?.(new Error('EPIPE private path'));
        },
        once: (event: 'error' | 'finish', listener: ((error: Error) => void) | (() => void)) => {
          if (event === 'error') stdinError = listener as (error: Error) => void;
          else stdinFinish = listener as () => void;
          return exitingChild.stdin;
        },
      },
      get exitCode() {
        return visibleExitCode;
      },
      once: (
        event: 'close' | 'error',
        listener: ((code: number | null) => void) | ((error: Error) => void),
      ) => {
        if (event === 'close') close = listener as (code: number | null) => void;
        return exitingChild;
      },
      kill: () => false,
    } as CliChildProcess;
    setup.spawner.spawn = () => exitingChild;

    await expect(
      setup.runner.run(
        request('echo-stdin-json', {
          args: [fixturePath, 'echo-stdin-json'],
          stdin: 'private request body',
          timeoutMs: 500,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect(stdinFinish).not.toBeNull();
  });

  it('terminates the verified child when nonempty stdin throws synchronously', async () => {
    const setup = createHarness();
    let throwingChild: CliChildProcess;
    throwingChild = {
      pid: 4321,
      stdout: { on: () => throwingChild.stdout },
      stderr: { on: () => throwingChild.stderr },
      stdin: {
        end: () => {
          throw new Error('EPIPE private path');
        },
        once: () => throwingChild.stdin,
      },
      exitCode: null,
      once: () => throwingChild,
      kill: () => false,
    } as CliChildProcess;
    setup.spawner.spawn = () => {
      setup.terminator.children.set(4321, throwingChild);
      return throwingChild;
    };

    await expect(
      setup.runner.run(
        request('echo-stdin-json', {
          args: [fixturePath, 'echo-stdin-json'],
          stdin: 'private request body',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect(setup.terminator.identities).toHaveLength(1);
  });

  it.each([
    ['timeout', 'sleep', 20, 32_768, 32_768, 'PROVIDER_TIMEOUT'],
    ['stdout-overflow', 'stdout-bytes', 2_000, 4_096, 32_768, 'PROVIDER_RESPONSE_TOO_LARGE'],
    ['stderr-overflow', 'stderr-bytes', 2_000, 32_768, 4_096, 'PROVIDER_RESPONSE_TOO_LARGE'],
  ] as const)(
    'kills the verified process tree on %s without validating a missing result',
    async (_name, mode, timeoutMs, stdoutLimitBytes, stderrLimitBytes, code) => {
      const setup = createHarness();
      let validationCalls = 0;

      await expect(
        setup.runner.run(
          request(mode, {
            timeoutMs,
            stdoutLimitBytes,
            stderrLimitBytes,
            postProcessValidation: async () => {
              validationCalls += 1;
              expect(setup.directories.cleaned).toHaveLength(0);
              expect(setup.aliases.releases).toBe(0);
              throw new Error('must not replace process failure');
            },
          }),
        ),
      ).rejects.toMatchObject({ code });
      expect(setup.terminator.identities).toHaveLength(1);
      expect(setup.terminator.identities[0]?.pid).toBeGreaterThan(0);
      expect(validationCalls).toBe(0);
      expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
      expect(setup.aliases.releases).toBe(1);
    },
  );

  it('maps an explicit abort to cancellation without validating a missing result', async () => {
    const setup = createHarness();
    const controller = new AbortController();
    let validationCalls = 0;
    const pending = setup.runner.run(
      request('sleep', {
        signal: controller.signal,
        postProcessValidation: async () => {
          validationCalls += 1;
          expect(setup.directories.cleaned).toHaveLength(0);
          expect(setup.aliases.releases).toBe(0);
          throw new Error('must not replace cancellation');
        },
      }),
    );
    setImmediate(() => controller.abort());

    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(setup.terminator.identities).toHaveLength(1);
    expect(validationCalls).toBe(0);
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
  });

  it('skips validation after spawn failure and still cleans before releasing the alias', async () => {
    const setup = createHarness();
    let validationCalls = 0;
    setup.spawner.spawn = () => {
      throw new Error('private spawn detail');
    };

    await expect(
      setup.runner.run(
        request('exit-code', {
          args: [fixturePath, 'exit-code', '0'],
          postProcessValidation: async () => {
            validationCalls += 1;
            throw new Error('must not replace spawn failure');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });

    expect(validationCalls).toBe(0);
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
  });

  it('skips validation after a settled process identity failure and still cleans and releases', async () => {
    const setup = createHarness();
    let validationCalls = 0;
    let child: CliChildProcess;
    child = {
      pid: 4321,
      stdout: { on: () => child.stdout },
      stderr: { on: () => child.stderr },
      stdin: { end: () => {}, once: () => child.stdin },
      exitCode: 1,
      once: () => child,
      kill: () => false,
    } as CliChildProcess;
    setup.spawner.spawn = () => child;
    setup.identities.capture = async () => {
      throw new Error('private identity detail');
    };

    await expect(
      setup.runner.run(
        request('exit-code', {
          args: [fixturePath, 'exit-code', '1'],
          postProcessValidation: async () => {
            validationCalls += 1;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });

    expect(validationCalls).toBe(0);
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
  });

  it('skips validation after a safely settled termination failure and still cleans and releases', async () => {
    const setup = createHarness();
    let validationCalls = 0;
    let visibleExitCode: number | null = null;
    let child: CliChildProcess;
    child = {
      pid: 4321,
      stdout: { on: () => child.stdout },
      stderr: { on: () => child.stderr },
      stdin: { end: () => {}, once: () => child.stdin },
      get exitCode() {
        return visibleExitCode;
      },
      once: () => child,
      kill: () => false,
    } as CliChildProcess;
    setup.spawner.spawn = () => child;
    setup.terminator.terminate = async (identity) => {
      setup.terminator.identities.push(identity);
      visibleExitCode = 1;
      throw new Error('private termination detail');
    };

    await expect(
      setup.runner.run(
        request('sleep', {
          timeoutMs: 20,
          postProcessValidation: async () => {
            validationCalls += 1;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });

    expect(validationCalls).toBe(0);
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
  });

  it('validates a settled nonzero result before exact request cleanup and alias release', async () => {
    const setup = createHarness();
    const lifecycle: string[] = [];
    let validationSignal: AbortSignal | undefined;

    const result = await setup.runner.run(
      request('exit-code', {
        args: [fixturePath, 'exit-code', '7'],
        postProcessValidation: async (signal?: AbortSignal) => {
          validationSignal = signal;
          lifecycle.push('validate');
          expect(setup.directories.cleaned).toHaveLength(0);
          expect(setup.aliases.releases).toBe(0);
        },
      }),
    );
    lifecycle.push('returned');

    expect(result.exitCode).toBe(7);
    expect(validationSignal).toBeInstanceOf(AbortSignal);
    expect(validationSignal?.aborted).toBe(false);
    expect(lifecycle).toEqual(['validate', 'returned']);
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
  });

  it('redacts callback failure on a settled nonzero result and still cleans before release', async () => {
    const setup = createHarness();
    const privateDetail = 'C:\\Users\\student\\private\\schema.json';

    const failure = await setup.runner
      .run(
        request('exit-code', {
          args: [fixturePath, 'exit-code', '7'],
          postProcessValidation: async () => {
            expect(setup.directories.cleaned).toHaveLength(0);
            expect(setup.aliases.releases).toBe(0);
            throw new Error(privateDetail);
          },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect(String((failure as Error).message)).not.toContain(privateDetail);
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
  });

  it('aborts a timed-out validation and cleans before releasing the alias', async () => {
    const setup = createHarness();
    useImmediatelySettledChild(setup);
    let validationStarted = false;
    let validationAborted = false;

    await expect(
      setup.runner.run(
        request('exit-code', {
          args: [fixturePath, 'exit-code', '0'],
          timeoutMs: 80,
          postProcessValidation: async (signal?: AbortSignal) => {
            validationStarted = true;
            if (signal === undefined) return await new Promise<void>(() => {});
            await new Promise<void>((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  validationAborted = true;
                  resolve();
                },
                { once: true },
              );
            });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });

    expect(validationStarted).toBe(true);
    expect(validationAborted).toBe(true);
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
  });

  it('does not let a signal-ignoring validation prevent cleanup, release, or safe late rejection', async () => {
    const setup = createHarness();
    useImmediatelySettledChild(setup);
    const lateValidation = { reject: null as ((error: Error) => void) | null };

    const failure = await setup.runner
      .run(
        request('exit-code', {
          args: [fixturePath, 'exit-code', '0'],
          timeoutMs: 80,
          postProcessValidation: () =>
            new Promise<void>((_resolve, reject) => {
              lateValidation.reject = reject;
            }),
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
    lateValidation.reject?.(new Error('private late validation detail'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('aborts validation on outer cancellation and preserves the fixed cancellation failure', async () => {
    const setup = createHarness();
    useImmediatelySettledChild(setup);
    const controller = new AbortController();
    let notifyStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let validationAborted = false;
    const pending = setup.runner.run(
      request('exit-code', {
        args: [fixturePath, 'exit-code', '0'],
        timeoutMs: 1_000,
        signal: controller.signal,
        postProcessValidation: async (signal?: AbortSignal) => {
          notifyStarted?.();
          if (signal === undefined) throw new Error('missing validation signal');
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                validationAborted = true;
                reject(new Error('private callback cancellation detail'));
              },
              { once: true },
            );
          });
        },
      }),
    );
    await started;
    controller.abort();

    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(String((failure as Error).message)).not.toContain('private');
    expect(validationAborted).toBe(true);
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
  });

  it('aborts validation through runner cancellation and still cleans and releases', async () => {
    const setup = createHarness();
    useImmediatelySettledChild(setup);
    let notifyStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let validationAborted = false;
    const pending = setup.runner.run(
      request('exit-code', {
        args: [fixturePath, 'exit-code', '0'],
        timeoutMs: 1_000,
        postProcessValidation: async (signal) => {
          notifyStarted?.();
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                validationAborted = true;
                resolve();
              },
              { once: true },
            );
          });
        },
      }),
    );
    await started;
    setup.runner.cancel(requestId);

    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(validationAborted).toBe(true);
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
  });

  it('keeps cleanup residue ahead of a validation timeout', async () => {
    const setup = createHarness();
    useImmediatelySettledChild(setup);
    setup.directories.cleanupFails = true;

    await expect(
      setup.runner.run(
        request('exit-code', {
          args: [fixturePath, 'exit-code', '0'],
          timeoutMs: 80,
          postProcessValidation: () => new Promise<void>(() => {}),
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
  });

  it('keeps alias-release residue ahead of a callback failure', async () => {
    const setup = createHarness();
    useImmediatelySettledChild(setup);
    setup.aliases.releaseFails = true;

    await expect(
      setup.runner.run(
        request('exit-code', {
          args: [fixturePath, 'exit-code', '0'],
          postProcessValidation: async () => {
            throw new Error('private callback failure');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.aliases.releases).toBe(1);
  });

  it('does not spawn when cancellation arrives during pre-spawn preparation', async () => {
    const setup = createHarness();
    const controller = new AbortController();
    setup.directories.prepareRequest = async () => {
      controller.abort();
    };

    await expect(
      setup.runner.run(request('sleep', { signal: controller.signal, timeoutMs: 20 })),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(setup.spawner.lastOptions).toBeNull();
  });

  it('preserves cancellation raised during binding revalidation and cleans with a fresh operation', async () => {
    const setup = createHarness();
    const controller = new AbortController();
    setup.onRevalidate((operation) => {
      if (operation.requestId !== requestId) return;
      controller.abort();
      throw new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED);
    });

    await expect(
      setup.runner.run(request('sleep', { signal: controller.signal, timeoutMs: 20 })),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });

    expect(setup.spawner.lastOptions).toBeNull();
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
    expect(setup.revalidationOperations[0]?.requestId).toBe(requestId);
    const cleanupOperations = setup.revalidationOperations.filter(
      (operation) => operation.requestId !== requestId,
    );
    expect(cleanupOperations).toHaveLength(1);
    expect(cleanupOperations[0]?.signal).not.toBe(controller.signal);
    expect(cleanupOperations[0]?.signal.aborted).toBe(false);
  });

  it('does not clean nonexistent request directories when already cancelled before preparation', async () => {
    const setup = createHarness();
    const controller = new AbortController();
    controller.abort();
    setup.directories.cleanupFails = true;

    await expect(
      setup.runner.run(request('sleep', { signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(setup.directories.prepared).toHaveLength(0);
    expect(setup.directories.cleaned).toHaveLength(0);
  });

  it('never kills a reused PID when the creation identity changed', async () => {
    const setup = createHarness();
    let captures = 0;
    setup.identities.capture = async (pid) => {
      captures += 1;
      return Object.freeze({
        pid,
        creationTime: captures === 1 ? '2026-09-02T00:00:00.000Z' : '2026-09-02T00:00:01.000Z',
        canonicalImagePath: 'S:\\node.exe',
      });
    };

    await expect(setup.runner.run(request('sleep', { timeoutMs: 20 }))).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
    expect(setup.terminator.identities).toHaveLength(0);
    expect(setup.directories.cleaned).toHaveLength(0);
    expect(setup.aliases.releases).toBe(0);
    for (const child of setup.terminator.children.values()) child.kill();
  });

  it('does not delete request directories or aliases while failed termination may leave a live tree', async () => {
    const setup = createHarness();
    setup.terminator.fail = true;

    await expect(setup.runner.run(request('sleep', { timeoutMs: 20 }))).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
    expect(setup.directories.cleaned).toHaveLength(0);
    expect(setup.aliases.releases).toBe(0);
    for (const child of setup.terminator.children.values()) child.kill();
  });

  it('discards successful output when post-run binding validation drifts', async () => {
    const setup = createHarness();
    const original = setup.directories.cleanupRequest.bind(setup.directories);
    setup.directories.cleanupRequest = async (id, cwd) => {
      setup.drift();
      await original(id, cwd);
    };

    const pending = setup.runner.run(
      request('echo-stdin-json', {
        stdin: 'private-result',
        args: [fixturePath, 'echo-stdin-json'],
      }),
    );
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CLI_CHANGED' });
    await expect(pending).rejects.not.toThrow(/private-result/u);
  });

  it('discards output when revalidation changes any private binding component', async () => {
    const setup = createHarness();
    const original = setup.directories.cleanupRequest.bind(setup.directories);
    setup.directories.cleanupRequest = async (id, cwd) => {
      setup.returnBinding(
        Object.freeze({
          ...binding,
          canonicalEntryPath: `${fixturePath}.changed`,
        }),
      );
      await original(id, cwd);
    };

    const pending = setup.runner.run(
      request('echo-stdin-json', {
        stdin: 'private-result',
        args: [fixturePath, 'echo-stdin-json'],
      }),
    );

    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CLI_CHANGED' });
    await expect(pending).rejects.not.toThrow(/private-result/u);
  });

  it('turns exact request-directory cleanup failure into residual data', async () => {
    const setup = createHarness();
    setup.directories.cleanupFails = true;

    await expect(
      setup.runner.run(request('exit-code', { args: [fixturePath, 'exit-code', '0'] })),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(setup.directories.cleaned).toEqual([`${requestId}:${workspace}`]);
  });
});

describe('private CLI directories', () => {
  it('applies a fixed owner/SYSTEM-only ACL helper with the target only in its env slot', async () => {
    const target = `${runtimeRoot}\\workspace\\${requestId}`;
    const requests: CliProcessRequest[] = [];
    const operation = connectionOperation();
    const canonical = new Map([
      [WINDOWS_POWERSHELL_PATH.toLowerCase(), WINDOWS_POWERSHELL_PATH],
      [target.toLowerCase(), target],
    ]);
    const acl = createWindowsPrivateDirectoryAclForTest({
      runner: {
        run: async (value) => {
          requests.push(value);
          return { exitCode: 0, stdout: '{"secure":true}\r\n', stderr: '' };
        },
        cancel: () => {},
      },
      files: {
        canonicalize: async (path) => canonical.get(path.toLowerCase()) ?? path,
        assertNoReparsePoints: async () => {},
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      hasher: { sha256: async () => 'a'.repeat(64) },
    });

    await acl.secure(target, operation);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.launcherPath).toBe(WINDOWS_POWERSHELL_PATH);
    expect(requests[0]?.env).toEqual({ [PRIVATE_DIRECTORY_TARGET_ENVIRONMENT_KEY]: target });
    expect(requests[0]?.requestId).toBe(operation.requestId);
    expect(requests[0]?.signal).toBe(operation.signal);
    expect(requests[0]?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      WINDOWS_PRIVATE_DIRECTORY_ACL_ENCODED_COMMAND,
    ]);
    const script = Buffer.from(WINDOWS_PRIVATE_DIRECTORY_ACL_ENCODED_COMMAND, 'base64').toString(
      'utf16le',
    );
    expect(script).not.toContain(target);
    expect(script).toContain('S-1-5-18');
    expect(script).toContain('SetAccessRuleProtection($true, $false)');
    expect(script).toContain('WindowsIdentity]::GetCurrent()');
    expect(script).toContain('$currentSid = $identity.User');
  });

  it('bootstraps only the fixed provider profile tree on a fresh install and is idempotent', async () => {
    const userDataRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp';
    const existing = new Set([userDataRoot.toLowerCase()]);
    const mkdirCalls: Array<Readonly<{ path: string; mode: number }>> = [];
    const secured: string[] = [];
    const manager = createCliPrivateDirectoryManagerForTest({
      userDataRoot,
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: `${runtimeRoot}\\profiles`,
      providerTempRoot: `${runtimeRoot}\\temp`,
      providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
      directories: {
        mkdir: async (path, options) => {
          mkdirCalls.push(Object.freeze({ path, mode: options.mode }));
          existing.add(path.toLowerCase());
        },
        remove: async () => {},
      },
      files: {
        canonicalize: async (path) => {
          if (!existing.has(path.toLowerCase())) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          }
          return path;
        },
        assertNoReparsePoints: async (path) => {
          if (!existing.has(path.toLowerCase())) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          }
        },
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      acl: {
        secure: async (path) => {
          secured.push(path);
        },
      },
    });
    const expectedPaths = [
      runtimeRoot,
      `${runtimeRoot}\\profiles`,
      `${runtimeRoot}\\temp`,
      `${runtimeRoot}\\workspace`,
      `${runtimeRoot}\\profiles\\gemini_cli`,
      `${runtimeRoot}\\profiles\\gemini_cli\\user`,
      `${runtimeRoot}\\profiles\\gemini_cli\\user\\AppData`,
      `${runtimeRoot}\\profiles\\gemini_cli\\user\\AppData\\Roaming`,
      `${runtimeRoot}\\profiles\\gemini_cli\\user\\AppData\\Local`,
      `${runtimeRoot}\\profiles\\gemini_cli\\settings`,
    ];
    const operation = connectionOperation();

    await manager.prepareProfile('gemini_cli', operation);
    await manager.prepareProfile('gemini_cli', operation);

    expect(mkdirCalls.map(({ path }) => path)).toEqual([...expectedPaths, ...expectedPaths]);
    expect(mkdirCalls.every(({ mode }) => mode === 0o700)).toBe(true);
    expect(secured).toEqual([...expectedPaths, ...expectedPaths]);
    expect(mkdirCalls.every(({ path }) => !path.includes(requestId))).toBe(true);
  });

  it('rejects every noncanonical configured managed root at construction', () => {
    const options = {
      userDataRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp',
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: `${runtimeRoot}\\profiles`,
      providerTempRoot: `${runtimeRoot}\\temp`,
      providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
      directories: { mkdir: async () => {}, remove: async () => {} },
      files: {
        canonicalize: async (path: string) => path,
        assertNoReparsePoints: async () => {},
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      acl: { secure: async () => {} },
    };

    for (const [key, value] of [
      ['providerProfilesRoot', `${runtimeRoot}\\profiles\\..\\profiles`],
      ['providerTempRoot', `${runtimeRoot}\\temp\\..\\temp`],
      ['providerWorkspaceRoot', `${runtimeRoot}\\workspace\\..\\workspace`],
    ] as const) {
      expect(() => createCliPrivateDirectoryManagerForTest({ ...options, [key]: value })).toThrow(
        expect.objectContaining({
          code: 'PROVIDER_UNSAFE_VERSION',
          message: 'PROVIDER_UNSAFE_VERSION',
        }),
      );
    }
  });

  it('rejects an invalid profile provider before any filesystem or ACL activity', async () => {
    const activity: string[] = [];
    const manager = createCliPrivateDirectoryManagerForTest({
      userDataRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp',
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: `${runtimeRoot}\\profiles`,
      providerTempRoot: `${runtimeRoot}\\temp`,
      providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
      directories: {
        mkdir: async () => {
          activity.push('mkdir');
        },
        remove: async () => {
          activity.push('remove');
        },
      },
      files: {
        canonicalize: async (path) => {
          activity.push('canonicalize');
          return path;
        },
        assertNoReparsePoints: async () => {
          activity.push('reparse');
        },
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      acl: {
        secure: async () => {
          activity.push('acl');
        },
      },
    });

    await expect(
      manager.prepareProfile('attacker\\profile', connectionOperation()),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
      message: 'PROVIDER_UNSAFE_VERSION',
    });
    expect(activity).toEqual([]);
  });

  it('rejects a pre-aborted profile operation before any filesystem or ACL activity', async () => {
    const activity: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const manager = createCliPrivateDirectoryManagerForTest({
      userDataRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp',
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: `${runtimeRoot}\\profiles`,
      providerTempRoot: `${runtimeRoot}\\temp`,
      providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
      directories: {
        mkdir: async () => {
          activity.push('mkdir');
        },
        remove: async () => {
          activity.push('remove');
        },
      },
      files: {
        canonicalize: async (path) => {
          activity.push('canonicalize');
          return path;
        },
        assertNoReparsePoints: async () => {
          activity.push('reparse');
        },
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      acl: {
        secure: async () => {
          activity.push('acl');
        },
      },
    });

    await expect(
      manager.prepareProfile('gemini_cli', connectionOperation(requestId, controller)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
      message: 'PROVIDER_CANCELLED',
    });
    expect(activity).toEqual([]);
  });

  it.each([
    { stage: 'reparse', expectedMkdirs: 0, expectedAcls: 0 },
    { stage: 'canonical', expectedMkdirs: 1, expectedAcls: 0 },
    { stage: 'acl', expectedMkdirs: 1, expectedAcls: 1 },
  ] as const)(
    'fails closed and sanitizes a $stage profile bootstrap failure',
    async ({ stage, expectedMkdirs, expectedAcls }) => {
      const userDataRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp';
      const existing = new Set([userDataRoot.toLowerCase()]);
      let mkdirs = 0;
      let acls = 0;
      const manager = createCliPrivateDirectoryManagerForTest({
        userDataRoot,
        providerRuntimeRoot: runtimeRoot,
        providerProfilesRoot: `${runtimeRoot}\\profiles`,
        providerTempRoot: `${runtimeRoot}\\temp`,
        providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
        directories: {
          mkdir: async (path) => {
            mkdirs += 1;
            existing.add(path.toLowerCase());
          },
          remove: async () => {},
        },
        files: {
          canonicalize: async (path) => {
            if (!existing.has(path.toLowerCase())) {
              throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            }
            if (stage === 'canonical' && path.toLowerCase() === runtimeRoot.toLowerCase()) {
              return 'C:\\private-attacker-target';
            }
            return path;
          },
          assertNoReparsePoints: async (path) => {
            if (stage === 'reparse' && path.toLowerCase() === runtimeRoot.toLowerCase()) {
              throw new Error('private reparse path detail');
            }
            if (!existing.has(path.toLowerCase())) {
              throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            }
          },
          readFile: async () => new Uint8Array(),
          listChildren: async () => [],
        },
        acl: {
          secure: async () => {
            acls += 1;
            if (stage === 'acl') throw new Error('private ACL target detail');
          },
        },
      });

      const pending = manager.prepareProfile('gemini_cli', connectionOperation());

      await expect(pending).rejects.toMatchObject({
        code: 'PROVIDER_UNSAFE_VERSION',
        message: 'PROVIDER_UNSAFE_VERSION',
      });
      await expect(pending).rejects.not.toThrow(/private|attacker|reparse|ACL/iu);
      expect(mkdirs).toBe(expectedMkdirs);
      expect(acls).toBe(expectedAcls);
    },
  );

  it('stops before the next dependency at every asynchronous profile preparation boundary', async () => {
    const userDataRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp';
    for (let stopAfter = 1; stopAfter <= 17; stopAfter += 1) {
      const controller = new AbortController();
      let calls = 0;
      const checkpoint = (): void => {
        calls += 1;
        if (calls === stopAfter) controller.abort();
      };
      const manager = createCliPrivateDirectoryManagerForTest({
        userDataRoot,
        providerRuntimeRoot: runtimeRoot,
        providerProfilesRoot: `${runtimeRoot}\\profiles`,
        providerTempRoot: `${runtimeRoot}\\temp`,
        providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
        directories: {
          mkdir: async () => {
            checkpoint();
          },
          remove: async () => {},
        },
        files: {
          canonicalize: async (path) => {
            checkpoint();
            return path;
          },
          assertNoReparsePoints: async () => {
            checkpoint();
          },
          readFile: async () => new Uint8Array(),
          listChildren: async () => [],
        },
        acl: {
          secure: async () => {
            checkpoint();
          },
        },
      });

      await expect(
        manager.prepareProfile('gemini_cli', connectionOperation(requestId, controller)),
        `checkpoint ${stopAfter}`,
      ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(calls, `checkpoint ${stopAfter}`).toBe(stopAfter);
    }
  });

  it('creates every managed component with 0700 semantics and deletes only the exact request UUID', async () => {
    const mkdirCalls: Array<Readonly<{ path: string; mode: number }>> = [];
    const removeCalls: string[] = [];
    const secured: string[] = [];
    const canonicalPaths = new Map<string, string>();
    const removedPaths = new Set<string>();
    const directories = {
      mkdir: async (path: string, options: Readonly<{ recursive: true; mode: number }>) => {
        mkdirCalls.push({ path, mode: options.mode });
        canonicalPaths.set(path.toLowerCase(), path);
      },
      remove: async (path: string) => {
        removeCalls.push(path);
        canonicalPaths.delete(path.toLowerCase());
        removedPaths.add(path.toLowerCase());
      },
    };
    const manager = createCliPrivateDirectoryManagerForTest({
      userDataRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp',
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: `${runtimeRoot}\\profiles`,
      providerTempRoot: `${runtimeRoot}\\temp`,
      providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
      directories,
      files: {
        canonicalize: async (path) => {
          if (removedPaths.has(path.toLowerCase())) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return canonicalPaths.get(path.toLowerCase()) ?? path;
        },
        assertNoReparsePoints: async (path) => {
          if (removedPaths.has(path.toLowerCase())) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
        },
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      acl: {
        secure: async (path) => {
          secured.push(path);
        },
      },
    });
    const operation = connectionOperation();

    await manager.prepareRequest('gemini_cli', requestId, workspace, operation);
    await manager.cleanupRequest(requestId, workspace);

    expect(mkdirCalls.length).toBeGreaterThan(6);
    expect(mkdirCalls.every((call) => call.mode === 0o700)).toBe(true);
    expect(secured).toContain(workspace);
    expect(secured).toContain(`${runtimeRoot}\\temp\\${requestId}`);
    expect(removeCalls).toEqual([workspace, `${runtimeRoot}\\temp\\${requestId}`]);

    await expect(
      manager.cleanupRequest(requestId, `${runtimeRoot}\\workspace\\..\\ordinary-profile`),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(removeCalls).toEqual([workspace, `${runtimeRoot}\\temp\\${requestId}`]);

    const mkdirCount = mkdirCalls.length;
    await expect(
      manager.prepareRequest('gemini_cli', requestId, workspace, connectionOperation(randomUUID())),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(mkdirCalls).toHaveLength(mkdirCount);
  });

  it('treats already-missing request directories as clean and still removes an existing sibling', async () => {
    const requestTemp = `${runtimeRoot}\\temp\\${requestId}`;
    const existing = new Set([
      'C:\\Users\\student\\AppData\\Local\\StudyApp'.toLowerCase(),
      requestTemp.toLowerCase(),
    ]);
    const removeCalls: string[] = [];
    const manager = createCliPrivateDirectoryManagerForTest({
      userDataRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp',
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: `${runtimeRoot}\\profiles`,
      providerTempRoot: `${runtimeRoot}\\temp`,
      providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
      directories: {
        mkdir: async () => {},
        remove: async (path) => {
          removeCalls.push(path);
          if (!existing.delete(path.toLowerCase())) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
        },
      },
      files: {
        canonicalize: async (path) => {
          if (!existing.has(path.toLowerCase())) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return path;
        },
        assertNoReparsePoints: async (path) => {
          if (!existing.has(path.toLowerCase())) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
        },
        readFile: async () => new Uint8Array(),
        listChildren: async (path) => {
          if (!existing.has(path.toLowerCase())) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return [];
        },
      },
      acl: { secure: async () => {} },
    });

    await expect(manager.cleanupRequest(requestId, workspace)).resolves.toBeUndefined();
    expect(removeCalls).toEqual([requestTemp]);
  });

  it('attempts both exact request removals when the workspace removal fails', async () => {
    const requestTemp = `${runtimeRoot}\\temp\\${requestId}`;
    const existing = new Set([
      'C:\\Users\\student\\AppData\\Local\\StudyApp'.toLowerCase(),
      workspace.toLowerCase(),
      requestTemp.toLowerCase(),
    ]);
    const removeCalls: string[] = [];
    const manager = createCliPrivateDirectoryManagerForTest({
      userDataRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp',
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: `${runtimeRoot}\\profiles`,
      providerTempRoot: `${runtimeRoot}\\temp`,
      providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
      directories: {
        mkdir: async () => {},
        remove: async (path) => {
          removeCalls.push(path);
          if (path === workspace) throw new Error('workspace removal failed');
          existing.delete(path.toLowerCase());
        },
      },
      files: {
        canonicalize: async (path) => {
          if (!existing.has(path.toLowerCase())) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return path;
        },
        assertNoReparsePoints: async (path) => {
          if (!existing.has(path.toLowerCase())) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
        },
        readFile: async () => new Uint8Array(),
        listChildren: async (path) => {
          if (!existing.has(path.toLowerCase())) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return [];
        },
      },
      acl: { secure: async () => {} },
    });

    await expect(manager.cleanupRequest(requestId, workspace)).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
      message: 'PROVIDER_RESIDUAL_DATA',
    });
    expect(removeCalls).toEqual([workspace, requestTemp]);
  });

  it('bounds a stalled exact-directory removal and observes its late rejection', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    let notifyRemovalStarted: (() => void) | null = null;
    const removalStarted = new Promise<void>((resolve) => {
      notifyRemovalStarted = resolve;
    });
    let rejectRemoval!: (reason: Error) => void;
    const stalledRemoval = new Promise<void>((_resolve, reject) => {
      rejectRemoval = reject;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const manager = createCliPrivateDirectoryManagerForTest({
        userDataRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp',
        providerRuntimeRoot: runtimeRoot,
        providerProfilesRoot: `${runtimeRoot}\\profiles`,
        providerTempRoot: `${runtimeRoot}\\temp`,
        providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
        directories: {
          mkdir: async () => {},
          remove: () => {
            notifyRemovalStarted?.();
            return stalledRemoval;
          },
        },
        files: {
          canonicalize: async (path) => path,
          assertNoReparsePoints: async () => {},
          readFile: async () => new Uint8Array(),
          listChildren: async () => [],
        },
        acl: { secure: async () => {} },
      });

      const pending = manager.cleanupRequest(requestId, workspace);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await removalStarted;

      expect(timeoutSpy).toHaveBeenCalledWith(5_000);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });

      rejectRemoval(new Error('private late removal failure'));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rejects a noncanonical trusted user-data root before creating directories', async () => {
    const mkdirCalls: string[] = [];
    const manager = createCliPrivateDirectoryManagerForTest({
      userDataRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp',
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: `${runtimeRoot}\\profiles`,
      providerTempRoot: `${runtimeRoot}\\temp`,
      providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
      directories: {
        mkdir: async (path) => {
          mkdirCalls.push(path);
        },
        remove: async () => {},
      },
      files: {
        canonicalize: async (path) =>
          path === 'C:\\Users\\student\\AppData\\Local\\StudyApp' ? 'C:\\Attacker\\StudyApp' : path,
        assertNoReparsePoints: async () => {},
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      acl: { secure: async () => {} },
    });

    await expect(
      manager.prepareRequest('gemini_cli', requestId, workspace, connectionOperation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(mkdirCalls).toHaveLength(0);
  });

  it('rejects a pre-existing managed reparse ancestor before recursive mkdir, ACL, or spawn', async () => {
    const userDataRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp';
    const reparseAncestor = runtimeRoot;
    const mkdirCalls: string[] = [];
    const secured: string[] = [];
    let spawnCalls = 0;
    const manager = createCliPrivateDirectoryManagerForTest({
      userDataRoot,
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: `${runtimeRoot}\\profiles`,
      providerTempRoot: `${runtimeRoot}\\temp`,
      providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
      directories: {
        mkdir: async (path) => {
          mkdirCalls.push(path);
        },
        remove: async () => {},
      },
      files: {
        canonicalize: async (path) => {
          if (
            path.toLowerCase() === workspace.toLowerCase() ||
            path.toLowerCase() === `${runtimeRoot}\\temp\\${requestId}`.toLowerCase()
          ) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return path;
        },
        assertNoReparsePoints: async (path) => {
          if (
            path.toLowerCase() === workspace.toLowerCase() ||
            path.toLowerCase() === `${runtimeRoot}\\temp\\${requestId}`.toLowerCase()
          ) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          if (path.toLowerCase() === reparseAncestor.toLowerCase()) {
            throw new Error('REPARSE_POINT');
          }
        },
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      acl: {
        secure: async (path) => {
          secured.push(path);
        },
      },
    });
    const base = createHarness();
    const runner = createNodeCliProcessRunnerForTest({
      binding,
      inspector: { revalidate: async () => binding },
      aliases: base.aliases,
      directories: manager,
      spawner: {
        spawn: () => {
          spawnCalls += 1;
          throw new Error('must not spawn');
        },
      },
      identities: base.identities,
      terminator: base.terminator,
      tools: { runVerified: async (_path, _operation, run) => run() },
    });

    await expect(runner.run(request('echo-stdin-json'))).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
    expect(mkdirCalls).toHaveLength(0);
    expect(secured).toHaveLength(0);
    expect(spawnCalls).toBe(0);
  });

  it('rejects the paired request temp directory as provider cwd before spawn', async () => {
    const mkdirCalls: string[] = [];
    let spawnCalls = 0;
    const manager = createCliPrivateDirectoryManagerForTest({
      userDataRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp',
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: `${runtimeRoot}\\profiles`,
      providerTempRoot: `${runtimeRoot}\\temp`,
      providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
      directories: {
        mkdir: async (path) => {
          mkdirCalls.push(path);
        },
        remove: async () => {},
      },
      files: {
        canonicalize: async (path) => path,
        assertNoReparsePoints: async () => {},
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      acl: { secure: async () => {} },
    });
    const base = createHarness();
    const runner = createNodeCliProcessRunnerForTest({
      binding,
      inspector: { revalidate: async () => binding },
      aliases: base.aliases,
      directories: manager,
      spawner: {
        spawn: () => {
          spawnCalls += 1;
          throw new Error('must not spawn');
        },
      },
      identities: base.identities,
      terminator: base.terminator,
      tools: { runVerified: async (_path, _operation, run) => run() },
    });

    await expect(
      runner.run(request('echo-stdin-json', { cwd: `${runtimeRoot}\\temp\\${requestId}` })),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(mkdirCalls).toHaveLength(0);
    expect(spawnCalls).toBe(0);
  });

  it('preflights through the deepest existing ancestor while allowing missing descendants', async () => {
    const userDataRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp';
    const existing = new Set([userDataRoot.toLowerCase()]);
    const mkdirCalls: string[] = [];
    const manager = createCliPrivateDirectoryManagerForTest({
      userDataRoot,
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: `${runtimeRoot}\\profiles`,
      providerTempRoot: `${runtimeRoot}\\temp`,
      providerWorkspaceRoot: `${runtimeRoot}\\workspace`,
      directories: {
        mkdir: async (path) => {
          mkdirCalls.push(path);
          existing.add(path.toLowerCase());
        },
        remove: async () => {},
      },
      files: {
        canonicalize: async (path) => {
          if (!existing.has(path.toLowerCase()))
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return path;
        },
        assertNoReparsePoints: async (path) => {
          if (!existing.has(path.toLowerCase()))
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      acl: { secure: async () => {} },
    });

    await expect(
      manager.prepareRequest('gemini_cli', requestId, workspace, connectionOperation()),
    ).resolves.toBeUndefined();
    expect(mkdirCalls[0]).toBe(runtimeRoot);
    expect(mkdirCalls).toContain(workspace);
  });
});

describe('verified process-tree termination', () => {
  it('invokes only fixed taskkill.exe with the verified PID tuple and shell disabled', async () => {
    const requests: CliProcessRequest[] = [];
    const paths: string[] = [];
    const tools: WindowsToolIdentityGuard = {
      runVerified: async (path, _operation, run) => {
        paths.push(path);
        return run();
      },
    };
    const terminator = createWindowsProcessTreeTerminatorForTest({
      runner: {
        run: async (value) => {
          requests.push(value);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        cancel: () => {},
      },
      tools,
    });

    await terminator.terminate({
      pid: 4321,
      creationTime: '2026-09-02T00:00:00.000Z',
      canonicalImagePath: process.execPath,
    });

    expect(paths).toEqual([WINDOWS_TASKKILL_PATH]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      launcherPath: WINDOWS_TASKKILL_PATH,
      args: ['/PID', '4321', '/T', '/F'],
      shell: false,
      env: {
        SystemRoot: 'C:\\Windows',
        WINDIR: 'C:\\Windows',
        PATH: 'C:\\Windows\\System32',
        NO_COLOR: '1',
      },
    });
  });

  it('hard-bounds a taskkill runner that ignores its cleanup signal', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const terminator = createWindowsProcessTreeTerminatorForTest({
        runner: {
          run: async () => new Promise<CliProcessResult>(() => undefined),
          cancel: () => undefined,
        },
        tools: { runVerified: async (_path, _operation, run) => run() },
      });
      let settled = false;
      let failure: unknown;
      void terminator
        .terminate({
          pid: 4321,
          creationTime: '2026-09-02T00:00:00.000Z',
          canonicalImagePath: process.execPath,
        })
        .catch((error: unknown) => {
          failure = error;
        })
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(failure).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('Windows process identity capture', () => {
  it('queries a PID only through the fixed helper env slot and returns a strict canonical tuple', async () => {
    const requests: CliProcessRequest[] = [];
    const imagePath = 'C:\\Program Files\\nodejs\\node.exe';
    const operation = connectionOperation();
    const identities = createWindowsProcessIdentityProviderForTest({
      runner: {
        run: async (value) => {
          requests.push(value);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              pid: 4321,
              creationTime: '2026-09-02T00:00:00.000Z',
              imagePath: 'S:\\node.exe',
            }),
            stderr: '',
          };
        },
        cancel: () => {},
      },
      files: {
        canonicalize: async (path) => (path === 'S:\\node.exe' ? imagePath : path),
        assertNoReparsePoints: async () => {},
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      hasher: { sha256: async () => 'a'.repeat(64) },
    });

    await expect(identities.capture(4321, operation)).resolves.toEqual({
      pid: 4321,
      creationTime: '2026-09-02T00:00:00.000Z',
      canonicalImagePath: imagePath,
    });
    expect(requests[0]?.env).toEqual({ [PROCESS_IDENTITY_PID_ENVIRONMENT_KEY]: '4321' });
    expect(requests[0]?.requestId).toBe(operation.requestId);
    expect(requests[0]?.signal).toBe(operation.signal);
    expect(requests[0]?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      WINDOWS_PROCESS_IDENTITY_ENCODED_COMMAND,
    ]);
    const script = Buffer.from(WINDOWS_PROCESS_IDENTITY_ENCODED_COMMAND, 'base64').toString(
      'utf16le',
    );
    expect(script).toContain('Get-CimInstance');
    expect(script).toContain("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
    expect(script).not.toContain('4321');
  });

  it('rejects process identity output with unexpected fields', async () => {
    const identities = createWindowsProcessIdentityProviderForTest({
      runner: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            pid: 4321,
            creationTime: '2026-09-02T00:00:00.000Z',
            imagePath: 'C:\\Program Files\\nodejs\\node.exe',
            commandLine: 'private argv',
          }),
          stderr: '',
        }),
        cancel: () => {},
      },
      files: {
        canonicalize: async (path) => path,
        assertNoReparsePoints: async () => {},
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      hasher: { sha256: async () => 'a'.repeat(64) },
    });

    await expect(identities.capture(4321, connectionOperation())).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
  });
});
