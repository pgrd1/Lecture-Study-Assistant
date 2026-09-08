import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderConnectionOperation } from '../../../../../src/core/ports/aiProvider';
import { ANTIGRAVITY_MANAGED_PROFILE_JSON } from '../../../../../src/infrastructure/providers/cli/antigravityCliProtocol';
import type {
  CliExecutableFileAccess,
  CliFileHasher,
} from '../../../../../src/infrastructure/providers/cli/cliFileIntegrity';
import type { CliPrivateDirectoryManager } from '../../../../../src/infrastructure/providers/cli/cliPrivateDirectories';
import {
  createNodeAntigravityManagedArtifactsForTest,
  type ManagedArtifactOptions,
} from '../../../../../src/infrastructure/providers/cli/nodeAntigravityManagedArtifacts';
import type {
  NodeCliManagedFileHandle,
  NodeCliManagedFileSystemOperations,
} from '../../../../../src/infrastructure/providers/cli/nodeCliManagedFileSystem';

const requestId = '50000000-0000-4000-8000-000000000001';
const otherRequestId = '50000000-0000-4000-8000-000000000002';
const runtimeRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers';
const profileRoot = `${runtimeRoot}\\profiles`;
const tempRoot = `${runtimeRoot}\\temp`;
const workspaceRoot = `${runtimeRoot}\\workspace`;
const profileDirectory = `${profileRoot}\\antigravity_cli\\settings`;
const profilePath = `${profileDirectory}\\profile.json`;

const operation = (
  id = requestId,
  signal: AbortSignal = new AbortController().signal,
): ProviderConnectionOperation => Object.freeze({ requestId: id, signal });

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const missing = (): Error & { readonly code: 'ENOENT' } =>
  Object.assign(new Error('ENOENT'), { code: 'ENOENT' as const });

type HarnessState = {
  readonly activity: string[];
  readonly files: Map<string, string>;
  readonly missingDirectories: Set<string>;
  readonly observedOperations: ProviderConnectionOperation[];
};

class FakeHandle implements NodeCliManagedFileHandle {
  readonly #chunks: Uint8Array[] = [];

  constructor(
    readonly path: string,
    readonly harness: HarnessState,
  ) {}

  async write(contents: Uint8Array): Promise<void> {
    this.harness.activity.push(`write:${this.path}`);
    this.#chunks.push(Uint8Array.from(contents));
  }

  async sync(): Promise<void> {
    this.harness.activity.push(`sync:${this.path}`);
  }

  async close(): Promise<void> {
    this.harness.activity.push(`close:${this.path}`);
    const length = this.#chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.harness.files.set(this.path, new TextDecoder().decode(joined));
  }
}

class FakeOperations implements NodeCliManagedFileSystemOperations {
  constructor(readonly harness: HarnessState) {}

  async mkdir(path: string): Promise<void> {
    this.harness.activity.push(`mkdir:${path}`);
  }

  async openExclusive(path: string): Promise<NodeCliManagedFileHandle> {
    this.harness.activity.push(`open:${path}`);
    if (this.harness.files.has(path)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    return new FakeHandle(path, this.harness);
  }

  async rename(source: string, target: string): Promise<void> {
    this.harness.activity.push(`rename:${source}:${target}`);
    const contents = this.harness.files.get(source);
    if (contents === undefined) throw missing();
    this.harness.files.delete(source);
    this.harness.files.set(target, contents);
  }

  async remove(path: string): Promise<void> {
    this.harness.activity.push(`remove:${path}`);
    if (!this.harness.files.delete(path)) throw missing();
  }
}

class FakeFiles implements CliExecutableFileAccess {
  readonly explicitChildren = new Map<string, readonly string[]>();
  reparseAt: string | null = null;

  constructor(readonly harness: HarnessState) {}

  async canonicalize(path: string, currentOperation: ProviderConnectionOperation): Promise<string> {
    this.harness.activity.push(`canonicalize:${path}`);
    this.harness.observedOperations.push(currentOperation);
    if (this.harness.missingDirectories.has(path.toLowerCase())) throw missing();
    return path;
  }

  async assertNoReparsePoints(
    path: string,
    currentOperation: ProviderConnectionOperation,
  ): Promise<void> {
    this.harness.activity.push(`reparse:${path}`);
    this.harness.observedOperations.push(currentOperation);
    if (this.harness.missingDirectories.has(path.toLowerCase())) throw missing();
    if (this.reparseAt?.toLowerCase() === path.toLowerCase()) {
      throw Object.assign(new Error('reparse'), { code: 'ELOOP' });
    }
  }

  async readFile(
    path: string,
    _limitBytes: number,
    currentOperation: ProviderConnectionOperation,
  ): Promise<Uint8Array> {
    this.harness.activity.push(`read:${path}`);
    this.harness.observedOperations.push(currentOperation);
    const value = this.harness.files.get(path);
    if (value === undefined) throw missing();
    return new TextEncoder().encode(value);
  }

  async listChildren(
    path: string,
    currentOperation: ProviderConnectionOperation,
  ): Promise<readonly string[]> {
    this.harness.activity.push(`list:${path}`);
    this.harness.observedOperations.push(currentOperation);
    if (this.harness.missingDirectories.has(path.toLowerCase())) throw missing();
    const explicit = this.explicitChildren.get(path);
    if (explicit !== undefined) return explicit;
    return [...this.harness.files.keys()].filter(
      (candidate) => win32.dirname(candidate).toLowerCase() === path.toLowerCase(),
    );
  }
}

class FakeHasher implements CliFileHasher {
  constructor(readonly harness: HarnessState) {}

  async sha256(path: string, _operation: ProviderConnectionOperation): Promise<string> {
    this.harness.activity.push(`hash:${path}`);
    const value = this.harness.files.get(path);
    if (value === undefined) throw missing();
    return sha256(value);
  }
}

class FakePrivateDirectories implements CliPrivateDirectoryManager {
  cleanupFails = false;
  afterPrepare: (() => void) | null = null;

  constructor(readonly harness: HarnessState) {}

  async prepareProfile(providerId: string, _operation: ProviderConnectionOperation): Promise<void> {
    this.harness.activity.push(`prepare-profile:${providerId}`);
    if (providerId === 'antigravity_cli') {
      this.harness.missingDirectories.delete(profileDirectory.toLowerCase());
    }
  }

  async prepareRequest(
    providerId: string,
    id: string,
    cwd: string,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {
    this.harness.activity.push(`prepare:${providerId}:${id}:${cwd}`);
    this.harness.missingDirectories.delete(cwd.toLowerCase());
    this.harness.missingDirectories.delete(`${tempRoot}\\${id}`.toLowerCase());
    this.afterPrepare?.();
  }

  async cleanupRequest(id: string, cwd: string): Promise<void> {
    this.harness.activity.push(`cleanup:${id}:${cwd}`);
    if (this.cleanupFails) throw new Error('private cleanup detail');
    const requestTemp = `${tempRoot}\\${id}`.toLowerCase();
    const requestWorkspace = cwd.toLowerCase();
    for (const path of [...this.harness.files.keys()]) {
      const normalized = path.toLowerCase();
      if (
        normalized === requestTemp ||
        normalized.startsWith(`${requestTemp}\\`) ||
        normalized === requestWorkspace ||
        normalized.startsWith(`${requestWorkspace}\\`)
      ) {
        this.harness.files.delete(path);
      }
    }
    this.harness.missingDirectories.add(requestTemp);
    this.harness.missingDirectories.add(requestWorkspace);
  }
}

const harness = () => {
  const state: HarnessState = {
    activity: [],
    files: new Map(),
    missingDirectories: new Set(),
    observedOperations: [],
  };
  const fileAccess = new FakeFiles(state);
  const privateDirectories = new FakePrivateDirectories(state);
  const operations = new FakeOperations(state);
  const options = Object.freeze({
    providerRuntimeRoot: runtimeRoot,
    providerProfilesRoot: profileRoot,
    providerTempRoot: tempRoot,
    providerWorkspaceRoot: workspaceRoot,
    files: fileAccess,
    hasher: new FakeHasher(state),
    privateDirectories,
  }) satisfies ManagedArtifactOptions;
  return {
    ...state,
    fileAccess,
    privateDirectories,
    artifacts: createNodeAntigravityManagedArtifactsForTest(options, operations),
  };
};

describe('node antigravity managed artifacts', () => {
  it('rejects malformed schema input before any filesystem or private-directory activity', async () => {
    for (const malformedSchema of [undefined, { type: 'object' }] as const) {
      const prepared = harness();
      await expect(
        prepared.artifacts.prepareRequestAtomic(
          requestId,
          malformedSchema as unknown as string,
          operation(),
        ),
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNSAFE_VERSION',
        message: 'PROVIDER_UNSAFE_VERSION',
      });
      expect(prepared.activity).toEqual([]);

      const verified = harness();
      await expect(
        verified.artifacts.verifyRequest(
          requestId,
          malformedSchema as unknown as string,
          operation(),
        ),
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNSAFE_VERSION',
        message: 'PROVIDER_UNSAFE_VERSION',
      });
      expect(verified.activity).toEqual([]);
    }
  });

  it('writes and verifies only the canonical managed profile and optional schema', async () => {
    const { artifacts, files, activity } = harness();
    const schema = '{"type":"object"}';

    await artifacts.writeProfileAtomic(ANTIGRAVITY_MANAGED_PROFILE_JSON, operation());
    await artifacts.verifyProfile(ANTIGRAVITY_MANAGED_PROFILE_JSON, operation());
    const result = await artifacts.prepareRequestAtomic(requestId, schema, operation());
    await artifacts.verifyRequest(requestId, schema, operation());

    expect(result).toEqual({
      workspacePath: `${workspaceRoot}\\${requestId}`,
      schemaPath: `${tempRoot}\\${requestId}\\output-schema.json`,
    });
    expect(files.get(profilePath)).toBe(ANTIGRAVITY_MANAGED_PROFILE_JSON);
    expect(files.get(result.schemaPath as string)).toBe(schema);
    expect(activity).toContain(
      `prepare:antigravity_cli:${requestId}:${workspaceRoot}\\${requestId}`,
    );
  });

  it('prepares a missing profile directory before access and never delegates when pre-aborted', async () => {
    const fresh = harness();
    fresh.missingDirectories.add(profileDirectory.toLowerCase());

    await fresh.artifacts.writeProfileAtomic(ANTIGRAVITY_MANAGED_PROFILE_JSON, operation());

    expect(fresh.files.get(profilePath)).toBe(ANTIGRAVITY_MANAGED_PROFILE_JSON);
    expect(fresh.activity[0]).toBe('prepare-profile:antigravity_cli');
    expect(fresh.activity.indexOf('prepare-profile:antigravity_cli')).toBeLessThan(
      fresh.activity.indexOf(`list:${profileDirectory}`),
    );

    const aborted = harness();
    aborted.missingDirectories.add(profileDirectory.toLowerCase());
    const controller = new AbortController();
    controller.abort();

    await expect(
      aborted.artifacts.writeProfileAtomic(
        ANTIGRAVITY_MANAGED_PROFILE_JSON,
        operation(requestId, controller.signal),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(aborted.activity).toEqual([]);
  });

  it('supports requests without a schema and proves both request directories are empty', async () => {
    const { artifacts, activity } = harness();

    await expect(artifacts.prepareRequestAtomic(requestId, null, operation())).resolves.toEqual({
      workspacePath: `${workspaceRoot}\\${requestId}`,
      schemaPath: null,
    });
    await artifacts.verifyRequest(requestId, null, operation());

    expect(activity).toContain(`list:${workspaceRoot}\\${requestId}`);
    expect(activity).toContain(`list:${tempRoot}\\${requestId}`);
    expect(activity.some((entry) => entry.includes('output-schema.json'))).toBe(false);
  });

  it('rejects non-canonical profile contents before any filesystem access', async () => {
    const { artifacts, activity } = harness();

    await expect(artifacts.writeProfileAtomic('{}', operation())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
    await expect(artifacts.verifyProfile('{}', operation())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });

    expect(activity).toEqual([]);
  });

  it('rejects invalid UUIDs and operation mismatches before request filesystem access', async () => {
    const invalid = harness();
    const mismatch = harness();
    const verifyMismatch = harness();
    const cleanupInvalid = harness();

    await expect(
      invalid.artifacts.prepareRequestAtomic('not-a-uuid', null, operation('not-a-uuid')),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    await expect(
      mismatch.artifacts.prepareRequestAtomic(requestId, null, operation(otherRequestId)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    await expect(
      verifyMismatch.artifacts.verifyRequest(requestId, null, operation(otherRequestId)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    await expect(cleanupInvalid.artifacts.cleanupRequest('not-a-uuid')).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });

    expect(invalid.activity).toEqual([]);
    expect(mismatch.activity).toEqual([]);
    expect(verifyMismatch.activity).toEqual([]);
    expect(cleanupInvalid.activity).toEqual([]);
  });

  it('rejects unexpected profile contents as residual data without leaking filenames', async () => {
    const { artifacts, fileAccess } = harness();
    fileAccess.explicitChildren.set(profileDirectory, [`${profileDirectory}\\plugin.json`]);

    await expect(
      artifacts.writeProfileAtomic(ANTIGRAVITY_MANAGED_PROFILE_JSON, operation()),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
      expect(String(error)).not.toContain('plugin.json');
      return true;
    });
  });

  it.each(['auth.json', 'oauth_creds.json', 'gemini-credentials.json', 'codex_auth.age'])(
    'classifies a %s profile remnant as residual data without leaking its name',
    async (credentialName) => {
      const { artifacts, fileAccess } = harness();
      fileAccess.explicitChildren.set(profileDirectory, [`${profileDirectory}\\${credentialName}`]);

      await expect(
        artifacts.writeProfileAtomic(ANTIGRAVITY_MANAGED_PROFILE_JSON, operation()),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
        expect(String(error)).not.toContain(credentialName);
        return true;
      });
    },
  );

  it('honors pre-aborted profile and request operations with zero filesystem access', async () => {
    const controller = new AbortController();
    controller.abort();
    const scenarios = [
      (artifacts: ReturnType<typeof harness>['artifacts']) =>
        artifacts.writeProfileAtomic(
          ANTIGRAVITY_MANAGED_PROFILE_JSON,
          operation(requestId, controller.signal),
        ),
      (artifacts: ReturnType<typeof harness>['artifacts']) =>
        artifacts.verifyProfile(
          ANTIGRAVITY_MANAGED_PROFILE_JSON,
          operation(requestId, controller.signal),
        ),
      (artifacts: ReturnType<typeof harness>['artifacts']) =>
        artifacts.prepareRequestAtomic(requestId, '{}', operation(requestId, controller.signal)),
      (artifacts: ReturnType<typeof harness>['artifacts']) =>
        artifacts.verifyRequest(requestId, '{}', operation(requestId, controller.signal)),
    ];

    for (const scenario of scenarios) {
      const current = harness();
      await expect(scenario(current.artifacts)).rejects.toMatchObject({
        code: 'PROVIDER_CANCELLED',
      });
      expect(current.activity).toEqual([]);
    }
  });

  it('stops after request-directory preparation when cancellation arrives before schema writing', async () => {
    const { artifacts, privateDirectories, activity, files, observedOperations } = harness();
    const controller = new AbortController();
    privateDirectories.afterPrepare = () => controller.abort();

    await expect(
      artifacts.prepareRequestAtomic(
        requestId,
        '{"type":"object"}',
        operation(requestId, controller.signal),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });

    expect(activity[0]).toBe(`prepare:antigravity_cli:${requestId}:${workspaceRoot}\\${requestId}`);
    expect(activity).toContain(`cleanup:${requestId}:${workspaceRoot}\\${requestId}`);
    expect(activity).toContain(`list:${workspaceRoot}\\${requestId}`);
    expect(activity).toContain(`list:${tempRoot}\\${requestId}`);
    expect(files.has(`${tempRoot}\\${requestId}\\output-schema.json`)).toBe(false);
    expect(
      observedOperations.some(
        (currentOperation) =>
          currentOperation.requestId !== requestId && !currentOperation.signal.aborted,
      ),
    ).toBe(true);
  });

  it('detects schema reparse substitution and later content tampering', async () => {
    const reparse = harness();
    const schemaPath = `${tempRoot}\\${requestId}\\output-schema.json`;
    reparse.fileAccess.reparseAt = schemaPath;

    await expect(
      reparse.artifacts.prepareRequestAtomic(requestId, '{}', operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });

    const tampered = harness();
    const prepared = await tampered.artifacts.prepareRequestAtomic(requestId, '{}', operation());
    tampered.files.set(prepared.schemaPath as string, '{"tampered":true}');
    await expect(
      tampered.artifacts.verifyRequest(requestId, '{}', operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
  });

  it('rejects unexpected files in schema and schema-free request directories', async () => {
    const withSchema = harness();
    const schemaDirectory = `${tempRoot}\\${requestId}`;
    await withSchema.artifacts.prepareRequestAtomic(requestId, '{}', operation());
    withSchema.fileAccess.explicitChildren.set(schemaDirectory, [
      `${schemaDirectory}\\output-schema.json`,
      `${schemaDirectory}\\injected.json`,
    ]);
    await expect(
      withSchema.artifacts.verifyRequest(requestId, '{}', operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });

    const withoutSchema = harness();
    await withoutSchema.artifacts.prepareRequestAtomic(requestId, null, operation());
    withoutSchema.fileAccess.explicitChildren.set(schemaDirectory, [
      `${schemaDirectory}\\injected.json`,
    ]);
    await expect(
      withoutSchema.artifacts.verifyRequest(requestId, null, operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
  });

  it('delegates scoped request cleanup and reports cleanup failures as residual data', async () => {
    const successful = harness();
    await successful.artifacts.cleanupRequest(requestId);
    expect(successful.activity).toContain(`cleanup:${requestId}:${workspaceRoot}\\${requestId}`);
    expect(successful.activity).toContain(`list:${workspaceRoot}\\${requestId}`);
    expect(successful.activity).toContain(`list:${tempRoot}\\${requestId}`);
    expect(
      successful.observedOperations.every(
        (currentOperation) =>
          currentOperation.requestId !== requestId && !currentOperation.signal.aborted,
      ),
    ).toBe(true);

    const failed = harness();
    failed.privateDirectories.cleanupFails = true;
    await expect(failed.artifacts.cleanupRequest(requestId)).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
      expect(String(error)).not.toContain('private cleanup detail');
      return true;
    });
  });

  it('never represents provider-managed history as locally deletable', async () => {
    const { artifacts, activity } = harness();

    await artifacts.cleanupProfileTransients();

    expect(activity).toEqual([]);
  });
});
