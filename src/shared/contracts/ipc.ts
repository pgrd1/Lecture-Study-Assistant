import { z } from 'zod';
import { ErrorEnvelopeSchema } from '../errors';
import { type CourseInputSchema, CoursePatchSchema } from './course';
import { PublicQueueStatusSchema, SOURCE_MEDIA_TYPES, SummaryModeSchema } from './job';
import { MAX_SOURCES_PER_BUNDLE } from './sourceBundle';
import { SupportedSourceFileNameSchema } from './sourceFile';

export const IPC_CHANNELS = Object.freeze({
  getBootstrapState: 'study:get-bootstrap-state',
  chooseVault: 'study:choose-vault',
  chooseQueue: 'study:choose-queue',
  createCourse: 'study:course-create',
  updateCourse: 'study:course-update',
  archiveCourse: 'study:course-archive',
  restoreCourse: 'study:course-restore',
  chooseSources: 'study:source-choose',
  enqueueSelection: 'study:source-enqueue-selection',
  enqueueDroppedFiles: 'study:source-enqueue-dropped',
  retryJob: 'study:job-retry',
  setAutoStart: 'study:auto-start-set',
  exportDiagnostics: 'study:diagnostics-export',
  stateChanged: 'study:state-changed',
} as const);

export const IPC_INVOKE_CHANNELS = Object.freeze([
  IPC_CHANNELS.getBootstrapState,
  IPC_CHANNELS.chooseVault,
  IPC_CHANNELS.chooseQueue,
  IPC_CHANNELS.createCourse,
  IPC_CHANNELS.updateCourse,
  IPC_CHANNELS.archiveCourse,
  IPC_CHANNELS.restoreCourse,
  IPC_CHANNELS.chooseSources,
  IPC_CHANNELS.enqueueSelection,
  IPC_CHANNELS.enqueueDroppedFiles,
  IPC_CHANNELS.retryJob,
  IPC_CHANNELS.setAutoStart,
  IPC_CHANNELS.exportDiagnostics,
] as const);

export const EXPECTED_API_METHODS = Object.freeze([
  'getBootstrapState',
  'chooseVault',
  'chooseQueue',
  'createCourse',
  'updateCourse',
  'archiveCourse',
  'restoreCourse',
  'chooseSources',
  'enqueueSelection',
  'enqueueDroppedFiles',
  'retryJob',
  'setAutoStart',
  'exportDiagnostics',
  'subscribeToState',
] as const);

export const EmptyRequestSchema = z.strictObject({}).readonly();

export const EntityIdRequestSchema = z
  .strictObject({
    id: z.uuid(),
  })
  .readonly();

export const UpdateCourseRequestSchema = z
  .strictObject({
    id: z.uuid(),
    patch: CoursePatchSchema,
  })
  .readonly();

export const EnqueueSelectionRequestSchema = z
  .strictObject({
    selectionToken: z.uuid(),
    courseId: z.uuid(),
    summaryMode: SummaryModeSchema,
  })
  .readonly();

const InternalAbsolutePathSchema = z
  .string()
  .min(3)
  .max(32_767)
  .refine((value) => /^[A-Za-z]:[\\/]/u.test(value) && !value.includes('\0'));

export const EnqueueDroppedFilesRequestSchema = z
  .strictObject({
    courseId: z.uuid(),
    filePaths: z.array(InternalAbsolutePathSchema).min(1).max(MAX_SOURCES_PER_BUNDLE).readonly(),
    summaryMode: SummaryModeSchema,
  })
  .readonly();

export const SetAutoStartRequestSchema = z
  .strictObject({
    enabled: z.boolean(),
  })
  .readonly();

export const CourseSummarySchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string().trim().min(1).max(80),
    professorName: z.string().trim().max(80),
    userInstructions: z.string().max(4_000),
    archived: z.boolean(),
    revision: z.int().min(0),
  })
  .readonly();

export const JobSummarySchema = z
  .strictObject({
    id: z.uuid(),
    courseId: z.uuid(),
    sourceFileName: SupportedSourceFileNameSchema,
    sourceMediaType: z.enum(SOURCE_MEDIA_TYPES),
    sourceCount: z.int().min(1).max(MAX_SOURCES_PER_BUNDLE).optional(),
    summaryMode: SummaryModeSchema,
    status: PublicQueueStatusSchema,
    retryCount: z.int().min(0),
    error: ErrorEnvelopeSchema.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .readonly();

export const BootstrapStateSchema = z
  .strictObject({
    settings: z
      .strictObject({
        vaultConfigured: z.boolean(),
        queueConfigured: z.boolean(),
        defaultSummaryMode: SummaryModeSchema,
        autoStart: z.boolean(),
        processingPaused: z.boolean(),
        legalNoticeAccepted: z.boolean(),
      })
      .readonly(),
    courses: z.array(CourseSummarySchema).max(1_000).readonly(),
    jobs: z.array(JobSummarySchema).max(500).readonly(),
    counts: z
      .strictObject({
        queued: z.int().min(0),
        processing: z.int().min(0),
        completed: z.int().min(0),
        failed: z.int().min(0),
      })
      .readonly(),
    synchronizationIssueCount: z.int().min(0),
  })
  .readonly();

export const DirectoryChoiceSchema = z.discriminatedUnion('cancelled', [
  z.strictObject({ cancelled: z.literal(true) }).readonly(),
  z
    .strictObject({
      cancelled: z.literal(false),
      state: BootstrapStateSchema,
    })
    .readonly(),
]);

export const SourceSelectionSchema = z.discriminatedUnion('cancelled', [
  z
    .strictObject({
      cancelled: z.literal(true),
      selectionToken: z.null(),
      files: z.tuple([]).readonly(),
    })
    .readonly(),
  z
    .strictObject({
      cancelled: z.literal(false),
      selectionToken: z.uuid(),
      files: z
        .array(
          z
            .strictObject({
              name: SupportedSourceFileNameSchema,
              size: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
            })
            .readonly(),
        )
        .min(1)
        .max(MAX_SOURCES_PER_BUNDLE)
        .readonly(),
    })
    .readonly(),
]);

export const ExportDiagnosticsResultSchema = z.discriminatedUnion('cancelled', [
  z.strictObject({ cancelled: z.literal(true) }).readonly(),
  z.strictObject({ cancelled: z.literal(false) }).readonly(),
]);

export const IpcResponseSchema = <Schema extends z.ZodType>(dataSchema: Schema) =>
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), data: dataSchema }).readonly(),
    z.strictObject({ ok: z.literal(false), error: ErrorEnvelopeSchema }).readonly(),
  ]);

export type EmptyRequest = z.infer<typeof EmptyRequestSchema>;
export type EntityIdRequest = z.infer<typeof EntityIdRequestSchema>;
export type UpdateCourseRequest = z.infer<typeof UpdateCourseRequestSchema>;
export type EnqueueSelectionRequest = z.infer<typeof EnqueueSelectionRequestSchema>;
export type EnqueueDroppedFilesRequest = z.infer<typeof EnqueueDroppedFilesRequestSchema>;
export type SetAutoStartRequest = z.infer<typeof SetAutoStartRequestSchema>;
export type BootstrapState = z.infer<typeof BootstrapStateSchema>;
export type DirectoryChoice = z.infer<typeof DirectoryChoiceSchema>;
export type SourceSelection = z.infer<typeof SourceSelectionSchema>;
export type ExportDiagnosticsResult = z.infer<typeof ExportDiagnosticsResultSchema>;

export type IpcResponse<Data> =
  | Readonly<{ ok: true; data: Data }>
  | Readonly<{ ok: false; error: z.infer<typeof ErrorEnvelopeSchema> }>;

export type DroppedFilesInput = Readonly<{
  courseId: string;
  files: readonly File[];
  summaryMode: z.infer<typeof SummaryModeSchema>;
}>;

export interface StudyAppApi {
  getBootstrapState(): Promise<IpcResponse<BootstrapState>>;
  chooseVault(): Promise<IpcResponse<DirectoryChoice>>;
  chooseQueue(): Promise<IpcResponse<DirectoryChoice>>;
  createCourse(input: z.input<typeof CourseInputSchema>): Promise<IpcResponse<BootstrapState>>;
  updateCourse(
    id: string,
    patch: z.input<typeof CoursePatchSchema>,
  ): Promise<IpcResponse<BootstrapState>>;
  archiveCourse(id: string): Promise<IpcResponse<BootstrapState>>;
  restoreCourse(id: string): Promise<IpcResponse<BootstrapState>>;
  chooseSources(): Promise<IpcResponse<SourceSelection>>;
  enqueueSelection(
    input: z.input<typeof EnqueueSelectionRequestSchema>,
  ): Promise<IpcResponse<BootstrapState>>;
  enqueueDroppedFiles(input: DroppedFilesInput): Promise<IpcResponse<BootstrapState>>;
  retryJob(id: string): Promise<IpcResponse<BootstrapState>>;
  setAutoStart(enabled: boolean): Promise<IpcResponse<BootstrapState>>;
  exportDiagnostics(): Promise<IpcResponse<ExportDiagnosticsResult>>;
  subscribeToState(callback: (state: BootstrapState) => void): () => void;
}
