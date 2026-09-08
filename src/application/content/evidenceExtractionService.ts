import {
  type ContentPipelineDependencies,
  type ContentPipelineInput,
  extractEvidenceStage,
} from './pipelineOperations';

export class EvidenceExtractionService {
  constructor(private readonly dependencies: ContentPipelineDependencies) {}
  extractEvidence(input: ContentPipelineInput) {
    return extractEvidenceStage(this.dependencies, input);
  }
}
