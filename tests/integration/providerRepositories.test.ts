import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ProviderDiagnostic } from '../../src/core/ports/aiProvider';
import { applyMigrations, SQLITE_MIGRATIONS } from '../../src/infrastructure/db/migrations';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import {
  AI_FEATURES,
  DEFAULT_PROMPT_VERSION_BY_FEATURE,
  parseSafeSemVer,
  SHARED_CREDENTIAL_NOTICE_VERSION,
  TRUSTED_CLI_BINDING_RECIPES,
  toPublicProviderDiagnostic,
} from '../../src/shared/contracts/provider';
import type { ProviderInvocation } from '../../src/shared/contracts/providerInvocation';
import { courseFixture } from '../testkit/fixtures';
import { withTempDirectory } from '../testkit/tempDirectory';

const NOW = '2026-09-02T00:00:00.000Z';
const LATER = '2026-09-02T00:01:00.000Z';

it('migration 6 preserves selected routes and retry references while adding disabled features', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(
      database,
      SQLITE_MIGRATIONS.filter((m) => m.version <= 5),
    );
    database
      .prepare(
        "UPDATE provider_routes SET model_id = 'custom-model', prompt_version = 'custom-v9', enabled = 1, provider_managed_history_consent_at = ?, provider_managed_history_consent_version = 'antigravity-history-v1', revision = 9 WHERE feature = 'lecture_organize'",
      )
      .run(NOW);
    const before = database.prepare('SELECT * FROM provider_routes ORDER BY feature').all();
    const insertInvocation = database.prepare(
      "INSERT INTO provider_invocations (id, request_id, feature, provider_id, prompt_version, output_schema_id, route_revision, request_sha256, status, attempt_kind, retry_of, started_at, revision) VALUES (?, ?, 'lecture_organize', 'openai_api', 'custom-v1', 'lecture_output', 3, ?, 'running', ?, ?, ?, 0)",
    );
    const originalId = randomUUID();
    const retryId = randomUUID();
    insertInvocation.run(originalId, randomUUID(), 'a'.repeat(64), 'initial', null, NOW);
    insertInvocation.run(retryId, randomUUID(), 'b'.repeat(64), 'transient_retry', originalId, NOW);
    const invocationsBefore = database
      .prepare('SELECT * FROM provider_invocations ORDER BY id')
      .all();
    applyMigrations(database);
    expect(database.prepare('SELECT * FROM provider_invocations ORDER BY id').all()).toEqual(
      invocationsBefore,
    );
    database
      .prepare("UPDATE provider_invocations SET feature = 'audio_transcription' WHERE id = ?")
      .run(retryId);
    expect(() =>
      database
        .prepare("UPDATE provider_invocations SET feature = 'unknown' WHERE id = ?")
        .run(retryId),
    ).toThrow();
    expect(
      database
        .prepare(
          "SELECT * FROM provider_routes WHERE feature IN ('lecture_organize','lecture_verify','professor_profile','exam_synthesis','question_generation','answer_verification','grading_feedback') ORDER BY feature",
        )
        .all(),
    ).toEqual(before);
    expect(database.prepare('SELECT feature FROM provider_routes').all()).toHaveLength(
      AI_FEATURES.length,
    );
    expect(
      database
        .prepare(
          "SELECT provider_id, model_id, enabled, revision FROM provider_routes WHERE feature = 'audio_transcription'",
        )
        .get(),
    ).toEqual({ provider_id: null, model_id: null, enabled: 0, revision: 0 });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    applyMigrations(database);
    expect(database.prepare('SELECT feature FROM provider_routes').all()).toHaveLength(
      AI_FEATURES.length,
    );
  } finally {
    database.close();
  }
});

const runningInvocation = (overrides: Partial<ProviderInvocation> = {}): ProviderInvocation =>
  Object.freeze({
    id: randomUUID(),
    requestId: randomUUID(),
    jobId: null,
    feature: 'lecture_organize',
    providerId: 'openai_api',
    selectedModelId: 'gpt-5.5',
    reportedModelId: null,
    promptVersion: 'lecture-organize-v1',
    outputSchemaId: 'lecture_output',
    routeRevision: 0,
    requestSha256: 'a'.repeat(64),
    responseSha256: null,
    status: 'running',
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    latencyMs: null,
    retryOf: null,
    attemptKind: 'initial',
    errorCode: null,
    startedAt: NOW,
    completedAt: null,
    revision: 0,
    ...overrides,
  });

const apiDiagnostic = (overrides: Partial<ProviderDiagnostic> = {}): ProviderDiagnostic =>
  Object.freeze({
    providerId: 'openai_api',
    status: 'ready',
    version: null,
    selectedModelId: 'gpt-5.5',
    reportedModelId: 'gpt-5.5',
    credentialPresent: true,
    credentialScope: 'not_applicable',
    sharedCredentialConsentAt: null,
    sharedCredentialConsentVersion: null,
    cliBinding: null,
    providerManagedHistory: false,
    checkedAt: NOW,
    latencyMs: 4,
    errorCode: null,
    revision: 0,
    ...overrides,
  } as ProviderDiagnostic);

type ProviderGlobalCodexDiagnostic = Extract<
  ProviderDiagnostic,
  Readonly<{ providerId: 'codex_cli'; credentialScope: 'profile_scoped' }>
>;

const providerGlobalCliDiagnostic = (
  overrides: Partial<ProviderGlobalCodexDiagnostic> = {},
): ProviderGlobalCodexDiagnostic =>
  Object.freeze({
    providerId: 'codex_cli',
    status: 'ready',
    version: parseSafeSemVer('0.146.0'),
    selectedModelId: null,
    reportedModelId: null,
    credentialPresent: true,
    credentialScope: 'profile_scoped',
    sharedCredentialConsentAt: null,
    sharedCredentialConsentVersion: null,
    cliBinding: Object.freeze({
      providerId: 'codex_cli',
      canonicalLauncherPath: 'C:\\private\\codex.exe',
      canonicalEntryPath: null,
      canonicalPackageManifestPath: null,
      canonicalPlatformPackageManifestPath: null,
      fixedPrefixArgs: Object.freeze([]),
      version: parseSafeSemVer('0.146.0'),
      launcherSha256: 'c'.repeat(64),
      entrySha256: null,
      packageManifestSha256: null,
      platformPackageManifestSha256: null,
      bindingSha256: 'd'.repeat(64),
      recipeId: 'codex-0.146-profile-keyring-v2',
      credentialScope: 'profile_scoped',
      signerClassification: 'openai',
      checkedAt: NOW,
    }),
    providerManagedHistory: false,
    checkedAt: NOW,
    latencyMs: null,
    errorCode: null,
    revision: 0,
    ...overrides,
  } as ProviderGlobalCodexDiagnostic);

const providerGlobalCliBinding = (): NonNullable<ProviderGlobalCodexDiagnostic['cliBinding']> => {
  const binding = providerGlobalCliDiagnostic().cliBinding;
  if (binding === null) {
    throw new TypeError('MISSING_TEST_CLI_BINDING');
  }
  return binding;
};

const providerGlobalCodexNpmDiagnostic = (): ProviderGlobalCodexDiagnostic => {
  const diagnostic = providerGlobalCliDiagnostic();
  const binding = providerGlobalCliBinding();
  const entry = 'C:\\private\\node_modules\\@openai\\codex\\bin\\codex.js';
  return Object.freeze({
    ...diagnostic,
    cliBinding: Object.freeze({
      ...binding,
      canonicalLauncherPath:
        'C:\\private\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe',
      canonicalEntryPath: entry,
      canonicalPackageManifestPath: 'C:\\private\\node_modules\\@openai\\codex\\package.json',
      canonicalPlatformPackageManifestPath:
        'C:\\private\\node_modules\\@openai\\codex-win32-x64\\package.json',
      fixedPrefixArgs: Object.freeze([]),
      entrySha256: 'e'.repeat(64),
      packageManifestSha256: 'f'.repeat(64),
      platformPackageManifestSha256: '1'.repeat(64),
      bindingSha256: '2'.repeat(64),
    }),
  });
};

describe('provider SQLite repositories', () => {
  it('defines only production recipes with launcher-prefix semantics', () => {
    expect(TRUSTED_CLI_BINDING_RECIPES).toEqual({
      antigravity_cli: {
        recipeId: 'antigravity-1.1-stream-json-v1',
        launcherPrefix: 'none',
      },
      gemini_cli: {
        recipeId: 'gemini-0.55-policy-json-v1',
        launcherPrefix: 'canonical_entry_path',
      },
      codex_cli: {
        recipeId: 'codex-0.146-profile-keyring-v2',
        launcherPrefix: 'none',
      },
    });
  });

  it('upgrades a real v1 database without losing existing rows and seeds exact routes', async () => {
    await withTempDirectory((directory) => {
      const path = join(directory, 'study.sqlite3');
      const v1 = new DatabaseSync(path);
      const course = courseFixture();
      try {
        applyMigrations(v1, SQLITE_MIGRATIONS.slice(0, 1), NOW);
        v1.prepare(
          `INSERT INTO courses (
            id, name, professor_name, folder_name, user_instructions, archived, created_at,
            updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          course.id,
          course.name,
          course.professorName,
          course.folderName,
          course.userInstructions,
          0,
          course.createdAt,
          course.updatedAt,
          course.revision,
        );
      } finally {
        v1.close();
      }

      const database = openDatabase(path);
      try {
        const repositories = createRepositories(database);
        expect(database.getSchemaVersion()).toBe(10);
        expect(repositories.courses.get(course.id)).toEqual(course);
        expect(repositories.providerRoutes.list()).toEqual(
          AI_FEATURES.map((feature) =>
            expect.objectContaining({
              feature,
              providerId: [
                'lecture_organize',
                'professor_profile',
                'exam_synthesis',
                'question_generation',
                'grading_feedback',
              ].includes(feature)
                ? 'antigravity_cli'
                : null,
              modelId: null,
              promptVersion: DEFAULT_PROMPT_VERSION_BY_FEATURE[feature],
              enabled: false,
              providerManagedHistoryConsentAt: null,
              providerManagedHistoryConsentVersion: null,
              updatedAt: '1970-01-01T00:00:00.000Z',
              revision: 0,
            }),
          ),
        );
      } finally {
        database.close();
      }
    });
  });

  it('migrates v2 CLI bindings to fail-closed reinspection while preserving API rows', async () => {
    await withTempDirectory((directory) => {
      const path = join(directory, 'study.sqlite3');
      const v2 = new DatabaseSync(path);
      try {
        applyMigrations(v2, SQLITE_MIGRATIONS.slice(0, 2), NOW);
        v2.prepare(
          `INSERT INTO provider_diagnostics (
            provider_id, status, version, selected_model_id, reported_model_id,
            credential_present, credential_scope, shared_credential_consent_at,
            shared_credential_consent_version, provider_managed_history, executable_path,
            entry_path, executable_sha256, entry_sha256, package_manifest_path,
            package_manifest_sha256, binding_sha256, recipe_id, signer_classification,
            fixed_prefix_args_json, checked_at, latency_ms, error_code, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'codex_cli',
          'ready',
          '0.146.0',
          null,
          'gpt-5.5',
          1,
          'provider_global',
          NOW,
          SHARED_CREDENTIAL_NOTICE_VERSION,
          0,
          'C:\\private\\codex.exe',
          null,
          'a'.repeat(64),
          null,
          null,
          null,
          'b'.repeat(64),
          'codex-0.146-exec-json-v1',
          'openai',
          '[]',
          NOW,
          3,
          null,
          7,
        );
        v2.prepare(
          `INSERT INTO provider_diagnostics (
            provider_id, status, version, selected_model_id, reported_model_id,
            credential_present, credential_scope, shared_credential_consent_at,
            shared_credential_consent_version, provider_managed_history, checked_at,
            latency_ms, error_code, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'openai_api',
          'ready',
          null,
          'gpt-5.5',
          'gpt-5.5',
          1,
          'not_applicable',
          null,
          null,
          0,
          NOW,
          4,
          null,
          5,
        );
      } finally {
        v2.close();
      }

      const database = openDatabase(path);
      try {
        const diagnostics = createRepositories(database).providerDiagnostics;
        expect(database.getSchemaVersion()).toBe(10);
        expect(diagnostics.get('codex_cli')).toEqual({
          providerId: 'codex_cli',
          status: 'not_checked',
          version: null,
          selectedModelId: null,
          reportedModelId: null,
          credentialPresent: false,
          credentialScope: 'unknown',
          sharedCredentialConsentAt: null,
          sharedCredentialConsentVersion: null,
          cliBinding: null,
          providerManagedHistory: false,
          checkedAt: null,
          latencyMs: null,
          errorCode: null,
          revision: 8,
        });
        expect(diagnostics.get('openai_api')).toEqual(apiDiagnostic({ revision: 5 }));
      } finally {
        database.close();
      }
    });
  });

  it('migrates v3 diagnostics to nullable checkedAt and invalidates the superseded Codex recipe only', async () => {
    await withTempDirectory((directory) => {
      const path = join(directory, 'study.sqlite3');
      const v3 = new DatabaseSync(path);
      try {
        applyMigrations(v3, SQLITE_MIGRATIONS.slice(0, 3), NOW);
        v3.prepare(
          `INSERT INTO provider_diagnostics (
            provider_id, status, version, selected_model_id, reported_model_id,
            credential_present, credential_scope, shared_credential_consent_at,
            shared_credential_consent_version, provider_managed_history, executable_path,
            entry_path, executable_sha256, entry_sha256, package_manifest_path,
            package_manifest_sha256, platform_package_manifest_path,
            platform_package_manifest_sha256, binding_sha256, recipe_id, signer_classification,
            fixed_prefix_args_json, checked_at, latency_ms, error_code, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'codex_cli',
          'ready',
          '0.146.0',
          null,
          'gpt-5.5',
          1,
          'provider_global',
          NOW,
          SHARED_CREDENTIAL_NOTICE_VERSION,
          0,
          'C:\\private\\codex.exe',
          null,
          'a'.repeat(64),
          null,
          null,
          null,
          null,
          null,
          'b'.repeat(64),
          'codex-0.146-exec-json-v1',
          'openai',
          '[]',
          NOW,
          9,
          null,
          2,
        );
        v3.prepare(
          `INSERT INTO provider_diagnostics (
            provider_id, status, version, selected_model_id, reported_model_id,
            credential_present, credential_scope, shared_credential_consent_at,
            shared_credential_consent_version, provider_managed_history, checked_at,
            latency_ms, error_code, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'gemini_api',
          'not_checked',
          null,
          null,
          null,
          0,
          'not_applicable',
          null,
          null,
          0,
          NOW,
          null,
          null,
          4,
        );
        v3.prepare(
          `INSERT INTO provider_diagnostics (
            provider_id, status, version, selected_model_id, reported_model_id,
            credential_present, credential_scope, shared_credential_consent_at,
            shared_credential_consent_version, provider_managed_history, checked_at,
            latency_ms, error_code, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'openai_api',
          'ready',
          null,
          'gpt-5.5',
          'gpt-5.5',
          1,
          'not_applicable',
          null,
          null,
          0,
          NOW,
          4,
          null,
          5,
        );
      } finally {
        v3.close();
      }

      const database = openDatabase(path);
      try {
        expect(database.getSchemaVersion()).toBe(10);
        const checkedAtColumn = database
          .prepare('PRAGMA table_info(provider_diagnostics)')
          .all()
          .find((column) => (column as { name: string }).name === 'checked_at') as
          | { notnull: number }
          | undefined;
        expect(checkedAtColumn?.notnull).toBe(0);

        const diagnostics = createRepositories(database).providerDiagnostics;
        expect(diagnostics.get('codex_cli')).toEqual({
          providerId: 'codex_cli',
          status: 'not_checked',
          version: null,
          selectedModelId: null,
          reportedModelId: null,
          credentialPresent: false,
          credentialScope: 'unknown',
          sharedCredentialConsentAt: null,
          sharedCredentialConsentVersion: null,
          cliBinding: null,
          providerManagedHistory: false,
          checkedAt: null,
          latencyMs: null,
          errorCode: null,
          revision: 3,
        });
        expect(diagnostics.get('gemini_api')).toEqual(
          apiDiagnostic({
            providerId: 'gemini_api',
            status: 'not_checked',
            selectedModelId: null,
            reportedModelId: null,
            credentialPresent: false,
            checkedAt: null,
            latencyMs: null,
            revision: 4,
          }),
        );
        expect(diagnostics.get('openai_api')).toEqual(apiDiagnostic({ revision: 5 }));
      } finally {
        database.close();
      }
    });
  });

  it('round-trips all three private Codex npm manifest components in schema v3', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const diagnostics = createRepositories(database).providerDiagnostics;
        const expected = providerGlobalCodexNpmDiagnostic();

        expect(diagnostics.upsert(expected, null)).toEqual(expected);
        expect(diagnostics.get('codex_cli')).toEqual(expected);
        expect(() =>
          database
            .prepare(
              'UPDATE provider_diagnostics SET platform_package_manifest_sha256 = NULL WHERE provider_id = ?',
            )
            .run('codex_cli'),
        ).toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('persists content-free invocation metadata, enforces revisions, and recovers interruption', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repositories = createRepositories(database);
        const created = repositories.providerInvocations.create(runningInvocation());
        expect(created.requestSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(Object.keys(created)).not.toContain('prompt');
        expect(Object.keys(created)).not.toContain('response');
        expect(Object.isFrozen(created)).toBe(true);

        expect(repositories.providerInvocations.recoverInterrupted(LATER)).toBe(1);
        expect(repositories.providerInvocations.get(created.id)).toEqual({
          ...created,
          status: 'failed',
          errorCode: 'PROVIDER_EXECUTION_FAILED',
          completedAt: LATER,
          revision: 1,
        });

        const retry = repositories.providerInvocations.create(
          runningInvocation({ retryOf: created.id, attemptKind: 'transient_retry' }),
        );
        const completed = repositories.providerInvocations.complete(retry.id, 0, {
          status: 'completed',
          reportedModelId: 'gpt-5.5',
          responseSha256: 'b'.repeat(64),
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          latencyMs: 4,
          completedAt: LATER,
          errorCode: null,
        });
        expect(completed.status).toBe('completed');
        expect(repositories.providerInvocations.get(retry.id)).toMatchObject({
          jobId: null,
          retryOf: created.id,
          attemptKind: 'transient_retry',
        });
        database
          .prepare('UPDATE provider_invocations SET output_schema_id = ? WHERE id = ?')
          .run('unsafe schema id', retry.id);
        expect(() => repositories.providerInvocations.get(retry.id)).toThrow('DATABASE_ERROR');
        expect(() =>
          repositories.providerInvocations.complete(retry.id, 0, {
            status: 'failed',
            reportedModelId: null,
            responseSha256: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            latencyMs: 1,
            completedAt: LATER,
            errorCode: 'PROVIDER_EXECUTION_FAILED',
          }),
        ).toThrow('STALE_WRITE');
      } finally {
        database.close();
      }
    });
  });

  it('marks running invocations cancelled during graceful shutdown', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const invocations = createRepositories(database).providerInvocations;
        const running = invocations.create(runningInvocation());

        expect(invocations.cancelRunningForShutdown(LATER)).toBe(1);
        expect(invocations.get(running.id)).toEqual({
          ...running,
          status: 'cancelled',
          errorCode: 'PROVIDER_CANCELLED',
          completedAt: LATER,
          revision: 1,
        });
        expect(invocations.cancelRunningForShutdown(LATER)).toBe(0);
      } finally {
        database.close();
      }
    });
  });

  it('persists validated diagnostic replacements and redacts private executable binding paths', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repositories = createRepositories(database);
        const inserted = repositories.providerDiagnostics.upsert(apiDiagnostic(), null);
        expect(Object.isFrozen(inserted)).toBe(true);
        expect(inserted.credentialScope).toBe('not_applicable');
        expect(repositories.providerDiagnostics.get('openai_api')).toEqual(inserted);

        const updated = repositories.providerDiagnostics.upsert(
          apiDiagnostic({ latencyMs: 8, revision: 1 }),
          0,
        );
        expect(updated.latencyMs).toBe(8);
        expect(() => repositories.providerDiagnostics.upsert(updated, 0)).toThrow('STALE_WRITE');

        const cli = repositories.providerDiagnostics.upsert(providerGlobalCliDiagnostic(), null);
        const publicDiagnostic = toPublicProviderDiagnostic(cli);
        expect(publicDiagnostic).toMatchObject({
          providerId: 'codex_cli',
          credentialScope: 'profile_scoped',
          bindingSha256: 'd'.repeat(64),
        });
        for (const forbiddenKey of [
          'canonicalLauncherPath',
          'canonicalEntryPath',
          'canonicalPackageManifestPath',
          'canonicalPlatformPackageManifestPath',
          'executablePath',
          'entryPath',
          'packageManifestPath',
          'platformPackageManifestPath',
          'executableSha256',
          'entrySha256',
          'packageManifestSha256',
          'platformPackageManifestSha256',
          'launcherSha256',
          'keyring',
          'account',
        ]) {
          expect(Object.keys(publicDiagnostic)).not.toContain(forbiddenKey);
        }

        const cleared = repositories.providerDiagnostics.upsert(
          Object.freeze({
            ...cli,
            sharedCredentialConsentAt: null,
            sharedCredentialConsentVersion: null,
            revision: 1,
          }),
          0,
        );
        expect(cleared.sharedCredentialConsentAt).toBeNull();
        expect(cleared.sharedCredentialConsentVersion).toBeNull();
      } finally {
        database.close();
      }
    });
  });

  it('preserves profile-scoped Codex consent nulls and rejects invalid scope or notice combinations', async () => {
    await withTempDirectory((directory) => {
      const database = openDatabase(join(directory, 'study.sqlite3'));
      try {
        const repositories = createRepositories(database);
        repositories.providerDiagnostics.upsert(providerGlobalCliDiagnostic(), null);
        const initialBinding = providerGlobalCliBinding();

        const changedBinding = repositories.providerDiagnostics.upsert(
          providerGlobalCliDiagnostic({
            cliBinding: Object.freeze({
              ...initialBinding,
              bindingSha256: 'e'.repeat(64),
            }),
            revision: 1,
          }),
          0,
        );
        expect(changedBinding.sharedCredentialConsentAt).toBeNull();
        expect(changedBinding.sharedCredentialConsentVersion).toBeNull();

        expect(() =>
          repositories.providerDiagnostics.upsert(
            Object.freeze({
              ...providerGlobalCliDiagnostic(),
              cliBinding: Object.freeze({
                ...providerGlobalCliBinding(),
                bindingSha256: 'e'.repeat(64),
              }),
              sharedCredentialConsentVersion: 'obsolete-consent-v0',
              revision: 2,
            }) as unknown as ProviderDiagnostic,
            1,
          ),
        ).toThrow('DATABASE_ERROR');

        expect(() =>
          repositories.providerDiagnostics.upsert(
            Object.freeze({
              ...providerGlobalCliDiagnostic(),
              cliBinding: Object.freeze({
                ...initialBinding,
                bindingSha256: 'e'.repeat(64),
                credentialScope: 'provider_global',
              }),
              credentialScope: 'provider_global',
              revision: 2,
            }) as unknown as ProviderDiagnostic,
            1,
          ),
        ).toThrow('DATABASE_ERROR');
      } finally {
        database.close();
      }
    });
  });

  it('rejects persisted Codex credential scope corruption without relying on SQLite checks', async () => {
    await withTempDirectory((directory) => {
      const path = join(directory, 'study.sqlite3');
      const database = openDatabase(path);
      try {
        createRepositories(database).providerDiagnostics.upsert(
          providerGlobalCliDiagnostic(),
          null,
        );
      } finally {
        database.close();
      }

      const corrupter = new DatabaseSync(path);
      try {
        corrupter.exec('PRAGMA ignore_check_constraints = ON');
        corrupter
          .prepare('UPDATE provider_diagnostics SET credential_scope = ? WHERE provider_id = ?')
          .run('provider_global', 'codex_cli');
      } finally {
        corrupter.close();
      }

      const reopened = openDatabase(path);
      try {
        expect(() => createRepositories(reopened).providerDiagnostics.get('codex_cli')).toThrow(
          'DATABASE_ERROR',
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects unsafe diagnostic metadata and every leaked private column in API or unknown rows', async () => {
    await withTempDirectory((directory) => {
      const path = join(directory, 'study.sqlite3');
      const database = openDatabase(path);
      try {
        const repositories = createRepositories(database);
        repositories.providerDiagnostics.upsert(apiDiagnostic(), null);
        expect(() =>
          repositories.providerDiagnostics.upsert(
            providerGlobalCliDiagnostic({
              cliBinding: Object.freeze({
                ...providerGlobalCliBinding(),
                fixedPrefixArgs: Object.freeze(['--api-key=redacted-value']),
              }),
            }),
            null,
          ),
        ).toThrow('DATABASE_ERROR');
        expect(() =>
          repositories.providerDiagnostics.upsert(
            providerGlobalCliDiagnostic({
              cliBinding: Object.freeze({
                ...providerGlobalCliBinding(),
                canonicalPlatformPackageManifestPath: 'C:\\private\\platform-package.json',
                platformPackageManifestSha256: 'f'.repeat(64),
              }),
            }),
            null,
          ),
        ).toThrow('DATABASE_ERROR');
        for (const rejectedPrefixArgument of [
          '--token=redacted-value',
          '--account=student',
          'summarize',
        ]) {
          expect(() =>
            repositories.providerDiagnostics.upsert(
              providerGlobalCliDiagnostic({
                cliBinding: Object.freeze({
                  ...providerGlobalCliBinding(),
                  fixedPrefixArgs: Object.freeze([rejectedPrefixArgument]),
                }),
              }),
              null,
            ),
          ).toThrow('DATABASE_ERROR');
        }
        expect(() =>
          repositories.providerDiagnostics.upsert(
            providerGlobalCliDiagnostic({
              cliBinding: Object.freeze({
                ...providerGlobalCliBinding(),
                recipeId: 'codex-account-student-v1',
              }),
            }),
            null,
          ),
        ).toThrow('DATABASE_ERROR');

        database
          .prepare(
            `UPDATE provider_diagnostics
             SET entry_path = ?, entry_sha256 = ?,
                 package_manifest_path = ?, package_manifest_sha256 = ?
             WHERE provider_id = ?`,
          )
          .run(
            'C:\\private\\entry.mjs',
            'f'.repeat(64),
            'C:\\private\\package.json',
            'f'.repeat(64),
            'openai_api',
          );
        expect(() => repositories.providerDiagnostics.get('openai_api')).toThrow('DATABASE_ERROR');
      } finally {
        database.close();
      }
    });
  });

  it.each(['ready', 'account_unsupported'] as const)(
    'rejects unknown CLI rows with invalid %s status without relying on SQLite checks',
    async (invalidStatus) => {
      await withTempDirectory((directory) => {
        const path = join(directory, 'study.sqlite3');
        const database = openDatabase(path);
        try {
          const repositories = createRepositories(database);
          repositories.providerDiagnostics.upsert(
            Object.freeze({
              providerId: 'gemini_cli',
              status: 'missing_executable',
              version: null,
              selectedModelId: null,
              reportedModelId: null,
              credentialPresent: false,
              credentialScope: 'unknown',
              sharedCredentialConsentAt: null,
              sharedCredentialConsentVersion: null,
              cliBinding: null,
              providerManagedHistory: false,
              checkedAt: NOW,
              latencyMs: null,
              errorCode: 'PROVIDER_EXECUTABLE_NOT_FOUND',
              revision: 0,
            } as unknown as ProviderDiagnostic),
            null,
          );
        } finally {
          database.close();
        }

        const corrupter = new DatabaseSync(path);
        try {
          corrupter.exec('PRAGMA ignore_check_constraints = ON');
          corrupter
            .prepare('UPDATE provider_diagnostics SET status = ? WHERE provider_id = ?')
            .run(invalidStatus, 'gemini_cli');
        } finally {
          corrupter.close();
        }

        const reopened = openDatabase(path);
        try {
          expect(() => createRepositories(reopened).providerDiagnostics.get('gemini_cli')).toThrow(
            'DATABASE_ERROR',
          );
        } finally {
          reopened.close();
        }
      });
    },
  );

  it('rejects unknown CLI binding leakage without a simultaneously invalid status', async () => {
    await withTempDirectory((directory) => {
      const path = join(directory, 'study.sqlite3');
      const database = openDatabase(path);
      try {
        const repositories = createRepositories(database);
        repositories.providerDiagnostics.upsert(
          Object.freeze({
            providerId: 'gemini_cli',
            status: 'missing_executable',
            version: null,
            selectedModelId: null,
            reportedModelId: null,
            credentialPresent: false,
            credentialScope: 'unknown',
            sharedCredentialConsentAt: null,
            sharedCredentialConsentVersion: null,
            cliBinding: null,
            providerManagedHistory: false,
            checkedAt: NOW,
            latencyMs: null,
            errorCode: 'PROVIDER_EXECUTABLE_NOT_FOUND',
            revision: 0,
          } as unknown as ProviderDiagnostic),
          null,
        );
      } finally {
        database.close();
      }

      const corrupter = new DatabaseSync(path);
      try {
        corrupter.exec('PRAGMA ignore_check_constraints = ON');
        corrupter
          .prepare(
            `UPDATE provider_diagnostics
             SET executable_path = ?, executable_sha256 = ?, binding_sha256 = ?, recipe_id = ?,
                 entry_path = ?, entry_sha256 = ?, package_manifest_path = ?,
                 package_manifest_sha256 = ?, signer_classification = ?, fixed_prefix_args_json = ?
             WHERE provider_id = ?`,
          )
          .run(
            'C:\\private\\node.exe',
            'a'.repeat(64),
            'b'.repeat(64),
            'gemini-0.55-policy-json-v1',
            'C:\\private\\gemini-entry.mjs',
            'c'.repeat(64),
            'C:\\private\\package.json',
            'd'.repeat(64),
            'nodejs',
            '["C:\\\\private\\\\gemini-entry.mjs"]',
            'gemini_cli',
          );
      } finally {
        corrupter.close();
      }

      const reopened = openDatabase(path);
      try {
        expect(() => createRepositories(reopened).providerDiagnostics.get('gemini_cli')).toThrow(
          'DATABASE_ERROR',
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects negative persisted diagnostic latency without relying on SQLite checks', async () => {
    await withTempDirectory((directory) => {
      const path = join(directory, 'study.sqlite3');
      const database = openDatabase(path);
      try {
        createRepositories(database).providerDiagnostics.upsert(apiDiagnostic(), null);
      } finally {
        database.close();
      }

      const corrupter = new DatabaseSync(path);
      try {
        corrupter.exec('PRAGMA ignore_check_constraints = ON');
        corrupter
          .prepare('UPDATE provider_diagnostics SET latency_ms = ? WHERE provider_id = ?')
          .run(-1, 'openai_api');
      } finally {
        corrupter.close();
      }

      const reopened = openDatabase(path);
      try {
        expect(() => createRepositories(reopened).providerDiagnostics.get('openai_api')).toThrow(
          'DATABASE_ERROR',
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('persists provider writes across reopen and rejects unknown CLI rows that are not fail-closed', async () => {
    await withTempDirectory((directory) => {
      const path = join(directory, 'study.sqlite3');
      const first = openDatabase(path);
      try {
        const repositories = createRepositories(first);
        repositories.providerDiagnostics.upsert(apiDiagnostic(), null);
        const route = repositories.providerRoutes.get('lecture_organize');
        expect(route).not.toBeNull();
        if (route === null) {
          throw new TypeError('MISSING_TEST_ROUTE');
        }
        repositories.providerRoutes.update(
          Object.freeze({ ...route, enabled: false, revision: 1, updatedAt: LATER }),
          0,
        );
        expect(() =>
          repositories.providerRoutes.update(
            Object.freeze({ ...route, enabled: false, revision: 1, updatedAt: LATER }),
            0,
          ),
        ).toThrow('STALE_WRITE');
      } finally {
        first.close();
      }

      const reopened = openDatabase(path);
      try {
        const repositories = createRepositories(reopened);
        expect(repositories.providerDiagnostics.get('openai_api')).toEqual(apiDiagnostic());
        expect(repositories.providerRoutes.get('lecture_organize')).toMatchObject({ revision: 1 });
        const unknownCli = repositories.providerDiagnostics.upsert(
          Object.freeze({
            providerId: 'gemini_cli',
            status: 'missing_executable',
            version: null,
            selectedModelId: null,
            reportedModelId: null,
            credentialPresent: false,
            credentialScope: 'unknown',
            sharedCredentialConsentAt: null,
            sharedCredentialConsentVersion: null,
            cliBinding: null,
            providerManagedHistory: false,
            checkedAt: NOW,
            latencyMs: null,
            errorCode: 'PROVIDER_EXECUTABLE_NOT_FOUND',
            revision: 0,
          } as unknown as ProviderDiagnostic),
          null,
        );
        expect(unknownCli).toMatchObject({
          providerId: 'gemini_cli',
          credentialScope: 'unknown',
          status: 'missing_executable',
          cliBinding: null,
        });
        expect(() =>
          repositories.providerDiagnostics.upsert(
            Object.freeze({
              providerId: 'gemini_cli',
              status: 'ready',
              version: null,
              selectedModelId: null,
              reportedModelId: null,
              credentialPresent: false,
              credentialScope: 'unknown',
              sharedCredentialConsentAt: null,
              sharedCredentialConsentVersion: null,
              cliBinding: null,
              providerManagedHistory: false,
              checkedAt: NOW,
              latencyMs: null,
              errorCode: null,
              revision: 0,
            } as unknown as ProviderDiagnostic),
            null,
          ),
        ).toThrow('DATABASE_ERROR');
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects persisted rows that satisfy SQLite but violate the strict shared contracts', async () => {
    await withTempDirectory((directory) => {
      const path = join(directory, 'study.sqlite3');
      const database = openDatabase(path);
      try {
        const repositories = createRepositories(database);
        const route = repositories.providerRoutes.get('lecture_organize');
        expect(route).not.toBeNull();
        database
          .prepare('UPDATE provider_routes SET prompt_version = ? WHERE feature = ?')
          .run('invalid prompt version', 'lecture_organize');
        expect(() => repositories.providerRoutes.get('lecture_organize')).toThrow('DATABASE_ERROR');
      } finally {
        database.close();
      }
    });
  });
});
