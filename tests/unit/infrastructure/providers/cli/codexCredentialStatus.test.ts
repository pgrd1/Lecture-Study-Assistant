import { describe, expect, it } from 'vitest';
import type {
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../../../src/core/ports/aiProvider';
import type {
  CliProcessRequest,
  CliProcessResult,
  CliProcessRunner,
} from '../../../../../src/core/ports/cliProcessRunner';
import { bindingHash } from '../../../../../src/infrastructure/providers/cli/cliIdentity';
import {
  CODEX_CONFIG_OVERRIDES,
  CODEX_DISABLE_ARGS,
} from '../../../../../src/infrastructure/providers/cli/codexCliProtocol';
import {
  type CodexCredentialStatusInspector,
  createCodexCredentialStatusInspectorForTest,
} from '../../../../../src/infrastructure/providers/cli/codexCredentialStatus';
import { parseSafeSemVer } from '../../../../../src/shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../../../src/shared/errors';

const RUNTIME_ROOT = 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers';
const PROFILE_ROOT = 'R:\\profiles\\codex_cli';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-09-03T00:00:00.000Z';

const identity = Object.freeze({
  providerId: 'codex_cli' as const,
  version: '0.146.0',
  recipeId: 'codex-0.146-profile-keyring-v2',
  credentialScope: 'profile_scoped' as const,
  signerClassification: 'openai' as const,
  launcherSha256: 'a'.repeat(64),
  entrySha256: null,
  packageManifestSha256: null,
  platformPackageManifestSha256: null,
});

const binding = Object.freeze({
  providerId: identity.providerId,
  canonicalLauncherPath: 'C:\\Users\\student\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe',
  canonicalEntryPath: null,
  canonicalPackageManifestPath: null,
  canonicalPlatformPackageManifestPath: null,
  fixedPrefixArgs: Object.freeze([]),
  version: parseSafeSemVer(identity.version),
  launcherSha256: identity.launcherSha256,
  entrySha256: null,
  packageManifestSha256: null,
  platformPackageManifestSha256: null,
  bindingSha256: bindingHash(identity),
  recipeId: identity.recipeId,
  credentialScope: identity.credentialScope,
  signerClassification: identity.signerClassification,
  checkedAt: NOW,
}) satisfies CliRuntimeBinding<'codex_cli', 'profile_scoped'>;

const operation = (
  controller = new AbortController(),
): Readonly<{ controller: AbortController; operation: ProviderConnectionOperation }> =>
  Object.freeze({
    controller,
    operation: Object.freeze({ requestId: REQUEST_ID, signal: controller.signal }),
  });

class FakeRunner implements CliProcessRunner {
  readonly requests: CliProcessRequest[] = [];
  result: CliProcessResult = Object.freeze({
    exitCode: 0,
    stdout: '',
    stderr: 'Logged in using ChatGPT\n',
  });
  failure: unknown = null;
  onRun: (() => void) | null = null;

  async run(request: CliProcessRequest): Promise<CliProcessResult> {
    this.requests.push(request);
    this.onRun?.();
    if (this.failure !== null) throw this.failure;
    return this.result;
  }

  cancel(): void {}
}

const harness = () => {
  const runner = new FakeRunner();
  const factoryBindings: CliRuntimeBinding<'codex_cli', 'profile_scoped'>[] = [];
  const inspector: CodexCredentialStatusInspector = createCodexCredentialStatusInspectorForTest({
    createRunner: (current) => {
      factoryBindings.push(current);
      return runner;
    },
    providerRuntimeRoot: RUNTIME_ROOT,
  });
  return { factoryBindings, inspector, runner };
};

const captureFailure = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('EXPECTED_FAILURE');
};

describe('Codex credential status inspector', () => {
  it('runs the verified binding against the current managed profile and returns frozen ChatGPT evidence', async () => {
    const setup = harness();
    const current = operation();

    const evidence = await setup.inspector.inspect(binding, PROFILE_ROOT, current.operation);

    expect(evidence).toEqual({
      backend: 'windows_credential_manager',
      status: 'present',
      resolvedProfilePath: null,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(setup.factoryBindings).toEqual([binding]);
    expect(setup.runner.requests).toHaveLength(1);
    expect(setup.runner.requests[0]).toEqual({
      requestId: REQUEST_ID,
      launcherPath: binding.canonicalLauncherPath,
      args: [
        ...binding.fixedPrefixArgs,
        ...CODEX_CONFIG_OVERRIDES.flatMap((value) => ['-c', value]),
        ...CODEX_DISABLE_ARGS,
        'login',
        'status',
      ],
      cwd: 'R:\\workspace\\123e4567-e89b-42d3-a456-426614174000',
      env: {},
      stdin: '',
      timeoutMs: 10_000,
      stdoutLimitBytes: 256,
      stderrLimitBytes: 256,
      signal: current.operation.signal,
      shell: false,
    });
    expect(setup.runner.requests[0]?.args).not.toContain('--strict-config');
    expect(setup.runner.requests[0]?.args).not.toContain('--ignore-user-config');
    expect(setup.runner.requests[0]?.args).not.toContain('--ignore-rules');
  });

  it('accepts only the official not-logged-in exit/output pair as absent', async () => {
    const setup = harness();
    setup.runner.result = Object.freeze({
      exitCode: 1,
      stdout: '',
      stderr: '\r\nNot logged in\r\n',
    });

    await expect(
      setup.inspector.inspect(binding, PROFILE_ROOT, operation().operation),
    ).resolves.toEqual({
      backend: 'windows_credential_manager',
      status: 'absent',
      resolvedProfilePath: null,
    });
  });

  it.each([
    {
      name: 'masked API key',
      result: { exitCode: 0, stdout: '', stderr: 'Logged in using an API key - api-key-redacted' },
      privateDetail: 'api-key-redacted',
    },
    {
      name: 'access token',
      result: { exitCode: 0, stdout: '', stderr: 'Logged in using access token secret-access' },
      privateDetail: 'secret-access',
    },
    {
      name: 'personal access token',
      result: {
        exitCode: 0,
        stdout: '',
        stderr: 'Logged in using personal access token pat-private',
      },
      privateDetail: 'pat-private',
    },
    {
      name: 'Bedrock key',
      result: {
        exitCode: 0,
        stdout: '',
        stderr: 'Logged in using Amazon Bedrock API key bedrock-private',
      },
      privateDetail: 'bedrock-private',
    },
    {
      name: 'status error',
      result: {
        exitCode: 1,
        stdout: '',
        stderr: 'Error checking login status: private keyring path',
      },
      privateDetail: 'private keyring path',
    },
    {
      name: 'additional stderr line',
      result: { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT\nprivate diagnostic' },
      privateDetail: 'private diagnostic',
    },
    {
      name: 'non-empty stdout',
      result: { exitCode: 0, stdout: 'private stdout', stderr: 'Logged in using ChatGPT' },
      privateDetail: 'private stdout',
    },
    {
      name: 'wrong present exit code',
      result: { exitCode: 1, stdout: '', stderr: 'Logged in using ChatGPT' },
      privateDetail: 'Logged in using ChatGPT',
    },
    {
      name: 'wrong absent exit code',
      result: { exitCode: 0, stdout: '', stderr: 'Not logged in' },
      privateDetail: 'Not logged in',
    },
  ])(
    'fails closed for $name without exposing process output',
    async ({ result, privateDetail }) => {
      const setup = harness();
      setup.runner.result = Object.freeze(result);

      const failure = await captureFailure(() =>
        setup.inspector.inspect(binding, PROFILE_ROOT, operation().operation),
      );

      expect(failure).toMatchObject({
        code: 'PROVIDER_UNSAFE_VERSION',
        message: 'PROVIDER_UNSAFE_VERSION',
      });
      expect((failure as { cause?: unknown }).cause).toBeUndefined();
      expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(privateDetail);
    },
  );

  it.each([
    'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers\\profiles\\codex_cli',
    'R:\\profiles\\codex_cli\\nested',
    'Q:\\profiles\\codex_cli',
    'R:\\profiles\\gemini_cli',
    'R:/profiles/codex_cli',
  ])('rejects a profile outside the active shared alias contract: %s', async (profileRoot) => {
    const setup = harness();

    await expect(
      setup.inspector.inspect(binding, profileRoot, operation().operation),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(setup.factoryBindings).toHaveLength(0);
    expect(setup.runner.requests).toHaveLength(0);
  });

  it('accepts the same aliased profile using Windows case-equivalent spelling', async () => {
    const setup = harness();

    await expect(
      setup.inspector.inspect(binding, 'r:\\PROFILES\\CODEX_CLI', operation().operation),
    ).resolves.toMatchObject({ status: 'present' });
  });

  it('rejects malformed bindings before creating a process runner', async () => {
    const setup = harness();
    const malformed = Object.freeze({ ...binding, signerClassification: 'google' as const });

    await expect(
      setup.inspector.inspect(malformed as never, PROFILE_ROOT, operation().operation),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(setup.factoryBindings).toHaveLength(0);
  });

  it('revalidates binding shape after the process settles', async () => {
    const setup = harness();
    const mutable = { ...binding } as unknown as CliRuntimeBinding<
      'codex_cli',
      'profile_scoped'
    > & {
      signerClassification: 'openai' | 'google';
    };
    setup.runner.onRun = () => {
      mutable.signerClassification = 'google';
    };

    await expect(
      setup.inspector.inspect(mutable, PROFILE_ROOT, operation().operation),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
  });

  it('honors cancellation before process creation and after a settled process result', async () => {
    const before = harness();
    const preflight = operation();
    preflight.controller.abort();

    await expect(
      before.inspector.inspect(binding, PROFILE_ROOT, preflight.operation),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(before.factoryBindings).toHaveLength(0);

    const during = harness();
    const inflight = operation();
    during.runner.onRun = () => inflight.controller.abort();
    await expect(
      during.inspector.inspect(binding, PROFILE_ROOT, inflight.operation),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(during.runner.requests[0]?.signal).toBe(inflight.operation.signal);
  });

  it('preserves a trusted runner boundary error without attaching process output', async () => {
    const setup = harness();
    const trusted = new AppError('PROVIDER_CLI_CHANGED', APP_ERROR_MESSAGES.PROVIDER_CLI_CHANGED);
    setup.runner.failure = trusted;

    const failure = await captureFailure(() =>
      setup.inspector.inspect(binding, PROFILE_ROOT, operation().operation),
    );

    expect(failure).toBe(trusted);
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
  });

  it('replaces an unknown runner failure with a fixed content-free unsafe-version error', async () => {
    const setup = harness();
    const privateDetail = 'private runner output and credential location';
    setup.runner.failure = new Error(privateDetail);

    const failure = await captureFailure(() =>
      setup.inspector.inspect(binding, PROFILE_ROOT, operation().operation),
    );

    expect(failure).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(privateDetail);
  });

  it('rejects an arbitrary runtime root at construction before any runner can be created', () => {
    const runner = new FakeRunner();
    let calls = 0;

    expect(() =>
      createCodexCredentialStatusInspectorForTest({
        createRunner: () => {
          calls += 1;
          return runner;
        },
        providerRuntimeRoot: 'D:\\unmanaged\\providers',
      }),
    ).toThrow();
    expect(calls).toBe(0);
  });
});
