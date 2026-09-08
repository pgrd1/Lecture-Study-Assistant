import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type CliRuntimeBinding,
  createProviderConnectionOperation,
  type ProviderConnectionOperation,
  type ProviderRequest,
} from '../../../../../src/core/ports/aiProvider';
import type {
  CliProcessRequest,
  CliProcessResult,
  CliProcessRunner,
} from '../../../../../src/core/ports/cliProcessRunner';
import type {
  CliCredentialGuard,
  CliCredentialInspection,
  CliCredentialStatusEvidence,
} from '../../../../../src/infrastructure/providers/cli/cliCredentialGuard';
import type { CliExecutableInspector } from '../../../../../src/infrastructure/providers/cli/cliExecutableInspector';
import { bindingHash } from '../../../../../src/infrastructure/providers/cli/cliIdentity';
import {
  CODEX_DISABLE_ARGS,
  CODEX_DISABLED_FEATURES,
  type CodexManagedArtifacts,
  type CodexManagedProfile,
  createCodexCliAdapterForTest,
} from '../../../../../src/infrastructure/providers/cli/codexCliAdapter';
import type { CodexImageInput } from '../../../../../src/infrastructure/providers/cli/codexCliMedia';
import { CODEX_REVIEWED_FEATURE_DEFAULTS } from '../../../../../src/infrastructure/providers/cli/codexCliProtocol';
import type { CodexCredentialStatusInspector } from '../../../../../src/infrastructure/providers/cli/codexCredentialStatus';
import type {
  WindowsWorkspaceAlias,
  WindowsWorkspaceAliasLease,
} from '../../../../../src/infrastructure/providers/cli/windowsWorkspaceAlias';
import {
  ProviderSourceMaterializer,
  type ProviderSourceMaterializerPort,
} from '../../../../../src/infrastructure/providers/providerSourceMaterializer';
import { parseSafeSemVer } from '../../../../../src/shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../../../src/shared/errors';

const NOW = '2026-09-03T00:00:00.000Z';
const RUNTIME_ROOT = 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers';
const PROFILE_PATH = `${RUNTIME_ROOT}\\profiles\\codex_cli`;
const CODEX_HOME = `${PROFILE_PATH}\\settings`;
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const PRIVATE_PROMPT = '비공개 강의 내용';

const connectionOperation = (
  requestId: string = randomUUID(),
  signal: AbortSignal = new AbortController().signal,
): ProviderConnectionOperation => createProviderConnectionOperation({ requestId, signal });

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

const REQUIRED_HELP_FLAGS = Object.freeze([
  'image',
  'model',
  'strict-config',
  'ignore-user-config',
  'ignore-rules',
  'ephemeral',
  'sandbox',
  'skip-git-repo-check',
  'json',
  'cd',
  'output-schema',
  'color',
  'config',
  'disable',
]);

const validHelp = (): string =>
  [
    'Usage: codex exec [OPTIONS] [PROMPT]',
    '',
    'Options:',
    ...REQUIRED_HELP_FLAGS.map((flag) =>
      flag === 'config' ? '  -c, --config <key=value>' : `      --${flag}`,
    ),
    '  -h, --help',
  ].join('\n');

const validFeatures = (): string =>
  `${CODEX_DISABLED_FEATURES.map((feature) => `${feature} experimental false`).join('\n')}\n${Object.entries(
    CODEX_REVIEWED_FEATURE_DEFAULTS,
  )
    .map(([feature, value]) => `${feature} removed ${value}`)
    .join('\n')}\n`;

const representativeHelp = (): string =>
  [
    'Run Codex non-interactively',
    '',
    'Usage: codex exec [OPTIONS] [PROMPT] [COMMAND]',
    '',
    'Commands:',
    '  resume  Resume a previous session by id',
    '  review  Run a review against the current workspace',
    '  help    Print this message or the help of the given subcommand(s)',
    '',
    'Arguments:',
    '  [PROMPT]',
    '          Initial instructions for the agent',
    '',
    'Options:',
    ...REQUIRED_HELP_FLAGS.flatMap((flag) => [
      flag === 'config' ? '  -c, --config <key=value>' : `      --${flag}`,
      `          Reviewed ${flag} option`,
    ]),
    '  -h, --help',
    '          Print help',
  ].join('\n');

const canonicalLines = (events: readonly unknown[]): string =>
  `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const validEvents = (
  options: {
    output?: unknown;
    model?: string;
    usage?: unknown;
    beforeAssistant?: readonly unknown[];
  } = {},
): string => {
  return canonicalLines([
    {
      type: 'thread.started',
      thread_id: '223e4567-e89b-42d3-a456-426614174000',
      ...(options.model === undefined ? {} : { model: options.model }),
    },
    { type: 'turn.started' },
    ...(options.beforeAssistant ?? []),
    {
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'agent_message',
        text: JSON.stringify(options.output ?? { ok: true }),
      },
    },
    {
      type: 'turn.completed',
      usage: options.usage ?? {
        input_tokens: 3,
        cached_input_tokens: 1,
        cache_write_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
      },
    },
  ]);
};

class FakeInspector implements CliExecutableInspector {
  inspectCalls = 0;
  revalidateCalls = 0;
  current: CliRuntimeBinding<'codex_cli', 'profile_scoped'> = binding;

  async inspect<Id extends 'antigravity_cli' | 'gemini_cli' | 'codex_cli'>(
    _providerId: Id,
    _operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id>> {
    this.inspectCalls += 1;
    return this.current as CliRuntimeBinding<Id>;
  }

  async revalidate<Id extends 'antigravity_cli' | 'gemini_cli' | 'codex_cli'>(
    value: CliRuntimeBinding<Id>,
    _operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id>> {
    this.revalidateCalls += 1;
    return (
      this.current.providerId === value.providerId ? this.current : value
    ) as CliRuntimeBinding<Id>;
  }
}

class FakeRunner implements CliProcessRunner {
  readonly calls: CliProcessRequest[] = [];
  readonly cancelled: string[] = [];
  help = validHelp();
  features = validFeatures();
  main: CliProcessResult | Error = Object.freeze({
    exitCode: 0,
    stdout: validEvents(),
    stderr: '',
  });
  blockOn: 'help' | 'features' | 'main' | null = null;
  onMain: (() => void) | null = null;
  onMainReturn: (() => void) | null = null;
  readonly #pending = new Map<string, () => void>();

  async run(request: CliProcessRequest): Promise<CliProcessResult> {
    this.calls.push(request);
    const phase = request.args.includes('--help')
      ? 'help'
      : request.args.includes('features')
        ? 'features'
        : 'main';
    if (this.blockOn === phase) {
      this.blockOn = null;
      return await new Promise<CliProcessResult>((_resolve, reject) => {
        const abort = () =>
          reject(
            Object.assign(new Error('private cancellation detail'), {
              code: 'PROVIDER_CANCELLED',
            }),
          );
        this.#pending.set(request.requestId, abort);
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
      });
    }
    if (request.args.includes('--help')) {
      return Object.freeze({ exitCode: 0, stdout: this.help, stderr: '' });
    }
    if (request.args.includes('features')) {
      return Object.freeze({ exitCode: 0, stdout: this.features, stderr: '' });
    }
    this.onMain?.();
    const result = this.main;
    if (result instanceof Error) throw result;
    await request.postProcessValidation?.(new AbortController().signal);
    this.onMainReturn?.();
    return result;
  }

  cancel(requestId: string): void {
    this.cancelled.push(requestId);
    this.#pending.get(requestId)?.();
    this.#pending.delete(requestId);
  }
}

class FakeArtifacts implements CodexManagedArtifacts {
  images: readonly CodexImageInput[] = [];
  preparedProfiles: CodexManagedProfile[] = [];
  verifiedProfiles: CodexManagedProfile[] = [];
  preparedRequests: string[] = [];
  verifiedRequests: string[] = [];
  cleanedRequests: string[] = [];
  requestVerificationSignals: AbortSignal[] = [];
  cleanupProfileCalls = 0;
  failProfileVerification = false;
  hangProfileVerificationAt: number | null = null;
  failRequestCleanup = false;
  failProfileCleanup = false;
  hangRequestCleanup = false;
  hangProfileCleanup = false;
  onProfileCleanup: (() => void) | null = null;
  onRequestVerification: (() => void) | null = null;
  onRequestCleanup: (() => void) | null = null;

  async prepareProfileAtomic(
    profile: CodexManagedProfile,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {
    this.preparedProfiles.push(profile);
  }

  async verifyProfile(
    profile: CodexManagedProfile,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {
    this.verifiedProfiles.push(profile);
    if (this.hangProfileVerificationAt === this.verifiedProfiles.length) {
      await new Promise<void>(() => undefined);
    }
    if (this.failProfileVerification) throw new Error('C:\\private\\profile drift');
  }

  async prepareRequestAtomic(
    requestId: string,
    schemaJson: string,
    _operation: ProviderConnectionOperation,
    images: readonly CodexImageInput[] = [],
  ) {
    this.images = images;
    this.preparedRequests.push(requestId);
    return Object.freeze({
      workspacePath: `${RUNTIME_ROOT}\\workspace\\${requestId}`,
      schemaPath: `${RUNTIME_ROOT}\\temp\\${requestId}\\output-schema.json`,
      schemaSha256: createHash('sha256').update(schemaJson, 'utf8').digest('hex'),
      images: images.map(({ fileName, sizeBytes, sha256 }) => ({
        fileName,
        sizeBytes,
        sha256,
        path: `${RUNTIME_ROOT}\\temp\\${requestId}\\${fileName}`,
      })),
    });
  }

  async verifyRequest(
    requestId: string,
    _schemaJson: string,
    _schemaSha256: string,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    this.onRequestVerification?.();
    this.verifiedRequests.push(requestId);
    this.requestVerificationSignals.push(operation.signal);
  }

  async cleanupRequest(requestId: string): Promise<void> {
    this.onRequestCleanup?.();
    this.cleanedRequests.push(requestId);
    if (this.hangRequestCleanup) await new Promise<void>(() => undefined);
    if (this.failRequestCleanup) throw new Error('C:\\private\\residue');
  }

  async cleanupProfileTransients(): Promise<void> {
    this.cleanupProfileCalls += 1;
    this.onProfileCleanup?.();
    if (this.hangProfileCleanup) await new Promise<void>(() => undefined);
    if (this.failProfileCleanup) throw new Error('C:\\private\\profile residue');
  }
}

class FakeCredentialGuard implements CliCredentialGuard {
  readonly requests: Parameters<CliCredentialGuard['inspect']>[0][] = [];
  inspection: CliCredentialInspection = Object.freeze({
    backend: 'windows_credential_manager',
    scope: 'profile_scoped',
    status: 'present',
    observedFileNames: Object.freeze([]),
    providerManagedHistory: false,
  });

  async inspect(
    request: Parameters<CliCredentialGuard['inspect']>[0],
    _operation: ProviderConnectionOperation,
  ) {
    this.requests.push(request);
    return this.inspection;
  }
}

class FakeCodexCredentialStatusInspector implements CodexCredentialStatusInspector {
  readonly calls: Readonly<{
    binding: CliRuntimeBinding<'codex_cli', 'profile_scoped'>;
    managedProfilePath: string;
    operation: ProviderConnectionOperation;
  }>[] = [];
  evidence: CliCredentialStatusEvidence = Object.freeze({
    backend: 'windows_credential_manager',
    status: 'present',
    resolvedProfilePath: null,
  });

  async inspect(
    currentBinding: CliRuntimeBinding<'codex_cli', 'profile_scoped'>,
    managedProfilePath: string,
    operation: ProviderConnectionOperation,
  ): Promise<CliCredentialStatusEvidence> {
    this.calls.push(Object.freeze({ binding: currentBinding, managedProfilePath, operation }));
    return this.evidence;
  }
}

class FakeAliases implements WindowsWorkspaceAlias {
  active = 0;
  acquireCalls = 0;
  releaseCalls = 0;
  revalidateCalls = 0;
  failRelease = false;
  rejectAbortedRevalidation = false;
  profileRoot = 'R:\\profiles\\codex_cli';

  async acquire(
    _binding: CliRuntimeBinding,
    _operation: ProviderConnectionOperation,
  ): Promise<WindowsWorkspaceAliasLease> {
    this.acquireCalls += 1;
    this.active += 1;
    const release = async () => {
      this.releaseCalls += 1;
      this.active -= 1;
      if (this.failRelease) throw new Error('private mapping detail');
    };
    return Object.freeze({
      providerId: 'codex_cli' as const,
      runtimeRoot: 'R:\\',
      profileRoot: this.profileRoot,
      workspaceRoot: 'R:\\workspace',
      tempRoot: 'R:\\temp',
      launcherPath: 'S:\\codex.exe',
      fixedPrefixArgs: Object.freeze([]),
      rewritePath: (path: string) => path,
      assertNoCanonicalPathDisclosure: () => undefined,
      revalidate: async (_operation: ProviderConnectionOperation) => {
        this.revalidateCalls += 1;
        if (this.rejectAbortedRevalidation && _operation.signal.aborted)
          throw new Error('aborted alias revalidation');
        if (this.active !== 1) throw new Error('stale alias');
      },
      release,
    });
  }

  async cleanupStale(
    _binding: CliRuntimeBinding,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {}
}

const createRequest = (
  overrides: Partial<ProviderRequest<{ readonly ok: true }>> = {},
): ProviderRequest<{ readonly ok: true }> =>
  Object.freeze({
    requestId: REQUEST_ID,
    feature: 'lecture_organize' as const,
    jobId: null,
    outputSchemaId: 'lecture_output',
    outputJsonSchema: Object.freeze({
      type: 'object' as const,
      additionalProperties: false,
      required: Object.freeze(['ok']),
      properties: Object.freeze({ ok: Object.freeze({ const: true }) }),
    }),
    parseOutput: (value: unknown) => {
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        (value as { ok?: unknown }).ok !== true ||
        Reflect.ownKeys(value).length !== 1
      ) {
        throw new Error('schema mismatch containing private input');
      }
      return Object.freeze({ ok: true as const });
    },
    blocks: Object.freeze([
      Object.freeze({ role: 'system' as const, kind: 'instruction' as const, text: '고정 지침' }),
      Object.freeze({ role: 'user' as const, kind: 'source' as const, text: PRIVATE_PROMPT }),
    ]),
    timeoutMs: 120_000,
    maxOutputTokens: 1_024,
    signal: new AbortController().signal,
    modelId: null,
    promptVersion: 'v1',
    routeRevision: 1,
    providerManagedHistoryConsentAt: null,
    providerManagedHistoryConsentVersion: null,
    sharedCredentialConsentAt: null,
    sharedCredentialConsentVersion: null,
    attemptKind: 'initial' as const,
    ...overrides,
  });

const setup = (materializer?: ProviderSourceMaterializerPort) => {
  const inspector = new FakeInspector();
  const runner = new FakeRunner();
  const artifacts = new FakeArtifacts();
  const credentialGuard = new FakeCredentialGuard();
  const credentialStatusInspector = new FakeCodexCredentialStatusInspector();
  const aliases = new FakeAliases();
  const adapter = createCodexCliAdapterForTest({
    inspector,
    loadBinding: () => binding,
    createRunner: () => runner,
    aliases,
    artifacts,
    providerRuntimeRoot: RUNTIME_ROOT,
    credentialGuard,
    credentialStatusInspector,
    now: () => NOW,
    nowMilliseconds: () => 1_000,
    ...(materializer ? { materializer } : {}),
  });
  return {
    adapter,
    inspector,
    runner,
    artifacts,
    credentialGuard,
    credentialStatusInspector,
    aliases,
  };
};

const mainCall = (runner: FakeRunner): CliProcessRequest => {
  const call = runner.calls.find(
    (candidate) => candidate.args[0] === 'exec' && !candidate.args.includes('--help'),
  );
  if (call === undefined) throw new Error('missing main call');
  return call;
};

describe('Codex CLI adapter', () => {
  it('rejects a fabricated conflicting model claim in an explicit-model execution', async () => {
    const { adapter, runner } = setup();
    runner.main = { exitCode: 0, stdout: validEvents({ model: 'gpt-4.1' }), stderr: '' };
    await expect(
      adapter.execute(createRequest({ modelId: 'gpt-5.5-2026-04-23' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
  });
  it.each(['success', 'failure', 'cancel'] as const)(
    'uses explicit native image arguments and preserves originals through %s cleanup',
    async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), 'codex-native-adapter-'));
      try {
        const staging = join(root, 'staging');
        const source = join(root, 'private-original.png');
        const bytes = Buffer.from(
          '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082',
          'hex',
        );
        await writeFile(source, bytes);
        const { adapter, runner, artifacts } = setup(new ProviderSourceMaterializer(staging));
        if (outcome === 'failure')
          runner.main = { exitCode: 1, stdout: '', stderr: 'private failure' };
        if (outcome === 'cancel') runner.onMain = () => adapter.cancel(REQUEST_ID);
        const pending = adapter.execute(
          createRequest({
            modelId: 'gpt-5.5-2026-04-23',
            feature: 'document_recognition',
            blocks: [
              {
                role: 'user',
                kind: 'source_file',
                sourceId: REQUEST_ID,
                filePath: source,
                mediaType: 'image',
                sizeBytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              },
              { role: 'user', kind: 'source', text: '@C:\\private.png --image C:\\secret.png' },
            ],
          }),
        );
        if (outcome === 'success')
          await expect(pending).resolves.toMatchObject({
            reportedModelId: null,
            output: { ok: true },
          });
        else
          await expect(pending).rejects.toMatchObject({
            code: outcome === 'cancel' ? 'PROVIDER_CANCELLED' : 'PROVIDER_EXECUTION_FAILED',
          });
        const args = mainCall(runner).args;
        expect(args.slice(-6)).toEqual([
          '--model',
          'gpt-5.5-2026-04-23',
          '--image',
          `${RUNTIME_ROOT}\\temp\\${REQUEST_ID}\\image-000.png`,
          '--',
          '-',
        ]);
        expect(args.filter((arg) => arg === '--image')).toHaveLength(1);
        expect(args).not.toContain(source);
        expect(Buffer.from(artifacts.images[0]?.bytes ?? [])).toEqual(bytes);
        expect(await readdir(staging)).toEqual([]);
        expect(await readFile(source)).toEqual(bytes);
        expect(artifacts.cleanedRequests).toContain(REQUEST_ID);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('probes the explicit image snapshot without claiming a reported model', async () => {
    const { adapter, runner } = setup();
    await expect(adapter.probe('gpt-5.5-2026-04-23', connectionOperation())).resolves.toMatchObject(
      { status: 'ready', reportedModelId: null },
    );
    expect(mainCall(runner).args.slice(-3)).toEqual(['--model', 'gpt-5.5-2026-04-23', '-']);
  });
  it('inspects credential status with the verified binding and authoritative active lease profile', async () => {
    const { adapter, credentialGuard, credentialStatusInspector } = setup();
    const operation = connectionOperation();

    await expect(adapter.inspect(operation)).resolves.toMatchObject({
      status: 'credential_saved',
      credentialPresent: true,
    });

    expect(credentialStatusInspector.calls).toHaveLength(2);
    expect(credentialStatusInspector.calls[0]).toMatchObject({
      binding,
      managedProfilePath: 'R:\\profiles\\codex_cli',
      operation: { requestId: operation.requestId },
    });
    expect(credentialStatusInspector.calls[0]?.operation.signal).toBeInstanceOf(AbortSignal);
    expect(credentialStatusInspector.calls[0]?.operation.signal.aborted).toBe(false);
    expect(credentialStatusInspector.calls[1]).toMatchObject({
      binding,
      managedProfilePath: 'R:\\profiles\\codex_cli',
    });
    expect(
      credentialGuard.requests.every(
        (request) => request.managedProfilePath === 'R:\\profiles\\codex_cli',
      ),
    ).toBe(true);
  });

  it.each([
    [
      'an alternate encrypted backend',
      {
        backend: 'os_account_bound_encrypted',
        status: 'present',
        resolvedProfilePath: null,
      },
    ],
    [
      'an indeterminate status',
      {
        backend: 'windows_credential_manager',
        status: 'unknown',
        resolvedProfilePath: null,
      },
    ],
    [
      'a resolved profile path',
      {
        backend: 'windows_credential_manager',
        status: 'present',
        resolvedProfilePath: 'R:\\profiles\\codex_cli',
      },
    ],
  ] as const)(
    'rejects %s from the Codex credential inspector before scanning',
    async (_label, evidence) => {
      const { adapter, credentialGuard, credentialStatusInspector } = setup();
      credentialStatusInspector.evidence = Object.freeze(evidence);

      await expect(adapter.inspect(connectionOperation())).rejects.toMatchObject({
        code: 'PROVIDER_UNSAFE_VERSION',
      });
      expect(credentialGuard.requests).toHaveLength(0);
    },
  );

  it.each([
    ['a non-Windows credential backend', { backend: 'os_account_bound_encrypted' as const }],
    ['a credential status mismatch', { status: 'absent' as const }],
    ['provider-managed history', { providerManagedHistory: true }],
    ['a non-profile scope', { scope: 'shared_user_login' as const }],
  ])('rejects credential guard output containing %s', async (_label, override) => {
    const { adapter, credentialGuard } = setup();
    credentialGuard.inspection = Object.freeze({
      ...credentialGuard.inspection,
      ...override,
    }) as CliCredentialInspection;

    await expect(adapter.inspect(connectionOperation())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
  });

  it('freezes the reviewed feature list and emits one ordered disable pair per feature', () => {
    expect(CODEX_DISABLED_FEATURES).toEqual([
      'apps',
      'artifact',
      'auth_elicitation',
      'browser_use',
      'browser_use_external',
      'browser_use_full_cdp_access',
      'code_mode',
      'code_mode_buffered_exec',
      'code_mode_host',
      'code_mode_only',
      'computer_use',
      'default_mode_request_user_input',
      'deferred_executor',
      'deferred_tool_world_state',
      'enable_mcp_apps',
      'exec_permission_approvals',
      'executor_capability_discovery',
      'goals',
      'guardian_approval',
      'hooks',
      'image_generation',
      'in_app_browser',
      'in_app_updates',
      'mcp_2026_07_28',
      'memories',
      'multi_agent',
      'multi_agent_v2',
      'network_proxy',
      'non_prefixed_mcp_tool_names',
      'plugin_sharing',
      'plugins',
      'remote_plugin',
      'request_permissions_tool',
      'respect_system_proxy',
      'shell_snapshot',
      'shell_tool',
      'shell_zsh_fork',
      'secret_auth_storage',
      'skill_mcp_dependency_install',
      'skill_search',
      'standalone_web_search',
      'tool_call_mcp_elicitation',
      'tool_suggest',
      'unified_exec',
      'unified_exec_zsh_fork',
      'use_agent_identity',
      'workspace_dependencies',
    ]);
    expect(CODEX_DISABLE_ARGS).toEqual(
      CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    );
    expect(Object.isFrozen(CODEX_DISABLED_FEATURES)).toBe(true);
    expect(Object.isFrozen(CODEX_DISABLE_ARGS)).toBe(true);
  });

  it('offers the default text model and explicit reviewed image snapshot without claiming account availability', async () => {
    const { adapter, runner, inspector, aliases } = setup();
    const models = await adapter.listModels(connectionOperation());
    expect(models).toEqual([
      { modelId: null, displayName: 'Codex CLI 로그인 기본 모델', compatibility: 'unverified' },
      {
        modelId: 'gpt-5.5-2026-04-23',
        displayName: 'GPT-5.5 이미지 입력',
        compatibility: 'unverified',
      },
    ]);
    expect(Object.isFrozen(models)).toBe(true);
    expect(Object.isFrozen(models[0])).toBe(true);
    expect(runner.calls).toHaveLength(0);
    expect(inspector.inspectCalls).toBe(0);
    expect(aliases.acquireCalls).toBe(0);
  });

  it.each(['inspect', 'listModels', 'probe'] as const)(
    'rejects a pre-aborted %s before binding, alias, artifact, credential, or runner work',
    async (method) => {
      const { adapter, inspector, aliases, artifacts, credentialGuard, runner } = setup();
      const controller = new AbortController();
      controller.abort();
      const operation = connectionOperation(randomUUID(), controller.signal);

      const pending =
        method === 'inspect'
          ? adapter.inspect(operation)
          : method === 'listModels'
            ? adapter.listModels(operation)
            : adapter.probe(null, operation);

      await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(inspector.inspectCalls).toBe(0);
      expect(inspector.revalidateCalls).toBe(0);
      expect(aliases.acquireCalls).toBe(0);
      expect(artifacts.preparedProfiles).toHaveLength(0);
      expect(credentialGuard.requests).toHaveLength(0);
      expect(runner.calls).toHaveLength(0);
    },
  );

  it('inspects the reviewed capabilities and reports only profile-scoped credential state', async () => {
    const { adapter, runner, artifacts, credentialGuard, aliases } = setup();
    await expect(adapter.inspect(connectionOperation())).resolves.toMatchObject({
      status: 'credential_saved',
      credentialPresent: true,
      credentialScope: 'profile_scoped',
      providerManagedHistory: false,
    });
    expect(runner.calls.filter((call) => call.args.includes('--help'))).toHaveLength(2);
    expect(runner.calls.filter((call) => call.args.includes('features'))).toHaveLength(2);
    expect(runner.calls.some((call) => call.args.includes('app-server'))).toBe(false);
    expect(
      runner.calls.some((call) => call.args.includes('login') || call.args.includes('logout')),
    ).toBe(false);
    expect(artifacts.preparedProfiles[0]).toEqual({
      managedProfilePath: PROFILE_PATH,
      codexHomePath: CODEX_HOME,
    });
    expect(
      credentialGuard.requests.every(
        (request) => request.managedProfilePath === 'R:\\profiles\\codex_cli',
      ),
    ).toBe(true);
    expect(aliases.releaseCalls).toBe(1);
  });

  it.each([
    ['missing hardening flag', validHelp().replace('      --ignore-rules\n', '')],
    ['renamed hardening flag', validHelp().replace('--output-schema', '--schema-output')],
    ['unknown security flag', `${validHelp()}\n      --remote-shell`],
    ['malformed grammar', validHelp().replace('Options:', 'Flags:')],
  ])('fails closed for %s in exec help', async (_name, help) => {
    const { adapter, runner } = setup();
    runner.help = help;
    await expect(adapter.inspect(connectionOperation())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
  });

  it('accepts the reviewed multiline exec-help grammar and aligned feature columns', async () => {
    const { adapter, runner } = setup();
    runner.help = representativeHelp();
    runner.features = `${CODEX_DISABLED_FEATURES.map(
      (feature, index) =>
        `${feature.padEnd(48)}  ${index % 2 === 0 ? 'under development' : 'experimental'}  false`,
    ).join('\n')}\n${Object.entries(CODEX_REVIEWED_FEATURE_DEFAULTS)
      .map(([feature, value]) => `${feature} removed ${value}`)
      .join('\n')}\n`;
    await expect(adapter.inspect(connectionOperation())).resolves.toMatchObject({
      status: 'credential_saved',
    });
  });

  it.each([
    ['missing feature', validFeatures().replace('apps experimental false\n', '')],
    [
      'renamed feature',
      validFeatures().replace('shell_tool experimental false', 'shell_tool_v2 experimental false'),
    ],
    ['unknown feature', `${validFeatures()}new_tool_world experimental false\n`],
    ['unknown stage', validFeatures().replace('apps experimental false', 'apps preview false')],
    [
      'feature still enabled',
      validFeatures().replace('apps experimental false', 'apps experimental true'),
    ],
  ])('fails closed for %s in the feature grammar', async (_name, features) => {
    const { adapter, runner } = setup();
    runner.features = features;
    await expect(adapter.inspect(connectionOperation())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
  });

  it('pins every hardening argument and sends the private prompt only through stdin', async () => {
    const { adapter, runner } = setup();
    const request = createRequest();
    await adapter.execute(request);
    const call = mainCall(runner);
    expect(call.args).toEqual([
      'exec',
      '--strict-config',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--json',
      '--cd',
      `${RUNTIME_ROOT}\\workspace\\${REQUEST_ID}`,
      '--output-schema',
      `${RUNTIME_ROOT}\\temp\\${REQUEST_ID}\\output-schema.json`,
      '--color',
      'never',
      '-c',
      'approval_policy="never"',
      '-c',
      'cli_auth_credentials_store="keyring"',
      '-c',
      'analytics.enabled=false',
      '-c',
      'feedback.enabled=false',
      '-c',
      'check_for_update_on_startup=false',
      '-c',
      'history.persistence="none"',
      '-c',
      'allow_login_shell=false',
      '-c',
      'mcp_servers={}',
      '-c',
      'include_apps_instructions=false',
      ...CODEX_DISABLE_ARGS,
      '-',
    ]);
    expect(call.stdin).toContain(PRIVATE_PROMPT);
    expect(call.stdin.endsWith('\n')).toBe(true);
    expect(call.args.join(' ')).not.toContain(PRIVATE_PROMPT);
    expect(Object.values(call.env).join(' ')).not.toContain(PRIVATE_PROMPT);
    expect(call.shell).toBe(false);
    expect(call.requestId).toBe(request.requestId);
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.signal.aborted).toBe(false);
  });

  it('rejects every explicit model selection before binding, alias, profile, credential, or runner work', async () => {
    const { adapter, inspector, aliases, artifacts, credentialGuard, runner } = setup();
    await expect(
      adapter.execute(createRequest({ modelId: 'gpt-5.6-codex' })),
    ).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_INCOMPATIBLE',
    });
    expect(inspector.revalidateCalls).toBe(0);
    expect(aliases.acquireCalls).toBe(0);
    expect(artifacts.preparedProfiles).toHaveLength(0);
    expect(credentialGuard.requests).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    [NOW, null],
    [null, 'shared-credential-notice-v1'],
    [NOW, 'old-notice'],
  ])(
    'rejects any shared-login consent on a profile-scoped Codex execute request',
    async (at, version) => {
      const { adapter, runner, aliases } = setup();
      await expect(
        adapter.execute(
          createRequest({ sharedCredentialConsentAt: at, sharedCredentialConsentVersion: version }),
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
      expect(runner.calls).toHaveLength(0);
      expect(aliases.acquireCalls).toBe(0);
    },
  );

  it('probes only the default model and freezes the reported model and strict usage', async () => {
    const { adapter, runner } = setup();
    const result = await adapter.probe(null, connectionOperation(REQUEST_ID));
    expect(result).toEqual({
      status: 'ready',
      reportedModelId: null,
      latencyMs: 0,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      providerManagedHistory: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
    const call = mainCall(runner);
    expect(call.args).not.toContain('--model');
    expect(call.stdin).toContain('진단용 고정 문장');
  });

  it('returns a recursively frozen locally parsed output and never returns the thread identifier', async () => {
    const { adapter } = setup();
    const result = await adapter.execute(createRequest());
    expect(result).toEqual({
      output: { ok: true },
      reportedModelId: null,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      completedAt: NOW,
    });
    expect(JSON.stringify(result)).not.toContain('223e4567');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
  });

  it.each([
    [
      'command item',
      { type: 'item.completed', item: { id: 'tool_1', type: 'command_execution', command: 'dir' } },
    ],
    [
      'MCP item',
      { type: 'item.completed', item: { id: 'tool_1', type: 'mcp_tool_call', server: 'x' } },
    ],
    [
      'browser item',
      {
        type: 'item.completed',
        item: { id: 'tool_1', type: 'browser_use', url: 'https://example.invalid' },
      },
    ],
    ['computer item', { type: 'item.completed', item: { id: 'tool_1', type: 'computer_use' } }],
    ['image item', { type: 'item.completed', item: { id: 'tool_1', type: 'image_generation' } }],
    [
      'file item',
      { type: 'item.completed', item: { id: 'tool_1', type: 'file_change', path: 'R:\\x' } },
    ],
    ['subagent item', { type: 'item.completed', item: { id: 'tool_1', type: 'subagent' } }],
    ['approval item', { type: 'item.completed', item: { id: 'tool_1', type: 'approval_request' } }],
    ['unknown item', { type: 'item.completed', item: { id: 'tool_1', type: 'future_capability' } }],
    [
      'started command item',
      {
        type: 'item.started',
        item: { id: 'tool_1', type: 'command_execution', command: 'dir' },
      },
    ],
    [
      'updated unknown item',
      { type: 'item.updated', item: { id: 'tool_1', type: 'future_capability' } },
    ],
    ['missing item object', { type: 'item.completed' }],
    ['null item object', { type: 'item.completed', item: null }],
    ['array item object', { type: 'item.completed', item: [] }],
    ['missing item type', { type: 'item.completed', item: { id: 'item_1' } }],
    ['non-string item type', { type: 'item.completed', item: { id: 'item_1', type: 1 } }],
    [
      'started assistant message lifecycle',
      {
        type: 'item.started',
        item: { id: 'item_1', type: 'agent_message', text: '{"ok":true}' },
      },
    ],
    [
      'updated reasoning lifecycle',
      { type: 'item.updated', item: { id: 'item_1', type: 'reasoning', text: 'private' } },
    ],
    [
      'top-level tool event',
      { type: 'tool.call', item: { type: 'agent_message', text: '{"ok":true}' } },
    ],
  ])('rejects a %s even when a later terminal answer is valid', async (_name, event) => {
    const { adapter, runner } = setup();
    runner.main = Object.freeze({
      exitCode: 0,
      stdout: validEvents({ beforeAssistant: [event] }),
      stderr: '',
    });
    await expect(adapter.execute(createRequest())).rejects.toMatchObject({
      code: 'PROVIDER_TOOL_ACTIVITY_DETECTED',
    });
  });

  it.each([
    [
      'duplicate assistant output',
      validEvents({
        beforeAssistant: [
          {
            type: 'item.completed',
            item: { id: 'item_0', type: 'agent_message', text: '{"ok":true}' },
          },
        ],
      }),
    ],
    [
      'assistant before turn start',
      canonicalLines([
        {
          type: 'thread.started',
          thread_id: '223e4567-e89b-42d3-a456-426614174000',
          model: 'gpt-5.6-codex',
        },
        {
          type: 'item.completed',
          item: { id: 'item_1', type: 'agent_message', text: '{"ok":true}' },
        },
        { type: 'turn.started' },
        {
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        },
      ]),
    ],
    [
      'noncanonical event JSON',
      validEvents().replace('{"type":"turn.started"}', '{ "type": "turn.started" }'),
    ],
    ['unknown event', validEvents({ beforeAssistant: [{ type: 'turn.progress' }] })],
    ['schema mismatch', validEvents({ output: { ok: false } })],
    ['empty model', validEvents({ model: '' })],
    ['rooted output path', validEvents({ output: { ok: true, path: 'C:\\private' } })],
  ])('rejects %s with only the fixed output error', async (_name, stdout) => {
    const { adapter, runner } = setup();
    runner.main = Object.freeze({ exitCode: 0, stdout, stderr: '' });
    await expect(adapter.execute(createRequest())).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_INVALID',
    });
  });

  it('normalizes a byte-bounded deeply nested event without exposing parser internals', async () => {
    const { adapter, runner } = setup();
    const deeplyNested = `${'['.repeat(20_000)}true${']'.repeat(20_000)}`;
    runner.main = Object.freeze({
      exitCode: 0,
      stdout: [
        '{"type":"thread.started","thread_id":"223e4567-e89b-42d3-a456-426614174000","model":"gpt-5.6-codex"}',
        '{"type":"turn.started"}',
        `{"type":"turn.progress","payload":${deeplyNested}}`,
        '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}',
      ].join('\n'),
      stderr: '',
    });
    await expect(adapter.execute(createRequest())).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_INVALID',
    });
  });

  it.each([
    ['missing cached tokens', { input_tokens: 1, output_tokens: 1 }],
    ['negative tokens', { input_tokens: -1, cached_input_tokens: 0, output_tokens: 1 }],
    ['fractional tokens', { input_tokens: 0.5, cached_input_tokens: 0, output_tokens: 1 }],
    [
      'unsafe tokens',
      { input_tokens: Number.MAX_SAFE_INTEGER, cached_input_tokens: 0, output_tokens: 1 },
    ],
    ['cached exceeds input', { input_tokens: 1, cached_input_tokens: 2, output_tokens: 1 }],
    ['extra usage', { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 }],
  ])('rejects %s in the closed usage grammar', async (_name, usage) => {
    const { adapter, runner } = setup();
    runner.main = Object.freeze({ exitCode: 0, stdout: validEvents({ usage }), stderr: '' });
    await expect(adapter.execute(createRequest())).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_INVALID',
    });
  });

  it.each([
    ['CODEX_CLI_ERROR AUTH_REQUIRED', 'PROVIDER_AUTH_REQUIRED'],
    ['CODEX_CLI_ERROR QUOTA_OR_BILLING', 'PROVIDER_QUOTA_OR_BILLING'],
    ['CODEX_CLI_ERROR RATE_LIMITED', 'PROVIDER_RATE_LIMITED'],
    ['CODEX_CLI_ERROR CANCELLED', 'PROVIDER_CANCELLED'],
    ['private account/path/quota detail', 'PROVIDER_EXECUTION_FAILED'],
  ] as const)(
    'normalizes the exact nonzero token %s without returning provider text',
    async (token, code) => {
      const { adapter, runner } = setup();
      runner.main = Object.freeze({ exitCode: 1, stdout: '', stderr: token });
      const error = await adapter.execute(createRequest()).catch((value: unknown) => value);
      expect(error).toMatchObject({ code });
      expect(String((error as Error).message)).not.toContain(token);
    },
  );

  it.each([false, true])(
    'preserves unresolved-child residual data after cancellation (alias rejects abort: %s)',
    async (rejectAbortedRevalidation) => {
      const { adapter, runner, artifacts, aliases } = setup();
      aliases.rejectAbortedRevalidation = rejectAbortedRevalidation;
      runner.onMain = () => adapter.cancel(REQUEST_ID);
      runner.main = new AppError(
        'PROVIDER_RESIDUAL_DATA',
        APP_ERROR_MESSAGES.PROVIDER_RESIDUAL_DATA,
      );

      await expect(adapter.execute(createRequest())).rejects.toMatchObject({
        code: 'PROVIDER_RESIDUAL_DATA',
      });
      expect(artifacts.preparedRequests).toEqual([REQUEST_ID]);
      expect(artifacts.cleanedRequests).toEqual([]);
      expect(aliases.releaseCalls).toBe(1);
    },
  );

  it('propagates adapter cancellation to a blocked main child, then cleans and releases', async () => {
    const { adapter, runner, artifacts, aliases } = setup();
    runner.blockOn = 'main';
    const pending = adapter.execute(createRequest());
    while (!runner.calls.some((call) => call.args[0] === 'exec' && !call.args.includes('--help'))) {
      await Promise.resolve();
    }
    adapter.cancel(REQUEST_ID);
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(runner.cancelled).toContain(REQUEST_ID);
    expect(artifacts.cleanedRequests).toContain(REQUEST_ID);
    expect(aliases.releaseCalls).toBe(1);
  });

  it.each(['help', 'features'] as const)(
    'propagates external cancellation to the equal-ID %s preflight and still runs the security postflight',
    async (phase) => {
      const { adapter, runner, aliases } = setup();
      const controller = new AbortController();
      const request = createRequest({ signal: controller.signal });
      runner.blockOn = phase;
      const pending = adapter.execute(request);
      while (
        !runner.calls.some((call) =>
          phase === 'help' ? call.args.includes('--help') : call.args.includes('features'),
        )
      ) {
        await Promise.resolve();
      }
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(runner.cancelled).toContain(REQUEST_ID);
      expect(runner.calls[0]?.requestId).toBe(request.requestId);
      expect(runner.calls[0]?.signal.aborted).toBe(true);
      expect(runner.calls.some((call) => call.args.includes('--help'))).toBe(true);
      expect(runner.calls.some((call) => call.args.includes('features'))).toBe(true);
      expect(aliases.releaseCalls).toBe(1);
    },
  );

  it('lets final binding drift override valid output and discards it', async () => {
    const { adapter, inspector, runner } = setup();
    runner.onMain = () => {
      inspector.current = Object.freeze({ ...binding, launcherSha256: 'b'.repeat(64) });
    };
    await expect(adapter.execute(createRequest())).rejects.toMatchObject({
      code: 'PROVIDER_CLI_CHANGED',
    });
  });

  it('keeps later binding drift ahead of a non-residual authentication failure', async () => {
    const { adapter, inspector, runner } = setup();
    runner.main = Object.freeze({
      exitCode: 1,
      stdout: '',
      stderr: 'CODEX_CLI_ERROR AUTH_REQUIRED',
    });
    runner.onMain = () => {
      inspector.current = Object.freeze({ ...binding, launcherSha256: 'b'.repeat(64) });
    };

    await expect(adapter.execute(createRequest())).rejects.toMatchObject({
      code: 'PROVIDER_CLI_CHANGED',
    });
  });

  it('lets final capability drift override valid output and discards it', async () => {
    const { adapter, runner } = setup();
    runner.onMain = () => {
      runner.help = `${validHelp()}\n      --model`;
    };
    await expect(adapter.execute(createRequest())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
  });

  it.each([
    'rollout-2026.jsonl',
    'session.json',
    'history.jsonl',
    'config.toml',
    'rules/default.rules',
    'hooks/after-run.json',
    'plugins/provider.json',
    'skills/local/SKILL.md',
    'memories/index.json',
  ])('discards valid output when post-call profile residue appears at %s', async (fileName) => {
    const { adapter, runner, credentialGuard } = setup();
    runner.onMain = () => {
      credentialGuard.inspection = Object.freeze({
        ...credentialGuard.inspection,
        observedFileNames: Object.freeze([fileName]),
      });
    };
    const error = await adapter.execute(createRequest()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(String((error as Error).message)).not.toContain(fileName);
  });

  it('discards valid output when the shared credential disappears during the call', async () => {
    const { adapter, runner, credentialGuard, credentialStatusInspector } = setup();
    runner.onMain = () => {
      credentialStatusInspector.evidence = Object.freeze({
        backend: 'windows_credential_manager',
        status: 'absent',
        resolvedProfilePath: null,
      });
      credentialGuard.inspection = Object.freeze({
        ...credentialGuard.inspection,
        status: 'absent',
      });
    };
    await expect(adapter.execute(createRequest())).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED',
    });
  });

  it('turns request cleanup or alias release failure into content-free residual data failure', async () => {
    const first = setup();
    first.artifacts.failRequestCleanup = true;
    const cleanupError = await first.adapter
      .execute(createRequest())
      .catch((value: unknown) => value);
    expect(cleanupError).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(String((cleanupError as Error).message)).not.toContain('private');

    const second = setup();
    second.aliases.failRelease = true;
    await expect(second.adapter.execute(createRequest())).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
  });

  it('bounds a never-settling request cleanup at fifteen seconds', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const { adapter, artifacts } = setup();
      artifacts.hangRequestCleanup = true;
      let settled = false;
      const pending = adapter.execute(createRequest()).finally(() => {
        settled = true;
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'PROVIDER_RESIDUAL_DATA',
      });

      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('hard-bounds profile cleanup even when the artifact implementation ignores its signal', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const { adapter, artifacts } = setup();
      artifacts.hangProfileCleanup = true;
      let settled = false;
      let failure: unknown;
      void adapter
        .inspect(connectionOperation())
        .catch((error: unknown) => {
          failure = error;
        })
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(failure).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('hard-bounds post-cleanup profile verification that ignores its signal', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const { adapter, artifacts } = setup();
      artifacts.hangProfileVerificationAt = 2;
      let settled = false;
      let failure: unknown;
      void adapter
        .inspect(connectionOperation())
        .catch((error: unknown) => {
          failure = error;
        })
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(true);
      expect(failure).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('validates the schema after child settlement but before runner return and defensive cleanup', async () => {
    const { adapter, artifacts, runner } = setup();
    const lifecycle: string[] = [];
    artifacts.onRequestVerification = () => lifecycle.push('verify');
    artifacts.onRequestCleanup = () => lifecycle.push('cleanup');
    runner.onMain = () => {
      lifecycle.length = 0;
      lifecycle.push('child-settled');
    };
    runner.onMainReturn = () => lifecycle.push('runner-return');

    await adapter.execute(createRequest());

    expect(lifecycle).toEqual(['child-settled', 'verify', 'runner-return', 'cleanup']);
    expect(artifacts.requestVerificationSignals.at(-1)).toBeInstanceOf(AbortSignal);
    expect(artifacts.requestVerificationSignals.at(-1)?.aborted).toBe(false);
  });

  it('keeps a process timeout when callback verification would otherwise fail', async () => {
    const { adapter, artifacts, runner } = setup();
    let verificationCalls = 0;
    artifacts.onRequestVerification = () => {
      verificationCalls += 1;
      if (verificationCalls > 1) throw new Error('private callback failure');
    };
    runner.main = new AppError('PROVIDER_TIMEOUT', APP_ERROR_MESSAGES.PROVIDER_TIMEOUT);

    const failure = await adapter.execute(createRequest()).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(String((failure as Error).message)).not.toContain('private');
    expect(verificationCalls).toBe(1);
    expect(artifacts.cleanedRequests).toEqual([REQUEST_ID]);
  });

  it.each([
    {
      label: 'request cleanup before capability drift',
      arrange: (state: ReturnType<typeof setup>) => {
        state.artifacts.failRequestCleanup = true;
        state.runner.onMain = () => {
          state.runner.help = `${validHelp()}\n      --model`;
        };
      },
    },
    {
      label: 'profile transient cleanup before credential drift',
      arrange: (state: ReturnType<typeof setup>) => {
        state.artifacts.failProfileCleanup = true;
        state.artifacts.onProfileCleanup = () => {
          state.credentialGuard.inspection = Object.freeze({
            ...state.credentialGuard.inspection,
            status: 'absent',
          });
        };
      },
    },
    {
      label: 'alias release after binding drift',
      arrange: (state: ReturnType<typeof setup>) => {
        state.aliases.failRelease = true;
        state.runner.onMain = () => {
          state.inspector.current = Object.freeze({
            ...binding,
            launcherSha256: 'b'.repeat(64),
          });
        };
      },
    },
  ])('keeps residual data dominant for $label', async ({ arrange }) => {
    const state = setup();
    arrange(state);

    const failure = await state.adapter.execute(createRequest()).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(String((failure as Error).message)).not.toMatch(/private|residue|drift|mapping/iu);
  });
});
