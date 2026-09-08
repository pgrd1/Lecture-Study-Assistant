import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import type { CliProcessRunner } from '../../../core/ports/cliProcessRunner';
import { ANTIGRAVITY_UUID_PATTERN, antigravityError } from './antigravityCliProtocol';

export type AntigravityActiveOperation = Readonly<{
  requestId: string;
  signal: AbortSignal;
}>;

export type AntigravityChildOperation = Readonly<{
  requestId: string;
  signal: AbortSignal;
}>;

export interface AntigravityOperationRegistry {
  begin(operation: ProviderConnectionOperation): AntigravityActiveOperation;
  reserveChild(
    active: AntigravityActiveOperation,
    requestId: string,
    allowOuterRequestId?: boolean,
  ): AntigravityChildOperation;
  attachRunner(child: AntigravityChildOperation, runner: CliProcessRunner): void;
  detachRunner(child: AntigravityChildOperation): void;
  releaseChild(child: AntigravityChildOperation): void;
  assertActive(active: AntigravityActiveOperation): void;
  cancel(requestId: string): void;
  finish(active: AntigravityActiveOperation): void;
}

type ActiveRecord = Readonly<{
  token: AntigravityActiveOperation;
  sourceSignal: AbortSignal;
  controller: AbortController;
  onAbort: () => void;
  childIds: Set<string>;
  childRunners: Map<string, CliProcessRunner>;
  cancelledChildIds: Set<string>;
  deliveredChildCancellations: Set<string>;
}>;

type ChildRecord = Readonly<{
  token: AntigravityChildOperation;
  active: ActiveRecord;
  controller: AbortController;
}>;

class FixedAntigravityOperationRegistry implements AntigravityOperationRegistry {
  readonly #activeById = new Map<string, ActiveRecord>();
  readonly #activeByToken = new WeakMap<AntigravityActiveOperation, ActiveRecord>();
  readonly #childById = new Map<string, ChildRecord>();
  readonly #childByToken = new WeakMap<AntigravityChildOperation, ChildRecord>();

  begin(operation: ProviderConnectionOperation): AntigravityActiveOperation {
    if (
      !ANTIGRAVITY_UUID_PATTERN.test(operation.requestId) ||
      !(operation.signal instanceof AbortSignal) ||
      this.#activeById.has(operation.requestId) ||
      this.#childById.has(operation.requestId)
    ) {
      throw antigravityError('PROVIDER_EXECUTION_FAILED');
    }
    if (operation.signal.aborted) throw antigravityError('PROVIDER_CANCELLED');

    const controller = new AbortController();
    const token = Object.freeze({ requestId: operation.requestId, signal: controller.signal });
    let record: ActiveRecord;
    const onAbort = () => this.#cancelRecord(record);
    record = Object.freeze({
      token,
      sourceSignal: operation.signal,
      controller,
      onAbort,
      childIds: new Set<string>(),
      childRunners: new Map<string, CliProcessRunner>(),
      cancelledChildIds: new Set<string>(),
      deliveredChildCancellations: new Set<string>(),
    });
    this.#activeById.set(token.requestId, record);
    this.#activeByToken.set(token, record);
    operation.signal.addEventListener('abort', onAbort, { once: true });
    if (operation.signal.aborted) {
      this.#cancelRecord(record);
      this.finish(token);
      throw antigravityError('PROVIDER_CANCELLED');
    }
    this.assertActive(token);
    return token;
  }

  reserveChild(
    active: AntigravityActiveOperation,
    requestId: string,
    allowOuterRequestId = false,
  ): AntigravityChildOperation {
    const record = this.#readActive(active);
    this.assertActive(active);
    if (
      !ANTIGRAVITY_UUID_PATTERN.test(requestId) ||
      this.#childById.has(requestId) ||
      (this.#activeById.has(requestId) && !(allowOuterRequestId && requestId === active.requestId))
    ) {
      throw antigravityError('PROVIDER_EXECUTION_FAILED');
    }
    const controller = new AbortController();
    const token = Object.freeze({
      requestId,
      signal: AbortSignal.any([active.signal, controller.signal]),
    });
    const child = Object.freeze({ token, active: record, controller });
    record.childIds.add(requestId);
    this.#childById.set(requestId, child);
    this.#childByToken.set(token, child);
    return token;
  }

  attachRunner(child: AntigravityChildOperation, runner: CliProcessRunner): void {
    const record = this.#readChild(child);
    if (record.active.childRunners.has(child.requestId)) {
      throw antigravityError('PROVIDER_EXECUTION_FAILED');
    }
    record.active.childRunners.set(child.requestId, runner);
    if (
      record.active.controller.signal.aborted ||
      record.active.cancelledChildIds.has(child.requestId)
    ) {
      this.#cancelChild(record);
    }
    this.assertActive(record.active.token);
  }

  detachRunner(child: AntigravityChildOperation): void {
    const record = this.#readChild(child);
    record.active.childRunners.delete(child.requestId);
  }

  releaseChild(child: AntigravityChildOperation): void {
    const record = this.#readChild(child);
    record.active.childRunners.delete(child.requestId);
    record.active.childIds.delete(child.requestId);
    record.active.cancelledChildIds.delete(child.requestId);
    record.active.deliveredChildCancellations.delete(child.requestId);
    if (this.#childById.get(child.requestId) === record) this.#childById.delete(child.requestId);
    this.#childByToken.delete(child);
  }

  assertActive(active: AntigravityActiveOperation): void {
    const record = this.#readActive(active);
    if (record.sourceSignal.aborted && !record.controller.signal.aborted) {
      this.#cancelRecord(record);
    }
    if (record.controller.signal.aborted) throw antigravityError('PROVIDER_CANCELLED');
  }

  cancel(requestId: string): void {
    const active = this.#activeById.get(requestId);
    if (active !== undefined) {
      this.#cancelRecord(active);
      return;
    }
    const child = this.#childById.get(requestId);
    if (child !== undefined) this.#cancelChild(child);
  }

  finish(active: AntigravityActiveOperation): void {
    const record = this.#readActive(active);
    record.sourceSignal.removeEventListener('abort', record.onAbort);
    for (const requestId of [...record.childIds]) {
      const child = this.#childById.get(requestId);
      if (child !== undefined) {
        child.active.childRunners.delete(requestId);
        this.#childByToken.delete(child.token);
        this.#childById.delete(requestId);
      }
    }
    record.childIds.clear();
    record.childRunners.clear();
    record.cancelledChildIds.clear();
    record.deliveredChildCancellations.clear();
    if (this.#activeById.get(active.requestId) === record)
      this.#activeById.delete(active.requestId);
    this.#activeByToken.delete(active);
  }

  #readActive(active: AntigravityActiveOperation): ActiveRecord {
    const record = this.#activeByToken.get(active);
    if (record === undefined || this.#activeById.get(active.requestId) !== record) {
      throw antigravityError('PROVIDER_EXECUTION_FAILED');
    }
    return record;
  }

  #readChild(child: AntigravityChildOperation): ChildRecord {
    const record = this.#childByToken.get(child);
    if (record === undefined || this.#childById.get(child.requestId) !== record) {
      throw antigravityError('PROVIDER_EXECUTION_FAILED');
    }
    return record;
  }

  #cancelRecord(record: ActiveRecord): void {
    if (record.controller.signal.aborted) return;
    record.controller.abort();
    for (const requestId of [...record.childIds]) {
      const child = this.#childById.get(requestId);
      if (child !== undefined) this.#cancelChild(child);
    }
  }

  #cancelChild(record: ChildRecord): void {
    const { requestId } = record.token;
    if (!record.active.cancelledChildIds.has(requestId)) {
      record.active.cancelledChildIds.add(requestId);
      record.controller.abort();
    }
    const runner = record.active.childRunners.get(requestId);
    if (runner !== undefined && !record.active.deliveredChildCancellations.has(requestId)) {
      record.active.deliveredChildCancellations.add(requestId);
      this.#cancelRunner(runner, requestId);
    }
  }

  #cancelRunner(runner: CliProcessRunner, requestId: string): void {
    try {
      runner.cancel(requestId);
    } catch {
      // The registry's cancellation bit remains authoritative even if a runner throws.
    }
  }
}

export const createAntigravityOperationRegistry = (): AntigravityOperationRegistry =>
  new FixedAntigravityOperationRegistry();
