import { win32 } from 'node:path';
import type {
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../core/ports/aiProvider';
import type { CliProcessRunner } from '../../../core/ports/cliProcessRunner';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';
import type { CliCredentialStatusEvidence } from './cliCredentialGuard';
import {
  assertProviderConnectionActive,
  isCanonicalAbsoluteWindowsPath,
  sameWindowsPath,
} from './cliFileIntegrity';
import {
  assertCodexBinding,
  assertCodexRoots,
  CODEX_CONFIG_OVERRIDES,
  CODEX_DISABLE_ARGS,
  CODEX_UUID_PATTERN,
  codexError,
} from './codexCliProtocol';
import { sameCliRuntimeBindingIdentity } from './windowsWorkspaceAlias';

export { CODEX_CONFIG_OVERRIDES, CODEX_DISABLE_ARGS } from './codexCliProtocol';

export interface CodexCredentialStatusInspector {
  inspect(
    binding: CliRuntimeBinding<'codex_cli', 'profile_scoped'>,
    managedProfilePath: string,
    operation: ProviderConnectionOperation,
  ): Promise<CliCredentialStatusEvidence>;
}

type CodexCredentialStatusInspectorOptions = Readonly<{
  createRunner: (binding: CliRuntimeBinding<'codex_cli', 'profile_scoped'>) => CliProcessRunner;
  providerRuntimeRoot: string;
}>;

const statusError = (code: 'PROVIDER_CANCELLED' | 'PROVIDER_UNSAFE_VERSION'): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);

const sanitizeFailure = (error: unknown): AppError => {
  if (AppError.isTrusted(error) && error.code.startsWith('PROVIDER_')) return error;
  return statusError('PROVIDER_UNSAFE_VERSION');
};

const assertManagedProfilePath = (path: string): void => {
  if (!isCanonicalAbsoluteWindowsPath(path)) throw codexError('PROVIDER_UNSAFE_VERSION');
  const driveRoot = win32.parse(path).root;
  if (
    !/^[R-W]:\\$/iu.test(driveRoot) ||
    !sameWindowsPath(path, win32.join(driveRoot, 'profiles', 'codex_cli'))
  ) {
    throw codexError('PROVIDER_UNSAFE_VERSION');
  }
};

const workspacePathForManagedProfile = (path: string, requestId: string): string => {
  assertManagedProfilePath(path);
  return win32.join(win32.parse(path).root, 'workspace', requestId);
};

const copyBinding = (
  binding: CliRuntimeBinding<'codex_cli', 'profile_scoped'>,
): CliRuntimeBinding<'codex_cli', 'profile_scoped'> =>
  Object.freeze({
    ...binding,
    fixedPrefixArgs: Object.freeze([...binding.fixedPrefixArgs]),
  });

const evidence = (status: 'present' | 'absent'): CliCredentialStatusEvidence =>
  Object.freeze({
    backend: 'windows_credential_manager',
    status,
    resolvedProfilePath: null,
  });

class FixedCodexCredentialStatusInspector implements CodexCredentialStatusInspector {
  readonly #options: CodexCredentialStatusInspectorOptions;

  constructor(options: CodexCredentialStatusInspectorOptions) {
    this.#options = options;
    assertCodexRoots(options.providerRuntimeRoot);
  }

  async inspect(
    binding: CliRuntimeBinding<'codex_cli', 'profile_scoped'>,
    managedProfilePath: string,
    operation: ProviderConnectionOperation,
  ): Promise<CliCredentialStatusEvidence> {
    let result: Awaited<ReturnType<CliProcessRunner['run']>> | null = null;
    let stdout = '';
    let stderr = '';
    try {
      assertProviderConnectionActive(operation);
      if (
        !CODEX_UUID_PATTERN.test(operation.requestId) ||
        !(operation.signal instanceof AbortSignal)
      ) {
        throw statusError('PROVIDER_UNSAFE_VERSION');
      }
      const currentBinding = copyBinding(assertCodexBinding(binding));
      const workspacePath = workspacePathForManagedProfile(managedProfilePath, operation.requestId);
      result = await this.#options.createRunner(currentBinding).run(
        Object.freeze({
          requestId: operation.requestId,
          launcherPath: currentBinding.canonicalLauncherPath,
          args: Object.freeze([
            ...currentBinding.fixedPrefixArgs,
            ...CODEX_CONFIG_OVERRIDES.flatMap((value) => ['-c', value]),
            ...CODEX_DISABLE_ARGS,
            'login',
            'status',
          ]),
          cwd: workspacePath,
          env: Object.freeze({}),
          stdin: '',
          timeoutMs: 10_000,
          stdoutLimitBytes: 256,
          stderrLimitBytes: 256,
          signal: operation.signal,
          shell: false,
        }),
      );
      stdout = result.stdout;
      stderr = result.stderr;
      const exitCode = result.exitCode;
      result = null;
      assertProviderConnectionActive(operation);
      const settledBinding = assertCodexBinding(binding);
      if (!sameCliRuntimeBindingIdentity(currentBinding, settledBinding)) {
        throw statusError('PROVIDER_UNSAFE_VERSION');
      }
      if (exitCode === 0 && stdout.length === 0 && stderr.trim() === 'Logged in using ChatGPT') {
        return evidence('present');
      }
      if (exitCode === 1 && stdout.length === 0 && stderr.trim() === 'Not logged in') {
        return evidence('absent');
      }
      throw statusError('PROVIDER_UNSAFE_VERSION');
    } catch (error) {
      if (operation.signal instanceof AbortSignal && operation.signal.aborted) {
        throw statusError('PROVIDER_CANCELLED');
      }
      throw sanitizeFailure(error);
    } finally {
      result = null;
      stdout = '';
      stderr = '';
    }
  }
}

export const createCodexCredentialStatusInspectorForTest = (
  options: CodexCredentialStatusInspectorOptions,
): CodexCredentialStatusInspector => new FixedCodexCredentialStatusInspector(options);

export const createCodexCredentialStatusInspector = createCodexCredentialStatusInspectorForTest;
