import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import type {
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../core/ports/aiProvider';
import type { CliProviderId } from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';
import {
  assertProviderConnectionActive,
  type CliExecutableFileAccess,
  isCanonicalAbsoluteWindowsPath,
  runCliCleanupWithinDeadline,
  SHA_256_PATTERN,
  sameWindowsPath,
  unsafeVersion,
} from './cliFileIntegrity';
import { isIssuedWindowsKnownFolders, type WindowsKnownFolders } from './windowsKnownFolders';
import { WINDOWS_ALIAS_DRIVES, type WindowsSubstMappingPort } from './windowsSubstMapping';

export {
  createWindowsSubstMappingPort,
  createWindowsSubstMappingPortForTest,
  createWindowsToolIdentityGuard,
  createWindowsToolIdentityGuardForTest,
  WINDOWS_ALIAS_DRIVES,
  WINDOWS_SUBST_PATH,
  type WindowsSubstMappingPort,
  type WindowsToolIdentityGuard,
} from './windowsSubstMapping';

const residualData = (): AppError =>
  new AppError('PROVIDER_RESIDUAL_DATA', APP_ERROR_MESSAGES.PROVIDER_RESIDUAL_DATA);
const cliChanged = (): AppError =>
  new AppError('PROVIDER_CLI_CHANGED', APP_ERROR_MESSAGES.PROVIDER_CLI_CHANGED);
const assertAliasDrive = (drive: string): void => {
  if (!WINDOWS_ALIAS_DRIVES.includes(drive as (typeof WINDOWS_ALIAS_DRIVES)[number])) {
    throw residualData();
  }
};
const createCleanupOperation = (): ProviderConnectionOperation =>
  Object.freeze({ requestId: randomUUID(), signal: AbortSignal.timeout(5_000) });

const sameNullablePath = (left: string | null, right: string | null): boolean =>
  left === null || right === null ? left === right : sameWindowsPath(left, right);

export const sameCliRuntimeBindingIdentity = (
  left: CliRuntimeBinding,
  right: CliRuntimeBinding,
): boolean =>
  left.providerId === right.providerId &&
  sameWindowsPath(left.canonicalLauncherPath, right.canonicalLauncherPath) &&
  sameNullablePath(left.canonicalEntryPath, right.canonicalEntryPath) &&
  sameNullablePath(left.canonicalPackageManifestPath, right.canonicalPackageManifestPath) &&
  sameNullablePath(
    left.canonicalPlatformPackageManifestPath,
    right.canonicalPlatformPackageManifestPath,
  ) &&
  left.fixedPrefixArgs.length === right.fixedPrefixArgs.length &&
  left.fixedPrefixArgs.every((argument, index) => argument === right.fixedPrefixArgs[index]) &&
  left.version === right.version &&
  left.launcherSha256 === right.launcherSha256 &&
  left.entrySha256 === right.entrySha256 &&
  left.packageManifestSha256 === right.packageManifestSha256 &&
  left.platformPackageManifestSha256 === right.platformPackageManifestSha256 &&
  left.bindingSha256 === right.bindingSha256 &&
  left.recipeId === right.recipeId &&
  left.credentialScope === right.credentialScope &&
  left.signerClassification === right.signerClassification;

export interface CliBindingRevalidator {
  revalidate(
    binding: CliRuntimeBinding,
    operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding>;
}

export type WindowsAliasMarker = Readonly<{
  kind: 'runtime' | 'install';
  drive: string;
  target: string;
  bindingSha256: string | null;
}>;

export interface WindowsAliasMarkerStore {
  readonly root: string;
  list(operation: ProviderConnectionOperation): Promise<readonly WindowsAliasMarker[]>;
  write(marker: WindowsAliasMarker, operation: ProviderConnectionOperation): Promise<void>;
  remove(drive: string, operation: ProviderConnectionOperation): Promise<void>;
}

type WindowsAliasMarkerStoreOptions = Readonly<{
  providerRuntimeRoot: string;
  files: CliExecutableFileAccess;
}>;

const parseMarker = (text: string, expectedDrive: string): WindowsAliasMarker => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw residualData();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw residualData();
  }
  const object = parsed as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (
    keys.join(',') !== 'bindingSha256,drive,kind,target' ||
    object.drive !== expectedDrive ||
    (object.kind !== 'runtime' && object.kind !== 'install') ||
    typeof object.target !== 'string' ||
    !isCanonicalAbsoluteWindowsPath(object.target) ||
    (object.bindingSha256 !== null &&
      (typeof object.bindingSha256 !== 'string' || !SHA_256_PATTERN.test(object.bindingSha256))) ||
    (object.kind === 'runtime') !== (object.bindingSha256 === null)
  ) {
    throw residualData();
  }
  return Object.freeze({
    kind: object.kind,
    drive: expectedDrive,
    target: object.target,
    bindingSha256: object.bindingSha256,
  });
};

class FileWindowsAliasMarkerStore implements WindowsAliasMarkerStore {
  readonly root: string;
  readonly #runtimeRoot: string;
  readonly #files: CliExecutableFileAccess;

  constructor(options: WindowsAliasMarkerStoreOptions) {
    if (!isCanonicalAbsoluteWindowsPath(options.providerRuntimeRoot)) throw residualData();
    this.#runtimeRoot = options.providerRuntimeRoot;
    this.root = win32.join(options.providerRuntimeRoot, 'alias-markers');
    this.#files = options.files;
  }

  async list(operation: ProviderConnectionOperation): Promise<readonly WindowsAliasMarker[]> {
    try {
      assertProviderConnectionActive(operation);
      await this.#secureRoot(operation);
      assertProviderConnectionActive(operation);
      const entries = await readdir(this.root, { withFileTypes: true });
      assertProviderConnectionActive(operation);
      if (entries.length > WINDOWS_ALIAS_DRIVES.length) throw residualData();
      const markers: WindowsAliasMarker[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const match = /^([R-W])\.json$/u.exec(entry.name);
        if (match === null || !entry.isFile() || match[1] === undefined) throw residualData();
        const drive = `${match[1]}:`;
        const path = win32.join(this.root, entry.name);
        await this.#files.assertNoReparsePoints(path, operation);
        assertProviderConnectionActive(operation);
        markers.push(parseMarker(await this.#readBounded(path, operation), drive));
        assertProviderConnectionActive(operation);
      }
      await this.#files.assertNoReparsePoints(this.root, operation);
      assertProviderConnectionActive(operation);
      return Object.freeze(markers);
    } catch (error) {
      if (AppError.isTrusted(error)) throw error;
      throw residualData();
    }
  }

  async write(marker: WindowsAliasMarker, operation: ProviderConnectionOperation): Promise<void> {
    try {
      assertProviderConnectionActive(operation);
      assertAliasDrive(marker.drive);
      const validated = parseMarker(JSON.stringify(marker), marker.drive);
      await this.#secureRoot(operation);
      assertProviderConnectionActive(operation);
      const finalPath = this.#markerPath(marker.drive);
      const temporaryPath = win32.join(this.root, `${marker.drive[0]}.${randomUUID()}.tmp`);
      const bytes = JSON.stringify(validated);
      try {
        await writeFile(temporaryPath, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        assertProviderConnectionActive(operation);
        await this.#files.assertNoReparsePoints(temporaryPath, operation);
        assertProviderConnectionActive(operation);
        await rename(temporaryPath, finalPath);
        assertProviderConnectionActive(operation);
        await this.#files.assertNoReparsePoints(finalPath, operation);
        assertProviderConnectionActive(operation);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (AppError.isTrusted(error)) throw error;
      throw residualData();
    }
  }

  async remove(drive: string, operation: ProviderConnectionOperation): Promise<void> {
    try {
      assertProviderConnectionActive(operation);
      assertAliasDrive(drive);
      await this.#secureRoot(operation);
      assertProviderConnectionActive(operation);
      await unlink(this.#markerPath(drive));
      assertProviderConnectionActive(operation);
      await this.#files.assertNoReparsePoints(this.root, operation);
      assertProviderConnectionActive(operation);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === 'ENOENT'
      ) {
        return;
      }
      if (AppError.isTrusted(error)) throw error;
      throw residualData();
    }
  }

  #markerPath(drive: string): string {
    return win32.join(this.root, `${drive[0]}.json`);
  }

  async #secureRoot(operation: ProviderConnectionOperation): Promise<void> {
    assertProviderConnectionActive(operation);
    await this.#files.assertNoReparsePoints(this.#runtimeRoot, operation);
    assertProviderConnectionActive(operation);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    assertProviderConnectionActive(operation);
    await this.#files.assertNoReparsePoints(this.root, operation);
    assertProviderConnectionActive(operation);
    const canonical = await this.#files.canonicalize(this.root, operation);
    assertProviderConnectionActive(operation);
    if (!sameWindowsPath(canonical, this.root)) throw residualData();
    await this.#files.assertNoReparsePoints(canonical, operation);
    assertProviderConnectionActive(operation);
  }

  async #readBounded(path: string, operation: ProviderConnectionOperation): Promise<string> {
    assertProviderConnectionActive(operation);
    const handle = await open(path, 'r');
    assertProviderConnectionActive(operation);
    try {
      const before = await handle.stat();
      assertProviderConnectionActive(operation);
      if (!before.isFile() || before.size <= 0 || before.size > 4_096) throw residualData();
      const buffer = Buffer.alloc(before.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      assertProviderConnectionActive(operation);
      const after = await handle.stat();
      assertProviderConnectionActive(operation);
      if (bytesRead !== before.size || after.size !== before.size) throw residualData();
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } finally {
      await handle.close();
    }
  }
}

export const createWindowsAliasMarkerStoreForTest = (
  options: WindowsAliasMarkerStoreOptions,
): WindowsAliasMarkerStore => new FileWindowsAliasMarkerStore(options);

export const createWindowsAliasMarkerStore = createWindowsAliasMarkerStoreForTest;

export type WindowsWorkspaceAliasLease = Readonly<{
  providerId: CliProviderId;
  runtimeRoot: string;
  profileRoot: string;
  workspaceRoot: string;
  tempRoot: string;
  launcherPath: string;
  fixedPrefixArgs: readonly string[];
  rewritePath(path: string): string;
  assertNoCanonicalPathDisclosure(value: string): void;
  revalidate(operation: ProviderConnectionOperation): Promise<void>;
  release(): Promise<void>;
}>;

export interface WindowsWorkspaceAlias {
  acquire(
    binding: CliRuntimeBinding,
    operation: ProviderConnectionOperation,
  ): Promise<WindowsWorkspaceAliasLease>;
  cleanupStale(binding: CliRuntimeBinding, operation: ProviderConnectionOperation): Promise<void>;
}

type WindowsWorkspaceAliasOptions = Readonly<{
  knownFolders: WindowsKnownFolders;
  providerRuntimeRoot: string;
  mappings: WindowsSubstMappingPort;
  markers: WindowsAliasMarkerStore;
  inspector: CliBindingRevalidator;
}>;

type ActiveMapping = {
  readonly drive: string;
  readonly target: string;
  readonly kind: 'runtime' | 'install';
  readonly bindingSha256: string | null;
  readonly references: number;
};

const containedOrEqual = (root: string, path: string): boolean => {
  if (sameWindowsPath(root, path)) return true;
  const relative = win32.relative(root, path);
  return relative.length > 0 && !relative.startsWith('..') && !win32.isAbsolute(relative);
};

const normalizeEmbeddedWindowsPathSeparators = (value: string): string =>
  value.replaceAll('/', '\\').replace(/\\+/gu, '\\').toLowerCase();

const containsRootedPath = (value: string, root: string): boolean => {
  const candidate = normalizeEmbeddedWindowsPathSeparators(value);
  const expectedRoot = normalizeEmbeddedWindowsPathSeparators(root).replace(/\\+$/u, '');
  let offset = 0;
  while (offset <= candidate.length - expectedRoot.length) {
    const index = candidate.indexOf(expectedRoot, offset);
    if (index < 0) return false;
    const suffix = candidate[index + expectedRoot.length];
    if (suffix === undefined || suffix === '\\') return true;
    offset = index + 1;
  }
  return false;
};

const commonDirectory = (paths: readonly string[]): string | null => {
  const directories = paths.map((path) => win32.dirname(path));
  const first = directories[0];
  if (first === undefined) return null;
  let common = first;
  for (const directory of directories.slice(1)) {
    while (!containedOrEqual(common, directory)) {
      const parent = win32.dirname(common);
      if (sameWindowsPath(parent, common)) return null;
      common = parent;
    }
  }
  return common;
};

class ReferenceCountedWindowsWorkspaceAlias implements WindowsWorkspaceAlias {
  readonly #userProfile: string;
  readonly #runtimeRoot: string;
  readonly #mappings: WindowsSubstMappingPort;
  readonly #markers: WindowsAliasMarkerStore;
  readonly #inspector: CliBindingRevalidator;
  readonly #activeByTarget = new Map<string, ActiveMapping>();
  #queue: Promise<void> = Promise.resolve();
  #poisoned = false;

  constructor(options: WindowsWorkspaceAliasOptions) {
    const userProfile = win32.dirname(win32.dirname(options.knownFolders.appData));
    const expectedMarkerRoot = win32.join(options.providerRuntimeRoot, 'alias-markers');
    if (
      !isIssuedWindowsKnownFolders(options.knownFolders) ||
      !isCanonicalAbsoluteWindowsPath(userProfile) ||
      !isCanonicalAbsoluteWindowsPath(options.providerRuntimeRoot) ||
      !containedOrEqual(options.knownFolders.localAppData, options.providerRuntimeRoot) ||
      !sameWindowsPath(options.markers.root, expectedMarkerRoot)
    ) {
      throw unsafeVersion();
    }
    this.#userProfile = userProfile;
    this.#runtimeRoot = options.providerRuntimeRoot;
    this.#mappings = options.mappings;
    this.#markers = options.markers;
    this.#inspector = options.inspector;
  }

  async acquire(
    binding: CliRuntimeBinding,
    operation: ProviderConnectionOperation,
  ): Promise<WindowsWorkspaceAliasLease> {
    assertProviderConnectionActive(operation);
    return this.#serialize(() => this.#acquire(binding, operation));
  }

  async #acquire(
    binding: CliRuntimeBinding,
    operation: ProviderConnectionOperation,
  ): Promise<WindowsWorkspaceAliasLease> {
    assertProviderConnectionActive(operation);
    if (this.#poisoned) throw residualData();
    const runtime = await this.#acquireTarget('runtime', this.#runtimeRoot, null, operation);
    assertProviderConnectionActive(operation);
    let install: ActiveMapping | null = null;
    try {
      const installRoot = this.#installRoot(binding);
      if (installRoot !== null) {
        install = await this.#acquireTarget(
          'install',
          installRoot,
          binding.bindingSha256,
          operation,
        );
        assertProviderConnectionActive(operation);
      }
      const rewritePath = (path: string): string => this.#rewriteWith(path, runtime, install);
      const privateRoots = Object.freeze([
        win32.dirname(this.#userProfile),
        this.#userProfile,
        win32.dirname(this.#runtimeRoot),
        this.#runtimeRoot,
        ...(install === null ? [] : [install.target]),
      ]);
      const assertNoCanonicalPathDisclosure = (value: string): void => {
        if (
          typeof value !== 'string' ||
          privateRoots.some((root) => containsRootedPath(value, root))
        ) {
          throw unsafeVersion();
        }
      };
      const launcherPath = rewritePath(binding.canonicalLauncherPath);
      const fixedPrefixArgs = Object.freeze(binding.fixedPrefixArgs.map(rewritePath));
      const profileRoot = `${runtime.drive}\\profiles\\${binding.providerId}`;
      const leasePaths = [
        launcherPath,
        ...fixedPrefixArgs,
        profileRoot,
        `${runtime.drive}\\workspace`,
        `${runtime.drive}\\temp`,
      ];
      for (const value of leasePaths) assertNoCanonicalPathDisclosure(value);
      let released = false;
      return Object.freeze({
        providerId: binding.providerId,
        runtimeRoot: `${runtime.drive}\\`,
        profileRoot,
        workspaceRoot: `${runtime.drive}\\workspace`,
        tempRoot: `${runtime.drive}\\temp`,
        launcherPath,
        fixedPrefixArgs,
        rewritePath,
        assertNoCanonicalPathDisclosure,
        revalidate: (revalidationOperation) =>
          this.#serialize(() =>
            this.#revalidateTargets(
              [runtime, ...(install === null ? [] : [install])],
              revalidationOperation,
            ),
          ),
        release: async () => {
          if (released) return;
          released = true;
          const cleanupOperation = createCleanupOperation();
          try {
            await runCliCleanupWithinDeadline(cleanupOperation, () =>
              this.#serialize(async () => {
                let releaseFailed = false;
                if (install !== null) {
                  try {
                    await this.#releaseTarget(install, cleanupOperation);
                  } catch {
                    releaseFailed = true;
                  }
                }
                try {
                  await this.#releaseTarget(runtime, cleanupOperation);
                } catch {
                  releaseFailed = true;
                }
                if (releaseFailed) throw residualData();
              }),
            );
          } catch {
            this.#poisoned = true;
            throw residualData();
          }
        },
      });
    } catch (error) {
      const cleanupOperation = createCleanupOperation();
      let rollbackFailed = false;
      await runCliCleanupWithinDeadline(cleanupOperation, async () => {
        if (install !== null) {
          await this.#releaseTarget(install, cleanupOperation).catch(() => {
            rollbackFailed = true;
          });
        }
        await this.#releaseTarget(runtime, cleanupOperation).catch(() => {
          rollbackFailed = true;
        });
        if (rollbackFailed) throw residualData();
      }).catch(() => {
        rollbackFailed = true;
      });
      if (rollbackFailed) {
        this.#poisoned = true;
        throw residualData();
      }
      throw error;
    }
  }

  async cleanupStale(
    binding: CliRuntimeBinding,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    assertProviderConnectionActive(operation);
    await this.#serialize(() => this.#cleanupStale(binding, operation));
  }

  async #cleanupStale(
    binding: CliRuntimeBinding,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    assertProviderConnectionActive(operation);
    if (this.#poisoned) throw residualData();
    let current: CliRuntimeBinding;
    try {
      current = await this.#inspector.revalidate(binding, operation);
      assertProviderConnectionActive(operation);
    } catch (error) {
      if (error instanceof AppError && error.code === 'PROVIDER_CANCELLED') throw error;
      throw cliChanged();
    }
    if (!sameCliRuntimeBindingIdentity(current, binding)) throw cliChanged();
    const installRoot = this.#installRoot(binding);
    const [markers, mappings] = await Promise.all([
      this.#markers.list(operation),
      this.#mappings.list(operation),
    ]);
    assertProviderConnectionActive(operation);
    for (const marker of markers) {
      if (!WINDOWS_ALIAS_DRIVES.includes(marker.drive as (typeof WINDOWS_ALIAS_DRIVES)[number])) {
        continue;
      }
      if ([...this.#activeByTarget.values()].some((record) => record.drive === marker.drive)) {
        continue;
      }
      const mappedTarget = mappings.get(marker.drive);
      if (mappedTarget === undefined) {
        await this.#markers.remove(marker.drive, operation);
        assertProviderConnectionActive(operation);
        continue;
      }
      if (!sameWindowsPath(mappedTarget, marker.target)) continue;
      const runtimeProven =
        marker.kind === 'runtime' &&
        marker.bindingSha256 === null &&
        sameWindowsPath(marker.target, this.#runtimeRoot);
      const installProven =
        marker.kind === 'install' &&
        installRoot !== null &&
        marker.bindingSha256 === binding.bindingSha256 &&
        sameWindowsPath(marker.target, installRoot);
      if (!runtimeProven && !installProven) continue;
      await this.#mappings.unmap(marker.drive, marker.target, operation);
      assertProviderConnectionActive(operation);
      await this.#markers.remove(marker.drive, operation);
      assertProviderConnectionActive(operation);
    }
  }

  #installRoot(binding: CliRuntimeBinding): string | null {
    if (!SHA_256_PATTERN.test(binding.bindingSha256)) throw unsafeVersion();
    const componentPaths = [
      binding.canonicalLauncherPath,
      binding.canonicalEntryPath,
      binding.canonicalPackageManifestPath,
      binding.canonicalPlatformPackageManifestPath,
    ].filter((path): path is string => path !== null && containedOrEqual(this.#userProfile, path));
    if (componentPaths.length === 0) return null;
    const root = commonDirectory(componentPaths);
    if (
      root === null ||
      sameWindowsPath(root, this.#userProfile) ||
      !containedOrEqual(this.#userProfile, root) ||
      containedOrEqual(this.#runtimeRoot, root)
    ) {
      throw unsafeVersion();
    }
    return root;
  }

  #rewriteWith(path: string, runtime: ActiveMapping, install: ActiveMapping | null): string {
    const candidate =
      install !== null && containedOrEqual(install.target, path) ? install : runtime;
    if (!containedOrEqual(candidate.target, path)) return path;
    const relative = win32.relative(candidate.target, path);
    return relative.length === 0 ? `${candidate.drive}\\` : `${candidate.drive}\\${relative}`;
  }

  async #acquireTarget(
    kind: 'runtime' | 'install',
    target: string,
    bindingSha256: string | null,
    operation: ProviderConnectionOperation,
  ): Promise<ActiveMapping> {
    assertProviderConnectionActive(operation);
    const key = target.toLowerCase();
    const active = this.#activeByTarget.get(key);
    if (active !== undefined) {
      if (active.kind !== kind || active.bindingSha256 !== bindingSha256) throw residualData();
      const incremented = Object.freeze({ ...active, references: active.references + 1 });
      this.#activeByTarget.set(key, incremented);
      return incremented;
    }
    const mappings = await this.#mappings.list(operation);
    assertProviderConnectionActive(operation);
    const drive = WINDOWS_ALIAS_DRIVES.find(
      (candidate) =>
        !mappings.has(candidate) &&
        ![...this.#activeByTarget.values()].some((record) => record.drive === candidate),
    );
    if (drive === undefined) throw residualData();
    try {
      await this.#mappings.map(drive, target, operation);
      assertProviderConnectionActive(operation);
      const observed = (await this.#mappings.list(operation)).get(drive);
      assertProviderConnectionActive(operation);
      if (observed === undefined || !sameWindowsPath(observed, target)) throw residualData();
    } catch (error) {
      const cleanupOperation = createCleanupOperation();
      let rollbackFailed = false;
      await runCliCleanupWithinDeadline(cleanupOperation, () =>
        this.#mappings.unmap(drive, target, cleanupOperation),
      ).catch(() => {
        rollbackFailed = true;
      });
      if (rollbackFailed) {
        this.#poisoned = true;
        throw residualData();
      }
      if (error instanceof AppError && error.code === 'PROVIDER_CANCELLED') throw error;
      throw residualData();
    }
    const record: ActiveMapping = Object.freeze({
      drive,
      target,
      kind,
      bindingSha256,
      references: 1,
    });
    try {
      await this.#markers.write(Object.freeze({ kind, drive, target, bindingSha256 }), operation);
      assertProviderConnectionActive(operation);
    } catch (error) {
      const cleanupOperation = createCleanupOperation();
      let rollbackFailed = false;
      await runCliCleanupWithinDeadline(cleanupOperation, async () => {
        await this.#mappings.unmap(drive, target, cleanupOperation).catch(() => {
          rollbackFailed = true;
        });
        await this.#markers.remove(drive, cleanupOperation).catch(() => {
          rollbackFailed = true;
        });
        if (rollbackFailed) throw residualData();
      }).catch(() => {
        rollbackFailed = true;
      });
      if (rollbackFailed) {
        this.#poisoned = true;
        throw residualData();
      }
      if (error instanceof AppError && error.code === 'PROVIDER_CANCELLED') throw error;
      throw residualData();
    }
    this.#activeByTarget.set(key, record);
    return record;
  }

  async #releaseTarget(
    record: ActiveMapping,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    const key = record.target.toLowerCase();
    const current = this.#activeByTarget.get(key);
    if (
      current === undefined ||
      current.references <= 0 ||
      current.kind !== record.kind ||
      current.bindingSha256 !== record.bindingSha256 ||
      current.drive !== record.drive
    ) {
      throw residualData();
    }
    const references = current.references - 1;
    if (references > 0) {
      this.#activeByTarget.set(key, Object.freeze({ ...current, references }));
      return;
    }
    await this.#mappings.unmap(current.drive, current.target, operation);
    assertProviderConnectionActive(operation);
    await this.#markers.remove(current.drive, operation);
    assertProviderConnectionActive(operation);
    this.#activeByTarget.delete(key);
  }

  async #revalidateTargets(
    records: readonly ActiveMapping[],
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    assertProviderConnectionActive(operation);
    if (this.#poisoned) throw residualData();
    const [mappings, markers] = await Promise.all([
      this.#mappings.list(operation),
      this.#markers.list(operation),
    ]);
    assertProviderConnectionActive(operation);
    for (const record of records) {
      const current = this.#activeByTarget.get(record.target.toLowerCase());
      const marker = markers.find((candidate) => candidate.drive === record.drive);
      if (
        current === undefined ||
        current.references <= 0 ||
        current.drive !== record.drive ||
        current.kind !== record.kind ||
        current.bindingSha256 !== record.bindingSha256 ||
        !sameWindowsPath(current.target, record.target) ||
        !sameWindowsPath(mappings.get(record.drive) ?? '', record.target) ||
        marker === undefined ||
        marker.kind !== record.kind ||
        marker.bindingSha256 !== record.bindingSha256 ||
        !sameWindowsPath(marker.target, record.target)
      ) {
        this.#poisoned = true;
        throw residualData();
      }
    }
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const createWindowsWorkspaceAliasForTest = (
  options: WindowsWorkspaceAliasOptions,
): WindowsWorkspaceAlias => new ReferenceCountedWindowsWorkspaceAlias(options);

export const createWindowsWorkspaceAlias = createWindowsWorkspaceAliasForTest;
