import type { CourseProvisioningInput } from '../../shared/contracts/course';
import type { ICloudSourceKind, SourceMediaType } from '../../shared/contracts/job';
import type {
  NormalizedSourceBundleManifest,
  QueueManifest,
  RejectionReceipt,
  StatusReceipt,
} from '../../shared/contracts/queue';

export type ReadyQueueItem = Readonly<{
  jobId: string;
  claimToken: string;
  sourceKind: ICloudSourceKind;
}>;

export type ClaimedSourceRecord = Readonly<{
  id: string;
  mediaType: SourceMediaType;
  ordinal: number;
  originalFileName: string;
  sha256: string;
  sizeBytes: number;
  stagedPath: string;
}>;

export type ClaimedSourceBundle = Readonly<{
  manifest: NormalizedSourceBundleManifest;
  courseProvisioning: CourseProvisioningInput | null;
  sourceKind: ICloudSourceKind;
  queueItemPath: string;
  stagingDirectoryPath: string;
  sources: readonly ClaimedSourceRecord[];
}>;

/** @deprecated Legacy consumers still read the first source through these aliases. */
export type ClaimedSource = ClaimedSourceBundle &
  Readonly<{
    manifest: NormalizedSourceBundleManifest & QueueManifest;
    stagedSourcePath: string;
    sourceSha256: string;
  }>;

export interface QueuePort {
  scanReady(): Promise<readonly ReadyQueueItem[]>;
  claim(item: ReadyQueueItem, stagingRoot: string): Promise<ClaimedSource>;
  writeReceipt(receipt: StatusReceipt): Promise<void>;
  writeRejection(receipt: RejectionReceipt): Promise<void>;
  removeCompleted(jobId: string, sourceKind: ICloudSourceKind): Promise<void>;
}
