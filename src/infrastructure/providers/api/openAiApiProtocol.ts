import { Buffer } from 'node:buffer';
import { types as nodeUtilTypes } from 'node:util';
import type {
  ProviderBlock,
  ProviderExecution,
  ProviderRequest,
  ProviderTextBlock,
} from '../../../core/ports/aiProvider';
import {
  APP_OWNED_OUTPUT_SCHEMA_IDS,
  snapshotProviderFileBlock,
} from '../../../core/ports/aiProvider';
import {
  type JsonValue,
  ModelIdSchema,
  type ProviderModel,
} from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError, type ProviderErrorCode } from '../../../shared/errors';
import { cloneOpenAiOwnedJson } from './openAiApiOwnedJson';
import { openAiStrictWireSchema } from './openAiStrictSchema';

const MAX_MODEL_COUNT = 1_000;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_OUTPUT_ITEMS = 128;
const MAX_REASONING_ITEMS = 64;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_ENTRIES = 100_000;
const MAX_BLOCKS = 10_000;
const MAX_BLOCK_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_MESSAGE_BYTES = 64 * 1024;
const MAX_ERROR_TYPE_BYTES = 256;
const MAX_ERROR_PARAM_BYTES = 2 * 1024;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/u;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const MODEL_KEYS = new Set(['id', 'object', 'created', 'owned_by', 'shutdown_date']);
const MODEL_REQUIRED_KEYS = new Set(['id', 'object', 'created', 'owned_by']);
const RESPONSE_KEYS = new Set([
  'object',
  'status',
  'error',
  'incomplete_details',
  'model',
  'output',
  'usage',
  'id',
  'created_at',
  'completed_at',
  'background',
  'instructions',
  'max_output_tokens',
  'max_tool_calls',
  'parallel_tool_calls',
  'previous_response_id',
  'reasoning',
  'store',
  'temperature',
  'text',
  'tool_choice',
  'tools',
  'top_logprobs',
  'top_p',
  'truncation',
  'metadata',
  'service_tier',
  'user',
  'prompt_cache_key',
  'prompt_cache_retention',
  'safety_identifier',
]);
const RESPONSE_REQUIRED_KEYS = new Set([
  'object',
  'status',
  'error',
  'incomplete_details',
  'model',
  'output',
  'usage',
]);
const TOOL_OUTPUT_TYPES = new Set(
  'function_call computer_call file_search_call web_search_call code_interpreter_call image_generation_call local_shell_call mcp_call custom_tool_call shell_call apply_patch_call function_call_output computer_call_output local_shell_call_output shell_call_output apply_patch_call_output mcp_list_tools mcp_approval_request custom_tool_call_output'.split(
    ' ',
  ),
);
const MODEL_INCOMPATIBLE_CODES = new Set([
  'model_not_found',
  'invalid_json_schema',
  'unsupported_parameter',
  'unsupported_value',
]);
const REQUEST_KEYS = new Set([
  'requestId',
  'feature',
  'jobId',
  'outputSchemaId',
  'outputJsonSchema',
  'parseOutput',
  'blocks',
  'timeoutMs',
  'maxOutputTokens',
  'signal',
  'modelId',
  'promptVersion',
  'routeRevision',
  'providerManagedHistoryConsentAt',
  'providerManagedHistoryConsentVersion',
  'sharedCredentialConsentAt',
  'sharedCredentialConsentVersion',
  'attemptKind',
]);

type StrictObject = Readonly<Record<string, unknown>>;

export type OpenAiExecuteSnapshot<Output extends JsonValue> = Readonly<{
  requestId: string;
  modelId: string;
  blocks: readonly ProviderBlock[];
  outputSchemaId: string;
  outputJsonSchema: Readonly<Record<string, JsonValue>>;
  parseOutput: (value: unknown) => Output;
  timeoutMs: number;
  maxOutputTokens: number;
  signal: AbortSignal;
}>;

export const openAiApiError = (code: ProviderErrorCode): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);

export const sanitizeOpenAiApiFailure = (error: unknown): AppError =>
  AppError.isTrusted(error) ? error : openAiApiError('PROVIDER_EXECUTION_FAILED');

const outputInvalid = (): AppError => openAiApiError('PROVIDER_OUTPUT_INVALID');

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
  let enumerableCount = 0;
  let iterations = 0;
  for (const key in value) {
    iterations += 1;
    if (iterations > allowedKeys.size + 1 || !Object.hasOwn(value, key) || !allowedKeys.has(key)) {
      throw outputInvalid();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw outputInvalid();
    }
    enumerableCount += 1;
    Object.defineProperty(copied, key, { enumerable: true, value: descriptor.value });
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== enumerableCount || ownKeys.some((key) => typeof key !== 'string')) {
    throw outputInvalid();
  }
  for (const key of requiredKeys) if (!Object.hasOwn(copied, key)) throw outputInvalid();
  return Object.freeze(copied);
};

const readDenseArray = (value: unknown, maximumLength: number): readonly unknown[] => {
  if (
    value === null ||
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    throw outputInvalid();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumLength
  )
    throw outputInvalid();
  const length = lengthDescriptor.value as number;
  let count = 0;
  let iterations = 0;
  for (const key in value) {
    iterations += 1;
    if (
      iterations > length + 1 ||
      !Object.hasOwn(value, key) ||
      !ARRAY_INDEX_PATTERN.test(key) ||
      Number(key) >= length
    )
      throw outputInvalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw outputInvalid();
    }
    count += 1;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    count !== length ||
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
  )
    throw outputInvalid();
  return value;
};

const safeInteger = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw outputInvalid();
  }
  return value as number;
};

const optionalBoundedString = (object: StrictObject, key: string): void => {
  if (Object.hasOwn(object, key) && object[key] !== null) {
    boundedString(object[key], MAX_METADATA_BYTES);
  }
};

const readModelId = (value: unknown): string => {
  const modelId = boundedString(value, 256, false);
  if (!ModelIdSchema.safeParse(modelId).success) throw outputInvalid();
  return modelId;
};

export const assertOpenAiApiModelId = (value: string | null): string => {
  if (value === null || !ModelIdSchema.safeParse(value).success) {
    throw openAiApiError('PROVIDER_MODEL_INCOMPATIBLE');
  }
  return value;
};

export const parseOpenAiModelList = (value: unknown): readonly ProviderModel[] => {
  try {
    const root = readStrictObject(value, new Set(['object', 'data']), new Set(['object', 'data']));
    if (root.object !== 'list') throw outputInvalid();
    const entries = readDenseArray(root.data, MAX_MODEL_COUNT);
    const seen = new Set<string>();
    const result: ProviderModel[] = [];
    for (const entry of entries) {
      const model = readStrictObject(entry, MODEL_KEYS, MODEL_REQUIRED_KEYS);
      if (model.object !== 'model') throw outputInvalid();
      const modelId = readModelId(model.id);
      if (seen.has(modelId)) throw outputInvalid();
      seen.add(modelId);
      safeInteger(model.created);
      boundedString(model.owned_by, MAX_METADATA_BYTES, false);
      if (Object.hasOwn(model, 'shutdown_date') && model.shutdown_date !== null) {
        safeInteger(model.shutdown_date);
      }
      result.push(Object.freeze({ modelId, displayName: modelId, compatibility: 'unverified' }));
    }
    return Object.freeze(result);
  } catch (error) {
    if (AppError.isTrusted(error)) throw error;
    throw outputInvalid();
  }
};

const validateEmptyArray = (value: unknown): void => {
  if (readDenseArray(value, 0).length !== 0) throw outputInvalid();
};

const validateReasoningItem = (value: unknown): void => {
  const item = readStrictObject(
    value,
    new Set(['id', 'type', 'summary', 'status', 'content', 'encrypted_content']),
    new Set(['type', 'summary']),
  );
  if (item.type !== 'reasoning') throw outputInvalid();
  optionalBoundedString(item, 'id');
  if (Object.hasOwn(item, 'status') && item.status !== null && item.status !== 'completed') {
    throw outputInvalid();
  }
  for (const summary of readDenseArray(item.summary, MAX_REASONING_ITEMS)) {
    const object = readStrictObject(summary, new Set(['type', 'text']), new Set(['type', 'text']));
    if (object.type !== 'summary_text') throw outputInvalid();
    boundedString(object.text, MAX_TEXT_BYTES);
  }
  if (Object.hasOwn(item, 'content')) {
    for (const content of readDenseArray(item.content, MAX_REASONING_ITEMS)) {
      const object = readStrictObject(
        content,
        new Set(['type', 'text']),
        new Set(['type', 'text']),
      );
      if (object.type !== 'reasoning_text') throw outputInvalid();
      boundedString(object.text, MAX_TEXT_BYTES);
    }
  }
  optionalBoundedString(item, 'encrypted_content');
};

const readOutputText = (value: unknown): string => {
  const item = readStrictObject(
    value,
    new Set(['type', 'text', 'annotations', 'logprobs']),
    new Set(['type', 'text']),
  );
  if (item.type === 'refusal') throw outputInvalid();
  if (item.type !== 'output_text') throw outputInvalid();
  if (Object.hasOwn(item, 'annotations')) validateEmptyArray(item.annotations);
  if (Object.hasOwn(item, 'logprobs')) validateEmptyArray(item.logprobs);
  return boundedString(item.text, MAX_TEXT_BYTES, false);
};

const readMessageText = (value: unknown): string => {
  const message = readStrictObject(
    value,
    new Set(['id', 'type', 'status', 'role', 'content']),
    new Set(['type', 'status', 'role', 'content']),
  );
  if (
    message.type !== 'message' ||
    message.status !== 'completed' ||
    message.role !== 'assistant'
  ) {
    throw outputInvalid();
  }
  optionalBoundedString(message, 'id');
  const content = readDenseArray(message.content, 1);
  if (content.length !== 1) throw outputInvalid();
  const candidate = content[0];
  const descriptor = readStrictObject(
    candidate,
    new Set(['type', 'text', 'annotations', 'logprobs', 'refusal']),
    new Set(['type']),
  );
  if (descriptor.type === 'refusal') {
    const refusal = readStrictObject(
      candidate,
      new Set(['type', 'refusal']),
      new Set(['type', 'refusal']),
    );
    boundedString(refusal.refusal, MAX_TEXT_BYTES, false);
    throw openAiApiError('PROVIDER_REFUSED');
  }
  return readOutputText(candidate);
};

const parseUsage = (value: unknown) => {
  const usage = readStrictObject(
    value,
    new Set([
      'input_tokens',
      'input_tokens_details',
      'output_tokens',
      'output_tokens_details',
      'total_tokens',
    ]),
    new Set([
      'input_tokens',
      'input_tokens_details',
      'output_tokens',
      'output_tokens_details',
      'total_tokens',
    ]),
  );
  const inputDetails = readStrictObject(
    usage.input_tokens_details,
    new Set(['cached_tokens', 'cache_write_tokens']),
    new Set([]),
  );
  for (const key of ['cached_tokens', 'cache_write_tokens']) {
    if (Object.hasOwn(inputDetails, key)) safeInteger(inputDetails[key]);
  }
  const outputDetails = readStrictObject(
    usage.output_tokens_details,
    new Set(['reasoning_tokens']),
    new Set([]),
  );
  if (Object.hasOwn(outputDetails, 'reasoning_tokens')) safeInteger(outputDetails.reasoning_tokens);
  return Object.freeze({
    inputTokens: safeInteger(usage.input_tokens),
    outputTokens: safeInteger(usage.output_tokens),
    totalTokens: safeInteger(usage.total_tokens),
  });
};

const validateEchoMetadata = (root: StrictObject): void => {
  optionalBoundedString(root, 'id');
  optionalBoundedString(root, 'instructions');
  optionalBoundedString(root, 'previous_response_id');
  optionalBoundedString(root, 'service_tier');
  optionalBoundedString(root, 'user');
  optionalBoundedString(root, 'prompt_cache_key');
  optionalBoundedString(root, 'prompt_cache_retention');
  optionalBoundedString(root, 'safety_identifier');
  for (const key of [
    'created_at',
    'completed_at',
    'max_output_tokens',
    'max_tool_calls',
    'top_logprobs',
  ]) {
    if (Object.hasOwn(root, key) && root[key] !== null) safeInteger(root[key]);
  }
  for (const key of ['temperature', 'top_p']) {
    if (Object.hasOwn(root, key) && root[key] !== null) {
      const value = root[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw outputInvalid();
    }
  }
  if (Object.hasOwn(root, 'background') && root.background !== false) throw outputInvalid();
  if (Object.hasOwn(root, 'parallel_tool_calls') && root.parallel_tool_calls !== false)
    throw outputInvalid();
  if (Object.hasOwn(root, 'store') && root.store !== false) throw outputInvalid();
  if (Object.hasOwn(root, 'tool_choice') && root.tool_choice !== 'none') throw outputInvalid();
  if (Object.hasOwn(root, 'tools')) validateEmptyArray(root.tools);
  if (Object.hasOwn(root, 'truncation') && root.truncation !== 'disabled') throw outputInvalid();
  for (const key of ['reasoning', 'text', 'metadata']) {
    if (Object.hasOwn(root, key) && root[key] !== null) {
      cloneOpenAiOwnedJson(root[key], MAX_JSON_DEPTH, MAX_JSON_ENTRIES);
    }
  }
};

const hasDuplicateJsonObjectKeys = (text: string): boolean => {
  const scopes: Array<Set<string> | null> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') {
      scopes.push(new Set());
      continue;
    }
    if (character === '[') {
      scopes.push(null);
      continue;
    }
    if (character === '}' || character === ']') {
      scopes.pop();
      continue;
    }
    if (character !== '"') continue;
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === '"') break;
      index += 1;
    }
    let next = index + 1;
    while (next < text.length && /\s/u.test(text[next] ?? '')) next += 1;
    const scope = scopes.at(-1);
    if (text[next] === ':' && scope instanceof Set) {
      let key: string;
      try {
        key = JSON.parse(text.slice(start, index + 1)) as string;
      } catch {
        continue;
      }
      if (scope.has(key)) return true;
      scope.add(key);
    }
  }
  return false;
};

const parseGeneratedOutput = <Output extends JsonValue>(
  text: string,
  parseOutput: (value: unknown) => Output,
): Output => {
  if (hasDuplicateJsonObjectKeys(text)) throw outputInvalid();
  let parsed: JsonValue;
  try {
    parsed = cloneOpenAiOwnedJson(JSON.parse(text), MAX_JSON_DEPTH, MAX_JSON_ENTRIES);
  } catch {
    throw outputInvalid();
  }
  let local: Output;
  try {
    local = parseOutput(parsed);
  } catch (error) {
    if (AppError.isTrusted(error)) throw error;
    throw outputInvalid();
  }
  try {
    return cloneOpenAiOwnedJson(local, MAX_JSON_DEPTH, MAX_JSON_ENTRIES) as Output;
  } catch {
    throw outputInvalid();
  }
};

const isIsoTimestamp = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const readOutputItemType = (value: unknown): string => {
  if (value === null || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) {
    throw outputInvalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw outputInvalid();
  let enumerableCount = 0;
  for (const key in value) {
    enumerableCount += 1;
    if (enumerableCount > 64 || !Object.hasOwn(value, key)) throw outputInvalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw outputInvalid();
    }
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== enumerableCount || ownKeys.some((key) => typeof key !== 'string')) {
    throw outputInvalid();
  }
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, 'type');
  if (
    typeDescriptor === undefined ||
    !typeDescriptor.enumerable ||
    !('value' in typeDescriptor) ||
    typeof typeDescriptor.value !== 'string'
  )
    throw outputInvalid();
  return typeDescriptor.value;
};

export const parseOpenAiResponse = <Output extends JsonValue>(
  value: unknown,
  parseOutput: (value: unknown) => Output,
  completedAt: string,
): ProviderExecution<Output> => {
  try {
    const root = readStrictObject(value, RESPONSE_KEYS, RESPONSE_REQUIRED_KEYS);
    if (
      root.object !== 'response' ||
      root.status !== 'completed' ||
      root.error !== null ||
      root.incomplete_details !== null
    )
      throw outputInvalid();
    const reportedModelId = readModelId(root.model);
    validateEchoMetadata(root);
    const output = readDenseArray(root.output, MAX_OUTPUT_ITEMS);
    let messageText: string | null = null;
    let messageSeen = false;
    for (const item of output) {
      const type = readOutputItemType(item);
      if (TOOL_OUTPUT_TYPES.has(type)) throw openAiApiError('PROVIDER_TOOL_ACTIVITY_DETECTED');
      if (type === 'reasoning') {
        if (messageSeen) throw outputInvalid();
        validateReasoningItem(item);
        continue;
      }
      if (type !== 'message' || messageSeen) throw outputInvalid();
      messageSeen = true;
      messageText = readMessageText(item);
    }
    if (!messageSeen || messageText === null) throw outputInvalid();
    const parsedOutput = parseGeneratedOutput(messageText, parseOutput);
    const parsedUsage = parseUsage(root.usage);
    if (typeof completedAt !== 'string' || !isIsoTimestamp(completedAt)) throw outputInvalid();
    return Object.freeze({
      output: parsedOutput,
      reportedModelId,
      usage: parsedUsage,
      completedAt,
    });
  } catch (error) {
    if (AppError.isTrusted(error)) throw error;
    throw outputInvalid();
  }
};

export const classifyOpenAiApiError = (_status: number, value: JsonValue): ProviderErrorCode => {
  try {
    const root = readStrictObject(value, new Set(['error']), new Set(['error']));
    const error = readStrictObject(
      root.error,
      new Set(['code', 'message', 'type', 'param']),
      new Set(['code', 'message', 'type', 'param']),
    );
    const code = boundedString(error.code, 64, false);
    boundedString(error.message, MAX_ERROR_MESSAGE_BYTES);
    boundedString(error.type, MAX_ERROR_TYPE_BYTES);
    if (error.param !== null) boundedString(error.param, MAX_ERROR_PARAM_BYTES);
    if (!ERROR_CODE_PATTERN.test(code)) return 'PROVIDER_EXECUTION_FAILED';
    if (MODEL_INCOMPATIBLE_CODES.has(code)) return 'PROVIDER_MODEL_INCOMPATIBLE';
    if (code === 'content_policy_violation') return 'PROVIDER_REFUSED';
    return 'PROVIDER_EXECUTION_FAILED';
  } catch {
    return 'PROVIDER_EXECUTION_FAILED';
  }
};

type ResponseBodyInput = Readonly<{
  modelId: string;
  blocks: readonly ProviderTextBlock[];
  outputJsonSchema: Readonly<Record<string, JsonValue>>;
  outputSchemaId: string;
  maxOutputTokens: number;
}>;

const renderBlocks = (
  blocks: readonly ProviderTextBlock[],
  role: ProviderTextBlock['role'],
): string =>
  JSON.stringify({
    blocks: blocks.flatMap((block, index) =>
      block.role === role ? [{ index, role: block.role, kind: block.kind, text: block.text }] : [],
    ),
  });

export const buildOpenAiResponseBody = ({
  modelId,
  blocks,
  outputJsonSchema,
  outputSchemaId,
  maxOutputTokens,
}: ResponseBodyInput): JsonValue => {
  try {
    if (
      !ModelIdSchema.safeParse(modelId).success ||
      (!APP_OWNED_OUTPUT_SCHEMA_IDS.includes(
        outputSchemaId as (typeof APP_OWNED_OUTPUT_SCHEMA_IDS)[number],
      ) &&
        outputSchemaId !== 'provider_probe_v1') ||
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 65_536
    )
      throw outputInvalid();
    const schema = openAiStrictWireSchema(outputJsonSchema);
    if (schema === null || Array.isArray(schema) || typeof schema !== 'object')
      throw outputInvalid();
    return Object.freeze({
      model: modelId,
      input: Object.freeze([
        Object.freeze({
          type: 'message',
          role: 'developer',
          content: Object.freeze([
            Object.freeze({ type: 'input_text', text: renderBlocks(blocks, 'system') }),
          ]),
        }),
        Object.freeze({
          type: 'message',
          role: 'user',
          content: Object.freeze([
            Object.freeze({ type: 'input_text', text: renderBlocks(blocks, 'user') }),
          ]),
        }),
      ]),
      store: false,
      background: false,
      stream: false,
      tools: Object.freeze([]),
      tool_choice: 'none',
      parallel_tool_calls: false,
      truncation: 'disabled',
      max_output_tokens: maxOutputTokens,
      text: Object.freeze({
        format: Object.freeze({ type: 'json_schema', name: outputSchemaId, strict: true, schema }),
      }),
    });
  } catch (error) {
    if (AppError.isTrusted(error)) throw error;
    throw openAiApiError('PROVIDER_EXECUTION_FAILED');
  }
};

const readNullableString = (value: unknown): void => {
  if (value !== null && typeof value !== 'string') throw outputInvalid();
};

export const snapshotOpenAiExecuteRequest = <Output extends JsonValue>(
  value: ProviderRequest<Output>,
): OpenAiExecuteSnapshot<Output> => {
  try {
    const request = readStrictObject(value, REQUEST_KEYS, REQUEST_KEYS);
    if (
      typeof request.requestId !== 'string' ||
      !UUID_PATTERN.test(request.requestId) ||
      !APP_OWNED_OUTPUT_SCHEMA_IDS.includes(
        request.outputSchemaId as (typeof APP_OWNED_OUTPUT_SCHEMA_IDS)[number],
      ) ||
      typeof request.parseOutput !== 'function' ||
      !(request.signal instanceof AbortSignal) ||
      typeof request.feature !== 'string' ||
      !Number.isSafeInteger(request.timeoutMs) ||
      (request.timeoutMs as number) < 30_000 ||
      (request.timeoutMs as number) > 900_000 ||
      !Number.isSafeInteger(request.maxOutputTokens) ||
      (request.maxOutputTokens as number) < 1 ||
      (request.maxOutputTokens as number) > 65_536 ||
      !Number.isSafeInteger(request.routeRevision) ||
      (request.routeRevision as number) < 0 ||
      typeof request.promptVersion !== 'string' ||
      !['initial', 'transient_retry', 'format_repair'].includes(request.attemptKind as string)
    )
      throw outputInvalid();
    for (const key of [
      'jobId',
      'providerManagedHistoryConsentAt',
      'providerManagedHistoryConsentVersion',
      'sharedCredentialConsentAt',
      'sharedCredentialConsentVersion',
    ])
      readNullableString(request[key]);
    const modelId = assertOpenAiApiModelId(request.modelId as string | null);
    const rawBlocks = readDenseArray(request.blocks, MAX_BLOCKS);
    let blockBytes = 0;
    const blocks = rawBlocks.map((raw): ProviderBlock => {
      const kind =
        raw !== null && typeof raw === 'object'
          ? Object.getOwnPropertyDescriptor(raw, 'kind')
          : undefined;
      if (kind && 'value' in kind && kind.value === 'source_file')
        return snapshotProviderFileBlock(raw);
      const block = readStrictObject(
        raw,
        new Set(['role', 'kind', 'text']),
        new Set(['role', 'kind', 'text']),
      );
      if (
        (block.role !== 'system' && block.role !== 'user') ||
        !['instruction', 'source', 'professor_note', 'format_repair'].includes(
          block.kind as string,
        ) ||
        typeof block.text !== 'string'
      )
        throw outputInvalid();
      blockBytes += Buffer.byteLength(block.text, 'utf8');
      if (blockBytes > MAX_BLOCK_BYTES) throw outputInvalid();
      return Object.freeze({
        role: block.role,
        kind: block.kind as ProviderTextBlock['kind'],
        text: block.text,
      });
    });
    const schema = cloneOpenAiOwnedJson(request.outputJsonSchema, MAX_JSON_DEPTH, MAX_JSON_ENTRIES);
    if (schema === null || Array.isArray(schema) || typeof schema !== 'object')
      throw outputInvalid();
    return Object.freeze({
      requestId: request.requestId,
      modelId,
      blocks: Object.freeze(blocks),
      outputSchemaId: request.outputSchemaId as string,
      outputJsonSchema: schema as Readonly<Record<string, JsonValue>>,
      parseOutput: request.parseOutput as (value: unknown) => Output,
      timeoutMs: request.timeoutMs as number,
      maxOutputTokens: request.maxOutputTokens as number,
      signal: request.signal,
    });
  } catch (error) {
    if (
      AppError.isTrusted(error) &&
      (error.code === 'PROVIDER_MODEL_INCOMPATIBLE' || error.code === 'PROVIDER_MEDIA_UNSUPPORTED')
    )
      throw error;
    throw openAiApiError('PROVIDER_EXECUTION_FAILED');
  }
};
