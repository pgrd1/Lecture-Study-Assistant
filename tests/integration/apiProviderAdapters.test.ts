import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnectionOperation, ProviderRequest } from '../../src/core/ports/aiProvider';
import type { HttpTransport, HttpTransportRequestInit } from '../../src/core/ports/httpTransport';
import type {
  SecretKey,
  SecretStore,
  SecretStoreOperation,
} from '../../src/core/ports/secretStore';
import { createAnthropicApiAdapterForTest } from '../../src/infrastructure/providers/api/anthropicApiAdapter';
import { createGeminiApiAdapterForTest } from '../../src/infrastructure/providers/api/geminiApiAdapter';
import { createOpenAiApiAdapterForTest } from '../../src/infrastructure/providers/api/openAiApiAdapter';
import {
  createProviderHttpClientForTest,
  type ProviderHttpLogEvent,
  type ProviderHttpLogger,
} from '../../src/infrastructure/providers/api/providerHttpClient';
import type { JsonValue } from '../../src/shared/contracts/provider';

const PRIVATE_KEY = 'fixed-private-integration-gemini-key';
const PRIVATE_PROMPT = 'fixed private integration prompt';
const PRIVATE_OUTPUT = 'fixed-private-output-marker';
const MODEL_ID = 'gemini-3.5-flash';
const FIXED_NOW = '2026-09-03T00:00:00.000Z';

type TransportCall = Readonly<{ url: string; init: HttpTransportRequestInit }>;
type ResponseFactory = (init: HttpTransportRequestInit) => Promise<Response>;

class ControlledTransport implements HttpTransport {
  calls: readonly TransportCall[] = Object.freeze([]);
  #queue: readonly ResponseFactory[] = Object.freeze([]);

  queueJson(value: JsonValue, status = 200): void {
    this.queue(
      async () =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
  }

  queue(factory: ResponseFactory): void {
    this.#queue = Object.freeze([...this.#queue, factory]);
  }

  async request(url: string, init: HttpTransportRequestInit): Promise<Response> {
    this.calls = Object.freeze([...this.calls, Object.freeze({ url, init })]);
    const [next, ...remaining] = this.#queue;
    this.#queue = Object.freeze(remaining);
    if (next === undefined) throw new Error('NO_CONTROLLED_RESPONSE');
    return next(init);
  }
}

class RecordingLogger implements ProviderHttpLogger {
  events: readonly ProviderHttpLogEvent[] = Object.freeze([]);

  record(event: ProviderHttpLogEvent): void {
    this.events = Object.freeze([...this.events, event]);
  }
}

class FixedSecretStore implements SecretStore {
  async set(_key: SecretKey, _value: string, _operation: SecretStoreOperation): Promise<void> {}
  async get(key: SecretKey, _operation: SecretStoreOperation): Promise<string | undefined> {
    return key === 'gemini_api_key' ? PRIVATE_KEY : undefined;
  }
  async delete(_key: SecretKey, _operation: SecretStoreOperation): Promise<void> {}
  async has(key: SecretKey, _operation: SecretStoreOperation): Promise<boolean> {
    return key === 'gemini_api_key';
  }
}

const request = (
  requestId: string = randomUUID(),
  signal: AbortSignal = new AbortController().signal,
): ProviderRequest<Readonly<{ ok: true; marker: string }>> =>
  Object.freeze({
    requestId,
    feature: 'lecture_organize',
    jobId: null,
    outputSchemaId: 'lecture_output',
    outputJsonSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['ok', 'marker']),
      properties: Object.freeze({
        ok: Object.freeze({ const: true }),
        marker: Object.freeze({ type: 'string' }),
      }),
    }),
    parseOutput: (value: unknown) => {
      const parsed = value as { ok?: unknown; marker?: unknown } | null;
      if (parsed?.ok !== true || typeof parsed.marker !== 'string') {
        throw new Error('private integration parser failure');
      }
      return Object.freeze({ ok: true as const, marker: parsed.marker });
    },
    blocks: Object.freeze([
      Object.freeze({ role: 'system', kind: 'instruction', text: 'Return safe JSON.' }),
      Object.freeze({ role: 'user', kind: 'source', text: PRIVATE_PROMPT }),
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
  });

const connectionOperation = (
  signal = new AbortController().signal,
  requestId = randomUUID(),
): ProviderConnectionOperation => Object.freeze({ requestId, signal });

const interaction = (): JsonValue =>
  Object.freeze({
    object: 'interaction',
    status: 'completed',
    model: MODEL_ID,
    steps: Object.freeze([
      Object.freeze({
        type: 'model_output',
        content: Object.freeze([
          Object.freeze({ type: 'text', text: `{"ok":true,"marker":"${PRIVATE_OUTPUT}"}` }),
        ]),
      }),
    ]),
    usage: Object.freeze({
      total_input_tokens: 7,
      total_output_tokens: 3,
      total_tokens: 10,
      total_tool_use_tokens: 0,
    }),
  });

const setup = () => {
  const transport = new ControlledTransport();
  const logger = new RecordingLogger();
  const httpClient = createProviderHttpClientForTest({ transport, logger, now: () => 0 });
  const adapter = createGeminiApiAdapterForTest({
    httpClient,
    secretStore: new FixedSecretStore(),
    now: () => FIXED_NOW,
    nowMilliseconds: () => 1_000,
  });
  return Object.freeze({ adapter, transport, logger });
};

describe('Gemini API adapter through the real bounded HTTP client', () => {
  it('uses the fixed v1beta model metadata endpoint and exact generateContent filtering', async () => {
    const { adapter, transport, logger } = setup();
    transport.queueJson({
      models: [
        {
          name: 'models/gemini-3.5-flash',
          displayName: 'Gemini 3.5 Flash',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-embedding-001',
          supportedGenerationMethods: ['embedContent'],
        },
      ],
    });

    await expect(adapter.listModels(connectionOperation())).resolves.toEqual([
      { modelId: MODEL_ID, displayName: 'Gemini 3.5 Flash', compatibility: 'unverified' },
    ]);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    );
    expect(transport.calls[0]?.init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(transport.calls[0]?.init.headers['x-goog-api-key']).toBe(PRIVATE_KEY);
    expect(transport.calls[0]?.url).not.toContain(PRIVATE_KEY);
    expect(logger.events).toEqual([
      {
        phase: 'completed',
        providerId: 'gemini_api',
        endpointId: 'gemini_models',
        status: 200,
        errorCode: null,
        retryAfterMs: null,
      },
    ]);
  });

  it('posts one stable v1 stateless Interaction and logs no key, prompt, body, or output', async () => {
    const { adapter, transport, logger } = setup();
    transport.queueJson(interaction());

    await expect(adapter.execute(request())).resolves.toEqual({
      output: { ok: true, marker: PRIVATE_OUTPUT },
      reportedModelId: MODEL_ID,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      completedAt: FIXED_NOW,
    });

    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    expect(call?.url).toBe('https://generativelanguage.googleapis.com/v1/interactions');
    expect(call?.init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(call?.init.headers['x-goog-api-key']).toBe(PRIVATE_KEY);
    const body = JSON.parse(call?.init.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      model: MODEL_ID,
      store: false,
      background: false,
      stream: false,
      tools: [],
    });
    expect(Object.keys(body)).not.toContain('previous_interaction_id');
    expect(call?.url).not.toContain(PRIVATE_KEY);
    expect(call?.init.body).not.toContain(PRIVATE_KEY);
    const visibleEvents = JSON.stringify(logger.events);
    expect(visibleEvents).not.toContain(PRIVATE_KEY);
    expect(visibleEvents).not.toContain(PRIVATE_PROMPT);
    expect(visibleEvents).not.toContain(PRIVATE_OUTPUT);
    expect(visibleEvents).not.toContain('https://');
    expect(logger.events).toEqual([
      {
        phase: 'completed',
        providerId: 'gemini_api',
        endpointId: 'gemini_interactions',
        status: 200,
        errorCode: null,
        retryAfterMs: null,
      },
    ]);
  });

  it('cancels an in-flight real bounded-client request without a live network call', async () => {
    const { adapter, transport } = setup();
    const requestId = randomUUID();
    transport.queue(
      (init) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(new DOMException('private abort detail', 'AbortError'));
          init.signal.addEventListener('abort', onAbort, { once: true });
          if (init.signal.aborted) onAbort();
        }),
    );

    const pending = adapter.execute(request(requestId));
    await vi.waitFor(() => expect(transport.calls).toHaveLength(1));
    adapter.cancel(requestId);

    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(transport.calls[0]?.init.signal.aborted).toBe(true);
  });

  it('classifies only an exact bounded machine error code and never logs its vendor message', async () => {
    const { adapter, transport, logger } = setup();
    const privateVendorMessage = 'private provider policy explanation';
    transport.queueJson({ error: { code: 'safety', message: privateVendorMessage } }, 400);

    await expect(adapter.execute(request())).rejects.toMatchObject({ code: 'PROVIDER_REFUSED' });

    expect(JSON.stringify(logger.events)).not.toContain(privateVendorMessage);
    expect(logger.events).toEqual([
      {
        phase: 'failed',
        providerId: 'gemini_api',
        endpointId: 'gemini_interactions',
        status: 400,
        errorCode: 'PROVIDER_REFUSED',
        retryAfterMs: null,
      },
    ]);
  });
});

const OPENAI_PRIVATE_KEY = 'fixed-private-integration-openai-key';
const OPENAI_MODEL_ID = 'gpt-5.6';
const OPENAI_REPORTED_MODEL_ID = 'gpt-5.6-2026-08-01';

class FixedOpenAiSecretStore implements SecretStore {
  async set(_key: SecretKey, _value: string, _operation: SecretStoreOperation): Promise<void> {}
  async get(key: SecretKey, _operation: SecretStoreOperation): Promise<string | undefined> {
    return key === 'openai_api_key' ? OPENAI_PRIVATE_KEY : undefined;
  }
  async delete(_key: SecretKey, _operation: SecretStoreOperation): Promise<void> {}
  async has(key: SecretKey, _operation: SecretStoreOperation): Promise<boolean> {
    return key === 'openai_api_key';
  }
}

const openAiRequest = (
  requestId: string = randomUUID(),
  signal: AbortSignal = new AbortController().signal,
): ProviderRequest<Readonly<{ ok: true; marker: string }>> =>
  Object.freeze({ ...request(requestId, signal), modelId: OPENAI_MODEL_ID });

const openAiResponse = (outputText = `{"ok":true,"marker":"${PRIVATE_OUTPUT}"}`): JsonValue => ({
  object: 'response',
  status: 'completed',
  error: null,
  incomplete_details: null,
  model: OPENAI_REPORTED_MODEL_ID,
  output: [
    {
      id: 'reasoning_private_id',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'private reasoning summary' }],
    },
    {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText, annotations: [], logprobs: [] }],
    },
  ],
  usage: {
    input_tokens: 7,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 10,
  },
});

const setupOpenAi = () => {
  const transport = new ControlledTransport();
  const logger = new RecordingLogger();
  const httpClient = createProviderHttpClientForTest({ transport, logger, now: () => 0 });
  const times = [1_000, 1_009];
  const adapter = createOpenAiApiAdapterForTest({
    httpClient,
    secretStore: new FixedOpenAiSecretStore(),
    now: () => FIXED_NOW,
    nowMilliseconds: () => times.shift() ?? 1_009,
  });
  return Object.freeze({ adapter, transport, logger });
};

describe('OpenAI API adapter through the real bounded HTTP client', () => {
  it('uses exact GET /v1/models and a Bearer header without beta/version/custom headers', async () => {
    const { adapter, transport, logger } = setupOpenAi();
    transport.queueJson({
      object: 'list',
      data: [{ id: OPENAI_MODEL_ID, object: 'model', created: 1, owned_by: 'openai' }],
    });

    await expect(adapter.listModels(connectionOperation())).resolves.toEqual([
      { modelId: OPENAI_MODEL_ID, displayName: OPENAI_MODEL_ID, compatibility: 'unverified' },
    ]);

    const call = transport.calls[0];
    expect(call?.url).toBe('https://api.openai.com/v1/models');
    expect(call?.init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    expect(call?.init.body).toBeUndefined();
    expect(call?.init.headers.authorization).toBe(`Bearer ${OPENAI_PRIVATE_KEY}`);
    expect(Object.keys(call?.init.headers ?? {}).sort()).toEqual([
      'accept',
      'authorization',
      'content-type',
      'user-agent',
    ]);
    expect(logger.events).toEqual([
      {
        phase: 'completed',
        providerId: 'openai_api',
        endpointId: 'openai_models',
        status: 200,
        errorCode: null,
        retryAfterMs: null,
      },
    ]);
  });

  it('posts exact stateless Responses calls for probe and execute and discards reasoning', async () => {
    const { adapter, transport, logger } = setupOpenAi();
    transport.queueJson(openAiResponse('{"ok":true}'));
    await expect(adapter.probe(OPENAI_MODEL_ID, connectionOperation())).resolves.toEqual({
      status: 'ready',
      reportedModelId: OPENAI_REPORTED_MODEL_ID,
      latencyMs: 9,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      providerManagedHistory: false,
    });
    transport.queueJson(openAiResponse());
    await expect(adapter.execute(openAiRequest())).resolves.toEqual({
      output: { ok: true, marker: PRIVATE_OUTPUT },
      reportedModelId: OPENAI_REPORTED_MODEL_ID,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      completedAt: FIXED_NOW,
    });

    expect(transport.calls.map((call) => call.url)).toEqual([
      'https://api.openai.com/v1/responses',
      'https://api.openai.com/v1/responses',
    ]);
    for (const call of transport.calls) {
      expect(call.init.headers.authorization).toBe(`Bearer ${OPENAI_PRIVATE_KEY}`);
      expect(Object.keys(call.init.headers)).not.toContain('openai-beta');
      expect(Object.keys(call.init.headers)).not.toContain('openai-version');
      const body = JSON.parse(call.init.body ?? '{}') as Record<string, unknown>;
      expect(body).toMatchObject({
        model: OPENAI_MODEL_ID,
        store: false,
        background: false,
        stream: false,
        tools: [],
        tool_choice: 'none',
        parallel_tool_calls: false,
        truncation: 'disabled',
      });
      expect(body.input).toHaveLength(2);
    }
    const visibleEvents = JSON.stringify(logger.events);
    for (const privateValue of [
      OPENAI_PRIVATE_KEY,
      PRIVATE_PROMPT,
      PRIVATE_OUTPUT,
      'private reasoning summary',
      'reasoning_private_id',
      'https://',
    ]) {
      expect(visibleEvents).not.toContain(privateValue);
    }
    expect(logger.events).toEqual([
      {
        phase: 'completed',
        providerId: 'openai_api',
        endpointId: 'openai_responses',
        status: 200,
        errorCode: null,
        retryAfterMs: null,
      },
      {
        phase: 'completed',
        providerId: 'openai_api',
        endpointId: 'openai_responses',
        status: 200,
        errorCode: null,
        retryAfterMs: null,
      },
    ]);
  });

  it('uses exact 400 machine classification while fixed status mappings keep precedence', async () => {
    const { adapter, transport, logger } = setupOpenAi();
    const privateVendorMessage = 'private vendor schema explanation';
    transport.queueJson(
      {
        error: {
          code: 'invalid_json_schema',
          message: privateVendorMessage,
          type: 'invalid_request_error',
          param: 'text.format.schema',
        },
      },
      400,
    );
    await expect(adapter.execute(openAiRequest())).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_INCOMPATIBLE',
    });
    transport.queueJson(
      {
        error: {
          code: 'invalid_json_schema',
          message: privateVendorMessage,
          type: 'invalid_request_error',
          param: null,
        },
      },
      401,
    );
    await expect(adapter.execute(openAiRequest())).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED',
    });
    expect(JSON.stringify(logger.events)).not.toContain(privateVendorMessage);
    expect(logger.events.map((event) => event.errorCode)).toEqual([
      'PROVIDER_MODEL_INCOMPATIBLE',
      'PROVIDER_AUTH_REQUIRED',
    ]);
  });

  it('cancels an in-flight real bounded-client OpenAI request', async () => {
    const { adapter, transport } = setupOpenAi();
    const requestId = randomUUID();
    transport.queue(
      (init) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(new DOMException('private abort detail', 'AbortError'));
          init.signal.addEventListener('abort', onAbort, { once: true });
          if (init.signal.aborted) onAbort();
        }),
    );
    const pending = adapter.execute(openAiRequest(requestId));
    await vi.waitFor(() => expect(transport.calls).toHaveLength(1));
    adapter.cancel(requestId);
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(transport.calls[0]?.init.signal.aborted).toBe(true);
  });
});

const ANTHROPIC_PRIVATE_KEY = 'fixed-private-integration-anthropic-key';
const ANTHROPIC_MODEL_ID = 'claude-sonnet-5';
const ANTHROPIC_REPORTED_MODEL_ID = 'claude-sonnet-5-20260801';
const ANTHROPIC_PRIVATE_THINKING = 'private anthropic thinking';
const ANTHROPIC_PRIVATE_SIGNATURE = 'private anthropic signature';
const ANTHROPIC_PRIVATE_REDACTED = 'private anthropic redacted data';
const ANTHROPIC_PRIVATE_MESSAGE_ID = 'msg_private_anthropic_identifier';

class FixedAnthropicSecretStore implements SecretStore {
  async set(_key: SecretKey, _value: string, _operation: SecretStoreOperation): Promise<void> {}
  async get(key: SecretKey, _operation: SecretStoreOperation): Promise<string | undefined> {
    return key === 'anthropic_api_key' ? ANTHROPIC_PRIVATE_KEY : undefined;
  }
  async delete(_key: SecretKey, _operation: SecretStoreOperation): Promise<void> {}
  async has(key: SecretKey, _operation: SecretStoreOperation): Promise<boolean> {
    return key === 'anthropic_api_key';
  }
}

const anthropicRequest = (
  requestId: string = randomUUID(),
  signal: AbortSignal = new AbortController().signal,
): ProviderRequest<Readonly<{ ok: true; marker: string }>> =>
  Object.freeze({ ...request(requestId, signal), modelId: ANTHROPIC_MODEL_ID });

const anthropicMessage = (outputText = `{"ok":true,"marker":"${PRIVATE_OUTPUT}"}`): JsonValue => ({
  id: ANTHROPIC_PRIVATE_MESSAGE_ID,
  type: 'message',
  role: 'assistant',
  model: ANTHROPIC_REPORTED_MODEL_ID,
  content: [
    {
      type: 'thinking',
      thinking: ANTHROPIC_PRIVATE_THINKING,
      signature: ANTHROPIC_PRIVATE_SIGNATURE,
    },
    { type: 'redacted_thinking', data: ANTHROPIC_PRIVATE_REDACTED },
    { type: 'text', text: outputText },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 7,
    output_tokens: 3,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 1,
    cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 1 },
    output_tokens_details: { thinking_tokens: 2 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: 'standard',
  },
});

const setupAnthropic = () => {
  const transport = new ControlledTransport();
  const logger = new RecordingLogger();
  const httpClient = createProviderHttpClientForTest({ transport, logger, now: () => 0 });
  const times = [1_000, 1_011];
  const adapter = createAnthropicApiAdapterForTest({
    httpClient,
    secretStore: new FixedAnthropicSecretStore(),
    now: () => FIXED_NOW,
    nowMilliseconds: () => times.shift() ?? 1_011,
  });
  return Object.freeze({ adapter, transport, logger });
};

describe('Anthropic API adapter through the real bounded HTTP client', () => {
  it('uses exact one-page GET /v1/models headers and never reflects provider cursors', async () => {
    const { adapter, transport, logger } = setupAnthropic();
    transport.queueJson({
      data: [
        {
          id: ANTHROPIC_MODEL_ID,
          type: 'model',
          display_name: 'Claude Sonnet 5',
          created_at: '2026-08-01T00:00:00Z',
        },
      ],
      has_more: false,
      first_id: ANTHROPIC_MODEL_ID,
      last_id: ANTHROPIC_MODEL_ID,
    });

    await expect(adapter.listModels(connectionOperation())).resolves.toEqual([
      {
        modelId: ANTHROPIC_MODEL_ID,
        displayName: 'Claude Sonnet 5',
        compatibility: 'unverified',
      },
    ]);

    const call = transport.calls[0];
    expect(call?.url).toBe('https://api.anthropic.com/v1/models?limit=100');
    expect(call?.init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    expect(call?.init.body).toBeUndefined();
    expect(call?.init.headers['x-api-key']).toBe(ANTHROPIC_PRIVATE_KEY);
    expect(call?.init.headers['anthropic-version']).toBe('2023-06-01');
    expect(Object.keys(call?.init.headers ?? {}).sort()).toEqual([
      'accept',
      'anthropic-version',
      'content-type',
      'user-agent',
      'x-api-key',
    ]);
    expect(call?.init.headers).not.toHaveProperty('anthropic-beta');
    expect(logger.events).toEqual([
      {
        phase: 'completed',
        providerId: 'claude_api',
        endpointId: 'claude_models',
        status: 200,
        errorCode: null,
        retryAfterMs: null,
      },
    ]);
  });

  it('rejects has_more without a cursor follow-up or partial result', async () => {
    const { adapter, transport } = setupAnthropic();
    transport.queueJson({
      data: [],
      has_more: true,
      first_id: null,
      last_id: 'claude-provider-cursor',
    });

    await expect(adapter.listModels(connectionOperation())).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_INVALID',
    });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=100');
  });

  it('posts exact Messages probe/execute bodies and discards thinking while preserving alias usage', async () => {
    const { adapter, transport, logger } = setupAnthropic();
    transport.queueJson(anthropicMessage('{"ok":true}'));
    await expect(adapter.probe(ANTHROPIC_MODEL_ID, connectionOperation())).resolves.toEqual({
      status: 'ready',
      reportedModelId: ANTHROPIC_REPORTED_MODEL_ID,
      latencyMs: 11,
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      providerManagedHistory: false,
    });
    transport.queueJson(anthropicMessage());
    await expect(adapter.execute(anthropicRequest())).resolves.toEqual({
      output: { ok: true, marker: PRIVATE_OUTPUT },
      reportedModelId: ANTHROPIC_REPORTED_MODEL_ID,
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      completedAt: FIXED_NOW,
    });

    expect(transport.calls.map((call) => call.url)).toEqual([
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/v1/messages',
    ]);
    for (const call of transport.calls) {
      expect(call.init.headers['x-api-key']).toBe(ANTHROPIC_PRIVATE_KEY);
      expect(call.init.headers['anthropic-version']).toBe('2023-06-01');
      expect(call.init.headers).not.toHaveProperty('anthropic-beta');
      const body = JSON.parse(call.init.body ?? '{}') as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'max_tokens',
        'messages',
        'model',
        'output_config',
        'stream',
        'system',
      ]);
      expect(body).toMatchObject({ model: ANTHROPIC_MODEL_ID, stream: false });
      expect(JSON.stringify(body)).not.toContain('"tools"');
      expect(JSON.stringify(body)).not.toContain('"thinking"');
    }
    const visibleEvents = JSON.stringify(logger.events);
    for (const privateValue of [
      ANTHROPIC_PRIVATE_KEY,
      PRIVATE_PROMPT,
      PRIVATE_OUTPUT,
      ANTHROPIC_PRIVATE_THINKING,
      ANTHROPIC_PRIVATE_SIGNATURE,
      ANTHROPIC_PRIVATE_REDACTED,
      ANTHROPIC_PRIVATE_MESSAGE_ID,
      'https://',
    ]) {
      expect(visibleEvents).not.toContain(privateValue);
    }
    expect(logger.events.map((event) => event.endpointId)).toEqual([
      'claude_messages',
      'claude_messages',
    ]);
  });

  it('uses machine-type-only classification while fixed auth and 529 mappings keep precedence', async () => {
    const { adapter, transport, logger } = setupAnthropic();
    const privateVendorMessage = 'private vendor invalid request refusal explanation';
    transport.queueJson(
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: privateVendorMessage },
        request_id: 'req_private_anthropic_identifier',
      },
      400,
    );
    await expect(adapter.execute(anthropicRequest())).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_INCOMPATIBLE',
    });
    transport.queueJson(
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: privateVendorMessage },
        request_id: 'req_private_anthropic_identifier',
      },
      401,
    );
    await expect(adapter.execute(anthropicRequest())).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED',
    });
    transport.queueJson({ message: privateVendorMessage }, 529);
    await expect(adapter.execute(anthropicRequest())).rejects.toMatchObject({
      code: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
    });
    expect(JSON.stringify(logger.events)).not.toContain(privateVendorMessage);
    expect(JSON.stringify(logger.events)).not.toContain('req_private_anthropic_identifier');
    expect(logger.events.map((event) => event.errorCode)).toEqual([
      'PROVIDER_MODEL_INCOMPATIBLE',
      'PROVIDER_AUTH_REQUIRED',
      'PROVIDER_TEMPORARILY_UNAVAILABLE',
    ]);
  });

  it('cancels an in-flight Messages request without a live network call', async () => {
    const { adapter, transport } = setupAnthropic();
    const requestId = randomUUID();
    transport.queue(
      (init) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(new DOMException('private abort detail', 'AbortError'));
          init.signal.addEventListener('abort', onAbort, { once: true });
          if (init.signal.aborted) onAbort();
        }),
    );
    const pending = adapter.execute(anthropicRequest(requestId));
    await vi.waitFor(() => expect(transport.calls).toHaveLength(1));
    adapter.cancel(requestId);
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(transport.calls[0]?.init.signal.aborted).toBe(true);
  });
});
