import { Buffer } from 'node:buffer';
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
  ANTIGRAVITY_HISTORY_NOTICE_VERSION,
  type JsonValue,
  type ProviderModel,
  SHARED_CREDENTIAL_NOTICE_VERSION,
} from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError, type ProviderErrorCode } from '../../../shared/errors';
import type { CliCredentialStatusEvidence } from './cliCredentialGuard';
import { isCanonicalAbsoluteWindowsPath, sameWindowsPath } from './cliFileIntegrity';
import { assertBindingShape } from './cliIdentity';

export const ANTIGRAVITY_RECIPE_ID = 'antigravity-1.1-stream-json-v1';
export const ANTIGRAVITY_MAX_HELP_BYTES = 16 * 1024;
export const ANTIGRAVITY_MAX_DIAGNOSTIC_BYTES = 64 * 1024;
export const ANTIGRAVITY_MAX_MODEL_LIST_BYTES = 128 * 1024;
export const ANTIGRAVITY_MAX_STREAM_BYTES = 1024 * 1024;
const ANTIGRAVITY_1_1_MODEL_ID_GRAMMAR = Object.freeze({
  family: 'gemini',
  tiers: Object.freeze([
    Object.freeze({
      token: 'pro',
      capabilitySuffixes: Object.freeze(['high', 'low'] as const),
    }),
    Object.freeze({
      token: 'flash',
      capabilitySuffixes: Object.freeze(['lite'] as const),
    }),
  ]),
  lifecycleSuffixes: Object.freeze(['preview', 'experimental'] as const),
});
const MAX_NDJSON_LINES = 512;
const MAX_NDJSON_LINE_BYTES = 256 * 1024;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/u;
const MODEL_SEMANTIC_VERSION_PATTERN = /^(?:[1-9]|[1-9][0-9])\.(?:0|[1-9][0-9]?)$/u;
export const ANTIGRAVITY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROOTED_PRIVATE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/{2}|file:\/\/)/iu;
const MODEL_DISPLAY_EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,64}/iu;
const MODEL_DISPLAY_SENSITIVE_LABEL =
  /(?:^|[^A-Z0-9])(?:account|quota|billing|usage|subscription|credits?|계정|할당량|결제|사용량|구독|크레딧)(?:$|[^A-Z0-9])/iu;
const MODEL_DISPLAY_PERCENTAGE = /\d+(?:\.\d+)?\s*%/u;
const MODEL_DISPLAY_CURRENCY =
  /(?:\p{Sc}\s*\d|\d(?:[.,]\d+)?\s*\p{Sc}|(?:^|[^A-Z0-9])(?:USD|EUR|GBP|JPY|KRW|CNY)\s*\d|\d(?:[.,]\d+)?\s*(?:USD|EUR|GBP|JPY|KRW|CNY)(?:$|[^A-Z0-9]))/iu;
const MODEL_DISPLAY_COUNTER = /(?:^|\s)\d+\s*(?:\/|of)\s*\d+(?:\s|$)/iu;
const MODEL_DISPLAY_UUID =
  /(?:^|[^A-F0-9])[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}(?:$|[^A-F0-9])/iu;
const MODEL_DISPLAY_LONG_IDENTIFIER = /(?:^|[^A-Z0-9])[A-Z0-9_-]{24,}(?:$|[^A-Z0-9])/iu;
const MODEL_DISPLAY_UNIX_PATH = /(?:^|[^\p{L}\p{N}._-])\/(?:[^/\s][^\s]*)/u;
const MODEL_DISPLAY_RELATIVE_PATH = /(?:^|\s)(?:\.\.|~)[\\/][^\s]*/u;
const MODEL_DISPLAY_VARIABLE_PATH =
  /(?:%[A-Z_][A-Z0-9_]*%|\$[A-Z_][A-Z0-9_]*|\$\{[A-Z_][A-Z0-9_]*\})[\\/]/iu;
const MODEL_DISPLAY_CANONICAL_PATTERN = /^[A-Za-z0-9]+(?:[ ._-][A-Za-z0-9]+)*$/u;

const isAntigravityRecipeModelId = (modelId: string): boolean => {
  if (!MODEL_ID_PATTERN.test(modelId)) {
    return false;
  }
  const [family, version, productTier, firstSuffix, secondSuffix, ...extraTokens] =
    modelId.split('-');
  if (
    family !== ANTIGRAVITY_1_1_MODEL_ID_GRAMMAR.family ||
    version === undefined ||
    !MODEL_SEMANTIC_VERSION_PATTERN.test(version) ||
    productTier === undefined ||
    extraTokens.length > 0
  ) {
    return false;
  }
  const tier = ANTIGRAVITY_1_1_MODEL_ID_GRAMMAR.tiers.find(
    (candidate) => candidate.token === productTier,
  );
  if (tier === undefined) {
    return false;
  }
  if (firstSuffix === undefined) {
    return secondSuffix === undefined;
  }
  const isLifecycle = ANTIGRAVITY_1_1_MODEL_ID_GRAMMAR.lifecycleSuffixes.some(
    (suffix) => suffix === firstSuffix,
  );
  if (isLifecycle) {
    return secondSuffix === undefined;
  }
  const isCapability = tier.capabilitySuffixes.some((suffix) => suffix === firstSuffix);
  if (!isCapability) {
    return false;
  }
  return (
    secondSuffix === undefined ||
    ANTIGRAVITY_1_1_MODEL_ID_GRAMMAR.lifecycleSuffixes.some((suffix) => suffix === secondSuffix)
  );
};

const hasEquivalentModelTokens = (modelId: string, displayName: string): boolean => {
  if (!MODEL_DISPLAY_CANONICAL_PATTERN.test(displayName)) {
    return false;
  }
  const modelTokens = modelId.split(/[._-]/u);
  const displayTokens = displayName.split(/[ ._-]/u);
  return (
    !modelTokens.includes('') &&
    modelTokens.length === displayTokens.length &&
    modelTokens.every((token, index) => token === displayTokens[index]?.toLowerCase())
  );
};

const isSafeModelDisplayName = (value: string): boolean =>
  !ROOTED_PRIVATE_PATH.test(value) &&
  !MODEL_DISPLAY_EMAIL.test(value) &&
  !MODEL_DISPLAY_SENSITIVE_LABEL.test(value) &&
  !MODEL_DISPLAY_PERCENTAGE.test(value) &&
  !MODEL_DISPLAY_CURRENCY.test(value) &&
  !MODEL_DISPLAY_COUNTER.test(value) &&
  !MODEL_DISPLAY_UUID.test(value) &&
  !MODEL_DISPLAY_LONG_IDENTIFIER.test(value) &&
  !MODEL_DISPLAY_UNIX_PATH.test(value) &&
  !MODEL_DISPLAY_RELATIVE_PATH.test(value) &&
  !MODEL_DISPLAY_VARIABLE_PATH.test(value);

export const ANTIGRAVITY_HELP_OUTPUT = Object.freeze([
  'Usage: agy [options]',
  '--input-format stream-json',
  '--output-format stream-json|json',
  '--json-schema <path>',
  '--model <id>',
  '--print-timeout <duration>',
  '--sandbox',
]).join('\n');
export const ANTIGRAVITY_MODELS_HELP_OUTPUT = Object.freeze([
  'Usage: agy models',
  'Output: MODEL_ID  DISPLAY_NAME',
]).join('\n');

export const ANTIGRAVITY_1_1_KNOWN_TOOLS = Object.freeze([
  'read_file',
  'write_file',
  'read_url',
  'execute_url',
  'command',
  'unsandboxed',
  'mcp',
] as const);
const EXACT_DENIES = Object.freeze(ANTIGRAVITY_1_1_KNOWN_TOOLS.map((tool) => `${tool}(*)`));
export const ANTIGRAVITY_MANAGED_PROFILE_JSON = JSON.stringify(
  Object.freeze({
    toolPermission: 'strict',
    artifactReviewPolicy: 'asks-for-review',
    enableTerminalSandbox: true,
    allowNonWorkspaceAccess: false,
    enableTelemetry: false,
    permissions: Object.freeze({
      allow: Object.freeze([]),
      ask: Object.freeze([]),
      deny: EXACT_DENIES,
    }),
  }),
);

export type AntigravityBinding = CliRuntimeBinding<'antigravity_cli', 'provider_global'>;
export type AntigravitySharedConsent = Readonly<{ at: string | null; version: string | null }>;
export type AntigravityConfiguration = Readonly<{
  managedProfilePath: string;
  credentialEvidence: CliCredentialStatusEvidence;
}>;
export type AntigravityParsedStream<Output extends JsonValue> = Readonly<{
  output: Output;
  reportedModelId: string;
  usage: ProviderUsage;
}>;
export type AntigravityArtifactPaths = Readonly<{
  workspacePath: string;
  schemaPath: string | null;
}>;
export type AntigravityArtifactRoots = Readonly<{
  providerWorkspaceRoot: string;
  providerTempRoot: string;
}>;

export const antigravityError = (code: ProviderErrorCode): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);
export const isAntigravityProviderError = (error: unknown): error is AppError =>
  AppError.isTrusted(error) && error.code.startsWith('PROVIDER_');
export const sanitizeAntigravityFailure = (error: unknown): AppError =>
  isAntigravityProviderError(error) ? error : antigravityError('PROVIDER_EXECUTION_FAILED');

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
    keys.some((key, index) => key !== expectedKeys[index]) ||
    Reflect.ownKeys(value).length !== keys.length
  ) {
    throw failure();
  }
  return value as Record<string, unknown>;
};

const parseCanonicalJson = (text: string, maxBytes: number, failure: () => AppError): unknown => {
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > maxBytes) throw failure();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw failure();
  }
  if (JSON.stringify(parsed) !== text) throw failure();
  return parsed;
};

const exactStringArray = (
  value: unknown,
  expected: readonly string[],
  failure: () => AppError,
): void => {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    throw failure();
  }
};

export const isAntigravityIsoTimestamp = (value: string | null): boolean =>
  value !== null && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

export const assertAntigravityModelId = (modelId: string | null): string => {
  if (modelId === null || !isAntigravityRecipeModelId(modelId)) {
    throw antigravityError('PROVIDER_MODEL_INCOMPATIBLE');
  }
  return modelId;
};

export const assertAntigravityConsent = (consent: AntigravitySharedConsent): void => {
  const failure = () => antigravityError('PROVIDER_SHARED_CREDENTIAL_CONSENT_REQUIRED');
  const value = strictObject(consent, ['at', 'version'], failure);
  if (
    typeof value.at !== 'string' ||
    !isAntigravityIsoTimestamp(value.at) ||
    value.version !== SHARED_CREDENTIAL_NOTICE_VERSION
  )
    throw failure();
};

export const assertAntigravityExecuteConsents = (request: ProviderRequest<JsonValue>): void => {
  assertAntigravityConsent({
    at: request.sharedCredentialConsentAt,
    version: request.sharedCredentialConsentVersion,
  });
  if (
    !isAntigravityIsoTimestamp(request.providerManagedHistoryConsentAt) ||
    request.providerManagedHistoryConsentVersion !== ANTIGRAVITY_HISTORY_NOTICE_VERSION
  ) {
    throw antigravityError('PROVIDER_DATA_RETENTION_CONSENT_REQUIRED');
  }
};

export const assertAntigravityBinding = (value: CliRuntimeBinding): AntigravityBinding => {
  try {
    if (
      value.providerId !== 'antigravity_cli' ||
      value.recipeId !== ANTIGRAVITY_RECIPE_ID ||
      value.credentialScope !== 'provider_global' ||
      value.signerClassification !== 'google' ||
      assertBindingShape(value) !== 'antigravity_native'
    ) {
      throw new Error('binding mismatch');
    }
    return value as AntigravityBinding;
  } catch {
    throw antigravityError('PROVIDER_UNSAFE_VERSION');
  }
};

export const assertAntigravityArtifactRoots = (
  providerWorkspaceRoot: string,
  providerTempRoot: string,
): AntigravityArtifactRoots => {
  if (
    !isCanonicalAbsoluteWindowsPath(providerWorkspaceRoot) ||
    !isCanonicalAbsoluteWindowsPath(providerTempRoot) ||
    win32.basename(providerWorkspaceRoot) !== 'workspace' ||
    win32.basename(providerTempRoot) !== 'temp' ||
    win32.dirname(providerWorkspaceRoot) !== win32.dirname(providerTempRoot) ||
    sameWindowsPath(providerWorkspaceRoot, providerTempRoot)
  ) {
    throw antigravityError('PROVIDER_UNSAFE_VERSION');
  }
  return Object.freeze({ providerWorkspaceRoot, providerTempRoot });
};

export const assertAntigravityArtifacts = (
  requestId: string,
  schemaJson: string | null,
  artifacts: AntigravityArtifactPaths,
  roots: AntigravityArtifactRoots,
): void => {
  const expectedWorkspacePath = win32.join(roots.providerWorkspaceRoot, requestId);
  if (
    !ANTIGRAVITY_UUID_PATTERN.test(requestId) ||
    !isCanonicalAbsoluteWindowsPath(artifacts.workspacePath) ||
    artifacts.workspacePath !== expectedWorkspacePath
  ) {
    throw antigravityError('PROVIDER_UNSAFE_VERSION');
  }
  if (schemaJson === null) {
    if (artifacts.schemaPath !== null) throw antigravityError('PROVIDER_UNSAFE_VERSION');
    return;
  }
  if (
    artifacts.schemaPath === null ||
    !isCanonicalAbsoluteWindowsPath(artifacts.schemaPath) ||
    artifacts.schemaPath !== win32.join(roots.providerTempRoot, requestId, 'output-schema.json')
  ) {
    throw antigravityError('PROVIDER_UNSAFE_VERSION');
  }
};

export const parseAntigravityPermissions = (text: string): void => {
  const failure = () => antigravityError('PROVIDER_UNSAFE_VERSION');
  const value = strictObject(
    parseCanonicalJson(text, ANTIGRAVITY_MAX_DIAGNOSTIC_BYTES, failure),
    ['kind', 'toolPermission', 'artifactReviewPolicy', 'alwaysProceed', 'allow', 'ask', 'deny'],
    failure,
  );
  if (
    value.kind !== 'permissions' ||
    value.toolPermission !== 'strict' ||
    value.artifactReviewPolicy !== 'asks-for-review' ||
    value.alwaysProceed !== false
  ) {
    throw failure();
  }
  exactStringArray(value.allow, [], failure);
  exactStringArray(value.ask, [], failure);
  exactStringArray(value.deny, EXACT_DENIES, failure);
};

export const parseAntigravityConfiguration = (
  text: string,
  activeProfileRoot: string,
): AntigravityConfiguration => {
  const failure = () => antigravityError('PROVIDER_UNSAFE_VERSION');
  const value = strictObject(
    parseCanonicalJson(text, ANTIGRAVITY_MAX_DIAGNOSTIC_BYTES, failure),
    [
      'kind',
      'profilePath',
      'enableTerminalSandbox',
      'allowNonWorkspaceAccess',
      'enableTelemetry',
      'mcpServers',
      'plugins',
      'hooks',
      'credentialBackend',
      'credentialStatus',
      'resolvedProfilePath',
    ],
    failure,
  );
  if (
    value.kind !== 'config' ||
    typeof value.profilePath !== 'string' ||
    value.profilePath !== activeProfileRoot ||
    value.enableTerminalSandbox !== true ||
    value.allowNonWorkspaceAccess !== false ||
    value.enableTelemetry !== false ||
    (value.credentialBackend !== 'windows_credential_manager' &&
      value.credentialBackend !== 'os_account_bound_encrypted') ||
    (value.credentialStatus !== 'present' && value.credentialStatus !== 'absent') ||
    value.resolvedProfilePath !== value.profilePath
  ) {
    throw failure();
  }
  exactStringArray(value.mcpServers, [], failure);
  exactStringArray(value.plugins, [], failure);
  exactStringArray(value.hooks, [], failure);
  return Object.freeze({
    managedProfilePath: value.profilePath,
    credentialEvidence: Object.freeze({
      backend: value.credentialBackend,
      status: value.credentialStatus,
      resolvedProfilePath: value.resolvedProfilePath,
    }),
  });
};

const FIXED_EXIT_ERRORS: Readonly<Record<string, ProviderErrorCode>> = Object.freeze({
  'ANTIGRAVITY_ERROR AUTH_REQUIRED': 'PROVIDER_AUTH_REQUIRED',
  'ANTIGRAVITY_ERROR QUOTA_OR_BILLING': 'PROVIDER_QUOTA_OR_BILLING',
  'ANTIGRAVITY_ERROR CANCELLED': 'PROVIDER_CANCELLED',
  'ANTIGRAVITY_ERROR MODEL_INCOMPATIBLE': 'PROVIDER_MODEL_INCOMPATIBLE',
  'ANTIGRAVITY_ERROR RATE_LIMITED': 'PROVIDER_RATE_LIMITED',
  'ANTIGRAVITY_ERROR NETWORK_FAILED': 'PROVIDER_NETWORK_FAILED',
  'ANTIGRAVITY_ERROR TEMPORARILY_UNAVAILABLE': 'PROVIDER_TEMPORARILY_UNAVAILABLE',
  'ANTIGRAVITY_ERROR REFUSED': 'PROVIDER_REFUSED',
});

export const assertAntigravitySuccess = (result: CliProcessResult): void => {
  if (result.exitCode !== 0) {
    const stdout = result.stdout.replace(/\r?\n$/u, '');
    const stderr = result.stderr.replace(/\r?\n$/u, '');
    const token = stdout.length === 0 ? stderr : stderr.length === 0 ? stdout : '';
    throw antigravityError(FIXED_EXIT_ERRORS[token] ?? 'PROVIDER_EXECUTION_FAILED');
  }
  if (result.stderr.length !== 0) throw antigravityError('PROVIDER_OUTPUT_INVALID');
};

const containsPrivatePath = (value: unknown): boolean => {
  if (typeof value === 'string') return ROOTED_PRIVATE_PATH.test(value);
  if (Array.isArray(value)) return value.some(containsPrivatePath);
  return value !== null && typeof value === 'object'
    ? Object.values(value as Record<string, unknown>).some(containsPrivatePath)
    : false;
};

const parseUsage = (value: unknown): ProviderUsage => {
  const failure = () => antigravityError('PROVIDER_OUTPUT_INVALID');
  const usage = strictObject(value, ['input_tokens', 'output_tokens', 'total_tokens'], failure);
  const values = [usage.input_tokens, usage.output_tokens, usage.total_tokens];
  if (
    values.some(
      (count) => count !== null && (!Number.isSafeInteger(count) || (count as number) < 0),
    )
  ) {
    throw failure();
  }
  return Object.freeze({
    inputTokens: usage.input_tokens as number | null,
    outputTokens: usage.output_tokens as number | null,
    totalTokens: usage.total_tokens as number | null,
  });
};

export const parseAntigravityStream = <Output extends JsonValue>(
  stdout: string,
  requestId: string,
  modelId: string,
  parseOutput: (value: unknown) => Output,
): AntigravityParsedStream<Output> => {
  const failure = () => antigravityError('PROVIDER_OUTPUT_INVALID');
  if (stdout.length === 0 || Buffer.byteLength(stdout, 'utf8') > ANTIGRAVITY_MAX_STREAM_BYTES) {
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
    lines.length > MAX_NDJSON_LINES ||
    lines.some(
      (line) => line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_NDJSON_LINE_BYTES,
    )
  ) {
    throw failure();
  }
  const events = lines.map((line) => parseCanonicalJson(line, MAX_NDJSON_LINE_BYTES, failure));
  for (const event of events) {
    if (event !== null && typeof event === 'object' && !Array.isArray(event)) {
      const record = event as Record<string, unknown>;
      if (
        record.event === 'subagent' ||
        record.event === 'tool' ||
        record.step_type === 'tool' ||
        record.step_type === 'subagent'
      ) {
        throw antigravityError('PROVIDER_TOOL_ACTIVITY_DETECTED');
      }
    }
  }
  const init = strictObject(
    events[0],
    ['event', 'cwd', 'permission_mode', 'tools', 'model'],
    failure,
  );
  const expectedCwd = new RegExp(`^[R-W]:\\\\workspace\\\\${requestId}$`, 'iu');
  if (
    init.event !== 'init' ||
    typeof init.cwd !== 'string' ||
    !expectedCwd.test(init.cwd) ||
    win32.normalize(init.cwd) !== init.cwd ||
    init.permission_mode !== 'strict' ||
    init.model !== modelId ||
    !Array.isArray(init.tools) ||
    Reflect.ownKeys(init.tools).length !== init.tools.length + 1 ||
    new Set(init.tools).size !== init.tools.length
  ) {
    throw failure();
  }
  if (
    init.tools.some(
      (tool) =>
        typeof tool !== 'string' ||
        !ANTIGRAVITY_1_1_KNOWN_TOOLS.includes(tool as (typeof ANTIGRAVITY_1_1_KNOWN_TOOLS)[number]),
    )
  ) {
    throw antigravityError('PROVIDER_TOOL_ACTIVITY_DETECTED');
  }
  for (const event of events.slice(1, -1)) {
    const step = strictObject(event, ['event', 'step_type'], failure);
    if (step.event !== 'step' || step.step_type !== 'reasoning') {
      throw antigravityError('PROVIDER_TOOL_ACTIVITY_DETECTED');
    }
  }
  const result = strictObject(
    events.at(-1),
    ['event', 'status', 'model', 'structured_output', 'usage'],
    failure,
  );
  if (
    result.event !== 'result' ||
    result.status !== 'SUCCESS' ||
    result.model !== modelId ||
    containsPrivatePath(result.structured_output)
  ) {
    throw failure();
  }
  let output: Output;
  try {
    output = freezeJsonCopy(parseOutput(result.structured_output)) as Output;
  } catch {
    throw failure();
  }
  return Object.freeze({ output, reportedModelId: modelId, usage: parseUsage(result.usage) });
};

export const buildAntigravityPrompt = (blocks: readonly ProviderTextBlock[]): string =>
  JSON.stringify({ blocks: blocks.map(({ role, kind, text }) => ({ role, kind, text })) });
export const buildAntigravityStdin = (prompt: string): string =>
  `${JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text: prompt }] } })}\n`;

export const parseAntigravityModels = (stdout: string): readonly ProviderModel[] => {
  if (stdout.length === 0 || Buffer.byteLength(stdout, 'utf8') > ANTIGRAVITY_MAX_MODEL_LIST_BYTES) {
    throw antigravityError('PROVIDER_OUTPUT_INVALID');
  }
  const lines = stdout.replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');
  if (lines.length < 2 || lines.length > 1_001 || lines[0] !== 'MODEL_ID  DISPLAY_NAME') {
    throw antigravityError('PROVIDER_OUTPUT_INVALID');
  }
  const seen = new Set<string>();
  return Object.freeze(
    lines.slice(1).map((line) => {
      const match = /^([a-z0-9][a-z0-9._-]{0,159}) {2}([^\p{Cc}\p{Cf}]{1,120})$/u.exec(line);
      const modelId = match?.[1];
      const displayName = match?.[2];
      if (
        modelId === undefined ||
        displayName === undefined ||
        displayName.trim() !== displayName ||
        displayName.includes('  ') ||
        !isAntigravityRecipeModelId(modelId) ||
        !hasEquivalentModelTokens(modelId, displayName) ||
        !isSafeModelDisplayName(displayName) ||
        seen.has(modelId)
      ) {
        throw antigravityError('PROVIDER_OUTPUT_INVALID');
      }
      seen.add(modelId);
      return Object.freeze({ modelId, displayName, compatibility: 'unverified' as const });
    }),
  );
};
