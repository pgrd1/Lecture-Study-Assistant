import { describe, expect, it } from 'vitest';
import type {
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../../../src/core/ports/aiProvider';
import {
  CLI_CREDENTIAL_SCOPE_BY_RECIPE,
  type CredentialProfileDirectoryReader,
  type CredentialProfileScanner,
  createCliCredentialGuardForTest,
  createCredentialProfileScannerForTest,
} from '../../../../../src/infrastructure/providers/cli/cliCredentialGuard';
import { parseSafeSemVer } from '../../../../../src/shared/contracts/provider';

const profile = 'R:\\profiles\\gemini_cli';
const operation = Object.freeze({
  requestId: '10000000-0000-4000-8000-000000000001',
  signal: new AbortController().signal,
}) satisfies ProviderConnectionOperation;
const binding = Object.freeze({
  providerId: 'gemini_cli',
  canonicalLauncherPath: 'C:\\Program Files\\nodejs\\node.exe',
  canonicalEntryPath:
    'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js',
  canonicalPackageManifestPath:
    'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\package.json',
  canonicalPlatformPackageManifestPath: null,
  fixedPrefixArgs: Object.freeze([
    'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js',
  ]),
  version: parseSafeSemVer('0.55.1'),
  launcherSha256: 'a'.repeat(64),
  entrySha256: 'b'.repeat(64),
  packageManifestSha256: 'c'.repeat(64),
  platformPackageManifestSha256: null,
  bindingSha256: 'd'.repeat(64),
  recipeId: 'gemini-0.55-policy-json-v1',
  credentialScope: 'provider_global',
  signerClassification: 'nodejs',
  checkedAt: '2026-09-02T00:00:00.000Z',
}) satisfies CliRuntimeBinding<'gemini_cli', 'provider_global'>;

class Scanner implements CredentialProfileScanner {
  readonly roots: string[] = [];
  readonly operations: ProviderConnectionOperation[] = [];
  files: readonly string[] = [];

  async listRelativeFileNames(
    root: string,
    requestedOperation: ProviderConnectionOperation,
  ): Promise<readonly string[]> {
    this.roots.push(root);
    this.operations.push(requestedOperation);
    return this.files;
  }
}

const safeEvidence = Object.freeze({
  backend: 'windows_credential_manager' as const,
  status: 'present' as const,
  resolvedProfilePath: null,
});

const codexProfile = 'R:\\profiles\\codex_cli';
const codexBinding = Object.freeze({
  providerId: 'codex_cli',
  canonicalLauncherPath: 'C:\\Users\\student\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe',
  canonicalEntryPath: null,
  canonicalPackageManifestPath: null,
  canonicalPlatformPackageManifestPath: null,
  fixedPrefixArgs: Object.freeze([]),
  version: parseSafeSemVer('0.146.0'),
  launcherSha256: 'a'.repeat(64),
  entrySha256: null,
  packageManifestSha256: null,
  platformPackageManifestSha256: null,
  bindingSha256: 'd'.repeat(64),
  recipeId: 'codex-0.146-profile-keyring-v2',
  credentialScope: 'profile_scoped',
  signerClassification: 'openai',
  checkedAt: '2026-09-02T00:00:00.000Z',
}) satisfies CliRuntimeBinding<'codex_cli', 'profile_scoped'>;

describe('CLI credential guard', () => {
  it('recursively scans managed-profile filenames without a content-read capability', async () => {
    const roots: string[] = [];
    const directories: CredentialProfileDirectoryReader = {
      list: async (root) => {
        roots.push(root);
        if (root === profile) {
          return Object.freeze([
            Object.freeze({ name: 'nested', kind: 'directory' as const }),
            Object.freeze({ name: 'settings.json', kind: 'file' as const }),
          ]);
        }
        return Object.freeze([Object.freeze({ name: 'policy.json', kind: 'file' as const })]);
      },
    };
    const reparseChecks: string[] = [];
    const scanner = createCredentialProfileScannerForTest({
      directories,
      files: {
        canonicalize: async (path) => path,
        assertNoReparsePoints: async (path) => {
          reparseChecks.push(path);
        },
        readFile: async () => {
          throw new Error('contents must never be read');
        },
        listChildren: async () => [],
      },
    });

    await expect(scanner.listRelativeFileNames(profile, operation)).resolves.toEqual([
      'settings.json',
      'nested\\policy.json',
    ]);
    expect(roots).toEqual([profile, `${profile}\\nested`]);
    expect(reparseChecks).toContain(`${profile}\\nested\\policy.json`);
  });

  it('returns only backend, scope, status, filenames, and provider-history evidence', async () => {
    const scanner = new Scanner();
    scanner.files = Object.freeze(['settings.json', 'policy.json']);
    const guard = createCliCredentialGuardForTest({ scanner });

    const evidence = await guard.inspect(
      {
        binding,
        managedProfilePath: profile,
        evidence: safeEvidence,
      },
      operation,
    );

    expect(evidence).toEqual({
      backend: 'windows_credential_manager',
      scope: 'provider_global',
      status: 'present',
      observedFileNames: ['settings.json', 'policy.json'],
      providerManagedHistory: false,
    });
    expect(scanner.roots).toEqual([profile]);
    expect(scanner.operations).toEqual([operation]);
    expect(JSON.stringify(evidence)).not.toMatch(/account|service|token|credentialValue/iu);
  });

  it.each([
    'R:\\profiles\\codex_cli',
    'R:\\profiles\\antigravity_cli',
    'R:\\profiles\\gemini_cli\\nested',
    'X:\\profiles\\gemini_cli',
    'R:/profiles/gemini_cli',
  ])(
    'rejects a managed profile path not exactly bound to Gemini: %s',
    async (managedProfilePath) => {
      const scanner = new Scanner();
      const guard = createCliCredentialGuardForTest({ scanner });
      let failure: unknown;

      try {
        await guard.inspect({ binding, managedProfilePath, evidence: safeEvidence }, operation);
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
      expect(failure instanceof Error ? failure.message : String(failure)).not.toContain(
        managedProfilePath,
      );
      expect(scanner.roots).toHaveLength(0);
    },
  );

  it('accepts the exact provider profile with Windows case-equivalent spelling', async () => {
    const scanner = new Scanner();
    const guard = createCliCredentialGuardForTest({ scanner });
    const caseEquivalentProfile = 'r:\\PROFILES\\GEMINI_CLI';

    await expect(
      guard.inspect(
        {
          binding,
          managedProfilePath: caseEquivalentProfile,
          evidence: safeEvidence,
        },
        operation,
      ),
    ).resolves.toMatchObject({ status: 'present' });
    expect(scanner.roots).toEqual([caseEquivalentProfile]);
  });

  it.each(['plaintext_file', 'unknown'] as const)(
    'fails closed for the %s credential backend without reading contents',
    async (backend) => {
      const scanner = new Scanner();
      const guard = createCliCredentialGuardForTest({ scanner });

      await expect(
        guard.inspect(
          {
            binding,
            managedProfilePath: profile,
            evidence: { ...safeEvidence, backend },
          },
          operation,
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    },
  );

  it.each(['oauth_creds.json', 'auth.json', 'credentials.json', 'refresh_token.txt'])(
    'rejects the anchored plaintext credential filename %s',
    async (fileName) => {
      const scanner = new Scanner();
      scanner.files = [fileName];
      const guard = createCliCredentialGuardForTest({ scanner });

      await expect(
        guard.inspect({ binding, managedProfilePath: profile, evidence: safeEvidence }, operation),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    },
  );

  it.each([
    'gemini-credentials.json',
    'Gemini-Credentials.JSON',
    'nested\\GeMiNi-CrEdEnTiAlS.JsOn',
    'nested\\oauth_creds.json',
    'nested\\OAUTH_CREDS.JSON',
  ])('rejects the Gemini fallback credential filename %s', async (fileName) => {
    const scanner = new Scanner();
    scanner.files = [fileName];
    const guard = createCliCredentialGuardForTest({ scanner });

    const failure = await guard
      .inspect({ binding, managedProfilePath: profile, evidence: safeEvidence }, operation)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(JSON.stringify(failure)).not.toContain(fileName);
    expect(String(failure)).not.toContain(fileName);
  });

  it.each(['session.json', 'session-2026.jsonl', 'history.sqlite'])(
    'reports residual data for the anchored session artifact %s',
    async (fileName) => {
      const scanner = new Scanner();
      scanner.files = [fileName];
      const guard = createCliCredentialGuardForTest({ scanner });

      await expect(
        guard.inspect({ binding, managedProfilePath: profile, evidence: safeEvidence }, operation),
      ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    },
  );

  it('rejects traversal and absolute filenames returned outside the managed profile', async () => {
    const scanner = new Scanner();
    scanner.files = ['..\\ordinary-profile\\settings.json'];
    const guard = createCliCredentialGuardForTest({ scanner });

    await expect(
      guard.inspect({ binding, managedProfilePath: profile, evidence: safeEvidence }, operation),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
  });

  it('requires Antigravity config evidence to resolve the aliased managed profile', async () => {
    const scanner = new Scanner();
    const guard = createCliCredentialGuardForTest({ scanner });
    const antigravityBinding = Object.freeze({
      ...binding,
      providerId: 'antigravity_cli' as const,
      canonicalLauncherPath: 'C:\\Users\\student\\AppData\\Local\\agy\\bin\\agy.exe',
      canonicalEntryPath: null,
      canonicalPackageManifestPath: null,
      fixedPrefixArgs: Object.freeze([]),
      version: parseSafeSemVer('1.1.16'),
      entrySha256: null,
      packageManifestSha256: null,
      recipeId: 'antigravity-1.1-stream-json-v1',
      signerClassification: 'google' as const,
    }) satisfies CliRuntimeBinding<'antigravity_cli', 'provider_global'>;

    await expect(
      guard.inspect(
        {
          binding: antigravityBinding,
          managedProfilePath: 'R:\\profiles\\antigravity_cli',
          evidence: {
            ...safeEvidence,
            resolvedProfilePath: 'C:\\Users\\student\\.agy',
          },
        },
        operation,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });

    await expect(
      guard.inspect(
        {
          binding: antigravityBinding,
          managedProfilePath: 'R:\\profiles\\antigravity_cli',
          evidence: {
            ...safeEvidence,
            resolvedProfilePath: 'R:\\profiles\\antigravity_cli',
          },
        },
        operation,
      ),
    ).resolves.toMatchObject({ providerManagedHistory: true });
  });

  it('fails closed when recipe scope metadata is unknown or conflicts with the binding', async () => {
    const scanner = new Scanner();
    const guard = createCliCredentialGuardForTest({ scanner });

    await expect(
      guard.inspect(
        {
          binding: Object.freeze({ ...binding, recipeId: 'unreviewed-recipe' }),
          managedProfilePath: profile,
          evidence: safeEvidence,
        },
        operation,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(CLI_CREDENTIAL_SCOPE_BY_RECIPE).toEqual({
      'antigravity-1.1-stream-json-v1': 'provider_global',
      'gemini-0.55-policy-json-v1': 'provider_global',
      'codex-0.146-profile-keyring-v2': 'profile_scoped',
    });
  });

  it('accepts only the reviewed profile-scoped Codex recipe for its own managed profile', async () => {
    const scanner = new Scanner();
    const guard = createCliCredentialGuardForTest({ scanner });

    await expect(
      guard.inspect(
        {
          binding: codexBinding,
          managedProfilePath: codexProfile,
          evidence: safeEvidence,
        },
        operation,
      ),
    ).resolves.toMatchObject({
      backend: 'windows_credential_manager',
      scope: 'profile_scoped',
      status: 'present',
      providerManagedHistory: false,
    });
    await expect(
      guard.inspect(
        {
          binding: Object.freeze({
            ...codexBinding,
            credentialScope: 'provider_global',
          }) as never,
          managedProfilePath: codexProfile,
          evidence: safeEvidence,
        },
        operation,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
  });

  it('rejects credential evidence carrying service, account, or value fields', async () => {
    const scanner = new Scanner();
    const guard = createCliCredentialGuardForTest({ scanner });

    await expect(
      guard.inspect(
        {
          binding,
          managedProfilePath: profile,
          evidence: { ...safeEvidence, accountName: 'private@example.test' } as never,
        },
        operation,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(scanner.roots).toHaveLength(0);
  });
});
