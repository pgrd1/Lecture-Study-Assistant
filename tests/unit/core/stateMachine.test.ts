import { describe, expect, it } from 'vitest';
import {
  type AttentionResolution,
  classifyFailure,
  resumeStatus,
  transitionJob,
} from '../../../src/core/jobs/stateMachine';
import { type Job, type JobStatus, MAX_AUTOMATIC_RETRIES } from '../../../src/shared/contracts/job';
import { APP_ERROR_MESSAGES, AppError } from '../../../src/shared/errors';
import { jobFixture, TEST_IDS } from '../../testkit/fixtures';

const NOW = '2026-09-01T01:00:00.000Z';

const NORMAL_EDGES = [
  ['queued', 'receiving'],
  ['receiving', 'source_ready'],
  ['source_ready', 'transcribing_or_extracting'],
  ['transcribing_or_extracting', 'structuring'],
  ['structuring', 'generating'],
  ['generating', 'verifying'],
  ['verifying', 'writing'],
  ['writing', 'completed'],
] as const satisfies ReadonlyArray<readonly [JobStatus, JobStatus]>;

const retryableFailure = (): AppError =>
  new AppError('SOURCE_HASH_FAILED', APP_ERROR_MESSAGES.SOURCE_HASH_FAILED);

const attentionFailure = (): AppError =>
  new AppError('SOURCE_TOO_LARGE', APP_ERROR_MESSAGES.SOURCE_TOO_LARGE);

const resolutionFor = (job: Job): AttentionResolution => ({
  id: TEST_IDS.attentionResolution,
  jobId: job.id,
  failureRevision: job.revision,
  createdAt: '2026-09-01T00:30:00.000Z',
});

const fixtureForStatus = (status: JobStatus): Job =>
  jobFixture({
    status,
    ...(status === 'completed' ? { lastSuccessfulStatus: 'completed' as const } : {}),
    ...(status === 'retryable_failed'
      ? { errorCode: 'SOURCE_HASH_FAILED' as const }
      : status === 'needs_attention'
        ? { errorCode: 'SOURCE_TOO_LARGE' as const }
        : {}),
  });

describe('immutable job state machine', () => {
  it('advances without mutating the old job', () => {
    const before = jobFixture({ status: 'queued', revision: 0 });
    const after = transitionJob(before, 'receiving', NOW);

    expect(after).toMatchObject({
      status: 'receiving',
      lastSuccessfulStatus: 'queued',
      revision: 1,
      updatedAt: NOW,
    });
    expect(before).toMatchObject({ status: 'queued', revision: 0 });
    expect(after).not.toBe(before);
    expect(Object.isFrozen(after)).toBe(true);
  });

  it.each(NORMAL_EDGES)('allows the normal edge %s -> %s', (current, next) => {
    const after = transitionJob(jobFixture({ status: current }), next, NOW);

    expect(after.status).toBe(next);
    expect(after.lastSuccessfulStatus).toBe(resumeStatus(next));
  });

  it.each(NORMAL_EDGES.map(([status]) => status))(
    'records retryable and attention failures atomically from %s',
    (status) => {
      const retryable = transitionJob(
        jobFixture({ status, retryCount: 2 }),
        'retryable_failed',
        NOW,
        { failure: retryableFailure() },
      );
      const attention = transitionJob(jobFixture({ status }), 'needs_attention', NOW, {
        failure: attentionFailure(),
      });

      expect(retryable).toMatchObject({
        status: 'retryable_failed',
        retryCount: 3,
        errorCode: 'SOURCE_HASH_FAILED',
      });
      expect(attention).toMatchObject({
        status: 'needs_attention',
        attentionResolutionId: null,
        errorCode: 'SOURCE_TOO_LARGE',
      });
    },
  );

  it('requires a trusted failure in the same transition', () => {
    const job = jobFixture({ status: 'structuring' });

    expect(() => transitionJob(job, 'retryable_failed', NOW)).toThrow('INVALID_JOB_TRANSITION');
    expect(() =>
      transitionJob(job, 'retryable_failed', NOW, {
        failure: Object.assign(Object.create(AppError.prototype) as AppError, {
          code: 'SOURCE_HASH_FAILED',
          displayMessage: APP_ERROR_MESSAGES.SOURCE_HASH_FAILED,
          retryable: true,
        }),
      }),
    ).toThrow('INVALID_JOB_TRANSITION');
  });

  it('returns from a retryable failure only to the persisted successful checkpoint', () => {
    const failed = jobFixture({
      status: 'retryable_failed',
      lastSuccessfulStatus: 'source_ready',
      errorCode: 'SOURCE_HASH_FAILED',
    });
    const resumed = transitionJob(failed, 'source_ready', NOW);

    expect(resumed).toMatchObject({
      status: 'source_ready',
      lastSuccessfulStatus: 'source_ready',
      errorCode: null,
    });
    expect(() => transitionJob(failed, 'transcribing_or_extracting', NOW)).toThrow(
      'INVALID_JOB_TRANSITION',
    );
  });

  it('binds attention resolution to the current job and failure revision', () => {
    const unresolved = jobFixture({
      status: 'needs_attention',
      errorCode: 'SOURCE_TOO_LARGE',
    });
    expect(() => transitionJob(unresolved, 'queued', NOW)).toThrow('INVALID_JOB_TRANSITION');
    expect(() =>
      transitionJob(unresolved, 'queued', NOW, {
        attentionResolution: {
          ...resolutionFor(unresolved),
          failureRevision: unresolved.revision - 1,
        },
      }),
    ).toThrow('INVALID_JOB_TRANSITION');
    expect(() =>
      transitionJob(unresolved, 'queued', NOW, {
        attentionResolution: {
          ...resolutionFor(unresolved),
          jobId: '44444444-4444-4444-8444-444444444444',
        },
      }),
    ).toThrow('INVALID_JOB_TRANSITION');

    const resolved = transitionJob(unresolved, 'queued', NOW, {
      attentionResolution: resolutionFor(unresolved),
    });
    expect(resolved).toMatchObject({
      status: 'queued',
      lastSuccessfulStatus: 'queued',
      attentionResolutionId: TEST_IDS.attentionResolution,
      errorCode: null,
      retryCount: 0,
    });
  });

  it('does not accept a resolution record replayed for a later failure', () => {
    const firstFailure = jobFixture({
      status: 'needs_attention',
      errorCode: 'SOURCE_TOO_LARGE',
    });
    const firstResolution = resolutionFor(firstFailure);
    const queued = transitionJob(firstFailure, 'queued', NOW, {
      attentionResolution: firstResolution,
    });
    const receiving = transitionJob(queued, 'receiving', '2026-09-01T01:00:00.001Z');
    const secondFailure = transitionJob(receiving, 'needs_attention', '2026-09-01T01:00:00.002Z', {
      failure: attentionFailure(),
    });

    expect(secondFailure.attentionResolutionId).toBeNull();
    expect(() =>
      transitionJob(secondFailure, 'queued', '2026-09-01T01:00:00.003Z', {
        attentionResolution: firstResolution,
      }),
    ).toThrow('INVALID_JOB_TRANSITION');
  });

  it('caps automatic retry and escalates an exhausted retryable error', () => {
    const job = jobFixture({ status: 'structuring', retryCount: MAX_AUTOMATIC_RETRIES });
    const error = retryableFailure();

    expect(classifyFailure(error, job.retryCount)).toBe('needs_attention');
    expect(() => transitionJob(job, 'retryable_failed', NOW, { failure: error })).toThrow(
      'INVALID_JOB_TRANSITION',
    );
    expect(transitionJob(job, 'needs_attention', NOW, { failure: error })).toMatchObject({
      status: 'needs_attention',
      retryCount: MAX_AUTOMATIC_RETRIES,
      errorCode: 'SOURCE_HASH_FAILED',
    });
  });

  it('retries only transient database locks and escalates other database failures', () => {
    const busy = new AppError('DATABASE_BUSY', APP_ERROR_MESSAGES.DATABASE_BUSY);
    const damaged = new AppError('DATABASE_ERROR', APP_ERROR_MESSAGES.DATABASE_ERROR);

    expect(classifyFailure(busy)).toBe('retryable_failed');
    expect(classifyFailure(damaged)).toBe('needs_attention');
  });

  it.each([
    ['queued', 'writing'],
    ['completed', 'queued'],
    ['writing', 'verifying'],
    ['structuring', 'structuring'],
    ['retryable_failed', 'needs_attention'],
  ] as const)('blocks the denied edge %s -> %s', (current, next) => {
    expect(() => transitionJob(fixtureForStatus(current), next, NOW)).toThrow(
      'INVALID_JOB_TRANSITION',
    );
  });

  it('requires a strictly increasing transition timestamp', () => {
    const job = jobFixture({ updatedAt: NOW });

    expect(() => transitionJob(job, 'receiving', 'yesterday')).toThrow('INVALID_JOB_TRANSITION');
    expect(() => transitionJob(job, 'receiving', '2026-08-31T23:59:59.999Z')).toThrow(
      'INVALID_JOB_TRANSITION',
    );
    expect(() => transitionJob(job, 'receiving', NOW)).toThrow('INVALID_JOB_TRANSITION');
  });

  it.each([
    ['queued', 'queued'],
    ['receiving', 'queued'],
    ['source_ready', 'source_ready'],
    ['transcribing_or_extracting', 'source_ready'],
    ['structuring', 'transcribing_or_extracting'],
    ['generating', 'structuring'],
    ['verifying', 'generating'],
    ['writing', 'verifying'],
    ['completed', 'completed'],
    ['retryable_failed', 'retryable_failed'],
    ['needs_attention', 'needs_attention'],
  ] as const satisfies ReadonlyArray<readonly [JobStatus, JobStatus]>)(
    'maps persisted %s to safe resume checkpoint %s',
    (status, expected) => {
      expect(resumeStatus(status)).toBe(expected);
    },
  );

  it('classifies only policy-approved application errors for automatic retry', () => {
    expect(classifyFailure(retryableFailure())).toBe('retryable_failed');
    expect(classifyFailure(attentionFailure())).toBe('needs_attention');
    expect(
      classifyFailure(
        new AppError('SOURCE_HASH_CANCELLED', APP_ERROR_MESSAGES.SOURCE_HASH_CANCELLED),
      ),
    ).toBe('needs_attention');
    expect(classifyFailure(new Error('network-ish but untrusted'))).toBe('needs_attention');
    expect(classifyFailure({ retryable: true })).toBe('needs_attention');

    const forged = Object.assign(Object.create(AppError.prototype) as AppError, {
      code: 'SOURCE_HASH_FAILED',
      displayMessage: APP_ERROR_MESSAGES.SOURCE_HASH_FAILED,
      retryable: true,
    });
    expect(classifyFailure(forged)).toBe('needs_attention');
  });
});
