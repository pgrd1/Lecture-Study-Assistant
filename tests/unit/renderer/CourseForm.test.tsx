/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CourseForm } from '../../../src/renderer/components/CourseForm';
import '../../setup/renderer';

describe('CourseForm', () => {
  it('rejects a blank course name without submitting', () => {
    const onSubmit = vi.fn(async () => true);
    render(<CourseForm onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: '과목 추가' }));

    expect(screen.getByRole('alert')).toHaveTextContent('과목명을 입력해 주세요.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('trims course fields and clears them after a successful save', async () => {
    const onSubmit = vi.fn(async () => true);
    render(<CourseForm onSubmit={onSubmit} />);
    const name = screen.getByLabelText('과목명');
    const professor = screen.getByLabelText('교수 표시명 (선택)');

    fireEvent.change(name, { target: { value: '  자료구조  ' } });
    fireEvent.change(professor, { target: { value: '  김교수  ' } });
    fireEvent.click(screen.getByRole('button', { name: '과목 추가' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        name: '자료구조',
        professorName: '김교수',
      }),
    );
    await waitFor(() => expect(name).toHaveValue(''));
    expect(professor).toHaveValue('');
  });
});
