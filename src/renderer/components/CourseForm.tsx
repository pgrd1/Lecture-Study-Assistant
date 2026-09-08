import { type FormEvent, useId, useState } from 'react';
import type { CourseInput } from '../../shared/contracts/course';

type CourseFormProps = Readonly<{
  disabled?: boolean;
  onSubmit(input: CourseInput): Promise<boolean>;
  submitLabel?: string;
}>;

export const CourseForm = ({
  disabled = false,
  onSubmit,
  submitLabel = '과목 추가',
}: CourseFormProps) => {
  const fieldId = useId();
  const [name, setName] = useState('');
  const [professorName, setProfessorName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedProfessor = professorName.trim();
    if (trimmedName.length === 0) {
      setError('과목명을 입력해 주세요.');
      return;
    }
    if (trimmedName.length > 80 || trimmedProfessor.length > 80) {
      setError('과목명과 교수 표시명은 80자 이하로 입력해 주세요.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      if (await onSubmit({ name: trimmedName, professorName: trimmedProfessor })) {
        setName('');
        setProfessorName('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="course-form" onSubmit={handleSubmit} noValidate>
      <div className="field-group">
        <label htmlFor={`${fieldId}-name`}>과목명</label>
        <input
          id={`${fieldId}-name`}
          value={name}
          maxLength={80}
          disabled={disabled || submitting}
          onChange={(event) => setName(event.currentTarget.value)}
          autoComplete="off"
        />
      </div>
      <div className="field-group">
        <label htmlFor={`${fieldId}-professor`}>교수 표시명 (선택)</label>
        <input
          id={`${fieldId}-professor`}
          value={professorName}
          maxLength={80}
          disabled={disabled || submitting}
          onChange={(event) => setProfessorName(event.currentTarget.value)}
          autoComplete="off"
        />
      </div>
      {error === '' ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="button button-primary" type="submit" disabled={disabled || submitting}>
        {submitting ? '저장 중…' : submitLabel}
      </button>
    </form>
  );
};
