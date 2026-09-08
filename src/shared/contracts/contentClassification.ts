import { z } from 'zod';
import { SourceLocatorSchema } from './evidence';

const Types = z
  .array(
    z.enum([
      'lecture_recording',
      'orientation',
      'syllabus',
      'lecture_slides',
      'handout',
      'textbook',
      'reference',
      'past_exam',
      'assignment',
      'quiz',
      'class_work',
      'handwritten',
      'whiteboard',
      'screen_photo',
      'administrative_notice',
      'other',
    ]),
  )
  .min(1)
  .max(16)
  .refine((v) => new Set(v).size === v.length)
  .readonly();
const Confidence = z.number().min(0).max(1);
const Uncertainty = z.string().min(1).max(2_000).nullable();
export const ClassificationFactSchema = z
  .strictObject({
    kind: z.enum([
      'weekly_topic',
      'textbook_scope',
      'grading_component',
      'candidate_exam_date',
      'candidate_quiz_date',
      'candidate_assignment_date',
      'exam_format',
      'permitted_materials',
      'study_instruction',
      'exam_instruction',
      'glossary',
      'chapter_structure',
    ]),
    text: z.string().min(1).max(4_000),
    locator: SourceLocatorSchema,
    confidence: Confidence,
    uncertainty: Uncertainty,
    date: z.iso.date().nullable(),
    weightPercent: z.number().min(0).max(100).nullable(),
  })
  .readonly();

export const ContentClassificationSchema = z
  .strictObject({
    sourceId: z.uuid(),
    types: Types,
    sections: z
      .array(
        z
          .strictObject({
            locator: SourceLocatorSchema,
            types: Types,
            confidence: Confidence,
            uncertainty: Uncertainty,
          })
          .readonly(),
      )
      .max(1_000)
      .readonly(),
    facts: z.array(ClassificationFactSchema).max(2_000).readonly(),
    confidence: z.number().min(0).max(1),
    uncertainty: z.string().min(1).max(2_000).nullable(),
    sessionDate: z.iso.date().nullable(),
  })
  .readonly();
export type ContentClassification = z.infer<typeof ContentClassificationSchema>;

/** One complete, ordered job checkpoint; singular v1 classifications remain readable separately. */
export const ContentClassificationResultSchema = z
  .strictObject({
    classifications: z.array(ContentClassificationSchema).min(1).max(32).readonly(),
  })
  .refine(
    (v) => new Set(v.classifications.map((c) => c.sourceId)).size === v.classifications.length,
  )
  .readonly();
export type ContentClassificationResult = z.infer<typeof ContentClassificationResultSchema>;
