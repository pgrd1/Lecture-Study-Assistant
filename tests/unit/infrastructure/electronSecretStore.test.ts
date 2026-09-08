import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const atomicTestHooks = vi.hoisted(() => ({
  beforeActual: undefined as (() => void) | undefined,
  afterActual: undefined as (() => void) | undefined,
}));

vi.mock('../../../src/infrastructure/filesystem/atomicWrite', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/infrastructure/filesystem/atomicWrite')>();
  return {
    ...actual,
    atomicReplace: async (options: Parameters<typeof actual.atomicReplace>[0]) => {
      atomicTestHooks.beforeActual?.();
      const result = await actual.atomicReplace(options);
      atomicTestHooks.afterActual?.();
      return result;
    },
  };
});

import {
  createElectronSafeStorageEncryptor,
  ElectronSecretStore,
  type Encryptor,
} from '../../../src/infrastructure/secrets/electronSecretStore';
import { withTempDirectory } from '../../testkit/tempDirectory';

const reverse = (value: string): string => [...value].reverse().join('');

const operation = (signal = new AbortController().signal) =>
  Object.freeze({ requestId: randomUUID(), signal });

const reversibleEncryptor = (available = true): Encryptor =>
  Object.freeze({
    isEncryptionAvailable: async () => available,
    encrypt: async (plaintext: string) => Buffer.from(`protected:${reverse(plaintext)}`, 'utf8'),
    decrypt: async (ciphertext: Buffer) => {
      const encoded = ciphertext.toString('utf8');
      if (!encoded.startsWith('protected:')) {
        throw new TypeError('INVALID_TEST_CIPHERTEXT');
      }
      return reverse(encoded.slice('protected:'.length));
    },
  });

afterEach(() => {
  atomicTestHooks.beforeActual = undefined;
  atomicTestHooks.afterActual = undefined;
});

describe('ElectronSecretStore', () => {
  it('stores only ciphertext and round-trips each supported provider key', async () => {
    await withTempDirectory(async (directory) => {
      const filePath = join(directory, 'secrets.json');
      const store = new ElectronSecretStore(filePath, reversibleEncryptor());
      const values = {
        openai_api_key: 'openai-secret-value-123',
        gemini_api_key: 'gemini-secret-value-456',
        anthropic_api_key: 'anthropic-secret-value-789',
      } as const;

      await store.set('openai_api_key', values.openai_api_key, operation());
      await store.set('gemini_api_key', values.gemini_api_key, operation());
      await store.set('anthropic_api_key', values.anthropic_api_key, operation());

      const raw = await readFile(filePath, 'utf8');
      for (const value of Object.values(values)) {
        expect(raw).not.toContain(value);
      }
      expect(JSON.parse(raw)).toMatchObject({
        version: 1,
        secrets: {
          openai_api_key: expect.any(String),
          gemini_api_key: expect.any(String),
          anthropic_api_key: expect.any(String),
        },
      });
      await expect(store.get('openai_api_key', operation())).resolves.toBe(values.openai_api_key);
      await expect(store.get('gemini_api_key', operation())).resolves.toBe(values.gemini_api_key);
      await expect(store.get('anthropic_api_key', operation())).resolves.toBe(
        values.anthropic_api_key,
      );
      await expect(store.has('gemini_api_key', operation())).resolves.toBe(true);

      await store.delete('gemini_api_key', operation());
      await expect(store.get('gemini_api_key', operation())).resolves.toBeUndefined();
      await expect(store.has('gemini_api_key', operation())).resolves.toBe(false);
      await store.delete('gemini_api_key', operation());
    });
  });

  it('refuses plaintext fallback when OS encryption is unavailable', async () => {
    await withTempDirectory(async (directory) => {
      const filePath = join(directory, 'secrets.json');
      const store = new ElectronSecretStore(filePath, reversibleEncryptor(false));

      await expect(
        store.set('openai_api_key', 'must-never-be-written', operation()),
      ).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' });
      await expect(access(filePath)).rejects.toBeDefined();
    });
  });

  it('maps corrupt secret files and invalid input to fixed public errors', async () => {
    await withTempDirectory(async (directory) => {
      const filePath = join(directory, 'secrets.json');
      const store = new ElectronSecretStore(filePath, reversibleEncryptor());

      await expect(store.set('openai_api_key', ' whitespace ', operation())).rejects.toMatchObject({
        code: 'SECRET_STORAGE_FAILED',
      });
      await writeFile(
        filePath,
        JSON.stringify({ version: 1, secrets: { openai_api_key: 'not base64!' } }),
        'utf8',
      );
      await expect(store.get('openai_api_key', operation())).rejects.toMatchObject({
        code: 'SECRET_STORAGE_FAILED',
        displayMessage: 'API 키 보안 저장소를 읽거나 쓰지 못했습니다.',
      });
    });
  });

  it('serializes concurrent provider updates without losing ciphertext entries', async () => {
    await withTempDirectory(async (directory) => {
      const store = new ElectronSecretStore(join(directory, 'secrets.json'), reversibleEncryptor());

      await Promise.all([
        store.set('openai_api_key', 'openai-concurrent-key', operation()),
        store.set('gemini_api_key', 'gemini-concurrent-key', operation()),
        store.set('anthropic_api_key', 'anthropic-concurrent-key', operation()),
      ]);

      await expect(store.get('openai_api_key', operation())).resolves.toBe('openai-concurrent-key');
      await expect(store.get('gemini_api_key', operation())).resolves.toBe('gemini-concurrent-key');
      await expect(store.get('anthropic_api_key', operation())).resolves.toBe(
        'anthropic-concurrent-key',
      );
    });
  });

  it('rejects pre-aborted and queued operations before encryption or mutation', async () => {
    await withTempDirectory(async (directory) => {
      let releaseFirst!: () => void;
      const firstEncryption = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let encryptionCalls = 0;
      const encryptor: Encryptor = Object.freeze({
        isEncryptionAvailable: async () => true,
        encrypt: async (plaintext: string) => {
          encryptionCalls += 1;
          if (encryptionCalls === 1) await firstEncryption;
          return Buffer.from(`protected:${reverse(plaintext)}`, 'utf8');
        },
        decrypt: reversibleEncryptor().decrypt,
      });
      const filePath = join(directory, 'secrets.json');
      const store = new ElectronSecretStore(filePath, encryptor);
      const firstController = new AbortController();
      const first = store.set('openai_api_key', 'first-secret', operation(firstController.signal));
      await vi.waitFor(() => expect(encryptionCalls).toBe(1));

      const queuedController = new AbortController();
      const queued = store.set(
        'gemini_api_key',
        'queued-secret',
        operation(queuedController.signal),
      );
      queuedController.abort();
      releaseFirst();

      await expect(first).resolves.toBeUndefined();
      await expect(queued).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(encryptionCalls).toBe(1);
      const raw = await readFile(filePath, 'utf8');
      expect(raw).not.toContain('queued-secret');

      const preAbortedController = new AbortController();
      preAbortedController.abort();
      await expect(
        store.set(
          'anthropic_api_key',
          'pre-aborted-secret',
          operation(preAbortedController.signal),
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(encryptionCalls).toBe(1);
    });
  });

  it('cancels deferred encryption before the atomic write boundary', async () => {
    await withTempDirectory(async (directory) => {
      let releaseEncryption!: () => void;
      const encryption = new Promise<void>((resolve) => {
        releaseEncryption = resolve;
      });
      const encryptor: Encryptor = Object.freeze({
        isEncryptionAvailable: async () => true,
        encrypt: async (plaintext: string) => {
          await encryption;
          return Buffer.from(`protected:${reverse(plaintext)}`, 'utf8');
        },
        decrypt: reversibleEncryptor().decrypt,
      });
      const filePath = join(directory, 'secrets.json');
      const store = new ElectronSecretStore(filePath, encryptor);
      const controller = new AbortController();
      const pending = store.set(
        'openai_api_key',
        'never-committed-secret',
        operation(controller.signal),
      );

      controller.abort();
      releaseEncryption();

      await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      await expect(access(filePath)).rejects.toBeDefined();
    });
  });

  it('prioritizes cancellation over a concurrent private encryption failure', async () => {
    await withTempDirectory(async (directory) => {
      let releaseEncryption!: () => void;
      const encryption = new Promise<void>((resolve) => {
        releaseEncryption = resolve;
      });
      let encryptionStarted = false;
      const privateDetail = 'private-encryptor-failure';
      const encryptor: Encryptor = Object.freeze({
        isEncryptionAvailable: async () => true,
        encrypt: async () => {
          encryptionStarted = true;
          await encryption;
          throw new Error(privateDetail);
        },
        decrypt: reversibleEncryptor().decrypt,
      });
      const filePath = join(directory, 'secrets.json');
      const store = new ElectronSecretStore(filePath, encryptor);
      const controller = new AbortController();
      const pending = store.set(
        'openai_api_key',
        'never-committed-secret',
        operation(controller.signal),
      );
      await vi.waitFor(() => expect(encryptionStarted).toBe(true));

      controller.abort();
      releaseEncryption();

      const failure = await pending.catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(privateDetail);
      await expect(access(filePath)).rejects.toBeDefined();
    });
  });

  it('cancels a deferred secret read without returning or exposing plaintext', async () => {
    await withTempDirectory(async (directory) => {
      const filePath = join(directory, 'secrets.json');
      const writer = new ElectronSecretStore(filePath, reversibleEncryptor());
      await writer.set('openai_api_key', 'deferred-private-value', operation());

      let releaseDecrypt!: () => void;
      const decryptGate = new Promise<void>((resolve) => {
        releaseDecrypt = resolve;
      });
      let decryptCalls = 0;
      const reader = new ElectronSecretStore(
        filePath,
        Object.freeze({
          ...reversibleEncryptor(),
          decrypt: async (ciphertext: Buffer) => {
            decryptCalls += 1;
            await decryptGate;
            return reversibleEncryptor().decrypt(ciphertext);
          },
        }),
      );
      const controller = new AbortController();
      const pending = reader.get('openai_api_key', operation(controller.signal));
      await vi.waitFor(() => expect(decryptCalls).toBe(1));

      controller.abort();
      releaseDecrypt();

      const failure = await pending.catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(
        'deferred-private-value',
      );
    });
  });

  it('finishes an atomic replacement after cancellation crosses the commit boundary', async () => {
    await withTempDirectory(async (directory) => {
      const filePath = join(directory, 'secrets.json');
      const store = new ElectronSecretStore(filePath, reversibleEncryptor());
      const controller = new AbortController();
      atomicTestHooks.beforeActual = () => controller.abort();

      await expect(
        store.set('openai_api_key', 'committed-private-value', operation(controller.signal)),
      ).resolves.toBeUndefined();

      const raw = await readFile(filePath, 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(raw).not.toContain('committed-private-value');
      await expect(store.get('openai_api_key', operation())).resolves.toBe(
        'committed-private-value',
      );
    });
  });

  it('finishes an atomic deletion after cancellation crosses the commit boundary', async () => {
    await withTempDirectory(async (directory) => {
      const filePath = join(directory, 'secrets.json');
      const store = new ElectronSecretStore(filePath, reversibleEncryptor());
      await store.set('openai_api_key', 'delete-boundary-private-value', operation());
      const controller = new AbortController();
      atomicTestHooks.beforeActual = () => controller.abort();

      await expect(
        store.delete('openai_api_key', operation(controller.signal)),
      ).resolves.toBeUndefined();

      const raw = await readFile(filePath, 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(raw).not.toContain('delete-boundary-private-value');
      await expect(store.get('openai_api_key', operation())).resolves.toBeUndefined();
    });
  });

  it('normalizes a post-boundary replacement failure without leaking plaintext or partial JSON', async () => {
    await withTempDirectory(async (directory) => {
      const filePath = join(directory, 'secrets.json');
      const store = new ElectronSecretStore(filePath, reversibleEncryptor());
      const privateValue = 'post-boundary-private-value';
      atomicTestHooks.afterActual = () => {
        throw new Error(`private atomic detail: ${privateValue}`);
      };

      const failure = await store
        .set('openai_api_key', privateValue, operation())
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'SECRET_STORAGE_FAILED' });
      expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(privateValue);
      const raw = await readFile(filePath, 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(raw).not.toContain(privateValue);
      atomicTestHooks.afterActual = undefined;
      await expect(store.get('openai_api_key', operation())).resolves.toBe(privateValue);
    });
  });

  it('adapts Electron asynchronous safeStorage without exposing its facade', async () => {
    const safeStorage = {
      isAsyncEncryptionAvailable: vi.fn(async () => true),
      encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
      decryptStringAsync: vi.fn(async (value: Buffer) => ({
        result: value.toString('utf8'),
        shouldReEncrypt: false,
      })),
    };
    const encryptor = createElectronSafeStorageEncryptor(safeStorage);

    await expect(encryptor.isEncryptionAvailable()).resolves.toBe(true);
    const ciphertext = await encryptor.encrypt('provider-key');
    await expect(encryptor.decrypt(ciphertext)).resolves.toBe('provider-key');
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith('provider-key');
  });
});
