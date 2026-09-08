import type { ProviderDiagnostic } from '../../src/core/ports/aiProvider';
import { parseSafeSemVer } from '../../src/shared/contracts/provider';

/** Offline diagnostic fixture; no installation, inspection or provider probe. */
export const readyCodexDiagnostic = (): ProviderDiagnostic => {
  const version = parseSafeSemVer('0.146.0');
  const checkedAt = '2026-09-07T00:00:00.000Z';
  return {
    providerId: 'codex_cli',
    status: 'ready',
    version,
    selectedModelId: null,
    reportedModelId: null,
    credentialPresent: true,
    credentialScope: 'profile_scoped',
    sharedCredentialConsentAt: null,
    sharedCredentialConsentVersion: null,
    cliBinding: {
      providerId: 'codex_cli',
      canonicalLauncherPath: 'C:\\test-only\\codex.exe',
      canonicalEntryPath: null,
      canonicalPackageManifestPath: null,
      canonicalPlatformPackageManifestPath: null,
      fixedPrefixArgs: [],
      version,
      launcherSha256: 'a'.repeat(64),
      entrySha256: null,
      packageManifestSha256: null,
      platformPackageManifestSha256: null,
      bindingSha256: 'b'.repeat(64),
      recipeId: 'codex-0.146-profile-keyring-v2',
      credentialScope: 'profile_scoped',
      signerClassification: 'openai',
      checkedAt,
    },
    providerManagedHistory: false,
    checkedAt,
    latencyMs: 1,
    errorCode: null,
    revision: 0,
  };
};
