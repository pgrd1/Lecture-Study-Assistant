/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CourseList } from '../../../src/renderer/components/CourseList';
import '../../setup/renderer';

const COURSE_ID = '11111111-1111-4111-8111-111111111111';
const activeCourse = {
  id: COURSE_ID,
  name: '자료구조',
  professorName: '',
  userInstructions: '',
  archived: false,
  revision: 0,
} as const;

describe('CourseList', () => {
  it('shows archived courses with an explicit restore action', () => {
    const onRestore = vi.fn(async () => undefined);
    render(
      <CourseList
        courses={[{ ...activeCourse, archived: true }]}
        onArchive={vi.fn(async () => undefined)}
        onRestore={onRestore}
        onUpdate={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByText('활성 과목이 없습니다. 새 과목을 추가해 주세요.')).toBeVisible();
    expect(screen.getByRole('heading', { name: '자료구조' })).toBeVisible();
    expect(screen.getByText('보관됨')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '과목 복원' }));
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(COURSE_ID);
  });

  it('edits professor tendencies and archives through explicit actions', async () => {
    const onUpdate = vi.fn(async () => true);
    const onArchive = vi.fn(async () => undefined);
    render(
      <CourseList
        courses={[activeCourse]}
        onArchive={onArchive}
        onRestore={vi.fn(async () => undefined)}
        onUpdate={onUpdate}
      />,
    );

    expect(screen.getByText('교수 표시명 미설정')).toBeVisible();
    expect(screen.getByText('교수님 성향과 과목별 AI 지침을 추가할 수 있습니다.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '과목 수정' }));
    fireEvent.change(screen.getByLabelText('과목명'), { target: { value: '  알고리즘  ' } });
    fireEvent.change(screen.getByLabelText('교수 표시명'), { target: { value: '  김교수  ' } });
    fireEvent.change(screen.getByLabelText('과목별 AI 지침·교수님 성향 메모'), {
      target: { value: '증명 문제를 자주 출제' },
    });
    fireEvent.click(screen.getByRole('button', { name: '수정 저장' }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledExactlyOnceWith(COURSE_ID, {
        name: '알고리즘',
        professorName: '김교수',
        userInstructions: '증명 문제를 자주 출제',
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '과목 수정' })).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: '과목 보관' }));
    expect(onArchive).toHaveBeenCalledExactlyOnceWith(COURSE_ID);
  });

  it('keeps the editor open when persistence rejects an update', async () => {
    const onUpdate = vi.fn(async () => false);
    render(
      <CourseList
        courses={[{ ...activeCourse, professorName: '김교수', userInstructions: '서술형 중심' }]}
        onArchive={vi.fn(async () => undefined)}
        onRestore={vi.fn(async () => undefined)}
        onUpdate={onUpdate}
      />,
    );

    expect(screen.getByText('서술형 중심')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '과목 수정' }));
    fireEvent.click(screen.getByRole('button', { name: '수정 저장' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '수정 취소' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '수정 취소' }));
    expect(screen.getByRole('button', { name: '과목 수정' })).toBeVisible();
  });

  it('discards a cancelled draft and reloads the latest course revision', () => {
    const onArchive = vi.fn(async () => undefined);
    const onUpdate = vi.fn(async () => true);
    const { rerender } = render(
      <CourseList
        courses={[activeCourse]}
        onArchive={onArchive}
        onRestore={vi.fn(async () => undefined)}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '과목 수정' }));
    fireEvent.change(screen.getByLabelText('과목명'), { target: { value: '취소할 이름' } });
    fireEvent.click(screen.getByRole('button', { name: '수정 취소' }));
    fireEvent.click(screen.getByRole('button', { name: '과목 수정' }));
    expect(screen.getByLabelText('과목명')).toHaveValue('자료구조');
    fireEvent.click(screen.getByRole('button', { name: '수정 취소' }));

    rerender(
      <CourseList
        courses={[
          { ...activeCourse, name: '최신 자료구조', professorName: '새 교수', revision: 1 },
        ]}
        onArchive={onArchive}
        onRestore={vi.fn(async () => undefined)}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '과목 수정' }));
    expect(screen.getByLabelText('과목명')).toHaveValue('최신 자료구조');
    expect(screen.getByLabelText('교수 표시명')).toHaveValue('새 교수');
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
