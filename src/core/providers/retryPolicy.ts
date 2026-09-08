import type { ProviderTextBlock } from '../ports/aiProvider';
import { normalizeProviderFailure, type ProviderFailure } from './providerErrors';

export const PROVIDER_RETRY_POLICY = Object.freeze({
  maxAttempts: 2,
  maxRetryAfterMs: 5_000,
  defaultDelayMs: 500,
});

export const FORMAT_REPAIR_BLOCK: ProviderTextBlock = Object.freeze({
  role: 'system',
  kind: 'format_repair',
  text: '이전 응답을 참조하지 말고, 요청된 JSON Schema에 맞는 JSON만 다시 생성하세요.',
});

export type ProviderRetry = Readonly<{
  attemptKind: 'transient_retry' | 'format_repair';
  delayMs: number;
}>;

export const classifyProviderRetry = (
  failure: ProviderFailure,
  attemptedCalls: number,
): ProviderRetry | null => {
  if (
    !Number.isSafeInteger(attemptedCalls) ||
    attemptedCalls < 0 ||
    attemptedCalls >= PROVIDER_RETRY_POLICY.maxAttempts
  ) {
    return null;
  }
  const normalized = normalizeProviderFailure(failure.publicError);
  if (normalized.category === 'format') {
    return Object.freeze({ attemptKind: 'format_repair', delayMs: 0 });
  }
  if (normalized.category !== 'transient') {
    return null;
  }
  return Object.freeze({
    attemptKind: 'transient_retry',
    delayMs: normalized.retryAfterMs ?? PROVIDER_RETRY_POLICY.defaultDelayMs,
  });
};
