import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRuntimePaths } from '../../../src/main/runtimePaths';
import { BootstrapStateSchema } from '../../../src/shared/contracts/ipc';

describe('runtime path isolation', () => {
  it('uses the normal Electron userData path without a test override', () => {
    const userDataPath = resolve('C:\\Users\\student\\AppData\\StudyApp');

    const paths = resolveRuntimePaths({
      defaultUserDataPath: userDataPath,
      environment: {},
      e2eBuild: false,
    });

    expect(paths).toEqual({
      userDataPath,
      databasePath: join(userDataPath, 'study.sqlite3'),
      stagingRoot: join(userDataPath, 'staging'),
      secretsPath: join(userDataPath, 'secrets.json'),
      providerRuntimeRoot: join(userDataPath, 'providers'),
      providerProfilesRoot: join(userDataPath, 'providers', 'profiles'),
      providerTempRoot: join(userDataPath, 'providers', 'temp'),
      providerWorkspaceRoot: join(userDataPath, 'providers', 'workspace'),
      testMode: false,
    });
    expect(Object.isFrozen(paths)).toBe(true);
  });

  it('keeps every CLI-visible runtime path strictly below the same provider root', () => {
    const paths = resolveRuntimePaths({
      defaultUserDataPath: resolve('C:\\normal'),
      environment: {},
      e2eBuild: false,
    });

    for (const path of [
      paths.providerProfilesRoot,
      paths.providerTempRoot,
      paths.providerWorkspaceRoot,
    ]) {
      const relativePath = relative(paths.providerRuntimeRoot, path);
      expect(relativePath).not.toBe('');
      expect(relativePath.startsWith('..')).toBe(false);
      expect(isAbsolute(relativePath)).toBe(false);
    }
  });

  it.each([
    {
      providerRuntimeRoot: 'C:\\Users\\student\\private\\providers',
    },
    {
      knownFolders: {
        appData: 'C:\\Users\\student\\AppData\\Roaming',
        localAppData: 'C:\\Users\\student\\AppData\\Local',
        programFiles: 'C:\\Program Files',
        architecture: 'x64',
      },
    },
  ])('strictly rejects private runtime provenance in public bootstrap state', (privateState) => {
    const forgedPublicState = {
      settings: {
        vaultConfigured: false,
        queueConfigured: false,
        defaultSummaryMode: 'concise',
        autoStart: false,
        processingPaused: false,
        legalNoticeAccepted: false,
      },
      courses: [],
      jobs: [],
      counts: { queued: 0, processing: 0, completed: 0, failed: 0 },
      synchronizationIssueCount: 0,
      ...privateState,
    };

    expect(BootstrapStateSchema.safeParse(forgedPublicState).success).toBe(false);
  });

  it('accepts only an E2E-build test root under the system temp directory', () => {
    const root = join(tmpdir(), 'lecture-study-assistant-e2e-safe-fixture');

    expect(
      resolveRuntimePaths({
        defaultUserDataPath: resolve('C:\\normal'),
        environment: { NODE_ENV: 'test', STUDYAPP_TEST_ROOT: root },
        e2eBuild: true,
      }),
    ).toMatchObject({
      userDataPath: join(root, 'userData'),
      testMode: true,
    });
  });

  it.each([
    {
      environment: {
        NODE_ENV: 'production',
        STUDYAPP_TEST_ROOT: join(tmpdir(), 'lecture-study-assistant-e2e-a'),
      },
      e2eBuild: true,
    },
    {
      environment: {
        NODE_ENV: 'test',
        STUDYAPP_TEST_ROOT: join(tmpdir(), 'lecture-study-assistant-e2e-b'),
      },
      e2eBuild: false,
    },
    {
      environment: { NODE_ENV: 'test', STUDYAPP_TEST_ROOT: resolve('C:\\outside') },
      e2eBuild: true,
    },
    {
      environment: { NODE_ENV: 'test', STUDYAPP_TEST_ROOT: join(tmpdir(), 'wrong-prefix') },
      e2eBuild: true,
    },
  ])('rejects unsafe or production override %#', ({ environment, e2eBuild }) => {
    expect(() =>
      resolveRuntimePaths({
        defaultUserDataPath: resolve('C:\\normal'),
        environment,
        e2eBuild,
      }),
    ).toThrow('TEST_ROOT_OVERRIDE_REJECTED');
  });
});
