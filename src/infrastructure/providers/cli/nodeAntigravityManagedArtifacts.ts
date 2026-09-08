import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import {
  ANTIGRAVITY_MANAGED_PROFILE_JSON,
  ANTIGRAVITY_UUID_PATTERN,
  type AntigravityArtifactPaths,
  type AntigravityArtifactRoots,
  antigravityError,
  assertAntigravityArtifactRoots,
  assertAntigravityArtifacts,
} from './antigravityCliProtocol';
import type { AntigravityManagedArtifacts } from './antigravityManagedArtifacts';
import { assertProviderConnectionActive } from './cliFileIntegrity';
import type { ManagedArtifactOptions } from './nodeCliManagedFileSystem';
import {
  createNodeCliManagedFileSystem,
  createNodeCliManagedFileSystemForTest,
  type NodeCliManagedFileSystemOperations,
} from './nodeCliManagedFileSystem';

export type { ManagedArtifactOptions };

const sha256 = (contents: string): string => createHash('sha256').update(contents).digest('hex');

const assertSchemaJson = (schemaJson: unknown): string | null => {
  if (schemaJson !== null && typeof schemaJson !== 'string') {
    throw antigravityError('PROVIDER_UNSAFE_VERSION');
  }
  return schemaJson;
};

const assertExactProfile = (
  contents: string,
  operation: Parameters<AntigravityManagedArtifacts['writeProfileAtomic']>[1],
): void => {
  assertProviderConnectionActive(operation);
  if (contents !== ANTIGRAVITY_MANAGED_PROFILE_JSON) {
    throw antigravityError('PROVIDER_UNSAFE_VERSION');
  }
};

const requestArtifacts = (
  id: string,
  schemaJson: string | null,
  operation: Parameters<AntigravityManagedArtifacts['prepareRequestAtomic']>[2],
  roots: AntigravityArtifactRoots,
): AntigravityArtifactPaths => {
  assertProviderConnectionActive(operation);
  const expectedSchemaJson = assertSchemaJson(schemaJson);
  if (operation.requestId !== id) {
    throw antigravityError('PROVIDER_UNSAFE_VERSION');
  }
  const artifacts = Object.freeze({
    workspacePath: win32.join(roots.providerWorkspaceRoot, id),
    schemaPath:
      expectedSchemaJson === null
        ? null
        : win32.join(roots.providerTempRoot, id, 'output-schema.json'),
  });
  assertAntigravityArtifacts(id, expectedSchemaJson, artifacts, roots);
  return artifacts;
};

const createArtifacts = (
  options: ManagedArtifactOptions,
  operations?: NodeCliManagedFileSystemOperations,
): AntigravityManagedArtifacts => {
  const files =
    operations === undefined
      ? createNodeCliManagedFileSystem(options)
      : createNodeCliManagedFileSystemForTest({ ...options, operations });
  const roots = assertAntigravityArtifactRoots(
    options.providerWorkspaceRoot,
    options.providerTempRoot,
  );
  const profilePath = win32.join(
    options.providerProfilesRoot,
    'antigravity_cli',
    'settings',
    'profile.json',
  );

  const artifacts: AntigravityManagedArtifacts = {
    async writeProfileAtomic(contents, operation) {
      assertExactProfile(contents, operation);
      await files.prepareProfileDirectory('antigravity_cli', operation);
      await files.assertDirectoryHasNoUnexpectedChildren(
        win32.dirname(profilePath),
        ['profile.json'],
        operation,
      );
      await files.writeUtf8FileAtomic(profilePath, contents, sha256(contents), operation);
    },
    async verifyProfile(contents, operation) {
      assertExactProfile(contents, operation);
      await files.assertDirectoryChildren(win32.dirname(profilePath), ['profile.json'], operation);
      await files.verifyUtf8File(profilePath, contents, sha256(contents), operation);
    },
    async prepareRequestAtomic(id, schemaJson, operation) {
      const prepared = requestArtifacts(id, schemaJson, operation, roots);
      await files.prepareRequestDirectory('antigravity_cli', id, prepared.workspacePath, operation);
      if (prepared.schemaPath !== null && schemaJson !== null) {
        await files.writeUtf8FileAtomic(
          prepared.schemaPath,
          schemaJson,
          sha256(schemaJson),
          operation,
        );
      }
      return prepared;
    },
    async verifyRequest(id, schemaJson, operation) {
      const prepared = requestArtifacts(id, schemaJson, operation, roots);
      await files.assertDirectoryChildren(prepared.workspacePath, [], operation);
      const requestTempPath = win32.join(roots.providerTempRoot, id);
      await files.assertDirectoryChildren(
        requestTempPath,
        prepared.schemaPath === null ? [] : ['output-schema.json'],
        operation,
      );
      if (prepared.schemaPath !== null && schemaJson !== null) {
        await files.verifyUtf8File(prepared.schemaPath, schemaJson, sha256(schemaJson), operation);
      }
    },
    async cleanupRequest(id) {
      if (!ANTIGRAVITY_UUID_PATTERN.test(id)) {
        throw antigravityError('PROVIDER_UNSAFE_VERSION');
      }
      await files.cleanupRequestDirectory(id, win32.join(roots.providerWorkspaceRoot, id));
    },
    async cleanupProfileTransients() {
      return undefined;
    },
  };
  return Object.freeze(artifacts);
};

export const createNodeAntigravityManagedArtifacts = (
  options: ManagedArtifactOptions,
): AntigravityManagedArtifacts => createArtifacts(options);

export const createNodeAntigravityManagedArtifactsForTest = (
  options: ManagedArtifactOptions,
  operations: NodeCliManagedFileSystemOperations,
): AntigravityManagedArtifacts => createArtifacts(options, operations);
