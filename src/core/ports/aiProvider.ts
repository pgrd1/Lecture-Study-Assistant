import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { type SourceMediaType, SourceMediaTypeSchema } from '../../shared/contracts/job';
import { AI_FEATURES } from '../../shared/contracts/provider';

export { assertProviderSupportsBlocks, requireTextBlocks } from './providerCapabilities';

import type {
  AiFeature,
  AiProviderId,
  ApiProviderId,
  CliProviderId,
  JsonValue,
  ProviderModel,
  ProviderStatus,
  SafeSemVer,
} from '../../shared/contracts/provider';
import type { ProviderErrorCode } from '../../shared/errors';
import { freezeJsonCopy } from '../providers/canonicalJson';
import type { SecretKey } from './secretStore';

export type ProviderTextBlock = Readonly<{
  role: 'system' | 'user';
  kind: 'instruction' | 'source' | 'professor_note' | 'format_repair';
  text: string;
}>;

export type ProviderFileBlock = Readonly<{
  role: 'user';
  kind: 'source_file';
  sourceId: string;
  filePath: string;
  mediaType: SourceMediaType;
  sha256: string;
  sizeBytes: number;
}>;
export type ProviderBlock = ProviderTextBlock | ProviderFileBlock;
const ProviderFileBlockSchema = z
  .strictObject({
    role: z.literal('user'),
    kind: z.literal('source_file'),
    sourceId: z.uuid(),
    filePath: z
      .string()
      .min(1)
      .max(32_768)
      .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v)),
    mediaType: SourceMediaTypeSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024),
  })
  .readonly();

export interface ProviderOperation<Output extends JsonValue> {
  readonly composedPromptSha256?: string;
  readonly requestId: string;
  readonly feature: AiFeature;
  readonly jobId: string | null;
  readonly outputSchemaId: string;
  readonly outputJsonSchema: Readonly<Record<string, JsonValue>>;
  readonly parseOutput: (value: unknown) => Output;
  readonly blocks: readonly ProviderBlock[];
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

export type ProviderConnectionOperation = Readonly<{
  requestId: string;
  signal: AbortSignal;
}>;

export type ProviderUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

export type ProviderExecution<Output extends JsonValue> = Readonly<{
  output: Output;
  reportedModelId: string | null;
  usage: ProviderUsage;
  completedAt: string;
}>;

export type CliCredentialScopeFor<Id extends CliProviderId> = Id extends 'codex_cli'
  ? 'profile_scoped'
  : 'provider_global';

export type CliRuntimeBinding<
  Id extends CliProviderId = CliProviderId,
  Scope extends CliCredentialScopeFor<Id> = CliCredentialScopeFor<Id>,
> = Id extends CliProviderId
  ? Scope extends CliCredentialScopeFor<Id>
    ? Readonly<{
        providerId: Id;
        canonicalLauncherPath: string;
        canonicalEntryPath: string | null;
        canonicalPackageManifestPath: string | null;
        canonicalPlatformPackageManifestPath: string | null;
        fixedPrefixArgs: readonly string[];
        version: SafeSemVer;
        launcherSha256: string;
        entrySha256: string | null;
        packageManifestSha256: string | null;
        platformPackageManifestSha256: string | null;
        bindingSha256: string;
        recipeId: string;
        credentialScope: Scope;
        signerClassification: 'google' | 'openai' | 'nodejs';
        checkedAt: string;
      }>
    : never
  : never;

type ApiProviderInspection = Readonly<{
  status: ProviderStatus;
  version: null;
  credentialPresent: boolean;
  credentialScope: 'not_applicable';
  cliBinding: null;
  providerManagedHistory: false;
}>;

type ProfileScopedCliProviderInspection<Id extends 'codex_cli'> = Readonly<{
  status: ProviderStatus;
  version: SafeSemVer;
  credentialPresent: boolean;
  credentialScope: 'profile_scoped';
  cliBinding: CliRuntimeBinding<Id>;
  providerManagedHistory: boolean;
}>;

type ProviderGlobalCliProviderInspection<Id extends Exclude<CliProviderId, 'codex_cli'>> =
  Readonly<{
    status: ProviderStatus;
    version: SafeSemVer;
    credentialPresent: boolean;
    credentialScope: 'provider_global';
    cliBinding: CliRuntimeBinding<Id>;
    providerManagedHistory: boolean;
  }>;

type UnboundCliProviderInspection = Readonly<{
  status: Exclude<ProviderStatus, 'ready' | 'installed' | 'credential_saved'>;
  version: null;
  credentialPresent: false;
  credentialScope: 'unknown';
  cliBinding: null;
  providerManagedHistory: false;
}>;

export type ProviderInspection<Id extends AiProviderId = AiProviderId> = Id extends ApiProviderId
  ? ApiProviderInspection
  : Id extends 'codex_cli'
    ? ProfileScopedCliProviderInspection<Id> | UnboundCliProviderInspection
    : Id extends Exclude<CliProviderId, 'codex_cli'>
      ? ProviderGlobalCliProviderInspection<Id> | UnboundCliProviderInspection
      : never;

export type ProviderProbeEvidence = Readonly<{
  status: 'ready';
  reportedModelId: string | null;
  latencyMs: number;
  usage: ProviderUsage;
  providerManagedHistory: boolean;
}>;

export interface ProviderRequest<Output extends JsonValue> extends ProviderOperation<Output> {
  readonly modelId: string | null;
  readonly promptVersion: string;
  readonly routeRevision: number;
  readonly providerManagedHistoryConsentAt: string | null;
  readonly providerManagedHistoryConsentVersion: string | null;
  readonly sharedCredentialConsentAt: string | null;
  readonly sharedCredentialConsentVersion: string | null;
  readonly attemptKind: 'initial' | 'transient_retry' | 'format_repair';
}

interface AiProviderAdapterContract<Id extends AiProviderId> {
  readonly id: Id;
  inspect(operation: ProviderConnectionOperation): Promise<ProviderInspection<Id>>;
  listModels(operation: ProviderConnectionOperation): Promise<readonly ProviderModel[]>;
  probe(
    modelId: string | null,
    operation: ProviderConnectionOperation,
  ): Promise<ProviderProbeEvidence>;
  /**
   * Preserve trusted lower-layer AppError identity so bounded retry metadata survives routing.
   * Unknown failures must be replaced with a central fixed provider error without a cause.
   */
  execute<Output extends JsonValue>(
    request: ProviderRequest<Output>,
  ): Promise<ProviderExecution<Output>>;
  cancel(requestId: string): void;
}

export type AiProviderAdapter<Id extends AiProviderId = AiProviderId> = Id extends AiProviderId
  ? AiProviderAdapterContract<Id>
  : never;

type ProviderDiagnosticMetadata = Readonly<{
  status: ProviderStatus;
  selectedModelId: string | null;
  reportedModelId: string | null;
  credentialPresent: boolean;
  checkedAt: string | null;
  latencyMs: number | null;
  errorCode: ProviderErrorCode | null;
  revision: number;
}>;

type ApiProviderDiagnostic = ProviderDiagnosticMetadata &
  Readonly<{
    providerId: ApiProviderId;
    version: null;
    credentialScope: 'not_applicable';
    sharedCredentialConsentAt: null;
    sharedCredentialConsentVersion: null;
    cliBinding: null;
    providerManagedHistory: false;
  }>;

type ProfileScopedCliProviderDiagnostic<Id extends 'codex_cli'> = ProviderDiagnosticMetadata &
  Readonly<{
    providerId: Id;
    version: SafeSemVer;
    credentialScope: 'profile_scoped';
    sharedCredentialConsentAt: null;
    sharedCredentialConsentVersion: null;
    cliBinding: CliRuntimeBinding<Id>;
    providerManagedHistory: boolean;
  }>;

type ProviderGlobalCredentialConsent =
  | Readonly<{
      sharedCredentialConsentAt: null;
      sharedCredentialConsentVersion: null;
    }>
  | Readonly<{
      sharedCredentialConsentAt: string;
      sharedCredentialConsentVersion: string;
    }>;

type ProviderGlobalCliProviderDiagnostic<Id extends Exclude<CliProviderId, 'codex_cli'>> =
  ProviderDiagnosticMetadata &
    Readonly<{
      providerId: Id;
      version: SafeSemVer;
      credentialScope: 'provider_global';
      cliBinding: CliRuntimeBinding<Id>;
      providerManagedHistory: boolean;
    }> &
    ProviderGlobalCredentialConsent;

type UnknownCliProviderDiagnostic<Id extends CliProviderId> = ProviderDiagnosticMetadata &
  Readonly<{
    providerId: Id;
    status: Exclude<ProviderStatus, 'ready' | 'installed' | 'credential_saved'>;
    version: null;
    credentialPresent: false;
    credentialScope: 'unknown';
    sharedCredentialConsentAt: null;
    sharedCredentialConsentVersion: null;
    cliBinding: null;
    providerManagedHistory: false;
  }>;

type CliProviderDiagnostic<Id extends CliProviderId = CliProviderId> = Id extends CliProviderId
  ? Id extends 'codex_cli'
    ? ProfileScopedCliProviderDiagnostic<Id> | UnknownCliProviderDiagnostic<Id>
    : Id extends Exclude<CliProviderId, 'codex_cli'>
      ? ProviderGlobalCliProviderDiagnostic<Id> | UnknownCliProviderDiagnostic<Id>
      : never
  : never;

export type ProviderDiagnostic = ApiProviderDiagnostic | CliProviderDiagnostic;

export const API_PROVIDER_SECRET_KEYS: Readonly<Record<ApiProviderId, SecretKey>> = Object.freeze({
  gemini_api: 'gemini_api_key',
  openai_api: 'openai_api_key',
  claude_api: 'anthropic_api_key',
});

const OutputSchemaIdSchema = z.string().regex(/^[a-z0-9_]{1,64}$/);
export const APP_OWNED_OUTPUT_SCHEMA_IDS = Object.freeze([
  'lecture_output',
  'content_classification',
  'evidence_segments',
  'topic_clusters',
  'study_content',
  'topic_clusters_v2',
  'study_content_v2',
  'study_verification_v1',
  'question_answer_v1',
] as const);
const MAX_BLOCK_BYTES = 8 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_ENTRIES = 10_000;

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const assertOwnKeySnapshot = (value: object, expectedCount: number, errorCode: string): void => {
  // JavaScript has no bounded iterator for hidden/symbol keys, and engines may snapshot
  // keys for `for...in`. The enumerable preflights still bound our explicit allocations;
  // this unavoidable final snapshot is what lets us reject every hidden and symbol key.
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedCount || keys.some((key) => typeof key !== 'string')) {
    throw new TypeError(errorCode);
  }
};

const assertDenseDataArray = (
  value: readonly unknown[],
  length: number,
  errorCode: string,
): void => {
  let enumerableIndexCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    enumerableIndexCount += 1;
    if (enumerableIndexCount > length || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      throw new TypeError(errorCode);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError(errorCode);
    }
  }
  if (enumerableIndexCount !== length) {
    throw new TypeError(errorCode);
  }
  assertOwnKeySnapshot(value, length + 1, errorCode);
};

const readDataProperties = (
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== 'object' || !isPlainObject(value)) {
    throw new TypeError('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
  }
  let enumerablePropertyCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    enumerablePropertyCount += 1;
    if (enumerablePropertyCount > expectedKeys.length || !expectedKeys.includes(key)) {
      throw new TypeError('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
    }
  }
  if (enumerablePropertyCount !== expectedKeys.length) {
    throw new TypeError('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
  }
  assertOwnKeySnapshot(value, expectedKeys.length, 'INVALID_PROVIDER_OPERATION_DESCRIPTOR');
  const copied: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
    }
    copied[key] = descriptor.value;
  }
  return copied;
};

const readDataArray = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new TypeError('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
  }
  const length = lengthDescriptor.value;
  if (length > MAX_SCHEMA_ENTRIES) {
    throw new TypeError('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
  }
  assertDenseDataArray(value, length, 'INVALID_PROVIDER_OPERATION_DESCRIPTOR');
  const copied: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
    }
    copied.push(descriptor.value);
  }
  return copied;
};

export const snapshotProviderFileBlock = (value: unknown): ProviderFileBlock =>
  ProviderFileBlockSchema.parse(
    readDataProperties(value, [
      'role',
      'kind',
      'sourceId',
      'filePath',
      'mediaType',
      'sha256',
      'sizeBytes',
    ]),
  );

export const createProviderConnectionOperation = (
  descriptor: Readonly<{ requestId: string; signal: AbortSignal }>,
): ProviderConnectionOperation => {
  let values: Readonly<Record<string, unknown>>;
  try {
    values = readDataProperties(descriptor, ['requestId', 'signal']);
  } catch {
    throw new TypeError('INVALID_PROVIDER_CONNECTION_OPERATION');
  }
  if (
    typeof values.requestId !== 'string' ||
    !z.uuid().safeParse(values.requestId).success ||
    !(values.signal instanceof AbortSignal)
  ) {
    throw new TypeError('INVALID_PROVIDER_CONNECTION_OPERATION');
  }
  return Object.freeze({
    requestId: values.requestId,
    signal: values.signal,
  });
};

const addJsonBytes = (total: number, value: null | boolean | number | string): number => {
  const encoded = JSON.stringify(value);
  const next = total + Buffer.byteLength(encoded, 'utf8');
  if (next > MAX_SCHEMA_BYTES) {
    throw new TypeError('PROVIDER_OUTPUT_SCHEMA_TOO_LARGE');
  }
  return next;
};

const validateBoundedJsonSchema = (schema: unknown): JsonValue => {
  const holder: { value: JsonValue | null } = { value: null };
  const stack: Array<{
    readonly value: unknown;
    readonly depth: number;
    readonly assign: (copy: JsonValue) => void;
  }> = [
    {
      value: schema,
      depth: 1,
      assign: (copy) => {
        holder.value = copy;
      },
    },
  ];
  const seen = new WeakSet<object>();
  let entries = 0;
  let byteCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (current.depth > MAX_SCHEMA_DEPTH) {
      throw new TypeError('PROVIDER_OUTPUT_SCHEMA_TOO_LARGE');
    }
    if (
      current.value === null ||
      typeof current.value === 'boolean' ||
      typeof current.value === 'string'
    ) {
      byteCount = addJsonBytes(byteCount, current.value);
      current.assign(current.value);
      continue;
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) {
        throw new TypeError('INVALID_PROVIDER_OUTPUT_SCHEMA');
      }
      byteCount = addJsonBytes(byteCount, current.value);
      current.assign(Object.is(current.value, -0) ? 0 : current.value);
      continue;
    }
    if (typeof current.value !== 'object' || seen.has(current.value)) {
      throw new TypeError('INVALID_PROVIDER_OUTPUT_SCHEMA');
    }
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(current.value, 'length');
      if (
        lengthDescriptor === undefined ||
        !('value' in lengthDescriptor) ||
        typeof lengthDescriptor.value !== 'number'
      ) {
        throw new TypeError('INVALID_PROVIDER_OUTPUT_SCHEMA');
      }
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length < 0 || entries + length > MAX_SCHEMA_ENTRIES) {
        throw new TypeError('PROVIDER_OUTPUT_SCHEMA_TOO_LARGE');
      }
      assertDenseDataArray(current.value, length, 'INVALID_PROVIDER_OUTPUT_SCHEMA');
      entries += length;
      byteCount += 2 + Math.max(0, length - 1);
      if (byteCount > MAX_SCHEMA_BYTES) {
        throw new TypeError('PROVIDER_OUTPUT_SCHEMA_TOO_LARGE');
      }
      const copied: JsonValue[] = new Array(length);
      current.assign(copied);
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError('INVALID_PROVIDER_OUTPUT_SCHEMA');
        }
        stack.push({
          value: descriptor.value,
          depth: current.depth + 1,
          assign: (copy) => {
            copied[index] = copy;
          },
        });
      }
      continue;
    }
    if (!isPlainObject(current.value)) {
      throw new TypeError('INVALID_PROVIDER_OUTPUT_SCHEMA');
    }
    const copied: Record<string, JsonValue> = {};
    current.assign(copied);
    let objectEntries = 0;
    byteCount += 2;
    if (byteCount > MAX_SCHEMA_BYTES) {
      throw new TypeError('PROVIDER_OUTPUT_SCHEMA_TOO_LARGE');
    }
    for (const key in current.value) {
      if (!Object.hasOwn(current.value, key)) {
        continue;
      }
      entries += 1;
      objectEntries += 1;
      if (entries > MAX_SCHEMA_ENTRIES) {
        throw new TypeError('PROVIDER_OUTPUT_SCHEMA_TOO_LARGE');
      }
      byteCount += objectEntries === 1 ? 1 : 2;
      if (byteCount > MAX_SCHEMA_BYTES) {
        throw new TypeError('PROVIDER_OUTPUT_SCHEMA_TOO_LARGE');
      }
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError('INVALID_PROVIDER_OUTPUT_SCHEMA');
      }
      byteCount = addJsonBytes(byteCount, key);
      stack.push({
        value: descriptor.value,
        depth: current.depth + 1,
        assign: (copy) => {
          copied[key] = copy;
        },
      });
    }
    assertOwnKeySnapshot(current.value, objectEntries, 'INVALID_PROVIDER_OUTPUT_SCHEMA');
  }
  const copiedSchema = holder.value;
  if (copiedSchema === null || Array.isArray(copiedSchema) || typeof copiedSchema !== 'object') {
    throw new TypeError('INVALID_PROVIDER_OUTPUT_SCHEMA');
  }
  if (Buffer.byteLength(JSON.stringify(copiedSchema), 'utf8') > MAX_SCHEMA_BYTES) {
    throw new TypeError('PROVIDER_OUTPUT_SCHEMA_TOO_LARGE');
  }
  return copiedSchema;
};

export type ProviderOperationDescriptor<Output extends JsonValue> = Readonly<{
  composedPromptSha256?: string;
  requestId: string;
  feature: AiFeature;
  jobId: string | null;
  outputSchemaId: string;
  outputJsonSchema: Readonly<Record<string, JsonValue>>;
  parseOutput: (value: unknown) => Output;
  blocks: readonly ProviderBlock[];
  timeoutMs: number;
  maxOutputTokens: number;
  signal: AbortSignal;
}>;

export const createProviderOperation = <Output extends JsonValue>(
  descriptor: ProviderOperationDescriptor<Output>,
): ProviderOperation<Output> => {
  const values = readDataProperties(descriptor, [
    ...(Object.hasOwn(descriptor, 'composedPromptSha256') ? ['composedPromptSha256'] : []),
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
  ]);
  const requestId = values.requestId;
  const composedPromptSha256 =
    values.composedPromptSha256 === undefined
      ? undefined
      : z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(values.composedPromptSha256);
  const outputSchemaId = values.outputSchemaId;
  if (
    typeof requestId !== 'string' ||
    typeof outputSchemaId !== 'string' ||
    !z.uuid().safeParse(requestId).success ||
    !OutputSchemaIdSchema.safeParse(outputSchemaId).success ||
    !APP_OWNED_OUTPUT_SCHEMA_IDS.includes(
      outputSchemaId as (typeof APP_OWNED_OUTPUT_SCHEMA_IDS)[number],
    )
  ) {
    throw new TypeError('INVALID_PROVIDER_OPERATION_ID');
  }
  if (
    typeof values.feature !== 'string' ||
    !z.enum(AI_FEATURES).safeParse(values.feature).success ||
    (values.jobId !== null && !z.uuid().safeParse(values.jobId).success) ||
    typeof values.parseOutput !== 'function' ||
    !(values.signal instanceof AbortSignal)
  ) {
    throw new TypeError('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
  }
  const timeoutMs = values.timeoutMs;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 30_000 ||
    timeoutMs > 900_000
  ) {
    throw new TypeError('INVALID_PROVIDER_OPERATION_TIMEOUT');
  }
  const maxOutputTokens = values.maxOutputTokens;
  if (
    typeof maxOutputTokens !== 'number' ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 65_536
  ) {
    throw new TypeError('INVALID_PROVIDER_OPERATION_TOKEN_LIMIT');
  }
  const blocks = readDataArray(values.blocks).map((block) => {
    const kindDescriptor =
      block !== null && typeof block === 'object'
        ? Object.getOwnPropertyDescriptor(block, 'kind')
        : undefined;
    if (
      kindDescriptor !== undefined &&
      'value' in kindDescriptor &&
      kindDescriptor.value === 'source_file'
    ) {
      return ProviderFileBlockSchema.parse(
        readDataProperties(block, [
          'role',
          'kind',
          'sourceId',
          'filePath',
          'mediaType',
          'sha256',
          'sizeBytes',
        ]),
      );
    }
    const blockValues = readDataProperties(block, ['role', 'kind', 'text']);
    if (
      (blockValues.role !== 'system' && blockValues.role !== 'user') ||
      typeof blockValues.kind !== 'string' ||
      !['instruction', 'source', 'professor_note', 'format_repair'].includes(blockValues.kind) ||
      typeof blockValues.text !== 'string'
    ) {
      throw new TypeError('INVALID_PROVIDER_OPERATION_DESCRIPTOR');
    }
    return Object.freeze({
      role: blockValues.role,
      kind: blockValues.kind,
      text: blockValues.text,
    }) as ProviderTextBlock;
  });
  const totalBlockBytes = blocks.reduce(
    (total, block) =>
      total +
      (block.kind === 'source_file'
        ? Buffer.byteLength(block.filePath, 'utf8')
        : Buffer.byteLength(block.text, 'utf8')),
    0,
  );
  if (totalBlockBytes > MAX_BLOCK_BYTES) {
    throw new TypeError('PROVIDER_OPERATION_TOO_LARGE');
  }
  const schema = freezeJsonCopy(validateBoundedJsonSchema(values.outputJsonSchema));
  if (Array.isArray(schema) || schema === null || typeof schema !== 'object') {
    throw new TypeError('INVALID_PROVIDER_OUTPUT_SCHEMA');
  }
  const objectSchema = schema as Readonly<Record<string, JsonValue>>;
  if (objectSchema.type !== 'object' || objectSchema.additionalProperties !== false) {
    throw new TypeError('PROVIDER_OUTPUT_SCHEMA_MUST_BE_CLOSED_OBJECT');
  }
  return Object.freeze({
    requestId,
    ...(composedPromptSha256 === undefined ? {} : { composedPromptSha256 }),
    feature: values.feature as AiFeature,
    jobId: values.jobId as string | null,
    outputSchemaId,
    outputJsonSchema: objectSchema,
    parseOutput: values.parseOutput as (value: unknown) => Output,
    blocks: Object.freeze(blocks),
    timeoutMs,
    maxOutputTokens,
    signal: values.signal as AbortSignal,
  });
};
