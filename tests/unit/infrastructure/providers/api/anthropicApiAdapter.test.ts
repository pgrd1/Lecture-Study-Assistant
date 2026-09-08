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
import { createAnthropicApiAdapterForTest } from '../../../../../src/infrastructure/providers/api/anthropicApiAdapter';
import type {
  ProviderHttpClient,
  ProviderHttpRequest,
} from '../../../../../src/infrastructure/providers/api/providerHttpClient';
import type { JsonValue } from '../../../../../src/shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../../../src/shared/errors';

const FIXED_NOW = '2026-09-03T00:00:00.000Z';
const MODEL_ID = 'claude-sonnet-5';
const REPORTED_MODEL_ID = 'claude-sonnet-5-20260801';

class MutableSecretStore implements SecretStore {
  value: string | undefined = 'first-test-credential';
  gets: readonly SecretKey[] = Object.freeze([]);
  hasCalls: readonly SecretKey[] = Object.freeze([]);
  getOperations: readonly SecretStoreOperation[] = Object.freeze([]);

  async set(_key: SecretKey, value: string, _operation: SecretStoreOperation): Promise<void> {
    this.value = value;
  }

  async get(key: SecretKey, operation: SecretStoreOperation): Promise<string | undefined> {
    this.gets = Object.freeze([...this.gets, key]);
    this.getOperations = Object.freeze([...this.getOperations, operation]);
    return key === 'anthropic_api_key' ? this.value : undefined;
  }

  async delete(_key: SecretKey, _operation: SecretStoreOperation): Promise<void> {
    this.value = undefined;
  }

  async has(key: SecretKey, _operation: SecretStoreOperation): Promise<boolean> {
    this.hasCalls = Object.freeze([...this.hasCalls, key]);
    return key === 'anthropic_api_key' && this.value !== undefined;
  }
}

type Handler = (request: ProviderHttpRequest) => Promise<JsonValue>;

class ControlledHttpClient implements ProviderHttpClient {
  calls: readonly ProviderHttpRequest[] = Object.freeze([]);
  #handlers: readonly Handler[] = Object.freeze([]);

  queue(value: JsonValue | Handler): void {
    const handler: Handler = typeof value === 'function' ? value : async () => value;
    this.#handlers = Object.freeze([...this.#handlers, handler]);
  }

  async requestJson(request: ProviderHttpRequest): Promise<JsonValue> {
    this.calls = Object.freeze([...this.calls, request]);
    const [handler, ...remaining] = this.#handlers;
    this.#handlers = Object.freeze(remaining);
    if (handler === undefined) throw new Error('NO_CONTROLLED_RESPONSE');
    return handler(request);
  }
}

const modelList = (): JsonValue => ({
  data: [
    {
      id: MODEL_ID,
      type: 'model',
      display_name: 'Claude Sonnet 5',
      created_at: '2026-08-01T00:00:00Z',
    },
  ],
  has_more: false,
  first_id: MODEL_ID,
  last_id: MODEL_ID,
});

const message = (
  text = '{"ok":true,"nested":["owned"]}',
  overrides: Readonly<Record<string, JsonValue>> = {},
): JsonValue => ({
  id: 'msg_discarded_private_identifier',
  type: 'message',
  role: 'assistant',
  model: REPORTED_MODEL_ID,
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 7,
    output_tokens: 3,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 1,
  },
  ...overrides,
});

type Output = Readonly<{ ok: true; nested: readonly string[] }>;

const request = (overrides: Partial<ProviderRequest<Output>> = {}): ProviderRequest<Output> =>
  Object.freeze({
    requestId: randomUUID(),
    feature: 'lecture_organize',
    jobId: null,
    outputSchemaId: 'lecture_output',
    outputJsonSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['ok', 'nested']),
      properties: Object.freeze({
        ok: Object.freeze({ const: true }),
        nested: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
      }),
    }),
    parseOutput: (value: unknown) => {
      const parsed = value as { ok?: unknown; nested?: unknown } | null;
      if (parsed?.ok !== true || !Array.isArray(parsed.nested)) {
        throw new Error('private parser failure');
      }
      return { ok: true as const, nested: parsed.nested as string[] };
    },
    blocks: Object.freeze([
      Object.freeze({ role: 'user', kind: 'source', text: 'private user source' }),
      Object.freeze({ role: 'system', kind: 'instruction', text: 'private system instruction' }),
      Object.freeze({ role: 'user', kind: 'professor_note', text: 'private professor note' }),
    ]),
    timeoutMs: 120_000,
    maxOutputTokens: 1_024,
    signal: new AbortController().signal,
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
  const httpClient = new ControlledHttpClient();
  const secretStore = new MutableSecretStore();
  let now = FIXED_NOW;
  let milliseconds: readonly number[] = Object.freeze([1_000, 1_037]);
  const adapter = createAnthropicApiAdapterForTest({
    httpClient,
    secretStore,
    now: () => now,
    nowMilliseconds: () => {
      const [value, ...remaining] = milliseconds;
      milliseconds = Object.freeze(remaining);
      return value ?? 1_037;
    },
  });
  return {
    adapter,
    httpClient,
    secretStore,
    setNow: (value: string) => {
      now = value;
    },
  };
};

describe('Anthropic API adapter', () => {
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

      await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(secretStore.gets).toEqual([]);
      expect(secretStore.hasCalls).toEqual([]);
      expect(httpClient.calls).toEqual([]);
    },
  );

  it('inspects credential presence with has only and exposes immutable API metadata', async () => {
    const { adapter, httpClient, secretStore } = setup();
    await expect(adapter.inspect(connectionOperation())).resolves.toEqual({
      status: 'credential_saved',
      version: null,
      credentialPresent: true,
      credentialScope: 'not_applicable',
      cliBinding: null,
      providerManagedHistory: false,
    });
    secretStore.value = undefined;
    const missing = await adapter.inspect(connectionOperation());
    expect(missing).toEqual({
      status: 'missing_credential',
      version: null,
      credentialPresent: false,
      credentialScope: 'not_applicable',
      cliBinding: null,
      providerManagedHistory: false,
    });
    expect(secretStore.hasCalls).toEqual(['anthropic_api_key', 'anthropic_api_key']);
    expect(secretStore.gets).toEqual([]);
    expect(httpClient.calls).toEqual([]);
    expect(Object.isFrozen(missing)).toBe(true);
    expect(Object.keys(adapter)).toEqual(['id']);
    expect(adapter.id).toBe('claude_api');
  });

  it('reads rotated credentials just in time for fixed model, probe, and execute requests', async () => {
    const { adapter, httpClient, secretStore } = setup();
    const listOperation = connectionOperation();
    httpClient.queue(modelList());
    await expect(adapter.listModels(listOperation)).resolves.toEqual([
      { modelId: MODEL_ID, displayName: 'Claude Sonnet 5', compatibility: 'unverified' },
    ]);
    secretStore.value = 'second-test-credential';
    httpClient.queue(message('{"ok":true}'));
    await adapter.probe(MODEL_ID, connectionOperation());
    secretStore.value = 'third-test-credential';
    httpClient.queue(message());
    await adapter.execute(request());

    expect(secretStore.gets).toEqual([
      'anthropic_api_key',
      'anthropic_api_key',
      'anthropic_api_key',
    ]);
    expect(httpClient.calls.map((call) => call.authValue)).toEqual([
      'first-test-credential',
      'second-test-credential',
      'third-test-credential',
    ]);
    expect(httpClient.calls.map((call) => [call.endpoint.id, call.responseLimitBytes])).toEqual([
      ['claude_models', 2 * 1_024 * 1_024],
      ['claude_messages', 1 * 1_024 * 1_024],
      ['claude_messages', 8 * 1_024 * 1_024],
    ]);
    expect(httpClient.calls[0]).toMatchObject({
      providerId: 'claude_api',
      endpoint: { id: 'claude_models' },
      timeoutMs: 30_000,
    });
    expect(httpClient.calls[0]?.body).toBeUndefined();
    expect(secretStore.getOperations[0]?.requestId).toBe(listOperation.requestId);
    expect(secretStore.getOperations[0]?.signal).toBe(httpClient.calls[0]?.signal);
  });

  it.each([undefined, ''])('rejects a missing credential without dispatch (%s)', async (value) => {
    const { adapter, httpClient, secretStore } = setup();
    secretStore.value = value;
    await expect(adapter.listModels(connectionOperation())).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED',
    });
    await expect(adapter.probe(MODEL_ID, connectionOperation())).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED',
    });
    await expect(adapter.execute(request())).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED',
    });
    expect(httpClient.calls).toEqual([]);
  });

  it('builds the exact six-key stateless body with role envelopes and owned schema', async () => {
    const { adapter, httpClient } = setup();
    const source = request();
    httpClient.queue(message());
    const result = await adapter.execute(source);
    expect(result).toEqual({
      output: { ok: true, nested: ['owned'] },
      reportedModelId: REPORTED_MODEL_ID,
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      completedAt: FIXED_NOW,
    });
    const call = httpClient.calls[0];
    expect(call).toMatchObject({
      providerId: 'claude_api',
      endpoint: { id: 'claude_messages' },
      timeoutMs: 120_000,
      responseLimitBytes: 8 * 1_024 * 1_024,
    });
    expect(call?.body).toEqual({
      model: MODEL_ID,
      system: JSON.stringify({
        blocks: [
          {
            index: 1,
            role: 'system',
            kind: 'instruction',
            text: 'private system instruction',
          },
        ],
      }),
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            blocks: [
              { index: 0, role: 'user', kind: 'source', text: 'private user source' },
              { index: 2, role: 'user', kind: 'professor_note', text: 'private professor note' },
            ],
          }),
        },
      ],
      max_tokens: 1_024,
      stream: false,
      output_config: {
        format: { type: 'json_schema', schema: source.outputJsonSchema },
      },
    });
    const body = call?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'stream',
      'system',
    ]);
    for (const prohibited of [
      'tools',
      'tool_choice',
      'thinking',
      'metadata',
      'temperature',
      'top_p',
      'top_k',
      'stop_sequences',
      'anthropic-beta',
      'previous_message_id',
    ]) {
      expect(JSON.stringify(body)).not.toContain(`"${prohibited}"`);
    }
    const ownedSchema = (
      body as { output_config: { format: { schema: Record<string, JsonValue> } } }
    ).output_config.format.schema;
    expect(ownedSchema).not.toBe(source.outputJsonSchema);
    expect(Object.isFrozen(ownedSchema)).toBe(true);
  });

  it('sends empty role envelopes when blocks are absent', async () => {
    const { adapter, httpClient } = setup();
    httpClient.queue(message());
    await adapter.execute(request({ blocks: Object.freeze([]) }));
    const body = httpClient.calls[0]?.body as {
      system: string;
      messages: readonly [{ content: string }];
    };
    expect(body.system).toBe('{"blocks":[]}');
    expect(body.messages[0].content).toBe('{"blocks":[]}');
  });

  it('uses the fixed public probe schema, prompt, token limit, cap, and local latency', async () => {
    const { adapter, httpClient } = setup();
    httpClient.queue(message('{"ok":true}'));
    await expect(adapter.probe(MODEL_ID, connectionOperation())).resolves.toEqual({
      status: 'ready',
      reportedModelId: REPORTED_MODEL_ID,
      latencyMs: 37,
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      providerManagedHistory: false,
    });
    const call = httpClient.calls[0];
    expect(call).toMatchObject({
      endpoint: { id: 'claude_messages' },
      timeoutMs: 120_000,
      responseLimitBytes: 1 * 1_024 * 1_024,
    });
    const body = call?.body as {
      max_tokens: number;
      messages: readonly [{ content: string }];
      output_config: { format: { schema: Readonly<Record<string, JsonValue>> } };
    };
    expect(body.max_tokens).toBe(128);
    expect(JSON.parse(body.messages[0].content)).toEqual({
      blocks: [
        {
          index: 0,
          role: 'user',
          kind: 'instruction',
          text: '연결을 확인합니다. 정확히 { "ok": true } JSON만 응답하세요.',
        },
      ],
    });
    expect(body.output_config.format.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { const: true } },
    });
  });

  it('accepts a different safe reported alias without comparing it in the adapter', async () => {
    const { adapter, httpClient } = setup();
    httpClient.queue(message(undefined, { model: 'claude-safe-dated-snapshot' }));
    await expect(adapter.execute(request())).resolves.toMatchObject({
      reportedModelId: 'claude-safe-dated-snapshot',
    });
  });

  it('rejects unsafe models and pre-abort before credential or network access', async () => {
    const { adapter, httpClient, secretStore } = setup();
    await expect(adapter.probe(null, connectionOperation())).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_INCOMPATIBLE',
    });
    await expect(adapter.probe('unsafe/id', connectionOperation())).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_INCOMPATIBLE',
    });
    const probeController = new AbortController();
    probeController.abort();
    await expect(
      adapter.probe(MODEL_ID, connectionOperation(probeController.signal)),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    const executeController = new AbortController();
    executeController.abort();
    await expect(
      adapter.execute(request({ signal: executeController.signal })),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(secretStore.gets).toEqual([]);
    expect(httpClient.calls).toEqual([]);
  });

  it('rejects duplicate probe/execute IDs before a second read without cancelling the original', async () => {
    const { adapter, httpClient, secretStore } = setup();
    const requestId = randomUUID();
    let release!: (value: JsonValue) => void;
    httpClient.queue(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = adapter.execute(request({ requestId }));
    await vi.waitFor(() => expect(httpClient.calls).toHaveLength(1));
    await expect(adapter.execute(request({ requestId }))).rejects.toMatchObject({
      code: 'PROVIDER_EXECUTION_FAILED',
    });
    await expect(
      adapter.probe(MODEL_ID, connectionOperation(undefined, requestId)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_EXECUTION_FAILED',
    });
    expect(secretStore.gets).toHaveLength(1);
    expect(httpClient.calls[0]?.signal?.aborted).toBe(false);
    release(message());
    await expect(first).resolves.toMatchObject({ reportedModelId: REPORTED_MODEL_ID });
  });

  it('forwards caller abort and local cancel, ignores unknown cancel, and reuses IDs', async () => {
    const { adapter, httpClient, secretStore } = setup();
    const requestId = randomUUID();
    const caller = new AbortController();
    const cancellationHandler: Handler = (outbound) =>
      new Promise((_resolve, reject) => {
        outbound.signal?.addEventListener(
          'abort',
          () => reject(new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED)),
          { once: true },
        );
      });
    httpClient.queue(cancellationHandler);
    const pending = adapter.execute(request({ requestId, signal: caller.signal }));
    await vi.waitFor(() => expect(httpClient.calls).toHaveLength(1));
    adapter.cancel('00000000-0000-4000-8000-000000000000');
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(httpClient.calls[0]?.signal?.aborted).toBe(true);
    expect(secretStore.getOperations[0]?.signal.aborted).toBe(true);

    httpClient.queue(message());
    await expect(adapter.execute(request({ requestId }))).resolves.toBeDefined();

    const localId = randomUUID();
    httpClient.queue(cancellationHandler);
    const localPending = adapter.execute(request({ requestId: localId }));
    await vi.waitFor(() => expect(httpClient.calls).toHaveLength(3));
    adapter.cancel(localId);
    await expect(localPending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
  });

  it('lets parse-time cancellation win and removes the completed registry entry', async () => {
    const { adapter, httpClient } = setup();
    const requestId = randomUUID();
    httpClient.queue(message());
    await expect(
      adapter.execute(
        request({
          requestId,
          parseOutput: (value: unknown) => {
            adapter.cancel(requestId);
            return value as Output;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    httpClient.queue(message());
    await expect(adapter.execute(request({ requestId }))).resolves.toBeDefined();
  });

  it('cleans active IDs after missing-key, HTTP, provider-output, parser, and clock failures', async () => {
    const { adapter, httpClient, secretStore, setNow } = setup();
    const requestId = randomUUID();
    secretStore.value = undefined;
    await expect(adapter.execute(request({ requestId }))).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED',
    });
    secretStore.value = 'restored-test-credential';
    const trustedHttp = new AppError('PROVIDER_TIMEOUT', APP_ERROR_MESSAGES.PROVIDER_TIMEOUT);
    httpClient.queue(async () => {
      throw trustedHttp;
    });
    await expect(adapter.execute(request({ requestId }))).rejects.toBe(trustedHttp);
    httpClient.queue({ invalid: true });
    await expect(adapter.execute(request({ requestId }))).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_INVALID',
    });
    httpClient.queue(message());
    await expect(
      adapter.execute(
        request({
          requestId,
          parseOutput: () => {
            throw new Error('private local parser');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
    setNow('not-a-time');
    httpClient.queue(message());
    await expect(adapter.execute(request({ requestId }))).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_INVALID',
    });
    setNow(FIXED_NOW);
    httpClient.queue(message());
    await expect(adapter.execute(request({ requestId }))).resolves.toBeDefined();
  });

  it('preserves trusted failures by identity and sanitizes unknown values without a cause', async () => {
    const { adapter, httpClient } = setup();
    const trustedHttp = new AppError(
      'PROVIDER_RATE_LIMITED',
      APP_ERROR_MESSAGES.PROVIDER_RATE_LIMITED,
      { retryAfterMs: 3_210 },
    );
    httpClient.queue(async () => {
      throw trustedHttp;
    });
    await expect(adapter.execute(request())).rejects.toBe(trustedHttp);
    const trustedParser = new AppError('PROVIDER_BUSY', APP_ERROR_MESSAGES.PROVIDER_BUSY);
    httpClient.queue(message());
    await expect(
      adapter.execute(
        request({
          parseOutput: () => {
            throw trustedParser;
          },
        }),
      ),
    ).rejects.toBe(trustedParser);
    httpClient.queue(async () => {
      throw new Error('private vendor failure');
    });
    const failure = await adapter.execute(request()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain('private vendor failure');
  });

  it('rejects hostile request/schema/parser values without trap reads and returns owned output', async () => {
    const { adapter, httpClient, secretStore } = setup();
    let requestTrapCalls = 0;
    const hostileRequest = new Proxy(request(), { get: () => (requestTrapCalls += 1) });
    await expect(adapter.execute(hostileRequest)).rejects.toMatchObject({
      code: 'PROVIDER_EXECUTION_FAILED',
    });
    let schemaTrapCalls = 0;
    const hostileSchema = new Proxy(
      { type: 'object', additionalProperties: false },
      { get: () => (schemaTrapCalls += 1) },
    );
    await expect(
      adapter.execute(request({ outputJsonSchema: hostileSchema })),
    ).rejects.toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect(requestTrapCalls).toBe(0);
    expect(schemaTrapCalls).toBe(0);
    expect(secretStore.gets).toEqual([]);

    const parserValue = { ok: true as const, nested: ['mutable'] };
    httpClient.queue(message());
    const result = await adapter.execute(request({ parseOutput: () => parserValue }));
    parserValue.nested.push('changed');
    expect(result.output).toEqual({ ok: true, nested: ['mutable'] });
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen(result.output.nested)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('msg_discarded_private_identifier');
  });
});
