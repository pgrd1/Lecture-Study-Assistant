import type {
  PipelineArtifact,
  PipelineArtifactIdentity,
  PipelineArtifactRead,
  PipelineArtifactWrite,
  PipelineStage,
} from '../../shared/contracts/pipelineArtifact';

export type PipelineArtifactWriteOptions = Readonly<{
  signal?: AbortSignal;
  /** Trusted application guard only. Runs after payload publication, immediately before pointer commit. */
  beforeCommit?: () => void | Promise<void>;
}>;

export interface PipelineArtifactStore {
  write(
    artifact: PipelineArtifactWrite,
    options?: PipelineArtifactWriteOptions,
  ): Promise<PipelineArtifact>;
  /** A miss includes stale identity. Corrupt committed checkpoints throw and never count as completed. */
  read(
    jobId: string,
    stage: PipelineStage,
    expectedIdentity: PipelineArtifactIdentity,
    expectedSchemaVersion?: 1 | 2,
  ): Promise<PipelineArtifactRead | null>;
}
