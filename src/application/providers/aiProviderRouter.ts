import type {
  AiProviderAdapter,
  ProviderDiagnostic,
  ProviderExecution,
  ProviderOperation,
  ProviderRequest,
  ProviderUsage,
} from '../../core/ports/aiProvider';
import { assertProviderSupportsBlocks } from '../../core/ports/aiProvider';
import type {
  ProviderDiagnosticRepository,
  ProviderInvocationRepository,
  ProviderRouteRepository,
} from '../../core/ports/providerRepositories';
import { freezeJsonCopy, sha256CanonicalJson } from '../../core/providers/canonicalJson';
import {
  ProviderConcurrency,
  type ProviderConcurrencyLease,
} from '../../core/providers/providerConcurrency';
import {
  normalizeProviderFailure,
  type ProviderFailure,
} from '../../core/providers/providerErrors';
import { classifyProviderRetry, FORMAT_REPAIR_BLOCK } from '../../core/providers/retryPolicy';
import {
  type AiProviderId,
  ANTIGRAVITY_HISTORY_NOTICE_VERSION,
  type JsonValue,
  ModelIdSchema,
  type ProviderRoute,
  type ProviderStatus,
  SHARED_CREDENTIAL_NOTICE_VERSION,
} from '../../shared/contracts/provider';
import type {
  ProviderInvocation,
  ProviderInvocationCompletion,
} from '../../shared/contracts/providerInvocation';
import { APP_ERROR_MESSAGES, AppError, type ProviderErrorCode } from '../../shared/errors';

type Delay = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export type AiProviderRouterDependencies = Readonly<{
  routes: ProviderRouteRepository;
  diagnostics: ProviderDiagnosticRepository;
  invocations: ProviderInvocationRepository;
  adapters: ReadonlyMap<AiProviderId, AiProviderAdapter>;
  clock: () => string;
  id: () => string;
  hash?: (value: unknown) => string;
  delay?: Delay;
  concurrency?: ProviderConcurrency;
}>;

type ActiveRequest = {
  readonly requestId: string;
  readonly controller: AbortController;
  adapter: AiProviderAdapter | null;
  acquired: boolean;
  cancelRequested: boolean;
  invocationId: string | null;
  suppressStaleAfterShutdown: boolean;
  completion: Promise<ProviderExecution<JsonValue>> | null;
};

type AttemptResult<Output extends JsonValue> = Readonly<{
  invocationId: string;
  execution: ProviderExecution<Output> | null;
  failure: ProviderFailure;
  latencyMs: number;
}>;

const providerError = (code: ProviderErrorCode): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);

const defaultDelay: Delay = (milliseconds, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(providerError('PROVIDER_CANCELLED'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(providerError('PROVIDER_CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });

const elapsedMilliseconds = (startedAt: string, completedAt: string): number => {
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) ? Math.max(0, Math.trunc(elapsed)) : 0;
};

const emptyUsage = (): ProviderUsage =>
  Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null });

const terminalStatusFor = (code: ProviderErrorCode): ProviderStatus | null => {
  switch (code) {
    case 'PROVIDER_EXECUTABLE_NOT_FOUND':
      return 'missing_executable';
    case 'PROVIDER_CLI_CHANGED':
    case 'PROVIDER_UNSAFE_VERSION':
    case 'PROVIDER_RESIDUAL_DATA':
      return 'unsafe_version';
    case 'PROVIDER_AUTH_REQUIRED':
      return 'auth_required';
    case 'PROVIDER_ACCOUNT_UNSUPPORTED':
      return 'account_unsupported';
    case 'PROVIDER_MODEL_INCOMPATIBLE':
      return 'incompatible_model';
    case 'PROVIDER_QUOTA_OR_BILLING':
      return 'quota_or_billing';
    case 'PROVIDER_NETWORK_FAILED':
    case 'PROVIDER_RATE_LIMITED':
    case 'PROVIDER_TEMPORARILY_UNAVAILABLE':
    case 'PROVIDER_TIMEOUT':
      return 'temporarily_unavailable';
    case 'PROVIDER_OUTPUT_INVALID':
      return 'invalid_provider_output';
    default:
      return null;
  }
};

export class AiProviderRouter {
  readonly #active = new Map<string, ActiveRequest>();
  readonly #adapters: ReadonlyMap<AiProviderId, AiProviderAdapter>;
  readonly #clock: () => string;
  readonly #concurrency: ProviderConcurrency;
  readonly #delay: Delay;
  readonly #diagnostics: ProviderDiagnosticRepository;
  readonly #hash: (value: unknown) => string;
  readonly #id: () => string;
  readonly #invocations: ProviderInvocationRepository;
  readonly #routes: ProviderRouteRepository;
  #shutdownPromise: Promise<void> | null = null;
  #stopped = false;

  constructor(dependencies: AiProviderRouterDependencies) {
    this.#routes = dependencies.routes;
    this.#diagnostics = dependencies.diagnostics;
    this.#invocations = dependencies.invocations;
    this.#adapters = dependencies.adapters;
    this.#clock = dependencies.clock;
    this.#id = dependencies.id;
    this.#hash = dependencies.hash ?? sha256CanonicalJson;
    this.#delay = dependencies.delay ?? defaultDelay;
    this.#concurrency = dependencies.concurrency ?? new ProviderConcurrency();
  }

  execute<Output extends JsonValue>(
    request: ProviderOperation<Output>,
  ): Promise<ProviderExecution<Output>> {
    if (this.#stopped || this.#active.has(request.requestId)) {
      return Promise.reject(providerError('PROVIDER_CANCELLED'));
    }
    const state: ActiveRequest = {
      requestId: request.requestId,
      controller: new AbortController(),
      adapter: null,
      acquired: false,
      cancelRequested: false,
      invocationId: null,
      suppressStaleAfterShutdown: false,
      completion: null,
    };
    const completion = this.#execute(request, state).finally(() => {
      if (this.#active.get(request.requestId) === state) this.#active.delete(request.requestId);
    });
    state.completion = completion as Promise<ProviderExecution<JsonValue>>;
    this.#active.set(request.requestId, state);
    return completion;
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== null) return this.#shutdownPromise;
    this.#stopped = true;
    this.#concurrency.shutdown();
    const snapshot = Object.freeze([...this.#active.values()]);
    for (const state of snapshot) {
      state.suppressStaleAfterShutdown = true;
      state.controller.abort();
      this.#cancelSelected(state);
    }
    this.#shutdownPromise = this.#finishShutdown(snapshot).catch((error: unknown) => {
      this.#shutdownPromise = null;
      throw error;
    });
    return this.#shutdownPromise;
  }

  async #execute<Output extends JsonValue>(
    request: ProviderOperation<Output>,
    state: ActiveRequest,
  ): Promise<ProviderExecution<Output>> {
    const route = this.#routeSnapshot(request);
    assertProviderSupportsBlocks(route.providerId, request.blocks, request.feature);
    const diagnostic = this.#requireReadyDiagnostic(route);
    const adapter = this.#adapters.get(route.providerId as AiProviderId);
    if (adapter === undefined || adapter.id !== route.providerId) {
      throw providerError('PROVIDER_NOT_CONFIGURED');
    }
    state.adapter = adapter;
    const signal = AbortSignal.any([request.signal, state.controller.signal]);
    const onAbort = (): void => this.#cancelSelected(state);
    signal.addEventListener('abort', onAbort, { once: true });
    let lease: ProviderConcurrencyLease | null = null;
    try {
      lease = await this.#concurrency.acquire(route.providerId as AiProviderId, signal);
      state.acquired = true;
      if (signal.aborted) {
        this.#cancelSelected(state);
        throw providerError('PROVIDER_CANCELLED');
      }
      return await this.#runAttempts(request, route, diagnostic, adapter, signal, state);
    } finally {
      signal.removeEventListener('abort', onAbort);
      state.acquired = false;
      lease?.release();
    }
  }

  #routeSnapshot<Output extends JsonValue>(
    request: ProviderOperation<Output>,
  ): ProviderRoute & {
    providerId: AiProviderId;
  } {
    const current = this.#routes.get(request.feature);
    if (current === null || !current.enabled || current.providerId === null) {
      throw providerError('PROVIDER_NOT_CONFIGURED');
    }
    return Object.freeze({ ...current, providerId: current.providerId });
  }

  #requireReadyDiagnostic(route: ProviderRoute & { providerId: AiProviderId }): ProviderDiagnostic {
    const diagnostic = this.#diagnostics.get(route.providerId);
    if (diagnostic === null) throw providerError('PROVIDER_NOT_READY');
    if (diagnostic.credentialScope === 'unknown') throw providerError('PROVIDER_NOT_READY');
    if (diagnostic.status !== 'ready') throw providerError('PROVIDER_NOT_READY');
    if (diagnostic.selectedModelId !== route.modelId) {
      throw providerError('PROVIDER_MODEL_INCOMPATIBLE');
    }
    if (
      diagnostic.credentialScope === 'provider_global' &&
      (diagnostic.sharedCredentialConsentAt === null ||
        diagnostic.sharedCredentialConsentVersion !== SHARED_CREDENTIAL_NOTICE_VERSION)
    ) {
      throw providerError('PROVIDER_SHARED_CREDENTIAL_CONSENT_REQUIRED');
    }
    if (
      route.providerId === 'antigravity_cli' &&
      (route.providerManagedHistoryConsentAt === null ||
        route.providerManagedHistoryConsentVersion !== ANTIGRAVITY_HISTORY_NOTICE_VERSION)
    ) {
      throw providerError('PROVIDER_DATA_RETENTION_CONSENT_REQUIRED');
    }
    return Object.freeze({ ...diagnostic }) as ProviderDiagnostic;
  }

  async #runAttempts<Output extends JsonValue>(
    request: ProviderOperation<Output>,
    route: ProviderRoute & { providerId: AiProviderId },
    diagnostic: ProviderDiagnostic,
    adapter: AiProviderAdapter,
    signal: AbortSignal,
    state: ActiveRequest,
  ): Promise<ProviderExecution<Output>> {
    let attemptKind: ProviderRequest<Output>['attemptKind'] = 'initial';
    let attemptedCalls = 0;
    let retryOf: string | null = null;
    while (true) {
      const result: AttemptResult<Output> = await this.#attempt(
        request,
        route,
        diagnostic,
        adapter,
        signal,
        state,
        attemptKind,
        retryOf,
      );
      attemptedCalls += 1;
      retryOf = result.invocationId;
      if (result.execution !== null) {
        await this.#refreshDiagnostic(diagnostic, result.execution, result.latencyMs);
        return result.execution;
      }
      const retry = classifyProviderRetry(result.failure, attemptedCalls);
      if (retry === null) {
        await this.#lowerDiagnostic(
          diagnostic,
          result.failure.publicError.code as ProviderErrorCode,
        );
        throw result.failure.publicError;
      }
      try {
        await this.#delay(retry.delayMs, signal);
      } catch (error) {
        if (signal.aborted) throw providerError('PROVIDER_CANCELLED');
        throw normalizeProviderFailure(error).publicError;
      }
      attemptKind = retry.attemptKind;
    }
  }

  async #attempt<Output extends JsonValue>(
    request: ProviderOperation<Output>,
    route: ProviderRoute & { providerId: AiProviderId },
    diagnostic: ProviderDiagnostic,
    adapter: AiProviderAdapter,
    signal: AbortSignal,
    state: ActiveRequest,
    attemptKind: ProviderRequest<Output>['attemptKind'],
    retryOf: string | null,
  ): Promise<AttemptResult<Output>> {
    const blocks =
      attemptKind === 'format_repair'
        ? Object.freeze([...request.blocks, FORMAT_REPAIR_BLOCK])
        : request.blocks;
    const { composedPromptSha256, ...adapterOperation } = request;
    const effectivePromptVersion =
      attemptKind === 'format_repair'
        ? sha256CanonicalJson({
            identityVersion: 'provider-prompt-attempt-v1',
            basePromptSha256:
              composedPromptSha256 ??
              sha256CanonicalJson(
                request.blocks.filter(
                  (block) => block.kind === 'instruction' || block.kind === 'format_repair',
                ),
              ),
            appendedInstructions: [FORMAT_REPAIR_BLOCK],
          })
        : (composedPromptSha256 ?? route.promptVersion);
    const adapterRequest: ProviderRequest<Output> = Object.freeze({
      ...adapterOperation,
      blocks,
      signal,
      modelId: route.modelId,
      promptVersion: effectivePromptVersion,
      routeRevision: route.revision,
      providerManagedHistoryConsentAt: route.providerManagedHistoryConsentAt,
      providerManagedHistoryConsentVersion: route.providerManagedHistoryConsentVersion,
      sharedCredentialConsentAt: diagnostic.sharedCredentialConsentAt,
      sharedCredentialConsentVersion: diagnostic.sharedCredentialConsentVersion,
      attemptKind,
    });
    const startedAt = this.#clock();
    const invocationId = this.#id();
    const requestSha256 = this.#hash({
      feature: request.feature,
      providerId: route.providerId,
      selectedModelId: route.modelId,
      promptVersion: route.promptVersion,
      ...(request.composedPromptSha256 === undefined
        ? {}
        : { composedPromptSha256: effectivePromptVersion }),
      outputSchemaId: request.outputSchemaId,
      routeRevision: route.revision,
      timeoutMs: request.timeoutMs,
      maxOutputTokens: request.maxOutputTokens,
      blocks: blocks.map((block) =>
        block.kind === 'source_file'
          ? {
              role: block.role,
              kind: block.kind,
              sourceId: block.sourceId,
              mediaType: block.mediaType,
              sha256: block.sha256,
              sizeBytes: block.sizeBytes,
            }
          : { role: block.role, kind: block.kind, text: block.text },
      ),
    });
    const running: ProviderInvocation = Object.freeze({
      id: invocationId,
      requestId: request.requestId,
      jobId: request.jobId,
      feature: request.feature,
      providerId: route.providerId,
      selectedModelId: route.modelId,
      reportedModelId: null,
      promptVersion: effectivePromptVersion,
      outputSchemaId: request.outputSchemaId,
      routeRevision: route.revision,
      requestSha256,
      responseSha256: null,
      status: 'running',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      latencyMs: null,
      retryOf,
      attemptKind,
      errorCode: null,
      startedAt,
      completedAt: null,
      revision: 0,
    });
    this.#invocations.create(running);
    state.invocationId = invocationId;

    let execution: ProviderExecution<Output>;
    try {
      execution = await adapter.execute(adapterRequest);
    } catch (error) {
      const normalized = normalizeProviderFailure(error);
      const failure =
        signal.aborted && normalized.publicError.code !== 'PROVIDER_RESIDUAL_DATA'
          ? normalizeProviderFailure(providerError('PROVIDER_CANCELLED'))
          : normalized;
      const completedAt = this.#clock();
      const latencyMs = elapsedMilliseconds(startedAt, completedAt);
      this.#completeFailure(
        state,
        invocationId,
        failure,
        null,
        emptyUsage(),
        latencyMs,
        completedAt,
      );
      return Object.freeze({ invocationId, execution: null, failure, latencyMs });
    }

    if (signal.aborted) {
      const failure = normalizeProviderFailure(providerError('PROVIDER_CANCELLED'));
      const completedAt = this.#clock();
      const latencyMs = elapsedMilliseconds(startedAt, completedAt);
      this.#completeFailure(
        state,
        invocationId,
        failure,
        null,
        execution.usage,
        latencyMs,
        completedAt,
      );
      return Object.freeze({ invocationId, execution: null, failure, latencyMs });
    }

    const parsedModel =
      execution.reportedModelId === null
        ? Object.freeze({ success: true as const, data: null })
        : ModelIdSchema.safeParse(execution.reportedModelId);
    if (!parsedModel.success || parsedModel.data !== diagnostic.reportedModelId) {
      const failure = normalizeProviderFailure(providerError('PROVIDER_MODEL_INCOMPATIBLE'));
      const completedAt = execution.completedAt;
      const latencyMs = elapsedMilliseconds(startedAt, completedAt);
      this.#completeFailure(
        state,
        invocationId,
        failure,
        parsedModel.success ? parsedModel.data : null,
        execution.usage,
        latencyMs,
        completedAt,
      );
      return Object.freeze({ invocationId, execution: null, failure, latencyMs });
    }

    let output: Output;
    let responseSha256: string;
    const usage = Object.freeze({ ...execution.usage });
    try {
      output = freezeJsonCopy(request.parseOutput(execution.output)) as Output;
      responseSha256 = this.#hash(output);
    } catch {
      const failure = normalizeProviderFailure(providerError('PROVIDER_OUTPUT_INVALID'));
      const latencyMs = elapsedMilliseconds(startedAt, execution.completedAt);
      this.#completeFailure(
        state,
        invocationId,
        failure,
        parsedModel.data,
        execution.usage,
        latencyMs,
        execution.completedAt,
      );
      return Object.freeze({ invocationId, execution: null, failure, latencyMs });
    }
    const latencyMs = elapsedMilliseconds(startedAt, execution.completedAt);
    this.#completeAccepted(
      state,
      invocationId,
      parsedModel.data,
      responseSha256,
      usage,
      latencyMs,
      execution.completedAt,
    );
    return Object.freeze({
      invocationId,
      execution: Object.freeze({
        ...execution,
        output,
        reportedModelId: parsedModel.data,
        usage,
      }),
      failure: normalizeProviderFailure(providerError('PROVIDER_EXECUTION_FAILED')),
      latencyMs,
    });
  }

  #completeAccepted(
    state: ActiveRequest,
    invocationId: string,
    reportedModelId: string | null,
    responseSha256: string,
    usage: ProviderUsage,
    latencyMs: number,
    completedAt: string,
  ): void {
    this.#complete(
      state,
      invocationId,
      Object.freeze({
        status: 'completed',
        reportedModelId,
        responseSha256,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        latencyMs,
        completedAt,
        errorCode: null,
      }),
    );
  }

  #completeFailure(
    state: ActiveRequest,
    invocationId: string,
    failure: ProviderFailure,
    reportedModelId: string | null,
    usage: ProviderUsage,
    latencyMs: number,
    completedAt: string,
  ): void {
    const status = failure.publicError.code === 'PROVIDER_CANCELLED' ? 'cancelled' : 'failed';
    const errorCode = failure.publicError.code as ProviderErrorCode;
    this.#complete(
      state,
      invocationId,
      Object.freeze({
        status,
        reportedModelId,
        responseSha256: null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        latencyMs,
        completedAt,
        errorCode,
      }),
    );
  }

  #complete(
    state: ActiveRequest,
    invocationId: string,
    completion: ProviderInvocationCompletion,
  ): void {
    try {
      this.#invocations.complete(invocationId, 0, completion);
      state.invocationId = null;
    } catch (error) {
      if (
        state.suppressStaleAfterShutdown &&
        AppError.isTrusted(error) &&
        error.code === 'STALE_WRITE'
      ) {
        state.invocationId = null;
        return;
      }
      throw error;
    }
  }

  async #refreshDiagnostic<Output extends JsonValue>(
    diagnostic: ProviderDiagnostic,
    execution: ProviderExecution<Output>,
    latencyMs: number,
  ): Promise<void> {
    await this.#updateDiagnostic(
      diagnostic,
      Object.freeze({
        ...diagnostic,
        status: 'ready',
        reportedModelId: execution.reportedModelId,
        checkedAt: execution.completedAt,
        latencyMs,
        errorCode: null,
        revision: diagnostic.revision + 1,
      }) as ProviderDiagnostic,
    );
  }

  async #lowerDiagnostic(diagnostic: ProviderDiagnostic, code: ProviderErrorCode): Promise<void> {
    const status = terminalStatusFor(code);
    if (status === null) return;
    await this.#updateDiagnostic(
      diagnostic,
      Object.freeze({
        ...diagnostic,
        status,
        checkedAt: this.#clock(),
        latencyMs: null,
        errorCode: code,
        revision: diagnostic.revision + 1,
      }) as ProviderDiagnostic,
    );
  }

  async #updateDiagnostic(current: ProviderDiagnostic, next: ProviderDiagnostic): Promise<void> {
    try {
      this.#diagnostics.upsert(next, current.revision);
    } catch (error) {
      if (AppError.isTrusted(error) && error.code === 'STALE_WRITE') return;
      throw error;
    }
  }

  #cancelSelected(state: ActiveRequest): void {
    if (!state.acquired || state.cancelRequested || state.adapter === null) return;
    state.cancelRequested = true;
    state.adapter.cancel(state.requestId);
  }

  async #finishShutdown(snapshot: readonly ActiveRequest[]): Promise<void> {
    const completions = snapshot
      .map((state) => state.completion)
      .filter(
        (completion): completion is Promise<ProviderExecution<JsonValue>> => completion !== null,
      );
    await new Promise<void>((resolveDrain, rejectDrain) => {
      const timer = setTimeout(() => rejectDrain(providerError('PROVIDER_CANCELLED')), 10_000);
      void Promise.allSettled(completions).then(() => {
        clearTimeout(timer);
        resolveDrain();
      });
    });
  }
}
