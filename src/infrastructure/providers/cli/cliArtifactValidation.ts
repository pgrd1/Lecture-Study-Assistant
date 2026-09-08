import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';

const assertActive = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED);
  }
};

export const runCliArtifactValidation = async (
  signal: AbortSignal,
  validation: (signal: AbortSignal) => Promise<void>,
): Promise<void> => {
  assertActive(signal);
  await validation(signal);
  assertActive(signal);
};
