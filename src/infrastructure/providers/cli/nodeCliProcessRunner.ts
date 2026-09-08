import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../core/ports/aiProvider';
import type {
  CliProcessRequest,
  CliProcessResult,
  CliProcessRunner,
} from '../../../core/ports/cliProcessRunner';
import type { CliProviderId } from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';
import type { CliChildProcess, CliSpawnFacade } from './boundedNodeProcessRunner';
import { MAX_CLI_STDIN_BYTES } from './boundedNodeProcessRunner';
import { runCliCleanupWithinDeadline, sameWindowsPath } from './cliFileIntegrity';
import type { CliPrivateDirectoryManager } from './cliPrivateDirectories';
import { selectCliProviderFailure } from './cliProviderFailurePrecedence';
import type {
  CliProcessIdentity,
  CliProcessIdentityProvider,
  CliProcessTreeTerminator,
} from './windowsCliProcessControl';
import { WINDOWS_TASKKILL_PATH } from './windowsCliProcessControl';
import { WINDOWS_POWERSHELL_PATH } from './windowsPowerShell';
import type {
  CliBindingRevalidator,
  WindowsToolIdentityGuard,
  WindowsWorkspaceAlias,
  WindowsWorkspaceAliasLease,
} from './windowsWorkspaceAlias';
import { sameCliRuntimeBindingIdentity } from './windowsWorkspaceAlias';

export type {
  CliChildProcess,
  CliReadableStream,
  CliSpawnFacade,
  CliSpawnOptions,
  CliWritableStream,
} from './boundedNodeProcessRunner';
export {
  createNodeSpawnFacade,
  MAX_CLI_STDIN_BYTES,
} from './boundedNodeProcessRunner';
export type {
  CliPrivateDirectoryManager,
  CliPrivateDirectoryOperations,
  WindowsPrivateDirectoryAcl,
} from './cliPrivateDirectories';
export {
  createCliPrivateDirectoryManager,
  createCliPrivateDirectoryManagerForTest,
  createNodePrivateDirectoryOperations,
  createWindowsPrivateDirectoryAcl,
  createWindowsPrivateDirectoryAclForTest,
  PRIVATE_DIRECTORY_TARGET_ENVIRONMENT_KEY,
  WINDOWS_PRIVATE_DIRECTORY_ACL_ENCODED_COMMAND,
} from './cliPrivateDirectories';
export type {
  CliProcessIdentity,
  CliProcessIdentityProvider,
  CliProcessTreeTerminator,
} from './windowsCliProcessControl';
export {
  createWindowsProcessIdentityProvider,
  createWindowsProcessIdentityProviderForTest,
  createWindowsProcessTreeTerminator,
  createWindowsProcessTreeTerminatorForTest,
  PROCESS_IDENTITY_PID_ENVIRONMENT_KEY,
  WINDOWS_PROCESS_IDENTITY_ENCODED_COMMAND,
  WINDOWS_TASKKILL_PATH,
} from './windowsCliProcessControl';

const FIXED_SYSTEM_ENVIRONMENT = Object.freeze({
  SystemRoot: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  PATH: 'C:\\Windows\\System32',
  NO_COLOR: '1',
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_POST_PROCESS_VALIDATION_MS = 1_000 as const;
const CLEANUP_TIMEOUT_MS = 15_000 as const;
const providerError = (
  code:
    | 'PROVIDER_CANCELLED'
    | 'PROVIDER_CLI_CHANGED'
    | 'PROVIDER_EXECUTION_FAILED'
    | 'PROVIDER_REQUEST_TOO_LARGE'
    | 'PROVIDER_RESIDUAL_DATA'
    | 'PROVIDER_RESPONSE_TOO_LARGE'
    | 'PROVIDER_TIMEOUT'
    | 'PROVIDER_UNSAFE_VERSION',
): AppError => new AppError(code, APP_ERROR_MESSAGES[code]);
class UnresolvedLiveProcessError extends Error {
  constructor() {
    super('UNRESOLVED_LIVE_PROCESS');
  }
}

const createOperation = (requestId: string, signal: AbortSignal): ProviderConnectionOperation =>
  Object.freeze({ requestId, signal });

const createCleanupOperation = (): ProviderConnectionOperation =>
  createOperation(randomUUID(), AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
type NodeCliProcessRunnerOptions = Readonly<{
  binding: CliRuntimeBinding;
  inspector: CliBindingRevalidator;
  aliases: WindowsWorkspaceAlias;
  directories: CliPrivateDirectoryManager;
  spawner: CliSpawnFacade;
  identities: CliProcessIdentityProvider;
  terminator: CliProcessTreeTerminator;
  tools: WindowsToolIdentityGuard;
}>;

const sameIdentity = (left: CliProcessIdentity, right: CliProcessIdentity): boolean =>
  left.pid === right.pid &&
  left.creationTime === right.creationTime &&
  sameWindowsPath(left.canonicalImagePath, right.canonicalImagePath);

const safeLocale = (value: string | undefined): string | null =>
  value !== undefined && /^[A-Za-z]{2,3}(?:_[A-Za-z]{2})?(?:\.[A-Za-z0-9-]{1,24})?$/u.test(value)
    ? value
    : null;

export const buildCliEnvironment = (
  providerId: CliProviderId,
  lease: WindowsWorkspaceAliasLease,
  inherited: Readonly<Record<string, string | undefined>>,
  requestId: string | null = null,
): Readonly<Record<string, string>> => {
  const userProfile = `${lease.profileRoot}\\user`;
  const tempRoot = requestId === null ? lease.tempRoot : `${lease.tempRoot}\\${requestId}`;
  const environment: Record<string, string> = {
    ...FIXED_SYSTEM_ENVIRONMENT,
    USERPROFILE: userProfile,
    APPDATA: `${userProfile}\\AppData\\Roaming`,
    LOCALAPPDATA: `${userProfile}\\AppData\\Local`,
    TEMP: tempRoot,
    TMP: tempRoot,
  };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE'] as const) {
    const locale = safeLocale(inherited[key]);
    if (locale !== null) environment[key] = locale;
  }
  if (providerId === 'gemini_cli') {
    environment.GEMINI_CLI_HOME = `${lease.profileRoot}\\settings`;
    environment.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE = 'true';
    environment.GEMINI_FORCE_FILE_STORAGE = 'false';
    environment.NO_BROWSER = 'true';
  }
  if (providerId === 'codex_cli') environment.CODEX_HOME = `${lease.profileRoot}\\settings`;
  return Object.freeze(environment);
};

type ProcessOutcome =
  | Readonly<{ kind: 'close'; exitCode: number }>
  | Readonly<{
      kind: 'failure';
      terminate: boolean;
      code:
        | 'PROVIDER_CANCELLED'
        | 'PROVIDER_EXECUTION_FAILED'
        | 'PROVIDER_RESPONSE_TOO_LARGE'
        | 'PROVIDER_TIMEOUT';
    }>;

class ProviderBoundNodeCliProcessRunner implements CliProcessRunner {
  readonly #options: NodeCliProcessRunnerOptions;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: NodeCliProcessRunnerOptions) {
    this.#options = options;
  }

  cancel(requestId: string): void {
    this.#controllers.get(requestId)?.abort();
  }

  async run(request: CliProcessRequest): Promise<CliProcessResult> {
    if (Buffer.byteLength(request.stdin, 'utf8') > MAX_CLI_STDIN_BYTES) {
      throw providerError('PROVIDER_REQUEST_TOO_LARGE');
    }
    this.#validateRequest(request);
    const requestStartedAt = performance.now();
    if (this.#controllers.has(request.requestId)) throw providerError('PROVIDER_EXECUTION_FAILED');
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    request.signal.addEventListener('abort', forwardAbort, { once: true });
    if (request.signal.aborted) controller.abort();
    this.#controllers.set(request.requestId, controller);
    const operation = createOperation(request.requestId, controller.signal);
    let lease: WindowsWorkspaceAliasLease | null = null;
    let failure: unknown;
    let result: CliProcessResult | null = null;
    let unresolvedLiveProcess = false;
    let preparationStarted = false;
    try {
      if (controller.signal.aborted) throw providerError('PROVIDER_CANCELLED');
      preparationStarted = true;
      await this.#options.directories.prepareRequest(
        this.#options.binding.providerId,
        request.requestId,
        request.cwd,
        operation,
      );
      if (controller.signal.aborted) throw providerError('PROVIDER_CANCELLED');
      await this.#revalidate(operation);
      if (controller.signal.aborted) throw providerError('PROVIDER_CANCELLED');
      await this.#verifyProcessTools(operation);
      if (controller.signal.aborted) throw providerError('PROVIDER_CANCELLED');
      lease = await this.#options.aliases.acquire(this.#options.binding, operation);
      if (controller.signal.aborted) throw providerError('PROVIDER_CANCELLED');
      result = await this.#runChild(request, lease, operation);
    } catch (error) {
      unresolvedLiveProcess = error instanceof UnresolvedLiveProcessError;
      failure = unresolvedLiveProcess ? providerError('PROVIDER_RESIDUAL_DATA') : error;
    }

    let aliasInvalid = false;
    const cleanupOperation = createCleanupOperation();
    if (
      lease !== null &&
      result !== null &&
      failure === undefined &&
      !unresolvedLiveProcess &&
      request.postProcessValidation !== undefined
    ) {
      try {
        await lease.revalidate(operation);
        await this.#runPostProcessValidation(
          request.postProcessValidation,
          operation.signal,
          request.timeoutMs - (performance.now() - requestStartedAt),
        );
        await lease.revalidate(operation);
      } catch (error) {
        const normalized = AppError.isTrusted(error)
          ? error
          : providerError('PROVIDER_EXECUTION_FAILED');
        failure = selectCliProviderFailure(failure, normalized);
        result = null;
      }
    }
    if (lease !== null && !unresolvedLiveProcess) {
      try {
        await lease.revalidate(cleanupOperation);
      } catch {
        aliasInvalid = true;
        failure = selectCliProviderFailure(failure, providerError('PROVIDER_RESIDUAL_DATA'));
        result = null;
      }
    }
    if (preparationStarted && !unresolvedLiveProcess) {
      try {
        if (request.requestCleanup !== undefined) {
          const cleanup = request.requestCleanup;
          await runCliCleanupWithinDeadline(cleanupOperation, () =>
            cleanup(cleanupOperation.signal),
          );
        } else {
          await this.#options.directories.cleanupRequest(request.requestId, request.cwd);
        }
      } catch {
        failure = selectCliProviderFailure(failure, providerError('PROVIDER_RESIDUAL_DATA'));
        result = null;
      }
    }
    try {
      await this.#revalidate(cleanupOperation);
    } catch {
      if (!unresolvedLiveProcess) {
        failure = selectCliProviderFailure(failure, providerError('PROVIDER_CLI_CHANGED'));
      }
      result = null;
    }
    try {
      await this.#verifyProcessTools(cleanupOperation);
    } catch {
      if (!unresolvedLiveProcess) {
        failure = selectCliProviderFailure(failure, providerError('PROVIDER_UNSAFE_VERSION'));
      }
      result = null;
    }
    if (lease !== null && !unresolvedLiveProcess && !aliasInvalid) {
      try {
        await lease.release();
      } catch {
        failure = selectCliProviderFailure(failure, providerError('PROVIDER_RESIDUAL_DATA'));
        result = null;
      }
    }
    request.signal.removeEventListener('abort', forwardAbort);
    this.#controllers.delete(request.requestId);
    if (failure !== undefined) {
      if (AppError.isTrusted(failure)) throw failure;
      throw providerError('PROVIDER_EXECUTION_FAILED');
    }
    if (result === null) throw providerError('PROVIDER_EXECUTION_FAILED');
    return result;
  }

  async #revalidate(operation: ProviderConnectionOperation): Promise<void> {
    try {
      const current = await this.#options.inspector.revalidate(this.#options.binding, operation);
      if (!sameCliRuntimeBindingIdentity(current, this.#options.binding)) {
        throw new Error('binding mismatch');
      }
    } catch (error) {
      if (
        operation.signal.aborted ||
        (AppError.isTrusted(error) && error.code === 'PROVIDER_CANCELLED')
      ) {
        throw providerError('PROVIDER_CANCELLED');
      }
      throw providerError('PROVIDER_CLI_CHANGED');
    }
  }

  async #verifyProcessTools(operation: ProviderConnectionOperation): Promise<void> {
    for (const path of [WINDOWS_POWERSHELL_PATH, WINDOWS_TASKKILL_PATH] as const) {
      await this.#options.tools.runVerified(path, operation, async () => undefined);
    }
  }

  async #runPostProcessValidation(
    validation: (signal: AbortSignal) => void | Promise<void>,
    outerSignal: AbortSignal,
    remainingRequestMs: number,
  ): Promise<void> {
    if (outerSignal.aborted) throw providerError('PROVIDER_CANCELLED');
    const remainingWholeMs = Math.floor(remainingRequestMs);
    if (remainingWholeMs < 1) throw providerError('PROVIDER_TIMEOUT');
    const controller = new AbortController();
    let boundaryCode: 'PROVIDER_CANCELLED' | 'PROVIDER_TIMEOUT' | null = null;
    let resolveBoundary!: () => void;
    const boundary = new Promise<void>((resolve) => {
      resolveBoundary = resolve;
    });
    const stop = (code: 'PROVIDER_CANCELLED' | 'PROVIDER_TIMEOUT'): void => {
      if (boundaryCode !== null) return;
      boundaryCode = code;
      resolveBoundary();
      controller.abort();
    };
    const cancel = () => stop('PROVIDER_CANCELLED');
    outerSignal.addEventListener('abort', cancel, { once: true });
    if (outerSignal.aborted) cancel();
    const validationLimitMs = Math.min(MAX_POST_PROCESS_VALIDATION_MS, remainingWholeMs);
    const timer = setTimeout(() => stop('PROVIDER_TIMEOUT'), validationLimitMs);
    const validationOutcome = Promise.resolve()
      .then(() => validation(controller.signal))
      .then(
        () => Object.freeze({ kind: 'success' as const }),
        (error: unknown) => Object.freeze({ kind: 'failure' as const, error }),
      );
    const boundaryOutcome = boundary.then(() => Object.freeze({ kind: 'boundary' as const }));
    const outcome = await Promise.race([validationOutcome, boundaryOutcome]);
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', cancel);
    if (boundaryCode !== null) throw providerError(boundaryCode);
    if (outcome.kind === 'failure') throw outcome.error;
  }

  #validateRequest(request: CliProcessRequest): void {
    if (
      !UUID_PATTERN.test(request.requestId) ||
      request.launcherPath !== this.#options.binding.canonicalLauncherPath ||
      request.args.length < this.#options.binding.fixedPrefixArgs.length ||
      (request.postProcessValidation !== undefined &&
        typeof request.postProcessValidation !== 'function') ||
      (request.requestCleanup !== undefined && typeof request.requestCleanup !== 'function') ||
      !this.#options.binding.fixedPrefixArgs.every(
        (argument, index) => request.args[index] === argument,
      ) ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs <= 0 ||
      request.timeoutMs > 900_000 ||
      !Number.isSafeInteger(request.stdoutLimitBytes) ||
      request.stdoutLimitBytes <= 0 ||
      request.stdoutLimitBytes > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(request.stderrLimitBytes) ||
      request.stderrLimitBytes <= 0 ||
      request.stderrLimitBytes > 8 * 1024 * 1024 ||
      !(request.signal instanceof AbortSignal)
    ) {
      throw providerError('PROVIDER_EXECUTION_FAILED');
    }
  }

  async #runChild(
    request: CliProcessRequest,
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<CliProcessResult> {
    const signal = operation.signal;
    if (signal.aborted) throw providerError('PROVIDER_CANCELLED');
    await lease.revalidate(operation);
    await this.#revalidate(operation);
    await this.#verifyProcessTools(operation);
    if (signal.aborted) throw providerError('PROVIDER_CANCELLED');
    const operationArgs = request.args.slice(this.#options.binding.fixedPrefixArgs.length);
    const args = Object.freeze([
      ...lease.fixedPrefixArgs,
      ...operationArgs.map((argument) => lease.rewritePath(argument)),
    ]);
    const cwd = lease.rewritePath(request.cwd);
    const env = buildCliEnvironment(
      this.#options.binding.providerId,
      lease,
      request.env,
      request.requestId,
    );
    const generated = [lease.launcherPath, ...args, cwd, ...Object.values(env)];
    for (const value of generated) lease.assertNoCanonicalPathDisclosure(value);

    let child: CliChildProcess;
    try {
      child = this.#options.spawner.spawn(lease.launcherPath, args, {
        shell: false,
        windowsHide: true,
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw providerError('PROVIDER_EXECUTION_FAILED');
    }
    const pid = child.pid;
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new UnresolvedLiveProcessError();
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outcomeSettled = false;
    let stdinFinished = request.stdin.length === 0;
    let pendingClose: number | null = null;
    let resolveOutcome!: (outcome: ProcessOutcome) => void;
    const outcome = new Promise<ProcessOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const settle = (value: ProcessOutcome): void => {
      if (outcomeSettled) return;
      outcomeSettled = true;
      resolveOutcome(value);
    };
    child.stdout.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > request.stdoutLimitBytes) {
        settle({ kind: 'failure', code: 'PROVIDER_RESPONSE_TOO_LARGE', terminate: true });
        return;
      }
      stdout.push(bytes);
    });
    child.stderr.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes > request.stderrLimitBytes) {
        settle({ kind: 'failure', code: 'PROVIDER_RESPONSE_TOO_LARGE', terminate: true });
        return;
      }
      stderr.push(bytes);
    });
    child.once('error', () =>
      settle({ kind: 'failure', code: 'PROVIDER_EXECUTION_FAILED', terminate: true }),
    );
    child.stdin.once?.('error', () => {
      if (request.stdin.length > 0) {
        settle({
          kind: 'failure',
          code: 'PROVIDER_EXECUTION_FAILED',
          terminate: child.exitCode === null,
        });
      }
    });
    child.stdin.once?.('finish', () => {
      stdinFinished = true;
      if (pendingClose !== null) settle({ kind: 'close', exitCode: pendingClose });
    });
    child.once('close', (exitCode) => {
      const normalizedExitCode = exitCode ?? 1;
      if (stdinFinished) settle({ kind: 'close', exitCode: normalizedExitCode });
      else pendingClose = normalizedExitCode;
    });
    const timer = setTimeout(
      () => settle({ kind: 'failure', code: 'PROVIDER_TIMEOUT', terminate: true }),
      request.timeoutMs,
    );
    const abort = () => settle({ kind: 'failure', code: 'PROVIDER_CANCELLED', terminate: true });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();

    let initialIdentity: CliProcessIdentity;
    try {
      initialIdentity = await this.#options.identities.capture(pid, operation);
    } catch {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (child.exitCode === null) throw new UnresolvedLiveProcessError();
      throw providerError('PROVIDER_RESIDUAL_DATA');
    }
    if (
      initialIdentity.pid !== pid ||
      (!sameWindowsPath(initialIdentity.canonicalImagePath, lease.launcherPath) &&
        !sameWindowsPath(
          initialIdentity.canonicalImagePath,
          this.#options.binding.canonicalLauncherPath,
        ))
    ) {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (child.exitCode === null) throw new UnresolvedLiveProcessError();
      throw providerError('PROVIDER_RESIDUAL_DATA');
    }
    if (!outcomeSettled) {
      if (child.exitCode === null) {
        if (request.stdin.length > 0 && child.stdin.once === undefined) {
          settle({ kind: 'failure', code: 'PROVIDER_EXECUTION_FAILED', terminate: true });
        } else {
          try {
            child.stdin.end(Buffer.from(request.stdin, 'utf8'));
          } catch {
            settle({ kind: 'failure', code: 'PROVIDER_EXECUTION_FAILED', terminate: true });
          }
        }
      } else if (request.stdin.length > 0) {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        throw providerError('PROVIDER_EXECUTION_FAILED');
      }
    }

    const completed = await outcome;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (completed.kind === 'failure') {
      if (!completed.terminate) throw providerError(completed.code);
      if (child.exitCode !== null) throw providerError('PROVIDER_RESIDUAL_DATA');
      let currentIdentity: CliProcessIdentity;
      const cleanupOperation = createCleanupOperation();
      try {
        currentIdentity = await this.#options.identities.capture(pid, cleanupOperation);
      } catch {
        if (child.exitCode === null) throw new UnresolvedLiveProcessError();
        throw providerError('PROVIDER_RESIDUAL_DATA');
      }
      if (!sameIdentity(initialIdentity, currentIdentity)) {
        if (child.exitCode === null) throw new UnresolvedLiveProcessError();
        throw providerError('PROVIDER_RESIDUAL_DATA');
      }
      try {
        await this.#options.terminator.terminate(initialIdentity);
      } catch {
        if (child.exitCode === null) throw new UnresolvedLiveProcessError();
        throw providerError('PROVIDER_RESIDUAL_DATA');
      }
      throw providerError(completed.code);
    }
    return Object.freeze({
      exitCode: completed.exitCode,
      stdout: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(stdout)),
      stderr: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(stderr)),
    });
  }
}

export const createNodeCliProcessRunnerForTest = (
  options: NodeCliProcessRunnerOptions,
): CliProcessRunner => new ProviderBoundNodeCliProcessRunner(options);

export const createNodeCliProcessRunner = createNodeCliProcessRunnerForTest;
