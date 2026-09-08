/** @vitest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/renderer/app/App';
import { bootstrapStateFixture, createStudyAppApi, installStudyAppApi } from '../../setup/renderer';

const COURSE_ID = '11111111-1111-4111-8111-111111111111';

describe('App onboarding', () => {
  it('guides a new user through Vault, iCloud queue, and first course', async () => {
    const initial = bootstrapStateFixture();
    const withVault = bootstrapStateFixture({
      settings: { ...initial.settings, vaultConfigured: true },
    });
    const withQueue = bootstrapStateFixture({
      settings: { ...withVault.settings, queueConfigured: true },
    });
    const ready = bootstrapStateFixture({
      settings: withQueue.settings,
      courses: [
        {
          id: COURSE_ID,
          name: '자료구조',
          professorName: '',
          userInstructions: '',
          archived: false,
          revision: 0,
        },
      ],
    });
    const api = createStudyAppApi(initial, {
      chooseVault: vi.fn(async () => ({
        ok: true as const,
        data: { cancelled: false as const, state: withVault },
      })),
      chooseQueue: vi.fn(async () => ({
        ok: true as const,
        data: { cancelled: false as const, state: withQueue },
      })),
      createCourse: vi.fn(async () => ({ ok: true as const, data: ready })),
    });
    installStudyAppApi(api);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '처음 설정' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '기존 Vault 선택' }));
    await waitFor(() => expect(api.chooseVault).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'iCloud 대기열 선택' }));
    await waitFor(() => expect(api.chooseQueue).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('과목명'), { target: { value: '자료구조' } });
    fireEvent.click(screen.getByRole('button', { name: '과목 추가' }));

    expect(await screen.findByRole('heading', { name: '자료구조' })).toBeVisible();
    expect(api.createCourse).toHaveBeenCalledExactlyOnceWith({
      name: '자료구조',
      professorName: '',
    });
  });

  it('shows queue counts and wires retry, auto-start, and diagnostics actions', async () => {
    const ready = bootstrapStateFixture({
      settings: {
        ...bootstrapStateFixture().settings,
        vaultConfigured: true,
        queueConfigured: true,
      },
      courses: [
        {
          id: COURSE_ID,
          name: '자료구조',
          professorName: '김교수',
          userInstructions: '정의 비교 문제를 자주 출제',
          archived: false,
          revision: 1,
        },
      ],
      jobs: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          courseId: COURSE_ID,
          sourceFileName: '중간고사 특강.m4a',
          sourceMediaType: 'audio',
          summaryMode: 'standard',
          status: 'failed',
          retryCount: 1,
          error: {
            code: 'DATABASE_BUSY',
            message: '로컬 데이터베이스가 사용 중입니다. 잠시 후 다시 시도해 주세요.',
            retryable: true,
          },
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:01:00.000Z',
        },
      ],
      counts: { queued: 2, processing: 1, completed: 7, failed: 1 },
      synchronizationIssueCount: 1,
    });
    const autoStarted = bootstrapStateFixture({
      ...ready,
      settings: { ...ready.settings, autoStart: true },
    });
    const retryJob = vi.fn(async () => ({ ok: true as const, data: ready }));
    const setAutoStart = vi.fn(async () => ({ ok: true as const, data: autoStarted }));
    const exportDiagnostics = vi.fn(async () => ({
      ok: true as const,
      data: { cancelled: false as const },
    }));
    installStudyAppApi(createStudyAppApi(ready, { exportDiagnostics, retryJob, setAutoStart }));

    render(<App />);

    expect(await screen.findByRole('heading', { name: '학습 대시보드' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '자료구조' })).toBeVisible();
    expect(screen.getByText('중간고사 특강.m4a')).toBeVisible();
    expect(screen.getAllByText('확인 필요')).not.toHaveLength(0);
    expect(screen.getByText('동기화 확인 필요 1건')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() =>
      expect(retryJob).toHaveBeenCalledExactlyOnceWith('22222222-2222-4222-8222-222222222222'),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Windows 로그인 시 자동 시작' }));
    await waitFor(() => expect(setAutoStart).toHaveBeenCalledExactlyOnceWith(true));
    fireEvent.click(screen.getByRole('button', { name: '진단 보고서 내보내기' }));
    await waitFor(() => expect(exportDiagnostics).toHaveBeenCalledOnce());
  });

  it('does not let a late bootstrap snapshot overwrite newer subscribed state', async () => {
    const initial = bootstrapStateFixture();
    const current = bootstrapStateFixture({
      settings: {
        ...initial.settings,
        vaultConfigured: true,
        queueConfigured: true,
      },
      courses: [
        {
          id: COURSE_ID,
          name: '최신 과목',
          professorName: '',
          userInstructions: '',
          archived: false,
          revision: 2,
        },
      ],
    });
    let publishState: (state: typeof current) => void = () => undefined;
    let resolveBootstrap: (response: { ok: true; data: typeof initial }) => void = () => undefined;
    const bootstrapPromise = new Promise<{ ok: true; data: typeof initial }>((resolve) => {
      resolveBootstrap = resolve;
    });
    const api = createStudyAppApi(initial, {
      getBootstrapState: vi.fn(async () => await bootstrapPromise),
      subscribeToState: vi.fn((callback) => {
        publishState = callback;
        return () => undefined;
      }),
    });
    installStudyAppApi(api);
    render(<App />);

    act(() => publishState(current));
    expect(await screen.findByRole('heading', { name: '최신 과목' })).toBeVisible();
    await act(async () => resolveBootstrap({ ok: true, data: initial }));

    expect(screen.getByRole('heading', { name: '최신 과목' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '처음 설정' })).not.toBeInTheDocument();
  });

  it('keeps the dashboard available when every course is archived and restores one', async () => {
    const archived = bootstrapStateFixture({
      settings: {
        ...bootstrapStateFixture().settings,
        vaultConfigured: true,
        queueConfigured: true,
      },
      courses: [
        {
          id: COURSE_ID,
          name: '자료구조',
          professorName: '김교수',
          userInstructions: '',
          archived: true,
          revision: 1,
        },
      ],
    });
    const archivedCourse = archived.courses[0];
    if (archivedCourse === undefined) throw new TypeError('TEST_COURSE_MISSING');
    const restored = bootstrapStateFixture({
      ...archived,
      courses: [{ ...archivedCourse, archived: false, revision: 2 }],
    });
    const restoreCourse = vi.fn(async () => ({ ok: true as const, data: restored }));
    installStudyAppApi(createStudyAppApi(archived, { restoreCourse }));

    render(<App />);

    expect(await screen.findByRole('heading', { name: '학습 대시보드' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '처음 설정' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '과목 복원' }));
    await waitFor(() => expect(restoreCourse).toHaveBeenCalledExactlyOnceWith(COURSE_ID));
    expect(await screen.findByRole('button', { name: '과목 보관' })).toBeVisible();
  });
});
