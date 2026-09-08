import { useCallback, useEffect, useState } from 'react';
import type { CourseInput, CoursePatch } from '../../shared/contracts/course';
import type { BootstrapState } from '../../shared/contracts/ipc';
import { DashboardPage } from '../pages/DashboardPage';
import { OnboardingPage } from '../pages/OnboardingPage';

const isReady = (state: BootstrapState): boolean =>
  state.settings.vaultConfigured && state.settings.queueConfigured && state.courses.length > 0;

export const App = () => {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [statusMessage, setStatusMessage] = useState('로컬 학습 공간을 확인하고 있습니다.');

  useEffect(() => {
    let active = true;
    let receivedSubscribedState = false;
    const unsubscribe = window.studyApp.subscribeToState((nextState) => {
      if (active) {
        receivedSubscribedState = true;
        setState(nextState);
        setStatusMessage('최신 작업 상태를 반영했습니다.');
      }
    });
    void window.studyApp.getBootstrapState().then((response) => {
      if (!active || receivedSubscribedState) {
        return;
      }
      if (response.ok) {
        setState(response.data);
        setStatusMessage('로컬 학습 공간을 불러왔습니다.');
      } else {
        setStatusMessage(response.error.message);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const chooseVault = useCallback(async (): Promise<void> => {
    setStatusMessage('Obsidian Vault를 확인하고 있습니다.');
    const response = await window.studyApp.chooseVault();
    if (!response.ok) {
      setStatusMessage(response.error.message);
      return;
    }
    if (response.data.cancelled) {
      setStatusMessage('Vault 선택을 취소했습니다.');
      return;
    }
    setState(response.data.state);
    setStatusMessage('Obsidian Vault를 연결했습니다.');
  }, []);

  const chooseQueue = useCallback(async (): Promise<void> => {
    setStatusMessage('iCloud 대기열을 확인하고 있습니다.');
    const response = await window.studyApp.chooseQueue();
    if (!response.ok) {
      setStatusMessage(response.error.message);
      return;
    }
    if (response.data.cancelled) {
      setStatusMessage('iCloud 대기열 선택을 취소했습니다.');
      return;
    }
    setState(response.data.state);
    setStatusMessage('iCloud 대기열을 연결했습니다.');
  }, []);

  const createCourse = useCallback(async (input: CourseInput): Promise<boolean> => {
    setStatusMessage('과목을 추가하고 있습니다.');
    const response = await window.studyApp.createCourse(input);
    if (!response.ok) {
      setStatusMessage(response.error.message);
      return false;
    }
    setState(response.data);
    setStatusMessage(`${input.name} 과목을 추가했습니다.`);
    return true;
  }, []);

  const updateCourse = useCallback(async (id: string, patch: CoursePatch): Promise<boolean> => {
    const response = await window.studyApp.updateCourse(id, patch);
    if (!response.ok) {
      setStatusMessage(response.error.message);
      return false;
    }
    setState(response.data);
    setStatusMessage('과목 정보를 수정했습니다.');
    return true;
  }, []);

  const archiveCourse = useCallback(async (id: string): Promise<void> => {
    const response = await window.studyApp.archiveCourse(id);
    if (!response.ok) {
      setStatusMessage(response.error.message);
      return;
    }
    setState(response.data);
    setStatusMessage('과목을 보관했습니다. 기존 노트는 그대로 유지됩니다.');
  }, []);

  const restoreCourse = useCallback(async (id: string): Promise<void> => {
    const response = await window.studyApp.restoreCourse(id);
    if (!response.ok) {
      setStatusMessage(response.error.message);
      return;
    }
    setState(response.data);
    setStatusMessage('과목을 복원했습니다. 기존 노트와 녹음은 그대로 유지됩니다.');
  }, []);

  const retryJob = useCallback(async (id: string): Promise<void> => {
    const response = await window.studyApp.retryJob(id);
    if (!response.ok) {
      setStatusMessage(response.error.message);
      return;
    }
    setState(response.data);
    setStatusMessage('작업을 다시 대기열에 넣었습니다.');
  }, []);

  const setAutoStart = useCallback(async (enabled: boolean): Promise<void> => {
    const response = await window.studyApp.setAutoStart(enabled);
    if (!response.ok) {
      setStatusMessage(response.error.message);
      return;
    }
    setState(response.data);
    setStatusMessage(enabled ? 'Windows 로그인 시 자동 시작합니다.' : '자동 시작을 껐습니다.');
  }, []);

  const exportDiagnostics = useCallback(async (): Promise<void> => {
    const response = await window.studyApp.exportDiagnostics();
    if (!response.ok) {
      setStatusMessage(response.error.message);
      return;
    }
    setStatusMessage(
      response.data.cancelled ? '진단 보고서 저장을 취소했습니다.' : '진단 보고서를 저장했습니다.',
    );
  }, []);

  return (
    <main className="app-shell">
      {state === null ? (
        <section className="loading-card" aria-labelledby="loading-title">
          <p className="eyebrow">LOCAL-FIRST STUDY WORKFLOW</p>
          <h1 id="loading-title">Lecture Study Assistant</h1>
          <p>PC 안의 학습 상태를 불러오는 중입니다.</p>
        </section>
      ) : isReady(state) ? (
        <DashboardPage
          state={state}
          onArchiveCourse={archiveCourse}
          onRestoreCourse={restoreCourse}
          onCreateCourse={createCourse}
          onExportDiagnostics={exportDiagnostics}
          onRetryJob={retryJob}
          onSetAutoStart={setAutoStart}
          onStateChange={setState}
          onStatus={setStatusMessage}
          onUpdateCourse={updateCourse}
        />
      ) : (
        <OnboardingPage
          state={state}
          onChooseQueue={chooseQueue}
          onChooseVault={chooseVault}
          onCreateCourse={createCourse}
        />
      )}
      <p className="sr-status" aria-live="polite" aria-atomic="true">
        {statusMessage}
      </p>
    </main>
  );
};
