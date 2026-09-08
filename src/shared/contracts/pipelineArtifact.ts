import { z } from 'zod';
import {
  ContentClassificationResultSchema,
  ContentClassificationSchema,
} from './contentClassification';
import { EvidenceSegmentsSchema } from './evidence';
import { AI_FEATURES, AI_PROVIDER_IDS, ProviderRouteSchema } from './provider';
import {
  StudyContentResultSchema,
  StudyContentV2Schema,
  StudyVerificationSchema,
  TopicClustersSchema,
  TopicClustersV2Schema,
} from './studyContent';

export const PIPELINE_STAGES = Object.freeze([
  'classification',
  'extraction',
  'evidence',
  'clustering',
  'synthesis',
  'verification',
] as const);
export const PipelineStageSchema = z.enum(PIPELINE_STAGES);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export {
  assertBoundedPipelineJson,
  PIPELINE_ARTIFACT_MAX_BYTES,
  PIPELINE_ARTIFACT_MAX_DEPTH,
  PIPELINE_ARTIFACT_MAX_NODES,
} from './boundedPipelineJson';

export const LegacyPipelineArtifactIdentitySchema = z
  .strictObject({
    sources: z
      .array(z.strictObject({ sourceId: z.uuid(), sha256: Hash }).readonly())
      .min(1)
      .max(32)
      .refine((values) => new Set(values.map((v) => v.sourceId)).size === values.length)
      .readonly(),
    upstream: z
      .array(z.strictObject({ stage: PipelineStageSchema, sha256: Hash }).readonly())
      .max(6)
      .refine((values) => new Set(values.map((v) => v.stage)).size === values.length)
      .readonly(),
    prompt: z
      .strictObject({
        id: z.string().min(1).max(160),
        version: z.string().min(1).max(160),
        sha256: Hash,
      })
      .readonly(),
    route: z
      .strictObject({
        feature: z.enum(AI_FEATURES),
        providerId: z.enum(AI_PROVIDER_IDS),
        modelId: z.string().min(1).max(160),
        revision: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .readonly(),
  })
  .readonly();
export const LegacyPipelineStageIdentitySchema = z
  .strictObject({
    identityVersion: z.literal(2),
    operationVersion: z.literal('content-stages-v1'),
    sources: z
      .array(
        z
          .strictObject({
            sourceId: z.uuid(),
            sha256: Hash,
            metadata: z
              .strictObject({
                parserVersion: z.string().min(1).max(200),
                policyVersion: z.string().min(1).max(160),
                factsSha256: Hash,
              })
              .readonly(),
          })
          .readonly(),
      )
      .min(1)
      .max(32)
      .refine((v) => new Set(v.map((s) => s.sourceId)).size === v.length)
      .readonly(),
    upstream: LegacyPipelineArtifactIdentitySchema.unwrap().shape.upstream,
    operations: z
      .array(
        z
          .strictObject({
            sourceId: z.uuid(),
            prompt: LegacyPipelineArtifactIdentitySchema.unwrap().shape.prompt,
            route: ProviderRouteSchema,
          })
          .readonly(),
      )
      .min(1)
      .max(32)
      .readonly(),
  })
  .refine(
    (v) =>
      v.operations.length === v.sources.length &&
      v.operations.every((op, i) => op.sourceId === v.sources[i]?.sourceId),
  )
  .readonly();
export const PipelineStageIdentitySchema = z
  .strictObject({
    ...LegacyPipelineStageIdentitySchema.unwrap().shape,
    identityVersion: z.literal(4),
    operationVersion: z.literal('content-stages-v2'),
    contextSha256: Hash,
  })
  .refine(
    (v) =>
      v.operations.length === v.sources.length &&
      v.operations.every((op, i) => op.sourceId === v.sources[i]?.sourceId),
  )
  .readonly();
export type PipelineStageIdentity = z.infer<typeof PipelineStageIdentitySchema>;
export const LegacyStudyStageIdentitySchema = z
  .strictObject({
    identityVersion: z.literal(3),
    operationVersion: z.literal('study-stages-v1'),
    sources: PipelineStageIdentitySchema.unwrap().shape.sources,
    upstream: LegacyPipelineArtifactIdentitySchema.unwrap().shape.upstream,
    existingTopicContextSha256: Hash,
    operation: z
      .strictObject({
        sourceIds: z.array(z.uuid()).min(1).max(32).readonly(),
        prompt: LegacyPipelineArtifactIdentitySchema.unwrap().shape.prompt,
        route: ProviderRouteSchema,
      })
      .readonly(),
  })
  .refine(
    (v) =>
      v.sources.length === v.operation.sourceIds.length &&
      v.sources.every((s, i) => s.sourceId === v.operation.sourceIds[i]),
  )
  .readonly();
export const StudyStageIdentitySchema = z
  .strictObject({
    ...LegacyStudyStageIdentitySchema.unwrap().shape,
    identityVersion: z.literal(5),
    operationVersion: z.literal('study-stages-v2'),
    contextSha256: Hash,
  })
  .refine(
    (v) =>
      v.sources.length === v.operation.sourceIds.length &&
      v.sources.every((s, i) => s.sourceId === v.operation.sourceIds[i]),
  )
  .readonly();
export type StudyStageIdentity = z.infer<typeof StudyStageIdentitySchema>;
export const PipelineArtifactIdentitySchema = z.union([
  LegacyPipelineArtifactIdentitySchema,
  LegacyPipelineStageIdentitySchema,
  LegacyStudyStageIdentitySchema,
  PipelineStageIdentitySchema,
  StudyStageIdentitySchema,
]);
export type PipelineArtifactIdentity = z.infer<typeof PipelineArtifactIdentitySchema>;

export const PipelineOperationReceiptsSchema = z
  .array(
    z
      .strictObject({
        sourceId: z.uuid(),
        requestId: z.uuid(),
      })
      .readonly(),
  )
  .min(1)
  .max(32)
  .refine((v) => new Set(v.map((r) => r.requestId)).size === v.length)
  .readonly();
export type PipelineOperationReceipts = z.infer<typeof PipelineOperationReceiptsSchema>;
export const PipelineBundleReceiptSchema = z
  .strictObject({
    sourceIds: z
      .array(z.uuid())
      .min(1)
      .max(32)
      .refine((v) => new Set(v).size === v.length)
      .readonly(),
    requestId: z.uuid(),
  })
  .readonly();
export type PipelineBundleReceipt = z.infer<typeof PipelineBundleReceiptSchema>;

const Envelope = z.strictObject({
  jobId: z.uuid(),
  schemaVersion: z.literal(1),
  identity: PipelineArtifactIdentitySchema,
  operationReceipts: PipelineOperationReceiptsSchema.optional(),
});
const StudyEnvelope = z.strictObject({
  jobId: z.uuid(),
  schemaVersion: z.literal(1),
  identity: z.union([LegacyStudyStageIdentitySchema, StudyStageIdentitySchema]),
  bundleReceipt: PipelineBundleReceiptSchema,
});
export const PipelineArtifactWriteSchema = z
  .union([
    StudyEnvelope.extend({
      stage: z.literal('clustering'),
      value: TopicClustersV2Schema,
    }).readonly(),
    StudyEnvelope.extend({ stage: z.literal('synthesis'), value: StudyContentV2Schema }).readonly(),
    StudyEnvelope.extend({
      stage: z.literal('verification'),
      value: StudyVerificationSchema,
    }).readonly(),
    Envelope.extend({
      stage: z.literal('classification'),
      value: ContentClassificationSchema,
    }).readonly(),
    Envelope.extend({
      stage: z.literal('classification'),
      schemaVersion: z.literal(2),
      identity: z.union([LegacyPipelineStageIdentitySchema, PipelineStageIdentitySchema]),
      value: ContentClassificationResultSchema,
    }).readonly(),
    Envelope.extend({ stage: z.literal('extraction'), value: EvidenceSegmentsSchema }).readonly(),
    Envelope.extend({ stage: z.literal('evidence'), value: EvidenceSegmentsSchema }).readonly(),
    Envelope.extend({ stage: z.literal('clustering'), value: TopicClustersSchema }).readonly(),
    Envelope.extend({ stage: z.literal('synthesis'), value: StudyContentResultSchema }).readonly(),
    Envelope.extend({
      stage: z.literal('verification'),
      value: StudyContentResultSchema,
    }).readonly(),
  ])
  .refine((v) => {
    const identity = v.identity;
    if ('operation' in identity)
      return (
        'bundleReceipt' in v &&
        JSON.stringify(v.bundleReceipt.sourceIds) === JSON.stringify(identity.operation.sourceIds)
      );
    if (!('operationReceipts' in v))
      return (
        !('identityVersion' in identity) ||
        (identity.identityVersion === 2 && v.stage === 'classification' && v.schemaVersion === 1)
      );
    if (!('identityVersion' in identity)) return v.operationReceipts === undefined;
    if (v.stage === 'classification' && v.schemaVersion === 1)
      return identity.identityVersion === 2 && v.operationReceipts === undefined;
    return (
      v.operationReceipts?.length === identity.operations.length &&
      v.operationReceipts.every(
        (receipt, i) => receipt.sourceId === identity.operations[i]?.sourceId,
      )
    );
  });
export type PipelineArtifactWrite = z.infer<typeof PipelineArtifactWriteSchema>;

export const PipelineArtifactSchema = z
  .strictObject({
    jobId: z.uuid(),
    stage: PipelineStageSchema,
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    relativePath: z.string().max(200),
    sha256: Hash,
    identitySha256: Hash,
    createdAt: z.iso.datetime(),
  })
  .refine((v) => v.schemaVersion === 1 || v.stage === 'classification')
  .refine((v) => v.relativePath === `${v.jobId}/${v.stage}-v${v.schemaVersion}-${v.sha256}.json`)
  .readonly();
export type PipelineArtifact = z.infer<typeof PipelineArtifactSchema>;
export type PipelineArtifactRead = PipelineArtifact & PipelineArtifactWrite;
