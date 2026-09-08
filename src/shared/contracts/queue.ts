import { z } from 'zod';
import { APP_ERROR_MESSAGES, AppErrorCodeSchema } from '../errors';
import { CourseProvisioningInputSchema } from './course';
import {
  PUBLIC_QUEUE_STATUSES,
  type PublicQueueStatusSchema,
  SOURCE_MEDIA_TYPES,
  SUMMARY_MODES,
  SummaryModeSchema,
  toPublicQueueStatus,
} from './job';
import { createMediaSourceFileNameSchema, SUPPORTED_EXTENSIONS } from './sourceFile';

export {
  type NormalizedSourceBundleManifest,
  normalizeQueueManifest,
  type SourceBundleManifestV2,
  SourceBundleManifestV2Schema,
} from './sourceBundle';

export {
  PUBLIC_QUEUE_STATUSES,
  SOURCE_MEDIA_TYPES,
  SUMMARY_MODES,
  SUPPORTED_EXTENSIONS,
  toPublicQueueStatus,
};

const AudioSourceSchema = z
  .strictObject({
    fileName: createMediaSourceFileNameSchema(['.m4a', '.mp3', '.wav', '.aac', '.flac']),
    mediaType: z.literal('audio'),
  })
  .readonly();

const VideoSourceSchema = z
  .strictObject({
    fileName: createMediaSourceFileNameSchema(['.mp4']),
    mediaType: z.literal('video'),
  })
  .readonly();

const DocumentSourceSchema = z
  .strictObject({
    fileName: createMediaSourceFileNameSchema(['.pdf', '.pptx', '.txt', '.md']),
    mediaType: z.literal('document'),
  })
  .readonly();

const ImageSourceSchema = z
  .strictObject({
    fileName: createMediaSourceFileNameSchema(['.png', '.jpg', '.jpeg', '.heic']),
    mediaType: z.literal('image'),
  })
  .readonly();

export const QueueSourceSchema = z
  .discriminatedUnion('mediaType', [
    AudioSourceSchema,
    VideoSourceSchema,
    DocumentSourceSchema,
    ImageSourceSchema,
  ])
  .readonly();

export const QueueManifestSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    jobId: z.uuid(),
    courseId: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
    source: QueueSourceSchema,
    summaryMode: SummaryModeSchema,
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .readonly();

export const CourseInboxRequestSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    jobId: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
    course: CourseProvisioningInputSchema,
    source: QueueSourceSchema,
    summaryMode: SummaryModeSchema,
  })
  .readonly();

export const CourseCatalogSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    generatedAt: z.iso.datetime({ offset: true }),
    courses: z
      .array(
        z
          .strictObject({
            id: z.uuid(),
            name: z.string().trim().min(1).max(80),
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();

export const PUBLIC_STATUS_MESSAGES = Object.freeze({
  queued: '강의 자료가 안전하게 대기 중입니다.',
  processing: '강의 자료를 처리하고 있습니다.',
  completed: '강의 자료 정리가 완료되었습니다.',
} as const);

const ReceiptIdentityShape = {
  jobId: z.uuid(),
  courseId: z.uuid(),
  updatedAt: z.iso.datetime({ offset: true }),
} as const;

const QueuedReceiptSchema = z
  .strictObject({
    ...ReceiptIdentityShape,
    status: z.literal('queued'),
    displayMessage: z.literal(PUBLIC_STATUS_MESSAGES.queued),
  })
  .readonly();

const ProcessingReceiptSchema = z
  .strictObject({
    ...ReceiptIdentityShape,
    status: z.literal('processing'),
    displayMessage: z.literal(PUBLIC_STATUS_MESSAGES.processing),
  })
  .readonly();

const CompletedReceiptSchema = z
  .strictObject({
    ...ReceiptIdentityShape,
    status: z.literal('completed'),
    displayMessage: z.literal(PUBLIC_STATUS_MESSAGES.completed),
  })
  .readonly();

const FailedReceiptSchema = z
  .strictObject({
    ...ReceiptIdentityShape,
    status: z.literal('failed'),
    displayMessage: z
      .string()
      .min(1)
      .max(200)
      .regex(/[가-힣]/u),
    errorCode: AppErrorCodeSchema,
  })
  .superRefine((receipt, context) => {
    if (receipt.displayMessage !== APP_ERROR_MESSAGES[receipt.errorCode]) {
      context.addIssue({
        code: 'custom',
        message: '오류 코드와 공개 메시지가 일치하지 않습니다.',
        path: ['displayMessage'],
      });
    }
  })
  .readonly();

export const StatusReceiptSchema = z
  .discriminatedUnion('status', [
    QueuedReceiptSchema,
    ProcessingReceiptSchema,
    CompletedReceiptSchema,
    FailedReceiptSchema,
  ])
  .readonly();

export const RejectionReceiptSchema = z
  .strictObject({
    jobId: z.uuid(),
    status: z.literal('failed'),
    displayMessage: z
      .string()
      .min(1)
      .max(200)
      .regex(/[가-힣]/u),
    updatedAt: z.iso.datetime({ offset: true }),
    errorCode: AppErrorCodeSchema,
  })
  .superRefine((receipt, context) => {
    if (receipt.displayMessage !== APP_ERROR_MESSAGES[receipt.errorCode]) {
      context.addIssue({
        code: 'custom',
        message: '오류 코드와 공개 메시지가 일치하지 않습니다.',
        path: ['displayMessage'],
      });
    }
  })
  .readonly();

export type QueueManifest = z.infer<typeof QueueManifestSchema>;
export type CourseInboxRequest = z.infer<typeof CourseInboxRequestSchema>;
export type CourseCatalog = z.infer<typeof CourseCatalogSchema>;
export type StatusReceipt = z.infer<typeof StatusReceiptSchema>;
export type RejectionReceipt = z.infer<typeof RejectionReceiptSchema>;
export type PublicQueueStatus = z.infer<typeof PublicQueueStatusSchema>;

export const toQueueManifest = (request: CourseInboxRequest): QueueManifest =>
  QueueManifestSchema.parse({
    protocolVersion: request.protocolVersion,
    jobId: request.jobId,
    courseId: request.course.id,
    createdAt: request.createdAt,
    source: request.source,
    summaryMode: request.summaryMode,
  });
