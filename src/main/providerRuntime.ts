import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { AiProviderRouter } from '../application/providers/aiProviderRouter';
import type { AiProviderAdapter, ProviderConnectionOperation } from '../core/ports/aiProvider';
import { createFetchHttpTransport } from '../core/ports/httpTransport';
import type { SecretStore } from '../core/ports/secretStore';
import type { SqliteRepositories } from '../infrastructure/db/sqliteDatabase';
import { createAnthropicApiAdapter } from '../infrastructure/providers/api/anthropicApiAdapter';
import { createGeminiApiAdapter } from '../infrastructure/providers/api/geminiApiAdapter';
import { createOpenAiApiAdapter } from '../infrastructure/providers/api/openAiApiAdapter';
import { createProviderHttpClient } from '../infrastructure/providers/api/providerHttpClient';
import {
  createBoundedNodeProcessRunner,
  createNodeSpawnFacade,
} from '../infrastructure/providers/cli/boundedNodeProcessRunner';
import {
  createCliCredentialGuard,
  createNodeCredentialProfileScanner,
} from '../infrastructure/providers/cli/cliCredentialGuard';
import {
  type CliExecutableInspector,
  createCliExecutableInspector,
} from '../infrastructure/providers/cli/cliExecutableInspector';
import {
  createCliPrivateDirectoryManager,
  createWindowsPrivateDirectoryAcl,
} from '../infrastructure/providers/cli/cliPrivateDirectories';
import { createCodexCliAdapter } from '../infrastructure/providers/cli/codexCliAdapter';
import { createCodexCredentialStatusInspector } from '../infrastructure/providers/cli/codexCredentialStatus';
import {
  createNodeCliExecutableFileAccess,
  createNodeCliFileHasher,
} from '../infrastructure/providers/cli/nodeCliFileIntegrity';
import { createNodeCliProcessRunner } from '../infrastructure/providers/cli/nodeCliProcessRunner';
import { createNodeCodexManagedArtifacts } from '../infrastructure/providers/cli/nodeCodexManagedArtifacts';
import { createWindowsAuthenticodeVerifier } from '../infrastructure/providers/cli/windowsAuthenticodeVerifier';
import {
  createWindowsProcessIdentityProvider,
  createWindowsProcessTreeTerminator,
} from '../infrastructure/providers/cli/windowsCliProcessControl';
import { createWindowsKnownFolderProvider } from '../infrastructure/providers/cli/windowsKnownFolders';
import {
  createWindowsSubstMappingPort,
  createWindowsToolIdentityGuard,
} from '../infrastructure/providers/cli/windowsSubstMapping';
import {
  createWindowsAliasMarkerStore,
  createWindowsWorkspaceAlias,
  type WindowsWorkspaceAlias,
} from '../infrastructure/providers/cli/windowsWorkspaceAlias';
import type { AiProviderId } from '../shared/contracts/provider';
import type { RuntimePaths } from './runtimePaths';

type Dependencies = Readonly<{
  paths: RuntimePaths;
  repositories: SqliteRepositories;
  secretStore: SecretStore;
}>;

/** Construction only assembles adapters; discovery, credentials and probes require explicit calls. */
export const createProviderRuntime = ({ paths, repositories, secretStore }: Dependencies) => {
  const now = () => new Date().toISOString();
  const files = createNodeCliExecutableFileAccess();
  const hasher = createNodeCliFileHasher();
  const runner = createBoundedNodeProcessRunner();
  const powershell = { files, hasher, runner };
  const acl = createWindowsPrivateDirectoryAcl(powershell);
  const directories = createCliPrivateDirectoryManager({
    ...paths,
    userDataRoot: paths.userDataPath,
    files,
    acl,
    directories: {
      mkdir: async (path, options) => {
        await mkdir(path, options);
      },
      remove: (path, options) => rm(path, options),
    },
  });
  const tools = createWindowsToolIdentityGuard({ files, hasher });
  const signatures = createWindowsAuthenticodeVerifier(powershell);
  const knownFolders = createWindowsKnownFolderProvider(powershell);
  const mappings = createWindowsSubstMappingPort({ runner, tools });
  const markers = createWindowsAliasMarkerStore({
    providerRuntimeRoot: paths.providerRuntimeRoot,
    files,
  });
  // Known-folder discovery requires Windows calls. Defer it until an explicit provider operation.
  type Environment = Readonly<{
    inspector: CliExecutableInspector;
    aliases: WindowsWorkspaceAlias;
  }>;
  let environment: Environment | undefined;
  let loading: Promise<Environment> | undefined;
  const load = (operation: ProviderConnectionOperation): Promise<Environment> => {
    if (environment) return Promise.resolve(environment);
    loading ??= (async () => {
      const roots = await knownFolders.load(operation);
      const inspector = createCliExecutableInspector({
        ...powershell,
        signatures,
        knownFolders: roots,
        now,
      });
      const aliases = createWindowsWorkspaceAlias({
        knownFolders: roots,
        providerRuntimeRoot: paths.providerRuntimeRoot,
        mappings,
        markers,
        inspector,
      });
      environment = Object.freeze({ inspector, aliases });
      return environment;
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  };
  const inspector: CliExecutableInspector = {
    inspect: async (id, operation) => (await load(operation)).inspector.inspect(id, operation),
    revalidate: async (binding, operation) =>
      (await load(operation)).inspector.revalidate(binding, operation),
  };
  const aliases: WindowsWorkspaceAlias = {
    acquire: async (binding, operation) =>
      (await load(operation)).aliases.acquire(binding, operation),
    cleanupStale: async (binding, operation) =>
      (await load(operation)).aliases.cleanupStale(binding, operation),
  };
  const identities = createWindowsProcessIdentityProvider(powershell);
  const terminator = createWindowsProcessTreeTerminator({ runner, tools });
  const spawner = createNodeSpawnFacade();
  const createRunner = (binding: Parameters<typeof createNodeCliProcessRunner>[0]['binding']) =>
    createNodeCliProcessRunner({
      binding,
      inspector,
      aliases,
      directories,
      spawner,
      identities,
      terminator,
      tools,
    });
  const codex = createCodexCliAdapter({
    inspector,
    loadBinding: () => {
      const diagnostic = repositories.providerDiagnostics.get('codex_cli');
      return diagnostic?.providerId === 'codex_cli' &&
        diagnostic.credentialScope === 'profile_scoped'
        ? diagnostic.cliBinding
        : null;
    },
    createRunner,
    aliases,
    artifacts: createNodeCodexManagedArtifacts({
      ...paths,
      files,
      hasher,
      privateDirectories: directories,
    }),
    providerRuntimeRoot: paths.providerRuntimeRoot,
    credentialGuard: createCliCredentialGuard({
      scanner: createNodeCredentialProfileScanner(files),
    }),
    credentialStatusInspector: createCodexCredentialStatusInspector({
      createRunner,
      providerRuntimeRoot: paths.providerRuntimeRoot,
    }),
    now,
    nowMilliseconds: Date.now,
  });
  const apiOptions = {
    httpClient: createProviderHttpClient({ transport: createFetchHttpTransport() }),
    secretStore,
    now,
    nowMilliseconds: Date.now,
  };
  const adapters = new Map<AiProviderId, AiProviderAdapter>([
    ['openai_api', createOpenAiApiAdapter(apiOptions)],
    ['gemini_api', createGeminiApiAdapter(apiOptions)],
    ['claude_api', createAnthropicApiAdapter(apiOptions)],
    ['codex_cli', codex],
  ]);
  // Gemini CLI is deliberately absent while its genuine runtime readiness gate is closed.
  const router = new AiProviderRouter({
    routes: repositories.providerRoutes,
    diagnostics: repositories.providerDiagnostics,
    invocations: repositories.providerInvocations,
    adapters,
    clock: now,
    id: randomUUID,
  });
  return Object.freeze({
    router,
    providerIds: Object.freeze([...adapters.keys()]),
    secureDirectory: acl.secure.bind(acl),
    shutdown: () => router.shutdown(),
  });
};
export type ProviderRuntime = ReturnType<typeof createProviderRuntime>;
