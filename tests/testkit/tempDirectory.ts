import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach } from 'vitest';

const registeredDirectories = new Set<string>();
const systemTempRoot = resolve(tmpdir());

const isInsideSystemTemp = (directory: string): boolean => {
  const relativeDirectory = relative(systemTempRoot, resolve(directory));
  return (
    relativeDirectory.length > 0 &&
    !relativeDirectory.startsWith('..') &&
    !isAbsolute(relativeDirectory)
  );
};

const assertSafeFixtureName = (name: string): void => {
  if (
    name.length === 0 ||
    name !== basename(name) ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new TypeError('SAFE_TEST_PATH');
  }
};

afterEach(async () => {
  const directories = [...registeredDirectories];
  registeredDirectories.clear();

  await Promise.all(
    directories.map((directory) => {
      if (!isInsideSystemTemp(directory)) {
        throw new TypeError('SAFE_TEST_CLEANUP_PATH');
      }
      return rm(directory, { recursive: true, force: true });
    }),
  );
});

export const withTempDirectory = async <T>(
  testBody: (directory: string) => Promise<T> | T,
): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'lecture-study-assistant-'));
  registeredDirectories.add(directory);

  return testBody(directory);
};

export const fixtureFile = async (
  name: string,
  bytes: Buffer | Uint8Array | string,
): Promise<string> =>
  withTempDirectory(async (directory) => {
    assertSafeFixtureName(name);
    const filePath = join(directory, name);
    await writeFile(filePath, bytes);
    return filePath;
  });
