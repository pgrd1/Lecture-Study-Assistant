import { z } from 'zod';
import { VaultRelativePathSchema } from './obsidianWorkspace';

export const QuestionIdSchema = z.string().regex(/^q_[a-f0-9]{32}$/u);
export const QUESTION_ANSWER_PROSE_BYTES = 8 * 1024;
const PlainText = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      Buffer.byteLength(value) <= 8192 &&
      !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}<>]/u.test(value) &&
      !/(?:[a-z]:[\\/]|file:\/\/|\\\\|(?:^|\s)\/[\w.-]+\/|(?:sk-|AIza)[A-Za-z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY|(?:api[_ -]?key|password|secret|token)\s*[:=])/iu.test(
        value,
      ),
  );
export const QuestionAnswerSchema = z
  .strictObject({
    answer: PlainText.min(1),
    steps: z.array(PlainText.min(1)).max(12),
    example: PlainText,
    uncertainty: PlainText,
    evidenceIds: z
      .array(z.uuid())
      .min(1)
      .max(32)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .refine(
    (value) =>
      [value.answer, ...value.steps, value.example, value.uncertainty].reduce(
        (total, field) => total + Buffer.byteLength(field),
        0,
      ) <= QUESTION_ANSWER_PROSE_BYTES,
  );
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
export const QuestionAnswerResultSchema = z.strictObject({
  output: QuestionAnswerSchema,
  provenance: z.strictObject({
    requestId: z.uuid(),
    modelId: PlainText.min(1).max(200),
    promptVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    completedAt: z.iso.datetime().max(40),
  }),
});
export const QuestionEvidenceSchema = z
  .strictObject({
    evidenceId: z.uuid(),
    relativePath: VaultRelativePathSchema,
    label: z.string().min(1).max(500),
    text: z.string().min(1).max(16000),
  })
  .readonly();
export const QuestionEvidenceListSchema = z
  .array(QuestionEvidenceSchema)
  .max(32)
  .refine(
    (items) =>
      new Set(items.map((item) => item.evidenceId)).size === items.length &&
      Buffer.byteLength(JSON.stringify(items)) <= 128 * 1024,
  )
  .readonly();
export type QuestionEvidence = z.infer<typeof QuestionEvidenceSchema>;
export type QuestionInboxTarget = Readonly<{
  courseId: string;
  stableId: string;
  relativePath: string;
  userInstructions: string;
}>;
