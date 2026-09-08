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
  requireTextBlocks,
  snapshotProviderFileBlock,
} from '../../../core/ports/aiProvider';
import {
  type JsonValue,
  ModelIdSchema,
  type ProviderModel,
} from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError, type ProviderErrorCode } from '../../../shared/errors';
import { cloneAnthropicOwnedJson, parseAnthropicOwnedJsonText } from './anthropicApiOwnedJson';

const MAX_MODELS = 100;
const MAX_BLOCKS = 10_000;
const MAX_CONTENT_BLOCKS = 64;
const MAX_BLOCK_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_ID_BYTES = 256;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_ENTRIES = 100_000;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/u;
const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const MACHINE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

const MODEL_KEYS = new Set([
  'id',
  'type',
  'display_name',
  'created_at',
  'capabilities',
  'max_input_tokens',
  'max_tokens',
]);
const MODEL_REQUIRED_KEYS = new Set(['id', 'type', 'display_name', 'created_at']);
const CAPABILITY_KEYS = new Set([
  'batch',
  'citations',
  'code_execution',
  'context_management',
  'effort',
  'image_input',
  'pdf_input',
  'structured_outputs',
  'thinking',
]);
const SIMPLE_CAPABILITY_KEYS = Object.freeze([
  'batch',
  'citations',
  'code_execution',
  'image_input',
  'pdf_input',
  'structured_outputs',
] as const);
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

export type AnthropicExecuteSnapshot<Output extends JsonValue> = Readonly<{
  requestId: string;
  modelId: string;
  blocks: readonly ProviderBlock[];
  outputJsonSchema: Readonly<Record<string, JsonValue>>;
  parseOutput: (value: unknown) => Output;
  timeoutMs: number;
  maxOutputTokens: number;
  signal: AbortSignal;
}>;

export const anthropicApiError = (code: ProviderErrorCode): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);

export const sanitizeAnthropicApiFailure = (error: unknown): AppError =>
  AppError.isTrusted(error) ? error : anthropicApiError('PROVIDER_EXECUTION_FAILED');

const outputInvalid = (): AppError => anthropicApiError('PROVIDER_OUTPUT_INVALID');

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
  const copy = Object.create(null) as Record<string, unknown>;
  let enumerableCount = 0;
  for (const key in value) {
    enumerableCount += 1;
    if (enumerableCount > allowedKeys.size || !Object.hasOwn(value, key) || !allowedKeys.has(key)) {
      throw outputInvalid();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw outputInvalid();
    }
    Object.defineProperty(copy, key, { enumerable: true, value: descriptor.value });
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== enumerableCount || ownKeys.some((key) => typeof key !== 'string')) {
    throw outputInvalid();
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(copy, key)) throw outputInvalid();
  }
  return Object.freeze(copy);
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
  let enumerableCount = 0;
  for (const key in value) {
    enumerableCount += 1;
    if (
      enumerableCount > length ||
      !Object.hasOwn(value, key) ||
      !ARRAY_INDEX_PATTERN.test(key) ||
      Number(key) >= length
    ) {
      throw outputInvalid();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw outputInvalid();
    }
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    enumerableCount !== length ||
    ownKeys.length !== length + 1 ||
    ownKeys.some((key) => typeof key !== 'string')
  ) {
    throw outputInvalid();
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw outputInvalid();
    }
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
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

const safeAdd = (left: number, right: number): number => {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw outputInvalid();
  return total;
};

const readModelId = (value: unknown): string => {
  const modelId = boundedString(value, MAX_ID_BYTES, false);
  if (!ModelIdSchema.safeParse(modelId).success) throw outputInvalid();
  return modelId;
};

export const assertAnthropicApiModelId = (value: string | null): string => {
  if (value === null || !ModelIdSchema.safeParse(value).success) {
    throw anthropicApiError('PROVIDER_MODEL_INCOMPATIBLE');
  }
  return value;
};

const isValidRfc3339 = (value: string): boolean => {
  const match = RFC3339_PATTERN.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
};

const readNullableModelId = (value: unknown): void => {
  if (value !== null) readModelId(value);
};

const validateSupported = (value: unknown): void => {
  const capability = readStrictObject(value, new Set(['supported']), new Set(['supported']));
  if (typeof capability.supported !== 'boolean') throw outputInvalid();
};

const validateCapabilities = (value: unknown): void => {
  if (value === null) return;
  const root = readStrictObject(value, CAPABILITY_KEYS, new Set());
  for (const key of SIMPLE_CAPABILITY_KEYS) {
    if (Object.hasOwn(root, key)) validateSupported(root[key]);
  }
  if (Object.hasOwn(root, 'context_management')) {
    const keys = new Set([
      'supported',
      'clear_thinking_20251015',
      'clear_tool_uses_20250919',
      'compact_20260112',
    ]);
    const context = readStrictObject(root.context_management, keys, keys);
    if (typeof context.supported !== 'boolean') throw outputInvalid();
    for (const key of ['clear_thinking_20251015', 'clear_tool_uses_20250919', 'compact_20260112']) {
      if (context[key] !== null) validateSupported(context[key]);
    }
  }
  if (Object.hasOwn(root, 'effort')) {
    const keys = new Set(['supported', 'low', 'medium', 'high', 'xhigh', 'max']);
    const effort = readStrictObject(root.effort, keys, keys);
    if (typeof effort.supported !== 'boolean') throw outputInvalid();
    for (const key of ['low', 'medium', 'high', 'xhigh', 'max']) validateSupported(effort[key]);
  }
  if (Object.hasOwn(root, 'thinking')) {
    const thinking = readStrictObject(
      root.thinking,
      new Set(['supported', 'types']),
      new Set(['supported', 'types']),
    );
    if (typeof thinking.supported !== 'boolean') throw outputInvalid();
    const types = readStrictObject(
      thinking.types,
      new Set(['adaptive', 'enabled']),
      new Set(['adaptive', 'enabled']),
    );
    validateSupported(types.adaptive);
    validateSupported(types.enabled);
  }
};

export const parseAnthropicModelList = (value: unknown): readonly ProviderModel[] => {
  try {
    const keys = new Set(['data', 'has_more', 'first_id', 'last_id']);
    const root = readStrictObject(value, keys, keys);
    if (root.has_more !== false) throw outputInvalid();
    readNullableModelId(root.first_id);
    readNullableModelId(root.last_id);
    const entries = readDenseArray(root.data, MAX_MODELS);
    const seen = new Set<string>();
    const result: ProviderModel[] = [];
    for (const entry of entries) {
      const item = readStrictObject(entry, MODEL_KEYS, MODEL_REQUIRED_KEYS);
      if (item.type !== 'model') throw outputInvalid();
      const modelId = readModelId(item.id);
      if (seen.has(modelId)) throw outputInvalid();
      seen.add(modelId);
      const rawDisplayName = boundedString(item.display_name, 4 * 120, false);
      if (CONTROL_OR_FORMAT_CHARACTER.test(rawDisplayName)) throw outputInvalid();
      const displayName = rawDisplayName.trim();
      if (displayName.length < 1 || displayName.length > 120) throw outputInvalid();
      const createdAt = boundedString(item.created_at, MAX_ID_BYTES, false);
      if (!isValidRfc3339(createdAt)) throw outputInvalid();
      for (const key of ['max_input_tokens', 'max_tokens']) {
        if (Object.hasOwn(item, key) && item[key] !== null) safeInteger(item[key]);
      }
      if (Object.hasOwn(item, 'capabilities')) validateCapabilities(item.capabilities);
      result.push(Object.freeze({ modelId, displayName, compatibility: 'unverified' }));
    }
    return Object.freeze(result);
  } catch (error) {
    if (AppError.isTrusted(error)) throw error;
    throw outputInvalid();
  }
};

const readContentBlockType = (value: unknown): string => {
  if (value === null || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) {
    throw outputInvalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw outputInvalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 8 || keys.some((key) => typeof key !== 'string')) throw outputInvalid();
  let enumerableCount = 0;
  for (const key in value) {
    enumerableCount += 1;
    if (!Object.hasOwn(value, key)) throw outputInvalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw outputInvalid();
    }
  }
  if (enumerableCount !== keys.length) throw outputInvalid();
  const type = Object.getOwnPropertyDescriptor(value, 'type');
  if (
    type === undefined ||
    !type.enumerable ||
    !('value' in type) ||
    typeof type.value !== 'string'
  ) {
    throw outputInvalid();
  }
  return type.value;
};

const validateToolUse = (value: unknown): never => {
  const tool = readStrictObject(
    value,
    new Set(['type', 'id', 'name', 'input']),
    new Set(['type', 'id', 'name', 'input']),
  );
  if (tool.type !== 'tool_use') throw outputInvalid();
  boundedString(tool.id, MAX_ID_BYTES, false);
  boundedString(tool.name, MAX_METADATA_BYTES, false);
  cloneAnthropicOwnedJson(tool.input, MAX_JSON_DEPTH, MAX_JSON_ENTRIES);
  throw anthropicApiError('PROVIDER_TOOL_ACTIVITY_DETECTED');
};

const readMessageText = (value: unknown): string => {
  const content = readDenseArray(value, MAX_CONTENT_BLOCKS);
  let text: string | null = null;
  for (const block of content) {
    const type = readContentBlockType(block);
    if (type === 'tool_use') validateToolUse(block);
    if (type === 'thinking') {
      if (text !== null) throw outputInvalid();
      const thinking = readStrictObject(
        block,
        new Set(['type', 'thinking', 'signature']),
        new Set(['type', 'thinking', 'signature']),
      );
      boundedString(thinking.thinking, MAX_TEXT_BYTES);
      boundedString(thinking.signature, MAX_TEXT_BYTES);
      continue;
    }
    if (type === 'redacted_thinking') {
      if (text !== null) throw outputInvalid();
      const redacted = readStrictObject(
        block,
        new Set(['type', 'data']),
        new Set(['type', 'data']),
      );
      boundedString(redacted.data, MAX_TEXT_BYTES);
      continue;
    }
    if (type !== 'text' || text !== null) throw outputInvalid();
    const textBlock = readStrictObject(block, new Set(['type', 'text']), new Set(['type', 'text']));
    text = boundedString(textBlock.text, MAX_TEXT_BYTES, false);
  }
  if (text === null) throw outputInvalid();
  return text;
};

const parseUsage = (value: unknown) => {
  const allowed = new Set([
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'cache_creation',
    'inference_geo',
    'output_tokens_details',
    'server_tool_use',
    'service_tier',
  ]);
  const root = readStrictObject(value, allowed, new Set(['input_tokens', 'output_tokens']));
  const inputTokens = safeInteger(root.input_tokens);
  const outputTokens = safeInteger(root.output_tokens);
  const cacheCreation = Object.hasOwn(root, 'cache_creation_input_tokens')
    ? safeInteger(root.cache_creation_input_tokens)
    : 0;
  const cacheRead = Object.hasOwn(root, 'cache_read_input_tokens')
    ? safeInteger(root.cache_read_input_tokens)
    : 0;
  if (Object.hasOwn(root, 'cache_creation')) {
    const cache = readStrictObject(
      root.cache_creation,
      new Set(['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens']),
      new Set(['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens']),
    );
    safeInteger(cache.ephemeral_1h_input_tokens);
    safeInteger(cache.ephemeral_5m_input_tokens);
  }
  if (Object.hasOwn(root, 'inference_geo')) {
    const inferenceGeo = boundedString(root.inference_geo, MAX_METADATA_BYTES, false);
    if (CONTROL_OR_FORMAT_CHARACTER.test(inferenceGeo)) throw outputInvalid();
  }
  if (Object.hasOwn(root, 'output_tokens_details')) {
    const details = readStrictObject(
      root.output_tokens_details,
      new Set(['thinking_tokens']),
      new Set(['thinking_tokens']),
    );
    if (safeInteger(details.thinking_tokens) > outputTokens) throw outputInvalid();
  }
  if (Object.hasOwn(root, 'server_tool_use')) {
    const tools = readStrictObject(
      root.server_tool_use,
      new Set(['web_fetch_requests', 'web_search_requests']),
      new Set(['web_fetch_requests', 'web_search_requests']),
    );
    const fetches = safeInteger(tools.web_fetch_requests);
    const searches = safeInteger(tools.web_search_requests);
    if (fetches !== 0 || searches !== 0) {
      throw anthropicApiError('PROVIDER_TOOL_ACTIVITY_DETECTED');
    }
  }
  if (
    Object.hasOwn(root, 'service_tier') &&
    root.service_tier !== 'standard' &&
    root.service_tier !== 'priority' &&
    root.service_tier !== 'batch'
  ) {
    throw outputInvalid();
  }
  const aggregateInput = safeAdd(safeAdd(inputTokens, cacheCreation), cacheRead);
  return Object.freeze({
    inputTokens: aggregateInput,
    outputTokens,
    totalTokens: safeAdd(aggregateInput, outputTokens),
  });
};

const parseGeneratedOutput = <Output extends JsonValue>(
  text: string,
  parseOutput: (value: unknown) => Output,
): Output => {
  let parsed: JsonValue;
  try {
    parsed = parseAnthropicOwnedJsonText(text, MAX_JSON_DEPTH, MAX_JSON_ENTRIES);
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
    return cloneAnthropicOwnedJson(local, MAX_JSON_DEPTH, MAX_JSON_ENTRIES) as Output;
  } catch {
    throw outputInvalid();
  }
};

const isIsoTimestamp = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

export const parseAnthropicMessage = <Output extends JsonValue>(
  value: unknown,
  parseOutput: (value: unknown) => Output,
  completedAt: string,
): ProviderExecution<Output> => {
  try {
    const keys = new Set([
      'id',
      'type',
      'role',
      'model',
      'content',
      'stop_reason',
      'stop_sequence',
      'usage',
    ]);
    const root = readStrictObject(value, keys, keys);
    boundedString(root.id, MAX_ID_BYTES, false);
    if (root.type !== 'message' || root.role !== 'assistant') throw outputInvalid();
    const reportedModelId = readModelId(root.model);
    if (root.stop_reason === 'refusal') throw anthropicApiError('PROVIDER_REFUSED');
    if (root.stop_reason === 'tool_use') {
      throw anthropicApiError('PROVIDER_TOOL_ACTIVITY_DETECTED');
    }
    if (root.stop_reason !== 'end_turn' || root.stop_sequence !== null) throw outputInvalid();
    const text = readMessageText(root.content);
    const parsedOutput = parseGeneratedOutput(text, parseOutput);
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

export const classifyAnthropicApiError = (status: number, value: JsonValue): ProviderErrorCode => {
  try {
    const rootKeys = new Set(['type', 'error', 'request_id']);
    const root = readStrictObject(value, rootKeys, rootKeys);
    if (root.type !== 'error') return 'PROVIDER_EXECUTION_FAILED';
    const error = readStrictObject(
      root.error,
      new Set(['type', 'message']),
      new Set(['type', 'message']),
    );
    const machineType = boundedString(error.type, MAX_ID_BYTES, false);
    boundedString(error.message, 64 * 1024);
    boundedString(root.request_id, MAX_ID_BYTES, false);
    if (!MACHINE_TYPE_PATTERN.test(machineType)) return 'PROVIDER_EXECUTION_FAILED';
    if ((status === 400 || status === 422) && machineType === 'invalid_request_error') {
      return 'PROVIDER_MODEL_INCOMPATIBLE';
    }
    if (status === 404 && machineType === 'not_found_error') {
      return 'PROVIDER_MODEL_INCOMPATIBLE';
    }
    return 'PROVIDER_EXECUTION_FAILED';
  } catch {
    return 'PROVIDER_EXECUTION_FAILED';
  }
};

type MessageBodyInput = Readonly<{
  modelId: string;
  blocks: readonly ProviderTextBlock[];
  outputJsonSchema: Readonly<Record<string, JsonValue>>;
  maxOutputTokens: number;
}>;

const readBlocks = (value: unknown): readonly ProviderBlock[] => {
  const rawBlocks = readDenseArray(value, MAX_BLOCKS);
  let bytes = 0;
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
    ) {
      throw outputInvalid();
    }
    bytes += Buffer.byteLength(block.text, 'utf8');
    if (bytes > MAX_BLOCK_BYTES) throw outputInvalid();
    return Object.freeze({
      role: block.role,
      kind: block.kind as ProviderTextBlock['kind'],
      text: block.text,
    });
  });
  return Object.freeze(blocks);
};

const renderBlocks = (
  blocks: readonly ProviderTextBlock[],
  role: ProviderTextBlock['role'],
): string =>
  JSON.stringify({
    blocks: blocks.flatMap((block, index) =>
      block.role === role ? [{ index, role: block.role, kind: block.kind, text: block.text }] : [],
    ),
  });

export const buildAnthropicMessageBody = (value: MessageBodyInput): JsonValue => {
  try {
    const input = readStrictObject(
      value,
      new Set(['modelId', 'blocks', 'outputJsonSchema', 'maxOutputTokens']),
      new Set(['modelId', 'blocks', 'outputJsonSchema', 'maxOutputTokens']),
    );
    const modelId = readModelId(input.modelId);
    const blocks = requireTextBlocks(readBlocks(input.blocks));
    const maxOutputTokens = safeInteger(input.maxOutputTokens);
    if (maxOutputTokens < 1 || maxOutputTokens > 65_536) throw outputInvalid();
    const schema = cloneAnthropicOwnedJson(
      input.outputJsonSchema,
      MAX_JSON_DEPTH,
      MAX_JSON_ENTRIES,
    );
    if (schema === null || Array.isArray(schema) || typeof schema !== 'object') {
      throw outputInvalid();
    }
    return Object.freeze({
      model: modelId,
      system: renderBlocks(blocks, 'system'),
      messages: Object.freeze([
        Object.freeze({ role: 'user', content: renderBlocks(blocks, 'user') }),
      ]),
      max_tokens: maxOutputTokens,
      stream: false,
      output_config: Object.freeze({
        format: Object.freeze({ type: 'json_schema', schema }),
      }),
    });
  } catch (error) {
    if (
      AppError.isTrusted(error) &&
      (error.code === 'PROVIDER_MODEL_INCOMPATIBLE' || error.code === 'PROVIDER_MEDIA_UNSUPPORTED')
    )
      throw error;
    throw anthropicApiError('PROVIDER_EXECUTION_FAILED');
  }
};

const readNullableString = (value: unknown): void => {
  if (value !== null && typeof value !== 'string') throw outputInvalid();
};

export const snapshotAnthropicExecuteRequest = <Output extends JsonValue>(
  value: ProviderRequest<Output>,
): AnthropicExecuteSnapshot<Output> => {
  try {
    const request = readStrictObject(value, REQUEST_KEYS, REQUEST_KEYS);
    if (
      typeof request.requestId !== 'string' ||
      !UUID_PATTERN.test(request.requestId) ||
      typeof request.feature !== 'string' ||
      !APP_OWNED_OUTPUT_SCHEMA_IDS.includes(
        request.outputSchemaId as (typeof APP_OWNED_OUTPUT_SCHEMA_IDS)[number],
      ) ||
      typeof request.parseOutput !== 'function' ||
      !(request.signal instanceof AbortSignal) ||
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
    ) {
      throw outputInvalid();
    }
    for (const key of [
      'jobId',
      'providerManagedHistoryConsentAt',
      'providerManagedHistoryConsentVersion',
      'sharedCredentialConsentAt',
      'sharedCredentialConsentVersion',
    ]) {
      readNullableString(request[key]);
    }
    const modelId = assertAnthropicApiModelId(request.modelId as string | null);
    const blocks = readBlocks(request.blocks);
    const schema = cloneAnthropicOwnedJson(
      request.outputJsonSchema,
      MAX_JSON_DEPTH,
      MAX_JSON_ENTRIES,
    );
    if (schema === null || Array.isArray(schema) || typeof schema !== 'object') {
      throw outputInvalid();
    }
    return Object.freeze({
      requestId: request.requestId,
      modelId,
      blocks,
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
    throw anthropicApiError('PROVIDER_EXECUTION_FAILED');
  }
};
