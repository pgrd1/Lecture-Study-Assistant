import { z } from 'zod';
import { assertBoundedPipelineJson } from '../../shared/contracts/boundedPipelineJson';
import { VaultRelativePathSchema } from '../../shared/contracts/obsidianWorkspace';
import { toVaultRelativePath } from './vaultReferencePath';

// Reject syntax instead of escaping targets: escaping could select a different file.
const Target = VaultRelativePathSchema.refine(
  (value) => !/[[\]#^]/u.test(value) && value.split('/').every((part) => part.trim() === part),
);
const Alias = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}|[\]\\#^<>]/u.test(value));

export const renderObsidianLink = (target: unknown, alias?: unknown): string => {
  const path = toVaultRelativePath(Target.parse(target));
  return alias === undefined ? `[[${path}]]` : `[[${path}|${Alias.parse(alias)}]]`;
};

export const renderObsidianEmbed = (target: unknown): string =>
  `![[${toVaultRelativePath(Target.parse(target))}]]`;

const Citation = z
  .strictObject({
    label: Alias,
    relativePath: Target,
    evidenceId: z.uuid().transform((value) => value.toLowerCase()),
  })
  .readonly();
const Citations = z
  .array(Citation)
  .max(1_000)
  .refine((values) => new Set(values.map((value) => value.evidenceId)).size === values.length)
  .readonly();
export type EvidenceCitation = z.infer<typeof Citation>;

/** Preserves declared order; duplicate evidence identities fail closed. */
export const renderEvidenceCitations = (input: unknown): string => {
  assertBoundedPipelineJson(input);
  const citations = Citations.parse(input);
  return citations
    .map(
      (citation) =>
        `- ${renderObsidianLink(citation.relativePath, citation.label)} — 근거: \`${citation.evidenceId}\``,
    )
    .join('\n');
};
