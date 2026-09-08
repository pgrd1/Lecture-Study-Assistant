import { describe, expect, it } from 'vitest';
import type { ProviderTextBlock } from '../../../../../src/core/ports/aiProvider';
import {
  assertAnthropicApiModelId,
  buildAnthropicMessageBody,
  classifyAnthropicApiError,
  parseAnthropicMessage,
  parseAnthropicModelList,
} from '../../../../../src/infrastructure/providers/api/anthropicApiProtocol';
import { APP_ERROR_MESSAGES, AppError } from '../../../../../src/shared/errors';

const MODEL_ID = 'claude-sonnet-5-20260801';
const FIXED_NOW = '2026-09-03T00:00:00.000Z';

const capabilities = () => ({
  batch: { supported: true },
  citations: { supported: false },
  code_execution: { supported: false },
  image_input: { supported: true },
  pdf_input: { supported: true },
  structured_outputs: { supported: true },
  context_management: {
    supported: true,
    clear_thinking_20251015: { supported: true },
    clear_tool_uses_20250919: null,
    compact_20260112: { supported: false },
  },
  effort: {
    supported: true,
    low: { supported: true },
    medium: { supported: true },
    high: { supported: true },
    xhigh: { supported: false },
    max: { supported: false },
  },
  thinking: {
    supported: true,
    types: {
      adaptive: { supported: true },
      enabled: { supported: true },
    },
  },
});

const model = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: MODEL_ID,
  type: 'model',
  display_name: ' Claude Sonnet 5 ',
  created_at: '2026-08-01T09:30:00+09:00',
  capabilities: capabilities(),
  max_input_tokens: 200_000,
  max_tokens: null,
  ...overrides,
});

const modelList = (
  data: readonly unknown[] = [model()],
  overrides: Readonly<Record<string, unknown>> = {},
) => ({
  data,
  has_more: false,
  first_id: MODEL_ID,
  last_id: MODEL_ID,
  ...overrides,
});

const usage = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  input_tokens: 7,
  output_tokens: 3,
  cache_creation_input_tokens: 2,
  cache_read_input_tokens: 1,
  ...overrides,
});

const message = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: 'msg_discarded_private_identifier',
  type: 'message',
  role: 'assistant',
  model: MODEL_ID,
  content: [{ type: 'text', text: '{"ok":true}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: usage(),
  ...overrides,
});

const parseOutput = (value: unknown): Readonly<{ ok: true }> => {
  if ((value as { ok?: unknown } | null)?.ok !== true) throw new Error('private parser failure');
  return Object.freeze({ ok: true as const });
};

const captureFailure = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('EXPECTED_FAILURE');
};

const expectFailureCode = (
  action: () => unknown,
  code: string,
  privateValues: readonly string[] = Object.freeze([]),
): void => {
  const failure = captureFailure(action);
  expect(failure).toMatchObject({ code });
  const visible = `${String(failure)} ${JSON.stringify(failure)}`;
  for (const privateValue of privateValues) expect(visible).not.toContain(privateValue);
  expect((failure as { cause?: unknown }).cause).toBeUndefined();
};

const expectOutputInvalid = (
  action: () => unknown,
  privateValues: readonly string[] = Object.freeze([]),
): void => expectFailureCode(action, 'PROVIDER_OUTPUT_INVALID', privateValues);

describe('Anthropic model-list protocol', () => {
  it('accepts the exact current root/item grammar and discards bounded metadata and capabilities', () => {
    const result = parseAnthropicModelList(modelList());
    expect(result).toEqual([
      { modelId: MODEL_ID, displayName: 'Claude Sonnet 5', compatibility: 'unverified' },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
    const visible = JSON.stringify(result);
    for (const discarded of ['capabilities', 'created_at', 'max_input_tokens', 'max_tokens']) {
      expect(visible).not.toContain(discarded);
    }
  });

  it('accepts absent, null, empty, and subset capability forms without inventing required fields', () => {
    const entries = [
      model({ id: 'claude-no-capabilities', capabilities: undefined }),
      model({ id: 'claude-null-capabilities', capabilities: null }),
      model({ id: 'claude-empty-capabilities', capabilities: {} }),
      model({
        id: 'claude-subset-capabilities',
        capabilities: { batch: { supported: false } },
      }),
    ].map((entry) => {
      if (entry.capabilities !== undefined) return entry;
      const { capabilities: _discarded, ...withoutCapabilities } = entry;
      return withoutCapabilities;
    });
    expect(parseAnthropicModelList(modelList(entries))).toHaveLength(4);
  });

  it.each([
    ['missing root field', { data: [], has_more: false, first_id: null }],
    ['unknown root field', { ...modelList([]), next_page: 'private' }],
    ['incomplete page', modelList([], { has_more: true })],
    ['too many entries', modelList(Array.from({ length: 101 }, () => model()))],
    ['duplicate IDs', modelList([model(), model({ display_name: 'Duplicate' })])],
    ['unsafe ID', modelList([model({ id: 'unsafe/id' })])],
    ['wrong type', modelList([model({ type: 'not-model' })])],
    ['empty display name', modelList([model({ display_name: '   ' })])],
    ['long display name', modelList([model({ display_name: 'x'.repeat(121) })])],
    ['control display name', modelList([model({ display_name: 'Claude\nPrivate' })])],
    ['format display name', modelList([model({ display_name: 'Claude\u200bPrivate' })])],
    ['invalid timestamp', modelList([model({ created_at: '2026-02-30T00:00:00Z' })])],
    ['unbounded timestamp', modelList([model({ created_at: 'x'.repeat(257) })])],
    ['negative max tokens', modelList([model({ max_tokens: -1 })])],
    ['fraction max input', modelList([model({ max_input_tokens: 1.5 })])],
    ['unknown model key', modelList([model({ private: true })])],
    ['unknown capability', modelList([model({ capabilities: { private: {} } })])],
    [
      'unknown nested capability key',
      modelList([model({ capabilities: { batch: { supported: true, private: true } } })]),
    ],
    [
      'missing required nested capability key',
      modelList([model({ capabilities: { context_management: { supported: true } } })]),
    ],
    [
      'wrong thinking types',
      modelList([
        model({
          capabilities: {
            thinking: { supported: true, types: { adaptive: { supported: true } } },
          },
        }),
      ]),
    ],
  ])('rejects %s', (_name, value) => expectOutputInvalid(() => parseAnthropicModelList(value)));

  it('accepts null page IDs and null token limits but rejects unsafe page IDs', () => {
    expect(
      parseAnthropicModelList(
        modelList([model({ max_input_tokens: null, max_tokens: null })], {
          first_id: null,
          last_id: null,
        }),
      ),
    ).toHaveLength(1);
    expectOutputInvalid(() =>
      parseAnthropicModelList(modelList([], { first_id: 'unsafe/id', last_id: null })),
    );
  });

  it('rejects proxy, getter, symbol, hidden, inherited, sparse, and cyclic shapes without trap reads', () => {
    let proxyTrapCalls = 0;
    const proxy = new Proxy(modelList(), {
      get: () => {
        proxyTrapCalls += 1;
        return undefined;
      },
      ownKeys: () => {
        proxyTrapCalls += 1;
        return [];
      },
    });
    let getterCalls = 0;
    const getter = Object.defineProperty({ ...modelList() }, 'data', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return [];
      },
    });
    const symbol = Object.defineProperty(modelList(), Symbol('private'), {
      enumerable: true,
      value: true,
    });
    const hidden = Object.defineProperty(modelList(), 'private', {
      enumerable: false,
      value: true,
    });
    const inherited = Object.assign(Object.create({ private: true }), modelList());
    const sparse = new Array(1);
    const cyclicCapability: Record<string, unknown> = {};
    cyclicCapability.batch = cyclicCapability;
    for (const value of [
      proxy,
      getter,
      symbol,
      hidden,
      inherited,
      modelList(sparse),
      modelList([model({ capabilities: cyclicCapability })]),
    ]) {
      expectOutputInvalid(() => parseAnthropicModelList(value));
    }
    expect(proxyTrapCalls).toBe(0);
    expect(getterCalls).toBe(0);
  });
});

describe('Anthropic Messages response protocol', () => {
  it('returns only an owned frozen result with safe model, local time, and exact aggregate usage', () => {
    const parserValue = { ok: true, nested: ['owned'] };
    const result = parseAnthropicMessage(
      message(),
      () => parserValue as Readonly<{ ok: true; nested: readonly string[] }>,
      FIXED_NOW,
    );
    expect(result).toEqual({
      output: { ok: true, nested: ['owned'] },
      reportedModelId: MODEL_ID,
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      completedAt: FIXED_NOW,
    });
    expect(result.output).not.toBe(parserValue);
    expect(result.output.nested).not.toBe(parserValue.nested);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen(result.output.nested)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
    parserValue.nested[0] = 'mutated';
    expect(result.output.nested).toEqual(['owned']);
    expect(JSON.stringify(result)).not.toContain('msg_discarded_private_identifier');
  });

  it('accepts zero or multiple leading thinking/redacted blocks and discards their data', () => {
    const result = parseAnthropicMessage(
      message({
        content: [
          { type: 'thinking', thinking: 'private thought one', signature: 'private signature' },
          { type: 'redacted_thinking', data: 'private opaque redaction' },
          { type: 'thinking', thinking: 'private thought two', signature: '' },
          { type: 'text', text: '{"ok":true}' },
        ],
      }),
      parseOutput,
      FIXED_NOW,
    );
    expect(result.output).toEqual({ ok: true });
    const visible = JSON.stringify(result);
    for (const discarded of ['private thought', 'private signature', 'private opaque']) {
      expect(visible).not.toContain(discarded);
    }
  });

  it.each([
    ['missing text', []],
    [
      'multiple text',
      [
        { type: 'text', text: '{"ok":true}' },
        { type: 'text', text: '{}' },
      ],
    ],
    ['empty text', [{ type: 'text', text: '' }]],
    [
      'thinking after text',
      [
        { type: 'text', text: '{"ok":true}' },
        { type: 'thinking', thinking: 'private', signature: 'private' },
      ],
    ],
    [
      'interleaved thinking',
      [
        { type: 'thinking', thinking: 'private', signature: 'private' },
        { type: 'text', text: '{"ok":true}' },
        { type: 'redacted_thinking', data: 'private' },
      ],
    ],
    ['text citation field', [{ type: 'text', text: '{"ok":true}', citations: [] }]],
    ['text extra field', [{ type: 'text', text: '{"ok":true}', private: true }]],
    ['unknown block', [{ type: 'image', source: 'private' }]],
  ])('rejects %s', (_name, content) =>
    expectOutputInvalid(() => parseAnthropicMessage(message({ content }), parseOutput, FIXED_NOW)),
  );

  it('maps a structurally proven tool-use block or stop reason to tool activity', () => {
    for (const candidate of [
      message({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_private',
            name: 'web_search',
            input: { query: 'private' },
          },
        ],
      }),
      message({ stop_reason: 'tool_use' }),
    ]) {
      expectFailureCode(
        () => parseAnthropicMessage(candidate, parseOutput, FIXED_NOW),
        'PROVIDER_TOOL_ACTIVITY_DETECTED',
        ['toolu_private', 'web_search'],
      );
    }
  });

  it('maps refusal only from the structured stop reason and discards all refusal content', () => {
    const privateRefusal = 'private refusal detail';
    expectFailureCode(
      () =>
        parseAnthropicMessage(
          message({
            stop_reason: 'refusal',
            content: [{ type: 'text', text: privateRefusal }],
          }),
          parseOutput,
          FIXED_NOW,
        ),
      'PROVIDER_REFUSED',
      [privateRefusal],
    );
  });

  it.each([
    'max_tokens',
    'stop_sequence',
    'pause_turn',
    'model_context_window_exceeded',
    null,
    'x',
  ])('rejects non-success stop reason %s', (stopReason) =>
    expectOutputInvalid(() =>
      parseAnthropicMessage(message({ stop_reason: stopReason }), parseOutput, FIXED_NOW),
    ),
  );

  it.each([
    ['wrong root type', { type: 'not-message' }],
    ['wrong role', { role: 'user' }],
    ['unsafe model', { model: 'unsafe/model' }],
    ['non-null stop sequence', { stop_sequence: 'private stop' }],
    ['unknown root field', { private: true }],
    ['invalid local time', {}],
  ])('rejects %s', (name, overrides) =>
    expectOutputInvalid(() =>
      parseAnthropicMessage(
        message(overrides),
        parseOutput,
        name === 'invalid local time' ? 'not-a-time' : FIXED_NOW,
      ),
    ),
  );

  it('accepts all current optional usage fields and does not double-count observational details', () => {
    const result = parseAnthropicMessage(
      message({
        usage: usage({
          cache_creation: {
            ephemeral_1h_input_tokens: 1,
            ephemeral_5m_input_tokens: 1,
          },
          inference_geo: 'us-east',
          output_tokens_details: { thinking_tokens: 2 },
          server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
          service_tier: 'priority',
        }),
      }),
      parseOutput,
      FIXED_NOW,
    );
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });

    const noOptional = parseAnthropicMessage(
      message({ usage: { input_tokens: 0, output_tokens: 0 } }),
      parseOutput,
      FIXED_NOW,
    );
    expect(noOptional.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('maps nonzero server tool counters to tool activity', () => {
    for (const serverToolUse of [
      { web_fetch_requests: 1, web_search_requests: 0 },
      { web_fetch_requests: 0, web_search_requests: 1 },
    ]) {
      expectFailureCode(
        () =>
          parseAnthropicMessage(
            message({ usage: usage({ server_tool_use: serverToolUse }) }),
            parseOutput,
            FIXED_NOW,
          ),
        'PROVIDER_TOOL_ACTIVITY_DETECTED',
      );
    }
  });

  it.each([
    ['negative', { input_tokens: -1 }],
    ['fraction', { output_tokens: 1.5 }],
    ['NaN', { cache_read_input_tokens: Number.NaN }],
    ['negative zero', { cache_creation_input_tokens: -0 }],
    ['input overflow', { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1 }],
    ['total overflow', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }],
    ['thinking exceeds output', { output_tokens_details: { thinking_tokens: 4 } }],
    ['null optional counter', { cache_read_input_tokens: null }],
    ['unknown usage field', { private: 0 }],
    [
      'unknown cache field',
      {
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0, private: 0 },
      },
    ],
    ['null optional object', { cache_creation: null }],
    ['unsafe service tier', { service_tier: 'free' }],
  ])('rejects usage %s', (_name, overrides) =>
    expectOutputInvalid(() =>
      parseAnthropicMessage(message({ usage: usage(overrides) }), parseOutput, FIXED_NOW),
    ),
  );

  it('normalizes malformed, duplicate-key, deep, overwide JSON and untrusted parser failures', () => {
    const overwide = JSON.stringify(Array.from({ length: 100_001 }, () => 0));
    for (const text of [
      'private invalid json',
      '{"ok":true,"ok":true}',
      `${'['.repeat(66)}0${']'.repeat(66)}`,
      overwide,
    ]) {
      expectOutputInvalid(
        () =>
          parseAnthropicMessage(
            message({ content: [{ type: 'text', text }] }),
            parseOutput,
            FIXED_NOW,
          ),
        [text === overwide ? 'EXPECTED_NOT_PRESENT' : text],
      );
    }
    expectOutputInvalid(() =>
      parseAnthropicMessage(
        message(),
        () => {
          throw new Error('private parser detail');
        },
        FIXED_NOW,
      ),
    );
  });

  it('preserves a trusted local parser AppError by exact identity', () => {
    const trusted = new AppError(
      'PROVIDER_RATE_LIMITED',
      APP_ERROR_MESSAGES.PROVIDER_RATE_LIMITED,
      { retryAfterMs: 4_321 },
    );
    const failure = captureFailure(() =>
      parseAnthropicMessage(
        message(),
        () => {
          throw trusted;
        },
        FIXED_NOW,
      ),
    );
    expect(failure).toBe(trusted);
    expect(AppError.getRetryAfterMs(failure)).toBe(4_321);
  });

  it('rejects proxy, getter, symbol, hidden, inherited, sparse, and hostile parser results', () => {
    let proxyTrapCalls = 0;
    const proxy = new Proxy(message(), { get: () => (proxyTrapCalls += 1) });
    let getterCalls = 0;
    const getter = Object.defineProperty({ ...message() }, 'content', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return [];
      },
    });
    const symbol = Object.defineProperty(message(), Symbol('private'), {
      enumerable: true,
      value: true,
    });
    const hidden = Object.defineProperty(message(), 'private', {
      enumerable: false,
      value: true,
    });
    const inherited = Object.assign(Object.create({ private: true }), message());
    const sparse = new Array(1);
    for (const value of [proxy, getter, symbol, hidden, inherited, message({ content: sparse })]) {
      expectOutputInvalid(() => parseAnthropicMessage(value, parseOutput, FIXED_NOW));
    }
    let parserTrapCalls = 0;
    const hostileParserResult = new Proxy({ ok: true }, { get: () => (parserTrapCalls += 1) });
    expectOutputInvalid(() =>
      parseAnthropicMessage(message(), () => hostileParserResult as never, FIXED_NOW),
    );
    expect(proxyTrapCalls).toBe(0);
    expect(getterCalls).toBe(0);
    expect(parserTrapCalls).toBe(0);
  });
});

describe('Anthropic request and error contracts', () => {
  it('builds the exact immutable role-separated body and keeps one owned schema copy only', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { const: true } },
    };
    const blocks: readonly ProviderTextBlock[] = Object.freeze([
      Object.freeze({ role: 'user', kind: 'source', text: 'source' }),
      Object.freeze({ role: 'system', kind: 'instruction', text: 'instruction' }),
      Object.freeze({ role: 'user', kind: 'professor_note', text: 'note' }),
    ]);
    const body = buildAnthropicMessageBody({
      modelId: 'claude-sonnet-5',
      blocks,
      outputJsonSchema: schema,
      maxOutputTokens: 1_024,
    });
    expect(body).toEqual({
      model: 'claude-sonnet-5',
      system: JSON.stringify({
        blocks: [{ index: 1, role: 'system', kind: 'instruction', text: 'instruction' }],
      }),
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            blocks: [
              { index: 0, role: 'user', kind: 'source', text: 'source' },
              { index: 2, role: 'user', kind: 'professor_note', text: 'note' },
            ],
          }),
        },
      ],
      max_tokens: 1_024,
      stream: false,
      output_config: { format: { type: 'json_schema', schema } },
    });
    const bodyObject = body as Record<string, unknown>;
    expect(Object.keys(bodyObject).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'stream',
      'system',
    ]);
    const serialized = JSON.stringify(body);
    for (const prohibited of [
      '"tools"',
      '"tool_choice"',
      '"thinking"',
      '"metadata"',
      '"temperature"',
      '"top_p"',
      '"top_k"',
      '"stop_sequences"',
      '"anthropic-beta"',
      '"history"',
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
    const ownedSchema = (body as { output_config: { format: { schema: typeof schema } } })
      .output_config.format.schema;
    expect(ownedSchema).not.toBe(schema);
    expect(ownedSchema.properties).not.toBe(schema.properties);
    expect(Object.isFrozen(ownedSchema.properties.ok)).toBe(true);
    schema.properties.ok.const = false;
    expect(ownedSchema.properties.ok.const).toBe(true);
  });

  it('rejects hostile, cyclic, deep, hidden, and overwide schemas without invoking traps', () => {
    let trapCalls = 0;
    const proxy = new Proxy(
      { type: 'object', additionalProperties: false },
      { get: () => (trapCalls += 1) },
    );
    const cyclic: Record<string, unknown> = { type: 'object', additionalProperties: false };
    cyclic.properties = cyclic;
    const hidden = Object.defineProperty(
      { type: 'object', additionalProperties: false },
      'private',
      { enumerable: false, value: true },
    );
    let deep: Record<string, unknown> = { type: 'object', additionalProperties: false };
    for (let index = 0; index < 66; index += 1) deep = { nested: deep };
    const overwide = Object.fromEntries(
      Array.from({ length: 100_001 }, (_, index) => [`x${index}`, 0]),
    );
    for (const outputJsonSchema of [proxy, cyclic, hidden, deep, overwide]) {
      expectFailureCode(
        () =>
          buildAnthropicMessageBody({
            modelId: 'claude-sonnet-5',
            blocks: [],
            outputJsonSchema: outputJsonSchema as never,
            maxOutputTokens: 128,
          }),
        'PROVIDER_EXECUTION_FAILED',
      );
    }
    expect(trapCalls).toBe(0);
  });

  it('validates model IDs', () => {
    expect(assertAnthropicApiModelId('claude-sonnet-5')).toBe('claude-sonnet-5');
    for (const value of [null, '', 'unsafe/id']) {
      expectFailureCode(() => assertAnthropicApiModelId(value), 'PROVIDER_MODEL_INCOMPATIBLE');
    }
  });

  it.each([
    [400, 'invalid_request_error'],
    [422, 'invalid_request_error'],
    [404, 'not_found_error'],
  ] as const)(
    'maps HTTP %i machine type %s to model incompatibility independently of message text',
    (status, machineType) => {
      expect(
        classifyAnthropicApiError(status, {
          type: 'error',
          error: { type: machineType, message: 'refusal not_found_error invalid_request_error' },
          request_id: 'req_discarded_private',
        }),
      ).toBe('PROVIDER_MODEL_INCOMPATIBLE');
    },
  );

  it('fails closed for other status/type combinations and malformed or extended envelopes', () => {
    const hostileMessage = 'invalid_request_error not_found_error refusal';
    for (const [status, machineType] of [
      [400, 'not_found_error'],
      [404, 'invalid_request_error'],
      [409, 'invalid_request_error'],
      [422, 'not_found_error'],
    ] as const) {
      expect(
        classifyAnthropicApiError(status, {
          type: 'error',
          error: { type: machineType, message: hostileMessage },
          request_id: 'req_discarded_private',
        }),
      ).toBe('PROVIDER_EXECUTION_FAILED');
    }
    for (const body of [
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: hostileMessage, details: {} },
        request_id: 'req_discarded_private',
      },
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 1 },
        request_id: 'req_discarded_private',
      },
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: hostileMessage },
      },
      {
        type: 'error',
        error: { type: 'INVALID_REQUEST_ERROR', message: hostileMessage },
        request_id: 'req_discarded_private',
      },
    ]) {
      expect(classifyAnthropicApiError(400, body as never)).toBe('PROVIDER_EXECUTION_FAILED');
    }
  });
});
