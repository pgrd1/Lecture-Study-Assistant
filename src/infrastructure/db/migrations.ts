import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

type ParameterizedStatement = Readonly<{
  sql: string;
  parameters: readonly (string | number | null)[];
}>;

export type SqliteMigration = Readonly<{
  version: number;
  statements: readonly string[];
  parameterizedStatements?: readonly ParameterizedStatement[];
}>;

const MIGRATION_ONE: SqliteMigration = Object.freeze({
  version: 1,
  statements: Object.freeze([
    `CREATE TABLE courses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      professor_name TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      user_instructions TEXT NOT NULL,
      archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0)
    ) STRICT`,
    'CREATE UNIQUE INDEX courses_folder_name_unique ON courses(folder_name COLLATE NOCASE)',
    `CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
      source_kind TEXT NOT NULL,
      source_file_name TEXT NOT NULL,
      source_media_type TEXT NOT NULL,
      summary_mode TEXT NOT NULL,
      staged_source_path TEXT NOT NULL,
      queue_item_path TEXT,
      source_sha256 TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      last_successful_status TEXT NOT NULL,
      retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
      error_code TEXT,
      cleanup_warning_code TEXT,
      attention_resolution_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0)
    ) STRICT`,
    'CREATE UNIQUE INDEX jobs_course_fingerprint_unique ON jobs(course_id, fingerprint)',
    'CREATE INDEX jobs_recovery_status_index ON jobs(status, updated_at, id)',
    `CREATE TABLE settings (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      schema_version INTEGER NOT NULL,
      vault_path TEXT,
      icloud_queue_path TEXT,
      default_summary_mode TEXT NOT NULL,
      auto_start INTEGER NOT NULL CHECK (auto_start IN (0, 1)),
      processing_paused INTEGER NOT NULL CHECK (processing_paused IN (0, 1)),
      legal_notice_accepted_at TEXT,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0)
    ) STRICT`,
    `CREATE TABLE job_artifacts (
      id INTEGER PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      artifact_kind TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(job_id, artifact_kind)
    ) STRICT`,
  ]),
});

const PROVIDER_ERROR_CODES_SQL = `'PROVIDER_NOT_CONFIGURED','PROVIDER_NOT_READY','PROVIDER_EXECUTABLE_NOT_FOUND','PROVIDER_LOGIN_TERMINAL_UNAVAILABLE','PROVIDER_CLI_CHANGED','PROVIDER_AUTH_REQUIRED','PROVIDER_ACCOUNT_UNSUPPORTED','PROVIDER_UNSAFE_VERSION','PROVIDER_MODEL_INCOMPATIBLE','PROVIDER_RATE_LIMITED','PROVIDER_BUSY','PROVIDER_QUOTA_OR_BILLING','PROVIDER_TIMEOUT','PROVIDER_NETWORK_FAILED','PROVIDER_TEMPORARILY_UNAVAILABLE','PROVIDER_REQUEST_TOO_LARGE','PROVIDER_RESPONSE_TOO_LARGE','PROVIDER_OUTPUT_INVALID','PROVIDER_REFUSED','PROVIDER_TOOL_ACTIVITY_DETECTED','PROVIDER_RESIDUAL_DATA','PROVIDER_SHARED_CREDENTIAL_CONSENT_REQUIRED','PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED','PROVIDER_DATA_RETENTION_CONSENT_REQUIRED','PROVIDER_EXECUTION_FAILED','PROVIDER_CANCELLED'`;

// Historical migrations must not depend on evolving application defaults.
const LEGACY_FEATURES = Object.freeze([
  'lecture_organize',
  'lecture_verify',
  'professor_profile',
  'exam_synthesis',
  'question_generation',
  'answer_verification',
  'grading_feedback',
] as const);
const LEGACY_PROMPTS = Object.freeze([
  'lecture-organize-v1',
  'lecture-verify-v1',
  'professor-profile-v1',
  'exam-synthesis-v1',
  'question-generation-v1',
  'answer-verification-v1',
  'grading-feedback-v1',
]);
const MIGRATION_TWO: SqliteMigration = Object.freeze({
  version: 2,
  statements: Object.freeze([
    `CREATE TABLE provider_routes (
      feature TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      prompt_version TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      provider_managed_history_consent_at TEXT,
      provider_managed_history_consent_version TEXT,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      CHECK (feature IN ('lecture_organize','lecture_verify','professor_profile','exam_synthesis','question_generation','answer_verification','grading_feedback')),
      CHECK (provider_id IS NULL OR provider_id IN ('antigravity_cli','gemini_cli','codex_cli','gemini_api','openai_api','claude_api')),
      CHECK (model_id IS NULL OR length(model_id) BETWEEN 1 AND 160),
      CHECK (provider_id IS NOT NULL OR model_id IS NULL),
      CHECK (enabled = 0 OR provider_id IS NOT NULL),
      CHECK (provider_id NOT IN ('gemini_api','openai_api','claude_api') OR model_id IS NOT NULL),
      CHECK (revision >= 0),
      CHECK ((provider_managed_history_consent_at IS NULL) = (provider_managed_history_consent_version IS NULL)),
      CHECK (provider_managed_history_consent_at IS NULL OR provider_id = 'antigravity_cli')
    ) STRICT`,
    `CREATE TABLE provider_diagnostics (
      provider_id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL,
      version TEXT,
      selected_model_id TEXT,
      reported_model_id TEXT,
      credential_present INTEGER NOT NULL CHECK (credential_present IN (0, 1)),
      credential_scope TEXT NOT NULL,
      shared_credential_consent_at TEXT,
      shared_credential_consent_version TEXT,
      provider_managed_history INTEGER NOT NULL CHECK (provider_managed_history IN (0, 1)),
      executable_path TEXT,
      entry_path TEXT,
      executable_sha256 TEXT,
      entry_sha256 TEXT,
      package_manifest_path TEXT,
      package_manifest_sha256 TEXT,
      binding_sha256 TEXT,
      recipe_id TEXT,
      signer_classification TEXT,
      fixed_prefix_args_json TEXT,
      checked_at TEXT NOT NULL,
      latency_ms INTEGER,
      error_code TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      CHECK (provider_id IN ('antigravity_cli','gemini_cli','codex_cli','gemini_api','openai_api','claude_api')),
      CHECK (status IN ('not_checked','installed','credential_saved','missing_executable','missing_credential','unsafe_version','ready','auth_required','account_unsupported','incompatible_model','quota_or_billing','temporarily_unavailable','invalid_provider_output')),
      CHECK (selected_model_id IS NULL OR length(selected_model_id) BETWEEN 1 AND 160),
      CHECK (reported_model_id IS NULL OR length(reported_model_id) BETWEEN 1 AND 160),
      CHECK (credential_scope IN ('not_applicable','profile_scoped','provider_global','unknown')),
      CHECK ((shared_credential_consent_at IS NULL) = (shared_credential_consent_version IS NULL)),
      CHECK (shared_credential_consent_at IS NULL OR credential_scope = 'provider_global'),
      CHECK ((provider_id IN ('antigravity_cli','gemini_cli','codex_cli')) = (credential_scope != 'not_applicable')),
      CHECK (credential_scope != 'unknown' OR status IN ('not_checked','missing_executable','unsafe_version')),
      CHECK (latency_ms IS NULL OR latency_ms >= 0),
      CHECK (error_code IS NULL OR error_code IN (${PROVIDER_ERROR_CODES_SQL})),
      CHECK (executable_sha256 IS NULL OR length(executable_sha256) = 64),
      CHECK (entry_sha256 IS NULL OR length(entry_sha256) = 64),
      CHECK (package_manifest_sha256 IS NULL OR length(package_manifest_sha256) = 64),
      CHECK (binding_sha256 IS NULL OR length(binding_sha256) = 64),
      CHECK ((executable_path IS NULL) = (executable_sha256 IS NULL)),
      CHECK ((executable_path IS NULL) = (recipe_id IS NULL)),
      CHECK ((executable_path IS NULL) = (signer_classification IS NULL)),
      CHECK ((executable_path IS NULL) = (binding_sha256 IS NULL)),
      CHECK ((executable_path IS NULL) = (fixed_prefix_args_json IS NULL)),
      CHECK (executable_path IS NULL OR credential_scope IN ('profile_scoped','provider_global')),
      CHECK ((entry_path IS NULL) = (entry_sha256 IS NULL)),
      CHECK ((package_manifest_path IS NULL) = (package_manifest_sha256 IS NULL)),
      CHECK ((entry_path IS NULL) = (package_manifest_path IS NULL)),
      CHECK (signer_classification != 'nodejs' OR entry_path IS NOT NULL),
      CHECK (entry_path IS NULL OR signer_classification IN ('nodejs','openai')),
      CHECK (signer_classification IS NULL OR signer_classification IN ('google','openai','nodejs')),
      CHECK (provider_id IN ('antigravity_cli','gemini_cli','codex_cli') OR executable_path IS NULL),
      CHECK (revision >= 0)
    ) STRICT`,
    `CREATE TABLE provider_invocations (
      id TEXT PRIMARY KEY NOT NULL,
      request_id TEXT NOT NULL,
      job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      feature TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      selected_model_id TEXT,
      reported_model_id TEXT,
      prompt_version TEXT NOT NULL,
      output_schema_id TEXT NOT NULL,
      route_revision INTEGER NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
      response_sha256 TEXT CHECK (response_sha256 IS NULL OR length(response_sha256) = 64),
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
      attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('initial','transient_retry','format_repair')),
      retry_of TEXT REFERENCES provider_invocations(id) ON DELETE SET NULL,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      error_code TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      CHECK (feature IN ('lecture_organize','lecture_verify','professor_profile','exam_synthesis','question_generation','answer_verification','grading_feedback')),
      CHECK (provider_id IN ('antigravity_cli','gemini_cli','codex_cli','gemini_api','openai_api','claude_api')),
      CHECK (selected_model_id IS NULL OR length(selected_model_id) BETWEEN 1 AND 160),
      CHECK (reported_model_id IS NULL OR length(reported_model_id) BETWEEN 1 AND 160),
      CHECK (error_code IS NULL OR error_code IN (${PROVIDER_ERROR_CODES_SQL})),
      CHECK (latency_ms IS NULL OR latency_ms >= 0),
      CHECK (input_tokens IS NULL OR input_tokens >= 0),
      CHECK (output_tokens IS NULL OR output_tokens >= 0),
      CHECK (total_tokens IS NULL OR total_tokens >= 0),
      CHECK (route_revision >= 0),
      CHECK (revision >= 0),
      CHECK ((status = 'running') = (completed_at IS NULL)),
      CHECK (status != 'running' OR (reported_model_id IS NULL AND response_sha256 IS NULL AND latency_ms IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL AND error_code IS NULL)),
      CHECK (status = 'completed' OR response_sha256 IS NULL),
      CHECK (status != 'completed' OR (response_sha256 IS NOT NULL AND error_code IS NULL)),
      CHECK (status NOT IN ('failed','cancelled') OR error_code IS NOT NULL)
    ) STRICT`,
    'CREATE INDEX provider_invocations_job_started_idx ON provider_invocations(job_id, started_at)',
    'CREATE INDEX provider_invocations_feature_started_idx ON provider_invocations(feature, started_at)',
  ]),
  parameterizedStatements: Object.freeze(
    LEGACY_FEATURES.map((feature, index) =>
      Object.freeze({
        sql: `INSERT INTO provider_routes (
          feature, provider_id, model_id, prompt_version, enabled,
          provider_managed_history_consent_at, provider_managed_history_consent_version,
          updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        parameters: Object.freeze([
          feature,
          feature === 'lecture_verify' || feature === 'answer_verification'
            ? null
            : 'antigravity_cli',
          null,
          LEGACY_PROMPTS[index] ?? '',
          0,
          null,
          null,
          '1970-01-01T00:00:00.000Z',
          0,
        ]),
      }),
    ),
  ),
});

const MIGRATION_THREE: SqliteMigration = Object.freeze({
  version: 3,
  statements: Object.freeze([
    'ALTER TABLE provider_diagnostics RENAME TO provider_diagnostics_v2',
    `CREATE TABLE provider_diagnostics (
      provider_id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL,
      version TEXT,
      selected_model_id TEXT,
      reported_model_id TEXT,
      credential_present INTEGER NOT NULL CHECK (credential_present IN (0, 1)),
      credential_scope TEXT NOT NULL,
      shared_credential_consent_at TEXT,
      shared_credential_consent_version TEXT,
      provider_managed_history INTEGER NOT NULL CHECK (provider_managed_history IN (0, 1)),
      executable_path TEXT,
      entry_path TEXT,
      executable_sha256 TEXT,
      entry_sha256 TEXT,
      package_manifest_path TEXT,
      package_manifest_sha256 TEXT,
      platform_package_manifest_path TEXT,
      platform_package_manifest_sha256 TEXT,
      binding_sha256 TEXT,
      recipe_id TEXT,
      signer_classification TEXT,
      fixed_prefix_args_json TEXT,
      checked_at TEXT NOT NULL,
      latency_ms INTEGER,
      error_code TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      CHECK (provider_id IN ('antigravity_cli','gemini_cli','codex_cli','gemini_api','openai_api','claude_api')),
      CHECK (status IN ('not_checked','installed','credential_saved','missing_executable','missing_credential','unsafe_version','ready','auth_required','account_unsupported','incompatible_model','quota_or_billing','temporarily_unavailable','invalid_provider_output')),
      CHECK (selected_model_id IS NULL OR length(selected_model_id) BETWEEN 1 AND 160),
      CHECK (reported_model_id IS NULL OR length(reported_model_id) BETWEEN 1 AND 160),
      CHECK (credential_scope IN ('not_applicable','profile_scoped','provider_global','unknown')),
      CHECK ((shared_credential_consent_at IS NULL) = (shared_credential_consent_version IS NULL)),
      CHECK (shared_credential_consent_at IS NULL OR credential_scope = 'provider_global'),
      CHECK ((provider_id IN ('antigravity_cli','gemini_cli','codex_cli')) = (credential_scope != 'not_applicable')),
      CHECK (credential_scope != 'unknown' OR status IN ('not_checked','missing_executable','unsafe_version')),
      CHECK (latency_ms IS NULL OR latency_ms >= 0),
      CHECK (error_code IS NULL OR error_code IN (${PROVIDER_ERROR_CODES_SQL})),
      CHECK (executable_sha256 IS NULL OR length(executable_sha256) = 64),
      CHECK (entry_sha256 IS NULL OR length(entry_sha256) = 64),
      CHECK (package_manifest_sha256 IS NULL OR length(package_manifest_sha256) = 64),
      CHECK (platform_package_manifest_sha256 IS NULL OR length(platform_package_manifest_sha256) = 64),
      CHECK (binding_sha256 IS NULL OR length(binding_sha256) = 64),
      CHECK ((executable_path IS NULL) = (executable_sha256 IS NULL)),
      CHECK ((executable_path IS NULL) = (recipe_id IS NULL)),
      CHECK ((executable_path IS NULL) = (signer_classification IS NULL)),
      CHECK ((executable_path IS NULL) = (binding_sha256 IS NULL)),
      CHECK ((executable_path IS NULL) = (fixed_prefix_args_json IS NULL)),
      CHECK (executable_path IS NULL OR credential_scope IN ('profile_scoped','provider_global')),
      CHECK ((entry_path IS NULL) = (entry_sha256 IS NULL)),
      CHECK ((package_manifest_path IS NULL) = (package_manifest_sha256 IS NULL)),
      CHECK ((platform_package_manifest_path IS NULL) = (platform_package_manifest_sha256 IS NULL)),
      CHECK ((entry_path IS NULL) = (package_manifest_path IS NULL)),
      CHECK (signer_classification IS NULL OR signer_classification IN ('google','openai','nodejs')),
      CHECK (provider_id IN ('antigravity_cli','gemini_cli','codex_cli') OR executable_path IS NULL),
      CHECK (
        executable_path IS NULL OR
        (
          entry_path IS NULL AND package_manifest_path IS NULL AND
          platform_package_manifest_path IS NULL AND
          ((provider_id = 'antigravity_cli' AND signer_classification = 'google') OR
           (provider_id = 'codex_cli' AND signer_classification = 'openai'))
        ) OR
        (
          provider_id = 'gemini_cli' AND signer_classification = 'nodejs' AND
          entry_path IS NOT NULL AND package_manifest_path IS NOT NULL AND
          platform_package_manifest_path IS NULL
        ) OR
        (
          provider_id = 'codex_cli' AND signer_classification = 'openai' AND
          entry_path IS NOT NULL AND package_manifest_path IS NOT NULL AND
          platform_package_manifest_path IS NOT NULL
        )
      ),
      CHECK (revision >= 0)
    ) STRICT`,
    `INSERT INTO provider_diagnostics (
      provider_id, status, version, selected_model_id, reported_model_id, credential_present,
      credential_scope, shared_credential_consent_at, shared_credential_consent_version,
      provider_managed_history, executable_path, entry_path, executable_sha256, entry_sha256,
      package_manifest_path, package_manifest_sha256, platform_package_manifest_path,
      platform_package_manifest_sha256, binding_sha256, recipe_id, signer_classification,
      fixed_prefix_args_json, checked_at, latency_ms, error_code, revision
    ) SELECT
      provider_id,
      CASE WHEN executable_path IS NOT NULL THEN 'not_checked' ELSE status END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE version END,
      selected_model_id,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE reported_model_id END,
      CASE WHEN executable_path IS NOT NULL THEN 0 ELSE credential_present END,
      CASE WHEN executable_path IS NOT NULL THEN 'unknown' ELSE credential_scope END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE shared_credential_consent_at END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE shared_credential_consent_version END,
      CASE WHEN executable_path IS NOT NULL THEN 0 ELSE provider_managed_history END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE executable_path END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE entry_path END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE executable_sha256 END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE entry_sha256 END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE package_manifest_path END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE package_manifest_sha256 END,
      NULL,
      NULL,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE binding_sha256 END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE recipe_id END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE signer_classification END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE fixed_prefix_args_json END,
      checked_at,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE latency_ms END,
      CASE WHEN executable_path IS NOT NULL THEN NULL ELSE error_code END,
      CASE WHEN executable_path IS NOT NULL THEN revision + 1 ELSE revision END
    FROM provider_diagnostics_v2`,
    'DROP TABLE provider_diagnostics_v2',
  ]),
});

const MIGRATION_FOUR: SqliteMigration = Object.freeze({
  version: 4,
  statements: Object.freeze([
    'ALTER TABLE provider_diagnostics RENAME TO provider_diagnostics_v3',
    `CREATE TABLE provider_diagnostics (
      provider_id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL,
      version TEXT,
      selected_model_id TEXT,
      reported_model_id TEXT,
      credential_present INTEGER NOT NULL CHECK (credential_present IN (0, 1)),
      credential_scope TEXT NOT NULL,
      shared_credential_consent_at TEXT,
      shared_credential_consent_version TEXT,
      provider_managed_history INTEGER NOT NULL CHECK (provider_managed_history IN (0, 1)),
      executable_path TEXT,
      entry_path TEXT,
      executable_sha256 TEXT,
      entry_sha256 TEXT,
      package_manifest_path TEXT,
      package_manifest_sha256 TEXT,
      platform_package_manifest_path TEXT,
      platform_package_manifest_sha256 TEXT,
      binding_sha256 TEXT,
      recipe_id TEXT,
      signer_classification TEXT,
      fixed_prefix_args_json TEXT,
      checked_at TEXT,
      latency_ms INTEGER,
      error_code TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      CHECK (provider_id IN ('antigravity_cli','gemini_cli','codex_cli','gemini_api','openai_api','claude_api')),
      CHECK (status IN ('not_checked','installed','credential_saved','missing_executable','missing_credential','unsafe_version','ready','auth_required','account_unsupported','incompatible_model','quota_or_billing','temporarily_unavailable','invalid_provider_output')),
      CHECK (selected_model_id IS NULL OR length(selected_model_id) BETWEEN 1 AND 160),
      CHECK (reported_model_id IS NULL OR length(reported_model_id) BETWEEN 1 AND 160),
      CHECK (credential_scope IN ('not_applicable','profile_scoped','provider_global','unknown')),
      CHECK ((shared_credential_consent_at IS NULL) = (shared_credential_consent_version IS NULL)),
      CHECK (shared_credential_consent_at IS NULL OR credential_scope = 'provider_global'),
      CHECK ((provider_id IN ('antigravity_cli','gemini_cli','codex_cli')) = (credential_scope != 'not_applicable')),
      CHECK (credential_scope != 'unknown' OR status IN ('not_checked','missing_executable','missing_credential','unsafe_version')),
      CHECK (latency_ms IS NULL OR latency_ms >= 0),
      CHECK (error_code IS NULL OR error_code IN (${PROVIDER_ERROR_CODES_SQL})),
      CHECK (executable_sha256 IS NULL OR length(executable_sha256) = 64),
      CHECK (entry_sha256 IS NULL OR length(entry_sha256) = 64),
      CHECK (package_manifest_sha256 IS NULL OR length(package_manifest_sha256) = 64),
      CHECK (platform_package_manifest_sha256 IS NULL OR length(platform_package_manifest_sha256) = 64),
      CHECK (binding_sha256 IS NULL OR length(binding_sha256) = 64),
      CHECK ((executable_path IS NULL) = (executable_sha256 IS NULL)),
      CHECK ((executable_path IS NULL) = (recipe_id IS NULL)),
      CHECK ((executable_path IS NULL) = (signer_classification IS NULL)),
      CHECK ((executable_path IS NULL) = (binding_sha256 IS NULL)),
      CHECK ((executable_path IS NULL) = (fixed_prefix_args_json IS NULL)),
      CHECK (executable_path IS NULL OR credential_scope IN ('profile_scoped','provider_global')),
      CHECK ((entry_path IS NULL) = (entry_sha256 IS NULL)),
      CHECK ((package_manifest_path IS NULL) = (package_manifest_sha256 IS NULL)),
      CHECK ((platform_package_manifest_path IS NULL) = (platform_package_manifest_sha256 IS NULL)),
      CHECK ((entry_path IS NULL) = (package_manifest_path IS NULL)),
      CHECK (signer_classification IS NULL OR signer_classification IN ('google','openai','nodejs')),
      CHECK (provider_id IN ('antigravity_cli','gemini_cli','codex_cli') OR executable_path IS NULL),
      CHECK (
        executable_path IS NULL OR
        (
          entry_path IS NULL AND package_manifest_path IS NULL AND
          platform_package_manifest_path IS NULL AND
          ((provider_id = 'antigravity_cli' AND signer_classification = 'google') OR
           (provider_id = 'codex_cli' AND signer_classification = 'openai'))
        ) OR
        (
          provider_id = 'gemini_cli' AND signer_classification = 'nodejs' AND
          entry_path IS NOT NULL AND package_manifest_path IS NOT NULL AND
          platform_package_manifest_path IS NULL
        ) OR
        (
          provider_id = 'codex_cli' AND signer_classification = 'openai' AND
          entry_path IS NOT NULL AND package_manifest_path IS NOT NULL AND
          platform_package_manifest_path IS NOT NULL
        )
      ),
      CHECK (revision >= 0)
    ) STRICT`,
    `INSERT INTO provider_diagnostics (
      provider_id, status, version, selected_model_id, reported_model_id, credential_present,
      credential_scope, shared_credential_consent_at, shared_credential_consent_version,
      provider_managed_history, executable_path, entry_path, executable_sha256, entry_sha256,
      package_manifest_path, package_manifest_sha256, platform_package_manifest_path,
      platform_package_manifest_sha256, binding_sha256, recipe_id, signer_classification,
      fixed_prefix_args_json, checked_at, latency_ms, error_code, revision
    ) SELECT
      provider_id,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN 'not_checked' ELSE status END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE version END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE selected_model_id END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE reported_model_id END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN 0 ELSE credential_present END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN 'unknown' ELSE credential_scope END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE shared_credential_consent_at END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE shared_credential_consent_version END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN 0 ELSE provider_managed_history END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE executable_path END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE entry_path END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE executable_sha256 END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE entry_sha256 END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE package_manifest_path END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE package_manifest_sha256 END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE platform_package_manifest_path END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE platform_package_manifest_sha256 END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE binding_sha256 END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE recipe_id END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE signer_classification END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE fixed_prefix_args_json END,
      CASE
        WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL
        WHEN status = 'not_checked' THEN NULL
        ELSE checked_at
      END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE latency_ms END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN NULL ELSE error_code END,
      CASE WHEN provider_id = 'codex_cli' AND recipe_id = 'codex-0.146-exec-json-v1' THEN revision + 1 ELSE revision END
    FROM provider_diagnostics_v3`,
    'DROP TABLE provider_diagnostics_v3',
  ]),
});

const MIGRATION_FIVE: SqliteMigration = Object.freeze({
  version: 5,
  statements: Object.freeze([
    `CREATE TABLE source_bundles (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
      manifest_sha256 TEXT NOT NULL,
      source_count INTEGER NOT NULL CHECK (source_count BETWEEN 1 AND 32),
      total_bytes INTEGER NOT NULL CHECK (total_bytes > 0),
      staging_directory_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE source_records (
      id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL REFERENCES source_bundles(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      original_file_name TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('audio','video','document','image')),
      staged_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      UNIQUE(bundle_id, ordinal),
      UNIQUE(bundle_id, sha256)
    ) STRICT`,
    'ALTER TABLE jobs ADD COLUMN source_bundle_id TEXT',
    `ALTER TABLE jobs ADD COLUMN source_count INTEGER NOT NULL DEFAULT 1
      CHECK (source_count BETWEEN 1 AND 32)`,
  ]),
});

const EXPANDED_FEATURES_SQL =
  "'content_classification','media_extraction','topic_clustering','source_question_extraction','question_variation','course_question_answer','audio_transcription','document_recognition','core_summary','lecture_organize','lecture_verify','professor_profile','exam_synthesis','question_generation','answer_verification','grading_feedback'";
const expandedTable = (name: string): string => {
  const original = (
    name === 'provider_diagnostics' ? MIGRATION_FOUR : MIGRATION_TWO
  ).statements.find((sql) => sql.startsWith(`CREATE TABLE ${name} (`));
  if (original === undefined) throw new TypeError('MISSING_HISTORICAL_TABLE');
  return original
    .replace(`CREATE TABLE ${name} (`, `CREATE TABLE ${name}_v6 (`)
    .replace(/CHECK \(feature IN \([^)]*\)\)/u, `CHECK (feature IN (${EXPANDED_FEATURES_SQL}))`)
    .replace('REFERENCES provider_invocations(id)', 'REFERENCES provider_invocations_v6(id)')
    .replace(
      "'PROVIDER_MODEL_INCOMPATIBLE'",
      "'PROVIDER_MODEL_INCOMPATIBLE','PROVIDER_MEDIA_UNSUPPORTED'",
    );
};
const MIGRATION_SIX: SqliteMigration = Object.freeze({
  version: 6,
  statements: Object.freeze([
    expandedTable('provider_routes'),
    'INSERT INTO provider_routes_v6 SELECT * FROM provider_routes',
    'DROP TABLE provider_routes',
    'ALTER TABLE provider_routes_v6 RENAME TO provider_routes',
    expandedTable('provider_invocations'),
    'INSERT INTO provider_invocations_v6 SELECT * FROM provider_invocations',
    'DROP TABLE provider_invocations',
    'ALTER TABLE provider_invocations_v6 RENAME TO provider_invocations',
    'CREATE INDEX provider_invocations_job_started_idx ON provider_invocations(job_id, started_at)',
    'CREATE INDEX provider_invocations_feature_started_idx ON provider_invocations(feature, started_at)',
    expandedTable('provider_diagnostics'),
    'INSERT INTO provider_diagnostics_v6 SELECT * FROM provider_diagnostics',
    'DROP TABLE provider_diagnostics',
    'ALTER TABLE provider_diagnostics_v6 RENAME TO provider_diagnostics',
  ]),
  parameterizedStatements: Object.freeze(
    [
      'content_classification',
      'media_extraction',
      'topic_clustering',
      'source_question_extraction',
      'question_variation',
      'course_question_answer',
      'audio_transcription',
      'document_recognition',
      'core_summary',
    ].map((feature) =>
      Object.freeze({
        sql: 'INSERT INTO provider_routes (feature, provider_id, model_id, prompt_version, enabled, provider_managed_history_consent_at, provider_managed_history_consent_version, updated_at, revision) VALUES (?, NULL, NULL, ?, 0, NULL, NULL, ?, 0)',
        parameters: Object.freeze([
          feature,
          `${feature.replaceAll('_', '-')}-v1`,
          '1970-01-01T00:00:00.000Z',
        ]),
      }),
    ),
  ),
});

const MIGRATION_SEVEN: SqliteMigration = Object.freeze({
  version: 7,
  statements: Object.freeze([
    `CREATE TABLE pipeline_artifacts (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK (stage IN ('classification','extraction','evidence','clustering','synthesis','verification')),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      relative_path TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
      identity_sha256 TEXT NOT NULL CHECK (length(identity_sha256) = 64 AND identity_sha256 NOT GLOB '*[^a-f0-9]*'),
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_id, stage)
    ) STRICT`,
  ]),
});

const PROMPT_PROFILE_COLUMNS_V8 = `
  scope TEXT NOT NULL CHECK (scope IN ('global','course','feature')),
  course_id TEXT REFERENCES courses(id) ON DELETE RESTRICT,
  feature TEXT CHECK (feature IN ('content_classification','media_extraction','topic_clustering','source_question_extraction','question_variation','course_question_answer','audio_transcription','document_recognition','core_summary','lecture_organize','lecture_verify','professor_profile','exam_synthesis','question_generation','answer_verification','grading_feedback')),
  additional_instructions TEXT NOT NULL CHECK (length(CAST(additional_instructions AS BLOB)) <= 65536),
  template_override TEXT CHECK (template_override IS NULL OR length(CAST(template_override AS BLOB)) BETWEEN 1 AND 262144),
  name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 256),
  base_version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK (deleted IN (0,1)),
  CHECK ((scope = 'global' AND course_id IS NULL AND feature IS NULL)
    OR (scope = 'course' AND course_id IS NOT NULL AND feature IS NULL)
    OR (scope = 'feature' AND feature IS NOT NULL))`;

const MIGRATION_EIGHT: SqliteMigration = Object.freeze({
  version: 8,
  statements: Object.freeze([
    `CREATE TABLE prompt_profiles (id TEXT PRIMARY KEY, ${PROMPT_PROFILE_COLUMNS_V8}) STRICT`,
    "CREATE UNIQUE INDEX prompt_profiles_scope_key ON prompt_profiles(scope, COALESCE(course_id, ''), COALESCE(feature, ''))",
    `CREATE TABLE prompt_profile_history (id TEXT NOT NULL REFERENCES prompt_profiles(id) ON DELETE RESTRICT,
      ${PROMPT_PROFILE_COLUMNS_V8}, PRIMARY KEY(id, revision)) STRICT`,
    `CREATE TRIGGER prompt_history_no_update BEFORE UPDATE ON prompt_profile_history
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_PROMPT_HISTORY'); END`,
    `CREATE TRIGGER prompt_history_no_delete BEFORE DELETE ON prompt_profile_history
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_PROMPT_HISTORY'); END`,
  ]),
});

// Preserve the historical table/data; only classification has a reviewed v2 payload.
const MIGRATION_NINE: SqliteMigration = Object.freeze({
  version: 9,
  statements: Object.freeze([
    MIGRATION_SEVEN.statements
      .join('\n')
      .replace('CREATE TABLE pipeline_artifacts (', 'CREATE TABLE pipeline_artifacts_v9 (')
      .replace(
        'CHECK (schema_version = 1)',
        "CHECK (schema_version = 1 OR (schema_version = 2 AND stage = 'classification'))",
      ),
    'INSERT INTO pipeline_artifacts_v9 SELECT * FROM pipeline_artifacts',
    'DROP TABLE pipeline_artifacts',
    'ALTER TABLE pipeline_artifacts_v9 RENAME TO pipeline_artifacts',
  ]),
});

// V10 is additive. The accepted head is the highest immutable history revision;
// no independently mutable head row can diverge from its audit trail.
const managedHashV10 = (column: string): string =>
  `length(CAST(${column} AS BLOB)) = 64 AND instr(${column}, char(0)) = 0 AND ${column} NOT GLOB '*[^a-f0-9]*'`;
const managedPathV10 = (column: string): string =>
  `length(${column}) BETWEEN 4 AND 1024 AND substr(${column}, -3) = '.md'
   AND substr(${column}, 1, 1) != '/' AND instr(${column}, char(92)) = 0
   AND instr(${column}, ':') = 0 AND instr(${column}, char(0)) = 0
   AND instr('/' || ${column} || '/', '/../') = 0
   AND instr('/' || ${column} || '/', '/./') = 0 AND instr(${column}, '//') = 0`;
const managedIdentityV10 = (column: string): string =>
  `length(${column}) BETWEEN 1 AND 80 AND instr(${column}, char(0)) = 0 AND ${column} NOT GLOB '*[^a-z0-9_-]*'
   AND substr(${column}, 1, 1) GLOB '[a-z0-9]'`;
const managedGenerationV10 = `length(generation_revision) BETWEEN 1 AND 80
  AND instr(generation_revision, char(0)) = 0
  AND generation_revision NOT GLOB '*[^A-Za-z0-9_-]*'
  AND substr(generation_revision, 1, 1) GLOB '[A-Za-z0-9]'`;
const MIGRATION_TEN: SqliteMigration = Object.freeze({
  version: 10,
  statements: Object.freeze([
    `CREATE TABLE managed_note_history (
      stable_id TEXT NOT NULL CHECK (${managedIdentityV10('stable_id')}),
      relative_path TEXT NOT NULL CHECK (${managedPathV10('relative_path')}),
      path_key TEXT NOT NULL CHECK (${managedPathV10('path_key')}),
      generated_base TEXT NOT NULL CHECK (length(CAST(generated_base AS BLOB)) <= 16777216 AND instr(generated_base, char(0)) = 0),
      generated_base_hash TEXT NOT NULL CHECK (${managedHashV10('generated_base_hash')}),
      published_hash TEXT NOT NULL CHECK (${managedHashV10('published_hash')}),
      generation_revision TEXT NOT NULL CHECK (${managedGenerationV10}),
      revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
      decision TEXT NOT NULL CHECK (decision IN ('written','unchanged')),
      created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND substr(created_at, -1) = 'Z'),
      updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND substr(updated_at, -1) = 'Z' AND updated_at >= created_at),
      PRIMARY KEY(stable_id, revision)
    ) STRICT`,
    'CREATE INDEX managed_note_path_idx ON managed_note_history(path_key, stable_id, revision DESC)',
    `CREATE TRIGGER managed_note_append_guard BEFORE INSERT ON managed_note_history BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM managed_note_history WHERE rowid = NEW.rowid)
        THEN RAISE(ABORT, 'IMMUTABLE_MANAGED_AUDIT') END;
      SELECT CASE WHEN NEW.revision != COALESCE((SELECT MAX(revision) + 1 FROM managed_note_history WHERE stable_id = NEW.stable_id), 0)
        THEN RAISE(ABORT, 'STALE_MANAGED_REVISION') END;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM managed_note_history WHERE path_key = NEW.path_key AND stable_id != NEW.stable_id)
        THEN RAISE(ABORT, 'MANAGED_PATH_OWNED') END;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM managed_note_history WHERE stable_id = NEW.stable_id AND
        (relative_path != NEW.relative_path OR path_key != NEW.path_key OR created_at != NEW.created_at OR updated_at > NEW.updated_at))
        THEN RAISE(ABORT, 'MANAGED_IDENTITY_CHANGED') END;
    END`,
    `CREATE TABLE managed_note_conflicts (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(CAST(id AS BLOB)) = 36 AND instr(id, char(0)) = 0 AND id NOT GLOB '*[^a-f0-9-]*'),
      stable_id TEXT NOT NULL CHECK (${managedIdentityV10('stable_id')}),
      original_path TEXT NOT NULL CHECK (${managedPathV10('original_path')}),
      current_path TEXT NOT NULL CHECK (${managedPathV10('current_path')}),
      candidate_path TEXT NOT NULL CHECK (${managedPathV10('candidate_path')} AND candidate_path != current_path),
      current_hash TEXT CHECK (current_hash IS NULL OR (${managedHashV10('current_hash')})),
      candidate_hash TEXT NOT NULL CHECK (${managedHashV10('candidate_hash')}),
      generation_revision TEXT NOT NULL CHECK (${managedGenerationV10}),
      reason TEXT NOT NULL CHECK (reason IN ('malformed_markers','managed_content_changed','locked','missing_current','untracked_path','path_owned','unexpected_current','writer_conflict')),
      created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND substr(created_at, -1) = 'Z')
    ) STRICT`,
    'CREATE INDEX managed_note_conflict_lookup_idx ON managed_note_conflicts(stable_id, created_at, id)',
    `CREATE TRIGGER managed_note_conflict_no_replace BEFORE INSERT ON managed_note_conflicts
      WHEN EXISTS (SELECT 1 FROM managed_note_conflicts WHERE id = NEW.id OR rowid = NEW.rowid)
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_MANAGED_AUDIT'); END`,
    ...['managed_note_history', 'managed_note_conflicts'].flatMap((table) =>
      ['UPDATE', 'DELETE'].map(
        (operation) =>
          `CREATE TRIGGER ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
       BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_MANAGED_AUDIT'); END`,
      ),
    ),
  ]),
});

export const SQLITE_MIGRATIONS = Object.freeze([
  MIGRATION_ONE,
  MIGRATION_TWO,
  MIGRATION_THREE,
  MIGRATION_FOUR,
  MIGRATION_FIVE,
  MIGRATION_SIX,
  MIGRATION_SEVEN,
  MIGRATION_EIGHT,
  MIGRATION_NINE,
  MIGRATION_TEN,
] as const);
export const CURRENT_SCHEMA_VERSION = SQLITE_MIGRATIONS.at(-1)?.version ?? 0;

const MigrationSchema = z
  .strictObject({
    version: z.int().positive(),
    statements: z.array(z.string().trim().min(1)).min(1),
    parameterizedStatements: z
      .array(
        z.strictObject({
          sql: z.string().trim().min(1),
          parameters: z.array(z.union([z.string(), z.number(), z.null()])),
        }),
      )
      .optional(),
  })
  .readonly();

const AppliedVersionRowSchema = z.strictObject({ version: z.int().positive() });
const HighestVersionRowSchema = z.strictObject({ version: z.int().positive().nullable() });

const migrationError = (): AppError =>
  new AppError('DATABASE_MIGRATION_FAILED', APP_ERROR_MESSAGES.DATABASE_MIGRATION_FAILED);

const rollback = (database: DatabaseSync): void => {
  try {
    database.exec('ROLLBACK');
  } catch {
    throw migrationError();
  }
};

const ensureMigrationTable = (database: DatabaseSync): void => {
  try {
    database.exec('BEGIN IMMEDIATE');
    database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT`);
    database.exec('COMMIT');
  } catch {
    rollback(database);
    throw migrationError();
  }
};

export const applyMigrations = (
  database: DatabaseSync,
  migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
  appliedAt: string = new Date().toISOString(),
): void => {
  ensureMigrationTable(database);

  const parsedMigrations = migrations.map((migration) => MigrationSchema.parse(migration));
  const versions = parsedMigrations.map(({ version }) => version);
  if (
    new Set(versions).size !== versions.length ||
    versions.some((version, index) => index > 0 && version <= (versions[index - 1] ?? 0))
  ) {
    throw migrationError();
  }

  const highestTargetVersion = versions.at(-1) ?? 0;
  const highestAppliedVersion = database.prepare(
    'SELECT MAX(version) AS version FROM schema_migrations',
  );
  const findAppliedVersion = database.prepare(
    'SELECT version FROM schema_migrations WHERE version = ?',
  );
  const insertVersion = database.prepare(
    'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
  );
  for (const migration of parsedMigrations) {
    try {
      database.exec('BEGIN IMMEDIATE');
      const highestApplied = HighestVersionRowSchema.parse(highestAppliedVersion.get()).version;
      if (highestApplied !== null && highestApplied > highestTargetVersion) {
        throw migrationError();
      }

      const alreadyApplied = findAppliedVersion.get(migration.version);
      if (alreadyApplied !== undefined) {
        AppliedVersionRowSchema.parse(alreadyApplied);
        database.exec('COMMIT');
        continue;
      }

      for (const statement of migration.statements) {
        database.exec(statement);
      }
      for (const statement of migration.parameterizedStatements ?? []) {
        database.prepare(statement.sql).run(...statement.parameters);
      }
      insertVersion.run(migration.version, appliedAt);
      database.exec('COMMIT');
    } catch {
      rollback(database);
      throw migrationError();
    }
  }
};
