import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type CliRuntimeBinding,
  createProviderConnectionOperation,
  type ProviderConnectionOperation,
} from '../../src/core/ports/aiProvider';
import type {
  CliProcessRequest,
  CliProcessResult,
  CliProcessRunner,
} from '../../src/core/ports/cliProcessRunner';
import {
  type AntigravityManagedArtifacts,
  createAntigravityCliAdapterForTest,
} from '../../src/infrastructure/providers/cli/antigravityCliAdapter';
import {
  type CredentialProfileScanner,
  createCliCredentialGuardForTest,
} from '../../src/infrastructure/providers/cli/cliCredentialGuard';
import type { CliExecutableInspector } from '../../src/infrastructure/providers/cli/cliExecutableInspector';
import { bindingHash } from '../../src/infrastructure/providers/cli/cliIdentity';
import { createCliPrivateDirectoryManager } from '../../src/infrastructure/providers/cli/cliPrivateDirectories';
import {
  CODEX_DISABLED_FEATURES,
  type CodexManagedArtifacts,
  type CodexManagedProfile,
  createCodexCliAdapter,
} from '../../src/infrastructure/providers/cli/codexCliAdapter';
import { CODEX_REVIEWED_FEATURE_DEFAULTS } from '../../src/infrastructure/providers/cli/codexCliProtocol';
import type { CodexCredentialStatusInspector } from '../../src/infrastructure/providers/cli/codexCredentialStatus';
import {
  createGeminiCliAdapter,
  type GeminiManagedArtifacts,
  type GeminiManagedProfile,
  type GeminiSettingsSchemaSnapshot,
} from '../../src/infrastructure/providers/cli/geminiCliAdapter';
import {
  type CliChildProcess,
  type CliProcessIdentityProvider,
  type CliProcessTreeTerminator,
  type CliSpawnFacade,
  createNodeCliProcessRunner,
} from '../../src/infrastructure/providers/cli/nodeCliProcessRunner';
import type { WindowsCredentialPresence } from '../../src/infrastructure/providers/cli/windowsCredentialPresence';
import { createWindowsKnownFoldersForTest } from '../../src/infrastructure/providers/cli/windowsKnownFolders';
import {
  createWindowsWorkspaceAlias,
  type WindowsAliasMarker,
  type WindowsAliasMarkerStore,
  type WindowsSubstMappingPort,
  type WindowsWorkspaceAlias,
} from '../../src/infrastructure/providers/cli/windowsWorkspaceAlias';
import {
  type CliProviderId,
  parseSafeSemVer,
  SHARED_CREDENTIAL_NOTICE_VERSION,
} from '../../src/shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../src/shared/errors';
import {
  settingsSchema as pinnedGeminiSettingsSchema,
  stream as pinnedGeminiStream,
} from '../fixtures/gemini-0.55.1';

const checkedAt = '2026-09-03T00:00:00.000Z';
const providerRuntimeRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers';
const connectionOperation = (
  requestId: string = randomUUID(),
  signal: AbortSignal = new AbortController().signal,
): ProviderConnectionOperation => createProviderConnectionOperation({ requestId, signal });
const assertValidationActive = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED);
  }
};
const identity = Object.freeze({
  providerId: 'antigravity_cli' as const,
  version: '1.1.16',
  recipeId: 'antigravity-1.1-stream-json-v1',
  credentialScope: 'provider_global' as const,
  signerClassification: 'google' as const,
  launcherSha256: 'a'.repeat(64),
  entrySha256: null,
  packageManifestSha256: null,
  platformPackageManifestSha256: null,
});
const binding = Object.freeze({
  providerId: identity.providerId,
  canonicalLauncherPath: 'C:\\Users\\student\\AppData\\Local\\agy\\bin\\agy.exe',
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
  checkedAt,
}) satisfies CliRuntimeBinding<'antigravity_cli', 'provider_global'>;

const geminiIdentity = Object.freeze({
  providerId: 'gemini_cli' as const,
  version: '0.55.1',
  recipeId: 'gemini-0.55-policy-json-v1',
  credentialScope: 'provider_global' as const,
  signerClassification: 'nodejs' as const,
  launcherSha256: 'd'.repeat(64),
  entrySha256: 'e'.repeat(64),
  packageManifestSha256: 'f'.repeat(64),
  platformPackageManifestSha256: null,
});
const geminiEntry =
  'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js';
const geminiBinding = Object.freeze({
  providerId: geminiIdentity.providerId,
  canonicalLauncherPath: 'C:\\Program Files\\nodejs\\node.exe',
  canonicalEntryPath: geminiEntry,
  canonicalPackageManifestPath:
    'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\package.json',
  canonicalPlatformPackageManifestPath: null,
  fixedPrefixArgs: Object.freeze([geminiEntry]),
  version: parseSafeSemVer(geminiIdentity.version),
  launcherSha256: geminiIdentity.launcherSha256,
  entrySha256: geminiIdentity.entrySha256,
  packageManifestSha256: geminiIdentity.packageManifestSha256,
  platformPackageManifestSha256: null,
  bindingSha256: bindingHash(geminiIdentity),
  recipeId: geminiIdentity.recipeId,
  credentialScope: geminiIdentity.credentialScope,
  signerClassification: geminiIdentity.signerClassification,
  checkedAt,
}) satisfies CliRuntimeBinding<'gemini_cli', 'provider_global'>;

const codexIdentity = Object.freeze({
  providerId: 'codex_cli' as const,
  version: '0.146.0',
  recipeId: 'codex-0.146-profile-keyring-v2',
  credentialScope: 'profile_scoped' as const,
  signerClassification: 'openai' as const,
  launcherSha256: '1'.repeat(64),
  entrySha256: null,
  packageManifestSha256: null,
  platformPackageManifestSha256: null,
});
const codexBinding = Object.freeze({
  providerId: codexIdentity.providerId,
  canonicalLauncherPath: 'C:\\Users\\student\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe',
  canonicalEntryPath: null,
  canonicalPackageManifestPath: null,
  canonicalPlatformPackageManifestPath: null,
  fixedPrefixArgs: Object.freeze([]),
  version: parseSafeSemVer(codexIdentity.version),
  launcherSha256: codexIdentity.launcherSha256,
  entrySha256: null,
  packageManifestSha256: null,
  platformPackageManifestSha256: null,
  bindingSha256: bindingHash(codexIdentity),
  recipeId: codexIdentity.recipeId,
  credentialScope: codexIdentity.credentialScope,
  signerClassification: codexIdentity.signerClassification,
  checkedAt,
}) satisfies CliRuntimeBinding<'codex_cli', 'profile_scoped'>;

const geminiSettingsSchema = JSON.stringify(pinnedGeminiSettingsSchema);

class Inspector implements CliExecutableInspector {
  async inspect<Id extends CliProviderId>(
    _providerId: Id,
    _operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id>> {
    return binding as unknown as CliRuntimeBinding<Id>;
  }
  async revalidate<Id extends CliProviderId>(
    _binding: CliRuntimeBinding<Id>,
    _operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id>> {
    return binding as unknown as CliRuntimeBinding<Id>;
  }
}

class GeminiInspector implements CliExecutableInspector {
  async inspect<Id extends CliProviderId>(
    _providerId: Id,
    _operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id>> {
    return geminiBinding as unknown as CliRuntimeBinding<Id>;
  }
  async revalidate<Id extends CliProviderId>(
    _binding: CliRuntimeBinding<Id>,
    _operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id>> {
    return geminiBinding as unknown as CliRuntimeBinding<Id>;
  }
}

class CodexInspector implements CliExecutableInspector {
  async inspect<Id extends CliProviderId>(
    _providerId: Id,
    _operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id>> {
    return codexBinding as unknown as CliRuntimeBinding<Id>;
  }
  async revalidate<Id extends CliProviderId>(
    _binding: CliRuntimeBinding<Id>,
    _operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id>> {
    return codexBinding as unknown as CliRuntimeBinding<Id>;
  }
}

class Runner implements CliProcessRunner {
  readonly calls: CliProcessRequest[] = [];
  readonly results: CliProcessResult[] = [];
  onRun: ((request: CliProcessRequest) => void) | null = null;
  cancel(): void {}
  async run(request: CliProcessRequest): Promise<CliProcessResult> {
    this.calls.push(request);
    this.onRun?.(request);
    const result = this.results.shift();
    if (result === undefined) throw new Error('missing fixture result');
    return result;
  }
}

class InMemoryAliasMappings implements WindowsSubstMappingPort {
  readonly mappings = new Map<string, string>();
  readonly mapCalls: Array<Readonly<{ drive: string; target: string }>> = [];
  readonly unmapCalls: Array<Readonly<{ drive: string; target: string }>> = [];

  async list(_operation: ProviderConnectionOperation): Promise<ReadonlyMap<string, string>> {
    return new Map(this.mappings);
  }

  async map(drive: string, target: string, _operation: ProviderConnectionOperation): Promise<void> {
    this.mapCalls.push(Object.freeze({ drive, target }));
    this.mappings.set(drive, target);
  }

  async unmap(
    drive: string,
    expectedTarget: string,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {
    if (this.mappings.get(drive) !== expectedTarget) throw new Error('mapping changed');
    this.unmapCalls.push(Object.freeze({ drive, target: expectedTarget }));
    this.mappings.delete(drive);
  }
}

class InMemoryAliasMarkers implements WindowsAliasMarkerStore {
  readonly root = `${providerRuntimeRoot}\\alias-markers`;
  readonly markers = new Map<string, WindowsAliasMarker>();

  async list(_operation: ProviderConnectionOperation): Promise<readonly WindowsAliasMarker[]> {
    return Object.freeze([...this.markers.values()]);
  }

  async write(marker: WindowsAliasMarker, _operation: ProviderConnectionOperation): Promise<void> {
    this.markers.set(marker.drive, marker);
  }

  async remove(drive: string, _operation: ProviderConnectionOperation): Promise<void> {
    this.markers.delete(drive);
  }
}

const createStaticAliases = (providerId: CliProviderId): WindowsWorkspaceAlias =>
  Object.freeze({
    acquire: async (current: CliRuntimeBinding, _operation: ProviderConnectionOperation) => {
      const profileRoot = `R:\\profiles\\${providerId}`;
      return Object.freeze({
        providerId,
        runtimeRoot: 'R:\\',
        profileRoot,
        workspaceRoot: 'R:\\workspace',
        tempRoot: 'R:\\temp',
        launcherPath: current.canonicalLauncherPath,
        fixedPrefixArgs: current.fixedPrefixArgs,
        rewritePath: (path: string) => path,
        assertNoCanonicalPathDisclosure: () => undefined,
        revalidate: async (_operation: ProviderConnectionOperation) => undefined,
        release: async () => undefined,
      });
    },
    cleanupStale: async (_binding: CliRuntimeBinding, _operation: ProviderConnectionOperation) =>
      undefined,
  });

class InMemoryReadable {
  #listener: ((chunk: Uint8Array | string) => void) | null = null;

  on(_event: 'data', listener: (chunk: Uint8Array | string) => void): this {
    this.#listener = listener;
    return this;
  }

  emit(value: string): void {
    this.#listener?.(value);
  }
}

class InMemoryGeminiChild implements CliChildProcess {
  readonly pid = 71;
  readonly stdout = new InMemoryReadable();
  readonly stderr = new InMemoryReadable();
  exitCode: number | null = null;
  stdinText = '';
  #closeListener: ((exitCode: number | null) => void) | null = null;
  #finishListener: (() => void) | null = null;
  readonly #stdoutText: string;

  constructor(stdoutText: string) {
    this.#stdoutText = stdoutText;
  }

  readonly stdin = {
    end: (data?: Uint8Array): void => {
      this.stdinText = data === undefined ? '' : Buffer.from(data).toString('utf8');
      queueMicrotask(() => {
        this.stdout.emit(this.#stdoutText);
        this.#finishListener?.();
        this.exitCode = 0;
        this.#closeListener?.(0);
      });
    },
    once: (event: 'error' | 'finish', listener: ((error: Error) => void) | (() => void)) => {
      if (event === 'finish') this.#finishListener = listener as () => void;
      return this.stdin;
    },
  };

  once(event: 'close', listener: (exitCode: number | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'close' | 'error',
    listener: ((exitCode: number | null) => void) | ((error: Error) => void),
  ): this {
    if (event === 'close') this.#closeListener = listener as (exitCode: number | null) => void;
    return this;
  }

  kill(): boolean {
    this.exitCode = 1;
    return true;
  }
}

class CapturingGeminiSpawner implements CliSpawnFacade {
  file = '';
  args: readonly string[] = [];
  options: Parameters<CliSpawnFacade['spawn']>[2] | null = null;
  child: InMemoryGeminiChild | null = null;
  readonly calls: Array<
    Readonly<{
      file: string;
      args: readonly string[];
      options: Parameters<CliSpawnFacade['spawn']>[2];
      child: InMemoryGeminiChild;
    }>
  > = [];
  readonly #stdoutTexts: string[];
  readonly #onSpawn: (() => void) | undefined;

  constructor(stdoutText: string | readonly string[], onSpawn?: () => void) {
    this.#stdoutTexts = typeof stdoutText === 'string' ? [stdoutText] : [...stdoutText];
    this.#onSpawn = onSpawn;
  }

  spawn(
    file: string,
    args: readonly string[],
    options: Parameters<CliSpawnFacade['spawn']>[2],
  ): CliChildProcess {
    this.#onSpawn?.();
    const stdoutText = this.#stdoutTexts.shift();
    if (stdoutText === undefined) throw new Error('missing child stdout fixture');
    this.file = file;
    this.args = Object.freeze([...args]);
    this.options = options;
    this.child = new InMemoryGeminiChild(stdoutText);
    this.calls.push(
      Object.freeze({
        file,
        args: Object.freeze([...args]),
        options,
        child: this.child,
      }),
    );
    return this.child;
  }
}

class Artifacts implements AntigravityManagedArtifacts {
  async writeProfileAtomic(
    _contents: string,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {}
  async verifyProfile(_contents: string, _operation: ProviderConnectionOperation): Promise<void> {}
  async prepareRequestAtomic(
    requestId: string,
    schemaJson: string | null,
    _operation: ProviderConnectionOperation,
  ) {
    return Object.freeze({
      workspacePath: `C:\\Users\\student\\AppData\\Local\\StudyApp\\providers\\workspace\\${requestId}`,
      schemaPath:
        schemaJson === null
          ? null
          : `C:\\Users\\student\\AppData\\Local\\StudyApp\\providers\\temp\\${requestId}\\output-schema.json`,
    });
  }
  async verifyRequest(
    _requestId: string,
    _schemaJson: string | null,
    operation: ProviderConnectionOperation,
  ) {
    assertValidationActive(operation.signal);
    assertValidationActive(operation.signal);
  }
  async cleanupRequest(): Promise<void> {}
  async cleanupProfileTransients(): Promise<void> {}
}

class GeminiArtifacts implements GeminiManagedArtifacts {
  readonly profiles: GeminiManagedProfile[] = [];
  async readSettingsSchemaSnapshot(
    _binding: CliRuntimeBinding<'gemini_cli', 'provider_global'>,
    _operation: ProviderConnectionOperation,
  ): Promise<GeminiSettingsSchemaSnapshot> {
    return Object.freeze({
      packageManifestSha256: geminiIdentity.packageManifestSha256,
      relativePath: 'settings.schema.json',
      schemaSha256: createHash('sha256').update(geminiSettingsSchema, 'utf8').digest('hex'),
      contents: geminiSettingsSchema,
    });
  }
  async writeProfileAtomic(
    profile: GeminiManagedProfile,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {
    this.profiles.push(profile);
  }
  async verifyProfile(
    profile: GeminiManagedProfile,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {
    expect(this.profiles.at(-1)).toEqual(profile);
  }
  async prepareRequestAtomic(requestId: string, _operation: ProviderConnectionOperation) {
    return Object.freeze({
      workspacePath: `C:\\Users\\student\\AppData\\Local\\StudyApp\\providers\\workspace\\${requestId}`,
    });
  }
  async verifyRequest(_requestId: string, operation: ProviderConnectionOperation) {
    assertValidationActive(operation.signal);
    assertValidationActive(operation.signal);
  }
  async cleanupRequest(): Promise<void> {}
  async cleanupProfileTransients(): Promise<void> {}
}

class CodexArtifacts implements CodexManagedArtifacts {
  readonly profiles: CodexManagedProfile[] = [];
  readonly schemaBytes = new Map<string, string>();
  readonly verificationSnapshots: Array<
    Readonly<{ requestId: string; contents: string; schemaSha256: string }>
  > = [];
  readonly verificationSignals: AbortSignal[] = [];
  onVerification: ((matches: boolean) => void) | null = null;
  onCleanup: (() => void) | null = null;

  async prepareProfileAtomic(
    profile: CodexManagedProfile,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {
    this.profiles.push(profile);
  }
  async verifyProfile(
    profile: CodexManagedProfile,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {
    expect(this.profiles.at(-1)).toEqual(profile);
  }
  async prepareRequestAtomic(
    requestId: string,
    schemaJson: string,
    _operation: ProviderConnectionOperation,
  ) {
    this.schemaBytes.set(requestId, schemaJson);
    return Object.freeze({
      workspacePath: `${providerRuntimeRoot}\\workspace\\${requestId}`,
      schemaPath: `${providerRuntimeRoot}\\temp\\${requestId}\\output-schema.json`,
      schemaSha256: createHash('sha256').update(schemaJson, 'utf8').digest('hex'),
    });
  }
  async verifyRequest(
    requestId: string,
    schemaJson: string,
    schemaSha256: string,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    assertValidationActive(operation.signal);
    this.verificationSignals.push(operation.signal);
    const contents = this.schemaBytes.get(requestId) ?? '';
    const matches =
      contents === schemaJson &&
      createHash('sha256').update(contents, 'utf8').digest('hex') === schemaSha256;
    assertValidationActive(operation.signal);
    this.verificationSnapshots.push(Object.freeze({ requestId, contents, schemaSha256 }));
    this.onVerification?.(matches);
    if (!matches) {
      throw new AppError('PROVIDER_UNSAFE_VERSION', APP_ERROR_MESSAGES.PROVIDER_UNSAFE_VERSION);
    }
  }
  async cleanupRequest(requestId: string): Promise<void> {
    this.onCleanup?.();
    this.schemaBytes.delete(requestId);
  }
  async cleanupProfileTransients(): Promise<void> {}

  tamperRequest(requestId: string): void {
    this.schemaBytes.set(requestId, '{"private":"tampered schema"}');
  }
}

const codexHelp = (): string =>
  [
    'Usage: codex exec [OPTIONS] [PROMPT]',
    '',
    'Options:',
    '  -i, --image <FILE>...',
    '  -m, --model <MODEL>',
    '      --strict-config',
    '      --ignore-user-config',
    '      --ignore-rules',
    '      --ephemeral',
    '      --sandbox',
    '      --skip-git-repo-check',
    '      --json',
    '      --cd',
    '      --output-schema',
    '      --color',
    '  -c, --config <key=value>',
    '      --disable',
    '  -h, --help',
  ].join('\n');

const codexFeatures = (): string =>
  `${CODEX_DISABLED_FEATURES.map((feature) => `${feature} experimental false`).join('\n')}\n${Object.entries(
    CODEX_REVIEWED_FEATURE_DEFAULTS,
  )
    .map(([feature, value]) => `${feature} removed ${value}`)
    .join('\n')}\n`;

const inspectionResults = (): readonly CliProcessResult[] =>
  Object.freeze([
    Object.freeze({
      exitCode: 0,
      stdout:
        'Usage: agy [options]\n--input-format stream-json\n--output-format stream-json|json\n--json-schema <path>\n--model <id>\n--print-timeout <duration>\n--sandbox',
      stderr: '',
    }),
    Object.freeze({
      exitCode: 0,
      stdout: 'Usage: agy models\nOutput: MODEL_ID  DISPLAY_NAME',
      stderr: '',
    }),
    Object.freeze({
      exitCode: 0,
      stdout: JSON.stringify({
        kind: 'permissions',
        toolPermission: 'strict',
        artifactReviewPolicy: 'asks-for-review',
        alwaysProceed: false,
        allow: [],
        ask: [],
        deny: [
          'read_file(*)',
          'write_file(*)',
          'read_url(*)',
          'execute_url(*)',
          'command(*)',
          'unsandboxed(*)',
          'mcp(*)',
        ],
      }),
      stderr: '',
    }),
    Object.freeze({
      exitCode: 0,
      stdout: JSON.stringify({
        kind: 'config',
        profilePath: 'R:\\profiles\\antigravity_cli',
        enableTerminalSandbox: true,
        allowNonWorkspaceAccess: false,
        enableTelemetry: false,
        mcpServers: [],
        plugins: [],
        hooks: [],
        credentialBackend: 'windows_credential_manager',
        credentialStatus: 'present',
        resolvedProfilePath: 'R:\\profiles\\antigravity_cli',
      }),
      stderr: '',
    }),
  ]);

const createIntegratedAdapter = (
  runner: CliProcessRunner,
  scanner: CredentialProfileScanner,
  aliases: WindowsWorkspaceAlias = createStaticAliases('antigravity_cli'),
  requestIds: readonly string[] = Array.from({ length: 8 }, () => randomUUID()),
) => {
  const ids = [...requestIds];
  return createAntigravityCliAdapterForTest({
    inspector: new Inspector(),
    loadBinding: () => binding,
    createRunner: () => runner,
    aliases,
    artifacts: new Artifacts(),
    providerWorkspaceRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers\\workspace',
    providerTempRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers\\temp',
    credentialGuard: createCliCredentialGuardForTest({ scanner }),
    nextChildRequestId: () => ids.shift() ?? randomUUID(),
    now: () => checkedAt,
    nowMilliseconds: () => 0,
  });
};

const createIntegratedGeminiAdapter = (
  runner: CliProcessRunner,
  scanner: CredentialProfileScanner,
  aliases: WindowsWorkspaceAlias = createStaticAliases('gemini_cli'),
  credentialStatus: 'present' | 'absent' = 'present',
) => {
  const artifacts = new GeminiArtifacts();
  const credentialPresence: WindowsCredentialPresence = Object.freeze({
    inspectGeminiOauth: async () => credentialStatus,
  });
  return {
    adapter: createGeminiCliAdapter({
      inspector: new GeminiInspector(),
      loadBinding: () => geminiBinding,
      createRunner: () => runner,
      aliases,
      artifacts,
      providerRuntimeRoot: 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers',
      credentialGuard: createCliCredentialGuardForTest({ scanner }),
      credentialPresence,
      sharedCredentialConsent: () =>
        Object.freeze({ at: checkedAt, version: SHARED_CREDENTIAL_NOTICE_VERSION }),
      now: () => checkedAt,
      nowMilliseconds: () => 0,
    }),
    artifacts,
  };
};

const createIntegratedCodexAdapter = (
  runner: CliProcessRunner,
  scanner: CredentialProfileScanner,
  aliases: WindowsWorkspaceAlias = createStaticAliases('codex_cli'),
  artifacts: CodexArtifacts = new CodexArtifacts(),
) => {
  const credentialStatusInspector: CodexCredentialStatusInspector = Object.freeze({
    inspect: async () =>
      Object.freeze({
        backend: 'windows_credential_manager' as const,
        status: 'present' as const,
        resolvedProfilePath: null,
      }),
  });
  return {
    adapter: createCodexCliAdapter({
      inspector: new CodexInspector(),
      loadBinding: () => codexBinding,
      createRunner: () => runner,
      aliases,
      artifacts,
      providerRuntimeRoot,
      credentialGuard: createCliCredentialGuardForTest({ scanner }),
      credentialStatusInspector,
      now: () => checkedAt,
      nowMilliseconds: () => 0,
    }),
    artifacts,
  };
};

const antigravityStream = (requestId: string): string =>
  [
    JSON.stringify({
      event: 'init',
      cwd: `R:\\workspace\\${requestId}`,
      permission_mode: 'strict',
      tools: [
        'read_file',
        'write_file',
        'read_url',
        'execute_url',
        'command',
        'unsandboxed',
        'mcp',
      ],
      model: 'gemini-3.1-pro-high',
    }),
    JSON.stringify({ event: 'step', step_type: 'reasoning' }),
    JSON.stringify({
      event: 'result',
      status: 'SUCCESS',
      model: 'gemini-3.1-pro-high',
      structured_output: { ok: true },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  ].join('\n');

const codexStream = (): string =>
  `${[
    JSON.stringify({
      type: 'thread.started',
      thread_id: randomUUID(),
    }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: '{"ok":true}' },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    }),
  ].join('\n')}\n`;

const createInMemoryPrivateDirectories = (lifecycle: string[] = []) => {
  const userDataRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp';
  const existing = new Set([userDataRoot.toLowerCase()]);
  const created: Array<
    Readonly<{ path: string; options: Readonly<{ recursive: true; mode: number }> }>
  > = [];
  const removed: Array<
    Readonly<{ path: string; options: Readonly<{ recursive: true; force: false }> }>
  > = [];
  const secured: string[] = [];
  const manager = createCliPrivateDirectoryManager({
    userDataRoot,
    providerRuntimeRoot,
    providerProfilesRoot: `${providerRuntimeRoot}\\profiles`,
    providerTempRoot: `${providerRuntimeRoot}\\temp`,
    providerWorkspaceRoot: `${providerRuntimeRoot}\\workspace`,
    directories: {
      mkdir: async (path, options) => {
        created.push(Object.freeze({ path, options: Object.freeze({ ...options }) }));
        existing.add(path.toLowerCase());
      },
      remove: async (path, options) => {
        lifecycle.push(`directory-cleanup:${path}`);
        removed.push(Object.freeze({ path, options: Object.freeze({ ...options }) }));
        existing.delete(path.toLowerCase());
      },
    },
    files: {
      canonicalize: async (path) => {
        if (!existing.has(path.toLowerCase())) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return path;
      },
      assertNoReparsePoints: async (path) => {
        if (!existing.has(path.toLowerCase())) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      },
      readFile: async () => new Uint8Array(),
      listChildren: async () => Object.freeze([]),
    },
    acl: {
      secure: async (path) => {
        secured.push(path);
      },
    },
  });
  return Object.freeze({ manager, created, removed, secured });
};

const createAliasBoundGeminiRunner = () => {
  const mappings = new InMemoryAliasMappings();
  const markers = new InMemoryAliasMarkers();
  const revalidator = Object.freeze({ revalidate: async () => geminiBinding });
  const aliases = createWindowsWorkspaceAlias({
    knownFolders: createWindowsKnownFoldersForTest({
      appData: 'C:\\Users\\student\\AppData\\Roaming',
      localAppData: 'C:\\Users\\student\\AppData\\Local',
      programFiles: 'C:\\Program Files',
      architecture: 'x64',
    }),
    providerRuntimeRoot,
    mappings,
    markers,
    inspector: revalidator,
  });
  const activeMappingSnapshots: ReadonlyMap<string, string>[] = [];
  const spawner = new CapturingGeminiSpawner(pinnedGeminiStream(), () => {
    activeMappingSnapshots.push(new Map(mappings.mappings));
  });
  const privateDirectories = createInMemoryPrivateDirectories();
  const identities: CliProcessIdentityProvider = Object.freeze({
    capture: async (pid: number) =>
      Object.freeze({
        pid,
        creationTime: checkedAt,
        canonicalImagePath: geminiBinding.canonicalLauncherPath,
      }),
  });
  const terminator: CliProcessTreeTerminator = Object.freeze({
    terminate: async () => undefined,
  });
  return {
    runner: createNodeCliProcessRunner({
      binding: geminiBinding,
      inspector: revalidator,
      aliases,
      directories: privateDirectories.manager,
      spawner,
      identities,
      terminator,
      tools: Object.freeze({
        runVerified: async <Value>(
          _path: string,
          _connection: ProviderConnectionOperation,
          action: () => Promise<Value>,
        ) => action(),
      }),
    }),
    mappings,
    aliases,
    privateDirectories,
    spawner,
    activeMappingSnapshots,
  };
};

const createAliasBoundAntigravityRunner = (stdoutTexts: readonly string[]) => {
  const mappings = new InMemoryAliasMappings();
  const markers = new InMemoryAliasMarkers();
  const revalidator = Object.freeze({ revalidate: async () => binding });
  const aliases = createWindowsWorkspaceAlias({
    knownFolders: createWindowsKnownFoldersForTest({
      appData: 'C:\\Users\\student\\AppData\\Roaming',
      localAppData: 'C:\\Users\\student\\AppData\\Local',
      programFiles: 'C:\\Program Files',
      architecture: 'x64',
    }),
    providerRuntimeRoot,
    mappings,
    markers,
    inspector: revalidator,
  });
  const activeMappingSnapshots: ReadonlyMap<string, string>[] = [];
  const spawner = new CapturingGeminiSpawner(stdoutTexts, () => {
    activeMappingSnapshots.push(new Map(mappings.mappings));
  });
  const privateDirectories = createInMemoryPrivateDirectories();
  const identities: CliProcessIdentityProvider = Object.freeze({
    capture: async (pid: number) =>
      Object.freeze({
        pid,
        creationTime: checkedAt,
        canonicalImagePath: binding.canonicalLauncherPath,
      }),
  });
  const terminator: CliProcessTreeTerminator = Object.freeze({
    terminate: async () => undefined,
  });
  return {
    runner: createNodeCliProcessRunner({
      binding,
      inspector: revalidator,
      aliases,
      directories: privateDirectories.manager,
      spawner,
      identities,
      terminator,
      tools: Object.freeze({
        runVerified: async <Value>(
          _path: string,
          _connection: ProviderConnectionOperation,
          action: () => Promise<Value>,
        ) => action(),
      }),
    }),
    mappings,
    aliases,
    privateDirectories,
    spawner,
    activeMappingSnapshots,
  };
};

const createAliasBoundCodexRunner = (
  onSpawn: ((spawnNumber: number) => void) | null = null,
  lifecycle: string[] = [],
) => {
  const mappings = new InMemoryAliasMappings();
  const markers = new InMemoryAliasMarkers();
  const revalidator = Object.freeze({ revalidate: async () => codexBinding });
  const aliases = createWindowsWorkspaceAlias({
    knownFolders: createWindowsKnownFoldersForTest({
      appData: 'C:\\Users\\student\\AppData\\Roaming',
      localAppData: 'C:\\Users\\student\\AppData\\Local',
      programFiles: 'C:\\Program Files',
      architecture: 'x64',
    }),
    providerRuntimeRoot,
    mappings,
    markers,
    inspector: revalidator,
  });
  const activeMappingSnapshots: ReadonlyMap<string, string>[] = [];
  let spawnNumber = 0;
  const spawner = new CapturingGeminiSpawner(
    [codexHelp(), codexFeatures(), codexStream(), codexHelp(), codexFeatures()],
    () => {
      spawnNumber += 1;
      activeMappingSnapshots.push(new Map(mappings.mappings));
      onSpawn?.(spawnNumber);
    },
  );
  const privateDirectories = createInMemoryPrivateDirectories(lifecycle);
  const identities: CliProcessIdentityProvider = Object.freeze({
    capture: async (pid: number) =>
      Object.freeze({
        pid,
        creationTime: checkedAt,
        canonicalImagePath: codexBinding.canonicalLauncherPath,
      }),
  });
  const terminator: CliProcessTreeTerminator = Object.freeze({
    terminate: async () => undefined,
  });
  return {
    runner: createNodeCliProcessRunner({
      binding: codexBinding,
      inspector: revalidator,
      aliases,
      directories: privateDirectories.manager,
      spawner,
      identities,
      terminator,
      tools: Object.freeze({
        runVerified: async <Value>(
          _path: string,
          _connection: ProviderConnectionOperation,
          action: () => Promise<Value>,
        ) => action(),
      }),
    }),
    mappings,
    aliases,
    privateDirectories,
    spawner,
    activeMappingSnapshots,
  };
};

describe('CLI provider adapters', () => {
  it('integrates Codex capability inspection with the filename-only profile-scoped credential guard', async () => {
    const roots: string[] = [];
    const scanner: CredentialProfileScanner = {
      listRelativeFileNames: async (root) => {
        roots.push(root);
        return Object.freeze([]);
      },
    };
    const runner = new Runner();
    runner.results.push(
      { exitCode: 0, stdout: codexHelp(), stderr: '' },
      { exitCode: 0, stdout: codexFeatures(), stderr: '' },
      { exitCode: 0, stdout: codexHelp(), stderr: '' },
      { exitCode: 0, stdout: codexFeatures(), stderr: '' },
    );
    const { adapter, artifacts } = createIntegratedCodexAdapter(runner, scanner);

    await expect(adapter.inspect(connectionOperation())).resolves.toMatchObject({
      status: 'credential_saved',
      credentialPresent: true,
      credentialScope: 'profile_scoped',
      providerManagedHistory: false,
    });
    expect(roots).toEqual(['R:\\profiles\\codex_cli', 'R:\\profiles\\codex_cli']);
    expect(artifacts.profiles).toEqual([
      {
        managedProfilePath: `${providerRuntimeRoot}\\profiles\\codex_cli`,
        codexHomePath: `${providerRuntimeRoot}\\profiles\\codex_cli\\settings`,
      },
    ]);
    expect(runner.calls.some((call) => call.args.includes('app-server'))).toBe(false);
    expect(
      runner.calls.some((call) => call.args.includes('login') || call.args.includes('logout')),
    ).toBe(false);
  });

  it('composes Codex hardening, schema, home, and credential scans through active Task 5 aliases', async () => {
    const requestId = randomUUID();
    const aliasBoundary = createAliasBoundCodexRunner();
    const scanMappingSnapshots: ReadonlyMap<string, string>[] = [];
    const scanner: CredentialProfileScanner = {
      listRelativeFileNames: async () => {
        scanMappingSnapshots.push(new Map(aliasBoundary.mappings.mappings));
        return Object.freeze([]);
      },
    };
    const { adapter } = createIntegratedCodexAdapter(
      aliasBoundary.runner,
      scanner,
      aliasBoundary.aliases,
    );

    await expect(adapter.probe(null, connectionOperation(requestId))).resolves.toMatchObject({
      status: 'ready',
      reportedModelId: null,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    const main = aliasBoundary.spawner.calls.find(
      (call) => call.args[0] === 'exec' && call.args.at(-1) === '-',
    );
    expect(main).toBeDefined();
    expect(main?.file).toBe('S:\\codex.exe');
    expect(main?.options.cwd).toBe(`R:\\workspace\\${requestId}`);
    expect(main?.options.env.CODEX_HOME).toBe('R:\\profiles\\codex_cli\\settings');
    expect(main?.args).toContain(`R:\\workspace\\${requestId}`);
    expect(main?.args).toContain(`R:\\temp\\${requestId}\\output-schema.json`);
    expect(main?.child.stdinText).toContain('진단용 고정 문장');
    expect(main?.child.stdinText).not.toContain(providerRuntimeRoot);
    expect(main?.args.join(' ')).not.toContain('진단용 고정 문장');
    expect(aliasBoundary.spawner.calls.every((call) => !call.args.includes('app-server'))).toBe(
      true,
    );

    const installRoot = 'C:\\Users\\student\\AppData\\Local\\OpenAI\\Codex\\bin';
    expect(
      [...aliasBoundary.activeMappingSnapshots, ...scanMappingSnapshots].every(
        (snapshot) =>
          snapshot.get('R:') === providerRuntimeRoot && snapshot.get('S:') === installRoot,
      ),
    ).toBe(true);
    expect(aliasBoundary.mappings.mapCalls).toEqual([
      { drive: 'R:', target: providerRuntimeRoot },
      { drive: 'S:', target: installRoot },
    ]);
    expect(aliasBoundary.mappings.unmapCalls).toEqual([
      { drive: 'S:', target: installRoot },
      { drive: 'R:', target: providerRuntimeRoot },
    ]);
    expect(aliasBoundary.mappings.mappings).toEqual(new Map());

    const cleanupCwd = aliasBoundary.spawner.calls.at(-1)?.options.cwd;
    const cleanupRequestId = cleanupCwd?.slice('R:\\workspace\\'.length);
    expect(cleanupRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(cleanupRequestId).not.toBe(requestId);
    expect(aliasBoundary.spawner.calls.map((call) => call.options.cwd)).toEqual([
      ...Array.from({ length: 3 }, () => `R:\\workspace\\${requestId}`),
      ...Array.from({ length: 2 }, () => `R:\\workspace\\${cleanupRequestId}`),
    ]);
    const requestCleanup = (id: string) => [
      {
        path: `${providerRuntimeRoot}\\workspace\\${id}`,
        options: { recursive: true, force: false },
      },
      {
        path: `${providerRuntimeRoot}\\temp\\${id}`,
        options: { recursive: true, force: false },
      },
    ];
    expect(aliasBoundary.privateDirectories.removed).toEqual(
      [
        ...Array.from({ length: 2 }, () => requestCleanup(requestId)),
        ...Array.from({ length: 2 }, () => requestCleanup(cleanupRequestId as string)),
      ].flat(),
    );
  });

  it('detects controlled Codex schema tamper before deterministic runner cleanup', async () => {
    const requestId = randomUUID();
    const lifecycle: string[] = [];
    const artifacts = new CodexArtifacts();
    artifacts.onVerification = (matches) =>
      lifecycle.push(matches ? 'schema-verified' : 'schema-tamper-detected');
    artifacts.onCleanup = () => lifecycle.push('artifact-cleanup');
    const aliasBoundary = createAliasBoundCodexRunner((spawnNumber) => {
      if (spawnNumber !== 3) return;
      lifecycle.push('child-started');
      artifacts.tamperRequest(requestId);
    }, lifecycle);
    const scanner: CredentialProfileScanner = {
      listRelativeFileNames: async () => Object.freeze([]),
    };
    const { adapter } = createIntegratedCodexAdapter(
      aliasBoundary.runner,
      scanner,
      aliasBoundary.aliases,
      artifacts,
    );

    const failure = await adapter
      .probe(null, connectionOperation(requestId))
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(String((failure as Error).message)).not.toContain('tampered schema');
    expect(artifacts.verificationSnapshots).toHaveLength(2);
    expect(artifacts.verificationSignals).toHaveLength(2);
    expect(artifacts.verificationSignals.every((signal) => !signal.aborted)).toBe(true);
    expect(artifacts.verificationSnapshots[1]?.contents).toBe('{"private":"tampered schema"}');
    const detectionIndex = lifecycle.indexOf('schema-tamper-detected');
    expect(detectionIndex).toBeGreaterThanOrEqual(0);
    // Main cleanup belongs to the exact artifact owner; runner recursion is only
    // used for capability-only invocations that never acquire schema/media.
    expect(lifecycle.indexOf('artifact-cleanup')).toBeGreaterThan(detectionIndex);
    expect(artifacts.schemaBytes.has(requestId)).toBe(false);
    expect(aliasBoundary.mappings.mappings).toEqual(new Map());
  });

  it.each(['inspect', 'listModels', 'probe'] as const)(
    'keeps Gemini %s gated before the real alias, credentials and runner boundaries',
    async (method) => {
      const requestId = randomUUID();
      const boundary = createAliasBoundGeminiRunner();
      let scans = 0;
      const scanner: CredentialProfileScanner = {
        listRelativeFileNames: async () => {
          scans += 1;
          throw new Error('credential scan must remain unreachable');
        },
      };
      const { adapter, artifacts } = createIntegratedGeminiAdapter(
        boundary.runner,
        scanner,
        boundary.aliases,
      );
      const operation = connectionOperation(requestId);
      await expect(
        method === 'probe' ? adapter.probe(null, operation) : adapter[method](operation),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
      expect(scans).toBe(0);
      expect(artifacts.profiles).toEqual([]);
      expect(boundary.spawner.args).toEqual([]);
      expect(boundary.mappings.mapCalls).toEqual([]);
      expect(boundary.privateDirectories.created).toEqual([]);
    },
  );

  it('integrates Antigravity inspection with provider-global credential evidence without credential enumeration', async () => {
    const roots: string[] = [];
    const scanner: CredentialProfileScanner = {
      listRelativeFileNames: async (root) => {
        roots.push(root);
        return Object.freeze(['settings.json']);
      },
    };
    const runner = new Runner();
    runner.results.push(...inspectionResults());
    const adapter = createIntegratedAdapter(runner, scanner);

    await expect(adapter.inspect(connectionOperation())).resolves.toEqual({
      status: 'credential_saved',
      version: '1.1.16',
      credentialPresent: true,
      credentialScope: 'provider_global',
      cliBinding: binding,
      providerManagedHistory: true,
    });
    expect(roots).toEqual(['R:\\profiles\\antigravity_cli']);
    expect(runner.calls.some((call) => call.args.length === 1 && call.args[0] === 'models')).toBe(
      false,
    );
  });

  it('composes Antigravity artifacts through active real alias, runner, and private directories', async () => {
    const requestId = randomUUID();
    const preflightRequestIds = Array.from({ length: 4 }, () => randomUUID());
    const stdoutTexts = [
      ...inspectionResults().map((result) => result.stdout),
      antigravityStream(requestId),
    ];
    const aliasBoundary = createAliasBoundAntigravityRunner(stdoutTexts);
    const scannedRoots: string[] = [];
    const scanMappingSnapshots: ReadonlyMap<string, string>[] = [];
    const scanner: CredentialProfileScanner = {
      listRelativeFileNames: async (root) => {
        scannedRoots.push(root);
        scanMappingSnapshots.push(new Map(aliasBoundary.mappings.mappings));
        return Object.freeze(['settings.json']);
      },
    };
    const adapter = createIntegratedAdapter(
      aliasBoundary.runner,
      scanner,
      aliasBoundary.aliases,
      preflightRequestIds,
    );

    await expect(
      adapter.probe('gemini-3.1-pro-high', connectionOperation(requestId)),
    ).resolves.toMatchObject({
      status: 'ready',
      reportedModelId: 'gemini-3.1-pro-high',
    });

    expect(scannedRoots).toEqual([
      'R:\\profiles\\antigravity_cli',
      'R:\\profiles\\antigravity_cli',
    ]);
    expect(
      [...aliasBoundary.activeMappingSnapshots, ...scanMappingSnapshots].every(
        (snapshot) =>
          snapshot.get('R:') === providerRuntimeRoot &&
          snapshot.get('S:') === 'C:\\Users\\student\\AppData\\Local\\agy\\bin',
      ),
    ).toBe(true);
    expect(aliasBoundary.mappings.mapCalls).toEqual([
      { drive: 'R:', target: providerRuntimeRoot },
      { drive: 'S:', target: 'C:\\Users\\student\\AppData\\Local\\agy\\bin' },
    ]);
    expect(aliasBoundary.mappings.unmapCalls).toEqual([
      { drive: 'S:', target: 'C:\\Users\\student\\AppData\\Local\\agy\\bin' },
      { drive: 'R:', target: providerRuntimeRoot },
    ]);
    expect(aliasBoundary.mappings.mappings).toEqual(new Map());

    const allRequestIds = [...preflightRequestIds, requestId];
    const profileRoot = `${providerRuntimeRoot}\\profiles\\antigravity_cli`;
    const sharedDirectories = [
      providerRuntimeRoot,
      `${providerRuntimeRoot}\\profiles`,
      `${providerRuntimeRoot}\\temp`,
      `${providerRuntimeRoot}\\workspace`,
      profileRoot,
      `${profileRoot}\\user`,
      `${profileRoot}\\user\\AppData`,
      `${profileRoot}\\user\\AppData\\Roaming`,
      `${profileRoot}\\user\\AppData\\Local`,
      `${profileRoot}\\settings`,
    ];
    const expectedDirectories = allRequestIds.flatMap((id) => [
      ...sharedDirectories,
      `${providerRuntimeRoot}\\workspace\\${id}`,
      `${providerRuntimeRoot}\\temp\\${id}`,
    ]);
    expect(aliasBoundary.privateDirectories.created).toEqual(
      expectedDirectories.map((path) => ({ path, options: { recursive: true, mode: 0o700 } })),
    );
    expect(aliasBoundary.privateDirectories.secured).toEqual(expectedDirectories);
    expect(aliasBoundary.privateDirectories.removed).toEqual(
      allRequestIds.flatMap((id) => [
        {
          path: `${providerRuntimeRoot}\\workspace\\${id}`,
          options: { recursive: true, force: false },
        },
        {
          path: `${providerRuntimeRoot}\\temp\\${id}`,
          options: { recursive: true, force: false },
        },
      ]),
    );

    expect(aliasBoundary.spawner.file).toBe('S:\\agy.exe');
    expect(aliasBoundary.spawner.args).toContain(`R:\\temp\\${requestId}\\output-schema.json`);
    expect(aliasBoundary.spawner.options?.cwd).toBe(`R:\\workspace\\${requestId}`);
    expect(aliasBoundary.spawner.options?.env.USERPROFILE).toBe(
      'R:\\profiles\\antigravity_cli\\user',
    );
  });

  it('integrates profile residue detection without returning credential or session details', async () => {
    const scanner: CredentialProfileScanner = {
      listRelativeFileNames: async () => Object.freeze(['history.json']),
    };
    const runner = new Runner();
    runner.results.push(...inspectionResults());
    const adapter = createIntegratedAdapter(runner, scanner);

    let error: unknown;
    try {
      await adapter.inspect(connectionOperation());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(JSON.stringify(error)).not.toContain('history.json');
    expect(runner.calls.some((call) => call.args.length === 1 && call.args[0] === 'models')).toBe(
      false,
    );
  });
});
