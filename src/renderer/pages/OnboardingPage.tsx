import type { CourseInput } from '../../shared/contracts/course';
import type { BootstrapState } from '../../shared/contracts/ipc';
import { CourseForm } from '../components/CourseForm';

type OnboardingPageProps = Readonly<{
  state: BootstrapState;
  onChooseVault(): Promise<void>;
  onChooseQueue(): Promise<void>;
  onCreateCourse(input: CourseInput): Promise<boolean>;
}>;

const SetupState = ({ complete }: Readonly<{ complete: boolean }>) => (
  <span className={complete ? 'setup-state complete' : 'setup-state'}>
    <span aria-hidden="true">{complete ? '✓' : '○'}</span> {complete ? '완료' : '필요'}
  </span>
);

export const OnboardingPage = ({
  state,
  onChooseVault,
  onChooseQueue,
  onCreateCourse,
}: OnboardingPageProps) => {
  const hasActiveCourse = state.courses.some((course) => !course.archived);
  const storageReady = state.settings.vaultConfigured && state.settings.queueConfigured;
  return (
    <div className="onboarding-layout">
      <header className="onboarding-header">
        <p className="eyebrow">LECTURE STUDY ASSISTANT</p>
        <h1>처음 설정</h1>
        <p>강의 파일은 이 PC에서 처리되고, 결과는 표준 Markdown으로 Obsidian Vault에 저장됩니다.</p>
      </header>

      <ol className="setup-grid" aria-label="처음 설정 단계">
        <li className="setup-card">
          <div className="setup-card-title">
            <span className="step-number">1</span>
            <h2>Obsidian Vault 연결</h2>
            <SetupState complete={state.settings.vaultConfigured} />
          </div>
          <p>
            iPad까지 안정적으로 보려면 Obsidian Sync를 권장합니다. iCloud Drive 안의 Vault도 선택할
            수 있습니다.
          </p>
          <div className="button-row">
            <button
              className="button button-primary"
              type="button"
              onClick={() => void onChooseVault()}
            >
              기존 Vault 선택
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void onChooseVault()}
            >
              새 Vault 만들기
            </button>
          </div>
        </li>

        <li className="setup-card">
          <div className="setup-card-title">
            <span className="step-number">2</span>
            <h2>iCloud 대기열 연결</h2>
            <SetupState complete={state.settings.queueConfigured} />
          </div>
          <p>PC가 꺼져 있을 때 보낸 녹음도 이 폴더에 남아, 다음 실행 때 자동으로 확인합니다.</p>
          <button
            className="button button-primary"
            type="button"
            disabled={!state.settings.vaultConfigured}
            onClick={() => void onChooseQueue()}
          >
            iCloud 대기열 선택
          </button>
        </li>

        <li className="setup-card">
          <div className="setup-card-title">
            <span className="step-number">3</span>
            <h2>첫 과목 추가</h2>
            <SetupState complete={hasActiveCourse} />
          </div>
          <p>
            과목 메인 노트 아래에 녹음별 서브 노트가 만들어집니다. 과목은 나중에도 추가할 수
            있습니다.
          </p>
          <CourseForm disabled={!storageReady} onSubmit={onCreateCourse} />
        </li>
      </ol>
      {!storageReady || !hasActiveCourse ? (
        <p className="onboarding-note">세 단계를 마치기 전에는 자동 처리를 시작하지 않습니다.</p>
      ) : null}
    </div>
  );
};
