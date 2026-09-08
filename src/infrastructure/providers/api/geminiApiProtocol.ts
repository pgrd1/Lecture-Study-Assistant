import { Buffer } from 'node:buffer';
import { types as nodeUtilTypes } from 'node:util';
import type { ProviderExecution, ProviderTextBlock } from '../../../core/ports/aiProvider';
import {
  type JsonValue,
  ModelIdSchema,
  type ProviderModel,
} from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError, type ProviderErrorCode } from '../../../shared/errors';
import { cloneBoundedJsonValue } from './boundedJson';

const MAX_MODEL_COUNT = 1_000;
const MAX_MODEL_METHODS = 64;
const MAX_MODEL_TEXT_BYTES = 16 * 1024;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_INTERACTION_METADATA_BYTES = 1_024;
const MAX_INTERACTION_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_MODALITY_ENTRIES = 32;
const MAX_PARSED_OUTPUT_DEPTH = 64;
const MAX_PARSED_OUTPUT_ENTRIES = 100_000;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/u;
const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const MODEL_KEYS = new Set([
  'name',
  'baseModelId',
  'version',
  'displayName',
  'description',
  'inputTokenLimit',
  'outputTokenLimit',
  'supportedGenerationMethods',
  'thinking',
  'temperature',
  'maxTemperature',
  'topP',
  'topK',
]);
const MODEL_REQUIRED_KEYS = new Set(['name', 'supportedGenerationMethods']);
const INTERACTION_KEYS = new Set([
  'object',
  'status',
  'model',
  'steps',
  'usage',
  'id',
  'created',
  'updated',
  'errors',
]);
const INTERACTION_REQUIRED_KEYS = new Set(['object', 'status', 'model', 'steps', 'usage']);
const USAGE_KEYS = new Set([
  'cached_tokens_by_modality',
  'grounding_tool_count',
  'input_tokens_by_modality',
  'output_tokens_by_modality',
  'tool_use_tokens_by_modality',
  'total_cached_tokens',
  'total_input_tokens',
  'total_output_tokens',
  'total_thought_tokens',
  'total_tokens',
  'total_tool_use_tokens',
]);
const USAGE_REQUIRED_KEYS = new Set([
  'total_input_tokens',
  'total_output_tokens',
  'total_tokens',
  'total_tool_use_tokens',
]);
const MODALITIES = new Set(['text', 'image', 'audio', 'video', 'document']);
const REFUSAL_CODES = new Set([
  'safety',
  'recitation',
  'language',
  'prohibited_content',
  'spii',
  'blocklist',
  'image_safety',
  'image_prohibited_content',
  'image_recitation',
  'image_other',
  'content_blocked',
]);

type StrictObject = Readonly<Record<string, unknown>>;

export const geminiApiError = (code: ProviderErrorCode): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);

export const sanitizeGeminiApiFailure = (error: unknown): AppError =>
  AppError.isTrusted(error) ? error : geminiApiError('PROVIDER_EXECUTION_FAILED');

const outputInvalid = (): AppError => geminiApiError('PROVIDER_OUTPUT_INVALID');

const readStrictObject = (
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: ReadonlySet<string>,
): StrictObject => {
  if (value === null || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) {
    throw outputInvalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw outputInvalid();
  const copied = Object.create(null) as Record<string, unknown>;
  let ownEnumerableCount = 0;
  let iterations = 0;
  for (const key in value) {
    iterations += 1;
    if (iterations > allowedKeys.size + 1 || !Object.hasOwn(value, key)) throw outputInvalid();
    if (!allowedKeys.has(key)) throw outputInvalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw outputInvalid();
    }
    ownEnumerableCount += 1;
    Object.defineProperty(copied, key, { enumerable: true, value: descriptor.value });
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== ownEnumerableCount || ownKeys.some((key) => typeof key !== 'string')) {
    throw outputInvalid();
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(copied, key)) throw outputInvalid();
  }
  return Object.freeze(copied);
};

const readDenseArray = (value: unknown, maximumLength: number): readonly unknown[] => {
  if (
    value === null ||
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw outputInvalid();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumLength
  ) {
    throw outputInvalid();
  }
  const length = lengthDescriptor.value as number;
  let indexCount = 0;
  let iterations = 0;
  for (const key in value) {
    iterations += 1;
    if (iterations > length + 1 || !Object.hasOwn(value, key)) throw outputInvalid();
    if (!ARRAY_INDEX_PATTERN.test(key) || Number(key) >= length) throw outputInvalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw outputInvalid();
    }
    indexCount += 1;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    indexCount !== length ||
    ownKeys.length !== length + 1 ||
    ownKeys.some((key) => typeof key !== 'string')
  ) {
    throw outputInvalid();
  }
  const copied: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw outputInvalid();
    }
    copied.push(descriptor.value);
  }
  return Object.freeze(copied);
};

const boundedString = (value: unknown, maximumBytes: number, allowEmpty = true): string => {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw outputInvalid();
  }
  return value;
};

const safeInteger = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw outputInvalid();
  }
  return value as number;
};

const optionalString = (object: StrictObject, key: string, maximumBytes: number): void => {
  if (Object.hasOwn(object, key)) boundedString(object[key], maximumBytes);
};

const readModelId = (value: unknown, requireResourcePrefix: boolean): string => {
  const raw = boundedString(value, 256, false);
  const modelId = requireResourcePrefix && raw.startsWith('models/') ? raw.slice(7) : raw;
  if ((requireResourcePrefix && modelId === raw) || !ModelIdSchema.safeParse(modelId).success) {
    throw outputInvalid();
  }
  return modelId;
};

export const assertGeminiApiModelId = (value: string | null): string => {
  if (value === null || !ModelIdSchema.safeParse(value).success) {
    throw geminiApiError('PROVIDER_MODEL_INCOMPATIBLE');
  }
  return value;
};

const validateModelMetadata = (model: StrictObject): void => {
  optionalString(model, 'baseModelId', 256);
  optionalString(model, 'version', 256);
  optionalString(model, 'description', MAX_MODEL_TEXT_BYTES);
  for (const key of ['inputTokenLimit', 'outputTokenLimit', 'topK']) {
    if (Object.hasOwn(model, key)) safeInteger(model[key]);
  }
  if (Object.hasOwn(model, 'thinking') && typeof model.thinking !== 'boolean') {
    throw outputInvalid();
  }
  for (const key of ['temperature', 'maxTemperature']) {
    if (
      Object.hasOwn(model, key) &&
      (typeof model[key] !== 'number' ||
        !Number.isFinite(model[key]) ||
        (model[key] as number) < 0 ||
        (model[key] as number) > 2)
    ) {
      throw outputInvalid();
    }
  }
  if (
    Object.hasOwn(model, 'topP') &&
    (typeof model.topP !== 'number' ||
      !Number.isFinite(model.topP) ||
      model.topP < 0 ||
      model.topP > 1)
  ) {
    throw outputInvalid();
  }
};

const readDisplayName = (value: unknown, fallback: string): string => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || CONTROL_OR_FORMAT_CHARACTER.test(value)) throw outputInvalid();
  const displayName = value.trim();
  if (displayName.length === 0 || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw outputInvalid();
  }
  return displayName;
};

export const parseGeminiModelList = (value: unknown): readonly ProviderModel[] => {
  try {
    const root = readStrictObject(value, new Set(['models', 'nextPageToken']), new Set(['models']));
    if (Object.hasOwn(root, 'nextPageToken')) {
      const token = boundedString(root.nextPageToken, 4_096);
      if (token.length !== 0) throw outputInvalid();
    }
    const models = readDenseArray(root.models, MAX_MODEL_COUNT);
    const seen = new Set<string>();
    const candidates: ProviderModel[] = [];
    for (const entry of models) {
      const model = readStrictObject(entry, MODEL_KEYS, MODEL_REQUIRED_KEYS);
      const modelId = readModelId(model.name, true);
      if (seen.has(modelId)) throw outputInvalid();
      seen.add(modelId);
      validateModelMetadata(model);
      const methods = readDenseArray(model.supportedGenerationMethods, MAX_MODEL_METHODS).map(
        (method) => boundedString(method, 128, false),
      );
      const displayName = readDisplayName(model.displayName, modelId);
      if (!methods.includes('generateContent')) continue;
      candidates.push(Object.freeze({ modelId, displayName, compatibility: 'unverified' }));
    }
    return Object.freeze(candidates);
  } catch (error) {
    if (AppError.isTrusted(error)) throw error;
    throw outputInvalid();
  }
};

const readModalityArray = (value: unknown): void => {
  const entries = readDenseArray(value, MAX_MODALITY_ENTRIES);
  const seen = new Set<string>();
  for (const entry of entries) {
    const item = readStrictObject(
      entry,
      new Set(['modality', 'tokens']),
      new Set(['modality', 'tokens']),
    );
    if (
      typeof item.modality !== 'string' ||
      !MODALITIES.has(item.modality) ||
      seen.has(item.modality)
    ) {
      throw outputInvalid();
    }
    seen.add(item.modality);
    safeInteger(item.tokens);
  }
};

const parseUsage = (value: unknown) => {
  const usage = readStrictObject(value, USAGE_KEYS, USAGE_REQUIRED_KEYS);
  const inputTokens = safeInteger(usage.total_input_tokens);
  const outputTokens = safeInteger(usage.total_output_tokens);
  const totalTokens = safeInteger(usage.total_tokens);
  const totalToolUseTokens = safeInteger(usage.total_tool_use_tokens);
  if (totalToolUseTokens !== 0) throw outputInvalid();
  for (const key of ['total_cached_tokens', 'total_thought_tokens']) {
    if (Object.hasOwn(usage, key)) safeInteger(usage[key]);
  }
  for (const key of [
    'cached_tokens_by_modality',
    'input_tokens_by_modality',
    'output_tokens_by_modality',
  ]) {
    if (Object.hasOwn(usage, key)) readModalityArray(usage[key]);
  }
  if (Object.hasOwn(usage, 'grounding_tool_count')) {
    const groundingToolCount = safeInteger(usage.grounding_tool_count);
    if (groundingToolCount !== 0) throw outputInvalid();
  }
  if (
    Object.hasOwn(usage, 'tool_use_tokens_by_modality') &&
    readDenseArray(usage.tool_use_tokens_by_modality, 0).length !== 0
  ) {
    throw outputInvalid();
  }
  return Object.freeze({ inputTokens, outputTokens, totalTokens });
};

const isIsoTimestamp = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

export const parseGeminiInteraction = <Output extends JsonValue>(
  value: unknown,
  parseOutput: (value: unknown) => Output,
  completedAt: string,
): ProviderExecution<Output> => {
  try {
    const root = readStrictObject(value, INTERACTION_KEYS, INTERACTION_REQUIRED_KEYS);
    if (root.object !== 'interaction' || root.status !== 'completed') throw outputInvalid();
    const reportedModelId = readModelId(root.model, false);
    for (const key of ['id', 'created', 'updated']) {
      optionalString(root, key, MAX_INTERACTION_METADATA_BYTES);
    }
    if (Object.hasOwn(root, 'errors') && readDenseArray(root.errors, 0).length !== 0) {
      throw outputInvalid();
    }
    const steps = readDenseArray(root.steps, 1);
    if (steps.length !== 1) throw outputInvalid();
    const step = readStrictObject(
      steps[0],
      new Set(['type', 'content']),
      new Set(['type', 'content']),
    );
    if (step.type !== 'model_output') throw outputInvalid();
    const content = readDenseArray(step.content, 1);
    if (content.length !== 1) throw outputInvalid();
    const item = readStrictObject(content[0], new Set(['type', 'text']), new Set(['type', 'text']));
    if (item.type !== 'text') throw outputInvalid();
    const text = boundedString(item.text, MAX_INTERACTION_TEXT_BYTES, false);
    const parsedJson: unknown = JSON.parse(text);
    let locallyParsed: Output;
    try {
      locallyParsed = parseOutput(parsedJson);
    } catch (error) {
      if (AppError.isTrusted(error)) throw error;
      throw outputInvalid();
    }
    const output = cloneBoundedJsonValue(
      locallyParsed,
      MAX_PARSED_OUTPUT_DEPTH,
      MAX_PARSED_OUTPUT_ENTRIES,
    ) as Output;
    const usage = parseUsage(root.usage);
    if (!isIsoTimestamp(completedAt)) throw outputInvalid();
    return Object.freeze({ output, reportedModelId, usage, completedAt });
  } catch (error) {
    if (AppError.isTrusted(error)) throw error;
    throw outputInvalid();
  }
};

export const classifyGeminiApiError = (status: number, value: JsonValue): ProviderErrorCode => {
  try {
    const root = readStrictObject(value, new Set(['error']), new Set(['error']));
    const error = readStrictObject(
      root.error,
      new Set(['code', 'message']),
      new Set(['code', 'message']),
    );
    const code = boundedString(error.code, 64, false);
    boundedString(error.message, 16 * 1024, false);
    if (!ERROR_CODE_PATTERN.test(code)) return 'PROVIDER_EXECUTION_FAILED';
    if (REFUSAL_CODES.has(code)) return 'PROVIDER_REFUSED';
    if (code === 'failed_precondition') return 'PROVIDER_QUOTA_OR_BILLING';
    if (code === 'model_not_found') return 'PROVIDER_MODEL_INCOMPATIBLE';
    if (status === 404 && code === 'not_found') return 'PROVIDER_MODEL_INCOMPATIBLE';
    if (
      (status === 400 || status === 422) &&
      (code === 'invalid_request' || code === 'parameter_unknown')
    ) {
      return 'PROVIDER_MODEL_INCOMPATIBLE';
    }
    return 'PROVIDER_EXECUTION_FAILED';
  } catch {
    return 'PROVIDER_EXECUTION_FAILED';
  }
};

type GeminiInteractionBodyInput = Readonly<{
  modelId: string;
  blocks: readonly ProviderTextBlock[];
  outputJsonSchema: Readonly<Record<string, JsonValue>>;
  maxOutputTokens: number;
}>;

export const buildGeminiInteractionBody = ({
  modelId,
  blocks,
  outputJsonSchema,
  maxOutputTokens,
}: GeminiInteractionBodyInput): JsonValue => {
  const systemBlocks: JsonValue[] = [];
  const sourceBlocks: JsonValue[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined) throw geminiApiError('PROVIDER_EXECUTION_FAILED');
    const rendered = Object.freeze({
      index,
      role: block.role,
      kind: block.kind,
      text: block.text,
    });
    if (block.role === 'system') systemBlocks.push(rendered);
    else sourceBlocks.push(rendered);
  }
  const schema = cloneBoundedJsonValue(
    outputJsonSchema,
    MAX_PARSED_OUTPUT_DEPTH,
    MAX_PARSED_OUTPUT_ENTRIES,
  );
  if (schema === null || Array.isArray(schema) || typeof schema !== 'object') {
    throw geminiApiError('PROVIDER_EXECUTION_FAILED');
  }
  return Object.freeze({
    model: modelId,
    system_instruction: JSON.stringify({ blocks: systemBlocks }),
    input: JSON.stringify({ blocks: sourceBlocks }),
    response_format: Object.freeze({
      type: 'text',
      mime_type: 'application/json',
      schema,
    }),
    generation_config: Object.freeze({ max_output_tokens: maxOutputTokens }),
    tools: Object.freeze([]),
    store: false,
    background: false,
    stream: false,
  });
};

export const GEMINI_API_UUID_PATTERN = UUID_PATTERN;
