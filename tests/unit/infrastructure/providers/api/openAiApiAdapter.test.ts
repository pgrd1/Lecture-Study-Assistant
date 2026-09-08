import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiProviderRouter } from '../../../../../src/application/providers/aiProviderRouter';
import type {
  ProviderConnectionOperation,
  ProviderRequest,
} from '../../../../../src/core/ports/aiProvider';
import { createProviderOperation } from '../../../../../src/core/ports/aiProvider';
import type {
  SecretKey,
  SecretStore,
  SecretStoreOperation,
} from '../../../../../src/core/ports/secretStore';
import { sha256CanonicalJson } from '../../../../../src/core/providers/canonicalJson';
import {
  createRepositories,
  openDatabase,
} from '../../../../../src/infrastructure/db/sqliteDatabase';
import { createOpenAiApiAdapterForTest } from '../../../../../src/infrastructure/providers/api/openAiApiAdapter';
import type {
  ProviderHttpClient,
  ProviderHttpRequest,
} from '../../../../../src/infrastructure/providers/api/providerHttpClient';
import { ContentClassificationSchema } from '../../../../../src/shared/contracts/contentClassification';
import { EvidenceSegmentsSchema } from '../../../../../src/shared/contracts/evidence';
import type { JsonValue } from '../../../../../src/shared/contracts/provider';
import {
  StudyContentV2Schema,
  StudyVerificationSchema,
  TopicClustersV2Schema,
} from '../../../../../src/shared/contracts/studyContent';
import { AppError } from '../../../../../src/shared/errors';
import { openAiEvidenceWireSchema } from '../../../../fixtures/content/openAiEvidenceWireSchema';
import { withTempDirectory } from '../../../../testkit/tempDirectory';

const FIXED_NOW = '2026-09-03T00:00:00.000Z';
const MODEL_ID = 'gpt-5.6';

class MutableSecretStore implements SecretStore {
  value: string | undefined = 'first-private-key';
  gets: readonly SecretKey[] = Object.freeze([]);
  hasCalls: readonly SecretKey[] = Object.freeze([]);
  getOperations: readonly SecretStoreOperation[] = Object.freeze([]);
  hasOperations: readonly SecretStoreOperation[] = Object.freeze([]);
  async set(_key: SecretKey, value: string, _operation: SecretStoreOperation): Promise<void> {
    this.value = value;
  }
  async get(key: SecretKey, operation: SecretStoreOperation): Promise<string | undefined> {
    this.gets = Object.freeze([...this.gets, key]);
    this.getOperations = Object.freeze([...this.getOperations, operation]);
    return key === 'openai_api_key' ? this.value : undefined;
  }
  async delete(_key: SecretKey, _operation: SecretStoreOperation): Promise<void> {
    this.value = undefined;
  }
  async has(key: SecretKey, operation: SecretStoreOperation): Promise<boolean> {
    this.hasCalls = Object.freeze([...this.hasCalls, key]);
    this.hasOperations = Object.freeze([...this.hasOperations, operation]);
    return key === 'openai_api_key' && this.value !== undefined;
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
    const [handler, ...rest] = this.#handlers;
    this.#handlers = Object.freeze(rest);
    if (handler === undefined) throw new Error('NO_CONTROLLED_RESPONSE');
    return handler(request);
  }
}

const modelList = (): JsonValue => ({
  object: 'list',
  data: [{ id: MODEL_ID, object: 'model', created: 1, owned_by: 'openai' }],
});

const completedResponse = (model = 'gpt-5.6-2026-08-01'): Readonly<Record<string, JsonValue>> => ({
  object: 'response',
  status: 'completed',
  error: null,
  incomplete_details: null,
  model,
  output: [
    {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: '{"ok":true,"nested":["owned"]}',
          annotations: [],
          logprobs: [],
        },
      ],
    },
  ],
  usage: {
    input_tokens: 7,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 10,
  },
});

const connectionOperation = (
  signal = new AbortController().signal,
  requestId = randomUUID(),
): ProviderConnectionOperation => Object.freeze({ requestId, signal });

const request = (
  overrides: Partial<ProviderRequest<Readonly<{ ok: true; nested: readonly string[] }>>> = {},
): ProviderRequest<Readonly<{ ok: true; nested: readonly string[] }>> =>
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
      if (parsed?.ok !== true || !Array.isArray(parsed.nested))
        throw new Error('private parser failure');
      return { ok: true as const, nested: parsed.nested as string[] };
    },
    blocks: Object.freeze([
      Object.freeze({ role: 'user', kind: 'source', text: 'private user prompt' }),
      Object.freeze({ role: 'system', kind: 'instruction', text: 'private developer prompt' }),
      Object.freeze({ role: 'user', kind: 'professor_note', text: 'private note' }),
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

const setup = () => {
  const httpClient = new ControlledHttpClient();
  const secretStore = new MutableSecretStore();
  const milliseconds = [1_000, 1_037];
  const adapter = createOpenAiApiAdapterForTest({
    httpClient,
    secretStore,
    now: () => FIXED_NOW,
    nowMilliseconds: () => milliseconds.shift() ?? 1_037,
  });
  return { adapter, httpClient, secretStore };
};

describe('OpenAI API adapter', () => {
  it.each([
    ['classification', ContentClassificationSchema],
    ['extraction and evidence', EvidenceSegmentsSchema],
    ['clustering', TopicClustersV2Schema],
    ['synthesis', StudyContentV2Schema],
    ['verification', StudyVerificationSchema],
  ] as const)(
    'sends the actual %s schema using only supported strict composition',
    async (_stage, schema) => {
      const { adapter, httpClient } = setup();
      httpClient.queue(completedResponse());
      await adapter.execute({
        ...request(),
        outputJsonSchema: JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' }))),
        parseOutput: () => ({}),
      });
      const body = httpClient.calls[0]?.body as {
        text: { format: { schema: Record<string, unknown> } };
      };
      const wire = body.text.format.schema;
      expect(wire.type).toBe('object');
      expect(wire).not.toHaveProperty('anyOf');
      const inspect = (node: Record<string, unknown>): void => {
        const supported = [
          'type',
          'properties',
          'required',
          'additionalProperties',
          'items',
          'anyOf',
          'enum',
          'const',
          '$schema',
          '$defs',
          'definitions',
          '$ref',
          'title',
          'description',
          'readOnly',
          'pattern',
          'format',
          'minLength',
          'maxLength',
          'minimum',
          'maximum',
          'exclusiveMinimum',
          'exclusiveMaximum',
          'multipleOf',
          'minItems',
          'maxItems',
        ];
        for (const key of Object.keys(node)) expect(supported).toContain(key);
        if (node.type !== undefined)
          for (const type of Array.isArray(node.type) ? node.type : [node.type])
            expect(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']).toContain(
              type,
            );
        for (const key of [
          'oneOf',
          'allOf',
          'not',
          'dependentRequired',
          'dependentSchemas',
          'if',
          'then',
          'else',
          'prefixItems',
          'contains',
          'unevaluatedProperties',
        ])
          expect(node).not.toHaveProperty(key);
        if (node.type === 'object') {
          expect(node.additionalProperties).toBe(false);
          expect(node.required).toEqual(Object.keys(node.properties as object));
        }
        for (const [key, value] of Object.entries(node)) {
          if (['properties', '$defs', 'definitions'].includes(key))
            Object.values(value as object).forEach((child) => {
              inspect(child);
            });
          else if (key === 'items') inspect(value as Record<string, unknown>);
          else if (key === 'anyOf') (value as Record<string, unknown>[]).forEach(inspect);
        }
      };
      inspect(wire);
    },
  );

  it.each([false, true])(
    'retains local union normalization and refinement (invalid=%s)',
    async (invalid) => {
      const { adapter, httpClient } = setup();
      const schema = z.strictObject({
        value: z.discriminatedUnion('kind', [
          z
            .strictObject({
              kind: z.literal('span'),
              start: z.number(),
              end: z.number(),
              note: z.string().optional(),
            })
            .refine((value) => value.end >= value.start),
          z.strictObject({ kind: z.literal('label'), label: z.string() }),
        ]),
      });
      httpClient.queue({
        ...completedResponse(),
        output: [
          {
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  value: { kind: 'span', start: 2, end: invalid ? 1 : 3, note: null },
                }),
              },
            ],
          },
        ],
      });
      const result = adapter.execute({
        ...request(),
        outputJsonSchema: JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' }))),
        parseOutput: (value) => JSON.parse(JSON.stringify(schema.parse(value))) as JsonValue,
      });
      if (invalid) await expect(result).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
      else
        await expect(result).resolves.toMatchObject({
          output: { value: { kind: 'span', start: 2, end: 3 } },
        });
      const body = httpClient.calls[0]?.body as {
        text: { format: { schema: { properties: { value: object } } } };
      };
      expect(body.text.format.schema.properties.value).not.toHaveProperty('oneOf');
      expect(body.text.format.schema.properties.value).toHaveProperty('anyOf');
    },
  );

  it.each([
    [
      'overlapping literals',
      {
        oneOf: [
          {
            type: 'object',
            properties: { kind: { type: 'string', const: 'same' } },
            required: ['kind'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { kind: { type: 'string', const: 'same' } },
            required: ['kind'],
            additionalProperties: false,
          },
        ],
      },
    ],
    ['no discriminator', { oneOf: [{ type: 'string' }, { type: 'string', minLength: 1 }] }],
    [
      'optional discriminator',
      {
        oneOf: [
          { type: 'object', properties: { kind: { type: 'string', const: 'a' } } },
          { type: 'object', properties: { kind: { type: 'string', const: 'b' } } },
        ],
      },
    ],
    [
      'hidden composition in additionalProperties',
      { type: 'object', additionalProperties: { allOf: [] } },
    ],
    ...[
      'allOf',
      'not',
      'dependentRequired',
      'dependentSchemas',
      'if',
      'then',
      'else',
      'prefixItems',
      'contains',
      'unevaluatedProperties',
    ].map((key): [string, JsonValue] => [key, { type: 'object', [key]: [] }]),
  ])('rejects unsupported %s before network or secret access', async (_name, property) => {
    const { adapter, httpClient, secretStore } = setup();
    httpClient.queue(completedResponse());
    await expect(
      adapter.execute({
        ...request(),
        outputJsonSchema: {
          type: 'object',
          properties: { value: property as JsonValue },
          required: ['value'],
          additionalProperties: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
    expect(httpClient.calls).toHaveLength(0);
    expect(secretStore.gets).toHaveLength(0);
  });

  it.each([
    { type: 'array', items: { type: 'string' } },
    { type: 'object', properties: {}, anyOf: [{ type: 'object', properties: {} }] },
  ])('rejects a non-object or composed root before network', async (schema) => {
    const { adapter, httpClient } = setup();
    httpClient.queue(completedResponse());
    await expect(adapter.execute({ ...request(), outputJsonSchema: schema })).rejects.toMatchObject(
      { code: 'PROVIDER_EXECUTION_FAILED' },
    );
    expect(httpClient.calls).toHaveLength(0);
  });
  it('audits the normalized accepted output hash through the real router', async () => {
    await withTempDirectory(async (root) => {
      const database = openDatabase(join(root, 'wire.sqlite'));
      const repositories = createRepositories(database);
      const { adapter, httpClient } = setup();
      const saved = repositories.providerRoutes.get('lecture_organize');
      if (!saved) throw new Error('Missing route');
      repositories.providerRoutes.update(
        {
          ...saved,
          providerId: 'openai_api',
          modelId: MODEL_ID,
          enabled: true,
          revision: saved.revision + 1,
        },
        saved.revision,
      );
      repositories.providerDiagnostics.upsert(
        {
          providerId: 'openai_api',
          status: 'ready',
          version: null,
          selectedModelId: MODEL_ID,
          reportedModelId: 'gpt-5.6-2026-08-01',
          credentialPresent: true,
          credentialScope: 'not_applicable',
          sharedCredentialConsentAt: null,
          sharedCredentialConsentVersion: null,
          cliBinding: null,
          providerManagedHistory: false,
          checkedAt: FIXED_NOW,
          latencyMs: 1,
          errorCode: null,
          revision: 0,
        },
        null,
      );
      const invocationId = randomUUID();
      const router = new AiProviderRouter({
        routes: repositories.providerRoutes,
        diagnostics: repositories.providerDiagnostics,
        invocations: repositories.providerInvocations,
        adapters: new Map([['openai_api', adapter]]),
        clock: () => FIXED_NOW,
        id: () => invocationId,
      });
      const schema = z.strictObject({
        optional: z.string().optional(),
        requiredNullable: z.string().nullable(),
      });
      const requestId = randomUUID();
      httpClient.queue({
        ...completedResponse(),
        output: [
          {
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: '{"optional":null,"requiredNullable":null}' }],
          },
        ],
      });
      try {
        const result = await router.execute(
          createProviderOperation({
            requestId,
            feature: 'lecture_organize',
            jobId: null,
            outputSchemaId: 'lecture_output',
            outputJsonSchema: JSON.parse(
              JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' })),
            ),
            parseOutput: (value) => JSON.parse(JSON.stringify(schema.parse(value))) as JsonValue,
            blocks: [],
            timeoutMs: 30000,
            maxOutputTokens: 100,
            signal: new AbortController().signal,
          }),
        );
        expect(result.output).toEqual({ requiredNullable: null });
        expect(repositories.providerInvocations.get(invocationId)).toMatchObject({
          status: 'completed',
          responseSha256: sha256CanonicalJson({ requiredNullable: null }),
        });
      } finally {
        await router.shutdown();
        database.close();
      }
    });
  });
  it('sends the complete strict evidence wire schema with required nullable optional fields', async () => {
    const { adapter, httpClient } = setup();
    const output = { segments: [] };
    httpClient.queue({
      ...completedResponse(),
      output: [
        {
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(output) }],
        },
      ],
    });
    await adapter.execute({
      ...request(),
      outputSchemaId: 'evidence_segments',
      outputJsonSchema: JSON.parse(
        JSON.stringify(z.toJSONSchema(EvidenceSegmentsSchema, { target: 'draft-7' })),
      ),
      parseOutput: (value) =>
        JSON.parse(JSON.stringify(EvidenceSegmentsSchema.parse(value))) as JsonValue,
    });
    expect(httpClient.calls[0]?.body).toMatchObject({
      text: {
        format: {
          type: 'json_schema',
          name: 'evidence_segments',
          strict: true,
        },
      },
    });
    const body = httpClient.calls[0]?.body as { text: { format: { schema: unknown } } };
    expect(body.text.format.schema).toEqual(openAiEvidenceWireSchema);
  });

  it('normalizes only introduced nested optional nulls before local parsing', async () => {
    const { adapter, httpClient } = setup();
    const schema = z.strictObject({
      items: z.array(
        z.strictObject({
          label: z.string().max(12).optional(),
          requiredNullable: z.string().nullable(),
          optionalNullable: z.string().nullable().optional(),
        }),
      ),
    });
    httpClient.queue({
      ...completedResponse(),
      output: [
        {
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: '{"items":[{"label":null,"requiredNullable":null,"optionalNullable":null}]}',
            },
          ],
        },
      ],
    });
    const result = await adapter.execute({
      ...request(),
      outputJsonSchema: JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' }))),
      parseOutput: (value) => JSON.parse(JSON.stringify(schema.parse(value))) as JsonValue,
    });
    expect(result.output).toEqual({ items: [{ requiredNullable: null, optionalNullable: null }] });
    const body = httpClient.calls[0]?.body as { text: { format: { schema: unknown } } };
    expect(body.text.format.schema).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { anyOf: [{ type: 'string', maxLength: 12 }, { type: 'null' }] },
              requiredNullable: { type: ['string', 'null'] },
              optionalNullable: { type: ['string', 'null'] },
            },
            required: ['label', 'requiredNullable', 'optionalNullable'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    });
  });
  it('inspects presence with has only and returns immutable API-provider metadata', async () => {
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
    expect(secretStore.gets).toEqual([]);
    expect(secretStore.hasCalls).toEqual(['openai_api_key', 'openai_api_key']);
    expect(httpClient.calls).toEqual([]);
    expect(Object.isFrozen(missing)).toBe(true);
  });

  it('reads the current key just in time for every model request and uses the fixed endpoint and 2 MiB cap', async () => {
    const { adapter, httpClient, secretStore } = setup();
    httpClient.queue(modelList());
    await expect(adapter.listModels(connectionOperation())).resolves.toEqual([
      { modelId: MODEL_ID, displayName: MODEL_ID, compatibility: 'unverified' },
    ]);
    secretStore.value = 'rotated-private-key';
    httpClient.queue(modelList());
    await adapter.listModels(connectionOperation());
    expect(secretStore.gets).toEqual(['openai_api_key', 'openai_api_key']);
    expect(
      httpClient.calls.map((call) => ({
        providerId: call.providerId,
        endpoint: call.endpoint,
        authValue: call.authValue,
        timeoutMs: call.timeoutMs,
        responseLimitBytes: call.responseLimitBytes,
        body: call.body,
      })),
    ).toEqual([
      {
        providerId: 'openai_api',
        endpoint: { id: 'openai_models' },
        authValue: 'first-private-key',
        timeoutMs: 30_000,
        responseLimitBytes: 2 * 1_024 * 1_024,
        body: undefined,
      },
      {
        providerId: 'openai_api',
        endpoint: { id: 'openai_models' },
        authValue: 'rotated-private-key',
        timeoutMs: 30_000,
        responseLimitBytes: 2 * 1_024 * 1_024,
        body: undefined,
      },
    ]);
  });

  it.each([undefined, ''])('rejects missing or empty keys without dispatch (%s)', async (value) => {
    const { adapter, httpClient, secretStore } = setup();
    secretStore.value = value;
    await expect(adapter.listModels(connectionOperation())).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED',
    });
    await expect(adapter.execute(request())).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED',
    });
    expect(httpClient.calls).toEqual([]);
  });

  it('builds the exact execute body, fixed endpoint, 8 MiB cap, and carries a dated reported model', async () => {
    const { adapter, httpClient } = setup();
    httpClient.queue(completedResponse());
    const result = await adapter.execute(request());
    expect(result).toEqual({
      output: { ok: true, nested: ['owned'] },
      reportedModelId: 'gpt-5.6-2026-08-01',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      completedAt: FIXED_NOW,
    });
    const call = httpClient.calls[0];
    expect(call).toMatchObject({
      providerId: 'openai_api',
      endpoint: { id: 'openai_responses' },
      timeoutMs: 120_000,
      responseLimitBytes: 8 * 1_024 * 1_024,
    });
    expect(call?.body).toEqual({
      model: MODEL_ID,
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                blocks: [
                  {
                    index: 1,
                    role: 'system',
                    kind: 'instruction',
                    text: 'private developer prompt',
                  },
                ],
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
                  { index: 0, role: 'user', kind: 'source', text: 'private user prompt' },
                  { index: 2, role: 'user', kind: 'professor_note', text: 'private note' },
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
          schema: request().outputJsonSchema,
        },
      },
    });
  });

  it('uses a fixed probe ID/schema/token limit, 1 MiB cap, and local latency', async () => {
    const { adapter, httpClient } = setup();
    httpClient.queue({
      ...completedResponse(),
      output: [
        {
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: '{"ok":true}', annotations: [], logprobs: [] }],
        },
      ],
    });
    await expect(adapter.probe(MODEL_ID, connectionOperation())).resolves.toEqual({
      status: 'ready',
      reportedModelId: 'gpt-5.6-2026-08-01',
      latencyMs: 37,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      providerManagedHistory: false,
    });
    const call = httpClient.calls[0];
    expect(call).toMatchObject({
      endpoint: { id: 'openai_responses' },
      timeoutMs: 120_000,
      responseLimitBytes: 1 * 1_024 * 1_024,
    });
    const body = call?.body as {
      max_output_tokens: number;
      text: { format: { name: string } };
      input: unknown[];
    };
    expect(body.max_output_tokens).toBe(128);
    expect(body.text.format.name).toBe('provider_probe_v1');
    expect(body.input).toHaveLength(2);
  });

  it('rejects malformed models and pre-aborted requests before secret or network access', async () => {
    const { adapter, httpClient, secretStore } = setup();
    await expect(adapter.probe(null, connectionOperation())).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_INCOMPATIBLE',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.execute(request({ signal: controller.signal }))).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });
    await expect(adapter.execute(request({ modelId: 'unsafe/id' }))).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_INCOMPATIBLE',
    });
    expect(secretStore.gets).toEqual([]);
    expect(httpClient.calls).toEqual([]);
  });

  it('rejects duplicate execute and probe collisions before another key read without cancelling the original', async () => {
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
    release(completedResponse());
    await expect(first).resolves.toMatchObject({ reportedModelId: 'gpt-5.6-2026-08-01' });
  });

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

  it('rejects an invalid outer request ID before secret or HTTP access', async () => {
    const { adapter, httpClient, secretStore } = setup();
    const invalid = Object.freeze({
      requestId: 'not-a-uuid',
      signal: new AbortController().signal,
    }) as ProviderConnectionOperation;

    await expect(adapter.inspect(invalid)).rejects.toMatchObject({
      code: 'PROVIDER_EXECUTION_FAILED',
    });
    expect(secretStore.hasCalls).toEqual([]);
    expect(httpClient.calls).toEqual([]);
  });

  it('uses the same active request identity and signal for secret and HTTP boundaries', async () => {
    const { adapter, httpClient, secretStore } = setup();
    const requestId = randomUUID();
    const controller = new AbortController();
    httpClient.queue(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(new AppError('PROVIDER_CANCELLED', 'AI 제공자 요청이 취소되었습니다.')),
            { once: true },
          );
        }),
    );

    const pending = adapter.listModels(connectionOperation(controller.signal, requestId));
    await vi.waitFor(() => expect(httpClient.calls).toHaveLength(1));

    expect(secretStore.getOperations[0]?.requestId).toBe(requestId);
    expect(secretStore.getOperations[0]?.signal).toBe(httpClient.calls[0]?.signal);
    controller.abort();
    expect(secretStore.getOperations[0]?.signal.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
  });

  it('forwards caller abort and local cancel, ignores unknown cancel, and reuses IDs after cleanup', async () => {
    const { adapter, httpClient } = setup();
    const requestId = randomUUID();
    const caller = new AbortController();
    httpClient.queue(
      (outbound) =>
        new Promise((_resolve, reject) =>
          outbound.signal?.addEventListener(
            'abort',
            () => reject(new AppError('PROVIDER_CANCELLED', 'AI 제공자 요청이 취소되었습니다.')),
            { once: true },
          ),
        ),
    );
    const pending = adapter.execute(request({ requestId, signal: caller.signal }));
    await vi.waitFor(() => expect(httpClient.calls).toHaveLength(1));
    adapter.cancel('00000000-0000-4000-8000-000000000000');
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(httpClient.calls[0]?.signal?.aborted).toBe(true);
    httpClient.queue(completedResponse());
    await expect(adapter.execute(request({ requestId }))).resolves.toMatchObject({
      completedAt: FIXED_NOW,
    });

    const localId = randomUUID();
    httpClient.queue(
      (outbound) =>
        new Promise((_resolve, reject) =>
          outbound.signal?.addEventListener(
            'abort',
            () => reject(new AppError('PROVIDER_CANCELLED', 'AI 제공자 요청이 취소되었습니다.')),
            { once: true },
          ),
        ),
    );
    const localPending = adapter.execute(request({ requestId: localId }));
    await vi.waitFor(() => expect(httpClient.calls).toHaveLength(3));
    adapter.cancel(localId);
    await expect(localPending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
  });

  it('lets cancellation during local parsing win and cleans the registry', async () => {
    const { adapter, httpClient } = setup();
    const requestId = randomUUID();
    httpClient.queue(completedResponse());
    const cancelling = request({
      requestId,
      parseOutput: (value: unknown) => {
        adapter.cancel(requestId);
        return value as Readonly<{ ok: true; nested: readonly string[] }>;
      },
    });
    await expect(adapter.execute(cancelling)).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    httpClient.queue(completedResponse());
    await expect(adapter.execute(request({ requestId }))).resolves.toBeDefined();
  });

  it('preserves trusted HTTP and parser AppErrors but removes unknown failure details and causes', async () => {
    const { adapter, httpClient } = setup();
    const trustedHttp = new AppError(
      'PROVIDER_RATE_LIMITED',
      'AI 제공자 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.',
      { retryAfterMs: 3_210 },
    );
    httpClient.queue(async () => {
      throw trustedHttp;
    });
    await expect(adapter.execute(request())).rejects.toBe(trustedHttp);
    const trustedParser = new AppError(
      'PROVIDER_BUSY',
      'AI 제공자가 현재 다른 요청을 처리하고 있습니다.',
    );
    httpClient.queue(completedResponse());
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

  it('snapshots hostile request values before key access and returns no parser alias', async () => {
    const { adapter, httpClient, secretStore } = setup();
    let trapCalls = 0;
    const hostile = new Proxy(request(), { get: () => (trapCalls += 1) });
    await expect(adapter.execute(hostile)).rejects.toMatchObject({
      code: 'PROVIDER_EXECUTION_FAILED',
    });
    expect(trapCalls).toBe(0);
    expect(secretStore.gets).toEqual([]);
    const parserValue = { ok: true as const, nested: ['mutable'] };
    httpClient.queue(completedResponse());
    const result = await adapter.execute(request({ parseOutput: () => parserValue }));
    parserValue.nested.push('changed');
    expect(result.output).toEqual({ ok: true, nested: ['mutable'] });
    expect(Object.isFrozen(result.output.nested)).toBe(true);
  });
});
