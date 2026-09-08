import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import type { CliProviderId } from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';
import {
  assertProviderConnectionActive,
  type CliExecutableFileAccess,
  type CliFileHasher,
  isCanonicalAbsoluteWindowsPath,
  isContained,
  isDirectChild,
  isMissingPathError,
  runCliCleanupWithinDeadline,
  SHA_256_PATTERN,
  sameWindowsPath,
  secureExpectedPath,
  unsafeVersion,
} from './cliFileIntegrity';
import type { CliPrivateDirectoryManager } from './cliPrivateDirectories';

const UTF8_SNAPSHOT_LIMIT_BYTES = 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WINDOWS_RESERVED_NAME_PATTERN = /[\\/:*?"<>|]/u;
const WINDOWS_RESERVED_DEVICE_NAME_PATTERN =
  /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const CLI_PROVIDER_IDS = new Set<CliProviderId>(['antigravity_cli', 'gemini_cli', 'codex_cli']);
const RESIDUAL_FILENAMES = new Set([
  'auth.json',
  'codex_auth.age',
  'oauth_creds.json',
  'gemini-credentials.json',
]);

export interface NodeCliManagedFileHandle {
  write(contents: Uint8Array, offset?: number, length?: number): Promise<number> | Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type NodeCliManagedFileSystemOperations = Readonly<{
  mkdir(path: string): Promise<void>;
  openExclusive(path: string): Promise<NodeCliManagedFileHandle>;
  rename(source: string, target: string): Promise<void>;
  remove(path: string): Promise<void>;
}>;

export type ManagedArtifactOptions = Readonly<{
  providerRuntimeRoot: string;
  providerProfilesRoot: string;
  providerTempRoot: string;
  providerWorkspaceRoot: string;
  files: CliExecutableFileAccess;
  hasher: CliFileHasher;
  privateDirectories: CliPrivateDirectoryManager;
}>;

export type ManagedUtf8Snapshot = Readonly<{ contents: string; sha256: string }>;

export interface NodeCliManagedFileSystem {
  writeBinaryFileExclusive(
    path: string,
    bytes: Uint8Array,
    expectedSha256: string,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  verifyBinaryFile(
    path: string,
    sizeBytes: number,
    expectedSha256: string,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  prepareProfileDirectory(
    providerId: CliProviderId,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  readUtf8Snapshot(
    path: string,
    limitBytes: number,
    operation: ProviderConnectionOperation,
  ): Promise<ManagedUtf8Snapshot>;
  writeUtf8FileAtomic(
    path: string,
    contents: string,
    expectedSha256: string,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  verifyUtf8File(
    path: string,
    contents: string,
    expectedSha256: string,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  assertDirectoryChildren(
    path: string,
    expectedNames: readonly string[],
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  assertDirectoryHasNoUnexpectedChildren(
    path: string,
    allowedNames: readonly string[],
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  prepareRequestDirectory(
    providerId: CliProviderId,
    requestId: string,
    workspacePath: string,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  cleanupRequestDirectory(requestId: string, workspacePath: string): Promise<void>;
}

const nodeOperations: NodeCliManagedFileSystemOperations = Object.freeze({
  mkdir: (path: string) => mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined),
  openExclusive: async (path: string) => {
    const handle = await open(path, 'wx', 0o600);
    return Object.freeze({
      write: async (contents: Uint8Array, offset = 0, length = contents.byteLength - offset) => {
        const result = await handle.write(contents, offset, length, offset);
        return result.bytesWritten;
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    });
  },
  // Node's same-volume rename is the atomic replacement boundary for an existing managed file.
  rename,
  remove: (path: string) => rm(path, { recursive: false, force: false }),
});

const providerError = (code: 'PROVIDER_RESIDUAL_DATA'): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);

const sha256 = (contents: Uint8Array): string =>
  createHash('sha256').update(contents).digest('hex');

const createCleanupOperation = (): ProviderConnectionOperation =>
  Object.freeze({ requestId: randomUUID(), signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });

const normalizeFailure = (error: unknown): never => {
  if (AppError.isTrusted(error)) throw error;
  throw unsafeVersion();
};

const validateOptions = (options: ManagedArtifactOptions): void => {
  if (
    ![
      options.providerRuntimeRoot,
      options.providerProfilesRoot,
      options.providerTempRoot,
      options.providerWorkspaceRoot,
    ].every(isCanonicalAbsoluteWindowsPath) ||
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
    throw unsafeVersion();
  }
};

const validateExpectedSha = (expectedSha256: string): void => {
  if (!SHA_256_PATTERN.test(expectedSha256)) throw unsafeVersion();
};

const validateContents = (contents: string, expectedSha256: string): Uint8Array => {
  validateExpectedSha(expectedSha256);
  const bytes = Buffer.from(contents, 'utf8');
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > UTF8_SNAPSHOT_LIMIT_BYTES ||
    sha256(bytes) !== expectedSha256
  ) {
    throw unsafeVersion();
  }
  return bytes;
};

const isSafeChildName = (name: string): boolean => {
  const lower = name.toLowerCase();
  const hasControlCharacter = [...name].some((character) => character.charCodeAt(0) <= 0x1f);
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    win32.basename(name) === name &&
    !WINDOWS_RESERVED_NAME_PATTERN.test(name) &&
    !WINDOWS_RESERVED_DEVICE_NAME_PATTERN.test(name) &&
    !hasControlCharacter &&
    !name.endsWith('.') &&
    !name.endsWith(' ') &&
    !RESIDUAL_FILENAMES.has(lower)
  );
};

const validateNames = (names: readonly string[]): ReadonlySet<string> => {
  const normalized = names.map((name) => name.toLowerCase());
  if (names.some((name) => !isSafeChildName(name)) || new Set(normalized).size !== names.length) {
    throw unsafeVersion();
  }
  return new Set(normalized);
};

const assertExpectedManagedPath = (
  options: ManagedArtifactOptions,
  path: string,
  operation: ProviderConnectionOperation,
): string => {
  assertProviderConnectionActive(operation);
  if (!isCanonicalAbsoluteWindowsPath(path) || !isContained(options.providerRuntimeRoot, path)) {
    throw unsafeVersion();
  }
  return path;
};

const assertManagedWritePath = (
  options: ManagedArtifactOptions,
  path: string,
  operation: ProviderConnectionOperation,
): string => {
  const expected = assertExpectedManagedPath(options, path, operation);
  if (isContained(options.providerProfilesRoot, expected)) {
    const [providerId] = win32.relative(options.providerProfilesRoot, expected).split('\\');
    if (providerId === undefined || !CLI_PROVIDER_IDS.has(providerId as CliProviderId)) {
      throw unsafeVersion();
    }
    return expected;
  }
  for (const requestRoot of [options.providerTempRoot, options.providerWorkspaceRoot]) {
    if (!isContained(requestRoot, expected)) continue;
    const [pathRequestId] = win32.relative(requestRoot, expected).split('\\');
    if (
      pathRequestId === undefined ||
      !UUID_PATTERN.test(pathRequestId) ||
      pathRequestId !== operation.requestId
    ) {
      throw unsafeVersion();
    }
    return expected;
  }
  throw unsafeVersion();
};

const assertExistingManagedPath = async (
  options: ManagedArtifactOptions,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<string> => {
  const expected = assertExpectedManagedPath(options, path, operation);
  const canonical = await secureExpectedPath(
    options.files,
    expected,
    options.providerRuntimeRoot,
    operation,
  );
  assertProviderConnectionActive(operation);
  return canonical;
};

const assertExistingOrMissingManagedPath = async (
  options: ManagedArtifactOptions,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<'existing' | 'missing'> => {
  assertExpectedManagedPath(options, path, operation);
  try {
    await assertExistingManagedPath(options, path, operation);
    return 'existing';
  } catch (error) {
    assertProviderConnectionActive(operation);
    if (isMissingPathError(error)) return 'missing';
    return normalizeFailure(error);
  }
};

const ensureExistingParent = async (
  options: ManagedArtifactOptions,
  operations: NodeCliManagedFileSystemOperations,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<void> => {
  const parent = win32.dirname(path);
  const state = await assertExistingOrMissingManagedPath(options, parent, operation);
  if (state === 'missing') {
    const ancestor = win32.dirname(parent);
    if (!isSafeChildName(win32.basename(parent))) throw unsafeVersion();
    await assertExistingManagedPath(options, ancestor, operation);
    assertProviderConnectionActive(operation);
    await operations.mkdir(parent);
    assertProviderConnectionActive(operation);
    try {
      await assertExistingManagedPath(options, parent, operation);
      await assertExistingManagedPath(options, ancestor, operation);
    } catch {
      throw providerError('PROVIDER_RESIDUAL_DATA');
    }
    return;
  }
  assertProviderConnectionActive(operation);
  await operations.mkdir(parent);
  assertProviderConnectionActive(operation);
  await assertExistingManagedPath(options, parent, operation);
};

const writeAll = async (
  handle: NodeCliManagedFileHandle,
  contents: Uint8Array,
  operation: ProviderConnectionOperation,
): Promise<void> => {
  let offset = 0;
  while (offset < contents.byteLength) {
    assertProviderConnectionActive(operation);
    const remaining = contents.byteLength - offset;
    const result = await handle.write(contents, offset, remaining);
    assertProviderConnectionActive(operation);
    const written = result === undefined ? remaining : result;
    if (!Number.isSafeInteger(written) || written <= 0 || written > remaining) {
      throw unsafeVersion();
    }
    offset += written;
  }
};

const closeHandle = async (handle: NodeCliManagedFileHandle): Promise<void> => {
  try {
    await handle.close();
  } catch {
    throw unsafeVersion();
  }
};

const assertFileAbsent = async (
  files: CliExecutableFileAccess,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<void> => {
  assertProviderConnectionActive(operation);
  try {
    await files.readFile(path, 1, operation);
    throw providerError('PROVIDER_RESIDUAL_DATA');
  } catch (error) {
    assertProviderConnectionActive(operation);
    if (isMissingPathError(error)) return;
    throw providerError('PROVIDER_RESIDUAL_DATA');
  }
};

const assertDirectoryAbsent = async (
  files: CliExecutableFileAccess,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<void> => {
  assertProviderConnectionActive(operation);
  try {
    await files.listChildren(path, operation);
    throw providerError('PROVIDER_RESIDUAL_DATA');
  } catch (error) {
    assertProviderConnectionActive(operation);
    if (isMissingPathError(error)) return;
    throw providerError('PROVIDER_RESIDUAL_DATA');
  }
};

const cleanupOwnedFile = async (
  options: ManagedArtifactOptions,
  operations: NodeCliManagedFileSystemOperations,
  path: string,
  handle: NodeCliManagedFileHandle | null,
): Promise<void> => {
  const cleanup = createCleanupOperation();
  try {
    await runCliCleanupWithinDeadline(cleanup, async () => {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // Removal plus absence proof decides whether any data remains.
        }
      }
      assertProviderConnectionActive(cleanup);
      const state = await assertExistingOrMissingManagedPath(options, path, cleanup);
      if (state === 'missing') {
        await assertFileAbsent(options.files, path, cleanup);
        return;
      }
      assertProviderConnectionActive(cleanup);
      try {
        await operations.remove(path);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      assertProviderConnectionActive(cleanup);
      await assertFileAbsent(options.files, path, cleanup);
    });
  } catch {
    throw providerError('PROVIDER_RESIDUAL_DATA');
  }
};

const validateRequest = (
  options: ManagedArtifactOptions,
  providerId: CliProviderId,
  requestId: string,
  workspacePath: string,
  operation?: ProviderConnectionOperation,
): Readonly<{ workspace: string; temp: string }> => {
  if (
    !UUID_PATTERN.test(requestId) ||
    !CLI_PROVIDER_IDS.has(providerId) ||
    (operation !== undefined && operation.requestId !== requestId)
  ) {
    throw unsafeVersion();
  }
  const workspace = win32.join(options.providerWorkspaceRoot, requestId);
  const temp = win32.join(options.providerTempRoot, requestId);
  if (
    win32.normalize(workspacePath) !== workspacePath ||
    !sameWindowsPath(workspacePath, workspace)
  ) {
    throw providerError('PROVIDER_RESIDUAL_DATA');
  }
  return Object.freeze({ workspace, temp });
};

const cleanupRequestPaths = async (
  options: ManagedArtifactOptions,
  requestId: string,
  paths: Readonly<{ workspace: string; temp: string }>,
): Promise<void> => {
  const cleanup = createCleanupOperation();
  try {
    await runCliCleanupWithinDeadline(cleanup, async () => {
      await options.privateDirectories.cleanupRequest(requestId, paths.workspace);
      assertProviderConnectionActive(cleanup);
      await assertDirectoryAbsent(options.files, paths.workspace, cleanup);
      await assertDirectoryAbsent(options.files, paths.temp, cleanup);
    });
  } catch {
    throw providerError('PROVIDER_RESIDUAL_DATA');
  }
};

const inspectDirectory = async (
  options: ManagedArtifactOptions,
  path: string,
  allowMissing: boolean,
  operation: ProviderConnectionOperation,
): Promise<readonly string[]> => {
  const state = await assertExistingOrMissingManagedPath(options, path, operation);
  if (state === 'missing') {
    if (allowMissing) return Object.freeze([]);
    throw unsafeVersion();
  }
  try {
    const children = await options.files.listChildren(path, operation);
    assertProviderConnectionActive(operation);
    await assertExistingManagedPath(options, path, operation);
    const names = children.map((child) => win32.basename(child).toLowerCase());
    if (
      children.some(
        (child) =>
          !isCanonicalAbsoluteWindowsPath(child) ||
          !isDirectChild(path, child) ||
          !isSafeChildName(win32.basename(child)),
      ) ||
      new Set(names).size !== names.length
    ) {
      throw providerError('PROVIDER_RESIDUAL_DATA');
    }
    return Object.freeze(names);
  } catch (error) {
    assertProviderConnectionActive(operation);
    if (allowMissing && isMissingPathError(error)) return Object.freeze([]);
    return normalizeFailure(error);
  }
};

const createManagedFileSystem = (
  options: ManagedArtifactOptions,
  operations: NodeCliManagedFileSystemOperations,
): NodeCliManagedFileSystem => {
  validateOptions(options);

  const managed: NodeCliManagedFileSystem = {
    async writeBinaryFileExclusive(path, input, expectedSha256, operation) {
      let handle: NodeCliManagedFileHandle | null = null;
      let owned = false;
      let finalized = false;
      try {
        assertProviderConnectionActive(operation);
        if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > 5_000_000)
          throw unsafeVersion();
        const bytes = Uint8Array.from(input);
        validateExpectedSha(expectedSha256);
        if (sha256(bytes) !== expectedSha256) throw unsafeVersion();
        assertManagedWritePath(options, path, operation);
        if (!/^image-00[01]\.(png|jpg)$/u.test(win32.basename(path))) throw unsafeVersion();
        await assertExistingManagedPath(options, win32.dirname(path), operation);
        await assertFileAbsent(options.files, path, operation);
        handle = await operations.openExclusive(path);
        owned = true;
        await writeAll(handle, bytes, operation);
        await handle.sync();
        await closeHandle(handle);
        handle = null;
        finalized = true;
        await managed.verifyBinaryFile(path, bytes.length, expectedSha256, operation);
      } catch (error) {
        // A closed file that fails verification is no longer proven ours to delete.
        if (finalized) throw providerError('PROVIDER_RESIDUAL_DATA');
        if (owned) await cleanupOwnedFile(options, operations, path, handle);
        return normalizeFailure(error);
      }
    },
    async verifyBinaryFile(path, sizeBytes, expectedSha256, operation) {
      try {
        assertProviderConnectionActive(operation);
        validateExpectedSha(expectedSha256);
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 5_000_000)
          throw unsafeVersion();
        for (let index = 0; index < 2; index += 1) {
          const canonical = await assertExistingManagedPath(options, path, operation);
          const bytes = await options.files.readFile(canonical, sizeBytes + 1, operation);
          await assertExistingManagedPath(options, path, operation);
          if (bytes.byteLength !== sizeBytes || sha256(bytes) !== expectedSha256)
            throw unsafeVersion();
        }
        if ((await options.hasher.sha256(path, operation)) !== expectedSha256)
          throw unsafeVersion();
      } catch (error) {
        return normalizeFailure(error);
      }
    },
    async prepareProfileDirectory(providerId, operation) {
      try {
        assertProviderConnectionActive(operation);
        if (!CLI_PROVIDER_IDS.has(providerId)) throw unsafeVersion();
        await options.privateDirectories.prepareProfile(providerId, operation);
        assertProviderConnectionActive(operation);
        const settingsPath = win32.join(options.providerProfilesRoot, providerId, 'settings');
        await assertExistingManagedPath(options, settingsPath, operation);
        assertProviderConnectionActive(operation);
      } catch (error) {
        return normalizeFailure(error);
      }
    },

    async readUtf8Snapshot(path, limitBytes, operation) {
      try {
        assertProviderConnectionActive(operation);
        if (
          !Number.isSafeInteger(limitBytes) ||
          limitBytes <= 0 ||
          limitBytes > UTF8_SNAPSHOT_LIMIT_BYTES
        ) {
          throw unsafeVersion();
        }
        const canonical = await assertExistingManagedPath(options, path, operation);
        const source = await options.files.readFile(canonical, limitBytes, operation);
        assertProviderConnectionActive(operation);
        const bytes = Uint8Array.from(source);
        if (bytes.byteLength === 0 || bytes.byteLength > limitBytes) throw unsafeVersion();
        await assertExistingManagedPath(options, canonical, operation);
        let contents: string;
        try {
          contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw unsafeVersion();
        }
        return Object.freeze({ contents, sha256: sha256(bytes) });
      } catch (error) {
        return normalizeFailure(error);
      }
    },

    async writeUtf8FileAtomic(path, contents, expectedSha256, operation) {
      let ownedPath: string | null = null;
      let handle: NodeCliManagedFileHandle | null = null;
      try {
        assertProviderConnectionActive(operation);
        const bytes = validateContents(contents, expectedSha256);
        const finalPath = assertManagedWritePath(options, path, operation);
        if (!isSafeChildName(win32.basename(finalPath))) throw unsafeVersion();
        await ensureExistingParent(options, operations, finalPath, operation);
        await assertExistingOrMissingManagedPath(options, finalPath, operation);
        assertProviderConnectionActive(operation);
        const tempPath = `${finalPath}.${randomUUID()}.tmp`;
        if (
          !isContained(options.providerRuntimeRoot, tempPath) ||
          !isDirectChild(win32.dirname(finalPath), tempPath)
        ) {
          throw unsafeVersion();
        }
        assertProviderConnectionActive(operation);
        handle = await operations.openExclusive(tempPath);
        ownedPath = tempPath;
        assertProviderConnectionActive(operation);
        await writeAll(handle, bytes, operation);
        assertProviderConnectionActive(operation);
        await handle.sync();
        assertProviderConnectionActive(operation);
        await closeHandle(handle);
        handle = null;
        await assertExistingManagedPath(options, tempPath, operation);
        await assertExistingOrMissingManagedPath(options, finalPath, operation);
        assertProviderConnectionActive(operation);
        await operations.rename(tempPath, finalPath);
        ownedPath = finalPath;
        assertProviderConnectionActive(operation);
        await managed.verifyUtf8File(finalPath, contents, expectedSha256, operation);
        assertProviderConnectionActive(operation);
        ownedPath = null;
      } catch (error) {
        if (ownedPath !== null) {
          await cleanupOwnedFile(options, operations, ownedPath, handle);
        }
        return normalizeFailure(error);
      }
    },

    async verifyUtf8File(path, contents, expectedSha256, operation) {
      try {
        assertProviderConnectionActive(operation);
        validateContents(contents, expectedSha256);
        const snapshot = await managed.readUtf8Snapshot(path, UTF8_SNAPSHOT_LIMIT_BYTES, operation);
        assertProviderConnectionActive(operation);
        const canonical = await assertExistingManagedPath(options, path, operation);
        const fileSha256 = await options.hasher.sha256(canonical, operation);
        assertProviderConnectionActive(operation);
        if (
          snapshot.contents !== contents ||
          snapshot.sha256 !== expectedSha256 ||
          fileSha256 !== expectedSha256 ||
          !SHA_256_PATTERN.test(fileSha256)
        ) {
          throw unsafeVersion();
        }
        const confirmed = await managed.readUtf8Snapshot(
          canonical,
          UTF8_SNAPSHOT_LIMIT_BYTES,
          operation,
        );
        if (confirmed.contents !== contents || confirmed.sha256 !== expectedSha256) {
          throw unsafeVersion();
        }
      } catch (error) {
        return normalizeFailure(error);
      }
    },

    async assertDirectoryChildren(path, expectedNames, operation) {
      try {
        assertProviderConnectionActive(operation);
        const expected = validateNames(expectedNames);
        const actual = await inspectDirectory(options, path, false, operation);
        if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) {
          throw providerError('PROVIDER_RESIDUAL_DATA');
        }
      } catch (error) {
        return normalizeFailure(error);
      }
    },

    async assertDirectoryHasNoUnexpectedChildren(path, allowedNames, operation) {
      try {
        assertProviderConnectionActive(operation);
        const allowed = validateNames(allowedNames);
        const actual = await inspectDirectory(options, path, true, operation);
        if (actual.some((name) => !allowed.has(name))) {
          throw providerError('PROVIDER_RESIDUAL_DATA');
        }
      } catch (error) {
        return normalizeFailure(error);
      }
    },

    async prepareRequestDirectory(providerId, id, workspacePath, operation) {
      let cleanupNeeded = false;
      let paths: Readonly<{ workspace: string; temp: string }> | null = null;
      try {
        assertProviderConnectionActive(operation);
        paths = validateRequest(options, providerId, id, workspacePath, operation);
        cleanupNeeded = true;
        await options.privateDirectories.prepareRequest(providerId, id, paths.workspace, operation);
        assertProviderConnectionActive(operation);
        await managed.assertDirectoryChildren(paths.workspace, [], operation);
        await managed.assertDirectoryChildren(paths.temp, [], operation);
        cleanupNeeded = false;
      } catch (error) {
        if (cleanupNeeded && paths !== null) {
          await cleanupRequestPaths(options, id, paths);
        }
        return normalizeFailure(error);
      }
    },

    async cleanupRequestDirectory(id, workspacePath) {
      try {
        const paths = validateRequest(options, 'gemini_cli', id, workspacePath);
        await cleanupRequestPaths(options, id, paths);
      } catch {
        throw providerError('PROVIDER_RESIDUAL_DATA');
      }
    },
  };

  return Object.freeze(managed);
};

export const createNodeCliManagedFileSystem = (
  options: ManagedArtifactOptions,
): NodeCliManagedFileSystem => createManagedFileSystem(options, nodeOperations);

export const createNodeCliManagedFileSystemForTest = (
  options: ManagedArtifactOptions & Readonly<{ operations: NodeCliManagedFileSystemOperations }>,
): NodeCliManagedFileSystem => createManagedFileSystem(options, options.operations);

export const createNodeCliManagedFileSystemWithOperationsForTest =
  createNodeCliManagedFileSystemForTest;
