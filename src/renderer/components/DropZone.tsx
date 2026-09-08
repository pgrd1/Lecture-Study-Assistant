import { type DragEvent, useState } from 'react';
import type { BootstrapState } from '../../shared/contracts/ipc';
import type { SummaryMode } from '../../shared/contracts/job';
import { SupportedSourceFileNameSchema } from '../../shared/contracts/sourceFile';

type Course = BootstrapState['courses'][number];
type PendingSourceSummary = Readonly<{ key: string; name: string; size: number }>;

type DropZoneProps = Readonly<{
  courses: readonly Course[];
  defaultSummaryMode?: SummaryMode;
  onMessage?(message: string): void;
  onStateChange?(state: BootstrapState): void;
}>;

type PendingSource =
  | Readonly<{
      kind: 'drop';
      files: readonly File[];
      sources: readonly PendingSourceSummary[];
    }>
  | Readonly<{
      kind: 'selection';
      selectionToken: string;
      sources: readonly PendingSourceSummary[];
    }>;

const formatFileSize = (size: number): string => {
  if (size < 1024) {
    return `${size} B`;
  }
  const kibibytes = size / 1024;
  if (kibibytes < 1024) {
    return `${Number.isInteger(kibibytes) ? kibibytes : kibibytes.toFixed(1)} KB`;
  }
  const mebibytes = kibibytes / 1024;
  return `${Number.isInteger(mebibytes) ? mebibytes : mebibytes.toFixed(1)} MB`;
};

export const DropZone = ({
  courses,
  defaultSummaryMode = 'standard',
  onMessage,
  onStateChange,
}: DropZoneProps) => {
  const activeCourses = courses.filter((course) => !course.archived);
  const [pending, setPending] = useState<PendingSource | null>(null);
  const [courseId, setCourseId] = useState('');
  const [summaryMode, setSummaryMode] = useState<SummaryMode>(defaultSummaryMode);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const announce = (nextMessage: string): void => {
    setMessage(nextMessage);
    onMessage?.(nextMessage);
  };

  const acceptDroppedFiles = (files: readonly File[]): void => {
    if (files.length < 1 || files.length > 32) {
      setPending(null);
      announce('파일은 1개 이상 32개 이하로 추가해 주세요.');
      return;
    }
    if (files.some((file) => !SupportedSourceFileNameSchema.safeParse(file.name).success)) {
      setPending(null);
      announce('지원하지 않는 파일 형식입니다.');
      return;
    }
    setPending(
      Object.freeze({
        kind: 'drop',
        files: Object.freeze([...files]),
        sources: Object.freeze(
          files.map(({ name, size }, ordinal) =>
            Object.freeze({ key: `${ordinal}:${name}:${size}`, name, size }),
          ),
        ),
      }),
    );
    announce('파일을 확인했습니다. 과목과 요약 수준을 선택해 주세요.');
  };

  const handleDrop = (event: DragEvent<HTMLFieldSetElement>): void => {
    event.preventDefault();
    acceptDroppedFiles(Array.from(event.dataTransfer.files));
  };

  const chooseSources = async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await window.studyApp.chooseSources();
      if (!response.ok) {
        announce(response.error.message);
        return;
      }
      if (response.data.cancelled) {
        announce('파일 선택을 취소했습니다.');
        return;
      }
      setPending(
        Object.freeze({
          kind: 'selection',
          selectionToken: response.data.selectionToken,
          sources: Object.freeze(
            response.data.files.map(({ name, size }, ordinal) =>
              Object.freeze({ key: `${ordinal}:${name}:${size}`, name, size }),
            ),
          ),
        }),
      );
      announce('파일을 확인했습니다. 과목과 요약 수준을 선택해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const enqueue = async (): Promise<void> => {
    if (pending === null || !activeCourses.some((course) => course.id === courseId)) {
      announce('파일과 과목을 먼저 선택해 주세요.');
      return;
    }
    setBusy(true);
    try {
      const response =
        pending.kind === 'drop'
          ? await window.studyApp.enqueueDroppedFiles({
              courseId,
              files: pending.files,
              summaryMode,
            })
          : await window.studyApp.enqueueSelection({
              selectionToken: pending.selectionToken,
              courseId,
              summaryMode,
            });
      if (!response.ok) {
        announce(response.error.message);
        return;
      }
      onStateChange?.(response.data);
      setPending(null);
      setCourseId('');
      announce('강의 파일을 처리 대기열에 추가했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="intake-panel">
      <fieldset
        className="drop-zone"
        aria-label="강의 파일 놓기"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <span className="drop-icon" aria-hidden="true">
          ↓
        </span>
        <strong>강의 파일을 여기에 놓으세요</strong>
        <p>음성·영상·PDF·PPTX·텍스트·이미지를 한 번에 32개까지 확인합니다.</p>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => void chooseSources()}
        >
          컴퓨터에서 파일 선택
        </button>
      </fieldset>

      {pending === null ? null : (
        <fieldset className="pending-file" aria-label="선택한 강의 파일">
          <div>
            <strong>파일 {pending.sources.length}개</strong>
            {pending.sources.map((source) => (
              <span key={source.key}>
                <span>{source.name}</span>
                <span>{formatFileSize(source.size)}</span>
              </span>
            ))}
          </div>
          <button
            className="button button-quiet"
            type="button"
            disabled={busy}
            onClick={() => setPending(null)}
          >
            선택 취소
          </button>
        </fieldset>
      )}

      <div className="intake-controls">
        <label>
          과목 선택
          <select
            value={courseId}
            disabled={busy}
            onChange={(event) => setCourseId(event.currentTarget.value)}
          >
            <option value="">과목을 선택하세요</option>
            {activeCourses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          요약 수준
          <select
            value={summaryMode}
            disabled={busy}
            onChange={(event) => setSummaryMode(event.currentTarget.value as SummaryMode)}
          >
            <option value="none">요약 안 함</option>
            <option value="core">핵심만</option>
            <option value="standard">표준</option>
            <option value="full">상세</option>
          </select>
        </label>
        <button
          className="button button-primary"
          type="button"
          disabled={busy || pending === null || courseId === ''}
          onClick={() => void enqueue()}
        >
          {busy ? '처리 중…' : '처리 대기열에 추가'}
        </button>
      </div>

      {message === '' ? null : (
        <p
          className={
            message.includes('지원하지') || message.includes('이상 32개 이하')
              ? 'form-error'
              : 'intake-message'
          }
          role={
            message.includes('지원하지') || message.includes('이상 32개 이하') ? 'alert' : 'status'
          }
        >
          {message}
        </p>
      )}
    </div>
  );
};
