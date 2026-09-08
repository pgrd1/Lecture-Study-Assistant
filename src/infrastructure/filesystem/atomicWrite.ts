import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertNoReparsePoints } from '../../core/paths/safePath';
import type { VaultConnection } from '../../core/ports/vault';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

export type AtomicMutationKind =
  | 'open-temp'
  | 'rename-target-to-backup'
  | 'rename-temp-to-target'
  | 'restore-backup';

export type AtomicMutation = Readonly<{
  kind: AtomicMutationKind;
  targetPath: string;
}>;

export type AtomicWriteDependencies = Readonly<{
  clock?: () => Date;
  idGenerator?: () => string;
  beforeMutation?: (mutation: AtomicMutation) => void | Promise<void>;
}>;

export type AtomicReplaceResult<T> = Readonly<{
  value: T;
  targetPath: string;
  temporaryRecoveryToken: string | null;
  backupRecoveryToken: string | null;
}>;

export type AtomicTargetSelection = Readonly<{
  targetPath: string;
  replaceExisting: boolean;
}>;

type AtomicReplaceInput<T> = Readonly<{
  connection: VaultConnection;
  targetPath: string;
  replaceExisting: boolean;
  write: (handle: FileHandle) => Promise<T>;
  selectTarget?: () => Promise<AtomicTargetSelection>;
  dependencies?: AtomicWriteDependencies;
}>;

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const safePathError = (): AppError => new AppError('SAFE_PATH', APP_ERROR_MESSAGES.SAFE_PATH);

const isContainedPath = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
};

const sameWindowsPath = (left: string, right: string): boolean =>
  resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US');

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

export const assertManagedDirectory = async (
  connection: VaultConnection,
  directory: string,
): Promise<void> => {
  const resolvedDirectory = resolve(directory);
  if (!isContainedPath(connection.managedRoot, resolvedDirectory)) {
    throw safePathError();
  }

  assertNoReparsePoints(connection.managedRoot);
  assertNoReparsePoints(resolvedDirectory);
  const stats = await lstat(resolvedDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw safePathError();
  }

  const [currentRoot, currentDirectory] = await Promise.all([
    realpath(connection.managedRoot),
    realpath(resolvedDirectory),
  ]);
  if (
    !sameWindowsPath(currentRoot, connection.realManagedRoot) ||
    !isContainedPath(connection.realManagedRoot, currentDirectory)
  ) {
    throw safePathError();
  }
};

export const ensureManagedParentDirectories = async (
  connection: VaultConnection,
  targetPath: string,
): Promise<void> => {
  const targetParent = dirname(targetPath);
  if (!isContainedPath(connection.managedRoot, targetParent)) {
    throw safePathError();
  }

  const relativeParent = relative(connection.managedRoot, targetParent);
  let current = connection.managedRoot;
  await assertManagedDirectory(connection, current);
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    const next = join(current, segment);
    if (!(await pathExists(next))) {
      await assertManagedDirectory(connection, current);
      try {
        await mkdir(next);
      } catch (error) {
        if (!(await pathExists(next))) {
          throw error;
        }
      }
    }
    await assertManagedDirectory(connection, next);
    current = next;
  }
};

const guardMutation = async (connection: VaultConnection, path: string): Promise<void> => {
  await assertManagedDirectory(connection, dirname(path));
  assertNoReparsePoints(path);
};

const timestampToken = (date: Date): string => {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
};

const withRecoveryTokens = (
  error: unknown,
  recoveryToken?: string,
  backupRecoveryToken?: string,
): AppError => {
  const recoveryOptions = {
    ...(recoveryToken === undefined ? {} : { recoveryToken }),
    ...(backupRecoveryToken === undefined ? {} : { backupRecoveryToken }),
  };
  if (AppError.isTrusted(error)) {
    return new AppError(error.code, error.displayMessage, recoveryOptions);
  }
  return new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED, recoveryOptions);
};

const runMutationHook = async (
  dependencies: AtomicWriteDependencies,
  kind: AtomicMutationKind,
  targetPath: string,
): Promise<void> => {
  await dependencies.beforeMutation?.(Object.freeze({ kind, targetPath }));
};

export const atomicReplace = async <T>(
  input: AtomicReplaceInput<T>,
): Promise<AtomicReplaceResult<T>> => {
  const dependencies = input.dependencies ?? {};
  const id = (dependencies.idGenerator ?? randomUUID)();
  const now = (dependencies.clock ?? (() => new Date()))();
  const parent = dirname(input.targetPath);
  const tempToken = `.studyapp-${id}.tmp`;
  const backupToken = `.studyapp-backup-${timestampToken(now)}-${id}.bak`;
  const tempPath = join(parent, tempToken);
  const backupPath = join(parent, backupToken);
  let tempCreated = false;
  let backupCreated = false;
  let handle: FileHandle | undefined;
  let value: T;
  let finalTargetPath = input.targetPath;
  let replaceExisting = input.replaceExisting;
  let temporaryRecoveryToken: string | null = null;
  const publishTempWithoutClobber = async (): Promise<void> => {
    await link(tempPath, finalTargetPath);
    try {
      await unlink(tempPath);
    } catch {
      temporaryRecoveryToken = tempToken;
    }
    tempCreated = false;
  };
  const refreshSelection = async (): Promise<boolean> => {
    const selection = await input.selectTarget?.();
    if (selection === undefined) {
      return false;
    }
    if (!sameWindowsPath(dirname(selection.targetPath), parent)) {
      throw safePathError();
    }
    const changed =
      !sameWindowsPath(selection.targetPath, finalTargetPath) ||
      selection.replaceExisting !== replaceExisting;
    finalTargetPath = selection.targetPath;
    replaceExisting = selection.replaceExisting;
    return changed;
  };

  await ensureManagedParentDirectories(input.connection, input.targetPath);
  try {
    await runMutationHook(dependencies, 'open-temp', input.targetPath);
    await guardMutation(input.connection, tempPath);
    handle = await open(tempPath, 'wx', 0o600);
    tempCreated = true;
    value = await input.write(handle);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await refreshSelection();
    let targetSelectionAttempts = 0;
    while (!backupCreated && tempCreated) {
      targetSelectionAttempts += 1;
      if (targetSelectionAttempts > 8) {
        throw new TypeError('ATOMIC_TARGET_DID_NOT_STABILIZE');
      }

      const targetExists = await pathExists(finalTargetPath);
      if (targetExists) {
        if (!replaceExisting) {
          if (await refreshSelection()) {
            continue;
          }
          throw new TypeError('ATOMIC_TARGET_EXISTS');
        }

        await runMutationHook(dependencies, 'rename-target-to-backup', finalTargetPath);
        await guardMutation(input.connection, finalTargetPath);
        await guardMutation(input.connection, backupPath);
        if (await refreshSelection()) {
          continue;
        }
        await rename(finalTargetPath, backupPath);
        backupCreated = true;
        break;
      }

      await runMutationHook(dependencies, 'rename-temp-to-target', finalTargetPath);
      await guardMutation(input.connection, tempPath);
      await guardMutation(input.connection, finalTargetPath);
      if (await refreshSelection()) {
        continue;
      }
      await publishTempWithoutClobber();
    }

    if (backupCreated) {
      await runMutationHook(dependencies, 'rename-temp-to-target', finalTargetPath);
      await guardMutation(input.connection, tempPath);
      await guardMutation(input.connection, finalTargetPath);
      await publishTempWithoutClobber();
    }
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // The original fixed public error is more useful; the temp token enables recovery.
    }
    if (backupCreated && !(await pathExists(finalTargetPath))) {
      try {
        await runMutationHook(dependencies, 'restore-backup', finalTargetPath);
        await guardMutation(input.connection, backupPath);
        await guardMutation(input.connection, finalTargetPath);
        await rename(backupPath, finalTargetPath);
        backupCreated = false;
      } catch {
        // Keep both recovery files in the managed directory for diagnostics.
      }
    }
    throw withRecoveryTokens(
      error,
      tempCreated ? tempToken : undefined,
      backupCreated ? backupToken : undefined,
    );
  }

  let backupRecoveryToken: string | null = null;
  if (backupCreated) {
    try {
      await assertManagedDirectory(input.connection, parent);
      await unlink(backupPath);
    } catch {
      backupRecoveryToken = basename(backupPath);
    }
  }

  return Object.freeze({
    value,
    targetPath: finalTargetPath,
    temporaryRecoveryToken,
    backupRecoveryToken,
  });
};
