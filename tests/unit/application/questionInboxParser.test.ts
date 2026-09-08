import { describe, expect, it } from 'vitest';
import {
  assignQuestionIds,
  parseQuestionInbox,
  withQuestionCount,
} from '../../../src/application/obsidian/questionInboxParser';
import { QuestionAnswerSchema } from '../../../src/shared/contracts/questionInbox';

const ID = 'q_018f47f2d4d77f83b513f00a12345678';
const inbox = (user: string) =>
  `---\n"locked": false\n---\n\n<!-- study-assistant:generated:start section="intro" revision="r1" -->\n질문함\n<!-- study-assistant:generated:end -->\n\n<!-- study-assistant:user:start -->${user}<!-- study-assistant:user:end -->\n`;
describe('question inbox boundary', () => {
  it('counts checked, unidentified and historical answered questions as one distinct union', () => {
    const user = `\n- [x] \`${ID}\` 질문: checked\n- [ ] 질문: unnamed\n- [x] 질문: other\n`;
    const block = `<!-- study-assistant:generated:start section="answer_${ID}" revision="r1" -->\n질문 ID: \`${ID}\` · 상태: completed\n근거: \`018f47f2-d4d7-7f83-b513-f00a12345678\`\n<!-- study-assistant:generated:end -->\n\n`;
    const content = inbox(user).replace(
      '<!-- study-assistant:user:start -->',
      `${block}<!-- study-assistant:user:start -->`,
    );
    expect(parseQuestionInbox(content).questionCount).toBe(3);
    expect(parseQuestionInbox(content.replace(user, '\n')).questionCount).toBe(1);
    const updated = withQuestionCount(content, 3);
    expect(updated).toContain('"question_count": 3');
    expect(parseQuestionInbox(updated).user).toBe(user);
    expect(withQuestionCount(updated, 3)).toBe(updated);
    expect(() => withQuestionCount(content, -1)).toThrow();
  });
  it('bounds aggregate answer prose even when each individual field is valid', () => {
    const field = '가'.repeat(2600);
    expect(() =>
      QuestionAnswerSchema.parse({
        answer: field,
        steps: [field],
        example: field,
        uncertainty: '',
        evidenceIds: ['018f47f2-d4d7-7f83-b513-f00a12345678'],
      }),
    ).toThrow();
  });
  it('parses only exact question tasks in the protected region', () => {
    const parsed = parseQuestionInbox(inbox(`\n메모\n- [ ] 할 일\n- [ ] \`${ID}\` 질문: 왜?\n`));
    expect(parsed.questions.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: ID, text: '왜?' },
    ]);
  });
  it('inserts only missing IDs and preserves mixed line endings and whitespace', () => {
    const content = inbox('\r\n  메모  \r\n- [ ] 질문: 왜?  \r\n');
    expect(assignQuestionIds(content, () => ID)).toBe(
      content.replace('- [ ] 질문:', `- [ ] \`${ID}\` 질문:`),
    );
  });
  it.each([
    `\n- [ ] \`${ID}\` 질문: a\n- [ ] \`${ID}\` 질문: b\n`,
    '\n- [ ] `q_BAD` 질문: a\n',
    '\n- [ ] 질문: \n',
    '\n- [ ] 질문: a\u0000\n',
    `\n- [ ] 질문: ${'a'.repeat(4097)}\n`,
  ])('rejects ambiguous or unbounded input without normalization', (user) => {
    expect(() => parseQuestionInbox(inbox(user))).toThrow();
  });
  it('rejects malformed markers and duplicate generated sections', () => {
    expect(() => parseQuestionInbox(inbox('\n').replace('user:end', 'user:END'))).toThrow();
    expect(() =>
      parseQuestionInbox(inbox('\n').replace('질문함', '<!-- study-assistant:user:start -->')),
    ).toThrow();
  });
  it('rejects invalid and colliding generated identities', () => {
    expect(() => assignQuestionIds(inbox('\n- [ ] 질문: a\n'), () => 'bad')).toThrow();
    expect(() =>
      assignQuestionIds(inbox(`\n- [ ] \`${ID}\` 질문: a\n- [ ] 질문: b\n`), () => ID),
    ).toThrow();
  });
  it.each([
    'C:\\private\\key',
    '/home/user/secret',
    '<script>x</script>',
    `sk-${'1'.repeat(20)}`,
    'api_key=hidden',
    'hello\u0001',
  ])('rejects unsafe answer prose: %s', (answer) => {
    expect(() =>
      QuestionAnswerSchema.parse({
        answer,
        steps: [],
        example: '',
        uncertainty: '',
        evidenceIds: ['018f47f2-d4d7-7f83-b513-f00a12345678'],
      }),
    ).toThrow();
  });
});
