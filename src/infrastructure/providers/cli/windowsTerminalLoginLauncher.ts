import { spawn as nodeSpawn } from 'node:child_process';
import {
  type CliRuntimeBinding,
  createProviderConnectionOperation,
  type ProviderConnectionOperation,
} from '../../../core/ports/aiProvider';
import type {
  CliLoginLauncher,
  OpenCliLoginRequest,
  OpenCliLogoutRequest,
} from '../../../core/ports/cliLoginLauncher';
import {
  type CliProviderId,
  TRUSTED_CLI_BINDING_RECIPES,
} from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';
import { CLI_CREDENTIAL_SCOPE_BY_RECIPE } from './cliCredentialGuard';
import { CODEX_CONFIG_OVERRIDES, CODEX_DISABLE_ARGS } from './codexCliProtocol';
import { buildCliEnvironment } from './nodeCliProcessRunner';
import type {
  CliBindingRevalidator,
  WindowsToolIdentityGuard,
  WindowsWorkspaceAlias,
  WindowsWorkspaceAliasLease,
} from './windowsWorkspaceAlias';
import { sameCliRuntimeBindingIdentity } from './windowsWorkspaceAlias';

export const WINDOWS_TERMINAL_PATH = 'C:\\Windows\\System32\\wt.exe' as const;
const WINDOWS_SYSTEM32_PATH = 'C:\\Windows\\System32' as const;

export const LOGIN_ARGV = Object.freeze({
  antigravity_cli: Object.freeze([] as const),
  gemini_cli: Object.freeze([] as const),
  codex_cli: Object.freeze([
    'login',
    '--device-auth',
    ...CODEX_CONFIG_OVERRIDES.flatMap((value) => ['-c', value]),
    ...CODEX_DISABLE_ARGS,
  ] as const),
});

export const PROFILE_SCOPED_LOGOUT_ARGV = Object.freeze({
  codex_cli: Object.freeze([
    'logout',
    ...CODEX_CONFIG_OVERRIDES.flatMap((value) => ['-c', value]),
    ...CODEX_DISABLE_ARGS,
  ] as const),
} as const);

const LOGIN_TITLES = Object.freeze({
  antigravity_cli: 'Antigravity CLI 로그인',
  gemini_cli: 'Gemini CLI 로그인',
  codex_cli: 'Codex CLI 로그인',
} as const);

const LOGOUT_TITLES = Object.freeze({
  codex_cli: 'Codex CLI 로그아웃',
} as const);

const providerError = (
  code:
    | 'PROVIDER_CANCELLED'
    | 'PROVIDER_CLI_CHANGED'
    | 'PROVIDER_LOGIN_TERMINAL_UNAVAILABLE'
    | 'PROVIDER_RESIDUAL_DATA'
    | 'PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED'
    | 'PROVIDER_UNSAFE_VERSION',
): AppError => new AppError(code, APP_ERROR_MESSAGES[code]);

export type VisibleProcessOptions = Readonly<{
  shell: false;
  windowsHide: false;
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
}>;

export interface VisibleProcessSpawner {
  spawn(file: string, args: readonly string[], options: VisibleProcessOptions): Promise<void>;
}

export const createVisibleProcessSpawner = (): VisibleProcessSpawner =>
  Object.freeze({
    spawn: (file: string, args: readonly string[], options: VisibleProcessOptions) =>
      new Promise<void>((resolve, reject) => {
        if (options.signal.aborted) {
          reject(new Error('VISIBLE_PROCESS_CANCELLED'));
          return;
        }
        const child = nodeSpawn(file, [...args], {
          shell: false,
          windowsHide: false,
          cwd: options.cwd,
          env: { ...options.env },
          stdio: 'ignore',
          signal: options.signal,
        });
        child.once('spawn', resolve);
        child.once('error', reject);
      }),
  });

type WindowsTerminalLoginLauncherDependencies = Readonly<{
  inspector: CliBindingRevalidator;
  aliases: WindowsWorkspaceAlias;
  tools: WindowsToolIdentityGuard;
  spawner: VisibleProcessSpawner;
  inheritedEnvironment: Readonly<Record<string, string | undefined>>;
}>;

type WindowsTerminalLoginLauncherOptions = WindowsTerminalLoginLauncherDependencies &
  Readonly<{ terminalCwd: string }>;

type WindowsTerminalLoginLauncherTestOptions = WindowsTerminalLoginLauncherDependencies &
  Readonly<{ terminalCwd?: string }>;

type PendingLogin = {
  readonly controller: AbortController;
  readonly connection: ProviderConnectionOperation;
  lease: WindowsWorkspaceAliasLease | null;
  launched: boolean;
  completion: Promise<void> | null;
};

class FixedWindowsTerminalLoginLauncher implements CliLoginLauncher {
  readonly #options: WindowsTerminalLoginLauncherOptions;
  readonly #heldLeases = new Map<CliProviderId, WindowsWorkspaceAliasLease>();
  readonly #pendingLogins = new Map<CliProviderId, PendingLogin>();
  readonly #releasePromises = new Map<CliProviderId, Promise<void>>();
  #shuttingDown = false;

  constructor(options: WindowsTerminalLoginLauncherOptions) {
    this.#options = options;
  }

  async openLogin(request: OpenCliLoginRequest): Promise<void> {
    const caller = this.#readOperation(request.requestId, request.signal);
    this.#assertCallerActive(caller);
    const scope = this.#assertCurrentRecipe(request.binding);
    if (scope === 'provider_global') {
      if (request.credentialPresent) {
        throw providerError('PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED');
      }
      if (request.binding.providerId === 'gemini_cli') {
        throw providerError('PROVIDER_UNSAFE_VERSION');
      }
      if (request.confirmSharedCredentialMutation !== true) {
        throw providerError('PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED');
      }
    } else {
      if (request.binding.providerId !== 'codex_cli') {
        throw providerError('PROVIDER_UNSAFE_VERSION');
      }
      if (request.credentialPresent) {
        throw providerError('PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED');
      }
    }
    if (
      this.#shuttingDown ||
      this.#heldLeases.has(request.binding.providerId) ||
      this.#pendingLogins.has(request.binding.providerId)
    ) {
      throw providerError(
        this.#shuttingDown ? 'PROVIDER_CANCELLED' : 'PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED',
      );
    }
    const operation = this.#createPending(caller);
    this.#pendingLogins.set(request.binding.providerId, operation);
    operation.completion = this.#openVisibleCli(
      request.binding,
      LOGIN_ARGV[request.binding.providerId],
      LOGIN_TITLES[request.binding.providerId],
      operation,
    );
    try {
      await operation.completion;
    } finally {
      if (this.#pendingLogins.get(request.binding.providerId) === operation) {
        this.#pendingLogins.delete(request.binding.providerId);
      }
    }
  }

  async #openVisibleCli(
    binding: CliRuntimeBinding,
    operationArgs: readonly string[],
    title: string,
    operation: PendingLogin,
  ): Promise<void> {
    try {
      this.#assertActive(operation);
      await this.#revalidate(binding, operation.connection);
      this.#assertActive(operation);
      const lease = await this.#options.aliases.acquire(binding, operation.connection);
      operation.lease = lease;
      this.#assertActive(operation);
      await lease.revalidate(operation.connection);
      this.#assertActive(operation);
      await this.#revalidate(binding, operation.connection);
      this.#assertActive(operation);
      const args = Object.freeze([
        'new-tab',
        '--title',
        title,
        '--',
        lease.launcherPath,
        ...lease.fixedPrefixArgs,
        ...operationArgs,
      ]);
      const env = buildCliEnvironment(
        binding.providerId,
        lease,
        this.#options.inheritedEnvironment,
      );
      for (const value of [
        WINDOWS_TERMINAL_PATH,
        this.#options.terminalCwd,
        ...args,
        ...Object.values(env),
      ]) {
        lease.assertNoCanonicalPathDisclosure(value);
      }
      try {
        await this.#options.tools.runVerified(WINDOWS_TERMINAL_PATH, operation.connection, () =>
          this.#options.spawner
            .spawn(WINDOWS_TERMINAL_PATH, args, {
              shell: false,
              windowsHide: false,
              cwd: this.#options.terminalCwd,
              env,
              signal: operation.connection.signal,
            })
            .then(() => {
              operation.launched = true;
            }),
        );
      } catch (error) {
        if (operation.connection.signal.aborted) throw providerError('PROVIDER_CANCELLED');
        if (AppError.isTrusted(error) && error.code === 'PROVIDER_UNSAFE_VERSION') throw error;
        throw providerError('PROVIDER_LOGIN_TERMINAL_UNAVAILABLE');
      }
      this.#assertActive(operation);
      await lease.revalidate(operation.connection);
      this.#assertActive(operation);
      await this.#revalidate(binding, operation.connection);
      this.#assertActive(operation);
      this.#heldLeases.set(binding.providerId, lease);
      operation.lease = null;
    } catch (error) {
      if (
        operation.launched &&
        !operation.connection.signal.aborted &&
        !this.#shuttingDown &&
        operation.lease !== null
      ) {
        this.#heldLeases.set(binding.providerId, operation.lease);
        operation.lease = null;
        throw error;
      }
      try {
        await this.#releasePendingLease(operation);
      } catch {
        throw providerError('PROVIDER_RESIDUAL_DATA');
      }
      throw error;
    }
  }

  async openLogout(request: OpenCliLogoutRequest): Promise<void> {
    const caller = this.#readOperation(request.requestId, request.signal);
    this.#assertCallerActive(caller);
    const scope = this.#assertCurrentRecipe(request.binding);
    if (scope === 'provider_global') {
      throw providerError('PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED');
    }
    if (request.binding.providerId !== 'codex_cli') {
      throw providerError('PROVIDER_UNSAFE_VERSION');
    }
    if (
      this.#shuttingDown ||
      this.#heldLeases.has(request.binding.providerId) ||
      this.#pendingLogins.has(request.binding.providerId)
    ) {
      throw providerError(
        this.#shuttingDown ? 'PROVIDER_CANCELLED' : 'PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED',
      );
    }
    const operation = this.#createPending(caller);
    this.#pendingLogins.set(request.binding.providerId, operation);
    operation.completion = this.#openVisibleCli(
      request.binding,
      PROFILE_SCOPED_LOGOUT_ARGV.codex_cli,
      LOGOUT_TITLES.codex_cli,
      operation,
    );
    try {
      await operation.completion;
    } finally {
      if (this.#pendingLogins.get(request.binding.providerId) === operation) {
        this.#pendingLogins.delete(request.binding.providerId);
      }
    }
  }

  async releaseAfterInspection(providerId: CliProviderId): Promise<void> {
    await this.#release(providerId);
  }

  async cancel(providerId: CliProviderId): Promise<void> {
    const pending = this.#pendingLogins.get(providerId);
    if (pending !== undefined) {
      pending.controller.abort();
      try {
        await pending.completion;
      } catch (error) {
        if (AppError.isTrusted(error) && error.code === 'PROVIDER_RESIDUAL_DATA') throw error;
      }
    }
    await this.#release(providerId);
  }

  async shutdown(signal: AbortSignal): Promise<void> {
    this.#shuttingDown = true;
    const pending = Object.freeze([...this.#pendingLogins.values()]);
    for (const operation of pending) operation.controller.abort();
    const pendingCompletions = pending.map(
      (operation) => operation.completion ?? Promise.resolve(),
    );
    for (const completion of pendingCompletions) this.#observeLate(completion);
    const providers = Object.freeze(
      new Set([...this.#heldLeases.keys(), ...this.#releasePromises.keys()]),
    );
    const releases = [...providers].map((providerId) => this.#release(providerId));
    for (const release of releases) this.#observeLate(release);
    const settled = await this.#settleUntilAborted([...pendingCompletions, ...releases], signal);
    if (settled === null) throw providerError('PROVIDER_CANCELLED');
    const residualFailure = settled.some(
      (result) =>
        result.status === 'rejected' &&
        AppError.isTrusted(result.reason) &&
        result.reason.code === 'PROVIDER_RESIDUAL_DATA',
    );
    if (residualFailure) throw providerError('PROVIDER_RESIDUAL_DATA');
  }

  #assertCurrentRecipe(binding: CliRuntimeBinding): 'profile_scoped' | 'provider_global' {
    const scope =
      CLI_CREDENTIAL_SCOPE_BY_RECIPE[
        binding.recipeId as keyof typeof CLI_CREDENTIAL_SCOPE_BY_RECIPE
      ];
    if (
      scope === undefined ||
      binding.credentialScope !== scope ||
      TRUSTED_CLI_BINDING_RECIPES[binding.providerId].recipeId !== binding.recipeId
    ) {
      throw providerError('PROVIDER_UNSAFE_VERSION');
    }
    return scope;
  }

  async #revalidate(
    binding: CliRuntimeBinding,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    try {
      this.#assertCallerActive(operation);
      const current = await this.#options.inspector.revalidate(binding, operation);
      this.#assertCallerActive(operation);
      if (!sameCliRuntimeBindingIdentity(current, binding)) throw new Error('binding mismatch');
    } catch (error) {
      if (operation.signal.aborted) throw providerError('PROVIDER_CANCELLED');
      if (AppError.isTrusted(error) && error.code === 'PROVIDER_CANCELLED') throw error;
      throw providerError('PROVIDER_CLI_CHANGED');
    }
  }

  async #release(providerId: CliProviderId): Promise<void> {
    const existing = this.#releasePromises.get(providerId);
    if (existing !== undefined) {
      await existing;
      return;
    }
    const lease = this.#heldLeases.get(providerId);
    if (lease === undefined) return;
    this.#heldLeases.delete(providerId);
    const releasing = lease.release().catch(() => {
      throw providerError('PROVIDER_RESIDUAL_DATA');
    });
    this.#releasePromises.set(providerId, releasing);
    try {
      await releasing;
    } finally {
      if (this.#releasePromises.get(providerId) === releasing) {
        this.#releasePromises.delete(providerId);
      }
    }
  }

  #assertActive(operation: PendingLogin): void {
    if (this.#shuttingDown || operation.connection.signal.aborted) {
      throw providerError('PROVIDER_CANCELLED');
    }
  }

  #assertCallerActive(operation: ProviderConnectionOperation): void {
    if (operation.signal.aborted) throw providerError('PROVIDER_CANCELLED');
  }

  #createPending(caller: ProviderConnectionOperation): PendingLogin {
    const controller = new AbortController();
    return {
      controller,
      connection: createProviderConnectionOperation({
        requestId: caller.requestId,
        signal: AbortSignal.any([caller.signal, controller.signal]),
      }),
      lease: null,
      launched: false,
      completion: null,
    };
  }

  #readOperation(requestId: string, signal: AbortSignal): ProviderConnectionOperation {
    return createProviderConnectionOperation({ requestId, signal });
  }

  #observeLate(promise: Promise<unknown>): void {
    void promise.catch(() => undefined);
  }

  async #settleUntilAborted(
    promises: readonly Promise<unknown>[],
    signal: AbortSignal,
  ): Promise<readonly PromiseSettledResult<unknown>[] | null> {
    if (!(signal instanceof AbortSignal) || signal.aborted) return null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: readonly PromiseSettledResult<unknown>[] | null): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = (): void => finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
      void Promise.allSettled(promises).then(finish);
    });
  }

  async #releasePendingLease(operation: PendingLogin): Promise<void> {
    const lease = operation.lease;
    if (lease === null) return;
    operation.lease = null;
    await lease.release();
  }
}

export const createWindowsTerminalLoginLauncherForTest = (
  options: WindowsTerminalLoginLauncherTestOptions,
): CliLoginLauncher =>
  new FixedWindowsTerminalLoginLauncher({
    ...options,
    terminalCwd: options.terminalCwd ?? WINDOWS_SYSTEM32_PATH,
  });

export const createWindowsTerminalLoginLauncher = (
  options: WindowsTerminalLoginLauncherDependencies,
): CliLoginLauncher =>
  new FixedWindowsTerminalLoginLauncher({ ...options, terminalCwd: WINDOWS_SYSTEM32_PATH });
