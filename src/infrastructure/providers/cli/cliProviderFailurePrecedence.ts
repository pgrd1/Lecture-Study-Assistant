import { AppError } from '../../../shared/errors';

const CLI_PROVIDER_FAILURE_PRECEDENCE = Object.freeze({
  default: 0,
  PROVIDER_RESIDUAL_DATA: 1,
} as const);

const precedenceOf = (failure: unknown): number =>
  AppError.isTrusted(failure) && failure.code === 'PROVIDER_RESIDUAL_DATA'
    ? CLI_PROVIDER_FAILURE_PRECEDENCE.PROVIDER_RESIDUAL_DATA
    : CLI_PROVIDER_FAILURE_PRECEDENCE.default;

export const selectCliProviderFailure = (current: unknown | undefined, next: unknown): unknown =>
  current !== undefined && precedenceOf(current) > precedenceOf(next) ? current : next;
