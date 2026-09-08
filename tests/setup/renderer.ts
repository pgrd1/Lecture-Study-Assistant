import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import {
  type BootstrapState,
  BootstrapStateSchema,
  type StudyAppApi,
} from '../../src/shared/contracts/ipc';

afterEach(() => cleanup());

export const bootstrapStateFixture = (overrides: Partial<BootstrapState> = {}): BootstrapState =>
  BootstrapStateSchema.parse({
    settings: {
      vaultConfigured: false,
      queueConfigured: false,
      defaultSummaryMode: 'standard',
      autoStart: false,
      processingPaused: false,
      legalNoticeAccepted: false,
      ...overrides.settings,
    },
    courses: overrides.courses ?? [],
    jobs: overrides.jobs ?? [],
    counts: overrides.counts ?? { queued: 0, processing: 0, completed: 0, failed: 0 },
    synchronizationIssueCount: overrides.synchronizationIssueCount ?? 0,
  });

export const createStudyAppApi = (
  state: BootstrapState,
  overrides: Partial<StudyAppApi> = {},
): StudyAppApi => {
  const defaultSuccess = async () => ({ ok: true as const, data: state });
  return Object.freeze({
    getBootstrapState: vi.fn(defaultSuccess),
    chooseVault: vi.fn(async () => ({ ok: true as const, data: { cancelled: true as const } })),
    chooseQueue: vi.fn(async () => ({ ok: true as const, data: { cancelled: true as const } })),
    createCourse: vi.fn(defaultSuccess),
    updateCourse: vi.fn(defaultSuccess),
    archiveCourse: vi.fn(defaultSuccess),
    restoreCourse: vi.fn(defaultSuccess),
    chooseSources: vi.fn(async () => ({
      ok: true as const,
      data: { cancelled: true as const, selectionToken: null, files: [] as const },
    })),
    enqueueSelection: vi.fn(defaultSuccess),
    enqueueDroppedFiles: vi.fn(defaultSuccess),
    retryJob: vi.fn(defaultSuccess),
    setAutoStart: vi.fn(defaultSuccess),
    exportDiagnostics: vi.fn(async () => ({
      ok: true as const,
      data: { cancelled: true as const },
    })),
    subscribeToState: vi.fn(() => () => undefined),
    ...overrides,
  });
};

export const installStudyAppApi = (api: StudyAppApi): void => {
  Object.defineProperty(window, 'studyApp', {
    configurable: true,
    value: api,
  });
};
