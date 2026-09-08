import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderConnectionOperation } from '../../../../../src/core/ports/aiProvider';
import type {
  CliExecutableFileAccess,
  CliFileHasher,
} from '../../../../../src/infrastructure/providers/cli/cliFileIntegrity';
import type { CliPrivateDirectoryManager } from '../../../../../src/infrastructure/providers/cli/cliPrivateDirectories';
import { createCodexManagedProfile } from '../../../../../src/infrastructure/providers/cli/codexCliProtocol';
import type {
  NodeCliManagedFileHandle,
  NodeCliManagedFileSystemOperations,
} from '../../../../../src/infrastructure/providers/cli/nodeCliManagedFileSystem';
import {
  createNodeCodexManagedArtifactsForTest,
  type ManagedArtifactOptions,
} from '../../../../../src/infrastructure/providers/cli/nodeCodexManagedArtifacts';

const REQUEST_ID = '50000000-0000-4000-8000-000000000001';
const OTHER_REQUEST_ID = '50000000-0000-4000-8000-000000000002';
const RUNTIME_ROOT = 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers';
const PROFILE_ROOT = `${RUNTIME_ROOT}\\profiles`;
const TEMP_ROOT = `${RUNTIME_ROOT}\\temp`;
const WORKSPACE_ROOT = `${RUNTIME_ROOT}\\workspace`;
const CODEX_PROFILE_ROOT = `${PROFILE_ROOT}\\codex_cli`;
const CODEX_HOME = `${CODEX_PROFILE_ROOT}\\settings`;
const SCHEMA_PATH = `${TEMP_ROOT}\\${REQUEST_ID}\\output-schema.json`;

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const operation = (
  requestId = REQUEST_ID,
  controller = new AbortController(),
): ProviderConnectionOperation => Object.freeze({ requestId, signal: controller.signal });

class FakeFiles implements CliExecutableFileAccess {
  readonly calls: string[] = [];
  readonly files = new Map<string, string | Uint8Array>();
  readonly children = new Map<string, readonly string[]>();
  readonly missingDirectories = new Set<string>();
  readonly reparsePaths = new Set<string>();
  onRead: ((path: string) => void) | null = null;

  async canonicalize(path: string): Promise<string> {
    this.calls.push(`canonicalize:${path}`);
    if (this.missingDirectories.has(path)) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    return path;
  }

  async assertNoReparsePoints(path: string): Promise<void> {
    this.calls.push(`reparse:${path}`);
    if (this.reparsePaths.has(path)) throw new Error('private reparse target');
  }

  async readFile(path: string, limitBytes: number): Promise<Uint8Array> {
    this.calls.push(`read:${path}:${limitBytes}`);
    this.onRead?.(path);
    const value = this.files.get(path);
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return typeof value === 'string' ? new TextEncoder().encode(value) : value;
  }

  async listChildren(path: string): Promise<readonly string[]> {
    this.calls.push(`list:${path}`);
    if (this.missingDirectories.has(path)) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    const configured = this.children.get(path);
    if (configured !== undefined) return configured;
    return Object.freeze(
      [...this.files.keys()].filter((candidate) => win32.dirname(candidate) === path),
    );
  }
}

class FakeHasher implements CliFileHasher {
  constructor(private readonly files: FakeFiles) {}

  async sha256(path: string): Promise<string> {
    this.files.calls.push(`hash:${path}`);
    const value = this.files.files.get(path);
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return createHash('sha256').update(value).digest('hex');
  }
}

class FakePrivateDirectories implements CliPrivateDirectoryManager {
  readonly calls: string[] = [];
  failCleanup = false;
  leaveDirectoriesPresent = false;
  onPrepare: (() => void) | null = null;

  constructor(private readonly files: FakeFiles) {}

  async prepareProfile(providerId: string): Promise<void> {
    this.calls.push(`profile:${providerId}`);
    this.files.missingDirectories.delete(`${PROFILE_ROOT}\\${providerId}\\settings`);
  }

  async prepareRequest(providerId: string, requestId: string, cwd: string): Promise<void> {
    this.calls.push(`prepare:${providerId}:${requestId}:${cwd}`);
    this.files.missingDirectories.delete(cwd);
    this.files.missingDirectories.delete(`${TEMP_ROOT}\\${requestId}`);
    this.onPrepare?.();
  }

  async cleanupRequest(requestId: string, cwd: string): Promise<void> {
    this.calls.push(`cleanup:${requestId}:${cwd}`);
    if (this.failCleanup) throw new Error('private cleanup path');
    if (!this.leaveDirectoriesPresent) {
      this.files.missingDirectories.add(cwd);
      this.files.missingDirectories.add(`${TEMP_ROOT}\\${requestId}`);
    }
    for (const path of [...this.files.files.keys()]) {
      if (path.startsWith(`${TEMP_ROOT}\\${requestId}\\`) || path.startsWith(`${cwd}\\`)) {
        this.files.files.delete(path);
      }
    }
  }
}

class FakeOperations implements NodeCliManagedFileSystemOperations {
  readonly calls: string[] = [];
  onWrite: (() => void) | null = null;
  failRename = false;

  constructor(private readonly files: FakeFiles) {}

  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`);
  }

  async openExclusive(path: string): Promise<NodeCliManagedFileHandle> {
    this.calls.push(`open:${path}`);
    if (this.files.files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    let closed = false;
    return Object.freeze({
      write: async (contents: Uint8Array): Promise<void> => {
        this.calls.push(`write:${path}`);
        if (closed) throw new Error('closed');
        this.files.files.set(
          path,
          path.includes('image-') ? Uint8Array.from(contents) : new TextDecoder().decode(contents),
        );
        this.onWrite?.();
      },
      sync: async (): Promise<void> => {
        this.calls.push(`sync:${path}`);
        if (closed) throw new Error('closed');
      },
      close: async (): Promise<void> => {
        this.calls.push(`close:${path}`);
        closed = true;
      },
    });
  }

  async rename(source: string, target: string): Promise<void> {
    this.calls.push(`rename:${source}:${target}`);
    if (this.failRename) throw new Error('private rename path');
    const value = this.files.files.get(source);
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    this.files.files.delete(source);
    this.files.files.set(target, value);
  }

  async remove(path: string): Promise<void> {
    this.calls.push(`remove:${path}`);
    if (!this.files.files.delete(path)) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
  }
}

const harness = () => {
  const files = new FakeFiles();
  const privateDirectories = new FakePrivateDirectories(files);
  const operations = new FakeOperations(files);
  const options = Object.freeze({
    providerRuntimeRoot: RUNTIME_ROOT,
    providerProfilesRoot: PROFILE_ROOT,
    providerTempRoot: TEMP_ROOT,
    providerWorkspaceRoot: WORKSPACE_ROOT,
    files,
    hasher: new FakeHasher(files),
    privateDirectories,
  }) satisfies ManagedArtifactOptions;
  const artifacts = createNodeCodexManagedArtifactsForTest(options, operations);
  return { artifacts, files, operations, privateDirectories };
};

const expectedProfile = () =>
  createCodexManagedProfile(
    Object.freeze({
      providerRuntimeRoot: RUNTIME_ROOT,
      providerProfilesRoot: PROFILE_ROOT,
      providerTempRoot: TEMP_ROOT,
      providerWorkspaceRoot: WORKSPACE_ROOT,
    }),
  );

const allIoCalls = (subject: ReturnType<typeof harness>): readonly string[] =>
  Object.freeze([
    ...subject.files.calls,
    ...subject.operations.calls,
    ...subject.privateDirectories.calls,
  ]);

describe('node codex managed artifacts', () => {
  it('preserves a binary replaced during acquisition verification and refuses recursive cleanup', async () => {
    const subject = harness();
    const path = `${TEMP_ROOT}\\${REQUEST_ID}\\image-000.png`;
    const bytes = Uint8Array.from([0, 1, 255]);
    const replacement = Uint8Array.from([0, 2, 255]);
    subject.files.onRead = (readPath) => {
      if (readPath === path && subject.operations.calls.includes(`close:${path}`)) {
        subject.files.onRead = null;
        subject.files.files.set(path, replacement);
      }
    };
    await expect(
      subject.artifacts.prepareRequestAtomic(REQUEST_ID, '{}', operation(), [
        {
          fileName: 'image-000.png',
          bytes,
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ]),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(subject.files.files.get(path)).toEqual(replacement);
    expect(subject.files.files.get(SCHEMA_PATH)).toBe('{}');
    expect(subject.operations.calls).not.toContain(`remove:${path}`);
    expect(subject.privateDirectories.calls.some((call) => call.startsWith('cleanup:'))).toBe(
      false,
    );
  });

  it.each(['hash', 'reparse', 'extra'] as const)(
    'refuses mutated binary %s before accepting output and preserves suspicious trees',
    async (mutation) => {
      const subject = harness();
      const bytes = Uint8Array.from([0, 1, 255]);
      const input = {
        fileName: 'image-000.png',
        bytes,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const prepared = await subject.artifacts.prepareRequestAtomic(REQUEST_ID, '{}', operation(), [
        input,
      ]);
      const path = prepared.images?.[0]?.path ?? '';
      if (mutation === 'hash') subject.files.files.set(path, Uint8Array.from([0, 2, 255]));
      if (mutation === 'reparse') subject.files.reparsePaths.add(path);
      if (mutation === 'extra')
        subject.files.files.set(`${WORKSPACE_ROOT}\\${REQUEST_ID}\\foreign.png`, 'foreign');
      await expect(
        subject.artifacts.verifyRequest(REQUEST_ID, '{}', prepared.schemaSha256, operation()),
      ).rejects.toThrow();
      await expect(subject.artifacts.cleanupRequest(REQUEST_ID)).rejects.toThrow();
      expect(subject.files.files.has(path)).toBe(true);
    },
  );

  it('never deletes a pre-existing schema from an acquisition it did not own', async () => {
    const subject = harness();
    subject.files.files.set(SCHEMA_PATH, 'foreign');
    await expect(
      subject.artifacts.prepareRequestAtomic(REQUEST_ID, '{}', operation()),
    ).rejects.toThrow();
    await expect(subject.artifacts.cleanupRequest(REQUEST_ID)).rejects.toThrow();
    expect(subject.files.files.get(SCHEMA_PATH)).toBe('foreign');
  });
  it('owns exact declared binary images and refuses foreign cleanup or a duplicate acquisition', async () => {
    const subject = harness();
    const bytes = Uint8Array.from([137, 80, 78, 71, 0, 255]);
    const image = {
      fileName: 'image-000.png',
      bytes,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const prepared = await subject.artifacts.prepareRequestAtomic(REQUEST_ID, '{}', operation(), [
      image,
    ]);
    expect(prepared.images).toEqual([
      {
        fileName: 'image-000.png',
        path: `${TEMP_ROOT}\\${REQUEST_ID}\\image-000.png`,
        sizeBytes: bytes.length,
        sha256: image.sha256,
      },
    ]);
    const imagePath = prepared.images?.[0]?.path ?? '';
    expect(subject.files.files.get(imagePath)).toEqual(bytes);
    await subject.artifacts.verifyRequest(REQUEST_ID, '{}', prepared.schemaSha256, operation());
    await expect(
      subject.artifacts.prepareRequestAtomic(REQUEST_ID, '{}', operation(), [image]),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(subject.files.files.has(imagePath)).toBe(true);
    const foreign = `${TEMP_ROOT}\\${REQUEST_ID}\\foreign.txt`;
    subject.files.files.set(foreign, 'keep');
    await expect(subject.artifacts.cleanupRequest(REQUEST_ID)).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
    expect(subject.files.files.get(foreign)).toBe('keep');
    subject.files.files.delete(foreign);
    await subject.artifacts.cleanupRequest(REQUEST_ID);
    expect(subject.files.files.size).toBe(0);
  });
  it('writes and verifies only the request-scoped output schema expected by codex exec', async () => {
    const subject = harness();
    const schema = '{"type":"object"}';

    const result = await subject.artifacts.prepareRequestAtomic(REQUEST_ID, schema, operation());
    await subject.artifacts.verifyRequest(REQUEST_ID, schema, result.schemaSha256, operation());

    expect(result).toEqual({
      workspacePath: `${WORKSPACE_ROOT}\\${REQUEST_ID}`,
      schemaPath: SCHEMA_PATH,
      schemaSha256: sha256(schema),
    });
    expect(subject.files.files.get(SCHEMA_PATH)).toBe(schema);
    expect(subject.privateDirectories.calls).toContain(
      `prepare:codex_cli:${REQUEST_ID}:${WORKSPACE_ROOT}\\${REQUEST_ID}`,
    );
    expect([...subject.files.files.keys()]).toEqual([SCHEMA_PATH]);
    expect(
      [...subject.files.files.keys()].some((path) => /auth\.json|codex_auth\.age/iu.test(path)),
    ).toBe(false);
  });

  it('supports a schema larger than the credential input boundary without changing its filename', async () => {
    const subject = harness();
    const schema = JSON.stringify({ type: 'object', description: 'x'.repeat(8193) });

    const result = await subject.artifacts.prepareRequestAtomic(REQUEST_ID, schema, operation());
    await subject.artifacts.verifyRequest(REQUEST_ID, schema, result.schemaSha256, operation());

    expect(result.schemaPath).toBe(SCHEMA_PATH);
    expect(subject.files.files.get(SCHEMA_PATH)).toBe(schema);
  });

  it.each(['auth.json', 'codex_auth.age'])(
    'rejects forbidden Codex credential file %s',
    async (name) => {
      const subject = harness();
      subject.files.children.set(CODEX_HOME, [`${CODEX_HOME}\\${name}`]);

      await expect(
        subject.artifacts.prepareProfileAtomic(expectedProfile(), operation()),
      ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
      expect(subject.operations.calls).toEqual([]);
    },
  );

  it('prepares an initially missing Codex home without creating a profile or credential file', async () => {
    const subject = harness();
    subject.files.missingDirectories.add(CODEX_HOME);

    await subject.artifacts.prepareProfileAtomic(expectedProfile(), operation());
    await subject.artifacts.verifyProfile(expectedProfile(), operation());

    expect(subject.privateDirectories.calls).toEqual(['profile:codex_cli']);
    expect(subject.files.files.size).toBe(0);
    expect(subject.operations.calls).toEqual([]);
  });

  it('accepts only the exact canonical Codex managed profile and normalizes hostile accessors', async () => {
    const subject = harness();
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, 'managedProfilePath', {
      enumerable: true,
      get: () => {
        throw new Error('C:\\private\\profile');
      },
    });
    Object.defineProperty(hostile, 'codexHomePath', {
      enumerable: true,
      value: CODEX_HOME,
    });

    await expect(
      subject.artifacts.prepareProfileAtomic(
        hostile as unknown as ReturnType<typeof expectedProfile>,
        operation(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(allIoCalls(subject)).toEqual([]);
  });

  it.each([
    Object.freeze({
      managedProfilePath: CODEX_PROFILE_ROOT,
      codexHomePath: CODEX_HOME,
      toJSON: () => ({ managedProfilePath: CODEX_PROFILE_ROOT, codexHomePath: CODEX_HOME }),
    }),
    Object.defineProperty(
      { managedProfilePath: CODEX_PROFILE_ROOT, codexHomePath: CODEX_HOME },
      'hidden',
      { value: 'unexpected' },
    ),
  ])(
    'rejects a profile with serialization hooks or additional own keys before I/O',
    async (profile) => {
      const subject = harness();

      await expect(
        subject.artifacts.prepareProfileAtomic(
          profile as ReturnType<typeof expectedProfile>,
          operation(),
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
      expect(allIoCalls(subject)).toEqual([]);
    },
  );

  it('rejects invalid and cross-request identifiers before any filesystem call', async () => {
    const invalid = harness();
    await expect(
      invalid.artifacts.prepareRequestAtomic('..\\other-request', '{}', operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(allIoCalls(invalid)).toEqual([]);

    const crossed = harness();
    await expect(
      crossed.artifacts.prepareRequestAtomic(REQUEST_ID, '{}', operation(OTHER_REQUEST_ID)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(allIoCalls(crossed)).toEqual([]);
  });

  it('rejects an invalid verification identifier before inspecting any derived path', async () => {
    const subject = harness();

    await expect(
      subject.artifacts.verifyRequest('..\\other-request', '{}', sha256('{}'), operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(allIoCalls(subject)).toEqual([]);
  });

  it('normalizes a non-string schema before touching request directories', async () => {
    const subject = harness();

    await expect(
      subject.artifacts.prepareRequestAtomic(REQUEST_ID, null as unknown as string, operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(allIoCalls(subject)).toEqual([]);
  });

  it('performs zero filesystem calls when profile, prepare, or verify starts aborted', async () => {
    const cases = [
      (subject: ReturnType<typeof harness>, op: ProviderConnectionOperation) =>
        subject.artifacts.prepareProfileAtomic(expectedProfile(), op),
      (subject: ReturnType<typeof harness>, op: ProviderConnectionOperation) =>
        subject.artifacts.verifyProfile(expectedProfile(), op),
      (subject: ReturnType<typeof harness>, op: ProviderConnectionOperation) =>
        subject.artifacts.prepareRequestAtomic(REQUEST_ID, '{}', op),
      (subject: ReturnType<typeof harness>, op: ProviderConnectionOperation) =>
        subject.artifacts.verifyRequest(REQUEST_ID, '{}', sha256('{}'), op),
    ] as const;

    for (const invoke of cases) {
      const subject = harness();
      const controller = new AbortController();
      controller.abort();
      await expect(invoke(subject, operation(REQUEST_ID, controller))).rejects.toMatchObject({
        code: 'PROVIDER_CANCELLED',
      });
      expect(allIoCalls(subject)).toEqual([]);
    }
  });

  it('rejects a tampered schema snapshot and an injected request credential file', async () => {
    const subject = harness();
    const schema = '{"type":"object"}';
    const prepared = await subject.artifacts.prepareRequestAtomic(REQUEST_ID, schema, operation());
    subject.files.files.set(prepared.schemaPath, '{"type":"array"}');

    await expect(
      subject.artifacts.verifyRequest(REQUEST_ID, schema, prepared.schemaSha256, operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });

    subject.files.files.set(prepared.schemaPath, schema);
    subject.files.files.set(`${TEMP_ROOT}\\${REQUEST_ID}\\auth.json`, 'secret');
    await expect(
      subject.artifacts.verifyRequest(REQUEST_ID, schema, prepared.schemaSha256, operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
  });

  it('rejects a reparse point at the exact derived schema path', async () => {
    const subject = harness();
    const schema = '{}';
    const prepared = await subject.artifacts.prepareRequestAtomic(REQUEST_ID, schema, operation());
    subject.files.reparsePaths.add(prepared.schemaPath);

    await expect(
      subject.artifacts.verifyRequest(REQUEST_ID, schema, prepared.schemaSha256, operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
  });

  it('cancels after private-directory preparation before creating an atomic temp file', async () => {
    const subject = harness();
    const controller = new AbortController();
    subject.privateDirectories.onPrepare = () => controller.abort();

    await expect(
      subject.artifacts.prepareRequestAtomic(REQUEST_ID, '{}', operation(REQUEST_ID, controller)),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(subject.operations.calls.some((call) => call.startsWith('open:'))).toBe(false);
    expect(subject.privateDirectories.calls.some((call) => call.startsWith('cleanup:'))).toBe(true);
  });

  it('uses bounded cleanup after cancellation once an app-owned temp exists', async () => {
    const subject = harness();
    const controller = new AbortController();
    subject.operations.onWrite = () => controller.abort();

    await expect(
      subject.artifacts.prepareRequestAtomic(
        REQUEST_ID,
        '{"type":"object"}',
        operation(REQUEST_ID, controller),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });

    expect([...subject.files.files.keys()]).toEqual([]);
    expect(subject.operations.calls.some((call) => call.startsWith('remove:'))).toBe(true);
    expect(subject.operations.calls.some((call) => call.startsWith('rename:'))).toBe(false);
  });

  it('cleans only the derived request workspace and reports an unproven cleanup as residual data', async () => {
    const success = harness();
    await success.artifacts.prepareRequestAtomic(REQUEST_ID, '{}', operation());
    await success.artifacts.cleanupRequest(REQUEST_ID);
    expect(success.privateDirectories.calls.at(-1)).toBe(
      `cleanup:${REQUEST_ID}:${WORKSPACE_ROOT}\\${REQUEST_ID}`,
    );
    expect(success.files.files.has(SCHEMA_PATH)).toBe(false);

    const failure = harness();
    failure.privateDirectories.failCleanup = true;
    await expect(failure.artifacts.cleanupRequest(REQUEST_ID)).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
  });

  it('reports residual data when cleanup returns but directory absence cannot be proven', async () => {
    const subject = harness();
    subject.privateDirectories.leaveDirectoriesPresent = true;

    await expect(subject.artifacts.cleanupRequest(REQUEST_ID)).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
  });

  it('rejects a malformed cleanup identifier without deriving or deleting a path', async () => {
    const subject = harness();

    await expect(subject.artifacts.cleanupRequest(null as unknown as string)).rejects.toMatchObject(
      { code: 'PROVIDER_RESIDUAL_DATA' },
    );
    expect(allIoCalls(subject)).toEqual([]);
  });

  it('normalizes raw atomic-write failures without exposing private paths', async () => {
    const subject = harness();
    subject.operations.failRename = true;

    let failure: unknown;
    try {
      await subject.artifacts.prepareRequestAtomic(REQUEST_ID, '{}', operation());
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(JSON.stringify(failure)).not.toContain('private rename path');
  });
});
