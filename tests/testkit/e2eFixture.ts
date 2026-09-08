import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import { AppSettingsSchema } from '../../src/shared/contracts/settings';
import { courseFixture } from './fixtures';
import { seedQueueJob } from './queueFixture';

export type FoundationE2eFixture = Readonly<{
  root: string;
  userDataPath: string;
  queueRoot: string;
  vaultRoot: string;
  recordingNotes(): Promise<readonly string[]>;
  dispose(): Promise<void>;
}>;

type FoundationFixtureOptions = Readonly<{
  pcWasOffline: boolean;
}>;

const assertSafeTestRoot = (root: string): void => {
  const relativePath = relative(resolve(tmpdir()), resolve(root));
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath) ||
    !relativePath.startsWith('lecture-study-assistant-e2e-')
  ) {
    throw new TypeError('UNSAFE_E2E_ROOT');
  }
};

const listMarkdown = async (directory: string): Promise<readonly string[]> => {
  try {
    return Object.freeze((await readdir(directory)).filter((name) => name.endsWith('.md')).sort());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Object.freeze([]);
    }
    throw error;
  }
};

export const createFoundationFixture = async (
  options: FoundationFixtureOptions,
): Promise<FoundationE2eFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'lecture-study-assistant-e2e-'));
  assertSafeTestRoot(root);
  const userDataPath = join(root, 'userData');
  const queueRoot = join(root, 'iCloud Queue');
  const vaultRoot = join(root, 'Obsidian Vault');
  await Promise.all([
    mkdir(userDataPath, { recursive: true }),
    mkdir(queueRoot, { recursive: true }),
  ]);

  try {
    // Fixture setup creates an empty, recognized Vault. The packaged app exercises
    // the production Vault boundary on startup; Playwright needs no XML renderer.
    await mkdir(join(vaultRoot, '.obsidian'), { recursive: true });
    const managedRoot = join(vaultRoot, 'AI 학습');
    await mkdir(managedRoot);
    const database = openDatabase(join(userDataPath, 'study.sqlite3'));
    try {
      const repositories = createRepositories(database);
      repositories.settings.insert(
        AppSettingsSchema.parse({
          schemaVersion: 1,
          vaultPath: vaultRoot,
          icloudQueuePath: queueRoot,
          defaultSummaryMode: 'standard',
          autoStart: false,
          processingPaused: false,
          legalNoticeAcceptedAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
          revision: 0,
        }),
      );
      repositories.courses.insert(courseFixture());
    } finally {
      database.close();
    }

    if (options.pcWasOffline) {
      await seedQueueJob(queueRoot);
    }

    const recordingDirectory = join(managedRoot, '과목', courseFixture().folderName, '녹음');
    return Object.freeze({
      root,
      userDataPath,
      queueRoot,
      vaultRoot,
      recordingNotes: () => listMarkdown(recordingDirectory),
      dispose: async () => {
        assertSafeTestRoot(root);
        await rm(root, { recursive: true, force: true });
      },
    });
  } catch (error) {
    assertSafeTestRoot(root);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};
