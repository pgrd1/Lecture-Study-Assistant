import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderConnectionOperation } from '../../../../../src/core/ports/aiProvider';
import type {
  CliExecutableFileAccess,
  CliFileHasher,
} from '../../../../../src/infrastructure/providers/cli/cliFileIntegrity';
import { bindingHash } from '../../../../../src/infrastructure/providers/cli/cliIdentity';
import type { CliPrivateDirectoryManager } from '../../../../../src/infrastructure/providers/cli/cliPrivateDirectories';
import {
  assertGeminiRoots,
  createGeminiManagedProfile,
  type GeminiBinding,
} from '../../../../../src/infrastructure/providers/cli/geminiCliProtocol';
import type {
  NodeCliManagedFileHandle,
  NodeCliManagedFileSystemOperations,
} from '../../../../../src/infrastructure/providers/cli/nodeCliManagedFileSystem';
import {
  createNodeGeminiManagedArtifactsForTest,
  type ManagedArtifactOptions,
} from '../../../../../src/infrastructure/providers/cli/nodeGeminiManagedArtifacts';
import { parseSafeSemVer } from '../../../../../src/shared/contracts/provider';

const requestId = '50000000-0000-4000-8000-000000000001';
const otherRequestId = '50000000-0000-4000-8000-000000000002';
const runtimeRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers';
const profileRoot = `${runtimeRoot}\\profiles`;
const tempRoot = `${runtimeRoot}\\temp`;
const workspaceRoot = `${runtimeRoot}\\workspace`;
const schemaPath =
  'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\settings.schema.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const operation = (
  id = requestId,
  signal: AbortSignal = new AbortController().signal,
): ProviderConnectionOperation => Object.freeze({ requestId: id, signal });

class FakeHandle implements NodeCliManagedFileHandle {
  readonly chunks: Uint8Array[] = [];
  closed = false;
  synced = false;

  constructor(
    readonly path: string,
    readonly fs: FakeManagedFs,
  ) {}

  async write(contents: Uint8Array): Promise<void> {
    this.fs.calls.push(`write:${this.path}:${contents.byteLength}`);
    this.chunks.push(Uint8Array.from(contents));
  }

  async sync(): Promise<void> {
    this.fs.calls.push(`sync:${this.path}`);
    this.synced = true;
  }

  async close(): Promise<void> {
    this.fs.calls.push(`close:${this.path}`);
    this.closed = true;
    const size = this.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const contents = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.chunks) {
      contents.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.fs.files.set(this.path, contents);
  }
}

class FakeManagedFs implements NodeCliManagedFileSystemOperations {
  readonly calls: string[] = [];
  readonly files = new Map<string, Uint8Array>();
  readonly handles: FakeHandle[] = [];
  readonly directories = new Set<string>();

  exists(path: string): boolean {
    if (this.files.has(path) || this.directories.has(path)) return true;
    const prefix = `${path}\\`;
    return (
      [...this.files.keys()].some((candidate) => candidate.startsWith(prefix)) ||
      [...this.directories].some((candidate) => candidate.startsWith(prefix))
    );
  }

  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`);
    this.directories.add(path);
  }

  async openExclusive(path: string): Promise<NodeCliManagedFileHandle> {
    this.calls.push(`open:${path}`);
    if (!this.exists(win32.dirname(path))) {
      throw Object.assign(new Error('missing parent'), { code: 'ENOENT' });
    }
    if (this.files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    const handle = new FakeHandle(path, this);
    this.handles.push(handle);
    return handle;
  }

  async rename(source: string, target: string): Promise<void> {
    this.calls.push(`rename:${source}:${target}`);
    const contents = this.files.get(source);
    if (contents === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    this.files.delete(source);
    this.files.set(target, contents);
  }

  async remove(path: string): Promise<void> {
    this.calls.push(`remove:${path}`);
    if (!this.files.delete(path)) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
  }
}

class FakeFiles implements CliExecutableFileAccess {
  readonly calls: string[] = [];
  reparseAt: string | null = null;
  canonicalizeTo: string | null = null;
  readFailure: Error | null = null;
  afterRead: ((path: string) => void) | null = null;

  constructor(readonly fs: FakeManagedFs) {}

  async canonicalize(path: string, _operation: ProviderConnectionOperation): Promise<string> {
    this.calls.push(`canonicalize:${path}`);
    if (!this.fs.exists(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return this.canonicalizeTo ?? path;
  }

  async assertNoReparsePoints(
    path: string,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {
    this.calls.push(`reparse:${path}`);
    if (this.reparseAt === path) throw Object.assign(new Error('reparse'), { code: 'ELOOP' });
    if (!this.fs.exists(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }

  async readFile(
    path: string,
    _limitBytes: number,
    _operation: ProviderConnectionOperation,
  ): Promise<Uint8Array> {
    this.calls.push(`read:${path}`);
    if (this.readFailure !== null) throw this.readFailure;
    const contents = this.fs.files.get(path);
    if (contents === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    this.afterRead?.(path);
    return Uint8Array.from(contents);
  }

  async listChildren(
    path: string,
    _operation: ProviderConnectionOperation,
  ): Promise<readonly string[]> {
    this.calls.push(`list:${path}`);
    if (!this.fs.directories.has(path) && !this.fs.exists(path)) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    const children = new Set<string>();
    for (const candidate of [...this.fs.files.keys(), ...this.fs.directories]) {
      const relative = win32.relative(path, candidate);
      if (relative.length === 0 || relative.startsWith('..') || win32.isAbsolute(relative)) {
        continue;
      }
      const [name] = relative.split('\\');
      if (name !== undefined) children.add(win32.join(path, name));
    }
    return Object.freeze([...children].sort());
  }
}

class FakeHasher implements CliFileHasher {
  constructor(readonly fs: FakeManagedFs) {}

  async sha256(path: string, _operation: ProviderConnectionOperation): Promise<string> {
    const contents = this.fs.files.get(path);
    if (contents === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return sha256(contents);
  }
}

class FakePrivateDirectories implements CliPrivateDirectoryManager {
  readonly profiles: string[] = [];
  readonly prepared: string[] = [];
  readonly cleaned: string[] = [];

  constructor(readonly fs: FakeManagedFs) {}

  async prepareProfile(providerId: string, _operation: ProviderConnectionOperation): Promise<void> {
    this.profiles.push(providerId);
    const managedProfile = win32.join(profileRoot, providerId);
    for (const path of [
      runtimeRoot,
      profileRoot,
      tempRoot,
      workspaceRoot,
      managedProfile,
      win32.join(managedProfile, 'user'),
      win32.join(managedProfile, 'user', 'AppData'),
      win32.join(managedProfile, 'user', 'AppData', 'Roaming'),
      win32.join(managedProfile, 'user', 'AppData', 'Local'),
      win32.join(managedProfile, 'settings'),
    ]) {
      this.fs.directories.add(path);
    }
  }

  async prepareRequest(
    providerId: string,
    id: string,
    cwd: string,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {
    this.prepared.push(`${providerId}:${id}:${cwd}`);
    this.fs.directories.add(cwd);
    this.fs.directories.add(win32.join(tempRoot, id));
  }

  async cleanupRequest(id: string, cwd: string): Promise<void> {
    this.cleaned.push(`${id}:${cwd}`);
    for (const path of [...this.fs.files.keys()]) {
      if (path === cwd || path.startsWith(`${cwd}\\`)) this.fs.files.delete(path);
    }
    const requestTemp = win32.join(tempRoot, id);
    for (const path of [...this.fs.directories]) {
      if (
        path === cwd ||
        path.startsWith(`${cwd}\\`) ||
        path === requestTemp ||
        path.startsWith(`${requestTemp}\\`)
      ) {
        this.fs.directories.delete(path);
      }
    }
  }
}

const identity = Object.freeze({
  providerId: 'gemini_cli' as const,
  version: '0.55.1',
  recipeId: 'gemini-0.55-policy-json-v1',
  credentialScope: 'provider_global' as const,
  signerClassification: 'nodejs' as const,
  launcherSha256: 'a'.repeat(64),
  entrySha256: 'b'.repeat(64),
  packageManifestSha256: 'c'.repeat(64),
  platformPackageManifestSha256: null,
});

const binding = Object.freeze({
  providerId: identity.providerId,
  canonicalLauncherPath: 'C:\\Program Files\\nodejs\\node.exe',
  canonicalEntryPath:
    'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js',
  canonicalPackageManifestPath:
    'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\package.json',
  canonicalPlatformPackageManifestPath: null,
  fixedPrefixArgs: Object.freeze([
    'C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js',
  ]),
  version: parseSafeSemVer(identity.version),
  launcherSha256: identity.launcherSha256,
  entrySha256: identity.entrySha256,
  packageManifestSha256: identity.packageManifestSha256,
  platformPackageManifestSha256: identity.platformPackageManifestSha256,
  bindingSha256: bindingHash(identity),
  recipeId: identity.recipeId,
  credentialScope: identity.credentialScope,
  signerClassification: identity.signerClassification,
  checkedAt: '2026-09-03T00:00:00.000Z',
}) satisfies GeminiBinding;

const canonicalProfile = createGeminiManagedProfile(assertGeminiRoots(runtimeRoot));

const harness = () => {
  const fs = new FakeManagedFs();
  const files = new FakeFiles(fs);
  const privateDirectories = new FakePrivateDirectories(fs);
  const options = Object.freeze({
    providerRuntimeRoot: runtimeRoot,
    providerProfilesRoot: profileRoot,
    providerTempRoot: tempRoot,
    providerWorkspaceRoot: workspaceRoot,
    files,
    hasher: new FakeHasher(fs),
    privateDirectories,
  }) satisfies ManagedArtifactOptions;
  return {
    fs,
    files,
    privateDirectories,
    artifacts: createNodeGeminiManagedArtifactsForTest(options, fs),
  };
};

const put = (fs: FakeManagedFs, path: string, contents: string): void => {
  fs.files.set(path, encoder.encode(contents));
};

const expectProviderCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof Error && 'code' in error && error.code === code;

describe('node gemini managed artifacts', () => {
  it.each([
    'tmp\\project\\chats\\session.jsonl',
    'history\\project\\snapshot',
    'projects.json',
    'GEMINI.md',
    'oauth_creds.json',
  ])(
    'does not bless or delete stock private-home artifact %s as disabled history',
    async (relativePath) => {
      const { artifacts, fs } = harness();
      await artifacts.writeProfileAtomic(canonicalProfile, operation());
      const file = win32.join(win32.dirname(canonicalProfile.settingsPath), relativePath);
      put(fs, file, 'original private data');
      await expect(artifacts.verifyProfile(canonicalProfile, operation())).rejects.toSatisfy(
        expectProviderCode('PROVIDER_RESIDUAL_DATA'),
      );
      await artifacts.cleanupProfileTransients();
      expect(decoder.decode(fs.files.get(file))).toBe('original private data');
      await expect(artifacts.verifyProfile(canonicalProfile, operation())).rejects.toSatisfy(
        expectProviderCode('PROVIDER_RESIDUAL_DATA'),
      );
    },
  );
  it('binds a fatal UTF-8 schema snapshot to the verified manifest and rechecks the path', async () => {
    const { artifacts, files, fs } = harness();
    put(fs, schemaPath, '{"type":"object"}');

    await expect(artifacts.readSettingsSchemaSnapshot(binding, operation())).resolves.toEqual({
      packageManifestSha256: 'c'.repeat(64),
      relativePath: 'settings.schema.json',
      schemaSha256: sha256('{"type":"object"}'),
      contents: '{"type":"object"}',
    });
    expect(files.calls).toEqual([
      `reparse:${schemaPath}`,
      `canonicalize:${schemaPath}`,
      `reparse:${schemaPath}`,
      `read:${schemaPath}`,
      `reparse:${schemaPath}`,
      `canonicalize:${schemaPath}`,
      `reparse:${schemaPath}`,
    ]);
  });

  it('normalizes malformed bindings and raw schema failures without exposing details', async () => {
    const malformed = Object.freeze({
      ...binding,
      canonicalPackageManifestPath: null,
      packageManifestSha256: null,
    }) as unknown as GeminiBinding;
    const first = harness();

    await expect(
      first.artifacts.readSettingsSchemaSnapshot(malformed, operation()),
    ).rejects.toSatisfy(expectProviderCode('PROVIDER_UNSAFE_VERSION'));
    expect(first.files.calls).toEqual([]);

    const second = harness();
    second.files.readFailure = new Error('C:\\private\\schema-path');
    await expect(
      second.artifacts.readSettingsSchemaSnapshot(binding, operation()),
    ).rejects.toSatisfy(expectProviderCode('PROVIDER_UNSAFE_VERSION'));
  });

  it('rejects invalid UTF-8 and oversized schema snapshots', async () => {
    const invalid = harness();
    invalid.fs.files.set(schemaPath, Uint8Array.from([0xc3, 0x28]));
    await expect(
      invalid.artifacts.readSettingsSchemaSnapshot(binding, operation()),
    ).rejects.toSatisfy(expectProviderCode('PROVIDER_UNSAFE_VERSION'));

    const oversized = harness();
    oversized.fs.files.set(schemaPath, new Uint8Array(1024 * 1024 + 1));
    await expect(
      oversized.artifacts.readSettingsSchemaSnapshot(binding, operation()),
    ).rejects.toSatisfy(expectProviderCode('PROVIDER_UNSAFE_VERSION'));
  });

  it('performs zero file operations when schema reading is already cancelled', async () => {
    const { artifacts, files, fs } = harness();
    put(fs, schemaPath, '{"type":"object"}');
    const controller = new AbortController();
    controller.abort();

    await expect(
      artifacts.readSettingsSchemaSnapshot(binding, operation(requestId, controller.signal)),
    ).rejects.toSatisfy(expectProviderCode('PROVIDER_CANCELLED'));
    expect(files.calls).toEqual([]);
  });

  it('stops after a schema read when cancellation wins the next checkpoint', async () => {
    const { artifacts, files, fs } = harness();
    put(fs, schemaPath, '{"type":"object"}');
    const controller = new AbortController();
    files.afterRead = () => controller.abort();

    await expect(
      artifacts.readSettingsSchemaSnapshot(binding, operation(requestId, controller.signal)),
    ).rejects.toSatisfy(expectProviderCode('PROVIDER_CANCELLED'));
    expect(files.calls).toEqual([
      `reparse:${schemaPath}`,
      `canonicalize:${schemaPath}`,
      `reparse:${schemaPath}`,
      `read:${schemaPath}`,
    ]);
  });

  it('writes and verifies only the canonical three-level Gemini profile', async () => {
    const { artifacts, fs, privateDirectories } = harness();

    await artifacts.writeProfileAtomic(canonicalProfile, operation());
    await expect(artifacts.verifyProfile(canonicalProfile, operation())).resolves.toBeUndefined();

    expect(decoder.decode(fs.files.get(canonicalProfile.settingsPath))).toBe(
      canonicalProfile.settingsJson,
    );
    expect(decoder.decode(fs.files.get(canonicalProfile.policyPath))).toBe(
      canonicalProfile.policyText,
    );
    expect([...fs.files.keys()].filter((path) => path.endsWith('.tmp'))).toEqual([]);
    expect([...fs.files.keys()].sort()).toEqual(
      [canonicalProfile.policyPath, canonicalProfile.settingsPath].sort(),
    );
    expect(privateDirectories.profiles).toEqual(['gemini_cli']);
  });

  it('rejects a noncanonical profile before any filesystem operation', async () => {
    const { artifacts, files, fs } = harness();
    const altered = Object.freeze({ ...canonicalProfile, settingsJson: '{}' });

    await expect(artifacts.writeProfileAtomic(altered, operation())).rejects.toSatisfy(
      expectProviderCode('PROVIDER_UNSAFE_VERSION'),
    );
    expect(files.calls).toEqual([]);
    expect(fs.calls).toEqual([]);
  });

  it.each(['auth.json', 'codex_auth.age', 'oauth_creds.json', 'gemini-credentials.json'])(
    'rejects credential artifact %s in the protocol-owned settings tree',
    async (fileName) => {
      const { artifacts, fs } = harness();
      put(fs, `${canonicalProfile.geminiCliHomePath}\\${fileName}`, 'secret');

      await expect(artifacts.writeProfileAtomic(canonicalProfile, operation())).rejects.toSatisfy(
        expectProviderCode('PROVIDER_RESIDUAL_DATA'),
      );
      expect(fs.handles).toHaveLength(0);
    },
  );

  it('allows the infrastructure-owned isolated user tree beside Gemini settings', async () => {
    const { artifacts, fs } = harness();
    put(
      fs,
      `${canonicalProfile.managedProfilePath}\\user\\AppData\\Roaming\\desktop.ini`,
      'infrastructure-owned',
    );

    await expect(
      artifacts.writeProfileAtomic(canonicalProfile, operation()),
    ).resolves.toBeUndefined();
    await expect(artifacts.verifyProfile(canonicalProfile, operation())).resolves.toBeUndefined();
  });

  it('rejects an unexpected nested profile file before writing managed settings', async () => {
    const { artifacts, fs } = harness();
    put(fs, `${canonicalProfile.geminiCliHomePath}\\policies\\extra.toml`, 'allow');

    await expect(artifacts.writeProfileAtomic(canonicalProfile, operation())).rejects.toSatisfy(
      expectProviderCode('PROVIDER_RESIDUAL_DATA'),
    );
    expect(fs.handles).toHaveLength(0);
  });

  it('detects profile content tampering during verification', async () => {
    const { artifacts, fs } = harness();
    await artifacts.writeProfileAtomic(canonicalProfile, operation());
    put(fs, canonicalProfile.settingsPath, '{}');

    await expect(artifacts.verifyProfile(canonicalProfile, operation())).rejects.toSatisfy(
      expectProviderCode('PROVIDER_UNSAFE_VERSION'),
    );
  });

  it('detects an unexpected file injected while exact profile files are being verified', async () => {
    const { artifacts, files, fs } = harness();
    await artifacts.writeProfileAtomic(canonicalProfile, operation());
    let policyReads = 0;
    files.afterRead = (path) => {
      if (path !== canonicalProfile.policyPath) return;
      policyReads += 1;
      if (policyReads === 2) {
        put(fs, `${canonicalProfile.geminiCliHomePath}\\injected.json`, '{}');
      }
    };

    await expect(artifacts.verifyProfile(canonicalProfile, operation())).rejects.toSatisfy(
      expectProviderCode('PROVIDER_RESIDUAL_DATA'),
    );
  });

  it('prepares, verifies, and cleans only the UUID-derived workspace', async () => {
    const { artifacts, privateDirectories } = harness();

    await expect(artifacts.prepareRequestAtomic(requestId, operation())).resolves.toEqual({
      workspacePath: `${workspaceRoot}\\${requestId}`,
    });
    await expect(artifacts.verifyRequest(requestId, operation())).resolves.toBeUndefined();
    await expect(artifacts.cleanupRequest(requestId)).resolves.toBeUndefined();
    expect(privateDirectories.prepared).toEqual([
      `gemini_cli:${requestId}:${workspaceRoot}\\${requestId}`,
    ]);
    expect(privateDirectories.cleaned).toEqual([`${requestId}:${workspaceRoot}\\${requestId}`]);
  });

  it('rejects an unexpected file in the request temp directory during verification', async () => {
    const { artifacts, fs } = harness();
    const requestTemp = `${tempRoot}\\${requestId}`;
    await artifacts.prepareRequestAtomic(requestId, operation());
    put(fs, `${requestTemp}\\unexpected.json`, '{}');

    await expect(artifacts.verifyRequest(requestId, operation())).rejects.toSatisfy(
      expectProviderCode('PROVIDER_RESIDUAL_DATA'),
    );
  });

  it('rejects path injection and cross-request operations before side effects', async () => {
    const injected = '..\\auth.json';
    const first = harness();
    await expect(
      first.artifacts.prepareRequestAtomic(injected, operation(injected)),
    ).rejects.toSatisfy(expectProviderCode('PROVIDER_UNSAFE_VERSION'));
    expect(first.privateDirectories.prepared).toEqual([]);
    expect(first.files.calls).toEqual([]);

    const second = harness();
    await expect(
      second.artifacts.verifyRequest(otherRequestId, operation(requestId)),
    ).rejects.toSatisfy(expectProviderCode('PROVIDER_UNSAFE_VERSION'));
    expect(second.files.calls).toEqual([]);

    const third = harness();
    await expect(third.artifacts.cleanupRequest(injected)).rejects.toSatisfy(
      expectProviderCode('PROVIDER_UNSAFE_VERSION'),
    );
    expect(third.privateDirectories.cleaned).toEqual([]);
  });

  it('performs zero request operations when preparation is already cancelled', async () => {
    const { artifacts, files, fs, privateDirectories } = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      artifacts.prepareRequestAtomic(requestId, operation(requestId, controller.signal)),
    ).rejects.toSatisfy(expectProviderCode('PROVIDER_CANCELLED'));
    expect(files.calls).toEqual([]);
    expect(fs.calls).toEqual([]);
    expect(privateDirectories.prepared).toEqual([]);
  });

  it('normalizes a schema reparse point as an unsafe provider version', async () => {
    const { artifacts, files, fs } = harness();
    put(fs, schemaPath, '{"type":"object"}');
    files.reparseAt = schemaPath;

    await expect(artifacts.readSettingsSchemaSnapshot(binding, operation())).rejects.toSatisfy(
      expectProviderCode('PROVIDER_UNSAFE_VERSION'),
    );
  });

  it('rejects a schema path whose canonical identity resolves elsewhere before reading it', async () => {
    const { artifacts, files, fs } = harness();
    put(fs, schemaPath, '{"type":"object"}');
    files.canonicalizeTo = `${win32.dirname(schemaPath)}\\other-schema.json`;

    await expect(artifacts.readSettingsSchemaSnapshot(binding, operation())).rejects.toSatisfy(
      expectProviderCode('PROVIDER_UNSAFE_VERSION'),
    );
    expect(files.calls).not.toContain(`read:${schemaPath}`);
  });
});
