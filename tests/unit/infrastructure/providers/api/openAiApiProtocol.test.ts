import { describe, expect, it } from 'vitest';
import type { ProviderTextBlock } from '../../../../../src/core/ports/aiProvider';
import {
  assertOpenAiApiModelId,
  buildOpenAiResponseBody,
  classifyOpenAiApiError,
  parseOpenAiModelList,
  parseOpenAiResponse,
} from '../../../../../src/infrastructure/providers/api/openAiApiProtocol';
import { AppError } from '../../../../../src/shared/errors';

const MODEL_ID = 'gpt-5.6-2026-08-01';
const FIXED_NOW = '2026-09-03T00:00:00.000Z';
const ERROR_MESSAGE_MAX_BYTES = 64 * 1024;
const ERROR_TYPE_MAX_BYTES = 256;
const ERROR_PARAM_MAX_BYTES = 2 * 1024;

const exactUtf8Bytes = (bytes: number): string =>
  `${'한'.repeat(Math.floor(bytes / 3))}${'a'.repeat(bytes % 3)}`;

const usage = () => ({
  input_tokens: 7,
  input_tokens_details: { cached_tokens: 2 },
  output_tokens: 3,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 11,
});

const response = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  object: 'response',
  status: 'completed',
  error: null,
  incomplete_details: null,
  model: MODEL_ID,
  output: [
    {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '{"ok":true}', annotations: [], logprobs: [] }],
    },
  ],
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

const expectOutputInvalid = (
  action: () => unknown,
  privateValues: readonly string[] = [],
): void => {
  const failure = captureFailure(action);
  expect(failure).toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
  const serialized = JSON.stringify(failure);
  for (const value of privateValues) expect(serialized).not.toContain(value);
  expect((failure as { cause?: unknown }).cause).toBeUndefined();
};

describe('OpenAI model-list protocol', () => {
  it('accepts only the exact documented list shape and returns frozen safe identifiers', () => {
    const result = parseOpenAiModelList({
      object: 'list',
      data: [
        { id: 'gpt-5.6', object: 'model', created: 1, owned_by: 'openai' },
        {
          id: 'gpt-5.6-mini',
          object: 'model',
          created: 0,
          owned_by: 'system',
          shutdown_date: null,
        },
      ],
    });
    expect(result).toEqual([
      { modelId: 'gpt-5.6', displayName: 'gpt-5.6', compatibility: 'unverified' },
      { modelId: 'gpt-5.6-mini', displayName: 'gpt-5.6-mini', compatibility: 'unverified' },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('owned_by');
  });

  it.each([
    ['wrong root discriminator', { object: 'collection', data: [] }],
    ['pagination field', { object: 'list', data: [], has_more: false }],
    ['missing data', { object: 'list' }],
    ['too many models', { object: 'list', data: Array.from({ length: 1_001 }, () => null) }],
    [
      'duplicate IDs',
      {
        object: 'list',
        data: [
          { id: 'gpt-safe', object: 'model', created: 1, owned_by: 'openai' },
          { id: 'gpt-safe', object: 'model', created: 2, owned_by: 'system' },
        ],
      },
    ],
    [
      'unsafe ID',
      { object: 'list', data: [{ id: 'unsafe/id', object: 'model', created: 1, owned_by: 'x' }] },
    ],
    [
      'negative timestamp',
      { object: 'list', data: [{ id: 'gpt-safe', object: 'model', created: -1, owned_by: 'x' }] },
    ],
    [
      'unknown model key',
      {
        object: 'list',
        data: [{ id: 'gpt-safe', object: 'model', created: 1, owned_by: 'x', private: true }],
      },
    ],
  ])('rejects %s', (_name, value) => expectOutputInvalid(() => parseOpenAiModelList(value)));

  it('rejects Proxy, accessors, symbols, hidden, inherited, and sparse shapes without reads', () => {
    let trapCalls = 0;
    const proxy = new Proxy(
      { object: 'list', data: [] },
      {
        get: () => {
          trapCalls += 1;
        },
        ownKeys: () => {
          trapCalls += 1;
          return [];
        },
      },
    );
    let getterCalls = 0;
    const getter = Object.defineProperty({ object: 'list' }, 'data', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return [];
      },
    });
    const symbol = Object.defineProperty({ object: 'list', data: [] }, Symbol('private'), {
      enumerable: true,
      value: true,
    });
    const hidden = Object.defineProperty({ object: 'list', data: [] }, 'private', {
      enumerable: false,
      value: true,
    });
    const inherited = Object.assign(Object.create({ private: true }), { object: 'list', data: [] });
    const sparse = new Array(1);
    for (const value of [
      proxy,
      getter,
      symbol,
      hidden,
      inherited,
      { object: 'list', data: sparse },
    ]) {
      expectOutputInvalid(() => parseOpenAiModelList(value));
    }
    expect(trapCalls).toBe(0);
    expect(getterCalls).toBe(0);
  });
});

describe('OpenAI Responses protocol', () => {
  it('returns only a deep-frozen owned output, safe reported model, local time, and usage', () => {
    const parserValue = { ok: true, nested: ['owned'] };
    const result = parseOpenAiResponse(
      response({ id: 'resp_private', created_at: 1, completed_at: 2 }),
      () => parserValue as Readonly<{ ok: true; nested: readonly string[] }>,
      FIXED_NOW,
    );
    expect(result).toEqual({
      output: { ok: true, nested: ['owned'] },
      reportedModelId: MODEL_ID,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 11 },
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
    expect(JSON.stringify(result)).not.toContain('resp_private');
  });

  it('accepts documented reasoning only before the message and discards it completely', () => {
    const result = parseOpenAiResponse(
      response({
        output: [
          {
            id: 'reason_private',
            type: 'reasoning',
            status: 'completed',
            summary: [{ type: 'summary_text', text: 'private summary' }],
            content: [{ type: 'reasoning_text', text: 'private reasoning' }],
            encrypted_content: 'private encrypted reasoning',
          },
          ...response().output,
        ],
      }),
      parseOutput,
      FIXED_NOW,
    );
    expect(result.output).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('accepts independent safe usage counters and documented cache details', () => {
    const result = parseOpenAiResponse(
      response({
        usage: {
          input_tokens: 3,
          input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
          output_tokens: 4,
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 99,
        },
      }),
      parseOutput,
      FIXED_NOW,
    );
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 99 });
  });

  it.each(['failed', 'incomplete', 'in_progress', 'cancelled', 'queued'])(
    'rejects noncompleted state %s',
    (status) =>
      expectOutputInvalid(() => parseOpenAiResponse(response({ status }), parseOutput, FIXED_NOW)),
  );

  it.each([
    ['nonnull error', { error: { code: 'private' } }],
    ['nonnull incomplete details', { incomplete_details: { reason: 'max_output_tokens' } }],
    ['unknown root key', { private_account_id: 'private' }],
    ['stored echo', { store: true }],
    ['background echo', { background: true }],
    ['parallel tools echo', { parallel_tool_calls: true }],
    ['tools echo', { tools: [{ type: 'web_search_preview' }] }],
    ['tool choice echo', { tool_choice: 'auto' }],
    ['truncation echo', { truncation: 'auto' }],
    ['unsafe model', { model: 'unsafe/model' }],
    ['zero messages', { output: [] }],
    ['two messages', { output: [...response().output, ...response().output] }],
    [
      'two text candidates',
      {
        output: [
          {
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: '{"ok":true}' },
              { type: 'output_text', text: '{"ok":true}' },
            ],
          },
        ],
      },
    ],
    [
      'nonempty annotations',
      {
        output: [
          {
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: '{"ok":true}', annotations: [{ type: 'url_citation' }] },
            ],
          },
        ],
      },
    ],
    [
      'reasoning after message',
      { output: [...response().output, { type: 'reasoning', summary: [] }] },
    ],
    [
      'malformed reasoning',
      {
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 7 }] },
          ...response().output,
        ],
      },
    ],
  ])('rejects %s', (_name, overrides) =>
    expectOutputInvalid(() => parseOpenAiResponse(response(overrides), parseOutput, FIXED_NOW)),
  );

  it('maps a closed refusal to a fixed refusal without retaining its text', () => {
    const privateRefusal = 'private refusal detail';
    const failure = captureFailure(() =>
      parseOpenAiResponse(
        response({
          output: [
            {
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'refusal', refusal: privateRefusal }],
            },
          ],
        }),
        parseOutput,
        FIXED_NOW,
      ),
    );
    expect(failure).toMatchObject({ code: 'PROVIDER_REFUSED' });
    expect(JSON.stringify(failure)).not.toContain(privateRefusal);
  });

  it.each([
    'function_call',
    'computer_call',
    'file_search_call',
    'web_search_call',
    'code_interpreter_call',
    'image_generation_call',
    'local_shell_call',
    'mcp_call',
    'custom_tool_call',
    'shell_call',
    'apply_patch_call',
    'function_call_output',
    'computer_call_output',
    'local_shell_call_output',
    'shell_call_output',
    'apply_patch_call_output',
    'mcp_list_tools',
    'mcp_approval_request',
    'custom_tool_call_output',
  ])('maps documented tool/action item %s to tool activity', (type) => {
    const failure = captureFailure(() =>
      parseOpenAiResponse(response({ output: [{ type }] }), parseOutput, FIXED_NOW),
    );
    expect(failure).toMatchObject({ code: 'PROVIDER_TOOL_ACTIVITY_DETECTED' });
  });

  it('normalizes unknown items, malformed JSON, duplicate JSON keys, excessive nesting, and parser errors', () => {
    expectOutputInvalid(() =>
      parseOpenAiResponse(response({ output: [{ type: 'private' }] }), parseOutput, FIXED_NOW),
    );
    for (const text of [
      'private invalid json',
      '{"ok":true,"ok":true}',
      `${'['.repeat(66)}0${']'.repeat(66)}`,
    ]) {
      expectOutputInvalid(
        () =>
          parseOpenAiResponse(
            response({
              output: [
                {
                  type: 'message',
                  status: 'completed',
                  role: 'assistant',
                  content: [{ type: 'output_text', text }],
                },
              ],
            }),
            parseOutput,
            FIXED_NOW,
          ),
        [text],
      );
    }
    expectOutputInvalid(() =>
      parseOpenAiResponse(
        response(),
        () => {
          throw new Error('private parser');
        },
        FIXED_NOW,
      ),
    );
  });

  it('preserves a trusted local parser AppError by exact identity', () => {
    const trusted = new AppError(
      'PROVIDER_RATE_LIMITED',
      'AI 제공자 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.',
      { retryAfterMs: 4_321 },
    );
    const failure = captureFailure(() =>
      parseOpenAiResponse(
        response(),
        () => {
          throw trusted;
        },
        FIXED_NOW,
      ),
    );
    expect(failure).toBe(trusted);
    expect(AppError.getRetryAfterMs(failure)).toBe(4_321);
  });

  it('rejects Proxy, getter, symbol, hidden, inherited, sparse, overwide, and overdeep shapes', () => {
    let trapCalls = 0;
    const proxy = new Proxy(response(), { get: () => (trapCalls += 1) });
    let getterCalls = 0;
    const getter = Object.defineProperty({ ...response() }, 'model', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return MODEL_ID;
      },
    });
    const symbol = Object.defineProperty(response(), Symbol('private'), {
      enumerable: true,
      value: true,
    });
    const hidden = Object.defineProperty(response(), 'private', { enumerable: false, value: true });
    const inherited = Object.assign(Object.create({ private: true }), response());
    const sparse = new Array(1);
    const tooWideUsage = {
      ...usage(),
      input_tokens_details: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`x${i}`, i])),
    };
    for (const value of [
      proxy,
      getter,
      symbol,
      hidden,
      inherited,
      response({ output: sparse }),
      response({ usage: tooWideUsage }),
    ]) {
      expectOutputInvalid(() => parseOpenAiResponse(value, parseOutput, FIXED_NOW));
    }
    expect(trapCalls).toBe(0);
    expect(getterCalls).toBe(0);
  });
});

describe('OpenAI request and error contracts', () => {
  it('builds exact immutable role-separated input and keeps schema only in text.format', () => {
    const schema: {
      type: string;
      additionalProperties: boolean;
      properties: { ok: { const: boolean } };
    } = {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { const: true } },
    } as const;
    const blocks: readonly ProviderTextBlock[] = Object.freeze([
      Object.freeze({ role: 'user', kind: 'source', text: 'source' }),
      Object.freeze({ role: 'system', kind: 'instruction', text: 'instruction' }),
      Object.freeze({ role: 'user', kind: 'professor_note', text: 'note' }),
    ]);
    const body = buildOpenAiResponseBody({
      modelId: 'gpt-5.6',
      blocks,
      outputJsonSchema: schema,
      outputSchemaId: 'lecture_output',
      maxOutputTokens: 1_024,
    });
    const bodyObject = body as Readonly<Record<string, unknown>>;
    expect(body).toEqual({
      model: 'gpt-5.6',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                blocks: [{ index: 1, role: 'system', kind: 'instruction', text: 'instruction' }],
              }),
            },
          ],
        },
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                blocks: [
                  { index: 0, role: 'user', kind: 'source', text: 'source' },
                  { index: 2, role: 'user', kind: 'professor_note', text: 'note' },
                ],
              }),
            },
          ],
        },
      ],
      store: false,
      background: false,
      stream: false,
      tools: [],
      tool_choice: 'none',
      parallel_tool_calls: false,
      truncation: 'disabled',
      max_output_tokens: 1_024,
      text: {
        format: {
          type: 'json_schema',
          name: 'lecture_output',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { anyOf: [{ const: true }, { type: 'null' }] } },
            required: ['ok'],
          },
        },
      },
    });
    expect(JSON.stringify(bodyObject.input)).not.toContain('additionalProperties');
    for (const key of [
      'instructions',
      'include',
      'max_tool_calls',
      'previous_response_id',
      'conversation',
      'reasoning',
      'metadata',
      'prompt_cache_key',
      'safety_identifier',
      'temperature',
      'top_p',
      'service_tier',
    ]) {
      expect(Object.keys(bodyObject)).not.toContain(key);
    }
    expect(Object.isFrozen(body)).toBe(true);
    expect(Object.isFrozen(bodyObject.input)).toBe(true);
    const ownedSchema = (
      body as {
        text: { format: { schema: { properties: { ok: { anyOf: [{ const: boolean }] } } } } };
      }
    ).text.format.schema;
    expect(ownedSchema).not.toBe(schema);
    expect(ownedSchema.properties).not.toBe(schema.properties);
    expect(Object.isFrozen(ownedSchema.properties.ok)).toBe(true);
    schema.properties.ok.const = false;
    expect(ownedSchema.properties.ok.anyOf[0].const).toBe(true);
  });

  it('uses fixed probe schema name without adding it to the public allowlist', () => {
    const body = buildOpenAiResponseBody({
      modelId: 'gpt-5.6',
      blocks: [],
      outputJsonSchema: { type: 'object', additionalProperties: false },
      outputSchemaId: 'provider_probe_v1',
      maxOutputTokens: 128,
    });
    expect((body as { text: { format: { name: string } } }).text.format.name).toBe(
      'provider_probe_v1',
    );
  });

  it('validates model IDs', () => {
    expect(assertOpenAiApiModelId('gpt-5.6')).toBe('gpt-5.6');
    for (const value of [null, '', 'unsafe/id']) {
      expect(captureFailure(() => assertOpenAiApiModelId(value))).toMatchObject({
        code: 'PROVIDER_MODEL_INCOMPATIBLE',
      });
    }
  });

  it.each(['model_not_found', 'invalid_json_schema', 'unsupported_parameter', 'unsupported_value'])(
    'maps machine code %s to model incompatibility regardless of hostile message',
    (code) =>
      expect(
        classifyOpenAiApiError(400, {
          error: { code, message: 'safety refusal model_not_found', type: 'private', param: null },
        }),
      ).toBe('PROVIDER_MODEL_INCOMPATIBLE'),
  );

  it.each([
    ['empty strings', '', '', ''],
    ['arbitrary private strings', 'private vendor message', 'private vendor type', 'private'],
    ['Unicode strings', '비공개 오류 🚫', '오류 유형', '매개변수'],
    ['null param', '', '', null],
    ['boundary message', exactUtf8Bytes(ERROR_MESSAGE_MAX_BYTES), '', null],
    ['boundary type', '', exactUtf8Bytes(ERROR_TYPE_MAX_BYTES), null],
    ['boundary param', '', '', exactUtf8Bytes(ERROR_PARAM_MAX_BYTES)],
  ] as const)(
    'classifies exact machine code independently of %s',
    (_name, message, type, param) => {
      expect(
        classifyOpenAiApiError(400, {
          error: { code: 'model_not_found', message, type, param },
        }),
      ).toBe('PROVIDER_MODEL_INCOMPATIBLE');
    },
  );

  it.each([
    ['message', `${exactUtf8Bytes(ERROR_MESSAGE_MAX_BYTES)}a`, '', ''],
    ['type', '', `${exactUtf8Bytes(ERROR_TYPE_MAX_BYTES)}a`, ''],
    ['param', '', '', `${exactUtf8Bytes(ERROR_PARAM_MAX_BYTES)}a`],
  ] as const)(
    'fails closed when discarded %s exceeds its UTF-8 byte cap by one byte',
    (_name, message, type, stringParam) => {
      expect(
        classifyOpenAiApiError(400, {
          error: { code: 'model_not_found', message, type, param: stringParam },
        }),
      ).toBe('PROVIDER_EXECUTION_FAILED');
    },
  );

  it.each([
    ['non-string message', { code: 'model_not_found', message: 1, type: '', param: null }],
    ['non-string type', { code: 'model_not_found', message: '', type: false, param: null }],
    ['non-string/non-null param', { code: 'model_not_found', message: '', type: '', param: {} }],
  ])('fails closed for %s without using discarded content', (_name, error) => {
    expect(classifyOpenAiApiError(400, { error } as never)).toBe('PROVIDER_EXECUTION_FAILED');
  });

  it('maps only the reviewed policy code to refusal and fails closed for all other envelopes', () => {
    expect(
      classifyOpenAiApiError(400, {
        error: {
          code: 'content_policy_violation',
          message: 'private',
          type: 'invalid_request_error',
          param: null,
        },
      }),
    ).toBe('PROVIDER_REFUSED');
    for (const body of [
      {
        error: {
          code: 'unknown',
          message: 'model_not_found',
          type: 'content_policy_violation',
          param: null,
        },
      },
      { error: { code: 'MODEL_NOT_FOUND', message: 'private', type: 'private', param: null } },
      {
        error: {
          code: 'model_not_found',
          message: 'private',
          type: 'private',
          param: null,
          extra: true,
        },
      },
    ])
      expect(classifyOpenAiApiError(400, body as never)).toBe('PROVIDER_EXECUTION_FAILED');
  });
});
