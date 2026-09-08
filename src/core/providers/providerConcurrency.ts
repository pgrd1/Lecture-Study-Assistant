import { type AiProviderId, CLI_PROVIDER_IDS } from '../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

export type ProviderConcurrencyLease = Readonly<{ release(): void }>;

type QueueEntry = Readonly<{
  id: symbol;
  signal: AbortSignal;
  resolve: (lease: ProviderConcurrencyLease) => void;
  reject: (error: AppError) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
}>;

type ProviderState = Readonly<{
  active: number;
  queue: readonly QueueEntry[];
}>;

const concurrencyError = (code: 'PROVIDER_BUSY' | 'PROVIDER_CANCELLED'): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);

export class ProviderConcurrency {
  readonly #queueTimeoutMs: number;
  readonly #states = new Map<AiProviderId, ProviderState>();
  #stopped = false;

  constructor(queueTimeoutMs = 30_000) {
    this.#queueTimeoutMs = queueTimeoutMs;
  }

  acquire(providerId: AiProviderId, signal: AbortSignal): Promise<ProviderConcurrencyLease> {
    if (this.#stopped || signal.aborted) {
      return Promise.reject(concurrencyError('PROVIDER_CANCELLED'));
    }
    const state = this.#state(providerId);
    if (state.active < this.#limit(providerId)) {
      this.#states.set(providerId, Object.freeze({ ...state, active: state.active + 1 }));
      return Promise.resolve(this.#lease(providerId));
    }

    return new Promise<ProviderConcurrencyLease>((resolve, reject) => {
      const id = Symbol(providerId);
      const removeAndReject = (error: AppError): void => {
        const current = this.#state(providerId);
        const entry = current.queue.find((candidate) => candidate.id === id);
        if (entry === undefined) return;
        clearTimeout(entry.timer);
        signal.removeEventListener('abort', entry.onAbort);
        this.#states.set(
          providerId,
          Object.freeze({
            ...current,
            queue: Object.freeze(current.queue.filter((item) => item.id !== id)),
          }),
        );
        reject(error);
      };
      const onAbort = (): void => removeAndReject(concurrencyError('PROVIDER_CANCELLED'));
      const timer = setTimeout(
        () => removeAndReject(concurrencyError('PROVIDER_BUSY')),
        this.#queueTimeoutMs,
      );
      const entry: QueueEntry = Object.freeze({ id, signal, resolve, reject, timer, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
      const current = this.#state(providerId);
      this.#states.set(
        providerId,
        Object.freeze({ ...current, queue: Object.freeze([...current.queue, entry]) }),
      );
    });
  }

  shutdown(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const [providerId, state] of this.#states) {
      for (const entry of state.queue) {
        clearTimeout(entry.timer);
        entry.signal.removeEventListener('abort', entry.onAbort);
        entry.reject(concurrencyError('PROVIDER_CANCELLED'));
      }
      this.#states.set(providerId, Object.freeze({ ...state, queue: Object.freeze([]) }));
    }
  }

  #lease(providerId: AiProviderId): ProviderConcurrencyLease {
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.#release(providerId);
      },
    });
  }

  #limit(providerId: AiProviderId): number {
    return CLI_PROVIDER_IDS.includes(providerId as (typeof CLI_PROVIDER_IDS)[number]) ? 1 : 2;
  }

  #release(providerId: AiProviderId): void {
    const state = this.#state(providerId);
    const nextActive = Math.max(0, state.active - 1);
    const next = state.queue[0];
    if (next === undefined || this.#stopped) {
      this.#states.set(providerId, Object.freeze({ ...state, active: nextActive }));
      return;
    }
    clearTimeout(next.timer);
    next.signal.removeEventListener('abort', next.onAbort);
    this.#states.set(
      providerId,
      Object.freeze({ active: nextActive + 1, queue: Object.freeze(state.queue.slice(1)) }),
    );
    next.resolve(this.#lease(providerId));
  }

  #state(providerId: AiProviderId): ProviderState {
    return this.#states.get(providerId) ?? Object.freeze({ active: 0, queue: Object.freeze([]) });
  }
}
