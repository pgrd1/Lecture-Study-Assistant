import { Buffer } from 'node:buffer';
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
import {
  PROVIDER_PROBE_JSON_SCHEMA,
  PROVIDER_PROBE_PROMPT,
  ProviderProbeOutputSchema,
} from '../../../core/providers/providerProbe';
import type { JsonValue, ProviderModel } from '../../../shared/contracts/provider';
import {
  ANTIGRAVITY_HELP_OUTPUT,
  ANTIGRAVITY_MANAGED_PROFILE_JSON,
  ANTIGRAVITY_MAX_DIAGNOSTIC_BYTES,
  ANTIGRAVITY_MAX_HELP_BYTES,
  ANTIGRAVITY_MAX_MODEL_LIST_BYTES,
  ANTIGRAVITY_MAX_STREAM_BYTES,
  ANTIGRAVITY_MODELS_HELP_OUTPUT,
  ANTIGRAVITY_UUID_PATTERN,
  type AntigravityArtifactRoots,
  type AntigravityBinding,
  type AntigravityConfiguration,
  type AntigravityParsedStream,
  antigravityError,
  assertAntigravityArtifactRoots,
  assertAntigravityArtifacts,
  assertAntigravityBinding,
  assertAntigravityExecuteConsents,
  assertAntigravityModelId,
  assertAntigravitySuccess,
  buildAntigravityPrompt,
  buildAntigravityStdin,
  isAntigravityIsoTimestamp,
  isAntigravityProviderError,
  parseAntigravityConfiguration,
  parseAntigravityModels,
  parseAntigravityPermissions,
  parseAntigravityStream,
  sanitizeAntigravityFailure,
} from './antigravityCliProtocol';
import type {
  AntigravityManagedArtifacts,
  AntigravityRequestArtifacts,
} from './antigravityManagedArtifacts';
import {
  type AntigravityActiveOperation,
  type AntigravityChildOperation,
  createAntigravityOperationRegistry,
} from './antigravityOperationRegistry';
import { runCliArtifactValidation } from './cliArtifactValidation';
import type { CliCredentialGuard, CliCredentialInspection } from './cliCredentialGuard';
import type { CliExecutableInspector } from './cliExecutableInspector';
import { runCliCleanupWithinDeadline } from './cliFileIntegrity';
import { selectCliProviderFailure } from './cliProviderFailurePrecedence';
import {
  sameCliRuntimeBindingIdentity,
  type WindowsWorkspaceAlias,
  type WindowsWorkspaceAliasLease,
} from './windowsWorkspaceAlias';

export { ANTIGRAVITY_1_1_KNOWN_TOOLS } from './antigravityCliProtocol';
export type { AntigravityManagedArtifacts, AntigravityRequestArtifacts };
export type AntigravityCliAdapterOptions = Readonly<{
  inspector: CliExecutableInspector;
  loadBinding: () => CliRuntimeBinding<'antigravity_cli', 'provider_global'> | null;
  createRunner: (binding: AntigravityBinding) => CliProcessRunner;
  aliases: WindowsWorkspaceAlias;
  artifacts: AntigravityManagedArtifacts;
  providerWorkspaceRoot: string;
  providerTempRoot: string;
  credentialGuard: CliCredentialGuard;
  nextChildRequestId: () => string;
  now: () => string;
  nowMilliseconds: () => number;
}>;
type CliArgs = readonly string[] | ((schemaPath: string | null) => readonly string[]);
const CLEANUP_TIMEOUT_MS = 15_000 as const;
const createCleanupOperation = (): ProviderConnectionOperation =>
  Object.freeze({ requestId: randomUUID(), signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });

class AntigravityCliAdapter implements AiProviderAdapter<'antigravity_cli'> {
  readonly id = 'antigravity_cli' as const;
  readonly #options: AntigravityCliAdapterOptions;
  readonly #artifactRoots: AntigravityArtifactRoots;
  readonly #operations = createAntigravityOperationRegistry();

  constructor(options: AntigravityCliAdapterOptions) {
    this.#options = options;
    this.#artifactRoots = assertAntigravityArtifactRoots(
      options.providerWorkspaceRoot,
      options.providerTempRoot,
    );
  }

  async inspect(
    operation: ProviderConnectionOperation,
  ): Promise<ProviderInspection<'antigravity_cli'>> {
    let active: AntigravityActiveOperation | undefined;
    try {
      const currentActive = this.#operations.begin(operation);
      active = currentActive;
      const binding = assertAntigravityBinding(
        await this.#options.inspector.inspect('antigravity_cli', currentActive),
      );
      this.#operations.assertActive(currentActive);
      return await this.#withVerifiedAlias(
        binding,
        async (current, lease) => {
          const inspection = await this.#preflight(current, lease, currentActive);
          return Object.freeze({
            status: inspection.status === 'present' ? 'credential_saved' : 'installed',
            version: current.version,
            credentialPresent: inspection.status === 'present',
            credentialScope: 'provider_global' as const,
            cliBinding: current,
            providerManagedHistory: true,
          });
        },
        currentActive,
      );
    } catch (error) {
      throw sanitizeAntigravityFailure(error);
    } finally {
      if (active !== undefined) this.#operations.finish(active);
    }
  }

  async listModels(operation: ProviderConnectionOperation): Promise<readonly ProviderModel[]> {
    let active: AntigravityActiveOperation | undefined;
    try {
      const currentActive = this.#operations.begin(operation);
      active = currentActive;
      const binding = await this.#currentBinding(currentActive);
      return await this.#withVerifiedAlias(
        binding,
        async (current, lease) => {
          const preflight = await this.#preflight(current, lease, currentActive);
          if (preflight.status !== 'present') throw antigravityError('PROVIDER_AUTH_REQUIRED');
          await this.#withVerifiedLease(lease, currentActive, () =>
            this.#revalidate(current, currentActive),
          );
          const result = await this.#withProfile(lease, currentActive, () =>
            this.#run(
              current,
              this.#nextChildId(),
              ['models'],
              '',
              30_000,
              ANTIGRAVITY_MAX_MODEL_LIST_BYTES,
              null,
              lease,
              currentActive,
            ),
          );
          assertAntigravitySuccess(result);
          const models = parseAntigravityModels(result.stdout);
          await this.#inspectCredential(current, preflight.configuration, lease, currentActive);
          return models;
        },
        currentActive,
      );
    } catch (error) {
      throw sanitizeAntigravityFailure(error);
    } finally {
      if (active !== undefined) this.#operations.finish(active);
    }
  }

  async probe(
    modelId: string | null,
    operation: ProviderConnectionOperation,
  ): Promise<ProviderProbeEvidence> {
    let active: AntigravityActiveOperation | undefined;
    try {
      const currentActive = this.#operations.begin(operation);
      active = currentActive;
      const selectedModelId = assertAntigravityModelId(modelId);
      const startedAt = this.#safeMilliseconds();
      const binding = await this.#currentBinding(currentActive);
      return await this.#withVerifiedAlias(
        binding,
        async (current, lease) => {
          const preflight = await this.#preflight(current, lease, currentActive);
          if (preflight.status !== 'present') throw antigravityError('PROVIDER_AUTH_REQUIRED');
          await this.#withVerifiedLease(lease, currentActive, () =>
            this.#revalidate(current, currentActive),
          );
          const parsed = await this.#executeModel(
            current,
            operation.requestId,
            selectedModelId,
            PROVIDER_PROBE_PROMPT,
            PROVIDER_PROBE_JSON_SCHEMA,
            (value) => ProviderProbeOutputSchema.parse(value),
            120_000,
            lease,
            currentActive,
          );
          await this.#inspectCredential(current, preflight.configuration, lease, currentActive);
          const latencyMs = Math.max(0, Math.trunc(this.#safeMilliseconds() - startedAt));
          return Object.freeze({
            status: 'ready' as const,
            reportedModelId: parsed.reportedModelId,
            latencyMs,
            usage: Object.freeze({ ...parsed.usage }),
            providerManagedHistory: true,
          });
        },
        currentActive,
      );
    } catch (error) {
      throw sanitizeAntigravityFailure(error);
    } finally {
      if (active !== undefined) this.#operations.finish(active);
    }
  }

  async execute<Output extends JsonValue>(
    request: ProviderRequest<Output>,
  ): Promise<ProviderExecution<Output>> {
    const textBlocks = requireTextBlocks(request.blocks);
    if (request.signal.aborted) throw antigravityError('PROVIDER_CANCELLED');
    assertAntigravityExecuteConsents(request);
    const modelId = assertAntigravityModelId(request.modelId);
    const activeExecution = this.#operations.begin(
      Object.freeze({ requestId: request.requestId, signal: request.signal }),
    );
    try {
      const binding = await this.#currentBinding(activeExecution);
      this.#operations.assertActive(activeExecution);
      const execution = await this.#withVerifiedAlias(
        binding,
        async (current, lease) => {
          const preflight = await this.#preflight(current, lease, activeExecution);
          if (preflight.status !== 'present') throw antigravityError('PROVIDER_AUTH_REQUIRED');
          this.#operations.assertActive(activeExecution);
          await this.#withVerifiedLease(lease, activeExecution, () =>
            this.#revalidate(current, activeExecution),
          );
          this.#operations.assertActive(activeExecution);
          const parsed = await this.#executeModel(
            current,
            request.requestId,
            modelId,
            buildAntigravityPrompt(textBlocks),
            request.outputJsonSchema,
            request.parseOutput,
            request.timeoutMs,
            lease,
            activeExecution,
          );
          await this.#inspectCredential(current, preflight.configuration, lease, activeExecution);
          this.#operations.assertActive(activeExecution);
          return Object.freeze({
            output: parsed.output,
            reportedModelId: parsed.reportedModelId,
            usage: Object.freeze({ ...parsed.usage }),
            completedAt: this.#safeNow(),
          });
        },
        activeExecution,
      );
      this.#operations.assertActive(activeExecution);
      return execution;
    } catch (error) {
      throw sanitizeAntigravityFailure(error);
    } finally {
      this.#operations.finish(activeExecution);
    }
  }

  cancel(requestId: string): void {
    this.#operations.cancel(requestId);
  }

  async #currentBinding(active: AntigravityActiveOperation): Promise<AntigravityBinding> {
    const stored = this.#options.loadBinding();
    if (stored === null) throw antigravityError('PROVIDER_NOT_READY');
    return this.#revalidate(assertAntigravityBinding(stored), active);
  }

  async #revalidate(
    binding: AntigravityBinding,
    operation: ProviderConnectionOperation,
  ): Promise<AntigravityBinding> {
    let current: AntigravityBinding;
    try {
      current = assertAntigravityBinding(
        await this.#options.inspector.revalidate(binding, operation),
      );
    } catch (error) {
      if (operation.signal.aborted) throw antigravityError('PROVIDER_CANCELLED');
      if (isAntigravityProviderError(error) && error.code === 'PROVIDER_UNSAFE_VERSION') {
        throw error;
      }
      throw antigravityError('PROVIDER_CLI_CHANGED');
    }
    if (!sameCliRuntimeBindingIdentity(current, binding)) {
      throw antigravityError('PROVIDER_CLI_CHANGED');
    }
    return current;
  }

  async #withVerifiedAlias<T>(
    binding: AntigravityBinding,
    action: (binding: AntigravityBinding, lease: WindowsWorkspaceAliasLease) => Promise<T>,
    activeExecution: AntigravityActiveOperation,
  ): Promise<T> {
    let lease: WindowsWorkspaceAliasLease | null = null;
    let leaseVerified = false;
    let outcome:
      | Readonly<{ kind: 'success'; value: T }>
      | Readonly<{ error: unknown; kind: 'error' }>;
    try {
      this.#operations.assertActive(activeExecution);
      const current = binding;
      this.#operations.assertActive(activeExecution);
      lease = await this.#options.aliases.acquire(current, activeExecution);
      this.#operations.assertActive(activeExecution);
      this.#assertAliasLease(current, lease);
      await this.#revalidateLease(lease, activeExecution);
      leaseVerified = true;
      outcome = Object.freeze({ kind: 'success', value: await action(current, lease) });
    } catch (error) {
      outcome = Object.freeze({ error, kind: 'error' });
    }
    let finalFailure: unknown = outcome.kind === 'error' ? outcome.error : undefined;
    const cleanupOperation = createCleanupOperation();
    if (lease !== null && leaseVerified) {
      try {
        await runCliCleanupWithinDeadline(cleanupOperation, () =>
          this.#withVerifiedLease(lease, cleanupOperation, () =>
            this.#revalidate(binding, cleanupOperation),
          ),
        );
      } catch (error) {
        finalFailure = selectCliProviderFailure(finalFailure, error);
      }
    } else {
      try {
        await runCliCleanupWithinDeadline(cleanupOperation, () =>
          this.#revalidate(binding, cleanupOperation),
        );
      } catch (error) {
        finalFailure = selectCliProviderFailure(finalFailure, error);
      }
    }
    if (lease !== null) {
      try {
        await lease.release();
      } catch {
        finalFailure = selectCliProviderFailure(
          finalFailure,
          antigravityError('PROVIDER_RESIDUAL_DATA'),
        );
      }
    }
    if (finalFailure !== undefined) throw finalFailure;
    if (outcome.kind === 'error') throw outcome.error;
    return outcome.value;
  }
  #assertAliasLease(binding: AntigravityBinding, lease: WindowsWorkspaceAliasLease): void {
    const drive = lease.runtimeRoot.slice(0, 2);
    if (
      lease.providerId !== binding.providerId ||
      !/^[R-W]:\\$/u.test(lease.runtimeRoot) ||
      lease.profileRoot !== `${drive}\\profiles\\antigravity_cli` ||
      lease.workspaceRoot !== `${drive}\\workspace` ||
      lease.tempRoot !== `${drive}\\temp`
    ) {
      throw antigravityError('PROVIDER_UNSAFE_VERSION');
    }
  }
  async #revalidateLease(
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    try {
      await lease.revalidate(operation);
    } catch {
      if (operation.signal.aborted) throw antigravityError('PROVIDER_CANCELLED');
      throw antigravityError('PROVIDER_RESIDUAL_DATA');
    }
  }
  async #withVerifiedLease<T>(
    lease: WindowsWorkspaceAliasLease,
    connectionOperation: ProviderConnectionOperation,
    action: () => T | Promise<T>,
  ): Promise<T> {
    await this.#revalidateLease(lease, connectionOperation);
    let outcome:
      | Readonly<{ kind: 'success'; value: T }>
      | Readonly<{ error: unknown; kind: 'error' }>;
    try {
      outcome = Object.freeze({ kind: 'success', value: await action() });
    } catch (error) {
      outcome = Object.freeze({ error, kind: 'error' });
    }
    await this.#revalidateLease(lease, connectionOperation);
    if (outcome.kind === 'error') throw outcome.error;
    return outcome.value;
  }

  async #preflight(
    binding: AntigravityBinding,
    lease: WindowsWorkspaceAliasLease,
    activeExecution: AntigravityActiveOperation,
  ): Promise<
    Readonly<{ status: CliCredentialInspection['status']; configuration: AntigravityConfiguration }>
  > {
    const configuration = await this.#withProfile(lease, activeExecution, async () => {
      const help = await this.#runLocal(
        binding,
        ['--help'],
        ANTIGRAVITY_MAX_HELP_BYTES,
        lease,
        activeExecution,
      );
      this.#assertHelp(help, ANTIGRAVITY_HELP_OUTPUT);
      const modelsHelp = await this.#runLocal(
        binding,
        ['models', '--help'],
        ANTIGRAVITY_MAX_HELP_BYTES,
        lease,
        activeExecution,
      );
      this.#assertHelp(modelsHelp, ANTIGRAVITY_MODELS_HELP_OUTPUT);
      const permissions = await this.#runLocal(
        binding,
        ['-p', '/permissions', '--output-format', 'json'],
        ANTIGRAVITY_MAX_DIAGNOSTIC_BYTES,
        lease,
        activeExecution,
      );
      assertAntigravitySuccess(permissions);
      parseAntigravityPermissions(permissions.stdout);
      const config = await this.#runLocal(
        binding,
        ['-p', '/config', '--output-format', 'json'],
        ANTIGRAVITY_MAX_DIAGNOSTIC_BYTES,
        lease,
        activeExecution,
      );
      assertAntigravitySuccess(config);
      return this.#withVerifiedLease(lease, activeExecution, () =>
        parseAntigravityConfiguration(config.stdout, lease.profileRoot),
      );
    });
    this.#operations.assertActive(activeExecution);
    const inspection = await this.#inspectCredential(
      binding,
      configuration,
      lease,
      activeExecution,
    );
    this.#operations.assertActive(activeExecution);
    if (
      inspection.scope !== 'provider_global' ||
      !inspection.providerManagedHistory ||
      (inspection.backend !== 'windows_credential_manager' &&
        inspection.backend !== 'os_account_bound_encrypted')
    ) {
      throw antigravityError('PROVIDER_UNSAFE_VERSION');
    }
    return Object.freeze({ status: inspection.status, configuration });
  }

  #inspectCredential(
    binding: AntigravityBinding,
    configuration: AntigravityConfiguration,
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<CliCredentialInspection> {
    return this.#withVerifiedLease(lease, operation, () =>
      this.#options.credentialGuard.inspect(
        Object.freeze({
          binding,
          managedProfilePath: configuration.managedProfilePath,
          evidence: configuration.credentialEvidence,
        }),
        operation,
      ),
    );
  }

  async #executeModel<Output extends JsonValue>(
    binding: AntigravityBinding,
    requestId: string,
    modelId: string,
    prompt: string,
    schema: Readonly<Record<string, JsonValue>>,
    parseOutput: (value: unknown) => Output,
    timeoutMs: number,
    lease: WindowsWorkspaceAliasLease,
    activeExecution: AntigravityActiveOperation,
  ): Promise<AntigravityParsedStream<Output>> {
    const schemaJson = JSON.stringify(schema);
    const result = await this.#withProfile(lease, activeExecution, () =>
      this.#run(
        binding,
        requestId,
        (schemaPath) => [
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--json-schema',
          schemaPath as string,
          '--model',
          modelId,
          '--print-timeout',
          `${Math.ceil(timeoutMs / 1_000)}s`,
          '--sandbox',
        ],
        buildAntigravityStdin(prompt),
        timeoutMs,
        ANTIGRAVITY_MAX_STREAM_BYTES,
        schemaJson,
        lease,
        activeExecution,
        true,
      ),
    );
    assertAntigravitySuccess(result);
    return parseAntigravityStream(result.stdout, requestId, modelId, parseOutput);
  }

  async #run(
    binding: AntigravityBinding,
    requestId: string,
    args: CliArgs,
    stdin: string,
    timeoutMs: number,
    stdoutLimitBytes: number,
    schemaJson: string | null,
    lease: WindowsWorkspaceAliasLease,
    activeExecution: AntigravityActiveOperation,
    usesOuterRequestId = false,
  ): Promise<CliProcessResult> {
    this.#operations.assertActive(activeExecution);
    const child = this.#operations.reserveChild(activeExecution, requestId, usesOuterRequestId);
    try {
      return await this.#runReserved(
        binding,
        requestId,
        args,
        stdin,
        timeoutMs,
        stdoutLimitBytes,
        schemaJson,
        lease,
        activeExecution,
        child,
      );
    } finally {
      this.#operations.releaseChild(child);
    }
  }

  async #runReserved(
    binding: AntigravityBinding,
    requestId: string,
    args: CliArgs,
    stdin: string,
    timeoutMs: number,
    stdoutLimitBytes: number,
    schemaJson: string | null,
    lease: WindowsWorkspaceAliasLease,
    activeExecution: AntigravityActiveOperation,
    child: AntigravityChildOperation,
  ): Promise<CliProcessResult> {
    const requestSignal = child.signal;
    let prepared: AntigravityRequestArtifacts | null = null;
    let result: CliProcessResult | null = null;
    let failure: unknown;
    let cleanupFailed = false;
    try {
      this.#operations.assertActive(activeExecution);
      prepared = await this.#prepareArtifacts(requestId, schemaJson, lease, child);
      this.#operations.assertActive(activeExecution);
      await this.#withVerifiedLease(lease, child, () =>
        this.#options.artifacts.verifyProfile(ANTIGRAVITY_MANAGED_PROFILE_JSON, child),
      );
      this.#operations.assertActive(activeExecution);
      await this.#withVerifiedLease(lease, child, () =>
        runCliArtifactValidation(requestSignal, (signal) =>
          this.#options.artifacts.verifyRequest(
            requestId,
            schemaJson,
            Object.freeze({ requestId, signal }),
          ),
        ),
      );
      this.#operations.assertActive(activeExecution);
      const runner = this.#options.createRunner(binding);
      this.#operations.attachRunner(child, runner);
      this.#operations.assertActive(activeExecution);
      const operationArgs = typeof args === 'function' ? args(prepared.schemaPath) : args;
      const currentPrepared = prepared;
      result = await this.#withVerifiedLease(lease, child, () =>
        runner.run(
          Object.freeze({
            requestId,
            launcherPath: binding.canonicalLauncherPath,
            args: Object.freeze([...binding.fixedPrefixArgs, ...operationArgs]),
            cwd: currentPrepared.workspacePath,
            env: Object.freeze({}),
            stdin,
            timeoutMs,
            stdoutLimitBytes,
            stderrLimitBytes: 16 * 1024,
            postProcessValidation: (signal) =>
              this.#withVerifiedLease(lease, Object.freeze({ requestId, signal }), () =>
                runCliArtifactValidation(signal, (activeSignal) =>
                  this.#options.artifacts.verifyRequest(
                    requestId,
                    schemaJson,
                    Object.freeze({ requestId, signal: activeSignal }),
                  ),
                ),
              ),
            signal: requestSignal,
            shell: false,
          }),
        ),
      );
      this.#operations.assertActive(activeExecution);
    } catch (error) {
      failure = error;
    } finally {
      this.#operations.detachRunner(child);
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
    if (cleanupFailed) throw antigravityError('PROVIDER_RESIDUAL_DATA');
    this.#operations.assertActive(activeExecution);
    if (failure !== undefined) throw sanitizeAntigravityFailure(failure);
    if (result === null) throw antigravityError('PROVIDER_EXECUTION_FAILED');
    return result;
  }

  #runLocal(
    binding: AntigravityBinding,
    args: readonly string[],
    stdoutLimitBytes: number,
    lease: WindowsWorkspaceAliasLease,
    activeExecution: AntigravityActiveOperation,
  ): Promise<CliProcessResult> {
    return this.#run(
      binding,
      this.#nextChildId(),
      args,
      '',
      15_000,
      stdoutLimitBytes,
      null,
      lease,
      activeExecution,
    );
  }

  async #prepareArtifacts(
    requestId: string,
    schemaJson: string | null,
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
  ): Promise<AntigravityRequestArtifacts> {
    if (!ANTIGRAVITY_UUID_PATTERN.test(requestId)) {
      throw antigravityError('PROVIDER_EXECUTION_FAILED');
    }
    try {
      const prepared = await this.#withVerifiedLease(lease, operation, () =>
        this.#options.artifacts.prepareRequestAtomic(requestId, schemaJson, operation),
      );
      assertAntigravityArtifacts(requestId, schemaJson, prepared, this.#artifactRoots);
      await this.#withVerifiedLease(lease, operation, () =>
        runCliArtifactValidation(operation.signal, (activeSignal) =>
          this.#options.artifacts.verifyRequest(
            requestId,
            schemaJson,
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
        throw antigravityError('PROVIDER_RESIDUAL_DATA');
      }
      if (isAntigravityProviderError(error)) throw error;
      throw antigravityError('PROVIDER_UNSAFE_VERSION');
    }
  }

  async #withProfile<T>(
    lease: WindowsWorkspaceAliasLease,
    operation: ProviderConnectionOperation,
    action: () => Promise<T>,
  ): Promise<T> {
    let value: T | undefined;
    let failure: unknown;
    try {
      await this.#withVerifiedLease(lease, operation, () =>
        this.#options.artifacts.writeProfileAtomic(ANTIGRAVITY_MANAGED_PROFILE_JSON, operation),
      );
      await this.#withVerifiedLease(lease, operation, () =>
        this.#options.artifacts.verifyProfile(ANTIGRAVITY_MANAGED_PROFILE_JSON, operation),
      );
      value = await action();
    } catch (error) {
      failure = error;
    }
    const cleanupOperation = createCleanupOperation();
    try {
      await runCliCleanupWithinDeadline(cleanupOperation, async () => {
        await this.#withVerifiedLease(lease, cleanupOperation, () =>
          this.#options.artifacts.cleanupProfileTransients(),
        );
        await this.#withVerifiedLease(lease, cleanupOperation, () =>
          this.#options.artifacts.verifyProfile(ANTIGRAVITY_MANAGED_PROFILE_JSON, cleanupOperation),
        );
      });
    } catch {
      throw antigravityError('PROVIDER_RESIDUAL_DATA');
    }
    if (failure !== undefined) throw failure;
    return value as T;
  }

  #assertHelp(result: CliProcessResult, expected: string): void {
    try {
      assertAntigravitySuccess(result);
      if (
        result.stdout !== expected ||
        Buffer.byteLength(result.stdout, 'utf8') > ANTIGRAVITY_MAX_HELP_BYTES
      ) {
        throw antigravityError('PROVIDER_UNSAFE_VERSION');
      }
    } catch (error) {
      if (
        isAntigravityProviderError(error) &&
        ['PROVIDER_CANCELLED', 'PROVIDER_CLI_CHANGED', 'PROVIDER_RESIDUAL_DATA'].includes(
          error.code,
        )
      ) {
        throw error;
      }
      throw antigravityError('PROVIDER_UNSAFE_VERSION');
    }
  }

  #nextChildId(): string {
    const value = this.#options.nextChildRequestId();
    if (!ANTIGRAVITY_UUID_PATTERN.test(value)) {
      throw antigravityError('PROVIDER_EXECUTION_FAILED');
    }
    return value;
  }

  #safeNow(): string {
    const value = this.#options.now();
    if (!isAntigravityIsoTimestamp(value)) throw antigravityError('PROVIDER_EXECUTION_FAILED');
    return value;
  }
  #safeMilliseconds(): number {
    const value = this.#options.nowMilliseconds();
    if (!Number.isFinite(value) || value < 0) throw antigravityError('PROVIDER_EXECUTION_FAILED');
    return value;
  }
}
export const createAntigravityCliAdapterForTest = (
  options: AntigravityCliAdapterOptions,
): AiProviderAdapter<'antigravity_cli'> => new AntigravityCliAdapter(options);

export const createAntigravityCliAdapter = createAntigravityCliAdapterForTest;
