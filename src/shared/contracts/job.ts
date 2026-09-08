import { z } from 'zod';
import { AppErrorCodeSchema } from '../errors';
import { SupportedSourceFileNameSchema } from './sourceFile';

export const ACTIVE_JOB_STATUSES = [
  'queued',
  'receiving',
  'source_ready',
  'transcribing_or_extracting',
  'structuring',
  'generating',
  'verifying',
  'writing',
] as const;

export const SUCCESSFUL_JOB_STATUSES = [...ACTIVE_JOB_STATUSES, 'completed'] as const;

export const JOB_STATUSES = [
  ...SUCCESSFUL_JOB_STATUSES,
  'retryable_failed',
  'needs_attention',
] as const;

export const MAX_AUTOMATIC_RETRIES = 3;

export const SUMMARY_MODES = ['none', 'core', 'standard', 'full'] as const;
export const SOURCE_KINDS = ['icloud', 'icloud_course', 'local'] as const;
export const SOURCE_MEDIA_TYPES = ['audio', 'video', 'document', 'image'] as const;
export const PUBLIC_QUEUE_STATUSES = ['queued', 'processing', 'completed', 'failed'] as const;

export const JobStatusSchema = z.enum(JOB_STATUSES);
export const SuccessfulJobStatusSchema = z.enum(SUCCESSFUL_JOB_STATUSES);
export const SummaryModeSchema = z.enum(SUMMARY_MODES);
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export const SourceMediaTypeSchema = z.enum(SOURCE_MEDIA_TYPES);
export const PublicQueueStatusSchema = z.enum(PUBLIC_QUEUE_STATUSES);

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type ActiveJobStatus = (typeof ACTIVE_JOB_STATUSES)[number];
export type SuccessfulJobStatus = z.infer<typeof SuccessfulJobStatusSchema>;
export type SummaryMode = z.infer<typeof SummaryModeSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type ICloudSourceKind = Exclude<SourceKind, 'local'>;
export type SourceMediaType = z.infer<typeof SourceMediaTypeSchema>;
export type PublicQueueStatus = z.infer<typeof PublicQueueStatusSchema>;

const SafeErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const InternalPathSchema = z.string().min(1).max(32_767);

const SUCCESSFUL_STATUS_INDEX = Object.freeze({
  queued: 0,
  receiving: 1,
  source_ready: 2,
  transcribing_or_extracting: 3,
  structuring: 4,
  generating: 5,
  verifying: 6,
  writing: 7,
  completed: 8,
} as const satisfies Record<SuccessfulJobStatus, number>);

export const JobSchema = z
  .strictObject({
    id: z.uuid(),
    courseId: z.uuid(),
    sourceKind: SourceKindSchema,
    sourceFileName: SupportedSourceFileNameSchema,
    sourceMediaType: SourceMediaTypeSchema,
    summaryMode: SummaryModeSchema,
    stagedSourcePath: InternalPathSchema,
    queueItemPath: InternalPathSchema.nullable(),
    sourceSha256: Sha256Schema,
    fingerprint: Sha256Schema,
    sourceBundleId: z.uuid().nullable().default(null),
    sourceCount: z.int().min(1).max(32).default(1),
    status: JobStatusSchema,
    lastSuccessfulStatus: SuccessfulJobStatusSchema,
    retryCount: z.int().min(0).max(MAX_AUTOMATIC_RETRIES),
    errorCode: AppErrorCodeSchema.nullable(),
    cleanupWarningCode: SafeErrorCodeSchema.nullable(),
    attentionResolutionId: z.uuid().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    revision: z.int().min(0),
  })
  .superRefine((job, context) => {
    const isFailure = job.status === 'retryable_failed' || job.status === 'needs_attention';
    if (Date.parse(job.createdAt) > Date.parse(job.updatedAt)) {
      context.addIssue({
        code: 'custom',
        message: '작업 생성 시각은 수정 시각보다 늦을 수 없습니다.',
        path: ['createdAt'],
      });
    }
    if (isFailure !== (job.errorCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: '실패 상태와 오류 코드가 일치해야 합니다.',
        path: ['errorCode'],
      });
    }
    if (job.attentionResolutionId !== null && job.status !== 'queued') {
      context.addIssue({
        code: 'custom',
        message: '사용자 조치 ID는 재대기 상태에서만 보존할 수 있습니다.',
        path: ['attentionResolutionId'],
      });
    }
    if (isFailure && job.lastSuccessfulStatus === 'completed') {
      context.addIssue({
        code: 'custom',
        message: '완료된 작업은 실패 상태로 되돌릴 수 없습니다.',
        path: ['lastSuccessfulStatus'],
      });
    }
    if (job.status !== 'retryable_failed' && job.status !== 'needs_attention') {
      const statusIndex = SUCCESSFUL_STATUS_INDEX[job.status];
      const checkpointIndex = SUCCESSFUL_STATUS_INDEX[job.lastSuccessfulStatus];
      // An interrupted job may deliberately rewind to an earlier checkpoint for
      // idempotent reprocessing, but it must never skip work by pointing ahead.
      if (
        checkpointIndex > statusIndex ||
        (job.status === 'completed' && job.lastSuccessfulStatus !== 'completed')
      ) {
        context.addIssue({
          code: 'custom',
          message: '마지막 성공 단계가 현재 작업 상태와 일치하지 않습니다.',
          path: ['lastSuccessfulStatus'],
        });
      }
    }
  })
  .readonly();

export type Job = z.infer<typeof JobSchema>;

export const toPublicQueueStatus = (status: JobStatus): PublicQueueStatus => {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'completed':
      return 'completed';
    case 'retryable_failed':
    case 'needs_attention':
      return 'failed';
    case 'receiving':
    case 'source_ready':
    case 'transcribing_or_extracting':
    case 'structuring':
    case 'generating':
    case 'verifying':
    case 'writing':
      return 'processing';
  }
};
