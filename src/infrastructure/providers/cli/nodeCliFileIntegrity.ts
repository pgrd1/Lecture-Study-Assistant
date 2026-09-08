import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  lstat as nodeLstat,
  open as nodeOpen,
  opendir as nodeOpenDirectory,
  realpath as nodeRealpath,
} from 'node:fs/promises';
import { win32 } from 'node:path';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import {
  assertProviderConnectionActive,
  type CliExecutableFileAccess,
  type CliFileHasher,
  isCanonicalAbsoluteWindowsPath,
  isDirectChild,
  isMissingPathError,
  sameWindowsPath,
  unsafeVersion,
} from './cliFileIntegrity';

const MAX_DIRECTORY_CHILDREN = 4_096;
const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_READ_LIMIT_BYTES = 16 * 1024 * 1024;
const UNSAFE_CHILD_NAME_PATTERN = /[<>:"/\\|?*\p{Cc}\p{Cf}]/u;
const WINDOWS_RESERVED_DEVICE_NAME_PATTERN =
  /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

export type NodeCliFileStat = Readonly<{
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}>;

export interface NodeCliFileHandle {
  stat(): Promise<NodeCliFileStat>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesRead: number }>>;
  close(): Promise<void>;
}

export interface NodeCliDirectoryHandle {
  read(): Promise<NodeCliDirent | null>;
  close(): Promise<void>;
}

export interface NodeCliDirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export type NodeCliFileSystemOperations = Readonly<{
  lstat(path: string): Promise<NodeCliFileStat>;
  realpath(path: string): Promise<string>;
  open(path: string): Promise<NodeCliFileHandle>;
  opendir(path: string): Promise<NodeCliDirectoryHandle>;
}>;

const nodeOperations: NodeCliFileSystemOperations = Object.freeze({
  lstat: nodeLstat,
  realpath: nodeRealpath,
  open: async (path: string): Promise<NodeCliFileHandle> => nodeOpen(path, 'r'),
  opendir: async (path: string): Promise<NodeCliDirectoryHandle> => nodeOpenDirectory(path),
});

type MissingPathCode = 'ENOENT' | 'ENOTDIR';

const missingPathCode = (error: unknown): MissingPathCode | null => {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return code;
  }
  if (error instanceof Error && (error.message === 'ENOENT' || error.message === 'ENOTDIR')) {
    return error.message;
  }
  return null;
};

const sanitizedMissingPathError = (code: MissingPathCode): Error & { code: MissingPathCode } =>
  Object.assign(new Error(code), { code });

const normalizeUnsafeError = (error: unknown): never => {
  const code = missingPathCode(error);
  if (code !== null || isMissingPathError(error)) {
    throw sanitizedMissingPathError(code ?? 'ENOENT');
  }
  throw unsafeVersion();
};

const assertActiveAfterError = (operation: ProviderConnectionOperation, error: unknown): never => {
  assertProviderConnectionActive(operation);
  return normalizeUnsafeError(error);
};

const withFilesystemBoundary = async <T>(
  operation: ProviderConnectionOperation,
  action: () => Promise<T>,
): Promise<T> => {
  assertProviderConnectionActive(operation);
  try {
    const value = await action();
    assertProviderConnectionActive(operation);
    return value;
  } catch (error) {
    return assertActiveAfterError(operation, error);
  }
};

const assertCanonicalInputPath = (path: string): void => {
  if (!isCanonicalAbsoluteWindowsPath(path)) throw unsafeVersion();
};

const assertSafePathSegment = (name: string): void => {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    UNSAFE_CHILD_NAME_PATTERN.test(name) ||
    WINDOWS_RESERVED_DEVICE_NAME_PATTERN.test(name) ||
    /[ .]$/u.test(name) ||
    win32.basename(name) !== name ||
    win32.normalize(name) !== name
  ) {
    throw unsafeVersion();
  }
};

const pathSegmentsRootToLeaf = (path: string): readonly string[] => {
  assertCanonicalInputPath(path);
  const { root } = win32.parse(path);
  if (root.length === 0 || !sameWindowsPath(root, path.slice(0, root.length))) {
    throw unsafeVersion();
  }
  const relative = win32.relative(root, path);
  if (relative.length === 0) return Object.freeze([root]);
  if (relative.startsWith('..') || win32.isAbsolute(relative)) throw unsafeVersion();
  const parts = relative.split('\\');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw unsafeVersion();
  }
  for (const part of parts) assertSafePathSegment(part);
  return Object.freeze([
    root,
    ...parts.map((_part, index) => win32.join(root, ...parts.slice(0, index + 1))),
  ]);
};

const assertSafeSegmentStat = (stat: NodeCliFileStat, isLeaf: boolean): void => {
  if (stat.isSymbolicLink()) throw unsafeVersion();
  if (!isLeaf && !stat.isDirectory()) throw unsafeVersion();
};

const walkWithoutReparsePoints = async (
  operations: NodeCliFileSystemOperations,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<void> => {
  const segments = pathSegmentsRootToLeaf(path);
  for (const [index, segment] of segments.entries()) {
    const stat = await withFilesystemBoundary(operation, () => operations.lstat(segment));
    assertSafeSegmentStat(stat, index === segments.length - 1);
  }
};

const canonicalizePath = async (
  operations: NodeCliFileSystemOperations,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<string> => {
  await walkWithoutReparsePoints(operations, path, operation);
  const canonical = await withFilesystemBoundary(operation, () => operations.realpath(path));
  assertCanonicalInputPath(canonical);
  if (!sameWindowsPath(canonical, path)) throw unsafeVersion();
  await walkWithoutReparsePoints(operations, canonical, operation);
  return canonical;
};

const assertStatIdentity = (before: NodeCliFileStat, after: NodeCliFileStat): void => {
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.isFile() !== after.isFile() ||
    before.isDirectory() !== after.isDirectory() ||
    before.isSymbolicLink() !== after.isSymbolicLink()
  ) {
    throw unsafeVersion();
  }
};

const revalidatePathIdentity = async (
  operations: NodeCliFileSystemOperations,
  canonical: string,
  before: NodeCliFileStat,
  operation: ProviderConnectionOperation,
): Promise<void> => {
  const canonicalAfter = await canonicalizePath(operations, canonical, operation);
  if (!sameWindowsPath(canonicalAfter, canonical)) throw unsafeVersion();
  const pathAfter = await withFilesystemBoundary(operation, () => operations.lstat(canonicalAfter));
  assertStatIdentity(before, pathAfter);
};

const assertRegularFileStat = (stat: NodeCliFileStat, limitBytes: number): void => {
  if (!stat.isFile() || stat.isSymbolicLink()) throw unsafeVersion();
  if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > limitBytes) {
    throw unsafeVersion();
  }
};

const assertReadLimit = (limitBytes: number): void => {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0 || limitBytes > MAX_READ_LIMIT_BYTES) {
    throw unsafeVersion();
  }
};

const openFileHandle = async (
  operations: NodeCliFileSystemOperations,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<NodeCliFileHandle> => {
  assertProviderConnectionActive(operation);
  try {
    return await operations.open(path);
  } catch (error) {
    return assertActiveAfterError(operation, error);
  }
};

const openDirectoryHandle = async (
  operations: NodeCliFileSystemOperations,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<NodeCliDirectoryHandle> => {
  assertProviderConnectionActive(operation);
  try {
    return await operations.opendir(path);
  } catch (error) {
    return assertActiveAfterError(operation, error);
  }
};

const statHandle = async (
  handle: NodeCliFileHandle,
  operation: ProviderConnectionOperation,
): Promise<NodeCliFileStat> => withFilesystemBoundary(operation, () => handle.stat());

const readChunk = async (
  handle: NodeCliFileHandle,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
  operation: ProviderConnectionOperation,
): Promise<number> => {
  const { bytesRead } = await withFilesystemBoundary(operation, () =>
    handle.read(buffer, offset, length, position),
  );
  if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
    throw unsafeVersion();
  }
  return bytesRead;
};

const readExactBytes = async (
  handle: NodeCliFileHandle,
  buffer: Uint8Array,
  operation: ProviderConnectionOperation,
): Promise<void> => {
  let position = 0;
  while (position < buffer.byteLength) {
    const bytesRead = await readChunk(
      handle,
      buffer,
      position,
      buffer.byteLength - position,
      position,
      operation,
    );
    if (bytesRead === 0) throw unsafeVersion();
    position += bytesRead;
  }
};

const assertEof = async (
  handle: NodeCliFileHandle,
  position: number,
  operation: ProviderConnectionOperation,
): Promise<void> => {
  const eofProbe = Buffer.alloc(1);
  const bytesRead = await readChunk(handle, eofProbe, 0, 1, position, operation);
  if (bytesRead !== 0) throw unsafeVersion();
};

const closeHandle = async (handle: NodeCliFileHandle): Promise<void> => {
  try {
    await handle.close();
  } catch {
    throw unsafeVersion();
  }
};

const readExactFile = async (
  operations: NodeCliFileSystemOperations,
  path: string,
  limitBytes: number,
  operation: ProviderConnectionOperation,
): Promise<Uint8Array> => {
  assertReadLimit(limitBytes);
  const canonical = await canonicalizePath(operations, path, operation);
  let handle: NodeCliFileHandle | undefined;
  try {
    const pathBefore = await withFilesystemBoundary(operation, () => operations.lstat(canonical));
    assertRegularFileStat(pathBefore, limitBytes);
    handle = await openFileHandle(operations, canonical, operation);
    assertProviderConnectionActive(operation);
    const before = await statHandle(handle, operation);
    assertStatIdentity(pathBefore, before);
    assertRegularFileStat(before, limitBytes);
    const buffer = Buffer.alloc(before.size);
    await readExactBytes(handle, buffer, operation);
    await assertEof(handle, before.size, operation);
    const after = await statHandle(handle, operation);
    assertStatIdentity(before, after);
    await revalidatePathIdentity(operations, canonical, before, operation);
    return Uint8Array.from(buffer);
  } finally {
    if (handle !== undefined) await closeHandle(handle);
  }
};

const assertSafeDirent = (dirent: NodeCliDirent): void => {
  assertSafePathSegment(dirent.name);
  if (dirent.isSymbolicLink() || (!dirent.isFile() && !dirent.isDirectory())) {
    throw unsafeVersion();
  }
};

const compareWindowsPaths = (left: string, right: string): number => {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const readDirectoryEntry = async (
  handle: NodeCliDirectoryHandle,
  operation: ProviderConnectionOperation,
): Promise<NodeCliDirent | null> => withFilesystemBoundary(operation, () => handle.read());

const closeDirectoryHandle = async (handle: NodeCliDirectoryHandle): Promise<void> => {
  try {
    await handle.close();
  } catch {
    throw unsafeVersion();
  }
};

const listDirectoryChildren = async (
  operations: NodeCliFileSystemOperations,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<readonly string[]> => {
  const canonical = await canonicalizePath(operations, path, operation);
  let directory: NodeCliDirectoryHandle | undefined;
  try {
    const before = await withFilesystemBoundary(operation, () => operations.lstat(canonical));
    if (!before.isDirectory() || before.isSymbolicLink()) throw unsafeVersion();
    directory = await openDirectoryHandle(operations, canonical, operation);
    assertProviderConnectionActive(operation);
    let children: readonly string[] = Object.freeze([]);
    const foldedNames = new Set<string>();
    for (let inspected = 0; inspected <= MAX_DIRECTORY_CHILDREN; inspected += 1) {
      const dirent = await readDirectoryEntry(directory, operation);
      if (dirent === null) break;
      if (inspected === MAX_DIRECTORY_CHILDREN) throw unsafeVersion();
      assertSafeDirent(dirent);
      const foldedName = dirent.name.toLowerCase();
      if (foldedNames.has(foldedName)) throw unsafeVersion();
      foldedNames.add(foldedName);
      const child = win32.join(canonical, dirent.name);
      if (!isCanonicalAbsoluteWindowsPath(child) || !isDirectChild(canonical, child)) {
        throw unsafeVersion();
      }
      children = Object.freeze([...children, child]);
    }
    await revalidatePathIdentity(operations, canonical, before, operation);
    return Object.freeze(children.toSorted(compareWindowsPaths));
  } finally {
    if (directory !== undefined) await closeDirectoryHandle(directory);
  }
};

const hashFile = async (
  operations: NodeCliFileSystemOperations,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<string> => {
  const canonical = await canonicalizePath(operations, path, operation);
  let handle: NodeCliFileHandle | undefined;
  try {
    const pathBefore = await withFilesystemBoundary(operation, () => operations.lstat(canonical));
    assertRegularFileStat(pathBefore, Number.MAX_SAFE_INTEGER);
    handle = await openFileHandle(operations, canonical, operation);
    assertProviderConnectionActive(operation);
    const before = await statHandle(handle, operation);
    assertStatIdentity(pathBefore, before);
    assertRegularFileStat(before, Number.MAX_SAFE_INTEGER);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, before.size));
    let position = 0;
    while (position < before.size) {
      const length = Math.min(buffer.byteLength, before.size - position);
      const bytesRead = await readChunk(handle, buffer, 0, length, position, operation);
      if (bytesRead === 0) throw unsafeVersion();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    await assertEof(handle, before.size, operation);
    const after = await statHandle(handle, operation);
    assertStatIdentity(before, after);
    await revalidatePathIdentity(operations, canonical, before, operation);
    return hash.digest('hex');
  } finally {
    if (handle !== undefined) await closeHandle(handle);
  }
};

const createNodeCliFileIntegrity = (
  operations: NodeCliFileSystemOperations,
): Readonly<{ files: CliExecutableFileAccess; hasher: CliFileHasher }> => {
  const files: CliExecutableFileAccess = Object.freeze({
    canonicalize: async (path: string, operation: ProviderConnectionOperation) => {
      return canonicalizePath(operations, path, operation);
    },
    assertNoReparsePoints: async (path: string, operation: ProviderConnectionOperation) => {
      await walkWithoutReparsePoints(operations, path, operation);
    },
    readFile: async (path: string, limitBytes: number, operation: ProviderConnectionOperation) =>
      readExactFile(operations, path, limitBytes, operation),
    listChildren: async (path: string, operation: ProviderConnectionOperation) =>
      listDirectoryChildren(operations, path, operation),
  });
  const hasher: CliFileHasher = Object.freeze({
    sha256: async (path: string, operation: ProviderConnectionOperation) =>
      hashFile(operations, path, operation),
  });
  return Object.freeze({ files, hasher });
};

export const createNodeCliExecutableFileAccess = (): CliExecutableFileAccess =>
  createNodeCliFileIntegrity(nodeOperations).files;

export const createNodeCliFileHasher = (): CliFileHasher =>
  createNodeCliFileIntegrity(nodeOperations).hasher;

export const createNodeCliFileIntegrityForTest = (
  operations: NodeCliFileSystemOperations,
): Readonly<{ files: CliExecutableFileAccess; hasher: CliFileHasher }> =>
  createNodeCliFileIntegrity(operations);
