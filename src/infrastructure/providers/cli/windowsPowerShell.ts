import { win32 } from 'node:path';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import type { CliProcessResult, CliProcessRunner } from '../../../core/ports/cliProcessRunner';
import {
  assertProviderConnectionActive,
  type CliExecutableFileAccess,
  type CliFileHasher,
  isCanonicalAbsoluteWindowsPath,
  SHA_256_PATTERN,
  sameWindowsPath,
  unsafeVersion,
} from './cliFileIntegrity';

export const WINDOWS_POWERSHELL_PATH =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' as const;

export type WindowsPowerShellDependencies = Readonly<{
  runner: CliProcessRunner;
  files: CliExecutableFileAccess;
  hasher: CliFileHasher;
}>;

type WindowsPowerShellRequest = Readonly<{
  encodedCommand: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
}>;

const captureHelper = async (
  dependencies: WindowsPowerShellDependencies,
  operation: ProviderConnectionOperation,
): Promise<string> => {
  try {
    assertProviderConnectionActive(operation);
    await dependencies.files.assertNoReparsePoints(WINDOWS_POWERSHELL_PATH, operation);
    assertProviderConnectionActive(operation);
    const canonical = await dependencies.files.canonicalize(WINDOWS_POWERSHELL_PATH, operation);
    assertProviderConnectionActive(operation);
    if (
      !isCanonicalAbsoluteWindowsPath(canonical) ||
      !sameWindowsPath(canonical, WINDOWS_POWERSHELL_PATH)
    ) {
      throw unsafeVersion();
    }
    await dependencies.files.assertNoReparsePoints(canonical, operation);
    assertProviderConnectionActive(operation);
    const hash = await dependencies.hasher.sha256(canonical, operation);
    assertProviderConnectionActive(operation);
    if (!SHA_256_PATTERN.test(hash)) throw unsafeVersion();
    return hash;
  } catch {
    assertProviderConnectionActive(operation);
    throw unsafeVersion();
  }
};

export const runVerifiedWindowsPowerShell = async (
  dependencies: WindowsPowerShellDependencies,
  request: WindowsPowerShellRequest,
  operation: ProviderConnectionOperation,
): Promise<CliProcessResult> => {
  assertProviderConnectionActive(operation);
  const initialHash = await captureHelper(dependencies, operation);
  assertProviderConnectionActive(operation);
  let result: CliProcessResult | null = null;
  let processFailed = false;
  try {
    result = await dependencies.runner.run(
      Object.freeze({
        requestId: operation.requestId,
        launcherPath: WINDOWS_POWERSHELL_PATH,
        args: Object.freeze([
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          request.encodedCommand,
        ]),
        cwd: win32.dirname(WINDOWS_POWERSHELL_PATH),
        env: Object.freeze({ ...request.env }),
        stdin: '',
        timeoutMs: request.timeoutMs,
        stdoutLimitBytes: request.stdoutLimitBytes,
        stderrLimitBytes: request.stderrLimitBytes,
        signal: operation.signal,
        shell: false,
      }),
    );
  } catch {
    assertProviderConnectionActive(operation);
    processFailed = true;
  }
  assertProviderConnectionActive(operation);
  const finalHash = await captureHelper(dependencies, operation);
  assertProviderConnectionActive(operation);
  if (finalHash !== initialHash || processFailed || result === null) throw unsafeVersion();
  return result;
};
