import type { BootstrapState } from '../../shared/contracts/ipc';
import { StatusBadge } from './StatusBadge';

type JobListProps = Readonly<{
  courses: BootstrapState['courses'];
  jobs: BootstrapState['jobs'];
  onRetry(id: string): Promise<void>;
}>;

const SUMMARY_LABELS = Object.freeze({
  none: '요약 안 함',
  core: '핵심만',
  standard: '표준',
  full: '상세',
} as const);

export const JobList = ({ courses, jobs, onRetry }: JobListProps) => {
  const courseNames = new Map(courses.map((course) => [course.id, course.name]));
  if (jobs.length === 0) {
    return <p className="empty-state">아직 처리한 강의 파일이 없습니다.</p>;
  }
  return (
    <ul className="job-list">
      {jobs.map((job) => (
        <li key={job.id} className="job-row">
          <div className="job-main">
            <div className="job-title-row">
              <strong>{job.sourceFileName}</strong>
              {(job.sourceCount ?? 1) > 1 ? <span>파일 {job.sourceCount}개</span> : null}
              <StatusBadge status={job.status} />
            </div>
            <p>
              {courseNames.get(job.courseId) ?? '알 수 없는 과목'} ·{' '}
              {SUMMARY_LABELS[job.summaryMode]} 요약
            </p>
            {job.error === null ? null : <p className="job-error">{job.error.message}</p>}
          </div>
          {job.status === 'failed' ? (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void onRetry(job.id)}
            >
              다시 시도
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
};
