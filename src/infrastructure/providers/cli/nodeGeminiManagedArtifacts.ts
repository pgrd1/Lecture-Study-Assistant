import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import { assertProviderConnectionActive, secureExactPath, unsafeVersion } from './cliFileIntegrity';
import {
  assertGeminiArtifacts,
  assertGeminiBinding,
  assertGeminiRoots,
  createGeminiManagedProfile,
  type GeminiBinding,
  type GeminiManagedProfile,
  type GeminiRequestArtifacts,
  isGeminiProviderError,
} from './geminiCliProtocol';
import type { GeminiManagedArtifacts } from './geminiManagedArtifacts';
import {
  createNodeCliManagedFileSystem,
  createNodeCliManagedFileSystemForTest,
  type ManagedArtifactOptions,
  type NodeCliManagedFileSystem,
  type NodeCliManagedFileSystemOperations,
} from './nodeCliManagedFileSystem';

export type { ManagedArtifactOptions };

const SCHEMA_LIMIT_BYTES = 1024 * 1024;
const PROFILE_KEYS = Object.freeze([
  'managedProfilePath',
  'geminiCliHomePath',
  'settingsPath',
  'policyPath',
  'settingsJson',
  'policyText',
  'settingsSha256',
  'policySha256',
] as const);
const GEMINI_HOME_CHILDREN = Object.freeze(['policies', 'settings.json'] as const);
const POLICY_CHILDREN = Object.freeze(['studyapp-deny-all.toml'] as const);

const sha256 = (contents: string): string =>
  createHash('sha256').update(contents, 'utf8').digest('hex');

const normalizeFailure = (error: unknown): never => {
  if (isGeminiProviderError(error)) throw error;
  throw unsafeVersion();
};

const assertProfile = (
  options: ManagedArtifactOptions,
  profile: GeminiManagedProfile,
): GeminiManagedProfile => {
  const expected = createGeminiManagedProfile(assertGeminiRoots(options.providerRuntimeRoot));
  const candidate = profile as unknown;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    Reflect.ownKeys(candidate).length !== PROFILE_KEYS.length
  ) {
    throw unsafeVersion();
  }
  for (const key of PROFILE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      descriptor.value !== expected[key]
    ) {
      throw unsafeVersion();
    }
  }
  return expected;
};

const requestArtifacts = (
  roots: ReturnType<typeof assertGeminiRoots>,
  id: string,
  operation?: ProviderConnectionOperation,
): GeminiRequestArtifacts => {
  if (operation !== undefined && operation.requestId !== id) throw unsafeVersion();
  const artifacts = Object.freeze({ workspacePath: win32.join(roots.providerWorkspaceRoot, id) });
  assertGeminiArtifacts(id, artifacts, roots);
  return artifacts;
};

const assertProfileDirectoriesAllowingMissingFiles = async (
  files: NodeCliManagedFileSystem,
  profile: GeminiManagedProfile,
  operation: ProviderConnectionOperation,
): Promise<void> => {
  await files.assertDirectoryHasNoUnexpectedChildren(
    profile.geminiCliHomePath,
    ['.gemini'],
    operation,
  );
  await files.assertDirectoryHasNoUnexpectedChildren(
    win32.dirname(profile.settingsPath),
    GEMINI_HOME_CHILDREN,
    operation,
  );
  await files.assertDirectoryHasNoUnexpectedChildren(
    win32.dirname(profile.policyPath),
    POLICY_CHILDREN,
    operation,
  );
};

const assertExactProfileDirectories = async (
  files: NodeCliManagedFileSystem,
  profile: GeminiManagedProfile,
  operation: ProviderConnectionOperation,
): Promise<void> => {
  await files.assertDirectoryChildren(profile.geminiCliHomePath, ['.gemini'], operation);
  await files.assertDirectoryChildren(
    win32.dirname(profile.settingsPath),
    GEMINI_HOME_CHILDREN,
    operation,
  );
  await files.assertDirectoryChildren(
    win32.dirname(profile.policyPath),
    POLICY_CHILDREN,
    operation,
  );
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

const createArtifacts = (
  options: ManagedArtifactOptions,
  operations?: NodeCliManagedFileSystemOperations,
): GeminiManagedArtifacts => {
  const files =
    operations === undefined
      ? createNodeCliManagedFileSystem(options)
      : createNodeCliManagedFileSystemForTest({ ...options, operations });
  const roots = assertGeminiRoots(options.providerRuntimeRoot);

  const artifacts: GeminiManagedArtifacts = {
    async readSettingsSchemaSnapshot(
      binding: GeminiBinding,
      operation: ProviderConnectionOperation,
    ) {
      try {
        assertProviderConnectionActive(operation);
        const verifiedBinding = assertGeminiBinding(binding);
        const manifest = verifiedBinding.canonicalPackageManifestPath;
        if (manifest === null || verifiedBinding.packageManifestSha256 === null) {
          throw unsafeVersion();
        }
        const path = win32.join(win32.dirname(manifest), 'settings.schema.json');
        const canonical = await secureExactPath(options.files, path, operation);
        assertProviderConnectionActive(operation);
        const source = await options.files.readFile(canonical, SCHEMA_LIMIT_BYTES, operation);
        assertProviderConnectionActive(operation);
        await secureExactPath(options.files, canonical, operation);
        assertProviderConnectionActive(operation);
        if (source.byteLength === 0 || source.byteLength > SCHEMA_LIMIT_BYTES) {
          throw unsafeVersion();
        }
        const bytes = Uint8Array.from(source);
        let contents: string;
        try {
          contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw unsafeVersion();
        }
        if (!sameBytes(new TextEncoder().encode(contents), bytes)) throw unsafeVersion();
        return Object.freeze({
          packageManifestSha256: verifiedBinding.packageManifestSha256,
          relativePath: 'settings.schema.json' as const,
          schemaSha256: sha256(contents),
          contents,
        });
      } catch (error) {
        return normalizeFailure(error);
      }
    },

    async writeProfileAtomic(
      profile: GeminiManagedProfile,
      operation: ProviderConnectionOperation,
    ) {
      try {
        assertProviderConnectionActive(operation);
        const expected = assertProfile(options, profile);
        await files.prepareProfileDirectory('gemini_cli', operation);
        await assertProfileDirectoriesAllowingMissingFiles(files, expected, operation);
        await files.writeUtf8FileAtomic(
          expected.settingsPath,
          expected.settingsJson,
          expected.settingsSha256,
          operation,
        );
        await files.writeUtf8FileAtomic(
          expected.policyPath,
          expected.policyText,
          expected.policySha256,
          operation,
        );
        await assertExactProfileDirectories(files, expected, operation);
      } catch (error) {
        return normalizeFailure(error);
      }
    },

    async verifyProfile(profile: GeminiManagedProfile, operation: ProviderConnectionOperation) {
      try {
        assertProviderConnectionActive(operation);
        const expected = assertProfile(options, profile);
        await assertExactProfileDirectories(files, expected, operation);
        await files.verifyUtf8File(
          expected.settingsPath,
          expected.settingsJson,
          expected.settingsSha256,
          operation,
        );
        await files.verifyUtf8File(
          expected.policyPath,
          expected.policyText,
          expected.policySha256,
          operation,
        );
        await assertExactProfileDirectories(files, expected, operation);
      } catch (error) {
        return normalizeFailure(error);
      }
    },

    async prepareRequestAtomic(id: string, operation: ProviderConnectionOperation) {
      try {
        assertProviderConnectionActive(operation);
        const prepared = requestArtifacts(roots, id, operation);
        await files.prepareRequestDirectory('gemini_cli', id, prepared.workspacePath, operation);
        return prepared;
      } catch (error) {
        return normalizeFailure(error);
      }
    },

    async verifyRequest(id: string, operation: ProviderConnectionOperation) {
      try {
        assertProviderConnectionActive(operation);
        const prepared = requestArtifacts(roots, id, operation);
        await files.assertDirectoryChildren(prepared.workspacePath, [], operation);
        await files.assertDirectoryChildren(win32.join(roots.providerTempRoot, id), [], operation);
      } catch (error) {
        return normalizeFailure(error);
      }
    },

    async cleanupRequest(id: string) {
      try {
        const prepared = requestArtifacts(roots, id);
        await files.cleanupRequestDirectory(id, prepared.workspacePath);
      } catch (error) {
        return normalizeFailure(error);
      }
    },

    async cleanupProfileTransients() {
      return undefined;
    },
  };
  return Object.freeze(artifacts);
};

export const createNodeGeminiManagedArtifacts = (
  options: ManagedArtifactOptions,
): GeminiManagedArtifacts => createArtifacts(options);

export const createNodeGeminiManagedArtifactsForTest = (
  options: ManagedArtifactOptions,
  operations: NodeCliManagedFileSystemOperations,
): GeminiManagedArtifacts => createArtifacts(options, operations);

export const geminiManagedArtifactContentHash = sha256;
