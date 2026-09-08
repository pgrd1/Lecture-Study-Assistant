import {
  type ContentPipelineDependencies,
  type ContentPipelineInput,
  extractSourcesStage,
} from './pipelineOperations';

export class SourceExtractionService {
  constructor(private readonly dependencies: ContentPipelineDependencies) {}
  extractSources(input: ContentPipelineInput) {
    return extractSourcesStage(this.dependencies, input);
  }
}
