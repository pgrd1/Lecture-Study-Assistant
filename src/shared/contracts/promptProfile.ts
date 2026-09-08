import { z } from 'zod';
import { APP_ERROR_MESSAGES, AppError } from '../errors';
import { AI_FEATURES } from './provider';

export const PROMPT_LIMITS = Object.freeze({
  instructionsBytes: 64 * 1024,
  templateBytes: 256 * 1024,
  composedBytes: 512 * 1024,
  previewBytes: 4096,
  sourceBlocks: 64,
});
export const promptInputError = (): AppError =>
  new AppError('INVALID_INPUT', APP_ERROR_MESSAGES.INVALID_INPUT);

// Read only bounded data properties before Zod clones any profile or composition input.
export const readPromptData = (
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> => {
  if (
    input === null ||
    typeof input !== 'object' ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  )
    throw promptInputError();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length > fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  )
    throw promptInputError();
  return Object.fromEntries(
    keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
        throw promptInputError();
      return [key, descriptor.value];
    }),
  );
};

export const boundedPromptText = (value: unknown, maxBytes: number): string => {
  if (
    typeof value !== 'string' ||
    value.length > maxBytes ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    value.includes('\0')
  )
    throw promptInputError();
  return value;
};
const byteString = (max: number) =>
  z
    .string()
    .refine(
      (value) =>
        value.length <= max &&
        new TextEncoder().encode(value).byteLength <= max &&
        !value.includes('\0'),
    );
export const PromptVersionSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const PromptRevisionSchema = z
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const PromptNameSchema = byteString(256).trim().min(1);

const keyFields = {
  scope: z.enum(['global', 'course', 'feature']),
  courseId: z.uuid().nullable(),
  feature: z.enum(AI_FEATURES).nullable(),
};
const validKey = (key: { scope: string; courseId: string | null; feature: string | null }) =>
  key.scope === 'global'
    ? key.courseId === null && key.feature === null
    : key.scope === 'course'
      ? key.courseId !== null && key.feature === null
      : key.feature !== null;
export const PromptProfileKeySchema = z.strictObject(keyFields).refine(validKey).readonly();
export type PromptProfileKey = z.infer<typeof PromptProfileKeySchema>;
export const parsePromptKey = (value: unknown): PromptProfileKey =>
  PromptProfileKeySchema.parse(readPromptData(value, ['scope', 'courseId', 'feature']));

const valueFields = {
  additionalInstructions: byteString(PROMPT_LIMITS.instructionsBytes),
  templateOverride: byteString(PROMPT_LIMITS.templateBytes)
    .refine((value) => value.trim().length > 0)
    .nullable(),
  name: PromptNameSchema,
};
export const PromptProfileValuesSchema = z.strictObject(valueFields).readonly();
export type PromptProfileValues = z.infer<typeof PromptProfileValuesSchema>;
export const parsePromptValues = (value: unknown): PromptProfileValues => {
  const data = readPromptData(value, ['additionalInstructions', 'templateOverride', 'name']);
  boundedPromptText(data.additionalInstructions, PROMPT_LIMITS.instructionsBytes);
  if (data.templateOverride !== null)
    boundedPromptText(data.templateOverride, PROMPT_LIMITS.templateBytes);
  boundedPromptText(data.name, 256);
  return PromptProfileValuesSchema.parse(data);
};

export const PromptProfileSchema = z
  .strictObject({
    ...keyFields,
    ...valueFields,
    id: z.uuid(),
    baseVersion: PromptVersionSchema,
    revision: PromptRevisionSchema,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    deleted: z.boolean(),
  })
  .refine(validKey)
  .readonly();
export type PromptProfile = z.infer<typeof PromptProfileSchema>;
export const parsePromptProfile = (value: unknown): PromptProfile => {
  const data = readPromptData(value, [
    'scope',
    'courseId',
    'feature',
    'additionalInstructions',
    'templateOverride',
    'name',
    'id',
    'baseVersion',
    'revision',
    'createdAt',
    'updatedAt',
    'deleted',
  ]);
  parsePromptValues({
    additionalInstructions: data.additionalInstructions,
    templateOverride: data.templateOverride,
    name: data.name,
  });
  return PromptProfileSchema.parse(data);
};
export const promptProfileKey = (key: PromptProfileKey): string => {
  const parsed = parsePromptKey(key);
  return `${parsed.scope}:${parsed.courseId ?? ''}:${parsed.feature ?? ''}`;
};
