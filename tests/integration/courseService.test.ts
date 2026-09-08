import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CourseService } from '../../src/application/courses/courseService';
import type { CourseCatalog } from '../../src/core/ports/courseCatalog';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import { JsonCourseCatalog } from '../../src/infrastructure/queue/jsonCourseCatalog';
import { VaultService } from '../../src/infrastructure/vault/vaultService';
import { VaultWriter } from '../../src/infrastructure/vault/vaultWriter';
import { AppSettingsSchema } from '../../src/shared/contracts/settings';
import { APP_ERROR_MESSAGES, AppError } from '../../src/shared/errors';
import { withTempDirectory } from '../testkit/tempDirectory';

const NOW = '2026-09-01T00:00:00.000Z';
const LATER = '2026-09-01T01:00:00.000Z';
const COURSE_IDS = Object.freeze([
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
]);
const MOBILE_COURSE_REQUEST = Object.freeze({
  id: '77777777-7777-4777-8777-777777777777',
  name: '운영체제',
  professorName: '김교수',
});

const openedDatabases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const database of openedDatabases.splice(0)) {
    database.close();
  }
});

const createHarness = async (root: string) => {
  const vaultRoot = join(root, 'Vault');
  const queueRoot = join(root, 'iCloud Queue');
  await mkdir(queueRoot);
  const connection = await new VaultService().connect({ path: vaultRoot, mode: 'create' });
  const database = openDatabase(join(root, 'study.sqlite3'));
  openedDatabases.push(database);
  const repositories = createRepositories(database);
  repositories.settings.insert(
    AppSettingsSchema.parse({
      schemaVersion: 1,
      vaultPath: vaultRoot,
      icloudQueuePath: queueRoot,
      defaultSummaryMode: 'standard',
      autoStart: false,
      processingPaused: false,
      legalNoticeAcceptedAt: null,
      updatedAt: NOW,
      revision: 0,
    }),
  );

  const ids = [...COURSE_IDS];
  let now = NOW;
  const writer = new VaultWriter(connection, {
    clock: () => new Date(now),
  });
  const catalog = new JsonCourseCatalog(repositories.settings, {
    clock: () => now,
  });
  const service = new CourseService({
    repository: repositories.courses,
    vault: writer,
    catalog,
    clock: () => now,
    idGenerator: () => {
      const id = ids.shift();
      if (id === undefined) {
        throw new TypeError('TEST_ID_EXHAUSTED');
      }
      return id;
    },
  });

  return Object.freeze({
    catalogPath: join(queueRoot, 'Catalog', 'courses.json'),
    connection,
    queueRoot,
    repositories,
    service,
    setNow: (value: string) => {
      now = value;
    },
    vaultRoot,
  });
};

describe('CourseService', () => {
  it('provisions a mobile course using its supplied UUID', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);

      const created = await harness.service.provision(MOBILE_COURSE_REQUEST);

      expect(created.id).toBe(MOBILE_COURSE_REQUEST.id);
      expect(harness.repositories.courses.get(MOBILE_COURSE_REQUEST.id)).toEqual(created);
    });
  });

  it('keeps the Windows course as authority when a stale mobile request is retried', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const created = await harness.service.provision(MOBILE_COURSE_REQUEST);
      const renamed = await harness.service.update(created.id, {
        name: '고급 운영체제',
        professorName: '박교수',
      });

      await expect(harness.service.provision(MOBILE_COURSE_REQUEST)).resolves.toEqual(renamed);
      expect(harness.repositories.courses.get(MOBILE_COURSE_REQUEST.id)).toEqual(renamed);
    });
  });

  it('refuses to reprovision an archived mobile course', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const created = await harness.service.provision(MOBILE_COURSE_REQUEST);
      const archived = await harness.service.archive(created.id);

      await expect(harness.service.provision(MOBILE_COURSE_REQUEST)).rejects.toThrow(
        'COURSE_NOT_FOUND',
      );
      expect(harness.repositories.courses.get(created.id)).toEqual(archived);
    });
  });

  it('rejects a mobile course whose folder collides with an existing course', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      await harness.service.provision(MOBILE_COURSE_REQUEST);

      await expect(
        harness.service.provision({
          id: '88888888-8888-4888-8888-888888888888',
          name: '운영체제',
          professorName: '다른 교수',
        }),
      ).rejects.toThrow('DUPLICATE_COURSE');
      expect(harness.repositories.courses.list({ includeArchived: true })).toHaveLength(1);
    });
  });

  it('serializes concurrent retries of one mobile request into one course and note', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);

      const results = await Promise.all([
        harness.service.provision(MOBILE_COURSE_REQUEST),
        harness.service.provision(MOBILE_COURSE_REQUEST),
        harness.service.provision(MOBILE_COURSE_REQUEST),
      ]);

      expect(results).toEqual([results[0], results[0], results[0]]);
      expect(harness.repositories.courses.list({ includeArchived: true })).toHaveLength(1);
      await expect(
        readFile(join(harness.connection.managedRoot, '과목', '운영체제', '운영체제.md'), 'utf8'),
      ).resolves.toContain(MOBILE_COURSE_REQUEST.id);
    });
  });

  it('keeps the course and note after catalog publication fails, then recovers on retry', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const catalog = new JsonCourseCatalog(harness.repositories.settings, { clock: () => NOW });
      let shouldFail = true;
      const strictCatalog: CourseCatalog = {
        publish: async (courses) => {
          if (shouldFail) {
            shouldFail = false;
            throw new AppError('QUEUE_WRITE_FAILED', APP_ERROR_MESSAGES.QUEUE_WRITE_FAILED);
          }
          await catalog.publish(courses);
        },
      };
      const service = new CourseService({
        repository: harness.repositories.courses,
        vault: new VaultWriter(harness.connection),
        catalog: strictCatalog,
        clock: () => NOW,
      });

      await expect(service.provision(MOBILE_COURSE_REQUEST)).rejects.toThrow('QUEUE_WRITE_FAILED');
      expect(harness.repositories.courses.get(MOBILE_COURSE_REQUEST.id)).not.toBeNull();
      await expect(
        readFile(join(harness.connection.managedRoot, '과목', '운영체제', '운영체제.md'), 'utf8'),
      ).resolves.toContain(MOBILE_COURSE_REQUEST.id);

      await expect(service.provision(MOBILE_COURSE_REQUEST)).resolves.toMatchObject({
        id: MOBILE_COURSE_REQUEST.id,
      });
      expect(harness.repositories.courses.list({ includeArchived: true })).toHaveLength(1);
      expect(JSON.parse(await readFile(harness.catalogPath, 'utf8'))).toMatchObject({
        courses: [{ id: MOBILE_COURSE_REQUEST.id, name: '운영체제' }],
      });
    });
  });

  it('creates the course hierarchy and publishes only minimal active course data', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const algorithms = await harness.service.create({
        name: '알고리즘',
        professorName: '김교수',
      });
      const operatingSystems = await harness.service.create({
        name: '운영체제',
        professorName: '',
      });
      await harness.service.archive(operatingSystems.id);

      const courseRoot = join(harness.connection.managedRoot, '과목', '알고리즘');
      const courseNotePath = join(courseRoot, '알고리즘.md');
      const courseNote = await readFile(courseNotePath, 'utf8');
      expect(courseNote).toContain(`studyapp-course-id: "${algorithms.id}"`);
      expect(courseNote).toContain('## 교수 출제 성향');
      expect(courseNote).toContain('## 시험 산출물');
      await expect(stat(join(courseRoot, '녹음'))).resolves.toMatchObject({});
      await expect(stat(join(courseRoot, '자료', '음성'))).resolves.toMatchObject({});
      await expect(stat(join(courseRoot, '자료', '문서'))).resolves.toMatchObject({});
      await expect(stat(join(courseRoot, '시험', 'PDF'))).resolves.toMatchObject({});

      const mainNote = await readFile(
        join(harness.connection.managedRoot, '메인 학습 노트.md'),
        'utf8',
      );
      expect(mainNote).toContain('[[과목/알고리즘/알고리즘|알고리즘]]');
      expect(mainNote).not.toContain('[[과목/운영체제/운영체제|운영체제]]');

      const catalog = JSON.parse(await readFile(harness.catalogPath, 'utf8')) as Record<
        string,
        unknown
      >;
      expect(catalog).toEqual({
        protocolVersion: 1,
        generatedAt: NOW,
        courses: [{ id: algorithms.id, name: '알고리즘' }],
      });
      expect(JSON.stringify(catalog)).not.toContain('김교수');
      expect(JSON.stringify(catalog)).not.toContain(harness.vaultRoot);
      expect(JSON.stringify(catalog)).not.toContain(harness.queueRoot);
    });
  });

  it('updates app-owned blocks while preserving user notes and the stable course path', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const original = await harness.service.create({
        name: '알고리즘',
        professorName: '김교수',
      });
      const courseNotePath = join(
        harness.connection.managedRoot,
        '과목',
        original.folderName,
        `${original.folderName}.md`,
      );
      const mainNotePath = join(harness.connection.managedRoot, '메인 학습 노트.md');
      const courseNote = await readFile(courseNotePath, 'utf8');
      const userTendency = '- 계산형 문제를 반복해서 사용함 (사용자 확인)';
      await writeFile(
        courseNotePath,
        courseNote
          .replace('---\n', '---\naliases: ["사용자 별칭"]\n')
          .replace('> 강의와 평가 자료에서 확인된 출제 신호가 여기에 누적됩니다.', userTendency)
          .replaceAll('\n', '\r\n'),
        'utf8',
      );
      await writeFile(
        mainNotePath,
        `${await readFile(mainNotePath, 'utf8')}\n사용자가 메인 노트에 남긴 메모\n`,
        'utf8',
      );

      harness.setNow(LATER);
      const updated = await harness.service.update(original.id, {
        name: '고급 알고리즘',
        professorName: '박교수',
        userInstructions: '계산 과정과 반례를 우선 정리',
      });

      expect(updated).toMatchObject({
        name: '고급 알고리즘',
        professorName: '박교수',
        folderName: '알고리즘',
        userInstructions: '계산 과정과 반례를 우선 정리',
        revision: 1,
      });
      const updatedCourseNote = await readFile(courseNotePath, 'utf8');
      expect(updatedCourseNote).toContain(userTendency);
      expect(updatedCourseNote).toContain('고급 알고리즘');
      expect(updatedCourseNote).toContain('박교수');
      expect(updatedCourseNote).toContain('계산 과정과 반례를 우선 정리');
      expect(updatedCourseNote).toContain('aliases: ["사용자 별칭"]');
      expect(updatedCourseNote).toContain('studyapp-course-name: "고급 알고리즘"');
      expect(updatedCourseNote).toContain('studyapp-course-revision: 1');

      const updatedMainNote = await readFile(mainNotePath, 'utf8');
      expect(updatedMainNote).toContain('사용자가 메인 노트에 남긴 메모');
      expect(updatedMainNote).toContain('[[과목/알고리즘/알고리즘|고급 알고리즘]]');
      expect(updatedMainNote).not.toContain('|알고리즘]]');
      expect(JSON.parse(await readFile(harness.catalogPath, 'utf8'))).toEqual({
        protocolVersion: 1,
        generatedAt: LATER,
        courses: [{ id: original.id, name: '고급 알고리즘' }],
      });
    });
  });

  it('does not overwrite a user-modified note when a concurrent edit wins', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const course = await harness.service.create({ name: '자료구조', professorName: '' });
      const notePath = join(
        harness.connection.managedRoot,
        '과목',
        course.folderName,
        `${course.folderName}.md`,
      );
      const before = await readFile(notePath, 'utf8');
      const racingWriter = new VaultWriter(harness.connection, {
        beforeMutation: async (mutation) => {
          if (mutation.kind === 'rename-target-to-backup' && mutation.targetPath === notePath) {
            await writeFile(notePath, `${before}\n동시 사용자 수정\n`, 'utf8');
          }
        },
      });
      const racingService = new CourseService({
        repository: harness.repositories.courses,
        vault: racingWriter,
        catalog: new JsonCourseCatalog(harness.repositories.settings),
        clock: () => LATER,
        idGenerator: () => '33333333-3333-4333-8333-333333333333',
      });

      await expect(
        racingService.update(course.id, { userInstructions: '변경된 앱 지침' }),
      ).rejects.toThrow('VAULT_WRITE_FAILED');
      expect(await readFile(notePath, 'utf8')).toContain('동시 사용자 수정');
      expect(await readFile(notePath, 'utf8')).not.toContain('변경된 앱 지침');
      expect(harness.repositories.courses.get(course.id)).toMatchObject({
        userInstructions: '',
        revision: 2,
      });
      expect(
        (await stat(join(harness.connection.managedRoot, '과목', course.folderName))).isDirectory(),
      ).toBe(true);
    });
  });

  it('rebuilds missing managed notes and keeps archive idempotent', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const course = await harness.service.create({ name: '자료구조', professorName: '' });
      const courseNotePath = join(
        harness.connection.managedRoot,
        '과목',
        course.folderName,
        `${course.folderName}.md`,
      );
      const mainNotePath = join(harness.connection.managedRoot, '메인 학습 노트.md');
      await unlink(courseNotePath);
      await unlink(mainNotePath);

      await harness.service.synchronize();
      expect(await readFile(courseNotePath, 'utf8')).toContain(course.id);
      expect(await readFile(mainNotePath, 'utf8')).toContain('|자료구조]]');

      const archived = await harness.service.archive(course.id);
      const archivedAgain = await harness.service.archive(course.id);
      expect(archivedAgain).toEqual(archived);
      expect(archivedAgain.revision).toBe(1);
      expect(await readFile(courseNotePath, 'utf8')).toContain('- 상태: 보관됨');
    });
  });

  it('restores an archived course without losing its notes or identity', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const created = await harness.service.create({ name: '자료구조', professorName: '김교수' });
      await harness.service.archive(created.id);

      const restored = await harness.service.restore(created.id);
      const restoredAgain = await harness.service.restore(created.id);

      expect(restored).toMatchObject({ id: created.id, archived: false, revision: 2 });
      expect(restoredAgain).toEqual(restored);
      expect(harness.repositories.courses.list({ includeArchived: true })).toHaveLength(1);
      await expect(
        readFile(
          join(
            harness.connection.managedRoot,
            '과목',
            restored.folderName,
            `${restored.folderName}.md`,
          ),
          'utf8',
        ),
      ).resolves.toContain('- 상태: 사용 중');
      await expect(
        readFile(join(harness.connection.managedRoot, '메인 학습 노트.md'), 'utf8'),
      ).resolves.toContain('|자료구조]]');
    });
  });

  it('treats creating the same archived course as a restore', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const created = await harness.service.create({ name: '자료구조', professorName: '김교수' });
      const personalized = await harness.service.update(created.id, {
        userInstructions: '계산형 문제를 우선 정리',
      });
      await harness.service.archive(personalized.id);

      const restored = await harness.service.create({ name: '자료구조', professorName: '이교수' });

      expect(restored).toMatchObject({
        id: created.id,
        archived: false,
        professorName: '이교수',
        userInstructions: '계산형 문제를 우선 정리',
      });
      expect(harness.repositories.courses.list({ includeArchived: true })).toHaveLength(1);
    });
  });

  it('rejects duplicates and missing courses while safely linking Obsidian syntax', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const course = await harness.service.create({ name: 'C# [심화]', professorName: '' });

      await expect(
        harness.service.create({ name: 'c# [심화]', professorName: '' }),
      ).rejects.toThrow('DUPLICATE_COURSE');
      await expect(harness.service.update('invalid-id', { name: '변경' })).rejects.toThrow(
        'COURSE_NOT_FOUND',
      );
      await expect(harness.service.archive('99999999-9999-4999-8999-999999999999')).rejects.toThrow(
        'COURSE_NOT_FOUND',
      );

      const mainNote = await readFile(
        join(harness.connection.managedRoot, '메인 학습 노트.md'),
        'utf8',
      );
      expect(mainNote).toContain('[C\\# \\[심화\\]](%EA%B3%BC%EB%AA%A9/C%23%20%5B');
      expect(course.folderName).toBe('C# [심화]');
    });
  });

  it('rolls back a new database row instead of replacing a pre-existing user note', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const notePath = join(harness.connection.managedRoot, '과목', '네트워크', '네트워크.md');
      await mkdir(join(harness.connection.managedRoot, '과목', '네트워크'), { recursive: true });
      await writeFile(notePath, '사용자가 먼저 만든 노트', 'utf8');

      await expect(harness.service.create({ name: '네트워크', professorName: '' })).rejects.toThrow(
        'DUPLICATE_COURSE',
      );
      expect(harness.repositories.courses.list({ includeArchived: true })).toEqual([]);
      expect(await readFile(notePath, 'utf8')).toBe('사용자가 먼저 만든 노트');
    });
  });

  it('records a derived-index sync issue without failing a valid local course mutation', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const missingQueue = join(root, 'temporarily unavailable queue');
      const settings = harness.repositories.settings.get();
      if (settings === null) {
        throw new TypeError('TEST_SETTINGS_MISSING');
      }
      harness.repositories.settings.update(
        AppSettingsSchema.parse({
          ...settings,
          icloudQueuePath: missingQueue,
          updatedAt: LATER,
          revision: settings.revision + 1,
        }),
        settings.revision,
      );

      const course = await harness.service.create({ name: '컴퓨터 구조', professorName: '' });
      expect(harness.repositories.courses.get(course.id)).toEqual(course);
      expect(harness.service.listSynchronizationIssues()).toEqual([
        {
          scope: 'indexes',
          courseId: course.id,
          error: {
            code: 'QUEUE_CONNECTION_FAILED',
            message: 'iCloud 대기열 연결을 확인해 주세요.',
            retryable: false,
          },
        },
      ]);

      await mkdir(missingQueue);
      await harness.service.synchronize();
      expect(harness.service.listSynchronizationIssues()).toEqual([]);
      expect(
        JSON.parse(await readFile(join(missingQueue, 'Catalog', 'courses.json'), 'utf8')),
      ).toMatchObject({ courses: [{ id: course.id, name: '컴퓨터 구조' }] });
    });
  });

  it('serializes concurrent mutations so one duplicate wins without conflict artifacts', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const results = await Promise.allSettled([
        harness.service.create({ name: '데이터베이스', professorName: '' }),
        harness.service.create({ name: '데이터베이스', professorName: '이교수' }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const courses = harness.repositories.courses.list({ includeArchived: true });
      expect(courses).toHaveLength(1);
      const files = await readdir(join(harness.connection.managedRoot, '과목', '데이터베이스'));
      expect(files.filter((name) => name.includes('.conflict-'))).toEqual([]);
    });
  });

  it('does not clear an unresolved course-note issue after another index sync succeeds', async () => {
    await withTempDirectory(async (root) => {
      const harness = await createHarness(root);
      const broken = await harness.service.create({ name: '컴파일러', professorName: '' });
      const healthy = await harness.service.create({ name: '인공지능', professorName: '' });
      const brokenNotePath = join(
        harness.connection.managedRoot,
        '과목',
        broken.folderName,
        `${broken.folderName}.md`,
      );
      await writeFile(
        brokenNotePath,
        (await readFile(brokenNotePath, 'utf8')).replace(
          '<!-- studyapp:course-info:end -->',
          '<!-- 사용자가 관리 마커를 제거함 -->',
        ),
        'utf8',
      );

      await expect(harness.service.synchronize()).rejects.toThrow('VAULT_WRITE_FAILED');
      const recorded = harness.service.listSynchronizationIssues();
      expect(recorded).toEqual([
        {
          scope: 'course-note',
          courseId: broken.id,
          error: {
            code: 'VAULT_WRITE_FAILED',
            message: 'Obsidian Vault에 안전하게 저장하지 못했습니다.',
            retryable: true,
          },
        },
      ]);

      await harness.service.update(healthy.id, { professorName: '최교수' });
      expect(harness.service.listSynchronizationIssues()).toEqual(recorded);

      await writeFile(
        brokenNotePath,
        (await readFile(brokenNotePath, 'utf8')).replace(
          '<!-- 사용자가 관리 마커를 제거함 -->',
          '<!-- studyapp:course-info:end -->',
        ),
        'utf8',
      );
      await harness.service.update(broken.id, { professorName: '복구된 교수' });
      expect(harness.service.listSynchronizationIssues()).toEqual([]);
    });
  });
});

describe('JsonCourseCatalog', () => {
  it('is disabled without settings and reports an unavailable configured queue', async () => {
    await withTempDirectory(async (root) => {
      const database = openDatabase(join(root, 'catalog.sqlite3'));
      openedDatabases.push(database);
      const repositories = createRepositories(database);
      const catalog = new JsonCourseCatalog(repositories.settings, { clock: () => NOW });

      await expect(catalog.publish([])).resolves.toBeUndefined();

      repositories.settings.insert(
        AppSettingsSchema.parse({
          schemaVersion: 1,
          vaultPath: null,
          icloudQueuePath: join(root, 'missing queue'),
          defaultSummaryMode: 'standard',
          autoStart: false,
          processingPaused: false,
          legalNoticeAcceptedAt: null,
          updatedAt: NOW,
          revision: 0,
        }),
      );
      await expect(catalog.publish([])).rejects.toThrow('QUEUE_CONNECTION_FAILED');
    });
  });
});
