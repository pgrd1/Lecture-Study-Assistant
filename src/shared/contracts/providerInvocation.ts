import { z } from 'zod';
import { ProviderErrorCodeSchema } from '../errors';
import {
  AI_FEATURES,
  AI_PROVIDER_IDS,
  type AiFeature,
  type AiProviderId,
  ModelIdSchema,
  Sha256Schema,
} from './provider';

const InvocationStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
const AttemptKindSchema = z.enum(['initial', 'transient_retry', 'format_repair']);
const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const UsageNumberSchema = z.int().min(0).nullable();

export const ProviderInvocationCompletionSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('completed'),
      reportedModelId: ModelIdSchema.nullable(),
      responseSha256: Sha256Schema,
      inputTokens: UsageNumberSchema,
      outputTokens: UsageNumberSchema,
      totalTokens: UsageNumberSchema,
      latencyMs: z.int().min(0),
      completedAt: IsoDateTimeSchema,
      errorCode: z.null(),
    })
    .readonly(),
  z
    .strictObject({
      status: z.enum(['failed', 'cancelled']),
      reportedModelId: ModelIdSchema.nullable(),
      responseSha256: z.null(),
      inputTokens: UsageNumberSchema,
      outputTokens: UsageNumberSchema,
      totalTokens: UsageNumberSchema,
      latencyMs: z.int().min(0),
      completedAt: IsoDateTimeSchema,
      errorCode: ProviderErrorCodeSchema,
    })
    .readonly(),
]);
export type ProviderInvocationCompletion = z.infer<typeof ProviderInvocationCompletionSchema>;

export const ProviderInvocationSchema = z
  .strictObject({
    id: z.uuid(),
    requestId: z.uuid(),
    jobId: z.uuid().nullable(),
    feature: z.enum(AI_FEATURES),
    providerId: z.enum(AI_PROVIDER_IDS),
    selectedModelId: ModelIdSchema.nullable(),
    reportedModelId: ModelIdSchema.nullable(),
    promptVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    outputSchemaId: z.string().regex(/^[a-z0-9_]{1,64}$/),
    routeRevision: z.int().min(0),
    requestSha256: Sha256Schema,
    responseSha256: Sha256Schema.nullable(),
    status: InvocationStatusSchema,
    inputTokens: UsageNumberSchema,
    outputTokens: UsageNumberSchema,
    totalTokens: UsageNumberSchema,
    latencyMs: z.int().min(0).nullable(),
    retryOf: z.uuid().nullable(),
    attemptKind: AttemptKindSchema,
    errorCode: ProviderErrorCodeSchema.nullable(),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
    revision: z.int().min(0),
  })
  .superRefine((value, context) => {
    const completed = value.status === 'completed';
    const terminal = completed || value.status === 'failed' || value.status === 'cancelled';
    if (
      value.status === 'running' &&
      (value.completedAt !== null ||
        value.errorCode !== null ||
        value.responseSha256 !== null ||
        value.reportedModelId !== null ||
        value.inputTokens !== null ||
        value.outputTokens !== null ||
        value.totalTokens !== null ||
        value.latencyMs !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: '실행 중 호출에는 완료 정보가 있을 수 없습니다.',
        path: ['status'],
      });
    }
    if (completed && (value.responseSha256 === null || value.errorCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: '완료 호출에는 응답 해시만 있어야 합니다.',
        path: ['responseSha256'],
      });
    }
    if (
      (value.status === 'failed' || value.status === 'cancelled') &&
      (value.responseSha256 !== null || value.errorCode === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: '실패 호출에는 제공자 오류만 있어야 합니다.',
        path: ['errorCode'],
      });
    }
    if (terminal !== (value.completedAt !== null)) {
      context.addIssue({
        code: 'custom',
        message: '완료 시각은 종료 상태와 일치해야 합니다.',
        path: ['completedAt'],
      });
    }
  })
  .readonly();
export type ProviderInvocation = z.infer<typeof ProviderInvocationSchema>;

export type ProviderInvocationIdentity = Readonly<{
  feature: AiFeature;
  providerId: AiProviderId;
}>;
