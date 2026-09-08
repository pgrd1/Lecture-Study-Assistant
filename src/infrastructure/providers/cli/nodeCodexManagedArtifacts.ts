import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import { assertProviderConnectionActive, unsafeVersion } from './cliFileIntegrity';
import type { CodexImageManifest } from './codexCliMedia';
import {
  assertCodexArtifacts,
  assertCodexRoots,
  CODEX_UUID_PATTERN,
  type CodexManagedProfile,
  codexError,
  createCodexManagedProfile,
} from './codexCliProtocol';
import type { CodexManagedArtifacts } from './codexManagedArtifacts';
import type { ManagedArtifactOptions } from './nodeCliManagedFileSystem';
import {
  createNodeCliManagedFileSystem,
  createNodeCliManagedFileSystemForTest,
  type NodeCliManagedFileSystemOperations,
} from './nodeCliManagedFileSystem';

export type { ManagedArtifactOptions };

const sha256 = (contents: string): string => createHash('sha256').update(contents).digest('hex');

const assertRequestContext = (id: string, operation: ProviderConnectionOperation): void => {
  assertProviderConnectionActive(operation);
  if (!CODEX_UUID_PATTERN.test(id) || operation.requestId !== id) throw unsafeVersion();
};

const assertSchemaJson = (schemaJson: string): string => {
  if (typeof schemaJson !== 'string') throw unsafeVersion();
  return schemaJson;
};

const assertCleanupRequestId = (id: string): string => {
  if (typeof id !== 'string' || !CODEX_UUID_PATTERN.test(id)) {
    throw codexError('PROVIDER_RESIDUAL_DATA');
  }
  return id;
};

const assertProfile = (
  options: ManagedArtifactOptions,
  profile: CodexManagedProfile,
): CodexManagedProfile => {
  try {
    const expected = createCodexManagedProfile(assertCodexRoots(options.providerRuntimeRoot));
    if (
      profile === null ||
      typeof profile !== 'object' ||
      Object.getPrototypeOf(profile) !== Object.prototype ||
      Reflect.ownKeys(profile).length !== 2
    ) {
      throw unsafeVersion();
    }
    const managedProfilePath = Object.getOwnPropertyDescriptor(profile, 'managedProfilePath');
    const codexHomePath = Object.getOwnPropertyDescriptor(profile, 'codexHomePath');
    if (
      managedProfilePath === undefined ||
      !('value' in managedProfilePath) ||
      managedProfilePath.value !== expected.managedProfilePath ||
      managedProfilePath.enumerable !== true ||
      codexHomePath === undefined ||
      !('value' in codexHomePath) ||
      codexHomePath.value !== expected.codexHomePath ||
      codexHomePath.enumerable !== true
    ) {
      throw unsafeVersion();
    }
    return expected;
  } catch {
    throw unsafeVersion();
  }
};

const createArtifacts = (
  options: ManagedArtifactOptions,
  operations?: NodeCliManagedFileSystemOperations,
): CodexManagedArtifacts => {
  const files =
    operations === undefined
      ? createNodeCliManagedFileSystem(options)
      : createNodeCliManagedFileSystemForTest({ ...options, operations });
  const roots = assertCodexRoots(options.providerRuntimeRoot);
  const owned = new Map<string, readonly CodexImageManifest[]>();
  const pending = new Set<string>();

  const artifacts: CodexManagedArtifacts = {
    async prepareProfileAtomic(profile, operation) {
      assertProviderConnectionActive(operation);
      const expected = assertProfile(options, profile);
      await files.prepareProfileDirectory('codex_cli', operation);
      await files.assertDirectoryHasNoUnexpectedChildren(expected.codexHomePath, [], operation);
    },
    async verifyProfile(profile, operation) {
      assertProviderConnectionActive(operation);
      const expected = assertProfile(options, profile);
      await files.assertDirectoryChildren(expected.codexHomePath, [], operation);
    },
    async prepareRequestAtomic(id, schemaJson, operation, imageInputs = []) {
      assertRequestContext(id, operation);
      if (owned.has(id) || pending.has(id)) throw unsafeVersion();
      const expectedSchemaJson = assertSchemaJson(schemaJson);
      const workspacePath = win32.join(roots.providerWorkspaceRoot, id);
      const schemaPath = win32.join(roots.providerTempRoot, id, 'output-schema.json');
      const schemaSha256 = sha256(expectedSchemaJson);
      if (imageInputs.length > 2) throw unsafeVersion();
      const images = Object.freeze(
        imageInputs.map((image, index) => {
          if (
            !new RegExp(`^image-${String(index).padStart(3, '0')}\\.(png|jpg)$`, 'u').test(
              image.fileName,
            ) ||
            !(image.bytes instanceof Uint8Array) ||
            image.sizeBytes !== image.bytes.byteLength ||
            image.sizeBytes < 1 ||
            image.sizeBytes > 5_000_000 ||
            createHash('sha256').update(image.bytes).digest('hex') !== image.sha256
          )
            throw unsafeVersion();
          return Object.freeze({
            fileName: image.fileName,
            path: win32.join(win32.dirname(schemaPath), image.fileName),
            sizeBytes: image.sizeBytes,
            sha256: image.sha256,
          });
        }),
      );
      const requestArtifacts = Object.freeze({
        workspacePath,
        schemaPath,
        schemaSha256,
        ...(images.length ? { images } : {}),
      });
      assertCodexArtifacts(id, expectedSchemaJson, requestArtifacts, roots);
      pending.add(id);
      let acquired = false;
      try {
        await files.assertDirectoryHasNoUnexpectedChildren(workspacePath, [], operation);
        await files.assertDirectoryHasNoUnexpectedChildren(
          win32.dirname(schemaPath),
          [],
          operation,
        );
        await files.prepareRequestDirectory('codex_cli', id, workspacePath, operation);
        acquired = true;
        owned.set(id, Object.freeze([]));
        await files.writeUtf8FileAtomic(schemaPath, expectedSchemaJson, schemaSha256, operation);
        for (const [index, image] of images.entries()) {
          const input = imageInputs[index];
          if (!input) throw unsafeVersion();
          await files.writeBinaryFileExclusive(image.path, input.bytes, image.sha256, operation);
          owned.set(id, Object.freeze(images.slice(0, index + 1)));
        }
        return requestArtifacts;
      } catch (error) {
        if (acquired) await artifacts.cleanupRequest(id);
        throw error;
      } finally {
        pending.delete(id);
      }
    },
    async verifyRequest(id, schemaJson, schemaSha256, operation) {
      assertRequestContext(id, operation);
      const expectedSchemaJson = assertSchemaJson(schemaJson);
      const workspacePath = win32.join(roots.providerWorkspaceRoot, id);
      const schemaPath = win32.join(roots.providerTempRoot, id, 'output-schema.json');
      assertCodexArtifacts(
        id,
        expectedSchemaJson,
        Object.freeze({ workspacePath, schemaPath, schemaSha256 }),
        roots,
      );
      await files.assertDirectoryChildren(workspacePath, [], operation);
      await files.assertDirectoryChildren(
        win32.dirname(schemaPath),
        ['output-schema.json', ...(owned.get(id) ?? []).map((image) => image.fileName)],
        operation,
      );
      await files.verifyUtf8File(schemaPath, expectedSchemaJson, schemaSha256, operation);
      for (const image of owned.get(id) ?? [])
        await files.verifyBinaryFile(image.path, image.sizeBytes, image.sha256, operation);
    },
    async cleanupRequest(id) {
      const requestId = assertCleanupRequestId(id);
      const operation = Object.freeze({ requestId, signal: AbortSignal.timeout(15_000) });
      // Missing paths are allowed after the runner's awaited owner cleanup. Existing
      // trees may contain only our generated names; foreign data is never removed.
      await files.assertDirectoryHasNoUnexpectedChildren(
        win32.join(roots.providerWorkspaceRoot, requestId),
        [],
        operation,
      );
      await files.assertDirectoryHasNoUnexpectedChildren(
        win32.join(roots.providerTempRoot, requestId),
        owned.has(id)
          ? ['output-schema.json', ...(owned.get(id) ?? []).map((image) => image.fileName)]
          : [],
        operation,
      );
      for (const image of owned.get(id) ?? []) {
        try {
          await files.verifyBinaryFile(image.path, image.sizeBytes, image.sha256, operation);
        } catch {
          throw codexError('PROVIDER_RESIDUAL_DATA');
        }
      }
      await files.cleanupRequestDirectory(
        requestId,
        win32.join(roots.providerWorkspaceRoot, requestId),
      );
      owned.delete(id);
    },
    async cleanupProfileTransients() {
      return undefined;
    },
  };

  return Object.freeze(artifacts);
};

export const createNodeCodexManagedArtifacts = (
  options: ManagedArtifactOptions,
): CodexManagedArtifacts => createArtifacts(options);

export const createNodeCodexManagedArtifactsForTest = (
  options: ManagedArtifactOptions,
  operations: NodeCliManagedFileSystemOperations,
): CodexManagedArtifacts => createArtifacts(options, operations);
