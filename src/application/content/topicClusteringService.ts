import type { EvidenceSegment } from '../../shared/contracts/evidence';
import { assertBoundedPipelineJson } from '../../shared/contracts/pipelineArtifact';
import {
  type ExistingTopicDescriptor,
  TopicClustersV2Schema,
} from '../../shared/contracts/studyContent';
import { contentError } from './pipelineOperations';
import {
  runStudyStage,
  type StudyPipelineDependencies,
  type StudyStageInput,
} from './studyPipelineOperations';

export const canonicalDates = (dates: readonly (string | null | undefined)[]): readonly string[] =>
  Object.freeze([...new Set(dates.filter((d): d is string => typeof d === 'string'))].sort());

export const validateTopicClusters = (
  raw: unknown,
  evidence: readonly EvidenceSegment[],
  existing: readonly ExistingTopicDescriptor[],
) => {
  assertBoundedPipelineJson(raw);
  const result = TopicClustersV2Schema.parse(raw);
  const known = new Map(evidence.map((e) => [e.id, e]));
  const covered = new Set<string>();
  const targets = new Set<string>();
  if (new Set(result.topics.map((t) => t.id)).size !== result.topics.length) throw contentError();
  for (const topic of result.topics) {
    const parent = existing.find((t) => t.id === topic.existingTopicId);
    if (topic.action === 'merge' && (!parent || targets.has(parent.id))) throw contentError();
    if (parent) targets.add(parent.id);
    for (const id of topic.evidenceIds) {
      if (!known.has(id)) throw contentError();
      covered.add(id);
    }
    const dates = canonicalDates([
      ...topic.evidenceIds.map((id) => known.get(id)?.sessionDate),
      ...(parent?.sessionDates ?? []),
    ]);
    if (JSON.stringify(dates) !== JSON.stringify(topic.sessionDates)) throw contentError();
  }
  if (covered.size !== known.size) throw contentError();
  return result;
};

export class TopicClusteringService {
  constructor(private readonly dependencies: StudyPipelineDependencies) {}
  cluster(input: StudyStageInput) {
    return runStudyStage(this.dependencies, input, {
      stage: 'clustering',
      feature: 'topic_clustering',
      schemaId: 'topic_clusters_v2',
      schema: TopicClustersV2Schema,
      instructions:
        'Cluster the complete evidence bundle by topic across upload boundaries. Cover every evidence ID, allowing shared evidence. Create or merge only known existing same-course topic IDs. Merge dates are the union of prior and referenced evidence dates. Unclassified or uncertain clusters are allowed. Return contentSchemaVersion 2.',
      context: { evidence: input.evidence.value, existingTopics: input.existingTopics },
      validate: (value) =>
        validateTopicClusters(value, input.evidence.value.segments, input.existingTopics),
    });
  }
}
