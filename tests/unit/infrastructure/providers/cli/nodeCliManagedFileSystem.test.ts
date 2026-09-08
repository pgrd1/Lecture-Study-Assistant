import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProviderConnectionOperation } from '../../../../../src/core/ports/aiProvider';
import type {
  CliExecutableFileAccess,
  CliFileHasher,
} from '../../../../../src/infrastructure/providers/cli/cliFileIntegrity';
import type { CliPrivateDirectoryManager } from '../../../../../src/infrastructure/providers/cli/cliPrivateDirectories';
import {
  createNodeCliManagedFileSystemForTest,
  type ManagedArtifactOptions,
  type NodeCliManagedFileHandle,
  type NodeCliManagedFileSystemOperations,
} from '../../../../../src/infrastructure/providers/cli/nodeCliManagedFileSystem';

const requestId = '50000000-0000-4000-8000-000000000001';
const runtimeRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers';
const profileRoot = `${runtimeRoot}\\profiles`;
const tempRoot = `${runtimeRoot}\\temp`;
const workspaceRoot = `${runtimeRoot}\\workspace`;
const outputPath = `${tempRoot}\\${requestId}\\output-schema.json`;
const workspacePath = `${workspaceRoot}\\${requestId}`;

const operation = (signal: AbortSignal = new AbortController().signal) =>
  Object.freeze({ requestId, signal }) satisfies ProviderConnectionOperation;

const sha256 = (contents: string): string => createHash('sha256').update(contents).digest('hex');
const filesystemError = (code: string): Error & { readonly code: string } =>
  Object.assign(new Error(`private ${code} path detail`), { code });

class FakeManagedFs implements NodeCliManagedFileSystemOperations {
  readonly calls: string[] = [];
  readonly files = new Map<string, string>();
  readonly handles: FakeHandle[] = [];
  maxWriteBytes = Number.POSITIVE_INFINITY;
  openCollision = false;
  closeFails = false;
  renameFails = false;
  renameTamper: string | null = null;
  removeFails = false;
  removeLeavesPath = false;
  onCall: ((call: string) => void) | null = null;
  onMkdir: ((path: string) => void) | null = null;

  async record(call: string): Promise<void> {
    this.calls.push(call);
    this.onCall?.(call);
  }

  async mkdir(path: string): Promise<void> {
    await this.record(`mkdir:${path}`);
    this.onMkdir?.(path);
  }

  async openExclusive(path: string): Promise<NodeCliManagedFileHandle> {
    await this.record(`open:${path}`);
    if (this.openCollision || this.files.has(path)) throw filesystemError('EEXIST');
    this.files.set(path, '');
    const handle = new FakeHandle(path, this);
    this.handles.push(handle);
    return handle;
  }

  async rename(source: string, target: string): Promise<void> {
    await this.record(`rename:${source}:${target}`);
    if (this.renameFails) throw filesystemError('ENOENT');
    const value = this.files.get(source);
    if (value === undefined) throw filesystemError('ENOENT');
    this.files.delete(source);
    this.files.set(target, this.renameTamper ?? value);
  }

  async remove(path: string): Promise<void> {
    await this.record(`remove:${path}`);
    if (this.removeFails) throw new Error('private cleanup detail');
    if (!this.files.has(path)) throw filesystemError('ENOENT');
    if (!this.removeLeavesPath) this.files.delete(path);
  }
}

class FakeHandle implements NodeCliManagedFileHandle {
  readonly bytes: number[] = [];
  closed = false;
  synced = false;

  constructor(
    readonly path: string,
    readonly fs: FakeManagedFs,
  ) {}

  async write(contents: Uint8Array, offset = 0, length = contents.byteLength): Promise<number> {
    const written = Math.min(length, this.fs.maxWriteBytes);
    await this.fs.record(`write:${this.path}:${offset}:${length}:${written}`);
    this.bytes.push(...contents.subarray(offset, offset + written));
    return written;
  }

  async sync(): Promise<void> {
    await this.fs.record(`sync:${this.path}`);
    this.synced = true;
  }

  async close(): Promise<void> {
    await this.fs.record(`close:${this.path}`);
    if (this.fs.closeFails) throw new Error('private close detail');
    this.closed = true;
    this.fs.files.set(this.path, new TextDecoder().decode(Uint8Array.from(this.bytes)));
  }
}

class FakeFiles implements CliExecutableFileAccess {
  readonly calls: string[] = [];
  readonly children = new Map<string, readonly string[]>();
  readonly missing = new Set<string>();
  readonly byteOverrides = new Map<string, Uint8Array>();
  readonly seenOperations: ProviderConnectionOperation[] = [];
  reparseAt: string | null = null;
  reparseAfterRead = false;
  obscureMissing = false;

  constructor(readonly fs: FakeManagedFs) {}

  async record(call: string, currentOperation: ProviderConnectionOperation): Promise<void> {
    this.calls.push(call);
    this.seenOperations.push(currentOperation);
    await this.fs.record(call);
  }

  async canonicalize(path: string, currentOperation: ProviderConnectionOperation): Promise<string> {
    await this.record(`canonicalize:${path}`, currentOperation);
    if (this.missing.has(path)) throw filesystemError('ENOENT');
    return path;
  }

  async assertNoReparsePoints(
    path: string,
    currentOperation: ProviderConnectionOperation,
  ): Promise<void> {
    await this.record(`reparse:${path}`, currentOperation);
    if (
      this.reparseAt === path ||
      (this.reparseAfterRead && this.calls.some((call) => call.startsWith('read:')))
    ) {
      throw filesystemError('ELOOP');
    }
  }

  async readFile(
    path: string,
    _limitBytes: number,
    currentOperation: ProviderConnectionOperation,
  ): Promise<Uint8Array> {
    await this.record(`read:${path}`, currentOperation);
    const bytes = this.byteOverrides.get(path);
    if (bytes !== undefined) return Uint8Array.from(bytes);
    const value = this.fs.files.get(path);
    if (value === undefined) {
      if (this.obscureMissing) throw filesystemError('EACCES');
      throw filesystemError('ENOENT');
    }
    return new TextEncoder().encode(value);
  }

  async listChildren(
    path: string,
    currentOperation: ProviderConnectionOperation,
  ): Promise<readonly string[]> {
    await this.record(`list:${path}`, currentOperation);
    if (this.missing.has(path)) throw filesystemError('ENOENT');
    return this.children.get(path) ?? [];
  }
}

class FakeHasher implements CliFileHasher {
  readonly calls: string[] = [];
  override: string | null = null;

  constructor(readonly fs: FakeManagedFs) {}

  async sha256(path: string, _operation: ProviderConnectionOperation): Promise<string> {
    this.calls.push(path);
    await this.fs.record(`hash:${path}`);
    const value = this.fs.files.get(path);
    if (value === undefined) throw filesystemError('ENOENT');
    return this.override ?? sha256(value);
  }
}

class FakePrivateDirectories implements CliPrivateDirectoryManager {
  readonly prepared: string[] = [];
  readonly profilesPrepared: string[] = [];
  readonly cleaned: string[] = [];
  prepareFails = false;
  cleanupFails = false;
  cleanupLeavesResidual = false;
  onPrepare: (() => void) | null = null;

  constructor(
    readonly fs: FakeManagedFs,
    readonly files: FakeFiles,
  ) {}

  async prepareProfile(providerId: string, _operation: ProviderConnectionOperation): Promise<void> {
    await this.fs.record(`private-profile:${providerId}`);
    this.profilesPrepared.push(providerId);
    this.files.missing.delete(`${profileRoot}\\${providerId}\\settings`);
  }

  async prepareRequest(
    providerId: string,
    id: string,
    cwd: string,
    _operation: ProviderConnectionOperation,
  ): Promise<void> {
    await this.fs.record(`private-prepare:${providerId}:${id}:${cwd}`);
    this.prepared.push(`${providerId}:${id}:${cwd}`);
    if (this.prepareFails) throw new Error('private prepare detail');
    this.files.missing.delete(cwd);
    this.files.missing.delete(`${tempRoot}\\${id}`);
    this.onPrepare?.();
  }

  async cleanupRequest(id: string, cwd: string): Promise<void> {
    await this.fs.record(`private-cleanup:${id}:${cwd}`);
    this.cleaned.push(`${id}:${cwd}`);
    if (this.cleanupFails) throw new Error('private cleanup detail');
    if (!this.cleanupLeavesResidual) {
      this.files.missing.add(cwd);
      this.files.missing.add(`${tempRoot}\\${id}`);
    }
  }
}

type ManagedRootOptions = Pick<
  ManagedArtifactOptions,
  'providerRuntimeRoot' | 'providerProfilesRoot' | 'providerTempRoot' | 'providerWorkspaceRoot'
>;

const harness = (rootOverrides: Partial<ManagedRootOptions> = {}) => {
  const fs = new FakeManagedFs();
  const files = new FakeFiles(fs);
  const hasher = new FakeHasher(fs);
  const privateDirectories = new FakePrivateDirectories(fs, files);
  fs.onMkdir = (path) => files.missing.delete(path);
  return {
    fs,
    files,
    hasher,
    privateDirectories,
    managed: createNodeCliManagedFileSystemForTest({
      providerRuntimeRoot: runtimeRoot,
      providerProfilesRoot: profileRoot,
      providerTempRoot: tempRoot,
      providerWorkspaceRoot: workspaceRoot,
      ...rootOverrides,
      files,
      hasher,
      privateDirectories,
      operations: fs,
    }),
  };
};

const abortOn = (
  fs: FakeManagedFs,
  controller: AbortController,
  match: (call: string) => boolean,
) => {
  fs.onCall = (call) => {
    if (match(call)) controller.abort();
  };
};

describe('node cli managed file system', () => {
  it('still cleans an exclusively acquired partial binary write that fails before finalization', async () => {
    const { managed, fs } = harness();
    const path = `${tempRoot}\\${requestId}\\image-000.png`;
    fs.maxWriteBytes = 0;
    await expect(
      managed.writeBinaryFileExclusive(
        path,
        new TextEncoder().encode('owned'),
        sha256('owned'),
        operation(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(fs.files.has(path)).toBe(false);
    expect(fs.calls).toContain(`remove:${path}`);
  });

  it.each(['hash', 'reparse', 'cancel'] as const)(
    'preserves a finalized binary when verification fails from %s',
    async (failure) => {
      const { managed, fs, files } = harness();
      const path = `${tempRoot}\\${requestId}\\image-000.png`;
      const controller = new AbortController();
      fs.onCall = (call) => {
        if (call !== `read:${path}` || !fs.handles[0]?.closed) return;
        fs.onCall = null;
        if (failure === 'hash') fs.files.set(path, 'changed');
        if (failure === 'reparse') files.reparseAt = path;
        if (failure === 'cancel') controller.abort();
      };
      await expect(
        managed.writeBinaryFileExclusive(
          path,
          new TextEncoder().encode('owned'),
          sha256('owned'),
          operation(controller.signal),
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
      expect(fs.files.get(path)).toBe(failure === 'hash' ? 'changed' : 'owned');
      expect(fs.calls).not.toContain(`remove:${path}`);
    },
  );

  it('rejects every noncanonical configured child root at construction', () => {
    for (const rootOverrides of [
      { providerProfilesRoot: `${profileRoot}\\..\\profiles` },
      { providerTempRoot: `${tempRoot}\\..\\temp` },
      { providerWorkspaceRoot: `${workspaceRoot}\\..\\workspace` },
    ] satisfies readonly Partial<ManagedRootOptions>[]) {
      expect(() => harness(rootOverrides)).toThrow(
        expect.objectContaining({
          code: 'PROVIDER_UNSAFE_VERSION',
          message: 'PROVIDER_UNSAFE_VERSION',
        }),
      );
    }
  });

  it('atomically replaces a managed file after exact partial writes, flush, close, and verification', async () => {
    const { fs, hasher, managed } = harness();
    fs.files.set(outputPath, 'old');
    fs.maxWriteBytes = 2;
    const contents = '{"title":"한글"}';

    await managed.writeUtf8FileAtomic(outputPath, contents, sha256(contents), operation());

    expect(fs.handles[0]).toMatchObject({ synced: true, closed: true });
    expect(fs.calls.filter((call) => call.startsWith('write:')).length).toBeGreaterThan(1);
    expect(fs.files.get(outputPath)).toBe(contents);
    expect(hasher.calls).toEqual([outputPath]);
  });

  it('prepares a missing profile through the private boundary before canonical post-checks', async () => {
    const { files, fs, privateDirectories, managed } = harness();
    const parent = `${profileRoot}\\gemini_cli\\settings`;
    const path = `${parent}\\settings.json`;
    files.missing.add(parent);

    await managed.prepareProfileDirectory('gemini_cli', operation());
    await managed.writeUtf8FileAtomic(path, '{}', sha256('{}'), operation());

    const prepareIndex = fs.calls.indexOf('private-profile:gemini_cli');
    expect(privateDirectories.profilesPrepared).toEqual(['gemini_cli']);
    expect(prepareIndex).toBeGreaterThanOrEqual(0);
    expect(fs.calls.lastIndexOf(`canonicalize:${parent}`)).toBeGreaterThan(prepareIndex);
    expect(fs.files.get(path)).toBe('{}');
  });

  it('creates only one missing app-owned child below a verified existing parent', async () => {
    const { files, fs, managed } = harness();
    const settings = `${profileRoot}\\gemini_cli\\settings`;
    const policies = `${settings}\\policies`;
    const path = `${policies}\\studyapp-deny-all.toml`;
    files.missing.add(policies);

    await managed.writeUtf8FileAtomic(path, 'deny = true', sha256('deny = true'), operation());

    const mkdirIndex = fs.calls.indexOf(`mkdir:${policies}`);
    expect(mkdirIndex).toBeGreaterThan(fs.calls.indexOf(`canonicalize:${settings}`));
    expect(fs.calls.lastIndexOf(`canonicalize:${policies}`)).toBeGreaterThan(mkdirIndex);
    expect(fs.files.get(path)).toBe('deny = true');
  });

  it('cleans the renamed artifact when post-rename exact verification detects tampering', async () => {
    const { fs, managed } = harness();
    fs.renameTamper = '{"type":"tampered"}';

    await expect(
      managed.writeUtf8FileAtomic(
        outputPath,
        '{"type":"object"}',
        sha256('{"type":"object"}'),
        operation(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });

    expect(fs.files.has(outputPath)).toBe(false);
    expect([...fs.files.keys()].filter((value) => value.includes('.tmp'))).toEqual([]);
    expect(fs.calls.some((call) => call === `remove:${outputPath}`)).toBe(true);
  });

  it('reports residual data when cleanup fails and hides the original path and error', async () => {
    const { fs, managed } = harness();
    fs.renameTamper = 'bad';
    fs.removeFails = true;

    await expect(
      managed.writeUtf8FileAtomic(outputPath, '{}', sha256('{}'), operation()),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
      expect(String(error)).not.toContain(outputPath);
      expect(String(error)).not.toContain('private cleanup detail');
      return true;
    });
  });

  it('does not delete another process temp file when exclusive creation reports EEXIST', async () => {
    const { fs, managed } = harness();
    fs.openCollision = true;

    await expect(
      managed.writeUtf8FileAtomic(outputPath, '{}', sha256('{}'), operation()),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
      expect(String(error)).not.toContain('EEXIST');
      return true;
    });

    expect(fs.calls.some((call) => call.startsWith('remove:'))).toBe(false);
  });

  it('does not follow a reparse temp during cleanup and reports residual data', async () => {
    const { files, fs, managed } = harness();
    fs.onCall = (call) => {
      if (call.startsWith('open:')) files.reparseAt = call.slice('open:'.length);
    };

    await expect(
      managed.writeUtf8FileAtomic(outputPath, '{}', sha256('{}'), operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });

    expect(fs.calls.some((call) => call.startsWith('rename:'))).toBe(false);
    expect(fs.calls.some((call) => call.startsWith('remove:'))).toBe(false);
    expect([...fs.files.keys()].filter((path) => path.endsWith('.tmp'))).toHaveLength(1);
  });

  it('rejects credential filenames before creating a file', async () => {
    const { fs, managed } = harness();
    const credentialPath = `${profileRoot}\\codex_cli\\settings\\auth.json`;

    await expect(
      managed.writeUtf8FileAtomic(credentialPath, '{}', sha256('{}'), operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });

    expect(fs.calls).toEqual([]);
  });

  it('rejects Windows reserved device filenames before creating a file', async () => {
    const { fs, managed } = harness();
    const reservedPath = `${tempRoot}\\${requestId}\\CON`;

    await expect(
      managed.writeUtf8FileAtomic(reservedPath, '{}', sha256('{}'), operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });

    expect(fs.calls).toEqual([]);
  });

  it('never writes into the read-only installed package area', async () => {
    const { fs, managed } = harness();
    const installedManifest = `${runtimeRoot}\\node_modules\\pkg\\package.json`;

    await expect(
      managed.writeUtf8FileAtomic(installedManifest, '{}', sha256('{}'), operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });

    expect(fs.calls).toEqual([]);
  });

  it.each([
    ['before exclusive open', (call: string) => call.startsWith('mkdir:')],
    ['after exclusive open', (call: string) => call.startsWith('open:')],
    ['after a write', (call: string) => call.startsWith('write:')],
    ['after sync', (call: string) => call.startsWith('sync:')],
    ['before rename', (call: string) => call.startsWith('reparse:') && call.endsWith('.tmp')],
    ['before verification', (call: string) => call.startsWith('rename:')],
  ])('honors cancellation %s and removes every owned artifact', async (_label, match) => {
    const { files, fs, managed } = harness();
    const controller = new AbortController();
    abortOn(fs, controller, match);

    await expect(
      managed.writeUtf8FileAtomic(
        outputPath,
        '{"ok":true}',
        sha256('{"ok":true}'),
        operation(controller.signal),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });

    expect(
      [...fs.files.keys()].filter((path) => path === outputPath || path.endsWith('.tmp')),
    ).toEqual([]);
    if (fs.calls.some((call) => call.startsWith('open:'))) {
      const cleanupOperations = files.seenOperations.filter(
        (item) => item.signal !== controller.signal,
      );
      expect(cleanupOperations.length).toBeGreaterThan(0);
    }
  });

  it('reports residual data when cancellation cleanup absence cannot be proven', async () => {
    const { files, fs, managed } = harness();
    const controller = new AbortController();
    files.obscureMissing = true;
    abortOn(fs, controller, (call) => call.startsWith('write:'));

    await expect(
      managed.writeUtf8FileAtomic(outputPath, '{}', sha256('{}'), operation(controller.signal)),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });

    expect(fs.calls.some((call) => call.startsWith('remove:'))).toBe(true);
  });

  it('verifies bounded fatal UTF-8 and rechecks the path after reading', async () => {
    const { files, fs, managed } = harness();
    const path = `${runtimeRoot}\\node_modules\\pkg\\settings.schema.json`;
    files.byteOverrides.set(path, Uint8Array.from([0xc3, 0x28]));

    await expect(managed.readUtf8Snapshot(path, 8192, operation())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });

    files.byteOverrides.delete(path);
    fs.files.set(path, 'valid');
    files.reparseAfterRead = true;
    await expect(managed.readUtf8Snapshot(path, 8192, operation())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
  });

  it('rejects a snapshot beyond its caller bound', async () => {
    const { fs, managed } = harness();
    const path = `${runtimeRoot}\\node_modules\\pkg\\settings.schema.json`;
    fs.files.set(path, 'a'.repeat(8193));

    await expect(managed.readUtf8Snapshot(path, 8192, operation())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
  });

  it('requires exact content and the independent file hasher during verification', async () => {
    const { fs, hasher, managed } = harness();
    fs.files.set(outputPath, '{}');
    hasher.override = '0'.repeat(64);

    await expect(
      managed.verifyUtf8File(outputPath, '{}', sha256('{}'), operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });

    expect(hasher.calls).toEqual([outputPath]);
  });

  it('distinguishes an exact existing directory from a missing allowed directory', async () => {
    const { files, managed } = harness();
    const settings = `${profileRoot}\\gemini_cli\\settings`;
    files.missing.add(settings);

    await expect(managed.assertDirectoryChildren(settings, [], operation())).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
    await expect(
      managed.assertDirectoryHasNoUnexpectedChildren(settings, ['settings.json'], operation()),
    ).resolves.toBeUndefined();
  });

  it('enforces exact versus allowed subset directory semantics', async () => {
    const { files, managed } = harness();
    const settings = `${profileRoot}\\gemini_cli\\settings`;
    files.children.set(settings, [`${settings}\\settings.json`]);

    await expect(
      managed.assertDirectoryChildren(settings, ['settings.json'], operation()),
    ).resolves.toBeUndefined();
    await expect(
      managed.assertDirectoryHasNoUnexpectedChildren(
        settings,
        ['settings.json', 'policies'],
        operation(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      managed.assertDirectoryChildren(settings, ['settings.json', 'policies'], operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
  });

  it('rejects unsafe expected names, nested children, and credential residue without disclosure', async () => {
    const { files, managed } = harness();
    const settings = `${profileRoot}\\codex_cli\\settings`;

    await expect(
      managed.assertDirectoryHasNoUnexpectedChildren(settings, ['..\\auth.json'], operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });

    await expect(
      managed.assertDirectoryHasNoUnexpectedChildren(settings, ['NUL'], operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });

    files.children.set(settings, [`${settings}\\nested\\settings.json`]);
    await expect(
      managed.assertDirectoryChildren(settings, ['settings.json'], operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });

    files.children.set(settings, [`${settings}\\auth.json`]);
    await expect(managed.assertDirectoryChildren(settings, [], operation())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
        expect(String(error)).not.toContain('auth.json');
        return true;
      },
    );
  });

  it('validates request UUID, provider, operation, and workspace before private operations', async () => {
    const invalidId = 'not-a-uuid';
    const cases: readonly ((managed: ReturnType<typeof harness>['managed']) => Promise<void>)[] = [
      (managed) =>
        managed.prepareRequestDirectory(
          'gemini_cli',
          invalidId,
          `${workspaceRoot}\\${invalidId}`,
          Object.freeze({ requestId: invalidId, signal: new AbortController().signal }),
        ),
      (managed) =>
        managed.prepareRequestDirectory(
          'unsupported_cli' as 'gemini_cli',
          requestId,
          workspacePath,
          operation(),
        ),
      (managed) =>
        managed.prepareRequestDirectory(
          'codex_cli',
          requestId,
          workspacePath,
          Object.freeze({ requestId: randomUUID(), signal: new AbortController().signal }),
        ),
    ];

    for (const invoke of cases) {
      const { fs, managed } = harness();
      await expect(invoke(managed)).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
      expect(fs.calls).toEqual([]);
    }

    const { fs, managed } = harness();
    const injected = `${workspaceRoot}\\${requestId}\\..\\other`;
    await expect(
      managed.prepareRequestDirectory('codex_cli', requestId, injected, operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    expect(fs.calls).toEqual([]);
  });

  it('requires a prepared request directory to be empty and cleans it after failure', async () => {
    const { files, privateDirectories, managed } = harness();
    files.children.set(workspacePath, [`${workspacePath}\\unexpected.json`]);

    await expect(
      managed.prepareRequestDirectory('gemini_cli', requestId, workspacePath, operation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });

    expect(privateDirectories.cleaned).toEqual([`${requestId}:${workspacePath}`]);
  });

  it('cleans a prepared request directory when cancellation is observed after preparation', async () => {
    const { privateDirectories, managed } = harness();
    const controller = new AbortController();
    privateDirectories.onPrepare = () => controller.abort();

    await expect(
      managed.prepareRequestDirectory(
        'antigravity_cli',
        requestId,
        workspacePath,
        operation(controller.signal),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });

    expect(privateDirectories.cleaned).toEqual([`${requestId}:${workspacePath}`]);
  });

  it('proves request workspace and temp absence after private force-false cleanup', async () => {
    const { fs, privateDirectories, managed } = harness();

    await managed.prepareRequestDirectory('gemini_cli', requestId, workspacePath, operation());
    await managed.cleanupRequestDirectory(requestId, workspacePath);

    expect(privateDirectories.cleaned).toEqual([`${requestId}:${workspacePath}`]);
    const cleanupIndex = fs.calls.indexOf(`private-cleanup:${requestId}:${workspacePath}`);
    expect(fs.calls.indexOf(`list:${workspacePath}`, cleanupIndex + 1)).toBeGreaterThan(
      cleanupIndex,
    );
    expect(fs.calls.indexOf(`list:${tempRoot}\\${requestId}`, cleanupIndex + 1)).toBeGreaterThan(
      cleanupIndex,
    );
  });

  it('reports residual data when request cleanup returns without removing the directory', async () => {
    const { privateDirectories, managed } = harness();
    privateDirectories.cleanupLeavesResidual = true;

    await expect(managed.cleanupRequestDirectory(requestId, workspacePath)).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
  });

  it.each([
    [
      'write',
      (managed: ReturnType<typeof harness>['managed'], op: ProviderConnectionOperation) =>
        managed.writeUtf8FileAtomic(outputPath, '{}', sha256('{}'), op),
    ],
    [
      'read',
      (managed: ReturnType<typeof harness>['managed'], op: ProviderConnectionOperation) =>
        managed.readUtf8Snapshot(outputPath, 1024, op),
    ],
    [
      'verify',
      (managed: ReturnType<typeof harness>['managed'], op: ProviderConnectionOperation) =>
        managed.verifyUtf8File(outputPath, '{}', sha256('{}'), op),
    ],
    [
      'exact directory',
      (managed: ReturnType<typeof harness>['managed'], op: ProviderConnectionOperation) =>
        managed.assertDirectoryChildren(workspacePath, [], op),
    ],
    [
      'allowed directory',
      (managed: ReturnType<typeof harness>['managed'], op: ProviderConnectionOperation) =>
        managed.assertDirectoryHasNoUnexpectedChildren(workspacePath, [], op),
    ],
    [
      'profile prepare',
      (managed: ReturnType<typeof harness>['managed'], op: ProviderConnectionOperation) =>
        managed.prepareProfileDirectory('gemini_cli', op),
    ],
    [
      'prepare',
      (managed: ReturnType<typeof harness>['managed'], op: ProviderConnectionOperation) =>
        managed.prepareRequestDirectory('gemini_cli', requestId, workspacePath, op),
    ],
  ])('honors a pre-aborted %s operation with zero filesystem calls', async (_label, invoke) => {
    const { files, fs, hasher, privateDirectories, managed } = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(invoke(managed, operation(controller.signal))).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });

    expect(fs.calls).toEqual([]);
    expect(files.calls).toEqual([]);
    expect(hasher.calls).toEqual([]);
    expect(privateDirectories.profilesPrepared).toEqual([]);
    expect(privateDirectories.prepared).toEqual([]);
  });
});
