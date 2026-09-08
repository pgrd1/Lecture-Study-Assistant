import { Buffer } from 'node:buffer';
import type { HttpTransport, HttpTransportRequestInit } from '../../../core/ports/httpTransport';
import type { ApiProviderId, JsonValue } from '../../../shared/contracts/provider';
import {
  APP_ERROR_MESSAGES,
  AppError,
  type ProviderErrorCode,
  ProviderErrorCodeSchema,
} from '../../../shared/errors';
import { type ClosedDataObject, cloneBoundedJsonValue, readClosedDataObject } from './boundedJson';
import { countBoundedJsonBytes } from './boundedJsonBytes';

export const MAX_PROVIDER_REQUEST_BYTES = 96_000_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_PROVIDER_TIMEOUT_MS = 900_000;
export const MAX_PROVIDER_JSON_DEPTH = 64;
export const MAX_PROVIDER_JSON_ENTRIES = 100_000;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_AUTH_VALUE_LENGTH = 8_192;
const MAX_PROVIDER_RESPONSE_CHUNKS = 4_096;
const MAX_RETRY_AFTER_MS = 5_000;
const AUTH_VALUE_PATTERN = /^[\x21-\x7e]+$/;
const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9]\d*)$/;
const PROVIDER_ORIGINS = Object.freeze({
  gemini_api: 'https://generativelanguage.googleapis.com',
  openai_api: 'https://api.openai.com',
  claude_api: 'https://api.anthropic.com',
} as const satisfies Record<ApiProviderId, string>);
const AUTH_HEADERS = Object.freeze({
  gemini_api: 'x-goog-api-key',
  openai_api: 'authorization',
  claude_api: 'x-api-key',
} as const satisfies Record<ApiProviderId, string>);
const PROVIDER_STATIC_HEADERS = Object.freeze({
  gemini_api: Object.freeze({}),
  openai_api: Object.freeze({}),
  claude_api: Object.freeze({ 'anthropic-version': '2023-06-01' }),
} as const satisfies Record<ApiProviderId, Readonly<Record<string, string>>>);
export const PROVIDER_HTTP_ENDPOINT_IDS = Object.freeze([
  'gemini_models',
  'gemini_interactions',
  'openai_models',
  'openai_responses',
  'claude_models',
  'claude_messages',
] as const);
export type ProviderHttpEndpointId = (typeof PROVIDER_HTTP_ENDPOINT_IDS)[number];
export type ProviderHttpEndpoint = {
  readonly [Id in ProviderHttpEndpointId]: Readonly<{ id: Id }>;
}[ProviderHttpEndpointId];
type EndpointRecipe = Readonly<{
  providerId: ApiProviderId;
  method: 'GET' | 'POST';
  pathname: string;
  search: string;
  url: string;
}>;

const createEndpointRecipe = (
  providerId: ApiProviderId,
  method: EndpointRecipe['method'],
  pathname: string,
  search: string,
): EndpointRecipe => {
  const origin = PROVIDER_ORIGINS[providerId];
  const url = new URL(`${pathname}${search}`, origin);
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin ||
    url.pathname !== pathname ||
    url.search !== search ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== '' ||
    url.href !== `${origin}${pathname}${search}`
  ) {
    throw new TypeError('INVALID_PROVIDER_HTTP_RECIPE');
  }
  return Object.freeze({ providerId, method, pathname, search, url: url.href });
};

const ENDPOINT_RECIPES: Readonly<Record<ProviderHttpEndpointId, EndpointRecipe>> = Object.freeze({
  gemini_models: createEndpointRecipe('gemini_api', 'GET', '/v1beta/models', '?pageSize=1000'),
  gemini_interactions: createEndpointRecipe('gemini_api', 'POST', '/v1/interactions', ''),
  openai_models: createEndpointRecipe('openai_api', 'GET', '/v1/models', ''),
  openai_responses: createEndpointRecipe('openai_api', 'POST', '/v1/responses', ''),
  claude_models: createEndpointRecipe('claude_api', 'GET', '/v1/models', '?limit=100'),
  claude_messages: createEndpointRecipe('claude_api', 'POST', '/v1/messages', ''),
});

export type ProviderHttpErrorClassifier = (
  status: number,
  boundedJson: JsonValue,
) => ProviderErrorCode;

export type ProviderHttpRequest = Readonly<{
  providerId: ApiProviderId;
  endpoint: ProviderHttpEndpoint;
  authValue: string;
  body?: JsonValue | undefined;
  timeoutMs: number;
  responseLimitBytes: number;
  signal: AbortSignal;
  classifyError?: ProviderHttpErrorClassifier | undefined;
}>;

export type ProviderHttpLogEvent = Readonly<{
  phase: 'completed' | 'failed';
  providerId: ApiProviderId;
  endpointId: ProviderHttpEndpointId;
  status: number | null;
  errorCode: ProviderErrorCode | null;
  retryAfterMs: number | null;
}>;

export interface ProviderHttpLogger {
  record(event: ProviderHttpLogEvent): void;
}

export interface ProviderHttpClient {
  requestJson(request: ProviderHttpRequest): Promise<JsonValue>;
}

type ProviderHttpClientOptions = Readonly<{
  transport: HttpTransport;
  logger?: ProviderHttpLogger;
  now?: () => number;
}>;

type ParsedRequest = Readonly<{
  providerId: ApiProviderId;
  endpointId: ProviderHttpEndpointId;
  recipe: EndpointRecipe;
  authValue: string;
  body: JsonValue | undefined;
  timeoutMs: number;
  responseLimitBytes: number;
  signal: AbortSignal;
  classifyError: ProviderHttpErrorClassifier | undefined;
}>;

type ByteChunk = Readonly<{
  bytes: Uint8Array;
  previous: ByteChunk | null;
}>;

const providerError = (code: ProviderErrorCode, retryAfterMs: number | null = null): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code], {
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
  });

const descriptorValue = (descriptors: ClosedDataObject, key: string): unknown => descriptors[key];

const parseRequest = (request: ProviderHttpRequest | null): ParsedRequest => {
  try {
    const descriptors = readClosedDataObject(
      request,
      new Set([
        'providerId',
        'endpoint',
        'authValue',
        'body',
        'timeoutMs',
        'responseLimitBytes',
        'signal',
        'classifyError',
      ]),
      new Set(['providerId', 'endpoint', 'authValue', 'timeoutMs', 'responseLimitBytes', 'signal']),
    );
    const providerId = descriptorValue(descriptors, 'providerId');
    if (providerId !== 'gemini_api' && providerId !== 'openai_api' && providerId !== 'claude_api') {
      throw new TypeError('INVALID_PROVIDER_HTTP_PROVIDER');
    }
    const endpointDescriptors = readClosedDataObject(
      descriptorValue(descriptors, 'endpoint'),
      new Set(['id']),
      new Set(['id']),
    );
    const endpointId = descriptorValue(endpointDescriptors, 'id');
    if (typeof endpointId !== 'string' || !(endpointId in ENDPOINT_RECIPES)) {
      throw new TypeError('INVALID_PROVIDER_HTTP_ENDPOINT');
    }
    const recipe = ENDPOINT_RECIPES[endpointId as ProviderHttpEndpointId];
    if (recipe.providerId !== providerId) throw new TypeError('INVALID_PROVIDER_HTTP_PAIR');

    const authValue = descriptorValue(descriptors, 'authValue');
    if (
      typeof authValue !== 'string' ||
      authValue.length < 1 ||
      authValue.length > MAX_AUTH_VALUE_LENGTH ||
      !AUTH_VALUE_PATTERN.test(authValue)
    ) {
      throw providerError('PROVIDER_AUTH_REQUIRED');
    }
    const timeoutMs = descriptorValue(descriptors, 'timeoutMs');
    const responseLimitBytes = descriptorValue(descriptors, 'responseLimitBytes');
    if (
      !Number.isSafeInteger(timeoutMs) ||
      (timeoutMs as number) < 1 ||
      (timeoutMs as number) > MAX_PROVIDER_TIMEOUT_MS ||
      !Number.isSafeInteger(responseLimitBytes) ||
      (responseLimitBytes as number) < 1 ||
      (responseLimitBytes as number) > MAX_PROVIDER_RESPONSE_BYTES
    ) {
      throw new TypeError('INVALID_PROVIDER_HTTP_BOUND');
    }
    const signal = descriptorValue(descriptors, 'signal');
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError('INVALID_PROVIDER_HTTP_SIGNAL');
    }
    const classifyError = descriptorValue(descriptors, 'classifyError');
    if (classifyError !== undefined && typeof classifyError !== 'function') {
      throw new TypeError('INVALID_PROVIDER_HTTP_CLASSIFIER');
    }
    const body = descriptorValue(descriptors, 'body');
    if (recipe.method === 'GET' && body !== undefined) {
      throw new TypeError('UNEXPECTED_PROVIDER_HTTP_BODY');
    }
    if (recipe.method === 'POST' && body === undefined) {
      throw new TypeError('MISSING_PROVIDER_HTTP_BODY');
    }
    const sanitizedBody =
      body === undefined
        ? undefined
        : cloneBoundedJsonValue(body, MAX_PROVIDER_JSON_DEPTH, MAX_PROVIDER_JSON_ENTRIES, 'none');

    return Object.freeze({
      providerId,
      endpointId: endpointId as ProviderHttpEndpointId,
      recipe,
      authValue,
      body: sanitizedBody,
      timeoutMs: timeoutMs as number,
      responseLimitBytes: responseLimitBytes as number,
      signal,
      classifyError: classifyError as ProviderHttpErrorClassifier | undefined,
    });
  } catch (error) {
    if (AppError.isTrusted(error)) throw error;
    throw providerError('PROVIDER_EXECUTION_FAILED');
  }
};

const serializeRequestBody = (parsedRequest: ParsedRequest): string | undefined => {
  if (parsedRequest.recipe.method === 'GET') return undefined;
  try {
    const ceiling =
      parsedRequest.providerId === 'gemini_api'
        ? MAX_PROVIDER_REQUEST_BYTES
        : parsedRequest.providerId === 'openai_api'
          ? 64_000_000
          : 32_000_000;
    if (parsedRequest.body === undefined) throw new TypeError('INVALID_PROVIDER_HTTP_BODY');
    countBoundedJsonBytes(parsedRequest.body, ceiling);
    const serialized = JSON.stringify(parsedRequest.body);
    if (serialized === undefined) throw new TypeError('INVALID_PROVIDER_HTTP_BODY');
    return serialized;
  } catch (error) {
    if (AppError.isTrusted(error)) throw error;
    throw providerError('PROVIDER_EXECUTION_FAILED');
  }
};

const responseContentLength = (
  response: Response,
  invalidCode: ProviderErrorCode,
): number | null => {
  let contentLength: string | null;
  try {
    contentLength = response.headers.get('content-length');
  } catch {
    throw providerError('PROVIDER_NETWORK_FAILED');
  }
  if (contentLength === null) return null;
  const normalized = contentLength.trim();
  if (!CONTENT_LENGTH_PATTERN.test(normalized)) throw providerError(invalidCode);
  const bytes = Number(normalized);
  if (!Number.isSafeInteger(bytes)) throw providerError(invalidCode);
  return bytes;
};

const isJsonMediaType = (response: Response): boolean => {
  try {
    const contentType = response.headers.get('content-type');
    return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
  } catch {
    return false;
  }
};

const statusErrorCode = (status: number): ProviderErrorCode => {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_REQUIRED';
  if (status === 402) return 'PROVIDER_QUOTA_OR_BILLING';
  if (status === 408 || status === 504) return 'PROVIDER_TIMEOUT';
  if (status === 413) return 'PROVIDER_REQUEST_TOO_LARGE';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status === 500 || status === 502 || status === 503 || status === 529) {
    return 'PROVIDER_TEMPORARILY_UNAVAILABLE';
  }
  return 'PROVIDER_EXECUTION_FAILED';
};

const CLASSIFIABLE_ERROR_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 422]);

const parseRetryAfter = (response: Response, now: number): number | null => {
  let value: string | null;
  try {
    value = response.headers.get('retry-after');
  } catch {
    return null;
  }
  if (value === null || value.length > 128) return null;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    try {
      const seconds = BigInt(normalized);
      return seconds >= 5n ? MAX_RETRY_AFTER_MS : Number(seconds) * 1_000;
    } catch {
      return null;
    }
  }
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/.test(
      normalized,
    )
  ) {
    return null;
  }
  const retryAt = Date.parse(normalized);
  if (
    !Number.isFinite(retryAt) ||
    !Number.isFinite(now) ||
    new Date(retryAt).toUTCString() !== normalized
  ) {
    return null;
  }
  return Math.min(Math.max(0, retryAt - now), MAX_RETRY_AFTER_MS);
};

const decodeAndParseJson = (bytes: Uint8Array, invalidCode: ProviderErrorCode): JsonValue => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.length === 0) throw new TypeError('EMPTY_PROVIDER_HTTP_BODY');
    const parsed: unknown = JSON.parse(text);
    return cloneBoundedJsonValue(parsed, MAX_PROVIDER_JSON_DEPTH, MAX_PROVIDER_JSON_ENTRIES);
  } catch {
    throw providerError(invalidCode);
  }
};

class BoundedProviderHttpClient implements ProviderHttpClient {
  readonly #logger: ProviderHttpLogger | undefined;
  readonly #now: () => number;
  readonly #transport: HttpTransport;

  constructor(options: ProviderHttpClientOptions) {
    this.#transport = options.transport;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  requestJson(request: ProviderHttpRequest): Promise<JsonValue> {
    return this.#requestJson(request);
  }

  async #requestJson(request: ProviderHttpRequest | null): Promise<JsonValue> {
    let parsedRequest: ParsedRequest | undefined;
    let serializedBody: string | undefined;
    let authHeaderValue = '';
    let headers: Readonly<Record<string, string>> | undefined;
    let init: HttpTransportRequestInit | undefined;
    let response: Response | undefined;
    let responseStatus: number | null = null;
    let retryAfterMs: number | null = null;
    let abortKind: 'cancelled' | 'timeout' | null = null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forwardAbort: (() => void) | undefined;

    try {
      parsedRequest = parseRequest(request);
      if (parsedRequest.signal.aborted) throw providerError('PROVIDER_CANCELLED');
      serializedBody = serializeRequestBody(parsedRequest);
      authHeaderValue =
        parsedRequest.providerId === 'openai_api'
          ? `Bearer ${parsedRequest.authValue}`
          : parsedRequest.authValue;
      headers = Object.freeze({
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'lecture-study-assistant/0.1.0',
        ...PROVIDER_STATIC_HEADERS[parsedRequest.providerId],
        [AUTH_HEADERS[parsedRequest.providerId]]: authHeaderValue,
      });
      init = Object.freeze({
        method: parsedRequest.recipe.method,
        headers,
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });

      const abortAs = (kind: 'cancelled' | 'timeout') => {
        if (abortKind !== null) return;
        abortKind = kind;
        controller.abort();
      };
      forwardAbort = () => abortAs('cancelled');
      parsedRequest.signal.addEventListener('abort', forwardAbort, { once: true });
      timer = setTimeout(() => abortAs('timeout'), parsedRequest.timeoutMs);

      response = await this.#requestResponse(
        parsedRequest.recipe.url,
        init,
        controller.signal,
        () => this.#abortOr('PROVIDER_NETWORK_FAILED', abortKind),
      );
      if (!(response instanceof Response)) throw providerError('PROVIDER_NETWORK_FAILED');
      responseStatus = response.status;
      if (response.redirected || (responseStatus >= 300 && responseStatus < 400)) {
        this.#cancelBody(response, controller);
        throw providerError('PROVIDER_NETWORK_FAILED');
      }
      if (responseStatus < 200 || responseStatus > 599) {
        this.#cancelBody(response, controller);
        throw providerError('PROVIDER_NETWORK_FAILED');
      }

      if (!response.ok) {
        retryAfterMs = responseStatus === 529 ? null : parseRetryAfter(response, this.#now());
        const code = statusErrorCode(responseStatus);
        const classifyError = parsedRequest.classifyError;
        if (classifyError === undefined || !CLASSIFIABLE_ERROR_STATUSES.has(responseStatus)) {
          this.#cancelBody(response, controller);
          throw providerError(code, retryAfterMs);
        }
        const declaredBytes = responseContentLength(response, 'PROVIDER_EXECUTION_FAILED');
        if (declaredBytes !== null && declaredBytes > MAX_ERROR_RESPONSE_BYTES) {
          this.#cancelBody(response, controller);
          throw providerError('PROVIDER_RESPONSE_TOO_LARGE');
        }
        const bytes = await this.#readBody(
          response,
          MAX_ERROR_RESPONSE_BYTES,
          controller,
          () => this.#abortOr('PROVIDER_EXECUTION_FAILED', abortKind),
          true,
        );
        if (!isJsonMediaType(response)) throw providerError('PROVIDER_EXECUTION_FAILED');
        const boundedJson = decodeAndParseJson(bytes, 'PROVIDER_EXECUTION_FAILED');
        let classified: unknown;
        try {
          classified = classifyError(responseStatus, boundedJson);
        } catch {
          throw providerError('PROVIDER_EXECUTION_FAILED');
        }
        const parsedCode = ProviderErrorCodeSchema.safeParse(classified);
        if (!parsedCode.success) throw providerError('PROVIDER_EXECUTION_FAILED');
        throw providerError(parsedCode.data, retryAfterMs);
      }

      const declaredBytes = responseContentLength(response, 'PROVIDER_OUTPUT_INVALID');
      if (declaredBytes !== null && declaredBytes > parsedRequest.responseLimitBytes) {
        this.#cancelBody(response, controller);
        throw providerError('PROVIDER_RESPONSE_TOO_LARGE');
      }
      if (!isJsonMediaType(response)) {
        this.#cancelBody(response, controller);
        throw providerError('PROVIDER_OUTPUT_INVALID');
      }
      const bytes = await this.#readBody(
        response,
        parsedRequest.responseLimitBytes,
        controller,
        () => this.#abortOr('PROVIDER_NETWORK_FAILED', abortKind),
        false,
      );
      const result = decodeAndParseJson(bytes, 'PROVIDER_OUTPUT_INVALID');
      this.#record(
        Object.freeze({
          phase: 'completed',
          providerId: parsedRequest.providerId,
          endpointId: parsedRequest.endpointId,
          status: responseStatus,
          errorCode: null,
          retryAfterMs: null,
        }),
      );
      return result;
    } catch (error) {
      const normalized =
        AppError.isTrusted(error) && ProviderErrorCodeSchema.safeParse(error.code).success
          ? error
          : providerError('PROVIDER_EXECUTION_FAILED');
      if (parsedRequest !== undefined) {
        this.#record(
          Object.freeze({
            phase: 'failed',
            providerId: parsedRequest.providerId,
            endpointId: parsedRequest.endpointId,
            status: responseStatus,
            errorCode: normalized.code as ProviderErrorCode,
            retryAfterMs,
          }),
        );
      }
      throw normalized;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (forwardAbort !== undefined) {
        parsedRequest?.signal.removeEventListener('abort', forwardAbort);
      }
      authHeaderValue = '';
      headers = undefined;
      init = undefined;
      response = undefined;
      serializedBody = undefined;
      parsedRequest = undefined;
      request = null;
    }
  }

  async #readBody(
    response: Response,
    limitBytes: number,
    controller: AbortController,
    failure: () => AppError,
    allowEmpty: boolean,
  ): Promise<Uint8Array> {
    if (response.body === null) {
      if (allowEmpty) return new Uint8Array();
      throw providerError('PROVIDER_OUTPUT_INVALID');
    }
    const reader = response.body.getReader();
    let chunks: ByteChunk | null = null;
    let bytesRead = 0;
    let chunkCount = 0;
    try {
      while (true) {
        const next = await this.#readChunk(reader, controller.signal, failure);
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw providerError('PROVIDER_OUTPUT_INVALID');
        bytesRead += next.value.byteLength;
        chunkCount += 1;
        if (bytesRead > limitBytes || chunkCount > MAX_PROVIDER_RESPONSE_CHUNKS) {
          controller.abort();
          this.#ignoreCleanup(() => reader.cancel());
          throw providerError('PROVIDER_RESPONSE_TOO_LARGE');
        }
        chunks = Object.freeze({ bytes: next.value.slice(), previous: chunks });
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Cleanup cannot replace the normalized result.
      }
    }
    if (!allowEmpty && bytesRead === 0) throw providerError('PROVIDER_OUTPUT_INVALID');
    const combined = Buffer.alloc(bytesRead);
    let offset = bytesRead;
    let chunk = chunks;
    while (chunk !== null) {
      offset -= chunk.bytes.byteLength;
      combined.set(chunk.bytes, offset);
      chunk = chunk.previous;
    }
    return combined;
  }

  async #requestResponse(
    url: string,
    init: HttpTransportRequestInit,
    signal: AbortSignal,
    failure: () => AppError,
  ): Promise<Response> {
    let transportRequest: Promise<Response>;
    try {
      transportRequest = this.#transport.request(url, init);
    } catch {
      throw failure();
    }
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<null>((resolve) => {
      abortListener = () => resolve(null);
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    const settled: Promise<Response | null> = Promise.resolve(transportRequest).then(
      (response) => {
        if (!signal.aborted) return response;
        this.#ignoreCleanup(() => response.body?.cancel());
        return null;
      },
      () => null,
    );
    try {
      const response = await Promise.race([settled, aborted]);
      if (!(response instanceof Response)) throw failure();
      return response;
    } finally {
      if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
    }
  }

  async #readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
    failure: () => AppError,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (signal.aborted) throw failure();
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<Readonly<{ kind: 'aborted' }>>((resolve) => {
      abortListener = () => resolve(Object.freeze({ kind: 'aborted' as const }));
      signal.addEventListener('abort', abortListener, { once: true });
    });
    const read = reader.read().then(
      (value) => Object.freeze({ kind: 'read' as const, value }),
      () => Object.freeze({ kind: 'failed' as const }),
    );
    const outcome = await Promise.race([read, aborted]);
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
    if (outcome.kind === 'aborted') {
      this.#ignoreCleanup(() => reader.cancel());
      throw failure();
    }
    if (outcome.kind === 'failed') throw failure();
    return outcome.value;
  }

  #abortOr(fallback: ProviderErrorCode, abortKind: 'cancelled' | 'timeout' | null): AppError {
    if (abortKind === 'cancelled') return providerError('PROVIDER_CANCELLED');
    if (abortKind === 'timeout') return providerError('PROVIDER_TIMEOUT');
    return providerError(fallback);
  }

  #cancelBody(response: Response, controller: AbortController): void {
    controller.abort();
    this.#ignoreCleanup(() => response.body?.cancel());
  }

  #ignoreCleanup(cleanup: () => Promise<void> | undefined): void {
    try {
      void cleanup()?.catch(() => undefined);
    } catch {
      // Best-effort cleanup never replaces the fixed primary result.
    }
  }

  #record(event: ProviderHttpLogEvent): void {
    try {
      this.#logger?.record(event);
    } catch {
      // Logging is best-effort and receives only fixed, content-free metadata.
    }
  }
}

export const createProviderHttpClientForTest = (
  options: ProviderHttpClientOptions,
): ProviderHttpClient => new BoundedProviderHttpClient(options);

export const createProviderHttpClient = createProviderHttpClientForTest;
