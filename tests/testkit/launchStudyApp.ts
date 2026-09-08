import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type ElectronApplication, _electron as electron } from '@playwright/test';
import type { FoundationE2eFixture } from './e2eFixture';

const packagedExecutable = (): string =>
  process.env.STUDYAPP_E2E_EXECUTABLE === undefined
    ? resolve(
        process.cwd(),
        'out',
        'e2e',
        'Lecture Study Assistant-win32-x64',
        'Lecture Study Assistant.exe',
      )
    : resolve(process.env.STUDYAPP_E2E_EXECUTABLE);

export const launchStudyApp = async (
  fixture: FoundationE2eFixture,
): Promise<ElectronApplication> => {
  const executablePath = packagedExecutable();
  await access(executablePath);

  return electron.launch({
    executablePath,
    args: [`--user-data-dir=${fixture.userDataPath}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      STUDYAPP_TEST_ROOT: fixture.root,
    },
  });
};
