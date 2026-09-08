import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CourseService } from '../../src/application/courses/courseService';
import { JobRunner, type JobRunnerDependencies } from '../../src/application/jobs/jobRunner';
import { LocalSourceIntake } from '../../src/application/jobs/localSourceIntake';
import { SourceArchiver } from '../../src/application/jobs/sourceArchiver';
import { StagingSourceCleaner } from '../../src/application/jobs/stagingSourceCleaner';
import type { CourseCatalog } from '../../src/core/ports/courseCatalog';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import { ICloudQueue } from '../../src/infrastructure/queue/icloudQueue';
import { VaultService } from '../../src/infrastructure/vault/vaultService';
import { VaultWriter } from '../../src/infrastructure/vault/vaultWriter';
import { FakeProcessor } from '../../src/processors/fakeProcessor';
import { FakeClock } from './fakeClock';
import { TEST_IDS } from './fixtures';

const STARTED_AT = '2026-09-01T00:00:00.000Z';

const NOOP_CATALOG: CourseCatalog = Object.freeze({
  publish: async () => undefined,
});

export const createFoundationServices = async (tempRoot: string) => {
  const vaultRoot = join(tempRoot, 'Obsidian Vault');
  const queueRoot = join(tempRoot, 'iCloud Queue');
  const stagingRoot = join(tempRoot, 'App Data', 'staging');
  const databasePath = join(tempRoot, 'App Data', 'study.sqlite3');
  await mkdir(queueRoot, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  const clock = new FakeClock(STARTED_AT);
  const connection = await new VaultService().connect({ path: vaultRoot, mode: 'create' });
  const database = openDatabase(databasePath);
  const repositories = createRepositories(database);
  const vault = new VaultWriter(connection, {
    clock: () => new Date(clock.now()),
    idGenerator: randomUUID,
  });
  const queue = new ICloudQueue(queueRoot, {
    clock: () => Date.parse(clock.now()),
    idGenerator: randomUUID,
  });
  let courseIdAvailable = true;
  const courseService = new CourseService({
    repository: repositories.courses,
    vault,
    catalog: NOOP_CATALOG,
    clock: () => clock.now(),
    idGenerator: () => {
      if (courseIdAvailable) {
        courseIdAvailable = false;
        return TEST_IDS.course;
      }
      return randomUUID();
    },
  });
  const sourceArchiver = new SourceArchiver({
    artifacts: repositories.artifacts,
    connection,
    vault,
    clock: () => clock.now(),
  });
  const stagingCleaner = new StagingSourceCleaner(stagingRoot);
  const processor = new FakeProcessor();
  const runnerDependencies: JobRunnerDependencies = {
    artifacts: repositories.artifacts,
    courseProvisioner: courseService,
    courses: repositories.courses,
    jobs: repositories.jobs,
    sourceBundles: repositories.sourceBundles,
    queue,
    vault,
    processor,
    sourceArchiver,
    stagingRoot,
    clock: () => clock.now(),
  };
  const createRunner = (overrides: Partial<JobRunnerDependencies> = {}) =>
    new JobRunner({ ...runnerDependencies, ...overrides });
  const runner = createRunner();
  const localIntake = new LocalSourceIntake({
    courses: repositories.courses,
    jobs: repositories.jobs,
    sourceBundles: repositories.sourceBundles,
    stagingRoot,
    clock: () => clock.now(),
  });

  return Object.freeze({
    clock,
    connection,
    courseService,
    database,
    createRunner,
    localIntake,
    paths: Object.freeze({ databasePath, queueRoot, stagingRoot, vaultRoot }),
    queue,
    repositories,
    runner,
    sourceArchiver,
    stagingCleaner,
    vault,
  });
};
