import type { StatementResultingChanges } from 'node:sqlite';
import { z } from 'zod';
import { APP_ERROR_MESSAGES, AppError, type AppErrorCode } from '../../shared/errors';

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CONSTRAINT_UNIQUE = 2_067;

const SqliteErrorSchema = z
  .object({
    code: z.literal('ERR_SQLITE_ERROR'),
    errcode: z.int(),
  })
  .passthrough();

const repositoryError = (code: AppErrorCode): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);

export const translateSqliteError = (
  error: unknown,
  duplicateCode?: Extract<AppErrorCode, 'DUPLICATE_COURSE' | 'DUPLICATE_JOB'>,
): never => {
  if (AppError.isTrusted(error)) {
    throw error;
  }

  const parsed = SqliteErrorSchema.safeParse(error);
  if (parsed.success) {
    const primaryCode = parsed.data.errcode & 0xff;
    if (primaryCode === SQLITE_BUSY || primaryCode === SQLITE_LOCKED) {
      throw repositoryError('DATABASE_BUSY');
    }
    if (parsed.data.errcode === SQLITE_CONSTRAINT_UNIQUE && duplicateCode !== undefined) {
      throw repositoryError(duplicateCode);
    }
  }

  throw repositoryError('DATABASE_ERROR');
};

export const parseDatabaseEntity = <T>(parser: () => T): T => {
  try {
    return parser();
  } catch (error) {
    return translateSqliteError(error);
  }
};

export const assertNextRevision = (nextRevision: number, expectedRevision: number): void => {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    nextRevision !== expectedRevision + 1
  ) {
    throw repositoryError('STALE_WRITE');
  }
};

export const assertSingleChange = (result: StatementResultingChanges): void => {
  if (result.changes !== 1 && result.changes !== 1n) {
    throw repositoryError('STALE_WRITE');
  }
};
