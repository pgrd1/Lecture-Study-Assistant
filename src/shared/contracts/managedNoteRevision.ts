import { createHash } from 'node:crypto';
import { z } from 'zod';
import { VaultRelativePathSchema, workspacePathKey } from './obsidianWorkspace';

export const MANAGED_MARKDOWN_MAX_BYTES = 16 * 1024 * 1024;
export const ManagedNoteIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/u);
export const GenerationRevisionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u);
export const ManagedNotePathSchema = VaultRelativePathSchema.refine(
  (path) => path.endsWith('.md') && path === path.normalize('NFC'),
);
export const ManagedNoteHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const ManagedMarkdownContentSchema = z
  .string()
  .max(MANAGED_MARKDOWN_MAX_BYTES)
  .refine(
    (text) =>
      !text.includes('\0') &&
      !/\p{Cs}/u.test(text) &&
      Buffer.byteLength(text, 'utf8') <= MANAGED_MARKDOWN_MAX_BYTES,
  );
export const ManagedNoteTimestampSchema = z.iso
  .datetime({ precision: 3 })
  .refine((value) => /^\d{4}-/u.test(value) && new Date(value).toISOString() === value);
const RevisionNumber = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// These contracts are deliberately flat. Inspect descriptors before any schema
// reads a field; bound each string independently (three merge inputs can be 48 MiB).
const PlainRecord = z.unknown().superRefine((value, context) => {
  const invalid = (): void =>
    context.addIssue({ code: 'custom', message: 'INVALID_MANAGED_NOTE_DATA' });
  if (
    value === null ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 24) return invalid();
  for (const key of keys) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
      return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
    const item: unknown = descriptor.value;
    if (typeof item === 'string') {
      if (
        item.length > MANAGED_MARKDOWN_MAX_BYTES ||
        Buffer.byteLength(item, 'utf8') > MANAGED_MARKDOWN_MAX_BYTES
      )
        return invalid();
    } else if (
      item !== null &&
      typeof item !== 'boolean' &&
      !(typeof item === 'number' && Number.isFinite(item))
    )
      return invalid();
  }
});
export const guardManagedNoteRecord = <T extends z.ZodType>(schema: T) => PlainRecord.pipe(schema);
export const managedMarkdownHash = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

export const ManagedNotePublicationSchema = guardManagedNoteRecord(
  z
    .strictObject({
      stableId: ManagedNoteIdSchema,
      relativePath: ManagedNotePathSchema,
      content: ManagedMarkdownContentSchema,
      generationRevision: GenerationRevisionSchema,
    })
    .readonly(),
);
export type ManagedNotePublication = z.infer<typeof ManagedNotePublicationSchema>;
export const parseManagedNotePublication = (value: unknown): ManagedNotePublication =>
  ManagedNotePublicationSchema.parse(value);

export const ManagedNoteRevisionSchema = guardManagedNoteRecord(
  z
    .strictObject({
      stableId: ManagedNoteIdSchema,
      relativePath: ManagedNotePathSchema,
      pathKey: z.string().min(1).max(1_024),
      generatedBase: ManagedMarkdownContentSchema,
      generatedBaseHash: ManagedNoteHashSchema,
      publishedHash: ManagedNoteHashSchema,
      generationRevision: GenerationRevisionSchema,
      revision: RevisionNumber,
      decision: z.enum(['written', 'unchanged']),
      createdAt: ManagedNoteTimestampSchema,
      updatedAt: ManagedNoteTimestampSchema,
    })
    .refine(
      (value) =>
        value.pathKey === workspacePathKey(value.relativePath) &&
        value.generatedBaseHash === managedMarkdownHash(value.generatedBase) &&
        value.updatedAt >= value.createdAt,
    )
    .readonly(),
);
export type ManagedNoteRevision = z.infer<typeof ManagedNoteRevisionSchema>;
export const parseManagedNoteRevision = (value: unknown): ManagedNoteRevision =>
  ManagedNoteRevisionSchema.parse(value);

export const ManagedNoteConflictReasonSchema = z.enum([
  'malformed_markers',
  'managed_content_changed',
  'locked',
  'missing_current',
  'untracked_path',
  'path_owned',
  'unexpected_current',
  'writer_conflict',
]);
export type ManagedNoteConflictReason = z.infer<typeof ManagedNoteConflictReasonSchema>;
export const ManagedNoteConflictSchema = guardManagedNoteRecord(
  z
    .strictObject({
      id: z.uuid().refine((value) => value === value.toLowerCase()),
      stableId: ManagedNoteIdSchema,
      originalPath: ManagedNotePathSchema,
      currentPath: ManagedNotePathSchema,
      candidatePath: ManagedNotePathSchema,
      currentHash: ManagedNoteHashSchema.nullable(),
      candidateHash: ManagedNoteHashSchema,
      generationRevision: GenerationRevisionSchema,
      reason: ManagedNoteConflictReasonSchema,
      createdAt: ManagedNoteTimestampSchema,
    })
    .refine(
      (value) => workspacePathKey(value.currentPath) !== workspacePathKey(value.candidatePath),
    )
    .readonly(),
);
export type ManagedNoteConflict = z.infer<typeof ManagedNoteConflictSchema>;
export const parseManagedNoteConflict = (value: unknown): ManagedNoteConflict =>
  ManagedNoteConflictSchema.parse(value);

export type ManagedNoteDecision =
  | Readonly<{ kind: 'unchanged'; sha256: string }>
  | Readonly<{ kind: 'written'; sha256: string }>
  | Readonly<{ kind: 'conflict_preserved'; currentPath: string; candidatePath: string }>;
