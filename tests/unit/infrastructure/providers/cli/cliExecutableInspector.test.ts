import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../../../src/core/ports/aiProvider';
import type {
  CliProcessRequest,
  CliProcessResult,
  CliProcessRunner,
} from '../../../../../src/core/ports/cliProcessRunner';
import { sha256CanonicalJson } from '../../../../../src/core/providers/canonicalJson';
import {
  type CliExecutableFileAccess,
  type CliExecutableInspector,
  type CliFileHasher,
  type CliSignatureVerifier,
  createCliExecutableInspectorForTest,
  SUPPORTED_CLI_RECIPES,
} from '../../../../../src/infrastructure/providers/cli/cliExecutableInspector';
import {
  createWindowsKnownFoldersForTest,
  type WindowsKnownFolders,
} from '../../../../../src/infrastructure/providers/cli/windowsKnownFolders';
import {
  parseSafeSemVer,
  TRUSTED_CLI_BINDING_RECIPES,
  toPublicProviderDiagnostic,
} from '../../../../../src/shared/contracts/provider';

const ROOTS: WindowsKnownFolders = createWindowsKnownFoldersForTest({
  localAppData: 'C:\\Users\\student\\AppData\\Local',
  appData: 'C:\\Users\\student\\AppData\\Roaming',
  programFiles: 'C:\\Program Files',
  architecture: 'x64',
});
const NOW = '2026-09-02T00:00:00.000Z';
const operation = Object.freeze({
  requestId: '20000000-0000-4000-8000-000000000001',
  signal: new AbortController().signal,
}) satisfies ProviderConnectionOperation;

class FakeFileAccess implements CliExecutableFileAccess {
  readonly operations: ProviderConnectionOperation[] = [];
  readonly canonicalizeCalls: string[] = [];
  readonly reparseChecks: string[] = [];
  readonly readCalls: string[] = [];
  readonly listCalls: string[] = [];
  readonly canonicalPaths = new Map<string, string>();
  readonly contents = new Map<string, Uint8Array>();
  readonly queuedContents = new Map<string, Uint8Array[]>();
  readonly children = new Map<string, readonly string[]>();
  readonly reparsePaths = new Set<string>();

  addFile(path: string, content?: string): void {
    this.canonicalPaths.set(path.toLowerCase(), path);
    if (content !== undefined) this.contents.set(path.toLowerCase(), Buffer.from(content, 'utf8'));
  }

  setCanonical(path: string, canonicalPath: string): void {
    this.canonicalPaths.set(path.toLowerCase(), canonicalPath);
    this.canonicalPaths.set(canonicalPath.toLowerCase(), canonicalPath);
  }

  setChildren(root: string, children: readonly string[]): void {
    this.children.set(root.toLowerCase(), Object.freeze([...children]));
  }

  markReparse(path: string): void {
    this.reparsePaths.add(win32.normalize(path).toLowerCase());
  }

  queueContents(path: string, contents: readonly string[]): void {
    this.queuedContents.set(
      path.toLowerCase(),
      contents.map((content) => Buffer.from(content, 'utf8')),
    );
  }

  setContent(path: string, content: string): void {
    this.contents.set(path.toLowerCase(), Buffer.from(content, 'utf8'));
  }

  async canonicalize(
    path: string,
    requestedOperation: ProviderConnectionOperation,
  ): Promise<string> {
    this.operations.push(requestedOperation);
    this.canonicalizeCalls.push(path);
    const canonicalPath = this.canonicalPaths.get(path.toLowerCase());
    if (canonicalPath === undefined) throw new Error('ENOENT');
    return canonicalPath;
  }

  async assertNoReparsePoints(
    path: string,
    requestedOperation: ProviderConnectionOperation,
  ): Promise<void> {
    this.operations.push(requestedOperation);
    this.reparseChecks.push(path);
    const normalized = win32.normalize(path).toLowerCase();
    for (const reparsePath of this.reparsePaths) {
      if (normalized === reparsePath || normalized.startsWith(`${reparsePath}\\`)) {
        throw new Error('REPARSE_POINT');
      }
    }
  }

  async readFile(
    path: string,
    _limitBytes: number,
    requestedOperation: ProviderConnectionOperation,
  ): Promise<Uint8Array> {
    this.operations.push(requestedOperation);
    this.readCalls.push(path);
    const queued = this.queuedContents.get(path.toLowerCase());
    const queuedContent = queued?.shift();
    if (queuedContent !== undefined) return Uint8Array.from(queuedContent);
    const content = this.contents.get(path.toLowerCase());
    if (content === undefined) throw new Error('ENOENT');
    return Uint8Array.from(content);
  }

  async listChildren(
    path: string,
    requestedOperation: ProviderConnectionOperation,
  ): Promise<readonly string[]> {
    this.operations.push(requestedOperation);
    this.listCalls.push(path);
    return this.children.get(path.toLowerCase()) ?? Object.freeze([]);
  }
}

class FakeHasher implements CliFileHasher {
  readonly hashes = new Map<string, string>();
  readonly queuedHashes = new Map<string, string[]>();
  readonly calls: string[] = [];
  readonly operations: ProviderConnectionOperation[] = [];

  set(path: string, hash: string): void {
    this.hashes.set(path.toLowerCase(), hash);
  }

  queue(path: string, hashes: readonly string[]): void {
    this.queuedHashes.set(path.toLowerCase(), [...hashes]);
  }

  async sha256(path: string, requestedOperation: ProviderConnectionOperation): Promise<string> {
    this.operations.push(requestedOperation);
    this.calls.push(path);
    const queued = this.queuedHashes.get(path.toLowerCase());
    const queuedHash = queued?.shift();
    if (queuedHash !== undefined) return queuedHash;
    const hash = this.hashes.get(path.toLowerCase());
    if (hash === undefined) throw new Error('ENOENT');
    return hash;
  }
}

class FakeSignatureVerifier implements CliSignatureVerifier {
  readonly calls: Array<
    Readonly<{ path: string; classification: 'google' | 'openai' | 'nodejs' }>
  > = [];
  readonly operations: ProviderConnectionOperation[] = [];
  rejected = false;
  onVerify: (() => void) | null = null;

  async verify(
    path: string,
    classification: 'google' | 'openai' | 'nodejs',
    requestedOperation: ProviderConnectionOperation,
  ): Promise<
    Readonly<{
      signerClassification: 'google' | 'openai' | 'nodejs';
      certificateThumbprint: string;
    }>
  > {
    this.operations.push(requestedOperation);
    this.calls.push(Object.freeze({ path, classification }));
    this.onVerify?.();
    if (this.rejected) throw new Error('SIGNATURE_REJECTED');
    return Object.freeze({
      signerClassification: classification,
      certificateThumbprint: 'A'.repeat(40),
    });
  }
}

class FakeRunner implements CliProcessRunner {
  readonly requests: CliProcessRequest[] = [];
  readonly results: CliProcessResult[] = [];
  readonly errors: Error[] = [];
  onRun: (() => void) | null = null;

  queue(stdout: string, exitCode = 0): void {
    this.results.push(Object.freeze({ exitCode, stdout, stderr: '' }));
  }

  queueError(message: string): void {
    this.errors.push(new Error(message));
  }

  async run(request: CliProcessRequest): Promise<CliProcessResult> {
    this.requests.push(request);
    this.onRun?.();
    const error = this.errors.shift();
    if (error !== undefined) throw error;
    const result = this.results.shift();
    if (result === undefined) throw new Error('NO_PROCESS_RESULT');
    return result;
  }

  cancel(): void {}
}

type Harness = Readonly<{
  files: FakeFileAccess;
  hasher: FakeHasher;
  signatures: FakeSignatureVerifier;
  runner: FakeRunner;
  inspector: CliExecutableInspector;
}>;

const harness = (roots: WindowsKnownFolders = ROOTS): Harness => {
  const files = new FakeFileAccess();
  const hasher = new FakeHasher();
  const signatures = new FakeSignatureVerifier();
  const runner = new FakeRunner();
  return Object.freeze({
    files,
    hasher,
    signatures,
    runner,
    inspector: createCliExecutableInspectorForTest({
      files,
      hasher,
      signatures,
      runner,
      knownFolders: roots,
      now: () => NOW,
    }),
  });
};

const addHashedFile = (
  setup: Harness,
  path: string,
  hashCharacter: string,
  content?: string,
): void => {
  setup.files.addFile(path, content);
  setup.hasher.set(path, hashCharacter.repeat(64));
};

const arrangeNative = (
  setup: Harness,
  providerId: 'antigravity_cli' | 'codex_cli',
  version: string,
): string => {
  const path =
    providerId === 'antigravity_cli'
      ? win32.join(ROOTS.localAppData, 'agy', 'bin', 'agy.exe')
      : win32.join(ROOTS.localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe');
  addHashedFile(setup, path, 'a');
  if (providerId === 'codex_cli') {
    setup.files.setChildren(win32.dirname(path), [path]);
  }
  setup.runner.queue(
    providerId === 'antigravity_cli' ? `agy ${version}\n` : `codex-cli ${version}\n`,
  );
  return path;
};

const packageJson = (name: string, version: string, command: string, entry: string): string =>
  JSON.stringify({ name, version, bin: { [command]: entry } });

const arrangeGemini = (setup: Harness, version = '0.55.1', entry = 'dist/index.js') => {
  const shim = win32.join(ROOTS.appData, 'npm', 'gemini.cmd');
  const packageRoot = win32.join(ROOTS.appData, 'npm', 'node_modules', '@google', 'gemini-cli');
  const manifest = win32.join(packageRoot, 'package.json');
  const entryPath = win32.resolve(packageRoot, entry);
  const node = win32.join(ROOTS.programFiles, 'nodejs', 'node.exe');
  setup.files.addFile(shim);
  addHashedFile(setup, manifest, 'c', packageJson('@google/gemini-cli', version, 'gemini', entry));
  addHashedFile(setup, entryPath, 'b');
  addHashedFile(setup, node, 'a');
  setup.runner.queue(`${version}\n`);
  return { shim, manifest, entryPath, node };
};

const arrangeCodexNpm = (
  setup: Harness,
  architecture: 'x64' | 'arm64' = 'x64',
  platformPackageOverride?: string,
) => {
  const version = '0.146.0';
  const shim = win32.join(ROOTS.appData, 'npm', 'codex.cmd');
  const packageRoot = win32.join(ROOTS.appData, 'npm', 'node_modules', '@openai', 'codex');
  const manifest = win32.join(packageRoot, 'package.json');
  const entryPath = win32.join(packageRoot, 'bin', 'codex.js');
  const platformName = platformPackageOverride ?? `@openai/codex-win32-${architecture}`;
  const platformLeaf = `codex-win32-${architecture}`;
  const platformRoot = win32.join(packageRoot, 'node_modules', '@openai', platformLeaf);
  const platformManifest = win32.join(platformRoot, 'package.json');
  const triple = architecture === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
  const launcher = win32.join(platformRoot, 'vendor', triple, 'codex', 'codex.exe');
  setup.files.addFile(shim);
  addHashedFile(
    setup,
    manifest,
    'c',
    packageJson('@openai/codex', version, 'codex', 'bin/codex.js'),
  );
  addHashedFile(setup, entryPath, 'b');
  addHashedFile(
    setup,
    platformManifest,
    'd',
    JSON.stringify({ name: platformName, version, os: ['win32'], cpu: [architecture] }),
  );
  addHashedFile(setup, launcher, 'a');
  setup.runner.queue(`codex-cli ${version}\n`);
  return { shim, manifest, entryPath, platformManifest, launcher };
};

const mutateCodexComponent = (
  setup: Harness,
  paths: ReturnType<typeof arrangeCodexNpm>,
  component: 'launcher' | 'entryPath' | 'manifest' | 'platformManifest',
): void => {
  if (component === 'manifest') {
    setup.files.setContent(
      paths.manifest,
      '{ "name":"@openai/codex", "version":"0.146.0", "bin":{ "codex":"bin/codex.js" } }',
    );
    return;
  }
  if (component === 'platformManifest') {
    setup.files.setContent(
      paths.platformManifest,
      '{ "name":"@openai/codex-win32-x64", "version":"0.146.0", "os":["win32"], "cpu":["x64"] }',
    );
    return;
  }
  setup.hasher.set(paths[component], 'f'.repeat(64));
};

describe('CLI executable inspector', () => {
  it('accepts the exact Antigravity location without consulting a PATH alias', async () => {
    const setup = harness();
    const canonical = arrangeNative(setup, 'antigravity_cli', '1.1.16');
    const alias = 'C:\\PathAlias\\agy.exe';
    addHashedFile(setup, alias, 'f');

    const binding = await setup.inspector.inspect('antigravity_cli', operation);
    expect(binding).toMatchObject({
      providerId: 'antigravity_cli',
      canonicalLauncherPath: canonical,
      canonicalEntryPath: null,
      canonicalPackageManifestPath: null,
      canonicalPlatformPackageManifestPath: null,
      fixedPrefixArgs: [],
      version: '1.1.16',
      launcherSha256: 'a'.repeat(64),
      platformPackageManifestSha256: null,
      recipeId: 'antigravity-1.1-stream-json-v1',
      credentialScope: 'provider_global',
      signerClassification: 'google',
      checkedAt: NOW,
    });
    expect(JSON.stringify(binding)).not.toContain(alias);
    expect(setup.files.canonicalizeCalls).not.toContain(alias);
    expect(setup.runner.requests.every((request) => request.shell === false)).toBe(true);
    expect(setup.runner.requests[0]).toMatchObject({
      requestId: operation.requestId,
      signal: operation.signal,
    });
    expect(setup.files.operations.length).toBeGreaterThan(0);
    expect(setup.files.operations.every((value) => value === operation)).toBe(true);
    expect(setup.hasher.operations.length).toBeGreaterThan(0);
    expect(setup.hasher.operations.every((value) => value === operation)).toBe(true);
    expect(setup.signatures.operations).toEqual([operation]);
  });

  it('never invokes where.exe or any PATH discovery process', async () => {
    const setup = harness();
    arrangeNative(setup, 'antigravity_cli', '1.1.16');

    await setup.inspector.inspect('antigravity_cli', operation);

    expect(setup.runner.requests).toHaveLength(1);
    expect(setup.runner.requests[0]?.launcherPath.toLowerCase()).not.toContain('where.exe');
    expect(setup.signatures.calls).toHaveLength(1);
  });

  it('reports a missing executable without attempting a process or signature check', async () => {
    const setup = harness();

    await expect(setup.inspector.inspect('codex_cli', operation)).rejects.toMatchObject({
      code: 'PROVIDER_EXECUTABLE_NOT_FOUND',
    });
    expect(setup.runner.requests).toHaveLength(0);
    expect(setup.signatures.calls).toHaveLength(0);
  });

  it('rejects a pre-aborted operation before filesystem, signature, or process access', async () => {
    const setup = harness();
    const controller = new AbortController();
    controller.abort();
    const abortedOperation = Object.freeze({
      requestId: '20000000-0000-4000-8000-000000000002',
      signal: controller.signal,
    }) satisfies ProviderConnectionOperation;

    await expect(
      setup.inspector.inspect('antigravity_cli', abortedOperation),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(setup.files.operations).toHaveLength(0);
    expect(setup.hasher.operations).toHaveLength(0);
    expect(setup.signatures.operations).toHaveLength(0);
    expect(setup.runner.requests).toHaveLength(0);
  });

  it.each([
    ['antigravity_cli', '1.1.11'],
    ['antigravity_cli', '1.2.0'],
    ['gemini_cli', '0.55.0'],
    ['gemini_cli', '0.56.0'],
    ['codex_cli', '0.145.0'],
    ['codex_cli', '0.147.0'],
  ] as const)('fails closed for unsupported %s version %s', async (providerId, version) => {
    const setup = harness();
    if (providerId === 'gemini_cli') arrangeGemini(setup, version);
    else arrangeNative(setup, providerId, version);

    await expect(setup.inspector.inspect(providerId, operation)).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
  });

  it.each([
    ['antigravity_cli', '1.1.12'],
    ['antigravity_cli', '1.1.999'],
    ['gemini_cli', '0.55.1'],
    ['gemini_cli', '0.55.999'],
    ['codex_cli', '0.146.0'],
    ['codex_cli', '0.146.999'],
  ] as const)('accepts closed-window boundary %s version %s', async (providerId, version) => {
    const setup = harness();
    if (providerId === 'gemini_cli') arrangeGemini(setup, version);
    else arrangeNative(setup, providerId, version);

    await expect(setup.inspector.inspect(providerId, operation)).resolves.toMatchObject({
      version,
    });
  });

  it.each([
    ['antigravity_cli', 'agy 1.1.16-preview.1\n'],
    ['gemini_cli', '0.55.1-nightly\n'],
    ['codex_cli', 'codex-cli 0.146.0+local\n'],
    ['codex_cli', 'prefix codex-cli 0.146.0\n'],
  ] as const)(
    'rejects preview, build, or unanchored %s version output',
    async (providerId, output) => {
      const setup = harness();
      if (providerId === 'gemini_cli') arrangeGemini(setup);
      else
        arrangeNative(setup, providerId, providerId === 'antigravity_cli' ? '1.1.16' : '0.146.0');
      setup.runner.results.splice(0, 1, Object.freeze({ exitCode: 0, stdout: output, stderr: '' }));

      await expect(setup.inspector.inspect(providerId, operation)).rejects.toMatchObject({
        code: 'PROVIDER_UNSAFE_VERSION',
      });
    },
  );

  it('binds Gemini to verified Node plus the official manifest and contained entry only', async () => {
    const setup = harness();
    const paths = arrangeGemini(setup);

    const binding = await setup.inspector.inspect('gemini_cli', operation);

    expect(binding).toMatchObject({
      canonicalLauncherPath: paths.node,
      canonicalEntryPath: paths.entryPath,
      canonicalPackageManifestPath: paths.manifest,
      fixedPrefixArgs: [paths.entryPath],
      launcherSha256: 'a'.repeat(64),
      entrySha256: 'b'.repeat(64),
      packageManifestSha256: createHash('sha256')
        .update(packageJson('@google/gemini-cli', '0.55.1', 'gemini', 'dist/index.js'))
        .digest('hex'),
      canonicalPlatformPackageManifestPath: null,
      platformPackageManifestSha256: null,
      signerClassification: 'nodejs',
      recipeId: TRUSTED_CLI_BINDING_RECIPES.gemini_cli.recipeId,
    });
    expect(setup.runner.requests[0]?.launcherPath).toBe(paths.node);
    expect(setup.runner.requests[0]?.args).toEqual([paths.entryPath, '--version']);
    expect(setup.runner.requests[0]?.launcherPath).not.toBe(paths.shim);
  });

  it.each([
    {
      name: 'wrong package name',
      manifest: packageJson('@attacker/gemini-cli', '0.55.1', 'gemini', 'dist/index.js'),
    },
    { name: 'malformed package JSON', manifest: '{"name":' },
    {
      name: 'unexpected bin command',
      manifest: packageJson('@google/gemini-cli', '0.55.1', 'attacker', 'dist/index.js'),
    },
    {
      name: 'bin traversal',
      manifest: packageJson('@google/gemini-cli', '0.55.1', 'gemini', '../../attacker.js'),
    },
    {
      name: 'absolute bin path',
      manifest: packageJson('@google/gemini-cli', '0.55.1', 'gemini', 'C:\\attacker.js'),
    },
  ])('rejects malicious Gemini package metadata: $name', async ({ manifest }) => {
    const setup = harness();
    const paths = arrangeGemini(setup);
    setup.files.setContent(paths.manifest, manifest);

    await expect(setup.inspector.inspect('gemini_cli', operation)).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
    expect(setup.runner.requests).toHaveLength(0);
  });

  it.each(['x64', 'arm64'] as const)(
    'binds Codex npm provenance to the architecture-matched %s native binary',
    async (architecture) => {
      const setup = harness(createWindowsKnownFoldersForTest({ ...ROOTS, architecture }));
      const paths = arrangeCodexNpm(setup, architecture);

      const binding = await setup.inspector.inspect('codex_cli', operation);

      expect(binding).toMatchObject({
        canonicalLauncherPath: paths.launcher,
        canonicalEntryPath: paths.entryPath,
        canonicalPackageManifestPath: paths.manifest,
        canonicalPlatformPackageManifestPath: paths.platformManifest,
        fixedPrefixArgs: [],
        version: '0.146.0',
        platformPackageManifestSha256: createHash('sha256')
          .update(
            setup.files.contents.get(paths.platformManifest.toLowerCase()) ?? new Uint8Array(),
          )
          .digest('hex'),
        signerClassification: 'openai',
      });
      expect(setup.runner.requests[0]?.launcherPath).toBe(paths.launcher);
      expect(setup.runner.requests[0]?.args).toEqual(['--version']);
    },
  );

  it('rejects a Codex platform package for the wrong architecture before execution', async () => {
    const setup = harness();
    arrangeCodexNpm(setup, 'x64', '@openai/codex-win32-arm64');

    await expect(setup.inspector.inspect('codex_cli', operation)).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
    expect(setup.runner.requests).toHaveLength(0);
  });

  it.each([
    [
      'wrong operating system',
      { name: '@openai/codex-win32-x64', version: '0.146.0', os: ['linux'], cpu: ['x64'] },
    ],
    [
      'wrong CPU field',
      { name: '@openai/codex-win32-x64', version: '0.146.0', os: ['win32'], cpu: ['arm64'] },
    ],
    [
      'mismatched version',
      { name: '@openai/codex-win32-x64', version: '0.146.1', os: ['win32'], cpu: ['x64'] },
    ],
  ] as const)('strictly rejects Codex platform metadata with $0', async (_name, metadata) => {
    const setup = harness();
    const paths = arrangeCodexNpm(setup);
    setup.files.setContent(paths.platformManifest, JSON.stringify(metadata));

    await expect(setup.inspector.inspect('codex_cli', operation)).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
    expect(setup.runner.requests).toHaveLength(0);
  });

  it('does not bypass an invalid nested Codex platform package through a valid hoisted package', async () => {
    const setup = harness();
    const nested = arrangeCodexNpm(setup);
    setup.files.setContent(
      nested.platformManifest,
      JSON.stringify({
        name: '@attacker/codex-win32-x64',
        version: '0.146.0',
        os: ['win32'],
        cpu: ['x64'],
      }),
    );
    const hoistedRoot = win32.join(
      ROOTS.appData,
      'npm',
      'node_modules',
      '@openai',
      'codex-win32-x64',
    );
    const hoistedManifest = win32.join(hoistedRoot, 'package.json');
    const hoistedLauncher = win32.join(
      hoistedRoot,
      'vendor',
      'x86_64-pc-windows-msvc',
      'codex',
      'codex.exe',
    );
    addHashedFile(
      setup,
      hoistedManifest,
      'd',
      JSON.stringify({
        name: '@openai/codex-win32-x64',
        version: '0.146.0',
        os: ['win32'],
        cpu: ['x64'],
      }),
    );
    addHashedFile(setup, hoistedLauncher, 'a');

    await expect(setup.inspector.inspect('codex_cli', operation)).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
    expect(setup.runner.requests).toHaveLength(0);
  });

  it('rejects PATH candidates outside the exact official roots without reading or executing them', async () => {
    const setup = harness();
    const malicious = 'C:\\Users\\student\\bin\\agy.exe';
    addHashedFile(setup, malicious, 'a');

    await expect(setup.inspector.inspect('antigravity_cli', operation)).rejects.toMatchObject({
      code: 'PROVIDER_EXECUTABLE_NOT_FOUND',
    });
    expect(setup.files.canonicalizeCalls).not.toContain(malicious);
    expect(setup.files.readCalls).toHaveLength(0);
    expect(setup.hasher.calls).toHaveLength(0);
    expect(setup.runner.requests).toHaveLength(0);
  });

  it.each(['shim', 'manifest', 'entryPath', 'node'] as const)(
    'rejects a Gemini reparse point at the %s component before reading, hashing, or execution',
    async (component) => {
      const setup = harness();
      const paths = arrangeGemini(setup);
      setup.files.markReparse(paths[component]);

      await expect(setup.inspector.inspect('gemini_cli', operation)).rejects.toBeInstanceOf(Error);
      expect(setup.runner.requests).toHaveLength(0);
    },
  );

  it.each(['shim', 'manifest', 'entryPath', 'platformManifest', 'launcher'] as const)(
    'rejects a Codex reparse point at the %s component before execution',
    async (component) => {
      const setup = harness();
      const paths = arrangeCodexNpm(setup);
      setup.files.markReparse(paths[component]);

      await expect(setup.inspector.inspect('codex_cli', operation)).rejects.toBeInstanceOf(Error);
      expect(setup.runner.requests).toHaveLength(0);
    },
  );

  it.each(['launcherSha256', 'entrySha256', 'packageManifestSha256'] as const)(
    'invalidates a Gemini binding when %s drifts',
    async (hashField) => {
      const setup = harness();
      arrangeGemini(setup);
      const binding = await setup.inspector.inspect('gemini_cli', operation);
      const pathByField = {
        launcherSha256: binding.canonicalLauncherPath,
        entrySha256: binding.canonicalEntryPath,
        packageManifestSha256: binding.canonicalPackageManifestPath,
      } as const;
      const path = pathByField[hashField];
      if (path === null) throw new Error('MISSING_TEST_PATH');
      if (hashField === 'packageManifestSha256') {
        setup.files.setContent(
          path,
          '{ "name":"@google/gemini-cli", "version":"0.55.1", "bin":{ "gemini":"dist/index.js" } }',
        );
      } else {
        setup.hasher.set(path, 'f'.repeat(64));
      }

      await expect(setup.inspector.revalidate(binding, operation)).rejects.toMatchObject({
        code: 'PROVIDER_CLI_CHANGED',
      });
    },
  );

  it('invalidates a Codex npm binding when only the platform manifest bytes drift', async () => {
    const setup = harness();
    const paths = arrangeCodexNpm(setup);
    const binding = await setup.inspector.inspect('codex_cli', operation);
    setup.files.setContent(
      paths.platformManifest,
      '{ "name":"@openai/codex-win32-x64", "version":"0.146.0", "os":["win32"], "cpu":["x64"] }',
    );

    await expect(setup.inspector.revalidate(binding, operation)).rejects.toMatchObject({
      code: 'PROVIDER_CLI_CHANGED',
    });
  });

  it.each([
    ['gemini_cli', '0.55.2'],
    ['codex_cli', '0.146.1'],
  ] as const)(
    'rejects a forged persisted %s version that differs from the current package manifest',
    async (providerId, forgedVersionValue) => {
      const setup = harness();
      if (providerId === 'gemini_cli') arrangeGemini(setup);
      else arrangeCodexNpm(setup);
      const binding = await setup.inspector.inspect(providerId, operation);
      const forgedVersion = parseSafeSemVer(forgedVersionValue);
      const forgedBinding = Object.freeze({
        ...binding,
        version: forgedVersion,
        bindingSha256: sha256CanonicalJson({
          providerId: binding.providerId,
          version: forgedVersion,
          recipeId: binding.recipeId,
          credentialScope: binding.credentialScope,
          signerClassification: binding.signerClassification,
          launcherSha256: binding.launcherSha256,
          entrySha256: binding.entrySha256,
          packageManifestSha256: binding.packageManifestSha256,
          platformPackageManifestSha256: binding.platformPackageManifestSha256,
        }),
      });

      await expect(setup.inspector.revalidate(forgedBinding, operation)).rejects.toMatchObject({
        code: 'PROVIDER_CLI_CHANGED',
      });
    },
  );

  it('keeps a valid native binding revalidatable without package-version provenance', async () => {
    const setup = harness();
    arrangeNative(setup, 'antigravity_cli', '1.1.16');
    const binding = await setup.inspector.inspect('antigravity_cli', operation);

    await expect(setup.inspector.revalidate(binding, operation)).resolves.toMatchObject({
      providerId: 'antigravity_cli',
      version: '1.1.16',
      canonicalPackageManifestPath: null,
      canonicalPlatformPackageManifestPath: null,
    });
  });

  it('invalidates a binding when its composite hash is forged', async () => {
    const setup = harness();
    arrangeNative(setup, 'antigravity_cli', '1.1.16');
    const binding = await setup.inspector.inspect('antigravity_cli', operation);

    await expect(
      setup.inspector.revalidate(
        Object.freeze({ ...binding, bindingSha256: 'f'.repeat(64) }) as CliRuntimeBinding<
          'antigravity_cli',
          'provider_global'
        >,
        operation,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CLI_CHANGED' });
  });

  it('rehashes the launcher immediately before the first version command', async () => {
    const setup = harness();
    const launcher = arrangeNative(setup, 'antigravity_cli', '1.1.16');
    setup.hasher.queue(launcher, ['a'.repeat(64), 'f'.repeat(64)]);

    await expect(setup.inspector.inspect('antigravity_cli', operation)).rejects.toMatchObject({
      code: 'PROVIDER_CLI_CHANGED',
    });
    expect(setup.runner.requests).toHaveLength(0);
  });

  it('hashes and parses each bounded manifest capture from the same single byte snapshot', async () => {
    const setup = harness();
    const paths = arrangeGemini(setup);
    const manifestBytes = packageJson('@google/gemini-cli', '0.55.1', 'gemini', 'dist/index.js');

    const binding = await setup.inspector.inspect('gemini_cli', operation);

    expect(binding.packageManifestSha256).toBe(
      createHash('sha256').update(manifestBytes).digest('hex'),
    );
    expect(setup.files.readCalls.filter((path) => path === paths.manifest)).toHaveLength(3);
    expect(setup.hasher.calls).not.toContain(paths.manifest);
  });

  it('rejects an A/B manifest byte change after signature even when parsed metadata is unchanged', async () => {
    const setup = harness();
    const paths = arrangeGemini(setup);
    setup.signatures.onVerify = () => {
      setup.files.setContent(
        paths.manifest,
        '{ "name":"@google/gemini-cli", "version":"0.55.1", "bin":{ "gemini":"dist/index.js" } }',
      );
    };

    await expect(setup.inspector.inspect('gemini_cli', operation)).rejects.toMatchObject({
      code: 'PROVIDER_CLI_CHANGED',
    });
    expect(setup.runner.requests).toHaveLength(0);
  });

  it.each(['launcher', 'entryPath', 'manifest', 'platformManifest'] as const)(
    'recaptures a changed Codex %s after signature and starts no version process',
    async (component) => {
      const setup = harness();
      const paths = arrangeCodexNpm(setup);
      setup.signatures.onVerify = () => mutateCodexComponent(setup, paths, component);

      await expect(setup.inspector.inspect('codex_cli', operation)).rejects.toMatchObject({
        code: 'PROVIDER_CLI_CHANGED',
      });
      expect(setup.runner.requests).toHaveLength(0);
    },
  );

  it.each([
    ['success', null, 0],
    ['nonzero exit', null, 1],
    ['timeout', 'PROCESS_TIMEOUT', null],
    ['cancellation', 'PROCESS_CANCELLED', null],
  ] as const)(
    'discards %s version output when a component changes during the command',
    async (_name, runnerError, exitCode) => {
      const setup = harness();
      const launcher = arrangeNative(setup, 'antigravity_cli', '1.1.16');
      if (runnerError !== null) setup.runner.queueError(runnerError);
      if (exitCode !== null && exitCode !== 0) {
        setup.runner.results.splice(
          0,
          1,
          Object.freeze({ exitCode, stdout: 'agy 1.1.16\n', stderr: 'private output' }),
        );
      }
      setup.runner.onRun = () => setup.hasher.set(launcher, 'f'.repeat(64));

      const pending = setup.inspector.inspect('antigravity_cli', operation);
      await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CLI_CHANGED' });
      await expect(pending).rejects.not.toThrow(/private output/u);
      expect(setup.runner.requests).toHaveLength(1);
    },
  );

  it('recaptures every component after signature during revalidation', async () => {
    const setup = harness();
    const paths = arrangeCodexNpm(setup);
    const binding = await setup.inspector.inspect('codex_cli', operation);
    setup.signatures.onVerify = () => mutateCodexComponent(setup, paths, 'platformManifest');

    await expect(setup.inspector.revalidate(binding, operation)).rejects.toMatchObject({
      code: 'PROVIDER_CLI_CHANGED',
    });
  });

  it.each([
    {
      name: 'native binding with a platform path only',
      patch: {
        canonicalPlatformPackageManifestPath: 'C:\\private\\platform-package.json',
        platformPackageManifestSha256: null,
      },
    },
    {
      name: 'Codex npm binding without platform provenance',
      patch: {
        canonicalPlatformPackageManifestPath: null,
        platformPackageManifestSha256: null,
      },
    },
  ])('rejects an illegal private component combination: $name', async ({ name, patch }) => {
    const setup = harness();
    const binding = name.startsWith('native')
      ? await (async () => {
          arrangeNative(setup, 'codex_cli', '0.146.0');
          return setup.inspector.inspect('codex_cli', operation);
        })()
      : await (async () => {
          arrangeCodexNpm(setup);
          return setup.inspector.inspect('codex_cli', operation);
        })();
    const signatureCount = setup.signatures.calls.length;

    await expect(
      setup.inspector.revalidate(
        Object.freeze({ ...binding, ...patch }) as typeof binding,
        operation,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CLI_CHANGED' });
    expect(setup.signatures.calls).toHaveLength(signatureCount);
  });

  it('computes the path-free composite from the reviewed identity fields only', async () => {
    const setup = harness();
    arrangeGemini(setup);
    const binding = await setup.inspector.inspect('gemini_cli', operation);

    expect(binding.bindingSha256).toBe(
      sha256CanonicalJson({
        providerId: 'gemini_cli',
        version: '0.55.1',
        recipeId: 'gemini-0.55-policy-json-v1',
        credentialScope: 'provider_global',
        signerClassification: 'nodejs',
        launcherSha256: 'a'.repeat(64),
        entrySha256: 'b'.repeat(64),
        packageManifestSha256: createHash('sha256')
          .update(packageJson('@google/gemini-cli', '0.55.1', 'gemini', 'dist/index.js'))
          .digest('hex'),
        platformPackageManifestSha256: null,
      }),
    );
    expect(binding.bindingSha256).not.toContain(binding.canonicalLauncherPath);
  });

  it('invalidates a binding when canonical resolution changes under the persisted path', async () => {
    const setup = harness();
    const canonical = arrangeNative(setup, 'antigravity_cli', '1.1.16');
    const binding = await setup.inspector.inspect('antigravity_cli', operation);
    setup.files.setCanonical(canonical, 'C:\\Users\\student\\AppData\\Local\\agy\\bin\\other.exe');

    await expect(setup.inspector.revalidate(binding, operation)).rejects.toMatchObject({
      code: 'PROVIDER_CLI_CHANGED',
    });
  });

  it('rejects a forged persisted native Codex path outside the reviewed install root', async () => {
    const setup = harness();
    arrangeNative(setup, 'codex_cli', '0.146.0');
    const binding = await setup.inspector.inspect('codex_cli', operation);
    const attackerPath = 'C:\\Attacker\\codex.exe';
    addHashedFile(setup, attackerPath, 'a');
    const signatureCount = setup.signatures.calls.length;

    await expect(
      setup.inspector.revalidate(
        Object.freeze({ ...binding, canonicalLauncherPath: attackerPath }),
        operation,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CLI_CHANGED' });
    expect(setup.signatures.calls).toHaveLength(signatureCount);
  });

  it('fails closed when the required native signature no longer verifies', async () => {
    const setup = harness();
    arrangeNative(setup, 'codex_cli', '0.146.0');
    const binding = await setup.inspector.inspect('codex_cli', operation);
    setup.signatures.rejected = true;

    await expect(setup.inspector.revalidate(binding, operation)).rejects.toMatchObject({
      code: 'PROVIDER_CLI_CHANGED',
    });
  });

  it('fails closed for a nonzero version process without exposing stderr', async () => {
    const setup = harness();
    arrangeNative(setup, 'antigravity_cli', '1.1.16');
    setup.runner.results.splice(
      0,
      1,
      Object.freeze({ exitCode: 1, stdout: '', stderr: 'C:\\private\\credential detail' }),
    );

    const pending = setup.inspector.inspect('antigravity_cli', operation);
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    await expect(pending).rejects.not.toThrow(/credential detail|C:\\private/u);
  });

  it('derives every recipe ID and launcher prefix from the canonical shared catalog', async () => {
    expect(
      Object.fromEntries(
        Object.entries(SUPPORTED_CLI_RECIPES).map(([providerId, recipe]) => [
          providerId,
          { recipeId: recipe.recipeId, launcherPrefix: recipe.launcherPrefix },
        ]),
      ),
    ).toEqual(TRUSTED_CLI_BINDING_RECIPES);
  });

  it('keeps private component paths out of public diagnostic conversion', async () => {
    const setup = harness();
    arrangeGemini(setup);
    const cliBinding = await setup.inspector.inspect('gemini_cli', operation);
    const publicDiagnostic = toPublicProviderDiagnostic({
      providerId: 'gemini_cli',
      status: 'ready',
      version: cliBinding.version,
      selectedModelId: null,
      reportedModelId: null,
      credentialPresent: true,
      checkedAt: NOW,
      latencyMs: 1,
      errorCode: null,
      credentialScope: 'provider_global',
      providerManagedHistory: false,
      cliBinding,
    });
    const serialized = JSON.stringify(publicDiagnostic);

    expect(serialized).toContain(cliBinding.bindingSha256);
    expect(serialized).not.toContain(cliBinding.canonicalLauncherPath);
    expect(serialized).not.toContain(cliBinding.canonicalEntryPath ?? 'MISSING_ENTRY');
    expect(serialized).not.toContain(cliBinding.canonicalPackageManifestPath ?? 'MISSING_MANIFEST');
    expect(serialized).not.toContain(
      cliBinding.canonicalPlatformPackageManifestPath ?? 'MISSING_PLATFORM_MANIFEST',
    );
    expect(Object.keys(publicDiagnostic)).not.toContain('platformPackageManifestSha256');
  });
});

describe('reviewed CLI locations', () => {
  it('rejects an unissued lookalike Known Folder object at the inspector factory boundary', () => {
    const setup = harness();
    const forgedRoots = Object.freeze({
      appData: ROOTS.appData,
      localAppData: ROOTS.localAppData,
      programFiles: ROOTS.programFiles,
      architecture: ROOTS.architecture,
    }) as WindowsKnownFolders;

    expect(() =>
      createCliExecutableInspectorForTest({
        files: setup.files,
        hasher: setup.hasher,
        signatures: setup.signatures,
        runner: setup.runner,
        knownFolders: forgedRoots,
        now: () => NOW,
      }),
    ).toThrow();
    expect(setup.runner.requests).toHaveLength(0);
  });

  it('enumerates only a nonrecursive codex.exe child below the fixed native root', async () => {
    const setup = harness();
    const codexRoot = win32.join(ROOTS.localAppData, 'OpenAI', 'Codex', 'bin');
    const nativeCodex = win32.join(codexRoot, 'codex.exe');
    const nestedCodex = win32.join(codexRoot, 'preview', 'codex.exe');
    setup.files.setChildren(codexRoot, [
      nestedCodex,
      nativeCodex,
      win32.join(codexRoot, 'notes.txt'),
    ]);
    addHashedFile(setup, nestedCodex, 'f');
    addHashedFile(setup, nativeCodex, 'a');
    setup.runner.queue('codex-cli 0.146.0\n');

    await expect(setup.inspector.inspect('codex_cli', operation)).resolves.toMatchObject({
      canonicalLauncherPath: nativeCodex,
    });
    expect(setup.files.canonicalizeCalls).not.toContain(nestedCodex);
    expect(setup.files.listCalls).toEqual([codexRoot]);
    expect(setup.runner.requests).toHaveLength(1);
  });

  it.each([
    ['antigravity_cli', 'C:\\PathOnly\\agy.exe'],
    ['gemini_cli', 'C:\\PathOnly\\gemini.cmd'],
    ['codex_cli', 'C:\\PathOnly\\codex.exe'],
  ] as const)(
    'fails closed when %s exists only on PATH-like custom location',
    async (providerId, pathOnlyCandidate) => {
      const setup = harness();
      addHashedFile(setup, pathOnlyCandidate, 'a');

      await expect(setup.inspector.inspect(providerId, operation)).rejects.toMatchObject({
        code: 'PROVIDER_EXECUTABLE_NOT_FOUND',
      });
      expect(setup.files.canonicalizeCalls).not.toContain(pathOnlyCandidate);
      expect(setup.runner.requests).toHaveLength(0);
    },
  );
});
