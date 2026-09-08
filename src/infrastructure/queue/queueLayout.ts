import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { assertNoReparsePoints, resolveManagedPath } from '../../core/paths/safePath';
import type { VaultConnection } from '../../core/ports/vault';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';
import { ensureManagedParentDirectories } from '../filesystem/atomicWrite';

export const QUEUE_DIRECTORIES = Object.freeze([
  'Catalog',
  'Inbox',
  'CourseInbox',
  'Status',
  'Rejected',
] as const);

const ManagedRootSchema = z
  .string()
  .min(1)
  .max(32_767)
  .refine((value) => isAbsolute(value) && !value.includes('\0'));

export const createSafeRootConnection = async (value: string): Promise<VaultConnection> => {
  const root = resolve(ManagedRootSchema.parse(value));
  assertNoReparsePoints(root);
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError('MANAGED_ROOT_NOT_DIRECTORY');
  }
  const realRoot = await realpath(root);
  if (resolve(realRoot).toLocaleLowerCase('en-US') !== root.toLocaleLowerCase('en-US')) {
    throw new TypeError('MANAGED_ROOT_REDIRECTED');
  }
  return Object.freeze({ vaultRoot: root, managedRoot: root, realManagedRoot: realRoot });
};

export const connectQueueRoot = async (value: string): Promise<VaultConnection> => {
  try {
    return await createSafeRootConnection(value);
  } catch (error) {
    if (AppError.isTrusted(error) && error.code === 'SAFE_PATH') {
      throw error;
    }
    throw new AppError('QUEUE_CONNECTION_FAILED', APP_ERROR_MESSAGES.QUEUE_CONNECTION_FAILED);
  }
};

export const ensureQueueLayout = async (connection: VaultConnection): Promise<void> => {
  for (const directory of QUEUE_DIRECTORIES) {
    const placeholder = resolveManagedPath(connection.managedRoot, directory, '.studyapp-layout');
    await ensureManagedParentDirectories(connection, placeholder);
  }
};

export const queuePath = (connection: VaultConnection, ...segments: readonly string[]): string =>
  resolveManagedPath(connection.managedRoot, ...segments);

export const toQueueWriteError = (error: unknown): AppError => {
  if (AppError.isTrusted(error) && error.code === 'SAFE_PATH') {
    return error;
  }
  return new AppError('QUEUE_WRITE_FAILED', APP_ERROR_MESSAGES.QUEUE_WRITE_FAILED, {
    ...(AppError.isTrusted(error) && error.recoveryToken !== undefined
      ? { recoveryToken: error.recoveryToken }
      : {}),
    ...(AppError.isTrusted(error) && error.backupRecoveryToken !== undefined
      ? { backupRecoveryToken: error.backupRecoveryToken }
      : {}),
  });
};
