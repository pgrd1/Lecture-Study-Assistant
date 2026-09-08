/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DropZone } from '../../../src/renderer/components/DropZone';
import { bootstrapStateFixture, createStudyAppApi, installStudyAppApi } from '../../setup/renderer';

const COURSE_ID = '11111111-1111-4111-8111-111111111111';
const course = {
  id: COURSE_ID,
  name: '자료구조',
  professorName: '김교수',
  userInstructions: '',
  archived: false,
  revision: 0,
} as const;

describe('DropZone', () => {
  it('keeps a dropped file until the user chooses a course and confirms', async () => {
    const state = bootstrapStateFixture({ courses: [course] });
    const enqueueDroppedFiles = vi.fn(async () => ({ ok: true as const, data: state }));
    installStudyAppApi(createStudyAppApi(state, { enqueueDroppedFiles }));
    const onStateChange = vi.fn();
    render(<DropZone courses={[course]} onStateChange={onStateChange} />);
    const file = new File([new Uint8Array(2048)], 'lecture.m4a', { type: 'audio/mp4' });

    fireEvent.drop(screen.getByLabelText('강의 파일 놓기'), {
      dataTransfer: { files: [file] },
    });

    expect(screen.getByText('lecture.m4a')).toBeVisible();
    expect(screen.getByText('2 KB')).toBeVisible();
    expect(screen.getByLabelText('요약 수준')).toHaveValue('standard');
    expect(enqueueDroppedFiles).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('과목 선택'), { target: { value: COURSE_ID } });
    fireEvent.click(screen.getByRole('button', { name: '처리 대기열에 추가' }));

    await waitFor(() =>
      expect(enqueueDroppedFiles).toHaveBeenCalledExactlyOnceWith({
        courseId: COURSE_ID,
        files: [file],
        summaryMode: 'standard',
      }),
    );
    expect(onStateChange).toHaveBeenCalledWith(state);
  });

  it('accepts an ordered multi-file drop and submits every File together', async () => {
    const state = bootstrapStateFixture({ courses: [course] });
    const enqueueDroppedFiles = vi.fn(async () => ({ ok: true as const, data: state }));
    const api = createStudyAppApi(state, { enqueueDroppedFiles });
    installStudyAppApi(api);
    render(<DropZone courses={[course]} />);
    const zone = screen.getByLabelText('강의 파일 놓기');
    const first = new File(['a'], 'a.m4a');
    const second = new File(['b'], 'b.pdf');

    fireEvent.drop(zone, {
      dataTransfer: { files: [first, second] },
    });
    expect(screen.getByText('a.m4a')).toBeVisible();
    expect(screen.getByText('b.pdf')).toBeVisible();
    expect(screen.getByText('파일 2개')).toBeVisible();
    fireEvent.change(screen.getByLabelText('과목 선택'), { target: { value: COURSE_ID } });
    fireEvent.click(screen.getByRole('button', { name: '처리 대기열에 추가' }));

    await waitFor(() =>
      expect(enqueueDroppedFiles).toHaveBeenCalledExactlyOnceWith({
        courseId: COURSE_ID,
        files: [first, second],
        summaryMode: 'standard',
      }),
    );
  });

  it('rejects unsupported, empty, and 33-file drops in Korean without submitting', () => {
    const state = bootstrapStateFixture({ courses: [course] });
    const api = createStudyAppApi(state);
    installStudyAppApi(api);
    render(<DropZone courses={[course]} />);
    const zone = screen.getByLabelText('강의 파일 놓기');

    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(['x'], 'malware.exe')] },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('지원하지 않는 파일 형식입니다.');

    for (const files of [
      [],
      Array.from({ length: 33 }, (_, index) => new File(['x'], `${index}.m4a`)),
    ]) {
      fireEvent.drop(zone, { dataTransfer: { files } });
      expect(screen.getByRole('alert')).toHaveTextContent(
        '파일은 1개 이상 32개 이하로 추가해 주세요.',
      );
    }
    expect(api.enqueueDroppedFiles).not.toHaveBeenCalled();
  });

  it('renders a dialog-selected bundle and submits its one-use token', async () => {
    const state = bootstrapStateFixture({ courses: [course] });
    const chooseSources = vi.fn(async () => ({
      ok: true as const,
      data: {
        cancelled: false as const,
        selectionToken: '33333333-3333-4333-8333-333333333333',
        files: [
          { name: '3주차.pdf', size: 1024 },
          { name: '3주차.m4a', size: 2048 },
        ],
      },
    }));
    const enqueueSelection = vi.fn(async () => ({ ok: true as const, data: state }));
    installStudyAppApi(createStudyAppApi(state, { chooseSources, enqueueSelection }));
    render(<DropZone courses={[course]} />);

    fireEvent.click(screen.getByRole('button', { name: '컴퓨터에서 파일 선택' }));
    expect(await screen.findByText('3주차.pdf')).toBeVisible();
    expect(screen.getByText('3주차.m4a')).toBeVisible();
    expect(screen.getByText('파일 2개')).toBeVisible();
    fireEvent.change(screen.getByLabelText('과목 선택'), { target: { value: COURSE_ID } });
    fireEvent.change(screen.getByLabelText('요약 수준'), { target: { value: 'core' } });
    fireEvent.click(screen.getByRole('button', { name: '처리 대기열에 추가' }));

    await waitFor(() =>
      expect(enqueueSelection).toHaveBeenCalledExactlyOnceWith({
        selectionToken: '33333333-3333-4333-8333-333333333333',
        courseId: COURSE_ID,
        summaryMode: 'core',
      }),
    );
  });
});
