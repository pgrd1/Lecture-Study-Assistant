import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { chmod, lstat, open } from 'node:fs/promises';
import { dirname, extname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { assertNoReparsePoints } from '../../core/paths/safePath';
import {
  type SecretKey,
  SecretKeySchema,
  type SecretStore,
  type SecretStoreOperation,
} from '../../core/ports/secretStore';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';
import { atomicReplace } from '../filesystem/atomicWrite';
import { createSafeRootConnection } from '../queue/queueLayout';

const SECRET_FILE_VERSION = 1;
const MAX_SECRET_FILE_BYTES = 256 * 1024;
const MAX_SECRET_LENGTH = 8 * 1024;

const SecretFilePathSchema = z
  .string()
  .min(1)
  .max(32_767)
  .refine((value) => isAbsolute(value) && !value.includes('\0') && extname(value) === '.json');

const SecretValueSchema = z
  .string()
  .min(1)
  .max(MAX_SECRET_LENGTH)
  .refine((value) => value === value.trim() && !value.includes('\0'));

const CiphertextSchema = z.base64().min(1).max(MAX_SECRET_FILE_BYTES);

const SecretDocumentSchema = z
  .strictObject({
    version: z.literal(SECRET_FILE_VERSION),
    secrets: z.partialRecord(SecretKeySchema, CiphertextSchema),
  })
  .readonly();

type SecretDocument = z.infer<typeof SecretDocumentSchema>;

export interface Encryptor {
  isEncryptionAvailable(): Promise<boolean>;
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<string>;
}

export type ElectronSafeStorageFacade = Readonly<{
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plaintext: string): Promise<Buffer>;
  decryptStringAsync(
    ciphertext: Buffer,
  ): Promise<Readonly<{ result: string; shouldReEncrypt: boolean }>>;
}>;

const emptyDocument = (): SecretDocument =>
  SecretDocumentSchema.parse({ version: SECRET_FILE_VERSION, secrets: {} });

const secureStorageUnavailable = (): AppError =>
  new AppError('SECURE_STORAGE_UNAVAILABLE', APP_ERROR_MESSAGES.SECURE_STORAGE_UNAVAILABLE);

const secretStorageFailed = (): AppError =>
  new AppError('SECRET_STORAGE_FAILED', APP_ERROR_MESSAGES.SECRET_STORAGE_FAILED);

const providerCancelled = (): AppError =>
  new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED);

const normalizeSecretError = (error: unknown): AppError =>
  AppError.isTrusted(error) &&
  (error.code === 'SECURE_STORAGE_UNAVAILABLE' ||
    error.code === 'SECRET_STORAGE_FAILED' ||
    error.code === 'PROVIDER_CANCELLED')
    ? error
    : secretStorageFailed();

const assertActive = (operation: SecretStoreOperation): void => {
  if (
    operation === null ||
    typeof operation !== 'object' ||
    typeof operation.requestId !== 'string' ||
    !z.uuid().safeParse(operation.requestId).success ||
    !(operation.signal instanceof AbortSignal)
  ) {
    throw secretStorageFailed();
  }
  if (operation.signal.aborted) {
    throw providerCancelled();
  }
};

const withCheckpoint = async <T>(
  operation: SecretStoreOperation,
  action: () => Promise<T>,
): Promise<T> => {
  assertActive(operation);
  let value: T;
  try {
    value = await action();
  } catch (error) {
    assertActive(operation);
    throw error;
  }
  assertActive(operation);
  return value;
};

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const sameFileSnapshot = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const readBounded = async (
  filePath: string,
  operation: SecretStoreOperation,
): Promise<Buffer | null> => {
  let handle: FileHandle | undefined;
  try {
    assertNoReparsePoints(filePath);
    const pathStats = await withCheckpoint(operation, () => lstat(filePath));
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      pathStats.size > MAX_SECRET_FILE_BYTES
    ) {
      throw secretStorageFailed();
    }
    const openedHandle = await withCheckpoint(operation, () => open(filePath, 'r'));
    handle = openedHandle;
    const before = await withCheckpoint(operation, () => openedHandle.stat());
    if (!before.isFile() || !sameFileSnapshot(pathStats, before)) {
      throw secretStorageFailed();
    }
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const result = await withCheckpoint(operation, () =>
        openedHandle.read(bytes, total, bytes.length - total, total),
      );
      if (result.bytesRead === 0) {
        break;
      }
      total += result.bytesRead;
      if (total > MAX_SECRET_FILE_BYTES) {
        throw secretStorageFailed();
      }
    }
    const after = await withCheckpoint(operation, () => openedHandle.stat());
    assertNoReparsePoints(filePath);
    const current = await withCheckpoint(operation, () => lstat(filePath));
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, current)) {
      throw secretStorageFailed();
    }
    return bytes.subarray(0, total);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  } finally {
    await handle?.close();
  }
};

export const createElectronSafeStorageEncryptor = (
  safeStorage: ElectronSafeStorageFacade,
): Encryptor =>
  Object.freeze({
    isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (plaintext: string) => safeStorage.encryptStringAsync(plaintext),
    decrypt: async (ciphertext: Buffer) =>
      (await safeStorage.decryptStringAsync(ciphertext)).result,
  });

export class ElectronSecretStore implements SecretStore {
  readonly #encryptor: Encryptor;
  readonly #filePath: string;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(filePath: string, encryptor: Encryptor) {
    const parsedPath = SecretFilePathSchema.safeParse(filePath);
    if (!parsedPath.success) {
      throw secretStorageFailed();
    }
    this.#filePath = parsedPath.data;
    this.#encryptor = encryptor;
  }

  set(key: SecretKey, value: string, operation: SecretStoreOperation): Promise<void> {
    return this.#runExclusive(operation, async () => {
      try {
        const parsedKey = SecretKeySchema.parse(key);
        const parsedValue = SecretValueSchema.parse(value);
        await this.#assertEncryptionAvailable(operation);
        const ciphertext = await withCheckpoint(operation, () =>
          this.#encryptor.encrypt(parsedValue),
        );
        if (ciphertext.length === 0 || ciphertext.length > MAX_SECRET_FILE_BYTES) {
          throw secretStorageFailed();
        }
        const current = await this.#readDocument(operation);
        await this.#writeDocument(
          {
            version: SECRET_FILE_VERSION,
            secrets: {
              ...current.secrets,
              [parsedKey]: ciphertext.toString('base64'),
            },
          },
          operation,
        );
      } catch (error) {
        throw normalizeSecretError(error);
      }
    });
  }

  get(key: SecretKey, operation: SecretStoreOperation): Promise<string | undefined> {
    return this.#runExclusive(operation, async () => {
      try {
        const parsedKey = SecretKeySchema.parse(key);
        await this.#assertEncryptionAvailable(operation);
        const document = await this.#readDocument(operation);
        const encoded = document.secrets[parsedKey];
        if (encoded === undefined) {
          return undefined;
        }
        const plaintext = await withCheckpoint(operation, () =>
          this.#encryptor.decrypt(Buffer.from(encoded, 'base64')),
        );
        return SecretValueSchema.parse(plaintext);
      } catch (error) {
        throw normalizeSecretError(error);
      }
    });
  }

  delete(key: SecretKey, operation: SecretStoreOperation): Promise<void> {
    return this.#runExclusive(operation, async () => {
      try {
        const parsedKey = SecretKeySchema.parse(key);
        const current = await this.#readDocument(operation);
        if (current.secrets[parsedKey] === undefined) {
          return;
        }
        const nextSecrets = Object.fromEntries(
          Object.entries(current.secrets).filter(([candidate]) => candidate !== parsedKey),
        );
        await this.#writeDocument(
          { version: SECRET_FILE_VERSION, secrets: nextSecrets },
          operation,
        );
      } catch (error) {
        throw normalizeSecretError(error);
      }
    });
  }

  has(key: SecretKey, operation: SecretStoreOperation): Promise<boolean> {
    return this.#runExclusive(operation, async () => {
      try {
        const parsedKey = SecretKeySchema.parse(key);
        return (await this.#readDocument(operation)).secrets[parsedKey] !== undefined;
      } catch (error) {
        throw normalizeSecretError(error);
      }
    });
  }

  async #assertEncryptionAvailable(operation: SecretStoreOperation): Promise<void> {
    if (!(await withCheckpoint(operation, () => this.#encryptor.isEncryptionAvailable()))) {
      throw secureStorageUnavailable();
    }
  }

  async #readDocument(operation: SecretStoreOperation): Promise<SecretDocument> {
    await withCheckpoint(operation, () => createSafeRootConnection(dirname(this.#filePath)));
    const bytes = await readBounded(this.#filePath, operation);
    if (bytes === null) {
      return emptyDocument();
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return SecretDocumentSchema.parse(JSON.parse(text));
  }

  async #writeDocument(value: unknown, operation: SecretStoreOperation): Promise<void> {
    const document = SecretDocumentSchema.parse(value);
    const content = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(content, 'utf8') > MAX_SECRET_FILE_BYTES) {
      throw secretStorageFailed();
    }
    const connection = await withCheckpoint(operation, () =>
      createSafeRootConnection(dirname(this.#filePath)),
    );
    // This is the atomic commit boundary. Once crossed, replacement and permission hardening
    // complete without consulting the caller's cancellation signal.
    assertActive(operation);
    await atomicReplace({
      connection,
      targetPath: this.#filePath,
      replaceExisting: true,
      write: async (handle) => {
        await handle.writeFile(content, 'utf8');
        return undefined;
      },
    });
    await chmod(this.#filePath, 0o600);
  }

  #runExclusive<T>(descriptor: SecretStoreOperation, operation: () => Promise<T>): Promise<T> {
    try {
      assertActive(descriptor);
    } catch (error) {
      return Promise.reject(normalizeSecretError(error));
    }
    const guarded = async (): Promise<T> => {
      assertActive(descriptor);
      return operation();
    };
    const result = this.#operationTail.then(guarded, guarded);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
