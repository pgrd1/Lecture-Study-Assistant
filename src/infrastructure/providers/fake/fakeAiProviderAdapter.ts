import type {
  AiProviderAdapter,
  ProviderConnectionOperation,
  ProviderExecution,
  ProviderInspection,
  ProviderProbeEvidence,
  ProviderRequest,
} from '../../../core/ports/aiProvider';
import { freezeJsonCopy } from '../../../core/providers/canonicalJson';
import {
  type AiProviderId,
  type JsonValue,
  type ProviderModel,
  parseSafeSemVer,
} from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError, type ProviderErrorCode } from '../../../shared/errors';

export type FakeProviderCall = Readonly<{
  requestId: string;
  feature: ProviderRequest<JsonValue>['feature'];
  jobId: string | null;
  modelId: string | null;
  promptVersion: string;
  routeRevision: number;
  outputSchemaId: string;
  attemptKind: ProviderRequest<JsonValue>['attemptKind'];
  blockKinds: readonly ProviderRequest<JsonValue>['blocks'][number]['kind'][];
}>;

type Outcome =
  | Readonly<{ kind: 'execution'; execution: ProviderExecution<JsonValue> }>
  | Readonly<{ kind: 'failure'; error: AppError }>
  | Readonly<{ kind: 'hold'; cancelable: boolean }>;

type Held = Readonly<{
  requestId: string;
  cancelable: boolean;
  resolve: (execution: ProviderExecution<JsonValue>) => void;
  reject: (error: AppError) => void;
}>;

const defaultExecution = (): ProviderExecution<Readonly<{ ok: true }>> =>
  Object.freeze({
    output: Object.freeze({ ok: true }),
    reportedModelId: null,
    usage: Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null }),
    completedAt: new Date().toISOString(),
  });

const snapshotExecution = <Output extends JsonValue>(
  execution: ProviderExecution<Output>,
): ProviderExecution<Output> =>
  Object.freeze({
    ...execution,
    output: freezeJsonCopy(execution.output) as Output,
    usage: Object.freeze({ ...execution.usage }),
  });

export class FakeAiProviderAdapter<Id extends AiProviderId> {
  readonly id: Id;
  #activeCalls = 0;
  #calls: readonly FakeProviderCall[] = Object.freeze([]);
  #cancelledRequestIds: readonly string[] = Object.freeze([]);
  #held: readonly Held[] = Object.freeze([]);
  #outcomes: readonly Outcome[] = Object.freeze([]);

  constructor(id: Id) {
    this.id = id;
  }

  get activeCalls(): number {
    return this.#activeCalls;
  }

  get calls(): readonly FakeProviderCall[] {
    return Object.freeze([...this.#calls]);
  }

  get cancelledRequestIds(): readonly string[] {
    return Object.freeze([...this.#cancelledRequestIds]);
  }

  queueExecution<Output extends JsonValue>(execution: ProviderExecution<Output>): void {
    const queuedExecution = snapshotExecution(execution) as ProviderExecution<JsonValue>;
    this.#outcomes = Object.freeze([
      ...this.#outcomes,
      Object.freeze({ kind: 'execution', execution: queuedExecution }),
    ]);
  }

  queueResult<Output extends JsonValue>(output: Output): void {
    this.queueExecution(Object.freeze({ ...defaultExecution(), output }));
  }

  queueFailure(code: ProviderErrorCode): void {
    this.#outcomes = Object.freeze([
      ...this.#outcomes,
      Object.freeze({ kind: 'failure', error: new AppError(code, APP_ERROR_MESSAGES[code]) }),
    ]);
  }

  holdNextCall(): void {
    this.#outcomes = Object.freeze([
      ...this.#outcomes,
      Object.freeze({ kind: 'hold', cancelable: true }),
    ]);
  }

  holdNextCallIgnoringCancellation(): void {
    this.#outcomes = Object.freeze([
      ...this.#outcomes,
      Object.freeze({ kind: 'hold', cancelable: false }),
    ]);
  }

  release<Output extends JsonValue>(execution: ProviderExecution<Output>): void {
    const held = this.#held[0];
    if (held === undefined) throw new TypeError('NO_HELD_PROVIDER_CALL');
    this.#held = Object.freeze(this.#held.slice(1));
    held.resolve(snapshotExecution(execution) as ProviderExecution<JsonValue>);
  }

  async inspect(operation: ProviderConnectionOperation): Promise<ProviderInspection<Id>> {
    this.#assertConnectionActive(operation);
    if (this.id.endsWith('_api')) {
      return Object.freeze({
        status: 'ready',
        version: null,
        credentialPresent: true,
        credentialScope: 'not_applicable',
        cliBinding: null,
        providerManagedHistory: false,
      }) as ProviderInspection<Id>;
    }
    const version = parseSafeSemVer('1.0.0');
    return Object.freeze({
      status: 'ready',
      version,
      credentialPresent: true,
      credentialScope: 'profile_scoped',
      cliBinding: Object.freeze({
        providerId: this.id,
        canonicalLauncherPath: `C:\\fake\\${this.id}.exe`,
        canonicalEntryPath: null,
        canonicalPackageManifestPath: null,
        canonicalPlatformPackageManifestPath: null,
        fixedPrefixArgs: Object.freeze([]),
        version,
        launcherSha256: 'a'.repeat(64),
        entrySha256: null,
        packageManifestSha256: null,
        platformPackageManifestSha256: null,
        bindingSha256: 'b'.repeat(64),
        recipeId: 'fake-test-only',
        credentialScope: 'profile_scoped',
        signerClassification: 'nodejs',
        checkedAt: new Date().toISOString(),
      }),
      providerManagedHistory: false,
    }) as unknown as ProviderInspection<Id>;
  }

  async listModels(operation: ProviderConnectionOperation): Promise<readonly ProviderModel[]> {
    this.#assertConnectionActive(operation);
    return Object.freeze([]);
  }

  async probe(
    _modelId: string | null,
    operation: ProviderConnectionOperation,
  ): Promise<ProviderProbeEvidence> {
    this.#assertConnectionActive(operation);
    return Object.freeze({
      status: 'ready',
      reportedModelId: null,
      latencyMs: 0,
      usage: Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null }),
      providerManagedHistory: false,
    });
  }

  async execute<Output extends JsonValue>(
    request: ProviderRequest<Output>,
  ): Promise<ProviderExecution<Output>> {
    this.#calls = Object.freeze([
      ...this.#calls,
      Object.freeze({
        requestId: request.requestId,
        feature: request.feature,
        jobId: request.jobId,
        modelId: request.modelId,
        promptVersion: request.promptVersion,
        routeRevision: request.routeRevision,
        outputSchemaId: request.outputSchemaId,
        attemptKind: request.attemptKind,
        blockKinds: Object.freeze(request.blocks.map((block) => block.kind)),
      }),
    ]);
    const outcome =
      this.#outcomes[0] ?? Object.freeze({ kind: 'execution', execution: defaultExecution() });
    this.#outcomes = Object.freeze(this.#outcomes.slice(1));
    this.#activeCalls += 1;
    try {
      if (outcome.kind === 'failure') throw outcome.error;
      if (outcome.kind === 'execution') return outcome.execution as ProviderExecution<Output>;
      return (await new Promise<ProviderExecution<JsonValue>>((resolve, reject) => {
        this.#held = Object.freeze([
          ...this.#held,
          Object.freeze({
            requestId: request.requestId,
            cancelable: outcome.cancelable,
            resolve,
            reject,
          }),
        ]);
      })) as ProviderExecution<Output>;
    } finally {
      this.#activeCalls -= 1;
    }
  }

  cancel(requestId: string): void {
    this.#cancelledRequestIds = Object.freeze([...this.#cancelledRequestIds, requestId]);
    const held = this.#held.find((entry) => entry.requestId === requestId);
    if (held === undefined || !held.cancelable) return;
    this.#held = Object.freeze(this.#held.filter((entry) => entry !== held));
    held.reject(new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED));
  }

  #assertConnectionActive(operation: ProviderConnectionOperation): void {
    if (operation.signal.aborted) {
      throw new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED);
    }
  }
}

const _contractCheck = <Id extends AiProviderId>(
  adapter: FakeAiProviderAdapter<Id>,
): AiProviderAdapter<Id> => adapter as unknown as AiProviderAdapter<Id>;
void _contractCheck;
