import { z } from 'zod';

const Position = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Index = z.int().positive().max(1_000_000);
export const SourceLocatorSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({ kind: z.literal('audio'), startMs: Position, endMs: Position })
    .refine((v) => v.endMs >= v.startMs)
    .readonly(),
  z.strictObject({ kind: z.literal('document'), page: Index }).readonly(),
  z.strictObject({ kind: z.literal('slide'), slide: Index }).readonly(),
  // Image coordinates are normalized fractions of the source image.
  z
    .strictObject({
      kind: z.literal('image'),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    })
    .refine((v) => v.x + v.width <= 1 && v.y + v.height <= 1)
    .readonly(),
  z
    .strictObject({ kind: z.literal('text'), startLine: Index, endLine: Index })
    .refine((v) => v.endLine >= v.startLine)
    .readonly(),
]);
export type SourceLocator = z.infer<typeof SourceLocatorSchema>;
export const EvidenceSegmentSchema = z
  .strictObject({
    id: z.uuid(),
    sourceId: z.uuid(),
    kind: z.enum([
      'definition',
      'explanation',
      'example',
      'formula',
      'question',
      'answer',
      'emphasis',
      'observation',
    ]),
    text: z.string().min(1).max(20_000),
    confidence: z.number().min(0).max(1),
    locator: SourceLocatorSchema,
    language: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/)
      .optional(),
    uncertainty: z.string().min(1).max(2_000).nullable().optional(),
    sessionDate: z.iso.date().nullable().optional(),
  })
  .readonly();
export type EvidenceSegment = z.infer<typeof EvidenceSegmentSchema>;
export const EvidenceSegmentsSchema = z
  .strictObject({ segments: z.array(EvidenceSegmentSchema).max(10_000).readonly() })
  .readonly();

export const validateEvidenceSources = (
  segments: readonly EvidenceSegment[],
  sourceIds: readonly string[],
): readonly EvidenceSegment[] => {
  const parsed = EvidenceSegmentsSchema.parse({ segments }).segments;
  const known = new Set(z.array(z.uuid()).max(32).parse(sourceIds));
  if (
    new Set(parsed.map((v) => v.id)).size !== parsed.length ||
    parsed.some((v) => !known.has(v.sourceId))
  )
    throw new TypeError('INVALID_EVIDENCE_SOURCE_REFERENCE');
  return parsed;
};
