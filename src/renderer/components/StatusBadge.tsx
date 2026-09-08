import type { BootstrapState } from '../../shared/contracts/ipc';

type JobStatus = BootstrapState['jobs'][number]['status'];

const STATUS_LABELS = Object.freeze({
  queued: '대기',
  processing: '처리 중',
  completed: '완료',
  failed: '확인 필요',
} as const satisfies Record<JobStatus, string>);

const STATUS_SYMBOLS = Object.freeze({
  queued: '•',
  processing: '↻',
  completed: '✓',
  failed: '!',
} as const satisfies Record<JobStatus, string>);

export const StatusBadge = ({ status }: Readonly<{ status: JobStatus }>) => (
  <span className={`status-badge status-${status}`}>
    <span aria-hidden="true" className="status-symbol">
      {STATUS_SYMBOLS[status]}
    </span>
    {STATUS_LABELS[status]}
  </span>
);
