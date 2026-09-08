export type MetadataErrorCode =
  | 'METADATA_IDENTITY'
  | 'METADATA_UNSUPPORTED'
  | 'METADATA_INVALID'
  | 'METADATA_LIMIT'
  | 'METADATA_CANCELLED'
  | 'METADATA_TIMEOUT'
  | 'METADATA_BUSY';
export class MetadataError extends Error {
  constructor(readonly code: MetadataErrorCode) {
    super(code);
    this.name = 'MetadataError';
  }
}
export const invalid = (): never => {
  throw new MetadataError('METADATA_INVALID');
};
export const limit = (): never => {
  throw new MetadataError('METADATA_LIMIT');
};
