import type {
  StudyContentInput,
  StudyContentProcessor,
} from '../../core/ports/studyContentProcessor';
import { parseExistingTopics } from '../../shared/contracts/studyContent';
import { snapshotContentAttempt } from './contentAttemptSnapshot';
import { LectureSynthesisService } from './lectureSynthesisService';
import { applyStudyVerification, LectureVerificationService } from './lectureVerificationService';
import { extractEvidencePipelineStages } from './pipelineOperations';
import { assertStudyJob, type StudyPipelineDependencies } from './studyPipelineOperations';
import { TopicClusteringService } from './topicClusteringService';

export class EvidencePipelineProcessor implements StudyContentProcessor {
  constructor(private readonly dependencies: StudyPipelineDependencies) {}
  async processBundle(input: StudyContentInput) {
    const attempt = snapshotContentAttempt(this.dependencies, input);
    input = attempt.input;
    const dependencies = attempt.dependencies;
    const sourceSnapshot = assertStudyJob(dependencies, input);
    const existingTopics = parseExistingTopics(input.existingTopics, input.courseId);
    const chain = await extractEvidencePipelineStages(dependencies, input);
    const upstream = [chain.classification, chain.extraction, chain.evidence];
    const stageInput = {
      input,
      existingTopics,
      evidence: chain.evidence,
      upstream,
      sourceSnapshot,
    };
    const clustering = await new TopicClusteringService(dependencies).cluster(stageInput);
    const synthesis = await new LectureSynthesisService(dependencies).synthesize(
      { ...stageInput, upstream: [...upstream, clustering] },
      clustering.value,
    );
    const verification = await new LectureVerificationService(dependencies).verify(
      { ...stageInput, upstream: [...upstream, clustering, synthesis] },
      clustering.value,
      synthesis.value,
    );
    return applyStudyVerification(
      synthesis.value,
      verification.value,
      chain.evidence.value.segments,
    );
  }
}
