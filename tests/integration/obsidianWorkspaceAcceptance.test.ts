import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCourseBase } from '../../src/application/obsidian/baseRenderer';
import type { WorkspacePublicationInput } from '../../src/application/obsidian/courseWorkspaceProjector';
import { CourseWorkspaceService } from '../../src/application/obsidian/courseWorkspaceService';
import {
  parseQuestionInbox,
  withQuestionCount,
} from '../../src/application/obsidian/questionInboxParser';
import {
  type InboxAnswerInput,
  QuestionInboxService,
} from '../../src/application/obsidian/questionInboxService';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import { VaultService } from '../../src/infrastructure/vault/vaultService';
import { VaultWriter } from '../../src/infrastructure/vault/vaultWriter';
import {
  JsonCanvasDocumentSchema,
  ObsidianBaseDocumentSchema,
  ObsidianPropertiesSchema,
} from '../../src/shared/contracts/obsidianWorkspace';
import { VerifiedStudyContentSchema } from '../../src/shared/contracts/studyContent';
import tree from '../fixtures/obsidian/expected-course-tree.json';
import { courseFixture, jobFixture } from '../testkit/fixtures';
import { withTempDirectory } from '../testkit/tempDirectory';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const vaultPath = (managed: string) => `AI 학습/${managed}`;
const course = courseFixture({ userInstructions: 'PRIVATE_SYSTEM_PROMPT_SECRET' });
const TOPIC = '과목/자료구조/강의노트/연결-리스트--topic_8000000000000401.md';
const CONCEPT = '과목/자료구조/개념/연결-리스트-정의--concept_8000000000001003.md';
const INBOX = '과목/자료구조/질문함/AI 질문함.md';
const USER_START = '<!-- study-assistant:user:start -->';
const USER_END = '<!-- study-assistant:user:end -->';
const Q1 = 'q_00000000000040008000000000000001';
const Q2 = 'q_00000000000040008000000000000002';
const Q3 = 'q_00000000000040008000000000000003';
const FREEFORM =
  '\r\n나의 메모  \t\r\n[[없는 사용자 노트]] ![[개인 그림.png]]\r\n[외부 참고](https://example.org)\r\n';
const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('Missing acceptance fixture');
  return value;
};
const userBytes = (note: string) =>
  note.slice(note.indexOf(USER_START) + USER_START.length, note.indexOf(USER_END));
const replaceUser = (note: string, user: string) =>
  `${note.slice(0, note.indexOf(USER_START) + USER_START.length)}${user}${note.slice(note.indexOf(USER_END))}`;
const appBytes = (note: string) =>
  note.replace(
    /<!-- study-assistant:user:start -->[\s\S]*?<!-- study-assistant:user:end -->/gu,
    '',
  );
const answerBlocks = (note: string) =>
  [
    ...note.matchAll(
      /<!-- study-assistant:generated:start section="answer_q_[a-f0-9]{32}" revision="[A-Za-z0-9_-]+" -->\n[\s\S]*?\n<!-- study-assistant:generated:end -->/gu,
    ),
  ].map((match) => match[0]);
const properties = (note: string) => {
  const frontmatter = required(/^---\n([\s\S]*?)\n---\n/u.exec(note)?.[1]);
  // Renderer emits JSON scalars/lists, a strict subset of quoted YAML Properties.
  return ObsidianPropertiesSchema.parse(
    Object.fromEntries(
      frontmatter.split('\n').map((line) => {
        const match = required(/^("[^"]+"): (.+)$/u.exec(line));
        return [JSON.parse(required(match[1])), JSON.parse(required(match[2]))];
      }),
    ),
  );
};
const enumerate = async (root: string) => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const path = (entry: (typeof entries)[number]) =>
    relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
  return {
    files: entries
      .filter((entry) => entry.isFile())
      .map(path)
      .sort(),
    directories: entries
      .filter((entry) => entry.isDirectory())
      .map(path)
      .sort(),
  };
};

async function publication(root: string, second = false): Promise<WorkspacePublicationInput> {
  const n = second ? 2 : 1;
  const original = required(tree.originals[n - 1]);
  const bytes = original.base64
    ? Buffer.from(original.base64, 'base64')
    : Buffer.from(required(original.text));
  const stagedPath = join(root, `source-${n}.${second ? 'png' : 'txt'}`);
  await writeFile(stagedPath, bytes);
  const source = {
    id: id(100 + n),
    bundleId: id(200 + n),
    ordinal: 0,
    originalFileName: second ? 'problem.png' : 'syllabus.txt',
    mediaType: second ? ('image' as const) : ('document' as const),
    stagedPath,
    sha256: original.sha256,
    sizeBytes: bytes.length,
  };
  const evidenceId = id(300 + n);
  const date = second ? '2026-09-08' : '2026-09-07';
  const claim = (itemId: number, text: string) => ({
    id: id(itemId),
    text,
    evidenceIds: [evidenceId],
    status: 'source_supported',
    uncertainty: null,
  });
  const topic = (newTopic: boolean) => {
    const title = newTopic ? '배열' : '연결 리스트';
    const action = second && !newTopic ? 'merge' : 'create';
    const existingTopicId = action === 'merge' ? id(401) : null;
    return {
      cluster: {
        id: id(newTopic ? 499 : 400 + n),
        title,
        action,
        existingTopicId,
        evidenceIds: [evidenceId],
        uncertainty: null,
        sessionDates: [date],
      },
      title,
      action,
      existingTopicId,
      contentMode: action === 'merge' ? 'merge_delta' : 'new_topic',
      sessionDates: [date],
      outline: [claim(n * 1000 + (newTopic ? 11 : 1), `${title} 학습 목표 ${n}`)],
      explanations: [],
      definitions: [claim(newTopic ? 2013 : 1003, `${title} 정의`)],
      formulas: [],
      examples: [claim(n * 1000 + (newTopic ? 15 : 5), `${title} 예시`)],
      exceptions: [claim(n * 1000 + (newTopic ? 16 : 6), `${title} 예외`)],
      misconceptions: [],
      professorSignals: [
        {
          ...claim(n * 1000 + (newTopic ? 18 : 8), `${title} 시험 강조`),
          observationKind: 'explicit_emphasis',
          inference: 'observable_course_evidence',
        },
      ],
      conflicts: [],
      citations: [
        {
          evidenceId,
          sourceId: source.id,
          locator: second
            ? { kind: 'image', x: 0, y: 0, width: 1, height: 1 }
            : { kind: 'text', startLine: 1, endLine: 1 },
        },
      ],
      sessions: [{ date, evidenceIds: [evidenceId] }],
    };
  };
  const topics = second ? [topic(false), topic(true)] : [topic(false)];
  // Separate verification decisions, never a synthesis-level "verified" flag.
  const accepted = second
    ? [2001, 1003, 2005, 2006, 2008, 2011, 2013, 2015, 2016, 2018]
    : [1001, 1003, 1005, 1006, 1008];
  return {
    course,
    job: jobFixture({
      id: id(n),
      sourceBundleId: source.bundleId,
      sourceFileName: source.originalFileName,
      sourceMediaType: source.mediaType,
      stagedSourcePath: stagedPath,
      sourceSha256: source.sha256,
      summaryMode: 'core',
    }),
    bundle: {
      id: source.bundleId,
      jobId: id(n),
      manifestSha256: hash(`manifest-${n}`),
      sourceCount: 1,
      totalBytes: source.sizeBytes,
      stagingDirectoryPath: root,
      createdAt: `${date}T00:00:00.000Z`,
    },
    sources: [source],
    content: VerifiedStudyContentSchema.parse({
      contentSchemaVersion: 2,
      topics,
      verification: {
        verificationSchemaVersion: 1,
        decisions: accepted.map((itemId) => ({
          itemId: id(itemId),
          decision: 'accept',
          reason: 'supported',
          missingEvidenceIds: [],
        })),
      },
    }),
    provenance: [{ invocationId: id(500 + n), modelId: 'offline-acceptance', promptVersion: 'v1' }],
  };
}

async function setup(root: string) {
  const connection = await new VaultService().connect({
    path: join(root, 'vault'),
    mode: 'create',
  });
  // Competing user files make an unprefixed Obsidian reference demonstrably wrong.
  for (const path of [...tree.firstFiles, ...tree.secondAddedFiles]) {
    await mkdir(dirname(join(connection.vaultRoot, path)), { recursive: true });
    await writeFile(join(connection.vaultRoot, path), 'USER-OWNED DECOY');
  }
  const artifactRoot = join(root, 'private');
  await mkdir(artifactRoot);
  const database = openDatabase(join(root, 'db.sqlite'));
  const repositories = createRepositories(database);
  repositories.courses.insert(course);
  const writer = new VaultWriter(connection);
  const workspace = new CourseWorkspaceService({ connection, artifactRoot, repositories, writer });
  const read = (path: string) => readFile(join(connection.managedRoot, path), 'utf8');
  const edit = (path: string, content: string) =>
    writeFile(join(connection.managedRoot, path), content);
  const calls: InboxAnswerInput[] = [];
  let invalidCitation = false;
  const dependencies = {
    workspaceRoot: connection.realManagedRoot,
    writer,
    revisions: repositories.managedNotes,
    targets: () => workspace.questionInboxTargets(),
    evidence: (target: { courseId: string }) => workspace.questionEvidence(target.courseId),
    idGenerator: () => Q1,
    answer: async (input: InboxAnswerInput) => {
      calls.push(input);
      return {
        output: {
          answer: '이전 노드를 알고 있을 때 삭제 비용은 일정합니다.',
          steps: ['연결을 갱신합니다.'],
          example: '',
          uncertainty: '',
          evidenceIds: [invalidCitation ? id(9999) : required(input.evidence[0]).evidenceId],
        },
        provenance: {
          requestId: id(900 + calls.length),
          modelId: 'offline-answer',
          promptVersion: 'v1',
          promptSha256: 'a'.repeat(64),
          completedAt: '2026-09-08T00:00:00.000Z',
        },
      };
    },
  };
  return {
    connection,
    database,
    repositories,
    workspace,
    writer,
    artifactRoot,
    read,
    edit,
    calls,
    dependencies,
    invalidCitation: (value: boolean) => {
      invalidCitation = value;
    },
  };
}
type Harness = Awaited<ReturnType<typeof setup>>;

async function assertOriginals(h: Harness, count: number) {
  for (const original of tree.originals.slice(0, count)) {
    const bytes = await readFile(join(h.connection.managedRoot, original.path));
    expect(bytes).toEqual(
      original.base64
        ? Buffer.from(original.base64, 'base64')
        : Buffer.from(required(original.text)),
    );
    expect(hash(bytes)).toBe(original.sha256);
  }
}

async function assertLinksAndPrivacy(h: Harness) {
  const all = await enumerate(h.connection.managedRoot);
  const vault = await enumerate(h.connection.vaultRoot);
  const targets: string[] = [];
  for (const path of all.files) {
    const content = await h.read(path);
    expect(content, path).not.toMatch(
      /(?:(?<![A-Za-z])[A-Za-z]:[\\/]|file:\/\/|\\\\[A-Za-z]|(?:sk-|AIza)[A-Za-z0-9_-]{16,}|PRIVATE_SYSTEM_PROMPT_SECRET|"(?:rawResponse|providerResponse|choices|candidates|systemPrompt)"\s*:)/u,
    );
    expect(content, path).not.toContain(h.artifactRoot);
    if (!path.endsWith('.md')) continue;
    if (content.includes('study-assistant:generated:start')) {
      const metadata = properties(content);
      expect(typeof metadata.note_type, path).toBe('string');
      if (path !== '학습 대시보드.md') {
        expect(metadata.course_id, path).toBe(course.id);
        expect(metadata.stable_id, path).toMatch(/^[a-z_]+_[a-f0-9-]{36}$/u);
      }
    }
    const generated = appBytes(content);
    for (const link of generated.matchAll(/(?<!!)\[\[([^\]\n]+)\]\]|!\[\[([^\]\n]+)\]\]/gu)) {
      const target = required(link[1] ?? link[2])
        .split('|')[0]
        ?.split('#')[0];
      targets.push(required(target));
      expect(target).toMatch(/^AI 학습\//u);
      expect(vault.files, `${path} -> ${target}`).toContain(target);
      expect(await readFile(join(h.connection.vaultRoot, required(target)), 'utf8')).not.toBe(
        'USER-OWNED DECOY',
      );
    }
  }
  expect(targets.length).toBeGreaterThan(30);
  const wholeVault = await enumerate(h.connection.vaultRoot);
  expect(
    wholeVault.files.some((path) =>
      /workspace-manifest|pipeline|provider-response|\.sqlite|\.tmp|\.lock/u.test(path),
    ),
  ).toBe(false);
}

async function assertStructuredArtifacts(h: Harness) {
  const canvasPath = '과목/자료구조/마인드맵/과목 전체.canvas';
  const canvas = JsonCanvasDocumentSchema.parse({
    ...JSON.parse(await h.read(canvasPath)),
    stableId: 'acceptance_canvas',
    kind: 'canvas',
    relativePath: canvasPath,
  });
  const all = await enumerate(h.connection.vaultRoot);
  expect(canvas.nodes.length).toBeGreaterThanOrEqual(4);
  const ids = canvas.nodes.map((node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const node of canvas.nodes)
    if (node.type === 'file') {
      expect(node.file).toMatch(/^AI 학습\//u);
      expect(all.files).toContain(node.file);
      expect(await readFile(join(h.connection.vaultRoot, node.file), 'utf8')).not.toBe(
        'USER-OWNED DECOY',
      );
    }
  for (const edge of canvas.edges) {
    expect(ids).toContain(edge.fromNode);
    expect(ids).toContain(edge.toNode);
  }
  const svgPath = '과목/자료구조/마인드맵/과목 전체.svg';
  const svg = required(await h.writer.readSvg(svgPath)).content; // Production passive XML validator on read.
  expect(svg).toBe(await h.read(svgPath));
  expect(svg).not.toMatch(/<script|<foreignObject|\son\w+\s*=|(?:href|src)\s*=|<!DOCTYPE|<\?xml/iu);
  expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toMatch(
    /https?:\/\/|javascript:|data:/iu,
  );
  const box = required(/viewBox="(-?\d+) (-?\d+) (\d+) (\d+)"/u.exec(svg));
  for (const coordinate of box.slice(1, 3).map(Number))
    expect(Math.abs(coordinate)).toBeLessThanOrEqual(100_000);
  for (const bound of box.slice(3).map(Number)) {
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThanOrEqual(200_000);
  }
  expect(Buffer.byteLength(svg)).toBeLessThan(32 * 1024 ** 2);
  for (const [basePath, companion] of [
    ['학습 대시보드.base', '학습 대시보드.md'],
    ['과목/자료구조/과목 색인.base', '과목/자료구조/자료구조.md'],
  ] as const) {
    const global = basePath === '학습 대시보드.base';
    const descriptor = ObsidianBaseDocumentSchema.parse({
      stableId: global ? 'dashboard_base' : `base_${course.id}`,
      kind: 'base',
      relativePath: basePath,
      courseId: global ? null : course.id,
      views: [
        { id: 'recent-lectures', name: '최근 강의노트', noteKinds: ['lecture'] },
        { id: 'attention-needed', name: '검토 필요', noteKinds: ['lecture', 'concept'] },
        { id: 'exam-candidates', name: '시험 후보', noteKinds: ['lecture', 'concept'] },
        { id: 'question-counts', name: '질문 수', noteKinds: ['question_bank', 'question_inbox'] },
        { id: 'latest-exam-packages', name: '최근 시험', noteKinds: ['course'] },
      ].map((view) => ({
        ...view,
        type: 'table',
        properties: ['stable_id', 'note_type', 'updated_at', 'question_count'],
      })),
    });
    const yaml = required(await h.writer.readBase(basePath)).content;
    expect(yaml).toBe(renderCourseBase(descriptor));
    // Parse the emitted restricted YAML (single-quoted scalars and indentation)
    // independently, then send recovered view values through the production contract.
    const scalar = (value: string) =>
      required(/^'((?:[^']|'')*)'$/u.exec(value)?.[1]).replaceAll("''", "'");
    const emittedViews = yaml
      .split('\n  - type: ')
      .slice(1)
      .map((block) => {
        const lines = block.split('\n');
        const name = scalar(
          required(lines.find((line) => line.startsWith('    name: '))).slice(10),
        );
        const expected = required(descriptor.views.find((view) => view.name === name));
        const order = required(
          / {4}order:\n([\s\S]*?)(?= {4}sort:| {4}limit:|$)/u.exec(block)?.[1],
        );
        const kinds = [...block.matchAll(/note_type == "([a-z_]+)"/gu)].map((match) =>
          required(match[1]),
        );
        return {
          id: expected.id,
          name,
          type: scalar(required(lines[0])),
          noteKinds: [...new Set(kinds)],
          properties: order
            .trimEnd()
            .split('\n')
            .map((line) => scalar(line.slice(8))),
        };
      });
    const parsed = ObsidianBaseDocumentSchema.parse({ ...descriptor, views: emittedViews });
    expect(parsed.views.map((view) => view.name).sort()).toEqual(
      descriptor.views.map((view) => view.name).sort(),
    );
    expect(yaml.split('\n').filter((line) => line === "  - type: 'table'")).toHaveLength(5);
    expect(yaml).toContain(
      global ? 'file.inFolder("AI 학습/과목")' : 'file.inFolder("AI 학습/과목/자료구조")',
    );
    expect(yaml).not.toContain('file.inFolder("과목');
    expect(await h.read(companion)).toContain(`[[${vaultPath(basePath)}]]`);
    expect(appBytes(await h.read(companion))).toContain(
      global ? '[[AI 학습/과목/자료구조/자료구조.md]]' : `[[${vaultPath(TOPIC)}]]`,
    );
  }
}

describe('complete deterministic Obsidian knowledge workspace acceptance', () => {
  it('preserves cumulative evidence, originals, user bytes and durable answers across two verified publications', async () => {
    await withTempDirectory(async (root) => {
      const h = await setup(root);
      try {
        const first = await publication(root);
        await h.workspace.publish(first);
        expect(await enumerate(h.connection.managedRoot)).toEqual({
          files: [...tree.firstFiles].sort(),
          directories: [...tree.directories].sort(),
        });
        await assertOriginals(h, 1);
        await assertStructuredArtifacts(h);
        await h.edit(TOPIC, replaceUser(await h.read(TOPIC), FREEFORM));
        const inboxUser = `${FREEFORM}- [ ] 질문: 삭제는 언제 일정한 비용인가?\r\n`;
        await h.edit(INBOX, replaceUser(await h.read(INBOX), inboxUser));
        const inbox = new QuestionInboxService(h.dependencies);
        await inbox.pollOnce();
        expect(userBytes(await h.read(INBOX))).toBe(inboxUser);
        expect(h.calls).toEqual([]);
        await inbox.pollOnce();
        const assignedUser = inboxUser.replace('- [ ] 질문:', `- [ ] \`${Q1}\` 질문:`);
        expect(userBytes(await h.read(INBOX))).toBe(assignedUser);
        expect(properties(await h.read(INBOX)).question_count).toBe(1);
        expect(h.calls).toEqual([]);
        await inbox.pollOnce();
        expect(h.calls).toEqual([]);
        await inbox.pollOnce();
        const answered = await h.read(INBOX);
        expect(parseQuestionInbox(answered).completed).toEqual([Q1]);
        expect(userBytes(answered)).toBe(assignedUser);
        expect(h.calls.map((call) => call.question.id)).toEqual([Q1]);
        const priorAnswers = answerBlocks(answered);
        expect(priorAnswers).toHaveLength(1);

        const second = await publication(root, true);
        await h.workspace.publish(second);
        expect(await enumerate(h.connection.managedRoot)).toEqual({
          files: [...tree.firstFiles, ...tree.secondAddedFiles].sort(),
          directories: [...tree.directories].sort(),
        });
        expect(Buffer.from(userBytes(await h.read(TOPIC)))).toEqual(Buffer.from(FREEFORM));
        expect(answerBlocks(await h.read(INBOX))).toEqual(priorAnswers);
        expect(properties(await h.read(INBOX)).question_count).toBe(1);
        expect(userBytes(await h.read(INBOX))).toBe(assignedUser);
        for (const [path, stableId, kind] of [
          ['과목/자료구조/자료구조.md', `course_${course.id}`, 'course'],
          [TOPIC, `topic_${id(401)}`, 'lecture'],
          [CONCEPT, `concept_${id(1003)}`, 'concept'],
          [INBOX, `inbox_${course.id}`, 'question_inbox'],
          ['과목/자료구조/교수 강조·출제 프로필.md', `profile_${course.id}`, 'professor_profile'],
          ['과목/자료구조/암기/암기 체크리스트.md', `memory_${course.id}`, 'memory'],
          ['과목/자료구조/핵심정리.md', `summary_${course.id}`, 'memory'],
          ['과목/자료구조/문제은행/원문 문제.md', `source_questions_${course.id}`, 'question_bank'],
          ['과목/자료구조/문제은행/AI 예상문제.md', `predicted_${course.id}`, 'question_bank'],
          ['과목/자료구조/문제은행/AI 변형문제.md', `variants_${course.id}`, 'question_bank'],
        ] as const) {
          expect(properties(await h.read(path))).toMatchObject({
            stable_id: stableId,
            course_id: course.id,
            note_type: kind,
            source_ids: [id(101), id(102)],
            session_dates: ['2026-09-07', '2026-09-08'],
            source_links: tree.originals.map((original) => `[[${vaultPath(original.path)}]]`),
            review_status: 'verified',
            prompt_version: 'v1',
          });
        }
        await assertOriginals(h, 2);
        for (const callout of ['summary', 'important', 'warning', 'example'])
          expect(await h.read(TOPIC)).toContain(`[!${callout}]`);
        expect(await h.read('과목/자료구조/문제은행/원문 문제.md')).toContain(
          `![[${vaultPath(required(tree.originals[1]).path)}]]`,
        );
        await assertStructuredArtifacts(h);
        const beforeRestart = await h.read(INBOX);
        const restarted = new QuestionInboxService(h.dependencies);
        await restarted.pollOnce();
        await restarted.pollOnce();
        expect(h.calls.map((call) => call.question.id)).toEqual([Q1]);
        expect(await h.read(INBOX)).toBe(beforeRestart);
        const nextUser = `${assignedUser}- [ ] \`${Q2}\` 질문: 배열과 무엇이 다른가?\r\n- [ ] \`${Q3}\` 질문: 예외는 무엇인가?\r\n`;
        await h.edit(INBOX, replaceUser(await h.read(INBOX), nextUser));
        await restarted.pollOnce();
        expect(h.calls.map((call) => call.question.id)).toEqual([Q1]);
        await restarted.pollOnce();
        const final = await h.read(INBOX);
        expect(h.calls.map((call) => call.question.id)).toEqual([Q1, Q2, Q3]);
        expect(parseQuestionInbox(final).completed).toEqual([Q1, Q2, Q3]);
        expect(answerBlocks(final).slice(0, 1)).toEqual(priorAnswers);
        expect(userBytes(final)).toBe(nextUser);
        expect(properties(final).question_count).toBe(3);
        for (const [index, block] of answerBlocks(final).entries()) {
          const offered = required(h.calls[index]).evidence.map((item) => item.evidenceId);
          for (const item of required(h.calls[index]).evidence)
            expect(tree.originals.map((original) => original.path)).toContain(item.relativePath);
          const citations = [...block.matchAll(/근거: `([a-f0-9-]{36})`/gu)].map(
            (match) => match[1],
          );
          expect(citations.length).toBeGreaterThan(0);
          for (const citation of citations) expect(offered).toContain(citation);
        }
        const again = new QuestionInboxService(h.dependencies);
        await again.pollOnce();
        await again.pollOnce();
        expect(h.calls).toHaveLength(3);
        expect(await h.read(INBOX)).toBe(final);
        const historicalUser = nextUser
          .replace(`- [ ] \`${Q1}\` 질문: 삭제는 언제 일정한 비용인가?\r\n`, '')
          .replace(`- [ ] \`${Q2}\``, `- [x] \`${Q2}\``);
        await h.edit(INBOX, replaceUser(final, historicalUser));
        await again.pollOnce();
        await again.pollOnce();
        expect(properties(await h.read(INBOX)).question_count).toBe(3);
        expect(answerBlocks(await h.read(INBOX))).toEqual(answerBlocks(final));
        expect(userBytes(await h.read(INBOX))).toBe(historicalUser);
        expect(h.calls).toHaveLength(3);
        await assertLinksAndPrivacy(h);
      } finally {
        h.database.close();
      }
    });
  }, 30_000);

  it('preserves a generated edit and candidate without committing the failed workspace revision', async () => {
    await withTempDirectory(async (root) => {
      const h = await setup(root);
      try {
        await h.workspace.publish(await publication(root));
        const manifestPath = join(h.artifactRoot, 'workspace-manifest.json');
        const manifest = await readFile(manifestPath);
        const edited = (await h.read(TOPIC)).replace('학습 목표 1', '사용자가 고친 생성 문장');
        await h.edit(TOPIC, edited);
        const before = required(h.repositories.managedNotes.get(`topic_${id(401)}`));
        await expect(h.workspace.publish(await publication(root, true))).rejects.toThrow(
          'WORKSPACE_NOTE_CONFLICT_PRESERVED',
        );
        expect(Buffer.from(await h.read(TOPIC))).toEqual(Buffer.from(edited));
        expect(await readFile(manifestPath)).toEqual(manifest);
        expect(h.repositories.managedNotes.get(`topic_${id(401)}`)).toEqual(before);
        const conflicts = h.repositories.managedNotes.conflicts(`topic_${id(401)}`);
        expect(conflicts).toHaveLength(1);
        const candidate = required(conflicts[0]).candidatePath;
        expect((await enumerate(h.connection.managedRoot)).files).toContain(candidate);
        expect(await h.read(candidate)).toContain('학습 목표 2');
        expect(await h.read(candidate)).not.toContain('사용자가 고친 생성 문장');
        await assertOriginals(h, 1);
      } finally {
        h.database.close();
      }
    });
  });

  it('rejects unverified publication and unoffered answer citations without accepting output', async () => {
    await withTempDirectory(async (root) => {
      const h = await setup(root);
      try {
        const first = await publication(root);
        await expect(
          h.workspace.publish({
            ...first,
            content: {
              ...first.content,
              verification: { ...first.content.verification, decisions: [] },
            },
          }),
        ).rejects.toThrow();
        expect((await enumerate(h.connection.managedRoot)).files).toEqual(['메인 학습 노트.md']);
        await h.workspace.publish(first);
        await h.edit(
          INBOX,
          replaceUser(await h.read(INBOX), `\n- [ ] \`${Q1}\` 질문: 근거가 있는가?\n`),
        );
        const before = await h.read(INBOX);
        h.invalidCitation(true);
        const inbox = new QuestionInboxService(h.dependencies);
        await inbox.pollOnce();
        await inbox.pollOnce();
        expect(h.calls).toHaveLength(1);
        expect(await h.read(INBOX)).toBe(withQuestionCount(before, 1));
        expect(parseQuestionInbox(await h.read(INBOX)).completed).toEqual([]);
        h.invalidCitation(false);
        await inbox.pollOnce();
        await inbox.pollOnce();
        expect(parseQuestionInbox(await h.read(INBOX)).completed).toEqual([Q1]);
      } finally {
        h.database.close();
      }
    });
  });
});
