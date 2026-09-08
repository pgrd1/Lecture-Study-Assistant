import { describe, expect, it } from 'vitest';
import {
  classifyGeminiApiError,
  parseGeminiInteraction,
  parseGeminiModelList,
} from '../../../../../src/infrastructure/providers/api/geminiApiProtocol';
import type { JsonValue } from '../../../../../src/shared/contracts/provider';
import { AppError } from '../../../../../src/shared/errors';

const FIXED_NOW = '2026-09-03T00:00:00.000Z';
const MODEL_ID = 'gemini-3.5-flash';

const usage = () => ({
  total_input_tokens: 3,
  total_output_tokens: 2,
  total_tokens: 5,
  total_cached_tokens: 1,
  total_thought_tokens: 0,
  total_tool_use_tokens: 0,
  input_tokens_by_modality: [{ modality: 'text', tokens: 3 }],
  output_tokens_by_modality: [{ modality: 'text', tokens: 2 }],
  cached_tokens_by_modality: [{ modality: 'text', tokens: 1 }],
  grounding_tool_count: 0,
  tool_use_tokens_by_modality: [],
});

const interaction = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: 'discarded-interaction-id',
  object: 'interaction',
  created: '2026-09-03T00:00:00.000Z',
  updated: '2026-09-03T00:00:01.000Z',
  status: 'completed',
  model: MODEL_ID,
  errors: [],
  steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"ok":true}' }] }],
  usage: usage(),
  ...overrides,
});

const parseOutput = (value: unknown): Readonly<{ ok: true; nested: readonly string[] }> => {
  if ((value as { ok?: unknown } | null)?.ok !== true) throw new Error('private parse failure');
  return { ok: true, nested: ['owned'] } as const;
};

const captureFailure = (operation: () => unknown): unknown => {
  try {
    operation();
    throw new Error('EXPECTED_FAILURE');
  } catch (error) {
    return error;
  }
};

const expectOutputInvalid = (
  operation: () => unknown,
  privateValues: readonly string[] = [],
): void => {
  const failure = captureFailure(operation);
  expect(failure).toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
  const visible = `${String(failure)} ${JSON.stringify(failure)}`;
  for (const privateValue of privateValues) expect(visible).not.toContain(privateValue);
};

describe('Gemini REST model-list protocol', () => {
  it('accepts only documented model fields and returns exact generateContent candidates unverified', () => {
    const result = parseGeminiModelList({
      models: [
        {
          name: 'models/gemini-3.5-flash',
          baseModelId: 'gemini-3.5-flash',
          version: '003',
          displayName: 'Gemini 3.5 Flash',
          description: 'Public model description',
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
          supportedGenerationMethods: ['countTokens', 'generateContent'],
          thinking: true,
          temperature: 1,
          maxTemperature: 2,
          topP: 0.95,
          topK: 64,
        },
        {
          name: 'models/gemini-embedding-001',
          displayName: 'Gemini Embedding',
          supportedGenerationMethods: ['embedContent'],
        },
      ],
      nextPageToken: '',
    });

    expect(result).toEqual([
      {
        modelId: 'gemini-3.5-flash',
        displayName: 'Gemini 3.5 Flash',
        compatibility: 'unverified',
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  it('uses the normalized model ID as the display name when displayName is absent', () => {
    expect(
      parseGeminiModelList({
        models: [
          {
            name: 'models/gemini-3.5-pro',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    ).toEqual([
      {
        modelId: 'gemini-3.5-pro',
        displayName: 'gemini-3.5-pro',
        compatibility: 'unverified',
      },
    ]);
  });

  it('requires exact case-sensitive generateContent and never accepts supportedActions', () => {
    expect(
      parseGeminiModelList({
        models: [
          {
            name: 'models/gemini-uppercase',
            supportedGenerationMethods: ['GenerateContent'],
          },
        ],
      }),
    ).toEqual([]);

    expectOutputInvalid(() =>
      parseGeminiModelList({
        models: [
          {
            name: 'models/gemini-sdk-projection',
            supportedGenerationMethods: [],
            supportedActions: ['generateContent'],
          },
        ],
      }),
    );
  });

  it('rejects duplicate normalized model IDs before returning candidates', () => {
    expectOutputInvalid(() =>
      parseGeminiModelList({
        models: [
          { name: 'models/gemini-duplicate', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-duplicate', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    );
  });

  it('rejects a nonempty page token instead of reflecting it into another request', () => {
    const privateToken = 'private-provider-page-token';
    expectOutputInvalid(
      () => parseGeminiModelList({ models: [], nextPageToken: privateToken }),
      [privateToken],
    );
  });

  it.each([
    ['unknown top-level field', { models: [], account: 'private-account' }],
    ['missing models', {}],
    ['too many models', { models: Array.from({ length: 1_001 }, () => null) }],
    [
      'unsafe model name',
      { models: [{ name: 'models/name/with/slash', supportedGenerationMethods: [] }] },
    ],
    [
      'unknown model field',
      {
        models: [{ name: 'models/gemini-safe', supportedGenerationMethods: [], owner: 'private' }],
      },
    ],
    [
      'invalid documented metadata',
      {
        models: [
          {
            name: 'models/gemini-safe',
            supportedGenerationMethods: [],
            topP: 4,
          },
        ],
      },
    ],
  ])('rejects %s', (_name, value) => {
    expectOutputInvalid(() => parseGeminiModelList(value));
  });

  it('rejects Proxy, accessor, symbol, hidden, inherited, and sparse model shapes', () => {
    let trapCalls = 0;
    const proxied = new Proxy(
      { models: [] },
      {
        get: (target, key, receiver) => {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target, key) => {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf: (target) => {
          trapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys: (target) => {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    expectOutputInvalid(() => parseGeminiModelList(proxied));
    expect(trapCalls).toBe(0);

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'models', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return [];
      },
    });
    expectOutputInvalid(() => parseGeminiModelList(accessor));
    expect(getterCalls).toBe(0);

    const symbol = Object.defineProperty({ models: [] }, Symbol('private'), {
      enumerable: true,
      value: 'private',
    });
    expectOutputInvalid(() => parseGeminiModelList(symbol));

    const hidden = Object.defineProperty({ models: [] }, 'private', {
      enumerable: false,
      value: 'private',
    });
    expectOutputInvalid(() => parseGeminiModelList(hidden));

    const inherited = Object.assign(Object.create({ private: 'private' }), { models: [] });
    expectOutputInvalid(() => parseGeminiModelList(inherited));

    const sparse = new Array(1);
    expectOutputInvalid(() => parseGeminiModelList({ models: sparse }));
  });

  it('rejects nested model and generation-method Proxies without invoking traps', () => {
    let trapCalls = 0;
    const trap = {
      get: (target: object, key: PropertyKey, receiver: unknown) => {
        trapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor: (target: object, key: PropertyKey) => {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf: (target: object) => {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys: (target: object) => {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
    };
    const proxiedModel = new Proxy(
      { name: 'models/gemini-safe', supportedGenerationMethods: ['generateContent'] },
      trap,
    );
    const proxiedMethods = new Proxy(['generateContent'], trap);

    expectOutputInvalid(() => parseGeminiModelList({ models: [proxiedModel] }));
    expectOutputInvalid(() =>
      parseGeminiModelList({
        models: [{ name: 'models/gemini-safe', supportedGenerationMethods: proxiedMethods }],
      }),
    );
    expect(trapCalls).toBe(0);
  });
});

describe('Gemini completed Interaction protocol', () => {
  it('accepts one completed model_output text and returns only a newly frozen owned result', () => {
    const parsedOutput = { ok: true, nested: ['owned'] };
    const result = parseGeminiInteraction(
      interaction(),
      () => parsedOutput as Readonly<{ ok: true; nested: readonly string[] }>,
      FIXED_NOW,
    );

    expect(result).toEqual({
      output: { ok: true, nested: ['owned'] },
      reportedModelId: MODEL_ID,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      completedAt: FIXED_NOW,
    });
    expect(result.output).not.toBe(parsedOutput);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen(result.output.nested)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('discarded-interaction-id');
    expect(JSON.stringify(result)).not.toContain('created');
    expect(JSON.stringify(result)).not.toContain('modality');
  });

  it('accepts absent optional discard-only metadata and usage detail fields', () => {
    const result = parseGeminiInteraction(
      {
        object: 'interaction',
        status: 'completed',
        model: MODEL_ID,
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"ok":true}' }] }],
        usage: {
          total_input_tokens: 3,
          total_output_tokens: 2,
          total_tokens: 5,
          total_tool_use_tokens: 0,
        },
      },
      parseOutput,
      FIXED_NOW,
    );
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });

  it('accepts safe totals without inferring an undocumented arithmetic relationship', () => {
    const result = parseGeminiInteraction(
      interaction({
        usage: {
          ...usage(),
          total_tokens: 6,
          total_thought_tokens: 1,
        },
      }),
      parseOutput,
      FIXED_NOW,
    );

    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 6 });
  });

  it.each(['requires_action', 'failed', 'cancelled', 'incomplete', 'in_progress'])(
    'rejects non-completed status %s',
    (status) => {
      expectOutputInvalid(() =>
        parseGeminiInteraction(interaction({ status }), parseOutput, FIXED_NOW),
      );
    },
  );

  it.each([
    ['nonzero errors', { errors: [{ code: 'private' }] }],
    ['nonzero tool tokens', { usage: { ...usage(), total_tool_use_tokens: 1 } }],
    ['nonzero grounding count', { usage: { ...usage(), grounding_tool_count: 1 } }],
    [
      'nonempty tool modality array',
      { usage: { ...usage(), tool_use_tokens_by_modality: [{ modality: 'text', tokens: 1 }] } },
    ],
    ['negative total', { usage: { ...usage(), total_input_tokens: -1 } }],
    [
      'negative-zero total',
      {
        usage: {
          ...usage(),
          total_input_tokens: -0,
          total_output_tokens: 2,
          total_tokens: 2,
        },
      },
    ],
    ['negative-zero tool total', { usage: { ...usage(), total_tool_use_tokens: -0 } }],
    ['unsafe total', { usage: { ...usage(), total_tokens: Number.MAX_SAFE_INTEGER + 1 } }],
    ['two steps', { steps: [...interaction().steps, ...interaction().steps] }],
    ['tool step', { steps: [{ type: 'tool_call', content: [] }] }],
    [
      'two content blocks',
      {
        steps: [
          {
            type: 'model_output',
            content: [
              { type: 'text', text: '{"ok":true}' },
              { type: 'text', text: '{"ok":true}' },
            ],
          },
        ],
      },
    ],
    [
      'annotation field',
      {
        steps: [
          {
            type: 'model_output',
            content: [{ type: 'text', text: '{"ok":true}', annotations: [] }],
          },
        ],
      },
    ],
    ['unknown usage field', { usage: { ...usage(), provider_account_id: 'private-account' } }],
    ['echoed tools field', { tools: [] }],
    ['echoed history field', { previous_interaction_id: 'private-history' }],
  ])('rejects %s', (_name, overrides) => {
    expectOutputInvalid(() =>
      parseGeminiInteraction(interaction(overrides), parseOutput, FIXED_NOW),
    );
  });

  it.each(['function_call', 'tool_call', 'code_execution', 'web_search'])(
    'rejects disallowed step type %s',
    (type) => {
      expectOutputInvalid(() =>
        parseGeminiInteraction(
          interaction({ steps: [{ type, content: [{ type: 'text', text: '{"ok":true}' }] }] }),
          parseOutput,
          FIXED_NOW,
        ),
      );
    },
  );

  it('rejects invalid JSON and normalizes an unknown local parser failure without leaking content', () => {
    const privateText = 'private invalid output';
    expectOutputInvalid(
      () =>
        parseGeminiInteraction(
          interaction({
            steps: [{ type: 'model_output', content: [{ type: 'text', text: privateText }] }],
          }),
          parseOutput,
          FIXED_NOW,
        ),
      [privateText],
    );

    const privateParserFailure = 'private local parser failure';
    expectOutputInvalid(
      () =>
        parseGeminiInteraction(
          interaction(),
          () => {
            throw new Error(privateParserFailure);
          },
          FIXED_NOW,
        ),
      [privateParserFailure],
    );
  });

  it('preserves a trusted local parser AppError by exact identity and retry metadata', () => {
    const trusted = new AppError(
      'PROVIDER_RATE_LIMITED',
      'AI 제공자 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.',
      {
        retryAfterMs: 4_321,
      },
    );
    const failure = captureFailure(() =>
      parseGeminiInteraction(
        interaction(),
        () => {
          throw trusted;
        },
        FIXED_NOW,
      ),
    );
    expect(failure).toBe(trusted);
    expect(AppError.getRetryAfterMs(failure)).toBe(4_321);
  });

  it('rejects Proxy, getter, symbol, hidden, inherited, and array-hole shapes without reading values', () => {
    const valid = interaction();
    const cases: unknown[] = [];
    let trapCalls = 0;
    cases.push(
      new Proxy(valid, {
        get: (target, key, receiver) => {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
      }),
    );
    let getterCalls = 0;
    cases.push(
      Object.defineProperty({ ...valid }, 'model', {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return MODEL_ID;
        },
      }),
    );
    cases.push(
      Object.defineProperty({ ...valid }, Symbol('private'), {
        enumerable: true,
        value: 'private',
      }),
    );
    cases.push(
      Object.defineProperty({ ...valid }, 'hidden', {
        enumerable: false,
        value: 'private',
      }),
    );
    cases.push(Object.assign(Object.create({ inherited: 'private' }), valid));
    const sparseSteps = new Array(1);
    cases.push(interaction({ steps: sparseSteps }));

    for (const value of cases) {
      expectOutputInvalid(() => parseGeminiInteraction(value, parseOutput, FIXED_NOW));
    }
    expect(trapCalls).toBe(0);
    expect(getterCalls).toBe(0);
  });

  it('rejects nested step, content, usage, and modality Proxies without invoking traps', () => {
    let trapCalls = 0;
    const proxy = <Value extends object>(value: Value): Value =>
      new Proxy(value, {
        get: (target, key, receiver) => {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target, key) => {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf: (target) => {
          trapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys: (target) => {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      });
    const validStep = { type: 'model_output', content: [{ type: 'text', text: '{"ok":true}' }] };
    const values = [
      interaction({ steps: proxy([validStep]) }),
      interaction({ steps: [proxy(validStep)] }),
      interaction({ steps: [{ ...validStep, content: proxy(validStep.content) }] }),
      interaction({
        steps: [{ ...validStep, content: [proxy({ type: 'text', text: '{"ok":true}' })] }],
      }),
      interaction({ usage: proxy(usage()) }),
      interaction({
        usage: { ...usage(), input_tokens_by_modality: proxy([{ modality: 'text', tokens: 3 }]) },
      }),
      interaction({
        usage: {
          ...usage(),
          input_tokens_by_modality: [proxy({ modality: 'text', tokens: 3 })],
        },
      }),
    ];

    for (const value of values) {
      expectOutputInvalid(() => parseGeminiInteraction(value, parseOutput, FIXED_NOW));
    }
    expect(trapCalls).toBe(0);
  });

  it('bounds discard-only strings, text, modality arrays, and hostile width', () => {
    expectOutputInvalid(() =>
      parseGeminiInteraction(interaction({ id: 'x'.repeat(1_025) }), parseOutput, FIXED_NOW),
    );
    expectOutputInvalid(() =>
      parseGeminiInteraction(
        interaction({
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'text', text: 'x'.repeat(8 * 1_024 * 1_024 + 1) }],
            },
          ],
        }),
        parseOutput,
        FIXED_NOW,
      ),
    );
    expectOutputInvalid(() =>
      parseGeminiInteraction(
        interaction({
          usage: {
            ...usage(),
            input_tokens_by_modality: Array.from({ length: 33 }, () => ({
              modality: 'text',
              tokens: 0,
            })),
          },
        }),
        parseOutput,
        FIXED_NOW,
      ),
    );
    const hiddenFields = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        `hidden_${index}`,
        { enumerable: false, value: index },
      ]),
    );
    const hostile = Object.defineProperties({ ...interaction() }, hiddenFields);
    expectOutputInvalid(() => parseGeminiInteraction(hostile, parseOutput, FIXED_NOW));
  });

  it('rejects an invalid local completion time without reflecting it', () => {
    expectOutputInvalid(
      () => parseGeminiInteraction(interaction(), parseOutput, 'not-private-iso-time'),
      ['not-private-iso-time'],
    );
  });
});

describe('Gemini Interactions semantic error classifier', () => {
  it.each([
    'safety',
    'recitation',
    'language',
    'prohibited_content',
    'spii',
    'blocklist',
    'image_safety',
    'image_prohibited_content',
    'image_recitation',
    'image_other',
    'content_blocked',
  ])('maps exact policy code %s to refusal without using message text', (code) => {
    expect(
      classifyGeminiApiError(400, { error: { code, message: 'private vendor message' } }),
    ).toBe('PROVIDER_REFUSED');
  });

  it.each([
    [400, 'model_not_found'],
    [404, 'model_not_found'],
    [404, 'not_found'],
    [400, 'invalid_request'],
    [422, 'invalid_request'],
    [400, 'parameter_unknown'],
    [422, 'parameter_unknown'],
  ] as const)('maps HTTP %s code %s to model incompatibility', (status, code) => {
    expect(classifyGeminiApiError(status, { error: { code, message: 'private' } })).toBe(
      'PROVIDER_MODEL_INCOMPATIBLE',
    );
  });

  it('maps exact failed_precondition to quota or billing', () => {
    expect(
      classifyGeminiApiError(400, {
        error: { code: 'failed_precondition', message: 'private billing detail' },
      }),
    ).toBe('PROVIDER_QUOTA_OR_BILLING');
  });

  it.each([
    [400, { error: { code: 'NOT_FOUND', message: 'model_not_found in text' } }],
    [400, { error: { code: 'not_found', message: 'private' } }],
    [409, { error: { code: 'invalid_request', message: 'private' } }],
    [400, { error: { code: 'tool_generation_failed', message: 'safety' } }],
    [400, { error: { code: 'safety', message: 'private', extra: true } }],
    [400, { error: { code: 'safety', message: '' } }],
    [400, { error: { code: 'safety' } }],
    [400, { message: 'safety' }],
  ] as const)('fails closed for non-contract classifier input %#', (status, body) => {
    expect(classifyGeminiApiError(status, body as JsonValue)).toBe('PROVIDER_EXECUTION_FAILED');
  });

  it('never invokes accessor or Proxy traps while classifying hostile input', () => {
    let getterCalls = 0;
    const getter = Object.defineProperty({}, 'error', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return { code: 'safety', message: 'private' };
      },
    });
    let trapCalls = 0;
    const proxy = new Proxy(
      { error: { code: 'safety', message: 'private' } },
      {
        get: (target, key, receiver) => {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(classifyGeminiApiError(400, getter as JsonValue)).toBe('PROVIDER_EXECUTION_FAILED');
    expect(classifyGeminiApiError(400, proxy as JsonValue)).toBe('PROVIDER_EXECUTION_FAILED');
    expect(getterCalls).toBe(0);
    expect(trapCalls).toBe(0);
  });
});
