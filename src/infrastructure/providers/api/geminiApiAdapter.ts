import type {
  AiProviderAdapter,
  ProviderBlock,
  ProviderConnectionOperation,
  ProviderExecution,
  ProviderInspection,
  ProviderProbeEvidence,
  ProviderRequest,
} from '../../../core/ports/aiProvider';
import { createProviderOperation } from '../../../core/ports/aiProvider';
import { assertProviderSupportsBlocks } from '../../../core/ports/providerCapabilities';
import type { SecretStore } from '../../../core/ports/secretStore';
import {
  PROVIDER_PROBE_JSON_SCHEMA,
  PROVIDER_PROBE_PROMPT,
  ProviderProbeOutputSchema,
} from '../../../core/providers/providerProbe';
import type { JsonValue, ProviderModel } from '../../../shared/contracts/provider';
import type { ProviderSourceMaterializerPort } from '../providerSourceMaterializer';
import {
  assertGeminiApiModelId,
  buildGeminiInteractionBody,
  classifyGeminiApiError,
  GEMINI_API_UUID_PATTERN,
  geminiApiError,
  parseGeminiInteraction,
  parseGeminiModelList,
  sanitizeGeminiApiFailure,
} from './geminiApiProtocol';
import { prepareApiMediaBody } from './providerApiMedia';
import type { ProviderHttpClient, ProviderHttpRequest } from './providerHttpClient';

const MODEL_LIST_TIMEOUT_MS = 30_000;
const MODEL_LIST_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const PROBE_RESPONSE_LIMIT_BYTES = 1024 * 1024;
const INTERACTION_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 120_000;
const PROBE_MAX_OUTPUT_TOKENS = 128;

export type GeminiApiAdapterOptions = Readonly<{
  httpClient: ProviderHttpClient;
  secretStore: SecretStore;
  now: () => string;
  nowMilliseconds: () => number;
  materializer?: ProviderSourceMaterializerPort;
}>;

type ActiveOperation = Readonly<{
  requestId: string;
  sourceSignal: AbortSignal;
  controller: AbortController;
  onAbort: () => void;
}>;

type InteractionOperation<Output extends JsonValue> = Readonly<{
  modelId: string;
  blocks: readonly ProviderBlock[];
  outputJsonSchema: Readonly<Record<string, JsonValue>>;
  parseOutput: (value: unknown) => Output;
  timeoutMs: number;
  responseLimitBytes: number;
  maxOutputTokens: number;
}>;

class GeminiApiAdapter implements AiProviderAdapter<'gemini_api'> {
  readonly id = 'gemini_api' as const;
  readonly #options: GeminiApiAdapterOptions;
  readonly #active = new Map<string, ActiveOperation>();

  constructor(options: GeminiApiAdapterOptions) {
    this.#options = options;
  }

  async inspect(operation: ProviderConnectionOperation): Promise<ProviderInspection<'gemini_api'>> {
    let active: ActiveOperation | undefined;
    try {
      active = this.#beginOperation(operation.requestId, operation.signal);
      const credentialPresent = await this.#options.secretStore.has(
        'gemini_api_key',
        this.#secretOperation(active),
      );
      this.#assertActive(active);
      return Object.freeze({
        status: credentialPresent ? ('credential_saved' as const) : ('missing_credential' as const),
        version: null,
        credentialPresent,
        credentialScope: 'not_applicable' as const,
        cliBinding: null,
        providerManagedHistory: false as const,
      });
    } catch (error) {
      throw sanitizeGeminiApiFailure(error);
    } finally {
      if (active !== undefined) this.#finishOperation(active);
    }
  }

  async listModels(operation: ProviderConnectionOperation): Promise<readonly ProviderModel[]> {
    let active: ActiveOperation | undefined;
    let authValue: string | undefined;
    let response: JsonValue | undefined;
    try {
      active = this.#beginOperation(operation.requestId, operation.signal);
      authValue = await this.#readSecret(active);
      response = await this.#options.httpClient.requestJson(
        Object.freeze({
          providerId: 'gemini_api',
          endpoint: Object.freeze({ id: 'gemini_models' as const }),
          authValue,
          timeoutMs: MODEL_LIST_TIMEOUT_MS,
          responseLimitBytes: MODEL_LIST_RESPONSE_LIMIT_BYTES,
          signal: active.controller.signal,
        }),
      );
      this.#assertActive(active);
      return parseGeminiModelList(response);
    } catch (error) {
      throw sanitizeGeminiApiFailure(error);
    } finally {
      response = undefined;
      authValue = undefined;
      if (active !== undefined) this.#finishOperation(active);
    }
  }

  async probe(
    modelId: string | null,
    operation: ProviderConnectionOperation,
  ): Promise<ProviderProbeEvidence> {
    let active: ActiveOperation | undefined;
    try {
      const selectedModelId = assertGeminiApiModelId(modelId);
      active = this.#beginOperation(operation.requestId, operation.signal);
      const startedAt = this.#safeMilliseconds();
      const parsed = await this.#executeInteraction(
        Object.freeze({
          modelId: selectedModelId,
          blocks: Object.freeze([
            Object.freeze({
              role: 'user' as const,
              kind: 'instruction' as const,
              text: PROVIDER_PROBE_PROMPT,
            }),
          ]),
          outputJsonSchema: PROVIDER_PROBE_JSON_SCHEMA,
          parseOutput: (value: unknown) => ProviderProbeOutputSchema.parse(value),
          timeoutMs: PROBE_TIMEOUT_MS,
          responseLimitBytes: PROBE_RESPONSE_LIMIT_BYTES,
          maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
        }),
        active,
      );
      this.#assertActive(active);
      const completedAt = this.#safeMilliseconds();
      return Object.freeze({
        status: 'ready' as const,
        reportedModelId: parsed.reportedModelId,
        latencyMs: Math.max(0, Math.trunc(completedAt - startedAt)),
        usage: Object.freeze({ ...parsed.usage }),
        providerManagedHistory: false as const,
      });
    } catch (error) {
      throw sanitizeGeminiApiFailure(error);
    } finally {
      if (active !== undefined) this.#finishOperation(active);
    }
  }

  async execute<Output extends JsonValue>(
    request: ProviderRequest<Output>,
  ): Promise<ProviderExecution<Output>> {
    let active: ActiveOperation | undefined;
    try {
      const modelId = assertGeminiApiModelId(request.modelId);
      const snapshot = createProviderOperation({
        requestId: request.requestId,
        feature: request.feature,
        jobId: request.jobId,
        outputSchemaId: request.outputSchemaId,
        outputJsonSchema: request.outputJsonSchema,
        parseOutput: request.parseOutput,
        blocks: request.blocks,
        timeoutMs: request.timeoutMs,
        maxOutputTokens: request.maxOutputTokens,
        signal: request.signal,
      });
      assertProviderSupportsBlocks(this.id, snapshot.blocks, snapshot.feature);
      active = this.#beginOperation(request.requestId, request.signal);
      return await this.#executeInteraction(
        Object.freeze({
          modelId,
          blocks: snapshot.blocks,
          outputJsonSchema: snapshot.outputJsonSchema,
          parseOutput: snapshot.parseOutput,
          timeoutMs: snapshot.timeoutMs,
          responseLimitBytes: INTERACTION_RESPONSE_LIMIT_BYTES,
          maxOutputTokens: snapshot.maxOutputTokens,
        }),
        active,
      );
    } catch (error) {
      throw sanitizeGeminiApiFailure(error);
    } finally {
      if (active !== undefined) this.#finishOperation(active);
      request = null as never;
    }
  }

  cancel(requestId: string): void {
    const active = this.#active.get(requestId);
    if (active === undefined) return;
    this.#cancelOperation(active);
  }

  async #executeInteraction<Output extends JsonValue>(
    operation: InteractionOperation<Output>,
    active: ActiveOperation,
  ): Promise<ProviderExecution<Output>> {
    let authValue: string | undefined;
    let body: JsonValue | undefined;
    let response: JsonValue | undefined;
    try {
      this.#assertActive(active);
      body = await prepareApiMediaBody({
        providerId: 'gemini_api',
        modelId: operation.modelId,
        requestId: active.requestId,
        blocks: operation.blocks,
        signal: active.controller.signal,
        ...(this.#options.materializer ? { materializer: this.#options.materializer } : {}),
        build: (blocks) =>
          buildGeminiInteractionBody({
            modelId: operation.modelId,
            blocks,
            outputJsonSchema: operation.outputJsonSchema,
            maxOutputTokens: operation.maxOutputTokens,
          }),
      });
      this.#assertActive(active);
      authValue = await this.#readSecret(active);
      this.#assertActive(active);
      const outbound: ProviderHttpRequest = Object.freeze({
        providerId: 'gemini_api',
        endpoint: Object.freeze({ id: 'gemini_interactions' as const }),
        authValue,
        body,
        timeoutMs: operation.timeoutMs,
        responseLimitBytes: operation.responseLimitBytes,
        signal: active.controller.signal,
        classifyError: classifyGeminiApiError,
      });
      response = await this.#options.httpClient.requestJson(outbound);
      this.#assertActive(active);
      const parsed = parseGeminiInteraction(response, operation.parseOutput, this.#safeNow());
      this.#assertActive(active);
      return parsed;
    } finally {
      response = undefined;
      body = undefined;
      authValue = undefined;
    }
  }

  async #readSecret(active: ActiveOperation): Promise<string> {
    this.#assertActive(active);
    const authValue = await this.#options.secretStore.get(
      'gemini_api_key',
      this.#secretOperation(active),
    );
    this.#assertActive(active);
    if (typeof authValue !== 'string' || authValue.length === 0) {
      throw geminiApiError('PROVIDER_AUTH_REQUIRED');
    }
    return authValue;
  }

  #secretOperation(active: ActiveOperation): ProviderConnectionOperation {
    return Object.freeze({ requestId: active.requestId, signal: active.controller.signal });
  }

  #beginOperation(requestId: string, sourceSignal: AbortSignal): ActiveOperation {
    if (
      typeof requestId !== 'string' ||
      !GEMINI_API_UUID_PATTERN.test(requestId) ||
      !(sourceSignal instanceof AbortSignal) ||
      this.#active.has(requestId)
    ) {
      throw geminiApiError('PROVIDER_EXECUTION_FAILED');
    }
    if (sourceSignal.aborted) throw geminiApiError('PROVIDER_CANCELLED');
    const controller = new AbortController();
    let active: ActiveOperation;
    const onAbort = () => this.#cancelOperation(active);
    active = Object.freeze({ requestId, sourceSignal, controller, onAbort });
    this.#active.set(requestId, active);
    sourceSignal.addEventListener('abort', onAbort, { once: true });
    if (sourceSignal.aborted) {
      this.#cancelOperation(active);
      this.#finishOperation(active);
      throw geminiApiError('PROVIDER_CANCELLED');
    }
    this.#assertActive(active);
    return active;
  }

  #cancelOperation(active: ActiveOperation): void {
    if (!active.controller.signal.aborted) active.controller.abort();
  }

  #assertActive(active: ActiveOperation): void {
    if (active.sourceSignal.aborted && !active.controller.signal.aborted) {
      this.#cancelOperation(active);
    }
    if (active.controller.signal.aborted) throw geminiApiError('PROVIDER_CANCELLED');
  }

  #finishOperation(active: ActiveOperation): void {
    active.sourceSignal.removeEventListener('abort', active.onAbort);
    if (this.#active.get(active.requestId) === active) this.#active.delete(active.requestId);
  }

  #safeNow(): string {
    const value = this.#options.now();
    if (typeof value !== 'string') throw geminiApiError('PROVIDER_OUTPUT_INVALID');
    return value;
  }

  #safeMilliseconds(): number {
    const value = this.#options.nowMilliseconds();
    if (!Number.isFinite(value) || value < 0) {
      throw geminiApiError('PROVIDER_EXECUTION_FAILED');
    }
    return value;
  }
}

export const createGeminiApiAdapterForTest = (
  options: GeminiApiAdapterOptions,
): AiProviderAdapter<'gemini_api'> => new GeminiApiAdapter(options);

export const createGeminiApiAdapter = createGeminiApiAdapterForTest;
