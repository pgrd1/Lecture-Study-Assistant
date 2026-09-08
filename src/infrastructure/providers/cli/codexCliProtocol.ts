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
import { CODEX_IMAGE_MODEL_ID, type JsonValue } from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError, type ProviderErrorCode } from '../../../shared/errors';
import type { CliCredentialStatusEvidence } from './cliCredentialGuard';
import { isCanonicalAbsoluteWindowsPath } from './cliFileIntegrity';
import { assertBindingShape } from './cliIdentity';
import type { CodexImageManifest } from './codexCliMedia';

export const CODEX_RECIPE_ID = 'codex-0.146-profile-keyring-v2';
export const CODEX_MAX_JSONL_BYTES = 1024 * 1024;
const CODEX_MAX_EVENT_BYTES = 512 * 1024;
const CODEX_MAX_CAPABILITY_BYTES = 256 * 1024;
const CODEX_MAX_CAPABILITY_LINES = 1024;
const CODEX_MAX_CAPABILITY_LINE_BYTES = 4096;
export const CODEX_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ROOTED_PRIVATE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/{2}|file:\/\/)/iu;

export const CODEX_DISABLED_FEATURES = Object.freeze([
  'apps',
  'artifact',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_buffered_exec',
  'code_mode_host',
  'code_mode_only',
  'computer_use',
  'default_mode_request_user_input',
  'deferred_executor',
  'deferred_tool_world_state',
  'enable_mcp_apps',
  'exec_permission_approvals',
  'executor_capability_discovery',
  'goals',
  'guardian_approval',
  'hooks',
  'image_generation',
  'in_app_browser',
  'in_app_updates',
  'mcp_2026_07_28',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'network_proxy',
  'non_prefixed_mcp_tool_names',
  'plugin_sharing',
  'plugins',
  'remote_plugin',
  'request_permissions_tool',
  'respect_system_proxy',
  'shell_snapshot',
  'shell_tool',
  'shell_zsh_fork',
  'secret_auth_storage',
  'skill_mcp_dependency_install',
  'skill_search',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'unified_exec_zsh_fork',
  'use_agent_identity',
  'workspace_dependencies',
] as const);

export const CODEX_DISABLE_ARGS = Object.freeze(
  CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature] as const),
);

// Remaining exact rust-v0.146.0 FEATURES registry defaults. These are read-only
// discovery facts, not permission to enable tools. Removed flags retain upstream
// default rows; active tool-bearing flags above must all be false.
export const CODEX_REVIEWED_FEATURE_DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({
  undo: false,
  js_repl: false,
  js_repl_tools_only: false,
  terminal_resize_reflow: true,
  web_search_request: false,
  web_search_cached: false,
  search_tool: false,
  codex_git_commit: false,
  runtime_metrics: false,
  sqlite: true,
  external_agent_memory_import: false,
  local_thread_store_compression: false,
  chronicle: false,
  apply_patch_freeform: false,
  apply_patch_streaming_events: false,
  use_linux_sandbox_bwrap: false,
  use_legacy_landlock: false,
  request_rule: false,
  experimental_windows_sandbox: false,
  elevated_windows_sandbox: false,
  remote_models: false,
  enable_request_compression: true,
  multi_agent_mode: false,
  enable_fanout: false,
  apps_mcp_path_override: false,
  tool_search: false,
  tool_search_always_defer_mcp_tools: true,
  unavailable_dummy_tools: false,
  plugin_hooks: false,
  external_migration: false,
  resize_all_images: true,
  item_ids: true,
  concurrent_reasoning_summaries: false,
  skill_env_var_dependency_prompt: false,
  mentions_v2: true,
  steer: true,
  terminal_visualization_instructions: false,
  guardianv2: false,
  token_budget: false,
  rollout_budget: false,
  current_time_reminder: false,
  collaboration_modes: true,
  personality: true,
  fast_mode: true,
  realtime_conversation: false,
  remote_control: false,
  image_detail_original: false,
  tui_app_server: true,
  prevent_idle_sleep: false,
  workspace_owner_usage_nudge: false,
  responses_websockets: false,
  responses_websockets_v2: false,
  remote_compaction_v2: true,
});

export const CODEX_CONFIG_OVERRIDES = Object.freeze([
  'approval_policy="never"',
  'cli_auth_credentials_store="keyring"',
  'analytics.enabled=false',
  'feedback.enabled=false',
  'check_for_update_on_startup=false',
  'history.persistence="none"',
  'allow_login_shell=false',
  'mcp_servers={}',
  'include_apps_instructions=false',
] as const);

export const CODEX_PROBE_PROMPT =
  '진단용 고정 문장입니다. 정확히 { "ok": true } JSON만 응답하세요.';

const REQUIRED_EXEC_FLAGS = Object.freeze([
  'image',
  'model',
  'strict-config',
  'ignore-user-config',
  'ignore-rules',
  'ephemeral',
  'sandbox',
  'skip-git-repo-check',
  'json',
  'cd',
  'output-schema',
  'color',
  'config',
  'disable',
] as const);
const REVIEWED_EXTRA_EXEC_FLAGS = new Set([
  'help',
  'enable',
  'image',
  'model',
  'oss',
  'local-provider',
  'profile',
  'full-auto',
  'dangerously-bypass-approvals-and-sandbox',
  'dangerously-bypass-hook-trust',
  'add-dir',
  'output-last-message',
  'search',
]);
const SECURITY_FLAG_WORD =
  /(?:agent|app|approval|browser|command|computer|dir|exec|file|hook|image|mcp|memory|network|permission|plugin|rule|sandbox|schema|search|shell|skill|tool|write)/u;

export type CodexBinding = CliRuntimeBinding<'codex_cli', 'profile_scoped'>;
export type CodexCredentialStatus = Readonly<{
  managedProfilePath: string;
  evidence: CliCredentialStatusEvidence;
}>;
export type CodexManagedProfile = Readonly<{
  managedProfilePath: string;
  codexHomePath: string;
}>;
export type CodexArtifactRoots = Readonly<{
  providerRuntimeRoot: string;
  providerProfilesRoot: string;
  providerWorkspaceRoot: string;
  providerTempRoot: string;
}>;
export type CodexRequestArtifacts = Readonly<{
  workspacePath: string;
  schemaPath: string;
  schemaSha256: string;
  images?: readonly CodexImageManifest[];
}>;
export type CodexParsedJsonl<Output extends JsonValue> = Readonly<{
  output: Output;
  reportedModelId: null;
  usage: ProviderUsage;
}>;

export const codexError = (code: ProviderErrorCode): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);
export const isCodexProviderError = (error: unknown): error is AppError =>
  AppError.isTrusted(error) && error.code.startsWith('PROVIDER_');
export const sanitizeCodexFailure = (error: unknown): AppError =>
  isCodexProviderError(error) ? error : codexError('PROVIDER_EXECUTION_FAILED');

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
    return JSON.parse(text);
  } catch {
    throw failure();
  }
};

const parseCanonicalJson = (text: string, maxBytes: number, failure: () => AppError): unknown => {
  const value = parseJson(text, maxBytes, failure);
  if (JSON.stringify(value) !== text) throw failure();
  return value;
};

const boundedLines = (
  text: string,
  maxBytes: number,
  minLines: number,
  failure: () => AppError,
): readonly string[] => {
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > maxBytes) throw failure();
  const body = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n')
      ? text.slice(0, -1)
      : text;
  const normalized = body.replaceAll('\r\n', '\n');
  if (normalized.includes('\r')) throw failure();
  const lines = normalized.split('\n');
  if (
    lines.length < minLines ||
    lines.length > CODEX_MAX_CAPABILITY_LINES ||
    lines.some((line) => Buffer.byteLength(line, 'utf8') > CODEX_MAX_CAPABILITY_LINE_BYTES)
  ) {
    throw failure();
  }
  return Object.freeze(lines);
};

export const parseCodexExecHelp = (stdout: string): readonly string[] => {
  const failure = () => codexError('PROVIDER_UNSAFE_VERSION');
  const lines = boundedLines(stdout, CODEX_MAX_CAPABILITY_BYTES, 4, failure);
  const usageLines = lines.filter(
    (line) =>
      line === 'Usage: codex exec [OPTIONS] [PROMPT]' ||
      line === 'Usage: codex exec [OPTIONS] [PROMPT] [COMMAND]',
  );
  if (usageLines.length !== 1 || !lines.includes('Options:')) {
    throw failure();
  }
  const flags = new Set<string>();
  let shortConfig = false;
  let section: 'preamble' | 'commands' | 'arguments' | 'options' = 'preamble';
  let acceptsContinuation = false;
  for (const line of lines) {
    // Clap descriptions contain blank paragraphs followed by indented examples.
    if (line.trim().length === 0) continue;
    if (
      (section === 'preamble' && line === '       codex exec [OPTIONS] <COMMAND> [ARGS]') ||
      line === 'Usage: codex exec [OPTIONS] [PROMPT]' ||
      line === 'Usage: codex exec [OPTIONS] [PROMPT] [COMMAND]'
    ) {
      acceptsContinuation = false;
      continue;
    }
    if (line === 'Run Codex non-interactively' && section === 'preamble') continue;
    if (line === 'Commands:') {
      section = 'commands';
      acceptsContinuation = false;
      continue;
    }
    if (line === 'Arguments:') {
      section = 'arguments';
      acceptsContinuation = false;
      continue;
    }
    if (line === 'Options:') {
      section = 'options';
      acceptsContinuation = false;
      continue;
    }
    if (
      section === 'commands' &&
      /^\s{2}(resume|review|help)(?:\s{2,}[^\p{Cc}\p{Cf}]*)?$/u.test(line)
    ) {
      acceptsContinuation = true;
      continue;
    }
    if (section === 'arguments' && /^\s{2}\[PROMPT\]$/u.test(line)) {
      acceptsContinuation = true;
      continue;
    }
    const option =
      /^\s+(?:-[A-Za-z],\s+)?--[a-z][a-z0-9-]*(?:\s+<[^<>\r\n]+>(?:\.\.\.)?)?(?:\s{2,}[^\p{Cc}\p{Cf}]*)?$/u.test(
        line,
      );
    if (section === 'options' && option) {
      acceptsContinuation = true;
    } else if (!acceptsContinuation || !/^\s{4,}[^\p{Cc}\p{Cf}]+$/u.test(line)) {
      throw failure();
    }
    if (!option) continue;
    if (/^\s+-c,\s+--config(?:\s|$)/u.test(line)) shortConfig = true;
    const match = /--([a-z][a-z0-9-]*)/u.exec(line);
    const flag = match?.[1];
    if (flag === undefined || flags.has(flag)) throw failure();
    flags.add(flag);
  }
  if (!shortConfig || REQUIRED_EXEC_FLAGS.some((flag) => !flags.has(flag))) throw failure();
  for (const flag of flags) {
    if (
      !REQUIRED_EXEC_FLAGS.includes(flag as (typeof REQUIRED_EXEC_FLAGS)[number]) &&
      !REVIEWED_EXTRA_EXEC_FLAGS.has(flag) &&
      SECURITY_FLAG_WORD.test(flag)
    ) {
      throw failure();
    }
  }
  return Object.freeze([...flags].sort());
};

export const parseCodexFeatureList = (stdout: string): readonly string[] => {
  const failure = () => codexError('PROVIDER_UNSAFE_VERSION');
  const lines = boundedLines(
    stdout,
    CODEX_MAX_CAPABILITY_BYTES,
    CODEX_DISABLED_FEATURES.length,
    failure,
  );
  const features = new Set<string>();
  for (const line of lines) {
    const match =
      /^([a-z][a-z0-9_]{0,127})\s+(stable|experimental|under-development|under development|deprecated|removed)\s+(true|false)$/u.exec(
        line,
      );
    const feature = match?.[1];
    if (feature === undefined || features.has(feature)) throw failure();
    const disabled = CODEX_DISABLED_FEATURES.includes(
      feature as (typeof CODEX_DISABLED_FEATURES)[number],
    );
    if (!disabled && !Object.hasOwn(CODEX_REVIEWED_FEATURE_DEFAULTS, feature)) throw failure();
    if (match?.[3] !== String(disabled ? false : CODEX_REVIEWED_FEATURE_DEFAULTS[feature]))
      throw failure();
    features.add(feature);
  }
  if (
    features.size !==
      CODEX_DISABLED_FEATURES.length + Object.keys(CODEX_REVIEWED_FEATURE_DEFAULTS).length ||
    CODEX_DISABLED_FEATURES.some((feature) => !features.has(feature))
  ) {
    throw failure();
  }
  return Object.freeze([...features].sort());
};

export const codexCapabilityHash = (
  helpFlags: readonly string[],
  featureNames: readonly string[],
): string => sha256(JSON.stringify({ helpFlags, featureNames }));

export const buildCodexCapabilityHelpArgs = (): readonly string[] =>
  Object.freeze([
    'exec',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
    ...CODEX_CONFIG_OVERRIDES.flatMap((value) => ['-c', value]),
    ...CODEX_DISABLE_ARGS,
    '--help',
  ]);

export const buildCodexFeatureListArgs = (): readonly string[] =>
  Object.freeze([
    // Pinned root dispatcher does not forward exec loader flags to features list.
    // This read-only command uses the runner's verified empty managed profile/cwd.
    ...CODEX_CONFIG_OVERRIDES.flatMap((value) => ['-c', value]),
    ...CODEX_DISABLE_ARGS,
    'features',
    'list',
  ]);

export const buildCodexMainArgs = (
  workspacePath: string,
  schemaPath: string,
  modelId: string | null = null,
  images: readonly CodexImageManifest[] = [],
): readonly string[] => {
  assertCodexDefaultModel(modelId);
  if (
    images.length > 2 ||
    (images.length && modelId !== CODEX_IMAGE_MODEL_ID) ||
    images.some(
      (image, index) =>
        image.path !== win32.join(win32.dirname(schemaPath), image.fileName) ||
        !new RegExp(`^image-${String(index).padStart(3, '0')}\\.(png|jpg)$`, 'u').test(
          image.fileName,
        ) ||
        image.path.includes(','),
    )
  )
    throw codexError('PROVIDER_UNSAFE_VERSION');
  return Object.freeze([
    'exec',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--json',
    '--cd',
    workspacePath,
    '--output-schema',
    schemaPath,
    '--color',
    'never',
    ...CODEX_CONFIG_OVERRIDES.flatMap((value) => ['-c', value]),
    ...CODEX_DISABLE_ARGS,
    ...(modelId === null ? [] : ['--model', modelId]),
    ...images.flatMap((image) => ['--image', image.path]),
    ...(images.length ? ['--'] : []),
    '-',
  ]);
};

export const assertCodexBinding = (value: CliRuntimeBinding): CodexBinding => {
  try {
    const shape = assertBindingShape(value);
    if (
      value.providerId !== 'codex_cli' ||
      value.recipeId !== CODEX_RECIPE_ID ||
      value.credentialScope !== 'profile_scoped' ||
      value.signerClassification !== 'openai' ||
      (shape !== 'codex_native' && shape !== 'codex_npm')
    ) {
      throw new Error('binding mismatch');
    }
    return value as CodexBinding;
  } catch {
    throw codexError('PROVIDER_UNSAFE_VERSION');
  }
};

export const assertCodexRoots = (providerRuntimeRoot: string): CodexArtifactRoots => {
  if (
    !isCanonicalAbsoluteWindowsPath(providerRuntimeRoot) ||
    !/^C:\\(?:[^\\]+\\)+providers$/u.test(providerRuntimeRoot) ||
    win32.basename(providerRuntimeRoot) !== 'providers'
  ) {
    throw codexError('PROVIDER_UNSAFE_VERSION');
  }
  return Object.freeze({
    providerRuntimeRoot,
    providerProfilesRoot: win32.join(providerRuntimeRoot, 'profiles'),
    providerWorkspaceRoot: win32.join(providerRuntimeRoot, 'workspace'),
    providerTempRoot: win32.join(providerRuntimeRoot, 'temp'),
  });
};

export const createCodexManagedProfile = (roots: CodexArtifactRoots): CodexManagedProfile => {
  const managedProfilePath = win32.join(roots.providerProfilesRoot, 'codex_cli');
  return Object.freeze({
    managedProfilePath,
    codexHomePath: win32.join(managedProfilePath, 'settings'),
  });
};

export const assertCodexArtifacts = (
  requestId: string,
  schemaJson: string,
  artifacts: CodexRequestArtifacts,
  roots: CodexArtifactRoots,
): void => {
  if (
    !CODEX_UUID_PATTERN.test(requestId) ||
    !isCanonicalAbsoluteWindowsPath(artifacts.workspacePath) ||
    !isCanonicalAbsoluteWindowsPath(artifacts.schemaPath) ||
    artifacts.workspacePath !== win32.join(roots.providerWorkspaceRoot, requestId) ||
    artifacts.schemaPath !== win32.join(roots.providerTempRoot, requestId, 'output-schema.json') ||
    !SHA_256_PATTERN.test(artifacts.schemaSha256) ||
    artifacts.schemaSha256 !== sha256(schemaJson)
  ) {
    throw codexError('PROVIDER_UNSAFE_VERSION');
  }
};

const isIsoTimestamp = (value: string | null): boolean =>
  value !== null && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

export const assertCodexDefaultModel = (modelId: string | null): string | null => {
  if (modelId !== null && modelId !== CODEX_IMAGE_MODEL_ID)
    throw codexError('PROVIDER_MODEL_INCOMPATIBLE');
  return modelId;
};

export const readCodexCredentialStatus = (
  status: CodexCredentialStatus,
  activeProfileRoot: string,
): CodexCredentialStatus => {
  const failure = () => codexError('PROVIDER_UNSAFE_VERSION');
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

export const assertCodexProfileFiles = (fileNames: readonly string[]): void => {
  if (
    !Array.isArray(fileNames) ||
    Reflect.ownKeys(fileNames).length !== fileNames.length + 1 ||
    fileNames.some((fileName) => typeof fileName !== 'string')
  ) {
    throw codexError('PROVIDER_UNSAFE_VERSION');
  }
  if (fileNames.length !== 0) throw codexError('PROVIDER_RESIDUAL_DATA');
};

const FIXED_EXIT_ERRORS: Readonly<Record<string, ProviderErrorCode>> = Object.freeze({
  'CODEX_CLI_ERROR AUTH_REQUIRED': 'PROVIDER_AUTH_REQUIRED',
  'CODEX_CLI_ERROR QUOTA_OR_BILLING': 'PROVIDER_QUOTA_OR_BILLING',
  'CODEX_CLI_ERROR RATE_LIMITED': 'PROVIDER_RATE_LIMITED',
  'CODEX_CLI_ERROR CANCELLED': 'PROVIDER_CANCELLED',
});

export const assertCodexSuccess = (result: CliProcessResult): void => {
  if (result.exitCode !== 0) {
    const stdout = result.stdout.replace(/\r?\n$/u, '');
    const stderr = result.stderr.replace(/\r?\n$/u, '');
    const token = stdout.length === 0 ? stderr : stderr.length === 0 ? stdout : '';
    throw codexError(FIXED_EXIT_ERRORS[token] ?? 'PROVIDER_EXECUTION_FAILED');
  }
  if (result.stderr.length !== 0) throw codexError('PROVIDER_OUTPUT_INVALID');
};

export const assertCodexCapabilitySuccess = (result: CliProcessResult): void => {
  if (result.exitCode !== 0 || result.stderr.length !== 0) {
    throw codexError('PROVIDER_UNSAFE_VERSION');
  }
};

const containsPrivatePath = (value: unknown): boolean => {
  if (typeof value === 'string') return ROOTED_PRIVATE_PATH.test(value);
  if (Array.isArray(value)) return value.some(containsPrivatePath);
  return value !== null && typeof value === 'object'
    ? Object.values(value as Record<string, unknown>).some(containsPrivatePath)
    : false;
};

const parseUsage = (value: unknown): ProviderUsage => {
  const failure = () => codexError('PROVIDER_OUTPUT_INVALID');
  const usage = strictObject(
    value,
    [
      'input_tokens',
      'cached_input_tokens',
      'cache_write_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
    ],
    failure,
  );
  const values = Object.values(usage);
  if (
    values.some(
      (count) => typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0,
    ) ||
    (usage.cached_input_tokens as number) > (usage.input_tokens as number)
  ) {
    throw failure();
  }
  const total = (usage.input_tokens as number) + (usage.output_tokens as number);
  if (!Number.isSafeInteger(total)) throw failure();
  return Object.freeze({
    inputTokens: usage.input_tokens as number,
    outputTokens: usage.output_tokens as number,
    totalTokens: total,
  });
};

const parseJsonlLines = (stdout: string): readonly unknown[] => {
  const failure = () => codexError('PROVIDER_OUTPUT_INVALID');
  const lines = boundedLines(stdout, CODEX_MAX_JSONL_BYTES, 4, failure);
  if (
    lines.length > 64 ||
    lines.some(
      (line) => line.length === 0 || Buffer.byteLength(line, 'utf8') > CODEX_MAX_EVENT_BYTES,
    )
  ) {
    throw failure();
  }
  return Object.freeze(
    lines.map((line) => parseCanonicalJson(line, CODEX_MAX_EVENT_BYTES, failure)),
  );
};

const TOOL_LIKE =
  /(?:agent|app|approval|artifact|browser|command|computer|exec|file|image|mcp|permission|shell|tool)/iu;

const rejectToolLikeEvents = (events: readonly unknown[]): void => {
  const failure = () => codexError('PROVIDER_OUTPUT_INVALID');
  for (const event of events) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) throw failure();
    const descriptor = Object.getOwnPropertyDescriptor(event, 'type');
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string'
    ) {
      throw failure();
    }
    if (descriptor.value.startsWith('item.')) {
      if (descriptor.value !== 'item.completed') {
        throw codexError('PROVIDER_TOOL_ACTIVITY_DETECTED');
      }
      const itemDescriptor = Object.getOwnPropertyDescriptor(event, 'item');
      if (
        itemDescriptor === undefined ||
        !('value' in itemDescriptor) ||
        itemDescriptor.value === null ||
        typeof itemDescriptor.value !== 'object' ||
        Array.isArray(itemDescriptor.value)
      ) {
        throw codexError('PROVIDER_TOOL_ACTIVITY_DETECTED');
      }
      const itemType = Object.getOwnPropertyDescriptor(itemDescriptor.value, 'type');
      if (
        itemType === undefined ||
        !('value' in itemType) ||
        (itemType.value !== 'reasoning' && itemType.value !== 'agent_message')
      ) {
        throw codexError('PROVIDER_TOOL_ACTIVITY_DETECTED');
      }
      continue;
    }
    if (!['thread.started', 'turn.started', 'turn.completed'].includes(descriptor.value)) {
      if (TOOL_LIKE.test(descriptor.value)) {
        throw codexError('PROVIDER_TOOL_ACTIVITY_DETECTED');
      }
    }
  }
};

export const parseCodexJsonl = <Output extends JsonValue>(
  stdout: string,
  parseOutput: (value: unknown) => Output,
): CodexParsedJsonl<Output> => {
  const failure = () => codexError('PROVIDER_OUTPUT_INVALID');
  const events = parseJsonlLines(stdout);
  rejectToolLikeEvents(events);
  const thread = strictObject(events[0], ['type', 'thread_id'], failure);
  if (
    thread.type !== 'thread.started' ||
    typeof thread.thread_id !== 'string' ||
    !CODEX_UUID_PATTERN.test(thread.thread_id)
  ) {
    throw failure();
  }
  const started = strictObject(events[1], ['type'], failure);
  if (started.type !== 'turn.started') throw failure();
  const completed = strictObject(events.at(-1), ['type', 'usage'], failure);
  if (completed.type !== 'turn.completed') throw failure();

  let assistantText: string | null = null;
  for (const eventValue of events.slice(2, -1)) {
    const event = strictObject(eventValue, ['type', 'item'], failure);
    if (event.type !== 'item.completed') throw failure();
    const item = strictObject(event.item, ['id', 'type', 'text'], failure);
    if (
      typeof item.id !== 'string' ||
      !SAFE_ITEM_ID.test(item.id) ||
      typeof item.text !== 'string' ||
      Buffer.byteLength(item.text, 'utf8') > CODEX_MAX_EVENT_BYTES
    ) {
      throw failure();
    }
    if (item.type === 'reasoning') {
      if (assistantText !== null) throw failure();
      continue;
    }
    if (item.type !== 'agent_message' || assistantText !== null) throw failure();
    assistantText = item.text;
  }
  if (assistantText === null) throw failure();

  let output: Output;
  try {
    const rawOutput = parseCanonicalJson(assistantText, CODEX_MAX_EVENT_BYTES, failure);
    if (containsPrivatePath(rawOutput)) throw failure();
    output = freezeJsonCopy(parseOutput(rawOutput));
  } catch {
    throw failure();
  }
  return Object.freeze({
    output,
    // Stock exec JSONL omits ModelVerification. Never claim requested model as reported.
    reportedModelId: null,
    usage: parseUsage(completed.usage),
  });
};

export const buildCodexPrompt = (
  blocks: readonly ProviderTextBlock[],
  outputJsonSchema: Readonly<Record<string, JsonValue>>,
): string =>
  `${JSON.stringify({
    blocks: blocks.map(({ role, kind, text }) => ({ role, kind, text })),
    outputJsonSchema,
  })}\n`;

export const buildCodexProbePrompt = (): string =>
  `${JSON.stringify({
    blocks: [{ role: 'user', kind: 'instruction', text: CODEX_PROBE_PROMPT }],
    outputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { const: true } },
    },
  })}\n`;

export const assertCodexProfileScopedRequest = (request: ProviderRequest<JsonValue>): void => {
  if (
    request.sharedCredentialConsentAt !== null ||
    request.sharedCredentialConsentVersion !== null
  ) {
    throw codexError('PROVIDER_EXECUTION_FAILED');
  }
};

export const isCodexIsoTimestamp = isIsoTimestamp;
