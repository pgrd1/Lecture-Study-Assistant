import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import type { CliProcessRunner } from '../../../core/ports/cliProcessRunner';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';
import type { CliExecutableFileAccess, CliFileHasher } from './cliExecutableInspector';
import {
  assertProviderConnectionActive,
  canonicalizeSecure,
  isCanonicalAbsoluteWindowsPath,
  runCliCleanupWithinDeadline,
} from './cliFileIntegrity';
import { runVerifiedWindowsPowerShell } from './windowsPowerShell';
import type { WindowsToolIdentityGuard } from './windowsWorkspaceAlias';

export const WINDOWS_TASKKILL_PATH = 'C:\\Windows\\System32\\taskkill.exe' as const;
export const PROCESS_IDENTITY_PID_ENVIRONMENT_KEY = 'STUDYAPP_PROCESS_IDENTITY_PID' as const;

const FIXED_SYSTEM_ENVIRONMENT = Object.freeze({
  SystemRoot: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  PATH: 'C:\\Windows\\System32',
  NO_COLOR: '1',
});

const WINDOWS_PROCESS_IDENTITY_SCRIPT = `$ErrorActionPreference = 'Stop'
$pidText = [Environment]::GetEnvironmentVariable('STUDYAPP_PROCESS_IDENTITY_PID', 'Process')
$requestedPid = 0
if (-not [int]::TryParse($pidText, [ref]$requestedPid) -or $requestedPid -le 0) { throw 'Invalid PID.' }
$process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $requestedPid" -ErrorAction Stop
if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ExecutablePath)) { throw 'Process unavailable.' }
$creation = ([datetime]$process.CreationDate).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)
[pscustomobject]@{ pid = [int]$process.ProcessId; creationTime = $creation; imagePath = [string]$process.ExecutablePath } | ConvertTo-Json -Compress`;

export const WINDOWS_PROCESS_IDENTITY_ENCODED_COMMAND = Buffer.from(
  WINDOWS_PROCESS_IDENTITY_SCRIPT,
  'utf16le',
).toString('base64');

const residualData = (): AppError =>
  new AppError('PROVIDER_RESIDUAL_DATA', APP_ERROR_MESSAGES.PROVIDER_RESIDUAL_DATA);
const TERMINATION_TIMEOUT_MS = 10_000 as const;

export type CliProcessIdentity = Readonly<{
  pid: number;
  creationTime: string;
  canonicalImagePath: string;
}>;

export interface CliProcessIdentityProvider {
  capture(pid: number, operation: ProviderConnectionOperation): Promise<CliProcessIdentity>;
}

export interface CliProcessTreeTerminator {
  terminate(identity: CliProcessIdentity): Promise<void>;
}

type WindowsProcessIdentityProviderOptions = Readonly<{
  runner: CliProcessRunner;
  files: CliExecutableFileAccess;
  hasher: CliFileHasher;
}>;

class FixedWindowsProcessIdentityProvider implements CliProcessIdentityProvider {
  readonly #options: WindowsProcessIdentityProviderOptions;

  constructor(options: WindowsProcessIdentityProviderOptions) {
    this.#options = options;
  }

  async capture(pid: number, operation: ProviderConnectionOperation): Promise<CliProcessIdentity> {
    try {
      assertProviderConnectionActive(operation);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid');
      const result = await runVerifiedWindowsPowerShell(
        this.#options,
        {
          encodedCommand: WINDOWS_PROCESS_IDENTITY_ENCODED_COMMAND,
          env: Object.freeze({ [PROCESS_IDENTITY_PID_ENVIRONMENT_KEY]: String(pid) }),
          timeoutMs: 5_000,
          stdoutLimitBytes: 4_096,
          stderrLimitBytes: 1_024,
        },
        operation,
      );
      assertProviderConnectionActive(operation);
      if (result.exitCode !== 0) throw new Error('process unavailable');
      const parsed: unknown = JSON.parse(result.stdout);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid identity');
      }
      const object = parsed as Record<string, unknown>;
      const keys = Object.keys(object).sort();
      if (
        keys.join(',') !== 'creationTime,imagePath,pid' ||
        object.pid !== pid ||
        typeof object.creationTime !== 'string' ||
        new Date(object.creationTime).toISOString() !== object.creationTime ||
        typeof object.imagePath !== 'string' ||
        !isCanonicalAbsoluteWindowsPath(object.imagePath)
      ) {
        throw new Error('invalid identity');
      }
      const canonicalImagePath = await canonicalizeSecure(
        this.#options.files,
        object.imagePath,
        operation,
      );
      assertProviderConnectionActive(operation);
      return Object.freeze({ pid, creationTime: object.creationTime, canonicalImagePath });
    } catch {
      assertProviderConnectionActive(operation);
      throw residualData();
    }
  }
}

export const createWindowsProcessIdentityProviderForTest = (
  options: WindowsProcessIdentityProviderOptions,
): CliProcessIdentityProvider => new FixedWindowsProcessIdentityProvider(options);

export const createWindowsProcessIdentityProvider = createWindowsProcessIdentityProviderForTest;

type WindowsProcessTreeTerminatorOptions = Readonly<{
  runner: CliProcessRunner;
  tools: WindowsToolIdentityGuard;
}>;

class FixedWindowsProcessTreeTerminator implements CliProcessTreeTerminator {
  readonly #options: WindowsProcessTreeTerminatorOptions;

  constructor(options: WindowsProcessTreeTerminatorOptions) {
    this.#options = options;
  }

  async terminate(identity: CliProcessIdentity): Promise<void> {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) throw residualData();
    const cleanupOperation = Object.freeze({
      requestId: randomUUID(),
      signal: AbortSignal.timeout(TERMINATION_TIMEOUT_MS),
    });
    try {
      const result = await runCliCleanupWithinDeadline(cleanupOperation, () =>
        this.#options.tools.runVerified(WINDOWS_TASKKILL_PATH, cleanupOperation, () =>
          this.#options.runner.run({
            requestId: cleanupOperation.requestId,
            launcherPath: WINDOWS_TASKKILL_PATH,
            args: Object.freeze(['/PID', String(identity.pid), '/T', '/F']),
            cwd: 'C:\\Windows\\System32',
            env: FIXED_SYSTEM_ENVIRONMENT,
            stdin: '',
            timeoutMs: TERMINATION_TIMEOUT_MS,
            stdoutLimitBytes: 1_024,
            stderrLimitBytes: 1_024,
            signal: cleanupOperation.signal,
            shell: false,
          }),
        ),
      );
      if (result.exitCode !== 0) throw residualData();
    } catch {
      throw residualData();
    }
  }
}

export const createWindowsProcessTreeTerminatorForTest = (
  options: WindowsProcessTreeTerminatorOptions,
): CliProcessTreeTerminator => new FixedWindowsProcessTreeTerminator(options);

export const createWindowsProcessTreeTerminator = createWindowsProcessTreeTerminatorForTest;
