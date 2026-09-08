import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiProviderRouter } from '../../src/application/providers/aiProviderRouter';
import {
  type AiProviderAdapter,
  createProviderOperation,
  type ProviderDiagnostic,
  type ProviderExecution,
  type ProviderOperation,
  type ProviderRequest,
} from '../../src/core/ports/aiProvider';
import type { ProviderInvocationRepository } from '../../src/core/ports/providerRepositories';
import { sha256CanonicalJson } from '../../src/core/providers/canonicalJson';
import { FORMAT_REPAIR_BLOCK } from '../../src/core/providers/retryPolicy';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import { FakeAiProviderAdapter } from '../../src/infrastructure/providers/fake/fakeAiProviderAdapter';
import {
  type AiProviderId,
  ANTIGRAVITY_HISTORY_NOTICE_VERSION,
  type JsonValue,
  parseSafeSemVer,
  SHARED_CREDENTIAL_NOTICE_VERSION,
} from '../../src/shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../src/shared/errors';
import { courseFixture, jobFixture, TEST_IDS } from '../testkit/fixtures';
import { withTempDirectory } from '../testkit/tempDirectory';

const NOW = '2026-09-02T01:02:03.000Z';
const COMPLETED = '2026-09-02T01:02:03.025Z';
const JOB_ID = TEST_IDS.job;
const MODEL = 'gpt-5.5';
const REPORTED_MODEL = 'gpt-5.5-2026-08-07';

const apiDiagnostic = (
  providerId: Extract<AiProviderId, `${string}_api`>,
  overrides: Partial<ProviderDiagnostic> = {},
): ProviderDiagnostic =>
  Object.freeze({
    providerId,
    status: 'ready',
    version: null,
    selectedModelId: MODEL,
    reportedModelId: REPORTED_MODEL,
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

const cliDiagnostic = (
  providerId: Extract<AiProviderId, `${string}_cli`>,
  overrides: Partial<ProviderDiagnostic> = {},
): ProviderDiagnostic => {
  const version = parseSafeSemVer(
    providerId === 'antigravity_cli' ? '1.1.0' : providerId === 'gemini_cli' ? '0.55.0' : '0.146.0',
  );
  const entry = providerId === 'gemini_cli' ? 'C:\\private\\gemini-entry.js' : null;
  const credentialScope = providerId === 'codex_cli' ? 'profile_scoped' : 'provider_global';
  return Object.freeze({
    providerId,
    status: 'ready',
    version,
    selectedModelId: null,
    reportedModelId: null,
    credentialPresent: true,
    credentialScope,
    sharedCredentialConsentAt: credentialScope === 'provider_global' ? NOW : null,
    sharedCredentialConsentVersion:
      credentialScope === 'provider_global' ? SHARED_CREDENTIAL_NOTICE_VERSION : null,
    cliBinding: Object.freeze({
      providerId,
      canonicalLauncherPath:
        providerId === 'gemini_cli' ? 'C:\\private\\node.exe' : `C:\\private\\${providerId}.exe`,
      canonicalEntryPath: entry,
      canonicalPackageManifestPath:
        providerId === 'gemini_cli' ? 'C:\\private\\package.json' : null,
      canonicalPlatformPackageManifestPath: null,
      fixedPrefixArgs: Object.freeze(entry === null ? [] : [entry]),
      version,
      launcherSha256: 'a'.repeat(64),
      entrySha256: entry === null ? null : 'b'.repeat(64),
      packageManifestSha256: providerId === 'gemini_cli' ? 'd'.repeat(64) : null,
      platformPackageManifestSha256: null,
      bindingSha256: 'c'.repeat(64),
      recipeId:
        providerId === 'antigravity_cli'
          ? 'antigravity-1.1-stream-json-v1'
          : providerId === 'gemini_cli'
            ? 'gemini-0.55-policy-json-v1'
            : 'codex-0.146-profile-keyring-v2',
      credentialScope,
      signerClassification:
        providerId === 'codex_cli' ? 'openai' : providerId === 'gemini_cli' ? 'nodejs' : 'google',
      checkedAt: NOW,
    }),
    providerManagedHistory: providerId === 'antigravity_cli',
    checkedAt: NOW,
    latencyMs: 10,
    errorCode: null,
    revision: 0,
    ...overrides,
  } as ProviderDiagnostic);
};

const outputExecution = <Output extends JsonValue>(
  output: Output,
  reportedModelId: string | null = REPORTED_MODEL,
): ProviderExecution<Output> =>
  Object.freeze({
    output,
    reportedModelId,
    usage: Object.freeze({ inputTokens: 4, outputTokens: 2, totalTokens: 6 }),
    completedAt: COMPLETED,
  });

const operation = (
  overrides: Partial<{
    requestId: string;
    jobId: string | null;
    signal: AbortSignal;
    blocks: readonly { role: 'system' | 'user'; kind: 'instruction' | 'source'; text: string }[];
  }> = {},
): ProviderOperation<Readonly<{ ok: true }>> =>
  createProviderOperation({
    requestId: overrides.requestId ?? randomUUID(),
    feature: 'lecture_organize',
    jobId: overrides.jobId === undefined ? JOB_ID : overrides.jobId,
    outputSchemaId: 'lecture_output',
    outputJsonSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['ok']),
      properties: Object.freeze({ ok: Object.freeze({ const: true }) }),
    }),
    parseOutput: (value) => z.strictObject({ ok: z.literal(true) }).parse(value),
    blocks:
      overrides.blocks ??
      Object.freeze([
        Object.freeze({ role: 'system', kind: 'instruction', text: '고정 지시' }),
        Object.freeze({ role: 'user', kind: 'source', text: '민감한 강의 본문' }),
      ]),
    timeoutMs: 30_000,
    maxOutputTokens: 100,
    signal: overrides.signal ?? new AbortController().signal,
  });

type Harness = Readonly<{
  database: ReturnType<typeof openDatabase>;
  repositories: ReturnType<typeof createRepositories>;
  router: AiProviderRouter;
  adapters: Readonly<Record<AiProviderId, FakeAiProviderAdapter<AiProviderId>>>;
}>;

const openedDatabases: ReturnType<typeof openDatabase>[] = [];
const openedDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const database of openedDatabases.splice(0)) database.close();
  for (const directory of openedDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const harness = (
  providerId: AiProviderId = 'gemini_api',
  diagnostic: ProviderDiagnostic = apiDiagnostic('gemini_api'),
  overrides: Partial<ConstructorParameters<typeof AiProviderRouter>[0]> = {},
  databasePath?: string,
): Harness => {
  let resolvedDatabasePath = databasePath;
  if (resolvedDatabasePath === undefined) {
    const directory = mkdtempSync(join(tmpdir(), 'lecture-study-assistant-router-'));
    openedDirectories.push(directory);
    resolvedDatabasePath = join(directory, 'study.sqlite3');
  }
  const database = openDatabase(resolvedDatabasePath);
  openedDatabases.push(database);
  const repositories = createRepositories(database);
  repositories.courses.insert(courseFixture());
  repositories.jobs.insert(jobFixture());
  repositories.providerDiagnostics.upsert(diagnostic, null);
  const currentRoute = repositories.providerRoutes.get('lecture_organize');
  if (currentRoute === null) throw new TypeError('MISSING_TEST_ROUTE');
  repositories.providerRoutes.update(
    Object.freeze({
      ...currentRoute,
      providerId,
      modelId: diagnostic.selectedModelId,
      enabled: true,
      providerManagedHistoryConsentAt: providerId === 'antigravity_cli' ? NOW : null,
      providerManagedHistoryConsentVersion:
        providerId === 'antigravity_cli' ? ANTIGRAVITY_HISTORY_NOTICE_VERSION : null,
      updatedAt: NOW,
      revision: 1,
    }),
    0,
  );
  const adapters = Object.fromEntries(
    (
      [
        'antigravity_cli',
        'gemini_cli',
        'codex_cli',
        'gemini_api',
        'openai_api',
        'claude_api',
      ] as const
    ).map((id) => [id, new FakeAiProviderAdapter(id)]),
  ) as Record<AiProviderId, FakeAiProviderAdapter<AiProviderId>>;
  const registry = new Map<AiProviderId, AiProviderAdapter>();
  for (const [id, adapter] of Object.entries(adapters) as [AiProviderId, AiProviderAdapter][]) {
    registry.set(id, adapter);
  }
  return Object.freeze({
    database,
    repositories,
    adapters,
    router: new AiProviderRouter({
      routes: repositories.providerRoutes,
      diagnostics: repositories.providerDiagnostics,
      invocations: repositories.providerInvocations,
      adapters: registry,
      clock: () => NOW,
      id: randomUUID,
      delay: async (milliseconds, signal) => {
        if (signal.aborted)
          throw new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED);
        await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
      },
      ...overrides,
    }),
  });
};

describe('AiProviderRouter', () => {
  it('reports cancelled-adapter residual data publicly and in audit/diagnostic without retry', async () => {
    const context = harness('codex_cli', cliDiagnostic('codex_cli'));
    const controller = new AbortController();
    const execute = vi.spyOn(context.adapters.codex_cli, 'execute').mockImplementation(async () => {
      controller.abort();
      throw new AppError('PROVIDER_RESIDUAL_DATA', APP_ERROR_MESSAGES.PROVIDER_RESIDUAL_DATA);
    });
    await expect(
      context.router.execute(operation({ signal: controller.signal })),
    ).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(context.repositories.providerInvocations.listForJob(JOB_ID)).toMatchObject([
      { status: 'failed', errorCode: 'PROVIDER_RESIDUAL_DATA' },
    ]);
    expect(context.repositories.providerDiagnostics.get('codex_cli')).toMatchObject({
      status: 'unsafe_version',
      errorCode: 'PROVIDER_RESIDUAL_DATA',
    });
    expect(context.adapters.openai_api.calls).toHaveLength(0);
  });

  it('rejects file operations before provider disclosure or invocation persistence', async () => {
    const context = harness();
    const request = createProviderOperation({
      ...operation(),
      blocks: [
        {
          role: 'user',
          kind: 'source_file',
          sourceId: randomUUID(),
          filePath: 'C:/private/lecture.m4a',
          mediaType: 'audio',
          sha256: 'a'.repeat(64),
          sizeBytes: 100,
        },
      ],
    });
    await expect(context.router.execute(request)).rejects.toMatchObject({
      code: 'PROVIDER_MEDIA_UNSUPPORTED',
      message: 'PROVIDER_MEDIA_UNSUPPORTED',
    });
    expect(Object.values(context.adapters).flatMap((adapter) => adapter.calls)).toEqual([]);
    expect(context.database.prepare('SELECT * FROM provider_invocations').all()).toEqual([]);
  });
  // Production break caught: a terminal failure triggers lookup or execution of a fallback provider.
  it('never calls a second provider when the selected provider fails', async () => {
    const context = harness();
    context.adapters.gemini_api.queueFailure('PROVIDER_QUOTA_OR_BILLING');
    await expect(context.router.execute(operation())).rejects.toMatchObject({
      code: 'PROVIDER_QUOTA_OR_BILLING',
    });
    expect(context.adapters.gemini_api.calls).toHaveLength(1);
    expect(context.adapters.openai_api.calls).toHaveLength(0);
    expect(context.adapters.codex_cli.calls).toHaveLength(0);
  });

  // Production break caught: a provider-global login is invoked without current paired consent metadata.
  it('does not call a provider-global CLI without current shared-login consent', async () => {
    const context = harness(
      'gemini_cli',
      cliDiagnostic('gemini_cli', {
        sharedCredentialConsentAt: null,
        sharedCredentialConsentVersion: null,
      }),
    );
    await expect(context.router.execute(operation())).rejects.toMatchObject({
      code: 'PROVIDER_SHARED_CREDENTIAL_CONSENT_REQUIRED',
    });
    expect(context.adapters.gemini_cli.calls).toHaveLength(0);
    expect(context.repositories.providerInvocations.listForJob(JOB_ID)).toHaveLength(0);
  });

  // Production break caught: an unknown CLI credential scope reaches an adapter or audit row.
  it('fails closed before invoking a CLI whose credential scope is unknown', async () => {
    const context = harness(
      'gemini_cli',
      Object.freeze({
        providerId: 'gemini_cli',
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
        checkedAt: NOW,
        latencyMs: null,
        errorCode: null,
        revision: 0,
      }),
    );
    await expect(context.router.execute(operation())).rejects.toMatchObject({
      code: 'PROVIDER_NOT_READY',
    });
    expect(context.adapters.gemini_cli.calls).toHaveLength(0);
    expect(context.repositories.providerInvocations.listForJob(JOB_ID)).toHaveLength(0);
  });

  // Production break caught: direct route persistence bypasses Antigravity history-consent enforcement.
  it('rechecks current Antigravity history consent at execution time', async () => {
    const context = harness('antigravity_cli', cliDiagnostic('antigravity_cli'));
    const route = context.repositories.providerRoutes.get('lecture_organize');
    if (route === null) throw new TypeError('MISSING_TEST_ROUTE');
    context.repositories.providerRoutes.update(
      Object.freeze({
        ...route,
        providerManagedHistoryConsentAt: null,
        providerManagedHistoryConsentVersion: null,
        revision: 2,
      }),
      1,
    );
    await expect(context.router.execute(operation())).rejects.toMatchObject({
      code: 'PROVIDER_DATA_RETENTION_CONSENT_REQUIRED',
    });
    expect(context.adapters.antigravity_cli.calls).toHaveLength(0);
  });

  // Production break caught: a format retry changes provider or embeds rejected output instead of the fixed repair block.
  it('allows one format repair on the same provider and records both attempts', async () => {
    const context = harness('gemini_cli', cliDiagnostic('gemini_cli'));
    context.adapters.gemini_cli.queueFailure('PROVIDER_OUTPUT_INVALID');
    context.adapters.gemini_cli.queueExecution(outputExecution({ ok: true }, null));
    await expect(context.router.execute(operation())).resolves.toMatchObject({
      output: { ok: true },
    });
    expect(context.adapters.gemini_cli.calls.map((call) => call.attemptKind)).toEqual([
      'initial',
      'format_repair',
    ]);
    expect(context.adapters.gemini_cli.calls[0]?.blockKinds).not.toContain('format_repair');
    expect(context.adapters.gemini_cli.calls[1]?.blockKinds).toContain(FORMAT_REPAIR_BLOCK.kind);
    const attempts = context.repositories.providerInvocations.listForJob(JOB_ID);
    expect(attempts).toHaveLength(2);
    const initial = attempts.find((attempt) => attempt.attemptKind === 'initial');
    const repair = attempts.find((attempt) => attempt.attemptKind === 'format_repair');
    expect(repair?.retryOf).toBe(initial?.id);
    expect(context.repositories.providerDiagnostics.get('gemini_cli')?.status).toBe('ready');
  });

  it('records a distinct composed identity for the added format-repair instruction without changing the saved route', async () => {
    const context = harness('gemini_cli', cliDiagnostic('gemini_cli'));
    const saved = context.repositories.providerRoutes.get('lecture_organize');
    context.adapters.gemini_cli.queueFailure('PROVIDER_OUTPUT_INVALID');
    context.adapters.gemini_cli.queueExecution(outputExecution({ ok: true }, null));
    const composedPromptSha256 = 'a'.repeat(64);
    await context.router.execute(createProviderOperation({ ...operation(), composedPromptSha256 }));
    const attempts = context.repositories.providerInvocations.listForJob(JOB_ID);
    const initial = attempts.find((v) => v.attemptKind === 'initial');
    const repair = attempts.find((v) => v.attemptKind === 'format_repair');
    expect(initial?.promptVersion).toBe(composedPromptSha256);
    expect(repair?.promptVersion).toMatch(/^[a-f0-9]{64}$/u);
    expect(repair?.promptVersion).not.toBe(initial?.promptVersion);
    expect(repair?.requestSha256).not.toBe(initial?.requestSha256);
    expect(context.adapters.gemini_cli.calls[1]?.promptVersion).toBe(repair?.promptVersion);
    expect(context.repositories.providerRoutes.get('lecture_organize')).toEqual(saved);
  });

  // Production break caught: CLI concurrency exceeds one or cancellation leaks a held lease.
  it('caps CLI concurrency at one and releases the lease after cancellation', async () => {
    vi.useFakeTimers();
    const context = harness('gemini_cli', cliDiagnostic('gemini_cli'));
    const firstAbort = new AbortController();
    context.adapters.gemini_cli.holdNextCall();
    const first = context.router.execute(operation({ signal: firstAbort.signal }));
    await vi.waitFor(() => expect(context.adapters.gemini_cli.activeCalls).toBe(1));
    const second = context.router.execute(operation({ requestId: randomUUID() }));
    const firstRejection = expect(first).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    const secondRejection = expect(second).rejects.toMatchObject({ code: 'PROVIDER_BUSY' });
    await vi.advanceTimersByTimeAsync(30_001);
    await secondRejection;
    firstAbort.abort();
    await firstRejection;
    expect(context.adapters.gemini_cli.activeCalls).toBe(0);
  });

  // Production break caught: queued CLI requests overtake earlier waiters.
  it('releases provider-scoped CLI leases in FIFO order', async () => {
    const context = harness('gemini_cli', cliDiagnostic('gemini_cli'));
    const firstId = randomUUID();
    const secondId = randomUUID();
    const thirdId = randomUUID();
    context.adapters.gemini_cli.holdNextCall();
    context.adapters.gemini_cli.queueExecution(outputExecution({ ok: true }, null));
    context.adapters.gemini_cli.queueExecution(outputExecution({ ok: true }, null));
    const first = context.router.execute(operation({ requestId: firstId, jobId: null }));
    await vi.waitFor(() => expect(context.adapters.gemini_cli.activeCalls).toBe(1));
    const second = context.router.execute(operation({ requestId: secondId, jobId: null }));
    const third = context.router.execute(operation({ requestId: thirdId, jobId: null }));
    context.adapters.gemini_cli.release(outputExecution({ ok: true }, null));
    await Promise.all([first, second, third]);
    expect(context.adapters.gemini_cli.calls.map((call) => call.requestId)).toEqual([
      firstId,
      secondId,
      thirdId,
    ]);
  });

  // Production break caught: an API provider runs more than two requests at once.
  it('caps API concurrency at two per provider', async () => {
    const context = harness();
    context.adapters.gemini_api.holdNextCall();
    context.adapters.gemini_api.holdNextCall();
    context.adapters.gemini_api.queueExecution(outputExecution({ ok: true }));
    const first = context.router.execute(operation({ requestId: randomUUID(), jobId: null }));
    const second = context.router.execute(operation({ requestId: randomUUID(), jobId: null }));
    const third = context.router.execute(operation({ requestId: randomUUID(), jobId: null }));
    await vi.waitFor(() => expect(context.adapters.gemini_api.activeCalls).toBe(2));
    expect(context.adapters.gemini_api.calls).toHaveLength(2);
    context.adapters.gemini_api.release(outputExecution({ ok: true }));
    context.adapters.gemini_api.release(outputExecution({ ok: true }));
    await Promise.all([first, second, third]);
    expect(context.adapters.gemini_api.calls).toHaveLength(3);
  });

  // Production break caught: a route is re-read after execution begins and switches provider mid-call.
  it('keeps the original route snapshot when the user changes the route mid-call', async () => {
    const context = harness();
    context.adapters.gemini_api.holdNextCall();
    const pending = context.router.execute(operation());
    await vi.waitFor(() => expect(context.adapters.gemini_api.activeCalls).toBe(1));
    const current = context.repositories.providerRoutes.get('lecture_organize');
    if (current === null) throw new TypeError('MISSING_TEST_ROUTE');
    context.repositories.providerRoutes.update(
      Object.freeze({ ...current, providerId: 'openai_api', updatedAt: COMPLETED, revision: 2 }),
      1,
    );
    context.adapters.gemini_api.release(outputExecution({ ok: true }));
    await pending;
    expect(context.repositories.providerInvocations.listForJob(JOB_ID)[0]).toMatchObject({
      providerId: 'gemini_api',
      routeRevision: 1,
    });
    expect(context.adapters.openai_api.calls).toHaveLength(0);
  });

  // Production break caught: execution accepts a route model different from the last successful probe model.
  it('refuses a route whose model was not the model in the last successful probe', async () => {
    const context = harness();
    const current = context.repositories.providerRoutes.get('lecture_organize');
    if (current === null) throw new TypeError('MISSING_TEST_ROUTE');
    context.repositories.providerRoutes.update(
      Object.freeze({ ...current, modelId: 'gpt-4.1', updatedAt: COMPLETED, revision: 2 }),
      1,
    );
    await expect(context.router.execute(operation())).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_INCOMPATIBLE',
    });
    expect(context.adapters.gemini_api.calls).toHaveLength(0);
  });

  // Production break caught: null CLI default-model probes are treated as equivalent to explicit model probes.
  it('treats a CLI default-model probe and explicit-model probe as different', async () => {
    const context = harness(
      'codex_cli',
      cliDiagnostic('codex_cli', { selectedModelId: 'gpt-5.6-sol', reportedModelId: null }),
    );
    const current = context.repositories.providerRoutes.get('lecture_organize');
    if (current === null) throw new TypeError('MISSING_TEST_ROUTE');
    context.repositories.providerRoutes.update(
      Object.freeze({ ...current, modelId: null, updatedAt: COMPLETED, revision: 2 }),
      1,
    );
    await expect(context.router.execute(operation())).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_INCOMPATIBLE',
    });
    expect(context.adapters.codex_cli.calls).toHaveLength(0);
  });

  // Production break caught: backend model drift is returned as success or omitted from the failed audit row.
  it('rejects model drift after execution and records both model identities', async () => {
    const context = harness();
    context.adapters.gemini_api.queueExecution(outputExecution({ ok: true }, 'gpt-5.5-2026-08-21'));
    await expect(context.router.execute(operation())).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_INCOMPATIBLE',
    });
    expect(context.repositories.providerInvocations.listForJob(JOB_ID)[0]).toMatchObject({
      selectedModelId: MODEL,
      reportedModelId: 'gpt-5.5-2026-08-21',
      status: 'failed',
      errorCode: 'PROVIDER_MODEL_INCOMPATIBLE',
    });
  });

  // Production break caught: an invocation-create database rejection occurs after the provider call starts.
  it('does not call the adapter when invocation creation is not accepted', async () => {
    const context = harness('gemini_api', apiDiagnostic('gemini_api'), {
      invocations: Object.freeze({
        ...contextPlaceholderInvocationRepository,
        create: () => {
          throw new AppError('DATABASE_ERROR', APP_ERROR_MESSAGES.DATABASE_ERROR);
        },
      }),
    });
    await expect(context.router.execute(operation())).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
    });
    expect(context.adapters.gemini_api.calls).toHaveLength(0);
  });

  // Production break caught: completion rejection returns unaccepted output or enters provider retry logic.
  it('does not return output or retry when invocation completion is not accepted', async () => {
    const context = harness('gemini_api', apiDiagnostic('gemini_api'), {
      invocations: Object.freeze({
        ...contextPlaceholderInvocationRepository,
        create: (next: Parameters<ProviderInvocationRepository['create']>[0]) => next,
        complete: () => {
          throw new AppError('DATABASE_ERROR', APP_ERROR_MESSAGES.DATABASE_ERROR);
        },
      }),
    });
    context.adapters.gemini_api.queueExecution(outputExecution({ ok: true }));
    await expect(context.router.execute(operation())).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
    });
    expect(context.adapters.gemini_api.calls).toHaveLength(1);
  });

  // Production break caught: a queued abort creates an audit row or invokes the selected adapter.
  it('cancels a queued request without creating an invocation or calling the adapter', async () => {
    const context = harness('gemini_cli', cliDiagnostic('gemini_cli'));
    context.adapters.gemini_cli.holdNextCall();
    const first = context.router.execute(operation());
    await vi.waitFor(() => expect(context.adapters.gemini_cli.activeCalls).toBe(1));
    const queuedAbort = new AbortController();
    const second = context.router.execute(
      operation({ requestId: randomUUID(), jobId: null, signal: queuedAbort.signal }),
    );
    const rejection = expect(second).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    queuedAbort.abort();
    await rejection;
    expect(context.adapters.gemini_cli.calls).toHaveLength(1);
    context.adapters.gemini_cli.release(outputExecution({ ok: true }, null));
    await first;
  });

  // Production break caught: a transient retry is unaudited, changes route identity, or targets another provider.
  it('records one same-provider transient retry linked to the previous attempt', async () => {
    vi.useFakeTimers();
    const context = harness();
    context.adapters.gemini_api.queueFailure('PROVIDER_NETWORK_FAILED');
    context.adapters.gemini_api.queueExecution(outputExecution({ ok: true }));
    const pending = context.router.execute(operation());
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    const attempts = context.repositories.providerInvocations.listForJob(JOB_ID);
    expect(
      attempts
        .map(({ providerId, selectedModelId, routeRevision, attemptKind }) => ({
          providerId,
          selectedModelId,
          routeRevision,
          attemptKind,
        }))
        .sort((left, right) => left.attemptKind.localeCompare(right.attemptKind)),
    ).toEqual(
      [
        {
          providerId: 'gemini_api',
          selectedModelId: MODEL,
          routeRevision: 1,
          attemptKind: 'initial',
        },
        {
          providerId: 'gemini_api',
          selectedModelId: MODEL,
          routeRevision: 1,
          attemptKind: 'transient_retry',
        },
      ].sort((left, right) => left.attemptKind.localeCompare(right.attemptKind)),
    );
    const initial = attempts.find((attempt) => attempt.attemptKind === 'initial');
    const retry = attempts.find((attempt) => attempt.attemptKind === 'transient_retry');
    expect(retry?.retryOf).toBe(initial?.id);
    expect(context.adapters.openai_api.calls).toHaveLength(0);
  });

  // Production break caught: a validated HTTP Retry-After hint is discarded before router delay.
  it('uses the trusted capped provider Retry-After hint for the same-provider retry', async () => {
    let executeCalls = 0;
    let delays: readonly number[] = Object.freeze([]);
    const adapter: AiProviderAdapter<'gemini_api'> = Object.freeze({
      id: 'gemini_api',
      inspect: async () =>
        Object.freeze({
          status: 'ready' as const,
          version: null,
          credentialPresent: true,
          credentialScope: 'not_applicable' as const,
          cliBinding: null,
          providerManagedHistory: false,
        }),
      listModels: async () => Object.freeze([]),
      probe: async () =>
        Object.freeze({
          status: 'ready' as const,
          reportedModelId: REPORTED_MODEL,
          latencyMs: 1,
          usage: Object.freeze({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
          providerManagedHistory: false,
        }),
      execute: async <Output extends JsonValue>(
        _request: ProviderRequest<Output>,
      ): Promise<ProviderExecution<Output>> => {
        executeCalls += 1;
        if (executeCalls === 1) {
          throw new AppError('PROVIDER_RATE_LIMITED', APP_ERROR_MESSAGES.PROVIDER_RATE_LIMITED, {
            retryAfterMs: 99_999,
          });
        }
        return outputExecution({ ok: true }) as unknown as ProviderExecution<Output>;
      },
      cancel: () => {},
    });
    const adapters = new Map<AiProviderId, AiProviderAdapter>();
    adapters.set('gemini_api', adapter);
    const context = harness('gemini_api', apiDiagnostic('gemini_api'), {
      adapters,
      delay: async (milliseconds) => {
        delays = Object.freeze([...delays, milliseconds]);
      },
    });

    await expect(context.router.execute(operation())).resolves.toMatchObject({
      output: { ok: true },
    });

    expect(executeCalls).toBe(2);
    expect(delays).toEqual([5_000]);
  });

  // Production break caught: retry-delay aborts leak DOMException/vendor errors instead of fixed cancellation.
  it('normalizes cancellation while waiting to retry', async () => {
    const controller = new AbortController();
    const context = harness('gemini_api', apiDiagnostic('gemini_api'), {
      delay: async (_milliseconds, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            {
              once: true,
            },
          );
        }),
    });
    context.adapters.gemini_api.queueFailure('PROVIDER_NETWORK_FAILED');
    const pending = context.router.execute(operation({ signal: controller.signal }));
    await vi.waitFor(() => expect(context.adapters.gemini_api.calls).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(context.adapters.gemini_api.calls).toHaveLength(1);
  });

  // Production break caught: caller mutation changes an outcome after the fake has queued its snapshot.
  it('copies queued fake outcomes before later caller mutation', async () => {
    const context = harness();
    const mutableOutput = { ok: true } as { ok: boolean };
    context.adapters.gemini_api.queueExecution(
      outputExecution(mutableOutput as Readonly<{ ok: true }>),
    );
    mutableOutput.ok = false;
    await expect(context.router.execute(operation())).resolves.toMatchObject({
      output: { ok: true },
    });
  });

  // Production break caught: accepted nested output/usage keep adapter or parser-owned mutable references after audit.
  it('snapshots nested validated output and usage across held release and accepted return', async () => {
    const context = harness();
    const callerOutput = { ok: true as const, details: { tags: ['original'] } };
    const callerUsage = { inputTokens: 4, outputTokens: 2, totalTokens: 6 };
    context.adapters.gemini_api.holdNextCall();
    const pending = context.router.execute(nestedOperation());
    await vi.waitFor(() => expect(context.adapters.gemini_api.activeCalls).toBe(1));
    context.adapters.gemini_api.release(
      Object.freeze({
        output: callerOutput,
        reportedModelId: REPORTED_MODEL,
        usage: callerUsage,
        completedAt: COMPLETED,
      }),
    );
    callerOutput.details.tags.push('mutated-after-release');
    callerUsage.inputTokens = 999;

    const accepted = await pending;
    expect(accepted.output).toEqual({ ok: true, details: { tags: ['original'] } });
    expect(accepted.usage).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
    expect(Object.isFrozen(accepted.output)).toBe(true);
    expect(Object.isFrozen(accepted.output.details)).toBe(true);
    expect(Object.isFrozen(accepted.output.details.tags)).toBe(true);
    expect(Object.isFrozen(accepted.usage)).toBe(true);
    expect(() => (accepted.output.details.tags as string[]).push('post-audit')).toThrow(TypeError);
    expect(() => {
      (accepted.usage as { inputTokens: number | null }).inputTokens = 123;
    }).toThrow(TypeError);
    expect(context.repositories.providerInvocations.listForJob(JOB_ID)[0]).toMatchObject({
      responseSha256: sha256CanonicalJson(accepted.output),
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    });
  });

  // Production break caught: the retry cap permits a third provider call after two transient failures.
  it('stops transient retries after two audited provider calls', async () => {
    vi.useFakeTimers();
    const context = harness();
    context.adapters.gemini_api.queueFailure('PROVIDER_NETWORK_FAILED');
    context.adapters.gemini_api.queueFailure('PROVIDER_NETWORK_FAILED');
    context.adapters.gemini_api.queueExecution(outputExecution({ ok: true }));
    const pending = context.router.execute(operation());
    const rejection = expect(pending).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_FAILED' });
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    expect(context.adapters.gemini_api.calls).toHaveLength(2);
    expect(context.repositories.providerInvocations.listForJob(JOB_ID)).toHaveLength(2);
    expect(context.repositories.providerDiagnostics.get('gemini_api')).toMatchObject({
      status: 'temporarily_unavailable',
      errorCode: 'PROVIDER_NETWORK_FAILED',
    });
  });

  // Production break caught: invocation persistence contains prompt/source text instead of hashes and metadata.
  it('persists content-free invocation metadata and hashes only locally validated output', async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, 'audit.sqlite3');
      const context = harness('gemini_api', apiDiagnostic('gemini_api'), {}, path);
      context.adapters.gemini_api.queueExecution(outputExecution({ ok: true }));
      await context.router.execute(operation());
      context.database.close();
      openedDatabases.splice(openedDatabases.indexOf(context.database), 1);
      const bytes = await readFile(path);
      expect(bytes.includes(Buffer.from('민감한 강의 본문'))).toBe(false);
    });
  });

  // Production break caught: a concurrent diagnostic probe is overwritten or turns success into STALE_WRITE.
  it('keeps a newer diagnostic revision and returns the original successful result', async () => {
    const context = harness();
    context.adapters.gemini_api.holdNextCall();
    const pending = context.router.execute(operation());
    await vi.waitFor(() => expect(context.adapters.gemini_api.activeCalls).toBe(1));
    const diagnostic = context.repositories.providerDiagnostics.get('gemini_api');
    if (diagnostic === null) throw new TypeError('MISSING_TEST_DIAGNOSTIC');
    context.repositories.providerDiagnostics.upsert(
      Object.freeze({ ...diagnostic, latencyMs: 99, revision: 1 }),
      0,
    );
    context.adapters.gemini_api.release(outputExecution({ ok: true }));
    await expect(pending).resolves.toMatchObject({ output: { ok: true } });
    expect(context.repositories.providerDiagnostics.get('gemini_api')).toMatchObject({
      latencyMs: 99,
      revision: 1,
    });
  });

  // Production break caught: shutdown leaves active/queued work running or cancels an unselected adapter.
  it('cancels only selected active adapters and rejects queued work during shutdown', async () => {
    const context = harness('gemini_cli', cliDiagnostic('gemini_cli'));
    context.adapters.gemini_cli.holdNextCall();
    const first = context.router.execute(operation());
    await vi.waitFor(() => expect(context.adapters.gemini_cli.activeCalls).toBe(1));
    const queued = context.router.execute(operation({ requestId: randomUUID(), jobId: null }));
    const firstRejection = expect(first).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    const queuedRejection = expect(queued).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    await context.router.shutdown();
    await firstRejection;
    await queuedRejection;
    expect(context.adapters.gemini_cli.cancelledRequestIds).toHaveLength(1);
    expect(context.adapters.openai_api.cancelledRequestIds).toHaveLength(0);
  });

  // Production break caught: shutdown waits forever when a selected adapter ignores cancellation.
  it('rejects shutdown after ten seconds until the cancellation-ignoring request actually settles', async () => {
    vi.useFakeTimers();
    const context = harness();
    context.adapters.gemini_api.holdNextCallIgnoringCancellation();
    const pending = context.router.execute(operation());
    const pendingRejection = expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    await vi.waitFor(() => expect(context.adapters.gemini_api.activeCalls).toBe(1));
    const shutdown = context.router.shutdown();
    const stopped = expect(shutdown).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    await vi.advanceTimersByTimeAsync(10_000);
    await stopped;
    expect(context.repositories.providerInvocations.listForJob(JOB_ID)[0]).toMatchObject({
      status: 'running',
      errorCode: null,
    });
    context.adapters.gemini_api.release(outputExecution({ ok: true }));
    await pendingRejection;
    await context.router.shutdown();
    expect(context.repositories.providerInvocations.listForJob(JOB_ID)[0]).toMatchObject({
      status: 'cancelled',
      errorCode: 'PROVIDER_CANCELLED',
    });
  });
});

const contextPlaceholderInvocationRepository: ProviderInvocationRepository = Object.freeze({
  create: (next: Parameters<ProviderInvocationRepository['create']>[0]) => next,
  get: () => null,
  complete: (
    _id: Parameters<ProviderInvocationRepository['complete']>[0],
    _revision: Parameters<ProviderInvocationRepository['complete']>[1],
    completion: Parameters<ProviderInvocationRepository['complete']>[2],
  ) => {
    throw new Error(`UNUSED_${completion.status}`);
  },
  listForJob: () => Object.freeze([]),
  recoverInterrupted: () => 0,
  cancelRunningForShutdown: () => 0,
});

const nestedOperation = (): ProviderOperation<
  Readonly<{ ok: true; details: Readonly<{ tags: readonly string[] }> }>
> =>
  createProviderOperation({
    requestId: randomUUID(),
    feature: 'lecture_organize',
    jobId: JOB_ID,
    outputSchemaId: 'lecture_output',
    outputJsonSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['ok', 'details']),
      properties: Object.freeze({
        ok: Object.freeze({ const: true }),
        details: Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: Object.freeze(['tags']),
          properties: Object.freeze({
            tags: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
          }),
        }),
      }),
    }),
    parseOutput: (value) =>
      z
        .strictObject({
          ok: z.literal(true),
          details: z.strictObject({ tags: z.array(z.string()) }),
        })
        .parse(value),
    blocks: Object.freeze([
      Object.freeze({ role: 'system', kind: 'instruction', text: '고정 지시' }),
      Object.freeze({ role: 'user', kind: 'source', text: '민감한 강의 본문' }),
    ]),
    timeoutMs: 30_000,
    maxOutputTokens: 100,
    signal: new AbortController().signal,
  });
