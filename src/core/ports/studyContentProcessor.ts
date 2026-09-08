import type { PromptProfile } from '../../shared/contracts/promptProfile';
import type { AiFeature } from '../../shared/contracts/provider';
import type {
  ExistingTopicDescriptor,
  StudyContentResult,
} from '../../shared/contracts/studyContent';

export type ContentContextBlocks = readonly Readonly<{
  role: 'user';
  kind: 'source' | 'professor_note';
  text: string;
}>[];

export type StudyContentInput = Readonly<{
  jobId: string;
  courseId: string;
  sourceBundleId: string;
  existingTopics: readonly ExistingTopicDescriptor[];
  signal: AbortSignal;
  contextBlocks?: ContentContextBlocks;
  prompts?: Readonly<
    Partial<
      Record<
        AiFeature,
        Readonly<{
          globalInstructions?: string;
          courseInstructions?: string;
          featureInstructions?: string;
          oneOffInstructions?: string;
          advancedTemplateOverride?: string | null;
          profiles?: readonly PromptProfile[];
        }>
      >
    >
  >;
}>;
export interface StudyContentProcessor {
  processBundle(input: StudyContentInput): Promise<StudyContentResult>;
}
