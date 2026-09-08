import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../../../src/core/ports/aiProvider';
import type {
  OpenCliLoginRequest,
  OpenCliLogoutRequest,
} from '../../../../../src/core/ports/cliLoginLauncher';
import type {
  VisibleProcessOptions,
  VisibleProcessSpawner,
} from '../../../../../src/infrastructure/providers/cli/windowsTerminalLoginLauncher';
import {
  createWindowsTerminalLoginLauncherForTest,
  LOGIN_ARGV,
  PROFILE_SCOPED_LOGOUT_ARGV,
  WINDOWS_TERMINAL_PATH,
} from '../../../../../src/infrastructure/providers/cli/windowsTerminalLoginLauncher';
import type {
  WindowsToolIdentityGuard,
  WindowsWorkspaceAlias,
  WindowsWorkspaceAliasLease,
} from '../../../../../src/infrastructure/providers/cli/windowsWorkspaceAlias';
import { parseSafeSemVer } from '../../../../../src/shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../../../src/shared/errors';

const binding = Object.freeze({
  providerId: 'codex_cli',
  canonicalLauncherPath:
    'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe',
  canonicalEntryPath:
    'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
  canonicalPackageManifestPath:
    'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\package.json',
  canonicalPlatformPackageManifestPath:
    'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\package.json',
  fixedPrefixArgs: Object.freeze([]),
  version: parseSafeSemVer('0.146.0'),
  launcherSha256: 'a'.repeat(64),
  entrySha256: 'b'.repeat(64),
  packageManifestSha256: 'c'.repeat(64),
  platformPackageManifestSha256: 'd'.repeat(64),
  bindingSha256: 'e'.repeat(64),
  recipeId: 'codex-0.146-profile-keyring-v2',
  credentialScope: 'profile_scoped',
  signerClassification: 'openai',
  checkedAt: '2026-09-02T00:00:00.000Z',
}) satisfies CliRuntimeBinding<'codex_cli', 'profile_scoped'>;

const TEST_REQUEST_ID = '11111111-1111-4111-8111-111111111111';

const connectionOperation = (
  controller = new AbortController(),
  requestId = randomUUID(),
): ProviderConnectionOperation =>
  Object.freeze({
    requestId,
    signal: controller.signal,
  });

const loginRequest = (overrides: Partial<OpenCliLoginRequest> = {}): OpenCliLoginRequest =>
  Object.freeze({
    ...connectionOperation(),
    binding,
    credentialPresent: false,
    confirmSharedCredentialMutation: true,
    ...overrides,
  });

const logoutRequest = (overrides: Partial<OpenCliLogoutRequest> = {}): OpenCliLogoutRequest =>
  Object.freeze({
    ...connectionOperation(),
    binding,
    ...overrides,
  });

const shutdownSignal = (): AbortSignal => new AbortController().signal;

class Aliases implements WindowsWorkspaceAlias {
  releases = 0;
  acquisitions = 0;
  revalidations = 0;
  readonly acquireOperations: ProviderConnectionOperation[] = [];
  readonly revalidationOperations: ProviderConnectionOperation[] = [];
  launcherPath = 'S:\\codex.exe';
  fixedPrefixArgs: readonly string[] = Object.freeze([]);
  profileRoot = 'R:\\profiles\\codex_cli';
  rejectedCanonicalPath: string | null = null;

  async acquire(
    current: CliRuntimeBinding,
    operation: ProviderConnectionOperation,
  ): Promise<WindowsWorkspaceAliasLease> {
    this.acquisitions += 1;
    this.acquireOperations.push(operation);
    return Object.freeze({
      providerId: current.providerId,
      runtimeRoot: 'R:\\',
      profileRoot: this.profileRoot,
      workspaceRoot: 'R:\\workspace',
      tempRoot: 'R:\\temp',
      launcherPath: this.launcherPath,
      fixedPrefixArgs: this.fixedPrefixArgs,
      rewritePath: (path: string) => path,
      assertNoCanonicalPathDisclosure: (value: string) => {
        if (
          this.rejectedCanonicalPath !== null &&
          value.toLowerCase().includes(this.rejectedCanonicalPath.toLowerCase())
        ) {
          throw new AppError('PROVIDER_UNSAFE_VERSION', APP_ERROR_MESSAGES.PROVIDER_UNSAFE_VERSION);
        }
      },
      revalidate: async (leaseOperation) => {
        this.revalidations += 1;
        this.revalidationOperations.push(leaseOperation);
      },
      release: async () => {
        this.releases += 1;
      },
    });
  }

  async cleanupStale(
    _current: CliRuntimeBinding,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {}
}

class ToolGuard implements WindowsToolIdentityGuard {
  readonly paths: string[] = [];
  readonly operations: ProviderConnectionOperation[] = [];
  missing = false;
  drift = false;
  driftAfterLaunch = false;

  async runVerified<T>(
    path: string,
    connection: ProviderConnectionOperation,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.paths.push(path);
    this.operations.push(connection);
    if (this.missing) throw new Error('ENOENT');
    if (this.drift) {
      throw new AppError('PROVIDER_UNSAFE_VERSION', APP_ERROR_MESSAGES.PROVIDER_UNSAFE_VERSION);
    }
    const result = await operation();
    if (this.driftAfterLaunch) {
      throw new AppError('PROVIDER_UNSAFE_VERSION', APP_ERROR_MESSAGES.PROVIDER_UNSAFE_VERSION);
    }
    return result;
  }
}

class Spawner implements VisibleProcessSpawner {
  readonly calls: Array<
    Readonly<{ file: string; args: readonly string[]; options: VisibleProcessOptions }>
  > = [];

  async spawn(
    file: string,
    args: readonly string[],
    options: VisibleProcessOptions,
  ): Promise<void> {
    this.calls.push(Object.freeze({ file, args: Object.freeze([...args]), options }));
  }
}

const deferred = <T = void>() => {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const harness = (options: Readonly<{ terminalCwd?: string }> = {}) => {
  const aliases = new Aliases();
  const tools = new ToolGuard();
  const spawner = new Spawner();
  let revalidationCalls = 0;
  const revalidationOperations: ProviderConnectionOperation[] = [];
  return {
    aliases,
    tools,
    spawner,
    revalidationCalls: () => revalidationCalls,
    revalidationOperations,
    launcher: createWindowsTerminalLoginLauncherForTest({
      inspector: {
        revalidate: async (current, operation) => {
          revalidationCalls += 1;
          revalidationOperations.push(operation);
          return current;
        },
      },
      aliases,
      tools,
      spawner,
      inheritedEnvironment: {
        PATH: 'C:\\Attacker',
        OPENAI_API_KEY: 'private-key',
        NODE_OPTIONS: '--require attacker.js',
      },
      ...(options.terminalCwd === undefined ? {} : { terminalCwd: options.terminalCwd }),
    }),
  };
};

describe('Windows Terminal CLI login launcher', () => {
  it('opens the exact profile-scoped Codex device-login argv without shared mutation confirmation', async () => {
    const setup = harness();

    await setup.launcher.openLogin(loginRequest({ confirmSharedCredentialMutation: false }));

    expect(LOGIN_ARGV).toEqual({
      antigravity_cli: [],
      gemini_cli: [],
      codex_cli: LOGIN_ARGV.codex_cli,
    });
    expect(LOGIN_ARGV.codex_cli.slice(0, 2)).toEqual(['login', '--device-auth']);
    expect(LOGIN_ARGV.codex_cli).toContain('cli_auth_credentials_store="keyring"');
    expect(LOGIN_ARGV.codex_cli).toContain('secret_auth_storage');
    expect(setup.spawner.calls).toHaveLength(1);
    expect(setup.spawner.calls[0]).toMatchObject({
      file: WINDOWS_TERMINAL_PATH,
      args: [
        'new-tab',
        '--title',
        'Codex CLI 로그인',
        '--',
        'S:\\codex.exe',
        ...LOGIN_ARGV.codex_cli,
      ],
      options: { shell: false, windowsHide: false },
    });
    expect(setup.spawner.calls[0]?.options.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(setup.spawner.calls[0]?.options.env.PATH).toBe('C:\\Windows\\System32');
    expect(setup.tools.paths).toEqual([WINDOWS_TERMINAL_PATH]);
    expect(setup.revalidationCalls()).toBe(3);
    expect(setup.aliases.revalidations).toBe(2);
    expect(setup.aliases.releases).toBe(0);
  });

  it('starts Windows Terminal from the fixed verified System32 directory while keeping provider paths explicit', async () => {
    const setup = harness();

    await setup.launcher.openLogin(loginRequest());

    expect(setup.spawner.calls).toHaveLength(1);
    expect(setup.spawner.calls[0]?.options.cwd).toBe('C:\\Windows\\System32');
    expect(setup.spawner.calls[0]?.args).toContain('S:\\codex.exe');
    expect(setup.spawner.calls[0]?.options.env.USERPROFILE).toBe('R:\\profiles\\codex_cli\\user');
  });

  it('rejects a private Windows Terminal cwd before visible spawn without disclosing it', async () => {
    const privateCwd =
      'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers\\workspace\\request-private';
    const setup = harness({ terminalCwd: privateCwd });
    setup.aliases.rejectedCanonicalPath = privateCwd;
    let failure: unknown;

    try {
      await setup.launcher.openLogin(loginRequest());
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(failure instanceof Error ? failure.message : String(failure)).not.toContain(privateCwd);
    expect(setup.spawner.calls).toHaveLength(0);
    expect(setup.aliases.releases).toBe(1);
  });

  it.each(['launcherPath', 'fixedPrefixArgs', 'generatedEnvironment'] as const)(
    'blocks a private canonical path from %s before visible spawn and keeps the public error path-free',
    async (source) => {
      const setup = harness();
      const privatePath =
        'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers\\profiles\\codex_cli\\private';
      setup.aliases.rejectedCanonicalPath = privatePath;
      if (source === 'launcherPath') setup.aliases.launcherPath = privatePath;
      if (source === 'fixedPrefixArgs') {
        setup.aliases.fixedPrefixArgs = Object.freeze([`--schema=${privatePath}`]);
      }
      if (source === 'generatedEnvironment') setup.aliases.profileRoot = privatePath;
      let failure: unknown;

      try {
        await setup.launcher.openLogin(loginRequest());
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
      expect(failure instanceof Error ? failure.message : String(failure)).not.toContain(
        privatePath,
      );
      expect(setup.spawner.calls).toHaveLength(0);
      expect(setup.aliases.releases).toBe(1);
    },
  );

  it('blocks a profile-scoped login when a credential already exists', async () => {
    const setup = harness();

    await expect(
      setup.launcher.openLogin(loginRequest({ credentialPresent: true })),
    ).rejects.toMatchObject({ code: 'PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED' });
    expect(setup.spawner.calls).toHaveLength(0);
    expect(setup.aliases.acquisitions).toBe(0);
  });

  it('rejects a provider and recipe mismatch before acquiring a login lease', async () => {
    const setup = harness();

    await expect(
      setup.launcher.openLogin(
        loginRequest({
          binding: Object.freeze({
            ...binding,
            providerId: 'antigravity_cli',
          }) as never,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(setup.spawner.calls).toHaveLength(0);
    expect(setup.aliases.acquisitions).toBe(0);
  });

  it('does not require shared mutation confirmation when no profile-scoped credential exists', async () => {
    const setup = harness();

    await setup.launcher.openLogin(loginRequest({ confirmSharedCredentialMutation: false }));

    expect(setup.spawner.calls).toHaveLength(1);
  });

  it('rejects an already-aborted login before any inspection, alias, tool, or spawn side effect', async () => {
    const setup = harness();
    const caller = new AbortController();
    caller.abort();

    await expect(
      setup.launcher.openLogin(
        loginRequest({
          ...connectionOperation(caller, TEST_REQUEST_ID),
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });

    expect(setup.revalidationCalls()).toBe(0);
    expect(setup.aliases.acquisitions).toBe(0);
    expect(setup.tools.paths).toHaveLength(0);
    expect(setup.spawner.calls).toHaveLength(0);
  });

  it.each(['binding-revalidation', 'alias-acquisition', 'terminal-spawn'] as const)(
    'propagates external cancellation through the same request operation during %s',
    async (phase) => {
      const aliases = new Aliases();
      const tools = new ToolGuard();
      const spawner = new Spawner();
      const entered = deferred();
      const releasePhase = deferred();
      const inspectorOperations: ProviderConnectionOperation[] = [];
      const caller = new AbortController();
      const originalAcquire = aliases.acquire.bind(aliases);
      aliases.acquire = async (current, operation) => {
        if (phase === 'alias-acquisition') {
          entered.resolve();
          await releasePhase.promise;
        }
        return originalAcquire(current, operation);
      };
      spawner.spawn = async (file, args, options) => {
        if (phase === 'terminal-spawn') {
          entered.resolve();
          await releasePhase.promise;
          if (options.signal.aborted) throw new Error('cancelled before spawn');
        }
        spawner.calls.push(Object.freeze({ file, args: Object.freeze([...args]), options }));
      };
      const launcher = createWindowsTerminalLoginLauncherForTest({
        inspector: {
          revalidate: async (current, operation) => {
            inspectorOperations.push(operation);
            if (phase === 'binding-revalidation' && inspectorOperations.length === 1) {
              entered.resolve();
              await releasePhase.promise;
            }
            return current;
          },
        },
        aliases,
        tools,
        spawner,
        inheritedEnvironment: {},
      });
      const opening = launcher.openLogin(
        loginRequest({
          ...connectionOperation(caller, TEST_REQUEST_ID),
        }),
      );
      await entered.promise;
      const observedBeforeCancellation = [
        ...inspectorOperations,
        ...aliases.acquireOperations,
        ...aliases.revalidationOperations,
        ...tools.operations,
      ];
      const combinedSignal = observedBeforeCancellation[0]?.signal;

      expect(observedBeforeCancellation.length).toBeGreaterThan(0);
      expect(combinedSignal).toBeInstanceOf(AbortSignal);
      expect(combinedSignal).not.toBe(caller.signal);
      for (const operation of observedBeforeCancellation) {
        expect(operation.requestId).toBe(TEST_REQUEST_ID);
        expect(operation.signal).toBe(combinedSignal);
      }
      if (phase === 'terminal-spawn') {
        expect(spawner.calls).toHaveLength(0);
      }

      caller.abort();
      expect(combinedSignal?.aborted).toBe(true);
      releasePhase.resolve();

      await expect(opening).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(spawner.calls).toHaveLength(0);
      expect(aliases.releases).toBe(phase === 'binding-revalidation' ? 0 : 1);
    },
  );

  it('opens at most one concurrent shared-login session per provider', async () => {
    const setup = harness();
    let releaseSpawn: (() => void) | undefined;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const spawn = setup.spawner.spawn.bind(setup.spawner);
    setup.spawner.spawn = async (...args) => {
      await spawn(...args);
      await spawnGate;
    };
    const input = loginRequest();

    const first = setup.launcher.openLogin(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = setup.launcher.openLogin(input);
    const secondFailure = second.catch((error: unknown) => error);
    await nextTurn();
    releaseSpawn?.();

    await first;
    expect(await secondFailure).toMatchObject({
      code: 'PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED',
    });
    expect(setup.spawner.calls).toHaveLength(1);
  });

  it.each([
    ['cancel', 'binding-revalidation'],
    ['cancel', 'alias-acquisition'],
    ['cancel', 'terminal-spawn'],
    ['shutdown', 'binding-revalidation'],
    ['shutdown', 'alias-acquisition'],
    ['shutdown', 'terminal-spawn'],
  ] as const)(
    '%s prevents a pending %s phase from later opening a terminal or retaining its lease',
    async (action, phase) => {
      const aliases = new Aliases();
      const tools = new ToolGuard();
      const spawner = new Spawner();
      const entered = deferred();
      const releasePhase = deferred();
      let revalidationCalls = 0;
      const originalAcquire = aliases.acquire.bind(aliases);
      aliases.acquire = async (current, operation) => {
        if (phase === 'alias-acquisition') {
          entered.resolve();
          await releasePhase.promise;
        }
        return originalAcquire(current, operation);
      };
      spawner.spawn = async (file, args, options) => {
        if (phase === 'terminal-spawn') {
          entered.resolve();
          await releasePhase.promise;
          const cancellable = options as VisibleProcessOptions & { signal?: AbortSignal };
          if (cancellable.signal?.aborted === true) throw new Error('cancelled before spawn');
        }
        spawner.calls.push(Object.freeze({ file, args: Object.freeze([...args]), options }));
      };
      const launcher = createWindowsTerminalLoginLauncherForTest({
        inspector: {
          revalidate: async (current, _operation) => {
            revalidationCalls += 1;
            if (phase === 'binding-revalidation' && revalidationCalls === 1) {
              entered.resolve();
              await releasePhase.promise;
            }
            return current;
          },
        },
        aliases,
        tools,
        spawner,
        inheritedEnvironment: {},
      });
      const opening = launcher.openLogin(loginRequest());
      await entered.promise;

      const stopping =
        action === 'cancel' ? launcher.cancel('codex_cli') : launcher.shutdown(shutdownSignal());
      releasePhase.resolve();

      await expect(opening).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      await expect(stopping).resolves.toBeUndefined();
      expect(spawner.calls).toHaveLength(0);
      expect(aliases.releases).toBe(phase === 'binding-revalidation' ? 0 : 1);
    },
  );

  it.each(['cancel', 'shutdown'] as const)(
    '%s releases exactly once when the terminal opened before post-spawn validation completed',
    async (action) => {
      const aliases = new Aliases();
      const tools = new ToolGuard();
      const spawner = new Spawner();
      const postSpawnEntered = deferred();
      const releasePostSpawn = deferred();
      let revalidationCalls = 0;
      const launcher = createWindowsTerminalLoginLauncherForTest({
        inspector: {
          revalidate: async (current, _operation) => {
            revalidationCalls += 1;
            if (revalidationCalls === 3) {
              postSpawnEntered.resolve();
              await releasePostSpawn.promise;
            }
            return current;
          },
        },
        aliases,
        tools,
        spawner,
        inheritedEnvironment: {},
      });
      const opening = launcher.openLogin(loginRequest());
      await postSpawnEntered.promise;

      const stopping =
        action === 'cancel' ? launcher.cancel('codex_cli') : launcher.shutdown(shutdownSignal());
      releasePostSpawn.resolve();

      await expect(opening).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      await expect(stopping).resolves.toBeUndefined();
      expect(spawner.calls).toHaveLength(1);
      expect(aliases.releases).toBe(1);
    },
  );

  it('serializes concurrent cancel and shutdown behind the same lease release', async () => {
    const aliases = new Aliases();
    const tools = new ToolGuard();
    const spawner = new Spawner();
    const releaseEntered = deferred();
    const releaseLease = deferred();
    const originalAcquire = aliases.acquire.bind(aliases);
    aliases.acquire = async (current, operation) => {
      const lease = await originalAcquire(current, operation);
      return Object.freeze({
        ...lease,
        release: async () => {
          aliases.releases += 1;
          releaseEntered.resolve();
          await releaseLease.promise;
        },
      });
    };
    const launcher = createWindowsTerminalLoginLauncherForTest({
      inspector: { revalidate: async (current, _operation) => current },
      aliases,
      tools,
      spawner,
      inheritedEnvironment: {},
    });
    await launcher.openLogin(loginRequest());

    const cancelling = launcher.cancel('codex_cli');
    await releaseEntered.promise;
    let shutdownSettled = false;
    const shuttingDown = launcher.shutdown(shutdownSignal()).then(() => {
      shutdownSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(shutdownSettled).toBe(false);
    releaseLease.resolve();
    await Promise.all([cancelling, shuttingDown]);
    expect(aliases.releases).toBe(1);
  });

  it('closes synchronously with an already-aborted shutdown deadline and observes late cleanup failure', async () => {
    const aliases = new Aliases();
    const tools = new ToolGuard();
    const spawner = new Spawner();
    const releaseEntered = deferred();
    const releaseLease = deferred();
    const originalAcquire = aliases.acquire.bind(aliases);
    aliases.acquire = async (current, operation) => {
      const lease = await originalAcquire(current, operation);
      return Object.freeze({
        ...lease,
        release: async () => {
          aliases.releases += 1;
          releaseEntered.resolve();
          await releaseLease.promise;
          throw new Error('late cleanup failure');
        },
      });
    };
    const launcher = createWindowsTerminalLoginLauncherForTest({
      inspector: { revalidate: async (current, _operation) => current },
      aliases,
      tools,
      spawner,
      inheritedEnvironment: {},
    });
    await launcher.openLogin(loginRequest());
    const completedInspections = aliases.acquisitions;
    const unhandledReasons: unknown[] = [];
    const captureUnhandled = (reason: unknown): void => {
      unhandledReasons.push(reason);
    };
    process.on('unhandledRejection', captureUnhandled);
    try {
      const deadline = new AbortController();
      deadline.abort();
      const shuttingDown = launcher.shutdown(deadline.signal);
      const rejectedAfterClosure = launcher.openLogin(loginRequest());

      await releaseEntered.promise;
      await expect(shuttingDown).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      await expect(rejectedAfterClosure).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(aliases.acquisitions).toBe(completedInspections);

      releaseLease.resolve();
      await nextTurn();
      await nextTurn();

      expect(unhandledReasons).toEqual([]);
      await expect(launcher.releaseAfterInspection('codex_cli')).resolves.toBeUndefined();
      expect(aliases.releases).toBe(1);
    } finally {
      process.off('unhandledRejection', captureUnhandled);
    }
  });

  it('returns when a later shutdown deadline aborts and releases a lease acquired afterward', async () => {
    const aliases = new Aliases();
    const tools = new ToolGuard();
    const spawner = new Spawner();
    const acquireEntered = deferred();
    const releaseAcquire = deferred();
    const caller = new AbortController();
    let lateOperation: ProviderConnectionOperation | undefined;
    const originalAcquire = aliases.acquire.bind(aliases);
    aliases.acquire = async (current, operation) => {
      lateOperation = operation;
      acquireEntered.resolve();
      await releaseAcquire.promise;
      return originalAcquire(current, operation);
    };
    const launcher = createWindowsTerminalLoginLauncherForTest({
      inspector: { revalidate: async (current, _operation) => current },
      aliases,
      tools,
      spawner,
      inheritedEnvironment: {},
    });
    const opening = launcher.openLogin(
      loginRequest({
        ...connectionOperation(caller, TEST_REQUEST_ID),
      }),
    );
    const openingFailure = opening.catch((error: unknown) => error);
    await acquireEntered.promise;

    const deadline = new AbortController();
    const shuttingDown = launcher.shutdown(deadline.signal);
    await nextTurn();
    deadline.abort();

    await expect(shuttingDown).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(caller.signal.aborted).toBe(false);
    expect(aliases.acquireOperations).toHaveLength(0);
    expect(lateOperation?.requestId).toBe(TEST_REQUEST_ID);
    expect(lateOperation?.signal).not.toBe(caller.signal);
    expect(lateOperation?.signal.aborted).toBe(true);

    releaseAcquire.resolve();
    expect(await openingFailure).toMatchObject({ code: 'PROVIDER_CANCELLED' });
    await nextTurn();

    expect(spawner.calls).toHaveLength(0);
    expect(aliases.releases).toBe(1);
    await expect(launcher.releaseAfterInspection('codex_cli')).resolves.toBeUndefined();
    expect(aliases.releases).toBe(1);
  });

  it('opens profile-scoped Codex logout and blocks provider-global logout', async () => {
    const setup = harness();

    expect(PROFILE_SCOPED_LOGOUT_ARGV).toEqual({
      codex_cli: ['logout', ...LOGIN_ARGV.codex_cli.slice(2)],
    });
    await setup.launcher.openLogout(logoutRequest());
    expect(setup.spawner.calls[0]?.args).toEqual([
      'new-tab',
      '--title',
      'Codex CLI 로그아웃',
      '--',
      'S:\\codex.exe',
      ...PROFILE_SCOPED_LOGOUT_ARGV.codex_cli,
    ]);
    await expect(
      setup.launcher.openLogout(
        logoutRequest({
          binding: Object.freeze({
            ...binding,
            providerId: 'antigravity_cli',
            recipeId: 'antigravity-1.1-stream-json-v1',
            credentialScope: 'provider_global',
            signerClassification: 'google',
          }) as CliRuntimeBinding<'antigravity_cli', 'provider_global'>,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED',
    });
    expect(setup.spawner.calls).toHaveLength(1);
  });

  it('returns terminal-unavailable guidance without falling back to another shell', async () => {
    const setup = harness();
    setup.tools.missing = true;

    await expect(setup.launcher.openLogin(loginRequest())).rejects.toMatchObject({
      code: 'PROVIDER_LOGIN_TERMINAL_UNAVAILABLE',
    });
    expect(setup.spawner.calls).toHaveLength(0);
    expect(setup.aliases.releases).toBe(1);
  });

  it('preserves a verified OS-tool identity drift as unsafe instead of misreporting absence', async () => {
    const setup = harness();
    setup.tools.drift = true;

    await expect(setup.launcher.openLogin(loginRequest())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
    expect(setup.spawner.calls).toHaveLength(0);
    expect(setup.aliases.releases).toBe(1);
  });

  it('releases the held provider lease after successful inspection, cancel, or shutdown', async () => {
    const setup = harness();
    const open = () => setup.launcher.openLogin(loginRequest());

    await open();
    await setup.launcher.releaseAfterInspection('codex_cli');
    await open();
    await setup.launcher.cancel('codex_cli');
    await open();
    await setup.launcher.shutdown(shutdownSignal());

    expect(setup.aliases.releases).toBe(3);
  });

  it('retains the lease for an already launched session when post-launch binding validation drifts', async () => {
    const aliases = new Aliases();
    const tools = new ToolGuard();
    const spawner = new Spawner();
    let calls = 0;
    const launcher = createWindowsTerminalLoginLauncherForTest({
      inspector: {
        revalidate: async (current, _operation) => {
          calls += 1;
          if (calls === 3) throw new Error('drift');
          return current;
        },
      },
      aliases,
      tools,
      spawner,
      inheritedEnvironment: {},
    });

    await expect(launcher.openLogin(loginRequest())).rejects.toMatchObject({
      code: 'PROVIDER_CLI_CHANGED',
    });
    expect(aliases.releases).toBe(0);
    await launcher.cancel('codex_cli');
    expect(aliases.releases).toBe(1);
  });

  it('retains the lease when the terminal starts but its post-launch tool identity drifts', async () => {
    const setup = harness();
    setup.tools.driftAfterLaunch = true;

    await expect(setup.launcher.openLogin(loginRequest())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
    expect(setup.spawner.calls).toHaveLength(1);
    expect(setup.aliases.releases).toBe(0);
    await setup.launcher.shutdown(shutdownSignal());
    expect(setup.aliases.releases).toBe(1);
  });
});
