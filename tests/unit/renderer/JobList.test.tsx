/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JobList } from '../../../src/renderer/components/JobList';
import { JobSummarySchema } from '../../../src/shared/contracts/ipc';
import '../../setup/renderer';

const COURSE_ID = '11111111-1111-4111-8111-111111111111';
const course = {
  id: COURSE_ID,
  name: '자료구조',
  professorName: '',
  userInstructions: '',
  archived: false,
  revision: 0,
} as const;

const job = (
  id: string,
  status: 'queued' | 'processing' | 'completed' | 'failed',
  summaryMode: 'none' | 'core' | 'standard' | 'full',
  courseId = COURSE_ID,
  sourceCount = 1,
) =>
  JobSummarySchema.parse({
    id,
    courseId,
    sourceFileName: `${status}.m4a`,
    sourceMediaType: 'audio',
    sourceCount,
    summaryMode,
    status,
    retryCount: 0,
    error:
      status === 'failed'
        ? {
            code: 'DATABASE_BUSY',
            message: '로컬 데이터베이스가 사용 중입니다. 잠시 후 다시 시도해 주세요.',
            retryable: true,
          }
        : null,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:01:00.000Z',
  });

describe('JobList', () => {
  it('explains an empty job history', () => {
    render(<JobList courses={[course]} jobs={[]} onRetry={vi.fn(async () => undefined)} />);
    expect(screen.getByText('아직 처리한 강의 파일이 없습니다.')).toBeVisible();
  });

  it('renders text-and-symbol statuses and retries only failed work', () => {
    const onRetry = vi.fn(async () => undefined);
    const jobs = [
      job('22222222-2222-4222-8222-222222222221', 'queued', 'none'),
      job('22222222-2222-4222-8222-222222222222', 'processing', 'core'),
      job('22222222-2222-4222-8222-222222222223', 'completed', 'standard'),
      job(
        '22222222-2222-4222-8222-222222222224',
        'failed',
        'full',
        '33333333-3333-4333-8333-333333333333',
        2,
      ),
    ];
    render(<JobList courses={[course]} jobs={jobs} onRetry={onRetry} />);

    expect(screen.getByText('대기')).toBeVisible();
    expect(screen.getByText('처리 중')).toBeVisible();
    expect(screen.getByText('완료')).toBeVisible();
    expect(screen.getByText('확인 필요')).toBeVisible();
    expect(screen.getByText('자료구조 · 요약 안 함 요약')).toBeVisible();
    expect(screen.getByText('알 수 없는 과목 · 상세 요약')).toBeVisible();
    expect(screen.getByText('파일 2개')).toBeVisible();
    expect(screen.getAllByRole('button', { name: '다시 시도' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('22222222-2222-4222-8222-222222222224');
  });
});
