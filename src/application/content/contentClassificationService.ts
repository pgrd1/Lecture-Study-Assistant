import {
  type ContentPipelineDependencies,
  type ContentPipelineInput,
  classifyStage,
} from './pipelineOperations';

export class ContentClassificationService {
  constructor(private readonly dependencies: ContentPipelineDependencies) {}
  classifySources(input: ContentPipelineInput) {
    return classifyStage(this.dependencies, input);
  }
}
