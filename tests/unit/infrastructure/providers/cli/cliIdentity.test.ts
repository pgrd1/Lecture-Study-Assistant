import { describe, expect, it } from 'vitest';
import type {
  CliCredentialScopeFor,
  CliRuntimeBinding,
} from '../../../../../src/core/ports/aiProvider';
import {
  assertBindingShape,
  bindingHash,
  createBinding,
  SUPPORTED_CLI_RECIPES,
} from '../../../../../src/infrastructure/providers/cli/cliIdentity';

const codexCapture = Object.freeze({
  providerId: 'codex_cli' as const,
  kind: 'codex_native' as const,
  canonicalLauncherPath: 'C:\\Users\\student\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe',
  canonicalEntryPath: null,
  canonicalPackageManifestPath: null,
  canonicalPlatformPackageManifestPath: null,
  fixedPrefixArgs: Object.freeze([]),
  launcherSha256: 'a'.repeat(64),
  entrySha256: null,
  packageManifestSha256: null,
  platformPackageManifestSha256: null,
  signerClassification: 'openai' as const,
  packageVersion: null,
});

describe('CLI identity', () => {
  it('maps reviewed recipes to exact credential scopes', () => {
    expect(SUPPORTED_CLI_RECIPES.codex_cli).toMatchObject({
      recipeId: 'codex-0.146-profile-keyring-v2',
      credentialScope: 'profile_scoped',
    });

    const codexScope: CliCredentialScopeFor<'codex_cli'> = 'profile_scoped';
    const geminiScope: CliCredentialScopeFor<'gemini_cli'> = 'provider_global';
    expect([codexScope, geminiScope]).toEqual(['profile_scoped', 'provider_global']);
  });

  it('creates a profile-scoped Codex binding and rejects provider-global drift', () => {
    const binding = createBinding(codexCapture, '0.146.0', '2026-09-03T00:00:00.000Z');

    expect(binding).toMatchObject({
      providerId: 'codex_cli',
      recipeId: 'codex-0.146-profile-keyring-v2',
      credentialScope: 'profile_scoped',
    });

    const profileIdentity = {
      providerId: 'codex_cli' as const,
      version: '0.146.0',
      recipeId: 'codex-0.146-profile-keyring-v2',
      credentialScope: 'profile_scoped' as const,
      signerClassification: 'openai' as const,
      launcherSha256: 'a'.repeat(64),
      entrySha256: null,
      packageManifestSha256: null,
      platformPackageManifestSha256: null,
    };
    expect(binding.bindingSha256).toBe(bindingHash(profileIdentity));
    expect(() =>
      createBinding(
        Object.freeze({
          ...codexCapture,
          signerClassification: 'openai',
        }),
        '0.146.0',
        'not-a-date',
      ),
    ).toThrow();

    const forged = Object.freeze({
      ...binding,
      credentialScope: 'provider_global',
      bindingSha256: bindingHash({ ...profileIdentity, credentialScope: 'provider_global' }),
    }) as unknown as CliRuntimeBinding;
    expect(forged.credentialScope).toBe('provider_global');
    expect(() => assertBindingShape(forged)).toThrow();
  });
});
