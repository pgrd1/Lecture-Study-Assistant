import type { SourceMediaType } from '../../shared/contracts/job';
import type { AiFeature, AiProviderId } from '../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';
import type { ProviderBlock, ProviderTextBlock } from './aiProvider';

// Family ceilings only: execution still requires model/transport verification.
const FAMILY_MEDIA: Readonly<Record<AiProviderId, readonly SourceMediaType[]>> = Object.freeze({
  antigravity_cli: Object.freeze([]),
  gemini_cli: Object.freeze([]),
  codex_cli: Object.freeze(['image'] as const),
  gemini_api: Object.freeze(['audio', 'document', 'image'] as const),
  openai_api: Object.freeze(['document', 'image'] as const),
  claude_api: Object.freeze(['document', 'image'] as const),
});
const NO_FILES = Object.freeze([]);
const SOURCE_FILES = Object.freeze(['audio', 'video', 'document', 'image'] as const);
const FEATURE_MEDIA: Readonly<Record<AiFeature, readonly SourceMediaType[]>> = Object.freeze({
  content_classification: SOURCE_FILES,
  media_extraction: SOURCE_FILES,
  audio_transcription: Object.freeze(['audio'] as const),
  document_recognition: Object.freeze(['document', 'image'] as const),
  topic_clustering: NO_FILES,
  source_question_extraction: NO_FILES,
  question_variation: NO_FILES,
  course_question_answer: NO_FILES,
  core_summary: NO_FILES,
  lecture_organize: NO_FILES,
  lecture_verify: NO_FILES,
  professor_profile: NO_FILES,
  exam_synthesis: NO_FILES,
  question_generation: NO_FILES,
  answer_verification: NO_FILES,
  grading_feedback: NO_FILES,
});
export const assertProviderSupportsBlocks = (
  providerId: AiProviderId,
  blocks: readonly ProviderBlock[],
  feature?: AiFeature,
): void => {
  const allowed = FAMILY_MEDIA[providerId];
  if (
    allowed === undefined ||
    (feature !== undefined && FEATURE_MEDIA[feature] === undefined) ||
    blocks.some(
      (block) =>
        block.kind === 'source_file' &&
        (!allowed.includes(block.mediaType) ||
          (feature !== undefined && !FEATURE_MEDIA[feature].includes(block.mediaType))),
    )
  ) {
    throw new AppError('PROVIDER_MEDIA_UNSUPPORTED', APP_ERROR_MESSAGES.PROVIDER_MEDIA_UNSUPPORTED);
  }
};

export const rejectSourceFileDescriptor = (value: unknown): void => {
  if (value === null || typeof value !== 'object') return;
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (kind !== undefined && 'value' in kind && kind.value === 'source_file')
    throw new AppError('PROVIDER_MEDIA_UNSUPPORTED', APP_ERROR_MESSAGES.PROVIDER_MEDIA_UNSUPPORTED);
};

// Temporary execution boundary until reviewed materialization is implemented.
export const requireTextBlocks = (
  blocks: readonly ProviderBlock[],
): readonly ProviderTextBlock[] => {
  return Object.freeze(
    blocks.map((block) => {
      if (block.kind === 'source_file')
        throw new AppError(
          'PROVIDER_MEDIA_UNSUPPORTED',
          APP_ERROR_MESSAGES.PROVIDER_MEDIA_UNSUPPORTED,
        );
      return block;
    }),
  );
};
