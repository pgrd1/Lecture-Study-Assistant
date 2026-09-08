import { z } from 'zod';
import type { ContentContextBlocks } from '../../core/ports/studyContentProcessor';
import { sha256CanonicalJson } from '../../core/providers/canonicalJson';
import { assertBoundedPipelineJson } from '../../shared/contracts/boundedPipelineJson';
import { readPromptData } from '../../shared/contracts/promptProfile';
import { AI_FEATURES } from '../../shared/contracts/provider';
import {
  type ContentPipelineDependencies,
  type ContentPipelineInput,
  type ContentPromptInput,
  contentError,
} from './pipelineOperations';

export const ContentContextBlocksSchema = z
  .array(
    z
      .strictObject({
        role: z.literal('user'),
        kind: z.enum(['source', 'professor_note']),
        text: z.string().max(32_768),
      })
      .readonly(),
  )
  .max(16)
  .readonly();
export type { ContentContextBlocks };

const EDITABLE_FIELDS = [
  'globalInstructions',
  'courseInstructions',
  'featureInstructions',
  'oneOffInstructions',
  'advancedTemplateOverride',
  'profiles',
] as const;
const INPUT_FIELDS = [
  'jobId',
  'courseId',
  'signal',
  'sourceBundleId',
  'existingTopics',
  'prompts',
  'contextBlocks',
] as const;

/** Validate before copying/hash; never retain caller or repository aliases across an await. */
export const snapshotContentAttempt = <
  D extends ContentPipelineDependencies,
  I extends ContentPipelineInput,
>(
  dependencies: D,
  original: I,
) => {
  dependencies.assertAttemptCurrent?.();
  const readInput = (): I => {
    const data = readPromptData(original, INPUT_FIELDS);
    z.uuid().parse(data.courseId);
    if (!(data.signal instanceof AbortSignal)) throw contentError();
    return data as I;
  };
  const capture = (data = readInput()) => {
    const supplied = readPromptData(data.prompts ?? {}, AI_FEATURES);
    const persisted = readPromptData(dependencies.promptInputs?.(data.courseId) ?? {}, AI_FEATURES);
    const prompts = Object.freeze(
      Object.fromEntries(
        AI_FEATURES.map((feature) => {
          const editable = {
            ...readPromptData(persisted[feature] ?? {}, EDITABLE_FIELDS),
            ...readPromptData(supplied[feature] ?? {}, EDITABLE_FIELDS),
          } as ContentPromptInput;
          // Composer checks every field, profile, UTF-8 budget and closed descriptor.
          dependencies.composer.compose({ ...editable, feature, courseId: data.courseId });
          const copy = JSON.parse(JSON.stringify(editable)) as ContentPromptInput;
          const profiles = copy.profiles?.map((p) => Object.freeze(p));
          return [
            feature,
            Object.freeze({ ...copy, ...(profiles ? { profiles: Object.freeze(profiles) } : {}) }),
          ];
        }),
      ),
    ) as NonNullable<ContentPipelineInput['prompts']>;
    const contextValue = data.contextBlocks ?? [];
    assertBoundedPipelineJson(contextValue);
    const contextBlocks = ContentContextBlocksSchema.parse(contextValue);
    if (Buffer.byteLength(JSON.stringify(contextBlocks), 'utf8') > 65_536) throw contentError();
    return Object.freeze({ prompts, contextBlocks });
  };
  const inputData = readInput();
  const snapshot = capture(inputData);
  const hash = sha256CanonicalJson(snapshot);
  const assertAttemptCurrent = () => {
    dependencies.assertAttemptCurrent?.();
    if (sha256CanonicalJson(capture()) !== hash) throw contentError('PROVIDER_NOT_READY');
  };
  return Object.freeze({
    input: Object.freeze({
      ...inputData,
      ...snapshot,
      signal: dependencies.lifetimeSignal
        ? AbortSignal.any([inputData.signal, dependencies.lifetimeSignal])
        : inputData.signal,
    }),
    dependencies: Object.freeze({ ...dependencies, promptInputs: undefined, assertAttemptCurrent }),
  });
};
