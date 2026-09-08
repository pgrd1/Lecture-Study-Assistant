import { describe, expect, it, vi } from 'vitest';
import {
  type AiProviderAdapter,
  type CliRuntimeBinding,
  createProviderOperation,
  type ProviderDiagnostic,
} from '../../../src/core/ports/aiProvider';
import {
  PROVIDER_PROBE_JSON_SCHEMA,
  PROVIDER_PROBE_PROMPT,
  ProviderProbeOutputSchema,
} from '../../../src/core/providers/providerProbe';
import {
  AI_FEATURES,
  AI_PROVIDER_IDS,
  API_PROVIDER_IDS,
  type ApiProviderIdRequest,
  CLI_PROVIDER_IDS,
  type CliProviderIdRequest,
  DEFAULT_PROVIDER_ROUTES,
  FEATURE_DATA_DISCLOSURES,
  OpenProviderLoginRequestSchema,
  ProbeProviderRequestSchema,
  ProviderCardStateSchema,
  ProviderHelpRequestSchema,
  type ProviderIdRequest,
  ProviderModelListStateSchema,
  ProviderModelSchema,
  ProviderSettingsStateSchema,
  parseSafeSemVer,
  SaveProviderRouteRequestSchema,
  SaveProviderSecretRequestSchema,
} from '../../../src/shared/contracts/provider';
import { ProviderInvocationSchema } from '../../../src/shared/contracts/providerInvocation';
import { APP_ERROR_RETRY_POLICY, PROVIDER_ERROR_CODES } from '../../../src/shared/errors';

describe('provider contracts', () => {
  it('allows the reviewed Codex image choice beside its text default while rejecting duplicate, unknown and wrong-provider mixes', () => {
    const models = [
      { modelId: null, displayName: 'Codex CLI 로그인 기본 모델', compatibility: 'unverified' },
      {
        modelId: 'gpt-5.5-2026-04-23',
        displayName: 'GPT-5.5 이미지 입력',
        compatibility: 'unverified',
      },
    ];
    expect(
      ProviderModelListStateSchema.parse({ providerId: 'codex_cli', models, checkedAt: null })
        .models,
    ).toHaveLength(2);
    for (const input of [
      { providerId: 'gemini_cli', models },
      { providerId: 'openai_api', models },
      { providerId: 'codex_cli', models: [...models, models[1]] },
      { providerId: 'codex_cli', models: [models[0], { ...models[1], modelId: 'unknown' }] },
    ])
      expect(() => ProviderModelListStateSchema.parse({ ...input, checkedAt: null })).toThrow();
  });
  it('allows ProviderModel null IDs only for either exact unverified CLI sentinel shape', () => {
    for (const displayName of ['CLI 기본 모델', 'Codex CLI 로그인 기본 모델'] as const) {
      expect(
        ProviderModelSchema.parse({ modelId: null, displayName, compatibility: 'unverified' }),
      ).toEqual({ modelId: null, displayName, compatibility: 'unverified' });
    }
    for (const model of [
      { modelId: null, displayName: '기본 모델', compatibility: 'unverified' },
      { modelId: null, displayName: 'CLI 기본 모델', compatibility: 'incompatible' },
      {
        modelId: null,
        displayName: 'CLI 기본 모델',
        compatibility: 'unverified',
        account: 'hidden',
      },
    ]) {
      expect(() => ProviderModelSchema.parse(model)).toThrow();
    }
  });

  it('accepts only the provider-owned singleton CLI default-model sentinels', () => {
    expect(
      ProviderModelListStateSchema.parse({
        providerId: 'gemini_cli',
        models: [{ modelId: null, displayName: 'CLI 기본 모델', compatibility: 'unverified' }],
        checkedAt: null,
      }).models,
    ).toEqual([{ modelId: null, displayName: 'CLI 기본 모델', compatibility: 'unverified' }]);
    expect(
      ProviderModelListStateSchema.parse({
        providerId: 'codex_cli',
        models: [
          {
            modelId: null,
            displayName: 'Codex CLI 로그인 기본 모델',
            compatibility: 'unverified',
          },
        ],
        checkedAt: null,
      }).models,
    ).toEqual([
      {
        modelId: null,
        displayName: 'Codex CLI 로그인 기본 모델',
        compatibility: 'unverified',
      },
    ]);
  });

  it.each([
    [
      'gemini_cli',
      [{ modelId: null, displayName: 'Codex CLI 로그인 기본 모델', compatibility: 'unverified' }],
    ],
    ['codex_cli', [{ modelId: null, displayName: 'CLI 기본 모델', compatibility: 'unverified' }]],
    [
      'antigravity_cli',
      [{ modelId: null, displayName: 'CLI 기본 모델', compatibility: 'unverified' }],
    ],
    ['gemini_api', [{ modelId: null, displayName: 'CLI 기본 모델', compatibility: 'unverified' }]],
    ['openai_api', [{ modelId: null, displayName: 'CLI 기본 모델', compatibility: 'unverified' }]],
    ['claude_api', [{ modelId: null, displayName: 'CLI 기본 모델', compatibility: 'unverified' }]],
    [
      'gemini_cli',
      [
        { modelId: null, displayName: 'CLI 기본 모델', compatibility: 'unverified' },
        { modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', compatibility: 'unverified' },
      ],
    ],
    ['gemini_cli', [{ modelId: null, displayName: 'CLI 기본 모델', compatibility: 'compatible' }]],
    [
      'gemini_cli',
      [{ modelId: null, displayName: 'CLI 기본 모델', compatibility: 'incompatible' }],
    ],
    [
      'gemini_cli',
      [
        {
          modelId: null,
          displayName: 'CLI 기본 모델',
          compatibility: 'unverified',
          account: 'hidden',
        },
      ],
    ],
  ] as const)('rejects an invalid null-model sentinel for %s', (providerId, models) => {
    expect(() =>
      ProviderModelListStateSchema.parse({ providerId, models, checkedAt: null }),
    ).toThrow();
  });

  it('keeps ordinary models and rejects duplicate string model IDs', () => {
    const ordinary = {
      modelId: 'gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      compatibility: 'compatible',
    } as const;
    expect(
      ProviderModelListStateSchema.parse({
        providerId: 'gemini_cli',
        models: [ordinary],
        checkedAt: null,
      }).models,
    ).toEqual([ordinary]);
    expect(() =>
      ProviderModelListStateSchema.parse({
        providerId: 'gemini_cli',
        models: [ordinary, { ...ordinary, displayName: 'Gemini Pro' }],
        checkedAt: null,
      }),
    ).toThrow();
  });

  it('prevents CLI binding crossover in inspection and diagnostic contracts', () => {
    const geminiBinding = {
      providerId: 'gemini_cli',
      canonicalLauncherPath: 'C:\\Program Files\\Gemini\\gemini.exe',
      canonicalEntryPath: null,
      canonicalPackageManifestPath: null,
      canonicalPlatformPackageManifestPath: null,
      fixedPrefixArgs: [],
      version: parseSafeSemVer('1.2.3'),
      launcherSha256: 'a'.repeat(64),
      entrySha256: null,
      packageManifestSha256: null,
      platformPackageManifestSha256: null,
      bindingSha256: 'b'.repeat(64),
      recipeId: 'gemini-cli-v1',
      credentialScope: 'provider_global',
      signerClassification: 'nodejs',
      checkedAt: '2026-09-02T00:00:00.000Z',
    } satisfies CliRuntimeBinding<'gemini_cli'>;

    const mismatchedDiagnostic = {
      providerId: 'codex_cli',
      status: 'ready',
      version: parseSafeSemVer('1.2.3'),
      selectedModelId: null,
      reportedModelId: null,
      credentialPresent: true,
      checkedAt: '2026-09-02T00:00:00.000Z',
      latencyMs: null,
      errorCode: null,
      revision: 0,
      credentialScope: 'provider_global',
      sharedCredentialConsentAt: null,
      sharedCredentialConsentVersion: null,
      cliBinding: geminiBinding,
      providerManagedHistory: false,
    } as const;
    const mismatchedInspection = {
      status: 'ready',
      version: parseSafeSemVer('1.2.3'),
      credentialPresent: true,
      credentialScope: 'provider_global',
      cliBinding: geminiBinding,
      providerManagedHistory: false,
    } as const;
    const mismatchedAdapter = {
      id: 'codex_cli',
      inspect: async () => mismatchedInspection,
      listModels: async () => [],
      probe: async () => {
        throw new Error('not called');
      },
      execute: async () => {
        throw new Error('not called');
      },
      cancel: () => undefined,
    } as const;
    const codexBinding = {
      ...geminiBinding,
      providerId: 'codex_cli',
      recipeId: 'codex-cli-v1',
      credentialScope: 'profile_scoped',
      signerClassification: 'openai',
    } satisfies CliRuntimeBinding<'codex_cli', 'profile_scoped'>;
    // @ts-expect-error Codex bindings are always profile-scoped.
    const invalidCodexCredentialScope: CliRuntimeBinding<'codex_cli', 'provider_global'> =
      Object.freeze({ ...codexBinding, credentialScope: 'provider_global' as const });
    // @ts-expect-error Gemini bindings are always provider-global.
    const invalidGeminiCredentialScope: CliRuntimeBinding<'gemini_cli', 'profile_scoped'> =
      Object.freeze({ ...geminiBinding, credentialScope: 'profile_scoped' as const });
    // @ts-expect-error The default CLI binding union remains provider/scope-correlated.
    const invalidDefaultCredentialScope: CliRuntimeBinding = Object.freeze({
      ...codexBinding,
      credentialScope: 'provider_global' as const,
    });
    const validGeminiAdapter = {
      ...mismatchedAdapter,
      id: 'gemini_cli',
      inspect: async () => mismatchedInspection,
    } as const;
    const validCodexAdapter = {
      ...mismatchedAdapter,
      inspect: async () => ({
        ...mismatchedInspection,
        credentialScope: 'profile_scoped' as const,
        cliBinding: codexBinding,
      }),
    } as const;
    const validAdapters = [
      validGeminiAdapter,
      validCodexAdapter,
    ] satisfies readonly AiProviderAdapter[];

    // @ts-expect-error codex diagnostics must not carry a Gemini binding.
    const invalidDiagnostic: ProviderDiagnostic = mismatchedDiagnostic;
    // @ts-expect-error a Codex adapter must not report a Gemini binding.
    const invalidInspection: Awaited<ReturnType<AiProviderAdapter<'codex_cli'>['inspect']>> =
      mismatchedInspection;
    // @ts-expect-error the default adapter contract must preserve id/inspection correlation.
    const invalidAdapter: AiProviderAdapter = mismatchedAdapter;

    void invalidDiagnostic;
    void invalidInspection;
    void invalidAdapter;
    void invalidCodexCredentialScope;
    void invalidGeminiCredentialScope;
    void invalidDefaultCredentialScope;
    expect(validAdapters.map((adapter) => adapter.id)).toEqual(['gemini_cli', 'codex_cli']);
  });

  it('preserves seven legacy features and adds nine pipeline features with six providers', () => {
    expect(AI_FEATURES).toEqual([
      'content_classification',
      'media_extraction',
      'topic_clustering',
      'source_question_extraction',
      'question_variation',
      'course_question_answer',
      'audio_transcription',
      'document_recognition',
      'core_summary',
      'lecture_organize',
      'lecture_verify',
      'professor_profile',
      'exam_synthesis',
      'question_generation',
      'answer_verification',
      'grading_feedback',
    ]);
    expect(AI_PROVIDER_IDS).toEqual([
      'antigravity_cli',
      'gemini_cli',
      'codex_cli',
      'gemini_api',
      'openai_api',
      'claude_api',
    ]);
    expect(CLI_PROVIDER_IDS).toEqual(['antigravity_cli', 'gemini_cli', 'codex_cli']);
    expect(API_PROVIDER_IDS).toEqual(['gemini_api', 'openai_api', 'claude_api']);
  });

  it('recommends but does not auto-enable Antigravity for generation routes', () => {
    expect(DEFAULT_PROVIDER_ROUTES.lecture_organize.providerId).toBe('antigravity_cli');
    expect(DEFAULT_PROVIDER_ROUTES.lecture_organize.enabled).toBe(false);
    expect(DEFAULT_PROVIDER_ROUTES.professor_profile.providerId).toBe('antigravity_cli');
    expect(DEFAULT_PROVIDER_ROUTES.lecture_verify.providerId).toBeNull();
    expect(DEFAULT_PROVIDER_ROUTES.answer_verification.providerId).toBeNull();
  });

  it.each([
    ['lecture_organize', 'antigravity_cli'],
    ['lecture_verify', null],
    ['professor_profile', 'antigravity_cli'],
    ['exam_synthesis', 'antigravity_cli'],
    ['question_generation', 'antigravity_cli'],
    ['answer_verification', null],
    ['grading_feedback', 'antigravity_cli'],
  ] as const)('keeps the explicit default route for %s', (feature, providerId) => {
    expect(DEFAULT_PROVIDER_ROUTES[feature]).toMatchObject({
      feature,
      providerId,
      modelId: null,
      enabled: false,
      revision: 0,
    });
  });

  it('defines a Korean data disclosure for every feature', () => {
    expect(Object.keys(FEATURE_DATA_DISCLOSURES)).toEqual(AI_FEATURES);
    expect(FEATURE_DATA_DISCLOSURES.lecture_organize).toContain('강의 전사문');
    expect(FEATURE_DATA_DISCLOSURES.grading_feedback).toContain('사용자 답안');
  });

  it('requires explicit confirmation flags and rejects every unknown field', () => {
    expect(() =>
      SaveProviderRouteRequestSchema.parse({
        feature: 'lecture_organize',
        providerId: 'openai_api',
        modelId: 'gpt-5.5',
        enabled: true,
        expectedRevision: 0,
      }),
    ).toThrow();
    expect(() =>
      ProviderSettingsStateSchema.parse({ routes: [], providers: [], secret: 'leak' }),
    ).toThrow();
  });

  it('keeps API secrets as untrimmed visible ASCII up to 8192 characters', () => {
    expect(
      SaveProviderSecretRequestSchema.parse({ providerId: 'openai_api', secret: 'x' }),
    ).toEqual({
      providerId: 'openai_api',
      secret: 'x',
    });
    expect(
      SaveProviderSecretRequestSchema.parse({
        providerId: 'claude_api',
        secret: '!'.repeat(8192),
      }).secret,
    ).toHaveLength(8192);

    for (const secret of ['', ' ', ' key ', '\t', '\n', '한글', 'x'.repeat(8193)]) {
      expect(() =>
        SaveProviderSecretRequestSchema.parse({ providerId: 'gemini_api', secret }),
      ).toThrow();
    }
    expect(
      SaveProviderSecretRequestSchema.parse({ providerId: 'gemini_api', secret: '!key!' }).secret,
    ).toBe('!key!');
  });

  it('exports typed provider ID request shapes for the application facade', () => {
    const provider: ProviderIdRequest = { providerId: 'codex_cli' };
    const api: ApiProviderIdRequest = { providerId: 'openai_api' };
    const cli: CliProviderIdRequest = { providerId: 'gemini_cli' };

    expect(provider.providerId).toBe('codex_cli');
    expect(api.providerId).toBe('openai_api');
    expect(cli.providerId).toBe('gemini_cli');
  });

  it.each([
    ['gemini_api', null],
    ['openai_api', null],
    ['claude_api', null],
  ] as const)('rejects an API route without a model for %s', (providerId, modelId) => {
    expect(() =>
      SaveProviderRouteRequestSchema.parse({
        feature: 'lecture_organize',
        providerId,
        modelId,
        enabled: true,
        expectedRevision: 0,
        confirmNotReady: false,
        confirmProviderManagedHistory: false,
      }),
    ).toThrow();
  });

  it('keeps public cards free of private credential and executable fields', () => {
    expect(() =>
      ProviderCardStateSchema.parse({
        providerId: 'codex_cli',
        kind: 'cli',
        displayName: 'Codex CLI',
        notices: ['Codex CLI 로그인과 OpenAI API 키·과금은 별도입니다.'],
        status: 'not_checked',
        errorCode: null,
        version: null,
        selectedModelId: null,
        reportedModelId: null,
        credentialPresent: false,
        checkedAt: null,
        providerManagedHistory: false,
        credentialScope: 'unknown',
        sharedCredentialConsentRequired: false,
        canonicalLauncherPath: 'C:\\secret.exe',
      }),
    ).toThrow();
  });

  it.each([
    'not_checked',
    'installed',
    'credential_saved',
    'missing_executable',
    'missing_credential',
    'unsafe_version',
    'ready',
    'auth_required',
    'account_unsupported',
    'incompatible_model',
    'quota_or_billing',
    'temporarily_unavailable',
    'invalid_provider_output',
  ] as const)('allows the normalized provider status %s without private fields', (status) => {
    expect(
      ProviderCardStateSchema.parse({
        providerId: 'openai_api',
        kind: 'api',
        displayName: 'OpenAI API',
        notices: ['API 키는 운영체제 보안 저장소에만 저장합니다.'],
        status,
        errorCode: null,
        version: null,
        selectedModelId: null,
        reportedModelId: null,
        credentialPresent: false,
        checkedAt: null,
        providerManagedHistory: false,
        credentialScope: 'not_applicable',
        sharedCredentialConsentRequired: false,
      }),
    ).toMatchObject({ status });
  });

  it('rejects provider-controlled public text instead of normalizing it into card state', () => {
    const card = {
      providerId: 'openai_api',
      kind: 'api',
      displayName: 'OpenAI API',
      notices: ['API 키는 운영체제 보안 저장소에만 저장합니다.'],
      status: 'not_checked',
      errorCode: null,
      version: null,
      selectedModelId: null,
      reportedModelId: null,
      credentialPresent: false,
      checkedAt: null,
      providerManagedHistory: false,
      credentialScope: 'not_applicable',
      sharedCredentialConsentRequired: false,
    } as const;

    expect(() =>
      ProviderCardStateSchema.parse({ ...card, displayName: 'Vendor supplied account' }),
    ).toThrow();
    expect(() =>
      ProviderCardStateSchema.parse({ ...card, notices: ['provider path C:\\secret'] }),
    ).toThrow();
    expect(() =>
      ProviderModelSchema.parse({
        modelId: 'model-1',
        displayName: '\nModel',
        compatibility: 'unverified',
      }),
    ).toThrow();
  });

  it('fails closed for inconsistent CLI credential scope and consent state', () => {
    const card = {
      providerId: 'codex_cli',
      kind: 'cli',
      displayName: 'Codex CLI',
      notices: ['Codex CLI 로그인과 OpenAI API 키·과금은 별도입니다.'],
      status: 'ready',
      errorCode: null,
      version: '1.2.3',
      selectedModelId: null,
      reportedModelId: null,
      credentialPresent: true,
      checkedAt: '2026-09-02T00:00:00.000Z',
      providerManagedHistory: false,
    } as const;

    expect(() =>
      ProviderCardStateSchema.parse({
        ...card,
        credentialScope: 'unknown',
        sharedCredentialConsentRequired: false,
      }),
    ).toThrow();
    expect(() =>
      ProviderCardStateSchema.parse({
        ...card,
        credentialScope: 'not_applicable',
        sharedCredentialConsentRequired: false,
      }),
    ).toThrow();
    expect(() =>
      ProviderCardStateSchema.parse({
        ...card,
        credentialScope: 'profile_scoped',
        sharedCredentialConsentRequired: true,
      }),
    ).toThrow();
  });

  it.each([
    ['profile_scoped', false, 'ready', '1.2.3', true],
    ['unknown', true, 'missing_credential', null, false],
  ] as const)(
    'accepts the safe CLI card combination for %s scope',
    (credentialScope, sharedCredentialConsentRequired, status, version, credentialPresent) => {
      expect(
        ProviderCardStateSchema.parse({
          providerId: 'codex_cli',
          kind: 'cli',
          displayName: 'Codex CLI',
          notices: ['Codex CLI 로그인과 OpenAI API 키·과금은 별도입니다.'],
          status,
          errorCode: null,
          version,
          selectedModelId: null,
          reportedModelId: null,
          credentialPresent,
          checkedAt: null,
          providerManagedHistory: false,
          credentialScope,
          sharedCredentialConsentRequired,
        }),
      ).toMatchObject({ credentialScope, status });
    },
  );

  it.each([true, false])(
    'accepts a provider-global CLI card with consent-required set to %s',
    (sharedCredentialConsentRequired) => {
      expect(() =>
        ProviderCardStateSchema.parse({
          providerId: 'codex_cli',
          kind: 'cli',
          displayName: 'Codex CLI',
          notices: ['Codex CLI 로그인과 OpenAI API 키·과금은 별도입니다.'],
          status: 'ready',
          errorCode: null,
          version: '1.2.3',
          selectedModelId: null,
          reportedModelId: null,
          credentialPresent: true,
          checkedAt: null,
          providerManagedHistory: false,
          credentialScope: 'provider_global',
          sharedCredentialConsentRequired,
        }),
      ).not.toThrow();
    },
  );

  it('rejects an unknown CLI card outside its fail-closed state set', () => {
    const card = {
      providerId: 'codex_cli',
      kind: 'cli',
      displayName: 'Codex CLI',
      notices: ['Codex CLI 로그인과 OpenAI API 키·과금은 별도입니다.'],
      errorCode: null,
      selectedModelId: null,
      reportedModelId: null,
      checkedAt: null,
      providerManagedHistory: false,
    } as const;

    expect(() =>
      ProviderCardStateSchema.parse({
        ...card,
        status: 'installed',
        version: null,
        credentialPresent: false,
        credentialScope: 'unknown',
        sharedCredentialConsentRequired: true,
      }),
    ).toThrow();
  });

  it('accepts normalized SemVer build metadata and rejects numeric prerelease identifiers', () => {
    const card = {
      providerId: 'codex_cli',
      kind: 'cli',
      displayName: 'Codex CLI',
      notices: ['Codex CLI 로그인과 OpenAI API 키·과금은 별도입니다.'],
      status: 'installed',
      errorCode: null,
      selectedModelId: null,
      reportedModelId: null,
      credentialPresent: false,
      checkedAt: null,
      providerManagedHistory: false,
      credentialScope: 'profile_scoped',
      sharedCredentialConsentRequired: false,
    } as const;

    expect(ProviderCardStateSchema.parse({ ...card, version: '1.2.3+build.1' }).version).toBe(
      '1.2.3+build.1',
    );
    expect(() => ProviderCardStateSchema.parse({ ...card, version: '1.2.3-01' })).toThrow();
  });

  it.each([
    ['PROVIDER_ACCOUNT_UNSUPPORTED', false],
    ['PROVIDER_AUTH_REQUIRED', false],
    ['PROVIDER_BUSY', true],
    ['PROVIDER_CANCELLED', false],
    ['PROVIDER_CLI_CHANGED', false],
    ['PROVIDER_DATA_RETENTION_CONSENT_REQUIRED', false],
    ['PROVIDER_EXECUTABLE_NOT_FOUND', false],
    ['PROVIDER_EXECUTION_FAILED', false],
    ['PROVIDER_LOGIN_TERMINAL_UNAVAILABLE', false],
    ['PROVIDER_MODEL_INCOMPATIBLE', false],
    ['PROVIDER_NETWORK_FAILED', true],
    ['PROVIDER_NOT_CONFIGURED', false],
    ['PROVIDER_NOT_READY', false],
    ['PROVIDER_OUTPUT_INVALID', false],
    ['PROVIDER_QUOTA_OR_BILLING', false],
    ['PROVIDER_RATE_LIMITED', true],
    ['PROVIDER_REFUSED', false],
    ['PROVIDER_REQUEST_TOO_LARGE', false],
    ['PROVIDER_RESIDUAL_DATA', false],
    ['PROVIDER_RESPONSE_TOO_LARGE', false],
    ['PROVIDER_SHARED_CREDENTIAL_CONSENT_REQUIRED', false],
    ['PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED', false],
    ['PROVIDER_TEMPORARILY_UNAVAILABLE', true],
    ['PROVIDER_TIMEOUT', true],
    ['PROVIDER_TOOL_ACTIVITY_DETECTED', false],
    ['PROVIDER_UNSAFE_VERSION', false],
  ] as const)('sets the public retry policy for %s', (code, retryable) => {
    expect(PROVIDER_ERROR_CODES).toContain(code);
    expect(APP_ERROR_RETRY_POLICY[code]).toBe(retryable);
  });

  it('requires explicit consent booleans for probe and CLI login', () => {
    expect(() =>
      ProbeProviderRequestSchema.parse({ providerId: 'codex_cli', modelId: null }),
    ).toThrow();
    expect(() => OpenProviderLoginRequestSchema.parse({ providerId: 'codex_cli' })).toThrow();
  });

  it('accepts only provider help topics without renderer-controlled URLs', () => {
    expect(() =>
      ProviderHelpRequestSchema.parse({
        providerId: 'openai_api',
        topic: 'setup',
        url: 'https://example.invalid',
      }),
    ).toThrow();
  });

  it('uses the sole fixed connection probe request and closed output schema', () => {
    expect(PROVIDER_PROBE_PROMPT).toBe(
      '연결을 확인합니다. 정확히 { "ok": true } JSON만 응답하세요.',
    );
    expect(PROVIDER_PROBE_JSON_SCHEMA).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { const: true } },
    });
    expect(ProviderProbeOutputSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(() => ProviderProbeOutputSchema.parse({ ok: true, account: 'private' })).toThrow();
  });

  it('creates only a bounded, closed, copied provider operation', () => {
    const controller = new AbortController();
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { answer: { type: 'string' } },
    } as const;
    const operation = createProviderOperation({
      requestId: '11111111-1111-4111-8111-111111111111',
      feature: 'lecture_organize',
      jobId: null,
      outputSchemaId: 'lecture_output',
      outputJsonSchema: schema,
      parseOutput: (value) => value as { readonly answer: string },
      blocks: [{ role: 'system', kind: 'instruction', text: 'JSON only.' }],
      timeoutMs: 30_000,
      maxOutputTokens: 1,
      signal: controller.signal,
    });

    expect(operation.outputJsonSchema).toEqual(schema);
    expect(operation.outputJsonSchema).not.toBe(schema);
    expect(Object.isFrozen(operation.outputJsonSchema)).toBe(true);
    expect(Object.isFrozen(operation.blocks)).toBe(true);
  });

  it('copies nested JSON schema values without preserving mutable numeric edge values', () => {
    const operation = createProviderOperation({
      requestId: '11111111-1111-4111-8111-111111111111',
      feature: 'lecture_organize',
      jobId: null,
      outputSchemaId: 'lecture_output',
      outputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        examples: ['한글', true, null, -0],
      },
      parseOutput: (value) => value as { readonly answer: string },
      blocks: [],
      timeoutMs: 30_000,
      maxOutputTokens: 1,
      signal: new AbortController().signal,
    });

    expect(operation.outputJsonSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      examples: ['한글', true, null, 0],
    });
    expect(Object.isFrozen(operation.outputJsonSchema.examples)).toBe(true);
  });

  it.each([
    ['invalid UUID', 'not-a-uuid', 30_000, 1, { type: 'object', additionalProperties: false }],
    [
      'short timeout',
      '11111111-1111-4111-8111-111111111111',
      29_999,
      1,
      { type: 'object', additionalProperties: false },
    ],
    [
      'too many tokens',
      '11111111-1111-4111-8111-111111111111',
      30_000,
      65_537,
      { type: 'object', additionalProperties: false },
    ],
    [
      'open schema',
      '11111111-1111-4111-8111-111111111111',
      30_000,
      1,
      { type: 'object', additionalProperties: true },
    ],
    [
      'invalid signal',
      '11111111-1111-4111-8111-111111111111',
      30_000,
      1,
      { type: 'object', additionalProperties: false },
    ],
  ] as const)(
    'rejects a provider operation with %s',
    (_name, requestId, timeoutMs, maxOutputTokens, outputJsonSchema) => {
      expect(() =>
        createProviderOperation({
          requestId,
          feature: 'lecture_organize',
          jobId: null,
          outputSchemaId: 'lecture_output',
          outputJsonSchema,
          parseOutput: (value) => value as { readonly answer: string },
          blocks: [],
          timeoutMs,
          maxOutputTokens,
          signal:
            _name === 'invalid signal'
              ? ({ aborted: false } as AbortSignal)
              : new AbortController().signal,
        }),
      ).toThrow();
    },
  );

  it('rejects unregistered output schemas before an operation can be created', () => {
    expect(() =>
      createProviderOperation({
        requestId: '11111111-1111-4111-8111-111111111111',
        feature: 'lecture_organize',
        jobId: null,
        outputSchemaId: 'unreviewed_schema',
        outputJsonSchema: { type: 'object', additionalProperties: false },
        parseOutput: (value) => value as { readonly answer: string },
        blocks: [],
        timeoutMs: 30_000,
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      }),
    ).toThrow();
  });

  it('rejects accessor-backed operation descriptors without reading the accessor', () => {
    let reads = 0;
    const descriptor = Object.defineProperty(
      {
        feature: 'lecture_organize',
        jobId: null,
        outputSchemaId: 'lecture_output',
        outputJsonSchema: { type: 'object', additionalProperties: false },
        parseOutput: (value: unknown) => value as { readonly answer: string },
        blocks: [],
        timeoutMs: 30_000,
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      },
      'requestId',
      {
        enumerable: true,
        get: () => {
          reads += 1;
          return '11111111-1111-4111-8111-111111111111';
        },
      },
    );

    expect(() => createProviderOperation(descriptor as never)).toThrow();
    expect(reads).toBe(0);
  });

  it('rejects accessor-backed text blocks without reading their text', () => {
    let reads = 0;
    const block = Object.defineProperty({ role: 'system', kind: 'instruction' }, 'text', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'never read';
      },
    });

    expect(() =>
      createProviderOperation({
        requestId: '11111111-1111-4111-8111-111111111111',
        feature: 'lecture_organize',
        jobId: null,
        outputSchemaId: 'lecture_output',
        outputJsonSchema: { type: 'object', additionalProperties: false },
        parseOutput: (value) => value as { readonly answer: string },
        blocks: [block] as never,
        timeoutMs: 30_000,
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      }),
    ).toThrow();
    expect(reads).toBe(0);
  });

  it('rejects accessor-backed block arrays without reading their entries', () => {
    let reads = 0;
    const blocks = [] as unknown[];
    Object.defineProperty(blocks, '0', {
      enumerable: true,
      get: () => {
        reads += 1;
        return { role: 'system', kind: 'instruction', text: 'never read' };
      },
    });
    blocks.length = 1;

    expect(() =>
      createProviderOperation({
        requestId: '11111111-1111-4111-8111-111111111111',
        feature: 'lecture_organize',
        jobId: null,
        outputSchemaId: 'lecture_output',
        outputJsonSchema: { type: 'object', additionalProperties: false },
        parseOutput: (value) => value as { readonly answer: string },
        blocks: blocks as never,
        timeoutMs: 30_000,
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      }),
    ).toThrow();
    expect(reads).toBe(0);
  });

  it('rejects hidden operation descriptor properties without reading them', () => {
    let reads = 0;
    const descriptor = Object.defineProperty(
      {
        requestId: '11111111-1111-4111-8111-111111111111',
        feature: 'lecture_organize',
        jobId: null,
        outputSchemaId: 'lecture_output',
        outputJsonSchema: { type: 'object', additionalProperties: false },
        parseOutput: (value: unknown) => value as { readonly answer: string },
        blocks: [],
        timeoutMs: 30_000,
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      },
      'hidden',
      {
        enumerable: false,
        get: () => {
          reads += 1;
          return 'never read';
        },
      },
    );

    expect(() => createProviderOperation(descriptor as never)).toThrow();
    expect(reads).toBe(0);
  });

  it('rejects an oversized enumerable operation descriptor before requesting a full key snapshot', () => {
    const extras = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`extra_${index}`, null]),
    );
    const descriptor = {
      requestId: '11111111-1111-4111-8111-111111111111',
      feature: 'lecture_organize',
      jobId: null,
      outputSchemaId: 'lecture_output',
      outputJsonSchema: { type: 'object', additionalProperties: false },
      parseOutput: (value: unknown) => value as { readonly answer: string },
      blocks: [],
      timeoutMs: 30_000,
      maxOutputTokens: 1,
      signal: new AbortController().signal,
      ...extras,
    };
    const originalOwnKeys = Reflect.ownKeys;
    const ownKeysSpy = vi.spyOn(Reflect, 'ownKeys').mockImplementation((target) => {
      if (target === descriptor) {
        throw new Error('UNBOUNDED_KEY_SNAPSHOT');
      }
      return originalOwnKeys(target);
    });
    let thrown: unknown;

    try {
      createProviderOperation(descriptor as never);
    } catch (error) {
      thrown = error;
    } finally {
      ownKeysSpy.mockRestore();
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
  });

  it('rejects symbol-backed block array properties before copying blocks', () => {
    const blocks = [{ role: 'system', kind: 'instruction', text: 'fixed' }];
    Object.defineProperty(blocks, Symbol('hidden'), {
      enumerable: false,
      value: 'never copied',
    });

    expect(() =>
      createProviderOperation({
        requestId: '11111111-1111-4111-8111-111111111111',
        feature: 'lecture_organize',
        jobId: null,
        outputSchemaId: 'lecture_output',
        outputJsonSchema: { type: 'object', additionalProperties: false },
        parseOutput: (value) => value as { readonly answer: string },
        blocks: blocks as never,
        timeoutMs: 30_000,
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      }),
    ).toThrow();
  });

  it('rejects hidden JSON-schema properties without reading their accessors', () => {
    let reads = 0;
    const schema = Object.defineProperty(
      { type: 'object', additionalProperties: false },
      'hidden',
      {
        enumerable: false,
        get: () => {
          reads += 1;
          return 'never read';
        },
      },
    );

    expect(() =>
      createProviderOperation({
        requestId: '11111111-1111-4111-8111-111111111111',
        feature: 'lecture_organize',
        jobId: null,
        outputSchemaId: 'lecture_output',
        outputJsonSchema: schema,
        parseOutput: (value) => value as { readonly answer: string },
        blocks: [],
        timeoutMs: 30_000,
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      }),
    ).toThrow();
    expect(reads).toBe(0);
  });

  it('enforces the schema entry cap before requesting a full object-key snapshot', () => {
    const oversizedProperties = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`field_${index}`, null]),
    );
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: oversizedProperties,
    } as const;
    const originalOwnKeys = Reflect.ownKeys;
    const ownKeysSpy = vi.spyOn(Reflect, 'ownKeys').mockImplementation((target) => {
      if (target === oversizedProperties) {
        throw new Error('UNBOUNDED_KEY_SNAPSHOT');
      }
      return originalOwnKeys(target);
    });
    let thrown: unknown;

    try {
      createProviderOperation({
        requestId: '11111111-1111-4111-8111-111111111111',
        feature: 'lecture_organize',
        jobId: null,
        outputSchemaId: 'lecture_output',
        outputJsonSchema: schema,
        parseOutput: (value) => value as { readonly answer: string },
        blocks: [],
        timeoutMs: 30_000,
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      });
    } catch (error) {
      thrown = error;
    } finally {
      ownKeysSpy.mockRestore();
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe('PROVIDER_OUTPUT_SCHEMA_TOO_LARGE');
  });

  it('rejects unbounded extra array properties before requesting a full key snapshot', () => {
    const arrayProperties = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [
        `extra_${index}`,
        { enumerable: true, value: null },
      ]),
    );
    const examples = Object.defineProperties([], arrayProperties);
    const originalOwnKeys = Reflect.ownKeys;
    const ownKeysSpy = vi.spyOn(Reflect, 'ownKeys').mockImplementation((target) => {
      if (target === examples) {
        throw new Error('UNBOUNDED_KEY_SNAPSHOT');
      }
      return originalOwnKeys(target);
    });
    let thrown: unknown;

    try {
      createProviderOperation({
        requestId: '11111111-1111-4111-8111-111111111111',
        feature: 'lecture_organize',
        jobId: null,
        outputSchemaId: 'lecture_output',
        outputJsonSchema: {
          type: 'object',
          additionalProperties: false,
          examples,
        },
        parseOutput: (value) => value as { readonly answer: string },
        blocks: [],
        timeoutMs: 30_000,
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      });
    } catch (error) {
      thrown = error;
    } finally {
      ownKeysSpy.mockRestore();
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe('INVALID_PROVIDER_OUTPUT_SCHEMA');
  });

  it('rejects coercion-backed block kinds without invoking their coercion hook', () => {
    let coercions = 0;
    const kind = {
      [Symbol.toPrimitive]: () => {
        coercions += 1;
        return 'instruction';
      },
    };

    expect(() =>
      createProviderOperation({
        requestId: '11111111-1111-4111-8111-111111111111',
        feature: 'lecture_organize',
        jobId: null,
        outputSchemaId: 'lecture_output',
        outputJsonSchema: { type: 'object', additionalProperties: false },
        parseOutput: (value) => value as { readonly answer: string },
        blocks: [{ role: 'system', kind, text: 'fixed' } as never],
        timeoutMs: 30_000,
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      }),
    ).toThrow();
    expect(coercions).toBe(0);
  });

  it('rejects a schema whose exact UTF-8 JSON is larger than 256 KiB', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 4_500 }, (_, index) => [
        `field_${String(index).padStart(32, '0')}`,
        { type: 'string' },
      ]),
    );
    const schema = { type: 'object', additionalProperties: false, properties };

    expect(Buffer.byteLength(JSON.stringify(schema), 'utf8')).toBeGreaterThan(256 * 1024);
    expect(() =>
      createProviderOperation({
        requestId: '11111111-1111-4111-8111-111111111111',
        feature: 'lecture_organize',
        jobId: null,
        outputSchemaId: 'lecture_output',
        outputJsonSchema: schema,
        parseOutput: (value) => value as { readonly answer: string },
        blocks: [],
        timeoutMs: 30_000,
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      }),
    ).toThrow('PROVIDER_OUTPUT_SCHEMA_TOO_LARGE');
  });

  it('requires matching invocation completion state without content fields', () => {
    const running = {
      id: '11111111-1111-4111-8111-111111111111',
      requestId: '22222222-2222-4222-8222-222222222222',
      jobId: null,
      feature: 'lecture_organize',
      providerId: 'openai_api',
      selectedModelId: 'gpt-5.5',
      reportedModelId: null,
      promptVersion: 'v1',
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
      startedAt: '2026-09-02T00:00:00.000Z',
      completedAt: null,
      revision: 0,
    } as const;

    expect(ProviderInvocationSchema.parse(running)).toMatchObject({ status: 'running' });
    expect(() =>
      ProviderInvocationSchema.parse({
        ...running,
        status: 'completed',
        completedAt: '2026-09-02T00:00:01.000Z',
      }),
    ).toThrow();
    expect(
      ProviderInvocationSchema.parse({
        ...running,
        status: 'failed',
        errorCode: 'PROVIDER_TIMEOUT',
        completedAt: '2026-09-02T00:00:01.000Z',
        latencyMs: 1,
      }),
    ).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_TIMEOUT' });
  });
});
