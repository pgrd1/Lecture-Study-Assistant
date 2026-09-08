import { describe, expect, it } from 'vitest';
import { normalizeProviderFailure } from '../../../../src/core/providers/providerErrors';
import {
  classifyProviderRetry,
  FORMAT_REPAIR_BLOCK,
  PROVIDER_RETRY_POLICY,
} from '../../../../src/core/providers/retryPolicy';
import { APP_ERROR_MESSAGES, AppError, type AppErrorCode } from '../../../../src/shared/errors';

const failure = (code: AppErrorCode, retryAfterMs: number | null = null) =>
  normalizeProviderFailure(
    new AppError(code, APP_ERROR_MESSAGES[code], {
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    }),
  );

describe('provider retry policy', () => {
  it.each([
    ['PROVIDER_RATE_LIMITED', 'transient_retry'],
    ['PROVIDER_TIMEOUT', 'transient_retry'],
    ['PROVIDER_NETWORK_FAILED', 'transient_retry'],
    ['PROVIDER_TEMPORARILY_UNAVAILABLE', 'transient_retry'],
    ['PROVIDER_OUTPUT_INVALID', 'format_repair'],
  ] as const)('selects the sole allowed retry kind for %s', (code, attemptKind) => {
    expect(classifyProviderRetry(failure(code), 1)).toMatchObject({ attemptKind });
  });

  it.each([
    'PROVIDER_BUSY',
    'PROVIDER_AUTH_REQUIRED',
    'PROVIDER_QUOTA_OR_BILLING',
    'PROVIDER_MODEL_INCOMPATIBLE',
    'PROVIDER_CANCELLED',
  ] as const)('does not automatically retry %s', (code) => {
    expect(classifyProviderRetry(failure(code), 0)).toBeNull();
  });

  it('caps automatic attempts at two and Retry-After at five seconds', () => {
    expect(classifyProviderRetry(failure('PROVIDER_RATE_LIMITED', 99_999), 2)).toBeNull();
    expect(classifyProviderRetry(failure('PROVIDER_RATE_LIMITED', 99_999), 1)).toEqual({
      attemptKind: 'transient_retry',
      delayMs: 5_000,
    });
    expect(PROVIDER_RETRY_POLICY.maxAttempts).toBe(2);
  });

  it('does not trust a forged retry category or unbounded delay', () => {
    const forged = {
      publicError: new AppError(
        'PROVIDER_AUTH_REQUIRED',
        APP_ERROR_MESSAGES.PROVIDER_AUTH_REQUIRED,
      ),
      category: 'transient',
      retryAfterMs: 99_999,
    } as const;

    expect(classifyProviderRetry(forged, 1)).toBeNull();
  });

  it('ignores a forged ProviderFailure delay when the trusted AppError has no hint', () => {
    const forged = {
      publicError: new AppError(
        'PROVIDER_NETWORK_FAILED',
        APP_ERROR_MESSAGES.PROVIDER_NETWORK_FAILED,
      ),
      category: 'transient',
      retryAfterMs: 4_999,
    } as const;

    expect(classifyProviderRetry(forged, 1)).toEqual({
      attemptKind: 'transient_retry',
      delayMs: PROVIDER_RETRY_POLICY.defaultDelayMs,
    });
  });

  it('uses a fixed Korean format-repair instruction without vendor output', () => {
    expect(FORMAT_REPAIR_BLOCK).toEqual({
      role: 'system',
      kind: 'format_repair',
      text: '이전 응답을 참조하지 말고, 요청된 JSON Schema에 맞는 JSON만 다시 생성하세요.',
    });
  });
});
