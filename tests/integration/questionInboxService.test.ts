import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ManagedNoteService } from '../../src/application/obsidian/managedNoteService';
import {
  parseQuestionInbox,
  withQuestionCount,
} from '../../src/application/obsidian/questionInboxParser';
import { QuestionInboxService } from '../../src/application/obsidian/questionInboxService';
import { runWorkspaceExclusive } from '../../src/application/obsidian/workspaceSerialQueue';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import { VaultService } from '../../src/infrastructure/vault/vaultService';
import { VaultWriter } from '../../src/infrastructure/vault/vaultWriter';
import {
  QuestionAnswerSchema,
  QuestionEvidenceListSchema,
} from '../../src/shared/contracts/questionInbox';
import { deferred } from '../testkit/deferred';
import { withTempDirectory } from '../testkit/tempDirectory';

const ID = 'q_018f47f2d4d77f83b513f00a12345678';
const SECOND = 'q_018f47f2d4d77f83b513f00a12345679';
const EVIDENCE = '018f47f2-d4d7-7f83-b513-f00a12345678';
const base =
  '---\n"locked": false\n---\n\n<!-- study-assistant:generated:start section="intro" revision="r1" -->\n질문함\n<!-- study-assistant:generated:end -->\n\n<!-- study-assistant:user:start -->\n<!-- study-assistant:user:end -->\n';
const answer = {
  answer: 'O(1)입니다.',
  steps: ['이전 노드를 알고 있습니다.'],
  example: '',
  uncertainty: '조건을 확인하세요.',
  evidenceIds: [EVIDENCE],
};
const result = (output: unknown) => ({
  output,
  provenance: {
    requestId: EVIDENCE,
    modelId: 'test-model',
    promptVersion: 'v1',
    promptSha256: 'a'.repeat(64),
    completedAt: '2026-09-07T00:00:00.000Z',
  },
});
const target = {
  courseId: EVIDENCE,
  stableId: 'inbox_a',
  relativePath: 'inbox.md',
  userInstructions: '',
};
const evidence = [
  {
    evidenceId: EVIDENCE,
    relativePath: '과목/자료구조/원본자료/a.pdf',
    label: '원본',
    text: '이전 노드를 아는 삭제는 O(1).',
  },
];

const run = (test: (h: Awaited<ReturnType<typeof setup>>) => Promise<void>) =>
  withTempDirectory(async (root) => {
    const h = await setup(root);
    try {
      await test(h);
    } finally {
      h.database.close();
    }
  });
async function setup(root: string) {
  const connection = await new VaultService().connect({
    path: join(root, 'vault'),
    mode: 'create',
  });
  const writer = new VaultWriter(connection);
  const database = openDatabase(join(root, 'db.sqlite'));
  const repositories = createRepositories(database);
  await new ManagedNoteService(repositories.managedNotes, writer).publish({
    stableId: target.stableId,
    relativePath: target.relativePath,
    content: base,
    generationRevision: 'r1',
  });
  const calls: string[] = [];
  let fail = false;
  let response: unknown = answer;
  const dependencies = {
    workspaceRoot: connection.realManagedRoot,
    writer,
    revisions: repositories.managedNotes,
    targets: async () => [target],
    evidence: async () => evidence,
    answer: async (input: { question: { id: string } }) => {
      calls.push(input.question.id);
      if (fail) throw new Error('offline');
      return result(response);
    },
    idGenerator: () => SECOND,
  };
  const service = new QuestionInboxService(dependencies);
  const read = async () => (await writer.readMarkdown('inbox.md'))?.content ?? '';
  const edit = async (content: string) =>
    writer.writeMarkdown({
      relativePath: 'inbox.md',
      content,
      expectedBaseHash: (await writer.readMarkdown('inbox.md'))?.sha256 ?? null,
    });
  return {
    database,
    writer,
    repositories,
    dependencies,
    service,
    calls,
    read,
    edit,
    fail: (value: boolean) => {
      fail = value;
    },
    response: (value: unknown) => {
      response = value;
    },
  };
}
describe('durable question inbox processing', () => {
  it.each(['VIOLET7319', '비공개코드:청록등대'])(
    'keeps short private instruction echoes pending at the direct adapter boundary',
    (instruction) =>
      run(async (h) => {
        const user = `\n- [ ] \`${ID}\` 질문: first\n`;
        await h.edit(
          base.replace('\n<!-- study-assistant:user:end', `${user}<!-- study-assistant:user:end`),
        );
        const service = new QuestionInboxService({
          ...h.dependencies,
          targets: async () => [{ ...target, userInstructions: instruction }],
        });
        for (const echo of [instruction, instruction.toLowerCase().split('').join(' \\_ ')]) {
          h.response(QuestionAnswerSchema.parse({ ...answer, answer: echo }));
          await service.pollOnce();
          await service.pollOnce();
          const parsed = parseQuestionInbox(await h.read());
          expect(parsed.completed).toEqual([]);
          expect(parsed.questions.map((question) => question.id)).toEqual([ID]);
          expect(parsed.user).toBe(user);
          expect(await h.read()).not.toContain(echo);
        }
        h.response(answer);
        await service.pollOnce();
        expect(parseQuestionInbox(await h.read()).completed).toEqual([ID]);
      }),
  );
  it.each([
    'COURSE_PRIVATE_SENTINEL_7319',
    'course\\_private\\_sentinel\\_7319',
    'C O U R S E private Sentinel 7 3 1 9',
  ])('keeps instruction-echo answers pending without publishing %s', (echo) =>
    run(async (h) => {
      const user = `\n- [ ] \`${ID}\` 질문: first\n`;
      await h.edit(
        base.replace('\n<!-- study-assistant:user:end', `${user}<!-- study-assistant:user:end`),
      );
      h.response({ ...answer, steps: [echo] });
      const service = new QuestionInboxService({
        ...h.dependencies,
        targets: async () => [{ ...target, userInstructions: 'COURSE_PRIVATE_SENTINEL_7319' }],
      });
      await service.pollOnce();
      await service.pollOnce();
      expect(h.calls).toHaveLength(1);
      const parsed = parseQuestionInbox(await h.read());
      expect(parsed.completed).toEqual([]);
      expect(parsed.user).toBe(user);
      expect(await h.read()).not.toContain(echo);
      h.response(answer);
      await service.pollOnce();
      expect(parseQuestionInbox(await h.read()).completed).toEqual([ID]);
    }),
  );
  it('counts recorded questions while pending and completed without double counting after restart', () =>
    run(async (h) => {
      await h.edit(
        base.replace(
          '\n<!-- study-assistant:user:end',
          `\n- [ ] \`${ID}\` 질문: first\n<!-- study-assistant:user:end`,
        ),
      );
      h.fail(true);
      await h.service.pollOnce();
      await h.service.pollOnce();
      expect(await h.read()).toContain('"question_count": 1');
      expect(parseQuestionInbox(await h.read()).completed).toEqual([]);
      h.fail(false);
      await h.service.pollOnce();
      expect(parseQuestionInbox(await h.read()).completed).toEqual([ID]);
      expect(await h.read()).toContain('"question_count": 1');
      const before = await h.read();
      const restarted = new QuestionInboxService(h.dependencies);
      await restarted.pollOnce();
      await restarted.pollOnce();
      expect(await h.read()).toBe(before);
    }));
  it('cancels a queued inbox without dispatch and can poll again after publication drains', () =>
    run(async (h) => {
      await h.edit(
        base.replace(
          '\n<!-- study-assistant:user:end',
          `\n- [ ] \`${ID}\` 질문: first\n<!-- study-assistant:user:end`,
        ),
      );
      await h.service.pollOnce();
      const entered = deferred();
      const release = deferred();
      const publishing = runWorkspaceExclusive(h.dependencies.workspaceRoot, async () => {
        entered.resolve();
        await release.promise;
      });
      try {
        await entered.promise;
        const controller = new AbortController();
        const polling = h.service.pollOnce(controller.signal);
        controller.abort();
        await polling;
        expect(h.calls).toEqual([]);
      } finally {
        release.resolve();
        await publishing;
      }
      await h.service.pollOnce();
      expect(h.calls).toEqual([ID]);
      expect(await h.read()).toContain('상태: completed');
    }));
  it('reserves answer capacity against actual UTF-8 user bytes and remains readable across restart', () =>
    run(async (h) => {
      const withQuestion = base.replace(
        '\n<!-- study-assistant:user:end',
        `\n- [ ] \`${ID}\` 질문: first\n<!-- study-assistant:user:end`,
      );
      const nearLimit = withQuestion.replace(
        '<!-- study-assistant:user:end -->',
        `${'메'.repeat(Math.floor((1024 * 1024 - 128 - Buffer.byteLength(withQuestion)) / 3))}\n<!-- study-assistant:user:end -->`,
      );
      expect(() => parseQuestionInbox(nearLimit)).not.toThrow();
      await h.edit(nearLimit);
      await h.service.pollOnce();
      await h.service.pollOnce();
      expect(h.calls).toEqual([]);
      expect(await h.read()).toBe(withQuestionCount(nearLimit, 1));
      expect(h.repositories.managedNotes.conflicts(target.stableId)).toEqual([]);
      const spacious = withQuestionCount(withQuestion, 1).replace(
        '<!-- study-assistant:user:end -->',
        `${'메'.repeat(Math.floor((700 * 1024 - Buffer.byteLength(withQuestion)) / 3))}\n<!-- study-assistant:user:end -->`,
      );
      await h.edit(spacious);
      await h.service.pollOnce();
      await h.service.pollOnce();
      const published = await h.read();
      expect(published).toContain('상태: completed');
      expect(parseQuestionInbox(published).user).toBe(parseQuestionInbox(spacious).user);
      const restarted = new QuestionInboxService(h.dependencies);
      await restarted.pollOnce();
      await restarted.pollOnce();
      expect(h.calls).toEqual([ID]);
      expect(await h.read()).toBe(published);
    }));
  it('does not dispatch or create conflict artifacts when all 100 generated slots are occupied', () =>
    run(async (h) => {
      const filler = Array.from(
        { length: 99 },
        (_, n) =>
          `<!-- study-assistant:generated:start section="filler_${n}" revision="r1" -->\nfiller\n<!-- study-assistant:generated:end -->\n\n`,
      ).join('');
      const fullBase = base.replace(
        '<!-- study-assistant:user:start -->',
        `${filler}<!-- study-assistant:user:start -->`,
      );
      await new ManagedNoteService(h.repositories.managedNotes, h.writer).publish({
        stableId: target.stableId,
        relativePath: target.relativePath,
        content: fullBase,
        generationRevision: 'r2',
      });
      const content = fullBase.replace(
        '\n<!-- study-assistant:user:end',
        `\n- [ ] \`${ID}\` 질문: first\n<!-- study-assistant:user:end`,
      );
      await h.edit(content);
      const writes = vi.spyOn(h.writer, 'writeMarkdown');
      for (let n = 0; n < 4; n++) await h.service.pollOnce();
      const restarted = new QuestionInboxService(h.dependencies);
      await restarted.pollOnce();
      await restarted.pollOnce();
      expect(h.calls).toEqual([]);
      expect(await h.read()).toBe(withQuestionCount(content, 1));
      expect(h.repositories.managedNotes.conflicts(target.stableId)).toEqual([]);
      expect(writes).toHaveBeenCalledTimes(1); // Only the pending count; no answer section.
    }));
  it('checks the exact preserved-user candidate again at the final writer boundary', () =>
    run(async (h) => {
      const countedBase = withQuestionCount(base, 1);
      await new ManagedNoteService(h.repositories.managedNotes, h.writer).publish({
        stableId: target.stableId,
        relativePath: target.relativePath,
        content: countedBase,
        generationRevision: 'counted',
      });
      const content = countedBase.replace(
        '\n<!-- study-assistant:user:end',
        `\n- [ ] \`${ID}\` 질문: first\n<!-- study-assistant:user:end`,
      );
      await h.edit(content);
      await h.service.pollOnce();
      const nearLimit = content.replace(
        '<!-- study-assistant:user:end -->',
        `${'메'.repeat(Math.floor((1024 * 1024 - 128 - Buffer.byteLength(content)) / 3))}\n<!-- study-assistant:user:end -->`,
      );
      const real = ManagedNoteService.prototype.publish;
      const spy = vi
        .spyOn(ManagedNoteService.prototype, 'publish')
        .mockImplementationOnce(async function (this: ManagedNoteService, input) {
          await h.edit(nearLimit);
          return real.call(this, input);
        });
      try {
        await h.service.pollOnce();
      } finally {
        spy.mockRestore();
      }
      expect(h.calls).toEqual([ID]);
      expect(await h.read()).toBe(nearLimit);
      expect(() => parseQuestionInbox(nearLimit)).not.toThrow();
      expect(h.repositories.managedNotes.get(target.stableId)?.generatedBase).toBe(countedBase);
      expect(h.repositories.managedNotes.conflicts(target.stableId)).toEqual([]);
      const restarted = new QuestionInboxService(h.dependencies);
      await restarted.pollOnce();
      await restarted.pollOnce();
      expect(h.calls).toEqual([ID]);
    }));
  it('publishes maximum schema-valid prose and long citations within reserved capacity exactly once across restart', () =>
    run(async (h) => {
      const countedBase = withQuestionCount(base, 1);
      await new ManagedNoteService(h.repositories.managedNotes, h.writer).publish({
        stableId: target.stableId,
        relativePath: target.relativePath,
        content: countedBase,
        generationRevision: 'counted',
      });
      const withQuestion = countedBase.replace(
        '\n<!-- study-assistant:user:end',
        `\n- [ ] \`${ID}\` 질문: first\n<!-- study-assistant:user:end`,
      );
      const content = withQuestion.replace(
        '<!-- study-assistant:user:end -->',
        `${'메'.repeat(Math.floor((768 * 1024 - 1 - Buffer.byteLength(withQuestion)) / 3))}\n<!-- study-assistant:user:end -->`,
      );
      await h.edit(content);
      const longPath = `${'가'.repeat(250)}/${'가'.repeat(250)}/${'가'.repeat(250)}.pdf`;
      const offered = QuestionEvidenceListSchema.parse(
        Array.from({ length: 32 }, (_, n) => ({
          evidenceId: `018f47f2-d4d7-7f83-b513-${n.toString(16).padStart(12, '0')}`,
          relativePath: longPath,
          label: '나'.repeat(500),
          text: '근거',
        })),
      );
      const maximum = QuestionAnswerSchema.parse({
        answer: '&'.repeat(4096),
        steps: ['&'.repeat(4096)],
        example: '',
        uncertainty: '',
        evidenceIds: offered.map((item) => item.evidenceId),
      });
      const dependencies = {
        ...h.dependencies,
        evidence: async () => offered,
        answer: async (input: { question: { id: string } }) => {
          h.calls.push(input.question.id);
          return result(maximum);
        },
      };
      const service = new QuestionInboxService(dependencies);
      await service.pollOnce();
      await service.pollOnce();
      const published = await h.read();
      expect(parseQuestionInbox(published).completed).toEqual([ID]);
      expect(Buffer.byteLength(published)).toBeGreaterThan(900 * 1024);
      expect(Buffer.byteLength(published)).toBeLessThanOrEqual(1024 * 1024);
      const restarted = new QuestionInboxService(dependencies);
      await restarted.pollOnce();
      await restarted.pollOnce();
      await restarted.pollOnce();
      expect(h.calls).toEqual([ID]);
      expect(await h.read()).toBe(published);
      expect(h.repositories.managedNotes.conflicts(target.stableId)).toEqual([]);
    }));
  it('rotates bounded course and question batches so failures cannot starve later work', () =>
    run(async (h) => {
      const ids = Array.from({ length: 9 }, (_, n) => `q_${String(n).padStart(32, '0')}`);
      await h.edit(
        base.replace(
          '\n<!-- study-assistant:user:end',
          `\n${ids.map((id) => `- [ ] \`${id}\` 질문: why?`).join('\n')}\n<!-- study-assistant:user:end`,
        ),
      );
      const missing = Array.from({ length: 32 }, (_, n) => ({
        ...target,
        stableId: `missing_${n}`,
        relativePath: `missing${n}.md`,
      }));
      const service = new QuestionInboxService({
        ...h.dependencies,
        targets: async () => [...missing, target],
        answer: async (input) => {
          h.calls.push(input.question.id);
          if (input.question.id !== ids[8]) throw new Error('offline');
          return result(answer);
        },
      });
      for (let n = 0; n < 8; n++) await service.pollOnce();
      expect(h.calls).toContain(ids[8]);
      expect(await h.read()).toContain(`질문 ID: \`${ids[8]}\` · 상태: completed`);
    }));
  it('pins publication to the observed hash even if the note changes just before managed publication', () =>
    run(async (h) => {
      const content = base.replace(
        '\n<!-- study-assistant:user:end',
        `\n- [ ] \`${ID}\` 질문: first\n<!-- study-assistant:user:end`,
      );
      await h.edit(content);
      await h.service.pollOnce();
      const real = ManagedNoteService.prototype.publish;
      const spy = vi
        .spyOn(ManagedNoteService.prototype, 'publish')
        .mockImplementationOnce(async function (this: ManagedNoteService, input) {
          await h.edit(content.replace('first', 'changed'));
          return real.call(this, input);
        });
      try {
        await h.service.pollOnce();
        expect(await h.read()).toBe(content.replace('first', 'changed'));
        expect(h.repositories.managedNotes.get(target.stableId)?.generatedBase).toBe(base);
      } finally {
        spy.mockRestore();
      }
    }));
  it('routes exactly two new IDs beside an answered ID and preserves the prior answer block', () =>
    run(async (h) => {
      const third = 'q_018f47f2d4d77f83b513f00a12345670';
      await h.edit(
        base.replace(
          '\n<!-- study-assistant:user:end',
          `\n- [ ] \`${ID}\` 질문: first\n<!-- study-assistant:user:end`,
        ),
      );
      await h.service.pollOnce();
      await h.service.pollOnce();
      const answered = await h.read();
      const priorBlock = answered.match(
        /<!-- study-assistant:generated:start section="answer_[\s\S]*?<!-- study-assistant:generated:end -->/,
      )?.[0];
      await h.edit(
        answered.replace(
          '<!-- study-assistant:user:end -->',
          `- [ ] \`${SECOND}\` 질문: second\n- [ ] \`${third}\` 질문: third\n<!-- study-assistant:user:end -->`,
        ),
      );
      const restarted = new QuestionInboxService(h.dependencies);
      await restarted.pollOnce();
      expect(h.calls).toEqual([ID]);
      await restarted.pollOnce();
      expect(h.calls).toEqual([ID, SECOND, third]);
      expect(await h.read()).toContain(priorBlock);
    }));
  it('resets stability when a synchronized question changes', () =>
    run(async (h) => {
      const content = base.replace(
        '\n<!-- study-assistant:user:end',
        `\n- [ ] \`${ID}\` 질문: first\n<!-- study-assistant:user:end`,
      );
      await h.edit(content);
      await h.service.pollOnce();
      await h.edit(content.replace('first', 'second'));
      await h.service.pollOnce();
      expect(h.calls).toEqual([]);
      await h.service.pollOnce();
      expect(h.calls).toEqual([ID]);
    }));
  it('never dispatches after an ID insertion CAS conflict', () =>
    run(async (h) => {
      const content = base.replace(
        '\n<!-- study-assistant:user:end',
        '\n- [ ] 질문: first\n<!-- study-assistant:user:end',
      );
      await h.edit(content);
      await h.service.pollOnce();
      const real = h.writer.writeMarkdown.bind(h.writer);
      const spy = vi.spyOn(h.writer, 'writeMarkdown').mockImplementationOnce(async (input) => {
        await real({ ...input, content: content.replace('first', 'changed') });
        return real(input);
      });
      try {
        await h.service.pollOnce();
        await h.service.pollOnce();
        expect(h.calls).toEqual([]);
        expect(await h.read()).toContain('질문: changed');
      } finally {
        spy.mockRestore();
      }
    }));
  it('preserves a raced user edit during answer publication without accepting completion', () =>
    run(async (h) => {
      const content = base.replace(
        '\n<!-- study-assistant:user:end',
        `\n- [ ] \`${ID}\` 질문: first\n<!-- study-assistant:user:end`,
      );
      await h.edit(content);
      await h.service.pollOnce();
      const real = h.writer.writeMarkdown.bind(h.writer);
      const spy = vi.spyOn(h.writer, 'writeMarkdown').mockImplementationOnce(async (input) => {
        await real({
          relativePath: 'inbox.md',
          content: content.replace('first', 'changed'),
          expectedBaseHash: (await h.writer.readMarkdown('inbox.md'))?.sha256 ?? null,
        });
        return real(input);
      });
      try {
        await h.service.pollOnce();
        expect(await h.read()).toBe(content.replace('first', 'changed'));
        expect(h.repositories.managedNotes.get(target.stableId)?.generatedBase).toBe(base);
        expect(h.repositories.managedNotes.conflicts(target.stableId)).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    }));
  it('isolates malformed course A while course B and later questions keep processing', () =>
    run(async (h) => {
      const other = { ...target, stableId: 'inbox_b', relativePath: 'other.md' };
      await new ManagedNoteService(h.repositories.managedNotes, h.writer).publish({
        stableId: other.stableId,
        relativePath: other.relativePath,
        content: base,
        generationRevision: 'r1',
      });
      const content = base.replace(
        '\n<!-- study-assistant:user:end',
        `\n- [ ] \`${ID}\` 질문: first\n- [ ] \`${SECOND}\` 질문: second\n<!-- study-assistant:user:end`,
      );
      await h.edit(base.replace('user:end', 'user:BAD'));
      await h.writer.writeMarkdown({
        relativePath: other.relativePath,
        content,
        expectedBaseHash: (await h.writer.readMarkdown(other.relativePath))?.sha256 ?? null,
      });
      const service = new QuestionInboxService({
        ...h.dependencies,
        targets: async () => [target, other],
        answer: async (input) => {
          h.calls.push(input.question.id);
          if (input.question.id === ID) throw new Error('offline');
          return result(answer);
        },
      });
      await service.pollOnce();
      await service.pollOnce();
      expect(h.calls).toEqual([ID, SECOND]);
      expect((await h.writer.readMarkdown(other.relativePath))?.content).toContain(
        `질문 ID: \`${SECOND}\` · 상태: completed`,
      );
      expect(await h.read()).toBe(base.replace('user:end', 'user:BAD'));
    }));
  it('does not publish after cancellation or a note edit during provider execution', () =>
    run(async (h) => {
      const content = base.replace(
        '\n<!-- study-assistant:user:end',
        `\n- [ ] \`${ID}\` 질문: first\n<!-- study-assistant:user:end`,
      );
      await h.edit(content);
      const controller = new AbortController();
      const service = new QuestionInboxService({
        ...h.dependencies,
        answer: async () => {
          controller.abort();
          return result(answer);
        },
      });
      await service.pollOnce(controller.signal);
      await service.pollOnce(controller.signal);
      expect(await h.read()).toBe(withQuestionCount(content, 1));
      const changed = new QuestionInboxService({
        ...h.dependencies,
        answer: async () => {
          await h.edit(content.replace('first', 'changed'));
          return result(answer);
        },
      });
      await changed.pollOnce();
      await changed.pollOnce();
      expect(await h.read()).toBe(content.replace('first', 'changed'));
      expect(h.repositories.managedNotes.get(target.stableId)?.generatedBase).toBe(
        withQuestionCount(base, 1),
      );
    }));
  it('requires stability, appends cited answers, preserves bytes and skips completion across restart', () =>
    run(async (h) => {
      const user = `\r\n메모 그대로  \r\n- [ ] \`${ID}\` 질문: 왜 O(1)?\r\n`;
      await h.edit(
        base.replace('\n<!-- study-assistant:user:end', `${user}<!-- study-assistant:user:end`),
      );
      await h.service.pollOnce();
      expect(h.calls).toEqual([]);
      await h.service.pollOnce();
      const content = await h.read();
      expect(content).toContain(user);
      expect(content).toContain('[[AI 학습/과목/자료구조/원본자료/a.pdf|원본]]');
      expect(content).toContain(`질문 ID: \`${ID}\` · 상태: completed`);
      const restarted = new QuestionInboxService(h.dependencies);
      await restarted.pollOnce();
      await restarted.pollOnce();
      expect(h.calls).toEqual([ID]);
      expect(await h.read()).toBe(content);
    }));
  it('persists missing IDs before any dispatch and reobserves two polls', () =>
    run(async (h) => {
      const content = base.replace(
        '\n<!-- study-assistant:user:end',
        '\r\n- [ ] 질문: 왜?  \r\n<!-- study-assistant:user:end',
      );
      await h.edit(content);
      await h.service.pollOnce();
      await h.service.pollOnce();
      expect(h.calls).toEqual([]);
      expect(await h.read()).toBe(
        withQuestionCount(content.replace('- [ ] 질문:', `- [ ] \`${SECOND}\` 질문:`), 1),
      );
      await h.service.pollOnce();
      expect(h.calls).toEqual([]);
      await h.service.pollOnce();
      expect(h.calls).toEqual([SECOND]);
    }));
  it('isolates provider failure and retries while updating only the pending count', () =>
    run(async (h) => {
      const content = base.replace(
        '\n<!-- study-assistant:user:end',
        `\n- [ ] \`${ID}\` 질문: 왜?\n<!-- study-assistant:user:end`,
      );
      await h.edit(content);
      h.fail(true);
      await h.service.pollOnce();
      await h.service.pollOnce();
      expect(await h.read()).toBe(withQuestionCount(content, 1));
      h.fail(false);
      await h.service.pollOnce();
      expect(await h.read()).toContain('상태: completed');
    }));
  it('rejects unoffered citations and malformed notes', () =>
    run(async (h) => {
      const content = base.replace(
        '\n<!-- study-assistant:user:end',
        `\n- [ ] \`${ID}\` 질문: 왜?\n<!-- study-assistant:user:end`,
      );
      await h.edit(content);
      h.response({ ...answer, evidenceIds: ['018f47f2-d4d7-7f83-b513-f00a12345679'] });
      await h.service.pollOnce();
      await h.service.pollOnce();
      expect(await h.read()).toBe(withQuestionCount(content, 1));
      await h.edit(content.replace(ID, 'q_BAD'));
      await h.service.pollOnce();
      await h.service.pollOnce();
      expect(h.calls).toEqual([ID]);
    }));
  it('does not dispatch after cancellation or without evidence', () =>
    run(async (h) => {
      await h.edit(
        base.replace(
          '\n<!-- study-assistant:user:end',
          `\n- [ ] \`${ID}\` 질문: 왜?\n<!-- study-assistant:user:end`,
        ),
      );
      const empty = new QuestionInboxService({ ...h.dependencies, evidence: async () => [] });
      await empty.pollOnce();
      await empty.pollOnce();
      await h.service.pollOnce(AbortSignal.abort());
      expect(h.calls).toEqual([]);
    }));
});
