import { Buffer } from 'node:buffer';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import type { CliCredentialGuard, CliCredentialInspection } from './cliCredentialGuard';
import { assertProviderConnectionActive, unsafeVersion } from './cliFileIntegrity';
import {
  assertGeminiProfileFiles,
  type GeminiBinding,
  geminiError,
  isGeminiProviderError,
} from './geminiCliProtocol';
import {
  runVerifiedWindowsPowerShell,
  type WindowsPowerShellDependencies,
} from './windowsPowerShell';

const WINDOWS_CREDENTIAL_PRESENCE_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class StudyAppGeminiOauthPresence
{
    private const uint CRED_TYPE_GENERIC = 1;
    private const int ERROR_NOT_FOUND = 1168;

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredReadW(
        string target,
        uint type,
        uint flags,
        out IntPtr credential);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern void CredFree(IntPtr credential);

    public static int Inspect()
    {
        IntPtr credential;
        if (CredReadW("gemini-cli-oauth/main-account", CRED_TYPE_GENERIC, 0, out credential))
        {
            if (credential == IntPtr.Zero)
            {
                return 2;
            }

            CredFree(credential);
            return 1;
        }

        int error = Marshal.GetLastWin32Error();
        if (credential != IntPtr.Zero)
        {
            CredFree(credential);
        }

        return error == ERROR_NOT_FOUND ? 0 : 2;
    }
}
"@
$status = [StudyAppGeminiOauthPresence]::Inspect()
if ($status -eq 1) {
    [Console]::Out.Write('{"status":"present"}')
    exit 0
}
if ($status -eq 0) {
    [Console]::Out.Write('{"status":"absent"}')
    exit 0
}
exit 1`;

export const WINDOWS_CREDENTIAL_PRESENCE_ENCODED_COMMAND = Buffer.from(
  WINDOWS_CREDENTIAL_PRESENCE_SCRIPT,
  'utf16le',
).toString('base64');

export interface WindowsCredentialPresence {
  inspectGeminiOauth(operation: ProviderConnectionOperation): Promise<'present' | 'absent'>;
}

export type GeminiCredentialEvidence = Readonly<{
  backend: 'windows_credential_manager';
  status: 'present' | 'absent';
  resolvedProfilePath: null;
}>;

export const createGeminiCredentialEvidence = (
  status: 'present' | 'absent',
): GeminiCredentialEvidence =>
  Object.freeze({
    backend: 'windows_credential_manager',
    status,
    resolvedProfilePath: null,
  });

export const GEMINI_ABSENT_CREDENTIAL_EVIDENCE = createGeminiCredentialEvidence('absent');

const normalizeGeminiCredentialBoundaryFailure = (
  error: unknown,
  operation: ProviderConnectionOperation,
  allowResidual: boolean,
) => {
  if (isGeminiProviderError(error)) {
    if (error.code === 'PROVIDER_UNSAFE_VERSION') return geminiError(error.code);
    if (allowResidual && error.code === 'PROVIDER_RESIDUAL_DATA') return geminiError(error.code);
    if (error.code === 'PROVIDER_CANCELLED' && operation.signal.aborted) {
      return geminiError(error.code);
    }
  }
  return operation.signal.aborted
    ? geminiError('PROVIDER_CANCELLED')
    : geminiError('PROVIDER_UNSAFE_VERSION');
};

export const inspectGeminiCredentialProfile = async (
  guard: CliCredentialGuard,
  binding: GeminiBinding,
  managedProfilePath: string,
  evidence: GeminiCredentialEvidence,
  operation: ProviderConnectionOperation,
): Promise<CliCredentialInspection> => {
  try {
    const inspection = await guard.inspect(
      Object.freeze({ binding, managedProfilePath, evidence }),
      operation,
    );
    if (
      inspection.scope !== 'provider_global' ||
      inspection.providerManagedHistory ||
      inspection.backend !== 'windows_credential_manager' ||
      inspection.status !== evidence.status
    ) {
      throw geminiError('PROVIDER_UNSAFE_VERSION');
    }
    assertGeminiProfileFiles(inspection.observedFileNames);
    return Object.freeze({
      backend: 'windows_credential_manager',
      scope: 'provider_global',
      status: inspection.status,
      observedFileNames: Object.freeze([...inspection.observedFileNames]),
      providerManagedHistory: false,
    });
  } catch (error) {
    throw normalizeGeminiCredentialBoundaryFailure(error, operation, true);
  }
};

export const inspectGeminiWindowsCredentialPresence = async (
  presence: WindowsCredentialPresence,
  operation: ProviderConnectionOperation,
): Promise<GeminiCredentialEvidence> => {
  try {
    const status = await presence.inspectGeminiOauth(operation);
    if (status !== 'present' && status !== 'absent') {
      throw geminiError('PROVIDER_UNSAFE_VERSION');
    }
    return createGeminiCredentialEvidence(status);
  } catch (error) {
    throw normalizeGeminiCredentialBoundaryFailure(error, operation, false);
  }
};

class FixedWindowsCredentialPresence implements WindowsCredentialPresence {
  readonly #dependencies: WindowsPowerShellDependencies;

  constructor(dependencies: WindowsPowerShellDependencies) {
    this.#dependencies = Object.freeze({ ...dependencies });
  }

  async inspectGeminiOauth(operation: ProviderConnectionOperation): Promise<'present' | 'absent'> {
    try {
      assertProviderConnectionActive(operation);
      const result = await runVerifiedWindowsPowerShell(
        this.#dependencies,
        {
          encodedCommand: WINDOWS_CREDENTIAL_PRESENCE_ENCODED_COMMAND,
          env: Object.freeze({}),
          timeoutMs: 10_000,
          stdoutLimitBytes: 256,
          stderrLimitBytes: 256,
        },
        operation,
      );
      assertProviderConnectionActive(operation);
      if (result.exitCode !== 0 || result.stderr !== '') throw unsafeVersion();
      if (result.stdout === '{"status":"present"}') return 'present';
      if (result.stdout === '{"status":"absent"}') return 'absent';
      throw unsafeVersion();
    } catch {
      assertProviderConnectionActive(operation);
      throw unsafeVersion();
    }
  }
}

export const createWindowsCredentialPresence = (
  dependencies: WindowsPowerShellDependencies,
): WindowsCredentialPresence => {
  const keys = Object.keys(dependencies).sort();
  if (keys.length !== 3 || keys[0] !== 'files' || keys[1] !== 'hasher' || keys[2] !== 'runner') {
    throw unsafeVersion();
  }
  return new FixedWindowsCredentialPresence(dependencies);
};
