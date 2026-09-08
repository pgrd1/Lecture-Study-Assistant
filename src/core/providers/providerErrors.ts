import {
  APP_ERROR_MESSAGES,
  AppError,
  type ProviderErrorCode,
  ProviderErrorCodeSchema,
} from '../../shared/errors';

export const PROVIDER_FAILURE_CATEGORIES = Object.freeze([
  'busy',
  'transient',
  'format',
  'cancelled',
  'permanent',
] as const);
export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORIES)[number];

export type ProviderFailure = Readonly<{
  publicError: AppError;
  category: ProviderFailureCategory;
  retryAfterMs: number | null;
}>;

const categoryFor = (code: ProviderErrorCode): ProviderFailureCategory => {
  switch (code) {
    case 'PROVIDER_BUSY':
      return 'busy';
    case 'PROVIDER_NETWORK_FAILED':
    case 'PROVIDER_RATE_LIMITED':
    case 'PROVIDER_TEMPORARILY_UNAVAILABLE':
    case 'PROVIDER_TIMEOUT':
      return 'transient';
    case 'PROVIDER_OUTPUT_INVALID':
      return 'format';
    case 'PROVIDER_CANCELLED':
      return 'cancelled';
    default:
      return 'permanent';
  }
};

export const normalizeProviderFailure = (error: unknown): ProviderFailure => {
  const parsedCode = AppError.isTrusted(error)
    ? ProviderErrorCodeSchema.safeParse(error.code)
    : null;
  const providerCode = parsedCode?.success ? parsedCode.data : 'PROVIDER_EXECUTION_FAILED';
  const publicError =
    parsedCode?.success && AppError.isTrusted(error)
      ? error
      : new AppError(providerCode, APP_ERROR_MESSAGES[providerCode]);
  return Object.freeze({
    publicError,
    category: categoryFor(providerCode),
    retryAfterMs: AppError.getRetryAfterMs(publicError),
  });
};
