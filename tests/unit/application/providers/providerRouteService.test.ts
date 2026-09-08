import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderRouteService } from '../../../../src/application/providers/providerRouteService';
import type { ProviderDiagnostic } from '../../../../src/core/ports/aiProvider';
import { createRepositories, openDatabase } from '../../../../src/infrastructure/db/sqliteDatabase';
import {
  AI_FEATURES,
  ANTIGRAVITY_HISTORY_NOTICE_VERSION,
  parseSafeSemVer,
  SHARED_CREDENTIAL_NOTICE_VERSION,
} from '../../../../src/shared/contracts/provider';

const NOW = '2026-09-02T01:02:03.000Z';

const apiDiagnostic = (overrides: Partial<ProviderDiagnostic> = {}): ProviderDiagnostic =>
  Object.freeze({
    providerId: 'openai_api',
    status: 'ready',
    version: null,
    selectedModelId: 'gpt-5.5',
    reportedModelId: 'gpt-5.5-2026-08-01',
    credentialPresent: true,
    credentialScope: 'not_applicable',
    sharedCredentialConsentAt: null,
    sharedCredentialConsentVersion: null,
    cliBinding: null,
    providerManagedHistory: false,
    checkedAt: NOW,
    latencyMs: 10,
    errorCode: null,
    revision: 0,
    ...overrides,
  } as ProviderDiagnostic);

const antigravityDiagnostic = (): ProviderDiagnostic =>
  Object.freeze({
    providerId: 'antigravity_cli',
    status: 'ready',
    version: parseSafeSemVer('1.1.0'),
    selectedModelId: null,
    reportedModelId: null,
    credentialPresent: true,
    credentialScope: 'provider_global',
    sharedCredentialConsentAt: NOW,
    sharedCredentialConsentVersion: SHARED_CREDENTIAL_NOTICE_VERSION,
    cliBinding: Object.freeze({
      providerId: 'antigravity_cli',
      canonicalLauncherPath: 'C:\\private\\antigravity.exe',
      canonicalEntryPath: null,
      canonicalPackageManifestPath: null,
      canonicalPlatformPackageManifestPath: null,
      fixedPrefixArgs: Object.freeze([]),
      version: parseSafeSemVer('1.1.0'),
      launcherSha256: 'a'.repeat(64),
      entrySha256: null,
      packageManifestSha256: null,
      platformPackageManifestSha256: null,
      bindingSha256: 'b'.repeat(64),
      recipeId: 'antigravity-1.1-stream-json-v1',
      credentialScope: 'provider_global',
      signerClassification: 'google',
      checkedAt: NOW,
    }),
    providerManagedHistory: true,
    checkedAt: NOW,
    latencyMs: 8,
    errorCode: null,
    revision: 0,
  });

const withService = <T>(
  run: (context: {
    service: ProviderRouteService;
    repositories: ReturnType<typeof createRepositories>;
  }) => T,
): T => {
  const directory = mkdtempSync(join(tmpdir(), 'lecture-study-assistant-route-'));
  const database = openDatabase(join(directory, 'study.sqlite3'));
  try {
    const repositories = createRepositories(database);
    return run({
      service: new ProviderRouteService({
        routes: repositories.providerRoutes,
        diagnostics: repositories.providerDiagnostics,
        clock: () => NOW,
      }),
      repositories,
    });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('ProviderRouteService', () => {
  // Production break caught: listing routes returns an incomplete or mutable settings snapshot.
  it('lists all frozen route snapshots', () => {
    withService(({ service }) => {
      const routes = service.list();
      expect(routes).toHaveLength(AI_FEATURES.length);
      expect(Object.isFrozen(routes)).toBe(true);
      expect(routes.every(Object.isFrozen)).toBe(true);
    });
  });

  // Production break caught: a missing diagnostic is silently treated as configured.
  it('requires explicit confirmation before saving a route whose provider is not configured', () => {
    withService(({ service }) => {
      expect(() =>
        service.update({
          feature: 'lecture_organize',
          providerId: 'openai_api',
          modelId: 'gpt-5.5',
          enabled: true,
          expectedRevision: 0,
          confirmNotReady: false,
          confirmProviderManagedHistory: false,
        }),
      ).toThrowError('PROVIDER_NOT_CONFIGURED');
    });
  });

  // Production break caught: a non-ready diagnostic bypasses the explicit warning gate.
  it('requires explicit confirmation before saving a route whose provider is not ready', () => {
    withService(({ service, repositories }) => {
      repositories.providerDiagnostics.upsert(
        apiDiagnostic({ status: 'missing_credential', credentialPresent: false }),
        null,
      );
      expect(() =>
        service.update({
          feature: 'lecture_organize',
          providerId: 'openai_api',
          modelId: 'gpt-5.5',
          enabled: true,
          expectedRevision: 0,
          confirmNotReady: false,
          confirmProviderManagedHistory: false,
        }),
      ).toThrowError('PROVIDER_NOT_READY');
    });
  });

  // Production break caught: route updates rewrite the locked prompt version or skip optimistic revisioning.
  it('saves a confirmed route while preserving its prompt version and incrementing its revision', () => {
    withService(({ service, repositories }) => {
      repositories.providerDiagnostics.upsert(apiDiagnostic(), null);
      const saved = service.update({
        feature: 'lecture_organize',
        providerId: 'openai_api',
        modelId: 'gpt-5.5',
        enabled: true,
        expectedRevision: 0,
        confirmNotReady: false,
        confirmProviderManagedHistory: false,
      });
      expect(saved).toMatchObject({
        promptVersion: 'lecture-organize-v1',
        updatedAt: NOW,
        revision: 1,
      });
      expect(Object.isFrozen(saved)).toBe(true);
    });
  });

  // Production break caught: enabling Antigravity can persist without current provider-history consent.
  it('requires and records current Antigravity provider-managed-history consent', () => {
    withService(({ service, repositories }) => {
      repositories.providerDiagnostics.upsert(antigravityDiagnostic(), null);
      const input = {
        feature: 'lecture_organize' as const,
        providerId: 'antigravity_cli' as const,
        modelId: null,
        enabled: true,
        expectedRevision: 0,
        confirmNotReady: false,
        confirmProviderManagedHistory: false,
      };
      expect(() => service.update(input)).toThrowError('PROVIDER_DATA_RETENTION_CONSENT_REQUIRED');
      expect(service.update({ ...input, confirmProviderManagedHistory: true })).toMatchObject({
        providerManagedHistoryConsentAt: NOW,
        providerManagedHistoryConsentVersion: ANTIGRAVITY_HISTORY_NOTICE_VERSION,
      });
    });
  });

  // Production break caught: an unchanged Antigravity route unnecessarily discards valid current consent.
  it('preserves current Antigravity consent without requiring confirmation again', () => {
    withService(({ service, repositories }) => {
      repositories.providerDiagnostics.upsert(antigravityDiagnostic(), null);
      const first = service.update({
        feature: 'lecture_organize',
        providerId: 'antigravity_cli',
        modelId: null,
        enabled: true,
        expectedRevision: 0,
        confirmNotReady: false,
        confirmProviderManagedHistory: true,
      });
      const second = service.update({
        feature: 'lecture_organize',
        providerId: 'antigravity_cli',
        modelId: null,
        enabled: true,
        expectedRevision: 1,
        confirmNotReady: false,
        confirmProviderManagedHistory: false,
      });
      expect(second.providerManagedHistoryConsentAt).toBe(first.providerManagedHistoryConsentAt);
    });
  });

  // Production break caught: provider-history consent leaks onto a non-Antigravity route.
  it('clears Antigravity consent when selecting another provider', () => {
    withService(({ service, repositories }) => {
      repositories.providerDiagnostics.upsert(antigravityDiagnostic(), null);
      repositories.providerDiagnostics.upsert(apiDiagnostic(), null);
      service.update({
        feature: 'lecture_organize',
        providerId: 'antigravity_cli',
        modelId: null,
        enabled: true,
        expectedRevision: 0,
        confirmNotReady: false,
        confirmProviderManagedHistory: true,
      });
      expect(
        service.update({
          feature: 'lecture_organize',
          providerId: 'openai_api',
          modelId: 'gpt-5.5',
          enabled: true,
          expectedRevision: 1,
          confirmNotReady: false,
          confirmProviderManagedHistory: false,
        }),
      ).toMatchObject({
        providerManagedHistoryConsentAt: null,
        providerManagedHistoryConsentVersion: null,
      });
    });
  });

  // Production break caught: disabling still requires a provider or leaves a stale model behind.
  it('allows a disabled route to clear its provider and model', () => {
    withService(({ service }) => {
      expect(
        service.update({
          feature: 'lecture_verify',
          providerId: null,
          modelId: null,
          enabled: false,
          expectedRevision: 0,
          confirmNotReady: false,
          confirmProviderManagedHistory: false,
        }),
      ).toMatchObject({ providerId: null, modelId: null, enabled: false, revision: 1 });
    });
  });

  // Production break caught: stale settings overwrite a newer route revision.
  it('preserves repository optimistic concurrency failures', () => {
    withService(({ service, repositories }) => {
      repositories.providerDiagnostics.upsert(apiDiagnostic(), null);
      const input = {
        feature: 'lecture_organize' as const,
        providerId: 'openai_api' as const,
        modelId: 'gpt-5.5',
        enabled: true,
        expectedRevision: 0,
        confirmNotReady: false,
        confirmProviderManagedHistory: false,
      };
      service.update(input);
      expect(() => service.update(input)).toThrowError('STALE_WRITE');
    });
  });

  // Production break caught: malformed boundary input leaks a validator error instead of the fixed AppError.
  it('normalizes malformed save requests to INVALID_INPUT', () => {
    withService(({ service }) => {
      expect(() =>
        service.update({
          feature: 'lecture_organize',
          providerId: null,
          modelId: MODEL_FOR_INVALID_INPUT,
          enabled: true,
          expectedRevision: 0,
          confirmNotReady: false,
          confirmProviderManagedHistory: false,
        }),
      ).toThrowError('INVALID_INPUT');
    });
  });
});

const MODEL_FOR_INVALID_INPUT = 'gpt-5.5';
