import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type {
  CliRuntimeBinding,
  ProviderRequest,
  ProviderTextBlock,
  ProviderUsage,
} from '../../../core/ports/aiProvider';
import type { CliProcessResult } from '../../../core/ports/cliProcessRunner';
import { freezeJsonCopy } from '../../../core/providers/canonicalJson';
import {
  type JsonValue,
  ModelIdSchema,
  SHARED_CREDENTIAL_NOTICE_VERSION,
} from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError, type ProviderErrorCode } from '../../../shared/errors';
import { cloneBoundedJsonValue } from '../api/boundedJson';
import type { CliCredentialStatusEvidence } from './cliCredentialGuard';
import { isCanonicalAbsoluteWindowsPath } from './cliFileIntegrity';
import { assertBindingShape } from './cliIdentity';

export const GEMINI_RECIPE_ID = 'gemini-0.55-policy-json-v1';
export const GEMINI_MAX_STREAM_BYTES = 1024 * 1024;
const GEMINI_MAX_SCHEMA_BYTES = 1024 * 1024;
const GEMINI_MAX_EVENT_BYTES = 512 * 1024;
export const GEMINI_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const ROOTED_PRIVATE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/{2}|file:\/\/)/iu;

export const GEMINI_DENY_POLICY =
  '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\ninteractive = false\n';
export const GEMINI_TOOL_DENIAL_CANARY_PROMPT =
  '공개 연결 진단입니다. 등록된 도구를 하나 호출한 다음 정확히 { "ok": true } JSON만 응답하세요.';

const managedSettings = Object.freeze({
  mcpServers: Object.freeze({}),
  // [] falls back to the default policy directory; it is not an isolation control.
  policyPaths: Object.freeze([]),
  hooksConfig: Object.freeze({ enabled: false }),
  skills: Object.freeze({ enabled: false }),
  experimental: Object.freeze({
    enableAgents: false,
    adk: Object.freeze({ agentSessionNoninteractiveEnabled: false }),
  }),
  general: Object.freeze({
    enableAutoUpdate: false,
    enableAutoUpdateNotification: false,
    checkpointing: Object.freeze({ enabled: false }),
    maxAttempts: 1,
    debugKeystrokeLogging: false,
    logRagSnippets: false,
  }),
  privacy: Object.freeze({ usageStatisticsEnabled: false }),
  telemetry: Object.freeze({ enabled: false, logPrompts: false }),
  ide: Object.freeze({ enabled: false }),
});
export const GEMINI_MANAGED_SETTINGS_JSON = JSON.stringify(managedSettings);
export const GEMINI_ALLOWED_PROFILE_FILES = Object.freeze([
  'settings\\.gemini\\policies\\studyapp-deny-all.toml',
  'settings\\.gemini\\settings.json',
] as const);

export type GeminiBinding = CliRuntimeBinding<'gemini_cli', 'provider_global'>;
export type GeminiSharedConsent = Readonly<{ at: string | null; version: string | null }>;
export type GeminiCredentialStatus = Readonly<{
  managedProfilePath: string;
  evidence: CliCredentialStatusEvidence;
}>;
export type GeminiSettingsSchemaSnapshot = Readonly<{
  packageManifestSha256: string;
  relativePath: 'settings.schema.json';
  schemaSha256: string;
  contents: string;
}>;
export type GeminiManagedProfile = Readonly<{
  managedProfilePath: string;
  geminiCliHomePath: string;
  settingsPath: string;
  policyPath: string;
  settingsJson: string;
  policyText: string;
  settingsSha256: string;
  policySha256: string;
}>;
export type GeminiArtifactRoots = Readonly<{
  providerRuntimeRoot: string;
  providerProfilesRoot: string;
  providerWorkspaceRoot: string;
  providerTempRoot: string;
}>;
export type GeminiRequestArtifacts = Readonly<{ workspacePath: string }>;
export type GeminiParsedStream<Output extends JsonValue> = Readonly<{
  output: Output;
  reportedModelId: string | null;
  usage: ProviderUsage;
}>;

export const geminiError = (code: ProviderErrorCode): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);
export const isGeminiProviderError = (error: unknown): error is AppError =>
  AppError.isTrusted(error) && error.code.startsWith('PROVIDER_');
export const sanitizeGeminiFailure = (error: unknown): AppError =>
  isGeminiProviderError(error) ? error : geminiError('PROVIDER_EXECUTION_FAILED');

const sha256 = (contents: string): string =>
  createHash('sha256').update(contents, 'utf8').digest('hex');

const strictObject = (
  value: unknown,
  expectedKeys: readonly string[],
  failure: () => AppError,
): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw failure();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key)) ||
    Reflect.ownKeys(value).length !== keys.length
  ) {
    throw failure();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw failure();
    }
  }
  return value as Record<string, unknown>;
};

const parseJson = (text: string, maxBytes: number, failure: () => AppError): unknown => {
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > maxBytes) throw failure();
  try {
    const value: unknown = JSON.parse(text);
    cloneBoundedJsonValue(value, 32, 16_384);
    return value;
  } catch {
    throw failure();
  }
};

const parseCanonicalJson = (text: string, maxBytes: number, failure: () => AppError): unknown => {
  try {
    const value = parseJson(text, maxBytes, failure);
    if (JSON.stringify(value) !== text) throw failure();
    return value;
  } catch {
    throw failure();
  }
};

// Validate only the closed, application-owned managed subset against the published
// schema. Schema metadata/unrelated supported properties are not runtime guarantees.
const schemaObject = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw geminiError('PROVIDER_UNSAFE_VERSION');
  }
  return value as Record<string, unknown>;
};
const validateManagedSubset = (value: unknown, schema: unknown): void => {
  const node = schemaObject(schema);
  const supportedKeys = [
    'type',
    'title',
    'description',
    'markdownDescription',
    'default',
    'properties',
    'additionalProperties',
    'items',
    '$schema',
    '$id',
    '$defs',
  ];
  if (Object.keys(node).some((key) => !supportedKeys.includes(key))) {
    throw geminiError('PROVIDER_UNSAFE_VERSION');
  }
  if (Array.isArray(value)) {
    if (node.type !== 'array' || schemaObject(node.items).type !== 'string') {
      throw geminiError('PROVIDER_UNSAFE_VERSION');
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    if (node.type !== 'object') throw geminiError('PROVIDER_UNSAFE_VERSION');
    const entries = Object.entries(value);
    if (entries.length === 0) return;
    if (node.additionalProperties !== false) throw geminiError('PROVIDER_UNSAFE_VERSION');
    const properties = schemaObject(node.properties);
    for (const [key, setting] of entries) validateManagedSubset(setting, properties[key]);
    return;
  }
  if (node.type !== typeof value) throw geminiError('PROVIDER_UNSAFE_VERSION');
};

export const validateGeminiSettingsSchema = (
  binding: GeminiBinding,
  snapshot: GeminiSettingsSchemaSnapshot,
): string => {
  const failure = () => geminiError('PROVIDER_UNSAFE_VERSION');
  const value = strictObject(
    snapshot,
    ['packageManifestSha256', 'relativePath', 'schemaSha256', 'contents'],
    failure,
  );
  if (
    binding.packageManifestSha256 === null ||
    value.packageManifestSha256 !== binding.packageManifestSha256 ||
    value.relativePath !== 'settings.schema.json' ||
    typeof value.schemaSha256 !== 'string' ||
    !SHA_256_PATTERN.test(value.schemaSha256) ||
    typeof value.contents !== 'string' ||
    sha256(value.contents) !== value.schemaSha256
  ) {
    throw failure();
  }
  const root = schemaObject(parseJson(value.contents, GEMINI_MAX_SCHEMA_BYTES, failure));
  if (
    root.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
    root.title !== 'Gemini CLI Settings'
  )
    throw failure();
  validateManagedSubset(managedSettings, root);
  return value.schemaSha256;
};

export const assertGeminiBinding = (value: CliRuntimeBinding): GeminiBinding => {
  try {
    if (
      value.providerId !== 'gemini_cli' ||
      value.recipeId !== GEMINI_RECIPE_ID ||
      value.credentialScope !== 'provider_global' ||
      value.signerClassification !== 'nodejs' ||
      assertBindingShape(value) !== 'gemini_npm'
    ) {
      throw new Error('binding mismatch');
    }
    return value as GeminiBinding;
  } catch {
    throw geminiError('PROVIDER_UNSAFE_VERSION');
  }
};

export const assertGeminiRoots = (providerRuntimeRoot: string): GeminiArtifactRoots => {
  if (
    !isCanonicalAbsoluteWindowsPath(providerRuntimeRoot) ||
    !/^C:\\(?:[^\\]+\\)+providers$/u.test(providerRuntimeRoot) ||
    win32.basename(providerRuntimeRoot) !== 'providers'
  ) {
    throw geminiError('PROVIDER_UNSAFE_VERSION');
  }
  return Object.freeze({
    providerRuntimeRoot,
    providerProfilesRoot: win32.join(providerRuntimeRoot, 'profiles'),
    providerWorkspaceRoot: win32.join(providerRuntimeRoot, 'workspace'),
    providerTempRoot: win32.join(providerRuntimeRoot, 'temp'),
  });
};

export const createGeminiManagedProfile = (roots: GeminiArtifactRoots): GeminiManagedProfile => {
  const managedProfilePath = win32.join(roots.providerProfilesRoot, 'gemini_cli');
  const geminiCliHomePath = win32.join(managedProfilePath, 'settings');
  return Object.freeze({
    managedProfilePath,
    geminiCliHomePath,
    settingsPath: win32.join(geminiCliHomePath, '.gemini', 'settings.json'),
    policyPath: win32.join(geminiCliHomePath, '.gemini', 'policies', 'studyapp-deny-all.toml'),
    settingsJson: GEMINI_MANAGED_SETTINGS_JSON,
    policyText: GEMINI_DENY_POLICY,
    settingsSha256: sha256(GEMINI_MANAGED_SETTINGS_JSON),
    policySha256: sha256(GEMINI_DENY_POLICY),
  });
};

export const assertGeminiArtifacts = (
  requestId: string,
  artifacts: GeminiRequestArtifacts,
  roots: GeminiArtifactRoots,
): void => {
  if (
    !GEMINI_UUID_PATTERN.test(requestId) ||
    !isCanonicalAbsoluteWindowsPath(artifacts.workspacePath) ||
    artifacts.workspacePath !== win32.join(roots.providerWorkspaceRoot, requestId)
  ) {
    throw geminiError('PROVIDER_UNSAFE_VERSION');
  }
};

export const isGeminiIsoTimestamp = (value: string | null): boolean =>
  value !== null && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

export const assertGeminiConsent = (consent: GeminiSharedConsent): void => {
  const failure = () => geminiError('PROVIDER_SHARED_CREDENTIAL_CONSENT_REQUIRED');
  const value = strictObject(consent, ['at', 'version'], failure);
  if (
    typeof value.at !== 'string' ||
    !isGeminiIsoTimestamp(value.at) ||
    value.version !== SHARED_CREDENTIAL_NOTICE_VERSION
  ) {
    throw failure();
  }
};

export const assertGeminiModelId = (modelId: string | null): string | null => {
  if (modelId !== null && !ModelIdSchema.safeParse(modelId).success) {
    throw geminiError('PROVIDER_MODEL_INCOMPATIBLE');
  }
  return modelId;
};

export const readGeminiCredentialStatus = (
  status: GeminiCredentialStatus,
  activeProfileRoot: string,
): GeminiCredentialStatus => {
  const failure = () => geminiError('PROVIDER_UNSAFE_VERSION');
  const value = strictObject(status, ['managedProfilePath', 'evidence'], failure);
  if (
    typeof value.managedProfilePath !== 'string' ||
    value.managedProfilePath !== activeProfileRoot ||
    !isCanonicalAbsoluteWindowsPath(value.managedProfilePath)
  ) {
    throw failure();
  }
  return Object.freeze({
    managedProfilePath: value.managedProfilePath,
    evidence: value.evidence as CliCredentialStatusEvidence,
  });
};

export const assertGeminiProfileFiles = (fileNames: readonly string[]): void => {
  if (
    !Array.isArray(fileNames) ||
    fileNames.length !== GEMINI_ALLOWED_PROFILE_FILES.length ||
    Reflect.ownKeys(fileNames).length !== fileNames.length + 1
  ) {
    throw geminiError('PROVIDER_UNSAFE_VERSION');
  }
  const copied = fileNames.map((value) => {
    if (typeof value !== 'string') throw geminiError('PROVIDER_UNSAFE_VERSION');
    return value;
  });
  copied.sort();
  if (copied.some((value, index) => value !== GEMINI_ALLOWED_PROFILE_FILES[index])) {
    throw geminiError('PROVIDER_UNSAFE_VERSION');
  }
};

const FIXED_EXIT_ERRORS: Readonly<Record<string, ProviderErrorCode>> = Object.freeze({
  'This account type is no longer supported by Gemini CLI. Use Antigravity CLI.':
    'PROVIDER_ACCOUNT_UNSUPPORTED',
});

export const assertGeminiSuccess = (result: CliProcessResult): void => {
  if (result.exitCode !== 0) {
    const stdout = result.stdout.replace(/\r?\n$/u, '');
    const stderr = result.stderr.replace(/\r?\n$/u, '');
    const token = stdout.length === 0 ? stderr : stderr.length === 0 ? stdout : '';
    throw geminiError(FIXED_EXIT_ERRORS[token] ?? 'PROVIDER_EXECUTION_FAILED');
  }
  if (result.stderr.length !== 0) throw geminiError('PROVIDER_OUTPUT_INVALID');
};

const containsPrivatePath = (value: unknown): boolean => {
  if (typeof value === 'string') return ROOTED_PRIVATE_PATH.test(value);
  if (Array.isArray(value)) return value.some(containsPrivatePath);
  return value !== null && typeof value === 'object'
    ? Object.values(value as Record<string, unknown>).some(containsPrivatePath)
    : false;
};

const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'total_tokens', 'cached', 'input'] as const;
const validCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const parseStats = (value: unknown, configuredModel: string) => {
  const failure = () => geminiError('PROVIDER_OUTPUT_INVALID');
  if (value === undefined)
    return Object.freeze({
      reportedModelId: null,
      usage: Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null }),
    });
  const stats = strictObject(
    value,
    [...TOKEN_KEYS, 'duration_ms', 'tool_calls', 'models'],
    failure,
  );
  if (![...TOKEN_KEYS, 'duration_ms', 'tool_calls'].every((key) => validCount(stats[key])))
    throw failure();
  if (stats.tool_calls !== 0) throw geminiError('PROVIDER_TOOL_ACTIVITY_DETECTED');
  const models = schemaObject(stats.models);
  const modelNames = Object.keys(models);
  if (modelNames.length !== 1 || modelNames[0] !== configuredModel) {
    throw geminiError('PROVIDER_MODEL_INCOMPATIBLE');
  }
  const modelStats = strictObject(models[configuredModel], TOKEN_KEYS, failure);
  if (!TOKEN_KEYS.every((key) => validCount(modelStats[key]) && modelStats[key] === stats[key]))
    throw failure();
  if ((stats.cached as number) + (stats.input as number) !== stats.input_tokens) throw failure();
  return Object.freeze({
    reportedModelId: configuredModel,
    usage: Object.freeze({
      inputTokens: stats.input_tokens as number,
      outputTokens: stats.output_tokens as number,
      totalTokens: stats.total_tokens as number,
    }),
  });
};

const parseStreamLines = (stdout: string): readonly unknown[] => {
  const failure = () => geminiError('PROVIDER_OUTPUT_INVALID');
  if (stdout.length === 0 || Buffer.byteLength(stdout, 'utf8') > GEMINI_MAX_STREAM_BYTES) {
    throw failure();
  }
  const body = stdout.endsWith('\r\n')
    ? stdout.slice(0, -2)
    : stdout.endsWith('\n')
      ? stdout.slice(0, -1)
      : stdout;
  const normalized = body.replaceAll('\r\n', '\n');
  if (normalized.includes('\r')) throw failure();
  const lines = normalized.split('\n');
  if (
    lines.length < 2 ||
    lines.length > 4096 ||
    lines.some(
      (line) => line.length === 0 || Buffer.byteLength(line, 'utf8') > GEMINI_MAX_EVENT_BYTES,
    )
  ) {
    throw failure();
  }
  return Object.freeze(
    lines.map((line) => {
      return parseCanonicalJson(line, GEMINI_MAX_EVENT_BYTES, failure);
    }),
  );
};

// Closed normal-branch policy: init, one user echo, assistant deltas, one success
// result. No tools (even denied attempts), warnings, ADK events, or reroutes.
// Session IDs are CLI-owned, not application request IDs. Auth is absent here.
export const parseGeminiStream = <Output extends JsonValue>(
  stdout: string,
  requestId: string,
  selectedModelId: string | null,
  parseOutput: (value: unknown) => Output,
): GeminiParsedStream<Output> => {
  const failure = () => geminiError('PROVIDER_OUTPUT_INVALID');
  if (!GEMINI_UUID_PATTERN.test(requestId)) throw failure();
  const events = parseStreamLines(stdout);
  for (const event of events) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) throw failure();
    const record = event as Record<string, unknown>;
    if (record.type === 'tool_use' || record.type === 'tool_result')
      throw geminiError('PROVIDER_TOOL_ACTIVITY_DETECTED');
    if (typeof record.timestamp !== 'string' || !isGeminiIsoTimestamp(record.timestamp))
      throw failure();
  }
  if (events.length < 4) throw failure();
  const init = strictObject(events[0], ['type', 'timestamp', 'session_id', 'model'], failure);
  if (
    init.type !== 'init' ||
    typeof init.session_id !== 'string' ||
    !GEMINI_UUID_PATTERN.test(init.session_id) ||
    typeof init.model !== 'string' ||
    !ModelIdSchema.safeParse(init.model).success
  )
    throw failure();
  if (selectedModelId !== null && init.model !== selectedModelId)
    throw geminiError('PROVIDER_MODEL_INCOMPATIBLE');
  const echo = strictObject(events[1], ['type', 'timestamp', 'role', 'content'], failure);
  if (echo.type !== 'message' || echo.role !== 'user' || typeof echo.content !== 'string')
    throw failure();
  const text = events
    .slice(2, -1)
    .map((event) => {
      const message = strictObject(
        event,
        ['type', 'timestamp', 'role', 'content', 'delta'],
        failure,
      );
      if (
        message.type !== 'message' ||
        message.role !== 'assistant' ||
        message.delta !== true ||
        typeof message.content !== 'string'
      )
        throw failure();
      return message.content;
    })
    .join('');
  const terminal = events.at(-1) as Record<string, unknown>;
  const result = strictObject(
    terminal,
    ['type', 'timestamp', 'status', ...('stats' in terminal ? ['stats'] : [])],
    failure,
  );
  if (result.type !== 'result' || result.status !== 'success') throw failure();
  let parsedStats: ReturnType<typeof parseStats>;
  try {
    parsedStats = parseStats(result.stats, init.model);
  } catch (error) {
    if (isGeminiProviderError(error) && error.code !== 'PROVIDER_UNSAFE_VERSION') throw error;
    throw failure();
  }
  let output: Output;
  try {
    const rawOutput = parseCanonicalJson(text, GEMINI_MAX_EVENT_BYTES, failure);
    if (containsPrivatePath(rawOutput)) throw failure();
    output = freezeJsonCopy(parseOutput(rawOutput));
  } catch {
    throw failure();
  }
  return Object.freeze({ output, ...parsedStats });
};

export const buildGeminiPrompt = (
  blocks: readonly ProviderTextBlock[],
  outputJsonSchema: Readonly<Record<string, JsonValue>>,
): string =>
  JSON.stringify({
    blocks: blocks.map(({ role, kind, text }) => ({ role, kind, text })),
    outputJsonSchema,
  }).replaceAll('@', '\\u0040');

export const buildGeminiProbePrompt = (): string =>
  JSON.stringify({
    blocks: [{ role: 'user', kind: 'instruction', text: GEMINI_TOOL_DENIAL_CANARY_PROMPT }],
    outputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { const: true } },
    },
  });

export const buildGeminiStdin = (prompt: string): string => `${prompt}\n`;

// Only options declared by the stock v0.55.1 strict parser. Piped stdin/stdout
// establish headless mode; none of these flags attest effective policy loading.
export const buildGeminiArgs = (
  fixedPrefixArgs: readonly string[],
  policyPath: string,
  selectedModelId: string | null,
): readonly string[] =>
  Object.freeze([
    ...fixedPrefixArgs,
    '--output-format',
    'stream-json',
    '--approval-mode',
    'default',
    '--admin-policy',
    policyPath,
    ...(selectedModelId === null ? [] : ['--model', selectedModelId]),
  ]);

export const assertGeminiExecuteConsent = (request: ProviderRequest<JsonValue>): void =>
  assertGeminiConsent({
    at: request.sharedCredentialConsentAt,
    version: request.sharedCredentialConsentVersion,
  });
