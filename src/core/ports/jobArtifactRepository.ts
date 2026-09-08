import type { JobArtifact, JobArtifactKind } from '../../shared/contracts/jobArtifact';

export interface JobArtifactRepository {
  get(jobId: string, kind: JobArtifactKind): JobArtifact | null;
  listByJob(jobId: string): readonly JobArtifact[];
  insert(artifact: JobArtifact): JobArtifact;
}
