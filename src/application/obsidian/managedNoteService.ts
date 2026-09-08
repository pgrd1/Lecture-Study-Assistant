import { randomUUID } from 'node:crypto';
import type { ManagedNoteRevisionRepository } from '../../core/ports/managedNoteRevisionRepository';
import type { MarkdownReadResult, VaultWriterPort, WriteResult } from '../../core/ports/vault';
import {
  type ManagedNoteConflictReason,
  type ManagedNoteDecision,
  ManagedNotePathSchema,
  type ManagedNotePublication,
  type ManagedNoteRevision,
  ManagedNoteTimestampSchema,
  managedMarkdownHash,
  parseManagedNoteConflict,
  parseManagedNotePublication,
  parseManagedNoteRevision,
} from '../../shared/contracts/managedNoteRevision';
import { workspacePathKey } from '../../shared/contracts/obsidianWorkspace';
import { threeWayMarkdownMerge } from './threeWayMarkdownMerge';

type PublicationContext = Readonly<{
  input: ManagedNotePublication;
  head: ManagedNoteRevision | null;
  path: string;
  timestamp: string;
}>;

// VaultWriter may add `.conflict-YYYYMMDD-HHMMSS-99` before the extension.
// Reserve its 28 UTF-16 units in both the segment and total relative-path limit.
const CONFLICT_COLLISION_RESERVE = 28;
const conflictCandidatePath = (context: PublicationContext): string => {
  const slash = context.path.lastIndexOf('/');
  let directory = context.path.slice(0, slash + 1);
  const identity = managedMarkdownHash(
    [context.input.stableId, context.path, context.input.generationRevision].join('\n'),
  ).slice(0, 12);
  const revision = context.input.generationRevision.slice(0, 16);
  const suffix = `-AI-충돌-${context.timestamp.replace(/[-:.]/gu, '')}-${revision}-${identity}.md`;
  const pathBudget = 1_024 - CONFLICT_COLLISION_RESERVE;
  // A near-limit directory may have no room even for a shortened filename.
  // Keep the nearest fitting ancestor; the audit retains the original full path.
  while (directory.length + suffix.length + 2 > pathBudget) {
    const parent = directory.slice(0, -1);
    directory = parent.slice(0, parent.lastIndexOf('/') + 1);
  }
  const stemBudget = Math.min(
    40,
    180 - CONFLICT_COLLISION_RESERVE - suffix.length,
    pathBudget - directory.length - suffix.length,
  );
  const originalStem = context.path.slice(slash + 1, -3) || 'note';
  // Slice by UTF-16 units as VaultWriter does, without leaving a lone surrogate.
  const stem = originalStem.slice(0, stemBudget).replace(/[\uD800-\uDBFF]$/u, '');
  return ManagedNotePathSchema.parse(`${directory}${stem}${suffix}`);
};

/** Files precede SQLite acceptance. A failed/stale commit leaves the previous
 * base authoritative: the next attempt conflicts rather than guessing ownership
 * of uncommitted file bytes. Writer recovery artifacts are never deleted here. */
export class ManagedNoteService {
  constructor(
    private readonly repository: ManagedNoteRevisionRepository,
    private readonly writer: VaultWriterPort,
    private readonly clock: () => Date = () => new Date(),
    private readonly idGenerator: () => string = randomUUID,
  ) {}

  async publish(value: unknown): Promise<ManagedNoteDecision> {
    const input = parseManagedNotePublication(value);
    const head = this.repository.get(input.stableId);
    const path = head?.relativePath ?? input.relativePath;
    const context = Object.freeze({
      input,
      head,
      path,
      timestamp: ManagedNoteTimestampSchema.parse(this.clock().toISOString()),
    });
    const current = await this.writer.readMarkdown(path);
    if (current && !this.#matchesRead(current, path))
      return this.#conflict(context, 'unexpected_current');
    const owner = this.repository.findByPath(path);
    if (owner && owner.stableId !== input.stableId) return this.#conflict(context, 'path_owned');
    if (!head) {
      if (current) return this.#conflict(context, 'untracked_path');
      const grammar = threeWayMarkdownMerge({
        base: input.content,
        current: input.content,
        candidate: input.content,
      });
      if (grammar.kind === 'conflict') return this.#conflict(context, grammar.reason);
      return this.#write(context, input.content, null);
    }
    if (!current) return this.#conflict(context, 'missing_current');
    const merge = threeWayMarkdownMerge({
      base: head.generatedBase,
      current: current.content,
      candidate: input.content,
    });
    if (merge.kind === 'conflict') return this.#conflict(context, merge.reason);
    if (merge.kind === 'write') return this.#write(context, merge.mergedContent, current.sha256);
    const confirmed = await this.writer.readMarkdown(path);
    if (!confirmed || !this.#matchesRead(confirmed, path) || confirmed.sha256 !== current.sha256)
      return this.#conflict(context, 'unexpected_current');
    return this.#accept(context, 'unchanged', current.sha256);
  }

  #matchesRead(current: MarkdownReadResult, path: string): boolean {
    return current.relativePath === path && current.sha256 === managedMarkdownHash(current.content);
  }

  async #write(
    context: PublicationContext,
    content: string,
    expectedBaseHash: string | null,
  ): Promise<ManagedNoteDecision> {
    const result = await this.writer.writeMarkdown({
      relativePath: context.path,
      content,
      expectedBaseHash,
    });
    if (result.kind === 'conflict') return this.#audit(context, result, 'writer_conflict');
    if (result.relativePath !== context.path || result.sha256 !== managedMarkdownHash(content))
      throw new TypeError('INVALID_MANAGED_PUBLICATION_RESULT');
    return this.#accept(context, 'written', result.sha256);
  }

  #accept(
    context: PublicationContext,
    kind: 'written' | 'unchanged',
    sha256: string,
  ): ManagedNoteDecision {
    const { input, head, path, timestamp } = context;
    this.repository.append(
      parseManagedNoteRevision({
        stableId: input.stableId,
        relativePath: path,
        pathKey: workspacePathKey(path),
        generatedBase: input.content,
        generatedBaseHash: managedMarkdownHash(input.content),
        publishedHash: sha256,
        generationRevision: input.generationRevision,
        revision: head === null ? 0 : head.revision + 1,
        decision: kind,
        createdAt: head?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }),
      head?.revision ?? null,
    );
    return Object.freeze({ kind, sha256 });
  }

  async #conflict(
    context: PublicationContext,
    reason: ManagedNoteConflictReason,
  ): Promise<ManagedNoteDecision> {
    const relativePath = conflictCandidatePath(context);
    const result = await this.writer.writeMarkdown({
      relativePath,
      content: context.input.content,
      expectedBaseHash: null,
    });
    return this.#audit(context, result, reason);
  }

  async #audit(
    context: PublicationContext,
    result: WriteResult,
    reason: ManagedNoteConflictReason,
  ): Promise<ManagedNoteDecision> {
    const current = await this.writer.readMarkdown(context.path);
    if (current && !this.#matchesRead(current, context.path))
      throw new TypeError('INVALID_MANAGED_CURRENT_READ');
    this.repository.recordConflict(
      parseManagedNoteConflict({
        id: this.idGenerator(),
        stableId: context.input.stableId,
        originalPath: context.path,
        currentPath: context.path,
        candidatePath: result.relativePath,
        currentHash: current?.sha256 ?? null,
        candidateHash: result.sha256,
        generationRevision: context.input.generationRevision,
        reason,
        createdAt: context.timestamp,
      }),
      context.head?.revision ?? null,
    );
    return Object.freeze({
      kind: 'conflict_preserved',
      currentPath: context.path,
      candidatePath: result.relativePath,
    });
  }
}
