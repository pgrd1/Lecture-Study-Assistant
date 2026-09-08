import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { assertNoReparsePoints, resolveManagedPath } from '../../core/paths/safePath';
import type { VaultConnectInput, VaultConnection, VaultServicePort } from '../../core/ports/vault';
import { APP_METADATA } from '../../shared/appMetadata';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';
import { VaultWriter } from './vaultWriter';

const MAIN_NOTE = '메인 학습 노트.md';
const MAIN_NOTE_CONTENT = `# 메인 학습 노트

이 노트는 Lecture Study Assistant가 관리하는 과목 색인입니다.

<!-- studyapp:courses:start -->
<!-- studyapp:courses:end -->
`;

const VaultConnectInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(32_767)
    .refine((value) => isAbsolute(value) && !value.includes('\0')),
  mode: z.enum(['existing', 'create']),
});

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const connectionError = (): AppError =>
  new AppError('VAULT_CONNECTION_FAILED', APP_ERROR_MESSAGES.VAULT_CONNECTION_FAILED);

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

const assertDirectory = async (path: string): Promise<void> => {
  assertNoReparsePoints(path);
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw connectionError();
  }
};

const createVaultRoot = async (vaultRoot: string): Promise<void> => {
  const parent = dirname(vaultRoot);
  if (resolve(parent) === resolve(vaultRoot)) {
    throw connectionError();
  }
  assertNoReparsePoints(parent);
  await assertDirectory(parent);
  await mkdir(vaultRoot);
  await assertDirectory(vaultRoot);
};

const ensureNewVault = async (vaultRoot: string): Promise<void> => {
  if (await pathExists(vaultRoot)) {
    await assertDirectory(vaultRoot);
    if ((await readdir(vaultRoot)).length > 0) {
      throw connectionError();
    }
  } else {
    await createVaultRoot(vaultRoot);
  }

  assertNoReparsePoints(vaultRoot);
  await mkdir(resolveManagedPath(vaultRoot, '.obsidian'));
};

const assertExistingVault = async (vaultRoot: string): Promise<void> => {
  await assertDirectory(vaultRoot);
  await assertDirectory(resolveManagedPath(vaultRoot, '.obsidian'));
};

const ensureManagedRoot = async (vaultRoot: string): Promise<string> => {
  const managedRoot = resolveManagedPath(vaultRoot, APP_METADATA.managedVaultRoot);
  if (!(await pathExists(managedRoot))) {
    assertNoReparsePoints(vaultRoot);
    await mkdir(managedRoot);
  }
  await assertDirectory(managedRoot);
  return managedRoot;
};

const ensureMainNote = async (connection: VaultConnection): Promise<void> => {
  const mainNotePath = resolveManagedPath(connection.managedRoot, MAIN_NOTE);
  if (await pathExists(mainNotePath)) {
    assertNoReparsePoints(mainNotePath);
    const stats = await lstat(mainNotePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw connectionError();
    }
    return;
  }
  await new VaultWriter(connection).writeMarkdown({
    relativePath: MAIN_NOTE,
    content: MAIN_NOTE_CONTENT,
  });
};

export class VaultService implements VaultServicePort {
  async connect(input: VaultConnectInput): Promise<VaultConnection> {
    try {
      const parsed = VaultConnectInputSchema.parse(input);
      const vaultRoot = resolve(parsed.path);
      assertNoReparsePoints(vaultRoot);
      if (parsed.mode === 'create') {
        await ensureNewVault(vaultRoot);
      } else {
        await assertExistingVault(vaultRoot);
      }

      const managedRoot = await ensureManagedRoot(vaultRoot);
      const connection = Object.freeze({
        vaultRoot,
        managedRoot,
        realManagedRoot: await realpath(managedRoot),
      });
      await ensureMainNote(connection);
      return connection;
    } catch (error) {
      if (AppError.isTrusted(error) && error.code === 'SAFE_PATH') {
        throw error;
      }
      throw connectionError();
    }
  }
}
