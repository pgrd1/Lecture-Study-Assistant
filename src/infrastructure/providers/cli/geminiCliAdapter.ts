import { randomUUID } from 'node:crypto';
import type {
  AiProviderAdapter,
  CliRuntimeBinding,
  ProviderConnectionOperation,
  ProviderExecution,
  ProviderInspection,
  ProviderProbeEvidence,
  ProviderRequest,
} from '../../../core/ports/aiProvider';
import { requireTextBlocks } from '../../../core/ports/aiProvider';
import type { CliProcessResult, CliProcessRunner } from '../../../core/ports/cliProcessRunner';
import { ProviderProbeOutputSchema } from '../../../core/providers/providerProbe';
import {
  CLI_DEFAULT_MODEL_DISPLAY_NAMES,
  type JsonValue,
  type ProviderModel,
} from '../../../shared/contracts/provider';
import { runCliArtifactValidation } from './cliArtifactValidation';
import type { CliCredentialGuard, CliCredentialInspection } from './cliCredentialGuard';
import type { CliExecutableInspector } from './cliExecutableInspector';
import { runCliCleanupWithinDeadline } from './cliFileIntegrity';
import { selectCliProviderFailure } from './cliProviderFailurePrecedence';
import {
  assertGeminiArtifacts,
  assertGeminiBinding,
  assertGeminiConsent,
  assertGeminiExecuteConsent,
  assertGeminiModelId,
  assertGeminiRoots,
  assertGeminiSuccess,
  buildGeminiArgs,
  buildGeminiProbePrompt,
  buildGeminiPrompt,
  buildGeminiStdin,
  createGeminiManagedProfile,
  GEMINI_MAX_STREAM_BYTES,
  GEMINI_UUID_PATTERN,
  type GeminiArtifactRoots,
  type GeminiBinding,
  type GeminiManagedProfile,
  type GeminiRequestArtifacts,
  type GeminiSharedConsent,
  geminiError,
  isGeminiIsoTimestamp,
  isGeminiProviderError,
  parseGeminiStream,
  sanitizeGeminiFailure,
  validateGeminiSettingsSchema,
} from './geminiCliProtocol';
import type { GeminiManagedArtifacts } from './geminiManagedArtifacts';
import {
  GEMINI_ABSENT_CREDENTIAL_EVIDENCE,
  type GeminiCredentialEvidence,
  inspectGeminiCredentialProfile,
  inspectGeminiWindowsCredentialPresence,
  type WindowsCredentialPresence,
} from './windowsCredentialPresence';
import {
  sameCliRuntimeBindingIdentity,
  type WindowsWorkspaceAlias,
  type WindowsWorkspaceAliasLease,
} from './windowsWorkspaceAlias';

export {
  GEMINI_DENY_POLICY,
  GEMINI_MANAGED_SETTINGS_JSON,
  GEMINI_TOOL_DENIAL_CANARY_PROMPT,
  type GeminiManagedProfile,
  type GeminiSettingsSchemaSnapshot,
} from './geminiCliProtocol';
export type { GeminiManagedArtifacts } from './geminiManagedArtifacts';

export type GeminiCliAdapterOptions = Readonly<{
  inspector: CliExecutableInspector;
  loadBinding: () => CliRuntimeBinding<'gemini_cli', 'provider_global'> | null;
  createRunner: (binding: GeminiBinding) => CliProcessRunner;
  aliases: WindowsWorkspaceAlias;
  artifacts: GeminiManagedArtifacts;
  providerRuntimeRoot: string;
  credentialGuard: CliCredentialGuard;
  credentialPresence: WindowsCredentialPresence;
  sharedCredentialConsent: () => GeminiSharedConsent;
  now: () => string;
  nowMilliseconds: () => number;
}>;

type ActiveOperation = Readonly<{
  requestId: string;
  sourceSignal: AbortSignal;
  signal: AbortSignal;
  cancelled: AbortController;
  runners: Map<string, CliProcessRunner>;
  onAbort: () => void;
}>;

const CLEANUP_TIMEOUT_MS = 15_000 as const;
// Stock v0.55.1 can ignore supplemental admin policies, merges machine context,
// records sessions, and supplies no stream auth/tier evidence. Offline protocol
// compatibility cannot satisfy these independent release gates. No test bypass.
const assertGeminiRecipeReady = (): void => {
  throw geminiError('PROVIDER_UNSAFE_VERSION');
};
const createCleanupOperation = (): ProviderConnectionOperation =>
  Object.freeze({ requestId: randomUUID(), signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });

type BracketOutcome<T> =
  | Readonly<{ kind: 'success'; value: T }>
  | Readonly<{ kind: 'failure'; error: unknown }>;

export interface GeminiCliAdapterTestSurface extends AiProviderAdapter<'gemini_cli'> {
  fixedPolicyArgs(): readonly ['--admin-policy', string];
}

class GeminiCliAdapter implements GeminiCliAdapterTestSurface {
  readonly id = 'gemini_cli' as const;
  readonly #options: GeminiCliAdapterOptions;
  readonly #roots: GeminiArtifactRoots;
  readonly #profile: GeminiManagedProfile;
  readonly #active = new Map<string, ActiveOperation>();

  constructor(options: GeminiCliAdapterOptions) {
    this.#options = options;
    this.#roots = assertGeminiRoots(options.providerRuntimeRoot);
    this.#profile = createGeminiManagedProfile(this.#roots);
  }

  fixedPolicyArgs(): readonly ['--admin-policy', string] {
    return Object.freeze(['--admin-policy', this.#profile.policyPath]);
  }

  async inspect(operation: ProviderConnectionOperation): Promise<ProviderInspection<'gemini_cli'>> {
    let active: ActiveOperation | undefined;
    try {
      active = this.#beginOperation(operation.requestId, operation.signal);
      const binding = assertGeminiBinding(
        await this.#options.inspector.inspect('gemini_cli', this.#connectionOperation(active)),
      );
      this.#assertActive(active);
      return await this.#bracketOperation(
        binding,
        async (inspection, current) =>
          Object.freeze({
            status: inspection.status === 'present' ? 'credential_saved' : 'installed',
            version: current.version,
            credentialPresent: inspection.status === 'present',
            credentialScope: 'provider_global',
            cliBinding: current,
            providerManagedHistory: false,
          }),
        active,
      );
    } catch (error) {
      throw sanitizeGeminiFailure(error);
    } finally {
      if (active !== undefined) this.#finishOperation(active);
    }
  }

  async listModels(operation: ProviderConnectionOperation): Promise<readonly ProviderModel[]> {
    let active: ActiveOperation | undefined;
    try {
      active = this.#beginOperation(operation.requestId, operation.signal);
      assertGeminiConsent(this.#options.sharedCredentialConsent());
      const binding = await this.#currentBinding(active);
      return await this.#bracketOperation(
        binding,
        async (inspection) => {
          if (inspection.status !== 'present') throw geminiError('PROVIDER_AUTH_REQUIRED');
          return Object.freeze([
            Object.freeze({
              modelId: null,
              displayName: CLI_DEFAULT_MODEL_DISPLAY_NAMES.gemini_cli,
              compatibility: 'unverified' as const,
            }),
          ]);
        },
        active,
      );
    } catch (error) {
      throw sanitizeGeminiFailure(error);
    } finally {
      if (active !== undefined) this.#finishOperation(active);
    }
  }

  async probe(
    modelId: string | null,
    operation: ProviderConnectionOperation,
  ): Promise<ProviderProbeEvidence> {
    let active: ActiveOperation | undefined;
    try {
      const currentActive = this.#beginOperation(operation.requestId, operation.signal);
      active = currentActive;
      const selectedModelId = assertGeminiModelId(modelId);
      const startedAt = this.#safeMilliseconds();
      const binding = await this.#currentBinding(currentActive);
      this.#assertActive(currentActive);
      return await this.#bracketOperation(
        binding,
        async (inspection, _current, lease, credentialBaseline) => {
          if (inspection.status !== 'present') throw geminiError('PROVIDER_AUTH_REQUIRED');
          const parsed = await this.#executeModel(
            binding,
            operation.requestId,
            selectedModelId,
            buildGeminiProbePrompt(),
            (value) => ProviderProbeOutputSchema.parse(value),
            120_000,
            currentActive,
            lease,
            credentialBaseline,
          );
          this.#assertActive(currentActive);
          return Object.freeze({
            status: 'ready' as const,
            reportedModelId: parsed.reportedModelId,
            latencyMs: Math.max(0, Math.trunc(this.#safeMilliseconds() - startedAt)),
            usage: Object.freeze({ ...parsed.usage }),
            providerManagedHistory: false,
          });
        },
        currentActive,
      );
    } catch (error) {
      throw sanitizeGeminiFailure(error);
    } finally {
      if (active !== undefined) this.#finishOperation(active);
    }
  }

  async execute<Output extends JsonValue>(
    request: ProviderRequest<Output>,
  ): Promise<ProviderExecution<Output>> {
    const textBlocks = requireTextBlocks(request.blocks);
    if (request.signal.aborted) throw geminiError('PROVIDER_CANCELLED');
    assertGeminiExecuteConsent(request);
    const selectedModelId = assertGeminiModelId(request.modelId);
    const active = this.#beginOperation(request.requestId, request.signal);
    try {
      const binding = await this.#currentBinding(active);
      this.#assertActive(active);
      return await this.#bracketOperation(
        binding,
        async (inspection, _current, lease, credentialBaseline) => {
          if (inspection.status !== 'present') throw geminiError('PROVIDER_AUTH_REQUIRED');
          const parsed = await this.#executeModel(
            binding,
            request.requestId,
            selectedModelId,
            buildGeminiPrompt(textBlocks, request.outputJsonSchema),
            request.parseOutput,
            request.timeoutMs,
            active,
            lease,
            credentialBaseline,
          );
          this.#assertActive(active);
          return Object.freeze({
            output: parsed.output,
            reportedModelId: parsed.reportedModelId,
            usage: Object.freeze({ ...parsed.usage }),
            completedAt: this.#safeNow(),
          });
        },
        active,
      );
    } catch (error) {
      throw sanitizeGeminiFailure(error);
    } finally {
      this.#finishOperation(active);
    }
  }

  cancel(requestId: string): void {
    const active = this.#active.get(requestId);
    if (active === undefined) return;
    this.#cancelOperation(active);
  }

  #beginOperation(requestId: string, signal: AbortSignal): ActiveOperation {
    if (
      !GEMINI_UUID_PATTERN.test(requestId) ||
      !(signal instanceof AbortSignal) ||
      this.#active.has(requestId)
    ) {
      throw geminiError('PROVIDER_EXECUTION_FAILED');
    }
    if (signal.aborted) throw geminiError('PROVIDER_CANCELLED');
    assertGeminiRecipeReady();
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
      throw geminiError('PROVIDER_CANCELLED');
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
        // The cancellation scope remains closed even if a runner rejects cancellation.
      }
    }
  }

  #finishOperation(active: ActiveOperation): void {
    active.sourceSignal.removeEventListener('abort', active.onAbort);
    if (this.#active.get(active.requestId) === active) this.#active.delete(active.requestId);
    active.runners.clear();
  }

  #assertActive(active?: ActiveOperation): void {
    if (active === undefined) return;
    if (active.sourceSignal.aborted && !active.cancelled.signal.aborted) {
      this.#cancelOperation(active);
    }
    if (active.cancelled.signal.aborted) throw geminiError('PROVIDER_CANCELLED');
  }

  #connectionOperation(active: ActiveOperation): ProviderConnectionOperation {
    return Object.freeze({ requestId: active.requestId, signal: active.signal });
  }

  async #currentBinding(active: ActiveOperation): Promise<GeminiBinding> {
    const stored = this.#options.loadBinding();
    if (stored === null) throw geminiError('PROVIDER_NOT_READY');
    return this.#revalidate(assertGeminiBinding(stored), this.#connectionOperation(active));
  }

  async #revalidate(
    binding: GeminiBinding,
    operation: ProviderConnectionOperation,
  ): Promise<GeminiBinding> {
    try {
      const current = assertGeminiBinding(
        await this.#options.inspector.revalidate(binding, operation),
      );
      if (!sameCliRuntimeBindingIdentity(current, binding)) {
        throw geminiError('PROVIDER_CLI_CHANGED');
      }
      return current;
    } catch {
      if (operation.signal.aborted) throw geminiError('PROVIDER_CANCELLED');
      throw geminiError('PROVIDER_CLI_CHANGED');
    }
  }

  async #bracketOperation<T>(
    binding: GeminiBinding,
    operation: (
      inspection: CliCredentialInspection,
      binding: GeminiBinding,
      lease: WindowsWorkspaceAliasLease,
      credentialEvidence: GeminiCredentialEvidence,
    ) => Promise<T>,
    active: ActiveOperation,
  ): Promise<T> {
    const userOperation = this.#connectionOperation(active);
    let lease: WindowsWorkspaceAliasLease | null = null;
    let leaseVerified = false;
    let schemaSha256: string | null = null;
    let credentialBaselineClean = false;
    let credentialEvidence: GeminiCredentialEvidence | null = null;
    let outcome: BracketOutcome<T>;
    try {
      this.#assertActive(active);
      lease = await this.#options.aliases.acquire(binding, userOperation);
      this.#assertActive(active);
      this.#assertAliasLease(binding, lease);
      await this.#revalidateLease(lease, userOperation);
      leaseVerified = true;
      const current = await this.#withVerifiedLease(lease, userOperation, () =>
        this.#revalidate(binding, userOperation),
      );
      schemaSha256 = await this.#currentSchemaHash(current, lease, userOperation);
      await this.#writeAndVerifyProfile(current, schemaSha256, lease, userOperation);
      const cleanInspection = await this.#scanCredentialProfile(
        current,
        lease,
        userOperation,
        GEMINI_ABSENT_CREDENTIAL_EVIDENCE,
      );
      credentialBaselineClean = true;
      credentialEvidence = await this.#inspectWindowsCredentialPresence(lease, userOperation);
      const inspection = Object.freeze({ ...cleanInspection, status: credentialEvidence.status });
      this.#assertActive(active);
      outcome = Object.freeze({
        kind: 'success',
        value: await operation(inspection, current, lease, credentialEvidence),
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
            const evidence = credentialEvidence ?? GEMINI_ABSENT_CREDENTIAL_EVIDENCE;
            await this.#scanCredentialProfile(binding, lease, cleanupOperation, evidence);
          } catch (error) {
            finalFailure = selectCliProviderFailure(
              finalFailure,
              credentialBaselineClean ? geminiError('PROVIDER_RESIDUAL_DATA') : error,
            );
          }
          try {
            await this.#withVerifiedLease(lease, cleanupOperation, () =>
              this.#options.artifacts.cleanupProfileTransients(),
            );
          } catch {
            finalFailure = selectCliProviderFailure(
              finalFailure,
              geminiError('PROVIDER_RESIDUAL_DATA'),
            );
          }
          if (schemaSha256 !== null) {
            try {
              await this.#verifyManagedProfile(binding, schemaSha256, lease, cleanupOperation);
            } catch (error) {
              finalFailure = selectCliProviderFailure(finalFailure, error);
            }
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
      finalFailure = selectCliProviderFailure(finalFailure, geminiError('PROVIDER_RESIDUAL_DATA'));
    }
    if (lease !== null) {
      try {
        await lease.release();
      } catch {
        finalFailure = selectCliProviderFailure(
          finalFailure,
          geminiError('PROVIDER_RESIDUAL_DATA'),
        );
      }
    }
    if (finalFailure !== undefined) throw finalFailure;
    if (outcome.kind === 'failure') throw outcome.error;
    return outcome.value;
  }

  #assertAliasLease(binding: GeminiBinding, lease: WindowsWorkspaceAliasLease): void {
    const drive = lease.runtimeRoot.slice(0, 2);
    if (
      lease.providerId !== binding.providerId ||
      !/^[R-W]:\\$/u.test(lease.runtimeRoot) ||
      lease.profileRoot !== `${drive}\\profiles\\gemini_cli` ||
      lease.workspaceRoot !== `${drive}\\workspace` ||
      lease.tempRoot !== `${drive}\\temp`
    ) {
      throw geminiError('PROVIDER_UNSAFE_VERSION');
    }
  }

  async #revalidateLease(
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    try {
      await lease.revalidate(operation);
    } catch {
      if (operation.signal.aborted) throw geminiError('PROVIDER_CANCELLED');
      throw geminiError('PROVIDER_RESIDUAL_DATA');
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
    await this.#revalidateLease(lease, connectionOperation);
    if (outcome.kind === 'failure') throw outcome.error;
    return outcome.value;
  }

  async #writeAndVerifyProfile(
    binding: GeminiBinding,
    expectedSchemaSha256: string,
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    try {
      await this.#withVerifiedLease(lease, operation, () =>
        this.#options.artifacts.writeProfileAtomic(this.#profile, operation),
      );
    } catch (error) {
      if (isGeminiProviderError(error)) throw error;
      throw geminiError('PROVIDER_UNSAFE_VERSION');
    }
    await this.#verifyManagedProfile(binding, expectedSchemaSha256, lease, operation);
  }

  async #verifyManagedProfile(
    binding: GeminiBinding,
    expectedSchemaSha256: string,
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    try {
      const snapshot = await this.#withVerifiedLease(lease, operation, () =>
        this.#options.artifacts.readSettingsSchemaSnapshot(binding, operation),
      );
      if (validateGeminiSettingsSchema(binding, snapshot) !== expectedSchemaSha256) {
        throw geminiError('PROVIDER_UNSAFE_VERSION');
      }
      await this.#withVerifiedLease(lease, operation, () =>
        this.#options.artifacts.verifyProfile(this.#profile, operation),
      );
    } catch (error) {
      if (isGeminiProviderError(error)) throw error;
      throw geminiError('PROVIDER_UNSAFE_VERSION');
    }
  }

  async #scanCredentialProfile(
    binding: GeminiBinding,
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
    evidence: GeminiCredentialEvidence,
  ): Promise<CliCredentialInspection> {
    return this.#withVerifiedLease(lease, operation, () =>
      inspectGeminiCredentialProfile(
        this.#options.credentialGuard,
        binding,
        lease.profileRoot,
        evidence,
        operation,
      ),
    );
  }

  async #inspectWindowsCredentialPresence(
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<GeminiCredentialEvidence> {
    return this.#withVerifiedLease(lease, operation, () =>
      inspectGeminiWindowsCredentialPresence(this.#options.credentialPresence, operation),
    );
  }

  async #rescanCredentialProfile(
    binding: GeminiBinding,
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
    evidence: GeminiCredentialEvidence,
  ): Promise<void> {
    try {
      await this.#scanCredentialProfile(binding, lease, operation, evidence);
    } catch (error) {
      if (
        isGeminiProviderError(error) &&
        error.code === 'PROVIDER_CANCELLED' &&
        operation.signal.aborted
      ) {
        throw error;
      }
      throw geminiError('PROVIDER_RESIDUAL_DATA');
    }
  }

  async #executeModel<Output extends JsonValue>(
    binding: GeminiBinding,
    requestId: string,
    selectedModelId: string | null,
    prompt: string,
    parseOutput: (value: unknown) => Output,
    timeoutMs: number,
    active: ActiveOperation,
    lease: WindowsWorkspaceAliasLease,
    credentialEvidence: GeminiCredentialEvidence,
  ) {
    const result = await this.#run(
      binding,
      requestId,
      selectedModelId,
      buildGeminiStdin(prompt),
      timeoutMs,
      active,
      lease,
      credentialEvidence,
    );
    assertGeminiSuccess(result);
    return parseGeminiStream(result.stdout, requestId, selectedModelId, parseOutput);
  }

  async #run(
    binding: GeminiBinding,
    requestId: string,
    selectedModelId: string | null,
    stdin: string,
    timeoutMs: number,
    active: ActiveOperation,
    lease: WindowsWorkspaceAliasLease,
    credentialEvidence: GeminiCredentialEvidence,
  ): Promise<CliProcessResult> {
    this.#assertActive(active);
    const operation = this.#connectionOperation(active);
    let prepared: GeminiRequestArtifacts | null = null;
    let result: CliProcessResult | null = null;
    let failure: unknown;
    let cleanupFailed = false;
    try {
      prepared = await this.#prepareRequest(requestId, lease, operation);
      this.#assertActive(active);
      await this.#verifyManagedProfile(
        binding,
        await this.#currentSchemaHash(binding, lease, operation),
        lease,
        operation,
      );
      await this.#withVerifiedLease(lease, operation, () =>
        runCliArtifactValidation(active.signal, (signal) =>
          this.#options.artifacts.verifyRequest(requestId, Object.freeze({ requestId, signal })),
        ),
      );
      this.#assertActive(active);
      await this.#rescanCredentialProfile(binding, lease, operation, credentialEvidence);
      this.#assertActive(active);
      const runner = this.#options.createRunner(binding);
      active.runners.set(requestId, runner);
      const currentPrepared = prepared;
      result = await this.#withVerifiedLease(lease, operation, () =>
        runner.run(
          Object.freeze({
            requestId,
            launcherPath: binding.canonicalLauncherPath,
            args: buildGeminiArgs(
              binding.fixedPrefixArgs,
              this.#profile.policyPath,
              selectedModelId,
            ),
            cwd: currentPrepared.workspacePath,
            env: Object.freeze({}),
            stdin,
            timeoutMs,
            stdoutLimitBytes: GEMINI_MAX_STREAM_BYTES,
            stderrLimitBytes: 16 * 1024,
            postProcessValidation: (signal) =>
              this.#withVerifiedLease(lease, Object.freeze({ requestId, signal }), () =>
                runCliArtifactValidation(signal, (activeSignal) =>
                  this.#options.artifacts.verifyRequest(
                    requestId,
                    Object.freeze({ requestId, signal: activeSignal }),
                  ),
                ),
              ),
            signal: active.signal,
            shell: false,
          }),
        ),
      );
      this.#assertActive(active);
    } catch (error) {
      failure = error;
    } finally {
      active.runners.delete(requestId);
      if (prepared !== null) {
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
    if (cleanupFailed) throw geminiError('PROVIDER_RESIDUAL_DATA');
    this.#assertActive(active);
    if (failure !== undefined) throw sanitizeGeminiFailure(failure);
    if (result === null) throw geminiError('PROVIDER_EXECUTION_FAILED');
    return result;
  }

  async #prepareRequest(
    requestId: string,
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<GeminiRequestArtifacts> {
    if (!GEMINI_UUID_PATTERN.test(requestId)) throw geminiError('PROVIDER_EXECUTION_FAILED');
    try {
      const prepared = await this.#withVerifiedLease(lease, operation, () =>
        this.#options.artifacts.prepareRequestAtomic(requestId, operation),
      );
      assertGeminiArtifacts(requestId, prepared, this.#roots);
      await this.#withVerifiedLease(lease, operation, () =>
        runCliArtifactValidation(operation.signal, (activeSignal) =>
          this.#options.artifacts.verifyRequest(
            requestId,
            Object.freeze({ requestId, signal: activeSignal }),
          ),
        ),
      );
      return prepared;
    } catch (error) {
      try {
        const cleanupOperation = createCleanupOperation();
        await runCliCleanupWithinDeadline(cleanupOperation, () =>
          this.#withVerifiedLease(lease, cleanupOperation, () =>
            this.#options.artifacts.cleanupRequest(requestId),
          ),
        );
      } catch {
        throw geminiError('PROVIDER_RESIDUAL_DATA');
      }
      if (isGeminiProviderError(error)) throw error;
      throw geminiError('PROVIDER_UNSAFE_VERSION');
    }
  }

  async #currentSchemaHash(
    binding: GeminiBinding,
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<string> {
    try {
      return validateGeminiSettingsSchema(
        binding,
        await this.#withVerifiedLease(lease, operation, () =>
          this.#options.artifacts.readSettingsSchemaSnapshot(binding, operation),
        ),
      );
    } catch (error) {
      if (isGeminiProviderError(error)) throw error;
      throw geminiError('PROVIDER_UNSAFE_VERSION');
    }
  }

  #safeNow(): string {
    const value = this.#options.now();
    if (!isGeminiIsoTimestamp(value)) throw geminiError('PROVIDER_EXECUTION_FAILED');
    return value;
  }

  #safeMilliseconds(): number {
    const value = this.#options.nowMilliseconds();
    if (!Number.isFinite(value) || value < 0) throw geminiError('PROVIDER_EXECUTION_FAILED');
    return value;
  }
}

export const createGeminiCliAdapterForTest = (
  options: GeminiCliAdapterOptions,
): GeminiCliAdapterTestSurface => new GeminiCliAdapter(options);

export const createGeminiCliAdapter = createGeminiCliAdapterForTest;
