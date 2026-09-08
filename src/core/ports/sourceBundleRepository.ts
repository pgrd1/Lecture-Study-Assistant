import type { Job } from '../../shared/contracts/job';
import type { SourceBundle, SourceRecord } from '../../shared/contracts/sourceBundle';

export interface SourceBundleRepository {
  insert(bundle: SourceBundle, records: readonly SourceRecord[]): SourceBundle;
  insertJobWithBundle(job: Job, bundle: SourceBundle, records: readonly SourceRecord[]): Job;
  attachLegacyBundle(job: Job, bundle: SourceBundle, records: readonly SourceRecord[]): Job;
  getByJobId(jobId: string): SourceBundle | null;
  listRecords(bundleId: string): readonly SourceRecord[];
}
