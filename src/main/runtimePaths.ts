import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export type RuntimePaths = Readonly<{
  userDataPath: string;
  databasePath: string;
  stagingRoot: string;
  secretsPath: string;
  providerRuntimeRoot: string;
  providerProfilesRoot: string;
  providerTempRoot: string;
  providerWorkspaceRoot: string;
  testMode: boolean;
}>;

type RuntimePathOptions = Readonly<{
  defaultUserDataPath: string;
  environment: Readonly<Record<string, string | undefined>>;
  e2eBuild: boolean;
}>;

const rejectedOverride = (): never => {
  throw new TypeError('TEST_ROOT_OVERRIDE_REJECTED');
};

const pathsFor = (userDataPath: string, testMode: boolean): RuntimePaths => {
  const providerRuntimeRoot = join(userDataPath, 'providers');
  return Object.freeze({
    userDataPath,
    databasePath: join(userDataPath, 'study.sqlite3'),
    stagingRoot: join(userDataPath, 'staging'),
    secretsPath: join(userDataPath, 'secrets.json'),
    providerRuntimeRoot,
    providerProfilesRoot: join(providerRuntimeRoot, 'profiles'),
    providerTempRoot: join(providerRuntimeRoot, 'temp'),
    providerWorkspaceRoot: join(providerRuntimeRoot, 'workspace'),
    testMode,
  });
};

export const resolveRuntimePaths = (options: RuntimePathOptions): RuntimePaths => {
  const defaultUserDataPath = resolve(options.defaultUserDataPath);
  if (
    !isAbsolute(options.defaultUserDataPath) ||
    options.defaultUserDataPath.includes('\0') ||
    options.defaultUserDataPath.length > 32_767
  ) {
    return rejectedOverride();
  }

  const override = options.environment.STUDYAPP_TEST_ROOT;
  if (override === undefined) {
    return pathsFor(defaultUserDataPath, false);
  }
  if (
    !options.e2eBuild ||
    options.environment.NODE_ENV !== 'test' ||
    !isAbsolute(override) ||
    override.includes('\0') ||
    override.length > 32_767
  ) {
    return rejectedOverride();
  }

  const root = resolve(override);
  const relativeToTemp = relative(resolve(tmpdir()), root);
  if (
    relativeToTemp.length === 0 ||
    relativeToTemp.startsWith('..') ||
    isAbsolute(relativeToTemp) ||
    !basename(root).startsWith('lecture-study-assistant-e2e-')
  ) {
    return rejectedOverride();
  }

  return pathsFor(join(root, 'userData'), true);
};
