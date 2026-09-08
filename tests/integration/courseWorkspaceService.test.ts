import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CourseService } from '../../src/application/courses/courseService';
import { attachmentPath } from '../../src/application/obsidian/attachmentProjector';
import { splitManagedNoteParts } from '../../src/application/obsidian/courseWorkspaceProjector';
import { CourseWorkspaceService } from '../../src/application/obsidian/courseWorkspaceService';
import { renderMarkdownDocument } from '../../src/application/obsidian/markdownRenderer';
import { QuestionInboxService } from '../../src/application/obsidian/questionInboxService';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import { JsonCourseCatalog } from '../../src/infrastructure/queue/jsonCourseCatalog';
import { VaultService } from '../../src/infrastructure/vault/vaultService';
import { VaultWriter } from '../../src/infrastructure/vault/vaultWriter';
import { VerifiedStudyContentSchema } from '../../src/shared/contracts/studyContent';
import { deferred } from '../testkit/deferred';
import { courseFixture, jobFixture } from '../testkit/fixtures';
import { withTempDirectory } from '../testkit/tempDirectory';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const NOW = '2026-09-07T00:00:00.000Z';
const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('Missing test fixture');
  return value;
};
const course = courseFixture({ userInstructions: 'PRIVATE_SYSTEM_PROMPT_SECRET' });
const makeInput = async (root: string, n = 1, merge = false, image = false) => {
  const bytes = Buffer.from(`immutable source ${n}`);
  const stagedPath = join(root, `source-${n}.${image ? 'png' : n === 1 ? 'txt' : 'm4a'}`);
  await writeFile(stagedPath, bytes);
  const source = {
    id: id(100 + n),
    bundleId: id(200 + n),
    ordinal: 0,
    originalFileName: `source.${image ? 'png' : n === 1 ? 'txt' : 'm4a'}`,
    mediaType: image ? ('image' as const) : n === 1 ? ('document' as const) : ('audio' as const),
    stagedPath,
    sha256: hash(bytes),
    sizeBytes: bytes.length,
  };
  const evidenceId = id(300 + n);
  const claim = (offset: number, text: string) => ({
    id: id(n * 1000 + offset),
    text,
    evidenceIds: [evidenceId],
    status: 'source_supported' as const,
    uncertainty: null,
  });
  const cluster = {
    id: id(400 + n),
    title: n === 1 ? '강의계획' : `강의 ${n}`,
    action: merge ? ('merge' as const) : ('create' as const),
    existingTopicId: merge ? id(401) : null,
    evidenceIds: [evidenceId],
    uncertainty: '일정 확인 필요',
    sessionDates: [`2026-09-${String(6 + n).padStart(2, '0')}`],
  };
  const topic = {
    cluster,
    title: cluster.title,
    action: cluster.action,
    existingTopicId: cluster.existingTopicId,
    sessionDates: [...cluster.sessionDates],
    contentMode: merge ? 'merge_delta' : 'new_topic',
    outline: [claim(1, `목표 ${n}`)],
    explanations: [claim(2, `설명 ${n}`)],
    definitions: [claim(3, `정의 ${n}`)],
    formulas: [
      {
        ...claim(4, `공식 ${n}`),
        symbols: [{ symbol: 'n', meaning: '개수', unit: '개' }],
        assumptions: ['비교 비용 일정'],
        conditions: ['n >= 2'],
      },
    ],
    examples: [claim(5, `예시 ${n}`)],
    exceptions: [claim(6, `예외 ${n}`)],
    misconceptions: [claim(7, `오개념 ${n}`)],
    professorSignals: [
      {
        ...claim(8, `시험 강조 ${n}`),
        observationKind: 'explicit_emphasis',
        inference: 'observable_course_evidence',
      },
    ],
    conflicts: [
      {
        ...claim(9, `충돌 ${n}`),
        alternatives: [
          {
            claimId: id(n * 1000 + 1),
            sessionDate: cluster.sessionDates[0],
            evidenceIds: [evidenceId],
          },
          {
            claimId: id(n * 1000 + 2),
            sessionDate: cluster.sessionDates[0],
            evidenceIds: [evidenceId],
          },
        ],
      },
    ],
    citations: [
      {
        evidenceId,
        sourceId: source.id,
        locator: image
          ? { kind: 'image', x: 0, y: 0, width: 1, height: 1 }
          : n === 1
            ? { kind: 'text', startLine: 1, endLine: 1 }
            : { kind: 'audio', startMs: 0, endMs: 1000 },
      },
    ],
    sessions: [{ date: cluster.sessionDates[0], evidenceIds: [evidenceId] }],
  };
  return {
    course,
    job: jobFixture({
      id: id(n),
      sourceBundleId: source.bundleId,
      sourceFileName: source.originalFileName,
      sourceMediaType: source.mediaType,
      stagedSourcePath: stagedPath,
      sourceSha256: source.sha256,
      summaryMode: n === 1 ? 'core' : 'none',
    }),
    bundle: {
      id: source.bundleId,
      jobId: id(n),
      manifestSha256: hash('manifest'),
      sourceCount: 1,
      totalBytes: bytes.length,
      stagingDirectoryPath: root,
      createdAt: NOW,
    },
    sources: [source],
    content: VerifiedStudyContentSchema.parse({
      contentSchemaVersion: 2,
      topics:
        n === 3
          ? [
              topic,
              {
                ...topic,
                cluster: { ...cluster, id: id(499), title: '추가 주제' },
                title: '추가 주제',
                outline: [claim(10, '두 번째 주제 설명')],
                explanations: [],
                definitions: [],
                formulas: [],
                examples: [],
                exceptions: [],
                misconceptions: [],
                professorSignals: [],
                conflicts: [],
              },
            ]
          : [topic],
      verification: {
        verificationSchemaVersion: 1,
        decisions: Array.from({ length: n === 3 ? 10 : 9 }, (_, i) => ({
          itemId: id(n * 1000 + i + 1),
          decision: 'accept',
          reason: 'supported',
          missingEvidenceIds: [],
        })),
      },
    }),
    provenance: [{ invocationId: id(500 + n), modelId: 'offline-model', promptVersion: 'v1' }],
  };
};
const setup = async (root: string) => {
  const connection = await new VaultService().connect({
    path: join(root, 'vault'),
    mode: 'create',
  });
  const artifactRoot = join(root, 'private');
  await mkdir(artifactRoot);
  const database = openDatabase(join(root, 'db.sqlite'));
  const repositories = createRepositories(database);
  repositories.courses.insert(course);
  const writer = new VaultWriter(connection);
  const service = new CourseWorkspaceService({ repositories, writer, connection, artifactRoot });
  return { connection, artifactRoot, database, repositories, writer, service };
};
const vaultFiles = async (root: string) =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

describe('course workspace publication', () => {
  it('serializes answer acceptance with a course snapshot while other workspaces publish independently', async () => {
    await withTempDirectory(async (root) => {
      const h = await setup(root);
      const otherRoot = join(root, 'independent');
      await mkdir(otherRoot);
      const other = await setup(otherRoot);
      const reached = deferred();
      const release = deferred();
      const order: string[] = [];
      try {
        await h.service.publish(await makeInput(root));
        const target = required((await h.service.questionInboxTargets())[0]);
        const questionId = 'q_018f47f2d4d77f83b513f00a12345678';
        const note = required(await h.writer.readMarkdown(target.relativePath));
        await h.writer.writeMarkdown({
          relativePath: target.relativePath,
          content: note.content.replace(
            '사용자 메모를 이 영역에 작성하세요.',
            `- [ ] \`${questionId}\` 질문: why?`,
          ),
          expectedBaseHash: note.sha256,
        });
        let calls = 0;
        const dependencies = {
          workspaceRoot: h.connection.realManagedRoot,
          writer: h.writer,
          revisions: h.repositories.managedNotes,
          targets: () => h.service.questionInboxTargets(),
          evidence: (value: { courseId: string }) => h.service.questionEvidence(value.courseId),
          answer: async () => {
            calls++;
            order.push('answer');
            return {
              output: {
                answer: '조건을 확인합니다.',
                steps: [],
                example: '',
                uncertainty: '',
                evidenceIds: [id(301)],
              },
              provenance: {
                requestId: id(901),
                modelId: 'offline-model',
                promptVersion: 'v1',
                promptSha256: 'b'.repeat(64),
                completedAt: NOW,
              },
            };
          },
        };
        const inbox = new QuestionInboxService(dependencies);
        await inbox.pollOnce();
        const realCopy = h.writer.copyAttachment.bind(h.writer);
        vi.spyOn(h.writer, 'copyAttachment').mockImplementationOnce(async (input) => {
          order.push('snapshot');
          reached.resolve();
          await release.promise;
          order.push('resume');
          return realCopy(input);
        });
        const publishing = h.service.publish(await makeInput(root, 2));
        await reached.promise;
        const answering = inbox.pollOnce();
        // A different Vault must finish while this publication is paused.
        await other.service.publish(await makeInput(otherRoot));
        expect(await other.service.questionInboxTargets()).toHaveLength(1);
        // Give an unguarded poll the chance to expose its completed answer before
        // resuming the stale snapshot. A guarded poll remains queued instead.
        await Promise.race([answering, new Promise((resolve) => setTimeout(resolve, 100))]);
        release.resolve();
        await Promise.all([publishing, answering]);
        await inbox.pollOnce();
        await inbox.pollOnce();
        const completed = required(await h.writer.readMarkdown(target.relativePath)).content;
        expect(order).toEqual(['snapshot', 'resume', 'answer']);
        expect(completed).toContain(`section="answer_${questionId}"`);
        expect(completed).toContain('상태: completed');
        const restarted = new QuestionInboxService(dependencies);
        await restarted.pollOnce();
        await restarted.pollOnce();
        expect(calls).toBe(1);
        expect(required(await h.writer.readMarkdown(target.relativePath)).content).toBe(completed);
      } finally {
        release.resolve();
        h.database.close();
        other.database.close();
      }
    });
  });
  it('preserves exact answer blocks through another course publication and a second lecture', async () => {
    await withTempDirectory(async (root) => {
      const h = await setup(root);
      try {
        await h.service.publish(await makeInput(root));
        const target = required((await h.service.questionInboxTargets())[0]);
        const questionId = 'q_018f47f2d4d77f83b513f00a12345678';
        const note = required(await h.writer.readMarkdown(target.relativePath));
        await h.writer.writeMarkdown({
          relativePath: target.relativePath,
          content: note.content.replace(
            '사용자 메모를 이 영역에 작성하세요.',
            `메모 그대로\r\n- [ ] \`${questionId}\` 질문: why?`,
          ),
          expectedBaseHash: note.sha256,
        });
        let calls = 0;
        const dependencies = {
          workspaceRoot: h.connection.realManagedRoot,
          writer: h.writer,
          revisions: h.repositories.managedNotes,
          targets: () => h.service.questionInboxTargets(),
          evidence: (value: { courseId: string }) => h.service.questionEvidence(value.courseId),
          answer: async () => {
            calls++;
            return {
              output: {
                answer: '조건을 확인합니다.',
                steps: [],
                example: '',
                uncertainty: '',
                evidenceIds: [id(301)],
              },
              provenance: {
                requestId: id(901),
                modelId: 'offline-model',
                promptVersion: 'v1',
                promptSha256: 'b'.repeat(64),
                completedAt: NOW,
              },
            };
          },
        };
        const inbox = new QuestionInboxService(dependencies);
        await inbox.pollOnce();
        await inbox.pollOnce();
        const answered = required(await h.writer.readMarkdown(target.relativePath)).content;
        const originalBlock = required(
          answered.match(
            /<!-- study-assistant:generated:start section="answer_[\s\S]*?<!-- study-assistant:generated:end -->/u,
          )?.[0],
        );
        const secondCourse = courseFixture({
          id: id(902),
          name: '알고리즘',
          folderName: '알고리즘',
        });
        h.repositories.courses.insert(secondCourse);
        const otherInput = await makeInput(root, 2);
        await h.service.publish({
          ...otherInput,
          course: secondCourse,
          job: { ...otherInput.job, courseId: secondCourse.id },
        });
        expect(required(await h.writer.readMarkdown(target.relativePath)).content).toBe(answered);
        await h.service.publish(await makeInput(root, 3));
        const updated = required(await h.writer.readMarkdown(target.relativePath)).content;
        expect(updated).toContain(originalBlock);
        expect(updated).toContain('메모 그대로\r\n');
        expect(updated).toContain(`section="j${id(3).replaceAll('-', '')}_0"`);
        const restarted = new QuestionInboxService(dependencies);
        await restarted.pollOnce();
        await restarted.pollOnce();
        expect(calls).toBe(1);
        expect(required(await h.writer.readMarkdown(target.relativePath)).content).toBe(updated);
      } finally {
        h.database.close();
      }
    });
  });
  it('offers only committed course evidence and configured inboxes, excluding current user edits', async () => {
    await withTempDirectory(async (root) => {
      const h = await setup(root);
      try {
        expect(await h.service.questionInboxTargets()).toEqual([]);
        const input = await makeInput(root);
        await h.service.publish(input);
        const targets = await h.service.questionInboxTargets();
        expect(targets).toHaveLength(1);
        expect(targets[0]).toMatchObject({
          courseId: course.id,
          userInstructions: course.userInstructions,
        });
        const evidence = await h.service.questionEvidence(course.id);
        expect(evidence.length).toBeGreaterThan(0);
        expect(evidence[0]).toMatchObject({
          evidenceId: id(301),
          relativePath: attachmentPath(course.folderName, input.sources[0]),
        });
        const state = JSON.parse(
          await readFile(join(h.artifactRoot, 'workspace-manifest.json'), 'utf8'),
        ).manifest.courses[0];
        const note = state.notes.find((n: { kind: string }) => n.kind === 'lecture');
        const current = required(await h.writer.readMarkdown(note.relativePath));
        await h.writer.writeMarkdown({
          relativePath: note.relativePath,
          content: current.content.replace(
            '사용자 메모를 이 영역에 작성하세요.',
            'PRIVATE_USER_EVIDENCE',
          ),
          expectedBaseHash: current.sha256,
        });
        expect(JSON.stringify(await h.service.questionEvidence(course.id))).not.toContain(
          'PRIVATE_USER_EVIDENCE',
        );
        expect(await h.service.questionEvidence(id(999))).toEqual([]);
        const accepted = required(h.repositories.managedNotes.get(note.stableId));
        const managedPath = attachmentPath(course.folderName, input.sources[0]);
        for (const prefix of ['', 'AI 학습/AI 학습/', 'other/AI 학습/', 'ai 학습/']) {
          const readAccepted = vi.spyOn(h.repositories.managedNotes, 'get').mockReturnValue({
            ...accepted,
            generatedBase: accepted.generatedBase.replaceAll(
              `[[AI 학습/${managedPath}|`,
              `[[${prefix}${managedPath}|`,
            ),
          });
          try {
            expect(await h.service.questionEvidence(course.id)).toEqual([]);
          } finally {
            readAccepted.mockRestore();
          }
        }
      } finally {
        h.database.close();
      }
    });
  });
  it.each([
    { extension: 'aac', n: 2 },
    { extension: 'pptx', n: 1 },
    { extension: 'heic', n: 4 },
  ])('publishes an immutable .$extension attachment', async ({ extension, n }) => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        const input = await makeInput(root, n, false, n === 4);
        const source = { ...required(input.sources[0]), originalFileName: `source.${extension}` };
        await live.service.publish({
          ...input,
          job: { ...input.job, sourceFileName: source.originalFileName },
          sources: [source],
        });
        const output = required(
          (await vaultFiles(live.connection.managedRoot)).find((path) =>
            path.endsWith(`.${extension}`),
          ),
        );
        expect(hash(await readFile(output))).toBe(source.sha256);
      } finally {
        live.database.close();
      }
    });
  });

  it('splits multibyte notes by complete rendered UTF-8 size including a preserved user region', () => {
    const generatedSections = Array.from({ length: 80 }, (_, index) => ({
      id: `section_${index}`,
      markdown: `claim ${index}\n${'강'.repeat(85_000)}`,
    }));
    const parts = splitManagedNoteParts(
      {
        stableId: 'topic_bytes',
        kind: 'lecture',
        relativePath: '과목/자료구조/강의노트/bytes.md',
        properties: { source_ids: [id(101)], locked: false },
        generatedSections,
        relatedSourceIds: [id(101)],
      },
      'bytes_revision',
      { topic_bytes: 1024 * 1024 },
    );
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((part) => part.generatedSections).map((section) => section.id)).toEqual(
      generatedSections.map((section) => section.id),
    );
    for (const part of parts) {
      const candidate = renderMarkdownDocument(part, 'bytes_revision');
      const rendered =
        part.stableId === 'topic_bytes'
          ? candidate.replace('\n사용자 메모를 이 영역에 작성하세요.\n', 'x'.repeat(1024 * 1024))
          : candidate;
      expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(part.generatedSections.length).toBeLessThanOrEqual(100);
    }
  });

  it('retains source and session Properties after a second merge', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        for (const n of [1, 2, 5]) await live.service.publish(await makeInput(root, n, n !== 1));
        const note = await readFile(
          join(
            live.connection.managedRoot,
            '과목/자료구조/강의노트/강의계획--topic_8000000000000401.md',
          ),
          'utf8',
        );
        const properties = required(note.split('\n---\n')[0]);
        for (const n of [101, 102, 105]) expect(properties).toContain(id(n));
        for (const date of ['2026-09-07', '2026-09-08', '2026-09-11'])
          expect(properties).toContain(date);
        for (const n of [1, 2, 5]) expect(properties).toContain(hash(`immutable source ${n}`));
      } finally {
        live.database.close();
      }
    });
  }, 15_000);

  it('bounds the rendered candidate too when the existing user region is empty', () => {
    const section = { id: 'last', markdown: '' };
    const document = {
      stableId: 'empty_user',
      kind: 'lecture' as const,
      relativePath: '과목/자료구조/강의노트/empty-user.md',
      properties: { stable_id: 'empty_user' },
      relatedSourceIds: [],
      generatedSections: [
        ...Array.from({ length: 69 }, (_, index) => ({
          id: `s_${index}`,
          markdown: '강'.repeat(80_000),
        })),
        section,
      ],
    };
    const remaining =
      16 * 1024 ** 2 - Buffer.byteLength(renderMarkdownDocument(document, 'revision')) + 1;
    const input = {
      ...document,
      generatedSections: [
        ...document.generatedSections.slice(0, -1),
        {
          ...section,
          markdown: `${'강'.repeat(Math.floor(remaining / 3))}${'a'.repeat(remaining % 3)}`,
        },
      ],
    };
    const parts = splitManagedNoteParts(input, 'revision', { empty_user: 0 });
    for (const part of parts)
      expect(Buffer.byteLength(renderMarkdownDocument(part, 'revision'))).toBeLessThanOrEqual(
        16 * 1024 ** 2,
      );
    expect(parts.flatMap((part) => part.generatedSections)).toEqual(input.generatedSections);
  });

  it('publishes a valid input whose rendered workspace and cumulative prior notes exceed 16 MiB', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        const input = await makeInput(root);
        const topic = required(input.content.topics[0]);
        const formula = required(topic.formulas[0]);
        const formulas = Array.from({ length: 24 }, (_, index) => ({
          ...formula,
          id: id(10000 + index),
          text: `large formula ${index}`,
          assumptions: Array.from(
            { length: 30 },
            (_, item) => `assumption ${item} ${'강'.repeat(1900)}`,
          ),
          conditions: Array.from(
            { length: 30 },
            (_, item) => `condition ${item} ${'의'.repeat(1900)}`,
          ),
        }));
        const content = VerifiedStudyContentSchema.parse(
          JSON.parse(
            JSON.stringify({
              ...input.content,
              topics: [{ ...topic, formulas }],
              verification: {
                ...input.content.verification,
                decisions: [
                  ...input.content.verification.decisions.filter(
                    (item) => item.itemId !== formula.id,
                  ),
                  ...formulas.map((item) => ({
                    itemId: item.id,
                    decision: 'accept',
                    reason: 'supported',
                    missingEvidenceIds: [],
                  })),
                ],
              },
            }),
          ),
        );
        expect(Buffer.byteLength(JSON.stringify({ ...input, content }))).toBeLessThan(
          16 * 1024 ** 2,
        );
        await live.service.publish({ ...input, content });
        const notes = (await vaultFiles(live.connection.managedRoot)).filter((path) =>
          path.endsWith('.md'),
        );
        const bytes = await Promise.all(notes.map((path) => readFile(path)));
        expect(bytes.reduce((sum, item) => sum + item.length, 0)).toBeGreaterThan(16 * 1024 ** 2);
        for (const item of bytes) expect(item.length).toBeLessThanOrEqual(16 * 1024 ** 2);
        await live.service.publish(await makeInput(root, 2, true));
        const all = await Promise.all(notes.map((path) => readFile(path, 'utf8')));
        for (const formula of formulas)
          expect(all.some((text) => text.includes(`Claim: ${formula.id}`))).toBe(true);
      } finally {
        live.database.close();
      }
    });
  }, 120_000);

  it('reconciles other-course user regions but preserves conflicts in generated regions', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        await live.service.publish(await makeInput(root));
        const other = courseFixture({ id: id(6000), name: '운영체제', folderName: '운영체제' });
        live.repositories.courses.insert(other);
        const path = join(
          live.connection.managedRoot,
          '과목/자료구조/강의노트/강의계획--topic_8000000000000401.md',
        );
        const hub = join(live.connection.managedRoot, '과목/자료구조/자료구조.md');
        const edited = (await readFile(path, 'utf8')).replace(
          '사용자 메모를 이 영역에 작성하세요.',
          '개인 메모 A',
        );
        const editedHub = (await readFile(hub, 'utf8')).replace(
          '사용자 메모를 이 영역에 작성하세요.',
          '과목 메모 A',
        );
        await writeFile(path, edited);
        await writeFile(hub, editedHub);
        const next = await makeInput(root, 2);
        await live.service.publish({
          ...next,
          course: other,
          job: { ...next.job, courseId: other.id },
        });
        expect(await readFile(path, 'utf8')).toBe(edited);
        expect(await readFile(hub, 'utf8')).toBe(editedHub);
        const manifest = await readFile(join(live.artifactRoot, 'workspace-manifest.json'), 'utf8');
        const conflict = edited.replace('목표 1', '사용자 수정 목표');
        await writeFile(path, conflict);
        const third = await makeInput(root, 3);
        await expect(
          live.service.publish({
            ...third,
            course: other,
            job: { ...third.job, courseId: other.id },
          }),
        ).rejects.toThrow();
        expect(await readFile(path, 'utf8')).toBe(conflict);
        expect(await readFile(join(live.artifactRoot, 'workspace-manifest.json'), 'utf8')).toBe(
          manifest,
        );
      } finally {
        live.database.close();
      }
    });
  }, 15_000);

  it('does not stream a committed historical attachment on unrelated course publication', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        const first = await makeInput(root);
        await live.service.publish(first);
        const historical = required(
          (await vaultFiles(live.connection.managedRoot)).find((path) => path.endsWith('.txt')),
        );
        const other = courseFixture({ id: id(6000), name: '운영체제', folderName: '운영체제' });
        live.repositories.courses.insert(other);
        const original = fs.createReadStream;
        const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((path, options) => {
          if (String(path) === historical) throw new Error('historical attachment was streamed');
          return original(path, options);
        });
        syncBuiltinESMExports();
        try {
          const next = await makeInput(root, 2);
          await live.service.publish({
            ...next,
            course: other,
            job: { ...next.job, courseId: other.id },
          });
          const changed = await makeInput(root, 3);
          await writeFile(required(changed.sources[0]).stagedPath, 'wrong bytes');
          await expect(
            live.service.publish({
              ...changed,
              course: other,
              job: { ...changed.job, courseId: other.id },
            }),
          ).rejects.toThrow();
        } finally {
          spy.mockRestore();
          syncBuiltinESMExports();
        }
      } finally {
        live.database.close();
      }
    });
  }, 15_000);
  it('publishes beside the real legacy CourseService note and persists the actual hub path across restart', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        await new CourseService({
          repository: live.repositories.courses,
          vault: live.writer,
          catalog: new JsonCourseCatalog(live.repositories.settings),
        }).synchronize();
        const canonical = join(live.connection.managedRoot, '과목/자료구조/자료구조.md');
        const legacy = `${await readFile(canonical, 'utf8')}\r\n사용자 기존 과목 메모  \r\n`;
        await writeFile(canonical, legacy);
        const input = await makeInput(root);
        await live.service.publish(input);
        expect(await readFile(canonical, 'utf8')).toBe(legacy);
        const actual = '과목/자료구조/자료구조--workspace.md';
        expect(await readFile(join(live.connection.managedRoot, actual), 'utf8')).toContain(
          '강의계획--topic_',
        );
        expect(
          await readFile(join(live.connection.managedRoot, '학습 대시보드.md'), 'utf8'),
        ).toContain(actual);
        expect(
          await readFile(join(live.artifactRoot, 'workspace-manifest.json'), 'utf8'),
        ).toContain(actual);
        live.database.close();
        const reopened = openDatabase(join(root, 'db.sqlite'));
        try {
          const service = new CourseWorkspaceService({
            repositories: createRepositories(reopened),
            writer: live.writer,
            connection: live.connection,
            artifactRoot: live.artifactRoot,
          });
          await service.publish(await makeInput(root, 2, true));
          expect(await readFile(canonical, 'utf8')).toBe(legacy);
          expect(
            await readFile(join(live.connection.managedRoot, '학습 대시보드.md'), 'utf8'),
          ).toContain(actual);
        } finally {
          reopened.close();
        }
      } finally {
        live.database.close();
      }
    });
  }, 15_000);
  it('publishes immutable media and evidence-linked cumulative notes, then reopens stable topic state', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        const first = await makeInput(root);
        const original = JSON.stringify(first);
        await live.service.publish(first);
        const topicPath = '과목/자료구조/강의노트/강의계획--topic_8000000000000401.md';
        const topicFile = join(live.connection.managedRoot, topicPath);
        const before = await readFile(topicFile, 'utf8');
        const userBytes = '\r\n개인 메모  \r\n**보존**\r\n';
        await writeFile(
          topicFile,
          before.replace('\n사용자 메모를 이 영역에 작성하세요.\n', userBytes),
        );
        for (const n of [2, 3, 4])
          await live.service.publish(await makeInput(root, n, n === 2, n === 4));
        const merged = await readFile(topicFile, 'utf8');
        expect(merged).toContain(userBytes);
        for (const text of [
          '목표 1',
          '목표 2',
          'explicit_emphasis',
          '충돌 1',
          '일정 확인 필요',
          '[!summary]',
          '[!important]',
          '[!warning]',
          '[!example]',
          id(301),
          'lines 1–1',
        ])
          expect(merged).toContain(text);
        expect(JSON.stringify(first)).toBe(original);
        const courseRoot = join(live.connection.managedRoot, '과목/자료구조');
        for (const directory of [
          '강의노트',
          '개념',
          '원본자료/녹음',
          '원본자료/이미지',
          '원본자료/문서',
          '문제은행',
          '마인드맵',
          '암기',
          '질문함',
          '시험',
        ])
          await expect(readdir(join(courseRoot, directory))).resolves.toBeDefined();
        const main = await readFile(join(courseRoot, '자료구조.md'), 'utf8');
        for (const target of [
          '원문 문제.md',
          'AI 예상문제.md',
          'AI 변형문제.md',
          '교수 강조·출제 프로필.md',
          '암기 체크리스트.md',
          'AI 질문함.md',
          '과목 전체.canvas',
          '과목 전체.svg',
          '핵심정리.md',
          topicPath,
        ])
          expect(main).toContain(target);
        const paths = await vaultFiles(live.connection.managedRoot);
        const imagePath = required(paths.find((path) => path.endsWith('.png')));
        expect(await readFile(imagePath)).toEqual(Buffer.from('immutable source 4'));
        expect(await readFile(join(courseRoot, '문제은행/원문 문제.md'), 'utf8')).toContain(
          '![[AI 학습/과목/자료구조/원본자료/이미지/',
        );
        const canvas = JSON.parse(
          await readFile(join(courseRoot, '마인드맵/과목 전체.canvas'), 'utf8'),
        ) as { nodes: { type: string; file: string }[] };
        expect(canvas.nodes.every((node) => node.type === 'file')).toBe(true);
        for (const node of canvas.nodes)
          await expect(readFile(join(live.connection.vaultRoot, node.file))).resolves.toBeDefined();
        expect(await readFile(join(courseRoot, '과목 색인.base'), 'utf8')).toContain(
          'file.inFolder("AI 학습/과목/자료구조/강의노트")',
        );
        expect(await readFile(join(courseRoot, '마인드맵/과목 전체.svg'), 'utf8')).toContain(
          '포함',
        );
        const manifestBefore = await readFile(
          join(live.artifactRoot, 'workspace-manifest.json'),
          'utf8',
        );
        await live.service.publish(await makeInput(root, 4, false, true));
        expect(await readFile(join(live.artifactRoot, 'workspace-manifest.json'), 'utf8')).toBe(
          manifestBefore,
        );
        live.database.close();
        const reopened = openDatabase(join(root, 'db.sqlite'));
        try {
          const service = new CourseWorkspaceService({
            repositories: createRepositories(reopened),
            writer: live.writer,
            connection: live.connection,
            artifactRoot: live.artifactRoot,
          });
          const topics = await service.existingTopics(course.id);
          expect(topics).toHaveLength(4);
          expect(topics.find((topic) => topic.id === id(401))?.provenance).toHaveLength(2);
        } finally {
          reopened.close();
        }
        const text =
          (
            await Promise.all(
              paths
                .filter((path) => /\.(md|base|canvas|svg)$/u.test(path))
                .map((path) => readFile(path, 'utf8')),
            )
          ).join('\n') + manifestBefore;
        expect(text).not.toMatch(
          /PRIVATE_SYSTEM_PROMPT_SECRET|[A-Z]:\\|file:\/\/|rawProviderResponse/u,
        );
      } finally {
        live.database.close();
      }
    });
  }, 15_000);

  it.each([
    'copyAttachment',
    'writeMarkdown',
    'writeCanvas',
    'writeBase',
    'dashboard',
    'manifest',
  ] as const)('never commits success after %s failure and converges on retry', async (fault) => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        const input = await makeInput(root);
        let undo: () => void;
        if (fault === 'manifest') {
          const original = live.writer.writeBase.bind(live.writer);
          const spy = vi.spyOn(live.writer, 'writeBase').mockImplementation(async (value) => {
            const result = await original(value);
            if (value.relativePath === '학습 대시보드.base')
              await mkdir(join(live.artifactRoot, 'workspace-manifest.json'));
            return result;
          });
          undo = () => spy.mockRestore();
        } else if (fault === 'dashboard') {
          const original = live.writer.writeMarkdown.bind(live.writer);
          const spy = vi.spyOn(live.writer, 'writeMarkdown').mockImplementation(async (value) => {
            if (value.relativePath === '학습 대시보드.md') throw new Error('forced dashboard');
            return original(value);
          });
          undo = () => spy.mockRestore();
        } else {
          const spy = vi
            .spyOn(live.writer, fault)
            .mockRejectedValueOnce(new Error('forced publication'));
          undo = () => spy.mockRestore();
        }
        await expect(live.service.publish(input)).rejects.toThrow();
        await expect(
          readFile(join(live.artifactRoot, 'workspace-manifest.json'), 'utf8'),
        ).rejects.toThrow();
        expect(await readFile(required(input.sources[0]).stagedPath)).toEqual(
          Buffer.from('immutable source 1'),
        );
        undo();
        if (fault === 'manifest') await rmdir(join(live.artifactRoot, 'workspace-manifest.json'));
        await expect(live.service.publish(input)).resolves.toBeDefined();
      } finally {
        live.database.close();
      }
    });
  });

  it.each(['locked', 'malformed', 'edited'] as const)(
    'preserves %s note bytes and refuses a success manifest for the merge',
    async (fault) => {
      await withTempDirectory(async (root) => {
        const live = await setup(root);
        try {
          await live.service.publish(await makeInput(root));
          const path = join(
            live.connection.managedRoot,
            '과목/자료구조/강의노트/강의계획--topic_8000000000000401.md',
          );
          const initial = await readFile(path, 'utf8');
          const edited =
            fault === 'locked'
              ? initial.replace('"locked": false', '"locked": true')
              : fault === 'malformed'
                ? initial.replace('generated:end', 'generated:broken')
                : initial.replace('목표 1', '내 목표');
          await writeFile(path, edited);
          const manifest = await readFile(
            join(live.artifactRoot, 'workspace-manifest.json'),
            'utf8',
          );
          await expect(live.service.publish(await makeInput(root, 2, true))).rejects.toThrow();
          expect(await readFile(path, 'utf8')).toBe(edited);
          expect(await readFile(join(live.artifactRoot, 'workspace-manifest.json'), 'utf8')).toBe(
            manifest,
          );
          expect(
            (await vaultFiles(live.connection.managedRoot)).some((file) =>
              file.includes('AI-충돌'),
            ),
          ).toBe(true);
        } finally {
          live.database.close();
        }
      });
    },
  );

  it('rejects hostile inputs before accessors and before copying any media', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        const input = await makeInput(root);
        let reads = 0;
        for (const bad of [
          Object.defineProperty({}, 'course', {
            enumerable: true,
            get: () => {
              reads++;
              return course;
            },
          }),
          Object.assign(Object.create({ inherited: true }) as object, input),
          { ...input, extra: true },
          {
            ...input,
            content: {
              ...input.content,
              topics: input.content.topics.map((topic) => ({
                ...topic,
                explanations: topic.explanations.map((claim) => ({
                  ...claim,
                  status: 'model_only',
                  evidenceIds: [],
                })),
              })),
            },
          },
          {
            ...input,
            provenance: [
              { invocationId: id(990), modelId: 'x'.repeat(20_000_000), promptVersion: 'v1' },
            ],
          },
          {
            ...input,
            content: {
              ...input.content,
              topics: input.content.topics.map((topic) => ({
                ...topic,
                explanations: topic.explanations.map((claim) => ({
                  ...claim,
                  text: course.userInstructions,
                })),
              })),
            },
          },
          {
            ...input,
            content: {
              ...input.content,
              topics: input.content.topics.map((topic) => ({
                ...topic,
                citations: topic.citations.map((citation) => ({
                  ...citation,
                  locator: { kind: 'audio', startMs: 0, endMs: 1000 },
                })),
              })),
            },
          },
          {
            ...input,
            content: {
              ...input.content,
              topics: input.content.topics.map((topic) => ({
                ...topic,
                citations: topic.citations.map((citation) => ({ ...citation, sourceId: id(999) })),
              })),
            },
          },
        ])
          await expect(live.service.publish(bad)).rejects.toThrow();
        expect(reads).toBe(0);
        expect(
          (await vaultFiles(live.connection.managedRoot)).filter(
            (p) => !p.endsWith('메인 학습 노트.md'),
          ),
        ).toEqual([]);
      } finally {
        live.database.close();
      }
    });
  });

  it('preserves user-region edits to an untouched earlier topic during later publication', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        await live.service.publish(await makeInput(root));
        const path = join(
          live.connection.managedRoot,
          '과목/자료구조/강의노트/강의계획--topic_8000000000000401.md',
        );
        const before = await readFile(path, 'utf8');
        const edited = before.replace(
          '사용자 메모를 이 영역에 작성하세요.',
          '다른 주제 처리 중에도 보존',
        );
        await writeFile(path, edited);
        await live.service.publish(await makeInput(root, 2));
        expect(await readFile(path, 'utf8')).toBe(edited);
      } finally {
        live.database.close();
      }
    });
  });

  it('packs a dashboard with over one hundred courses and keeps the initial none summary preference', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        for (let i = 0; i < 101; i++)
          live.repositories.courses.insert(
            courseFixture({ id: id(10000 + i), name: `course ${i}`, folderName: `course-${i}` }),
          );
        const input = await makeInput(root);
        await live.service.publish({ ...input, job: { ...input.job, summaryMode: 'none' } });
        const second = await makeInput(root, 2);
        await live.service.publish({ ...second, job: { ...second.job, summaryMode: 'full' } });
        const dashboard = await readFile(
          join(live.connection.managedRoot, '학습 대시보드.md'),
          'utf8',
        );
        expect(dashboard).toContain('과목/course-100/course-100.md');
        await expect(
          readFile(join(live.connection.managedRoot, '과목/자료구조/핵심정리.md')),
        ).rejects.toThrow();
        const path = join(live.artifactRoot, 'workspace-manifest.json');
        const manifest = await readFile(path, 'utf8');
        await writeFile(path, manifest.replace('"version":1', '"version":2'));
        await expect(live.service.existingTopics(course.id)).rejects.toThrow();
      } finally {
        live.database.close();
      }
    });
  });

  it('retains distinct immutable source IDs when identical source bytes share one attachment', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        const input = await makeInput(root);
        const source = required(input.sources[0]);
        const two = {
          ...input,
          job: { ...input.job, sourceCount: 2 },
          bundle: { ...input.bundle, sourceCount: 2, totalBytes: source.sizeBytes * 2 },
          sources: [source, { ...source, id: id(999), ordinal: 1 }],
        };
        await live.service.publish(two);
        await live.service.publish(two);
        expect(
          (await vaultFiles(live.connection.managedRoot)).filter((path) => path.endsWith('.txt')),
        ).toHaveLength(1);
        const manifest = await readFile(join(live.artifactRoot, 'workspace-manifest.json'), 'utf8');
        expect(manifest).toContain(source.id);
        expect(manifest).toContain(id(999));
      } finally {
        live.database.close();
      }
    });
  });

  it('reuses a verified attachment conflict path after a failed publication without overwriting the occupied target', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        const input = await makeInput(root);
        const path = attachmentPath(course.folderName, input.sources[0]);
        await live.writer.ensureDirectory('과목/자료구조/원본자료/문서');
        await writeFile(join(live.connection.managedRoot, path), 'user original');
        const spy = vi.spyOn(live.writer, 'writeCanvas').mockRejectedValueOnce(new Error('forced'));
        try {
          await expect(live.service.publish(input)).rejects.toThrow();
        } finally {
          spy.mockRestore();
        }
        const before = (await vaultFiles(live.connection.managedRoot)).filter((p) =>
          p.endsWith('.txt'),
        );
        await live.service.publish(input);
        const after = (await vaultFiles(live.connection.managedRoot)).filter((p) =>
          p.endsWith('.txt'),
        );
        expect(after).toEqual(before);
        expect(await readFile(join(live.connection.managedRoot, path), 'utf8')).toBe(
          'user original',
        );
      } finally {
        live.database.close();
      }
    });
  });

  it('chunks oversized generated evidence without dropping the last claim and serializes duplicate publishers', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        const input = await makeInput(root);
        const topic = required(input.content.topics[0]);
        const additions = Array.from({ length: 12 }, (_, i) => ({
          ...required(topic.explanations[0]),
          id: id(9000 + i),
          text: `claim ${i} ${'검증된 설명 '.repeat(2100)}`,
        }));
        const large = {
          ...input,
          content: {
            ...input.content,
            topics: [{ ...topic, explanations: additions }],
            verification: {
              ...input.content.verification,
              decisions: [
                ...input.content.verification.decisions,
                ...additions.map((claim) => ({
                  itemId: claim.id,
                  decision: 'accept',
                  reason: 'supported',
                  missingEvidenceIds: [],
                })),
              ],
            },
          },
        };
        await Promise.all([
          live.service.publish(JSON.parse(JSON.stringify(large))),
          live.service.publish(JSON.parse(JSON.stringify(large))),
        ]);
        const content = await readFile(
          join(
            live.connection.managedRoot,
            '과목/자료구조/강의노트/강의계획--topic_8000000000000401.md',
          ),
          'utf8',
        );
        expect(content).toContain('claim 11');
        expect(content.match(/claim 11/gu)).toHaveLength(1);
        expect(content.match(/generated:start/gu)?.length).toBeGreaterThan(1);
        const manifest = JSON.parse(
          await readFile(join(live.artifactRoot, 'workspace-manifest.json'), 'utf8'),
        ) as { manifest: { revision: number } };
        expect(manifest.manifest.revision).toBe(0);
      } finally {
        live.database.close();
      }
    });
  });

  it('keeps a visible evidence reference on every chunk of a long formula recall callout', async () => {
    await withTempDirectory(async (root) => {
      const live = await setup(root);
      try {
        const input = await makeInput(root);
        const content = {
          ...input.content,
          topics: input.content.topics.map((topic) => ({
            ...topic,
            formulas: topic.formulas.map((formula) => ({
              ...formula,
              assumptions: Array.from({ length: 30 }, (_, i) => `가정 ${i} ${'a'.repeat(1990)}`),
              conditions: Array.from({ length: 20 }, (_, i) => `조건 ${i} ${'b'.repeat(1990)}`),
            })),
          })),
        };
        await live.service.publish({ ...input, content });
        const memory = await readFile(
          join(live.connection.managedRoot, '과목/자료구조/암기/암기 체크리스트.md'),
          'utf8',
        );
        const callouts = memory.split('> [!question]').slice(1);
        expect(callouts.length).toBeGreaterThan(2);
        for (const callout of callouts) expect(callout).toContain(id(301));
      } finally {
        live.database.close();
      }
    });
  });
});
