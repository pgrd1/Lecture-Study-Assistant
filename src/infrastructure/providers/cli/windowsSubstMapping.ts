import { Buffer } from 'node:buffer';
import { win32 } from 'node:path';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import type { CliProcessRunner } from '../../../core/ports/cliProcessRunner';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';
import {
  assertProviderConnectionActive,
  type CliExecutableFileAccess,
  type CliFileHasher,
  hashSecureFile,
  isCanonicalAbsoluteWindowsPath,
  isMissingPathError,
  SHA_256_PATTERN,
  sameWindowsPath,
  secureExactPath,
  unsafeVersion,
} from './cliFileIntegrity';
import { WINDOWS_POWERSHELL_PATH } from './windowsPowerShell';

export const WINDOWS_ALIAS_DRIVES = Object.freeze(['R:', 'S:', 'T:', 'U:', 'V:', 'W:'] as const);
export const WINDOWS_SUBST_PATH = 'C:\\Windows\\System32\\subst.exe' as const;

const WINDOWS_TASKKILL_PATH = 'C:\\Windows\\System32\\taskkill.exe';
const WINDOWS_TERMINAL_PATH = 'C:\\Windows\\System32\\wt.exe';
const FIXED_SYSTEM_ENVIRONMENT = Object.freeze({
  SystemRoot: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  PATH: 'C:\\Windows\\System32',
  NO_COLOR: '1',
});
const ALLOWED_TOOL_PATHS = Object.freeze([
  WINDOWS_SUBST_PATH,
  WINDOWS_TASKKILL_PATH,
  WINDOWS_TERMINAL_PATH,
  WINDOWS_POWERSHELL_PATH,
]);

const residualData = (): AppError =>
  new AppError('PROVIDER_RESIDUAL_DATA', APP_ERROR_MESSAGES.PROVIDER_RESIDUAL_DATA);
const terminalUnavailable = (): AppError =>
  new AppError(
    'PROVIDER_LOGIN_TERMINAL_UNAVAILABLE',
    APP_ERROR_MESSAGES.PROVIDER_LOGIN_TERMINAL_UNAVAILABLE,
  );

export interface WindowsToolIdentityGuard {
  runVerified<T>(
    path: string,
    operation: ProviderConnectionOperation,
    run: () => Promise<T>,
  ): Promise<T>;
}

type WindowsToolIdentityGuardOptions = Readonly<{
  files: CliExecutableFileAccess;
  hasher: CliFileHasher;
}>;

class FixedWindowsToolIdentityGuard implements WindowsToolIdentityGuard {
  readonly #files: CliExecutableFileAccess;
  readonly #hasher: CliFileHasher;
  readonly #processHashes = new Map<string, string>();

  constructor(options: WindowsToolIdentityGuardOptions) {
    this.#files = options.files;
    this.#hasher = options.hasher;
  }

  async runVerified<T>(
    path: string,
    operation: ProviderConnectionOperation,
    run: () => Promise<T>,
  ): Promise<T> {
    assertProviderConnectionActive(operation);
    const initial = await this.#capture(path, operation);
    assertProviderConnectionActive(operation);
    const key = path.toLowerCase();
    const pinned = this.#processHashes.get(key);
    if (pinned !== undefined && pinned !== initial) throw unsafeVersion();
    if (pinned === undefined) this.#processHashes.set(key, initial);

    let value: T | undefined;
    let operationError: unknown;
    try {
      value = await run();
      assertProviderConnectionActive(operation);
    } catch (error) {
      assertProviderConnectionActive(operation);
      operationError = error;
    }

    const finalHash = await this.#capture(path, operation);
    assertProviderConnectionActive(operation);
    if (initial !== finalHash || this.#processHashes.get(key) !== finalHash) throw unsafeVersion();
    if (operationError !== undefined) throw operationError;
    return value as T;
  }

  async #capture(path: string, operation: ProviderConnectionOperation): Promise<string> {
    try {
      assertProviderConnectionActive(operation);
      if (!ALLOWED_TOOL_PATHS.some((allowed) => sameWindowsPath(allowed, path))) {
        throw unsafeVersion();
      }
      const canonical = await secureExactPath(this.#files, path, operation);
      assertProviderConnectionActive(operation);
      if (!sameWindowsPath(canonical, path)) throw unsafeVersion();
      const hash = await hashSecureFile(
        { files: this.#files, hasher: this.#hasher },
        canonical,
        operation,
      );
      assertProviderConnectionActive(operation);
      if (!SHA_256_PATTERN.test(hash)) throw unsafeVersion();
      return hash;
    } catch (error) {
      assertProviderConnectionActive(operation);
      if (sameWindowsPath(path, WINDOWS_TERMINAL_PATH) && isMissingPathError(error)) {
        throw terminalUnavailable();
      }
      throw unsafeVersion();
    }
  }
}

export const createWindowsToolIdentityGuardForTest = (
  options: WindowsToolIdentityGuardOptions,
): WindowsToolIdentityGuard => new FixedWindowsToolIdentityGuard(options);

export const createWindowsToolIdentityGuard = createWindowsToolIdentityGuardForTest;

export interface WindowsSubstMappingPort {
  list(operation: ProviderConnectionOperation): Promise<ReadonlyMap<string, string>>;
  map(drive: string, target: string, operation: ProviderConnectionOperation): Promise<void>;
  unmap(
    drive: string,
    expectedTarget: string,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
}

type WindowsSubstMappingOptions = Readonly<{
  runner: CliProcessRunner;
  tools: WindowsToolIdentityGuard;
}>;

const assertAliasDrive = (drive: string): void => {
  if (!WINDOWS_ALIAS_DRIVES.includes(drive as (typeof WINDOWS_ALIAS_DRIVES)[number])) {
    throw residualData();
  }
};

const parseSubstMappings = (output: string): ReadonlyMap<string, string> => {
  if (Buffer.byteLength(output, 'utf8') > 32_768) throw residualData();
  const mappings = new Map<string, string>();
  const trimmed = output.trim();
  if (trimmed.length === 0) return mappings;
  for (const line of trimmed.split(/\r?\n/u)) {
    const match = /^([A-Z]):\\: => ([A-Za-z]:\\[^\r\n]*)$/u.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) throw residualData();
    const drive = `${match[1]}:`;
    const target = win32.normalize(match[2]);
    if (target !== match[2] || !isCanonicalAbsoluteWindowsPath(target) || mappings.has(drive)) {
      throw residualData();
    }
    mappings.set(drive, target);
  }
  return mappings;
};

class VerifiedWindowsSubstMappingPort implements WindowsSubstMappingPort {
  readonly #runner: CliProcessRunner;
  readonly #tools: WindowsToolIdentityGuard;

  constructor(options: WindowsSubstMappingOptions) {
    this.#runner = options.runner;
    this.#tools = options.tools;
  }

  async list(operation: ProviderConnectionOperation): Promise<ReadonlyMap<string, string>> {
    assertProviderConnectionActive(operation);
    const result = await this.#run([], operation);
    assertProviderConnectionActive(operation);
    if (result.exitCode !== 0) throw residualData();
    return parseSubstMappings(result.stdout);
  }

  async map(drive: string, target: string, operation: ProviderConnectionOperation): Promise<void> {
    assertProviderConnectionActive(operation);
    assertAliasDrive(drive);
    if (!isCanonicalAbsoluteWindowsPath(target)) throw residualData();
    if ((await this.list(operation)).has(drive)) throw residualData();
    assertProviderConnectionActive(operation);
    const result = await this.#run([drive, target], operation);
    assertProviderConnectionActive(operation);
    if (result.exitCode !== 0) throw residualData();
    const observed = (await this.list(operation)).get(drive);
    assertProviderConnectionActive(operation);
    if (observed === undefined || !sameWindowsPath(observed, target)) throw residualData();
  }

  async unmap(
    drive: string,
    expectedTarget: string,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    assertProviderConnectionActive(operation);
    assertAliasDrive(drive);
    const current = (await this.list(operation)).get(drive);
    assertProviderConnectionActive(operation);
    if (current === undefined || !sameWindowsPath(current, expectedTarget)) throw residualData();
    const result = await this.#run([drive, '/D'], operation);
    assertProviderConnectionActive(operation);
    if (result.exitCode !== 0) throw residualData();
    if ((await this.list(operation)).has(drive)) throw residualData();
    assertProviderConnectionActive(operation);
  }

  async #run(args: readonly string[], operation: ProviderConnectionOperation) {
    assertProviderConnectionActive(operation);
    const result = await this.#tools.runVerified(WINDOWS_SUBST_PATH, operation, () =>
      this.#runner.run(
        Object.freeze({
          requestId: operation.requestId,
          launcherPath: WINDOWS_SUBST_PATH,
          args: Object.freeze([...args]),
          cwd: 'C:\\Windows\\System32',
          env: FIXED_SYSTEM_ENVIRONMENT,
          stdin: '',
          timeoutMs: 5_000,
          stdoutLimitBytes: 32_768,
          stderrLimitBytes: 1_024,
          signal: operation.signal,
          shell: false,
        }),
      ),
    );
    assertProviderConnectionActive(operation);
    return result;
  }
}

export const createWindowsSubstMappingPortForTest = (
  options: WindowsSubstMappingOptions,
): WindowsSubstMappingPort => new VerifiedWindowsSubstMappingPort(options);

export const createWindowsSubstMappingPort = createWindowsSubstMappingPortForTest;
