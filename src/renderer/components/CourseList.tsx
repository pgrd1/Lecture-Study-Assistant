import { type FormEvent, useState } from 'react';
import type { CoursePatch } from '../../shared/contracts/course';
import type { BootstrapState } from '../../shared/contracts/ipc';

type Course = BootstrapState['courses'][number];

type CourseListProps = Readonly<{
  courses: readonly Course[];
  onArchive(id: string): Promise<void>;
  onRestore(id: string): Promise<void>;
  onUpdate(id: string, patch: CoursePatch): Promise<boolean>;
}>;

const CourseCard = ({
  course,
  onArchive,
  onRestore,
  onUpdate,
}: Readonly<{
  course: Course;
  onArchive(id: string): Promise<void>;
  onRestore(id: string): Promise<void>;
  onUpdate(id: string, patch: CoursePatch): Promise<boolean>;
}>) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(course.name);
  const [professorName, setProfessorName] = useState(course.professorName);
  const [userInstructions, setUserInstructions] = useState(course.userInstructions);
  const [busy, setBusy] = useState(false);

  const resetDraft = (): void => {
    setName(course.name);
    setProfessorName(course.professorName);
    setUserInstructions(course.userInstructions);
  };

  const toggleEditing = (): void => {
    resetDraft();
    setEditing((current) => !current);
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      const patch = {
        name: name.trim(),
        professorName: professorName.trim(),
        userInstructions,
      } satisfies CoursePatch;
      if (await onUpdate(course.id, patch)) {
        setEditing(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const restore = async (): Promise<void> => {
    setBusy(true);
    try {
      await onRestore(course.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="course-card">
      <div className="course-card-heading">
        <div>
          <p className="card-kicker">과목 메인 노트</p>
          <h2>{course.name}</h2>
          <p>{course.professorName === '' ? '교수 표시명 미설정' : course.professorName}</p>
        </div>
        <div className="button-row">
          {course.archived ? (
            <button
              className="button button-secondary"
              type="button"
              disabled={busy}
              onClick={() => void restore()}
            >
              {busy ? '복원 중…' : '과목 복원'}
            </button>
          ) : (
            <>
              <button className="button button-quiet" type="button" onClick={toggleEditing}>
                {editing ? '수정 취소' : '과목 수정'}
              </button>
              <button
                className="button button-danger"
                type="button"
                disabled={busy}
                onClick={() => void onArchive(course.id)}
              >
                과목 보관
              </button>
            </>
          )}
        </div>
      </div>
      {course.archived ? (
        <p className="muted">보관됨</p>
      ) : editing ? (
        <form className="course-edit-form" onSubmit={save}>
          <label>
            과목명
            <input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label>
            교수 표시명
            <input
              value={professorName}
              maxLength={80}
              onChange={(event) => setProfessorName(event.currentTarget.value)}
            />
          </label>
          <label>
            과목별 AI 지침·교수님 성향 메모
            <textarea
              value={userInstructions}
              maxLength={4000}
              rows={4}
              onChange={(event) => setUserInstructions(event.currentTarget.value)}
            />
          </label>
          <button
            className="button button-primary"
            type="submit"
            disabled={busy || name.trim() === ''}
          >
            {busy ? '저장 중…' : '수정 저장'}
          </button>
        </form>
      ) : course.userInstructions === '' ? (
        <p className="muted">교수님 성향과 과목별 AI 지침을 추가할 수 있습니다.</p>
      ) : (
        <p className="course-instructions">{course.userInstructions}</p>
      )}
    </article>
  );
};

export const CourseList = ({ courses, onArchive, onRestore, onUpdate }: CourseListProps) => {
  const activeCourses = courses.filter((course) => !course.archived);
  const archivedCourses = courses.filter((course) => course.archived);
  return (
    <div className="course-groups">
      {activeCourses.length === 0 ? (
        <p className="empty-state">활성 과목이 없습니다. 새 과목을 추가해 주세요.</p>
      ) : (
        <div className="course-list">
          {activeCourses.map((course) => (
            <CourseCard
              key={course.id}
              course={course}
              onArchive={onArchive}
              onRestore={onRestore}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      )}
      {archivedCourses.length === 0 ? null : (
        <section className="archived-course-section" aria-labelledby="archived-courses-title">
          <h3 id="archived-courses-title">보관된 과목</h3>
          <div className="course-list">
            {archivedCourses.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                onArchive={onArchive}
                onRestore={onRestore}
                onUpdate={onUpdate}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
