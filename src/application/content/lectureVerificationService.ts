import type { EvidenceSegment } from '../../shared/contracts/evidence';
import { assertBoundedPipelineJson } from '../../shared/contracts/pipelineArtifact';
import {
  STUDY_ITEM_FIELDS,
  type StudyContentV2,
  StudyVerificationSchema,
  studyItems,
  type TopicClustersV2,
  VerifiedStudyContentSchema,
} from '../../shared/contracts/studyContent';
import { contentError } from './pipelineOperations';
import {
  runStudyStage,
  type StudyPipelineDependencies,
  type StudyStageInput,
} from './studyPipelineOperations';

export const validateStudyVerification = (
  raw: unknown,
  candidate: StudyContentV2,
  evidence: readonly EvidenceSegment[],
) => {
  assertBoundedPipelineJson(raw);
  const result = StudyVerificationSchema.parse(raw);
  const items = new Set(studyItems(candidate).map((item) => item.id));
  const known = new Set(evidence.map((e) => e.id));
  if (
    result.decisions.length !== items.size ||
    new Set(result.decisions.map((d) => d.itemId)).size !== items.size ||
    result.decisions.some(
      (d) => !items.has(d.itemId) || d.missingEvidenceIds.some((id) => !known.has(id)),
    )
  )
    throw contentError();
  return result;
};

export class LectureVerificationService {
  constructor(private readonly dependencies: StudyPipelineDependencies) {}
  verify(input: StudyStageInput, clusters: TopicClustersV2, candidate: StudyContentV2) {
    return runStudyStage(this.dependencies, input, {
      stage: 'verification',
      feature: 'lecture_verify',
      schemaId: 'study_verification_v1',
      schema: StudyVerificationSchema,
      instructions:
        'Independently verify every candidate item UUID exactly once, including conflicts. Return only accept/reject decisions, reasons and missingEvidenceIds (only IDs present in this bundle). Reject unsupported or model_only items; reject professor personality/sensitive inference/exam guarantees. Check all cited evidence, dates, formula assumptions and conditions. Do not rewrite candidate prose. Return verificationSchemaVersion 1.',
      context: {
        evidence: input.evidence.value,
        clusters,
        existingTopics: input.existingTopics,
        candidate,
      },
      validate: (value) =>
        validateStudyVerification(value, candidate, input.evidence.value.segments),
    });
  }
}

export const applyStudyVerification = (
  candidate: StudyContentV2,
  raw: unknown,
  evidence: readonly EvidenceSegment[],
) => {
  const verification = validateStudyVerification(raw, candidate, evidence);
  const known = new Set(evidence.map((e) => e.id));
  const decisions = new Map(verification.decisions.map((d) => [d.itemId, d]));
  const accepted = new Set(
    studyItems(candidate)
      .filter((item) => {
        const decision = decisions.get(item.id);
        return (
          decision?.decision === 'accept' &&
          decision.missingEvidenceIds.length === 0 &&
          item.status === 'source_supported' &&
          item.evidenceIds.length > 0 &&
          item.evidenceIds.every((id) => known.has(id))
        );
      })
      .map((item) => item.id),
  );
  const topics = candidate.topics.map((topic) => {
    const fields = Object.fromEntries(
      STUDY_ITEM_FIELDS.map((field) => [
        field,
        topic[field].filter((item) => accepted.has(item.id)),
      ]),
    );
    const conflicts = topic.conflicts.filter(
      (item) => accepted.has(item.id) && item.alternatives.every((a) => accepted.has(a.claimId)),
    );
    const evidenceIds = new Set(
      [
        ...STUDY_ITEM_FIELDS.flatMap((field) =>
          topic[field].filter((item) => accepted.has(item.id)),
        ),
        ...conflicts,
      ].flatMap((item) => item.evidenceIds),
    );
    return {
      ...topic,
      title: topic.cluster.title,
      action: topic.cluster.action,
      existingTopicId: topic.cluster.existingTopicId,
      sessionDates: [...topic.cluster.sessionDates],
      ...fields,
      conflicts,
      citations: topic.citations.filter((c) => evidenceIds.has(c.evidenceId)),
    };
  });
  // Final text is selected unchanged from the candidate. The verifier never authors final content.
  return VerifiedStudyContentSchema.parse({ contentSchemaVersion: 2, topics, verification });
};
