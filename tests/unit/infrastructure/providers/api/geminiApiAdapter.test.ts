import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ProviderConnectionOperation,
  ProviderRequest,
} from '../../../../../src/core/ports/aiProvider';
import type {
  SecretKey,
  SecretStore,
  SecretStoreOperation,
} from '../../../../../src/core/ports/secretStore';
import { createGeminiApiAdapterForTest } from '../../../../../src/infrastructure/providers/api/geminiApiAdapter';
import type {
  ProviderHttpClient,
  ProviderHttpRequest,
} from '../../../../../src/infrastructure/providers/api/providerHttpClient';
import type { JsonValue } from '../../../../../src/shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../../../src/shared/errors';

const FIXED_NOW = '2026-09-03T00:00:00.000Z';
const MODEL_ID = 'gemini-3.5-flash';
const PRIVATE_KEY_ONE = 'fixed-private-gemini-key-one';
const PRIVATE_KEY_TWO = 'fixed-private-gemini-key-two';
const PRIVATE_SOURCE = 'private source with ]} delimiter-like text';

const geminiSuccess = (text = '{"ok":true}', model = MODEL_ID): JsonValue =>
  Object.freeze({
    id: 'discarded-private-interaction-id',
    object: 'interaction',
    created: FIXED_NOW,
    updated: '2026-09-03T00:00:01.000Z',
    status: 'completed',
    model,
    errors: Object.freeze([]),
    steps: Object.freeze([
      Object.freeze({
        type: 'model_output',
        content: Object.freeze([Object.freeze({ type: 'text', text })]),
      }),
    ]),
    usage: Object.freeze({
      total_input_tokens: 3,
      total_output_tokens: 2,
      total_tokens: 5,
      total_tool_use_tokens: 0,
    }),
  });

type QueuedHttpResult =
  | Readonly<{ kind: 'value'; value: JsonValue }>
  | Readonly<{ kind: 'failure'; error: unknown }>
  | Readonly<{
      kind: 'handler';
      handler: (request: ProviderHttpRequest) => Promise<JsonValue>;
    }>;

class FakeHttpClient implements ProviderHttpClient {
  calls: readonly ProviderHttpRequest[] = Object.freeze([]);
  #queue: readonly QueuedHttpResult[] = Object.freeze([]);

  get lastRequest(): ProviderHttpRequest | undefined {
    return this.calls.at(-1);
  }

  queue(value: JsonValue): void {
    this.#queue = Object.freeze([...this.#queue, Object.freeze({ kind: 'value', value })]);
  }

  queueFailure(error: unknown): void {
    const queued: QueuedHttpResult = Object.freeze({ kind: 'failure', error });
    this.#queue = Object.freeze([...this.#queue, queued]);
  }

  queueHandler(handler: (request: ProviderHttpRequest) => Promise<JsonValue>): void {
    this.#queue = Object.freeze([...this.#queue, Object.freeze({ kind: 'handler', handler })]);
  }

  async requestJson(request: ProviderHttpRequest): Promise<JsonValue> {
    this.calls = Object.freeze([...this.calls, request]);
    const [next, ...remaining] = this.#queue;
    this.#queue = Object.freeze(remaining);
    if (next === undefined) throw new Error('NO_FAKE_HTTP_RESULT');
    if (next.kind === 'failure') throw next.error;
    if (next.kind === 'handler') return next.handler(request);
    return next.value;
  }
}

class FakeSecretStore implements SecretStore {
  reads: readonly SecretKey[] = Object.freeze([]);
  presenceChecks: readonly SecretKey[] = Object.freeze([]);
  readOperations: readonly SecretStoreOperation[] = Object.freeze([]);
  value: string | undefined = PRIVATE_KEY_ONE;

  async set(_key: SecretKey, value: string, _operation: SecretStoreOperation): Promise<void> {
    this.value = value;
  }

  async get(key: SecretKey, operation: SecretStoreOperation): Promise<string | undefined> {
    this.reads = Object.freeze([...this.reads, key]);
    this.readOperations = Object.freeze([...this.readOperations, operation]);
    return this.value;
  }

  async delete(_key: SecretKey, _operation: SecretStoreOperation): Promise<void> {
    this.value = undefined;
  }

  async has(key: SecretKey, _operation: SecretStoreOperation): Promise<boolean> {
    this.presenceChecks = Object.freeze([...this.presenceChecks, key]);
    return this.value !== undefined;
  }
}

const createRequest = (
  requestId: string = randomUUID(),
  signal: AbortSignal = new AbortController().signal,
  overrides: Partial<ProviderRequest<Readonly<{ ok: true }>>> = {},
): ProviderRequest<Readonly<{ ok: true }>> =>
  Object.freeze({
    requestId,
    feature: 'lecture_organize',
    jobId: null,
    outputSchemaId: 'lecture_output',
    outputJsonSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['ok']),
      properties: Object.freeze({ ok: Object.freeze({ const: true }) }),
    }),
    parseOutput: (value: unknown) => {
      if ((value as { ok?: unknown } | null)?.ok !== true) {
        throw new Error('private local validation failure');
      }
      return { ok: true } as const;
    },
    blocks: Object.freeze([
      Object.freeze({ role: 'system', kind: 'instruction', text: 'System instruction.' }),
      Object.freeze({ role: 'user', kind: 'source', text: PRIVATE_SOURCE }),
      Object.freeze({ role: 'system', kind: 'format_repair', text: 'Return JSON.' }),
    ]),
    timeoutMs: 120_000,
    maxOutputTokens: 1_024,
    signal,
    modelId: MODEL_ID,
    promptVersion: 'lecture-organize-v1',
    routeRevision: 1,
    providerManagedHistoryConsentAt: null,
    providerManagedHistoryConsentVersion: null,
    sharedCredentialConsentAt: null,
    sharedCredentialConsentVersion: null,
    attemptKind: 'initial',
    ...overrides,
  });

const connectionOperation = (
  signal = new AbortController().signal,
  requestId = randomUUID(),
): ProviderConnectionOperation => Object.freeze({ requestId, signal });

const setup = () => {
  const httpClient = new FakeHttpClient();
  const secretStore = new FakeSecretStore();
  let now = FIXED_NOW;
  let milliseconds = 1_000;
  const adapter = createGeminiApiAdapterForTest({
    httpClient,
    secretStore,
    now: () => now,
    nowMilliseconds: () => milliseconds,
  });
  return Object.freeze({
    adapter,
    httpClient,
    secretStore,
    setNow: (value: string) => {
      now = value;
    },
    setMilliseconds: (value: number) => {
      milliseconds = value;
    },
  });
};

const captureFailure = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation;
    throw new Error('EXPECTED_FAILURE');
  } catch (error) {
    return error;
  }
};

const expectFixedFailure = async (
  operation: Promise<unknown>,
  code: string,
  privateValues: readonly string[] = [],
): Promise<unknown> => {
  const failure = await captureFailure(operation);
  expect(failure).toMatchObject({ code });
  const visible = `${String(failure)} ${JSON.stringify(failure)}`;
  for (const value of privateValues) expect(visible).not.toContain(value);
  return failure;
};

describe('GeminiApiAdapter inspection and model listing', () => {
  it('inspects only fixed secret presence and never infers consumer subscription state', async () => {
    const { adapter, httpClient, secretStore } = setup();

    await expect(adapter.inspect(connectionOperation())).resolves.toEqual({
      status: 'credential_saved',
      version: null,
      credentialPresent: true,
      credentialScope: 'not_applicable',
      cliBinding: null,
      providerManagedHistory: false,
    });
    expect(secretStore.presenceChecks).toEqual(['gemini_api_key']);
    expect(secretStore.reads).toEqual([]);
    expect(httpClient.calls).toEqual([]);

    secretStore.value = undefined;
    await expect(adapter.inspect(connectionOperation())).resolves.toMatchObject({
      status: 'missing_credential',
      credentialPresent: false,
    });
  });

  it('lists one bounded metadata page with a just-in-time key and returns candidates unverified', async () => {
    const { adapter, httpClient, secretStore } = setup();
    const operation = connectionOperation();
    httpClient.queue({
      models: [
        {
          name: 'models/gemini-3.5-flash',
          displayName: 'Gemini 3.5 Flash',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    });

    await expect(adapter.listModels(operation)).resolves.toEqual([
      {
        modelId: MODEL_ID,
        displayName: 'Gemini 3.5 Flash',
        compatibility: 'unverified',
      },
    ]);
    expect(secretStore.reads).toEqual(['gemini_api_key']);
    expect(httpClient.lastRequest).toEqual({
      providerId: 'gemini_api',
      endpoint: { id: 'gemini_models' },
      authValue: PRIVATE_KEY_ONE,
      timeoutMs: 30_000,
      responseLimitBytes: 2 * 1024 * 1024,
      signal: expect.any(AbortSignal),
    });
    expect(secretStore.readOperations[0]?.requestId).toBe(operation.requestId);
    expect(secretStore.readOperations[0]?.signal).toBe(httpClient.lastRequest?.signal);
  });

  it('reads key rotation immediately before every model request and never caches pagination', async () => {
    const { adapter, httpClient, secretStore } = setup();
    httpClient.queue({ models: [] });
    httpClient.queue({ models: [] });

    await adapter.listModels(connectionOperation());
    secretStore.value = PRIVATE_KEY_TWO;
    await adapter.listModels(connectionOperation());

    expect(httpClient.calls.map((call) => call.authValue)).toEqual([
      PRIVATE_KEY_ONE,
      PRIVATE_KEY_TWO,
    ]);
    expect(httpClient.calls.every((call) => call.endpoint.id === 'gemini_models')).toBe(true);
  });

  it('rejects a missing key before making a model request', async () => {
    const { adapter, httpClient, secretStore } = setup();
    secretStore.value = undefined;

    await expectFixedFailure(adapter.listModels(connectionOperation()), 'PROVIDER_AUTH_REQUIRED');
    expect(httpClient.calls).toEqual([]);
  });
});

describe('GeminiApiAdapter stateless execution', () => {
  it('uses deterministic role-separated JSON envelopes, an owned schema, and no state or tools', async () => {
    const { adapter, httpClient } = setup();
    const request = createRequest();
    httpClient.queue(geminiSuccess());

    await adapter.execute(request);

    const outbound = httpClient.lastRequest;
    expect(outbound).toMatchObject({
      providerId: 'gemini_api',
      endpoint: { id: 'gemini_interactions' },
      authValue: PRIVATE_KEY_ONE,
      timeoutMs: request.timeoutMs,
      responseLimitBytes: 8 * 1024 * 1024,
      signal: expect.any(AbortSignal),
      body: {
        model: MODEL_ID,
        system_instruction: JSON.stringify({
          blocks: [
            { index: 0, role: 'system', kind: 'instruction', text: 'System instruction.' },
            { index: 2, role: 'system', kind: 'format_repair', text: 'Return JSON.' },
          ],
        }),
        input: JSON.stringify({
          blocks: [{ index: 1, role: 'user', kind: 'source', text: PRIVATE_SOURCE }],
        }),
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: request.outputJsonSchema,
        },
        generation_config: { max_output_tokens: 1_024 },
        tools: [],
        store: false,
        background: false,
        stream: false,
      },
    });
    const body = outbound?.body as Readonly<Record<string, JsonValue>>;
    expect(Object.keys(body).sort()).toEqual(
      [
        'background',
        'generation_config',
        'input',
        'model',
        'response_format',
        'store',
        'stream',
        'system_instruction',
        'tools',
      ].sort(),
    );
    expect(body).not.toHaveProperty('previous_interaction_id');
    expect(body).not.toHaveProperty('history');
    expect(body).not.toHaveProperty('labels');
    expect(body).not.toHaveProperty('agent');
    expect(body).not.toHaveProperty('temperature');
    const responseFormat = body.response_format as Readonly<Record<string, JsonValue>>;
    expect(responseFormat.schema).not.toBe(request.outputJsonSchema);
    expect(Object.isFrozen(responseFormat.schema)).toBe(true);
    expect(JSON.stringify(body.system_instruction)).not.toContain('additionalProperties');
    expect(JSON.stringify(body.input)).not.toContain('additionalProperties');
  });

  it('returns one locally validated result with local completion time and discarded metadata', async () => {
    const { adapter, httpClient } = setup();
    httpClient.queue(geminiSuccess());

    const result = await adapter.execute(createRequest());

    expect(result).toEqual({
      output: { ok: true },
      reportedModelId: MODEL_ID,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      completedAt: FIXED_NOW,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('discarded-private-interaction-id');
  });

  it('does not require or infer CLI shared-login or provider-history consent', async () => {
    const { adapter, httpClient } = setup();
    httpClient.queue(geminiSuccess());
    const request = createRequest(randomUUID(), new AbortController().signal, {
      sharedCredentialConsentAt: null,
      sharedCredentialConsentVersion: null,
      providerManagedHistoryConsentAt: null,
      providerManagedHistoryConsentVersion: null,
    });

    await expect(adapter.execute(request)).resolves.toMatchObject({ reportedModelId: MODEL_ID });
  });

  it('uses a newly read key for every execution', async () => {
    const { adapter, httpClient, secretStore } = setup();
    httpClient.queue(geminiSuccess());
    httpClient.queue(geminiSuccess());

    await adapter.execute(createRequest());
    secretStore.value = PRIVATE_KEY_TWO;
    await adapter.execute(createRequest());

    expect(httpClient.calls.map((call) => call.authValue)).toEqual([
      PRIVATE_KEY_ONE,
      PRIVATE_KEY_TWO,
    ]);
  });

  it('rejects null and unsafe model IDs before secret or network access', async () => {
    for (const modelId of [null, 'models/unsafe/path', 'line\nbreak']) {
      const { adapter, httpClient, secretStore } = setup();
      await expectFixedFailure(
        adapter.execute(createRequest(randomUUID(), new AbortController().signal, { modelId })),
        'PROVIDER_MODEL_INCOMPATIBLE',
      );
      expect(secretStore.reads).toEqual([]);
      expect(httpClient.calls).toEqual([]);
    }
  });

  it('rejects a missing key after registering and then releases the request ID', async () => {
    const { adapter, httpClient, secretStore } = setup();
    const request = createRequest();
    secretStore.value = undefined;
    await expectFixedFailure(adapter.execute(request), 'PROVIDER_AUTH_REQUIRED');
    secretStore.value = PRIVATE_KEY_TWO;
    httpClient.queue(geminiSuccess());
    await expect(adapter.execute(request)).resolves.toMatchObject({ reportedModelId: MODEL_ID });
    expect(httpClient.calls).toHaveLength(1);
  });

  it('preserves a trusted lower-layer AppError by identity with private retry metadata', async () => {
    const { adapter, httpClient } = setup();
    const trusted = new AppError(
      'PROVIDER_RATE_LIMITED',
      APP_ERROR_MESSAGES.PROVIDER_RATE_LIMITED,
      { retryAfterMs: 4_321 },
    );
    httpClient.queueFailure(trusted);

    const failure = await captureFailure(adapter.execute(createRequest()));
    expect(failure).toBe(trusted);
    expect(AppError.getRetryAfterMs(failure)).toBe(4_321);
  });

  it('replaces unknown failures with a fresh fixed content-free AppError and no cause', async () => {
    const { adapter, httpClient } = setup();
    const privateFailure = 'private vendor transport detail';
    const unknown = new Error(privateFailure);
    httpClient.queueFailure(unknown);

    const failure = await expectFixedFailure(
      adapter.execute(createRequest()),
      'PROVIDER_EXECUTION_FAILED',
      [privateFailure],
    );
    expect(failure).not.toBe(unknown);
    expect(AppError.isTrusted(failure)).toBe(true);
    expect(failure).not.toHaveProperty('cause');
  });

  it('normalizes invalid provider JSON and local validation failures without leaking output', async () => {
    const first = setup();
    first.httpClient.queue(geminiSuccess('private invalid JSON'));
    await expectFixedFailure(first.adapter.execute(createRequest()), 'PROVIDER_OUTPUT_INVALID', [
      'private invalid JSON',
    ]);

    const second = setup();
    second.httpClient.queue(geminiSuccess('{"ok":false,"private":"private output"}'));
    await expectFixedFailure(second.adapter.execute(createRequest()), 'PROVIDER_OUTPUT_INVALID', [
      'private output',
      'private local validation failure',
    ]);
  });

  it('does not retain secret or prompt data on the adapter surface', () => {
    const { adapter } = setup();
    const visible = JSON.stringify(adapter);
    expect(visible).not.toContain(PRIVATE_KEY_ONE);
    expect(visible).not.toContain(PRIVATE_SOURCE);
    expect(Object.keys(adapter)).toEqual(['id']);
  });
});

describe('GeminiApiAdapter cancellation registry', () => {
  it.each(['inspect', 'listModels', 'probe'] as const)(
    'rejects pre-aborted %s before secret or HTTP access',
    async (method) => {
      const { adapter, httpClient, secretStore } = setup();
      const controller = new AbortController();
      controller.abort();
      const operation = connectionOperation(controller.signal);

      const pending =
        method === 'inspect'
          ? adapter.inspect(operation)
          : method === 'listModels'
            ? adapter.listModels(operation)
            : adapter.probe(MODEL_ID, operation);

      await expectFixedFailure(pending, 'PROVIDER_CANCELLED');
      expect(secretStore.reads).toEqual([]);
      expect(secretStore.presenceChecks).toEqual([]);
      expect(httpClient.calls).toEqual([]);
    },
  );

  it('rejects a pre-aborted execution before secret and network access', async () => {
    const { adapter, httpClient, secretStore } = setup();
    const controller = new AbortController();
    controller.abort();

    await expectFixedFailure(
      adapter.execute(createRequest(randomUUID(), controller.signal)),
      'PROVIDER_CANCELLED',
    );
    expect(secretStore.reads).toEqual([]);
    expect(httpClient.calls).toEqual([]);
  });

  it('cancels an in-flight execution using the registered request ID', async () => {
    const { adapter, httpClient } = setup();
    const requestId = randomUUID();
    httpClient.queueHandler(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED)),
            { once: true },
          );
        }),
    );

    const pending = adapter.execute(createRequest(requestId));
    await vi.waitFor(() => expect(httpClient.calls).toHaveLength(1));
    adapter.cancel(requestId);

    await expectFixedFailure(pending, 'PROVIDER_CANCELLED');
    expect(httpClient.lastRequest?.signal?.aborted).toBe(true);
  });

  it('forwards an in-flight caller abort into the registered HTTP signal', async () => {
    const { adapter, httpClient } = setup();
    const controller = new AbortController();
    httpClient.queueHandler(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED)),
            { once: true },
          );
        }),
    );
    const pending = adapter.execute(createRequest(randomUUID(), controller.signal));
    await vi.waitFor(() => expect(httpClient.calls).toHaveLength(1));

    controller.abort();

    await expectFixedFailure(pending, 'PROVIDER_CANCELLED');
    expect(httpClient.lastRequest?.signal?.aborted).toBe(true);
  });

  it('rejects a duplicate active request ID before second secret or network access', async () => {
    const { adapter, httpClient, secretStore } = setup();
    const requestId = randomUUID();
    httpClient.queueHandler(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED)),
            { once: true },
          );
        }),
    );
    const first = adapter.execute(createRequest(requestId));
    await vi.waitFor(() => expect(httpClient.calls).toHaveLength(1));

    await expectFixedFailure(
      adapter.execute(createRequest(requestId)),
      'PROVIDER_EXECUTION_FAILED',
    );
    expect(secretStore.reads).toEqual(['gemini_api_key']);
    expect(httpClient.calls).toHaveLength(1);

    adapter.cancel(requestId);
    await expectFixedFailure(first, 'PROVIDER_CANCELLED');
  });

  it('does not let unknown cancellation affect another request', async () => {
    const { adapter, httpClient } = setup();
    httpClient.queue(geminiSuccess());
    adapter.cancel(randomUUID());
    await expect(adapter.execute(createRequest())).resolves.toMatchObject({
      reportedModelId: MODEL_ID,
    });
  });

  it('shares duplicate protection between probe and execute operations', async () => {
    const harness = setup();
    const requestId = randomUUID();
    harness.httpClient.queueHandler(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED)),
            { once: true },
          );
        }),
    );
    const probe = harness.adapter.probe(MODEL_ID, connectionOperation(undefined, requestId));
    await vi.waitFor(() => expect(harness.httpClient.calls).toHaveLength(1));

    await expectFixedFailure(
      harness.adapter.execute(createRequest(requestId)),
      'PROVIDER_EXECUTION_FAILED',
    );
    expect(harness.secretStore.reads).toEqual(['gemini_api_key']);
    expect(harness.httpClient.calls).toHaveLength(1);
    harness.adapter.cancel(requestId);
    await expectFixedFailure(probe, 'PROVIDER_CANCELLED');
  });

  it('discards a response when cancellation wins during local parsing', async () => {
    const { adapter, httpClient } = setup();
    const requestId = randomUUID();
    httpClient.queue(geminiSuccess());
    const request = createRequest(requestId, new AbortController().signal, {
      parseOutput: () => {
        adapter.cancel(requestId);
        return { ok: true } as const;
      },
    });

    await expectFixedFailure(adapter.execute(request), 'PROVIDER_CANCELLED');
  });
});

describe('GeminiApiAdapter actual model probe', () => {
  it('uses the caller operation, selected model, public schema, and measured local latency', async () => {
    const harness = setup();
    const probeRequestId = randomUUID();
    harness.setMilliseconds(2_000);
    harness.httpClient.queueHandler(async (_request) => {
      harness.setMilliseconds(2_137.9);
      return geminiSuccess('{"ok":true}', MODEL_ID);
    });

    const result = await harness.adapter.probe(
      MODEL_ID,
      connectionOperation(undefined, probeRequestId),
    );

    expect(result).toEqual({
      status: 'ready',
      reportedModelId: MODEL_ID,
      latencyMs: 137,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      providerManagedHistory: false,
    });
    expect(harness.httpClient.lastRequest).toMatchObject({
      providerId: 'gemini_api',
      endpoint: { id: 'gemini_interactions' },
      authValue: PRIVATE_KEY_ONE,
      timeoutMs: 120_000,
      responseLimitBytes: 1024 * 1024,
      signal: expect.any(AbortSignal),
      body: {
        model: MODEL_ID,
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['ok'],
            properties: { ok: { const: true } },
          },
        },
      },
    });
    expect(JSON.stringify(harness.httpClient.lastRequest?.body)).not.toContain(PRIVATE_SOURCE);
  });

  it('rejects null or unsafe probe models before secret access', async () => {
    for (const modelId of [null, 'models/unsafe/path', 'line\nbreak']) {
      const { adapter, httpClient, secretStore } = setup();
      await expectFixedFailure(
        adapter.probe(modelId, connectionOperation()),
        'PROVIDER_MODEL_INCOMPATIBLE',
      );
      expect(secretStore.reads).toEqual([]);
      expect(httpClient.calls).toEqual([]);
    }
  });

  it('honors pre-aborted and explicit in-flight probe cancellation', async () => {
    const preAborted = setup();
    const preController = new AbortController();
    preController.abort();
    await expectFixedFailure(
      preAborted.adapter.probe(MODEL_ID, connectionOperation(preController.signal)),
      'PROVIDER_CANCELLED',
    );
    expect(preAborted.secretStore.reads).toEqual([]);

    const active = setup();
    const requestId = randomUUID();
    active.httpClient.queueHandler(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED)),
            { once: true },
          );
        }),
    );
    const pending = active.adapter.probe(MODEL_ID, connectionOperation(undefined, requestId));
    await vi.waitFor(() => expect(active.httpClient.calls).toHaveLength(1));
    active.adapter.cancel(requestId);
    expect(active.secretStore.readOperations[0]?.signal.aborted).toBe(true);
    await expectFixedFailure(pending, 'PROVIDER_CANCELLED');
  });

  it('reads a rotated key for the probe immediately before its HTTP call', async () => {
    const { adapter, httpClient, secretStore } = setup();
    secretStore.value = PRIVATE_KEY_TWO;
    httpClient.queue(geminiSuccess());

    await adapter.probe(MODEL_ID, connectionOperation());

    expect(secretStore.reads).toEqual(['gemini_api_key']);
    expect(httpClient.lastRequest?.authValue).toBe(PRIVATE_KEY_TWO);
  });

  it('fails closed on invalid local clocks without exposing their values', async () => {
    const invalidStart = setup();
    invalidStart.setMilliseconds(Number.NaN);
    await expectFixedFailure(
      invalidStart.adapter.probe(MODEL_ID, connectionOperation()),
      'PROVIDER_EXECUTION_FAILED',
    );
    expect(invalidStart.secretStore.reads).toEqual([]);

    const invalidCompletion = setup();
    invalidCompletion.setNow('private-invalid-time');
    invalidCompletion.httpClient.queue(geminiSuccess());
    await expectFixedFailure(
      invalidCompletion.adapter.execute(createRequest()),
      'PROVIDER_OUTPUT_INVALID',
      ['private-invalid-time'],
    );
  });
});
