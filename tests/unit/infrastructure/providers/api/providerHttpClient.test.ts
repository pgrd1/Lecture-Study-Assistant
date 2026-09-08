import { describe, expect, it, vi } from 'vitest';
import {
  createFetchHttpTransport,
  type HttpTransport,
  type HttpTransportRequestInit,
} from '../../../../../src/core/ports/httpTransport';
import {
  createProviderHttpClientForTest,
  MAX_PROVIDER_REQUEST_BYTES,
  MAX_PROVIDER_RESPONSE_BYTES,
  type ProviderHttpClient,
  type ProviderHttpLogEvent,
  type ProviderHttpLogger,
  type ProviderHttpRequest,
} from '../../../../../src/infrastructure/providers/api/providerHttpClient';
import type { ApiProviderId, JsonValue } from '../../../../../src/shared/contracts/provider';
import { AppError, type ProviderErrorCode } from '../../../../../src/shared/errors';

type TransportCall = Readonly<{
  url: string;
  init: HttpTransportRequestInit;
}>;

type QueuedTransportResult =
  | Readonly<{ kind: 'response'; response: Response }>
  | Readonly<{
      kind: 'factory';
      create: (url: string, init: HttpTransportRequestInit) => Promise<Response>;
    }>
  | Readonly<{ kind: 'failure'; error: unknown }>;

class ControlledHttpTransport implements HttpTransport {
  calls: readonly TransportCall[] = Object.freeze([]);
  #queue: readonly QueuedTransportResult[] = Object.freeze([]);

  get lastInit(): HttpTransportRequestInit | undefined {
    return this.calls.at(-1)?.init;
  }

  get lastUrl(): string | undefined {
    return this.calls.at(-1)?.url;
  }

  queueResponse(response: Response): void {
    this.#queue = Object.freeze([...this.#queue, Object.freeze({ kind: 'response', response })]);
  }

  queueFailure(error: unknown): void {
    const queued: QueuedTransportResult = Object.freeze({ kind: 'failure', error });
    this.#queue = Object.freeze([...this.#queue, queued]);
  }

  queueFactory(create: (url: string, init: HttpTransportRequestInit) => Promise<Response>): void {
    this.#queue = Object.freeze([...this.#queue, Object.freeze({ kind: 'factory', create })]);
  }

  async request(url: string, init: HttpTransportRequestInit): Promise<Response> {
    this.calls = Object.freeze([...this.calls, Object.freeze({ url, init })]);
    const [next, ...remaining] = this.#queue;
    this.#queue = Object.freeze(remaining);
    if (next === undefined) throw new Error('NO_CONTROLLED_HTTP_RESULT');
    if (next.kind === 'failure') throw next.error;
    if (next.kind === 'factory') return next.create(url, init);
    return next.response;
  }
}

class RecordingLogger implements ProviderHttpLogger {
  events: readonly ProviderHttpLogEvent[] = Object.freeze([]);

  record(event: ProviderHttpLogEvent): void {
    this.events = Object.freeze([...this.events, event]);
  }
}

const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8' });

const jsonResponse = (
  status: number,
  value: JsonValue,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });

const bytesResponse = (
  status: number,
  chunks: readonly Uint8Array[],
  headers: Readonly<Record<string, string>> = {},
): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status, headers: { ...JSON_HEADERS, ...headers } },
  );

const hangingResponse = (init: HttpTransportRequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(new DOMException('private abort reason', 'AbortError'));
    init.signal.addEventListener('abort', rejectAbort, { once: true });
    if (init.signal.aborted) rejectAbort();
  });

const requestFor = (
  providerId: ApiProviderId = 'openai_api',
  overrides: Partial<ProviderHttpRequest> = {},
): ProviderHttpRequest =>
  Object.freeze({
    providerId,
    endpoint: Object.freeze({ id: 'openai_responses' as const }),
    authValue: 'fixed-fake-auth-value',
    body: Object.freeze({ input: 'safe' }),
    timeoutMs: 1_000,
    responseLimitBytes: 1_024,
    signal: new AbortController().signal,
    ...overrides,
  });

const createHarness = (now: () => number = () => Date.parse('2026-09-02T00:00:00.000Z')) => {
  const transport = new ControlledHttpTransport();
  const logger = new RecordingLogger();
  const client = createProviderHttpClientForTest({ transport, logger, now });
  return Object.freeze({ transport, logger, client });
};

const captureFailure = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation;
    throw new Error('EXPECTED_PROVIDER_HTTP_FAILURE');
  } catch (error) {
    return error;
  }
};

const expectFixedRedactedFailure = async (
  operation: Promise<unknown>,
  code: ProviderErrorCode,
  privateValues: readonly string[] = Object.freeze([]),
): Promise<void> => {
  const failure = await captureFailure(operation);
  expect(failure).toMatchObject({ code });
  const visibleFailure = `${String(failure)} ${JSON.stringify(failure)}`;
  for (const privateValue of privateValues) expect(visibleFailure).not.toContain(privateValue);
};

describe('fetch HTTP transport', () => {
  it('forwards the closed request once without storing request options on itself', async () => {
    const response = jsonResponse(200, { ok: true });
    const fetchImplementation = vi.fn(async () => response);
    const transport = createFetchHttpTransport(fetchImplementation);
    const init: HttpTransportRequestInit = Object.freeze({
      method: 'GET',
      headers: Object.freeze({ accept: 'application/json' }),
      redirect: 'error',
      cache: 'no-store',
      signal: new AbortController().signal,
    });

    await expect(transport.request('https://api.openai.com/v1/models', init)).resolves.toBe(
      response,
    );

    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledWith('https://api.openai.com/v1/models', init);
    expect(Object.keys(transport)).toEqual(['request']);
    expect(Object.isFrozen(transport)).toBe(true);
  });
});

describe('ProviderHttpClient fixed request boundary', () => {
  it.each([
    [
      'gemini_api',
      'gemini_models',
      'GET',
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    ],
    [
      'gemini_api',
      'gemini_interactions',
      'POST',
      'https://generativelanguage.googleapis.com/v1/interactions',
    ],
    ['openai_api', 'openai_models', 'GET', 'https://api.openai.com/v1/models'],
    ['openai_api', 'openai_responses', 'POST', 'https://api.openai.com/v1/responses'],
    ['claude_api', 'claude_models', 'GET', 'https://api.anthropic.com/v1/models?limit=100'],
    ['claude_api', 'claude_messages', 'POST', 'https://api.anthropic.com/v1/messages'],
  ] as const)(
    'maps %s/%s to its one fixed %s URL',
    async (providerId, endpointId, method, expectedUrl) => {
      const { client, transport } = createHarness();
      transport.queueResponse(jsonResponse(200, { ok: true }));

      await client.requestJson(
        requestFor(providerId, {
          endpoint: Object.freeze({ id: endpointId }),
          ...(method === 'GET' ? { body: undefined } : {}),
        }),
      );

      expect(transport.lastUrl).toBe(expectedUrl);
      expect(transport.lastInit).toMatchObject({
        method,
        redirect: 'error',
        cache: 'no-store',
      });
      expect(Object.keys(transport.lastInit ?? {}).sort()).toEqual(
        method === 'GET'
          ? ['cache', 'headers', 'method', 'redirect', 'signal']
          : ['body', 'cache', 'headers', 'method', 'redirect', 'signal'],
      );
    },
  );

  it.each([
    ['gemini_api', 'gemini_interactions', 'x-goog-api-key', 'gemini-fixed-fake-key'],
    ['openai_api', 'openai_responses', 'authorization', 'Bearer openai-fixed-fake-key'],
    ['claude_api', 'claude_messages', 'x-api-key', 'claude-fixed-fake-key'],
  ] as const)(
    'uses only the fixed %s authentication header for %s',
    async (providerId, endpointId, expectedHeader, expectedValue) => {
      const { client, transport, logger } = createHarness();
      const rawKey = expectedValue.replace(/^Bearer /, '');
      transport.queueResponse(jsonResponse(200, { ok: true }));

      await client.requestJson(
        requestFor(providerId, {
          endpoint: Object.freeze({ id: endpointId }),
          authValue: rawKey,
        }),
      );

      expect(transport.lastInit?.headers).toMatchObject({
        accept: 'application/json',
        'content-type': 'application/json',
        [expectedHeader]: expectedValue,
        'user-agent': 'lecture-study-assistant/0.1.0',
      });
      expect(transport.lastUrl).not.toContain(rawKey);
      expect(transport.lastInit?.body).not.toContain(rawKey);
      expect(JSON.stringify(logger.events)).not.toContain(rawKey);
      if (providerId === 'claude_api') {
        expect(transport.lastInit?.headers).toMatchObject({
          'anthropic-version': '2023-06-01',
        });
      } else {
        expect(transport.lastInit?.headers).not.toHaveProperty('anthropic-version');
      }
    },
  );

  it.each([
    ['gemini_api', 'openai_models'],
    ['openai_api', 'claude_messages'],
    ['claude_api', 'gemini_interactions'],
  ] as const)(
    'rejects the forged %s/%s provider-endpoint pairing before transport',
    async (providerId, endpointId) => {
      const { client, transport } = createHarness();

      await expectFixedRedactedFailure(
        client.requestJson(
          requestFor(providerId, {
            endpoint: Object.freeze({ id: endpointId }) as ProviderHttpRequest['endpoint'],
            body: undefined,
          }),
        ),
        'PROVIDER_EXECUTION_FAILED',
      );
      expect(transport.calls).toHaveLength(0);
    },
  );

  it('rejects endpoint objects carrying path or query injection before transport', async () => {
    const { client, transport } = createHarness();
    const forgedEndpoint = Object.freeze({
      id: 'openai_responses',
      path: '/v1/responses?api_key=private-query-key',
    });

    await expectFixedRedactedFailure(
      client.requestJson(
        requestFor('openai_api', {
          endpoint: forgedEndpoint as ProviderHttpRequest['endpoint'],
        }),
      ),
      'PROVIDER_EXECUTION_FAILED',
      ['private-query-key'],
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('rejects over-wide enumerable request and endpoint objects before transport', async () => {
    const { client, transport } = createHarness();
    const requestExtras = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`extra_${index}`, index]),
    );
    const endpointExtras = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`path_${index}`, index]),
    );

    await expectFixedRedactedFailure(
      client.requestJson({ ...requestFor(), ...requestExtras } as ProviderHttpRequest),
      'PROVIDER_EXECUTION_FAILED',
    );
    await expectFixedRedactedFailure(
      client.requestJson(
        requestFor('openai_api', {
          endpoint: {
            id: 'openai_responses',
            ...endpointExtras,
          } as ProviderHttpRequest['endpoint'],
        }),
      ),
      'PROVIDER_EXECUTION_FAILED',
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('ignores hidden and symbol metadata on request and endpoint objects', async () => {
    const { client, transport } = createHarness();
    transport.queueResponse(jsonResponse(200, { ok: true }));
    let metadataReads = 0;
    const endpoint = Object.defineProperties(
      { id: 'openai_responses' as const },
      {
        hiddenPath: {
          enumerable: false,
          get: () => {
            metadataReads += 1;
            return '/private-path';
          },
        },
        [Symbol('hidden endpoint metadata')]: {
          enumerable: true,
          get: () => {
            metadataReads += 1;
            return 'private-symbol-value';
          },
        },
      },
    );
    const hiddenRequestMetadata = Object.fromEntries([
      ...Array.from({ length: 10_000 }, (_, index) => [
        `hidden_${index}`,
        Object.freeze({ enumerable: false, value: index }),
      ]),
      ...Array.from({ length: 10_000 }, (_, index) => [
        Symbol(`symbol_${index}`),
        Object.freeze({ enumerable: true, value: index }),
      ]),
    ]);
    const request = Object.defineProperties(
      { ...requestFor('openai_api', { endpoint }) },
      {
        ...hiddenRequestMetadata,
        [Symbol('hidden request metadata')]: {
          enumerable: true,
          get: () => {
            metadataReads += 1;
            return 'private-request-symbol';
          },
        },
      },
    );

    await expect(client.requestJson(request)).resolves.toEqual({ ok: true });

    expect(metadataReads).toBe(0);
    expect(transport.calls).toHaveLength(1);
  });

  it('rejects request, endpoint, and body Proxies before invoking any trap', async () => {
    for (const target of ['request', 'endpoint', 'body'] as const) {
      const { client, transport } = createHarness();
      let trapCalls = 0;
      const proxied = new Proxy(
        target === 'request'
          ? { ...requestFor() }
          : target === 'endpoint'
            ? { id: 'openai_responses' as const }
            : { input: 'safe' },
        {
          get: (value, key, receiver) => {
            trapCalls += 1;
            return Reflect.get(value, key, receiver);
          },
          getOwnPropertyDescriptor: (value, key) => {
            trapCalls += 1;
            return Reflect.getOwnPropertyDescriptor(value, key);
          },
          getPrototypeOf: (value) => {
            trapCalls += 1;
            return Reflect.getPrototypeOf(value);
          },
          ownKeys: (value) => {
            trapCalls += 1;
            return Reflect.ownKeys(value);
          },
        },
      );
      const request =
        target === 'request'
          ? (proxied as ProviderHttpRequest)
          : requestFor('openai_api', {
              ...(target === 'endpoint'
                ? { endpoint: proxied as ProviderHttpRequest['endpoint'] }
                : { body: proxied as JsonValue }),
            });

      await expectFixedRedactedFailure(client.requestJson(request), 'PROVIDER_EXECUTION_FAILED');
      expect(trapCalls).toBe(0);
      expect(transport.calls).toHaveLength(0);
    }
  });

  it('rejects enumerable request accessors without reading their values', async () => {
    const { client, transport } = createHarness();
    let getterCalls = 0;
    const request = Object.defineProperty({ ...requestFor() }, 'authValue', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'private-accessor-value';
      },
    });

    await expectFixedRedactedFailure(
      client.requestJson(request as ProviderHttpRequest),
      'PROVIDER_EXECUTION_FAILED',
      ['private-accessor-value'],
    );
    expect(getterCalls).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it('rejects a missing required cancellation signal before transport', async () => {
    const { client, transport } = createHarness();
    const { signal: _signal, ...withoutSignal } = requestFor();

    await expectFixedRedactedFailure(
      client.requestJson(withoutSignal as ProviderHttpRequest),
      'PROVIDER_EXECUTION_FAILED',
    );
    expect(transport.calls).toHaveLength(0);
  });

  it.each(['', 'contains space', 'line\nbreak', 'a'.repeat(8_193)])(
    'rejects an invalid call-local auth value without retaining or transporting it',
    async (authValue) => {
      const { client, transport, logger } = createHarness();

      await expectFixedRedactedFailure(
        client.requestJson(requestFor('openai_api', { authValue })),
        'PROVIDER_AUTH_REQUIRED',
        authValue.length > 0 ? [authValue] : [],
      );
      expect(transport.calls).toHaveLength(0);
      if (authValue.length > 0) expect(JSON.stringify(logger.events)).not.toContain(authValue);
    },
  );

  it('rejects a request body above 8 MiB before starting transport', async () => {
    const { client, transport } = createHarness();
    const privatePayload = 'private-oversized-body';

    await expectFixedRedactedFailure(
      client.requestJson(
        requestFor('openai_api', {
          body: Object.freeze({
            input: `${privatePayload}${'x'.repeat(MAX_PROVIDER_REQUEST_BYTES)}`,
          }),
          responseLimitBytes: MAX_PROVIDER_RESPONSE_BYTES,
        }),
      ),
      'PROVIDER_REQUEST_TOO_LARGE',
      [privatePayload],
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('serializes a valid body exactly once after rejecting getters and toJSON hooks', async () => {
    const { client, transport } = createHarness();
    let getterCalls = 0;
    let toJsonCalls = 0;
    const getterBody = Object.defineProperty({}, 'input', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'private-getter';
      },
    });
    const toJsonBody = Object.freeze({
      input: 'safe',
      toJSON: () => {
        toJsonCalls += 1;
        return { input: 'private-to-json' };
      },
    });

    await expectFixedRedactedFailure(
      client.requestJson(requestFor('openai_api', { body: getterBody as never })),
      'PROVIDER_EXECUTION_FAILED',
      ['private-getter'],
    );
    await expectFixedRedactedFailure(
      client.requestJson(requestFor('openai_api', { body: toJsonBody as never })),
      'PROVIDER_EXECUTION_FAILED',
      ['private-to-json'],
    );
    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it('serializes only enumerable body data and ignores hidden, symbol, and toJSON metadata', async () => {
    const { client, transport } = createHarness();
    transport.queueResponse(jsonResponse(200, { ok: true }));
    let metadataReads = 0;
    const hiddenBodyMetadata = Object.fromEntries([
      ...Array.from({ length: 10_000 }, (_, index) => [
        `hidden_${index}`,
        Object.freeze({ enumerable: false, value: `private-hidden-${index}` }),
      ]),
      ...Array.from({ length: 10_000 }, (_, index) => [
        Symbol(`symbol_${index}`),
        Object.freeze({ enumerable: true, value: `private-symbol-${index}` }),
      ]),
    ]);
    const body = Object.defineProperties(
      { input: 'safe' },
      {
        ...hiddenBodyMetadata,
        toJSON: {
          enumerable: false,
          get: () => {
            metadataReads += 1;
            return () => ({ input: 'private-to-json-result' });
          },
        },
        [Symbol('hidden body metadata')]: {
          enumerable: true,
          get: () => {
            metadataReads += 1;
            return 'private-symbol-value';
          },
        },
      },
    );

    await expect(
      client.requestJson(requestFor('openai_api', { body: body as JsonValue })),
    ).resolves.toEqual({ ok: true });

    expect(metadataReads).toBe(0);
    expect(transport.lastInit?.body).toBe('{"input":"safe"}');
    expect(transport.lastInit?.body).not.toContain('private');
  });

  it('does not let inherited enumerable toJSON metadata influence serialization', async () => {
    const { client, transport } = createHarness();
    transport.queueResponse(jsonResponse(200, { ok: true }));
    let metadataReads = 0;
    let result: JsonValue | undefined;
    let failure: unknown;
    let sentBody: string | undefined;
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        enumerable: true,
        get: () => {
          metadataReads += 1;
          return () => ({ input: 'private-inherited-result' });
        },
      });
      try {
        result = await client.requestJson(requestFor());
        sentBody = transport.lastInit?.body;
      } catch (error) {
        failure = error;
      }
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(Object.prototype, 'toJSON');
      } else {
        Object.defineProperty(Object.prototype, 'toJSON', original);
      }
    }

    expect(failure).toBeUndefined();
    expect(result).toEqual({ ok: true });
    expect(metadataReads).toBe(0);
    expect(sentBody).toBe('{"input":"safe"}');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, undefined, Symbol('private')])(
    'rejects non-JSON request body value %s before transport',
    async (input) => {
      const { client, transport } = createHarness();

      await expectFixedRedactedFailure(
        client.requestJson(requestFor('openai_api', { body: { input } as never })),
        'PROVIDER_EXECUTION_FAILED',
      );
      expect(transport.calls).toHaveLength(0);
    },
  );

  it('rejects cyclic and non-plain request bodies before transport', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { client, transport } = createHarness();

    await expectFixedRedactedFailure(
      client.requestJson(requestFor('openai_api', { body: cyclic as never })),
      'PROVIDER_EXECUTION_FAILED',
    );
    await expectFixedRedactedFailure(
      client.requestJson(requestFor('openai_api', { body: new Date() as never })),
      'PROVIDER_EXECUTION_FAILED',
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('rejects a GET body and invalid timeout/response bounds before transport', async () => {
    const { client, transport } = createHarness();
    const invalidRequests = Object.freeze([
      requestFor('openai_api', {
        endpoint: Object.freeze({ id: 'openai_models' }),
        body: Object.freeze({ input: 'not-allowed' }),
      }),
      requestFor('openai_api', { timeoutMs: 0 }),
      requestFor('openai_api', { timeoutMs: 900_001 }),
      requestFor('openai_api', { responseLimitBytes: 0 }),
      requestFor('openai_api', { responseLimitBytes: MAX_PROVIDER_RESPONSE_BYTES + 1 }),
    ]);

    for (const invalidRequest of invalidRequests) {
      await expectFixedRedactedFailure(
        client.requestJson(invalidRequest),
        'PROVIDER_EXECUTION_FAILED',
      );
    }
    expect(transport.calls).toHaveLength(0);
  });
});

describe('ProviderHttpClient bounded response parsing', () => {
  it('rejects Content-Length above the caller bound before reading the body', async () => {
    const { client, transport } = createHarness();
    transport.queueResponse(
      bytesResponse(200, [new TextEncoder().encode('{"private":"body"}')], {
        'content-length': '4097',
      }),
    );

    await expectFixedRedactedFailure(
      client.requestJson(requestFor('openai_api', { responseLimitBytes: 4_096 })),
      'PROVIDER_RESPONSE_TOO_LARGE',
      ['private'],
    );
  });

  it('counts chunked bytes before decoding and aborts on stream overflow', async () => {
    const { client, transport } = createHarness();
    transport.queueResponse(bytesResponse(200, [new Uint8Array(700), new Uint8Array(400)], {}));

    await expectFixedRedactedFailure(
      client.requestJson(requestFor('openai_api', { responseLimitBytes: 1_024 })),
      'PROVIDER_RESPONSE_TOO_LARGE',
    );
  });

  it('rejects more than 4,096 tiny chunks before accumulation becomes unbounded', async () => {
    const { client, transport } = createHarness();
    const encoded = new TextEncoder().encode(`"${'x'.repeat(4_095)}"`);
    const tinyChunks = Object.freeze([...encoded].map((byte) => Uint8Array.of(byte)));
    transport.queueResponse(bytesResponse(200, tinyChunks));

    await expectFixedRedactedFailure(
      client.requestJson(requestFor('openai_api', { responseLimitBytes: 8_192 })),
      'PROVIDER_RESPONSE_TOO_LARGE',
    );
  });

  it.each([
    [
      'wrong-media-type',
      new Response('{"private":"body"}', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ],
    [
      'invalid-content-length',
      bytesResponse(200, [new TextEncoder().encode('{"ok":true}')], {
        'content-length': 'not-a-number',
      }),
    ],
    ['invalid-utf8', bytesResponse(200, [new Uint8Array([0xc3, 0x28])])],
    ['invalid-json', bytesResponse(200, [new TextEncoder().encode('{"private":"unterminated"')])],
    ['empty-body', bytesResponse(200, [])],
  ] as const)(
    'maps %s to fixed invalid-output without leaking response content',
    async (_fixture, response) => {
      const { client, transport, logger } = createHarness();
      transport.queueResponse(response);

      await expectFixedRedactedFailure(
        client.requestJson(requestFor()),
        'PROVIDER_OUTPUT_INVALID',
        ['private', 'unterminated'],
      );
      expect(JSON.stringify(logger.events)).not.toContain('private');
    },
  );

  it('rejects parsed JSON deeper than 64 without recursive traversal', async () => {
    const { client, transport } = createHarness();
    let deepJson = 'true';
    for (let depth = 0; depth < 65; depth += 1) deepJson = `{"next":${deepJson}}`;
    transport.queueResponse(
      new Response(deepJson, { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expectFixedRedactedFailure(
      client.requestJson(requestFor('openai_api', { responseLimitBytes: 4_096 })),
      'PROVIDER_OUTPUT_INVALID',
    );
  });

  it('rejects more than 100,000 aggregate entries', async () => {
    const { client, transport } = createHarness();
    const wideJson = `[${'0,'.repeat(100_000)}0]`;
    transport.queueResponse(
      new Response(wideJson, { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expectFixedRedactedFailure(
      client.requestJson(requestFor('openai_api', { responseLimitBytes: 512 * 1_024 })),
      'PROVIDER_OUTPUT_INVALID',
    );
  });

  it('returns a distinct recursively frozen JSON tree', async () => {
    const { client, transport } = createHarness();
    transport.queueResponse(jsonResponse(200, { nested: { values: [1, 2, 3] } }));

    const result = await client.requestJson(requestFor());

    expect(result).toEqual({ nested: { values: [1, 2, 3] } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen((result as { nested: object }).nested)).toBe(true);
    const values = (result as { nested: { values: readonly number[] } }).nested.values;
    expect(Object.isFrozen(values)).toBe(true);
    expect(values.map((value) => value * 2)).toEqual([2, 4, 6]);
  });
});

describe('ProviderHttpClient cancellation and network normalization', () => {
  it('times out when the transport ignores abort and absorbs its late rejection', async () => {
    vi.useFakeTimers();
    try {
      const privateFailure = 'private late transport failure';
      const { client, transport } = createHarness();
      let rejectLate: ((reason: unknown) => void) | undefined;
      transport.queueFactory(
        async () =>
          new Promise<Response>((_resolve, reject) => {
            rejectLate = reject;
          }),
      );
      let observed: unknown = null;
      const pending = client.requestJson(requestFor('openai_api', { timeoutMs: 1_000 }));
      const observation = pending.catch((error: unknown) => {
        observed = error;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      const observedBeforeLateRejection = observed;
      rejectLate?.(new Error(privateFailure));
      await observation;

      expect(observedBeforeLateRejection).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
      expect(`${String(observed)} ${JSON.stringify(observed)}`).not.toContain(privateFailure);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels when the transport ignores abort and absorbs its late rejection', async () => {
    const privateFailure = 'private late cancelled transport failure';
    const caller = new AbortController();
    const { client, transport } = createHarness();
    let rejectLate: ((reason: unknown) => void) | undefined;
    transport.queueFactory(
      async () =>
        new Promise<Response>((_resolve, reject) => {
          rejectLate = reject;
        }),
    );
    let observed: unknown = null;
    const pending = client.requestJson(requestFor('openai_api', { signal: caller.signal }));
    const observation = pending.catch((error: unknown) => {
      observed = error;
    });

    caller.abort('private ignored caller cancellation');
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      observation,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 25);
      }),
    ]);
    if (deadline !== undefined) clearTimeout(deadline);
    const observedBeforeLateRejection = observed;
    rejectLate?.(new Error(privateFailure));
    await observation;

    expect(observedBeforeLateRejection).toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(`${String(observed)} ${JSON.stringify(observed)}`).not.toContain(privateFailure);
  });

  it('maps caller cancellation to the fixed cancelled error', async () => {
    const { client, transport } = createHarness();
    const controller = new AbortController();
    transport.queueFactory(async (_url, init) => hangingResponse(init));
    const pending = client.requestJson(requestFor('openai_api', { signal: controller.signal }));

    controller.abort('private caller abort reason');

    await expectFixedRedactedFailure(pending, 'PROVIDER_CANCELLED', [
      'private caller abort reason',
      'private abort reason',
    ]);
  });

  it('maps its own deadline abort to the fixed timeout error', async () => {
    vi.useFakeTimers();
    try {
      const { client, transport } = createHarness();
      transport.queueFactory(async (_url, init) => hangingResponse(init));
      const pending = client.requestJson(requestFor('openai_api', { timeoutMs: 1_000 }));
      const rejection = expectFixedRedactedFailure(pending, 'PROVIDER_TIMEOUT', [
        'private abort reason',
      ]);

      await vi.advanceTimersByTimeAsync(1_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps an already-aborted signal without starting transport', async () => {
    const { client, transport } = createHarness();
    const controller = new AbortController();
    controller.abort('private pre-abort');

    await expectFixedRedactedFailure(
      client.requestJson(requestFor('openai_api', { signal: controller.signal })),
      'PROVIDER_CANCELLED',
      ['private pre-abort'],
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('maps rejected redirects and arbitrary fetch failures to fixed network errors', async () => {
    const privateFailure = 'getaddrinfo private-host.internal';
    const first = createHarness();
    first.transport.queueResponse(
      new Response(null, {
        status: 302,
        headers: { location: 'https://private-host.internal/secret' },
      }),
    );
    await expectFixedRedactedFailure(
      first.client.requestJson(requestFor()),
      'PROVIDER_NETWORK_FAILED',
      ['private-host.internal'],
    );

    const second = createHarness();
    second.transport.queueFailure(new TypeError(privateFailure));
    await expectFixedRedactedFailure(
      second.client.requestJson(requestFor()),
      'PROVIDER_NETWORK_FAILED',
      [privateFailure],
    );
    expect(JSON.stringify(second.logger.events)).not.toContain(privateFailure);
  });

  it('maps a stream read failure without exposing the stream exception', async () => {
    const privateFailure = 'socket failed for private tenant';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(privateFailure));
      },
    });
    const { client, transport, logger } = createHarness();
    transport.queueResponse(
      new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expectFixedRedactedFailure(client.requestJson(requestFor()), 'PROVIDER_NETWORK_FAILED', [
      privateFailure,
    ]);
    expect(JSON.stringify(logger.events)).not.toContain(privateFailure);
  });

  it('maps cancellation while reading the response stream to cancelled', async () => {
    const caller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
      },
    });
    const { client, transport } = createHarness();
    transport.queueResponse(
      new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const pending = client.requestJson(requestFor('openai_api', { signal: caller.signal }));

    caller.abort('private read abort');

    await expectFixedRedactedFailure(pending, 'PROVIDER_CANCELLED', ['private read abort']);
  });

  it('preserves cancellation when a pending read ignores cancel and releaseLock throws', async () => {
    const privateCleanupFailure = 'private release-lock failure';
    const caller = new AbortController();
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const hostileReader = {
      read: () => {
        markReadStarted?.();
        return new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined);
      },
      cancel: () => new Promise<void>(() => undefined),
      releaseLock: () => {
        throw new Error(privateCleanupFailure);
      },
    };
    const hostileBody = Object.freeze({
      getReader: () => hostileReader,
    }) as unknown as NonNullable<Response['body']>;
    class HostileBodyResponse extends Response {
      override get body(): NonNullable<Response['body']> {
        return hostileBody;
      }
    }
    const response = new HostileBodyResponse(null, { status: 200, headers: JSON_HEADERS });
    const { client, transport } = createHarness();
    transport.queueResponse(response);
    const pending = client.requestJson(requestFor('openai_api', { signal: caller.signal }));
    await readStarted;

    caller.abort('private pending-read cancellation');

    await expectFixedRedactedFailure(pending, 'PROVIDER_CANCELLED', [
      privateCleanupFailure,
      'private pending-read cancellation',
    ]);
  });
});

describe('ProviderHttpClient status and vendor-body normalization', () => {
  it.each([
    [401, 'PROVIDER_AUTH_REQUIRED'],
    [403, 'PROVIDER_AUTH_REQUIRED'],
    [402, 'PROVIDER_QUOTA_OR_BILLING'],
    [408, 'PROVIDER_TIMEOUT'],
    [504, 'PROVIDER_TIMEOUT'],
    [413, 'PROVIDER_REQUEST_TOO_LARGE'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [500, 'PROVIDER_TEMPORARILY_UNAVAILABLE'],
    [502, 'PROVIDER_TEMPORARILY_UNAVAILABLE'],
    [503, 'PROVIDER_TEMPORARILY_UNAVAILABLE'],
    [400, 'PROVIDER_EXECUTION_FAILED'],
    [404, 'PROVIDER_EXECUTION_FAILED'],
    [409, 'PROVIDER_EXECUTION_FAILED'],
    [422, 'PROVIDER_EXECUTION_FAILED'],
    [418, 'PROVIDER_EXECUTION_FAILED'],
  ] as const)('maps HTTP %i to %s and discards its vendor body', async (status, code) => {
    const privateVendorMessage = `private vendor message ${status}`;
    const { client, transport, logger } = createHarness();
    transport.queueResponse(jsonResponse(status, { message: privateVendorMessage }));

    await expectFixedRedactedFailure(client.requestJson(requestFor()), code, [
      privateVendorMessage,
    ]);
    expect(JSON.stringify(logger.events)).not.toContain(privateVendorMessage);
  });

  it('maps fixed HTTP 529 before classifier/body semantics without Retry-After trust', async () => {
    const privateVendorMessage = 'private anthropic overloaded explanation';
    const classifier = vi.fn((): ProviderErrorCode => 'PROVIDER_MODEL_INCOMPATIBLE');
    const { client, transport, logger } = createHarness();
    transport.queueResponse(
      jsonResponse(529, { message: privateVendorMessage }, { 'retry-after': '2' }),
    );

    const failure = await captureFailure(
      client.requestJson(
        requestFor('claude_api', {
          endpoint: Object.freeze({ id: 'claude_messages' as const }),
          classifyError: classifier,
        }),
      ),
    );

    expect(failure).toMatchObject({ code: 'PROVIDER_TEMPORARILY_UNAVAILABLE' });
    expect(AppError.getRetryAfterMs(failure)).toBeNull();
    expect(classifier).not.toHaveBeenCalled();
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(privateVendorMessage);
    expect(JSON.stringify(logger.events)).not.toContain(privateVendorMessage);
    expect(logger.events.at(-1)).toMatchObject({
      status: 529,
      errorCode: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
      retryAfterMs: null,
    });
  });

  it('returns fixed HTTP 529 promptly when body cancellation never settles', async () => {
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const { client, transport } = createHarness();
    transport.queueResponse(new Response(stream, { status: 529, headers: JSON_HEADERS }));
    const pending = client.requestJson(
      requestFor('claude_api', { endpoint: Object.freeze({ id: 'claude_messages' as const }) }),
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      pending.then(
        () => Object.freeze({ kind: 'resolved' as const }),
        (failure: unknown) => Object.freeze({ kind: 'rejected' as const, failure }),
      ),
      new Promise<Readonly<{ kind: 'pending' }>>((resolve) => {
        deadline = setTimeout(() => resolve(Object.freeze({ kind: 'pending' as const })), 25);
      }),
    ]);
    if (deadline !== undefined) clearTimeout(deadline);

    expect(observed).toMatchObject({
      kind: 'rejected',
      failure: { code: 'PROVIDER_TEMPORARILY_UNAVAILABLE' },
    });
    expect(cancelCalls).toBe(1);
  });

  it('keeps fixed HTTP 529 when body access throws and absorbs late cancellation rejection', async () => {
    const privateBodyFailure = 'private anthropic body getter failure';
    class ThrowingBodyResponse extends Response {
      override get body(): NonNullable<Response['body']> {
        throw new Error(privateBodyFailure);
      }
    }
    const throwing = createHarness();
    throwing.transport.queueResponse(
      new ThrowingBodyResponse(null, { status: 529, headers: JSON_HEADERS }),
    );
    await expectFixedRedactedFailure(
      throwing.client.requestJson(
        requestFor('claude_api', { endpoint: Object.freeze({ id: 'claude_messages' as const }) }),
      ),
      'PROVIDER_TEMPORARILY_UNAVAILABLE',
      [privateBodyFailure],
    );

    const privateLateFailure = 'private anthropic late cancellation failure';
    let rejectCancellation: ((reason: unknown) => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      cancel: () =>
        new Promise<void>((_resolve, reject) => {
          rejectCancellation = reject;
        }),
    });
    const late = createHarness();
    late.transport.queueResponse(new Response(stream, { status: 529, headers: JSON_HEADERS }));
    await expectFixedRedactedFailure(
      late.client.requestJson(
        requestFor('claude_api', { endpoint: Object.freeze({ id: 'claude_messages' as const }) }),
      ),
      'PROVIDER_TEMPORARILY_UNAVAILABLE',
      [privateLateFailure],
    );
    rejectCancellation?.(new Error(privateLateFailure));
    await Promise.resolve();
    expect(JSON.stringify(late.logger.events)).not.toContain(privateLateFailure);
  });

  it('keeps caller cancellation ahead of a queued HTTP 529 response', async () => {
    const controller = new AbortController();
    controller.abort('private pre-cancel detail');
    const { client, transport } = createHarness();
    transport.queueResponse(jsonResponse(529, { message: 'private overload detail' }));

    await expectFixedRedactedFailure(
      client.requestJson(
        requestFor('claude_api', {
          endpoint: Object.freeze({ id: 'claude_messages' as const }),
          signal: controller.signal,
        }),
      ),
      'PROVIDER_CANCELLED',
      ['private pre-cancel detail', 'private overload detail'],
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('keeps HTTP 429 and its capped Retry-After when the response body stream errors', async () => {
    const privateStreamFailure = 'private rate-limit stream failure';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(privateStreamFailure));
      },
    });
    const { client, transport, logger } = createHarness();
    transport.queueResponse(
      new Response(stream, {
        status: 429,
        headers: { ...JSON_HEADERS, 'retry-after': '999' },
      }),
    );

    const failure = await captureFailure(client.requestJson(requestFor()));

    expect(failure).toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    expect(AppError.getRetryAfterMs(failure)).toBe(5_000);
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(privateStreamFailure);
    expect(logger.events.at(-1)).toMatchObject({
      status: 429,
      errorCode: 'PROVIDER_RATE_LIMITED',
      retryAfterMs: 5_000,
    });
  });

  it('returns HTTP 429 promptly when its body and cancellation never settle', async () => {
    const caller = new AbortController();
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const { client, transport } = createHarness();
    transport.queueResponse(
      new Response(stream, {
        status: 429,
        headers: { ...JSON_HEADERS, 'retry-after': '2' },
      }),
    );
    const pending = client.requestJson(requestFor('openai_api', { signal: caller.signal }));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      pending.then(
        () => Object.freeze({ kind: 'resolved' as const }),
        (failure: unknown) => Object.freeze({ kind: 'rejected' as const, failure }),
      ),
      new Promise<Readonly<{ kind: 'pending' }>>((resolve) => {
        deadline = setTimeout(() => resolve(Object.freeze({ kind: 'pending' as const })), 25);
      }),
    ]);
    if (deadline !== undefined) clearTimeout(deadline);
    caller.abort('private cleanup cancellation');
    await pending.catch(() => undefined);

    expect(observed).toMatchObject({
      kind: 'rejected',
      failure: { code: 'PROVIDER_RATE_LIMITED' },
    });
    if (observed.kind === 'rejected') {
      expect(AppError.getRetryAfterMs(observed.failure)).toBe(2_000);
    }
    expect(cancelCalls).toBe(1);
  });

  it.each([
    [401, 'PROVIDER_AUTH_REQUIRED'],
    [418, 'PROVIDER_EXECUTION_FAILED'],
  ] as const)(
    'keeps fail-closed HTTP %i mapping when its body stream errors',
    async (status, code) => {
      const privateStreamFailure = `private status ${status} stream failure`;
      const { client, transport } = createHarness();
      transport.queueResponse(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error(privateStreamFailure));
            },
          }),
          { status, headers: JSON_HEADERS },
        ),
      );

      await expectFixedRedactedFailure(client.requestJson(requestFor()), code, [
        privateStreamFailure,
      ]);
    },
  );

  it('fails closed with HTTP 400 when its classifiable body stream errors', async () => {
    const privateStreamFailure = 'private classifiable stream failure';
    const { client, transport } = createHarness();
    transport.queueResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error(privateStreamFailure));
          },
        }),
        { status: 400, headers: JSON_HEADERS },
      ),
    );

    await expectFixedRedactedFailure(
      client.requestJson(
        requestFor('openai_api', {
          classifyError: () => 'PROVIDER_QUOTA_OR_BILLING',
        }),
      ),
      'PROVIDER_EXECUTION_FAILED',
      [privateStreamFailure],
    );
  });

  it('invokes an adapter-owned classifier only for bounded 400/404/409/422 JSON', async () => {
    const classifiedStatuses: readonly number[] = Object.freeze([400, 404, 409, 422]);
    for (const status of classifiedStatuses) {
      const privateVendorMessage = `private classified body ${status}`;
      const { client, transport, logger } = createHarness();
      const classifier = vi.fn((_receivedStatus: number, body: unknown): ProviderErrorCode => {
        expect(body).toEqual({ code: 'model_rejected', message: privateVendorMessage });
        return 'PROVIDER_MODEL_INCOMPATIBLE';
      });
      transport.queueResponse(
        jsonResponse(status, { code: 'model_rejected', message: privateVendorMessage }),
      );

      await expectFixedRedactedFailure(
        client.requestJson(requestFor('openai_api', { classifyError: classifier })),
        'PROVIDER_MODEL_INCOMPATIBLE',
        [privateVendorMessage],
      );
      expect(classifier).toHaveBeenCalledTimes(1);
      expect(classifier).toHaveBeenCalledWith(status, {
        code: 'model_rejected',
        message: privateVendorMessage,
      });
      expect(JSON.stringify(logger.events)).not.toContain(privateVendorMessage);
    }
  });

  it('ignores a classifier for statuses with fixed mappings', async () => {
    const { client, transport } = createHarness();
    const classifier = vi.fn((): ProviderErrorCode => 'PROVIDER_MODEL_INCOMPATIBLE');
    transport.queueResponse(jsonResponse(401, { message: 'private auth body' }));

    await expectFixedRedactedFailure(
      client.requestJson(requestFor('openai_api', { classifyError: classifier })),
      'PROVIDER_AUTH_REQUIRED',
      ['private auth body'],
    );
    expect(classifier).not.toHaveBeenCalled();
  });

  it('normalizes a throwing or invalid classifier to fixed execution failure', async () => {
    const first = createHarness();
    first.transport.queueResponse(jsonResponse(400, { message: 'private body one' }));
    await expectFixedRedactedFailure(
      first.client.requestJson(
        requestFor('openai_api', {
          classifyError: () => {
            throw new Error('private classifier failure');
          },
        }),
      ),
      'PROVIDER_EXECUTION_FAILED',
      ['private body one', 'private classifier failure'],
    );

    const second = createHarness();
    second.transport.queueResponse(jsonResponse(400, { message: 'private body two' }));
    await expectFixedRedactedFailure(
      second.client.requestJson(
        requestFor('openai_api', {
          classifyError: () => 'NOT_A_PROVIDER_CODE' as ProviderErrorCode,
        }),
      ),
      'PROVIDER_EXECUTION_FAILED',
      ['private body two'],
    );
  });

  it('caps non-success bodies at 64 KiB independently of the success limit', async () => {
    const { client, transport } = createHarness();
    transport.queueResponse(
      new Response('x'.repeat(64 * 1_024 + 1), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expectFixedRedactedFailure(
      client.requestJson(
        requestFor('openai_api', {
          responseLimitBytes: MAX_PROVIDER_RESPONSE_BYTES,
          classifyError: () => 'PROVIDER_MODEL_INCOMPATIBLE',
        }),
      ),
      'PROVIDER_RESPONSE_TOO_LARGE',
    );
  });

  it.each([
    ['2', 2_000],
    ['999', 5_000],
    ['Wed, 02 Sep 2026 00:00:10 GMT', 5_000],
    ['Wed, 02 Sep 2026 00:00:02 GMT', 2_000],
    ['Tue, 01 Sep 2026 00:00:00 GMT', 0],
    ['2.5', null],
    ['-1', null],
    ['not-a-date', null],
  ] as const)(
    'parses and caps Retry-After %s as %s ms in safe metadata',
    async (retryAfter, expectedMilliseconds) => {
      const { client, transport, logger } = createHarness();
      transport.queueResponse(
        jsonResponse(429, { message: 'private rate-limit body' }, { 'retry-after': retryAfter }),
      );

      const failure = await captureFailure(client.requestJson(requestFor()));
      expect(failure).toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
      expect(AppError.getRetryAfterMs(failure)).toBe(expectedMilliseconds);
      expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(
        'private rate-limit body',
      );
      expect(logger.events.at(-1)).toMatchObject({
        phase: 'failed',
        providerId: 'openai_api',
        endpointId: 'openai_responses',
        status: 429,
        errorCode: 'PROVIDER_RATE_LIMITED',
        retryAfterMs: expectedMilliseconds,
      });
    },
  );

  it('never stores response JSON, request JSON, headers, URLs, or auth values in log events', async () => {
    const privateAuth = 'fixed-private-auth';
    const privateRequest = 'fixed-private-request';
    const privateResponse = 'fixed-private-response';
    const { client, transport, logger } = createHarness();
    transport.queueResponse(jsonResponse(200, { output: privateResponse }));

    await client.requestJson(
      requestFor('openai_api', {
        authValue: privateAuth,
        body: Object.freeze({ input: privateRequest }),
      }),
    );

    const visibleEvents = JSON.stringify(logger.events);
    expect(visibleEvents).not.toContain(privateAuth);
    expect(visibleEvents).not.toContain(privateRequest);
    expect(visibleEvents).not.toContain(privateResponse);
    expect(visibleEvents).not.toContain('authorization');
    expect(visibleEvents).not.toContain('https://');
    expect(logger.events.at(-1)).toEqual({
      phase: 'completed',
      providerId: 'openai_api',
      endpointId: 'openai_responses',
      status: 200,
      errorCode: null,
      retryAfterMs: null,
    });
  });

  it('ignores logger failures so untrusted logging cannot alter provider outcomes', async () => {
    const transport = new ControlledHttpTransport();
    transport.queueResponse(jsonResponse(200, { ok: true }));
    const logger: ProviderHttpLogger = {
      record: () => {
        throw new Error('private logger failure');
      },
    };
    const client: ProviderHttpClient = createProviderHttpClientForTest({
      transport,
      logger,
      now: () => 0,
    });

    await expect(client.requestJson(requestFor())).resolves.toEqual({ ok: true });
  });
});
