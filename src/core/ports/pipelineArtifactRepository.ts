import type { PipelineArtifact, PipelineStage } from '../../shared/contracts/pipelineArtifact';

/** Metadata pointers only: callers must publish and validate the immutable payload before put. */
export interface PipelineArtifactRepository {
  get(jobId: string, stage: PipelineStage): PipelineArtifact | null;
  put(artifact: PipelineArtifact): PipelineArtifact;
}
