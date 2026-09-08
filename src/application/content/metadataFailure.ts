import { MetadataError, type MetadataErrorCode } from '../../infrastructure/metadata/metadataError';
import { APP_ERROR_MESSAGES, AppError, type AppErrorCode } from '../../shared/errors';

const codes = Object.freeze({
  METADATA_CANCELLED: 'PROVIDER_CANCELLED',
  METADATA_TIMEOUT: 'PROVIDER_TIMEOUT',
  METADATA_BUSY: 'PROVIDER_BUSY',
  METADATA_UNSUPPORTED: 'PROVIDER_MEDIA_UNSUPPORTED',
  METADATA_INVALID: 'PROVIDER_MEDIA_UNSUPPORTED',
  METADATA_LIMIT: 'SOURCE_TOO_LARGE',
  METADATA_IDENTITY: 'SOURCE_HASH_MISMATCH',
} satisfies Record<MetadataErrorCode, AppErrorCode>);

export const rethrowMetadataFailure = (error: unknown, signal: AbortSignal): never => {
  if (signal.aborted)
    throw new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED);
  if (error instanceof MetadataError && Object.hasOwn(codes, error.code)) {
    const code = codes[error.code];
    throw new AppError(code, APP_ERROR_MESSAGES[code]);
  }
  // Unknown exceptions retain their untrusted identity; never trust a lookalike `code`.
  throw error;
};
