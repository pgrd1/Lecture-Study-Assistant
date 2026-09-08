import type { CourseInput, CoursePatch } from '../../shared/contracts/course';
import type { BootstrapState } from '../../shared/contracts/ipc';
import { CourseForm } from '../components/CourseForm';
import { CourseList } from '../components/CourseList';
import { DropZone } from '../components/DropZone';
import { JobList } from '../components/JobList';

type DashboardPageProps = Readonly<{
  state: BootstrapState;
  onArchiveCourse(id: string): Promise<void>;
  onRestoreCourse(id: string): Promise<void>;
  onCreateCourse(input: CourseInput): Promise<boolean>;
  onExportDiagnostics(): Promise<void>;
  onRetryJob(id: string): Promise<void>;
  onSetAutoStart(enabled: boolean): Promise<void>;
  onStateChange(state: BootstrapState): void;
  onStatus(message: string): void;
  onUpdateCourse(id: string, patch: CoursePatch): Promise<boolean>;
}>;

export const DashboardPage = ({
  state,
  onArchiveCourse,
  onRestoreCourse,
  onCreateCourse,
  onExportDiagnostics,
  onRetryJob,
  onSetAutoStart,
  onStateChange,
  onStatus,
  onUpdateCourse,
}: DashboardPageProps) => (
  <div className="dashboard-layout">
    <header className="dashboard-header">
      <div>
        <p className="eyebrow">LOCAL-FIRST · OBSIDIAN READY</p>
        <h1>학습 대시보드</h1>
        <p>강의 자료를 과목별 메인 노트와 녹음 서브 노트로 정리합니다.</p>
      </div>
      <div className="header-actions">
        <label className="toggle-control">
          <input
            type="checkbox"
            checked={state.settings.autoStart}
            onChange={(event) => void onSetAutoStart(event.currentTarget.checked)}
          />
          Windows 로그인 시 자동 시작
        </label>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => void onExportDiagnostics()}
        >
          진단 보고서 내보내기
        </button>
      </div>
    </header>

    <section aria-labelledby="queue-summary-title">
      <h2 className="section-title" id="queue-summary-title">
        처리 현황
      </h2>
      <dl className="metric-grid">
        <div>
          <dt>대기</dt>
          <dd>{state.counts.queued}</dd>
        </div>
        <div>
          <dt>처리 중</dt>
          <dd>{state.counts.processing}</dd>
        </div>
        <div>
          <dt>완료</dt>
          <dd>{state.counts.completed}</dd>
        </div>
        <div className={state.counts.failed > 0 ? 'metric-attention' : undefined}>
          <dt>확인 필요</dt>
          <dd>{state.counts.failed}</dd>
        </div>
      </dl>
    </section>

    <section className="dashboard-section" aria-labelledby="intake-title">
      <div className="section-heading">
        <div>
          <p className="card-kicker">ADD MATERIAL</p>
          <h2 id="intake-title">강의 파일 추가</h2>
        </div>
      </div>
      <DropZone
        courses={state.courses}
        defaultSummaryMode={state.settings.defaultSummaryMode}
        onMessage={onStatus}
        onStateChange={onStateChange}
      />
    </section>

    <section className="dashboard-section" aria-labelledby="courses-title">
      <div className="section-heading">
        <div>
          <p className="card-kicker">COURSES</p>
          <h2 id="courses-title">과목</h2>
        </div>
      </div>
      <CourseList
        courses={state.courses}
        onArchive={onArchiveCourse}
        onRestore={onRestoreCourse}
        onUpdate={onUpdateCourse}
      />
      <details className="add-course-panel">
        <summary>새 과목 추가</summary>
        <CourseForm onSubmit={onCreateCourse} />
      </details>
    </section>

    <section className="dashboard-section" aria-labelledby="jobs-title">
      <div className="section-heading">
        <div>
          <p className="card-kicker">RECENT JOBS</p>
          <h2 id="jobs-title">최근 작업</h2>
        </div>
        {state.synchronizationIssueCount > 0 ? (
          <p className="sync-warning" role="status">
            동기화 확인 필요 {state.synchronizationIssueCount}건
          </p>
        ) : null}
      </div>
      <JobList courses={state.courses} jobs={state.jobs} onRetry={onRetryJob} />
    </section>
  </div>
);
