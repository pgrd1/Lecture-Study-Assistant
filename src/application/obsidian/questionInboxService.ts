import { randomUUID } from 'node:crypto';
import type { ManagedNoteRevisionRepository } from '../../core/ports/managedNoteRevisionRepository';
import type { VaultWriterPort } from '../../core/ports/vault';
import { managedMarkdownHash } from '../../shared/contracts/managedNoteRevision';
import {
  QuestionAnswerResultSchema,
  type QuestionEvidence,
  QuestionEvidenceListSchema,
  type QuestionInboxTarget,
} from '../../shared/contracts/questionInbox';
import { assertNoInstructionEcho } from '../prompts/instructionEchoGuard';
import { ManagedNoteService } from './managedNoteService';
import { renderCallout } from './markdownRenderer';
import { renderEvidenceCitations } from './obsidianLink';
import {
  assignQuestionIds,
  INBOX_USER_START,
  parseQuestionInbox,
  QUESTION_INBOX_LIMITS,
  withQuestionCount,
} from './questionInboxParser';
import { threeWayMarkdownMerge } from './threeWayMarkdownMerge';
import { runWorkspaceExclusive } from './workspaceSerialQueue';

export type InboxAnswerInput = Readonly<{
  target: QuestionInboxTarget;
  question: Readonly<{ id: string; text: string }>;
  evidence: readonly QuestionEvidence[];
  signal: AbortSignal;
}>;
type Dependencies = Readonly<{
  workspaceRoot: string;
  writer: VaultWriterPort;
  revisions: ManagedNoteRevisionRepository;
  targets(): Promise<readonly QuestionInboxTarget[]>;
  evidence(target: QuestionInboxTarget): Promise<readonly QuestionEvidence[]>;
  answer(input: InboxAnswerInput): Promise<unknown>;
  idGenerator?: () => string;
  assertCurrent?: () => void;
}>;
const prose = (value: string) =>
  value.replaceAll('&', '&amp;').replace(/([\\`*_[\]{}()#+.!|~])/gu, '\\$1');
// Reserve the entire bounded rendered block, including its markers, citations,
// provenance and separators. The preserved user bytes are part of this budget.
const hasAnswerCapacity = (content: string) =>
  parseQuestionInbox(content).generatedSectionCount < QUESTION_INBOX_LIMITS.sections &&
  Buffer.byteLength(content) + QUESTION_INBOX_LIMITS.answerBytes <= QUESTION_INBOX_LIMITS.bytes;

/** Each instance observes stability; accepted generated bases hold completion across restart. */
export class QuestionInboxService {
  #observed = new Map<string, string>();
  #running = false;
  #courseOffset = 0;
  #questionOffsets = new Map<string, number>();
  constructor(private readonly dependencies: Dependencies) {}

  async pollOnce(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.#running || signal.aborted) return;
    this.#running = true;
    try {
      await runWorkspaceExclusive(
        this.dependencies.workspaceRoot,
        () => this.#poll(signal),
        signal,
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      this.#running = false;
    }
  }

  async #poll(signal: AbortSignal) {
    const targets = await this.dependencies.targets();
    const active = new Set(targets.map((target) => target.stableId));
    this.#observed = new Map([...this.#observed].filter(([id]) => active.has(id)));
    this.#questionOffsets = new Map([...this.#questionOffsets].filter(([id]) => active.has(id)));
    const offset = this.#courseOffset % Math.max(1, targets.length);
    const batch = [...targets.slice(offset), ...targets.slice(0, offset)].slice(0, 32);
    this.#courseOffset = offset + batch.length;
    for (const target of batch) {
      if (signal.aborted) break;
      try {
        await this.#pollTarget(target, signal);
      } catch {
        this.#observed.delete(target.stableId);
      }
    }
  }

  async #pollTarget(target: QuestionInboxTarget, signal: AbortSignal) {
    const { writer, revisions } = this.dependencies;
    this.dependencies.assertCurrent?.();
    let current = await writer.readMarkdown(target.relativePath);
    const head = revisions.get(target.stableId);
    if (!current || !head || head.relativePath !== target.relativePath) {
      this.#observed.delete(target.stableId);
      return;
    }
    const parsed = parseQuestionInbox(current.content);
    const base = parseQuestionInbox(head.generatedBase);
    if (
      threeWayMarkdownMerge({
        base: head.generatedBase,
        current: current.content,
        candidate: head.generatedBase,
      }).kind === 'conflict'
    )
      throw new TypeError('QUESTION_INBOX_CONFLICT');
    const stable = this.#observed.get(target.stableId) === current.sha256;
    this.#observed.set(target.stableId, current.sha256);
    if (!stable) return;
    const counted = withQuestionCount(head.generatedBase, parsed.questionCount);
    if (counted !== head.generatedBase) {
      const result = await new ManagedNoteService(
        revisions,
        this.#pinnedWriter(target.relativePath, current.sha256, signal),
      ).publish({
        stableId: target.stableId,
        relativePath: target.relativePath,
        content: counted,
        generationRevision: managedMarkdownHash(counted),
      });
      if (result.kind === 'conflict_preserved') return;
      current = await writer.readMarkdown(target.relativePath);
      if (current?.sha256 !== result.sha256) return;
      this.#observed.set(target.stableId, current.sha256);
    }
    if (parsed.questions.some((q) => q.id === null)) {
      const content = assignQuestionIds(
        current.content,
        this.dependencies.idGenerator ?? (() => `q_${randomUUID().replaceAll('-', '')}`),
      );
      this.dependencies.assertCurrent?.();
      if (signal.aborted) return;
      await writer.writeMarkdown({
        relativePath: target.relativePath,
        content,
        expectedBaseHash: current.sha256,
      });
      this.#observed.delete(target.stableId);
      return;
    }
    const evidence = QuestionEvidenceListSchema.parse(await this.dependencies.evidence(target));
    if (evidence.length === 0) return;
    let expectedHash = current.sha256;
    const pending = parsed.questions.filter((q) => q.id && !base.completed.includes(q.id));
    const offset = (this.#questionOffsets.get(target.stableId) ?? 0) % Math.max(1, pending.length);
    const batch = [...pending.slice(offset), ...pending.slice(0, offset)].slice(0, 8);
    this.#questionOffsets.set(target.stableId, offset + batch.length);
    for (const question of batch) {
      if (signal.aborted) return;
      const before = await writer.readMarkdown(target.relativePath);
      if (before?.sha256 !== expectedHash) {
        this.#observed.delete(target.stableId);
        return;
      }
      const beforeHead = revisions.get(target.stableId);
      if (
        !beforeHead ||
        !hasAnswerCapacity(before.content) ||
        !hasAnswerCapacity(beforeHead.generatedBase)
      )
        return;
      this.dependencies.assertCurrent?.();
      try {
        const id = question.id as string;
        const { output, provenance } = QuestionAnswerResultSchema.parse(
          await this.dependencies.answer({
            target,
            question: { id, text: question.text },
            evidence,
            signal,
          }),
        );
        assertNoInstructionEcho({ output, provenance }, [target.userInstructions]);
        if (
          output.evidenceIds.some(
            (evidenceId) => !evidence.some((item) => item.evidenceId === evidenceId),
          )
        )
          throw new TypeError('UNSUPPORTED_QUESTION_CITATION');
        if (signal.aborted) return;
        this.dependencies.assertCurrent?.();
        const after = await writer.readMarkdown(target.relativePath);
        if (after?.sha256 !== expectedHash) {
          this.#observed.delete(target.stableId);
          return;
        }
        const latest = revisions.get(target.stableId);
        if (!latest || parseQuestionInbox(latest.generatedBase).completed.includes(id)) return;
        const citations = renderEvidenceCitations(
          output.evidenceIds.map((evidenceId) => {
            const item = evidence.find(
              (entry) => entry.evidenceId === evidenceId,
            ) as QuestionEvidence;
            return { evidenceId, relativePath: item.relativePath, label: item.label };
          }),
        );
        const metadata = `모델: ${prose(provenance.modelId)} · 프롬프트: ${provenance.promptVersion}\n생성: ${provenance.completedAt} · 요청: ${provenance.requestId}\n프롬프트 해시: ${provenance.promptSha256}`;
        const body = [
          `질문 ID: \`${id}\` · 상태: completed`,
          renderCallout({
            type: 'summary',
            title: 'AI 답변',
            body: [output.answer, ...output.steps, output.example, output.uncertainty]
              .filter(Boolean)
              .map(prose)
              .join('\n\n'),
          }),
          citations,
          metadata,
        ].join('\n\n');
        const revision = managedMarkdownHash(body);
        const block = `<!-- study-assistant:generated:start section="answer_${id}" revision="${revision}" -->\n${body}\n<!-- study-assistant:generated:end -->\n\n`;
        if (Buffer.byteLength(block) > QUESTION_INBOX_LIMITS.answerBytes)
          throw new TypeError('QUESTION_ANSWER_CAPACITY');
        const content = latest.generatedBase.replace(
          INBOX_USER_START,
          `${block}${INBOX_USER_START}`,
        );
        // Both the accepted base and the exact user-preserving publication must
        // remain valid parser inputs, including after an application restart.
        parseQuestionInbox(content);
        const merged = threeWayMarkdownMerge({
          base: latest.generatedBase,
          current: after.content,
          candidate: content,
        });
        if (merged.kind !== 'write') return;
        parseQuestionInbox(merged.mergedContent);
        // ManagedNoteService preserves user edits observed on its own read. The
        // question answer additionally requires the original observation to hold.
        const pinnedWriter = this.#pinnedWriter(target.relativePath, expectedHash, signal);
        const result = await new ManagedNoteService(revisions, pinnedWriter).publish({
          stableId: target.stableId,
          relativePath: target.relativePath,
          content,
          generationRevision: revision,
        });
        if (result.kind === 'conflict_preserved') {
          this.#observed.delete(target.stableId);
          return;
        }
        expectedHash = result.sha256;
      } catch {
        // A provider failure leaves the durable question pending; other IDs still run.
      }
    }
    this.#observed.set(target.stableId, expectedHash);
  }

  #pinnedWriter(relativePath: string, expectedHash: string, signal: AbortSignal): VaultWriterPort {
    return new Proxy(this.dependencies.writer, {
      get: (original, property) => {
        if (property === 'writeMarkdown')
          return (input: Parameters<VaultWriterPort['writeMarkdown']>[0]) => {
            this.dependencies.assertCurrent?.();
            if (signal.aborted) throw new TypeError('QUESTION_INBOX_CANCELLED');
            parseQuestionInbox(input.content);
            return original.writeMarkdown(
              input.relativePath === relativePath
                ? { ...input, expectedBaseHash: expectedHash }
                : input,
            );
          };
        const method = Reflect.get(original, property);
        return typeof method === 'function' ? method.bind(original) : method;
      },
    });
  }
}
