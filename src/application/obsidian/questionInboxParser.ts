import { QuestionIdSchema } from '../../shared/contracts/questionInbox';
import { threeWayMarkdownMerge } from './threeWayMarkdownMerge';

export const INBOX_USER_START = '<!-- study-assistant:user:start -->';
export const QUESTION_INBOX_LIMITS = Object.freeze({
  bytes: 1024 * 1024,
  sections: 100,
  // 8 KiB prose × at most 5 for escaping + 32 citations ×
  // (3 × (1024 path + 500 alias) + 64 syntax bytes) + 8 KiB metadata
  // is 197,504 bytes. 256 KiB reserves every schema-valid answer block.
  answerBytes: 256 * 1024,
});
const USER_END = '<!-- study-assistant:user:end -->';
export type InboxQuestion = Readonly<{ id: string | null; text: string; insertionOffset: number }>;
const invalid = () => new TypeError('INVALID_QUESTION_INBOX');

/** Offsets address the original string. No line endings or user whitespace are rewritten. */
export const parseQuestionInbox = (content: string) => {
  if (
    Buffer.byteLength(content) > QUESTION_INBOX_LIMITS.bytes ||
    /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(content) ||
    /[\p{Cc}]/u.test(content.replace(/[\r\n\t]/gu, ''))
  )
    throw invalid();
  if (
    threeWayMarkdownMerge({ base: content, current: content, candidate: content }).kind ===
    'conflict'
  )
    throw invalid();
  const start = content.indexOf(INBOX_USER_START) + INBOX_USER_START.length;
  const user = content.slice(start, content.indexOf(USER_END));
  const lines = [...user.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)];
  if (lines.length > 2000) throw invalid();
  const questions: InboxQuestion[] = [];
  const ids = new Set<string>();
  let unidentified = 0;
  for (const line of lines) {
    const raw = line[0].replace(/[\r\n]+$/u, '');
    if (!/^\s*- \[[ xX]\]/u.test(raw) || !/(?:질문:|`q_)/u.test(raw)) continue;
    const match = /^- \[([ xX])\] (?:`(q_[a-f0-9]{32})` )?질문: (.+)$/u.exec(raw);
    if (!match?.[3]?.trim() || Buffer.byteLength(raw) > 8192 || match[3].length > 4096)
      throw invalid();
    const id = match[2] ?? null;
    if (id && ids.has(id)) throw invalid();
    if (id) ids.add(id);
    else unidentified++;
    if (match[1] !== ' ') continue;
    questions.push(Object.freeze({ id, text: match[3], insertionOffset: start + line.index + 6 }));
    if (questions.length > 64) throw invalid();
  }
  const completed = [
    ...content
      .slice(0, start - INBOX_USER_START.length)
      .matchAll(
        /<!-- study-assistant:generated:start section="answer_(q_[a-f0-9]{32})" revision="[A-Za-z0-9_-]+" -->\n([\s\S]*?)\n<!-- study-assistant:generated:end -->/gu,
      ),
  ].map((match) => {
    if (
      !match[1] ||
      !match[2]?.startsWith(`질문 ID: \`${match[1]}\` · 상태: completed\n`) ||
      !/근거: `[a-f0-9-]{36}`/u.test(match[2])
    )
      throw invalid();
    return match[1];
  });
  return Object.freeze({
    questions: Object.freeze(questions),
    completed: Object.freeze(completed),
    // Total recorded history: each ID once, including checked lines and answers
    // whose original user line was removed; each unidentified line counts once.
    questionCount: new Set([...ids, ...completed]).size + unidentified,
    user,
    generatedSectionCount: [...content.matchAll(/<!-- study-assistant:generated:start /gu)].length,
  });
};

/** Update only the managed scalar; all other bytes, including answer blocks, stay exact. */
export const withQuestionCount = (content: string, count: number): string => {
  if (!Number.isSafeInteger(count) || count < 0 || count > 4096) throw invalid();
  parseQuestionInbox(content);
  const end = content.indexOf('\n---\n', 4);
  const prefix = content.slice(0, end);
  const property = /^(?:"question_count"|question_count):[^\n]*$/gmu;
  if ([...prefix.matchAll(property)].length > 1) throw invalid();
  const line = `"question_count": ${count}`;
  const next = property.test(prefix) ? prefix.replace(property, line) : `${prefix}\n${line}`;
  const result = `${next}${content.slice(end)}`;
  parseQuestionInbox(result);
  return result;
};

export const assignQuestionIds = (content: string, generate: () => string): string => {
  const parsed = parseQuestionInbox(content);
  const used = new Set([
    ...parsed.questions.flatMap((q) => (q.id ? [q.id] : [])),
    ...parsed.completed,
  ]);
  let result = content;
  for (const question of [...parsed.questions].reverse()) {
    if (question.id !== null) continue;
    const id = QuestionIdSchema.parse(generate());
    if (used.has(id)) throw invalid();
    used.add(id);
    result = `${result.slice(0, question.insertionOffset)}\`${id}\` ${result.slice(question.insertionOffset)}`;
  }
  parseQuestionInbox(result);
  return result;
};
