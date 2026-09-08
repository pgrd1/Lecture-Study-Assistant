import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, type Page, test } from '@playwright/test';
import { createFoundationFixture } from '../testkit/e2eFixture';
import { launchStudyApp } from '../testkit/launchStudyApp';

const processingSnapshot = (userDataPath: string) => {
  const database = new DatabaseSync(join(userDataPath, 'study.sqlite3'), { readOnly: true });
  try {
    return {
      jobs: database
        .prepare('SELECT id, status, retry_count, revision FROM jobs ORDER BY id')
        .all(),
      invocations: database
        .prepare('SELECT id, feature, status, revision FROM provider_invocations ORDER BY id')
        .all(),
    };
  } finally {
    database.close();
  }
};

// These normal renderer events are emitted only after intake and inbox polls finish.
// Two observed cycles prevent persisted startup UI from masquerading as settled intake.
const observeSettledIntake = async (page: Page) => {
  const counts = await page.evaluate(
    () =>
      new Promise<{ queued: number; processing: number }>((resolve, reject) => {
        let cycles = 0;
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error('No settled intake events'));
        }, 15_000);
        const unsubscribe = window.studyApp.subscribeToState((state) => {
          if (++cycles === 2) {
            clearTimeout(timer);
            unsubscribe();
            resolve(state.counts);
          }
        });
      }),
  );
  expect(counts.queued).toBe(0);
  expect(counts.processing).toBe(0);
};

const workspaceFiles = async (vaultRoot: string) => {
  const root = join(vaultRoot, 'AI 학습');
  return (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
};
const expectWorkspaceVisible = async (vaultRoot: string) => {
  const fixed = [
    '학습 대시보드.md',
    '학습 대시보드.base',
    '과목/자료구조/과목 색인.base',
    '과목/자료구조/자료구조--workspace.md',
    '과목/자료구조/교수 강조·출제 프로필.md',
    '과목/자료구조/핵심정리.md',
    '과목/자료구조/암기/암기 체크리스트.md',
    '과목/자료구조/질문함/AI 질문함.md',
    '과목/자료구조/문제은행/원문 문제.md',
    '과목/자료구조/문제은행/AI 예상문제.md',
    '과목/자료구조/문제은행/AI 변형문제.md',
    '과목/자료구조/마인드맵/과목 전체.canvas',
    '과목/자료구조/마인드맵/과목 전체.svg',
  ];
  await expect
    .poll(async () => {
      const files = await workspaceFiles(vaultRoot);
      return (
        fixed.every((path) => files.includes(path)) &&
        files.some((path) => /^과목\/자료구조\/강의노트\/.+\.md$/u.test(path)) &&
        files.some((path) => /^과목\/자료구조\/개념\/.+\.md$/u.test(path)) &&
        files.some((path) => /^과목\/자료구조\/원본자료\/녹음\/[a-f0-9]{64}\.m4a$/u.test(path))
      );
    })
    .toBe(true);
  const files = await workspaceFiles(vaultRoot);
  for (const path of files) {
    await mkdir(dirname(join(vaultRoot, path)), { recursive: true });
    await writeFile(join(vaultRoot, path), 'USER-OWNED DECOY');
  }
  const vaultFiles = (await readdir(vaultRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(vaultRoot, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  const assertTarget = async (target: string) => {
    expect(target).toMatch(/^AI 학습\//u);
    expect(vaultFiles).toContain(target);
    expect(await readFile(join(vaultRoot, target), 'utf8')).not.toBe('USER-OWNED DECOY');
  };
  for (const path of files.filter((file) => file.endsWith('.md'))) {
    const content = await readFile(join(vaultRoot, 'AI 학습', path), 'utf8');
    if (!content.includes('study-assistant:generated:start')) continue;
    const generated = content.replace(
      /<!-- study-assistant:user:start -->[\s\S]*?<!-- study-assistant:user:end -->/gu,
      '',
    );
    for (const link of generated.matchAll(/!?\[\[([^\]\n|#]+)(?:[^\]\n]*)\]\]/gu))
      await assertTarget(link[1] ?? '');
  }
  for (const path of files.filter((file) => file.endsWith('.base'))) {
    const content = await readFile(join(vaultRoot, 'AI 학습', path), 'utf8');
    expect(content).toContain('file.inFolder("AI 학습/과목');
    expect(content).not.toContain('file.inFolder("과목');
  }
  const canvas = JSON.parse(
    await readFile(join(vaultRoot, 'AI 학습/과목/자료구조/마인드맵/과목 전체.canvas'), 'utf8'),
  ) as {
    nodes: { id: string; type: string; file?: string }[];
    edges: { fromNode: string; toNode: string }[];
  };
  expect(canvas.nodes.length).toBeGreaterThan(1);
  for (const node of canvas.nodes)
    if (node.type === 'file') {
      expect(node.file).toBeDefined();
      await assertTarget(node.file ?? '');
    }
  for (const edge of canvas.edges) {
    expect(canvas.nodes.map((node) => node.id)).toContain(edge.fromNode);
    expect(canvas.nodes.map((node) => node.id)).toContain(edge.toNode);
  }
  expect(files.some((path) => /workspace-manifest|pipeline-artifacts|\.sqlite/u.test(path))).toBe(
    false,
  );
  return files;
};

test('processes an offline-created iCloud job after startup exactly once', async () => {
  const fixture = await createFoundationFixture({ pcWasOffline: true });
  let runningApp: Awaited<ReturnType<typeof launchStudyApp>> | undefined;

  try {
    runningApp = await launchStudyApp(fixture);
    const window = await runningApp.firstWindow();
    const completedMetric = window.locator('.metric-grid > div').filter({ hasText: '완료' });

    const before = await expectWorkspaceVisible(fixture.vaultRoot);
    await expect(completedMetric.locator('dd')).toHaveText('1');
    await expect.poll(() => fixture.recordingNotes()).toHaveLength(1);
    const inboxPath = join(fixture.vaultRoot, 'AI 학습/과목/자료구조/질문함/AI 질문함.md');
    const inboxBefore = await readFile(inboxPath, 'utf8');
    await writeFile(
      inboxPath,
      inboxBefore.replace(
        '사용자 메모를 이 영역에 작성하세요.',
        '- [ ] `q_018f47f2d4d77f83b513f00a12345678` 질문: What does an array store?',
      ),
    );
    await expect
      .poll(async () => {
        const content = await readFile(inboxPath, 'utf8');
        return content.includes('"question_count": 1') && content.includes('상태: completed');
      })
      .toBe(true);
    const inboxAnswered = await readFile(inboxPath, 'utf8');
    await observeSettledIntake(window);
    const durableBefore = processingSnapshot(fixture.userDataPath);
    expect(durableBefore.jobs).toHaveLength(1);
    expect(durableBefore.invocations.length).toBeGreaterThan(0);
    await runningApp.close();
    runningApp = undefined;

    runningApp = await launchStudyApp(fixture);
    const restartedWindow = await runningApp.firstWindow();
    const restartedCompletedMetric = restartedWindow
      .locator('.metric-grid > div')
      .filter({ hasText: '완료' });
    expect(await expectWorkspaceVisible(fixture.vaultRoot)).toEqual(before);
    await expect(restartedCompletedMetric.locator('dd')).toHaveText('1');
    await expect.poll(() => fixture.recordingNotes()).toHaveLength(1);
    await observeSettledIntake(restartedWindow);
    expect(processingSnapshot(fixture.userDataPath)).toEqual(durableBefore);
    expect(await readFile(inboxPath, 'utf8')).toBe(inboxAnswered);
  } catch (error) {
    const window = runningApp?.windows()[0];
    if (window) {
      await test.info().attach('visible-workspace-failure', {
        body: `${await window.locator('body').innerText()}\n\n${(await workspaceFiles(fixture.vaultRoot)).join('\n')}`,
        contentType: 'text/plain',
      });
    }
    throw error;
  } finally {
    await runningApp?.close();
    await fixture.dispose();
  }
});
