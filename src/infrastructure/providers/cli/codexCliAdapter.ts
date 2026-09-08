import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import type {
  AiProviderAdapter,
  CliRuntimeBinding,
  ProviderConnectionOperation,
  ProviderExecution,
  ProviderInspection,
  ProviderProbeEvidence,
  ProviderRequest,
} from '../../../core/ports/aiProvider';
import type { CliProcessResult, CliProcessRunner } from '../../../core/ports/cliProcessRunner';
import { ProviderProbeOutputSchema } from '../../../core/providers/providerProbe';
import type { JsonValue, ProviderModel } from '../../../shared/contracts/provider';
import {
  ProviderSourceMaterializer,
  type ProviderSourceMaterializerPort,
} from '../providerSourceMaterializer';
import { runCliArtifactValidation } from './cliArtifactValidation';
import type { CliCredentialGuard, CliCredentialInspection } from './cliCredentialGuard';
import type { CliExecutableInspector } from './cliExecutableInspector';
import { runCliCleanupWithinDeadline } from './cliFileIntegrity';
import { selectCliProviderFailure } from './cliProviderFailurePrecedence';
import { type CodexImageInput, preflightCodexMedia, prepareCodexImages } from './codexCliMedia';
import {
  assertCodexArtifacts,
  assertCodexBinding,
  assertCodexCapabilitySuccess,
  assertCodexDefaultModel,
  assertCodexProfileFiles,
  assertCodexProfileScopedRequest,
  assertCodexRoots,
  assertCodexSuccess,
  buildCodexCapabilityHelpArgs,
  buildCodexFeatureListArgs,
  buildCodexMainArgs,
  buildCodexProbePrompt,
  buildCodexPrompt,
  CODEX_MAX_JSONL_BYTES,
  CODEX_UUID_PATTERN,
  type CodexArtifactRoots,
  type CodexBinding,
  type CodexManagedProfile,
  type CodexRequestArtifacts,
  codexCapabilityHash,
  codexError,
  createCodexManagedProfile,
  isCodexProviderError,
  parseCodexExecHelp,
  parseCodexFeatureList,
  parseCodexJsonl,
  readCodexCredentialStatus,
  sanitizeCodexFailure,
} from './codexCliProtocol';
import {
  assertCodexAliasLease,
  assertCodexImageManifest,
  codexMilliseconds,
  codexModelChoices,
  codexTimestamp,
  snapshotCodexOperation,
} from './codexCliRequest';
import type { CodexCredentialStatusInspector } from './codexCredentialStatus';
import type { CodexManagedArtifacts } from './codexManagedArtifacts';
import {
  sameCliRuntimeBindingIdentity,
  type WindowsWorkspaceAlias,
  type WindowsWorkspaceAliasLease,
} from './windowsWorkspaceAlias';

export {
  CODEX_CONFIG_OVERRIDES,
  CODEX_DISABLE_ARGS,
  CODEX_DISABLED_FEATURES,
  CODEX_PROBE_PROMPT,
  type CodexManagedProfile,
} from './codexCliProtocol';
export type { CodexManagedArtifacts } from './codexManagedArtifacts';

const CAPABILITY_TIMEOUT_MS = 15_000;
const CAPABILITY_OUTPUT_LIMIT_BYTES = 256 * 1024;
const STDERR_LIMIT_BYTES = 16 * 1024;
const CLEANUP_TIMEOUT_MS = 15_000;
export type CodexCliAdapterOptions = Readonly<{
  inspector: CliExecutableInspector;
  loadBinding: () => CliRuntimeBinding<'codex_cli', 'profile_scoped'> | null;
  createRunner: (binding: CodexBinding) => CliProcessRunner;
  aliases: WindowsWorkspaceAlias;
  artifacts: CodexManagedArtifacts;
  providerRuntimeRoot: string;
  credentialGuard: CliCredentialGuard;
  credentialStatusInspector: CodexCredentialStatusInspector;
  now: () => string;
  nowMilliseconds: () => number;
  materializer?: ProviderSourceMaterializerPort;
}>;
type ActiveOperation = Readonly<{
  requestId: string;
  sourceSignal: AbortSignal;
  signal: AbortSignal;
  cancelled: AbortController;
  runners: Map<string, CliProcessRunner>;
  onAbort: () => void;
}>;
const createCleanupOperation = (): ProviderConnectionOperation =>
  Object.freeze({ requestId: randomUUID(), signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });

type BracketOutcome<T> =
  | Readonly<{ kind: 'success'; value: T }>
  | Readonly<{ kind: 'failure'; error: unknown }>;
class CodexCliAdapter implements AiProviderAdapter<'codex_cli'> {
  readonly id = 'codex_cli' as const;
  readonly #options: CodexCliAdapterOptions;
  readonly #roots: CodexArtifactRoots;
  readonly #profile: CodexManagedProfile;
  readonly #active = new Map<string, ActiveOperation>();
  constructor(options: CodexCliAdapterOptions) {
    this.#options = options;
    this.#roots = assertCodexRoots(options.providerRuntimeRoot);
    this.#profile = createCodexManagedProfile(this.#roots);
  }
  async inspect(operation: ProviderConnectionOperation): Promise<ProviderInspection<'codex_cli'>> {
    let active: ActiveOperation | undefined;
    try {
      active = this.#beginOperation(operation.requestId, operation.signal);
      const binding = assertCodexBinding(
        await this.#options.inspector.inspect('codex_cli', this.#connectionOperation(active)),
      );
      this.#assertActive(active);
      return await this.#bracketOperation(
        binding,
        async (inspection, current) =>
          Object.freeze({
            status: inspection.status === 'present' ? 'credential_saved' : 'installed',
            version: current.version,
            credentialPresent: inspection.status === 'present',
            credentialScope: 'profile_scoped' as const,
            cliBinding: current,
            providerManagedHistory: false as const,
          }),
        active,
      );
    } catch (error) {
      throw sanitizeCodexFailure(error);
    } finally {
      if (active !== undefined) this.#finishOperation(active);
    }
  }

  async listModels(operation: ProviderConnectionOperation): Promise<readonly ProviderModel[]> {
    this.#assertConnectionOperation(operation);
    const models = codexModelChoices();
    this.#assertConnectionOperation(operation);
    return models;
  }

  async probe(
    modelId: string | null,
    operation: ProviderConnectionOperation,
  ): Promise<ProviderProbeEvidence> {
    let active: ActiveOperation | undefined;
    try {
      const currentActive = this.#beginOperation(operation.requestId, operation.signal);
      active = currentActive;
      assertCodexDefaultModel(modelId);
      const startedAt = codexMilliseconds(this.#options.nowMilliseconds());
      const binding = await this.#currentBinding(currentActive);
      this.#assertActive(currentActive);
      return await this.#bracketOperation(
        binding,
        async (inspection, current, lease) => {
          if (inspection.status !== 'present') throw codexError('PROVIDER_AUTH_REQUIRED');
          const parsed = await this.#executeModel(
            current,
            operation.requestId,
            buildCodexProbePrompt(),
            JSON.stringify({
              type: 'object',
              additionalProperties: false,
              required: ['ok'],
              properties: { ok: { const: true } },
            }),
            (value) => ProviderProbeOutputSchema.parse(value),
            120_000,
            currentActive,
            lease,
            modelId,
          );
          this.#assertActive(currentActive);
          return Object.freeze({
            status: 'ready' as const,
            reportedModelId: parsed.reportedModelId,
            latencyMs: Math.max(
              0,
              Math.trunc(codexMilliseconds(this.#options.nowMilliseconds()) - startedAt),
            ),
            usage: Object.freeze({ ...parsed.usage }),
            providerManagedHistory: false as const,
          });
        },
        currentActive,
      );
    } catch (error) {
      throw sanitizeCodexFailure(error);
    } finally {
      if (active !== undefined) this.#finishOperation(active);
    }
  }

  async execute<Output extends JsonValue>(
    request: ProviderRequest<Output>,
  ): Promise<ProviderExecution<Output>> {
    if (request.signal.aborted) throw codexError('PROVIDER_CANCELLED');
    assertCodexProfileScopedRequest(request);
    assertCodexDefaultModel(request.modelId);
    const snapshot = snapshotCodexOperation(request);
    const modelId = request.modelId;
    const media = preflightCodexMedia(
      modelId,
      snapshot.blocks,
      snapshot.outputJsonSchema,
      snapshot.maxOutputTokens,
    );
    const active = this.#beginOperation(request.requestId, request.signal);
    try {
      const binding = await this.#currentBinding(active);
      this.#assertActive(active);
      return await this.#bracketOperation(
        binding,
        async (inspection, current, lease) => {
          if (inspection.status !== 'present') throw codexError('PROVIDER_AUTH_REQUIRED');
          const images = await prepareCodexImages(
            request.requestId,
            media.files,
            active.signal,
            this.#options.materializer ??
              new ProviderSourceMaterializer(`${this.#roots.providerTempRoot}\\image-staging`),
          );
          const schemaJson = JSON.stringify(snapshot.outputJsonSchema);
          const parsed = await this.#executeModel(
            current,
            request.requestId,
            buildCodexPrompt(media.text, snapshot.outputJsonSchema),
            schemaJson,
            snapshot.parseOutput,
            snapshot.timeoutMs,
            active,
            lease,
            modelId,
            images,
          );
          this.#assertActive(active);
          return Object.freeze({
            output: parsed.output,
            reportedModelId: parsed.reportedModelId,
            usage: Object.freeze({ ...parsed.usage }),
            completedAt: codexTimestamp(this.#options.now()),
          });
        },
        active,
      );
    } catch (error) {
      throw sanitizeCodexFailure(error);
    } finally {
      this.#finishOperation(active);
    }
  }

  cancel(requestId: string): void {
    const active = this.#active.get(requestId);
    if (active !== undefined) this.#cancelOperation(active);
  }
  #beginOperation(requestId: string, signal: AbortSignal): ActiveOperation {
    if (
      !CODEX_UUID_PATTERN.test(requestId) ||
      !(signal instanceof AbortSignal) ||
      this.#active.has(requestId)
    ) {
      throw codexError('PROVIDER_EXECUTION_FAILED');
    }
    const cancelled = new AbortController();
    let active: ActiveOperation;
    const onAbort = () => this.#cancelOperation(active);
    active = Object.freeze({
      requestId,
      sourceSignal: signal,
      signal: cancelled.signal,
      cancelled,
      runners: new Map<string, CliProcessRunner>(),
      onAbort,
    });
    this.#active.set(requestId, active);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      this.#cancelOperation(active);
      this.#finishOperation(active);
      throw codexError('PROVIDER_CANCELLED');
    }
    return active;
  }
  #cancelOperation(active: ActiveOperation): void {
    if (active.cancelled.signal.aborted) return;
    active.cancelled.abort();
    for (const [requestId, runner] of [...active.runners]) {
      try {
        runner.cancel(requestId);
      } catch {
        // The operation remains cancelled even if the process adapter rejects cancellation.
      }
    }
  }
  #finishOperation(active: ActiveOperation): void {
    active.sourceSignal.removeEventListener('abort', active.onAbort);
    if (this.#active.get(active.requestId) === active) this.#active.delete(active.requestId);
    active.runners.clear();
  }
  #assertActive(active?: ActiveOperation, failure?: unknown): void {
    if (active === undefined) return;
    if (active.sourceSignal.aborted && !active.cancelled.signal.aborted) {
      this.#cancelOperation(active);
    }
    if (active.cancelled.signal.aborted)
      throw selectCliProviderFailure(failure, codexError('PROVIDER_CANCELLED'));
  }

  #assertConnectionOperation(operation: ProviderConnectionOperation): void {
    if (
      !CODEX_UUID_PATTERN.test(operation.requestId) ||
      !(operation.signal instanceof AbortSignal)
    ) {
      throw codexError('PROVIDER_EXECUTION_FAILED');
    }
    if (operation.signal.aborted) throw codexError('PROVIDER_CANCELLED');
  }
  #connectionOperation(active: ActiveOperation): ProviderConnectionOperation {
    return Object.freeze({ requestId: active.requestId, signal: active.signal });
  }
  async #currentBinding(active: ActiveOperation): Promise<CodexBinding> {
    const stored = this.#options.loadBinding();
    if (stored === null) throw codexError('PROVIDER_NOT_READY');
    return this.#revalidate(assertCodexBinding(stored), this.#connectionOperation(active));
  }
  async #revalidate(
    binding: CodexBinding,
    operation: ProviderConnectionOperation,
  ): Promise<CodexBinding> {
    try {
      const current = assertCodexBinding(
        await this.#options.inspector.revalidate(binding, operation),
      );
      if (!sameCliRuntimeBindingIdentity(current, binding)) {
        throw codexError('PROVIDER_CLI_CHANGED');
      }
      return current;
    } catch {
      if (operation.signal.aborted) throw codexError('PROVIDER_CANCELLED');
      throw codexError('PROVIDER_CLI_CHANGED');
    }
  }
  async #bracketOperation<T>(
    binding: CodexBinding,
    operation: (
      inspection: CliCredentialInspection,
      binding: CodexBinding,
      lease: WindowsWorkspaceAliasLease,
    ) => Promise<T>,
    active: ActiveOperation,
  ): Promise<T> {
    const userOperation = this.#connectionOperation(active);
    let lease: WindowsWorkspaceAliasLease | null = null;
    let leaseVerified = false;
    let capabilityHash: string | null = null;
    let initialInspection: CliCredentialInspection | null = null;
    let outcome: BracketOutcome<T>;
    try {
      this.#assertActive(active);
      lease = await this.#options.aliases.acquire(binding, userOperation);
      this.#assertActive(active);
      assertCodexAliasLease(binding, lease);
      await this.#revalidateLease(lease, userOperation);
      leaseVerified = true;
      const current = await this.#withVerifiedLease(lease, userOperation, () =>
        this.#revalidate(binding, userOperation),
      );
      await this.#prepareAndVerifyProfile(lease, userOperation);
      capabilityHash = await this.#inspectCapabilities(current, userOperation, lease, active);
      const inspection = await this.#inspectCredential(current, lease, userOperation);
      initialInspection = inspection;
      this.#assertActive(active);
      outcome = Object.freeze({
        kind: 'success',
        value: await operation(inspection, current, lease),
      });
    } catch (error) {
      outcome = Object.freeze({ kind: 'failure', error });
    }

    let finalFailure: unknown = outcome.kind === 'failure' ? outcome.error : undefined;
    const cleanupOperation = createCleanupOperation();
    try {
      await runCliCleanupWithinDeadline(cleanupOperation, async () => {
        if (lease !== null && leaseVerified) {
          try {
            await this.#withVerifiedLease(lease, cleanupOperation, () =>
              this.#options.artifacts.cleanupProfileTransients(),
            );
          } catch {
            finalFailure = selectCliProviderFailure(
              finalFailure,
              codexError('PROVIDER_RESIDUAL_DATA'),
            );
          }
          try {
            await this.#withVerifiedLease(lease, cleanupOperation, () =>
              this.#options.artifacts.verifyProfile(this.#profile, cleanupOperation),
            );
            const finalInspection = await this.#inspectCredential(binding, lease, cleanupOperation);
            if (initialInspection !== null && finalInspection.status !== initialInspection.status) {
              finalFailure = selectCliProviderFailure(
                finalFailure,
                codexError(
                  finalInspection.status === 'absent'
                    ? 'PROVIDER_AUTH_REQUIRED'
                    : 'PROVIDER_UNSAFE_VERSION',
                ),
              );
            } else if (
              initialInspection !== null &&
              finalInspection.backend !== initialInspection.backend
            ) {
              finalFailure = selectCliProviderFailure(
                finalFailure,
                codexError('PROVIDER_UNSAFE_VERSION'),
              );
            }
          } catch (error) {
            finalFailure = selectCliProviderFailure(finalFailure, error);
          }
          try {
            const finalHash = await this.#inspectCapabilities(binding, cleanupOperation, lease);
            if (capabilityHash !== null && finalHash !== capabilityHash) {
              finalFailure = selectCliProviderFailure(
                finalFailure,
                codexError('PROVIDER_UNSAFE_VERSION'),
              );
            }
          } catch (error) {
            finalFailure = selectCliProviderFailure(finalFailure, error);
          }
          try {
            await this.#withVerifiedLease(lease, cleanupOperation, () =>
              this.#revalidate(binding, cleanupOperation),
            );
          } catch (error) {
            finalFailure = selectCliProviderFailure(finalFailure, error);
          }
        } else {
          try {
            await this.#revalidate(binding, cleanupOperation);
          } catch (error) {
            finalFailure = selectCliProviderFailure(finalFailure, error);
          }
        }
      });
    } catch {
      finalFailure = selectCliProviderFailure(finalFailure, codexError('PROVIDER_RESIDUAL_DATA'));
    }
    if (lease !== null) {
      try {
        await lease.release();
      } catch {
        finalFailure = selectCliProviderFailure(finalFailure, codexError('PROVIDER_RESIDUAL_DATA'));
      }
    }
    if (finalFailure !== undefined) throw finalFailure;
    if (outcome.kind === 'failure') throw outcome.error;
    return outcome.value;
  }
  async #revalidateLease(
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    try {
      await lease.revalidate(operation);
    } catch {
      if (operation.signal.aborted) throw codexError('PROVIDER_CANCELLED');
      throw codexError('PROVIDER_RESIDUAL_DATA');
    }
  }

  async #withVerifiedLease<T>(
    lease: WindowsWorkspaceAliasLease,
    connectionOperation: ProviderConnectionOperation,
    action: () => T | Promise<T>,
  ): Promise<T> {
    await this.#revalidateLease(lease, connectionOperation);
    let outcome: BracketOutcome<T>;
    try {
      outcome = Object.freeze({ kind: 'success', value: await action() });
    } catch (error) {
      outcome = Object.freeze({ kind: 'failure', error });
    }
    try {
      await this.#revalidateLease(lease, connectionOperation);
    } catch (error) {
      throw selectCliProviderFailure(outcome.kind === 'failure' ? outcome.error : undefined, error);
    }
    if (outcome.kind === 'failure') throw outcome.error;
    return outcome.value;
  }

  async #prepareAndVerifyProfile(
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    try {
      await this.#withVerifiedLease(lease, operation, () =>
        this.#options.artifacts.prepareProfileAtomic(this.#profile, operation),
      );
      await this.#withVerifiedLease(lease, operation, () =>
        this.#options.artifacts.verifyProfile(this.#profile, operation),
      );
    } catch (error) {
      if (isCodexProviderError(error)) throw error;
      throw codexError('PROVIDER_UNSAFE_VERSION');
    }
  }

  async #inspectCredential(
    binding: CodexBinding,
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<CliCredentialInspection> {
    const status = readCodexCredentialStatus(
      Object.freeze({
        managedProfilePath: lease.profileRoot,
        evidence: await this.#withVerifiedLease(lease, operation, () =>
          this.#options.credentialStatusInspector.inspect(binding, lease.profileRoot, operation),
        ),
      }),
      lease.profileRoot,
    );
    if (
      status.evidence.backend !== 'windows_credential_manager' ||
      (status.evidence.status !== 'present' && status.evidence.status !== 'absent') ||
      status.evidence.resolvedProfilePath !== null
    ) {
      throw codexError('PROVIDER_UNSAFE_VERSION');
    }
    const inspection = await this.#withVerifiedLease(lease, operation, () =>
      this.#options.credentialGuard.inspect(
        Object.freeze({
          binding,
          managedProfilePath: status.managedProfilePath,
          evidence: status.evidence,
        }),
        operation,
      ),
    );
    if (
      inspection.scope !== 'profile_scoped' ||
      inspection.providerManagedHistory ||
      inspection.backend !== 'windows_credential_manager' ||
      inspection.status !== status.evidence.status
    ) {
      throw codexError('PROVIDER_UNSAFE_VERSION');
    }
    assertCodexProfileFiles(inspection.observedFileNames);
    return inspection;
  }

  async #inspectCapabilities(
    binding: CodexBinding,
    operation: ProviderConnectionOperation,
    lease: WindowsWorkspaceAliasLease,
    active?: ActiveOperation,
  ): Promise<string> {
    const help = await this.#runProcess(
      binding,
      operation,
      buildCodexCapabilityHelpArgs(),
      '',
      CAPABILITY_TIMEOUT_MS,
      CAPABILITY_OUTPUT_LIMIT_BYTES,
      active,
      lease,
    );
    assertCodexCapabilitySuccess(help);
    const helpFlags = parseCodexExecHelp(help.stdout);
    const features = await this.#runProcess(
      binding,
      operation,
      buildCodexFeatureListArgs(),
      '',
      CAPABILITY_TIMEOUT_MS,
      CAPABILITY_OUTPUT_LIMIT_BYTES,
      active,
      lease,
    );
    assertCodexCapabilitySuccess(features);
    return codexCapabilityHash(helpFlags, parseCodexFeatureList(features.stdout));
  }

  async #executeModel<Output extends JsonValue>(
    binding: CodexBinding,
    requestId: string,
    stdin: string,
    schemaJson: string,
    parseOutput: (value: unknown) => Output,
    timeoutMs: number,
    active: ActiveOperation,
    lease: WindowsWorkspaceAliasLease,
    modelId: string | null = null,
    images: readonly CodexImageInput[] = [],
  ) {
    const result = await this.#runModel(
      binding,
      requestId,
      stdin,
      schemaJson,
      timeoutMs,
      active,
      lease,
      modelId,
      images,
    );
    assertCodexSuccess(result);
    return parseCodexJsonl(result.stdout, parseOutput);
  }

  async #runModel(
    binding: CodexBinding,
    requestId: string,
    stdin: string,
    schemaJson: string,
    timeoutMs: number,
    active: ActiveOperation,
    lease: WindowsWorkspaceAliasLease,
    modelId: string | null,
    images: readonly CodexImageInput[],
  ): Promise<CliProcessResult> {
    const operation = this.#connectionOperation(active);
    let prepared: CodexRequestArtifacts | null = null;
    let result: CliProcessResult | null = null;
    let failure: unknown;
    let cleanupFailed = false;
    try {
      prepared = await this.#prepareRequest(requestId, schemaJson, lease, operation, images);
      this.#assertActive(active);
      const current = prepared;
      result = await this.#runProcess(
        binding,
        operation,
        buildCodexMainArgs(current.workspacePath, current.schemaPath, modelId, current.images),
        stdin,
        timeoutMs,
        CODEX_MAX_JSONL_BYTES,
        active,
        lease,
        (signal) =>
          this.#withVerifiedLease(lease, Object.freeze({ requestId, signal }), () =>
            runCliArtifactValidation(signal, (activeSignal) =>
              this.#options.artifacts.verifyRequest(
                requestId,
                schemaJson,
                current.schemaSha256,
                Object.freeze({ requestId, signal: activeSignal }),
              ),
            ),
          ),
        () => this.#options.artifacts.cleanupRequest(requestId),
      );
      this.#assertActive(active);
    } catch (error) {
      failure = error;
    } finally {
      if (
        prepared !== null &&
        !(isCodexProviderError(failure) && failure.code === 'PROVIDER_RESIDUAL_DATA')
      ) {
        try {
          const cleanupOperation = createCleanupOperation();
          await runCliCleanupWithinDeadline(cleanupOperation, () =>
            this.#withVerifiedLease(lease, cleanupOperation, () =>
              this.#options.artifacts.cleanupRequest(requestId),
            ),
          );
        } catch {
          cleanupFailed = true;
        }
      }
    }
    if (cleanupFailed) throw codexError('PROVIDER_RESIDUAL_DATA');
    this.#assertActive(active, failure);
    if (failure !== undefined) throw sanitizeCodexFailure(failure);
    if (result === null) throw codexError('PROVIDER_EXECUTION_FAILED');
    return result;
  }

  async #prepareRequest(
    requestId: string,
    schemaJson: string,
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
    images: readonly CodexImageInput[],
  ): Promise<CodexRequestArtifacts> {
    if (!CODEX_UUID_PATTERN.test(requestId)) throw codexError('PROVIDER_EXECUTION_FAILED');
    let acquired = false;
    try {
      const prepared = await this.#withVerifiedLease(lease, operation, async () => {
        const result = await this.#options.artifacts.prepareRequestAtomic(
          requestId,
          schemaJson,
          operation,
          images,
        );
        acquired = true;
        return result;
      });
      assertCodexArtifacts(requestId, schemaJson, prepared, this.#roots);
      assertCodexImageManifest(requestId, images, prepared, this.#roots);
      await this.#withVerifiedLease(lease, operation, () =>
        runCliArtifactValidation(operation.signal, (activeSignal) =>
          this.#options.artifacts.verifyRequest(
            requestId,
            schemaJson,
            prepared.schemaSha256,
            Object.freeze({ requestId, signal: activeSignal }),
          ),
        ),
      );
      return prepared;
    } catch (error) {
      if (!acquired) throw sanitizeCodexFailure(error);
      try {
        const cleanupOperation = createCleanupOperation();
        await runCliCleanupWithinDeadline(cleanupOperation, () =>
          this.#withVerifiedLease(lease, cleanupOperation, () =>
            this.#options.artifacts.cleanupRequest(requestId),
          ),
        );
      } catch {
        throw codexError('PROVIDER_RESIDUAL_DATA');
      }
      if (isCodexProviderError(error)) throw error;
      throw codexError('PROVIDER_UNSAFE_VERSION');
    }
  }

  async #runProcess(
    binding: CodexBinding,
    operation: ProviderConnectionOperation,
    args: readonly string[],
    stdin: string,
    timeoutMs: number,
    stdoutLimitBytes: number,
    active: ActiveOperation | undefined,
    lease: WindowsWorkspaceAliasLease,
    postProcessValidation?: (signal: AbortSignal) => Promise<void>,
    requestCleanup?: (signal: AbortSignal) => Promise<void>,
  ): Promise<CliProcessResult> {
    this.#assertActive(active);
    const runner = this.#options.createRunner(binding);
    active?.runners.set(operation.requestId, runner);
    try {
      const result = await this.#withVerifiedLease(lease, operation, () =>
        runner.run(
          Object.freeze({
            requestId: operation.requestId,
            launcherPath: binding.canonicalLauncherPath,
            args,
            cwd: win32.join(this.#roots.providerWorkspaceRoot, operation.requestId),
            env: Object.freeze({}),
            stdin,
            timeoutMs,
            stdoutLimitBytes,
            stderrLimitBytes: STDERR_LIMIT_BYTES,
            ...(postProcessValidation === undefined ? {} : { postProcessValidation }),
            ...(requestCleanup === undefined ? {} : { requestCleanup }),
            signal: operation.signal,
            shell: false,
          }),
        ),
      );
      this.#assertActive(active);
      return result;
    } catch (error) {
      this.#assertActive(active, error);
      throw error;
    } finally {
      active?.runners.delete(operation.requestId);
    }
  }
}

export const createCodexCliAdapterForTest = (
  options: CodexCliAdapterOptions,
): AiProviderAdapter<'codex_cli'> => new CodexCliAdapter(options);

export const createCodexCliAdapter = createCodexCliAdapterForTest;
