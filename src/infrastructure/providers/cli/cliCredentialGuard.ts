import { readdir } from 'node:fs/promises';
import { win32 } from 'node:path';
import type {
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../core/ports/aiProvider';
import type { CliProviderId } from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';
import type { CliExecutableFileAccess } from './cliFileIntegrity';
import {
  assertProviderConnectionActive,
  isCanonicalAbsoluteWindowsPath,
  sameWindowsPath,
} from './cliFileIntegrity';

export const CLI_CREDENTIAL_SCOPE_BY_RECIPE = Object.freeze({
  'antigravity-1.1-stream-json-v1': 'provider_global',
  'gemini-0.55-policy-json-v1': 'provider_global',
  'codex-0.146-profile-keyring-v2': 'profile_scoped',
} as const);

const RECIPE_PROVIDER_BY_ID = Object.freeze({
  'antigravity-1.1-stream-json-v1': 'antigravity_cli',
  'gemini-0.55-policy-json-v1': 'gemini_cli',
  'codex-0.146-profile-keyring-v2': 'codex_cli',
} as const satisfies Readonly<Record<keyof typeof CLI_CREDENTIAL_SCOPE_BY_RECIPE, CliProviderId>>);

const PLAINTEXT_CREDENTIAL_FILE =
  /^(?:gemini-credentials|oauth_creds|auth|credentials|refresh_token|tokens?|session_token|refresh-token)\.(?:json|jsonl|db|sqlite|txt)$/iu;
const SESSION_ARTIFACT_FILE = /^(?:session|history)(?:$|[-_.].*)/iu;
const MAX_PROFILE_FILE_NAMES = 4_096;
const MAX_RELATIVE_FILE_NAME_LENGTH = 1_024;

const unsafeVersion = (): AppError =>
  new AppError('PROVIDER_UNSAFE_VERSION', APP_ERROR_MESSAGES.PROVIDER_UNSAFE_VERSION);
const residualData = (): AppError =>
  new AppError('PROVIDER_RESIDUAL_DATA', APP_ERROR_MESSAGES.PROVIDER_RESIDUAL_DATA);

export interface CredentialProfileScanner {
  listRelativeFileNames(
    aliasedManagedProfileRoot: string,
    operation: ProviderConnectionOperation,
  ): Promise<readonly string[]>;
}

export type CredentialProfileDirectoryEntry = Readonly<{
  name: string;
  kind: 'file' | 'directory' | 'other';
}>;

export interface CredentialProfileDirectoryReader {
  list(
    path: string,
    operation: ProviderConnectionOperation,
  ): Promise<readonly CredentialProfileDirectoryEntry[]>;
}

type CredentialProfileScannerOptions = Readonly<{
  directories: CredentialProfileDirectoryReader;
  files: CliExecutableFileAccess;
}>;

class BoundedCredentialProfileScanner implements CredentialProfileScanner {
  readonly #directories: CredentialProfileDirectoryReader;
  readonly #files: CliExecutableFileAccess;

  constructor(options: CredentialProfileScannerOptions) {
    this.#directories = options.directories;
    this.#files = options.files;
  }

  async listRelativeFileNames(
    root: string,
    operation: ProviderConnectionOperation,
  ): Promise<readonly string[]> {
    assertProviderConnectionActive(operation);
    if (!/^[R-W]:\\profiles\\(?:antigravity_cli|gemini_cli|codex_cli)$/iu.test(root)) {
      throw unsafeVersion();
    }
    const files: string[] = [];
    const pending: Array<Readonly<{ fullPath: string; relativePath: string; depth: number }>> = [
      Object.freeze({ fullPath: root, relativePath: '', depth: 0 }),
    ];
    while (pending.length > 0) {
      const current = pending.shift();
      if (current === undefined || current.depth > 16) throw unsafeVersion();
      await this.#files.assertNoReparsePoints(current.fullPath, operation);
      assertProviderConnectionActive(operation);
      const entries = await this.#directories.list(current.fullPath, operation);
      assertProviderConnectionActive(operation);
      if (entries.length + files.length + pending.length > MAX_PROFILE_FILE_NAMES) {
        throw unsafeVersion();
      }
      for (const entry of entries) {
        if (
          entry.name.length === 0 ||
          entry.name.length > 255 ||
          entry.name === '.' ||
          entry.name === '..' ||
          /[\\/\p{Cc}\p{Cf}]/u.test(entry.name) ||
          (entry.kind !== 'file' && entry.kind !== 'directory')
        ) {
          throw unsafeVersion();
        }
        const fullPath = win32.join(current.fullPath, entry.name);
        const relativePath =
          current.relativePath.length === 0
            ? entry.name
            : win32.join(current.relativePath, entry.name);
        await this.#files.assertNoReparsePoints(fullPath, operation);
        assertProviderConnectionActive(operation);
        if (entry.kind === 'file') files.push(relativePath);
        else pending.push(Object.freeze({ fullPath, relativePath, depth: current.depth + 1 }));
      }
      await this.#files.assertNoReparsePoints(current.fullPath, operation);
      assertProviderConnectionActive(operation);
    }
    return Object.freeze(files);
  }
}

export const createCredentialProfileScannerForTest = (
  options: CredentialProfileScannerOptions,
): CredentialProfileScanner => new BoundedCredentialProfileScanner(options);

export const createNodeCredentialProfileScanner = (
  files: CliExecutableFileAccess,
): CredentialProfileScanner =>
  createCredentialProfileScannerForTest({
    files,
    directories: Object.freeze({
      list: async (path: string, operation: ProviderConnectionOperation) => {
        assertProviderConnectionActive(operation);
        const entries = await readdir(path, { withFileTypes: true });
        assertProviderConnectionActive(operation);
        return Object.freeze(
          entries.map((entry) =>
            Object.freeze({
              name: entry.name,
              kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
            }),
          ),
        );
      },
    }),
  });

export type CliCredentialStatusEvidence = Readonly<{
  backend:
    | 'windows_credential_manager'
    | 'os_account_bound_encrypted'
    | 'plaintext_file'
    | 'unknown';
  status: 'present' | 'absent' | 'unknown';
  resolvedProfilePath: string | null;
}>;

export type CliCredentialInspection = Readonly<{
  backend: 'windows_credential_manager' | 'os_account_bound_encrypted';
  scope: (typeof CLI_CREDENTIAL_SCOPE_BY_RECIPE)[keyof typeof CLI_CREDENTIAL_SCOPE_BY_RECIPE];
  status: 'present' | 'absent';
  observedFileNames: readonly string[];
  providerManagedHistory: boolean;
}>;

export type InspectCliCredentialRequest = Readonly<{
  binding: CliRuntimeBinding;
  managedProfilePath: string;
  evidence: CliCredentialStatusEvidence;
}>;

export interface CliCredentialGuard {
  inspect(
    request: InspectCliCredentialRequest,
    operation: ProviderConnectionOperation,
  ): Promise<CliCredentialInspection>;
}

type CliCredentialGuardOptions = Readonly<{
  scanner: CredentialProfileScanner;
}>;

const readExactEvidence = (value: CliCredentialStatusEvidence): CliCredentialStatusEvidence => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unsafeVersion();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    keys.some((key) => typeof key !== 'string') ||
    !keys.includes('backend') ||
    !keys.includes('status') ||
    !keys.includes('resolvedProfilePath')
  ) {
    throw unsafeVersion();
  }
  const copied: Record<string, unknown> = {};
  for (const key of ['backend', 'status', 'resolvedProfilePath'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw unsafeVersion();
    }
    copied[key] = descriptor.value;
  }
  if (
    ![
      'windows_credential_manager',
      'os_account_bound_encrypted',
      'plaintext_file',
      'unknown',
    ].includes(copied.backend as string) ||
    !['present', 'absent', 'unknown'].includes(copied.status as string) ||
    (copied.resolvedProfilePath !== null && typeof copied.resolvedProfilePath !== 'string')
  ) {
    throw unsafeVersion();
  }
  return Object.freeze({
    backend: copied.backend as CliCredentialStatusEvidence['backend'],
    status: copied.status as CliCredentialStatusEvidence['status'],
    resolvedProfilePath: copied.resolvedProfilePath as string | null,
  });
};

const copySafeFileNames = (values: readonly string[]): readonly string[] => {
  if (!Array.isArray(values) || values.length > MAX_PROFILE_FILE_NAMES) throw unsafeVersion();
  const copied = values.map((value) => {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_RELATIVE_FILE_NAME_LENGTH ||
      /[\p{Cc}\p{Cf}]/u.test(value) ||
      win32.isAbsolute(value) ||
      value.includes(':') ||
      value.split(/[\\/]/u).includes('..')
    ) {
      throw unsafeVersion();
    }
    return value;
  });
  return Object.freeze(copied);
};

const isExactAliasedProviderProfile = (path: string, providerId: CliProviderId): boolean => {
  if (!isCanonicalAbsoluteWindowsPath(path)) return false;
  const driveRoot = win32.parse(path).root;
  if (!/^[R-W]:\\$/iu.test(driveRoot)) return false;
  return sameWindowsPath(path, win32.join(driveRoot, 'profiles', providerId));
};

class FixedCliCredentialGuard implements CliCredentialGuard {
  readonly #scanner: CredentialProfileScanner;

  constructor(options: CliCredentialGuardOptions) {
    this.#scanner = options.scanner;
  }

  async inspect(
    request: InspectCliCredentialRequest,
    operation: ProviderConnectionOperation,
  ): Promise<CliCredentialInspection> {
    assertProviderConnectionActive(operation);
    const scope =
      CLI_CREDENTIAL_SCOPE_BY_RECIPE[
        request.binding.recipeId as keyof typeof CLI_CREDENTIAL_SCOPE_BY_RECIPE
      ];
    const expectedProvider =
      RECIPE_PROVIDER_BY_ID[request.binding.recipeId as keyof typeof RECIPE_PROVIDER_BY_ID];
    if (
      scope === undefined ||
      expectedProvider !== request.binding.providerId ||
      request.binding.credentialScope !== scope ||
      !isExactAliasedProviderProfile(request.managedProfilePath, request.binding.providerId)
    ) {
      throw unsafeVersion();
    }
    const evidence = readExactEvidence(request.evidence);
    if (
      (evidence.backend !== 'windows_credential_manager' &&
        evidence.backend !== 'os_account_bound_encrypted') ||
      (evidence.status !== 'present' && evidence.status !== 'absent')
    ) {
      throw unsafeVersion();
    }
    if (
      request.binding.providerId === 'antigravity_cli'
        ? evidence.resolvedProfilePath === null ||
          !sameWindowsPath(evidence.resolvedProfilePath, request.managedProfilePath)
        : evidence.resolvedProfilePath !== null
    ) {
      throw unsafeVersion();
    }

    const observedFileNames = copySafeFileNames(
      await this.#scanner.listRelativeFileNames(request.managedProfilePath, operation),
    );
    assertProviderConnectionActive(operation);
    for (const relativeName of observedFileNames) {
      const baseName = win32.basename(relativeName);
      if (PLAINTEXT_CREDENTIAL_FILE.test(baseName)) throw unsafeVersion();
      if (SESSION_ARTIFACT_FILE.test(baseName)) throw residualData();
    }
    return Object.freeze({
      backend: evidence.backend,
      scope,
      status: evidence.status,
      observedFileNames,
      providerManagedHistory: request.binding.providerId === 'antigravity_cli',
    });
  }
}

export const createCliCredentialGuardForTest = (
  options: CliCredentialGuardOptions,
): CliCredentialGuard => new FixedCliCredentialGuard(options);

export const createCliCredentialGuard = createCliCredentialGuardForTest;
