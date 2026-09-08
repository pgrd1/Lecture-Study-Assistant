import type { StudyAppApi } from '../contracts/ipc';

declare global {
  const __STUDYAPP_E2E_BUILD__: boolean;

  interface Window {
    readonly studyApp: StudyAppApi;
  }
}
