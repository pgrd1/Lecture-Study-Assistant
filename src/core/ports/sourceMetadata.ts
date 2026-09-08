import type { SourceRecord } from '../../shared/contracts/sourceBundle';
import type { TrustedSourceMetadata } from '../../shared/contracts/sourceMetadata';

export interface SourceMetadataPort {
  measure(source: SourceRecord, signal?: AbortSignal): Promise<TrustedSourceMetadata>;
}
/** Only byte snapshots cross the parser/worker boundary, never source paths. */
export type MetadataByteInput = Readonly<{
  bytes: Uint8Array;
  extension: string;
  sha256: string;
  sizeBytes: number;
}>;
