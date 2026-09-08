/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/renderer/app/App';
import { bootstrapStateFixture, createStudyAppApi, installStudyAppApi } from '../../setup/renderer';

describe('initial application shell', () => {
  it('guides a new user to start setup', () => {
    const state = bootstrapStateFixture();
    installStudyAppApi(
      createStudyAppApi(state, {
        getBootstrapState: vi.fn(async () => await new Promise<never>(() => undefined)),
      }),
    );
    render(<App />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Lecture Study Assistant' }),
    ).toBeVisible();
    expect(screen.getByText('PC 안의 학습 상태를 불러오는 중입니다.')).toBeVisible();
  });
});
