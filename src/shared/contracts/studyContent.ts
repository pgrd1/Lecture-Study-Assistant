import { z } from 'zod';
import { assertBoundedPipelineJson } from './boundedPipelineJson';
import { SourceLocatorSchema } from './evidence';

const EvidenceIds = z
  .array(z.uuid())
  .max(1_000)
  .refine((v) => new Set(v).size === v.length)
  .readonly();
const Uncertainty = z.string().min(1).max(2_000).nullable();
export const TopicClusterSchema = z
  .strictObject({
    id: z.uuid(),
    title: z.string().min(1).max(500),
    evidenceIds: EvidenceIds,
    uncertainty: Uncertainty,
  })
  .readonly();
export type TopicCluster = z.infer<typeof TopicClusterSchema>;
export const validateTopicEvidence = (
  topics: readonly TopicCluster[],
  evidenceIds: readonly string[],
): readonly TopicCluster[] => {
  const parsed = TopicClustersSchema.parse({ topics }).topics;
  const known = new Set(z.array(z.uuid()).max(10_000).parse(evidenceIds));
  if (
    new Set(parsed.map((topic) => topic.id)).size !== parsed.length ||
    parsed.some((topic) => topic.evidenceIds.some((id) => !known.has(id)))
  )
    throw new TypeError('INVALID_TOPIC_EVIDENCE_REFERENCE');
  return parsed;
};
export const TopicClustersSchema = z
  .strictObject({ topics: z.array(TopicClusterSchema).max(1_000).readonly() })
  .readonly();
export const StudyClaimSchema = z
  .strictObject({
    id: z.uuid(),
    text: z.string().min(1).max(20_000),
    evidenceIds: EvidenceIds,
    status: z.enum(['source_supported', 'model_only', 'uncertain']),
    uncertainty: Uncertainty,
  })
  .refine((v) => v.status !== 'source_supported' || v.evidenceIds.length > 0)
  .readonly();
export const StudyContentResultSchema = z
  .strictObject({
    claims: z.array(StudyClaimSchema).max(10_000).readonly(),
    conflicts: z
      .array(
        z
          .strictObject({
            claimIds: z
              .array(z.uuid())
              .min(2)
              .max(100)
              .refine((ids) => new Set(ids).size === ids.length)
              .readonly(),
            description: z.string().min(1).max(2_000),
          })
          .readonly(),
      )
      .max(1_000)
      .readonly(),
    sessionDates: z.array(z.iso.date()).max(366).readonly(),
  })
  .superRefine((value, context) => {
    const ids = new Set(value.claims.map((c) => c.id));
    if (
      ids.size !== value.claims.length ||
      value.conflicts.some((c) => c.claimIds.some((id) => !ids.has(id)))
    )
      context.addIssue({ code: 'custom', message: 'INVALID_CLAIM_REFERENCE' });
  })
  .readonly();
export type LegacyStudyContentResult = z.infer<typeof StudyContentResultSchema>;
export const validateStudyEvidence = (
  result: LegacyStudyContentResult,
  evidenceIds: readonly string[],
): LegacyStudyContentResult => {
  const parsed = StudyContentResultSchema.parse(result);
  const known = new Set(z.array(z.uuid()).max(10_000).parse(evidenceIds));
  if (parsed.claims.some((c) => c.evidenceIds.some((id) => !known.has(id))))
    throw new TypeError('INVALID_STUDY_EVIDENCE_REFERENCE');
  return parsed;
};

// Artifact v1 remains readable above. New study stages use explicitly versioned payloads.
const Dates = z
  .array(z.iso.date())
  .max(366)
  .refine((v) => v.every((d, i) => i === 0 || d > (v[i - 1] ?? '')))
  .readonly();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ExistingTopicDescriptorSchema = z
  .strictObject({
    id: z.uuid(),
    courseId: z.uuid(),
    title: z.string().min(1).max(500),
    aliases: z.array(z.string().min(1).max(500)).max(20).readonly(),
    summary: z.string().max(8_000),
    sessionDates: Dates,
    acceptedContentSha256: Hash,
    provenance: z
      .array(z.strictObject({ sourceId: z.uuid(), evidenceIds: EvidenceIds }).readonly())
      .max(100)
      .readonly(),
  })
  .readonly();
export type ExistingTopicDescriptor = z.infer<typeof ExistingTopicDescriptorSchema>;
export const parseExistingTopics = (
  value: unknown,
  courseId: string,
): readonly ExistingTopicDescriptor[] => {
  assertBoundedPipelineJson(value);
  const topics = z.array(ExistingTopicDescriptorSchema).max(100).readonly().parse(value);
  if (
    new Set(topics.map((t) => t.id)).size !== topics.length ||
    topics.some((t) => t.courseId !== courseId)
  )
    throw new TypeError('INVALID_EXISTING_TOPICS');
  if (new TextEncoder().encode(JSON.stringify(topics)).length > 128_000)
    throw new TypeError('EXISTING_TOPIC_CONTEXT_TOO_LARGE');
  return topics;
};
export const TopicClusterV2Schema = z
  .strictObject({
    id: z.uuid(),
    title: z.string().min(1).max(500),
    action: z.enum(['create', 'merge']),
    existingTopicId: z.uuid().nullable(),
    evidenceIds: EvidenceIds,
    uncertainty: Uncertainty,
    sessionDates: Dates,
  })
  .refine(
    (t) =>
      t.evidenceIds.length > 0 &&
      (t.action === 'create' ? t.existingTopicId === null : t.existingTopicId !== null),
  )
  .readonly();
export const TopicClustersV2Schema = z
  .strictObject({
    contentSchemaVersion: z.literal(2),
    topics: z.array(TopicClusterV2Schema).min(1).max(100).readonly(),
  })
  .readonly();
export type TopicClustersV2 = z.infer<typeof TopicClustersV2Schema>;
export type TopicClusterV2 = z.infer<typeof TopicClusterV2Schema>;

export const STUDY_ITEM_FIELDS = Object.freeze([
  'outline',
  'explanations',
  'definitions',
  'formulas',
  'examples',
  'exceptions',
  'misconceptions',
  'professorSignals',
] as const);
const Items = z.array(StudyClaimSchema).max(100).readonly();
const Formula = z
  .strictObject({
    ...StudyClaimSchema.unwrap().shape,
    symbols: z
      .array(
        z
          .strictObject({
            symbol: z.string().min(1).max(100),
            meaning: z.string().min(1).max(500),
            unit: z.string().min(1).max(100).nullable(),
          })
          .readonly(),
      )
      .max(100)
      .readonly(),
    assumptions: z.array(z.string().min(1).max(2_000)).max(30).readonly(),
    conditions: z.array(z.string().min(1).max(2_000)).max(30).readonly(),
  })
  .readonly();
const ProfessorSignal = z
  .strictObject({
    ...StudyClaimSchema.unwrap().shape,
    observationKind: z.enum(['explicit_emphasis', 'repetition', 'worked_example', 'stated_scope']),
    inference: z.literal('observable_course_evidence'),
  })
  .readonly();
export const StudyConflictSchema = z
  .strictObject({
    ...StudyClaimSchema.unwrap().shape,
    alternatives: z
      .array(
        z
          .strictObject({ claimId: z.uuid(), sessionDate: z.iso.date(), evidenceIds: EvidenceIds })
          .readonly(),
      )
      .min(2)
      .max(20)
      .readonly(),
  })
  .readonly();
const Citation = z
  .strictObject({ evidenceId: z.uuid(), sourceId: z.uuid(), locator: SourceLocatorSchema })
  .readonly();
const StudyTopic = z
  .strictObject({
    cluster: TopicClusterV2Schema,
    contentMode: z.enum(['new_topic', 'merge_delta']),
    outline: Items,
    explanations: Items,
    definitions: Items,
    formulas: z.array(Formula).max(100).readonly(),
    examples: Items,
    exceptions: Items,
    misconceptions: Items,
    professorSignals: z.array(ProfessorSignal).max(100).readonly(),
    conflicts: z.array(StudyConflictSchema).max(100).readonly(),
    citations: z.array(Citation).max(1_000).readonly(),
    sessions: z
      .array(z.strictObject({ date: z.iso.date(), evidenceIds: EvidenceIds }).readonly())
      .max(366)
      .readonly(),
  })
  .refine((t) => t.contentMode === (t.cluster.action === 'merge' ? 'merge_delta' : 'new_topic'))
  .readonly();
export const StudyContentV2Schema = z
  .strictObject({
    contentSchemaVersion: z.literal(2),
    topics: z.array(StudyTopic).min(1).max(100).readonly(),
  })
  .readonly();
export type StudyContentV2 = z.infer<typeof StudyContentV2Schema>;
export type StudyItem = z.infer<typeof StudyClaimSchema>;
export const studyItems = (value: StudyContentV2): readonly StudyItem[] =>
  value.topics.flatMap((t) => [...STUDY_ITEM_FIELDS.flatMap((field) => t[field]), ...t.conflicts]);
export const StudyVerificationSchema = z
  .strictObject({
    verificationSchemaVersion: z.literal(1),
    decisions: z
      .array(
        z
          .strictObject({
            itemId: z.uuid(),
            decision: z.enum(['accept', 'reject']),
            reason: z.string().min(1).max(2_000),
            missingEvidenceIds: EvidenceIds,
          })
          .readonly(),
      )
      .max(10_000)
      .readonly(),
  })
  .readonly();
export type StudyVerification = z.infer<typeof StudyVerificationSchema>;
export const VerifiedStudyContentSchema = z
  .strictObject({
    ...StudyContentV2Schema.unwrap().shape,
    topics: z
      .array(
        z
          .strictObject({
            ...StudyTopic.unwrap().shape,
            title: z.string().min(1).max(500),
            action: z.enum(['create', 'merge']),
            existingTopicId: z.uuid().nullable(),
            sessionDates: Dates,
          })
          .refine(
            (t) =>
              t.title === t.cluster.title &&
              t.action === t.cluster.action &&
              t.existingTopicId === t.cluster.existingTopicId &&
              JSON.stringify(t.sessionDates) === JSON.stringify(t.cluster.sessionDates) &&
              t.contentMode === (t.action === 'merge' ? 'merge_delta' : 'new_topic'),
          )
          .readonly(),
      )
      .min(1)
      .max(100)
      .readonly(),
    verification: StudyVerificationSchema,
  })
  .readonly();
export type StudyContentResult = z.infer<typeof VerifiedStudyContentSchema>;
