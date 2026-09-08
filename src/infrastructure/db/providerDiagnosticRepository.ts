import { isAbsolute } from 'node:path';
import type { StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type { CliRuntimeBinding, ProviderDiagnostic } from '../../core/ports/aiProvider';
import type { ProviderDiagnosticRepository } from '../../core/ports/providerRepositories';
import {
  AI_PROVIDER_IDS,
  type AiProviderId,
  type CliProviderId,
  ModelIdSchema,
  ProviderStatusSchema,
  parseSafeSemVer,
  SHARED_CREDENTIAL_NOTICE_VERSION,
  Sha256Schema,
  TRUSTED_CLI_BINDING_RECIPES,
} from '../../shared/contracts/provider';
import { ProviderErrorCodeSchema } from '../../shared/errors';
import type { SqliteDatabase } from './sqliteDatabase';
import {
  assertNextRevision,
  assertSingleChange,
  parseDatabaseEntity,
  translateSqliteError,
} from './sqliteErrors';

const DIAGNOSTIC_COLUMNS = `
  provider_id AS providerId,
  status,
  version,
  selected_model_id AS selectedModelId,
  reported_model_id AS reportedModelId,
  credential_present AS credentialPresent,
  credential_scope AS credentialScope,
  shared_credential_consent_at AS sharedCredentialConsentAt,
  shared_credential_consent_version AS sharedCredentialConsentVersion,
  provider_managed_history AS providerManagedHistory,
  executable_path AS executablePath,
  entry_path AS entryPath,
  executable_sha256 AS executableSha256,
  entry_sha256 AS entrySha256,
  package_manifest_path AS packageManifestPath,
  package_manifest_sha256 AS packageManifestSha256,
  platform_package_manifest_path AS platformPackageManifestPath,
  platform_package_manifest_sha256 AS platformPackageManifestSha256,
  binding_sha256 AS bindingSha256,
  recipe_id AS recipeId,
  signer_classification AS signerClassification,
  fixed_prefix_args_json AS fixedPrefixArgsJson,
  checked_at AS checkedAt,
  latency_ms AS latencyMs,
  error_code AS errorCode,
  revision
`;

const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const PrivatePathSchema = z
  .string()
  .min(3)
  .max(32_767)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
  .refine(isAbsolute);
const RecipeIdSchema = z.string().min(1).max(120);
const FixedPrefixArgsSchema = z.array(z.string().min(1).max(120)).max(64);
const UnknownCliProviderStatusSchema = ProviderStatusSchema.extract([
  'not_checked',
  'missing_executable',
  'missing_credential',
  'unsafe_version',
]);

const DiagnosticRowSchema = z.strictObject({
  providerId: z.enum(AI_PROVIDER_IDS),
  status: ProviderStatusSchema,
  version: z.string().nullable(),
  selectedModelId: ModelIdSchema.nullable(),
  reportedModelId: ModelIdSchema.nullable(),
  credentialPresent: z.union([z.literal(0), z.literal(1)]),
  credentialScope: z.enum(['not_applicable', 'profile_scoped', 'provider_global', 'unknown']),
  sharedCredentialConsentAt: IsoDateTimeSchema.nullable(),
  sharedCredentialConsentVersion: z.string().nullable(),
  providerManagedHistory: z.union([z.literal(0), z.literal(1)]),
  executablePath: PrivatePathSchema.nullable(),
  entryPath: PrivatePathSchema.nullable(),
  executableSha256: Sha256Schema.nullable(),
  entrySha256: Sha256Schema.nullable(),
  packageManifestPath: PrivatePathSchema.nullable(),
  packageManifestSha256: Sha256Schema.nullable(),
  platformPackageManifestPath: PrivatePathSchema.nullable(),
  platformPackageManifestSha256: Sha256Schema.nullable(),
  bindingSha256: Sha256Schema.nullable(),
  recipeId: RecipeIdSchema.nullable(),
  signerClassification: z.enum(['google', 'openai', 'nodejs']).nullable(),
  fixedPrefixArgsJson: z.string().max(8_192).nullable(),
  checkedAt: IsoDateTimeSchema.nullable(),
  latencyMs: z.int().min(0).nullable(),
  errorCode: z.string().nullable(),
  revision: z.int(),
});

const hasNoPrivateBindingColumns = (row: z.infer<typeof DiagnosticRowSchema>): boolean =>
  row.executablePath === null &&
  row.entryPath === null &&
  row.executableSha256 === null &&
  row.entrySha256 === null &&
  row.packageManifestPath === null &&
  row.packageManifestSha256 === null &&
  row.platformPackageManifestPath === null &&
  row.platformPackageManifestSha256 === null &&
  row.bindingSha256 === null &&
  row.recipeId === null &&
  row.signerClassification === null &&
  row.fixedPrefixArgsJson === null;

const requireTrustedRecipe = (
  providerId: CliProviderId,
  recipeId: string,
  fixedPrefixArgs: readonly string[],
  canonicalEntryPath: string | null,
): void => {
  const recipe = TRUSTED_CLI_BINDING_RECIPES[providerId];
  const expectedPrefixArgs =
    recipe.launcherPrefix === 'none'
      ? []
      : canonicalEntryPath === null
        ? null
        : [canonicalEntryPath];
  if (
    recipe.recipeId !== recipeId ||
    expectedPrefixArgs === null ||
    expectedPrefixArgs.length !== fixedPrefixArgs.length ||
    expectedPrefixArgs.some((argument, index) => argument !== fixedPrefixArgs[index])
  ) {
    throw new TypeError('UNTRUSTED_CLI_BINDING_RECIPE');
  }
};

const requireCliBinding = (row: z.infer<typeof DiagnosticRowSchema>): CliRuntimeBinding => {
  if (
    row.executablePath === null ||
    row.executableSha256 === null ||
    (row.entryPath === null && row.entrySha256 !== null) ||
    (row.entryPath !== null && row.entrySha256 === null) ||
    (row.packageManifestPath === null && row.packageManifestSha256 !== null) ||
    (row.packageManifestPath !== null && row.packageManifestSha256 === null) ||
    (row.platformPackageManifestPath === null && row.platformPackageManifestSha256 !== null) ||
    (row.platformPackageManifestPath !== null && row.platformPackageManifestSha256 === null) ||
    row.bindingSha256 === null ||
    row.recipeId === null ||
    row.signerClassification === null ||
    row.fixedPrefixArgsJson === null ||
    row.version === null ||
    row.checkedAt === null ||
    (row.credentialScope !== 'profile_scoped' && row.credentialScope !== 'provider_global')
  ) {
    throw new TypeError('INVALID_PROVIDER_DIAGNOSTIC_ROW');
  }
  const providerId = row.providerId;
  if (
    providerId !== 'antigravity_cli' &&
    providerId !== 'gemini_cli' &&
    providerId !== 'codex_cli'
  ) {
    throw new TypeError('INVALID_PROVIDER_DIAGNOSTIC_ROW');
  }
  const fixedPrefixArgs = FixedPrefixArgsSchema.parse(JSON.parse(row.fixedPrefixArgsJson));
  requireTrustedRecipe(providerId, row.recipeId, fixedPrefixArgs, row.entryPath);
  const expectedCredentialScope = providerId === 'codex_cli' ? 'profile_scoped' : 'provider_global';
  if (row.credentialScope !== expectedCredentialScope) {
    throw new TypeError('INVALID_PROVIDER_DIAGNOSTIC_CREDENTIAL_SCOPE');
  }
  const entryPresent = row.entryPath !== null;
  const manifestPresent = row.packageManifestPath !== null;
  const platformPresent = row.platformPackageManifestPath !== null;
  const componentMatrixIsValid =
    (providerId === 'antigravity_cli' &&
      row.signerClassification === 'google' &&
      !entryPresent &&
      !manifestPresent &&
      !platformPresent) ||
    (providerId === 'gemini_cli' &&
      row.signerClassification === 'nodejs' &&
      entryPresent &&
      manifestPresent &&
      !platformPresent) ||
    (providerId === 'codex_cli' &&
      row.signerClassification === 'openai' &&
      entryPresent === manifestPresent &&
      (!entryPresent ? !platformPresent : platformPresent));
  if (!componentMatrixIsValid) {
    throw new TypeError('INVALID_PROVIDER_DIAGNOSTIC_COMPONENT_MATRIX');
  }
  const bindingFields = Object.freeze({
    canonicalLauncherPath: row.executablePath,
    canonicalEntryPath: row.entryPath,
    canonicalPackageManifestPath: row.packageManifestPath,
    canonicalPlatformPackageManifestPath: row.platformPackageManifestPath,
    fixedPrefixArgs: Object.freeze(fixedPrefixArgs),
    version: parseSafeSemVer(row.version),
    launcherSha256: Sha256Schema.parse(row.executableSha256),
    entrySha256: row.entrySha256 === null ? null : Sha256Schema.parse(row.entrySha256),
    packageManifestSha256:
      row.packageManifestSha256 === null ? null : Sha256Schema.parse(row.packageManifestSha256),
    platformPackageManifestSha256:
      row.platformPackageManifestSha256 === null
        ? null
        : Sha256Schema.parse(row.platformPackageManifestSha256),
    bindingSha256: Sha256Schema.parse(row.bindingSha256),
    recipeId: row.recipeId,
    signerClassification: row.signerClassification,
    checkedAt: IsoDateTimeSchema.parse(row.checkedAt),
  });
  if (providerId === 'codex_cli') {
    if (row.credentialScope !== 'profile_scoped') {
      throw new TypeError('INVALID_PROVIDER_DIAGNOSTIC_CREDENTIAL_SCOPE');
    }
    return Object.freeze({
      ...bindingFields,
      providerId,
      credentialScope: row.credentialScope,
    });
  }
  if (row.credentialScope !== 'provider_global') {
    throw new TypeError('INVALID_PROVIDER_DIAGNOSTIC_CREDENTIAL_SCOPE');
  }
  if (providerId === 'gemini_cli') {
    return Object.freeze({
      ...bindingFields,
      providerId,
      credentialScope: row.credentialScope,
    });
  }
  return Object.freeze({
    ...bindingFields,
    providerId,
    credentialScope: row.credentialScope,
  });
};

const toDiagnostic = (value: unknown): ProviderDiagnostic =>
  parseDatabaseEntity(() => {
    const row = DiagnosticRowSchema.parse(value);
    const common = {
      providerId: row.providerId,
      status: row.status,
      selectedModelId: row.selectedModelId,
      reportedModelId: row.reportedModelId,
      credentialPresent: row.credentialPresent === 1,
      checkedAt: row.checkedAt === null ? null : IsoDateTimeSchema.parse(row.checkedAt),
      latencyMs: row.latencyMs,
      errorCode: row.errorCode === null ? null : ProviderErrorCodeSchema.parse(row.errorCode),
      revision: z.int().min(0).parse(row.revision),
    } as const;
    if (row.providerId.endsWith('_api')) {
      if (
        row.version !== null ||
        row.credentialScope !== 'not_applicable' ||
        row.sharedCredentialConsentAt !== null ||
        row.sharedCredentialConsentVersion !== null ||
        row.providerManagedHistory !== 0 ||
        !hasNoPrivateBindingColumns(row)
      ) {
        throw new TypeError('INVALID_PROVIDER_DIAGNOSTIC_ROW');
      }
      return Object.freeze({
        ...common,
        providerId: row.providerId,
        version: null,
        credentialScope: 'not_applicable',
        sharedCredentialConsentAt: null,
        sharedCredentialConsentVersion: null,
        cliBinding: null,
        providerManagedHistory: false,
      }) as ProviderDiagnostic;
    }
    if (row.credentialScope === 'unknown') {
      if (
        row.version !== null ||
        row.credentialPresent !== 0 ||
        row.sharedCredentialConsentAt !== null ||
        row.sharedCredentialConsentVersion !== null ||
        row.providerManagedHistory !== 0 ||
        !hasNoPrivateBindingColumns(row)
      ) {
        throw new TypeError('INVALID_PROVIDER_DIAGNOSTIC_ROW');
      }
      UnknownCliProviderStatusSchema.parse(row.status);
      return Object.freeze({
        ...common,
        providerId: row.providerId as CliProviderId,
        version: null,
        credentialScope: 'unknown',
        sharedCredentialConsentAt: null,
        sharedCredentialConsentVersion: null,
        cliBinding: null,
        providerManagedHistory: false,
      }) as ProviderDiagnostic;
    }
    const binding = requireCliBinding(row);
    if (
      (row.sharedCredentialConsentAt === null) !== (row.sharedCredentialConsentVersion === null) ||
      (row.credentialScope !== 'provider_global' && row.sharedCredentialConsentAt !== null) ||
      (row.sharedCredentialConsentVersion !== null &&
        row.sharedCredentialConsentVersion !== SHARED_CREDENTIAL_NOTICE_VERSION)
    ) {
      throw new TypeError('INVALID_PROVIDER_DIAGNOSTIC_ROW');
    }
    return Object.freeze({
      ...common,
      providerId: row.providerId as CliProviderId,
      version: parseSafeSemVer(row.version ?? ''),
      credentialScope: row.credentialScope,
      sharedCredentialConsentAt: row.sharedCredentialConsentAt,
      sharedCredentialConsentVersion: row.sharedCredentialConsentVersion,
      cliBinding: binding,
      providerManagedHistory: row.providerManagedHistory === 1,
    }) as ProviderDiagnostic;
  });

const toRow = (next: ProviderDiagnostic) => {
  const binding = next.cliBinding;
  return Object.freeze({
    providerId: next.providerId,
    status: next.status,
    version: next.version,
    selectedModelId: next.selectedModelId,
    reportedModelId: next.reportedModelId,
    credentialPresent: next.credentialPresent ? 1 : 0,
    credentialScope: next.credentialScope,
    sharedCredentialConsentAt: next.sharedCredentialConsentAt,
    sharedCredentialConsentVersion: next.sharedCredentialConsentVersion,
    providerManagedHistory: next.providerManagedHistory ? 1 : 0,
    executablePath: binding?.canonicalLauncherPath ?? null,
    entryPath: binding?.canonicalEntryPath ?? null,
    executableSha256: binding?.launcherSha256 ?? null,
    entrySha256: binding?.entrySha256 ?? null,
    packageManifestPath: binding?.canonicalPackageManifestPath ?? null,
    packageManifestSha256: binding?.packageManifestSha256 ?? null,
    platformPackageManifestPath: binding?.canonicalPlatformPackageManifestPath ?? null,
    platformPackageManifestSha256: binding?.platformPackageManifestSha256 ?? null,
    bindingSha256: binding?.bindingSha256 ?? null,
    recipeId: binding?.recipeId ?? null,
    signerClassification: binding?.signerClassification ?? null,
    fixedPrefixArgsJson: binding === null ? null : JSON.stringify(binding?.fixedPrefixArgs),
    checkedAt: next.checkedAt,
    latencyMs: next.latencyMs,
    errorCode: next.errorCode,
    revision: next.revision,
  });
};

const requireDiagnostic = (diagnostic: ProviderDiagnostic | null): ProviderDiagnostic =>
  parseDatabaseEntity(() => {
    if (diagnostic === null) {
      throw new TypeError('MISSING_PROVIDER_DIAGNOSTIC_AFTER_WRITE');
    }
    return diagnostic;
  });

export class SqliteProviderDiagnosticRepository implements ProviderDiagnosticRepository {
  readonly #getStatement: StatementSync;
  readonly #listStatement: StatementSync;
  readonly #insertStatement: StatementSync;
  readonly #updateStatement: StatementSync;

  constructor(database: SqliteDatabase) {
    this.#getStatement = database.prepare(
      `SELECT ${DIAGNOSTIC_COLUMNS} FROM provider_diagnostics WHERE provider_id = ?`,
    );
    this.#listStatement = database.prepare(
      `SELECT ${DIAGNOSTIC_COLUMNS} FROM provider_diagnostics ORDER BY provider_id`,
    );
    this.#insertStatement = database.prepare(`
      INSERT INTO provider_diagnostics (
        provider_id, status, version, selected_model_id, reported_model_id, credential_present,
        credential_scope, shared_credential_consent_at, shared_credential_consent_version,
        provider_managed_history, executable_path, entry_path, executable_sha256, entry_sha256,
        package_manifest_path, package_manifest_sha256, platform_package_manifest_path,
        platform_package_manifest_sha256, binding_sha256, recipe_id, signer_classification,
        fixed_prefix_args_json, checked_at, latency_ms, error_code, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#updateStatement = database.prepare(`
      UPDATE provider_diagnostics SET
        status = ?, version = ?, selected_model_id = ?, reported_model_id = ?,
        credential_present = ?, credential_scope = ?, shared_credential_consent_at = ?,
        shared_credential_consent_version = ?, provider_managed_history = ?, executable_path = ?,
        entry_path = ?, executable_sha256 = ?, entry_sha256 = ?, package_manifest_path = ?,
        package_manifest_sha256 = ?, platform_package_manifest_path = ?,
        platform_package_manifest_sha256 = ?, binding_sha256 = ?, recipe_id = ?,
        signer_classification = ?, fixed_prefix_args_json = ?, checked_at = ?, latency_ms = ?,
        error_code = ?, revision = ?
      WHERE provider_id = ? AND revision = ?
    `);
  }

  get(providerId: AiProviderId): ProviderDiagnostic | null {
    const parsedId = parseDatabaseEntity(() => z.enum(AI_PROVIDER_IDS).parse(providerId));
    try {
      const row = this.#getStatement.get(parsedId);
      return row === undefined ? null : toDiagnostic(row);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  list(): readonly ProviderDiagnostic[] {
    try {
      return Object.freeze(this.#listStatement.all().map(toDiagnostic));
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  upsert(next: ProviderDiagnostic, expectedRevision: number | null): ProviderDiagnostic {
    const parsed = toDiagnostic(toRow(next));
    const row = toRow(parsed);
    try {
      if (expectedRevision === null) {
        if (parsed.revision !== 0) {
          return parseDatabaseEntity(() => {
            throw new TypeError('INVALID_PROVIDER_DIAGNOSTIC_REVISION');
          });
        }
        this.#insertStatement.run(...Object.values(row));
      } else {
        assertNextRevision(parsed.revision, expectedRevision);
        assertSingleChange(
          this.#updateStatement.run(
            row.status,
            row.version,
            row.selectedModelId,
            row.reportedModelId,
            row.credentialPresent,
            row.credentialScope,
            row.sharedCredentialConsentAt,
            row.sharedCredentialConsentVersion,
            row.providerManagedHistory,
            row.executablePath,
            row.entryPath,
            row.executableSha256,
            row.entrySha256,
            row.packageManifestPath,
            row.packageManifestSha256,
            row.platformPackageManifestPath,
            row.platformPackageManifestSha256,
            row.bindingSha256,
            row.recipeId,
            row.signerClassification,
            row.fixedPrefixArgsJson,
            row.checkedAt,
            row.latencyMs,
            row.errorCode,
            row.revision,
            row.providerId,
            expectedRevision,
          ),
        );
      }
    } catch (error) {
      return translateSqliteError(error);
    }
    return requireDiagnostic(this.get(parsed.providerId));
  }
}

export const createProviderDiagnosticRepository = (
  database: SqliteDatabase,
): ProviderDiagnosticRepository => new SqliteProviderDiagnosticRepository(database);
