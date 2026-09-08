import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import type { CliProcessRunner } from '../../../core/ports/cliProcessRunner';
import type { CliProviderId } from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';
import type { CliExecutableFileAccess, CliFileHasher } from './cliExecutableInspector';
import {
  assertProviderConnectionActive,
  isCanonicalAbsoluteWindowsPath,
  isContained,
  isMissingPathError,
  runCliCleanupWithinDeadline,
  sameWindowsPath,
  secureExactPath,
} from './cliFileIntegrity';
import { runVerifiedWindowsPowerShell } from './windowsPowerShell';

export const PRIVATE_DIRECTORY_TARGET_ENVIRONMENT_KEY =
  'STUDYAPP_PRIVATE_DIRECTORY_TARGET' as const;

const WINDOWS_PRIVATE_DIRECTORY_ACL_SCRIPT = `$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('STUDYAPP_PRIVATE_DIRECTORY_TARGET', 'Process')
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing target.' }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $identity.User
if ($null -eq $currentSid) { throw 'Missing current user SID.' }
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$security = [System.Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner($currentSid)
$security.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($currentSid, $full, $inheritance, $propagation, $allow))
$security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, $full, $inheritance, $propagation, $allow))
$directory = [System.IO.DirectoryInfo]::new($target)
$directory.SetAccessControl($security)
$verified = $directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)
if (-not $verified.AreAccessRulesProtected) { throw 'Inherited ACL remains.' }
if ($verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { throw 'Owner mismatch.' }
$rules = @($verified.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'Unexpected ACL entry count.' }
$allowed = @($currentSid.Value, $systemSid.Value)
foreach ($rule in $rules) {
  if ($rule.AccessControlType -ne $allow -or $rule.FileSystemRights -ne $full -or $allowed -notcontains $rule.IdentityReference.Value) { throw 'Unexpected ACL entry.' }
}
[pscustomobject]@{ secure = $true } | ConvertTo-Json -Compress`;

export const WINDOWS_PRIVATE_DIRECTORY_ACL_ENCODED_COMMAND = Buffer.from(
  WINDOWS_PRIVATE_DIRECTORY_ACL_SCRIPT,
  'utf16le',
).toString('base64');

const providerError = (code: 'PROVIDER_RESIDUAL_DATA' | 'PROVIDER_UNSAFE_VERSION'): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);

const CLEANUP_TIMEOUT_MS = 5_000;

export interface WindowsPrivateDirectoryAcl {
  secure(canonicalTarget: string, operation: ProviderConnectionOperation): Promise<void>;
}

type WindowsPrivateDirectoryAclOptions = Readonly<{
  runner: CliProcessRunner;
  files: CliExecutableFileAccess;
  hasher: CliFileHasher;
}>;

class FixedWindowsPrivateDirectoryAcl implements WindowsPrivateDirectoryAcl {
  readonly #options: WindowsPrivateDirectoryAclOptions;

  constructor(options: WindowsPrivateDirectoryAclOptions) {
    this.#options = options;
  }

  async secure(canonicalTarget: string, operation: ProviderConnectionOperation): Promise<void> {
    try {
      assertProviderConnectionActive(operation);
      await secureExactPath(this.#options.files, canonicalTarget, operation);
      assertProviderConnectionActive(operation);
      const result = await runVerifiedWindowsPowerShell(
        this.#options,
        {
          encodedCommand: WINDOWS_PRIVATE_DIRECTORY_ACL_ENCODED_COMMAND,
          env: Object.freeze({ [PRIVATE_DIRECTORY_TARGET_ENVIRONMENT_KEY]: canonicalTarget }),
          timeoutMs: 10_000,
          stdoutLimitBytes: 1_024,
          stderrLimitBytes: 1_024,
        },
        operation,
      );
      assertProviderConnectionActive(operation);
      if (result.exitCode !== 0 || result.stdout.trim() !== '{"secure":true}') {
        throw providerError('PROVIDER_UNSAFE_VERSION');
      }
      await secureExactPath(this.#options.files, canonicalTarget, operation);
      assertProviderConnectionActive(operation);
    } catch {
      assertProviderConnectionActive(operation);
      throw providerError('PROVIDER_UNSAFE_VERSION');
    }
  }
}

export const createWindowsPrivateDirectoryAclForTest = (
  options: WindowsPrivateDirectoryAclOptions,
): WindowsPrivateDirectoryAcl => new FixedWindowsPrivateDirectoryAcl(options);

export const createWindowsPrivateDirectoryAcl = createWindowsPrivateDirectoryAclForTest;

export interface CliPrivateDirectoryOperations {
  mkdir(path: string, options: Readonly<{ recursive: true; mode: number }>): Promise<void>;
  remove(path: string, options: Readonly<{ recursive: true; force: false }>): Promise<void>;
}

export const createNodePrivateDirectoryOperations = (): CliPrivateDirectoryOperations =>
  Object.freeze({
    mkdir: (path: string, options: Readonly<{ recursive: true; mode: number }>): Promise<void> =>
      mkdir(path, options).then(() => undefined),
    remove: (path: string, options: Readonly<{ recursive: true; force: false }>): Promise<void> =>
      rm(path, options),
  });

export interface CliPrivateDirectoryManager {
  prepareProfile(
    providerId: CliProviderId | string,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  prepareRequest(
    providerId: CliProviderId | string,
    requestId: string,
    cwd: string,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  cleanupRequest(requestId: string, cwd: string): Promise<void>;
}

type CliPrivateDirectoryManagerOptions = Readonly<{
  userDataRoot: string;
  providerRuntimeRoot: string;
  providerProfilesRoot: string;
  providerTempRoot: string;
  providerWorkspaceRoot: string;
  directories: CliPrivateDirectoryOperations;
  files: CliExecutableFileAccess;
  acl: WindowsPrivateDirectoryAcl;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class FixedCliPrivateDirectoryManager implements CliPrivateDirectoryManager {
  readonly #options: CliPrivateDirectoryManagerOptions;

  constructor(options: CliPrivateDirectoryManagerOptions) {
    if (
      ![
        options.userDataRoot,
        options.providerRuntimeRoot,
        options.providerProfilesRoot,
        options.providerTempRoot,
        options.providerWorkspaceRoot,
      ].every(isCanonicalAbsoluteWindowsPath) ||
      !isContained(options.userDataRoot, options.providerRuntimeRoot) ||
      !sameWindowsPath(
        options.providerProfilesRoot,
        win32.join(options.providerRuntimeRoot, 'profiles'),
      ) ||
      !sameWindowsPath(options.providerTempRoot, win32.join(options.providerRuntimeRoot, 'temp')) ||
      !sameWindowsPath(
        options.providerWorkspaceRoot,
        win32.join(options.providerRuntimeRoot, 'workspace'),
      )
    ) {
      throw providerError('PROVIDER_UNSAFE_VERSION');
    }
    this.#options = options;
  }

  async prepareProfile(
    providerId: CliProviderId | string,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    assertProviderConnectionActive(operation);
    this.#assertProviderId(providerId);
    await this.#preparePaths(this.#profilePaths(providerId), operation);
  }

  async prepareRequest(
    providerId: CliProviderId | string,
    requestId: string,
    cwd: string,
    operation: ProviderConnectionOperation,
  ) {
    assertProviderConnectionActive(operation);
    if (operation.requestId !== requestId) {
      throw providerError('PROVIDER_UNSAFE_VERSION');
    }
    this.#assertProviderId(providerId);
    this.#assertRequestDirectory(requestId, cwd);
    const requestTempRoot = win32.join(this.#options.providerTempRoot, requestId);
    const paths = Object.freeze([...this.#profilePaths(providerId), cwd, requestTempRoot]);
    await this.#preparePaths(paths, operation);
  }

  async #preparePaths(
    paths: readonly string[],
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    try {
      await this.#assertCanonicalUserDataRoot(operation);
      assertProviderConnectionActive(operation);
      for (const path of paths) {
        await this.#assertSafeExistingAncestors(path, operation);
        assertProviderConnectionActive(operation);
        await this.#options.directories.mkdir(path, { recursive: true, mode: 0o700 });
        assertProviderConnectionActive(operation);
        await this.#assertCanonicalManagedPath(path, operation);
        assertProviderConnectionActive(operation);
        await this.#options.acl.secure(path, operation);
        assertProviderConnectionActive(operation);
        await this.#assertCanonicalManagedPath(path, operation);
        assertProviderConnectionActive(operation);
      }
    } catch (error) {
      assertProviderConnectionActive(operation);
      if (AppError.isTrusted(error)) throw error;
      throw providerError('PROVIDER_UNSAFE_VERSION');
    }
  }

  #profilePaths(providerId: CliProviderId | string): readonly string[] {
    const profileRoot = win32.join(this.#options.providerProfilesRoot, providerId);
    const userRoot = win32.join(profileRoot, 'user');
    return Object.freeze([
      this.#options.providerRuntimeRoot,
      this.#options.providerProfilesRoot,
      this.#options.providerTempRoot,
      this.#options.providerWorkspaceRoot,
      profileRoot,
      userRoot,
      win32.join(userRoot, 'AppData'),
      win32.join(userRoot, 'AppData', 'Roaming'),
      win32.join(userRoot, 'AppData', 'Local'),
      win32.join(profileRoot, 'settings'),
    ]);
  }

  #assertProviderId(providerId: CliProviderId | string): void {
    if (!['antigravity_cli', 'gemini_cli', 'codex_cli'].includes(providerId)) {
      throw providerError('PROVIDER_UNSAFE_VERSION');
    }
  }

  async cleanupRequest(requestId: string, cwd: string): Promise<void> {
    const operation = Object.freeze({
      requestId: randomUUID(),
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    });
    try {
      await runCliCleanupWithinDeadline(operation, () =>
        this.#cleanupRequest(requestId, cwd, operation),
      );
    } catch {
      throw providerError('PROVIDER_RESIDUAL_DATA');
    }
  }

  async #cleanupRequest(
    requestId: string,
    cwd: string,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    try {
      this.#assertRequestDirectory(requestId, cwd);
      await this.#assertCanonicalUserDataRoot(operation);
      const workspace = win32.join(this.#options.providerWorkspaceRoot, requestId);
      const temp = win32.join(this.#options.providerTempRoot, requestId);
      const paths = Object.freeze([workspace, temp]);
      const existing = await Promise.allSettled(
        paths.map((path) => this.#requestDirectoryExists(path, operation)),
      );
      assertProviderConnectionActive(operation);
      if (existing.some((result) => result.status === 'rejected')) {
        throw providerError('PROVIDER_RESIDUAL_DATA');
      }
      const removals = await Promise.allSettled(
        paths.map(async (path, index) => {
          const state = existing[index];
          if (state?.status !== 'fulfilled' || !state.value) return;
          try {
            await this.#options.directories.remove(path, { recursive: true, force: false });
          } catch (error) {
            if (!isMissingPathError(error)) throw error;
          }
        }),
      );
      assertProviderConnectionActive(operation);
      const absence = await Promise.allSettled(
        paths.map((path) => this.#assertRequestDirectoryAbsent(path, operation)),
      );
      assertProviderConnectionActive(operation);
      if (
        removals.some((result) => result.status === 'rejected') ||
        absence.some((result) => result.status === 'rejected')
      ) {
        throw providerError('PROVIDER_RESIDUAL_DATA');
      }
    } catch {
      throw providerError('PROVIDER_RESIDUAL_DATA');
    }
  }

  async #requestDirectoryExists(
    path: string,
    operation: ProviderConnectionOperation,
  ): Promise<boolean> {
    assertProviderConnectionActive(operation);
    try {
      await this.#assertCanonicalManagedPath(path, operation);
      assertProviderConnectionActive(operation);
      return true;
    } catch (error) {
      assertProviderConnectionActive(operation);
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }

  async #assertRequestDirectoryAbsent(
    path: string,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    if (await this.#requestDirectoryExists(path, operation)) {
      throw providerError('PROVIDER_RESIDUAL_DATA');
    }
  }

  #assertRequestDirectory(requestId: string, cwd: string): void {
    const workspace = win32.join(this.#options.providerWorkspaceRoot, requestId);
    if (
      !UUID_PATTERN.test(requestId) ||
      win32.normalize(cwd) !== cwd ||
      !sameWindowsPath(cwd, workspace)
    ) {
      throw providerError('PROVIDER_RESIDUAL_DATA');
    }
  }

  async #assertCanonicalManagedPath(
    path: string,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    if (!isContained(this.#options.userDataRoot, path)) {
      throw providerError('PROVIDER_UNSAFE_VERSION');
    }
    await this.#options.files.assertNoReparsePoints(path, operation);
    assertProviderConnectionActive(operation);
    const canonical = await this.#options.files.canonicalize(path, operation);
    assertProviderConnectionActive(operation);
    if (!sameWindowsPath(canonical, path) || !isContained(this.#options.userDataRoot, canonical)) {
      throw providerError('PROVIDER_UNSAFE_VERSION');
    }
    await this.#options.files.assertNoReparsePoints(canonical, operation);
    assertProviderConnectionActive(operation);
  }

  async #assertSafeExistingAncestors(
    path: string,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    if (!isCanonicalAbsoluteWindowsPath(path) || !isContained(this.#options.userDataRoot, path)) {
      throw providerError('PROVIDER_UNSAFE_VERSION');
    }
    await this.#assertCanonicalUserDataRoot(operation);
    assertProviderConnectionActive(operation);
    const segments = win32.relative(this.#options.userDataRoot, path).split('\\');
    let current = this.#options.userDataRoot;
    for (const segment of segments) {
      current = win32.join(current, segment);
      try {
        await this.#options.files.assertNoReparsePoints(current, operation);
        assertProviderConnectionActive(operation);
        const canonical = await this.#options.files.canonicalize(current, operation);
        assertProviderConnectionActive(operation);
        if (
          !sameWindowsPath(canonical, current) ||
          !isContained(this.#options.userDataRoot, canonical)
        ) {
          throw providerError('PROVIDER_UNSAFE_VERSION');
        }
        await this.#options.files.assertNoReparsePoints(canonical, operation);
        assertProviderConnectionActive(operation);
      } catch (error) {
        if (error instanceof AppError && error.code === 'PROVIDER_CANCELLED') throw error;
        if (isMissingPathError(error)) return;
        if (AppError.isTrusted(error)) throw error;
        throw providerError('PROVIDER_UNSAFE_VERSION');
      }
    }
  }

  async #assertCanonicalUserDataRoot(operation: ProviderConnectionOperation): Promise<void> {
    assertProviderConnectionActive(operation);
    await this.#options.files.assertNoReparsePoints(this.#options.userDataRoot, operation);
    assertProviderConnectionActive(operation);
    const canonical = await this.#options.files.canonicalize(this.#options.userDataRoot, operation);
    assertProviderConnectionActive(operation);
    if (!sameWindowsPath(canonical, this.#options.userDataRoot)) {
      throw providerError('PROVIDER_UNSAFE_VERSION');
    }
    await this.#options.files.assertNoReparsePoints(canonical, operation);
    assertProviderConnectionActive(operation);
  }
}

export const createCliPrivateDirectoryManagerForTest = (
  options: CliPrivateDirectoryManagerOptions,
): CliPrivateDirectoryManager => new FixedCliPrivateDirectoryManager(options);

export const createCliPrivateDirectoryManager = createCliPrivateDirectoryManagerForTest;
