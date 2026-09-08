import type { Job } from '../../shared/contracts/job';

export interface JobRepository {
  get(id: string): Job | null;
  list(): readonly Job[];
  listRecoverable(): readonly Job[];
  findByFingerprint(courseId: string, fingerprint: string): Job | null;
  insert(job: Job): Job;
  update(job: Job, expectedRevision: number): Job;
}
