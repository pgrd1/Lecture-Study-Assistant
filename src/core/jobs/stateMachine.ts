import { z } from 'zod';
import {
  type ActiveJobStatus,
  type Job,
  JobSchema,
  type JobStatus,
  JobStatusSchema,
  MAX_AUTOMATIC_RETRIES,
  type SuccessfulJobStatus,
} from '../../shared/contracts/job';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

const NORMAL_SUCCESSORS = Object.freeze({
  queued: 'receiving',
  receiving: 'source_ready',
  source_ready: 'transcribing_or_extracting',
  transcribing_or_extracting: 'structuring',
  structuring: 'generating',
  generating: 'verifying',
  verifying: 'writing',
  writing: 'completed',
} as const satisfies Record<ActiveJobStatus, SuccessfulJobStatus>);

const RESUME_CHECKPOINTS = Object.freeze({
  queued: 'queued',
  receiving: 'queued',
  source_ready: 'source_ready',
  transcribing_or_extracting: 'source_ready',
  structuring: 'transcribing_or_extracting',
  generating: 'structuring',
  verifying: 'generating',
  writing: 'verifying',
  completed: 'completed',
  retryable_failed: 'retryable_failed',
  needs_attention: 'needs_attention',
} as const satisfies Record<JobStatus, JobStatus>);

const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const AttentionResolutionSchema = z
  .strictObject({
    id: z.uuid(),
    jobId: z.uuid(),
    failureRevision: z.int().min(0),
    createdAt: IsoDateTimeSchema,
  })
  .readonly();

export type AttentionResolution = z.infer<typeof AttentionResolutionSchema>;

const JobTransitionContextSchema = z
  .strictObject({
    failure: z.custom<AppError>(AppError.isTrusted).optional(),
    attentionResolution: AttentionResolutionSchema.optional(),
  })
  .readonly();

export type JobTransitionContext = z.input<typeof JobTransitionContextSchema>;

const throwInvalidTransition = (): never => {
  throw new AppError('INVALID_JOB_TRANSITION', APP_ERROR_MESSAGES.INVALID_JOB_TRANSITION);
};

const isFailureStatus = (status: JobStatus): status is 'retryable_failed' | 'needs_attention' =>
  status === 'retryable_failed' || status === 'needs_attention';

const isActiveStatus = (status: JobStatus): status is ActiveJobStatus =>
  Object.hasOwn(NORMAL_SUCCESSORS, status);

const hasNoTransitionAction = (context: JobTransitionContext): boolean =>
  context.failure === undefined && context.attentionResolution === undefined;

const isFreshResolution = (
  job: Job,
  resolution: AttentionResolution | undefined,
  now: string,
): resolution is AttentionResolution =>
  resolution !== undefined &&
  resolution.jobId === job.id &&
  resolution.failureRevision === job.revision &&
  Date.parse(resolution.createdAt) > Date.parse(job.updatedAt) &&
  Date.parse(resolution.createdAt) <= Date.parse(now);

export const classifyFailure = (
  error: unknown,
  retryCount = 0,
): 'retryable_failed' | 'needs_attention' =>
  AppError.isTrusted(error) &&
  error.retryable &&
  Number.isSafeInteger(retryCount) &&
  retryCount >= 0 &&
  retryCount < MAX_AUTOMATIC_RETRIES
    ? 'retryable_failed'
    : 'needs_attention';

const isAllowedTransition = (
  job: Job,
  next: JobStatus,
  context: JobTransitionContext,
  now: string,
): boolean => {
  if (isActiveStatus(job.status)) {
    if (NORMAL_SUCCESSORS[job.status] === next) {
      return hasNoTransitionAction(context);
    }
    if (isFailureStatus(next) && context.failure !== undefined) {
      return (
        context.attentionResolution === undefined &&
        classifyFailure(context.failure, job.retryCount) === next
      );
    }
    return false;
  }
  if (job.status === 'retryable_failed') {
    return (
      job.lastSuccessfulStatus !== 'completed' &&
      next === job.lastSuccessfulStatus &&
      hasNoTransitionAction(context)
    );
  }
  if (job.status === 'needs_attention') {
    return (
      next === 'queued' &&
      context.failure === undefined &&
      isFreshResolution(job, context.attentionResolution, now)
    );
  }
  return false;
};

export const resumeStatus = (status: JobStatus): JobStatus => {
  const parsedStatus = JobStatusSchema.safeParse(status);
  if (!parsedStatus.success) {
    return throwInvalidTransition();
  }
  return RESUME_CHECKPOINTS[parsedStatus.data];
};

export const transitionJob = (
  job: Job,
  next: JobStatus,
  now: string,
  context: JobTransitionContext = {},
): Job => {
  const parsedJob = JobSchema.safeParse(job);
  const parsedNext = JobStatusSchema.safeParse(next);
  const parsedNow = IsoDateTimeSchema.safeParse(now);
  const parsedContext = JobTransitionContextSchema.safeParse(context);
  if (
    !parsedJob.success ||
    !parsedNext.success ||
    !parsedNow.success ||
    !parsedContext.success ||
    Date.parse(parsedNow.data) <= Date.parse(parsedJob.data.updatedAt) ||
    !isAllowedTransition(parsedJob.data, parsedNext.data, parsedContext.data, parsedNow.data)
  ) {
    return throwInvalidTransition();
  }

  const current = parsedJob.data;
  const nextStatus = parsedNext.data;
  const recovering = isFailureStatus(current.status) && !isFailureStatus(nextStatus);
  const lastSuccessfulStatus = recovering
    ? current.status === 'needs_attention'
      ? 'queued'
      : current.lastSuccessfulStatus
    : isFailureStatus(nextStatus)
      ? current.lastSuccessfulStatus
      : resumeStatus(nextStatus);
  const failure = parsedContext.data.failure;

  const candidate = JobSchema.safeParse({
    ...current,
    status: nextStatus,
    lastSuccessfulStatus,
    retryCount:
      current.status === 'needs_attention'
        ? 0
        : current.retryCount + (nextStatus === 'retryable_failed' ? 1 : 0),
    errorCode: isFailureStatus(nextStatus) && failure !== undefined ? failure.code : null,
    attentionResolutionId:
      current.status === 'needs_attention'
        ? (parsedContext.data.attentionResolution?.id ?? null)
        : null,
    updatedAt: parsedNow.data,
    revision: current.revision + 1,
  });
  if (!candidate.success) {
    return throwInvalidTransition();
  }

  return candidate.data;
};
