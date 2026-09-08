import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnectionOperation } from '../../../../../src/core/ports/aiProvider';
import type {
  CliProcessRequest,
  CliProcessResult,
  CliProcessRunner,
} from '../../../../../src/core/ports/cliProcessRunner';
import { createAntigravityOperationRegistry } from '../../../../../src/infrastructure/providers/cli/antigravityOperationRegistry';

const operation = (
  requestId: string = randomUUID(),
  signal: AbortSignal = new AbortController().signal,
): ProviderConnectionOperation => Object.freeze({ requestId, signal });

class RecordingRunner implements CliProcessRunner {
  readonly cancelled: string[] = [];
  cancelError: Error | null = null;

  run(_request: CliProcessRequest): Promise<CliProcessResult> {
    return Promise.resolve(Object.freeze({ exitCode: 0, stdout: '', stderr: '' }));
  }

  cancel(requestId: string): void {
    this.cancelled.push(requestId);
    if (this.cancelError !== null) throw this.cancelError;
  }
}

describe('Antigravity operation registry', () => {
  it.each([
    ['invalid outer request ID', operation('not-a-uuid')],
    [
      'non-AbortSignal source',
      Object.freeze({ requestId: randomUUID(), signal: Object.freeze({ aborted: false }) }),
    ],
  ] as const)('rejects %s without poisoning later operations', (_label, invalidOperation) => {
    const registry = createAntigravityOperationRegistry();

    expect(() =>
      registry.begin(invalidOperation as unknown as ProviderConnectionOperation),
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_EXECUTION_FAILED' }));

    const replacement = registry.begin(
      operation(
        invalidOperation.requestId === 'not-a-uuid' ? randomUUID() : invalidOperation.requestId,
      ),
    );
    registry.finish(replacement);
  });

  it('rejects a pre-aborted source without retaining its request ID', () => {
    const registry = createAntigravityOperationRegistry();
    const requestId = randomUUID();
    const controller = new AbortController();
    controller.abort();

    expect(() => registry.begin(operation(requestId, controller.signal))).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_CANCELLED' }),
    );

    const replacement = registry.begin(operation(requestId));
    registry.finish(replacement);
  });

  it('rejects a duplicate live outer request ID until the first operation finishes', () => {
    const registry = createAntigravityOperationRegistry();
    const requestId = randomUUID();
    const first = registry.begin(operation(requestId));

    expect(() => registry.begin(operation(requestId))).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_EXECUTION_FAILED' }),
    );

    registry.finish(first);
    const replacement = registry.begin(operation(requestId));
    registry.finish(replacement);
  });

  it('rejects duplicate and cross-operation child IDs', () => {
    const registry = createAntigravityOperationRegistry();
    const first = registry.begin(operation());
    const second = registry.begin(operation());
    const childId = randomUUID();
    const child = registry.reserveChild(first, childId);

    expect(() => registry.reserveChild(first, childId)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_EXECUTION_FAILED' }),
    );
    expect(() => registry.reserveChild(second, childId)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_EXECUTION_FAILED' }),
    );
    expect(() => registry.begin(operation(childId))).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_EXECUTION_FAILED' }),
    );

    registry.releaseChild(child);
    registry.finish(first);
    registry.finish(second);
  });

  it('requires explicit permission for an outer ID child and rejects active-ID collisions', () => {
    const registry = createAntigravityOperationRegistry();
    const first = registry.begin(operation());
    const second = registry.begin(operation());

    expect(() => registry.reserveChild(first, first.requestId)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_EXECUTION_FAILED' }),
    );
    expect(() => registry.reserveChild(first, second.requestId, true)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_EXECUTION_FAILED' }),
    );

    const outerChild = registry.reserveChild(first, first.requestId, true);
    expect(outerChild.requestId).toBe(first.requestId);
    registry.releaseChild(outerChild);
    registry.finish(first);
    registry.finish(second);
  });

  it('delivers repeated outer and source cancellation to every attached runner once', () => {
    const registry = createAntigravityOperationRegistry();
    const source = new AbortController();
    const active = registry.begin(operation(randomUUID(), source.signal));
    const first = registry.reserveChild(active, randomUUID());
    const second = registry.reserveChild(active, randomUUID());
    const firstRunner = new RecordingRunner();
    const secondRunner = new RecordingRunner();
    registry.attachRunner(first, firstRunner);
    registry.attachRunner(second, secondRunner);

    registry.cancel(active.requestId);
    registry.cancel(active.requestId);
    source.abort();

    expect(active.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(firstRunner.cancelled).toEqual([first.requestId]);
    expect(secondRunner.cancelled).toEqual([second.requestId]);
    expect(() => registry.assertActive(active)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_CANCELLED' }),
    );
    registry.finish(active);
  });

  it('records child cancellation before attach and delivers it once to a late runner', () => {
    const registry = createAntigravityOperationRegistry();
    const active = registry.begin(operation());
    const child = registry.reserveChild(active, randomUUID());
    const runner = new RecordingRunner();

    registry.cancel(child.requestId);
    registry.cancel(child.requestId);
    expect(child.signal.aborted).toBe(true);
    expect(active.signal.aborted).toBe(false);
    expect(runner.cancelled).toEqual([]);

    registry.attachRunner(child, runner);
    registry.cancel(child.requestId);
    expect(runner.cancelled).toEqual([child.requestId]);
    expect(() => registry.assertActive(active)).not.toThrow();

    registry.releaseChild(child);
    registry.finish(active);
  });

  it('does not notify a detached runner and cancels a replacement attached later', () => {
    const registry = createAntigravityOperationRegistry();
    const active = registry.begin(operation());
    const child = registry.reserveChild(active, randomUUID());
    const detached = new RecordingRunner();
    const replacement = new RecordingRunner();
    registry.attachRunner(child, detached);
    registry.detachRunner(child);

    registry.cancel(child.requestId);
    expect(detached.cancelled).toEqual([]);

    registry.attachRunner(child, replacement);
    registry.cancel(child.requestId);
    expect(detached.cancelled).toEqual([]);
    expect(replacement.cancelled).toEqual([child.requestId]);

    registry.releaseChild(child);
    registry.finish(active);
  });

  it('keeps cancellation authoritative when a runner cancel method throws', () => {
    const registry = createAntigravityOperationRegistry();
    const active = registry.begin(operation());
    const child = registry.reserveChild(active, randomUUID());
    const runner = new RecordingRunner();
    runner.cancelError = new Error('private runner failure');
    registry.attachRunner(child, runner);

    expect(() => registry.cancel(active.requestId)).not.toThrow();
    expect(runner.cancelled).toEqual([child.requestId]);
    expect(() => registry.assertActive(active)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_CANCELLED' }),
    );
    registry.finish(active);
  });

  it('removes the source listener and releases all IDs when finishing', () => {
    const registry = createAntigravityOperationRegistry();
    const source = new AbortController();
    const addListener = vi.spyOn(source.signal, 'addEventListener');
    const removeListener = vi.spyOn(source.signal, 'removeEventListener');
    const outerId = randomUUID();
    const childId = randomUUID();
    const active = registry.begin(operation(outerId, source.signal));
    const child = registry.reserveChild(active, childId);
    const runner = new RecordingRunner();
    registry.attachRunner(child, runner);
    const registeredListener = addListener.mock.calls.find(([type]) => type === 'abort')?.[1];

    registry.finish(active);
    source.abort();

    expect(registeredListener).toBeTypeOf('function');
    expect(removeListener).toHaveBeenCalledWith('abort', registeredListener);
    expect(runner.cancelled).toEqual([]);
    expect(() => registry.assertActive(active)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_EXECUTION_FAILED' }),
    );
    expect(() => registry.releaseChild(child)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_EXECUTION_FAILED' }),
    );

    const replacement = registry.begin(operation(outerId));
    const replacementChild = registry.reserveChild(replacement, childId);
    registry.releaseChild(replacementChild);
    registry.finish(replacement);
  });
});
