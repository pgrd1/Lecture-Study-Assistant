import { z } from 'zod';
import { CourseNameSchema, CourseProvisioningInputSchema, ProfessorNameSchema } from './course';
import { SourceMediaTypeSchema, SummaryModeSchema } from './job';
import { QueueManifestSchema, QueueSourceSchema } from './queue';
import { SupportedSourceFileNameSchema } from './sourceFile';

export const MAX_SOURCES_PER_BUNDLE = 32;
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_AUDIO_VIDEO_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_DOCUMENT_IMAGE_SOURCE_BYTES = 500 * 1024 * 1024;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const InternalPathSchema = z.string().min(1).max(32_767);

const assertFileNameMatchesMediaType = (
  fileName: string,
  mediaType: z.infer<typeof SourceMediaTypeSchema>,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void => {
  if (!QueueSourceSchema.safeParse({ fileName, mediaType }).success) {
    context.addIssue({
      code: 'custom',
      message: '파일 확장자와 미디어 유형이 일치하지 않습니다.',
      path: [...path],
    });
  }
};

export const SourceDescriptorV2Schema = z
  .strictObject({
    id: z.uuid(),
    fileName: SupportedSourceFileNameSchema,
    mediaType: SourceMediaTypeSchema,
    sizeBytes: z.int().min(1).max(MAX_AUDIO_VIDEO_SOURCE_BYTES),
    sha256: Sha256Schema.optional(),
  })
  .superRefine((source, context) => {
    assertFileNameMatchesMediaType(source.fileName, source.mediaType, context, ['fileName']);
  })
  .readonly();

export type SourceDescriptorV2 = z.infer<typeof SourceDescriptorV2Schema>;

const CourseProvisioningRequestV2Schema = z
  .strictObject({
    id: z.uuid(),
    name: CourseNameSchema,
    professorName: ProfessorNameSchema.optional(),
  })
  .readonly();

const sourceByteLimit = (mediaType: SourceDescriptorV2['mediaType']): number =>
  mediaType === 'audio' || mediaType === 'video'
    ? MAX_AUDIO_VIDEO_SOURCE_BYTES
    : MAX_DOCUMENT_IMAGE_SOURCE_BYTES;

const assertUniqueSourcesAndBoundedTotal = (
  manifest: { readonly sources: readonly SourceDescriptorV2[] },
  context: z.RefinementCtx,
): void => {
  const sourceIds = new Set<string>();
  let totalBytes = 0;

  manifest.sources.forEach((source, index) => {
    if (sourceIds.has(source.id)) {
      context.addIssue({
        code: 'custom',
        message: '원본 ID는 묶음 안에서 고유해야 합니다.',
        path: ['sources', index, 'id'],
      });
    }
    sourceIds.add(source.id);
    if (source.sizeBytes > sourceByteLimit(source.mediaType)) {
      context.addIssue({
        code: 'custom',
        message: '원본 파일이 미디어 유형별 크기 제한을 초과했습니다.',
        path: ['sources', index, 'sizeBytes'],
      });
    }
    totalBytes += source.sizeBytes;
  });

  if (totalBytes > MAX_BUNDLE_BYTES) {
    context.addIssue({
      code: 'custom',
      message: '원본 묶음이 전체 크기 제한을 초과했습니다.',
      path: ['sources'],
    });
  }
};

export const SourceBundleManifestV2Schema = z
  .strictObject({
    protocolVersion: z.literal(2),
    jobId: z.uuid(),
    courseId: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
    summaryMode: SummaryModeSchema,
    sources: z.array(SourceDescriptorV2Schema).min(1).max(MAX_SOURCES_PER_BUNDLE).readonly(),
    courseProvisioning: CourseProvisioningRequestV2Schema.optional(),
  })
  .superRefine((manifest, context) => {
    assertUniqueSourcesAndBoundedTotal(manifest, context);
    if (
      manifest.courseProvisioning !== undefined &&
      manifest.courseProvisioning.id !== manifest.courseId
    ) {
      context.addIssue({
        code: 'custom',
        message: '새 과목 정보는 묶음의 과목 ID와 일치해야 합니다.',
        path: ['courseProvisioning', 'id'],
      });
    }
  })
  .readonly();

export type SourceBundleManifestV2 = z.infer<typeof SourceBundleManifestV2Schema>;

export const NormalizedSourceDescriptorSchema = z
  .strictObject({
    id: z.uuid(),
    fileName: SupportedSourceFileNameSchema,
    mediaType: SourceMediaTypeSchema,
    sizeBytes: z.int().min(1).max(MAX_AUDIO_VIDEO_SOURCE_BYTES).nullable(),
    sha256: Sha256Schema.optional(),
  })
  .readonly();

export const NormalizedSourceBundleManifestSchema = z
  .strictObject({
    protocolVersion: z.union([z.literal(1), z.literal(2)]),
    jobId: z.uuid(),
    courseId: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
    summaryMode: SummaryModeSchema,
    courseProvisioning: CourseProvisioningInputSchema.nullable(),
    sources: z
      .array(NormalizedSourceDescriptorSchema)
      .min(1)
      .max(MAX_SOURCES_PER_BUNDLE)
      .readonly(),
  })
  .readonly();

export type NormalizedSourceBundleManifest = z.infer<typeof NormalizedSourceBundleManifestSchema>;

export const normalizeQueueManifest = (value: unknown): NormalizedSourceBundleManifest => {
  const manifest = z.union([QueueManifestSchema, SourceBundleManifestV2Schema]).parse(value);

  if (manifest.protocolVersion === 1) {
    return NormalizedSourceBundleManifestSchema.parse({
      protocolVersion: 1,
      jobId: manifest.jobId,
      courseId: manifest.courseId,
      createdAt: manifest.createdAt,
      summaryMode: manifest.summaryMode,
      courseProvisioning: null,
      sources: [
        {
          id: manifest.jobId,
          fileName: manifest.source.fileName,
          mediaType: manifest.source.mediaType,
          sizeBytes: null,
          ...(manifest.sha256 === undefined ? {} : { sha256: manifest.sha256 }),
        },
      ],
    });
  }

  return NormalizedSourceBundleManifestSchema.parse({
    protocolVersion: 2,
    jobId: manifest.jobId,
    courseId: manifest.courseId,
    createdAt: manifest.createdAt,
    summaryMode: manifest.summaryMode,
    courseProvisioning:
      manifest.courseProvisioning === undefined
        ? null
        : {
            ...manifest.courseProvisioning,
            professorName: manifest.courseProvisioning.professorName ?? '',
          },
    sources: manifest.sources,
  });
};

export const SourceBundleSchema = z
  .strictObject({
    id: z.uuid(),
    jobId: z.uuid(),
    manifestSha256: Sha256Schema,
    sourceCount: z.int().min(1).max(MAX_SOURCES_PER_BUNDLE),
    totalBytes: z.int().min(1).max(MAX_BUNDLE_BYTES),
    stagingDirectoryPath: InternalPathSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .readonly();

export const SourceRecordSchema = z
  .strictObject({
    id: z.uuid(),
    bundleId: z.uuid(),
    ordinal: z.int().min(0),
    originalFileName: SupportedSourceFileNameSchema,
    mediaType: SourceMediaTypeSchema,
    stagedPath: InternalPathSchema,
    sha256: Sha256Schema,
    sizeBytes: z.int().min(1).max(MAX_AUDIO_VIDEO_SOURCE_BYTES),
  })
  .superRefine((record, context) => {
    assertFileNameMatchesMediaType(record.originalFileName, record.mediaType, context, [
      'originalFileName',
    ]);
    if (record.sizeBytes > sourceByteLimit(record.mediaType)) {
      context.addIssue({
        code: 'custom',
        message: '원본 파일이 미디어 유형별 크기 제한을 초과했습니다.',
        path: ['sizeBytes'],
      });
    }
  })
  .readonly();

export type SourceBundle = z.infer<typeof SourceBundleSchema>;
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
