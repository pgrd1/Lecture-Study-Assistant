import { sha256CanonicalJson } from '../../core/providers/canonicalJson';
import type { EvidenceSegment } from '../../shared/contracts/evidence';
import { assertBoundedPipelineJson } from '../../shared/contracts/pipelineArtifact';
import {
  STUDY_ITEM_FIELDS,
  StudyContentV2Schema,
  studyItems,
  type TopicClustersV2,
} from '../../shared/contracts/studyContent';
import { contentError } from './pipelineOperations';
import {
  runStudyStage,
  type StudyPipelineDependencies,
  type StudyStageInput,
} from './studyPipelineOperations';

export const validateStudyCandidate = (
  raw: unknown,
  evidence: readonly EvidenceSegment[],
  clusters: TopicClustersV2,
) => {
  assertBoundedPipelineJson(raw);
  const result = StudyContentV2Schema.parse(raw);
  const known = new Map(evidence.map((e) => [e.id, e]));
  const items = studyItems(result);
  if (
    items.length > 10_000 ||
    new Set(items.map((i) => i.id)).size !== items.length ||
    result.topics.length !== clusters.topics.length
  )
    throw contentError();
  result.topics.forEach((topic, index) => {
    if (sha256CanonicalJson(topic.cluster) !== sha256CanonicalJson(clusters.topics[index]))
      throw contentError();
    const own = [...STUDY_ITEM_FIELDS.flatMap((field) => topic[field]), ...topic.conflicts];
    const ownIds = new Map(own.map((item) => [item.id, item]));
    const used = new Set(own.flatMap((item) => item.evidenceIds));
    if (
      own.some(
        (item) =>
          (item.status === 'source_supported' && item.evidenceIds.length === 0) ||
          item.evidenceIds.some((id) => !topic.cluster.evidenceIds.includes(id) || !known.has(id)),
      )
    )
      throw contentError();
    if (
      topic.citations.length !== used.size ||
      new Set(topic.citations.map((c) => c.evidenceId)).size !== used.size
    )
      throw contentError();
    for (const citation of topic.citations) {
      const source = known.get(citation.evidenceId);
      if (
        !used.has(citation.evidenceId) ||
        !source ||
        citation.sourceId !== source.sourceId ||
        sha256CanonicalJson(citation.locator) !== sha256CanonicalJson(source.locator)
      )
        throw contentError();
    }
    if (
      JSON.stringify(topic.sessions.map((s) => s.date)) !==
      JSON.stringify(topic.cluster.sessionDates)
    )
      throw contentError();
    for (const session of topic.sessions) {
      const expected = topic.cluster.evidenceIds
        .filter((id) => known.get(id)?.sessionDate === session.date)
        .sort();
      if (JSON.stringify([...session.evidenceIds].sort()) !== JSON.stringify(expected))
        throw contentError();
    }
    for (const conflict of topic.conflicts) {
      if (
        new Set(conflict.alternatives.map((a) => a.claimId)).size !== conflict.alternatives.length
      )
        throw contentError();
      for (const alternative of conflict.alternatives) {
        const claim = ownIds.get(alternative.claimId);
        if (
          !claim ||
          topic.conflicts.some((c) => c.id === claim.id) ||
          alternative.evidenceIds.length === 0 ||
          alternative.evidenceIds.some(
            (id) =>
              !claim.evidenceIds.includes(id) ||
              !conflict.evidenceIds.includes(id) ||
              known.get(id)?.sessionDate !== alternative.sessionDate,
          )
        )
          throw contentError();
      }
    }
    for (const signal of topic.professorSignals) {
      if (
        signal.evidenceIds.length === 0 ||
        signal.evidenceIds.some(
          (id) => !['emphasis', 'observation', 'example'].includes(known.get(id)?.kind ?? ''),
        )
      )
        throw contentError();
      if (
        /(?:personality|sensitive inference|exam guarantee|성격|민감정보|시험.{0,8}(?:보장|반드시))/iu.test(
          signal.text,
        )
      )
        throw contentError();
    }
  });
  return result;
};

export class LectureSynthesisService {
  constructor(private readonly dependencies: StudyPipelineDependencies) {}
  synthesize(input: StudyStageInput, clusters: TopicClustersV2) {
    return runStudyStage(this.dependencies, input, {
      stage: 'synthesis',
      feature: 'lecture_organize',
      schemaId: 'study_content_v2',
      schema: StudyContentV2Schema,
      instructions:
        'Produce structured candidate items with unique UUIDs and exact evidence IDs. Preserve Korean/English terms, numbers, formulas, units, conditions and assumptions. Copy cluster provenance exactly. Creates are new_topic; merges are merge_delta, preserving prior accepted material downstream. Include dated alternatives for conflicts. Professor signals must cite observable emphasis, observation or examples, never infer personality, sensitive traits or guaranteed exams. Citations exactly resolve used evidence IDs; sessions contain all cluster dates and matching current evidence. Do not treat model_only material as verified.',
      context: { evidence: input.evidence.value, clusters, existingTopics: input.existingTopics },
      validate: (value) => validateStudyCandidate(value, input.evidence.value.segments, clusters),
    });
  }
}
